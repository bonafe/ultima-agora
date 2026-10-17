//Pure audio logic around Whisper (no browser APIs, so it is tested with plain arrays): resampling to the 16 kHz Whisper
//expects, cutting the microphone into utterances by voice activity, and discarding what Whisper invents on silence.

export const WHISPER_RATE = 16000;

//Streaming downsampler (box filter): keeps its position between calls, so the blocks of a continuous signal join without clicks.
export class Resampler {
    #ratio; #acc = 0; #need;
    constructor(inputRate, outputRate = WHISPER_RATE) { this.#ratio = inputRate / outputRate; this.#need = this.#ratio; }

    process(samples) {
        if (this.#ratio === 1) return samples;
        const out = [];
        for (let i = 0; i < samples.length; i++) {
            const x = samples[i];
            if (this.#need >= 1) {
                this.#acc += x; this.#need -= 1;
                if (this.#need < 1e-9) { out.push(this.#acc / this.#ratio); this.#acc = 0; this.#need = this.#ratio; }
            } else {                                         // this input sample straddles two output samples
                this.#acc += x * this.#need;
                out.push(this.#acc / this.#ratio);
                this.#acc = x * (1 - this.#need);
                this.#need = this.#ratio - (1 - this.#need);
            }
        }
        return Float32Array.from(out);
    }
}

const FRAME = 320;                           // 20 ms at 16 kHz
const START_FRAMES = 3;                      // speech must persist 60 ms to start an utterance (a click is not speech)
const MIN_START_LEVEL = 0.012;               // RMS below this is never speech, whatever the room noise
const NOISE_FACTOR = 2.5;                    // speech = this many times above the room's noise floor
const PRE_ROLL_FRAMES = 15;                  // 300 ms kept from before the start: the first syllable is not cut
const END_SILENCE_FRAMES = 35;               // 700 ms of silence ends the utterance
const TRAILING_FRAMES = 8;                   // of that silence, 160 ms stay in the audio
const MIN_SPEECH_FRAMES = 20;                // under 400 ms of speech is noise, a cough, a chair
const MAX_FRAMES = 1250;                     // 25 s: Whisper takes at most 30 s at a time

//Voice-activity segmenter. feed(samples at 16 kHz) calls onUtterance({ audio: Float32Array, startedAt, durationMs }) per utterance.
//`clock` returns the time in ms of the START of the samples being fed (so tests need no real time).
export class Segmenter {
    #onUtterance; #now;
    #pending = new Float32Array(0);
    #noise = 0.005;
    #pre = [];                               // frames before the start, newest last
    #frames = null;                          // the utterance in progress (array of frames), or null
    #loud = 0; #silent = 0; #speech = 0;
    #startedAt = 0;
    #processed = 0;                          // samples consumed since the beginning

    constructor({ onUtterance, startTime = 0 }) { this.#onUtterance = onUtterance; this.#now = startTime; }

    feed(samples) {
        const joined = new Float32Array(this.#pending.length + samples.length);
        joined.set(this.#pending); joined.set(samples, this.#pending.length);
        let offset = 0;
        for (; offset + FRAME <= joined.length; offset += FRAME) this.#frame(joined.subarray(offset, offset + FRAME));
        this.#pending = joined.slice(offset);
    }

    //Ends whatever is in progress (the person muted the microphone or stopped transcribing)
    flush() {
        if (this.#frames) this.#finish(0);
        this.#pending = new Float32Array(0);
    }

    #frame(frame) {
        const at = this.#now + this.#processed / WHISPER_RATE * 1000;
        this.#processed += FRAME;
        let sum = 0;
        for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
        const level = Math.sqrt(sum / frame.length);
        const voiced = level > Math.max(MIN_START_LEVEL, this.#noise * NOISE_FACTOR);
        const copy = frame.slice();

        if (!this.#frames) {
            if (!voiced) this.#noise += (level - this.#noise) * 0.02;              // only silence teaches the noise floor
            this.#pre.push(copy);
            if (this.#pre.length > PRE_ROLL_FRAMES) this.#pre.shift();
            this.#loud = voiced ? this.#loud + 1 : 0;
            if (this.#loud >= START_FRAMES) {
                this.#frames = [...this.#pre];
                this.#startedAt = at - (this.#frames.length - 1) * 20;
                this.#pre = []; this.#loud = 0; this.#silent = 0; this.#speech = START_FRAMES;
            }
            return;
        }
        this.#frames.push(copy);
        if (voiced) { this.#silent = 0; this.#speech++; } else this.#silent++;
        if (this.#silent >= END_SILENCE_FRAMES) this.#finish(this.#silent - TRAILING_FRAMES);
        else if (this.#frames.length >= MAX_FRAMES) this.#finish(0);
    }

    //dropTrailing: frames of silence to cut off the end
    #finish(dropTrailing) {
        const frames = this.#frames;
        this.#frames = null; this.#silent = 0; this.#loud = 0;
        const kept = frames.slice(0, frames.length - Math.max(0, dropTrailing));
        const speech = this.#speech; this.#speech = 0;
        if (speech < MIN_SPEECH_FRAMES) return;
        const audio = new Float32Array(kept.length * FRAME);
        kept.forEach((f, i) => audio.set(f, i * FRAME));
        this.#onUtterance({ audio, startedAt: this.#startedAt, durationMs: kept.length * 20 });
    }
}

//What Whisper writes when it hears nothing: tags, applause, subtitle credits learned from its training data, loops.
const PHANTOM = [
    /^[\s.…,!?-]*$/,
    /^[\[(♪*].*[\])♪*]$/,                                                       // [Música] (aplausos) ♪ ... ♪
    /^(obrigad[oa]( por assistir)?|muito obrigad[oa]|tchau|até (a )?próxima|inscreva-se.*|legendas? (pel[ao]|por|de) .*|thanks for watching|thank you( for watching)?\.?|subtitles by .*)[.!\s]*$/i,
];
export function cleanTranscript(text) {
    let clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!clean || PHANTOM.some(pattern => pattern.test(clean))) return '';
    const words = clean.split(' ');
    //A decoding loop ("e e e e e e e ...") is not speech: keep a few repetitions at most
    const out = [];
    let run = 0;
    for (const word of words) {
        run = word.toLowerCase() === out.at(-1)?.toLowerCase() ? run + 1 : 1;
        if (run <= 3) out.push(word);
    }
    clean = out.join(' ');
    return clean;
}
