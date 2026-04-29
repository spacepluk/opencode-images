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
}

const DEFAULTS: Required<Omit<PluginOptions, "cellPixelSize">> = {
  maxCellWidth: 30,
  maxCellHeight: 15,
  allowNetwork: true,
  networkSizeLimit: 10 * 1024 * 1024,
  networkTimeoutMs: 5000,
  customMarkers: ["image"],
  allowBareUrls: true,
  showSidebar: true,
  maxTransmitBytes: 512 * 1024,
}

const tui: TuiPlugin = async (api: TuiPluginApi, raw) => {
  const opts = (raw ?? {}) as PluginOptions
  const merged = { ...DEFAULTS, ...opts }
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
