// node-pty's prebuilt spawn-helper is sometimes unpacked without its execute bit,
// which makes every spawn fail with "posix_spawnp failed". Runs at install and at start.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

export function fixSpawnHelper() {
  try {
    const root = path.dirname(require.resolve('node-pty/package.json'))
    for (const sub of ['prebuilds', 'build/Release']) {
      const base = path.join(root, sub)
      if (!fs.existsSync(base)) continue
      const dirs = sub === 'prebuilds' ? fs.readdirSync(base).map(d => path.join(base, d)) : [base]
      for (const d of dirs) {
        const helper = path.join(d, 'spawn-helper')
        if (fs.existsSync(helper) && (fs.statSync(helper).mode & 0o111) === 0) fs.chmodSync(helper, 0o755)
      }
    }
  } catch {
    // If this fails, spawning reports the real error.
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) fixSpawnHelper()
