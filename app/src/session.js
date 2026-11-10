// The session's changes: read from the hook's events.jsonl, shared back through state.json.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { diffFor, diffStats, firstChangedLine } from './diff.js'

/**
 * @typedef {{ file: string, added: number, removed: number, edits: number,
 *   reviewed: boolean, why: string, focusLine: number, lastAt?: number,
 *   status: 'modified' | 'new' | 'deleted' }} Change
 */

/** Whether a diff adds, deletes or modifies its file. */
export function fileStatus(file, diff) {
  if (!fs.existsSync(file) || /^\+\+\+ \/dev\/null/m.test(diff) || /^deleted file mode/m.test(diff)) return 'deleted'
  if (/^--- \/dev\/null/m.test(diff) || /^new file mode/m.test(diff)) return 'new'
  return 'modified'
}

/** The first sentence of what Claude said, one line. */
export function oneLine(text, max = 160) {
  const flat = text.replace(/\s+/g, ' ').trim()
  const sentence = /^(.+?[.!?:])(\s|$)/.exec(flat)?.[1] ?? flat
  return sentence.length > max ? sentence.slice(0, max - 1) + '…' : sentence
}

/** The last thing Claude said in the transcript (a JSONL file), read from its tail. */
export function lastAssistantText(transcript) {
  if (typeof transcript !== 'string' || transcript === '') return ''
  let fd
  try {
    fd = fs.openSync(transcript, 'r')
    const size = fs.fstatSync(fd).size
    const len = Math.min(size, 512 * 1024)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line.includes('"assistant"')) continue
      try {
        const row = JSON.parse(line)
        const content = row?.message?.content
        if (row?.type !== 'assistant' || !Array.isArray(content)) continue
        const text = content.filter(b => b?.type === 'text').map(b => b.text).join(' ').trim()
        if (text !== '') return oneLine(text)
      } catch {
        // The first line of the tail is usually cut: skip it.
      }
    }
  } catch {
    // No transcript: no "why".
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  return ''
}

export class Session {
  /**
   * @param {{ dir: string, cwd: string, isGit: boolean, config: import('./config.js').Config }} opts
   * @param {(change: Change) => void} onEdit
   */
  constructor({ dir, cwd, isGit, config }, onEdit) {
    this.dir = dir
    this.cwd = cwd
    this.isGit = isGit
    this.gate = config.gate
    this.threshold = config.threshold
    this.allowance = config.threshold
    /** @type {Change[]} */
    this.changes = []
    this.onEdit = onEdit
    this.offset = 0
    /** @type {{ file: string, at: number }[]} files the watcher saw change */
    this.diskChanges = []
    /** @type {Map<string, number>} Bash calls running: id → start time */
    this.running = new Map()
    /** @type {{ start: number, end: number, transcript: string | null, readAt: number, isTurnEnd?: boolean }[]} */
    this.windows = []
    /** True from the person's prompt until Claude's turn ends: disk changes then are Claude's. */
    this.busy = false
    this.turnStart = 0
    this.turnTranscript = null
    /** @type {string[]} files Claude changed this turn, in the order it changed them */
    this.turn = []
    /** @type {(phase: 'start' | 'end') => void} called at a turn's start, and once its last files have settled */
    this.onTurn = () => {}
    /** @type {Map<string, NodeJS.Timeout>} */
    this.liveTimers = new Map()
    this.eventsPath = path.join(dir, 'events.jsonl')
    fs.mkdirSync(path.join(dir, 'baseline'), { recursive: true })
    fs.writeFileSync(this.eventsPath, '')
    this.writeState()
    this.timer = setInterval(() => this.poll(), 250)
  }

  stop() {
    clearInterval(this.timer)
    for (const t of this.liveTimers.values()) clearTimeout(t)
  }

  writeState() {
    const state = {
      gate: this.gate,
      threshold: this.threshold,
      allowance: this.allowance,
      reviewed: this.changes.filter(c => c.reviewed).map(c => c.file),
    }
    try {
      fs.writeFileSync(path.join(this.dir, 'state.json'), JSON.stringify(state))
    } catch {
      // The session folder went away: the gate just won't see it.
    }
  }

  diff(file) {
    return diffFor(file, { cwd: this.cwd, isGit: this.isGit, sessionDir: this.dir })
  }

  /** The watcher saw `file` change just now. */
  noteDiskChange(file) {
    const now = Date.now()
    this.diskChanges.push({ file, at: now })
    if (this.diskChanges.length > 5000) this.diskChanges = this.diskChanges.filter(c => now - c.at < 600_000)
    if (!this.busy) return
    clearTimeout(this.liveTimers.get(file))
    this.liveTimers.set(file, setTimeout(() => {
      this.liveTimers.delete(file)
      this.recordFromDisk(file, now, this.turnTranscript)
    }, 300))
  }

  /** Record a file the watcher saw change during Claude's turn, unless it's not worth showing. */
  recordFromDisk(file, at, transcript) {
    const known = this.changes.find(c => c.file === file)
    if (known && (known.lastAt ?? 0) >= at) return // an edit event already covered it
    try {
      if (!fs.statSync(file).isFile()) return
    } catch {
      if (!known) return // deleted, and never one of Claude's
    }
    if (this.isGit && spawnSync('git', ['check-ignore', '-q', file], { cwd: this.cwd }).status === 0) return
    this.record(file, lastAssistantText(transcript))
  }

  /** Files that changed on disk while a Bash call ran count as Claude's. */
  settleWindows() {
    const now = Date.now()
    const ready = this.windows.filter(w => now - w.readAt >= 700)
    if (ready.length === 0) return
    this.windows = this.windows.filter(w => now - w.readAt < 700)
    for (const w of ready) {
      const files = new Set(
        this.diskChanges.filter(c => c.at >= w.start - 50 && c.at <= w.end + 700).map(c => c.file),
      )
      for (const file of files) {
        const at = Math.max(...this.diskChanges.filter(c => c.file === file).map(c => c.at))
        this.recordFromDisk(file, at, w.transcript)
      }
      if (w.isTurnEnd) this.onTurn('end')
    }
  }

  poll() {
    this.settleWindows()
    let size
    try {
      size = fs.statSync(this.eventsPath).size
    } catch {
      return
    }
    if (size <= this.offset) return
    const fd = fs.openSync(this.eventsPath, 'r')
    const buf = Buffer.alloc(size - this.offset)
    fs.readSync(fd, buf, 0, buf.length, this.offset)
    fs.closeSync(fd)
    const text = buf.toString('utf8')
    const end = text.lastIndexOf('\n')
    if (end < 0) return
    this.offset += Buffer.byteLength(text.slice(0, end + 1))
    for (const line of text.slice(0, end).split('\n')) {
      if (line.trim() === '') continue
      try {
        const event = JSON.parse(line)
        if (event.type === 'edit') this.record(event.file, lastAssistantText(event.transcript))
        else if (event.type === 'turn-start') {
          this.busy = true
          this.turnStart = event.at
          this.turnTranscript = event.transcript
          this.turn = []
          this.onTurn('start')
        } else if (event.type === 'turn-end') {
          this.busy = false
          this.windows.push({ start: this.turnStart || event.at, end: event.at, transcript: event.transcript, readAt: Date.now(), isTurnEnd: true })
        } else if (event.type === 'tool-start') this.running.set(String(event.id), event.at)
        else if (event.type === 'tool-end') {
          const id = String(event.id)
          const start = this.running.get(id) ?? event.at - 60_000
          this.running.delete(id)
          this.windows.push({ start, end: event.at, transcript: event.transcript, readAt: Date.now() })
        }
      } catch {
        // skip a broken line
      }
    }
  }

  /** Fold one edit into the change list. */
  record(file, why) {
    const { text } = this.diff(file)
    const { added, removed } = diffStats(text)
    const focusLine = firstChangedLine(text)
    const status = fileStatus(file, text)
    let change = this.changes.find(c => c.file === file)
    if (change === undefined) {
      change = { file, added, removed, edits: 1, reviewed: false, why, focusLine, lastAt: Date.now(), status }
      this.changes.push(change)
    } else {
      // One change can arrive twice (the watcher, then the edit hook): count it once.
      const isRepeat = Date.now() - (change.lastAt ?? 0) < 1500
      Object.assign(change, {
        added, removed, focusLine, status, reviewed: false, lastAt: Date.now(),
        edits: change.edits + (isRepeat ? 0 : 1),
        why: why || change.why,
      })
    }
    if (!this.turn.includes(file)) this.turn.push(file)
    this.writeState()
    this.onEdit(change)
  }

  /** Recount one file's lines (after it changed on disk). */
  refresh(file) {
    const change = this.changes.find(c => c.file === file)
    if (change === undefined) return
    const { text } = this.diff(file)
    Object.assign(change, diffStats(text), { status: fileStatus(file, text) })
  }

  markReviewed(file, value = true) {
    const change = this.changes.find(c => c.file === file)
    if (change === undefined || change.reviewed === value) return
    change.reviewed = value
    this.writeState()
  }

  setGate(on) {
    this.gate = on
    this.writeState()
  }

  setThreshold(n) {
    this.threshold = n
    this.allowance = this.changes.length + n
    this.writeState()
  }

  allowMore() {
    this.allowance = this.changes.length + Math.max(1, this.threshold)
    this.writeState()
  }

  get reviewedCount() {
    return this.changes.filter(c => c.reviewed).length
  }
}
