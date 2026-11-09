// Claude Code running in a pseudo-terminal, emulated by xterm.js and painted into its rect.
import { createRequire } from 'node:module'

import { fixSpawnHelper } from './fix-pty.js'
import { BOLD, DIM, INVERSE, ITALIC, UNDERLINE } from './screen.js'

const require = createRequire(import.meta.url)
const pty = require('node-pty')
const { Terminal } = require('@xterm/headless')

function color(mode, value, isFg) {
  if (mode === 'default') return ''
  if (mode === 'palette') {
    if (value < 8) return String((isFg ? 30 : 40) + value)
    if (value < 16) return String((isFg ? 90 : 100) + value - 8)
    return `${isFg ? 38 : 48};5;${value}`
  }
  return `${isFg ? 38 : 48};2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`
}

export class ClaudePanel {
  /**
   * @param {{ cwd: string, args: string[], env: Record<string, string>, cols: number, rows: number }} opts
   * @param {() => void} onRender
   * @param {(code: number) => void} onExit
   */
  constructor({ cwd, args, env, cols, rows }, onRender, onExit) {
    fixSpawnHelper()
    this.cols = Math.max(10, cols)
    this.rows = Math.max(3, rows)
    this.term = new Terminal({ cols: this.cols, rows: this.rows, allowProposedApi: true, scrollback: 2000 })
    this.proc = pty.spawn('claude', args, { name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd, env })
    this.proc.onData(data => this.term.write(data, onRender))
    this.term.onData(data => this.proc.write(data))
    this.proc.onExit(({ exitCode }) => onExit(exitCode ?? 0))
    this.cell = this.term.buffer.active.getNullCell()
  }

  write(data) {
    this.proc.write(data)
  }

  resize(cols, rows) {
    cols = Math.max(10, cols)
    rows = Math.max(3, rows)
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    this.term.resize(cols, rows)
    try {
      this.proc.resize(cols, rows)
    } catch {
      // Already exited.
    }
  }

  get wantsMouse() {
    return this.term.modes.mouseTrackingMode !== 'none'
  }

  get wantsPaste() {
    return this.term.modes.bracketedPasteMode
  }

  /** Forward a mouse event, its position made relative to the panel's body. */
  mouse(event, bodyX, bodyY) {
    if (!this.wantsMouse) return
    const x = event.x - bodyX + 1
    const y = event.y - bodyY + 1
    if (x < 1 || y < 1 || x > this.cols || y > this.rows) return
    const code = event.raw.slice(3).split(';')[0]
    this.proc.write(`\x1b[<${code};${x};${y}${event.isRelease ? 'm' : 'M'}`)
  }

  /** Paint the emulated screen at (x0, y0). Returns the cursor, if shown. */
  paint(screen, x0, y0, isFocused) {
    const buffer = this.term.buffer.active
    const cell = this.cell
    for (let y = 0; y < this.rows; y++) {
      const line = buffer.getLine(buffer.viewportY + y)
      let x = 0
      while (x < this.cols) {
        const c = line?.getCell(x, cell)
        if (!c) {
          screen.set(x0 + x, y0 + y, ' ')
          x += 1
          continue
        }
        const width = c.getWidth()
        if (width === 0) {
          x += 1
          continue
        }
        let flags = 0
        if (c.isBold()) flags |= BOLD
        if (c.isDim()) flags |= DIM
        if (c.isItalic()) flags |= ITALIC
        if (c.isUnderline()) flags |= UNDERLINE
        if (c.isInverse()) flags |= INVERSE
        const fgMode = c.isFgDefault() ? 'default' : c.isFgPalette() ? 'palette' : 'rgb'
        const bgMode = c.isBgDefault() ? 'default' : c.isBgPalette() ? 'palette' : 'rgb'
        const fg = color(fgMode, c.getFgColor(), true)
        const bg = color(bgMode, c.getBgColor(), false)
        const chars = c.getChars() || ' '
        screen.set(x0 + x, y0 + y, chars, fg, bg, flags)
        if (width === 2 && x + 1 < this.cols) screen.set(x0 + x + 1, y0 + y, '', fg, bg, flags)
        x += width
      }
    }
    // @ts-ignore: xterm keeps cursor visibility on its core service.
    const hidden = this.term._core?.coreService?.isCursorHidden ?? false
    if (!isFocused || hidden || buffer.viewportY !== buffer.baseY) return null
    return { x: x0 + buffer.cursorX, y: y0 + buffer.cursorY }
  }

  kill() {
    try {
      this.proc.kill()
    } catch {
      // gone already
    }
  }
}
