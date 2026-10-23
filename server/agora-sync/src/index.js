import { createSyncServer } from './server.js';

const devAuth = process.env.AGORA_DEV_AUTH === '1';
let iceServers = null;
if (process.env.AGORA_ICE_SERVERS) {
    try { iceServers = JSON.parse(process.env.AGORA_ICE_SERVERS); if (!Array.isArray(iceServers)) throw new Error('not a list'); }
    catch (error) { console.error(`[agora-sync] AGORA_ICE_SERVERS must be a JSON list of RTCIceServer (${error.message})`); process.exit(1); }
}
let server;
try {
    server = createSyncServer({
        secret: process.env.AGORA_SYNC_SECRET,
        adminToken: process.env.AGORA_SYNC_ADMIN_TOKEN || null,
        dataDir: process.env.DATA_DIR ?? './data',
        chatRetentionDays: Number(process.env.CHAT_RETENTION_DAYS ?? 0) || 0,
        transcriptRetentionDays: Number(process.env.TRANSCRIPT_RETENTION_DAYS ?? 0) || 0,
        iceServers,
        devAuth,
        //What the host system hears about (calls, recordings): a signed webhook, retried until it answers (docs 09, 9.2 EventSink)
        webhookUrl: process.env.AGORA_WEBHOOK_URL || null,
        webhookSecret: process.env.AGORA_WEBHOOK_SECRET || null,
        maxPartBytes: Number(process.env.MAX_RECORDING_PART_BYTES ?? 0) || undefined,
        recordingIdleMs: (Number(process.env.RECORDING_IDLE_SECONDS ?? 0) || 120) * 1000,
        log: message => console.log(`[agora-sync] ${message}`),
    });
} catch (error) {
    console.error(`[agora-sync] ${error.message}`);
    process.exit(1);
}
if (process.env.AGORA_SYNC_ADMIN_TOKEN && process.env.AGORA_SYNC_ADMIN_TOKEN.length < 16) {
    console.error('[agora-sync] AGORA_SYNC_ADMIN_TOKEN must have at least 16 characters');
    process.exit(1);
}
const port = Number(process.env.PORT ?? 8787);
const host = process.env.BIND_ADDR ?? '127.0.0.1';
await server.listen(port, host);
console.log(`[agora-sync] listening on ${host}:${port}${devAuth ? ' (DEV AUTH ENABLED: do not expose)' : ''}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0); });
