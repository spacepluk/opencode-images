/** @jsxImportSource @opentui/solid */
import { createSignal, onMount, onCleanup, Show, type Component } from "solid-js"
import type { BoxRenderable, CliRenderer } from "@opentui/core"
import * as kitty from "../protocols/kitty.js"
import * as iterm2 from "../protocols/iterm2.js"
import { maybeTmuxWrap } from "../tmux.js"
import { fetchImage, readImageDimensions, type FetchedImage } from "../fetch.js"
import { parseImageInfo } from "../dimensions.js"
import { isAbsolute, resolve } from "node:path"
import type { Capabilities } from "../caps.js"
import type { WriteOut } from "../writeOut.js"

// Deterministic image IDs: hash the file path to a 24-bit ID so the same
// file always produces the same ID regardless of process restarts. This
// ensures server-replayed ref escapes, browser bitmap caches, and fresh
// TUI renders all reference the same ID for a given path.
function stableImageId(src: string): number {
  // FNV-1a hash reduced to 24 bits (fits in kitty fg color encoding).
  let h = 0x811c9dc5
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  // Map to [1, 0xFFFFFE] — avoid 0 (invalid) and 0xFFFFFF
  return ((h >>> 0) & 0xfffffe) || 1
}

// ---------------------------------------------------------------------------
// Transmit queue: serialize image transmissions for native kitty terminals.
// In the "ref" protocol (xterm.js/Eyes), only the lightweight escape is
// queued — the heavy image fetch happens client-side in the browser.
// ---------------------------------------------------------------------------
const TRANSMIT_DELAY_MS = 100
let transmitQueue: Promise<void> = Promise.resolve()
function enqueueTransmit<T>(fn: () => Promise<T>): Promise<T> {
  const p = transmitQueue.then(() => fn()).then((result) => {
    return new Promise<T>((resolve) => setTimeout(() => resolve(result), TRANSMIT_DELAY_MS))
  })
  transmitQueue = p.then(() => {}, () => {})
  return p
}

// ---------------------------------------------------------------------------
// Transmit cache: reuse kitty image IDs for the same src + cell dimensions.
// ---------------------------------------------------------------------------
type CacheEntry = {
  imageId: number
  cellW: number
  cellH: number
  fetched: FetchedImage
  refcount: number
}
const transmitCache = new Map<string, CacheEntry>()

function cacheKey(src: string, cellW: number, cellH: number): string {
  return `${src}@${cellW}x${cellH}`
}

// ---------------------------------------------------------------------------
// Image size limits and downscaling (native kitty only).
// In "ref" mode, downscaling is done client-side by Eyes.
// ---------------------------------------------------------------------------
const MAX_TRANSMIT_BYTES = 150 * 1024

let sharpModule: any = undefined
let sharpChecked = false
async function tryDownscale(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array | null> {
  if (!sharpChecked) {
    sharpChecked = true
    try {
      // @ts-ignore -- sharp is an optional peer; not in devDependencies
      sharpModule = (await import(/* webpackIgnore: true */ "sharp")).default
    } catch { /* sharp not available */ }
  }
  if (!sharpModule) return null
  try {
    for (const width of [480, 320, 240, 160]) {
      const result = await sharpModule(Buffer.from(bytes))
        .resize({ width, fit: "inside", withoutEnlargement: true })
        .png({ effort: 1, compressionLevel: 9 })
        .toBuffer()
      if (result.length <= maxBytes) {
        return new Uint8Array(result.buffer, result.byteOffset, result.byteLength)
      }
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Lightweight reference escape for Eyes/xterm.js context.
// Format: \x1b_L<key>=<value>,<key>=<value>\x1b\\
// Keys: p=path, i=id, c=cols, r=rows
// Eyes' Terminal.js intercepts this and fetches the image client-side.
// ---------------------------------------------------------------------------
function buildRefEscape(path: string, id: number, cols: number, rows: number): string {
  // Send the absolute path. Eyes' /api/terminal-image endpoint validates
  // it against worldsRoot for security.
  const safePath = path.replace(/\\/g, '/').replace(/;/g, '%3B').replace(/,/g, '%2C')
  return `\x1b_Lp=${safePath},i=${id},c=${cols},r=${rows}\x1b\\`
}

function buildRefDelete(id: number): string {
  return `\x1b_La=d,i=${id}\x1b\\`
}

// ---------------------------------------------------------------------------
// Ref escape batch queue: collect ref escapes from all ImageBox instances
// and flush them in a single writeOut call per microtask. This avoids
// flooding the renderer with N individual writeOut calls when many images
// mount simultaneously (e.g. terminal switch with 30+ images).
// ---------------------------------------------------------------------------
let _refBatch: string[] = []
let _refBatchWriter: ((data: string | Uint8Array) => void) | null = null
let _refBatchScheduled = false

function enqueueRefEscape(escape: string, writeOut: WriteOut): void {
  _refBatch.push(escape)
  _refBatchWriter = writeOut
  if (!_refBatchScheduled) {
    _refBatchScheduled = true
    queueMicrotask(flushRefBatch)
  }
}

function flushRefBatch(): void {
  _refBatchScheduled = false
  const writer = _refBatchWriter
  const batch = _refBatch
  _refBatch = []
  _refBatchWriter = null
  if (writer && batch.length > 0) {
    writer(batch.join(''))
  }
}

// ---------------------------------------------------------------------------
// Props & helpers.
// ---------------------------------------------------------------------------
export type ImageBoxProps = {
  src: string
  alt?: string
  cellWidth?: number
  cellHeight?: number
  maxCellWidth: number
  maxCellHeight: number
  caps: Capabilities
  writeOut: WriteOut
  renderer: CliRenderer
  fetchOptions: Parameters<typeof fetchImage>[1]
  maxTransmitBytes?: number
  /** Use lightweight reference escapes instead of full kitty transmit.
   *  Eyes sets this to true; native terminals use false (full transmit). */
  useRefProtocol?: boolean
  /** Called when the user clicks on the image. Receives the image src path. */
  onImageClick?: (src: string) => void
}

type Loaded = {
  fetched?: FetchedImage  // undefined in ref mode (Eyes handles the pixels)
  cellW: number
  cellH: number
  imageId: number
}

function computeCells(
  fetched: FetchedImage,
  caps: Capabilities,
  override: { cellWidth?: number; cellHeight?: number },
  maxW: number,
  maxH: number,
): { cellW: number; cellH: number } {
  if (override.cellWidth && override.cellHeight) {
    return { cellW: override.cellWidth, cellH: override.cellHeight }
  }
  if (!fetched.info) {
    return { cellW: Math.min(20, maxW), cellH: Math.min(10, maxH) }
  }
  const { width: pxW, height: pxH } = fetched.info
  const { w: cellPxW, h: cellPxH } = caps.cellSize
  const naturalCellW = Math.max(1, Math.ceil(pxW / cellPxW))
  const cellsAspect = (pxH / pxW) * (cellPxW / cellPxH)
  let targetW = override.cellWidth ?? Math.min(naturalCellW, maxW)
  let targetH = override.cellHeight ?? Math.max(1, Math.round(targetW * cellsAspect))
  if (!override.cellHeight && targetH > maxH) {
    targetH = maxH
    if (!override.cellWidth) {
      targetW = Math.max(1, Math.round(targetH / cellsAspect))
      targetW = Math.min(targetW, maxW)
    }
  }
  return { cellW: targetW, cellH: targetH }
}

// ---------------------------------------------------------------------------
// ImageBox component.
// ---------------------------------------------------------------------------
export const ImageBox: Component<ImageBoxProps> = (props) => {
  const [state, setState] = createSignal<Loaded | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  let cacheEntry: CacheEntry | null = null
  let cacheEntryKey: string | null = null
  let disposed = false


  onMount(async () => {
    if (props.useRefProtocol) {
      // ── Ref protocol (Eyes/xterm.js) ──────────────────────────────
      // Emit a lightweight escape with just the path. Eyes fetches the
      // image client-side and calls kittyAddon.registerImage(). No heavy
      // data goes through the terminal at all.
      //
      // Only read the first 4KB of the file to parse pixel dimensions
      // for aspect-ratio computation — no full file read needed.
      try {
        // Resolve relative paths against fetchOptions.baseDir (project
        // worktree), matching what fetchImage does for the full transmit
        // path. Without this, relative paths from tool output fail.
        let imgPath = props.src
        if (!isAbsolute(imgPath)) {
          const base = props.fetchOptions.baseDir ?? process.cwd()
          imgPath = resolve(base, imgPath)
        }

        const info = await readImageDimensions(imgPath)
        if (disposed) return
        // File missing or not a recognized image — render nothing.
        if (!info) return

        const pseudo = { info, bytes: new Uint8Array(0), source: "file" as const, url: imgPath }
        const { cellW, cellH } = computeCells(
          pseudo, props.caps,
          { cellWidth: props.cellWidth, cellHeight: props.cellHeight },
          props.maxCellWidth, props.maxCellHeight,
        )

        const id = stableImageId(imgPath)
        setState({ cellW, cellH, imageId: id })
        enqueueRefEscape(buildRefEscape(imgPath, id, cellW, cellH), props.writeOut)
      } catch {
        // Unexpected error — render nothing.
      }
      return
    }

    // ── Full kitty transmit (native terminals) ────────────────────
    await enqueueTransmit(async () => {
      if (disposed) return

      let result = await fetchImage(props.src, props.fetchOptions)
      if ("error" in result) {
        setError(result.error)
        return
      }

      const limit = props.maxTransmitBytes ?? MAX_TRANSMIT_BYTES
      if (limit > 0 && result.bytes.length > limit) {
        const downscaled = await tryDownscale(result.bytes, limit)
        if (downscaled) {
          result = { ...result, bytes: downscaled, info: parseImageInfo(downscaled) }
        } else {
          const kb = Math.round(result.bytes.length / 1024)
          const limitKb = Math.round(limit / 1024)
          setError(`${kb}KB exceeds ${limitKb}KB limit`)
          return
        }
      }

      if (disposed) return

      const { cellW, cellH } = computeCells(
        result, props.caps,
        { cellWidth: props.cellWidth, cellHeight: props.cellHeight },
        props.maxCellWidth, props.maxCellHeight,
      )

      const key = cacheKey(props.src, cellW, cellH)
      cacheEntryKey = key
      const cached = transmitCache.get(key)
      if (cached) {
        cached.refcount++
        cacheEntry = cached
        setState({ fetched: cached.fetched, cellW, cellH, imageId: cached.imageId })
        return
      }

      const id = stableImageId(props.src)
      if (props.caps.protocol === "kitty") {
        const chunks = kitty.buildTransmit({
          id,
          bytes: result.bytes,
          format: "png",
          cellWidth: cellW,
          cellHeight: cellH,
        })
        try {
          for (const chunk of chunks) {
            props.writeOut(maybeTmuxWrap(chunk, props.caps.inTmux))
          }
        } catch (e) {
          setError("transmit: " + (e as Error).message)
          return
        }
      }

      cacheEntry = { imageId: id, cellW, cellH, fetched: result, refcount: 1 }
      transmitCache.set(key, cacheEntry)
      setState({ fetched: result, cellW, cellH, imageId: id })
    })
  })

  onCleanup(() => {
    disposed = true

    if (props.useRefProtocol) {
      // In ref mode, do NOT emit delete escapes. The browser-side bitmap
      // cache and addon storage serve as long-lived stores. Emitting
      // deletes here causes a race: the TUI tears down old components
      // (deletes) and creates new ones (async registers), but deletes
      // arrive at the browser first and clear the images before the new
      // registers can repopulate them, causing a visible flash-to-blank.
      return
    }
    if (!cacheEntry || !cacheEntryKey) return
    cacheEntry.refcount--
    if (cacheEntry.refcount <= 0) {
      transmitCache.delete(cacheEntryKey)
      if (props.caps.protocol === "kitty") {
        try {
          props.writeOut(maybeTmuxWrap(kitty.buildDelete(cacheEntry.imageId), props.caps.inTmux))
        } catch { /* ignore */ }
      }
    }
  })

  const handleClick = (evt: any) => {
    // Don't trigger click if user was selecting text
    if (props.renderer.getSelection()?.getSelectedText()) return
    evt?.stopPropagation?.()
    props.onImageClick?.(props.src)
  }

  return (
    <Show
      when={state()}
      fallback={null}
    >
      {(loaded) => {
        if (props.caps.protocol === "kitty") {
          return (
            <box selectable={false} onMouseUp={handleClick}>
              <KittyPlaceholder cellW={loaded().cellW} cellH={loaded().cellH} imageId={loaded().imageId} />
            </box>
          )
        }
        if (props.caps.protocol === "iterm2") {
          return (
            <box selectable={false} onMouseUp={handleClick}>
              <ItermBox
                cellW={loaded().cellW}
                cellH={loaded().cellH}
                bytes={loaded().fetched?.bytes ?? new Uint8Array(0)}
                filename={props.src.split("/").pop()}
                caps={props.caps}
                writeOut={props.writeOut}
              />
            </box>
          )
        }
        return <text fg="#888888">[image: {props.src.split("/").pop()}]</text>
      }}
    </Show>
  )
}

// ---------------------------------------------------------------------------
// Kitty placeholder cells.
// ---------------------------------------------------------------------------
const KittyPlaceholder: Component<{ cellW: number; cellH: number; imageId: number }> = (props) => {
  const fg = () => kitty.imageIdToFgHex(props.imageId)
  return (
    <box width={props.cellW} height={props.cellH} flexShrink={0} selectable={false}>
      {Array.from({ length: props.cellH }, (_, row) => (
        <text selectable={false}>
          <span style={{ fg: fg() }}>
            {kitty.buildPlaceholderRow({
              imageId: props.imageId,
              row,
              cols: props.cellW,
              placementId: props.imageId,
            })}
          </span>
        </text>
      ))}
    </box>
  )
}

// ---------------------------------------------------------------------------
// iTerm2 inline image (cursor-positioned, doesn't survive scroll).
// ---------------------------------------------------------------------------
const ItermBox: Component<{
  cellW: number
  cellH: number
  bytes: Uint8Array
  filename?: string
  caps: Capabilities
  writeOut: WriteOut
}> = (props) => {
  let itermRef: BoxRenderable | undefined

  const emit = () => {
    if (!itermRef) return
    const x = (itermRef as any).screenX as number
    const y = (itermRef as any).screenY as number
    if (typeof x !== "number" || typeof y !== "number") return
    const seq =
      iterm2.buildSaveCursor() +
      iterm2.buildCup(y, x) +
      iterm2.buildITermInline({
        bytes: props.bytes,
        cellWidth: props.cellW,
        cellHeight: props.cellH,
        filename: props.filename,
        preserveAspectRatio: true,
      }) +
      iterm2.buildRestoreCursor()
    props.writeOut(maybeTmuxWrap(seq, props.caps.inTmux))
  }

  onMount(() => { queueMicrotask(emit) })

  return (
    <box ref={(b) => (itermRef = b)} width={props.cellW} height={props.cellH} flexShrink={0} />
  )
}
