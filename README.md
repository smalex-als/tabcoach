# Tabcoach

Tabcoach is a two-part setup:

- a local TypeScript server that receives tab snapshots and records tab switch activity
- a Chrome extension that reads open tabs and sends them to that server

## What It Does

- Reads all open Chrome tabs from the extension
- Detects duplicate tabs by normalized URL
- Auto-closes duplicate tabs conservatively when enabled
- Provides a keyboard-driven tab switcher with grouping, search, bookmarks, and tab actions
- Records tab switch stats and tab events locally

## Project Layout

- `src/index.ts`: local HTTP server
- `extension/manifest.json`: Chrome extension manifest
- `extension/background.js`: extension background worker

## Prerequisites

- Node.js 20+
- Google Chrome

## Install

```bash
npm install
```

## Run The Local Server

Development:

```bash
npm run dev
```

Build and run:

```bash
npm run build
npm start
```

Server defaults:

- `HOST`: `127.0.0.1`
- `PORT`: `3847`
- `TAB_SWITCH_LOG_PATH`: `tab-switch-log.jsonl`
- `TAB_EVENT_LOG_PATH`: `tabcoach-events.jsonl`
- `DESKTOP_APPS_JSON`: optional desktop app allowlist, defaults to iTerm, IntelliJ IDEA, Obsidian, and WebStorm when unset; set to `[]` to disable desktop app buttons

Health check:

```bash
curl http://127.0.0.1:3847/health
```

## Run With Docker

Build and start the local server:

```bash
docker compose up --build
```

The Compose setup publishes the server at `http://127.0.0.1:3847`, stores logs in the local ignored `data/` folder, and configures desktop app buttons for iTerm, IntelliJ IDEA, Obsidian, and WebStorm.

Desktop app launching from Docker still depends on the container being able to run the host's macOS `open -a` command. If launches do not work from Docker, run with `npm run dev` or `npm start` directly on macOS instead.

## Load The Chrome Extension

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the [extension](/Users/smalex/jsprojects/tabcoach/extension) folder

The extension will:

- sync on startup
- sync when tabs are created, updated, removed, or activated
- sync every minute
- auto-close duplicate tabs conservatively
- show server health and duplicate-group count as extension badge text
- show, create, drag-reorder, group, bookmark, copy URLs, close, and switch between tabs in the current window with `Command+E` on macOS, including inline duplicate indicators, tab group labels, search, and recently visited sorting
- use toolbar actions in the `Command+E` popup to create a group, move to a group, ungroup, or duplicate the currently selected tab
- collapse, expand, and rename tab groups directly from the `Command+E` popup
- show saved bookmarks for a tab group directly in the list when they are not currently open, then open a selected bookmark back into that group
- assign numeric tab bookmark 1 from any page with `Ctrl+Shift+1` (`Control+Shift+1` on macOS), then jump with `Ctrl+1`; slots 0 through 9 are available as extension commands and can be assigned in `chrome://extensions/shortcuts`; saved numeric bookmarks show a small in-page notification; the `Command+E` popup supports slots 0 through 9
- store bookmarks under `Tabcoach/<tab group name>` to keep saved tabs organized
- show optional app bookmark buttons that open a configured URL in the currently selected tab group
- show desktop app launcher buttons at the bottom of the `Command+E` popup; by default, the `iTerm`, `IntelliJ IDEA`, `Obsidian`, and `WebStorm` buttons ask the local server to run `open -a` for those apps
- show optional workspace launch buttons that open configured URLs as a new Chrome tab group
- keep a per-window activation history and expose previous/next history commands for jumping backward and forward between recently active tabs in the same window
- show a tab movement statistics page from extension options, backed by the local tab switch log

Extension settings are available from `chrome://extensions` -> `Tabcoach` -> `Details` -> `Extension options`.
Settings include an option to open the `Command+E` tab switcher as a left-side window next to the current Chrome window. In left-side mode, selecting a tab keeps the switcher open while focus moves to the selected tab.
Use the `Stats` button in extension options to open tab movement statistics.

The `Command+E` popup includes a `+` button that opens a new tab before the currently active tab in the source window. If the active tab is in a Chrome tab group, the new tab is added to the same group.
The `Previous tab` shortcut defaults to `Ctrl+Q` (`Control+Q` on macOS) and can be changed from `chrome://extensions/shortcuts`. The `Next tab in history` command is available there too; Chrome may not allow `Ctrl+W` because it normally closes the current tab.

App bookmarks are stored in the Chrome bookmarks folder `Tabcoach/App Bookmarks`. Use a tab row context menu item, `Add to app bookmarks`, to save the current tab as an app bookmark.

Select a tab group or a tab inside a group in the `Command+E` popup, then click an app bookmark to open it inside that group. If no group is selected, the app bookmark opens ungrouped near the active tab. If the URL is already open in the current window, Tabcoach focuses that tab instead of opening a duplicate.

Auto-close rules:

- keep one tab per normalized URL
- prefer the active tab
- then prefer pinned tabs
- only close duplicates that are neither active nor pinned
- give newly created tabs a 3 minute grace period before duplicate auto-close applies

## Tab Switch Log

Switching tabs through the `Command+E` popup posts to `POST /api/tab-switch`. The server appends JSON Lines to local `tab-switch-log.jsonl` by default, including timestamp, source, previous tab, and target tab.
The stats page reads aggregates from `GET /api/tab-switch-stats`, including totals, today, last 7 days, average switches per day, daily counts for the last 7 days, today-specific routes and domain breakdowns, estimated focus time by domain, top target domains, top routes, sources, and recent switches with estimated time spent. Focus intervals longer than 15 minutes are treated as idle and excluded from time totals.
Copying a tab URL through the popup posts to `POST /api/tab-event`. The server appends JSON Lines to local `tabcoach-events.jsonl` by default.

## Desktop App Launcher

The `Command+E` popup loads desktop app buttons from `GET /api/desktop-apps` and launches them through `POST /api/desktop-apps/launch`.

Default allowlist:

```json
[{"id":"iterm","label":"iTerm","macAppName":"iTerm"},{"id":"intellij-idea","label":"IntelliJ IDEA","macAppName":"IntelliJ IDEA"},{"id":"obsidian","label":"Obsidian","macAppName":"Obsidian"},{"id":"webstorm","label":"WebStorm","macAppName":"WebStorm"}]
```

To add more macOS apps, start the server with `DESKTOP_APPS_JSON`:

```bash
DESKTOP_APPS_JSON='[{"id":"iterm","label":"iTerm","macAppName":"iTerm"},{"id":"intellij-idea","label":"IntelliJ IDEA","macAppName":"IntelliJ IDEA"},{"id":"obsidian","label":"Obsidian","macAppName":"Obsidian"},{"id":"webstorm","label":"WebStorm","macAppName":"WebStorm"},{"id":"notes","label":"Notes","macAppName":"Notes"}]' npm run dev
```

Workspace launch groups can be configured from extension options as JSON:

```json
[
  {
    "id": "job-search",
    "label": "Job Search",
    "urls": ["https://www.indeed.com/", "https://www.linkedin.com/jobs/"]
  }
]
```

Workspace `urls` are opened in the switcher's source Chrome window as a tab group. URLs that are already open in that window are focused instead of duplicated.
