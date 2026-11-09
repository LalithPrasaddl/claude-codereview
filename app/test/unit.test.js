import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { changedLines, diffStats, firstChangedLine, hunksOnly, isGitCommit } from '../src/diff.js'
import { highlightLines, languageFor } from '../src/highlight.js'
import { InputParser } from '../src/input.js'
import { computeLayout, panelAt } from '../src/layout.js'
import { Screen } from '../src/screen.js'
import { oneLine } from '../src/session.js'
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
