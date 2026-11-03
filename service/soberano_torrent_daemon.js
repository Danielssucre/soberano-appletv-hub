// ==============================================================================
// SOBERANO TORRENT RAM DAEMON (Apple Silicon M3 - Port 9097)
// High-Speed In-Memory Torrent Streaming Engine (0 Disk Write)
// ==============================================================================
import WebTorrent from 'webtorrent';
import memoryChunkStore from 'memory-chunk-store';
import http from 'http';
import { spawn } from 'child_process';

const PORT = parseInt(process.env.SOBERANO_TORRENT_PORT || 9097, 10);
const HOST = '0.0.0.0';

const TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://explodie.org:6969/announce',
    'udp://tracker.coppersurfer.tk:6969/announce',
    'http://tracker.opentrackr.org:1337/announce',
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.btorrent.xyz'
];

const client = new WebTorrent({
    maxConns: 75,
    dht: true,
    tracker: true,
    utp: true,
    webSeeds: true
});

const wtServer = client.createServer({ pathname: '/webtorrent' });

let activeTorrentHash = null;
let activeTorrentTimer = null;

function resetActiveTimer() {
    if (activeTorrentTimer) clearTimeout(activeTorrentTimer);
    activeTorrentTimer = setTimeout(async () => {
        if (activeTorrentHash) {
            console.log(`[SOBERANO_DAEMON] Inactividad superada (20m): purgando torrent ${activeTorrentHash} de RAM`);
            try {
                const t = await client.get(activeTorrentHash);
                if (t) t.destroy();
            } catch (e) {}
            activeTorrentHash = null;
        }
    }, 20 * 60 * 1000);
}

const myServer = http.createServer(async (req, res) => {
    resetActiveTimer();
    const reqUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    // CORS headers universales
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    // 1. WebTorrent native range requests (/webtorrent/*)
    if (reqUrl.pathname.startsWith('/webtorrent')) {
        return wtServer.wrapRequest(req, res);
    }

    // 2. Health check
    if (reqUrl.pathname === '/health' || reqUrl.pathname === '/api/torrent/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            status: 'ok',
            service: 'soberano_torrent_daemon',
            activeTorrent: activeTorrentHash,
            torrentsCount: client.torrents.length,
            downloadSpeed: client.downloadSpeed,
            uploadSpeed: client.uploadSpeed
        }));
    }

    // 3. Resolve torrent stream
    if (reqUrl.pathname === '/api/torrent/resolve' || reqUrl.pathname === '/resolve') {
        const infoHash = (reqUrl.searchParams.get('hash') || reqUrl.searchParams.get('infoHash') || '').toLowerCase().trim();
        const fileIdx = parseInt(reqUrl.searchParams.get('fileIdx') || reqUrl.searchParams.get('idx') || -1, 10);
        const dn = reqUrl.searchParams.get('name') || reqUrl.searchParams.get('title') || 'video';

        if (!infoHash) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'error', message: 'Missing infoHash' }));
        }

        // Si ya hay un torrent diferente cargado en memoria, destruirlo para liberar RAM
        if (activeTorrentHash && activeTorrentHash !== infoHash) {
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
                return sendTorrentReadyResponse(existing, fileIdx, req, res);
            }

            if (existing) {
                let responded = false;
                const onReady = () => {
                    if (responded) return;
                    responded = true;
                    sendTorrentReadyResponse(existing, fileIdx, req, res);
                };
                existing.once('ready', onReady);
                setTimeout(() => {
                    if (responded || res.headersSent) return;
                    responded = true;
                    existing.removeListener('ready', onReady);
                    res.writeHead(504, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'timeout', message: 'Tiempo de espera agotado buscando metadatos P2P.' }));
                }, 14000);
                return;
            }
        } catch (eGet) {}

        // Construir Magnet Link optimizado con trackers
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
        }, 15000);

        try {
            client.add(magnet, { store: memoryChunkStore }, (torrent) => {
                clearTimeout(metaTimeout);
                if (timeoutTriggered || res.headersSent) return;
                console.log(`[SOBERANO_DAEMON] Metadatos listos para ${torrent.name}! Archivos: ${torrent.files.length}`);
                sendTorrentReadyResponse(torrent, fileIdx, req, res);
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

    // 4. Remux Matroska to Fragmented MP4 on the fly for Safari / iPadOS
    if (reqUrl.pathname.startsWith('/remux/')) {
        const subPath = reqUrl.pathname.substring('/remux/'.length);
        const targetUrl = `http://127.0.0.1:${PORT}/webtorrent/${subPath}`;

        console.log(`[SOBERANO_DAEMON] Iniciando Remux FFmpeg hacia MP4: ${targetUrl}`);

        const ffmpeg = spawn('/opt/homebrew/bin/ffmpeg', [
            '-re',
            '-analyzeduration', '2000000',
            '-probesize', '2000000',
            '-i', targetUrl,
            '-c', 'copy',
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
            '-f', 'mp4',
            'pipe:1'
        ], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Cache-Control': 'no-store'
        });

        ffmpeg.stdout.pipe(res);

        req.on('close', () => {
            console.log('[SOBERANO_DAEMON] Cliente desconectado, finalizando proceso FFmpeg remux.');
            try { ffmpeg.kill('SIGKILL'); } catch (e) {}
        });

        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

function sendTorrentReadyResponse(torrent, fileIdx, req, res) {
    if (!torrent || !Array.isArray(torrent.files) || torrent.files.length === 0) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'error', message: 'No se encontraron archivos en el torrent.' }));
    }

    let file = null;
    if (fileIdx >= 0 && fileIdx < torrent.files.length) {
        file = torrent.files[fileIdx];
    } else {
        // Encontrar el archivo de video más grande
        let maxLen = -1;
        torrent.files.forEach((f) => {
            const isVid = /\.(mp4|mkv|avi|webm|mov|m4v)$/i.test(f.name);
            if (isVid && f.length > maxLen) {
                maxLen = f.length;
                file = f;
            }
        });
    }

    if (!file) {
        file = torrent.files[0];
    }

    const hostHeader = req.headers.host || `127.0.0.1:${PORT}`;
    const encodedFilePath = file.path.split(/[/\\]/).map(encodeURIComponent).join('/');
    const rawStreamPath = `/webtorrent/${torrent.infoHash}/${encodedFilePath}`;
    const remuxPath = `/remux/${torrent.infoHash}/${encodedFilePath}`;
    const isMkv = /\.mkv$/i.test(file.name);

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
        status: 'ok',
        infoHash: torrent.infoHash,
        name: torrent.name,
        filename: file.name,
        fileIndex: torrent.files.indexOf(file),
        sizeBytes: file.length,
        numPeers: torrent.numPeers,
        stream_path: rawStreamPath,
        remux_path: isMkv ? remuxPath : rawStreamPath,
        stream_url: `http://${hostHeader}${rawStreamPath}`,
        remux_url: `http://${hostHeader}${isMkv ? remuxPath : rawStreamPath}`,
        is_mkv: isMkv
    }));
}

myServer.listen(PORT, HOST, () => {
    console.log(`[SOBERANO_DAEMON] SOBERANO Torrent RAM Daemon escuchando en http://${HOST}:${PORT}`);
});
