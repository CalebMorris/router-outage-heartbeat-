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

echo "Enabling and starting service..."
systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"
systemctl --user start "$SERVICE_NAME"

echo "Enabling linger so service starts at boot (not just login)..."
loginctl enable-linger "$USER"

echo ""
echo "Done. Service status:"
systemctl --user status "$SERVICE_NAME" --no-pager
