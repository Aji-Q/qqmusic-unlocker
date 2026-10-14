"""Fresh-profile file-only recovery and download acceptance.

Usage: python tests/file_only_browser.py URL INPUT.mgg OUTPUT_DIRECTORY [OGG_SHA256]
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
        for output_format in ['original', 'mp3']:
            if output_format == 'mp3' and browser_name == 'webkit':
                continue  # Native WebKit codecs vary; original recovery is the key acceptance.
            page.locator('#format').select_option(output_format)
            print(f'{browser_name}: {output_format}', flush=True)
            page.locator('#files').set_input_files(str(source))
            if output_format == 'original':
                page.locator('#start').click()
                expect(page.locator('.fileStatus')).to_contain_text('%', timeout=30000)
                page.locator('#cancel').click()
                expect(page.locator('.fileStatus')).to_have_text('已停止 · 可继续')
                expect(page.locator('#start')).to_be_enabled()
                assert page.evaluate('window.__activeWorkers.size') == 0
                expect(page.locator('.download')).to_have_count(0)
            started = time.monotonic()
            page.locator('#start').click()
            page.locator('.download, .fileError').first.wait_for(state='visible', timeout=240000)
            if page.locator('.fileError').count():
                page.screenshot(path=str(destination / f'{browser_name}-error.png'), full_page=True)
                raise AssertionError([page.locator('.fileError').all_text_contents(), page.evaluate('window.__workerErrors')])
            page.locator('.download').wait_for(timeout=10000)
            expect(page.locator('.fileError')).to_have_count(0)
            with page.expect_download() as event:
                page.locator('.download').click()
            download = event.value
            output = destination / f'{browser_name}-{output_format}{Path(download.suggested_filename).suffix}'
            download.save_as(str(output))
            digest = hashlib.sha256(output.read_bytes()).hexdigest()
            if output_format == 'original' and expected_sha:
                assert digest == expected_sha, (browser_name, digest)
            probe = json.loads(subprocess.check_output([
                'ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(output),
            ]))
            decode = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(output), '-f', 'null', '-'], capture_output=True)
            assert decode.returncode == 0 and not decode.stderr, decode.stderr.decode()
            expected_codec = 'vorbis' if output_format == 'original' else 'mp3'
            assert probe['streams'][0]['codec_name'] == expected_codec
            page.screenshot(path=str(destination / f'{browser_name}-{output_format}.png'), full_page=True)
            results.append({
                'browser': browser_name, 'format': output_format,
                'codec': expected_codec, 'sha256': digest,
                'duration': float(probe['format']['duration']),
                'seconds': round(time.monotonic() - started, 2),
                'no_page_errors': not page_errors, 'no_uploads_or_external_requests': not blocked,
                'fresh_profile': True, 'inputs': 'music file only',
                'cancel_and_restart': output_format == 'original',
            })
            assert not blocked and not page_errors, (blocked, page_errors)
            page.locator('#clear').click()
        context.close()
        browser.close()

(destination / 'browser-recovery.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
print(json.dumps(results, ensure_ascii=False, indent=2))
