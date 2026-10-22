# /// script
# requires-python = ">=3.12"
# dependencies = ["mlx-audio==0.5.8"]
# ///
"""Phone dictation's ears: Qwen3-ASR 1.7B (8-bit) on this Mac's GPU through MLX.

  in   per turn: sample count as a little-endian UInt32, then that many PCM16 samples, 16 kHz mono
  out  per turn: one JSON line, {"text": "...", "ms": 120}; {"ready": true} once, after loading

    uv run -q --script ears.py

Run with uv, not the wake-word venv: mlx-audio pins its own mlx. Loading takes a few seconds (the first
run downloads ~2.5 GB from Hugging Face), so src/main/dictation/ears.ts keeps one warm between presses.
"""

import json
import struct
import sys
import time

import numpy as np
from mlx_audio.stt import load

MODEL = "mlx-community/Qwen3-ASR-1.7B-8bit"
# The user speaks one or the other. Left to guess among its 11 languages, a short turn could come back
# as Russian or Chinese; then it is heard again as English. No hotwords: with a list of names it heard a
# clear "Testing one two three" as nothing, and silence as the names.
LANGUAGES = ("English", "Portuguese")


def log(text):
    print(f"ears: {text}", file=sys.stderr, flush=True)


def read(rfile, count):
    """Exactly [count] bytes, or None at EOF."""
    data = rfile.read(count)
    return data if len(data) == count else None


def hear(model, samples):
    out = model.generate(samples)
    heard = out.language if isinstance(out.language, list) else [out.language]  # one per chunk
    if heard == ["None"]:  # no speech in it
        return ""
    if any(lang not in LANGUAGES for lang in heard):
        log(f"heard as {heard}, again as English")
        out = model.generate(samples, language="English")
    return out.text.strip()


def main():
    started = time.monotonic()
    model = load(MODEL)
    hear(model, np.zeros(16_000, dtype=np.float32))  # the first pass compiles; take it now
    log(f"Qwen3-ASR ready in {int((time.monotonic() - started) * 1000)} ms")
    rfile, wfile = sys.stdin.buffer, sys.stdout.buffer
    wfile.write(b'{"ready": true}\n')
    wfile.flush()
    while header := read(rfile, 4):
        (count,) = struct.unpack("<I", header)
        if (pcm := read(rfile, count * 2)) is None:
            break
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
        t0 = time.monotonic()
        text = ""
        if len(samples) >= 1_600:  # under 0.1 s is a slip of the finger
            try:
                text = hear(model, samples)
            except Exception as e:  # one bad turn must not take the ears down with it
                log(f"{type(e).__name__}: {e}")
        wfile.write((json.dumps({"text": text, "ms": int((time.monotonic() - t0) * 1000)}) + "\n").encode())
        wfile.flush()


if __name__ == "__main__":
    main()
