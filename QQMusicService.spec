# -*- mode: python ; coding: utf-8 -*-
"""Self-contained macOS server, including Python and the FFmpeg dependency tree."""
import shutil
from pathlib import Path

root = Path(SPECPATH)
media = []
for name in ('ffmpeg', 'ffprobe'):
    binary = shutil.which(name)
    if not binary:
        raise RuntimeError(f'Build dependency missing: {name}')
    media.append((binary, '.'))
a = Analysis(
    [str(root / 'mac' / 'service.py')],
    pathex=[str(root / 'app')], binaries=media,
    datas=[(str(root / 'app' / 'ui'), 'app/ui')],
    hiddenimports=['server', 'qmengine', 'settings', 'version', 'sqlite3', 'plistlib'],
    hookspath=[], hooksconfig={}, runtime_hooks=[],
    excludes=['tkinter'], noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [], exclude_binaries=True, name='QQMusicService',
    debug=False, bootloader_ignore_signals=False, strip=False, upx=False,
    console=True, argv_emulation=False,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='QQMusicService')
