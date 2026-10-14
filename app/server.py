#!/usr/bin/env python3
"""QQ 音乐解锁器本地服务：任务队列 + 进度上报 + 原生文件选择（仅监听 127.0.0.1）。

前端是 app/ui/index.html 单页应用；启动方式见 ../launch.sh 或应用包。
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import qmengine as eng  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
UI_DIR = (os.path.join(sys._MEIPASS, "app", "ui")
          if getattr(sys, "frozen", False) else os.path.join(HERE, "ui"))
HOME = os.path.expanduser("~")


# ------------------------------------------------------------------ 任务队列

class Item:
    def __init__(self, path: str):
        self.path = path
        self.name = os.path.basename(path)
        self.size = os.path.getsize(path) if os.path.exists(path) else 0
        self.status = "等待"
        self.progress = 0.0
        self.detail = ""
        self.result = None
        self.error = None
        self.footer = None

    def as_dict(self):
        return {"path": self.path, "name": self.name, "size": self.size,
                "status": self.status, "progress": round(self.progress * 100, 1),
                "detail": self.detail, "result": self.result, "error": self.error,
                "footer": self.footer}


class Jobs:
    """单工作线程串行处理队列；进度写入共享状态供前端轮询。"""

    def __init__(self, cache: eng.EkeyCache):
        self.cache = cache
        self.lock = threading.Lock()
        self.version = 0
        self.items: list[Item] = []
        self.logs: list[dict] = []
        self.running = False
        self.cancel = threading.Event()
        self.worker = None
        self.outdir = eng.default_output_dir()
        self.bitrate = "320k"
        self.keep_ogg = False

    # ---------- 状态读取 ----------
    def snapshot(self):
        with self.lock:
            return {"version": self.version, "running": self.running,
                    "stopping": self.running and self.cancel.is_set(),
                    "outdir": self.outdir, "bitrate": self.bitrate,
                    "keep_ogg": self.keep_ogg, "logs": self.logs[-200:],
                    "items": [i.as_dict() for i in self.items],
                    "stats": self._stats()}

    def _stats(self):
        done = sum(1 for i in self.items if i.status == "完成")
        fail = sum(1 for i in self.items if i.status == "失败")
        return {"total": len(self.items), "done": done, "failed": fail,
                "pending": len(self.items) - done - fail}

    def touch(self):
        self.version += 1

    def log(self, text, level="info"):
        with self.lock:
            self.logs.append({"t": time.strftime("%H:%M:%S"), "text": text, "level": level})
            self.touch()

    # ---------- 队列操作 ----------
    def add(self, paths):
        added, skipped = 0, 0
        for supplied in paths:
            path = os.path.abspath(supplied)
            candidates = eng.scan_folder(path) if os.path.isdir(path) else [path]
            if not candidates:
                skipped += 1
            for candidate in candidates:
                if not os.path.isfile(candidate) or not candidate.lower().endswith(eng.SUPPORTED_EXT):
                    skipped += 1
                    continue
                with self.lock:
                    # Windows 路径忽略大小写；在锁内检查，避免两个拖入请求重复入队。
                    known = {os.path.normcase(i.path) for i in self.items}
                    if os.path.normcase(candidate) in known:
                        skipped += 1
                        continue
                    self.items.append(Item(candidate))
                    added += 1
        with self.lock:
            self.touch()
        if added:
            self.log(f"加入 {added} 个文件" + (f"（跳过 {skipped} 个）" if skipped else ""))
        elif skipped:
            self.log(f"没有新增文件（跳过 {skipped} 个）", "warn")
        return added

    def clear(self, only_finished=True):
        with self.lock:
            if self.running or any(i.status == "进行中" for i in self.items):
                return False
            self.items = ([i for i in self.items if i.status == "等待"]
                          if only_finished else [])
            self.logs.clear()
            self.touch()
        return True

    def remove(self, path):
        with self.lock:
            self.items = [i for i in self.items
                          if not (i.path == path and i.status in ("等待", "完成", "失败"))]
            self.touch()

    def configure(self, outdir=None, bitrate=None, keep_ogg=None):
        with self.lock:
            if outdir:
                self.outdir = os.path.expanduser(outdir)
            if bitrate:
                self.bitrate = bitrate
            if keep_ogg is not None:
                self.keep_ogg = bool(keep_ogg)
            self.touch()

    def start(self):
        with self.lock:
            pending = [i for i in self.items if i.status in ("等待", "失败")]
            if self.running:
                return False, "任务已在运行"
            if not pending:
                return False, "队列里没有待处理的文件"
            for i in pending:
                i.status, i.progress, i.error, i.result = "等待", 0.0, None, None
            self.running = True
            self.cancel.clear()
            self.touch()
        self.log(f"开始处理 {len(pending)} 个文件，输出到 {self.outdir}")
        self.worker = threading.Thread(target=self._run, daemon=True)
        self.worker.start()
        return True, None

    def stop(self):
        with self.lock:
            if not self.running:
                return False
        self.cancel.set()
        self.log("已请求停止：当前文件完成后中断", "warn")
        return True

    # ---------- 工作线程 ----------
    def _run(self):
        while True:
            target = None
            with self.lock:
                for i in self.items:
                    if i.status == "等待":
                        i.status = "进行中"
                        target = i
                        break
                if target is None or self.cancel.is_set():
                    self.running = False
                    if self.cancel.is_set():
                        for i in self.items:
                            if i.status == "进行中":
                                i.status, i.detail = "等待", ""
                    self.touch()
                    break
                self.touch()
            self._process(target)
        with self.lock:
            s = self._stats()
        self.log(f"任务结束：成功 {s['done']}，失败 {s['failed']}"
                 + ("（已中断）" if self.cancel.is_set() else ""))

    def _process(self, item: Item):
        def progress(stage, ratio):
            with self.lock:
                item.detail = stage
                item.progress = ratio
                self.touch()

        try:
            result = eng.decrypt_file(item.path, self.outdir, self.bitrate,
                                      cache=self.cache, progress=progress,
                                      keep_ogg=self.keep_ogg)
            with self.lock:
                item.status = "完成"
                item.progress = 1.0
                item.detail = ""
                item.footer = result["footer"]
                item.result = {k: result[k] for k in
                               ("mp3", "size", "codec", "src_bitrate", "duration", "tags")}
                self.touch()
            self.log(f"完成 {item.name} → {os.path.basename(result['mp3'])} "
                     f"({result['codec']} {result['src_bitrate'] // 1000}k "
                     f"{result['duration']:.1f}s)", "ok")
        except eng.EngineError as exc:
            with self.lock:
                item.status = "失败"
                item.error = str(exc)
                item.detail = ""
                self.touch()
            self.log(f"失败 {item.name}：{exc}", "error")
        except Exception as exc:  # noqa: BLE001
            with self.lock:
                item.status = "失败"
                item.error = f"未预期错误：{exc}"
                item.detail = ""
                self.touch()
            self.log(f"失败 {item.name}：{exc}", "error")


# ------------------------------------------------------------- 原生文件选择

IS_WIN = sys.platform.startswith("win")


# -- macOS：osascript 原生对话框 ----------------------------------------

def osascript(script: str, timeout: int = 120):
    """执行 AppleScript；用户取消（-128）返回空字符串而不是抛错。"""
    proc = subprocess.run(["osascript", "-e", script], capture_output=True,
                          text=True, timeout=timeout)
    if proc.returncode != 0:
        if "-128" in proc.stderr:
            return ""
        raise RuntimeError(proc.stderr.strip()[:200])
    return proc.stdout.strip()


# -- Windows：tkinter 原生对话框（stdlib，随 Python 一起打包） ----------
# subtle: tkinter 的对话框必须在它自己创建的线程里从头到尾用完一个 root，
# 跨线程复用 root 会崩；这里每次开一个隐藏 root，用完即销毁。

def _tk_dialog(fn):
    import tkinter as tk
    from tkinter import filedialog
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        return fn(filedialog, root)
    finally:
        root.destroy()


def pick_files():
    if IS_WIN:
        exts = " ".join(f"*{e}" for e in eng.SUPPORTED_EXT)
        res = _tk_dialog(lambda fd, r: fd.askopenfilenames(
            title="选择加密音频文件", parent=r,
            filetypes=[("QQ 音乐加密音频", exts), ("所有文件", "*.*")]))
        return [p for p in res if p]
    type_list = ", ".join(f'"{e.lstrip(".")}"' for e in eng.SUPPORTED_EXT)
    out = osascript(
        f'set typeList to {{{type_list}}}\n'
        'set theFiles to choose file with prompt "选择加密音频文件" '
        'of type typeList with multiple selections allowed\n'
        'set out to ""\n'
        'repeat with f in theFiles\n'
        '  set out to out & POSIX path of f & linefeed\n'
        'end repeat\nreturn out')
    return [p for p in out.splitlines() if p.strip()]


def pick_folder(prompt="选择包含加密音频的目录"):
    if IS_WIN:
        return _tk_dialog(lambda fd, r: fd.askdirectory(title=prompt, parent=r)) or ""
    out = osascript(f'POSIX path of (choose folder with prompt "{prompt}")')
    return out.strip()


def reveal(path):
    if IS_WIN:
        # 选中文件时用 /select 定位，否则直接打开目录
        if os.path.isfile(path):
            subprocess.run(["explorer", "/select,", os.path.normpath(path)], check=False)
        else:
            os.startfile(path if os.path.isdir(path) else os.path.dirname(path))  # noqa: S606
        return
    subprocess.run(["open", "-R", path], check=False)


# ------------------------------------------------------------------ HTTP 服务

class Handler(BaseHTTPRequestHandler):
    jobs: Jobs = None
    token: str = ""

    server_version = "QQMusicUnlocker/1.0"

    def log_message(self, fmt, *args):  # 静默访问日志
        pass

    def _send(self, code, body: bytes, ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, payload, code=200):
        self._send(code, json.dumps(payload, ensure_ascii=False).encode())

    def _authorized(self):
        if self.path.startswith("/api/") and self.token:
            return self.headers.get("X-Token") == self.token
        return True

    def do_GET(self):  # noqa: N802
        path = self.path.split("?")[0]
        if path.startswith("/api/") and not self._authorized():
            return self._json({"error": "未授权"}, 403)
        if path == "/api/state":
            return self._json(self.jobs.snapshot())
        if path == "/api/status":
            return self._json({"engine": eng.engine_status(),
                               "defaults": {"outdir": eng.default_output_dir(),
                                            "home": HOME,
                                            "cache_dir": eng.CACHE_DIR}})
        if path == "/api/credentials/reload":
            self.jobs.cache.invalidate()
            return self._json({"engine": eng.engine_status()})
        return self._serve_static(path)

    def _serve_static(self, path):
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        target = os.path.normpath(os.path.join(UI_DIR, rel))
        if not target.startswith(UI_DIR) or not os.path.isfile(target):
            return self._send(404, b"not found", "text/plain; charset=utf-8")
        ctype = {".html": "text/html; charset=utf-8",
                 ".js": "text/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8",
                 ".svg": "image/svg+xml"}.get(os.path.splitext(target)[1],
                                              "application/octet-stream")
        if self.token and target.endswith((".html", ".js")):
            text = open(target, encoding="utf-8").read()
            text = text.replace("%%TOKEN%%", self.token)
            return self._send(200, text.encode(), ctype)
        with open(target, "rb") as f:
            return self._send(200, f.read(), ctype)

    def do_POST(self):  # noqa: N802
        path = self.path.split("?")[0]
        if not self._authorized():
            return self._json({"error": "未授权"}, 403)
        length = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._json({"error": "请求体不是合法 JSON"}, 400)

        if path == "/api/add":
            paths = payload.get("paths") or []
            return self._json({"added": self.jobs.add(paths)})
        if path == "/api/pick/files":
            try:
                return self._json({"paths": pick_files()})
            except Exception as exc:  # noqa: BLE001
                return self._json({"error": str(exc)}, 500)
        if path == "/api/pick/folder":
            try:
                if payload.get("outdir"):
                    folder = pick_folder("选择输出目录")
                    if folder:
                        self.jobs.configure(outdir=folder)
                    return self._json({"folder": folder, "files": [], "added": 0})
                folder = pick_folder()
                if not folder:
                    return self._json({"folder": "", "files": [], "added": 0})
                files = eng.scan_folder(folder)
                return self._json({"folder": folder, "files": files,
                                   "added": self.jobs.add(files)})
            except Exception as exc:  # noqa: BLE001
                return self._json({"error": str(exc)}, 500)
        if path == "/api/open":
            # 「拖到图标/窗口上」的统一入口：加进队列，默认直接开跑（少点一次按钮）
            paths = [p for p in (payload.get("paths") or [])
                     if os.path.exists(p)]
            added = self.jobs.add(paths)
            started = False
            if added and payload.get("auto_start", True):
                started, _ = self.jobs.start()
            return self._json({"added": added, "started": started})
        if path == "/api/start":
            ok, msg = self.jobs.start()
            return self._json({"ok": ok, "message": msg})
        if path == "/api/stop":
            return self._json({"ok": self.jobs.stop()})
        if path == "/api/clear":
            return self._json({"ok": self.jobs.clear(bool(payload.get("only_finished", True)))})
        if path == "/api/remove":
            self.jobs.remove(payload.get("path", ""))
            return self._json({"ok": True})
        if path == "/api/config":
            self.jobs.configure(payload.get("outdir"), payload.get("bitrate"),
                                payload.get("keep_ogg"))
            return self._json(self.jobs.snapshot())
        if path == "/api/reveal":
            target = payload.get("path") or self.jobs.outdir
            reveal(target)
            return self._json({"ok": True})
        if path == "/api/quit":
            threading.Thread(target=lambda: (time.sleep(0.3), os._exit(0)),
                             daemon=True).start()
            return self._json({"ok": True})
        return self._json({"error": "未知接口"}, 404)


def start_server(port=0, token="", runtime_file=""):
    """创建并在后台线程启动 HTTP 服务，返回 (httpd, url)。供 Windows 的
    pywebview 启动器在本进程内调用，不阻塞主线程。"""
    jobs = Jobs(eng.EkeyCache())
    Handler.jobs = jobs
    Handler.token = token
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    bound = httpd.server_address[1]
    url = f"http://127.0.0.1:{bound}/?t={token}" if token else f"http://127.0.0.1:{bound}/"
    if runtime_file:
        with open(runtime_file, "w") as f:
            f.write(json.dumps({"port": bound, "token": token, "pid": os.getpid()}))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, url


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--token", default="")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--runtime-file", default="")
    args = ap.parse_args()

    httpd, url = start_server(args.port, args.token, args.runtime_file)
    if sys.stdout is not None:
        sys.stdout.reconfigure(line_buffering=True)
        print(f"QQ 音乐解锁器运行中：{url}", flush=True)
    if not args.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == "__main__":
    main()
