"""Windows 首次启动与原生添加反馈；不读取真实注册表或账号。"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'app'), str(ROOT / 'win')]
import launcher


class RuntimeDetectionTests(unittest.TestCase):
    def registry(self, machine=None, user=None):
        registry = types.ModuleType('winreg')
        registry.HKEY_LOCAL_MACHINE = 'machine'
        registry.HKEY_CURRENT_USER = 'user'
        registry.KEY_READ = 1
        registry.KEY_WOW64_32KEY = 2
        values = {'machine': machine, 'user': user}
        def open_key(root, path, reserved, flags):
            self.assertEqual(path, launcher._WEBVIEW2_KEY)
            self.assertEqual(flags, 3 if root == 'machine' else 1)
            value = values[root]
            if isinstance(value, Exception):
                raise value
            if value is None:
                raise FileNotFoundError(path)
            key = mock.MagicMock()
            key.__enter__.return_value = value
            return key
        registry.OpenKey = open_key
        registry.QueryValueEx = lambda key, name: (key, 1)
        return registry

    def test_per_machine_install_uses_32_bit_registry_view(self):
        with mock.patch.dict(sys.modules, {'winreg': self.registry(machine='130.0.1.2')}):
            self.assertEqual(launcher.webview2_runtime_version(), '130.0.1.2')

    def test_per_user_install_is_detected_when_machine_is_missing(self):
        with mock.patch.dict(sys.modules, {'winreg': self.registry(user='130.0.1.2')}):
            self.assertEqual(launcher.webview2_runtime_version(), '130.0.1.2')

    def test_zero_or_invalid_versions_do_not_pass(self):
        for value in ('0.0.0.0', '', 'not-installed', 42):
            with self.subTest(value=value), mock.patch.dict(sys.modules, {'winreg': self.registry(machine=value)}):
                self.assertEqual(launcher.webview2_runtime_version(), '')

    def test_access_denied_is_unknown_not_missing(self):
        with mock.patch.dict(sys.modules, {'winreg': self.registry(machine=PermissionError('denied'))}):
            self.assertIsNone(launcher.webview2_runtime_version())

    def test_per_user_install_still_wins_after_machine_access_denied(self):
        with mock.patch.dict(sys.modules, {'winreg': self.registry(machine=PermissionError('denied'), user='130.0.1.2')}):
            self.assertEqual(launcher.webview2_runtime_version(), '130.0.1.2')

    def test_missing_runtime_stops_before_creating_a_window(self):
        with mock.patch.object(launcher.eng, 'IS_WIN', True), mock.patch.object(launcher, 'webview2_runtime_version', return_value=''), mock.patch.object(launcher, 'run_window') as window, mock.patch.object(launcher, '_show_startup_error') as dialog:
            self.assertEqual(launcher.main([]), 1)
        window.assert_not_called()
        self.assertIsInstance(dialog.call_args.args[0], launcher.MissingWebView2Error)

    def test_unknown_runtime_state_allows_actual_webview_attempt(self):
        with mock.patch.object(launcher.eng, 'IS_WIN', True), mock.patch.object(launcher, 'webview2_runtime_version', return_value=None), mock.patch.object(launcher, 'run_window', return_value=0) as window:
            self.assertEqual(launcher.main([]), 0)
        window.assert_called_once()


class StartupFeedbackTests(unittest.TestCase):
    def show_dialog(self, error, button):
        import ctypes
        message_box = mock.Mock(return_value=button)
        windll = types.SimpleNamespace(user32=types.SimpleNamespace(MessageBoxW=message_box))
        with mock.patch.object(launcher.eng, 'IS_WIN', True), mock.patch.object(ctypes, 'windll', windll, create=True), mock.patch('webbrowser.open') as browser:
            launcher._show_startup_error(error)
        return message_box, browser

    def test_only_explicit_yes_opens_the_official_runtime_page(self):
        dialog, browser = self.show_dialog(launcher.MissingWebView2Error(), 6)
        browser.assert_called_once_with(launcher.WEBVIEW2_DOWNLOAD_URL)
        self.assertEqual(dialog.call_args.args[3], 0x24)
        _, browser = self.show_dialog(launcher.MissingWebView2Error(), 7)
        browser.assert_not_called()

    def test_unrelated_failure_does_not_claim_runtime_is_missing(self):
        dialog, browser = self.show_dialog(PermissionError('synthetic denied'), 6)
        message = dialog.call_args.args[1]
        self.assertIn('PermissionError: synthetic denied', message)
        self.assertNotIn('WebView2', message)
        browser.assert_not_called()

    def test_native_paths_use_ui_save_barrier_with_safe_encoding_and_error_feedback(self):
        class Event:
            def __init__(self):
                self.callbacks = []
            def __iadd__(self, callback):
                self.callbacks.append(callback)
                return self
        window = mock.Mock()
        window.events = types.SimpleNamespace(loaded=Event(), closing=Event())
        webview = types.ModuleType('webview')
        webview.create_window = mock.Mock(return_value=window)
        webview.start = lambda **kwargs: [callback() for callback in window.events.loaded.callbacks]
        jobs = mock.Mock()
        paths = ['中文 空格.mgg', 'quote"\\newline\n\u2028.mflac']
        with mock.patch.dict(sys.modules, {'webview': webview}), mock.patch.object(launcher.server, 'start_server', return_value=(mock.Mock(), 'http://127.0.0.1/')), mock.patch.object(launcher.server.Handler, 'jobs', jobs), mock.patch.object(launcher, 'install_drop', return_value=True):
            self.assertEqual(launcher.run_window(paths), 0)
        jobs.open_paths.assert_not_called()
        jobs.start.assert_not_called()
        window.evaluate_js.assert_called_once_with(
            'void window.addPaths(' + json.dumps(paths, ensure_ascii=True)
            + ').catch(window.showError);')

    def test_diagnostics_restore_settings_environment(self):
        key = 'QQMUSIC_UNLOCKER_CONFIG_DIR'
        with mock.patch.dict(os.environ, {key: 'existing-setting-path'}):
            with launcher.isolated_settings():
                path = os.environ[key]
                self.assertNotEqual(path, 'existing-setting-path')
                self.assertTrue(os.path.isdir(path))
            self.assertEqual(os.environ[key], 'existing-setting-path')
            self.assertFalse(os.path.exists(path))


if __name__ == '__main__':
    unittest.main()
