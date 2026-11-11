// The full-screen app: layout, focus, input routing and drawing.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ClaudePanel } from './claude-panel.js'
import { CodePanel } from './code-panel.js'
import { saveConfig } from './config.js'
import { isGitRepo } from './diff.js'
import { followOnEdit, followOnTurnEnd, reviewOrder } from './follow.js'
import { InputParser } from './input.js'
import { Notes } from './notes.js'
import { LAYOUTS, LAYOUT_LABELS, computeLayout, panelAt } from './layout.js'
import { BOLD, DIM, Screen } from './screen.js'
import { Session } from './session.js'
import { REPLY as TINT_REPLY } from './tint.js'
import { IGNORED, TreePanel } from './tree-panel.js'
import { fit, textWidth } from './width.js'

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hook.js')
const ACCENT = '38;5;209'
const PAUSE_STEPS = [0, 3, 5, 10]
const PREFIX_NAME = 'ctrl+\\'

const HELP = [
  'codeview: keys',
  '',
  `${PREFIX_NAME} is the prefix: press it, let go, then press one of:`,
  '  1 / 2 / 3     focus the tree / code / Claude (or click a panel)',
  '  tab           move focus to the next panel',
  '  l             switch layout (tree|code|claude, or claude below)',
  '  z             zoom the focused panel to full screen, and back',
  '  c             Claude only (the default Claude view), and back',
  '  f             follow Claude\'s edits on or off',
  '  g             review gate on/off: refuse git commit until all reviewed',
  '  p             pause Claude every 3 / 5 / 10 edited files, or off',
  '  space         let Claude continue after a pause',
  '  s             send your review notes to Claude\'s prompt',
  `  ${PREFIX_NAME}        send ${PREFIX_NAME} itself to Claude`,
  '  q             quit codeview (and Claude)',
  '',
  'In the tree:  ↑↓ / j k move · enter open · ← → fold · c changes list',
  'In the code:  ↑↓ move the line cursor · space/b page · d diff · n/p next/prev change',
  '              c note on this line · s send notes · r mark reviewed',
  '              a ask Claude about this file · esc back to Claude',
  '',
  'Native text selection: hold option (iTerm2/Terminal) or shift while dragging.',
  '',
  'Press any key to close.',
]

/** Single-quote a string for a POSIX shell. */
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`

export class App {
  /**
   * @param {{ cwd: string, claudeArgs: string[], config: import('./config.js').Config,
   *   tint?: import('./tint.js').Tint | null }} opts
   */
  constructor({ cwd, claudeArgs, config, tint = null }) {
    this.cwd = cwd
    this.config = config
    this.layout = config.layout
    /** @type {import('./layout.js').PanelId | null} */
    this.zoomed = null
    /** @type {import('./layout.js').PanelId} */
    this.focus = 'claude'
    this.isPrefix = false
    this.isHelp = false
    this.message = ''
    this.messageTimer = null
    this.renderTimer = null
    this.exited = false
    this.dragTarget = null

    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeview-'))
    this.session = new Session({ dir: this.dir, cwd, isGit: isGitRepo(cwd), config }, change => this.onEdit(change))
    this.tree = new TreePanel(cwd, this.session)
    this.code = new CodePanel(cwd, this.session)
    this.code.follow = config.follow
    this.code.tint = tint
    this.notes = new Notes()
    this.code.notes = this.notes
    /** The person opened a file themselves this turn: follow leaves them there. */
    this.userPicked = false
    this.session.onTurn = phase => this.onTurn(phase)
    this.parser = new InputParser()

    const cols = process.stdout.columns || 120
    const rows = process.stdout.rows || 40
    this.screen = new Screen(cols, rows)
    this.rects = computeLayout(cols, rows, this.layout, this.zoomed)
    const body = this.claudeBody()

    const settings = {
      hooks: {
        PreToolUse: [
          { matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: `${shq(process.execPath)} ${shq(HOOK)} pre` }] },
        ],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${shq(process.execPath)} ${shq(HOOK)} turn-start` }] }],
        Stop: [{ hooks: [{ type: 'command', command: `${shq(process.execPath)} ${shq(HOOK)} turn-end` }] }],
        PostToolUse: [
          { matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: `${shq(process.execPath)} ${shq(HOOK)} post` }] },
        ],
      },
    }
    /** @type {Record<string, string>} */
    const env = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    env.CODEVIEW_DIR = this.dir
    env.TERM = 'xterm-256color'
    env.COLORTERM = env.COLORTERM || 'truecolor'

    this.claude = new ClaudePanel(
      { cwd, args: ['--settings', JSON.stringify(settings), ...claudeArgs], env, cols: body.w, rows: body.h },
      () => this.scheduleRender(),
      code => this.exit(code),
    )
  }

  claudeBody() {
    const r = this.rects.claude ?? { x: 0, y: 0, w: this.screen.cols, h: this.screen.rows - 1 }
    return { x: r.x, y: r.y + 1, w: r.w, h: Math.max(3, r.h - 1) }
  }

  /** @param {string} [pending] keys typed before the app took over the terminal */
  start(pending = '') {
    const out = process.stdout
    out.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h')
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', data => this.onInput(data))
    out.on('resize', () => this.onResize())
    for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => this.exit(0))
    process.on('uncaughtException', err => this.exit(1, err))
    this.watch()
    this.render(true)
    if (pending !== '') this.onInput(pending)
  }

  watch() {
    let timer = null
    const touched = new Set()
    try {
      this.watcher = fs.watch(this.cwd, { recursive: true }, (_, name) => {
        if (!name) return
        const parts = String(name).split(path.sep)
        if (parts.some(p => IGNORED.has(p))) return
        const full = path.join(this.cwd, String(name))
        this.session.noteDiskChange(full)
        touched.add(full)
        clearTimeout(timer)
        timer = setTimeout(() => {
          this.tree.rebuild()
          if (this.code.file && touched.has(this.code.file)) this.code.reload()
          for (const file of touched) this.session.refresh(file)
          touched.clear()
          this.scheduleRender()
        }, 200)
      })
    } catch {
      // No recursive watch here: the tree still refreshes on Claude's edits.
    }
  }

  /** @param {import('./session.js').Change} change */
  onEdit(change) {
    this.tree.rebuild()
    const target = this.code.follow
      ? followOnEdit({ shown: this.code.file, edited: change.file, turn: this.session.turn, userPicked: this.userPicked || this.code.draft !== null })
      : null
    if (target !== null) {
      this.code.open(target, { focusLine: change.focusLine })
      if (this.focus !== 'tree') this.tree.reveal(target)
    } else if (this.code.file === change.file) {
      this.code.reload()
    }
    this.scheduleRender()
  }

  /** @param {'start' | 'end'} phase */
  onTurn(phase) {
    if (phase === 'start') {
      this.userPicked = false
      return
    }
    const { turn, changes } = this.session
    if (this.code.follow) {
      const target = followOnTurnEnd({ shown: this.code.file, turn, changes, userPicked: this.userPicked || this.code.draft !== null })
      if (target !== null) {
        const change = changes.find(c => c.file === target)
        this.code.open(target, { focusLine: change?.focusLine })
        if (this.focus !== 'tree') this.tree.reveal(target)
      }
    }
    const waiting = turn.filter(file => changes.some(c => c.file === file && !c.reviewed)).length
    if (turn.length > 1 && waiting > 0) this.flash(`Claude changed ${turn.length} files this turn, ${waiting} not reviewed: n steps through them in order.`)
    this.scheduleRender()
  }

  /** Open a file because the person asked: that counts as reviewing it. */
  openByUser(file, showDiff) {
    const change = this.session.changes.find(c => c.file === file)
    this.code.open(file, { focusLine: change?.focusLine, showDiff })
    this.userPicked = true
    if (change) this.session.markReviewed(file)
  }

  step(by) {
    const list = reviewOrder(this.session.turn, this.session.changes)
    if (list.length === 0) return this.flash('No changes yet.')
    const at = list.indexOf(this.code.file ?? '')
    const next = at < 0 && by < 0 ? list[list.length - 1] : list[(at + by + list.length) % list.length]
    this.openByUser(next)
    this.tree.reveal(next)
  }

  /** A key while a note is being typed. */
  draftKey(event) {
    const draft = /** @type {NonNullable<CodePanel['draft']>} */ (this.code.draft)
    if (event.name === 'enter') {
      const file = /** @type {string} */ (this.code.file)
      const had = this.notes.at(file, draft.line, draft.code) !== undefined
      this.notes.set(file, draft.line, draft.code, draft.text)
      this.code.draft = null
      const has = this.notes.at(file, draft.line, draft.code) !== undefined
      this.flash(had && !has ? 'Note removed.' : has ? `Note saved (${this.notes.count} in all). s sends them to Claude.` : 'Empty note: nothing saved.')
    } else if (event.name === 'escape') this.code.draft = null
    else if (event.name === 'backspace') draft.text = [...draft.text].slice(0, -1).join('')
    else if (event.name === 'space') draft.text += ' '
    else if (event.type === 'key' && /^[^\x00-\x1f\x7f]+$/.test(event.raw)) draft.text += event.raw
  }

  /** Type every note into Claude's prompt as one message; the person reads it and presses enter. */
  sendNotes() {
    if (this.notes.count === 0) return this.flash('No notes yet: in the code panel, c adds one on the cursor line.')
    const n = this.notes.count
    this.claude.write(this.notes.toPrompt(this.cwd))
    this.notes.clear()
    this.focus = 'claude'
    if (this.zoomed !== null && this.zoomed !== 'claude') {
      this.zoomed = null
      this.relayout()
    }
    this.flash(`${n} note${n === 1 ? ' is' : 's are'} in Claude's prompt: press enter to send.`)
  }

  flash(text) {
    this.message = text
    clearTimeout(this.messageTimer)
    this.messageTimer = setTimeout(() => {
      this.message = ''
      this.scheduleRender()
    }, 2500)
  }

  setLayout(layout) {
    this.layout = layout
    this.zoomed = null
    saveConfig({ layout })
    this.relayout()
    this.flash(`Layout: ${LAYOUT_LABELS[layout]}`)
  }

  relayout() {
    this.rects = computeLayout(this.screen.cols, this.screen.rows, this.layout, this.zoomed)
    if (this.rects[this.focus] === null) this.focus = this.zoomed ?? 'claude'
    const body = this.claudeBody()
    this.claude.resize(body.w, body.h)
    this.render(true)
  }

  onResize() {
    this.screen.resize(process.stdout.columns || 120, process.stdout.rows || 40)
    process.stdout.write('\x1b[2J')
    this.relayout()
  }

  /** The key after the prefix. */
  command(name) {
    const order = /** @type {const} */ (['tree', 'code', 'claude'])
    switch (name) {
      case '1':
      case '2':
      case '3': {
        const id = order[Number(name) - 1]
        if (this.zoomed !== null && this.zoomed !== id) {
          this.zoomed = id
          this.relayout()
        }
        this.focus = id
        break
      }
      case 'tab': {
        const visible = order.filter(id => this.rects[id] !== null)
        this.focus = visible[(visible.indexOf(this.focus) + 1) % visible.length] ?? 'claude'
        break
      }
      case 'l':
        this.setLayout(LAYOUTS[(LAYOUTS.indexOf(this.layout) + 1) % LAYOUTS.length])
        break
      case 'z':
        this.zoomed = this.zoomed === null ? this.focus : null
        this.relayout()
        break
      case 'c':
        this.zoomed = this.zoomed === 'claude' ? null : 'claude'
        this.focus = 'claude'
        this.relayout()
        this.flash(this.zoomed ? `Claude only. ${PREFIX_NAME} c brings the viewer back.` : 'Viewer back.')
        break
      case 'f':
        this.code.follow = !this.code.follow
        saveConfig({ follow: this.code.follow })
        this.flash(`Follow Claude's edits: ${this.code.follow ? 'on' : 'off'}`)
        break
      case 'g':
        this.session.setGate(!this.session.gate)
        saveConfig({ gate: this.session.gate })
        this.flash(this.session.gate ? 'Review gate on: git commit waits until every change is reviewed.' : 'Review gate off.')
        break
      case 'p': {
        const next = PAUSE_STEPS[(PAUSE_STEPS.indexOf(this.session.threshold) + 1) % PAUSE_STEPS.length] ?? 0
        this.session.setThreshold(next)
        saveConfig({ threshold: next })
        this.flash(next === 0 ? 'Pause off.' : `Claude pauses for your review every ${next} edited files.`)
        break
      }
      case 'space':
        this.session.allowMore()
        this.flash('Claude may continue editing.')
        break
      case 's':
        this.sendNotes()
        break
      case '?':
      case 'h':
        this.isHelp = true
        break
      case 'q':
        this.claude.kill()
        this.exit(0)
        return
      case 'ctrl-\\':
        this.claude.write('\x1c')
        break
      default:
        break
    }
    this.scheduleRender()
  }

  onInput(data) {
    // A late answer to the background-color question must not reach Claude as typing.
    data = data.replace(new RegExp(TINT_REPLY.source, 'gi'), '')
    for (const event of this.parser.feed(data)) {
      if (this.isHelp) {
        if (event.type !== 'mouse' || !event.isRelease) this.isHelp = false
        continue
      }
      if (event.type === 'paste' && this.code.draft) {
        this.code.draft.text += event.raw.slice(6, -6).replace(/\s+/g, ' ')
        continue
      }
      if (event.type === 'paste') {
        this.focus = 'claude'
        this.claude.write(this.claude.wantsPaste ? event.raw : event.raw.slice(6, -6))
        continue
      }
      if (event.type === 'mouse') {
        this.onMouse(event)
        continue
      }
      if (this.isPrefix) {
        this.isPrefix = false
        this.command(event.name)
        continue
      }
      if (event.name === 'ctrl-\\') {
        this.isPrefix = true
        continue
      }
      if (this.code.draft && this.focus === 'code') {
        this.draftKey(event)
        continue
      }
      if (this.focus === 'claude') {
        this.claude.write(event.raw)
        continue
      }
      if (event.name === 'escape') {
        this.focus = 'claude'
        continue
      }
      if (event.name === 'tab') {
        this.command('tab')
        continue
      }
      if (this.focus === 'tree') {
        const result = this.tree.key(event.name)
        if (result) this.openByUser(result.open)
        continue
      }
      const action = this.code.key(event.name)
      if (action === 'next') this.step(1)
      else if (action === 'prev') this.step(-1)
      else if (action === 'reviewed' && this.code.file) {
        const change = this.session.changes.find(c => c.file === this.code.file)
        if (change) this.session.markReviewed(change.file, !change.reviewed)
        else this.flash('Claude has not changed this file.')
      } else if (action === 'note') {
        const at = this.code.file ? this.code.lineAt() : null
        if (at === null || this.code.file === null) this.flash('Put the cursor on a line of code first.')
        else this.code.draft = { ...at, text: this.notes.at(this.code.file, at.line, at.code)?.text ?? '' }
      } else if (action === 'send') {
        this.sendNotes()
      } else if (action === 'ask' && this.code.file) {
        this.claude.write(`About your change to ${path.relative(this.cwd, this.code.file)}: `)
        this.focus = 'claude'
      }
    }
    this.scheduleRender()
  }

  /** @param {import('./input.js').MouseEvent} event */
  onMouse(event) {
    const id = event.isDrag || event.isRelease ? this.dragTarget ?? panelAt(this.rects, event.x, event.y) : panelAt(this.rects, event.x, event.y)
    if (id === null) return
    const rect = this.rects[id]
    if (!rect) return
    if (event.isWheel) {
      const delta = event.button === 0 ? -3 : 3
      if (id === 'tree') this.tree.wheel(delta)
      else if (id === 'code') this.code.wheel(delta)
      else this.claude.mouse(event, rect.x, rect.y + 1)
      return
    }
    if (!event.isRelease && !event.isDrag) {
      this.focus = id
      this.dragTarget = id
      if (id === 'code') this.code.clickAt(event.y)
      if (id === 'tree' && event.y > rect.y) {
        const result = this.tree.click(event.y - rect.y - 1)
        if (result) this.openByUser(result.open)
      }
    }
    if (id === 'claude') this.claude.mouse(event, rect.x, rect.y + 1)
    if (event.isRelease) this.dragTarget = null
  }

  scheduleRender() {
    if (this.renderTimer !== null || this.exited) return
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null
      this.render()
    }, 16)
  }

  render(force = false) {
    if (this.exited) return
    const s = this.screen
    s.clear()
    const { tree, code, claude } = this.rects

    if (tree) {
      this.title(tree, this.tree.title(), 'tree')
      this.tree.paint(s, tree.x, tree.y + 1, tree.w, tree.h - 1, this.focus === 'tree', this.code.file)
    }
    if (code) {
      this.title(code, this.code.title(), 'code')
      if (this.code.draft && this.focus !== 'code') this.code.draft = null
      this.code.paint(s, code.x, code.y + 1, code.w, code.h - 1, this.focus === 'code')
    }
    if (claude) {
      this.title(claude, 'CLAUDE', 'claude')
      const cursor = this.claude.paint(s, claude.x, claude.y + 1, this.focus === 'claude' && !this.isPrefix)
      s.cursor = cursor
    }
    if (code && this.code.inputCursor) {
      s.cursor = this.code.inputCursor
    }
    this.borders()
    this.statusBar()
    if (this.isHelp) this.helpBox()
    process.stdout.write(s.flush(force))
  }

  title(rect, text, id) {
    const isFocused = this.focus === id
    const label = ` ${isFocused ? '●' : '○'} ${text} `
    this.screen.text(rect.x, rect.y, fit(label, rect.w), isFocused ? { fg: ACCENT, flags: BOLD } : { flags: DIM }, rect.x + rect.w)
  }

  borders() {
    const s = this.screen
    const style = { flags: DIM }
    const { tree, code, claude } = this.rects
    const vline = (x, y, h) => {
      for (let j = y; j < y + h; j++) s.set(x, j, '│', '', '', DIM)
    }
    if (this.zoomed !== null) return
    if (this.layout === 'stacked' && tree && code && claude) {
      vline(tree.x + tree.w, tree.y, tree.h)
      s.fill(0, claude.y - 1, s.cols, 1, '─', style)
      s.set(tree.x + tree.w, claude.y - 1, '┴', '', '', DIM)
      return
    }
    if (tree) vline(tree.x + tree.w, tree.y, tree.h)
    if (code) vline(code.x + code.w, code.y, code.h)
  }

  statusBar() {
    const s = this.screen
    const y = s.rows - 1
    const left = this.isPrefix
      ? ` ${PREFIX_NAME} … 1 tree · 2 code · 3 claude · l layout · z zoom · c claude only · ? help`
      : this.message
        ? ` ${this.message}`
        : ` ${PREFIX_NAME} then: 1 tree · 2 code · 3 claude · l layout · z zoom · ? help`
    const parts = []
    if (this.session.gate) parts.push('gate on')
    if (this.session.threshold > 0) parts.push(`pause every ${this.session.threshold}`)
    const n = this.session.changes.length
    if (n > 0) parts.push(`${this.session.reviewedCount}/${n} reviewed`)
    if (this.notes.count > 0) parts.push(`${this.notes.count} note${this.notes.count === 1 ? '' : 's'}: s sends`)
    parts.push(this.zoomed ? `zoom: ${this.zoomed}` : LAYOUT_LABELS[this.layout])
    const right = parts.join(' · ') + ' '
    const rightW = textWidth(right)
    s.text(0, y, fit(left, Math.max(0, s.cols - rightW - 1)), this.isPrefix || this.message ? { fg: ACCENT, flags: BOLD } : { flags: DIM })
    s.text(s.cols - rightW, y, right, { flags: DIM })
  }

  helpBox() {
    const s = this.screen
    const w = Math.min(s.cols - 2, Math.max(...HELP.map(l => textWidth(l))) + 4)
    const h = Math.min(s.rows - 2, HELP.length + 2)
    const x = Math.floor((s.cols - w) / 2)
    const y = Math.floor((s.rows - h) / 2)
    s.fill(x, y, w, h, ' ')
    s.text(x, y, '╭' + '─'.repeat(w - 2) + '╮', { fg: ACCENT })
    s.text(x, y + h - 1, '╰' + '─'.repeat(w - 2) + '╯', { fg: ACCENT })
    for (let j = 1; j < h - 1; j++) {
      s.set(x, y + j, '│', ACCENT)
      s.set(x + w - 1, y + j, '│', ACCENT)
      const line = HELP[j - 1] ?? ''
      s.text(x + 2, y + j, fit(line, w - 4), j === 1 ? { fg: ACCENT, flags: BOLD } : {}, x + w - 1)
    }
  }

  exit(code, err) {
    if (this.exited) return
    this.exited = true
    try {
      this.watcher?.close()
      this.session.stop()
      this.claude.kill()
    } catch {
      // best effort
    }
    process.stdout.write('\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[0m\x1b[?25h\x1b[?1049l')
    try {
      process.stdin.setRawMode(false)
    } catch {
      // not a tty any more
    }
    fs.rmSync(this.dir, { recursive: true, force: true })
    if (err) console.error('codeview crashed:', err)
    process.exit(code)
  }
}


