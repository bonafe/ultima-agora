//A stable audio stream out of the microphone, for recording.
//
//The conference stops the microphone track when I mute (and makes a new one when I unmute), but a recording must go on across
//that: the timeline has to stay in step with the call, with silence where I was muted. So the recorder listens to this stream,
//which has a track of its own that never ends, and the live microphone track is plugged into it whenever there is one.
export function createMicSource({ getTrack, subscribe, AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext }) {
    const context = new AudioContextClass();
    const destination = context.createMediaStreamDestination();
    let node = null, plugged = null;

    const attach = () => {
        const track = getTrack();
        if (track === plugged && (!track || track.readyState === 'live')) return;
        node?.disconnect(); node = null; plugged = track;
        if (track && track.readyState === 'live') {
            node = context.createMediaStreamSource(new MediaStream([track]));
            node.connect(destination);
        }
    };
    attach();
    const unsubscribe = subscribe(attach);
    context.resume?.();                                           //started by a click, so the browser lets it run

    return {
        stream: destination.stream,
        dispose() { unsubscribe(); node?.disconnect(); node = null; context.close?.().catch?.(() => {}); },
    };
}
