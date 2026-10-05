# Changelog

Follows [Semantic Versioning](https://semver.org/). Below 1.0.0, minor versions may change behavior.

## Unreleased (M0 — foundation)

### Added
- `vendor/ultima`: UltimaJS core 0.3.0, which adds `mix(Base).with(...mixins)` (D-02).
- Manifest and config validation; `ComponentRegistry` (lazy loading, search, port-type lookup).
- `AgoraComponent`: instance contract (`attach`, `config`, capability-guarded services, `emit`, queued inputs, actions, `onDispose`).
- `MemoryStateStore`: path-addressed document with change listeners, undo/redo transactions, snapshot/restore.
- Browser test suite (`tests/`) and CI workflow.
