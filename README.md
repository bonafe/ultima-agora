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
- Próximo: M4 (integração com o Inteligência Aberta: hospedeiro Django, componentes `ia-*`, classificação).

## Testes

Sem build nem dependências. Sirva a raiz (`python3 -m http.server`) e abra `/tests/`, ou rode `tests/run.sh` (Chrome headless).
