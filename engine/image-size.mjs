// The pixel size of a screenshot, read from its header: PNG, GIF, JPEG and WebP. Null when the bytes are none of them or
// the header is cut short: a size the engine cannot read is shown as unknown, never a refusal.
//
// Named failure (I-117): a runner labelled its desktop captures 1440 px wide but wrote 1280 px images (its window stayed
// smaller), cropping the right-hand side of every screen; the gate passed and the reviewer, handed no size, saw a
// plausible picture. The measured size is now beside every screenshot the reviewer is handed.
export function imageSize(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  const sized = (width, height) => (width > 0 && height > 0 ? { width, height } : null);
  // PNG: the signature, then the IHDR chunk: width and height as big-endian 32-bit integers at 16 and 20.
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('ascii', 12, 16) === 'IHDR') return sized(b.readUInt32BE(16), b.readUInt32BE(20));
  // GIF: GIF87a or GIF89a, then the logical screen width and height, little-endian 16-bit, at 6 and 8.
  if (b.length >= 10 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return sized(b.readUInt16LE(6), b.readUInt16LE(8));
  // WebP: RIFF....WEBP with a VP8 (lossy), VP8L (lossless) or VP8X (extended) chunk.
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') return sized(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return sized((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
    if (chunk === 'VP8X') return sized(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
    return null;
  }
  // JPEG: walk the markers to the first start-of-frame (SOF0..SOF15 but DHT, JPG and DAC), whose height and width follow.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const length = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return sized(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
      if (length < 2) return null;
      i += 2 + length;
    }
  }
  return null;
}
