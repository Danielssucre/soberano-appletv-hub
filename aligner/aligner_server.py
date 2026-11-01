#!/usr/bin/env python3
"""
SOBERANO SUB-ALIGNER SERVER (puerto 9098, solo LAN)
GET /align?type=movie|tv&id=TMDB&s=1&e=1&stream=URL[&imdb=tt..][&force=1]
GET /status?key=type_id_s_e
GET /vtt/<archivo>.vtt
GET /health
Un solo trabajador (cola FIFO). Cada trabajo corre en un subproceso (venv con mlx-whisper):
al terminar el SO libera la memoria. Guardia: no arranca con menos de 20% de memoria libre.
"""
import json, os, queue, re, subprocess, sys, threading, time, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'aligned')
LOGS = os.path.join(HERE, 'logs')
os.makedirs(OUT, exist_ok=True)
os.makedirs(LOGS, exist_ok=True)
PY = os.path.join(HERE, 'venv', 'bin', 'python')
CORE = os.path.join(HERE, 'aligner_core.py')
PORT = int(os.environ.get('ALIGNER_PORT', '9098'))

JOBS = {}           # key -> dict(state, queued_at, proc)
Q = queue.Queue()
LOCK = threading.Lock()


def free_mem_pct():
    try:
        o = subprocess.run(['memory_pressure'], capture_output=True, text=True, timeout=10).stdout
        m = re.search(r'free percentage:\s*(\d+)%', o)
        return int(m.group(1)) if m else 100
    except Exception:
        return 100


def read_meta(key):
    p = os.path.join(OUT, key + '.json')
    try:
        return json.load(open(p))
    except Exception:
        return None


def worker():
    while True:
        job = Q.get()
        key = job['key']
        try:
            waited = 0
            while free_mem_pct() < 20 and waited < 600:
                with LOCK:
                    JOBS[key]['state'] = 'waiting_memory'
                time.sleep(15)
                waited += 15
            with LOCK:
                JOBS[key]['state'] = 'running'
            cmd = [PY, CORE, '--key', key, '--type', job['type'], '--id', job['id'], '--season', job['s'],
                   '--episode', job['e'], '--stream', job['stream'], '--tv', job['tv']]
            if job.get('imdb'):
                cmd += ['--imdb', job['imdb']]
            logf = open(os.path.join(LOGS, key + '.log'), 'a')
            logf.write(f'\n=== {time.ctime()} ===\n')
            logf.flush()
            p = subprocess.Popen(cmd, stdout=logf, stderr=subprocess.STDOUT)
            with LOCK:
                JOBS[key]['proc'] = p
            p.wait()
            logf.close()
            with LOCK:
                JOBS[key]['state'] = 'finished'
        except Exception as ex:
            with LOCK:
                JOBS[key]['state'] = 'error'
                JOBS[key]['note'] = str(ex)
        finally:
            Q.task_done()


class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        sys.stderr.write('[ALIGNER] %s %s\n' % (self.address_string(), fmt % a))

    def _send(self, code, obj, ctype='application/json; charset=utf-8'):
        body = obj if isinstance(obj, (bytes, bytearray)) else json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        if u.path == '/health':
            return self._send(200, {'ok': True, 'free_mem_pct': free_mem_pct(), 'jobs': {k: v['state'] for k, v in JOBS.items()}})
        if u.path == '/status':
            key = re.sub(r'[^A-Za-z0-9_.\-]', '', q.get('key', ''))
            meta = read_meta(key) or {}
            with LOCK:
                j = JOBS.get(key)
            state = meta.get('state', 'idle')
            if j and j['state'] in ('queued', 'waiting_memory'):
                state = j['state']
            elif j and j['state'] == 'running':
                state = 'running'
            elif j and j['state'] == 'finished' and state == 'running':
                state = 'error'
                meta['note'] = meta.get('note') or 'el proceso termino sin resultado (ver logs)'
            meta['state'] = state
            return self._send(200, meta)
        if u.path.startswith('/vtt/'):
            name = os.path.basename(u.path)
            p = os.path.join(OUT, name)
            if name.endswith('.vtt') and os.path.exists(p):
                return self._send(200, open(p, 'rb').read(), 'text/vtt; charset=utf-8')
            return self._send(404, {'error': 'not found'})
        if u.path == '/align':
            typ = q.get('type', 'movie')
            if typ not in ('movie', 'tv'):
                return self._send(400, {'error': 'type'})
            tid = re.sub(r'\D', '', q.get('id', ''))
            s = re.sub(r'\D', '', q.get('s', '1')) or '1'
            e = re.sub(r'\D', '', q.get('e', '1')) or '1'
            stream = q.get('stream', '')
            if not tid or not stream.startswith('http'):
                return self._send(400, {'error': 'id/stream requeridos'})
            key = f'{typ}_{tid}_{s}_{e}'
            tv = q.get('tv') or f'http://{self.client_address[0]}:9099'
            force = q.get('force') == '1'
            meta = read_meta(key)
            with LOCK:
                j = JOBS.get(key)
                active = j and j['state'] in ('queued', 'running', 'waiting_memory')
                if active:
                    return self._send(200, {'key': key, 'state': j['state'], 'note': 'ya en curso'})
                if meta and meta.get('state') == 'done' and not force:
                    # ya alineado: reenviar al TV por si perdio el archivo
                    name = meta.get('file')
                    p = os.path.join(OUT, name or '')
                    if name and os.path.exists(p):
                        try:
                            body = json.dumps({'name': name, 'content': open(p, encoding='utf-8').read()}).encode()
                            rq = urllib.request.Request(tv + '/api/subtitles/upload', data=body,
                                                        headers={'Content-Type': 'application/json'}, method='POST')
                            urllib.request.urlopen(rq, timeout=30).read()
                        except Exception:
                            pass
                    return self._send(200, {'key': key, 'state': 'done', 'cached': True})
                JOBS[key] = {'key': key, 'state': 'queued', 'queued_at': time.time()}
            Q.put({'key': key, 'type': typ, 'id': tid, 's': s, 'e': e, 'stream': stream, 'tv': tv, 'imdb': q.get('imdb', '')})
            return self._send(200, {'key': key, 'state': 'queued'})
        return self._send(404, {'error': 'ruta'})


if __name__ == '__main__':
    threading.Thread(target=worker, daemon=True).start()
    srv = ThreadingHTTPServer(('0.0.0.0', PORT), H)
    print(f'[ALIGNER] escuchando en 0.0.0.0:{PORT}', flush=True)
    srv.serve_forever()
