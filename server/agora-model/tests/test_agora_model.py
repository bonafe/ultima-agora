#!/usr/bin/env python3
"""Testes do agora-model: contrato HTTP (/choose, /health), backend openai_compat contra um servidor falso e, se o modelo estiver
instalado, a paridade do Laya com o navegador. Rodar: python3 -m unittest discover -s server/agora-model/tests"""
import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI.parent))
import app  # noqa: E402
from backends import criar, laya, openai_compat  # noqa: E402

RAIZ = AQUI.parent.parent.parent
OPCOES = [{"id": "add", "text": "add: adicionar"}, {"id": "undo", "text": "undo: desfazer"}, {"id": "none", "text": "none: conversa"}]


class Falso:
    id = "falso-1"

    def __init__(self, vencedor="add", erro=None):
        self.vencedor, self.erro, self.visto = vencedor, erro, []

    def load(self): pass

    def choose(self, question, options, state):
        self.visto.append((question, options, state))
        if self.erro:
            raise self.erro
        return [0.8 if o["id"] == self.vencedor else 0.1 for o in options]


def servir(handler_class_or_server):
    servidor = handler_class_or_server
    threading.Thread(target=servidor.serve_forever, daemon=True).start()
    return servidor


def pedir(servidor, caminho, corpo=None, cabecalhos=None):
    url = f"http://127.0.0.1:{servidor.server_address[1]}{caminho}"
    pedido = urllib.request.Request(url, json.dumps(corpo).encode() if corpo is not None else None, {"content-type": "application/json", **(cabecalhos or {})})
    try:
        with urllib.request.urlopen(pedido, timeout=5) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        with e:
            return e.code, json.loads(e.read() or b"{}")


class Contrato(unittest.TestCase):
    def iniciar(self, backend=None, token=None, log=None):
        servidor = servir(app.criar_servidor(backend or Falso(), port=0, token=token, log=log or (lambda m: None)))
        self.addCleanup(servidor.shutdown)
        self.addCleanup(servidor.server_close)
        return servidor

    def test_choose_devolve_uma_probabilidade_por_opcao_na_ordem_pedida(self):
        s = self.iniciar()
        status, r = pedir(s, "/choose", {"options": OPCOES, "state": "põe uma tabela"})
        self.assertEqual(status, 200)
        self.assertEqual([x["id"] for x in r["scores"]], ["add", "undo", "none"])
        self.assertEqual(r["model"], "falso-1")
        self.assertGreaterEqual(r["ms"], 0)
        self.assertEqual(pedir(s, "/health")[1], {"ok": True, "model": "falso-1"})

    def test_pergunta_padrao_e_pergunta_do_cliente(self):
        b = Falso()
        s = self.iniciar(b)
        pedir(s, "/choose", {"options": OPCOES, "state": "a"})
        pedir(s, "/choose", {"options": OPCOES, "state": "a", "question": "Outra?"})
        self.assertEqual([v[0] for v in b.visto], [app.PERGUNTA, "Outra?"])

    def test_recusa_o_que_nao_e_o_contrato(self):
        s = self.iniciar()
        for ruim in [{"options": OPCOES}, {"options": OPCOES, "state": " "}, {"options": OPCOES[:1], "state": "a"}, {"options": [OPCOES[0], OPCOES[0]], "state": "a"},
                     {"options": [{"id": "a"}, {"id": "b", "text": "b"}], "state": "a"}, {"options": OPCOES * 20, "state": "a"}]:
            self.assertEqual(pedir(s, "/choose", ruim)[0], 400, str(ruim)[:50])
        self.assertEqual(pedir(s, "/outra", {})[0], 404)

    def test_token_quando_configurado(self):
        s = self.iniciar(token="segredo")
        corpo = {"options": OPCOES, "state": "a"}
        self.assertEqual(pedir(s, "/choose", corpo)[0], 401)
        self.assertEqual(pedir(s, "/choose", corpo, {"authorization": "Bearer errado"})[0], 401)
        self.assertEqual(pedir(s, "/choose", corpo, {"authorization": "Bearer segredo"})[0], 200)

    def test_falha_do_modelo_vira_502_e_a_frase_nunca_vai_ao_log(self):
        linhas = []
        s = self.iniciar(Falso(erro=RuntimeError("falhou com frase-secreta")), log=linhas.append)
        self.assertEqual(pedir(s, "/choose", {"options": OPCOES, "state": "frase-secreta"})[0], 502)
        s2 = self.iniciar(Falso(), log=linhas.append)
        pedir(s2, "/choose", {"options": OPCOES, "state": "frase-secreta"})
        self.assertTrue(any("choose" in l for l in linhas))
        self.assertFalse(any("frase-secreta" in l for l in linhas), linhas)


class OpenAICompat(unittest.TestCase):
    def test_escolher_id(self):
        ids = ["add", "add-note", "undo", "none"]
        casos = [("undo", "undo"), ("  `Undo`.\n", "undo"), ("A opção é add-note.", "add-note"), ("acho que é undo, não add", "undo"),
                 ("add", "add"), ("nenhuma delas", None), ("", None), ("reundo", None)]
        for texto, esperado in casos:
            self.assertEqual(openai_compat.escolher_id(texto, ids), esperado, repr(texto))

    def test_pontuar(self):
        p = openai_compat.pontuar("b", ["a", "b", "c"], 0.8)
        self.assertAlmostEqual(sum(p), 1.0)
        self.assertEqual(max(range(3), key=p.__getitem__), 1)
        self.assertEqual(openai_compat.pontuar(None, ["a", "b"], 0.8), [0.5, 0.5], "sem resposta útil: ninguém ganha")

    def test_chama_a_api_com_chave_e_le_a_escolha(self):
        recebido = {}

        class Api(BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def do_POST(self):
                recebido["auth"] = self.headers.get("authorization")
                recebido["body"] = json.loads(self.rfile.read(int(self.headers["content-length"])))
                dados = json.dumps({"choices": [{"message": {"content": "undo"}}]}).encode()
                self.send_response(200); self.send_header("content-length", str(len(dados))); self.end_headers(); self.wfile.write(dados)

        api = servir(ThreadingHTTPServer(("127.0.0.1", 0), Api))
        self.addCleanup(api.shutdown); self.addCleanup(api.server_close)
        b = openai_compat.OpenAICompatBackend(f"http://127.0.0.1:{api.server_address[1]}/v1/chat/completions", modelo="qwen", chave="k1", confianca=0.7)
        p = b.choose("Qual?", OPCOES, "desfaz isso")
        self.assertEqual(max(range(3), key=p.__getitem__), 1)
        self.assertEqual(recebido["auth"], "Bearer k1")
        self.assertEqual(recebido["body"]["temperature"], 0)
        self.assertEqual(recebido["body"]["model"], "qwen")
        texto = recebido["body"]["messages"][-1]["content"]
        self.assertIn("desfaz isso", texto)
        self.assertTrue(all(o["id"] in texto for o in OPCOES))

    def test_criar_escolhe_o_backend_pelo_ambiente(self):
        b = criar("openai_compat", {"AGORA_LLM_URL": "http://x/v1/chat/completions", "AGORA_LLM_MODEL": "m"})
        self.assertEqual(b.id, "openai:m")
        self.assertIsInstance(criar("laya", {}), laya.LayaBackend)
        with self.assertRaises(ValueError):
            criar("inexistente", {})


MODELO = RAIZ / "models" / "laya-en-int4"


@unittest.skipUnless((MODELO / "model_int4.onnx").exists(), "modelo não instalado (tools/baixar_modelo_laya.py)")
class ParidadeComONavegador(unittest.TestCase):
    """A entrada do modelo montada aqui é idêntica à do navegador (laya_input.js): os ids vêm de tests/fixtures/laya_input_cases.json, gerado pelo JS."""

    @classmethod
    def setUpClass(cls):
        try:
            cls.backend = laya.LayaBackend(MODELO)
            cls.backend.load()
        except ImportError as e:
            raise unittest.SkipTest(f"dependência ausente: {e}")

    def test_mesma_sequencia_e_mesma_temperatura(self):
        casos = json.loads((AQUI / "fixtures" / "laya_input_cases.json").read_text())
        for c in casos:
            ids, marcadores = laya.montar_entrada(self.backend._codificar, self.backend.especiais, self.backend.config, c["question"], c["options"], c["state"])
            self.assertEqual(ids, c["inputIds"], c["state"][:30])
            self.assertEqual(marcadores, c["markerPos"])
            self.assertAlmostEqual(laya.temperatura(self.backend.config, len(c["options"])), c["temperature"], places=9)

    def test_escolhe_a_fruta(self):
        opcoes = [{"id": "car", "text": "a car"}, {"id": "apple", "text": "an apple"}, {"id": "house", "text": "a house"}]
        p = self.backend.choose("Which of these is a fruit?", opcoes, "I am hungry and want to eat something sweet")
        self.assertAlmostEqual(sum(p), 1.0, places=6)
        self.assertEqual(len(p), 3)


if __name__ == "__main__":
    unittest.main()
