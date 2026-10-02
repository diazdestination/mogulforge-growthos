// Deterministic format conversion of the existing straight-edged SVG brand mark.
// No new artwork and no external image dependency. Rerun when that SVG changes.
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const brand = new URL('../public/brand/', import.meta.url);
const svg = readFileSync(new URL('mogulforge-mark.svg', brand), 'utf8');
if (!svg.includes('viewBox="0 0 128 128"')) throw new Error('Review changed source geometry before converting icons.');
const polygons = [...svg.matchAll(/<path fill="(#[\da-f]{6})" d="([^"]+)"/gi)].map(([, fill, data]) => {
  const tokens = data.match(/[a-zA-Z]|-?\d+(?:\.\d+)?/g);
  const points = []; let x = 0; let y = 0; let command = '';
  for (let i = 0; i < tokens.length;) {
    if (/^[a-z]$/i.test(tokens[i])) command = tokens[i++];
    if (!'MmLlHhVvZz'.includes(command)) throw new Error('Only the existing polygon SVG geometry is supported.');
    if (/z/i.test(command)) break;
    const relative = command === command.toLowerCase();
    if (/^[ml]$/i.test(command)) { x = Number(tokens[i++]) + (relative ? x : 0); y = Number(tokens[i++]) + (relative ? y : 0); command = relative ? 'l' : 'L'; }
    else if (/h/i.test(command)) x = Number(tokens[i++]) + (relative ? x : 0);
    else y = Number(tokens[i++]) + (relative ? y : 0);
    points.push([x, y]);
  }
  return { points, rgb: [1, 3, 5].map(offset => parseInt(fill.slice(offset, offset + 2), 16)) };
});
if (polygons.length !== 2) throw new Error('Review changed source paths before converting icons.');

function inside(x, y, polygon) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]; const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
function chunk(name, body) {
  const payload = Buffer.concat([Buffer.from(name), body]); let crc = 0xffffffff;
  for (const byte of payload) { crc ^= byte; for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
  const check = Buffer.alloc(4); check.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, payload, check]);
}
for (const size of [180, 192, 512]) {
  const raw = Buffer.alloc(size * (1 + size * 3)); const background = [5, 18, 29];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const channels = [0, 0, 0];
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const px = ((x + (sx + .5) / 4) / size - .125) / .75 * 128;
      const py = ((y + (sy + .5) / 4) / size - .125) / .75 * 128;
      let color = background;
      for (const polygon of polygons) if (inside(px, py, polygon.points)) color = polygon.rgb;
      for (let c = 0; c < 3; c++) channels[c] += color[c];
    }
    for (let c = 0; c < 3; c++) raw[y * (1 + size * 3) + 1 + x * 3 + c] = Math.round(channels[c] / 16);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  writeFileSync(new URL(`growthos-icon-${size}.png`, brand), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
console.log('Converted the existing MogulForge mark into 180, 192, and 512 pixel app icons.');
