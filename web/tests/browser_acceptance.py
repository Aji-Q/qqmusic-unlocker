from pathlib import Path
import json, subprocess, sys, os
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[2]
OUT=Path(os.environ.get('WEB_TEST_OUTPUT', str(ROOT/'web/test-results'))); OUT.mkdir(parents=True,exist_ok=True)
WORK=OUT
URL=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:4173'
F=ROOT/'web/tests/fixtures'; result=[]
with sync_playwright() as pw:
 for name in ['chromium','webkit']:
  browser=getattr(pw,name).launch(**({'channel':os.environ['CHROMIUM_CHANNEL']} if name=='chromium' and os.environ.get('CHROMIUM_CHANNEL') else {}))
  context=browser.new_context(viewport={'width':1280,'height':900},accept_downloads=True)
  page=context.new_page(); errors=[]; writes=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('request',lambda r:writes.append(r.url) if r.method not in ['GET','HEAD'] else None)
  print('BROWSER',name,flush=True)
  response=page.goto(URL);assert response.status==200
  expect(page.locator('#start')).to_be_disabled()
  page.locator('#helpOpen').click(); expect(page.locator('#help')).to_be_visible();page.keyboard.press('Escape');expect(page.locator('#help')).to_be_hidden()
  assert page.locator('#helpOpen').evaluate('(e)=>e===document.activeElement')
  for w,h in [(1440,900),(1280,720),(768,1024),(390,844)]:
   page.set_viewport_size({'width':w,'height':h})
   assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),(name,w,'overflow')
   if name=='chromium': page.screenshot(path=str(OUT/f'网页版-{w}.png'),full_page=True)
  page.set_viewport_size({'width':1280,'height':900})
  # Real BE QTag input; Chromium MP3 or WebKit original-format recovery.
  page.locator('#files').set_input_files(str(F/'silence-qtag.mflac'))
  page.locator('#start').click();page.locator('.download').wait_for(timeout=60000)
  with page.expect_download() as dl:page.locator('.download').click()
  path=WORK/f'web-{name}-acceptance.mp3';dl.value.save_as(str(path))
  probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(path)]))
  assert probe['streams'][0]['codec_name'] in (['mp3'] if name=='chromium' else ['mp3','flac'])
  assert .9<float(probe['format']['duration'])<1.2
  if name=='chromium':page.screenshot(path=str(OUT/'网页版-转换完成.png'),full_page=True)
  page.locator('#clear').click()
  # Same files deduplicate, original output is byte-identical.
  page.locator('#format').select_option('original')
  page.locator('#files').set_input_files(str(F/'silence-qtag.mflac'));page.locator('#files').set_input_files(str(F/'silence-qtag.mflac'));expect(page.locator('#count')).to_have_text('1')
  page.locator('#start').click();page.locator('.download').wait_for()
  with page.expect_download() as dl:page.locator('.download').click()
  path=WORK/f'web-{name}-original.flac';dl.value.save_as(str(path));assert path.read_bytes()==(F/'silence.flac').read_bytes()
  page.locator('#clear').click()
  # Unsupported short MusicEx inputs cannot wedge the queue or request credentials.
  musicex=b'x'*128+(32).to_bytes(4,'little')+b'\x00'*4+b'musicex\x00'
  page.locator('#files').set_input_files([{'name':'新版 示例.mflac','mimeType':'application/octet-stream','buffer':musicex},{'name':'空文件.mgg','mimeType':'application/octet-stream','buffer':b''}])
  page.locator('#start').click();expect(page.locator('#summary')).to_have_text('失败 2')
  expect(page.locator('.fileError').first).to_contain_text('不满足当前恢复条件');expect(page.locator('.fileError a')).to_have_count(0)
  expect(page.locator('#retry')).to_be_visible();page.locator('#clear').click()
  page.locator('#files').set_input_files(str(F/'silence.wav'));page.locator('#format').select_option('mp3');page.locator('#start').click();page.locator('.download').wait_for(timeout=60000)
  assert not errors,(name,errors)
  assert not writes,(name,writes)
  result.append({'browser':name,'output':probe['streams'][0]['codec_name'],'duration':probe['format']['duration'],'viewports':4,'errors':errors,'uploads':writes})
  context.close();browser.close()
print(json.dumps(result,ensure_ascii=False,indent=2))
(WORK/'web-acceptance.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
