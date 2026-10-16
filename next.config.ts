import type {NextConfig} from 'next';
import {BASE_PATH} from './lib/basePath';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Served at the Piko FG site's /studio/dj via Multi-Zones (see lib/basePath.ts).
  basePath: BASE_PATH,
  // The page is /studio/dj (no trailing slash), one level above the worker's own folder.
  async headers() {
    return [{source: '/sw.js', headers: [{key: 'Service-Worker-Allowed', value: BASE_PATH}]}];
  },
  // Keep the old top-level addresses working on this app's own domain.
  async redirects() {
    return [
      {source: '/', destination: BASE_PATH, basePath: false, permanent: false},
      {source: '/vault-admin', destination: `${BASE_PATH}/vault-admin`, basePath: false, permanent: false},
      {source: '/api/:path*', destination: `${BASE_PATH}/api/:path*`, basePath: false, permanent: false},
      // Seeded tracks saved in IndexedDB before the move store /track-images/... artwork URLs.
      {source: '/track-images/:path*', destination: `${BASE_PATH}/track-images/:path*`, basePath: false, permanent: false},
    ];
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  // Allow access to remote image placeholder.
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'picsum.photos',
        port: '',
        pathname: '/**', // This allows any path under the hostname
      },
    ],
  },
  output: 'standalone',
  transpilePackages: ['motion'],
  webpack: (config, {dev}) => {
    // HMR is disabled in AI Studio via DISABLE_HMR env var.
    // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
    if (dev && process.env.DISABLE_HMR === 'true') {
      config.watchOptions = {
        ignored: /.*/,
      };
    }
    return config;
  },
};

export default nextConfig;
