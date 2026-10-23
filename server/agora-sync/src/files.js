//FileStore (docs/especificacao/09, 9.2): where the bytes of a recording live. The workspace document never holds bytes,
//only a reference (`blob:<id>`, R-DOC-4); this is the object store behind that reference.
//
//The contract (any implementation: this disk one, S3/Garage, or the host system's own):
//   beginUpload()                          -> uploadId
//   putPart(uploadId, n, bytes)            idempotent: the same part twice is the same part
//   partsPresent(uploadId)                 -> [n, ...] ascending
//   complete(uploadId, { parts })          -> { blobId, sizeBytes, sha256, missing[], truncated }
//                                             `parts` is how many were sent; without it, the contiguous prefix is taken
//   abort(uploadId)
//   open(blobId, { start, end }?)          -> { stream, size } | null     (size is the whole file's)
//   signDownload(blobId, ttlSeconds)       -> { exp, sig }       verifyDownload(blobId, exp, sig) -> boolean
//   delete(blobId)
import { mkdir, writeFile, rename, readdir, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

const ID = /^[0-9a-f-]{36}$/;
const MAX_PARTS = 100_000;

export class FileStoreError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

export class DiskFileStore {
    #dir; #secret;
    constructor({ dir, secret }) {
        if (!dir) throw new Error('DiskFileStore needs a directory');
        this.#dir = dir; this.#secret = secret;
    }

    #uploadDir(uploadId) {
        if (!ID.test(uploadId)) throw new FileStoreError('bad_request', 'uploadId inválido.');
        return join(this.#dir, 'uploads', uploadId);
    }
    #blobPath(blobId) {
        if (!ID.test(blobId)) throw new FileStoreError('bad_request', 'blobId inválido.');
        return join(this.#dir, 'blobs', blobId);
    }

    async beginUpload() {
        const uploadId = randomUUID();
        await mkdir(this.#uploadDir(uploadId), { recursive: true });
        return uploadId;
    }

    async putPart(uploadId, n, bytes) {
        if (!Number.isInteger(n) || n < 0 || n >= MAX_PARTS) throw new FileStoreError('bad_request', 'Número de parte inválido.');
        const dir = this.#uploadDir(uploadId);
        const temporary = join(dir, `${n}.tmp`);
        await writeFile(temporary, bytes);
        await rename(temporary, join(dir, `${n}.part`));            //atomic: a half-written part never counts
    }

    async partsPresent(uploadId) {
        try {
            return (await readdir(this.#uploadDir(uploadId))).filter(f => f.endsWith('.part')).map(f => Number.parseInt(f, 10)).sort((a, b) => a - b);
        } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    }

    //Joins the parts in order into one blob, streaming (a long video is never held in memory)
    async complete(uploadId, { parts = null } = {}) {
        const present = await this.partsPresent(uploadId);
        const have = new Set(present);
        let prefix = 0; while (have.has(prefix)) prefix++;            //how many parts are there with no hole before them
        const take = parts ?? prefix;
        const missing = []; for (let n = 0; n < take; n++) if (!have.has(n)) missing.push(n);
        const usable = missing.length ? missing[0] : take;           //never skip a gap: what follows a hole is not joined
        const blobId = randomUUID();
        await mkdir(join(this.#dir, 'blobs'), { recursive: true });
        const out = createWriteStream(this.#blobPath(blobId));
        const hash = createHash('sha256');
        let sizeBytes = 0;
        try {
            for (let n = 0; n < usable; n++) {
                await new Promise((resolve, reject) => {
                    const input = createReadStream(join(this.#uploadDir(uploadId), `${n}.part`));
                    input.on('data', chunk => { hash.update(chunk); sizeBytes += chunk.length; if (!out.write(chunk)) { input.pause(); out.once('drain', () => input.resume()); } });
                    input.on('end', resolve); input.on('error', reject);
                });
            }
            await new Promise((resolve, reject) => { out.end(resolve); out.on('error', reject); });
        } catch (error) {
            out.destroy();
            await rm(this.#blobPath(blobId), { force: true });
            throw new FileStoreError('storage', `Não foi possível montar o arquivo: ${error.message}`);
        }
        await rm(this.#uploadDir(uploadId), { recursive: true, force: true });
        return { blobId, sizeBytes, sha256: hash.digest('hex'), missing, truncated: missing.length > 0 || present.length > usable };
    }

    async abort(uploadId) { await rm(this.#uploadDir(uploadId), { recursive: true, force: true }); }

    //range: { start, end } inclusive, for a player that seeks
    async open(blobId, range = null) {
        try {
            const path = this.#blobPath(blobId);
            const { size } = await stat(path);
            return { stream: createReadStream(path, range ? { start: range.start, end: range.end } : undefined), size };
        } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }

    signDownload(blobId, ttlSeconds = 300, now = Date.now()) {
        const exp = Math.floor(now / 1000) + ttlSeconds;
        return { exp, sig: createHmac('sha256', this.#secret).update(`${blobId}.${exp}`).digest('hex') };
    }

    verifyDownload(blobId, exp, sig, now = Date.now()) {
        if (!Number.isFinite(Number(exp)) || Number(exp) * 1000 < now || typeof sig !== 'string') return false;
        const expected = Buffer.from(createHmac('sha256', this.#secret).update(`${blobId}.${Number(exp)}`).digest('hex'));
        const given = Buffer.from(sig);
        return given.length === expected.length && timingSafeEqual(given, expected);
    }

    async delete(blobId) { await rm(this.#blobPath(blobId), { force: true }); }
}
