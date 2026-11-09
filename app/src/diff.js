// Diffs (git, or against the file as it was before Claude touched it) and their numbers.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function diffStats(diff) {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return { added, removed }
}

/** The diff from its first hunk on. */
export function hunksOnly(diff) {
  const at = diff.search(/^@@ /m)
  return at < 0 ? '' : diff.slice(at).replace(/\n$/, '')
}

/** New-side line numbers that were added or changed, and lines after which something was removed. */
export function changedLines(diff) {
  const added = new Set()
  const removedAfter = new Set()
  let line = 0
  let inHunk = false
  for (const text of diff.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (header) {
      line = Number(header[1])
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (text.startsWith('+')) {
      added.add(line)
      line += 1
    } else if (text.startsWith('-')) {
      removedAfter.add(Math.max(0, line - 1))
    } else if (text.startsWith(' ')) {
      line += 1
    }
  }
  return { added, removedAfter }
}

export function firstChangedLine(diff) {
  const { added, removedAfter } = changedLines(diff)
  const all = [...added, ...[...removedAfter].map(n => n + 1)]
  return all.length === 0 ? 1 : Math.max(1, Math.min(...all))
}

/** True for a shell command that runs `git commit`. */
export function isGitCommit(command) {
  return /(^|[;&|(\s])git(\s+-[^\s]+(\s+[^-\s][^\s]*)?)*\s+commit\b/.test(command)
}

export function baselinePath(sessionDir, file) {
  const key = crypto.createHash('sha1').update(file).digest('hex')
  return path.join(sessionDir, 'baseline', key)
}

function run(cmd, args, cwd, input) {
  const r = spawnSync(cmd, args, { cwd, input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return { code: r.status ?? 1, out: r.stdout ?? '' }
}

export function isGitRepo(cwd) {
  return run('git', ['rev-parse', '--is-inside-work-tree'], cwd).out.trim() === 'true'
}

/**
 * The diff for one file: against HEAD in a git repo, else against the
 * baseline the hook saved when Claude first touched it.
 * @returns {{ text: string, base: string }}
 */
export function diffFor(file, { cwd, isGit, sessionDir }) {
  if (isGit) {
    const tracked = run('git', ['ls-files', '--error-unmatch', '--', file], cwd)
    if (tracked.code !== 0) {
      if (!fs.existsSync(file)) return { text: '', base: 'git' }
      return { text: run('git', ['diff', '--no-index', '--no-color', '--', '/dev/null', file], cwd).out, base: 'git (new file)' }
    }
    const head = run('git', ['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', file], cwd)
    if (head.code === 0) return { text: head.out, base: 'git HEAD' }
    return { text: run('git', ['diff', '--no-color', '--no-ext-diff', '--', file], cwd).out, base: 'git index' }
  }
  const saved = baselinePath(sessionDir, file)
  if (fs.existsSync(saved)) {
    return { text: run('diff', ['-u', saved, file], cwd).out, base: 'start of session' }
  }
  if (fs.existsSync(saved + '.none')) {
    return { text: run('diff', ['-u', '/dev/null', file], cwd).out, base: 'start of session (new file)' }
  }
  return { text: '', base: 'none' }
}
