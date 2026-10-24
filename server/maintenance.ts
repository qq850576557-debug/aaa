import { pool, transaction } from './db';
import { retainHistory, validateHistory } from '../src/lib/history';
export async function maintain() {
  await pool.query('DELETE FROM auth_session WHERE expires_at<now()');
  await pool.query('DELETE FROM login_limit WHERE expires_at<now()');
  await pool.query('DELETE FROM import_preview WHERE expires_at<now()');
  const ids = await pool.query('SELECT workspace_id FROM workspace_state');
  for (const row of ids.rows)
    await transaction(async (c) => {
      const q = await c.query(
        'SELECT history FROM workspace_state WHERE workspace_id=$1 FOR UPDATE',
        [row.workspace_id],
      );
      if (q.rowCount)
        await c.query('UPDATE workspace_state SET history=$2 WHERE workspace_id=$1', [
          row.workspace_id,
          JSON.stringify(retainHistory(validateHistory(q.rows[0].history))),
        ]);
    });
}
