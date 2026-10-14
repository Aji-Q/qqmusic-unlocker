"""Reject external Mach-O dependencies and smoke-test a relocated bundle with a minimal PATH."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import re
import tempfile

MACHO = {b'\xfe\xed\xfa\xce', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf',
         b'\xcf\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca'}


def check(app, report):
    failures, count = [], 0
    for path in app.rglob('*'):
        if not path.is_file() or path.is_symlink():
            continue
        with path.open('rb') as handle:
            if handle.read(4) not in MACHO:
                continue
        count += 1
        result = subprocess.run(['/usr/bin/otool', '-L', str(path)], check=True,
                                text=True, capture_output=True)
        for line in result.stdout.splitlines()[1:]:
            dep = line.strip().split(' (compatibility version', 1)[0]
            if dep.startswith(('/', '@')) and not dep.startswith(('/System/Library/', '/usr/lib/', '@rpath/', '@loader_path/', '@executable_path/')):
                failures.append(f'{path.relative_to(app)}: {dep}')
        load_commands = subprocess.run(['/usr/bin/otool', '-l', str(path)], check=True, text=True, capture_output=True).stdout
        for rpath in re.findall(r'cmd LC_RPATH\n\s*cmdsize \d+\n\s*path (.*?) \(offset', load_commands):
            if not rpath.startswith(('@loader_path', '@executable_path', '/System/Library/', '/usr/lib/')):
                failures.append(f'{path.relative_to(app)}: external rpath {rpath}')
    if failures:
        raise RuntimeError('外部动态库依赖:\n' + '\n'.join(failures))
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)], check=True)
    with tempfile.TemporaryDirectory(prefix='qm-relocated-') as tmp:
        relocated = Path(tmp) / '中文 空格目录' / app.name
        relocated.parent.mkdir()
        subprocess.run(['/usr/bin/ditto', str(app), str(relocated)], check=True)
        env = os.environ.copy()
        env['PATH'] = '/usr/bin:/bin:/usr/sbin:/sbin'
        for key in ('PYTHONPATH', 'PYTHONHOME', 'DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH'):
            env.pop(key, None)
        service = relocated / 'Contents/Resources/service/QQMusicService'
        subprocess.run([str(service), '--selftest', '--selftest-report', str(report)],
                       env=env, check=True, timeout=90)
    data = json.loads(report.read_text(encoding='utf-8'))
    assert data['ok'], data
    data['checks'].extend(['ad_hoc_signature_verified', 'relocated_minimal_path', 'no_external_dylibs'])
    data['mach_o_files'] = count
    report.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Bundle checks passed: {count} Mach-O files; {report}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('app', type=Path)
    parser.add_argument('--report', type=Path, default=Path('mac-selftest.json'))
    args = parser.parse_args()
    check(args.app.resolve(), args.report.resolve())
