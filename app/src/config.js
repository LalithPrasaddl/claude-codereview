// Settings kept across sessions in ~/.config/codeview/config.json.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * @typedef {{ enabled: boolean, layout: 'editor' | 'stacked', gate: boolean,
 *   threshold: number, follow: boolean, tint: 'auto' | 'dark' | 'light' | 'off' }} Config
 */

/** @type {Config} */
export const DEFAULTS = { enabled: true, layout: 'editor', gate: false, threshold: 0, follow: true, tint: 'auto' }

export function configPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'codeview', 'config.json')
}

/** @returns {Config} */
export function loadConfig() {
  try {
    const stored = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    const merged = { ...DEFAULTS, ...stored }
    if (merged.layout !== 'editor' && merged.layout !== 'stacked') merged.layout = 'editor'
    if (!['auto', 'dark', 'light', 'off'].includes(merged.tint)) merged.tint = 'auto'
    return merged
  } catch {
    return { ...DEFAULTS }
  }
}

/** @param {Partial<Config>} change */
export function saveConfig(change) {
  const next = { ...loadConfig(), ...change }
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true })
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n')
  } catch {
    // Not fatal: the setting just isn't remembered.
  }
  return next
}
