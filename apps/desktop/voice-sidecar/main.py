"""Orchestra voice sidecar entrypoint.

Reads JSON commands from stdin (one per line):
    {"type": "set_vocab", "vocab": [{"actionId": "...", "phrases": [...]}, ...]}
    {"type": "shutdown"}

Writes JSON events to stdout (one per line):
    {"type": "wake", ...}
    {"type": "final", "text": "..."}
    {"type": "matched", "action_id": "...", "text": "...", "confidence": 0.95}
    {"type": "no_match", "text": "..."}
    {"type": "timeout"}
    {"type": "error", "code": "...", "message": "..."}
    {"type": "heartbeat"}

Architecture
------------

The audio loop is decoupled from stdin/stdout I/O so unit tests can drive the
pipeline without `sounddevice`. `run_with_sources(...)` accepts injected
implementations of:

    - frame source (yields raw 16kHz mono int16 PCM bytes per frame)
    - command reader (yields parsed JSON dicts from stdin)
    - event emitter (writes JSON events to stdout)
    - clock (for heartbeat timing)

`run()` is the production entry that wires real sounddevice / stdin / stdout.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import signal
import sys
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Iterator, Optional

from intent import IntentMatcher
from pipeline import (
    PipelineConfig,
    PipelineState,
    VoicePipeline,
)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SAMPLE_RATE = 16000
FRAME_MS = 80
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000  # 1280 at 16k/80ms
HEARTBEAT_INTERVAL_S = 2.0
DEFAULT_WAKE_WORD = "computer"


# ---------------------------------------------------------------------------
# Wake / VAD / Transcriber adapters
# ---------------------------------------------------------------------------


class EnergyVAD:
    """Tiny energy-threshold VAD on int16 PCM bytes.

    Avoids introducing a webrtcvad dep when not strictly needed. Matches the
    `VoiceActivityDetector` protocol from `pipeline.py`.
    """

    def __init__(self, threshold_rms: float = 350.0) -> None:
        self._threshold = float(threshold_rms)

    def is_speech(self, frame_bytes: bytes) -> bool:
        if not frame_bytes:
            return False
        try:
            import numpy as np  # local import: numpy is a runtime dep
        except Exception:  # pragma: no cover - dep missing in non-runtime envs
            return False
        samples = np.frombuffer(frame_bytes, dtype=np.int16).astype(np.float32)
        if samples.size == 0:
            return False
        rms = float(np.sqrt(np.mean(samples * samples)))
        return rms >= self._threshold


class OpenWakeWordDetector:
    """Adapter around `openwakeword.Model` matching `WakeDetector`.

    Tests use a fake; this class is exercised only at runtime.
    """

    def __init__(self, wake_word: str = DEFAULT_WAKE_WORD) -> None:  # pragma: no cover
        from openwakeword.model import Model  # type: ignore[import-not-found]

        self._wake_word = wake_word
        # `wakeword_models` accepts the bundled prebuilt names.
        self._model = Model(wakeword_models=[wake_word], inference_framework="onnx")
        self._key: Optional[str] = None

    def score(self, frame_bytes: bytes) -> float:  # pragma: no cover
        import numpy as np

        samples = np.frombuffer(frame_bytes, dtype=np.int16)
        scores = self._model.predict(samples)
        if not isinstance(scores, dict):
            return 0.0
        if self._key is None:
            # Pick the first key matching our requested wake word, fall back to any.
            for k in scores.keys():
                if self._wake_word.replace(" ", "_") in str(k).lower():
                    self._key = str(k)
                    break
            if self._key is None and scores:
                self._key = next(iter(scores.keys()))
        if self._key is None:
            return 0.0
        return float(scores.get(self._key, 0.0))

    def reset(self) -> None:  # pragma: no cover
        try:
            self._model.reset()
        except Exception:
            pass


class ParakeetTranscriber:
    """Adapter around `parakeet-mlx` matching `Transcriber`."""

    def __init__(self) -> None:  # pragma: no cover
        from parakeet_mlx import from_pretrained  # type: ignore[import-not-found]

        self._model = from_pretrained("mlx-community/parakeet-tdt-0.6b-v2")

    def transcribe(self, audio_bytes: bytes) -> str:  # pragma: no cover
        import numpy as np

        samples = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        result = self._model.transcribe(samples)
        if hasattr(result, "text"):
            return str(result.text or "")
        if isinstance(result, str):
            return result
        return ""


# ---------------------------------------------------------------------------
# Command parsing
# ---------------------------------------------------------------------------


@dataclass
class StdinCommandReader:
    """Reads JSON commands from stdin in a background thread.

    Items are placed onto an internal queue. Use `try_get()` to drain
    without blocking the audio loop.
    """

    queue: "queue.Queue[dict]"

    @classmethod
    def start(cls) -> "StdinCommandReader":
        q: "queue.Queue[dict]" = queue.Queue()

        def _read_loop() -> None:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(payload, dict):
                    q.put(payload)

        t = threading.Thread(target=_read_loop, name="voice-stdin", daemon=True)
        t.start()
        return cls(queue=q)

    def try_get(self) -> Optional[dict]:
        try:
            return self.queue.get_nowait()
        except queue.Empty:
            return None


# ---------------------------------------------------------------------------
# Event emitter
# ---------------------------------------------------------------------------


def emit_json(out_stream: Any, payload: dict) -> None:
    line = json.dumps(payload, separators=(",", ":"))
    try:
        out_stream.write(line + "\n")
        out_stream.flush()
    except (BrokenPipeError, ValueError):  # pragma: no cover
        # Parent went away. Best-effort: we'll exit on next shutdown signal.
        pass


# ---------------------------------------------------------------------------
# Audio loop (production)
# ---------------------------------------------------------------------------


def _frames_from_sounddevice() -> Iterator[bytes]:  # pragma: no cover
    """Yields 80ms int16 PCM frames from the default mic at 16kHz mono.

    Raises a clear exception if `sounddevice` cannot open the input — the
    caller emits an `error` event and exits.
    """
    import sounddevice as sd  # type: ignore[import-not-found]

    block = FRAME_SAMPLES
    with sd.RawInputStream(
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype="int16",
        blocksize=block,
    ) as stream:
        while True:
            data, overflowed = stream.read(block)
            if overflowed:
                # Drop on overflow; not worth corrupting downstream models.
                continue
            yield bytes(data)


# ---------------------------------------------------------------------------
# Core run loop (testable)
# ---------------------------------------------------------------------------


def run_with_sources(
    *,
    frames: Iterable[bytes],
    commands: Callable[[], Optional[dict]],
    emit: Callable[[dict], None],
    pipeline: VoicePipeline,
    clock: Callable[[], float] = time.monotonic,
    heartbeat_interval_s: float = HEARTBEAT_INTERVAL_S,
    should_stop: Optional[Callable[[], bool]] = None,
) -> None:
    """Drive the pipeline from injected sources.

    Returns when the frame iterator is exhausted, when a `shutdown` command
    arrives, or when `should_stop()` is truthy.
    """
    next_heartbeat = clock() + heartbeat_interval_s
    stopped = False

    for frame in frames:
        if stopped:
            break
        if should_stop and should_stop():
            break

        # Drain any pending commands first so vocab updates apply to this frame.
        while True:
            cmd = commands()
            if cmd is None:
                break
            ctype = cmd.get("type")
            if ctype == "set_vocab":
                vocab = cmd.get("vocab") or cmd.get("words") or []
                if isinstance(vocab, list):
                    pipeline.set_vocab(vocab)
            elif ctype == "shutdown":
                stopped = True
                break
        if stopped:
            break

        pipeline.feed_frame(frame)

        now = clock()
        if now >= next_heartbeat:
            emit({
                "type": "heartbeat",
                "ts": now,
                "state": pipeline.state.value if isinstance(pipeline.state, PipelineState) else str(pipeline.state),
            })
            next_heartbeat = now + heartbeat_interval_s


# ---------------------------------------------------------------------------
# Production entrypoint
# ---------------------------------------------------------------------------


def run() -> int:  # pragma: no cover - exercised manually / in smoke
    parser = argparse.ArgumentParser()
    parser.add_argument("--wake-word", default=os.environ.get("ORCHESTRA_VOICE_WAKE_WORD", DEFAULT_WAKE_WORD))
    parser.add_argument("--wake-threshold", type=float, default=float(os.environ.get("ORCHESTRA_VOICE_WAKE_THRESHOLD", 0.6)))
    parser.add_argument("--intent-threshold", type=float, default=float(os.environ.get("ORCHESTRA_VOICE_INTENT_THRESHOLD", 0.75)))
    args = parser.parse_args()

    out = sys.stdout

    def emit(payload: dict) -> None:
        emit_json(out, payload)

    # Build models. Failures here become a single error event then exit.
    try:
        wake = OpenWakeWordDetector(wake_word=args.wake_word)
    except Exception as exc:
        emit({"type": "error", "code": "model_missing", "message": f"openWakeWord init failed: {exc}"})
        return 2

    try:
        transcriber = ParakeetTranscriber()
    except Exception as exc:
        emit({"type": "error", "code": "model_missing", "message": f"parakeet-mlx init failed: {exc}"})
        return 2

    vad = EnergyVAD()
    intent = IntentMatcher(threshold=args.intent_threshold)
    config = PipelineConfig(
        wake_threshold=args.wake_threshold,
        intent_threshold=args.intent_threshold,
        sample_rate_hz=SAMPLE_RATE,
        frame_ms=FRAME_MS,
    )

    pipeline = VoicePipeline(
        wake_detector=wake,
        transcriber=transcriber,
        vad=vad,
        on_event=lambda _name, payload: emit(payload),
        intent=intent,
        config=config,
    )

    cmd_reader = StdinCommandReader.start()

    stop_flag = {"v": False}

    def _on_signal(_signum: int, _frame: object) -> None:
        stop_flag["v"] = True

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    # Open the mic and start streaming. Distinguish permission errors so the
    # main process can show an actionable message.
    try:
        frame_source = _frames_from_sounddevice()
    except Exception as exc:
        msg = str(exc).lower()
        code = "mic_denied" if ("permission" in msg or "denied" in msg) else "mic_lost"
        emit({"type": "error", "code": code, "message": str(exc)})
        return 2

    try:
        run_with_sources(
            frames=frame_source,
            commands=cmd_reader.try_get,
            emit=emit,
            pipeline=pipeline,
            should_stop=lambda: stop_flag["v"],
        )
    except Exception as exc:
        emit({"type": "error", "code": "sidecar_crash", "message": str(exc)})
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(run())
