# MusicEx MGG 单文件恢复

2026-10-14。此功能只读取用户选择的音乐文件，不读取 QQ 音乐目录、客户端缓存、账号或额外密钥库。Vercel 只提供静态资源。成功输出需要通过完整文件验证，不能仅凭扩展名判断支持情况。

WEB 1.2 起，网页统一下载 320 kbps MP3。本文的原始 Ogg 校验指转码前的内部恢复阶段，不是可选的下载格式。

## 为什么这次能做到

检查现有项目后，MusicKey 1.0.0 的 MusicEx 分支仍要求外部 EKey；旧 Unlock Music 的 MGG mask 推测也无法处理此次样本。继续研究公开 QMC2 实现发现，RC4 分段会重复初始化同一状态，只改变开头跳过的字节数。这提供了从文件内重复结构恢复信息的机会。

实现分为五步：

1. 枚举公开的 Vorbis vendor 位置，用其他音频页验证候选 Ogg 标记、流编号和固定字段。
2. 利用页面序号、长度、lacing 表统计和跨页关系，推导局部密码流与各段偏移。
3. 比较由合成音频生成的公开 Vorbis setup 模板，补齐编码配置对应的流片段。模板不是歌曲明文，也不包含用户密钥。
4. 利用每隔 512 段重复使用同一 seed 的关系，求出候选 hash 和 512 字节密钥。候选必须重新生成一致的 hash 和已知密码流。
5. 用候选密钥解密全部原始字节，包括采用不同规则加密的前 128 字节。逐页检查原始 CRC、流编号、序号、包连续性、时间位置和结束标记，全部通过后才允许输出。

恢复不会修改 CRC、重建首包或猜测采样率。研究中已确认：44.1 kHz 与 48 kHz 的公开 setup 模板可能相同，因此模板匹配本身不足以恢复音频参数。最终参数来自解密后的原始首包。

## 支持边界

- 当前路径针对具有可识别 Xiph Vorbis 结构的 MusicEx MGG、512 字节 RC4 密钥及足够密集的音频页。vendor 须匹配内置公开格式，setup 配置须位于首个 5,120 字节内并命中公开模板。
- 音频体至少 7,869,440 字节，并且必须有足够的分段重复观测；超过大小下限仍可能不支持。
- 短文件、其他编码器、不同密钥长度、MFLAC、稀疏分页或损坏文件不能据此推定兼容。
- 对假设不一致、搜索超时、不能唯一恢复或 CRC 错误的输入直接报错，不输出局部音频。
- 处理运行在临时 Worker 中，可以停止；文件和恢复出的密钥不会写入 localStorage、日志或服务器。

## 验证方式

真实样本的研究实验在禁止网络、QQ 音乐目录和旧解密结果访问的沙箱内完成。完整输出有 2,105 个 Ogg 页，所有原始 CRC 正确；独立 ffprobe 和 ffmpeg 全曲解码通过。原始首包恢复为 44.1 kHz 双声道，时长 240.991973 秒。文件改名不影响结果。

研究还从另一条 CRC 线性求解路径得到 5,631 字节密码流，与最终恢复密钥产生的流全部相同。这是交叉核验；参与方程求解的页面不冒充独立验证数据。

仓库不包含该歌曲、真实密钥、账号资料或研究中间状态。自动测试使用随机密钥、合成音频和破坏校验和的负面输入。

独立生成的合成音频采用另一把 512 字节密钥、不同 metadata 长度及分页位置。恢复进程只能读取加密文件，禁止读取生成器、测试密钥和 oracle；恢复出的 9,031,173 字节与事后核对的原文 SHA-256 完全一致，1,639 个原始页面 CRC 全部通过。另一种较长 metadata 的夹具和稀疏分页夹具暂不支持，按预期明确拒绝，不计作兼容通过。

密钥恢复与旧解密路径共 43 项自动测试通过，包含零 seed、浮点边界、稀疏观测、错误流、超时和原始 CRC 损坏。10 个公开编码模板可从合成正弦波逐字节重现。

WEB 1.1 的全新浏览器会话中，Chrome 的原格式与 MP3 下载、Playwright WebKit 的原格式下载均通过整曲解码。原格式 SHA-256 一致，停止后重新开始也成功。测试阻断了所有外部请求及非 GET / HEAD 请求，未发生音频上传或账号请求。旧 QTag、普通音频、失败后继续处理与四种窗口尺寸的回归验收同时通过。

```bash
cd web
npm test
npm run build

# 需要启用了 libvorbis 的 ffmpeg；输出目录必须位于仓库外。
python tests/generate_file_only_fixtures.py --help

# 浏览器验收只把 INPUT.mgg 交给网页；SHA256 仅在下载后比较。
python tests/file_only_browser.py http://127.0.0.1:4173 INPUT.mgg OUTPUT_DIR EXPECTED_MP3_SHA256
```

生成合成夹具时会产生独立的 oracle 和测试密钥，恢复进程不能读取它们。恢复结束后再比较输出 SHA-256。WebKit 自动化结果不等同于 Safari 或 iOS 实机测试。

## 直接来源

- [QMC2 分段实现](https://github.com/bczhc/qmc-decode/blob/master/QMC2-crypto/qmc2-crypto/StreamCencrypt.cpp)：公开的 RC4 状态重置、跳过字节与 seed 选择规则。
- [早期 Unlock Music mask 推测](https://git.edik.cn/github/unlock-music/src/commit/e7b86a47790973012cc7391a60e595486348b054/src/decrypt/qmcMask.js)：2020-04-26；提供历史格式与公开 Vorbis 头模板参考，不是本次新版恢复的现成实现。
- [MusicKey QMC 实现](https://github.com/Xiaowu-0916/music-key/blob/5ee0d19c28021348f89a78933c99c7567c135cf5/musickey/formats/qmc.py)：2026-08-26，v1.0.0；独立实测在无 EKey/密钥库时拒绝此次 MusicEx 样本。
- [DSH Audio Converter](https://github.com/yousj666/dsh-audio-converter)：2026-09-27；其格式说明仍要求 MusicEx 外部 EKey，未作为解决路径采用。
- [Ogg framing](https://xiph.org/ogg/doc/framing.html) 与 [Vorbis 规范](https://xiph.org/vorbis/doc/Vorbis_I_spec.html)：页面、lacing、包头和 CRC 定义。
- [libvorbis 1.3.7](https://github.com/xiph/vorbis/tree/v1.3.7)：公开编码模板生成器；许可保存在 `public/sources/libvorbis-COPYING.txt`。

上述实现是有限格式下的单文件恢复实验，不是所有 QQ 音乐文件的通用解密证明。
