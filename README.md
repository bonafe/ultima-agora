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
- M5 pronto: chat (servidor, cliente offline, painel), suíte de aceite com várias pessoas contra o servidor real, contrato de todos os componentes e verificação de acoplamento. **Rastreabilidade dos 23 critérios: `docs/aceite-mvp.md`** (14 cobertos, 9 parciais com a lacuna escrita).
- **Docker (app + servidor de tempo real):** `docker compose up -d --build` sobe o app em `http://localhost:8080/` e `https://<host>:8443/`
  (nginx, com o `agora-sync` atrás de `/sync/`, na mesma origem) e o `agora-sync` em `:8787` (dados no volume `agora-data`;
  `docker compose down` para). Para outras máquinas, informe o IP que elas usam, pois ele entra no certificado:
  `AGORA_HOSTS=192.168.2.155 docker compose up -d --build`, e passe `https://192.168.2.155:8443/?sync=https://192.168.2.155:8443/sync&name=Maria`
  mais o `#/workspace/<id>` a quem for entrar. O certificado é autoassinado (o navegador pede uma confirmação, uma vez por máquina).
  O compose liga `AGORA_DEV_AUTH=1` (qualquer um que alcance o servidor obtém token e escolhe o próprio papel): só em rede
  confiável. Produção: `server/agora-sync/README.md`.
- **Chamada de áudio e vídeo** (botão 📹 no cabeçalho, ou o componente `ultima-conference`): WebRTC em malha entre os navegadores, com a
  sinalização pelo `agora-sync` (D-36). Câmera e microfone **só ligam quando você marca**; sair ou desligar encerra a captura. Exigem
  `localhost` ou HTTPS (por isso o `https://` acima). Pensada para grupos pequenos (até ~4–6 pessoas); entre redes diferentes pode
  precisar de um TURN (`AGORA_ICE_SERVERS`). Tela compartilhada: próxima etapa.
- Próximo: fase 2 (conexões visuais, conferência com LiveKit, quadro, templates, histórico, agentes em modo proposta); e a cifra do armazenamento local (D-17).

## Testes

Sem build nem dependências. Sirva a raiz (`python3 -m http.server`) e abra `/tests/`, ou rode `tests/run.sh` (Chrome headless).
