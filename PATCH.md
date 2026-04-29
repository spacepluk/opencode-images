# OpenCode upstream patch

This patch adds a `message_part_after` TUI slot to OpenCode, which the `opencode-images` plugin uses for inline image rendering. Without it, the plugin's inline placement is silently inert (sidebar still works).

The patch is intentionally minimal: a slot type declaration and two `<Slot/>` insertions. It introduces no behavior change without a plugin registered to the slot.

The full diff is checked into this repo as [`opencode.patch`](./opencode.patch). It adds a slot type to `packages/plugin/src/tui.ts` and four `<Slot/>` call sites in `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` (one each in `UserMessage`, `ReasoningPart`, `TextPart`, and `ToolPart`).

The `ToolPart` slot passes `tool_name` and `tool_output` props, enabling plugins to render images extracted from tool output JSON (e.g., keyframe paths from `lorebot skill generate-shots`).

## Applying locally

```bash
cd /path/to/opencode-checkout
git apply /path/to/opencode-images/opencode.patch
bun install
bun run --cwd packages/opencode --conditions=browser src/index.ts
```
