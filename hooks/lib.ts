// Pure helpers: no `$`, so the tests can call them directly.

/** Folders the tree never shows. */
export const IGNORED = new Set([
  '.git',
  'node_modules',
  '.DS_Store',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'Pods',
  'DerivedData',
  'coverage',
  'dist',
  'build',
  '.gradle',
  '.idea',
])

/** The tools whose calls change a file, and where each names the file. */
export function editedPath(tool: string, input: unknown): string | undefined {
  if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    return undefined
  }
  const fields = input as { file_path?: unknown; notebook_path?: unknown }
  const path = fields.file_path ?? fields.notebook_path

  return typeof path === 'string' && path.length > 0 ? path : undefined
}

export function absolute(cwd: string, path: string): string {
  return path.startsWith('/') ? path : `${cwd.replace(/\/$/, '')}/${path}`
}

export function relative(cwd: string, path: string): string {
  const root = cwd.replace(/\/$/, '') + '/'

  return path.startsWith(root) ? path.slice(root.length) : path
}

/** Lines added and removed in a unified diff, headers left out. */
export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }

  return { added, removed }
}

/** The diff from its first hunk on: what the Code element parses. */
export function hunksOnly(diff: string): string {
  const at = diff.search(/^@@ /m)

  return at < 0 ? '' : diff.slice(at).replace(/\n$/, '')
}

/** The new-side line where the first hunk's first change sits; 1 if none. */
export function firstChangedLine(diff: string): number {
  const lines = diff.split('\n')
  let line = 0
  let inHunk = false
  for (const text of lines) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (header) {
      line = Number(header[1])
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (text.startsWith('+') || text.startsWith('-')) return Math.max(1, line)
    if (text.startsWith(' ')) line += 1
  }

  return 1
}

/** True for a shell command that runs `git commit`. */
export function isGitCommit(command: string): boolean {
  return /(^|[;&|(\s])git(\s+-[^\s]+(\s+[^-\s][^\s]*)?)*\s+commit\b/.test(command)
}

/** Text the Code element accepts: tab and newline its only control characters. */
export function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')
}

/** The first sentence of what Claude said, for the "why" line. */
export function oneLine(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const sentence = /^(.+?[.!?:])(\s|$)/.exec(flat)?.[1] ?? flat

  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence
}

export type Parsed =
  | { kind: 'toggle' }
  | { kind: 'on' | 'off' | 'continue' | 'summary' | 'ask' | 'help' | 'diff' }
  | { kind: 'view'; view: 'tree' | 'file' | 'changes' }
  | { kind: 'gate'; isOn: boolean }
  | { kind: 'pause'; every: number }
  | { kind: 'unknown'; text: string }

export function parseArgs(args: string): Parsed {
  const [word = '', value = ''] = args.trim().toLowerCase().split(/\s+/)
  switch (word) {
    case '':
      return { kind: 'toggle' }
    case 'on':
    case 'off':
    case 'continue':
    case 'summary':
    case 'ask':
    case 'help':
    case 'diff':
      return { kind: word }
    case 'tree':
    case 'files':
      return { kind: 'view', view: 'tree' }
    case 'file':
      return { kind: 'view', view: 'file' }
    case 'changes':
      return { kind: 'view', view: 'changes' }
    case 'gate':
      if (value === 'on' || value === 'off') {
        return { kind: 'gate', isOn: value === 'on' }
      }
      return { kind: 'unknown', text: args }
    case 'pause': {
      if (value === 'off' || value === '0') return { kind: 'pause', every: 0 }
      const every = Number(value)
      return Number.isInteger(every) && every > 0
        ? { kind: 'pause', every }
        : { kind: 'unknown', text: args }
    }
    default:
      return { kind: 'unknown', text: args }
  }
}

export const HELP = [
  'A read-only file tree and live diff viewer beside Claude.',
  '',
  '/codeview              switch between the viewer and the default view',
  '/codeview tree         show the folder tree',
  '/codeview changes      list the files changed this session',
  '/codeview diff         flip the open file between full text and its diff',
  '/codeview ask          ask Claude about the text you selected',
  '/codeview summary      what changed this session and what you reviewed',
  '/codeview off | on     turn codeview off or on (remembered across sessions)',
  '',
  'Optional, off by default:',
  '/codeview gate on|off  refuse `git commit` until every changed file is reviewed',
  '/codeview pause N|off  pause Claude after every N edited files',
  '/codeview continue     let Claude go on after a pause',
  '',
  'In the pane (ctrl+x tab to focus it): t tree · c changes · f file ·',
  'd diff · n/p next/previous change · r mark reviewed · a ask about this file',
].join('\n')
