'use client';

import {
  useState, useEffect, useRef, useCallback, useMemo, memo,
} from 'react';
import {
  Plus, Upload, Loader2, FolderOpen, Trash2, Activity,
  Search, Clock, Music2, LayoutGrid, LayoutList,
  ChevronDown, ChevronRight, Disc3, X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import { PIKO_VAULT_TRACKS, useLibraryStore } from '@/store/libraryStore';
import { useUIStore } from '@/store/uiStore';
import { useDeckStore } from '@/store/deckStore';
import { useCueStore } from '@/store/cueStore';
import { useCrateStore } from '@/store/crateStore';
import { useHistoryStore } from '@/store/historyStore';
import { getCamelotStyles, isSmartMatch } from '@/lib/harmonic';
import { getCompatibleKeys } from '@/lib/harmonicKeys';
import type { Track } from '@/lib/db';
import { useShallow } from 'zustand/react/shallow';

const WAVE_BARS = [0.55, 0.82, 0.38, 0.92, 0.65, 0.28, 0.77, 0.44, 0.88, 0.61, 0.33, 0.95, 0.50, 0.72, 0.42, 0.85];

// ─── Mini Waveform Bar ───────────────────────────────────────────────────────
const MiniWave = memo(function MiniWave({ color = '#D4AF37' }: { color?: string }) {
  return (
    <div className="flex items-end gap-px h-4 w-16 opacity-60 flex-shrink-0">
      {WAVE_BARS.map((h, i) => (
        <div key={i} className="flex-1 rounded-sm" style={{ height: `${h * 100}%`, background: color }} />
      ))}
    </div>
  );
});

// ─── Camelot Key Badge ────────────────────────────────────────────────────────
function KeyBadge({ trackKey, glow }: { trackKey?: string; glow?: boolean }) {
  const style = getCamelotStyles(trackKey ?? '');
  return (
    <span
      className={clsx(
        'inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[9px] font-black font-mono tracking-tight min-w-[28px]',
        glow && 'shadow-[0_0_8px_rgba(212,175,55,0.6)]'
      )}
      style={{ background: style.bg, color: style.text }}
    >
      {trackKey || '—'}
    </span>
  );
}

// ─── BPM Cell ─────────────────────────────────────────────────────────────────
function BpmCell({ bpm, match }: { bpm?: string; match?: boolean }) {
  return (
    <span className={clsx(
      'font-mono tabular-nums text-xs font-bold',
      match ? 'text-yellow-400' : 'text-white/60'
    )}>
      {bpm || '--'}
    </span>
  );
}

// ─── Sidebar Item ─────────────────────────────────────────────────────────────
function SidebarItem({
  label, icon, active, count, onClick, danger, onDelete,
}: {
  label: string; icon?: React.ReactNode; active?: boolean; count?: number;
  onClick: () => void; danger?: boolean; onDelete?: () => void;
}) {
  return (
    <div
      className={clsx(
        'group flex items-center gap-2 px-3 py-1.5 rounded-lg cursor-pointer transition-all select-none',
        active
          ? 'bg-white/10 text-white'
          : danger
          ? 'text-red-400/60 hover:text-red-400 hover:bg-red-500/10'
          : 'text-white/40 hover:text-white/80 hover:bg-white/5'
      )}
      onClick={onClick}
    >
      <span className={clsx('flex-shrink-0 w-3.5 h-3.5', active ? 'text-yellow-400' : '')}>{icon}</span>
      <span className="flex-1 min-w-0 text-[11px] font-semibold truncate">{label}</span>
      {count !== undefined && (
        <span className="text-[9px] font-mono text-white/25">{count}</span>
      )}
      {onDelete && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 text-white/30 hover:text-red-400 rounded"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

// ─── Track Row ────────────────────────────────────────────────────────────────
const TrackRow = memo(function TrackRow({
  track, index, isMatch, isHarmonicMatch, compact, isPlaying, isSelected,
  onDragStart, onLoadDeckA, onLoadDeckB, onAddCueA, onAddCueB,
}: {
  track: Track; index: number; isMatch?: boolean; isHarmonicMatch?: boolean;
  compact?: boolean; isPlaying?: boolean; isSelected?: boolean;
  onDragStart: (e: React.DragEvent, t: Track) => void;
  onLoadDeckA: (t: Track) => void; onLoadDeckB: (t: Track) => void;
  onAddCueA: (t: Track) => void; onAddCueB: (t: Track) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const deckAColor = '#D4AF37';
  const deckBColor = '#E11D48';
  const accentColor = isMatch ? deckAColor : isHarmonicMatch ? '#3b82f6' : '#6b7280';

  return (
    <tr
      draggable
      onDragStart={(e) => onDragStart(e, track)}
      className={clsx(
        'group relative border-b cursor-grab active:cursor-grabbing transition-colors duration-100',
        isMatch
          ? 'border-yellow-500/20 bg-yellow-500/5 hover:bg-yellow-500/10'
          : isHarmonicMatch
          ? 'border-blue-500/15 bg-blue-500/5 hover:bg-blue-500/8'
          : 'border-white/5 hover:bg-white/5',
        isSelected && 'bg-white/15 border-white/20 shadow-[inset_0_0_12px_rgba(255,255,255,0.05)] ring-1 ring-white/10 z-10'
      )}
    >
      {/* Index / Playing Indicator */}
      <td className="w-8 pl-3 pr-1 py-2.5">
        {isPlaying ? (
          <Disc3 className="w-3.5 h-3.5 text-yellow-400 animate-spin" />
        ) : isSelected ? (
          <ChevronRight className="w-3.5 h-3.5 text-studio-gold animate-pulse" />
        ) : (
          <span className="text-[10px] font-mono text-white/20 group-hover:text-white/40 tabular-nums">{index + 1}</span>
        )}
      </td>

      {/* Artwork + Title + Artist */}
      <td className={clsx('py-2 min-w-0', compact ? 'pl-1 pr-2' : 'pl-2 pr-3')}>
        <div className="flex items-center gap-2.5 min-w-0">
          {/* Artwork */}
          <div
            className="w-8 h-8 rounded flex-shrink-0 border border-white/10 overflow-hidden"
            style={{
              background: track.artworkUrl
                ? `url(${track.artworkUrl}) center/cover`
                : 'linear-gradient(135deg, #1e293b, #0f172a)',
            }}
          >
            {!track.artworkUrl && (
              <div className="w-full h-full flex items-center justify-center">
                <Music2 className="w-3 h-3 text-white/20" />
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className={clsx('font-semibold truncate leading-tight', isPlaying ? 'text-yellow-400' : 'text-white/90', compact ? 'text-[11px]' : 'text-xs')}>
              {track.title}
              {track.hasVocal && (
                <span className="ml-1.5 px-1 py-px bg-blue-500/20 text-blue-400 text-[8px] font-bold rounded border border-blue-500/30 align-middle">VOC</span>
              )}
            </div>
            <div className={clsx('truncate text-white/35', compact ? 'text-[9px]' : 'text-[10px]')}>{track.artist}</div>
          </div>
        </div>
      </td>

      {/* Mini Waveform — hidden on compact/mobile */}
      {!compact && (
        <td className="hidden lg:table-cell pr-3 py-2">
          <MiniWave color={accentColor} />
        </td>
      )}

      {/* BPM */}
      <td className="pr-3 py-2 whitespace-nowrap">
        <BpmCell bpm={track.bpm} match={isMatch} />
      </td>

      {/* Key */}
      <td className="pr-3 py-2 whitespace-nowrap">
        <KeyBadge trackKey={track.key} glow={isHarmonicMatch || isMatch} />
      </td>

      {/* Duration — hidden on compact */}
      {!compact && (
        <td className="hidden md:table-cell pr-3 py-2 whitespace-nowrap">
          <span className="text-[10px] font-mono text-white/35">{track.duration || '--:--'}</span>
        </td>
      )}

      {/* Action Menu */}
      <td className="pr-2 py-2 text-right">
        <div className="relative inline-block" ref={menuOpen ? menuRef : undefined}>
          <button
            type="button"
            onClick={() => setMenuOpen(!menuOpen)}
            className="w-6 h-6 pointer-coarse:w-9 pointer-coarse:h-9 rounded flex items-center justify-center text-white/20 pointer-coarse:text-white/60 hover:text-white hover:bg-white/10 transition-all opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100"
            title="Load or queue this track"
            aria-label={`Load or queue ${track.title}`}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <AnimatePresence>
            {menuOpen && (
              <motion.div
                ref={menuRef}
                initial={{ opacity: 0, scale: 0.95, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: -4 }}
                transition={{ duration: 0.12 }}
                className="absolute right-0 top-full mt-1 w-44 bg-[#0e0e14] border border-white/10 rounded-xl shadow-2xl z-[60] overflow-hidden"
              >
                {[
                  { label: 'Load to Deck A', color: deckAColor, action: () => { onLoadDeckA(track); setMenuOpen(false); } },
                  { label: 'Load to Deck B', color: deckBColor, action: () => { onLoadDeckB(track); setMenuOpen(false); } },
                  { label: 'Play next on Deck A', color: deckAColor + '99', action: () => { onAddCueA(track); setMenuOpen(false); } },
                  { label: 'Play next on Deck B', color: deckBColor + '99', action: () => { onAddCueB(track); setMenuOpen(false); } },
                ].map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={item.action}
                    className="flex items-center gap-3 w-full px-3 py-2.5 text-[11px] font-medium text-white/70 hover:text-white hover:bg-white/5 transition-colors border-b border-white/5 last:border-0"
                  >
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: item.color }} />
                    {item.label}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </td>
    </tr>
  );
});

// ─── Main Library Component ────────────────────────────────────────────────────
export const Library = memo(function Library({ compact = false }: Readonly<{ compact?: boolean }>) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'tracks' | 'cue' | 'history'>('tracks');
  const [isDragging, setIsDragging] = useState(false);
  const [isSyncFlashing, setIsSyncFlashing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(!compact);
  const [cratesExpanded, setCratesExpanded] = useState(true);
  const [isCreatingCrate, setIsCreatingCrate] = useState(false);
  const [newCrateName, setNewCrateName] = useState('');
  const [holdVaultHud, setHoldVaultHud] = useState(false);
  const crateInputRef = useRef<HTMLInputElement>(null);
  const analyzerWorkerRef = useRef<Worker | null>(null);
  const decodeAudioCtxRef = useRef<AudioContext | null>(null);
  const [computedBpms, setComputedBpms] = useState<Record<number, string>>({});
  const [selectedIndex, setSelectedIndex] = useState(0);

  const {
    tracks, processingTracks, loadTracks, seedLibrary,
    queueFilesForIngestion, loadPikoVault, isProcessingQueue,
    queueProgress, isVaultSyncActive, vaultReadyCount, vaultTotalCount,
  } = useLibraryStore();

  const setAddMusicModalOpen = useUIStore((s) => s.setAddMusicModalOpen);
  const { isSmartMatchEnabled, toggleSmartMatch, isGridView, toggleGridView, isPerformanceMode } = useUIStore();
  const { addToCue, queueA, queueB, removeFromCue, clearCue, popNext } = useCueStore();
  const { crates, activeCrateId, crateTracks, loadCrates, createCrate, deleteCrate, addTrackToCrate, setActiveCrate } = useCrateStore();
  const { history, loadHistory, addToHistory, clearHistory } = useHistoryStore();

  const deckA = useDeckStore(useShallow((s) => ({ isPlaying: s.deckA.isPlaying, track: s.deckA.track })));
  const deckB = useDeckStore(useShallow((s) => ({ isPlaying: s.deckB.isPlaying, track: s.deckB.track })));
  const masterDeck = deckA.isPlaying ? deckA : deckB.isPlaying ? deckB : deckA;

  const compatibleKeys = useMemo(
    () => (masterDeck.track?.key ? getCompatibleKeys(masterDeck.track.key.toUpperCase()) : []),
    [masterDeck.track],
  );

  const isTrackHarmonicMatch = useCallback(
    (key?: string) => masterDeck.isPlaying && masterDeck.track?.key && key
      ? compatibleKeys.includes(key.toUpperCase()) : false,
    [compatibleKeys, masterDeck],
  );

  // Filter & search
  const displayTracks = useMemo(() => {
    let result = tracks;
    if (activeCrateId) {
      const ids = crateTracks[activeCrateId] ?? [];
      result = result.filter((t) => t.id && ids.includes(t.id));
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (t) => t.title?.toLowerCase().includes(q) || t.artist?.toLowerCase().includes(q) || t.key?.toLowerCase().includes(q)
      );
    }
    if (isSmartMatchEnabled && masterDeck.track) {
      result = result.filter((t) =>
        isSmartMatch(masterDeck.track!.key, Number(masterDeck.track!.bpm) || 120, t.key, Number(t.bpm) || 120)
      );
    }
    return result;
  }, [tracks, activeCrateId, crateTracks, searchQuery, isSmartMatchEnabled, masterDeck.track]);

  // Effects
  useEffect(() => {
    loadTracks().then(() => seedLibrary());
    loadCrates();
    loadHistory();
  }, [loadTracks, seedLibrary, loadCrates, loadHistory]);

  useEffect(() => {
    analyzerWorkerRef.current = new Worker('/workers/analyzer.worker.js');
    decodeAudioCtxRef.current = new AudioContext();
    return () => {
      analyzerWorkerRef.current?.terminate();
      void decodeAudioCtxRef.current?.close();
    };
  }, []);

  useEffect(() => {
    const pending = tracks.find((t) => t.id && (!t.bpm || t.bpm === '--') && !computedBpms[t.id] && (t.fileBlob || t.audioUrl));
    if (!pending || !analyzerWorkerRef.current || !decodeAudioCtxRef.current) return;
    const worker = analyzerWorkerRef.current;
    const audioCtx = decodeAudioCtxRef.current;
    const trackId = pending.id!;
    const run = async () => {
      try {
        const buf = pending.fileBlob ? await pending.fileBlob.arrayBuffer() : await (await fetch(pending.audioUrl!)).arrayBuffer();
        const audioBuf = await audioCtx.decodeAudioData(buf);
        worker.onmessage = (e: MessageEvent<{ bpm: number }>) =>
          setComputedBpms((prev) => ({ ...prev, [trackId]: String(e.data.bpm) }));
        const data = audioBuf.getChannelData(0);
        worker.postMessage({ audioData: data, sampleRate: audioBuf.sampleRate }, [data.buffer]);
      } catch { /* non-critical */ }
    };
    void run();
  }, [tracks, computedBpms]);

  useEffect(() => {
    const lastA = { id: null as number | null };
    const lastB = { id: null as number | null };
    if (deckA.track?.id && deckA.isPlaying && deckA.track.id !== lastA.id) {
      addToHistory(deckA.track.id, 'A'); lastA.id = deckA.track.id;
    }
    if (deckB.track?.id && deckB.isPlaying && deckB.track.id !== lastB.id) {
      addToHistory(deckB.track.id, 'B'); lastB.id = deckB.track.id;
    }
  }, [deckA.track?.id, deckA.isPlaying, deckB.track?.id, deckB.isPlaying, addToHistory]);

  useEffect(() => {
    if (isVaultSyncActive || !holdVaultHud) return;
    const t = setTimeout(() => setHoldVaultHud(false), 700);
    return () => clearTimeout(t);
  }, [holdVaultHud, isVaultSyncActive, vaultReadyCount, vaultTotalCount]);

  // Reset selection on filter change
  useEffect(() => {
    setSelectedIndex(0);
  }, [displayTracks.length]);

  // Global keyboard shortcuts for Library
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Ignore if typing in any input/textarea
      if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) {
        if (e.key === 'Enter') {
          // Blur the input to let keyboard navigation take over
          (document.activeElement as HTMLElement).blur();
          setSelectedIndex(0);
        }
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => Math.min(prev + 1, displayTracks.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => Math.max(prev - 1, 0));
      } else if (e.key.toLowerCase() === 'a') {
        const t = displayTracks[selectedIndex];
        if (t) {
          useDeckStore.getState().loadTrack('A', t);
          toast.success(`Loaded "${t.title}" to Deck A`, { icon: '🎧', style: { background: '#0f172a', color: '#D4AF37', border: '1px solid rgba(212,175,55,0.3)' } });
        }
      } else if (e.key.toLowerCase() === 'b') {
        const t = displayTracks[selectedIndex];
        if (t) {
          useDeckStore.getState().loadTrack('B', t);
          toast.success(`Loaded "${t.title}" to Deck B`, { icon: '🎧', style: { background: '#0f172a', color: '#E11D48', border: '1px solid rgba(225,29,72,0.3)' } });
        }
      } else if (e.key === 'Enter') {
        const t = displayTracks[selectedIndex];
        if (t) {
          useDeckStore.getState().loadTrack('A', t);
          toast.success(`Loaded to Deck A`);
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [displayTracks, selectedIndex]);

  useEffect(() => {
    const h = (e: Event) => {
      setIsSyncFlashing(true);
      if ((e as CustomEvent).detail?.type === 'NEW_CUE') toast('B2B hot cue synced');
      setTimeout(() => setIsSyncFlashing(false), 200);
    };
    window.addEventListener('pro-dj-sync-feedback', h as EventListener);
    return () => window.removeEventListener('pro-dj-sync-feedback', h as EventListener);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); }, []);
  const handleDragLeave = useCallback(() => setIsDragging(false), []);
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false);
    await queueFilesForIngestion(Array.from(e.dataTransfer.files));
  }, [queueFilesForIngestion]);

  const handleTrackDragStart = (e: React.DragEvent, track: Track) => {
    e.dataTransfer.setData('application/json', JSON.stringify(track));
    e.dataTransfer.effectAllowed = 'copy';
  };

  const handleCreateCrate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCrateName.trim()) return;
    await createCrate(newCrateName.trim());
    toast.success(`Crate "${newCrateName}" created`);
    setNewCrateName('');
    setIsCreatingCrate(false);
  };

  const vaultProgress = vaultTotalCount > 0 ? Math.min(100, (vaultReadyCount / vaultTotalCount) * 100) : 0;
  const showVaultHud = isVaultSyncActive || holdVaultHud;

  // Track currently loaded on each deck for row highlight
  const deckATrackId = deckA.track?.id;
  const deckBTrackId = deckB.track?.id;

  const containerClass = clsx(
    'flex flex-col overflow-hidden relative transition-all duration-300',
    compact ? 'h-full' : isPerformanceMode ? 'h-[15vh] min-h-[80px]' : 'h-[42vh] min-h-[260px]',
    isSyncFlashing && 'shadow-[0_0_0_1px_rgba(0,255,0,0.6),0_0_24px_rgba(0,255,0,0.2)]'
  );

  return (
    <div className={containerClass} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>

      {/* ── Drag & Drop Overlay ──────────────────────────────────────────── */}
      <AnimatePresence>
        {isDragging && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 bg-yellow-500/10 border-2 border-dashed border-yellow-500/60 rounded-xl z-50 flex flex-col items-center justify-center backdrop-blur-sm"
          >
            <Upload className="w-12 h-12 text-yellow-400 mb-3 animate-bounce" />
            <p className="text-white font-bold text-lg">Drop audio files to analyze</p>
            <p className="text-white/50 text-sm mt-1">MP3, WAV, FLAC, M4A supported</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Vault HUD ────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {showVaultHud && (
          <motion.div
            initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
            className="absolute top-0 left-0 right-0 z-40 bg-black/90 backdrop-blur border-b border-yellow-500/30 px-4 py-2 flex items-center gap-4"
          >
            <Loader2 className="w-4 h-4 text-yellow-400 animate-spin flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[10px] text-yellow-400 font-bold uppercase tracking-widest">Vault Sync</div>
              <div className="h-1 w-full bg-white/10 rounded-full overflow-hidden mt-1">
                <motion.div
                  className="h-full bg-yellow-400 rounded-full"
                  animate={{ width: `${vaultProgress}%` }}
                  transition={{ duration: 0.3 }}
                />
              </div>
            </div>
            <span className="text-xs font-mono text-white/60">{vaultReadyCount}/{vaultTotalCount}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Top Toolbar ──────────────────────────────────────────────────── */}
      {/* Wraps on narrow screens: one row was wider than a phone and scrolled the whole list sideways. */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-white/5 bg-black/40 flex-shrink-0">
        {/* Sidebar toggle */}
        {!compact && (
          <button
            type="button"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-1.5 rounded-lg text-white/30 hover:text-white hover:bg-white/10 transition-all flex-shrink-0"
            title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          >
            <LayoutList className="w-4 h-4" />
          </button>
        )}

        {/* Tab Pills */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {([
            { id: 'tracks', label: 'ALL TRACKS', icon: <Music2 className="w-3 h-3" /> },
            { id: 'cue', label: 'QUEUE', icon: <LayoutGrid className="w-3 h-3" /> },
            { id: 'history', label: 'HISTORY', icon: <Clock className="w-3 h-3" /> },
          ] as const).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => { setActiveTab(tab.id); if (tab.id !== 'cue') setActiveCrate(null); }}
              className={clsx(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider transition-all',
                activeTab === tab.id && (activeCrateId === null || tab.id !== 'tracks')
                  ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/40'
                  : 'text-white/30 hover:text-white/70 border border-transparent'
              )}
            >
              {tab.icon}{tab.label}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="flex-1 min-w-0 max-w-xs">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-white/25 pointer-events-none" />
            <input
              type="text"
              placeholder="Search tracks…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-7 pr-3 py-1 bg-white/5 border border-white/10 rounded-full text-[11px] text-white placeholder:text-white/20 focus:outline-none focus:border-yellow-500/50 focus:bg-white/8 transition-all"
            />
            {searchQuery && (
              <button type="button" onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-white/30 hover:text-white">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>

        {/* Right controls */}
        <div className="flex items-center gap-1.5 flex-shrink-0 ml-auto">
          <button
            type="button"
            onClick={toggleSmartMatch}
            className={clsx(
              'px-2.5 py-1 rounded-full border text-[10px] font-black uppercase tracking-wider transition-all',
              isSmartMatchEnabled
                ? 'bg-yellow-500 text-black border-yellow-400 shadow-[0_0_10px_rgba(212,175,55,0.4)]'
                : 'text-white/30 border-white/10 hover:text-yellow-400 hover:border-yellow-500/40'
            )}
          >
            ⚡ MATCH
          </button>

          <button
            type="button"
            onClick={() => setAddMusicModalOpen(true)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/8 border border-white/10 text-[10px] font-black text-white/70 hover:text-white hover:bg-white/15 transition-all"
          >
            <Plus className="w-3 h-3" /> ADD
          </button>

          <button
            type="button"
            onClick={() => { setHoldVaultHud(true); void loadPikoVault(PIKO_VAULT_TRACKS); }}
            className="px-2.5 py-1 rounded-full bg-yellow-500 text-black text-[10px] font-black uppercase hover:bg-yellow-400 transition-all shadow-[0_0_10px_rgba(212,175,55,0.3)]"
          >
            VAULT
          </button>

          {isProcessingQueue && (
            <div className="flex items-center gap-1.5 text-[10px] text-yellow-400">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span className="hidden sm:inline truncate max-w-[100px]">{queueProgress || 'Analyzing…'}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Body: Sidebar + Content ──────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Sidebar */}
        <AnimatePresence initial={false}>
          {sidebarOpen && !compact && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 176, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: 'easeInOut' }}
              className="flex-shrink-0 h-full border-r border-white/5 bg-black/30 overflow-y-auto overflow-x-hidden"
            >
              <div className="p-2 space-y-0.5 min-w-[176px]">
                <SidebarItem
                  label="All Tracks"
                  icon={<Music2 className="w-full h-full" />}
                  active={activeTab === 'tracks' && !activeCrateId}
                  count={tracks.length}
                  onClick={() => { setActiveTab('tracks'); setActiveCrate(null); }}
                />
                <SidebarItem
                  label="History"
                  icon={<Clock className="w-full h-full" />}
                  active={activeTab === 'history'}
                  count={history.length}
                  onClick={() => setActiveTab('history')}
                />

                {/* Crates Section */}
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => setCratesExpanded(!cratesExpanded)}
                    className="flex items-center gap-1 w-full px-2 py-1 text-[9px] font-black uppercase tracking-[0.15em] text-white/25 hover:text-white/50 transition-colors"
                  >
                    {cratesExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                    Crates
                  </button>
                  <AnimatePresence>
                    {cratesExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden space-y-0.5"
                      >
                        {crates.map((crate) => (
                          <SidebarItem
                            key={crate.id}
                            label={crate.name}
                            icon={<FolderOpen className="w-full h-full" />}
                            active={activeCrateId === crate.id}
                            onClick={() => { setActiveTab('tracks'); setActiveCrate(crate.id!); }}
                            onDelete={() => { if (crate.id) void deleteCrate(crate.id); }}
                          />
                        ))}
                        {isCreatingCrate ? (
                          <form onSubmit={handleCreateCrate} className="px-2 py-1">
                            <input
                              ref={crateInputRef}
                              autoFocus
                              type="text"
                              value={newCrateName}
                              onChange={(e) => setNewCrateName(e.target.value)}
                              placeholder="Crate name…"
                              className="w-full px-2 py-1 bg-white/5 border border-white/15 rounded text-[11px] text-white focus:outline-none focus:border-yellow-500/50"
                              onBlur={() => { if (!newCrateName) setIsCreatingCrate(false); }}
                              onKeyDown={(e) => { if (e.key === 'Escape') setIsCreatingCrate(false); }}
                            />
                          </form>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setIsCreatingCrate(true)}
                            className="flex items-center gap-1.5 w-full px-3 py-1.5 text-[10px] text-white/25 hover:text-yellow-400 transition-colors"
                          >
                            <Plus className="w-3 h-3" /> New Crate
                          </button>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Main Content Area ───────────────────────────────────────── */}
        <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">

          {/* History Tab */}
          {activeTab === 'history' && (
            <div className="p-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-[10px] uppercase tracking-widest text-white/30 font-bold">Play History</h3>
                <button
                  type="button"
                  onClick={() => clearHistory()}
                  disabled={history.length === 0}
                  className="px-2 py-0.5 text-[9px] font-bold rounded bg-white/5 border border-white/10 text-white/40 hover:text-red-400 hover:border-red-400/30 transition-colors disabled:opacity-30"
                >
                  CLEAR
                </button>
              </div>
              <div className="space-y-0.5">
                {history.length === 0 ? (
                  <div className="py-8 text-center text-white/20 text-xs">No tracks played yet.</div>
                ) : (
                  history.map((item, idx) => (
                    <div key={`hist-${item.id ?? idx}`} className="group flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-white/5 transition-colors">
                      <span className="text-[9px] font-mono text-white/20 w-4 text-right">{history.length - idx}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-white/80 truncate">{item.track?.title || 'Unknown'}</div>
                        <div className="text-[9px] text-white/30 truncate">
                          {item.track?.artist} · Deck {item.deckId} · {new Date(item.playedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {(['A', 'B'] as const).map((d) => (
                          <button
                            key={d}
                            type="button"
                            onClick={() => { if (item.track) { useDeckStore.getState().loadTrack(d, item.track); toast.success(`Loaded to Deck ${d}`); } }}
                            className={clsx(
                              'px-1.5 py-0.5 text-[9px] font-black rounded border transition-colors',
                              d === 'A'
                                ? 'border-yellow-500/30 text-yellow-400/70 hover:text-yellow-400 hover:border-yellow-500'
                                : 'border-pink-500/30 text-pink-400/70 hover:text-pink-400 hover:border-pink-500'
                            )}
                          >
                            {d}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Cue Queue Tab */}
          {activeTab === 'cue' && (
            <div className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <p className="sm:col-span-2 text-[11px] leading-relaxed text-white/45">
                Line up the tracks you want to play next on each deck. On any track, tap <span className="font-bold text-white/70">+</span> and
                choose <span className="font-bold text-white/70">Play next on Deck A</span> or <span className="font-bold text-white/70">B</span>.
                When the deck is ready, <span className="font-bold text-white/70">LOAD NEXT</span> puts the first track in the line on it.
              </p>
              {(['A', 'B'] as const).map((d) => {
                const queue = d === 'A' ? queueA : queueB;
                const color = d === 'A' ? '#D4AF37' : '#E11D48';
                return (
                  <div key={d}>
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-[10px] uppercase tracking-widest font-black" style={{ color }}>{`DECK ${d} · UP NEXT`}</h3>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => { const next = popNext(d); if (next) useDeckStore.getState().loadTrack(d, next); }}
                          disabled={queue.length === 0}
                          className="px-2 py-1 text-[9px] font-bold rounded border border-white/10 text-white/50 hover:text-white transition-colors disabled:opacity-30"
                          title={`Load the first queued track onto Deck ${d}`}
                        >
                          LOAD NEXT
                        </button>
                        <button
                          type="button"
                          onClick={() => clearCue(d)}
                          disabled={queue.length === 0}
                          className="px-2 py-1 text-[9px] font-bold rounded border border-white/10 text-white/50 hover:text-red-400 transition-colors disabled:opacity-30"
                        >
                          CLEAR
                        </button>
                      </div>
                    </div>
                    <div className="space-y-0.5">
                      {queue.length === 0 ? (
                        <div className="py-5 text-center text-white/30 text-[11px]">Nothing lined up for Deck {d} yet</div>
                      ) : (
                        queue.map((t, i) => (
                          <div key={`q${d}-${t.id ?? i}`} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white/3 hover:bg-white/7 group">
                            <span className="text-[9px] font-mono text-white/20 w-4">{i + 1}</span>
                            <div className="flex-1 min-w-0">
                              <div className="text-[11px] font-semibold text-white/80 truncate">{t.title}</div>
                              <div className="text-[9px] text-white/30 truncate">{t.artist}</div>
                            </div>
                            <button
                              type="button"
                              onClick={() => { if (t.id) removeFromCue(d, t.id); }}
                              className="opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 pointer-coarse:p-2 text-white/20 hover:text-red-400 transition-all"
                              aria-label={`Remove ${t.title} from the Deck ${d} queue`}
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Track Table (grid or list) */}
          {activeTab !== 'cue' && (
            <>
              {isGridView ? (
                /* ── Grid View ─────────────────────────────────────────── */
                <div className="p-3 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2">
                  {displayTracks.map((track, idx) => {
                    const isMatch = isSmartMatchEnabled && masterDeck.track
                      ? isSmartMatch(masterDeck.track.key, Number(masterDeck.track.bpm) || 120, track.key, Number(track.bpm) || 120)
                      : false;
                    return (
                      <div
                        key={track.id}
                        draggable
                        onDragStart={(e) => handleTrackDragStart(e, track)}
                        className={clsx(
                          'group cursor-grab active:cursor-grabbing rounded-xl overflow-hidden border transition-all',
                          idx === selectedIndex ? 'ring-2 ring-yellow-500 scale-[1.02] shadow-[0_0_20px_rgba(212,175,55,0.3)] z-10 bg-white/10' :
                          isMatch
                            ? 'border-yellow-500/40 bg-yellow-500/8 shadow-[0_0_12px_rgba(212,175,55,0.2)]'
                            : 'border-white/8 bg-white/3 hover:bg-white/6 hover:border-white/15'
                        )}
                      >
                        <div
                          className="aspect-square relative"
                          style={{ background: track.artworkUrl ? `url(${track.artworkUrl}) center/cover` : 'linear-gradient(135deg,#1e293b,#0f172a)' }}
                        >
                          {!track.artworkUrl && (
                            <div className="w-full h-full flex items-center justify-center">
                              <Music2 className="w-6 h-6 text-white/10" />
                            </div>
                          )}
                          <div className="absolute bottom-1 right-1"><KeyBadge trackKey={track.key} glow={isMatch} /></div>
                        </div>
                        <div className="p-2">
                          <div className="text-[10px] font-semibold text-white/90 truncate">{track.title}</div>
                          <div className="text-[9px] text-white/35 truncate">{track.artist}</div>
                          <div className="text-[9px] font-mono text-white/40 mt-0.5">{track.bpm || '--'} BPM</div>
                          <div className="mt-1.5 grid grid-cols-2 gap-1">
                            {(['A', 'B'] as const).map((d) => (
                              <button
                                key={d}
                                type="button"
                                onClick={() => { useDeckStore.getState().loadTrack(d, track); toast.success(`Loaded to Deck ${d}`); }}
                                className="py-1 rounded-md border text-[9px] font-black transition-colors hover:bg-white/10"
                                style={{ color: d === 'A' ? '#D4AF37' : '#E11D48', borderColor: d === 'A' ? 'rgba(212,175,55,0.35)' : 'rgba(225,29,72,0.35)' }}
                              >
                                LOAD {d}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                /* ── List / Table View ─────────────────────────────────── */
                <table className="w-full text-left border-separate" style={{ borderSpacing: 0 }}>
                  <thead className="sticky top-0 z-20">
                    <tr className="bg-[#09090f]/95 backdrop-blur border-b border-white/5">
                      <th className="w-8 pl-3 py-2 text-[9px] uppercase tracking-widest text-white/20 font-bold">#</th>
                      <th className="py-2 pl-2 pr-3 text-[9px] uppercase tracking-widest text-white/20 font-bold">Title</th>
                      {!compact && <th className="hidden lg:table-cell py-2 pr-3 text-[9px] uppercase tracking-widest text-white/20 font-bold">Wave</th>}
                      <th className="py-2 pr-3 text-[9px] uppercase tracking-widest text-white/20 font-bold">BPM</th>
                      <th className="py-2 pr-3 text-[9px] uppercase tracking-widest text-white/20 font-bold">Key</th>
                      {!compact && <th className="hidden md:table-cell py-2 pr-3 text-[9px] uppercase tracking-widest text-white/20 font-bold">Time</th>}
                      <th className="py-2 pr-2 text-right text-[9px] text-white/20 font-bold w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {/* Processing rows */}
                    {processingTracks.map((pt) => (
                      <tr key={`proc-${pt.id}`} className="border-b border-white/5 bg-yellow-500/5">
                        <td className="w-8 pl-3 py-2.5">
                          <Activity className="w-3 h-3 text-yellow-400 animate-pulse" />
                        </td>
                        <td className="py-2 pl-2 pr-3" colSpan={!compact ? 5 : 3}>
                          <div className="flex items-center gap-2">
                            <Loader2 className="w-3.5 h-3.5 text-yellow-400 animate-spin flex-shrink-0" />
                            <span className="text-[11px] text-yellow-400/70 italic truncate">Analyzing {pt.name}…</span>
                          </div>
                        </td>
                        <td />
                      </tr>
                    ))}

                    {displayTracks.map((track, index) => {
                      const isMatch = isSmartMatchEnabled && masterDeck.track
                        ? isSmartMatch(masterDeck.track.key, Number(masterDeck.track.bpm) || 120, track.key, Number(track.bpm) || 120)
                        : false;
                      const isHM = isTrackHarmonicMatch(track.key);
                      const isLoadedA = track.id === deckATrackId;
                      const isLoadedB = track.id === deckBTrackId;
                      const accentColor = isLoadedA ? '#D4AF37' : isLoadedB ? '#E11D48' : undefined;

                      return (
                        <TrackRow
                          key={track.id}
                          track={{ ...track, bpm: (track.id && computedBpms[track.id]) || track.bpm }}
                          index={index}
                          isSelected={index === selectedIndex}
                          isMatch={isMatch}
                          isHarmonicMatch={isHM}
                          compact={compact}
                          isPlaying={(isLoadedA && deckA.isPlaying) || (isLoadedB && deckB.isPlaying)}
                          onDragStart={handleTrackDragStart}
                          onLoadDeckA={(t) => { useDeckStore.getState().loadTrack('A', t); toast.success('Loaded to Deck A'); }}
                          onLoadDeckB={(t) => { useDeckStore.getState().loadTrack('B', t); toast.success('Loaded to Deck B'); }}
                          onAddCueA={(t) => { addToCue('A', t); toast.success('Queued to play next on Deck A'); }}
                          onAddCueB={(t) => { addToCue('B', t); toast.success('Queued to play next on Deck B'); }}
                        />
                      );
                    })}

                    {displayTracks.length === 0 && processingTracks.length === 0 && (
                      <tr>
                        <td colSpan={7}>
                          <div className="flex flex-col items-center gap-2 py-12 text-white/20">
                            <Upload className="w-8 h-8" />
                            <p className="text-xs">
                              {searchQuery ? 'No tracks match your search.' : 'No tracks in library. Drag & drop audio files here.'}
                            </p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Status Bar ────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-1 border-t border-white/5 bg-black/30 flex-shrink-0">
        <div className="flex items-center gap-3">
          <span className={clsx(
            'flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider',
            isProcessingQueue ? 'text-yellow-400' : tracks.length > 0 ? 'text-green-400' : 'text-white/20'
          )}>
            <span className={clsx('w-1.5 h-1.5 rounded-full', isProcessingQueue ? 'bg-yellow-400 animate-pulse' : tracks.length > 0 ? 'bg-green-400' : 'bg-white/20')} />
            {isProcessingQueue ? 'SYNCING' : `${tracks.length} TRACKS`}
          </span>
          {activeCrateId && (
            <span className="text-[9px] text-yellow-400 font-bold uppercase">
              📂 {crates.find((c) => c.id === activeCrateId)?.name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={toggleGridView}
            className={clsx(
              'p-1 rounded transition-colors',
              isGridView ? 'text-yellow-400' : 'text-white/20 hover:text-white/50'
            )}
            title={isGridView ? 'List view' : 'Grid view'}
          >
            {isGridView ? <LayoutList className="w-3.5 h-3.5" /> : <LayoutGrid className="w-3.5 h-3.5" />}
          </button>
          {searchQuery && (
            <span className="text-[9px] text-white/30 font-mono">
              {displayTracks.length} result{displayTracks.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});
