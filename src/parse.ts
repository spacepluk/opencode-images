/**
 * Extract image references from message text.
 *
 * Sources:
 *  1. Markdown image syntax:           ![alt](url-or-path)
 *  2. Custom <image> marker:           <image src="..." [width=N] [height=M] />
 *  3. Bare URLs / file paths ending in an image extension, when they sit
 *     in whitespace.
 *
 * Code blocks (fenced ``` and inline `code`) are excluded so we don't render
 * images inside example markdown.
 */

export type ImageRef = {
  // Position in the original text (post code-block removal). Useful only for
  // ordering; we don't compute actual cell coordinates here.
  index: number
  // Source URL or path. http(s)://, file://, absolute, or relative.
  src: string
  alt?: string
  // Optional explicit cell dimensions from custom marker.
  cellWidth?: number
  cellHeight?: number
}

export type ParseOptions = {
  customMarkers: string[] // tag names, e.g. ["image"]
  allowBareUrls: boolean
}

export const DEFAULT_PARSE_OPTIONS: ParseOptions = {
  customMarkers: ["image"],
  allowBareUrls: true,
}

// A bare ref must have at least one identifier-ish character before the
// image extension, so a stray ".png" mention in prose isn't matched.
const IMG_EXT_RE = /[A-Za-z0-9_\-/]\.(?:png|jpe?g|gif|webp|bmp)(?:\?[^\s)<>"']*)?$/i

const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

function buildCustomTagRe(tag: string): RegExp {
  // <tag src="..." width="N" height="N" /> or <tag src='...'>
  // permissive: any attr order, self-closing or with closing tag.
  const t = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(
    `<${t}(\\s+[^>]*?)?(?:\\s*\\/?>|>\\s*<\\/${t}\\s*>)`,
    "g",
  )
}

function parseAttrs(attrStr: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(attrStr))) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ""
  }
  return out
}

/**
 * Mask code blocks so their contents are skipped by other matchers, but
 * positions are preserved (fill with same-length space).
 */
function maskCode(text: string): string {
  let out = ""
  let i = 0
  // Fenced
  while (i < text.length) {
    const fenceStart = text.indexOf("```", i)
    if (fenceStart < 0) {
      out += text.slice(i)
      break
    }
    out += text.slice(i, fenceStart)
    const fenceEnd = text.indexOf("```", fenceStart + 3)
    const blockEnd = fenceEnd < 0 ? text.length : fenceEnd + 3
    out += " ".repeat(blockEnd - fenceStart)
    i = blockEnd
  }
  // Inline `...`
  out = out.replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length))
  return out
}

/**
 * Bare reference detection — any whitespace-bounded token ending in an image
 * extension is a candidate. The IMG_EXT_RE filter applied after matching
 * keeps this to actual image refs.
 *
 * Accepts:
 *   - http(s)://...                 (URLs)
 *   - file://...                    (file URIs)
 *   - /abs/path/img.png             (absolute paths)
 *   - ./rel/img.png  ../up/img.png  (dot-relative paths)
 *   - rel/img.png  img.png          (plain relative paths)
 *
 * The leading-character class `[\s(]` makes us ignore tokens that are
 * already part of a markdown image's `![alt](...)` paren group, since
 * those are extracted by the markdown matcher first and their indices are
 * marked consumed.
 */
const BARE_REF_RE =
  /(?:^|[\s(])([^\s()<>"']+)/g

/**
 * Extract image references from tool output.
 *
 * Tool output (especially from Bash) is often a mix of log lines and a JSON
 * result blob. Strategy:
 *   1. Try parsing the entire output as JSON.
 *   2. If that fails, scan for the last top-level JSON object or array in the
 *      text (the skill result is always the last thing printed).
 *   3. Walk the parsed JSON looking for string values ending in an image
 *      extension.
 *   4. Also scan the non-JSON portions (log lines) for bare image paths,
 *      since logs may print paths like "Saved /path/to/keyframe_a.png".
 */
export function parseToolOutputImageRefs(output: string): ImageRef[] {
  const refs: ImageRef[] = []
  const seen = new Set<string>()

  const addPath = (p: string) => {
    if (seen.has(p)) return
    seen.add(p)
    refs.push({ index: refs.length, src: p })
  }

  // Try to parse JSON and walk it for image paths.
  const parsed = tryParseJson(output)
  if (parsed !== undefined) {
    const paths: string[] = []
    collectImagePaths(parsed, paths)
    for (const p of paths) addPath(p)
  }

  // Also scan the raw text for bare image paths (catches log lines like
  // "Generated keyframe: /path/to/keyframe_a.png").
  for (const m of output.matchAll(BARE_REF_RE)) {
    const raw = m[1]
    if (!raw) continue
    const stripped = raw.replace(/[.,;:!?]+$/, "")
    if (!stripped) continue
    if (!IMG_EXT_RE.test(stripped)) continue
    addPath(stripped)
  }

  return refs
}

/**
 * Try to parse JSON from output that may contain non-JSON log lines.
 * Attempts full parse first, then scans for the last `{...}` or `[...]` block.
 */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // Fall through — try to extract embedded JSON.
  }

  // Find the last top-level '{' or '[' and try to parse from there.
  // Skill output is always the last thing printed (console.log(JSON.stringify(result))).
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === "}" || ch === "]") {
      const open = ch === "}" ? "{" : "["
      // Walk backwards to find the matching opener at the same nesting level.
      let depth = 0
      for (let j = i; j >= 0; j--) {
        if (text[j] === ch) depth++
        else if (text[j] === open) depth--
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(j, i + 1))
          } catch {
            break // This pair didn't parse; stop searching.
          }
        }
      }
      break // Only try the last top-level block.
    }
  }

  return undefined
}

function collectImagePaths(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (IMG_EXT_RE.test(value)) {
      out.push(value)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImagePaths(item, out)
    return
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectImagePaths(v, out)
  }
}

export function parseImageRefs(text: string, opts: ParseOptions = DEFAULT_PARSE_OPTIONS): ImageRef[] {
  const masked = maskCode(text)
  const refs: ImageRef[] = []
  const seen = new Set<number>() // indices already consumed

  // 1. Markdown images
  for (const m of masked.matchAll(MD_IMAGE_RE)) {
    if (m.index === undefined) continue
    refs.push({ index: m.index, src: m[2], alt: m[1] || undefined })
    for (let k = 0; k < m[0].length; k++) seen.add(m.index + k)
  }

  // 2. Custom markers
  for (const tag of opts.customMarkers) {
    const re = buildCustomTagRe(tag)
    for (const m of masked.matchAll(re)) {
      if (m.index === undefined) continue
      const attrs = parseAttrs(m[1] ?? "")
      const src = attrs.src ?? attrs.path ?? attrs.url
      if (!src) continue
      const cw = attrs.width ? parseInt(attrs.width, 10) : undefined
      const ch = attrs.height ? parseInt(attrs.height, 10) : undefined
      refs.push({
        index: m.index,
        src,
        alt: attrs.alt,
        cellWidth: Number.isFinite(cw as number) ? (cw as number) : undefined,
        cellHeight: Number.isFinite(ch as number) ? (ch as number) : undefined,
      })
      for (let k = 0; k < m[0].length; k++) seen.add(m.index + k)
    }
  }

  // 3. Bare image refs (only outside already-matched ranges).
  // Any whitespace-bounded token ending in an image extension counts:
  // URLs, file URIs, absolute paths, dot-relative paths, plain relative paths.
  if (opts.allowBareUrls) {
    for (const m of masked.matchAll(BARE_REF_RE)) {
      if (m.index === undefined) continue
      const raw = m[1]
      if (!raw) continue
      // Strip a single trailing punctuation char (commas/periods/etc.) so
      // "see cat.png." and "cat.png," both work.
      const stripped = raw.replace(/[.,;:!?]+$/, "")
      if (!stripped) continue
      const matchStart = m.index + m[0].indexOf(raw)
      if (seen.has(matchStart)) continue
      if (!IMG_EXT_RE.test(stripped)) continue
      refs.push({ index: matchStart, src: stripped })
    }
  }

  refs.sort((a, b) => a.index - b.index)
  // Dedupe by index/src
  const dedup: ImageRef[] = []
  const key = new Set<string>()
  for (const r of refs) {
    const k = r.index + ":" + r.src
    if (key.has(k)) continue
    key.add(k)
    dedup.push(r)
  }
  return dedup
}
