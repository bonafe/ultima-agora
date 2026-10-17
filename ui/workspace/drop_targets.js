//Where would a dragged window land? One answer for every kind of drag (palette item, tab, window), so the
//highlight always shows exactly what the drop will do (docs 07, 7.3).
//
//  { panelId, side: 'center' }               add as a tab of the panel (body of the panel)
//  { panelId, side: 'center', index }        add as a tab at a position (dropped on the tab bar)
//  { panelId, side: 'left'|'right'|'top'|'bottom' }   split that panel
//  { root: true, side }                      split the whole workspace (dropped on its outer edge)
//
//`rect` is where to draw the highlight, in viewport coordinates.

export const EDGE = 0.25;           //share of a panel that counts as its edge
const ROOT_BAND = 14;               //px of the workspace's own border that count as its edge

const inside = (rect, x, y) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
const box = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });

//The half (or `share`) of `rect` on one side
export function sideRect(rect, side, share = 0.5) {
    switch (side) {
        case 'left': return box(rect.left, rect.top, rect.left + rect.width * share, rect.bottom);
        case 'right': return box(rect.right - rect.width * share, rect.top, rect.right, rect.bottom);
        case 'top': return box(rect.left, rect.top, rect.right, rect.top + rect.height * share);
        case 'bottom': return box(rect.left, rect.bottom - rect.height * share, rect.right, rect.bottom);
        default: return box(rect.left, rect.top, rect.right, rect.bottom);
    }
}

export function zoneOf(rect, x, y) {
    const fx = (x - rect.left) / rect.width, fy = (y - rect.top) / rect.height;
    if (fx < EDGE) return 'left';
    if (fx > 1 - EDGE) return 'right';
    if (fy < EDGE) return 'top';
    if (fy > 1 - EDGE) return 'bottom';
    return 'center';
}

//Position among the tabs the dragged one does not occupy: the number of tabs whose middle is left of the pointer
function tabSlot(tabs, x) {
    const index = tabs.filter(tab => { const r = tab.getBoundingClientRect(); return r.left + r.width / 2 < x; }).length;
    return index;
}

//panels: the rendered .panel elements; area: the workspace's box; layout: for the no-op rules.
//dragged: the instance being moved (null for something new from the palette).
export function dropTargetAt({ area, panels, layout, dragged = null }, x, y) {
    if (!inside(area, x, y)) return null;
    if (!layout.rootId) return { panelId: null, side: 'center', rect: area };           //empty workspace: the whole area

    const sourcePanel = dragged ? layout.findPanelOf(dragged) : null;
    const alone = sourcePanel && layout.panel(sourcePanel).tabs.length === 1;
    const panelCount = panels.length;

    const panel = panels.find(p => inside(p.getBoundingClientRect(), x, y));
    if (!panel) return null;
    const panelId = panel.dataset.panel;
    const rect = panel.getBoundingClientRect();

    const bar = panel.querySelector(':scope > .tabbar');
    if (bar && inside(bar.getBoundingClientRect(), x, y)) {
        const tabs = [...bar.querySelectorAll('.tab')].filter(tab => tab.dataset.id !== dragged);
        const index = tabSlot(tabs, x);
        const barRect = bar.getBoundingClientRect();
        const left = !tabs.length ? barRect.left : index < tabs.length ? tabs[index].getBoundingClientRect().left : tabs.at(-1).getBoundingClientRect().right;
        if (alone && panelId === sourcePanel) return null;
        return { panelId, side: 'center', index, rect: box(left - 2, barRect.top, left + 2, barRect.bottom), bar: barRect };
    }

    //Outer edge of the whole workspace (the tab bars win over it: their ends are where a tab is put first or last)
    const edges = [['left', x - area.left], ['right', area.right - x], ['top', y - area.top], ['bottom', area.bottom - y]]
        .filter(([, distance]) => distance < ROOT_BAND).sort((a, b) => a[1] - b[1]);
    if (edges.length && !(alone && panelCount === 1)) {
        const edge = edges[0][0];
        return { root: true, side: edge, rect: sideRect(area, edge, 0.3) };
    }

    const side = zoneOf(rect, x, y);
    if (alone && panelId === sourcePanel) return null;                                  //nothing would change
    return { panelId, side, rect: side === 'center' ? rect : sideRect(rect, side) };
}

//What to hand to Workspace.addInstance/moveInstance
export const placement = target => target.root
    ? { root: true, side: target.side }
    : { panelId: target.panelId, side: target.side, ...(target.index !== undefined ? { index: target.index } : {}) };
