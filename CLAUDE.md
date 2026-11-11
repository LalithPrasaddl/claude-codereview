# codeview

Keeps developers reading the code Claude writes, instead of committing it unread. Shows a read-only file tree and a live code/diff view beside Claude.

Repo: github.com/LalithPrasaddl/claude-codereview.

## Two versions in one repo

1. **Full-screen app** (`app/`, the `codeview` command). This is the main product.
   - Plain Node ESM with no build step.
   - `package.json` sits at the repo root because npm can't install a git subdirectory.
   - Install: `npm install -g github:LalithPrasaddl/claude-codereview`.
2. **Pane plugin** (`.claude-plugin/`, `hooks/register.tsx`, `hooks/lib.ts`, `types/`, `tests/`). A Claude Code mod that opens a pane docked right, capped at 45% width.
   - Install: `/plugin install codeview --marketplace LalithPrasaddl/claude-codereview`.
   - Local launcher: `scripts/codeview-pane`.
   - Check it with `claude plugin validate .` and `claude plugin test .`.

## How the app works

- `app/src/main.js`:
  - handles `codeview on|off|help` and `--layout editor|stacked`
  - passes every other argument to `claude`
  - runs plain `claude` when codeview is disabled or stdout isn't a TTY
- `app/src/app.js` (`App`):
  - owns the screen, layout, input routing and the prefix key `ctrl+\` (0x1c)
  - watches the disk with recursive `fs.watch`
- `claude-panel.js`:
  - runs the real `claude` in node-pty and emulates its screen with `@xterm/headless`
  - `fix-pty.js` restores node-pty's `spawn-helper` +x bit (`posix_spawnp failed` otherwise); it runs at postinstall and at startup
- Hooks:
  - Passed with `claude --settings '<json>'`. **Never touch the user's own settings.**
  - `app/src/hook.js` runs as `pre` / `post` (Edit, Write, MultiEdit, NotebookEdit, Bash), `turn-start` (UserPromptSubmit) and `turn-end` (Stop).
  - Events are appended to `$CODEVIEW_DIR/events.jsonl`, in a per-session temp dir that also holds `state.json` and `baseline/`.
  - Exit code 2 with a stderr message refuses a tool call; the review gate and pause use this.
- `session.js` decides which files are Claude's (and keeps `turn`, this turn's files in edit order), from three sources:
  - edit events
  - files changed on disk inside a Bash start/end window
  - any disk change during Claude's turn (prompt sent until Stop)

  Git-ignored files are skipped. Duplicates within 1.5s don't count as new edits.
- Diffs:
  - `git diff HEAD`; untracked files use `--no-index /dev/null`
  - without git, `diff -u` against the copy the `pre` hook saved
  - since review: marking a file reviewed copies it to `$CODEVIEW_DIR/reviewed/<sha1>`. When Claude edits it again, `CodePanel.open` reads that copy into `reviewBase` (before the open marks it reviewed again) and diffs against it with `diff -u -`; `v` switches to the HEAD diff. `record` points `focusLine` at the first new line, and leaves a file reviewed if it matches the copy exactly
- Panels and helpers:
  - `tree-panel.js`: git-style status colors (M yellow, A green, D red, ✓ dim once reviewed), plus a pinned CHANGED list at the bottom that the arrow keys reach
  - `code-panel.js`: file view and diff view, with a line cursor and the note input box
  - `notes.js`: review notes (file, line or null for a removed line, the line's code, text). `toPrompt` makes one line, since a newline would submit Claude's prompt; sending types it but doesn't press enter
  - `follow.js`: where follow goes. The turn's first file opens; later ones queue in the "this turn" strip; at Stop it shows the first unreviewed one; a file the person opens wins until the next turn
  - helpers in `screen.js`, `input.js`, `layout.js`, `width.js`, `highlight.js`, `diff.js`
- `tint.js`: before the app starts, `main.js` asks the terminal for its background (OSC 11, 250ms timeout) to pick dark or light backgrounds for changed lines; no answer means no tint. A late reply is stripped in `App.onInput` so it never reaches Claude.
- Config lives in `~/.config/codeview/config.json`: `{enabled, layout, gate, threshold, follow, tint}` (`tint`: `auto` | `dark` | `light` | `off`).

## Product rules

- **The review gate and the pause-every-N-files stay optional and OFF by default.** They should feel like support, not restrictions.
- The viewer is read-only. Opening a file marks it reviewed.
- Layouts:
  - default `editor` is tree | code | Claude, like an editor
  - `stacked` is tree | code on top, Claude below
- Keep the README in step with features and keys.

## Testing

- `npm test` runs `node --test app/test/*.test.js`. Name the files: a bare directory fails on Node 22.
- To see the real UI: `npm link` this repo, then run `codeview` in any small git repo. Restart `codeview` to pick up changes.
- Headless checks: run `app/bin/codeview.js` in node-pty, feed its output to an `@xterm/headless` Terminal, send keys, then dump the buffer (with colors when needed).
  - Simulate an edit: change a file, then pipe `{"tool_name":"Edit","tool_input":{"file_path":...},"cwd":...}` into `CODEVIEW_DIR=<session dir> node app/src/hook.js post`.
  - Reset the test repo after: `git checkout . && git clean -fd`.
