#!/usr/bin/env python3
"""Static server for the repo root WITH cross-origin isolation headers (COOP/COEP), which WebAssembly threads need.
`python3 -m http.server` does not send them, so ONNX Runtime Web falls back to ONE thread (about 15x slower for Laya).
Usage: tools/spike-laya/serve_isolated.py [port]      The same two headers must be sent by whatever hosts the app for threads to work there."""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    raiz = Path(__file__).resolve().parent.parent.parent
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8794), partial(Handler, directory=str(raiz))).serve_forever()
