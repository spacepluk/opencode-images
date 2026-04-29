import type { CliRenderer } from "@opentui/core"

export type Protocol = "kitty" | "iterm2" | "fallback"

export type Capabilities = {
  protocol: Protocol
  /** True when the protocol was forced via OPENCODE_IMAGES_PROTOCOL (Eyes/xterm.js context). */
  forced: boolean
  inTmux: boolean
  termProgram: string | undefined
  cellSize: { w: number; h: number } // pixels per cell
}

function detectITerm2Family(env: NodeJS.ProcessEnv): boolean {
  const tp = env.TERM_PROGRAM ?? ""
  const lt = env.LC_TERMINAL ?? ""
  return (
    /^iTerm\.app$/i.test(tp) ||
    /WezTerm/i.test(tp) ||
    /mintty/i.test(tp) ||
    /^iTerm2$/i.test(lt)
  )
}

function detectGhostty(env: NodeJS.ProcessEnv): boolean {
  // Ghostty sets TERM_PROGRAM=ghostty (since v1.x) or GHOSTTY_RESOURCES_DIR.
  // Inside tmux, TERM is usually tmux-256color and TERM_PROGRAM gets clobbered
  // to "tmux", so we also check GHOSTTY_RESOURCES_DIR which tmux preserves.
  return (
    env.TERM === "xterm-ghostty" ||
    /ghostty/i.test(env.TERM_PROGRAM ?? "") ||
    !!env.GHOSTTY_RESOURCES_DIR ||
    !!env.GHOSTTY_BIN_DIR
  )
}

function detectKittyTerm(env: NodeJS.ProcessEnv): boolean {
  return (
    env.TERM_PROGRAM === "kitty" ||
    !!env.KITTY_WINDOW_ID ||
    !!env.KITTY_PID ||
    !!env.KITTY_INSTALLATION_DIR
  )
}

function detectWezTerm(env: NodeJS.ProcessEnv): boolean {
  return /WezTerm/i.test(env.TERM_PROGRAM ?? "") || !!env.WEZTERM_PANE
}

export function detectCapabilities(
  renderer: CliRenderer,
  override?: { cellSize?: { w: number; h: number } },
): Capabilities {
  const env = process.env
  const inTmux = !!env.TMUX
  const termProgram = env.TERM_PROGRAM

  // Explicit user override — useful when auto-detection is wrong inside tmux.
  const forced = env.OPENCODE_IMAGES_PROTOCOL?.toLowerCase()
  if (forced === "kitty" || forced === "iterm2" || forced === "fallback") {
    return {
      protocol: forced as Protocol,
      forced: true,
      inTmux,
      termProgram,
      cellSize: override?.cellSize ?? { w: 8, h: 16 },
    }
  }

  const caps = renderer.capabilities as { kitty_graphics?: boolean; sixel?: boolean } | null

  // Kitty graphics support detection. OpenTUI's runtime probe is the
  // authoritative signal when it works, but inside tmux without
  // allow-passthrough the probe is swallowed and reports false. Fall back to
  // env-var heuristics that survive tmux.
  const kittyDetected =
    caps?.kitty_graphics === true ||
    detectKittyTerm(env) ||
    detectGhostty(env) ||
    detectWezTerm(env)

  const iterm2Detected = detectITerm2Family(env)

  let protocol: Protocol = "fallback"
  if (kittyDetected) protocol = "kitty"
  else if (iterm2Detected) protocol = "iterm2"

  // Cell pixel size: try renderer.resolution if available, else default 8x16.
  let cellSize = override?.cellSize ?? { w: 8, h: 16 }
  const res = (renderer as any).resolution as
    | { cellWidth?: number; cellHeight?: number }
    | null
    | undefined
  if (!override?.cellSize && res?.cellWidth && res?.cellHeight) {
    cellSize = { w: res.cellWidth, h: res.cellHeight }
  }

  return { protocol, forced: false, inTmux, termProgram, cellSize }
}
