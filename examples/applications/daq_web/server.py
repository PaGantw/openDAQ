#!/usr/bin/env python3
"""Single-user local DAQ workstation; all acquisition goes through the source-built SDK."""
import argparse
import collections
import csv
import datetime as dt
import json
import math
import pathlib
import queue
import re
import secrets
import signal
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ROOT = pathlib.Path(__file__).resolve().parent


class Bridge:
    def __init__(self, executable, modules):
        self.lock = threading.RLock()
        self.logs = collections.deque(maxlen=200)
        self.replies = queue.Queue()
        self.process = subprocess.Popen([str(executable), str(modules)], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        text=True, encoding='utf-8', bufsize=1)
        threading.Thread(target=self._stdout, daemon=True).start()
        threading.Thread(target=self._stderr, daemon=True).start()

    def _stdout(self):
        for line in self.process.stdout:
            try:
                value = json.loads(line)
                if isinstance(value, dict) and 'ok' in value:
                    self.replies.put(value)
                else:
                    self.logs.append(line.rstrip())
            except ValueError:
                self.logs.append(line.rstrip())
        self.replies.put({'ok': False, 'error': 'SDK bridge exited; restart the application.'})

    def _stderr(self):
        for line in self.process.stderr:
            self.logs.append(line.rstrip())

    def call(self, op, **kwargs):
        with self.lock:
            if self.process.poll() is not None:
                raise RuntimeError('SDK bridge is unavailable; restart the application.')
            self.process.stdin.write(json.dumps({'op': op, **kwargs}, allow_nan=False) + '\n')
            self.process.stdin.flush()
            try:
                reply = self.replies.get(timeout=45)
            except queue.Empty:
                self.process.terminate()  # Never let a delayed response match a later request.
                raise RuntimeError('Device operation timed out; restart and check device connectivity.')
            if not reply['ok']:
                raise ValueError(reply.get('error', 'SDK error'))
            return reply['result']

    def close(self):
        with self.lock:
            if self.process.poll() is None:
                self.process.stdin.close()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.terminate()
                    try:
                        self.process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        self.process.kill()
                        self.process.wait()


class Station:
    MUTATIONS = {'connect', 'disconnect', 'set', 'block_add', 'block_remove',
                 'port_connect', 'port_disconnect', 'config_load'}

    def __init__(self, bridge, recordings):
        self.bridge = bridge
        self.lock = threading.RLock()
        self.recordings = pathlib.Path(recordings).resolve()
        self.recordings.mkdir(parents=True, exist_ok=True)
        self.selected = []
        self.running = False
        self.series = {}
        self.sequence = 0
        self.events = collections.deque(maxlen=80)
        self.record = None
        self.completed = []
        self.closed = threading.Event()
        self.thread = threading.Thread(target=self._acquire, daemon=True)
        self.thread.start()

    def event(self, message):
        self.events.append({'time': dt.datetime.now(dt.timezone.utc).isoformat(), 'message': message})

    def _finish_record(self, reason='Recording stopped'):
        if self.record:
            r = self.record
            r['file'].flush()
            r['file'].close()
            self.completed.append({k: r[k] for k in ('id', 'name', 'rows', 'started')})
            self.event(reason + ': ' + r['name'])
            self.record = None

    def _acquire(self):
        while not self.closed.wait(0.1):
            with self.lock:
                if not self.running:
                    continue
                try:
                    result = self.bridge.call('samples')
                    for batch in result['batches']:
                        sid = batch['id']
                        if 'error' in batch:
                            raise RuntimeError(sid + ': ' + batch['error'])
                        s = self.series[sid]
                        s['pending'] = batch.get('pending', 0)
                        for tick, value in zip(batch['ticks'], batch['values']):
                            if s['firstTick'] is None:
                                s['firstTick'] = tick
                            numerator = int(batch.get('tickNumerator', '1'))
                            denominator = int(batch.get('tickDenominator', '1'))
                            seconds = (int(tick) - int(s['firstTick'])) * numerator / denominator
                            s['points'].append([seconds, value])
                            s['count'] += 1
                            s['origin'] = batch.get('origin', '')
                            if value is not None and math.isfinite(value):
                                s['finiteCount'] += 1
                                s['mean'] += (value - s['mean']) / s['finiteCount']
                                s['squareMean'] += (value * value - s['squareMean']) / s['finiteCount']
                                s['min'] = value if s['min'] is None else min(s['min'], value)
                                s['max'] = value if s['max'] is None else max(s['max'], value)
                            if self.record:
                                r = self.record
                                r['writer'].writerow([sid, batch.get('origin', ''), tick,
                                                      numerator, denominator, seconds, value])
                                r['rows'] += 1
                                if r['rows'] >= 2_000_000 or r['file'].tell() >= 256 * 1024 * 1024:
                                    self._finish_record('Recording size limit reached')
                    if self.record:
                        self.record['file'].flush()
                    self.sequence += 1
                except Exception as exc:
                    self.running = False
                    self._finish_record('Recording stopped after acquisition error')
                    self.event('Acquisition failed: ' + str(exc))

    def live(self):
        with self.lock:
            series = []
            for sid, s in self.series.items():
                series.append({'id': sid, **{k: v for k, v in s.items()
                              if k not in ('points', 'squareMean', 'finiteCount')},
                               'rms': math.sqrt(max(0, s['squareMean'])), 'points': list(s['points'])})
            return {'running': self.running, 'sequence': self.sequence, 'series': series,
                    'recording': ({k: self.record[k] for k in ('id', 'name', 'rows', 'started')}
                                  if self.record else None),
                    'recordings': self.completed[-100:], 'events': list(self.events),
                    'sdkLogs': list(self.bridge.logs)[-30:]}

    def command(self, op, args):
        with self.lock:
            if op == 'start':
                if self.running:
                    raise ValueError('Acquisition is already running')
                selected = args.get('signals', [])
                if not isinstance(selected, list) or not selected or len(selected) > 16:
                    raise ValueError('Select 1–16 scalar numeric signals')
                self.bridge.call('subscribe', signals=selected)
                self.selected = selected
                self.series = {sid: {'points': collections.deque(maxlen=2000), 'count': 0,
                                     'finiteCount': 0, 'mean': 0.0, 'squareMean': 0.0,
                                     'min': None, 'max': None, 'firstTick': None,
                                     'origin': '', 'pending': 0} for sid in selected}
                self.running = True
                self.event('Acquisition started')
                return self.live()
            if op == 'stop':
                # Stop at the last completed polling cycle, then release SDK readers.
                self.running = False
                self._finish_record()
                self.bridge.call('stop')
                self.event('Acquisition stopped')
                return self.live()
            if op == 'record_start':
                if not self.running or self.record:
                    raise ValueError('Start acquisition first; only one recording can run')
                rid = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + secrets.token_hex(4)
                name = rid + '.csv'
                f = (self.recordings / name).open('x', newline='', encoding='utf-8')
                writer = csv.writer(f)
                writer.writerow(['signal_id', 'domain_origin', 'domain_tick', 'tick_numerator',
                                 'tick_denominator', 'relative_seconds', 'value'])
                self.record = {'id': rid, 'name': name, 'file': f, 'writer': writer, 'rows': 0,
                               'started': dt.datetime.now(dt.timezone.utc).isoformat()}
                self.event('Recording started: ' + name)
                return self.live()
            if op == 'record_stop':
                self._finish_record()
                return self.live()
            if op in self.MUTATIONS and self.running:
                raise ValueError('Stop acquisition before changing device topology or properties')
            if op == 'scan' and self.running:
                raise ValueError('Stop acquisition before discovery')
            allowed = {'state', 'properties', 'config_save', 'scan'} | self.MUTATIONS
            if op not in allowed:
                raise ValueError('Unknown command')
            result = self.bridge.call(op, **args)
            if op in self.MUTATIONS:
                self.event(op + ' completed')
            return result

    def close(self):
        self.closed.set()
        self.thread.join(timeout=50)
        with self.lock:
            self._finish_record('Application shutting down')
            self.bridge.close()


class Handler(BaseHTTPRequestHandler):
    server_version = 'DAQWorkstation/1.0'

    def send(self, code, data, kind='application/json; charset=utf-8'):
        body = json.dumps(data, ensure_ascii=False, allow_nan=False).encode() if isinstance(data, dict) else data
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlsplit(self.path).path
        try:
            if path == '/api/session':
                self.send(200, {'token': self.server.token, 'deviceHint': '169.254.27.27'})
            elif path == '/api/live':
                self.send(200, self.server.station.live())
            elif path.startswith('/api/recordings/'):
                rid = path.rsplit('/', 1)[-1]
                if not re.fullmatch(r'\d{8}T\d{6}Z-[0-9a-f]{8}', rid):
                    raise FileNotFoundError()
                # Only finalized recordings created by this running application are downloadable.
                item = next((r for r in self.server.station.completed if r['id'] == rid), None)
                if item is None:
                    raise FileNotFoundError()
                file = self.server.station.recordings / item['name']
                self.send_response(200)
                self.send_header('Content-Type', 'text/csv; charset=utf-8')
                self.send_header('Content-Disposition', 'attachment; filename="' + item['name'] + '"')
                self.send_header('Content-Length', str(file.stat().st_size))
                self.end_headers()
                with file.open('rb') as f:
                    while data := f.read(65536):
                        self.wfile.write(data)
            else:
                files = {'/': ('index.html', 'text/html; charset=utf-8'),
                         '/app.js': ('app.js', 'text/javascript; charset=utf-8'),
                         '/style.css': ('style.css', 'text/css; charset=utf-8')}
                if path not in files:
                    raise FileNotFoundError()
                name, kind = files[path]
                self.send(200, (ROOT / 'static' / name).read_bytes(), kind)
        except FileNotFoundError:
            self.send(404, {'error': 'Not found'})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self.send(500, {'error': str(exc)})

    def do_POST(self):
        try:
            if self.path != '/api/command':
                self.send(404, {'error': 'Not found'})
                return
            if not secrets.compare_digest(self.headers.get('X-DAQ-Token', ''), self.server.token):
                self.send(403, {'error': 'Refresh this page before making changes'})
                return
            origin = self.headers.get('Origin')
            if origin and urlsplit(origin).netloc != self.headers.get('Host'):
                self.send(403, {'error': 'Cross-origin request denied'})
                return
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 2 * 1024 * 1024:
                self.send(413, {'error': 'Request must be 1 byte to 2 MiB'})
                return
            req = json.loads(self.rfile.read(length))
            if not isinstance(req, dict) or not isinstance(req.get('op'), str) or not isinstance(req.get('args', {}), dict):
                raise ValueError('Expected command and argument object')
            self.send(200, {'ok': True, 'result': self.server.station.command(req['op'], req.get('args', {}))})
        except (ValueError, KeyError, TypeError) as exc:
            self.send(400, {'error': str(exc)})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self.send(503, {'error': str(exc)})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bridge', type=pathlib.Path, required=True)
    parser.add_argument('--modules', type=pathlib.Path, required=True)
    parser.add_argument('--recordings', type=pathlib.Path, default=ROOT.parents[2] / 'build' / 'daq-web-recordings')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8080)
    args = parser.parse_args()
    if not args.bridge.is_file() or not args.modules.is_dir():
        parser.error('Build the SDK bridge and modules first')
    station = Station(Bridge(args.bridge.resolve(), args.modules.resolve()), args.recordings)
    try:
        station.command('state', {})  # Fail startup if the source-built SDK cannot initialize.
        server = ThreadingHTTPServer((args.host, args.port), Handler)
        server.station, server.token = station, secrets.token_urlsafe(32)
        print(f'DAQ workstation listening on {args.host}:{server.server_port}', flush=True)
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
    finally:
        station.close()


if __name__ == '__main__':
    main()
