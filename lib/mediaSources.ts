export type MediaSourceType = 'local' | 'r2' | 'custom-storage' | 'external';
export type MediaProvider = 'r2' | 'custom-s3' | 'youtube' | 'soundcloud' | 'custom' | 'local';
export type MediaLicenseStatus = 'owned' | 'licensed' | 'user-upload' | 'unknown';

export interface NormalizedMediaSource {
  sourceType: MediaSourceType;
  provider: MediaProvider;
  externalId: string;
  sourceUrl: string;
  streamUrl: string | null;
  storageKey?: string;
  licenseStatus: MediaLicenseStatus;
  title?: string;
  artist?: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  requiresServerConfig?: boolean;
}

export const APPROVED_MEDIA_PROVIDERS = new Set<MediaProvider>(['youtube', 'soundcloud', 'r2', 'custom-s3']);

export const parseProviderFromUrl = (sourceUrl: string): MediaProvider | null => {
  if (!sourceUrl) return null;
  const url = sourceUrl.toLowerCase();
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('soundcloud.com')) return 'soundcloud';
  return null;
};

export const isApprovedMediaProvider = (provider?: string | null): boolean => {
  if (!provider) return false;
  return APPROVED_MEDIA_PROVIDERS.has(provider as MediaProvider);
};

export const buildMediaProxyUrl = (provider: string, sourceUrl: string) => {
  const params = new URLSearchParams({
    provider,
    sourceUrl,
  });
  return `/api/media/stream?${params.toString()}`;
};

export const normalizeMediaSource = (input: {
  sourceUrl?: string;
  provider?: string;
  storageKey?: string;
  licenseStatus?: string;
  title?: string;
  artist?: string;
  durationSeconds?: number;
  thumbnailUrl?: string;
}): NormalizedMediaSource => {
  const sourceUrl = typeof input.sourceUrl === 'string' ? input.sourceUrl.trim() : '';
  const explicitProvider = typeof input.provider === 'string' ? input.provider.trim().toLowerCase() : '';
  const provider = explicitProvider || parseProviderFromUrl(sourceUrl) || 'custom';

  if (!sourceUrl) {
    throw new Error('A valid sourceUrl is required.');
  }

  if (!isApprovedMediaProvider(provider) && provider !== 'custom') {
    throw new Error(`Provider "${provider}" is not approved for media proxying.`);
  }

  const sourceType: MediaSourceType = provider === 'r2' || provider === 'custom-s3' ? 'custom-storage' : 'external';
  const licenseStatus = (['owned', 'licensed', 'user-upload', 'unknown'] as const).includes((input.licenseStatus ?? 'unknown') as any)
    ? (input.licenseStatus as MediaLicenseStatus)
    : 'unknown';

  const externalId = (() => {
    const fromUrl = new URL(sourceUrl);
    const host = fromUrl.hostname.replace(/^www\./, '');
    const path = fromUrl.pathname.replace(/\/+$/, '');
    return `${provider}:${host}:${path || fromUrl.search}`;
  })();

  const baseStreamUrl = buildMediaProxyUrl(provider, sourceUrl);

  return {
    sourceType,
    provider: provider as MediaProvider,
    externalId,
    sourceUrl,
    streamUrl: provider === 'youtube' || provider === 'soundcloud' ? baseStreamUrl : sourceUrl,
    storageKey: input.storageKey,
    licenseStatus,
    title: input.title,
    artist: input.artist,
    thumbnailUrl: input.thumbnailUrl,
    durationSeconds: input.durationSeconds,
    requiresServerConfig: provider === 'youtube' || provider === 'soundcloud',
  };
};
