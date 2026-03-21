#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_NAME="router-outage-heartbeat"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"

echo "Building project..."
cd "$PROJECT_DIR"
npm run build

echo "Installing systemd service..."
mkdir -p "$SYSTEMD_USER_DIR"
cp "$PROJECT_DIR/systemd/$SERVICE_NAME.service" "$SYSTEMD_USER_DIR/$SERVICE_NAME.service"

echo "Reloading systemd daemon..."
systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"

# Restart if already running to pick up new binary; start fresh otherwise.
if systemctl --user is-active --quiet "$SERVICE_NAME"; then
    echo "Service is running — restarting to pick up new binary..."
    systemctl --user restart "$SERVICE_NAME"
else
    echo "Starting service..."
    systemctl --user start "$SERVICE_NAME"
fi

echo "Enabling linger so service starts at boot (not just at login)..."
if ! loginctl enable-linger "$USER" 2>/dev/null; then
    echo "Warning: loginctl enable-linger failed. The service will not start automatically at boot." >&2
    echo "         This is expected in containers or systems with restricted loginctl." >&2
fi

echo ""
echo "Done. Service status:"
systemctl --user status "$SERVICE_NAME" --no-pager
