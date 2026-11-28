#!/usr/bin/env python3
"""Verificação de publicação: o que o navegador importa tem de estar no que é publicado (GitHub Pages) e no cache offline.

Falha (exit 1) se:
  1. algum módulo do app importa (import estático ou dinâmico) um arquivo de uma pasta que não está em PASTAS do precache
     (o app funcionaria no Docker, que monta o repositório inteiro, e quebraria offline e no Pages);
  2. o workflow .github/workflows/pages.yml não copia alguma pasta de PASTAS, alguma página de EXTRAS ou sw.js/precache.json.

Nasceu de um defeito real: `voice/` e `recording/` eram importadas pelo app e não eram publicadas, e nenhum teste via isso.
"""
import os
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True                  # importa gerar_precache sem deixar __pycache__ no repositório
RAIZ = Path(os.environ.get("AGORA_RAIZ") or Path(__file__).resolve().parent.parent)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from gerar_precache import PASTAS, PASTAS_EXCLUIDAS  # noqa: E402

PAGINAS = ["index.html", "app.html", "hospedar.html", "comandos.html"]
RAIZ_PUBLICA = {"sw.js", "precache.json", *PAGINAS}
IMPORTACAO = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}/[^'"]+)['"]""")


def importacoes_fora(raiz: Path):
    achados = []
    for pasta in PASTAS:
        base = raiz / pasta
        if not base.is_dir():
            continue
        for arquivo in sorted(base.rglob("*.js")) + sorted(base.rglob("*.mjs")):
            rel = arquivo.relative_to(raiz)
            if PASTAS_EXCLUIDAS & set(rel.parts):
                continue
            for destino in IMPORTACAO.findall(arquivo.read_text(encoding="utf-8")):
                alvo = (arquivo.parent / destino).resolve()
                try:
                    topo = alvo.relative_to(raiz.resolve()).parts[0]
                except ValueError:
                    continue
                if alvo.exists() and topo not in PASTAS and topo not in RAIZ_PUBLICA:
                    achados.append(f"{rel.as_posix()} importa {destino} (pasta '{topo}/' fora do precache e da publicação)")
    for pagina in PAGINAS:
        arquivo = raiz / pagina
        if arquivo.exists():
            for destino in IMPORTACAO.findall(arquivo.read_text(encoding="utf-8")):
                alvo = (arquivo.parent / destino).resolve()
                topo = alvo.relative_to(raiz.resolve()).parts[0] if alvo.exists() else None
                if topo and topo not in PASTAS and topo not in RAIZ_PUBLICA:
                    achados.append(f"{pagina} importa {destino} (pasta '{topo}/' fora do precache e da publicação)")
    return achados


def copiado_pelo_workflow(raiz: Path):
    fluxo = raiz / ".github" / "workflows" / "pages.yml"
    if not fluxo.exists():
        return []
    copiados = set()
    for linha in fluxo.read_text(encoding="utf-8").splitlines():
        m = re.match(r"\s*cp\s+-r\s+(.+?)\s+_site/?\s*$", linha)
        if m:
            copiados |= set(m.group(1).split())
    faltam = sorted((set(PASTAS) | RAIZ_PUBLICA) - copiados)
    return [f"pages.yml não copia '{nome}' para o site publicado" for nome in faltam]


def main() -> int:
    problemas = importacoes_fora(RAIZ) + copiado_pelo_workflow(RAIZ)
    if problemas:
        print("Publicação incompleta:\n  " + "\n  ".join(problemas), file=sys.stderr)
        return 1
    print("publicação ok: tudo o que o app importa é publicado e entra no cache offline")
    return 0


if __name__ == "__main__":
    sys.exit(main())
