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
