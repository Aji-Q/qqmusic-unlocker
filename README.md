# QQ 音乐解锁器

把本机 QQ 音乐加密文件转换为 MP3。音频在本机处理；部分新格式需要联网获取本人账号有权访问的密钥。

## 网页版

无需安装：[打开网页版](https://qqmusic-unlocker-web.vercel.app)。选择文件 → 开始转换 → 下载 320 kbps MP3。无需选择格式或码率，推荐 Chrome / Edge。

网页支持旧版 QMC2、普通 FLAC / OGG / WAV / MP3，以及部分新版 MusicEx MGG / MFLAC 的单文件恢复。只需选择音乐文件，无需账号、客户端缓存或额外密钥文件；新版恢复结果必须通过完整的原始音频校验。结果统一为 320 kbps MP3；浏览器无法转码时会显示错误，可换用 Chrome / Edge 重试。适用范围与限制见 [web/README.md](web/README.md)。

## 下载与安装

从 [最新 Release](https://github.com/Aji-Q/qqmusic-unlocker/releases/latest) 的 **Assets** 下载应用包。不要下载 `Source code`，那是给开发者的源码。

| 电脑 | 下载文件 | 安装方式 |
| --- | --- | --- |
| Windows x64 | `QQMusicUnlocker-windows-x64.zip` | 完整解压，打开 `QQMusicUnlocker` 文件夹内的 `QQMusicUnlocker.exe` |
| Mac Apple 芯片，macOS 15+ | `QQMusicUnlocker-macos-arm64.zip` | 解压，把 `QQ音乐解锁器.app` 拖进「应用程序」 |
| Mac Intel，macOS 15+ | `QQMusicUnlocker-macos-x64.zip` | 同上 |

Mac 的芯片类型在苹果菜单 →「关于本机」中查看。应用包自带 Python、ffmpeg 和 ffprobe，无需安装开发工具。

- **Windows**：保留整个解压文件夹，不能单独移动 exe。缺少 WebView2 时，程序会提供打开[微软官方下载页](https://developer.microsoft.com/microsoft-edge/webview2/#download-section)的按钮；安装 Evergreen Runtime 后重开应用。
- **Mac 首次打开**：当前包尚未通过 Developer ID 公证。如果系统阻止打开，请先确认来自本仓库 Release，再按 [Apple 官方方法](https://support.apple.com/zh-cn/102445)，到「系统设置 → 隐私与安全性 → 仍要打开」。
- **快捷启动**：Windows 右键 exe →「显示更多选项」→「发送到 → 桌面快捷方式」；Mac 从「应用程序」拖到 Dock。快捷方式指向安装目录，文件夹移动后需重建。
- **更新**：先退出旧版，再在原安装位置替换应用或完整的 Windows 文件夹。不要只替换 exe，也不要继续使用另一个旧副本。输出设置会保留。

## 第一次使用

1. 在电脑的 QQ 音乐中登录并下载歌曲。在 QQ 音乐「设置」中查看下载目录，或在已下载歌曲的右键菜单中查找打开文件位置。需要的是本地音频文件，歌单链接和播放缓存不能直接转换。
2. 打开解锁器，确认「输出设置」中的保存目录。把文件或文件夹拖进窗口，会自动开始；也可点「选择文件」「选择文件夹」或「输入路径」。
3. 完成后点「打开文件夹」。失败时查看对应原因，按提示处理后点「重试失败项」。右上角「使用帮助」随时可打开。

输出目录、码率和「同时保存解密后的 OGG / FLAC」会记住。原格式指解密后的 OGG / FLAC；勾选后会在 MP3 之外额外保存一份。程序不修改输入文件，已有同名输出会自动编号保留。

支持 `.mgg`、`.mflac`、`.qmcogg`、`.qmcflac` 等 QMC2 文件，且解密后必须是 OGG 或 FLAC。扩展名相同不代表内部格式一定兼容。

## 遇到问题

| 状态或现象 | 下一步 |
| --- | --- |
| 账号未就绪 | 打开本机 QQ 音乐，登录下载该歌曲的账号，然后在应用内「重新检测」。部分旧格式无需账号，仍可尝试转换 |
| 没有找到文件 | 查看 QQ 音乐的下载目录；确认文件已下载完成、扩展名受支持。重复文件不会重复加入队列 |
| 无法写入输出目录 | 在「输出设置」改选可写入的本地文件夹，然后重试 |
| 缺少转码组件 | 重新下载并完整解压对应应用包；不要单独复制 exe |
| 获取密钥失败或被拒绝 | 查看该文件的具体提示，检查网络和本机账号；确认 QQ 音乐本身能播放这份下载文件，再重新检测并重试 |
| 不支持的格式 | 在 QQ 音乐中重新下载后再试；仍失败时保留原文件，不要只修改扩展名 |
| 界面还是旧版 | 退出所有副本，从刚替换的安装目录直接打开；检查 Dock / 桌面快捷方式是否指向旧位置 |

仍无法解决时，在「使用帮助」中复制排查信息，附上操作步骤和错误提示提交到 [Issues](https://github.com/Aji-Q/qqmusic-unlocker/issues)。不要附账号 cookie、密钥或付费音频。

## 验证范围

构建工作流会执行离线回归、打包后真实 WAV → MP3 转码、中文／空格路径和资源检查；Windows 还实际加载 WebView2 窗口并注册拖拽桥。每个包的 `BUILD-INFO.json` 记录源码提交及构建依赖，下载旁的 `.sha256` 可校验文件完整性。

**真实 Windows QQ 音乐账号及在线解密尚未完成实机验证。** 自动检查不能代替本机登录态读取、实际文件拖放、文件选择器和客户端格式兼容性验收。Mac 未公证，首次下载安装也可能需要上面的系统确认步骤。

## 开发与检查

普通使用请下载 Release。本节仅用于从源码构建。

```text
app/qmengine.py       解密、转码与平台路径
app/server.py        本地服务、队列与文件选择
app/settings.py      输出设置的持久化
app/ui/              共用界面
app/wincred.py       Windows 凭据文本解析
native/main.m        macOS 原生窗口
win/launcher.py      Windows 窗口和自检
QQMusicUnlocker.spec Windows 打包清单
```

离线检查（第二条需要 ffmpeg / ffprobe，不读取账号凭据或调用 QQ 音乐接口）：

```bash
python -m unittest discover -s tests -v
python win/launcher.py --selftest --selftest-report selftest.json
```

Windows x64 / Python 3.12 构建：先把 `ffmpeg.exe` 和 `ffprobe.exe` 放到仓库根目录。

```powershell
python -m pip install "pyinstaller==6.*" "pywebview==5.4"
python -m PyInstaller --noconfirm --clean QQMusicUnlocker.spec
$p = Start-Process .\dist\QQMusicUnlocker\QQMusicUnlocker.exe -ArgumentList '--selftest --selftest-report selftest.json' -Wait -PassThru
$p.ExitCode
Get-Content selftest.json
```

`--gui-selftest --selftest-report gui-selftest.json` 检查 WebView2 初始化，会加载首页并检测本机账号状态，但不会转换或请求在线密钥。GUI exe 没有可靠标准输出，需同时检查退出码和 JSON 的 `ok`。自检使用临时设置目录，不修改用户偏好。工作流保留报告，`v*` 标签汇集成品至 Release 草稿；三个平台检查通过、ZIP 与校验文件齐全后再公开。

macOS 源码构建见 `build.sh`；开发环境需 Python 3、Xcode Command Line Tools 和 ffmpeg。发行包不需要这些依赖。

```bash
python3 -m venv .venv
.venv/bin/pip install "pyinstaller==6.*"
PYTHON=.venv/bin/python ./build.sh
./launch.sh ~/Music/下载目录 -o ~/Desktop -b 320k
```

仅处理本人账号下载到本机的音频用于个人备份。程序不修改 QQ 音乐客户端，不绕过会员权限；接口拒绝的资源会显示失败。随包分发的 FFmpeg 及其依赖许可见包内 `LICENSES/`。
