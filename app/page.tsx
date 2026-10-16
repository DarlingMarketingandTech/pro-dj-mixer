'use client';

import { useEffect, useState } from 'react';
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
import { withBasePath } from '@/lib/basePath';

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

  const [isCompactViewport, setIsCompactViewport] = useState(false);
  const [isRemixDrawerOpen, setIsRemixDrawerOpen] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(orientation: landscape) and (max-height: 540px), (max-width: 767px)');
    const updateCompactViewport = () => setIsCompactViewport(mediaQuery.matches);

    updateCompactViewport();
    mediaQuery.addEventListener('change', updateCompactViewport);
    return () => mediaQuery.removeEventListener('change', updateCompactViewport);
  }, []);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    // Before the move to /studio/dj the worker was registered at /sw.js with scope "/".
    // Retire that one so it stops intercepting the rest of the domain.
    void navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) {
        const script = registration.active?.scriptURL ?? registration.waiting?.scriptURL ?? registration.installing?.scriptURL;
        if (script && new URL(script).pathname === '/sw.js') void registration.unregister();
      }
    });
    void navigator.serviceWorker.register(withBasePath('/sw.js'), { scope: withBasePath('') });
  }, []);

  return (
    <div
      className="h-screen overflow-hidden flex flex-col bg-studio-black relative"
      style={{ touchAction: 'none' }}
    >
      <main className="flex-1 flex flex-col relative min-h-0">
        <ViewControls compact={isCompactViewport} />
        <div className={
          isCompactViewport
            ? 'flex-1 flex flex-col gap-3 px-3 pb-[calc(3.5rem+env(safe-area-inset-bottom))] pt-14 overflow-hidden min-w-0'
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

              <div className={activeTab === 'DECK_A' ? 'flex-1 min-h-0 overflow-hidden' : 'hidden'}>
                {isDeckAVisible && <Deck deckId="A" compact />}
              </div>
              <div className={activeTab === 'MIXER' ? 'flex-1 min-h-0 overflow-hidden' : 'hidden'}>
                {isMixerVisible && <Mixer compact />}
              </div>
              <div className={activeTab === 'DECK_B' ? 'flex-1 min-h-0 overflow-hidden' : 'hidden'}>
                {isDeckBVisible && <Deck deckId="B" compact />}
              </div>
            </>
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
      <AudioStats />
    </div>
  );
}
