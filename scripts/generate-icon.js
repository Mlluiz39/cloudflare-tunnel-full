'use strict';

/**
 * Gera assets/icon.png sem depender de biblioteca de imagem: desenha um
 * gradiente laranja com cantos arredondados e um raio branco, e codifica o
 * PNG na mão (zlib + CRC32). O electron-builder exige >= 256x256.
 *
 * Uso: node scripts/generate-icon.js [tamanho]
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = Number(process.argv[2]) || 512;

// ---------------------------------------------------------------- desenho

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function insideRoundedRect(x, y, size, radius) {
  const r = radius;
  if (x >= r && x <= size - r) return true;
  if (y >= r && y <= size - r) return true;
  const cx = x < r ? r : size - r;
  const cy = y < r ? r : size - r;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function insidePolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const intersects = (yi > y) !== (yj > y)
      && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function render(size) {
  const radius = Math.round(size * 0.2);
  const scale = size / 512;
  const bolt = [
    [310, 34], [168, 300], [256, 300], [204, 480],
    [356, 200], [266, 200],
  ].map(([x, y]) => [x * scale, y * scale]);
  const boltShadow = bolt.map(([x, y]) => [x + 4 * scale, y + 4 * scale]);

  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const alpha = insideRoundedRect(x, y, size, radius) ? 255 : 0;

      // Gradiente vertical laranja (#F97316 → #EA580C).
      const t = y / size;
      let r = lerp(0xF9, 0xEA, t);
      let g = lerp(0x73, 0x58, t);
      let b = lerp(0x16, 0x0C, t);

      if (insidePolygon(x, y, bolt)) {
        r = 255; g = 255; b = 255;
      } else if (alpha && insidePolygon(x, y, boltShadow)) {
        r = Math.min(255, r + 12);
        g = Math.min(255, g + 12);
        b = Math.min(255, b + 12);
      }

      pixels[index] = r;
      pixels[index + 1] = g;
      pixels[index + 2] = b;
      pixels[index + 3] = alpha;
    }
  }

  return pixels;
}

// ------------------------------------------------------------ codifica PNG

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // profundidade
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0;  // compressão
  ihdr[11] = 0;  // filtro
  ihdr[12] = 0;  // entrelaçamento

  const stride = size * 4;
  const rawData = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    rawData[y * (stride + 1)] = 0; // filtro "none"
    rgba.copy(rawData, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rawData, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const assetsDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assetsDir, { recursive: true });

const target = path.join(assetsDir, 'icon.png');
fs.writeFileSync(target, encodePng(SIZE, render(SIZE)));
console.log(`Ícone gerado: ${target} (${SIZE}x${SIZE}, ${fs.statSync(target).size} bytes)`);
