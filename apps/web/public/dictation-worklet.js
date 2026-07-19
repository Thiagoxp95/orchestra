// Posts mono Float32 frames from the mic to the main thread. Registered as
// "pcm-capture". The main thread accumulates, downsamples to 16k, and uploads.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (input && input[0]) {
      this.port.postMessage(input[0].slice(0))
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor)
