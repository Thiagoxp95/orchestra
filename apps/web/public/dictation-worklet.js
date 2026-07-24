// Posts mono Float32 blocks from the mic to the main thread. Registered as
// "pcm-capture". The main thread accumulates, resamples to 16k, and uploads.
//
// Blocks are batched to BLOCK_SAMPLES before posting: the render quantum is 128
// samples, so posting per-quantum meant ~375 structured-clone postMessages per
// second competing with React on a phone's main thread. Batching cuts that to
// ~23/s, with no added latency that matters for a hold-to-talk utterance.
const BLOCK_SAMPLES = 2048

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(BLOCK_SAMPLES)
    this.filled = 0
    // The main thread asks for a flush at end-of-utterance so the final partial
    // block is not stranded in here — that tail is usually the last word. The
    // ack tells it the block has been posted, so it knows when it is safe to
    // tear the graph down.
    this.port.onmessage = (event) => {
      if (event.data !== 'flush') return
      this.flush()
      this.port.postMessage('flushed')
    }
  }

  flush() {
    if (this.filled === 0) return
    this.port.postMessage(this.buffer.slice(0, this.filled))
    this.filled = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    let offset = 0
    while (offset < channel.length) {
      const take = Math.min(BLOCK_SAMPLES - this.filled, channel.length - offset)
      this.buffer.set(channel.subarray(offset, offset + take), this.filled)
      this.filled += take
      offset += take
      if (this.filled === BLOCK_SAMPLES) this.flush()
    }
    return true
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor)
