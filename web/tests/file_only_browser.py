"""Fresh-profile file-only recovery and download acceptance.

Usage: python tests/file_only_browser.py URL INPUT.mgg OUTPUT_DIRECTORY [MP3_SHA256]
The selected music file is the only input sent to the web app. No key is loaded.
"""
from pathlib import Path
from urllib.parse import urlparse
import hashlib
import json
import os
import subprocess
import sys
import time
from playwright.sync_api import sync_playwright, expect
from mp3_validation import assert_mp3_320k

url, source, destination = sys.argv[1:4]
expected_sha = sys.argv[4] if len(sys.argv) > 4 else None
source = Path(source).resolve()
destination = Path(destination).resolve()
destination.mkdir(parents=True, exist_ok=True)
origin = urlparse(url).netloc
results = []

with sync_playwright() as pw:
    for browser_name in os.environ.get('RECOVERY_BROWSERS', 'chromium,webkit').split(','):
        options = {'channel': os.environ.get('CHROMIUM_CHANNEL', 'chrome')} if browser_name == 'chromium' else {}
        browser = getattr(pw, browser_name).launch(**options)
        context = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
        context.add_init_script('''
          window.__workerErrors = [];
          window.__activeWorkers = new Set();
          const NativeWorker = window.Worker;
          window.Worker = class extends NativeWorker {
            constructor(...args) {
              super(...args);
              window.__activeWorkers.add(this);
              this.addEventListener('message', e => {
                if (e.data?.error) window.__workerErrors.push(e.data.error);
              });
              this.addEventListener('error', e => window.__workerErrors.push({message:e.message}));
            }
            terminate() {
              window.__activeWorkers.delete(this);
              return super.terminate();
            }
          };
        ''')
        blocked = []
        page_errors = []

        def route(request_route):
            request = request_route.request
            if request.method not in ['GET', 'HEAD'] or urlparse(request.url).netloc != origin:
                blocked.append({'method': request.method, 'url': request.url})
                request_route.abort()
            else:
                request_route.continue_()

        context.route('**/*', route)
        page = context.new_page()
        page.on('pageerror', lambda error: page_errors.append(str(error)))
        response = page.goto(url)
        assert response.status == 200
        assert context.cookies() == []
        expect(page.locator('#format, #bitrate, #summary, #substatus')).to_have_count(0)
        expect(page.locator('#start')).to_be_hidden()
        print(f'{browser_name}: mp3 320 kbps', flush=True)
        page.locator('#files').set_input_files(str(source))
        page.locator('#start').click()
        expect(page.locator('.fileStatus')).to_contain_text('%', timeout=30000)
        expect(page.locator('#start')).to_be_hidden()
        page.locator('#cancel').click()
        expect(page.locator('.fileStatus')).to_have_text('已停止 · 可继续')
        expect(page.locator('#start')).to_be_visible()
        expect(page.locator('#start')).to_be_enabled()
        assert page.evaluate('window.__activeWorkers.size') == 0
        expect(page.locator('.download')).to_have_count(0)
        started = time.monotonic()
        page.locator('#start').click()
        page.locator('.download, .fileError').first.wait_for(state='visible', timeout=240000)
        if page.locator('.fileError').count():
            page.screenshot(path=str(destination / f'{browser_name}-error.png'), full_page=True)
            error = page.locator('.fileError').all_text_contents()
            results.append({
                'browser': browser_name, 'format': 'mp3', 'status': 'failed',
                'error': error, 'no_download': page.locator('.download').count() == 0,
                'no_page_errors': not page_errors, 'no_uploads_or_external_requests': not blocked,
            })
            (destination / 'browser-recovery.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
            raise AssertionError([error, page.evaluate('window.__workerErrors')])
        page.locator('.download').wait_for(timeout=10000)
        expect(page.locator('.fileError')).to_have_count(0)
        expect(page.locator('#start')).to_be_hidden()
        expect(page.locator('#cancel')).to_be_hidden()
        with page.expect_download() as event:
            page.locator('.download').click()
        download = event.value
        assert Path(download.suggested_filename).suffix == '.mp3'
        output = destination / f'{browser_name}-mp3.mp3'
        download.save_as(str(output))
        digest = hashlib.sha256(output.read_bytes()).hexdigest()
        if expected_sha:
            assert digest == expected_sha, (browser_name, digest)
        probe = json.loads(subprocess.check_output([
            'ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(output),
        ]))
        decode = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(output), '-f', 'null', '-'], capture_output=True)
        assert decode.returncode == 0 and not decode.stderr, decode.stderr.decode()
        assert probe['streams'][0]['codec_name'] == 'mp3'
        audio_frames = assert_mp3_320k(output)
        page.screenshot(path=str(destination / f'{browser_name}-mp3.png'), full_page=True)
        results.append({
            'browser': browser_name, 'format': 'mp3', 'status': 'passed',
            'codec': 'mp3', 'bitrate': 320000, 'sha256': digest,
            'audio_frames_320k': audio_frames, 'ffprobe_average_bitrate': int(probe['streams'][0]['bit_rate']),
            'duration': float(probe['format']['duration']),
            'seconds': round(time.monotonic() - started, 2),
            'no_page_errors': not page_errors, 'no_uploads_or_external_requests': not blocked,
            'fresh_profile': True, 'inputs': 'music file only',
            'cancel_and_restart': True, 'completed_start_hidden': True,
        })
        assert not blocked and not page_errors, (blocked, page_errors)
        (destination / 'browser-recovery.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
        page.locator('#clear').click()
        context.close()
        browser.close()

(destination / 'browser-recovery.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
print(json.dumps(results, ensure_ascii=False, indent=2))
