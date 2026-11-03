// ==============================================================================
// SOBERANO TORRENT RAM-HLS DAEMON (Apple Silicon M3 - Port 9097)
// High-Speed In-Memory P2P Torrent + JIT HLS Engine (0 Permanent Disk Storage)
// Supports MKV / MP4 / AVI + HEVC 10-bit (M3 VideoToolbox) + EAC3/AC3/DTS -> AAC
// ==============================================================================
import WebTorrent from 'webtorrent';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn, execFile } from 'child_process';

const PORT = parseInt(process.env.SOBERANO_TORRENT_PORT || 9097, 10);
const HOST = '0.0.0.0';
const HLS_BASE_DIR = '/tmp/soberano_hls';
const FFMPEG_BIN = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const FFPROBE_BIN = fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe';

// Bounded RAM Ring-Buffer Chunk Store (Max ~320 MB RAM per active torrent - Jetsam Guard)
const MAX_RAM_STORE_BYTES = 320 * 1024 * 1024;
const PINNED_HEAD_CHUNKS = 1024; // ~16 MB initial header chunks pinned in RAM

class BoundedRamChunkStore {
    constructor(chunkLength, opts = {}) {
        this.chunkLength = Number(chunkLength);
        if (!this.chunkLength) throw new Error('First argument must be a chunk length');
        this.chunks = new Map();
        this.fifoQueue = [];
        this.usedBytes = 0;
        this.closed = false;
        this.length = Number(opts.length) || Infinity;
        if (this.length !== Infinity) {
            this.lastChunkLength = (this.length % this.chunkLength) || this.chunkLength;
            this.lastChunkIndex = Math.ceil(this.length / this.chunkLength) - 1;
        }
    }

    put(index, buf, cb = () => {}) {
        if (this.closed) return queueMicrotask(() => cb(new Error('Storage is closed')));
        const isLastChunk = (index === this.lastChunkIndex);
        if (isLastChunk && buf.length !== this.lastChunkLength) {
            return queueMicrotask(() => cb(new Error('Last chunk length must be ' + this.lastChunkLength)));
        }
        if (!isLastChunk && buf.length !== this.chunkLength) {
            return queueMicrotask(() => cb(new Error('Chunk length must be ' + this.chunkLength)));
        }

        if (!this.chunks.has(index)) {
            this.usedBytes += buf.length;
            if (index >= PINNED_HEAD_CHUNKS) {
                this.fifoQueue.push(index);
            }
        }
        this.chunks.set(index, buf);

        // Evict oldest non-pinned chunks if RAM window exceeds 320 MB
        while (this.usedBytes > MAX_RAM_STORE_BYTES && this.fifoQueue.length > 0) {
            const oldIdx = this.fifoQueue.shift();
            const oldBuf = this.chunks.get(oldIdx);
            if (oldBuf) {
                this.usedBytes -= oldBuf.length;
                this.chunks.delete(oldIdx);
            }
        }

        queueMicrotask(() => cb(null));
    }

    get(index, opts, cb = () => {}) {
        if (typeof opts === 'function') return this.get(index, null, opts);
        if (this.closed) return queueMicrotask(() => cb(new Error('Storage is closed')));

        let buf = this.chunks.get(index);
        if (!buf) {
            const err = new Error('Chunk not found in RAM window');
            err.notFound = true;
            return queueMicrotask(() => cb(err));
        }

        if (!opts) opts = {};
        const offset = opts.offset || 0;
        const len = opts.length || (buf.length - offset);
        if (offset !== 0 || len !== buf.length) {
            buf = buf.subarray(offset, len + offset);
        }
        queueMicrotask(() => cb(null, buf));
    }

    close(cb = () => {}) {
        if (this.closed) return queueMicrotask(() => cb(null));
        this.closed = true;
        this.chunks.clear();
        this.fifoQueue = [];
        this.usedBytes = 0;
        queueMicrotask(() => cb(null));
    }

    destroy(cb = () => {}) {
        this.close(cb);
    }
}

const TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://explodie.org:6969/announce',
    'udp://tracker.dler.org:6969/announce',
    'udp://exodus.desync.com:6969/announce',
    'http://tracker.opentrackr.org:1337/announce',
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.btorrent.xyz'
];

// Clean HLS base directory on startup
try {
    fs.rmSync(HLS_BASE_DIR, { recursive: true, force: true });
    fs.mkdirSync(HLS_BASE_DIR, { recursive: true });
} catch (e) {}

const client = new WebTorrent({
    maxConns: 80,
    downloadLimit: 8 * 1024 * 1024, // 8 MB/s cap to keep Mac M3 cool & responsive
    uploadLimit: 256 * 1024,
    dht: true,
    tracker: true,
    utp: true,
    webSeeds: true
});

client.on('error', (err) => {
    console.warn('[SOBERANO_DAEMON] WebTorrent client warning:', err.message);
});

const wtServer = client.createServer({ pathname: '/webtorrent' });

let activeTorrentHash = null;
let activeTorrentTimer = null;
let activeHlsSession = null; // { infoHash, fileIndex, ffmpegProc, hlsDir, videoCodec, audioLang, filename, ready }

function cleanupHlsSession(hashToClean = null) {
    if (activeHlsSession && (!hashToClean || activeHlsSession.infoHash === hashToClean)) {
        if (activeHlsSession.ffmpegProc) {
            try { activeHlsSession.ffmpegProc.kill('SIGKILL'); } catch (e) {}
        }
        if (activeHlsSession.hlsDir) {
            try { fs.rmSync(activeHlsSession.hlsDir, { recursive: true, force: true }); } catch (e) {}
        }
        activeHlsSession = null;
    }
}

function resetActiveTimer() {
    if (activeTorrentTimer) clearTimeout(activeTorrentTimer);
    activeTorrentTimer = setTimeout(async () => {
        if (activeTorrentHash) {
            console.log(`[SOBERANO_DAEMON] Inactividad superada (20m): purgando torrent ${activeTorrentHash} de RAM`);
            cleanupHlsSession(activeTorrentHash);
            try {
                const t = await client.get(activeTorrentHash);
                if (t) t.destroy();
            } catch (e) {}
            activeTorrentHash = null;
        }
    }, 20 * 60 * 1000);
}

function probeStreamStreams(rawStreamUrl) {
    return new Promise((resolve) => {
        execFile(FFPROBE_BIN, [
            '-v', 'quiet',
            '-seekable', '0',
            '-analyzeduration', '1500000',
            '-probesize', '1500000',
            '-print_format', 'json',
            '-show_streams',
            rawStreamUrl
        ], { timeout: 6000 }, (err, stdout) => {
            if (err || !stdout) return resolve([]);
            try {
                const parsed = JSON.parse(stdout);
                resolve(Array.isArray(parsed.streams) ? parsed.streams : []);
            } catch (e) {
                resolve([]);
            }
        });
    });
}

async function ensureHlsTransmuxSession(torrent, file, fileIndex, preferEs = false) {
    const infoHash = torrent.infoHash.toLowerCase();
    const hlsDir = path.join(HLS_BASE_DIR, infoHash);
    const m3u8Path = path.join(hlsDir, 'index.m3u8');
    const firstSegPath = path.join(hlsDir, 'seg_0000.ts');

    // Reuse existing session if already running or ready for the exact same torrent + file
    if (
        activeHlsSession &&
        activeHlsSession.infoHash === infoHash &&
        activeHlsSession.fileIndex === fileIndex &&
        ((fs.existsSync(m3u8Path) && fs.existsSync(firstSegPath)) ||
         (activeHlsSession.ffmpegProc && activeHlsSession.ffmpegProc.exitCode === null))
    ) {
        const waitReuse = Date.now();
        while (Date.now() - waitReuse < 14000) {
            if (fs.existsSync(m3u8Path) && fs.existsSync(firstSegPath)) {
                try {
                    const st = fs.statSync(firstSegPath);
                    if (st.size > 1024) {
                        activeHlsSession.ready = true;
                        break;
                    }
                } catch (e) {}
            }
            await new Promise(r => setTimeout(r, 80));
        }
        return activeHlsSession;
    }

    cleanupHlsSession();
    fs.mkdirSync(hlsDir, { recursive: true });

    // Prioritize the selected video file and mark the initial 8 MB as critical
    try {
        torrent.files.forEach((f) => {
            if (f !== file) f.deselect();
        });
        file.select();
        if (typeof file._startPiece === 'number' && typeof file._endPiece === 'number') {
            const pieceLen = torrent.pieceLength || (1024 * 1024);
            const critPieces = Math.max(3, Math.ceil((8 * 1024 * 1024) / pieceLen));
            const critEnd = Math.min(file._endPiece, file._startPiece + critPieces);
            torrent.critical(file._startPiece, critEnd);
            torrent.select(file._startPiece, critEnd, 10);
        }
    } catch (eSel) {}

    const encodedFilePath = file.path.split(/[/\\]/).map(encodeURIComponent).join('/');
    const rawStreamUrl = `http://127.0.0.1:${PORT}/webtorrent/${infoHash}/${encodedFilePath}`;

    // Single-pass Apple Silicon M3 Hardware VideoToolbox (H.264 8-bit yuv420p) + Stereo AAC
    // Avoids a separate ffprobe pass (saving 6s on cold swarms) and guarantees 100% compatibility
    // across 10-bit HEVC/x265, H.264, AV1, MKV, MP4, EAC3 5.1, AC3, DTS on iPadOS & LG webOS.
    const selectedAudioMap = '0:a:0?';
    const selectedAudioLang = preferEs ? 'es/orig' : 'orig';

    const ffmpegArgs = [
        '-loglevel', 'error',
        '-seekable', '0',
        '-analyzeduration', '1000000',
        '-probesize', '1000000',
        '-i', rawStreamUrl,
        '-map', '0:v:0',
        '-map', selectedAudioMap,
        '-c:v', 'h264_videotoolbox',
        '-b:v', '5500k',
        '-maxrate', '7800k',
        '-bufsize', '12000k',
        '-pix_fmt', 'yuv420p',
        '-g', '48',
        '-c:a', 'aac',
        '-ac', '2',
        '-b:a', '192k',
        '-f', 'hls',
        '-hls_time', '3',
        '-hls_list_size', '0',
        '-hls_playlist_type', 'event',
        '-hls_flags', 'independent_segments+append_list+temp_file',
        '-hls_segment_filename', path.join(hlsDir, 'seg_%04d.ts'),
        m3u8Path
    ];

    console.log(`[SOBERANO_DAEMON] Iniciando JIT HLS (M3 Hardware VideoToolbox H264 + AAC, Audio: ${selectedAudioLang}) para ${file.name}`);

    const ffmpegProc = spawn(FFMPEG_BIN, ffmpegArgs, {
        stdio: ['ignore', 'ignore', 'pipe']
    });

    // Drain stderr so the 64KB OS pipe buffer never deadlocks FFmpeg
    ffmpegProc.stderr.on('data', (chunk) => {
        const msg = chunk.toString().trim();
        if (msg) console.warn(`[SOBERANO_FFMPEG] ${msg.slice(0, 250)}`);
    });

    ffmpegProc.on('exit', (code, sig) => {
        console.log(`[SOBERANO_DAEMON] Proceso FFmpeg HLS para ${infoHash} finalizado (code=${code}, sig=${sig})`);
    });

    activeHlsSession = {
        infoHash,
        fileIndex,
        ffmpegProc,
        hlsDir,
        videoCodec: 'h264_videotoolbox',
        audioLang: selectedAudioLang,
        filename: file.name,
        ready: false
    };

    // Wait until index.m3u8 and seg_0000.ts exist on disk (up to 8s; /hls/ also waits in-flight up to 12s)
    const startWait = Date.now();
    while (Date.now() - startWait < 8000) {
        if (fs.existsSync(m3u8Path) && fs.existsSync(firstSegPath)) {
            try {
                const stat = fs.statSync(firstSegPath);
                if (stat.size > 1024) {
                    activeHlsSession.ready = true;
                    console.log(`[SOBERANO_DAEMON] Primer segmento HLS listo en ${((Date.now() - startWait) / 1000).toFixed(2)}s (${(stat.size / 1024).toFixed(0)} KB)`);
                    break;
                }
            } catch (e) {}
        }
        await new Promise(r => setTimeout(r, 80));
    }

    return activeHlsSession;
}

const myServer = http.createServer(async (req, res) => {
    resetActiveTimer();
    const reqUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    // 1. WebTorrent internal sequential/range server (/webtorrent/*)
    if (reqUrl.pathname.startsWith('/webtorrent')) {
        return wtServer.wrapRequest(req, res);
    }

    // 2. Serve JIT HLS Manifests & Segments (/hls/{infoHash}/{file})
    // Includes in-flight segment wait so AVPlayer / Hls.js never receives HTTP 404 while FFmpeg encodes!
    if (reqUrl.pathname.startsWith('/hls/')) {
        const rel = reqUrl.pathname.substring('/hls/'.length).replace(/\.\./g, '');
        const fullPath = path.join(HLS_BASE_DIR, rel);
        const isM3u8 = fullPath.endsWith('.m3u8');

        if (!fs.existsSync(fullPath) && activeHlsSession && rel.startsWith(activeHlsSession.infoHash)) {
            const waitStart = Date.now();
            while (Date.now() - waitStart < 12000) {
                if (fs.existsSync(fullPath)) {
                    try {
                        if (fs.statSync(fullPath).size > (isM3u8 ? 40 : 512)) break;
                    } catch (e) {}
                }
                await new Promise(r => setTimeout(r, 100));
            }
        }

        if (!fs.existsSync(fullPath)) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('HLS resource not found');
        }

        const stat = fs.statSync(fullPath);
        res.writeHead(200, {
            'Content-Type': isM3u8 ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
            'Content-Length': stat.size,
            'Cache-Control': isM3u8 ? 'no-store, no-cache, must-revalidate' : 'public, max-age=3600',
            'Access-Control-Allow-Origin': '*'
        });
        return fs.createReadStream(fullPath).pipe(res);
    }

    // 3. Health check
    if (reqUrl.pathname === '/health' || reqUrl.pathname === '/api/torrent/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            status: 'ok',
            service: 'soberano_torrent_daemon',
            activeTorrent: activeTorrentHash,
            activeHls: activeHlsSession ? {
                infoHash: activeHlsSession.infoHash,
                filename: activeHlsSession.filename,
                videoCodec: activeHlsSession.videoCodec,
                audioLang: activeHlsSession.audioLang,
                ready: activeHlsSession.ready
            } : null,
            torrentsCount: client.torrents.length,
            downloadSpeed: client.downloadSpeed,
            uploadSpeed: client.uploadSpeed
        }));
    }

    // 4. Resolve torrent stream & start JIT HLS
    if (reqUrl.pathname === '/api/torrent/resolve' || reqUrl.pathname === '/resolve') {
        const infoHash = (reqUrl.searchParams.get('hash') || reqUrl.searchParams.get('infoHash') || '').toLowerCase().trim();
        const fileIdx = parseInt(reqUrl.searchParams.get('fileIdx') || reqUrl.searchParams.get('idx') || -1, 10);
        const dn = reqUrl.searchParams.get('name') || reqUrl.searchParams.get('title') || 'video';
        const isEs = reqUrl.searchParams.get('is_es') === '1' || reqUrl.searchParams.get('is_es') === 'true';

        if (!infoHash) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'error', message: 'Missing infoHash' }));
        }

        if (activeTorrentHash && activeTorrentHash !== infoHash) {
            cleanupHlsSession(activeTorrentHash);
            try {
                const oldT = await client.get(activeTorrentHash);
                if (oldT) {
                    console.log(`[SOBERANO_DAEMON] Reemplazando torrent previo ${activeTorrentHash} con ${infoHash}`);
                    oldT.destroy();
                }
            } catch (e) {}
        }
        activeTorrentHash = infoHash;

        try {
            let existing = await client.get(infoHash);
            if (existing && existing.ready && Array.isArray(existing.files) && existing.files.length > 0) {
                return await sendTorrentReadyResponse(existing, fileIdx, isEs, req, res);
            }

            if (existing) {
                let responded = false;
                const onReady = async () => {
                    if (responded) return;
                    responded = true;
                    await sendTorrentReadyResponse(existing, fileIdx, isEs, req, res);
                };
                existing.once('ready', onReady);
                setTimeout(() => {
                    if (responded || res.headersSent) return;
                    responded = true;
                    existing.removeListener('ready', onReady);
                    res.writeHead(504, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'timeout', message: 'Tiempo de espera agotado buscando metadatos P2P.' }));
                }, 18000);
                return;
            }
        } catch (eGet) {}

        const trParams = TRACKERS.map(t => `tr=${encodeURIComponent(t)}`).join('&');
        const magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(dn)}&${trParams}`;

        console.log(`[SOBERANO_DAEMON] Añadiendo torrent a RAM: ${infoHash} (${dn})`);

        let timeoutTriggered = false;
        const metaTimeout = setTimeout(() => {
            timeoutTriggered = true;
            if (!res.headersSent) {
                res.writeHead(504, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'timeout', message: 'Tiempo de espera agotado buscando metadatos en el enjambre P2P.' }));
            }
        }, 18000);

        try {
            client.add(magnet, { store: BoundedRamChunkStore }, async (torrent) => {
                clearTimeout(metaTimeout);
                if (timeoutTriggered || res.headersSent) return;
                console.log(`[SOBERANO_DAEMON] Metadatos listos para ${torrent.name}! Archivos: ${torrent.files.length}`);
                await sendTorrentReadyResponse(torrent, fileIdx, isEs, req, res);
            });
        } catch (eAdd) {
            clearTimeout(metaTimeout);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', message: eAdd.message }));
            }
        }
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

async function sendTorrentReadyResponse(torrent, fileIdx, isEs, req, res) {
    if (!torrent || !Array.isArray(torrent.files) || torrent.files.length === 0) {
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', message: 'No se encontraron archivos en el torrent.' }));
        }
        return;
    }

    const VIDEO_REGEX = /\.(mp4|mkv|avi|webm|mov|m4v|ts)$/i;
    let file = null;
    if (fileIdx >= 0 && fileIdx < torrent.files.length && VIDEO_REGEX.test(torrent.files[fileIdx].name)) {
        file = torrent.files[fileIdx];
    } else {
        let maxLen = -1;
        torrent.files.forEach((f) => {
            if (VIDEO_REGEX.test(f.name) && f.length > maxLen) {
                maxLen = f.length;
                file = f;
            }
        });
    }

    if (!file) {
        file = torrent.files.reduce((best, cur) => (!best || cur.length > best.length ? cur : best), null) || torrent.files[0];
    }

    const actualIdx = torrent.files.indexOf(file);
    const hostHeader = req.headers.host || `127.0.0.1:${PORT}`;
    const encodedFilePath = file.path.split(/[/\\]/).map(encodeURIComponent).join('/');
    const rawStreamPath = `/webtorrent/${torrent.infoHash}/${encodedFilePath}`;

    const hlsSession = await ensureHlsTransmuxSession(torrent, file, actualIdx, isEs);
    const hlsPath = `/hls/${torrent.infoHash.toLowerCase()}/index.m3u8`;

    if (res.headersSent) return;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
        status: 'ok',
        infoHash: torrent.infoHash.toLowerCase(),
        name: torrent.name,
        filename: file.name,
        fileIndex: actualIdx,
        sizeBytes: file.length,
        numPeers: torrent.numPeers,
        videoCodec: hlsSession ? hlsSession.videoCodec : 'unknown',
        audioLang: hlsSession ? hlsSession.audioLang : 'orig',
        hls_ready: hlsSession ? hlsSession.ready : false,
        hls_path: hlsPath,
        hls_url: `http://${hostHeader}${hlsPath}`,
        stream_path: rawStreamPath,
        stream_url: `http://${hostHeader}${rawStreamPath}`,
        is_mkv: /\.mkv$/i.test(file.name)
    }));
}

myServer.listen(PORT, HOST, () => {
    console.log(`[SOBERANO_DAEMON] SOBERANO Torrent RAM-HLS Daemon escuchando en http://${HOST}:${PORT}`);
});
