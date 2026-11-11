#!/bin/bash
set -e
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
TV_PORT="9922"
SSH_KEY="$HOME/.ssh/tv_webos"

# Auto-detect TV IP from ARP (LG Electronics MAC 58:fd:b1) or ares-setup-device
TV_IP=$(arp -a | grep -i "58:fd:b1" | sed -n 's/.*(\([0-9.]*\)).*/\1/p' | head -n 1)
if [ -z "$TV_IP" ]; then
    TV_IP=$(ares-setup-device -l 2>/dev/null | grep "^tv " | sed -n 's/.*@\([0-9.]*\):.*/\1/p' | head -n 1)
fi
[ -z "$TV_IP" ] && TV_IP="192.168.128.11"

echo "==> Verificando conexión con LG TV en $TV_IP:$TV_PORT..."
if ! nc -z -w 2 "$TV_IP" "$TV_PORT" >/dev/null 2>&1; then
    echo "==> AVISO: LG TV ($TV_IP:$TV_PORT) no responde actualmente (apagada o en suspensión)."
    exit 1
fi

# Sincronizar IP en ares-setup-device
ares-setup-device -m tv -i "host=$TV_IP" >/dev/null 2>&1 || true

# 1. Empaquetar e instalar IPK permanente en webOS (App + Service)
STAGE="/tmp/soberano-ipk-stage"
OUT="/tmp/soberano-ipk-out"
rm -rf "$STAGE" "$OUT"
mkdir -p "$STAGE/app" "$STAGE/service" "$OUT"

cp "$REPO_DIR/app/appinfo.json" "$STAGE/app/"
[ -d "$REPO_DIR/assets" ] && cp "$REPO_DIR/assets/"*.png "$STAGE/app/" 2>/dev/null || true
cp "$REPO_DIR/app/index.html" "$STAGE/app/ipad_vault.html"

cp "$REPO_DIR/service/package.json" "$STAGE/service/"
cp "$REPO_DIR/service/services.json" "$STAGE/service/"
[ -f "$REPO_DIR/service/aligner.json" ] && cp "$REPO_DIR/service/aligner.json" "$STAGE/service/"
cp "$REPO_DIR/service/service.js" "$STAGE/service/"
cp "$REPO_DIR/app/index.html" "$STAGE/service/ipad_vault.html"

MAC_IP=$(ifconfig en0 2>/dev/null | awk '/inet / {print $2; exit}')
[ -z "$MAC_IP" ] && MAC_IP="192.168.128.4"

cat << EOF > "$STAGE/app/index.html"
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Soberano Hub</title>
<style>
  body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #000; font-family: -apple-system, BlinkMacSystemFont, sans-serif; color: #fff; }
  #loader { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; text-align: center; padding: 24px; box-sizing: border-box; }
  .spinner { width: 52px; height: 52px; border: 4px solid rgba(255,255,255,0.18); border-top-color: #0a84ff; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 22px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  h2 { font-size: 28px; font-weight: 700; margin: 0 0 10px 0; letter-spacing: -0.5px; }
  p { font-size: 16px; color: rgba(255,255,255,0.65); margin: 0 0 18px 0; }
  #retryBtn { display: none; padding: 12px 28px; font-size: 16px; font-weight: 600; border-radius: 12px; border: none; background: #0a84ff; color: #fff; cursor: pointer; }
  #retryBtn:focus { outline: 3px solid #fff; }
</style>
<script>
  const ON_DEVICE_BASE = "http://127.0.0.1:9099";
  const MAC_PC_BASE    = "http://$MAC_IP:9099";
  let hasRedirected = false;
  let bridgeKeepAlive = null;

  function redirect(baseUrl) {
    if (hasRedirected) return;
    hasRedirected = true;
    window.location.replace(baseUrl + "/ipad?v=" + Date.now());
  }

  function wakeServiceViaLuna() {
    try {
      if (window.PalmServiceBridge) {
        if (!bridgeKeepAlive) {
          bridgeKeepAlive = new window.PalmServiceBridge();
          bridgeKeepAlive.onservicecallback = function() {};
          bridgeKeepAlive.call("luna://com.soberano.appletvhub.service/heartbeat", JSON.stringify({ subscribe: true }));
        }
        var b2 = new window.PalmServiceBridge();
        b2.onservicecallback = function() {};
        b2.call("luna://com.soberano.appletvhub.service/status", "{}");
      }
    } catch (e) {}
  }

  function probeOnDevice(retries) {
    if (hasRedirected) return;
    fetch(ON_DEVICE_BASE + "/status?_=" + Date.now(), { cache: "no-store" })
      .then(function(r) { if (r && r.ok) redirect(ON_DEVICE_BASE); else retryOrFallback(retries); })
      .catch(function() { retryOrFallback(retries); });
  }

  function retryOrFallback(retries) {
    if (retries > 0) {
      if (retries % 6 === 0) wakeServiceViaLuna();
      setTimeout(function() { probeOnDevice(retries - 1); }, 250);
    } else {
      fetch(MAC_PC_BASE + "/status?_=" + Date.now(), { cache: "no-store" })
        .then(function(r) { if (r && r.ok) redirect(MAC_PC_BASE); else showRetry(); })
        .catch(function() { showRetry(); });
    }
  }

  function showRetry() {
    var msg = document.getElementById("statusText");
    var btn = document.getElementById("retryBtn");
    if (msg) msg.textContent = "Despertando motor local de la TV (puerto 9099)...";
    if (btn) { btn.style.display = "inline-block"; btn.focus(); }
    wakeServiceViaLuna();
    setTimeout(function() { probeOnDevice(16); }, 1000);
  }

  function manualRetry() { wakeServiceViaLuna(); probeOnDevice(20); }

  window.addEventListener("DOMContentLoaded", function() {
    wakeServiceViaLuna();
    probeOnDevice(24);
  });
</script>
</head>
<body>
  <div id="loader">
    <div class="spinner"></div>
    <h2>Soberano Hub</h2>
    <p id="statusText">Iniciando motor de streaming nativo en tu LG TV...</p>
    <button id="retryBtn" onclick="manualRetry()">Reintentar conexión local</button>
  </div>
</body>
</html>
EOF

echo "==> Empaquetando IPK actualizado..."
ares-package "$STAGE/app" "$STAGE/service" -o "$OUT"
IPK_FILE=$(ls -t "$OUT"/*.ipk | head -n 1)

echo "==> Instalando IPK en LG TV ($TV_IP)..."
ares-install -d tv "$IPK_FILE"

echo "==> Sincronizando copia en /media/developer/temp/..."
scp -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa -P "$TV_PORT" -i "$SSH_KEY" "$REPO_DIR/app/index.html" "prisoner@$TV_IP:/media/developer/temp/ipad_vault.html"
scp -o StrictHostKeyChecking=no -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa -P "$TV_PORT" -i "$SSH_KEY" "$REPO_DIR/service/service.js" "prisoner@$TV_IP:/media/developer/temp/server.js"

echo "==> Relanzando Soberano Hub en LG TV..."
ares-launch -d tv --close com.soberano.appletvhub >/dev/null 2>&1 || true
sleep 1
ares-launch -d tv com.soberano.appletvhub
echo "==> Despliegue permanente completado con éxito."
