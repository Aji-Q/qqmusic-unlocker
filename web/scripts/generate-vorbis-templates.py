"""Reproduce public codec configuration templates from synthetic sine waves.

No song, metadata, key, account, or downloaded audio is required.
Use --ffmpeg /path/to/libvorbis-enabled-ffmpeg. --check does not modify sources.
"""
from pathlib import Path
import argparse
import base64
import hashlib
import json
import re
import subprocess
import tempfile


def packets(data):
    offset = 0
    packet = bytearray()
    while offset < len(data):
        assert data[offset:offset + 5] == b'OggS\0'
        count = data[offset + 26]
        lacing = data[offset + 27:offset + 27 + count]
        start = offset + 27 + count
        for size in lacing:
            packet.extend(data[start:start + size])
            start += size
            if size < 255:
                yield bytes(packet)
                packet.clear()
        offset = start
    assert not packet


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ffmpeg', default='ffmpeg')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    unique = {}
    with tempfile.TemporaryDirectory(prefix='vorbis-public-templates-') as temporary:
        for quality in range(-1, 11):
            output = Path(temporary) / f'q{quality}.ogg'
            subprocess.run([
                args.ffmpeg, '-y', '-v', 'error', '-f', 'lavfi', '-i',
                'sine=frequency=997:sample_rate=44100:duration=0.25',
                '-ac', '2', '-c:a', 'libvorbis', '-q:a', str(quality), str(output),
            ], check=True)
            setup = next(packet for packet in packets(output.read_bytes()) if packet.startswith(b'\x05vorbis'))
            digest = hashlib.sha256(setup).hexdigest()
            item = unique.setdefault(digest, {'qualities': [], 'bytes': setup})
            item['qualities'].append(quality)
    encoded = [{
        'id': 'libvorbis-stereo-q' + ','.join(map(str, item['qualities'])),
        'sha256': digest, 'base64': base64.b64encode(item['bytes']).decode(),
    } for digest, item in unique.items()]
    target = Path(__file__).resolve().parents[1] / 'src/vorbis-templates.js'
    if args.check:
        stored = json.loads(re.search(r'const ENCODED = (\[.*\]);', target.read_text()).group(1))
        assert encoded == stored, 'Encoder templates differ: review libvorbis version/configuration.'
        print(f'{len(encoded)} public templates reproduced byte for byte')
    else:
        target.write_text('''/** Public libvorbis setup packets generated from synthetic audio.
 * Reproduce with scripts/generate-vorbis-templates.py (libvorbis 1.3.7).
 * No song, metadata, or secret is included. See public/sources/libvorbis-COPYING.txt.
 */
const ENCODED = ''' + json.dumps(encoded, separators=(',', ':')) + ''';

let decoded;
export function vorbisTemplates() {
  decoded ??= ENCODED.map(({ id, sha256, base64 }) => ({
    id, sha256, bytes: Uint8Array.from(atob(base64), (value) => value.charCodeAt(0)),
  }));
  return decoded;
}
''')
        print(f'Wrote {len(encoded)} public templates to {target}')


if __name__ == '__main__':
    main()
