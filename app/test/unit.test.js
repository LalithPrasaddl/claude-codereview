import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { changedLines, diffStats, firstChangedLine, hunksOnly, isGitCommit } from '../src/diff.js'
import { followOnEdit, followOnTurnEnd, reviewOrder } from '../src/follow.js'
import { highlightLines, languageFor } from '../src/highlight.js'
import { InputParser } from '../src/input.js'
import { computeLayout, panelAt } from '../src/layout.js'
import { Screen } from '../src/screen.js'
import { oneLine } from '../src/session.js'
import { TreePanel } from '../src/tree-panel.js'
import { fit, textWidth } from '../src/width.js'

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hook.js')

const DIFF = ['--- a/a.js', '+++ b/a.js', '@@ -3,4 +3,5 @@', ' one', ' two', '-three', '+THREE', '+four', ' five'].join('\n')

test('diff helpers', () => {
  assert.deepEqual(diffStats(DIFF), { added: 2, removed: 1 })
  assert.equal(firstChangedLine(DIFF), 5)
  assert.ok(hunksOnly(DIFF).startsWith('@@'))
  const { added, removedAfter } = changedLines(DIFF)
  assert.deepEqual([...added], [5, 6])
  assert.deepEqual([...removedAfter], [4])
  assert.equal(isGitCommit('git commit -m x'), true)
  assert.equal(isGitCommit('npm test && git -C repo commit -am x'), true)
  assert.equal(isGitCommit('git status'), false)
  assert.equal(isGitCommit('echo commit'), false)
})

test('input parser: keys, mouse, paste split across chunks', () => {
  const p = new InputParser()
  const events = p.feed('a\x1b[A\x1c\r\x1b[<0;10;5M\x1b[<64;3;3M')
  assert.deepEqual(events.map(e => (e.type === 'key' ? e.name : e.type)), ['a', 'up', 'ctrl-\\', 'enter', 'mouse', 'mouse'])
  const click = events[4]
  assert.equal(click.type === 'mouse' && click.x, 9)
  const wheel = events[5]
  assert.equal(wheel.type === 'mouse' && wheel.isWheel, true)
  assert.deepEqual(p.feed('\x1b[200~hel'), [])
  const paste = p.feed('lo\x1b[201~x')
  assert.equal(paste[0].type, 'paste')
  assert.equal(paste[0].raw, '\x1b[200~hello\x1b[201~')
  assert.equal(paste[1].type === 'key' && paste[1].name, 'x')
})

test('layouts fill the screen without overlapping', () => {
  for (const layout of /** @type {const} */ (['editor', 'stacked'])) {
    const r = computeLayout(200, 50, layout, null)
    assert.ok(r.tree && r.code && r.claude)
    assert.equal(panelAt(r, r.tree.x, r.tree.y), 'tree')
    assert.equal(panelAt(r, r.code.x, r.code.y), 'code')
    assert.equal(panelAt(r, r.claude.x, r.claude.y), 'claude')
  }
  const editor = computeLayout(200, 50, 'editor', null)
  assert.ok(editor.tree.x < editor.code.x && editor.code.x < editor.claude.x)
  const stacked = computeLayout(200, 50, 'stacked', null)
  assert.ok(stacked.claude.y > stacked.code.y)
  const zoomed = computeLayout(200, 50, 'editor', 'code')
  assert.equal(zoomed.tree, null)
  assert.equal(zoomed.code?.w, 200)
  // Too narrow for three columns: falls back to claude below.
  const narrow = computeLayout(80, 40, 'editor', null)
  assert.ok(narrow.claude && narrow.code && narrow.claude.y > narrow.code.y)
})

test('screen writes only changed rows, wide characters take two cells', () => {
  const s = new Screen(10, 2)
  s.text(0, 0, '你好ab')
  const first = s.flush()
  assert.ok(first.includes('你好ab'))
  assert.equal(s.flush(), '\x1b[?25l')
  s.text(0, 1, 'x')
  const second = s.flush()
  assert.ok(second.includes('\x1b[2;1H') && !second.includes('\x1b[1;1H'))
  assert.equal(textWidth('你好'), 4)
  assert.equal(fit('abcdefgh', 5), 'abcd…')
})

test('highlighting keeps every line', () => {
  assert.equal(languageFor('/x/a.ts'), 'typescript')
  assert.equal(languageFor('/x/notes.unknownext'), null)
  const lines = highlightLines('const a = "<b>" // hi\nlet b = 2', 'javascript')
  assert.equal(lines.length, 2)
  assert.equal(lines[0].map(s => s.text).join(''), 'const a = "<b>" // hi')
  assert.ok(lines[0].some(s => s.fg === '35'))
  assert.equal(oneLine('Rename it. Then more.'), 'Rename it.')
})

function hook(dir, phase, input) {
  return spawnSync(process.execPath, [HOOK, phase], {
    input: JSON.stringify(input),
    env: { ...process.env, CODEVIEW_DIR: dir },
    encoding: 'utf8',
  })
}

test('hook: records edits, saves a baseline, gate and pause are off by default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeview-test-'))
  const file = path.join(dir, 'a.txt')
  fs.writeFileSync(file, 'before\n')
  const edit = { tool_name: 'Edit', tool_input: { file_path: file }, cwd: dir, tool_use_id: 't1' }

  assert.equal(hook(dir, 'pre', edit).status, 0)
  fs.writeFileSync(file, 'after\n')
  assert.equal(hook(dir, 'post', edit).status, 0)
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(events[0].type, 'edit')
  assert.equal(events[0].file, file)
  const baselines = fs.readdirSync(path.join(dir, 'baseline'))
  assert.equal(fs.readFileSync(path.join(dir, 'baseline', baselines[0]), 'utf8'), 'before\n')

  const commit = { tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: dir, tool_use_id: 'b1' }
  assert.equal(hook(dir, 'pre', commit).status, 0)

  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ gate: true, threshold: 0, allowance: 0, reviewed: [] }))
  const gated = hook(dir, 'pre', commit)
  assert.equal(gated.status, 2)
  assert.match(gated.stderr, /review gate/)

  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ gate: true, threshold: 0, allowance: 0, reviewed: [file] }))
  assert.equal(hook(dir, 'pre', commit).status, 0)

  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ gate: false, threshold: 1, allowance: 1, reviewed: [] }))
  const other = { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'b.txt') }, cwd: dir }
  const paused = hook(dir, 'pre', other)
  assert.equal(paused.status, 2)
  assert.match(paused.stderr, /pause/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('session: a file changed on disk during a turn is followed, after the turn it is not', async () => {
  const { Session } = await import('../src/session.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeview-test-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codeview-cwd-'))
  const followed = []
  const session = new Session(
    { dir, cwd, isGit: false, config: { enabled: true, layout: 'editor', gate: false, threshold: 0, follow: true } },
    change => followed.push(change.file),
  )
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ type: 'turn-start', at: Date.now() }) + '\n')
  session.poll()
  const a = path.join(cwd, 'a.js')
  fs.writeFileSync(a, 'x\n')
  session.noteDiskChange(a)
  await sleep(450)
  assert.deepEqual(followed, [a])

  fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ type: 'turn-end', at: Date.now() }) + '\n')
  session.poll()
  await sleep(800)
  session.poll()
  assert.equal(session.changes.length, 1)
  assert.equal(session.changes[0].edits, 1)

  const b = path.join(cwd, 'b.js')
  fs.writeFileSync(b, 'y\n')
  session.noteDiskChange(b)
  await sleep(450)
  assert.deepEqual(followed, [a])
  session.stop()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(cwd, { recursive: true, force: true })
})

test('tree: arrows move from the tree into the pinned changed list and back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeview-tree-'))
  for (const name of ['a.js', 'b.js', 'c.js']) fs.writeFileSync(path.join(dir, name), 'x\n')
  const change = (name, reviewed) => ({ file: path.join(dir, name), added: 1, removed: 0, edits: 1, reviewed, why: '', focusLine: 1, status: 'modified' })
  const session = { changes: [change('a.js', false), change('c.js', false)] }
  const tree = new TreePanel(dir, session)
  const screen = new Screen(40, 12)
  const paint = () => tree.paint(screen, 0, 0, 40, 12, true, null)
  paint()
  // Newest unreviewed first.
  assert.deepEqual(tree.pinnedFiles.map(f => path.basename(f)), ['c.js', 'a.js'])
  tree.key('G')
  assert.equal(tree.pinnedCursor, -1)
  tree.key('down')
  assert.equal(tree.pinnedCursor, 0)
  tree.key('down')
  tree.key('down')
  assert.equal(tree.pinnedCursor, 1, 'stops at the last pinned row')
  assert.equal(path.basename(tree.key('enter').open), 'a.js')
  tree.key('up')
  tree.key('up')
  assert.equal(tree.pinnedCursor, -1)
  assert.equal(tree.cursor, 2, 'back on the last tree row')
  tree.key('down')
  // Reviewing the selected file reorders the list; the cursor stays on a real row.
  session.changes = [change('a.js', true)]
  paint()
  assert.equal(tree.pinnedCursor, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('follow: the turn\'s first file opens, later ones wait, the person\'s pick wins', () => {
  const turn = ['a.js', 'b.js']
  assert.equal(followOnEdit({ shown: null, edited: 'a.js', turn: ['a.js'], userPicked: false }), 'a.js')
  assert.equal(followOnEdit({ shown: 'old.js', edited: 'a.js', turn: ['a.js'], userPicked: false }), 'a.js', 'a file from before the turn gives way')
  assert.equal(followOnEdit({ shown: 'a.js', edited: 'b.js', turn, userPicked: false }), null, 'b.js waits in the queue')
  assert.equal(followOnEdit({ shown: 'a.js', edited: 'a.js', turn, userPicked: false }), 'a.js', 'a new change to the open file shows')
  assert.equal(followOnEdit({ shown: 'x.js', edited: 'a.js', turn: ['a.js'], userPicked: true }), null)

  const changes = [{ file: 'a.js', reviewed: true }, { file: 'b.js', reviewed: false }, { file: 'c.js', reviewed: false }]
  assert.equal(followOnTurnEnd({ shown: 'c.js', turn: ['a.js', 'b.js', 'c.js'], changes, userPicked: false }), 'b.js')
  assert.equal(followOnTurnEnd({ shown: 'b.js', turn: ['a.js', 'b.js'], changes, userPicked: false }), null)
  assert.equal(followOnTurnEnd({ shown: 'c.js', turn: ['a.js', 'b.js'], changes, userPicked: true }), null)
  assert.equal(followOnTurnEnd({ shown: 'a.js', turn: ['a.js'], changes, userPicked: false }), null, 'all reviewed: stay')

  assert.deepEqual(reviewOrder(['c.js', 'a.js'], [{ file: 'a.js' }, { file: 'b.js' }, { file: 'c.js' }]), ['c.js', 'a.js', 'b.js'])
})

test('session: keeps this turn\'s files in edit order and reports the turn\'s end after they settle', async () => {
  const { Session } = await import('../src/session.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeview-test-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codeview-cwd-'))
  const session = new Session(
    { dir, cwd, isGit: false, config: { enabled: true, layout: 'editor', gate: false, threshold: 0, follow: true } },
    () => {},
  )
  const phases = []
  session.onTurn = phase => phases.push([phase, [...session.turn]])
  const event = e => fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(e) + '\n')
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const [a, b] = [path.join(cwd, 'a.js'), path.join(cwd, 'b.js')]
  fs.writeFileSync(a, 'x\n')
  fs.writeFileSync(b, 'y\n')

  event({ type: 'turn-start', at: Date.now() })
  event({ type: 'edit', file: a })
  event({ type: 'edit', file: b })
  event({ type: 'edit', file: a })
  session.poll()
  assert.deepEqual(session.turn, [a, b])
  event({ type: 'turn-end', at: Date.now() })
  session.poll()
  await sleep(750)
  session.poll()
  assert.deepEqual(phases, [['start', []], ['end', [a, b]]])

  event({ type: 'turn-start', at: Date.now() })
  session.poll()
  assert.deepEqual(session.turn, [], 'a new turn starts empty')
  session.stop()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(cwd, { recursive: true, force: true })
})

test('tint: reads the terminal\'s background reply and picks dark or light', async () => {
  const { isLight, parseBackground, tintFor } = await import('../src/tint.js')
  assert.deepEqual(parseBackground('\x1b]11;rgb:1e1e/1e1e/1e1e\x07'), { r: 30, g: 30, b: 30 })
  assert.deepEqual(parseBackground('x\x1b]11;rgb:ff/ff/ff\x1b\\y'), { r: 255, g: 255, b: 255 }, 'ESC \\ ending, 2-digit channels')
  assert.equal(parseBackground('\x1b[A'), null)
  assert.equal(isLight({ r: 30, g: 30, b: 30 }), false)
  assert.equal(isLight({ r: 250, g: 250, b: 245 }), true)
  assert.match(tintFor('dark', false).added, /^48;5;/)
  assert.match(tintFor('light', true).removed, /^48;2;/)
})

test('notes: add, edit, remove, and one-line prompt in file and line order', async () => {
  const { Notes } = await import('../src/notes.js')
  const notes = new Notes()
  notes.set('/r/src/b.js', 10, '  return x  ', 'handle null')
  notes.set('/r/src/a.js', 4, 'const y = 1', 'why a constant?')
  notes.set('/r/src/a.js', null, 'oldCall()', 'this was still\nused')
  assert.equal(notes.count, 3)
  notes.set('/r/src/b.js', 10, 'return x', 'handle null and undefined')
  assert.equal(notes.at('/r/src/b.js', 10, '').text, 'handle null and undefined', 'same line edits the note')
  const prompt = notes.toPrompt('/r')
  assert.ok(!prompt.includes('\n'), 'a newline would submit the prompt')
  assert.equal(prompt,
    'Review notes on your changes: (1) src/a.js (removed line) `oldCall()`: this was still used (2) src/a.js:4 `const y = 1`: why a constant?' +
    ' (3) src/b.js:10 `return x`: handle null and undefined Please address each note.')
  notes.set('/r/src/a.js', 4, '', '   ')
  assert.equal(notes.count, 2, 'saving an empty note removes it')
})

test('code panel: diff line numbers and the cursor line as a note target', async () => {
  const { CodePanel, diffLineNumbers } = await import('../src/code-panel.js')
  assert.deepEqual(diffLineNumbers(['@@ -1,2 +1,3 @@', ' a', '-b', '+c', '+d', '\\ No newline at end of file']), [null, 1, null, 2, 3, null])
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeview-code-'))
  const file = path.join(dir, 'a.js')
  fs.writeFileSync(file, 'one\ntwo\nthree\n')
  const panel = new CodePanel(dir, { changes: [], diff: () => ({ text: '@@ -1,3 +1,3 @@\n one\n-zwei\n+two\n three\n', base: 'HEAD' }) })
  panel.open(file)
  panel.height = 2
  panel.key('down')
  assert.deepEqual(panel.lineAt(), { line: 2, code: 'two' })
  panel.key('down')
  panel.key('down')
  assert.equal(panel.cursor, 2, 'stops at the last line')
  assert.equal(panel.scroll, 1, 'scrolls to keep the cursor visible')
  assert.equal(panel.key('c'), 'note')
  panel.key('d')
  assert.equal(panel.cursor, 2, 'diff view starts on the first changed line')
  assert.deepEqual(panel.lineAt(), { line: null, code: 'zwei' })
  panel.key('down')
  assert.deepEqual(panel.lineAt(), { line: 2, code: 'two' })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('since review: a reviewed file Claude edits again shows only what is new, and a revert stays reviewed', async () => {
  const { Session } = await import('../src/session.js')
  const { CodePanel } = await import('../src/code-panel.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeview-test-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codeview-cwd-'))
  const session = new Session(
    { dir, cwd, isGit: false, config: { enabled: true, layout: 'editor', gate: false, threshold: 0, follow: true } },
    () => {},
  )
  const event = e => fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(e) + '\n')
  const file = path.join(cwd, 'a.js')
  const edit = text => {
    fs.writeFileSync(file, text)
    event({ type: 'edit', file })
    session.poll()
  }
  const reviewed = 'one\ntwo\nthree\n'
  edit(reviewed)
  session.markReviewed(file)
  assert.equal(session.reviewSnapshot(file), reviewed)

  edit('one\ntwo\nthree\nfour\n')
  const change = session.changes[0]
  assert.equal(change.reviewed, false)
  assert.equal(change.focusLine, 4, 'follow points at the new line, not old changes')

  const panel = new CodePanel(cwd, session)
  panel.open(file, { focusLine: change.focusLine })
  assert.equal(panel.isSinceReview(), true)
  assert.deepEqual(panel.diffStat, { added: 1, removed: 0 })
  assert.deepEqual([...(panel.diff?.added ?? [])], [4])
  session.markReviewed(file) // opening it counts as reviewing it...
  panel.reload()
  assert.equal(panel.isSinceReview(), true, '...but the view keeps the base it opened with')
  panel.key('v')
  assert.equal(panel.isSinceReview(), false, 'v shows all changes')
  assert.equal(panel.key('v'), null)
  assert.equal(panel.isSinceReview(), true)

  edit('one\ntwo\nthree\nfour\nfive\n')
  edit('one\ntwo\nthree\nfour\n')
  assert.equal(session.changes[0].reviewed, true, 'back to exactly what was reviewed')
  session.stop()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(cwd, { recursive: true, force: true })
})

test('summary on quit: unreviewed files, never opened, unsent notes; silent when nothing to say', async () => {
  const { summaryText } = await import('../src/summary.js')
  const change = (name, extra) => ({ file: `/r/${name}`, added: 2, removed: 1, edits: 1, reviewed: false, why: '', focusLine: 1, status: 'modified', ...extra })
  const text = summaryText({
    changes: [
      change('src/a.js', { reviewed: true }),
      change('src/db.js'),
      change('src/new.js', { status: 'new', added: 40, removed: 0 }),
      change('src/done.js', { added: 0, removed: 0 }),
    ],
    notes: [{ file: '/r/src/a.js', line: 3, code: 'x()', text: 'why?' }],
    shown: new Set(['/r/src/a.js', '/r/src/db.js']),
    cwd: '/r',
    isColor: false,
  })
  assert.equal(text, [
    'codeview · 3 files changed · 1 reviewed · 1 committed or reverted',
    '  Not reviewed:',
    '    M src/db.js   +2 −1',
    '    A src/new.js  +40 −0   never opened',
    '  1 review note was not sent:',
    '    src/a.js:3 `x()`: why?',
    '',
  ].join('\n'))
  assert.match(summaryText({ changes: [change('a.js', { reviewed: true })], notes: [], shown: new Set(), cwd: '/r', isColor: false }), /all reviewed ✓/)
  assert.equal(summaryText({ changes: [change('a.js', { added: 0, removed: 0 })], notes: [], shown: new Set(), cwd: '/r', isColor: false }), '')
})
