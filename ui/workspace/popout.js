//Shows a live component in ANOTHER browser window (multi-monitor).
//
//The component is not copied or reloaded: its element is moved into the new window's document. The code keeps
//running in the main window, so the document, the ports and the bus stay bound exactly as before; only the pixels
//are drawn elsewhere. The cost: the main window must stay open (closing it ends the pop-outs, which dock back
//when the page reloads) and a component that listens on the global `document` hears only the main window.
import { h } from '../dom.js';

const THEME_VARS = ['--agora-bg', '--agora-surface', '--agora-border', '--agora-text', '--agora-accent', '--agora-danger'];

//Returns { window, body, close() } or null when the browser refused the window (pop-up blocker).
//themeSource: element whose computed theme variables the new window copies. onClosed: the person closed/reloaded it.
export function openPopout({ title, rect, themeSource, onDock, onClosed, onHide = null, dockLabel = 'Reacoplar ao workspace', open = (...args) => window.open(...args) }) {
    const features = ['popup=yes', `width=${Math.round(rect.w)}`, `height=${Math.round(rect.h)}`, `left=${Math.round(rect.x)}`, `top=${Math.round(rect.y)}`].join(',');
    const win = open('', '', features);
    if (!win) return null;

    const doc = win.document;
    doc.open();
    doc.write(`<!doctype html><html lang="${document.documentElement.lang || 'pt-BR'}"><head><meta charset="utf-8"><base href="${document.baseURI}"></head><body></body></html>`);
    doc.close();
    doc.title = title;

    const computed = getComputedStyle(themeSource);
    const style = doc.createElement('style');
    style.textContent = `
        html, body { height: 100%; margin: 0; }
        body { display: flex; flex-direction: column; background: var(--agora-surface); color: var(--agora-text); font: 14px/1.4 system-ui, sans-serif; }
        .popout-bar { display: flex; align-items: center; gap: .5rem; padding: .25rem .6rem; background: var(--agora-bg); border-bottom: 1px solid var(--agora-border); }
        .popout-bar strong { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .popout-bar button { font: inherit; padding: .15rem .6rem; border: 1px solid var(--agora-border); border-radius: .3rem; background: var(--agora-surface); color: inherit; cursor: pointer; }
        .popout-bar button:focus-visible { outline: 2px solid var(--agora-accent); outline-offset: 1px; }
        .popout-body { flex: 1; min-height: 0; overflow: auto; position: relative; }
        .popout-body > * { box-sizing: border-box; min-height: 100%; }`;
    doc.head.append(style);
    for (const name of THEME_VARS) doc.documentElement.style.setProperty(name, computed.getPropertyValue(name));

    const heading = h('strong', {}, title);
    const body = h('div', { class: 'popout-body' });
    doc.body.append(h('div', { class: 'popout-bar' }, heading, h('button', { type: 'button', onClick: () => onDock() }, dockLabel), onHide ? h('button', { type: 'button', onClick: () => onHide() }, 'Esconder') : null), body);

    let closed = false;
    const finish = () => { if (closed) return; closed = true; clearInterval(poll); removeEventListener('pagehide', closeWithMain); onClosed(); };
    const closeWithMain = () => { try { win.close(); } catch { /* already gone */ } };
    win.addEventListener('pagehide', finish);
    const poll = setInterval(() => { if (win.closed) finish(); }, 500);       //pagehide is not always delivered when the window is closed
    addEventListener('pagehide', closeWithMain);

    return {
        window: win, body,
        setTitle(text) { doc.title = text; heading.textContent = text; },
        focus() { win.focus(); },
        close() { if (closed) return; closed = true; clearInterval(poll); removeEventListener('pagehide', closeWithMain); closeWithMain(); },
    };
}
