#!/usr/bin/env python3
"""Build the small packet validator; downloads stay in a temporary work directory.
Requires Python >= 3.10 and Git. No shell startup files or global SDK settings change.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

VERSION = '4.0.22'
PINS = {
    'emsdk': ('https://github.com/emscripten-core/emsdk.git', '8f685c26ee9f672081e61e22c6aa60fa972d00a9'),
    'vorbis': ('https://github.com/xiph/vorbis.git', '1b75110b5a2754ba1931d82dd83cb822b266a21d'),
    'ogg': ('https://github.com/xiph/ogg.git', '06a5e0262cdc28aa4ae6797627a783b5010440f0'),
}
BASE = Path(__file__).resolve().parent
WEB = BASE.parent.parent


def run(command, **kwargs):
    subprocess.run([str(item) for item in command], check=True, **kwargs)


def checkout(path, name):
    url, commit = PINS[name]
    if not (path / '.git').exists():
        path.mkdir(parents=True, exist_ok=True)
        run(['git', 'init', path])
        run(['git', '-C', path, 'fetch', '--depth=1', url, commit])
        run(['git', '-C', path, 'checkout', '--detach', 'FETCH_HEAD'])
    actual = subprocess.check_output(['git', '-C', str(path), 'rev-parse', 'HEAD'], text=True).strip()
    if actual != commit:
        raise RuntimeError(f'{name} checkout is {actual}; expected pinned {commit}')
    if subprocess.check_output(['git', '-C', str(path), 'diff', '--name-only'], text=True).strip():
        raise RuntimeError(f'{name} contains modified tracked sources')


def main():
    if sys.version_info < (3, 10):
        raise SystemExit('Use Python 3.10 or newer (modern emsdk requires it).')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-dir', type=Path, default=Path(tempfile.gettempdir()) / 'qqmusic-vorbis-validator-build')
    for name in PINS:
        parser.add_argument(f'--{name}', type=Path, help='Reuse an existing checkout at the exact pinned commit')
    args = parser.parse_args()
    paths = {name: (getattr(args, name) or args.work_dir / name).resolve() for name in PINS}
    for name, path in paths.items():
        checkout(path, name)
    sdk, vorbis, ogg = (paths[name] for name in ('emsdk', 'vorbis', 'ogg'))
    if not (sdk / 'upstream/emscripten/emcc.py').exists():
        run([sys.executable, sdk / 'emsdk.py', 'install', VERSION])
    run([sys.executable, sdk / 'emsdk.py', 'activate', VERSION, '--embedded'])
    env = os.environ.copy()
    local_bins = list((sdk / 'python').glob('*/bin')) + list((sdk / 'node').glob('*/bin'))
    env['PATH'] = os.pathsep.join(map(str, local_bins)) + os.pathsep + env.get('PATH', '')
    env['EM_CONFIG'] = str(sdk / '.emscripten')
    env['EM_CACHE'] = str(sdk / 'upstream/emscripten/cache')
    emcc = [sys.executable, str(sdk / 'upstream/emscripten/emcc.py')]
    version = subprocess.check_output(emcc + ['--version'], text=True, env=env)
    if f' {VERSION} ' not in version.splitlines()[0]:
        raise RuntimeError(f'Unexpected compiler: {version.splitlines()[0]}')
    work = args.work_dir.resolve()
    work.mkdir(parents=True, exist_ok=True)
    patched = work / 'patched-vorbis'
    (patched / 'lib').mkdir(parents=True, exist_ok=True)
    patched_names = ('floor0', 'floor1', 'res0')
    for name in patched_names:
        shutil.copyfile(vorbis / 'lib' / f'{name}.c', patched / 'lib' / f'{name}.c')
    # Apply only to fresh temporary copies; leave the pinned upstream checkout clean.
    patch_env = os.environ.copy()
    for key in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'):
        patch_env.pop(key, None)
    patch_env['GIT_CEILING_DIRECTORIES'] = str(work)
    run(['git', 'apply', '--check', BASE / 'strict-eop.patch'], cwd=patched, env=patch_env)
    run(['git', 'apply', BASE / 'strict-eop.patch'], cwd=patched, env=patch_env)
    for name, expected_calls in [('floor0', 2), ('floor1', 1), ('res0', 2)]:
        if (patched / 'lib' / f'{name}.c').read_text().count('qqv_incomplete(vb);') != expected_calls:
            raise RuntimeError(f'Missing strict decoder hooks in {name}.c')
    output = work / 'vorbis-validator.js'
    sources = 'mdct smallft block envelope window lsp lpc analysis synthesis psy info floor1 floor0 res0 mapping0 registry codebook sharedbook lookup bitrate'.split()
    exports = ['_qqv_create', '_qqv_header', '_qqv_ready', '_qqv_packet', '_qqv_consumed', '_qqv_remaining', '_qqv_destroy', '_malloc', '_free']
    command = emcc + [
        '-O3', '-flto', '-DNDEBUG', '-DHAVE_ALLOCA_H',
        f'-I{BASE / "include"}', f'-I{ogg / "include"}', f'-I{vorbis / "include"}', f'-I{vorbis / "lib"}',
        str(BASE / 'validator.c'), str(ogg / 'src/bitwise.c'),
    ] + [str((patched if name in patched_names else vorbis) / 'lib' / f'{name}.c') for name in sources] + [
        '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=web,worker,node', '-sFILESYSTEM=0',
        '-sGL_ENABLE_GET_PROC_ADDRESS=0', '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=16777216',
        '-sMAXIMUM_MEMORY=67108864', '-sSTACK_SIZE=1048576', '-sABORTING_MALLOC=1', '-sASSERTIONS=0',
        '-sEXPORTED_FUNCTIONS=' + json.dumps(exports), '-sEXPORTED_RUNTIME_METHODS=["HEAPU8"]',
        '-o', str(output),
    ]
    run(command, env=env)
    destinations = [WEB / 'src/vendor/vorbis-validator.js', BASE / 'artifacts/vorbis-validator.wasm']
    for source, destination in zip([output, output.with_suffix('.wasm')], destinations):
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
    public_asset = WEB / 'public/vendor/vorbis-validator.wasm'
    public_asset.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(destinations[1], public_asset)
    license_dir = BASE / 'licenses'
    license_dir.mkdir(parents=True, exist_ok=True)
    licenses = {
        'libvorbis-COPYING.txt': vorbis / 'COPYING',
        'libogg-COPYING.txt': ogg / 'COPYING',
        'Emscripten-LICENSE.txt': sdk / 'upstream/emscripten/LICENSE',
        'musl-COPYRIGHT.txt': sdk / 'upstream/emscripten/system/lib/libc/musl/COPYRIGHT',
        'compiler-rt-LICENSE.txt': sdk / 'upstream/emscripten/system/lib/compiler-rt/LICENSE.TXT',
    }
    for name, source in licenses.items():
        shutil.copyfile(source, license_dir / name)
    shutil.copytree(license_dir, WEB / 'public/vendor/vorbis-validator-licenses', dirs_exist_ok=True)
    info = {
        'emscripten': VERSION,
        'sources': {name: {'url': url, 'commit': commit} for name, (url, commit) in PINS.items()},
        'patches': {'strict-eop.patch': hashlib.sha256((BASE / 'strict-eop.patch').read_bytes()).hexdigest()},
        'files': {str(path.relative_to(WEB)): {'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in destinations},
    }
    (BASE / 'build.json').write_text(json.dumps(info, indent=2) + '\n')
    print(json.dumps(info, indent=2))


if __name__ == '__main__':
    main()
