"""Run an isolated viewer for browser checks, without opening a window."""
import sys
from pathlib import Path
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app

root = Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=True)
app.PROJECT = root / "project.json"
app.VIDEOS = root / "videos"
app.EXPORTS = root / "exports"
app.VIDEOS.mkdir(exist_ok=True)
server = ThreadingHTTPServer(("127.0.0.1", int(sys.argv[2])), app.Handler)
print("ready", flush=True)
server.serve_forever()
