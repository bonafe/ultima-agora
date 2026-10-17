//Conference in a full mesh (D-36): every browser connects straight to every other one with the browser's own
//RTCPeerConnection; the sync server only relays the offers/answers/ICE (signalling) between people of the workspace.
//Good for small groups (cost grows with the square of the people); LiveKit takes over behind the same contract.
//
//Who is in the call comes from PRESENCE (R-CONF-3), not from the connections: a person shows up in `participants`
//as soon as they join, and the connection follows. Between two people, the one with the LOWER client id offers; the
//other answers (no simultaneous offers). Each side has one audio and one video transceiver from the start, so turning
//the mic or the camera on and off is just replaceTrack(): no renegotiation. (A screen-share track will need
//renegotiation from either side: switch to "perfect negotiation" then.)
import { ConferenceRoom, ConferenceError } from '../conference_provider.js';
import { VoiceMeter } from './voice_meter.js';

const GRACE_MS = 5000;           // a peer missing from presence (e.g. a sync-server hiccup) keeps its connection this long
const RETRY_MS = 1000;
const DISCONNECTED_MS = 8000;    // 'disconnected' often heals by itself; after this long, start over
const CONSTRAINTS = {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } },
};
const DEVICE_NAME = { audio: 'microfone', video: 'câmera' };

const newGeneration = () => Math.random().toString(36).slice(2, 10);

function mediaError(error, kind) {
    const device = DEVICE_NAME[kind];
    if (error instanceof ConferenceError) return error;
    switch (error?.name) {
        case 'NotAllowedError': case 'SecurityError': return new ConferenceError('denied', `Sem permissão para usar o ${device}. Libere o acesso nas configurações do navegador para este site.`);
        case 'NotFoundError': case 'OverconstrainedError': return new ConferenceError('no_device', `Nenhum ${device} encontrado neste dispositivo.`);
        case 'NotReadableError': case 'AbortError': return new ConferenceError('busy', `O ${device} está em uso por outro programa ou aba.`);
        default: return new ConferenceError('failed', `Não foi possível ligar o ${device}: ${error?.message ?? error}`);
    }
}

export class MeshProvider {
    #options;

    //iceServers: RTCIceServer[] (STUN/TURN of the operator; none = direct connections only, enough for a LAN).
    //RTCPeerConnection / mediaDevices / AudioContext are injectable for tests.
    constructor({ iceServers = [], RTCPeerConnection = globalThis.RTCPeerConnection, mediaDevices = globalThis.navigator?.mediaDevices, AudioContext = undefined } = {}) {
        this.#options = { iceServers, RTCPeerConnection, mediaDevices, AudioContext };
    }

    connect({ roomId, signaling, presence, me, canPublish = () => true }) {
        return new MeshRoom({ ...this.#options, roomId, signaling, presence, me, canPublish });
    }
}

class MeshRoom extends ConferenceRoom {
    #o;
    #joined = false;
    #iceServers;
    #tracks = { audio: null, video: null };
    #acquiring = new Set();
    #cameraStream = null;
    #peers = new Map();            // clientId -> { clientId, user, pc, gen, initiator, stream, queue, senders, graceTimer, stateTimer }
    #roster = new Set();           // clientIds seen in the call, to emit joined/left
    #speaking = false;
    #transcribing = false;
    #meter;
    #stops = [];
    #destroyed = false;

    constructor(options) {
        super();
        this.#o = options;
        this.#iceServers = options.iceServers;
        this.roomId = options.roomId;
        this.#meter = new VoiceMeter(speaking => { this.#speaking = speaking; this.#publish(); this._emit('speaking', { clientId: this.#myId, speaking }); this._changed(); }, options.AudioContext);
        this.#stops.push(options.presence.onPeers(() => this.#reconcile()), options.signaling.onSignal(event => this.#onSignal(event)));
        this.#reconcile();
    }

    get #myId() { return this.#o.signaling.clientId; }
    get joined() { return this.#joined; }
    get supported() { return this.unsupportedReason === null; }
    get unsupportedReason() {
        if (!this.#o.RTCPeerConnection) return 'Este navegador não oferece chamadas de áudio e vídeo (WebRTC).';
        if (!this.#o.mediaDevices) return globalThis.isSecureContext === false
            ? 'Câmera e microfone só funcionam em conexão segura (HTTPS) ou em localhost. Abra o endereço https:// deste servidor.'
            : 'Este navegador não consegue acessar câmera e microfone.';
        return null;
    }
    get canPublish() { return this.#o.canPublish(); }
    //My microphone track while it is on (the transcription listens to it); null when off
    get localAudioTrack() { return this.#tracks.audio; }

    //Publishes that I am being transcribed, so everyone sees it (nobody is transcribed without the others knowing)
    setTranscribing(on) {
        if (this.#transcribing === !!on) return;
        this.#transcribing = !!on;
        if (this.#joined) this.#publish();
        this._changed();
    }

    //Replaces the STUN/TURN list (the server announces it after connecting); applies to connections made from now on
    setIceServers(iceServers) { if (Array.isArray(iceServers)) this.#iceServers = iceServers; }

    get participants() {
        const result = [];
        if (this.#joined) {
            const video = this.#tracks.video;
            if (video && this.#cameraStream?.getVideoTracks()[0] !== video) this.#cameraStream = new MediaStream([video]);
            result.push({ clientId: this.#myId, user: this.#o.presence.local.user ?? this.#o.me, self: true, mic: !!this.#tracks.audio, cam: !!video, speaking: this.#speaking, transcribing: this.#transcribing, stream: video ? this.#cameraStream : null });
        }
        for (const peer of this.#inCall()) {
            const c = peer.conference;
            result.push({ clientId: peer.clientId, user: peer.user, self: false, mic: !!c.mic, cam: !!c.cam, speaking: !!c.speaking, transcribing: !!c.transcribing, stream: this.#peers.get(peer.clientId)?.stream ?? null });
        }
        return result;
    }

    #inCall() { return this.#o.presence.peers().filter(p => p.conference?.in); }

    // ---- joining and leaving ----

    async join({ mic = false, cam = false } = {}) {
        if (!this.supported) throw new ConferenceError('unsupported', this.unsupportedReason);
        const errors = [];
        if (!this.#joined) {
            this.#joined = true;
            this.#publish();
            this.#reconcile();
            this._changed();
        }
        for (const [kind, wanted] of [['audio', mic], ['video', cam]]) {
            if (!wanted) continue;
            try { await this.#setTrack(kind, true); } catch (error) { errors.push(error); this._emit('error', error); }
        }
        return { errors };
    }

    leave() {
        if (!this.#joined) return;
        this.#joined = false;
        for (const kind of ['audio', 'video']) this.#stopTrack(kind);
        this.#meter.stop();
        this.#speaking = false;
        for (const id of [...this.#peers.keys()]) this.#closePeer(id);
        this.#transcribing = false;
        this.#o.presence.setLocal({ conference: null });
        this.#reconcile();
        this._changed();
    }

    destroy() {
        if (this.#destroyed) return;
        this.#destroyed = true;
        this.leave();
        this.#stops.forEach(stop => stop());
    }

    async setMic(on) { await this.#setTrack('audio', on); }
    async setCam(on) { await this.#setTrack('video', on); }

    async #setTrack(kind, on) {
        if (!this.#joined) throw new ConferenceError('not_joined', 'Entre na chamada primeiro.');
        if (on === !!this.#tracks[kind] || this.#acquiring.has(kind)) return;
        if (on) {
            if (!this.#o.canPublish()) throw new ConferenceError('forbidden', 'Seu papel só permite assistir e ouvir a chamada.');
            if (!this.supported) throw new ConferenceError('unsupported', this.unsupportedReason);
            this.#acquiring.add(kind);
            let track;
            try { track = (await this.#o.mediaDevices.getUserMedia({ [kind]: CONSTRAINTS[kind] })).getTracks()[0]; }
            catch (error) { throw mediaError(error, kind); }
            finally { this.#acquiring.delete(kind); }
            if (!this.#joined) { track.stop(); return; }                 // left while the browser was asking for permission
            this.#tracks[kind] = track;
            track.onended = () => { if (this.#tracks[kind] === track) this.#setTrack(kind, false).catch(() => {}); };      // unplugged
            if (kind === 'audio') this.#meter.start(track);
        } else {
            this.#stopTrack(kind);
            if (kind === 'audio') this.#meter.stop();
        }
        for (const peer of this.#peers.values()) peer.senders[kind]?.replaceTrack(this.#tracks[kind]).catch(() => {});
        this.#publish();
        this._changed();
    }

    #stopTrack(kind) {
        const track = this.#tracks[kind];
        if (!track) return;
        this.#tracks[kind] = null;
        track.onended = null;
        track.stop();                                                    // the device light goes out (R-CONF-7)
        if (kind === 'video') this.#cameraStream = null;
    }

    #publish() {
        this.#o.presence.setLocal({ conference: { in: true, mic: !!this.#tracks.audio, cam: !!this.#tracks.video, speaking: this.#speaking && !!this.#tracks.audio, transcribing: this.#transcribing } });
    }

    // ---- who should be connected ----

    #reconcile() {
        const present = new Map(this.#inCall().map(p => [p.clientId, p]));
        for (const [id, p] of present) if (!this.#roster.has(id)) this._emit('participant-joined', { clientId: id, user: p.user });
        for (const id of this.#roster) if (!present.has(id)) this._emit('participant-left', { clientId: id });
        this.#roster = new Set(present.keys());

        if (this.#joined) {
            for (const [id, p] of present) {
                const peer = this.#peers.get(id);
                if (peer) { clearTimeout(peer.graceTimer); peer.graceTimer = null; peer.user = p.user; }
                else if (this.#myId < id) this.#startPeer(id, p.user);
            }
            for (const [id, peer] of this.#peers) {
                if (!present.has(id) && !peer.graceTimer) peer.graceTimer = setTimeout(() => { this.#closePeer(id); this._changed(); }, GRACE_MS);
            }
        }
        this._changed();
    }

    // ---- connections ----

    #send(to, data) { return this.#o.signaling.send(to, data); }

    #newPeer(clientId, user, initiator, gen) {
        const pc = new this.#o.RTCPeerConnection({ iceServers: this.#iceServers });
        const peer = { clientId, user, pc, gen, initiator, stream: new MediaStream(), queue: Promise.resolve(), senders: {}, graceTimer: null, stateTimer: null };
        this.#peers.set(clientId, peer);

        pc.onicecandidate = event => { if (event.candidate) this.#send(clientId, { kind: 'candidate', gen, candidate: event.candidate.toJSON() }); };
        pc.ontrack = event => {
            peer.stream.addTrack(event.track);
            this._emit('track-subscribed', { clientId, kind: event.track.kind });
            this._changed();
        };
        pc.onconnectionstatechange = () => {
            clearTimeout(peer.stateTimer);
            if (pc.connectionState === 'failed') this.#restart(peer);
            else if (pc.connectionState === 'disconnected') peer.stateTimer = setTimeout(() => this.#restart(peer), DISCONNECTED_MS);
            this._changed();
        };
        return peer;
    }

    //Tears the connection down and, if the other person is still in the call, builds it again
    #restart(peer) {
        if (this.#peers.get(peer.clientId) !== peer) return;
        this.#closePeer(peer.clientId);
        this._changed();
        setTimeout(() => { if (this.#joined && !this.#destroyed) this.#reconcile(); }, RETRY_MS);
    }

    #startPeer(clientId, user) {
        const gen = newGeneration();
        const peer = this.#newPeer(clientId, user, true, gen);
        const { pc } = peer;
        for (const kind of ['audio', 'video']) {
            const transceiver = pc.addTransceiver(kind, { direction: 'sendrecv' });
            peer.senders[kind] = transceiver.sender;
            if (this.#tracks[kind]) transceiver.sender.replaceTrack(this.#tracks[kind]).catch(() => {});
        }
        pc.onnegotiationneeded = () => this.#enqueue(peer, async () => {
            await pc.setLocalDescription(await pc.createOffer());
            this.#send(clientId, { kind: 'offer', gen, sdp: pc.localDescription.sdp });
        });
    }

    #closePeer(clientId) {
        const peer = this.#peers.get(clientId);
        if (!peer) return;
        this.#peers.delete(clientId);
        clearTimeout(peer.graceTimer);
        clearTimeout(peer.stateTimer);
        peer.pc.onicecandidate = peer.pc.ontrack = peer.pc.onconnectionstatechange = peer.pc.onnegotiationneeded = null;
        peer.pc.close();
    }

    //Signals of one peer are handled strictly in order (an answer must be applied before the candidates that follow it)
    #enqueue(peer, task) {
        peer.queue = peer.queue.then(task).catch(error => {
            console.warn('[conference] negotiation step failed:', error?.message ?? error);
            if (this.#peers.get(peer.clientId) === peer) this.#restart(peer);
        });
    }

    #onSignal(event) {
        if (event.type === 'error') { console.warn('[conference] signalling:', event.code, event.message); return; }
        if (event.type !== 'signal' || !this.#joined) return;
        const { from, user, data } = event;
        if (!data || typeof data !== 'object') return;
        let peer = this.#peers.get(from);

        if (data.kind === 'offer') {
            if (peer && peer.gen !== data.gen) { this.#closePeer(from); peer = null; }          // the other side started over
            if (!peer) peer = this.#newPeer(from, user, false, data.gen);
            const { pc } = peer;
            this.#enqueue(peer, async () => {
                await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
                for (const transceiver of pc.getTransceivers()) {
                    transceiver.direction = 'sendrecv';
                    const kind = transceiver.receiver.track.kind;
                    peer.senders[kind] = transceiver.sender;
                    if (this.#tracks[kind]) await transceiver.sender.replaceTrack(this.#tracks[kind]);
                }
                await pc.setLocalDescription(await pc.createAnswer());
                this.#send(from, { kind: 'answer', gen: data.gen, sdp: pc.localDescription.sdp });
            });
        } else if (peer && data.gen === peer.gen) {
            if (data.kind === 'answer') this.#enqueue(peer, () => peer.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp }));
            else if (data.kind === 'candidate') this.#enqueue(peer, () => peer.pc.addIceCandidate(data.candidate).catch(() => {}));       // a late candidate for a closed connection is harmless
        }
    }
}
