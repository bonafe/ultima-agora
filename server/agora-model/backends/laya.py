"""Laya (ModernBERT, ONNX) no servidor: CPU, ou GPU com ONNX_PROVIDERS=CUDAExecutionProvider,CPUExecutionProvider (pacote onnxruntime-gpu).

Mesma montagem de entrada e mesma temperatura que o navegador (voice/interpreters/model/laya/laya_input.js): o mesmo modelo dá as
mesmas probabilidades nos dois lugares. Pesos: tools/baixar_modelo_laya.py (models/laya-en-int4/)."""
import json
import math
import threading
from pathlib import Path


def temperatura(config: dict, n: int) -> float:
    balde = "choice:2" if n <= 2 else "choice:3-5" if n <= 5 else "choice:6-10" if n <= 10 else "choice:11+"
    ajustada = (config.get("temperature_by_options") or {}).get(balde) or (config.get("temperature") or [1])[0]
    return min(5.0, max(0.5, ajustada))


def montar_entrada(codificar, especiais: dict, config: dict, pergunta: str, opcoes: list[str], estado: str):
    """[CLS] choice question: <pergunta> [SEP] [MASK] op0 [MASK] op1 ... [SEP] <estado> [SEP]  (laya.common.build_sequence)"""
    ids = [[especiais["mask"], *codificar(" " + texto)[:48]] for texto in opcoes]
    orcamento = config["head_max_len"] - sum(len(i) for i in ids)
    if orcamento < 16:
        cada = max(4, (config["head_max_len"] - 16) // len(ids))
        ids = [i[:cada] for i in ids]
        orcamento = config["head_max_len"] - sum(len(i) for i in ids)
    cabeca = codificar(f"choice question: {pergunta}")[: max(8, orcamento)]
    sequencia = [especiais["cls"], *cabeca, especiais["sep"]]
    marcadores = []
    for i in ids:
        marcadores.append(len(sequencia))
        sequencia += i
    sequencia.append(especiais["sep"])
    sequencia += codificar(estado)[: max(0, config["max_len"] - len(sequencia) - 1)]
    sequencia.append(especiais["sep"])
    return sequencia, marcadores


def softmax(logits, temperatura: float) -> list[float]:
    z = [x / temperatura for x in logits]
    topo = max(z)
    e = [math.exp(x - topo) for x in z]
    soma = sum(e)
    return [x / soma for x in e]


class LayaBackend:
    def __init__(self, pasta="models/laya-en-int4", onnx="model_int4.onnx", providers=("CPUExecutionProvider",), threads=None):
        self.pasta, self.onnx, self.providers, self.threads = Path(pasta), onnx, list(providers), threads
        self.id = f"laya-{self.pasta.name.removeprefix('laya-')}"
        self._lock = threading.Lock()          # uma passada por vez: em paralelo só atrapalhariam uma à outra

    def load(self) -> None:
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer
        self._np = np
        self.tokenizer = Tokenizer.from_file(str(self.pasta / "tokenizer.json"))
        cfg = json.loads((self.pasta / "tokenizer_config.json").read_text())
        self.especiais = {k: self.tokenizer.token_to_id(cfg[f"{k}_token"]) for k in ("cls", "sep", "mask")}
        self.config = json.loads((self.pasta / "rl_agent_config.json").read_text())
        opcoes = ort.SessionOptions()
        if self.threads:
            opcoes.intra_op_num_threads = self.threads
        self.sessao = ort.InferenceSession(str(self.pasta / self.onnx), opcoes, providers=self.providers)
        self.id = f"{self.id}@{self.sessao.get_providers()[0].removesuffix('ExecutionProvider').lower()}"

    def _codificar(self, texto):
        return self.tokenizer.encode(texto, add_special_tokens=False).ids

    def choose(self, question, options, state):
        np = self._np
        sequencia, marcadores = montar_entrada(self._codificar, self.especiais, self.config, question, [o["text"] for o in options], state)
        feed = {
            "input_ids": np.array([sequencia], dtype=np.int64), "attention_mask": np.ones((1, len(sequencia)), dtype=np.int64),
            "marker_pos": np.array([marcadores], dtype=np.int64), "marker_mask": np.ones((1, len(marcadores)), dtype=bool),
            "qtype": np.array([0], dtype=np.int64),
        }
        with self._lock:
            logits = self.sessao.run(["logits"], feed)[0][0]
        return softmax([float(x) for x in logits], temperatura(self.config, len(options)))
