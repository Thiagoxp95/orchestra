import base64

from dictation import run_dictation_with_sources


class FakeTranscriber:
    """Returns text proportional to how many bytes it has been given, so the
    test can assert interim/final fire on the accumulated buffer."""

    def transcribe(self, audio_bytes: bytes) -> str:
        return f"len={len(audio_bytes)}"


def _pcm(nbytes: int) -> str:
    return base64.b64encode(b"\x01\x00" * (nbytes // 2)).decode("ascii")


def test_emits_final_on_end_over_full_buffer():
    cmds = [
        {"type": "audio", "pcm": _pcm(100)},
        {"type": "audio", "pcm": _pcm(100)},
        {"type": "end"},
        {"type": "shutdown"},
    ]
    out = []
    queue = list(cmds)
    run_dictation_with_sources(
        commands=lambda: queue.pop(0) if queue else None,
        emit=out.append,
        transcriber=FakeTranscriber(),
        idle_sleep=lambda: None,
        should_stop=lambda: not queue,
    )
    # Exactly one transcription per utterance, on end, over the full buffer.
    assert out == [{"type": "final", "text": "len=200"}]


def test_reset_drops_buffer_before_end():
    queue = [
        {"type": "audio", "pcm": _pcm(100)},
        {"type": "reset"},
        {"type": "audio", "pcm": _pcm(40)},
        {"type": "end"},
        {"type": "shutdown"},
    ]
    out = []
    run_dictation_with_sources(
        commands=lambda: queue.pop(0) if queue else None,
        emit=out.append,
        transcriber=FakeTranscriber(),
        idle_sleep=lambda: None,
        should_stop=lambda: not queue,
    )
    assert out == [{"type": "final", "text": "len=40"}]
