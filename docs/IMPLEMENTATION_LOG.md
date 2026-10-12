# Implementation Log

Newest first. Each entry records what changed, why, how it was verified, and anything left open. Research context: `docs/research/`. Plan: `docs/roadmap/DJ_MIXER_ROADMAP.md`.

---

## 2026-10-11: Tablet and phone layouts

**Branch:** `feat/transport-clock` working tree, on top of the uncommitted R6 changes. **Status:** implemented and verified. **Not committed.** You asked for tablet and mobile versions and gave the go-ahead to keep using REA.

### Research

Mixxx has no phone or tablet interface; see `research/MIXXX_REVERSE_ENGINEERING.md` §8. The useful idea is `WSizeAwareStack`: hold layout variants smallest first, and show the largest one that fits.

### Measured before the change

| Viewport | Problem |
| --- | --- |
| 1024×768 (iPad landscape) | Decks stacked in one column. Page **2,266 px** tall; the mixer header started at **1,758 px**, so the crossfader was off-screen |
| 768×1024 (iPad portrait) | Same: page 2,257 px tall |
| 812×375 (phone landscape) | Tab bar hidden by `md:hidden`, panel not scrollable: **Deck B and the mixer unreachable** |
| 375×812 (phone portrait) | Top bar's fullscreen button 36 px past the right edge; Audio Stats badge over the Deck A tab |
| 1366×1024 (iPad Pro landscape) | Fine: already the three-column desktop grid |

### Changes

- **`lib/layoutTier.ts`** (new, pure). `layoutFitFor(width, height)` returns `{ tier, mixerPlacement }`.
  - phone: width < 768, or landscape with height ≤ 540.
  - tablet: width < 1280. desktop: everything wider.
  - mixerPlacement `between` when width ≥ 960, otherwise `below`.
- **`hooks/useLayoutFit.ts`** (new). Recomputes on resize. The first render is desktop, so server and client markup match.
- **`app/page.tsx`**
  - Uses the tier instead of the old media query.
  - New `TabletLayout`: compact waveforms, then panels with their own scroll and no page scroll. Hidden panels (A / MX / B) give up their space.
  - Phone panels scroll (`overflow-y-auto`).
  - The Audio Stats badge shows on desktop only, since it's fixed bottom-left.
- **`components/Mixer.tsx`**
  - `layout="strip"`: channel A | crossfader | channel B in one row, for portrait tablets.
  - `ChannelStrip` has a `row` layout. The column layout is unchanged.
- **`components/ViewControls.tsx`** takes a `variant` prop:
  - phone: bar without the panel toggles or workspace switcher (the tabs replace them).
  - tablet: bar with the A / MX / B toggles.
  - desktop: unchanged.
- **`components/MobileNav.tsx`**: removed `md:hidden`; the page renders it only for the phone tier.
- **`tests/layoutTier.test.ts`**: 5 tests, covering devices and the exact breakpoints.

### Verification (dev server, built-in browser)

| Viewport | Layout | Result |
| --- | --- | --- |
| 1024×768 | tablet, between | Panels 336 / 298 / 336 px wide, scrollWidth = clientWidth (no sideways scroll), all 638 px tall with no inner scroll |
| 1180×820 | tablet, between | Screenshot: three columns, crossfader and both Play buttons visible |
| 768×1024 | tablet, below | Decks 364 px wide, 647 px tall with no inner scroll; mixer strip 742×233 with no scroll |
| 820×1180 | tablet, below | Decks 390×803, strip 794×233; page scroll 0 |
| 812×375 | phone | Tab bar visible; the active panel scrolls |
| 375×812 | phone | 0 elements past the right edge; tab bar visible |
| 1440×900 | desktop | Unchanged |

- No console errors.
- `npm test` 23/23, `tsc` clean.
- Lint at the 4-error / 2-warning baseline.
- `npm run build` passes.

**Not verified:** a real touch device. All of this is viewport emulation in Chromium; Safari on iPad was not tested.

### Left open

- **Touch targets:** 33 of 83 phone buttons were under 32 px when measured before this change.
- **Phone landscape:** only about 140 px of the deck is visible at once.
- **Tablet portrait:** the Mixer's AI crate and MIDI controls live in the tab row above the strip. They are reachable, but the strip leaves no room for the crate list.

---

## 2026-10-11: R6, transport clock (approved), plus pause-reset and stale-bundle fixes

**Branch:** `feat/transport-clock` (from `main` @ `ce77124`, after PR #26 merged). **Status:** implemented and verified. **Not committed** at time of writing.

### Changes

| Item | Files | What |
|---|---|---|
| Transport clock | `lib/transportClock.ts` (new), `lib/audioEngine.ts` | Per-deck segments: anchor (context time, position, rate) + exact integral of `setTargetAtTime` glides + native loop wrap + clamping. Updated wherever audio is scheduled: `startStutter`, `seekTo`, `stopStutter`, `startPerformanceLoop` / `stopPerformanceLoop`, `setDeckPlaybackRate` (native and SoundTouch), `disconnectDeck`. Public API: `getDeckPosition`, `getDeckRate`, `startDeckClock`, `stopDeckClock`, `setDeckClockPosition`. |
| Hook on the clock | `hooks/useDeckAudio.ts` | One RAF loop for both paths reads `getDeckPosition`, replacing RAF delta integration and the SoundTouch input counter. Play/pause start/stop the clock. Pause publishes the exact stop position to the store. Paused scrub, new track and end-of-track set the clock explicitly. |
| **Pause reset bug** (pre-existing) | `hooks/useDeckAudio.ts` | The "new track → reset to 0" effect depended on `syncRuntime`, which changes on every play/pause, so each pause jumped back to 0:00. That effect now calls `syncRuntime` through a ref. |
| Exact positions for actions | `components/Deck.tsx`, `hooks/usePerformanceFX.ts` | Beat jump, loop in/out, quantized loop start, CUE/hot-cue set and the slip-roll/beat-break origin read the clock instead of React `currentTime`. |
| Phase-true seek | `lib/audioEngine.ts` (`seekTo`) | The new source starts 3 ms ahead (anti-click), so it now starts 3 ms × rate further into the track, which keeps beat jumps in phase. |
| **Stale dev bundles** (root cause) | `app/page.tsx` | The service worker served `/_next/static` cache-first, so every dev page load ran the *previous* build. It is now registered only in production, and dev unregisters any installed worker. |
| Tests | `tests/transportClock.test.ts` | 6 tests: steps, glide vs numerical integration, mid-glide retarget continuity, loop wrap, clamping, stop/seek. |

### Verification

**Unit:** `npm test` 18/18.

**Model vs real Web Audio** (`OfflineAudioContext`, clicks every 0.25 s of track time, engine call pattern, 4 rate changes including one mid-glide):
- glide model: max **0.24 ms**, mean 0.09 ms
- a naive step model would be off by up to 2.54 ms

**Live app (Chrome pane, real track, fresh bundle verified each time):**

| Check | Result |
|---|---|
| Clock linearity over 2 s | 0 ms residual (store value: 539 ms of jumps; the pane delivers only ~5 RAF/s) |
| Pitch −8 % mid-play | 0 ms jump at the change; rate 0.920 (expected 0.92) |
| Seek while playing | Lands at the target |
| Slip roll ¼ beat at 90 BPM | Stays inside its 0.1667 s loop; releases at origin + elapsed |
| Pause → resume ×3 | Store = clock to 1 ms; positions monotonic (before the fix: 2.80 s → 0.00) |
| Key lock +6 % | Clock 1.060; SoundTouch's input counter leads by ~187 ms (its buffer) |
| End of track | Stops and parks at 0 |
| Beat jump +4 at 90 BPM | UI click **2.6667 s** (exact); 10 programmatic jumps **0 ms** phase error (−3 ms before the seek compensation) |

**Static:** `tsc` clean; lint unchanged from baseline (4 errors, 2 warnings, all pre-existing); `npm run build` succeeds.

### Notes for next steps
- R7 (sample-accurate loops) and R8 (phase sync) can now read `getDeckPosition(deck, at)` at any *future* context time, which is what scheduling on the beat needs.
- The embedded browser pane throttles RAF to ~5/s. Measure through the engine clock, never the store.

---

## 2026-10-11: R5, main output routing fix (approved)

**File:** `lib/audioEngine.ts` (34 lines added, 29 removed). **Status:** implemented and verified. **Not committed.**

**Root cause:** the constructor connected `masterGain` to the speakers twice:
- through the limiter (correct), and
- through a "monitor" gain → `StereoPannerNode` path that **bypassed the limiter**.

This happened even with split-mono off. Split-mono was also on by default, panned hard left at ×1.41. A stereo source into a pan = −1 panner sums L+R into the left channel, so left came out +6.6 dB louder and could clip above the limiter.

**Fix:**
- **Normal stereo (now the default):** `limiter → destination` is the only path to the speakers.
- **Split-mono (opt-in):** `setSplitMonoEnabled(true)` disconnects that path and connects a `ChannelMerger`. The limited main mix is downmixed to mono (`channelCount 1`, "speakers" interpretation, 0.5·(L+R)) on input 0, and the cue bus is downmixed to mono on input 1. Toggling swaps which single node feeds `destination`.
- The old panner/monitor nodes are removed.
- No UI calls split-mono yet; R9 adds headphone cueing.

**Verification.** The *real* `AudioEngine` constructor ran inside an `OfflineAudioContext`: `window.AudioContext` swapped in the page, `createMediaStreamDestination` stubbed, reverb wet = 0. Input was a 440 Hz sine at 0.5 on both channels into `masterGain`.

| Configuration | Before | After |
|---|---|---|
| Default | L −7.85 / R −14.48 dBFS (peak 0.573 / 0.267), split-mono on | **L −14.48 / R −14.48** (0.267 / 0.267), split-mono off |
| Default with a 0.25 cue tone | — | Unchanged: the cue doesn't reach the speakers |
| Split-mono with a 0.25 cue tone | — | L = main 0.267, R = cue 0.250 |
| Split-mono → stereo | — | Back to L = R −14.48 |

**Live check:** master RMS 0.351 while playing, context running, recording stream present. `npm test` 12/12, `tsc` clean, lint unchanged from baseline (4 errors, 2 warnings, none in this file).

**Audible effect:** the left speaker is 6.6 dB quieter than before (correct), so overall loudness drops slightly. The limiter now catches every peak that reaches the speakers.

**Test tip:** a page loaded right after an edit can run a stale `next dev` bundle (seen twice). Check the live module, e.g. `String(AudioEngine.prototype.setSplitMonoEnabled).includes('splitMonoMerger')`, before trusting a measurement.

---

## 2026-10-11: REA deep provider (Ghidra + JDK), approved

- **Installed** (per user, no admin): Temurin JDK 21.0.12.1 and Ghidra 12.1.4 under `C:\tools`, both SHA-256 verified. `rea doctor` passes every Ghidra check.
- **Settings:** in the Windows user environment and the `rea` MCP entry (`~/.claude.json`, backup `~/.claude.json.bak-before-rea-env-20261011071635`).
- **Function-level tracing of `mixxx.exe`** works with PDB-derived seeds. 9 functions across the Play, Sync, Crossfader and Loop workflows were decompiled and their callers and callees collected; results are in `docs/research/MIXXX_REVERSE_ENGINEERING.md`. Tools: `docs/research/tools/`.
- **Timing:** each REA session spends ~12 min on Ghidra analysis before answering; the PDB seed dump takes ~18 min.
- **Open:** the session's own REA MCP server must be reconnected (`/mcp`) or the app restarted to pick up the new environment. Until then, tracing runs through the private-session script.

---

## 2026-10-11: R0, make pitch reach the audio (approved)

**File:** `hooks/useDeckAudio.ts` (14 lines added, 6 removed). **Status:** implemented and verified. **Not committed.**

**Root cause (two parts):**

1. `basePlaybackRate` was a dependency of both the play/stop effect and `syncRuntime`. Every pitch change therefore stopped and recreated the source.
2. Because `syncRuntime` changed identity, the "new track loaded" effect also re-ran, setting `pauseTimeRef = 0` while the async `playAudio` was still waiting on `engine.resume()`. The recreated source therefore **started from 0:00**. It also ran at rate 1.0, because `engine.setDeckPlaybackRate` targeted the engine's previously registered, already stopped source.

**Fix:**
- The rate is read through `basePlaybackRateRef` inside `syncRuntime` and the play effect, and removed from their dependencies, so pitch moves never restart or reset playback.
- A new source gets `playbackRate.value` set directly before `start()`.
- The existing rate effect still ramps the live source (or SoundTouch tempo) on pitch moves.

**Verification** (in-browser, real tracks; rate = track-seconds per audio-context second):

| Case | Expected | Before fix | After fix |
|---|---|---|---|
| Pitch −10 % while playing | 0.900, position continues | 0.999; position 3.89 s → **0.09 s** | 0.903; position 3.98 s → 4.13 s |
| Pitch +5 % set while paused, then Play | 1.050 | (ignored) | 1.050 |
| +8 % while playing | 1.080 | — | 1.070 |
| SYNC set while paused (−11.636 %), then Play | 0.884 | (ignored) | 0.877 |
| Follower while the leader moves (−18.182 %) | 0.818 | 1.003 | 0.823 |
| Key lock (SoundTouch path) 0 / +6 / −8 %, 12 s linear fit | 1.000 / 1.060 / 0.920 | — | 0.997 / 1.058 / 0.920 |

Short-window rates carry ±0.01–0.02 of quantization from the 30 Hz position commits. SoundTouch reports position in ~0.34 s blocks, so it needs long windows. `npm test` 12/12, `tsc` clean, `eslint hooks/useDeckAudio.ts` clean.

---

## 2026-10-11: Phase 0–5, first batch (R1–R4 + waveform playhead)

**Branch:** `feat/mixxx-research` (from `docs/add-claude-md` @ `7ae1a23`).
**Rollback point:** tag `pre-mixxx-research` → `git checkout pre-mixxx-research` restores the exact pre-work state.
**Status:** implemented and verified. **Not committed.**

### Changes

| Item | Files | What |
|---|---|---|
| R1 beat grid analysis | `lib/beatGrid.ts` (new), `lib/analysisWorker.ts`, `lib/db.ts`, `store/libraryStore.ts`, `store/deckStore.ts` | New detector returning `{bpm, firstBeatSec, confidence}`. Stored as `Track.beatGrid` (unindexed, no Dexie version bump). Tracks without a current grid are analysed in the worker when loaded on a deck, then persisted. The analysis cache key is versioned (`piko-track-analysis-grid<N>:`). |
| R2 grid-aware UI | `components/ParallelWaveforms.tsx`, `components/PhraseDisplay.tsx`, `components/Deck.tsx`, `app/page.tsx` | Grid lines, bar numbers, phase-lock indicator and phrase counter count from the first beat. Quantized loop start follows Mixxx semantics (`quantizedLoopStart`). |
| R3 sync tempo | `store/deckStore.ts`, `lib/beatGrid.ts` | SYNC matches the leader's *effective* BPM with half/double folding. Follower tracks leader pitch moves; moving the follower's pitch releases sync; only one deck follows at a time; a synced deck re-syncs on track load. |
| R4 effective BPM | `components/Deck.tsx` | Readout = file BPM × pitch, with `~` and a tooltip when the grid is low-confidence. |
| Waveform playhead (found while testing) | `components/ParallelWaveforms.tsx` | Playhead predicted at the playback rate and eased toward the store's 30 Hz position (snaps on jumps > 0.25 s). Previously it ran on wall-clock time and ignored pitch, seeks, beat jumps and loops while playing. |
| Test runner | `package.json` (`npm test`), `tsconfig.json` (`allowImportingTsExtensions`), `tests/beatGrid.test.ts` | Node 22's built-in test runner with native TS type stripping. **No new dependencies.** |

`lib/audioEngine.ts` and `hooks/useDeckAudio.ts` were **not modified**, per the approval rule.

### Verification

**Automated (`npm test`): 12/12 pass.**

| Test fixture | Result |
|---|---|
| 120 BPM clicks, first beat 0.25 s | 120.000, 0.2512 s (1.2 ms error) |
| 128 BPM kick + off-beat hats + noise, 0.37 s | 128.004, 0.3721 s (2.1 ms); grid on kicks, not hats |
| 93.5 BPM (fractional) | 93.503, 1.9 ms |
| 174 BPM | Exact with a 120–200 range; 87/174 (octave-equivalent) with defaults |
| Silence / 2 s clip | `null` |
| White noise 30 s / 120 s | Flagged low-confidence |
| Grid maths, sync pitch, BPM formatting | Exact |

Extra probe, not in the suite: 140 BPM × 300 s → 1.0 ms phase error, analysis 1.2 s; 126.4 BPM × 240 s → 0.7 ms, 0.9 s.

**Static checks:**
- `npx tsc --noEmit`: 0 errors.
- `npm run lint`: 4 errors and 2 warnings, **identical to the baseline** (`Layout.tsx:34`, `Library.tsx:374`, `useMediaRecorder.ts:171/231/233/275`); none in touched code.
- `npm run build`: succeeds.

**In the running app** (Claude's built-in browser, `next dev`, real vault tracks):

| Check | Result |
|---|---|
| Vault import stores grids | ✅ 25 tracks imported with `beatGrid` |
| Lazy re-analysis on deck load (grid version bump 1→2) | ✅ Both decks got v2 grids about 0.8 s after load; library rows and IndexedDB updated |
| SYNC (A=Bungalow 90 playing, B=Amor Sincero 110) | ✅ B pitch −18.182 % (expected −18.182); readouts `90.0` / `90.0⟳` |
| Leader A → +4 % | ✅ B follows to −14.909 % (expected −14.909); readouts `93.6` / `93.6⟳` |
| Move B's own pitch | ✅ B sync released; later leader moves no longer affect B |
| Console | No errors from the new code (the only errors seen were transient hot-reload states between edits) |

**Real-music analysis quality** (11 vault tracks, whole track vs each half):

| Confidence | Tracks | Half-to-half agreement |
|---|---|---|
| 0.15–0.29 | Corazon Y Mente 180, F-7 166, Bungalow 90, El Don 162, Amor Sincero 110 | All consistent |
| 0.03–0.06 | Ganja, Amores Perdidos, Dejate Llevar, Falle, Entre Humos, Crussin | Halves disagree, or drift by about 1 BPM (e.g. 168.3 → 169.1): tempo is not constant |

Decision: keep a constant-tempo grid, but flag confidence < 0.12 (`LOW_CONFIDENCE_THRESHOLD`) with `~`. Variable-tempo beat maps are roadmap P3. Tuning variants tried (low-band weight 0.3 / 0 / 300 Hz cutoff) all did worse: 1–2 of 8 tracks half-consistent vs 4 of 8 for the shipped settings.

**Not verified:** a visual check of grid lines against waveform transients. The capture is too dense at default zoom, and the paused waveform renders black (pre-existing issue below). Alignment rests on the numeric phase measurements above.

### Problems found, not fixed (need approval or out of scope)

1. **P0: pitch never reaches the audio** (`hooks/useDeckAudio.ts`, predates this work).
   - Measured: Deck B at −18.18 % advanced 1.003 track-s/s (expected 0.826); Deck A at +1 % advanced 1.003 (expected 1.010).
   - Cause: `basePlaybackRate` is in the play/stop effect's dependencies, so each pitch change restarts the source. The restart is async, so `setDeckPlaybackRate` finds no registered source and the new source runs at 1.0.
   - Fix plan: roadmap **R0**. Until it's fixed, SYNC and the pitch fader are visual only.
2. **P0: main output imbalance** (`lib/audioEngine.ts:227-240`). The split-mono monitor path duplicates the master to the left channel, unlimited: **+6.6 dB left** on an `OfflineAudioContext` replica. Roadmap **R5**.
3. Paused waveform renders black (live analyser tint × 0). P2.
4. The deck track picker is empty until the Library view has been opened once. P2.
5. `public/workers/analyzer.worker.js` (Library fallback) always returns 120 BPM, and its key estimate is unused. It rarely runs now that analysis always yields a BPM; to be replaced by R12 key detection.
6. `RemixGrid` still reads `track.bpm` (refreshed on next load), not the deck grid. Minor.

### Tooling notes

- **REA:**
  - `open_binary` / `inspect_pe_resources` / `inspect_artifact` worked on `mixxx.exe`.
  - Deep analysis is unavailable: no Ghidra/Java, Hopper is macOS-only, IDA isn't configured.
  - `capture_browser_scenario` failed twice with `cleanup_incomplete`.
- **Stale dev bundle:** once, `next dev` served a page compiled before the latest edit (`BEAT_GRID_VERSION` 1 in the page while the source said 2). Fixed by reloading. Check `req.c[...]` exports if behaviour doesn't match the source.
- **Test fixtures:** an LCG noise generator produced a fake ~84 BPM "beat" (periodic low bits). Fixtures use mulberry32.

### Open questions for you

See "Approvals requested" in the roadmap: R0 pitch fix, R5 routing fix, R6–R8 transport clock / phase sync / native loops, R9 headphone output, Ghidra + JDK install for REA.
