# Feature Comparison: Mixxx 2.5.6 vs DJ Pro Mixer

Baseline: DJ Pro Mixer at tag `pre-mixxx-research` (commit `7ae1a23`). Mixxx references point to `docs/research/MIXXX_REVERSE_ENGINEERING.md`.

**How a status was decided.** A control counts as working only if it changes what you actually hear, or the stored data, in the code path traced. A control that looks right but never reaches the audio engine is marked **UI-only**.

**Status legend:**
- ✅ Fully implemented and functional
- 🟡 Partial
- 🎭 UI-only or nonfunctional
- ❌ Missing
- ⚠️ Implemented but architecturally weak or buggy
- 🚫 Not appropriate for this app

**Stack fit:**
- **Web:** doable with the Web Audio API in the current architecture.
- **Worklet:** needs AudioWorklet-level transport.
- **Native:** needs OS or audio-driver access that browsers don't give.

## P0: playback correctness and stability

| Feature | Mixxx approach | My app status | Recommended approach | Priority | Difficulty | Dependencies |
|---|---|---|---|---|---|---|
| Main output routing | Main and headphone are separate outputs; `headSplit` applies only to headphones | ⚠️ **Bug.** `lib/audioEngine.ts:227-240` sends `masterGain` to the speakers twice: through the limiter, and again through an **unlimited** split-mono monitor path panned hard left at ×1.41. Measured on an `OfflineAudioContext` replica of the coded graph with identical L/R input: **L −7.85 dBFS vs R −14.48 dBFS (+6.6 dB left)**. With a full-scale deck the left monitor path reaches about 1.41 → clipping. | Disconnect the monitor buses from `destination` until a dedicated headphone output exists, so the master goes **only** through the limiter. | P0 | Low | ✅ *Fixed (R5, 2026-10-11).* Real engine measured L = R = −14.48 dBFS. Split-mono is now opt-in: main mono left, cue mono right, no doubled path |
| **Pitch / tempo actually reaches the audio** | `RateControl::calculateSpeed` feeds the scaler every callback | ⚠️ **Bug (found during verification).** `hooks/useDeckAudio.ts` lists `basePlaybackRate` in the play/stop effect's dependencies. Every pitch change **stops and restarts the source**, and because the restart is async (`await engine.resume()`) the new source starts at **rate 1.0** and stays there. Measured in the running app: Deck B at −18.18 % advanced **1.003** track-s/s (expected 0.826); Deck A at +1 % advanced 1.003 (expected 1.010). Pitch fader, keyboard nudge and SYNC are therefore inaudible. | Apply the rate to the new source before `start()`, and drop the rate from the play effect (keep it in a ref) so pitch moves don't restart playback | **P0** | Low | ✅ *Fixed (R0, 2026-10-11).* Also fixed: pitch moves restarted the track from 0:00. Verified 0.90/1.05/1.07/0.88 against expected 0.90/1.05/1.08/0.88; key lock 0.997/1.058/0.920 |
| Waveform playhead | Visual play position comes from the engine | ⚠️ `ParallelWaveforms.tsx` advanced the playhead by wall-clock `dt` while playing and never re-synced, so it ignored pitch, seeks, beat jumps and loops | Predict at the playback rate and steer toward the store's 30 Hz position; snap on jumps > 0.25 s | P0 (visual) | Low | ✅ *implemented* |
| BPM detection | QM-DSP onset detection + tempo tracking, constant-region fitting (`beatutils.cpp`) | ⚠️ `lib/analysisWorker.ts`: integer histogram of intervals between consecutive energy peaks at 21 ms hops; no phase. The Library fallback (`public/workers/analyzer.worker.js`) **always returns 120**. | Onset envelope + autocorrelation with a tempo prior + whole-track comb refinement that also gives the **first-beat phase** + a confidence score | P0 | Medium | None (Web Worker). ✅ *implemented.* Synthetic: ±0.004 BPM, ≤2.1 ms phase. Real library: 5 of 11 tracks steady (confidence 0.15–0.29); 6 drift and are flagged low-confidence (`~`) |
| Beat grid (first-beat offset) | `Beats` = first-beat marker + BPM (`track/beats.h`) | ❌ No offset stored. Grid lines, loop quantize, phrase counter and the phase indicator all assume beat 1 is at 0:00. | Store `beatGrid {bpm, firstBeatSec}` on `Track`; pure grid helpers | P0 | Low | Dexie field (no index, so no schema bump) ✅ *implemented* |
| Seek / loop click-free transitions | Crossfade old→new buffer (`enginebuffer.cpp:454, 1107`) | ✅ 2–6 ms gain dip around source swaps (`seekTo`, `startStutter`) | Keep | — | — | — |
| Audio-thread safety | Decoding on worker thread, lock-free FIFOs | ✅ Whole-file decode before play; Web Audio thread isolates rendering | Keep. Watch memory for long tracks (about 110 MB per 10-minute stereo track as float32). | P3 | — | — |

## P1: core DJ mixing and performance

| Feature | Mixxx approach | My app status | Recommended approach | Priority | Difficulty | Dependencies |
|---|---|---|---|---|---|---|
| Sync (tempo) | `rate = leaderBpm / localBpm`, half/double multiplier at a √2 threshold (`synccontrol.cpp:287`), followers track leader changes | ⚠️ `store/deckStore.ts` `toggleSync` uses the **leader's file BPM and ignores its pitch fader**, has no half/double handling, and is one-shot: followers don't track later leader pitch moves | `computeSyncPitchPercent` (effective leader BPM, half/double), follower tracks leader pitch, manual pitch move releases sync | P1 | Low | None. ✅ *Implemented and audible* (since R0): follower measured at 0.823 rate against 0.818 expected; −18.182 % → −14.909 % when the leader moved +4 %. |
| Sync (phase) | Proportional controller on beat distance (`bpmcontrol.cpp:524`); phase seek on Play when quantized | ❌ | Engine-side transport clock (position computed from `context.currentTime`), then a one-shot phase seek on sync/play plus optional drift trim | P1 | Medium | Engine edit, **needs approval** |
| BPM readout | Shows effective BPM (file × rate) | ⚠️ Deck shows file BPM even when pitched (`components/Deck.tsx:648`) | Show `effectiveBpm` | P1 | Trivial | ✅ *implemented* |
| Beat loops | 1/32–512 beats, quantized start, sample-accurate wrap in the read-ahead | ⚠️ `Deck.tsx:523-531` wraps the loop from a **React effect on `currentTime` (~45 Hz)**, so it overshoots by up to about 22 ms plus scheduling jitter. Quantize assumed the grid starts at 0. | Short term: grid-aware quantized start ✅ *implemented*. Proper fix: native `AudioBufferSourceNode.loop/loopStart/loopEnd`; the engine already uses it for slip-roll (`startPerformanceLoop`) | P1 | Medium | Engine edit, **needs approval** |
| Beat jump | Moves the loop when inside one, else seeks N beats keeping phase | 🟡 Seeks N beats keeping phase (`Deck.tsx:592`). Uses React `currentTime`, which can be up to 33 ms stale. | Move to the engine with a precise clock (same approval as phase sync) | P2 | Low | Engine |
| Hot cues | 36 hot cues, quantized set, CDJ preview | ✅ 8 per track, persisted by track hash, cross-tab broadcast, stutter on hold | Quantize hot-cue set to grid (now possible) | P2 | Low | — |
| Main cue (CDJ behaviour) | `cueCDJ` (`cuecontrol.cpp:1408`) | ❌ No main CUE button semantics | Implement the CDJ state machine in the store using `seekTo` | P2 | Medium | — |
| Key lock | SoundTouch / Rubber Band; disabled when scratching, >1.9× or <0.1× | ✅ Native `preservesPitch` with a SoundTouch fallback (`initKeyLockEngine`) | Copy Mixxx's guard: bypass key lock during scratch / extreme rates | P2 | Low | Engine |
| Crossfader curves | Transform exponent + constant-power renormalisation | ✅ Blend = equal-power cosine, Cut = hard cut with 5 % dead zone, Neural = sqrt plus stem swapping | Optional: add a continuous curve-shape knob like Mixxx's transform | P3 | Low | — |
| Channel EQ + kill | Biquad/Bessel EQ, kill at −23 dB | ✅ Shelf/peak/shelf EQ, −24 dB…+6 dB mapping with kill (`useDeckAudio.ts:159`) | Keep | — | — | — |
| Headphone cue (PFL) | Separate headphone device, `headMix`, `headSplit` | 🎭 The engine has per-deck cue sends (`setDeckCueEnabled`) but **nothing in the UI calls it**; the cue bus would currently play through the main speakers | Second output via `AudioContext.setSinkId` / `<audio>.setSinkId` on a `MediaStreamDestination`, plus a cue-mix knob | P1 | Medium | Engine; Chromium-only API; **needs approval** |
| Slip mode | Shadow play position (`processSlip`) | 🎭 `SLIP` toggle (`Deck.tsx:775`) changes local state only | Track a shadow position during loops/stutters and resume there (engine already does this for slip-roll) | P2 | Medium | Engine |
| Vinyl / nudge jog | Scratch controller, `wheel`/`jog` | ✅ Jog scrub (paused) and pitch-bend (playing) via `scrubTrack` | Keep | — | — | — |
| Quantize toggle | Global per-deck `quantize` | 🟡 Local `QUANT` state only affects loop-size buttons | Use for hot-cue set, beat jump, play start once the precise clock exists | P2 | Low | — |

## P2: workflow and visualisation

| Feature | Mixxx approach | My app status | Recommended approach | Priority | Difficulty | Dependencies |
|---|---|---|---|---|---|---|
| Waveform beat grid | Beat markers from `Beats` | ⚠️ Drawn from t=0 (`ParallelWaveforms.tsx:270`) | Offset by `firstBeatSec` | P2 | Trivial | ✅ *implemented* |
| Phase-alignment indicator | n/a (Mixxx shows beat distance) | ⚠️ Assumes both grids start at 0 (`ParallelWaveforms.tsx:343`) | Use grid-relative beat phase | P2 | Trivial | ✅ *implemented* |
| Phrase counter | n/a | ⚠️ Counts from 0:00 (`PhraseDisplay.tsx`) | Count from the first beat | P2 | Trivial | ✅ *implemented* |
| Key detection | QM key / KeyFinder | 🎭 All imported tracks show `--`; the fallback worker's key result is discarded and its algorithm is unreliable (12 autocorrelation probes) | Chroma (FFT) + key-profile correlation in the worker | P2 | Medium | None |
| Waveform analysis cache | Stored in the DB once | ✅ Overview peaks in IndexedDB + localStorage cache | Keep | — | — | — |
| Waveform visible while paused | Always drawn from cached band data | ⚠️ The live `multiply` tint uses analyser energy, which is 0 when paused, so the paused waveform renders **black** (`ParallelWaveforms.tsx` step 3) | Floor the tint at a visible grey, or use precomputed band colours (R13) | P2 | Trivial | — |
| Deck track picker | n/a | ⚠️ Shows "No tracks found" until the Library view has been opened once (library store only loads when `Library` mounts) | Call `loadTracks()` on app start | P2 | Trivial | — |
| 3-band coloured waveform | Bessel-4 bands at 600 Hz / 4 kHz | 🟡 Colours come from the live analyser (real-time RGB), not per-sample band data | Precompute 3-band peaks in the worker | P3 | Medium | — |
| Library search / crates / history | SQLite DAOs | ✅ Dexie: crates, crate tracks, history | Keep | — | — | — |
| Recording | Recording + broadcasting | ✅ 24-bit WAV of the post-limiter master (`useMediaRecorder.ts`) | Keep | — | — | — |

## P3: advanced / optional

| Feature | Mixxx approach | My app status | Recommended approach | Priority | Difficulty | Dependencies |
|---|---|---|---|---|---|---|
| MIDI controllers | XML/JS mappings onto ControlObjects | 🟡 CC-only: crossfader + volumes (`useMIDIManager.ts`) | Control-key registry (`[DeckA].play`-style) + JSON mappings + MIDI learn | P3 | Medium | — |
| Variable-tempo grids | Multiple `BeatMarker`s | ❌ | Not worth it until the constant grid is proven | P3 | High | — |
| Stem separation | Mixxx 2.6+ STEM files | 🟡 "Stems" are LR4 frequency bands, not real separation | Real separation needs a model (Demucs/ONNX) | P3 | High | Large deps, **approval** |
| Broadcasting (Icecast) | Built in | ❌ | 🚫 Needs a server-side relay | — | — | — |
| Vinyl control (timecode) | Built in | ❌ | 🚫 Not practical in a browser | — | — | — |
| HID controllers / ASIO | Native | ❌ | 🚫 Native only | — | — | — |

## Scoring summary (what to build first)

The first batch was chosen for: high user value, low or medium effort, no engine edits, no new dependencies, and testable with pure functions.

1. **Beat grid analysis + offset** (P0). Everything rhythmic depends on it. No dependencies, runs in a worker, fully unit-testable.
2. **Sync tempo correctness** (P1). One-line-class bug with large audible impact; pure function.
3. **Grid-aware waveform / phrase / phase / loop quantize** (P1/P2). Trivial once the grid exists.
4. **Effective BPM readout** (P1). Trivial.

The second batch needs your approval because it edits the core audio path (`hooks/useDeckAudio.ts`, `lib/audioEngine.ts`). In priority order:

1. **Pitch reaches the audio.** Without it, pitch, nudge and SYNC are all inaudible.
2. Main output routing fix.
3. Precise transport clock → phase sync and native loops.
4. Headphone output.
