// Picks the screen layout from the viewport size. Pure, so it can be unit-tested in Node.
//
// Mixxx solves the same problem per widget with WSizeAwareStack: it holds variants ordered
// smallest first and shows the largest one whose minimum size fits, falling back to the
// smallest. Here the variants are whole-page layouts:
//   phone   — one panel at a time behind a bottom tab bar
//   tablet  — both decks and the mixer on one screen, each panel scrolling on its own; the
//             mixer sits between the decks when there's room, otherwise below them
//   desktop — the full three-column performance layout (needs ~1280 px for three full decks)

export type LayoutTier = 'phone' | 'tablet' | 'desktop';
export type MixerPlacement = 'between' | 'below';

export interface LayoutFit {
  tier: LayoutTier;
  /** Tablet only: Deck A | Mixer | Deck B, or the decks side by side with the mixer under them. */
  mixerPlacement: MixerPlacement;
}

/** Narrower than this, a deck and the mixer can't sit side by side. */
export const TABLET_MIN_WIDTH = 768;
/** From this width the desktop grid has room for three full-size columns (Tailwind `xl`). */
export const DESKTOP_MIN_WIDTH = 1280;
/** A landscape screen this short (a phone on its side) can't fit even one deck's controls. */
export const SHORT_LANDSCAPE_MAX_HEIGHT = 540;
/** The mixer needs ~300 px and a compact deck ~330 px, so three columns need this much. */
export const MIXER_BETWEEN_MIN_WIDTH = 960;

export function layoutFitFor(width: number, height: number): LayoutFit {
  const mixerPlacement: MixerPlacement = width >= MIXER_BETWEEN_MIN_WIDTH ? 'between' : 'below';
  const landscape = width > height;
  if (width < TABLET_MIN_WIDTH || (landscape && height <= SHORT_LANDSCAPE_MAX_HEIGHT)) {
    return { tier: 'phone', mixerPlacement };
  }
  if (width < DESKTOP_MIN_WIDTH) return { tier: 'tablet', mixerPlacement };
  return { tier: 'desktop', mixerPlacement };
}
