"""Backends do modelo de decisão. Contrato (o único ponto de troca no servidor):

    class Backend:
        id: str                                  # nome do modelo, devolvido em /choose e /health
        def load(self) -> None                   # carrega pesos/abre conexões; chamado uma vez na subida
        def choose(self, question, options, state) -> list[float]
            # options: [{"id", "text"}]; state: a frase. Devolve uma probabilidade por opção (mesma ordem; soma ~1).

O serviço (app.py) cuida de HTTP, validação, autenticação e medição de tempo; o backend só pontua opções para uma frase.
Para um modelo novo: uma classe com esse contrato e uma linha em `criar()`.
"""
import os


def criar(nome: str | None = None, ambiente=os.environ):
    nome = nome or ambiente.get("MODEL_BACKEND", "laya")
    if nome == "laya":
        from .laya import LayaBackend
        return LayaBackend(
            pasta=ambiente.get("LAYA_DIR", "models/laya-en-int4"),
            onnx=ambiente.get("LAYA_ONNX", "model_int4.onnx"),
            providers=[p for p in ambiente.get("ONNX_PROVIDERS", "CPUExecutionProvider").split(",") if p],
            threads=int(ambiente.get("ONNX_THREADS", "0")) or None,
        )
    if nome == "openai_compat":
        from .openai_compat import OpenAICompatBackend
        return OpenAICompatBackend(
            url=ambiente["AGORA_LLM_URL"], modelo=ambiente.get("AGORA_LLM_MODEL", ""), chave=ambiente.get("AGORA_LLM_KEY") or None,
            timeout=float(ambiente.get("AGORA_LLM_TIMEOUT", "30")), confianca=float(ambiente.get("AGORA_LLM_CONFIDENCE", "0.8")),
        )
    raise ValueError(f"MODEL_BACKEND desconhecido: {nome!r} (use laya ou openai_compat)")
