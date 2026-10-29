#!/usr/bin/env python3
"""Browser coverage for the measurement controls using real SDK reference samples."""
import argparse
import pathlib
from playwright.sync_api import sync_playwright

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--url', default='http://127.0.0.1:18181')
p.add_argument('--output', type=pathlib.Path, default=pathlib.Path('build/daq-web-measurement-test'))
p.add_argument('--browser')
a=p.parse_args();a.output.mkdir(parents=True, exist_ok=True)
with sync_playwright() as pw:
    kwargs={'headless':True,'args':['--no-sandbox']}
    if a.browser: kwargs['executable_path']=a.browser
    browser=pw.chromium.launch(**kwargs)
    page=browser.new_page(viewport={'width':1600,'height':1100})
    errors=[];page.on('pageerror', lambda error:errors.append(str(error)))
    def wait(expression): page.wait_for_function('() => ('+expression+')')
    page.goto(a.url);wait('state.root && !busy')
    page.locator('#protocol').select_option('custom')
    page.locator('#address').fill('daqref://device0')
    page.locator('#connect-form button[type=submit]').click()
    wait('!busy && state.signals.length >= 2')
    page.locator('[data-tab=acquisition]').click()
    signal=page.evaluate('state.signals.find(s=>s.sampleType===2).id')
    name=page.evaluate('state.signals.find(s=>s.sampleType===2).name')
    page.locator('#signal-search').fill(name)
    page.locator('#signals button').first.click()
    wait("!busy && document.getElementById('channel-settings').open")
    frequency=page.locator('#channel-properties').get_by_role('spinbutton',name='Frequency',exact=True)
    frequency.fill('31.25')
    frequency.locator('xpath=ancestor::tr').get_by_role('button',name='套用').click()
    wait("!busy && document.getElementById('notice').textContent.includes('Frequency 已更新')")
    page.locator('#channel-settings summary').click()
    page.locator('#signal-search').fill('')
    page.locator('#select-visible').click()
    assert page.locator('#signals input[type=checkbox]:checked').count()==2
    page.locator('#start').click()
    wait('live.running && live.series.length===2 && live.series.every(s=>s.count>=1500)')
    assert page.locator('.wave-canvas').count()==2
    page.locator('#spectrum-signal').select_option(signal)
    wait('document.getElementById("spectrum-status").dataset.peak')
    peak=page.locator('#spectrum-status').get_attribute('data-peak')
    fs=float(page.locator('#spectrum-status').get_attribute('data-sample-rate'))
    assert abs(float(peak)-31.25)<=fs/1024+1e-6, (peak,fs)
    page.locator('#record-start').click();wait('live.recording && live.recording.rows>100')
    page.locator('#plot-layout').select_option('columns')
    page.locator('#pause-plot').click()
    snapshot=page.evaluate('JSON.stringify(displaySeries())')
    rows=page.evaluate('live.recording.rows')
    wait(f'live.recording.rows>{rows+500}')
    assert page.evaluate('JSON.stringify(displaySeries())')==snapshot, 'Frozen chart changed while recording'
    assert page.locator('#plots').get_attribute('class')=='plot-columns'
    # Place two cursors at distinct positions and check actual sample readouts.
    canvas=page.locator('.wave-canvas').first
    bounds=canvas.bounding_box()
    page.locator('#plot-tool').select_option('a')
    canvas.click(position={'x':bounds['width']*.4,'y':60})
    page.locator('#plot-tool').select_option('b')
    canvas.click(position={'x':bounds['width']*.7,'y':70})
    assert 'Δt' in page.locator('.cursor-readout').first.inner_text()
    old_cursor=page.evaluate('Array.from(plotCursors.values())[0].b[0]')
    canvas.press('ArrowRight')
    assert page.evaluate('Array.from(plotCursors.values())[0].b[0]')>old_cursor
    page.locator('#plot-tool').select_option('zoom')
    canvas=page.locator('.wave-canvas').first;bounds=canvas.bounding_box()
    page.mouse.move(bounds['x']+bounds['width']*.3,bounds['y']+80)
    page.mouse.down();page.mouse.move(bounds['x']+bounds['width']*.7,bounds['y']+80,steps=8);page.mouse.up()
    assert page.evaluate('viewRanges.size')==1
    zoomed=page.evaluate('Array.from(viewRanges.values())[0][1]-Array.from(viewRanges.values())[0][0]')
    assert zoomed>0
    canvas=page.locator('.wave-canvas').first
    canvas.hover();page.mouse.wheel(0,-100)
    wait(f'Array.from(viewRanges.values())[0][1]-Array.from(viewRanges.values())[0][0] < {zoomed}')
    page.locator('#reset-view').click();assert page.evaluate('viewRanges.size===0 && plotCursors.size===0')
    page.locator('#time-window').select_option('0.1')
    assert page.evaluate('plotRange(displaySeries()[0])[1]-plotRange(displaySeries()[0])[0]')<=0.10001
    page.locator('#time-window').select_option('all')
    page.locator('#y-mode').select_option('fixed')
    page.locator('#y-min').fill('10');page.locator('#y-min').dispatch_event('change')
    assert '設定無效' in page.locator('#view-status').inner_text()
    page.locator('#y-min').fill('-6');page.locator('#y-min').dispatch_event('change')
    page.locator('#y-max').fill('6');page.locator('#y-max').dispatch_event('change')
    assert '設定無效' not in page.locator('#view-status').inner_text()
    page.locator('#fft-scale').select_option('db')
    assert 'dB re 1' in page.locator('#spectrum-status').inner_text()
    page.locator('#fft-size').select_option('8192')
    assert '需要 8192 筆' in page.locator('#spectrum-status').inner_text()
    page.locator('#fft-size').select_option('1024')
    page.locator('#fft-scale').select_option('linear')
    page.locator('#y-mode').select_option('auto')
    page.locator('#pause-plot').click();wait('!paused')
    page.locator('#record-stop').click();wait('!busy && !live.recording')
    page.locator('#stop').click();wait('!busy && !live.running')
    page.screenshot(path=str(a.output/'measurement.png'),full_page=True)
    page.set_viewport_size({'width':390,'height':844})
    page.screenshot(path=str(a.output/'mobile-measurement.png'),full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1'), 'Mobile overflow'
    page.locator('[data-tab=devices]').click()
    page.locator('#connected').get_by_role('button',name='中斷連線').click()
    wait('!busy && !state.nodes.some(n=>n.kind==="device")')
    assert not errors, errors
    print('Measurement browser flow passed: channel settings, two channels, FFT frequency, drag/wheel zoom, mouse/keyboard cursors, frozen recording, time windows, scales, mobile.')
    browser.close()
