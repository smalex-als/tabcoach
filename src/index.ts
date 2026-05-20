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
    id: "iterm",
    label: "iTerm",
    macAppName: "iTerm"
  },
  {
    id: "intellij-idea",
    label: "IntelliJ IDEA",
    macAppName: "IntelliJ IDEA"
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

function loadConfig(): Config {
  return {
    host: process.env.HOST ?? "127.0.0.1",
    port: readNumber("PORT", 3847),
    tabSwitchLogPath: process.env.TAB_SWITCH_LOG_PATH ?? "tab-switch-log.jsonl",
    tabEventLogPath: process.env.TAB_EVENT_LOG_PATH ?? "tabcoach-events.jsonl",
    desktopApps: readDesktopApps(),
    dropHash: readBoolean("DROP_HASH", true),
    sortQueryParams: readBoolean("SORT_QUERY_PARAMS", true),
    stripTrackingParams: readBoolean("STRIP_TRACKING_PARAMS", true)
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
  console.log(JSON.stringify(config, null, 2));
  console.log(`POST tab snapshots to http://${config.host}:${config.port}/api/sync`);
  console.log(`POST tab switches to http://${config.host}:${config.port}/api/tab-switch`);
  console.log(`GET tab switch stats from http://${config.host}:${config.port}/api/tab-switch-stats`);
  console.log(`POST tab events to http://${config.host}:${config.port}/api/tab-event`);
  console.log(`GET desktop apps from http://${config.host}:${config.port}/api/desktop-apps`);
  console.log(`POST desktop app launches to http://${config.host}:${config.port}/api/desktop-apps/launch`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
