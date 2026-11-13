import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutFitFor } from '../lib/layoutTier.ts';

const tier = (w: number, h: number) => layoutFitFor(w, h).tier;

test('phones get the tabbed layout in both orientations', () => {
  assert.equal(tier(375, 812), 'phone');
  assert.equal(tier(390, 844), 'phone');
  // Wider than 768 but far too short for a deck: still a phone.
  assert.equal(tier(812, 375), 'phone');
  assert.equal(tier(932, 430), 'phone');
});

test('tablets and narrow windows get the one-screen tablet layout', () => {
  assert.equal(tier(768, 1024), 'tablet');
  assert.equal(tier(834, 1194), 'tablet');
  assert.equal(tier(1024, 768), 'tablet');
  assert.equal(tier(1180, 820), 'tablet');
  // A half-width laptop window behaves like a tablet too.
  assert.equal(tier(960, 1000), 'tablet');
});

test('wide screens keep the desktop layout', () => {
  assert.equal(tier(1280, 800), 'desktop');
  assert.equal(tier(1366, 1024), 'desktop');
  assert.equal(tier(1920, 1080), 'desktop');
});

test('tablet mixer sits between the decks only when three columns fit', () => {
  // Portrait tablets: decks side by side, mixer below.
  assert.deepEqual(layoutFitFor(768, 1024), { tier: 'tablet', mixerPlacement: 'below' });
  assert.deepEqual(layoutFitFor(834, 1194), { tier: 'tablet', mixerPlacement: 'below' });
  // Landscape tablets and a 1024-wide portrait iPad Pro: Deck A | Mixer | Deck B.
  assert.deepEqual(layoutFitFor(1024, 768), { tier: 'tablet', mixerPlacement: 'between' });
  assert.deepEqual(layoutFitFor(1024, 1366), { tier: 'tablet', mixerPlacement: 'between' });
  assert.deepEqual(layoutFitFor(1180, 820), { tier: 'tablet', mixerPlacement: 'between' });
  // A landscape window too narrow for three columns stacks the mixer instead.
  assert.deepEqual(layoutFitFor(900, 600), { tier: 'tablet', mixerPlacement: 'below' });
});

test('the boundaries fall exactly on the breakpoints', () => {
  assert.equal(tier(767, 1024), 'phone');
  assert.equal(tier(768, 1024), 'tablet');
  assert.equal(tier(1279, 900), 'tablet');
  assert.equal(tier(1280, 900), 'desktop');
  assert.equal(tier(1000, 540), 'phone');
  assert.equal(tier(1000, 541), 'tablet');
  assert.equal(layoutFitFor(959, 1000).mixerPlacement, 'below');
  assert.equal(layoutFitFor(960, 1000).mixerPlacement, 'between');
});
