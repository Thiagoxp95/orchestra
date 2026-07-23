"""Orchestra remote-dictation sidecar.

Reads JSON commands from stdin (one per line):
    {"type": "audio", "pcm": "<base64 int16 mono 16k>"}
    {"type": "end"}        # finalize current utterance
    {"type": "reset"}      # drop the current buffer (new utterance)
    {"type": "shutdown"}

Writes JSON events to stdout (one per line):
    {"type": "ready"}
    {"type": "final", "text": "..."}
    {"type": "error", "code": "...", "message": "..."}

Reuses ParakeetTranscriber from main.py — the same model the wake-word sidecar
loads — so there is no new dependency and no packaging change. Transcription
runs exactly once per utterance, on `end`, over the full accumulated buffer:
one clean pass is both faster and more accurate than re-transcribing a growing
buffer (partial buffers hallucinate), and there is no live preview to keep warm.
"""

from __future__ import annotations

import base64
import signal
import sys
import time
from typing import Any, Callable, Optional

from main import ParakeetTranscriber, StdinCommandReader, emit_json


def run_dictation_with_sources(
    *,
    commands: Callable[[], Optional[dict]],
    emit: Callable[[dict], None],
    transcriber: Any,
    should_stop: Optional[Callable[[], bool]] = None,
    idle_sleep: Callable[[], None] = lambda: time.sleep(0.01),
) -> None:
    """Drive the dictation loop from injected sources (testable)."""
    buf = bytearray()

    while True:
        if should_stop and should_stop():
            break

        cmd = commands()
        if cmd is None:
            idle_sleep()
            continue

        ctype = cmd.get("type")
        if ctype == "audio":
            try:
                buf += base64.b64decode(cmd.get("pcm", ""))
            except Exception:
                pass  # drop a malformed chunk rather than crash the utterance
        elif ctype == "end":
            text = transcriber.transcribe(bytes(buf)) if buf else ""
            emit({"type": "final", "text": text})
            buf = bytearray()
        elif ctype == "reset":
            buf = bytearray()
        elif ctype == "shutdown":
            break


def run() -> int:  # pragma: no cover - exercised manually / in smoke
    out = sys.stdout

    def emit(payload: dict) -> None:
        emit_json(out, payload)

    try:
        transcriber = ParakeetTranscriber()
    except Exception as exc:
        emit({"type": "error", "code": "model_missing", "message": f"parakeet-mlx init failed: {exc}"})
        return 2

    reader = StdinCommandReader.start()
    stop_flag = {"v": False}

    def _on_signal(_signum: int, _frame: object) -> None:
        stop_flag["v"] = True

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    emit({"type": "ready"})
    run_dictation_with_sources(
        commands=reader.try_get,
        emit=emit,
        transcriber=transcriber,
        should_stop=lambda: stop_flag["v"],
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(run())
