"""Windows 版入口：在自带的原生窗口（pywebview + 系统 WebView2）里显示界面，
不打开浏览器。服务在本进程内起一个后台线程，关窗即退出。

对应 macOS 的 native/main.m（WKWebView 窗口）。界面、引擎、HTTP 服务三者
与 macOS 完全共用 app/ 下的代码。

打包：PyInstaller 以本文件为入口，把 app/ 与 ffmpeg.exe 一并带上（见 .github
的构建工作流）。自测：`python win/launcher.py --selftest` 不开窗口，跑一遍服务
自检后退出，供 CI 在无显示环境下验证。

命令行自测：
    python win/launcher.py --selftest
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


def selftest() -> int:
    """无显示环境的冒烟测试：启动服务、打一次自检、命中首页，然后退出。
    不依赖 QQ 音乐登录态（CI 环境没有），凭据缺失是预期结果。"""
    import json
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
        # /api/state 需要 token
        api = urllib.request.Request(base + "api/state", headers={"X-Token": token})
        state = json.loads(urllib.request.urlopen(api, timeout=5).read())
        assert "items" in state, "state 缺字段"
        # ffmpeg / ffprobe 必须随包可用
        assert st["ffmpeg"] and st["ffprobe"], "ffmpeg/ffprobe 不可用（打包漏了？）"
    finally:
        httpd.shutdown()
    print("SELFTEST OK")


def run_window() -> int:
    import webview  # pywebview，惰性导入：selftest 不需要它

    token = uuid.uuid4().hex
    _httpd, url = server.start_server(token=token)

    window = webview.create_window(
        "QQ音乐解锁器", url=url, width=1080, height=760,
        min_size=(720, 520), text_select=True)

    # 关窗 = 退出整个程序（服务线程是 daemon，随进程结束）
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
    return run_window()


if __name__ == "__main__":
    raise SystemExit(main())
