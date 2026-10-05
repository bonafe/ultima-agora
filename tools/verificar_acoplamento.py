#!/usr/bin/env python3
"""Verificação de acoplamento (critério de aceite 21 e princípios 46/57 da especificação).

Falha (exit 1) se o código do núcleo violar a separação de camadas:

  1. Yjs, y-protocols, lib0 ou LiveKit só podem ser importados por collaboration/ (providers, document, presence)
     e por vendor/ (o próprio bundle). Componentes, UI, core e adaptadores NÃO os importam: trocar a biblioteca
     de CRDT tem de ser uma mudança em um lugar só.
  2. Termos de domínio (Entity, Claim, Evidence, Provenance, Artifact, Organização...) não aparecem no código
     do núcleo. O Agora é genérico; o domínio é de quem o instala (o pacote ia-* vive no repositório do IA).

Comentários e strings de teste não contam: o que conta é código (import e identificadores).
"""
import os
import re
import sys
from pathlib import Path

RAIZ = Path(os.environ.get("AGORA_RAIZ") or Path(__file__).resolve().parent.parent)
NUCLEO = ["core", "collaboration", "ui", "components", "adapters"]
PODEM_IMPORTAR_CRDT = ("collaboration/", "vendor/")
IMPORT_PROIBIDO = re.compile(r"""(?:from|import)\s*\(?\s*['"][^'"]*(?:\byjs\b|y-protocols|lib0|livekit)[^'"]*['"]""", re.I)
TERMOS_DOMINIO = re.compile(r"\b(Entity|Entities|Claim|Evidence|Provenance|Artifact|Organization|Organizacao|Empresa|Pessoa)\b")


def codigo_sem_comentarios(texto: str) -> str:
    texto = re.sub(r"/\*.*?\*/", "", texto, flags=re.S)
    return "\n".join(re.sub(r"(?<![:'\"`])//.*$", "", linha) for linha in texto.splitlines())


def main() -> int:
    problemas = []
    for pasta in NUCLEO:
        for arquivo in sorted((RAIZ / pasta).rglob("*.js")):
            rel = arquivo.relative_to(RAIZ).as_posix()
            codigo = codigo_sem_comentarios(arquivo.read_text(encoding="utf-8"))
            if not rel.startswith(PODEM_IMPORTAR_CRDT) and IMPORT_PROIBIDO.search(codigo):
                problemas.append(f"{rel}: importa Yjs/LiveKit fora de collaboration/ (use o StateStore/provider)")
            achados = sorted(set(TERMOS_DOMINIO.findall(re.sub(r"(['\"`]).*?\1", "", codigo))))
            if achados:
                problemas.append(f"{rel}: termo(s) de domínio no núcleo: {', '.join(achados)}")
    if problemas:
        print("Acoplamento indevido:\n  " + "\n  ".join(problemas), file=sys.stderr)
        return 1
    print("acoplamento ok: sem Yjs/LiveKit fora de collaboration/, sem termos de domínio no núcleo")
    return 0


if __name__ == "__main__":
    sys.exit(main())
