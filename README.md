# Ultima Ágora

**Um espaço de trabalho que você monta com peças vivas e divide com outras pessoas, em tempo real.**

O Ultima Ágora é uma camada colaborativa sobre o [UltimaJS](../ultima). Em vez de telas fixas, cada pessoa
**compõe o próprio espaço** com componentes que têm portas tipadas (notas, tabela, grafo, chat, chamada...), liga uma peça
na outra e trabalha ali junto com os outros. O espaço é **persistente**: quando todos saem, ele continua como foi deixado.

> Sem build, sem dependências no navegador: JavaScript puro, módulos ES nativos. Funciona offline depois da primeira visita.

[Conhecer o site](https://bonafe.github.io/ultima-agora/) ·
[Rodar em casa](https://bonafe.github.io/ultima-agora/hospedar.html) ·
[Falar com a Ágora (comandos de voz)](https://bonafe.github.io/ultima-agora/comandos.html) ·
[Documentação](docs/README.md) ·
[Especificação](docs/especificacao/00-indice.md)

---

## Experimente em 30 segundos

```bash
python3 -m http.server 8080        # na raiz do repositório
```

Abra <http://localhost:8080/> (a apresentação) e clique em **Entrar na Ágora**, ou vá direto a
<http://localhost:8080/app.html>. O primeiro acesso abre um **workspace de boas-vindas**: um exemplo funcionando, com um guia,
um caderno e uma tabela ligada a um grafo.

> Use a porta 8080 (a 8000 é a do portal do Inteligência Aberta). Abrir o arquivo direto, por `file://`, não funciona: módulos ES
> exigem HTTP.

**Para trabalhar com outras pessoas** (tempo real, presença, chat, chamada), suba também o servidor de sincronização:

```bash
cd server/agora-sync && npm install && AGORA_DEV_AUTH=1 npm start
# em outro terminal, na raiz:  python3 -m http.server 8080
# abra  http://localhost:8080/app.html?sync=http://localhost:8787&name=Maria
```

Ou tudo de uma vez com Docker (app, HTTPS e servidor, atrás do mesmo endereço): `docker compose up -d --build`.
O passo a passo para quem não programa está em [Rodar em casa](https://bonafe.github.io/ultima-agora/hospedar.html); o de produção, em
[`server/agora-sync/README.md`](server/agora-sync/README.md).

---

## O que já funciona

| Área | O que você faz |
|---|---|
| **Composição** | Escolhe peças na paleta, arruma em painéis, abas e divisões, **liga uma peça a outra** por portas tipadas. Uma tabela vira um grafo com um clique, num único passo que se desfaz. |
| **Janelas** | Arrasta janelas para acoplar, **flutuar**, abrir em **outra janela do navegador** (outro monitor) ou fixar por cima de tudo (Picture-in-Picture). |
| **Colaboração** | Várias pessoas editam ao mesmo tempo (Yjs), com **presença** (quem está aqui, o que olha), papéis (`owner`, `editor`, `participant`, `viewer`) **aplicados no servidor** e edição offline que se funde na volta. |
| **Conversa** | **Chat** persistente com menções, **chamada de áudio e vídeo** em malha (WebRTC) e **convite por QR code**. Câmera e microfone só ligam quando você marca. |
| **Transcrição** | O Whisper roda **no seu navegador**: o áudio não sai do seu aparelho, só o texto vai ao workspace. Exporta em `.txt`, `.vtt`, `.srt`. |
| **Gravação** | Cada pessoa grava a própria trilha, com consentimento visível, enviada em pedaços durante a chamada. O servidor avisa outros sistemas por **webhook assinado**. |
| **Comandos por voz** | Diga "Ágora, adiciona uma tabela à direita das notas" (ou digite). As regras entendem; um **modelo de decisão opcional** sugere o que elas não pegaram. Veja o [guia de comandos](https://bonafe.github.io/ultima-agora/comandos.html). |
| **Celular** | Cada componente responde à largura da própria caixa; no telefone o workspace mostra uma janela por vez, com barra inferior. |
| **Offline e acessível** | Service worker, cache local, reconexão automática; controles nomeados e alcançáveis por teclado. |

O que **ainda não** existe (e está dito com franqueza): conexões visuais, quadro branco, histórico de versões, agentes que
manipulam o workspace, vídeo gravado e tela compartilhada. Veja o [roadmap](docs/especificacao/11-roadmap-mvp.md).

---

## Como funciona

```
 navegador (local-first)                       servidores (opcionais)
┌───────────────────────────────┐
│  shell · paleta · inspetor    │   WebSocket   ┌──────────────────────┐
│  workspace (layout em árvore) │ ◄───────────► │  agora-sync (Node)   │  tokens, papéis, chat,
│  componentes ──portas──► bus  │   /v1 (HTTP)  │  Yjs · chamada · API │  gravações, webhooks
│  documento do workspace (Yjs) │ ◄───────────► └──────────┬───────────┘
│  IndexedDB · service worker   │                          │ POST /choose
│  Whisper · Laya (opcionais)   │                          ▼
└───────────────────────────────┘               ┌──────────────────────┐
                                                │ agora-model (Python) │  modelo de decisão
                                                │ laya · openai_compat │  de comandos (opcional)
                                                └──────────────────────┘
```

Quatro ideias sustentam o projeto:

1. **O workspace é um documento.** Composição, layout, conexões e conteúdo escrito à mão vivem num documento colaborativo.
   Dados de domínio **não**: o documento guarda só *referências* (R-DOC-3).
2. **Tudo passa por contratos.** O estado colaborativo (`StateStore`), a conferência (`ConferenceProvider`), a transcrição
   (`Transcriber`) e o modelo de decisão (`ChoiceBackend`) são interfaces pequenas. Yjs, WebRTC, Whisper e Laya são *detalhes atrás
   de adaptadores*, trocáveis sem mexer no resto.
3. **Local-first.** Seu trabalho existe no seu aparelho; o servidor sincroniza, não é o dono.
4. **Máquinas à vista.** O que um modelo ou agente faz passa pela mesma API e pelas mesmas permissões das pessoas, e só *sugere*
   quando não tem certeza. Nada executa em silêncio.

---

## Mapa do repositório

| Pasta | Para que serve |
|---|---|
| `core/` | Componentes (`AgoraComponent`), registro e manifestos, workspace e layout, barramento, comandos |
| `collaboration/` | Documento (`MemoryStateStore`, `YjsWorkspaceDoc`), provedores de sync, presença. **Só aqui se importa o Yjs** |
| `components/` | Catálogo: notas, texto, tabela, grafo, chat, chamada, transcrição, gravações |
| `ui/` | Shell, paleta, workspace, inspetor, chamada, barra de comandos, convite |
| `voice/` | Comandos por voz: serviço, interpretador de regras, modelo de decisão (navegador e servidor) |
| `transcription/`, `conference/` | Whisper no navegador; chamada WebRTC em malha |
| `adapters/dev/` | `DevHost`, o hospedeiro de desenvolvimento |
| `server/agora-sync/` | Servidor de tempo real (Node). **`server/agora-model/`**: modelo de decisão (Python) |
| `vendor/` | Bibliotecas de terceiros já compiladas, com versão e hash (UltimaJS, Yjs, Whisper, ONNX Runtime, uqr) |
| `site/`, `index.html`, `hospedar.html`, `comandos.html` | O site (estático, GitHub Pages) |
| `docs/` | Especificação (em português), contratos, aceite e medições |
| `tests/`, `tools/` | Testes sem dependências e ferramentas (modelos, precache, acoplamento) |

---

## Testes

Sem build nem dependências no navegador. Há três suítes e uma de servidor:

| Comando | O que roda |
|---|---|
| `tests/run.sh` | Suíte do navegador em Chrome headless (é o que o CI roda), mais a verificação de acoplamento e do precache offline |
| `tests/run_acceptance.sh` | Várias pessoas, cada uma um cliente completo, contra o servidor real: os critérios de aceite do MVP ([`docs/aceite-mvp.md`](docs/aceite-mvp.md)) |
| `cd server/agora-sync && npm test` | Servidor de sincronização, chat, gravação, API |
| `python3 -m unittest discover -s server/agora-model/tests` | Serviço do modelo de decisão |

Toda correção de bug entra com um teste. Mudanças visíveis entram no [`CHANGELOG.md`](CHANGELOG.md).

---

## Modelos de IA (opcionais)

Dois recursos usam modelos que **não vêm no repositório** (pesos grandes ficam em `models/`, fora do git):

```bash
tools/baixar_modelo_whisper.py      # transcrição (~80 MB; tiny ~41 MB, small ~250 MB)
tools/baixar_modelo_laya.py         # modelo de decisão de comandos (~262 MB)
```

O modelo de decisão pode rodar **no navegador** (`?model=local`), **no servidor** (`?model=remote`, serviço `server/agora-model`,
CPU ou GPU) ou **nos dois, em ordem** (`?model=auto`). O padrão é `off`: só as regras, instantâneas, sem nada sair do navegador.
O servidor aceita apontar para **outro lugar** (o gateway do Inteligência Aberta, um vLLM, uma API externa). A fala só vai a um servidor
se a pessoa escolheu, e é repassada e esquecida (decisão **D-44**). Medições e a conclusão honesta (o modelo ajuda a velocidade e o
alcance, não o acerto) estão em [`docs/spike-laya.md`](docs/spike-laya.md).

---

## Documentação

- [`docs/README.md`](docs/README.md): o mapa de toda a documentação
- [`docs/especificacao/`](docs/especificacao/00-indice.md): requisitos (`R-…`) e decisões (`D-…`), começando pelo índice
- [`docs/contrato-agoracomponent.md`](docs/contrato-agoracomponent.md): como escrever um componente novo
- [`docs/aceite-mvp.md`](docs/aceite-mvp.md): critério por critério, o que está provado e o que falta
- [`server/agora-sync/README.md`](server/agora-sync/README.md) e [`server/agora-model/README.md`](server/agora-model/README.md): os servidores
- [`CLAUDE.md`](CLAUDE.md): convenções do código para quem (ou o quê) for contribuir

**Idioma:** código, comentários e identificadores em inglês; documentação e textos de interface em português.

---

## Integração com o Inteligência Aberta

O Ágora roda dentro do [Inteligência Aberta](../inteligencia-aberta) (`/agora/`), com hospedeiro Django, papéis limitados pelo papel na
organização e componentes `ia-*`. Essa integração vive no repositório do IA; **este repositório não conhece dado de domínio**.

## Licença

[GNU AGPL v3](LICENSE).
