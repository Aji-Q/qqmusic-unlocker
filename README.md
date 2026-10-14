# QQ 音乐解锁器

把 QQ 音乐客户端下载的加密音频（`.mgg` / `.mflac` 等）解密并转成 MP3 的本地小软件。
双击即用，全程在本机完成，不上传任何音频。

```
qqmusic-unlocker/
├── build.sh                  # 编译原生入口 + 组装 .app -> dist/QQ音乐解锁器.app
├── launch.sh                 # 命令行入口（批量转换 / 服务管理）
├── native/main.m             # 原生入口（接 Apple Event、拉起服务、自带 WKWebView 窗口）
├── app/
│   ├── qmengine.py           # 解密引擎（无第三方依赖，可单独命令行使用）
│   ├── server.py             # 本地服务：任务队列 / 进度 / 原生文件选择
│   └── ui/                   # 前端界面（index.html + style.css + app.js）
├── win/launcher.py           # Windows 原生窗口入口（pywebview + WebView2）
├── app/wincred.py            # Windows 凭据读取（只读本人账号文件）
└── tools/make_icon.py        # 生成 AppIcon.icns
```

## 使用

**图形界面**：双击 `QQ音乐解锁器.app`

1. **把 `.mgg` / `.mflac` 拖进窗口就自动开始转换**，不用再点按钮；
   也可以点「选择文件 / 选择文件夹」，或把文件**拖到应用图标上**（macOS 走 Apple Event）。
2. 默认输出到桌面、320 kbps；这两个值在「设置」里改一次就记住。
3. 转完顶部出现结果条：`转换完成：N 个文件 · 已保存到 <目录>`，点「打开输出文件夹」
   直接定位到文件，不用自己去桌面翻。

界面是「极简优先」的：队列没东西时不显示表格，详情（每个文件的尾部格式、日志）
收在抽屉里，平时不占视线。

## Windows 版

自带窗口（基于系统 WebView2），不打开浏览器，界面和 macOS 完全一致。
差别只在取登录凭据的来源：

- 需先安装并登录 **QQ 音乐 PC 客户端**；
- 凭据只从本机当前用户自己的文件读取：`%APPDATA%\Tencent\QQMusic\`
  下的 `QQMusicServiceConfig.ini`（取 `uin`）与 `SetCookie.dat`（取 `authst`）。
  不读取任何其它进程的内存，不改动客户端。
- ffmpeg 已随 exe 打包，无需自行安装；Windows 11 自带 WebView2 运行时，
  个别 Windows 10 需到微软官网装 “Evergreen” 运行时。

### 拿到 exe（两种方式）

**方式一：直接下载（推荐，不用自己构建）**

1. 打开仓库的 Actions 页面：<https://github.com/Aji-Q/qqmusic-unlocker/actions/workflows/build-windows.yml>
2. 点右侧 **Run workflow** → 绿色按钮运行（约 5 分钟）；
3. 运行结束后点进那次运行，页面底部 **Artifacts** 里下载 `QQ音乐解锁器-windows-x64`。

**方式二：发版拿固定下载链接**

```bash
git tag v1.0.0 && git push origin v1.0.0
```

工作流会自动把 zip 发到 Releases，得到一个长期有效的链接。

### 解压后怎么用

目录里有四个东西，用法各自明确：

| 文件 | 用途 |
| --- | --- |
| `QQMusicUnlocker.exe` | 双击打开窗口，把音频拖进窗口即自动转换 |
| `Convert-dropped-files.bat` | **把音频（或整个文件夹）拖到这个 .bat 图标上**，批量转换后窗口停住显示结果 |
| `创建桌面快捷方式.ps1` | 右键「使用 PowerShell 运行」一次，桌面出现快捷方式 |
| `README.md` / `LICENSES/` | 说明与 ffmpeg 许可 |

> 拖到 `.bat` 上是 Windows 版的推荐姿势：Windows 不会把拖到 exe 上的文件路径交给
> Python 程序，所以由这个脚本把路径转发成命令行参数（`QQMusicUnlocker.exe <文件…>`）。
> 拖进窗口（WebView2）则走 pywebview 的 DOM 事件桥，两者都能自动开始转换。

### 登录态报错怎么办

界面右上角显示「**需要登录 QQ 音乐**」时**点它**，会弹出一张排障卡片：

- 逐个列出检查了哪些文件、路径是什么、读到了没有（✓/✗）；
- 给出照做即可的处理顺序（登录客户端 → 重开本程序 → 播放一首会员歌触发凭据落盘 …）；
- 底下有「复制排查信息」，出问题可以把这段发出来。

日志窗口里的每一行都带时间戳，转换失败时会写明确原因（需要 VIP / 凭据过期 / 文件格式不符）。

## 原理（为什么不是简单异或）

| 尾部格式 | 出现版本 | ekey 位置 |
| --- | --- | --- |
| `QTag` | 旧版 QMC2 | 文件尾部明文 |
| `V1` | 过渡版本 | 文件末尾「长度 + 密钥」 |
| `musicex` | macOS 客户端 ≥ 19.57 / PC 客户端新版 | **不嵌在文件里**，必须调接口实时取 |

`musicex` 是现在最常见的坑：尾部 192 字节只存 `song_id`、`media_mid`、资源文件名，
任何「自己算密钥」的脚本都会失败。正确链路（两个平台一致，只有凭据来源不同）：

1. 解析 musicex 尾部，取 `media_mid` 与 `filename`；
2. 读本机登录凭据（macOS：`~/Library/Preferences/com.tencent.QQMusicMac.plist` 的
   `AutoLoginUserInfo`；Windows：`%APPDATA%\Tencent\QQMusic\` 下的 ini + cookie，
   见 `app/wincred.py`），解出 `uin` / `authst`；
3. 调 `music.vkey.GetEVkey`（`songtype=1`，平台码 macOS=20 / Windows=27）拿 `ekey`，
   有效期约 22 小时，引擎按曲缓存；
4. `ekey` → base64 → **TC-TEA**（腾讯 16 轮 CBC 变体，固定 10 字节头）派生密钥；
5. **QMC2 流密码**解密：密钥 ≤ 300 字节走 Map 密码（`key[(i² + 71214) % len]` 再按位旋转），
   > 300 字节走修改版 RC4（首 128 字节特殊，其后每 0x1400 字节分块、按块号重算丢弃数）；
6. 解出 Ogg Vorbis / Opus，用 ffmpeg 转 MP3，macOS 下标签优先读取本机曲库 `qqmusic.sqlite`。

> 算法参照 jixunmoe 的 `tc_tea_rust` 与 ownlight6 的 `qmc-decoder`。
> 已用真实文件（O8M0 超品 OGG Vorbis 331 kbps）端到端验证：解密结果是 2187 个页、
> 末页带 EOS 标记的完整 Ogg 流，转出的 MP3 时长 3:53.9 / 320 kbps。

## 环境要求

- macOS 12+ 已装 **ffmpeg**（`brew install ffmpeg`）；Windows 版已内置 ffmpeg
- QQ 音乐客户端处于登录状态（两个平台都需要；凭据过期就重新登录，再点「重新检测登录」）
- 构建 macOS 应用包需要 Xcode 命令行工具（`xcode-select --install`），运行时不需要
- 构建 Windows 版由 GitHub Actions 完成（PyInstaller onedir + Gyan.dev 的 ffmpeg 静态构建，GPLv3）

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 右上角显示「需要登录 QQ 音乐」 | 点它看排障卡片：会列出查了哪些文件、缺哪个、下一步做什么 |
| 失败提示「接口未返回 ekey（result=104005）」 | 该资源需要 VIP，或登录态已失效 |
| 失败提示「无法识别的尾部格式」 | 文件不是本工具支持的加密音频（例如已经是普通 mp3） |
| 失败提示「解密失败：输出头不是 OggS」 | ekey 与文件不匹配（文件被替换或损坏） |
| 拖进窗口没反应 | 用 `.bat` 转发（Windows），或改用「选择文件」按钮；浏览器标签页里拖拽受浏览器隐私限制拿不到路径 |
| 桌面找不到转好的文件 | 点结果条的「打开输出文件夹」；输出目录在「设置」里可见 |

## 开发与重建

```bash
./build.sh                  # macOS：编译原生入口并打包
cp -R dist/QQ音乐解锁器.app ~/Applications/
python3 app/qmengine.py <文件或目录> -o ~/Desktop   # 只用引擎（不开界面）

# Windows（在 Windows 或 CI 上执行；macOS 上只能验证到同一份 app/ 代码）
python win/launcher.py --selftest                   # 无显示自测：服务/首页/拖拽回调/ffmpeg
pyinstaller --noconfirm --clean --onedir --windowed --name QQMusicUnlocker \
  --add-data "app;app" --add-binary "ffmpeg.exe;." --add-binary "ffprobe.exe;." win/launcher.py
```

日志：macOS `~/Library/Logs/QQMusicUnlocker/launcher.log`；运行态：同目录 `runtime.json`。

**命令行**（批量 / 脚本化）：

```bash
./launch.sh ~/Music/下载目录 -o ~/Desktop -b 320k   # 目录批量
./launch.sh a.mgg b.mflac                            # 指定文件
./launch.sh --stop                                   # 关闭正在运行的服务
./launch.sh --new-session                            # 强制开一个新会话
```

界面在应用自己的窗口里显示，不打开浏览器；有 Dock 图标和菜单栏。
关掉窗口（⌘W / ⌘Q）或点界面右下角「退出服务」，应用和后台服务一起退出；
命令行起的服务用 `./launch.sh --stop` 关。

**开机自启**（可选）：`./build.sh --login-item` 注册登录项，取消命令脚本会打印出来。

## 原理（为什么不是简单异或）

| 尾部格式 | 出现版本 | ekey 位置 |
| --- | --- | --- |
| `QTag` | 旧版 QMC2 | 文件尾部明文 |
| `V1` | 过渡版本 | 文件末尾「长度 + 密钥」 |
| `musicex` | macOS 客户端 ≥ 19.57 | **不嵌在文件里**，必须调接口实时取 |

`musicex` 是现在最常见的坑：尾部 192 字节只存 `song_id`、`media_mid`、资源文件名，
任何「自己算密钥」的脚本都会失败。正确链路：

1. 解析 musicex 尾部，取 `media_mid` 与 `filename`；
2. 读本机登录凭据（`~/Library/Preferences/com.tencent.QQMusicMac.plist` 的
   `AutoLoginUserInfo`，解出 `uin` / `authst` / `loginType`）；
3. 调 `music.vkey.GetEVkey`（`songtype=1`）拿 `ekey`，有效期约 22 小时，引擎按曲缓存；
4. `ekey` → base64 → **TC-TEA**（腾讯 16 轮 CBC 变体，固定 10 字节头）派生密钥；
5. **QMC2 流密码**解密：密钥 ≤ 300 字节走 Map 密码（`key[(i² + 71214) % len]` 再按位旋转），
   > 300 字节走修改版 RC4（首 128 字节特殊，其后每 0x1400 字节分块、按块号重算丢弃数）；
6. 解出 Ogg Vorbis / Opus，用 ffmpeg 转 MP3，标签优先读取本机曲库 `qqmusic.sqlite`。

> 算法参照 jixunmoe 的 `tc_tea_rust` 与 ownlight6 的 `qmc-decoder`。
> 已用真实文件（O8M0 超品 OGG Vorbis 331 kbps）端到端验证：解密结果是 2187 个页、
> 末页带 EOS 标记的完整 Ogg 流，转出的 MP3 时长 3:53.9 / 320 kbps。

## 环境要求

- macOS 12+，已安装 **ffmpeg**（`brew install ffmpeg`）
- 本机 QQ 音乐处于登录状态；凭据过期就在 QQ 音乐重新登录，再点界面上的「重载凭据」
- 构建应用包需要 Xcode 命令行工具（`xcode-select --install`），运行时不需要

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 状态栏显示「未检测到登录」 | 先在 QQ 音乐登录，再点「重载凭据」 |
| 失败提示「接口未返回 ekey（result=104005）」 | 该资源需要 VIP，或登录态已失效 |
| 失败提示「无法识别的尾部格式」 | 文件不是本工具支持的加密音频（例如已是普通 mp3） |
| 失败提示「解密失败：输出头不是 OggS」 | ekey 与文件不匹配（文件被替换或损坏） |
| 提示缺少 ffmpeg | 终端执行 `brew install ffmpeg` |
| 拖拽没反应（用 `launch.sh` 在 Safari 里打开时） | Safari 不提供文件路径，改用界面按钮；应用窗口里拖拽由原生层取路径，不受影响 |

## 开发与重建

```bash
./build.sh                  # 重新编译并打包
cp -R dist/QQ音乐解锁器.app ~/Applications/
python3 app/qmengine.py <文件或目录> -o ~/Desktop   # 只用引擎（不开界面）
python3 tools/make_icon.py  # 需要 Pillow，仅图标变更时执行
```

日志：`~/Library/Logs/QQMusicUnlocker/launcher.log`；运行态：同目录 `runtime.json`。

## 边界说明

仅用于解密**本人账号下载到本机的**音频，属个人备份用途；软件不修改 QQ 音乐客户端，
也不绕过付费获取资源——没有 VIP 权限的资源，接口不会返回 ekey，软件会明确报错。
