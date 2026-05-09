/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { detectCapabilities } from "./caps.js"
import { makeWriteOut } from "./writeOut.js"
import { DEFAULT_FETCH_OPTIONS, type FetchOptions } from "./fetch.js"
import { DEFAULT_PARSE_OPTIONS, type ParseOptions } from "./parse.js"
import { InlineSlot } from "./ui/InlineSlot.js"
import { SidebarPanel } from "./ui/SidebarPanel.js"

export const id = "opencode-images"

export type PluginOptions = {
  maxCellWidth?: number
  maxCellHeight?: number
  cellPixelSize?: { w: number; h: number }
  allowNetwork?: boolean
  networkSizeLimit?: number
  networkTimeoutMs?: number
  customMarkers?: string[]
  allowBareUrls?: boolean
  showSidebar?: boolean
  // Max raw image bytes to transmit via kitty graphics. Images larger than
  // this are skipped with a placeholder to avoid hanging xterm.js. Set to 0
  // to disable the limit (safe in native terminals like kitty/Ghostty).
  maxTransmitBytes?: number
  /** Called when the user clicks on an image. Receives the src path.
   *  When not set and eyesPort is configured, defaults to navigating Eyes. */
  onImageClick?: (src: string) => void
  /** Eyes server port for click-to-navigate. Defaults to EYES_PORT env or 3400. */
  eyesPort?: number
}

const DEFAULTS: Required<Omit<PluginOptions, "cellPixelSize" | "onImageClick">> = {
  maxCellWidth: 30,
  maxCellHeight: 15,
  allowNetwork: true,
  networkSizeLimit: 10 * 1024 * 1024,
  networkTimeoutMs: 5000,
  customMarkers: ["image"],
  allowBareUrls: true,
  showSidebar: true,
  maxTransmitBytes: 512 * 1024,
  eyesPort: parseInt(process.env.EYES_PORT || "3400", 10),
}

// ---------------------------------------------------------------------------
// Eyes navigation: derive a hash route from an image file path and POST to
// the Eyes /api/navigate endpoint to open the relevant section.
// ---------------------------------------------------------------------------
function imagePathToEyesRoute(src: string): string | null {
  // Find the /worlds/ segment and parse from there.
  const idx = src.indexOf("/worlds/")
  if (idx < 0) return null
  const rel = src.slice(idx + "/worlds/".length) // e.g. "my-world/locations/forest/ref.png"
  const parts = rel.split("/")
  if (parts.length < 3) return null

  const worldId = parts[0]
  const entityType = parts[1] // "locations", "characters", "props", "projects"
  const entityId = parts[2]

  // Map plural directory names to singular Eyes route names
  switch (entityType) {
    case "locations":
      return `/world/${worldId}/location/${entityId}`
    case "characters":
      return `/world/${worldId}/character/${entityId}`
    case "props":
      return `/world/${worldId}/prop/${entityId}`
    case "projects": {
      // .../projects/{projectId}/episodes/{episodeId}/shots/{shotId}/filename
      if (parts.length >= 5 && parts[3] === "episodes") {
        const projectId = entityId
        const episodeId = parts[4]
        if (parts.length >= 7 && parts[5] === "shots") {
          const shotId = parts[6]
          const filename = parts[parts.length - 1]
          // keyframe_*.png -> keyframes view (default), video/thumb -> shots view
          const isKeyframe = filename.startsWith("keyframe")
          const view = isKeyframe ? "" : "view=shots&"
          return `/world/${worldId}/project/${projectId}/episode/${episodeId}?${view}shot=${shotId}`
        }
        return `/world/${worldId}/project/${projectId}/episode/${episodeId}`
      }
      return `/world/${worldId}/project/${entityId}`
    }
    default:
      return `/world/${worldId}`
  }
}

function navigateEyes(port: number, src: string): void {
  const route = imagePathToEyesRoute(src)
  if (!route) return
  fetch(`http://127.0.0.1:${port}/api/navigate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: route }),
  }).catch(() => {
    // Eyes not running or unreachable -- silently ignore.
  })
}

const tui: TuiPlugin = async (api: TuiPluginApi, raw) => {
  const opts = (raw ?? {}) as PluginOptions
  const merged = { ...DEFAULTS, ...opts }
  const handleImageClick = opts.onImageClick ?? ((src: string) => navigateEyes(merged.eyesPort, src))
  const caps = detectCapabilities(api.renderer, { cellSize: opts.cellPixelSize })
  const writeOut = makeWriteOut(api.renderer)

  // Resolve relative paths against the project's worktree (preferred) or
  // working directory. Falls back to process.cwd() inside fetch.ts when both
  // are missing.
  const baseDir = api.state.path?.worktree || api.state.path?.directory || undefined

  const fetchOptions: FetchOptions = {
    ...DEFAULT_FETCH_OPTIONS,
    allowNetwork: merged.allowNetwork,
    networkSizeLimit: merged.networkSizeLimit,
    networkTimeoutMs: merged.networkTimeoutMs,
    baseDir,
  }
  const parseOptions: ParseOptions = {
    ...DEFAULT_PARSE_OPTIONS,
    customMarkers: merged.customMarkers,
    allowBareUrls: merged.allowBareUrls,
  }

  await api.client.app.log({
    service: "opencode-images",
    level: "info",
    message: "initialized",
    extra: {
      protocol: caps.protocol,
      inTmux: caps.inTmux,
      cellSize: caps.cellSize,
      termProgram: caps.termProgram ?? null,
    },
  })

  if (caps.protocol === "fallback") {
    await api.client.app.log({
      service: "opencode-images",
      level: "warn",
      message:
        "no supported terminal image protocol detected. Plugin will not render images. " +
        "Tested terminals: kitty, Ghostty, WezTerm, iTerm2, mintty.",
    })
    return
  }

  // Inline placement (requires opencode host with `message_part_after` slot).
  // Declared via the generic so the slot type isn't part of the npm @opencode-ai/plugin
  // shipping at the time of publish. The handler is a no-op on hosts that don't have it.
  api.slots.register<{
    message_part_after: {
      session_id: string
      message_id: string
      part_id: string
      part_type: "text" | "reasoning" | "tool"
      tool_name?: string
      tool_output?: string
    }
  }>({
    order: 100,
    slots: {
      message_part_after(_ctx, props) {
        return (
          <InlineSlot
            api={api}
            message_id={props.message_id}
            part_id={props.part_id}
            part_type={props.part_type}
            tool_name={props.tool_name}
            tool_output={props.tool_output}
            caps={caps}
            writeOut={writeOut}
            renderer={api.renderer}
            fetchOptions={fetchOptions}
            parseOptions={parseOptions}
            maxCellWidth={merged.maxCellWidth}
            maxCellHeight={merged.maxCellHeight}
            maxTransmitBytes={merged.maxTransmitBytes}
            useRefProtocol={caps.forced}
            onImageClick={handleImageClick}
          />
        )
      },
    },
  })

  if (merged.showSidebar) {
    api.slots.register({
      order: 600,
      slots: {
        sidebar_content(_ctx, props) {
          return <SidebarPanel api={api} session_id={props.session_id} parseOptions={parseOptions} />
        },
      },
    })
  }
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
