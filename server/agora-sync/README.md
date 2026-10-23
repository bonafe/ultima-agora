# agora-sync

Serviço de tempo real do Ultima Agora (decisão D-05): sincroniza documentos Yjs, presença e aplica papéis.
Implementação de referência em Node; o protocolo é o do `y-websocket` mais mensagens de controle (ver
`collaboration/providers/sync_provider.js`).

## Rodar (desenvolvimento)

```
cd server/agora-sync
npm install
AGORA_DEV_AUTH=1 npm start          # porta 8787, dados em ./data
```

Com `AGORA_DEV_AUTH=1` o servidor emite tokens para qualquer um (`POST /dev/token`) e aceita mudar papéis
(`POST /dev/role`). **Nunca exponha assim.** O app abre com `?sync=http://localhost:8787`
(`&name=Maria`, `&role=viewer`).

## Produção

| Variável | Significado |
|---|---|
| `AGORA_SYNC_SECRET` | segredo HS256 (≥ 32 caracteres) compartilhado com o host que emite os tokens; obrigatório |
| `PORT` / `BIND_ADDR` | padrão `8787` / `127.0.0.1` (a imagem Docker usa `0.0.0.0`) |
| `AGORA_ICE_SERVERS` | (opcional) lista JSON de `RTCIceServer` (STUN/TURN) anunciada aos clientes para a chamada de áudio/vídeo |
| `TRANSCRIPT_RETENTION_DAYS` | dias de guarda do registro de transcrição das chamadas (0 = para sempre) |
| `DATA_DIR` | onde ficam os documentos (um `.bin` por workspace, gravação atômica), as sessões, as gravações (`media/`) e o outbox de eventos |
| `AGORA_WEBHOOK_URL` / `AGORA_WEBHOOK_SECRET` | (opcional) para onde vão os eventos da chamada e das gravações (`call.*`, `recording.*`, `transcript.finalized`): `POST` assinado com HMAC-SHA256, reenviado até o host responder |
| `RECORDING_IDLE_SECONDS` | segundos sem partes até o servidor encerrar uma gravação que ninguém terminou (padrão 120) |
| `MAX_RECORDING_PART_BYTES` | tamanho máximo de uma parte da gravação (padrão 8 MB) |

O host (Django) emite tokens curtos com as claims `sub`, `name`, `workspace`, `role`, `exp`. Sem
`AGORA_DEV_AUTH`, `/dev/*` responde 404.

## O que o servidor garante

- **Autenticação:** token ausente, forjado, expirado ou de outro workspace → conexão fechada (4401).
- **Papéis, no servidor** (`src/permissions.js`): `viewer` não altera nada; `participant` só o conteúdo
  autoral (`content`); `owner`/`editor` tudo. Uma escrita proibida fecha a conexão (4403) e **não** entra no
  documento. A mudança de papel vale para conexões abertas (`setRole`).
- **Chamada (D-36):** repassa a sinalização WebRTC (mensagem tipo 5) entre duas pessoas do mesmo workspace, com o remetente tirado da conexão e limites de tamanho e taxa. Não vê nem transporta mídia, e por isso **não impede** que um `viewer` envie áudio/vídeo.
- **Transcrição da chamada (D-37):** registro por workspace (mensagem tipo 6), separado do chat e fora do documento: autor tirado do token, idempotente por `clientId`, histórico, persistência (`<id>.transcript.jsonl`), limite de taxa. O texto é produzido no dispositivo de cada pessoa; o servidor não recebe áudio.
- **Chamadas (docs 14):** cada cliente avisa que entrou ou saiu (mensagem tipo 7); o servidor guarda a sessão (`<id>.sessions.jsonl`) e carimba nela cada trecho da transcrição, com o horário em que foi falado, a duração e o idioma (validados: o cliente não escolhe a forma).
- **Gravações (docs 14, D-40):** cada pessoa grava só o próprio áudio e o envia em partes durante a chamada (`/v1/workspaces/:id/recordings`). Exige `consent: true`; `viewer` não grava; só quem gravou (ou o dono) mexe nela; o arquivo sai por link assinado e temporário, com `Range`. Uma gravação que ninguém encerrou é fechada com o que chegou. O `FileStore` (`src/files.js`) é o contrato que um host pode substituir (S3, por exemplo).
- **Eventos (D-42):** `src/events.js`. Entrega pelo menos uma vez, com outbox em arquivo e reenvio; o conteúdo nunca vai no evento.
- **Transcrição em arquivo:** `GET /v1/workspaces/:id/transcript?format=jsonl|json|txt|vtt|srt`.
- **Limites:** mensagens acima de `maxMessageBytes` (2 MB) são recusadas.
- **Persistência:** o documento sobrevive a reinício; falha de disco é registrada, não derruba a sessão.

## Limites conhecidos

- Cada escrita de `participant` copia o documento para conferir o que ela toca; aceitável agora, caro em
  documentos grandes (guardar uma cópia sombra por sala).
- Armazenamento em arquivo; PostgreSQL (D-29) fica para a integração com o Inteligência Aberta.
- Sem limite de taxa por conexão nem expiração de sessão por inatividade.
- Autoria por conexão, não por operação (D-18).

## Testes

`npm test` — 11 testes de integração com o `SyncProvider` do navegador rodando no Node contra o servidor real
(convergência, autenticação, viewer que burla a interface, participante, mudança de papel, presença,
persistência, offline, mensagem grande, configuração).
