/**
 * Texture pass for the map atlases.
 *
 * Runs as its own process on purpose: the geometry pass allocates well over a gigabyte of
 * Float32Array vertex data, and libvips fails to allocate behind that, surfacing as a bogus
 * "colourspace: parameter space not set". A clean heap makes the encode deterministic, and
 * caching the results means the (slow) 8K decode only happens once.
 *
 * Output: .cache/albedo{N}.webp
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = process.env.FL_SRC || 'C:/Users/chase/Downloads';
const CACHE = path.join(ROOT, '.cache');

const MAX_TEX = 4096;
const QUALITY = 90;

sharp.cache(false);
sharp.concurrency(2);

const buf = fs.readFileSync(path.join(SRC, 'r6_maps_luna-park.glb'));
const total = buf.readUInt32LE(8);
let off = 12, g = null, bin = null;
while (off < total) {
  const len = buf.readUInt32LE(off);
  const type = buf.subarray(off + 4, off + 8).toString('ascii');
  if (type === 'JSON') g = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString('utf8'));
  else if (type.startsWith('BIN')) bin = buf.subarray(off + 8, off + 8 + len);
  off += 8 + len;
}

fs.mkdirSync(CACHE, { recursive: true });

for (let i = 0; i < g.images.length; i++) {
  const outFile = path.join(CACHE, `albedo${i}.webp`);
  if (fs.existsSync(outFile) && !process.env.FL_FORCE) {
    console.log(`[textures] ${i}: cached (${(fs.statSync(outFile).size / 1048576).toFixed(2)} MB)`);
    continue;
  }
  const img = g.images[i];
  const bv = g.bufferViews[img.bufferView];
  const src = Buffer.from(bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength));

  const meta = await sharp(src, { failOn: 'none', limitInputPixels: false }).metadata();
  const target = Math.min(MAX_TEX, Math.max(meta.width, meta.height));

  const { data, info } = await sharp(src, { failOn: 'none', limitInputPixels: false })
    .resize(target, target, { fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });

  const webp = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .webp({ quality: QUALITY, effort: 6, smartSubsample: true })
    .toBuffer();

  fs.writeFileSync(outFile, webp);
  console.log(`[textures] ${i}: ${meta.width}x${meta.height} -> ${info.width}px  ${(src.length / 1048576).toFixed(2)} MB -> ${(webp.length / 1048576).toFixed(2)} MB webp`);
}
console.log('[textures] done');
