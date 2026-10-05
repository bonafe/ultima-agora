# Ultima Agora

Ambiente colaborativo e componível construído sobre o [UltimaJS](../ultima): usuários montam
**workspaces persistentes** a partir de componentes com portas tipadas e trabalham neles juntos.
A primeira aplicação de referência é o [Inteligência Aberta](../inteligencia-aberta).

- Especificação: [`docs/especificacao/`](docs/especificacao/00-indice.md)
- Estado: **M1 (workspace local)** — shell, paleta, layout com painéis e abas, inspetor, notas e texto, persistência em IndexedDB. Sem backend: `python3 -m http.server 8080` e abra `http://localhost:8080/` (não use a 8000, que é a do portal do Inteligência Aberta; abrir o arquivo direto, por `file://`, não funciona: módulos ES exigem HTTP).
- M2 pronto: barramento tipado, conexões, ações que criam componentes, `ultima-table` e `ultima-graph`; contrato do componente congelado em `docs/contrato-agoracomponent.md`.
- M3 pronto: colaboração em tempo real (Yjs), presença, papéis aplicados no servidor. Para testar com várias pessoas:
  `cd server/agora-sync && npm install && AGORA_DEV_AUTH=1 npm start`, depois abra
  `http://localhost:8080/?sync=http://localhost:8787&name=Maria` e, **em outra origem** (`127.0.0.1` ou o IP da máquina,
  que têm IndexedDB próprio), o mesmo link do workspace com `&name=Carlos` (ou `&role=viewer`).
- M4 pronto: o Agora roda dentro do Inteligência Aberta (`/agora/`), com hospedeiro Django, papéis limitados pelo papel na organização, componentes `ia-search` e `ia-entity`, e `agora-sync` no compose. A integração vive no repositório do IA (branch `agora-m4`, ADR 013/014); este repositório continua sem conhecer dado de domínio. Para levar uma versão nova ao IA: `scripts/sincronizar_agora.sh` no IA.
- Próximo: M5 (chat, workspace de referência e fechamento do MVP).

## Testes

Sem build nem dependências. Sirva a raiz (`python3 -m http.server`) e abra `/tests/`, ou rode `tests/run.sh` (Chrome headless).
