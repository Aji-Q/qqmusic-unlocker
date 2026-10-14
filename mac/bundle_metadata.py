"""Record the actual deployment target and licenses for the frozen dependency set."""
from __future__ import annotations

import ast
import json
import plistlib
from pathlib import Path
import re
import shutil
import subprocess
import sys

from check_bundle import MACHO


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from strings(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)


app, toc = map(Path, sys.argv[1:3])
minimum = (15, 0, 0)
for path in app.rglob('*'):
    if not path.is_file() or path.is_symlink():
        continue
    with path.open('rb') as handle:
        if handle.read(4) not in MACHO:
            continue
    commands = subprocess.run(['/usr/bin/otool', '-l', str(path)], check=True,
                              capture_output=True, text=True).stdout
    for command in commands.split('Load command '):
        if 'LC_BUILD_VERSION' in command:
            match = re.search(r'\bminos\s+([0-9.]+)', command)
        elif 'LC_VERSION_MIN_MACOSX' in command:
            match = re.search(r'\bversion\s+([0-9.]+)', command)
        else:
            continue
        if match:
            version = tuple(int(n) for n in match[1].split('.'))
            minimum = max(minimum, (version + (0, 0, 0))[:3])
plist = app / 'Contents/Info.plist'
info = plistlib.loads(plist.read_bytes())
info['LSMinimumSystemVersion'] = '.'.join(map(str, minimum[:2]))
plist.write_bytes(plistlib.dumps(info))
print('Bundle minimum macOS:', info['LSMinimumSystemVersion'])

if toc.is_file():
    notices = app / 'Contents/Resources/LICENSES'
    notices.mkdir(exist_ok=True)
    roots = set()
    for source in strings(ast.literal_eval(toc.read_text())):
        if not source.startswith('/'):
            continue
        source = str(Path(source).resolve())
        if '/Cellar/' not in source:
            continue
        prefix, rest = source.split('/Cellar/', 1)
        parts = rest.split('/')
        if len(parts) >= 2:
            roots.add(Path(prefix) / 'Cellar' / parts[0] / parts[1])
    manifest = []
    for root in sorted(roots):
        if not root.is_dir():
            continue
        target = notices / (root.parent.name + '-' + root.name)
        target.mkdir(exist_ok=True)
        for source in root.iterdir():
            if source.is_file() and source.name.upper().startswith(('LICENSE', 'COPYING', 'NOTICE', 'COPYRIGHT')):
                shutil.copy2(source, target / source.name)
        # Homebrew's installed recipe preserves exact source URLs and build options.
        if (root / '.brew').is_dir():
            shutil.copytree(root / '.brew', target / 'build-recipe', dirs_exist_ok=True)
        if (root / 'INSTALL_RECEIPT.json').is_file():
            shutil.copy2(root / 'INSTALL_RECEIPT.json', target / 'INSTALL_RECEIPT.json')
        manifest.append({'name': root.parent.name, 'version': root.name,
                         'formula': 'https://formulae.brew.sh/formula/' + root.parent.name})
    (notices / 'dependencies.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (notices / 'README.txt').write_text(
        'Bundled media tools: FFmpeg (https://ffmpeg.org).\n'
        'This distribution includes GPL components. See each dependency directory for licenses.\n'
        'Exact Homebrew source URLs and build options are in build-recipe; installed versions are in dependencies.json.\n'
        'Python: https://www.python.org/psf/license/ ; PyInstaller bootloader: https://pyinstaller.org/en/stable/license.html\n')

from datetime import datetime, timezone
import importlib.metadata
import platform
repository = Path(__file__).resolve().parents[1]
commit = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=repository,
                        text=True, capture_output=True, check=True).stdout.strip()
changed = subprocess.run(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=repository,
                         text=True, capture_output=True, check=True).stdout.strip()
build_info = {
    'version': info['CFBundleShortVersionString'], 'source_commit': commit,
    'source_dirty': bool(changed), 'build_id': info['QQMusicBuildID'],
    'architecture': platform.machine(), 'minimum_macos': info['LSMinimumSystemVersion'],
    'python': platform.python_version(), 'pyinstaller': importlib.metadata.version('pyinstaller'),
    'built_at': datetime.now(timezone.utc).isoformat(),
    'dependencies': 'LICENSES/dependencies.json',
    'signing': 'ad-hoc; no Developer ID or Apple notarization',
}
(app / 'Contents/Resources/BUILD-INFO.json').write_text(
    json.dumps(build_info, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
