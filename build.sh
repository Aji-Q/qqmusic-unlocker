#!/bin/bash
# macOS self-contained app: PYTHON=/path/to/venv/bin/python ./build.sh
# Build dependencies: Python + PyInstaller 6, Xcode command-line tools, FFmpeg.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="QQ音乐解锁器"
APP="$ROOT/dist/$APP_NAME.app"
PYTHON="${PYTHON:-python3}"
DEV=0
INSTALL=0
for option in "$@"; do
  case "$option" in
    --dev) DEV=1 ;;
    --install) INSTALL=1 ;;
    --login-item) echo '不再自动注册登录项。安装应用后可在 macOS 系统设置中添加登录项。' >&2; exit 2 ;;
    *) echo "未知选项: $option（可用 --dev、--install）" >&2; exit 2 ;;
  esac
done
VERSION="$(ROOT="$ROOT" "$PYTHON" -c 'import os, sys; sys.path.insert(0, os.path.join(os.environ["ROOT"], "app")); from version import APP_VERSION; print(APP_VERSION)')"
# Include service/UI/native sources in runtime identity, even when rebuilding the same version.
BUILD_ID="$(ROOT="$ROOT" "$PYTHON" - <<'PY'
import hashlib, os
from pathlib import Path
root=Path(os.environ['ROOT'])
h=hashlib.sha256()
files=list((root/'app').rglob('*.py'))+list((root/'app/ui').glob('*'))+[root/'native/main.m', root/'mac/service.py']
for p in sorted(files):
    if p.is_file():
        h.update(str(p.relative_to(root)).encode()); h.update(p.read_bytes())
print(h.hexdigest()[:24])
PY
)"
if [ "$DEV" = 0 ]; then
  "$PYTHON" -m PyInstaller --version >/dev/null
  command -v ffmpeg >/dev/null
  command -v ffprobe >/dev/null
  "$PYTHON" -m PyInstaller --noconfirm --clean --distpath "$ROOT/dist/service-build" \
    --workpath "$ROOT/build/pyinstaller" "$ROOT/QQMusicService.spec"
fi
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
clang -fobjc-arc -O2 -mmacosx-version-min=15.0 -o "$APP/Contents/MacOS/QQMusicUnlocker" \
  "$ROOT/native/main.m" -framework AppKit -framework Foundation -framework WebKit
if [ "$DEV" = 1 ]; then
  mkdir -p "$APP/Contents/Resources/app/ui"
  cp "$ROOT/app/"*.py "$APP/Contents/Resources/app/"
  cp "$ROOT/app/ui/"* "$APP/Contents/Resources/app/ui/"
else
  ditto "$ROOT/dist/service-build/QQMusicService" "$APP/Contents/Resources/service"
fi
cp "$ROOT/tools/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
APP="$APP" VERSION="$VERSION" BUILD_ID="$BUILD_ID" DEV="$DEV" "$PYTHON" - <<'PY'
import os, plistlib
from pathlib import Path
info={
 'CFBundleName':'QQ音乐解锁器', 'CFBundleDisplayName':'QQ音乐解锁器',
 'CFBundleExecutable':'QQMusicUnlocker', 'CFBundleIdentifier':'com.local.qqmusic-unlocker',
 'CFBundleIconFile':'AppIcon', 'CFBundlePackageType':'APPL',
 'CFBundleShortVersionString':os.environ['VERSION'], 'CFBundleVersion':os.environ['VERSION'],
 'QQMusicBuildID':os.environ['BUILD_ID'], 'QQMusicStandalone':os.environ['DEV'] == '0', 'LSMinimumSystemVersion':'15.0',
 'LSApplicationCategoryType':'public.app-category.utilities', 'NSHighResolutionCapable':True,
 'CFBundleDocumentTypes':[{'CFBundleTypeName':'QQ音乐加密音频', 'CFBundleTypeRole':'Viewer',
  'LSHandlerRank':'Alternate','LSItemContentTypes':['public.data'],
  'CFBundleTypeExtensions':['mgg','mgg1','mggl','mflac','mflac0','mflac1','qmcogg','qmcflac','qmc0','qmc2','qmc3']}]
}
(Path(os.environ['APP'])/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
PY
if [ "$DEV" = 0 ]; then
  "$PYTHON" "$ROOT/mac/bundle_metadata.py" "$APP" "$ROOT/build/pyinstaller/QQMusicService/Analysis-00.toc"
fi
# Ad-hoc signature detects corruption; it is not Developer ID signing or notarization.
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
echo "已生成: $APP"
du -sh "$APP"
if [ "$INSTALL" = 1 ]; then
  "$PYTHON" "$ROOT/mac/install.py" "$APP"
fi
