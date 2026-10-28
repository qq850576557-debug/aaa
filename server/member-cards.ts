import type { Express } from 'express';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { owner, type AuthRequest } from './auth';
import { transaction } from './db';
import { ApiError, audit } from './store';
import { cardEdit, managedCardEdit, departmentEdit } from '../src/lib/member-cards';
export function memberCardRoutes(app: Express, announce: (workspaceId: string) => void) {
  app.get('/api/member-cards', async (req: AuthRequest, res, next) => {
    try {
      const a = req.actor!;
      const cards = await transaction(
        async (c) =>
          (
            await c.query(
              `SELECT a.id,a.login,coalesce(nullif(a.display_name,''),a.login) AS "displayName",a.active,(w.owner_account_id=a.id) AS owner,v.version AS "avatarVersion",cv.version AS "cardAvatarVersion",coalesce(m.job_title,'') AS "jobTitle",coalesce(m.english_name,'') AS "englishName",m.department_id AS "departmentId",d.name AS "departmentName",d.english_name AS "departmentEnglishName",to_char(m.joined_on,'YYYY-MM-DD') AS "joinedOn" FROM account a JOIN cloud_workspace w ON w.id=a.workspace_id LEFT JOIN member_card m ON m.account_id=a.id AND m.workspace_id=a.workspace_id LEFT JOIN department d ON d.workspace_id=a.workspace_id AND d.id=m.department_id LEFT JOIN account_avatar v ON v.account_id=a.id LEFT JOIN card_avatar cv ON cv.account_id=a.id WHERE a.workspace_id=$1 ORDER BY a.active DESC,a.login`,
              [a.workspaceId],
            )
          ).rows,
      );
      res.json({
        cards: cards.map(({ joinedOn, ...r }) => ({
          ...r,
          ...(a.owner || a.id === r.id ? { joinedOn } : {}),
        })),
      });
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/departments', async (req: AuthRequest, res, next) => {
    try {
      const departments = await transaction(
        async (c) =>
          (
            await c.query(
              `SELECT d.id,d.name,d.english_name AS "englishName",d.active,count(m.account_id)::int AS members FROM department d LEFT JOIN member_card m ON m.workspace_id=d.workspace_id AND m.department_id=d.id WHERE d.workspace_id=$1 GROUP BY d.workspace_id,d.id ORDER BY d.active DESC,d.name`,
              [req.actor!.workspaceId],
            )
          ).rows,
      );
      res.json({ departments });
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/departments', owner, async (req: AuthRequest, res, next) => {
    try {
      const b = departmentEdit.parse(req.body),
        id = randomUUID();
      await transaction(async (c) => {
        await c.query(
          'INSERT INTO department(workspace_id,id,name,english_name,active) VALUES($1,$2,$3,$4,$5)',
          [req.actor!.workspaceId, id, b.name, b.englishName, b.active],
        );
        await audit(c, req.actor!, 'department.create', undefined, {
          entityType: 'department',
          entityId: id,
          operation: 'create',
          changedFields: ['name', 'englishName', 'active'],
        });
      });
      res.status(201).json({ id });
    } catch (e) {
      next(e);
    }
  });
  app.put('/api/departments/:id', owner, async (req: AuthRequest, res, next) => {
    try {
      const b = departmentEdit.parse(req.body);
      await transaction(async (c) => {
        const q = await c.query(
          'UPDATE department SET name=$3,english_name=$4,active=$5 WHERE workspace_id=$1 AND id=$2 RETURNING id',
          [req.actor!.workspaceId, req.params.id, b.name, b.englishName, b.active],
        );
        if (!q.rowCount) throw new ApiError(404, '部门不存在');
        await audit(c, req.actor!, 'department.update', undefined, {
          entityType: 'department',
          entityId: String(req.params.id),
          operation: 'update',
          changedFields: ['name', 'englishName', 'active'],
        });
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.delete('/api/departments/:id', owner, async (req: AuthRequest, res, next) => {
    try {
      await transaction(async (c) => {
        const p = await c.query(
          'SELECT id FROM department WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
          [req.actor!.workspaceId, req.params.id],
        );
        if (!p.rowCount) throw new ApiError(404, '部门不存在');
        if (
          (
            await c.query('SELECT 1 FROM member_card WHERE workspace_id=$1 AND department_id=$2', [
              req.actor!.workspaceId,
              req.params.id,
            ])
          ).rowCount
        )
          throw new ApiError(409, '部门仍有成员，请先调整分配或停用部门');
        await c.query('DELETE FROM department WHERE workspace_id=$1 AND id=$2', [
          req.actor!.workspaceId,
          req.params.id,
        ]);
        await audit(c, req.actor!, 'department.delete', undefined, {
          entityType: 'department',
          entityId: String(req.params.id),
          operation: 'delete',
        });
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  async function save(c: PoolClient, req: AuthRequest, target: string, managed: boolean) {
    const b = managed ? managedCardEdit.parse(req.body) : cardEdit.parse(req.body),
      a = req.actor!;
    const account = await c.query(
      'SELECT id FROM account WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [a.workspaceId, target],
    );
    if (!account.rowCount) throw new ApiError(404, '账号不存在');
    const previous =
      (
        await c.query(
          'SELECT department_id FROM member_card WHERE workspace_id=$1 AND account_id=$2',
          [a.workspaceId, target],
        )
      ).rows[0]?.department_id ?? null;
    const departmentId = 'departmentId' in b ? b.departmentId : previous;
    if (departmentId) {
      const q = await c.query(
        'SELECT active FROM department WHERE workspace_id=$1 AND id=$2 FOR SHARE',
        [a.workspaceId, departmentId],
      );
      if (!q.rowCount || (!q.rows[0].active && departmentId !== previous))
        throw new ApiError(409, '部门不存在或已停用');
    }
    await c.query('UPDATE account SET display_name=$3 WHERE workspace_id=$1 AND id=$2', [
      a.workspaceId,
      target,
      b.displayName,
    ]);
    await c.query(
      'INSERT INTO member_card(workspace_id,account_id,english_name,department_id,joined_on,job_title) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,account_id) DO UPDATE SET english_name=$3,department_id=$4,joined_on=$5,job_title=CASE WHEN $7 THEN $6 ELSE member_card.job_title END,updated_at=now()',
      [
        a.workspaceId,
        target,
        b.englishName,
        departmentId,
        b.joinedOn || null,
        'jobTitle' in b ? (b.jobTitle ?? '') : '',
        'jobTitle' in b,
      ],
    );
    // General audit is readable by employees: never include employment dates/values.
    await audit(c, a, 'account.card', undefined, {
      entityType: 'account',
      entityId: target,
      operation: 'update',
      changedFields: [
        'displayName',
        'englishName',
        ...(managed ? ['departmentId', 'jobTitle'] : []),
        'privateProfileChanged',
      ],
    });
  }
  app.put('/api/member-cards/me', async (req: AuthRequest, res, next) => {
    try {
      await transaction((c) => save(c, req, req.actor!.id, false));
      announce(req.actor!.workspaceId);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.put('/api/member-cards/:id', owner, async (req: AuthRequest, res, next) => {
    try {
      await transaction((c) => save(c, req, String(req.params.id), true));
      announce(req.actor!.workspaceId);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
}
