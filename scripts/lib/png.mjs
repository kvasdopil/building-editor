/**
 * Minimal PNG writer for RGBA pixels, so a script can put a raster on disk
 * without a dependency: signature, IHDR, one deflated IDAT, IEND.
 */

import { deflateSync } from "node:zlib";

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

/** Nearest-neighbour magnification, because half-metre cells are tiny. */
function magnify(rgba, width, height, scale) {
  const out = Buffer.alloc(width * scale * height * scale * 4);
  for (let y = 0; y < height * scale; y++) {
    for (let x = 0; x < width * scale; x++) {
      const from = (((y / scale) | 0) * width + ((x / scale) | 0)) * 4;
      const to = (y * width * scale + x) * 4;
      for (let channel = 0; channel < 4; channel++) out[to + channel] = rgba[from + channel];
    }
  }
  return out;
}

/** RGBA bytes as a PNG buffer, magnified `scale` times. */
export function encodePng(rgba, width, height, scale = 1) {
  const pixels = scale === 1 ? Buffer.from(rgba) : magnify(rgba, width, height, scale);
  const w = width * scale;
  const h = height * scale;
  // Every scanline is prefixed with its filter type; 0 means "store as is".
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    pixels.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
