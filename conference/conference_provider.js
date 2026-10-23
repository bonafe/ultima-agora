//The conference contract (docs/especificacao/06, 6.2, D-36). The core and the components know only this; WebRTC itself
//lives in a provider (conference/mesh/ for small groups; LiveKit later, behind the same surface).
//
//  provider.connect({ roomId, signaling, presence, me, canPublish }) -> ConferenceRoom   (idle: it already knows who is in the call)
//
//  room.supported            false (with room.unsupportedReason) when this browser/context cannot capture or connect
//  room.joined               am I in the call?
//  room.participants         [{ clientId, user: { id, name, color }, self, mic, cam, speaking, transcribing, recording, stream: MediaStream | null }]
//                            everyone in the call (and, before I join, who is already there), me first
//  room.join({ mic, cam })   enter the call. Mic/cam start OFF unless asked: nothing is ever turned on by itself (R-CONF privacy).
//                            Resolves with { errors } (a denied camera does not stop the person from joining the call)
//  room.setMic(on) / room.setCam(on)   turning OFF stops the capture (the device light goes out), it does not just mute
//  room.localAudioTrack      my microphone track while it is on (null otherwise): what the transcription listens to
//  room.setTranscribing(on)  tell everyone I am being transcribed (it is part of the media state in presence)
//  room.setRecording(on)     tell everyone I am recording my side of the call (same: nobody is recorded unseen)
//  room.leave()
//  room.on('change' | 'participant-joined' | 'participant-left' | 'track-subscribed' | 'speaking' | 'error', fn) -> off
//
//Signalling (the provider asks for it, the host supplies it): { clientId, send(to, data) -> boolean, onSignal(fn) -> off }
//Presence (media state, R-CONF-3): the room publishes { conference: { in, mic, cam, speaking, transcribing, recording } } through presence.setLocal().

//An error the person can read. code: 'denied' | 'no_device' | 'busy' | 'insecure' | 'unsupported' | 'forbidden' | 'not_joined' | 'failed'
export class ConferenceError extends Error {
    constructor(code, message) { super(message); this.name = 'ConferenceError'; this.code = code; }
}

export class ConferenceRoom {
    #listeners = new Map();

    on(event, fn) {
        if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
        this.#listeners.get(event).add(fn);
        return () => this.#listeners.get(event)?.delete(fn);
    }

    _emit(event, payload) {
        for (const fn of [...(this.#listeners.get(event) ?? [])]) {
            try { fn(payload); } catch (error) { console.error(`[conference] listener for "${event}" failed:`, error); }
        }
    }

    //Anything the UI draws changed
    _changed() { this._emit('change'); }
}
