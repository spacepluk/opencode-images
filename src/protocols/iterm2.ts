/**
 * iTerm2 inline images protocol.
 *
 * https://iterm2.com/documentation-images.html
 *
 *   ESC ] 1337 ; File = [args] : <base64> BEL
 *
 * Args:
 *   inline=1                  show inline (otherwise download)
 *   width=<N>, height=<N>     in cells (auto by default)
 *   preserveAspectRatio=1     keep aspect ratio
 *   size=<bytes>              file size hint
 *   name=<base64-of-name>     filename hint
 *
 * Unlike kitty, iTerm2 places the image AT THE CURSOR POSITION at the time
 * the escape is processed, and the image flows with text — it occupies cells
 * and scrolls naturally. We emit the cursor positioning escape immediately
 * before the image escape.
 */

function base64Encode(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64")
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export type ITermInlineOptions = {
  bytes: Uint8Array
  // Filename for hint only.
  filename?: string
  // Cell dimensions for the image area. Required so the image doesn't reflow.
  cellWidth: number
  cellHeight: number
  preserveAspectRatio?: boolean
}

export function buildITermInline(opts: ITermInlineOptions): string {
  const args: string[] = ["inline=1"]
  args.push(`width=${opts.cellWidth}`)
  args.push(`height=${opts.cellHeight}`)
  args.push(`preserveAspectRatio=${opts.preserveAspectRatio === false ? 0 : 1}`)
  args.push(`size=${opts.bytes.length}`)
  if (opts.filename) args.push(`name=${base64Encode(new TextEncoder().encode(opts.filename))}`)
  const b64 = base64Encode(opts.bytes)
  return `\x1b]1337;File=${args.join(";")}:${b64}\x07`
}

/**
 * Move the cursor to (row, col) in 1-indexed terminal coordinates.
 */
export function buildCup(row: number, col: number): string {
  return `\x1b[${row + 1};${col + 1}H`
}

/**
 * Save and restore cursor (DECSC/DECRC). Wrapping the inline-image emission
 * in these prevents disturbing the host renderer's cursor expectations.
 */
export function buildSaveCursor(): string {
  return "\x1b7"
}
export function buildRestoreCursor(): string {
  return "\x1b8"
}
