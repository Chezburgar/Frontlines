import { defineConfig } from 'vite';
import { shotPlugin } from './tools/vite-shot.js';

// GitHub Pages serves project sites from /<repo>/, so the base has to match at build time.
// Overridable for local `vite build && vite preview` checks.
const base = process.env.FL_BASE ?? (process.env.NODE_ENV === 'production' ? '/Frontlines/' : '/');

export default defineConfig({
  base,
  publicDir: 'public',
  plugins: [shotPlugin()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 1400,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          supabase: ['@supabase/supabase-js'],
        },
      },
    },
  },
  server: { host: true, port: 5173 },
  preview: { port: 4173 },
});
