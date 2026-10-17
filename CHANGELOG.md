# Changelog

Follows [Semantic Versioning](https://semver.org/). Below 1.0.0, minor versions may change behavior.

## Unreleased (phone UX)

### Added
- **Picture-in-Picture** (Chrome/Edge, Document PiP API): "Fixar por cima de tudo (PiP)" no menu da janela move o componente vivo para uma janelinha sempre por cima (uma por vez; precisa de clique). Durante uma chamada, sair da aba abre a chamada em PiP sozinha (Media Session `enterpictureinpicture`, como o Google Meet) e voltar à aba restaura. Navegadores sem a API não veem o item.
- Janelas flutuantes redimensionam pelos 4 cantos e pelas 4 laterais (antes só o canto inferior direito); o lado oposto fica parado. Uma janela flutuante nova nasce inteira dentro do workspace (antes a borda de baixo podia ficar fora da tela, sem como pegar).
- **Components answer to the width of their own box** (R-ADAPT-1..3): the host of every `AgoraComponent` is a container (`container-type: inline-size`) and exposes `data-box` (`compact` < 420 px, `regular`, `wide` ≥ 720 px; `core/components/box.js`). Each catalog component has `@container` rules and `@media (pointer: coarse)` touch targets (44 px, 16 px inputs).
- **Compact presentation of the workspace** (R-LAY-13..15): below 720 px of its own width the workspace shows ONE window at a time (the layout flattened in reading order, `flattenTree`) with a bottom bar and a sheet listing every window (rename, close, add). The same live elements are moved, never recreated, and all stay mounted. A hidden window that receives a value from a connection gets a dot (`Bus.onDelivery`). The document is untouched.
- **Shell on a small box** (R-LAY-16): essentials in the header and the rest behind "⋯"; palette, inspector and chat as bottom sheets, one at a time, with a scrim; the call is full screen or a mini-bar above the window bar (mic, camera, leave), so the audio goes on while switching windows. `100dvh`, `viewport-fit=cover`, safe-area insets.
- `AgoraWorkspaceView.compactAt` (0 = never; the call's people-windows always show together), `compactAccessory`, `showWindow`.

## Unreleased (call window)

### Fixed
- With a real mouse the browser started its own text drag on a tab press, cancelling the window drag (`pointercancel`) and selecting text. Native `dragstart`/`selectstart` are now blocked while a tab is pressed. (The synthetic-event tests could not see it; checked by hand in Chrome.)

### Changed
- **The call is a window like the others** (R-CONF-2, R-LAY-12): drag its tab to dock it beside any panel (as a tab or a split of the whole workspace edge), float it, or show it in another browser window (multi-monitor); the 📹 button or "–" hides it without ending the call (it is parked, so audio goes on). It is your own view: nothing in the shared document, nobody else sees how you arranged it. Replaces the fixed tray.
- **Windows inside the call**: each person is a window (`ultima-call-person`) in a small workspace of its own, with the same docking, tabs, floating and pop-out. Whoever joins gets a window, whoever leaves loses it. "Abrir transcrição" opens the transcript as a window of the call.
- `ultima-conference` 1.1.0: `tiles` config (`false` = only the controls); the tile drawing moved to `components/conference/tile.js`.
- `AgoraWorkspaceView`: personal windows (`showPersonal` / `hidePersonal`), `release()`; drags inside a pop-out use that window's own size and `Esc`.

## Unreleased (windows: better docking, floating, other browser windows)

### Added
- **Dragging windows** is now by pointer: a ghost follows the pointer and one highlight shows exactly what the drop does — a tab at a position (drop on the tab bar, also reorders), split a panel, or split the **whole workspace** (outer edge). The empty part of a tab bar drags too. `Esc` cancels.
- **Floating windows** (R-LAY-8): double-click a tab, or `⋯` → "Destacar em janela flutuante". Move by the title bar (arrow keys too), resize by the edge, bring back with ⇲ / Enter.
- **Other browser windows** (R-LAY-8, D-39): `⋯` → "Destacar em outra janela do navegador", or drag a tab out of the browser window and drop it on the other monitor. The live component is moved into the new window (not reloaded), so its connections keep working. Pop-up blocked → falls back to floating and says so.
- `Layout.place/move` accept `index` (tab position) and `root` (split the whole tree). View state only: detaching changes nothing for collaborators.

### Changed
- The per-panel drop hints and the HTML5 tab drag were replaced by `ui/workspace/drop_targets.js` (shared by palette drops and window drags). The `⋯` menu is available to read-only users for the detach items.

## Unreleased (welcome workspace)

### Added
- **Welcome workspace** (D-38): the first visit opens a real, working composition that teaches by being used — a guide to read, a notebook to write in, a table ("who does what") and a graph connected to it, so editing the table redraws the graph. The **Boas-vindas** button brings a fresh one at any time; `?template=boas-vindas` does the same from a link.
- `core/workspace/templates.js`: a template is data applied through the `Workspace` controller, validated first (nothing half-applied), one undo step, synchronized like manual work. The content lives with the application (`ui/welcome/`), not in the core. `DevHost.create(title, { seed })` / `clearSeed`: the shell fills a seeded workspace once, before showing it.
- `ultima-notes` 1.2.0: `startInView` config (open for reading).

### Fixed
- The chat drawer and the call tray were always visible: their `display` rules (by id) beat `aside[hidden]`. Test: both are really hidden until opened.

## Unreleased (site — Ágora Digital)

### Added
- **Landing page** (`index.html`, `site/`): the story of the Ágora in six acts over a canvas background that is a function of the scroll (dusk square with columns → people meet → voices ripple → machines join as a graph → floating panels → dawn). The visitor's pointer is a person too. Honours `prefers-reduced-motion` (still picture, changes only with the scroll), works at phone width and offline.
- `hospedar.html`: hosting guide for people who will not program (Docker in plain words, sharing the link, the self-signed certificate, the Whisper model, cautions).
- Static only, so it can be published on GitHub Pages; tags "já existe" / "a caminho" keep the page from promising what is not built.

### Changed
- The workspace application moved from `/` to **`/app.html`** (relative module paths unchanged): links with `?sync=` now start with `app.html`. `/` is the landing page. The precache lists both pages and `site/`.
- Test: the links of both pages are served and the art draws at every point of the story.

## Unreleased (transcription — Whisper in the browser)

### Added
- **Automatic transcription of each person in the call** (D-37, spec 6.2.1): Whisper (transformers.js + ONNX Runtime Web, CPU/WASM) runs in a worker IN the browser, vendored in `vendor/whisper/` (`tools/vendor-whisper`), with the model served from our own origin (`models/`, outside git; `tools/baixar_modelo_whisper.py`). Each person is transcribed on their own device, the audio never leaves it, only the text goes to the workspace; no third parties, works offline.
- `transcription/`: `WhisperProvider` (worker, audio worklet, 16 kHz resampling, voice-activity cutting into utterances, discard of what Whisper invents on silence), `Transcriber` (the person's switch: never starts by itself, follows the microphone, ends when leaving the call). Everyone sees who is being transcribed (presence); live caption on the tile.
- `ultima-transcript` component (per-person list, search, copy, download `.txt`) and `ultima-conference` controls (switch, language: pt/en/es/auto, status, "Abrir transcrição").
- `agora-sync`: transcript log (message type 6) separate from the chat and outside the document: author from the token, idempotent by `clientId`, history for late joiners, rate limit, persistence, `TRANSCRIPT_RETENTION_DAYS`. `TranscriptClient` with an outbox for offline.
- Docker: cross-origin isolation headers (COOP/COEP) for multi-threaded Whisper (~2× faster). Precache now also lists `conference/` and `transcription/` (they were missing).
- Tests: audio logic (resampling, voice detection, filters), transcript client, switch, the conference component, Whisper end to end with a recorded voice (skipped when the model is not installed), 4 server tests and E25 in the acceptance suite.

## Unreleased (conference — camera and microphone)

### Added
- **Call with audio and video** (`ultima-conference`, capability `conference`; 📹 button and floating tray in the shell): `ConferenceProvider`/`ConferenceRoom` contract (`conference/`) and `MeshProvider` — browser-native WebRTC in a full mesh (D-36; spec 06 updated). Who is in the call and who is speaking come from presence (R-CONF-3); the media goes straight between browsers.
- Mic and camera never turn on by themselves: the person ticks them before joining; turning them off (or leaving) stops the capture so the device light goes out. A viewer can watch and listen but the interface does not offer publishing (the server cannot stop a P2P viewer: documented limit). A refused device does not keep the person out of the call; errors are explained in Portuguese. A peer that disappears from presence for a moment (server hiccup) keeps its connection for 5 s.
- `agora-sync`: signalling relay (message type 5) between two people of the SAME workspace, with the sender taken from the connection (cannot forge another client id), size and rate limits; `AGORA_ICE_SERVERS` (JSON) announces STUN/TURN to the clients. `SyncProvider.sendSignal` / `onSignal`.
- Tests: 6 mesh tests with real `RTCPeerConnection`s and synthetic media (no permission or hardware needed), 4 server tests, and E24 in the acceptance suite (real server, fake devices, video frames checked in both directions).

## Unreleased (docker)

### Added
- `docker-compose.yml`: app (nginx, 8080 and **HTTPS 8443** with a self-signed certificate covering `AGORA_HOSTS`, because camera and microphone need a secure context) + `agora-sync` (8787, volume `agora-data`), with the realtime server also reachable at `/sync/` on the same origin. Uses `AGORA_DEV_AUTH=1`: trusted networks only.

## Unreleased (M5 — chat and MVP acceptance)

### Added
- **Chat** (`ultima-chat`, capability `chat`): a per-workspace log on `agora-sync` OUTSIDE the document (author taken from the token, idempotent by `clientId`, roles — a viewer reads, 20 sends per 10 s, 4000 chars, optional retention `CHAT_RETENTION_DAYS`, deleting redacts the text from disk). `ChatClient` keeps the history and the unsent messages on the device (reads and queues offline), counts unread and mentions; the shell has a 💬 drawer with the same component, a count (a different colour for mentions) and the unread number in the tab title.
- `SyncProvider.sendChat` / `onChat` (message type 4); IndexedDB v3 with a `local` store for authored-here data (never touched by the data-cache policy).
- **Acceptance suite** (`tests/run_acceptance.sh`): several full clients against the real `agora-sync`; a contract test over every catalog component; `tools/verificar_acoplamento.py` with its own test; `docs/aceite-mvp.md` maps the 23 criteria.
- `DevHost({ identity })` for several people in one page.

### Fixed (found by the real-server runs)
- The `agora-sync` container could not write to `/data`: it now starts as root only to fix ownership, then drops to `node`.
- A storage failure in the chat closed the connection; it now answers the sender with a clear error and the message is not half-created.
- The service worker revalidates (`cache: 'no-cache'`), so an updated app is not masked by the browser's HTTP cache.

## Unreleased (settings)

### Added
- ⚙ **Configurações** in the shell (`ui/settings/agora-settings.js`), built from `host.settings`: account and **Sair** (with "also clear this device"), **Dados neste dispositivo** (cache level, summary, **Limpar este dispositivo** in two steps that names what is still unsent), and app settings (theme, network). Sections the host does not offer are not shown.
- `IndexedDbBackend.destroy()`, `YjsStateStore.closeAll()`, `DevHost.settings`.

## Unreleased (offline-first)

### Added
- `sw.js`: the app shell opens without a network (network first with a 4 s limit, cache as the reserve). The file list is `precache.json`, GENERATED by `tools/gerar_precache.py` (version = content hash; `--check` runs in `tests/run.sh`).
- `core/offline/register_sw.js`: registers the worker with the cache version in the URL (a new version is a new worker) and keeps the installed one when offline.
- IndexedDB v2: a `cache` store for host-side copies of data (`getCache/putCache/deleteCache/cacheEntries`); old databases upgrade.
- The sync provider reconnects as soon as the browser reports `online`.

### Found by trying it
- Reloading `/` offline found nothing: the page is requested as `/`, not `/index.html`. The list now includes the root.
- The worker never updated: browsers only update it when `sw.js` itself changes, not `precache.json`. Hence the versioned registration.

## Unreleased (M4 — integration with Inteligência Aberta)

### Added
- Capability `domain-data` is real: the host injects a client (`host.domain`, scoped with `forWorkspace(id)`) and the view hands it to components as `this.domain`; `Workspace` takes `domain` and `id`.
- `agora-sync`: `POST /admin/role` (Bearer admin token) so the host can change a role for open connections; absent without a token.
- The integration itself lives in the Inteligência Aberta repository (Django app `agora`, `DjangoHost`, `ia-*` pack): see its ADR 013/014.

### Changed
- **Every instance is mounted**, inactive tabs only hidden. Outputs are derived from the live component, so a source on a background tab never fed what was connected to it (found with a second user in the portal).

## Unreleased (M3 — collaboration)

### Added
- `vendor/yjs` (Yjs 13.6.27, y-protocols, lib0) as a prebuilt ESM bundle with recorded hash; `tools/vendor-yjs` regenerates it (the app itself stays build-free).
- `YjsWorkspaceDoc`: the document API on Yjs — nested maps merge field by field, shared text is a `Y.Text` edited by minimal diffs, undo is per user, roles are enforced locally the way the server enforces them. `MemoryWorkspaceDoc` gained the same `text()`.
- `SyncProvider` (Yjs sync + awareness over any transport; reconnect with backoff, offline edits merge) and `YjsStateStore` (IndexedDB, optional sync, imports M1/M2 data).
- Presence (`LocalPresence`, `YjsPresence`): participants in the toolbar, who is looking at which tab, "is editing" marker.
- Roles in `Workspace` (owner/editor/participant/viewer), live role changes, read-only UI; notes follow the role and keep the caret during remote edits.
- `server/agora-sync`: Node sync server with HS256 tokens, role enforcement, persistence, limits; 11 integration tests; Dockerfile; CI job.
- `DevHost` on top of the Yjs store with optional sync (`?sync=…&name=…&role=…`); opening a shared link adopts the workspace.
- Banner offering to discard local changes the server refused.

### Fixed
- A viewer was disconnected on connect: the server treated the empty handshake update as a write.
- Opening an empty (unsynced) workspace wrote `schemaVersion`/title and overwrote the real ones, or got viewers refused.
- `server.close()` hung when called twice or when the data directory had vanished.

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
