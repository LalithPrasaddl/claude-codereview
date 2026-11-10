// The middle panel: one file, read-only, as full text or as its diff.
import fs from 'node:fs'
import path from 'node:path'

import { changedLines, hunksOnly } from './diff.js'
import { highlightLines, languageFor } from './highlight.js'
import { BOLD, DIM, ITALIC, UNDERLINE } from './screen.js'
import { fit, textWidth } from './width.js'

const MAX_BYTES = 2 * 1024 * 1024

/** @typedef {import('./highlight.js').Segment} Segment */

export class CodePanel {
  /**
   * @param {string} cwd
   * @param {import('./session.js').Session} session
   */
  constructor(cwd, session) {
    this.cwd = cwd
    this.session = session
    /** @type {string | null} */
    this.file = null
    this.showDiff = false
    this.scroll = 0
    this.hscroll = 0
    this.height = 10
    this.follow = true
    /** @type {import('./tint.js').Tint | null} backgrounds for changed lines, or none */
    this.tint = null
    /** @type {{ lines: Segment[][], note: string } | null} */
    this.text = null
    /** @type {{ lines: string[], base: string, added: Set<number>, removedAfter: Set<number> } | null} */
    this.diff = null
  }

  title() {
    if (this.file === null) return 'CODE'
    return `CODE · ${path.relative(this.cwd, this.file) || this.file}`
  }

  /** Re-read the file and its diff. */
  reload() {
    if (this.file === null) return
    const file = this.file
    const { text, base } = this.session.diff(file)
    const { added, removedAfter } = changedLines(text)
    const hunks = hunksOnly(text)
    this.diff = { lines: hunks === '' ? [] : hunks.split('\n'), base, added, removedAfter }
    try {
      const stat = fs.statSync(file)
      if (stat.size > MAX_BYTES) {
        this.text = { lines: [], note: `File is ${Math.round(stat.size / 1024)} KB: too large to show.` }
        return
      }
      const raw = fs.readFileSync(file, 'utf8')
      if (raw.includes('\u0000')) {
        this.text = { lines: [], note: 'Binary file.' }
        return
      }
      const clean = raw.replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
      this.text = { lines: highlightLines(clean.replace(/\n$/, ''), languageFor(file)), note: '' }
    } catch {
      this.text = { lines: [], note: 'This file no longer exists.' }
    }
  }

  /** @param {string} file @param {{ focusLine?: number, showDiff?: boolean }} [opts] */
  open(file, opts = {}) {
    const isSame = file === this.file
    this.file = file
    if (opts.showDiff !== undefined) this.showDiff = opts.showDiff
    this.reload()
    if (opts.focusLine !== undefined) this.focusOn(opts.focusLine)
    else if (!isSame) {
      this.scroll = 0
      this.hscroll = 0
    }
  }

  focusOn(line) {
    if (this.showDiff) {
      this.scroll = 0
      return
    }
    this.scroll = Math.max(0, line - 1 - Math.min(5, Math.floor(this.height / 4)))
  }

  lineCount() {
    if (this.showDiff) return this.diff?.lines.length ?? 0
    return this.text?.lines.length ?? 0
  }

  clampScroll() {
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.lineCount() - this.height + 1)))
  }

  /** @returns {string | null} an action for the app: 'next' | 'prev' | 'reviewed' | 'ask' */
  key(name) {
    switch (name) {
      case 'up':
      case 'k':
        this.scroll -= 1
        break
      case 'down':
      case 'j':
        this.scroll += 1
        break
      case 'pageup':
      case 'b':
        this.scroll -= this.height - 2
        break
      case 'pagedown':
      case 'space':
        this.scroll += this.height - 2
        break
      case 'home':
      case 'g':
        this.scroll = 0
        break
      case 'end':
      case 'G':
        this.scroll = this.lineCount()
        break
      case 'left':
      case 'h':
        this.hscroll = Math.max(0, this.hscroll - 8)
        break
      case 'right':
      case 'l':
        this.hscroll += 8
        break
      case 'd':
        this.showDiff = !this.showDiff
        this.scroll = 0
        if (!this.showDiff && this.file) {
          const change = this.session.changes.find(c => c.file === this.file)
          if (change) this.focusOn(change.focusLine)
        }
        break
      case 'f':
        this.follow = !this.follow
        break
      case 'n':
        return 'next'
      case 'p':
        return 'prev'
      case 'r':
        return 'reviewed'
      case 'a':
        return 'ask'
      default:
        return null
    }
    this.clampScroll()
    return null
  }

  wheel(delta) {
    this.scroll += delta
    this.clampScroll()
  }

  /**
   * One line listing the files Claude changed this turn, in edit order:
   * ✓ reviewed, ○ not yet, the open one underlined.
   * @param {import('./screen.js').Screen} screen
   */
  paintTurn(screen, x, y, maxX) {
    const turn = this.session.turn
    const names = turn.map(file => path.basename(file))
    const label = names.map((name, i) =>
      names.indexOf(name) !== names.lastIndexOf(name) ? path.relative(this.cwd, turn[i]) : name)
    let cx = screen.text(x, y, 'this turn ', { flags: DIM }, maxX)
    for (let i = 0; i < turn.length; i++) {
      const change = this.session.changes.find(c => c.file === turn[i])
      const left = turn.length - i - 1
      const room = maxX - cx - (left > 0 ? textWidth(` +${left}`) : 0)
      if (textWidth(` ○ ${label[i]}`) > room) {
        screen.text(cx, y, ` +${turn.length - i}`, { flags: DIM }, maxX)
        return
      }
      const isReviewed = change?.reviewed ?? true
      cx = screen.text(cx, y, isReviewed ? ' ✓ ' : ' ○ ', { fg: isReviewed ? '32' : '33' }, maxX)
      const isOpen = turn[i] === this.file
      cx = screen.text(cx, y, label[i], isOpen ? { flags: BOLD | UNDERLINE } : isReviewed ? { flags: DIM } : {}, maxX)
    }
  }

  /** @param {import('./screen.js').Screen} screen */
  paint(screen, x, y, w, h) {
    const maxX = x + w
    if (this.file === null) {
      const lines = [
        'No file open.',
        '',
        'Pick a file in the tree, or ask Claude to change',
        'something: the file opens here as Claude edits it.',
      ]
      lines.forEach((line, i) => screen.text(x + 1, y + i, fit(line, w - 2), { flags: DIM }, maxX))
      return
    }
    const change = this.session.changes.find(c => c.file === this.file)

    // Header: stats, review state, the "why" line and the keys.
    let cx = x + 1
    if (change) {
      cx = screen.text(cx, y, `+${change.added}`, { fg: '32', flags: BOLD }, maxX)
      cx = screen.text(cx + 1, y, `−${change.removed}`, { fg: '31', flags: BOLD }, maxX)
      cx = screen.text(cx + 2, y, change.reviewed ? '✓ reviewed' : '○ not reviewed', { fg: change.reviewed ? '32' : '33' }, maxX)
      cx += 2
    }
    const view = this.showDiff ? `diff vs ${this.diff?.base ?? 'git'}` : 'full file'
    screen.text(cx, y, fit(`${view} · follow ${this.follow ? 'on' : 'off'}`, maxX - cx), { flags: DIM }, maxX)
    let top = y + 1
    if (change?.why) {
      screen.text(x + 1, top, fit(change.why, w - 2), { flags: DIM | ITALIC }, maxX)
      top += 1
    }
    if (this.session.turn.length > 1) {
      this.paintTurn(screen, x + 1, top, maxX)
      top += 1
    }
    const keys = 'd diff · n/p next/prev · r reviewed · a ask · f follow'
    screen.text(x + 1, top, fit(keys, w - 2), { flags: DIM }, maxX)
    top += 1
    screen.fill(x, top, w, 1, '─', { flags: DIM })
    top += 1

    const bodyH = y + h - top
    this.height = bodyH
    this.clampScroll()

    if (this.showDiff) {
      const lines = this.diff?.lines ?? []
      if (lines.length === 0) {
        const msg = this.diff?.base === 'none' ? 'No baseline: not a git repo, and Claude has not edited this file.' : 'No changes.'
        screen.text(x + 1, top, fit(msg, w - 2), { flags: DIM }, maxX)
        return
      }
      // Number the lines on the new side as we go.
      let newLine = 0
      const numbers = []
      for (const line of lines) {
        const header = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line)
        if (header) {
          newLine = Number(header[1])
          numbers.push('')
        } else if (line.startsWith('-')) numbers.push('')
        else {
          numbers.push(String(newLine))
          newLine += 1
        }
      }
      const gutter = Math.max(3, String(newLine).length) + 1
      for (let i = 0; i < bodyH; i++) {
        const line = lines[this.scroll + i]
        if (line === undefined) break
        const num = numbers[this.scroll + i] ?? ''
        screen.text(x, top + i, num.padStart(gutter - 1) + ' ', { flags: DIM }, maxX)
        const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : ''
        // With a tint the background carries the change and the text keeps its normal color.
        const bg = this.tint && (kind === 'added' || kind === 'removed') ? this.tint[kind] : ''
        if (bg) screen.fill(x + gutter, top + i, w - gutter, 1, ' ', { bg })
        const style = kind === 'hunk'
          ? { fg: '36', flags: DIM }
          : bg
            ? { bg }
            : kind === 'added'
              ? { fg: '32' }
              : kind === 'removed'
                ? { fg: '31' }
                : {}
        screen.text(x + gutter, top + i, line.replace(/\t/g, '    ').slice(this.hscroll), style, maxX)
      }
      return
    }

    const text = this.text
    if (!text || text.note) {
      screen.text(x + 1, top, fit(text?.note ?? '', w - 2), { flags: DIM }, maxX)
      return
    }
    const gutter = String(text.lines.length).length + 1
    const added = this.diff?.added ?? new Set()
    const removedAfter = this.diff?.removedAfter ?? new Set()
    for (let i = 0; i < bodyH; i++) {
      const n = this.scroll + i + 1
      const segments = text.lines[n - 1]
      if (segments === undefined) break
      screen.text(x, top + i, String(n).padStart(gutter - 1) + ' ', { flags: DIM }, maxX)
      const mark = added.has(n) ? ['▌', '32'] : removedAfter.has(n) && !added.has(n + 1) ? ['▁', '31'] : [' ', '']
      const bg = this.tint && added.has(n) ? this.tint.added : ''
      if (bg) screen.fill(x + gutter, top + i, w - gutter, 1, ' ', { bg })
      screen.text(x + gutter, top + i, mark[0], { fg: mark[1], bg }, maxX)
      let col = x + gutter + 1
      let skip = this.hscroll
      for (const seg of segments) {
        let part = seg.text
        if (skip > 0) {
          const cut = Math.min(skip, part.length)
          part = part.slice(cut)
          skip -= cut
        }
        if (part === '') continue
        col = screen.text(col, top + i, part, { fg: seg.fg, bg, flags: seg.flags }, maxX)
        if (col >= maxX) break
      }
    }
  }
}
