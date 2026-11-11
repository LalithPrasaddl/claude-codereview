# codeview

See the code Claude is writing, as it writes it.

When an AI session touches 10+ files, it's easy to stop reading and just commit. codeview keeps the code in front of you while Claude works: a read-only file tree, a live code and diff viewer that jumps to every file Claude edits, and a list of what changed and what you've actually looked at.

This repo has two versions:

| | **Full-screen app** (`codeview` command) | **Pane plugin** (inside Claude Code) |
|---|---|---|
| What it is | A full-screen terminal app with Claude running inside it | A panel inside a normal `claude` session |
| Size | The whole terminal: tree, code and Claude side by side | Capped at 45% of the width, on the right |
| Install | `npm i -g` from this repo | `/plugin install` |

---

## Full-screen app

```
┌ FILES ──────┬ CODE · src/math.js ─────────────┬ CLAUDE ─────────────────┐
│ ▾ src/ ●    │ +4 −0  ○ not reviewed           │ > add a subtract        │
│   math.js ● │  6  export function multiply(…  │   function              │
│ README.md   │  9 ▌                            │                         │
│             │ 10 ▌export function subtract(…  │ ⏺ Update(src/math.js)   │
│             │ 11 ▌  return a - b              │                         │
└─────────────┴─────────────────────────────────┴─────────────────────────┘
 ctrl+\ then: 1 tree · 2 code · 3 claude · l layout · z zoom · ? help
```

### Install

Requires Node 18+, Claude Code on your PATH, macOS or Linux.

```sh
npm install -g github:LalithPrasaddl/claude-codereview
```

Or from a clone:

```sh
git clone https://github.com/LalithPrasaddl/claude-codereview.git
cd claude-codereview && npm install && npm link
```

Then, in any project:

```sh
codeview            # instead of `claude`; any claude options pass through: codeview -c, codeview --resume
```

You set it up once and it works in every project. Your normal `claude` command is not changed.

### What it does

- **Two layouts.** The default is like an editor: tree | code | Claude. The second puts tree and code side by side with Claude below. `ctrl+\ l` switches, and your choice is remembered.
- **Follows Claude.** The first file Claude changes in a turn opens in the middle, scrolled to the change, with changed lines marked `▌`. Files it changes after that don't pull the view away: they queue in a **this turn** line at the top of the code panel, in the order Claude edited them (`✓` reviewed, `○` not yet). When Claude finishes, the first file you haven't reviewed is shown. If you open a file yourself, follow leaves you there until the next turn. Any file that changes on disk while Claude is working counts: its Edit/Write tools, shell commands, subagents. Files your `.gitignore` excludes are skipped.
- **Diff view.** `d` flips between the full file and its diff (against `HEAD` in a git repo, otherwise against the file before Claude touched it).
- **Changes in the tree, like an editor.** Changed files are colored by status: yellow `M` modified, green `A` new, red `D` deleted, dimmed with `✓` once you've reviewed them. Folders holding unreviewed changes are yellow. A **CHANGED** list is pinned at the bottom of the tree (unreviewed first), so changes in collapsed folders are never out of sight. Arrow down past the last tree row (or click) to pick one; `c` shows the full list.
- **Reviewed.** A file counts as reviewed once you open it yourself (tree, list, `n`/`p`) or press `r`. Files Claude opened for you don't count.
- **Step through changes.** `n` / `p` go through this turn's files in the order Claude edited them, then the rest.
- **Review notes.** Move the line cursor in the code panel and press `c` to leave a note on that line ("this should handle null"). Lines with notes get a `●`. `s` puts all your notes into Claude's prompt as one message, each with its file, line and code. You read it and press enter to send. `c` on a noted line edits the note; saving it empty removes it.
- **Ask about it.** `a` types "About your change to <file>: " into Claude's prompt.
- **Read-only.** Nothing in the tree or code panel can edit files.
- **Claude only.** `ctrl+\ c` gives Claude the whole screen (the default Claude view) and back. `codeview off` makes the command run plain `claude` until `codeview on`.

Optional, off by default:

- `ctrl+\ g`: review gate. Claude's `git commit` is refused until every changed file is reviewed.
- `ctrl+\ p`: pause Claude every 3 / 5 / 10 edited files so you can catch up. `ctrl+\ space` lets it continue.

### Keys

`ctrl+\` is the prefix: press it, let go, then:

| Key | |
|---|---|
| `1` `2` `3` | focus tree / code / Claude (clicking a panel works too) |
| `tab` | next panel |
| `l` | switch layout |
| `z` | zoom the focused panel to full screen, and back |
| `c` | Claude only, and back |
| `f` | follow Claude's edits on/off |
| `s` | send your review notes to Claude's prompt |
| `g` / `p` / `space` | review gate / pause / continue after a pause |
| `?` | all keys |
| `q` | quit |

In the tree: `↑↓` or `j k` (down past the end goes into the CHANGED list), `enter` open, `← →` fold, `c` change list. In the code: `↑↓` move the line cursor (or click a line), `space`/`b` page, `d` diff, `n`/`p` next/previous change, `c` note on this line, `s` send notes, `r` reviewed, `a` ask, `esc` back to Claude. The mouse wheel scrolls any panel.

Settings live in `~/.config/codeview/config.json`. Changed lines get a faint green / red background suited to your terminal's colors; codeview asks the terminal for its background at startup. If it guesses wrong, set `"tint"` to `"dark"`, `"light"` or `"off"` (default `"auto"`).

### How it works

`codeview` starts the real `claude` inside a pseudo-terminal, emulated by xterm.js (the terminal inside VS Code), and draws it in its panel. It passes Claude Code a pair of hooks through `--settings`, so your own settings are untouched. The hooks report each edit, save the file's original text, and apply the optional gate and pause.

---

## Pane plugin (inside Claude Code)

The same idea as a Claude Code plugin: a panel docked on the right of a normal `claude` session.

At the prompt of a Claude Code terminal session:

```
/plugin install codeview --marketplace LalithPrasaddl/claude-codereview
```

Answer `y` to add the marketplace, then pick a scope (user scope = every session). From a shell instead:

```
claude plugin install codeview --marketplace LalithPrasaddl/claude-codereview
```

Commands: `/codeview` (switch between the viewer and the default view), `/codeview tree`, `/codeview changes`, `/codeview diff`, `/codeview ask`, `/codeview summary`, `/codeview off | on`, and the optional `/codeview gate on|off`, `/codeview pause N|off`, `/codeview continue`. In the pane (`ctrl+x tab` to focus it): `t` tree · `c` changes · `f` file · `d` diff · `n`/`p` next/previous · `r` reviewed · `a` ask.

The pane docks beside the conversation in fullscreen mode at 110+ columns. To try it from a clone without installing: `scripts/codeview-pane`.

---

## Development

```sh
npm install && npm test                           # full-screen app
claude plugin validate . && claude plugin test .   # pane plugin
```

## License

MIT
