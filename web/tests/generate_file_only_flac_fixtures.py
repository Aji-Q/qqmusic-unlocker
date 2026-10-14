#!/usr/bin/env python3
"""Generate independent synthetic FLAC inputs for blind file-only recovery.

Example:
  python3 generate_file_only_flac_fixtures.py --output /tmp/flac-fixtures

Requires FFmpeg. Output is deliberately split into inputs/ (encrypted music
files) and private/ (expected plaintext, deterministic test keys and hashes).
Run recovery with access to inputs/ only, then compare output hashes in a
separate validation step. Never commit these generated files.

This independent Python QMC2 encoder imports no product code, reads no user
music or account data, and performs no network requests. Keys are deterministic
TEST DATA, not cryptographically secure credentials. The audio is generated
white noise; its metadata and 8192-byte FLAC padding are public structure.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess

SEGMENT = 5120
PERIOD = 512


def private_write(path, data):
    path.write_bytes(data)
    path.chmod(0o600)


def with_padding(source):
    if source[:4] != b"fLaC":
        raise ValueError("Expected native FLAC")
    blocks = []
    position = 4
    while True:
        if position + 4 > len(source):
            raise ValueError("Truncated FLAC metadata")
        flag = source[position]
        size = int.from_bytes(source[position + 1:position + 4], "big")
        end = position + 4 + size
        if end > len(source):
            raise ValueError("Truncated FLAC metadata block")
        if flag & 127 != 1:
            blocks.append((flag & 127, source[position + 4:end]))
        position = end
        if flag & 128:
            break
    # Reordering/removing padding does not alter any original audio frame CRC.
    metadata = b"".join(bytes([kind]) + len(data).to_bytes(3, "big") + data
                        for kind, data in blocks)
    return (b"fLaC" + metadata + bytes([0x81]) + (8192).to_bytes(3, "big")
            + bytes(8192) + source[position:])


def transform(data, key):
    state = [index & 255 for index in range(PERIOD)]
    second = 0
    for first in range(PERIOD):
        second = (second + state[first] + key[first]) % PERIOD
        state[first], state[second] = state[second], state[first]
    stream = bytearray()
    first = second = 0
    for _ in range(SEGMENT + PERIOD - 1):
        first = (first + 1) % PERIOD
        second = (second + state[first]) % PERIOD
        state[first], state[second] = state[second], state[first]
        stream.append(state[(state[first] + state[second]) % PERIOD])
    key_hash = 1
    for value in key:
        if value:
            following = (key_hash * value) & 0xFFFFFFFF
            if not following or following <= key_hash:
                break
            key_hash = following

    def skip(segment, seed):
        return int(key_hash / ((segment + 1) * seed) * 100) if seed else 0

    output = bytearray(data)
    for index in range(min(128, len(output))):
        output[index] ^= key[skip(index, key[index % PERIOD]) % PERIOD]
    for segment in range((len(output) + SEGMENT - 1) // SEGMENT):
        start = max(128, segment * SEGMENT)
        end = min(len(output), (segment + 1) * SEGMENT)
        if end <= start:
            continue
        stream_start = (skip(segment, key[segment % PERIOD]) & 511) + start % SEGMENT
        output[start:end] = bytes(a ^ b for a, b in zip(
            output[start:end], stream[stream_start:stream_start + end - start]))
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ffmpeg", default=shutil.which("ffmpeg"))
    args = parser.parse_args()
    if not args.ffmpeg:
        parser.error("FFmpeg is required; pass --ffmpeg /path/to/ffmpeg")
    private = args.output / "private"
    inputs = args.output / "inputs"
    private.mkdir(parents=True, exist_ok=True)
    inputs.mkdir(parents=True, exist_ok=True)
    source = private / "source.flac"
    subprocess.run([
        args.ffmpeg, "-v", "error", "-f", "lavfi", "-i",
        "anoisesrc=color=white:amplitude=0.25:sample_rate=44100:seed=987654:d=120",
        "-ac", "2", "-sample_fmt", "s16", "-c:a", "flac", "-compression_level", "5",
        "-metadata", "title=Independent synthetic FLAC recovery fixture", "-y", str(source),
    ], check=True)
    source.chmod(0o600)
    plain = with_padding(source.read_bytes())
    private_write(private / "expected.flac", plain)
    records = []
    for number in range(3):
        key = hashlib.shake_256(
            f"independent-flac-blind-fixture-{number}-20261014".encode()).digest(PERIOD)
        output = transform(plain, key)
        output += struct.pack("<II", 16, 0) + b"musicex\x00"
        name = f"noise-{number}.mflac"
        (inputs / name).write_bytes(output)
        private_write(private / f"key-{number}.bin", key)
        records.append({"name": name, "bytes": len(output),
                        "expected_sha256": hashlib.sha256(plain).hexdigest()})
    private_write(private / "manifest.json", json.dumps(records, indent=2).encode())
    print(json.dumps({"inputs": len(records), "body_bytes": len(plain),
                      "padding_bytes": 8192, "input_directory": str(inputs)}))


if __name__ == "__main__":
    main()
