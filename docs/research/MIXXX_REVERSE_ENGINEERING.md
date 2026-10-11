# Mixxx Reverse-Engineering Findings

Research notes on how Mixxx implements core DJ features, written to guide improvements to DJ Pro Mixer. **No Mixxx code was copied into this project.** Mixxx is GPL-2.0-or-later; everything below describes concepts and constants so they can be re-implemented independently.

## Provenance

| Item | Value |
|---|---|
| Source revision | `mixxxdj/mixxx` tag `2.5.6`, commit `3ebac449e7e5fe2a0186596657696e87ce8b0e56` (2026-03-25, "Release 2.5.6") |
| Source checkout | Sparse, blobless clone (read-only, never built or executed): `src/engine`, `src/mixer`, `src/track`, `src/analyzer`, `src/effects/backends/builtin`, `src/library/dao`, `src/waveform/renderers`, `src/control`, `src/audio`, `src/soundio`, `src/util` |
| Installed binary | `C:\Program Files\Mixxx\mixxx.exe`, Mixxx **2.5.6 x64**, SHA-256 `525bbfebc867299dd58abbf456c8a14eb80f3afc200d01d56b873a26b7958c87`, 9,681,912 bytes, with `mixxx.pdb` (93 MB) |
| License | `LICENSE`: "GNU General Public License … either version 2 of the License, or (at your option) any later version" |
| Investigation date | 2026-10-11 |

Paths below are relative to the Mixxx `src/` directory. Line numbers refer to tag 2.5.6.

## REA evidence log (what was actually run)

Verified results only. Failures are recorded as failures.

| REA operation | Target | Result |
|---|---|---|
| `open_binary` | `mixxx.exe` | ✅ Opened: `format: pe`, `kind: executable`, `architecture: x86_64`, SHA-256 above |
| `binary_overview` | `mixxx.exe` | ❌ `provider_unavailable`. Ghidra: `GHIDRA_INSTALL_DIR` not set, no Java runtime. Hopper: "not supported on win32". IDA: `REA_IDA_MCP_CONFIG` not set. |
| `inspect_pe_resources` | `mixxx.exe` | ✅ PE32+ (machine `0x8664`); 8 resources (5 RT_ICON, 1 RT_GROUP_ICON `IDI_ICON1`, 1 RT_VERSION, 1 RT_MANIFEST); coverage `complete`. Evidence `ev_6105f73f…2657` |
| `inspect_artifact` | `mixxx.exe` | ✅ Single-node artifact graph, hash verified, no embedded containers. REA proposes `open_binary` with a deep provider as the next probe. Evidence `ev_ac807fcd…5de9` |
| `inspect_signature` | `mixxx.exe` | ❌ `capability_unavailable`: "Native macOS utilities require macOS." |
| `capture_browser_scenario` | DJ Pro Mixer on `http://localhost:3000` (headless Chrome) | ❌ Failed twice: `cleanup_incomplete` / "Browser scenario provider is closing". Runtime checks used Claude's built-in browser instead (see below). |

The rows above are from the first pass, before a deep provider existed. **Function-level REA results follow below.**

### Deep provider setup (2026-10-11, approved)

| Component | Version / location | Verification |
|---|---|---|
| Eclipse Temurin JDK | 21.0.12.1+1, `C:\tools\jdk-21.0.12.1+1` | SHA-256 `f9d6e191…8b4e` matches the Adoptium API |
| Ghidra | 12.1.4 (the version REA pins), `C:\tools\ghidra_12.1.4_PUBLIC` | SHA-256 `ddac49f9…d4db` matches the GitHub release notes |
| REA | `rea-agents` 6.4.0, provider `ghidra` | `rea doctor`: installation, version, headless, native decompiler (`win_x86_64`), Java and Windows isolation checks all healthy |
| Settings | `GHIDRA_INSTALL_DIR`, `JAVA_HOME`, `GHIDRA_HEADLESS_MAXMEM=8G`, `REA_GHIDRA_STARTUP_TIMEOUT_MS=3600000` | Set in the Windows user environment and in the `rea` MCP server entry of `~/.claude.json` |

**PDB symbols.** REA analyses a renamed private copy of the target with a private `APPDATA`/`user.home`, so Ghidra's PDB analyzer can't see `mixxx.pdb`. The first REA run found 25,228 functions, all unnamed (`FUN_…`).

Workaround, using REA's supported `REA_GHIDRA_SEED_FILE` hook:
1. Run Ghidra headless directly on the original `mixxx.exe`, where it finds `mixxx.pdb`: "PDB Types and Main Symbols Processing Terminated Normally", 306,713 symbols resolved, 18 min.
2. Dump every PDB-named function as an REA seed line. This produced 31,208 entries in `C:\tools\rea-snapshots\mixxx-2.5.6-pdb.seeds`.
3. Re-run REA with the seeds. Tools: `docs/research/tools/`.

### Function-level REA evidence (Ghidra 12.1.4 + PDB seeds)

**Run details.** One REA MCP session (`open_binary` → Ghidra analysis 704 s), then 26 queries.
- **Raw evidence:** `C:\tools\rea-snapshots\mixxx-trace-2026-10-11-pdb\`, one JSON per query plus `summary.json`. Kept outside the repo because the decompiled output is derived from GPL code.
- **Names:** callers and callees come back as addresses and were mapped back to the PDB names.

| Workflow | Function (address) | REA evidence | What the shipped binary shows |
|---|---|---|---|
| A. Play | `EngineBuffer::slotControlPlayRequest` (`0x1401a4430`) | pseudocode `ev_dcb3fa5f2efb…`, callees `ev_5f2d5f6aab51…` | Calls `updateIndicatorsAndModifyPlay`, `VinylControlControl::isEnabled` and `ControlDoublePrivate::setAndConfirm`. **`requestSyncPhase()` is inlined** as a flag write (`+0x3204 = 1`) that only happens when quantize > 0 and vinyl control is off. That confirms "Play with quantize phase-aligns" at the binary level. |
| A. Play | `EngineBuffer::processTrackLocked` (`0x1401a3200`) | callees `ev_87dbf450d36f…` | Calls `processSeek`, `processSlip`, `readToCrossfadeBuffer`, `RateControl::calculateSpeed`, `KeyControl::getPitchTempoRatio`, `SampleUtil::linearCrossfadeBuffersIn` and `CachingReader::hintAndMaybeWake`, matching the source order in §2. |
| B. Sync | `RateControl::calculateSpeed` (`0x1403a02a0`) → `BpmControl::calcSyncedRate` (`0x14037bca0`) → `BpmControl::calcSyncAdjustment` (`0x14037b7b0`) | callers `ev_2997545d17f4…`, `ev_de558084d0c6…`, `ev_7da08920ddc5…`; pseudocode `ev_4e42ecad53a4…` | Sync correction runs **inside the per-buffer speed calculation**. The decompiled controller contains the dead-band `0.01`, train-wreck `0.2`, gain `0.7`, step cap `±0.02`, adjustment cap `±0.05` and train-wreck speed-up `1.05`. `shortestPercentageChange` is inlined. |
| B. Sync | `SyncControl::determineBpmMultiplier` (`0x1403a3210`) | pseudocode `ev_5e5794f642a5…`, callers `ev_11db6040c61d…` | `ratio² > 2.0 → 2.0`, `ratio² < 0.5 → 0.5`, else `1.0`. Called from `SyncControl::reinitLeaderParams` and `slotControlBeatSyncTempo`. |
| C. Crossfader | `EngineXfader::getXfadeGains` (`0x1401a7450`) | pseudocode `ev_29f5d3b40138…`, callers `ev_04a78230875b…` | `1 − pow(x, transform)` per side; constant-power branch (`curve == 1.0`) renormalises by `1/√(g1² + g2²)`; reverse swaps sides. **Callers:** `EngineMixer::process` (audio), `PlayerInfo::updateCurrentPlayingDeck` (crossfader position decides which deck counts as "now playing") and `DlgPrefMixer::drawXfaderDisplay` (preferences graph). |
| D. Loop | `LoopingControl::findQuantizedBeatloopStart` (`0x1403964d0`) | pseudocode `ev_a6fe07d7dc36…`, callers `ev_430b2e51ea68…` | Under one beat: floor to the sub-division, then compare against `loopLength × 0.5`. Otherwise: closest beat. Called from `LoopingControl::slotBeatLoop` and `LoopingControl::hintReader` (pre-loads the audio cache at the loop start). |
| D. Loop | `ReadAheadManager::getNextSamples` (`0x1403a18e0`) | callees `ev_4818f282b945…`, callers `ev_2516826804344…` (empty) | Calls `SampleUtil::linearCrossfadeBuffersOut`, `applyRampingGain`, `RateControl::notifyWrapAround` and `LoopingControl::getTrackSamples`, so **loop wraps are crossfaded**, not hard-cut. No static callers resolved, which is consistent with a virtual call (the class has a test mock). |

**What this adds beyond the source reading:**
1. `requestSyncPhase` is inlined, so quantized Play is a flag on the hot path.
2. The crossfader also drives "now playing" detection.
3. Loop wraps are crossfaded.

All constants match the 2.5.6 source, so the shipped build behaves as the source describes for these four workflows.

### Correlating the binary with the source (no REA; plain byte search)

To confirm the installed binary is the same code as the source checkout, the binary and PDB were searched for class names and control keys from the source (`grep -c -a -F`, counting matching lines):

| Token | `mixxx.exe` | `mixxx.pdb` |
|---|---|---|
| `LoopingControl` | 5 | 329 |
| `BpmControl` | 4 | 174 |
| `SyncControl` | 3 | 120 |
| `CueControl` | 2 | 206 |
| `ReadAheadManager` | 3 | 69 |
| `EngineBufferScaleRubberBand` / `EngineBufferScaleST` | 2 / 2 | 48 / 40 |
| `EngineXfader` / `EngineBuffer::process` | 0 / 0 | 10 / 5 |
| control keys `beatloop_activate`, `sync_enabled`, `slip_enabled`, `xFaderCurve` | 1 each | 1 each |

This is consistent with the 2.5.6 source (string presence only; no behaviour is inferred from it).

---

## 1. Audio playback architecture

**What it does.** A real-time engine thread pulls fixed-size buffers from each deck, scales them for tempo and pitch, mixes them, and writes the result to the sound card.

**How it works (verified in source):**

- **Pull model, one callback per buffer.** `EngineMixer::process` → `processChannels` (`engine/enginemixer.cpp:273`) → each `EngineChannel` → `EngineBuffer::process` (`engine/enginebuffer.cpp:1165`) → `processTrackLocked` (`:857`).
- **Decoding is off the audio thread.** `CachingReader` reads the file in chunks of `kFrames = 8192` (about 170 ms at 48 kHz; `engine/cachingreader/cachingreaderchunk.h:27`). It keeps `kNumberOfCachedChunksInMemory = 80` chunks (`engine/cachingreader/cachingreader.cpp:36`), filled by a worker thread through lock-free FIFOs. The audio thread never decodes.
- **Read-ahead and loops.** `ReadAheadManager::getNextSamples` (`engine/readaheadmanager.cpp:37`) clamps each read at the loop trigger, so loops wrap **sample-accurately** inside one callback.
- **Tempo and pitch scaling.** Three interchangeable scalers: linear (vinyl), SoundTouch and Rubber Band (`engine/bufferscalers/*`). The keylock engine is chosen at runtime (`slotKeylockEngineChanged`, `:831`). Keylock is **forced off while scratching, above ±1.9× speed, or below 0.1×**, because time-stretchers sound bad and reallocate at those extremes (`processTrackLocked`, `:906-932`).
- **Click-free seeks.** On a seek, `setNewPlaypos` (`:467`) first renders one extra buffer from the *old* position into `m_pCrossfadeBuffer` (`readToCrossfadeBuffer`, `:454`), then crossfades old into new (`SampleUtil::linearCrossfadeBuffersIn`, `:1107`). Stopping also renders a fade-out buffer (`:957-962`).
- **Per-buffer gain ramps.** Every channel's gain ramps linearly from the previous callback's value to the new one across the whole buffer (`ChannelMixer::applyEffectsAndMixChannels`, `engine/channelmixer.cpp:8-50`, `GainCache` old/new gain). Fader moves therefore never produce zipper noise.

**DJ Pro Mixer equivalent.** The Web Audio API provides the real-time thread, mixing and scheduling. Each deck plays a fully decoded `AudioBuffer` through an `AudioBufferSourceNode` (`lib/audioEngine.ts`). Seeks swap source nodes behind a 2–6 ms gain dip (`seekTo`, `startStutter`). Parameter changes use `setTargetAtTime`, which matches Mixxx's per-buffer ramps in spirit.

**Difficulty to adopt:** the chunked cache and crossfaded seeks need an AudioWorklet engine, so the cost is high. **Recommendation:** keep `AudioBufferSourceNode`. Move to a worklet only if a feature needs sample-level transport control.

## 2. Deck controls

### Play (trace of Example A, from source)

```
UI play button  ──►  ControlObject [ChannelN],play
                      │  slotControlPlayRequest (enginebuffer.cpp:776)
                      │    ├─ updateIndicatorsAndModifyPlay (:750): refuses play if no track / at end / passthrough
                      │    └─ if quantize enabled → requestSyncPhase()   ◄── phase-aligns on play
                      ▼
engine callback  EngineBuffer::process (:1165) → processTrackLocked (:857)
                      ├─ processSyncRequests, processSlip, processSeek (phase seek applied here)
                      ├─ RateControl::calculateSpeed (ratecontrol.cpp:393)  → speed
                      ├─ choose scaler (keylock / linear) (:906-955)
                      └─ m_pScale->scaleBuffer(pOutput) (:1082) → ReadAheadManager → CachingReader
                      ▼
EngineMixer: per-channel gain (volume × crossfader) ramped old→new, effects, sum → main / headphone
```

The key insight: **with quantize on, pressing Play snaps the deck's phase to the sync leader** (`slotControlPlayRequest`, `:782-788`).

### Cue (CDJ mode)

`CueControl::cueCDJ` (`engine/controls/cuecontrol.cpp:1408`) implements Pioneer behaviour:

- While playing, press → stop and return to cue.
- While paused away from the cue, press → set a new cue there; with quantize on, snap it to a beat.
- While paused at the cue, hold → preview playback; release → return to cue and stop.
- Pressing Play during a preview keeps the deck playing.

There are 36 hot cues (`NUM_HOT_CUES 37` includes the main cue; `cuecontrol.h:17`).

### Tempo, BPM and sync (Example B)

- **Sync engine.** `EngineSync` picks a **leader** (`pickLeader`, `engine/sync/enginesync.cpp:219`); followers chase its BPM and beat distance.
- **Half/double tempo.** `SyncControl::determineBpmMultiplier` (`engine/sync/synccontrol.cpp:287`) compares `(myBpm/targetBpm)²` against 2 and ½ (a √2 threshold), so an 87 BPM track syncs to a 174 BPM leader at ×2 instead of doubling its speed.
- **Tempo.** `BpmControl::calcSyncedRate` (`engine/controls/bpmcontrol.cpp:466`) gives `rate = leaderInstantaneousBpm / localBpm`.
- **Phase.** `calcSyncAdjustment` (`:524`) is a proportional controller on *beat distance*, meaning the fraction 0..1 of the way from the previous beat to the next. It uses:
  - `kErrorThreshold = 0.01` beat dead-band
  - `kSyncAdjustmentProportional = 0.7` gain
  - `kSyncDeltaCap = 0.02` limit on change per callback
  - `kSyncAdjustmentCap = 0.05` (±5 %) maximum correction
  - `kTrainWreckThreshold = 0.2` beat: beyond this, just speed up
- **Shortest phase distance.** `shortestPercentageChange` (`:431`) wraps phase error to the shorter way around the beat circle.
- **Beat distance.** `getBeatDistance` (`:601`) = `(pos − prevBeat)/(nextBeat − prevBeat)` minus a user offset.
- **Pitch range.** `rate_temp_*` buttons nudge temporarily; the permanent rate range is the `rateRange` pot, 0.01–4.00 (`ratecontrol.cpp:46, 59-65, 330-360`).

### Quantize

`QuantizeControl` publishes `beat_closest`, `beat_prev` and `beat_next` positions (`engine/controls/quantizecontrol.cpp:71-102`). Seeks, cues and loops snap to these.

## 3. Mixing (Example C: crossfader)

`EngineXfader::getXfadeGains` (`engine/enginexfader.cpp:16`):

- The position is −1..1. A curve **transform** exponent (0.6 … 1000, default 1) bends `gain = 1 − |x|^transform` per side. A high transform gives a fast-cut scratch curve; 1 gives a linear "slow fade".
- In **constant-power mode**, the gains are renormalised so that `gain1² + gain2² = 1` (`:59-76`). The source comment notes that a ReplayGain test of real music found the crossover sum closer to uncorrelated (0.707) than correlated (0.5).
- `EngineMixer` calls it once per callback (`enginemixer.cpp:524`). The resulting gains are then ramped per buffer (§1).

**Headphones.** `headMix` (−1..1) blends cue (PFL) and main signal in the headphones; `headSplit` puts main on the left ear and cue on the right, **on the headphone output only** (`enginemixer.cpp:136-142, 414-475, 867`). Mixxx always has a separate headphone output device.

**EQ.** `knobValueToBiquadGainDb` (`effects/backends/builtin/biquadfullkilleqeffect.cpp:29`):
- Above 0.25 of the knob ratio, the gain is plain `ratio2db`.
- Below 0.25, it slides linearly to the **kill gain of −23 dB** (`kKillGain`, `:18`).
- Default crossover corners are 246 Hz and 2484 Hz (`lvmixeqbase.h:16-17`).

**Pregain.** `EnginePregain` applies ReplayGain plus the gain knob, and a speed-dependent gain bend while scratching (`enginepregain.cpp:13-18`).

## 4. Loops and performance (Example D)

- **Beat loop sizes.** `{1/32 … 512}` beats (`engine/controls/loopingcontrol.cpp:27`).
- **Quantized loop start.** `findQuantizedBeatloopStart` (`:1451`):
  - Loops of 1 beat or more start at the **closest** beat, which may be slightly ahead of the playhead (a "catching" loop).
  - Loops shorter than a beat start at the nearest **sub-division** of the current beat; for example, ½ beat pressed 60 % of the way through a beat loops 50–100 %.
- **Beat jump.** `slotBeatJump` (`:1738`): inside an active loop it *moves the loop*; otherwise it seeks exactly N beats, keeping the current phase (`findNBeatsFromPosition`).
- **Loop wrapping.** `nextTrigger` (`:410`) and `ReadAheadManager` (§1) wrap loops sample-accurately inside the engine callback, not on a UI timer.
- **Slip mode.** `processSlip` (`enginebuffer.cpp:1234`) keeps a shadow play position running during loops, scratches and censor, and seeks back to it on release.

## 5. Waveforms

- `AnalyzerWaveform` splits audio into three bands with **Bessel 4th-order** filters at **600 Hz / 4 kHz** (`analyzer/analyzerwaveform.cpp:13-15, 156-158`). The commented-out Butterworth-8 line shows Bessel was a deliberate choice (Bessel filters have no ringing).
- It stores per-stride peak data for each band plus a fixed-size **summary** (`2 × 1920` samples, `:61`) for the overview. Both are cached in the library database, so a track is analysed once.
- Renderers in `waveform/renderers/*` draw beat-grid, cue and loop marks on top of the cached data. The waveform is never recomputed from audio during playback.

## 6. Library and analysis

- **Beat grid model.** `mixxx::Beats` (`track/beats.h:66`) is a list of `BeatMarker{position, beatsTillNextMarker}`. A constant-tempo track is a single marker (the first beat) plus the BPM; variable-tempo tracks have several markers. Main queries: `findClosestBeat`, `findNthBeat`, `findPrevNextBeats`.
- **BPM detection.** Plugins are Queen Mary (QM-DSP onset detection + tempo tracking) and SoundTouch BPM (`analyzer/analyzerbeats.cpp:20-21, 104-107`). Fixed-tempo detection is on by default (`m_bPreferencesFixedTempo(true)`, `:37`).
- **Constant-tempo fitting.** `BeatUtils::retrieveConstRegions` and `makeConstBpm` (`track/beatutils.cpp:51, 140`) collapse detected beats into constant-tempo regions. Tolerances: `kMaxSecsPhaseError = 0.025`, `kMaxSecsPhaseErrorSum = 0.1`, `kMaxOutliersCount = 1` (`:12-16`).
- **Other analyzers.** Key (QM key / KeyFinder), ReplayGain/EBU R128 and silence detection run on a background `AnalyzerThread`.

## 7. Hardware and session

MIDI/HID mappings are XML plus JavaScript files that read and write **ControlObjects** (string keys such as `[Channel1],play`). Every engine parameter is a ControlObject, so the UI, controllers and scripts all share one control surface. Not investigated in depth because DJ Pro Mixer's Web MIDI support is minimal (`hooks/useMIDIManager.ts`).

## 8. Screen sizes and layouts

**Mixxx has no phone or tablet interface.** It is a desktop application. It copes with smaller windows in four ways, none of them a mobile layout.

| Mechanism | Evidence | What it does |
| --- | --- | --- |
| **Minimum skin size** | Installed `skins/LateNight/skin.xml`: `<MinimumSize>1280,668</MinimumSize>`. `Tango/skin.xml`: `1008,500`. `Shade/skin.xml`: `<Size>1008e,500e</Size>` | Each skin declares the smallest window it can work in. |
| **Fit check** | `LegacySkin::fitsScreenSize` (`skin/legacy/legacyskin.cpp:86`); in the shipped binary at `0x140301f70` (PDB name, from the seed file) | Reads the skin's `MinimumSize` with a regex and returns false when it is wider or taller than the screen. It falls back to parsing a resolution from the skin name. Its only callers are in the Preferences dialog (`preferences/dialog/dlgprefinterface.cpp:161, 457`), which shows a warning label when the chosen skin doesn't fit. `SkinLoader::getDefaultSkinName` always returns `"LateNight"` (`skinloader.cpp:127`). So Mixxx warns about a skin that's too big but never switches skins by screen size. |
| **Size-aware variants** | `SizeAwareLayout::setCurrentIndexForSize` (`widget/wsizeawarestack.cpp`); used by `Deere/mixer.xml:240` (crossfader buttons), `Tango/decks/row_loop_jump.xml:55`, `Tango/helpers/size_detector_*.xml`, `LateNight/fx/unit_parameters_hidden.xml:27` | A container holds variants **smallest first**. On resize it keeps the current one if it fits, otherwise it picks the first that fits exactly, then the largest whose minimum fits, then the smallest. This is Mixxx's closest thing to responsive design, used inside widgets. |
| **User section toggles** | `[Skin],show_*` controls across the installed skins: `show_mixer` (40 uses), `show_maximized_library` (41), `show_waveforms` (13), `show_samplers` (30), `show_effectrack` (25), plus compact variants `show_rate_controls_compact` and `show_vumeters_compact` | The DJ hides whole sections to make room. The experimental QML interface (`qml/main.qml`) does the same with `visible:` bindings on `show4decks`, `maximizeLibrary`, `showSamplers` and `showEffects`. |

**What DJ Pro Mixer takes from this (re-implemented, not copied).**
- The `WSizeAwareStack` rule, applied to the whole page (`lib/layoutTier.ts`). There are three layouts: phone tabs, tablet one-screen, and desktop. The app picks the largest one that fits the viewport.
- The `show_*` toggles map to the existing A / MX / B panel toggles. In the tablet layout, hidden panels give their space to the rest.

**Not verified with REA decompilation.** In this session the REA server process reported `GHIDRA_INSTALL_DIR is not set`, because the new environment variables only reach a restarted MCP server. The binary address above comes from the PDB name dump (`C:\tools\rea-snapshots\mixxx-2.5.6-pdb.seeds`). The behaviour comes from source at tag 2.5.6 and from the installed skin XML.

---

## Verified vs. inferred

- **Verified (read in source at the revision above):** every constant, function name and line number in §1–§6.
- **Verified (REA):** binary identity, format, architecture, resources. **Function level:** the nine functions in the table above (decompiled code, callers and callees, constants), in the shipped `mixxx.exe`.
- **Inferred, not verified at runtime:** run-time behaviour. Everything here is static (source plus decompilation); nothing was executed under a debugger.

## Open questions

1. Does Mixxx soft-limit the main output, or only show clipping? Not checked: `src/engine/enginemixer.cpp` post-mix stages were not fully read.
2. How do QM-DSP onset detection internals compare with the onset function implemented in `lib/beatGrid.ts`? `lib/qm-dsp` was not checked out.
3. ~~Static tracing needs a deep provider~~: done, see the function-level evidence above. Still open: *runtime* traces. REA's `capture_process_scenario` targets Linux/macOS PTYs, and `observe_native_calls` is LLDB/Mach-O only, so Windows runtime tracing would need a different debugger.
