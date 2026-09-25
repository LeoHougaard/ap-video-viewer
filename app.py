"""Local video playlist and export server. Run with `python app.py`."""

from __future__ import annotations

import hashlib
import json
import math
import mimetypes
import os
import re
import shutil
import subprocess
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlsplit
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parent
VIDEOS = ROOT / "videos"
EXPORTS = ROOT / "exports"
PROJECT = ROOT / "project.json"
EXTENSIONS = {".mp4", ".m4v", ".mov", ".webm", ".mkv"}
STATIC = {"/": "index.html", "/app.css": "app.css", "/app.js": "app.js"}
lock = threading.RLock()
export_status = {"state": "idle"}


def natural_key(value: str):
    return [(1, int(x)) if x.isdigit() else (0, x.casefold()) for x in re.split(r"(\d+)", value)]


def read_project():
    if PROJECT.exists():
        return json.loads(PROJECT.read_text(encoding="utf-8"))
    return {"source": "files", "folder": str(VIDEOS), "items": []}


def write_project(project):
    temporary = PROJECT.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(project, indent=2), encoding="utf-8")
    temporary.replace(PROJECT)


def scan_project():
    project = read_project()
    if project.get("source") == "ap":
        return None, [
            {
                "id": item["id"], "path": item["name"], "name": item["name"],
                "unit": item["unit"], "trim": item.get("trim", 0),
                "apUrl": item["apUrl"], "source": "ap", "browserPlayable": True,
            }
            for item in project.get("items", [])
        ]
    folder = Path(project["folder"]).expanduser().resolve()
    if not folder.is_dir():
        return folder, []
    previous = {item["path"]: item for item in project.get("items", [])}
    files = []
    for path in folder.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in EXTENSIONS:
            continue
        if not path.resolve().is_relative_to(folder):
            continue
        relative = path.relative_to(folder).as_posix()
        files.append(relative)
    files.sort(key=natural_key)
    order = {item["path"]: i for i, item in enumerate(project.get("items", []))}
    files.sort(key=lambda name: (0, order[name]) if name in order else (1, natural_key(name)))
    clips = []
    for relative in files:
        trim = previous.get(relative, {}).get("trim", 0)
        clip_id = hashlib.sha256(relative.encode("utf-8")).hexdigest()[:20]
        clips.append({
            "id": clip_id,
            "path": relative,
            "name": Path(relative).stem,
            "trim": trim,
            "url": f"/media/{clip_id}",
            "browserPlayable": Path(relative).suffix.lower() in {".mp4", ".m4v", ".webm"},
            "source": "files",
        })
    return folder, clips


def ffmpeg_tools():
    ffmpeg = os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg")
    ffprobe = os.environ.get("FFPROBE_PATH") or shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        raise RuntimeError("Export needs FFmpeg and FFprobe on PATH. Install FFmpeg, then restart the app.")
    return ffmpeg, ffprobe


def probe_video(ffprobe, path):
    result = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(result.stdout)
    streams = data.get("streams", [])
    if not any(stream.get("codec_type") == "video" for stream in streams):
        raise RuntimeError(f"No video track: {path.name}")
    duration = float(data.get("format", {}).get("duration", 0))
    if duration <= 0:
        raise RuntimeError(f"Could not read duration: {path.name}")
    return duration, any(stream.get("codec_type") == "audio" for stream in streams)


def export_video(folder, clips):
    global export_status
    try:
        ffmpeg, ffprobe = ffmpeg_tools()
        if not clips:
            raise RuntimeError("Add video files before exporting.")
        EXPORTS.mkdir(exist_ok=True)
        output = EXPORTS / "combined.mp4"
        temporary = EXPORTS / "combined.partial.mp4"
        args = [ffmpeg, "-hide_banner", "-y"]
        info = []
        for clip in clips:
            path = folder / clip["path"]
            duration, has_audio = probe_video(ffprobe, path)
            trim = float(clip["trim"])
            if trim >= duration:
                raise RuntimeError(f"Trim reaches the end of {clip['path']} ({duration:.1f}s).")
            args += ["-ss", str(trim), "-i", str(path)]
            info.append((duration - trim, has_audio))
        for remaining, has_audio in info:
            if not has_audio:
                args += ["-f", "lavfi", "-t", str(remaining), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
        filters = []
        silence_index = len(clips)
        for i, (_, has_audio) in enumerate(info):
            filters.append(
                f"[{i}:v:0]fps=30,scale=1280:720:force_original_aspect_ratio=decrease,"
                f"pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v{i}]"
            )
            audio_index = i if has_audio else silence_index
            filters.append(
                f"[{audio_index}:a:0]aresample=48000,"
                f"aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}]"
            )
            if not has_audio:
                silence_index += 1
        inputs = "".join(f"[v{i}][a{i}]" for i in range(len(clips)))
        filters.append(f"{inputs}concat=n={len(clips)}:v=1:a=1[v][a]")
        args += [
            "-filter_complex", ";".join(filters), "-map", "[v]", "-map", "[a]",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(temporary),
        ]
        subprocess.run(args, capture_output=True, text=True, check=True)
        temporary.replace(output)
        with lock:
            export_status = {"state": "done", "file": str(output)}
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or "").splitlines()
        with lock:
            export_status = {"state": "error", "message": "FFmpeg failed: " + "\n".join(detail[-8:])}
    except Exception as error:
        with lock:
            export_status = {"state": "error", "message": str(error)}
    finally:
        (EXPORTS / "combined.partial.mp4").unlink(missing_ok=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def send_bytes(self, data, content_type="application/json", status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, data, status=200):
        self.send_bytes(json.dumps(data).encode("utf-8"), status=status)

    def body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length > 1_000_000:
            raise ValueError("Request is too large")
        return json.loads(self.rfile.read(length))

    def do_GET(self):
        route = urlsplit(self.path).path
        try:
            if route == "/api/project":
                with lock:
                    folder, clips = scan_project()
                    project = read_project()
                    status = export_status.copy()
                return self.send_json({"app": "ap-video-viewer", "source": project.get("source", "files"), "courseName": project.get("courseName", ""), "folder": str(folder) if folder else "", "clips": clips, "export": status})
            if route == "/api/export":
                with lock:
                    status = export_status.copy()
                return self.send_json(status)
            if route.startswith("/media/"):
                return self.send_media(unquote(route.removeprefix("/media/")))
            if route in STATIC:
                path = ROOT / "ui" / STATIC[route]
                content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
                return self.send_bytes(path.read_bytes(), content_type)
            self.send_error(404)
        except Exception as error:
            self.send_json({"error": str(error)}, 500)

    def send_media(self, clip_id):
        with lock:
            folder, clips = scan_project()
        clip = next((item for item in clips if item["id"] == clip_id), None)
        if clip is None:
            return self.send_error(404)
        path = folder / clip["path"]
        size = path.stat().st_size
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        if match:
            left, right = match.groups()
            if not left and not right:
                return self.send_error(416)
            if left:
                start = int(left)
                end = min(int(right), size - 1) if right else size - 1
            else:
                suffix = int(right)
                start, end = max(0, size - suffix), size - 1
            if start >= size or end < start:
                return self.send_error(416)
            status = 206
        else:
            start, end, status = 0, size - 1, 200
        self.send_response(status)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with path.open("rb") as source:
            source.seek(start)
            remaining = end - start + 1
            while remaining:
                chunk = source.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
                remaining -= len(chunk)

    def do_POST(self):
        global export_status
        route = urlsplit(self.path).path
        try:
            if route == "/api/folder":
                raw = self.body().get("folder", "").strip()
                if not raw:
                    raise ValueError("Choose a video folder first.")
                folder = Path(raw).expanduser()
                if not folder.is_absolute():
                    folder = ROOT / folder
                folder = folder.resolve()
                if not folder.is_dir():
                    raise ValueError("Choose an existing folder.")
                with lock:
                    project = read_project()
                    project["source"] = "files"
                    project["folder"] = str(folder)
                    project["items"] = []
                    write_project(project)
                return self.send_json({"ok": True})
            if route == "/api/ap-import":
                payload = self.body()
                course_id = str(payload.get("courseId", ""))
                imported = payload.get("clips", [])
                if not re.fullmatch(r"\d{1,4}", course_id) or not isinstance(imported, list) or not 0 < len(imported) <= 1000:
                    raise ValueError("Open an AP Classroom video, then use the import bookmarklet.")
                with lock:
                    old = read_project()
                    trims = {item.get("id"): item.get("trim", 0) for item in old.get("items", [])} if old.get("source") == "ap" else {}
                    old_order = {item.get("id"): i for i, item in enumerate(old.get("items", []))} if old.get("source") == "ap" else {}
                    items = []
                    seen = set()
                    for clip in imported:
                        clip_id = str(clip.get("id", ""))
                        unit = str(clip.get("unit", ""))
                        name = str(clip.get("name", "")).strip()[:200]
                        if not re.fullmatch(r"[A-Za-z0-9]{6,30}", clip_id) or not re.fullmatch(r"\d{1,2}", unit) or not name:
                            raise ValueError("The AP Classroom video list contains an invalid entry.")
                        if clip_id in seen:
                            continue
                        seen.add(clip_id)
                        items.append({
                            "id": clip_id, "unit": unit, "name": name, "trim": trims.get(clip_id, 0),
                            "apUrl": f"https://apclassroom.collegeboard.org/{course_id}/home?apd={clip_id}&unit={unit}",
                        })
                    incoming_order = {item["id"]: i for i, item in enumerate(items)}
                    items.sort(key=lambda item: (0, old_order[item["id"]]) if item["id"] in old_order else (1, incoming_order[item["id"]]))
                    write_project({"source": "ap", "courseName": str(payload.get("courseName", "AP Classroom"))[:100], "items": items})
                return self.send_json({"ok": True, "count": len(items)})
            if route == "/api/choose-folder":
                import tkinter as tk
                from tkinter import filedialog
                root = tk.Tk()
                root.withdraw()
                root.attributes("-topmost", True)
                try:
                    folder = filedialog.askdirectory(parent=root, title="Choose your video folder")
                finally:
                    root.destroy()
                return self.send_json({"folder": folder})
            if route == "/api/project":
                submitted = self.body().get("items", [])
                with lock:
                    folder, clips = scan_project()
                    by_id = {clip["id"]: clip for clip in clips}
                    if len(submitted) != len(clips) or {item.get("id") for item in submitted} != set(by_id):
                        raise ValueError("Video list changed. Refresh and try again.")
                    items = []
                    for item in submitted:
                        trim = float(item.get("trim", 0))
                        if not math.isfinite(trim) or not 0 <= trim < 86400 or round(trim, 3) != trim:
                            raise ValueError("Trim must be a number of seconds between 0 and 86400, with up to 3 decimals.")
                        clip = by_id[item["id"]]
                        if folder:
                            items.append({"path": clip["path"], "trim": trim})
                        else:
                            items.append({"id": clip["id"], "name": clip["name"], "unit": clip["unit"], "apUrl": clip["apUrl"], "trim": trim})
                    project = read_project()
                    project["items"] = items
                    write_project(project)
                return self.send_json({"ok": True})
            if route == "/api/export":
                with lock:
                    if export_status["state"] == "running":
                        return self.send_json(export_status)
                    folder, clips = scan_project()
                    if folder is None:
                        raise ValueError("AP Classroom videos cannot be exported from this viewer. Export works for local video files you can edit.")
                    export_status = {"state": "running"}
                    threading.Thread(target=export_video, args=(folder, clips), daemon=True).start()
                return self.send_json({"state": "running"})
            self.send_error(404)
        except (ValueError, KeyError, TypeError) as error:
            self.send_json({"error": str(error)}, 400)
        except Exception as error:
            self.send_json({"error": str(error)}, 500)


def main():
    VIDEOS.mkdir(exist_ok=True)
    port = int(os.environ.get("STUDY_REEL_PORT", "8765"))
    url = f"http://127.0.0.1:{port}/"
    try:
        response = urlopen(url + "api/project", timeout=2)
    except HTTPError as error:
        raise RuntimeError(f"Port {port} is busy. Set STUDY_REEL_PORT to another port.") from error
    except URLError:
        response = None
    if response is not None:
        with response:
            try:
                already_running = json.load(response).get("app") == "ap-video-viewer"
            except (ValueError, AttributeError):
                already_running = False
        if not already_running:
            raise RuntimeError(f"Port {port} is busy. Set STUDY_REEL_PORT to another port.")
        print(f"AP video viewer is already running: {url}", flush=True)
        if not os.environ.get("STUDY_REEL_NO_BROWSER"):
            webbrowser.open(url)
        return
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError:
        try:
            with urlopen(url + "api/project", timeout=2) as response:
                already_running = json.load(response).get("app") == "ap-video-viewer"
        except Exception:
            already_running = False
        if not already_running:
            raise RuntimeError(f"Port {port} is busy. Set STUDY_REEL_PORT to another port.")
        print(f"AP video viewer is already running: {url}", flush=True)
        if not os.environ.get("STUDY_REEL_NO_BROWSER"):
            webbrowser.open(url)
        return
    print(f"AP video viewer: {url}", flush=True)
    if not os.environ.get("STUDY_REEL_NO_BROWSER"):
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
