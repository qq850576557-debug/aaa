import {
  saveWorkspaceSubmission,
  workspaceStateWithProof,
  WorkspaceConflictError,
} from './workspace-save';
import { transferRoutes } from './transfers';
import { recordRoutes } from './records';
import { purchaseRoutes } from './purchases';
import { materialRoutes } from './materials';
import { memberCardRoutes } from './member-cards';
import { assessmentRoutes } from './assessments';
import express from 'express';
import { requireAccountPermission } from './permissions';
import { validateAvatar } from './avatar';
import { auditDevice } from './audit';
import { loginSchema, loginInputSchema } from '../src/lib/login';
import { passwordSchema } from '../src/lib/password';
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
import { parseBackup, prepareWorkspace, dateOK, emptyData, plus } from '../src/lib/model';
import { parseArchive, canonical, differences, type History } from '../src/lib/history';
const credentials = z
  .object({
    login: loginSchema,
    password: passwordSchema,
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
const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
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
      const body = credentials.extend({ login: loginInputSchema }).parse(req.body);
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
        const previous = tokenFrom(req),
          token = randomToken();
        // Password changes/reset take the same account row lock, so an old hash
        // cannot be verified before revocation and create a session after it.
        await transaction(async (c) => {
          const q = await c.query(
            'SELECT id,password_hash,active FROM account WHERE login_key=$1 FOR UPDATE',
            [body.login],
          );
          const user = q.rows[0];
          const valid = await argon2.verify(user?.password_hash ?? dummyHash, body.password);
          if (!valid || !user?.active) throw new ApiError(401, '账号或密码不正确');
          if (previous)
            await c.query('DELETE FROM auth_session WHERE token_hash=$1', [hash(previous)]);
          await c.query(
            "INSERT INTO auth_session(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '8 hours')",
            [hash(token), user.id],
          );
        });
        if (previous) for (const s of streams) if (s.tokenHash === hash(previous)) s.close();
        setCookie(res, token);
        res.json({ ok: true });
      } finally {
        hashing--;
      }
    } catch (e) {
      next(e);
    }
  });
  app.use('/api', authenticate, (req: AuthRequest, _res, next) => {
    req.actor!.auditDevice = auditDevice(req.get('user-agent') ?? '');
    next();
  });
  purchaseRoutes(app);
  recordRoutes(app);
  assessmentRoutes(app);
  materialRoutes(app);
  transferRoutes(app);
  memberCardRoutes(app, announcePresence);
  app.get('/api/auth/session', (req: AuthRequest, res) => {
    const { auditDevice: _device, ...user } = req.actor!;
    res.json({ user, csrf: hash('csrf:' + req.token) });
  });
  app.patch('/api/auth/profile', async (req: AuthRequest, res, next) => {
    try {
      const body = z.object({ displayName: displayNameSchema }).strict().parse(req.body);
      await transaction(async (c) => {
        await c.query('UPDATE account SET display_name=$2 WHERE id=$1 AND workspace_id=$3', [
          req.actor!.id,
          body.displayName,
          req.actor!.workspaceId,
        ]);
        await audit(c, req.actor!, 'account.profile', undefined, {
          entityType: 'account',
          entityId: req.actor!.id,
          operation: 'update',
          changedFields: ['displayName'],
        });
      });
      announcePresence(req.actor!.workspaceId);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.put('/api/auth/avatar', async (req: AuthRequest, res, next) => {
    try {
      const body = z
        .object({ image: z.string().max(2800000) })
        .strict()
        .parse(req.body);
      const png = validateAvatar(body.image);
      await transaction(async (c) => {
        await c.query(
          'INSERT INTO account_avatar(account_id,png,version) VALUES($1,$2,$3) ON CONFLICT(account_id) DO UPDATE SET png=$2,version=$3,updated_at=now()',
          [req.actor!.id, png, randomUUID()],
        );
        await audit(c, req.actor!, 'account.avatar', undefined, {
          entityType: 'account',
          entityId: req.actor!.id,
          operation: 'update',
          changedFields: ['avatar'],
        });
      });
      announcePresence(req.actor!.workspaceId);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.delete('/api/auth/avatar', async (req: AuthRequest, res, next) => {
    try {
      await transaction(async (c) => {
        await c.query('DELETE FROM account_avatar WHERE account_id=$1', [req.actor!.id]);
        await audit(c, req.actor!, 'account.avatar', undefined, {
          entityType: 'account',
          entityId: req.actor!.id,
          operation: 'update',
          changedFields: ['avatar'],
        });
      });
      announcePresence(req.actor!.workspaceId);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/accounts/:id/avatar', async (req: AuthRequest, res, next) => {
    try {
      const q = await pool.query(
        'SELECT v.png FROM account_avatar v JOIN account a ON a.id=v.account_id WHERE a.id=$1 AND a.workspace_id=$2 AND a.active=true',
        [req.params.id, req.actor!.workspaceId],
      );
      if (!q.rowCount) throw new ApiError(404, '头像不存在');
      res.type('png').send(q.rows[0].png);
    } catch (e) {
      next(e);
    }
  });
  app.put('/api/auth/card-avatar', async (req: AuthRequest, res, next) => {
    try {
      const body = z
        .object({ image: z.string().max(2800000) })
        .strict()
        .parse(req.body);
      const png = validateAvatar(body.image, 1024);
      await transaction(async (c) => {
        await c.query(
          'INSERT INTO card_avatar(account_id,png,version) VALUES($1,$2,$3) ON CONFLICT(account_id) DO UPDATE SET png=$2,version=$3,updated_at=now()',
          [req.actor!.id, png, randomUUID()],
        );
        await audit(c, req.actor!, 'account.card-avatar', undefined, {
          entityType: 'account',
          entityId: req.actor!.id,
          operation: 'update',
          changedFields: ['avatar'],
        });
      });
      announcePresence(req.actor!.workspaceId);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.delete('/api/auth/card-avatar', async (req: AuthRequest, res, next) => {
    try {
      await transaction(async (c) => {
        await c.query('DELETE FROM card_avatar WHERE account_id=$1', [req.actor!.id]);
        await audit(c, req.actor!, 'account.card-avatar', undefined, {
          entityType: 'account',
          entityId: req.actor!.id,
          operation: 'update',
          changedFields: ['avatar'],
        });
      });
      announcePresence(req.actor!.workspaceId);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/accounts/:id/card-avatar', async (req: AuthRequest, res, next) => {
    try {
      const q = await pool.query(
        'SELECT v.png FROM card_avatar v JOIN account a ON a.id=v.account_id WHERE a.id=$1 AND a.workspace_id=$2 AND a.active=true',
        [req.params.id, req.actor!.workspaceId],
      );
      if (!q.rowCount) throw new ApiError(404, '头像不存在');
      res.type('png').send(q.rows[0].png);
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/presence', async (req: AuthRequest, res, next) => {
    try {
      const ids = [
        ...new Set(
          [...streams]
            .filter((s) => s.workspaceId === req.actor!.workspaceId)
            .map((s) => s.accountId),
        ),
      ];
      const tokens = [...streams]
        .filter((s) => s.workspaceId === req.actor!.workspaceId)
        .map((s) => s.tokenHash);
      const q = await pool.query(
        `SELECT DISTINCT a.id,a.login,COALESCE(NULLIF(a.display_name,''),a.login) AS "displayName",v.version AS "avatarVersion" FROM account a JOIN auth_session s ON s.account_id=a.id LEFT JOIN account_avatar v ON v.account_id=a.id WHERE a.workspace_id=$1 AND a.id=ANY($2::text[]) AND s.token_hash=ANY($3::text[]) AND s.expires_at>now() AND a.active=true ORDER BY a.id`,
        [req.actor!.workspaceId, ids, tokens],
      );
      res.json({ accounts: q.rows });
    } catch (e) {
      next(e);
    }
  });
  app.get(
    '/api/directory',
    requireAccountPermission('directory'),
    async (req: AuthRequest, res, next) => {
      try {
        const q = await pool.query(
          `SELECT a.id,a.login,COALESCE(NULLIF(a.display_name,''),a.login) AS "displayName",a.active,(w.owner_account_id=a.id) AS owner,COALESCE(n.note,'') AS note,v.version AS "avatarVersion"
        FROM account a JOIN cloud_workspace w ON w.id=a.workspace_id
        LEFT JOIN account_avatar v ON v.account_id=a.id
        LEFT JOIN account_note n ON n.workspace_id=a.workspace_id AND n.target_id=a.id AND n.author_id=$2
        WHERE a.workspace_id=$1 ORDER BY a.login`,
          [req.actor!.workspaceId, req.actor!.id],
        );
        res.json({ accounts: q.rows });
      } catch (e) {
        next(e);
      }
    },
  );
  app.put(
    '/api/accounts/:id/note',
    requireAccountPermission('directory'),
    async (req: AuthRequest, res, next) => {
      try {
        const body = z
          .object({ note: z.string().trim().max(1000) })
          .strict()
          .parse(req.body);
        if (req.params.id === req.actor!.id) throw new ApiError(400, '请为其他账号添加个人备注');
        await transaction(async (c) => {
          const target = await c.query('SELECT 1 FROM account WHERE id=$1 AND workspace_id=$2', [
            req.params.id,
            req.actor!.workspaceId,
          ]);
          if (!target.rowCount) throw new ApiError(404, '账号不存在');
          if (body.note)
            await c.query(
              `INSERT INTO account_note(workspace_id,author_id,target_id,note) VALUES($1,$2,$3,$4)
          ON CONFLICT(workspace_id,author_id,target_id) DO UPDATE SET note=excluded.note,updated_at=now()`,
              [req.actor!.workspaceId, req.actor!.id, req.params.id, body.note],
            );
          else
            await c.query(
              'DELETE FROM account_note WHERE workspace_id=$1 AND author_id=$2 AND target_id=$3',
              [req.actor!.workspaceId, req.actor!.id, req.params.id],
            );
        });
        res.json({ ok: true });
      } catch (e) {
        next(e);
      }
    },
  );
  app.get('/api/audit', requireAccountPermission('audit'), async (req: AuthRequest, res, next) => {
    try {
      const filter = z
        .object({
          actorId: z.string().max(100).optional(),
          entityType: z
            .enum([
              'project',
              'trade',
              'task',
              'purchase',
              'note',
              'person',
              'dictionary',
              'department',
              'account',
              'workspace',
              'record',
              'person_private',
            ])
            .optional(),
          operation: z.enum(['create', 'update', 'delete']).optional(),
          from: z.string().max(40).optional(),
          to: z.string().max(40).optional(),
          cursor: z.string().max(500).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .strict()
        .parse(req.query);
      const args: unknown[] = [req.actor!.workspaceId];
      const where = ['workspace_id=$1'];
      const condition = (sql: string, value: unknown) => {
        args.push(value);
        where.push(sql.replace('?', '$' + args.length));
      };
      if (filter.actorId) condition('actor_id=?', filter.actorId);
      if (filter.entityType) condition('entity_type=?', filter.entityType);
      if (filter.operation) condition('operation=?', filter.operation);
      const edge = (s: string, end: boolean) => {
        if (dateOK(s)) return (end ? plus(s, 1) : s) + 'T00:00:00+08:00';
        if (!z.iso.datetime({ offset: true }).safeParse(s).success)
          throw new ApiError(400, '筛选日期无效');
        return s;
      };
      if (filter.from) condition('created_at>=?::timestamptz', edge(filter.from, false));
      if (filter.to) condition('created_at<?::timestamptz', edge(filter.to, true));
      if (filter.cursor) {
        const cursor = valid(() =>
          z
            .object({ at: z.iso.datetime(), id: z.string().max(100) })
            .strict()
            .parse(JSON.parse(Buffer.from(filter.cursor!, 'base64url').toString())),
        );
        args.push(cursor.at, cursor.id);
        where.push(`(created_at,id)<($${args.length - 1}::timestamptz,$${args.length})`);
      }
      args.push(filter.limit + 1);
      const rows = (
        await pool.query(
          `SELECT id,actor_id AS "actorId",actor_display_name AS "actorDisplayName",
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
        entity_type AS "entityType",entity_id AS "entityId",operation,action,revision,before_value AS before,after_value AS after,changed_fields AS "changedFields",device
        FROM audit_event WHERE ${where.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT $${args.length}`,
          args,
        )
      ).rows;
      const events = rows.slice(0, filter.limit);
      const last = events.at(-1);
      res.json({
        events,
        nextCursor:
          rows.length > filter.limit && last
            ? Buffer.from(JSON.stringify({ at: last.createdAt, id: last.id })).toString('base64url')
            : null,
      });
    } catch (e) {
      next(e);
    }
  });
  const streams = new Set<{
    accountId: string;
    workspaceId: string;
    tokenHash: string;
    close: () => void;
    notify: () => void;
  }>();
  function announcePresence(workspaceId: string) {
    for (const stream of streams) if (stream.workspaceId === workspaceId) stream.notify();
  }

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
  const passwordLimit = async (id: string) => {
    const q = await pool.query(
      "INSERT INTO login_limit VALUES($1,1,now()+interval '1 minute') ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN login_limit.expires_at<now() THEN 1 ELSE login_limit.attempts+1 END,expires_at=CASE WHEN login_limit.expires_at<now() THEN now()+interval '1 minute' ELSE login_limit.expires_at END RETURNING attempts",
      [hash('password:' + id)],
    );
    if (q.rows[0].attempts > 5) throw new ApiError(429, '密码操作过于频繁，请稍后重试');
  };
  app.get(
    '/api/auth/login-policy',
    requireAccountPermission('changeLogin'),
    async (req: AuthRequest, res, next) => {
      try {
        const q = await pool.query(
          `SELECT login,login_changed_at AS "lastChangedAt",
        login_changed_at+interval '2160 hours' AS "nextAllowedAt",
        login_changed_at IS NULL OR clock_timestamp()>=login_changed_at+interval '2160 hours' AS "canChange",
        clock_timestamp() AS "serverNow" FROM account WHERE id=$1`,
          [req.actor!.id],
        );
        res.json(q.rows[0]);
      } catch (e) {
        next(e);
      }
    },
  );
  app.post(
    '/api/auth/login-name',
    requireAccountPermission('changeLogin'),
    async (req: AuthRequest, res, next) => {
      try {
        const body = z
          .object({
            newLogin: loginSchema,
            currentPassword: passwordSchema,
            confirm: z.literal(true),
          })
          .strict()
          .parse(req.body);
        await passwordLimit(req.actor!.id);
        if (hashing >= 2) throw new ApiError(429, '账号验证繁忙，请稍后重试');
        hashing++;
        try {
          await transaction(async (c) => {
            const q = await c.query(
              `SELECT id,login,login_key,password_hash,login_changed_at,
            login_changed_at+interval '2160 hours' AS next_allowed,
            login_changed_at IS NULL OR clock_timestamp()>=login_changed_at+interval '2160 hours' AS can_change
            FROM account WHERE id=$1 AND active=true FOR UPDATE`,
              [req.actor!.id],
            );
            const row = q.rows[0];
            const live = await c.query(
              'SELECT 1 FROM auth_session WHERE token_hash=$1 AND account_id=$2 AND expires_at>now()',
              [req.tokenHash, req.actor!.id],
            );
            if (!row || !live.rowCount) throw new ApiError(401, '会话已失效，请重新登录');
            if (!row.can_change)
              throw new ApiError(
                409,
                '90天内不可再次修改，下次允许修改时间：' + new Date(row.next_allowed).toISOString(),
              );
            if (row.login_key === body.newLogin)
              throw new ApiError(409, '新账号与当前账号规范化后相同');
            if (!(await argon2.verify(row.password_hash, body.currentPassword)))
              throw new ApiError(403, '当前密码不正确');
            const changed = await c.query(
              'UPDATE account SET login=$2 WHERE id=$1 RETURNING login,login_changed_at',
              [req.actor!.id, body.newLogin],
            );
            const current = changed.rows[0];
            await audit(c, req.actor!, 'account.login.change', undefined, {
              entityType: 'account',
              entityId: req.actor!.id,
              operation: 'update',
              before: { login: row.login },
              after: {
                login: current.login,
                loginChangedAt: current.login_changed_at.toISOString(),
              },
              changedFields: ['login'],
            });
          });
          for (const stream of streams) if (stream.accountId === req.actor!.id) stream.close();
          setCookie(res, '', true);
          res.json({ ok: true, login: body.newLogin });
        } finally {
          hashing--;
        }
      } catch (e) {
        if ((e as { code?: string }).code === '23505')
          next(new ApiError(409, '该登录账号已被使用，请选择其他账号'));
        else next(e);
      }
    },
  );
  app.post('/api/auth/password', async (req: AuthRequest, res, next) => {
    try {
      const body = z
        .object({
          currentPassword: passwordSchema,
          newPassword: passwordSchema,
          confirmPassword: passwordSchema,
        })
        .strict()
        .refine((v) => v.newPassword === v.confirmPassword)
        .parse(req.body);
      await passwordLimit(req.actor!.id);
      if (hashing >= 2) throw new ApiError(429, '密码处理繁忙');
      hashing++;
      try {
        await transaction(async (c) => {
          const q = await c.query(
            'SELECT password_hash FROM account WHERE id=$1 AND active=true FOR UPDATE',
            [req.actor!.id],
          );
          // A concurrent reset/change may have revoked this request after authentication.
          const live = await c.query(
            'SELECT 1 FROM auth_session WHERE token_hash=$1 AND account_id=$2 AND expires_at>now()',
            [req.tokenHash, req.actor!.id],
          );
          if (!q.rowCount || !live.rowCount) throw new ApiError(401, '会话已失效，请登录');
          if (!(await argon2.verify(q.rows[0].password_hash, body.currentPassword)))
            throw new ApiError(403, '当前密码不正确');
          await c.query('UPDATE account SET password_hash=$2 WHERE id=$1', [
            req.actor!.id,
            await passwordHash(body.newPassword),
          ]);
          await c.query('DELETE FROM auth_session WHERE account_id=$1', [req.actor!.id]);
          await audit(c, req.actor!, 'account.password.change');
        });
        for (const s of streams) if (s.accountId === req.actor!.id) s.close();
        setCookie(res, '', true);
        res.json({ ok: true });
      } finally {
        hashing--;
      }
    } catch (e) {
      next(e);
    }
  });
  app.get(
    '/api/accounts',
    requireAccountPermission('manageAccounts'),
    async (req: AuthRequest, res, next) => {
      try {
        const q = await pool.query(
          `SELECT id,login,COALESCE(NULLIF(display_name,''),login) AS "displayName",active FROM account WHERE workspace_id=$1 AND id<>$2 ORDER BY login`,
          [req.actor!.workspaceId, req.actor!.id],
        );
        res.json({ accounts: q.rows });
      } catch (e) {
        next(e);
      }
    },
  );
  app.post(
    '/api/accounts',
    requireAccountPermission('manageAccounts'),
    async (req: AuthRequest, res, next) => {
      try {
        const body = credentials
          .extend({ displayName: displayNameSchema.optional() })
          .strict()
          .parse(req.body);
        await passwordLimit(req.actor!.id);
        if (hashing >= 2) throw new ApiError(429, '密码处理繁忙');
        hashing++;
        try {
          const id = randomUUID(),
            pwd = await passwordHash(body.password);
          await transaction(async (c) => {
            await c.query(
              "INSERT INTO account(id,workspace_id,login,password_hash,role,display_name) VALUES($1,$2,$3,$4,'employee',$5)",
              [id, req.actor!.workspaceId, body.login, pwd, body.displayName ?? ''],
            );
            await audit(c, req.actor!, 'account.create', undefined, {
              entityType: 'account',
              entityId: id,
              operation: 'create',
              changedFields: ['login', 'displayName', 'active'],
            });
          });
          res.status(201).json({ id, login: body.login, role: 'employee' });
        } finally {
          hashing--;
        }
      } catch (e) {
        next(e);
      }
    },
  );
  app.patch(
    '/api/accounts/:id',
    requireAccountPermission('manageAccounts'),
    async (req: AuthRequest, res, next) => {
      try {
        const body = z
          .object({
            active: z.boolean().optional(),
            displayName: displayNameSchema.optional(),
            password: passwordSchema.optional(),
          })
          .strict()
          .refine((x) => x.active !== undefined || x.password || x.displayName !== undefined)
          .parse(req.body);
        if (req.params.id === req.actor!.id && body.password)
          throw new ApiError(409, '请使用修改我的密码并验证当前密码');
        if (body.password) await passwordLimit(req.actor!.id);
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
            'UPDATE account SET active=COALESCE($3,active),password_hash=COALESCE($4,password_hash),display_name=COALESCE($5,display_name) WHERE id=$1 AND workspace_id=$2 RETURNING id',
            [
              req.params.id,
              req.actor!.workspaceId,
              body.active ?? null,
              pwd ?? null,
              body.displayName ?? null,
            ],
          );
          if (!q.rowCount) throw new ApiError(404, '账号不存在');
          if (body.password || body.active !== undefined)
            await c.query('DELETE FROM auth_session WHERE account_id=$1', [req.params.id]);
          await audit(c, req.actor!, 'account.update', undefined, {
            entityType: 'account',
            entityId: String(req.params.id),
            operation: 'update',
            changedFields: Object.keys(body).map((k) => (k === 'password' ? 'passwordChanged' : k)),
          });
        });
        if (body.password || body.active !== undefined)
          for (const s of streams) if (s.accountId === req.params.id) s.close();
        res.json({ ok: true });
      } catch (e) {
        next(e);
      }
    },
  );
  app.get('/api/workspace', async (req: AuthRequest, res, next) => {
    try {
      res.json(
        workspaceStateWithProof(
          await transaction((c) => getState(c, req.actor!.workspaceId)),
          req.actor!,
        ),
      );
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
      const b = z
        .object({
          revision: version,
          data: z.unknown(),
          base: z.unknown().optional(),
          baseProof: z
            .string()
            .regex(/^[a-f0-9]{64}$/i)
            .optional(),
          requestId: z.string().uuid().optional(),
        })
        .strict()
        .parse(req.body);
      const data = valid(() => prepareWorkspace(parseBackup(b.data)));
      if (b.base !== undefined || b.baseProof !== undefined || b.requestId !== undefined) {
        if (b.base === undefined || !b.baseProof || !b.requestId)
          throw new ApiError(400, '保存基线与提交编号必须完整');
        const base = valid(() => prepareWorkspace(parseBackup(b.base)));
        res.json(
          await transaction((c) =>
            saveWorkspaceSubmission(c, req.actor!, {
              ...b,
              base,
              data,
              baseProof: b.baseProof!,
              requestId: b.requestId!,
            }),
          ),
        );
      } else {
        res.json(
          workspaceStateWithProof(
            await transaction((c) => commit(c, req.actor!, b.revision, data)),
            req.actor!,
          ),
        );
      }
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
        ).then((state) => workspaceStateWithProof(state, req.actor!)),
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
        }).then((state) => workspaceStateWithProof(state, req.actor!)),
      );
    } catch (e) {
      next(e);
    }
  });
  app.get(
    '/api/people/:id/private',
    requireAccountPermission('privatePersonnel'),
    async (req: AuthRequest, res, next) => {
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
    },
  );
  app.put(
    '/api/people/:id/private',
    requireAccountPermission('privatePersonnel'),
    async (req: AuthRequest, res, next) => {
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
    },
  );
  app.post(
    '/api/import/preview',
    requireAccountPermission('backupImport'),
    async (req: AuthRequest, res, next) => {
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
    },
  );
  app.post(
    '/api/import/commit',
    requireAccountPermission('backupImport'),
    async (req: AuthRequest, res, next) => {
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
    },
  );
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
        lastRecord = '',
        ticks = 0;
      const close = () => {
        if (!res.writableEnded && !res.destroyed) res.write('event: session-expired\ndata: {}\n\n');
        clearInterval(timer);
        const removed = streams.delete(stream);
        res.end();
        if (removed) announcePresence(req.actor!.workspaceId);
      };
      const stream = {
        accountId: req.actor!.id,
        workspaceId: req.actor!.workspaceId,
        tokenHash: req.tokenHash!,
        close,
        notify: () => {
          if (!res.writableEnded && !res.destroyed) res.write('event: presence\ndata: {}\n\n');
        },
      };
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
          }
          const recordRevision = String(
            (
              await pool.query(
                'SELECT coalesce(max(id),0)::text revision FROM record_history WHERE workspace_id=$1',
                [actor.workspaceId],
              )
            ).rows[0].revision,
          );
          if (recordRevision !== lastRecord) {
            lastRecord = recordRevision;
            res.write(`event: records\ndata: ${JSON.stringify({ revision: recordRevision })}\n\n`);
          }
          if (++ticks % 5 === 0) res.write('event: presence\ndata: {}\n\n');
        } catch {
          close();
        } finally {
          busy = false;
        }
      }, 1000);
      streams.add(stream);
      announcePresence(req.actor!.workspaceId);
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
      if (error instanceof WorkspaceConflictError) {
        res
          .status(409)
          .json({ error: error.message, conflicts: error.conflicts, current: error.current });
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
