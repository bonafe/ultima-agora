//A floating window: a frame over the workspace that hosts one live component. Where it is and how big is the
//person's own view (R-LAY-5): the shared layout keeps the component in its panel.
import { h } from '../dom.js';

const MIN_W = 240, MIN_H = 160, KEEP = 80;          //px of the frame that must stay reachable inside the layer
const STEP = 24;                                     //keyboard move, px
let topZ = 10;

//layer: the element the frame floats in; rect: { x, y, w, h } relative to it.
export function createFloatFrame({ layer, title, rect, onDock, onPopout, onRaise, onHide = null, dockLabel = 'Reacoplar ao painel' }) {
    const state = { ...rect };
    const titleText = h('span', { class: 'float-title' }, title);
    const bar = h('div', { class: 'float-bar', style: 'padding-right:16px', tabindex: 0, role: 'group', 'aria-label': `Janela flutuante ${title}. Setas movem; Enter: ${dockLabel.toLowerCase()}.` },
        h('span', { class: 'float-grip', 'aria-hidden': 'true' }, '⠿'), titleText,
        h('button', { type: 'button', class: 'float-btn', title: 'Abrir em outra janela do navegador', 'aria-label': 'Abrir em outra janela do navegador', onClick: () => onPopout() }, '⧉'),
        h('button', { type: 'button', class: 'float-btn', title: dockLabel, 'aria-label': dockLabel, onClick: () => onDock() }, '⇲'),
        onHide ? h('button', { type: 'button', class: 'float-btn', title: 'Esconder (continua em segundo plano)', 'aria-label': 'Esconder', onClick: () => onHide() }, '–') : null,
    );
    const body = h('div', { class: 'float-body' });
    //The corners use the directional cursors (nw-resize…), not nwse-resize: some Linux cursor themes lack the diagonal
    //"nwse" name and the browser then keeps the previous cursor, so the corner looked dead.
    //Eight handles: four edge strips and four corner squares. Geometry AND cursor are inline, not in the stylesheet or set
    //by script while the mouse moves: a stale cached stylesheet must not disable them, and the cursor must be right the
    //moment the pointer arrives. Corners are drawn after (above) the strips and touch them, so there is no gap.
    const EDGE = 'position:absolute;touch-action:none;z-index:5;', CORNER = 'position:absolute;touch-action:none;z-index:6;width:22px;height:22px;';
    const HANDLES = {
        n: `${EDGE}left:14px;right:14px;top:-6px;height:12px;cursor:ns-resize`, s: `${EDGE}left:14px;right:14px;bottom:-6px;height:12px;cursor:ns-resize`,
        w: `${EDGE}top:14px;bottom:14px;left:-6px;width:12px;cursor:ew-resize`, e: `${EDGE}top:14px;bottom:14px;right:-6px;width:12px;cursor:ew-resize`,
        nw: `${CORNER}left:-8px;top:-8px;cursor:nw-resize`, se: `${CORNER}right:-8px;bottom:-8px;cursor:se-resize`,
        ne: `${CORNER}right:-8px;top:-8px;cursor:ne-resize`, sw: `${CORNER}left:-8px;bottom:-8px;cursor:sw-resize`,
    };
    const corners = Object.keys(HANDLES).map(side => h('div', { class: `float-handle ${side}`, 'data-corner': side, 'aria-hidden': 'true', style: HANDLES[side] }));
    const element = h('div', { class: 'float', style: 'overflow:visible', role: 'dialog', 'aria-label': title }, bar, body, ...corners);

    const clamp = () => {
        const bounds = layer.getBoundingClientRect();
        state.w = Math.max(MIN_W, Math.min(state.w, bounds.width || state.w));
        state.h = Math.max(MIN_H, Math.min(state.h, bounds.height || state.h));
        state.x = Math.min(Math.max(state.x, KEEP - state.w), Math.max(KEEP - state.w, (bounds.width || state.x + state.w) - KEEP));
        state.y = Math.min(Math.max(state.y, 0), Math.max(0, (bounds.height || state.y + 30) - 30));
    };
    const apply = () => {
        clamp();
        Object.assign(element.style, { left: `${state.x}px`, top: `${state.y}px`, width: `${state.w}px`, height: `${state.h}px` });
    };
    const raise = () => { element.style.zIndex = ++topZ; onRaise?.(); };

    bar.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.target.closest('button')) return;
        event.preventDefault();
        bar.setPointerCapture(event.pointerId);
        element.classList.add('moving');
        const from = { x: event.clientX - state.x, y: event.clientY - state.y };
        const move = e => { state.x = e.clientX - from.x; state.y = e.clientY - from.y; apply(); };
        const up = () => {
            element.classList.remove('moving');
            bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); bar.removeEventListener('pointercancel', up);
        };
        bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', up); bar.addEventListener('pointercancel', up);
    });
    bar.addEventListener('dblclick', event => { if (!event.target.closest('button')) onDock(); });
    bar.addEventListener('keydown', event => {
        const delta = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] }[event.key];
        if (delta) { event.preventDefault(); state.x += delta[0]; state.y += delta[1]; apply(); }
        else if (event.key === 'Enter' && event.target === bar) { event.preventDefault(); onDock(); }
    });
    element.addEventListener('pointerdown', raise, true);

    //Resizing from any edge or corner: the opposite side stays where it is.
    for (const handle of corners) {
        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            const side = handle.dataset.corner;
            const west = side.includes('w'), east = side.includes('e'), north = side.includes('n'), south = side.includes('s');
            event.preventDefault(); event.stopPropagation();
            raise();
            try { handle.setPointerCapture(event.pointerId); } catch { /* not an active pointer (synthetic): the listeners still work */ }
            element.classList.add('moving');
            const start = { ...state, px: event.clientX, py: event.clientY };
            const move = e => {
                const dx = e.clientX - start.px, dy = e.clientY - start.py;
                if (west || east) state.w = Math.max(MIN_W, start.w + (west ? -dx : dx));
                if (north || south) state.h = Math.max(MIN_H, start.h + (north ? -dy : dy));
                if (west) state.x = start.x + start.w - state.w;
                if (north) state.y = start.y + start.h - state.h;
                apply();
            };
            const up = () => {
                element.classList.remove('moving');
                handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
            };
            handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
        });
    }

    //Keep the remembered size in step with the element
    const observer = new ResizeObserver(() => {
        if (!element.isConnected) return;
        state.w = element.offsetWidth; state.h = element.offsetHeight;
    });

    layer.append(element);
    apply();
    raise();
    observer.observe(element);

    return {
        element, body,
        get rect() { return { ...state }; },
        setTitle(text) { titleText.textContent = text; element.setAttribute('aria-label', text); },
        raise, fit: apply,
        destroy() { observer.disconnect(); element.remove(); },
    };
}
