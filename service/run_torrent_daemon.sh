#!/bin/zsh
# SOBERANO Torrent Daemon Supervisor Launcher (iCloud-safe & LaunchAgent-backed)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_DIR="$HOME/.soberano-daemon"

mkdir -p "$RUNTIME_DIR"
cp "$SCRIPT_DIR/soberano_torrent_daemon.js" "$RUNTIME_DIR/soberano_torrent_daemon.js"
[ -f "$SCRIPT_DIR/gen_sub_pngs.py" ] && cp "$SCRIPT_DIR/gen_sub_pngs.py" "$RUNTIME_DIR/gen_sub_pngs.py"

if [ ! -f "$RUNTIME_DIR/package.json" ]; then
    cat << 'EOF' > "$RUNTIME_DIR/package.json"
{
  "name": "soberano-torrent-daemon",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "memory-chunk-store": "^1.3.5",
    "webtorrent": "^3.0.21"
  }
}
EOF
fi

if launchctl print "gui/$(id -u)/com.soberano.torrentdaemon" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/com.soberano.torrentdaemon"
else
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.soberano.torrentdaemon.plist"
fi
