# Changelog

Follows [Semantic Versioning](https://semver.org/). Below 1.0.0, minor versions may change behavior.

## Unreleased (M2 — typed bus, connections, actions)

### Added
- `TypeRegistry` (subtypes, arrays, structural validation, converters) and core types `Table`, `Row`, `Graph`, `Node`, `Text`, `Ref`…; the registry refuses ports whose type is not registered.
- `Bus`: typed ports, connections in the document (cycles, incompatible types and double-fed inputs refused with a reason), retained values, conversion on the way, ordered `multiple` inputs, no repeated deliveries.
- Actions with effect `emit`/`create`: results are published, visualizations are suggested, and `createLinked` makes the component, places it beside the source and connects it in one undo step.
- Components `ultima-table` (CSV, sorting, row selection, "mostrar como grafo") and `ultima-graph` (deterministic layout, keyboard selectable); `ultima-text` gained a `text` input.
- Inspector sections for connections (compatible sources, noting conversions) and actions.
- `docs/contrato-agoracomponent.md`: the contract, frozen as version 1 (D-04).

### Fixed
- SVG `hidden` was set as a property, which SVG elements ignore; the graph was in the DOM but invisible.
- Output values were lost on reload when only an action had produced them; components now re-emit what they derive.

## Unreleased (M1 — local workspace)

### Added
- Docking layout (`core/workspace/layout.js`): binary tree of tab panels and splits, in the document; place/move/remove/reorder/resize, each one undo step.
- `Workspace` controller: add/remove/move/configure instances with manifest validation, per-field config, read-only for newer schemas, `sharedText()` (SharedText interface).
- IndexedDB persistence (`PersistentStateStore`, debounced) and `DevHost` (create, rename, duplicate, archive, list) — works with no server.
- Shell: `agora-shell`, `agora-palette`, `agora-workspace` (tabs, splits, drag and drop, keyboard alternatives), `agora-inspector` (generated from the manifest), light/dark theme via `--agora-*`.
- Components `ultima-text` and `ultima-notes` (Markdown, safe renderer), `registerFromUrl()` in the registry, `onHistory`/`onStatus` on documents.
- `index.html`: the running dev application.

### Changed
- `AgoraComponent.dispose()` replaces the `disconnectedCallback` hook: moving an element between panels is not a removal.
- `tests/run.sh` polls the page title instead of using `--virtual-time-budget` (virtual time does not wait for IndexedDB).

## Unreleased (M0 — foundation)

### Added
- `vendor/ultima`: UltimaJS core 0.3.0, which adds `mix(Base).with(...mixins)` (D-02).
- Manifest and config validation; `ComponentRegistry` (lazy loading, search, port-type lookup).
- `AgoraComponent`: instance contract (`attach`, `config`, capability-guarded services, `emit`, queued inputs, actions, `onDispose`).
- `MemoryStateStore`: path-addressed document with change listeners, undo/redo transactions, snapshot/restore.
- Browser test suite (`tests/`) and CI workflow.
