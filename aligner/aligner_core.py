#!/usr/bin/env python3
"""
SOBERANO SUB-ALIGNER (job worker)
=================================
Sincroniza subtitulos con el audio REAL del stream que reproduce el TV.

Generaliza la estrategia de Ninku ("el tiempo sale del propio video"):
  1. Reune subtitulos candidatos (proveedor del stream + OpenSubtitles via Stremio, sin API key).
  2. Toma el audio del stream en ventanas cortas (ffmpeg -ss, HTTP range) y lo transcribe con
     Whisper local (MLX). El texto reconocido se empareja con las lineas del subtitulo de referencia
     (mismo idioma que el audio) -> anclas (tiempo_video, tiempo_subtitulo).
  3. Refinamiento adaptativo (biseccion) hasta localizar cortes/insercion de escenas (cortes extendidos)
     y derivas de fps  -> mapa por tramos (constante / lineal / escalon en el mayor silencio).
  4. Alinea cada candidato en espanol contra la referencia (correlacion de actividad de dialogo,
     independiente del idioma), elige el mejor; si ninguno alinea bien, traduce la referencia (metodo Ninku).
  5. Escribe el .vtt final, lo publica en el TV (POST /api/subtitles/upload) y guarda metricas.

Se ejecuta como proceso aparte: al terminar el SO libera toda la memoria (guardia Jetsam M3).
"""
import argparse, difflib, gc, json, os, re, subprocess, sys, time, urllib.parse, urllib.request
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, 'aligned')
TMP_DIR = os.path.join(HERE, 'tmp')
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(TMP_DIR, exist_ok=True)

FPS = 10                      # resolucion de actividad (100 ms)
WIN = 60                      # segundos de audio por ventana ASR
COARSE_STEP = 480             # separacion de ventanas gruesas (s)
MAX_WINDOWS = 90              # presupuesto total de ventanas ASR
UA = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36'}
WHISPER_MULTI = 'mlx-community/whisper-base-mlx'
WHISPER_EN = 'mlx-community/whisper-base.en-mlx'


# --------------------------------------------------------------------------- utilidades
class Status:
    def __init__(self, key):
        self.path = os.path.join(OUT_DIR, key + '.json')
        self.d = {'key': key, 'state': 'running', 'stage': 'init', 'progress': 0.0, 'version': 0,
                  'note': '', 'started': time.time(), 'windows': 0}
        self.save()

    def update(self, **kw):
        self.d.update(kw)
        self.d['ts'] = time.time()
        self.save()

    def save(self):
        tmp = self.path + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(self.d, f)
        os.replace(tmp, self.path)


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def http_get(url, timeout=25, headers=None):
    req = urllib.request.Request(url, headers=headers or UA)
    return urllib.request.urlopen(req, timeout=timeout).read()


def http_json(url, timeout=25):
    return json.loads(http_get(url, timeout).decode('utf-8', 'ignore'))


def decode_bytes(b):
    for enc in ('utf-8-sig', 'cp1252', 'latin-1'):
        try:
            return b.decode(enc)
        except Exception:
            continue
    return b.decode('utf-8', 'ignore')


def ts_to_s(s):
    s = s.strip().replace(',', '.')
    p = s.split(':')
    if len(p) == 3:
        return int(p[0]) * 3600 + int(p[1]) * 60 + float(p[2])
    return int(p[0]) * 60 + float(p[1])


def s_to_ts(t):
    t = max(0.0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    sec = t - h * 3600 - m * 60
    return f'{h:02d}:{m:02d}:{sec:06.3f}'


TC = re.compile(r'(\d+:\d+:\d+[.,]\d+|\d+:\d+[.,]\d+)\s*-->\s*(\d+:\d+:\d+[.,]\d+|\d+:\d+[.,]\d+)')


def parse_cues(text):
    text = text.replace('\r', '')
    cues = []
    for blk in re.split(r'\n\s*\n', text):
        m = TC.search(blk)
        if not m:
            continue
        body = blk[m.end():]
        body = re.sub(r'<[^>]+>', '', body)
        body = re.sub(r'\{\\[^}]*\}', '', body)
        lines = [l.strip() for l in body.split('\n') if l.strip()]
        txt = '\n'.join(lines)
        if not txt:
            continue
        try:
            cues.append([ts_to_s(m.group(1)), ts_to_s(m.group(2)), txt])
        except Exception:
            continue
    cues.sort(key=lambda c: c[0])
    return cues


def write_vtt(cues):
    out = ['WEBVTT', '']
    for s, e, t in cues:
        out.append(f'{s_to_ts(s)} --> {s_to_ts(e)}')
        out.append(t)
        out.append('')
    return '\n'.join(out)


def norm(t):
    t = t.lower()
    t = re.sub(r'[^a-z0-9\u00e0-\u00ff ]', ' ', t)
    return re.sub(r'\s+', ' ', t).strip()


def activity(cues, total):
    n = int(total * FPS) + 2
    a = np.zeros(n, dtype=np.float32)
    for s, e, _ in cues:
        i, j = int(max(0, s) * FPS), int(max(0, e) * FPS) + 1
        if i < n:
            a[i:min(j, n)] = 1.0
    return a


# --------------------------------------------------------------------------- candidatos
def gather_candidates(kind, tid, season, episode, imdb, tv_base, st):
    """Devuelve lista de dicts {lang, url, label, src, cues}."""
    raw = []
    # 1) proveedor del stream
    try:
        q = f'type={kind}&id={tid}' + (f'&season={season}&episode={episode}' if kind == 'tv' else '')
        fx = http_json('https://api.framextv.tech/api/stream?' + q, 25)
        for s in fx.get('subtitles', []) or []:
            l = (s.get('lang') or s.get('language') or '').lower()
            if l.startswith('en'):
                raw.append(('en', s['url'], s.get('label', 'provider-en'), 'provider'))
            elif l.startswith('es'):
                raw.append(('es', s['url'], s.get('label', 'provider-es'), 'provider'))
    except Exception as ex:
        log('provider subs error', ex)
    # 2) IMDb -> OpenSubtitles v3 (Stremio, sin API key)
    if not imdb:
        try:
            imdb = http_json(f'{tv_base}/api/tmdb/{kind}/{tid}/external_ids', 15).get('imdb_id')
        except Exception as ex:
            log('imdb lookup error', ex)
    if imdb:
        try:
            path = f'movie/{imdb}' if kind == 'movie' else f'series/{imdb}:{season}:{episode}'
            data = http_json(f'https://opensubtitles-v3.strem.io/subtitles/{path}.json', 25)
            per = {'en': 0, 'es': 0}
            for s in data.get('subtitles', []):
                l = s.get('lang', '')
                code = 'en' if l == 'eng' else ('es' if l in ('spa', 'spl') else None)
                if code and per[code] < 8:
                    per[code] += 1
                    raw.append((code, s['url'], s.get('movieReleaseName') or s.get('subtitleFileName') or 'os', 'opensubtitles'))
        except Exception as ex:
            log('opensubtitles error', ex)
    cands, seen = [], set()
    for lang, url, label, src in raw:
        if url in seen:
            continue
        seen.add(url)
        try:
            cues = parse_cues(decode_bytes(http_get(url, 30)))
        except Exception as ex:
            log('skip', label, ex)
            continue
        if len(cues) < (60 if kind == 'movie' else 20):
            continue
        cands.append({'lang': lang, 'url': url, 'label': label, 'src': src, 'cues': cues})
    log('candidatos:', [(c['lang'], c['src'], len(c['cues'])) for c in cands])
    return cands, imdb


# --------------------------------------------------------------------------- ASR
class ASR:
    def __init__(self, url, st, deadline):
        self.url, self.st, self.deadline = url, st, deadline
        self.lang = None
        self.model = WHISPER_MULTI
        self.count = 0

    def extract(self, t0, dur, path):
        for attempt in range(2):
            try:
                if os.path.exists(path):
                    os.remove(path)
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{t0:.2f}', '-t', str(dur), '-i', self.url, '-vn',
                                '-af', 'pan=mono|c0=FC,highpass=f=100', '-ar', '16000', '-ac', '1', path],
                               check=True, timeout=100, capture_output=True)
                if os.path.exists(path) and os.path.getsize(path) > 64000:
                    return True
            except Exception as ex:
                log('ffmpeg retry', t0, str(ex)[:80])
        # ultimo recurso: pista mono/estereo sin pan al canal central
        try:
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{t0:.2f}', '-t', str(dur), '-i', self.url, '-vn',
                            '-ac', '1', '-ar', '16000', path], check=True, timeout=100, capture_output=True)
            return os.path.exists(path) and os.path.getsize(path) > 64000
        except Exception:
            return False

    def segments(self, t0, dur=WIN):
        import mlx_whisper
        if time.time() > self.deadline or self.count >= MAX_WINDOWS:
            return None
        wav = os.path.join(TMP_DIR, f'w_{os.getpid()}.wav')
        if not self.extract(max(0, t0), dur, wav):
            return []
        self.count += 1
        kw = dict(path_or_hf_repo=self.model, condition_on_previous_text=False, temperature=0.0,
                  no_speech_threshold=0.5, word_timestamps=False)
        if self.lang:
            kw['language'] = self.lang
        out = mlx_whisper.transcribe(wav, **kw)
        if not self.lang:
            good = [x for x in out['segments'] if len(x['text'].strip()) > 10]
            if len(good) >= 3:
                self.lang = out.get('language')
                if self.lang == 'en':
                    self.model = WHISPER_EN
                log('idioma de audio detectado:', self.lang)
        try:
            os.remove(wav)
        except Exception:
            pass
        self.st.update(windows=self.count)
        return out['segments']


class RefIndex:
    """Indice invertido de palabras para emparejar texto ASR contra cues de un subtitulo."""
    def __init__(self, cues):
        self.cues = cues
        self.norm = [norm(c[2]) for c in cues]
        self.inv = {}
        for i, n in enumerate(self.norm):
            for w in set(n.split()):
                if len(w) >= 3:
                    self.inv.setdefault(w, []).append(i)

    def best(self, text):
        words = [w for w in set(norm(text).split()) if len(w) >= 3]
        if len(words) < 2:
            return None
        score = {}
        for w in words:
            lst = self.inv.get(w)
            if lst and len(lst) < 400:
                for i in lst:
                    score[i] = score.get(i, 0) + 1
        if not score:
            return None
        top = sorted(score.items(), key=lambda x: -x[1])[:6]
        nt = norm(text)
        best = (0.0, None)
        for i, _ in top:
            r = difflib.SequenceMatcher(None, nt, self.norm[i]).ratio()
            if r > best[0]:
                best = (r, i)
        return best if best[1] is not None else None


def window_matches(asr, c, indexes):
    """Mide el desfase d = t_video - t_subtitulo en torno al tiempo de video c.
    indexes: {nombre: RefIndex}. Devuelve {nombre: (d, n_inliers)} y el centro real."""
    t0 = max(0.0, c - WIN / 2)
    segs = asr.segments(t0, WIN)
    if segs is None:
        return None
    res = {}
    for name, idx in indexes.items():
        ms = []
        for sg in segs:
            tx = sg['text'].strip()
            if len(norm(tx)) < 14 or sg.get('no_speech_prob', 0) > 0.6:
                continue
            b = idx.best(tx)
            if not b or b[0] < 0.78:
                continue
            ms.append((t0 + sg['start'], idx.cues[b[1]][0], b[0], len(norm(tx))))
        if not ms:
            continue
        ds = np.array([v - s for v, s, _, _ in ms])
        mode = max(ds, key=lambda x: int((np.abs(ds - x) <= 1.5).sum()))
        inl = [m for m, d in zip(ms, ds) if abs(d - mode) <= 1.5]
        if len(inl) >= 2 or (len(inl) == 1 and inl[0][2] >= 0.95 and inl[0][3] >= 28):
            d = float(np.median([m[0] - m[1] for m in inl]))
            res[name] = (d, len(inl))
    return res, t0 + WIN / 2


def measure(asr, c, indexes, dur):
    for sh in (0, 40, -40, 80, -80):
        cc = min(max(c + sh, 30), dur - 30)
        r = window_matches(asr, cc, indexes)
        if r is None:
            return None
        res, center = r
        if res:
            return center, res
    return None


# --------------------------------------------------------------------------- mapa por tramos
class Mapper:
    """Mapa t -> d(t) por tramos. pts: [(t, d, kind_to_next)], kind in 'lin'|'step'."""
    def __init__(self, pts, cues):
        self.pts = sorted(pts, key=lambda p: p[0])
        self.breaks = []
        for i in range(len(self.pts) - 1):
            t1, d1, k = self.pts[i]
            t2, d2, _ = self.pts[i + 1]
            self.breaks.append(self._gap(cues, t1, t2) if k == 'step' else None)

    @staticmethod
    def _gap(cues, a, b):
        best, bt = 0.0, (a + b) / 2
        prev_end = None
        for s, e, _ in cues:
            if s < a - 1:
                continue
            if prev_end is not None and a <= prev_end <= b and s - prev_end > best:
                best, bt = s - prev_end, (prev_end + s) / 2
            prev_end = e
            if s > b:
                break
        return bt

    def __call__(self, t):
        pts = self.pts
        if not pts:
            return 0.0
        if t <= pts[0][0]:
            return pts[0][1]
        if t >= pts[-1][0]:
            return pts[-1][1]
        lo, hi = 0, len(pts) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if pts[mid][0] <= t:
                lo = mid
            else:
                hi = mid
        t1, d1, k = pts[lo]
        t2, d2, _ = pts[hi]
        if k == 'lin':
            return d1 + (d2 - d1) * (t - t1) / max(1e-6, t2 - t1)
        return d1 if t < self.breaks[lo] else d2


def ncc_profile(win, ref):
    from scipy.signal import fftconvolve
    n = len(win)
    w = win - win.mean()
    wn = float(np.sqrt((w ** 2).sum()))
    if wn < 1e-6 or len(ref) < n + 2:
        return None
    c1 = np.concatenate([[0.0], np.cumsum(ref, dtype=np.float64)])
    c2 = np.concatenate([[0.0], np.cumsum(ref.astype(np.float64) ** 2)])
    num = fftconvolve(ref, w[::-1], mode='valid')
    s1 = c1[n:] - c1[:-n]
    s2 = c2[n:] - c2[:-n]
    var = np.maximum(s2 - s1 ** 2 / n, 0)
    den = wn * np.sqrt(np.maximum(var, 1e-9))
    ncc = num / den
    ncc[var < 0.02 * n] = -1
    return ncc


def align_track_to_ref(cands_cues, ref_cues, dur):
    """Alinea un subtitulo candidato contra la referencia por correlacion de actividad.
    Devuelve (Mapper lag(t_cand) -> t_ref - t_cand, score, cobertura)."""
    L = dur + 1800
    ac = activity(cands_cues, L)
    ar = activity(ref_cues, L)
    W = 150 * FPS
    step = 60 * FPS
    maxlag = 1500 * FPS
    pts = []
    n_ok = n_tot = 0
    scores = []
    for s0 in range(0, int(dur * FPS) - W, step):
        win = ac[s0:s0 + W]
        if win.mean() < 0.12:
            continue
        n_tot += 1
        prof = ncc_profile(win, ar)
        if prof is None:
            continue
        lo = max(0, s0 - maxlag)
        hi = min(len(prof), s0 + maxlag + 1)
        if hi <= lo:
            continue
        seg = prof[lo:hi]
        j = int(np.argmax(seg))
        best = float(seg[j])
        p = lo + j
        mask = np.ones(len(seg), bool)
        mask[max(0, j - 30):j + 31] = False
        second = float(seg[mask].max()) if mask.any() else 0.0
        if best >= 0.45 and best - second >= 0.08:
            pts.append(((s0 + W / 2) / FPS, (p - s0) / FPS, best))
            scores.append(best)
            n_ok += 1
    # filtra atipicos aislados (debe coincidir con algun vecino a +-2 s)
    keep = []
    for i, (t, lag, sc) in enumerate(pts):
        near = [abs(lag - pts[k][1]) <= 2.0 for k in (i - 1, i + 1) if 0 <= k < len(pts)]
        if any(near):
            keep.append((t, lag, sc))
    if not keep:
        return None, 0.0, 0.0
    mp_pts = []
    for i, (t, lag, sc) in enumerate(keep):
        kind = 'lin'
        if i + 1 < len(keep):
            kind = 'lin' if abs(keep[i + 1][1] - lag) <= 6.0 else 'step'
        mp_pts.append((t, lag, kind))
    cov = len(keep) / max(1, n_tot)
    return Mapper(mp_pts, cands_cues), float(np.median([k[2] for k in keep])), cov


# --------------------------------------------------------------------------- traduccion (metodo Ninku)
def translate_cues(cues, src='en', dst='es'):
    out = []
    CH = 30
    for i in range(0, len(cues), CH):
        chunk = cues[i:i + CH]
        combined = '\n===\n'.join(c[2].replace('\n', ' ') for c in chunk)
        url = ('https://translate.googleapis.com/translate_a/single?client=gtx&sl=%s&tl=%s&dt=t&q=' % (src, dst)
               + urllib.parse.quote(combined))
        try:
            data = json.loads(http_get(url, 20).decode('utf-8'))
            full = ''.join(seg[0] for seg in data[0] if seg[0])
            parts = full.split('===')
            for j, c in enumerate(chunk):
                t = parts[j].strip() if j < len(parts) else c[2]
                out.append([c[0], c[1], t])
        except Exception:
            out.extend([list(c) for c in chunk])
        time.sleep(0.1)
    return out


# --------------------------------------------------------------------------- publicacion
def publish(key, name, vtt_text, tv_base, st, stage, extra=None):
    path = os.path.join(OUT_DIR, name)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(vtt_text)
    ok = False
    try:
        body = json.dumps({'name': name, 'content': vtt_text}).encode('utf-8')
        req = urllib.request.Request(tv_base + '/api/subtitles/upload', data=body,
                                     headers={'Content-Type': 'application/json'}, method='POST')
        r = json.loads(urllib.request.urlopen(req, timeout=40).read().decode())
        ok = (r.get('status') == 'ok')
        log('publicado en TV:', r)
    except Exception as ex:
        log('push TV fallo:', ex)
    v = st.d.get('version', 0) + 1
    st.update(stage=stage, version=v, file=name, pushed=ok, **(extra or {}))
    return ok


def build_output(chosen_cues, mapper_c2r, ref_mapper, dur):
    out = []
    for s, e, t in chosen_cues:
        lag = mapper_c2r(s) if mapper_c2r else 0.0
        rs, re_ = s + lag, e + (mapper_c2r(e) if mapper_c2r else 0.0)
        ds = ref_mapper(rs)
        de = ref_mapper(re_)
        vs, ve = rs + ds, re_ + de
        if vs < 0 or vs > dur + 5:
            continue
        if ve <= vs:
            ve = vs + 1.5
        out.append([vs, ve, t])
    return out


# --------------------------------------------------------------------------- principal
def run(a):
    key = a.key
    st = Status(key)
    kind = a.type
    t_start = time.time()
    deadline = t_start + a.max_minutes * 60
    try:
        dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of',
                                    'default=nw=1:nk=1', a.stream], capture_output=True, text=True, timeout=60).stdout.strip())
    except Exception:
        dur = 0.0
    if dur < 120:
        st.update(state='error', note='no se pudo leer la duracion del stream')
        return 2
    log('duracion', dur)
    st.update(stage='candidatos', progress=0.02, duration=dur)
    cands, imdb = gather_candidates(kind, a.id, a.season, a.episode, a.imdb, a.tv, st)
    if not cands:
        st.update(state='error', note='sin subtitulos candidatos')
        return 3

    asr = ASR(a.stream, st, deadline)
    # ---- fase 0: idioma + eleccion de referencia (cualquier idioma presente entre candidatos)
    st.update(stage='idioma_referencia', progress=0.05)
    all_idx = {f"{c['lang']}|{i}": RefIndex(c['cues']) for i, c in enumerate(cands)}
    asr.lang = None
    votes = {}
    probe_pts = [dur * 0.18, dur * 0.38, dur * 0.62]
    first = True
    for c in probe_pts:
        if first:
            # primer window: autodeteccion de idioma
            first = False
        m = measure(asr, c, {k: v for k, v in all_idx.items() if not asr.lang or k.startswith(asr.lang + '|')}, dur)
        if m and m[1]:
            for k, (d, n) in m[1].items():
                votes[k] = votes.get(k, 0) + n
    if not votes:
        st.update(state='error', note=f'no se encontro texto coincidente entre audio y subtitulos (idioma audio={asr.lang})')
        return 4
    ref_key = max(votes, key=votes.get)
    ref_idx = int(ref_key.split('|')[1])
    ref = cands[ref_idx]
    ref_index = {ref_key: all_idx[ref_key]}
    log('referencia:', ref['label'], ref['src'], 'idioma audio:', asr.lang, 'votos', votes)

    # ---- fase 1: ventanas gruesas
    pts = []   # (c_video, d)
    cs = list(np.arange(COARSE_STEP / 2, dur - 60, COARSE_STEP))
    for i, c in enumerate(cs):
        m = measure(asr, float(c), ref_index, dur)
        if m and ref_key in m[1]:
            pts.append((m[0], m[1][ref_key][0]))
            log(f'  coarse c={m[0]:7.1f}s d={m[1][ref_key][0]:+8.2f}s n={m[1][ref_key][1]}')
        st.update(stage='ventanas_gruesas', progress=0.08 + 0.35 * (i + 1) / len(cs))
    pts.sort()
    if len(pts) < 2:
        st.update(state='error', note='anclas insuficientes (<2)')
        return 5

    def build_ref_mapper(pts_list, leaves):
        """leaves: {(c1,c2): kind}. Convierte a mapa en tiempo de subtitulo (r = c - d)."""
        P = []
        srt = sorted(pts_list)
        for i, (c, d) in enumerate(srt):
            kind = 'lin'
            if i + 1 < len(srt):
                kind = leaves.get((c, srt[i + 1][0]), 'step' if abs(srt[i + 1][1] - d) > 6 else 'lin')
            P.append((c - d, d, kind))
        # en tiempo de subtitulo el orden puede cambiar si hay cortes: ordenar por r
        return Mapper(P, ref['cues'])

    def publish_current(stage, leaves):
        mp = build_ref_mapper(pts, leaves)
        final_cues, label, extra = choose_and_build(mp)
        vtt = write_vtt(final_cues)
        name = f'auto_{kind}_{a.id}_{a.season}_{a.episode}.vtt'
        publish(key, name, vtt, a.tv, st, stage, extra)

    # ---- eleccion del subtitulo final (espanol) + construccion
    es_cands = [c for c in cands if c['lang'] == 'es']
    cache_align = {}

    def choose_and_build(ref_mapper):
        target = a.lang
        if asr.lang == target:
            return build_output(ref['cues'], None, ref_mapper, dur), 'referencia', {'method': 'referencia_directa', 'chosen': ref['label']}
        best = None
        for i, c in enumerate(es_cands):
            if i not in cache_align:
                cache_align[i] = align_track_to_ref(c['cues'], ref['cues'], dur)
            mp, sc, cov = cache_align[i]
            if mp is None:
                continue
            q = sc * cov
            log(f'  candidato es {c["label"][:40]} score={sc:.2f} cov={cov:.2f} q={q:.2f}')
            if best is None or q > best[0]:
                best = (q, c, mp, sc, cov)
        if best and best[0] >= 0.30:
            q, c, mp, sc, cov = best
            cues = build_output(c['cues'], mp, ref_mapper, dur)
            return cues, c['label'], {'method': 'candidato_es_alineado', 'chosen': c['label'], 'score': round(sc, 3), 'coverage': round(cov, 3)}
        # fallback Ninku: traducir referencia alineada
        if 'trans' not in cache_align:
            cache_align['trans'] = translate_cues(ref['cues'], asr.lang or 'en', target)
        res = build_output(cache_align['trans'], None, ref_mapper, dur)
        return res, ref['label'], {'method': 'referencia_traducida', 'chosen': ref['label']}

    st.update(stage='publicando_preliminar', progress=0.45)
    publish_current('preliminar', {})

    # ---- fase 2: refinamiento adaptativo
    leaves = {}
    st.update(stage='refinando', progress=0.5)

    def refine(p1, p2, depth=0):
        c1, d1 = p1
        c2, d2 = p2
        L = c2 - c1
        if L < 50:
            leaves[(c1, c2)] = 'step' if abs(d1 - d2) > 0.8 else 'lin'
            return
        if abs(d1 - d2) <= 0.8 and L <= 600:
            leaves[(c1, c2)] = 'lin'
            return
        if time.time() > deadline or asr.count >= MAX_WINDOWS or depth > 9:
            leaves[(c1, c2)] = 'step' if abs(d1 - d2) > 6 else 'lin'
            return
        m = measure(asr, (c1 + c2) / 2, ref_index, dur)
        if not m or ref_key not in m[1]:
            leaves[(c1, c2)] = 'step' if abs(d1 - d2) > 6 else 'lin'
            return
        cm, (dm, _) = m[0], m[1][ref_key]
        if cm <= c1 + 5 or cm >= c2 - 5:
            leaves[(c1, c2)] = 'step' if abs(d1 - d2) > 6 else 'lin'
            return
        pts.append((cm, dm))
        exp = d1 + (d2 - d1) * (cm - c1) / L
        log(f'  refine c={cm:7.1f}s d={dm:+8.2f}s (esperado lineal {exp:+8.2f})')
        if abs(dm - exp) <= 0.8 and abs(d1 - d2) <= 40:
            leaves[(c1, cm)] = 'lin'
            leaves[(cm, c2)] = 'lin'
            return
        refine((c1, d1), (cm, dm), depth + 1)
        refine((cm, dm), (c2, d2), depth + 1)

    base_pts = list(pts)
    for i in range(len(base_pts) - 1):
        refine(base_pts[i], base_pts[i + 1])
        st.update(progress=0.5 + 0.4 * (i + 1) / max(1, len(base_pts) - 1))

    publish_current('final', leaves)
    # ---- metricas de calidad: residual entre anclas y mapa final
    final_map = build_ref_mapper(pts, leaves)
    resid = [abs(final_map(c - d) - d) for c, d in pts]
    extra = {'anchors': len(pts), 'windows': asr.count, 'residual_median_s': round(float(np.median(resid)), 3),
             'residual_max_s': round(float(np.max(resid)), 3), 'elapsed_s': round(time.time() - t_start, 1),
             'audio_lang': asr.lang}
    st.update(state='done', progress=1.0, **extra)
    log('LISTO', extra)
    json.dump({'anchors': sorted(pts), 'leaves': {f'{k[0]:.1f}-{k[1]:.1f}': v for k, v in leaves.items()}},
              open(os.path.join(OUT_DIR, key + '.anchors.json'), 'w'))
    return 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--key', required=True)
    ap.add_argument('--type', default='movie')
    ap.add_argument('--id', required=True)
    ap.add_argument('--season', default='1')
    ap.add_argument('--episode', default='1')
    ap.add_argument('--stream', required=True)
    ap.add_argument('--imdb', default='')
    ap.add_argument('--tv', default='http://192.168.128.8:9099')
    ap.add_argument('--lang', default='es')
    ap.add_argument('--max-minutes', type=float, default=30)
    args = ap.parse_args()
    try:
        sys.exit(run(args))
    except Exception as ex:
        import traceback
        traceback.print_exc()
        Status(args.key).update(state='error', note=str(ex)[:300])
        sys.exit(1)
