'use client';

import { useEffect, useState } from 'react';
import { layoutFitFor, type LayoutFit } from '@/lib/layoutTier';

// Server render and first client render both use the desktop layout, so hydration matches;
// the real fit is applied right after mount.
const INITIAL_FIT: LayoutFit = { tier: 'desktop', mixerPlacement: 'between' };

export function useLayoutFit(): LayoutFit {
  const [fit, setFit] = useState<LayoutFit>(INITIAL_FIT);

  useEffect(() => {
    const update = () => {
      const next = layoutFitFor(window.innerWidth, window.innerHeight);
      setFit((prev) => (prev.tier === next.tier && prev.mixerPlacement === next.mixerPlacement ? prev : next));
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return fit;
}
