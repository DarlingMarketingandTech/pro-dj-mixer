/**
 * The mixer is served under this path (Next.js `basePath`) so it can live at
 * the Piko FG site's /studio/dj through Next.js Multi-Zones.
 *
 * next/link and the router add it automatically. Raw URLs do not: fetch(),
 * workers, audio worklets, the service worker, metadata, and CSS backgrounds
 * must go through `withBasePath`. No imports, so tests can load it in plain Node.
 */
export const BASE_PATH = '/studio/dj';

export const withBasePath = (path: string) => `${BASE_PATH}${path}`;
