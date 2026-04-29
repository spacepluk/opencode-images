# opencode-images

Inline terminal image rendering for [OpenCode](https://opencode.ai).

Detects markdown image syntax (`![alt](path-or-url)`), `<image>` markers, and bare image URLs / file paths in messages, and renders them inline using the best available terminal protocol — without sending image bytes through the LLM context.

## Supported terminal protocols

| Protocol | Terminals |
|----------|-----------|
| Kitty graphics | kitty, Ghostty, WezTerm |
| iTerm2 inline | iTerm2, WezTerm, mintty |
| Fallback (no images) | Everything else — plugin disables itself silently |

Kitty graphics is preferred when available because it uses unicode-placeholder placement, which anchors images to TUI cells (no flicker on scroll/resize, no per-frame retransmit).

`tmux` users need `set -g allow-passthrough on` in `tmux.conf`. Verify with `tmux show -g allow-passthrough` — it should print `on`. Each transmitted chunk is wrapped in its own `\x1bPtmux;...\x1b\\` so multi-megabyte images are not lost to tmux's per-DCS size limit.

## Requirements

This plugin renders images **inline** in the chat (under the markdown that referenced them). To do this, OpenCode's TUI must expose a `message_part_after` slot. As of OpenCode 1.x, this slot is added by a small upstream patch; without it, the plugin's slot handler simply never fires (the plugin is harmless).

If the slot isn't present, the sidebar panel listing images still works — it uses an existing `sidebar_content` slot.

The required upstream patch is ~20 lines across `packages/plugin/src/tui.ts` and `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`. See [`PATCH.md`](./PATCH.md) for the diff if you want to apply it locally.

## Install

This is a TUI plugin, so it goes in `tui.json` (not `opencode.json`). Place it in your project root or in `~/.config/opencode/tui.json`:

```jsonc
{
  "plugin": ["opencode-images@latest"]
}
```

Or with options:

```jsonc
{
  "plugin": [
    ["opencode-images@latest", {
      "maxCellWidth": 60,
      "maxCellHeight": 30,
      "allowNetwork": true,
      "networkSizeLimit": 10485760,
      "networkTimeoutMs": 5000,
      "customMarkers": ["image"],
      "allowBareUrls": true,
      "showSidebar": true
    }]
  ]
}
```

For local development, point at the source directory:

```jsonc
{
  "plugin": ["file:///absolute/path/to/opencode-images"]
}
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `maxCellWidth` | `60` | Max image width in terminal cells. Larger images are scaled down. |
| `maxCellHeight` | `30` | Max image height in terminal cells. |
| `cellPixelSize` | auto-detected | `{w, h}` pixel size of one terminal cell. Override only if auto-detection is wrong. |
| `allowNetwork` | `true` | Fetch http(s):// images. Disable for offline / privacy-sensitive setups. |
| `networkSizeLimit` | `10485760` (10 MB) | Max bytes per remote image. |
| `networkTimeoutMs` | `5000` | Network fetch timeout. |
| `customMarkers` | `["image"]` | XML-ish tag names recognized as image refs. Add your own (e.g. `["image", "screenshot"]`) or disable with `[]`. |
| `allowBareUrls` | `true` | Detect bare image URLs / file paths in message text (anything ending in a supported image extension). |
| `showSidebar` | `true` | Show an "Images" list in the session sidebar. |

## Environment variables

- `OPENCODE_IMAGES_PROTOCOL=kitty|iterm2|fallback` — force a specific protocol, bypassing auto-detection. Useful when running inside tmux where the runtime kitty-graphics probe gets swallowed.

## Image reference syntax

Three ways to reference an image:

```markdown
1. Markdown:        ![alt](path-or-url)
2. Custom tag:      <image src="path-or-url" width="40" height="20"/>
3. Bare reference:  any whitespace-bounded token ending in
                    .png .jpg .jpeg .gif .webp .bmp
```

Bare references accept:
- http(s) URLs:           `https://example.com/img.png`
- file URIs:              `file:///abs/path/img.png`
- absolute paths:         `/abs/path/img.png`
- dot-relative paths:     `./img.png`, `../up/img.png`
- plain relative paths:   `images/cat.png`, `img.png`

Relative paths are resolved against the current project's worktree (or working directory if no worktree).

`width`/`height` on the custom tag are in **terminal cells**, not pixels.

Images inside fenced code blocks (`` ``` `` or `` ` ``) are intentionally ignored, so example markdown isn't accidentally rendered. A trailing `.` `,` `;` `:` `!` `?` is stripped, so prose like "see cat.png." works.

## How it works

The plugin registers two TUI slots:

- `message_part_after` — fires per assistant text part. Parses the part for image references and renders each as a small `<box>`. For kitty, the box's cells contain unicode placeholders (`U+10EEEE`) with row/col diacritics and the image-id encoded in fg color, so kitty renders the actual image into those cells. For iTerm2, the box reserves cell space and the plugin emits `OSC 1337` after layout. For unsupported terminals, no slot is registered.
- `sidebar_content` — renders an "Images" list in the session sidebar.

Image data is **never put into message text**. It's transmitted directly to the terminal using `RenderLib.writeOut` (a public FFI from `@opentui/core`), bypassing OpenTUI's framebuffer. The LLM sees only the original markdown / URL / tag string.

Remote images are cached on disk under `~/.cache/opencode-images/` (keyed by URL hash) to avoid re-fetching.

## Limitations

- iTerm2 inline images do not survive scroll/resize cleanly. Use a kitty-protocol terminal for the best experience.
- SVG isn't rasterized. PNG, JPEG, GIF, WebP are supported.
- Animated GIFs render as their first frame.
- Sixel and ASCII-art fallback are not implemented in v0.

## Troubleshooting

If images don't render, run the standalone protocol test:

```bash
bun run src/test/standalone.ts /path/to/image.png --verbose
```

It performs three checks: capability detection, direct kitty placement (Test A), and unicode-placeholder placement (Test B). Test B is the path the plugin uses inside OpenCode. If neither test shows an image:

- Make sure you're in a kitty-protocol terminal (kitty, Ghostty, WezTerm).
- If you're inside tmux, verify `tmux show -g allow-passthrough` says `on`.
- Look for `response: "..."` lines in `--verbose` mode — kitty echoes back `OK` on success or an error string on failure.

If standalone works but inline rendering inside OpenCode doesn't, your OpenCode build may not have the `message_part_after` slot patch (see [`PATCH.md`](./PATCH.md)).

## License

MIT
