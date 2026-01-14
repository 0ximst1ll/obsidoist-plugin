# Obsidoist

[中文说明](README.zh-CN.md)

Obsidian plugin for task management with Todoist sync.

This project currently uses a **local-first** sync strategy: tasks are cached locally, edits are queued locally, and then synced to Todoist in the background.

## Features

- Render a Todoist task list inside an Obsidian code block.
- Create/update/complete tasks from markdown (via a sync tag).
- Local-first sync with a persistent offline queue.
- Configurable auto-sync interval and a manual “Sync now” action.

## Usage

### 1) Render a task list (code block)

Create a code block like this:

```obsidoist
filter: #ObsidianTest
limit: 10
name: My Tasks
```

- `filter:` is a Todoist filter expression.
- `limit:` (optional) limits the maximum number of tasks displayed.
- The list renders from the local cache. Clicking the refresh button will sync and fetch tasks for that filter.

### 2) Sync tasks from markdown lines

Add tasks in your note using the configured sync tag (default: `#todoist`). For example:

```md
- [ ] Buy milk #todoist
- [x] Pay rent #todoist
```

After syncing, the plugin appends an ID marker to bind the line to a Todoist task:

```md
- [ ] Buy milk #todoist [todoist_id:123456789]
```

Notes:

- New tasks may temporarily use a local ID like `[todoist_id:local-...]` until they are created on Todoist.
- The plugin will later replace the local ID with the real remote ID automatically.

## Settings

Open Obsidian → Settings → Community plugins → Obsidoist.

- `Todoist API Token`: from Todoist Settings → Integrations.
- `Sync Tag`: markdown tag that marks lines for syncing.
- `Default Project`: where new tasks are created by default.
- `Auto sync interval (seconds)`: set `0` to disable background sync.
- `Sync now`: flush local pending changes and refresh cached tasks.

## How sync works (current)

- The plugin stores a persistent local cache of tasks and projects.
- All edits (create/update/close/reopen) are applied to the local cache first and appended to a local queue.
- A background timer (configurable) flushes the queue to Todoist and refreshes the local cache.
- Code blocks render from local cache. For `filter:` blocks, refresh will fetch the remote filter result and cache it.
- Completing/uncompleting a task from a code block sends the change to Todoist immediately.

## Development

```bash
npm install
npm run build
```

## Limitations

- Todoist “completed history / archive” is not fully mirrored locally yet (depends on the API endpoints available).
- For `filter:` code blocks, the plugin caches the remote filter result after a refresh; offline mode shows the last cached result.
