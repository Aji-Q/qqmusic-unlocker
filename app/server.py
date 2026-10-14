#!/usr/bin/env python3
"""QQ 音乐解锁器本地服务：任务队列 + 进度上报 + 原生文件选择（仅监听 127.0.0.1）。

前端是 app/ui/index.html 单页应用；启动方式见 ../launch.sh 或应用包。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import qmengine as eng  # noqa: E402
import settings  # noqa: E402
from version import APP_VERSION  # noqa: E402

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
        self.error_code = None
        self.action = None
        self.hint = ""
        self.footer = None

    def as_dict(self):
        return {"path": self.path, "name": self.name, "size": self.size,
                "status": self.status, "progress": round(self.progress * 100, 1),
                "detail": self.detail, "result": self.result, "error": self.error,
                "error_code": self.error_code, "action": self.action, "hint": self.hint,
                "footer": self.footer}


class Jobs:
    """单工作线程串行处理队列；进度写入共享状态供前端轮询。"""

    def __init__(self, cache: eng.EkeyCache, settings_path=None):
        self.cache = cache
        self.lock = threading.Lock()
        self.version = 0
        self.items: list[Item] = []
        self.logs: list[dict] = []
        self.running = False
        self.cancel = threading.Event()
        self.worker = None
        self.settings_path = settings_path or settings.default_path()
        defaults = {"outdir": eng.default_output_dir(), "bitrate": "320k", "keep_ogg": False}
        saved, self.settings_warning = settings.load(defaults, self.settings_path)
        self.outdir, self.bitrate, self.keep_ogg = (saved[key] for key in settings.FIELDS)
        self.start_error = None

    # ---------- 状态读取 ----------
    def snapshot(self):
        with self.lock:
            return {"version": self.version, "running": self.running,
                    "stopping": self.running and self.cancel.is_set(),
                    "outdir": self.outdir, "bitrate": self.bitrate,
                    "keep_ogg": self.keep_ogg, "logs": self.logs[-200:],
                    "settings_warning": self.settings_warning,
                    "start_error": self.start_error,
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
        """原生入口保留返回新增数量；HTTP 使用 add_report 的完整反馈。"""
        return self.add_report(paths)["added"]

    def add_report(self, paths):
        if not isinstance(paths, list) or any(not isinstance(p, str) or not p or "\x00" in p for p in paths):
            raise eng.EngineError("请选择有效的文件或文件夹", code="invalid_paths", action="retry")
        report = {"added": 0, "duplicate": 0, "unsupported": 0, "missing": 0,
                  "empty_folders": 0, "unreadable": 0}
        for supplied in paths:
            path = os.path.abspath(os.path.expanduser(supplied))
            if os.path.isdir(path):
                candidates = []
                def unreadable(_):
                    report["unreadable"] += 1
                for root, directories, names in os.walk(path, onerror=unreadable):
                    directories[:] = sorted(d for d in directories if not d.startswith("."))
                    candidates.extend(os.path.join(root, name) for name in sorted(names)
                                      if not name.startswith("."))
                if not any(p.lower().endswith(eng.SUPPORTED_EXT) for p in candidates):
                    report["empty_folders"] += 1
            else:
                candidates = [path]
            for candidate in candidates:
                if not os.path.isfile(candidate):
                    report["missing"] += 1
                    continue
                if not candidate.lower().endswith(eng.SUPPORTED_EXT):
                    report["unsupported"] += 1
                    continue
                with self.lock:
                    # Windows 路径忽略大小写；在锁内检查，避免两个拖入请求重复入队。
                    known = {os.path.normcase(os.path.realpath(i.path)) for i in self.items}
                    if os.path.normcase(os.path.realpath(candidate)) in known:
                        report["duplicate"] += 1
                        continue
                    try:
                        self.items.append(Item(candidate))
                        report["added"] += 1
                    except OSError:
                        report["unreadable"] += 1
        with self.lock:
            self.touch()
        report["skipped"] = sum(report[key] for key in ("duplicate", "unsupported", "missing", "unreadable"))
        report["reason"] = ("added" if report["added"] else
                            "duplicate" if report["duplicate"] else
                            "missing" if report["missing"] else
                            "unreadable" if report["unreadable"] else
                            "unsupported" if report["unsupported"] else
                            "empty_folder" if report["empty_folders"] else "no_selection")
        labels = (("added", "新增"), ("duplicate", "已在队列"), ("unsupported", "不支持"),
                  ("missing", "不存在"), ("unreadable", "无法读取"))
        summary = "，".join(f"{label} {report[key]}" for key, label in labels if report[key])
        report["message"] = summary or ("文件夹中没有支持的音频" if report["empty_folders"] else "未选择文件")
        if summary:
            self.log(summary, "info" if report["added"] else "warn")
        elif report["empty_folders"]:
            self.log("文件夹中没有支持的音频", "warn")
        return report

    def open_paths(self, paths, auto_start=True):
        """拖放、文件关联与 HTTP 共用，运行中的新文件直接加入当前队列。"""
        report = self.add_report(paths)
        report.update(started=False, queued=False, start_error=None)
        if report["added"] and auto_start:
            with self.lock:
                running = self.running
            if running:
                report["queued"] = True
            else:
                report["started"], _ = self.start()
                if not report["started"]:
                    report["start_error"] = self.start_error
        return report

    def clear(self, only_finished=True):
        with self.lock:
            if self.running or any(i.status == "进行中" for i in self.items):
                return False
            self.items = ([i for i in self.items if i.status != "完成"]
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
            if self.running:
                raise eng.EngineError("转换中无法修改设置", code="busy", action="retry",
                                      hint="等待任务结束或停止任务后再修改", status=409)
            values = {"outdir": self.outdir if outdir is None else outdir,
                      "bitrate": self.bitrate if bitrate is None else bitrate,
                      "keep_ogg": self.keep_ogg if keep_ogg is None else keep_ogg}
            try:
                values = settings.validate(values)
                settings.save(values, self.settings_path)
            except settings.SettingsError as exc:
                raise eng.EngineError(str(exc), code="invalid_settings", action="settings") from exc
            except OSError as exc:
                raise eng.EngineError("无法保存设置", code="settings_unwritable", action="settings",
                                      hint="请检查用户配置目录的写入权限") from exc
            self.outdir, self.bitrate, self.keep_ogg = (values[key] for key in settings.FIELDS)
            self.settings_warning = None
            self.start_error = None
            self.touch()

    def start(self):
        with self.lock:
            self.start_error = None
            pending = [i for i in self.items if i.status in ("等待", "失败")]
            if self.running:
                self.start_error = eng.EngineError("任务已在运行", code="busy", action="retry").as_dict()
                return False, "任务已在运行"
            if not pending:
                self.start_error = eng.EngineError("队列里没有待处理的文件", code="empty_queue", action="add").as_dict()
                return False, "队列里没有待处理的文件"
            try:
                eng.check_dependencies()
                eng.check_output_dir(self.outdir)
            except eng.EngineError as exc:
                self.start_error = exc.as_dict()
                self.touch()
                return False, str(exc)
            for i in pending:
                i.status, i.progress, i.error, i.result = "等待", 0.0, None, None
                i.error_code, i.action, i.hint = None, None, ""
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
                item.result["original"] = result.get("original")
                self.touch()
            self.log(f"完成 {item.name} → {os.path.basename(result['mp3'])} "
                     f"({result['codec']} {result['src_bitrate'] // 1000}k "
                     f"{result['duration']:.1f}s)", "ok")
        except eng.EngineError as exc:
            with self.lock:
                item.status = "失败"
                item.error = str(exc)
                item.error_code, item.action, item.hint = exc.code, exc.action, exc.hint
                item.detail = ""
                self.touch()
            self.log(f"失败 {item.name}：{exc}", "error")
        except Exception as exc:  # noqa: BLE001
            with self.lock:
                item.status = "失败"
                item.error = "转换未完成"
                item.error_code, item.action = "unexpected", "retry"
                item.hint = "请重试；若持续失败，请提供日志反馈问题"
                item.detail = ""
                self.touch()
            self.log(f"失败 {item.name}：{exc}", "error")


# ------------------------------------------------------------- 原生文件选择

IS_WIN = sys.platform.startswith("win")
PICKER_LOCK = threading.Lock()


def run_picker(callback, *args):
    """所有选择按钮共用一个原生对话框；拒绝重复请求，不排队再弹一次。"""
    if not PICKER_LOCK.acquire(blocking=False):
        raise eng.EngineError("已有文件选择窗口打开", code="picker_busy", action="retry",
                              hint="请先完成或取消当前选择", status=409)
    try:
        return callback(*args)
    finally:
        PICKER_LOCK.release()


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
    if not isinstance(path, str) or not os.path.exists(path):
        raise eng.EngineError("文件或目录已不存在", code="path_missing", action="settings",
                              hint="请重新选择输出目录，或确认结果文件的位置")
    if IS_WIN:
        # 选中文件时用 /select 定位，否则直接打开目录
        if os.path.isfile(path):
            subprocess.run(["explorer", "/select,", os.path.normpath(path)], check=False)
        else:
            os.startfile(path if os.path.isdir(path) else os.path.dirname(path))  # noqa: S606
        return
    subprocess.run(["open", path] if os.path.isdir(path) else ["open", "-R", path], check=False)


def open_qqmusic():
    """打开已安装的官方客户端；不读取进程或改变登录状态。"""
    if not IS_WIN:
        result = subprocess.run(["open", "-b", "com.tencent.QQMusicMac"],
                                capture_output=True, timeout=10)
        if result.returncode == 0:
            return
    else:
        import winreg
        candidates = []
        registry_path = r"Software\Microsoft\Windows\CurrentVersion\App Paths\QQMusic.exe"
        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            for view in (0, winreg.KEY_WOW64_32KEY, winreg.KEY_WOW64_64KEY):
                try:
                    with winreg.OpenKey(hive, registry_path, 0, winreg.KEY_READ | view) as key:
                        value, _ = winreg.QueryValueEx(key, None)
                        if isinstance(value, str):
                            candidates.append(os.path.expandvars(value.strip('"')))
                except OSError:
                    pass
        for variable in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
            root = os.environ.get(variable)
            if root:
                candidates.append(os.path.join(root, "Tencent", "QQMusic", "QQMusic.exe"))
        executable = shutil.which("QQMusic.exe")
        if executable:
            candidates.append(executable)
        for candidate in candidates:
            if os.path.isfile(candidate):
                os.startfile(candidate)
                return
    raise eng.EngineError("未找到 QQ 音乐客户端", code="qqmusic_missing", action="login",
                          hint="请先安装 QQ 音乐，或手动打开已安装的客户端")


# ------------------------------------------------------------------ HTTP 服务

class Handler(BaseHTTPRequestHandler):
    jobs: Jobs = None
    token: str = ""

    server_version = f"QQMusicUnlocker/{APP_VERSION}"

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
            return self._json(eng.EngineError("连接已失效", code="unauthorized", action="retry",
                                             hint="请重新打开应用").as_dict(), 403)
        if path == "/api/state":
            return self._json(self.jobs.snapshot())
        if path == "/api/status":
            return self._json({"version": APP_VERSION, "engine": eng.engine_status(),
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
            return self._json(eng.EngineError("连接已失效", code="unauthorized", action="retry",
                                             hint="请重新打开应用").as_dict(), 403)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length < 0 or length > 2 * 1024 * 1024:
                raise ValueError("请求体过大")
            payload = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(payload, dict):
                raise ValueError("请求体必须是对象")
        except (ValueError, UnicodeError):
            return self._json(eng.EngineError("请求格式无效", code="invalid_request",
                                             action="retry").as_dict(), 400)
        try:
            return self._post(path, payload)
        except eng.EngineError as exc:
            return self._json(exc.as_dict(), exc.status)
        except (OSError, subprocess.SubprocessError) as exc:
            self.jobs.log(f"操作失败：{exc}", "error")
            return self._json(eng.EngineError("操作未完成", code="operation_failed", action="retry",
                                             hint="请重试；若持续失败，请查看日志").as_dict(), 500)

    def _post(self, path, payload):
        if path == "/api/add":
            return self._json(self.jobs.add_report(payload.get("paths", [])))
        if path == "/api/pick/files":
            try:
                return self._json({"paths": run_picker(pick_files)})
            except eng.EngineError:
                raise
            except Exception as exc:  # noqa: BLE001
                raise eng.EngineError("无法打开文件选择器", code="picker_failed", action="retry",
                                      hint="请重试，或将文件拖入窗口", status=500) from exc
        if path == "/api/pick/folder":
            selecting_output = bool(payload.get("outdir"))
            if selecting_output:
                with self.jobs.lock:
                    if self.jobs.running:
                        raise eng.EngineError("转换中无法修改设置", code="busy", action="retry",
                                              hint="等待任务结束后再修改", status=409)
            try:
                folder = run_picker(pick_folder, "选择输出目录" if selecting_output else "选择包含加密音频的目录")
            except eng.EngineError:
                raise
            except Exception as exc:  # noqa: BLE001
                raise eng.EngineError("无法打开文件夹选择器", code="picker_failed", action="retry",
                                      hint="请重试，或将文件夹拖入窗口", status=500) from exc
            report = self.jobs.add_report([])
            if not folder:
                report["reason"] = "cancelled"
                report["message"] = "已取消选择"
                return self._json({**report, "folder": "", "files": []})
            if selecting_output:
                self.jobs.configure(outdir=folder)
                report["reason"] = "configured"
                report["message"] = "输出目录已保存"
                return self._json({**report, "folder": folder, "files": []})
            return self._json({**self.jobs.open_paths([folder]), "folder": folder,
                               "files": eng.scan_folder(folder)})
        if path == "/api/open":
            # 「拖到图标/窗口上」的统一入口：加进队列，默认直接开跑（少点一次按钮）
            auto_start = payload.get("auto_start", True)
            if not isinstance(auto_start, bool):
                raise eng.EngineError("自动开始选项无效", code="invalid_request", action="retry")
            return self._json(self.jobs.open_paths(payload.get("paths", []), auto_start))
        if path == "/api/start":
            ok, msg = self.jobs.start()
            return self._json({"ok": ok, "message": msg,
                               **(self.jobs.start_error or {})})
        if path == "/api/stop":
            return self._json({"ok": self.jobs.stop()})
        if path == "/api/clear":
            return self._json({"ok": self.jobs.clear(bool(payload.get("only_finished", True)))})
        if path == "/api/remove":
            self.jobs.remove(payload.get("path", ""))
            return self._json({"ok": True})
        if path == "/api/config":
            if any(key in payload and payload[key] is None for key in settings.FIELDS):
                raise eng.EngineError("设置值不能为空", code="invalid_settings", action="settings")
            self.jobs.configure(payload.get("outdir"), payload.get("bitrate"),
                                payload.get("keep_ogg"))
            return self._json(self.jobs.snapshot())
        if path == "/api/reveal":
            target = payload.get("path") or self.jobs.outdir
            reveal(target)
            return self._json({"ok": True})
        if path == "/api/qqmusic/open":
            open_qqmusic()
            return self._json({"ok": True})
        if path == "/api/quit":
            threading.Thread(target=lambda: (time.sleep(0.3), os._exit(0)),
                             daemon=True).start()
            return self._json({"ok": True})
        return self._json(eng.EngineError("未知接口", code="not_found", action="retry").as_dict(), 404)


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
            f.write(json.dumps({"port": bound, "token": token, "pid": os.getpid(),
                                "version": APP_VERSION,
                                "service_path": os.path.realpath(
                                    sys.executable if getattr(sys, "frozen", False) else __file__)}))
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
