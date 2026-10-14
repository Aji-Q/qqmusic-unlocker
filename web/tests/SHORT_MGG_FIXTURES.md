# Independent short MGG fixtures

The generator creates synthetic stereo white noise, encodes it with FFmpeg/libvorbis q9, and encrypts it using the existing independent Python test encoder. It imports no product recovery code, reads no account or user music, and makes no network requests. The 56/60-second cases use 40 ms Ogg pages and the public historical Xiph vendor string. With the tested encoder they contain 2,682,417 and 2,872,531 audio-body bytes. These reproduce the research audio parameters; the original research keys were random and are not included.

```sh
python3 web/tests/generate_short_mgg_fixtures.py --output /tmp/qqmusic-short-fixtures
```

Use `--ffmpeg PATH` if needed. Default keys are new random 512-byte test keys. For repeatable experimental inputs, supply `--seed TEST-SEED` at generation time; never give the seed to the recovery process. Different encoder versions and keys can change recovery difficulty. A 2–3 MB file is not guaranteed recoverable solely because of its size.

The output is split into `inputs/` (encrypted files), `private/` (originals, keys, expected hashes), and a public manifest containing only input sizes/hashes. Do not commit generated outputs. Generate outside the repository and keep `private/` inaccessible during recovery.

After installing normal web dependencies (`cd web && npm ci`), the runner invokes the same `decryptFile()` entry point as the application:

```sh
mkdir /tmp/qqmusic-short-fixtures/recovered
node web/tests/recover_short_mgg_fixture.mjs \
  /tmp/qqmusic-short-fixtures/inputs/mid1.mgg \
  /tmp/qqmusic-short-fixtures/recovered/mid1.ogg
```

It reads only the explicitly supplied encrypted file and product code/assets, writes an output only after recovery and original Ogg CRC checks succeed, and prints the output SHA-256. It has no key, oracle, metadata, or seed option. Existing outputs are never overwritten. Exit 0 means recovery succeeded; exit 2 means unresolved; exit 1 means an operational error. `--expect-rejection` returns 0 for a product `file_only_unsupported` result but does not treat timeouts as a passing negative test.

For an enforced blind run on macOS, create a sandbox profile **before recovery**:

```sh
python3 - /tmp/qqmusic-short-fixtures <<'PY'
from pathlib import Path
import json, sys
base = Path(sys.argv[1]).resolve()
blocked = [base / 'private', Path.home() / 'Library']
profile = '(version 1)\n(allow default)\n(deny network*)\n'
for path in blocked:
    profile += '(deny file-read* (subpath ' + json.dumps(str(path)) + '))\n'
(base / 'recovery.sb').write_text(profile)
PY
sandbox-exec -f /tmp/qqmusic-short-fixtures/recovery.sb \
  node web/tests/recover_short_mgg_fixture.mjs \
  /tmp/qqmusic-short-fixtures/inputs/mid1.mgg \
  /tmp/qqmusic-short-fixtures/recovered/mid1.ogg
```

On other systems, use a separate recovery account/container with only the encrypted inputs and application code/dependencies mounted, with network disabled and `private/` unavailable. File permissions alone are not a blind boundary when both processes run as the same user.

**Only after the recovery process exits successfully**, compare its output with the withheld original in a separate process:

```sh
python3 - /tmp/qqmusic-short-fixtures <<'PY'
from pathlib import Path
import hashlib, sys
base = Path(sys.argv[1])
original = (base / 'private/mid1.ogg').read_bytes()
recovered = (base / 'recovered/mid1.ogg').read_bytes()
assert recovered == original, 'Recovered bytes differ from withheld original'
print(len(recovered), hashlib.sha256(recovered).hexdigest())
PY
```

This separates the recovery decision from the known-answer check. Never use the private hash to choose among ambiguous candidate outputs. An unresolved case must remain unresolved.
