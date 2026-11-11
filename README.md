# Soberano Apple TV Hub (webOS Native 10-Foot Architecture)

> **Autonomous, zero-cost, high-performance streaming and dynamic catalog platform engineered directly for Apple Silicon & LG Smart TV webOS.**

---

## 🌟 Overview & Philosophy

**Soberano Apple TV Hub** transforms an LG Smart TV (webOS) into a premium, fluid **Apple TV (tvOS)** entertainment center without costly external hardware, subscriptions, or external proxies. 

Designed under the **Pure Kernel & $0.00 USD Execution Principle**, the platform balances computation across:
1. **On-Device Silico (LG Smart TV ARMv7 Realtek SoC):** Runs a lightweight native Node.js companion daemon that provides in-memory RAM segment caching, direct HLS rewriting, and real-time WebVTT subtitle synchronization.
2. **Apple Silicon M3 Host (Optional Heavy Inference):** Whisper ASR alignment engine powered by MLX for automatic subtitle extraction and piecewise time-sync calibration.

---

## 🚀 Key Architectural Pillars

### 1. Unified Dynamic Growing Catalog Engine
- **Perpetual Auto-Sync:** Periodically polls upstream live feeds (every 10 minutes in the background and on window visibility changes).
- **Multi-Source Federation:**
  - **Anime:** 5,059+ series with daily live episode updates.
  - **Movies:** 10,000+ titles dynamically categorized (Trending, Top Rated, Action, Sci-Fi, Box Office).
  - **TV Series:** Ongoing season and episode tracking for prime-time broadcasting.
- **Adaptive Memory Micro-Cache:**
  - Fast TTLs (5 min for fresh episodes, 10 min for popular carousels) ensure that newly released titles appear immediately on the dashboard without manual app reloads or device reboots.

### 2. Autonomous Ground-Truth Subtitle Alignment Engine
- **The Core Problem:** Stream providers frequently deliver extended director's cuts (e.g., 178-min *Avatar*) while online subtitle repositories only offer theatrical cuts (162-min). A static offset is mathematically impossible due to inserted scenes causing non-linear drifts (from $+96\text{ s}$ up to $+841\text{ s}$).
- **The Solution (ASR-Guided Piecewise Alignment):**
  - Audio slices are sampled and transcribed locally using **Whisper MLX on Apple Silicon**.
  - Inverted word index matching computes exact video-to-subtitle time anchors $(t_{\text{video}}, d)$.
  - Adaptive bisection pinpoints scene insertion boundaries and derives a continuous/piecewise synchronization map.
  - The final `.vtt` track is automatically pushed to the TV and hot-swapped into the video player without interrupting playback.

### 3. Pure Subtitle Sanitization & Anti-Overlap Engine
- **Zero AI/OCR Artifacts:** Strips unwanted strings like `[cite: 2]`, `[cita 2]`, and HTML formatting.
- **Anti-Overlap Mathematical Guard:** If two dialogue cues collide, the predecessor cue is adjusted with a `50 ms` safe-gap, eliminating flicker and subtitle stacking on low-tier TV GPUs.
- **Micro-Cue Elimination:** Drops transient cues under `0.2 s` to preserve readability.

### 4. Smart TV 10-Foot UI (tvOS Theater Layout)
- **Fluid 60 FPS Spatial Navigation:** Euclidean 2D distance navigation optimized for LG Magic Remote and standard D-Pad controls.
- **Theater-Centered Modal:** Replaces narrow side-drawers with an expansive 1,140px centered dialog with episode thumbnails, 2-line auto-clamped overviews, and high-visibility focus indicators.

---

## 📂 Repository Structure

```
├── app/
│   ├── index.html                   # Interfaz tvOS/Apple TV completa (10-foot UI, SpatialNav, P2P RAM Player)
│   └── appinfo.json                 # Manifiesto de aplicación webOS
├── assets/
│   ├── icon.png                     # Ícono estándar de la app webOS
│   └── largeIcon.png                # Ícono grande de la app webOS
├── service/
│   ├── service.js                   # Servicio webOS (Node.js 8.12: RAM cache, HLS proxy, torrent swarm & subs)
│   ├── services.json                # Registro LS2 del servicio webOS
│   ├── package.json                 # Metadatos del servicio webOS
│   ├── soberano_torrent_daemon.js   # Demonio P2P WebTorrent en RAM + VideoToolbox HLS (:9097 en Mac M3)
│   ├── gen_sub_pngs.py              # Renderizador PNG RGBA para burn-in de subtítulos por AirPlay
│   ├── run_torrent_daemon.sh        # Lanzador seguro LaunchAgent para macOS
│   └── aligner.json                 # Configuración de host para alineación y daemon
├── aligner/
│   ├── aligner_core.py              # Transcripción Whisper MLX y alineación por tramos
│   └── aligner_server.py            # Servidor HTTP en Apple Silicon (:9098)
├── deploy_to_tv.sh                  # Auto-detección de IP TV + build IPK + ares-install + relanzamiento
├── DOCUMENTACION_CAMBIOS.md         # Manual detallado punto por punto: qué hace y cómo funciona cada cambio
└── README.md                        # Documentación general de arquitectura
```

---

## 🛠️ Deployment & Setup

### Requirements
- **Target Device:** LG Smart TV running webOS (Developer Mode enabled, CLI tools installed: `ares-package`, `ares-install`, `ares-launch`, `ares-setup-device`).
- **Controller Host (Mac Apple Silicon M-Series):** Node.js 18+, `ffmpeg` (con `h264_videotoolbox`), Python 3.10+ (`Pillow` para burn-in AirPlay; opcional `mlx-whisper` para alineación ASR).

### 1. Build, Package and Install Permanently on LG Smart TV
```bash
# Auto-detecta la IP de tu LG TV por ARP, empaqueta el IPK completo con PalmServiceBridge,
# lo instala en webOS y sincroniza /media/developer/temp/
./deploy_to_tv.sh
```

### 2. Run the Mac M3 P2P Torrent + HLS Hardware Daemon
```bash
cd service/
./run_torrent_daemon.sh
```

### 3. Detailed Changelog & Architecture Guide
Consulta [`DOCUMENTACION_CAMBIOS.md`](DOCUMENTACION_CAMBIOS.md) para ver el detalle técnico completo de cada corrección (para qué sirve y cómo funciona internamente).

### 2. Run the Host Subtitle Aligner (Optional)
```bash
cd aligner/
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python aligner_server.py --port 9098 --host 0.0.0.0
```

---

## 🔒 Privacy & Safety Guarantee
- **Agnostic & Anonymous:** Zero tracking, zero telemetry, and zero credentials committed.
- **Cost $0.00 USD:** Entirely built on local compute and public decentralized endpoints.

---

**Developed with precision for sovereign home entertainment.**
