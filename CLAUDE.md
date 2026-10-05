# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Ultima Agora is a collaborative, composable workspace environment built on UltimaJS: users compose
persistent workspaces out of components with typed ports, and work in them together. The full
specification (Portuguese) is in `docs/especificacao/` — read `00-indice.md` first. Requirement IDs
(`R-…`) and decisions (`D-…`, see `12-decisoes-em-aberto.md`) are cited in code comments and commits.

Like UltimaJS: vanilla JavaScript, native ES modules, **no build step, no npm dependencies**.

**Code, comments and identifiers are in English. Documentation (`docs/`) is in Portuguese.**

## Commands

- Serve the repo root with any static server (`python3 -m http.server`) and open `/tests/`.
- `tests/run.sh` runs the suite in headless Chrome and exits non-zero on failure (this is what CI runs).
- Add a test with every bug fix. User-visible changes go in `CHANGELOG.md`.

## Layout

- `vendor/ultima/` — copy of the UltimaJS core. **Do not edit here**: change `../ultima` and re-copy (see `vendor/ultima/README.md`).
- `core/components/` — `mix.js` (re-export of UltimaJS `mix()`, D-02) and `agora_component.js`.
- `core/registry/` — manifest validation and `ComponentRegistry`.
- `collaboration/document/` — `MemoryStateStore`; the Yjs store will implement the same surface (R-STORE-*).
- `core/workspace/` — `layout.js` (docking tree in the document) and `workspace.js` (the only way to mutate the composition).
- `collaboration/providers/` — IndexedDB persistence. `adapters/dev/` — `DevHost`, the serverless host.
- `components/` — generic catalog (`ultima-text`, `ultima-notes`, markdown renderer). `ui/` — shell, palette, workspace view, inspector.
- Run the app: serve the root and open `/` (hash route `#/workspace/<id>`).
- `tests/` — zero-dependency browser tests, same runner shape as UltimaJS.

Planned (see spec 55): `core/{events,connections,permissions}`, `collaboration/presence`, `conference/`.

## Rules that matter

- **Domain stays out of the core**: no `Entity`, `Claim`, `Evidence`… outside the application's own pack.
- **Yjs, LiveKit, Django, PostgreSQL appear only behind adapters/providers.** Components never import them.
- **The workspace document holds references, not copies, of domain data** (R-DOC-3).
- Third-party libraries are copied into `vendor/` as prebuilt ESM with version and hash (D-06); the runtime stays build-free.
- Keep `component.html` / `component.js` / `component.css` separate, as in UltimaJS.
