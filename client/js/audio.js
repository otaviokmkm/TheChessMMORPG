// Streaming music player for the provided MP3
class AudioStreamEngine {
  constructor() {
    this.audio = null;
    this.isRunning = false;
    this.src = '/media/music';
  }
  ensureAudio() {
    if (this.audio) return;
    const a = new Audio(this.src);
    a.loop = true;
    a.preload = 'auto';
    a.crossOrigin = 'anonymous';
    this.audio = a;
  }
  async start() {
    this.ensureAudio();
    if (this.isRunning) return;
    try {
      await this.audio.play();
      this.isRunning = true;
    } catch (e) {
      // Autoplay blocked until user gesture
    }
  }
  stop() {
    if (!this.audio) return;
    this.audio.pause();
    // Reset to start when muted/stopped so resuming starts from the beginning
    try { this.audio.currentTime = 0; } catch {}
    this.isRunning = false;
  }
  toggle() { this.isRunning ? this.stop() : this.start(); }
}

export const AudioEngine = new AudioStreamEngine();
