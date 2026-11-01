import type { Express } from 'express';
import { owner, type AuthRequest } from './auth';
import { transaction } from './db';
import { dataSchema } from '../src/lib/model';
// Inventory is raw, read-only and opt-in. It never normalizes or migrates records.
export function upgradePreviewRoutes(app: Express) {
  app.get('/api/upgrade-data-preview', owner, async (req: AuthRequest, res, next) => {
    try {
      res.json(
        await transaction(async (c) => {
          await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
          const w = req.actor!.workspaceId;
          const raw = (
            await c.query(
              'SELECT revision,data,history FROM workspace_state WHERE workspace_id=$1',
              [w],
            )
          ).rows[0];
          const totals: Record<string, number | null> = {};
          const unrecognizedSources: { source: string; index?: number; reason: string }[] = [];
          const rows = (key: string): any[] =>
            Array.isArray(raw.data?.[key]) ? raw.data[key] : [];
          const historyNodes = Array.isArray(raw.history?.records)
            ? raw.history.records.length
            : null;
          if (historyNodes === null)
            unrecognizedSources.push({
              source: 'history.records',
              reason: '历史列表结构无法识别，保留原样且数量待核对',
            });
          for (const key of [
            'projects',
            'trades',
            'tasks',
            'notes',
            'purchases',
            'people',
            'dictionaries',
          ]) {
            const source = raw.data?.[key];
            totals[key] = Array.isArray(source)
              ? source.length
              : source === undefined && ['people', 'dictionaries'].includes(key)
                ? 0
                : null;
            if (totals[key] === null)
              unrecognizedSources.push({
                source: key,
                reason: '列表结构缺失或属于无法识别的旧结构，数量待核对',
              });
            rows(key).forEach((row, index) => {
              if (
                !row ||
                typeof row !== 'object' ||
                Array.isArray(row) ||
                typeof row.id !== 'string'
              )
                unrecognizedSources.push({
                  source: key,
                  index,
                  reason: '原记录缺少可识别的稳定ID，保留原样待核对',
                });
            });
          }
          const retained: Record<string, number> = {};
          for (const table of [
            'work_record',
            'record_history',
            'record_version',
            'purchase_record',
            'purchase_action',
            'material_item',
            'material_event',
            'material_history',
            'material_project_meta',
            'material_context',
            'material_alert',
            'material_transfer',
            'department',
            'member_card',
            'daily_assessment',
            'assessment_history',
            'account',
            'assignment',
            'audit_event',
            'legacy_record_link',
            'cloud_restore_backup',
          ])
            retained[table] = Number(
              (await c.query(`SELECT count(*) FROM ${table} WHERE workspace_id=$1`, [w])).rows[0]
                .count,
            );
          const projects = rows('projects')
            .filter((p) => p && typeof p === 'object')
            .map((p: any) => ({
              id: p.id,
              name: p.name,
              createdBy: p.createdBy ?? null,
              updatedAt: p.updatedAt ?? null,
              status: p.status,
              counts: Object.fromEntries(
                ['trades', 'tasks', 'notes', 'purchases'].map((key) => [
                  key,
                  totals[key] === null || typeof p.id !== 'string'
                    ? null
                    : rows(key).filter((x: any) => x?.projectId === p.id).length,
                ]),
              ),
            }));
          const recordSources = (
            await c.query(
              `SELECT id,project_id AS "projectId",created_by AS "createdBy",created_name AS "createdName",created_at AS "createdAt",updated_at AS "updatedAt",node_date AS date,status,deleted FROM work_record WHERE workspace_id=$1 ORDER BY project_id,id`,
              [w],
            )
          ).rows;
          const materialProjects = (
            await c.query(
              `SELECT payload->>'projectId' AS "projectId",count(*)::int AS contexts FROM material_context WHERE workspace_id=$1 GROUP BY payload->>'projectId'`,
              [w],
            )
          ).rows;
          return {
            readOnly: true,
            revision: Number(raw.revision),
            totals,
            retained,
            projects,
            recordSources,
            materialProjects,
            unrecognizedSources,
            unknownRootFields: Object.keys(raw.data ?? {}).filter(
              (key) => !Object.hasOwn(dataSchema.shape, key),
            ),
            legacySources: rows('notes')
              .filter((n) => n && typeof n === 'object')
              .map((n: any) => ({
                id: n.id,
                projectId: n.projectId,
                kind: n.kind,
                date: n.date,
                reminder: n.reminder,
                owner: n.owner,
                done: n.done,
                createdBy: n.createdBy ?? null,
                updatedAt: n.updatedAt ?? null,
              })),
            historyNodes,
            legacyPreview: '/api/legacy-migration/preview',
            productionMigrationExecuted: false,
            localDrafts: '浏览器各账号草稿不在服务器中，须分别导出核对',
            materialsDisposition: '仅停用界面；原表、项目关联、事件及历史保留，不自动迁移到采购',
          };
        }),
      );
    } catch (e) {
      next(e);
    }
  });
}
