//Byte-level BPE (GPT-2 style: what ModernBERT/Laya's tokenizer.json describes), enough to encode plain text. No special-token
//handling: the caller adds [CLS]/[SEP]/[MASK] by id. Pure JS so it runs in the worker and in tests; parity with the Python
//`tokenizers` library is checked by tests/fixtures/laya_tokenizer_cases.json.
//
//  new ByteLevelBpe(tokenizerJson).encode('abre as notas') -> [ids]

//GPT-2's reversible byte -> printable-character table
const BYTE_CHAR = (() => {
    const keep = [...range(33, 126), ...range(161, 172), ...range(174, 255)];
    const table = new Map(keep.map(code => [code, String.fromCharCode(code)]));
    let extra = 0;
    for (let code = 0; code < 256; code++) if (!table.has(code)) table.set(code, String.fromCharCode(256 + extra++));
    return table;
})();
function range(from, to) { return Array.from({ length: to - from + 1 }, (_, i) => from + i); }

const PRETOKENIZE = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;
const encoder = new TextEncoder();

export class ByteLevelBpe {
    #vocab; #ranks = new Map(); #unk; #cache = new Map(); #added = new Map(); #addedPattern = null; #byName = new Map();

    constructor({ model, added_tokens = [] }) {
        if (model?.type !== 'BPE') throw new Error('ByteLevelBpe needs a BPE tokenizer.json');
        this.#vocab = model.vocab;
        model.merges.forEach((merge, rank) => this.#ranks.set(Array.isArray(merge) ? merge.join(' ') : merge, rank));
        this.#unk = model.unk_token != null ? this.#vocab[model.unk_token] : undefined;
        //Plain (non-special) added tokens, like runs of spaces, are cut out of the text BEFORE the BPE (as `tokenizers` does). Special
        //ones ([CLS]...) are NOT matched: a person saying "[MASK]" must not inject a control token.
        for (const token of added_tokens) this.#byName.set(token.content, token.id);
        const plain = added_tokens.filter(token => !token.special && token.content);
        for (const token of plain) this.#added.set(token.content, token.id);
        if (plain.length) this.#addedPattern = new RegExp(plain.map(token => token.content).sort((a, b) => b.length - a.length).map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
    }

    tokenId(token) { return this.#byName.get(token) ?? this.#vocab[token]; }

    encode(text) {
        const ids = [];
        const normalized = String(text).normalize('NFC');
        let at = 0;
        for (const found of this.#addedPattern ? normalized.matchAll(this.#addedPattern) : []) {
            this.#encodePlain(normalized.slice(at, found.index), ids);
            ids.push(this.#added.get(found[0]));
            at = found.index + found[0].length;
        }
        this.#encodePlain(normalized.slice(at), ids);
        return ids;
    }

    #encodePlain(text, ids) {
        for (const word of text.match(PRETOKENIZE) ?? []) {
            const symbols = [...encoder.encode(word)].map(byte => BYTE_CHAR.get(byte));
            for (const piece of this.#merge(symbols.join('\u0000'), symbols)) {
                const id = this.#vocab[piece] ?? this.#unk;
                if (id !== undefined) ids.push(id);
            }
        }
    }

    #merge(key, symbols) {
        const cached = this.#cache.get(key);
        if (cached) return cached;
        let parts = symbols;
        while (parts.length > 1) {
            let best = -1, rank = Infinity;
            for (let i = 0; i < parts.length - 1; i++) {
                const r = this.#ranks.get(`${parts[i]} ${parts[i + 1]}`);
                if (r !== undefined && r < rank) { rank = r; best = i; }
            }
            if (best < 0) break;
            parts = [...parts.slice(0, best), parts[best] + parts[best + 1], ...parts.slice(best + 2)];
        }
        if (this.#cache.size < 5000) this.#cache.set(key, parts);
        return parts;
    }
}
