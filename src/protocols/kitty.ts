/**
 * Kitty graphics protocol encoder.
 *
 * https://sw.kovidgoyal.net/kitty/graphics-protocol/
 *
 * Strategy (3 steps for unicode-placeholder placement):
 *  1. Transmit image data with action=T (transmit AND create a virtual
 *     placement) using U=1 to mark it as a unicode-placeholder placement,
 *     and c/r to declare the cell rectangle. The terminal stores the image
 *     and the virtual placement; nothing is drawn yet because U=1.
 *  2. Write placeholder cells: each cell is U+10EEEE plus row/col combining
 *     diacritics, with the image id encoded into the SGR foreground color.
 *     The terminal sees these cells, looks up the virtual placement for the
 *     id, and draws the image into them.
 *  3. On unmount: send action=d to delete the placement.
 *
 * This is the only kitty placement mode that survives TUI redraws cleanly:
 * the placeholder cells are normal text in the framebuffer, so OpenTUI's
 * diff-and-repaint just keeps emitting them and the terminal keeps drawing
 * the image into them.
 */

const PLACEHOLDER = "\u{10EEEE}"

// Row/column diacritics from the kitty spec, abbreviated. The N-th codepoint
// in this list represents row/col index N (0-based). Kitty accepts up to 297
// distinct diacritics; we include enough for typical inline image sizes.
const DIACRITICS = [
  0x305, 0x30d, 0x30e, 0x310, 0x312, 0x33d, 0x33e, 0x33f, 0x346, 0x34a, 0x34b, 0x34c, 0x350, 0x351,
  0x352, 0x357, 0x35b, 0x363, 0x364, 0x365, 0x366, 0x367, 0x368, 0x369, 0x36a, 0x36b, 0x36c, 0x36d,
  0x36e, 0x36f, 0x483, 0x484, 0x485, 0x486, 0x487, 0x592, 0x593, 0x594, 0x595, 0x597, 0x598, 0x599,
  0x59c, 0x59d, 0x59e, 0x59f, 0x5a0, 0x5a1, 0x5a8, 0x5a9, 0x5ab, 0x5ac, 0x5af, 0x5c4, 0x610, 0x611,
  0x612, 0x613, 0x614, 0x615, 0x616, 0x617, 0x657, 0x658, 0x659, 0x65a, 0x65b, 0x65d, 0x65e, 0x6d6,
  0x6d7, 0x6d8, 0x6d9, 0x6da, 0x6db, 0x6dc, 0x6df, 0x6e0, 0x6e1, 0x6e2, 0x6e4, 0x6e7, 0x6e8, 0x6eb,
  0x6ec, 0x730, 0x732, 0x733, 0x735, 0x736, 0x73a, 0x73d, 0x73f, 0x740, 0x741, 0x743, 0x745, 0x747,
  0x749, 0x74a, 0x7eb, 0x7ec, 0x7ed, 0x7ee, 0x7ef, 0x7f0, 0x7f1, 0x7f3, 0x816, 0x817, 0x818, 0x819,
  0x81b, 0x81c, 0x81d, 0x81e, 0x81f, 0x820, 0x821, 0x822, 0x823, 0x825, 0x826, 0x827, 0x829, 0x82a,
  0x82b, 0x82c, 0x82d, 0x951, 0x953, 0x954, 0xf82, 0xf83, 0xf86, 0xf87, 0x135d, 0x135e, 0x135f,
  0x17dd, 0x193a, 0x1a17, 0x1a75, 0x1a76, 0x1a77, 0x1a78, 0x1a79, 0x1a7a, 0x1a7b, 0x1a7c, 0x1b6b,
  0x1b6d, 0x1b6e, 0x1b6f, 0x1b70, 0x1b71, 0x1b72, 0x1b73, 0x1cd0, 0x1cd1, 0x1cd2, 0x1cda, 0x1cdb,
  0x1ce0, 0x1dc0, 0x1dc1, 0x1dc3, 0x1dc4, 0x1dc5, 0x1dc6, 0x1dc7, 0x1dc8, 0x1dc9, 0x1dcb, 0x1dcc,
  0x1dd1, 0x1dd2, 0x1dd3, 0x1dd4, 0x1dd5, 0x1dd6, 0x1dd7, 0x1dd8, 0x1dd9, 0x1dda, 0x1ddb, 0x1ddc,
  0x1ddd, 0x1dde, 0x1ddf, 0x1de0, 0x1de1, 0x1de2, 0x1de3, 0x1de4, 0x1de5, 0x1de6, 0x1dfe, 0x20d0,
  0x20d1, 0x20d4, 0x20d5, 0x20d6, 0x20d7, 0x20db, 0x20dc, 0x20e1, 0x20e7, 0x20e9, 0x20f0, 0x2cef,
  0x2cf0, 0x2cf1, 0x2de0, 0x2de1, 0x2de2, 0x2de3, 0x2de4, 0x2de5, 0x2de6, 0x2de7, 0x2de8, 0x2de9,
  0x2dea, 0x2deb, 0x2dec, 0x2ded, 0x2dee, 0x2def, 0x2df0, 0x2df1, 0x2df2, 0x2df3, 0x2df4, 0x2df5,
  0x2df6, 0x2df7, 0x2df8, 0x2df9, 0x2dfa, 0x2dfb, 0x2dfc, 0x2dfd, 0x2dfe, 0x2dff, 0xa66f, 0xa67c,
  0xa67d, 0xa6f0, 0xa6f1, 0xa8e0, 0xa8e1, 0xa8e2, 0xa8e3, 0xa8e4, 0xa8e5, 0xa8e6, 0xa8e7, 0xa8e8,
  0xa8e9, 0xa8ea, 0xa8eb, 0xa8ec, 0xa8ed, 0xa8ee, 0xa8ef, 0xa8f0, 0xa8f1, 0xaab0, 0xaab2, 0xaab3,
  0xaab7, 0xaab8, 0xaabe, 0xaabf, 0xaac1, 0xfb1e, 0xfe20, 0xfe21, 0xfe22, 0xfe23, 0xfe24, 0xfe25,
  0xfe26, 0x10a0f, 0x10a38, 0x1d185, 0x1d186, 0x1d187, 0x1d188, 0x1d189, 0x1d1aa, 0x1d1ab, 0x1d1ac,
  0x1d1ad, 0x1d242, 0x1d243, 0x1d244,
]

const CHUNK_SIZE = 4096

function base64Encode(bytes: Uint8Array): string {
  // Bun has globalThis.btoa with binary-string semantics, but for >1MB images
  // it's faster to use Buffer.
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64")
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export type KittyTransmitOptions = {
  id: number
  bytes: Uint8Array
  format: "png" | "rgba" | "rgb"
  // Cell rectangle the image will fill via unicode-placeholder placement.
  cellWidth: number
  cellHeight: number
  // Optional explicit image pixel size (required for rgba/rgb formats).
  pixelWidth?: number
  pixelHeight?: number
}

/**
 * Build the transmit-and-create-virtual-placement escape sequence(s) for
 * unicode-placeholder placement.
 *
 * Uses action=T (transmit + place) plus U=1 (unicode-placeholder mode),
 * c=cellWidth, r=cellHeight. Because U=1 is set, the terminal does NOT draw
 * the image at the cursor — it stores a virtual placement that activates
 * when matching placeholder cells are emitted.
 *
 * Returns an array of escape chunks. The caller is responsible for
 * concatenating (or, when going through tmux DCS passthrough, wrapping each
 * chunk individually so that tmux's per-DCS size limit is not exceeded).
 */
export function buildTransmit(opts: KittyTransmitOptions): string[] {
  const { id, bytes, format, cellWidth, cellHeight, pixelWidth, pixelHeight } = opts
  const b64 = base64Encode(bytes)
  const f = format === "png" ? 100 : format === "rgba" ? 32 : 24
  const pixAttrs =
    f !== 100 && pixelWidth && pixelHeight ? `,s=${pixelWidth},v=${pixelHeight}` : ""
  const baseAttrs = `a=T,U=1,f=${f},i=${id},c=${cellWidth},r=${cellHeight},q=2${pixAttrs}`

  if (b64.length <= CHUNK_SIZE) {
    return [`\x1b_G${baseAttrs};${b64}\x1b\\`]
  }

  const parts: string[] = []
  let offset = 0
  let first = true
  while (offset < b64.length) {
    const next = Math.min(offset + CHUNK_SIZE, b64.length)
    const isLast = next >= b64.length
    const chunk = b64.slice(offset, next)
    if (first) {
      parts.push(`\x1b_G${baseAttrs},m=${isLast ? 0 : 1};${chunk}\x1b\\`)
      first = false
    } else {
      parts.push(`\x1b_Gm=${isLast ? 0 : 1},q=2;${chunk}\x1b\\`)
    }
    offset = next
  }
  return parts
}

/**
 * Build the delete sequence for an image id.
 */
export function buildDelete(id: number): string {
  return `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`
}

/**
 * Build the placement-cells content for a single row. Each cell is the
 * placeholder character (U+10EEEE) followed by row + column combining
 * diacritics. The image id MUST be encoded into the cells' SGR foreground
 * color separately (the caller sets fg via the host renderer or by emitting
 * SGR escapes around the text). This function returns ONLY the text content,
 * no escape sequences, so it is safe to embed in any cell-grid renderer.
 */
export function buildPlaceholderRow(opts: {
  imageId: number
  row: number
  cols: number
  placementId?: number
}): string {
  const { row, cols, placementId = 0 } = opts

  if (row >= DIACRITICS.length) {
    throw new Error(`opencode-images: row ${row} exceeds diacritic table size`)
  }
  const rowDia = String.fromCodePoint(DIACRITICS[row]!)

  let out = ""
  for (let c = 0; c < cols; c++) {
    if (c >= DIACRITICS.length) {
      throw new Error(`opencode-images: col ${c} exceeds diacritic table size`)
    }
    const colDia = String.fromCodePoint(DIACRITICS[c]!)
    out += PLACEHOLDER + rowDia + colDia
    if (placementId > 0) {
      // Use modular index so IDs beyond the diacritic table size still
      // produce distinct values (wrapping rather than clamping to the
      // last entry, which would collapse all large IDs into one).
      const pdia = DIACRITICS[placementId % DIACRITICS.length]!
      out += String.fromCodePoint(pdia)
    }
  }
  return out
}

/**
 * Build a row wrapped in raw SGR escape sequences. Use this when writing
 * directly to stdout (e.g. the standalone test) where the terminal will
 * interpret the escapes natively. Inside an OpenTUI cell-grid renderer, use
 * `buildPlaceholderRow` and set fg via `<span fg="#rrggbb">`.
 */
export function buildPlaceholderRowWithSgr(opts: {
  imageId: number
  row: number
  cols: number
  placementId?: number
}): string {
  const { imageId } = opts
  const r = (imageId >> 16) & 0xff
  const g = (imageId >> 8) & 0xff
  const b = imageId & 0xff
  return `\x1b[38;2;${r};${g};${b}m` + buildPlaceholderRow(opts) + `\x1b[39m`
}

/**
 * Compute the hex foreground color string that encodes an image id for use
 * with unicode-placeholder placement.
 */
export function imageIdToFgHex(imageId: number): string {
  const r = (imageId >> 16) & 0xff
  const g = (imageId >> 8) & 0xff
  const b = imageId & 0xff
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`
}
