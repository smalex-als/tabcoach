import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type BrowserTab = {
  id?: number;
  windowId?: number;
  title: string;
  url: string;
  active?: boolean;
  pinned?: boolean;
};

type DuplicateGroup = {
  normalizedUrl: string;
  tabs: BrowserTab[];
};

type LinkRecord = {
  url: string;
  lastOpenedAt: string;
  title?: string;
};

type RegistryData = {
  repos: LinkRecord[];
  tickets: LinkRecord[];
  documents: LinkRecord[];
};

type DesktopApp = {
  id: string;
  label: string;
  macAppName: string;
};

type Config = {
  host: string;
  port: number;
  repoListOutputPath: string;
  tabSwitchLogPath: string;
  tabEventLogPath: string;
  ttsClipboardAppPath: string;
  desktopApps: DesktopApp[];
  openAiApiKey?: string;
  openAiTranslationModel: string;
  dropHash: boolean;
  sortQueryParams: boolean;
  stripTrackingParams: boolean;
};

type SyncPayload = {
  tabs?: BrowserTab[];
  capturedAt?: string;
  source?: string;
};

type TtsSelectionPayload = {
  text?: string;
  pageTitle?: string;
  pageUrl?: string;
  source?: string;
};

type TabSwitchPayload = {
  switchedAt?: string;
  source?: string;
  from?: BrowserTab | null;
  to?: BrowserTab | null;
};

type TabEventPayload = {
  eventType?: string;
  occurredAt?: string;
  source?: string;
  ok?: boolean;
  tab?: BrowserTab | null;
};

type DesktopAppLaunchPayload = {
  appId?: string;
  source?: string;
};

const DEFAULT_DESKTOP_APPS: DesktopApp[] = [
  {
    id: "iterm",
    label: "iTerm",
    macAppName: "iTerm"
  }
];

const DEFAULT_TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "si",
  "spm",
  "utm_campaign",
  "utm_content",
  "utm_id",
  "utm_medium",
  "utm_source",
  "utm_term"
]);

function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];

  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function readNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isDesktopApp(value: unknown): value is DesktopApp {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<DesktopApp>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.trim().length > 0 &&
    typeof candidate.label === "string" &&
    candidate.label.trim().length > 0 &&
    typeof candidate.macAppName === "string" &&
    candidate.macAppName.trim().length > 0
  );
}

function readDesktopApps(): DesktopApp[] {
  const rawApps = process.env.DESKTOP_APPS_JSON;
  if (!rawApps) {
    return DEFAULT_DESKTOP_APPS;
  }

  try {
    const parsed = JSON.parse(rawApps);
    if (!Array.isArray(parsed)) {
      throw new Error("DESKTOP_APPS_JSON must be a JSON array");
    }

    const apps = parsed.filter(isDesktopApp).map((app) => ({
      id: app.id.trim(),
      label: app.label.trim(),
      macAppName: app.macAppName.trim()
    }));

    return apps.length > 0 ? apps : DEFAULT_DESKTOP_APPS;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Invalid DESKTOP_APPS_JSON; using defaults. ${message}`);
    return DEFAULT_DESKTOP_APPS;
  }
}

function formatConfigForLog(config: Config): Config {
  return {
    ...config,
    openAiApiKey: config.openAiApiKey ? "[set]" : undefined
  };
}

function loadConfig(): Config {
  return {
    host: process.env.HOST ?? "127.0.0.1",
    port: readNumber("PORT", 3847),
    repoListOutputPath: process.env.REPO_LIST_OUTPUT_PATH ?? "code-repos.md",
    tabSwitchLogPath: process.env.TAB_SWITCH_LOG_PATH ?? "tab-switch-log.jsonl",
    tabEventLogPath: process.env.TAB_EVENT_LOG_PATH ?? "tabcoach-events.jsonl",
    ttsClipboardAppPath: process.env.TTS_CLIPBOARD_APP_PATH ?? "/Users/smalex/bin/tts-clipboard",
    desktopApps: readDesktopApps(),
    openAiApiKey: process.env.OPENAI_API_KEY,
    openAiTranslationModel: process.env.OPENAI_TRANSLATION_MODEL ?? "gpt-4.1-mini",
    dropHash: readBoolean("DROP_HASH", true),
    sortQueryParams: readBoolean("SORT_QUERY_PARAMS", true),
    stripTrackingParams: readBoolean("STRIP_TRACKING_PARAMS", true)
  };
}

function getCurrentDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalizeUrl(rawUrl: string, config: Config): string {
  try {
    const parsed = new URL(rawUrl);

    if (config.dropHash) {
      parsed.hash = "";
    }

    parsed.hostname = parsed.hostname.toLowerCase();

    if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) {
      parsed.port = "";
    }

    if (config.stripTrackingParams) {
      for (const key of [...parsed.searchParams.keys()]) {
        if (DEFAULT_TRACKING_PARAMS.has(key.toLowerCase())) {
          parsed.searchParams.delete(key);
        }
      }
    }

    if (config.sortQueryParams) {
      const sortedEntries = [...parsed.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => {
        if (leftKey === rightKey) {
          return leftValue.localeCompare(rightValue);
        }

        return leftKey.localeCompare(rightKey);
      });

      parsed.search = "";
      for (const [key, value] of sortedEntries) {
        parsed.searchParams.append(key, value);
      }
    }

    if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    return parsed.toString();
  } catch {
    return rawUrl.trim();
  }
}

function findDuplicateGroups(tabs: BrowserTab[], config: Config): DuplicateGroup[] {
  const grouped = new Map<string, BrowserTab[]>();

  for (const tab of tabs) {
    if (!tab.url || tab.url.startsWith("chrome://")) {
      continue;
    }

    const normalizedUrl = normalizeUrl(tab.url, config);
    const entries = grouped.get(normalizedUrl) ?? [];
    entries.push(tab);
    grouped.set(normalizedUrl, entries);
  }

  return [...grouped.entries()]
    .filter(([, groupTabs]) => groupTabs.length > 1)
    .map(([normalizedUrl, groupTabs]) => ({ normalizedUrl, tabs: groupTabs }))
    .sort((left, right) => right.tabs.length - left.tabs.length);
}

function extractIndeedRepoUrl(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl);

    if (parsed.hostname !== "code.corp.indeed.com") {
      return undefined;
    }

    const pathSegments = parsed.pathname.split("/").filter(Boolean);
    if (pathSegments.length < 2) {
      return undefined;
    }

    const [group, repo] = pathSegments;
    return `https://code.corp.indeed.com/${group}/${repo}/`;
  } catch {
    return undefined;
  }
}

function collectIndeedRepoUrls(tabs: BrowserTab[]): string[] {
  return [...new Set(tabs.map((tab) => extractIndeedRepoUrl(tab.url)).filter((url): url is string => Boolean(url)))].sort();
}

function formatRepoMarkdownLink(url: string): string {
  try {
    const parsed = new URL(url);
    const pathSegments = parsed.pathname.split("/").filter(Boolean);
    const repoName = pathSegments[pathSegments.length - 1] ?? url;
    return `[${repoName}](${url})`;
  } catch {
    return url;
  }
}

function extractJiraTicketUrl(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl);

    if (parsed.hostname !== "indeed.atlassian.net") {
      return undefined;
    }

    const ticketMatch = parsed.pathname.match(/^\/browse\/([A-Z][A-Z0-9]+-\d+)$/);
    if (!ticketMatch) {
      return undefined;
    }

    return `https://indeed.atlassian.net/browse/${ticketMatch[1]}`;
  } catch {
    return undefined;
  }
}

function collectJiraTicketUrls(tabs: BrowserTab[]): string[] {
  return [...new Set(tabs.map((tab) => extractJiraTicketUrl(tab.url)).filter((url): url is string => Boolean(url)))].sort();
}

function collectJiraTicketRecords(tabs: BrowserTab[]): LinkRecord[] {
  const records = new Map<string, LinkRecord>();

  for (const tab of tabs) {
    const ticketUrl = extractJiraTicketUrl(tab.url);
    if (!ticketUrl) {
      continue;
    }

    records.set(ticketUrl, {
      url: ticketUrl,
      lastOpenedAt: "",
      title: tab.title.trim()
    });
  }

  return [...records.values()].sort((left, right) => left.url.localeCompare(right.url));
}

function escapeMarkdownLinkText(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function formatJiraMarkdownLinkWithTitle(record: LinkRecord): string {
  const fallback = record.url.split("/").pop() ?? record.url;
  const label = record.title?.trim() ? record.title.trim() : fallback;
  return `[${escapeMarkdownLinkText(label)}](${record.url})`;
}

function extractDocumentUrl(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl);

    if (parsed.hostname === "docs.google.com") {
      const match = parsed.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([^/]+)/);
      if (!match) {
        return undefined;
      }

      const [, kind, id] = match;
      return `https://docs.google.com/${kind}/d/${id}`;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function collectDocumentRecords(tabs: BrowserTab[]): LinkRecord[] {
  const records = new Map<string, LinkRecord>();

  for (const tab of tabs) {
    const documentUrl = extractDocumentUrl(tab.url);
    if (!documentUrl) {
      continue;
    }

    records.set(documentUrl, {
      url: documentUrl,
      lastOpenedAt: "",
      title: normalizeDocumentTitle(tab.title)
    });
  }

  return [...records.values()].sort((left, right) => left.url.localeCompare(right.url));
}

function formatDocumentMarkdownLinkWithTitle(record: LinkRecord): string {
  const fallback = record.url;
  const label = record.title?.trim() ? record.title.trim() : fallback;
  return `[${escapeMarkdownLinkText(label)}](${record.url})`;
}

function extractUrlFromMarkdown(value: string): string {
  const markdownLinkMatch = value.match(/\[[^\]]+\]\((https:\/\/[^)]+)\)/);
  return markdownLinkMatch?.[1] ?? value;
}

function extractMarkdownLinkParts(value: string): { label?: string; url: string } {
  const markdownLinkMatch = value.match(/\[([^\]]+)\]\((https:\/\/[^)]+)\)/);
  if (!markdownLinkMatch) {
    return {
      url: value
    };
  }

  return {
    label: markdownLinkMatch[1],
    url: markdownLinkMatch[2] ?? value
  };
}

function normalizeDocumentTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed
    .replace(/\s+-\s+Google Docs$/, "")
    .replace(/\s+-\s+Google Sheets$/, "")
    .replace(/\s+-\s+Google Slides$/, "")
    .trim();
}

function parseMarkdownTableRecords(lines: string[]): LinkRecord[] {
  return lines
    .filter((line) => line.startsWith("|") && !line.includes("---"))
    .slice(1)
    .map((line) => line.split("|").map((part) => part.trim()))
    .filter((parts) => parts.length >= 4)
    .map((parts) => {
      const linkParts = extractMarkdownLinkParts(parts[2] ?? "");
      const title = parts[3] || linkParts.label || "";
      return {
        lastOpenedAt: parts[1] ?? "",
        url: linkParts.url,
        title
      };
    })
    .filter((record) => record.url.startsWith("https://") && record.lastOpenedAt.length > 0);
}

function readSection(lines: string[], heading: string): string[] {
  const startIndex = lines.findIndex((line) => line === heading);
  if (startIndex === -1) {
    return [];
  }

  const sectionLines: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];

    if (line === undefined) {
      continue;
    }

    if (line.startsWith("## ")) {
      break;
    }

    if (line.length > 0) {
      sectionLines.push(line);
    }
  }

  return sectionLines;
}

async function readExistingRegistry(path: string): Promise<RegistryData> {
  try {
    const contents = await readFile(path, "utf8");
    const lines = contents
      .split(/\r\n|\n|\r/)
      .map((line) => line.trim())
      .filter(Boolean);

    const repoSection = readSection(lines, "## Repositories");
    const ticketSection = readSection(lines, "## Jira Tickets");
    const documentSection = readSection(lines, "## Documents");

    if (repoSection.length > 0 || ticketSection.length > 0 || documentSection.length > 0) {
      return {
        repos: parseMarkdownTableRecords(repoSection).filter((record) => record.url.startsWith("https://code.corp.indeed.com/")),
        tickets: parseMarkdownTableRecords(ticketSection).filter((record) => record.url.startsWith("https://indeed.atlassian.net/browse/")),
        documents: parseMarkdownTableRecords(documentSection).filter((record) => record.url.startsWith("https://docs.google.com/"))
      };
    }

    const legacyRepoRecords = parseMarkdownTableRecords(lines).filter((record) => record.url.startsWith("https://code.corp.indeed.com/"));
    if (legacyRepoRecords.length > 0) {
      return {
        repos: legacyRepoRecords,
        tickets: [],
        documents: []
      };
    }

    return {
      repos: lines
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2).trim())
        .filter((line) => line.startsWith("https://code.corp.indeed.com/"))
        .map((url) => ({
          url,
          lastOpenedAt: "1970-01-01",
          title: ""
        })),
      tickets: [],
      documents: []
    };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: string }).code) : "";

    if (code === "ENOENT") {
      return {
        repos: [],
        tickets: [],
        documents: []
      };
    }

    throw error;
  }
}

function mergeRecords(existingRecords: LinkRecord[], currentUrls: string[], now: string): LinkRecord[] {
  const mergedRecords = new Map(existingRecords.map((record) => [record.url, record] as const));

  for (const url of currentUrls) {
    mergedRecords.set(url, {
      url,
      lastOpenedAt: now
    });
  }

  return [...mergedRecords.values()].sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt));
}

function mergeTicketRecords(existingRecords: LinkRecord[], currentRecords: LinkRecord[], now: string): LinkRecord[] {
  const mergedRecords = new Map(existingRecords.map((record) => [record.url, record] as const));

  for (const record of currentRecords) {
    mergedRecords.set(record.url, {
      url: record.url,
      lastOpenedAt: now,
      title: record.title || mergedRecords.get(record.url)?.title || ""
    });
  }

  return [...mergedRecords.values()].sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt));
}

async function writeRegistryFile(tabs: BrowserTab[], config: Config): Promise<RegistryData> {
  const repoUrls = collectIndeedRepoUrls(tabs);
  const ticketRecords = collectJiraTicketRecords(tabs);
  const documentRecords = collectDocumentRecords(tabs);
  const existingRegistry = await readExistingRegistry(config.repoListOutputPath);
  const now = getCurrentDate();
  const sortedRepoRecords = mergeRecords(existingRegistry.repos, repoUrls, now);
  const sortedTicketRecords = mergeTicketRecords(existingRegistry.tickets, ticketRecords, now);
  const sortedDocumentRecords = mergeTicketRecords(existingRegistry.documents, documentRecords, now);
  const lines = [
    "# Indeed Browser Registry",
    "",
    `Updated: ${now}`,
    "",
    "## Repositories",
    "",
    "| Last Opened | Repository | Title |",
    "| --- | --- | --- |",
    ...(
      sortedRepoRecords.length > 0
        ? sortedRepoRecords.map((record) => `| ${record.lastOpenedAt} | ${formatRepoMarkdownLink(record.url)} | ${record.title ?? ""} |`)
        : ["No matching code.corp.indeed.com repository tabs found."]
    ),
    "",
    "## Jira Tickets",
    "",
    "| Last Opened | Ticket |",
    "| --- | --- |",
    ...(
      sortedTicketRecords.length > 0
        ? sortedTicketRecords.map((record) => `| ${record.lastOpenedAt} | ${formatJiraMarkdownLinkWithTitle(record)} |`)
        : ["No matching Jira ticket tabs found."]
    ),
    "",
    "## Documents",
    "",
    "| Last Opened | Document |",
    "| --- | --- |",
    ...(
      sortedDocumentRecords.length > 0
        ? sortedDocumentRecords.map((record) => `| ${record.lastOpenedAt} | ${formatDocumentMarkdownLinkWithTitle(record)} |`)
        : ["No matching document tabs found."]
    ),
    ""
  ];

  await mkdir(dirname(config.repoListOutputPath), { recursive: true });
  await writeFile(config.repoListOutputPath, lines.join("\n"), "utf8");
  return {
    repos: sortedRepoRecords,
    tickets: sortedTicketRecords,
    documents: sortedDocumentRecords
  };
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

function looksRussian(text: string): boolean {
  const cyrillicMatches = text.match(/[А-Яа-яЁё]/g) ?? [];
  if (cyrillicMatches.length === 0) {
    return false;
  }

  const letterMatches = text.match(/\p{L}/gu) ?? [];
  if (letterMatches.length === 0) {
    return false;
  }

  const cyrillicRatio = cyrillicMatches.length / letterMatches.length;
  return cyrillicRatio >= 0.3;
}

async function translateRussianTextToEnglish(text: string, config: Config): Promise<string> {
  if (!config.openAiApiKey) {
    console.warn("OPENAI_API_KEY is not set; using original Russian text for TTS.");
    return text;
  }

  console.log(
    `[${new Date().toISOString()}] translating Russian selection to English with model=${config.openAiTranslationModel}`
  );

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({
    apiKey: config.openAiApiKey
  });

  const response = await client.responses.create({
    model: config.openAiTranslationModel,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: "Translate Russian text into natural English for text-to-speech. Return only the translated English text with no commentary."
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text
          }
        ]
      }
    ]
  });

  const translatedText = response.output_text.trim();
  if (!translatedText) {
    throw new Error("OpenAI translation returned empty text");
  }

  return translatedText;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let rawBody = "";

  for await (const chunk of request) {
    rawBody += String(chunk);
  }

  return rawBody ? JSON.parse(rawBody) : {};
}

async function copyTextToClipboard(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pbcopy", [], {
      stdio: ["pipe", "ignore", "pipe"]
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr || `pbcopy exited with code ${code}`));
    });

    child.stdin.write(text);
    child.stdin.end();
  });
}

function launchTtsClipboardApp(appPath: string): void {
  const child = spawn(appPath, [], {
    detached: true,
    stdio: "ignore"
  });

  child.unref();
}

function findDesktopApp(appId: string, config: Config): DesktopApp | undefined {
  return config.desktopApps.find((app) => app.id === appId);
}

async function launchDesktopApp(app: DesktopApp): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Desktop app launching is currently supported only on macOS");
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn("open", ["-a", app.macAppName], {
      stdio: ["ignore", "ignore", "pipe"]
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr || `open exited with code ${code}`));
    });
  });
}

function isBrowserTab(value: unknown): value is BrowserTab {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<BrowserTab>;
  return typeof candidate.title === "string" && typeof candidate.url === "string";
}

async function handleSync(request: IncomingMessage, response: ServerResponse, config: Config): Promise<void> {
  const body = await readJsonBody(request);
  const payload = body as SyncPayload;
  const tabs = Array.isArray(payload.tabs) ? payload.tabs.filter(isBrowserTab) : [];
  const duplicateGroups = findDuplicateGroups(tabs, config);
  const registry = await writeRegistryFile(tabs, config);

  console.log(
    `[${new Date().toISOString()}] sync from ${payload.source ?? "unknown"}: ${tabs.length} tabs, ${duplicateGroups.length} duplicate groups, ${registry.repos.length} tracked repos, ${registry.tickets.length} tracked tickets, ${registry.documents.length} tracked documents`
  );

  sendJson(response, 200, {
    ok: true,
    trackedRepoCount: registry.repos.length,
    trackedTicketCount: registry.tickets.length,
    trackedDocumentCount: registry.documents.length,
    duplicateGroupCount: duplicateGroups.length,
    duplicateGroups: duplicateGroups.map((group) => ({
      normalizedUrl: group.normalizedUrl,
      count: group.tabs.length,
      tabs: group.tabs.map((tab) => ({
        title: tab.title,
        url: tab.url,
        windowId: tab.windowId,
        tabId: tab.id,
        active: tab.active,
        pinned: tab.pinned
      }))
    }))
  });
}

async function handleTtsSelection(request: IncomingMessage, response: ServerResponse, config: Config): Promise<void> {
  const body = await readJsonBody(request);
  const payload = body as TtsSelectionPayload;
  const text = typeof payload.text === "string" ? payload.text.trim() : "";

  if (!text) {
    sendJson(response, 400, {
      ok: false,
      error: "Missing selection text"
    });
    return;
  }

  const translated = looksRussian(text);
  const textForTts = translated ? await translateRussianTextToEnglish(text, config) : text;

  await copyTextToClipboard(textForTts);
  launchTtsClipboardApp(config.ttsClipboardAppPath);

  console.log(
    `[${new Date().toISOString()}] tts selection from ${payload.source ?? "unknown"}: ${text.length} chars, translated=${translated}, translationModel=${translated ? config.openAiTranslationModel : "none"}, page=${payload.pageTitle ?? "(unknown)"}`
  );

  sendJson(response, 200, {
    ok: true,
    copiedToClipboard: true,
    launched: true,
    translated
  });
}

async function handleTabSwitch(request: IncomingMessage, response: ServerResponse, config: Config): Promise<void> {
  const body = await readJsonBody(request);
  const payload = body as TabSwitchPayload;
  const switchedAt = typeof payload.switchedAt === "string" ? payload.switchedAt : new Date().toISOString();
  const record = {
    switchedAt,
    source: payload.source ?? "unknown",
    from: payload.from && isBrowserTab(payload.from) ? payload.from : null,
    to: payload.to && isBrowserTab(payload.to) ? payload.to : null
  };

  await mkdir(dirname(config.tabSwitchLogPath), { recursive: true });
  await appendFile(config.tabSwitchLogPath, `${JSON.stringify(record)}\n`, "utf8");

  console.log(
    `[${new Date().toISOString()}] tab switch from ${record.from?.title ?? "(unknown)"} to ${record.to?.title ?? "(unknown)"}`
  );

  sendJson(response, 200, {
    ok: true,
    logged: true
  });
}

async function handleTabEvent(request: IncomingMessage, response: ServerResponse, config: Config): Promise<void> {
  const body = await readJsonBody(request);
  const payload = body as TabEventPayload;
  const record = {
    occurredAt: typeof payload.occurredAt === "string" ? payload.occurredAt : new Date().toISOString(),
    eventType: typeof payload.eventType === "string" ? payload.eventType : "unknown",
    source: payload.source ?? "unknown",
    ok: Boolean(payload.ok),
    tab: payload.tab && isBrowserTab(payload.tab) ? payload.tab : null
  };

  await mkdir(dirname(config.tabEventLogPath), { recursive: true });
  await appendFile(config.tabEventLogPath, `${JSON.stringify(record)}\n`, "utf8");

  console.log(
    `[${new Date().toISOString()}] tab event ${record.eventType}: ok=${record.ok}, tab=${record.tab?.title ?? "(unknown)"}`
  );

  sendJson(response, 200, {
    ok: true,
    logged: true
  });
}

async function handleDesktopAppLaunch(request: IncomingMessage, response: ServerResponse, config: Config): Promise<void> {
  const body = await readJsonBody(request);
  const payload = body as DesktopAppLaunchPayload;
  const appId = typeof payload.appId === "string" ? payload.appId : "";
  const app = findDesktopApp(appId, config);

  if (!app) {
    sendJson(response, 404, {
      ok: false,
      error: "Unknown desktop app"
    });
    return;
  }

  await launchDesktopApp(app);

  console.log(
    `[${new Date().toISOString()}] desktop app launch from ${payload.source ?? "unknown"}: ${app.label} (${app.macAppName})`
  );

  sendJson(response, 200, {
    ok: true,
    app: {
      id: app.id,
      label: app.label
    },
    launched: true
  });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, config: Config): Promise<void> {
  if (!request.url) {
    sendJson(response, 404, { ok: false, error: "Missing URL" });
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    });
    response.end();
    return;
  }

  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, {
      ok: true,
      host: config.host,
      port: config.port,
      repoListOutputPath: config.repoListOutputPath
    });
    return;
  }

  if (request.method === "GET" && request.url === "/api/desktop-apps") {
    sendJson(response, 200, {
      ok: true,
      apps: config.desktopApps.map((app) => ({
        id: app.id,
        label: app.label
      }))
    });
    return;
  }

  if (request.method === "POST" && request.url === "/api/desktop-apps/launch") {
    await handleDesktopAppLaunch(request, response, config);
    return;
  }

  if (request.method === "POST" && request.url === "/api/sync") {
    await handleSync(request, response, config);
    return;
  }

  if (request.method === "POST" && request.url === "/api/tts-selection") {
    await handleTtsSelection(request, response, config);
    return;
  }

  if (request.method === "POST" && request.url === "/api/tab-switch") {
    await handleTabSwitch(request, response, config);
    return;
  }

  if (request.method === "POST" && request.url === "/api/tab-event") {
    await handleTabEvent(request, response, config);
    return;
  }

  sendJson(response, 404, { ok: false, error: "Not found" });
}

async function ensureTabSwitchLogFile(config: Config): Promise<void> {
  await mkdir(dirname(config.tabSwitchLogPath), { recursive: true });
  await appendFile(config.tabSwitchLogPath, "", "utf8");
}

async function ensureTabEventLogFile(config: Config): Promise<void> {
  await mkdir(dirname(config.tabEventLogPath), { recursive: true });
  await appendFile(config.tabEventLogPath, "", "utf8");
}

async function main(): Promise<void> {
  const config = loadConfig();
  await ensureTabSwitchLogFile(config);
  await ensureTabEventLogFile(config);

  const server = createServer((request, response) => {
    void handleRequest(request, response, config).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      sendJson(response, 500, { ok: false, error: message });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });

  console.log("tabcoach server started");
  console.log(JSON.stringify(formatConfigForLog(config), null, 2));
  console.log(`POST tab snapshots to http://${config.host}:${config.port}/api/sync`);
  console.log(`POST selected text to http://${config.host}:${config.port}/api/tts-selection`);
  console.log(`POST tab switches to http://${config.host}:${config.port}/api/tab-switch`);
  console.log(`POST tab events to http://${config.host}:${config.port}/api/tab-event`);
  console.log(`GET desktop apps from http://${config.host}:${config.port}/api/desktop-apps`);
  console.log(`POST desktop app launches to http://${config.host}:${config.port}/api/desktop-apps/launch`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
