# agora-model

Serviço do **modelo de decisão de comandos**: dada uma frase ("põe as notas embaixo") e uma lista de opções (os comandos do workspace),
diz qual opção a frase quer dizer. Existe porque o modelo no navegador (`voice/interpreters/model/laya/`) leva 2–3 s por frase e **não roda
em todo aparelho**; aqui roda no servidor (~0,7 s em CPU, bem menos com GPU) e o navegador só pergunta.
Decisão: D-44 (`docs/especificacao/12-decisoes-em-aberto.md`).

```
navegador ──(token)──> agora-sync  POST /v1/workspaces/:id/decide ──> agora-model  POST /choose
                       autentica, limita, não guarda o texto           backend laya | openai_compat
```

Quem fala com este serviço é o `agora-sync`; o navegador nunca. Contrato (o que **qualquer** serviço precisa falar para o `AGORA_MODEL_URL` apontar para ele):

```
POST /choose   {"question"?: "...", "options": [{"id": "add", "text": "add: adicionar janela"}, ...], "state": "<a frase>"}
            -> {"scores": [{"id": "add", "p": 0.82}, ...], "ms": 640.2, "model": "laya-en-int4@cpu"}     (uma p por opção, soma ≈ 1)
GET  /health -> {"ok": true, "model": "..."}
```

## Rodar

```
tools/baixar_modelo_laya.py                       # pesos (262 MB) em models/laya-en-int4/, fora do git
pip install -r server/agora-model/requirements.txt
cd server/agora-model && python3 app.py           # 127.0.0.1:8790
```

Com Docker (a partir da raiz): `tools/baixar_modelo_laya.py && AGORA_MODEL_URL=http://model:8790 docker compose --profile model up -d --build`
e abra o app com `?sync=…&model=remote` (ou `model=auto`: servidor, depois o navegador). **GPU NVIDIA:** acrescente `-f docker-compose.gpu.yml`
(usa `onnxruntime-gpu`; precisa do NVIDIA Container Toolkit). Se a GPU não for achada, o ONNX Runtime cai para CPU e o `id` do modelo mostra
qual rodou (`laya-en-int4@cuda` ou `@cpu`).

## Apontar para outro lugar (`MODEL_BACKEND=openai_compat`)

Em vez do Laya, um LLM por trás de qualquer API compatível com OpenAI (`/v1/chat/completions`): o gateway do **inteligencia-aberta**, um
vLLM/llama.cpp, ou uma API externa. A chamada é servidor → servidor: a chave nunca vai ao navegador.

| Variável | Significado |
|---|---|
| `MODEL_BACKEND` | `laya` (padrão) ou `openai_compat` |
| `AGORA_LLM_URL` | o endpoint completo, ex. `http://inteligencia-aberta:8000/v1/chat/completions` |
| `AGORA_LLM_MODEL` / `AGORA_LLM_KEY` | modelo (ex. `qwen2.5:3b`) e chave (no gateway do inteligencia-aberta, o `LLM_GATEWAY_TOKEN`) |
| `AGORA_LLM_CONFIDENCE` | confiança dada à escolhida quando a API não devolve probabilidades (padrão 0,8). O app trata como **sugestão**: abaixo do limiar dele, pergunta "Quis dizer…?" |
| `AGORA_LLM_TIMEOUT` | segundos (padrão 30) |

O gateway do inteligencia-aberta só escuta em VPN/LAN e usa um token único do cluster: o `agora-model` precisa alcançá-lo por essa rede.
Outro modelo = uma classe com `load()`/`choose()` em `backends/` e uma linha em `backends/__init__.py::criar`.

## Outras variáveis

| Variável | Significado |
|---|---|
| `PORT` / `BIND_ADDR` | `8790` / `127.0.0.1` (a imagem usa `0.0.0.0`) |
| `AGORA_MODEL_TOKEN` | (opcional) exige `Authorization: Bearer …` em `/choose`; use se mais alguém alcança a porta (o mesmo valor vai no `agora-sync`) |
| `LAYA_DIR` / `LAYA_ONNX` | pasta e arquivo do modelo (padrão `models/laya-en-int4` / `model_int4.onnx`) |
| `ONNX_PROVIDERS` / `ONNX_THREADS` | provedores de execução (padrão `CPUExecutionProvider`) / threads |

## Privacidade

A frase é fala transcrita. Este serviço **não a guarda nem a registra** (o log tem só número de opções e tempo; os testes garantem). O
`agora-sync` faz o mesmo. Se você apontar para uma API externa, a frase vai para ela: é uma escolha sua, como operador.

## Testes

`python3 -m unittest discover -s server/agora-model/tests` (precisa de `onnxruntime`, `tokenizers`, `numpy` e dos pesos só para a paridade
com o navegador; sem eles esses testes são pulados). `tests/fixtures/laya_input_cases.json` foi gerado pelo JS: garante que a entrada do modelo
é idêntica nos dois lugares.
