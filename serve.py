# Local server that tells the browser not to cache anything,
# so every reload always uses the latest version of the files.
import http.server
import re
import sys
from pathlib import Path

BAKED = Path(__file__).parent / "rl" / "tracks"


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # rl/bake.html saves each track's mask here, to build the track in Node when training the AI
    def do_PUT(self):
        m = re.fullmatch(r"/rl/tracks/([a-z0-9-]+)\.mask", self.path)
        if not m:
            self.send_error(403)
            return
        BAKED.mkdir(parents=True, exist_ok=True)
        (BAKED / f"{m[1]}.mask").write_bytes(self.rfile.read(int(self.headers["Content-Length"])))
        self.send_response(204)
        self.end_headers()


# the menu requests the layouts of all tracks at once: with the default connection queue (5), macOS drops the ones
# that don't fit
http.server.ThreadingHTTPServer.request_queue_size = 64

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
print(f"Fórmula ½ at http://localhost:{port}")
http.server.ThreadingHTTPServer(("", port), NoCacheHandler).serve_forever()
