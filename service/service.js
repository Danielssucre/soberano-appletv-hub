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

async function fetchJson(targetUrl, customHeaders = {}, timeoutMs = 6500) {
    const raw = await fetchText(targetUrl, customHeaders, timeoutMs);
    try {
        return JSON.parse(raw);
    } catch(e) {
        return null;
    }
}

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
    if (cached && (now - cached.ts < 600000)) {
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

        // 3. Episodes (soporta animes finalizados y en emisión con actualización dinámica)
        const epm = html.match(/<span>Episodios:<\/span>\s*([^<]+)/);
        let eps_count = epm ? parseInt(epm[1].trim(), 10) : 0;
        const links = html.match(new RegExp(`${normalizedSlug}/(\\d+)/?`, 'g')) || [];
        const nums = links.map(l => parseInt(l.split('/')[1], 10)).filter(n => !isNaN(n) && n > 0 && n < 5000);
        if (nums.length > 0) {
            const maxLinkEp = Math.max(...nums);
            if (isNaN(eps_count) || eps_count === 0 || maxLinkEp > eps_count) {
                eps_count = maxLinkEp;
            }
        }
        if (isNaN(eps_count) || eps_count <= 0) eps_count = 12;

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

const TMDB_OFFICIAL_KEY = '15d2ea6d0dc1d476efbca3eba2b9bbfb';

function fetchHttpsJsonRaw(hostname, fullPath, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: hostname,
            port: 443,
            path: fullPath,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
                'Accept': 'application/json'
            },
            timeout: timeoutMs
        };
        const req = https.request(opts, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.abort(); reject(new Error('TMDB Request Timeout: ' + hostname)); });
        req.end();
    });
}

async function proxyTmdbRequest(subpath, queryStr) {
    let finalQuery = queryStr || '';
    if (!finalQuery.includes('language=')) {
        finalQuery += (finalQuery ? '&' : '') + 'language=es-MX';
    }
    // 1. Fuente Primaria en Tiempo Real: API Oficial de TMDB (0 retraso de caché en estrenos/nuevas temporadas)
    try {
        const officialQuery = `api_key=${TMDB_OFFICIAL_KEY}&${finalQuery}`;
        const primaryRes = await fetchHttpsJsonRaw('api.themoviedb.org', `/3/${subpath}?${officialQuery}`, 5500);
        if (primaryRes && primaryRes.statusCode === 200 && primaryRes.body && primaryRes.body.length > 2) {
            return primaryRes;
        }
    } catch (ePrimary) {
        console.warn(`[TMDB_PRIMARY] Fallback a espejo para ${subpath}: ${ePrimary.message}`);
    }
    // 2. Espejo de Respaldo: nabby.pro
    return fetchHttpsJsonRaw('nabby.pro', `/api/tmdb/${subpath}?${finalQuery}`, 7500);
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

function verifySpanishLinguisticText(rawText) {
    if (!rawText || typeof rawText !== 'string' || rawText.length < 40) return false;
    if (!rawText.includes('-->')) return false;
    // Rechazar pistas con mojibake árabe/cirílico/hebreo
    const sample = rawText.slice(0, 12000);
    if (/[\u0600-\u06FF\u0400-\u04FF\u0590-\u05FF]/.test(sample)) return false;

    const esWords = sample.match(/\b(?:que|los|las|para|por|con|una|como|pero|m[aá]s|esta|est[aá]|son|del|todo|bien|aqu[ií]|vamos|hola|gracias|s[ií]|qu[eé]|c[oó]mo|cu[aá]ndo|d[oó]nde|qui[eé]n|eso|esto|nada|algo|muy|tambi[eé]n|solo|s[oó]lo|cuando|porque|puedo|puede|hacer|tengo|tiene|eres|soy|estoy|est[aá]s|fue|era|hay|hab[ií]a|nunca|siempre|ahora|despu[eé]s|antes|hace|vida|tiempo|d[ií]a|noche|casa|hombre|mujer|padre|madre|hijo|dios|mierda|vamos|bueno|verdad|entonces|nosotros|ustedes|ellos)\b/gi);
    const esChars = sample.match(/[áéíóúñ¡¿ÁÉÍÓÚÑ]/g);
    const wordHits = esWords ? esWords.length : 0;
    const charHits = esChars ? esChars.length : 0;
    return (wordHits >= 3) || (wordHits >= 1 && charHits >= 2);
}

function convertSrtToWebVtt(rawSub) {
    if (!rawSub) return '';
    let vtt = String(rawSub).replace(/^\uFEFF/, '').replace(/\r/g, '');
    vtt = vtt.replace(/\[\s*(?:cite|cita)\s*[:：]?\s*\d+\s*\]/gi, '')
             .replace(/\b(?:cite|cita)\s*[:：]?\s*\d+\b/gi, '')
             .replace(/\{\\[^}]*\}/g, '');
    vtt = vtt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
             .replace(/(\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    if (!/^\s*WEBVTT/i.test(vtt)) {
        vtt = 'WEBVTT\n\n' + vtt;
    }
    return vtt;
}

const AUTO_SUB_CACHE = new Map();

async function translateRawSubToSpanishVtt(rawSub) {
    let clean = String(rawSub || '').replace(/^\uFEFF/, '').replace(/\r/g, '')
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
        .replace(/(\d{2}:\d{2}),(\d{3})/g, '$1.$2')
        .replace(/\{\\[^}]*\}/g, '');
    const blocks = clean.split(/\n\n+/);
    const cues = [];
    for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
        const lines = blocks[bIdx].trim().split('\n');
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
    const batchSize = 35;
    const batches = [];
    for (let i = 0; i < Math.min(cues.length, 650); i += batchSize) {
        batches.push(cues.slice(i, i + batchSize));
    }
    await safeAll(batches.map(async (batch) => {
        try {
            const joined = batch.map(c => c.text).join('\n');
            const gUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=es&dt=t&q=${encodeURIComponent(joined)}`;
            const gRaw = await fetchText(gUrl, {}, 4500);
            const gJson = JSON.parse(gRaw);
            const fullTrans = (gJson[0] || []).map(x => (x && x[0]) ? x[0] : '').join('');
            const transLines = fullTrans.split('\n');
            for (let j = 0; j < batch.length; j++) {
                if (transLines[j]) batch[j].text = transLines[j].trim();
            }
        } catch(eTrans) {}
    }));
    let outVtt = 'WEBVTT\n\n';
    for (let cIdx = 0; cIdx < cues.length; cIdx++) {
        outVtt += `${cues[cIdx].ts}\n${cues[cIdx].text}\n\n`;
    }
    return outVtt;
}

async function resolveAutoSpanishSubtitle(params, reqHost, reqProto = "http") {
    let rawId = String(params.id || params.imdb_id || "").trim();
    let tmdbId = /^\d+$/.test(rawId) ? rawId : "";
    let imdbId = rawId.startsWith("tt") ? rawId : (String(params.imdb_id || "").startsWith("tt") ? String(params.imdb_id).trim() : "");
    let type = (params.type === "movie" || params.type === "tv") ? params.type : (params.s || params.season || params.e || params.episode ? "tv" : "movie");
    const s = parseInt(params.s || params.season || 1, 10) || 1;
    const e = parseInt(params.e || params.episode || 1, 10) || 1;
    const title = String(params.title || "").trim();
    const slug = String(params.slug || "").trim();
    const requestedTrack = Math.max(0, parseInt(params.track || 0, 10) || 0);

    // 0. Verificar si es Ninku o si hay subtítulo local pre-sincronizado en disco
    if (slug === "ninku" || title.toLowerCase().includes("ninku")) {
        const epPad = String(e).padStart(2, "0");
        const ninkuFile = `ninku_ep${epPad}_es.vtt`;
        const ninkuPath = path.join(SUBTITLES_DIR, ninkuFile);
        if (fs.existsSync(ninkuPath)) {
            const vttContent = fs.readFileSync(ninkuPath, "utf8");
            const vttUrl = `${reqProto}://${reqHost}/subtitles/${ninkuFile}`;
            return {
                status: "ok",
                tmdb_id: tmdbId || "ninku",
                imdb_id: null,
                selected_index: 0,
                total_tracks: 1,
                label: "Español Oficial (Ninku)",
                vtt_url: vttUrl,
                vtt_content: vttContent,
                tracks: [{ index: 0, label: "Español Oficial (Ninku)", url: vttUrl }]
            };
        }
    }

    // 1. Si tenemos imdb_id pero no tmdbId numérico, resolver tmdbId con find/
    if (imdbId && !tmdbId) {
        try {
            const findRes = await proxyTmdbRequest(`find/${imdbId}`, "external_source=imdb_id");
            const findJson = JSON.parse(findRes.body || "{}");
            const foundMovie = findJson.movie_results && findJson.movie_results[0];
            const foundTv = findJson.tv_results && findJson.tv_results[0];
            if (foundMovie) {
                tmdbId = String(foundMovie.id);
                type = "movie";
            } else if (foundTv) {
                tmdbId = String(foundTv.id);
                type = "tv";
            }
        } catch(eFind) {
            console.warn("[AUTO_SUB] Error resolviendo tmdbId desde imdbId:", eFind.message);
        }
    }

    // 2. Si no tenemos ni tmdbId ni imdbId, buscar en TMDB por título
    if (!tmdbId && !imdbId && title) {
        try {
            const cleanTitle = title.replace(/\b(?:season|temporada|part|parte)\s*\d+/gi, "").replace(/[^\w\sáéíóúñÁÉÍÓÚÑ]/g, " ").trim();
            const searchPath = type === "movie" ? "search/movie" : "search/tv";
            const sRes = await proxyTmdbRequest(searchPath, `query=${encodeURIComponent(cleanTitle)}&language=es-MX`);
            const sJson = JSON.parse(sRes.body || "{}");
            if (sJson.results && sJson.results.length > 0) {
                tmdbId = String(sJson.results[0].id);
            } else {
                const mRes = await proxyTmdbRequest("search/multi", `query=${encodeURIComponent(cleanTitle)}&language=es-MX`);
                const mJson = JSON.parse(mRes.body || "{}");
                const validHit = (mJson.results || []).find(r => r.media_type === "tv" || r.media_type === "movie");
                if (validHit) {
                    tmdbId = String(validHit.id);
                    type = validHit.media_type;
                }
            }
        } catch(eSearch) {
            console.warn("[AUTO_SUB] Error buscando título en TMDB:", eSearch.message);
        }
    }

    // Si aún no tenemos imdbId pero sí tmdbId, obtener imdbId de external_ids
    if (tmdbId && !imdbId) {
        try {
            const extRes = await proxyTmdbRequest(`${type}/${tmdbId}/external_ids`, "");
            const extJson = JSON.parse(extRes.body || "{}");
            if (extJson && extJson.imdb_id) {
                imdbId = extJson.imdb_id;
            }
        } catch(eExt) {}
    }

    if (!tmdbId && !imdbId) {
        return { status: "not_found", message: "No se pudo identificar el título en TMDB/IMDb para buscar subtítulos." };
    }

    const cacheKey = `${type}_${imdbId || tmdbId}_${s}_${e}`;
    let cachedEntry = AUTO_SUB_CACHE.get(cacheKey);
    const now = Date.now();

    if (!cachedEntry || (now - cachedEntry.ts > 1800000)) {
        // Consultar proveedores de subtítulos en paralelo:
        //    A) Archivo local alineado (si existe)
        //    B) OpenSubtitles v3 Oficial (vía Stremio OpenSubtitles v3 API usando imdb_id)
        //    C) Framex Subtitle Aggregator (vía TMDB ID si está disponible)
        const osUrl = imdbId
            ? (type === "tv"
                ? `https://opensubtitles-v3.strem.io/subtitles/series/${imdbId}:${s}:${e}.json`
                : `https://opensubtitles-v3.strem.io/subtitles/movie/${imdbId}.json`)
            : null;
        const fmxQ = type === "tv"
            ? `type=tv&id=${tmdbId}&season=${s}&episode=${e}&s=${s}&e=${e}`
            : `type=movie&id=${tmdbId}`;
        const fmxUrl = tmdbId ? `https://api.framextv.tech/api/stream?${fmxQ}` : null;

        const [osRaw, fmxData] = await safeAll([
            osUrl ? fetchText(osUrl, { "Accept": "application/json" }, 5500) : Promise.resolve(null),
            fmxUrl ? fetchFramexCluster(fmxUrl, 5000) : Promise.resolve(null)
        ]);

        const esCandidates = [];
        const enFallbackCandidates = [];
        const seenRawUrls = new Set();

        // A) Local aligned file
        const locName = alignedName(type, tmdbId, s, e);
        const locPath = path.join(SUBTITLES_DIR, locName);
        if (fs.existsSync(locPath) && !isCorruptedSubFile(locPath)) {
            const locUrl = `${reqProto}://${reqHost}/subtitles/${locName}`;
            esCandidates.push({
                label: '🎯 Español (Sincronizado Audio)',
                raw_url: locUrl,
                url: locUrl,
                isLocal: true,
                localPath: locPath
            });
            seenRawUrls.add(locUrl);
        }

        // B) OpenSubtitles v3 results
        if (osRaw) {
            try {
                const osJson = JSON.parse(osRaw);
                const subs = Array.isArray(osJson.subtitles) ? osJson.subtitles : [];
                let osEsCount = 0;
                let osEnCount = 0;
                for (let i = 0; i < subs.length; i++) {
                    const sub = subs[i];
                    if (!sub || !sub.url || seenRawUrls.has(sub.url)) continue;
                    const lang = String(sub.lang || '').toLowerCase();
                    if (lang === 'spa' || lang === 'es' || lang === 'spl' || lang === 'spn') {
                        seenRawUrls.add(sub.url);
                        osEsCount++;
                        esCandidates.push({
                            label: `OpenSubtitles Español #${osEsCount}`,
                            raw_url: sub.url,
                            url: `${reqProto}://${reqHost}/api/sub_proxy?url=${encodeURIComponent(sub.url)}`
                        });
                    } else if ((lang === 'eng' || lang === 'en') && osEnCount < 2) {
                        osEnCount++;
                        enFallbackCandidates.push({
                            label: `Español IA (Traducido de OpenSubtitles #${osEnCount})`,
                            raw_url: sub.url,
                            url: `${reqProto}://${reqHost}/api/sub_translate?url=${encodeURIComponent(sub.url)}`,
                            needsTranslation: true
                        });
                    }
                }
            } catch(eOs) {}
        }

        // C) Framex Subtitles results
        if (fmxData && Array.isArray(fmxData.subtitles)) {
            let fmxEsCount = 0;
            for (let j = 0; j < fmxData.subtitles.length; j++) {
                const sub = fmxData.subtitles[j];
                if (!sub || !sub.url || seenRawUrls.has(sub.url)) continue;
                const langCode = ((sub.lang || '') + ' ' + (sub.language || '') + ' ' + (sub.label || '')).toLowerCase();
                const isEs = /(?:^|[^a-z])(?:spa|spl|spn|es(?:-[a-z0-9]+)?|espa[ñn]ol|spanish|castellano|latino)(?:$|[^a-z])/i.test(langCode);
                if (isEs) {
                    seenRawUrls.add(sub.url);
                    fmxEsCount++;
                    esCandidates.push({
                        label: `Framex Español #${fmxEsCount}`,
                        raw_url: sub.url,
                        url: `${reqProto}://${reqHost}/api/sub_proxy?url=${encodeURIComponent(sub.url)}`
                    });
                } else if (/eng|english/i.test(langCode) && enFallbackCandidates.length < 3) {
                    enFallbackCandidates.push({
                        label: `Español IA (Traducido de Framex)`,
                        raw_url: sub.url,
                        url: `${reqProto}://${reqHost}/api/sub_translate?url=${encodeURIComponent(sub.url)}`,
                        needsTranslation: true
                    });
                }
            }
        }

        cachedEntry = {
            ts: now,
            imdbId: imdbId,
            esCandidates: esCandidates,
            enFallbackCandidates: enFallbackCandidates,
            verifiedVttByUrl: new Map()
        };
        if (AUTO_SUB_CACHE.size > 60) {
            const oldest = AUTO_SUB_CACHE.keys().next().value;
            AUTO_SUB_CACHE.delete(oldest);
        }
        AUTO_SUB_CACHE.set(cacheKey, cachedEntry);
    }

    const pool = cachedEntry.esCandidates.length > 0
        ? cachedEntry.esCandidates
        : cachedEntry.enFallbackCandidates;

    if (!pool || pool.length === 0) {
        return {
            status: 'not_found',
            tmdb_id: tmdbId,
            imdb_id: cachedEntry.imdbId,
            message: 'No se encontraron subtítulos disponibles para este episodio/película.'
        };
    }

    // 4. Probar pistas desde el índice solicitado (con verificación lingüística española garantizada)
    for (let attempt = 0; attempt < Math.min(pool.length, 6); attempt++) {
        const idx = (requestedTrack + attempt) % pool.length;
        const cand = pool[idx];
        try {
            let vttContent = cachedEntry.verifiedVttByUrl.get(cand.raw_url);
            if (!vttContent) {
                if (cand.isLocal && cand.localPath && fs.existsSync(cand.localPath)) {
                    vttContent = fs.readFileSync(cand.localPath, 'utf8');
                } else if (cand.needsTranslation) {
                    const rawEn = await fetchText(cand.raw_url, {}, 5000);
                    vttContent = await translateRawSubToSpanishVtt(rawEn);
                } else {
                    const rawEs = await fetchText(cand.raw_url, {}, 5000);
                    vttContent = convertSrtToWebVtt(rawEs);
                }
                if (!verifySpanishLinguisticText(vttContent)) {
                    console.warn(`[AUTO_SUB] Pista rechazada por guardia lingüístico español: ${cand.label}`);
                    continue;
                }
                cachedEntry.verifiedVttByUrl.set(cand.raw_url, vttContent);
            }

            // Persistir el subtítulo validado como archivo .vtt estático en el mismo origen con X-TIMESTAMP-MAP
            // para que receptores AirPlay 2 (TV / Apple TV) puedan descargarlo directamente sin blob://
            const safeKey = String(cacheKey || 'sub').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
            const staticFileName = `auto_es_${safeKey}_${idx}.vtt`;
            let hlsReadyVtt = String(vttContent || '').replace(/^\uFEFF/, '');
            if (!hlsReadyVtt.includes('X-TIMESTAMP-MAP')) {
                hlsReadyVtt = hlsReadyVtt.replace(/^WEBVTT[^\n]*\n/, 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:126000,LOCAL:00:00:00.000\n');
            }
            try {
                if (!fs.existsSync(SUBTITLES_DIR)) fs.mkdirSync(SUBTITLES_DIR);
                fs.writeFileSync(path.join(SUBTITLES_DIR, staticFileName), hlsReadyVtt, 'utf8');
                fs.writeFileSync(path.join(SUBTITLES_DIR, 'active_es.vtt'), hlsReadyVtt, 'utf8');
            } catch (eWriteSub) {}

            const staticVttUrl = `${reqProto}://${reqHost}/subtitles/${staticFileName}`;

            const tracksOut = pool.map((t, i) => ({
                index: i,
                label: t.label,
                url: t.url.replace(/^https?:\/\/[^/]+\//, `${reqProto}://${reqHost}/`),
                raw_url: t.raw_url
            }));

            return {
                status: 'ok',
                tmdb_id: tmdbId,
                imdb_id: cachedEntry.imdbId,
                selected_index: idx,
                total_tracks: pool.length,
                label: cand.label,
                vtt_url: staticVttUrl,
                vtt_content: hlsReadyVtt,
                tracks: tracksOut
            };
        } catch(eCand) {
            console.warn(`[AUTO_SUB] Fallo descargando pista ${cand.label}: ${eCand.message}`);
        }
    }

    // 5. Si todas las pistas supuestamente en español fallaron el guardia lingüístico y hay pistas en inglés, traducir al vuelo
    if (cachedEntry.esCandidates.length > 0 && cachedEntry.enFallbackCandidates.length > 0) {
        try {
            const fb = cachedEntry.enFallbackCandidates[0];
            const rawEn = await fetchText(fb.raw_url, {}, 5000);
            let vttTrans = await translateRawSubToSpanishVtt(rawEn);
            if (verifySpanishLinguisticText(vttTrans)) {
                if (!vttTrans.includes('X-TIMESTAMP-MAP')) {
                    vttTrans = vttTrans.replace(/^WEBVTT[^\n]*\n/, 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:126000,LOCAL:00:00:00.000\n');
                }
                const safeKey = String(cacheKey || 'sub').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
                const staticFileName = `auto_es_${safeKey}_fb.vtt`;
                try {
                    if (!fs.existsSync(SUBTITLES_DIR)) fs.mkdirSync(SUBTITLES_DIR);
                    fs.writeFileSync(path.join(SUBTITLES_DIR, staticFileName), vttTrans, 'utf8');
                    fs.writeFileSync(path.join(SUBTITLES_DIR, 'active_es.vtt'), vttTrans, 'utf8');
                } catch (eW) {}
                const staticVttUrl = `${reqProto}://${reqHost}/subtitles/${staticFileName}`;
                return {
                    status: 'ok',
                    tmdb_id: tmdbId,
                    imdb_id: cachedEntry.imdbId,
                    selected_index: 0,
                    total_tracks: 1,
                    label: fb.label,
                    vtt_url: staticVttUrl,
                    vtt_content: vttTrans,
                    tracks: [{ index: 0, label: fb.label, url: staticVttUrl }]
                };
            }
        } catch(eFb) {}
    }

    return {
        status: 'not_found',
        tmdb_id: tmdbId,
        imdb_id: cachedEntry.imdbId,
        message: 'Ninguna pista superó la validación de español.'
    };
}

function decorateWithAligned(data, id, type, s, e, reqHost, reqProto = "http") {
    if (!data || data.status !== 'ok') return data;
    // Si el contenido proviene de Cuevana3c (Latino o Inglés Subtitulado), suprimir subtítulos externos (los subtítulos ya vienen integrados en el video)
    if (data.server && data.server.includes('Cuevana3c')) {
        return Object.assign({}, data, { aligned: false, sub_es: null, subtitles: [] });
    }
    const out = Object.assign({}, data);
    const name = alignedName(type, id, s, e);
    const p = path.join(SUBTITLES_DIR, name);
    out.aligned = false;
    if (fs.existsSync(p) && !isCorruptedSubFile(p)) {
        const url0 = `${reqProto}://${reqHost}/subtitles/${name}`;
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

function rewriteSubHost(data, reqHost, reqProto = "http") {
    if (!data) return data;
    const out = Object.assign({}, data);
    if (out.sub_es && out.sub_es.includes('/api/sub_')) {
        out.sub_es = out.sub_es.replace(/^https?:\/\/[^/]+\//, `${reqProto}://${reqHost}/`);
    }
    if (Array.isArray(out.subtitles)) {
        out.subtitles = out.subtitles.map(s => {
            const copy = Object.assign({}, s);
            if (copy.url && copy.url.includes('/api/sub_')) {
                copy.url = copy.url.replace(/^https?:\/\/[^/]+\//, `${reqProto}://${reqHost}/`);
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

function rot13(str) {
    return str.replace(/[a-zA-Z]/g, function(c) {
        var base = c <= 'Z' ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
    });
}

function decodeVoeJson(rawJson) {
    try {
        var arr = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
        var obf = arr[0];
        var s1 = rot13(obf);
        var pats = ['@$', '^^', '~@', '%?', '*~', '!!', '#&'];
        for (var i = 0; i < pats.length; i++) {
            s1 = s1.split(pats[i]).join('');
        }
        var s2 = Buffer.from(s1, 'base64').toString('utf8');
        var s3 = '';
        for (var j = 0; j < s2.length; j++) {
            s3 += String.fromCharCode(s2.charCodeAt(j) - 3);
        }
        var s4 = s3.split('').reverse().join('');
        var s5 = Buffer.from(s4, 'base64').toString('utf8');
        try {
            return JSON.parse(s5);
        } catch(e) {
            return s5;
        }
    } catch(err) {
        return null;
    }
}

async function resolveVoeStream(voeUrl) {
    try {
        var pageHtml = await fetchText(voeUrl, { 'Referer': 'https://ver.gnula.one/' }, 5000);
        var jsRedirect = pageHtml.match(/window\.location\.href\s*=\s*['"](https?:\/\/[^'"]+)['"]/);
        if (jsRedirect) {
            pageHtml = await fetchText(jsRedirect[1], { 'Referer': 'https://ver.gnula.one/' }, 5000);
        }

        var jsonScriptMatch = pageHtml.match(/<script type="application\/json">\s*(\[[\s\S]*?\])\s*<\/script>/);
        if (jsonScriptMatch) {
            var voeData = decodeVoeJson(jsonScriptMatch[1]);
            if (voeData && typeof voeData === 'object') {
                if (voeData.source) return voeData.source;
                if (voeData.direct_access_url) return voeData.direct_access_url;
                if (Array.isArray(voeData.fallback) && voeData.fallback[0] && voeData.fallback[0].file) {
                    return voeData.fallback[0].file;
                }
            } else if (typeof voeData === 'string') {
                var m3u8Match = voeData.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/);
                if (m3u8Match) return m3u8Match[0];
            }
        }
        return null;
    } catch(e) {
        return null;
    }
}

async function resolveGnulaStreams(id, type, s, e, titles, yearTarget, origLang) {
    var results = [];
    var isTv = type === 'tv';

    for (var i = 0; i < titles.length; i++) {
        var title = titles[i];
        var cleanQuery = title.replace(/[:\-–—]/g, ' ').trim();
        var suggestUrl = 'https://ver.gnula.one/wp-json/gnula/v1/suggest?q=' + encodeURIComponent(cleanQuery);
        var jsonStr = await fetchText(suggestUrl, { 'Referer': 'https://ver.gnula.one/' }, 4000);
        var items = [];
        try {
            items = JSON.parse(jsonStr);
        } catch(err) { continue; }

        if (!Array.isArray(items) || items.length === 0) continue;

        var matched = null;
        for (var j = 0; j < items.length; j++) {
            var item = items[j];
            var itemType = (item.type || '').toLowerCase();
            if (isTv && !itemType.includes('serie')) continue;
            if (!isTv && itemType.includes('serie')) continue;

            if (yearTarget && item.year) {
                var diff = Math.abs(parseInt(item.year, 10) - parseInt(yearTarget, 10));
                if (diff <= 1) {
                    matched = item;
                    break;
                }
            } else {
                matched = item;
                break;
            }
        }

        if (!matched && items.length > 0) {
            for (var k = 0; k < items.length; k++) {
                var it = items[k];
                var itType = (it.type || '').toLowerCase();
                if (isTv && !itType.includes('serie')) continue;
                if (!isTv && itType.includes('serie')) continue;
                matched = it;
                break;
            }
            if (!matched) matched = items[0];
        }
        if (!matched || !matched.url) continue;

        console.log('[GNULA] Match: "' + matched.title + '" (' + matched.year + ') -> ' + matched.url);
        var postHtml = await fetchText(matched.url, { 'Referer': 'https://ver.gnula.one/' }, 5000);
        if (!postHtml) continue;

        var serverBlockRegex = /<div[^>]*id="(gn-ls-[^"]+)"[\s\S]*?<\/div>/g;
        var bMatch;
        var collectedOptions = [];

        while ((bMatch = serverBlockRegex.exec(postHtml)) !== null) {
            var tabId = bMatch[1].toLowerCase();
            var isSub = tabId.indexOf('sub') !== -1;
            var isLat = tabId.indexOf('lat') !== -1;
            var isCas = tabId.indexOf('cas') !== -1 || tabId.indexOf('esp') !== -1;

            var linkRegex = /<a class="gn-srv"[^>]*data-src="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
            var lMatch;
            while ((lMatch = linkRegex.exec(bMatch[0])) !== null) {
                var trembedUrl = lMatch[1].replace(/&#038;/g, '&');
                var label = lMatch[2].replace(/<[^>]+>/g, '').trim();
                collectedOptions.push({
                    isSub: isSub,
                    isLat: isLat,
                    isCas: isCas,
                    label: label,
                    trembedUrl: trembedUrl
                });
            }
        }

        collectedOptions.sort(function(a, b) {
            var scoreA = (a.isSub ? 100 : 0) + (a.isLat ? 50 : 0);
            var scoreB = (b.isSub ? 100 : 0) + (b.isLat ? 50 : 0);
            return scoreB - scoreA;
        });

        for (var o = 0; o < collectedOptions.length; o++) {
            var opt = collectedOptions[o];
            var trembedHtml = await fetchText(opt.trembedUrl, { 'Referer': matched.url }, 4000);
            var ifrMatch = trembedHtml.match(/<iframe[^>]*src="([^"]+)"/i);
            if (!ifrMatch) continue;

            var ifrUrl = ifrMatch[1].replace(/&#038;/g, '&');

            // 1. VOE Hoster
            if (ifrUrl.indexOf('voe.sx') !== -1 || ifrUrl.indexOf('voe.') !== -1 || ifrUrl.indexOf('shannoncoldalready') !== -1) {
                var voeM3u8 = await resolveVoeStream(ifrUrl);
                if (voeM3u8) {
                    results.push({
                        status: 'ok',
                        id: id,
                        type: type,
                        season: s,
                        episode: e,
                        direct_stream_url: voeM3u8,
                        server: 'Gnula ' + (opt.isSub ? 'Inglés (Subtitulado Español)' : (opt.isLat ? 'Latino' : 'Castellano')) + ' HD',
                        is_sub: opt.isSub,
                        quality: '1080p',
                        format: 'hls',
                        audio_es: !opt.isSub,
                        sub_es: null,
                        subtitles: []
                    });
                    if (opt.isSub) break;
                }
            }

            // 2. VidHide Hoster
            if (ifrUrl.indexOf('ikhjerbhye3wjkhoduh5xiczuvd.lol') !== -1 || ifrUrl.indexOf('vidhide') !== -1) {
                var vhHtml = await fetchText(ifrUrl, { 'Referer': opt.trembedUrl }, 4000);
                var vhPacked = vhHtml.match(/eval\(function\(p,a,c,k,e,d\)[\s\S]*?\.split\('\|'\)\)\)/);
                if (vhPacked) {
                    var vhUnpacked = unpackPackedJS(vhPacked[0]);
                    var vhM3u8 = vhUnpacked.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]+/);
                    if (vhM3u8) {
                        results.push({
                            status: 'ok',
                            id: id,
                            type: type,
                            season: s,
                            episode: e,
                            direct_stream_url: vhM3u8[0],
                            server: 'Gnula ' + (opt.isSub ? 'Inglés (Subtitulado Español)' : (opt.isLat ? 'Latino' : 'Castellano')) + ' HD',
                            is_sub: opt.isSub,
                            quality: '1080p',
                            format: 'hls',
                            audio_es: !opt.isSub,
                            sub_es: null,
                            subtitles: []
                        });
                        if (opt.isSub) break;
                    }
                }
            }
        }
        if (results.length > 0) break;
    }
    return results;
}

async function resolveCuevanaStreams(id, type, s, e, titles, yearTarget, origLang) {
    var results = [];
    var isTv = type === 'tv';
    var matchedPageUrl = null;

    for (var i = 0; i < titles.length; i++) {
        var titleQuery = titles[i];
        var cleanQuery = titleQuery.replace(/[:\-–—]/g, ' ').trim();
        var searchUrl = 'https://cuevana3c.pro/explorar?s=' + encodeURIComponent(cleanQuery);
        var searchHtml = await fetchText(searchUrl, { 'Referer': 'https://cuevana3c.pro/' }, 5000);
        
        var cardRegex = /<div class="movie-item">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/div>/g;
        var m;
        var candidates = [];
        while ((m = cardRegex.exec(searchHtml)) !== null) {
            var link = m[1];
            var inner = m[2];
            var isTypeMatch = isTv ? link.indexOf('/serie/') !== -1 : link.indexOf('/pelicula/') !== -1;
            if (!isTypeMatch) continue;
            
            var titleM = inner.match(/<p>([^<]+)<\/p>/);
            var yearM = inner.match(/<span class="year[^"]*">([^<]+)<\/span>/);
            candidates.push({
                url: link,
                title: titleM ? titleM[1].trim() : '',
                year: yearM ? yearM[1].trim() : ''
            });
        }

        if (candidates.length > 0) {
            if (yearTarget) {
                var yearMatch = candidates.find(function(c) { return c.year && c.year.indexOf(yearTarget) !== -1; });
                if (yearMatch) {
                    matchedPageUrl = yearMatch.url;
                    break;
                }
            }
            matchedPageUrl = candidates[0].url;
            break;
        }
    }

    if (!matchedPageUrl) return results;

    var targetContentUrl = matchedPageUrl;
    if (isTv) {
        var slugMatch = matchedPageUrl.match(/\/serie\/([^\/]+)/);
        if (slugMatch) {
            targetContentUrl = 'https://cuevana3c.pro/serie/' + slugMatch[1] + '/episodio-' + s + 'x' + e;
        } else {
            targetContentUrl = matchedPageUrl.replace(/\/$/, '') + '/episodio-' + s + 'x' + e;
        }
    }

    var detailHtml = await fetchText(targetContentUrl, { 'Referer': 'https://cuevana3c.pro/' }, 6000);
    var tabRegex = /<li class="tab-video-item">([\s\S]*?)(?=<li class="tab-video-item">|<\/ul>\s*<\/div>)/g;
    var tabMatch;
    var parsedTabs = [];

    while ((tabMatch = tabRegex.exec(detailHtml)) !== null) {
        var tabBlock = tabMatch[1];
        var nameMatch = tabBlock.match(/<div class="tab-item-name">\s*([^<]+)/);
        var imgMatch = tabBlock.match(/<img[^>]+src="?([^"\s>]+)/);
        var tName = nameMatch ? nameMatch[1].trim() : '';
        var tImg = imgMatch ? imgMatch[1].trim() : '';
        var combined = (tName + ' ' + tImg).toLowerCase();

        var tokenMatch = tabBlock.match(/data-server="https:\/\/tungtungsahur\.cuevana3c\.pro\/\?token=([^"]+)"/);
        var token = tokenMatch ? tokenMatch[1] : null;

        var isSub = /subtitulado|ingl[eé]s|sub\.png|\bvo\b/.test(combined);
        var isEs = /latino|castellano|español|lat\.png|cas\.png/.test(combined);

        parsedTabs.push({
            name: tName,
            token: token,
            isSub: isSub,
            isEs: isEs
        });
    }

    for (var t = 0; t < parsedTabs.length; t++) {
        var tab = parsedTabs[t];
        if (!tab.token) continue;
        var tabSub = tab.isSub;
        var label = tabSub ? 'Inglés (Subtitulado Español)' : (tab.name || (tab.isEs ? 'Latino' : 'Audio'));
        var embedUrl = decryptCuevanaToken(tab.token);
        if (!embedUrl) continue;

        if (embedUrl.indexOf('ikhjerbhye3wjkhoduh5xiczuvd.lol') !== -1 || embedUrl.indexOf('lkhjerbhye3wjkhodvh5xlczuvd.lol') !== -1) {
            var embedHtml = await fetchText(embedUrl, { 'Referer': 'https://tungtungsahur.cuevana3c.pro/' }, 5000);
            var packedMatch = embedHtml.match(/eval\(function\(p,a,c,k,e,d\)[\s\S]*?\.split\('\|'\)\)\)/);
            if (packedMatch) {
                var unpacked = unpackPackedJS(packedMatch[0]);
                var m3u8Match = unpacked.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]+/);
                if (m3u8Match) {
                    results.push({
                        status: 'ok',
                        id: id,
                        type: type,
                        season: s,
                        episode: e,
                        direct_stream_url: m3u8Match[0],
                        server: 'Cuevana3c ' + label + ' HD',
                        is_sub: tabSub,
                        quality: '1080p',
                        format: 'hls',
                        audio_es: !tabSub,
                        sub_es: null,
                        subtitles: []
                    });
                }
            }
        }
    }
    return results;
}

function getStreamDeduplicationKey(url) {
    if (!url) return '';
    try {
        var u = new URL(url);
        var innerUrl = u.searchParams.get('url');
        if (innerUrl) {
            return innerUrl.split('?')[0];
        }
        return u.origin + u.pathname;
    } catch(e) {
        return url.split('?')[0];
    }
}

function deduplicateAndRankStreams(candidates, origLang, sharedEsSub, sharedAllSubs) {
    var isForeign = (origLang || 'en').toLowerCase() !== 'es';
    var seenUrls = new Set();
    var unique = [];

    for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        if (!c || !c.direct_stream_url) continue;
        var normKey = getStreamDeduplicationKey(c.direct_stream_url);
        if (seenUrls.has(normKey)) {
            console.log('[DEDUP] Omitiendo stream duplicado: ' + normKey);
            continue;
        }
        seenUrls.add(normKey);

        // Enriquecer cualquier candidato (ej. Cuevana/Gnula) con los subtítulos españoles verificados de OpenSubtitles
        if ((!c.subtitles || c.subtitles.length === 0) && sharedAllSubs && sharedAllSubs.length > 0) {
            c.subtitles = sharedAllSubs;
        }
        if (!c.sub_es && sharedEsSub) {
            c.sub_es = sharedEsSub;
        }

        var score = c.base_bonus || 0;
        if (c.server && (c.server.indexOf('Cuevana3c') === 0 || c.server.indexOf('Gnula') === 0)) {
            score += 75;
        }
        if (c.is_sub) {
            score += 1000; // Preferencia universal solicitada: HD con subtítulos
        } else if (c.audio_es) {
            score += 900;  // Audio Español Latino / Castellano listo en la barra de servidores
        }

        if (c.quality === '1080p' || c.quality === 'HD') {
            score += 500;
        }

        if (!isForeign && c.audio_es) {
            score += 2000; // Obra original en español
        }

        c.score = score;
        unique.push(c);
    }

    unique.sort(function(a, b) { return b.score - a.score; });
    return unique;
}

function safeAll(promises) {
    return Promise.all(promises.map(function(p) {
        return Promise.resolve(p).catch(function(err) {
            console.warn('[SAFE_ALL ERROR]', err && err.message ? err.message : err);
            return null;
        });
    }));
}

async function fetchFramexCluster(url, timeoutMs = 5000) {
    try {
        const text = await fetchText(url, {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
            'Accept': 'application/json'
        }, timeoutMs);
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

async function resolveFramexStreams(id, type = 'movie', s = 1, e = 1, origLang = 'en', reqHost = '127.0.0.1:9099', reqProto = 'http') {
    const isTv = type === 'tv';
    // CRÍTICO: Pasar tanto season/episode como s/e garantiza resolución exacta de temporada/episodio en todos los clusters
    const baseQ = isTv
        ? `type=tv&id=${id}&season=${s}&episode=${e}&s=${s}&e=${e}`
        : `type=movie&id=${id}`;

    try {
        // Federación Multi-Cluster en Paralelo:
        // - Default/Titan (MP4 Directo 1080p + Subtítulos OpenSubtitles)
        // - Bowler (PrimeVids / Rivestream HLS - indexación inmediata de episodios en emisión)
        // - Executioner (Vidrock HLS - alta disponibilidad global)
        // - Root Rider (Vidzee / FastCloud HLS)
        const clusterUrls = [
            `https://api.framextv.tech/api/stream?${baseQ}`,
            `https://api.framextv.tech/api/stream?${baseQ}&provider=bowler`,
            `https://api.framextv.tech/api/stream?${baseQ}&provider=executioner`,
            `https://api.framextv.tech/api/stream?${baseQ}&provider=root_rider`
        ];

        const responses = await safeAll(clusterUrls.map((u, idx) => fetchFramexCluster(u, idx === 0 ? 5500 : 4800)));

        let esSub = null;
        const allSubs = [];
        const seenSubUrls = new Set();

        responses.forEach(data => {
            if (!data || !Array.isArray(data.subtitles)) return;
            data.subtitles.forEach(sub => {
                if (!sub || !sub.url || seenSubUrls.has(sub.url)) return;
                const langCode = ((sub.lang || '') + ' ' + (sub.language || '') + ' ' + (sub.label || '')).toLowerCase();
                const isEs = /(?:^|[^a-z])(?:spa|spl|spn|es(?:-[a-z0-9]+)?|espa[ñn]ol|spanish|castellano|latino)(?:$|[^a-z])/i.test(langCode);
                if (isEs) {
                    seenSubUrls.add(sub.url);
                    const proxiedSub = `${reqProto}://${reqHost}/api/sub_proxy?url=${encodeURIComponent(sub.url)}`;
                    allSubs.push({
                        url: proxiedSub,
                        raw_url: sub.url,
                        label: sub.label || 'Español',
                        lang: 'es'
                    });
                    if (!esSub) esSub = proxiedSub;
                }
            });
        });

        const candidates = [];
        let orderIdx = 0;

        responses.forEach(data => {
            if (!data || !data.success || !Array.isArray(data.sources)) return;
            for (let i = 0; i < data.sources.length; i++) {
                const src = data.sources[i];
                if (!src || !src.url) continue;

                const rawSrv = src.server || ('Servidor ' + (orderIdx + 1));
                // Omitir espejos redundantes Relay / VPS del mismo cluster para mantener limpia la UI
                if (/\b(?:Relay|VPS)\b/i.test(rawSrv) && i > 0) continue;

                // GUARDIA DE INTEGRIDAD DE EPISODIO:
                // Si el servidor etiqueta explícitamente SxxExx, verificar que coincida exactamente con S{s}E{e}
                if (isTv) {
                    const epMatch = rawSrv.match(/S(\d+)E(\d+)/i);
                    if (epMatch) {
                        const srvSeason = parseInt(epMatch[1], 10);
                        const srvEp = parseInt(epMatch[2], 10);
                        if (srvSeason !== parseInt(s, 10) || srvEp !== parseInt(e, 10)) {
                            console.warn(`[FRAMEX_GUARD] Descartado stream con episodio no coincidente: ${rawSrv} (solicitado S${s}E${e})`);
                            continue;
                        }
                    }
                }

                const isHls = src.type === 'hls' || src.url.includes('.m3u8');
                const is1080 = (src.quality || '').includes('1080') || src.quality === 'dcloud' || src.quality === 'tcloud' || src.quality === 'Auto';
                const serverClean = rawSrv
                    .replace(/^Framex\s*/i, '')
                    .replace(/\s*-\s*S\d+E\d+\s*/i, ' ')
                    .replace(/\s*·\s*(?:dcloud|ipcloud|tcloud|Relay|VPS)/gi, '')
                    .replace(/\s+/g, ' ')
                    .trim();
                const serverName = `Framex ${serverClean} (${is1080 ? '1080p' : 'HD'})`;

                candidates.push({
                    status: 'ok',
                    id: String(id),
                    type: type,
                    season: String(s),
                    episode: String(e),
                    direct_stream_url: src.url,
                    server: serverName,
                    is_sub: true,
                    quality: is1080 ? '1080p' : '720p',
                    format: isHls ? 'hls' : 'mp4',
                    audio_es: false,
                    sub_es: esSub,
                    subtitles: allSubs,
                    base_bonus: 55 - (orderIdx * 4)
                });
                orderIdx++;
            }
        });

        return candidates;
    } catch (e) {
        console.warn(`[FRAMEX_RESOLVER] Error para ${id} (${type} S${s}E${e}): ${e.message}`);
        return [];
    }
}

async function resolveTmdbStream(id, type = 'movie', s = 1, e = 1, reqHost = '127.0.0.1:9099', origLang = 'en', expectedTitle = '', expectedOrigTitle = '', forceRefresh = false, reqProto = 'http') {
    const cacheKey = `${id}_${type}_${s}_${e}`;
    const now = Date.now();
    const cached = TMDB_STREAM_CACHE.get(cacheKey);
    // TTL de 15 minutos (900000 ms) para garantizar tokens CDN frescos y detección rápida de nuevos episodios
    if (!forceRefresh && cached && (now - cached.ts < 900000)) {
        return decorateWithAligned(rewriteSubHost(cached.data, reqHost, reqProto), id, type, s, e, reqHost, reqProto);
    }

    let titles = [expectedTitle, expectedOrigTitle].filter(Boolean);
    let yearTarget = null;
    let resolvedOrigLang = origLang;

    try {
        const tmdbRes = await proxyTmdbRequest(type === 'tv' ? `tv/${id}` : `movie/${id}`, 'language=es-MX');
        const tmdbJson = JSON.parse(tmdbRes.body);
        if (tmdbJson.title) titles.push(tmdbJson.title);
        if (tmdbJson.name) titles.push(tmdbJson.name);
        if (tmdbJson.original_title) titles.push(tmdbJson.original_title);
        if (tmdbJson.original_name) titles.push(tmdbJson.original_name);
        if (tmdbJson.original_language) resolvedOrigLang = tmdbJson.original_language;
        const dateStr = tmdbJson.release_date || tmdbJson.first_air_date || '';
        if (dateStr) yearTarget = dateStr.slice(0, 4);
    } catch(e) {}
    titles = Array.from(new Set(titles.filter(Boolean)));

    console.log(`[MULTI_CLUSTER_RESOLVER] Consultando Cuevana3c, Gnula y 4 Clusters Framex para ${id} (${type} S${s}E${e}) con títulos:`, titles, `año:`, yearTarget, `origLang:`, resolvedOrigLang);

    try {
        const triResults = await safeAll([
            resolveCuevanaStreams(id, type, s, e, titles, yearTarget, resolvedOrigLang),
            resolveGnulaStreams(id, type, s, e, titles, yearTarget, resolvedOrigLang),
            resolveFramexStreams(id, type, s, e, resolvedOrigLang, reqHost, reqProto)
        ]);

        const framexCands = triResults[2] || [];
        let sharedEsSub = null;
        let sharedAllSubs = [];
        for (let fIdx = 0; fIdx < framexCands.length; fIdx++) {
            if (framexCands[fIdx].sub_es && !sharedEsSub) sharedEsSub = framexCands[fIdx].sub_es;
            if (framexCands[fIdx].subtitles && framexCands[fIdx].subtitles.length > sharedAllSubs.length) {
                sharedAllSubs = framexCands[fIdx].subtitles;
            }
        }

        const allCandidates = [].concat(triResults[0] || [], triResults[1] || [], framexCands);
        console.log(`[MULTI_CLUSTER_RESOLVER] Total candidatos brutos obtenidos: ${allCandidates.length}`);

        const ranked = deduplicateAndRankStreams(allCandidates, resolvedOrigLang, sharedEsSub, sharedAllSubs);
        console.log(`[MULTI_CLUSTER_RESOLVER] Candidatos únicos y clasificados: ${ranked.length}`);

        if (ranked.length > 0) {
            const primary = ranked[0];
            primary.servers = ranked.map(c => ({
                name: c.server,
                url: c.direct_stream_url,
                quality: c.quality,
                is_sub: c.is_sub,
                audio_es: c.audio_es
            }));
            console.log(`[MULTI_CLUSTER_RESOLVER SUCCESS] Stream ganador seleccionado (${primary.server}, score: ${primary.score}, total servers: ${primary.servers.length}):`, primary.direct_stream_url.slice(0, 80) + '...');
            TMDB_STREAM_CACHE.set(cacheKey, { data: primary, ts: now });
            return decorateWithAligned(primary, id, type, s, e, reqHost, reqProto);
        }
    } catch (triErr) {
        console.warn(`[MULTI_CLUSTER_RESOLVER] Error durante resolución: ${triErr.message}`);
    }

    return {
        status: 'not_found',
        id: id,
        type: type,
        message: 'Contenido no disponible en los proveedores de streaming por el momento.'
    };
}

// ==============================================================================
// 4. STREAM EXTRACTION & NATIVE HLS REWRITER
// ==============================================================================

async function resolveJkStream(slug, epNum, reqHost, reqProto = "http") {
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

            const proxiedUrl = `${reqProto}://${reqHost}/stream.m3u8?url=${encodeURIComponent(target)}&slug=${encodeURIComponent(slug)}&ep=${epNum}`;

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
        stream_url: directM3u8 ? `${reqProto}://${reqHost}/stream.m3u8?url=${encodeURIComponent(directM3u8)}&slug=${encodeURIComponent(slug)}&ep=${epNum}` : '',
        servers: servers
    };

    if (directM3u8) {
        STREAM_CACHE.set(cacheKey, { data: result, time: Date.now() });
    }

    return result;
}

function resolveNinku(epNum, reqHost, reqProto = "http") {
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
            src: `${reqProto}://${reqHost}/subtitles/${subFile}`,
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
// 4.5. SOBERANO PHANTOM-SWARM ENGINE (Universal Torrents on HTTPS Port 443)
// ==============================================================================
const SOBERANO_CACHE = new Map();
const SOBERANO_STREAMS_CACHE = new Map();

function cleanTorrentTitle(rawTitle) {
    if (!rawTitle) return '';
    return rawTitle
        .replace(/\b(2160p|1080p|720p|480p|4k|uhd|bluray|bdrip|brrip|web-dl|webrip|hdr10\+|hdr10|hdr|dv|dovi|dolby vision|atmos|truehd|dts-hd|dts|ddp5\.1|dd5\.1|ac3|aac|x264|x265|hevc|h\.264|h\.265|av1|remux|proper|repack|imax)\b/gi, '')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[._-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseTorrentStream(stream) {
    const rawTitle = stream.title || '';
    const name = stream.name || 'Torrentio';
    const lines = rawTitle.split('\n');
    const firstLine = lines[0] || '';
    const detailsLine = lines[1] || '';

    // Extracción de resolución
    let quality = 'HD';
    if (/4k|2160p/i.test(name) || /4k|2160p/i.test(firstLine)) quality = '4K';
    else if (/1080p/i.test(name) || /1080p/i.test(firstLine)) quality = '1080p';
    else if (/720p/i.test(name) || /720p/i.test(firstLine)) quality = '720p';

    // Extracción de Seeders (👤)
    const seedMatch = rawTitle.match(/👤\s*(\d+)/);
    const seeds = seedMatch ? parseInt(seedMatch[1], 10) : 0;

    // Extracción de Tamaño (💾)
    const sizeMatch = rawTitle.match(/💾\s*([\d.]+\s*(?:GB|MB|TB))/i);
    const size = sizeMatch ? sizeMatch[1].trim() : '';

    // Extracción de Fuente/Tracker (⚙️)
    const trackerMatch = rawTitle.match(/⚙️\s*([^\n]+)/);
    const tracker = trackerMatch ? trackerMatch[1].trim() : '';

    // Detección de Idioma
    const isEs = /🇪🇸|🇲🇽|\b(spa|latino|castellano|spanish|es)\b/i.test(rawTitle);
    const isDual = /\b(dual|multi|multi-audio|multi-subs|dub)\b/i.test(rawTitle);

    // Detección de HDR / Dolby Vision
    const isHdr = /\b(hdr|hdr10|hdr10\+|dv|dolby vision)\b/i.test(rawTitle) || /\b(hdr|dv)\b/i.test(name);

    // Nombre de archivo y contenedor
    const fn = (stream.behaviorHints && stream.behaviorHints.filename) ? stream.behaviorHints.filename : firstLine;
    const isMp4 = fn.toLowerCase().endsWith('.mp4');

    return {
        name: name.replace(/\n/g, ' ').trim(),
        title: firstLine.trim(),
        full_title: rawTitle,
        infoHash: stream.infoHash,
        fileIdx: stream.fileIdx !== undefined ? stream.fileIdx : 0,
        quality: quality,
        seeds: seeds,
        size: size,
        tracker: tracker,
        is_es: isEs,
        is_dual: isDual,
        is_hdr: isHdr,
        is_mp4: isMp4,
        filename: fn
    };
}

async function searchSoberanoCatalog(query) {
    const qTrim = String(query || '').trim();
    if (!qTrim) return [];

    const cacheKey = `sob_q_${qTrim.toLowerCase()}`;
    if (SOBERANO_CACHE.has(cacheKey)) {
        return SOBERANO_CACHE.get(cacheKey);
    }

    const enc = encodeURIComponent(qTrim);
    // Búsqueda cruzada en Cinemeta (Películas, Series y Anime)
    const endpoints = [
        `https://v3-cinemeta.strem.io/catalog/movie/top/search=${enc}.json`,
        `https://v3-cinemeta.strem.io/catalog/series/top/search=${enc}.json`
    ];

    try {
        const results = await safeAll(endpoints.map(u => fetchJson(u, {}, 5000)));
        const combined = [];
        const seenIds = new Set();

        results.forEach(res => {
            if (res && Array.isArray(res.metas)) {
                res.metas.forEach(m => {
                    if (m && m.id && !seenIds.has(m.id)) {
                        seenIds.add(m.id);
                        combined.push({
                            id: m.id,
                            imdb_id: m.imdb_id || m.id,
                            type: m.type === 'series' ? 'tv' : 'movie',
                            title: m.name,
                            poster: m.poster,
                            backdrop: m.background,
                            year: m.releaseInfo || m.year || '',
                            description: m.description || '',
                            genres: m.genres || []
                        });
                    }
                });
            }
        });

        SOBERANO_CACHE.set(cacheKey, combined);
        return combined;
    } catch (e) {
        console.warn('[SOBERANO_CATALOG] Error:', e.message);
        return [];
    }
}

async function getSoberanoTorrentStreams(id, type = 'movie', s = 1, e = 1) {
    let imdbId = String(id || '').trim();
    const isTv = type === 'tv' || type === 'series';

    // Si viene como TMDB ID numérico, resolver IMDB ID primero
    if (/^\d+$/.test(imdbId)) {
        try {
            const extRes = await proxyTmdbRequest(`${isTv ? 'tv' : 'movie'}/${imdbId}/external_ids`, '');
            const extData = JSON.parse(extRes.body);
            if (extData.imdb_id) imdbId = extData.imdb_id;
        } catch(e) {}
    }

    const streamId = isTv ? `${imdbId}:${s}:${e}` : imdbId;
    const cacheKey = `sob_str_${streamId}`;
    if (SOBERANO_STREAMS_CACHE.has(cacheKey)) {
        return SOBERANO_STREAMS_CACHE.get(cacheKey);
    }

    const tUrl = `https://torrentio.strem.fun/stream/${isTv ? 'series' : 'movie'}/${streamId}.json`;
    try {
        const rawData = await fetchJson(tUrl, { 'User-Agent': 'Mozilla/5.0' }, 6500);
        const streams = (rawData && Array.isArray(rawData.streams)) ? rawData.streams : [];
        const parsed = streams.map(parseTorrentStream);

        // Clasificar y ordenar por prioridad: Seeds descendentes + Calidad 1080p/4K
        parsed.sort((a, b) => {
            if (b.seeds !== a.seeds) return b.seeds - a.seeds;
            const scoreQ = (q) => q === '4K' ? 3 : (q === '1080p' ? 2 : 1);
            return scoreQ(b.quality) - scoreQ(a.quality);
        });

        const out = {
            imdb_id: imdbId,
            stream_id: streamId,
            type: isTv ? 'tv' : 'movie',
            season: s,
            episode: e,
            total_torrents: parsed.length,
            streams: parsed
        };

        if (parsed.length > 0) {
            SOBERANO_STREAMS_CACHE.set(cacheKey, out);
        }
        return out;
    } catch (err) {
        console.warn(`[SOBERANO_STREAMS] Error fetching streams for ${streamId}:`, err.message);
        return {
            imdb_id: imdbId,
            stream_id: streamId,
            type: isTv ? 'tv' : 'movie',
            season: s,
            episode: e,
            total_torrents: 0,
            streams: []
        };
    }
}


// ==============================================================================
// 5. HTTP SERVER DISPATCHER
// ==============================================================================

const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const reqProto = (req.headers['x-forwarded-proto'] || (req.connection && req.connection.encrypted ? 'https' : 'http')).split(',')[0].trim();
    const reqHost = req.headers.host || `127.0.0.1:${PORT}`;
    const hostBase = `${reqProto}://${reqHost}`;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    // 0. SOBERANO PHANTOM-SWARM TORRENT SEARCH & STREAM ENDPOINTS ($0.00 USD)
    if (parsed.pathname === '/api/soberano/search') {
        const q = parsed.query.q || parsed.query.query || '';
        try {
            const results = await searchSoberanoCatalog(q);
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'public, max-age=1800',
                'Access-Control-Allow-Origin': '*'
            });
            return res.end(JSON.stringify({ status: 'ok', query: q, count: results.length, results: results }));
        } catch(eSob) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ status: 'error', message: eSob.message, results: [] }));
        }
    }

    if (parsed.pathname === '/api/soberano/streams') {
        const id = parsed.query.id || parsed.query.imdb_id || '';
        const type = parsed.query.type || 'movie';
        const s = parseInt(parsed.query.s || parsed.query.season || 1, 10) || 1;
        const e = parseInt(parsed.query.e || parsed.query.episode || 1, 10) || 1;
        try {
            const streamsData = await getSoberanoTorrentStreams(id, type, s, e);
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'public, max-age=900',
                'Access-Control-Allow-Origin': '*'
            });
            return res.end(JSON.stringify(streamsData));
        } catch(eStreams) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ status: 'error', message: eStreams.message, streams: [] }));
        }
    }

    if (parsed.pathname === '/api/soberano/play') {
        const id = parsed.query.id || parsed.query.imdb_id || '';
        const infoHash = (parsed.query.hash || parsed.query.infoHash || '').toLowerCase().trim();
        const fileIdx = parseInt(parsed.query.idx || parsed.query.fileIdx || -1, 10);
        const type = parsed.query.type || 'movie';
        const s = parseInt(parsed.query.s || parsed.query.season || 1, 10) || 1;
        const e = parseInt(parsed.query.e || parsed.query.episode || 1, 10) || 1;
        const title = parsed.query.title || '';
        const isEs = parsed.query.is_es === '1' || parsed.query.is_es === 'true';

        if (!infoHash) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ status: 'error', message: 'Falta infoHash del torrent seleccionado.' }));
        }

        // Resolver EXCLUSIVAMENTE el Torrent real en RAM + JIT HLS vía Mac M3 Daemon (puerto 9097)
        // PROHIBIDO hacer fallback al proveedor de películas/series (Cuevana/Framex)
        try {
            const daemonUrl = `http://${ALIGNER_HOST}:9097/api/torrent/resolve?hash=${encodeURIComponent(infoHash)}&fileIdx=${fileIdx}&name=${encodeURIComponent(title)}&is_es=${isEs ? '1' : '0'}`;
            const daemonRes = await fetchJson(daemonUrl, {}, 26000);
            if (daemonRes && daemonRes.status === 'ok') {
                const cleanHash = (daemonRes.infoHash || infoHash).toLowerCase();
                const directHlsUrl = `${reqProto}://${reqHost}/api/torrent/hls/${cleanHash}/index.m3u8`;

                res.writeHead(200, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'no-store',
                    'Access-Control-Allow-Origin': '*'
                });
                return res.end(JSON.stringify({
                    status: 'ok',
                    mode: 'torrent_p2p',
                    infoHash: cleanHash,
                    direct_stream_url: directHlsUrl,
                    name: daemonRes.name,
                    filename: daemonRes.filename,
                    sizeBytes: daemonRes.sizeBytes,
                    numPeers: daemonRes.numPeers,
                    videoCodec: daemonRes.videoCodec,
                    audioLang: daemonRes.audioLang,
                    hls_ready: daemonRes.hls_ready,
                    is_mkv: daemonRes.is_mkv
                }));
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({
                status: 'error',
                message: (daemonRes && daemonRes.message) || 'El torrent no tiene seeds disponibles en este momento. Prueba otro torrent de la lista.'
            }));
        } catch (eDaemon) {
            console.warn('[SOBERANO_PLAY] Error o timeout en daemon P2P Mac:', eDaemon.message);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({
                status: 'error',
                message: 'Tiempo agotado conectando con los seeds de este torrent. Selecciona otro torrent con más seeds.'
            }));
        }
    }

    // In-Manifest Master Playlist + HLS Proxy (.m3u8 y segmentos .ts) para Torrent P2P
    if (parsed.pathname.indexOf('/api/torrent/hls/') === 0) {
        const subHlsPath = parsed.pathname.replace(/^\/api\/torrent\/hls\//, '');
        const match = subHlsPath.match(/^([a-f0-9]{40})\/(.*)$/i);
        if (match) {
            const infoHash = match[1].toLowerCase();
            const relFile = match[2].split('?')[0];

            // 1. Multivariant Master Playlist nativo (#EXT-X-MEDIA:TYPE=SUBTITLES)
            // Garantiza que AirPlay 2 y el receptor del televisor LG carguen video y subtítulos
            // de forma nativa e inseparable sin recurrir a sideloading DOM en el móvil.
            if (relFile === 'index.m3u8') {
                const masterLines = [
                    '#EXTM3U',
                    '#EXT-X-VERSION:6',
                    '#EXT-X-INDEPENDENT-SEGMENTS',
                    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="es",NAME="Español",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI="sub.m3u8"',
                    '#EXT-X-STREAM-INF:BANDWIDTH=5500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",SUBTITLES="subs"',
                    'video.m3u8',
                    ''
                ].join('\n');
                res.writeHead(200, {
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    'Content-Length': Buffer.byteLength(masterLines),
                    'Cache-Control': 'no-store, no-cache, must-revalidate',
                    'Access-Control-Allow-Origin': '*'
                });
                return res.end(masterLines);
            }

            // 2. Subtitle Media Playlist generado dinámicamente y sincronizado con el video
            if (relFile === 'sub.m3u8') {
                try {
                    const upstreamVideoM3u8 = await fetchText(`http://${ALIGNER_HOST}:9097/hls/${infoHash}/index.m3u8`, {}, 8000);
                    if (!upstreamVideoM3u8) throw new Error('Video stream not ready');
                    const vLines = upstreamVideoM3u8.replace(/\r/g, '').split('\n');
                    const subLines = [
                        '#EXTM3U',
                        '#EXT-X-VERSION:6',
                        '#EXT-X-TARGETDURATION:4',
                        '#EXT-X-MEDIA-SEQUENCE:0',
                        '#EXT-X-PLAYLIST-TYPE:EVENT',
                        '#EXT-X-INDEPENDENT-SEGMENTS',
                        '#EXT-X-DISCONTINUITY'
                    ];
                    let segIdx = 0;
                    let cumTime = 0.0;
                    for (let i = 0; i < vLines.length; i++) {
                        const ln = vLines[i].trim();
                        if (ln.indexOf('#EXTINF:') === 0) {
                            const dur = parseFloat(ln.substring(8).replace(',', '')) || 4.0;
                            subLines.push(`#EXTINF:${dur.toFixed(6)},`);
                            subLines.push(`sub_seg.vtt?seg=${segIdx}&dur=${dur.toFixed(3)}&cum=${cumTime.toFixed(3)}`);
                            cumTime += dur;
                            segIdx++;
                        }
                    }
                    if (upstreamVideoM3u8.indexOf('#EXT-X-ENDLIST') !== -1) {
                        subLines.push('#EXT-X-ENDLIST');
                    }
                    subLines.push('');
                    const subM3u8Body = subLines.join('\n');
                    res.writeHead(200, {
                        'Content-Type': 'application/vnd.apple.mpegurl',
                        'Content-Length': Buffer.byteLength(subM3u8Body),
                        'Cache-Control': 'no-store, no-cache, must-revalidate',
                        'Access-Control-Allow-Origin': '*'
                    });
                    return res.end(subM3u8Body);
                } catch (eSub) {
                    console.warn('[SOBERANO_SUB_M3U8] Error generando sub.m3u8 para torrent:', eSub.message);
                    res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
                    return res.end('Error generando pista de subtítulos');
                }
            }

            // 3. Segmentos WebVTT alineados al fotograma con cabecera X-TIMESTAMP-MAP
            if (relFile === 'sub_seg.vtt') {
                const segIdx = parseInt(parsed.query.seg || '0', 10);
                const dur = parseFloat(parsed.query.dur || '4.0');
                const cumStart = parseFloat(parsed.query.cum || '0.0');
                const cumEnd = cumStart + dur;

                let localDiskPath = path.join(SUBTITLES_DIR, 'active_es.vtt');
                let matchedCues = [];
                if (fs.existsSync(localDiskPath)) {
                    try {
                        const content = fs.readFileSync(localDiskPath, 'utf8');
                        const cues = parseVttForHls(content);
                        matchedCues = cues.filter(c => c.end >= cumStart && c.start < cumEnd);
                    } catch (eC) {}
                }

                const vttOut = [
                    'WEBVTT',
                    'X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:126000',
                    ''
                ];
                for (let c = 0; c < matchedCues.length; c++) {
                    const item = matchedCues[c];
                    vttOut.push((c + 1).toString());
                    vttOut.push(`${formatVttTime(item.start)} --> ${formatVttTime(item.end)}`);
                    vttOut.push(item.text);
                    vttOut.push('');
                }
                const vttBuf = Buffer.from(vttOut.join('\n'), 'utf8');
                res.writeHead(200, {
                    'Content-Type': 'text/vtt; charset=utf-8',
                    'Content-Length': vttBuf.length,
                    'Cache-Control': 'public, max-age=3600',
                    'Access-Control-Allow-Origin': '*'
                });
                return res.end(vttBuf);
            }

            // 4. Mapeo del flujo de video real (video.m3u8 -> index.m3u8 en Mac M3)
            let proxyUpstreamPath = `/hls/${subHlsPath}`;
            if (relFile === 'video.m3u8') {
                proxyUpstreamPath = `/hls/${infoHash}/index.m3u8`;
            }

            const reqOpts = {
                hostname: ALIGNER_HOST,
                port: 9097,
                path: proxyUpstreamPath,
                method: req.method,
                headers: {}
            };

            const preq = http.request(reqOpts, (pres) => {
                const outHeaders = Object.assign({}, pres.headers, {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
                    'Access-Control-Allow-Headers': '*'
                });
                res.writeHead(pres.statusCode, outHeaders);
                pres.pipe(res);
            });

            preq.on('error', (err) => {
                console.warn('[TORRENT_HLS_PROXY] Error conectando con Mac torrent daemon:', err.message);
                if (!res.headersSent) {
                    res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
                    res.end('Error conectando con el motor HLS Torrent en RAM.');
                }
            });

            req.on('close', () => {
                try { preq.abort(); } catch (e) {}
            });

            preq.end();
            return;
        }
    }

    // Proxy para el flujo de streaming crudo del Torrent en RAM desde el Mac M3
    if (parsed.pathname === '/api/torrent/stream') {
        const streamPath = parsed.query.path || '';
        if (!streamPath) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            return res.end('Missing stream path');
        }
        const proxyHeaders = {};
        if (req.headers.range) proxyHeaders['range'] = req.headers.range;
        if (req.headers['accept-encoding']) proxyHeaders['accept-encoding'] = req.headers['accept-encoding'];

        const reqOpts = {
            hostname: ALIGNER_HOST,
            port: 9097,
            path: streamPath,
            method: req.method,
            headers: proxyHeaders
        };

        const preq = http.request(reqOpts, (pres) => {
            const outHeaders = Object.assign({}, pres.headers, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
                'Access-Control-Allow-Headers': '*'
            });
            res.writeHead(pres.statusCode, outHeaders);
            pres.pipe(res);
        });

        preq.on('error', (err) => {
            console.warn('[TORRENT_PROXY] Error conectando con Mac torrent daemon:', err.message);
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end('Error conectando con el motor Torrent en RAM.');
            }
        });

        req.on('close', () => {
            try { preq.abort(); } catch (e) {}
        });

        if (req.method === 'POST') req.pipe(preq);
        else preq.end();
        return;
    }

    // Health & Silicon Telemetry
    if (parsed.pathname === '/status' || parsed.pathname === '/stats') {
        let publicUrl = null;
        try {
            if (fs.existsSync('/media/developer/temp/public_url.txt')) {
                publicUrl = fs.readFileSync('/media/developer/temp/public_url.txt', 'utf8').trim();
            }
        } catch(e) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            status: 'ok',
            device: 'LG_webOS_SmartTV_OnDevice',
            engine: 'Node.js 8.12 (ARMv7 Realtek)',
            service: 'com.soberano.appletvhub.service',
            tunnel_url: publicUrl,
            catalog_animes_total: 5059,
            cached_pages: CATALOG_CACHE.size,
            cached_streams: STREAM_CACHE.size,
            cached_segments: RAM_SEGMENT_CACHE.size,
            cached_segment_bytes: TOTAL_CACHE_BYTES,
            memory: process.memoryUsage(),
            timestamp: Date.now()
        }));
    }

    // Cloudflare Remote Access Tunnel Telemetry
    if (parsed.pathname === '/api/tunnel' || parsed.pathname === '/tunnel') {
        let publicUrl = null;
        try {
            if (fs.existsSync('/media/developer/temp/public_url.txt')) {
                publicUrl = fs.readFileSync('/media/developer/temp/public_url.txt', 'utf8').trim();
            }
        } catch(e) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            status: publicUrl ? 'active' : 'inactive',
            tunnel_url: publicUrl,
            remote_access: publicUrl ? `${publicUrl}/ipad` : null,
            device: 'LG_webOS_SmartTV_OnDevice'
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

    // WebVTT Subtitles (CORS-enabled + HLS X-TIMESTAMP-MAP for AirPlay 2)
    if (parsed.pathname.indexOf('/subtitles/') === 0) {
        const subName = path.basename(parsed.pathname);
        const subPath = path.join(SUBTITLES_DIR, subName);
        if (fs.existsSync(subPath)) {
            let vtt = fs.readFileSync(subPath, 'utf8');
            if (!vtt.includes('X-TIMESTAMP-MAP')) {
                vtt = vtt.replace(/^WEBVTT[^\n]*\n/, 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:126000,LOCAL:00:00:00.000\n');
            }
            const buf = Buffer.from(vtt, 'utf8');
            res.writeHead(200, {
                'Content-Type': 'text/vtt; charset=utf-8',
                'Content-Length': buf.length,
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*'
            });
            return res.end(buf);
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
            return res.end('Subtitle not found');
        }
    }

    // Helper para parsear VTT en cues para segmentación HLS (compatible con Node 8+)
    function parseVttForHls(vttText) {
        if (!vttText) return [];
        var lines = vttText.replace(/\r/g, '').split('\n');
        var cues = [];
        var i = 0;
        while (i < lines.length && lines[i].indexOf('-->') === -1) i++;
        while (i < lines.length) {
            if (lines[i].indexOf('-->') !== -1) {
                var parts = lines[i].split('-->');
                var startSec = parseVttSec(parts[0].trim());
                var endSec = parseVttSec(parts[1].trim().split(' ')[0]);
                var textLines = [];
                i++;
                while (i < lines.length && lines[i].trim() !== '' && lines[i].indexOf('-->') === -1) {
                    textLines.push(lines[i]);
                    i++;
                }
                cues.push({ start: startSec, end: endSec, text: textLines.join('\n') });
            } else {
                i++;
            }
        }
        return cues;
    }

    function parseVttSec(t) {
        if (!t) return 0;
        var parts = t.split(':');
        if (parts.length === 3) {
            return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2].replace(',', '.'));
        } else if (parts.length === 2) {
            return parseFloat(parts[0]) * 60 + parseFloat(parts[1].replace(',', '.'));
        }
        return 0;
    }

    function formatVttTime(sec) {
        var h = Math.floor(sec / 3600);
        var m = Math.floor((sec % 3600) / 60);
        var s = (sec % 60).toFixed(3);
        var hh = (h < 10 ? '0' : '') + h;
        var mm = (m < 10 ? '0' : '') + m;
        var ss = (parseFloat(s) < 10 ? '0' : '') + s;
        return hh + ':' + mm + ':' + ss;
    }

    // AirPlay 2 Native HLS Subtitle Media Playlist (RFC 8216 & Apple Authoring Spec)
    if (parsed.pathname === '/api/hls_sub_media.m3u8') {
        const subUrl = parsed.query.sub || `${hostBase}/subtitles/active_es.vtt`;
        const segDur = 4.0;
        let maxTime = 7200; // 2 horas por defecto
        const subName = path.basename(url.parse(subUrl).pathname || 'active_es.vtt');
        let localDiskPath = path.join(SUBTITLES_DIR, subName);
        if (!fs.existsSync(localDiskPath)) {
            localDiskPath = path.join(SUBTITLES_DIR, 'active_es.vtt');
        }
        if (fs.existsSync(localDiskPath)) {
            try {
                const content = fs.readFileSync(localDiskPath, 'utf8');
                const cues = parseVttForHls(content);
                if (cues.length > 0) {
                    maxTime = Math.max(3600, cues[cues.length - 1].end + 30);
                }
            } catch (eSubRead) {}
        }
        const totalSegs = Math.ceil(maxTime / segDur);
        const mediaLines = [
            '#EXTM3U',
            '#EXT-X-VERSION:4',
            '#EXT-X-TARGETDURATION:4',
            '#EXT-X-MEDIA-SEQUENCE:0',
            '#EXT-X-PLAYLIST-TYPE:VOD'
        ];
        for (let s = 0; s < totalSegs; s++) {
            mediaLines.push('#EXTINF:4.000000,');
            mediaLines.push(`${hostBase}/api/hls_sub_segment.vtt?sub=${encodeURIComponent(subUrl)}&seg=${s}`);
        }
        mediaLines.push('#EXT-X-ENDLIST');
        mediaLines.push('');
        const mediaM3u8 = mediaLines.join('\n');
        res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Content-Length': Buffer.byteLength(mediaM3u8),
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Access-Control-Allow-Origin': '*'
        });
        return res.end(mediaM3u8);
    }

    // AirPlay 2 Native HLS WebVTT Segment Delivery (Apple HLS Authoring Spec)
    if (parsed.pathname === '/api/hls_sub_segment.vtt') {
        const subUrl = parsed.query.sub || `${hostBase}/subtitles/active_es.vtt`;
        const segIdx = parseInt(parsed.query.seg || '0', 10);
        const segDur = 4.0;
        const segStart = segIdx * segDur;
        const segEnd = (segIdx + 1) * segDur;
        
        const subName = path.basename(url.parse(subUrl).pathname || 'active_es.vtt');
        let localDiskPath = path.join(SUBTITLES_DIR, subName);
        if (!fs.existsSync(localDiskPath)) {
            localDiskPath = path.join(SUBTITLES_DIR, 'active_es.vtt');
        }
        let matchedCues = [];
        if (fs.existsSync(localDiskPath)) {
            try {
                const content = fs.readFileSync(localDiskPath, 'utf8');
                const cues = parseVttForHls(content);
                matchedCues = cues.filter(c => c.end >= segStart && c.start < segEnd);
            } catch (eCues) {}
        }

        const vttOut = [
            'WEBVTT',
            'X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:126000',
            ''
        ];
        for (let c = 0; c < matchedCues.length; c++) {
            const item = matchedCues[c];
            vttOut.push((c + 1).toString());
            vttOut.push(`${formatVttTime(item.start)} --> ${formatVttTime(item.end)}`);
            vttOut.push(item.text);
            vttOut.push('');
        }
        const vttBuf = Buffer.from(vttOut.join('\n'), 'utf8');
        res.writeHead(200, {
            'Content-Type': 'text/vtt; charset=utf-8',
            'Content-Length': vttBuf.length,
            'Cache-Control': 'public, max-age=3600',
            'Access-Control-Allow-Origin': '*'
        });
        return res.end(vttBuf);
    }

    // AirPlay 2 Native HLS Master Playlist Injector (#EXT-X-MEDIA:TYPE=SUBTITLES)
    // Garantiza que al enviar por AirPlay desde iPhone/iPad a Smart TV / Apple TV,
    // el receptor AirPlay 2 cargue y muestre los subtítulos en español directamente desde el manifiesto HLS.
    if (parsed.pathname === '/api/hls_sub_master.m3u8') {
        const streamUrl = parsed.query.stream || '';
        const subUrl = parsed.query.sub || `${hostBase}/subtitles/active_es.vtt`;
        if (!streamUrl) {
            res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
            return res.end('Missing stream parameter');
        }

        const subMediaUri = `${hostBase}/api/hls_sub_media.m3u8?sub=${encodeURIComponent(subUrl)}`;
        const mediaTag = `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="es",NAME="Español",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI="${subMediaUri}"`;

        // Si no es un manifiesto maestro externo (ej. Torrent HLS o Media Playlist directo), envolver en Master Playlist
        if (streamUrl.indexOf('/api/torrent/hls/') !== -1 || streamUrl.indexOf('/stream.m3u8') !== -1) {
            const masterM3u8 = [
                '#EXTM3U',
                '#EXT-X-VERSION:4',
                '#EXT-X-INDEPENDENT-SEGMENTS',
                mediaTag,
                '#EXT-X-STREAM-INF:BANDWIDTH=5500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",SUBTITLES="subs"',
                streamUrl,
                ''
            ].join('\n');
            res.writeHead(200, {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*'
            });
            return res.end(masterM3u8);
        }

        try {
            const upstreamText = await fetchText(streamUrl, {}, 4500);
            if (upstreamText && upstreamText.indexOf('#EXT-X-STREAM-INF') !== -1) {
                const parsedUp = url.parse(streamUrl);
                const baseUp = `${parsedUp.protocol}//${parsedUp.host}${path.dirname(parsedUp.pathname)}/`;
                const lines = upstreamText.replace(/\r/g, '').split('\n');
                const outLines = ['#EXTM3U', '#EXT-X-VERSION:4', mediaTag];
                for (let i = 0; i < lines.length; i++) {
                    const ln = lines[i].trim();
                    if (!ln || ln === '#EXTM3U' || ln.indexOf('#EXT-X-VERSION') === 0 || ln.indexOf('#EXT-X-MEDIA:TYPE=SUBTITLES') === 0) continue;
                    if (ln.indexOf('#EXT-X-STREAM-INF:') === 0) {
                        const cleanedInf = ln.replace(/,?\s*SUBTITLES="[^"]*"/g, '');
                        outLines.push(`${cleanedInf},SUBTITLES="subs"`);
                    } else if (ln.indexOf('#') === 0) {
                        outLines.push(ln);
                    } else {
                        const absVariant = (ln.indexOf('http://') === 0 || ln.indexOf('https://') === 0) ? ln : url.resolve(baseUp, ln);
                        outLines.push(absVariant);
                    }
                }
                res.writeHead(200, {
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    'Cache-Control': 'no-store',
                    'Access-Control-Allow-Origin': '*'
                });
                return res.end(outLines.join('\n') + '\n');
            }
        } catch (eUp) {}

        const fallbackMaster = [
            '#EXTM3U',
            '#EXT-X-VERSION:4',
            mediaTag,
            '#EXT-X-STREAM-INF:BANDWIDTH=5500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",SUBTITLES="subs"',
            streamUrl,
            ''
        ].join('\n');
        res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*'
        });
        return res.end(fallbackMaster);
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
            const isDynamicSeries = subpath.startsWith('tv/') || subpath.includes('trending') || subpath.includes('airing') || subpath.includes('now_playing');
            res.writeHead(tmdbRes.statusCode || 200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': isDynamicSeries ? 'public, max-age=300' : 'public, max-age=1800',
                'Access-Control-Allow-Origin': '*'
            });
            return res.end(tmdbRes.body);
        } catch (e) {
            res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ results: [], error: e.message }));
        }
    }

    // 8. TMDB Stream Resolver (Movies & TV Series)
    if (parsed.pathname === '/api/resolve_tmdb') {
        const id = parsed.query.id || '';
        const type = parsed.query.type || 'movie';
        const s = parsed.query.s || parsed.query.season || 1;
        const e = parsed.query.e || parsed.query.episode || 1;
        const forceRefresh = parsed.query.refresh === '1' || parsed.query.refresh === 'true';

        try {
            const origLang = parsed.query.orig_lang || 'en';
            const expectedTitle = parsed.query.title || '';
            const expectedOrigTitle = parsed.query.orig_title || '';
            const streamData = await resolveTmdbStream(id, type, s, e, reqHost, origLang, expectedTitle, expectedOrigTitle, forceRefresh, reqProto);
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

    // 8.0 Automated On-Demand Spanish Subtitle Search & Anchor API ($0.00 USD)
    // Busca, valida lingüísticamente en español y convierte a WebVTT bajo demanda cuando el usuario presiona el botón de subtítulos
    if (parsed.pathname === '/api/subtitles/auto' || parsed.pathname === '/api/sub_auto') {
        try {
            const subRes = await resolveAutoSpanishSubtitle(parsed.query || {}, reqHost, reqProto);
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*'
            });
            return res.end(JSON.stringify(subRes));
        } catch (errAuto) {
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*'
            });
            return res.end(JSON.stringify({ status: 'error', message: errAuto.message }));
        }
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
            data = resolveNinku(ep, reqHost, reqProto);
        } else {
            data = await resolveJkStream(slug, ep, reqHost, reqProto);
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
                    return `${hostBase}/stream.m3u8?url=${encodeURIComponent(variantUrl)}`;
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
                return `${hostBase}/stream?url=${encodeURIComponent(fullSegUrl)}`;
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
