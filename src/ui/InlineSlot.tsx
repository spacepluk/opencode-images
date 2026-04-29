/** @jsxImportSource @opentui/solid */
import { createMemo, For, type Component } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { parseImageRefs, parseToolOutputImageRefs, type ImageRef, type ParseOptions } from "../parse.js"
import { ImageBox } from "./ImageBox.js"
import type { Capabilities } from "../caps.js"
import type { WriteOut } from "../writeOut.js"
import type { FetchOptions } from "../fetch.js"
import type { CliRenderer } from "@opentui/core"

export type InlineSlotProps = {
  api: TuiPluginApi
  message_id: string
  part_id: string
  part_type: "text" | "reasoning" | "tool"
  tool_name?: string
  tool_output?: string
  caps: Capabilities
  writeOut: WriteOut
  renderer: CliRenderer
  fetchOptions: FetchOptions
  parseOptions: ParseOptions
  maxCellWidth: number
  maxCellHeight: number
  maxTransmitBytes?: number
}

const GRID_GAP = 1 // cell gap between images

export const InlineSlot: Component<InlineSlotProps> = (props) => {
  // Stable refs: during text streaming the memo re-runs on every token.
  // parseImageRefs creates new objects each time, which would cause <For>
  // to tear down and recreate all ImageBox components (killing in-flight
  // async dimension reads). We stabilize by keeping previous ref objects
  // when their src hasn't changed.
  let prevRefs: ImageRef[] = []
  const refs = createMemo(() => {
    // Always read from the reactive state API so the memo re-runs
    // when any part of the message changes — including tool completion.
    // The tool_output prop alone may not trigger reactivity depending
    // on how the plugin slot system propagates prop updates.
    const parts = props.api.state.part(props.message_id)

    let next: ImageRef[]
    if (props.part_type === "tool") {
      // Try the prop first, fall back to extracting from state
      const output = props.tool_output
        ?? (parts.find((p: any) => p.id === props.part_id && p.state?.status === "completed")?.state?.output as string | undefined)
      next = output ? parseToolOutputImageRefs(output) : []
    } else if (props.part_type === "text") {
      const part = parts.find((p) => p.id === props.part_id)
      next = part && part.type === "text" ? parseImageRefs(part.text, props.parseOptions) : []
    } else {
      next = []
    }
    // Preserve object identity for refs whose src hasn't changed,
    // so <For> reuses existing ImageBox components instead of
    // tearing them down and recreating.
    const prevBySrc = new Map(prevRefs.map((r) => [r.src, r]))
    const stable = next.map((r) => prevBySrc.get(r.src) ?? r)
    prevRefs = stable
    return stable
  })

  return (
    <box flexDirection="row" flexWrap="wrap" gap={GRID_GAP} marginTop={1}>
      <For each={refs()}>
        {(ref) => (
          <ImageBox
            src={ref.src}
            alt={ref.alt}
            cellWidth={ref.cellWidth}
            cellHeight={ref.cellHeight}
            maxCellWidth={props.maxCellWidth}
            maxCellHeight={props.maxCellHeight}
            maxTransmitBytes={props.maxTransmitBytes}
            caps={props.caps}
            writeOut={props.writeOut}
            renderer={props.renderer}
            fetchOptions={props.fetchOptions}
          />
        )}
      </For>
    </box>
  )
}
