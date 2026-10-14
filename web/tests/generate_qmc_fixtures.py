#!/usr/bin/env python3
"""Generate deterministic, synthetic QMC vectors from the desktop engine.

Run from any directory with Python 3. No user audio or credentials are read.
The fixture JSON is committed so the JS tests need only Node.js to run.
"""
import base64
import io
import json
import shutil
import struct
import subprocess
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "app"))
import qmengine as engine

DEST = Path(__file__).resolve().parent / "fixtures"
DEST.mkdir(exist_ok=True)


def b64(data):
    return base64.b64encode(data).decode("ascii")


def tea_encrypt(data, key):
    pad = (8 - (len(data) + 10) % 8) % 8
    padded = bytes([0xA0 | pad]) + bytes(range(pad)) + b"\x12\x34" + data + b"\0" * 7
    words = struct.unpack(">4I", key)
    previous_cipher = previous_block = 0
    out = bytearray()
    for offset in range(0, len(padded), 8):
        block = int.from_bytes(padded[offset:offset + 8], "big") ^ previous_cipher
        cipher = engine._ecb(block, words, True) ^ previous_block
        out += cipher.to_bytes(8, "big")
        previous_cipher, previous_block = cipher, block
    assert engine.tc_tea_decrypt(out, key) == data
    return bytes(out)


def encoded_key(key, encv2=False):
    encoded = key[:8] + tea_encrypt(key[8:], engine._derive_tea_key(key[:8]))
    result = b64(encoded)
    if encv2:
        second = tea_encrypt(result.encode(), engine._ENC_V2_KEYS[1])
        result = b64(engine._ENC_V2_PREFIX + tea_encrypt(second, engine._ENC_V2_KEYS[0]))
    assert engine.parse_ekey(result) == key
    return result


def payload(length, header):
    return header + bytes((index * 73 + index // 37) % 256 for index in range(length - len(header)))


cases = []
for name, key, plain, tagged, encv2 in [
    ("map-v1", b"12345678", payload(65543, b"fLaC"), False, False),
    ("map-tea-qtag", bytes(range(8, 72)), payload(12001, b"OggS"), True, False),
    ("rc4-tea-v1", bytes((index * 17 + 3) % 256 for index in range(512)), payload(20023, b"fLaC"), False, False),
    ("rc4-encv2-qtag", bytes((index * 31 + 5) % 256 for index in range(320)), payload(17003, b"OggS"), True, True),
]:
    ekey = b64(key) if name == "map-v1" else encoded_key(key, encv2)
    encrypted = bytearray(plain)
    engine.make_cipher(key).decrypt(0, encrypted)
    key_text = ekey.encode()
    footer = key_text + struct.pack(">I" if tagged else "<I", len(key_text)) + (b"QTag" if tagged else b"")
    complete = bytes(encrypted) + footer
    if tagged:
        # Independently verify the on-disk byte order, not only a round-trip
        # through the same implementation that produced the fixture.
        assert complete[-8:-4] == len(key_text).to_bytes(4, "big")
        assert complete[-8:-4] != len(key_text).to_bytes(4, "little")
    else:
        assert complete[-4:] == len(key_text).to_bytes(4, "little")
    kind, meta, end = engine.detect_footer(complete)
    assert kind == ("QTag" if tagged else "V1")
    assert end == len(plain)
    assert engine.parse_ekey(meta["ekey"]) == key
    decoded = bytearray(complete[:end])
    engine.make_cipher(key).decrypt(0, decoded)
    assert bytes(decoded) == plain
    filename = name + (".mflac" if plain.startswith(b"fLaC") else ".mgg")
    (DEST / filename).write_bytes(complete)
    cases.append({"name": name, "file": filename, "key": b64(key), "ekey": ekey,
                  "plain": b64(plain), "cipher": b64(encrypted), "extension": ".flac" if plain.startswith(b"fLaC") else ".ogg"})

tea_key = bytes(range(16))
tea_plain = b"Synthetic Tencent TEA cross-language fixture."
vectors = {"source": "app/qmengine.py", "cases": cases,
           "tea": {"key": b64(tea_key), "plain": b64(tea_plain), "cipher": b64(tea_encrypt(tea_plain, tea_key))}}
(DEST / "vectors.json").write_text(json.dumps(vectors, indent=2) + "\n", encoding="utf-8")

# A valid tiny, silent WAV is available for full browser transcoding tests.
buffer = io.BytesIO()
with wave.open(buffer, "wb") as wav:
    wav.setnchannels(1)
    wav.setsampwidth(2)
    wav.setframerate(8000)
    wav.writeframes(b"\0\0" * 8000)
(DEST / "silence.wav").write_bytes(buffer.getvalue())
if shutil.which("ffmpeg"):
    # Optional fixture for a complete encrypted-file -> MP3 browser smoke test.
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                    "-i", str(DEST / "silence.wav"), "-map_metadata", "-1",
                    str(DEST / "silence.flac")], check=True)
    real_flac = (DEST / "silence.flac").read_bytes()
    encrypted_flac = bytearray(real_flac)
    key = b"12345678"
    engine.make_cipher(key).decrypt(0, encrypted_flac)
    ekey = base64.b64encode(key)
    (DEST / "silence.mflac").write_bytes(encrypted_flac + ekey + struct.pack("<I", len(ekey)))
    # Valid QTag audio, including metadata, for a full browser/desktop smoke test.
    qtag_metadata = ekey + b",123456,2"
    (DEST / "silence-qtag.mflac").write_bytes(
        encrypted_flac + qtag_metadata + struct.pack(">I", len(qtag_metadata)) + b"QTag")
    decoded = bytearray(encrypted_flac)
    engine.make_cipher(key).decrypt(0, decoded)
    assert bytes(decoded) == real_flac
print("Generated Python-verified QMC vectors and valid synthetic audio fixtures.")
