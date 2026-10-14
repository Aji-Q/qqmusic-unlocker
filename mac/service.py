"""Frozen macOS background service; the window stays in the native WKWebView shell."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))


def selftest(report_path="") -> int:
    """Run offline in an isolated profile: packaged resources, HTTP and real audio conversion."""
    import tempfile
    import urllib.error
    import urllib.request
    import uuid
    import wave

    report = {"ok": False, "mode": "offline", "checks": [], "platform": sys.platform}
    httpd = None
    try:
        with tempfile.TemporaryDirectory(prefix="qm-selftest-") as tmp:
            os.environ["QQMUSIC_UNLOCKER_CONFIG_DIR"] = str(Path(tmp) / "settings")
            import server
            import qmengine as eng
            from version import APP_VERSION
            report["version"] = APP_VERSION
            if getattr(sys, "frozen", False):
                root = Path(sys.executable).resolve().parent
                for binary in (eng.FFMPEG, eng.FFPROBE):
                    assert Path(binary).resolve().is_relative_to(root), f"媒体工具未包含在应用内: {binary}"
            token = uuid.uuid4().hex
            runtime = str(Path(tmp) / "runtime.json")
            httpd, url = server.start_server(token=token, runtime_file=runtime)
            base = url.split("?")[0]
            with urllib.request.urlopen(url, timeout=5) as response:
                html = response.read().decode("utf-8")
            assert '<html' in html.lower() and 'id="dropZone"' in html, "首页资源缺失"
            with urllib.request.urlopen(base + "app.js", timeout=5) as response:
                script = response.read().decode("utf-8")
            assert token in script and "%%TOKEN%%" not in script, "认证令牌未注入"
            report["checks"].append("ui_resources")
            try:
                urllib.request.urlopen(base + "api/state", timeout=5)
                raise AssertionError("API 接受了无凭据请求")
            except urllib.error.HTTPError as exc:
                assert exc.code == 403
            req = urllib.request.Request(base + "api/state", headers={"X-Token": token})
            with urllib.request.urlopen(req, timeout=5) as response:
                assert "items" in json.load(response)
            rt = json.loads(Path(runtime).read_text())
            assert rt["version"] == APP_VERSION
            assert rt["service_path"] == os.path.realpath(sys.executable if getattr(sys, "frozen", False) else server.__file__)
            report["checks"].append("authenticated_http_and_runtime_identity")
            folder = Path(tmp) / "中文 空格目录"
            folder.mkdir()
            wav, mp3 = folder / "输入.wav", folder / "输出.mp3"
            with wave.open(str(wav), "wb") as handle:
                handle.setparams((1, 2, 22050, 0, "NONE", "not compressed"))
                handle.writeframes(b"\x00\x00" * 22050)
            eng.to_mp3(str(wav), str(mp3), {"title": "离线测试"}, "192k")
            info = eng.ffprobe(str(mp3))
            assert info["codec"] == "mp3" and info["duration"] > 0, "转码校验失败"
            report["checks"].append("bundled_ffmpeg_mp3_unicode_path")
            report["ok"] = True
    except Exception as exc:
        report["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        if httpd is not None:
            httpd.shutdown()
            httpd.server_close()
    if report_path:
        path = Path(report_path).resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False), flush=True)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        import argparse
        parser = argparse.ArgumentParser()
        parser.add_argument("--selftest", action="store_true")
        parser.add_argument("--selftest-report", default="")
        args = parser.parse_args()
        raise SystemExit(selftest(args.selftest_report))
    import server
    server.main()
