#!/usr/bin/env python3
"""Baixa um modelo Whisper (ONNX quantizado, formato do transformers.js) para models/whisper-<tamanho>/.

Os pesos ficam fora do git (models/ é ignorado). O app os serve da própria origem, então a transcrição funciona sem
internet depois de baixados (D-37). Registra o sha256 de cada arquivo em SHA256SUMS e confere no próximo download.

Uso: tools/baixar_modelo_whisper.py [tiny|base|small]      (padrão: base)
"""
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
REPO = "https://huggingface.co/onnx-community/whisper-{size}/resolve/main/{path}"
ARQUIVOS = [
    "config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json",
    "normalizer.json", "added_tokens.json", "special_tokens_map.json", "merges.txt", "vocab.json",
    "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx",
]


def baixar(url: str, destino: Path) -> str:
    destino.parent.mkdir(parents=True, exist_ok=True)
    sha = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=60) as resposta, open(destino.with_suffix(destino.suffix + ".part"), "wb") as saida:
        while bloco := resposta.read(1 << 20):
            saida.write(bloco)
            sha.update(bloco)
    destino.with_suffix(destino.suffix + ".part").replace(destino)
    return sha.hexdigest()


def main() -> int:
    tamanho = sys.argv[1] if len(sys.argv) > 1 else "base"
    if tamanho not in ("tiny", "base", "small"):
        print("tamanho deve ser tiny, base ou small", file=sys.stderr)
        return 2
    pasta = RAIZ / "models" / f"whisper-{tamanho}"
    soma = pasta / "SHA256SUMS"
    conhecidos = dict(l.split("  ", 1)[::-1] for l in soma.read_text().splitlines()) if soma.exists() else {}
    for caminho in ARQUIVOS:
        destino = pasta / caminho
        if destino.exists() and caminho in conhecidos:
            print(f"ok      {caminho}")
            continue
        print(f"baixando {caminho} ...", flush=True)
        conhecidos[caminho] = baixar(REPO.format(size=tamanho, path=caminho), destino)
    soma.write_text("".join(f"{sha}  {caminho}\n" for caminho, sha in sorted(conhecidos.items())))
    (pasta / "model.json").write_text(json.dumps({"size": tamanho, "dtype": "q8", "files": sorted(conhecidos)}, indent=1))
    total = sum((pasta / c).stat().st_size for c in ARQUIVOS) / 1e6
    print(f"pronto: {pasta.relative_to(RAIZ)} ({total:.0f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
