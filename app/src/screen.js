// A grid of cells drawn to the terminal, rewriting only the rows that changed.
import { charWidth } from './width.js'

export const BOLD = 1
export const DIM = 2
export const ITALIC = 4
export const UNDERLINE = 8
export const INVERSE = 16

/**
 * A style: `fg` / `bg` are SGR color parameters ('' for the terminal default,
 * e.g. '33', '38;5;209', '38;2;1;2;3'), `flags` the bits above.
 * @typedef {{ fg?: string, bg?: string, flags?: number }} Style
 */

const PLAIN = { fg: '', bg: '', flags: 0 }

function sgr(fg, bg, flags) {
  let s = '\x1b[0'
  if (flags & BOLD) s += ';1'
  if (flags & DIM) s += ';2'
  if (flags & ITALIC) s += ';3'
  if (flags & UNDERLINE) s += ';4'
  if (flags & INVERSE) s += ';7'
  if (fg) s += ';' + fg
  if (bg) s += ';' + bg
  return s + 'm'
}

export class Screen {
  constructor(cols, rows) {
    this.resize(cols, rows)
    /** @type {{ x: number, y: number } | null} */
    this.cursor = null
  }

  resize(cols, rows) {
    this.cols = cols
    this.rows = rows
    this.ch = new Array(cols * rows).fill(' ')
    this.fg = new Array(cols * rows).fill('')
    this.bg = new Array(cols * rows).fill('')
    this.fl = new Uint8Array(cols * rows)
    this.prev = new Array(rows).fill(null)
  }

  clear() {
    this.ch.fill(' ')
    this.fg.fill('')
    this.bg.fill('')
    this.fl.fill(0)
    this.cursor = null
  }

  /** Set one cell. `ch` '' marks the right half of a wide character. */
  set(x, y, ch, fg = '', bg = '', flags = 0) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return
    const i = y * this.cols + x
    this.ch[i] = ch
    this.fg[i] = fg
    this.bg[i] = bg
    this.fl[i] = flags
  }

  /**
   * Write text from (x, y), clipped at `maxX` (exclusive). Returns the x after it.
   * @param {Style} [style]
   */
  text(x, y, text, style = PLAIN, maxX = this.cols) {
    const fg = style.fg ?? ''
    const bg = style.bg ?? ''
    const flags = style.flags ?? 0
    for (const raw of text) {
      const ch = raw === '\t' ? ' ' : raw
      const w = charWidth(ch)
      if (w === 0) continue
      if (x + w > maxX) break
      this.set(x, y, ch, fg, bg, flags)
      if (w === 2) this.set(x + 1, y, '', fg, bg, flags)
      x += w
    }
    return x
  }

  /** @param {Style} [style] */
  fill(x, y, w, h, ch = ' ', style = PLAIN) {
    for (let j = y; j < y + h; j++) {
      for (let i = x; i < x + w; i++) this.set(i, j, ch, style.fg ?? '', style.bg ?? '', style.flags ?? 0)
    }
  }

  /** The escape sequence that brings the terminal up to date. */
  flush(force = false) {
    let out = '\x1b[?25l'
    for (let y = 0; y < this.rows; y++) {
      let row = ''
      let last = ''
      for (let x = 0; x < this.cols; x++) {
        const i = y * this.cols + x
        const ch = this.ch[i]
        if (ch === '') continue
        const style = sgr(this.fg[i], this.bg[i], this.fl[i])
        if (style !== last) {
          row += style
          last = style
        }
        row += ch
      }
      if (force || this.prev[y] !== row) {
        out += `\x1b[${y + 1};1H${row}\x1b[0m`
        this.prev[y] = row
      }
    }
    if (this.cursor) out += `\x1b[${this.cursor.y + 1};${this.cursor.x + 1}H\x1b[?25h`
    return out
  }
}
