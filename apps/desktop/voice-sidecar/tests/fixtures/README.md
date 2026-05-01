# Voice sidecar test fixtures

These fixtures are not committed. The pytest suite that depends on them is
guarded by `@pytest.mark.skip` until the WAVs exist on disk in this folder.
Once you record them and drop them in here, swap the skips for real test
bodies.

## Recording requirements (all fixtures)

- **Format**: 16-bit PCM WAV
- **Sample rate**: 16 kHz
- **Channels**: 1 (mono)
- **Environment**: quiet room, single speaker, normal speaking volume — no
  music, no other voices, no fans/AC.
- **Mic**: built-in MacBook mic is fine. Sit ~30 cm from the mic.
- **Distance from edges**: leave ~300 ms of silence at the start and the end
  of every clip so the VAD has clean boundaries.

A one-line capture command using the `sox` tool (Homebrew: `brew install
sox`):

```sh
rec -c 1 -r 16000 -b 16 wake_then_ship.wav
# Speak, then Ctrl+C when done.
```

If the mic captures at a different rate, resample with:

```sh
sox in.wav -c 1 -r 16000 -b 16 out.wav
```

## Files to record

| Filename | Length | Content |
|---|---|---|
| `wake_then_ship.wav` | ~3.5 s | Say `"computer"`, pause ~500 ms, say `"ship"`. Used by `test_wake_then_ship_wav`. |
| `wake_only.wav` | ~6 s | Say `"computer"` once, then stay completely silent for the rest of the clip. Used by `test_wake_only_wav` to verify the 5 s timeout. |
| `meeting_chatter_60s.wav` | ~60 s | Continuous casual speech — read a paragraph aloud, talk to yourself, etc. **Must NOT contain the word "computer"** or any close phonetic neighbor. Used by `test_meeting_chatter_no_wake` as a false-positive guard. |
| `wake_then_xyz.wav` | ~3.5 s | Say `"computer"`, pause ~500 ms, say a phrase that is NOT in any test vocabulary — e.g. `"xyzzy nonsense words"`. Used by `test_wake_then_xyz_wav`. |

## Sanity check

Quick check after recording:

```sh
file wake_then_ship.wav
# Should print: RIFF (little-endian) data, WAVE audio, ... 16000 Hz
```

The `test_wake_then_ship_wav` body, once you implement it, should look
roughly like:

```python
import wave, numpy as np
from openwakeword.model import Model
# feed frames into VoicePipeline with the real WakeDetector + Transcriber
# wired in main.py
```
