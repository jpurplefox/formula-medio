# Servidor local que le pide al navegador no cachear nada,
# así cada recarga usa siempre la última versión de los archivos.
import http.server
import re
import sys
from pathlib import Path

BAKED = Path(__file__).parent / "rl" / "tracks"


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # rl/bake.html guarda acá la máscara de cada circuito, para armarlo en Node al entrenar la IA
    def do_PUT(self):
        m = re.fullmatch(r"/rl/tracks/([a-z0-9-]+)\.mask", self.path)
        if not m:
            self.send_error(403)
            return
        BAKED.mkdir(parents=True, exist_ok=True)
        (BAKED / f"{m[1]}.mask").write_bytes(self.rfile.read(int(self.headers["Content-Length"])))
        self.send_response(204)
        self.end_headers()


# el menú pide los trazados de todos los circuitos a la vez: con la cola de conexiones de siempre (5), macOS corta
# las que no entran
http.server.ThreadingHTTPServer.request_queue_size = 64

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
print(f"Raycast Racer en http://localhost:{port}")
http.server.ThreadingHTTPServer(("", port), NoCacheHandler).serve_forever()
