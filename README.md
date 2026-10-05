# Ultima Agora

Ambiente colaborativo e componível construído sobre o [UltimaJS](../ultima): usuários montam
**workspaces persistentes** a partir de componentes com portas tipadas e trabalham neles juntos.
A primeira aplicação de referência é o [Inteligência Aberta](../inteligencia-aberta).

- Especificação: [`docs/especificacao/`](docs/especificacao/00-indice.md)
- Estado: **M1 (workspace local)** — shell, paleta, layout com painéis e abas, inspetor, notas e texto, persistência em IndexedDB. Sem backend: `python3 -m http.server 8080` e abra `http://localhost:8080/` (não use a 8000, que é a do portal do Inteligência Aberta; abrir o arquivo direto, por `file://`, não funciona: módulos ES exigem HTTP).
- Próximo: M2 (barramento tipado, conexões, ações).

## Testes

Sem build nem dependências. Sirva a raiz (`python3 -m http.server`) e abra `/tests/`, ou rode `tests/run.sh` (Chrome headless).
