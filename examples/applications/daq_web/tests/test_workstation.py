#!/usr/bin/env python3
"""Functional HTTP/SDK tests using the actual reference device, never physical hardware."""
import argparse
import csv
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

parser = argparse.ArgumentParser(add_help=False)
parser.add_argument('--bridge', type=pathlib.Path, required=True)
parser.add_argument('--modules', type=pathlib.Path, required=True)
args, remaining = parser.parse_known_args()
APP = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('daq_workstation', APP / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class WorkstationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.station = server.Station(server.Bridge(args.bridge.resolve(), args.modules.resolve()), cls.temp.name)
        cls.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.http.station, cls.http.token = cls.station, 'integration-token'
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = 'http://127.0.0.1:' + str(cls.http.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.station.close()
        cls.temp.cleanup()

    def request(self, path, payload=None, token='integration-token', origin=None):
        headers = {'X-DAQ-Token': token}
        if origin:
            headers['Origin'] = origin
        body = None if payload is None else json.dumps(payload).encode()
        req = urllib.request.Request(self.url + path, body, headers)
        try:
            with urllib.request.urlopen(req, timeout=50) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def call(self, op, **kwargs):
        code, raw = self.request('/api/command', {'op': op, 'args': kwargs})
        data = json.loads(raw)
        self.assertEqual(code, 200, data)
        return data['result']

    def wait_samples(self, minimum=10):
        end = time.monotonic() + 8
        while time.monotonic() < end:
            live = json.loads(self.request('/api/live')[1])
            if live['series'] and all(s['count'] >= minimum for s in live['series']):
                return live
            if not live['running']:
                self.fail(str(live['events']))
            time.sleep(0.1)
        self.fail('SDK produced no samples')

    def test_01_device_acquisition_recording_processing_configuration(self):
        scanned = self.call('scan')['devices']
        self.assertTrue(any(d['connection'].startswith('daqref://') for d in scanned))
        device = self.call('connect', connection='daqref://device0', username='integration', password='')['id']
        state = self.call('state')
        self.assertTrue(any(n['id'] == device for n in state['nodes']))
        signal = next(s for s in state['signals'] if s.get('sampleType') in (1, 2))
        channels = [n for n in state['nodes'] if n['kind'] == 'channel']
        self.assertTrue(channels)
        props = self.call('properties', id=channels[0]['id'])['properties']
        writable = next(p for p in props if not p['readOnly'] and p['name'] == 'Frequency')
        self.call('set', id=channels[0]['id'], name=writable['name'], value=7.0)
        checked = self.call('properties', id=channels[0]['id'])['properties']
        self.assertEqual(next(p['value'] for p in checked if p['name'] == 'Frequency'), 7)
        code, _ = self.request('/api/command', {'op': 'set', 'args': {
            'id': channels[0]['id'], 'name': 'Frequency'}})
        self.assertEqual(code, 400, 'Missing values must not crash the bridge')
        block = self.call('block_add', type='RefFBModuleScaling')['id']
        state = self.call('state')
        ports = next(b['ports'] for b in state['blocks'] if b['id'] == block)
        self.call('port_connect', port=ports[0]['id'], signal=signal['id'])
        self.call('set', id=block, name='scale', value=3.0)
        state = self.call('state')
        output = next(s for s in state['signals'] if s['id'].startswith(block + '/'))
        config = self.call('config_save')['configuration']
        self.assertIsInstance(json.loads(config), dict)
        self.call('start', signals=[signal['id'], output['id']])
        live = self.wait_samples()
        self.assertGreater(live['series'][0]['max'] - live['series'][0]['min'], 0)
        self.assertTrue(live['series'][0]['firstTick'].lstrip('-').isdigit())
        code, _ = self.request('/api/command', {'op': 'disconnect', 'args': {'id': device}})
        self.assertEqual(code, 400, 'Topology changes must fail while acquiring')
        record = self.call('record_start')['recording']
        end = time.monotonic() + 5
        while time.monotonic() < end:
            live = json.loads(self.request('/api/live')[1])
            if live['recording']['rows'] > 10:
                break
            time.sleep(0.1)
        self.assertGreater(live['recording']['rows'], 10)
        self.call('record_stop')
        code, content = self.request('/api/recordings/' + record['id'])
        self.assertEqual(code, 200)
        rows = list(csv.DictReader(io.StringIO(content.decode())))
        self.assertGreater(len(rows), 10)
        self.assertEqual({r['signal_id'] for r in rows}, {signal['id'], output['id']})
        raw = {r['domain_tick']: float(r['value']) for r in rows if r['signal_id'] == signal['id']}
        scaled = {r['domain_tick']: float(r['value']) for r in rows if r['signal_id'] == output['id']}
        common = raw.keys() & scaled.keys()
        self.assertGreater(len(common), 10)
        for tick in common:
            self.assertAlmostEqual(scaled[tick], raw[tick] * 3.0, places=7)
        self.assertTrue(rows[0]['domain_tick'].lstrip('-').isdigit())
        self.assertNotEqual(float(rows[0]['tick_denominator']), 0)
        self.call('stop')
        self.call('port_disconnect', port=ports[0]['id'])
        self.call('block_remove', id=block)
        self.call('config_load', configuration=config)
        restored = self.call('state')
        self.assertTrue(restored['blocks'])
        # SDK configuration restore preserves the existing device identity.
        restored_device = next(n['id'] for n in restored['nodes'] if n['kind'] == 'device')
        self.call('disconnect', id=restored_device)
        self.assertFalse([n for n in self.call('state')['nodes'] if n['kind'] == 'device'])

    def test_02_invalid_commands_do_not_crash_bridge(self):
        for op, kwargs in [('start', {'signals': []}), ('record_start', {}),
                           ('set', {'id': '/missing', 'name': 'Frequency'}),
                           ('connect', {'connection': 'unknown://device'}),
                           ('properties', {'id': '/does-not-exist'}), ('not-a-command', {})]:
            with self.subTest(op=op):
                code, _ = self.request('/api/command', {'op': op, 'args': kwargs})
                self.assertEqual(code, 400)
        self.assertIn('root', self.call('state'))

    def test_03_http_boundaries(self):
        self.assertEqual(self.request('/api/command', {'op': 'scan'}, token='wrong')[0], 403)
        self.assertEqual(self.request('/api/command', {'op': 'scan'}, origin='http://untrusted.invalid')[0], 403)
        self.assertEqual(self.request('/api/recordings/../../server.py')[0], 404)
        self.assertEqual(self.request('/missing')[0], 404)
        self.assertEqual(self.request('/api/command', [1, 2, 3])[0], 400)

    def test_04_frontend_assets_and_session(self):
        for path in ['/', '/style.css', '/app.js', '/analysis.js', '/api/session', '/api/live']:
            with self.subTest(path=path):
                code, body = self.request(path)
                self.assertEqual(code, 200)
                self.assertTrue(body)
        self.assertEqual(json.loads(self.request('/api/session')[1])['token'], 'integration-token')


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], *remaining], verbosity=2)
