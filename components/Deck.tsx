'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useDeckStore, getDeckBpm } from '@/store/deckStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useUIStore } from '@/store/uiStore';
import { useTrackCueStore } from '@/store/trackCueStore';
import { useDeckAudio } from '@/hooks/useDeckAudio';
import { usePerformanceFX } from '@/hooks/usePerformanceFX';
import { usePerformanceKeys } from '@/hooks/usePerformanceKeys';
import { PerformancePads } from '@/components/deck/PerformancePads';
import { FXRack } from '@/components/deck/FXRack';
import { AudioEngine } from '@/lib/audioEngine';
import { beatPeriodSec, effectiveBpm, isLowConfidenceGrid, quantizedLoopStart, type BeatGrid } from '@/lib/beatGrid';
import type { Track } from '@/lib/db';
import { broadcastCue } from '@/lib/syncManager';
import { getCueTrackHash } from '@/store/trackCueStore';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Music2, FolderOpen, RotateCcw, Mic2, Drum, Guitar, Volume2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

// ── Type guard ────────────────────────────────────────────────────────────────
const isTrackPayload = (value: unknown): value is Track => {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<Track>;
  return typeof c.title === 'string' && typeof c.artist === 'string' && typeof c.bpm === 'string';
};

interface DeckProps { deckId: 'A' | 'B'; compact?: boolean; }
interface DeckTheme { primary: string; secondary: string; primaryRgb: string; }

const DEFAULT_DECK_THEME: Record<'A' | 'B', DeckTheme> = {
  A: { primary: '#D4AF37', secondary: '#F59E0B', primaryRgb: '212,175,55' },
  B: { primary: '#E11D48', secondary: '#FB7185', primaryRgb: '225,29,72' },
};

const rgbToHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map(n => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')).join('')}`;

const extractThemeFromArtwork = (image: HTMLImageElement): DeckTheme | null => {
  const canvas = document.createElement('canvas');
  canvas.width = 60; canvas.height = 60;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, 60, 60);
  const data = ctx.getImageData(0, 0, 60, 60).data;
  let totalR = 0, totalG = 0, totalB = 0, count = 0, bestSat = -1;
  let accent = { r: 212, g: 175, b: 55 };
  for (let i = 0; i < data.length; i += 16) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 120) continue;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (lum < 24 || lum > 235) continue;
    totalR += r; totalG += g; totalB += b; count += 1;
    if (sat > bestSat && lum > 40 && lum < 210) { bestSat = sat; accent = { r, g, b }; }
  }
  if (count === 0) return null;
  const bR = totalR / count, bG = totalG / count, bB = totalB / count;
  const boost = { r: Math.min(255, bR * 1.12 + 12), g: Math.min(255, bG * 1.12 + 12), b: Math.min(255, bB * 1.12 + 12) };
  return {
    primary: rgbToHex(boost.r, boost.g, boost.b),
    secondary: rgbToHex(accent.r, accent.g, accent.b),
    primaryRgb: `${Math.round(boost.r)},${Math.round(boost.g)},${Math.round(boost.b)}`,
  };
};

const PLATTER_REV_S = 1.8;

// ─── Quick Track Picker ───────────────────────────────────────────────────────
function TrackPicker({ deckId, deckTheme, onClose }: { deckId: 'A' | 'B'; deckTheme: DeckTheme; onClose: () => void }) {
  const { tracks, loadTracks } = useLibraryStore(useShallow(s => ({ tracks: s.tracks, loadTracks: s.loadTracks })));
  const loadTrack = useDeckStore(s => s.loadTrack);
  const setIsLibraryOverlayOpen = useUIStore(s => s.setIsLibraryOverlayOpen);
  const [q, setQ] = useState('');
  // The library list is otherwise only read when the Library view mounts, so read it here too
  // (IndexedDB only, no downloads) or the picker shows an empty list on a fresh page.
  const [isReadingLibrary, setIsReadingLibrary] = useState(tracks.length === 0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // On touch screens focusing would pop the keyboard up over the list.
    if (window.matchMedia('(pointer: fine)').matches) inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isReadingLibrary) return;
    void loadTracks().finally(() => setIsReadingLibrary(false));
  }, [isReadingLibrary, loadTracks]);

  const openVault = useCallback(() => {
    onClose();
    setIsLibraryOverlayOpen(true);
  }, [onClose, setIsLibraryOverlayOpen]);

  const filtered = useMemo(() => {
    if (!q.trim()) return tracks.slice(0, 20);
    const lo = q.toLowerCase();
    return tracks.filter(t => t.title?.toLowerCase().includes(lo) || t.artist?.toLowerCase().includes(lo)).slice(0, 20);
  }, [tracks, q]);

  const load = useCallback((track: Track) => {
    void loadTrack(deckId, track);
    onClose();
  }, [deckId, loadTrack, onClose]);

  // Close on Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0, y: -8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.97 }}
      transition={{ duration: 0.15 }}
      className="absolute inset-x-0 top-full mt-1 z-[100] rounded-2xl border border-white/10 bg-[#0a0a12]/97 backdrop-blur-2xl shadow-2xl overflow-hidden"
      style={{ boxShadow: `0 20px 60px rgba(0,0,0,0.8), 0 0 0 1px rgba(${deckTheme.primaryRgb},0.2)` }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 pt-2.5">
        <span className="text-[10px] font-black uppercase tracking-widest" style={{ color: deckTheme.primary }}>
          Choose a track for Deck {deckId}
        </span>
        <button type="button" onClick={onClose} className="text-white/40 hover:text-white text-[10px] font-bold px-2 py-1 -mr-1 rounded">
          CLOSE
        </button>
      </div>
      <div className="flex items-center gap-2 mx-3 my-2 px-2.5 py-2 rounded-xl border border-white/10 bg-white/5">
        <Search className="w-3.5 h-3.5 text-white/30 flex-shrink-0" />
        <input
          ref={inputRef}
          type="search"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search title or artist"
          className="flex-1 min-w-0 bg-transparent text-sm text-white placeholder:text-white/30 focus:outline-none"
        />
      </div>

      {/* Track list */}
      <div className="max-h-64 overflow-y-auto border-t border-white/8">
        {isReadingLibrary && tracks.length === 0 ? (
          <div className="px-4 py-6 text-white/40 text-xs">Loading your library…</div>
        ) : tracks.length === 0 ? (
          <div className="flex flex-col items-start gap-3 px-4 py-5">
            <div className="flex items-center gap-2 text-white/70 text-xs font-semibold">
              <Music2 className="w-4 h-4" /> Your library is empty
            </div>
            <p className="text-[11px] leading-relaxed text-white/45">
              Open the Vault to get the free tracks or add music from your device. They will show up here.
            </p>
            <button
              type="button"
              onClick={openVault}
              className="rounded-full px-4 py-2 text-[11px] font-black uppercase tracking-widest text-black"
              style={{ background: `linear-gradient(135deg,${deckTheme.primary},${deckTheme.secondary})` }}
            >
              Open Vault
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center gap-2 px-4 py-6 text-white/40 text-xs">
            <Music2 className="w-4 h-4" /> No tracks match &ldquo;{q.trim()}&rdquo;
          </div>
        ) : (
          filtered.map(track => (
            <button
              key={track.id}
              type="button"
              onClick={() => load(track)}
              className="flex items-center gap-2.5 w-full min-h-12 px-3 py-2 text-left hover:bg-white/8 active:bg-white/10 transition-colors border-b border-white/4 last:border-0"
            >
              <div
                className="w-7 h-7 rounded flex-shrink-0 border border-white/10"
                style={{ background: track.artworkUrl ? `url(${track.artworkUrl}) center/cover` : 'linear-gradient(135deg,#1e293b,#0f172a)' }}
              />
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-semibold text-white/90 truncate">{track.title}</div>
                <div className="text-[9px] text-white/35 truncate">{track.artist}</div>
              </div>
              {/* Always visible: a touch screen has no hover. */}
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-[10px] font-mono text-white/40">{track.bpm || '--'} BPM</span>
                <span
                  className="text-[9px] font-black px-2 py-1 rounded-full border"
                  style={{ color: deckTheme.primary, borderColor: `rgba(${deckTheme.primaryRgb},0.4)` }}
                >
                  LOAD
                </span>
              </div>
            </button>
          ))
        )}
      </div>

      <div className="px-3 py-2 border-t border-white/5 flex items-center justify-between gap-2">
        <span className="text-[9px] text-white/30 pointer-coarse:hidden">Or drag a track from the library onto this deck</span>
        <button type="button" onClick={openVault} className="ml-auto text-[10px] font-bold text-white/50 hover:text-white">
          Browse the Vault →
        </button>
      </div>
    </motion.div>
  );
}

// ─── Jog Wheel ────────────────────────────────────────────────────────────────
function JogWheel({
  deckId, isPlaying, track, currentTime, deckTheme, onScrub, onScrubEnd, compact, vinylMode,
}: {
  deckId: 'A' | 'B'; isPlaying: boolean; track: Track | null; currentTime: number;
  deckTheme: DeckTheme; onScrub: (delta: number) => void; onScrubEnd: () => void;
  compact?: boolean; vinylMode: boolean;
}) {
  const wheelRef = useRef<HTMLDivElement>(null);
  const platterRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const lastAngle = useRef(0);
  const lastMoveTime = useRef(0);
  const lastDelta = useRef(0);
  const currentTimeRef = useRef(currentTime);
  const scratchOffset = useRef(0);

  useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);

  useEffect(() => {
    let raf: number;
    const tick = () => {
      const deg = (currentTimeRef.current / PLATTER_REV_S) * 360;
      if (platterRef.current) platterRef.current.style.transform = `rotate(${deg + scratchOffset.current}deg)`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const getAngle = (e: React.PointerEvent | PointerEvent) => {
    if (!wheelRef.current) return 0;
    const { left, top, width, height } = wheelRef.current.getBoundingClientRect();
    return Math.atan2(e.clientY - (top + height / 2), e.clientX - (left + width / 2)) * (180 / Math.PI);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    isDragging.current = true;
    lastAngle.current = getAngle(e);
    lastMoveTime.current = performance.now();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current) return;
    const angle = getAngle(e);
    let delta = angle - lastAngle.current;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    scratchOffset.current += delta;
    lastAngle.current = angle;
    const now = performance.now();
    lastDelta.current = delta / Math.max(1, now - lastMoveTime.current);
    lastMoveTime.current = now;
    if (vinylMode) {
      onScrub((delta / 360) * PLATTER_REV_S);
    } else {
      onScrub(delta * 0.001); // Nudge: small pitch bend
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    isDragging.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const velocity = lastDelta.current;
    const start = performance.now();
    const brake = () => {
      const t = Math.min(1, (performance.now() - start) / 200);
      scratchOffset.current += velocity * (1 - t) * 5;
      if (t < 1) requestAnimationFrame(brake);
      else onScrubEnd();
    };
    requestAnimationFrame(brake);
  };

  const size = compact ? 'h-32 w-32' : 'h-44 w-44 lg:h-52 lg:w-52';

  return (
    <div
      ref={wheelRef}
      className={`${size} relative rounded-full cursor-grab active:cursor-grabbing select-none touch-none flex-shrink-0`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{ boxShadow: `0 0 40px rgba(${deckTheme.primaryRgb},0.2), inset 0 2px 8px rgba(0,0,0,0.8)` }}
    >
      <div className="absolute inset-0 rounded-full border-2" style={{ borderColor: `rgba(${deckTheme.primaryRgb},0.5)`, background: 'radial-gradient(circle,rgba(255,255,255,0.03),rgba(8,8,8,0.97) 60%)' }} />
      <div
        ref={platterRef}
        className="absolute inset-[10%] rounded-full"
        style={{
          background: track?.artworkUrl
            ? `radial-gradient(circle at 30% 30%,rgba(255,255,255,0.2),transparent 28%),url(${track.artworkUrl}) center/cover`
            : `radial-gradient(circle at 30% 30%,rgba(255,255,255,0.15),transparent 28%),repeating-radial-gradient(circle,rgba(255,255,255,0.03) 0px,rgba(0,0,0,0.5) 3px,rgba(0,0,0,0.8) 6px)`,
        }}
      >
        <div className="absolute inset-[22%] rounded-full border border-white/5" />
        <div className="absolute inset-[40%] rounded-full border border-white/20" style={{ background: `radial-gradient(circle,rgba(${deckTheme.primaryRgb},0.4),#000)` }} />
        <div className="absolute inset-[47%] rounded-full bg-white/80" />
        <div className="absolute left-1/2 top-[8%] h-[16%] w-[3px] -translate-x-1/2 rounded-full" style={{ background: `rgba(${deckTheme.primaryRgb},0.7)` }} />
      </div>
      {isPlaying && (
        <div className="absolute inset-0 rounded-full pointer-events-none" style={{ boxShadow: `0 0 20px rgba(${deckTheme.primaryRgb},0.35), inset 0 0 16px rgba(${deckTheme.primaryRgb},0.08)` }} />
      )}
      {/* Vinyl/Nudge mode indicator */}
      <div className="absolute top-1 right-1" title={vinylMode ? 'Vinyl (scratch)' : 'Nudge (pitch bend)'}>
        <div className={clsx('w-1.5 h-1.5 rounded-full', vinylMode ? 'bg-orange-400' : 'bg-blue-400')} />
      </div>
    </div>
  );
}

// ─── Pitch Fader ─────────────────────────────────────────────────────────────
function PitchStrip({ value, onChange, deckTheme, compact }: { value: number; onChange: (v: number) => void; deckTheme: DeckTheme; compact?: boolean; }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const getVal = (clientY: number) => {
    if (!trackRef.current) return value;
    const r = trackRef.current.getBoundingClientRect();
    return Math.max(-8, Math.min(8, ((r.bottom - clientY) / r.height * 2 - 1) * 8));
  };
  const onDown = (e: React.PointerEvent) => { dragging.current = true; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); onChange(getVal(e.clientY)); };
  const onMove = (e: React.PointerEvent) => { if (dragging.current) onChange(getVal(e.clientY)); };
  const onUp = () => { dragging.current = false; };
  const thumbPct = ((value + 8) / 16) * 100;
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[8px] uppercase tracking-widest text-white/30">PITCH</span>
      <div
        ref={trackRef}
        className={`${compact ? 'h-20' : 'h-28'} w-4 rounded-full border border-white/10 bg-black/60 relative cursor-pointer`}
        style={{ boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.8)' }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onDoubleClick={() => onChange(0)}
      >
        <div className="absolute left-0 right-0 top-1/2 h-px bg-white/20" />
        <div
          className="absolute left-0 right-0 h-4 rounded-sm flex items-center justify-center"
          style={{
            bottom: `${thumbPct}%`, transform: 'translateY(50%)',
            background: value === 0 ? 'linear-gradient(135deg,#d4d4d4,#888)' : `linear-gradient(135deg,${deckTheme.primary},${deckTheme.secondary})`,
            boxShadow: `0 0 6px rgba(${deckTheme.primaryRgb},0.4)`,
          }}
        >
          <div className="w-3 h-px bg-black/50" />
        </div>
      </div>
      <span className="text-[9px] font-mono font-bold" style={{ color: value === 0 ? 'rgba(255,255,255,0.25)' : `rgb(${deckTheme.primaryRgb})` }}>
        {value >= 0 ? '+' : ''}{value.toFixed(1)}%
      </span>
    </div>
  );
}

// ─── Volume Knob ─────────────────────────────────────────────────────────────
function VolumeKnob({ value, onChange, deckTheme }: { value: number; onChange: (v: number) => void; deckTheme: DeckTheme }) {
  const startY = useRef(0);
  const startVal = useRef(value);
  const dragging = useRef(false);
  const angleDeg = -135 + value * 270;
  const onDown = (e: React.PointerEvent) => { dragging.current = true; startY.current = e.clientY; startVal.current = value; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); };
  const onMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const delta = (startY.current - e.clientY) / 100;
    onChange(Math.max(0, Math.min(1, startVal.current + delta)));
  };
  const onUp = () => { dragging.current = false; };
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div
        className="w-8 h-8 rounded-full cursor-pointer relative flex items-center justify-center"
        style={{ background: 'radial-gradient(circle,#2a2a3a,#111)', border: `1.5px solid rgba(${deckTheme.primaryRgb},0.3)`, boxShadow: `0 0 8px rgba(${deckTheme.primaryRgb},0.2)` }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onDoubleClick={() => onChange(1)}
      >
        <div
          className="absolute w-1 h-3 rounded-full bottom-1/2 left-1/2"
          style={{ transformOrigin: 'bottom center', transform: `translateX(-50%) rotate(${angleDeg}deg)`, background: value > 0.9 ? `rgb(${deckTheme.primaryRgb})` : 'rgba(255,255,255,0.7)' }}
        />
      </div>
      <span className="text-[8px] text-white/25 uppercase tracking-widest">VOL</span>
    </div>
  );
}

// ─── Loop Controls ────────────────────────────────────────────────────────────
function LoopControls({
  deckTheme, isPlaying, currentTime, duration, loopActive, loopIn, loopOut,
  onSetLoopIn, onSetLoopOut, onToggleLoop, onLoopSize,
}: {
  deckTheme: DeckTheme; isPlaying: boolean; currentTime: number; duration: number;
  loopActive: boolean; loopIn: number | null; loopOut: number | null;
  onSetLoopIn: () => void; onSetLoopOut: () => void;
  onToggleLoop: () => void; onLoopSize: (bars: number) => void;
}) {
  const loopSizes = [1, 2, 4, 8, 16];
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[8px] uppercase tracking-widest text-white/25 text-center">LOOP</span>
      {/* Quick loop size buttons */}
      <div className="flex items-center gap-0.5">
        {loopSizes.map(bars => (
          <button
            key={bars}
            type="button"
            onClick={() => onLoopSize(bars)}
            className="flex-1 py-1 rounded text-[8px] font-black font-mono transition-all"
            style={{ background: `rgba(${deckTheme.primaryRgb},0.06)`, color: 'rgba(255,255,255,0.35)' }}
            onMouseOver={e => { (e.currentTarget as HTMLElement).style.background = `rgba(${deckTheme.primaryRgb},0.2)`; (e.currentTarget as HTMLElement).style.color = deckTheme.primary; }}
            onMouseOut={e => { (e.currentTarget as HTMLElement).style.background = `rgba(${deckTheme.primaryRgb},0.06)`; (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.35)'; }}
          >
            {bars}
          </button>
        ))}
      </div>
      {/* IN / LOOP / OUT */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onSetLoopIn}
          className={clsx('flex-1 py-1.5 rounded text-[9px] font-black transition-all border', loopIn !== null ? 'text-black' : 'border-white/15 text-white/40 hover:text-white bg-black/30')}
          style={loopIn !== null ? { background: deckTheme.primary, borderColor: deckTheme.primary } : {}}
        >
          IN
        </button>
        <button
          type="button"
          onClick={onToggleLoop}
          className={clsx('flex-1 py-1.5 rounded text-[9px] font-black transition-all border', loopActive ? 'text-black' : 'border-white/15 text-white/40 hover:text-white bg-black/30')}
          style={loopActive ? { background: `linear-gradient(135deg,${deckTheme.primary},${deckTheme.secondary})`, borderColor: deckTheme.primary, boxShadow: `0 0 10px rgba(${deckTheme.primaryRgb},0.4)` } : {}}
        >
          LOOP
        </button>
        <button
          type="button"
          onClick={onSetLoopOut}
          className={clsx('flex-1 py-1.5 rounded text-[9px] font-black transition-all border', loopOut !== null ? 'text-black' : 'border-white/15 text-white/40 hover:text-white bg-black/30')}
          style={loopOut !== null ? { background: deckTheme.secondary, borderColor: deckTheme.secondary } : {}}
        >
          OUT
        </button>
      </div>
    </div>
  );
}

// ─── Stem Controls ────────────────────────────────────────────────────────────
function StemControls({ deckId, deckTheme, stems, onToggle }: {
  deckId: 'A' | 'B'; deckTheme: DeckTheme;
  stems: { vocals: boolean; drums: boolean; inst: boolean };
  onToggle: (stem: 'vocals' | 'drums' | 'inst') => void;
}) {
  const stemDefs: { key: 'vocals' | 'drums' | 'inst'; label: string; icon: React.ReactNode }[] = [
    { key: 'vocals', label: 'VOC', icon: <Mic2 className="w-3 h-3" /> },
    { key: 'drums', label: 'DRM', icon: <Drum className="w-3 h-3" /> },
    { key: 'inst', label: 'INST', icon: <Guitar className="w-3 h-3" /> },
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[8px] uppercase tracking-widest text-white/25 text-center">STEMS</span>
      <div className="flex items-center gap-1">
        {stemDefs.map(({ key, label, icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => onToggle(key)}
            className={clsx('flex-1 flex flex-col items-center gap-0.5 py-1.5 rounded border text-[8px] font-black transition-all')}
            style={stems[key]
              ? { background: `rgba(${deckTheme.primaryRgb},0.15)`, borderColor: `rgba(${deckTheme.primaryRgb},0.5)`, color: deckTheme.primary }
              : { background: 'rgba(0,0,0,0.5)', borderColor: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.25)' }}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Toggle Pill ──────────────────────────────────────────────────────────────
function DeckToggle({ label, active, on, off, onClick, deckTheme }: { label: string; active: boolean; on?: string; off?: string; onClick: () => void; deckTheme: DeckTheme }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-0.5"
    >
      <span className="text-[7px] uppercase tracking-widest text-white/20">{label}</span>
      <span
        className="px-2 py-0.5 rounded text-[9px] font-black border transition-all"
        style={active
          ? { background: `rgba(${deckTheme.primaryRgb},0.2)`, borderColor: `rgba(${deckTheme.primaryRgb},0.5)`, color: deckTheme.primary }
          : { background: 'rgba(0,0,0,0.4)', borderColor: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.25)' }}
      >
        {active ? (on ?? 'ON') : (off ?? 'OFF')}
      </span>
    </button>
  );
}

// ─── Main Deck ────────────────────────────────────────────────────────────────
export function Deck({ deckId, compact = false }: Readonly<DeckProps>) {
  const loadTrackStore = useDeckStore(s => s.loadTrack);
  const setPitch = useDeckStore(s => s.setPitch);
  const toggleSync = useDeckStore(s => s.toggleSync);
  const toggleKeyLock = useDeckStore(s => s.toggleKeyLock);
  const toggleStem = useDeckStore(s => s.toggleStem);
  const setVolume = useDeckStore(s => s.setVolume);

  const sync = useDeckStore(s => deckId === 'A' ? s.deckA.sync : s.deckB.sync);
  const keyLock = useDeckStore(s => deckId === 'A' ? s.deckA.keyLock : s.deckB.keyLock);
  const keyLockSupported = useDeckStore(s => deckId === 'A' ? s.deckA.keyLockSupported : s.deckB.keyLockSupported);
  const pitchPercent = useDeckStore(s => deckId === 'A' ? s.deckA.pitchPercent : s.deckB.pitchPercent);
  const volume = useDeckStore(s => deckId === 'A' ? s.deckA.volume : s.deckB.volume);
  const stems = useDeckStore(useShallow(s => deckId === 'A' ? s.deckA.stems : s.deckB.stems));

  const { tracks } = useLibraryStore(useShallow(s => ({ tracks: s.tracks })));
  const { currentTime, duration, isPlaying, isLoading, track, togglePlay, scrubTrack, endScrub } = useDeckAudio(deckId);
  const { setCue, clearCue, loadCues, getCues } = useTrackCueStore();

  // Local state
  const deckBpm = useDeckStore(s => getDeckBpm(deckId === 'A' ? s.deckA : s.deckB));
  const beatGrid = useDeckStore(s => (deckId === 'A' ? s.deckA : s.deckB).beatGrid);
  const currentBpm = deckBpm || 120;
  // Analysed grid when available; tracks not analysed yet fall back to a grid anchored at 0:00.
  const grid = useMemo<BeatGrid>(
    () => beatGrid ? { bpm: beatGrid.bpm, firstBeatSec: beatGrid.firstBeatSec } : { bpm: currentBpm, firstBeatSec: 0 },
    [beatGrid, currentBpm],
  );
  const [isDragOver, setIsDragOver] = useState(false);
  const [isPerformanceOpen, setIsPerformanceOpen] = useState(false);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [deckTheme, setDeckTheme] = useState<DeckTheme>(DEFAULT_DECK_THEME[deckId]);
  const [vinylMode, setVinylMode] = useState(true);
  const [slipMode, setSlipMode] = useState(false);
  const [quantize, setQuantize] = useState(true);
  // Loop state
  const [loopIn, setLoopIn] = useState<number | null>(null);
  const [loopOut, setLoopOut] = useState<number | null>(null);
  const [loopActive, setLoopActive] = useState(false);
  const [loopBars, setLoopBars] = useState<number | null>(null);

  const pickerRef = useRef<HTMLDivElement>(null);

  const cuePoints = useMemo(() => track ? getCues(track) : [], [getCues, track]);

  useEffect(() => { if (track) void loadCues(track); }, [track, loadCues]);
  useEffect(() => { void AudioEngine.getInstance().createDeckFxBus(deckId); }, [deckId]);

  useEffect(() => {
    if (!track?.artworkUrl) {
      const t = setTimeout(() => setDeckTheme(DEFAULT_DECK_THEME[deckId]), 0);
      return () => clearTimeout(t);
    }
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { if (!cancelled) { const th = extractThemeFromArtwork(img); setDeckTheme(th ?? DEFAULT_DECK_THEME[deckId]); } };
    img.onerror = () => { if (!cancelled) setDeckTheme(DEFAULT_DECK_THEME[deckId]); };
    img.src = track.artworkUrl;
    return () => { cancelled = true; };
  }, [track?.artworkUrl, deckId]);

  // currentBpm is derived via useMemo above — no sync effect needed

  // Loop enforcement — seek back to loop-in point when we cross the loop-out boundary
  useEffect(() => {
    if (!loopActive || loopIn === null || loopOut === null || loopOut <= loopIn) return;
    if (currentTime >= loopOut) {
      // Use stutter to hard-seek to the loop-in point without pitch glitch
      const engine = AudioEngine.getInstance();
      engine.startStutter(deckId, loopIn);
    }
  }, [currentTime, loopActive, loopIn, loopOut, deckId]);

  // Close picker on outside click
  useEffect(() => {
    if (!isPickerOpen) return;
    const h = (e: MouseEvent) => { if (!pickerRef.current?.contains(e.target as Node)) setIsPickerOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [isPickerOpen]);

  const { padMode, setPadMode, handlePadHold, handlePadRelease, handleCueTimeHold, handleCueTimeRelease } = usePerformanceFX({
    deckId, track, cuePoints, bpm: currentBpm, setCue,
  });

  const clearCueSlot = useCallback(async (slot: number) => {
    if (!track) return;
    await clearCue(track, slot);
    broadcastCue(getCueTrackHash(track), { slot, time: 0, type: 'hot', timestamp: Date.now(), color: '#00FF00', name: `Cue ${slot}`, deleted: true });
  }, [track, clearCue]);

  const { shiftHeld, pressedSlots } = usePerformanceKeys({
    deckId,
    getCueTime: slot => cuePoints.find(c => c.slot === slot)?.time ?? null,
    startStutter: handleCueTimeHold,
    stopStutter: handleCueTimeRelease,
    clearCue: slot => { void clearCueSlot(slot); },
  });

  // Drag & drop handlers
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragOver(true); };
  const onDragLeave = () => setIsDragOver(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setIsDragOver(false);
    const json = e.dataTransfer.getData('application/json');
    if (json) {
      try {
        const dropped: unknown = JSON.parse(json);
        if (isTrackPayload(dropped)) { void loadTrackStore(deckId, dropped); }
      } catch {
        const id = e.dataTransfer.getData('text/plain');
        if (id) { const t = tracks.find(tr => tr.id === Number(id)); if (t) { void loadTrackStore(deckId, t); } }
      }
    }
  };

  // Loop helpers
  // Position-critical actions read the engine's transport clock (exact), not the throttled React state.
  const exactPosition = useCallback(() => AudioEngine.getInstance().getDeckPosition(deckId), [deckId]);
  const handleSetLoopIn = () => setLoopIn(exactPosition());
  const handleSetLoopOut = () => { setLoopOut(exactPosition()); if (loopIn !== null) setLoopActive(true); };
  const handleToggleLoop = () => setLoopActive(la => !la);
  const handleLoopSize = (bars: number) => {
    if (!track) return;
    const beats = bars * 4; // 4 beats per bar
    const loopLength = beats * beatPeriodSec(grid.bpm);
    const now = exactPosition();
    const startAt = quantize ? quantizedLoopStart(now, grid, beats) : now;
    setLoopIn(startAt);
    setLoopOut(startAt + loopLength);
    setLoopActive(true);
    setLoopBars(bars);
  };

  const handleBeatJump = useCallback((beats: number) => {
    if (!track) return;
    const bpm = currentBpm || 120;
    const beatDuration = 60 / bpm;
    const jumpSeconds = beats * beatDuration;
    const engine = AudioEngine.getInstance();
    engine.seekTo(deckId, engine.getDeckPosition(deckId) + jumpSeconds);
  }, [deckId, track, currentBpm]);

  const formatTime = (s: number) => {
    if (Number.isNaN(s) || s < 0) return '00:00';
    return `${Math.floor(s / 60).toString().padStart(2, '0')}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
  };

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  const pilBtn = (label: string, active: boolean, onClick: () => void, color?: string, disabled?: boolean) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={clsx('h-8 min-w-[48px] rounded-full border text-[9px] font-black tracking-widest uppercase transition-all px-2 disabled:opacity-30 disabled:cursor-not-allowed')}
      style={active
        ? { background: color ? `linear-gradient(135deg,${color},${deckTheme.secondary})` : `linear-gradient(135deg,${deckTheme.primary},${deckTheme.secondary})`, borderColor: deckTheme.primary, color: '#000', boxShadow: `0 0 12px rgba(${deckTheme.primaryRgb},0.45)` }
        : { background: 'rgba(0,0,0,0.4)', borderColor: 'rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.45)' }}
    >
      {label}
    </button>
  );

  const isLeft = deckId === 'A';

  return (
    <div
      className={clsx('w-full h-full flex flex-col gap-2 transition-colors', isDragOver && 'ring-2 ring-white/40 rounded-2xl bg-white/5')}
      onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
    >
      {/* ── Track Info + Quick Load ──────────────────────────────────────── */}
      <div className="relative pointer-events-auto" ref={pickerRef}>
        <div className="flex items-center gap-2 px-3 py-2 rounded-2xl bg-black/50 backdrop-blur-lg border border-white/10">
          {/* Artwork */}
          <div
            className="h-9 w-9 rounded-lg flex-shrink-0 border border-white/10 overflow-hidden cursor-pointer hover:scale-105 transition-transform"
            style={{ background: track?.artworkUrl ? `url(${track.artworkUrl}) center/cover` : `linear-gradient(135deg,${deckTheme.primary}30,${deckTheme.secondary}15)` }}
            onClick={() => setIsPickerOpen(!isPickerOpen)}
            title="Click to load a track"
          />
          {track ? (
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold truncate leading-tight" style={{ color: deckTheme.primary }}>{track.title}</p>
              <p className="text-[10px] text-white/35 truncate">{track.artist}</p>
            </div>
          ) : (
            <button type="button" onClick={() => setIsPickerOpen(!isPickerOpen)} className="min-w-0 flex-1 text-left">
              <p className="text-xs font-bold truncate leading-tight text-white/70">Deck {deckId} is empty</p>
              <p className="text-[10px] text-white/40 truncate">Tap LOAD to choose a track</p>
            </button>
          )}
          {/* BPM + Key */}
          <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
            <span
              className="text-sm font-mono font-black text-white leading-none"
              title={beatGrid && isLowConfidenceGrid(beatGrid) ? 'Approximate: this track may not hold one steady tempo, so the beat grid can drift' : undefined}
            >
              {track ? `${beatGrid && isLowConfidenceGrid(beatGrid) ? '~' : ''}${effectiveBpm(currentBpm, pitchPercent).toFixed(1)}${sync ? '⟳' : ''}` : '--'}
            </span>
            <span className="text-[9px] uppercase tracking-widest text-white/25">{track?.key ?? '--'}</span>
          </div>
          {/* Quick Load Button */}
          {/* Labelled LOAD while the deck is empty; just the folder icon once a track is loaded. */}
          <button
            type="button"
            onClick={() => setIsPickerOpen(!isPickerOpen)}
            className={clsx(
              'flex-shrink-0 h-8 rounded-full flex items-center justify-center gap-1.5 border transition-all',
              track ? 'w-8' : 'px-3 text-[10px] font-black tracking-widest',
              isPickerOpen
                ? 'border-yellow-500/50 bg-yellow-500/15 text-yellow-400'
                : track
                  ? 'border-white/10 bg-white/5 text-white/40 hover:text-white hover:border-white/20'
                  : 'text-black border-transparent'
            )}
            style={!track && !isPickerOpen ? { background: `linear-gradient(135deg,${deckTheme.primary},${deckTheme.secondary})` } : undefined}
            title="Choose a track for this deck"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            {!track && 'LOAD'}
          </button>
        </div>

        {/* Floating Track Picker */}
        <AnimatePresence>
          {isPickerOpen && (
            <TrackPicker deckId={deckId} deckTheme={deckTheme} onClose={() => setIsPickerOpen(false)} />
          )}
        </AnimatePresence>
      </div>

      {/* ── Progress Bar ─────────────────────────────────────────────────── */}
      <div className="px-3 pointer-events-auto">
        <div className="relative h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
          <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${progress * 100}%`, background: `linear-gradient(90deg,${deckTheme.primary},${deckTheme.secondary})`, boxShadow: `0 0 6px rgba(${deckTheme.primaryRgb},0.5)` }} />
          {/* Loop region overlay */}
          {loopActive && loopIn !== null && loopOut !== null && duration > 0 && (
            <div className="absolute inset-y-0 rounded-full opacity-50" style={{ left: `${(loopIn / duration) * 100}%`, width: `${((loopOut - loopIn) / duration) * 100}%`, background: `rgba(${deckTheme.primaryRgb},0.5)` }} />
          )}
          {cuePoints.map(cue => (
            <div key={cue.slot} className="absolute top-0 bottom-0 w-0.5" style={{ left: `${duration > 0 ? (cue.time / duration) * 100 : 0}%`, background: deckTheme.secondary }} />
          ))}
        </div>
        <div className="flex justify-between mt-0.5">
          <span className="text-[9px] font-mono text-white/25">{formatTime(currentTime)}</span>
          <span className="text-[9px] font-mono" style={{ color: track ? `rgba(${deckTheme.primaryRgb},0.7)` : 'rgba(255,255,255,0.2)' }}>-{formatTime(duration - currentTime)}</span>
        </div>
      </div>

      {/* ── Jog Wheel + Pitch + Volume ───────────────────────────────────── */}
      <div className={clsx('flex items-center justify-center gap-4 px-3', isLeft ? 'flex-row' : 'flex-row-reverse')}>
        <JogWheel
          deckId={deckId} isPlaying={isPlaying} track={track} currentTime={currentTime}
          deckTheme={deckTheme} onScrub={scrubTrack} onScrubEnd={endScrub}
          compact={compact} vinylMode={vinylMode}
        />
        <div className="flex flex-col items-center gap-3">
          <PitchStrip value={pitchPercent} onChange={v => setPitch(deckId, v)} deckTheme={deckTheme} compact={compact} />
          <VolumeKnob value={volume} onChange={v => setVolume(deckId, v)} deckTheme={deckTheme} />
        </div>
      </div>

      {/* ── Stem Controls ────────────────────────────────────────────────── */}
      <div className="px-3 pointer-events-auto">
        <StemControls deckId={deckId} deckTheme={deckTheme} stems={stems} onToggle={stem => toggleStem(deckId, stem)} />
      </div>

      <div className="px-3 pointer-events-auto">
        <BeatjumpControls onJump={handleBeatJump} />
      </div>

      {/* ── Loop Controls ────────────────────────────────────────────────── */}
      <div className="px-3 pointer-events-auto">
        <LoopControls
          deckTheme={deckTheme} isPlaying={isPlaying} currentTime={currentTime} duration={duration}
          loopActive={loopActive} loopIn={loopIn} loopOut={loopOut}
          onSetLoopIn={handleSetLoopIn} onSetLoopOut={handleSetLoopOut}
          onToggleLoop={handleToggleLoop} onLoopSize={handleLoopSize}
        />
      </div>

      {/* ── Transport Controls ───────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 px-3 pointer-events-auto">
        {/* CUE */}
        <button
          type="button"
          onClick={() => { if (!track) return; void setCue(track, 0, exactPosition(), 'hot', { color: deckTheme.primary, label: 'CUE' }); }}
          disabled={!track}
          className="h-11 w-14 rounded-full border-2 text-[11px] font-black uppercase tracking-widest transition-all disabled:opacity-30"
          style={{ borderColor: deckTheme.primary, color: deckTheme.primary, background: `rgba(${deckTheme.primaryRgb},0.07)` }}
          onMouseOver={e => { (e.currentTarget as HTMLElement).style.boxShadow = `0 0 14px rgba(${deckTheme.primaryRgb},0.4)`; }}
          onMouseOut={e => { (e.currentTarget as HTMLElement).style.boxShadow = 'none'; }}
        >
          CUE
        </button>

        {/* PLAY / PAUSE */}
        <button
          type="button"
          onClick={togglePlay}
          disabled={!track || isLoading}
          className="h-14 w-14 rounded-full flex items-center justify-center text-black transition-all disabled:opacity-30"
          style={{
            background: `linear-gradient(135deg,${deckTheme.primary},${deckTheme.secondary})`,
            boxShadow: isPlaying ? `0 0 28px rgba(${deckTheme.primaryRgb},0.7)` : `0 0 10px rgba(${deckTheme.primaryRgb},0.25)`,
          }}
        >
          {isLoading ? <span className="h-5 w-5 rounded-full border-2 border-black/40 border-t-black animate-spin block" /> :
           isPlaying ? <span className="flex gap-1"><span className="block h-5 w-1.5 bg-black rounded-sm" /><span className="block h-5 w-1.5 bg-black rounded-sm" /></span> :
           <svg className="w-6 h-6 ml-1" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>}
        </button>

        {/* SYNC */}
        <button
          type="button"
          onClick={() => toggleSync(deckId)}
          disabled={!track}
          className="h-11 w-14 rounded-full border-2 text-[11px] font-black uppercase tracking-widest transition-all disabled:opacity-30"
          style={sync
            ? { borderColor: '#22c55e', color: '#22c55e', background: 'rgba(34,197,94,0.12)', boxShadow: '0 0 14px rgba(34,197,94,0.4)' }
            : { borderColor: 'rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.35)', background: 'rgba(0,0,0,0.3)' }}
        >
          SYNC
        </button>
      </div>

      {/* ── Mode Toggles Row ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-around px-3 pointer-events-auto">
        <DeckToggle label="KEY" active={keyLock} on="LOCK" off="OFF" onClick={() => toggleKeyLock(deckId)} deckTheme={deckTheme} />
        <DeckToggle label="VINYL" active={vinylMode} on="SCRATCH" off="NUDGE" onClick={() => setVinylMode(v => !v)} deckTheme={deckTheme} />
        <DeckToggle label="SLIP" active={slipMode} on="ON" off="OFF" onClick={() => setSlipMode(s => !s)} deckTheme={deckTheme} />
        <DeckToggle label="QUANT" active={quantize} on="ON" off="OFF" onClick={() => setQuantize(q => !q)} deckTheme={deckTheme} />
      </div>

      {/* ── Collapsible Performance Section ─────────────────────────────── */}
      <div className="px-3 pointer-events-auto">
        <button
          type="button"
          onClick={() => setIsPerformanceOpen(!isPerformanceOpen)}
          className="w-full py-1.5 bg-black/40 backdrop-blur border border-white/8 rounded-lg text-center text-[9px] font-black uppercase tracking-widest text-white/30 hover:text-white transition-colors"
        >
          {isPerformanceOpen ? '▲ PADS & FX' : '▼ PADS & FX'}
        </button>
      </div>

      <AnimatePresence>
        {isPerformanceOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden px-3 space-y-2 pointer-events-auto"
          >
            <PerformancePads
              cuePoints={cuePoints} deckId={deckId} compact={compact}
              accentColor={deckTheme.primary} accentRgb={deckTheme.primaryRgb}
              padMode={padMode} onPadModeChange={setPadMode}
              shiftHeld={shiftHeld} pressedSlots={pressedSlots}
              onPadHold={(slot: number) => {
                if (padMode === 'hot') {
                  const cue = cuePoints.find(c => c.slot === slot);
                  if (cue) {
                    if (shiftHeld) {
                      void clearCueSlot(slot);
                    } else {
                      // Pass cueTime (not slot number) to stutter engine
                      handleCueTimeHold(cue.time, slot);
                    }
                  } else if (track) {
                    void setCue(track, slot, exactPosition(), 'hot', { color: deckTheme.primary, label: `Cue ${slot}` });
                  }
                } else {
                  handlePadHold(slot);
                }
              }}
              onPadRelease={(slot: number) => { if (padMode === 'hot') handleCueTimeRelease(slot); else handlePadRelease(slot); }}
              onClearCue={(slot: number) => void clearCueSlot(slot)}
              onAutoGenerate={() => {}}
            />
            <FXRack
              deckId={deckId} compact={compact}
              accentColor={deckTheme.primary} accentRgb={deckTheme.primaryRgb}
              secondaryColor={deckTheme.secondary}
              onFxChange={(type, val) => { AudioEngine.getInstance().setDeckFX(deckId, type, val); }}
              onStemFxSendChange={(stem, active) => { AudioEngine.getInstance().setStemFXSend(deckId, stem, active ? 1 : 0); }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function BeatjumpControls({ onJump }: { onJump: (beats: number) => void }) {
  const jumps = [1, 4, 8, 16];
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[8px] uppercase tracking-widest text-white/25 text-center">BEAT JUMP</span>
      <div className="flex items-center gap-1">
        <div className="flex flex-1 items-center gap-0.5">
          {[...jumps].reverse().map(beats => (
            <button
              key={`back-${beats}`}
              type="button"
              onClick={() => onJump(-beats)}
              className="flex-1 py-1 rounded text-[8px] font-black font-mono transition-all border border-white/5 bg-black/20 text-white/40 hover:text-studio-gold hover:border-studio-gold/30"
            >
              -{beats}
            </button>
          ))}
        </div>
        <div className="flex flex-1 items-center gap-0.5">
          {jumps.map(beats => (
            <button
              key={`fwd-${beats}`}
              type="button"
              onClick={() => onJump(beats)}
              className="flex-1 py-1 rounded text-[8px] font-black font-mono transition-all border border-white/5 bg-black/20 text-white/40 hover:text-studio-gold hover:border-studio-gold/30"
            >
              +{beats}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
