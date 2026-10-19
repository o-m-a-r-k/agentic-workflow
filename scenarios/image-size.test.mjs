// I-117: a runner labelled its desktop captures 1440 px wide but wrote 1280 px images (its window stayed smaller), cropping
// the right of every screen; the gate passed and the reviewer, handed no size, saw a plausible picture. Every capture now
// carries its measured width and height, read from the image's own header (`wf screens` refuses a width that is not the
// viewport's: scenarios/screens-capture.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageSize } from '../engine/image-size.mjs';

const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const png = (w, h) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...u32(w), ...u32(h), 8, 2, 0, 0, 0]);
const gif = (w, h) => Buffer.from([...Buffer.from('GIF89a'), w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0]);
// SOI, an APP0 segment, then SOF0 (length 17, precision 8, height, width).
const jpeg = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
const le24 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const webpX = (w, h) => Buffer.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8X'), 10, 0, 0, 0, 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1), 0, 0]);

test('the size of PNG, JPEG, GIF and WebP screenshots is read from their headers; anything else is unknown', () => {
  assert.deepEqual(imageSize(png(1280, 800)), { width: 1280, height: 800 });
  assert.deepEqual(imageSize(jpeg(1440, 900)), { width: 1440, height: 900 });
  assert.deepEqual(imageSize(gif(390, 844)), { width: 390, height: 844 });
  assert.deepEqual(imageSize(webpX(2880, 1800)), { width: 2880, height: 1800 });
  assert.equal(imageSize(Buffer.from('en')), null, 'not an image');
  assert.equal(imageSize(png(1280, 800).subarray(0, 20)), null, 'cut short');
});

