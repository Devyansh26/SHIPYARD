import { env } from './config/env.js';
import { createApp } from './app.js';
import { pool } from './db/pool.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`ShipYard control plane listening on :${env.PORT} (${env.NODE_ENV})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
  });
}
