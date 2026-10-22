import { env } from './config/env.js';
import { createApp } from './app.js';
import { pool } from './db/pool.js';
import { SERVICE_TARGET_SUMMARY } from './modules/providers/index.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`ShipYard control plane listening on :${env.PORT} (${env.NODE_ENV})`);
  // Print the live routing table on boot. A stale process is otherwise
  // invisible: it answers /health happily while silently sending a `backend`
  // service to whatever target that older build knew about. If this line is
  // missing from your logs, the process predates container deploys — restart it.
  for (const line of SERVICE_TARGET_SUMMARY()) console.log(`  ${line}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
  });
}
