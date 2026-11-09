// Where each panel sits. Every panel's rect includes its one-row title bar.

/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */
/** @typedef {'tree' | 'code' | 'claude'} PanelId */
/** @typedef {'editor' | 'stacked'} LayoutName */

export const LAYOUTS = /** @type {const} */ (['editor', 'stacked'])

export const LAYOUT_LABELS = {
  editor: 'tree | code | claude',
  stacked: 'tree | code, claude below',
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))

/**
 * @param {number} cols
 * @param {number} rows terminal rows, the status bar's included
 * @param {LayoutName} layout
 * @param {PanelId | null} zoomed
 * @returns {Record<PanelId, Rect | null>} null for a hidden panel; borders sit between rects
 */
export function computeLayout(cols, rows, layout, zoomed) {
  const h = Math.max(1, rows - 1) // the last row is the status bar
  if (zoomed !== null) {
    const full = { x: 0, y: 0, w: cols, h }
    return { tree: null, code: null, claude: null, [zoomed]: full }
  }

  if (layout === 'stacked') {
    const topH = clamp(Math.round(h * 0.55), 4, h - 6)
    const treeW = clamp(Math.round(cols * 0.22), 18, 40)
    return {
      tree: { x: 0, y: 0, w: treeW, h: topH },
      code: { x: treeW + 1, y: 0, w: cols - treeW - 1, h: topH },
      claude: { x: 0, y: topH + 1, w: cols, h: h - topH - 1 },
    }
  }

  // editor: tree | code | claude
  const treeW = clamp(Math.round(cols * 0.18), 18, 36)
  const claudeW = clamp(Math.round(cols * 0.38), 44, Math.max(44, cols - treeW - 30))
  const codeW = cols - treeW - claudeW - 2
  if (codeW < 20) return computeLayout(cols, rows, 'stacked', null)
  return {
    tree: { x: 0, y: 0, w: treeW, h },
    code: { x: treeW + 1, y: 0, w: codeW, h },
    claude: { x: treeW + codeW + 2, y: 0, w: claudeW, h },
  }
}

/** @returns {PanelId | null} */
export function panelAt(rects, x, y) {
  for (const id of /** @type {PanelId[]} */ (['tree', 'code', 'claude'])) {
    const r = rects[id]
    if (r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return id
  }
  return null
}
