# DJ Pro Mixer: Improvement Roadmap

Built from `docs/research/FEATURE_COMPARISON.md`. Each item lists purpose (A), user experience (B), technical design (C), reference findings (D), implementation (E), risks (F) and testing (G). Status lives in `docs/IMPLEMENTATION_LOG.md`.

## Phase overview

| Phase | Theme | Items | Gate |
|---|---|---|---|
| **1. Quick wins + foundation** | Make rhythm data true | R1 beat grid analysis · R2 grid helpers in UI · R3 sync tempo correctness · R4 effective BPM readout | None: no engine edits, no new dependencies |
| **2. Engine correctness** | Make the audio path true | R0 pitch reaches the audio · R5 main routing fix · R6 transport clock · R7 native loops | **Your approval**: edits `lib/audioEngine.ts` / `hooks/useDeckAudio.ts` |
| **3. Core DJ features** | Pro deck behaviour | R8 phase sync + quantized play · R9 headphone cue output · R10 CDJ main cue · R11 slip mode | Phase 2 done; R9 needs approval (Chromium-only API) |
| **4. Advanced** | Depth | R12 key detection · R13 3-band waveform data · R14 MIDI mapping layer | Optional |

---

## Phase 1 (approved scope: low risk, implemented in this session)

### R1. Beat grid analysis (BPM + first-beat phase)
- **A. Purpose.** Accurate BPM to 0.01 plus the *time of the first beat*. Loops, sync, phrase counting and grid lines all depend on these.
- **B. UX.** Nothing new to learn. Imported tracks get accurate BPMs. Tracks already in the library get a grid the first time they're loaded onto a deck, then keep it.
- **C. Design.** `lib/beatGrid.ts` (pure, no imports) runs in three stages:
  1. **Onset envelope.** Log-energy rise of a low band (one-pole low-pass at 150 Hz) and of the full band, at a hop of about 2.7 ms.
  2. **Coarse tempo.** Autocorrelation over 70–180 BPM, weighted by a log-normal tempo prior centred at 120 BPM.
  3. **Refinement + phase.** For candidate BPMs within ±1 of the coarse value (0.01 steps), fold the envelope modulo the beat period into a phase histogram. The sharpest histogram gives the BPM; its peak gives the phase. Snap to an integer BPM when that scores within 2 % of the best.
- **D. Reference.** Mixxx assumes a constant tempo by default and stores one first-beat marker plus the BPM (`track/beats.h`, `analyzerbeats.cpp:37`). Its constant-region fitting tolerates about 25 ms of phase error per beat (`beatutils.cpp:12`). Mixxx uses QM-DSP (GPL); this is an independent design.
- **E. Implementation.**
  - `lib/beatGrid.ts` (new)
  - `lib/analysisWorker.ts` (use it, return `firstBeatSec`, `confidence`)
  - `lib/db.ts` (optional `beatGrid` field; not indexed, so no Dexie version bump)
  - `store/libraryStore.ts` (store the grid; bump the localStorage analysis-cache prefix to v2 so stale results are ignored; export `analyzeBeatGridForTrack`)
  - `store/deckStore.ts` (lazily analyse a loaded track that has no grid)
- **F. Risks.**
  - Wrong half/double tempo on ambiguous tracks. Mitigated by the tempo prior and range; users will want a ×2 / ÷2 control later.
  - Copying the deck buffer for analysis costs about 50 MB transiently for a 5-minute track. A copy is needed so the playing buffer isn't detached by the transfer.
- **G. Testing.** `tests/beatGrid.test.ts` uses synthetic click and kick tracks with known BPM and offset (integer, fractional, 174 BPM, kick + off-beat hats + noise, silence). Asserts BPM within ±0.05 and phase within 10 ms.

### R2. Grid-aware UI
- **A.** Grid lines, phrase counter, phase indicator and quantized loops line up with the music.
- **B.** Gold bar lines sit on the kicks; the "bars to drop" counter starts at the first beat; quantized loops start on a beat.
- **C.** Pure helpers: `beatPhase`, `nearestBeatTime`, `quantizedLoopStart` (Mixxx semantics: ≥1 beat → closest beat; <1 beat → nearest sub-division).
- **D.** `findQuantizedBeatloopStart` (`loopingcontrol.cpp:1451`).
- **E.** `components/ParallelWaveforms.tsx`, `components/PhraseDisplay.tsx`, `components/Deck.tsx`, `app/page.tsx`.
- **F.** Tracks without a grid fall back to offset 0, which is the old behaviour.
- **G.** Unit tests for the helpers, plus a manual visual check (see the learning guide).

### R3. Sync tempo correctness
- **A.** SYNC matches the tempo you actually *hear* from the other deck, handles half/double tempo, and keeps following the leader.
- **B.** Press SYNC on the deck you want to follow. Moving the leader's pitch drags the follower along. Moving the follower's own pitch fader releases SYNC (as on CDJs).
- **C.** `computeSyncPitchPercent(followerBpm, leaderBpm, leaderPitch)`: leader effective BPM = file BPM × (1 + pitch/100). Fold the ratio into [1/√2, √2] by ×2 or ÷2.
- **D.** `SyncControl::determineBpmMultiplier` (`synccontrol.cpp:287`), `calcSyncedRate` (`bpmcontrol.cpp:466`).
- **E.** `store/deckStore.ts` (`toggleSync`, `setPitch`), `lib/beatGrid.ts`.
- **F.** Sync can push pitch past the ±8 % fader range. The engine allows 0.5–2.0×; the fader UI shows the clamped value.
- **G.** Unit tests for the pitch maths; manual check with two tracks.

### R4. Effective BPM readout
- **A–C.** The deck shows `fileBpm × (1 + pitch/100)`. **E.** `components/Deck.tsx`. **G.** Manual check: move the pitch fader and watch the BPM change.

---

## Phase 2 (needs approval before any code change)

### R0. Make pitch reach the audio (P0, found during Phase 1 verification)
- **A. Purpose.** The pitch fader, keyboard nudge and SYNC currently change the numbers on screen but not the sound.
- **B. UX.** Moving pitch changes tempo smoothly while playing, with no restart click. A deck synced while paused plays at the synced tempo when you press Play.
- **C. Design.** In `useDeckAudio.playAudio`, set `source.playbackRate.value = basePlaybackRate` **before** `start()`. Keep the rate in a ref and remove `basePlaybackRate` (and the rate-dependent `syncRuntime`) from the play/stop effect's dependencies, so a rate change no longer tears down the source. The existing rate effect (`useDeckAudio.ts:334-339`) then ramps the live source.
- **D. Reference.** Mixxx never restarts playback for a rate change; the rate is a parameter read every callback (`RateControl::calculateSpeed`).
- **F. Risks.** The SoundTouch key-lock path also derives tempo from `basePlaybackRate`; check that `setDeckPlaybackRate` still drives `soundTouch.tempo`. `syncRuntime` callbacks must keep updating `playbackRate` in the engine registry.
- **G. Testing.** In-browser measurement of track-seconds per wall-second at −18 %, 0 % and +8 % (expect 0.82 / 1.00 / 1.08, ±0.01), both for pitch set before Play and changed during play.

### R5. Main output routing fix (P0)
- **A.** Stop the left channel playing about 6.6 dB louder than the right through an unlimited path.
- **C.** In the `AudioEngine` constructor, do not connect `masterPanner` / `cuePanner` to `destination` until a headphone output exists (R9). Keep `setSplitMonoEnabled` for that future output.
- **D.** Mixxx applies `headSplit` to the headphone bus only (`enginemixer.cpp:867`).
- **F.** If you *rely* on split-mono cueing with a Y-cable today, this removes it until R9. The cue send is never enabled from the UI, so the right channel currently carries no cue signal anyway.
- **G.** An `OfflineAudioContext` replica test: equal L/R RMS. A browser runtime check reading the master analyser's per-channel levels.

### R6. Precise transport clock
- **A.** Know each deck's position to the sample at any moment, without React re-renders.
- **C.** The engine stores `{startContextTime, startPosition, rate}` per deck on every source start, rate change or seek. `getPosition(deck) = startPosition + (ctx.currentTime − startContextTime) × rate`, piecewise across rate changes. `useDeckAudio` reads it instead of accumulating RAF deltas.
- **F.** Touches the core play path. Must stay compatible with `onSourceSwap` / `onPauseTime` callbacks and the SoundTouch path (which has its own position counter).
- **G.** Play, seek, pitch-change and stutter sequences compared against expected positions in a browser test.

### R7. Sample-accurate loops
- **A.** Loops that never overshoot.
- **C.** Reuse the engine's existing `startPerformanceLoop` (native `loop/loopStart/loopEnd`) for normal beat loops; exit resumes at the loop-relative position (or the slip position, R11).
- **D.** Mixxx clamps reads at the loop trigger (`readaheadmanager.cpp:49-75`).
- **G.** Record a 1-beat loop for 30 s; check the period on the waveform matches 60/BPM to the sample.

## Phase 3

- **R8. Phase sync + quantized play.** Needs R6. On SYNC or Play (with QUANT on), seek the follower so its beat phase equals the leader's (shortest way around, like Mixxx `shortestPercentageChange`). Optional drift trim of ±0.05 % per second.
- **R9. Headphone cue output.** `AudioContext.setSinkId()` (Chromium) for a second context, or a `MediaStreamDestination` piped to an `<audio>` element with `setSinkId`. Add a cue-mix knob (Mixxx `headMix`). Needs approval (browser-specific API).
- **R10. CDJ main cue.** State machine from `cueCDJ` (`cuecontrol.cpp:1408`), implemented in the store on top of `seekTo`.
- **R11. Slip mode.** Shadow position advanced by the transport clock during loops, stutters and rolls; on release, seek to the shadow position.

## Phase 4

- **R12. Key detection.** In the worker: an FFT chromagram plus Krumhansl-style major/minor profile correlation, mapped to Camelot.
- **R13. 3-band waveform data.** Precompute low/mid/high peaks (Mixxx: Bessel-4 at 600 Hz / 4 kHz) for coloured waveforms that don't depend on the live analyser.
- **R14. MIDI mapping layer.** A named control registry plus JSON mappings and MIDI learn.

## Approvals requested

| # | Request | Why | Risk |
|---|---|---|---|
| 0 | ~~Edit `hooks/useDeckAudio.ts` for **R0**~~ ✅ approved and done 2026-10-11 | P0: pitch, nudge and SYNC were inaudible | Done; see implementation log |
| 1 | Edit `lib/audioEngine.ts` for **R5** routing fix | P0 audible imbalance and unlimited path | Low; small diff, easy rollback |
| 2 | Edit engine + `useDeckAudio` for **R6/R7/R8** | Phase sync and sample-accurate loops need a precise clock | Medium; core play path |
| 3 | **R9** headphone output via `setSinkId` | Real PFL cueing | Chromium-only; needs a device picker |
| 4 | ~~Install **Ghidra 12.1.x + JDK 21**~~ ✅ approved and done 2026-10-11 (`C:\tools`) | Enable REA function-level tracing of `mixxx.exe` | Done |
