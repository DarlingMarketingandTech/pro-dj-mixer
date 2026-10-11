# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Next.js dev server (http://localhost:3000)
npm run build        # Production build (output: 'standalone')
npm run lint         # eslint . (flat config in eslint.config.mjs, extends eslint-config-next)
npx tsc --noEmit     # Type check
```

There is no test framework or test suite. Verify changes with `tsc` + `lint` and by running the app in a browser (audio requires a user gesture to resume the `AudioContext`).

`next.config.ts` sets `eslint.ignoreDuringBuilds: true` but `typescript.ignoreBuildErrors: false`, so type errors break `npm run build` while lint errors do not. When `DISABLE_HMR=true` (AI Studio), webpack file watching is disabled entirely.

## Environment

Server-only vars used by `app/api/vault/*`: `VAULT_KEY` (checked against the `x-syndicate-key` request header; auth is skipped if unset), `R2_ENDPOINT`, `R2_BUCKET_NAME` (default `audio`), `R2_KEY_PREFIX` (default `audio`), `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. `NEXT_PUBLIC_VAULT_KEY` is only a UI hint on `/vault-admin` and must never be used for auth comparisons. See `.env.example`.

## Architecture

Single-page, fully client-side two-deck DJ mixer (Next.js 15 App Router, React 19, Zustand 5, Tailwind 4, Web Audio API). `app/page.tsx` is the whole app; `app/vault-admin/page.tsx` is an upload tool for the cloud track vault.

### Audio engine (`lib/audioEngine.ts`)

`AudioEngine` is a browser-only singleton (`AudioEngine.getInstance()` throws during SSR — guard with `typeof window !== 'undefined'` in stores). It owns the `AudioContext` (48 kHz, `interactive`) and all node graphs. Per-deck signal path:

```
source (AudioBufferSourceNode, or SoundTouch ScriptProcessor for key lock)
  → stem chain input → LR4 crossover (drums <250Hz | vocals 250–4kHz | inst >4kHz) → per-stem gain
      → per-stem direct gain → stem output ───────────────────────────────┐
      → per-stem FX-send gain → deck FX bus (crush worklet → bipolar filter → echo) → deckGain ┤
  → EQ chain (lowshelf/peak/highshelf) → deck analyser → masterGain ◄──────────────────────┘
masterGain → master analyser → dry + "bunker" convolver reverb → limiter → destination
                                                                       → MediaStreamDestination (recording tap)
remixBus → limiter (bypasses master FX)
masterGain / cueGain → split-mono panners → destination (headphone cueing)
```

Note `deckGain` (crossfader × channel volume) lives inside the FX bus object (`fxBus.deckGain`). "Stems" are frequency-band splits, not real source separation.

Graph-building methods (`createStemChain`, `createDeckFxBus`) are idempotent per deck — they return cached nodes. `disconnectDeck` tears them down on eject.

### Store ↔ engine wiring

- **`store/deckStore.ts`** holds deck state (track, decoded `AudioBuffer`, `isPlaying`, pitch, sync, keyLock, stems). `loadTrack` decodes via the engine. Some actions (`toggleKeyLock`, `toggleStem`, `ejectTrack`) call the engine directly.
- **`hooks/useDeckAudio.ts`** is the bridge: it builds the per-deck graph, starts/stops sources in response to `isPlaying`, applies EQ/crossfader/stem gains from `mixerStore`, and runs the RAF playhead loop. It calls `engine.registerDeckRuntime(...)` (`syncRuntime`) so engine-side transport methods (`seekTo`, `startStutter`, slip-roll/beat-break loops) can swap sources and report back via `onSourceSwap`/`onPauseTime` callbacks. If you change source lifecycle in either place, keep both sides consistent.
- Playhead time is throttled: local React state ~45 Hz, `deckStore.currentTime` commits at 30 Hz. Components that render the full page avoid subscribing to `currentTime` (see the comment in `app/page.tsx`) — use narrow `useShallow` selectors.
- Key lock uses native `preservesPitch` when available, otherwise a SoundTouch (`soundtouchjs`, dynamically imported) `ScriptProcessorNode` path; position then comes from `engine.getKeyLockPosition`.
- **`store/mixerStore.ts`**: crossfader (-1..1), curve (`blend` | `cut` | `neural`), volumes, EQ, vault ambience. The `neural` curve hard-swaps stems at thresholds via `calculateNeuralGains`.

### Persistence & library

- **IndexedDB via Dexie** (`lib/db.ts`, database `DJDatabase`): `tracks`, `cuePoints`, `crates`, `crateTracks`, `history`. Schema changes require a new `this.version(n)` block that repeats all tables.
- **`store/libraryStore.ts`** ingests local files and "vault" tracks (hard-coded `PIKO_VAULT_TRACKS` plus a `library.json` manifest fetched from the public R2 bucket). BPM/overview-waveform analysis runs in `lib/analysisWorker.ts` (bundled via `new URL(..., import.meta.url)`); decoding happens on the main thread because workers can't use Web Audio. Results are cached in localStorage (`piko-track-analysis-v1:*`). `components/Library.tsx` separately uses the static `public/workers/analyzer.worker.js`.
- **Cues**: `store/trackCueStore.ts` is the main cue store, keyed by `getCueTrackHash(track)` (sourceId → audioUrl → metadata fallback). `store/cueStore.ts` is an older store still used by `Library.tsx`.
- **Cloud vault** (`app/api/vault/`): `route.ts` returns a presigned R2 PUT URL, `sync/route.ts` appends to the `library.json` manifest, `delete/route.ts` removes objects. The browser uploads directly to R2.

### Cross-tab sync (`lib/syncManager.ts`)

`BroadcastChannel('pro_dj_studio_sync')` carries `SESSION_STATE`, `NEW_CUE`, and `LIBRARY_REFRESH` messages between tabs ("B2B" mode); session state is also persisted to localStorage. `Mixer.tsx` calls `ensureSessionSync()` and broadcasts on mixer/deck changes; cue edits call `broadcastCue`. Messages carry a `senderId` and JSON signatures are compared to prevent echo loops.

### Other pieces

- `public/worklets/bitcrusher-processor.js` — AudioWorklet for the crush FX (falls back to bypass if it fails to load).
- `public/impulses/concrete-bunker.wav` — master reverb IR (synthetic fallback if missing).
- `public/sw.js` — service worker registered from `app/page.tsx`.
- `hooks/useMediaRecorder.ts` records the post-limiter master tap; `hooks/useMIDIManager.ts` wraps Web MIDI; `useKeyboardShortcuts` / `usePerformanceKeys` handle global and per-deck pad keys (both ignore events from form fields).
- `components/scene/*` (react-three-fiber) are not currently imported anywhere.
- `store/uiStore.ts` drives layout: `layoutMode`, panel visibility, performance mode, mobile `activeTab`. `app/page.tsx` switches to a tabbed compact layout under 768px width or short landscape.

## Design conventions (from `.github/agents/dj-mixer-engineer.agent.md`)

- "MPC studio hardware" aesthetic: pitch-black/matte gunmetal chassis, LED-glow pad states, monospace "OLED" readouts. Theme tokens live in the `@theme` block of `app/globals.css` (`studio-black`, `studio-slate`, `studio-gold`, `studio-crimson`) — use those Tailwind classes rather than raw hex.
- Keep -3 to -6 dB summing headroom ahead of the master limiter; avoid clicks by ramping gains (`setTargetAtTime` / short linear ramps) rather than setting `.value` on live params.
- Never block the UI thread during load or waveform painting (workers, chunked/RAF rendering). Prefer Canvas for waveforms and CSS for depth effects over heavy 3D libraries.
