import {
  createStoppedSegment,
  positionAt,
  rateAt,
  retargetSegment,
  seekSegment,
  startSegment,
  stopSegment,
  type TransportLoop,
  type TransportSegment,
} from '@/lib/transportClock';

export type StemType = 'drums' | 'inst' | 'vocals';
export type NeuralStemGains = Record<StemType, { a: number; b: number }>;
const NEURAL_STEM_GAIN = 1.0; // 1.0 since stems are now frequency-isolated 
const NEURAL_DRUMS_THRESHOLD = 0.25;
const NEURAL_INST_THRESHOLD = 0.5;
const NEURAL_VOCALS_THRESHOLD = 0.75;

export const calculateNeuralGains = (xfade: number): NeuralStemGains => {
  const norm = Math.max(0, Math.min(1, (xfade + 1) / 2));

  // Drums and instruments intentionally hard-swap at their power points; timing smoothness is applied
  // in the deck hook with sub-10ms/short ramps so the stems trade places without kick or tonal clashes.
  return {
    drums: norm > NEURAL_DRUMS_THRESHOLD ? { a: 0, b: NEURAL_STEM_GAIN } : { a: NEURAL_STEM_GAIN, b: 0 },
    inst: norm > NEURAL_INST_THRESHOLD ? { a: 0, b: NEURAL_STEM_GAIN } : { a: NEURAL_STEM_GAIN, b: 0 },
    vocals: norm > NEURAL_VOCALS_THRESHOLD ? { a: 0, b: NEURAL_STEM_GAIN } : { a: NEURAL_STEM_GAIN, b: 0 },
  };
};

export class AudioEngine {
  private static instance: AudioEngine;
  public context: AudioContext;
  public masterGain: GainNode;
  public masterAnalyser: AnalyserNode;
  public cueGain: GainNode;
  // Split-mono cueing on one stereo output (like a DJ splitter cable): limited main mix in mono on
  // the left, cue bus in mono on the right. Only one of {limiter, splitMonoMerger} ever feeds the
  // speakers, so the main mix is never doubled or routed around the limiter.
  private splitMonoMain: GainNode;
  private splitMonoCue: GainNode;
  private splitMonoMerger: ChannelMergerNode;
  private isSplitMono = false;
  private remixBus: GainNode;
  private limiter: DynamicsCompressorNode;
  private bunkerConvolver: ConvolverNode;
  private bunkerWetGain: GainNode;
  private bunkerDryGain: GainNode;
  private bunkerPreDelay: DelayNode;
  private bunkerImpulseLoaded = false;
  private bunkerImpulseWarningLogged = false;
  private masterDataArray: Uint8Array<ArrayBuffer>;
  private workletReadyPromise: Promise<boolean> | null = null;
  private workletWarningLogged = false;
  private recordingDestination: MediaStreamAudioDestinationNode | null = null;
  // Per-deck SoundTouch fallback engine for Key Lock (used when native preservesPitch is absent)
  private deckKeyLockEngines: Partial<Record<'A' | 'B', {
    node: ScriptProcessorNode;
    filter: { sourcePosition: number; extract(target: Float32Array, numFrames: number): number; clear(): void };
    soundTouch: { tempo: number };
    buffer: AudioBuffer;
  }>> = {};
  private nativeKeyLockSupported: boolean | null = null;
  private readonly latencyHint: AudioContextLatencyCategory = 'interactive';
  private deckAnalysers: Partial<Record<'A' | 'B', AnalyserNode>> = {};
  private deckDataArrays: Partial<Record<'A' | 'B', Uint8Array<ArrayBuffer>>> = {};
  private decks: Record<'A' | 'B', {
    buffer: AudioBuffer | null;
    source: AudioBufferSourceNode | null;
    stemInput: GainNode | null;
    deckGain: GainNode | null;
    isPlaying: boolean;
    playbackRate: number;
    pauseTime: number;
    currentTime: number;
    keyLockEnabled: boolean;
    onSourceSwap?: (source: AudioBufferSourceNode | null) => void;
    onPauseTime?: (time: number) => void;
  }> = {
    A: {
      buffer: null,
      source: null,
      stemInput: null,
      deckGain: null,
      isPlaying: false,
      playbackRate: 1,
      pauseTime: 0,
      currentTime: 0,
      keyLockEnabled: false,
    },
    B: {
      buffer: null,
      source: null,
      stemInput: null,
      deckGain: null,
      isPlaying: false,
      playbackRate: 1,
      pauseTime: 0,
      currentTime: 0,
      keyLockEnabled: false,
    },
  };
  private originalPlayState: Record<'A' | 'B', boolean> = { A: false, B: false };
  /**
   * Computed playhead per deck (see lib/transportClock.ts). Updated at the same moment any audio
   * change is scheduled (start, stop, seek, stutter, loop, rate glide), so position reads are exact
   * at any context time instead of being polled from React state.
   */
  private clocks: Record<'A' | 'B', TransportSegment> = {
    A: createStoppedSegment(),
    B: createStoppedSegment(),
  };
  private deckFxBuses: Partial<Record<'A' | 'B', {
    input: GainNode;
    crushBypassGain: GainNode;
    crushPreGain: GainNode;
    crushNode: AudioWorkletNode | GainNode;
    crushSupported: boolean;
    crushState: { step: number; holdSample: number; decimation: number; reduction: number };
    crushPostGain: GainNode;
    filter: BiquadFilterNode;
    delayNode: DelayNode;
    delayFeedbackGain: GainNode;
    delayMixGain: GainNode;
    dryGain: GainNode;
    deckGain: GainNode;
    output: GainNode;
  }>> = {};
  private stemGains: Partial<Record<'A' | 'B', {
    drums: GainNode;
    inst: GainNode;
    vocals: GainNode;
  }>> = {};
  private stemDirectGains: Partial<Record<'A' | 'B', {
    drums: GainNode;
    inst: GainNode;
    vocals: GainNode;
  }>> = {};
  private stemFxGains: Partial<Record<'A' | 'B', {
    drums: GainNode;
    inst: GainNode;
    vocals: GainNode;
  }>> = {};
  private stemChains: Partial<Record<'A' | 'B', {
    input: GainNode;
    output: GainNode;
    fxOutput: GainNode;
  }>> = {};
  private stemCrossoverFilters: Partial<Record<'A' | 'B', {
    lowLP1: BiquadFilterNode;
    lowLP2: BiquadFilterNode;
    midHP1: BiquadFilterNode;
    midHP2: BiquadFilterNode;
    midLP1: BiquadFilterNode;
    midLP2: BiquadFilterNode;
    highHP1: BiquadFilterNode;
    highHP2: BiquadFilterNode;
  }>> = {};
  private deckCueGains: Partial<Record<'A' | 'B', GainNode>> = {};
  private performanceLoops: Record<'A' | 'B', {
    mode: 'slip-roll' | 'beat-break' | null;
    originTime: number;
    loopStart: number;
    loopDuration: number;
    startedAtContextTime: number;
    wasPlaying: boolean;
  }> = {
    A: { mode: null, originTime: 0, loopStart: 0, loopDuration: 0, startedAtContextTime: 0, wasPlaying: false },
    B: { mode: null, originTime: 0, loopStart: 0, loopDuration: 0, startedAtContextTime: 0, wasPlaying: false },
  };
  private static readonly STEM_COUNT = 3;
  private static readonly DEFAULT_PLAYBACK_RAMP = 0.01;
  private static readonly KEY_LOCK_PLAYBACK_RAMP = 0.02;
  private static readonly CRUSH_ACTIVATION_THRESHOLD = 0.001;
  private static readonly MIN_PERFORMANCE_LOOP_DURATION = 0.05;
  private static readonly TARGET_RECORDING_SAMPLE_RATE = 48000;
  private static readonly TARGET_RECORDING_BIT_DEPTH = 24;
  // ── Bipolar filter constants ──
  private static readonly FILTER_CENTER_VALUE = 50;
  private static readonly FILTER_BYPASS_THRESHOLD = 1;
  private static readonly FILTER_MAX_FREQ = 20000;
  private static readonly FILTER_MIN_FREQ = 20;
  private static readonly FILTER_BASE_RESONANCE = 0.7;
  private static readonly FILTER_RESONANCE_RANGE = 4;

  private constructor() {
    if (typeof window === 'undefined') {
      throw new Error('AudioEngine can only be constructed in the browser.');
    }

    const AudioContextCtor = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
    if (!AudioContextCtor) {
      throw new Error('Web Audio API is unavailable in this browser.');
    }

    try {
      this.context = new AudioContextCtor({
        latencyHint: this.latencyHint,
        sampleRate: AudioEngine.TARGET_RECORDING_SAMPLE_RATE,
      });
    } catch {
      this.context = new AudioContextCtor();
    }
    this.masterGain = this.context.createGain();
    this.masterGain.gain.value = 0.5;
    this.cueGain = this.context.createGain();
    this.cueGain.gain.value = 1;
    this.splitMonoMain = this.createMonoDownmix();
    this.splitMonoCue = this.createMonoDownmix();
    this.splitMonoMerger = this.context.createChannelMerger(2);
    this.remixBus = this.context.createGain();
    this.remixBus.gain.value = 0.72;

    this.masterAnalyser = this.context.createAnalyser();
    this.masterAnalyser.fftSize = 512;
    this.masterAnalyser.smoothingTimeConstant = 0.85;
    this.masterDataArray = new Uint8Array(new ArrayBuffer(this.masterAnalyser.frequencyBinCount));
    this.limiter = this.context.createDynamicsCompressor();
    this.limiter.threshold.setValueAtTime(-1, this.context.currentTime);
    this.limiter.knee.setValueAtTime(0, this.context.currentTime);
    this.limiter.ratio.setValueAtTime(20, this.context.currentTime);
    this.limiter.attack.setValueAtTime(0.003, this.context.currentTime);
    this.limiter.release.setValueAtTime(0.1, this.context.currentTime);

    this.bunkerConvolver = this.context.createConvolver();
    this.bunkerPreDelay = this.context.createDelay(1.0);
    this.bunkerPreDelay.delayTime.value = 0.02; // 20ms
    this.bunkerWetGain = this.context.createGain();
    this.bunkerDryGain = this.context.createGain();
    this.bunkerWetGain.gain.value = 0.2;
    this.bunkerDryGain.gain.value = 0.8;

    // Master routing: masterGain -> analyser -> (dry + bunker) -> limiter -> destination
    this.masterGain.connect(this.masterAnalyser);
    this.masterAnalyser.connect(this.bunkerDryGain);
    this.masterAnalyser.connect(this.bunkerPreDelay);
    this.bunkerPreDelay.connect(this.bunkerConvolver);
    this.bunkerConvolver.connect(this.bunkerWetGain);

    this.bunkerDryGain.connect(this.limiter);
    this.bunkerWetGain.connect(this.limiter);
    // Remix bus is intentionally post-master-FX but pre-limiter so captured loops bypass deck/master FX
    // coloration while still landing inside the final safety stage.
    this.remixBus.connect(this.limiter);
    // Normal stereo output: the limiter is the only path to the speakers.
    this.limiter.connect(this.context.destination);
    // Split-mono bus, pre-wired but only reaches the speakers while enabled (setSplitMonoEnabled).
    this.limiter.connect(this.splitMonoMain);
    this.splitMonoMain.connect(this.splitMonoMerger, 0, 0);
    this.cueGain.connect(this.splitMonoCue);
    this.splitMonoCue.connect(this.splitMonoMerger, 0, 1);

    // Recording tap: connect the final post-limiter signal to the MediaStreamDestination
    this.recordingDestination = this.context.createMediaStreamDestination();
    this.limiter.connect(this.recordingDestination);

    this.workletReadyPromise = this.ensureAudioWorklets();
    void this.loadBunkerImpulse();
  }

  /** Gain node that downmixes any input to mono (0.5 × (L + R) for stereo). */
  private createMonoDownmix() {
    const node = this.context.createGain();
    node.channelCount = 1;
    node.channelCountMode = 'explicit';
    node.channelInterpretation = 'speakers';
    return node;
  }

  public static getInstance(): AudioEngine {
    if (typeof window === 'undefined') {
      throw new Error('AudioEngine is unavailable during server-side rendering.');
    }
    if (!AudioEngine.instance) {
      AudioEngine.instance = new AudioEngine();
    }
    return AudioEngine.instance;
  }

  public async resume() {
    if (this.context.state === 'suspended') {
      await this.context.resume();
    }
  }

  public async loadBuffer(file: File | Blob | string): Promise<AudioBuffer> {
    let arrayBuffer: ArrayBuffer;
    if (typeof file === 'string') {
      const response = await fetch(file);
      if (!response.ok) throw new Error(`Failed to fetch from cloud: ${response.status} - ${file}`);
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('text/html')) {
        throw new Error('Cloudflare returned an HTML error page. Check exact filename and path.');
      }
      arrayBuffer = await response.arrayBuffer();
    } else {
      arrayBuffer = await file.arrayBuffer();
    }
    return await this.context.decodeAudioData(arrayBuffer);
  }

  public createPitchLockedSource(deckId: 'A' | 'B', buffer: AudioBuffer) {
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    this.applyPitchLock(source, deckId);
    return source;
  }

  public registerDeckRuntime(
    deckId: 'A' | 'B',
    payload: Partial<{
      buffer: AudioBuffer | null;
      source: AudioBufferSourceNode | null;
        stemInput: GainNode | null;
        deckGain: GainNode | null;
        isPlaying: boolean;
        playbackRate: number;
        pauseTime: number;
        currentTime: number;
        keyLockEnabled: boolean;
        onSourceSwap?: (source: AudioBufferSourceNode | null) => void;
        onPauseTime?: (time: number) => void;
      }>
  ) {
    this.decks[deckId] = {
      ...this.decks[deckId],
      ...payload,
    };
  }

  public startStutter(deckId: 'A' | 'B', time: number) {
    const deck = this.decks[deckId];
    if (!deck?.buffer || !deck.stemInput || !deck.deckGain) return null;

    const now = this.context.currentTime;
    const targetTime = Math.max(0, Math.min(time, deck.buffer.duration));
    this.originalPlayState[deckId] = deck.isPlaying;

    // Anti-click fade out of the current source
    deck.deckGain.gain.cancelScheduledValues(now);
    deck.deckGain.gain.setValueAtTime(deck.deckGain.gain.value, now);
    deck.deckGain.gain.linearRampToValueAtTime(0, now + 0.002);

    if (deck.source) {
      try {
        deck.source.stop(now + 0.002);
      } catch {
        // Source might already be stopped
      }
      deck.source.disconnect();
    }

    // Recreate a fresh source and start from the requested position
    const freshSource = this.createPitchLockedSource(deckId, deck.buffer);
    freshSource.playbackRate.value = deck.playbackRate;
    freshSource.connect(deck.stemInput);
    freshSource.start(now + 0.002, targetTime);
    this.clocks[deckId] = startSegment(this.clockFor(deckId), targetTime, deck.playbackRate, now + 0.002);

    deck.deckGain.gain.setValueAtTime(0, now + 0.002);
    deck.deckGain.gain.linearRampToValueAtTime(1, now + 0.004);

    deck.source = freshSource;
    deck.isPlaying = true;
    deck.pauseTime = targetTime;
    deck.onSourceSwap?.(freshSource);
    deck.onPauseTime?.(targetTime);

    return freshSource;
  }

  public seekTo(deckId: 'A' | 'B', time: number) {
    const deck = this.decks[deckId];
    if (!deck?.buffer || !deck.stemInput || !deck.deckGain) return;

    const now = this.context.currentTime;
    const targetTime = Math.max(0, Math.min(time, deck.buffer.duration));

    // If not playing, just update the position for the next play
    if (!deck.isPlaying) {
      this.clocks[deckId] = seekSegment(this.clockFor(deckId), targetTime, now);
      deck.pauseTime = targetTime;
      deck.onPauseTime?.(targetTime);
      return;
    }

    // If playing, we need to swap sources smoothly
    deck.deckGain.gain.cancelScheduledValues(now);
    deck.deckGain.gain.setValueAtTime(deck.deckGain.gain.value, now);
    deck.deckGain.gain.linearRampToValueAtTime(0, now + 0.003);

    if (deck.source) {
      try {
        deck.source.stop(now + 0.003);
      } catch {
        // Source might already be stopped
      }
      deck.source.disconnect();
    }

    const freshSource = this.createPitchLockedSource(deckId, deck.buffer);
    freshSource.playbackRate.value = deck.playbackRate;
    freshSource.connect(deck.stemInput);
    // The new source starts 3 ms from now (anti-click fade), so start it 3 ms further into the
    // track: "seek to T" then means "be at T now", which keeps beat jumps exactly in phase.
    const startPosition = Math.min(targetTime + 0.003 * deck.playbackRate, deck.buffer.duration);
    freshSource.start(now + 0.003, startPosition);
    this.clocks[deckId] = startSegment(this.clockFor(deckId), startPosition, deck.playbackRate, now + 0.003);

    deck.deckGain.gain.setValueAtTime(0, now + 0.003);
    deck.deckGain.gain.linearRampToValueAtTime(1, now + 0.006);

    deck.source = freshSource;
    deck.pauseTime = targetTime;
    deck.onSourceSwap?.(freshSource);
    deck.onPauseTime?.(targetTime);
  }

  public stopStutter(deckId: 'A' | 'B', time: number) {
    const deck = this.decks[deckId];
    if (!deck?.deckGain) return;
    const now = this.context.currentTime;
    const targetTime = deck.buffer ? Math.max(0, Math.min(time, deck.buffer.duration)) : time;

    if (!this.originalPlayState[deckId]) {
      deck.deckGain.gain.cancelScheduledValues(now);
      deck.deckGain.gain.setValueAtTime(deck.deckGain.gain.value, now);
      deck.deckGain.gain.linearRampToValueAtTime(0, now + 0.002);

      if (deck.source) {
        try {
          deck.source.stop(now + 0.002);
        } catch {
          // ignore
        }
        deck.source.disconnect();
        deck.source = null;
        deck.onSourceSwap?.(null);
      }

      this.clocks[deckId] = stopSegment(this.clockFor(deckId), now, targetTime);
      deck.isPlaying = false;
      deck.pauseTime = targetTime;
      deck.onPauseTime?.(targetTime);
    }

    // Reset the remembered state for the next gesture
    this.originalPlayState[deckId] = false;
  }

  public createStemChain(deckId: 'A' | 'B') {
    // Reuse existing nodes to prevent duplicate audio nodes in the graph
    const existingGains = this.stemGains[deckId];
    const existingChain = this.stemChains[deckId];
    if (existingGains && existingChain) {
      return existingChain;
    }

    const input = this.context.createGain();
    const output = this.context.createGain();
    const fxOutput = this.context.createGain();
    const cueSend = this.deckCueGains[deckId] ?? this.context.createGain();

    const drumsGain = existingGains?.drums ?? this.context.createGain();
    const instGain = existingGains?.inst ?? this.context.createGain();
    const vocalsGain = existingGains?.vocals ?? this.context.createGain();
    const drumsDirectGain = this.context.createGain();
    const instDirectGain = this.context.createGain();
    const vocalsDirectGain = this.context.createGain();
    const drumsFxGain = this.context.createGain();
    const instFxGain = this.context.createGain();
    const vocalsFxGain = this.context.createGain();

    // Unity gain per stem — the Linkwitz-Riley crossover handles band isolation;
    // each stem gain node is now purely for mute/level control.
    [drumsGain, instGain, vocalsGain].forEach((gainNode) => {
      gainNode.gain.value = 1.0;
    });
    cueSend.gain.value = 0;
    // Before Phase 7 every stem branch fed the deck FX bus, so deck FX always processed the full deck.
    // Start in that same all-to-FX posture so existing mixes still sound identical until the user
    // deliberately drops specific stems back to the dry path via the new FX Sends controls.
    [drumsDirectGain, instDirectGain, vocalsDirectGain].forEach((gainNode) => {
      gainNode.gain.value = 0;
    });
    [drumsFxGain, instFxGain, vocalsFxGain].forEach((gainNode) => {
      gainNode.gain.value = 1;
    });

    // ── Linkwitz-Riley 4th-order crossover (LR4) ──────────────────────────
    // Two cascaded 2nd-order Butterworth filters per band edge.
    // Low (drums):  LP @ 250 Hz
    // Mid (vocals): HP @ 250 Hz + LP @ 4000 Hz
    // High (inst):  HP @ 4000 Hz
    const LR_Q = 0.7071; // Butterworth Q for 2nd-order
    const LOW_FREQ = 250;
    const HIGH_FREQ = 4000;

    const createLP = (freq: number): BiquadFilterNode => {
      const f = this.context.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = freq;
      f.Q.value = LR_Q;
      return f;
    };
    const createHP = (freq: number): BiquadFilterNode => {
      const f = this.context.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = freq;
      f.Q.value = LR_Q;
      return f;
    };

    // Low band: two cascaded lowpass at 250 Hz
    const lowLP1 = createLP(LOW_FREQ);
    const lowLP2 = createLP(LOW_FREQ);
    // Mid band: two cascaded highpass at 250 Hz → two cascaded lowpass at 4000 Hz
    const midHP1 = createHP(LOW_FREQ);
    const midHP2 = createHP(LOW_FREQ);
    const midLP1 = createLP(HIGH_FREQ);
    const midLP2 = createLP(HIGH_FREQ);
    // High band: two cascaded highpass at 4000 Hz
    const highHP1 = createHP(HIGH_FREQ);
    const highHP2 = createHP(HIGH_FREQ);

    this.stemCrossoverFilters[deckId] = {
      lowLP1, lowLP2, midHP1, midHP2, midLP1, midLP2, highHP1, highHP2,
    };

    // Wire: input → [low crossover → drums gain] + [mid crossover → vocals gain] + [high crossover → inst gain]
    input.connect(lowLP1);
    lowLP1.connect(lowLP2);
    lowLP2.connect(drumsGain);

    input.connect(midHP1);
    midHP1.connect(midHP2);
    midHP2.connect(midLP1);
    midLP1.connect(midLP2);
    midLP2.connect(vocalsGain);

    input.connect(highHP1);
    highHP1.connect(highHP2);
    highHP2.connect(instGain);

    input.connect(cueSend);

    drumsGain.connect(drumsDirectGain);
    drumsGain.connect(drumsFxGain);
    instGain.connect(instDirectGain);
    instGain.connect(instFxGain);
    vocalsGain.connect(vocalsDirectGain);
    vocalsGain.connect(vocalsFxGain);

    drumsDirectGain.connect(output);
    instDirectGain.connect(output);
    vocalsDirectGain.connect(output);
    drumsFxGain.connect(fxOutput);
    instFxGain.connect(fxOutput);
    vocalsFxGain.connect(fxOutput);
    cueSend.connect(this.cueGain);

    this.stemGains[deckId] = { drums: drumsGain, inst: instGain, vocals: vocalsGain };
    this.stemDirectGains[deckId] = { drums: drumsDirectGain, inst: instDirectGain, vocals: vocalsDirectGain };
    this.stemFxGains[deckId] = { drums: drumsFxGain, inst: instFxGain, vocals: vocalsFxGain };
    this.stemChains[deckId] = { input, output, fxOutput };
    this.deckCueGains[deckId] = cueSend;

    return this.stemChains[deckId]!;
  }

  private async ensureAudioWorklets(): Promise<boolean> {
    if (!this.context.audioWorklet) {
      if (!this.workletWarningLogged) {
        console.warn('[AudioEngine] AudioWorklet unavailable. Crush FX will run in bypass mode.');
        this.workletWarningLogged = true;
      }
      return false;
    }

    try {
      await this.context.audioWorklet.addModule('/worklets/bitcrusher-processor.js');
      return true;
    } catch (error) {
      if (!this.workletWarningLogged) {
        const message = error instanceof Error ? error.message : 'unknown worklet load failure';
        console.warn(`[AudioEngine] Failed to load bitcrusher worklet (${message}). Crush FX will run in bypass mode.`);
        this.workletWarningLogged = true;
      }
      return false;
    }
  }

  private async createCrushNode(initialDecimation: number, initialReduction: number) {
    const workletReady = this.workletReadyPromise ? await this.workletReadyPromise : await this.ensureAudioWorklets();
    if (!workletReady) {
      return {
        crushNode: this.context.createGain(),
        crushSupported: false,
        crushState: { step: 0, holdSample: 0, decimation: initialDecimation, reduction: initialReduction }
      };
    }

    const crushNode = new AudioWorkletNode(this.context, 'bitcrusher-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      parameterData: {
        decimation: initialDecimation,
        reduction: initialReduction,
      }
    });

    const crushState = { step: 0, holdSample: 0, decimation: initialDecimation, reduction: initialReduction };
    return { crushNode, crushSupported: true, crushState };
  }

  public async createDeckFxBus(deckId: 'A' | 'B') {
    if (this.deckFxBuses[deckId]) {
      return this.deckFxBuses[deckId];
    }

    const input = this.context.createGain();
    const crushBypassGain = this.context.createGain();
    const crushPreGain = this.context.createGain();
    const { crushNode, crushSupported, crushState } = await this.createCrushNode(4, 4);
    const crushPostGain = this.context.createGain();
    const filter = this.context.createBiquadFilter();
    const delayNode = this.context.createDelay(2);
    const delayFeedbackGain = this.context.createGain();
    const delayMixGain = this.context.createGain();
    const dryGain = this.context.createGain();
    const deckGain = this.context.createGain();
    const output = this.context.createGain();

    filter.type = 'lowpass';
    filter.frequency.value = 20000;
    filter.Q.value = 0.7;

    delayNode.delayTime.value = 0.18;
    delayFeedbackGain.gain.value = 0.22;
    delayMixGain.gain.value = 0;
    dryGain.gain.value = 1;
    deckGain.gain.value = 0.9;
    crushBypassGain.gain.value = 1;

    input.connect(crushBypassGain);
    input.connect(crushPreGain);
    crushBypassGain.connect(filter);
    crushPreGain.connect(crushNode);
    crushNode.connect(crushPostGain);
    crushPostGain.connect(filter);

    filter.connect(dryGain);
    filter.connect(delayNode);

    delayNode.connect(delayFeedbackGain);
    delayFeedbackGain.connect(delayNode);
    delayNode.connect(delayMixGain);

    dryGain.connect(deckGain);
    delayMixGain.connect(deckGain);
    deckGain.connect(output);

    const bus = {
      input,
      crushBypassGain,
      crushPreGain,
      crushNode,
      crushSupported,
      crushState,
      crushPostGain,
      filter,
      delayNode,
      delayFeedbackGain,
      delayMixGain,
      dryGain,
      deckGain,
      output,
    };
    this.deckFxBuses[deckId] = bus;
    this.setDeckFX(deckId, 'filter', 50);
    this.setDeckFX(deckId, 'echo', 0);
    this.setDeckFX(deckId, 'crush', 0);
    return bus;
  }

  public setDeckFX(deckId: 'A' | 'B', type: 'filter' | 'echo' | 'crush', value: number, bpm?: number) {
    const fx = this.deckFxBuses[deckId];
    if (!fx) return;
    const now = this.context.currentTime;
    const norm = Math.max(0, Math.min(1, value / 100));

    if (type === 'filter') {
      const center = AudioEngine.FILTER_CENTER_VALUE;
      if (Math.abs(value - center) < AudioEngine.FILTER_BYPASS_THRESHOLD) {
        // Neutral: bypass by opening the filter wide
        fx.filter.type = 'lowpass';
        fx.filter.frequency.setTargetAtTime(AudioEngine.FILTER_MAX_FREQ, now, 0.03);
        fx.filter.Q.setTargetAtTime(AudioEngine.FILTER_BASE_RESONANCE, now, 0.03);
        return;
      }
      if (value < center) {
        // Lowpass sweep down
        const cutoff = AudioEngine.FILTER_MAX_FREQ * Math.pow(AudioEngine.FILTER_MIN_FREQ / AudioEngine.FILTER_MAX_FREQ, (center - value) / center);
        fx.filter.type = 'lowpass';
        fx.filter.frequency.setTargetAtTime(cutoff, now, 0.03);
      } else {
        // Highpass sweep up
        const cutoff = AudioEngine.FILTER_MIN_FREQ * Math.pow(AudioEngine.FILTER_MAX_FREQ / AudioEngine.FILTER_MIN_FREQ, (value - center) / center);
        fx.filter.type = 'highpass';
        fx.filter.frequency.setTargetAtTime(cutoff, now, 0.03);
      }
      const resonance = AudioEngine.FILTER_BASE_RESONANCE + (1 - Math.abs(value - center) / center) * AudioEngine.FILTER_RESONANCE_RANGE;
      fx.filter.Q.setTargetAtTime(resonance, now, 0.03);
      return;
    }

    if (type === 'echo') {
      const safeBpm = (bpm && Number.isFinite(bpm) && bpm > 0) ? bpm : 120;
      const beatDuration = 60 / safeBpm;
      const syncDelay = beatDuration * 0.75; // 3/4 beat
      const feedback = Math.min(0.88, 0.12 + norm * 0.65);
      const mix = Math.min(0.85, norm * 0.85);
      const dry = 1 - mix * 0.65;
      fx.delayNode.delayTime.setTargetAtTime(syncDelay, now, 0.03);
      fx.delayFeedbackGain.gain.setTargetAtTime(feedback, now, 0.03);
      fx.delayMixGain.gain.setTargetAtTime(mix, now, 0.03);
      fx.dryGain.gain.setTargetAtTime(dry, now, 0.03);
      return;
    }

    if (type === 'crush') {
      const decimation = 1 + norm * 12; // 1..13
      const reduction = 4 + norm * 60; // quantization levels
      // Treat near-zero UI values as "off" so the worklet can fully bypass and stop background fizz.
      const crushActive = norm > AudioEngine.CRUSH_ACTIVATION_THRESHOLD;
      const preGain = crushActive ? 1 - norm * 0.2 : 0;
      const postGain = crushActive ? 1 + norm * 0.9 : 0;
      const bypassGain = crushActive ? 0 : 1;
      fx.crushState.decimation = decimation;
      fx.crushState.reduction = reduction;
      if (fx.crushSupported && fx.crushNode instanceof AudioWorkletNode) {
        const decimationParam = fx.crushNode.parameters.get('decimation');
        const reductionParam = fx.crushNode.parameters.get('reduction');
        decimationParam?.setValueAtTime(decimation, now);
        reductionParam?.setValueAtTime(reduction, now);
      }
      fx.crushBypassGain.gain.setTargetAtTime(bypassGain, now, 0.02);
      fx.crushPreGain.gain.setTargetAtTime(preGain, now, 0.03);
      fx.crushPostGain.gain.setTargetAtTime(postGain, now, 0.03);
    }
  }

  private makeDistortionCurve(amount: number) {
    const samples = 65536;
    const curve = new Float32Array(samples);
    const normalized = Math.max(0, Math.min(1, amount));
    const minBits = 4;
    const maxBits = 16;
    const bits = Math.round(maxBits - normalized * (maxBits - minBits));
    const levels = Math.pow(2, bits - 1);

    for (let i = 0; i < samples; ++i) {
      const x = (i / samples) * 2 - 1;
      const quantized = Math.round(x * levels) / levels;
      curve[i] = quantized;
    }
    return curve;
  }

  private async loadBunkerImpulse() {
    if (this.bunkerImpulseLoaded) return;
    try {
      const res = await fetch('/impulses/concrete-bunker.wav');
      if (!res.ok) throw new Error('Failed IR fetch');
      const array = await res.arrayBuffer();
      this.bunkerConvolver.buffer = await this.context.decodeAudioData(array.slice(0));
      this.bunkerImpulseLoaded = true;
    } catch (error) {
      if (!this.bunkerImpulseWarningLogged) {
        const message = error instanceof Error ? error.message : 'unknown bunker IR load failure';
        console.warn(`[AudioEngine] Falling back to synthetic bunker impulse: ${message}`);
        this.bunkerImpulseWarningLogged = true;
      }
      // Fallback synthetic IR: exponential decay noise burst
      const length = this.context.sampleRate * 2.5;
      const impulse = this.context.createBuffer(2, length, this.context.sampleRate);
      for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
        const data = impulse.getChannelData(channel);
        for (let i = 0; i < length; i++) {
          const decay = Math.exp(-i / (this.context.sampleRate * 1.2));
          data[i] = (Math.random() * 2 - 1) * decay;
        }
      }
      this.bunkerConvolver.buffer = impulse;
      this.bunkerImpulseLoaded = true;
    }
  }

  public setVaultAmbience(amount: number) {
    const wet = Math.max(0, Math.min(1, amount));
    const dry = 1 - wet * 0.5;
    const now = this.context.currentTime;
    this.bunkerWetGain.gain.setTargetAtTime(wet, now, 0.05);
    this.bunkerDryGain.gain.setTargetAtTime(dry, now, 0.05);
  }

  public getMasterEnergy(): { rms: number; low: number } {
    this.masterAnalyser.getByteFrequencyData(this.masterDataArray);
    let sum = 0;
    let lowSum = 0;
    const len = this.masterDataArray.length;
    for (let i = 0; i < len; i++) {
      const v = this.masterDataArray[i] / 255;
      sum += v * v;
      if (i < len * 0.1) lowSum += v;
    }
    return {
      rms: Math.sqrt(sum / len),
      low: lowSum / (len * 0.1),
    };
  }

  public getAudioStats() {
    const contextWithLatency = this.context as AudioContext & { latencyHint?: AudioContextLatencyCategory | number };
    return {
      sampleRate: this.context.sampleRate,
      contextState: this.context.state,
      latencyHint: contextWithLatency.latencyHint ?? this.latencyHint,
      baseLatency: this.context.baseLatency ?? 0,
    };
  }

  public getDeckAnalyser(deckId: 'A' | 'B'): AnalyserNode | null {
    return this.deckAnalysers[deckId] ?? null;
  }

  public registerDeckAnalyser(deckId: 'A' | 'B', analyser: AnalyserNode) {
    this.deckAnalysers[deckId] = analyser;
    this.deckDataArrays[deckId] = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
  }

  public getDeckEnergy(deckId: 'A' | 'B'): { rms: number; peak: number } {
    const analyser = this.deckAnalysers[deckId];
    const arr = this.deckDataArrays[deckId];
    if (!analyser || !arr) return { rms: 0, peak: 0 };
    analyser.getByteTimeDomainData(arr);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < arr.length; i++) {
      const sample = (arr[i] - 128) / 128; // -1..1
      const abs = Math.abs(sample);
      sum += sample * sample;
      if (abs > peak) peak = abs;
    }
    return { rms: Math.sqrt(sum / arr.length), peak };
  }

  public setStemMute(deckId: 'A' | 'B', stemType: StemType, isMuted: boolean) {
    this.setStemLevel(deckId, stemType, isMuted ? 0 : 1);
  }

  public setStemLevel(deckId: 'A' | 'B', stemType: StemType, level: number) {
    const deckStemGains = this.stemGains[deckId];
    if (!deckStemGains) return;
    const clamped = Math.max(0, Math.min(1, level));
    deckStemGains[stemType].gain.setTargetAtTime(clamped, this.context.currentTime, 0.01);
  }

  public setStemContribution(
    deckId: 'A' | 'B',
    stemType: StemType,
    contribution: number,
    options?: { rampSeconds?: number; mode?: 'target' | 'linear' }
  ) {
    const deckStemGains = this.stemGains[deckId];
    if (!deckStemGains) return;
    const clamped = Math.max(0, Math.min(1, contribution));
    const now = this.context.currentTime;
    const rampSeconds = Math.max(0, options?.rampSeconds ?? 0.01);
    const gain = deckStemGains[stemType].gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    if (options?.mode === 'linear') {
      gain.linearRampToValueAtTime(clamped, now + rampSeconds);
      return;
    }
    gain.setTargetAtTime(clamped, now, Math.max(0.001, rampSeconds));
  }

  public setStemFXSend(deckId: 'A' | 'B', stemType: StemType, sendAmount: number) {
    const deckDirectGains = this.stemDirectGains[deckId];
    const deckFxGains = this.stemFxGains[deckId];
    if (!deckDirectGains || !deckFxGains) return;

    const clamped = Math.max(0, Math.min(1, sendAmount));
    const now = this.context.currentTime;
    deckDirectGains[stemType].gain.setTargetAtTime(1 - clamped, now, 0.02);
    deckFxGains[stemType].gain.setTargetAtTime(clamped, now, 0.02);
  }

  /**
   * Switch between normal stereo output and split-mono cueing (main left, cue right).
   * Swaps which single node feeds the speakers; never both.
   */
  public setSplitMonoEnabled(enabled: boolean) {
    if (enabled === this.isSplitMono) return;
    this.isSplitMono = enabled;
    if (enabled) {
      this.limiter.disconnect(this.context.destination);
      this.splitMonoMerger.connect(this.context.destination);
      return;
    }
    this.splitMonoMerger.disconnect(this.context.destination);
    this.limiter.connect(this.context.destination);
  }

  public getSplitMonoEnabled() {
    return this.isSplitMono;
  }

  public setDeckCueEnabled(deckId: 'A' | 'B', enabled: boolean) {
    const cueSend = this.deckCueGains[deckId];
    if (!cueSend) return;
    cueSend.gain.setTargetAtTime(enabled ? 1 : 0, this.context.currentTime, 0.01);
  }

  public toggleKeyLock(deckId: 'A' | 'B') {
    const deck = this.decks[deckId];
    const enabled = !deck.keyLockEnabled;
    deck.keyLockEnabled = enabled;
    if (deck.source) {
      this.applyPitchLock(deck.source, deckId);
    }
    // Key Lock is always "supported": either via native preservesPitch or SoundTouch fallback.
    return { enabled, supported: true };
  }

  public setDeckPlaybackRate(deckId: 'A' | 'B', playbackRate: number) {
    const deck = this.decks[deckId];
    const targetRate = Math.max(0.5, Math.min(2.0, playbackRate));
    deck.playbackRate = targetRate;

    // When the SoundTouch key-lock engine is active, drive its tempo instead of the source.
    const kle = this.deckKeyLockEngines[deckId];
    if (kle) {
      kle.soundTouch.tempo = targetRate;
      this.clocks[deckId] = retargetSegment(this.clockFor(deckId), this.context.currentTime, targetRate, 0);
      return;
    }

    if (!deck.source) {
      return;
    }

    const now = this.context.currentTime;
    // Key Lock needs a slightly slower ramp so the browser's pitch-preserving stretch can settle
    // without zipper noise while still feeling responsive on the tempo fader.
    const smoothing = deck.keyLockEnabled
      ? AudioEngine.KEY_LOCK_PLAYBACK_RAMP
      : AudioEngine.DEFAULT_PLAYBACK_RAMP;
    deck.source.playbackRate.cancelScheduledValues(now);
    deck.source.playbackRate.setValueAtTime(deck.source.playbackRate.value, now);
    deck.source.playbackRate.setTargetAtTime(targetRate, now, smoothing);
    this.clocks[deckId] = retargetSegment(this.clockFor(deckId), now, targetRate, smoothing);
  }

  // ─── Transport clock ────────────────────────────────────────────────────────────

  private clockFor(deckId: 'A' | 'B'): TransportSegment {
    const duration = this.decks[deckId].buffer?.duration ?? Infinity;
    return { ...this.clocks[deckId], duration };
  }

  /** Exact playhead (track seconds) of a deck at a context time (default: now). */
  public getDeckPosition(deckId: 'A' | 'B', at: number = this.context.currentTime): number {
    return positionAt(this.clockFor(deckId), at);
  }

  /** Instantaneous playback rate of a deck (0 while stopped). */
  public getDeckRate(deckId: 'A' | 'B', at: number = this.context.currentTime): number {
    return rateAt(this.clocks[deckId], at);
  }

  /** Record that playback of a deck started at `startAt` from `position` at `rate`. */
  public startDeckClock(deckId: 'A' | 'B', position: number, rate: number, startAt: number = this.context.currentTime, loop: TransportLoop | null = null) {
    this.clocks[deckId] = startSegment(this.clockFor(deckId), position, rate, startAt, loop);
  }

  /** Record that playback stopped now; returns the exact position it stopped at. */
  public stopDeckClock(deckId: 'A' | 'B'): number {
    this.clocks[deckId] = stopSegment(this.clockFor(deckId), this.context.currentTime);
    return this.clocks[deckId].position;
  }

  /** Move a paused deck's clock (scrub, cue, new track). */
  public setDeckClockPosition(deckId: 'A' | 'B', position: number) {
    this.clocks[deckId] = seekSegment(this.clockFor(deckId), position, this.context.currentTime);
  }

  public createEQChain() {
    const low = this.context.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 250;

    const mid = this.context.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 1000;
    mid.Q.value = 1;

    const high = this.context.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 4000;

    // Connect chain: input -> low -> mid -> high -> output
    low.connect(mid);
    mid.connect(high);

    return {
      input: low,
      output: high,
      low,
      mid,
      high
    };
  }

  /**
   * Explicitly disconnects all AudioNodes associated with `deckId`.
   * Call this when a track is unmounted to prevent "setState on unmounted component"
   * warnings and to release Web Audio API resources.
   */
  public disconnectDeck(deckId: 'A' | 'B') {
    const deck = this.decks[deckId];

    // Stop and disconnect the active playback source.
    if (deck.source) {
      try {
        deck.source.stop();
      } catch {
        // Source may already be stopped — ignore.
      }
      deck.source.disconnect();
      deck.source = null;
    }

    // Disconnect stem gain nodes.
    const stemGains = this.stemGains[deckId];
    if (stemGains) {
      stemGains.drums.disconnect();
      stemGains.inst.disconnect();
      stemGains.vocals.disconnect();
    }
    const stemDirectGains = this.stemDirectGains[deckId];
    if (stemDirectGains) {
      stemDirectGains.drums.disconnect();
      stemDirectGains.inst.disconnect();
      stemDirectGains.vocals.disconnect();
    }
    const stemFxGains = this.stemFxGains[deckId];
    if (stemFxGains) {
      stemFxGains.drums.disconnect();
      stemFxGains.inst.disconnect();
      stemFxGains.vocals.disconnect();
    }

    // Disconnect the stem chain input/output.
    const stemChain = this.stemChains[deckId];
    if (stemChain) {
      stemChain.input.disconnect();
      stemChain.output.disconnect();
      stemChain.fxOutput.disconnect();
    }
    const cueSend = this.deckCueGains[deckId];
    if (cueSend) {
      cueSend.disconnect();
    }

    // Disconnect the per-deck analyser.
    const analyser = this.deckAnalysers[deckId];
    if (analyser) {
      analyser.disconnect();
    }

    // Disconnect the FX bus output from the master chain.
    const fxBus = this.deckFxBuses[deckId];
    if (fxBus) {
      fxBus.output.disconnect();
    }

    // Clean up the SoundTouch key-lock engine if active.
    this.cleanupKeyLockEngine(deckId);
    this.clocks[deckId] = createStoppedSegment();
  }

  public getRecordingStream(): MediaStream | null {
    return this.recordingDestination ? this.recordingDestination.stream : null;
  }

  public getRemixBus(): GainNode {
    return this.remixBus;
  }

  public getRecordingProfile() {
    return {
      sampleRate: this.context.sampleRate,
      bitDepth: AudioEngine.TARGET_RECORDING_BIT_DEPTH,
      signalPath: 'post-limiter-master' as const,
    };
  }

  private getPitchLockSupport() {
    if (this.nativeKeyLockSupported !== null) return this.nativeKeyLockSupported;
    const probe = this.context.createBufferSource() as AudioBufferSourceNode & {
      preservesPitch?: boolean;
      mozPreservesPitch?: boolean;
      webkitPreservesPitch?: boolean;
    };
    this.nativeKeyLockSupported = (
      'preservesPitch' in probe ||
      'mozPreservesPitch' in probe ||
      'webkitPreservesPitch' in probe
    );
    return this.nativeKeyLockSupported;
  }

  /** Returns true when the browser natively supports pitch-invariant playback rate changes. */
  public hasNativeKeyLock(): boolean {
    return this.getPitchLockSupport();
  }

  /**
   * Creates a SoundTouch-powered ScriptProcessorNode that plays `buffer` with pitch-invariant
   * time-stretching at the given `tempo` ratio, starting at `startPositionSec`.
   *
   * Call `cleanupKeyLockEngine(deckId)` before invoking again or when stopping.
   * Returns null if soundtouchjs fails to load (fallback to native playback).
   */
  public async initKeyLockEngine(
    deckId: 'A' | 'B',
    buffer: AudioBuffer,
    startPositionSec: number,
    tempo: number,
  ): Promise<ScriptProcessorNode | null> {
    this.cleanupKeyLockEngine(deckId);

    let stMod: typeof import('soundtouchjs');
    try {
      // Dynamic import keeps soundtouchjs out of the SSR bundle.
      stMod = await import('soundtouchjs');
    } catch {
      console.warn('[AudioEngine] soundtouchjs unavailable; Key Lock falling back to native preservesPitch.');
      return null;
    }

    const { SoundTouch, SimpleFilter, WebAudioBufferSource } = stMod;

    const soundTouch = new SoundTouch();
    soundTouch.tempo = Math.max(0.5, Math.min(2.0, tempo));

    const bufferSource = new WebAudioBufferSource(buffer);
    const filter = new SimpleFilter(bufferSource, soundTouch);
    filter.sourcePosition = Math.round(startPositionSec * buffer.sampleRate);

    const BLOCK = 4096;
    // Use (BLOCK, 2, 2) so onaudioprocess fires reliably in all browsers (mirrors soundtouchjs default).
    const node = this.context.createScriptProcessor(BLOCK, 2, 2);
    const samples = new Float32Array(BLOCK * 2);
    const deck = this.decks[deckId];

    node.onaudioprocess = (e: AudioProcessingEvent) => {
      const left = e.outputBuffer.getChannelData(0);
      const right = e.outputBuffer.getChannelData(1);
      const framesExtracted = filter.extract(samples, BLOCK);

      for (let i = 0; i < framesExtracted; i++) {
        left[i] = samples[i * 2];
        right[i] = samples[i * 2 + 1];
      }
      // Zero-fill any remaining frames (end-of-buffer).
      for (let i = framesExtracted; i < BLOCK; i++) {
        left[i] = 0;
        right[i] = 0;
      }

      if (framesExtracted === 0) {
        // Buffer exhausted — signal end of track.
        deck.isPlaying = false;
        deck.onPauseTime?.(0);
      }
    };

    this.deckKeyLockEngines[deckId] = { node, filter, soundTouch, buffer };
    return node;
  }

  /**
   * Returns the current playback position (in seconds) of the SoundTouch key-lock engine.
   * Falls back to 0 if no engine is active.
   */
  public getKeyLockPosition(deckId: 'A' | 'B'): number {
    const kle = this.deckKeyLockEngines[deckId];
    if (!kle) return 0;
    return kle.filter.sourcePosition / kle.buffer.sampleRate;
  }

  /** Disconnects and destroys the SoundTouch engine for the given deck. */
  public cleanupKeyLockEngine(deckId: 'A' | 'B') {
    const kle = this.deckKeyLockEngines[deckId];
    if (!kle) return;
    try {
      // Setting onaudioprocess to null stops the processing callback before disconnect.
      (kle.node as ScriptProcessorNode & { onaudioprocess: null }).onaudioprocess = null;
      kle.node.disconnect();
    } catch {
      // Already disconnected — ignore.
    }
    delete this.deckKeyLockEngines[deckId];
  }

  private applyPitchLock(source: AudioBufferSourceNode, deckId: 'A' | 'B') {
    const pitchLockSource = source as AudioBufferSourceNode & {
      preservesPitch?: boolean;
      mozPreservesPitch?: boolean;
      webkitPreservesPitch?: boolean;
    };
    const enabled = this.decks[deckId].keyLockEnabled;
    if ('preservesPitch' in pitchLockSource) {
      pitchLockSource.preservesPitch = enabled;
    }
    if ('mozPreservesPitch' in pitchLockSource) {
      pitchLockSource.mozPreservesPitch = enabled;
    }
    if ('webkitPreservesPitch' in pitchLockSource) {
      pitchLockSource.webkitPreservesPitch = enabled;
    }
  }

  public getCrossfaderGains(
    crossfaderValue: number,
    curve: 'blend' | 'cut' | 'neural' = 'blend'
  ): { gainA: number; gainB: number } {
    // crossfaderValue ranges from -1 (Deck A) to 1 (Deck B)
    const x = Math.max(0, Math.min(1, (crossfaderValue + 1) / 2)); // 0 -> 1

    if (curve === 'cut') {
      if (x <= 0.05) {
        return { gainA: 1, gainB: 0 };
      }
      if (x >= 0.95) {
        return { gainA: 0, gainB: 1 };
      }
      return { gainA: 1, gainB: 1 };
    }

    if (curve === 'neural') {
      const gainA = Math.sqrt(1 - x);
      const gainB = Math.sqrt(x);
      return { gainA, gainB };
    }

    // Equal power blend curve
    const gainA = Math.cos(x * 0.5 * Math.PI);
    const gainB = Math.cos((1 - x) * 0.5 * Math.PI);
    return { gainA, gainB };
  }

  private startPerformanceLoop(
    deckId: 'A' | 'B',
    loopStart: number,
    originTime: number,
    loopDuration: number,
    mode: 'slip-roll' | 'beat-break',
    playbackRateMultiplier = 1
  ) {
    const deck = this.decks[deckId];
    if (!deck?.buffer || !deck.stemInput || !deck.deckGain) return null;

    const now = this.context.currentTime;
    const safeLoopStart = Math.max(0, Math.min(loopStart, deck.buffer.duration));
    const safeLoopDuration = Math.max(
      AudioEngine.MIN_PERFORMANCE_LOOP_DURATION,
      Math.min(
        loopDuration,
        Math.max(AudioEngine.MIN_PERFORMANCE_LOOP_DURATION, deck.buffer.duration - safeLoopStart)
      )
    );
    const freshSource = this.createPitchLockedSource(deckId, deck.buffer);

    this.performanceLoops[deckId] = {
      mode,
      originTime: Math.max(0, Math.min(originTime, deck.buffer.duration)),
      loopStart: safeLoopStart,
      loopDuration: safeLoopDuration,
      startedAtContextTime: now + 0.002,
      wasPlaying: deck.isPlaying,
    };

    deck.deckGain.gain.cancelScheduledValues(now);
    deck.deckGain.gain.setValueAtTime(deck.deckGain.gain.value, now);
    deck.deckGain.gain.linearRampToValueAtTime(0, now + 0.002);

    if (deck.source) {
      try {
        deck.source.stop(now + 0.002);
      } catch {
        // Source might already be stopped
      }
      deck.source.disconnect();
    }

    freshSource.loop = true;
    freshSource.loopStart = safeLoopStart;
    freshSource.loopEnd = Math.min(deck.buffer.duration, safeLoopStart + safeLoopDuration);
    freshSource.playbackRate.value = deck.playbackRate * playbackRateMultiplier;
    freshSource.connect(deck.stemInput);
    freshSource.start(now + 0.002, safeLoopStart);
    this.clocks[deckId] = startSegment(
      this.clockFor(deckId),
      safeLoopStart,
      freshSource.playbackRate.value,
      now + 0.002,
      { start: freshSource.loopStart, end: freshSource.loopEnd },
    );

    deck.deckGain.gain.setValueAtTime(0, now + 0.002);
    deck.deckGain.gain.linearRampToValueAtTime(1, now + 0.004);

    deck.source = freshSource;
    deck.isPlaying = true;
    deck.pauseTime = safeLoopStart;
    deck.currentTime = safeLoopStart;
    deck.onSourceSwap?.(freshSource);
    deck.onPauseTime?.(safeLoopStart);

    return freshSource;
  }

  public startSlipRoll(deckId: 'A' | 'B', loopStart: number, originTime: number, bpm: number, beatFraction = 0.25) {
    const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
    const safeBeatFraction = Math.max(0.125, Math.min(1, beatFraction));
    return this.startPerformanceLoop(deckId, loopStart, originTime, (60 / safeBpm) * safeBeatFraction, 'slip-roll');
  }

  public stopSlipRoll(deckId: 'A' | 'B') {
    this.stopPerformanceLoop(deckId);
  }

  public startBeatBreak(deckId: 'A' | 'B', loopStart: number, originTime: number, bpm: number) {
    const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
    // Slow the loop slightly for a classic beat-break tug before slipping back to the live timeline.
    return this.startPerformanceLoop(deckId, loopStart, originTime, (60 / safeBpm) * 0.5, 'beat-break', 0.92);
  }

  public stopBeatBreak(deckId: 'A' | 'B') {
    this.stopPerformanceLoop(deckId);
  }

  private stopPerformanceLoop(deckId: 'A' | 'B') {
    const deck = this.decks[deckId];
    const loop = this.performanceLoops[deckId];
    if (!deck?.deckGain) return;

    const now = this.context.currentTime;
    const elapsed = Math.max(0, now - loop.startedAtContextTime);
    const resumeTime = deck.buffer
      ? Math.max(0, Math.min(loop.originTime + elapsed * deck.playbackRate, deck.buffer.duration))
      : loop.originTime;

    deck.deckGain.gain.cancelScheduledValues(now);
    deck.deckGain.gain.setValueAtTime(deck.deckGain.gain.value, now);
    deck.deckGain.gain.linearRampToValueAtTime(0, now + 0.002);

    if (deck.source) {
      try {
        deck.source.stop(now + 0.002);
      } catch {
        // ignore
      }
      deck.source.disconnect();
      deck.source = null;
      deck.onSourceSwap?.(null);
    }

    if (loop.wasPlaying && deck.buffer && deck.stemInput) {
      const resumeSource = this.createPitchLockedSource(deckId, deck.buffer);
      resumeSource.playbackRate.value = deck.playbackRate;
      resumeSource.connect(deck.stemInput);
      resumeSource.start(now + 0.002, resumeTime);
      this.clocks[deckId] = startSegment(this.clockFor(deckId), resumeTime, deck.playbackRate, now + 0.002);

      deck.deckGain.gain.setValueAtTime(0, now + 0.002);
      deck.deckGain.gain.linearRampToValueAtTime(1, now + 0.004);
      deck.source = resumeSource;
      deck.isPlaying = true;
      deck.pauseTime = resumeTime;
      deck.currentTime = resumeTime;
      deck.onSourceSwap?.(resumeSource);
      deck.onPauseTime?.(resumeTime);
    } else {
      this.clocks[deckId] = stopSegment(this.clockFor(deckId), now, resumeTime);
      deck.isPlaying = false;
      deck.pauseTime = resumeTime;
      deck.currentTime = resumeTime;
      deck.onPauseTime?.(resumeTime);
    }

    this.performanceLoops[deckId] = {
      mode: null,
      originTime: 0,
      loopStart: 0,
      loopDuration: 0,
      startedAtContextTime: 0,
      wasPlaying: false,
    };
  }
}
