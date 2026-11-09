#!/usr/bin/env node
// Claude Code runs this as a PreToolUse / PostToolUse hook inside a codeview session.
//   pre:  saves the file's text before Claude's first edit, and applies the optional
//         review gate and pause (exit 2 refuses the tool call, stderr tells Claude why).
//   post: records the edit in events.jsonl, which the app watches.
import fs from 'node:fs'
import path from 'node:path'

import { baselinePath, isGitCommit } from './diff.js'

const phase = process.argv[2]
const dir = process.env.CODEVIEW_DIR

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'))
  } catch {
    return null
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))
  } catch {
    return { gate: false, threshold: 0, allowance: 0, reviewed: [] }
  }
}

function changedFiles() {
  try {
    const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n')
    const files = new Set()
    for (const line of lines) {
      if (line.trim() === '') continue
      try {
        const event = JSON.parse(line)
        if (event.type === 'edit' && typeof event.file === 'string') files.add(event.file)
      } catch {
        // A line cut short by a crash: skip it.
      }
    }
    return files
  } catch {
    return new Set()
  }
}

function refuse(message) {
  process.stderr.write(message + '\n')
  process.exit(2)
}

function main() {
  if (!dir) return
  const input = readStdin()
  if (input === null) return
  if (phase === 'turn-start' || phase === 'turn-end') {
    // Claude's turn begins (prompt sent) or ends (Stop): files changing in between are Claude's.
    const mark = { type: phase, at: Date.now(), transcript: input.transcript_path ?? null }
    fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(mark) + '\n')
    return
  }
  if (phase !== 'pre' && phase !== 'post') return
  const tool = String(input.tool_name ?? '')
  const toolInput = input.tool_input ?? {}
  const cwd = String(input.cwd ?? process.cwd())

  if (tool === 'Bash') {
    // A shell command can change files too: the app counts files that change on
    // disk between these two marks as Claude's.
    const mark = { type: phase === 'pre' ? 'tool-start' : 'tool-end', id: input.tool_use_id ?? null, at: Date.now(), transcript: input.transcript_path ?? null }
    if (phase === 'post') {
      fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(mark) + '\n')
      return
    }
    const state = readState()
    if (state.gate && isGitCommit(String(toolInput.command ?? ''))) {
      const reviewed = new Set(state.reviewed ?? [])
      const open = [...changedFiles()].filter(file => !reviewed.has(file))
      if (open.length > 0) {
        const names = open.slice(0, 8).map(file => path.relative(cwd, file) || file).join(', ')
        refuse(
          `codeview review gate: ${open.length} changed file(s) not reviewed yet: ${names}. ` +
            'Ask the person to review them in the codeview window before committing. ' +
            'They can turn the gate off with ctrl+\\ g.',
        )
      }
    }
    fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(mark) + '\n')
    return
  }

  const named = toolInput.file_path ?? toolInput.notebook_path
  if (typeof named !== 'string' || named === '') return
  const file = path.resolve(cwd, named)

  if (phase === 'pre') {
    const state = readState()
    const changed = changedFiles()
    if (state.threshold > 0 && !changed.has(file) && changed.size >= (state.allowance ?? state.threshold)) {
      refuse(
        `codeview: ${changed.size} files edited this session, and the person asked to pause every ` +
          `${state.threshold} files to review. Stop here, summarize what you changed and why, and ask ` +
          'them to review it in the codeview window. They let you continue with ctrl+\\ space.',
      )
    }
    const saved = baselinePath(dir, file)
    if (!fs.existsSync(saved) && !fs.existsSync(saved + '.none')) {
      fs.mkdirSync(path.dirname(saved), { recursive: true })
      try {
        fs.copyFileSync(file, saved)
      } catch {
        fs.writeFileSync(saved + '.none', '')
      }
    }
    return
  }

  const event = { type: 'edit', tool, file, transcript: input.transcript_path ?? null, at: Date.now() }
  fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(event) + '\n')
}

try {
  main()
} catch {
  // Never get in Claude's way over the viewer.
}
