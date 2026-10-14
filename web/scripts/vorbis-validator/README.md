# Vorbis packet validator

This small, local WebAssembly module narrows ambiguous file-only recovery candidates using Xiph packet decoding with explicit early-exit instrumentation. It returns no PCM and sends no audio to a server. The caller must first verify the original Ogg checksums and, after selecting a unique result, validate every audio packet.

This is a **restricted complete-packet Xiph VBR profile**, not a general Vorbis validity checker. Legal Vorbis streams may use truncation or extra padding, including Xiph rate-managed encoding. Such streams are deliberately unsupported by this filter. A successful parse does not prove a candidate is the unique original file; the recovery caller must enforce uniqueness across its complete candidate set.

The three parsed headers must describe two channels, zero upper/lower bitrate hints, and exactly two modes with block flags `[0, 1]`. Each audio packet must parse without end-of-packet overread and leave only 0–7 zero padding bits. Continuous-stream window relations and original page CRCs are checked by the recovery code, not this module. These header conditions alone do not prove encoder provenance; callers additionally use the public supported setup-template/vendor profile.

## Use

```js
import { createValidatorFactory } from '../../src/vorbis-packet-validator.js';

const makeValidator = await createValidatorFactory();
const validator = makeValidator([identification, comments, setup]);
try {
  const valid = validator.validatePacket(audioPacket); // boolean
  const detail = validator.inspect(audioPacket);      // valid, status, consumed, remaining
  console.log(validator.profile);                     // parsed header values
} finally {
  validator.dispose();
}
```

The factory is asynchronous; context creation and packet validation are synchronous. Invalid headers throw. The same context can validate candidate packets in any order; no PCM accumulation or previous packet is needed. `dispose()` is idempotent. `close()` is its alias. `profileOK` is true for successfully initialized contexts. Browser and worker loading defaults to same-origin `/vendor/vorbis-validator.wasm`; Node loads the committed build artifact. Pass Emscripten's `wasmBinary` or `locateFile` options to override loading.

C exports: `qqv_create`, `qqv_header`, `qqv_ready`, `qqv_packet`, `qqv_consumed`, `qqv_remaining`, `qqv_destroy`. Successful header/packet calls return 0. Header failures include malformed headers (-2), channel count (-20), rate-management hints (-21), unsupported modes (-22), and initialization failures (-23/-24). Packet failures include malformed packet (-6), overread (-7), nonzero padding (-8), excessive padding (-9), and early floor/residue decoding termination (-10). JS also rejects empty or oversized packets. Headers are limited to 64 KiB; audio packets to 128 KiB. WASM starts at 16 MiB memory and may grow to 64 MiB.

## Rebuild

Requires Python 3.10+, Git, and network access for the first build:

```sh
python3 web/scripts/vorbis-validator/build.py
```

The script checks out the exact commits below, installs/activates Emscripten **4.0.22** inside its temporary work directory, compiles, and copies the generated JS, committed WASM artifact, and license files to the web application. It does not change shell startup files, globally install tools, or package its downloaded SDK. `prepare-assets.mjs` copies the committed WASM and notices into public/vendor during a normal application build, so a fresh checkout needs no Emscripten toolchain. The initial SDK/source download consumes about 2 GB of temporary disk space; the shipped module is about 80 KB before compression.

Use `--work-dir PATH` to choose the temporary directory. Existing exact-pinned checkouts may be supplied using `--emsdk PATH --vorbis PATH --ogg PATH`. Modified tracked sources are rejected. `build.json` records input commits and final SHA-256 hashes. Compilation uses `-O3 -flto`, without fast-math, filesystem access, or threads.

Pinned sources:

- [libvorbis `1b75110`](https://github.com/xiph/vorbis/tree/1b75110b5a2754ba1931d82dd83cb822b266a21d): packet decoding and internal setup definitions; only the documented strict-eop.patch is applied to temporary floor0, floor1, and residue source copies.
- [libogg `06a5e02`](https://github.com/xiph/ogg/tree/06a5e0262cdc28aa4ae6797627a783b5010440f0): bit reader; upstream source unmodified. The small `include/ogg/config_types.h` supplies fixed-width types for the wasm32 target.
- [emsdk `8f685c2`](https://github.com/emscripten-core/emsdk/tree/8f685c26ee9f672081e61e22c6aa60fa972d00a9): Emscripten 4.0.22 (`bebaf7e50e31865b0724f17eaa52e161e2dfef5a`).

License notices are committed in `web/scripts/vorbis-validator/licenses/` and copied to `web/public/vendor/vorbis-validator-licenses/`. They cover libvorbis, libogg, Emscripten's runtime, musl, and compiler-rt.

## Why the explicit early-exit patch is necessary

A failed codebook look-ahead may return -1 without advancing the bit-reader. The normal decoder deliberately tolerates truncated floor/residue data. Measuring `oggpack_bits()` alone can therefore accept a truncated packet. `strict-eop.patch` records the actual floor0/floor1 and residue failure branches; it does not flag ordinary speculative look-ahead misses, zero floors, or normal loop termination. The C wrapper resets this per-context flag before every packet and rejects flagged results. The small patch is version-pinned and its digest is recorded in `build.json`; upstream checkouts remain unchanged.

## Verification

Run `node --test web/tests/vorbis-packet-validator.test.mjs` for the public synthetic fixture, malformed/profile headers, packet truncation, nonzero/excess padding, order independence, and disposal.

During integration, native and WASM filters made identical decisions across all 64 CRC-compatible candidates of one independently recovered real file and all 256 candidates of an independent synthetic fixture. Both admitted exactly one candidate. The final complete streams passed 13,099 and 2,606 packets respectively; the synthetic recovery was also byte-identical to its withheld original after selection completed. These checks demonstrate the tested profile, not universal support for encrypted music.
