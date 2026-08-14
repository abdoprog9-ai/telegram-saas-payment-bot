import { buildServer } from './server.js';
import dotenv from 'dotenv';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

async function main() {
  const app = await buildServer();

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`🚀 Telegram SaaS Server running on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
