/**
 * Procedural audio for Sporefall.
 *
 * We synthesize every sound with the Web Audio API instead of shipping audio
 * files — the rest of the game is fully procedural (no sprite/image assets)
 * so adding a binary asset pipeline for one feature would be disproportionate.
 *
 * Everything runs through a single master gain so the mute toggle is a single
 * value change; the AudioContext is created lazily on the first user gesture
 * because browsers block audio until one has happened.
 */
const MUTE_KEY = "sporefall.muted";
const VOLUME_KEY = "sporefall.volume";
const MASTER_VOLUME = 0.5;
const AMBIENT_VOLUME = 0.045;

type WindowWithWebkitAudio = Window & {
  webkitAudioContext?: typeof AudioContext;
};

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private dynamics: DynamicsCompressorNode | null = null;
  private ambientStop: (() => void) | null = null;
  private musicStop: (() => void) | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;
  private volume = 0.85;
  private lastEventAt = new Map<string, number>();

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === "1";
      const storedVolume = Number(localStorage.getItem(VOLUME_KEY));
      if (Number.isFinite(storedVolume)) {
        this.volume = Math.max(0, Math.min(1, storedVolume));
      }
    } catch {
      this.muted = false;
      this.volume = 0.85;
    }
  }

  /** Call from inside any genuine user-gesture handler to unlock audio. */
  resume(): void {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {
        /* user may deny; silent fallback */
      });
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    try {
      localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    } catch {
      /* storage may be unavailable (private mode) */
    }
    if (this.master && this.ctx) {
      const target = muted ? 0 : MASTER_VOLUME * this.volume;
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(target, now, 0.05);
    }
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  getVolume(): number {
    return this.volume;
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    try {
      localStorage.setItem(VOLUME_KEY, String(this.volume));
    } catch {
      /* storage may be unavailable (private mode) */
    }
    if (this.master && this.ctx && !this.muted) {
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(MASTER_VOLUME * this.volume, now, 0.04);
    }
  }

  // ---------- one-shot SFX ----------

  /** Short wood-block "tok" the moment a structure is placed. */
  playBuildStart(): void {
    const ctx = this.ensureCtx();
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(90, now + 0.12);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.35, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.22);
    // Add a tiny click/noise transient so taps feel less synthetic.
    const noise = this.playNoise(0.05, 1800, 0.045, now);
    if (noise) noise.stop(now + 0.07);
  }

  /** Soft rising chirp when a structure finishes growing into active. */
  playBuildComplete(): void {
    const ctx = this.ensureCtx();
    if (!ctx || !this.master || !this.allowEvent("buildComplete", 70)) return;
    this.playSineBlip([330, 440], 0.2, "sine", 0.22);
    this.playSineBlip([660], 0.03, "triangle", 0.08);
  }

  /** Bell-like two-tone chime when a mutation upgrade finishes. */
  playMutateComplete(): void {
    const ctx = this.ensureCtx();
    if (!ctx || !this.master || !this.allowEvent("mutateComplete", 110)) return;
    const now = ctx.currentTime;
    const freqs = [523.25, 659.25]; // C5 + E5
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f;
      const g = ctx.createGain();
      const start = now + i * 0.04;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.22, start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.6);
      osc.connect(g).connect(this.master!);
      osc.start(start);
      osc.stop(start + 0.65);
    });
    this.playNoise(0.08, 2500, 0.028, now);
  }

  /** Impact / clash thud when a structure gets disabled. */
  playDisable(): void {
    const ctx = this.ensureCtx();
    if (!ctx || !this.master || !this.allowEvent("disable", 90)) return;
    const now = ctx.currentTime;
    // Pitch-dropping triangle for a softer "thud" body.
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(55, now + 0.25);
    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0.0001, now);
    oscGain.gain.exponentialRampToValueAtTime(0.16, now + 0.005);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
    osc.connect(oscGain).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.38);
    // Noise grit layer.
    const noise = this.playNoise(0.25, 850, 0.13, now);
    if (noise) noise.stop(now + 0.28);
  }

  /** Airy whoosh when a fruiting body releases its surge. */
  playSurge(): void {
    const ctx = this.ensureCtx();
    if (!ctx || !this.master || !this.allowEvent("surge", 120)) return;
    const now = ctx.currentTime;
    const src = this.makeNoiseSource();
    if (!src) return;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 1.1;
    filter.frequency.setValueAtTime(2200, now);
    filter.frequency.exponentialRampToValueAtTime(420, now + 0.45);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(now);
    src.stop(now + 0.55);
  }

  /** Rising major arpeggio on victory. */
  playWin(): void {
    // C E G C (major triad + octave)
    this.playArpeggio([523.25, 659.25, 783.99, 1046.5], 0.12, "triangle", 0.3);
  }

  /** Descending minor drop on defeat. */
  playLose(): void {
    // C Ab F — minor-feeling fall
    this.playArpeggio([523.25, 415.3, 349.23], 0.18, "sawtooth", 0.22);
  }

  /** Soft tick for each countdown number (3…2…1). */
  playCountdownTick(): void {
    this.playSineBlip([660], 0.06, "sine", 0.18);
  }

  /** Brighter tap when the countdown hits GO. */
  playCountdownGo(): void {
    this.playSineBlip([523.25, 1046.5], 0.14, "triangle", 0.28);
  }

  // ---------- ambient loop ----------

  startAmbient(): void {
    const ctx = this.ensureCtx();
    if (!ctx || !this.master) return;
    if (this.ambientStop) return;

    const now = ctx.currentTime;
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0, now);
    bus.gain.linearRampToValueAtTime(AMBIENT_VOLUME, now + 3);
    bus.connect(this.master);

    // Two sine drones a perfect fifth apart give a warm organic pad without
    // reading as a melody — keeps it out of the way of gameplay SFX.
    const droneFreqs = [55, 82.5];
    const drones = droneFreqs.map((f) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.7;
      osc.connect(g).connect(bus);
      osc.start(now);
      return { osc, g };
    });

    // Slow LFO on the bus gain for a gentle "breathing" swell.
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.08;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.35;
    lfo.connect(lfoDepth);
    // Modulate one of the drone gains so the pad pulses without modulating
    // the overall volume (avoids fighting the master-volume automation).
    lfoDepth.connect(drones[0].g.gain);
    lfo.start(now);

    // Airy noise wash, heavily filtered. Very low amplitude so it reads as
    // "room tone", not static.
    const noiseSrc = this.makeNoiseSource(true);
    let noiseChain: { src: AudioBufferSourceNode; g: GainNode } | null = null;
    if (noiseSrc) {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 600;
      filter.Q.value = 0.4;
      const g = ctx.createGain();
      g.gain.value = 0.08;
      noiseSrc.connect(filter).connect(g).connect(bus);
      noiseSrc.start(now);
      noiseChain = { src: noiseSrc, g };
    }

    this.ambientStop = () => {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      bus.gain.cancelScheduledValues(t);
      bus.gain.setValueAtTime(bus.gain.value, t);
      bus.gain.linearRampToValueAtTime(0, t + 1);
      const stopAt = t + 1.1;
      drones.forEach((d) => {
        try {
          d.osc.stop(stopAt);
        } catch {
          /* already stopped */
        }
      });
      try {
        lfo.stop(stopAt);
      } catch {
        /* already stopped */
      }
      if (noiseChain) {
        try {
          noiseChain.src.stop(stopAt);
        } catch {
          /* already stopped */
        }
      }
    };
  }

  startMusic(): void {
    const ctx = this.ensureCtx();
    if (!ctx || !this.master || this.musicStop) return;
    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.connect(this.master);
    const now = ctx.currentTime;
    bus.gain.linearRampToValueAtTime(0.18, now + 2.4);

    const chordProg = [
      [220, 277.18, 329.63], // A, C#, E
      [196, 246.94, 329.63], // G, B, E
      [174.61, 220, 261.63], // F, A, C
      [196, 246.94, 293.66], // G, B, D
    ];
    const melody = [440, 493.88, 523.25, 659.25, 587.33, 523.25, 493.88, 440];
    const beat = 0.34;
    let bar = 0;
    let disposed = false;

    const scheduleBar = (start: number): void => {
      if (disposed || !this.ctx) return;
      const chord = chordProg[bar % chordProg.length];
      chord.forEach((f) => this.playMusicPadNote(start, 1.15, f, bus));
      for (let i = 0; i < 8; i++) {
        const t = start + i * beat;
        const mf = melody[(bar * 2 + i) % melody.length];
        this.playMusicPluck(t, 0.26, mf, bus, i % 2 === 0 ? "triangle" : "sine");
      }
      bar += 1;
    };

    let nextBarTime = now + 0.06;
    const scheduler = window.setInterval(() => {
      if (!this.ctx || disposed) return;
      while (nextBarTime < this.ctx.currentTime + 0.35) {
        scheduleBar(nextBarTime);
        nextBarTime += beat * 8;
      }
    }, 120);

    this.musicStop = () => {
      disposed = true;
      window.clearInterval(scheduler);
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      bus.gain.cancelScheduledValues(t);
      bus.gain.setValueAtTime(bus.gain.value, t);
      bus.gain.linearRampToValueAtTime(0, t + 0.9);
    };
  }

  stopMusic(): void {
    if (this.musicStop) {
      this.musicStop();
      this.musicStop = null;
    }
  }

  stopAmbient(): void {
    if (this.ambientStop) {
      this.ambientStop();
      this.ambientStop = null;
    }
  }

  // ---------- internals ----------

  private ensureCtx(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      const Ctor =
        window.AudioContext ??
        (window as WindowWithWebkitAudio).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : MASTER_VOLUME * this.volume;
      this.dynamics = this.ctx.createDynamicsCompressor();
      this.dynamics.threshold.value = -22;
      this.dynamics.knee.value = 18;
      this.dynamics.ratio.value = 2.5;
      this.dynamics.attack.value = 0.01;
      this.dynamics.release.value = 0.18;
      this.master.connect(this.dynamics);
      this.dynamics.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
      this.master = null;
    }
    return this.ctx;
  }

  private playSineBlip(
    freqs: number[],
    step: number,
    type: OscillatorType,
    peak: number,
  ): void {
    const ctx = this.ensureCtx();
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = f;
      const g = ctx.createGain();
      const start = now + i * step;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(peak, start + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      osc.connect(g).connect(this.master!);
      osc.start(start);
      osc.stop(start + 0.25);
    });
  }

  /**
   * Rate-limit events so rapid sim updates don't stack identical sounds and
   * turn them into harsh clipping bursts.
   */
  private allowEvent(key: string, minGapMs: number): boolean {
    if (!this.ctx) return false;
    const nowMs = this.ctx.currentTime * 1000;
    const prev = this.lastEventAt.get(key) ?? -Infinity;
    if (nowMs - prev < minGapMs) return false;
    this.lastEventAt.set(key, nowMs);
    return true;
  }

  private playArpeggio(
    freqs: number[],
    step: number,
    type: OscillatorType,
    peak: number,
  ): void {
    const ctx = this.ensureCtx();
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = f;
      const g = ctx.createGain();
      const start = now + i * step;
      const hold = step * 0.6;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(peak, start + 0.015);
      g.gain.setValueAtTime(peak, start + hold);
      g.gain.exponentialRampToValueAtTime(0.0001, start + hold + 0.3);
      osc.connect(g).connect(this.master!);
      osc.start(start);
      osc.stop(start + hold + 0.35);
    });
  }

  private playNoise(
    seconds: number,
    centerHz: number,
    peak: number,
    now: number,
  ): AudioBufferSourceNode | null {
    if (!this.ctx || !this.master) return null;
    const src = this.makeNoiseSource();
    if (!src) return null;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = centerHz;
    filter.Q.value = 1.2;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
    src.connect(filter).connect(g).connect(this.master);
    src.start(now);
    return src;
  }

  private playMusicPadNote(
    start: number,
    length: number,
    freq: number,
    out: AudioNode,
  ): void {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(0.04, start + 0.18);
    g.gain.setValueAtTime(0.04, start + length * 0.72);
    g.gain.exponentialRampToValueAtTime(0.0001, start + length);
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 980;
    osc.connect(lp).connect(g).connect(out);
    osc.start(start);
    osc.stop(start + length + 0.05);
  }

  private playMusicPluck(
    start: number,
    length: number,
    freq: number,
    out: AudioNode,
    type: OscillatorType,
  ): void {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.98, start + length);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(0.05, start + 0.016);
    g.gain.exponentialRampToValueAtTime(0.0001, start + length);
    const hp = this.ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 120;
    osc.connect(hp).connect(g).connect(out);
    osc.start(start);
    osc.stop(start + length + 0.03);
  }

  private makeNoiseSource(loop = false): AudioBufferSourceNode | null {
    if (!this.ctx) return null;
    if (!this.noiseBuffer) {
      const sr = this.ctx.sampleRate;
      const buf = this.ctx.createBuffer(1, sr * 2, sr);
      const data = buf.getChannelData(0);
      // Soft pink-ish noise via simple integration of white noise — cheaper
      // than a full pink filter and good enough for a bed.
      let last = 0;
      for (let i = 0; i < data.length; i++) {
        const white = Math.random() * 2 - 1;
        last = 0.98 * last + 0.02 * white;
        data[i] = last * 6;
      }
      this.noiseBuffer = buf;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = loop;
    return src;
  }
}

// Module-level singleton so the audio context and ambient loop survive
// `scene.restart()` — Phaser reuses the scene instance but we don't want to
// re-create an AudioContext (browsers rate-limit them) or hear the ambient
// bed clip in and out across every restart.
let instance: AudioManager | null = null;
export function getAudio(): AudioManager {
  if (!instance) instance = new AudioManager();
  return instance;
}
