# -*- mode: python ; coding: utf-8 -*-
"""Windows x64 构建：python -m PyInstaller --noconfirm --clean QQMusicUnlocker.spec"""
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

root = Path(SPECPATH)
a = Analysis(
    [str(root / 'win' / 'launcher.py')],
    pathex=[str(root / 'app')],
    binaries=[(str(root / 'ffmpeg.exe'), '.'), (str(root / 'ffprobe.exe'), '.')]
             + collect_dynamic_libs('webview'),
    datas=[(str(root / 'app' / 'ui'), 'app/ui')] + collect_data_files('webview'),
    hiddenimports=['server', 'qmengine', 'wincred', 'tkinter', 'tkinter.filedialog',
                   'webview.platforms.edgechromium', 'webview.platforms.winforms',
                   'clr', 'pythonnet'],
    hookspath=[], hooksconfig={}, runtime_hooks=[], excludes=[], noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [], exclude_binaries=True, name='QQMusicUnlocker',
    debug=False, bootloader_ignore_signals=False, strip=False, upx=False,
    console=False, disable_windowed_traceback=False,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='QQMusicUnlocker')
