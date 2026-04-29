# Tabcoach

Tabcoach is a two-part setup:

- a local TypeScript server that receives tab snapshots and writes a cumulative Markdown repo registry
- a Chrome extension that reads open tabs and sends them to that server

## What It Does

- Reads all open Chrome tabs from the extension
- Detects duplicate tabs by normalized URL
- Extracts unique repository links
- Extracts unique Jira ticket links
- Extracts Google Docs, Sheets, and Slides document links
- Stores repos, Jira tickets, and documents in the same cumulative Markdown file
- Saves `Last Opened` as `YYYY-MM-DD`
- Keeps document names in the registry after tabs are closed, instead of degrading them back to plain URLs
- Sorts records by most recently opened first
- Formats links as Markdown links

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
- `REPO_LIST_OUTPUT_PATH`: `code-repos.md`
- `TAB_SWITCH_LOG_PATH`: `tab-switch-log.jsonl`
- `TAB_EVENT_LOG_PATH`: `tabcoach-events.jsonl`
- `TTS_CLIPBOARD_APP_PATH`: `/Users/smalex/bin/tts-clipboard`
- `DESKTOP_APPS_JSON`: optional desktop app allowlist, defaults to iTerm
- `OPENAI_TRANSLATION_MODEL`: `gpt-4.1-mini`

Health check:

```bash
curl http://127.0.0.1:3847/health
```

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
- group Google Docs, Sheets, and Slides tabs into a blue `Docs` tab group
- show server health and duplicate-group count as extension badge text
- show, create, drag-reorder, group, bookmark, copy URLs, close, and switch between tabs in the current window with `Command+E` on macOS, including inline duplicate indicators, tab group labels, search, and recently visited sorting
- use toolbar actions in the `Command+E` popup to create a group, move to a group, ungroup, or duplicate the currently selected tab
- collapse, expand, and rename tab groups directly from the `Command+E` popup
- save a tab group as a dated bookmark snapshot without deduplicating URLs, then open that snapshot in Chrome Bookmark Manager
- assign numeric tab bookmark 1 from any page with `Ctrl+Shift+1` (`Control+Shift+1` on macOS), then jump with `Ctrl+1`; slots 0 through 9 are available as extension commands and can be assigned in `chrome://extensions/shortcuts`; saved numeric bookmarks show a small in-page notification; the `Command+E` popup supports slots 0 through 9
- store bookmarks under `Tabcoach/<tab group name>` to keep saved tabs organized
- show desktop app launcher buttons at the bottom of the `Command+E` popup; by default, the `iTerm` button asks the local server to run `open -a iTerm`
- send selected page text to the local TTS flow; assign the `Speak selection` shortcut from `chrome://extensions/shortcuts`
- show a badge and notification when TTS is started successfully
- keep a per-window activation history and expose previous/next history commands for jumping backward and forward between recently active tabs in the same window
- show a tab movement statistics page from extension options, backed by the local tab switch log

Extension settings are available from `chrome://extensions` -> `Tabcoach` -> `Details` -> `Extension options`.
Settings include an option to open the `Command+E` tab switcher as a left-side window next to the current Chrome window. In left-side mode, selecting a tab keeps the switcher open while focus moves to the selected tab.
Use the `Stats` button in extension options to open tab movement statistics.

The `Command+E` popup includes a `+` button that opens a new tab before the currently active tab in the source window. If the active tab is in a Chrome tab group, the new tab is added to the same group.
The `Previous tab` shortcut defaults to `Ctrl+Q` (`Control+Q` on macOS) and can be changed from `chrome://extensions/shortcuts`. The `Next tab in history` command is available there too; Chrome may not allow `Ctrl+W` because it normally closes the current tab.

Auto-close rules:

- keep one tab per normalized URL
- prefer the active tab
- then prefer pinned tabs
- only close duplicates that are neither active nor pinned
- give newly created tabs a 3 minute grace period before duplicate auto-close applies

Focused window Docs grouping protection:

- Google Docs tabs in the focused window are not regrouped into the `Docs` tab group until you leave that window

## Output File

The repo registry is written to:

[code-repos.md](/Users/smalex/jsprojects/tabcoach/code-repos.md)

Format:

```md
## Repositories

| Last Opened | Repository | Title |
| --- | --- | --- |
| 2026-03-11 | [example-service](https://git.example.com/platform/example-service/) | Example Service |

## Jira Tickets

| Last Opened | Ticket |
| --- | --- |
| 2026-03-11 | [[APP-123] Example ticket - Jira Software](https://jira.example.com/browse/APP-123) |

## Documents

| Last Opened | Document |
| --- | --- |
| 2026-03-11 | [AI Champions AMER Notes/Agenda](https://docs.google.com/document/d/1xE-oA7OH0VdQnWsE_8BBpmnMlzLyaKmg-cSh7x83y-w) |
```

The file is cumulative. Repos, Jira tickets, and documents stay in the file even after their tabs are closed later.
Document labels are read back from the saved Markdown links, so previously captured Google Docs names are preserved across later syncs.

## Tab Switch Log

Switching tabs through the `Command+E` popup posts to `POST /api/tab-switch`. The server appends JSON Lines to local `tab-switch-log.jsonl` by default, including timestamp, source, previous tab, and target tab.
The stats page reads aggregates from `GET /api/tab-switch-stats`, including totals, today, last 7 days, average switches per day, daily counts for the last 7 days, today-specific routes and domain breakdowns, estimated focus time by domain, top target domains, top routes, sources, and recent switches with estimated time spent. Focus intervals longer than 15 minutes are treated as idle and excluded from time totals.
Copying a tab URL through the popup posts to `POST /api/tab-event`. The server appends JSON Lines to local `tabcoach-events.jsonl` by default.

## Desktop App Launcher

The `Command+E` popup loads desktop app buttons from `GET /api/desktop-apps` and launches them through `POST /api/desktop-apps/launch`.

Default allowlist:

```json
[{"id":"iterm","label":"iTerm","macAppName":"iTerm"}]
```

To add more macOS apps, start the server with `DESKTOP_APPS_JSON`:

```bash
DESKTOP_APPS_JSON='[{"id":"iterm","label":"iTerm","macAppName":"iTerm"},{"id":"notes","label":"Notes","macAppName":"Notes"}]' npm run dev
```

## TTS Shortcut

On macOS, press `Command+Shift+S` with text selected on the page.

Flow:

1. The extension reads the current selection from the active tab
2. It sends that text to `POST /api/tts-selection`
3. If the selection looks Russian, the server translates it to English through OpenAI first
4. The server copies the final text into the macOS clipboard
5. The server launches `/Users/smalex/bin/tts-clipboard`

Your current `tts-clipboard` script reads from `pbpaste`, so this keeps it compatible with the existing CLI.

To enable Russian-to-English translation before TTS, set `OPENAI_API_KEY` in the shell where you start `npm run dev`.
