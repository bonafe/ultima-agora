//One person's picture in the call (video or avatar, name, state, live caption). Shared by `ultima-conference`
//(a grid of tiles) and `ultima-call-person` (one tile as a window of its own). The video element is kept
//between repaints so that it never flickers.
import { h } from '../../ui/dom.js';

export function createTile(person) {
    const video = h('video', { autoplay: true, playsinline: true, muted: person.self, 'aria-hidden': 'true' });
    video.muted = person.self;                   // never play my own voice back to me
    const avatar = h('div', { class: 'avatar' });
    const name = h('span', { class: 'name' });
    const off = h('span', { class: 'off' });
    const caption = h('div', { class: 'caption', 'aria-hidden': 'true' });
    const element = h('div', { class: 'tile', role: 'listitem' }, video, avatar, caption, h('div', { class: 'label' }, name, off));
    return { element, video, avatar, name, off, caption };
}

export function paintTile(tile, person, transcript) {
    const hasVideo = !!person.stream && person.cam;
    if (tile.video.srcObject !== person.stream) tile.video.srcObject = person.stream;
    if (person.stream) tile.video.play?.().catch(() => {});
    tile.element.classList.toggle('self', person.self);
    tile.element.classList.toggle('has-video', hasVideo);
    tile.element.classList.toggle('speaking', person.speaking && person.mic);
    tile.element.classList.toggle('connecting', !person.self && !person.stream);
    tile.avatar.style.background = person.user.color ?? '#667';
    tile.avatar.textContent = [...(person.user.name ?? '?').replace(/^Participante\s*/, '')][0]?.toUpperCase() ?? '?';
    tile.name.textContent = person.self ? `${person.user.name} (você)` : person.user.name;
    tile.off.textContent = [person.mic ? '' : '🔇', person.cam ? '' : '🚫', person.transcribing ? '📝' : '', person.recording ? '🔴' : ''].filter(Boolean).join(' ');
    tile.caption.textContent = transcript?.captionOf(person.user.id) ?? '';
    tile.element.setAttribute('aria-label', `${person.user.name}${person.self ? ' (você)' : ''}: microfone ${person.mic ? 'ligado' : 'desligado'}, câmera ${person.cam ? 'ligada' : 'desligada'}${person.speaking && person.mic ? ', falando' : ''}${person.transcribing ? ', sendo transcrito' : ''}${person.recording ? ', gravando' : ''}`);
}
