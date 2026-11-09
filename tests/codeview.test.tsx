import { expect, test } from 'claude-code/testing'

import { diffStats, firstChangedLine, isGitCommit, parseArgs } from '../hooks/lib'

const DIFF = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -3,4 +3,5 @@',
  ' one',
  ' two',
  '-three',
  '+THREE',
  '+four',
  ' five',
].join('\n')

const FILE = 'const a = 1\nconst b = 2\n'

const pane = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'codeview',
    component: 'Pane',
    requestId: 'codeview',
    surface,
    props: {
      title: 'codeview',
      isFocused: false,
      bodyColumns: 60,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  }) as const

/** Stand in for the engine: a git repo whose diff is DIFF, a file whose text is FILE. */
function engine(on: Parameters<Parameters<typeof test>[1]>[1]) {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'codeview' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.scroll', () => ({ value: {} }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('fs.read', () => ({ value: FILE }))
  on('fs.list', () => ({
    value: [
      { name: 'src', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
      { name: 'a.ts', kind: 'file', size: 10, mtimeMs: 0, isLink: false },
      { name: 'node_modules', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
    ],
  }))
  on('session.messages', () => ({
    value: [{ role: 'assistant', text: 'Rename three to THREE. Then more.', toolUses: [] }],
  }))
  on('process.run', (_, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    const stdout = argv[0] === 'git' && argv[1] === 'rev-parse' ? 'true\n' : argv[1] === 'diff' ? DIFF : ''
    return {
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))
}

test('helpers read diffs and commands', async () => {
  expect(diffStats(DIFF)).toEqual({ added: 2, removed: 1 })
  expect(firstChangedLine(DIFF)).toBe(5)
  expect(isGitCommit('git commit -m "x"')).toBe(true)
  expect(isGitCommit('npm test && git -C repo commit -am x')).toBe(true)
  expect(isGitCommit('git status')).toBe(false)
  expect(isGitCommit('echo commit')).toBe(false)
  expect(parseArgs('')).toEqual({ kind: 'toggle' })
  expect(parseArgs('pause 5')).toEqual({ kind: 'pause', every: 5 })
  expect(parseArgs('gate on')).toEqual({ kind: 'gate', isOn: true })
})

test('the tree lists files and hides node_modules', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(pane(surface))
    expect((await ui.find({ type: 'Button', key: 'tree:/repo/a.ts' })) !== undefined).toBe(true)
    expect(await ui.find({ type: 'Button', key: 'tree:/repo/node_modules' })).toBe(undefined)
    await ui.unmount()
  }
})

test("an edit opens the file and lists it as an unreviewed change", async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(pane(surface))
    await ui.press({ key: 'tab:file' })
    const title = await ui.find({ type: 'Text', text: /a\.ts/ })
    expect(title?.text).toContain('a.ts')
    expect((await ui.find({ type: 'Text', text: /Rename three/ })) !== undefined).toBe(true)
    await ui.press({ key: 'tab:changes' })
    expect((await ui.find({ type: 'Button', key: 'change:/repo/a.ts' })) !== undefined).toBe(true)
    await ui.unmount()
  }
})

test('the review gate is off by default and refuses an unreviewed commit when on', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' })

  const before = await $.tool.call({ tool: 'Bash', command: 'git commit -m wip' })
  expect('deny' in before && before.deny !== undefined).toBe(false)

  await $.command.run({ command: 'codeview', args: 'gate on' })
  const gated = await $.tool.call({ tool: 'Bash', command: 'git commit -m wip' })
  expect(String((gated as { deny?: string }).deny)).toContain('review gate')
})

test('pause N stops Claude after N files until /codeview continue', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'codeview', args: 'pause 1' })

  await $.tool.call({ tool: 'Write', file_path: '/repo/one.ts', content: 'a' })
  const second = await $.tool.call({ tool: 'Write', file_path: '/repo/two.ts', content: 'b' })
  expect(String((second as { deny?: string }).deny)).toContain('pause')

  await $.command.run({ command: 'codeview', args: 'continue' })
  const again = await $.tool.call({ tool: 'Write', file_path: '/repo/two.ts', content: 'b' })
  expect((again as { deny?: string }).deny).toBe(undefined)
})
