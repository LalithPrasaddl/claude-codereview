import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  CodeviewChange,
  CodeviewCurrent,
  CodeviewSettings,
  CodeviewView,
} from '../types'
import {
  HELP,
  IGNORED,
  absolute,
  diffStats,
  editedPath,
  firstChangedLine,
  hunksOnly,
  isGitCommit,
  oneLine,
  parseArgs,
  printable,
  relative,
} from './lib'

type $ = EngineInterface

const PANE = 'codeview'
const TITLE = 'codeview'
const MAX_TREE_ROWS = 800
const MAX_FILE_LINES = 4000
const DEFAULTS: CodeviewSettings = { enabled: true, gate: false, threshold: 0 }

const view = atom({ plugin: 'codeview', key: 'view' } as const, 'tree' as CodeviewView, { shape: 'view-1' })
const expanded = atom({ plugin: 'codeview', key: 'expanded' } as const, [] as string[], { shape: 'expanded-1' })
const current = atom({ plugin: 'codeview', key: 'current' } as const, null as CodeviewCurrent | null, {
  shape: 'current-1',
})
const changes = atom({ plugin: 'codeview', key: 'changes' } as const, [] as CodeviewChange[], {
  shape: 'changes-1',
})
const settings = atom({ plugin: 'codeview', key: 'settings' } as const, DEFAULTS, { shape: 'settings-1' })
const allowance = atom({ plugin: 'codeview', key: 'allowance' } as const, 0)
const hidden = atom({ plugin: 'codeview', key: 'hidden' } as const, false)
const tick = atom({ plugin: 'codeview', key: 'tick' } as const, 0)

// Module memory: a reload starts these over, which only costs the session baseline.
let cwd = ''
let isGit = false
let lastNudged = 0
/** Each file's text before Claude first touched it; null when it did not exist. */
const baselines = new Map<string, string | null>()

async function root($: $): Promise<string> {
  if (cwd === '') cwd = await $.session.cwd()
  return cwd
}

async function saveSettings($: $, change: Partial<CodeviewSettings>) {
  const next = await update($, settings, now => ({ ...now, ...change }))
  await $.store.set('settings', next)
  return next
}

async function isPaneUp($: $): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

async function openPane($: $, focus: boolean) {
  await update($, hidden, () => false)
  return $.ui.open({ id: PANE, title: TITLE, columns: 90, backgroundColor: 'transparent', ...(focus ? { focus: true as const } : {}) })
}

async function refreshStatus($: $) {
  const list = await read($, changes)
  const { enabled } = await read($, settings)
  if (!enabled || list.length === 0) {
    $.ui.status(undefined)
    return
  }
  const done = list.filter(one => one.reviewed).length
  $.ui.status(`codeview ${done}/${list.length} reviewed`)
}

async function diffFor($: $, path: string): Promise<{ text: string; base: string }> {
  const dir = await root($)
  if (isGit) {
    const tracked = await $.process.run(
      ['git', 'ls-files', '--error-unmatch', '--', path],
      { cwd: dir },
    )
    if (tracked.exitCode !== 0) {
      const added = await $.process.run(
        ['git', 'diff', '--no-index', '--no-color', '--', '/dev/null', path],
        { cwd: dir },
      )
      return { text: added.stdout, base: 'git (new file)' }
    }
    const head = await $.process.run(
      ['git', 'diff', '--no-color', '--no-ext-diff', 'HEAD', '--', path],
      { cwd: dir },
    )
    if (head.exitCode === 0) return { text: head.stdout, base: 'git HEAD' }
    const index = await $.process.run(
      ['git', 'diff', '--no-color', '--no-ext-diff', '--', path],
      { cwd: dir },
    )
    return { text: index.stdout, base: 'git index' }
  }
  if (!baselines.has(path)) return { text: '', base: 'none' }
  const before = baselines.get(path)
  const ran =
    before === null || before === undefined
      ? await $.process.run(['diff', '-u', '/dev/null', path], { cwd: dir })
      : await $.process.run(['diff', '-u', '-', path], { cwd: dir, stdin: before })
  return { text: ran.stdout, base: 'start of session' }
}

async function lastWhy($: $): Promise<string> {
  try {
    const found = await $.session.messages()
    if (!Array.isArray(found)) return ''
    for (let i = found.length - 1; i >= 0; i -= 1) {
      const message = found[i]
      if (message?.role === 'assistant' && message.text.trim() !== '') {
        return oneLine(message.text)
      }
    }
  } catch {
    // No transcript to read: leave the line out.
  }
  return ''
}

/** Open a file in the viewer because the person asked: that counts as reviewing it. */
async function show($: $, path: string, showDiff: boolean) {
  const list = await read($, changes)
  const change = list.find(one => one.path === path)
  let focusLine = 1
  if (change !== undefined) {
    focusLine = firstChangedLine((await diffFor($, path)).text)
    await update($, changes, all =>
      all.map(one => (one.path === path ? { ...one, reviewed: true } : one)),
    )
  }
  await update($, current, () => ({ path, showDiff, focusLine }))
  await update($, view, () => 'file')
  await refreshStatus($)
  void $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)
}

async function step($: $, by: 1 | -1) {
  const list = await read($, changes)
  if (list.length === 0) return
  const now = await read($, current)
  const at = list.findIndex(one => one.path === now?.path)
  const next = list[(at + by + list.length) % list.length]
  if (next !== undefined) await show($, next.path, now?.showDiff ?? true)
}

async function toggleReviewed($: $) {
  const now = await read($, current)
  if (now === null) return
  await update($, changes, all =>
    all.map(one => (one.path === now.path ? { ...one, reviewed: !one.reviewed } : one)),
  )
  await refreshStatus($)
}

async function askAbout($: $) {
  const now = await read($, current)
  if (now === null) return
  const name = relative(await root($), now.path)
  await $.prompt.fill({ text: `About your change to ${name}: `, mode: 'replace' })
}

async function summary($: $): Promise<string> {
  const dir = await root($)
  const list = await read($, changes)
  if (list.length === 0) return 'codeview: no files changed this session yet.'
  const added = list.reduce((sum, one) => sum + one.added, 0)
  const removed = list.reduce((sum, one) => sum + one.removed, 0)
  const done = list.filter(one => one.reviewed).length
  const rows = list.map(
    one =>
      `${one.reviewed ? '✓' : '○'} ${relative(dir, one.path)}  +${one.added} −${one.removed}` +
      (one.why === '' ? '' : `\n    ${one.why}`),
  )
  return [
    `codeview: ${list.length} files changed (+${added} −${removed}), ${done} reviewed.`,
    '',
    ...rows,
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    const stored = (await $.store.get('settings')) as Partial<CodeviewSettings> | undefined
    const loaded = { ...DEFAULTS, ...(stored ?? {}) }
    await update($, settings, () => loaded)
    await update($, allowance, () => loaded.threshold)
    const probe = await $.process.run(['git', 'rev-parse', '--is-inside-work-tree'], {
      cwd: e.cwd,
    })
    isGit = probe.exitCode === 0 && probe.stdout.trim() === 'true'
    await $.command.register({
      name: 'codeview',
      description: 'Read-only file tree and live diff viewer beside Claude',
      argumentHint: '[tree|changes|diff|ask|summary|on|off|gate on|off|pause N|off|continue|help]',
    })
    if (loaded.enabled && e.isInteractive && !(await read($, hidden))) {
      void $.ui.open({ id: PANE, title: TITLE, columns: 90, backgroundColor: 'transparent' }).catch(() => undefined)
    }
    await refreshStatus($)
    return next(e)
  })

  on('command.run', { command: 'codeview' }, async ($, e) => {
    const parsed = parseArgs(e.args)
    const now = await read($, settings)

    if (parsed.kind === 'help') return { text: HELP }
    if (parsed.kind === 'on') {
      await saveSettings($, { enabled: true })
      await openPane($, true)
      await refreshStatus($)
      return { text: 'codeview is on.' }
    }
    if (parsed.kind === 'off') {
      await saveSettings($, { enabled: false })
      await $.ui.close({ id: PANE })
      $.ui.status(undefined)
      return { text: 'codeview is off, and stays off in new sessions. /codeview on brings it back.' }
    }
    if (!now.enabled) return { text: 'codeview is off. /codeview on turns it on.' }

    switch (parsed.kind) {
      case 'toggle':
        if (await isPaneUp($)) {
          await update($, hidden, () => true)
          await $.ui.close({ id: PANE })
          return { text: 'Back to the default view. /codeview brings the viewer back.' }
        }
        await openPane($, true)
        return { text: 'codeview opened. ctrl+x tab moves between it and the prompt.' }
      case 'view':
        await update($, view, () => parsed.view)
        await openPane($, true)
        return { text: `codeview: ${parsed.view}.` }
      case 'diff': {
        const file = await update($, current, one => (one === null ? one : { ...one, showDiff: !one.showDiff }))
        await update($, view, () => 'file')
        await openPane($, true)
        return { text: file === null ? 'No file open yet.' : `codeview: ${file.showDiff ? 'diff' : 'full file'}.` }
      }
      case 'gate': {
        await saveSettings($, { gate: parsed.isOn })
        return {
          text: parsed.isOn
            ? 'Review gate on: `git commit` is refused while a changed file is unreviewed.'
            : 'Review gate off.',
        }
      }
      case 'pause': {
        await saveSettings($, { threshold: parsed.every })
        const count = (await read($, changes)).length
        await update($, allowance, () => count + parsed.every)
        return {
          text:
            parsed.every === 0
              ? 'Pause off.'
              : `Claude will pause for your review after every ${parsed.every} edited files.`,
        }
      }
      case 'continue': {
        const count = (await read($, changes)).length
        await update($, allowance, () => count + Math.max(1, now.threshold))
        return { text: 'Claude may go on editing.' }
      }
      case 'summary':
        return { text: await summary($) }
      case 'ask': {
        const selected = await $.ui.selection()
        const file = await read($, current)
        const name = file === null ? 'this code' : relative(await root($), file.path)
        if (selected === undefined) {
          await askAbout($)
          return { text: 'Nothing selected: asking about the open file.' }
        }
        const quoted = selected.text.replace(/^/gm, '> ')
        await $.prompt.fill({ text: `In ${name}, why did you change this?\n${quoted}\n\n`, mode: 'replace' })
        return { text: 'Question ready in the prompt.' }
      }
      case 'unknown':
        return { text: `codeview: unknown option "${parsed.text}".\n\n${HELP}` }
    }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await update($, hidden, () => true)
    return next(e)
  })

  // Follow every file Claude writes: open it, scroll to the edit, record it.
  on('tool.call', async ($, e, next) => {
    const named = editedPath(String(e.tool), e)
    const opts = await read($, settings)
    if (named === undefined || !opts.enabled) return next(e)

    const dir = await root($)
    const path = absolute(dir, named)
    const before = await read($, changes)
    const isNew = !before.some(one => one.path === path)

    if (opts.threshold > 0 && isNew && before.length >= (await read($, allowance))) {
      return {
        deny:
          `codeview: ${before.length} files edited this session, and the person asked to pause ` +
          `every ${opts.threshold} files to review. Stop here, summarize what you changed and why, ` +
          'and ask them to review it in the codeview pane. They continue with /codeview continue.',
      }
    }

    if (!baselines.has(path)) {
      try {
        baselines.set(path, await $.fs.read(path))
      } catch {
        baselines.set(path, null)
      }
    }

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    try {
      const diff = (await diffFor($, path)).text
      const { added, removed } = diffStats(diff)
      const why = await lastWhy($)
      await update($, changes, all => {
        const found = all.find(one => one.path === path)
        return found === undefined
          ? [...all, { path, added, removed, edits: 1, reviewed: false, why }]
          : all.map(one =>
              one.path === path
                ? { ...one, added, removed, edits: one.edits + 1, reviewed: false, why: why || one.why }
                : one,
            )
      })
      await update($, current, one => ({
        path,
        showDiff: one?.showDiff ?? false,
        focusLine: firstChangedLine(diff),
      }))
      await update($, view, () => 'file')
      await update($, tick, n => n + 1)
      await refreshStatus($)
      if (!(await read($, hidden)) && !(await isPaneUp($))) {
        void $.ui.open({ id: PANE, title: TITLE, columns: 90, backgroundColor: 'transparent' }).catch(() => undefined)
      }
      $.clock.after(120, () => {
        void $.ui.scroll({ in: PANE, to: { key: 'focus' }, block: 'start' }).catch(() => undefined)
      })
    } catch {
      // The viewer is a convenience: never fail Claude's edit over it.
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Optional review gate: off unless the person turned it on.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const opts = await read($, settings)
    if (!opts.enabled || !opts.gate || !isGitCommit(e.command)) return next(e)
    const dir = await root($)
    const open = (await read($, changes)).filter(one => !one.reviewed)
    if (open.length === 0) return next(e)
    const names = open.slice(0, 8).map(one => relative(dir, one.path)).join(', ')
    return {
      deny:
        `codeview review gate: ${open.length} changed file(s) not reviewed yet: ${names}. ` +
        'Ask the person to review them in the codeview pane (/codeview changes) before committing, ' +
        'or they can run /codeview gate off.',
    }
  }).catch(($, e, next) => next(e))

  // A gentle nudge when a turn leaves unreviewed changes behind.
  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if ('agentId' in e && e.agentId !== undefined) return ran
    const opts = await read($, settings)
    const open = (await read($, changes)).filter(one => !one.reviewed).length
    if (opts.enabled && open > lastNudged) {
      $.ui.toast(`codeview: ${open} changed file${open === 1 ? '' : 's'} to look at (/codeview changes)`)
    }
    lastNudged = open
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const dir = await root($)
    const mode = await read($, view)
    const list = await read($, changes)
    const file = await read($, current)
    const open = await read($, expanded)
    await read($, tick)
    const width = e.props.bodyColumns
    const done = list.filter(one => one.reviewed).length
    const changed = new Set(list.map(one => one.path))

    const tabs = (
      <Box flexDirection="row" gap={1}>
        <Button key="tab:tree" plain hotkey="t" dimColor={mode !== 'tree'} onPress={() => update($, view, () => 'tree')}>
          Tree
        </Button>
        <Button key="tab:file" plain hotkey="f" dimColor={mode !== 'file'} onPress={() => update($, view, () => 'file')}>
          File
        </Button>
        <Button key="tab:changes" plain hotkey="c" dimColor={mode !== 'changes'} onPress={() => update($, view, () => 'changes')}>
          Changes
        </Button>
        <Text dimColor>{list.length === 0 ? '· read-only' : `· ${done}/${list.length} reviewed`}</Text>
      </Box>
    )

    if (mode === 'tree') {
      type Row = { path: string; name: string; depth: number; isDir: boolean }
      const rows: Row[] = []
      const walk = async (folder: string, depth: number): Promise<void> => {
        let entries
        try {
          entries = await $.fs.list(folder)
        } catch {
          return
        }
        const shown = entries
          .filter(one => !IGNORED.has(one.name))
          .sort((a, b) =>
            a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
          )
        for (const entry of shown) {
          if (rows.length >= MAX_TREE_ROWS) return
          const path = `${folder.replace(/\/$/, '')}/${entry.name}`
          const isDir = entry.kind === 'dir'
          rows.push({ path, name: entry.name, depth, isDir })
          if (isDir && open.includes(path)) await walk(path, depth + 1)
        }
      }
      await walk(dir, 0)
      const touchedDirs = new Set<string>()
      for (const path of changed) {
        let at = path.lastIndexOf('/')
        while (at > dir.length) {
          touchedDirs.add(path.slice(0, at))
          at = path.lastIndexOf('/', at - 1)
        }
      }

      return (
        <Box flexDirection="column" width={width}>
          {tabs}
          <Text dimColor>{dir.split('/').pop()}/</Text>
          {rows.map(row => (
            <Button
              key={`tree:${row.path}`}
              plain
              onPress={() =>
                row.isDir
                  ? update($, expanded, all =>
                      all.includes(row.path) ? all.filter(one => one !== row.path) : [...all, row.path],
                    )
                  : show($, row.path, false)
              }
            >
              {'  '.repeat(row.depth)}
              {row.isDir ? (open.includes(row.path) ? '▾ ' : '▸ ') : '  '}
              {row.name}
              {row.isDir ? '/' : ''}
              {changed.has(row.path) || touchedDirs.has(row.path) ? <Text color="warning"> ●</Text> : ''}
            </Button>
          ))}
          {rows.length >= MAX_TREE_ROWS && <Text dimColor>… more entries not shown</Text>}
        </Box>
      )
    }

    if (mode === 'changes') {
      const added = list.reduce((sum, one) => sum + one.added, 0)
      const removed = list.reduce((sum, one) => sum + one.removed, 0)
      const opts = await read($, settings)
      return (
        <Box flexDirection="column" width={width}>
          {tabs}
          <Text>
            {list.length} file{list.length === 1 ? '' : 's'} changed this session{' '}
            <Text color="success">+{added}</Text> <Text color="error">−{removed}</Text>
          </Text>
          <Text dimColor>
            gate {opts.gate ? 'on' : 'off'} · pause {opts.threshold === 0 ? 'off' : `every ${opts.threshold}`} · n/p step through
          </Text>
          {list.length === 0 && <Text dimColor>Nothing yet. Files Claude edits show up here.</Text>}
          {list.map(one => (
            <Box key={`chg:${one.path}`} flexDirection="column">
              <Button key={`change:${one.path}`} plain onPress={() => show($, one.path, true)}>
                <Text color={one.reviewed ? 'success' : 'warning'}>{one.reviewed ? '✓ ' : '○ '}</Text>
                {relative(dir, one.path)} <Text color="success">+{one.added}</Text>{' '}
                <Text color="error">−{one.removed}</Text>
              </Button>
              {one.why !== '' && <Text dimColor italic>{`    ${one.why}`}</Text>}
            </Box>
          ))}
          <Box flexDirection="row" gap={1}>
            <Button key="nav:next" plain hotkey="n" dimColor onPress={() => step($, 1)}>next</Button>
            <Button key="nav:prev" plain hotkey="p" dimColor onPress={() => step($, -1)}>previous</Button>
          </Box>
        </Box>
      )
    }

    // File view.
    if (file === null) {
      return (
        <Box flexDirection="column" width={width}>
          {tabs}
          <Text dimColor>No file open. Pick one in the tree, or wait for Claude's next edit.</Text>
        </Box>
      )
    }

    const change = list.find(one => one.path === file.path)
    const toolbar = (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Button key="act:diff" plain hotkey="d" onPress={() => update($, current, one => (one === null ? one : { ...one, showDiff: !one.showDiff }))}>
          {file.showDiff ? 'full file' : 'diff'}
        </Button>
        <Button key="act:next" plain hotkey="n" dimColor onPress={() => step($, 1)}>next</Button>
        <Button key="act:prev" plain hotkey="p" dimColor onPress={() => step($, -1)}>prev</Button>
        {change !== undefined && (
          <Button key="act:reviewed" plain hotkey="r" dimColor onPress={() => toggleReviewed($)}>
            {change.reviewed ? 'reviewed ✓' : 'mark reviewed'}
          </Button>
        )}
        <Button key="act:ask" plain hotkey="a" dimColor onPress={() => askAbout($)}>ask</Button>
      </Box>
    )
    const heading = (
      <Box flexDirection="column">
        <Text bold>
          {relative(dir, file.path)}
          {change !== undefined && (
            <Text>
              {' '}
              <Text color="success">+{change.added}</Text> <Text color="error">−{change.removed}</Text>
            </Text>
          )}
        </Text>
        {change !== undefined && change.why !== '' && <Text dimColor italic>{change.why}</Text>}
      </Box>
    )

    if (file.showDiff) {
      const { text, base } = await diffFor($, file.path)
      const hunks = hunksOnly(printable(text))
      return (
        <Box flexDirection="column" width={width}>
          {tabs}
          {heading}
          {toolbar}
          <Text dimColor>diff against {base}</Text>
          {hunks === '' ? (
            <Text dimColor>{base === 'none' ? 'Not a git repo, and Claude has not edited this file this session.' : 'No changes.'}</Text>
          ) : (
            <Code source={hunks} path={file.path} format="diff" />
          )}
        </Box>
      )
    }

    let body: string
    try {
      body = await $.fs.read(file.path)
    } catch {
      return (
        <Box flexDirection="column" width={width}>
          {tabs}
          {heading}
          {toolbar}
          <Text color="warning">This file can't be read (deleted, or over 4 MB).</Text>
        </Box>
      )
    }
    if (body.includes('\u0000')) {
      return (
        <Box flexDirection="column" width={width}>
          {tabs}
          {heading}
          {toolbar}
          <Text dimColor>Binary file.</Text>
        </Box>
      )
    }
    const lines = printable(body).split('\n')
    const isCut = lines.length > MAX_FILE_LINES
    const kept = lines.slice(0, MAX_FILE_LINES)
    const focus = Math.min(Math.max(1, file.focusLine), Math.max(1, kept.length))
    const above = kept.slice(0, focus - 1).join('\n')
    const below = kept.slice(focus - 1).join('\n')

    return (
      <Box flexDirection="column" width={width}>
        {tabs}
        {heading}
        {toolbar}
        {above !== '' && <Code source={above} path={file.path} startLine={1} />}
        <Box key="focus" flexDirection="column">
          <Code source={below === '' ? ' ' : below} path={file.path} startLine={focus} />
        </Box>
        {isCut && <Text dimColor>… {lines.length - MAX_FILE_LINES} more lines not shown</Text>}
      </Box>
    )
  })
}
