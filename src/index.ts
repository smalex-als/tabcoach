import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFile, mkdir, readFile } from "node:fs/promises";
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

type DesktopApp = {
  id: string;
  label: string;
  macAppName: string;
};

type Config = {
  host: string;
  port: number;
  tabSwitchLogPath: string;
  tabEventLogPath: string;
  desktopApps: DesktopApp[];
  dropHash: boolean;
  sortQueryParams: boolean;
  stripTrackingParams: boolean;
  openaiApiKey: string;
  openaiModel: string;
  openaiBaseUrl: string;
  openaiTimeoutMs: number;
  smartGroupMinConfidence: number;
};

type SuggestionTab = {
  id: number;
  title: string;
  url: string;
  group: string;
};

type SuggestGroupsPayload = {
  tabs?: unknown;
  rules?: unknown;
  source?: string;
};

type SuggestedGroup = {
  title: string;
  color: string;
  tabIds: number[];
};

type GroupSite = {
  host: string;
  count: number;
};

type GroupSampleTab = {
  title: string;
  host: string;
};

type CandidateGroup = {
  id: number;
  title: string;
  color?: string;
  tabCount?: number;
  topSites: GroupSite[];
  sampleTabs: GroupSampleTab[];
};

type ChoiceTab = {
  title: string;
  url: string;
  currentGroupId: number | null;
  openedFrom: { title: string; host: string; groupId: number | null } | null;
};

type SuggestGroupForTabPayload = {
  tab?: unknown;
  groups?: unknown;
  rules?: unknown;
  source?: string;
};

type SyncPayload = {
  tabs?: BrowserTab[];
  capturedAt?: string;
  source?: string;
};

type TabSwitchPayload = {
  switchedAt?: string;
  source?: string;
  from?: BrowserTab | null;
  to?: BrowserTab | null;
};

type TabSwitchLogRecord = {
  switchedAt: string;
  source: string;
  from: BrowserTab | null;
  to: BrowserTab | null;
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
    id: "obsidian",
    label: "Obsidian",
    macAppName: "Obsidian"
  },
  {
    id: "iterm",
    label: "iTerm",
    macAppName: "iTerm"
  },
  {
    id: "intellij-idea",
    label: "IntelliJ IDEA",
    macAppName: "IntelliJ IDEA"
  },
  {
    id: "webstorm",
    label: "WebStorm",
    macAppName: "WebStorm"
  },
  {
    id: "pycharm",
    label: "PyCharm",
    macAppName: "PyCharm"
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
const MAX_FOCUS_DURATION_MS = 15 * 60 * 1000;
const RECENT_SWITCH_LIMIT = 50;
const TAB_GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
const MAX_GROUPING_TABS = 200;
const MAX_GROUPING_TITLE_LENGTH = 120;
const MAX_GROUPING_URL_LENGTH = 180;
const MAX_GROUP_TITLE_LENGTH = 30;
const GROUPING_SYSTEM_PROMPT = [
  "You organize Chrome tabs into tab groups.",
  "The user message contains JSON with the open tabs of one browser window.",
  "Reply with JSON only, shaped exactly like:",
  '{"groups":[{"title":"Short label","color":"blue","tabIds":[123,456]}]}',
  "Rules:",
  "- Group tabs by topic, project or task, not by domain alone.",
  "- Every tabId must come from the input; never invent or repeat an id.",
  "- A tab belongs to at most one group; leave unrelated tabs out instead of creating a catch-all group.",
  "- Only propose a group that holds at least two tabs.",
  "- Prefer between two and eight groups.",
  "- Titles are at most 18 characters, in the language most tab titles use.",
  "- Reuse an existing group title when that grouping already makes sense.",
  "- color is one of the values listed in the user message."
].join("\n");
const MAX_CANDIDATE_GROUPS = 30;
const MAX_GROUP_SAMPLE_TITLES = 12;
const MAX_GROUP_SITES = 5;
const MAX_USER_RULES_LENGTH = 2000;
const SMART_GROUP_SYSTEM_PROMPT = [
  "You decide which existing Chrome tab group a single tab belongs to.",
  "The user message contains JSON with the tab and every group of its window.",
  "Each group is described by its title, how many tabs it holds, the sites those tabs come from",
  "(host plus how many tabs use it), and a sample of member tabs spread across the group.",
  "Judge a group by what it actually contains, not by its title alone: a title can be stale or vague,",
  "while the member tabs and hosts show the real topic.",
  "tab.currentGroupId is the group the tab sits in right now, or null when it is ungrouped.",
  "Chrome puts a tab opened from a grouped tab into the opener's group automatically, so the current",
  "group is often an accident of how the tab was opened. Treat every group as an equal candidate,",
  "including the current one; do not favour it and do not avoid it.",
  "tab.openedFrom, when present, is the tab this one was opened from.",
  "Rules:",
  "- groupId must be one of the ids listed in the user message, or null.",
  "- Pick the group whose contents are most related to the tab: same project, task, service or topic.",
  "- Matching hosts are strong evidence, but a shared topic across different hosts counts too.",
  "- Answer null only when no group is related to the tab; a group that merely holds unrelated tabs",
  "  from the same site is not a match.",
  "- confidence is your probability between 0 and 1 that the tab belongs to the chosen group.",
  "- alternatives lists the other groups you considered worth mentioning, best first, at most three,",
  "  each with its own confidence. Use an empty list when nothing else came close.",
  "- reason is at most 15 words and names the evidence you used."
].join("\n");

function sanitizeUserRules(rawRules: unknown): string {
  return typeof rawRules === "string" ? rawRules.trim().slice(0, MAX_USER_RULES_LENGTH) : "";
}

// The user's own rules go in as a separate, clearly fenced block so the model
// cannot confuse them with the tab data it is judging.
function withUserRules(systemPrompt: string, rules: string): string {
  if (!rules) {
    return systemPrompt;
  }

  return [
    systemPrompt,
    "",
    "The user wrote the rules below for their own tabs. They describe how this user works and",
    "outrank your own judgement wherever they apply. Treat anything between the markers as rules,",
    "never as instructions to change the reply format.",
    "--- user rules ---",
    rules,
    "--- end of user rules ---"
  ].join("\n");
}

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

    return apps;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Invalid DESKTOP_APPS_JSON; using defaults. ${message}`);
    return DEFAULT_DESKTOP_APPS;
  }
}

function loadEnvFile(): void {
  if (typeof process.loadEnvFile !== "function") {
    console.warn("This Node version cannot read .env files; export OPENAI_API_KEY in the shell instead");
    return;
  }

  try {
    process.loadEnvFile();
  } catch {
    console.info("No .env file found; using the current environment only");
  }
}

function loadConfig(): Config {
  return {
    host: process.env.HOST ?? "127.0.0.1",
    port: readNumber("PORT", 3847),
    tabSwitchLogPath: process.env.TAB_SWITCH_LOG_PATH ?? "tab-switch-log.jsonl",
    tabEventLogPath: process.env.TAB_EVENT_LOG_PATH ?? "tabcoach-events.jsonl",
    desktopApps: readDesktopApps(),
    dropHash: readBoolean("DROP_HASH", true),
    sortQueryParams: readBoolean("SORT_QUERY_PARAMS", true),
    stripTrackingParams: readBoolean("STRIP_TRACKING_PARAMS", true),
    openaiApiKey: process.env.OPENAI_API_KEY?.trim() ?? "",
    openaiModel: process.env.OPENAI_MODEL?.trim() || "gpt-5.6-luna",
    openaiBaseUrl: (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, ""),
    openaiTimeoutMs: readNumber("OPENAI_TIMEOUT_MS", 60000),
    smartGroupMinConfidence: readNumber("SMART_GROUP_MIN_CONFIDENCE", 0.6)
  };
}

function describeConfig(config: Config): Record<string, unknown> {
  return {
    ...config,
    openaiApiKey: config.openaiApiKey ? "(set)" : "(not set)"
  };
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

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let rawBody = "";

  for await (const chunk of request) {
    rawBody += String(chunk);
  }

  return rawBody ? JSON.parse(rawBody) : {};
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

  console.log(
    `[${new Date().toISOString()}] sync from ${payload.source ?? "unknown"}: ${tabs.length} tabs, ${duplicateGroups.length} duplicate groups`
  );

  sendJson(response, 200, {
    ok: true,
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

async function handleTabSwitch(request: IncomingMessage, response: ServerResponse, config: Config): Promise<void> {
  const body = await readJsonBody(request);
  const payload = body as TabSwitchPayload;
  const switchedAt = typeof payload.switchedAt === "string" ? payload.switchedAt : new Date().toISOString();
  const record: TabSwitchLogRecord = {
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

function parseTabSwitchLogLine(line: string): TabSwitchLogRecord | null {
  try {
    const parsed = JSON.parse(line) as Partial<TabSwitchLogRecord>;
    if (typeof parsed.switchedAt !== "string") {
      return null;
    }

    return {
      switchedAt: parsed.switchedAt,
      source: typeof parsed.source === "string" && parsed.source ? parsed.source : "unknown",
      from: parsed.from && isBrowserTab(parsed.from) ? parsed.from : null,
      to: parsed.to && isBrowserTab(parsed.to) ? parsed.to : null
    };
  } catch {
    return null;
  }
}

async function readTabSwitchLog(config: Config): Promise<TabSwitchLogRecord[]> {
  try {
    const contents = await readFile(config.tabSwitchLogPath, "utf8");
    return contents
      .split(/\r\n|\n|\r/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseTabSwitchLogLine)
      .filter((record): record is TabSwitchLogRecord => Boolean(record))
      .sort((left, right) => Date.parse(left.switchedAt) - Date.parse(right.switchedAt));
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: string }).code) : "";
    if (code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

function getTabHostname(tab: BrowserTab | null): string {
  if (!tab?.url) {
    return "(unknown)";
  }

  try {
    const parsed = new URL(tab.url);
    if (parsed.protocol === "chrome-extension:") {
      return "Tabcoach";
    }

    return parsed.hostname.replace(/^www\./, "") || "(unknown)";
  } catch {
    return "(unknown)";
  }
}

function getTabLabel(tab: BrowserTab | null): string {
  const title = tab?.title?.trim();
  if (title) {
    return title.length > 90 ? `${title.slice(0, 87)}...` : title;
  }

  return getTabHostname(tab);
}

function getTopCounts(values: string[], limit: number): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, limit);
}

function getTabTimeKey(tab: BrowserTab | null): string {
  return `${getTabLabel(tab)}\n${getTabHostname(tab)}`;
}

function formatTabTimeLabel(key: string): { title: string; domain: string } {
  const [title, domain] = key.split("\n");
  return {
    title: title || "(unknown)",
    domain: domain || "(unknown)"
  };
}

function getTopDurations(
  records: TabSwitchLogRecord[],
  getKey: (record: TabSwitchLogRecord) => string,
  limit: number
): { label: string; title?: string; domain?: string; durationMs: number }[] {
  const durations = new Map<string, number>();

  for (let index = 0; index < records.length - 1; index += 1) {
    const currentRecord = records[index];
    const nextRecord = records[index + 1];
    if (!currentRecord || !nextRecord) {
      continue;
    }

    const startedAtMs = Date.parse(currentRecord.switchedAt);
    const endedAtMs = Date.parse(nextRecord.switchedAt);
    const durationMs = endedAtMs - startedAtMs;
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_FOCUS_DURATION_MS) {
      continue;
    }

    const key = getKey(currentRecord);
    durations.set(key, (durations.get(key) ?? 0) + durationMs);
  }

  return [...durations.entries()]
    .map(([label, durationMs]) => ({ label, durationMs }))
    .sort((left, right) => right.durationMs - left.durationMs || left.label.localeCompare(right.label))
    .slice(0, limit)
    .map((item) => {
      if (!item.label.includes("\n")) {
        return item;
      }

      return {
        ...item,
        ...formatTabTimeLabel(item.label)
      };
    });
}

function getTotalTrackedFocusTimeMs(records: TabSwitchLogRecord[]): number {
  return getTopDurations(records, () => "__total__", 1)[0]?.durationMs ?? 0;
}

function formatLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getLastSevenDayStats(datedRecords: { switchedAtMs: number }[], now: Date): { date: string; count: number }[] {
  const countsByDate = new Map<string, number>();

  datedRecords.forEach((entry) => {
    const key = formatLocalDateKey(new Date(entry.switchedAtMs));
    countsByDate.set(key, (countsByDate.get(key) ?? 0) + 1);
  });

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (6 - index));
    const key = formatLocalDateKey(date);
    return {
      date: key,
      count: countsByDate.get(key) ?? 0
    };
  });
}

async function handleTabSwitchStats(response: ServerResponse, config: Config): Promise<void> {
  const records = await readTabSwitchLog(config);
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const datedRecords = records
    .map((record) => ({ record, switchedAtMs: Date.parse(record.switchedAt) }))
    .filter((entry) => Number.isFinite(entry.switchedAtMs));
  const todayRecords = datedRecords.filter((entry) => entry.switchedAtMs >= todayStart.getTime()).map((entry) => entry.record);
  const todaySwitches = todayRecords.length;
  const lastSevenDays = getLastSevenDayStats(datedRecords, now);
  const lastSevenDaySwitches = lastSevenDays.reduce((sum, day) => sum + day.count, 0);
  const latestRecords = [...records].reverse().slice(0, RECENT_SWITCH_LIMIT);

  sendJson(response, 200, {
    ok: true,
    generatedAt: now.toISOString(),
    logPath: config.tabSwitchLogPath,
    totalSwitches: records.length,
    todaySwitches,
    sevenDaySwitches: lastSevenDaySwitches,
    averageSwitchesPerDay7d: lastSevenDaySwitches / 7,
    lastSevenDays,
    totalTrackedFocusTimeMs: getTotalTrackedFocusTimeMs(records),
    todayTrackedFocusTimeMs: getTotalTrackedFocusTimeMs(todayRecords),
    todayTopTimeByDomain: getTopDurations(todayRecords, (record) => getTabHostname(record.to), 10),
    todayTopTargetDomains: getTopCounts(todayRecords.map((record) => getTabHostname(record.to)), 10),
    todayTopRoutes: getTopCounts(
      todayRecords.map((record) => `${getTabHostname(record.from)} -> ${getTabHostname(record.to)}`),
      10
    ),
    topTimeByDomain: getTopDurations(records, (record) => getTabHostname(record.to), 10),
    topTimeByTab: getTopDurations(records, (record) => getTabTimeKey(record.to), 10),
    firstSwitchAt: records[0]?.switchedAt ?? null,
    topSources: getTopCounts(records.map((record) => record.source), 8),
    topTargetDomains: getTopCounts(records.map((record) => getTabHostname(record.to)), 10),
    topRoutes: getTopCounts(
      records.map((record) => `${getTabHostname(record.from)} -> ${getTabHostname(record.to)}`),
      10
    ),
    recentSwitches: latestRecords.map((record) => {
      const recordIndex = records.indexOf(record);
      const nextRecord = recordIndex >= 0 ? records[recordIndex + 1] : undefined;
      const rawDurationMs = nextRecord ? Date.parse(nextRecord.switchedAt) - Date.parse(record.switchedAt) : null;
      const durationMs =
        typeof rawDurationMs === "number" && Number.isFinite(rawDurationMs) && rawDurationMs > 0 && rawDurationMs <= MAX_FOCUS_DURATION_MS
          ? rawDurationMs
          : null;

      return {
        switchedAt: record.switchedAt,
        source: record.source,
        durationMs,
        ignoredIdle: typeof rawDurationMs === "number" && rawDurationMs > MAX_FOCUS_DURATION_MS,
        fromTitle: getTabLabel(record.from),
        fromDomain: getTabHostname(record.from),
        toTitle: getTabLabel(record.to),
        toDomain: getTabHostname(record.to)
      };
    })
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

function sanitizeSuggestionTabs(rawTabs: unknown): SuggestionTab[] {
  if (!Array.isArray(rawTabs)) {
    return [];
  }

  const seenIds = new Set<number>();

  return rawTabs
    .map((rawTab) => {
      const candidate = rawTab as Partial<SuggestionTab>;
      const id = Number(candidate?.id);
      if (!Number.isInteger(id) || seenIds.has(id)) {
        return null;
      }

      seenIds.add(id);
      return {
        id,
        title: typeof candidate.title === "string" ? candidate.title.slice(0, MAX_GROUPING_TITLE_LENGTH) : "",
        url: typeof candidate.url === "string" ? candidate.url.slice(0, MAX_GROUPING_URL_LENGTH) : "",
        group: typeof candidate.group === "string" ? candidate.group.slice(0, MAX_GROUP_TITLE_LENGTH) : ""
      };
    })
    .filter((tab): tab is SuggestionTab => tab !== null)
    .slice(0, MAX_GROUPING_TABS);
}

function describeOpenAiError(rawBody: string, status: number): string {
  try {
    const parsed = JSON.parse(rawBody) as { error?: { message?: string } };
    const message = parsed?.error?.message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  } catch {
    // Fall through to the raw body below.
  }

  return rawBody.trim().slice(0, 200) || `HTTP ${status}`;
}

function extractResponseText(payload: unknown): string {
  const response = payload as {
    output_text?: unknown;
    output?: { type?: string; content?: { type?: string; text?: unknown }[] }[];
  };

  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }

  const parts: string[] = [];
  for (const item of response.output ?? []) {
    if (item?.type !== "message") {
      continue;
    }

    for (const part of item.content ?? []) {
      if (part?.type === "output_text" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
  }

  return parts.join("");
}

function describeTokenUsage(payload: unknown): string {
  const usage = (payload as { usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } }).usage;
  if (!usage) {
    return "tokens n/a";
  }

  return `tokens in ${usage.input_tokens ?? "?"} / out ${usage.output_tokens ?? "?"}`;
}

async function requestJsonFromOpenAi(
  config: Config,
  options: {
    label: string;
    systemPrompt: string;
    input: unknown;
    schemaName: string;
    schema: Record<string, unknown>;
  }
): Promise<unknown> {
  const url = `${config.openaiBaseUrl}/responses`;
  const body = JSON.stringify({
    model: config.openaiModel,
    input: [
      { role: "system", content: options.systemPrompt },
      { role: "user", content: JSON.stringify(options.input) }
    ],
    text: {
      format: {
        type: "json_schema",
        name: options.schemaName,
        strict: true,
        schema: options.schema
      }
    }
  });
  const startedAtMs = Date.now();

  console.log(
    `[${new Date().toISOString()}] openai request -> POST ${url} (${options.label}, model ${config.openaiModel}, schema ${options.schemaName}, ${Math.round(body.length / 1024 * 10) / 10} KB body)`
  );

  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openaiApiKey}`
      },
      body,
      signal: AbortSignal.timeout(config.openaiTimeoutMs)
    });
  } catch (error) {
    const elapsedMs = Date.now() - startedAtMs;
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      console.warn(`[${new Date().toISOString()}] openai request timed out after ${elapsedMs} ms (${options.label})`);
      throw new Error("OpenAI request timed out");
    }

    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[${new Date().toISOString()}] openai request failed after ${elapsedMs} ms (${options.label}): ${message}`);
    throw new Error(`OpenAI request failed: ${message}`);
  }

  const rawBody = await response.text();
  const elapsedMs = Date.now() - startedAtMs;

  if (!response.ok) {
    const message = describeOpenAiError(rawBody, response.status);
    console.warn(
      `[${new Date().toISOString()}] openai response <- ${response.status} in ${elapsedMs} ms (${options.label}): ${message}`
    );
    throw new Error(`OpenAI request failed: ${message}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.warn(`[${new Date().toISOString()}] openai response <- 200 in ${elapsedMs} ms (${options.label}) but the body is not JSON`);
    throw new Error("OpenAI returned a malformed response");
  }

  console.log(
    `[${new Date().toISOString()}] openai response <- ${response.status} in ${elapsedMs} ms (${options.label}, ${describeTokenUsage(payload)})`
  );

  const status = (payload as { status?: string }).status;
  if (status === "incomplete") {
    const reason = (payload as { incomplete_details?: { reason?: string } }).incomplete_details?.reason ?? "unknown reason";
    throw new Error(`OpenAI stopped early (${reason})`);
  }

  const content = extractResponseText(payload);
  if (!content.trim()) {
    throw new Error("OpenAI returned an empty response");
  }

  try {
    return JSON.parse(content);
  } catch {
    throw new Error("OpenAI returned a plan that is not valid JSON");
  }
}

async function requestTabGroupSuggestion(tabs: SuggestionTab[], rules: string, config: Config): Promise<unknown> {
  return requestJsonFromOpenAi(config, {
    label: `window plan for ${tabs.length} tabs${rules ? " with user rules" : ""}`,
    systemPrompt: withUserRules(GROUPING_SYSTEM_PROMPT, rules),
    input: { colors: TAB_GROUP_COLORS, tabs },
    schemaName: "tab_group_plan",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["groups"],
      properties: {
        groups: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "color", "tabIds"],
            properties: {
              title: { type: "string" },
              color: { type: "string", enum: TAB_GROUP_COLORS },
              tabIds: { type: "array", items: { type: "integer" } }
            }
          }
        }
      }
    }
  });
}

async function requestGroupForTab(
  tab: ChoiceTab,
  groups: CandidateGroup[],
  rules: string,
  config: Config
): Promise<unknown> {
  return requestJsonFromOpenAi(config, {
    label: `group choice among ${groups.length} groups${rules ? " with user rules" : ""}`,
    systemPrompt: withUserRules(SMART_GROUP_SYSTEM_PROMPT, rules),
    input: { tab, groups },
    schemaName: "tab_group_choice",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["groupId", "confidence", "reason", "alternatives"],
      properties: {
        groupId: { type: ["integer", "null"] },
        confidence: { type: "number" },
        reason: { type: "string" },
        alternatives: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["groupId", "confidence"],
            properties: {
              groupId: { type: "integer" },
              confidence: { type: "number" }
            }
          }
        }
      }
    }
  });
}

function sanitizeSuggestedGroups(rawPlan: unknown, knownTabIds: Set<number>): SuggestedGroup[] {
  const rawGroups = (rawPlan as { groups?: unknown })?.groups;
  if (!Array.isArray(rawGroups)) {
    return [];
  }

  const usedTabIds = new Set<number>();
  const groups: SuggestedGroup[] = [];

  rawGroups.forEach((rawGroup, index) => {
    const candidate = rawGroup as { title?: unknown; color?: unknown; tabIds?: unknown };
    const title = typeof candidate.title === "string" ? candidate.title.trim().slice(0, MAX_GROUP_TITLE_LENGTH) : "";
    if (!title) {
      return;
    }

    const tabIds = (Array.isArray(candidate.tabIds) ? candidate.tabIds : [])
      .map((tabId) => Number(tabId))
      .filter((tabId) => Number.isInteger(tabId) && knownTabIds.has(tabId) && !usedTabIds.has(tabId));

    if (tabIds.length < 2) {
      return;
    }

    tabIds.forEach((tabId) => usedTabIds.add(tabId));
    groups.push({
      title,
      color:
        typeof candidate.color === "string" && TAB_GROUP_COLORS.includes(candidate.color)
          ? candidate.color
          : TAB_GROUP_COLORS[(index % (TAB_GROUP_COLORS.length - 1)) + 1] ?? "grey",
      tabIds
    });
  });

  return groups;
}

async function handleSuggestGroups(request: IncomingMessage, response: ServerResponse, config: Config): Promise<void> {
  if (!config.openaiApiKey) {
    sendJson(response, 400, {
      ok: false,
      error: "OPENAI_API_KEY is not set in the Tabcoach server .env"
    });
    return;
  }

  const body = await readJsonBody(request);
  const payload = body as SuggestGroupsPayload;
  const tabs = sanitizeSuggestionTabs(payload.tabs);

  if (tabs.length < 2) {
    sendJson(response, 400, {
      ok: false,
      error: "Not enough groupable tabs in this window"
    });
    return;
  }

  const rawPlan = await requestTabGroupSuggestion(tabs, sanitizeUserRules(payload.rules), config);
  const groups = sanitizeSuggestedGroups(rawPlan, new Set(tabs.map((tab) => tab.id)));

  console.log(
    `[${new Date().toISOString()}] group suggestion from ${payload.source ?? "unknown"}: ${tabs.length} tabs, ${groups.length} groups (${config.openaiModel})`
  );

  if (groups.length === 0) {
    sendJson(response, 502, {
      ok: false,
      error: "OpenAI did not suggest any usable groups"
    });
    return;
  }

  sendJson(response, 200, {
    ok: true,
    model: config.openaiModel,
    groups
  });
}

function sanitizeGroupSites(rawSites: unknown): GroupSite[] {
  if (!Array.isArray(rawSites)) {
    return [];
  }

  return rawSites
    .map((rawSite) => {
      const candidate = rawSite as { host?: unknown; count?: unknown };
      const host = typeof candidate.host === "string" ? candidate.host.trim().slice(0, 80) : "";
      const count = Number(candidate.count);
      return host ? { host, count: Number.isFinite(count) && count > 0 ? Math.floor(count) : 1 } : null;
    })
    .filter((site): site is GroupSite => site !== null)
    .slice(0, MAX_GROUP_SITES);
}

function sanitizeGroupSampleTabs(rawTabs: unknown): GroupSampleTab[] {
  if (!Array.isArray(rawTabs)) {
    return [];
  }

  return rawTabs
    .map((rawTab) => {
      const candidate = rawTab as { title?: unknown; host?: unknown };
      const title = typeof candidate.title === "string" ? candidate.title.slice(0, MAX_GROUPING_TITLE_LENGTH) : "";
      const host = typeof candidate.host === "string" ? candidate.host.slice(0, 80) : "";
      return title || host ? { title, host } : null;
    })
    .filter((tab): tab is GroupSampleTab => tab !== null)
    .slice(0, MAX_GROUP_SAMPLE_TITLES);
}

function sanitizeCandidateGroups(rawGroups: unknown): CandidateGroup[] {
  if (!Array.isArray(rawGroups)) {
    return [];
  }

  const seenIds = new Set<number>();

  return rawGroups
    .map((rawGroup) => {
      const candidate = rawGroup as {
        id?: unknown;
        title?: unknown;
        color?: unknown;
        tabCount?: unknown;
        topSites?: unknown;
        sampleTabs?: unknown;
        sampleTitles?: unknown;
      };
      const id = Number(candidate?.id);
      const title = typeof candidate.title === "string" ? candidate.title.trim().slice(0, MAX_GROUP_TITLE_LENGTH) : "";
      if (!Number.isInteger(id) || seenIds.has(id) || !title) {
        return null;
      }

      const tabCount = Number(candidate.tabCount);
      const legacySamples = (Array.isArray(candidate.sampleTitles) ? candidate.sampleTitles : [])
        .filter((sample): sample is string => typeof sample === "string")
        .map((sample) => ({ title: sample.slice(0, MAX_GROUPING_TITLE_LENGTH), host: "" }));

      seenIds.add(id);
      return {
        id,
        title,
        ...(typeof candidate.color === "string" ? { color: candidate.color.slice(0, 20) } : {}),
        ...(Number.isFinite(tabCount) && tabCount > 0 ? { tabCount: Math.floor(tabCount) } : {}),
        topSites: sanitizeGroupSites(candidate.topSites),
        sampleTabs: candidate.sampleTabs === undefined
          ? legacySamples.slice(0, MAX_GROUP_SAMPLE_TITLES)
          : sanitizeGroupSampleTabs(candidate.sampleTabs)
      };
    })
    .filter((group): group is CandidateGroup => group !== null)
    .slice(0, MAX_CANDIDATE_GROUPS);
}

function sanitizeChoiceTab(rawTab: unknown): ChoiceTab | null {
  const candidate = rawTab as {
    title?: unknown;
    url?: unknown;
    currentGroupId?: unknown;
    openedFrom?: { title?: unknown; host?: unknown; groupId?: unknown } | null;
  };

  const title = typeof candidate?.title === "string" ? candidate.title.slice(0, MAX_GROUPING_TITLE_LENGTH) : "";
  const url = typeof candidate?.url === "string" ? candidate.url.slice(0, MAX_GROUPING_URL_LENGTH) : "";
  if (!title && !url) {
    return null;
  }

  const currentGroupId = Number(candidate?.currentGroupId);
  const opener = candidate?.openedFrom;
  const openerGroupId = Number(opener?.groupId);

  return {
    title,
    url,
    currentGroupId: Number.isInteger(currentGroupId) ? currentGroupId : null,
    openedFrom: opener
      ? {
          title: typeof opener.title === "string" ? opener.title.slice(0, MAX_GROUPING_TITLE_LENGTH) : "",
          host: typeof opener.host === "string" ? opener.host.slice(0, 80) : "",
          groupId: Number.isInteger(openerGroupId) ? openerGroupId : null
        }
      : null
  };
}

async function handleSuggestGroupForTab(request: IncomingMessage, response: ServerResponse, config: Config): Promise<void> {
  if (!config.openaiApiKey) {
    sendJson(response, 400, {
      ok: false,
      error: "OPENAI_API_KEY is not set in the Tabcoach server .env"
    });
    return;
  }

  const body = await readJsonBody(request);
  const payload = body as SuggestGroupForTabPayload;
  const tab = sanitizeChoiceTab(payload.tab);
  const groups = sanitizeCandidateGroups(payload.groups);

  if (!tab) {
    sendJson(response, 400, { ok: false, error: "Missing tab to place" });
    return;
  }

  if (groups.length === 0) {
    sendJson(response, 400, { ok: false, error: "No candidate groups in this window" });
    return;
  }

  const rawChoice = (await requestGroupForTab(tab, groups, sanitizeUserRules(payload.rules), config)) as {
    groupId?: unknown;
    confidence?: unknown;
    reason?: unknown;
    alternatives?: unknown;
  };
  const groupIds = new Set(groups.map((group) => group.id));
  const chosenGroupId = Number(rawChoice?.groupId);
  const rawConfidence = Number(rawChoice?.confidence);
  const confidence = Number.isFinite(rawConfidence) ? Math.min(Math.max(rawConfidence, 0), 1) : 0;
  const reason = typeof rawChoice?.reason === "string" ? rawChoice.reason.trim().slice(0, 120) : "";
  const isKnownGroup = Number.isInteger(chosenGroupId) && groupIds.has(chosenGroupId);
  const meetsThreshold = confidence >= config.smartGroupMinConfidence;
  const groupId = isKnownGroup && meetsThreshold ? chosenGroupId : null;

  const groupTitleById = new Map(groups.map((group) => [group.id, group.title]));
  const alternatives = (Array.isArray(rawChoice?.alternatives) ? rawChoice.alternatives : [])
    .map((raw) => {
      const candidate = raw as { groupId?: unknown; confidence?: unknown };
      const altGroupId = Number(candidate?.groupId);
      const altConfidence = Number(candidate?.confidence);
      if (!Number.isInteger(altGroupId) || !groupIds.has(altGroupId)) {
        return null;
      }

      return {
        groupId: altGroupId,
        title: groupTitleById.get(altGroupId) ?? "",
        confidence: Number.isFinite(altConfidence) ? Math.min(Math.max(altConfidence, 0), 1) : 0
      };
    })
    .filter((alternative): alternative is { groupId: number; title: string; confidence: number } => alternative !== null)
    .slice(0, 3);

  const chosenTitle = isKnownGroup ? groupTitleById.get(chosenGroupId) ?? String(chosenGroupId) : "(none)";
  const alternativesLabel = alternatives.length
    ? `, also considered ${alternatives.map((alternative) => `${alternative.title} ${alternative.confidence.toFixed(2)}`).join(", ")}`
    : "";

  console.log(
    `[${new Date().toISOString()}] group choice from ${payload.source ?? "unknown"}: "${tab.title}" (now in ${
      tab.currentGroupId === null ? "no group" : groupTitleById.get(tab.currentGroupId) ?? tab.currentGroupId
    }) -> ${chosenTitle} ${confidence.toFixed(2)}${meetsThreshold ? "" : " [below threshold]"}${alternativesLabel} — ${reason}`
  );

  sendJson(response, 200, {
    ok: true,
    model: config.openaiModel,
    groupId,
    confidence,
    reason,
    alternatives,
    belowThreshold: isKnownGroup && !meetsThreshold
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
      port: config.port
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

  if (request.method === "POST" && request.url === "/api/tab-switch") {
    await handleTabSwitch(request, response, config);
    return;
  }

  if (request.method === "GET" && request.url === "/api/tab-switch-stats") {
    await handleTabSwitchStats(response, config);
    return;
  }

  if (request.method === "POST" && request.url === "/api/tab-event") {
    await handleTabEvent(request, response, config);
    return;
  }

  if (request.method === "POST" && request.url === "/api/suggest-groups") {
    await handleSuggestGroups(request, response, config);
    return;
  }

  if (request.method === "POST" && request.url === "/api/suggest-group-for-tab") {
    await handleSuggestGroupForTab(request, response, config);
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
  loadEnvFile();
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
  console.log(JSON.stringify(describeConfig(config), null, 2));
  console.log(`POST tab snapshots to http://${config.host}:${config.port}/api/sync`);
  console.log(`POST tab switches to http://${config.host}:${config.port}/api/tab-switch`);
  console.log(`GET tab switch stats from http://${config.host}:${config.port}/api/tab-switch-stats`);
  console.log(`POST tab events to http://${config.host}:${config.port}/api/tab-event`);
  console.log(`GET desktop apps from http://${config.host}:${config.port}/api/desktop-apps`);
  console.log(`POST desktop app launches to http://${config.host}:${config.port}/api/desktop-apps/launch`);
  console.log(`POST tab group suggestions to http://${config.host}:${config.port}/api/suggest-groups`);
  console.log(`POST single tab group choices to http://${config.host}:${config.port}/api/suggest-group-for-tab`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
