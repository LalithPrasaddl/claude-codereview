// Split raw terminal input into keys, mouse events and pastes.

/**
 * @typedef {{ type: 'key', raw: string, name: string }} KeyEvent
 * @typedef {{ type: 'mouse', raw: string, button: number, x: number, y: number,
 *   isRelease: boolean, isWheel: boolean, isDrag: boolean }} MouseEvent
 * @typedef {{ type: 'paste', raw: string }} PasteEvent
 * @typedef {KeyEvent | MouseEvent | PasteEvent} InputEvent
 */

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

const CSI_NAMES = {
  A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'shift-tab',
}
const TILDE_NAMES = { 1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end' }

function keyName(raw) {
  if (raw === '\r' || raw === '\n') return 'enter'
  if (raw === '\t') return 'tab'
  if (raw === '\x1b') return 'escape'
  if (raw === '\x7f' || raw === '\b') return 'backspace'
  if (raw === ' ') return 'space'
  if (raw.length === 1) {
    const code = raw.charCodeAt(0)
    if (code === 0x1c) return 'ctrl-\\'
    if (code > 0 && code < 27) return 'ctrl-' + String.fromCharCode(code + 96)
    return raw
  }
  let m = /^\x1b\[(?:1;\d+)?([A-HZF])$/.exec(raw) ?? /^\x1bO([A-HF])$/.exec(raw)
  if (m) return CSI_NAMES[m[1]] ?? raw
  m = /^\x1b\[(\d+)(?:;\d+)?~$/.exec(raw)
  if (m) return TILDE_NAMES[m[1]] ?? raw
  if (raw.length === 2 && raw[0] === '\x1b') return 'alt-' + raw[1]
  return raw
}

/** Keeps a partial paste between chunks. */
export class InputParser {
  constructor() {
    this.pasting = null
  }

  /** @returns {InputEvent[]} */
  feed(data) {
    /** @type {InputEvent[]} */
    const events = []
    let s = data
    if (this.pasting !== null) {
      const end = s.indexOf(PASTE_END)
      if (end < 0) {
        this.pasting += s
        return events
      }
      events.push({ type: 'paste', raw: this.pasting + s.slice(0, end + PASTE_END.length) })
      this.pasting = null
      s = s.slice(end + PASTE_END.length)
    }
    let i = 0
    while (i < s.length) {
      if (s.startsWith(PASTE_START, i)) {
        const end = s.indexOf(PASTE_END, i)
        if (end < 0) {
          this.pasting = s.slice(i)
          return events
        }
        events.push({ type: 'paste', raw: s.slice(i, end + PASTE_END.length) })
        i = end + PASTE_END.length
        continue
      }
      const ch = s[i]
      if (ch === '\x1b' && i + 1 < s.length) {
        const next = s[i + 1]
        if (next === '[') {
          const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s.slice(i))
          if (mouse) {
            const code = Number(mouse[1])
            events.push({
              type: 'mouse',
              raw: mouse[0],
              button: code & 3,
              x: Number(mouse[2]) - 1,
              y: Number(mouse[3]) - 1,
              isRelease: mouse[4] === 'm',
              isWheel: (code & 64) !== 0,
              isDrag: (code & 32) !== 0,
            })
            i += mouse[0].length
            continue
          }
          let j = i + 2
          while (j < s.length && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e)) j++
          const raw = s.slice(i, j + 1)
          events.push({ type: 'key', raw, name: keyName(raw) })
          i = j + 1
          continue
        }
        if (next === 'O' && i + 2 < s.length) {
          const raw = s.slice(i, i + 3)
          events.push({ type: 'key', raw, name: keyName(raw) })
          i += 3
          continue
        }
        if (next !== '\x1b') {
          const cp = s.codePointAt(i + 1) ?? 0
          const raw = s.slice(i, i + 1 + (cp > 0xffff ? 2 : 1))
          events.push({ type: 'key', raw, name: keyName(raw) })
          i += raw.length
          continue
        }
      }
      const cp = s.codePointAt(i) ?? 0
      const raw = s.slice(i, i + (cp > 0xffff ? 2 : 1))
      events.push({ type: 'key', raw, name: keyName(raw) })
      i += raw.length
    }
    return events
  }
}
