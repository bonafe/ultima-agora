#!/usr/bin/env python3
"""O verificador de acoplamento precisa PEGAR as violações (um verificador que sempre passa é pior que nenhum)."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "verificar_acoplamento.py"


def rodar(arquivos: dict):
    with tempfile.TemporaryDirectory() as tmp:
        for caminho, conteudo in arquivos.items():
            alvo = Path(tmp) / caminho
            alvo.parent.mkdir(parents=True, exist_ok=True)
            alvo.write_text(conteudo)
        return subprocess.run([sys.executable, str(SCRIPT)], env={**os.environ, "AGORA_RAIZ": tmp}, capture_output=True, text=True)


class Acoplamento(unittest.TestCase):
    def test_limpo_passa(self):
        r = rodar({"core/a.js": "export const x = 1;", "collaboration/providers/p.js": "import { Y } from '../../vendor/yjs/yjs.js';"})
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_yjs_em_componente_falha(self):
        r = rodar({"components/notes/n.js": "import * as Y from '../../vendor/yjs/yjs.js';"})
        self.assertEqual(r.returncode, 1)
        self.assertIn("components/notes/n.js", r.stderr)

    def test_yjs_importado_por_npm_em_ui_falha(self):
        self.assertEqual(rodar({"ui/x.js": "import * as Y from 'yjs';"}).returncode, 1)
        self.assertEqual(rodar({"core/x.js": "const m = await import('y-protocols/sync');"}).returncode, 1)

    def test_livekit_fora_dos_providers_falha(self):
        self.assertEqual(rodar({"core/c.js": "import { Room } from 'livekit-client';"}).returncode, 1)

    def test_termo_de_dominio_no_nucleo_falha(self):
        r = rodar({"core/workspace/w.js": "class Entity {}"})
        self.assertEqual(r.returncode, 1)
        self.assertIn("Entity", r.stderr)
        self.assertEqual(rodar({"ui/y.js": "const claim = new Claim();"}).returncode, 1)

    def test_comentario_e_texto_nao_contam(self):
        r = rodar({"core/doc.js": "// the domain defines Entity and Claim, not the core\n/* Evidence */\nconst label = 'Empresa';"})
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_vendor_pode_ter_yjs(self):
        self.assertEqual(rodar({"vendor/yjs/yjs.js": "import 'yjs';"}).returncode, 0)


if __name__ == "__main__":
    unittest.main()
