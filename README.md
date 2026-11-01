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
│   ├── index.html            # Core tvOS/Apple TV interface (SpatialNav, 10-foot UI)
│   ├── appinfo.json          # webOS Application manifest
│   └── assets/               # Apple TV icons, badges, and splash screens
├── service/
│   ├── service.js            # Node.js companion service (RAM cache, HLS proxy)
│   ├── services.json         # webOS LS2 service registration
│   └── package.json          # Service dependency definitions
├── aligner/
│   ├── aligner_core.py       # Whisper MLX audio transcription & piecewise mapper
│   └── aligner_server.py     # HTTP daemon on Apple Silicon host (:9098)
└── README.md                 # Technical documentation and operational guide
```

---

## 🛠️ Deployment & Setup

### Requirements
- **Target Device:** LG Smart TV running webOS (Developer Mode enabled, CLI tools installed: `ares-package`, `ares-install`, `ares-launch`).
- **Controller Host (Optional for Whisper sync):** macOS on Apple Silicon (M-Series) with Python 3.10+ and `mlx-whisper`.

### 1. Build and Install on LG Smart TV
```bash
# Package webOS application and background companion service
ares-package app/ service/ -o build/

# Install the generated IPK on your target TV
ares-install -d tv build/com.soberano.appletvhub_1.0.0_all.ipk

# Launch the app
ares-launch -d tv com.soberano.appletvhub
```

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
