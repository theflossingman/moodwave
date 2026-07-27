const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPNG(size) {
  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const t = (x + y) / (size * 2);
      const r = Math.round(124 + (192 - 124) * t);
      const g = Math.round(92 + (96 - 92) * t);
      const b = Math.round(252 + (255 - 252) * t);

      const cx = x - size / 2;
      const cy = y - size / 2;
      const dist = Math.sqrt(cx * cx + cy * cy);
      const radius = size * 0.35;
      const innerRadius = size * 0.2;

      if (dist < radius && dist > innerRadius) {
        const angle = Math.atan2(cy, cx);
        if (angle > -2.5 && angle < 0.8) {
          pixels[i] = 255;
          pixels[i + 1] = 255;
          pixels[i + 2] = 255;
          pixels[i + 3] = 255;
          continue;
        }
      }
      if (dist <= innerRadius) {
        const angle = Math.atan2(cy, cx);
        if (angle > -2.5 && angle < 0.8) {
          pixels[i] = 255;
          pixels[i + 1] = 255;
          pixels[i + 2] = 255;
          pixels[i + 3] = 255;
          continue;
        }
      }

      const cornerRadius = size * 0.2;
      const dx = Math.max(cornerRadius - x, 0, x - (size - cornerRadius));
      const dy = Math.max(cornerRadius - y, 0, y - (size - cornerRadius));
      const cornerDist = Math.sqrt(dx * dx + dy * dy);
      if (cornerDist > cornerRadius) {
        pixels[i + 3] = 0;
        continue;
      }

      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = 255;
    }
  }

  const rawRows = [];
  for (let y = 0; y < size; y++) {
    rawRows.push(Buffer.concat([Buffer.from([0]), pixels.slice(y * size * 4, (y + 1) * size * 4)]));
  }
  const rawData = Buffer.concat(rawRows);
  const compressed = zlib.deflateSync(rawData);

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type), data]);
    const crc = crc32(typeAndData);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc >>> 0);
    return Buffer.concat([len, typeAndData, crcBuf]);
  }

  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[n] = c;
  }

  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    pngSignature,
    chunk('IHDR', ihdrData),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const iconsDir = path.join(__dirname, 'public', 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

fs.writeFileSync(path.join(iconsDir, 'icon-192.png'), createPNG(192));
fs.writeFileSync(path.join(iconsDir, 'icon-512.png'), createPNG(512));
console.log('Icons generated: icon-192.png, icon-512.png');
