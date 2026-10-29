#!/usr/bin/env python3
"""Optional browser smoke test. Requires Playwright and a running workstation."""
import argparse
import pathlib
from playwright.sync_api import sync_playwright

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--url', default='http://127.0.0.1:8080')
p.add_argument('--output', type=pathlib.Path, default=pathlib.Path('build/daq-web-browser-test'))
p.add_argument('--browser', help='Optional path to an installed Chromium executable')
a = p.parse_args()
a.output.mkdir(parents=True, exist_ok=True)
with sync_playwright() as pw:
    options = {'headless': True, 'args': ['--no-sandbox']}
    if a.browser:
        options['executable_path'] = a.browser
    browser = pw.chromium.launch(**options)
    page = browser.new_page(viewport={'width': 1440, 'height': 1050}, accept_downloads=True)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    def wait(expression):
        page.wait_for_function('() => (' + expression + ')')

    page.goto(a.url)
    wait("state.root && !busy")
    page.locator('#scan').click()
    wait("!busy && document.querySelector('#discovered').textContent.includes('daqref://device0')")
    page.locator('#discovered .device-row').filter(has_text='daqref://device0').get_by_role('button', name='連線', exact=True).click()
    wait("!busy && state.signals.length > 0")
    signal = page.evaluate("state.signals.find(s => s.sampleType === 2 || s.sampleType === 1).id")
    # Exercise function-block creation, port wiring and exposed settings through the UI.
    page.locator('[data-tab="processing"]').click()
    page.locator('#block-type').select_option('RefFBModuleScaling')
    page.locator('#block-form button').click()
    wait("!busy && state.blocks.length === 1")
    page.locator('#blocks .port-row select').first.select_option(signal)
    page.locator('#blocks .port-row').first.get_by_role('button', name='接線', exact=True).click()
    wait("!busy && state.blocks[0].ports[0].signal !== ''")
    page.locator('#blocks').get_by_role('button', name='編輯屬性').click()
    wait("!busy && document.querySelector('#properties').textContent.includes('scale')")
    scale = page.locator('#properties tr').filter(has=page.get_by_role('cell', name='scale', exact=True))
    scale.locator('input').fill('3')
    scale.get_by_role('button', name='套用').click()
    wait('!busy')
    assert page.locator('#notice').get_attribute('class') != 'notice error'
    page.locator('[data-tab="acquisition"]').click()
    labels = page.locator('#signals label')
    for i in range(labels.count()):
        if signal in labels.nth(i).inner_text():
            labels.nth(i).locator('input').check()
            break
    page.locator('#start').click()
    wait("live.running && live.series.some(s => s.count > 20)")
    page.locator('#record-start').click()
    wait('live.recording && live.recording.rows > 20')
    page.screenshot(path=str(a.output / 'acquisition.png'), full_page=True)
    assert page.locator('canvas').count() == 1
    page.locator('#record-stop').click()
    wait('!busy && !live.recording && live.recordings.length > 0')
    page.locator('#stop').click()
    wait('!busy && !live.running')
    page.locator('[data-tab="configuration"]').click()
    with page.expect_download() as dl:
        page.locator('#recordings a').last.click()
    csv = dl.value
    csv.save_as(a.output / 'recording.csv')
    content = (a.output / 'recording.csv').read_text()
    assert 'domain_tick' in content and len(content.splitlines()) > 20
    with page.expect_download() as dl:
        page.locator('#save-config').click()
    dl.value.save_as(a.output / 'configuration.json')
    wait('!busy')
    page.on('dialog', lambda dialog: dialog.accept())
    page.locator('#load-config').set_input_files(a.output / 'configuration.json')
    wait("!busy && document.querySelector('#notice').textContent.includes('組態已載入')")
    page.set_viewport_size({'width': 390, 'height': 844})
    page.locator('[data-tab="devices"]').click()
    page.screenshot(path=str(a.output / 'mobile.png'), full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Mobile horizontal overflow'
    page.locator('#connected').get_by_role('button', name='中斷連線').first.click()
    wait("!busy && !state.nodes.some(n => n.kind === 'device')")
    page.locator('[data-tab="processing"]').click()
    page.locator('#blocks').get_by_role('button', name='移除', exact=True).first.click()
    wait('!busy && state.blocks.length === 0')
    assert not errors, errors
    print('Browser flow passed: scan, connect, block wiring/settings, acquisition, recording/download, config restore, mobile, disconnect.')
    browser.close()
