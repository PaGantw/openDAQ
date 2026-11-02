"""Optional Playwright OD trend test against a local HTTP stub and real SDK bridge."""
import argparse,importlib.util,threading,tempfile,pathlib
from playwright.sync_api import sync_playwright
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--bridge',required=True)
parser.add_argument('--modules',required=True)
parser.add_argument('--browser')
parser.add_argument('--output',type=pathlib.Path,default=pathlib.Path('build/od-trends-test'))
args=parser.parse_args()
args.output.mkdir(parents=True,exist_ok=True)
root=pathlib.Path(__file__).resolve().parents[1]
def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
app=load('app',root/'server.py');test=load('testod',root/'tests/test_od.py')
fake=app.ThreadingHTTPServer(('127.0.0.1',0),test.Device)
threading.Thread(target=fake.serve_forever,daemon=True).start()
with tempfile.TemporaryDirectory() as tmp:
 station=app.Station(app.Bridge(args.bridge,args.modules),tmp)
 http=app.ThreadingHTTPServer(('127.0.0.1',0),app.Handler);http.station=station;http.token='od-browser-test'
 threading.Thread(target=http.serve_forever,daemon=True).start()
 try:
  with sync_playwright() as pw:
   options={'args':['--no-sandbox']}
   if args.browser: options['executable_path']=args.browser
   browser=pw.chromium.launch(**options)
   page=browser.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(f'http://127.0.0.1:{http.server_port}');page.wait_for_function('() => token && !busy')
   page.wait_for_function("() => document.querySelector('#od-table tbody')?.rows.length === 537")
   page.locator('#od-url').fill(f'http://127.0.0.1:{fake.server_port}')
   page.locator('#od-table tbody tr input').first.check()
   page.get_by_role('textbox',name='16896:1 顯示名稱',exact=True).fill('參數 A')
   page.get_by_role('textbox',name='16896:1 顯示名稱',exact=True).press('Tab')
   page.get_by_role('textbox',name='16896:1 顯示單位',exact=True).fill('kN')
   page.get_by_role('textbox',name='16896:1 顯示單位',exact=True).press('Tab')
   page.locator('#od-interval').fill('0.5');page.locator('#od-interval').press('Tab')
   page.locator('#od-trend-start').click()
   page.wait_for_function("() => Number(document.querySelector('.od-wave-canvas')?.dataset.count) >= 3")
   assert '參數 A / kN' in page.locator('#od-plots').inner_text()
   page.locator('[data-tab="devices"]').click()
   page.locator('#od-trend-stop').click()
   count=len(test.Device.seen)
   page.wait_for_timeout(1500)
   assert len(test.Device.seen)==count, 'Stop must stop polling'
   with page.expect_download() as preset: page.locator('#od-preset-save').click()
   preset.value.save_as(str(args.output / 'preset.json'))
   page.locator('[data-tab="acquisition"]').click()
   with page.expect_download() as history: page.locator('#od-history-export').click()
   history.value.save_as(str(args.output / 'trends.csv'))
   content=pathlib.Path(str(args.output / 'trends.csv')).read_text(encoding='utf-8-sig')
   assert '參數 A' in content and len(content.splitlines()) >= 4
   page.reload()
   page.get_by_role('textbox',name='16896:1 顯示名稱',exact=True).wait_for()
   assert page.get_by_role('textbox',name='16896:1 顯示名稱',exact=True).input_value()=='參數 A'
   assert page.get_by_role('textbox',name='16896:1 顯示單位',exact=True).input_value()=='kN'
   assert page.locator('#od-interval').input_value()=='0.5'
   assert not page.locator('#od-auto').is_checked()
   page.locator('#od-read').click()
   page.wait_for_function("() => document.querySelector('#od-status').textContent.includes('1 / 1')")
   page.locator('#od-table tbody tr input').nth(1).check()
   page.locator('#od-read').click()
   page.wait_for_function("() => document.querySelector('#od-status').textContent.includes('1 / 2')")
   page.locator('[data-tab="acquisition"]').click()
   assert '讀取失敗' in page.locator('#od-plots').inner_text()
   page.screenshot(path=str(args.output / 'trends.png'),full_page=True)
   assert not errors,errors
   browser.close();print('OD trends passed: continuous chart, stop, aliases/units, presets, history CSV, reload restore, read errors')
 finally:
  http.shutdown();http.server_close();station.close()
fake.shutdown();fake.server_close()
