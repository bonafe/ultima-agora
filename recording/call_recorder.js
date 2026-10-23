//What a person uses to record THEIR side of the call: ties the Recorder to the conference room and the call session.
//  - starts only from inside the call, with the person's explicit consent;
//  - tells everyone through presence (room.setRecording) for as long as it goes on;
//  - records a stream that survives muting (silence where I was muted), so every track stays in step with the call.
import { createMicSource } from './mic_source.js';
import { RecorderError } from './recorder.js';

export class CallRecorder {
    #recorder; #room; #call; #source = null; #makeSource;

    constructor({ recorder, room, call, createSource = createMicSource }) {
        this.#recorder = recorder; this.#room = room; this.#call = call; this.#makeSource = createSource;
        //A recording that ends by itself (the server refused it, the person left the call) must take the flag down
        recorder.onChange(() => { if (!recorder.recording) this.#release(); });
        room.on('change', () => { if (!room.joined && recorder.recording) this.stop(); });
    }

    get supported() { return this.#recorder.supported; }
    get recording() { return this.#recorder.recording; }
    get pending() { return this.#recorder.pending; }
    get lastError() { return this.#recorder.lastError; }
    get sessionId() { return this.#call?.sessionId ?? null; }
    onChange(fn) { return this.#recorder.onChange(fn); }

    #release() {
        if (!this.#source) return;
        this.#source.dispose(); this.#source = null;
        this.#room.setRecording(false);
    }

    async start({ consented = false } = {}) {
        if (consented !== true) throw new RecorderError('consent_required', 'A gravação só começa com o seu consentimento.');
        if (!this.#room.joined) throw new RecorderError('not_in_call', 'Entre na chamada para gravar.');
        this.#source = this.#makeSource({ getTrack: () => this.#room.localAudioTrack, subscribe: fn => this.#room.on('change', fn) });
        try {
            const record = await this.#recorder.start({ stream: this.#source.stream, kind: 'audio', consented: true });
            this.#room.setRecording(true);                    //only once it really started: the badge never lies
            return record;
        } catch (error) { this.#release(); throw error; }
    }

    async stop() { await this.#recorder.stop(); this.#release(); }
    resume() { return this.#recorder.resume(); }
}
