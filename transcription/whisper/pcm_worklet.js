//Runs on the audio thread: hands the microphone samples to the page in blocks (128 samples per call would flood it).
class PcmTap extends AudioWorkletProcessor {
    #block = new Float32Array(2048);
    #filled = 0;

    process(inputs) {
        const channel = inputs[0]?.[0];
        if (!channel) return true;
        for (let i = 0; i < channel.length; i++) {
            this.#block[this.#filled++] = channel[i];
            if (this.#filled === this.#block.length) {
                this.port.postMessage(this.#block, [this.#block.buffer]);
                this.#block = new Float32Array(2048);
                this.#filled = 0;
            }
        }
        return true;
    }
}
registerProcessor('agora-pcm-tap', PcmTap);
