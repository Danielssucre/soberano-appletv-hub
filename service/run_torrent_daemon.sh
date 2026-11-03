#!/bin/zsh
# SOBERANO Torrent Daemon Supervisor Launcher (iCloud-safe & LaunchAgent-backed)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_DIR="$HOME/.soberano-daemon"

mkdir -p "$RUNTIME_DIR"
cp "$SCRIPT_DIR/soberano_torrent_daemon.js" "$RUNTIME_DIR/soberano_torrent_daemon.js"

if launchctl print "gui/$(id -u)/com.soberano.torrentdaemon" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/com.soberano.torrentdaemon"
else
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.soberano.torrentdaemon.plist"
fi
