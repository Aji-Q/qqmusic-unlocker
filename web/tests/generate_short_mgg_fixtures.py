#!/usr/bin/env python3
"""Generate independent 2.7/2.9 MB MusicEx MGG test inputs.

Only inputs/*.mgg may be exposed to recovery. The private/ directory contains
original audio, random test keys, and expected hashes; use it only AFTER blind
recovery has finished. No user music, account data, product decoder, or network
is used. Requires FFmpeg with libvorbis. Audio parameters match the research
mid0/mid1 cases, but fresh independent keys change the recovery problem.
"""
import argparse
import hashlib
import json
from pathlib import Path
import secrets
import subprocess

from generate_file_only_fixtures import (
    describe, digest, find_ffmpeg, musicex_footer, rc4_transform, replace_comments,
)

CASES = (
    {"name": "mid0", "duration": 56, "audio_seeds": [5546, 4823], "serial": 71513, "index": 0},
    {"name": "mid1", "duration": 60, "audio_seeds": [5637, 4905], "serial": 71636, "index": 1},
)


def private_write(path, data):
    path.write_bytes(data)
    path.chmod(0o600)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--ffmpeg')
    parser.add_argument('--case', choices=['mid0', 'mid1', 'both'], default='both')
    parser.add_argument('--seed', help='Optional reproducible TEST key seed; never pass it to recovery')
    args = parser.parse_args()
    destination = args.output.expanduser().resolve()
    repo = Path(__file__).resolve().parents[2]
    if destination == repo or repo in destination.parents:
        raise SystemExit('Generate fixtures outside the repository; do not commit keys or audio.')
    if destination.exists() and any(destination.iterdir()):
        raise SystemExit('Choose an empty output directory to keep fixture runs independent.')
    inputs, private = destination / 'inputs', destination / 'private'
    inputs.mkdir(parents=True, exist_ok=True)
    private.mkdir(mode=0o700, exist_ok=True)
    private.chmod(0o700)
    ffmpeg = find_ffmpeg(args.ffmpeg)
    version = subprocess.check_output([ffmpeg, '-version'], text=True).splitlines()[0]
    manifest = {'generator': Path(__file__).name, 'ffmpeg': version,
                'source': 'Independent seeded white-noise channels, 44100 Hz stereo libvorbis q9',
                'page_duration_microseconds': 40000,
                'blind_rule': 'Only inputs/*.mgg may be read during recovery', 'cases': []}
    for case in CASES:
        if args.case != 'both' and case['name'] != args.case:
            continue
        name = case['name']
        target = private / f'{name}.ogg'
        command = [ffmpeg, '-hide_banner', '-v', 'error', '-y']
        for seed in case['audio_seeds']:
            command += ['-f', 'lavfi', '-i',
                        f'anoisesrc=r=44100:d={case["duration"]}:a=0.55:color=white:seed={seed}']
        command += ['-filter_complex', '[0:a][1:a]amerge=inputs=2[a]', '-map', '[a]',
                    '-c:a', 'libvorbis', '-q:a', '9', '-ac', '2', '-ar', '44100',
                    '-map_metadata', '-1', '-fflags', '+bitexact',
                    '-serial_offset', str(case['serial']), '-page_duration', '40000', str(target)]
        subprocess.run(command, check=True)
        plain = replace_comments(target.read_bytes(), f'Independent short case {case["index"]}', 'Blind fixture')
        private_write(target, plain)
        if not 2_000_000 <= len(plain) < 4_000_000:
            raise SystemExit(f'Unexpected fixture size {len(plain)}; record the FFmpeg/libvorbis version.')
        if args.seed is None:
            key = secrets.token_bytes(512)
        else:
            key = hashlib.shake_256((args.seed + '\0' + name).encode()).digest(512)
        encrypted = rc4_transform(plain, key)
        if rc4_transform(encrypted, key) != plain:
            raise AssertionError('Independent encoder round-trip failed')
        complete = encrypted + musicex_footer(name, case['serial'])
        (inputs / f'{name}.mgg').write_bytes(complete)
        private_write(private / f'{name}.key', key)
        expected = {**case, 'plain': describe(plain), 'seed': args.seed,
                    'key_sha256': digest(key), 'encrypted_sha256': digest(complete)}
        private_write(private / f'{name}.json', (json.dumps(expected, indent=2) + '\n').encode())
        subprocess.run([ffmpeg, '-v', 'error', '-xerror', '-i', str(target), '-f', 'null', '-'], check=True)
        public = {'name': name, 'bytes': len(complete), 'body_bytes': len(plain),
                  'duration_seconds': case['duration'], 'input_sha256': digest(complete)}
        manifest['cases'].append(public)
        print(json.dumps(public), flush=True)
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('Recovery may read only inputs/. Compare private/ originals after recovery exits.')


if __name__ == '__main__':
    main()
