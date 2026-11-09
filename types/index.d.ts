/** Which body the pane shows. */
export type CodeviewView = 'tree' | 'file' | 'changes'

/** The file open in the viewer. `path` is absolute. */
export type CodeviewCurrent = {
  path: string
  showDiff: boolean
  /** 1-based line the viewer scrolls to (the first changed line). */
  focusLine: number
}

/** One file Claude changed this session. `path` is absolute. */
export type CodeviewChange = {
  path: string
  added: number
  removed: number
  edits: number
  reviewed: boolean
  /** What Claude said just before the edit, one short line. */
  why: string
}

/** Kept across sessions in $.store as well. */
export type CodeviewSettings = {
  enabled: boolean
  /** Refuse `git commit` while changed files are unreviewed. Off by default. */
  gate: boolean
  /** Pause Claude after this many edited files; 0 is off (the default). */
  threshold: number
}

declare module 'claude-code' {
  interface PluginState {
    codeview: {
      view: Shaped<CodeviewView>
      expanded: Shaped<string[]>
      current: Shaped<CodeviewCurrent | null>
      changes: Shaped<CodeviewChange[]>
      settings: Shaped<CodeviewSettings>
      /** Files Claude may edit before the next pause. */
      allowance: number
      /** The person closed the pane: don't reopen it on the next edit. */
      hidden: boolean
      /** Bumped after each edit so the tree and file re-read the disk. */
      tick: number
    }
  }
}
