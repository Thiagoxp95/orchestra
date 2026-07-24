import base64

from dictation import MIN_UTTERANCE_BYTES, run_dictation_with_sources


class FakeTranscriber:
    """Returns text proportional to how many bytes it has been given, so the
    test can assert the final fires on the accumulated buffer."""

    def transcribe(self, audio_bytes: bytes) -> str:
        return f"len={len(audio_bytes)}"


class ExplodingTranscriber:
    def transcribe(self, audio_bytes: bytes) -> str:
        raise RuntimeError("mlx blew up")


def _pcm(nbytes: int) -> str:
    return base64.b64encode(b"\x01\x00" * (nbytes // 2)).decode("ascii")


def _run(queue, transcriber=None):
    out = []
    run_dictation_with_sources(
        commands=lambda: queue.pop(0) if queue else None,
        emit=out.append,
        transcriber=transcriber or FakeTranscriber(),
        idle_sleep=lambda: None,
        should_stop=lambda: not queue,
    )
    return out


def test_emits_final_on_end_over_full_buffer():
    half = MIN_UTTERANCE_BYTES
    out = _run(
        [
            {"type": "reset", "id": "u1"},
            {"type": "audio", "pcm": _pcm(half)},
            {"type": "audio", "pcm": _pcm(half)},
            {"type": "end", "id": "u1"},
            {"type": "shutdown"},
        ]
    )
    # Exactly one transcription per utterance, on end, over the full buffer.
    assert out == [{"type": "final", "id": "u1", "text": f"len={half * 2}"}]


def test_reset_drops_buffer_before_end():
    out = _run(
        [
            {"type": "reset", "id": "u1"},
            {"type": "audio", "pcm": _pcm(MIN_UTTERANCE_BYTES * 2)},
            {"type": "reset", "id": "u2"},
            {"type": "audio", "pcm": _pcm(MIN_UTTERANCE_BYTES)},
            {"type": "end", "id": "u2"},
            {"type": "shutdown"},
        ]
    )
    assert out == [{"type": "final", "id": "u2", "text": f"len={MIN_UTTERANCE_BYTES}"}]


def test_final_carries_the_utterance_id_it_was_started_with():
    out = _run(
        [
            {"type": "reset", "id": "utterance-a"},
            {"type": "audio", "pcm": _pcm(MIN_UTTERANCE_BYTES)},
            {"type": "end", "id": "utterance-a"},
            {"type": "shutdown"},
        ]
    )
    assert out[0]["id"] == "utterance-a"


def test_too_short_buffer_finalizes_empty_without_transcribing():
    out = _run(
        [
            {"type": "reset", "id": "u1"},
            {"type": "audio", "pcm": _pcm(64)},
            {"type": "end", "id": "u1"},
            {"type": "shutdown"},
        ]
    )
    # No transcription attempt: a sub-200ms buffer has no word in it, and the
    # model happily invents one when handed noise.
    assert out == [{"type": "final", "id": "u1", "text": ""}]


def test_transcription_failure_emits_error_not_silence():
    out = _run(
        [
            {"type": "reset", "id": "u1"},
            {"type": "audio", "pcm": _pcm(MIN_UTTERANCE_BYTES)},
            {"type": "end", "id": "u1"},
            {"type": "shutdown"},
        ],
        transcriber=ExplodingTranscriber(),
    )
    assert len(out) == 1
    assert out[0]["type"] == "error"
    assert out[0]["id"] == "u1"
    assert out[0]["code"] == "transcribe_failed"


def test_malformed_base64_chunk_does_not_kill_the_utterance():
    out = _run(
        [
            {"type": "reset", "id": "u1"},
            {"type": "audio", "pcm": "!!!not base64!!!"},
            {"type": "audio", "pcm": _pcm(MIN_UTTERANCE_BYTES)},
            {"type": "end", "id": "u1"},
            {"type": "shutdown"},
        ]
    )
    assert out == [{"type": "final", "id": "u1", "text": f"len={MIN_UTTERANCE_BYTES}"}]


def test_buffer_resets_between_consecutive_utterances():
    out = _run(
        [
            {"type": "reset", "id": "u1"},
            {"type": "audio", "pcm": _pcm(MIN_UTTERANCE_BYTES * 2)},
            {"type": "end", "id": "u1"},
            {"type": "reset", "id": "u2"},
            {"type": "audio", "pcm": _pcm(MIN_UTTERANCE_BYTES)},
            {"type": "end", "id": "u2"},
            {"type": "shutdown"},
        ]
    )
    assert out == [
        {"type": "final", "id": "u1", "text": f"len={MIN_UTTERANCE_BYTES * 2}"},
        {"type": "final", "id": "u2", "text": f"len={MIN_UTTERANCE_BYTES}"},
    ]
