# Changelog

Follows [Semantic Versioning](https://semver.org/). Below 1.0.0, minor versions may change behavior.

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
