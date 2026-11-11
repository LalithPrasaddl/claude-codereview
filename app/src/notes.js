// Review notes: the person's comments on lines of Claude's changes, sent to Claude together.
import path from 'node:path'

/**
 * line: the line number in the file as it is now, or null for a removed line (diff view);
 * code: that line's text, so Claude can find it even if the lines have moved.
 * @typedef {{ file: string, line: number | null, code: string, text: string }} Note
 */

export class Notes {
  constructor() {
    /** @type {Note[]} */
    this.list = []
  }

  /** The note on this line of this file, if any. */
  at(file, line, code) {
    return this.list.find(n => n.file === file && n.line === line && (line !== null || n.code === code))
  }

  forFile(file) {
    return this.list.filter(n => n.file === file)
  }

  /** Add, change or (with empty text) remove the note on a line. */
  set(file, line, code, text) {
    const existing = this.at(file, line, code)
    const clean = text.replace(/\s+/g, ' ').trim()
    if (existing) {
      if (clean === '') this.list = this.list.filter(n => n !== existing)
      else existing.text = clean
      return
    }
    if (clean !== '') this.list.push({ file, line, code: code.trim(), text: clean })
  }

  get count() {
    return this.list.length
  }

  clear() {
    this.list = []
  }

  /**
   * All notes as one line for Claude's prompt (a newline there would submit it),
   * ordered by file then line.
   */
  toPrompt(cwd) {
    const sorted = [...this.list].sort((a, b) =>
      a.file === b.file ? (a.line ?? 0) - (b.line ?? 0) : a.file.localeCompare(b.file))
    const items = sorted.map((n, i) => {
      const where = `${path.relative(cwd, n.file) || n.file}${n.line === null ? ' (removed line)' : `:${n.line}`}`
      const code = n.code === '' ? '' : ` \`${n.code.length > 80 ? n.code.slice(0, 79) + '…' : n.code}\``
      return `(${i + 1}) ${where}${code}: ${n.text}`
    })
    return `Review notes on your changes: ${items.join(' ')} Please address each note.`
  }
}
