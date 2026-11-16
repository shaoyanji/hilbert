// Wire constants. Kept out of codec.js so the browser decoder never imports
// node:zlib.

export const MAGIC_H = 0x48; // 'H'
export const MAGIC_B = 0x42; // 'B'
export const VERSION = 1;
export const KIND_TILE = 2;
export const HEADER_BYTES = 32;
