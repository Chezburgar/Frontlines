/**
 * Dev-only screenshot sink.
 *
 * The in-app browser pane does not composite frames when it is hidden, so `computer`
 * screenshots time out. This lets the page push its own framebuffer to disk instead:
 *
 *     await fetch('/__shot/name.png', { method: 'POST', body: blob })
 *
 * Only registered on the dev server — it never reaches a production build.
 */
import fs from 'node:fs';
import path from 'node:path';

export function shotPlugin({ dir = '.shots' } = {}) {
  return {
    name: 'frontlines-shot',
    apply: 'serve',
    configureServer(server) {
      const outDir = path.resolve(server.config.root, dir);
      fs.mkdirSync(outDir, { recursive: true });
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/__shot/')) return next();
        if (req.method !== 'POST') { res.statusCode = 405; return res.end('POST only'); }
        const name = path.basename(decodeURIComponent(req.url.slice('/__shot/'.length))) || 'shot.png';
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const buf = Buffer.concat(chunks);
          const file = path.join(outDir, name);
          fs.writeFileSync(file, buf);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, file, bytes: buf.length }));
        });
      });
    },
  };
}
