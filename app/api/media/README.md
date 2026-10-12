# Media proxy

This directory contains the server-side media proxy layer for approved external providers.

## Design goals

- Keep all external media resolution and fetches on the server.
- Never expose raw YouTube or untrusted source URLs to the browser.
- Allow the DJ mixer to consume approved external sources in the same way as vault/R2 tracks.

## Flow

1. UI posts a source URL to `/api/media/resolve`.
2. Server validates the provider and host against an approved allowlist.
3. Server returns a proxy URL for `/api/media/stream`.
4. Client reads the stream URL through the app rather than directly from the third-party host.

## Security constraints

- Use a server-only `MEDIA_PROXY_KEY` or `VAULT_KEY` to protect the routes.
- Restrict supported hosts and providers to approved domains only.
- Cache proxied audio aggressively and enforce licensing checks before use.
- Do not enable bare torrent or arbitrary file-host searching in the main app.
