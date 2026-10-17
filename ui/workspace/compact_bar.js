//The small-screen way to move between windows: a bar at the bottom and a sheet with the whole list (docs 07, R-LAY-13).
//Pure builders: the view owns the state and passes it in.
import { h } from '../dom.js';

export const BAR_SLOTS = 4;

//The windows the bar shows: the first ones, always including the active one (it takes the last slot if it would not fit)
export function barItems(records, active, slots = BAR_SLOTS) {
    if (records.length <= slots) return records;
    const shown = records.slice(0, slots);
    if (shown.some(r => r.id === active)) return shown;
    return [...shown.slice(0, slots - 1), records.find(r => r.id === active) ?? records[slots - 1]];
}

//records: [{ id, label }]; activity: ids with news since they were last looked at
export function buildCompactBar({ records, active, activity, onSelect, onMore }) {
    const tabs = barItems(records, active).map(record => h('button', {
        type: 'button', role: 'tab', class: 'compact-tab', 'data-id': record.id,
        'aria-selected': String(record.id === active), tabindex: record.id === active ? 0 : -1,
        onClick: () => onSelect(record.id),
        onKeydown: event => {
            const shown = barItems(records, active);
            const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
            if (!step) return;
            event.preventDefault();
            onSelect(shown[(shown.findIndex(r => r.id === record.id) + step + shown.length) % shown.length].id, true);
        },
    }, h('span', { class: 'compact-label' }, record.label),
        activity.has(record.id) ? h('span', { class: 'activity', role: 'img', 'aria-label': 'com novidade' }) : null));
    return h('nav', { class: 'compact-bar', 'aria-label': 'Janelas' },
        h('div', { class: 'compact-tabs', role: 'tablist' }, tabs),
        h('button', { type: 'button', class: 'compact-more', 'aria-haspopup': 'dialog', 'aria-label': `Todas as janelas (${records.length})`, onClick: () => onMore() }, '☰'));
}

//records: all windows. canEdit: may rename/close/add. renaming: id being renamed, or null.
export function buildSheet({ records, active, activity, canEdit, renaming, onSelect, onClose, onRename, onStartRename, onRemove, onAdd }) {
    const row = record => {
        if (renaming === record.id) {
            const input = h('input', { type: 'text', value: record.label, 'aria-label': `Novo nome para ${record.label}`, class: 'rename',
                onKeydown: event => { if (event.key === 'Enter') onRename(record.id, input.value.trim() || record.label); else if (event.key === 'Escape') onStartRename(null); } });
            queueMicrotask(() => { input.focus(); input.select(); });
            return h('li', {}, input, h('button', { type: 'button', onClick: () => onRename(record.id, input.value.trim() || record.label) }, 'OK'));
        }
        return h('li', { class: record.id === active ? 'current' : '' },
            h('button', { type: 'button', class: 'pick', 'aria-current': record.id === active ? 'true' : null, onClick: () => onSelect(record.id) },
                record.label, activity.has(record.id) ? h('span', { class: 'activity', role: 'img', 'aria-label': 'com novidade' }) : null),
            canEdit && !record.personal ? [
                h('button', { type: 'button', 'aria-label': `Renomear ${record.label}`, onClick: () => onStartRename(record.id) }, '✎'),
                h('button', { type: 'button', 'aria-label': `Fechar ${record.label}`, onClick: () => onRemove(record.id) }, '×'),
            ] : null);
    };
    return h('div', { class: 'sheet-layer' },
        h('div', { class: 'sheet-backdrop', onClick: () => onClose() }),
        h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Janelas', onKeydown: event => { if (event.key === 'Escape') onClose(); } },
            h('header', {}, h('strong', {}, 'Janelas'), h('button', { type: 'button', 'aria-label': 'Fechar lista', onClick: () => onClose() }, '×')),
            h('ul', {}, records.map(row)),
            canEdit ? h('button', { type: 'button', class: 'add', onClick: () => onAdd() }, '＋ Adicionar componente') : null));
}
