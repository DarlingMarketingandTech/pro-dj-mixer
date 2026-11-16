'use client';

import { useEffect, useRef } from 'react';
import { X, BookOpen } from 'lucide-react';
import { Library } from '@/components/Library';
import { useLayoutFit } from '@/hooks/useLayoutFit';

interface LibraryOverlayProps {
  isOpen: boolean;
  onClose: () => void;
}

export function LibraryOverlay({ isOpen, onClose }: LibraryOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  // On a phone the crates sidebar took half the width and pushed BPM, key and the + menu off-screen.
  const isPhone = useLayoutFit().tier === 'phone';

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  // Close on backdrop click
  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === overlayRef.current) onClose();
  };

  if (!isOpen) return null;

  return (
    <div
      ref={overlayRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center"
      style={{
        background: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Track Library"
    >
      <div
        className="relative w-full sm:w-[95vw] sm:max-w-5xl flex flex-col rounded-t-2xl sm:rounded-2xl border border-studio-gold/20 shadow-2xl overflow-hidden"
        style={{
          background: 'linear-gradient(135deg, rgba(15,15,20,0.97) 0%, rgba(20,20,30,0.97) 100%)',
          maxHeight: '90vh',
          ...(isPhone ? { height: '90vh' } : {}),
          boxShadow: '0 0 60px rgba(212,175,55,0.08), 0 25px 50px rgba(0,0,0,0.8)',
        }}
      >
        {/* Header */}
        <div className="flex-shrink-0 flex items-center justify-between px-5 py-3 border-b border-studio-gold/15">
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-studio-gold" />
            <span className="text-sm font-black tracking-[0.18em] uppercase oled-display text-white">
              Velocity Browser
            </span>
          </div>
          <div className="flex items-center gap-3">
            {/* Deck load hint badges */}
            <span className="hidden sm:flex items-center gap-1 px-2 py-0.5 rounded text-[10px] tracking-widest uppercase text-studio-gold/60 border border-studio-gold/20">
              [A] → Deck A
            </span>
            <span className="hidden sm:flex items-center gap-1 px-2 py-0.5 rounded text-[10px] tracking-widest uppercase text-studio-gold/60 border border-studio-gold/20">
              [B] → Deck B
            </span>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg transition-colors text-slate-400 hover:text-white hover:bg-white/10"
              aria-label="Close library"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Library content */}
        <div className="flex-1 min-h-0 overflow-hidden" style={{ touchAction: 'pan-y' }}>
          <Library compact={isPhone} />
        </div>
      </div>
    </div>
  );
}
