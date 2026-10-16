import { NextResponse } from 'next/server';
import { isApprovedMediaProvider, parseProviderFromUrl } from '@/lib/mediaSources';
import { withBasePath } from '@/lib/basePath';

const API_KEY = process.env.MEDIA_PROXY_KEY || process.env.VAULT_KEY;

const SUPPORTED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'soundcloud.com',
  'm.soundcloud.com',
]);

export async function POST(req: Request): Promise<NextResponse> {
  const providedKey = req.headers.get('x-media-key') || req.headers.get('x-syndicate-key');
  if (API_KEY && (!providedKey || providedKey !== API_KEY)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { sourceUrl } = body as Record<string, unknown>;
  if (typeof sourceUrl !== 'string' || !sourceUrl.trim()) {
    return NextResponse.json({ error: '"sourceUrl" must be a non-empty string' }, { status: 400 });
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(sourceUrl);
  } catch {
    return NextResponse.json({ error: 'Invalid sourceUrl' }, { status: 400 });
  }

  if (!SUPPORTED_HOSTS.has(parsedUrl.hostname.toLowerCase())) {
    return NextResponse.json({ error: 'Unsupported media provider host' }, { status: 400 });
  }

  const provider = parseProviderFromUrl(sourceUrl);
  if (!provider || !isApprovedMediaProvider(provider)) {
    return NextResponse.json({ error: `Provider not approved: ${provider ?? 'unknown'}` }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    provider,
    sourceUrl,
    proxyUrl: withBasePath(`/api/media/stream?provider=${encodeURIComponent(provider)}&sourceUrl=${encodeURIComponent(sourceUrl)}`),
    licenseStatus: 'licensed',
    title: 'Resolved via media proxy',
    artist: 'Approved source',
  });
}
