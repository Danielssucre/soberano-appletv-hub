#📘 Documentación Técnica Detallada de Cambios — Soberano Apple TV Hub

Este documento explica **punto por punto** cada cambio, corrección y subsistema agregado recientemente al repositorio, incluyendo **para qué sirve**, **cómo funciona internamente** y **dónde vive cada archivo/función** para futuras referencias o restauraciones.

---

## 🗺️ Índice Rápido de Arquitectura

```text
┌─────────────────────────────────────────────────────────────────────────┐
│  LG Smart TV (webOS 5.6 - ARMv7 Realtek)                                │
│                                                                         │
│  1. App instalada: com.soberano.appletvhub                              │
│     └─ index.html (Bootstrapper nativo con PalmServiceBridge)           │
│        └─ Despierta com.soberano.appletvhub.service y abre :9099/ipad   │
│                                                                         │
│  2. Servicio webOS: com.soberano.appletvhub.service (Puerto 9099)       │
│     └─ service/service.js (Node.js 8.12)                                │
│        ├─ Sirve app/index.html (como ipad_vault.html sin caché)         │
│        ├─ Federación Torrents (Torrentio + trackers españoles)          │
│        ├─ Motor de Subtítulos (/api/subtitles/auto + OpenSubtitles)     │
│        └─ Proxy HLS + Caché RAM (45 MB) para Anime / Series / Películas │
└─────────────────────────────────▲───────────────────────────────────────┘
                                  │ Red LAN (HTTP + Descubrimiento ARP)
┌─────────────────────────────────▼───────────────────────────────────────┐
│  Mac Apple Silicon M3 (Motor P2P y Transcodificación Hardware)          │
│                                                                         │
│  3. Demonio Torrents: service/soberano_torrent_daemon.js (Puerto 9097)  │
│     ├─ WebTorrent en memoria RAM pura (BoundedRamChunkStore)            │
│     ├─ Transmuxing JIT a HLS con VideoToolbox (h264_videotoolbox + AAC) │
│     ├─ Burn-in opcional para AirPlay (service/gen_sub_pngs.py + FFmpeg) │
│     └─ Auto-anuncio a la TV vía ARP (MAC 58:fd:b1) cada 30 s            │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Despliegue Permanente en TV (IPK webOS + Auto-Arranque sin Surge.sh)

### 📂 Archivos involucrados
* [`deploy_to_tv.sh`](deploy_to_tv.sh)
* [`service/service.js`](service/service.js) (`findIpadVaultHtml`, `resolveWritableSubtitlesDir`)
* [`assets/icon.png`](assets/icon.png) y [`assets/largeIcon.png`](assets/largeIcon.png)

### 🎯 ¿Para qué sirve?
Evita que la TV vuelva a una interfaz vieja (`surge.sh`) cuando se apaga, se reinicia o cambia de IP por DHCP. Antes, las actualizaciones solo se copiaban a `/media/developer/temp/`, que es volátil al reiniciar la TV; el paquete IPK instalado seguía siendo del 1 de noviembre y carecía de `webOSTV.js`, por lo que al fallar el arranque redirigía a `https://soberano-apple.surge.sh/`.

### ⚙️ ¿Cómo funciona?
1. **Bootstrapper nativo con `PalmServiceBridge` (`deploy_to_tv.sh`):**
   * Al ejecutar `./deploy_to_tv.sh`, el script detecta automáticamente la IP actual de la TV buscando la MAC `58:fd:b1` (LG Electronics) en `arp -a` (o en `ares-setup-device`).
   * Empaqueta un IPK completo con `ares-package` que incluye la UI más reciente (`app/index.html` copiado como `ipad_vault.html`), el servicio (`service/service.js`), los íconos (`assets/*.png`) y un cargador ligero `index.html`.
   * Cuando abres la app en la TV, ese cargador usa la API nativa **`window.PalmServiceBridge`** (integrada en `WebAppMgr` de webOS, sin librerías externas) para invocar `luna://com.soberano.appletvhub.service/heartbeat` con `{ subscribe: true }`.
   * Sondea `http://127.0.0.1:9099/status` cada `250 ms` (hasta 24 intentos / 6 s) y apenas responde `200 OK` navega a `http://127.0.0.1:9099/ipad?v=<timestamp>`. Ya no cae en `surge.sh`.
2. **Selección de la UI más reciente y sin caché (`service/service.js`):**
   * [`findIpadVaultHtml()`](service/service.js) inspecciona todas las rutas posibles (`/media/developer/temp/ipad_vault.html`, carpeta del servicio y carpeta de la app), compara su fecha de modificación (`statSync(p).mtimeMs`) y sirve **siempre el archivo más reciente**.
   * La ruta HTTP `/`, `/ipad`, `/tablet` responde con encabezados `Cache-Control: no-store, no-cache, must-revalidate`, `Pragma: no-cache` y `Expires: 0` para impedir que el navegador de webOS muestre código viejo en caché.
3. **Directorio de subtítulos con respaldo de escritura (`resolveWritableSubtitlesDir()`):**
   * Verifica en arranque cuál carpeta permite escritura (`/media/developer/temp/subtitles`, `__dirname/subtitles`, o `/tmp/soberano_subtitles`) realizando un `.write_probe` real, garantizando que guardar archivos `.vtt` nunca falle por permisos de sistema en webOS.

---

## 2. Descubrimiento Dinámico de IPs en Red Local (Sin IPs Hardcodeadas)

### 📂 Archivos involucrados
* [`service/service.js`](service/service.js) (`getLocalLanIp`)
* [`service/soberano_torrent_daemon.js`](service/soberano_torrent_daemon.js) (`announceToTv`)
* [`deploy_to_tv.sh`](deploy_to_tv.sh)

### 🎯 ¿Para qué sirve?
El router asigna IPs dinámicas por DHCP (por ejemplo, la TV pasó de `192.168.128.8` a `192.168.128.11`). Si una IP queda escrita de forma fija en el código, la TV y la Mac dejan de encontrarse al pedir subtítulos o streams P2P.

### ⚙️ ¿Cómo funciona?
* **En la TV ([`getLocalLanIp()`](service/service.js)):** Lee `os.networkInterfaces()` de Node.js para devolver dinámicamente la IPv4 real de la interfaz activa de la TV (`eth0` / Wi-Fi) cuando construye URLs internas como `burnSubUrl`.
* **En la Mac ([`announceToTv()`](service/soberano_torrent_daemon.js)):** Cada 30 segundos ejecuta `arp -a`, filtra la MAC de LG (`58:fd:b1`) y registra la IP actual de la Mac en `/api/daemon/register?host=<lanIp>&port=9097` contra la TV descubierta.

---

## 3. Subtítulos Inteligentes, Anti-Duplicidad y Detección Real de Idioma

### 📂 Archivos involucrados
* [`service/service.js`](service/service.js) (`parseTorrentioStream`, `/api/soberano/play`, `/api/soberano/play_stream`)
* [`app/index.html`](app/index.html) (`enforceSpanishTracks`, `isBurnedTorrent`, `isLocalDomSubModeForTorrent`, `launchSoberanoTorrentPlayback`, `playSoberanoTorrent`, `toggleSubtitles`, `onAutoSubPillClick`, `reloadSoberanoVariant`, listener `timeupdate`)

### 🎯 ¿Para qué sirve?
Resuelve dos fallos opuestos que ocurrían en la TV:
1. **Subtítulos duplicados:** Cuando el navegador webOS pintaba la pista WebVTT nativa (`mode = 'showing'`) al mismo tiempo que el reproductor pintaba la pastilla visual `#soberanoSubOverlay` (o cuando un video con subtítulos ya quemados en los píxeles recibía un overlay encima).
2. **Subtítulos ausentes en series/películas en inglés:** Torrentio agrega al final de los releases una fila con +20 banderas de subtítulos embebidos (ej. `🇬🇧 / 🇯🇵 / ... / 🇪🇸 / ...`). Antes, esa bandera `🇪🇸` hacía que el sistema creyera que el **audio** era español (`is_es = true`) y omitiera por completo buscar subtítulos.

### ⚙️ ¿Cómo funciona?
1. **Separación estricta entre Audio Español y Subtítulos Embebidos (`parseTorrentioStream`):**
   * Filtra y excluye de la detección de audio cualquier línea que contenga `3` o más emojis de banderas regionales (`[\uD83C][\uDDE6-\uDDFF]...`) y limpia palabras como `subtitulado`, `multisub`, `esub`.
   * Solo marca `is_es: true` cuando el título del release o el tracker (`Cinecalidad`, `MejorTorrent`, `Wolfmax4k`, `BestTorrents`, `Latino`, `Castellano`, `SPA`, `ESP`) confirma **audio en español**.
2. **Modo Nativo TV (`#soberanoSubOverlay`) vs Modo AirPlay (`burn=1`):**
   * En **LG TV local** ([`isLocalDomSubModeForTorrent()`](app/index.html)):
     * `playSoberanoTorrent` solicita `burn=0` para arrancar el video de inmediato sin esperar renderizado de subtítulos en FFmpeg.
     * Si el audio no es exclusivamente español (`!stream.is_es || stream.is_dual`), `launchSoberanoTorrentPlayback` dispara automáticamente `autoSearchAndAnchorSpanishSub(0)`, descargando pistas de OpenSubtitles/Framex y activando el overlay `#soberanoSubOverlay`.
     * Ventajas en TV: cambio instantáneo entre pistas (`Pista 1..9`), encendido/apagado (`OFF` ↔ `ES`) sin reiniciar el video y calibración de sincronización en `0 ms` (`-1s`, `-0.5s`, `+0.5s`, `+1s` o botones rojo/verde/azul del control remoto).
   * En **iPhone/iPad hacia AirPlay**:
     * Solicita `burn=1` para que la Mac M3 incruste los subtítulos directamente en los píxeles del video (porque Apple/LG AirPlay 2 descarta pistas `<track>` externas). Si no hubiera quemado disponible, cae automáticamente al overlay DOM.
3. **Regla Anti-Duplicidad (`enforceSpanishTracks` + `timeupdate`):**
   * Si `isBurnedTorrent()` es `true`: silencia TODAS las pistas `<track>` (`mode = 'disabled'`), limpia y oculta `#soberanoSubOverlay` y marca `BURNED_HASHES[hash] = true` en `service.js` para no inyectar `#EXT-X-MEDIA:TYPE=SUBTITLES` en `index.m3u8`.
   * Si NO es `burned` y se reproduce localmente en TV (`!videoEl.webkitCurrentPlaybackTargetIsWireless`): todas las pistas españolas se mantienen en **`mode = 'hidden'`** (y cualquier pista en otro idioma en `'disabled'`) para que webOS jamás dibuje texto nativo sobre `#soberanoSubOverlay`.
   * Solo cuando `webkitCurrentPlaybackTargetIsWireless === true` (AirPlay inalámbrico activo), pasa la pista a `'showing'` y oculta el overlay DOM local.
4. **Botón de Subtítulos robusto (`toggleSubtitles`, `reloadSoberanoVariant`):**
   * Si se solicita activación forzada en un torrent (`burn=1`), envía `&force_sub=1` y limpia `&is_es=1` para que `service.js` no bloquee la búsqueda.
   * Al recargar variantes en webOS, llama a `executeTmdbDirectPlayback(0, keepT)` en vez de reasignar `video.src` directamente, manteniendo `Hls.js` intacto en la posición exacta (`keepT`).

---

## 4. Transcodificación RAM-HLS y Burn-In Hardware en Mac M3

### 📂 Archivos involucrados
* [`service/soberano_torrent_daemon.js`](service/soberano_torrent_daemon.js)
* [`service/gen_sub_pngs.py`](service/gen_sub_pngs.py)
* [`service/run_torrent_daemon.sh`](service/run_torrent_daemon.sh)

### 🎯 ¿Para qué sirve?
Permite reproducir cualquier torrent P2P (incluso archivos `.mkv` 4K/10-bit HEVC o audio EAC3/AC3/DTS incompatibles con navegadores) directamente desde la memoria RAM sin llenar el disco duro ni dejar residuos, a `0 $` de costo.

### ⚙️ ¿Cómo funciona?
1. **`BoundedRamChunkStore`:** Almacena las piezas descargadas por `WebTorrent` en un búfer circular en RAM (máximo `280` piezas / ~280 MB), descartando automáticamente las piezas ya reproducidas y priorizando los primeros `8 MB` del archivo de video como críticos.
2. **Transmuxing JIT (`h264_videotoolbox`):** FFmpeg lee el flujo HTTP interno (`/webtorrent/...`) y codifica por aceleración hardware de Apple Silicon M3 a `H.264 8-bit yuv420p` (`5.5 Mbps`) + `AAC Stereo 192k` en segmentos HLS de `3 s` (`/tmp/soberano_hls/<hash>/seg_XXXX.ts`).
3. **Pipeline de Burn-in (`gen_sub_pngs.py`):** Cuando `burn=1` incluye `?sub=<url_vtt>`, descarga el `.vtt`, genera una franja RGBA transparente de `1920x240` por cada diálogo con Pillow y un archivo `concat.txt`, y FFmpeg lo compone en un solo paso sobre el video usando el filtro `overlay=0:H-h`.
4. **Supervisor seguro (`run_torrent_daemon.sh`):** Copia `soberano_torrent_daemon.js` y `gen_sub_pngs.py` a `~/.soberano-daemon/` (fuera de iCloud Drive para evitar desalojos de archivos en la nube) y reinicia el agente `launchd` `com.soberano.torrentdaemon`.

---

## 5. Selector HIG de Temporadas/Episodios y Tarjetas de Enjambre P2P

### 📂 Archivos involucrados
* [`app/index.html`](app/index.html) (`openSoberanoSwarmModal`, `initSoberanoSeasonEpisodeSelectors`, `selectSoberanoSeason`, `renderSoberanoEpisodeTabs`, `selectSoberanoEpisode`, `renderSoberanoTorrentListFromCache`)

### 🎯 ¿Para qué sirve?
* Los `<select>` nativos de HTML fallan o pierden el foco con el Magic Remote y D-Pad en webOS.
* Las tarjetas de torrents mostraban insignias de seeds/resolución montadas encima del nombre del archivo.

### ⚙️ ¿Cómo funciona?
1. **Carruseles de pastillas táctiles (Apple TV HIG):**
   * `#soberanoSeasonTabs` y `#soberanoEpisodeTabs` reemplazan los `<select>` con botones `.season-tab` navegables por control remoto (`SpatialNav`).
   * Si el ID recibido es numérico (TMDB), consulta `/api/tmdb/tv/:id/external_ids` para obtener el `imdb_id` (`tt...`), consulta Cinemeta (`v3-cinemeta.strem.io`) para obtener las temporadas y episodios reales con sus títulos, y recarga los torrents automáticamente al cambiar de temporada o capítulo.
2. **Tarjetas `.soberano-torrent-item` en 3 filas limpias:**
   * **Fila 1:** Badges de calidad (`4K`/`1080p`), rango dinámico (`HDR`/`SDR`), idioma (`Español`/`Multi`), seeds (`👤`), tamaño (`💾`) y velocidad estimada.
   * **Fila 2:** Nombre completo del release con `word-break: break-word` y `line-height: 1.4` sin colisiones ni recortes bruscos.
   * **Fila 3:** Tracker y origen (`1337x • Torrentio`) junto al botón de acción **RAM Play**.

---

## 6. Blindaje Contra Cortes a Mitad de Capítulo en Torrents Pesados y Persistencia del Servicio webOS

### 📂 Archivos involucrados
* [`service/soberano_torrent_daemon.js`](service/soberano_torrent_daemon.js) (`BoundedRamChunkStore`, `ffmpegArgs`, `resetActiveTimer`, `/hls/`)
* [`service/service.js`](service/service.js) (`--disable-timeouts`, `service.activityManager`)
* [`app/index.html`](app/index.html) (`Hls.Events.ERROR`, `executeTmdbDirectPlayback`, `playAdjacentEpisode`)

### 🎯 ¿Para qué sirve?
* Evita que un capítulo o película pesada en Torrent (`> 500 MB` a varios GB) se detenga prematuramente a mitad de reproducción (por ejemplo, en el minuto 27 de un episodio de 52 minutos) engañando al reproductor como si el capítulo hubiera terminado (`#EXT-X-ENDLIST`).
* Impide que el administrador de servicios de LG webOS (`run-unified-service-server`) apague el servicio local (`9099`) tras 5 segundos sin mensajes por el bus Luna.
* Permite que al terminar realmente un episodio de una serie en modo Torrent o TMDB, el reproductor avance o abra el selector del siguiente episodio automáticamente.

### ⚙️ ¿Cómo funciona?
1. **Memoria Circular Inteligente con Spillover Efímero (`BoundedRamChunkStore`):**
   * WebTorrent descarga piezas fuera de orden a hasta `8 MB/s`. Anteriormente, cuando el almacén en RAM superaba su límite de `320 MB`, una cola FIFO simple borraba piezas antiguas o intermedias que `ffmpeg` aún no había leído, provocando `Chunk not found in RAM window` $\rightarrow$ `[http] Stream ends prematurely` $\rightarrow$ `#EXT-X-ENDLIST` prematuro.
   * Ahora `BoundedRamChunkStore` (`512 MB` de ventana en RAM) rastrea el cursor real de lectura de FFmpeg (`this.lastReadIndex`):
     1. Al liberar RAM, desaloja primero las piezas **ya leídas** (`oldIdx < lastReadIndex - 32`).
     2. Si el enjambre P2P descarga más de `512 MB` por delante de FFmpeg, vuelca temporalmente los chunks futuros no leídos a `/tmp/soberano_chunks/<storeId>/<index>.chunk` y los recupera de forma transparente cuando FFmpeg llega a ese byte, eliminándolos en cuanto se cierra o cambia el torrent (`0 B` de residuo permanente en disco).
2. **Flags de Reconexión HTTP en FFmpeg y Guardián de Inactividad de 3 Horas:**
   * Se agregaron `-reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 5` antes de `-i` en FFmpeg para tolerar micro-pausas del servidor interno de WebTorrent.
   * El temporizador de limpieza (`resetActiveTimer`) aumentó de 20 a **180 minutos** y verifica si `ffmpegProc.exitCode === null` antes de purgar la sesión.
3. **Bloqueo Permanente de Actividad en webOS (`service/service.js`):**
   * En webOS 5.6, `/usr/lib/node_modules/webos-service/lib/activitymanager.js` cierra cualquier servicio tras 5 segundos de inactividad en el bus Luna a menos que reciba `--disable-timeouts` y tenga una actividad registrada.
   * `service.js` inyecta `--disable-timeouts` en `process.argv` antes de cargar `webos-service`, fija `exitOnTimeout = false` y crea `soberanoPermanentActivity`.
4. **Auto-Recuperación de `Hls.js` en el Reproductor (`app/index.html`):**
   * Ante un error de red o de decodificación (`NETWORK_ERROR` / `MEDIA_ERROR`), `Hls.js` ejecuta `hlsPlayer.startLoad(resumePos)` o `hlsPlayer.recoverMediaError()` conservando el segundo exacto (`video.currentTime`) en lugar de reiniciar el capítulo desde `0:00`.

---

## 7. Controles Nativos de Adelanto y Retroceso (Rewind/Fast-Forward) y Teclas del Mando LG

### 📂 Archivos involucrados
* [`app/index.html`](app/index.html) (`btnRewind10`, `btnForward10`, `scrubberContainer`, `updateScrubberUi`, `seekRelative`, `keydown`)

### 🎯 ¿Para qué sirve?
* Añade botones físicos de **Atrasar 10s (`⏪ -10s`)** y **Adelantar 10s (`⏩ +10s`)** en la barra del reproductor estilo Apple TV, permitiendo adelantar o retroceder el video con un solo clic o con el Magic Remote de LG.
* Mapea correctamente las teclas multimedia físicas del control remoto de la TV (`<<` y `>>`), eliminando el conflicto donde la tecla `>>` activaba o desactivaba subtítulos en lugar de adelantar el video.
* Permite enfocar y explorar la barra de progreso (`scrubber`) con la cruceta (D-pad) del control remoto para saltos de 15 segundos.

### ⚙️ ¿Cómo funciona?
1. **Botones de Navegación Rápida (`[⏪ -10s]` y `[⏩ +10s]`):**
   * Integrados en `.left-controls` flanqueando el botón central de Play/Pause:
     `[⏪ -10s]` $\longleftrightarrow$ `[ ▶ Reproducir ]` $\longleftrightarrow$ `[⏩ +10s]`.
   * Al pulsar con el puntero o pulsar Enter con el control remoto, invocan `seekRelative(±10)` actualizando de inmediato la barra de progreso y mostrando el aviso en pantalla.
2. **Corrección de Códigos del Mando LG webOS:**
   * **`412` (`KEY_REWIND` / `<<`):** Retrocede 10 segundos al instante.
   * **`417` (`KEY_FAST_FWD` / `>>`):** Adelanta 10 segundos al instante (anteriormente estaba asignado por error a alternar subtítulos).
   * **`413` (`KEY_STOP`):** Cierra el reproductor limpiamente.
   * **`405` (Botón Amarillo):** Alterna subtítulos ON/OFF.
3. **Navegación Espacial en el Scrubber (`tabindex="0"`):**
   * Al pulsar Flecha Arriba desde los controles, el foco sube a la barra de progreso; las flechas Izquierda/Derecha permiten retroceder o adelantar en tramos de 15 segundos, y Flecha Abajo regresa al botón de Reproducir.

---

## 8. Autoreproducción del Siguiente Capítulo con Tarjeta Interactiva Apple TV / Netflix

### 📂 Archivos involucrados
* [`app/index.html`](app/index.html) (`btnAutoPlayNext`, `nextEpCard`, `toggleAutoPlayNext`, `startNextEpisodeCountdown`, `autoPlayNextTorrentEpisode`, `openSoberanoSwarmModal`)

### 🎯 ¿Para qué sirve?
* Permite ver series de corrido (Anime, Series Web TMDB y Torrents en RAM) sin tener que levantarse o buscar el mando al terminar cada episodio.
* Añade un botón configurable en la barra del reproductor (**`Auto Sig: ON / OFF`**) persistente en `localStorage`.
* Muestra una tarjeta interactiva estilo Apple TV / Netflix en los últimos segundos con una cuenta regresiva de 5 segundos, barra de progreso animada y botones de **`[ ▶ Reproducir ya (5s) ]`** y **`[ ✕ Cancelar ]`**.
* Al cancelar o pulsar la tecla Volver/Back del control remoto, la tarjeta se descarta sin cerrar el reproductor ni interrumpir la sesión.

### ⚙️ ¿Cómo funciona?
1. **Detección Dinámica de Series (`isCurrentPlaybackSeries`):**
   * El botón `Auto Sig: ON` y los botones de cambio de episodio solo se muestran cuando se está reproduciendo una serie (Anime del Vault, Serie TMDB o Serie Torrent), ocultándose automáticamente en películas individuales.
2. **Motor Multi-Capa de Detección del Fin del Episodio (Sin Bloqueos):**
   * **Capa 1 (Pre-roll Créditos en `timeupdate`):** Al restar $\le 15$ segundos de video (créditos finales), despliega la tarjeta interactiva flotante Apple TV en la esquina inferior derecha con cuenta regresiva animada de 5 segundos. Si el usuario no hace nada, transiciona limpiamente al siguiente capítulo.
   * **Capa 2 (Límite Absoluto $\le 1.5$s):** Si el video llega a 1.5s del final sin interacción, avanza de inmediato.
   * **Capa 3 (EOF Pause Guard):** En transmisiones HLS/P2P de webOS donde el stream finaliza pero el navegador se pausa sin emitir el evento `ended` nativo (debido a diferencias de milisegundos entre pistas de audio y video), detecta la pausa en los últimos 4 segundos y avanza automáticamente.
   * **Capa 4 (`BUFFER_EOS` en Hls.js):** Detecta cuando se han descargado y renderizado todos los fragmentos del buffer HLS en Anime y Torrents.
   * **Capa 5 (Heartbeat Watchdog 1s en `startStatsPolling`):** Supervisor continuo que verifica cada segundo el estado del video; si se estanca al final, ejecuta `triggerNextEpisodeNow()`.
3. **Tarjeta de Cuenta Regresiva (`#nextEpCard`):**
   * Con desenfoque de cristal (`backdrop-filter: blur(28px)`) y barra de progreso animada.
   * El foco del control remoto se coloca en `[ ▶ Reproducir ya ]`; al presionar OK/Enter avanza sin esperar los 5 segundos. Si se presiona `[ Cancelar ]` o Volver (Back), la tarjeta se oculta para ese episodio.
4. **Soporte Universal de Transición:**
   * **Anime (Vault / JKanime):** Localiza el siguiente capítulo y arranca la reproducción con `launchEpisodePlayback`.
   * **Series Web TMDB:** Resuelve y carga el nuevo capítulo mediante `launchTmdbPlayback` (corrigiendo el orden de parámetros `season` y `episode`).
   * **Torrents P2P en RAM (`autoPlayNextTorrentEpisode`):** Consulta el enjambre de torrents para `T{season} E{episode}`, selecciona automáticamente la mejor fuente (1080p con mayores seeds) y la envía directo a la memoria RAM de la Mac M3 sin abrir modales ni interrumpir al usuario. Si no encuentra semillas automáticas, abre el selector directamente en el nuevo capítulo.

---

## 9. Persistencia e Inferencia Inteligente de Subtítulos entre Capítulos

### 📂 Archivos involucrados
* [`app/index.html`](app/index.html) (`userSubtitlePreference`, `setUserSubtitlePreference`, `shouldAutoEnableSubtitles`, `autoSearchAndAnchorSpanishSub`, `toggleSubtitles`, `launchEpisodePlayback`, `launchTmdbPlayback`, `launchSoberanoTorrentPlayback`, `playSoberanoTorrent`)

### 🎯 ¿Para qué sirve?
* Elimina la molestia de tener que activar los subtítulos manualmente en cada nuevo episodio.
* **Inferencia automática:** Si en el primer capítulo de cualquier serie decides encender los subtítulos en español (o si se anclan automáticamente), el reproductor **intuye que en todos los capítulos siguientes también quieres subtítulos**.
* Al avanzar al siguiente capítulo (por autoreproducción continua, pulsar "Siguiente" o cambiar de episodio), el sistema busca, sincroniza y ancla de inmediato los subtítulos en español sin que tengas que tocar nada.
* Si en algún momento decides apagarlos (pulsando el botón de subtítulos o la tecla Amarilla del Magic Remote), el sistema actualiza tu preferencia a `OFF` y los siguientes capítulos respetarán tu decisión sin forzarte subtítulos no deseados.
* Funciona de forma idéntica en los 3 motores de streaming:
  1. **Anime Vault** (`launchEpisodePlayback`)
  2. **Series Web TMDB** (`launchTmdbPlayback`)
  3. **Torrents P2P en RAM Soberano** (`launchSoberanoTorrentPlayback`)

### ⚙️ ¿Cómo funciona?
1. **Memoria de Preferencia en Silicio Local (`localStorage`):**
   * Se almacena la clave `'soberano_subtitles_user_pref'`:
     * Al encender subtítulos $\to$ `setUserSubtitlePreference(true)`.
     * Al apagar subtítulos $\to$ `setUserSubtitlePreference(false)`.
     * Al anclar exitosamente una pista en español desde la API Soberano $\to$ se confirma `setUserSubtitlePreference(true)`.
2. **Inferencia en el Arranque de Cada Capítulo:**
   * Al iniciar un nuevo episodio, cada motor consulta `shouldAutoEnableSubtitles()`.
   * Si es `true`:
     * El botón de subtítulos pasa inmediatamente a estado de carga: `[ <i class="fa fa-spinner"></i> Buscando ES... ]`.
     * Se despacha en segundo plano la consulta a la API unificada `/api/subtitles/auto` con el ID, temporada, capítulo y título de la serie.
     * En cuanto se parsea el archivo WebVTT, se ancla al motor nativo del televisor y se activa el overlay DOM de alta legibilidad Apple TV.
3. **Regla de Oro Anti-Duplicidad en Torrents:**
   * Si un torrent ya tiene subtítulos quemados/incrustados por transcodificación (`burned === true`), el sistema muestra el botón como `ON`, pero **suprime las pistas DOM** para evitar que se superpongan dos textos simultáneos en la pantalla del televisor.
   * Si el torrent viene con audio puro en español (`is_es && !is_dual`), no fuerza subtítulos innecesarios salvo que el usuario lo solicite.

---

## 10. Limpieza Minimalista de Modo Soberano y Desbloqueo Total de la Barra de Búsqueda para LG TV

### 📂 Archivos involucrados
* [`app/index.html`](app/index.html) (`soberanoSearchInput`, `.soberano-search-field`, `btnSoberanoSearchClear`, `btnExecuteSoberanoSearch`, `onSoberanoSearchInputChange`, `clearSoberanoSearch`, `SpatialNav.focusableSelector`, `initKeyboardShortcuts`)
* [`service/soberano_client.js`](service/soberano_client.js) (`onSoberanoSearchInputChange`, `clearSoberanoSearch`)

### 🎯 ¿Para qué sirve?
* **Eliminación de Relleno Visual:** Se erradicaron todas las sugerencias fijas de relleno en Modo Soberano (`Dune`, `Interstellar`, `Severance`, `Breaking Bad`, `Solo Leveling`, `Mushoku Tensei`), dejando una interfaz limpia, profesional y despejada bajo los principios de diseño de Apple TV Human Interface Guidelines (HIG).
* **Conservación del Filtro Esencial:** Se mantuvo únicamente el chip funcional `[ 🇪🇸 Solo en Español ]` centrado bajo el buscador para filtrar torrents en idioma nativo.
* **Desbloqueo Total de Escritura en Smart TV:** Corrige la falla donde el usuario no podía escribir nada en el buscador de Modo Soberano en la TV.
  * Se integra soporte nativo tanto para teclado virtual de LG webOS (VKB), Magic Remote (puntero y D-Pad) como teclados físicos Bluetooth/USB.
  * Se añade botón de borrado rápido `[ ✕ ]` que aparece automáticamente al escribir para vaciar la búsqueda en un toque.
  * Al presionar Enter/OK en el teclado remoto, se lanza la búsqueda de inmediato y el foco de navegación salta al primer resultado encontrado.

### ⚙️ ¿Cómo funciona?
1. **Identificación de la Causa Raíz de Bloqueo:**
   * El selector de navegación espacial (`SpatialNav.focusableSelector`) no incluía elementos `input` ni `textarea`, impidiendo que el motor de navegación D-Pad del televisor enfocara el campo de texto.
   * El escuchador global de teclado (`document.addEventListener('keydown', ...)`) capturaba las teclas flecha izquierda (37), flecha derecha (39) y Enter (13) ejecutando `e.preventDefault()`, lo que robaba el foco del campo de texto de inmediato antes de que el teclado virtual de webOS pudiera emitir caracteres o mover el cursor.
2. **Armadura de Bypass para Campos de Entrada Activos (`isInputActive`):**
   * Al recibir cualquier pulsación de teclado, el sistema evalúa si el foco activo es un `<input>` o `<textarea>`.
   * Si es un campo activo:
     * **Letras, números, espacios, caracteres y flechas Izquierda/Derecha:** Se concede paso libre inmediato (`return`) sin ejecutar `e.preventDefault()`, permitiendo que el teclado virtual de LG y los teclados físicos escriban y muevan el cursor fluidamente.
     * **Enter / OK (13):** Ejecuta la búsqueda (`executeSoberanoSearch()`) y desenfoca el campo para mostrar los resultados en pantalla.
     * **Flecha Abajo (40):** Desenfoca el campo y transfiere suavemente el foco hacia el filtro de español o los resultados.
     * **Flecha Arriba (38):** Desenfoca el campo y transfiere el foco hacia la barra de navegación superior.
     * **Botón Atrás / Back (461 / Escape):** Desenfoca el campo y cierra el teclado virtual sin cerrar la aplicación.
3. **Estilos de Enfoque de Alto Contraste Apple TV:**
   * La clase `.soberano-search-field` cuenta con anillo de enfoque púrpura fluorescente (`rgba(232, 121, 249, 0.5)`), fondo translúcido y supresión de `transform: scale` para garantizar que el texto no se distorsione durante la escritura.

---

## 11. Despliegue Rápido si Cambias de TV o Reinstalas Todo

1. **En la Mac (Demonio P2P puerto `9097`):**
   ```bash
   cd service
   ./run_torrent_daemon.sh
   ```
   *(Asegúrate de tener instalados `node`, `ffmpeg`, `python3` con `Pillow`, y `npm install` dentro de `~/.soberano-daemon`)*

2. **En la LG Smart TV (App + Servicio puerto `9099`):**
   ```bash
   ./deploy_to_tv.sh
   ```
   *(Requiere Developer Mode encendido en la TV, llave SSH `~/.ssh/tv_webos` y CLI `ares-*` en macOS. El script detecta la IP nueva automáticamente, genera el IPK, lo instala y abre la app).*
