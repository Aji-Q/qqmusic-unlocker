"""Windows 版入口：自带原生窗口（pywebview + 系统 WebView2），不打开浏览器。

和 macOS 版的 native/main.m 对应：服务在后台线程里跑，窗口一关就退出。

Windows 上两件专有的事：
1. **窗口内拖入文件**：WebView2 默认不给网页真实文件路径，但 pywebview 的 DOM
   事件桥会把路径塞进 `event['dataTransfer']['files'][i]['pywebviewFullPath']`
   （见 webview/platforms/edgechromium.py 与 webview/util.py 的 drop 分支）。
   所以拖拽必须走 pywebview 的 dom API 注册 'drop' 监听，不能靠网页那套
   webkitGetAsEntry()。
2. **拖到 exe 图标 / 右键「打开方式」**：路径作为命令行参数进来，直接灌进队列。

窗口有意保持极简：网页只显示一个大投放区 + 一行设置 + 结果条，详情藏在抽屉里。

打包：PyInstaller 以本文件为入口（见 .github/workflows/build-windows.yml）。
自测：`python win/launcher.py --selftest` 不开窗口，跑一遍服务自检后退出。
"""
from __future__ import annotations

import os
import sys
import uuid

# Windows 控制台默认 cp936/cp1252，打印中文会 UnicodeEncodeError；强制 UTF-8。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

# 让 "import server / qmengine" 能找到 app/（源码运行与 PyInstaller 打包都适用）
_HERE = os.path.dirname(os.path.abspath(__file__))
_APP = os.path.join(getattr(sys, "_MEIPASS", os.path.dirname(_HERE)), "app")
if os.path.isdir(_APP):
    sys.path.insert(0, _APP)
else:  # PyInstaller 把 app/ 内容平铺到根时
    sys.path.insert(0, getattr(sys, "_MEIPASS", _HERE))

import server  # noqa: E402  —— app/server.py
import qmengine as eng  # noqa: E402


def file_args(argv: list[str]) -> list[str]:
    """从命令行 argv 里取出真实存在的文件/目录路径。

    覆盖两种入口：把音频拖到 exe 图标上（参数=文件）、右键「打开方式」。
    跳过 PyInstaller/WebView2 可能塞进来的开关参数。
    """
    out = []
    for a in argv:
        if a.startswith("-"):
            continue
        path = os.path.abspath(a)
        if os.path.exists(path):
            out.append(path)
    return out


# --------------------------------------------------------------------------- 拖拽

def install_drop(win, push, on_error=None) -> bool:
    """给窗口挂 'drop' 监听，拿到真实路径后交给 push(paths)。

    pywebview 会在事件里附上 'pywebviewFullPath'（仅 WebView2 有效）；
    拿不到就回退到 name，仍然是可用的绝对路径。
    """
    try:
        from webview.dom import DOMEventHandler
        win.dom.body.on("drop", DOMEventHandler(drop_handler(push, on_error),
                                                prevent_default=True,
                                                stop_propagation=True))
        return True
    except Exception as exc:  # noqa: BLE001
        if on_error:
            on_error(exc)
        return False


def drop_handler(push, on_error=None):
    """纯函数式拆出来，方便自测直接喂一个事件字典验证路径提取。"""

    def _handler(event):
        try:
            files = (event.get("dataTransfer") or {}).get("files") or []
            paths = []
            for f in files:
                p = f.get("pywebviewFullPath") or f.get("path") or f.get("name")
                if p and os.path.exists(p):
                    paths.append(p)
            if paths:
                push(paths)
        except Exception as exc:  # noqa: BLE001 —— 回调里抛错会污染事件线程
            if on_error:
                on_error(exc)

    return _handler


def selftest() -> int:
    """无显示环境的冒烟测试：启动服务、打一次自检、命中首页，然后退出。
    不依赖 QQ 音乐登录态（CI 环境没有），凭据缺失是预期结果。"""
    import json
    import tempfile
    import urllib.request

    token = uuid.uuid4().hex
    httpd, url = server.start_server(token=token)
    try:
        st = eng.engine_status()
        print("engine_status:", json.dumps(st, ensure_ascii=False))
        base = url.split("?")[0]
        # 首页是 HTML，token 注入在 app.js（前端 fetch 带 X-Token）
        html = urllib.request.urlopen(urllib.request.Request(url), timeout=5
                                      ).read().decode("utf-8", "ignore")
        assert "<html" in html.lower(), "首页不是 HTML"
        appjs = urllib.request.urlopen(base + "app.js", timeout=5).read().decode("utf-8", "ignore")
        assert token in appjs, "token 未注入 app.js"
        # 页面里拖拽所依赖的元素必须存在，否则回调无处挂
        for eid in ("dropZone", "resultBar", "helpModal", "btnOpenOut"):
            assert f'id="{eid}"' in html, f"首页缺少元素 {eid}"
        # /api/state 需要 token
        api = urllib.request.Request(base + "api/state", headers={"X-Token": token})
        state = json.loads(urllib.request.urlopen(api, timeout=5).read())
        assert "items" in state, "state 缺字段"
        # /api/open 自动开始：拖入即跑
        payload = json.dumps({"paths": []}).encode()
        req = urllib.request.Request(base + "api/open", data=payload,
                                     headers={"X-Token": token,
                                              "Content-Type": "application/json"})
        openres = json.loads(urllib.request.urlopen(req, timeout=5).read())
        assert "started" in openres, "/api/open 未返回 started"
        # 拖拽回调：喂一个模拟事件，验证能取出真实路径并灌进队列
        with tempfile.TemporaryDirectory() as tmp:
            probe = os.path.join(tmp, "probe.mgg")
            open(probe, "wb").write(b"x")
            got = []
            handler = drop_handler(got.append)
            handler({"dataTransfer": {"files": [
                {"name": "probe.mgg", "pywebviewFullPath": probe},
                {"name": "ghost.mgg", "pywebviewFullPath": os.path.join(tmp, "nope.mgg")},
            ]}})
            assert got == [[probe]], f"drop 回调取路径错误：{got}"
        # 拖到 exe 图标：命令行参数解析
        assert file_args(["--flag", sys.executable]) == [sys.executable], "file_args 解析错误"
        # ffmpeg / ffprobe 必须随包可用
        assert st["ffmpeg"] and st["ffprobe"], "ffmpeg/ffprobe 不可用（打包漏了？）"
    finally:
        httpd.shutdown()
    print("SELFTEST OK")


def run_window(arg_paths: list[str]) -> int:
    import webview  # pywebview，惰性导入：selftest 不需要它

    token = uuid.uuid4().hex
    _httpd, url = server.start_server(token=token)
    jobs = server.Handler.jobs

    window = webview.create_window(
        "QQ音乐解锁器", url=url, width=880, height=680,
        min_size=(640, 480), text_select=True)

    def push(paths):
        added = jobs.add(paths)
        if added:
            jobs.start()          # 拖进来就直接跑，不用再点按钮
        window.show()

    # 窗口内拖入
    install_drop(window, push,
                 on_error=lambda exc: print("拖拽监听未装上：", exc))

    # 命令行带文件（拖到 exe 图标 / 右键打开方式）
    if arg_paths:
        push(arg_paths)

    # 关窗时若还有任务在跑，先确认，避免误关打断转换
    def on_closing():
        try:
            if jobs.snapshot()["running"]:
                import webview as _w
                return _w.windows[0].create_confirmation_dialog(
                    "还在转换中", "有文件正在处理，确定要关闭吗？")
        except Exception:  # noqa: BLE001
            pass
        return True

    try:
        window.events.closing += on_closing
    except Exception:  # noqa: BLE001 —— 老版本 pywebview 没有该事件
        pass

    window.events.closed += lambda: os._exit(0)
    webview.start()  # 阻塞直到窗口关闭
    return 0


def main() -> int:
    if "--selftest" in sys.argv:
        # subtle: PyInstaller --windowed 的 exe 在解释器正常退出时会因 stderr
        # flush 把退出码变成 1。selftest 用 os._exit 绕过退出清理，确定性返回码。
        try:
            selftest()
        except BaseException as exc:  # noqa: BLE001
            print("SELFTEST FAILED:", exc)
            sys.stdout.flush()
            os._exit(1)
        sys.stdout.flush()
        os._exit(0)
    return run_window(file_args(sys.argv[1:]))


if __name__ == "__main__":
    raise SystemExit(main())
