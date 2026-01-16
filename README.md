# Obsidoist

[中文说明](README.zh-CN.md)

Obsidoist is an Obsidian plugin that lets you manage Todoist tasks in plain text.

Write tasks as normal Markdown checkboxes, sync them to Todoist, and pull changes back into your notes.

This plugin uses a **local-first** sync strategy: tasks are cached locally, edits are queued locally, and then synced to Todoist in the background.

## Features

- Two-way sync between Markdown tasks and Todoist.
- Create / update / complete / reopen tasks from Markdown lines (via a sync tag).
- Set due date and project using simple inline markers.
- Render a task list inside an Obsidian code block (including Todoist filters).
- Local-first cache with a persistent offline queue.

## Quick start

1) Install the plugin and set your Todoist API token.
2) Add `#todoist` to a Markdown task line.
3) Wait for auto sync (or click “Sync now”).
4) The plugin will append `[todoist_id:...]` to bind the line to Todoist.

## Usage

### Markdown tasks (create / update / complete)

Mark any Markdown checkbox line with your sync tag (default: `#todoist`):

```md
- [ ] Buy milk #todoist
- [x] Pay rent #todoist
```

After syncing, the plugin appends an ID marker:

```md
- [ ] Buy milk #todoist [todoist_id:123456789]
```

Notes:

- New tasks may temporarily use a local ID like `[todoist_id:local-...]` until they are created on Todoist.
- If a task is deleted on Todoist, the plugin will remove `[todoist_id:...]` from the note and leave a normal Markdown task.

### Due dates

Add a due date in `YYYY-MM-DD` format:

```md
- [ ] Submit report 🗓 2026-01-16 #todoist
```

Accepted calendar markers: `🗓`, `🗓️`, `📅`.

### Projects

Add a project tag using the project name without spaces (case-insensitive):

```md
- [ ] Fix bug #todoist #Work
- [ ] Buy groceries #todoist #Personal
```

New tasks will be created in `Default Project` if set; otherwise they go to Inbox.

### Code blocks (task list)

Create a code block like this:

```obsidoist
filter: #ObsidianTest
limit: 10
name: My Tasks
```

- `filter:` is a Todoist filter expression.
- `limit:` (optional) limits the maximum number of tasks displayed.
- For `filter:` blocks, the plugin fetches the latest results from Todoist during refresh (and caches them locally).

## Settings

Open Obsidian → Settings → Community plugins → Obsidoist.

### Basic
- `Todoist API Token`: from Todoist Settings → Integrations.
- `Default Project`: default destination for new tasks (empty = Inbox).
- `Sync Tag`: tag that marks Markdown lines for syncing.

### Sync
- `Codeblock auto refresh (seconds)`: how often code blocks refresh themselves (0 = disable).
- `Auto sync interval (seconds)`: background sync interval (0 = disable).
- `Sync now`: flush pending local changes and refresh tasks.
- `Sync status`: quick overview of queue / cache / last sync.
- `Todoist Sync API`: connectivity test.
- `Use Sync API`: use Todoist Sync API for incremental sync.

### Cache
- `Filter cache retention (days)`: how long cached filter results are kept (0 = disable age-based pruning).
- `Max cached filters`: maximum number of cached filter result sets (LRU).
- `Maintenance (advanced)`: cache/queue cleanup utilities.

### Developer
- `Debug logging`: enable verbose logs in the developer console.

## Installation

### Recommended (release build)

1) Download the latest release.
2) Copy `main.js`, `manifest.json`, `styles.css` into:

`<your vault>/.obsidian/plugins/obsidoist-plugin/`

3) Restart Obsidian and enable the plugin in Community plugins.

### From source

Clone this repo into `<your vault>/.obsidian/plugins/obsidoist-plugin/`, then run:

```bash
npm install
npm run build
```

## License

MIT
