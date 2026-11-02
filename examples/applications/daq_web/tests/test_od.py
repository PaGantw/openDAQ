"""Exercise OD reads against a local HTTP device stub using the supplied API schema."""
import importlib.util
import json
from pathlib import Path
import threading
import unittest
from types import SimpleNamespace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

spec = importlib.util.spec_from_file_location('station', Path(__file__).resolve().parents[1] / 'server.py')
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)

class Device(BaseHTTPRequestHandler):
    seen = []
    source = 6
    ignore_write = False
    writes = []
    def do_PUT(self):
        if self.path != '/od/4612/0':
            self.send_error(404); return
        value = json.loads(self.rfile.read(int(self.headers['Content-Length'])))['value']
        Device.writes.append(value)
        if not Device.ignore_write:
            Device.source = value
        self.send_response(200); self.end_headers()
    def do_GET(self):
        self.seen.append(self.path)
        if self.path == '/od/16896/2':
            self.send_error(503); return
        _, _, index, sub = self.path.split('/')
        value = {'index': int(index), 'subindex': int(sub), 'type': 'U32', 'value': {'current': 123}}
        if self.path == '/od/4612/0':
            value.update(type='U8', value={'current': Device.source})
        if self.path == '/od/12304/3':
            value.update(index=0)
        raw = json.dumps([value]).encode()
        self.send_response(200); self.end_headers(); self.wfile.write(raw)
    def log_message(self, *args): pass

class ODTests(unittest.TestCase):
    def test_streaming_source_write_and_readback(self):
        http = ThreadingHTTPServer(('127.0.0.1', 0), Device)
        thread = threading.Thread(target=http.serve_forever, daemon=True); thread.start()
        try:
            url = f'http://127.0.0.1:{http.server_port}'
            Device.source = 6
            self.assertEqual(app.stream_source(url)['name'], 'Final value')
            for value, name in app.STREAM_SOURCES.items():
                self.assertEqual(app.stream_source(url, value), {'value': value, 'name': name, 'verified': True})
            count = len(Device.writes)
            for bad in (0, 7, True, '3', 3.0):
                with self.assertRaises(ValueError): app.stream_source(url, bad)
            self.assertEqual(len(Device.writes), count)
            Device.ignore_write = True
            with self.assertRaisesRegex(ValueError, 'verification failed'):
                app.stream_source(url, 3)
        finally:
            Device.ignore_write = False
            http.shutdown(); http.server_close(); thread.join()

    def test_source_change_requires_idle_disconnected_station(self):
        class Bridge:
            def call(self, op): return {'nodes': [{'kind': 'device'}]}
        station = SimpleNamespace(lock=threading.RLock(), running=True, record=None, bridge=Bridge())
        with self.assertRaisesRegex(ValueError, 'Stop acquisition'):
            app.Station.command(station, 'stream_source_set', {'url': 'http://localhost', 'value': 3})
        station.running = False
        with self.assertRaisesRegex(ValueError, 'Disconnect'):
            app.Station.command(station, 'stream_source_set', {'url': 'http://localhost', 'value': 3})

    def test_catalog_and_csv(self):
        rows = app.od_catalog()
        self.assertEqual(len(rows), 537)
        self.assertTrue(any(x['index'] == 0x3030 and x['subindex'] == 7 for x in rows))
        text = 'Index,Subindex,Type,Array Length,Access,Comment,\n0x4200,1,U32,1,RO,Status,\n0x3010,2,NULL,1,WO,Reset,\n'
        imported = app.od_catalog(text)
        self.assertEqual([x['id'] for x in imported], ['16896:1'])
    def test_read_and_isolated_errors(self):
        http = ThreadingHTTPServer(('127.0.0.1', 0), Device)
        thread = threading.Thread(target=http.serve_forever, daemon=True); thread.start()
        try:
            url = f'http://127.0.0.1:{http.server_port}'
            rows = app.od_read(url, ['16896:1', '16896:2', '12304:3'])
            self.assertEqual(rows[0]['value'], 123)
            self.assertEqual(rows[0]['status'], 'ok')
            self.assertTrue(rows[0]['observedAt'])
            self.assertEqual([x['status'] for x in rows[1:]], ['error', 'error'])
            self.assertTrue(all(x['value'] is None for x in rows[1:]))
            count = len(Device.seen)
            with self.assertRaises(ValueError): app.od_read(url, ['12304:2'])
            self.assertEqual(len(Device.seen), count, 'Never send a write-only request')
            with self.assertRaises(ValueError): app.od_read(url + '/reboot', ['16896:1'])
        finally:
            http.shutdown(); http.server_close(); thread.join()

if __name__ == '__main__': unittest.main()
