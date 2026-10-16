# 06. Comunicação

Conferência, chat, notas e whiteboard são **capacidades do workspace**. O Agora não é um sistema de videoconferência. O conteúdo é o protagonista e a reunião o acompanha.

## 6.1 Chat

### Escopo

| Escopo | Fase |
|---|---|
| Chat do workspace | MVP |
| Menções (`@Maria`) e notificação | MVP |
| Referências a elementos do workspace (instância, objeto de domínio) | F2 |
| Chat de componente / de entidade / de investigação | F2 |
| Mensagens privadas | F2 |

### Requisitos

- **R-CHAT-1.** O chat do workspace é um componente (`ultima-chat`) e também pode ser exibido como painel flutuante do shell. É o mesmo componente em ambos os casos.
- **R-CHAT-2.** Mensagens são **persistidas no servidor** (fora do documento CRDT, ver 05.6), com retenção configurável por workspace (D-11), e entregues em tempo real aos conectados.
- **R-CHAT-3.** Uma mensagem pode carregar **anexos de referência**: `{ kind: "instance" | "domain-ref", id, label }`. A referência abre, ou destaca, o elemento correspondente se o leitor tiver acesso. Sem acesso, aparece como "referência indisponível", sem vazar rótulo.
- **R-CHAT-4.** Texto simples com marcação mínima (negrito/itálico/código/lista). Sem HTML arbitrário. A sanitização é feita na renderização.
- **R-CHAT-5.** Mensagens podem ser **editadas e removidas** pelo autor (o histórico de edição fica visível para auditoria quando o workspace exigir, D-11).
- **R-CHAT-6.** Agentes participam do chat com identidade própria (08).
- **R-CHAT-7.** Indicador de leitura e contagem de não lidas por participante.

## 6.2 Conferência (áudio, vídeo, tela)

### Abstração

O núcleo não implementa uma pilha WebRTC. Ele define o contrato:

```text
ConferenceProvider
  connect(roomId, token, { audio, video }) → ConferenceRoom
ConferenceRoom
  participants         (lista com estado de mídia)
  setMic(on) / setCam(on) / shareScreen(on)
  on("participant-joined" | "participant-left" | "track-subscribed" | "speaking" | "error")
  disconnect()
```

O componente `<ultima-conference>` usa um `ConferenceProvider` injetado. Implementações (D-36):

- `MeshProvider` (**padrão para grupos pequenos**, até cerca de 4–6 pessoas): cada navegador liga direto aos outros com `RTCPeerConnection` nativo. A sinalização (oferta, resposta, ICE) passa pelo `agora-sync`, que só a repassa entre pessoas do mesmo workspace (mensagem tipo 5); quem está na chamada e o estado de mídia vêm da presença. Sem servidor novo. Limites: banda e CPU crescem com o quadrado do número de participantes; o servidor **não consegue impedir** que um *viewer* envie mídia (o P2P não passa por ele), então o papel só controla a interface; entre redes diferentes pode precisar de TURN (`AGORA_ICE_SERVERS`).
- `LiveKitProvider` (para escala, F3), `JitsiProvider` (alternativa, F3): atrás do mesmo contrato.

- **R-CONF-1** (F2). A sala da conferência é derivada do workspace (`roomId = workspaceId`) e as credenciais são emitidas pelo backend de forma curta, após verificação do papel (D-20). No `MeshProvider` o crédito é o próprio token do `agora-sync`.
- **R-CONF-2** (F2). A conferência **não ocupa a tela toda**. Os participantes aparecem como *tiles* pequenos e reposicionáveis sobre o workspace, ou numa barra. Há modo expandido sob demanda.
- **R-CONF-3** (F2). O estado de mídia (microfone, câmera, falando) publica-se na presença (5.3), de modo que o restante da UI possa mostrar "quem está falando" sem acoplamento com o provider.
- **R-CONF-7.** Câmera e microfone só funcionam em contexto seguro do navegador (HTTPS ou `localhost`): o ambiente de demonstração em rede local usa HTTPS (`docker-compose.yml`). Desligar a câmera ou o microfone **encerra** a captura (a luz do dispositivo apaga), não apenas silencia.
- **R-CONF-4.** O compartilhamento de tela pode ser exibido como componente (`ultima-screen-share`, F3), que passa a ser uma instância no workspace.
- **R-CONF-5.** Sem conferência, o workspace funciona completo. Falha no provider não afeta o resto.
- **R-CONF-6. Implantação isolada.** Ambientes sem internet devem poder usar o LiveKit autoalojado. O Agora **não** pode depender de serviço de terceiros para a conferência (coerente com o Inteligência Aberta).

### Privacidade

- Entrar numa conferência pede confirmação explícita para ativar microfone e câmera (nunca ligam sozinhos).
- Gravação **fora do MVP**. Se for adotada, exige consentimento visível e é tratada como dado classificado (herda a classificação do workspace).

## 6.3 Voz como interface (alinhamento com a ADR 004 do Inteligência Aberta)

O Inteligência Aberta trata voz como cidadã de primeira classe. O Agora não implementa STT/TTS, mas **não pode ser um obstáculo**:

- **R-VOICE-1.** Toda ação disponível por UI deve estar disponível de forma programática (via `actions` e ferramentas de agente, 08), o que permite uma interface de voz acionar o Agora pelo agente.
- **R-VOICE-2.** O shell e os componentes do núcleo devem ser operáveis por teclado e leitores de tela (7.8). Isso é pré-requisito para voz e acessibilidade.
- **R-VOICE-3** (F3). Avaliar um canal de voz para o agente do workspace ("ditar" no chat/notas, ouvir respostas curtas), reaproveitando o contêiner de voz do Inteligência Aberta, sem acoplar o núcleo.

## 6.4 Notas colaborativas (`ultima-notes`)

- **R-NOTES-1** (MVP). Edição simultânea de texto rico mínimo (cabeçalhos, listas, negrito/itálico, links, código) com cursores de colegas.
- **R-NOTES-2.** Persistência no nó `content[instanceId]` do documento. Várias instâncias de notas são independentes.
- **R-NOTES-3.** Permite inserir **chips de referência** (objetos do domínio, outras instâncias), a partir de drag-and-drop (4.8) ou menção `@`/`#`.
- **R-NOTES-4.** O editor é **substituível**: a interface com o Agora é `SharedText` (`getText()`, `onChange`, `insertRef(ref)`, binding ao nó colaborativo). A implementação inicial deve ser escolhida considerando o requisito **sem build** (D-07):
  - editor mínimo próprio sobre `contenteditable` ou `<textarea>` ligado a `Y.Text` (pouco código, funcionalidades limitadas);
  - biblioteca existente distribuída como ESM pronto (ex.: um editor com binding Yjs que forneça bundle sem bundler).
- **R-NOTES-5.** Exportar como Markdown e texto simples.
- **R-NOTES-6. Classificação.** Notas são **conteúdo do workspace**. Herdam a classificação do workspace e o seu modelo de compartilhamento. Se o workspace é `interno`, as notas são `interno`. (A reclassificação do workspace é uma operação explícita, ver 09.4.)

## 6.5 Whiteboard (`ultima-whiteboard`) — F2

- **R-WB-1.** Componente opcional, **um entre muitos**. Não define o modelo de layout do Agora.
- **R-WB-2.** A implementação inicial é uma biblioteca consolidada (a proposta sugere tldraw). Como o Agora é **sem build** e tldraw é distribuído para toolchains com bundler/React, isso é um risco técnico real (D-06). Alternativas a avaliar: tldraw via bundle ESM pré-construído e copiado; Excalidraw; um quadro próprio mínimo (traços, formas, texto, cartões) sobre canvas/SVG com `Y.Array`.
- **R-WB-3.** Interface com o Agora: `shared-content` para o estado, `drops` para receber objetos arrastados (4.8), e saídas tipadas (por exemplo, `selectedCard`).
- **R-WB-4.** Objetos de domínio no quadro são **cartões com referência** (R-DOC-3), nunca cópias do dado.
- **R-WB-5.** Limites de tamanho e de número de elementos por quadro (D-10).

## 6.6 Outros componentes genéricos do catálogo (resumo)

Os componentes da lista da proposta (seção 31), com a fase proposta:

| Componente | Descrição | Fase |
|---|---|---|
| `ultima-text` | Texto estático/rotulado | MVP |
| `ultima-markdown` | Renderização de Markdown | MVP |
| `ultima-notes` | Notas colaborativas | MVP |
| `ultima-table` | Tabela (tipo `Table`) com ordenação/filtro, entrada e saída de seleção | MVP |
| `ultima-chat` | Chat do workspace | MVP |
| `ultima-chart` | Gráfico (tipo `Series`) | F2 |
| `ultima-tree` | Árvore | F2 |
| `ultima-timeline` | Linha do tempo (tipo `TimeSeries`/eventos) | F2 |
| `ultima-map` | Mapa (tipo `GeoFeatures`) | F2/F3 |
| `ultima-image` / `ultima-file` | Mídia/arquivo no `file-store` | F2 |
| `ultima-browser` | Navegador embutido (iframe com restrições) | F3 (riscos de segurança, D-21) |
| `ultima-whiteboard` | Quadro | F2 |
| `ultima-conference` | Conferência | F2 |
| `ultima-agent` | Agente genérico | F2 |
| `ultima-graph` | Grafo genérico (tipo `Graph`) | MVP (o `ia-graph` do domínio é uma especialização) |

> **Nota.** `ultima-graph` e `ultima-timeline` são genéricos e podem ser reaproveitados por qualquer domínio. Os componentes `ia-*` os **estendem ou os envolvem**, adicionando semântica do domínio (ações específicas, tipos). Isso mantém "domínio fora do núcleo" sem duplicar visualização.
