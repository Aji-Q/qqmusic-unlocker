# 网页版

在浏览器中处理文件，无账号登录、音频上传或转换服务器。页面使用 Vite 构建，Vercel 只托管静态资源。

## 使用

1. 选择已下载的音乐文件。
2. 选择 MP3 或「原格式」，点击开始转换。
3. 点击每个结果旁的下载按钮，在关闭页面前保存。

QTag / V1 内嵌密钥的 QMC2 可本地解密；`musicex` 不携带密钥，当前网页无法仅凭音乐文件转换。网页不要求登录，也不加入密钥导入步骤。不能仅凭扩展名判断兼容性。普通 FLAC、OGG、WAV、MP3 也可转为 MP3。

已有匹配的客户端缓存密钥时，musicex 的解密运算可以离线执行；这是额外密钥材料，不能视为网页“只拖入音乐文件”的兼容性通过。内嵌密钥测试通过不代表新版下载文件已通过验收。

推荐最新版 Chrome / Edge 转 MP3。WebKit 26.5 实测可处理 Ogg，但 FLAC 可能在解码时失败，即使能力预检通过；失败后仍可下载已解密的原格式。Playwright WebKit 检查不等同于真实 Safari 或 iOS 实机验收。

每个文件上限 100 MiB，每批最多 20 个 / 200 MiB；MP3 预计和实际输出同样有单个 100 MiB、当前结果总量 200 MiB 上限。这是产品限制，不保证所有设备都有足够内存。较大文件建议使用桌面版。逐文件处理、停止可继续；完成文件由用户逐个点击下载。关闭页面会丢失尚未下载的结果。音频码率不会提升源文件音质，高采样率或多声道转 MP3 时会转换至 MP3 支持的采样率与声道。

## 本地开发

Node.js 22.12+（部署使用 24.x）：

```bash
cd web
npm ci
npm run dev
npm test
npm run build
npm run preview
```

`npm test` 使用 Node 内置测试器，包含 Python 引擎生成的 Map、RC4、TEA、EncV2 交叉校验向量及有效的合成静音 FLAC。重新生成测试向量需 Python 和本机 ffmpeg，见 `tests/generate_qmc_fixtures.py`。

浏览器验收（另需 Python Playwright 与 ffprobe，服务先运行 `npm run preview`）：

```bash
python -m pip install playwright
python -m playwright install chromium webkit
python tests/browser_acceptance.py http://127.0.0.1:4173
```

覆盖真实 QTag 解密 / MP3 下载、WebKit 原格式恢复、错误后下一文件、去重、帮助键盘焦点、四种视口和无音频 POST。使用系统 Chrome 可设置 `CHROMIUM_CHANNEL=chrome`。结果默认写入忽略的 `web/test-results/`。

部署时项目 Root Directory 选择 `web`，Framework 选择 Vite；Production Branch 为 `main`。`vercel.json` 提供静态资源策略和 CSP，无环境变量或服务器函数。核心转换模块按需加载，同源打包，不依赖第三方 CDN。

## 开源组件

Mediabunny 与 MP3 encoder 固定为 1.61.3（MPL-2.0），内含 LAME 3.100（LGPL-2.0-or-later）。`public/licenses.html` 提供精确版本源码、构建脚本和许可；LAME 对应源码随站点提供。npm 模块保持未修改，可用上游源码重新构建并替换编码器。依赖版本锁定在 `package-lock.json`。
