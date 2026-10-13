#!/bin/bash
# 组装 macOS 应用包：./build.sh  ->  dist/QQ音乐解锁器.app
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="QQ音乐解锁器"
APP="$ROOT/dist/$APP_NAME.app"
BUNDLE_ID="com.local.qqmusic-unlocker"
VERSION="1.0.0"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app/ui"

# 1) 编译原生入口（接 Apple Event / 拉起服务 / 自带窗口显示界面）
if [ ! -x "$ROOT/native/QQMusicUnlocker" ] || [ "$ROOT/native/main.m" -nt "$ROOT/native/QQMusicUnlocker" ]; then
  clang -fobjc-arc -O2 -o "$ROOT/native/QQMusicUnlocker" "$ROOT/native/main.m" \
        -framework AppKit -framework Foundation -framework WebKit
fi
cp "$ROOT/native/QQMusicUnlocker" "$APP/Contents/MacOS/QQMusicUnlocker"
chmod +x "$APP/Contents/MacOS/QQMusicUnlocker"

# 1b) 命令行入口（批量转换用，不参与 GUI 生命周期）
cp "$ROOT/launch.sh" "$APP/Contents/MacOS/launch"
chmod 755 "$APP/Contents/MacOS/launch"

# 2) 应用代码
cp "$ROOT/app/qmengine.py" "$ROOT/app/server.py" "$APP/Contents/Resources/app/"
cp "$ROOT/app/ui/index.html" "$ROOT/app/ui/style.css" "$ROOT/app/ui/app.js" \
   "$APP/Contents/Resources/app/ui/"

# 3) 图标
cp "$ROOT/tools/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

# 4) Info.plist
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
    <key>CFBundleExecutable</key><string>QQMusicUnlocker</string>
    <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>${VERSION}</string>
    <key>CFBundleVersion</key><string>${VERSION}</string>
    <key>LSMinimumSystemVersion</key><string>12.0</string>
    <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
    <key>NSHighResolutionCapable</key><true/>
    <!-- 声明文档类型，Finder 里把 .mgg 拖到应用图标上才会触发 open-documents
         Apple Event；由于入口是原生程序（不是 shell 脚本），事件能被正确接收。 -->
    <key>CFBundleDocumentTypes</key>
    <array>
        <dict>
            <key>CFBundleTypeName</key><string>QQ音乐加密音频</string>
            <key>CFBundleTypeRole</key><string>Viewer</string>
            <key>LSHandlerRank</key><string>Alternate</string>
            <key>LSItemContentTypes</key>
            <array><string>public.data</string></array>
            <key>CFBundleTypeExtensions</key>
            <array>
                <string>mgg</string><string>mgg1</string><string>mggl</string>
                <string>mflac</string><string>mflac0</string><string>mflac1</string>
                <string>qmcogg</string><string>qmcflac</string>
                <string>qmc0</string><string>qmc2</string><string>qmc3</string>
            </array>
        </dict>
    </array>
</dict>
</plist>
PLIST

# 5) 临时签名（本机自用，避免 Gatekeeper 直接拦截）
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
touch "$APP"

echo "已生成: $APP"
du -sh "$APP" | awk '{print "体积:", $1}'

# 6) 可选：注册/注销开机自启（登录项）
if [ "${1:-}" = "--login-item" ]; then
  PLIST="$HOME/Library/LaunchAgents/${BUNDLE_ID}.plist"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<AGENT
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${BUNDLE_ID}</string>
    <key>ProgramArguments</key>
    <array><string>${APP}/Contents/MacOS/launcher</string></array>
    <key>RunAtLoad</key><true/>
    <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
AGENT
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  launchctl load "$PLIST" >/dev/null 2>&1 || true
  echo "已注册开机自启（登录后自动运行）: $PLIST"
  echo "取消自启: launchctl unload \"$PLIST\" && rm \"$PLIST\""
  echo "注意：注册的是当前 dist 路径，改动 App 位置后需重新执行本命令。"
fi
