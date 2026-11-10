// Faint backgrounds behind changed lines, picked to suit the terminal's own background.
// We ask the terminal for its background color (OSC 11); one that doesn't answer gets no tint.

/** @typedef {{ added: string, removed: string }} Tint  SGR background parameters */

const QUERY = '\x1b]11;?\x07'
/** The terminal's answer: ESC ] 11 ; rgb:RRRR/GGGG/BBBB, ended by BEL or ESC \ */
export const REPLY = /\x1b\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\x07|\x1b\\)/i

/** The background color in a terminal's reply, as 0–255 channels, or null. */
export function parseBackground(reply) {
  const m = REPLY.exec(reply)
  if (!m) return null
  const [r, g, b] = m.slice(1, 4).map(hex => Math.round((parseInt(hex, 16) / (16 ** hex.length - 1)) * 255))
  return { r, g, b }
}

/** @param {{ r: number, g: number, b: number }} c */
export function isLight({ r, g, b }) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5
}

/**
 * The tint for a dark or light background, in 24-bit color where the terminal has it.
 * @param {'dark' | 'light'} theme @returns {Tint}
 */
export function tintFor(theme, isTrueColor) {
  if (isTrueColor) {
    return theme === 'light'
      ? { added: '48;2;220;245;224', removed: '48;2;252;226;226' }
      : { added: '48;2;22;48;30', removed: '48;2;58;24;28' }
  }
  return theme === 'light' ? { added: '48;5;194', removed: '48;5;224' } : { added: '48;5;22', removed: '48;5;52' }
}

/**
 * Ask the terminal for its background, waiting up to `timeoutMs`. Call before anything
 * else reads stdin. Resolves to the color or null, plus any keys typed meanwhile.
 * @returns {Promise<{ color: { r: number, g: number, b: number } | null, leftover: string }>}
 */
export function queryBackground(timeoutMs = 250) {
  const stdin = process.stdin
  return new Promise(resolve => {
    let got = ''
    const finish = color => {
      clearTimeout(timer)
      stdin.off('data', onData)
      stdin.pause()
      resolve({ color, leftover: got.replace(REPLY, '') })
    }
    const onData = chunk => {
      got += chunk
      const color = parseBackground(got)
      if (color) finish(color)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    stdin.on('data', onData)
    stdin.resume()
    process.stdout.write(QUERY)
  })
}

/**
 * The tint to use: the config's choice, or the detected one when it says 'auto'.
 * @param {'auto' | 'dark' | 'light' | 'off'} setting
 * @returns {Promise<{ tint: Tint | null, leftover: string }>}
 */
export async function resolveTint(setting) {
  const isTrueColor = /truecolor|24bit/i.test(process.env.COLORTERM ?? '')
  if (setting === 'off') return { tint: null, leftover: '' }
  if (setting === 'dark' || setting === 'light') return { tint: tintFor(setting, isTrueColor), leftover: '' }
  const { color, leftover } = await queryBackground()
  return { tint: color ? tintFor(isLight(color) ? 'light' : 'dark', isTrueColor) : null, leftover }
}
