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
        min_interim_interval_s=999,  # suppress interim; isolate the final
        clock=lambda: 0.0,
        idle_sleep=lambda: None,
        should_stop=lambda: not queue,
    )
    finals = [e for e in out if e["type"] == "final"]
    assert finals == [{"type": "final", "text": "len=200"}]


def test_emits_interim_on_cadence_then_clears_on_end():
    queue = [
        {"type": "audio", "pcm": _pcm(40)},
        {"type": "end"},
        {"type": "shutdown"},
    ]
    out = []
    ticks = iter([0.0, 0.0, 1.0, 1.0, 2.0, 2.0, 2.0])
    run_dictation_with_sources(
        commands=lambda: queue.pop(0) if queue else None,
        emit=out.append,
        transcriber=FakeTranscriber(),
        min_interim_interval_s=0.5,
        clock=lambda: next(ticks, 9.0),
        idle_sleep=lambda: None,
        should_stop=lambda: not queue,
    )
    kinds = [e["type"] for e in out]
    assert "interim" in kinds
    assert kinds[-1] == "final"
