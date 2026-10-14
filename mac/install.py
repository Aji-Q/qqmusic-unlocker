"""Install a verified local build and keep the Desktop shortcut pointed at it."""
from __future__ import annotations
import datetime
from pathlib import Path
import shutil
import subprocess
import sys

source = Path(sys.argv[1]).resolve()
home = Path.home()
target = home / 'Applications' / source.name
desktop = home / 'Desktop' / source.name
commands = subprocess.run(['/bin/ps', '-axo', 'command='], capture_output=True, text=True, check=True).stdout
if str(target / 'Contents/MacOS/QQMusicUnlocker') in commands:
    raise SystemExit('请先退出正在运行的 QQ音乐解锁器，再执行 --install。')
stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
backup = home / 'Library/Application Support/QQMusicUnlocker/Backups' / stamp
stage = target.parent / ('.QQMusicUnlocker-' + stamp + '.app')
target.parent.mkdir(parents=True, exist_ok=True)
backup.mkdir(parents=True)
subprocess.run(['/usr/bin/ditto', str(source), str(stage)], check=True)
subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(stage)], check=True)
old_app = backup / 'Applications.app'
old_desktop = backup / 'Desktop.app'
try:
    if target.exists() or target.is_symlink():
        target.rename(old_app)
    stage.rename(target)
    if desktop.exists() or desktop.is_symlink():
        desktop.rename(old_desktop)
    desktop.symlink_to(target)
except Exception:
    if old_desktop.exists() or old_desktop.is_symlink():
        if desktop.is_symlink():
            desktop.unlink()
        old_desktop.rename(desktop)
    if old_app.exists() or old_app.is_symlink():
        if target.exists():
            shutil.rmtree(target)
        old_app.rename(target)
    raise
print(f'已安装: {target}\n桌面快捷方式: {desktop}\n备份: {backup}')
