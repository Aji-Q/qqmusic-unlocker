"""Windows 入口：本地服务、WebView2 窗口与离线自检。"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import os
import sys
import uuid

# PyInstaller --windowed 会把标准流设为 None，日志和自检不能依赖它们。
for _stream in (sys.stdout, sys.stderr):
    if _stream is not None and hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

_HERE = os.path.dirname(os.path.abspath(__file__))
_APP = os.path.join(getattr(sys, "_MEIPASS", os.path.dirname(_HERE)), "app")
sys.path.insert(0, _APP)

import server  # noqa: E402
import qmengine as eng  # noqa: E402
from version import APP_VERSION  # noqa: E402

WEBVIEW2_DOWNLOAD_URL = "https://developer.microsoft.com/microsoft-edge/webview2/#download-section"
_WEBVIEW2_KEY = r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"


class MissingWebView2Error(RuntimeError):
    pass


def webview2_runtime_version():
    """微软公开的 Evergreen 检测方法；空串表示缺失，None 表示无法确认。

    HKLM 使用 32 位注册表视图，对应 64 位系统的 WOW6432Node；HKCU
    使用当前用户视图。权限等读取错误不应被误报为「尚未安装」。
    https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution
    """
    import winreg

    unknown = False
    for root, view in ((winreg.HKEY_LOCAL_MACHINE, winreg.KEY_WOW64_32KEY),
                       (winreg.HKEY_CURRENT_USER, 0)):
        try:
            with winreg.OpenKey(root, _WEBVIEW2_KEY, 0, winreg.KEY_READ | view) as key:
                value, _ = winreg.QueryValueEx(key, "pv")
            parts = value.split(".") if isinstance(value, str) else []
            if len(parts) == 4 and all(p.isascii() and p.isdigit() for p in parts):
                if any(int(p) > 0 for p in parts):
                    return value
        except FileNotFoundError:
            continue
        except OSError:
            unknown = True
    return None if unknown else ""


def file_args(argv: list[str]) -> list[str]:
    """保留现存路径；目录由 Jobs.add 统一递归展开。"""
    return [os.path.abspath(a) for a in argv
            if not a.startswith("-") and os.path.exists(a)]


def drop_handler(push, on_error=None):
    def handle(event):
        try:
            paths = []
            for item in (event.get("dataTransfer") or {}).get("files") or []:
                # name 只有文件名，不能拿当前工作目录里的同名文件冒充拖入文件。
                path = item.get("pywebviewFullPath") or item.get("path")
                if path and os.path.isabs(path) and os.path.exists(path):
                    paths.append(path)
            if paths:
                push(paths)
            elif on_error:
                on_error(RuntimeError("未能读取拖入路径，请使用「选择文件」"))
        except Exception as exc:  # 回调异常交给窗口内日志显示
            if on_error:
                on_error(exc)
    return handle


def install_drop(window, push, on_error=None) -> bool:
    """仅在 events.loaded 后调用，此时 DOM 和 pywebview 桥已初始化。"""
    try:
        from webview.dom import DOMEventHandler
        window.dom.body.on("dragover", DOMEventHandler(
            lambda event: None, prevent_default=True))
        window.dom.body.on("drop", DOMEventHandler(
            drop_handler(push, on_error), prevent_default=True))
        window.evaluate_js("window.__nativeDropReady = true")
        return True
    except Exception as exc:
        if on_error:
            on_error(exc)
        return False


def _write_report(path, report):
    if path:
        target = os.path.abspath(path)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2)
    if sys.stdout is not None:
        print(json.dumps(report, ensure_ascii=False), flush=True)


def show_add_response(window, result):
    """结构化结果交由共用 UI 呈现，原生拖入也能看到未开始转换的原因。"""
    payload = json.dumps(result, ensure_ascii=True)
    window.evaluate_js(
        "if (typeof window.handleAddResponse === 'function') {"
        f"window.handleAddResponse({payload});"
        "} void 0;")


@contextmanager
def isolated_settings():
    """诊断不得读写用户的输出设置。"""
    import tempfile

    key = "QQMUSIC_UNLOCKER_CONFIG_DIR"
    previous = os.environ.get(key)
    with tempfile.TemporaryDirectory(prefix="qm-diagnostic-settings-") as folder:
        os.environ[key] = folder
        try:
            yield
        finally:
            if previous is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = previous


def selftest(report_path="") -> int:
    with isolated_settings():
        return _offline_selftest(report_path)


def _offline_selftest(report_path="") -> int:
    """离线检查打包资源、HTTP、路径、ffmpeg 与真实 MP3 转码，不读取登录凭据。"""
    import tempfile
    import urllib.error
    import urllib.request
    import wave

    report = {"ok": False, "version": APP_VERSION, "mode": "offline", "checks": []}
    httpd = None
    try:
        if eng.IS_WIN:
            import tkinter  # noqa: F401 —— 检查打包是否携带文件选择器
            import webview  # noqa: F401 —— 检查 pythonnet / pywebview 依赖
            import wincred  # noqa: F401 —— 不调用凭据读取函数
            report["checks"].append("windows_imports")
        token = uuid.uuid4().hex
        httpd, url = server.start_server(token=token)
        base = url.split("?")[0]
        with urllib.request.urlopen(url, timeout=5) as response:
            html = response.read().decode("utf-8")
        assert "<html" in html.lower(), "首页不是 HTML"
        for element_id in ("dropZone", "resultBar", "helpModal", "btnOpenOut"):
            assert f'id="{element_id}"' in html, f"首页缺少元素 {element_id}"
        with urllib.request.urlopen(base + "app.js", timeout=5) as response:
            appjs = response.read().decode("utf-8")
        assert token in appjs and "%%TOKEN%%" not in appjs, "token 未注入"
        report["checks"].append("ui_resources")
        try:
            urllib.request.urlopen(base + "api/state", timeout=5)
            raise AssertionError("API 未拒绝缺少 token 的请求")
        except urllib.error.HTTPError as exc:
            assert exc.code == 403
        req = urllib.request.Request(base + "api/state", headers={"X-Token": token})
        with urllib.request.urlopen(req, timeout=5) as response:
            assert "items" in json.load(response), "state 缺字段"
        report["checks"].append("authenticated_http")
        with tempfile.TemporaryDirectory(prefix="qm-selftest-") as tmp:
            folder = os.path.join(tmp, "中文 空格目录")
            os.makedirs(folder)
            probe = os.path.join(folder, "示例.mgg")
            with open(probe, "wb") as handle:
                handle.write(b"synthetic")
            got = []
            drop_handler(got.append)({"dataTransfer": {"files": [
                {"name": "示例.mgg", "pywebviewFullPath": probe}]}})
            assert got == [[probe]], "drop 未保留真实路径"
            assert file_args(["--flag", folder]) == [folder], "目录参数丢失"
            assert server.Handler.jobs.add([folder, probe]) == 1, "目录展开或去重失败"
            report["checks"].append("unicode_paths_and_drop")
            wav = os.path.join(folder, "输入.wav")
            mp3 = os.path.join(folder, "输出.mp3")
            with wave.open(wav, "wb") as handle:
                handle.setparams((1, 2, 22050, 0, "NONE", "not compressed"))
                handle.writeframes(b"\x00\x00" * 22050)
            eng.to_mp3(wav, mp3, {"title": "离线测试"}, "192k")
            info = eng.ffprobe(mp3)
            assert info["codec"] == "mp3" and info["duration"] > 0, "MP3 转码失败"
            report["checks"].append("ffmpeg_mp3_roundtrip")
        report["ok"] = True
    except Exception as exc:
        report["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        if httpd is not None:
            httpd.shutdown()
            httpd.server_close()
    _write_report(report_path, report)
    return 0 if report["ok"] else 1


def run_window(arg_paths: list[str], diagnostic_report=None) -> int:
    import webview

    token = uuid.uuid4().hex
    httpd, url = server.start_server(token=token)
    jobs = server.Handler.jobs
    diagnostic = diagnostic_report is not None
    report = {"ok": False, "version": APP_VERSION, "mode": "gui", "checks": []}
    try:
        window = webview.create_window(
            "QQ音乐解锁器", url=url, width=880, height=680,
            min_size=(640, 480), text_select=True, hidden=diagnostic)
    except Exception:
        httpd.shutdown()
        httpd.server_close()
        raise

    def push(paths):
        # 共用 UI 的设置保存屏障，避免原生拖入先于输出目录保存而开始转换。
        payload = json.dumps(paths, ensure_ascii=True)
        window.evaluate_js(
            f"void window.addPaths({payload}).catch(window.showError);")
        if not diagnostic:
            window.show()

    def drop_error(exc):
        message = str(exc)
        jobs.log(message, "error")
        show_add_response(window, {"added": 0, "error": message, "reason": message})

    def loaded():
        ok = install_drop(window, push, on_error=drop_error)
        if diagnostic:
            try:
                assert ok, "DOM 拖拽桥注册失败"
                assert window.evaluate_js("document.readyState") == "complete"
                assert window.evaluate_js("window.__nativeDropReady === true")
                assert window.evaluate_js("!!document.getElementById('dropZone')")
                report.update(ok=True, checks=["webview2_loaded", "native_drop_bound"])
            except Exception as exc:
                report["error"] = f"{type(exc).__name__}: {exc}"
            finally:
                window.destroy()

    window.events.loaded += loaded
    if arg_paths:
        # 加载后再展示和处理参数，避免窗口尚未创建就调用 show。
        window.events.loaded += lambda: push(arg_paths)

    def on_closing():
        if jobs.snapshot()["running"]:
            return window.create_confirmation_dialog(
                "正在转换", "关闭后将中断当前转换，确定关闭？")
        return True

    window.events.closing += on_closing
    try:
        webview.start(gui="edgechromium")
    except Exception as exc:
        if not diagnostic:
            raise
        report["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        httpd.shutdown()
        httpd.server_close()
    if diagnostic:
        if not report["ok"] and "error" not in report:
            report["error"] = "窗口在完成检查前关闭"
        _write_report(diagnostic_report, report)
        return 0 if report["ok"] else 1
    return 0


def _show_startup_error(exc):
    missing_runtime = isinstance(exc, MissingWebView2Error)
    if missing_runtime:
        message = ("未检测到 Microsoft Edge WebView2 Runtime，暂时无法显示界面。\n\n"
                   "点击「是」打开微软官方下载页，安装 Evergreen Runtime 后重新打开本程序。")
    else:
        message = ("窗口启动失败。\n请先完整解压下载包，再打开 QQMusicUnlocker.exe。\n"
                   "若仍失败，请在项目 Issues 中提供以下错误信息：\n\n"
                   + f"版本 {APP_VERSION}\n{type(exc).__name__}: {exc}")
    if eng.IS_WIN:
        import ctypes
        result = ctypes.windll.user32.MessageBoxW(
            None, message, "QQ音乐解锁器", 0x24 if missing_runtime else 0x10)
        if missing_runtime and result == 6:  # IDYES：仅在用户点击后打开官网
            import webbrowser
            webbrowser.open(WEBVIEW2_DOWNLOAD_URL)
    elif sys.stderr is not None:
        print(message, file=sys.stderr)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument("--gui-selftest", action="store_true")
    parser.add_argument("--selftest-report", default="")
    parser.add_argument("paths", nargs="*")
    args = parser.parse_args(argv)
    if args.selftest:
        return selftest(args.selftest_report)
    try:
        if eng.IS_WIN and webview2_runtime_version() == "":
            raise MissingWebView2Error("未检测到 WebView2 Evergreen Runtime")
        if args.gui_selftest:
            with isolated_settings():
                return run_window([], diagnostic_report=args.selftest_report)
        return run_window(file_args(args.paths))
    except Exception as exc:
        if args.gui_selftest:
            _write_report(args.selftest_report, {"ok": False, "mode": "gui", "checks": [],
                                                 "error": f"{type(exc).__name__}: {exc}"})
        else:
            _show_startup_error(exc)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
