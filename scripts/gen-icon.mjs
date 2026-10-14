/**
 * One-off generator for resources/tray.png and resources/icon.png.
 * Pure Node PNG encoder (zlib + manual chunks), no dependencies.
 * Run: node scripts/gen-icon.mjs
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const BG = [14, 16, 20, 255] // #0e1014
const MAIN = [235, 235, 245, 255]
const ACCENT = [139, 92, 246, 255] // violet

/** Signed distance for a 4-point star: |x|^p + |y|^p <= r^p with soft p. */
function inStar(nx, ny, r, p) {
  return Math.abs(nx) ** p + Math.abs(ny) ** p <= r ** p
}

function drawStar(px, cx, cy, rad, p) {
  const nx = (px[0] - cx) / rad
  const ny = (px[1] - cy) / rad
  return inStar(nx, ny, 1, p)
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4)
  const half = size / 2
  const radius = size * 0.22 // corner radius of the rounded square
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      // rounded-square mask
      const dx = Math.max(Math.abs(x + 0.5 - half) - (half - radius), 0)
      const dy = Math.max(Math.abs(y + 0.5 - half) - (half - radius), 0)
      const inside = dx * dx + dy * dy <= radius * radius
      if (!inside) continue
      let color = BG
      // main star, slightly above center; small accent star bottom right —
      // mirrors the app logo.
      if (drawStar([x, y], half, half * 0.94, size * 0.3, 0.72)) {
        color = MAIN
      }
      if (drawStar([x, y], half * 1.42, half * 1.42, size * 0.09, 0.75)) {
        color = ACCENT
      }
      buf[i] = color[0]
      buf[i + 1] = color[1]
      buf[i + 2] = color[2]
      buf[i + 3] = color[3]
    }
  }
  return buf
}

mkdirSync(path.resolve('resources'), { recursive: true })
writeFileSync(path.resolve('resources/tray.png'), encodePng(32, render(32)))
writeFileSync(path.resolve('resources/icon.png'), encodePng(256, render(256)))
console.log('wrote resources/tray.png and resources/icon.png')
