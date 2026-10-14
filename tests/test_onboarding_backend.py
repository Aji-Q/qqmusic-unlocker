"""首次使用与失败恢复回归；只使用合成文件、临时配置和模拟接口。"""
from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import threading
import types
import unittest
from unittest import mock
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))
import qmengine as eng
import server
import settings


class IsolatedJobsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="qq-onboarding-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.config = self.directory / "preferences" / "settings.json"
        self.jobs = server.Jobs(eng.EkeyCache(), settings_path=str(self.config))

    def source(self, name="track.mgg"):
        path = self.directory / name
        path.write_bytes(b"synthetic")
        return str(path)


class SettingsTests(IsolatedJobsTest):
    def test_preferences_survive_restart_and_only_contain_output_options(self):
        output = str(self.directory / "我的音乐")
        self.jobs.configure(output, "192k", True)
        restarted = server.Jobs(eng.EkeyCache(), settings_path=str(self.config))
        self.assertEqual((restarted.outdir, restarted.bitrate, restarted.keep_ogg),
                         (output, "192k", True))
        self.assertEqual(set(json.loads(self.config.read_text())),
                         {"version", "outdir", "bitrate", "keep_ogg"})

    def test_corrupt_or_invalid_settings_fall_back_without_overwriting(self):
        self.config.parent.mkdir()
        for content in ("broken JSON", "[]", '{"keep_ogg":"false"}', '{"bitrate":"999k"}'):
            self.config.write_text(content)
            restarted = server.Jobs(eng.EkeyCache(), settings_path=str(self.config))
            self.assertEqual(restarted.bitrate, "320k")
            self.assertFalse(restarted.keep_ogg)
            self.assertTrue(restarted.settings_warning)
            self.assertEqual(self.config.read_text(), content)

    def test_invalid_configuration_does_not_change_current_settings(self):
        before = (self.jobs.outdir, self.jobs.bitrate, self.jobs.keep_ogg)
        for kwargs in ({"outdir": "relative"}, {"outdir": ""}, {"bitrate": "123k"},
                       {"keep_ogg": "false"}, {"outdir": "bad\x00path"}):
            with self.assertRaises(eng.EngineError) as raised:
                self.jobs.configure(**kwargs)
            self.assertEqual(raised.exception.action, "settings")
            self.assertEqual((self.jobs.outdir, self.jobs.bitrate, self.jobs.keep_ogg), before)
        self.assertFalse(self.config.exists())

    def test_atomic_save_failure_preserves_previous_file_and_memory(self):
        self.jobs.configure(bitrate="192k")
        previous = self.config.read_bytes()
        with mock.patch.object(settings.os, "replace", side_effect=PermissionError("synthetic")):
            with self.assertRaises(eng.EngineError):
                self.jobs.configure(bitrate="256k")
        self.assertEqual(self.jobs.bitrate, "192k")
        self.assertEqual(self.config.read_bytes(), previous)
        self.assertEqual(list(self.config.parent.iterdir()), [self.config])

    def test_running_jobs_reject_configuration_without_writing(self):
        self.jobs.running = True
        with self.assertRaises(eng.EngineError) as raised:
            self.jobs.configure(bitrate="128k")
        self.assertEqual(raised.exception.status, 409)
        self.assertFalse(self.config.exists())

    def test_windows_settings_live_outside_qqmusic_credentials(self):
        with mock.patch.object(sys, "platform", "win32"), mock.patch.dict(
                os.environ, {"LOCALAPPDATA": str(self.directory), "QQMUSIC_UNLOCKER_CONFIG_DIR": ""}):
            self.assertEqual(settings.default_path(), str(self.directory / "QQMusicUnlocker" / "settings.json"))


class QueueRecoveryTests(IsolatedJobsTest):
    def test_clear_completed_preserves_waiting_and_failed_for_retry(self):
        for status in ("等待", "完成", "失败"):
            item = server.Item(str(self.directory / (status + ".mgg")))
            item.status = status
            self.jobs.items.append(item)
        self.assertTrue(self.jobs.clear(only_finished=True))
        self.assertEqual([item.status for item in self.jobs.items], ["等待", "失败"])

    def test_add_report_distinguishes_duplicate_unsupported_missing_and_empty(self):
        source = self.source()
        unsupported = self.source("readme.txt")
        empty = self.directory / "empty"
        empty.mkdir()
        report = self.jobs.add_report([source, source, unsupported,
                                       str(self.directory / "missing.mgg"), str(empty)])
        self.assertEqual({key: report[key] for key in
                          ("added", "duplicate", "unsupported", "missing", "empty_folders")},
                         {"added": 1, "duplicate": 1, "unsupported": 1, "missing": 1, "empty_folders": 1})
        self.assertEqual(report["skipped"], 3)
        self.assertEqual(report["reason"], "added")

    def test_folder_without_supported_files_reports_unsupported(self):
        self.source("readme.txt")
        report = self.jobs.add_report([str(self.directory)])
        self.assertEqual(report["added"], 0)
        self.assertEqual(report["unsupported"], 1)
        self.assertEqual(report["empty_folders"], 1)
        self.assertEqual(report["reason"], "unsupported")

    def test_failed_preflight_preserves_failed_item_and_does_not_start_worker(self):
        self.jobs.add([self.source()])
        item = self.jobs.items[0]
        item.status, item.error, item.progress = "失败", "previous error", 0.2
        with mock.patch.object(eng, "check_dependencies", side_effect=eng.EngineError(
                "缺少 ffprobe", code="dependencies", action="dependencies")), mock.patch.object(
                threading, "Thread") as worker:
            ok, message = self.jobs.start()
        self.assertFalse(ok)
        self.assertEqual(message, "缺少 ffprobe")
        self.assertEqual((item.status, item.error, item.progress), ("失败", "previous error", 0.2))
        self.assertFalse(self.jobs.running)
        self.assertEqual(self.jobs.start_error["action"], "dependencies")
        worker.assert_not_called()

    def test_unwritable_output_fails_before_consuming_queue(self):
        self.jobs.add([self.source()])
        with mock.patch.object(eng, "check_dependencies"), mock.patch.object(
                eng, "check_output_dir", side_effect=eng.EngineError(
                    "输出目录不可写", code="output_unwritable", action="settings")):
            self.assertFalse(self.jobs.start()[0])
        self.assertEqual(self.jobs.items[0].status, "等待")
        self.assertEqual(self.jobs.start_error["action"], "settings")

    def test_open_auto_start_failure_keeps_added_file_with_recovery_action(self):
        with mock.patch.object(eng, "check_dependencies", side_effect=eng.EngineError(
                "缺少 ffmpeg", code="dependencies", action="dependencies")):
            report = self.jobs.open_paths([self.source()])
        self.assertEqual(report["added"], 1)
        self.assertFalse(report["started"])
        self.assertEqual(report["start_error"]["action"], "dependencies")
        self.assertEqual(self.jobs.items[0].status, "等待")

    def test_new_files_join_running_queue_without_false_busy_error(self):
        self.jobs.running = True
        with mock.patch.object(self.jobs, "start") as start:
            report = self.jobs.open_paths([self.source()])
        start.assert_not_called()
        self.assertTrue(report["queued"])
        self.assertIsNone(report["start_error"])

    def test_successful_preflight_resets_failure_then_converts(self):
        self.jobs.add([self.source()])
        self.jobs.items[0].status = "失败"
        result = {"footer": "V1", "mp3": "synthetic.mp3", "size": 10,
                  "codec": "flac", "src_bitrate": 1000, "duration": 1, "tags": {}}
        with mock.patch.object(eng, "check_dependencies") as dependencies, mock.patch.object(
                eng, "check_output_dir") as output, mock.patch.object(eng, "decrypt_file", return_value=result):
            self.assertTrue(self.jobs.start()[0])
            self.jobs.worker.join(timeout=2)
        dependencies.assert_called_once()
        output.assert_called_once()
        self.assertEqual(self.jobs.items[0].status, "完成")
        self.assertFalse(self.jobs.running)


class EngineRecoveryTests(unittest.TestCase):
    def test_missing_credentials_have_login_action(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(eng, "IS_WIN", False), mock.patch.object(
                eng, "PLIST", os.path.join(folder, "missing.plist")):
            with self.assertRaises(eng.EngineError) as raised:
                eng.read_credentials()
        self.assertEqual(raised.exception.action, "login")

    def test_network_failure_has_retry_without_claiming_account_entitlement(self):
        with mock.patch.object(eng.urllib.request, "urlopen", side_effect=urllib.error.URLError("offline")):
            with self.assertRaises(eng.EngineError) as raised:
                eng.fetch_ekey("fake", "fake", eng.Credentials("123", "synthetic", "1", 0))
        self.assertEqual(raised.exception.code, "network")
        self.assertEqual(raised.exception.action, "retry")
        self.assertNotIn("VIP", str(raised.exception))

    def test_empty_key_does_not_assert_vip_and_offers_login_recovery(self):
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(
            {"req_1": {"data": {"midurlinfo": [{"result": 104005}]}}}).encode()
        with mock.patch.object(eng.urllib.request, "urlopen", return_value=response):
            with self.assertRaises(eng.EngineError) as raised:
                eng.fetch_ekey("fake", "fake", eng.Credentials("123", "synthetic", "1", 0))
        self.assertEqual(raised.exception.code, "key_unavailable")
        self.assertNotIn("VIP", str(raised.exception))

    def test_preflight_runs_both_tools_and_rejects_broken_executable(self):
        with mock.patch.object(eng, "_run_media", return_value=types.SimpleNamespace(returncode=0)) as run:
            eng.check_dependencies()
        self.assertEqual([call.args[0][0] for call in run.call_args_list], [eng.FFMPEG, eng.FFPROBE])
        with mock.patch.object(eng, "_run_media", return_value=types.SimpleNamespace(returncode=1)):
            with self.assertRaises(eng.EngineError) as raised:
                eng.check_dependencies()
        self.assertEqual(raised.exception.action, "dependencies")

    def test_output_directory_write_probe_cleans_up_and_reports_permissions(self):
        with tempfile.TemporaryDirectory() as folder:
            eng.check_output_dir(folder)
            self.assertEqual(os.listdir(folder), [])
            with mock.patch.object(eng.tempfile, "TemporaryFile", side_effect=PermissionError("synthetic")):
                with self.assertRaises(eng.EngineError) as raised:
                    eng.check_output_dir(folder)
        self.assertEqual(raised.exception.action, "settings")


class OutputSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.raw = b"fLaC" + b"synthetic" * 10
        key = b"12345678"
        encrypted = bytearray(self.raw)
        eng.make_cipher(key).decrypt(0, encrypted)
        encoded_key = base64.b64encode(key)
        self.fixture = encrypted + encoded_key + struct.pack("<I", len(encoded_key))
        self.source = self.directory / "song.mflac"
        self.source.write_bytes(self.fixture)
        for target, value in (("ffprobe", {"codec": "flac", "duration": 1, "bitrate": 1000}),
                              ("db_lookup", None), ("find_cover", None)):
            patch = mock.patch.object(eng, target, return_value=value)
            patch.start()
            self.addCleanup(patch.stop)
        patch = mock.patch.object(eng, "to_mp3", side_effect=lambda src, dst, *args: Path(dst).write_bytes(b"mp3"))
        patch.start()
        self.addCleanup(patch.stop)

    def convert(self, keep=False):
        return eng.decrypt_file(str(self.source), str(self.directory), keep_ogg=keep)

    def test_existing_mp3_is_never_overwritten_and_source_stays_unchanged(self):
        existing = self.directory / "song.mp3"
        existing.write_bytes(b"keep existing")
        first = self.convert()
        second = self.convert()
        self.assertEqual(Path(first["mp3"]).name, "song (2).mp3")
        self.assertEqual(Path(second["mp3"]).name, "song (3).mp3")
        self.assertEqual(existing.read_bytes(), b"keep existing")
        self.assertEqual(self.source.read_bytes(), self.fixture)

    def test_original_format_collision_numbers_both_outputs_consistently(self):
        original = self.directory / "song.flac"
        original.write_bytes(b"existing flac")
        result = self.convert(keep=True)
        self.assertEqual(Path(result["mp3"]).name, "song (2).mp3")
        self.assertEqual(Path(result["original"]).name, "song (2).flac")
        self.assertEqual(original.read_bytes(), b"existing flac")
        self.assertEqual(Path(result["original"]).read_bytes(), self.raw)
        self.assertFalse((self.directory / "song.mp3").exists())

    def test_concurrent_conversions_allocate_distinct_complete_outputs(self):
        with ThreadPoolExecutor(max_workers=6) as workers:
            results = list(workers.map(lambda _: self.convert(keep=True), range(12)))
        self.assertEqual(len({result["mp3"] for result in results}), 12)
        for result in results:
            self.assertEqual(Path(result["mp3"]).read_bytes(), b"mp3")
            self.assertEqual(Path(result["original"]).read_bytes(), self.raw)
            self.assertEqual(Path(result["mp3"]).stem, Path(result["original"]).stem)
        self.assertFalse(any(path.name.startswith(".qmdec-") for path in self.directory.iterdir()))

    def test_conversion_failure_removes_partial_files(self):
        def fail(src, dst, *args):
            Path(dst).write_bytes(b"partial")
            raise eng.EngineError("synthetic failure")
        with mock.patch.object(eng, "to_mp3", side_effect=fail):
            with self.assertRaises(eng.EngineError):
                self.convert(keep=True)
        self.assertEqual(list(self.directory.iterdir()), [self.source])

    def test_publish_failure_rolls_back_only_this_attempt(self):
        existing = self.directory / "song.mp3"
        existing.write_bytes(b"existing")
        replace = os.replace
        def fail_original(source, target):
            if str(target).endswith(".flac"):
                raise PermissionError("synthetic publish failure")
            return replace(source, target)
        with mock.patch.object(eng.os, "replace", side_effect=fail_original):
            with self.assertRaises(eng.EngineError):
                self.convert(keep=True)
        self.assertEqual(set(self.directory.iterdir()), {self.source, existing})
        self.assertEqual(existing.read_bytes(), b"existing")


class HTTPRecoveryTests(IsolatedJobsTest):
    def setUp(self):
        super().setUp()
        handler = type("IsolatedHandler", (server.Handler,), {"jobs": self.jobs, "token": ""})
        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def close_server(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)

    def post(self, path, data):
        request = urllib.request.Request(self.url + path, json.dumps(data).encode(),
                                         {"Content-Type": "application/json"})
        try:
            response = urllib.request.urlopen(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read())

    def test_invalid_config_and_running_config_return_structured_errors(self):
        code, response = self.post("/api/config", {"keep_ogg": "false"})
        self.assertEqual(code, 400)
        self.assertEqual(response["action"], "settings")
        self.assertIn("error", response)
        self.jobs.running = True
        code, response = self.post("/api/config", {"bitrate": "128k"})
        self.assertEqual(code, 409)
        self.assertEqual(response["code"], "busy")

    def test_invalid_json_shape_does_not_crash_handler(self):
        for payload in ([], None, "bad"):
            code, response = self.post("/api/config", payload)
            self.assertEqual(code, 400)
            self.assertEqual(response["code"], "invalid_request")

    def test_open_reports_missing_paths_instead_of_discarding_them(self):
        code, response = self.post("/api/open", {"paths": [str(self.directory / "missing.mgg")]})
        self.assertEqual(code, 200)
        self.assertEqual(response["missing"], 1)
        self.assertEqual(response["reason"], "missing")

    def test_start_error_returns_action_and_keeps_queue(self):
        self.jobs.add([self.source()])
        with mock.patch.object(eng, "check_dependencies", side_effect=eng.EngineError(
                "缺少工具", code="dependencies", action="dependencies")):
            code, response = self.post("/api/start", {})
        self.assertEqual(code, 200)
        self.assertFalse(response["ok"])
        self.assertEqual(response["action"], "dependencies")
        self.assertEqual(self.jobs.items[0].status, "等待")

    def test_folder_cancel_and_unsupported_folder_have_distinct_reasons(self):
        with mock.patch.object(server, "pick_folder", return_value=""):
            _, response = self.post("/api/pick/folder", {})
        self.assertEqual(response["reason"], "cancelled")
        self.source("notes.txt")
        with mock.patch.object(server, "pick_folder", return_value=str(self.directory)):
            _, response = self.post("/api/pick/folder", {})
        self.assertEqual(response["reason"], "unsupported")
        self.assertEqual(response["unsupported"], 1)

    def test_folder_added_while_running_joins_queue_without_busy_error(self):
        self.source()
        self.jobs.running = True
        with mock.patch.object(server, "pick_folder", return_value=str(self.directory)), mock.patch.object(
                self.jobs, "start") as start:
            code, response = self.post("/api/pick/folder", {})
        self.assertEqual(code, 200)
        self.assertEqual(response["added"], 1)
        self.assertTrue(response["queued"])
        self.assertFalse(response["started"])
        self.assertIsNone(response["start_error"])
        start.assert_not_called()

    def test_reveal_directory_opens_it_instead_of_selecting_it(self):
        with mock.patch.object(server, "IS_WIN", False), mock.patch.object(server.subprocess, "run") as run:
            code, _ = self.post("/api/reveal", {"path": str(self.directory)})
        self.assertEqual(code, 200)
        self.assertEqual(run.call_args.args[0], ["open", str(self.directory)])

    def test_open_qqmusic_failure_gives_install_or_manual_open_hint(self):
        with mock.patch.object(server, "IS_WIN", False), mock.patch.object(
                server.subprocess, "run", return_value=types.SimpleNamespace(returncode=1)):
            code, response = self.post("/api/qqmusic/open", {})
        self.assertEqual(code, 400)
        self.assertEqual(response["code"], "qqmusic_missing")
        self.assertIn("安装", response["hint"])

    def test_parallel_picker_request_is_rejected_instead_of_opened_later(self):
        opened, release = threading.Event(), threading.Event()
        def hold_picker():
            opened.set()
            self.assertTrue(release.wait(timeout=5))
            return []
        with mock.patch.object(server, "pick_files", side_effect=hold_picker), mock.patch.object(
                server, "pick_folder") as folder:
            with ThreadPoolExecutor(max_workers=1) as workers:
                request = workers.submit(self.post, "/api/pick/files", {})
                try:
                    self.assertTrue(opened.wait(timeout=2))
                    code, response = self.post("/api/pick/folder", {})
                    self.assertEqual(code, 409)
                    self.assertEqual(response["code"], "picker_busy")
                    folder.assert_not_called()
                finally:
                    release.set()
                self.assertEqual(request.result(timeout=2)[0], 200)
        self.assertFalse(server.PICKER_LOCK.locked())

    def test_picker_error_releases_lock_for_next_attempt(self):
        with mock.patch.object(server, "pick_files", side_effect=RuntimeError("synthetic")):
            code, response = self.post("/api/pick/files", {})
        self.assertEqual(code, 500)
        self.assertEqual(response["code"], "picker_failed")
        with mock.patch.object(server, "pick_files", return_value=[]):
            self.assertEqual(self.post("/api/pick/files", {})[0], 200)


if __name__ == "__main__":
    unittest.main()
