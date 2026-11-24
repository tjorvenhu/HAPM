import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV !== 'production';

// Der Dev-Server von Turbopack braucht 'unsafe-eval' für das Nachladen.
const CSP = isDev
  ? "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' ws:; frame-ancestors 'none'"
  : "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'";

const nextConfig: NextConfig = {
  output: 'standalone',
  turbopack: {},
  // Der Treiber öffnet Sockets und bleibt außerhalb des Bündels. Next legt ihn
  // dafür in den Standalone-Baum, wo ihn der Server zur Laufzeit lädt.
  serverExternalPackages: ['postgres'],
  /**
   * Zwei Dinge, die zur Laufzeit gelesen und nicht importiert werden: die
   * mitgelieferte Länder-Tabelle (lib/geoip/store.ts) und die Docker-Anbindung,
   * die auch `bin/hapm-ctl.mjs` benutzt.
   */
  outputFileTracingIncludes: {
    '/api/**': ['./lib/geoip/data/**', './lib/docker/*.mjs'],
  },
  headers: async () => [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Content-Security-Policy', value: CSP },
      ],
    },
  ],
};

export default nextConfig;
