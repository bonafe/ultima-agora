# 14. Mídia, gravação e integração com outros sistemas

Este documento descreve o que uma chamada deixa para trás, onde isso é guardado e como outro sistema (a Inteligência Aberta, por exemplo) o recebe. Complementa [06](06-comunicacao.md) (comunicação) e [09](09-backend-persistencia-permissoes.md) (contratos do host). Decisões: D-40 a D-43.

## 14.1 Princípios

- **R-MID-1.** O documento do workspace guarda **referências**, nunca bytes (R-DOC-4). O áudio e o vídeo vão para um object store; o documento, quando precisar, aponta com `blob:<id>`.
- **R-MID-2.** O núcleo fala com **contratos** (`FileStore`, `EventSink`, `SessionLog`). Quem integra troca a implementação sem mexer em componentes. Nada de S3, Postgres ou webhook fora dos adaptadores.
- **R-MID-3.** **Cada pessoa grava só o próprio lado** da chamada (o que sai do seu microfone). Ninguém grava outra pessoa. Todos veem um aviso enquanto alguém grava (flag `recording` na presença).
- **R-MID-4.** A gravação **só começa com o consentimento explícito** da pessoa, dado no momento de gravar. O servidor também recusa um pedido sem `consent: true`.
- **R-MID-5.** Um evento de saída carrega **ids, tipos, tamanhos e offsets, nunca conteúdo** (R-AUD-1). O conteúdo se busca por referência assinada e temporária.
- **R-MID-6.** O contrato não depende do provedor de mídia: toda gravação diz a sua `source` (`client-track` hoje; `sfu-egress` quando houver um SFU, D-36).

## 14.2 O que existe

| Dado | Onde fica | Quando |
|---|---|---|
| Chamada (`CallSession`) | `<ws>.sessions.jsonl` | começa quando a primeira pessoa entra, termina quando a última sai ou cai |
| Transcrição | `<ws>.transcript.jsonl` | cada trecho sobe na hora, com `startedAt`, `durationMs`, `language` e `sessionId` |
| Gravação de áudio | `FileStore` (`<DATA_DIR>/media/` no padrão) + registro `<ws>.recordings.jsonl` | em pedaços, durante a chamada |
| Eventos de saída | outbox `events.outbox.jsonl` → webhook | at-least-once |

**`CallSession`:** `{ id, workspaceId, startedAt, endedAt, durationMs, participants[{userId, name, joinedAt, leftAt}] }`. O servidor sabe da chamada porque cada cliente avisa que entrou ou saiu (mensagem tipo 7), não por inferência da presença. Uma sessão que estava aberta quando o processo caiu é fechada como `interrupted` na próxima carga.

**`Recording`:** `{ id, sessionId, userId, kind: audio|video|screen, source, mime, startOffsetMs, status: recording|complete, sizeBytes, sha256, durationMs, truncated, consent{at, by} }`. `startOffsetMs` é onde a trilha começa na linha do tempo da chamada: com ele, quem integra alinha as trilhas de várias pessoas.

## 14.3 O fluxo de uma gravação (D-40)

1. A pessoa está na chamada e clica em "Gravar minha fala". A tela explica o que será gravado e quem vai saber; ela confirma.
2. O cliente pede ao servidor (`POST /v1/workspaces/:id/recordings`) e recebe o `Recording`. A presença passa a mostrar 🔴 para todos.
3. A cada ~5 s o `MediaRecorder` fecha um pedaço. Ele entra numa fila local (IndexedDB, só como buffer) e sobe na hora (`PUT .../parts/:n`). Sai da fila quando o servidor confirma.
4. Sem rede: a fila acumula e esvazia, em ordem, na volta. Aba morta: o que subiu está salvo, o resto sobe na próxima abertura do app; o trecho não gravado se perde.
5. Ao parar (ou sair da chamada), `POST .../complete` junta as partes em um arquivo no `FileStore`. Uma gravação que ninguém encerrou (aba morta, rede que não voltou) é fechada pelo servidor depois de `RECORDING_IDLE_SECONDS` sem partes, com o que chegou, marcada `truncated`.
6. O servidor emite `recording.completed`. O arquivo se acessa por um link assinado e temporário, que serve para `<audio src>` e aceita `Range`.

O microfone passa por um `AudioContext` (`recording/mic_source.js`) para que a gravação continue quando a pessoa silencia (a trilha do microfone para e recomeça): onde ela estava mutada, grava-se silêncio e a linha do tempo não desalinha.

## 14.4 Contratos

**`FileStore`** (implementação padrão: `DiskFileStore`; outra, S3-compatível, ou a do host, pode substituí-la):
`beginUpload()`, `putPart(uploadId, n, bytes)` (idempotente), `complete(uploadId, {parts})`, `open(blobId, range)`, `signDownload(blobId, ttl)`, `verifyDownload(...)`, `delete(blobId)`.

**`EventSink`:** `emit(type, workspaceId, data)`. O `EventBus` entrega a cada sink **pelo menos uma vez**: grava no outbox, tenta, repete com espera crescente (1 s, 5 s, 30 s, 2 min, 10 min) e, se o processo cair, reenvia o que estava pendente na próxima partida. `emit` nunca lança erro: um host fora do ar não derruba uma chamada. O sink padrão é `webhook`: `POST` com `x-agora-event-id` (estável entre tentativas, para o receptor ser idempotente), `x-agora-timestamp` e `x-agora-signature: sha256=HMAC(segredo, "<timestamp>.<corpo>")`.

**`SessionLog`:** chamadas e gravações em arquivo (`RecordSet`); a transcrição e o chat usam `ChatLog`. Uma implementação em Postgres cumpre os mesmos métodos (D-29).

### Eventos (R-MID-5)

| Evento | Dados |
|---|---|
| `call.started` | `sessionId`, `startedAt`, `by` |
| `call.ended` | `sessionId`, `startedAt`, `endedAt`, `durationMs`, `participants[]` |
| `transcript.finalized` | `sessionId`, `segments` (quando a chamada acaba) |
| `recording.started` | `recordingId`, `sessionId`, `userId`, `kind`, `mime` |
| `recording.completed` | `recordingId`, `sessionId`, `userId`, `kind`, `mime`, `sizeBytes`, `durationMs`, `startOffsetMs`, `sha256`, `truncated` |

Os eventos de segurança e de workspace de 09 §9.6 continuam valendo e entram no mesmo `EventSink` quando forem implementados.

## 14.5 API HTTP `/v1` (R-API-1..3)

Erro sempre `{ "error": { "code", "message" } }`. A autenticação é o mesmo token curto da conexão, em `Authorization: Bearer`.

| Rota | O que faz | Quem |
|---|---|---|
| `POST /v1/workspaces/:id/recordings` | começa (exige `consent: true`) | owner, editor, participant |
| `PUT .../recordings/:rid/parts/:n` | uma parte (até 8 MB) | só quem gravou |
| `POST .../recordings/:rid/complete` | junta as partes | quem gravou, ou o dono do workspace |
| `GET .../recordings` | a lista, com link assinado nas concluídas | qualquer papel |
| `GET .../recordings/:rid/media?exp&sig` | o arquivo (link assinado, `Range`) | quem tem o link |
| `GET .../transcript?format=jsonl\|json\|txt\|vtt\|srt[&session=]` | a transcrição, com tempo relativo à chamada | qualquer papel |

`viewer` não grava (R-PERM). O servidor recusa a parte maior que `MAX_RECORDING_PART_BYTES` e a gravação acima do limite total.

## 14.6 Como a Inteligência Aberta se encaixa (D-41)

- **Modo pull (hoje):** o `agora-sync` guarda os arquivos. Um receptor do webhook (a IA) recebe `recording.completed`, baixa pelo link assinado da lista e copia para o object store dela. A transcrição sai por `GET .../transcript` ou pelo evento `transcript.finalized`.
- **Modo push (próximo passo):** a IA implementa `FileStore` e devolve URLs de upload no bucket dela; o navegador envia os pedaços direto, e os bytes nunca passam pelo `agora-sync`. O contrato já separa quem decide o destino de quem grava.
- Os dois modos usam os mesmos eventos e o mesmo registro (`Recording`); muda só o `FileStore`.

## 14.7 Escala (D-43)

Hoje: um processo, arquivos em disco, salas em memória. O desenho já separa o que cresce:

- **Tempo real × HTTP.** As salas WebSocket ficam fixas num nó por workspace (roteamento por hash de `workspaceId`, ou dono da sala por trava no Postgres). Upload, download e API não têm estado e escalam em horizontal. Com URL assinada do host, os bytes nem passam pelo nó da sala.
- **Persistência.** Documento Yjs como log de atualizações com snapshot periódico, chat, transcrição, sessões e outbox em Postgres (D-29); bytes em object store S3-compatível (Garage/MinIO).
- **Transcrição no cliente (D-37):** escala com os usuários. Transcrever as gravações no servidor fica como worker em fila, depois.
- **A malha tem teto** (~6 a 8 pessoas). Um SFU (LiveKit) entra por trás do mesmo contrato e passa a gravar por `egress` (`source: sfu-egress`).
- **Operação:** limites por parte e por gravação, janitor de gravações abandonadas, retenção por tipo; ainda por fazer: `/metrics`, cota por workspace, exclusão por pedido (LGPD).

## 14.8 Fora desta etapa

Vídeo e compartilhamento de tela (o contrato já prevê `kind: video|screen`); exportação e importação do workspace inteiro em pacote; implementações S3 e Postgres; modo push com URL assinada do host; reconectar sem partir a chamada em duas (hoje uma queda de conexão que deixa a pessoa fora do último instante encerra a sessão e abre outra, e a gravação em andamento fica ligada à sessão anterior).

## 14.9 Próximos passos (para retomar)

Estado ao fim desta etapa (2026-10-17): servidor 45/45, navegador 180/180, aceitação 17/17. **Ainda não foi usado num Chrome real** com microfone, nem em produção. Ordem sugerida:

1. **Validar à mão (primeiro, antes de construir mais).** `docker compose up -d --build` (imagens novas: código do servidor e `client_max_body_size` do proxy). Entrar com duas pessoas, gravar, silenciar no meio, derrubar a aba, reabrir e conferir que a trilha sobe e toca; testar o Safari (MP4/AAC) e o celular. Receber o webhook num receptor de teste e baixar pela URL assinada. Confirmar o PiP automático ao sair da aba. O que falhar vira teste antes do conserto.
2. **Reconexão sem partir a chamada.** Dar uma carência (~15 s) antes de encerrar a sessão quando a pessoa some; se voltar dentro dela, continua a mesma. Evita a gravação ficar ligada à sessão errada. Teste: queda e volta de rede durante a gravação mantém um `sessionId`.
3. **Fase A (contratos com mais de uma implementação).** `FileStore` em S3 (Garage/MinIO) com upload em partes; `SessionLog`/`RecordSet`/outbox em Postgres; Compose com os dois; os testes de contrato de `media.test.js` passam a rodar contra todas as implementações. O check de acoplamento proíbe S3/Postgres fora dos adaptadores.
4. **Fase D.** Modo *push* (o host entrega URLs assinadas por parte e o navegador envia direto; sem mudar eventos nem `Recording`); vídeo (`kind: video`, mesmo `Recorder`, `pickMime('video')` já existe) e tela (`getDisplayMedia`); `GET /v1/workspaces/:id/export` e importação com manifesto versionado (documento, transcrição, sessões, referências `blob:`).
5. **Fase E.** Dono da sala (trava no Postgres), HTTP sem estado, `/metrics`, cota por workspace e pessoa, exclusão por pedido (LGPD), retenção por tipo, SFU (LiveKit) com `source: sfu-egress`. Decidir D-43 quando houver carga.
6. **Depois.** Transcrever as gravações no servidor (worker em fila, melhora a transcrição do cliente), política de classificação do workspace (R-CLS-2) que proíbe gravar, e mixagem das trilhas alinhadas por `startOffsetMs` para um único arquivo da reunião.

Limites conhecidos a lembrar: o servidor guarda o estado em arquivos num único processo; a malha P2P tem teto (~6 a 8 pessoas); o buffer local do gravador é o IndexedDB (em janela privada vira memória e não sobrevive à aba).
