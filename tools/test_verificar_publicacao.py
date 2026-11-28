#!/usr/bin/env python3
"""O verificador de publicação precisa PEGAR o que quebraria no GitHub Pages (um verificador que sempre passa é pior que nenhum)."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "verificar_publicacao.py"
FLUXO_OK = "          cp -r index.html app.html hospedar.html comandos.html sw.js precache.json site core collaboration conference transcription recording voice components ui vendor adapters _site/\n"


def rodar(arquivos: dict):
    with tempfile.TemporaryDirectory() as tmp:
        for caminho, conteudo in arquivos.items():
            alvo = Path(tmp) / caminho
            alvo.parent.mkdir(parents=True, exist_ok=True)
            alvo.write_text(conteudo)
        return subprocess.run([sys.executable, str(SCRIPT)], env={**os.environ, "AGORA_RAIZ": tmp}, capture_output=True, text=True)


class Publicacao(unittest.TestCase):
    def test_tudo_publicado_passa(self):
        r = rodar({"core/a.js": "import { b } from '../voice/b.js';", "voice/b.js": "export const b = 1;", ".github/workflows/pages.yml": FLUXO_OK})
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_importar_pasta_nao_publicada_falha(self):
        r = rodar({"collaboration/p.js": "import { R } from '../extra/r.js';", "extra/r.js": "export const R = 1;"})
        self.assertEqual(r.returncode, 1)
        self.assertIn("extra/", r.stderr)

    def test_import_dinamico_tambem_conta(self):
        self.assertEqual(rodar({"ui/x.js": "const m = await import('../extra/r.js');", "extra/r.js": "export const R = 1;"}).returncode, 1)

    def test_workflow_que_esquece_uma_pasta_falha(self):
        r = rodar({".github/workflows/pages.yml": FLUXO_OK.replace(" voice", "")})
        self.assertEqual(r.returncode, 1)
        self.assertIn("'voice'", r.stderr)

    def test_workflow_que_esquece_a_pagina_nova_falha(self):
        self.assertEqual(rodar({".github/workflows/pages.yml": FLUXO_OK.replace(" comandos.html", "")}).returncode, 1)

    def test_importar_arquivo_inexistente_ou_de_fora_do_repositorio_nao_conta(self):
        self.assertEqual(rodar({"core/a.js": "import x from '../../fora/x.js'; import y from './nada.js';"}).returncode, 0)


if __name__ == "__main__":
    unittest.main()
