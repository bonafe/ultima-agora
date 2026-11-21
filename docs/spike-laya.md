# Spike F0 — modelo de decisão (Laya) para comandos de voz

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
