import { resolveRenderLib, type CliRenderer } from "@opentui/core"

/**
 * Write raw bytes/escape sequences to the terminal, bypassing OpenTUI's
 * cell-grid framebuffer. Routes through the same path as the renderer's own
 * ANSI output so the bytes are correctly interleaved with frame output.
 */
export function makeWriteOut(renderer: CliRenderer) {
  const lib = resolveRenderLib()
  // Read rendererPtr fresh on every call instead of capturing once.
  // The pointer can become stale if the renderer recreates its native
  // state (e.g. on resize or theme change), causing all subsequent
  // writeOut calls to silently no-op or write to freed memory.
  return (data: string | Uint8Array) => {
    const ptr = renderer.rendererPtr
    if (!ptr) return
    lib.writeOut(ptr, data)
  }
}

export type WriteOut = ReturnType<typeof makeWriteOut>
