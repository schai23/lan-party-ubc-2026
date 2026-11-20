// Entry point: `pnpm start` / `pnpm -F @sidekick/server dev`. (Import `startServer` from ./app to embed.)
import { startServer } from './app';

const srv = await startServer();
const stop = async () => { await srv.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
