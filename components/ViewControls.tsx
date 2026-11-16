'use client';

import { useState, useCallback, useEffect } from 'react';
import { PanelTop, FolderOpen, Maximize, Minimize, Layout, Library, SlidersHorizontal } from 'lucide-react';
import { clsx } from 'clsx';
import { useUIStore } from '@/store/uiStore';
import { useMediaRecorder } from '@/hooks/useMediaRecorder';

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/**
 * phone: full-width bar; the bottom tabs pick the panel, so the panel toggles and workspace
 * switcher are left out (they also pushed the bar off a 375 px screen).
 * tablet: full-width bar with the A / MX / B panel toggles.
 * desktop: floating pill with everything.
 */
export function ViewControls({ variant = 'desktop' }: Readonly<{ variant?: 'phone' | 'tablet' | 'desktop' }>) {
  const compact = variant !== 'desktop';
  const showPanelToggles = variant !== 'phone';
  const showWorkspaceSwitcher = variant === 'desktop';
  const {
    isWaveformVisible,
    isDeckAVisible,
    isMixerVisible,
    isDeckBVisible,
    toggleWaveform,
    toggleDeckA,
    toggleMixer,
    toggleDeckB,
    setIsLibraryOverlayOpen,
    layoutMode,
    setLayoutMode,
  } = useUIStore();

  const { isRecording, elapsedSeconds, startRecording, stopRecording } = useMediaRecorder();

  const [isFullscreen, setIsFullscreen] = useState(false);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {
        // Fullscreen may be blocked by browser policy or missing user gesture
      });
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  // Keep isFullscreen in sync with external fullscreen changes (e.g. user presses Esc)
  useEffect(() => {
    const handleChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleChange);
    return () => document.removeEventListener('fullscreenchange', handleChange);
  }, []);

  return (
    <div className={clsx(
      'z-50 flex items-center gap-2 bg-slate-900/60 backdrop-blur-xl border border-white/10 shadow-2xl',
      compact
        ? 'absolute left-3 right-3 top-2 justify-center rounded-2xl px-2 py-1.5'
        : 'absolute top-4 right-4 rounded-full px-3 py-2'
    )}>
      <button
        onClick={toggleWaveform}
        className={clsx(
          "p-1.5 rounded-full transition-all duration-300",
          isWaveformVisible
            ? "text-accent neon-text-glow bg-accent/10"
            : "text-slate-500 hover:text-slate-300 hover:bg-slate-800"
        )}
        title="Toggle Waveforms"
      >
        <PanelTop className="w-4 h-4" />
      </button>

      {showPanelToggles && (<>
      <div className="w-px h-4 bg-slate-700 mx-1"></div>

      <button
        onClick={toggleDeckA}
        className={clsx(
          'rounded-full transition-all duration-300 px-2 py-1 text-[11px] font-bold',
          isDeckAVisible
            ? 'text-accent neon-text-glow bg-accent/10'
            : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
        )}
        title="Toggle Deck A"
      >
        A
      </button>

      <button
        onClick={toggleMixer}
        className={clsx(
          'rounded-full transition-all duration-300 px-2 py-1 text-[11px] font-bold',
          isMixerVisible
            ? 'text-accent neon-text-glow bg-accent/10'
            : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
        )}
        title="Toggle Mixer"
      >
        MX
      </button>

      <button
        onClick={toggleDeckB}
        className={clsx(
          'rounded-full transition-all duration-300 px-2 py-1 text-[11px] font-bold',
          isDeckBVisible
            ? 'text-accent neon-text-glow bg-accent/10'
            : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
        )}
        title="Toggle Deck B"
      >
        B
      </button>
      </>)}

      {showWorkspaceSwitcher && (<>
      <div className="w-px h-4 bg-slate-700 mx-1"></div>

      {/* Workspace Switcher */}
      <div className="flex items-center gap-1 bg-black/20 rounded-full p-1 border border-white/5">
        <button
          onClick={() => setLayoutMode('PERFORMANCE')}
          className={clsx(
            "p-1.5 rounded-full transition-all duration-300",
            layoutMode === 'PERFORMANCE'
              ? "text-accent bg-accent/20 shadow-[0_0_12px_rgba(212,175,55,0.3)]"
              : "text-slate-500 hover:text-slate-300 hover:bg-slate-800"
          )}
          title="Performance View"
        >
          <Layout className="w-4 h-4" />
        </button>
        <button
          onClick={() => setLayoutMode('MIXER')}
          className={clsx(
            "p-1.5 rounded-full transition-all duration-300",
            layoutMode === 'MIXER'
              ? "text-accent bg-accent/20 shadow-[0_0_12px_rgba(212,175,55,0.3)]"
              : "text-slate-500 hover:text-slate-300 hover:bg-slate-800"
          )}
          title="Mixer View"
        >
          <SlidersHorizontal className="w-4 h-4" />
        </button>
        <button
          onClick={() => setLayoutMode('LIBRARY')}
          className={clsx(
            "p-1.5 rounded-full transition-all duration-300",
            layoutMode === 'LIBRARY'
              ? "text-accent bg-accent/20 shadow-[0_0_12px_rgba(212,175,55,0.3)]"
              : "text-slate-500 hover:text-slate-300 hover:bg-slate-800"
          )}
          title="Library View"
        >
          <Library className="w-4 h-4" />
        </button>
      </div>
      </>)}

      <div className="w-px h-4 bg-slate-700 mx-1"></div>

      <button
        onClick={() => setIsLibraryOverlayOpen(true)}
        className="flex items-center gap-1.5 rounded-full transition-all duration-300 px-2.5 py-1 text-[11px] font-bold text-studio-gold hover:text-studio-gold/80 hover:bg-studio-gold/10 border border-studio-gold/30 hover:border-studio-gold/60"
        title="Browse Vault"
      >
        <FolderOpen className="w-3.5 h-3.5" />
        <span className="hidden sm:inline tracking-widest">VAULT</span>
      </button>

      <div className="w-px h-4 bg-slate-700 mx-1"></div>

      {/* Record button */}
      <button
        onClick={isRecording ? stopRecording : startRecording}
        className={clsx(
          'flex items-center gap-1.5 rounded-full px-2 py-1 text-[10px] font-bold transition-all duration-200',
          isRecording
            ? 'bg-red-900/40 border border-red-500/60 text-red-400 hover:bg-red-900/60'
            : 'text-slate-500 hover:text-red-400 hover:bg-slate-800 border border-transparent'
        )}
        title={isRecording ? 'Stop Recording' : 'Record Mix'}
      >
        <span
          className={clsx(
            'inline-block w-2 h-2 rounded-full bg-red-500 flex-shrink-0',
            isRecording && 'record-led-blink'
          )}
        />
        {isRecording ? (
          <span className="oled-display tabular-nums">{formatElapsed(elapsedSeconds)}</span>
        ) : (
          <span>REC</span>
        )}
      </button>

      {/* Fullscreen toggle */}
      <button
        onClick={toggleFullscreen}
        className="p-1.5 rounded-full text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-all duration-300"
        title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
      >
        {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
      </button>
    </div>
  );
}
