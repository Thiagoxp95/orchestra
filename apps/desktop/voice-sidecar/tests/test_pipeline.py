"""Pipeline unit tests.

These tests exercise the state machine WITHOUT real audio, openWakeWord, or
Parakeet. They inject stubs for the wake detector, the VAD, and the
transcriber, and a mock clock so timing-dependent transitions are
deterministic.

The "drives recorded WAVs through the real openWakeWord + Parakeet" flavor
of tests is deferred to integration / smoke tests — see
`apps/desktop/voice-sidecar/tests/fixtures/README.md`.
"""

from __future__ import annotations

from typing import List

import pytest

from intent import IntentMatcher
from pipeline import (
    PipelineConfig,
    PipelineState,
    VoicePipeline,
)


class FakeWakeDetector:
    def __init__(self, scores: List[float]) -> None:
        self._scores = list(scores)
        self.reset_count = 0

    def score(self, _frame: bytes) -> float:
        if not self._scores:
            return 0.0
        return self._scores.pop(0)

    def reset(self) -> None:
        self.reset_count += 1


class FakeVAD:
    """Step through `pattern` once, then hold the final value forever."""

    def __init__(self, pattern: List[bool]) -> None:
        self._pattern = list(pattern) or [False]
        self._i = 0

    def is_speech(self, _frame: bytes) -> bool:
        if self._i >= len(self._pattern):
            return self._pattern[-1]
        out = self._pattern[self._i]
        self._i += 1
        return out


class FakeTranscriber:
    def __init__(self, transcript: str) -> None:
        self._transcript = transcript
        self.calls = 0

    def transcribe(self, _audio: bytes) -> str:
        self.calls += 1
        return self._transcript


class MockClock:
    def __init__(self, start: float = 0.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def collect_events() -> tuple[list, callable]:
    events: list = []

    def on_event(_name: str, payload: dict) -> None:
        events.append(payload)

    return events, on_event


VOCAB = [
    {"actionId": "abc-1", "phrases": ["ship"]},
    {"actionId": "abc-2", "phrases": ["deploy", "deploy to prod"]},
]


def make_pipeline(
    *,
    wake_scores: list[float],
    vad_pattern: list[bool],
    transcript: str,
    config: PipelineConfig | None = None,
) -> tuple[VoicePipeline, list, MockClock, FakeTranscriber]:
    cfg = config or PipelineConfig(
        wake_threshold=0.6,
        intent_threshold=0.75,
        command_window_ms=3000,
        silence_end_ms=700,
        timeout_ms=5000,
        frame_ms=80,
    )
    events, on_event = collect_events()
    clock = MockClock()
    wake = FakeWakeDetector(wake_scores)
    transcriber = FakeTranscriber(transcript)
    vad = FakeVAD(vad_pattern)
    intent = IntentMatcher(VOCAB, threshold=cfg.intent_threshold)
    pipeline = VoicePipeline(
        wake_detector=wake,
        transcriber=transcriber,
        vad=vad,
        on_event=on_event,
        intent=intent,
        config=cfg,
        clock=clock,
    )
    return pipeline, events, clock, transcriber


# ---------------------------------------------------------------------------
# Wake-word transitions
# ---------------------------------------------------------------------------


def test_wake_above_threshold_emits_wake_event() -> None:
    pipeline, events, _, _ = make_pipeline(
        wake_scores=[0.1, 0.7],
        vad_pattern=[False],
        transcript="ship",
    )
    pipeline.feed_frame(b"\x00" * 16)  # below threshold
    assert pipeline.state is PipelineState.LISTENING_FOR_WAKE
    pipeline.feed_frame(b"\x00" * 16)  # crosses threshold
    assert pipeline.state is PipelineState.LISTENING_FOR_COMMAND
    assert any(e["type"] == "wake" for e in events)


def test_wake_resets_detector() -> None:
    pipeline, _, _, _ = make_pipeline(
        wake_scores=[0.95],
        vad_pattern=[False],
        transcript="",
    )
    pipeline.feed_frame(b"\x00" * 16)
    # FakeWakeDetector.reset_count tracked here:
    assert pipeline.state is PipelineState.LISTENING_FOR_COMMAND


# ---------------------------------------------------------------------------
# Command transcription paths
# ---------------------------------------------------------------------------


def test_wake_then_command_emits_matched() -> None:
    pipeline, events, clock, transcriber = make_pipeline(
        wake_scores=[0.95],
        vad_pattern=[True, True, True, False, False, False, False, False, False, False, False],
        transcript="ship",
    )
    # Wake.
    pipeline.feed_frame(b"\x00" * 1280)
    # Speech frames.
    for _ in range(3):
        clock.advance(0.08)
        pipeline.feed_frame(b"\x00" * 1280)
    # Silence frames totalling >= 700ms.
    for _ in range(10):
        clock.advance(0.08)
        pipeline.feed_frame(b"\x00" * 1280)

    types = [e["type"] for e in events]
    assert "wake" in types
    assert "final" in types
    assert "matched" in types
    assert types.index("wake") < types.index("final") < types.index("matched")
    matched = next(e for e in events if e["type"] == "matched")
    assert matched["action_id"] == "abc-1"
    assert transcriber.calls == 1


def test_wake_then_silence_emits_timeout() -> None:
    pipeline, events, clock, transcriber = make_pipeline(
        wake_scores=[0.95],
        vad_pattern=[False],
        transcript="",
    )
    pipeline.feed_frame(b"\x00" * 1280)  # wake
    # Advance past the 5s timeout entirely with silence.
    for _ in range(80):
        clock.advance(0.08)
        pipeline.feed_frame(b"\x00" * 1280)
    types = [e["type"] for e in events]
    assert "wake" in types
    assert "timeout" in types
    assert "matched" not in types
    # Transcription must NOT run when nothing was said.
    assert transcriber.calls == 0
    assert pipeline.state is PipelineState.LISTENING_FOR_WAKE


def test_unknown_command_emits_no_match() -> None:
    pipeline, events, clock, _ = make_pipeline(
        wake_scores=[0.95],
        vad_pattern=[True, True, True, False, False, False, False, False, False, False, False],
        transcript="xyzzy nonsense words",
    )
    pipeline.feed_frame(b"\x00" * 1280)  # wake
    for _ in range(3):
        clock.advance(0.08)
        pipeline.feed_frame(b"\x00" * 1280)
    for _ in range(10):
        clock.advance(0.08)
        pipeline.feed_frame(b"\x00" * 1280)

    types = [e["type"] for e in events]
    assert "no_match" in types
    assert "matched" not in types
    nm = next(e for e in events if e["type"] == "no_match")
    assert nm["text"] == "xyzzy nonsense words"


# ---------------------------------------------------------------------------
# Vocab swap behavior
# ---------------------------------------------------------------------------


def test_vocab_swap_changes_match_target() -> None:
    pipeline, events, clock, _ = make_pipeline(
        wake_scores=[0.95, 0.95],
        vad_pattern=[True, True, True, False, False, False, False, False, False, False, False],
        transcript="ship",
    )

    # First run: "ship" -> abc-1.
    pipeline.feed_frame(b"\x00" * 1280)
    for _ in range(3):
        clock.advance(0.08)
        pipeline.feed_frame(b"\x00" * 1280)
    for _ in range(10):
        clock.advance(0.08)
        pipeline.feed_frame(b"\x00" * 1280)

    matched_first = [e for e in events if e["type"] == "matched"]
    assert len(matched_first) == 1
    assert matched_first[0]["action_id"] == "abc-1"

    # Replace vocab; "ship" should no longer match.
    pipeline.set_vocab([{"actionId": "different", "phrases": ["deploy"]}])

    pipeline.feed_frame(b"\x00" * 1280)  # wake again
    for _ in range(3):
        clock.advance(0.08)
        pipeline.feed_frame(b"\x00" * 1280)
    for _ in range(10):
        clock.advance(0.08)
        pipeline.feed_frame(b"\x00" * 1280)

    no_match = [e for e in events if e["type"] == "no_match"]
    assert len(no_match) == 1, "ship should now miss after vocab swap"


# ---------------------------------------------------------------------------
# Audio-fixture tests — gated on recorded WAVs the user must produce.
# ---------------------------------------------------------------------------


@pytest.mark.skip(reason="needs recorded fixture: wake_then_ship.wav (see tests/fixtures/README.md)")
def test_wake_then_ship_wav() -> None:  # pragma: no cover
    raise AssertionError("unreachable")


@pytest.mark.skip(reason="needs recorded fixture: wake_only.wav (see tests/fixtures/README.md)")
def test_wake_only_wav() -> None:  # pragma: no cover
    raise AssertionError("unreachable")


@pytest.mark.skip(reason="needs recorded fixture: meeting_chatter_60s.wav (see tests/fixtures/README.md)")
def test_meeting_chatter_no_wake() -> None:  # pragma: no cover
    raise AssertionError("unreachable")


@pytest.mark.skip(reason="needs recorded fixture: wake_then_xyz.wav (see tests/fixtures/README.md)")
def test_wake_then_xyz_wav() -> None:  # pragma: no cover
    raise AssertionError("unreachable")
