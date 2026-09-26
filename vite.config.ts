/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Injects the real build output into the service worker's precache list, and a
 * build id that busts the cache on every deployment (same approach as BoxingCoach).
 */
function serviceWorkerPrecache(): Plugin {
  return {
    name: 'trevor-sw-precache',
    apply: 'build',
    closeBundle() {
      const outDir = fileURLToPath(new URL('./dist', import.meta.url));
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) walk(full);
          else files.push('/' + relative(outDir, full).split(/[\\/]/).join('/'));
        }
      };
      walk(outDir);
      const precache = files.filter(
        (f) => f !== '/sw.js' && /\.(?:html|js|css|svg|png|webmanifest)$/i.test(f),
      );
      if (!precache.includes('/')) precache.unshift('/');
      const swPath = join(outDir, 'sw.js');
      const buildId = Date.now().toString(36);
      const source = readFileSync(swPath, 'utf8');
      writeFileSync(
        swPath,
        `self.__BUILD_ID__ = ${JSON.stringify(buildId)};\n` +
          `self.__PRECACHE__ = ${JSON.stringify(precache)};\n` +
          source,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorkerPrecache()],
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@web': fileURLToPath(new URL('./src/web', import.meta.url)),
    },
  },
  server: {
    // `npm run dev` serves the PWA with HMR; the API runs in `wrangler dev` (npm run dev:api).
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    chunkSizeWarningLimit: 700,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
