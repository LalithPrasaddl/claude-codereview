// Where "follow Claude" takes the code panel. Claude often edits several files in one
// turn; jumping to each in turn leaves the person on the last one, so follow opens the
// turn's first file and queues the rest, in the order Claude edited them.

/**
 * After Claude edits `edited`: the file to open, or null to stay where we are.
 * @param {{ shown: string | null, edited: string, turn: string[], userPicked: boolean }} s
 *   turn: files Claude changed this turn, in edit order; userPicked: the person opened a file this turn
 */
export function followOnEdit({ shown, edited, turn, userPicked }) {
  if (userPicked) return null // the person chose what to read: leave them there
  if (shown === edited) return edited // same file again: show the new change
  if (shown === null || !turn.includes(shown)) return edited // the turn's first file
  return null // a later file of the turn: it waits in the queue
}

/**
 * When Claude's turn ends: the first file of the turn not yet reviewed, or null to stay.
 * @param {{ shown: string | null, turn: string[], changes: { file: string, reviewed: boolean }[], userPicked: boolean }} s
 */
export function followOnTurnEnd({ shown, turn, changes, userPicked }) {
  if (userPicked) return null
  const first = turn.find(file => changes.some(c => c.file === file && !c.reviewed))
  return first === undefined || first === shown ? null : first
}

/**
 * The order n / p step through: this turn's files as Claude edited them, then the rest.
 * @param {string[]} turn @param {{ file: string }[]} changes
 */
export function reviewOrder(turn, changes) {
  const known = new Set(changes.map(c => c.file))
  const inTurn = turn.filter(file => known.has(file))
  return [...inTurn, ...changes.map(c => c.file).filter(file => !inTurn.includes(file))]
}
