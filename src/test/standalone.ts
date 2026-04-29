/**
 * Standalone self-test for the kitty graphics protocol path.
 *
 * Runs three tests so you can pinpoint where things go wrong:
 *   A. Direct placement (a=T): transmit + place at cursor in one go.
 *      If this works, your terminal supports kitty graphics.
 *   B. Unicode-placeholder placement: transmit (a=t), then write placeholder
 *      cells with image-id encoded into fg color + row/col diacritics.
 *      If A works and B doesn't, the placeholder encoding is broken.
 *   C. Cleanup.
 *
 * Usage:
 *   bun run src/test/standalone.ts <path-to-image>           # quiet
 *   bun run src/test/standalone.ts <path-to-image> --verbose # echo terminal responses
 *
 * Inside tmux, you must enable passthrough first:
 *   tmux set -g allow-passthrough on
 */

import { readFileSync } from "node:fs"
import * as kitty from "../protocols/kitty.js"
import { maybeTmuxWrap } from "../tmux.js"
import { parseImageInfo } from "../dimensions.js"

const path = process.argv[2]
const verbose = process.argv.includes("--verbose") || process.argv.includes("-v")
if (!path) {
  console.error("usage: bun run src/test/standalone.ts <path-to-image> [--verbose]")
  process.exit(1)
}

const bytes = new Uint8Array(readFileSync(path))
const info = parseImageInfo(bytes)
const inTmux = !!process.env.TMUX
const id = 7

console.log("=== environment ===")
console.log("TERM         =", process.env.TERM)
console.log("TERM_PROGRAM =", process.env.TERM_PROGRAM)
console.log("TMUX         =", process.env.TMUX ?? "(none)")
console.log("GHOSTTY      =", process.env.GHOSTTY_RESOURCES_DIR ? "yes" : "no")
console.log("KITTY        =", process.env.KITTY_WINDOW_ID ? "yes" : "no")
console.log("verbose      =", verbose)
console.log("")
console.log("=== image ===")
console.log("path:", path)
console.log("size:", bytes.length, "bytes")
console.log("info:", info)

const cellPxW = 8
const cellPxH = 16
const naturalCellW = info ? Math.ceil(info.width / cellPxW) : 30
const naturalCellH = info ? Math.ceil(info.height / cellPxH) : 15
const cellW = Math.min(40, naturalCellW)
const aspect = info ? info.height / info.width : 0.5
const cellH = Math.max(1, Math.round((cellW * aspect * cellPxW) / cellPxH))
console.log("display cells:", cellW, "x", cellH)
console.log("")

const wrap = (s: string) => maybeTmuxWrap(s, inTmux)

// In verbose mode, set q=0 so the terminal echoes back OK / EINVAL / etc.
const Q = verbose ? "0" : "2"

function b64(bs: Uint8Array): string {
  return Buffer.from(bs).toString("base64")
}

// --- A. Direct placement (a=T) -----------------------------------------
function buildDirectPlacementChunks(opts: {
  id: number
  bytes: Uint8Array
  cellW: number
  cellH: number
}): string[] {
  const data = b64(opts.bytes)
  const CHUNK = 4096
  if (data.length <= CHUNK) {
    return [`\x1b_Ga=T,f=100,i=${opts.id},c=${opts.cellW},r=${opts.cellH},q=${Q};${data}\x1b\\`]
  }
  const parts: string[] = []
  let offset = 0
  let first = true
  while (offset < data.length) {
    const next = Math.min(offset + CHUNK, data.length)
    const isLast = next >= data.length
    const chunk = data.slice(offset, next)
    if (first) {
      parts.push(
        `\x1b_Ga=T,f=100,i=${opts.id},c=${opts.cellW},r=${opts.cellH},q=${Q},m=${isLast ? 0 : 1};${chunk}\x1b\\`,
      )
      first = false
    } else {
      parts.push(`\x1b_Gm=${isLast ? 0 : 1},q=${Q};${chunk}\x1b\\`)
    }
    offset = next
  }
  return parts
}

console.log("=== test A: direct placement (a=T) ===")
console.log("If this shows the image, your terminal supports kitty graphics.")
console.log("(Image appears below; cursor advances after.)")
process.stdout.write("\n")
const aChunks = buildDirectPlacementChunks({ id: id + 100, bytes, cellW, cellH })
console.log(`test A chunks: ${aChunks.length}`)
for (const chunk of aChunks) {
  process.stdout.write(wrap(chunk))
}
// kitty draws the image AT the cursor; we don't know how many cells the
// terminal advanced, so leave a generous gap.
process.stdout.write("\n".repeat(cellH + 1))
console.log("^ test A above ^")
console.log("")

// --- B. Unicode-placeholder placement -----------------------------------
console.log("=== test B: unicode-placeholder placement ===")
console.log(`Image transmitted with a=t (id=${id}), then placed via diacritic cells.`)
process.stdout.write("\n")
// Use a=T + U=1 so a virtual placement is created and the image will render
// into the placeholder cells we emit afterwards.
function buildTransmitChunks(opts: { id: number; bytes: Uint8Array; cellW: number; cellH: number }): string[] {
  const data = b64(opts.bytes)
  const CHUNK = 4096
  const baseAttrs = `a=T,U=1,f=100,i=${opts.id},c=${opts.cellW},r=${opts.cellH},q=${Q}`
  if (data.length <= CHUNK) {
    return [`\x1b_G${baseAttrs};${data}\x1b\\`]
  }
  const parts: string[] = []
  let offset = 0
  let first = true
  while (offset < data.length) {
    const next = Math.min(offset + CHUNK, data.length)
    const isLast = next >= data.length
    const chunk = data.slice(offset, next)
    if (first) {
      parts.push(`\x1b_G${baseAttrs},m=${isLast ? 0 : 1};${chunk}\x1b\\`)
      first = false
    } else {
      parts.push(`\x1b_Gm=${isLast ? 0 : 1},q=${Q};${chunk}\x1b\\`)
    }
    offset = next
  }
  return parts
}
const transmitChunks = buildTransmitChunks({ id, bytes, cellW, cellH })
console.log(`transmit chunks: ${transmitChunks.length} (each wrapped in its own tmux DCS when in tmux)`)
for (const chunk of transmitChunks) {
  process.stdout.write(wrap(chunk))
}
const transmit = transmitChunks.join("")
for (let row = 0; row < cellH; row++) {
  process.stdout.write(kitty.buildPlaceholderRowWithSgr({ imageId: id, row, cols: cellW }) + "\n")
}
console.log("^ test B above ^")
console.log("")

console.log("=== diagnostics ===")
console.log("transmit escape length:", transmit.length, "bytes")
console.log("first placeholder row (4 cells, JSON):")
console.log(JSON.stringify(kitty.buildPlaceholderRowWithSgr({ imageId: id, row: 0, cols: 4 })))
console.log("")
if (verbose) {
  console.log("Watch for kitty response sequences (printed below as raw text).")
  console.log("OK responses look like: \\x1b_Gi=N,...;OK\\x1b\\\\")
  console.log("Errors look like:      \\x1b_Gi=N,...;ENOTSUP|EINVAL|...\\x1b\\\\")
  console.log("")
  // Echo stdin so terminal responses become visible
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.on("data", (chunk) => {
      const s = chunk.toString()
      if (s === "\x03" || s === "q") {
        process.stdin.setRawMode(false)
        process.stdout.write(wrap(kitty.buildDelete(id)))
        process.stdout.write(wrap(kitty.buildDelete(id + 100)))
        process.exit(0)
      }
      // Render bytes as JSON so escape sequences are visible.
      process.stdout.write("\nresponse: " + JSON.stringify(s) + "\n")
    })
  }
}

console.log("Cleanup in 30s. Press Ctrl-C (or `q` in verbose mode) to exit early.")
setTimeout(() => {
  process.stdout.write(wrap(kitty.buildDelete(id)))
  process.stdout.write(wrap(kitty.buildDelete(id + 100)))
  process.exit(0)
}, 30000)
