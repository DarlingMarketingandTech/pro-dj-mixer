import { create } from 'zustand';
import type { Track, TrackBeatGrid } from '@/lib/db';
import { AudioEngine } from '@/lib/audioEngine';
import { BEAT_GRID_VERSION, computeSyncPitchPercent, type BeatGrid } from '@/lib/beatGrid';

export interface StemState {
  vocals: boolean;
  drums: boolean;
  inst: boolean;
}

export interface DeckState {
  track: Track | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  buffer: AudioBuffer | null;
  isLoading: boolean;
  volume: number;
  pitchPercent: number;
  sync: boolean;
  keyLock: boolean;
  keyLockSupported: boolean;
  stems: StemState;
  /** Beat grid for the loaded track. Kept beside `track` so filling it in never swaps the track object. */
  beatGrid: TrackBeatGrid | null;
}

interface DeckStore {
  deckA: DeckState;
  deckB: DeckState;
  loadTrack: (deckId: 'A' | 'B', track: Track) => Promise<void>;
  ejectTrack: (deckId: 'A' | 'B') => void;
  togglePlay: (deckId: 'A' | 'B') => void;
  setVolume: (deckId: 'A' | 'B', volume: number) => void;
  setPitch: (deckId: 'A' | 'B', pitchPercent: number) => void;
  toggleSync: (deckId: 'A' | 'B') => void;
  toggleKeyLock: (deckId: 'A' | 'B') => void;
  setCurrentTime: (deckId: 'A' | 'B', time: number) => void;
  toggleStem: (deckId: 'A' | 'B', stemType: keyof StemState) => void;
}

const initialDeckState: DeckState = {
  track: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  buffer: null,
  isLoading: false,
  volume: 1,
  pitchPercent: 0,
  sync: false,
  keyLock: false,
  keyLockSupported: true,
  stems: { vocals: true, drums: true, inst: true },
  beatGrid: null,
};

type DeckId = 'A' | 'B';
const deckKeyOf = (deckId: DeckId) => (deckId === 'A' ? 'deckA' : 'deckB') as 'deckA' | 'deckB';
const otherDeckKeyOf = (deckId: DeckId) => (deckId === 'A' ? 'deckB' : 'deckA') as 'deckA' | 'deckB';

const hasCurrentGrid = (track: Track) => track.beatGrid?.version === BEAT_GRID_VERSION;

/** BPM of the loaded track at pitch 0: the analysed grid when available, otherwise the library tag. */
export const getDeckBpm = (deck: DeckState): number => deck.beatGrid?.bpm ?? (Number(deck.track?.bpm) || 0);

/** Grid used for beat math. Falls back to a grid anchored at 0:00 for tracks not analysed yet. */
export const getDeckGrid = (deck: DeckState): BeatGrid | null => {
  if (deck.beatGrid) return { bpm: deck.beatGrid.bpm, firstBeatSec: deck.beatGrid.firstBeatSec };
  const bpm = getDeckBpm(deck);
  return bpm > 0 ? { bpm, firstBeatSec: 0 } : null;
};

/** Pitch a synced follower needs to match the other deck, or null if either side has no tempo. */
const followerPitch = (follower: DeckState, leader: DeckState) =>
  computeSyncPitchPercent(getDeckBpm(follower), getDeckBpm(leader), leader.pitchPercent);

export const useDeckStore = create<DeckStore>((set, get) => ({
  deckA: { ...initialDeckState },
  deckB: { ...initialDeckState },

  loadTrack: async (deckId: 'A' | 'B', track: Track) => {
    const deckKey = deckId === 'A' ? 'deckA' : 'deckB';

    set((state) => ({
      [deckKey]: {
        ...state[deckKey],
        isLoading: true,
        track,
        stems: { vocals: true, drums: true, inst: true },
        beatGrid: hasCurrentGrid(track) ? track.beatGrid! : null,
      }
    }));

    try {
      const engine = AudioEngine.getInstance();
      await engine.resume();

      let buffer: AudioBuffer;
      if (track.audioUrl) {
        buffer = await engine.loadBuffer(track.audioUrl);
      } else if (track.fileBlob) {
        buffer = await engine.loadBuffer(track.fileBlob);
      } else {
        // Fallback for seeded tracks without Blob
        buffer = await engine.loadBuffer('https://actions.google.com/sounds/v1/alarms/bugle_tune.ogg');
      }

      set((state) => {
        const loadedDeck: DeckState = {
          ...state[deckKey],
          isLoading: false,
          buffer,
          duration: buffer.duration,
          currentTime: 0,
          isPlaying: false,
        };
        // A synced deck keeps following the other deck when it gets a new track.
        const syncedPitch = loadedDeck.sync ? followerPitch(loadedDeck, state[otherDeckKeyOf(deckId)]) : null;
        return { [deckKey]: syncedPitch === null ? loadedDeck : { ...loadedDeck, pitchPercent: syncedPitch } };
      });

      if (!hasCurrentGrid(track)) {
        void analyzeLoadedTrack(deckId, track, buffer);
      }
    } catch (error) {
      console.error(`Failed to load track to Deck ${deckId}:`, error);
      set((state) => ({
        [deckKey]: { ...state[deckKey], isLoading: false, track: null, buffer: null }
      }));
    }
  },

  ejectTrack: (deckId: 'A' | 'B') => {
    const deckKey = deckId === 'A' ? 'deckA' : 'deckB';
    if (typeof window !== 'undefined') {
      AudioEngine.getInstance().disconnectDeck(deckId);
    }
    set({ [deckKey]: { ...initialDeckState } });
  },

  togglePlay: (deckId: 'A' | 'B') => {
    const deckKey = deckId === 'A' ? 'deckA' : 'deckB';
    set((state) => ({
      [deckKey]: { ...state[deckKey], isPlaying: !state[deckKey].isPlaying }
    }));
  },

  setVolume: (deckId: 'A' | 'B', volume: number) => {
    const deckKey = deckId === 'A' ? 'deckA' : 'deckB';
    set((state) => ({
      [deckKey]: { ...state[deckKey], volume }
    }));
  },

  setPitch: (deckId: 'A' | 'B', pitchPercent: number) => {
    const deckKey = deckKeyOf(deckId);
    const otherKey = otherDeckKeyOf(deckId);
    set((state) => {
      // Moving a synced deck's own pitch releases sync, like a CDJ.
      const deck: DeckState = { ...state[deckKey], pitchPercent, sync: false };
      const other = state[otherKey];
      const otherPitch = other.sync ? followerPitch(other, deck) : null;
      return {
        [deckKey]: deck,
        ...(otherPitch === null ? {} : { [otherKey]: { ...other, pitchPercent: otherPitch } }),
      };
    });
  },

  setCurrentTime: (deckId: 'A' | 'B', time: number) => {
    const deckKey = deckId === 'A' ? 'deckA' : 'deckB';
    set((state) => {
      if (Math.abs(state[deckKey].currentTime - time) < 0.001) {
        return state;
      }
      return {
        [deckKey]: { ...state[deckKey], currentTime: time }
      };
    });
  },

  toggleSync: (deckId: 'A' | 'B') => {
    const localDeckKey = deckId === 'A' ? 'deckA' : 'deckB';
    const masterDeckKey = deckId === 'A' ? 'deckB' : 'deckA';

    set((state) => {
      const localDeck = state[localDeckKey];
      const masterDeck = state[masterDeckKey];

      if (localDeck.sync) {
        return {
          [localDeckKey]: { ...localDeck, sync: false }
        };
      }

      const pitchPercent = masterDeck.isPlaying ? followerPitch(localDeck, masterDeck) : null;
      if (pitchPercent === null) {
        return {
          [localDeckKey]: { ...localDeck, sync: false }
        };
      }

      // Match the tempo you hear from the other deck (its file BPM × its pitch fader).
      // The other deck becomes the leader, so it cannot also be following this one.
      return {
        [localDeckKey]: { ...localDeck, sync: true, pitchPercent },
        [masterDeckKey]: { ...masterDeck, sync: false },
      };
    });
  },

  toggleKeyLock: (deckId: 'A' | 'B') => {
    const deckKey = deckId === 'A' ? 'deckA' : 'deckB';
    const { enabled, supported } =
      typeof window !== 'undefined'
        ? AudioEngine.getInstance().toggleKeyLock(deckId)
        : { enabled: !get()[deckKey].keyLock, supported: true };

    set((state) => ({
      [deckKey]: {
        ...state[deckKey],
        keyLock: enabled,
        keyLockSupported: supported,
      },
    }));
  },

  toggleStem: (deckId: 'A' | 'B', stemType: keyof StemState) => {
    const deckKey = deckId === 'A' ? 'deckA' : 'deckB';
    set((state) => {
      const currentStems = state[deckKey].stems;
      const nextActive = !currentStems[stemType];
      if (typeof window !== 'undefined') {
        // stems.x = true means the stem is audible (not muted); invert for setStemMute
        AudioEngine.getInstance().setStemMute(deckId, stemType, !nextActive);
      }
      return {
        [deckKey]: {
          ...state[deckKey],
          stems: { ...currentStems, [stemType]: nextActive },
        },
      };
    });
  },
}));

/**
 * Analyse a freshly loaded track that has no (current) beat grid, then store the grid on the deck
 * and in the library. Runs in the analysis worker; playback is never blocked.
 */
async function analyzeLoadedTrack(deckId: DeckId, track: Track, buffer: AudioBuffer) {
  const deckKey = deckKeyOf(deckId);
  const otherKey = otherDeckKeyOf(deckId);
  try {
    // Dynamic import keeps libraryStore (and its worker) out of deckStore's static import graph.
    const { analyzeBeatGridForBuffer, persistTrackBeatGrid } = await import('@/store/libraryStore');
    const beatGrid = await analyzeBeatGridForBuffer(buffer);
    if (!beatGrid) return;
    // The user may have loaded something else while the analysis ran.
    if (useDeckStore.getState()[deckKey].track !== track) return;

    useDeckStore.setState((state) => {
      const deck: DeckState = { ...state[deckKey], beatGrid };
      const other = state[otherKey];
      // BPMs just changed, so keep whichever deck is synced locked to the other.
      const deckPitch = deck.sync ? followerPitch(deck, other) : null;
      const otherPitch = other.sync ? followerPitch(other, deck) : null;
      return {
        [deckKey]: deckPitch === null ? deck : { ...deck, pitchPercent: deckPitch },
        ...(otherPitch === null ? {} : { [otherKey]: { ...other, pitchPercent: otherPitch } }),
      };
    });
    await persistTrackBeatGrid(track, beatGrid);
  } catch (error) {
    console.warn(`[deckStore] Beat grid analysis failed for Deck ${deckId}:`, error);
  }
}
