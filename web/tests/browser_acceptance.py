"""Browser acceptance for the fixed 320 kbps MP3 workflow."""
from pathlib import Path
import json, subprocess, sys, os
from playwright.sync_api import sync_playwright, expect
from mp3_validation import assert_mp3_320k

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get('WEB_TEST_OUTPUT', str(ROOT / 'web/test-results')))
OUT.mkdir(parents=True, exist_ok=True)
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:4173'
FIXTURES = ROOT / 'web/tests/fixtures'
results = []


def download_mp3(page, destination, duration_range=(.9, 1.2)):
    page.locator('.download, .fileError').first.wait_for(timeout=60000)
    assert page.locator('.fileError').count() == 0, page.locator('.fileError').all_text_contents()
    expect(page.locator('#start')).to_be_hidden()
    with page.expect_download() as event:
        page.locator('.download').click()
    assert event.value.suggested_filename.endswith('.mp3')
    event.value.save_as(str(destination))
    probe = json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(destination),
    ]))
    stream = probe['streams'][0]
    assert stream['codec_name'] == 'mp3', stream
    probe['audio_frames_320k'] = assert_mp3_320k(destination)
    assert duration_range[0] < float(probe['format']['duration']) < duration_range[1]
    decoded = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(destination), '-f', 'null', '-'], capture_output=True)
    assert decoded.returncode == 0 and not decoded.stderr, decoded.stderr.decode()
    return probe


with sync_playwright() as pw:
    for name in ['chromium', 'webkit']:
        options = {'channel': os.environ['CHROMIUM_CHANNEL']} if name == 'chromium' and os.environ.get('CHROMIUM_CHANNEL') else {}
        browser = getattr(pw, name).launch(**options)
        context = browser.new_context(viewport={'width': 1280, 'height': 900}, accept_downloads=True)
        # Preferences from an older version must not change the fixed MP3 output.
        context.add_init_script("localStorage.setItem('qqmusic-web-preferences', JSON.stringify({format:'original',bitrate:'128'}));")
        page = context.new_page()
        errors, writes = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda request: writes.append(request.url) if request.method not in ['GET', 'HEAD'] else None)
        print('BROWSER', name, flush=True)
        response = page.goto(URL)
        assert response.status == 200
        expect(page.locator('#start')).to_be_hidden()
        expect(page.locator('#format, #bitrate, #summary, #substatus')).to_have_count(0)
        expect(page.locator('a[href="mailto:jayqin04@gmail.com"]')).to_be_visible()
        page.locator('#helpOpen').click()
        expect(page.locator('#help')).to_be_visible()
        page.keyboard.press('Escape')
        expect(page.locator('#help')).to_be_hidden()
        assert page.locator('#helpOpen').evaluate('(element) => element === document.activeElement')
        for width, height in [(1440, 900), (1280, 720), (768, 1024), (390, 844)]:
            page.set_viewport_size({'width': width, 'height': height})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (name, width, 'overflow')
            if name == 'chromium':
                page.screenshot(path=str(OUT / f'网页版-{width}.png'), full_page=True)
        page.set_viewport_size({'width': 1280, 'height': 900})
        # Real BE QTag input, with a strict MP3 result in both browsers.
        page.locator('#files').set_input_files(str(FIXTURES / 'silence-qtag.mflac'))
        expect(page.locator('#start')).to_be_visible()
        page.locator('#start').click()
        page.locator('.download, .fileError').first.wait_for(timeout=60000)
        if name == 'webkit' and page.locator('.fileError').count():
            # WebKit's native FLAC decoder may be unavailable. This must be an
            # explicit error, never a non-MP3 download reported as success.
            expect(page.locator('.download')).to_have_count(0)
            expect(page.locator('#start')).to_be_hidden()
            error = page.locator('.fileError').inner_text()
            assert any(message in error for message in [
                '当前浏览器无法解码此音频', '此浏览器无法完成 MP3 转换', '无法转换此音频',
            ]), error
            qtag_result = {'status': 'unsupported_native_flac', 'error': error}
        else:
            qtag_probe = download_mp3(page, OUT / f'web-{name}-qtag.mp3')
            qtag_result = {'status': 'mp3', 'audio_bitrate': 320000, 'ffprobe_average_bitrate': int(qtag_probe['streams'][0]['bit_rate'])}
        if name == 'chromium':
            page.screenshot(path=str(OUT / '网页版-转换完成.png'), full_page=True)
        page.locator('#clear').click()
        # Ordinary input deduplicates and uses the same fixed MP3 output.
        page.locator('#files').set_input_files(str(FIXTURES / 'silence.wav'))
        page.locator('#files').set_input_files(str(FIXTURES / 'silence.wav'))
        expect(page.locator('#count')).to_have_text('1')
        page.locator('#start').click()
        probe = download_mp3(page, OUT / f'web-{name}-ordinary.mp3')
        page.locator('#clear').click()
        # Unsupported files produce only errors; the next ordinary input still succeeds.
        musicex = b'x' * 128 + (32).to_bytes(4, 'little') + b'\x00' * 4 + b'musicex\x00'
        page.locator('#files').set_input_files([
            {'name': '新版 示例.mflac', 'mimeType': 'application/octet-stream', 'buffer': musicex},
            {'name': '空文件.mgg', 'mimeType': 'application/octet-stream', 'buffer': b''},
        ])
        page.locator('#start').click()
        expect(page.locator('.fileError')).to_have_count(2)
        expect(page.locator('.fileError').first).to_contain_text('此文件暂不支持免密钥转换')
        expect(page.locator('.fileError a')).to_have_count(0)
        expect(page.locator('.download')).to_have_count(0)
        expect(page.locator('#start')).to_be_hidden()
        expect(page.locator('#retry')).to_be_visible()
        page.locator('#clear').click()
        page.locator('#files').set_input_files(str(FIXTURES / 'silence.wav'))
        page.locator('#start').click()
        download_mp3(page, OUT / f'web-{name}-after-error.mp3')
        assert not errors, (name, errors)
        assert not writes, (name, writes)
        results.append({
            'browser': name, 'output': 'mp3', 'bitrate': 320000,
            'duration': probe['format']['duration'], 'ffprobe_average_bitrate': int(probe['streams'][0]['bit_rate']),
            'audio_frames_320k': probe['audio_frames_320k'], 'qtag': qtag_result, 'viewports': 4,
            'legacy_preferences_ignored': True, 'completed_start_hidden': True,
            'errors': errors, 'uploads': writes,
        })
        context.close()
        browser.close()

print(json.dumps(results, ensure_ascii=False, indent=2))
(OUT / 'web-acceptance.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
