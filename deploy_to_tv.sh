#!/bin/bash
TV_IP="192.168.128.8"
TV_PORT="9922"
SSH_KEY="$HOME/.ssh/tv_webos"
LOCAL_FILE="$(cd "$(dirname "$0")" && pwd)/app/index.html"
REMOTE_PATH="/media/developer/temp/ipad_vault.html"

echo "==> Verificando conexión con LG TV en $TV_IP:$TV_PORT..."
if nc -z -w 2 "$TV_IP" "$TV_PORT" >/dev/null 2>&1; then
    echo "==> Desplegando index.html a LG TV..."
    scp -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa -P "$TV_PORT" -i "$SSH_KEY" "$LOCAL_FILE" "prisoner@$TV_IP:$REMOTE_PATH"
    echo "==> Despliegue completado con éxito."
else
    echo "==> AVISO: LG TV ($TV_IP:$TV_PORT) no responde actualmente (apagada o en suspensión)."
fi
