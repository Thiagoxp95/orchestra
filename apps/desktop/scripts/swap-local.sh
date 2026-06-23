#!/bin/bash
# Swap the pre-built local Orchestra.app into /Applications WITHOUT rebuilding
# (so it never invokes codesign / the keychain). Run this after building with:
#   CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --dir --mac \
#     -c.mac.notarize=false -c.mac.identity=null
#
# It quits the running Orchestra (closing every terminal/agent inside it),
# replaces /Applications/Orchestra.app, clears quarantine, and relaunches.
set -e

APP_NAME="Orchestra"
APP_PATH="/Applications/${APP_NAME}.app"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_APP="${DESKTOP_DIR}/dist/mac-arm64/${APP_NAME}.app"

if [ ! -d "$DIST_APP" ]; then
  echo "ERROR: built app not found at ${DIST_APP}. Build it first."
  exit 1
fi

echo "==> Swapping in ${DIST_APP}"
echo "==> Orchestra will quit (this closes this terminal), then relaunch."

# Detached installer, reparented to launchd, survives Orchestra dying.
(
  nohup bash -c "
    sleep 1
    osascript -e 'tell application \"${APP_NAME}\" to quit' 2>/dev/null || true
    sleep 2
    for i in \$(seq 1 20); do
      pgrep -f \"${APP_PATH}/Contents\" >/dev/null 2>&1 || break
      sleep 0.5
    done
    pgrep -f \"${APP_PATH}/Contents\" 2>/dev/null | while read -r pid; do
      [ \"\$pid\" != \"\$\$\" ] && kill -9 \"\$pid\" 2>/dev/null || true
    done
    sleep 0.5
    rm -rf \"${APP_PATH}\"
    cp -R \"${DIST_APP}\" \"${APP_PATH}\"
    xattr -rd com.apple.quarantine \"${APP_PATH}\" 2>/dev/null || true
    open \"${APP_PATH}\"
  " >/tmp/orchestra-swap.log 2>&1 &
) &
disown
echo "==> Installer launched. Log: /tmp/orchestra-swap.log"
