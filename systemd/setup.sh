#!/bin/bash
set -euo pipefail

# ── 1. Stop existing processes ──
echo "Stopping existing processes..."
kill $(cat ~/daemon.pid 2>/dev/null) 2>/dev/null || true
kill $(cat ~/relay.pid 2>/dev/null) 2>/dev/null || true
# Also kill any paseo supervisor/daemon that's still around (SIGKILL to ensure cleanup)
pkill -9 -u $USER -f 'supervisor-entrypoint' 2>/dev/null || true
pkill -9 -u $USER -f 'paseo/server/dist/server' 2>/dev/null || true
pkill -u $USER -f 'node dist/index.js --port 39217' 2>/dev/null || true
sleep 2

# ── 2. Enable linger (keeps user services running after logout) ──
echo "Enabling linger..."
loginctl enable-linger $USER

# ── 3. Install service files ──
mkdir -p ~/.config/systemd/user
cp ~/tiny-paseo-relay/systemd/paseo-relay.service ~/.config/systemd/user/
cp ~/tiny-paseo-relay/systemd/paseo-daemon.service ~/.config/systemd/user/

# ── 4. Reload and enable ──
systemctl --user daemon-reload
systemctl --user enable paseo-relay paseo-daemon

# ── 5. Start ──
systemctl --user start paseo-relay
sleep 1
systemctl --user start paseo-daemon

# ── 6. Verify ──
echo ""
echo "=== Service status ==="
systemctl --user status paseo-relay --no-pager -l
echo ""
systemctl --user status paseo-daemon --no-pager -l
echo ""

echo "=== Daemon HOME check ==="
DAEMON_PID=$(systemctl --user show paseo-daemon -p MainPID --value)
cat /proc/$DAEMON_PID/environ | tr '\0' '\n' | grep -E '^HOME=|^PASEO_RELAY'
echo ""
echo "Done. Old pid files can be removed: rm ~/{relay,daemon}.pid"
