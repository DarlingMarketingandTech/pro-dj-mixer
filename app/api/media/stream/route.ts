import { NextRequest, NextResponse } from 'next/server';
import { isApprovedMediaProvider, parseProviderFromUrl } from '@/lib/mediaSources';

const API_KEY = process.env.MEDIA_PROXY_KEY || process.env.VAULT_KEY;

const ALLOWED_AUDIO_TYPES = new Set(['audio/mpeg', 'audio/mp4', 'audio/mp3', 'audio/wav', 'audio/flac', 'audio/ogg', 'audio/webm']);

const proxyFetch = async (url: string) => {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; pro-dj-mixer/1.0)',
      Accept: 'audio/*,*/*;q=0.8',
    },
  });

  if (!response.ok) {
    throw new Error(`Media fetch failed with status ${response.status}`);
  }

  return response;
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  const providedKey = req.headers.get('x-media-key') || req.headers.get('x-syndicate-key');
  if (API_KEY && (!providedKey || providedKey !== API_KEY)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const provider = req.nextUrl.searchParams.get('provider');
  const sourceUrl = req.nextUrl.searchParams.get('sourceUrl');

  if (!provider || !sourceUrl) {
    return NextResponse.json({ error: 'provider and sourceUrl are required' }, { status: 400 });
  }

  if (!isApprovedMediaProvider(provider)) {
    return NextResponse.json({ error: `Provider not approved: ${provider}` }, { status: 400 });
  }

  const resolvedProvider = parseProviderFromUrl(sourceUrl) ?? provider;
  if (!isApprovedMediaProvider(resolvedProvider)) {
    return NextResponse.json({ error: 'Unsupported media provider.' }, { status: 400 });
  }

  try {
    const upstream = await proxyFetch(sourceUrl);
    const contentType = upstream.headers.get('content-type') ?? 'audio/mpeg';
    const normalizedType = contentType.split(';')[0].trim().toLowerCase();
    if (normalizedType && !ALLOWED_AUDIO_TYPES.has(normalizedType)) {
      return NextResponse.json({ error: 'Unsupported media content type' }, { status: 415 });
    }

    const headers = new Headers();
    headers.set('Content-Type', normalizedType || 'audio/mpeg');
    headers.set('Cache-Control', 'private, max-age=3600');
    headers.set('Access-Control-Allow-Origin', '*');

    const arrayBuffer = await upstream.arrayBuffer();
    return new NextResponse(Buffer.from(arrayBuffer), {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error('[media/stream] proxy failure:', error);
    return NextResponse.json({ error: 'Unable to proxy media stream' }, { status: 502 });
  }
}
