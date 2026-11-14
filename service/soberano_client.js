// ==============================================================================
// SOBERANO PHANTOM-SWARM CLIENT ENGINE (Universal Torrents on HTTPS Port 443)
// ==============================================================================
let soberanoLoaded = false;
let activeSoberanoItem = null;
let activeSoberanoStreams = [];

async function loadSoberanoView(forceRefresh = false) {
    if (soberanoLoaded && !forceRefresh) return;
    soberanoLoaded = true;

    // Fila 1: Torrents Top Tendencias Globales (Películas 4K HDR)
    fetchAndRenderSoberanoRow('https://v3-cinemeta.strem.io/catalog/movie/top.json', 'trackSoberanoTopMovies', 'movie');

    // Fila 2: Series y Anime en Tendencia
    fetchAndRenderSoberanoRow('https://v3-cinemeta.strem.io/catalog/series/top.json', 'trackSoberanoTopSeries', 'tv');
}

async function fetchAndRenderSoberanoRow(url, containerId, mediaType) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '<div style="color:var(--text-muted); padding:20px;"><i class="fa fa-spinner fa-spin"></i> Cargando enjambre global...</div>';

    try {
        const resp = await fetch(url);
        const data = await resp.json();
        const metas = (data && Array.isArray(data.metas)) ? data.metas : [];

        if (metas.length === 0) {
            container.innerHTML = '<div style="color:var(--text-muted); padding:20px;">No hay títulos disponibles</div>';
            return;
        }

        container.innerHTML = '';
        metas.slice(0, 18).forEach(item => {
            const card = createSoberanoCard(item, mediaType);
            container.appendChild(card);
        });
    } catch (e) {
        container.innerHTML = `<div style="color:var(--text-muted); padding:20px;">Error conectando al enjambre: ${e.message}</div>`;
    }
}

function createSoberanoCard(item, mediaType = 'movie') {
    const card = document.createElement('div');
    card.className = 'tv-card';
    card.tabIndex = 0;

    const title = item.name || item.title || 'Sin título';
    const poster = item.poster || getCanonicalPoster('', title);
    const year = (item.releaseInfo || item.year || '').substring(0, 4);

    card.onclick = () => openSoberanoSwarmModal(item, mediaType);
    card.onkeydown = (e) => {
        if (e.key === 'Enter') openSoberanoSwarmModal(item, mediaType);
    };

    card.innerHTML = `
        <div class="poster-container">
            <img class="poster-img" src="${poster}" alt="${escapeHtml(title)}" loading="lazy" onerror="handleImageError(this)">
            <span class="card-pill-tag" style="background:rgba(217,70,239,0.7);"><i class="fa fa-infinity"></i> Torrent</span>
            <div class="card-play-hover-icon"><i class="fa fa-play"></i></div>
        </div>
        <div class="poster-info">
            <div class="poster-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
            <div class="poster-sub">${year ? year + ' • ' : ''}Enjambre 4K/HD</div>
        </div>
    `;
    return card;
}

function onSoberanoSearchInputChange(val) {
    const clearBtn = document.getElementById('btnSoberanoSearchClear');
    if (clearBtn) {
        clearBtn.style.display = (val && val.trim().length > 0) ? 'inline-flex' : 'none';
    }
}

function clearSoberanoSearch() {
    const input = document.getElementById('soberanoSearchInput');
    if (input) {
        input.value = '';
        input.focus();
    }
    const clearBtn = document.getElementById('btnSoberanoSearchClear');
    if (clearBtn) clearBtn.style.display = 'none';
    const secResults = document.getElementById('sectionSoberanoResults');
    if (secResults) secResults.style.display = 'none';
}

function quickSoberanoSearch(term) {
    const input = document.getElementById('soberanoSearchInput');
    if (input) {
        input.value = term;
        onSoberanoSearchInputChange(term);
        executeSoberanoSearch();
    }
}

async function executeSoberanoSearch() {
    const input = document.getElementById('soberanoSearchInput');
    const query = input ? input.value.trim() : '';
    if (!query) return;

    // Detección de Magnet Link o InfoHash pegado directamente
    if (query.startsWith('magnet:') || /^[a-fA-F0-9]{40}$/.test(query)) {
        showToast('🧲 Enlace Magnet / InfoHash detectado. Abriendo enjambre...');
        const customTorrent = {
            id: query,
            name: 'Torrente Personal (Magnet)',
            title: query.slice(0, 40) + '...',
            poster: '',
            releaseInfo: 'P2P'
        };
        openSoberanoSwarmModal(customTorrent, 'movie');
        return;
    }

    const secResults = document.getElementById('sectionSoberanoResults');
    const grid = document.getElementById('gridSoberanoResults');
    const titleEl = document.getElementById('soberanoResultsTitle');
    const countEl = document.getElementById('soberanoResultsCount');

    if (secResults) secResults.style.display = 'block';
    if (grid) grid.innerHTML = '<div style="color:var(--text-muted); padding:40px; grid-column:1/-1; text-align:center;"><i class="fa fa-spinner fa-spin fa-2x"></i><p style="margin-top:10px;">Buscando en catálogo global de torrents...</p></div>';
    if (titleEl) titleEl.innerHTML = `<i class="fa fa-search" style="color:#e879f9;"></i> Resultados para "${escapeHtml(query)}"`;

    try {
        const resp = await fetch(`${PROXY_BASE}/api/soberano/search?q=${encodeURIComponent(query)}`);
        const data = await resp.json();
        const results = (data && Array.isArray(data.results)) ? data.results : [];

        if (countEl) countEl.textContent = `${results.length} encontrados`;

        if (results.length === 0) {
            grid.innerHTML = '<div style="color:var(--text-muted); padding:40px; grid-column:1/-1; text-align:center;">No se encontraron títulos en el enjambre para esta búsqueda.</div>';
            return;
        }

        grid.innerHTML = '';
        results.forEach(res => {
            const card = createSoberanoCard({
                id: res.id,
                name: res.title,
                poster: res.poster,
                releaseInfo: res.year
            }, res.type);
            grid.appendChild(card);
        });

        secResults.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
        if (grid) grid.innerHTML = `<div style="color:var(--text-muted); padding:40px; grid-column:1/-1; text-align:center;">Error en búsqueda: ${err.message}</div>`;
    }
}

async function openSoberanoSwarmModal(item, mediaType = 'movie') {
    activeSoberanoItem = { ...item, mediaType: mediaType };
    const modal = document.getElementById('soberanoSwarmModal');
    const titleEl = document.getElementById('soberanoSwarmTitle');
    const bannerEl = document.getElementById('soberanoSwarmBanner');
    const typeBadge = document.getElementById('soberanoSwarmTypeBadge');
    const epBar = document.getElementById('soberanoEpisodeSelectorBar');
    const listEl = document.getElementById('soberanoTorrentList');
    const countBadge = document.getElementById('soberanoTorrentCountBadge');

    const title = item.name || item.title || 'Sin título';
    const banner = item.backdrop || item.poster || getCanonicalPoster('', title);

    if (titleEl) titleEl.textContent = title;
    if (bannerEl) bannerEl.src = banner;
    if (typeBadge) typeBadge.textContent = mediaType === 'tv' ? '📺 Serie / Anime' : '🎬 Película';
    if (countBadge) countBadge.textContent = 'Consultando enjambre...';
    if (listEl) listEl.innerHTML = '<div style="color:var(--text-muted); padding:30px; text-align:center;"><i class="fa fa-spinner fa-spin fa-2x"></i><p style="margin-top:10px;">Consultando enjambre global de torrents...</p></div>';

    modal.classList.add('active');

    // Configuración del selector de Episodios si es Serie o Anime
    if (mediaType === 'tv' && epBar) {
        epBar.style.display = 'block';
        initSoberanoSeasonEpisodeSelectors(item);
    } else if (epBar) {
        epBar.style.display = 'none';
        loadSoberanoTorrentList(item.id, 'movie', 1, 1);
    }
}

function closeSoberanoSwarmModal(e) {
    if (e && e.target !== document.getElementById('soberanoSwarmModal') && !e.target.closest('.sheet-close-btn')) return;
    const modal = document.getElementById('soberanoSwarmModal');
    if (modal) modal.classList.remove('active');
}

async function initSoberanoSeasonEpisodeSelectors(item) {
    const sSelect = document.getElementById('soberanoSeasonSelect');
    const eSelect = document.getElementById('soberanoEpisodeSelect');
    if (!sSelect || !eSelect) return;

    sSelect.innerHTML = '';
    eSelect.innerHTML = '';

    // Consultar metadatos en Cinemeta para saber total de temporadas y episodios
    try {
        const resp = await fetch(`https://v3-cinemeta.strem.io/meta/series/${item.id}.json`);
        const data = await resp.json();
        const videos = (data && data.meta && Array.isArray(data.meta.videos)) ? data.meta.videos : [];

        const seasonsSet = new Set();
        videos.forEach(v => { if (v.season) seasonsSet.add(v.season); });
        const seasons = Array.from(seasonsSet).sort((a, b) => a - b);

        if (seasons.length === 0) seasons.push(1);

        seasons.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s;
            opt.textContent = `Temporada ${s}`;
            sSelect.appendChild(opt);
        });

        // Poblado de episodios para temporada 1
        updateSoberanoEpisodeDropdown(videos, seasons[0]);

        sSelect.onchange = () => {
            const currentSeason = parseInt(sSelect.value, 10) || 1;
            updateSoberanoEpisodeDropdown(videos, currentSeason);
            onSoberanoSeasonEpisodeChange();
        };

        // Cargar torrents del episodio 1 temporada 1
        loadSoberanoTorrentList(item.id, 'tv', seasons[0], 1);
    } catch (e) {
        // Fallback genérico: 5 temporadas, 24 episodios
        for (let s = 1; s <= 5; s++) {
            const opt = document.createElement('option');
            opt.value = s;
            opt.textContent = `Temporada ${s}`;
            sSelect.appendChild(opt);
        }
        for (let ep = 1; ep <= 24; ep++) {
            const opt = document.createElement('option');
            opt.value = ep;
            opt.textContent = `Episodio ${ep}`;
            eSelect.appendChild(opt);
        }
        loadSoberanoTorrentList(item.id, 'tv', 1, 1);
    }
}

function updateSoberanoEpisodeDropdown(videos, targetSeason) {
    const eSelect = document.getElementById('soberanoEpisodeSelect');
    if (!eSelect) return;
    eSelect.innerHTML = '';

    const epsInSeason = videos.filter(v => v.season === targetSeason);
    const count = epsInSeason.length > 0 ? epsInSeason.length : 24;

    for (let i = 1; i <= count; i++) {
        const opt = document.createElement('option');
        opt.value = i;
        const vObj = epsInSeason.find(v => v.episode === i || v.number === i);
        opt.textContent = `Episodio ${i}${vObj && vObj.name ? ': ' + vObj.name : ''}`;
        eSelect.appendChild(opt);
    }
}

function onSoberanoSeasonEpisodeChange() {
    if (!activeSoberanoItem) return;
    const sSelect = document.getElementById('soberanoSeasonSelect');
    const eSelect = document.getElementById('soberanoEpisodeSelect');
    const s = parseInt(sSelect ? sSelect.value : 1, 10) || 1;
    const e = parseInt(eSelect ? eSelect.value : 1, 10) || 1;

    loadSoberanoTorrentList(activeSoberanoItem.id, 'tv', s, e);
}

async function loadSoberanoTorrentList(id, type = 'movie', s = 1, e = 1) {
    const listEl = document.getElementById('soberanoTorrentList');
    const countBadge = document.getElementById('soberanoTorrentCountBadge');
    if (!listEl) return;

    listEl.innerHTML = '<div style="color:var(--text-muted); padding:30px; text-align:center;"><i class="fa fa-spinner fa-spin fa-2x"></i><p style="margin-top:10px;">Consultando enjambre global de torrents...</p></div>';

    try {
        const resp = await fetch(`${PROXY_BASE}/api/soberano/streams?id=${encodeURIComponent(id)}&type=${type}&s=${s}&e=${e}`);
        const data = await resp.json();
        const streams = (data && Array.isArray(data.streams)) ? data.streams : [];
        activeSoberanoStreams = streams;

        if (countBadge) countBadge.textContent = `${streams.length} torrents en vivo`;

        if (streams.length === 0) {
            listEl.innerHTML = '<div style="color:var(--text-muted); padding:30px; text-align:center;">No se encontraron torrents activos para este contenido por el momento.</div>';
            return;
        }

        let html = '';
        streams.forEach((stream, idx) => {
            const isTopSeeds = idx === 0 && stream.seeds > 10;
            const seedBadgeClass = stream.seeds > 50 ? 'style="color:#30d158; font-weight:700;"' : (stream.seeds > 10 ? 'style="color:#0a84ff;"' : 'style="color:#ff9f0a;"');
            const langIcon = stream.is_es ? '🇪🇸 Español' : (stream.is_dual ? '🌐 Dual Audio' : '🇺🇸 VO');
            const qualityClass = stream.quality === '4K' ? 'style="background:rgba(217,70,239,0.25); color:#f0abfc; font-weight:800;"' : 'style="background:rgba(56,189,248,0.2); color:#38bdf8;"';

            html += `
                <div class="soberano-torrent-item" onclick="playSoberanoTorrent(${idx})" style="display:flex; justify-content:space-between; align-items:center; padding:12px 16px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:12px; cursor:pointer; transition:all 0.2s;" onmouseover="this.style.background='rgba(217,70,239,0.12)'; this.style.borderColor='rgba(217,70,239,0.4)';" onmouseout="this.style.background='rgba(255,255,255,0.04)'; this.style.borderColor='rgba(255,255,255,0.08)';">
                    <div style="flex:1; margin-right:14px; min-width:0;">
                        <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px; flex-wrap:wrap;">
                            <span class="meta-badge" ${qualityClass}>${stream.quality}</span>
                            ${stream.is_hdr ? '<span class="meta-badge" style="background:rgba(255,159,10,0.2); color:#ff9f0a; font-weight:700;">HDR / DV</span>' : ''}
                            <span class="meta-badge" style="background:rgba(255,255,255,0.08);">${langIcon}</span>
                            <span class="meta-badge" ${seedBadgeClass}><i class="fa fa-users"></i> ${stream.seeds} seeds</span>
                            ${stream.size ? `<span class="meta-badge" style="background:rgba(255,255,255,0.08); color:var(--text-muted);"><i class="fa fa-hdd"></i> ${stream.size}</span>` : ''}
                            ${isTopSeeds ? '<span class="meta-badge" style="background:rgba(48,209,88,0.25); color:#30d158; font-weight:700;"><i class="fa fa-bolt"></i> Máxima Velocidad</span>' : ''}
                        </div>
                        <div style="font-size:13px; font-weight:600; color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(stream.title || stream.filename)}">
                            ${escapeHtml(stream.title || stream.filename)}
                        </div>
                        <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">
                            ${escapeHtml(stream.tracker || 'P2P')} • ${stream.name || 'Torrentio'}
                        </div>
                    </div>
                    <button class="btn-apple-primary" style="padding:8px 16px; font-size:13px; display:inline-flex; align-items:center; gap:6px; flex-shrink:0; background:linear-gradient(135deg, #d946ef, #8b5cf6);">
                        <i class="fa fa-play"></i> RAM Play
                    </button>
                </div>
            `;
        });

        listEl.innerHTML = html;
    } catch (e) {
        listEl.innerHTML = `<div style="color:var(--text-muted); padding:30px; text-align:center;">Error consultando torrents: ${e.message}</div>`;
    }
}

async function playSoberanoTorrent(streamIdx) {
    if (!activeSoberanoItem || !activeSoberanoStreams || !activeSoberanoStreams[streamIdx]) return;
    const stream = activeSoberanoStreams[streamIdx];
    const sSelect = document.getElementById('soberanoSeasonSelect');
    const eSelect = document.getElementById('soberanoEpisodeSelect');
    const s = parseInt(sSelect ? sSelect.value : 1, 10) || 1;
    const e = parseInt(eSelect ? eSelect.value : 1, 10) || 1;

    showToast(`⚡ Conectando Transmutador HTTPS para [${stream.quality}] • ${stream.seeds} seeds...`);
    closeSoberanoSwarmModal();

    const title = activeSoberanoItem.name || activeSoberanoItem.title || '';
    const type = activeSoberanoItem.mediaType || 'movie';

    // Lanzar reproducción universal transmutada a través de resolveTmdbPlayback
    const fakeTmdbItem = {
        id: activeSoberanoItem.id,
        tmdb_id: activeSoberanoItem.id,
        title: title,
        name: title,
        poster_path: activeSoberanoItem.poster || '',
        backdrop_path: activeSoberanoItem.backdrop || '',
        media_type: type
    };

    launchTmdbPlayback(fakeTmdbItem, type === 'tv' ? s : null, type === 'tv' ? e : null, 'direct_native');
}
