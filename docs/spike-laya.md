# Spike F0 — modelo de decisão (Laya) para comandos de voz

> **Estado atual (2026-11-21).** Este documento registra as **medições** do modelo de decisão. O desenho que saiu delas (contrato
> `ChoiceBackend`, modelo no navegador, no servidor ou em outro lugar, sempre atrás das regras) está no
> [capítulo 15 da especificação](especificacao/15-comandos-por-voz.md) e na decisão **D-44**. As seções abaixo estão em ordem
> cronológica: F0 (Python), F0b (navegador) e F0c (servidor).

Data: 2026-11-20. Pergunta: um modelo de decisão estilo JEV/Laya, rodando no navegador, escolhe o comando certo a partir da frase falada? Scripts: `tools/spike-laya/`; frases: `tests/fixtures/voice_commands_pt.json` (130 frases pt-BR, 16 comandos + "conversa").

## O que foi medido

Laya (Apache-2.0, Convai Innovations) em ONNX (`techtheist/laya-onnx`), CPU, 6 threads, uma pergunta `choice` com os comandos como opções. Sem treino: zero-shot.

| Configuração | Acerta o comando | Latência (mediana) | Observação |
|---|---|---|---|
| Laya EN int4 (262 MB), opções "chave: descrição" | 14,6 % | 504 ms | descrições truncadas (limite de 192 tokens para as 17 opções) |
| Laya EN int4, só nomes dos comandos | 25,4 % | 150 ms | |
| Laya EN int4, descrições curtas em pt | **40,8 %** | 445 ms | melhor caso; só 2–10 % das frases passam do limiar com 70–100 % de acerto |
| Laya EN int4, dois estágios (grupo → comando) | 10,0 % | 184 ms | pior |
| Laya multilingual int8 (873 MB) | 6,2 % (acaso) | 207 ms | saída uniforme (~1/n): a quantização int8 dinâmica o inutiliza |
| **`RulesInterpreter`** (gramática atual) | **48,5 %** | < 1 ms | **0** conversas tomadas por comando; 64 "não entendi"; 3 trocas |

O pipeline está correto: no exemplo do README (cobrança/técnico/outro) o checkpoint EN acerta, inclusive em português.

## Conclusão

1. **Laya zero-shot não serve** para este catálogo: com ~17 opções ele erra mais do que acerta e, pior, **executa errado** com confiança média. As regras têm o mesmo alcance e nunca executam o comando errado (só "não entendi").
2. O checkpoint multilíngue (o que entenderia português) só existe aqui em int8 e vem quebrado; um export fp32/int4 próprio exigiria Python+PyTorch.
3. Para um modelo valer a pena seria preciso **ajustá-lo** (o `laya.Learner` aprende de respostas confirmadas, mas em Python, na máquina do servidor, não no navegador) — fora do escopo do MVP.

## Decisão recomendada

- Manter `RulesInterpreter` como interpretador e **ampliar a gramática** com as paráfrases que faltam (a maior parte dos 64 "não entendi" são sinônimos e interjeições: "ops, desfaz", "pode fechar", "quero ver como grafo", "liga X ao Y"), medindo contra este fixture.
- Deixar o contrato `interpret(text, ctx)` aberto para um modelo ajustado no futuro; se vier, ele só **propõe** e as regras/limiar decidem (nada executa abaixo de 0,6 de confiança sem perguntar).
- Reabrir a questão se: (a) houver um modelo de decisão multilíngue com export fp32/int4 utilizável, ou (b) juntarmos frases reais de uso para ajustar um.

## Depois: gramática ampliada (mesmo dia)

A gramática foi ampliada olhando para as 130 frases acima (interjeições como "ops" e "pode", sinônimos, "quero ver", "me traz", variações de lado, conexões e desconexões por "ligação"). Como isso é medir no próprio conjunto de desenvolvimento, foi escrito **outro conjunto de 111 frases que a gramática não tinha visto** (`tests/fixtures/voice_commands_pt_heldout.json`, 24 delas conversa comum):

| Conjunto | Entende o comando | Troca um comando por outro | Conversa tomada por comando |
|---|---|---|---|
| Desenvolvimento (130) | 100 % | 0 | 0 de 10 |
| **Reservado (111)** | **93,7 %** (104/111) | 0 | **7 de 24** |

Dois ajustes (“me traz”, “se chamam”) vieram dos erros do conjunto reservado; ele já não é mais virgem para esses casos.

As 7 conversas tomadas por comando são frases como "põe a mesa para o almoço", "fecha a porta", "tira uma foto da lousa", "me dá um minuto". Elas só chegam ao interpretador **depois da palavra de ativação** ("Ágora, …"), e mesmo então o comando não acha nada que conheça ("Não achei janela 'porta'", "Não conheço 'a mesa'"), então **nada muda no workspace** e nenhuma pergunta de confirmação é feita (teste automatizado). É ruído na tela, não dano. Se incomodar, o próximo passo é exigir que o argumento cite um componente ou janela conhecidos já no interpretador.

## F0b — o mesmo modelo rodando NO navegador (2026-11-21)

O spike acima rodou em Python (ONNX Runtime nativo); isto mede o Laya EN int4 de fato no navegador: worker + onnxruntime-web (WASM, CPU),
tokenizador BPE próprio em JS, mesmos 17 comandos do catálogo, 130 frases pt-BR. Reproduzir: `tools/baixar_modelo_laya.py` e `tools/spike-laya/browser.sh`.
Máquina: 6 núcleos; Chrome headless.

| | Python nativo (6 threads) | Navegador, 1 thread (sem COOP/COEP) | Navegador, com threads (COOP/COEP) |
|---|---|---|---|
| inferência por frase (mediana) | ~0,8 s (opções longas, 195 tokens) | **7,1 s** | **2,1–2,8 s** (p95 ~2,4–4,5 s) |
| carga dos 262 MB | — | ~2,6–5 s (do servidor local) | idem; depois vem do Cache Storage |
| acerto do comando | 40,8 % (melhor caso) | — | **23,1 %** (130 frases; opções descritivas completas) |

- **Funciona no navegador e é fiel**: as probabilidades batem com as do ONNX Runtime em Python (ex.: `run-action` 0,387 vs 0,396 para a mesma entrada); o tokenizador dá os mesmos ids do `tokenizers` (57 casos, teste automático).
- **Sem isolamento de origem não há threads**: 7 s por frase. O servidor que hospeda o app precisa enviar `Cross-Origin-Opener-Policy: same-origin` e `Cross-Origin-Embedder-Policy: require-corp` (o `tools/spike-laya/serve_isolated.py` mostra como). Mesmo com threads o WASM é ~3x mais lento que o nativo.
- **Latência ainda alta para voz** (2–3 s depois da transcrição) e **acerto baixo**: a conclusão do spike não muda (as regras seguem como base; o modelo só poderia *sugerir*). A medição de F0b serve de linha de base para trocar de modelo: `ChoiceBackend` (`voice/interpreters/model/choice_backend.js`) é o único ponto de troca.

## F0c — o mesmo modelo no servidor (2026-11-21)

`server/agora-model` (Python + onnxruntime, CPU 6 threads) atrás do `agora-sync`, chamado pelo `RemoteChoiceBackend` do app: ~0,6–0,7 s por frase de ponta a ponta
(modelo 600–710 ms; `agora-sync` + rede local somam ~50 ms), contra 2,1–2,8 s no navegador com threads e ~7 s sem. As probabilidades são as mesmas do navegador
(`adiciona uma tabela` → `run-action` 0,40 nos dois) e a entrada do modelo é idêntica byte a byte (teste de paridade). **O acerto não muda** (mesmo modelo): mover para o servidor
resolve latência e alcance de aparelhos, não a qualidade. Uma GPU (`onnxruntime-gpu`, `docker-compose.gpu.yml`) ainda não foi medida.
