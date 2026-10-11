'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Deck } from '@/components/Deck';
import { AudioStats } from '@/components/AudioStats';
import { Mixer } from '@/components/Mixer';
import { ParallelWaveforms } from '@/components/ParallelWaveforms';
import { PhraseDisplay } from '@/components/PhraseDisplay';
import { RemixGrid } from '@/components/RemixGrid';
import { Layout as PerformanceLayout } from '@/components/Layout';
import { clsx } from 'clsx';
import { useUIStore } from '@/store/uiStore';
import { useDeckStore, getDeckBpm } from '@/store/deckStore';
import { useShallow } from 'zustand/react/shallow';
import { AddMusicModal } from '@/components/AddMusicModal';
import { Library } from '@/components/Library';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { ViewControls } from '@/components/ViewControls';
import { MobileNav } from '@/components/MobileNav';
import { LibraryOverlay } from '@/components/LibraryOverlay';
import { RecordingStatusBar } from '@/components/RecordingStatusBar';
import { useLayoutFit } from '@/hooks/useLayoutFit';

export default function Home() {
  useKeyboardShortcuts();

  const {
    isWaveformVisible,
    isDeckAVisible,
    isDeckBVisible,
    isMixerVisible,
    isAddMusicModalOpen,
    isPerformanceMode,
    isLibraryOverlayOpen,
    activeTab,
    setActiveTab,
    setIsLibraryOverlayOpen,
    toggleWaveform,
    togglePerformanceMode,
    layoutMode,
  } = useUIStore();

  // Omit currentTime from these selectors — PhraseDisplay subscribes to it directly,
  // isolating the 30 Hz re-renders to that small component instead of the whole page.
  const deckA = useDeckStore(useShallow((s) => ({ isPlaying: s.deckA.isPlaying, bpm: getDeckBpm(s.deckA) })));
  const deckB = useDeckStore(useShallow((s) => ({ isPlaying: s.deckB.isPlaying, bpm: getDeckBpm(s.deckB) })));

  const { tier, mixerPlacement } = useLayoutFit();
  const isCompactViewport = tier === 'phone';
  const [isRemixDrawerOpen, setIsRemixDrawerOpen] = useState(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    // The worker serves /_next/static cache-first; dev chunk URLs never change, so in development
    // every load would run the previous build. Only register it in production, and remove any
    // worker a dev session already installed.
    if (process.env.NODE_ENV !== 'production') {
      void navigator.serviceWorker.getRegistrations().then((registrations) =>
        registrations.forEach((registration) => void registration.unregister()));
      return;
    }
    void navigator.serviceWorker.register('/sw.js');
  }, []);

  return (
    <div
      className="h-screen overflow-hidden flex flex-col bg-studio-black relative"
      style={{ touchAction: 'none' }}
    >
      <main className="flex-1 flex flex-col relative min-h-0">
        <ViewControls variant={tier} />
        <div className={
          tier === 'phone'
            ? 'flex-1 flex flex-col gap-3 px-3 pb-[calc(3.5rem+env(safe-area-inset-bottom))] pt-14 overflow-hidden min-w-0'
            : tier === 'tablet'
              ? 'flex-1 flex flex-col gap-3 px-3 pb-3 pt-14 overflow-hidden min-w-0'
              : 'flex-1 flex flex-col gap-4 p-4 overflow-hidden min-w-0'
        }>
          {isCompactViewport ? (
            <>
              {/* Waveforms — smooth collapse via max-h transition.
                  160px safely exceeds ParallelWaveforms compact max-height (h-24 = 96px). */}
              <div
                className="flex-shrink-0 overflow-hidden transition-all duration-300 ease-in-out"
                style={{ maxHeight: (isWaveformVisible || isPerformanceMode) ? '160px' : '0px' }}
              >
                <ParallelWaveforms compact />
              </div>

              {/* The active panel scrolls when it is taller than the screen (a phone on its side). */}
              <div className={activeTab === 'DECK_A' ? PHONE_PANEL : 'hidden'}>
                {isDeckAVisible && <Deck deckId="A" compact />}
              </div>
              <div className={activeTab === 'MIXER' ? PHONE_PANEL : 'hidden'}>
                {isMixerVisible && <Mixer compact />}
              </div>
              <div className={activeTab === 'DECK_B' ? PHONE_PANEL : 'hidden'}>
                {isDeckBVisible && <Deck deckId="B" compact />}
              </div>
            </>
          ) : tier === 'tablet' ? (
            <TabletLayout
              mixerPlacement={mixerPlacement}
              showWaveforms={isWaveformVisible || isPerformanceMode}
              deckA={isDeckAVisible ? <Deck deckId="A" compact /> : null}
              mixer={isMixerVisible ? <Mixer compact layout={mixerPlacement === 'below' ? 'strip' : 'full'} /> : null}
              deckB={isDeckBVisible ? <Deck deckId="B" compact /> : null}
            />
          ) : (
            <div className="flex-1 flex flex-col gap-4 overflow-y-auto pr-1 min-h-0 min-w-0 overflow-x-hidden">
              {(isWaveformVisible || isPerformanceMode) && (
                <PerformanceLayout
                  isPerformanceMode={isPerformanceMode}
                  onTogglePerformanceMode={togglePerformanceMode}
                  isWaveformVisible={isWaveformVisible}
                  onToggleWaveform={toggleWaveform}
                  isRemixOpen={isRemixDrawerOpen}
                  onToggleRemix={() => setIsRemixDrawerOpen((prev) => !prev)}
                  phraseBadges={(
                    <>
                      {deckA.isPlaying && deckA.bpm > 0 && (
                        <PhraseDisplay bpm={deckA.bpm} deckId="A" label="A" />
                      )}
                      {deckB.isPlaying && deckB.bpm > 0 && (
                        <PhraseDisplay bpm={deckB.bpm} deckId="B" label="B" />
                      )}
                    </>
                  )}
                  waveformContent={<ParallelWaveforms />}
                  remixContent={<RemixGrid />}
                />
              )}

              <div className={clsx(
                "flex-1 w-full max-w-[1920px] mx-auto gap-6 min-h-0",
                layoutMode === 'LIBRARY' ? "flex flex-col" : "grid grid-cols-1 xl:grid-cols-[minmax(420px,1fr)_minmax(360px,0.9fr)_minmax(420px,1fr)]"
              )}>
                {/* Deck A */}
                <div className={clsx(
                  "flex flex-col justify-center",
                  layoutMode === 'LIBRARY' ? "h-auto" : "h-full order-1 md:order-1",
                  layoutMode === 'MIXER' && "xl:scale-95 origin-right"
                )}>
                  {isDeckAVisible && (
                    <div className="bg-studio-slate/90 backdrop-blur-xl rounded-2xl border border-studio-gold/20 shadow-2xl overflow-visible">
                      <div className="p-4 border-b border-studio-gold/20 flex items-center justify-between">
                        <h2 className="text-sm font-bold text-white tracking-tight">DECK A</h2>
                        {layoutMode === 'LIBRARY' && <div className="text-[10px] text-studio-gold font-mono">COMPACT VIEW</div>}
                      </div>
                      <div className="p-4">
                        <Deck deckId="A" compact={layoutMode === 'LIBRARY'} />
                      </div>
                    </div>
                  )}
                </div>

                {/* Center Content: Mixer or Library */}
                <div className={clsx(
                  "flex flex-col justify-center",
                  layoutMode === 'LIBRARY' ? "flex-1 min-h-[400px]" : "h-full order-3 md:order-3 xl:order-2"
                )}>
                  {layoutMode === 'LIBRARY' ? (
                    <div className="flex-1 bg-studio-slate/95 backdrop-blur-2xl rounded-2xl border border-studio-gold/30 shadow-2xl overflow-hidden flex flex-col">
                      <div className="p-4 border-b border-studio-gold/30 flex justify-between items-center bg-black/20">
                        <h2 className="text-sm font-bold text-studio-gold tracking-widest uppercase">Global Track Library</h2>
                      </div>
                      <div className="flex-1 min-h-0">
                        <Library />
                      </div>
                    </div>
                  ) : (
                    isMixerVisible && (
                      <div className={clsx(
                        "bg-studio-slate/90 backdrop-blur-xl rounded-2xl border border-studio-gold/20 shadow-2xl overflow-visible transition-all",
                        layoutMode === 'MIXER' ? "xl:scale-105" : ""
                      )}>
                        <div className="p-4 border-b border-studio-gold/20 flex justify-between items-center">
                          <h2 className="text-sm font-bold text-white tracking-tight">MIXER</h2>
                        </div>
                        <div className="p-4">
                          <Mixer />
                        </div>
                      </div>
                    )
                  )}
                </div>

                {/* Deck B */}
                <div className={clsx(
                  "flex flex-col justify-center",
                  layoutMode === 'LIBRARY' ? "h-auto" : "h-full order-2 md:order-2 xl:order-3",
                  layoutMode === 'MIXER' && "xl:scale-95 origin-left"
                )}>
                  {isDeckBVisible && (
                    <div className="bg-studio-slate/90 backdrop-blur-xl rounded-2xl border border-studio-gold/20 shadow-2xl overflow-visible">
                      <div className="p-4 border-b border-studio-gold/20 flex items-center justify-between">
                        <h2 className="text-sm font-bold text-white tracking-tight">DECK B</h2>
                        {layoutMode === 'LIBRARY' && <div className="text-[10px] text-studio-gold font-mono">COMPACT VIEW</div>}
                      </div>
                      <div className="p-4">
                        <Deck deckId="B" compact={layoutMode === 'LIBRARY'} />
                      </div>
                    </div>
                  )}
                </div>
              </div>

            </div>
          )}
        </div>
      </main>
      <RecordingStatusBar />
      {isCompactViewport && (
        <MobileNav
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onOpenLibrary={() => setIsLibraryOverlayOpen(true)}
        />
      )}
      <LibraryOverlay
        isOpen={isLibraryOverlayOpen}
        onClose={() => setIsLibraryOverlayOpen(false)}
      />
      {isAddMusicModalOpen && <AddMusicModal />}
      {/* Diagnostics badge, pinned bottom-left: on a phone it covers the tab bar and on a tablet the Deck A EQ. */}
      {tier === 'desktop' && <AudioStats />}
    </div>
  );
}

const PHONE_PANEL = 'flex-1 min-h-0 overflow-y-auto overscroll-contain';

const TABLET_PANEL =
  'min-h-0 min-w-0 overflow-y-auto overscroll-contain rounded-2xl border border-studio-gold/20 bg-studio-slate/90 py-3 shadow-2xl';

/**
 * Both decks and the mixer on one screen, with no page scroll: the crossfader and both Play
 * buttons are always reachable. A column taller than the screen scrolls on its own.
 * 'between': Deck A | Mixer | Deck B. 'below': the decks side by side, the mixer under them.
 * Hidden panels (the A / MX / B toggles) give their space to the others.
 */
function TabletLayout({ mixerPlacement, showWaveforms, deckA, mixer, deckB }: {
  mixerPlacement: 'between' | 'below';
  showWaveforms: boolean;
  deckA: ReactNode;
  mixer: ReactNode;
  deckB: ReactNode;
}) {
  const decks = [deckA, deckB].filter(Boolean);
  const between = mixerPlacement === 'between';

  const columns = between
    ? [deckA && 'minmax(0,1fr)', mixer && 'minmax(300px,0.85fr)', deckB && 'minmax(0,1fr)'].filter(Boolean).join(' ')
    : decks.map(() => 'minmax(0,1fr)').join(' ') || 'minmax(0,1fr)';

  return (
    <>
      {showWaveforms && (
        <div className="flex-shrink-0">
          <ParallelWaveforms compact />
        </div>
      )}
      {between ? (
        <div className="flex-1 min-h-0 grid gap-3" style={{ gridTemplateColumns: columns }}>
          {deckA && <div className={TABLET_PANEL}>{deckA}</div>}
          {mixer && <div className={clsx(TABLET_PANEL, 'px-1')}>{mixer}</div>}
          {deckB && <div className={TABLET_PANEL}>{deckB}</div>}
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col gap-3">
          {decks.length > 0 && (
            <div className="flex-1 min-h-0 grid gap-3" style={{ gridTemplateColumns: columns }}>
              {deckA && <div className={TABLET_PANEL}>{deckA}</div>}
              {deckB && <div className={TABLET_PANEL}>{deckB}</div>}
            </div>
          )}
          {mixer && (
            <div className={clsx(TABLET_PANEL, 'flex-shrink-0 px-1', decks.length > 0 ? 'max-h-[40%]' : 'flex-1')}>
              {mixer}
            </div>
          )}
        </div>
      )}
    </>
  );
}
