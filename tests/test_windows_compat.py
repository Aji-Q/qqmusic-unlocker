"""离线回归：标准流、生命周期、Windows 路径与共享转码行为。"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'app'), str(ROOT / 'win')]
import launcher
import qmengine as eng
import server
import wincred


class QueueTests(unittest.TestCase):
    def make_jobs(self):
        jobs = server.Jobs(eng.EkeyCache())
        for status in ("等待", "完成", "失败"):
            item = server.Item("synthetic-" + status + ".mgg")
            item.status = status
            jobs.items.append(item)
        return jobs

    def test_clear_all_removes_waiting_completed_and_failed(self):
        jobs = self.make_jobs()
        self.assertTrue(jobs.clear(only_finished=False))
        self.assertEqual(jobs.snapshot()["stats"]["total"], 0)

    def test_clear_finished_keeps_waiting(self):
        jobs = self.make_jobs()
        self.assertTrue(jobs.clear(only_finished=True))
        self.assertEqual([i.status for i in jobs.items], ["等待"])

    def test_clear_rejects_active_queue_before_worker_picks_file(self):
        jobs = self.make_jobs()
        jobs.running = True
        self.assertFalse(jobs.clear(only_finished=False))
        self.assertEqual(len(jobs.items), 3)

    def test_stopping_is_visible_only_until_worker_finishes(self):
        jobs = self.make_jobs()
        self.assertFalse(jobs.snapshot()["stopping"])
        jobs.running = True
        self.assertTrue(jobs.stop())
        self.assertTrue(jobs.snapshot()["stopping"])
        with mock.patch.object(jobs, "_process") as process:
            jobs._run()
        process.assert_not_called()
        self.assertFalse(jobs.snapshot()["running"])
        self.assertFalse(jobs.snapshot()["stopping"])
        self.assertEqual(jobs.items[0].status, "等待")


class PathTests(unittest.TestCase):
    def test_folder_input_expands_and_deduplicates(self):
        with tempfile.TemporaryDirectory(prefix='中文 空格 ') as folder:
            nested = Path(folder) / '子目录'
            nested.mkdir()
            track = nested / '歌曲.MFLAC'
            track.write_bytes(b'fixture')
            (nested / 'readme.txt').write_text('ignore')
            jobs = server.Jobs(eng.EkeyCache())
            self.assertEqual(jobs.add([folder, str(track)]), 1)
            self.assertEqual([i.path for i in jobs.items], [str(track)])

    def test_drop_requires_absolute_path_not_basename(self):
        got = []
        with mock.patch('launcher.os.path.exists', return_value=True):
            launcher.drop_handler(got.append)({'dataTransfer': {'files': [
                {'name': 'local.mgg'}, {'path': 'relative.mgg'}]}})
        self.assertEqual(got, [])

    def test_empty_appdata_uses_user_home(self):
        with mock.patch.dict(os.environ, {'APPDATA': ''}):
            self.assertEqual(wincred.qqmusic_dir(), os.path.join(
                os.path.expanduser('~'), 'AppData', 'Roaming', 'Tencent', 'QQMusic'))

    def test_windows_redirected_desktop(self):
        import ctypes
        def get_folder(hwnd, csidl, token, flags, buffer):
            self.assertEqual(csidl, 0x10)
            buffer.value = r'C:\Users\example\OneDrive\桌面'
            return 0
        windll = types.SimpleNamespace(shell32=types.SimpleNamespace(SHGetFolderPathW=get_folder))
        with mock.patch.object(eng, 'IS_WIN', True), mock.patch.object(ctypes, 'windll', windll, create=True):
            self.assertEqual(eng.default_output_dir(), r'C:\Users\example\OneDrive\桌面')

    def test_frozen_ffmpeg_can_live_in_internal_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            binary = Path(folder) / 'ffmpeg.exe'
            binary.write_bytes(b'fixture')
            with mock.patch.object(eng, 'IS_WIN', True), mock.patch.object(sys, 'frozen', True, create=True), mock.patch.object(sys, '_MEIPASS', folder, create=True):
                self.assertEqual(eng._ffbin('ffmpeg'), str(binary))


class CredentialParsingTests(unittest.TestCase):
    def test_utf16_ini_and_numeric_uin(self):
        self.assertEqual(wincred.parse_uin(wincred._decode('[Config]\nUin=12345'.encode('utf-16'))), '12345')
        for invalid in ('0', '-1', 'not-a-number', '１２３'):
            self.assertIsNone(wincred.parse_uin('Uin=' + invalid))

    def test_synthetic_cookie_only(self):
        self.assertEqual(wincred.authst_from_blob(b'{"authst":"synthetic_token_123456"}'), 'synthetic_token_123456')

    def test_permission_error_is_user_readable(self):
        with mock.patch.object(eng, 'IS_WIN', True), mock.patch.object(eng, 'wincred', wincred, create=True), mock.patch.object(wincred, 'read_credentials', side_effect=PermissionError('denied')):
            with self.assertRaisesRegex(eng.EngineError, 'denied'):
                eng.read_credentials()


class MediaTests(unittest.TestCase):
    def test_windows_subprocess_has_no_console_and_decodes_utf8(self):
        with mock.patch.object(eng, 'IS_WIN', True), mock.patch.object(eng.subprocess, 'CREATE_NO_WINDOW', 0x08000000, create=True), mock.patch.object(eng.subprocess, 'run') as run:
            eng._run_media(['ffmpeg.exe', '-version'])
        self.assertEqual(run.call_args.kwargs['creationflags'], 0x08000000)
        self.assertEqual(run.call_args.kwargs['encoding'], 'utf-8')
        self.assertEqual(run.call_args.kwargs['stdin'], eng.subprocess.DEVNULL)

    def test_missing_tool_returns_engine_error(self):
        with mock.patch.object(eng.subprocess, 'run', side_effect=FileNotFoundError('missing')):
            with self.assertRaisesRegex(eng.EngineError, 'ffprobe'):
                eng.ffprobe('input')

    def test_flac_decrypt_preserves_correct_extension(self):
        # 合成 V1 尾部 + Map 密钥，不使用账号、网络或用户音频。
        key = b'12345678'
        raw = b'fLaC' + b'fixture' * 10
        encrypted = bytearray(raw)
        eng.make_cipher(key).decrypt(0, encrypted)
        ekey = base64.b64encode(key)
        fixture = encrypted + ekey + struct.pack('<I', len(ekey))
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'source.mflac'
            source.write_bytes(fixture)
            def convert(src, dst, *args):
                self.assertTrue(src.endswith('.flac'))
                self.assertEqual(Path(src).read_bytes(), raw)
                Path(dst).write_bytes(b'fake-mp3')
            with mock.patch.object(eng, 'to_mp3', side_effect=convert), mock.patch.object(eng, 'ffprobe', return_value={'codec': 'flac', 'duration': 1, 'bitrate': 1000}), mock.patch.object(eng, 'db_lookup', return_value=None), mock.patch.object(eng, 'find_cover', return_value=None), mock.patch.object(eng, 'fetch_ekey', side_effect=AssertionError('no network')):
                result = eng.decrypt_file(str(source), folder, keep_ogg=True)
            self.assertEqual(result['codec'], 'flac')
            self.assertEqual((Path(folder) / 'source.flac').read_bytes(), raw)
            self.assertFalse((Path(folder) / 'source.ogg').exists())


class WindowTests(unittest.TestCase):
    def test_drop_binding_enables_dragover_and_sets_ready(self):
        dom_module = types.ModuleType('webview.dom')
        dom_module.DOMEventHandler = lambda callback, **kwargs: (callback, kwargs)
        window = mock.Mock()
        with mock.patch.dict(sys.modules, {'webview.dom': dom_module}):
            self.assertTrue(launcher.install_drop(window, lambda paths: None))
        calls = window.dom.body.on.call_args_list
        self.assertEqual([c.args[0] for c in calls], ['dragover', 'drop'])
        self.assertTrue(calls[0].args[1][1]['prevent_default'])
        self.assertFalse(calls[1].args[1][1].get('stop_propagation', False))
        window.evaluate_js.assert_called_once_with('window.__nativeDropReady = true')

    def test_drop_installs_only_after_loaded(self):
        callbacks = []
        class Event:
            def __iadd__(self, callback):
                callbacks.append(callback)
                return self
        window = mock.Mock()
        window.events.loaded = Event()
        window.events.closing = Event()
        webview = types.ModuleType('webview')
        webview.create_window = mock.Mock(return_value=window)
        def start(**kwargs):
            install.assert_not_called()
            callbacks[0]()
        webview.start = start
        with mock.patch.dict(sys.modules, {'webview': webview}), mock.patch.object(server, 'start_server', return_value=(mock.Mock(), 'http://127.0.0.1/')), mock.patch.object(server.Handler, 'jobs', mock.Mock()), mock.patch.object(launcher, 'install_drop', return_value=True) as install:
            self.assertEqual(launcher.run_window([]), 0)
        install.assert_called_once()

    def test_gui_startup_failure_writes_report_without_dialog(self):
        with tempfile.TemporaryDirectory() as folder:
            report = Path(folder) / 'gui.json'
            with mock.patch.object(launcher, 'run_window', side_effect=RuntimeError('missing runtime')), mock.patch.object(launcher, '_show_startup_error') as dialog, mock.patch.object(sys, 'stdout', None):
                self.assertEqual(launcher.main(['--gui-selftest', '--selftest-report', str(report)]), 1)
            dialog.assert_not_called()
            self.assertFalse(json.loads(report.read_text())['ok'])

    def test_normal_startup_failure_shows_actionable_error(self):
        with mock.patch.object(launcher, 'run_window', side_effect=RuntimeError('missing runtime')), mock.patch.object(launcher, '_show_startup_error') as dialog:
            self.assertEqual(launcher.main([]), 1)
        dialog.assert_called_once()

    def test_report_is_written_without_standard_streams(self):
        with tempfile.TemporaryDirectory() as folder:
            report = Path(folder) / 'result.json'
            with mock.patch.object(sys, 'stdout', None), mock.patch.object(sys, 'stderr', None):
                launcher._write_report(str(report), {'ok': True})
            self.assertTrue(json.loads(report.read_text())['ok'])

    def test_failed_selftest_has_report_and_nonzero_exit(self):
        with tempfile.TemporaryDirectory() as folder:
            report = Path(folder) / 'result.json'
            with mock.patch.object(server, 'start_server', side_effect=RuntimeError('synthetic failure')), mock.patch.object(eng, 'IS_WIN', False), mock.patch.object(sys, 'stdout', None), mock.patch.object(sys, 'stderr', None):
                self.assertEqual(launcher.selftest(str(report)), 1)
            result = json.loads(report.read_text())
            self.assertFalse(result['ok'])
            self.assertIn('synthetic failure', result['error'])


if __name__ == '__main__':
    unittest.main()
