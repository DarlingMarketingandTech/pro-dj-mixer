import Dexie, { Table } from 'dexie';

export interface HistoryItem {
  id?: number;
  trackId: number;
  deckId: 'A' | 'B';
  playedAt: number;
}

export interface Crate {
  id?: number;
  name: string;
  createdAt: number;
}

export interface CrateTrack {
  id?: number;
  crateId: number;
  trackId: number;
  createdAt: number;
}

export interface CuePoint {
  id?: number;
  trackId?: number;
  slot: number; // 1-8
  time: number; // seconds
  type: 'hot' | 'memory';
  label?: string;
  color?: string;
  updatedAt: number;
}

/** Constant-tempo beat grid from lib/beatGrid.ts. Stored unindexed, so no schema version bump. */
export interface TrackBeatGrid {
  bpm: number;
  firstBeatSec: number;
  confidence: number;
  version: number;
}

export interface Track {
  id?: number;
  sourceId?: string;
  sourceType?: 'local' | 'r2' | 'custom-storage' | 'external';
  provider?: 'r2' | 'custom-s3' | 'youtube' | 'soundcloud' | 'custom' | 'local';
  externalId?: string;
  streamUrl?: string;
  storageKey?: string;
  licenseStatus?: 'owned' | 'licensed' | 'user-upload' | 'unknown';
  title: string;
  artist: string;
  bpm: string;
  key: string;
  duration: string;
  energy: string;
  hasVocal: boolean;
  fileBlob?: Blob;
  audioUrl?: string;
  artworkUrl?: string;
  overviewWaveform?: number[];
  beatGrid?: TrackBeatGrid;
  createdAt: number;
}

export class DJDatabase extends Dexie {
  tracks!: Table<Track, number>;
  cuePoints!: Table<CuePoint, number>;
  crates!: Table<Crate, number>;
  crateTracks!: Table<CrateTrack, number>;
  history!: Table<HistoryItem, number>;

  constructor() {
    super('DJDatabase');
    this.version(2).stores({
      tracks: '++id, title, artist, bpm, key, createdAt, audioUrl, artworkUrl'
    });
    this.version(3).stores({
      tracks: '++id, title, artist, bpm, key, createdAt, audioUrl, artworkUrl',
      cuePoints: '++id, trackId, [trackId+slot]'
    });
    this.version(4).stores({
      tracks: '++id, title, artist, bpm, key, createdAt, audioUrl, artworkUrl',
      cuePoints: '++id, trackId, [trackId+slot]',
      crates: '++id, &name, createdAt',
      crateTracks: '++id, crateId, trackId, [crateId+trackId]'
    });
    this.version(5).stores({
      tracks: '++id, title, artist, bpm, key, createdAt, audioUrl, artworkUrl',
      cuePoints: '++id, trackId, [trackId+slot]',
      crates: '++id, &name, createdAt',
      crateTracks: '++id, crateId, trackId, [crateId+trackId]',
      history: '++id, trackId, playedAt'
    });
    this.version(6).stores({
      tracks: '++id, sourceId, sourceType, provider, externalId, title, artist, bpm, key, createdAt, audioUrl, artworkUrl, storageKey, licenseStatus',
      cuePoints: '++id, trackId, [trackId+slot]',
      crates: '++id, &name, createdAt',
      crateTracks: '++id, crateId, trackId, [crateId+trackId]',
      history: '++id, trackId, playedAt'
    });
  }
}

export const db = new DJDatabase();
