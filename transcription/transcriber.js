//The person's own switch for transcribing their speech during a call (D-37). It ties together: the call (the microphone track
//and the "being transcribed" flag everyone sees), the engine (Whisper in the browser) and the transcript log (what is sent).
//
//  state: 'off' | 'loading' (model) | 'waiting' (microphone is off) | 'listening' | 'transcribing' | 'error'
//
//Rules: it never starts by itself (enable() is the person's choice); it only runs while the person is in the call; it
//follows the microphone (mic off -> waiting, mic on -> listening again); leaving the call turns it off.
const LANGUAGE_KEY = 'agora.transcription.language';
export const LANGUAGES = { pt: 'Português', en: 'English', es: 'Español', auto: 'Detectar' };

export class Transcriber {
    #engine; #client; #room; #storage;
    #enabled = false;
    #state = 'off';
    #progress = 0;
    #error = null;
    #language;
    #session = null;
    #track = null;
    #listeners = new Set();
    #stopRoom;

    //engine: WhisperProvider (or anything with supported/load/start).  client: TranscriptClient.  room: ConferenceRoom.
    constructor({ engine, client, room, storage = globalThis.localStorage }) {
        this.#engine = engine; this.#client = client; this.#room = room; this.#storage = storage;
        let saved = null;
        try { saved = storage?.getItem(LANGUAGE_KEY); } catch { /* storage blocked: the default is fine */ }
        this.#language = saved in LANGUAGES ? saved : 'pt';
        this.#stopRoom = room.on('change', () => this.#follow());
    }

    get state() { return this.#state; }
    get enabled() { return this.#enabled; }
    get progress() { return this.#progress; }
    get error() { return this.#error; }
    get language() { return this.#language; }
    get supported() { return this.#engine.supported; }
    get unsupportedReason() { return this.#engine.unsupportedReason; }
    get canWrite() { return this.#client.canWrite; }

    onChange(fn) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
    #set(patch) {
        const before = `${this.#state}|${this.#progress}|${this.#error}|${this.#enabled}`;
        if ('state' in patch) this.#state = patch.state;
        if ('progress' in patch) this.#progress = patch.progress;
        if ('error' in patch) this.#error = patch.error;
        if ('enabled' in patch) this.#enabled = patch.enabled;
        if (before !== `${this.#state}|${this.#progress}|${this.#error}|${this.#enabled}`) for (const fn of [...this.#listeners]) { try { fn(); } catch (e) { console.error('[transcriber] listener error:', e); } }
    }

    setLanguage(code) {
        if (!(code in LANGUAGES) || code === this.#language) return;
        this.#language = code;
        try { this.#storage?.setItem(LANGUAGE_KEY, code); } catch { /* per-viewer convenience only */ }
        this.#restartSession();
        this.#set({});
    }

    //The person asks to be transcribed. Needs to be in the call; the microphone may come later.
    async enable() {
        if (this.#enabled) return;
        if (!this.#room.joined) { this.#set({ error: 'Entre na chamada para ser transcrito.' }); return; }
        if (!this.#client.canWrite) { this.#set({ error: 'Seu papel não permite transcrever.' }); return; }
        if (!this.#engine.supported) { this.#set({ error: this.#engine.unsupportedReason }); return; }
        this.#set({ enabled: true, error: null, state: 'loading', progress: 0 });
        this.#room.setTranscribing(true);                                  // everyone sees who is being transcribed
        try { await this.#engine.load(fraction => this.#set({ progress: fraction })); }
        catch (error) {
            this.#room.setTranscribing(false);
            this.#set({ enabled: false, state: 'error', error: error.message });
            return;
        }
        if (!this.#enabled) return;                                         // turned off while the model was loading
        this.#set({ state: 'waiting', progress: 1 });
        this.#follow();
    }

    disable() {
        if (!this.#enabled && this.#state === 'off') return;
        this.#stopSession();
        this.#room.setTranscribing(false);
        this.#set({ enabled: false, state: 'off', error: null });
    }

    //Keeps the session in line with the call and the microphone
    #follow() {
        if (!this.#enabled || this.#state === 'loading') return;
        if (!this.#room.joined) { this.disable(); return; }
        const track = this.#room.localAudioTrack;
        if (!track) { this.#stopSession(); this.#set({ state: 'waiting' }); return; }
        if (track === this.#track && this.#session) return;
        this.#restartSession();
    }

    #restartSession() {
        this.#stopSession();
        if (!this.#enabled || this.#state === 'loading') return;
        const track = this.#room.localAudioTrack;
        if (!track) return;
        this.#track = track;
        this.#set({ state: 'listening' });
        try {
            this.#session = this.#engine.start(track, {
                language: this.#language,
                onSegment: ({ text, startedAt }) => this.#client.send(text, { startedAt, language: this.#language }),
                onState: state => { if (this.#enabled && this.#session) this.#set({ state: state === 'behind' ? 'transcribing' : state === 'error' ? 'error' : state, error: state === 'error' ? 'Não foi possível ouvir o microfone para transcrever.' : this.#error }); },
            });
        } catch (error) { this.#set({ state: 'error', error: error.message }); }
    }

    #stopSession() {
        this.#session?.stop();
        this.#session = null;
        this.#track = null;
    }

    destroy() { this.#stopRoom(); this.#stopSession(); this.#listeners.clear(); }
}
