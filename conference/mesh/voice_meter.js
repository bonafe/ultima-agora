//Voice activity of one microphone track, for the "who is speaking" indicator. Local only: others learn it through
//presence (R-CONF-3), so the indicator needs no extra stream analysis on their side.
const ON_LEVEL = 0.03, OFF_LEVEL = 0.015, HOLD_TICKS = 5, TICK_MS = 120;

export class VoiceMeter {
    #context = null; #timer = null; #quiet = 0; #speaking = false;

    //onChange(speaking: boolean) is called only when it changes
    constructor(onChange, AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext) {
        this.onChange = onChange;
        this.AudioContextClass = AudioContextClass;
    }

    start(track) {
        this.stop();
        if (!this.AudioContextClass) return;
        try {
            this.#context = new this.AudioContextClass();
            this.#context.resume?.().catch(() => {});
            const analyser = this.#context.createAnalyser();
            analyser.fftSize = 512;
            this.#context.createMediaStreamSource(new MediaStream([track])).connect(analyser);
            const samples = new Float32Array(analyser.fftSize);
            this.#timer = setInterval(() => {
                analyser.getFloatTimeDomainData(samples);
                const level = Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
                if (level > ON_LEVEL) { this.#quiet = 0; this.#set(true); }
                else if (level < OFF_LEVEL && ++this.#quiet >= HOLD_TICKS) this.#set(false);
            }, TICK_MS);
        } catch (error) { console.warn('[conference] voice meter unavailable:', error.message); this.stop(); }
    }

    stop() {
        clearInterval(this.#timer);
        this.#timer = null;
        this.#context?.close?.().catch(() => {});
        this.#context = null;
        this.#quiet = 0;
        this.#set(false);
    }

    #set(value) { if (value !== this.#speaking) { this.#speaking = value; this.onChange(value); } }
}
