# Tabcoach

Tabcoach is a two-part setup:

- a local TypeScript server that receives tab snapshots and writes a cumulative Markdown repo registry
- a Chrome extension that reads open tabs and sends them to that server

## What It Does

- Reads all open Chrome tabs from the extension
- Detects duplicate tabs by normalized URL
- Extracts unique `https://code.corp.indeed.com/<group>/<repo>/` links
- Extracts unique Jira ticket links like `https://indeed.atlassian.net/browse/NEXSCI-464`
- Extracts Google Docs, Sheets, and Slides document links
- Stores repos, Jira tickets, and documents in the same cumulative Markdown file
- Saves `Last Opened` as `YYYY-MM-DD`
- Keeps document names in the registry after tabs are closed, instead of degrading them back to plain URLs
- Sorts records by most recently opened first
- Formats links as Markdown links like `[talent-scout-dradis-integration](https://code.corp.indeed.com/one-host/talent-scout-dradis-integration/)`

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
- `REPO_LIST_OUTPUT_PATH`: `/Users/smalex/Documents/home/indeed-repos.md`
- `TTS_CLIPBOARD_APP_PATH`: `/Users/smalex/bin/tts-clipboard`
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
- show the duplicate-group count as the extension badge text
- show, drag-reorder, bookmark, close, and switch between tabs in the current window with `Command+E` on macOS, including tab group labels and recently visited sorting
- send selected page text to the local TTS flow with `Command+Shift+S` on macOS
- show a badge and notification when TTS is started successfully

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

[indeed-repos.md](/Users/smalex/Documents/home/indeed-repos.md)

Format:

```md
## Repositories

| Last Opened | Repository | Title |
| --- | --- | --- |
| 2026-03-11 | [talent-scout-dradis-integration](https://code.corp.indeed.com/one-host/talent-scout-dradis-integration/) | Talent Scout Dradis Integration |

## Jira Tickets

| Last Opened | Ticket |
| --- | --- |
| 2026-03-11 | [[NEXSCI-464] CSP Prompt: Seamless Merge of Employer Activity Signals into Scoring - Jira Software](https://indeed.atlassian.net/browse/NEXSCI-464) |

## Documents

| Last Opened | Document |
| --- | --- |
| 2026-03-11 | [AI Champions AMER Notes/Agenda](https://docs.google.com/document/d/1xE-oA7OH0VdQnWsE_8BBpmnMlzLyaKmg-cSh7x83y-w) |
```

The file is cumulative. Repos, Jira tickets, and documents stay in the file even after their tabs are closed later.
Document labels are read back from the saved Markdown links, so previously captured Google Docs names are preserved across later syncs.

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
