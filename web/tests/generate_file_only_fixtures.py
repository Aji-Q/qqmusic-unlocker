#!/usr/bin/env python3
"""Create large, entirely synthetic inputs for blind musicex recovery tests.

Usage:
    python3 generate_file_only_fixtures.py --output /tmp/file-only-fixtures

Requires FFmpeg with libvorbis; no Python packages, user audio, account data or
network are used. Keep the output outside the repository: only ``inputs/*.mgg``
may be exposed to a recovery implementation. ``oracle`` and ``private`` contain
the expected plaintext and test keys, respectively, and must remain unavailable
to that implementation. Compare the recovered SHA-256 afterwards.

This is a deterministic test-data generator, not a secure key generator. Its
standalone QMC RC4 implementation deliberately does not import production code.
The Ogg vendor is replaced with a public historical libvorbis vendor string so
the fixture exercises that recovery hypothesis. This does not establish support
for arbitrary encoders. Metadata sizes and serials vary between the two cases.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile

SEGMENT = 5120
MIN_BODY_BYTES = max(8 * 1024 * 1024, 1537 * SEGMENT)
VENDOR = "Xiph.Org libVorbis I 20150105 (\u26c4\u26c4\u26c4\u26c4)".encode("utf-8")
CASES = (
    {"name": "noise-alpha", "key_seed": "synthetic-file-only-alpha-20261014",
     "title": "Independent white noise A", "artist": "Fixture generator",
     "page_duration": 110000, "serial": 137153},
    {"name": "noise-beta", "key_seed": "synthetic-file-only-beta-20261014",
     "title": "Synthetic B: " + "a deliberately longer metadata field; " * 5,
     "artist": "Second independent fixture", "page_duration": 100000,
     "serial": 274307},
)


def crc_table():
    table = []
    for byte in range(256):
        value = byte << 24
        for _ in range(8):
            value = ((value << 1) ^ (0x04C11DB7 if value & 0x80000000 else 0)) & 0xFFFFFFFF
        table.append(value)
    return table


CRC_TABLE = crc_table()


def ogg_crc(data):
    checksum = 0
    for byte in data:
        checksum = ((checksum << 8) & 0xFFFFFFFF) ^ CRC_TABLE[(checksum >> 24) ^ byte]
    return checksum


def pages(data):
    """Yield verified Ogg pages; reject trailing, truncated or corrupt bytes."""
    offset = 0
    sequence = 0
    serial = None
    while offset < len(data):
        if data[offset:offset + 5] != b"OggS\x00" or offset + 27 > len(data):
            raise ValueError("Invalid Ogg header at byte %d" % offset)
        count = data[offset + 26]
        lacing = data[offset + 27:offset + 27 + count]
        size = 27 + count + sum(lacing)
        page = bytearray(data[offset:offset + size])
        if len(lacing) != count or len(page) != size:
            raise ValueError("Truncated Ogg page")
        stored_crc = struct.unpack_from("<I", page, 22)[0]
        page[22:26] = b"\x00" * 4
        if ogg_crc(page) != stored_crc:
            raise ValueError("Ogg CRC mismatch at byte %d" % offset)
        page[22:26] = struct.pack("<I", stored_crc)
        page_serial, page_sequence = struct.unpack_from("<II", page, 14)
        if page_sequence != sequence or (serial is not None and page_serial != serial):
            raise ValueError("Expected one continuous logical stream")
        serial = page_serial
        sequence += 1
        yield offset, bytes(page), lacing
        offset += size


def page_packets(page, lacing):
    if page[5] & 1 or not lacing or lacing[-1] == 255:
        raise ValueError("Fixture headers must fit in a single complete page")
    result = []
    position = 27 + len(lacing)
    start = position
    for size in lacing:
        position += size
        if size < 255:
            result.append(page[start:position])
            start = position
    return result


def replace_comments(data, title, artist):
    """Rebuild the comments page, including lacing and CRC, without audio edits."""
    comment = bytearray(b"\x03vorbis" + struct.pack("<I", len(VENDOR)) + VENDOR)
    tags = ["TITLE=" + title, "ARTIST=" + artist,
            "COMMENT=Generated white noise; no source recording", "ENCODER=Synthetic fixture"]
    comment += struct.pack("<I", len(tags))
    for tag in tags:
        encoded = tag.encode("utf-8")
        comment += struct.pack("<I", len(encoded)) + encoded
    comment += b"\x01"
    output = bytearray()
    replacements = 0
    for _, page, lacing in pages(data):
        if page[18:22] != b"\x01\x00\x00\x00":
            output += page
            continue
        packets = page_packets(page, lacing)
        if not packets[0].startswith(b"\x03vorbis"):
            raise ValueError("Expected Vorbis comments on the second Ogg page")
        packets[0] = bytes(comment)
        new_lacing = bytearray()
        for packet in packets:
            new_lacing += b"\xff" * (len(packet) // 255) + bytes([len(packet) % 255])
        if len(new_lacing) > 255:
            raise ValueError("Header packets no longer fit in one page")
        new_page = bytearray(page[:27])
        new_page[26] = len(new_lacing)
        new_page[22:26] = b"\x00" * 4
        new_page += new_lacing + b"".join(packets)
        struct.pack_into("<I", new_page, 22, ogg_crc(new_page))
        output += new_page
        replacements += 1
    if replacements != 1:
        raise ValueError("Expected exactly one comments packet")
    # CRC validation also checks that no bytes were lost or duplicated.
    list(pages(output))
    return bytes(output)


def rc4_transform(data, key):
    """Independent QMC2 512-byte-state RC4 variant (encryption is XOR)."""
    size = len(key)
    state = [index & 255 for index in range(size)]
    second = 0
    for first in range(size):
        second = (second + state[first] + key[first]) % size
        state[first], state[second] = state[second], state[first]
    key_hash = 1
    for value in key:
        if value:
            next_hash = (key_hash * value) & 0xFFFFFFFF
            if not next_hash or next_hash <= key_hash:
                break
            key_hash = next_hash

    def skip(segment, seed):
        return int(key_hash / ((segment + 1) * seed) * 100) if seed else 0

    # QMC resets the state for each segment. Compute the shared stream once.
    stream = bytearray(SEGMENT + 511)
    first = second = 0
    for index in range(len(stream)):
        first = (first + 1) % size
        second = (second + state[first]) % size
        state[first], state[second] = state[second], state[first]
        stream[index] = state[(state[first] + state[second]) % size]
    output = bytearray(data)
    for position in range(min(128, len(output))):
        output[position] ^= key[skip(position, key[position % size]) % size]
    position = 128
    while position < len(output):
        segment, alignment = divmod(position, SEGMENT)
        count = min(SEGMENT - alignment, len(output) - position)
        start = (skip(segment, key[(segment & 511) % size]) & 511) + alignment
        for index in range(count):
            output[position + index] ^= stream[start + index]
        position += count
    return bytes(output)


def musicex_footer(name, serial):
    footer = bytearray(192)
    struct.pack_into("<I", footer, 0, serial)
    mid = ("SYNTHETIC" + str(serial)).encode("utf-16-le")
    filename = (name + ".mgg").encode("utf-16-le")
    assert len(mid) <= 60 and len(filename) <= 68
    footer[12:12 + len(mid)] = mid
    footer[72:72 + len(filename)] = filename
    struct.pack_into("<II", footer, 176, 192, 1)
    footer[184:] = b"musicex\x00"
    return bytes(footer)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def describe(data):
    parsed = list(pages(data))
    lengths = sorted(len(page) for _, page, _ in parsed)
    return {"bytes": len(data), "sha256": digest(data), "pages": len(parsed),
            "all_page_crcs_valid": True,
            "page_bytes": {"min": lengths[0], "median": lengths[len(lengths) // 2],
                           "max": lengths[-1]},
            "setup_packet_start": data.find(b"\x05vorbis"),
            "vendor_start": data.find(VENDOR),
            "full_segments": len(data) // SEGMENT,
            "page_headers_near_period_boundaries": {
                str(segment): [offset for offset, _, _ in parsed
                               if abs(offset - segment * SEGMENT) < SEGMENT]
                for segment in (512, 1024, 1536)}}


def find_ffmpeg(requested):
    candidates = [requested] if requested else [
        "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg", shutil.which("ffmpeg")]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            available = subprocess.run([candidate, "-hide_banner", "-encoders"],
                                       capture_output=True, text=True, check=True).stdout
            if "libvorbis" in available:
                return candidate
    raise SystemExit("FFmpeg with libvorbis is required; pass --ffmpeg PATH")


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--ffmpeg")
    parser.add_argument("--duration", type=int, default=190)
    parser.add_argument("--sparse", action="store_true",
                        help="also generate a 1-second-page stress fixture using the beta key")
    args = parser.parse_args()
    destination = args.output.expanduser().resolve()
    repo = Path(__file__).resolve().parents[2]
    if destination == repo or repo in destination.parents:
        raise SystemExit("Choose --output outside the repository; large fixtures/keys are private")
    destination.mkdir(parents=True, exist_ok=True)
    for directory in ("inputs", "oracle", "private"):
        (destination / directory).mkdir(exist_ok=True)
    os.chmod(destination / "private", 0o700)
    ffmpeg = find_ffmpeg(args.ffmpeg)
    version = subprocess.run([ffmpeg, "-version"], check=True, capture_output=True,
                             text=True).stdout.splitlines()[0]
    cases = list(CASES)
    if args.sparse:
        cases.append({**CASES[1], "name": "noise-beta-sparse", "page_duration": 1000000})
    manifest = {"generator": Path(__file__).name, "ffmpeg": version,
                "source": "Two independently seeded generated white-noise channels",
                "audio_seeds": [6101401, 6101402], "duration_seconds": args.duration,
                "codec": "libvorbis q9, 44100 Hz, stereo",
                "public_vendor": VENDOR.decode("utf-8"),
                "blind_input_rule": "Recovery may read only inputs/, never oracle/ or private/",
                "cases": []}
    with tempfile.TemporaryDirectory(prefix="encoding-", dir=destination) as temporary:
        source = Path(temporary) / "encoded.ogg"
        for case in cases:
            command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
            for seed in manifest["audio_seeds"]:
                command += ["-f", "lavfi", "-i",
                            "anoisesrc=r=44100:d=%d:a=0.55:color=white:seed=%d" % (args.duration, seed)]
            command += ["-filter_complex", "[0:a][1:a]amerge=inputs=2[a]", "-map", "[a]",
                        "-c:a", "libvorbis", "-q:a", "9", "-ac", "2", "-ar", "44100",
                        "-map_metadata", "-1", "-fflags", "+bitexact", "-serial_offset",
                        str(case["serial"]), "-page_duration", str(case["page_duration"]), str(source)]
            subprocess.run(command, check=True)
            plain = replace_comments(source.read_bytes(), case["title"], case["artist"])
            if len(plain) < MIN_BODY_BYTES:
                raise SystemExit("Fixture too small (%d); increase --duration" % len(plain))
            key = hashlib.shake_256(case["key_seed"].encode("ascii")).digest(512)
            encrypted = rc4_transform(plain, key)
            if rc4_transform(encrypted, key) != plain:
                raise AssertionError("Independent cipher round-trip failed")
            complete = encrypted + musicex_footer(case["name"], case["serial"])
            (destination / "inputs" / (case["name"] + ".mgg")).write_bytes(complete)
            oracle = destination / "oracle" / (case["name"] + ".ogg")
            oracle.write_bytes(plain)
            key_path = destination / "private" / (case["name"] + ".key")
            key_path.write_bytes(key)
            key_path.chmod(0o600)
            subprocess.run([ffmpeg, "-v", "error", "-xerror", "-i", str(oracle),
                            "-f", "null", "-"], check=True)
            metadata = {"name": case["name"], "key_seed": case["key_seed"],
                        "key_sha256": digest(key), "mgg_sha256": digest(complete),
                        "page_duration_microseconds": case["page_duration"],
                        "plain": describe(plain), "ffmpeg_full_decode": True}
            manifest["cases"].append(metadata)
            print(json.dumps(metadata, ensure_ascii=False), flush=True)
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print("Only inputs/*.mgg may be supplied to the blind recovery process.")


if __name__ == "__main__":
    run()
