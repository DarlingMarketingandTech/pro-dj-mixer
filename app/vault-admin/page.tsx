'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { withBasePath } from '@/lib/basePath';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UploadPhase = 'idle' | 'signing' | 'uploading' | 'syncing' | 'done' | 'error';

interface VaultTrack {
  title: string;
  artist: string;
  bpm: string;
  key: string;
  audioUrl: string;
  createdAt: number;
}

interface UploadStatus {
  phase: UploadPhase;
  message: string;
  progress: number; // 0–100
  uploadedKey: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * When NEXT_PUBLIC_VAULT_KEY is set, show a hint on the lock screen that a key
 * is configured. Do NOT use it for auth comparisons — the API route enforces
 * the real check via VAULT_KEY (server-only env var).
 */
const VAULT_KEY_CONFIGURED = Boolean(process.env.NEXT_PUBLIC_VAULT_KEY);

const SESSION_KEY = 'vault_syndicate_key';

const ACCEPTED_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/flac',
  'audio/x-flac',
  'audio/ogg',
  'audio/aac',
];

const ACCEPTED_EXTENSIONS = '.mp3,.wav,.flac,.ogg,.aac,.aiff';

const R2_PUBLIC_BASE = 'https://pub-9d6c022e6cbf422ea4fcac0a116cbfce.r2.dev/audio';
// Bucket-level public URL (no key prefix) — used to build audioUrl from a key.
const R2_PUBLIC_ROOT = 'https://pub-9d6c022e6cbf422ea4fcac0a116cbfce.r2.dev';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getFileContentType(file: File): string {
  // Prefer MIME from browser; fall back to extension sniffing
  if (file.type && ACCEPTED_MIME_TYPES.includes(file.type)) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    aac: 'audio/aac',
    aiff: 'audio/x-aiff',
  };
  return (ext && map[ext]) || 'audio/mpeg';
}

/** Derive a display title from a filename by stripping the extension. */
function titleFromFilename(filename: string): string {
  return filename.replace(/\.[^/.]+$/, '').replace(/_/g, ' ');
}



/** Blinking cursor for OLED displays. */
function OledCursor() {
  return (
    <span
      className="inline-block w-2 h-4 ml-0.5 align-middle animate-pulse"
      style={{ background: 'var(--color-studio-gold)' }}
    />
  );
}

/** Single status LED indicator. */
function StatusLed({ active, color }: { active: boolean; color: string }) {
  return (
    <span
      className="inline-block w-2.5 h-2.5 rounded-full border mr-2 transition-all duration-300"
      style={{
        background: active ? color : '#111',
        borderColor: active ? color : '#333',
        boxShadow: active ? `0 0 8px ${color}` : 'none',
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function VaultAdminPage() {
  // ── Auth state ─────────────────────────────────────────────────────────
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [sessionKey, setSessionKey] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [keyError, setKeyError] = useState('');

  // ── Restore session on mount ────────────────────────────────────────────
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(SESSION_KEY);
      if (stored) {
        setSessionKey(stored);
        setIsUnlocked(true);
      }
    } catch {
      // sessionStorage unavailable (e.g. private browsing restrictions) — ignore
    }
  }, []);

  // ── Upload state ───────────────────────────────────────────────────────
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [status, setStatus] = useState<UploadStatus>({
    phase: 'idle',
    message: 'AWAITING INPUT',
    progress: 0,
    uploadedKey: '',
  });

  // ── Track metadata ─────────────────────────────────────────────────────
  const [trackTitle, setTrackTitle] = useState('');
  const [trackArtist, setTrackArtist] = useState('');
  const [trackBpm, setTrackBpm] = useState('');
  const [trackKey, setTrackKey] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  // ── Vault tracks state ────────────────────────────────────────────────
  const [vaultTracks, setVaultTracks] = useState<VaultTrack[]>([]);
  const [tracksLoading, setTracksLoading] = useState(false);
  const [deletingUrl, setDeletingUrl] = useState<string | null>(null);

  // ── Auth handler ───────────────────────────────────────────────────────
  const handleUnlock = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = keyInput.trim();

    if (!trimmed) {
      setKeyError('KEY REQUIRED');
      return;
    }

    // Accept any non-empty key — the server is the sole auth authority.
    // A wrong key will surface as a 401 on the first upload attempt, at
    // which point handleLock() automatically re-locks the UI.

    // Persist the key for this browser session so re-entry is not required
    // per upload. Stored in sessionStorage (cleared on tab close).
    // NOTE: requires HTTPS in production — Vercel enforces this.
    try {
      sessionStorage.setItem(SESSION_KEY, trimmed);
    } catch {
      // Ignore write failures (e.g. private browsing restrictions)
    }
    setSessionKey(trimmed);
    setIsUnlocked(true);
    setKeyError('');
  };

  // ── Lock handler ───────────────────────────────────────────────────────
  const handleLock = useCallback(() => {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // Ignore
    }
    setSessionKey('');
    setIsUnlocked(false);
    setKeyInput('');
    setKeyError('');
    setSelectedFile(null);
    setTrackTitle('');
    setTrackArtist('');
    setTrackBpm('');
    setTrackKey('');
    setStatus({ phase: 'idle', message: 'AWAITING INPUT', progress: 0, uploadedKey: '' });
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  // ── File selection ─────────────────────────────────────────────────────
  const handleFileSelect = useCallback((file: File) => {
    setSelectedFile(file);
    setStatus({ phase: 'idle', message: 'FILE LOADED — READY TO UPLOAD', progress: 0, uploadedKey: '' });
    // Auto-populate title from filename (strip extension) if not already set
    setTrackTitle((prev) => prev || titleFromFilename(file.name));
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleFileSelect(f);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => setIsDragOver(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFileSelect(f);
  };

  // ── Clear file selection (reused in upload/sync error paths) ──────────────
  const clearFileSelection = useCallback(() => {
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  // ── Upload handler ─────────────────────────────────────────────────────
  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile || status.phase === 'uploading' || status.phase === 'signing') return;

    // ── Step 1: Get presigned URL ─────────────────────────────────────────
    setStatus({ phase: 'signing', message: 'REQUESTING UPLOAD CREDENTIAL...', progress: 0, uploadedKey: '' });

    let uploadUrl: string;
    let key: string;

    try {
      const res = await fetch(withBasePath('/api/vault'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-syndicate-key': sessionKey,
        },
        body: JSON.stringify({
          filename: selectedFile.name,
          contentType: getFileContentType(selectedFile),
        }),
      });

      // 401 means the server rejected our key — re-lock to force re-entry
      if (res.status === 401) {
        handleLock();
        return;
      }

      const data = (await res.json()) as { uploadUrl?: string; key?: string; error?: string };

      if (!res.ok || !data.uploadUrl || !data.key) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      uploadUrl = data.uploadUrl;
      key = data.key;
    } catch (err) {
      setStatus({
        phase: 'error',
        message: `CREDENTIAL ERROR: ${(err as Error).message}`,
        progress: 0,
        uploadedKey: '',
      });
      return;
    }

    // ── Step 2: PUT file directly to R2 ──────────────────────────────────
    setStatus({ phase: 'uploading', message: 'UPLOADING TO VAULT...', progress: 0, uploadedKey: '' });

    try {
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhrRef.current = xhr;

        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('Content-Type', getFileContentType(selectedFile));

        xhr.upload.onprogress = (ev: ProgressEvent) => {
          if (ev.lengthComputable) {
            const pct = Math.round((ev.loaded / ev.total) * 100);
            setStatus((prev) => ({ ...prev, message: `UPLOADING... ${pct}%`, progress: pct }));
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`R2 PUT failed — HTTP ${xhr.status}`));
          }
        };

        xhr.onerror = () => reject(new Error('NETWORK ERROR DURING UPLOAD'));
        xhr.onabort = () => reject(new Error('UPLOAD ABORTED'));

        xhr.send(selectedFile);
      });

      setStatus({
        phase: 'syncing',
        message: 'SYNCING LIBRARY MANIFEST...',
        progress: 100,
        uploadedKey: key,
      });

      // ── Step 3: Update library.json manifest ─────────────────────────────
      // Derive the public audioUrl from the R2 object key using the bucket root.
      const audioUrl = `${R2_PUBLIC_ROOT}/${key}`;
      // Fallback title: handleFileSelect auto-populates trackTitle, but the user
      // may have cleared it manually — derive from filename as a safety net.
      const resolvedTitle = trackTitle.trim() || titleFromFilename(selectedFile.name);

      try {
        const syncRes = await fetch(withBasePath('/api/vault/sync'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-syndicate-key': sessionKey,
          },
          body: JSON.stringify({
            title: resolvedTitle,
            artist: trackArtist.trim(),
            bpm: trackBpm.trim(),
            key: trackKey.trim(),
            audioUrl,
          }),
        });

        if (syncRes.status === 401) {
          handleLock();
          return;
        }

        const syncData = (await syncRes.json()) as { ok?: boolean; error?: string };
        if (!syncRes.ok || !syncData.ok) {
          // Sync failed but audio is already uploaded — surface warning, not error
          setStatus({
            phase: 'done',
            message: `UPLOAD OK — MANIFEST SYNC FAILED: ${syncData.error ?? `HTTP ${syncRes.status}`}`,
            progress: 100,
            uploadedKey: key,
          });
          clearFileSelection();
          return;
        }
      } catch (syncErr) {
        setStatus({
          phase: 'done',
          message: `UPLOAD OK — MANIFEST SYNC ERROR: ${(syncErr as Error).message}`,
          progress: 100,
          uploadedKey: key,
        });
        clearFileSelection();
        return;
      }

      setStatus({
        phase: 'done',
        message: 'TRACK SECURED IN VAULT ✓  MANIFEST UPDATED ✓',
        progress: 100,
        uploadedKey: key,
      });

      setSelectedFile(null);
      setTrackTitle('');
      setTrackArtist('');
      setTrackBpm('');
      setTrackKey('');
      clearFileSelection();
      // Refresh track listing after successful upload
      fetchVaultTracks();
    } catch (err) {
      setStatus({
        phase: 'error',
        message: (err as Error).message ?? 'UPLOAD FAILED',
        progress: 0,
        uploadedKey: '',
      });
    }
  };

  const handleCancel = () => {
    xhrRef.current?.abort();
  };

  const handleReset = () => {
    setSelectedFile(null);
    setStatus({ phase: 'idle', message: 'AWAITING INPUT', progress: 0, uploadedKey: '' });
    setTrackTitle('');
    setTrackArtist('');
    setTrackBpm('');
    setTrackKey('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // ── Fetch vault tracks ────────────────────────────────────────────────
  const fetchVaultTracks = useCallback(async () => {
    setTracksLoading(true);
    try {
      const res = await fetch(`${R2_PUBLIC_ROOT}/library.json`, { cache: 'no-store' });
      if (!res.ok) { setVaultTracks([]); return; }
      const data: unknown = await res.json();
      if (Array.isArray(data)) {
        setVaultTracks(data as VaultTrack[]);
      }
    } catch {
      setVaultTracks([]);
    } finally {
      setTracksLoading(false);
    }
  }, []);

  // Load tracks when unlocked
  useEffect(() => {
    if (isUnlocked) fetchVaultTracks();
  }, [isUnlocked, fetchVaultTracks]);

  // ── Delete track handler ──────────────────────────────────────────────
  const handleDeleteTrack = useCallback(async (audioUrl: string) => {
    if (deletingUrl) return; // prevent concurrent deletes
    setDeletingUrl(audioUrl);
    try {
      const res = await fetch(withBasePath('/api/vault/delete'), {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'x-syndicate-key': sessionKey,
        },
        body: JSON.stringify({ audioUrl }),
      });

      if (res.status === 401) {
        handleLock();
        return;
      }

      const data = (await res.json()) as { success?: boolean; error?: string };
      if (res.ok && data.success) {
        setVaultTracks((prev) => prev.filter((t) => t.audioUrl !== audioUrl));
      }
    } catch {
      // Silently fail — track remains in list
    } finally {
      setDeletingUrl(null);
    }
  }, [deletingUrl, sessionKey, handleLock]);

  // ── Phase-derived UI values ─────────────────────────────────────────────
  const isBusy = status.phase === 'signing' || status.phase === 'uploading' || status.phase === 'syncing';
  const progressBarColor =
    status.phase === 'done'
      ? 'var(--color-studio-gold)'
      : status.phase === 'error'
        ? 'var(--color-studio-crimson)'
        : 'var(--color-studio-gold)';

  // ============================================================
  // RENDER — LOCK SCREEN
  // ============================================================
  if (!isUnlocked) {
    return (
      <div
        className="flex items-center justify-center min-h-screen p-4"
        style={{ background: '#0a0a0a' }}
      >
        <div
          className="deck-chassis rounded-2xl w-full max-w-sm"
          style={{
            border: '1px solid rgba(255,215,0,0.15)',
            boxShadow: '0 0 60px rgba(0,0,0,0.9), inset 0 1px 0 rgba(255,255,255,0.04)',
          }}
        >
          {/* Header plate */}
          <div
            className="rounded-t-2xl px-6 py-4 border-b"
            style={{ borderColor: 'rgba(255,215,0,0.1)', background: 'rgba(0,0,0,0.5)' }}
          >
            <div className="flex items-center gap-3">
              {/* Lock icon — decorative LEDs */}
              <div className="flex gap-1.5">
                <StatusLed active color="var(--color-studio-crimson)" />
                <StatusLed active={false} color="var(--color-studio-gold)" />
              </div>
              <div>
                <p
                  className="oled-display text-xs tracking-[0.3em] font-bold uppercase"
                  style={{ color: 'var(--color-studio-gold)' }}
                >
                  VAULT ADMIN
                </p>
                <p
                  className="oled-display text-[10px] tracking-[0.2em] uppercase mt-0.5"
                  style={{ color: 'rgba(255,215,0,0.4)' }}
                >
                  SYNDICATE AUTH REQUIRED
                </p>
              </div>
            </div>
          </div>

          {/* OLED display panel */}
          <div className="px-6 pt-5 pb-2">
            <div
              className="oled-display rounded p-3 mb-5 text-xs"
              style={{
                background: '#050505',
                border: '1px solid rgba(255,215,0,0.08)',
                color: 'rgba(255,215,0,0.6)',
                letterSpacing: '0.15em',
              }}
            >
              <div className="flex items-center">
                <span style={{ color: 'var(--color-studio-crimson)' }}>■ </span>
                <span className="ml-1">SYSTEM: LOCKED</span>
                <OledCursor />
              </div>
            </div>

            <form onSubmit={handleUnlock} className="space-y-4">
              <div>
                <label
                  className="oled-display block text-[10px] tracking-[0.3em] uppercase mb-2"
                  style={{ color: 'rgba(255,215,0,0.5)' }}
                >
                  SYNDICATE KEY
                </label>
                <input
                  type="password"
                  value={keyInput}
                  onChange={(e) => {
                    setKeyInput(e.target.value);
                    setKeyError('');
                  }}
                  placeholder="••••••••••••"
                  autoComplete="current-password"
                  className="w-full oled-display text-sm rounded px-4 py-3 outline-none transition-all duration-200"
                  style={{
                    background: '#080808',
                    border: keyError
                      ? '1px solid var(--color-studio-crimson)'
                      : '1px solid rgba(255,215,0,0.2)',
                    color: 'var(--color-studio-gold)',
                    letterSpacing: '0.2em',
                    caretColor: 'var(--color-studio-gold)',
                    boxShadow: keyError
                      ? '0 0 12px rgba(255,0,60,0.2)'
                      : 'inset 0 1px 4px rgba(0,0,0,0.8)',
                  }}
                  onFocus={(e) =>
                    (e.currentTarget.style.boxShadow = '0 0 0 2px rgba(255,215,0,0.25)')
                  }
                  onBlur={(e) =>
                    (e.currentTarget.style.boxShadow = keyError
                      ? '0 0 12px rgba(255,0,60,0.2)'
                      : 'inset 0 1px 4px rgba(0,0,0,0.8)')
                  }
                />
                {keyError && (
                  <p
                    className="oled-display text-[10px] tracking-[0.15em] mt-2"
                    style={{ color: 'var(--color-studio-crimson)' }}
                  >
                    ⚠ {keyError}
                  </p>
                )}
                {!VAULT_KEY_CONFIGURED && (
                  <p
                    className="oled-display text-[10px] tracking-[0.1em] mt-2"
                    style={{ color: 'rgba(255,215,0,0.25)' }}
                  >
                    [DEV MODE — SET VAULT_KEY ENV VAR TO ENABLE AUTH]
                  </p>
                )}
              </div>

              <button
                type="submit"
                className="neon-glow w-full oled-display text-sm font-bold tracking-[0.3em] uppercase rounded py-3 transition-all duration-150 active:scale-[0.98] active:brightness-90"
                style={{
                  background: 'linear-gradient(135deg, rgba(255,215,0,0.12), rgba(255,215,0,0.06))',
                  border: '1px solid rgba(255,215,0,0.5)',
                  color: 'var(--color-studio-gold)',
                  cursor: 'pointer',
                }}
              >
                AUTHENTICATE
              </button>
            </form>
          </div>

          {/* Bottom chassis detail */}
          <div className="px-6 pb-4 pt-2 flex justify-between items-center">
            <div className="flex gap-2">
              {[...Array(5)].map((_, i) => (
                <div
                  key={i}
                  className="w-1 h-1 rounded-full"
                  style={{ background: 'rgba(255,215,0,0.15)' }}
                />
              ))}
            </div>
            <span
              className="oled-display text-[9px] tracking-[0.2em] uppercase"
              style={{ color: 'rgba(255,215,0,0.2)' }}
            >
              VAULT v2.0
            </span>
          </div>
        </div>
      </div>
    );
  }

  // ============================================================
  // RENDER — UPLOAD CONSOLE (UNLOCKED)
  // ============================================================
  return (
    <div
      className="flex items-center justify-center min-h-screen p-4"
      style={{ background: '#0a0a0a' }}
    >
      <div
        className="deck-chassis rounded-2xl w-full max-w-lg"
        style={{
          border: '1px solid rgba(255,215,0,0.2)',
          boxShadow: '0 0 80px rgba(0,0,0,0.95), 0 0 30px rgba(255,215,0,0.05), inset 0 1px 0 rgba(255,255,255,0.04)',
        }}
      >
        {/* ── Header ───────────────────────────────────────────────────── */}
        <div
          className="rounded-t-2xl px-6 py-4 border-b"
          style={{ borderColor: 'rgba(255,215,0,0.1)', background: 'rgba(0,0,0,0.5)' }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex gap-1.5">
                <StatusLed active color="var(--color-studio-gold)" />
                <StatusLed
                  active={status.phase === 'uploading' || status.phase === 'signing'}
                  color="#00FF88"
                />
                <StatusLed active={status.phase === 'error'} color="var(--color-studio-crimson)" />
              </div>
              <div>
                <p
                  className="oled-display text-xs tracking-[0.35em] font-black uppercase neon-text-glow"
                  style={{ color: 'var(--color-studio-gold)' }}
                >
                  VAULT ADMIN
                </p>
                <p
                  className="oled-display text-[10px] tracking-[0.2em] uppercase mt-0.5"
                  style={{ color: 'rgba(255,215,0,0.35)' }}
                >
                  AUDIO ASSET UPLOADER
                </p>
              </div>
            </div>

            {/* Lock button */}
            <button
              onClick={handleLock}
              className="oled-display text-[10px] tracking-[0.2em] uppercase px-3 py-1.5 rounded transition-all duration-150 hover:brightness-110 active:scale-95"
              style={{
                background: 'rgba(255,0,60,0.08)',
                border: '1px solid rgba(255,0,60,0.25)',
                color: 'rgba(255,0,60,0.7)',
                cursor: 'pointer',
              }}
            >
              LOCK
            </button>
          </div>
        </div>

        {/* ── OLED Status Display ───────────────────────────────────────── */}
        <div className="px-6 pt-5">
          <div
            className="oled-display rounded p-3 text-xs"
            style={{
              background: '#030303',
              border: '1px solid rgba(255,215,0,0.07)',
              minHeight: '60px',
            }}
          >
            <div className="flex items-start justify-between gap-2">
              <div style={{ color: 'rgba(255,215,0,0.7)', letterSpacing: '0.12em' }}>
                <span
                  style={{
                    color:
                      status.phase === 'error'
                        ? 'var(--color-studio-crimson)'
                        : status.phase === 'done'
                          ? '#00FF88'
                          : 'var(--color-studio-gold)',
                  }}
                >
                  ▶{' '}
                </span>
                {status.message}
                {isBusy && <OledCursor />}
              </div>
              {isBusy && (
                <span
                  className="oled-display text-[10px] animate-pulse"
                  style={{ color: 'rgba(255,215,0,0.4)', whiteSpace: 'nowrap' }}
                >
                  PROC...
                </span>
              )}
            </div>

            {selectedFile && status.phase !== 'done' && (
              <div className="mt-2" style={{ color: 'rgba(255,215,0,0.4)', letterSpacing: '0.1em' }}>
                <span style={{ color: 'rgba(255,215,0,0.25)' }}>FILE: </span>
                {selectedFile.name}
                <span className="ml-3" style={{ color: 'rgba(255,215,0,0.25)' }}>
                  {formatBytes(selectedFile.size)}
                </span>
              </div>
            )}

            {status.uploadedKey && (
              <div className="mt-2" style={{ color: 'rgba(0,255,136,0.6)', letterSpacing: '0.08em' }}>
                <span style={{ color: 'rgba(0,255,136,0.35)' }}>KEY: </span>
                {status.uploadedKey}
              </div>
            )}
          </div>
        </div>

        {/* ── Progress Bar ─────────────────────────────────────────────── */}
        {(isBusy || status.phase === 'done' || (status.phase === 'error' && status.progress > 0)) && (
          <div className="px-6 pt-3">
            <div
              className="rounded-full overflow-hidden"
              style={{
                height: '3px',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.04)',
              }}
            >
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${status.progress}%`,
                  background: progressBarColor,
                  boxShadow: `0 0 8px ${progressBarColor}`,
                }}
              />
            </div>
            <div className="flex justify-between mt-1">
              <span
                className="oled-display text-[9px] tracking-[0.15em] uppercase"
                style={{ color: 'rgba(255,215,0,0.3)' }}
              >
                {status.phase === 'signing' ? 'AUTHENTICATING' : status.phase === 'syncing' ? 'MANIFEST SYNC' : 'TRANSFER'}
              </span>
              <span
                className="oled-display text-[9px] tracking-[0.1em]"
                style={{ color: 'rgba(255,215,0,0.4)' }}
              >
                {status.progress}%
              </span>
            </div>
          </div>
        )}

        {/* ── Main Upload Form ─────────────────────────────────────────── */}
        <form onSubmit={handleUpload} className="px-6 pt-4 pb-6 space-y-4">
          {/* Drop Zone */}
          <div
            role="button"
            tabIndex={0}
            aria-label="Drop zone for audio files"
            className="rounded-xl cursor-pointer transition-all duration-200"
            style={{
              border: isDragOver
                ? '2px dashed var(--color-studio-gold)'
                : selectedFile
                  ? '2px dashed rgba(255,215,0,0.4)'
                  : '2px dashed rgba(255,215,0,0.12)',
              background: isDragOver
                ? 'rgba(255,215,0,0.04)'
                : 'rgba(0,0,0,0.3)',
              padding: '28px 20px',
              textAlign: 'center',
              boxShadow: isDragOver ? '0 0 20px rgba(255,215,0,0.1)' : 'none',
            }}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
          >
            {selectedFile ? (
              <div className="space-y-1">
                <div
                  className="oled-display text-sm font-bold tracking-[0.1em]"
                  style={{ color: 'var(--color-studio-gold)' }}
                >
                  {selectedFile.name}
                </div>
                <div
                  className="oled-display text-xs tracking-[0.15em]"
                  style={{ color: 'rgba(255,215,0,0.4)' }}
                >
                  {formatBytes(selectedFile.size)} · {selectedFile.type || 'audio/mpeg'}
                </div>
                <div
                  className="oled-display text-[10px] tracking-[0.2em] uppercase mt-2"
                  style={{ color: 'rgba(255,215,0,0.25)' }}
                >
                  CLICK TO REPLACE
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {/* Waveform icon */}
                <div className="flex items-end justify-center gap-0.5 h-8">
                  {[3, 6, 10, 14, 10, 18, 12, 22, 14, 18, 10, 14, 10, 6, 3].map((h, i) => (
                    <div
                      key={i}
                      className="w-1 rounded-sm"
                      style={{
                        height: `${h}px`,
                        background: isDragOver
                          ? 'var(--color-studio-gold)'
                          : 'rgba(255,215,0,0.2)',
                        transition: 'background 0.2s',
                      }}
                    />
                  ))}
                </div>
                <p
                  className="oled-display text-xs tracking-[0.25em] uppercase"
                  style={{ color: 'rgba(255,215,0,0.5)' }}
                >
                  DROP AUDIO FILE HERE
                </p>
                <p
                  className="oled-display text-[10px] tracking-[0.15em] uppercase"
                  style={{ color: 'rgba(255,215,0,0.2)' }}
                >
                  MP3 · WAV · FLAC · OGG · AAC
                </p>
              </div>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_EXTENSIONS}
            onChange={handleFileChange}
            className="sr-only"
            aria-hidden="true"
          />

          {/* ── Track Metadata Fields ────────────────────────────────── */}
          <div
            className="rounded-xl p-4 space-y-3"
            style={{
              background: 'rgba(0,0,0,0.25)',
              border: '1px solid rgba(255,215,0,0.1)',
            }}
          >
            <p
              className="oled-display text-[10px] tracking-[0.25em] uppercase font-bold"
              style={{ color: 'rgba(255,215,0,0.4)' }}
            >
              ▸ TRACK METADATA
            </p>
            <div className="grid grid-cols-2 gap-3">
              {/* Title */}
              <div className="col-span-2">
                <label
                  className="oled-display block text-[9px] tracking-[0.25em] uppercase mb-1"
                  style={{ color: 'rgba(255,215,0,0.35)' }}
                >
                  TITLE
                </label>
                <input
                  type="text"
                  value={trackTitle}
                  onChange={(e) => setTrackTitle(e.target.value)}
                  placeholder="Track title..."
                  disabled={isBusy}
                  className="w-full oled-display text-xs rounded px-3 py-2 outline-none transition-all duration-200 disabled:opacity-40"
                  style={{
                    background: '#060606',
                    border: '1px solid rgba(255,215,0,0.15)',
                    color: 'var(--color-studio-gold)',
                    letterSpacing: '0.08em',
                    caretColor: 'var(--color-studio-gold)',
                  }}
                />
              </div>
              {/* Artist */}
              <div className="col-span-2">
                <label
                  className="oled-display block text-[9px] tracking-[0.25em] uppercase mb-1"
                  style={{ color: 'rgba(255,215,0,0.35)' }}
                >
                  ARTIST
                </label>
                <input
                  type="text"
                  value={trackArtist}
                  onChange={(e) => setTrackArtist(e.target.value)}
                  placeholder="Artist name..."
                  disabled={isBusy}
                  className="w-full oled-display text-xs rounded px-3 py-2 outline-none transition-all duration-200 disabled:opacity-40"
                  style={{
                    background: '#060606',
                    border: '1px solid rgba(255,215,0,0.15)',
                    color: 'var(--color-studio-gold)',
                    letterSpacing: '0.08em',
                    caretColor: 'var(--color-studio-gold)',
                  }}
                />
              </div>
              {/* BPM */}
              <div>
                <label
                  className="oled-display block text-[9px] tracking-[0.25em] uppercase mb-1"
                  style={{ color: 'rgba(255,215,0,0.35)' }}
                >
                  BPM
                </label>
                <input
                  type="text"
                  value={trackBpm}
                  onChange={(e) => setTrackBpm(e.target.value)}
                  placeholder="e.g. 128"
                  disabled={isBusy}
                  className="w-full oled-display text-xs rounded px-3 py-2 outline-none transition-all duration-200 disabled:opacity-40"
                  style={{
                    background: '#060606',
                    border: '1px solid rgba(255,215,0,0.15)',
                    color: 'var(--color-studio-gold)',
                    letterSpacing: '0.08em',
                    caretColor: 'var(--color-studio-gold)',
                  }}
                />
              </div>
              {/* Key */}
              <div>
                <label
                  className="oled-display block text-[9px] tracking-[0.25em] uppercase mb-1"
                  style={{ color: 'rgba(255,215,0,0.35)' }}
                >
                  KEY
                </label>
                <input
                  type="text"
                  value={trackKey}
                  onChange={(e) => setTrackKey(e.target.value)}
                  placeholder="e.g. 8A"
                  disabled={isBusy}
                  className="w-full oled-display text-xs rounded px-3 py-2 outline-none transition-all duration-200 disabled:opacity-40"
                  style={{
                    background: '#060606',
                    border: '1px solid rgba(255,215,0,0.15)',
                    color: 'var(--color-studio-gold)',
                    letterSpacing: '0.08em',
                    caretColor: 'var(--color-studio-gold)',
                  }}
                />
              </div>
            </div>
          </div>


          <div className="flex gap-3">
            <button
              type="submit"
              disabled={!selectedFile || isBusy}
              className="neon-glow flex-1 oled-display text-sm font-bold tracking-[0.3em] uppercase rounded-xl py-3.5 transition-all duration-150 active:scale-[0.98] disabled:opacity-30 disabled:cursor-not-allowed disabled:shadow-none"
              style={{
                background: !selectedFile || isBusy
                  ? 'rgba(255,215,0,0.04)'
                  : 'linear-gradient(135deg, rgba(255,215,0,0.14), rgba(255,215,0,0.06))',
                border: '1px solid rgba(255,215,0,0.45)',
                color: 'var(--color-studio-gold)',
                cursor: !selectedFile || isBusy ? 'not-allowed' : 'pointer',
              }}
            >
              {status.phase === 'signing'
                ? 'AUTHENTICATING...'
                : status.phase === 'uploading'
                  ? `UPLOADING ${status.progress}%`
                  : status.phase === 'syncing'
                    ? 'SYNCING MANIFEST...'
                    : 'UPLOAD TO VAULT'}
            </button>

            {isBusy ? (
              <button
                type="button"
                onClick={handleCancel}
                className="oled-display text-xs font-bold tracking-[0.2em] uppercase px-4 rounded-xl transition-all duration-150 active:scale-95"
                style={{
                  background: 'rgba(255,0,60,0.08)',
                  border: '1px solid rgba(255,0,60,0.35)',
                  color: 'var(--color-studio-crimson)',
                  cursor: 'pointer',
                }}
              >
                ABORT
              </button>
            ) : (selectedFile || status.phase !== 'idle') ? (
              <button
                type="button"
                onClick={handleReset}
                className="oled-display text-xs font-bold tracking-[0.2em] uppercase px-4 rounded-xl transition-all duration-150 active:scale-95"
                style={{
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: 'rgba(255,255,255,0.3)',
                  cursor: 'pointer',
                }}
              >
                CLEAR
              </button>
            ) : null}
          </div>

          {/* ── Library info panel ──────────────────────────────────────── */}
          <div
            className="rounded-xl p-4"
            style={{
              background: 'rgba(255,215,0,0.02)',
              border: '1px solid rgba(255,215,0,0.07)',
            }}
          >
            <p
              className="oled-display text-[10px] tracking-[0.25em] uppercase font-bold mb-2"
              style={{ color: 'rgba(255,215,0,0.4)' }}
            >
              ▸ LIBRARY SYNC
            </p>
            <p
              className="oled-display text-[10px] leading-relaxed"
              style={{ color: 'rgba(255,255,255,0.2)', letterSpacing: '0.05em' }}
            >
              After upload, the manifest at{' '}
              <span style={{ color: 'rgba(255,215,0,0.35)' }}>library.json</span> is
              automatically updated. New tracks will appear in the{' '}
              <span style={{ color: 'rgba(255,215,0,0.35)' }}>LIBRARY</span> panel on
              next session load.
            </p>
          </div>

          {/* ── Manage Tracks panel ─────────────────────────────────────── */}
          <div
            className="rounded-xl p-4"
            style={{
              background: 'rgba(0,0,0,0.25)',
              border: '1px solid rgba(255,215,0,0.1)',
            }}
          >
            <div className="flex items-center justify-between mb-3">
              <p
                className="oled-display text-[10px] tracking-[0.25em] uppercase font-bold"
                style={{ color: 'rgba(255,215,0,0.4)' }}
              >
                ▸ MANAGE TRACKS ({vaultTracks.length})
              </p>
              <button
                type="button"
                onClick={fetchVaultTracks}
                disabled={tracksLoading}
                className="oled-display text-[9px] tracking-[0.15em] uppercase px-2 py-1 rounded transition-all duration-150 active:scale-95 disabled:opacity-40"
                style={{
                  background: 'rgba(255,215,0,0.05)',
                  border: '1px solid rgba(255,215,0,0.15)',
                  color: 'rgba(255,215,0,0.5)',
                  cursor: tracksLoading ? 'not-allowed' : 'pointer',
                }}
              >
                {tracksLoading ? 'LOADING...' : 'REFRESH'}
              </button>
            </div>

            {tracksLoading && vaultTracks.length === 0 ? (
              <p
                className="oled-display text-[10px] tracking-[0.1em] py-4 text-center animate-pulse"
                style={{ color: 'rgba(255,215,0,0.3)' }}
              >
                LOADING VAULT MANIFEST...
              </p>
            ) : vaultTracks.length === 0 ? (
              <p
                className="oled-display text-[10px] tracking-[0.1em] py-4 text-center"
                style={{ color: 'rgba(255,255,255,0.2)' }}
              >
                NO TRACKS IN VAULT
              </p>
            ) : (
              <div
                className="space-y-1.5 overflow-y-auto"
                style={{ maxHeight: '280px' }}
              >
                {vaultTracks.map((track) => (
                  <div
                    key={track.audioUrl}
                    className="flex items-center justify-between rounded-lg px-3 py-2 group transition-all duration-150"
                    style={{
                      background: deletingUrl === track.audioUrl
                        ? 'rgba(255,0,60,0.08)'
                        : 'rgba(255,255,255,0.02)',
                      border: deletingUrl === track.audioUrl
                        ? '1px solid rgba(255,0,60,0.2)'
                        : '1px solid rgba(255,255,255,0.04)',
                    }}
                  >
                    <div className="min-w-0 flex-1 mr-3">
                      <p
                        className="oled-display text-xs truncate"
                        style={{ color: 'rgba(255,215,0,0.7)', letterSpacing: '0.05em' }}
                      >
                        {track.title || 'Untitled'}
                      </p>
                      {track.artist && (
                        <p
                          className="oled-display text-[10px] truncate"
                          style={{ color: 'rgba(255,255,255,0.25)', letterSpacing: '0.05em' }}
                        >
                          {track.artist}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDeleteTrack(track.audioUrl)}
                      disabled={deletingUrl !== null}
                      className="oled-display text-[9px] tracking-[0.15em] uppercase px-2.5 py-1 rounded transition-all duration-150 active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed opacity-60 hover:opacity-100"
                      style={{
                        background: 'rgba(255,0,60,0.08)',
                        border: '1px solid rgba(255,0,60,0.3)',
                        color: 'var(--color-studio-crimson)',
                        cursor: deletingUrl !== null ? 'not-allowed' : 'pointer',
                        flexShrink: 0,
                      }}
                    >
                      {deletingUrl === track.audioUrl ? 'DELETING...' : 'DELETE'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Chassis detail row ──────────────────────────────────────── */}
          <div className="flex items-center justify-between pt-1">
            <div className="flex gap-2">
              {[...Array(8)].map((_, i) => (
                <div
                  key={i}
                  className="rounded-sm"
                  style={{
                    width: '6px',
                    height: '2px',
                    background:
                      isBusy && i < Math.floor((status.progress / 100) * 8)
                        ? 'var(--color-studio-gold)'
                        : 'rgba(255,215,0,0.1)',
                    boxShadow:
                      isBusy && i < Math.floor((status.progress / 100) * 8)
                        ? '0 0 4px var(--color-studio-gold)'
                        : 'none',
                    transition: 'all 0.3s',
                  }}
                />
              ))}
            </div>
            <span
              className="oled-display text-[9px] tracking-[0.2em] uppercase"
              style={{ color: 'rgba(255,215,0,0.15)' }}
            >
              R2·VAULT·NODE
            </span>
          </div>
        </form>
      </div>
    </div>
  );
}
