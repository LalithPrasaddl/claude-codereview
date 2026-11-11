// What codeview prints after it closes: what Claude changed, what's still unreviewed,
// and any review notes that were never sent (they'd be lost otherwise).
import path from 'node:path'

import { fitLeft } from './width.js'

const STATUS = { modified: 'M', new: 'A', deleted: 'D' }

/**
 * @param {{ changes: import('./session.js').Change[], notes: import('./notes.js').Note[],
 *   shown: Set<string>, cwd: string, isColor: boolean }} s
 *   changes with stats as they are now; shown: files the code panel ever showed
 * @returns {string} '' when there is nothing to say
 */
export function summaryText({ changes, notes, shown, cwd, isColor }) {
  const c = (code, text) => (isColor ? `\x1b[${code}m${text}\x1b[0m` : text)
  const rel = file => path.relative(cwd, file) || file
  // No diff left: committed or put back, nothing to review.
  const live = changes.filter(ch => ch.added + ch.removed > 0)
  const settled = changes.length - live.length
  if (live.length === 0 && notes.length === 0) return ''

  const lines = []
  const open = live.filter(ch => !ch.reviewed)
  const counts = [`${live.length} file${live.length === 1 ? '' : 's'} changed`]
  if (live.length > 0) counts.push(open.length === 0 ? c('32', 'all reviewed ✓') : `${live.length - open.length} reviewed`)
  if (settled > 0) counts.push(c('2', `${settled} committed or reverted`))
  lines.push(`${c('1;38;5;209', 'codeview')} · ${counts.join(' · ')}`)

  if (open.length > 0) {
    lines.push(c('33', '  Not reviewed:'))
    const width = Math.min(48, Math.max(...open.map(ch => rel(ch.file).length)))
    for (const ch of open) {
      const mark = STATUS[ch.status] ?? 'M'
      const color = ch.status === 'new' ? '32' : ch.status === 'deleted' ? '31' : '33'
      const name = fitLeft(rel(ch.file), width).padEnd(width)
      const never = shown.has(ch.file) ? '' : `   ${c('2', 'never opened')}`
      lines.push(`    ${c(color, mark)} ${name}  ${c('32', `+${ch.added}`)} ${c('31', `−${ch.removed}`)}${never}`)
    }
  }

  if (notes.length > 0) {
    lines.push(c('33', `  ${notes.length} review note${notes.length === 1 ? ' was' : 's were'} not sent:`))
    for (const n of notes) {
      const where = `${rel(n.file)}${n.line === null ? ' (removed line)' : `:${n.line}`}`
      const code = n.code === '' ? '' : ` \`${n.code.length > 60 ? n.code.slice(0, 59) + '…' : n.code}\``
      lines.push(`    ${where}${c('2', code)}: ${n.text}`)
    }
  }
  return lines.join('\n') + '\n'
}
