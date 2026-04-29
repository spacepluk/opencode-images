/** @jsxImportSource @opentui/solid */
import { createMemo, For, Show, type Component } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { parseImageRefs, type ParseOptions } from "../parse.js"

export type SidebarPanelProps = {
  api: TuiPluginApi
  session_id: string
  parseOptions: ParseOptions
}

export const SidebarPanel: Component<SidebarPanelProps> = (props) => {
  const theme = () => props.api.theme.current
  const refs = createMemo(() => {
    const messages = props.api.state.session.messages(props.session_id)
    const out: { src: string; alt?: string; messageId: string }[] = []
    for (const m of messages) {
      const parts = props.api.state.part(m.id)
      for (const p of parts) {
        if (p.type !== "text") continue
        for (const r of parseImageRefs(p.text, props.parseOptions)) {
          out.push({ src: r.src, alt: r.alt, messageId: m.id })
        }
      }
    }
    return out
  })

  return (
    <Show when={refs().length > 0}>
      <box>
        <text fg={theme().text}>
          <b>Images</b>
        </text>
        <For each={refs()}>
          {(r) => (
            <box flexDirection="row" gap={1}>
              <text fg={theme().textMuted} wrapMode="none">
                {basename(r.src)}
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

function basename(s: string): string {
  const last = s.replace(/[?#].*$/, "").split("/").filter(Boolean).pop() ?? s
  return last.length > 32 ? last.slice(0, 30) + "…" : last
}
