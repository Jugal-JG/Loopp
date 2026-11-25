class LooppMic extends AudioWorkletProcessor {
  samples = [];
  phase = 0;
  sum = 0;
  count = 0;
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const value of channel) {
      this.sum += value;
      this.count++;
      this.phase += 16000;
      if (this.phase < sampleRate) continue;
      this.phase -= sampleRate;
      this.samples.push(Math.max(-32768, Math.min(32767, Math.round(this.sum / this.count * 32768))));
      this.sum = this.count = 0;
    }
    if (this.samples.length >= 320) {
      const pcm = Int16Array.from(this.samples);
      this.samples.length = 0;
      this.port.postMessage(pcm, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('loopp-mic', LooppMic);
