"""Regression for TIME, vector FFT, visible cursors, fixed time windows and live chains."""
import argparse
import json
import pathlib
from playwright.sync_api import sync_playwright
p=argparse.ArgumentParser();p.add_argument('--url',default='http://127.0.0.1:18182');p.add_argument('--output',type=pathlib.Path,default=pathlib.Path('build/signal-type-browser'))
a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1500,'height':1100},accept_downloads=True)
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    def wait(s):page.wait_for_function('() => ('+s+')')
    page.goto(a.url);wait('state.root && !busy')
    page.locator('#protocol').select_option('custom');page.locator('#address').fill('daqref://device0');page.locator('#connect-form button').click();wait('!busy && state.signals.some(s=>s.kind==="time")')
    source=page.evaluate('state.signals.find(s=>s.kind==="scalar").id')
    time_id=page.evaluate('(id)=>state.signals.find(s=>s.domainSource===id).id',source)
    page.locator('[data-tab=processing]').click();page.locator('#block-type').select_option('RefFBModuleFFT');page.locator('#block-form button').click();wait('!busy && state.blocks.length===1')
    page.locator('#blocks .port-row select').first.select_option(source);page.locator('#blocks .port-row').first.get_by_role('button',name='接線',exact=True).click()
    wait('!busy && state.signals.some(s=>s.kind==="vector")')
    vector=page.evaluate('state.signals.find(s=>s.kind==="vector").id')
    page.locator('[data-tab=acquisition]').click()
    for sid in [source,time_id,vector]:
        labels=page.locator('#signals label')
        for i in range(labels.count()):
            if labels.nth(i).locator('small').last.inner_text()==sid:
                labels.nth(i).locator('input').check();break
        else:raise AssertionError('Signal not shown: '+sid)
    page.locator('#start').click();wait('live.running && live.series.length===3 && live.series.every(s=>s.count>0 && !s.error)')
    assert page.locator('.wave-canvas').count()==3
    assert page.locator('#show-cursors').is_checked()
    assert all('A:' in text and 'B:' in text for text in page.locator('.cursor-readout').all_inner_texts())
    page.locator('#time-window').select_option('10')
    width=page.evaluate('plotRange(displaySeries().find(s=>s.kind==="scalar"))[1]-plotRange(displaySeries().find(s=>s.kind==="scalar"))[0]')
    assert abs(width-10)<1e-6,width
    page.locator('#record-start').click();wait('live.recording && live.recording.rows>100')
    page.screenshot(path=str(a.output/'time-and-vector.png'),full_page=True)
    page.locator('[data-tab=processing]').click();wait('document.getElementById("live-chain").textContent.includes("frames")')
    before=page.locator('#live-chain').inner_text();wait('document.getElementById("live-chain").textContent !== '+json.dumps(before))
    assert page.locator('#live-chain canvas').count()>=1
    page.screenshot(path=str(a.output/'live-chain.png'),full_page=True)
    page.locator('[data-tab=acquisition]').click();page.locator('#record-stop').click();wait('!busy && !live.recording');page.locator('#stop').click();wait('!busy && !live.running')
    page.locator('[data-tab=devices]').click()
    with page.expect_download() as d:page.locator('#export-signals').click()
    d.value.save_as(a.output/'signals.json');metadata=json.loads((a.output/'signals.json').read_text())
    assert metadata['bridgeVersion']==2 and any(s['kind']=='vector' for s in metadata['signals'])
    wait('!busy');page.locator('#connected').get_by_role('button',name='中斷連線').click();wait('!busy')
    page.locator('[data-tab=processing]').click();page.locator('#blocks').get_by_role('button',name='移除',exact=True).click();wait('!busy && state.blocks.length===0')
    assert not errors,errors
    print('TIME, SDK FFT vectors, visible A/B cursors, exact ten-second window, live chain and descriptor export passed.')
    browser.close()
