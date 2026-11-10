// Command line: codeview [--layout editor|stacked] [on|off|help] [claude args...]
import { spawnSync } from 'node:child_process'

import { configPath, loadConfig, saveConfig } from './config.js'

const USAGE = `codeview: Claude Code with a read-only file tree and live code/diff viewer, full screen.

Usage:
  codeview [claude options]      start (options like --resume or -c go to claude)
  codeview --layout stacked      start with Claude below the tree and code
  codeview off                   make codeview run plain claude (remembered)
  codeview on                    turn the viewer back on
  codeview help                  this text

Inside: press ctrl+\\ then ? for all keys.
Settings: ${configPath()}`

export async function main(argv) {
  const first = argv[0]
  if (first === 'help' || first === '--help' || first === '-h') {
    console.log(USAGE)
    return
  }
  if (first === 'on' || first === 'off') {
    saveConfig({ enabled: first === 'on' })
    console.log(first === 'on' ? 'codeview is on.' : 'codeview is off: `codeview` now runs plain claude. `codeview on` turns it back on.')
    return
  }

  const config = loadConfig()
  const claudeArgs = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--layout' && (argv[i + 1] === 'editor' || argv[i + 1] === 'stacked')) {
      config.layout = argv[i + 1]
      i += 1
    } else if (arg === '--') {
      claudeArgs.push(...argv.slice(i + 1))
      break
    } else {
      claudeArgs.push(arg)
    }
  }

  const probe = spawnSync('claude', ['--version'], { encoding: 'utf8' })
  if (probe.error) {
    console.error('codeview needs Claude Code on your PATH: https://claude.com/claude-code')
    process.exit(1)
  }

  if (!config.enabled || !process.stdin.isTTY || !process.stdout.isTTY) {
    const r = spawnSync('claude', claudeArgs, { stdio: 'inherit' })
    process.exit(r.status ?? 0)
  }

  const { App } = await import('./app.js')
  const { resolveTint } = await import('./tint.js')
  const { tint, leftover } = await resolveTint(config.tint)
  new App({ cwd: process.cwd(), claudeArgs, config, tint }).start(leftover)
}
