#!/usr/bin/env bash
# Idempotent setup for the Orchestra voice sidecar.
#
#   - Creates a venv at ~/.orchestra/voice-venv
#   - Installs dependencies declared in pyproject.toml
#
# Safe to run multiple times; only re-creates pip when the python interpreter
# version changes.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="${ORCHESTRA_VOICE_VENV:-$HOME/.orchestra/voice-venv}"
PYTHON_BIN="${ORCHESTRA_VOICE_PYTHON:-python3.11}"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "[orchestra-voice] Could not find $PYTHON_BIN on PATH." >&2
  echo "[orchestra-voice] Install Python 3.11+ (e.g. \`brew install python@3.11\`) and re-run." >&2
  exit 1
fi

mkdir -p "$(dirname "$VENV_DIR")"

if [ ! -d "$VENV_DIR" ]; then
  echo "[orchestra-voice] Creating venv at $VENV_DIR"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

echo "[orchestra-voice] Upgrading pip..."
python -m pip install --upgrade pip wheel >/dev/null

echo "[orchestra-voice] Installing dependencies (this can take several minutes the first time)..."
python -m pip install --upgrade -e "$REPO_DIR"

cat <<EOF
[orchestra-voice] Done.
[orchestra-voice] Sidecar venv: $VENV_DIR
[orchestra-voice] Run:   $VENV_DIR/bin/python $REPO_DIR/main.py
EOF
