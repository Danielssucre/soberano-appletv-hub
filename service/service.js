/**
 * Soberano Hub — On-Device webOS Native Companion Service
 * Package ID: com.soberano.appletvhub.service
 * Runtime: Node.js 8.12.0 (ARMv7 Realtek SoC)
 * Capabilities: Autonomous Stream Extractor, Direct HLS Rewriter,
 *               Sliding-Window RAM Segment Prefetcher (45 MB Bounded RAM Buffer),
 *               Smart Fast-Mirror Auto-Routing (cdn2/cdn1 priority over cdn6),
 *               Full Catalog Engine (5,059 animes), Trending & On-Air Scraper,
 *               TMDB Proxy & WebVTT Subtitles ($0.00 USD, 100% On-Device).
 */

'use strict';

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

// 1. webOS Luna Service Bridge Registration
let service = null;
try {
    const Service = require('webos-service');
    service = new Service('com.soberano.appletvhub.service');
    console.log('[SOBERANO_SERVICE] Registered with webOS Service Bus');

    service.register('heartbeat', (message) => {
        message.respond({
            returnValue: true,
            status: 'running',
            port: 9099,
            memory: process.memoryUsage(),
            uptime: process.uptime()
        });
    });

    service.register('status', (message) => {
        message.respond({
            returnValue: true,
            device: 'LG_webOS_5.6',
            streamEngine: 'Active_Turbo_Prefetch_RAM',
            catalogEngine: 'Full_5000_Active'
        });
    });
} catch (e) {
    console.log('[SOBERANO_SERVICE] webos-service not available, continuing in pure HTTP mode:', e.message);
}

// 2. HTTP Server Engine on 0.0.0.0:9099
const PORT = 9099;
const BIND_HOST = '0.0.0.0';

// Resolution paths for files
function findIpadVaultHtml() {
    const candidates = [
        path.join(__dirname, 'ipad_vault.html'),
        path.join(__dirname, '../com.soberano.appletvhub/ipad_vault.html'),
        '/media/developer/temp/ipad_vault.html',
        '/media/developer/apps/usr/palm/applications/com.soberano.appletvhub/ipad_vault.html'
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

const SUBTITLES_DIR = path.join(__dirname, 'subtitles');

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    'Referer': 'https://jkanime.net/'
};

// ==============================================================================
// 2B. TURBO RAM BUFFER & PREFETCH ENGINE (ZERO DISK PERSISTENCE)
// ==============================================================================
const RAM_SEGMENT_CACHE = new Map(); // segUrl -> Buffer
let TOTAL_CACHE_BYTES = 0;
const MAX_CACHE_BYTES = 45 * 1024 * 1024; // 45 MB bound safe for webOS
const IN_FLIGHT_SEGMENTS = new Map(); // segUrl -> Promise<Buffer>
let CURRENT_PLAYLIST_SEGMENTS = []; // active segment URLs in chronological order

function getMirrorCandidates(segUrl) {
    const list = [];
    if (segUrl.includes('ducvomes.com')) {
        if (segUrl.includes('cdn6.ducvomes.com')) {
            list.push(segUrl.replace('cdn6.ducvomes.com', 'cdn2.ducvomes.com'));
            list.push(segUrl.replace('cdn6.ducvomes.com', 'cdn1.ducvomes.com'));
            list.push(segUrl.replace('cdn6.ducvomes.com', 'cdn3.ducvomes.com'));
        }
        list.push(segUrl);
        for (const fast of ['cdn2', 'cdn1', 'cdn3']) {
            const alt = segUrl.replace(/cdn\d+\.ducvomes\.com/, fast + '.ducvomes.com');
            if (!list.includes(alt)) list.push(alt);
        }
    } else {
        list.push(segUrl);
    }
    return list;
}

function fetchSegmentBinary(targetUrl, timeoutMs = 7000) {
    return new Promise((resolve, reject) => {
        const candidates = getMirrorCandidates(targetUrl);
        let idx = 0;

        function tryNext() {
            if (idx >= candidates.length) {
                return reject(new Error('All mirror candidates failed for ' + targetUrl));
            }
            const cand = candidates[idx++];
            try {
                const parsed = url.parse(cand);
                const client = parsed.protocol === 'https:' ? https : http;
                const opts = {
                    hostname: parsed.hostname,
                    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                    path: parsed.path,
                    method: 'GET',
                    headers: Object.assign({}, HEADERS, { 'Referer': 'https://jkanime.net/' }),
                    timeout: timeoutMs
                };

                const req = client.request(opts, (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        let redir = res.headers.location;
                        if (!redir.startsWith('http')) redir = url.resolve(cand, redir);
                        return fetchSegmentBinary(redir, timeoutMs).then(resolve).catch(() => tryNext());
                    }
                    if (res.statusCode !== 200 && res.statusCode !== 206) {
                        return tryNext();
                    }
                    const chunks = [];
                    res.on('data', chunk => chunks.push(chunk));
                    res.on('end', () => resolve(Buffer.concat(chunks)));
                });

                req.on('error', () => tryNext());
                req.on('timeout', () => { req.abort(); tryNext(); });
                req.end();
            } catch (e) {
                tryNext();
            }
        }

        tryNext();
    });
}

async function getOrFetchSegment(segUrl) {
    if (RAM_SEGMENT_CACHE.has(segUrl)) {
        return { buf: RAM_SEGMENT_CACHE.get(segUrl), fromCache: true };
    }
    if (IN_FLIGHT_SEGMENTS.has(segUrl)) {
        const buf = await IN_FLIGHT_SEGMENTS.get(segUrl);
        return { buf, fromCache: true };
    }

    const p = fetchSegmentBinary(segUrl).then(buf => {
        IN_FLIGHT_SEGMENTS.delete(segUrl);
        // Evict oldest if exceeding RAM budget
        while (TOTAL_CACHE_BYTES + buf.length > MAX_CACHE_BYTES && RAM_SEGMENT_CACHE.size > 0) {
            const oldestKey = RAM_SEGMENT_CACHE.keys().next().value;
            const oldBuf = RAM_SEGMENT_CACHE.get(oldestKey);
            TOTAL_CACHE_BYTES -= (oldBuf ? oldBuf.length : 0);
            RAM_SEGMENT_CACHE.delete(oldestKey);
        }
        RAM_SEGMENT_CACHE.set(segUrl, buf);
        TOTAL_CACHE_BYTES += buf.length;
        return buf;
    }).catch(err => {
        IN_FLIGHT_SEGMENTS.delete(segUrl);
        throw err;
    });

    IN_FLIGHT_SEGMENTS.set(segUrl, p);
    const buf = await p;
    return { buf, fromCache: false };
}

function triggerPrefetchNext(currentUrl, count = 5) {
    if (!CURRENT_PLAYLIST_SEGMENTS || CURRENT_PLAYLIST_SEGMENTS.length === 0) return;
    const idx = CURRENT_PLAYLIST_SEGMENTS.indexOf(currentUrl);
    if (idx === -1) return;

    const start = idx + 1;
    const end = Math.min(CURRENT_PLAYLIST_SEGMENTS.length, start + count);
    for (let i = start; i < end; i++) {
        const nextUrl = CURRENT_PLAYLIST_SEGMENTS[i];
        if (!RAM_SEGMENT_CACHE.has(nextUrl) && !IN_FLIGHT_SEGMENTS.has(nextUrl)) {
            getOrFetchSegment(nextUrl).catch(() => {});
        }
    }
}

// Caches with TTL to preserve RAM and prevent excessive network queries
const STREAM_CACHE = new Map();
const POPULAR_CACHE = { data: null, ts: 0 };
const RECENT_CACHE = { data: null, ts: 0 };
const CATALOG_CACHE = new Map(); // max 60 entries
const SEARCH_CACHE = new Map();  // max 40 entries
const ANIME_CACHE = new Map();   // max 100 entries

function fetchText(targetUrl, customHeaders = {}, timeoutMs = 6500) {
    return new Promise((resolve, reject) => {
        try {
            const parsed = url.parse(targetUrl);
            const client = parsed.protocol === 'https:' ? https : http;
            const opts = {
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.path,
                method: 'GET',
                headers: Object.assign({}, HEADERS, customHeaders),
                timeout: timeoutMs
            };

            const req = client.request(opts, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    let redirectUrl = res.headers.location;
                    if (!redirectUrl.startsWith('http')) {
                        redirectUrl = url.resolve(targetUrl, redirectUrl);
                    }
                    return fetchText(redirectUrl, customHeaders, timeoutMs).then(resolve).catch(reject);
                }
                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => resolve(data));
            });

            req.on('error', reject);
            req.on('timeout', () => { req.abort(); reject(new Error('Timeout')); });
            req.end();
        } catch (e) {
            reject(e);
        }
    });
}

function extractStreamFromHtml(html) {
    if (!html) return null;
    let m = html.match(/<source[^>]+src=["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
    if (m) return m[1].replace(/\\\//g, '/');
    m = html.match(/(?:url|file|src)\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
    if (m) return m[1].replace(/\\\//g, '/');
    m = html.match(/["'](https?:\/\/[^"']+\.m3u8(?:\?[^"']*)?)["']/i);
    if (m) return m[1].replace(/\\\//g, '/');
    m = html.match(/https?:\/\/[^\s"'<>]+\.m3u8(?:\?[^\s"'<>]*)?/i);
    if (m) return m[0].replace(/\\\//g, '/');
    m = html.match(/(?:url|file|src)\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
    if (m) return m[1].replace(/\\\//g, '/');
    return null;
}

// ==============================================================================
// 3. CATALOG & DISCOVERY ENGINES ($0.00 USD ON-DEVICE)
// ==============================================================================

async function getPopularAnimes() {
    const now = Date.now();
    if (POPULAR_CACHE.data && (now - POPULAR_CACHE.ts < 600000)) {
        return POPULAR_CACHE.data;
    }

    try {
        const html = await fetchText('https://jkanime.net/');
        const popRegex = /<div class="card">\s*<a href="https:\/\/jkanime\.net\/([^/]+)\/"><div class="card-img"><img class="card-img-top" src="([^"]+)"[^>]*>.*?data-rank="(\d+)".*?<h5 class="card-title">([^<]+)<\/h5>\s*<div class="card-synopsis[^"]*">([^<]*)<\/div>/g;
        let match;
        const popular = [];
        while ((match = popRegex.exec(html)) !== null) {
            popular.push({
                slug: match[1],
                poster: match[2],
                rank: parseInt(match[3], 10),
                title: match[4].replace(/&quot;/g, '"').trim(),
                synopsis: match[5].replace(/&quot;/g, '"').trim()
            });
        }
        if (popular.length > 0) {
            POPULAR_CACHE.data = popular;
            POPULAR_CACHE.ts = now;
            return popular;
        }
    } catch (e) {
        console.error('[POPULAR] Error scraping jkanime popular:', e.message);
    }

    return POPULAR_CACHE.data || [
        { rank: 1, title: "One Piece", slug: "one-piece", poster: "https://cdn.jkdesa.com/assets/images/animes/image/one-piece.jpg" },
        { rank: 2, title: "Solo Leveling Season 2", slug: "ore-dake-level-up-na-ken-season-2-arise-from-the-shadow", poster: "https://cdn.jkdesa.com/assets/images/animes/image/ore-dake-level-up-na-ken-season-2-arise-from-the-shadow.jpg" },
        { rank: 3, title: "Bleach TYBW Part 3", slug: "bleach-sennen-kessen-hen-soukoku-tan", poster: "https://cdn.jkdesa.com/assets/images/animes/image/bleach-sennen-kessen-hen-soukoku-tan.jpg" },
        { rank: 4, title: "Dandadan", slug: "dandadan", poster: "https://cdn.jkdesa.com/assets/images/animes/image/dandadan.jpg" },
        { rank: 5, title: "Blue Lock vs. U-20", slug: "blue-lock-vs-u-20-japan", poster: "https://cdn.jkdesa.com/assets/images/animes/image/blue-lock-vs-u-20-japan.jpg" }
    ];
}

async function getRecentEpisodes() {
    const now = Date.now();
    if (RECENT_CACHE.data && (now - RECENT_CACHE.ts < 300000)) { // 15 mins cache
        return RECENT_CACHE.data;
    }

    try {
        const html = await fetchText('https://jkanime.net/');
        const aMatches = html.match(/<a[^>]+href=["']https:\/\/jkanime\.net\/[a-zA-Z0-9\-]+\/\d+\/?["'][^>]*>[\s\S]*?<\/a>/g) || [];
        const recent = [];
        for (const block of aMatches) {
            const mSlug = block.match(/href=["']https:\/\/jkanime\.net\/([a-zA-Z0-9\-]+)\/(\d+)\/?["']/);
            const mTitle = block.match(/<h5[^>]*>(.*?)<\/h5>/);
            const mPic = block.match(/data-animepic=["']([^"']+)["']/) || block.match(/src=["']([^"']+)["']/);
            if (mSlug && mTitle) {
                const slug = mSlug[1];
                const ep = mSlug[2];
                const title = mTitle[1].replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').trim();
                const poster = mPic ? mPic[1] : `https://cdn.jkdesa.com/assets/images/animes/image/${slug}.jpg`;
                if (!recent.some(r => r.slug === slug) && !['directorio', 'horario', 'top'].some(x => slug.includes(x))) {
                    recent.push({ title, slug, latest_ep: ep, poster });
                }
            }
        }
        if (recent.length > 0) {
            RECENT_CACHE.data = recent;
            RECENT_CACHE.ts = now;
            return recent;
        }
    } catch (e) {
        console.error('[RECENT] Error scraping jkanime recent:', e.message);
    }

    return RECENT_CACHE.data || [
        { title: "Dragon Ball Daima", slug: "dragon-ball-daima", latest_ep: "3", poster: "https://cdn.jkdesa.com/assets/images/animes/image/dragon-ball-daima.jpg" },
        { title: "Bleach TYBW Part 3", slug: "bleach-sennen-kessen-hen-soukoku-tan", latest_ep: "4", poster: "https://cdn.jkdesa.com/assets/images/animes/image/bleach-sennen-kessen-hen-soukoku-tan.jpg" },
        { title: "Seitokai ni mo Ana wa Aru!", slug: "seitokai-ni-mo-ana-wa-aru", latest_ep: "5", poster: "https://cdn.jkdesa.com/assets/images/animes/image/seitokai-ni-mo-ana-wa-aru.jpg" }
    ];
}

async function getCatalogPage(page = 1, filtro = 'popularidad', genero = '', tipo = '', estado = '') {
    const p = Math.max(1, parseInt(page, 10) || 1);
    const cacheKey = `${p}_${filtro}_${genero}_${tipo}_${estado}`;
    const now = Date.now();

    const cached = CATALOG_CACHE.get(cacheKey);
    if (cached && (now - cached.ts < 900000)) {
        return cached.data;
    }

    const queryParts = [`p=${p}`];
    if (filtro) queryParts.push(`filtro=${encodeURIComponent(filtro)}`);
    if (genero) queryParts.push(`genero=${encodeURIComponent(genero)}`);
    if (tipo) queryParts.push(`tipo=${encodeURIComponent(tipo)}`);
    if (estado) queryParts.push(`estado=${encodeURIComponent(estado)}`);

    const targetUrl = `https://jkanime.net/directorio?${queryParts.join('&')}`;

    try {
        const html = await fetchText(targetUrl);
        const match = html.match(/var\s+animes\s*=\s*(\{.*?\});\s*(?:var|\n)/s);
        if (match) {
            const raw = JSON.parse(match[1]);
            const cleaned = (raw.data || []).map(a => ({
                id: a.slug || String(a.id),
                slug: a.slug || '',
                title: a.title || '',
                synopsis: a.synopsis || '',
                poster: a.image || `https://cdn.jkdesa.com/assets/images/animes/image/${a.slug}.jpg`,
                studio: a.studios || '',
                type: a.type || 'TV',
                status: a.estado || 'Finalizado'
            }));

            const result = {
                current_page: raw.current_page || p,
                last_page: raw.last_page || 169,
                total: raw.total || 5059,
                filtro: filtro,
                genero: genero,
                tipo: tipo,
                estado: estado,
                animes: cleaned
            };

            if (CATALOG_CACHE.size > 80) {
                const firstKey = CATALOG_CACHE.keys().next().value;
                CATALOG_CACHE.delete(firstKey);
            }
            CATALOG_CACHE.set(cacheKey, { data: result, ts: now });
            return result;
        }
    } catch (e) {
        console.error(`[CATALOG] Error fetching catalog page ${p}:`, e.message);
    }

    return {
        current_page: p,
        last_page: 169,
        total: 5059,
        filtro: filtro,
        genero: genero,
        tipo: tipo,
        estado: estado,
        animes: []
    };
}

async function searchAnimes(query) {
    if (!query || !query.trim()) return [];
    const q = query.trim();
    const cacheKey = q.toLowerCase();
    const now = Date.now();

    const cached = SEARCH_CACHE.get(cacheKey);
    if (cached && (now - cached.ts < 3600000)) {
        return cached.data;
    }

    try {
        const searchUrl = `https://jkanime.net/buscar/${encodeURIComponent(q)}/`;
        const html = await fetchText(searchUrl);
        const pattern = /<div class="anime__item">[\s\S]*?<a\s+href="https:\/\/jkanime\.net\/([^/]+)\/"[\s\S]*?data-setbg="([^"]+)"[\s\S]*?<h5><a[^>]*>(.*?)<\/a><\/h5>/g;
        let m;
        const results = [];
        while ((m = pattern.exec(html)) !== null) {
            results.push({
                slug: m[1],
                poster: m[2],
                title: m[3].replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').trim(),
                type: 'TV',
                status: 'Finalizado'
            });
        }

        if (SEARCH_CACHE.size > 50) {
            const firstKey = SEARCH_CACHE.keys().next().value;
            SEARCH_CACHE.delete(firstKey);
        }
        SEARCH_CACHE.set(cacheKey, { data: results, ts: now });
        return results;
    } catch (e) {
        console.error(`[SEARCH] Error searching for "${q}":`, e.message);
        return [];
    }
}

async function getAnimeDetails(slug) {
    if (!slug) return { slug: '', title: '', synopsis: '', episodes_count: 12 };

    if (slug === 'ninku') {
        return {
            slug: 'ninku',
            title: 'NINKU -忍空-',
            synopsis: 'Ambientada tras la caída del Shogunato en la Era Edo/Meiji ficticia, Fuusuke es un niño de apariencia infantil pero un temible maestro del Ninku (un arte marcial que combina las técnicas ninja con el kárate y el control elemental del viento). Como ex-capitán del Primer Cuerpo Ninku (Fūsuke del Viento), viaja por el país en busca de sus antiguos camaradas capitanes (Aicho y Tōji) para defender a los indefensos de los remanentes corruptos del Ejército Imperial.',
            episodes_count: 55,
            poster: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx912-3uK0m0NF29Br.jpg',
            genres: ['Acción', 'Aventura', 'Shounen', 'Artes Marciales'],
            studio: 'Studio Pierrot'
        };
    }

    let normalizedSlug = slug;
    if (slug === 'mushoku') normalizedSlug = 'mushoku-tensei-isekai-ittara-honki-dasu';
    if (slug === 'black_clover') normalizedSlug = 'black-clover-tv';

    const now = Date.now();
    const cached = ANIME_CACHE.get(normalizedSlug);
    if (cached && (now - cached.ts < 7200000)) {
        return cached.data;
    }

    try {
        const detailUrl = `https://jkanime.net/${normalizedSlug}/`;
        const html = await fetchText(detailUrl);

        // 1. Title
        const tm = html.match(/<meta property=["']og:title["']\s+content=["'](.*?)["']/);
        const title = tm ? tm[1].replace(/\s*-\s*anime\s+.*$/i, '').trim() : normalizedSlug.replace(/-/g, ' ');

        // 2. Synopsis
        const pm = html.match(/<p\s+class=["']scroll["'][^>]*>([\s\S]*?)<\/p>/);
        const synopsis = pm ? pm[1].replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').trim() : '';

        // 3. Episodes
        const epm = html.match(/<span>Episodios:<\/span>\s*([^<]+)/);
        let eps_count = epm ? parseInt(epm[1].trim(), 10) : 12;
        if (isNaN(eps_count) || eps_count === 0) {
            const links = html.match(new RegExp(`${normalizedSlug}/(\\d+)/`, 'g')) || [];
            const nums = links.map(l => parseInt(l.split('/')[1], 10)).filter(n => !isNaN(n));
            if (nums.length > 0) eps_count = Math.max(...nums);
            else eps_count = 12;
        }

        // 4. Poster
        const postm = html.match(/<meta property="og:image" content="(.*?)"/);
        const poster = postm ? postm[1] : `https://cdn.jkdesa.com/assets/images/animes/image/${normalizedSlug}.jpg`;

        // 5. Genres
        const genm = html.match(/<a href=["']https:\/\/jkanime\.net\/genero\/[^/]+\/["']>([^<]+)<\/a>/g) || [];
        const genres = genm.map(g => g.replace(/<[^>]+>/g, '').trim());

        // 6. Studio
        const stum = html.match(/<span>Studios:<\/span>\s*<a[^>]*>([^<]+)<\/a>/);
        const studio = stum ? stum[1].trim() : '';

        const data = {
            slug: normalizedSlug,
            title: title,
            synopsis: synopsis,
            episodes_count: eps_count,
            poster: poster,
            genres: genres,
            studio: studio
        };

        if (ANIME_CACHE.size > 120) {
            const firstKey = ANIME_CACHE.keys().next().value;
            ANIME_CACHE.delete(firstKey);
        }
        ANIME_CACHE.set(normalizedSlug, { data, ts: now });
        return data;
    } catch (e) {
        console.error(`[ANIME_DETAIL] Error fetching details for ${slug}:`, e.message);
        return {
            slug: slug,
            title: slug.replace(/-/g, ' '),
            synopsis: 'Sinopsis no disponible temporalmente.',
            episodes_count: 12,
            poster: `https://cdn.jkdesa.com/assets/images/animes/image/${slug}.jpg`,
            genres: [],
            studio: ''
        };
    }
}

function proxyTmdbRequest(subpath, queryStr) {
    let finalQuery = queryStr || '';
    if (!finalQuery.includes('language=')) {
        finalQuery += (finalQuery ? '&' : '') + 'language=es-MX';
    }
    return new Promise((resolve, reject) => {
        const fullPath = `/api/tmdb/${subpath}?${finalQuery}`;
        const opts = {
            hostname: 'nabby.pro',
            port: 443,
            path: fullPath,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            },
            timeout: 8000
        };

        const req = https.request(opts, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        });

        req.on('error', reject);
        req.on('timeout', () => { req.abort(); reject(new Error('TMDB Proxy Timeout')); });
        req.end();
    });
}

const TMDB_STREAM_CACHE = new Map();


// ==============================================================================
// SUB-ALIGNER BRIDGE: subtitulos sincronizados con el audio real (estrategia Ninku generalizada)
// El Mac ejecuta el alineador (Whisper local) y publica el .vtt aqui via POST /api/subtitles/upload.
// ==============================================================================
let ALIGNER_CFG = {};
try { ALIGNER_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'aligner.json'), 'utf8')); } catch (e0) {}
const ALIGNER_HOST = process.env.ALIGNER_HOST || ALIGNER_CFG.host || '192.168.128.5';
const ALIGNER_PORT = parseInt(process.env.ALIGNER_PORT || ALIGNER_CFG.port || 9098, 10);
const ALIGN_TRIGGERED = {};

function alignedName(type, id, s, e) {
    return `auto_${type}_${id}_${s}_${e}.vtt`;
}

function isCorruptedSubFile(p) {
    try {
        const sample = fs.readFileSync(p, 'utf8').slice(0, 4000);
        // Detectar mojibake árabe/persa (UTF-8 leído como Windows-1256) o archivos vacíos
        if (/[\u0600-\u06FF]/.test(sample) || !sample.includes('-->')) return true;
        return false;
    } catch(e) { return true; }
}

function decorateWithAligned(data, id, type, s, e, reqHost) {
    if (!data || data.status !== 'ok') return data;
    // Si la pista ya viene en Español nativo (Cuevana3c Latino / Castellano), suprimir subtítulos
    if (data.audio_es) {
        return Object.assign({}, data, { aligned: false, sub_es: null, subtitles: [] });
    }
    const out = Object.assign({}, data);
    const name = alignedName(type, id, s, e);
    const p = path.join(SUBTITLES_DIR, name);
    out.aligned = false;
    if (fs.existsSync(p) && !isCorruptedSubFile(p)) {
        const url0 = `http://${reqHost}/subtitles/${name}`;
        out.aligned = true;
        out.aligned_url = url0;
        out.sub_es = url0;
        const cleanExisting = (data.subtitles || []).filter(sub => sub.url !== url0);
        out.subtitles = [{ url: url0, label: '🎯 Español (Sincronizado con audio)', lang: 'es', language: 'es', format: 'vtt', isDefault: true }]
            .concat(cleanExisting);
    }
    return out;
}

function alignerRequest(pathAndQuery, timeoutMs, cb) {
    const req = http.get({ hostname: ALIGNER_HOST, port: ALIGNER_PORT, path: pathAndQuery, timeout: timeoutMs }, (r) => {
        let b = '';
        r.on('data', (c) => { b += c; });
        r.on('end', () => { try { cb(null, JSON.parse(b)); } catch (er) { cb(er); } });
    });
    req.on('error', (er) => cb(er));
    req.on('timeout', () => { req.abort(); cb(new Error('aligner timeout')); });
}

function triggerAlign(id, type, s, e, streamUrl) {
    const key = `${type}_${id}_${s}_${e}`;
    const now = Date.now();
    if (ALIGN_TRIGGERED[key] && now - ALIGN_TRIGGERED[key] < 120000) return;
    ALIGN_TRIGGERED[key] = now;
    const q = `/align?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}&s=${encodeURIComponent(s)}&e=${encodeURIComponent(e)}&stream=${encodeURIComponent(streamUrl)}`;
    alignerRequest(q, 4000, (err, r) => {
        console.log('[ALIGNER] trigger', key, err ? ('error: ' + err.message) : JSON.stringify(r).slice(0, 160));
    });
}

function scoreTmdbSource(s, originalLang) {
    originalLang = (originalLang || 'en').toLowerCase();
    const server = (s.server || '').toLowerCase();
    const quality = (s.quality || '').toLowerCase();
    const label = `${server} ${quality}`;

    // REGLA DE ORO LINGÜÍSTICA:
    // Penalización severa a audios doblados en idiomas índicos (Hindi, Telugu, Tamil, etc.)
    // a menos que la obra original sea de la India.
    const indicLangs = ['hindi', 'telugu', 'tamil', 'malayalam', 'kannada', 'bengali', 'marathi', 'punjabi', 'urdu'];
    const isIndic = indicLangs.some(w => label.includes(w));
    if (isIndic && !['hi', 'te', 'ta', 'ml', 'kn', 'bn', 'mr', 'pa', 'ur'].includes(originalLang)) {
        return -1000;
    }

    let score = 0;
    // 1. Audio doblado en Español (Máxima prioridad para usuario hispanohablante)
    if (['spanish', 'español', 'castellano', 'latino', 'es-es', 'es-mx'].some(w => label.includes(w))) {
        score += 500;
    }
    // 2. Audio en idioma original (Inglés / VO / Original)
    if (['english', 'inglés', 'eng', 'original', 'org', 'vo'].some(w => label.includes(w))) {
        score += 300;
    } else if (!isIndic) {
        score += 200; // Servidores estándar globales limpios (PrimeVids, FastCloud, Titan, etc.)
    }

    // Resolución
    if (label.includes('1080') || quality.includes('1080')) score += 50;
    else if (label.includes('720') || quality.includes('720')) score += 20;

    // Estabilidad directa de contenedor
    if (s.type === 'mp4') score += 15;
    return score;
}


function extractSourceFilenameTitle(sourceUrl) {
    if (!sourceUrl) return null;
    try {
        const decoded = decodeURIComponent(sourceUrl).replace(/\+/g, ' ');
        const m = decoded.match(/\/(?:movie|tv)\/[0-9a-f\-]{20,}\/([^/?&#]+)/i);
        if (m && m[1]) {
            return m[1].replace(/\(\d{4}\)/g, '').replace(/[^a-zA-Z0-9\u00C0-\u017F\s]/g, ' ').replace(/\s+/g, ' ').trim();
        }
    } catch(e) {}
    return null;
}

function isSourceTitleMismatch(sourceUrl, expectedTitles) {
    const fileTitle = extractSourceFilenameTitle(sourceUrl);
    if (!fileTitle || !expectedTitles || expectedTitles.length === 0) return false;
    const stopWords = ['the', 'and', 'for', 'with', 'part', 'movie', 'film', 'del', 'las', 'los', 'una', 'uno', 'por', 'con', 'para'];
    const getWords = (str) => String(str || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 3 && !stopWords.includes(w));

    const fileWords = getWords(fileTitle);
    if (fileWords.length === 0) return false;

    for (let i = 0; i < expectedTitles.length; i++) {
        const expWords = getWords(expectedTitles[i]);
        if (expWords.length === 0) continue;
        const hasOverlap = fileWords.some(fw => expWords.some(ew => fw === ew || (fw.length >= 4 && ew.includes(fw)) || (ew.length >= 4 && fw.includes(ew))));
        if (hasOverlap) return false;
    }
    return true;
}

function resolveVixsrcStream(id, type, s, e, reqHost = '127.0.0.1:9099') {
    return new Promise((resolve) => {
        const isTv = type === 'tv' || (s !== null && e !== null && type !== 'movie');
        const apiUrlStr = isTv ? `https://vixsrc.to/api/tv/${id}/${s}/${e}` : `https://vixsrc.to/api/movie/${id}`;
        const refUrl = isTv ? `https://vixsrc.to/tv/${id}/${s}/${e}` : `https://vixsrc.to/movie/${id}`;
        
        const parsedApi = url.parse(apiUrlStr);
        const opts = {
            hostname: parsedApi.hostname,
            port: 443,
            path: parsedApi.path,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36',
                'Referer': refUrl
            },
            timeout: 5000
        };

        const req = https.request(opts, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', async () => {
                try {
                    const json = JSON.parse(data);
                    const embedPath = json.src || json.embed;
                    if (!embedPath) return resolve(null);
                    const embedUrl = 'https://vixsrc.to' + embedPath;
                    const parsedEmbed = url.parse(embedUrl);
                    
                    const opts2 = {
                        hostname: parsedEmbed.hostname,
                        port: 443,
                        path: parsedEmbed.path,
                        method: 'GET',
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36',
                            'Referer': refUrl
                        },
                        timeout: 5000
                    };

                    const req2 = https.request(opts2, (res2) => {
                        let html = '';
                        res2.on('data', c => { html += c; });
                        res2.on('end', async () => {
                            const mToken = html.match(/['"]token['"]\s*:\s*['"]([^'"]+)['"]/);
                            const mExpires = html.match(/['"]expires['"]\s*:\s*['"]([^'"]+)['"]/);
                            const mUrl = html.match(/url\s*:\s*['"](https?:\/\/[^'"]+)['"]/);
                            if (mToken && mExpires && mUrl) {
                                const masterUrl = `${mUrl[1]}?token=${mToken[1]}&expires=${mExpires[1]}&h=1`;
                                // Extraer subtítulos embebidos en el manifiesto HLS de VixSrc (Español o Inglés para traducir)
                                const vixSubs = [];
                                try {
                                    const m3u8Text = await fetchText(masterUrl, { 'Referer': 'https://vixsrc.to/' }, 4000);
                                    const subLines = m3u8Text.split('\n').filter(l => l.includes('TYPE=SUBTITLES') && l.includes('URI="'));
                                    for (let sl of subLines) {
                                        const mLang = sl.match(/LANGUAGE="([^"]+)"/i);
                                        const mName = sl.match(/NAME="([^"]+)"/i);
                                        const mUri = sl.match(/URI="([^"]+)"/i);
                                        if (mUri && mUri[1]) {
                                            const lCode = (mLang ? mLang[1] : '').toLowerCase();
                                            const lName = (mName ? mName[1] : '').toLowerCase();
                                            if (lCode.includes('es') || lCode.includes('spa') || lName.includes('span') || lName.includes('espa') || lCode.includes('en') || lName.includes('eng')) {
                                                const subPl = await fetchText(mUri[1], { 'Referer': 'https://vixsrc.to/' }, 3500);
                                                const vttMatch = subPl.match(/https?:\/\/[^\s"']+\.vtt(?:\?[^\s"']*)?/i);
                                                if (vttMatch) {
                                                    const isEsTrack = lCode.includes('es') || lCode.includes('spa') || lName.includes('span') || lName.includes('espa');
                                                    vixSubs.push({
                                                        url: isEsTrack ? `http://${reqHost}/api/sub_proxy?url=${encodeURIComponent(vttMatch[0])}` : `http://${reqHost}/api/sub_translate?url=${encodeURIComponent(vttMatch[0])}`,
                                                        raw_url: vttMatch[0],
                                                        label: isEsTrack ? `⚡ Español (VixSrc Master)` : `🧠 Español (Traductor Neuronal VixSrc)`,
                                                        lang: 'es',
                                                        language: 'es',
                                                        format: 'vtt',
                                                        source: isEsTrack ? 'vixsrc_es' : 'vixsrc_neural',
                                                        priority: isEsTrack ? 98 : 85
                                                    });
                                                    if (isEsTrack) break;
                                                }
                                            }
                                        }
                                    }
                                } catch(eVixSub) {}

                                return resolve({
                                    status: 'ok',
                                    id: id,
                                    type: type,
                                    season: s,
                                    episode: e,
                                    direct_stream_url: masterUrl,
                                    quality: '1080p',
                                    format: 'hls',
                                    server: 'VixSrc Clean VO Master',
                                    audio_es: false,
                                    orig_lang: 'en',
                                    vix_subs: vixSubs
                                });
                            }
                            resolve(null);
                        });
                    });
                    req2.on('error', () => resolve(null));
                    req2.on('timeout', () => { req2.abort(); resolve(null); });
                    req2.end();
                } catch(e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.abort(); resolve(null); });
        req.end();
    });
}


function isStrictSpanishCode(str) {
    if (!str) return false;
    const s = String(str).toLowerCase().trim();
    if (['es', 'spa', 'spl', 'spn', 'es-es', 'es-mx', 'es-419', 'es-la', 'es-ar', 'es-co', 'español', 'espanol', 'spanish', 'castellano', 'latino'].includes(s)) {
        return true;
    }
    return /(?:^|[^a-z])(?:spa|spl|spn|es(?:-[a-z0-9]+)?|espa[ñn]ol|spanish|castellano|latino)(?:$|[^a-z])/i.test(s);
}

function isSpanishSubItem(sub) {
    if (!sub) return false;
    return isStrictSpanishCode(sub.lang) || isStrictSpanishCode(sub.language) || isStrictSpanishCode(sub.label);
}

function isEnglishSubItem(sub) {
    if (!sub) return false;
    const l = ((sub.lang || '') + ' ' + (sub.language || '') + ' ' + (sub.label || '')).toLowerCase();
    return /(?:^|[^a-z])(?:eng|en(?:-[a-z0-9]+)?|english)(?:$|[^a-z])/i.test(l);
}

function verifySpanishLinguisticText(text) {
    if (!text || text.length < 40) return false;
    // Rechazar corrupción de codificación árabe/persa
    if (/[\u0600-\u06FF]/.test(text.slice(0, 3000))) return false;
    // Extraer muestra de diálogo (saltando marcas de tiempo)
    const sample = text.slice(0, 6000)
        .replace(/WEBVTT/gi, '')
        .replace(/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .toLowerCase();
    // Palabras ancla exclusivas de alta frecuencia en español + signos ¿ ¡ ñ
    const esAnchors = sample.match(/(?:\b(?:que|qué|de|la|el|en|los|las|por|con|una|para|del|está|están|pero|como|cómo|más|todo|todos|bien|aquí|ahora|cuando|cuándo|eso|esto|vamos|puedo|tengo|eres|hola|gracias|señor|sí|también|hacer|algo)\b|[¿¡ñáéíóú])/g);
    const count = esAnchors ? esAnchors.length : 0;
    return count >= 6;
}

function fetchExternalOpenSubtitles(tmdbId, mediaType, s, e, reqHost = '127.0.0.1:9099') {
    return new Promise(async (resolve) => {
        try {
            // 1. Obtener IMDB ID de TMDB (Node 8.12 compatible via fetchText)
            const extUrl = `https://nabby.pro/api/tmdb/${mediaType}/${tmdbId}/external_ids`;
            let imdbId = null;
            try {
                const extRaw = await fetchText(extUrl, {}, 3500);
                const extData = JSON.parse(extRaw);
                imdbId = extData.imdb_id;
            } catch(e) {}

            const targetId = imdbId || tmdbId;
            const isTv = mediaType === 'tv';
            const osUrl = isTv 
                ? `https://opensubtitles-v3.strem.io/subtitles/series/${targetId}:${s}:${e}.json`
                : `https://opensubtitles-v3.strem.io/subtitles/movie/${targetId}.json`;

            const data = await fetchText(osUrl, {}, 4000);
            const json = JSON.parse(data);
            const rawSubs = json.subtitles || [];
            let latinoCounter = 1;
            let espCounter = 1;
            const seenRawUrls = new Set();
            const formatted = [];
            for (let idx = 0; idx < rawSubs.length; idx++) {
                const sub = rawSubs[idx];
                if (!sub || !sub.url || seenRawUrls.has(sub.url)) continue;
                seenRawUrls.add(sub.url);
                const code = (sub.lang || '').toLowerCase().trim();
                const isEs = isStrictSpanishCode(code);
                const isEn = ['eng', 'en'].includes(code);
                // Solo conservar pistas en Español o Inglés (para traducción neuronal si faltara español)
                if (!isEs && !isEn) continue;
                let label = `OpenSubtitles • ${code}`;
                let priority = 10;
                if (isEs) {
                    const isLat = code === 'spl' || code === 'es-mx' || code === 'es-la';
                    if (isLat) {
                        label = `⚡ Español Latino #${latinoCounter++}`;
                        priority = 110 - latinoCounter;
                    } else {
                        label = `⚡ Español #${espCounter++}`;
                        priority = 95 - espCounter;
                    }
                    // Limpiar el tope a máximo 4 variantes por región para no inundar con duplicados
                    if (isLat && latinoCounter > 5) continue;
                    if (!isLat && espCounter > 5) continue;
                }
                const proxiedUrl = `http://${reqHost}/api/sub_proxy?url=${encodeURIComponent(sub.url)}`;
                formatted.push({
                    url: proxiedUrl,
                    raw_url: sub.url,
                    label: label,
                    lang: isEs ? 'es' : 'en',
                    language: isEs ? 'es' : 'en',
                    format: 'vtt',
                    source: 'opensubtitles',
                    priority: priority
                });
            }
            formatted.sort((a, b) => (b.priority || 0) - (a.priority || 0));
            resolve(formatted);
        } catch(ex) { resolve([]); }
    });
}

function rewriteSubHost(data, reqHost) {
    if (!data) return data;
    const out = Object.assign({}, data);
    if (out.sub_es && out.sub_es.includes('/api/sub_')) {
        out.sub_es = out.sub_es.replace(/^http:\/\/[^/]+\//, `http://${reqHost}/`);
    }
    if (Array.isArray(out.subtitles)) {
        out.subtitles = out.subtitles.map(s => {
            const copy = Object.assign({}, s);
            if (copy.url && copy.url.includes('/api/sub_')) {
                copy.url = copy.url.replace(/^http:\/\/[^/]+\//, `http://${reqHost}/`);
            }
            return copy;
        });
    }
    return out;
}

// =========================================================================
// SOBERANO CUEVANA3C NATIVE EXTRACTOR (Audio Español Latino / Castellano HD)
// =========================================================================
const CUEVANA_KEY = 'a45f04ce-2394-47c3-b718-0ecd97ce51d6';
const CUEVANA_SERVERS = {
    '1': 'https://ikhjerbhye3wjkhoduh5xiczuvd.lol/v/',
    '2': 'https://filemoon.sx/e/',
    '3': 'https://lkhjerbhye3wjkhodvh5xlczuvd.lol/e/',
    '4': 'https://dood.li/e/'
};

function decryptCuevanaToken(token) {
    try {
        const prefix = token[0];
        let rawB64 = token.slice(1);
        while (rawB64.length % 4 !== 0) rawB64 += '=';
        const decoded = Buffer.from(rawB64, 'base64').toString('binary');
        let decrypted = '';
        for (let i = 0; i < decoded.length; i++) {
            decrypted += String.fromCharCode(decoded.charCodeAt(i) ^ CUEVANA_KEY.charCodeAt(i % CUEVANA_KEY.length));
        }
        const serverBase = CUEVANA_SERVERS[prefix];
        return serverBase ? (serverBase + decrypted) : null;
    } catch(e) {
        return null;
    }
}

function unpackPackedJS(packedStr) {
    const m = packedStr.match(/}\('(.*)',\s*(\d+),\s*(\d+),\s*'([^']*)'\.split\('\|'\)\)/);
    if (!m) return '';
    let p = m[1];
    const a = parseInt(m[2], 10);
    const c = parseInt(m[3], 10);
    const k = m[4].split('|');
    function baseN(num, b) {
        const digits = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
        let res = '';
        while (num > 0) {
            res = digits[num % b] + res;
            num = Math.floor(num / b);
        }
        return res || '0';
    }
    for (let i = c - 1; i >= 0; i--) {
        const keyChar = baseN(i, a);
        if (i < k.length && k[i]) {
            p = p.replace(new RegExp('\\b' + keyChar + '\\b', 'g'), k[i]);
        }
    }
    return p;
}

async function resolveCuevanaStream(id, type, s, e, reqHost, expectedTitle, expectedOrigTitle) {
    try {
        let titles = [expectedTitle, expectedOrigTitle].filter(Boolean);
        let yearTarget = null;
        if (titles.length === 0 || !yearTarget) {
            try {
                const tmdbRes = await proxyTmdbRequest(type === 'tv' ? `tv/${id}` : `movie/${id}`, 'language=es-MX');
                const tmdbJson = JSON.parse(tmdbRes.body);
                if (tmdbJson.title) titles.push(tmdbJson.title);
                if (tmdbJson.name) titles.push(tmdbJson.name);
                if (tmdbJson.original_title) titles.push(tmdbJson.original_title);
                if (tmdbJson.original_name) titles.push(tmdbJson.original_name);
                const dateStr = tmdbJson.release_date || tmdbJson.first_air_date || '';
                if (dateStr) yearTarget = dateStr.slice(0, 4);
            } catch(e) {}
        }
        titles = Array.from(new Set(titles.filter(Boolean)));
        if (titles.length === 0) return null;

        console.log(`[CUEVANA] Buscando stream para ${id} (${type} S${s}E${e}) con títulos:`, titles, `año:`, yearTarget);

        let matchedPageUrl = null;
        let matchedSlug = null;

        for (const titleQuery of titles) {
            const cleanQuery = titleQuery.replace(/[:\-–—]/g, ' ').trim();
            const searchUrl = `https://cuevana3c.pro/explorar?s=${encodeURIComponent(cleanQuery)}`;
            const searchHtml = await fetchText(searchUrl, { 'Referer': 'https://cuevana3c.pro/' }, 5000);
            
            const cardRegex = /<div class="movie-item">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/div>/g;
            let m;
            const candidates = [];
            while ((m = cardRegex.exec(searchHtml)) !== null) {
                const link = m[1];
                const inner = m[2];
                const isTypeMatch = type === 'tv' ? link.includes('/serie/') : link.includes('/pelicula/');
                if (!isTypeMatch) continue;
                
                const titleM = inner.match(/<p>([^<]+)<\/p>/);
                const yearM = inner.match(/<span class="year[^"]*">([^<]+)<\/span>/);
                const itemTitle = titleM ? titleM[1].trim() : '';
                const itemYear = yearM ? yearM[1].trim() : '';
                
                candidates.push({ link, itemTitle, itemYear });
            }

            if (candidates.length > 0) {
                let best = null;
                if (yearTarget && type === 'movie') {
                    best = candidates.find(c => c.itemYear && c.itemYear.includes(yearTarget));
                }
                if (!best) {
                    best = candidates[0];
                }
                matchedPageUrl = best.link;
                if (type === 'tv') {
                    const slugMatch = matchedPageUrl.match(/\/serie\/([^\/]+)/);
                    if (slugMatch) matchedSlug = slugMatch[1];
                }
                break;
            }
        }

        if (!matchedPageUrl && !matchedSlug) {
            console.log(`[CUEVANA] No se encontró entrada para ${titles[0]}`);
            return null;
        }

        let targetContentUrl = matchedPageUrl;
        if (type === 'tv') {
            targetContentUrl = `https://cuevana3c.pro/serie/${matchedSlug}/episodio-${s}x${e}`;
        }

        console.log(`[CUEVANA] Obteniendo página de reproducción: ${targetContentUrl}`);
        const contentHtml = await fetchText(targetContentUrl, { 'Referer': 'https://cuevana3c.pro/' }, 6000);

        const tabRegex = /<li class="tab-video-item">([\s\S]*?)(?=<li class="tab-video-item">|<\/ul>\s*<\/div>)/g;
        let tabMatch;
        let selectedToken = null;
        let selectedLang = 'Español';

        while ((tabMatch = tabRegex.exec(contentHtml)) !== null) {
            const tabBlock = tabMatch[1];
            const isLatino = /latino|lat\.png/i.test(tabBlock);
            const isCastellano = /castellano|cas\.png/i.test(tabBlock);
            
            if (isLatino || isCastellano) {
                const tokenMatch = tabBlock.match(/data-server="https:\/\/tungtungsahur\.cuevana3c\.pro\/\?token=([^"]+)"/);
                if (tokenMatch) {
                    selectedToken = tokenMatch[1];
                    selectedLang = isLatino ? 'Latino' : 'Castellano';
                    break;
                }
            }
        }

        if (!selectedToken) {
            const anyTokenMatch = contentHtml.match(/data-server="https:\/\/tungtungsahur\.cuevana3c\.pro\/\?token=([^"]+)"/);
            if (anyTokenMatch) {
                selectedToken = anyTokenMatch[1];
                selectedLang = 'Audio';
            }
        }

        if (!selectedToken) {
            console.log(`[CUEVANA] No se encontraron tokens válidos en ${targetContentUrl}`);
            return null;
        }

        const embedUrl = decryptCuevanaToken(selectedToken);
        console.log(`[CUEVANA] Token desencriptado (${selectedLang}): ${embedUrl}`);
        if (!embedUrl) return null;

        if (embedUrl.includes('ikhjerbhye3wjkhoduh5xiczuvd.lol') || embedUrl.includes('lkhjerbhye3wjkhodvh5xlczuvd.lol')) {
            const embedHtml = await fetchText(embedUrl, { 'Referer': 'https://tungtungsahur.cuevana3c.pro/' }, 6000);
            const packedMatch = embedHtml.match(/eval\(function\(p,a,c,k,e,d\)[\s\S]*?\.split\('\|'\)\)\)/);
            if (packedMatch) {
                const unpacked = unpackPackedJS(packedMatch[0]);
                const m3u8Match = unpacked.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]+/);
                if (m3u8Match) {
                    const directM3u8 = m3u8Match[0];
                    console.log(`[CUEVANA SUCCESS] Stream m3u8 nativo obtenido en Español ${selectedLang}:`, directM3u8);
                    return {
                        status: 'ok',
                        id: id,
                        type: type,
                        season: s,
                        episode: e,
                        direct_stream_url: directM3u8,
                        quality: '1080p',
                        format: 'hls',
                        server: `Cuevana3c ${selectedLang} HD`,
                        audio_es: true,
                        sub_es: null,
                        subtitles: []
                    };
                }
            }
        }

        return null;
    } catch(err) {
        console.error(`[CUEVANA ERROR] ${err.message}`);
        return null;
    }
}

async function resolveTmdbStream(id, type = 'movie', s = 1, e = 1, reqHost = '127.0.0.1:9099', origLang = 'en', expectedTitle = '', expectedOrigTitle = '') {
    const cacheKey = `${id}_${type}_${s}_${e}`;
    const now = Date.now();
    const cached = TMDB_STREAM_CACHE.get(cacheKey);
    if (cached && (now - cached.ts < 7200000)) {
        return decorateWithAligned(rewriteSubHost(cached.data, reqHost), id, type, s, e, reqHost);
    }

    // 1. CUEVANA3C NATIVE EN ROUTE: Prioridad N° 1 para Películas y Series (Español Latino / Castellano HD nativo $0)
    try {
        const cuevanaStream = await resolveCuevanaStream(id, type, s, e, reqHost, expectedTitle, expectedOrigTitle);
        if (cuevanaStream && cuevanaStream.status === 'ok' && cuevanaStream.direct_stream_url) {
            TMDB_STREAM_CACHE.set(cacheKey, { data: cuevanaStream, ts: now });
            return decorateWithAligned(cuevanaStream, id, type, s, e, reqHost);
        }
    } catch (cuevanaErr) {
        console.warn(`[CUEVANA] Fallback activado tras error: ${cuevanaErr.message}`);
    }

    return new Promise((resolve) => {
        const query = type === 'tv' ? (`&season=${s}&episode=${e}`) : '';
        const targetUrl = `https://api.framextv.tech/api/stream?type=${type}&id=${id}${query}`;
        const parsed = url.parse(targetUrl);
        const opts = {
            hostname: parsed.hostname,
            port: 443,
            path: parsed.path,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 8000
        };

        // Lanzar federación de OpenSubtitles en paralelo desde el milisegundo 0
        const osPromise = fetchExternalOpenSubtitles(id, type, s, e, reqHost).catch(() => []);
        // Obtener títulos canónicos de TMDB si no fueron enviados por el cliente (para validación de homónimos en Películas)
        const titlesPromise = (type === 'movie' && !expectedTitle && !expectedOrigTitle)
            ? proxyTmdbRequest(`movie/${id}`, 'language=es-MX').then(r => {
                try {
                    const j = JSON.parse(r.body);
                    return [j.title, j.original_title].filter(Boolean);
                } catch(e) { return []; }
            }).catch(() => [])
            : Promise.resolve([expectedTitle, expectedOrigTitle].filter(Boolean));

        const req = https.request(opts, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', async () => {
                try {
                    const json = JSON.parse(data);
                    const canonicalTitles = await titlesPromise;
                    if (json.success && json.sources && json.sources.length > 0) {
                        // SOBERANO AUDIO CURATOR + UNIVERSAL HOMONYM SHIELD (Películas):
                        // Penalizar severamente (-800) cualquier fuente de films365 cuyo nombre de archivo sea otra película distinta
                        const scoreWithTitleGuard = (src) => {
                            let base = scoreTmdbSource(src, origLang);
                            if (type === 'movie' && canonicalTitles.length > 0 && isSourceTitleMismatch(src.url, canonicalTitles)) {
                                base -= 800;
                            }
                            return base;
                        };
                        const sortedSources = json.sources.slice().sort((a, b) => scoreWithTitleGuard(b) - scoreWithTitleGuard(a));
                        const chosenSource = sortedSources[0];
                        const directUrl = chosenSource.url;
                        const streamUrlLower = (chosenSource.url || '').toLowerCase();
                        const labelLower = (chosenSource.server + ' ' + chosenSource.quality).toLowerCase();
                        // SOBERANO INTEGRITY GUARD: Detección estricta de falsos homónimos
                        const streamName = (chosenSource.url || '').toLowerCase();
                        if (id == '1657630' && streamName.includes('the+awakening')) {
                            console.warn(`[INTEGRITY GUARD] Bloqueado falso homónimo para ID 1657630: la película está en cines y el servidor devuelve The Awakening (2011).`);
                            return resolve({
                                status: 'cinema_exclusive',
                                id: id,
                                type: type,
                                title: 'El despertar (2026)',
                                message: '🎬 Esta película está actualmente en cines físicos y aún no cuenta con copia digital oficial. Los servidores externos devolvían por error la película británica homónima "The Awakening (2011)". Se ha bloqueado la reproducción para evitar confusiones.'
                            });
                        }

                        const isExplicitSpanish = ['spanish', 'español', 'castellano', 'latino', 'lat'].some(w => labelLower.includes(w) || streamUrlLower.includes(w));
                        const isEnglishTrack = ['english', 'inglés', 'eng'].some(w => labelLower.includes(w)) || streamUrlLower.includes('the+awakening') || (chosenSource.url || '').includes('films365.org');
                        const isAudioSpanish = isExplicitSpanish || (origLang === 'es' && !isEnglishTrack);

                        // Unificar subtítulos de OpenSubtitles (Cloudflare <50ms) + Framex (respaldo)
                        const osSubs = await osPromise;
                        const rawFramexSubs = (json.subtitles || []).map((sub, idx) => {
                            const isEs = isSpanishSubItem(sub);
                            const rawUrl = sub.url || '';
                            const proxied = rawUrl.startsWith('http://127.0.0.1') ? rawUrl : `http://${reqHost}/api/sub_proxy?url=${encodeURIComponent(rawUrl)}`;
                            return {
                                url: proxied,
                                raw_url: rawUrl,
                                label: sub.label || (isEs ? `Español Servidor #${idx + 1}` : (sub.lang || 'Sub')),
                                lang: isEs ? 'es' : (sub.lang || sub.language || 'en'),
                                language: isEs ? 'es' : (sub.language || sub.lang || 'en'),
                                format: 'vtt',
                                source: 'framex',
                                priority: isEs ? 50 - idx : 5
                            };
                        });

                        // Priorizar OpenSubtitles CF primero y deduplicar URLs repetidas
                        const seenSubUrls = new Set();
                        let subs = [];
                        osSubs.concat(rawFramexSubs).forEach(sItem => {
                            const key = sItem.raw_url || sItem.url;
                            if (key && !seenSubUrls.has(key)) {
                                seenSubUrls.add(key);
                                subs.push(sItem);
                            }
                        });
                        let esSubsList = subs.filter(isSpanishSubItem);
                        let esSub = esSubsList.length > 0 ? esSubsList[0] : null;

                        // Si no existe ningún subtítulo en español pero sí en inglés, activar Traductor Neuronal On-The-Fly ($0)
                        if (!esSub) {
                            const enSub = subs.find(isEnglishSubItem) || subs[0];
                            if (enSub && (enSub.raw_url || enSub.url)) {
                                const srcSubUrl = enSub.raw_url || enSub.url;
                                const transUrl = `http://${reqHost}/api/sub_translate?url=${encodeURIComponent(srcSubUrl)}`;
                                const neuralTrack = {
                                    url: transUrl,
                                    label: '🧠 Español (Traducción Neuronal Automática)',
                                    lang: 'es',
                                    language: 'es',
                                    format: 'vtt',
                                    source: 'neural_translator',
                                    priority: 80
                                };
                                subs.unshift(neuralTrack);
                                esSub = neuralTrack;
                                esSubsList = [neuralTrack];
                            }
                        }

                        // Purgar pistas en otros idiomas: devolver al reproductor exclusivamente pistas en Español limpias y deduplicadas
                        subs = esSubsList;

                        const result = {
                            status: 'ok',
                            id: id,
                            type: type,
                            season: s,
                            episode: e,
                            direct_stream_url: directUrl,
                            quality: chosenSource.quality || '1080p',
                            format: chosenSource.type || 'mp4',
                            server: chosenSource.server || '',
                            audio_es: isAudioSpanish,
                            orig_lang: origLang,
                            sub_es: esSub ? esSub.url : null,
                            subtitles: subs
                        };
                        const topScore = scoreWithTitleGuard(sortedSources[0]);
                        if (topScore <= -400) {
                            console.log(`[MOVIE/AUDIO SHIELD] Fuentes de Framex descartadas (score=${topScore}) para ${id} (${type}). Conmutando a VixSrc VO...`);
                            resolveVixsrcStream(id, type, s, e, reqHost).then(vixData => {
                                if (vixData) {
                                    const vixExtraSubs = vixData.vix_subs || [];
                                    const mergedSubs = subs.filter(isSpanishSubItem).length > 0 ? subs : vixExtraSubs.concat(subs);
                                    const bestEs = mergedSubs.find(isSpanishSubItem) || esSub;
                                    vixData.subtitles = mergedSubs;
                                    vixData.sub_es = bestEs ? bestEs.url : null;
                                    TMDB_STREAM_CACHE.set(cacheKey, { data: vixData, ts: now });
                                    return resolve(decorateWithAligned(vixData, id, type, s, e, reqHost));
                                }
                                TMDB_STREAM_CACHE.set(cacheKey, { data: result, ts: now });
                                return resolve(decorateWithAligned(result, id, type, s, e, reqHost));
                            });
                            return;
                        }
                        TMDB_STREAM_CACHE.set(cacheKey, { data: result, ts: now });
                        return resolve(decorateWithAligned(result, id, type, s, e, reqHost));
                    }
                    // Si Framex no tuvo fuentes (ej. película/serie en VixSrc), intentar VixSrc + OpenSubtitles + Subtítulos HLS VixSrc
                    const osSubsFallback = await osPromise;
                    const vixFallback = await resolveVixsrcStream(id, type, s, e, reqHost);
                    if (vixFallback) {
                        const vixExtraSubs = vixFallback.vix_subs || [];
                        let allFbSubs = osSubsFallback.concat(vixExtraSubs);
                        let esSubFb = allFbSubs.find(isSpanishSubItem);
                        if (!esSubFb && allFbSubs.length > 0) {
                            const enCand = allFbSubs.find(isEnglishSubItem) || allFbSubs[0];
                            if (enCand && (enCand.raw_url || enCand.url)) {
                                const transUrl = `http://${reqHost}/api/sub_translate?url=${encodeURIComponent(enCand.raw_url || enCand.url)}`;
                                esSubFb = {
                                    url: transUrl,
                                    label: '🧠 Español (Traducción Neuronal Automática)',
                                    lang: 'es',
                                    language: 'es',
                                    format: 'vtt',
                                    source: 'neural_translator'
                                };
                                allFbSubs.unshift(esSubFb);
                            }
                        }
                        vixFallback.subtitles = allFbSubs;
                        vixFallback.sub_es = esSubFb ? esSubFb.url : null;
                        TMDB_STREAM_CACHE.set(cacheKey, { data: vixFallback, ts: now });
                        return resolve(decorateWithAligned(vixFallback, id, type, s, e, reqHost));
                    }
                    resolve({ status: 'fallback', id: id, type: type, message: 'No direct sources found' });
                } catch(err) {
                    resolve({ status: 'error', id: id, message: err.message });
                }
            });
        });
        req.on('error', err => resolve({ status: 'error', id: id, message: err.message }));
        req.on('timeout', () => { req.abort(); resolve({ status: 'timeout', id: id }); });
        req.end();
    });
}

// ==============================================================================
// 4. STREAM EXTRACTION & NATIVE HLS REWRITER
// ==============================================================================

async function resolveJkStream(slug, epNum, reqHost) {
    let normalizedSlug = slug;
    if (slug === 'mushoku') normalizedSlug = 'mushoku-tensei-isekai-ittara-honki-dasu';
    if (slug === 'black_clover') normalizedSlug = 'black-clover-tv';

    const cacheKey = `${normalizedSlug}_${epNum}`;
    const cached = STREAM_CACHE.get(cacheKey);
    if (cached && (Date.now() - cached.time < 3600000)) {
        return cached.data;
    }

    const pageUrl = `https://jkanime.net/${normalizedSlug}/${epNum}/`;
    const servers = [];
    let directM3u8 = null;

    try {
        const pageHtml = await fetchText(pageUrl);
        const iframeMatches = pageHtml.match(/video\[\d+\]\s*=\s*['"]<iframe[^>]*src=['"]([^'"]+)['"]/g) || [];
        const iframes = iframeMatches.map(m => {
            const sm = m.match(/src=['"]([^'"]+)['"]/);
            return sm ? sm[1] : null;
        }).filter(Boolean);

        iframes.sort((a, b) => {
            const scoreA = a.includes('jkplayer/um?') ? 0 : (a.includes('jkplayer/umv?') ? 1 : 2);
            const scoreB = b.includes('jkplayer/um?') ? 0 : (b.includes('jkplayer/umv?') ? 1 : 2);
            return scoreA - scoreB;
        });

        for (const ifr of iframes) {
            let sName = '⚡ Servidor Directo';
            let sType = 'iframe';
            let extracted = null;

            if (ifr.includes('jkplayer/um?')) {
                sName = '⚡ Desu HD (Pre-búfer RAM)';
                sType = 'direct';
            } else if (ifr.includes('jkplayer/umv?')) {
                sName = '⚡ Magi Stream (Pre-búfer RAM)';
                sType = 'direct';
            } else if (ifr.includes('jkplayer/jk?')) {
                sName = '⚡ Direct MP4';
                sType = 'direct';
            }

            if (ifr.includes('jkplayer')) {
                try {
                    const embHtml = await fetchText(ifr);
                    extracted = extractStreamFromHtml(embHtml);
                } catch (e) {}
            }

            const target = extracted || ifr;
            if (extracted && !directM3u8) {
                directM3u8 = extracted;
            }

            const proxiedUrl = `http://${reqHost}/stream.m3u8?url=${encodeURIComponent(target)}&slug=${encodeURIComponent(slug)}&ep=${epNum}`;

            servers.push({
                name: sName,
                url: target,
                stream_url: proxiedUrl,
                type: sType,
                format: (extracted && extracted.includes('.m3u8')) ? 'm3u8' : ((extracted && extracted.includes('.mp4')) ? 'mp4' : 'iframe'),
                embed_url: ifr
            });
        }
    } catch (e) {
        console.error(`[STREAM_RESOLVE] Error resolving ${slug} ep ${epNum}:`, e.message);
    }

    const result = {
        slug: slug,
        episode: parseInt(epNum, 10),
        m3u8_url: directM3u8,
        stream_url: directM3u8 ? `http://${reqHost}/stream.m3u8?url=${encodeURIComponent(directM3u8)}&slug=${encodeURIComponent(slug)}&ep=${epNum}` : '',
        servers: servers
    };

    if (directM3u8) {
        STREAM_CACHE.set(cacheKey, { data: result, time: Date.now() });
    }

    return result;
}

function resolveNinku(epNum, reqHost) {
    const ep = Math.max(1, Math.min(55, parseInt(epNum, 10) || 1));
    const epPad = String(ep).padStart(2, '0');
    const archiveUrl = `https://archive.org/download/Ninku-English-Sub/Ninku%20%5BEpisode%20${epPad}%5D%20English%20Sub.mp4`;
    const archiveEmbed = `https://archive.org/embed/Ninku-English-Sub/Ninku%20%5BEpisode%20${epPad}%5D%20English%20Sub.mp4`;

    const servers = [
        {
            name: '⚡ Archive.org HD Directo (Cero Buffering)',
            type: 'direct',
            format: 'mp4',
            url: archiveUrl,
            target: archiveUrl,
            proxied_url: archiveUrl
        },
        {
            name: '🏛️ Reproductor Legal Embebido',
            type: 'iframe',
            format: 'iframe',
            url: archiveEmbed,
            embed_url: archiveEmbed,
            target: archiveEmbed,
            proxied_url: archiveEmbed
        }
    ];

    const subtitles = [];
    const subFile = `ninku_ep${epPad}_es.vtt`;
    const subDisk = path.join(SUBTITLES_DIR, subFile);
    if (fs.existsSync(subDisk)) {
        subtitles.push({
            label: 'Español (Oficial)',
            src: `http://${reqHost}/subtitles/${subFile}`,
            srclang: 'es',
            default: true
        });
    }

    return {
        slug: 'ninku',
        episode: ep,
        m3u8_url: archiveUrl,
        stream_url: archiveUrl,
        servers: servers,
        subtitles: subtitles
    };
}

// ==============================================================================
// 5. HTTP SERVER DISPATCHER
// ==============================================================================

const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const reqHost = req.headers.host || `127.0.0.1:${PORT}`;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    // Health & Silicon Telemetry
    if (parsed.pathname === '/status' || parsed.pathname === '/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            status: 'ok',
            device: 'LG_webOS_SmartTV_OnDevice',
            engine: 'Node.js 8.12 (ARMv7 Realtek)',
            service: 'com.soberano.appletvhub.service',
            catalog_animes_total: 5059,
            cached_pages: CATALOG_CACHE.size,
            cached_streams: STREAM_CACHE.size,
            cached_segments: RAM_SEGMENT_CACHE.size,
            cached_segment_bytes: TOTAL_CACHE_BYTES,
            memory: process.memoryUsage(),
            timestamp: Date.now()
        }));
    }

    // Web UI Presentation
    if (parsed.pathname === '/' || parsed.pathname === '/ipad' || parsed.pathname === '/tablet' || parsed.pathname === '/ipad_vault.html') {
        const filePath = findIpadVaultHtml();
        if (filePath && fs.existsSync(filePath)) {
            const html = fs.readFileSync(filePath);
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Length': Buffer.byteLength(html)
            });
            return res.end(html);
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('ipad_vault.html not found on device');
        }
    }

    // WebVTT Subtitles
    if (parsed.pathname.startsWith('/subtitles/')) {
        const subName = path.basename(parsed.pathname);
        const subPath = path.join(SUBTITLES_DIR, subName);
        if (fs.existsSync(subPath)) {
            const vtt = fs.readFileSync(subPath);
            res.writeHead(200, {
                'Content-Type': 'text/vtt; charset=utf-8',
                'Content-Length': Buffer.byteLength(vtt)
            });
            return res.end(vtt);
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('Subtitle not found');
        }
    }

    // 1. Trending / Popular Row
    if (parsed.pathname === '/api/popular') {
        const popular = await getPopularAnimes();
        const jsonStr = JSON.stringify(popular);
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(jsonStr)
        });
        return res.end(jsonStr);
    }

    // 2. Recent On-Air Episodes Row
    if (parsed.pathname === '/api/recent') {
        const recent = await getRecentEpisodes();
        const jsonStr = JSON.stringify(recent);
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(jsonStr)
        });
        return res.end(jsonStr);
    }

    // 3. Full Paginated Catalog (5,059 animes)
    if (parsed.pathname === '/api/catalog') {
        const p = parsed.query.p || 1;
        const filtro = parsed.query.filtro || 'popularidad';
        const genero = parsed.query.genero || '';
        const tipo = parsed.query.tipo || '';
        const estado = parsed.query.estado || '';

        const catData = await getCatalogPage(p, filtro, genero, tipo, estado);
        const jsonStr = JSON.stringify(catData);
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=1800',
            'Content-Length': Buffer.byteLength(jsonStr)
        });
        return res.end(jsonStr);
    }

    // 4. Anime Search Query
    if (parsed.pathname === '/api/search') {
        const q = parsed.query.q || '';
        const results = await searchAnimes(q);
        const jsonStr = JSON.stringify(results);
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(jsonStr)
        });
        return res.end(jsonStr);
    }

    // 5. Anime Details & Episodes Count
    if (parsed.pathname === '/api/anime') {
        const slug = parsed.query.slug || '';
        const details = await getAnimeDetails(slug);
        const jsonStr = JSON.stringify(details);
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(jsonStr)
        });
        return res.end(jsonStr);
    }

    // 6. Pre-buffer Stub (Client intent notification)
    if (parsed.pathname === '/api/prebuffer') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'prebuffering_acknowledged' }));
    }

    // 7. TMDB Transparent Proxy (Movies & TV Series Tabs)
    if (parsed.pathname.startsWith('/api/tmdb/')) {
        const subpath = parsed.pathname.replace(/^\/api\/tmdb\//, '');
        const queryStr = parsed.search ? parsed.search.replace(/^\?/, '') : '';

        try {
            const tmdbRes = await proxyTmdbRequest(subpath, queryStr);
            res.writeHead(tmdbRes.statusCode || 200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'public, max-age=3600'
            });
            return res.end(tmdbRes.body);
        } catch (e) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ results: [], error: e.message }));
        }
    }

    // 8. TMDB Stream Resolver (Movies & TV Series)
    if (parsed.pathname === '/api/resolve_tmdb') {
        const id = parsed.query.id || '';
        const type = parsed.query.type || 'movie';
        const s = parsed.query.s || 1;
        const e = parsed.query.e || 1;

        try {
            const origLang = parsed.query.orig_lang || 'en';
            const expectedTitle = parsed.query.title || '';
            const expectedOrigTitle = parsed.query.orig_title || '';
            const streamData = await resolveTmdbStream(id, type, s, e, reqHost, origLang, expectedTitle, expectedOrigTitle);
            if (streamData && streamData.status === 'ok' && !streamData.aligned && streamData.direct_stream_url && parsed.query.noalign !== '1') {
                streamData.aligning = true;
                triggerAlign(id, type, s, e, streamData.direct_stream_url);
            }
            const jsonStr = JSON.stringify(streamData);
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*'
            });
            return res.end(jsonStr);
        } catch (err) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'error', message: err.message }));
        }
    }

    // 8.2 Subtitle upload (usado por el alineador del Mac y por el boton de subir .vtt/.srt)
    if (parsed.pathname === '/api/subtitles/upload' && req.method === 'POST') {
        let size = 0;
        const chunks = [];
        let aborted = false;
        req.on('data', (c) => {
            size += c.length;
            if (size > 4 * 1024 * 1024) { aborted = true; res.writeHead(413); res.end('too large'); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            if (aborted) return;
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                let name = path.basename(String(body.name || 'upload.vtt')).replace(/[^A-Za-z0-9_.\-]/g, '_');
                name = name.replace(/\.(srt|vtt|txt)$/i, '') + '.vtt';
                if (name.length > 90) name = name.slice(-90);
                let content = String(body.content || '');
                if (content.length < 20) throw new Error('empty subtitle');
                content = content.replace(/\[\s*(?:cite|cita)\s*[:：]?\s*\d+\s*\]/gi, '')
                                 .replace(/(?:cite|cita)\s*[:：]?\s*\d+/gi, '');
                if (!/^\s*WEBVTT/.test(content)) {
                    content = 'WEBVTT\n\n' + content.replace(/\r/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
                }
                if (!fs.existsSync(SUBTITLES_DIR)) fs.mkdirSync(SUBTITLES_DIR);
                const tmp = path.join(SUBTITLES_DIR, name + '.tmp');
                fs.writeFileSync(tmp, content);
                fs.renameSync(tmp, path.join(SUBTITLES_DIR, name));
                const out = JSON.stringify({ status: 'ok', url: '/subtitles/' + name, bytes: content.length });
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                return res.end(out);
            } catch (er) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ status: 'error', message: er.message }));
            }
        });
        return;
    }

    // 8.3 Estado de la alineacion de subtitulos (consulta al Mac + archivo local)
    if (parsed.pathname === '/api/align_status') {
        const type = parsed.query.type || 'movie';
        const id = parsed.query.id || '';
        const s = parsed.query.s || 1;
        const e = parsed.query.e || 1;
        const name = alignedName(type, id, s, e);
        const hasLocal = fs.existsSync(path.join(SUBTITLES_DIR, name));
        const key = `${type}_${id}_${s}_${e}`;
        alignerRequest('/status?key=' + encodeURIComponent(key), 3000, (err, r) => {
            const out = err ? { state: hasLocal ? 'done' : 'unavailable', version: 0, pushed: hasLocal, note: 'alineador no disponible' } : r;
            out.local = hasLocal;
            out.url = hasLocal ? `http://${reqHost}/subtitles/${name}` : null;
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(out));
        });
        return;
    }

    // 8.1 Subtitle Proxy & SRT-to-WebVTT Transcoder Endpoint (CORS-free + Zero-Desync + Linguistic Guard for webOS)
    if (parsed.pathname === '/api/sub_proxy') {
        const subUrl = parsed.query.url;
        if (!subUrl) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            return res.end('Missing url');
        }
        try {
            let rawSub = await fetchText(subUrl, {}, 5000);
            rawSub = rawSub.replace(/^\uFEFF/, '').replace(/\r/g, '');
            // Limpiar artefactos de citas, spam publicitario y etiquetas ASS/SSA
            rawSub = rawSub.replace(/\[\s*(?:cite|cita)\s*[:：]?\s*\d+\s*\]/gi, '')
                           .replace(/\b(?:cite|cita)\s*[:：]?\s*\d+\b/gi, '')
                           .replace(/\{\\[^}]*\}/g, '');
            // Convertir marcas de tiempo SRT (00:00:14,139) a WebVTT estándar (00:00:14.139)
            rawSub = rawSub.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
                           .replace(/(\d{2}:\d{2}),(\d{3})/g, '$1.$2');
            // VERIFICACIÓN LINGÜÍSTICA ESPAÑOLA: si una pista etiquetada como 'spa' en OpenSubtitles viene en otro idioma o corrupta, devolver 422 para que el failover pase a la siguiente en <30ms
            if (!verifySpanishLinguisticText(rawSub)) {
                res.writeHead(422, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
                return res.end('Non-Spanish or corrupted subtitle track rejected by Linguistic Guard');
            }
            if (!/^\s*WEBVTT/i.test(rawSub)) {
                rawSub = 'WEBVTT\n\n' + rawSub;
            }
            res.writeHead(200, {
                'Content-Type': 'text/vtt; charset=utf-8',
                'Cache-Control': 'public, max-age=7200',
                'Access-Control-Allow-Origin': '*'
            });
            return res.end(rawSub);
        } catch(e) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            return res.end('Sub proxy error: ' + e.message);
        }
    }

    // 8.4 On-The-Fly Neural Subtitle Translator ($0.00 USD GTX Batch Engine)
    // Si una serie/película nueva solo tiene subtítulos en inglés/otro idioma, los traduce al español al vuelo
    if (parsed.pathname === '/api/sub_translate') {
        const subUrl = parsed.query.url;
        if (!subUrl) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            return res.end('Missing url');
        }
        try {
            let rawSub = await fetchText(subUrl, {}, 5500);
            rawSub = rawSub.replace(/^\uFEFF/, '').replace(/\r/g, '')
                           .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
                           .replace(/\{\\[^}]*\}/g, '');
            const blocks = rawSub.split(/\n\n+/);
            const cues = [];
            for (let b of blocks) {
                const lines = b.trim().split('\n');
                let tsIdx = -1;
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].includes('-->')) { tsIdx = i; break; }
                }
                if (tsIdx !== -1) {
                    const tsLine = lines[tsIdx];
                    const txt = lines.slice(tsIdx + 1).join(' ').replace(/<[^>]+>/g, '').trim();
                    if (txt) cues.push({ ts: tsLine, text: txt });
                }
            }
            // Traducir por lotes de ~35 líneas en paralelo usando GTX ($0 API)
            const batchSize = 35;
            const batches = [];
            for (let i = 0; i < Math.min(cues.length, 700); i += batchSize) {
                batches.push(cues.slice(i, i + batchSize));
            }
            await Promise.all(batches.map(async (batch) => {
                try {
                    const joined = batch.map(c => c.text).join('\n');
                    const gUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=es&dt=t&q=${encodeURIComponent(joined)}`;
                    const gRaw = await fetchText(gUrl, {}, 4500);
                    const gJson = JSON.parse(gRaw);
                    const fullTrans = (gJson[0] || []).map(x => x[0] || '').join('');
                    const transLines = fullTrans.split('\n');
                    for (let j = 0; j < batch.length; j++) {
                        if (transLines[j]) batch[j].text = transLines[j].trim();
                    }
                } catch(eTrans) {}
            }));
            let outVtt = 'WEBVTT\n\n';
            for (let c of cues) {
                outVtt += `${c.ts}\n${c.text}\n\n`;
            }
            res.writeHead(200, {
                'Content-Type': 'text/vtt; charset=utf-8',
                'Cache-Control': 'public, max-age=86400',
                'Access-Control-Allow-Origin': '*'
            });
            return res.end(outVtt);
        } catch(e) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            return res.end('Sub translate error: ' + e.message);
        }
    }

    // 9. Stream Info Resolver
    if (parsed.pathname === '/api/stream_info') {
        const slug = parsed.query.slug || '';
        const ep = parsed.query.ep || 1;

        let data;
        if (slug === 'ninku') {
            data = resolveNinku(ep, reqHost);
        } else {
            data = await resolveJkStream(slug, ep, reqHost);
        }

        const jsonStr = JSON.stringify(data);
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(jsonStr)
        });
        return res.end(jsonStr);
    }

    // 10. Direct HLS Manifest Rewriter (.m3u8) with Segment In-RAM Proxying
    if (parsed.pathname === '/stream.m3u8') {
        const targetUrl = parsed.query.url;
        if (!targetUrl) {
            res.writeHead(400);
            return res.end('Missing url param');
        }

        try {
            const playlistText = await fetchText(targetUrl, { 'Referer': 'https://jkanime.net/' });
            const targetParsed = url.parse(targetUrl);
            const baseUrl = `${targetParsed.protocol}//${targetParsed.host}${path.dirname(targetParsed.pathname)}/`;

            const lines = playlistText.split('\n');

            // 10a. Variant Master Playlist
            if (playlistText.includes('#EXT-X-STREAM-INF')) {
                const rewritten = lines.map(line => {
                    const trimmed = line.trim();
                    if (trimmed.length === 0 || trimmed.startsWith('#')) return line;
                    let variantUrl = trimmed;
                    if (!variantUrl.startsWith('http://') && !variantUrl.startsWith('https://')) {
                        variantUrl = url.resolve(baseUrl, trimmed);
                    }
                    return `http://${reqHost}/stream.m3u8?url=${encodeURIComponent(variantUrl)}`;
                }).join('\n');

                res.writeHead(200, {
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    'Access-Control-Allow-Origin': '*'
                });
                return res.end(rewritten);
            }

            // 10b. Media Playlist: rewrite each chunk to /stream?url=...
            const segUrls = [];
            const rewritten = lines.map(line => {
                const trimmed = line.trim();
                if (trimmed.length === 0 || trimmed.startsWith('#')) return line;
                let fullSegUrl = trimmed;
                if (!fullSegUrl.startsWith('http://') && !fullSegUrl.startsWith('https://')) {
                    fullSegUrl = url.resolve(baseUrl, trimmed);
                }
                segUrls.push(fullSegUrl);
                return `http://${reqHost}/stream?url=${encodeURIComponent(fullSegUrl)}`;
            }).join('\n');

            CURRENT_PLAYLIST_SEGMENTS = segUrls;

            // Pre-warm initial 4 segments into RAM immediately upon manifest request!
            if (segUrls.length > 0) {
                for (let i = 0; i < Math.min(4, segUrls.length); i++) {
                    getOrFetchSegment(segUrls[i]).catch(() => {});
                }
            }

            res.writeHead(200, {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Access-Control-Allow-Origin': '*'
            });
            return res.end(rewritten);
        } catch (e) {
            res.writeHead(502);
            return res.end(`Upstream stream error: ${e.message}`);
        }
    }

    // 11. Ultra-Low Latency Video Chunk Streamer (/stream or /proxy)
    if (parsed.pathname === '/stream' || parsed.pathname === '/proxy') {
        const segUrl = parsed.query.url;
        if (!segUrl) {
            res.writeHead(400);
            return res.end('Missing url param');
        }

        try {
            const { buf, fromCache } = await getOrFetchSegment(segUrl);
            triggerPrefetchNext(segUrl, 5);

            res.writeHead(200, {
                'Content-Type': segUrl.includes('.mp4') ? 'video/mp4' : 'video/mp2t',
                'Content-Length': buf.length,
                'Access-Control-Allow-Origin': '*',
                'X-Buffer-Source': fromCache ? 'RAM-CACHE' : 'STREAM-LIVE'
            });
            return res.end(buf);
        } catch (e) {
            res.writeHead(502);
            return res.end(`Segment fetch error: ${e.message}`);
        }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
});

server.listen(PORT, BIND_HOST, () => {
    console.log(`[SOBERANO_ON_DEVICE] Listening on http://${BIND_HOST}:${PORT} (Turbo RAM Prefetch Buffer Active)`);
});

module.exports = server;
