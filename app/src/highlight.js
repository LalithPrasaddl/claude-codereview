// Syntax colors: highlight.js output turned into per-line colored segments.
import hljs from 'highlight.js'

/** @typedef {{ text: string, fg: string, flags: number }} Segment */

const COLORS = {
  keyword: '35', 'built_in': '33', type: '33', literal: '36', number: '36',
  string: '32', regexp: '32', 'template-variable': '32', subst: '',
  comment: '90', doctag: '90', meta: '90', 'meta keyword': '90',
  title: '34', 'title function_': '34', 'title class_': '33', function: '34',
  params: '', attr: '36', attribute: '36', property: '36', variable: '31',
  'variable language_': '31', symbol: '36', selector: '35', 'selector-tag': '35',
  'selector-class': '33', 'selector-id': '34', tag: '34', name: '34',
  section: '34', bullet: '33', code: '32', emphasis: '', strong: '',
  addition: '32', deletion: '31', link: '34', quote: '90',
}

const EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', json: 'json', yml: 'yaml',
  yaml: 'yaml', toml: 'ini', ini: 'ini', md: 'markdown', html: 'xml', xml: 'xml',
  svg: 'xml', css: 'css', scss: 'scss', less: 'less', sql: 'sql', lua: 'lua',
  dart: 'dart', scala: 'scala', r: 'r', pl: 'perl', ex: 'elixir', exs: 'elixir',
  dockerfile: 'dockerfile', makefile: 'makefile', gradle: 'groovy', vue: 'xml',
}

export function languageFor(file) {
  const base = file.split('/').pop()?.toLowerCase() ?? ''
  if (base === 'dockerfile') return 'dockerfile'
  if (base === 'makefile') return 'makefile'
  const ext = base.includes('.') ? base.split('.').pop() ?? '' : ''
  const lang = EXT[ext]
  return lang && hljs.getLanguage(lang) ? lang : null
}

function unescape(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * @param {string} source
 * @param {string | null} language
 * @returns {Segment[][]} one list of segments per line
 */
export function highlightLines(source, language) {
  const plain = () => source.split('\n').map(line => [{ text: line, fg: '', flags: 0 }])
  if (language === null || source.length > 300_000) return plain()
  let html
  try {
    html = hljs.highlight(source, { language, ignoreIllegals: true }).value
  } catch {
    return plain()
  }
  /** @type {Segment[][]} */
  const lines = [[]]
  /** @type {string[]} */
  const stack = []
  const color = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const cls = stack[i]
      if (cls in COLORS && COLORS[cls] !== '') return COLORS[cls]
      const first = cls.split(' ')[0]
      if (first in COLORS && COLORS[first] !== '') return COLORS[first]
    }
    return ''
  }
  const push = text => {
    const parts = unescape(text).split('\n')
    parts.forEach((part, i) => {
      if (i > 0) lines.push([])
      if (part !== '') {
        const fg = color()
        const flags = stack.some(cls => cls.startsWith('comment')) ? 4 : 0
        lines[lines.length - 1].push({ text: part, fg, flags })
      }
    })
  }
  const tag = /<span class="([^"]*)">|<\/span>/g
  let last = 0
  let m
  while ((m = tag.exec(html)) !== null) {
    if (m.index > last) push(html.slice(last, m.index))
    if (m[1] !== undefined) stack.push(m[1].replace(/hljs-/g, '').replace(/_+$/, '_'))
    else stack.pop()
    last = tag.lastIndex
  }
  if (last < html.length) push(html.slice(last))
  return lines
}
