/**
 * Wrap an escape sequence in tmux's DCS passthrough so it reaches the outer
 * terminal. Inside the wrapper, every ESC byte must be doubled.
 *
 * Requires `set -g allow-passthrough on` in tmux.conf.
 */
export function tmuxWrap(escape: string): string {
  return "\x1bPtmux;" + escape.replace(/\x1b/g, "\x1b\x1b") + "\x1b\\"
}

export function maybeTmuxWrap(escape: string, inTmux: boolean): string {
  return inTmux ? tmuxWrap(escape) : escape
}
