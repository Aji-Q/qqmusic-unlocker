# MusicEx MGG / MFLAC 单文件恢复

2026-10-14。此功能只读取用户选择的音乐文件，不读取 QQ 音乐目录、客户端缓存、账号或额外密钥库。Vercel 只提供静态资源。成功输出需要通过完整文件验证，不能仅凭扩展名判断支持情况。

WEB 1.3。网页统一下载 320 kbps MP3。本文的原始 Ogg / FLAC 校验指转码前的内部恢复阶段，不是可选的下载格式。

## 为什么这次能做到

检查现有项目后，MusicKey 1.0.0 的 MusicEx 分支仍要求外部 EKey；旧 Unlock Music 的 MGG mask 推测也无法处理此次样本。继续研究公开 QMC2 实现发现，RC4 分段会重复初始化同一状态，只改变开头跳过的字节数。这提供了从文件内重复结构恢复信息的机会。

MGG 恢复分为五步：

1. 枚举公开的 Vorbis vendor 位置，用其他音频页验证候选 Ogg 标记、流编号和固定字段。
2. 利用页面序号、长度、lacing 表统计和跨页关系，推导局部密码流与各段偏移。
3. 比较由合成音频生成的公开 Vorbis setup 模板，补齐编码配置对应的流片段。模板不是歌曲明文，也不包含用户密钥。
4. 利用每隔 512 段重复使用同一 seed 的关系，求出候选 hash 和 512 字节密钥。候选必须重新生成一致的 hash 和已知密码流。
5. 用候选密钥解密全部原始字节，包括采用不同规则加密的前 128 字节。逐页检查原始 CRC、流编号、序号、包连续性、时间位置和结束标记，全部通过后才允许输出。

恢复不会修改 CRC、重建首包或猜测采样率。研究中已确认：44.1 kHz 与 48 kHz 的公开 setup 模板可能相同，因此模板匹配本身不足以恢复音频参数。最终参数来自解密后的原始首包。

WEB 1.3 增加了 metadata 长度不可读时的公开 setup 模板搜索，并将密钥求解从至少四次重复观测扩展到三次。三次观测会产生更多 hash 别名，因此在收集候选前用另外两组独立分段观测筛选；最终唯一密钥、hash、密码流及所有原始页面 CRC 要求保持不变。某些短文件没有任何一页能够在密钥求解前完整读取，此时局部校验仅用于排除矛盾，不能冒充完整验证；完整验证始终在密钥恢复之后进行。

MFLAC 使用另一条路径：

1. 在前两个加密分段中寻找长重复片段，提出连续零填充假设；不使用歌曲名称、固定填充位置或外部密钥。
2. 利用公开 FLAC 帧头结构和原始 CRC8 找到连续帧，收集分段偏移，求出候选 hash 和部分 key byte。
3. 用已对齐帧的原始 CRC16 建立二进制线性方程，补齐重复密码流。参与求解的 CRC 不计作独立验证。
4. 用更多帧的 CRC16 缩小剩余 seed 候选；完整密钥必须重新生成一致的 hash 和已推导密码流；需要 CRC 补全的分支会比对全部 5,631 字节。若分段观测已足以唯一确定完整密钥，则直接用已知密码流验证，再进行完整音频校验，无需强制补出未使用的中间字节。
5. 解密全部原始字节，解析 STREAMINFO、metadata、每个音频子帧和精确帧边界；核对全部原始 CRC8 / CRC16、帧编号、音频参数与总样本数。只允许移除精确音频末尾之后最多 15 字节的封装余量，不扫描或重写 CRC 来拼接音频。

FLAC 验证器不还原 PCM，也不声称运行时验证 PCM MD5。真实 MFLAC 的验收另用 FFmpeg 全曲解码，再将 PCM 的 MD5 与解密后的原始 STREAMINFO 比较。解码音频一致性与前面的恢复约束是不同检查。

## 支持边界

- MGG 需要可识别的 Xiph Vorbis 结构、512 字节 RC4 密钥及足够密集的音频页。vendor 须匹配内置公开格式，setup 配置须位于首个 5,120 字节内并命中公开模板。
- MFLAC 需要跨越前两个分段的足量零填充、可识别的固定块帧、512 字节 RC4 密钥、足够多的重复段和独立校验约束。缺少这些结构仍可能失败。
- 音频体至少 5,248,000 字节，并且必须有足够的分段重复观测；超过大小下限仍可能不支持。约 4.1 MiB 的 MGG 尚未被证明支持，不能仅通过降低大小门槛解决。
- 较短文件、其他编码器、不同密钥长度、稀疏分页、填充不足或损坏文件不能据此推定兼容。
- 对假设不一致、搜索超时、不能唯一恢复或 CRC 错误的输入直接报错，不输出局部音频。
- 处理运行在临时 Worker 中，可以停止；文件和恢复出的密钥不会写入 localStorage、日志或服务器。

## 验证方式

真实样本的研究实验在禁止网络、QQ 音乐目录和旧解密结果访问的沙箱内完成。完整输出有 2,105 个 Ogg 页，所有原始 CRC 正确；独立 ffprobe 和 ffmpeg 全曲解码通过。原始首包恢复为 44.1 kHz 双声道，时长 240.991973 秒。文件改名不影响结果。

研究还从另一条 CRC 线性求解路径得到 5,631 字节密码流，与最终恢复密钥产生的流全部相同。这是交叉核验；参与方程求解的页面不冒充独立验证数据。

仓库不包含该歌曲、真实密钥、账号资料或研究中间状态。自动测试使用随机密钥、合成音频和破坏校验和的负面输入。

独立生成的合成音频采用另一把 512 字节密钥、不同 metadata 长度及分页位置。恢复进程只能读取加密文件，禁止读取生成器、测试密钥和 oracle；恢复出的 9,031,173 字节与事后核对的原文 SHA-256 完全一致，1,639 个原始页面 CRC 全部通过。WEB 1.1 当时对另一种较长 metadata 的夹具和稀疏分页夹具明确拒绝，没有把它们计作兼容通过；这些历史结果不用于推断新版兼容性。

WEB 1.3 的真实文件验收覆盖四个 MGG 与一个 MFLAC：音频体分别约 5.8、6.7、8.9、9.3、19.9 MiB。均以随机 `.bin` 文件名交给产品 `decryptFile`，仅读取该加密文件，完整解码通过。新增 MGG 的 1,321 / 1,577 / 2,187 个原始页面 CRC 均正确；原成功样本的 2,105 个页面回归通过。MFLAC 恢复 5,397,840 个原始样本、44.1 kHz / 24 bit / 双声道，122.4 秒；完整 PCM MD5 与原始 STREAMINFO 一致。

另以公开 FFmpeg 合成 120 秒、16 bit 的噪声音频，使用独立 Python QMC2 编码器与三把不同的 512 字节测试密钥生成 MFLAC。三个盲恢复结果均通过全部原始 FLAC 校验，事后与隔离保存的原文 SHA-256 逐字节比对一致，完整解码通过。生成器只产生测试数据，不包含真实音乐或用户密钥。

自动测试包含三次分段重复、候选爆量、零 seed、浮点边界、稀疏观测、错误流、超时、可变 metadata 的独立随机容器，以及 FLAC 损坏、截断、伪帧头、原始 CRC、子帧语法和 metadata 越界。10 个公开编码模板可从合成正弦波逐字节重现。

WEB 1.1 的全新浏览器会话中，Chrome 的原格式与 MP3 下载、Playwright WebKit 的原格式下载均通过整曲解码。原格式 SHA-256 一致，停止后重新开始也成功。测试阻断了所有外部请求及非 GET / HEAD 请求，未发生音频上传或账号请求。旧 QTag、普通音频、失败后继续处理与四种窗口尺寸的回归验收同时通过。

```bash
cd web
npm test
npm run build

# 需要启用了 libvorbis 的 ffmpeg；输出目录必须位于仓库外。
python tests/generate_file_only_fixtures.py --help
python tests/generate_file_only_flac_fixtures.py --output /tmp/flac-fixtures
# 在只允许读取 inputs/ 的独立进程内运行，结束后再与 private/ 中的 hash 比较。
node tests/recover_flac_fixture.mjs /tmp/flac-fixtures/inputs/noise-0.mflac /tmp/recovered.flac

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
- [RFC 9639](https://www.rfc-editor.org/rfc/rfc9639.html)：2024-12，FLAC 零填充、帧头、子帧、CRC 与 PCM MD5 的原始规范；于 2026-10-14 复核。新路径依据这些格式约束实现，不依赖额外的账号或密钥服务。

上述实现是有限格式下的单文件恢复实验，不是所有 QQ 音乐文件的通用解密证明。
