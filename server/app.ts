import express from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { pool, transaction } from './db';
import { config } from './config';
import { ApiError, getState, commit, hash, mergeImport, audit } from './store';
import {
  authenticate,
  owner,
  session,
  passwordHash,
  argon2,
  randomToken,
  setCookie,
  seal,
  unseal,
  privatePool,
  tokenFrom,
  type AuthRequest,
} from './auth';
import { parseBackup, dateOK, emptyData } from '../src/lib/model';
import { parseArchive, canonical, differences, type History } from '../src/lib/history';
const credentials = z
  .object({
    login: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_.@-]{3,80}$/),
    password: z.string().min(12).max(128),
  })
  .strict();
function valid<T>(fn: () => T): T {
  try {
    return fn();
  } catch {
    throw new ApiError(400, '数据校验失败；未覆盖已保存数据');
  }
}
const version = z.number().int().nonnegative();
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Only the local Nginx is trusted; it replaces incoming X-Forwarded-For.
  app.set('trust proxy', 'loopback');
  let hashing = 0;
  app.use('/api', (req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    const origin = req.get('origin');
    if (origin && origin !== config.APP_ORIGIN) return next(new ApiError(403, '来源不允许'));
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (origin !== config.APP_ORIGIN) return next(new ApiError(403, '缺少可信来源'));
      if (!req.is('application/json')) return next(new ApiError(415, '需要JSON请求'));
    }
    next();
  });
  app.use('/api', express.json({ limit: '16mb' }));
  app.get('/api/health', async (_req, res, next) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, environment: config.APP_ENV });
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/auth/login', async (req, res, next) => {
    try {
      const body = credentials.parse(req.body);
      for (const bucket of ['login:' + body.login + ':' + req.ip, 'ip:' + req.ip]) {
        const q = await pool.query(
          "INSERT INTO login_limit VALUES($1,1,now()+interval '1 minute') ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN login_limit.expires_at<now() THEN 1 ELSE login_limit.attempts+1 END,expires_at=CASE WHEN login_limit.expires_at<now() THEN now()+interval '1 minute' ELSE login_limit.expires_at END RETURNING attempts",
          [hash(bucket)],
        );
        if (q.rows[0].attempts > (bucket.startsWith('login:') ? 5 : 100))
          throw new ApiError(429, '尝试过多，请稍后重试');
      }
      if (hashing >= 2) throw new ApiError(429, '登录繁忙，请稍后重试');
      hashing++;
      try {
        const q = await pool.query('SELECT id,password_hash,active FROM account WHERE login=$1', [
          body.login,
        ]);
        const user = q.rows[0];
        const valid = user
          ? await argon2.verify(user.password_hash, body.password)
          : await argon2.verify(dummyHash, body.password);
        if (!valid || !user?.active) throw new ApiError(401, '账号或密码不正确');
        const previous = tokenFrom(req);
        if (previous) {
          await pool.query('DELETE FROM auth_session WHERE token_hash=$1', [hash(previous)]);
          for (const s of streams) if (s.tokenHash === hash(previous)) s.close();
        }
        const token = randomToken();
        await pool.query(
          "INSERT INTO auth_session(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '8 hours')",
          [hash(token), user.id],
        );
        setCookie(res, token);
        res.json({ ok: true });
      } finally {
        hashing--;
      }
    } catch (e) {
      next(e);
    }
  });
  app.use('/api', authenticate);
  app.get('/api/auth/session', (req: AuthRequest, res) =>
    res.json({ user: req.actor, csrf: hash('csrf:' + req.token) }),
  );
  const streams = new Set<{ accountId: string; tokenHash: string; close: () => void }>();
  app.post('/api/auth/logout', async (req: AuthRequest, res, next) => {
    try {
      await pool.query('DELETE FROM auth_session WHERE token_hash=$1', [req.tokenHash]);
      for (const s of streams) if (s.tokenHash === req.tokenHash) s.close();
      setCookie(res, '', true);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/accounts', owner, async (req: AuthRequest, res, next) => {
    try {
      const body = credentials.parse(req.body);
      if (hashing >= 2) throw new ApiError(429, '密码处理繁忙');
      hashing++;
      try {
        const id = randomUUID(),
          pwd = await passwordHash(body.password);
        await transaction(async (c) => {
          await c.query(
            "INSERT INTO account(id,workspace_id,login,password_hash,role) VALUES($1,$2,$3,$4,'employee')",
            [id, req.actor!.workspaceId, body.login, pwd],
          );
          await audit(c, req.actor!, 'account.create');
        });
        res.status(201).json({ id, login: body.login, role: 'employee' });
      } finally {
        hashing--;
      }
    } catch (e) {
      next(e);
    }
  });
  app.patch('/api/accounts/:id', owner, async (req: AuthRequest, res, next) => {
    try {
      const body = z
        .object({
          active: z.boolean().optional(),
          password: z.string().min(12).max(128).optional(),
        })
        .strict()
        .refine((x) => x.active !== undefined || x.password)
        .parse(req.body);
      if (req.params.id === req.actor!.id && body.active === false)
        throw new ApiError(409, '不能停用负责人');
      if (body.password && hashing >= 2) throw new ApiError(429, '密码处理繁忙');
      let pwd: string | undefined;
      if (body.password) {
        hashing++;
        try {
          pwd = await passwordHash(body.password);
        } finally {
          hashing--;
        }
      }
      await transaction(async (c) => {
        const q = await c.query(
          'UPDATE account SET active=COALESCE($3,active),password_hash=COALESCE($4,password_hash) WHERE id=$1 AND workspace_id=$2 RETURNING id',
          [req.params.id, req.actor!.workspaceId, body.active ?? null, pwd ?? null],
        );
        if (!q.rowCount) throw new ApiError(404, '账号不存在');
        await c.query('DELETE FROM auth_session WHERE account_id=$1', [req.params.id]);
        await audit(c, req.actor!, 'account.update');
      });
      for (const s of streams) if (s.accountId === req.params.id) s.close();
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/workspace', async (req: AuthRequest, res, next) => {
    try {
      res.json(await transaction((c) => getState(c, req.actor!.workspaceId)));
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/export', async (req: AuthRequest, res, next) => {
    try {
      const s = await transaction((c) => getState(c, req.actor!.workspaceId));
      res.json({ format: 'chunmo-history-backup', version: 1, data: s.data, history: s.history });
    } catch (e) {
      next(e);
    }
  });
  app.put('/api/workspace', async (req: AuthRequest, res, next) => {
    try {
      const b = z.object({ revision: version, data: z.unknown() }).strict().parse(req.body);
      const data = valid(() => parseBackup(b.data));
      res.json(await transaction((c) => commit(c, req.actor!, b.revision, data)));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/purchases/:id/deadline', owner, async (req: AuthRequest, res, next) => {
    try {
      const b = z
        .object({
          revision: version,
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          reason: z.string().trim().min(1).max(4000),
        })
        .strict()
        .parse(req.body);
      res.json(
        await transaction((c) =>
          commit(c, req.actor!, b.revision, emptyData(), {
            deadlineChange: { id: String(req.params.id), date: b.date, reason: b.reason },
          }),
        ),
      );
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/history/restore', owner, async (req: AuthRequest, res, next) => {
    try {
      const b = z
        .object({ revision: version, id: z.string().min(1).max(100) })
        .strict()
        .parse(req.body);
      res.json(
        await transaction(async (c) => {
          const current = await getState(c, req.actor!.workspaceId, 'UPDATE');
          return commit(c, req.actor!, b.revision, current.data, { restoreId: b.id });
        }),
      );
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/people/:id/private', owner, async (req: AuthRequest, res, next) => {
    try {
      const r = await privatePool.query(
        'SELECT sealed FROM person_private WHERE workspace_id=$1 AND person_id=$2',
        [req.actor!.workspaceId, req.params.id],
      );
      if (!r.rowCount) throw new ApiError(404, '私密资料未登记');
      await transaction((c) => audit(c, req.actor!, 'person.private.read'));
      res.json(unseal(r.rows[0].sealed));
    } catch (e) {
      next(e);
    }
  });
  app.put('/api/people/:id/private', owner, async (req: AuthRequest, res, next) => {
    try {
      const b = z
        .object({
          phone: z.string().regex(/^\+?\d{6,20}$/),
          birthDate: z.string().refine((x) => x === '' || dateOK(x)),
        })
        .strict()
        .parse(req.body);
      const current = await transaction((c) => getState(c, req.actor!.workspaceId));
      if (!current.data.people?.some((p) => p.id === req.params.id))
        throw new ApiError(404, '人员不存在');
      const pc = await privatePool.connect();
      try {
        await pc.query('BEGIN');
        await pc.query(
          'INSERT INTO person_private(workspace_id,person_id,sealed) VALUES($1,$2,$3) ON CONFLICT(workspace_id,person_id) DO UPDATE SET sealed=excluded.sealed,updated_at=now()',
          [req.actor!.workspaceId, req.params.id, JSON.stringify(seal(b))],
        );
        await audit(pc, req.actor!, 'person.private.update');
        await pc.query('COMMIT');
      } catch (e) {
        await pc.query('ROLLBACK');
        throw e;
      } finally {
        pc.release();
      }
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/import/preview', owner, async (req: AuthRequest, res, next) => {
    try {
      const raw = z.object({ archive: z.unknown() }).strict().parse(req.body),
        archive = valid(() => parseArchive(raw.archive)),
        digest = hash(canonical(raw.archive));
      const preview = await transaction(async (c) => {
        const prior = await c.query(
          'SELECT revision FROM imported_archive WHERE workspace_id=$1 AND hash=$2',
          [req.actor!.workspaceId, digest],
        );
        if (prior.rowCount)
          return { alreadyImported: true, revision: Number(prior.rows[0].revision) };
        const s = await getState(c, req.actor!.workspaceId);
        const merged = mergeImport(s.data, archive.data);
        const id = randomUUID();
        const history: History | undefined = archive.history
          ? {
              ...archive.history,
              records: archive.history.records.map((r) => {
                const { actorId: _, ...rest } = r;
                return {
                  ...rest,
                  changes: differences(
                    archive.history!.snapshots[r.before],
                    archive.history!.snapshots[r.after],
                  ),
                  actor: '导入记录（身份未核验）',
                };
              }),
            }
          : undefined;
        await c.query(
          "INSERT INTO import_preview VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes',false)",
          [
            id,
            req.actor!.workspaceId,
            req.actor!.id,
            s.revision,
            digest,
            JSON.stringify({ data: merged, history }),
          ],
        );
        return {
          id,
          revision: s.revision,
          hash: digest,
          counts: {
            projects: archive.data.projects.length,
            tasks: archive.data.tasks.length,
            people: archive.data.people?.length ?? 0,
            purchases: archive.data.purchases.length,
            history: archive.history?.records.length ?? 0,
            historyDiscarded: Math.max(
              0,
              ((raw.archive as { history?: { records?: unknown[] } })?.history?.records?.length ??
                0) - (archive.history?.records.length ?? 0),
            ),
          },
        };
      });
      res.json(preview);
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/import/commit', owner, async (req: AuthRequest, res, next) => {
    try {
      const b = z
        .object({ id: z.string().uuid(), revision: version, confirm: z.literal(true) })
        .strict()
        .parse(req.body);
      res.json(
        await transaction(async (c) => {
          const q = await c.query(
            'SELECT * FROM import_preview WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND expires_at>now() FOR UPDATE',
            [b.id, req.actor!.workspaceId, req.actor!.id],
          );
          if (!q.rowCount) throw new ApiError(404, '预览不存在或已过期');
          const p = q.rows[0];
          const old = await c.query(
            'SELECT revision FROM imported_archive WHERE workspace_id=$1 AND hash=$2',
            [req.actor!.workspaceId, p.hash],
          );
          if (old.rowCount)
            return { alreadyImported: true, revision: Number(old.rows[0].revision) };
          if (p.consumed || Number(p.base_revision) !== b.revision)
            throw new ApiError(409, '预览版本已变化');
          const result = await commit(c, req.actor!, b.revision, parseBackup(p.payload.data), {
            importHistory: p.payload.history,
            importing: true,
          });
          await c.query('INSERT INTO imported_archive VALUES($1,$2,$3,$4)', [
            req.actor!.workspaceId,
            p.hash,
            req.actor!.id,
            result.revision,
          ]);
          await c.query('UPDATE import_preview SET consumed=true WHERE id=$1', [b.id]);
          return result;
        }),
      );
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/events', async (req: AuthRequest, res, next) => {
    try {
      if ([...streams].filter((s) => s.accountId === req.actor!.id).length >= 8)
        throw new ApiError(429, '连接过多');
      res.set({
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      let busy = false,
        last = -1,
        ticks = 0;
      const close = () => {
        if (!res.writableEnded && !res.destroyed) res.write('event: session-expired\ndata: {}\n\n');
        clearInterval(timer);
        streams.delete(stream);
        res.end();
      };
      const stream = { accountId: req.actor!.id, tokenHash: req.tokenHash!, close };
      const timer = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          const actor = await session(req.tokenHash!);
          if (!actor) {
            close();
            return;
          }
          const q = await pool.query('SELECT revision FROM workspace_state WHERE workspace_id=$1', [
            actor.workspaceId,
          ]);
          const revision = Number(q.rows[0].revision);
          if (revision !== last) {
            last = revision;
            res.write(`event: revision\ndata: ${JSON.stringify({ revision })}\n\n`);
          } else if (++ticks % 15 === 0) res.write(': keepalive\n\n');
        } catch {
          close();
        } finally {
          busy = false;
        }
      }, 1000);
      streams.add(stream);
      req.on('close', close);
      res.write(': connected\n\n');
    } catch (e) {
      next(e);
    }
  });
  app.use('/api', (_req, _res, next) => next(new ApiError(404, '接口不存在')));
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const e = error as { code?: string; status?: number };
      let status =
        error instanceof ApiError
          ? error.status
          : error instanceof z.ZodError || error instanceof SyntaxError
            ? 400
            : e.code === '23505'
              ? 409
              : e.code === '23503' || e.code === '23514'
                ? 409
                : e.status === 413
                  ? 413
                  : 400;
      if (
        !(error instanceof ApiError) &&
        !(error instanceof z.ZodError) &&
        !(error instanceof SyntaxError) &&
        !e.code &&
        e.status !== 413
      )
        status = 500;
      res.status(status).json({
        error:
          error instanceof ApiError
            ? error.message
            : status === 409
              ? '记录冲突或关联校验失败'
              : status === 413
                ? '文件超过16MiB限制'
                : status === 500
                  ? '服务异常，请稍后重试'
                  : '数据校验失败；未覆盖已保存数据',
      });
    },
  );
  return app;
}
const dummyHash = await passwordHash(randomToken());
