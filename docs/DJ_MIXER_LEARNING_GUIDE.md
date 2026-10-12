# DJ Mixer Learning Guide

A plain-language tour of how DJ software works, using Mixxx (open source) as the reference and DJ Pro Mixer as the hands-on example. Each topic follows the same pattern:

- **What** it is
- **Why** DJs care
- **How** it works
- **Mixxx**: how Mixxx does it (source file and line, tag 2.5.6)
- **Here**: where it lives in DJ Pro Mixer
- **Try it**: an experiment you can run

Updated as features land. Last update: 2026-10-11 (beat grid + sync).

---

## 1. Audio buffers: what the computer is actually playing

**What.** Digital audio is a long list of numbers (samples) between −1 and +1, typically 48,000 per second per channel. A 4-minute stereo track is about 23 million numbers.

**Why.** Every DJ feature (pitch, loops, cues) is ultimately "which samples do we play next, and how loud?"

**How.** The sound card asks for a small chunk of samples (a *buffer*, for example 128–1024 samples, a few milliseconds) over and over. If the software is late delivering a chunk you hear a click or dropout. Real-time audio code therefore never does slow work (file reading, decoding, memory allocation) on the audio thread.

```
file.mp3 ──decode──► [float samples in memory] ──read N at a time──► effects/mix ──► sound card
                     (slow, done ahead of time)   (fast, every few ms)
```

**Mixxx.** Decodes in chunks of 8,192 frames (~170 ms) on a worker thread and keeps up to 80 chunks cached. The audio thread only reads from that cache (`engine/cachingreader/cachingreaderchunk.h:27`, `cachingreader.cpp:36`).

**Here.** The browser decodes the whole file up front (`AudioEngine.loadBuffer`, `lib/audioEngine.ts:259`). The Web Audio API then runs mixing on its own real-time thread, so React work can't cause dropouts.

**Try it.** Open *AUDIO STATS* (bottom left) to see the sample rate and latency reported by the engine.

## 2. Beat grids and BPM detection

**What.** BPM is beats per minute. A **beat grid** is BPM *plus the time of one beat*, so the software knows where every beat falls:

```
beat n is at  firstBeat + n × (60 / BPM)
  firstBeat = 0.37 s, 128 BPM → beats at 0.37, 0.84, 1.31, 1.78 … seconds
```

**Why.** Loops, beat jumps, sync, quantize and the "bars to drop" counter all need to know where beats are. A BPM without the first-beat offset makes every one of them land between beats.

**How the detector works** (`lib/beatGrid.ts`):

1. **Onset envelope.** Every ~2.7 ms, measure how much louder the sound just got, mostly in the bass band where kick drums live. Sudden rises are drum hits.
2. **Tempo guess (autocorrelation).** Slide the envelope against itself. At the beat period the hits line up with each other and the overlap score peaks. A gentle preference for dance tempos around 120 BPM decides between "64 or 128?" style ambiguities.
3. **Fine tempo and phase (folding).** For each candidate BPM near the guess, wrap the whole song's envelope around a circle one beat long, like winding a long tape onto a reel. With the right BPM, every kick lands in the same spot and forms one tall spike. With a slightly wrong BPM they spread out. The tallest spike gives the exact BPM, and its angle gives the first beat.
4. **Confidence.** How much taller that spike is than the average across nearby (wrong) tempos.

```
right BPM:  ▁▁▁▁█▁▁▁▁   ← kicks pile up at one phase → firstBeat
wrong BPM:  ▂▃▄▅▅▄▃▂▂   ← smeared
```

**Mixxx.** Default plugin is Queen Mary DSP (onset detection plus tempo tracking), with "assume constant tempo" on by default (`analyzer/analyzerbeats.cpp:20-37`). The grid is stored as beat markers (`track/beats.h:66`). Beats are fitted to constant-tempo regions with ±25 ms tolerance (`track/beatutils.cpp:12-16`). Our design is independent; Mixxx's code is GPL and was not copied.

**Here.**
- Analysis: `lib/beatGrid.ts` → `lib/analysisWorker.ts` (worker thread, so the UI never freezes).
- Stored as `Track.beatGrid` (`lib/db.ts`).
- Tracks imported before this change get a grid the first time they're loaded on a deck (`analyzeLoadedTrack` in `store/deckStore.ts`).

**Measured accuracy.**
- **Synthetic tracks** (tests): BPM within 0.004, first beat within 0.7–2.1 ms.
- **Real tracks:** steady ones were consistent across both halves of the song (e.g. Bungalow 90, Amor Sincero 110). Several live-feel tracks drift by about 1 BPM through the song, so a single grid can't fit them. Those get confidence below 0.12 and a `~` in front of the BPM.

**Try it.**
1. Load a track and watch the deck BPM.
2. A `~` means "approximate, the tempo moves".
3. Run `npm test` to see the detector checked against synthetic tracks with known answers.

## 3. Tempo, pitch and the effective BPM

**What.** The pitch (tempo) fader speeds the track up or down: +4 % means 4 % faster.

**Why.** To mix two tracks they must play at the same speed.

**How.** Playing samples faster raises both tempo and musical pitch, like a record at the wrong speed. The tempo you *hear* is:

```
effective BPM = file BPM × (1 + pitch% / 100)      125 BPM at +4 % → 130 BPM
```

**Mixxx.** Rate = 1 + direction × range × slider (`ratecontrol.cpp:287`); the range is adjustable from 1 % to 400 % (`:46`).

**Here.**
- The deck readout shows the effective BPM (`components/Deck.tsx`, `effectiveBpm` in `lib/beatGrid.ts`).
- `hooks/useDeckAudio.ts` applies the rate. Before fix R0, a pitch move secretly restarted the sound source, from 0:00 and at normal speed. The lesson: in React audio code, *parameters* (rate, gain) must update live nodes; they must never be dependencies of the code that *creates* nodes.

**Try it.** Play a track and move the pitch fader: the tempo changes smoothly and the track keeps its place.

## 4. Sync

**What.** One button that matches a deck's tempo to the other deck.

**Why.** Saves manual beatmatching, so you can focus on track choice and EQ.

**How.** The follower needs `pitch = leaderEffectiveBPM / followerBPM − 1`. Two refinements:

- **Half/double tempo.** An 87 BPM hip-hop track and a 174 BPM drum & bass track share a pulse. Ratios beyond √2 (~1.41) are halved or doubled, so the follower changes by 0 % instead of +100 %.
- **Phase.** Same tempo isn't enough; the kicks must also land together. That needs a precise clock (not built yet).

```
tempo sync:  A |  |  |  |       B |  |  |  |     same spacing ✓
phase sync:  A |  |  |  |       B  |  |  |  |    kicks offset ✗ → nudge B
```

**Mixxx.**
- `determineBpmMultiplier` handles half/double with the same √2 idea (`engine/sync/synccontrol.cpp:287`).
- Phase is a feedback loop: measure where each deck sits between beats ("beat distance"), then speed the follower up or down by at most ±5 %, in steps of at most 2 %, with a 1 % dead-band (`engine/controls/bpmcontrol.cpp:524-588`).
- Pressing Play with quantize on snaps the phase immediately (`enginebuffer.cpp:782-788`).

**Here.** `toggleSync` / `setPitch` in `store/deckStore.ts`.
- SYNC follows the other deck's *effective* BPM (the old code ignored the leader's pitch fader).
- The follower keeps following when the leader's pitch moves.
- Moving the follower's own pitch releases SYNC, as on CDJs.

**Try it.**
1. Play deck A, load a different-tempo track on B and press **SYNC** on B. B's readout now matches A's, with ⟳.
2. Move A's pitch: B's readout follows.
3. Move B's pitch: ⟳ disappears.

## 5. Crossfader curves

**What.** The crossfader blends deck A into deck B.

**Why.** Different styles need different curves. Long blends want smooth "constant power"; scratch DJs want an instant cut.

**How.** Two equally loud, unrelated songs played together sound about 3 dB louder than one, because their powers add. A constant-power curve keeps `gainA² + gainB² = 1`, so the sum stays level. At the centre each deck gets 0.707 (−3 dB).

```
gain                     gain
1 ┤A‾‾‾‾╲    ╱‾‾‾‾B     1 ┤A‾‾‾‾‾‾‾‾‾‾‾‾‾B    "cut": both full except
  │      ╲  ╱             │                  the last few % of travel
  │   constant power      │
0 ┼──────────────────   0 ┼A_________________B
```

**Mixxx.** A shape exponent ("transform"), then renormalisation so `gain1² + gain2² = 1`. The comment cites a ReplayGain listening test (`engine/enginexfader.cpp:16-84`).

**Here.** `getCrossfaderGains` (`lib/audioEngine.ts:1171`): *blend* = cosine (constant power), *cut* = hard cut with a 5 % edge, *neural* = square-root power plus stem swapping.

**Try it.** Use the **BLEND / CUT / AI** buttons under the mixer's crossfader and sweep the fader slowly. Notice the dip, or lack of one, in the middle.

## 6. Loops, quantize and beat jumps

**What.** A loop repeats a section. *Quantize* snaps actions to the nearest beat. *Beat jump* skips N beats.

**Why.** Extend an intro, build tension, or fix a mix without missing the beat.

**How.** With a grid, "nearest beat" is `round((t − firstBeat) / period)`. For loops shorter than a beat (½, ¼) Mixxx snaps to the nearest *fraction* of the beat instead, so a ½-beat loop pressed late in a beat repeats the second half.

**Mixxx.**
- `findQuantizedBeatloopStart` (`engine/controls/loopingcontrol.cpp:1451`).
- Loops wrap *inside the audio thread* at the exact sample (`readaheadmanager.cpp:49-75`).
- Beat jump inside a loop moves the loop (`:1738`).

**Here.**
- Loop start: `quantizedLoopStart` (`lib/beatGrid.ts`) used by `Deck.tsx` `handleLoopSize`. It now snaps to real beats instead of multiples of the bar length counted from 0:00.
- ⚠ The loop end is still enforced by a React effect that runs about 45 times a second, so loops can overshoot by up to ~22 ms. The fix (roadmap R7) uses the browser's built-in sample-accurate looping.

**Try it.** With **QUANT ON**, press a loop size mid-beat. The loop starts on the beat; compare against the gold grid lines in the waveform.

## 6b. The transport clock: knowing exactly where the playhead is

**What.** A clock that answers "which second of the track is playing *right now*", or at any moment in the near future.

**Why.** Beat jumps, loop points, cue points and phase sync all happen *on the beat*. If the software's idea of "now" is 30 ms late, every one of those lands 30 ms off, which is audible as a flam.

**How.** Don't keep asking the audio where it is; *compute* it. Every time playback changes (play, pause, seek, new speed), write down an anchor:

```
"at context time 12.000 s the playhead was at 64.250 s, moving at rate 0.92"
position(t) = 64.250 + 0.92 × (t − 12.000)
```

Speed changes in Web Audio don't jump: `setTargetAtTime` glides exponentially toward the new rate. The clock includes that glide exactly, using the integral of the curve. Tested against real rendered audio, the clock was within **0.24 ms**; ignoring the glide would be off by up to 2.5 ms.

**Mixxx.** The engine *owns* the play position and advances it every audio callback. `RateControl::calculateSpeed` feeds the sync controller inside the same callback, as REA traced in the binary.

**Here.**
- The model: `lib/transportClock.ts`.
- The engine API: `AudioEngine.getDeckPosition()`, `lib/audioEngine.ts`.
- Readers: the deck display (`useDeckAudio`), beat jump, loops and cues (`Deck.tsx`, `usePerformanceFX.ts`).

Building it surfaced a hidden bug: every **pause** reset the track to 0:00.

**Try it.** Play a track, press **+4** beat jump a few times, and watch the gold grid lines: the music stays locked to the grid after every jump.

## 7. Key lock (time-stretching)

**What.** Change tempo without changing musical pitch.

**Why.** A +6 % tempo change otherwise raises the key by about a semitone, which clashes harmonically.

**How.** Chop the audio into tiny overlapping grains and repeat or skip grains to change the length without resampling. Good stretchers (SoundTouch, Rubber Band) choose the splice points carefully to avoid warbling.

**Mixxx.** Offers SoundTouch or Rubber Band, and turns key lock **off** while scratching or outside 0.1–1.9× speed, where stretchers sound bad or reallocate memory (`enginebuffer.cpp:906-932`).

**Here.** Native `preservesPitch` when the browser supports it, otherwise a SoundTouch fallback (`initKeyLockEngine`, `lib/audioEngine.ts:1071`).

**Try it.** Toggle **KEY**, then move the pitch fader and listen: the vocal pitch stays put. In Chrome this uses the SoundTouch fallback, because Chrome has no `preservesPitch` on buffer sources. Measured tempo: 0.997 / 1.058 / 0.920 at 0 / +6 / −8 %.

## 8. Gain staging and the limiter

**What.** Keeping levels below the digital ceiling (1.0) at every stage.

**Why.** Above 1.0 the signal is chopped off (clipping): harsh distortion.

**How.** Leave headroom before the master (−3 to −6 dB). A *limiter* at the end catches peaks.

**Mixxx.** Per-channel gain is ramped from the previous value to the new one across each buffer, so faders never click (`engine/channelmixer.cpp:8-50`).

**Here.**
- `masterGain` = 0.5 (−6 dB) → DynamicsCompressor limiter at −1 dB.
- Before fix R5, an extra, unlimited copy of the master went to the left speaker, so the left measured +6.6 dB louder. The lesson: give every signal **exactly one** path to the speakers, and put the limiter last on it.
- *Split-mono cueing* (one headphone cable, main in one ear, cue in the other) is a separate mode that replaces the stereo path; it is never added on top of it.

**Try it.** Play one deck with the crossfader centred, ideally on headphones: left and right sound equally loud.
