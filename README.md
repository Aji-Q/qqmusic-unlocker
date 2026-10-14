# QQ 音乐解锁器

将本机 QQ 音乐加密音频转换为 MP3。米白／黑色界面，音频在本机处理。
`musicex` 格式需要联网获取本人账号有权访问的解密密钥。

## 使用

1. 打开应用，拖入文件或文件夹，自动转换；也可选择文件或输入路径。
2. 在「输出设置」选择目录、码率，按需保留原格式（OGG / FLAC）。设置作用于当前会话。
3. 完成后打开输出文件夹；失败原因在队列和日志中查看，可重试失败项。

支持 `.mgg`、`.mflac`、`.qmcogg`、`.qmcflac` 等 QMC2 文件。
当前支持解密后的 OGG / FLAC 音频流；扩展名本身不保证格式兼容。
账号状态可点击查看，详细路径与处理步骤折叠在「排查详情」。

## Windows

- 下载 [Actions 构建产物](https://github.com/Aji-Q/qqmusic-unlocker/actions/workflows/build-windows.yml) 中的 `QQ音乐解锁器-windows-x64`，完整解压后运行 `QQMusicUnlocker.exe`。
- 程序内置 ffmpeg / ffprobe，需安装 [Microsoft WebView2 Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。不要只复制 exe。
- 可把文件或目录拖到 exe / `Convert-dropped-files.bat` 上，程序会打开窗口并转换。
- `创建桌面快捷方式.ps1` 用于创建桌面快捷方式。
- 新格式需要 QQ 音乐 PC 客户端已登录。程序只读取当前用户 `%APPDATA%\Tencent\QQMusic\` 下的配置与 cookie 文件，不读取进程内存。

### 验证范围

工作流在 push、PR 或手动运行时执行以下检查，结果以对应提交的 Actions 为准：

- Python 离线回归：路径、队列、凭据文本解析、无控制台输出、音频格式。
- 打包 exe 离线自检：资源、HTTP、中文与空格路径、ffmpeg 实际转码。
- WebView2 自检：实际初始化窗口、加载页面和注册原生拖拽桥。

**上述检查不等同于真实 QQ 音乐客户端验收。** 仍需在 Windows 上用本人文件验证：登录态读取、`musicex` 在线密钥接口、真实文件／目录拖放、原生文件选择器和资源管理器定位。客户端文件格式或接口变化可能导致失败。

## macOS

运行 `dist/QQ音乐解锁器.app`；需要 Python 3 和 ffmpeg：

```bash
brew install ffmpeg
./build.sh
open dist/QQ音乐解锁器.app
```

界面运行在原生窗口中，支持拖到窗口或应用图标。窗口关闭时后台服务一起退出。

## 开发

```text
app/qmengine.py       解密、转码与平台路径
app/server.py         本地 HTTP 服务、队列与文件选择
app/ui/              两个平台共用的界面
app/wincred.py       Windows 凭据文件解析
native/main.m        macOS 窗口入口
win/launcher.py      Windows WebView2 入口和自检
QQMusicUnlocker.spec Windows 打包清单
```

### 离线检查

```bash
python -m unittest discover -s tests -v
python win/launcher.py --selftest --selftest-report selftest.json
```

第二条需要 ffmpeg 和 ffprobe；不读取真实登录凭据，也不访问 QQ 音乐接口。

### Windows 构建

在 Windows x64 / Python 3.12 环境执行，先把 `ffmpeg.exe` 和 `ffprobe.exe` 放到仓库根目录：

```powershell
python -m pip install "pyinstaller==6.*" "pywebview==5.4"
python -m PyInstaller --noconfirm --clean QQMusicUnlocker.spec
$exe = ".\dist\QQMusicUnlocker\QQMusicUnlocker.exe"
$p = Start-Process $exe -ArgumentList '--selftest --selftest-report selftest.json' -Wait -PassThru
$p.ExitCode
Get-Content selftest.json
```

`--gui-selftest --selftest-report gui-selftest.json` 可验证 WebView2 初始化；此模式会加载首页并检测本机账号状态，但不会执行转换或请求在线密钥。
GUI exe 无可靠标准输出，自检必须同时检查退出码和 JSON 中的 `ok`。
工作流会保存自检报告；`v*` 标签额外发布 Release。

### 命令行

```bash
./launch.sh ~/Music/下载目录 -o ~/Desktop -b 320k
python3 app/qmengine.py <文件或目录> -o <输出目录>
./launch.sh --stop
```

macOS 日志与服务信息位于 `~/Library/Logs/QQMusicUnlocker/`。

## 边界

仅处理本人账号下载到本机的音频用于个人备份。软件不修改 QQ 音乐客户端，
不绕过会员权限；接口拒绝的资源会显示失败。随 Windows 包分发的 FFmpeg 构建采用 GPLv3，见包内 `LICENSES/`。
