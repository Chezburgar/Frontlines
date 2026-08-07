import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// The spectator ships as its own GitHub Pages site so access to it is a separate URL from
// the game, and so a caster's build can be updated without touching players.
const base = process.env.FL_SPEC_BASE ?? '/Frontlines-Spectator/';

export default defineConfig({
  base,
  // Root at the spectator folder so index.html lands at the output root, which is what
  // GitHub Pages serves. Sources outside it still resolve through the relative imports.
  root: resolve(process.cwd(), 'spectator'),
  publicDir: false,
  build: {
    target: 'es2022',
    outDir: resolve(process.cwd(), 'dist-spectator'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          supabase: ['@supabase/supabase-js'],
        },
      },
    },
  },
  server: { port: 5174 },
});
