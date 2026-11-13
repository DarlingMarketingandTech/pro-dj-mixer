# DJ Pro Mixer: Architecture

How the app is put together, for anyone (or any agent) continuing the work. It complements `CLAUDE.md`, which covers commands and conventions. Known defects are tracked in `docs/research/FEATURE_COMPARISON.md`.

## Platform

The app is a single-page Next.js 15 / React 19 web app, and all audio work happens in the browser through the Web Audio API.
- **State** lives in Zustand stores (`store/*`).
- **Persistence** is IndexedDB via Dexie (`lib/db.ts`) plus localStorage caches.
- **Server side** is only the cloud "vault" upload routes (`app/api/vault/*`, presigned Cloudflare R2 URLs).

No native code is involved, so anything that needs OS audio access (ASIO, a second device on non-Chromium browsers, HID) is out of reach.

## Three layers

```
┌──────────── UI (React components) ────────────┐
│ Deck.tsx  Mixer.tsx  ParallelWaveforms.tsx …  │  reads stores with narrow selectors
└──────────────┬───────────────────────────┬────┘
               │ actions                   │ RAF reads (no re-render)
┌──────────────▼──────── state ────────────▼────┐
│ deckStore   mixerStore   libraryStore   uiStore│  Zustand
└──────────────┬────────────────────────────────┘
               │ useDeckAudio (one per deck) bridges state → audio graph
┌──────────────▼──────── audio ─────────────────┐
│ AudioEngine singleton (lib/audioEngine.ts)    │  Web Audio nodes, transport helpers
└───────────────────────────────────────────────┘
```

**Rule of thumb:** stores hold *intent* (is playing, pitch %, EQ values). `useDeckAudio` turns intent into node operations. The engine owns the nodes and the transport tricks: seek, stutter, slip-roll, beat-break, key lock.

## Audio graph (per deck → master)

```
AudioBufferSourceNode  (or SoundTouch ScriptProcessor when key lock needs it)
  → stem crossover (LR4: drums <250 Hz | vocals 250 Hz–4 kHz | inst >4 kHz) → stem gains
      ├─ direct sends ──────────────────────────────┐
      └─ FX sends → deck FX bus (crush → filter → echo) → deckGain (volume × crossfader)
  → EQ (low shelf 250 Hz · peak 1 kHz · high shelf 4 kHz) → deck analyser → masterGain (0.5 = −6 dB)
masterGain → master analyser → dry + "bunker" convolution reverb (20 % wet) → limiter → speakers
                                                                          → recording tap
remixBus → limiter
split-mono (opt-in): limiter → mono → L ┐ ChannelMerger → speakers, replacing the stereo limiter → speakers path
                     cueGain → mono → R ┘ (only one path ever feeds the speakers)
```

## Timing model (where "now" comes from)

| Consumer | Source of position | Precision |
|---|---|---|
| Audio itself | `AudioBufferSourceNode` playhead (sample-accurate, inside the audio thread) | exact |
| **Engine transport clock** (`engine.getDeckPosition(deck, at?)`) | Computed from segments (`lib/transportClock.ts`): anchor + rate, exact `setTargetAtTime` glide integral, native loop wrap. Updated wherever audio is scheduled (play, stop, seek, stutter, slip-roll/beat-break, rate) | ≤ 0.24 ms vs rendered audio |
| `useDeckAudio` local `currentTime` | Reads the transport clock in its RAF loop; repaints at about 45 Hz | exact value, sampled per frame |
| `deckStore.currentTime` | Committed from the RAF loop at 30 Hz | ±33 ms |
| Waveform canvas | Predicts at the playback rate and eases toward the store value; snaps on jumps > 0.25 s (`advancePlayhead`) | smooth, ±a few ms |

Rule: anything that must act *on the beat* (beat jump, loop points, cue setting, phase sync, quantized play) reads `AudioEngine.getDeckPosition()`, never `deckStore.currentTime` or React state. The store and React values are for display only.

**Dev note.** `public/sw.js` serves `/_next/static` cache-first, so it is registered only in production (`app/page.tsx`). In development an installed worker made every page load run the *previous* build.

## Beat grid data flow (Phase 1)

```
Import / vault sync                          Deck load (track has no current grid)
  decode (main thread)                         engine.loadBuffer → AudioBuffer
  → analysisWorker: analyzeBeatGrid            → copy channel 0 → analysisWorker
  → Track.beatGrid {bpm, firstBeatSec,         → deckStore.deckX.beatGrid (track object untouched)
     confidence, version} + Track.bpm          → persistTrackBeatGrid → Dexie + libraryStore
```

- `lib/beatGrid.ts` is pure (no imports). It contains the analysis and all grid maths: phase, nearest beat, quantized loop start, effective BPM, sync pitch.
- **Consumers:**
  - `getDeckBpm` / `getDeckGrid` (deckStore) feed `Deck.tsx` (readout, loop quantize, beat jump), `PhraseDisplay`, `ParallelWaveforms` (grid lines, phase indicator) and `app/page.tsx`.
  - Tracks without a grid fall back to `{bpm: track.bpm, firstBeatSec: 0}`, which is the old behaviour.
- **Versioning:** `BEAT_GRID_VERSION`. Raising it makes decks re-analyse stale grids on load, and changes the analysis-cache key (`piko-track-analysis-grid<N>:`).
- **Why the grid sits on the deck rather than the track:** `useDeckAudio` resets the playhead whenever the deck's `track` object changes. Writing the grid into a new track object mid-play would jump the playhead to 0.

## Sync model (Phase 1)

There's one leader and one follower. The deck you press SYNC on follows the other deck, which must be playing.

- Follower pitch = `computeSyncPitchPercent(followerBpm, leaderBpm, leaderPitch)`: leader *effective* BPM, ratio folded into [1/√2, √2].
- Leader pitch changes are pushed to the follower (`setPitch`).
- Moving the follower's own pitch releases SYNC.
- Loading a new track onto a synced deck re-syncs it.
- No phase alignment yet (needs R6).

## Cross-tab sync

`lib/syncManager.ts` mirrors mixer and deck state, cues and library refreshes across tabs through a `BroadcastChannel`. It applies remote pitch through `setState` (not `setPitch`), so remote updates don't release local sync.

## Testing

`npm test` runs `node --test "tests/**/*.test.ts"` using Node 22's built-in TypeScript type stripping, with no test dependencies. Modules under test must be importable without the `@/` alias or browser globals, which is why `lib/beatGrid.ts` has no imports. `tsconfig.json` sets `allowImportingTsExtensions` so tests can import `../lib/x.ts`.
