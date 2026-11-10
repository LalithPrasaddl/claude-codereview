// The left panel: the folder tree, colored by Claude's changes, with the changed
// files pinned at the bottom; or (key c) the full list of changes.
import fs from 'node:fs'
import path from 'node:path'

import { BOLD, DIM, INVERSE } from './screen.js'
import { fit, fitLeft } from './width.js'

export const IGNORED = new Set([
  '.git', 'node_modules', '.DS_Store', '.next', '.nuxt', '.turbo', '.cache', '.venv', 'venv',
  '__pycache__', 'Pods', 'DerivedData', 'coverage', 'dist', 'build', '.gradle', '.idea',
])

const MAX_ROWS = 3000

/** Color and letter per change status, like an editor's git decorations. */
const STATUS = {
  modified: { fg: '33', letter: 'M' },
  new: { fg: '32', letter: 'A' },
  deleted: { fg: '31', letter: 'D' },
}

/** @typedef {{ path: string, name: string, depth: number, isDir: boolean }} Row */
/** @typedef {import('./session.js').Change} Change */

/** Style for a changed file's name: its status color, dimmed once reviewed. */
function changeStyle(change) {
  return change.reviewed ? { fg: '', flags: DIM } : { fg: STATUS[change.status ?? 'modified'].fg, flags: 0 }
}

function stats(change) {
  if (change.status === 'new') return `+${change.added} new`
  if (change.status === 'deleted') return 'deleted'
  return `+${change.added} −${change.removed}`
}

export class TreePanel {
  /**
   * @param {string} cwd
   * @param {import('./session.js').Session} session
   */
  constructor(cwd, session) {
    this.cwd = cwd
    this.session = session
    /** @type {'files' | 'changes'} */
    this.mode = 'files'
    this.expanded = new Set()
    /** @type {Row[]} */
    this.rows = []
    this.cursor = 0
    this.scroll = 0
    this.height = 10
    /** Body row where the pinned list starts, and the files it shows, top to bottom. */
    this.pinnedTop = Infinity
    /** @type {string[]} */
    this.pinnedFiles = []
    /** Whether the pinned list ends in a "… N more" row. */
    this.pinnedMore = false
    /** Selected pinned row, or -1 while the cursor is in the tree. */
    this.pinnedCursor = -1
    this.rebuild()
  }

  title() {
    return this.mode === 'files' ? 'FILES  · c changes' : `CHANGES (${this.session.changes.length})  · c files`
  }

  rebuild() {
    /** @type {Row[]} */
    const rows = []
    const walk = (dir, depth) => {
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      entries = entries
        .filter(e => !IGNORED.has(e.name))
        .sort((a, b) => {
          const ad = a.isDirectory()
          const bd = b.isDirectory()
          return ad === bd ? a.name.localeCompare(b.name) : ad ? -1 : 1
        })
      for (const e of entries) {
        if (rows.length >= MAX_ROWS) return
        const full = path.join(dir, e.name)
        const isDir = e.isDirectory()
        rows.push({ path: full, name: e.name, depth, isDir })
        if (isDir && this.expanded.has(full)) walk(full, depth + 1)
      }
    }
    walk(this.cwd, 0)
    const selected = this.rows[this.cursor]?.path
    this.rows = rows
    if (selected !== undefined) {
      const at = rows.findIndex(r => r.path === selected)
      if (at >= 0) this.cursor = at
    }
    this.cursor = Math.min(this.cursor, Math.max(0, this.count() - 1))
  }

  count() {
    return this.mode === 'files' ? this.rows.length : this.session.changes.length
  }

  /** Expand the folders above `file` and put the cursor on it. */
  reveal(file) {
    if (!file.startsWith(this.cwd + path.sep)) return
    let dir = path.dirname(file)
    while (dir.length > this.cwd.length) {
      this.expanded.add(dir)
      dir = path.dirname(dir)
    }
    this.rebuild()
    this.pinnedCursor = -1
    if (this.mode === 'files') {
      const at = this.rows.findIndex(r => r.path === file)
      if (at >= 0) this.cursor = at
    } else {
      const at = this.session.changes.findIndex(c => c.file === file)
      if (at >= 0) this.cursor = at
    }
    this.keepCursorVisible()
  }

  keepCursorVisible() {
    if (this.cursor < this.scroll) this.scroll = this.cursor
    if (this.cursor >= this.scroll + this.height) this.scroll = this.cursor - this.height + 1
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.count() - this.height)))
  }

  /**
   * Act on the row under the cursor.
   * @returns {{ open: string } | null}
   */
  activate() {
    if (this.mode === 'changes') {
      const change = this.session.changes[this.cursor]
      return change ? { open: change.file } : null
    }
    const row = this.rows[this.cursor]
    if (!row) return null
    if (row.isDir) {
      if (this.expanded.has(row.path)) this.expanded.delete(row.path)
      else this.expanded.add(row.path)
      this.rebuild()
      return null
    }
    return { open: row.path }
  }

  /** Rows the cursor can stop on in the pinned list (files, plus the "more" row). */
  pinnedCount() {
    return this.mode === 'files' ? this.pinnedFiles.length + (this.pinnedMore ? 1 : 0) : 0
  }

  /** Open the selected pinned file, or show every change from the "more" row. */
  activatePinned() {
    const file = this.pinnedFiles[this.pinnedCursor]
    if (file) return { open: file }
    this.toggleMode()
    return null
  }

  toggleMode() {
    this.mode = this.mode === 'files' ? 'changes' : 'files'
    this.cursor = 0
    this.scroll = 0
    this.pinnedCursor = -1
  }

  /** Keys while the cursor is in the pinned list. */
  pinnedKey(name) {
    const last = this.pinnedCount() - 1
    switch (name) {
      case 'up':
      case 'k':
        if (this.pinnedCursor > 0) this.pinnedCursor--
        else this.leavePinned(this.rows.length - 1)
        return null
      case 'down':
      case 'j':
      case 'pagedown':
      case 'end':
      case 'G':
        this.pinnedCursor = name === 'down' || name === 'j' ? Math.min(last, this.pinnedCursor + 1) : last
        return null
      case 'pageup':
        this.leavePinned(this.rows.length - 1)
        return null
      case 'home':
      case 'g':
        this.leavePinned(0)
        return null
      case 'enter':
      case 'space':
      case 'right':
      case 'l':
        return this.activatePinned()
      case 'c':
        this.toggleMode()
        return null
      default:
        return null
    }
  }

  leavePinned(row) {
    this.pinnedCursor = -1
    this.cursor = Math.max(0, row)
    this.keepCursorVisible()
  }

  /** @returns {{ open: string } | null} */
  key(name) {
    if (this.pinnedCursor >= 0) return this.pinnedKey(name)
    const n = this.count()
    // Moving down past the last tree row goes into the pinned list.
    if ((name === 'down' || name === 'j' || name === 'pagedown') && this.cursor >= n - 1 && this.pinnedCount() > 0) {
      this.pinnedCursor = 0
      return null
    }
    switch (name) {
      case 'up':
      case 'k':
        this.cursor = Math.max(0, this.cursor - 1)
        break
      case 'down':
      case 'j':
        this.cursor = Math.min(n - 1, this.cursor + 1)
        break
      case 'pageup':
        this.cursor = Math.max(0, this.cursor - this.height)
        break
      case 'pagedown':
        this.cursor = Math.min(n - 1, this.cursor + this.height)
        break
      case 'home':
      case 'g':
        this.cursor = 0
        break
      case 'end':
      case 'G':
        this.cursor = Math.max(0, n - 1)
        break
      case 'c':
        this.toggleMode()
        break
      case 'left':
      case 'h': {
        const row = this.rows[this.cursor]
        if (this.mode !== 'files' || !row) break
        if (row.isDir && this.expanded.has(row.path)) {
          this.expanded.delete(row.path)
          this.rebuild()
        } else {
          const parent = this.rows.findIndex(r => r.path === path.dirname(row.path))
          if (parent >= 0) this.cursor = parent
        }
        break
      }
      case 'right':
      case 'l': {
        const row = this.rows[this.cursor]
        if (this.mode === 'files' && row?.isDir && !this.expanded.has(row.path)) {
          this.expanded.add(row.path)
          this.rebuild()
          break
        }
        if (this.mode === 'files' && row && !row.isDir) return this.activate()
        break
      }
      case 'enter':
      case 'space':
        this.keepCursorVisible()
        return this.activate()
      default:
        return null
    }
    this.keepCursorVisible()
    return null
  }

  wheel(delta) {
    this.scroll = Math.max(0, Math.min(this.scroll + delta, Math.max(0, this.count() - this.height)))
  }

  /** @returns {{ open: string } | null} */
  click(bodyRow) {
    if (this.mode === 'files' && bodyRow >= this.pinnedTop) {
      const index = bodyRow - this.pinnedTop - 1
      if (index < 0 || index >= this.pinnedCount()) return null
      this.pinnedCursor = index
      return this.activatePinned()
    }
    const at = this.scroll + bodyRow
    if (at < 0 || at >= this.count()) return null
    this.pinnedCursor = -1
    this.cursor = at
    return this.activate()
  }

  /** One changed file as a row: mark, path (cut from the left), stats. */
  changeRow(screen, x, y, w, change, isCursor, openFile) {
    const flags = isCursor ? INVERSE : 0
    if (isCursor) screen.fill(x, y, w, 1, ' ', { flags: INVERSE })
    const mark = change.reviewed ? ' ✓ ' : ' ○ '
    let cx = screen.text(x, y, mark, { fg: change.reviewed ? '32' : '33', flags }, x + w)
    // File name first, its folder dimmed after it, the counts on the right.
    const tail = ' ' + stats(change) + ' '
    const statsX = Math.max(cx + 4, x + w - tail.length)
    const base = path.basename(change.file)
    const folder = path.relative(this.cwd, path.dirname(change.file))
    const style = changeStyle(change)
    cx = screen.text(cx, y, fit(base, Math.max(1, statsX - cx)), { fg: style.fg, flags: flags | style.flags | (change.file === openFile ? BOLD : 0) }, statsX)
    if (folder !== '' && statsX - cx >= 5) screen.text(cx + 1, y, fitLeft(folder + '/', statsX - cx - 1), { flags: flags | DIM }, statsX)
    screen.text(statsX, y, tail, { flags: flags | DIM }, x + w)
  }

  /** @param {import('./screen.js').Screen} screen */
  paint(screen, x, y, w, h, isFocused, openFile) {
    const list = this.session.changes

    if (this.mode === 'changes') {
      this.height = h
      this.pinnedTop = Infinity
      this.keepCursorVisible()
      if (list.length === 0) {
        screen.text(x + 1, y, fit('No changes yet.', w - 1), { flags: DIM }, x + w)
        screen.text(x + 1, y + 1, fit('Files Claude edits show here.', w - 1), { flags: DIM }, x + w)
        return
      }
      for (let i = 0; i < h; i++) {
        const change = list[this.scroll + i]
        if (!change) break
        this.changeRow(screen, x, y + i, w, change, this.scroll + i === this.cursor && isFocused, openFile)
      }
      return
    }

    // The pinned list of changed files takes up to a third of the panel.
    const pinnedRows = list.length === 0 ? 0 : Math.min(list.length, Math.max(2, Math.floor(h / 3) - 1))
    const pinnedH = pinnedRows === 0 ? 0 : pinnedRows + 1
    const treeH = Math.max(1, h - pinnedH)
    this.height = treeH
    this.keepCursorVisible()

    const byFile = new Map(list.map(c => [c.file, c]))
    /** Folders holding a change: yellow while any of them is unreviewed, dim once all are. */
    const dirState = new Map()
    for (const change of list) {
      let dir = path.dirname(change.file)
      while (dir.length > this.cwd.length) {
        const open = dirState.get(dir) === 'open' || !change.reviewed
        dirState.set(dir, open ? 'open' : 'reviewed')
        dir = path.dirname(dir)
      }
    }

    for (let i = 0; i < treeH; i++) {
      const row = this.rows[this.scroll + i]
      if (!row) break
      const isCursor = this.scroll + i === this.cursor && isFocused && this.pinnedCursor < 0
      const flags = isCursor ? INVERSE : 0
      if (isCursor) screen.fill(x, y + i, w, 1, ' ', { flags: INVERSE })
      const icon = row.isDir ? (this.expanded.has(row.path) ? '▾ ' : '▸ ') : '  '
      const change = byFile.get(row.path)
      const dir = dirState.get(row.path)
      let style = { fg: row.isDir ? '34' : '', flags: 0 }
      let mark = ''
      if (change) {
        style = changeStyle(change)
        mark = change.reviewed ? '✓' : STATUS[change.status ?? 'modified'].letter
      } else if (dir === 'open') style = { fg: '33', flags: 0 }
      else if (dir === 'reviewed') style = { fg: '34', flags: DIM }
      const label = ' ' + '  '.repeat(row.depth) + icon + row.name + (row.isDir ? '/' : '')
      screen.text(x, y + i, fit(label, w - (mark ? 3 : 0)), { fg: style.fg, flags: flags | style.flags | (row.path === openFile ? BOLD : 0) }, x + w)
      if (mark) screen.text(x + w - 2, y + i, mark, { fg: change?.reviewed ? '32' : style.fg, flags }, x + w)
    }

    this.pinnedTop = Infinity
    this.pinnedFiles = []
    this.pinnedMore = false
    if (pinnedH === 0) {
      this.pinnedCursor = -1
      return
    }
    const top = y + h - pinnedH
    this.pinnedTop = h - pinnedH
    const done = list.filter(c => c.reviewed).length
    const header = `─ CHANGED ${done}/${list.length} `
    screen.text(x, top, header + '─'.repeat(Math.max(0, w - header.length)), { flags: DIM }, x + w)
    // Unreviewed first, newest first within each group.
    const ordered = [...list].reverse().sort((a, b) => Number(a.reviewed) - Number(b.reviewed))
    const hidden = ordered.length - pinnedRows
    const shown = hidden > 0 ? ordered.slice(0, pinnedRows - 1) : ordered
    this.pinnedFiles = shown.map(change => change.file)
    this.pinnedMore = hidden > 0
    // The list can shrink (or reorder) under the cursor: keep it on a real row.
    if (this.pinnedCursor >= this.pinnedCount()) this.pinnedCursor = this.pinnedCount() - 1
    const selected = isFocused ? this.pinnedCursor : -1
    shown.forEach((change, i) => {
      this.changeRow(screen, x, top + 1 + i, w, change, i === selected, openFile)
    })
    if (hidden > 0) {
      const isCursor = selected === shown.length
      if (isCursor) screen.fill(x, top + pinnedRows, w, 1, ' ', { flags: INVERSE })
      screen.text(x + 1, top + pinnedRows, fit(`… ${hidden + 1} more · c for all`, w - 1), { flags: DIM | (isCursor ? INVERSE : 0) }, x + w)
    }
  }
}
