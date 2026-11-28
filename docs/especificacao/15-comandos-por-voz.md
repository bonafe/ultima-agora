# 15. Comandos por voz e modelo de decisão

Este capítulo descreve como a fala (ou o texto digitado) vira uma operação no workspace, e **onde roda o modelo** que ajuda a
entender frases que a gramática não conhece. Ele concretiza R-VOICE-1 e R-VOICE-3 (06) e registra a decisão **D-44** (12).

## 15.1 Ideia em uma frase

A pessoa diz "Ágora, põe as notas embaixo"; o Agora **entende, confere se ela pode, e faz pela mesma API que a interface usa**, de
modo que o resultado é um passo que se desfaz, como se ela tivesse arrastado a janela com o mouse.

Três princípios guiam tudo:

1. **Nenhuma porta dos fundos.** Um comando só recebe o `Workspace`; não tem acesso a nada que a interface não tenha (R-AG-3).
2. **Sugerir, não adivinhar.** Quando não tem certeza, o sistema **pergunta** ("Quis dizer *Mover janela*?"). Quando não entende, diz
   "não entendi". Nunca executa um palpite em silêncio.
3. **A pessoa liga, a pessoa vê.** Nada é interpretado até ela ligar o interruptor; tudo o que foi ouvido e feito aparece na tela.

## 15.2 O caminho de uma frase

```
 fala ──► Transcriber ──► palavra de ativação ──► interpretador ──► CommandRegistry ──► resposta
 (só a      (Whisper no      ("Ágora, …";            regras primeiro,   confere papel,     "Adicionei Tabela."
 sua)       seu navegador)    digitar dispensa)       modelo sugere      pede confirmação,   [Desfazer]
                                                                         executa
 texto digitado ────────────────────────────────────────┘
```

| Etapa | Quem faz | Garantia |
|---|---|---|
| Ouvir | `VoiceCommandService` escuta `Transcriber.onUtterance` | Só a fala **da própria pessoa**, e só depois de ela ligar "Ouvir meus comandos" (R-CMD-1) |
| Porta de entrada | Palavra de ativação ("Ágora", "Ultima Ágora") | Conversa comum não vira comando. Texto digitado não precisa dela |
| Entender | Um **interpretador** (15.4) devolve `{ command, args, confidence }` ou nada | Nada = "não entendi" |
| Decidir | `confidence` abaixo de `minConfidence` (0,6) | A pessoa confirma antes de qualquer execução |
| Executar | `CommandRegistry.execute(workspace, call)` | Confere o papel, valida os argumentos, pede confirmação se destrutivo, nunca lança exceção |
| Responder | Barra de comandos no shell | Mostra o que ouviu e o resultado, com **Desfazer** |

## 15.3 Os comandos

Cada comando é um objeto com nome, título, exemplos, parâmetros, **nível de acesso** e se é **destrutivo**. A lista abaixo é a do
catálogo (`core/commands/catalog.js`); a ajuda do app ("quais comandos?") a gera do mesmo lugar.

| Comando | O que faz | Exemplo | Quem pode | Pede confirmação |
|---|---|---|---|---|
| `add` | Adiciona uma peça, com lado e vizinha | "adiciona notas à direita da tabela" | compor | não |
| `remove` | Remove uma janela | "remove as notas" | compor | **sim** |
| `rename` | Renomeia | "renomeia a tabela para Clientes" | compor | não |
| `duplicate` | Duplica | "duplica esta janela" | compor | não |
| `focus` | Vai até uma janela | "foca nas notas" | qualquer um | não |
| `move` | Move para um lado | "põe as notas embaixo" | compor | não |
| `connect` | Liga duas janelas | "conecta a busca na tabela" | compor | não |
| `disconnect` | Desliga | "desconecta a busca da tabela" | compor | **sim** |
| `undo` / `redo` | Desfaz / refaz | "desfaz" | compor | não |
| `run-action` | Roda uma ação do componente | "mostra como grafo" | compor | não |
| `note` | Escreve nas notas | "anota: comprar passagens" | editar conteúdo | não |
| `chat` | Escreve no chat | "escreve no chat: já volto" | editar conteúdo | não |
| `stop-transcribing` | Para a transcrição | "para de transcrever" | qualquer um | não |
| `describe` | Descreve o que há na tela | "o que tem na tela?" | qualquer um | não |
| `help` | Lista os comandos | "quais comandos?" | qualquer um | não |

"Compor" é o que `owner` e `editor` podem; "editar conteúdo" inclui `participant`; `viewer` só usa os de "qualquer um". O papel é o
da própria pessoa: **um comando nunca dá mais poder que a interface** (R-AG-3, R-AG-9).

## 15.4 Os interpretadores

Um interpretador é qualquer objeto com `interpret(texto, contexto) → chamada | nada` (pode ser assíncrono). Há três peças:

| Peça | Papel |
|---|---|
| `RulesInterpreter` | **A base.** Gramática em português, determinística, instantânea (< 1 ms), sem rede. Entende interjeições ("ops, desfaz"), sinônimos e formas livres. Nunca chuta: sem correspondência devolve nada. Medida em 111 frases que não tinha visto: 93,7 % entendidas, 0 comandos trocados |
| `ModelInterpreter` | Pergunta a um **modelo de decisão** qual comando a frase quer dizer; os argumentos ("a tabela", "à esquerda") continuam sendo cortados pelas regras (`RulesInterpreter.extract`) |
| `ChainInterpreter` | Junta as duas: **as regras vão primeiro**; só o que elas não entenderam vai ao modelo, que então **apenas sugere**. Se o modelo falhar, vale o "não entendi" das regras |

O modelo fala através de um contrato mínimo, `ChoiceBackend`: dada uma frase e uma lista de opções, devolve uma probabilidade por opção.

```
backend.id                              nome do modelo (aparece na interface e nas medições)
backend.load({ onProgress })            prepara; sabe dizer "não há modelo aqui" (não adianta tentar de novo)
backend.choose({ question, options:[{id,text}], state }) → { scores:[{id,p}], ms }
backend.dispose()
```

Como o contrato não sabe nada de comandos, ONNX ou servidores, **trocar de modelo é escrever uma classe**. Existem três backends:
`LayaBackend` (no navegador), `RemoteChoiceBackend` (no servidor) e `FallbackBackend`, que tenta vários em ordem.

## 15.5 Onde o modelo roda

Quem escolhe é a pessoa, com `?model=` na URL. O padrão é `off`.

| `?model=` | O que acontece | Quando usar |
|---|---|---|
| `off` (padrão) | Só as regras. Nada sai do navegador | Quase sempre. É o caminho mais rápido e mais previsível |
| `local` | Regras, depois o Laya **no navegador** (worker + ONNX Runtime Web) | Sem servidor de modelo. Pesado: ~262 MB e 2–3 s por frase; **não roda em todo aparelho** |
| `remote` | Regras, depois o modelo **no servidor** (`agora-sync` → `agora-model`) | Aparelhos fracos. ~0,7 s em CPU, menos com GPU |
| `auto` | Regras, depois o servidor, depois o navegador | Quer o melhor que estiver disponível |

No servidor, o `agora-sync` recebe `POST /v1/workspaces/:id/decide`, confere o token, limita por pessoa e repassa a **qualquer serviço
que fale o contrato `POST /choose`** (`AGORA_MODEL_URL`). O serviço que acompanha o projeto, `server/agora-model` (Python), tem dois
backends: `laya` (ONNX, CPU ou GPU) e `openai_compat`, que **aponta para outro lugar**: o gateway do Inteligência Aberta, um vLLM ou uma
API externa. Ver o [README do serviço](../../server/agora-model/README.md).

**Medidas** (CPU de 6 núcleos, 130 frases em português; `docs/spike-laya.md`):

| Onde | Tempo por frase | Acerto do comando |
|---|---|---|
| Regras | < 1 ms | 48,5 % (na primeira medição; 93,7 % na gramática atual, em frases novas) |
| Laya no servidor (CPU) | ~0,7 s | 23–41 % |
| Laya no navegador, com threads | 2,1–2,8 s | 23 % |
| Laya no navegador, sem threads | ~7 s | — |

A conclusão é franca: **o servidor resolve velocidade e alcance, não qualidade**. O Laya zero-shot, em português, acerta menos que as
regras. Por isso ele só sugere. Para valer mais, o modelo precisaria ser ajustado a frases reais de uso (o `laya.Learner` faz isso, em
Python, no servidor), ou trocado por outro que entenda português, o que é *escrever um backend*.

> O WebAssembly só usa vários *threads* se a página for servida com `Cross-Origin-Opener-Policy: same-origin` e
> `Cross-Origin-Embedder-Policy: require-corp`. O nginx do `docker-compose` já envia os dois cabeçalhos.

## 15.6 Privacidade

A frase é fala transcrita; merece cuidado. Decisão **D-44**:

- **Padrão: nada sai.** Com `?model=off`, interpretação e execução acontecem no navegador.
- **Só vai a um servidor se a pessoa escolheu** `?model=remote` ou `auto`.
- **O servidor repassa e esquece.** `agora-sync` e `agora-model` **nunca gravam nem registram o texto**; o log tem só número de opções e tempo
  (há testes que garantem). A chave de uma API externa fica só no servidor.
- **Quem opera decide o destino.** Apontar `AGORA_MODEL_URL` para um serviço externo é uma escolha explícita de quem hospeda, e a frase
  vai para lá. Instalações com dados restritos devem usar apenas serviço do próprio operador (ADR 003 do Inteligência Aberta).
- O interruptor "só comandos" faz a frase ser usada **localmente** sem entrar na transcrição da chamada.

## 15.7 Requisitos

- **R-CMD-1.** Nada é interpretado até a pessoa ligar o interruptor; ele ouve **só a fala da própria pessoa**. Comandos digitados funcionam sempre (acessibilidade, R-VOICE-2).
- **R-CMD-2.** Um comando usa apenas a API do `Workspace`, respeita o papel da pessoa e é **um passo desfazível**, registrado com `createdVia: voice`.
- **R-CMD-3.** Comandos destrutivos (`remove`, `disconnect`) **pedem confirmação** ("Sim"/"Não") antes de executar (R-AG-4).
- **R-CMD-4.** Há um **limite de taxa** de comandos por minuto, para que uma frase mal ouvida em laço não reescreva o workspace (R-AG-8).
- **R-CMD-5.** Abaixo de uma confiança mínima o sistema **pergunta antes de executar**; sem entendimento, diz "não entendi". Nunca executa um palpite.
- **R-CMD-6.** Um modelo de decisão é **opcional e trocável** atrás do contrato `ChoiceBackend`; as regras vão sempre primeiro e o modelo só sugere. Um modelo indisponível **não** é um erro para a pessoa.
- **R-CMD-7.** O texto da fala só sai do navegador por escolha da pessoa; o servidor o **repassa e esquece** e o operador escolhe o destino (D-44).
- **R-CMD-8.** O código que importa o runtime do modelo (ONNX) fica restrito ao backend; o resto fala só com o contrato (verificado por `tools/verificar_acoplamento.py`).

## 15.8 Fora do escopo e próximos passos

- Comandos **de chamada** (silenciar, ligar câmera) e de navegação entre workspaces.
- **Ajustar** um modelo com frases reais confirmadas ("sim, era isso"), para o acerto subir.
- Um **modelo multilíngue** melhor que o Laya, escrito como novo backend; medir com `tools/spike-laya/browser.sh`.
- Medir o servidor **com GPU** e decidir se vale a pena dividir o `agora-model` entre várias máquinas (o Inteligência Aberta já tem um
  roteador por máquina para LLMs).
- Resposta por voz (síntese) mais rica e teste de ponta a ponta com microfone real, em mais navegadores e idiomas.
