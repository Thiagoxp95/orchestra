"""Audio pipeline state machine for the Orchestra voice sidecar.

The pipeline is structured so the audio loop, the wake-word detector, and
the transcriber are pluggable: production wires `openWakeWord` and
`parakeet-mlx`, tests inject lightweight stubs so the state machine itself
is exercised without any audio dependency.

State machine
-------------

    LISTENING_FOR_WAKE
        on wake (oWW score >= threshold) -> emit `wake`, transition
    LISTENING_FOR_COMMAND
        accumulate frames; on VAD silence (>= silence_ms) or buffer cap (>= window_ms)
            -> transcribe, run intent matcher, emit `final` then
               `matched` or `no_match`, transition back to LISTENING_FOR_WAKE
        on hard 5s timeout from wake event
            -> emit `timeout`, transition back

The pipeline does NOT own the mic. `feed_frame()` is the entry point; the
`main.py` audio loop calls it. Tests call `feed_frame()` directly with
synthetic frames and stubbed detectors.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, List, Optional, Protocol

from intent import IntentMatcher


class PipelineState(str, Enum):
    LISTENING_FOR_WAKE = "listening_for_wake"
    LISTENING_FOR_COMMAND = "listening_for_command"


class WakeDetector(Protocol):
    """Anything that scores a frame for the wake word.

    Production: a wrapper around `openwakeword.Model.predict`. Tests: a
    callable that returns a fixed score per frame.
    """

    def score(self, frame_bytes: bytes) -> float: ...
    def reset(self) -> None: ...


class Transcriber(Protocol):
    """Anything that converts a chunk of buffered audio into a transcript."""

    def transcribe(self, audio_bytes: bytes) -> str: ...


class VoiceActivityDetector(Protocol):
    """Anything that classifies a frame as speech or silence."""

    def is_speech(self, frame_bytes: bytes) -> bool: ...


@dataclass
class PipelineConfig:
    """Tunable pipeline parameters. Defaults match the spec."""

    wake_threshold: float = 0.6
    """openWakeWord score above which the wake event fires."""

    intent_threshold: float = 0.75
    """Fuzzy match confidence above which an intent counts as matched."""

    sample_rate_hz: int = 16000
    """Native rate openWakeWord and Parakeet expect."""

    frame_ms: int = 80
    """Per-frame duration. 80ms = 1280 samples at 16kHz."""

    command_window_ms: int = 3000
    """Maximum command audio buffered before forced transcription."""

    silence_end_ms: int = 700
    """Trailing silence after wake that ends the command window early."""

    timeout_ms: int = 5000
    """Hard timeout after wake fired with no usable speech."""


# The first arg is the event name; the second is an optional payload dict.
EventCallback = Callable[[str, dict], None]


@dataclass
class _CommandSession:
    """In-flight command-listening state after a wake fires."""

    started_at: float
    last_speech_at: float
    buffer: bytearray = field(default_factory=bytearray)
    heard_speech: bool = False


class VoicePipeline:
    """Single-shot wake-then-command state machine.

    Stateful, single-threaded. The owning audio loop drives ticks via
    `feed_frame`; vocabulary updates are pushed via `set_vocab`. Events go
    out via the constructor's `on_event` callback.
    """

    def __init__(
        self,
        wake_detector: WakeDetector,
        transcriber: Transcriber,
        vad: VoiceActivityDetector,
        on_event: EventCallback,
        intent: IntentMatcher | None = None,
        config: PipelineConfig | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._wake = wake_detector
        self._transcriber = transcriber
        self._vad = vad
        self._on_event = on_event
        self._config = config or PipelineConfig()
        self._intent = intent or IntentMatcher(threshold=self._config.intent_threshold)
        self._clock = clock
        self._state: PipelineState = PipelineState.LISTENING_FOR_WAKE
        self._session: Optional[_CommandSession] = None
        self._vocab_size = 0

    @property
    def state(self) -> PipelineState:
        return self._state

    def set_vocab(self, vocab: List[dict]) -> None:
        self._intent.set_vocab(vocab)
        self._vocab_size = len(vocab)

    def feed_frame(self, frame_bytes: bytes) -> None:
        if self._state is PipelineState.LISTENING_FOR_WAKE:
            self._handle_wake_frame(frame_bytes)
        else:
            self._handle_command_frame(frame_bytes)

    # ------------------------------------------------------------------
    # State: LISTENING_FOR_WAKE
    # ------------------------------------------------------------------
    def _handle_wake_frame(self, frame_bytes: bytes) -> None:
        score = self._wake.score(frame_bytes)
        if score < self._config.wake_threshold:
            return
        # Wake fired. Transition.
        self._wake.reset()
        now = self._clock()
        self._session = _CommandSession(started_at=now, last_speech_at=now)
        self._state = PipelineState.LISTENING_FOR_COMMAND
        self._emit("wake", {"ts": now, "score": score})

    # ------------------------------------------------------------------
    # State: LISTENING_FOR_COMMAND
    # ------------------------------------------------------------------
    def _handle_command_frame(self, frame_bytes: bytes) -> None:
        assert self._session is not None
        now = self._clock()
        elapsed_ms = (now - self._session.started_at) * 1000

        is_speech = self._vad.is_speech(frame_bytes)
        if is_speech:
            self._session.heard_speech = True
            self._session.last_speech_at = now
            self._session.buffer.extend(frame_bytes)
        elif self._session.heard_speech:
            # Tail silence after speech: keep buffering a bit so Parakeet sees
            # the trailing audio context.
            self._session.buffer.extend(frame_bytes)

        # Hard 5s timeout: nothing useful heard.
        if elapsed_ms >= self._config.timeout_ms and not self._session.heard_speech:
            self._emit("timeout", {})
            self._return_to_wake()
            return

        # Trailing silence ends the window early.
        silence_ms = (now - self._session.last_speech_at) * 1000
        ended_by_silence = (
            self._session.heard_speech
            and silence_ms >= self._config.silence_end_ms
        )
        ended_by_window = elapsed_ms >= self._config.command_window_ms

        if not (ended_by_silence or ended_by_window):
            return

        # Run transcription + intent matching.
        if not self._session.buffer:
            self._emit("timeout", {})
            self._return_to_wake()
            return

        transcript = self._transcriber.transcribe(bytes(self._session.buffer))
        text = (transcript or "").strip()
        self._emit("final", {"text": text})

        if not text:
            self._emit("no_match", {"text": ""})
            self._return_to_wake()
            return

        match = self._intent.match(text)
        if match is None:
            self._emit("no_match", {"text": text})
        else:
            self._emit(
                "matched",
                {
                    "action_id": match.action_id,
                    "text": text,
                    "confidence": match.confidence,
                },
            )
        self._return_to_wake()

    def _return_to_wake(self) -> None:
        self._session = None
        self._state = PipelineState.LISTENING_FOR_WAKE

    def _emit(self, event_type: str, payload: dict) -> None:
        # Always include the event type so callers can serialize uniformly.
        out = {"type": event_type, **payload}
        try:
            self._on_event(event_type, out)
        except Exception:  # pragma: no cover - defensive only
            # The pipeline must not die because a downstream consumer raised.
            pass
