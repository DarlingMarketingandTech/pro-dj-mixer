'use client';

import { useEffect, useRef, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useMixerStore } from '@/store/mixerStore';
import { useDeckStore } from '@/store/deckStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useTrackCueStore } from '@/store/trackCueStore';
import { buildSessionState, ensureSessionSync, saveSessionState } from '@/lib/syncManager';
import { useMIDIManager } from '@/hooks/useMIDIManager';
import { buildAICrate } from '@/lib/aiCrate';
import { getCompatibleKeys } from '@/lib/harmonicKeys';
import { AudioEngine, calculateNeuralGains } from '@/lib/audioEngine';
import { clsx } from 'clsx';
import { useUIStore } from '@/store/uiStore';
import { motion, AnimatePresence } from 'framer-motion';
import { Sliders, Cpu, Music2 } from 'lucide-react';

const DEFAULT_AI_CRATE_PROMPT = 'Show me tracks for a 124 BPM house set.';

const MasterMeter = dynamic(
  () => import('@/components/MasterMeter').then((m) => m.MasterMeter),
  { ssr: false }
);

// ─── Key Compatibility Badge ──────────────────────────────────────────────────
function MixOpportunityBadge() {
  const keyA = useDeckStore(s => s.deckA.track?.key ?? '');
  const keyB = useDeckStore(s => s.deckB.track?.key ?? '');
  if (!keyA || !keyB || keyA === '--' || keyB === '--') return null;
  const compatible = getCompatibleKeys(keyA.toUpperCase());
  const isMatch = compatible.includes(keyB.toUpperCase());
  return (
    <div className={clsx(
      'flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-black tracking-widest border',
      isMatch
        ? 'bg-green-900/40 border-green-500/40 text-green-400 shadow-[0_0_10px_rgba(34,197,94,0.25)]'
        : 'bg-red-900/30 border-red-500/30 text-red-400'
    )}>
      <span>{isMatch ? '✓' : '✗'}</span>
      <span>{isMatch ? 'KEY MATCH' : 'KEY CLASH'}</span>
    </div>
  );
}

// ─── EQ Knob ──────────────────────────────────────────────────────────────────
function EQKnob({
  label, value, onChange, color = '#D4AF37',
}: {
  label: string; value: number; onChange: (v: number) => void; color?: string;
}) {
  const startY = useRef(0);
  const startVal = useRef(value);
  const dragging = useRef(false);
  const angleDeg = value * 135;
  const killed = value <= -0.98;

  const onDown = (e: React.PointerEvent) => {
    dragging.current = true;
    startY.current = e.clientY;
    startVal.current = value;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    onChange(Math.max(-1, Math.min(1, startVal.current + (startY.current - e.clientY) / 80)));
  };
  const onUp = () => { dragging.current = false; };

  return (
    <div className="flex flex-col items-center gap-0.5">
      <div
        className={clsx('w-9 h-9 rounded-full cursor-pointer relative flex items-center justify-center', killed && 'ring-1 ring-red-500/60')}
        style={{
          background: killed ? 'rgba(239,68,68,0.12)' : 'radial-gradient(circle at 35% 35%,#2a2a3c,#0d0d15)',
          border: `1.5px solid ${killed ? 'rgba(239,68,68,0.5)' : 'rgba(255,255,255,0.12)'}`,
        }}
        onPointerDown={onDown} onPointerMove={onMove}
        onPointerUp={onUp} onPointerCancel={onUp}
        onDoubleClick={() => onChange(0)}
        title={`${label} EQ — drag to adjust, double-click to reset`}
      >
        <div
          className="absolute w-0.5 h-3.5 rounded-full"
          style={{
            bottom: '50%', left: '50%', transformOrigin: 'bottom center',
            transform: `translateX(-50%) rotate(${angleDeg}deg)`,
            background: killed ? '#ef4444' : (Math.abs(value) < 0.05 ? 'rgba(255,255,255,0.4)' : color),
          }}
        />
        <div className={clsx('w-1.5 h-1.5 rounded-full', killed ? 'bg-red-500' : 'bg-white/15')} />
      </div>
      <span className={clsx('text-[7px] font-black uppercase tracking-widest', killed ? 'text-red-400' : 'text-white/25')}>{label}</span>
      <button
        type="button"
        onClick={() => onChange(value <= -0.98 ? 0 : -1)}
        className={clsx('text-[7px] font-black px-1 py-px rounded border transition-all leading-none',
          killed ? 'bg-red-500/25 text-red-400 border-red-500/40' : 'bg-white/4 text-white/15 border-white/8 hover:text-red-400 hover:border-red-400/30'
        )}
      >
        {killed ? 'LIVE' : 'KILL'}
      </button>
    </div>
  );
}

// ─── Channel Fader (vertical) ──────────────────────────────────────────────────
function ChannelFader({ value, onChange, color }: { value: number; onChange: (v: number) => void; color: string }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const getVal = (clientY: number) => {
    if (!trackRef.current) return value;
    const r = trackRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, 1 - (clientY - r.top) / r.height));
  };
  const onDown = (e: React.PointerEvent) => {
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onChange(getVal(e.clientY));
  };
  const onMove = (e: React.PointerEvent) => { if (dragging.current) onChange(getVal(e.clientY)); };
  const onUp = () => { dragging.current = false; };

  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[7px] uppercase tracking-widest text-white/15">CH</span>
      <div
        ref={trackRef}
        className="h-24 w-3 rounded-full border border-white/10 bg-black/60 relative cursor-pointer select-none touch-none"
        style={{ boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.8)' }}
        onPointerDown={onDown} onPointerMove={onMove}
        onPointerUp={onUp} onPointerCancel={onUp}
        onDoubleClick={() => onChange(0.75)}
      >
        <div className="absolute left-0 right-0 top-[25%] h-px bg-white/8" />
        <div
          className="absolute left-[-3px] right-[-3px] h-4 rounded-sm border border-white/20"
          style={{
            bottom: `calc(${value * 100}% - 8px)`,
            background: `linear-gradient(135deg,${color},${color}99)`,
            boxShadow: `0 0 6px ${color}40`,
          }}
        >
          <div className="w-full h-px bg-black/40 absolute top-1/2 -translate-y-1/2" />
        </div>
      </div>
      <span className="text-[7px] font-mono text-white/15">{Math.round(value * 100)}</span>
    </div>
  );
}

// ─── Filter Knob (bipolar HPF/LPF) ────────────────────────────────────────────
function FilterKnob({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const startY = useRef(0);
  const startVal = useRef(value);
  const dragging = useRef(false);
  const angleDeg = value * 135;
  const color = value < -0.05 ? '#60a5fa' : value > 0.05 ? '#f97316' : 'rgba(255,255,255,0.3)';

  const onDown = (e: React.PointerEvent) => {
    dragging.current = true; startY.current = e.clientY; startVal.current = value;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    onChange(Math.max(-1, Math.min(1, startVal.current + (startY.current - e.clientY) / 70)));
  };
  const onUp = () => { dragging.current = false; };

  return (
    <div className="flex flex-col items-center gap-0.5">
      <div
        className="w-8 h-8 rounded-full cursor-pointer relative flex items-center justify-center"
        style={{
          background: 'radial-gradient(circle at 35% 35%,#1c1c2e,#0a0a10)',
          border: `1.5px solid ${color}30`,
          boxShadow: Math.abs(value) > 0.05 ? `0 0 8px ${color}40` : 'none',
        }}
        onPointerDown={onDown} onPointerMove={onMove}
        onPointerUp={onUp} onPointerCancel={onUp}
        onDoubleClick={() => onChange(0)}
        title="Filter: drag down=LPF, drag up=HPF, double-click=flat"
      >
        <div
          className="absolute w-0.5 h-3 rounded-full"
          style={{ bottom: '50%', left: '50%', transformOrigin: 'bottom center', transform: `translateX(-50%) rotate(${angleDeg}deg)`, background: color }}
        />
      </div>
      <span className="text-[7px] font-black uppercase text-white/15">
        {value < -0.1 ? 'LPF' : value > 0.1 ? 'HPF' : 'FILT'}
      </span>
    </div>
  );
}

// ─── Crossfader ───────────────────────────────────────────────────────────────
function Crossfader({
  value, onChange, curve, onCurveChange,
}: {
  value: number; onChange: (v: number) => void;
  curve: 'blend' | 'cut' | 'neural'; onCurveChange: (c: 'blend' | 'cut' | 'neural') => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const getVal = (clientX: number) => {
    if (!trackRef.current) return value;
    const r = trackRef.current.getBoundingClientRect();
    return Math.max(-1, Math.min(1, ((clientX - r.left) / r.width) * 2 - 1));
  };
  const onDown = (e: React.PointerEvent) => {
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onChange(getVal(e.clientX));
  };
  const onMove = (e: React.PointerEvent) => { if (dragging.current) onChange(getVal(e.clientX)); };
  const onUp = () => { dragging.current = false; };

  const thumbPct = ((value + 1) / 2) * 100;
  const thumbColor = value < -0.05 ? '#D4AF37' : value > 0.05 ? '#E11D48' : '#ffffff';

  return (
    <div className="flex flex-col gap-1.5 items-center w-full">
      <div className="flex items-center justify-between w-full">
        <span className="text-[9px] font-black text-yellow-400/70">A</span>
        <div className="flex items-center gap-1">
          {(['blend', 'cut', 'neural'] as const).map(c => (
            <button
              key={c}
              type="button"
              onClick={() => onCurveChange(c)}
              className={clsx(
                'text-[7px] font-black uppercase px-1.5 py-0.5 rounded border transition-all',
                curve === c ? 'bg-white/15 border-white/30 text-white' : 'border-white/8 text-white/20 hover:text-white/50'
              )}
            >
              {c === 'neural' ? 'AI' : c}
            </button>
          ))}
        </div>
        <span className="text-[9px] font-black text-red-400/70">B</span>
      </div>

      {/* Fader track */}
      <div
        ref={trackRef}
        className="relative h-7 w-full rounded-full border border-white/12 bg-black/70 cursor-pointer select-none touch-none"
        style={{ boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.8)' }}
        onPointerDown={onDown} onPointerMove={onMove}
        onPointerUp={onUp} onPointerCancel={onUp}
        onDoubleClick={() => onChange(0)}
      >
        {/* Left fill */}
        {value < -0.02 && (
          <div className="absolute left-0 top-1 bottom-1 rounded-l-full" style={{ width: `${50 - thumbPct}%`, background: 'rgba(212,175,55,0.15)' }} />
        )}
        {/* Right fill */}
        {value > 0.02 && (
          <div className="absolute right-0 top-1 bottom-1 rounded-r-full" style={{ width: `${thumbPct - 50}%`, background: 'rgba(225,29,72,0.15)' }} />
        )}
        {/* Center grip line */}
        <div className="absolute top-2 bottom-2 left-1/2 w-px bg-white/10" />
        {/* Thumb */}
        <div
          className="absolute top-1 bottom-1 rounded-full border border-white/25 transition-colors"
          style={{
            left: `calc(${thumbPct}% - 12px)`,
            width: 24,
            background: `linear-gradient(135deg,${thumbColor},${thumbColor}cc)`,
            boxShadow: `0 0 12px ${thumbColor}50, 0 2px 4px rgba(0,0,0,0.6)`,
          }}
        >
          <div className="absolute w-full h-px bg-black/30 top-1/2" />
        </div>
      </div>

      <div className="text-[8px] font-mono text-white/20">
        {Math.abs(value) < 0.03 ? 'CENTER' : value < 0 ? `← A  ${Math.round(Math.abs(value) * 100)}%` : `${Math.round(value * 100)}%  B →`}
      </div>
    </div>
  );
}

// ─── Channel Strip ─────────────────────────────────────────────────────────────
// layout 'row' lays the EQ, filter and fader side by side for the low tablet mixer strip.
function ChannelStrip({ deckId, label, color, layout = 'column' }: { deckId: 'A' | 'B'; label: string; color: string; layout?: 'column' | 'row' }) {
  // Flat primitive selectors only — never return new object literals inside useShallow
  const track      = useDeckStore(s => deckId === 'A' ? s.deckA.track      : s.deckB.track);
  const isPlaying  = useDeckStore(s => deckId === 'A' ? s.deckA.isPlaying  : s.deckB.isPlaying);
  const currentTime= useDeckStore(s => deckId === 'A' ? s.deckA.currentTime: s.deckB.currentTime);
  const duration   = useDeckStore(s => deckId === 'A' ? s.deckA.duration   : s.deckB.duration);
  const vol        = useDeckStore(s => deckId === 'A' ? s.deckA.volume     : s.deckB.volume);
  const setVolume  = useDeckStore(s => s.setVolume);

  // EQ lives in mixerStore — useShallow is safe here because eqA/eqB are stable objects
  const eqHigh = useMixerStore(s => deckId === 'A' ? s.eqA.high : s.eqB.high);
  const eqMid  = useMixerStore(s => deckId === 'A' ? s.eqA.mid  : s.eqB.mid);
  const eqLow  = useMixerStore(s => deckId === 'A' ? s.eqA.low  : s.eqB.low);
  const setEQ  = useMixerStore(s => s.setEQ);

  const [filterVal, setFilterVal] = useState(0);

  // Apply filter value to AudioEngine BiquadFilter node
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const engine = AudioEngine.getInstance();
      const bus = (engine as any).deckFxBuses?.[deckId];
      if (!bus) return;
      const now = engine.context.currentTime;
      if (filterVal < -0.08) {
        bus.filter.type = 'lowpass';
        const freq = 200 + (1 + filterVal) * 17800; // 200Hz at -1, 18kHz at 0
        bus.filter.frequency.setTargetAtTime(Math.max(20, freq), now, 0.04);
        bus.filter.Q.setTargetAtTime(1.5, now, 0.04);
      } else if (filterVal > 0.08) {
        bus.filter.type = 'highpass';
        const freq = 20 + filterVal * 4000; // 20Hz at 0, 4kHz at +1
        bus.filter.frequency.setTargetAtTime(freq, now, 0.04);
        bus.filter.Q.setTargetAtTime(1.2, now, 0.04);
      } else {
        bus.filter.type = 'allpass';
        bus.filter.Q.setTargetAtTime(0.5, now, 0.04);
      }
    } catch {
      // AudioEngine may not be initialized yet
    }
  }, [filterVal, deckId]);

  const progress = duration > 0 ? currentTime / duration : 0;
  const nearEnd = progress > 0.85 && isPlaying;

  return (
    <div className="flex flex-col items-center gap-2 min-w-0">
      {/* Label */}
      <div
        className={clsx('text-[8px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full', isPlaying && 'animate-pulse')}
        style={{ color, background: `${color}18` }}
      >
        {label}
      </div>

      {/* Track display + progress */}
      <div className="w-full px-0.5">
        <div
          className={clsx('h-1 w-full rounded-full bg-white/6 overflow-hidden', nearEnd && 'shadow-[0_0_4px_rgba(249,115,22,0.6)]')}
        >
          <div
            className="h-full rounded-full"
            style={{ width: `${progress * 100}%`, background: `linear-gradient(90deg,${color},${color}80)`, transition: 'width 0.1s linear' }}
          />
        </div>
        <div className="text-[7px] text-white/15 mt-0.5 truncate text-center">{track?.title ?? '—'}</div>
      </div>

      <div className={clsx('flex items-center', layout === 'row' ? 'flex-row items-end gap-2' : 'flex-col gap-2')}>
        {/* 3-Band EQ with Kill */}
        <div className="flex items-end gap-1.5">
          <EQKnob label="HI"  value={eqHigh} onChange={v => setEQ(deckId, 'high', v)} color={color} />
          <EQKnob label="MID" value={eqMid}  onChange={v => setEQ(deckId, 'mid',  v)} color={color} />
          <EQKnob label="LO"  value={eqLow}  onChange={v => setEQ(deckId, 'low',  v)} color={color} />
        </div>

        {/* Filter knob */}
        <FilterKnob value={filterVal} onChange={setFilterVal} />

        {/* Channel Fader — drives deckStore.volume → useDeckAudio picks it up */}
        <ChannelFader value={vol} onChange={v => setVolume(deckId, v)} color={color} />
      </div>
    </div>
  );
}

// ─── Main Mixer ────────────────────────────────────────────────────────────────
/**
 * layout 'strip': a low, wide mixer for a portrait tablet, where the decks take the top of the
 * screen. Channel A | crossfader | channel B in one row instead of stacked columns.
 */
export function Mixer({ compact = false, layout = 'full' }: Readonly<{ compact?: boolean; layout?: 'full' | 'strip' }>) {
  const crossfader       = useMixerStore(s => s.crossfader);
  const crossfaderCurve  = useMixerStore(s => s.crossfaderCurve);
  const vaultAmbience    = useMixerStore(s => s.vaultAmbience);
  const volA             = useMixerStore(s => s.volA);
  const volB             = useMixerStore(s => s.volB);
  const setCrossfader    = useMixerStore(s => s.setCrossfader);
  const setCrossfaderCurve = useMixerStore(s => s.setCrossfaderCurve);

  const { crossfaderCurve: uiCurve } = useUIStore();
  const cuesByTrack  = useTrackCueStore(s => s.cuesByTrack);
  // Only the fields needed for session-save — not the full tick-heavy currentTime object
  const deckATrack   = useDeckStore(s => s.deckA.track);
  const deckAPlaying = useDeckStore(s => s.deckA.isPlaying);
  const deckBTrack   = useDeckStore(s => s.deckB.track);
  const deckBPlaying = useDeckStore(s => s.deckB.isPlaying);
  const libraryTracks = useLibraryStore(s => s.tracks);

  const { isSupported: isMIDISupported, isConnecting: isMIDIConnecting, isConnected: isMIDIConnected, devices: midiDevices, connect: connectMIDI } = useMIDIManager();
  const [cratePrompt, setCratePrompt] = useState(DEFAULT_AI_CRATE_PROMPT);
  const [activeTab, setActiveTab] = useState<'mix' | 'crate'>('mix');

  const aiCrate = useMemo(() => buildAICrate(libraryTracks, cratePrompt, { limit: 4, vaultOnly: true }), [cratePrompt, libraryTracks]);

  // Keep crossfader curve in sync with settings panel
  useEffect(() => { if (uiCurve !== crossfaderCurve) setCrossfaderCurve(uiCurve); }, [uiCurve, crossfaderCurve, setCrossfaderCurve]);

  useEffect(() => { ensureSessionSync(); }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      // Read full deck state at save-time from store directly — avoids making Mixer
      // re-render on every 30Hz currentTime tick just for the session snapshot.
      const { deckA, deckB } = useDeckStore.getState();
      saveSessionState(buildSessionState({
        deckA, deckB,
        mixer: { crossfader, crossfaderCurve, vaultAmbience, volumes: { A: volA, B: volB } },
        cuesByTrack,
      }));
    }, 120);
    return () => window.clearTimeout(t);
  }, [crossfader, crossfaderCurve, cuesByTrack, deckATrack, deckBTrack, vaultAmbience, volA, volB]);

  // NOTE: Do NOT apply crossfader to AudioEngine here.
  // useDeckAudio already applies it via its own effect that watches crossfader + crossfaderCurve.
  // Only update mixerStore state — the hook picks it up.

  // Neural mode stem adjustment — this is an extra effect on top of what useDeckAudio does
  useEffect(() => {
    if (crossfaderCurve !== 'neural') return;
    if (typeof window === 'undefined') return;
    try {
      const engine = AudioEngine.getInstance();
      const stemGains = calculateNeuralGains(crossfader);
      (['drums', 'inst', 'vocals'] as const).forEach(stem => {
        engine.setStemContribution('A', stem, stemGains[stem].a, { rampSeconds: 0.012 });
        engine.setStemContribution('B', stem, stemGains[stem].b, { rampSeconds: 0.012 });
      });
    } catch {
      // AudioEngine not ready
    }
  }, [crossfader, crossfaderCurve]);

  return (
    <div className="w-full flex flex-col gap-3">
      {/* Tab selector */}
      <div className="flex items-center gap-1 justify-center flex-wrap">
        <button
          type="button"
          onClick={() => setActiveTab('mix')}
          className={clsx('flex items-center gap-1 text-[9px] font-black uppercase px-2.5 py-1 rounded-full border transition-all',
            activeTab === 'mix' ? 'bg-white/12 border-white/25 text-white' : 'border-white/8 text-white/20 hover:text-white/50'
          )}
        >
          <Sliders className="w-3 h-3" /> MIX
        </button>
        <MixOpportunityBadge />
        <button
          type="button"
          onClick={() => setActiveTab('crate')}
          className={clsx('flex items-center gap-1 text-[9px] font-black uppercase px-2.5 py-1 rounded-full border transition-all',
            activeTab === 'crate' ? 'bg-yellow-500/15 border-yellow-500/35 text-yellow-400' : 'border-white/8 text-white/20 hover:text-white/50'
          )}
        >
          <Cpu className="w-3 h-3" /> AI
        </button>
        {/* MIDI quick connect */}
        {isMIDISupported && (
          <button
            type="button"
            onClick={() => void connectMIDI()}
            disabled={isMIDIConnecting || isMIDIConnected}
            className={clsx(
              'text-[7px] font-black uppercase px-2 py-1 rounded-full border transition-all',
              isMIDIConnected ? 'border-green-500/40 bg-green-500/8 text-green-400' : 'border-white/8 text-white/20 hover:text-white/50'
            )}
          >
            {isMIDIConnecting ? '⟳' : isMIDIConnected ? `MIDI ✓${midiDevices.length > 0 ? ` (${midiDevices.length})` : ''}` : 'MIDI'}
          </button>
        )}
      </div>

      <AnimatePresence mode="wait">
        {activeTab === 'mix' && (
          <motion.div
            key="mix"
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.12 }}
          >
            {layout === 'strip' ? (
              <div className="flex items-end justify-between gap-3 px-1">
                <ChannelStrip deckId="A" label="DECK A" color="#D4AF37" layout="row" />
                <div className="flex-1 min-w-[160px] max-w-xs self-center rounded-2xl border border-white/8 bg-black/40 backdrop-blur-sm p-3">
                  <Crossfader
                    value={crossfader}
                    onChange={setCrossfader}
                    curve={crossfaderCurve}
                    onCurveChange={(c) => {
                      setCrossfaderCurve(c);
                    }}
                  />
                </div>
                <ChannelStrip deckId="B" label="DECK B" color="#E11D48" layout="row" />
              </div>
            ) : (<>
            {/* Channel Strips + Master Meter */}
            <div className="flex items-start justify-between gap-1 px-1">
              <ChannelStrip deckId="A" label="DECK A" color="#D4AF37" />

              {/* Master meter center column */}
              <div className="flex flex-col items-center gap-2 flex-shrink-0 pt-6">
                <span className="text-[6px] uppercase tracking-widest text-white/15">OUT</span>
                <MasterMeter />
              </div>

              <ChannelStrip deckId="B" label="DECK B" color="#E11D48" />
            </div>

            {/* Crossfader */}
            <div className="mt-3 mx-1 rounded-2xl border border-white/8 bg-black/40 backdrop-blur-sm p-3">
              <p className="text-[7px] uppercase tracking-[0.25em] text-white/15 text-center mb-2">CROSSFADER</p>
              <Crossfader
                value={crossfader}
                onChange={setCrossfader}
                curve={crossfaderCurve}
                onCurveChange={(c) => {
                  setCrossfaderCurve(c);
                }}
              />
            </div>
            </>)}
          </motion.div>
        )}

        {activeTab === 'crate' && (
          <motion.div
            key="crate"
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.12 }}
            className="px-2 flex flex-col gap-3"
          >
            <div className="flex items-center gap-2">
              <Music2 className="w-3.5 h-3.5 text-yellow-400/70" />
              <span className="text-[9px] font-black uppercase tracking-widest text-white/40">AI Assistant Crate</span>
            </div>
            <input
              value={cratePrompt}
              onChange={e => setCratePrompt(e.target.value)}
              placeholder={DEFAULT_AI_CRATE_PROMPT}
              className="w-full rounded-xl border border-white/10 bg-black/50 px-3 py-2 text-[11px] text-white/70 placeholder:text-white/15 outline-none focus:border-yellow-500/30"
            />
            <div className="space-y-1.5">
              {aiCrate.matches.length > 0 ? aiCrate.matches.map(({ track, reasons, score }) => (
                <div key={track.id} className="flex items-center gap-2 rounded-xl border border-white/6 bg-white/3 px-2.5 py-2">
                  <div
                    className="w-6 h-6 rounded flex-shrink-0"
                    style={{ background: track.artworkUrl ? `url(${track.artworkUrl}) center/cover` : '#1e293b' }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[10px] font-bold text-white/75">{track.title}</p>
                    <p className="truncate text-[8px] text-white/25">{track.bpm} BPM · {reasons[0]}</p>
                  </div>
                  <span className="text-[7px] font-mono text-yellow-400/50">{Math.round(score * 100)}%</span>
                </div>
              )) : (
                <div className="text-center py-4 text-[10px] text-white/20">No matching tracks found.</div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
