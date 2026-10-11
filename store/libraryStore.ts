import { create } from 'zustand';
import { db, Track, type TrackBeatGrid } from '@/lib/db';
import { BEAT_GRID_VERSION, formatBpm } from '@/lib/beatGrid';
import { broadcastLibraryRefresh } from '@/lib/syncManager';
import toast from 'react-hot-toast';
import type { AnalysisRequest, AnalysisResponse } from '@/lib/analysisWorker';

const R2_BASE = 'https://pub-9d6c022e6cbf422ea4fcac0a116cbfce.r2.dev/audio';
export const PIKO_VAULT_TRACKS = [
  { id: 'piko-1', title: 'Amor Sincero', artist: 'Piko FG', url: `${R2_BASE}/Amor%20Sincero.mp3` },
  { id: 'piko-2', title: 'Amores Perdidos', artist: 'Piko FG', url: `${R2_BASE}/Amores%20Perdidos.mp3` },
  { id: 'piko-3', title: 'Bungalow', artist: 'Piko FG', url: `${R2_BASE}/Bungalow.mp3` },
  { id: 'piko-4', title: 'Corazon Y Mente', artist: 'Piko FG', url: `${R2_BASE}/Corazon%20Y%20Mente.mp3` },
  { id: 'piko-5', title: 'Crussin', artist: 'Piko FG', url: `${R2_BASE}/Crussin.mp3` },
  { id: 'piko-6', title: 'Dejate Llevar', artist: 'Piko FG', url: `${R2_BASE}/Dejate%20Llevar.mp3` },
  { id: 'piko-7', title: 'El Don', artist: 'Piko FG', url: `${R2_BASE}/El%20Don.mp3` },
  { id: 'piko-8', title: 'Entre Humos', artist: 'Piko FG', url: `${R2_BASE}/Entre%20Humos.mp3` },
  { id: 'piko-9', title: 'F-7', artist: 'Piko FG', url: `${R2_BASE}/F-7.mp3` },
  { id: 'piko-10', title: 'Falle', artist: 'Piko FG', url: `${R2_BASE}/Falle.mp3` },
  { id: 'piko-11', title: 'Ganja', artist: 'Piko FG', url: `${R2_BASE}/Ganja.mp3` },
  { id: 'piko-12', title: 'Gunster', artist: 'Piko FG', url: `${R2_BASE}/Gunster.mp3` },
  { id: 'piko-13', title: 'Im Sorry', artist: 'Piko FG', url: `${R2_BASE}/Im%20Sorry.mp3` },
  { id: 'piko-14', title: 'Jardin De Rosas', artist: 'Piko FG', url: `${R2_BASE}/Jardin%20De%20Rosas.mp3` },
  { id: 'piko-15', title: 'Los 5', artist: 'Piko FG', url: `${R2_BASE}/Los%205.mp3` },
  { id: 'piko-16', title: 'Me Cuentan', artist: 'Piko FG', url: `${R2_BASE}/Me%20Cuentan.mp3` },
  { id: 'piko-17', title: 'Noches Enteras', artist: 'Piko FG', url: `${R2_BASE}/Noches%20Enteras.mp3` },
  { id: 'piko-18', title: 'Party', artist: 'Piko FG', url: `${R2_BASE}/Party.mp3` },
  { id: 'piko-19', title: 'Quejas', artist: 'Piko FG', url: `${R2_BASE}/Quejas.mp3` },
  { id: 'piko-20', title: 'Sentimientos', artist: 'Piko FG', url: `${R2_BASE}/Sentimientos.mp3` },
  { id: 'piko-21', title: 'Sin Rencores', artist: 'Piko FG', url: `${R2_BASE}/Sin%20Rencores.mp3` },
  { id: 'piko-22', title: 'Te Perdi', artist: 'Piko FG', url: `${R2_BASE}/Te%20Perdi.mp3` },
  { id: 'piko-23', title: 'Te Prometo', artist: 'Piko FG', url: `${R2_BASE}/Te%20Prometo.mp3` },
  { id: 'piko-24', title: 'Tortas De Jamon', artist: 'Piko FG', url: `${R2_BASE}/Tortas%20De%20Jamon.mp3` },
  { id: 'piko-25', title: 'Un Dia Mas', artist: 'Piko FG', url: `${R2_BASE}/Un%20Dia%20Mas.mp3` }
] as const;

type PikoVaultTrack = (typeof PIKO_VAULT_TRACKS)[number];

// ---------------------------------------------------------------------------
// R2 manifest support
// ---------------------------------------------------------------------------

/** Shape of each entry stored in library.json by the /api/vault/sync route. */
interface ManifestEntry {
  title: string;
  artist: string;
  bpm: string;
  key: string;
  audioUrl: string;
  createdAt: number;
}

/**
 * Fetches newly-uploaded tracks from the R2 manifest (library.json) and
 * normalises them into the same shape as PIKO_VAULT_TRACKS so they can flow
 * through the existing loadPikoVault pipeline.
 *
 * Falls back to an empty array if the file doesn't exist yet or the
 * network request fails for any reason.
 */
const fetchManifestTracks = async (): Promise<{ id: string; title: string; artist: string; url: string }[]> => {
  const r2PublicUrl = 'pub-9d6c022e6cbf422ea4fcac0a116cbfce.r2.dev';
  try {
    const res = await fetch(`https://${r2PublicUrl}/library.json`, { cache: 'no-store' });
    if (!res.ok) return [];
    const raw: unknown = await res.json();
    if (!Array.isArray(raw)) return [];

    return (raw as ManifestEntry[])
      .filter((e) => e && typeof e.audioUrl === 'string' && e.audioUrl.trim())
      .map((e) => {
        const title = typeof e.title === 'string' ? e.title.trim() : '';
        const artist = typeof e.artist === 'string' ? e.artist.trim() : '';
        // Build a stable ID from audioUrl so it survives manifest reordering.
        const stableKey = e.audioUrl.trim().replace(/[^a-z0-9]/gi, '-').slice(-48);
        return {
          id: `manifest-${stableKey}`,
          title: title || 'Unknown Track',
          artist,
          url: e.audioUrl.trim(),
        };
      });
  } catch {
    return [];
  }
};

type CachedAnalysis = {
  bpm: string;
  duration: string;
  overviewWaveform: number[];
  beatGrid?: TrackBeatGrid;
};

// Keyed by grid version so cached results from an older detector are ignored and recomputed.
const ANALYSIS_CACHE_PREFIX = `piko-track-analysis-grid${BEAT_GRID_VERSION}:`;
const pendingTrackKeys = new Set<string>();

// Reusable decode context (main thread only). Workers cannot use Web Audio APIs.
const decodeContext =
  typeof window !== 'undefined'
    ? new (window.AudioContext || (window as any).webkitAudioContext)()
    : null;

/** Minimal shape shared by hardcoded vault tracks and manifest-fetched tracks. */
interface VaultTrack {
  id: string;
  title: string;
  artist: string;
  url: string;
}

interface LibraryState {
  tracks: Track[];
  processingTracks: { id: string; name: string }[];
  isProcessingQueue: boolean;
  queueProgress: string;
  isVaultSyncActive: boolean;
  vaultReadyCount: number;
  vaultTotalCount: number;
  loadTracks: () => Promise<void>;
  addTrack: (file: File) => Promise<void>;
  seedLibrary: () => Promise<void>;
  queueFilesForIngestion: (files: File[]) => Promise<void>;
  loadPikoVault: (cloudTracks?: ReadonlyArray<VaultTrack>) => Promise<void>;
  fetchLibrary: () => Promise<void>;
}

const mockAnalysis = async (file: File | string) => {
  // Fallback for seed tracks
  await new Promise(resolve => setTimeout(resolve, 500));
  const bpms = ['120', '124', '126', '128', '130', '140'];
  const keys = ['8A', '4A', '11B', '2A', '7B', '9A', '5B'];
  const energies = ['Low', 'Medium', 'High', 'Peak'];
  return {
    bpm: bpms[Math.floor(Math.random() * bpms.length)],
    key: keys[Math.floor(Math.random() * keys.length)],
    energy: energies[Math.floor(Math.random() * energies.length)],
    duration: '03:45',
    hasVocal: Math.random() > 0.5,
  };
};

let isSeeding = false;

const seedArtworkUrls = [
  '/track-images/abstract-1846847_1280.jpg',
  '/track-images/architecture-3189972_1280.jpg',
  '/track-images/aurora-borealis-9267515_1280.jpg',
  '/track-images/background-1833056_1280.jpg',
  '/track-images/bicycle-3045580_1280.jpg',
  '/track-images/dj-2581269_1280.jpg',
  '/track-images/gong-8255081_1280.jpg',
  '/track-images/graffiti-1476119_1280.jpg',
  '/track-images/graffiti-3750912_1280.jpg',
  '/track-images/hamburg-2718329_1280.jpg',
  '/track-images/love-2724141_1280.png',
  '/track-images/skateboard-447147_1280.jpg',
  '/track-images/skull-and-crossbones-414207_1280.jpg',
  '/track-images/starry-sky-1655503_1280.jpg',
  '/track-images/street-art-1499524_1280.jpg',
  '/track-images/tube-7260586_1280.jpg',
  '/track-images/vinyl-1595847_1280.jpg',
  '/track-images/wall-2583885_1280.jpg',
  '/track-images/wallpaper-5928106_1280.png',
  '/track-images/woman-3633737_1280.jpg'
];

const pickRandomArtworkUrl = () => {
  return seedArtworkUrls[Math.floor(Math.random() * seedArtworkUrls.length)];
};

// Singleton Worker instance
let worker: Worker | null = null;
if (typeof globalThis.window !== 'undefined') {
  worker = new Worker(new URL('../lib/analysisWorker.ts', import.meta.url), { type: 'module' });
}

const formatDuration = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

const toAnalysisCacheKey = (key: string) => `${ANALYSIS_CACHE_PREFIX}${key}`;

const readCachedAnalysis = (key: string): CachedAnalysis | null => {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(toAnalysisCacheKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedAnalysis;
    if (!Array.isArray(parsed.overviewWaveform)) return null;
    return parsed;
  } catch {
    return null;
  }
};

const writeCachedAnalysis = (key: string, analysis: CachedAnalysis) => {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(toAnalysisCacheKey(key), JSON.stringify(analysis));
  } catch {
    // Ignore storage quota errors; analysis still lives in IndexedDB.
  }
};

const trackIdentityMatches = (
  track: Track,
  candidate: Partial<Pick<Track, 'id' | 'sourceId' | 'audioUrl'>>
) => {
  if (candidate.id !== undefined && track.id === candidate.id) return true;
  if (candidate.sourceId && track.sourceId === candidate.sourceId) return true;
  if (candidate.audioUrl && track.audioUrl === candidate.audioUrl) return true;
  return false;
};

const dedupeVisibleTracks = (tracks: Track[]) => {
  const seen = new Set<string>();

  return tracks.filter((track) => {
    const key = track.audioUrl
      ? `url:${track.audioUrl}`
      : track.sourceId
        ? `source:${track.sourceId}`
        : track.id !== undefined
          ? `id:${track.id}`
          : null;

    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const getFileSourceId = (file: File) => `file:${file.name}:${file.size}:${file.lastModified}`;
const getCloudSourceId = (track: VaultTrack) => `vault:${track.id}`;
const getVaultTrackIds = (cloudTracks: readonly VaultTrack[]) => new Set(cloudTracks.map((track) => getCloudSourceId(track)));

const countVaultReadyTracks = (tracks: Track[], cloudTracks: readonly VaultTrack[]) => {
  const vaultIds = getVaultTrackIds(cloudTracks);
  return tracks.filter((track) => track.sourceId && vaultIds.has(track.sourceId)).length;
};

const buildTrackFromAnalysis = (
  partial: Pick<Track, 'title' | 'artist' | 'audioUrl' | 'fileBlob' | 'artworkUrl' | 'createdAt' | 'sourceId'>,
  analysis: CachedAnalysis
): Track => ({
  ...partial,
  bpm: analysis.bpm,
  key: '--',
  duration: analysis.duration,
  energy: 'Medium',
  hasVocal: false,
  overviewWaveform: analysis.overviewWaveform,
  ...(analysis.beatGrid ? { beatGrid: analysis.beatGrid } : {}),
});

const toBeatGrid = (res: AnalysisResponse): TrackBeatGrid | undefined =>
  res.firstBeatSec === null
    ? undefined
    : { bpm: res.bpm, firstBeatSec: res.firstBeatSec, confidence: res.confidence, version: BEAT_GRID_VERSION };

const toCachedAnalysis = (res: AnalysisResponse): CachedAnalysis => ({
  bpm: formatBpm(res.bpm),
  duration: formatDuration(res.duration),
  overviewWaveform: Array.from(res.overviewPeaks),
  beatGrid: toBeatGrid(res),
});

// Helper to wrap the worker postMessage in a Promise
const analyzeAudio = (payload: { id: string; channelData: Float32Array; sampleRate: number; duration: number }): Promise<AnalysisResponse> => {
  return new Promise((resolve, reject) => {
    const runAsync = async () => {
      if (!worker) {
        reject(new Error('Worker not initialized'));
        return;
      }

      const requestId = payload.id;

      const handleMessage = (e: MessageEvent<AnalysisResponse>) => {
        if (e.data.id === requestId) {
          worker?.removeEventListener('message', handleMessage);
          if (e.data.error) {
            reject(new Error(e.data.error));
            return;
          }
          resolve(e.data);
        }
      };

      worker.addEventListener('message', handleMessage);

      const request: AnalysisRequest = {
        id: requestId,
        channelData: payload.channelData,
        sampleRate: payload.sampleRate,
        duration: payload.duration,
      };

      // Attempt true zero-copy transfer; if the runtime refuses (e.g. AudioBuffer-backed data),
      // fall back to copying into a transferable ArrayBuffer to avoid crashing.
      try {
        worker.postMessage(request, [payload.channelData.buffer]);
      } catch {
        const copy = new Float32Array(payload.channelData);
        worker.postMessage({ ...request, channelData: copy }, [copy.buffer]);
      }
    };

    runAsync().catch((error) => reject(error instanceof Error ? error : new Error('Analysis failed')));
  });
};

const yieldToUi = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

const fetchArrayBufferStrict = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch from cloud: ${response.status} - ${url}`);
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('text/html')) {
    throw new Error('Cloudflare returned an HTML error page. Check exact filename and path.');
  }
  return await response.arrayBuffer();
};

const decodeToMonoChannelData = async (arrayBuffer: ArrayBuffer) => {
  if (!decodeContext) throw new Error('Audio decoding is only available in the browser.');
  const audioBuffer = await decodeContext.decodeAudioData(arrayBuffer);
  return {
    channelData: audioBuffer.getChannelData(0),
    sampleRate: audioBuffer.sampleRate,
    duration: audioBuffer.duration,
  };
};

/**
 * Beat-grid analysis for a buffer that is already decoded (e.g. a track just loaded on a deck).
 * Copies channel 0 first: transferring the live channel data would detach it from the playing buffer.
 */
export const analyzeBeatGridForBuffer = async (buffer: AudioBuffer): Promise<TrackBeatGrid | null> => {
  const channelData = new Float32Array(buffer.getChannelData(0));
  const res = await analyzeAudio({
    id: crypto.randomUUID(),
    channelData,
    sampleRate: buffer.sampleRate,
    duration: buffer.duration,
  });
  return toBeatGrid(res) ?? null;
};

/** Persist a newly computed grid (and its BPM) for a library track and refresh library state. */
export const persistTrackBeatGrid = async (track: Track, beatGrid: TrackBeatGrid) => {
  const bpm = formatBpm(beatGrid.bpm);
  if (track.id !== undefined) {
    await db.tracks.update(track.id, { bpm, beatGrid });
  }
  const identity = { id: track.id, sourceId: track.sourceId, audioUrl: track.audioUrl };
  useLibraryStore.setState((state) => ({
    tracks: state.tracks.map((t) => (trackIdentityMatches(t, identity) ? { ...t, bpm, beatGrid } : t)),
  }));
  broadcastLibraryRefresh();
};

export const useLibraryStore = create<LibraryState>((set, get) => ({
  tracks: [],
  processingTracks: [],
  isProcessingQueue: false,
  queueProgress: '',
  isVaultSyncActive: false,
  vaultReadyCount: 0,
  vaultTotalCount: PIKO_VAULT_TRACKS.length,
  loadTracks: async () => {
    const tracks = await db.tracks.orderBy('createdAt').reverse().toArray();
    const dedupedTracks = dedupeVisibleTracks(tracks);
    set({
      tracks: dedupedTracks,
      vaultReadyCount: countVaultReadyTracks(dedupedTracks, PIKO_VAULT_TRACKS),
      vaultTotalCount: PIKO_VAULT_TRACKS.length,
    });
  },

  queueFilesForIngestion: async (files: File[]) => {
    if (get().isProcessingQueue) {
      toast.error('A queue is already processing. Please wait.');
      return;
    }

    const audioFiles = files.filter(f => f.type.startsWith('audio/') || /\.(mp3|wav|flac|m4a)$/i.test(f.name));
    const existingTracks = get().tracks;
    const uniqueFiles = audioFiles.filter((file) => {
      const sourceId = getFileSourceId(file);
      if (pendingTrackKeys.has(sourceId)) return false;
      return !existingTracks.some((track) => trackIdentityMatches(track, { sourceId }));
    });

    if (audioFiles.length === 0) {
      toast.error("No valid audio files found in selection.");
      return;
    }

    if (uniqueFiles.length === 0) {
      toast('All selected files are already in the library.');
      return;
    }

    set({ isProcessingQueue: true, queueProgress: `Preparing ${uniqueFiles.length} files...` });

    let successCount = 0;
    const total = uniqueFiles.length;

    for (let i = 0; i < total; i++) {
        const file = uniqueFiles[i];
        const sourceId = getFileSourceId(file);
        set({ queueProgress: `Analyzing ${i + 1} of ${total}: ${file.name}` });
        pendingTrackKeys.add(sourceId);

        try {
          const artworkUrl = URL.createObjectURL(file);
          let resolvedAnalysis = readCachedAnalysis(sourceId);
          if (!resolvedAnalysis) {
            const arrayBuffer = await file.arrayBuffer();
            const decoded = await decodeToMonoChannelData(arrayBuffer);
            const res = await analyzeAudio({ id: crypto.randomUUID(), ...decoded });
            resolvedAnalysis = toCachedAnalysis(res);
            writeCachedAnalysis(sourceId, resolvedAnalysis);
          }

          const newTrack = buildTrackFromAnalysis({
            title: file.name.replace(/\.[^/.]+$/, ""),
            artist: 'Unknown Artist',
            sourceId,
            fileBlob: file,
            artworkUrl,
            createdAt: Date.now(),
          }, resolvedAnalysis);

          const id = await db.tracks.add(newTrack);
          newTrack.id = id;

          set(state => ({
            tracks: dedupeVisibleTracks([newTrack, ...state.tracks])
          }));
          successCount++;
        } catch (err) {
            console.error(`Failed to ingest ${file.name}:`, err);
        } finally {
            pendingTrackKeys.delete(sourceId);
        }
        await yieldToUi();
    }

    set({ isProcessingQueue: false, queueProgress: '' });
    if (successCount > 0) {
      broadcastLibraryRefresh();
    }
    toast.success(`Successfully imported ${successCount} tracks.`);
  },

  seedLibrary: async () => {
    if (isSeeding) return;
    isSeeding = true;

    const seedTracks = PIKO_VAULT_TRACKS;

    const existingSeededTracks = await db.tracks
      .where('audioUrl')
      .anyOf(seedTracks.map(t => t.url))
      .toArray();
    const existingByUrl = new Map(existingSeededTracks.filter(t => t.audioUrl).map(t => [t.audioUrl as string, t]));

    // Backfill missing artwork on existing seeded tracks
    const toBackfill = existingSeededTracks.filter(t => !t.artworkUrl);
    if (toBackfill.length > 0) {
      await db.transaction('rw', db.tracks, async () => {
        for (const t of toBackfill) {
          if (!t.id) continue;
          const artworkUrl = pickRandomArtworkUrl();
          await db.tracks.update(t.id, { artworkUrl });
        }
      });
    }

    for (const track of seedTracks) {
      if (existingByUrl.has(track.url)) continue;

      const tempId = track.id + Date.now();
      set(state => ({
        processingTracks: [...state.processingTracks, { id: tempId, name: track.title }]
      }));

      try {
        const sourceId = getCloudSourceId(track);
        const cachedAnalysis = readCachedAnalysis(sourceId);
        const analysis =
          cachedAnalysis ??
          (await (async () => {
            const arrayBuffer = await fetchArrayBufferStrict(track.url);
            const decoded = await decodeToMonoChannelData(arrayBuffer);
            const res = await analyzeAudio({ id: track.id, ...decoded });
            const built = toCachedAnalysis(res);
            writeCachedAnalysis(sourceId, built);
            return built;
          })());

        const title = track.title;
        const artist = track.artist || 'Piko Vault';

        const newTrack: Track = {
          sourceId,
          title,
          artist,
          bpm: analysis.bpm,
          key: '--',
          duration: analysis.duration,
          energy: "Medium",
          hasVocal: false,
          audioUrl: track.url,
          artworkUrl: pickRandomArtworkUrl(),
          ...(analysis.beatGrid ? { beatGrid: analysis.beatGrid } : {}),
          createdAt: Date.now(),
        };

        const id = await db.tracks.add(newTrack);
        newTrack.id = id;

        set(state => ({
          tracks: dedupeVisibleTracks([...state.tracks, newTrack].sort((a, b) => b.createdAt - a.createdAt))
        }));
      } catch (error) {
        console.error(`Failed to seed ${track.title}`, error);
      } finally {
        set(state => ({
          processingTracks: state.processingTracks.filter(t => t.id !== tempId)
        }));
      }
    }
    isSeeding = false;

    // Reload to reflect any inserts/backfills
    await get().loadTracks();
    broadcastLibraryRefresh();
  },

  loadPikoVault: async (cloudTracks?: ReadonlyArray<VaultTrack>) => {
    if (get().isProcessingQueue) {
      toast.error('A queue is already processing. Please wait.');
      return;
    }

    // When called without an explicit list, merge the hardcoded vault tracks
    // with any newly uploaded tracks fetched from the R2 library.json manifest.
    if (!cloudTracks) {
      const manifestTracks = await fetchManifestTracks();
      const existingUrls = new Set<string>(PIKO_VAULT_TRACKS.map((t) => t.url));
      const newManifestTracks = manifestTracks.filter((t) => !existingUrls.has(t.url));
      cloudTracks = (Array.from(PIKO_VAULT_TRACKS) as VaultTrack[]).concat(newManifestTracks);
    }

    if (cloudTracks.length === 0) {
      toast.error('No cloud tracks supplied.');
      return;
    }

    const existingTracks = get().tracks;
    const existingPersistedTracks = await db.tracks.where('audioUrl').anyOf(cloudTracks.map((track) => track.url)).toArray();
    const existingTrackIndex = dedupeVisibleTracks([...existingTracks, ...existingPersistedTracks]);
    pendingTrackKeys.clear();

    const tracksToLoad = cloudTracks.filter((track) => {
      const sourceId = getCloudSourceId(track);
      return !existingTrackIndex.some((existing) => trackIdentityMatches(existing, { sourceId, audioUrl: track.url }));
    });

    set({
      isVaultSyncActive: true,
      vaultReadyCount: countVaultReadyTracks(existingTrackIndex, cloudTracks),
      vaultTotalCount: cloudTracks.length,
    });

    if (tracksToLoad.length === 0) {
      toast('Piko Vault is already fully synced.');
      set({
        processingTracks: [],
        isVaultSyncActive: false,
      });
      return;
    }

    set({
      isProcessingQueue: true,
      queueProgress: `Fetching ${tracksToLoad.length} cloud track(s)...`,
      processingTracks: [],
    });

    let successCount = 0;

    for (let i = 0; i < tracksToLoad.length; i++) {
      const track = tracksToLoad[i];
      const sourceId = getCloudSourceId(track);
      if (pendingTrackKeys.has(sourceId)) continue;
      pendingTrackKeys.add(sourceId);
      const tempId = `${track.id}-${Date.now()}`;
      set(state => ({
        processingTracks: [...state.processingTracks, { id: tempId, name: track.title }]
      }));

      try {
        const cachedAnalysis = readCachedAnalysis(sourceId);
        let analysis = cachedAnalysis;

        if (!analysis) {
          set({ queueProgress: `Downloading & analyzing ${i + 1} of ${tracksToLoad.length}: ${track.title}` });
          const arrayBuffer = await fetchArrayBufferStrict(track.url);
          const decoded = await decodeToMonoChannelData(arrayBuffer);
          const res = await analyzeAudio({ id: track.id, ...decoded });
          analysis = toCachedAnalysis(res);
          writeCachedAnalysis(sourceId, analysis);
        } else {
          set({ queueProgress: `Syncing ${i + 1} of ${tracksToLoad.length}: ${track.title}` });
        }

        const newTrack = buildTrackFromAnalysis({
          sourceId,
          title: track.title,
          artist: track.artist || 'Unknown Artist',
          audioUrl: track.url,
          artworkUrl: pickRandomArtworkUrl(),
          createdAt: Date.now(),
        }, analysis);

        const id = await db.tracks.add(newTrack);
        newTrack.id = id;

        set(state => ({
          tracks: dedupeVisibleTracks([newTrack, ...state.tracks]),
          vaultReadyCount: Math.min(state.vaultReadyCount + 1, cloudTracks.length),
        }));
        successCount++;
      } catch (error) {
        console.error(`Failed to ingest cloud track ${track.title}:`, error);
        toast.error(`Failed to ingest ${track.title}`);
      } finally {
        pendingTrackKeys.delete(sourceId);
        set(state => ({
          processingTracks: state.processingTracks.filter(t => t.id !== tempId)
        }));
        await yieldToUi();
      }
    }

    const refreshedTracks = dedupeVisibleTracks(await db.tracks.orderBy('createdAt').reverse().toArray());
    set({
      isProcessingQueue: false,
      queueProgress: '',
      isVaultSyncActive: false,
      tracks: refreshedTracks,
      vaultReadyCount: countVaultReadyTracks(refreshedTracks, cloudTracks),
      vaultTotalCount: cloudTracks.length,
    });
    if (successCount > 0) {
      broadcastLibraryRefresh();
      toast.success(`Imported ${successCount} cloud track${successCount > 1 ? 's' : ''}.`);
    }
  },

  addTrack: async (file: File) => {
    const sourceId = getFileSourceId(file);
    const duplicateInState = get().tracks.some((track) =>
      trackIdentityMatches(track, { sourceId, audioUrl: track.audioUrl })
    );
    if (duplicateInState) return;

    await get().queueFilesForIngestion([file]);
  },

  fetchLibrary: async () => {
    try {
      // Load existing tracks from IndexedDB first
      await get().loadTracks();
      
      // Then load/sync vault tracks (merges PIKO_VAULT_TRACKS with manifest)
      await get().loadPikoVault();
    } catch (error) {
      console.error('Failed to load library:', error);
      toast.error('Failed to load library. Please refresh the page.');
    }
  }
}));
