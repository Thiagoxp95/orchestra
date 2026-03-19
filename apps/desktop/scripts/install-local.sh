#!/bin/bash
set -e

APP_NAME="Orchestra"
APP_PATH="/Applications/${APP_NAME}.app"
ARCH=$(uname -m)

if [ "$ARCH" = "arm64" ]; then
  DIST_APP="dist/mac-arm64/${APP_NAME}.app"
else
  DIST_APP="dist/mac/${APP_NAME}.app"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$DESKTOP_DIR"

# Build FIRST — before quitting the running app, since we may be running inside Orchestra
echo "==> Building ${APP_NAME} (unpacked)..."
electron-vite build && electron-builder --dir --mac

DIST_APP_FULL="${DESKTOP_DIR}/${DIST_APP}"

if [ ! -d "$DIST_APP_FULL" ]; then
  echo "ERROR: Build output not found at ${DIST_APP_FULL}"
  exit 1
fi

echo "==> Build complete. Handing off to installer..."

# Spawn a fully detached process that will:
#   1. Wait for this script's parent (Orchestra) to die
#   2. Remove old app, copy new app, relaunch
# This survives Orchestra being killed because it's reparented to launchd (PID 1).
(
  nohup bash -c "
    APP_NAME='${APP_NAME}'
    APP_PATH='${APP_PATH}'
    DIST_APP_FULL='${DIST_APP_FULL}'

    # Give the parent script a moment to exit cleanly
    sleep 1

    # Quit Orchestra gracefully, then force-kill if needed
    osascript -e 'tell application \"${APP_NAME}\" to quit' 2>/dev/null || true
    sleep 2

    # Wait up to 10s for Orchestra to fully exit
    for i in \$(seq 1 20); do
      if ! pgrep -f '${APP_NAME}.app' >/dev/null 2>&1; then
        break
      fi
      sleep 0.5
    done

    # Force kill if still alive
    pkill -9 -f '${APP_NAME}.app' 2>/dev/null || true
    sleep 0.5

    # Remove old and install new
    rm -rf \"\$APP_PATH\"
    cp -R \"\$DIST_APP_FULL\" \"\$APP_PATH\"

    # Clear quarantine
    xattr -rd com.apple.quarantine \"\$APP_PATH\" 2>/dev/null || true

    # Launch
    open \"\$APP_PATH\"
  " >/tmp/orchestra-install.log 2>&1 &
) &
disown

echo "==> Installer will quit Orchestra, replace it, and relaunch."
echo "==> Check /tmp/orchestra-install.log if something goes wrong."
