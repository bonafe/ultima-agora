#!/usr/bin/env python3
"""Baixa o Laya (modelo de decisão, ONNX int4) para models/laya-en-int4/, de onde o navegador o lê (voice/interpreters/model/laya).

Os pesos (262 MB) ficam fora do git (models/ é ignorado). Registra o sha256 de cada arquivo em SHA256SUMS.
Origem: https://huggingface.co/techtheist/laya-onnx (exportação não oficial do Laya, Convai Innovations, Apache-2.0).

Uso: tools/baixar_modelo_laya.py
"""
import hashlib
import sys
import urllib.request
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
REPO = "https://huggingface.co/techtheist/laya-onnx/resolve/main/en/{nome}"
ARQUIVOS = ["rl_agent_config.json", "tokenizer.json", "tokenizer_config.json", "model_int4.onnx"]


def baixar(url: str, destino: Path) -> str:
    parcial = destino.with_suffix(destino.suffix + ".part")
    sha = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=60) as resposta, open(parcial, "wb") as saida:
        while bloco := resposta.read(1 << 20):
            saida.write(bloco)
            sha.update(bloco)
    parcial.replace(destino)
    return sha.hexdigest()


def main() -> int:
    pasta = RAIZ / "models" / "laya-en-int4"
    pasta.mkdir(parents=True, exist_ok=True)
    soma = pasta / "SHA256SUMS"
    conhecidos = dict(l.split("  ", 1)[::-1] for l in soma.read_text().splitlines()) if soma.exists() else {}
    for nome in ARQUIVOS:
        destino = pasta / nome
        if destino.exists() and nome in conhecidos:
            print(f"ok      {nome}")
            continue
        print(f"baixando {nome} ...", flush=True)
        conhecidos[nome] = baixar(REPO.format(nome=nome), destino)
    soma.write_text("".join(f"{sha}  {nome}\n" for nome, sha in sorted(conhecidos.items())))
    print(f"pronto: {pasta}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
