'use client';

import { useDeckStore } from '@/store/deckStore';
import { beatIndexAt } from '@/lib/beatGrid';

/** Standard phrase length in beats (8 bars × 4 beats). Most electronic/pop music uses 8-bar phrases. */
const BEATS_PER_PHRASE = 32;
/** Alert threshold: pulse red when this many bars or fewer remain */
const URGENT_BARS_THRESHOLD = 4;

interface PhraseDisplayProps {
  bpm: number;
  deckId: 'A' | 'B';
  label: string;
}

/**
 * Predictive Phrase Display: shows remaining bars in a 32-beat phrase.
 * Pulses red when 4 bars (16 beats) remain.
 *
 * Subscribes to `currentTime` directly from deckStore so the parent component does NOT
 * need to forward it — isolating the 30 Hz re-renders to this small component only.
 */
export function PhraseDisplay({ bpm, deckId, label }: Readonly<PhraseDisplayProps>) {
  const currentTime = useDeckStore(
    (s) => (deckId === 'A' ? s.deckA.currentTime : s.deckB.currentTime),
  );
  // Phrases count from the analysed first beat (0:00 until the track has a grid).
  const firstBeatSec = useDeckStore(
    (s) => (deckId === 'A' ? s.deckA.beatGrid : s.deckB.beatGrid)?.firstBeatSec ?? 0,
  );

  if (!bpm || bpm <= 0) return null;

  const currentBeat = beatIndexAt(currentTime, { bpm, firstBeatSec });
  const beatInPhrase = ((currentBeat % BEATS_PER_PHRASE) + BEATS_PER_PHRASE) % BEATS_PER_PHRASE;
  const beatsRemaining = BEATS_PER_PHRASE - beatInPhrase;
  const barsRemaining = Math.ceil(beatsRemaining / 4);

  const isUrgent = barsRemaining <= URGENT_BARS_THRESHOLD;

  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1 rounded font-mono text-[10px] font-bold tracking-wider transition-all ${
        isUrgent
          ? 'bg-red-500/20 text-red-400 border border-red-500/40 animate-pulse shadow-[0_0_8px_rgba(255,0,0,0.3)]'
          : 'bg-white/5 text-slate-400 border border-white/10'
      }`}
    >
      <span className="text-[8px] opacity-60">{label}</span>
      <span>{barsRemaining} {barsRemaining === 1 ? 'BAR' : 'BARS'} TO DROP</span>
    </div>
  );
}
