#!/usr/bin/env python3
"""agora-model: serviço do modelo de decisão de comandos (qual das opções a frase quer dizer?).

    POST /choose  {question?, options:[{id,text}], state} -> {scores:[{id,p}], ms, model}
    GET  /health  -> {ok, model}

Quem chama é o agora-sync (que autentica a pessoa e limita); este serviço só precisa de AGORA_MODEL_TOKEN se estiver numa rede onde mais
alguém alcança a porta. PRIVACIDADE: a frase (state) é fala transcrita: nunca é gravada nem registrada em log (só contagem e tempo).
Backends: MODEL_BACKEND=laya (padrão; CPU/GPU) ou openai_compat (outro lugar: inteligencia-aberta, vLLM, API externa). Ver README.md.
"""
import hmac
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from backends import criar

LIMITE_CORPO = 16 * 1024
PERGUNTA = "Qual comando o usuário deu ao workspace?"


class Invalido(ValueError):
    pass


def validar(corpo) -> tuple[str, list[dict], str]:
    if not isinstance(corpo, dict) or not isinstance(corpo.get("state"), str) or not corpo["state"].strip():
        raise Invalido("falta a frase (state)")
    opcoes = corpo.get("options")
    if not isinstance(opcoes, list) or not 2 <= len(opcoes) <= 40:
        raise Invalido("envie de 2 a 40 opções")
    vistos = set()
    for o in opcoes:
        if not isinstance(o, dict) or not isinstance(o.get("id"), str) or not isinstance(o.get("text"), str) or not o["id"] or not o["text"]:
            raise Invalido("opção inválida (id e text)")
        if o["id"] in vistos:
            raise Invalido(f"opção repetida: {o['id']}")
        vistos.add(o["id"])
    pergunta = corpo.get("question")
    return (pergunta if isinstance(pergunta, str) and pergunta else PERGUNTA), [{"id": o["id"], "text": o["text"]} for o in opcoes], corpo["state"]


def criar_servidor(backend, host="127.0.0.1", port=8790, token=None, log=print):
    pronto = threading.Event()
    pronto.set()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):            # nunca o conteúdo: o log do http.server mostraria a linha do pedido
            pass

        def _json(self, status, corpo):
            dados = json.dumps(corpo).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(dados)))
            self.end_headers()
            self.wfile.write(dados)

        def _autorizado(self):
            return not token or hmac.compare_digest(self.headers.get("authorization", ""), f"Bearer {token}")

        def do_GET(self):
            if self.path == "/health":
                return self._json(200, {"ok": True, "model": backend.id})
            self._json(404, {"error": "rota desconhecida"})

        def do_POST(self):
            if self.path != "/choose":
                return self._json(404, {"error": "rota desconhecida"})
            if not self._autorizado():
                return self._json(401, {"error": "não autorizado"})
            tamanho = int(self.headers.get("content-length") or 0)
            if tamanho > LIMITE_CORPO:
                return self._json(413, {"error": "pedido grande demais"})
            try:
                pergunta, opcoes, estado = validar(json.loads(self.rfile.read(tamanho) or b"{}"))
            except (Invalido, json.JSONDecodeError) as erro:
                return self._json(400, {"error": f"pedido inválido: {erro}"})
            inicio = time.perf_counter()
            try:
                p = backend.choose(pergunta, opcoes, estado)
            except Exception as erro:             # o texto do erro pode citar a frase: só o tipo vai ao log
                log(f"choose falhou: {type(erro).__name__}")
                return self._json(502, {"error": "o modelo falhou"})
            ms = (time.perf_counter() - inicio) * 1000
            log(f"choose: {len(opcoes)} opções, {ms:.0f} ms")
            self._json(200, {"scores": [{"id": o["id"], "p": x} for o, x in zip(opcoes, p)], "ms": round(ms, 1), "model": backend.id})

    return ThreadingHTTPServer((host, port), Handler)


def main() -> int:
    backend = criar()
    print(f"[agora-model] carregando {os.environ.get('MODEL_BACKEND', 'laya')} ...", flush=True)
    inicio = time.perf_counter()
    backend.load()
    print(f"[agora-model] pronto: {backend.id} ({time.perf_counter() - inicio:.1f} s)", flush=True)
    servidor = criar_servidor(backend, os.environ.get("BIND_ADDR", "127.0.0.1"), int(os.environ.get("PORT", "8790")),
                              os.environ.get("AGORA_MODEL_TOKEN") or None, log=lambda m: print(f"[agora-model] {m}", flush=True))
    print(f"[agora-model] ouvindo em {servidor.server_address[0]}:{servidor.server_address[1]}", flush=True)
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
