import { createSyncServer } from './server.js';

const devAuth = process.env.AGORA_DEV_AUTH === '1';
let server;
try {
    server = createSyncServer({
        secret: process.env.AGORA_SYNC_SECRET,
        dataDir: process.env.DATA_DIR ?? './data',
        devAuth,
        log: message => console.log(`[agora-sync] ${message}`),
    });
} catch (error) {
    console.error(`[agora-sync] ${error.message}`);
    process.exit(1);
}
const port = Number(process.env.PORT ?? 8787);
const host = process.env.BIND_ADDR ?? '127.0.0.1';
await server.listen(port, host);
console.log(`[agora-sync] listening on ${host}:${port}${devAuth ? ' (DEV AUTH ENABLED: do not expose)' : ''}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0); });
