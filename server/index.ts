import { maintain } from './maintenance';
import { createApp } from './app';
import { config } from './config';
import { pool, privatePool } from './db';
import { assertDatabaseReady } from './database-readiness';
const q = await pool.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user');
if (q.rows[0]?.rolsuper) throw Error('Refusing to run API with PostgreSQL superuser');
await assertDatabaseReady(pool);
let maintenanceBusy = false;
const maintenance = setInterval(
  () => {
    if (maintenanceBusy) return;
    maintenanceBusy = true;
    void maintain()
      .catch(() =>
        console.error('Background retention maintenance failed; business state preserved.'),
      )
      .finally(() => {
        maintenanceBusy = false;
      });
  },
  60 * 60 * 1000,
);
const server = createApp().listen(config.API_PORT, '127.0.0.1', () =>
  console.log(`Chunmo API ready on loopback port ${config.API_PORT} (${config.APP_ENV}).`),
);
async function stop() {
  clearInterval(maintenance);
  server.close();
  server.closeAllConnections();
  await pool.end();
  await privatePool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
