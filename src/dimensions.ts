/**
 * Parse pixel dimensions and MIME type from image bytes by reading headers
 * only. Supports PNG, JPEG, GIF, WebP. No pixel decoding.
 */

export type ImageInfo = {
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/unknown"
  width: number
  height: number
}

export function parseImageInfo(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 12) return null

  // PNG: 8-byte signature, then IHDR chunk: 4 len, "IHDR", 4 width, 4 height (BE)
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    if (bytes.length < 24) return null
    const w = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]
    const h = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]
    return { mime: "image/png", width: w >>> 0, height: h >>> 0 }
  }

  // GIF: "GIF87a" or "GIF89a", LE width/height at bytes 6..9.
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    const w = bytes[6] | (bytes[7] << 8)
    const h = bytes[8] | (bytes[9] << 8)
    return { mime: "image/gif", width: w, height: h }
  }

  // WebP: "RIFF????WEBP" then a chunk header. We handle VP8/VP8L/VP8X.
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    if (bytes.length < 30) return null
    const tag = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
    if (tag === "VP8 ") {
      // VP8 (lossy): width/height in bits 26-27 (LE) and 28-29.
      const w = (bytes[26] | (bytes[27] << 8)) & 0x3fff
      const h = (bytes[28] | (bytes[29] << 8)) & 0x3fff
      return { mime: "image/webp", width: w, height: h }
    }
    if (tag === "VP8L") {
      // VP8L: 1 + ((b21 | b22<<8) & 0x3FFF), 1 + ((b22>>6 | b23<<2 | b24<<10) & 0x3FFF)
      const w1 = ((bytes[21] | (bytes[22] << 8)) & 0x3fff) + 1
      const h1 =
        (((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10)) & 0x3fff) + 1
      return { mime: "image/webp", width: w1, height: h1 }
    }
    if (tag === "VP8X") {
      // VP8X: width-1 at bytes 24..26 LE, height-1 at 27..29 LE.
      const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16))
      const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
      return { mime: "image/webp", width: w, height: h }
    }
  }

  // JPEG: scan markers for SOFn (0xFFC0..0xFFCF except 0xC4, 0xC8, 0xCC).
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++
        continue
      }
      // Skip fill bytes
      while (i < bytes.length && bytes[i] === 0xff) i++
      if (i >= bytes.length) break
      const marker = bytes[i]
      i++
      if (marker === 0xd8 || marker === 0xd9) continue // SOI/EOI no payload
      if (i + 1 >= bytes.length) break
      const segLen = (bytes[i] << 8) | bytes[i + 1]
      const isSof =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      if (isSof) {
        if (i + 7 >= bytes.length) break
        const h = (bytes[i + 3] << 8) | bytes[i + 4]
        const w = (bytes[i + 5] << 8) | bytes[i + 6]
        return { mime: "image/jpeg", width: w, height: h }
      }
      i += segLen
    }
  }

  return null
}
