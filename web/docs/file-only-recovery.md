# MusicEx MGG / MFLAC 单文件恢复

2026-10-14。此功能只读取用户选择的音乐文件，不读取 QQ 音乐目录、客户端缓存、账号或额外密钥库。Vercel 只提供静态资源。成功输出需要通过完整文件验证，不能仅凭扩展名判断支持情况。

WEB 1.4。网页统一下载 320 kbps MP3。本文的原始 Ogg / FLAC 校验指转码前的内部恢复阶段，不是可选的下载格式。

## 为什么这次能做到

检查现有项目后，MusicKey 1.0.0 的 MusicEx 分支仍要求外部 EKey；旧 Unlock Music 的 MGG mask 推测也无法处理此次样本。继续研究公开 QMC2 实现发现，RC4 分段会重复初始化同一状态，只改变开头跳过的字节数。这提供了从文件内重复结构恢复信息的机会。

长 MGG 的完整密钥恢复分为五步：

1. 枚举公开的 Vorbis vendor 位置，用其他音频页验证候选 Ogg 标记、流编号和固定字段。
2. 利用页面序号、长度、lacing 表统计和跨页关系，推导局部密码流与各段偏移。
3. 比较由合成音频生成的公开 Vorbis setup 模板，补齐编码配置对应的流片段。模板不是歌曲明文，也不包含用户密钥。
4. 利用每隔 512 段重复使用同一 seed 的关系，求出候选 hash 和 512 字节密钥。候选必须重新生成一致的 hash 和已知密码流。
5. 用候选密钥解密全部原始字节，包括采用不同规则加密的前 128 字节。逐页检查原始 CRC、流编号、序号、包连续性、时间位置和结束标记，全部通过后才允许输出。

恢复不会修改 CRC、重建首包或猜测采样率。研究中已确认：44.1 kHz 与 48 kHz 的公开 setup 模板可能相同，因此模板匹配本身不足以恢复音频参数。最终参数来自解密后的原始首包。

WEB 1.3 增加了 metadata 长度不可读时的公开 setup 模板搜索，并将密钥求解从至少四次重复观测扩展到三次。三次观测会产生更多 hash 别名，因此在收集候选前用另外两组独立分段观测筛选；最终唯一密钥、hash、密码流及所有原始页面 CRC 要求保持不变。某些短文件没有任何一页能够在密钥求解前完整读取，此时局部校验仅用于排除矛盾，不能冒充完整验证；完整验证始终在密钥恢复之后进行。

WEB 1.4 为短 MGG 增加直接恢复原始字节的路径，不要求先求出全部 512 字节密钥：

1. 联合搜索公开 setup 前缀与后续 Ogg 页，避免以歌曲名、文件大小或固定 metadata 位置选择模板。
2. 利用首 128 字节的特殊掩码规则、公开固定字段和分段观测求出唯一 hash；按实际 JavaScript 浮点运算核对 seed 候选。
3. 将原始 Ogg CRC32、音频包类型位与已知结构化为二进制方程；由相邻页序确定的页面边界也参与求解。lacing 长度必须精确等于原始页体长度，使用有预算的动态规划和 CaDiCaL SAT 求解，不能把求解器 unknown 当成 unsat。
4. 原始前两页的 CRC 与 seed 候选必须唯一确定首 128 字节；参数尚有多解就拒绝，不填写默认采样率。对已验证的连续 Xiph 双模式、无上下码率限制编码结构，加入相邻窗口关系。
5. 至多枚举 12 个剩余自由位。验证所有未受影响的音频包，并检查每个候选影响的包：floor/residue 不得截断，剩余位必须不足一个字节且全零。仅在支持结构内得到唯一完整候选、全部原始页 CRC 和连续性正确时输出。

这一额外包校验是**支持编码结构的限制**，不是 Vorbis 普遍规则。Vorbis 允许某些截断包，libvorbis 的普通解码器可能接受它们，受码率管理的编码器也可能主动截断或补零。实验中同一份约 2.87 MB 合成文件存在 256 个 CRC 合格候选，其中 227 个能被普通 FFmpeg 解码，因此“能播放”和 CRC 都不能单独证明恢复正确。包校验器增加可审计的显式 EOP 标记，避免把解码器容错当成完整包。

任何尚未搜索完的结构、预算耗尽、未解决的前缀或多个完整候选都导致拒绝；它们不会被当作已排除分支后返回另一个结果。

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
- 音频体从 2,000,000 字节开始分析。短文件是否支持由可恢复信息决定，并非固定大小阈值；约 2 MB 的部分文件仍可能不支持。旧 4.1 MiB 文件本轮已不在测试目录，不能声称对该文件通过验收。
- 短 MGG 额外要求双声道、两种模式的 blockflag 为 [0, 1]、上下码率字段为零、连续窗口关系和完整音频包。其他编码器、不同密钥长度、稀疏分页、填充不足或损坏文件不能据此推定兼容。
- 对假设不一致、搜索超时、不能唯一恢复或 CRC 错误的输入直接报错，不输出局部音频。
- 处理运行在临时 Worker 中，可以停止；文件和恢复出的密钥不会写入 localStorage、日志或服务器。

## 验证方式

真实样本的研究实验在禁止网络、QQ 音乐目录和旧解密结果访问的沙箱内完成。完整输出有 2,105 个 Ogg 页，所有原始 CRC 正确；独立 ffprobe 和 ffmpeg 全曲解码通过。原始首包恢复为 44.1 kHz 双声道，时长 240.991973 秒。文件改名不影响结果。

研究还从另一条 CRC 线性求解路径得到 5,631 字节密码流，与最终恢复密钥产生的流全部相同。这是交叉核验；参与方程求解的页面不冒充独立验证数据。

仓库不包含该歌曲、真实密钥、账号资料或研究中间状态。自动测试使用随机密钥、合成音频和破坏校验和的负面输入。

独立生成的合成音频采用另一把 512 字节密钥、不同 metadata 长度及分页位置。恢复进程只能读取加密文件，禁止读取生成器、测试密钥和 oracle；恢复出的 9,031,173 字节与事后核对的原文 SHA-256 完全一致，1,639 个原始页面 CRC 全部通过。WEB 1.1 当时对另一种较长 metadata 的夹具和稀疏分页夹具明确拒绝，没有把它们计作兼容通过；这些历史结果不用于推断新版兼容性。

WEB 1.3 的真实文件验收覆盖四个 MGG 与一个 MFLAC：音频体分别约 5.8、6.7、8.9、9.3、19.9 MiB。均以随机 `.bin` 文件名交给产品 `decryptFile`，仅读取该加密文件，完整解码通过。新增 MGG 的 1,321 / 1,577 / 2,187 个原始页面 CRC 均正确；原成功样本的 2,105 个页面回归通过。MFLAC 恢复 5,397,840 个原始样本、44.1 kHz / 24 bit / 双声道，122.4 秒；完整 PCM MD5 与原始 STREAMINFO 一致。

另以公开 FFmpeg 合成 120 秒、16 bit 的噪声音频，使用独立 Python QMC2 编码器与三把不同的 512 字节测试密钥生成 MFLAC。三个盲恢复结果均通过全部原始 FLAC 校验，事后与隔离保存的原文 SHA-256 逐字节比对一致，完整解码通过。生成器只产生测试数据，不包含真实音乐或用户密钥。

WEB 1.4 的短文件验收使用新下载的《保留》MGG（2,800,895 字节，音频体 2,800,703 字节）。恢复过程只可读取加密文件，禁止网络、QQ 音乐目录、旧解密结果及 oracle。独立合成的 2,872,531 字节音频体也由相同产品模块盲恢复，事后与隔离保存的原文逐字节一致。另一个 2,682,417 字节测试文件因第二页信息不足被拒绝，2,141,971 字节测试文件的首包参数仍有多解；这两项不计为成功。约 4.04 MB 的另一独立样本在 hash 域搜索预算内也未解决。新增生成器使用两把新测试密钥重新加密相同 2.68 / 2.87 MB 音频，两份均安全拒绝，没有输出；不能把一个成功样本推广到相同长度或所有密钥。

新增《我不难过》MFLAC（35,801,895 字节）的失败来自填充候选的过早筛选：该文件起始只能推导 4,944 个流字节，低于旧的 5,000 门槛。新版允许从 4,096 个字节起继续核验，未降低最终 CRC、子帧结构或密钥一致性要求。恢复后的 14,129,640 个样本、44.1 kHz / 16 bit / 双声道完整解码通过，PCM MD5 与原始 STREAMINFO 一致。独立生成 case 21（metadata 增加 700 字节，起始 4,973 个已知流字节）也覆盖此回归边界；测试数据不包含用户文件或真实密钥。

本轮产品路径复测 7 首真实歌曲，全部完整恢复并通过 FFmpeg 整曲解码。全新 Chrome 会话中，2.80 MB MGG 与 35.80 MB MFLAC 的单文件选择、停止后继续、320 kbps MP3 下载均通过；逐帧验证 10,343 / 12,267 个音频帧，且未发生音频上传或外部请求。旧 QTag、普通 WAV、失败后继续、4 种窗口尺寸均通过回归。Playwright WebKit 的普通音频通过，原生 FLAC 不可用时明确拒绝；不据此声称 Safari 的加密音频转 MP3 兼容。

自动测试包含三次分段重复、候选爆量、零 seed、浮点边界、稀疏观测、错误流、超时、可变 metadata 的独立随机容器，以及 FLAC 损坏、截断、伪帧头、原始 CRC、子帧语法和 metadata 越界。10 个公开编码模板可从合成正弦波逐字节重现。

WEB 1.1 的全新浏览器会话中，Chrome 的原格式与 MP3 下载、Playwright WebKit 的原格式下载均通过整曲解码。原格式 SHA-256 一致，停止后重新开始也成功。测试阻断了所有外部请求及非 GET / HEAD 请求，未发生音频上传或账号请求。旧 QTag、普通音频、失败后继续处理与四种窗口尺寸的回归验收同时通过。

```bash
cd web
npm test
npm run build

# 需要启用了 libvorbis 的 ffmpeg；输出目录必须位于仓库外。
python tests/generate_file_only_fixtures.py --help
python tests/generate_file_only_flac_fixtures.py --output /tmp/flac-fixtures --metadata-bytes 700
python tests/generate_short_mgg_fixtures.py --output /tmp/short-mgg-fixtures
# 在只允许读取 inputs/ 的独立进程内运行，结束后再与 private/ 中的 hash 比较。
node tests/recover_flac_fixture.mjs /tmp/flac-fixtures/inputs/noise-0.mflac /tmp/recovered.flac

# 浏览器验收只把 INPUT.mgg 交给网页；SHA256 仅在下载后比较。
python tests/file_only_browser.py http://127.0.0.1:4173 INPUT.mgg OUTPUT_DIR EXPECTED_MP3_SHA256
```

短 MGG 的生成、隔离和事后逐字节比较见 [复现说明](../tests/SHORT_MGG_FIXTURES.md)。生成合成夹具时会产生独立的 oracle 和测试密钥，恢复进程不能读取它们。恢复结束后再比较输出 SHA-256。WebKit 自动化结果不等同于 Safari 或 iOS 实机测试。

## 直接来源

- [QMC2 分段实现](https://github.com/bczhc/qmc-decode/blob/master/QMC2-crypto/qmc2-crypto/StreamCencrypt.cpp)：公开的 RC4 状态重置、跳过字节与 seed 选择规则。
- [早期 Unlock Music mask 推测](https://git.edik.cn/github/unlock-music/src/commit/e7b86a47790973012cc7391a60e595486348b054/src/decrypt/qmcMask.js)：2020-04-26；提供历史格式与公开 Vorbis 头模板参考，不是本次新版恢复的现成实现。
- [MusicKey QMC 实现](https://github.com/Xiaowu-0916/music-key/blob/5ee0d19c28021348f89a78933c99c7567c135cf5/musickey/formats/qmc.py)：2026-08-26，v1.0.0；独立实测在无 EKey/密钥库时拒绝此次 MusicEx 样本。
- [DSH Audio Converter](https://github.com/yousj666/dsh-audio-converter)：2026-09-27；其格式说明仍要求 MusicEx 外部 EKey，未作为解决路径采用。
- [Ogg framing](https://xiph.org/ogg/doc/framing.html) 与 [Vorbis 规范](https://xiph.org/vorbis/doc/Vorbis_I_spec.html)：页面、lacing、包头和 CRC 定义。
- [libvorbis 1.3.7](https://github.com/xiph/vorbis/tree/v1.3.7)：公开编码模板生成器；许可保存在 `public/sources/libvorbis-COPYING.txt`。
- [CaDiCaL WASM 0.1.2](https://github.com/dgreensp/cadical-wasm)：2026-08-01，MIT；作为精确整数约束求解工具采用，并非现成的音乐解密器。
- [Xiph 连续窗口实现](https://github.com/xiph/vorbis/blob/c2aa86b05e981c96bf381fc6aa11cdd03eccc2fb/lib/block.c) 与 [码率管理截断路径](https://github.com/xiph/vorbis/blob/c2aa86b05e981c96bf381fc6aa11cdd03eccc2fb/lib/bitrate.c)：固定提交 2025-12-05，支持约束与反例的直接来源。
- [RFC 9639](https://www.rfc-editor.org/rfc/rfc9639.html)：2024-12，FLAC 零填充、帧头、子帧、CRC 与 PCM MD5 的原始规范；于 2026-10-14 复核。新路径依据这些格式约束实现，不依赖额外的账号或密钥服务。

上述实现是有限格式下的单文件恢复实验，不是所有 QQ 音乐文件的通用解密证明。
