# codeview

A read-only file tree and live file/diff viewer that sits beside Claude Code in your terminal.

When Claude edits a file, codeview opens it, scrolls to the change, and records it in a list for the session. You can flip any file to its git diff. Nothing in the pane can be edited: it's there so you keep seeing the code Claude writes, even though you're not typing it.

## Why

When an AI session touches 10+ files, it's easy to stop reading and just commit. codeview keeps the code in front of you while Claude works, tracks which changed files you've actually looked at, and makes it one keypress to ask Claude about a change.

## What it does

- **Folder tree.** Expand and collapse folders. Files and folders Claude changed are marked `●`. `node_modules`, `.git`, build output and similar folders are hidden.
- **Auto-open on edit.** Each Edit/Write/NotebookEdit by Claude opens that file and scrolls to the first changed line.
- **Diff toggle.** `d` flips between the full file and its diff: against `HEAD` in a git repo, otherwise against the file as it was when Claude first touched it this session.
- **Change list.** Every file changed this session, with `+/−` counts, a ✓ once you've reviewed it, and the line Claude wrote just before making the edit.
- **Step through changes.** `n` / `p` go to the next or previous changed file.
- **Ask about it.** `a` puts "About your change to <file>:" in the prompt. `/codeview ask` quotes the text you selected with the mouse and asks Claude why it changed.
- **Gentle nudge.** When a turn ends with unreviewed files, a toast tells you how many.
- **Summary.** `/codeview summary` lists what changed and what you've reviewed.

### Optional, off by default

These add friction on purpose, so they stay off unless you turn them on:

- `/codeview gate on`: Claude's `git commit` is refused until every changed file is reviewed.
- `/codeview pause 5`: Claude pauses after every 5 edited files and asks you to review. `/codeview continue` lets it go on.

## Commands

```
/codeview              switch between the viewer and the default Claude view
/codeview tree         show the folder tree
/codeview changes      list the files changed this session
/codeview diff         flip the open file between full text and its diff
/codeview ask          ask Claude about the text you selected
/codeview summary      what changed this session and what you reviewed
/codeview off | on     turn codeview off or on (remembered across sessions)
/codeview gate on|off  optional review gate before git commit
/codeview pause N|off  optional pause every N edited files
/codeview continue     let Claude go on after a pause
/codeview help
```

In the pane (`ctrl+x tab` moves focus between the pane and the prompt): `t` tree · `c` changes · `f` file · `d` diff · `n`/`p` next/previous change · `r` mark reviewed · `a` ask · arrows scroll · `ctrl+x x` closes it.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install codeview --marketplace <owner>/<repo>
```

Answer `y` to add the marketplace, then pick a scope (user scope = every session). From a shell instead:

```
claude plugin install codeview --marketplace <owner>/<repo>
```

### Or run it from a clone, as its own command

```sh
git clone https://github.com/<owner>/<repo>.git ~/codeview
ln -s ~/codeview/scripts/codeview /usr/local/bin/codeview   # or add an alias
cd your-project && codeview
```

`codeview` starts `claude` with the plugin loaded and fullscreen rendering on. Plain `claude` stays unchanged.

## Requirements

- Claude Code with plugin hooks modules (2.1.317 or later).
- The pane docks beside the conversation in **fullscreen mode at 110+ columns**. On narrower terminals, or on the main screen (tmux by default), it opens above the prompt instead.
- macOS or Linux; uses `git` and `diff` from your PATH.

## Development

```sh
claude plugin validate .
claude plugin test .
claude --plugin-dir .      # reloads when you save a file
```

## License

MIT
