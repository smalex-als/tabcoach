const DEFAULT_SETTINGS = {
  localServerEnabled: true,
  serverBaseUrl: "http://127.0.0.1:3847",
  autoCloseDuplicates: true,
  fetchDiagnostics: true,
  syncIntervalMinutes: 1,
  switcherOpenLeft: false,
  showRecentTabIndent: true,
  badgeMode: "both",
  smartGroupMode: "off",
  smartGroupRules: "",
  workspaceLaunchGroups: []
};
const SYNC_ENDPOINT = "/api/sync";
const TAB_SWITCH_LOG_ENDPOINT = "/api/tab-switch";
const TAB_SWITCH_STATS_ENDPOINT = "/api/tab-switch-stats";
const TAB_EVENT_LOG_ENDPOINT = "/api/tab-event";
const DESKTOP_APPS_ENDPOINT = "/api/desktop-apps";
const DESKTOP_APP_LAUNCH_ENDPOINT = "/api/desktop-apps/launch";
const SUGGEST_GROUPS_ENDPOINT = "/api/suggest-groups";
const SUGGEST_GROUP_FOR_TAB_ENDPOINT = "/api/suggest-group-for-tab";
const SYNC_ALARM = "tabcoach-sync";
const SYNC_DEBOUNCE_MS = 1500;
const DEFAULT_SWITCHER_POPUP_WIDTH = 940;
const DEFAULT_SWITCHER_POPUP_HEIGHT = 720;
const LEFT_SWITCHER_POPUP_WIDTH = 800;
const NEW_TAB_DUPLICATE_GRACE_MS = 3 * 60 * 1000;
const TRANSIENT_RETRY_ATTEMPTS = 4;
const TRANSIENT_RETRY_DELAY_MS = 500;
const NUMERIC_BOOKMARK_BADGE_MS = 1500;
const ACTION_TITLE = "Tabcoach";
const BACKGROUND_BUILD = "smart-group-9";
const TAB_SWITCHER_PAGE = "tab-switcher.html";
const GET_TAB_SWITCHER_ITEMS_MESSAGE = "tabcoach:get-tab-switcher-items";
const CREATE_TAB_MESSAGE = "tabcoach:create-tab";
const DUPLICATE_TAB_MESSAGE = "tabcoach:duplicate-tab";
const JUMP_NUMERIC_BOOKMARK_MESSAGE = "tabcoach:jump-numeric-bookmark";
const POPUP_NUMERIC_BOOKMARK_COMMAND_MESSAGE = "tabcoach:popup-numeric-bookmark-command";
const FOCUS_TAB_SWITCHER_SEARCH_MESSAGE = "tabcoach:focus-tab-switcher-search";
const REFRESH_TAB_SWITCHER_MESSAGE = "tabcoach:refresh-tab-switcher";
const NUMERIC_BOOKMARKS_KEY = "numericBookmarks";
const SWITCH_TAB_MESSAGE = "tabcoach:switch-tab";
const CLOSE_TAB_MESSAGE = "tabcoach:close-tab";
const MOVE_TAB_MESSAGE = "tabcoach:move-tab";
const CREATE_GROUP_MESSAGE = "tabcoach:create-group";
const SET_TAB_GROUP_MESSAGE = "tabcoach:set-tab-group";
const SET_GROUP_COLLAPSED_MESSAGE = "tabcoach:set-group-collapsed";
const RENAME_GROUP_MESSAGE = "tabcoach:rename-group";
const CLOSE_GROUP_MESSAGE = "tabcoach:close-group";
const OPEN_GROUP_BOOKMARK_MESSAGE = "tabcoach:open-group-bookmark";
const TOGGLE_BOOKMARK_MESSAGE = "tabcoach:toggle-bookmark";
const COPY_TAB_URL_MESSAGE = "tabcoach:copy-tab-url";
const LOG_TAB_EVENT_MESSAGE = "tabcoach:log-tab-event";
const GET_TAB_SWITCH_STATS_MESSAGE = "tabcoach:get-tab-switch-stats";
const GET_DESKTOP_APPS_MESSAGE = "tabcoach:get-desktop-apps";
const LAUNCH_DESKTOP_APP_MESSAGE = "tabcoach:launch-desktop-app";
const GET_APP_BOOKMARKS_MESSAGE = "tabcoach:get-app-bookmarks";
const ADD_APP_BOOKMARK_MESSAGE = "tabcoach:add-app-bookmark";
const OPEN_APP_BOOKMARK_MESSAGE = "tabcoach:open-app-bookmark";
const GET_WORKSPACE_LAUNCH_GROUPS_MESSAGE = "tabcoach:get-workspace-launch-groups";
const LAUNCH_WORKSPACE_LAUNCH_GROUP_MESSAGE = "tabcoach:launch-workspace-launch-group";
const SUGGEST_TAB_GROUPS_MESSAGE = "tabcoach:suggest-tab-groups";
const APPLY_TAB_GROUPS_MESSAGE = "tabcoach:apply-tab-groups";
const SUGGEST_GROUP_FOR_TAB_MESSAGE = "tabcoach:suggest-group-for-tab";
const RESOLVE_SMART_GROUP_PROMPT_MESSAGE = "tabcoach:resolve-smart-group-prompt";
const MAX_GROUPING_TABS = 200;
const MAX_GROUPING_TITLE_LENGTH = 120;
const MAX_GROUPING_URL_LENGTH = 180;
const TAB_GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
const MAX_SMART_GROUP_SAMPLE_TITLES = 12;
const MAX_SMART_GROUP_SITES = 5;
const MAX_SMART_GROUP_RULES_LENGTH = 2000;
const MAX_SMART_GROUP_REQUESTS_IN_FLIGHT = 3;
const SMART_GROUP_PROMPTS_KEY = "smartGroupPrompts";
const SMART_GROUP_NOTIFICATION_PREFIX = "tabcoach-smart-group-";
const SMART_GROUP_PROMPT_TTL_MS = 10 * 60 * 1000;
const SMART_GROUP_MODES = new Set(["off", "ask", "auto"]);
const BOOKMARK_FOLDER_TITLE = "Tabcoach";
const APP_BOOKMARK_FOLDER_TITLE = "App Bookmarks";
const ASSIGN_NUMERIC_BOOKMARK_COMMAND_PREFIX = "assign-numeric-bookmark-";
const JUMP_NUMERIC_BOOKMARK_COMMAND_PREFIX = "jump-numeric-bookmark-";
const PREVIOUS_TAB_COMMAND = "previous-tab";
const NEXT_TAB_IN_HISTORY_COMMAND = "next-tab-in-history";
const TAB_ACTIVATION_HISTORY_KEY = "tabActivationHistory";
const RECENT_TAB_CREATIONS_KEY = "recentTabCreations";
const TAB_FORWARD_HISTORY_KEY = "tabForwardHistory";
const MAX_TAB_ACTIVATION_HISTORY_PER_WINDOW = 25;

const TRACKING_PARAMS = new Set([
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

let pendingSyncTimer = null;
let badgeResetTimer = null;
let tabSwitcherPopupWindowId = null;
let tabSwitcherSourceWindowId = null;
let settingsCache = null;
let tabActivationHistoryLoaded = false;
let tabActivationHistoryLoadPromise = null;
let lastServerHealth = {
  ok: null,
  checkedAt: null,
  message: "Not checked yet",
  badgeText: ""
};
const recentTabCreations = new Map();
const smartGroupEvaluatedTabIds = new Set();
let smartGroupRequestsInFlight = 0;
const tabActivationHistoryByWindowId = new Map();
const tabForwardHistoryByWindowId = new Map();
const suppressedActivationHistoryByWindowId = new Map();

function sanitizeWorkspaceUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    return "";
  }

  try {
    const parsed = new URL(rawUrl.trim());
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "";
    }

    return parsed.toString();
  } catch {
    return "";
  }
}

function getWorkspaceLaunchGroupId(group, index) {
  if (typeof group?.id === "string" && group.id.trim().length > 0) {
    return group.id.trim();
  }

  if (typeof group?.label === "string" && group.label.trim().length > 0) {
    const slug = group.label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug) {
      return slug;
    }
  }

  return `workspace-${index + 1}`;
}

function sanitizeWorkspaceLaunchGroups(groups) {
  if (!Array.isArray(groups)) {
    return [];
  }

  return groups
    .map((group, index) => {
      const label = typeof group?.label === "string" ? group.label.trim() : "";
      const urls = Array.isArray(group?.urls)
        ? [...new Set(group.urls.map(sanitizeWorkspaceUrl).filter(Boolean))]
        : [];

      return {
        id: getWorkspaceLaunchGroupId(group, index),
        label,
        urls
      };
    })
    .filter((group) => group.label && group.urls.length > 0);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeSettings(settings) {
  const syncIntervalMinutes = Number(settings.syncIntervalMinutes);
  const serverBaseUrl = typeof settings.serverBaseUrl === "string" && settings.serverBaseUrl.trim()
    ? settings.serverBaseUrl.trim().replace(/\/+$/, "")
    : DEFAULT_SETTINGS.serverBaseUrl;
  const badgeModes = new Set(["both", "health", "duplicates"]);

  return {
    localServerEnabled: settings.localServerEnabled !== false,
    serverBaseUrl,
    autoCloseDuplicates: Boolean(settings.autoCloseDuplicates),
    fetchDiagnostics: Boolean(settings.fetchDiagnostics),
    syncIntervalMinutes: Number.isFinite(syncIntervalMinutes) && syncIntervalMinutes >= 1 ? syncIntervalMinutes : DEFAULT_SETTINGS.syncIntervalMinutes,
    switcherOpenLeft: Boolean(settings.switcherOpenLeft),
    showRecentTabIndent: settings.showRecentTabIndent !== false,
    badgeMode: badgeModes.has(settings.badgeMode) ? settings.badgeMode : DEFAULT_SETTINGS.badgeMode,
    smartGroupMode: SMART_GROUP_MODES.has(settings.smartGroupMode) ? settings.smartGroupMode : DEFAULT_SETTINGS.smartGroupMode,
    smartGroupRules: typeof settings.smartGroupRules === "string" ? settings.smartGroupRules.trim().slice(0, MAX_SMART_GROUP_RULES_LENGTH) : "",
    workspaceLaunchGroups: sanitizeWorkspaceLaunchGroups(settings.workspaceLaunchGroups)
  };
}

async function getSettings() {
  if (settingsCache) {
    return settingsCache;
  }

  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  settingsCache = sanitizeSettings(stored);
  return settingsCache;
}

function getLocalServerPermissionPattern(settings) {
  return `${settings.serverBaseUrl}/*`;
}

function getServerUrl(settings, endpoint) {
  return `${settings.serverBaseUrl}${endpoint}`;
}

async function createSyncAlarm() {
  const settings = await getSettings();
  await chrome.alarms.clear(SYNC_ALARM);
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: settings.syncIntervalMinutes });
}

async function hasLocalServerHostPermission() {
  try {
    if (!chrome.permissions?.contains) {
      return null;
    }

    const settings = await getSettings();
    return await chrome.permissions.contains({ origins: [getLocalServerPermissionPattern(settings)] });
  } catch (error) {
    console.warn("Tabcoach local fetch permission check failed", error);
    return null;
  }
}

async function fetchLocalServer(label, endpoint, options = {}, settings = null) {
  const activeSettings = settings ?? (await getSettings());
  const method = options.method ?? "GET";
  const hasHostPermission = await hasLocalServerHostPermission();
  const url = getServerUrl(activeSettings, endpoint);

  if (activeSettings.fetchDiagnostics) {
    console.info("Tabcoach local fetch start", {
      label,
      method,
      url,
      hasHostPermission
    });
  }

  try {
    const response = await fetch(url, options);
    if (activeSettings.fetchDiagnostics) {
      console.info("Tabcoach local fetch response", {
        label,
        method,
        url,
        hasHostPermission,
        ok: response.ok,
        status: response.status,
        statusText: response.statusText
      });
    }
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("Tabcoach local fetch failed", {
      label,
      method,
      url,
      hasHostPermission,
      likelyAccessDenied: hasHostPermission === false || message.includes("Failed to fetch"),
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: message
    });
    throw error;
  }
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function getTabHistoryStorageArea() {
  return chrome.storage.session ?? chrome.storage.local;
}

function serializeTabActivationHistory() {
  return Object.fromEntries(
    [...tabActivationHistoryByWindowId.entries()].map(([windowId, tabIds]) => [String(windowId), tabIds])
  );
}

function serializeTabForwardHistory() {
  return Object.fromEntries(
    [...tabForwardHistoryByWindowId.entries()].map(([windowId, tabIds]) => [String(windowId), tabIds])
  );
}

async function saveTabActivationHistory() {
  await getTabHistoryStorageArea().set({
    [TAB_ACTIVATION_HISTORY_KEY]: serializeTabActivationHistory(),
    [TAB_FORWARD_HISTORY_KEY]: serializeTabForwardHistory()
  });
}

function loadSerializedTabHistory(rawHistory, targetMap) {
  targetMap.clear();
  if (typeof rawHistory !== "object" || rawHistory === null) {
    return;
  }

  for (const [windowIdText, tabIds] of Object.entries(rawHistory)) {
    const windowId = Number(windowIdText);
    if (!Number.isInteger(windowId) || !Array.isArray(tabIds)) {
      continue;
    }

    const cleanTabIds = tabIds
      .filter((tabId) => Number.isInteger(tabId))
      .slice(0, MAX_TAB_ACTIVATION_HISTORY_PER_WINDOW);

    if (cleanTabIds.length > 0) {
      targetMap.set(windowId, cleanTabIds);
    }
  }
}

function loadSerializedTabActivationHistory(rawHistory) {
  loadSerializedTabHistory(rawHistory, tabActivationHistoryByWindowId);
}

function loadSerializedTabForwardHistory(rawHistory) {
  loadSerializedTabHistory(rawHistory, tabForwardHistoryByWindowId);
}

async function seedActiveTabsInHistory() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  let changed = false;

  for (const window of windows) {
    if (typeof window.id !== "number") {
      continue;
    }

    const activeTab = window.tabs?.find((tab) => tab.active && typeof tab.id === "number" && !isTabSwitcherUrl(tab.url));
    if (!activeTab) {
      continue;
    }

    const history = tabActivationHistoryByWindowId.get(window.id) ?? [];
    if (history[0] === activeTab.id) {
      continue;
    }

    tabActivationHistoryByWindowId.set(window.id, [
      activeTab.id,
      ...history.filter((tabId) => tabId !== activeTab.id)
    ].slice(0, MAX_TAB_ACTIVATION_HISTORY_PER_WINDOW));
    changed = true;
  }

  if (changed) {
    await saveTabActivationHistory();
  }
}

async function ensureTabActivationHistoryLoaded() {
  if (tabActivationHistoryLoaded) {
    return;
  }

  if (!tabActivationHistoryLoadPromise) {
    tabActivationHistoryLoadPromise = (async () => {
      const stored = await getTabHistoryStorageArea().get({
        [TAB_ACTIVATION_HISTORY_KEY]: {},
        [TAB_FORWARD_HISTORY_KEY]: {}
      });
      loadSerializedTabActivationHistory(stored[TAB_ACTIVATION_HISTORY_KEY]);
      loadSerializedTabForwardHistory(stored[TAB_FORWARD_HISTORY_KEY]);
      await seedActiveTabsInHistory();
      tabActivationHistoryLoaded = true;
    })().finally(() => {
      tabActivationHistoryLoadPromise = null;
    });
  }

  await tabActivationHistoryLoadPromise;
}

async function isNormalBrowserTab(tab, windowId) {
  if (!tab || typeof tab.id !== "number" || typeof windowId !== "number") {
    return false;
  }

  if (windowId === tabSwitcherPopupWindowId || isTabSwitcherUrl(tab.url)) {
    return false;
  }

  try {
    const window = await chrome.windows.get(windowId);
    return window?.type === "normal";
  } catch (error) {
    console.warn("Tabcoach window lookup failed during history update", error);
    return false;
  }
}

async function recordActivatedTab(tabId, windowId, { clearForwardHistory = true } = {}) {
  if (!Number.isInteger(tabId) || !Number.isInteger(windowId)) {
    return;
  }

  await ensureTabActivationHistoryLoaded();

  if (suppressedActivationHistoryByWindowId.get(windowId) === tabId) {
    suppressedActivationHistoryByWindowId.delete(windowId);
    return;
  }

  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    console.warn("Tabcoach activated tab lookup failed", error);
    return;
  }

  if (!(await isNormalBrowserTab(tab, windowId))) {
    return;
  }

  const history = tabActivationHistoryByWindowId.get(windowId) ?? [];
  tabActivationHistoryByWindowId.set(windowId, [
    tabId,
    ...history.filter((historyTabId) => historyTabId !== tabId)
  ].slice(0, MAX_TAB_ACTIVATION_HISTORY_PER_WINDOW));

  if (clearForwardHistory) {
    tabForwardHistoryByWindowId.delete(windowId);
  }

  await saveTabActivationHistory();
}

async function removeTabFromActivationHistory(tabId, windowId = null) {
  if (!Number.isInteger(tabId)) {
    return;
  }

  await ensureTabActivationHistoryLoaded();
  let changed = false;
  const entries = Number.isInteger(windowId)
    ? [[windowId, tabActivationHistoryByWindowId.get(windowId) ?? []]]
    : [...tabActivationHistoryByWindowId.entries()];

  for (const [historyWindowId, history] of entries) {
    const nextHistory = history.filter((historyTabId) => historyTabId !== tabId);
    if (nextHistory.length !== history.length) {
      changed = true;
      if (nextHistory.length > 0) {
        tabActivationHistoryByWindowId.set(historyWindowId, nextHistory);
      } else {
        tabActivationHistoryByWindowId.delete(historyWindowId);
      }
    }

    const forwardHistory = tabForwardHistoryByWindowId.get(historyWindowId) ?? [];
    const nextForwardHistory = forwardHistory.filter((historyTabId) => historyTabId !== tabId);
    if (nextForwardHistory.length !== forwardHistory.length) {
      changed = true;
      if (nextForwardHistory.length > 0) {
        tabForwardHistoryByWindowId.set(historyWindowId, nextForwardHistory);
      } else {
        tabForwardHistoryByWindowId.delete(historyWindowId);
      }
    }
  }

  if (changed) {
    await saveTabActivationHistory();
  }
}

async function clearWindowActivationHistory(windowId) {
  if (!Number.isInteger(windowId)) {
    return;
  }

  await ensureTabActivationHistoryLoaded();
  suppressedActivationHistoryByWindowId.delete(windowId);
  if (!tabActivationHistoryByWindowId.delete(windowId)) {
    if (!tabForwardHistoryByWindowId.delete(windowId)) {
      return;
    }
  } else {
    tabForwardHistoryByWindowId.delete(windowId);
  }

  await saveTabActivationHistory();
}

async function setServerHealth(ok, message, badgeText = "") {
  const settings = await getSettings();
  const visibleBadgeText = ok
    ? settings.badgeMode === "health"
      ? "OK"
      : settings.badgeMode === "duplicates"
        ? badgeText
        : badgeText || "OK"
    : "ERR";

  lastServerHealth = {
    ok,
    checkedAt: new Date().toISOString(),
    message,
    badgeText: visibleBadgeText
  };

  if (ok) {
    await chrome.action.setBadgeBackgroundColor({ color: badgeText ? "#b42318" : "#15803d" });
    await chrome.action.setBadgeText({ text: visibleBadgeText });
    await chrome.action.setTitle({ title: `${ACTION_TITLE}: server ok` });
    return;
  }

  await chrome.action.setBadgeBackgroundColor({ color: "#b42318" });
  await chrome.action.setBadgeText({ text: "ERR" });
  await chrome.action.setTitle({ title: `${ACTION_TITLE}: server error - ${message}` });
}

async function setLocalModeBadge(badgeText = "") {
  const settings = await getSettings();
  const visibleBadgeText =
    settings.badgeMode === "health" ? "OFF" : settings.badgeMode === "duplicates" ? badgeText : badgeText || "";

  lastServerHealth = {
    ok: true,
    checkedAt: new Date().toISOString(),
    message: "Local server disabled",
    badgeText: visibleBadgeText
  };

  await chrome.action.setBadgeBackgroundColor({ color: badgeText ? "#b42318" : "#4b5563" });
  await chrome.action.setBadgeText({ text: visibleBadgeText });
  await chrome.action.setTitle({ title: `${ACTION_TITLE}: local server disabled` });
}

async function restoreServerHealthBadge() {
  if (lastServerHealth.ok === true) {
    await chrome.action.setBadgeText({ text: lastServerHealth.badgeText });
    if (lastServerHealth.message === "Local server disabled") {
      await chrome.action.setBadgeBackgroundColor({ color: lastServerHealth.badgeText ? "#b42318" : "#4b5563" });
      await chrome.action.setTitle({ title: `${ACTION_TITLE}: local server disabled` });
      return;
    }

    await chrome.action.setBadgeBackgroundColor({ color: lastServerHealth.badgeText ? "#b42318" : "#15803d" });
    await chrome.action.setTitle({ title: `${ACTION_TITLE}: server ok` });
    return;
  }

  if (lastServerHealth.ok === false) {
    await chrome.action.setBadgeBackgroundColor({ color: "#b42318" });
    await chrome.action.setBadgeText({ text: "ERR" });
    await chrome.action.setTitle({ title: `${ACTION_TITLE}: server error - ${lastServerHealth.message}` });
    return;
  }

  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: ACTION_TITLE });
}

function logDuplicateGroups(duplicateGroups) {
  if (!Array.isArray(duplicateGroups) || duplicateGroups.length === 0) {
    return;
  }

  console.info(
    "Tabcoach duplicate groups",
    duplicateGroups.map((group) => ({
      normalizedUrl: group.normalizedUrl,
      count: group.count,
      tabs: Array.isArray(group.tabs)
        ? group.tabs.map((tab) => ({
            title: tab.title,
            url: tab.url,
            windowId: tab.windowId,
            tabId: tab.tabId,
            active: tab.active,
            pinned: tab.pinned
          }))
        : []
    }))
  );
}

function isTransientChromeEditError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Tabs cannot be edited right now") || message.includes("Tabs can only be moved to and from normal windows");
}

async function withTransientRetry(operation, label) {
  let lastError = null;

  for (let attempt = 1; attempt <= TRANSIENT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isTransientChromeEditError(error) || attempt === TRANSIENT_RETRY_ATTEMPTS) {
        throw error;
      }

      console.warn(`Tabcoach transient failure during ${label}, retry ${attempt}/${TRANSIENT_RETRY_ATTEMPTS}`, error);
      await delay(TRANSIENT_RETRY_DELAY_MS);
    }
  }

  throw lastError;
}

function normalizeTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? "",
    url: tab.url ?? "",
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned)
  };
}

function markTabCreated(tabId) {
  if (typeof tabId !== "number") {
    return;
  }

  const createdAt = Date.now();
  recentTabCreations.set(tabId, createdAt);
  void persistTabCreation(tabId, createdAt);
}

async function persistTabCreation(tabId, createdAt) {
  try {
    const area = getTabHistoryStorageArea();
    const stored = await area.get({ [RECENT_TAB_CREATIONS_KEY]: {} });
    const marks = stored[RECENT_TAB_CREATIONS_KEY] ?? {};
    const cutoff = Date.now() - NEW_TAB_DUPLICATE_GRACE_MS;

    for (const [key, value] of Object.entries(marks)) {
      if (typeof value !== "number" || value <= cutoff) {
        delete marks[key];
      }
    }

    marks[tabId] = createdAt;
    await area.set({ [RECENT_TAB_CREATIONS_KEY]: marks });
  } catch (error) {
    console.warn("Tabcoach tab creation persistence failed", error);
  }
}

// The in-memory map is lost whenever the service worker restarts, so fall back
// to the session-backed marks before deciding a tab is not newly created.
async function isRecentlyCreatedTab(tabId) {
  if (recentTabCreations.has(tabId)) {
    return true;
  }

  try {
    const stored = await getTabHistoryStorageArea().get({ [RECENT_TAB_CREATIONS_KEY]: {} });
    const createdAt = stored[RECENT_TAB_CREATIONS_KEY]?.[tabId];
    return typeof createdAt === "number" && Date.now() - createdAt < NEW_TAB_DUPLICATE_GRACE_MS;
  } catch {
    return false;
  }
}

function cleanupRecentTabCreations() {
  const cutoff = Date.now() - NEW_TAB_DUPLICATE_GRACE_MS;

  for (const [tabId, createdAt] of recentTabCreations.entries()) {
    if (createdAt <= cutoff) {
      recentTabCreations.delete(tabId);
    }
  }
}

function isWithinDuplicateGracePeriod(tab) {
  if (typeof tab.id !== "number") {
    return false;
  }

  cleanupRecentTabCreations();
  const createdAt = recentTabCreations.get(tab.id);
  return typeof createdAt === "number" && Date.now() - createdAt < NEW_TAB_DUPLICATE_GRACE_MS;
}

async function getFocusedWindowId() {
  try {
    const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    return typeof window?.id === "number" ? window.id : null;
  } catch (error) {
    console.warn("Tabcoach focused window lookup failed", error);
    return null;
  }
}

async function collectTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab) => typeof tab.url === "string" && tab.url.length > 0)
    .map(normalizeTab);
}

function normalizeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);

    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();

    if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) {
      parsed.port = "";
    }

    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }

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

    if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    return parsed.toString();
  } catch {
    return rawUrl.trim();
  }
}

function findDuplicateGroups(tabs) {
  const grouped = new Map();

  for (const tab of tabs) {
    if (!tab.url || tab.url.startsWith("chrome://")) {
      continue;
    }

    const normalizedUrl = normalizeUrl(tab.url);
    const entries = grouped.get(normalizedUrl) ?? [];
    entries.push(tab);
    grouped.set(normalizedUrl, entries);
  }

  return [...grouped.entries()]
    .filter(([, groupedTabs]) => groupedTabs.length > 1)
    .map(([normalizedUrl, groupedTabs]) => ({ normalizedUrl, tabs: groupedTabs }));
}

function compareTabsForKeep(left, right) {
  if (left.active !== right.active) {
    return left.active ? -1 : 1;
  }

  if (left.pinned !== right.pinned) {
    return left.pinned ? -1 : 1;
  }

  return (left.id ?? Number.MAX_SAFE_INTEGER) - (right.id ?? Number.MAX_SAFE_INTEGER);
}

async function closeDuplicateTabs(tabs, settings) {
  if (!settings.autoCloseDuplicates) {
    return;
  }

  const duplicateGroups = findDuplicateGroups(tabs);

  for (const group of duplicateGroups) {
    const sortedTabs = [...group.tabs].sort(compareTabsForKeep);
    const tabsToClose = sortedTabs
      .slice(1)
      .filter((tab) => !tab.active && !tab.pinned && typeof tab.id === "number" && !isWithinDuplicateGracePeriod(tab));

    for (const tab of tabsToClose) {
      try {
        await withTransientRetry(() => chrome.tabs.remove(tab.id), "duplicate-close");
        recentTabCreations.delete(tab.id);
      } catch (error) {
        console.warn("Tabcoach close failed", tab, error);
      }
    }
  }
}

async function pushSnapshot(reason) {
  try {
    const settings = await getSettings();
    const tabs = await collectTabs();
    await closeDuplicateTabs(tabs, settings);
    const localDuplicateGroups = findDuplicateGroups(tabs);

    if (!settings.localServerEnabled) {
      const badgeText = localDuplicateGroups.length > 0 ? String(localDuplicateGroups.length) : "";
      await setLocalModeBadge(badgeText);
      return;
    }

    const response = await fetchLocalServer("sync", SYNC_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        source: `chrome-extension:${reason}`,
        capturedAt: new Date().toISOString(),
        tabs
      })
    }, settings);

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }

    const result = await response.json();
    logDuplicateGroups(result.duplicateGroups);
    const badgeText = result.duplicateGroupCount > 0 ? String(result.duplicateGroupCount) : "";
    await setServerHealth(true, `Last sync ok from ${reason}`, badgeText);
  } catch (error) {
    console.error("Tabcoach sync failed", error);
    await setServerHealth(false, getErrorMessage(error));
  }
}

function getTabTitleKey(title) {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

function isWeakTabTitle(title) {
  const normalized = getTabTitleKey(title);
  return normalized === "" || normalized === "new tab" || normalized === "untitled" || normalized === "about:blank" || normalized === "loading...";
}

function getReadablePathSegment(pathname) {
  const segments = pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => !["edit", "view", "pull", "issues", "browse", "d"].includes(segment.toLowerCase()));

  const segment = segments.at(-1);
  if (!segment) {
    return "";
  }

  try {
    return decodeURIComponent(segment).replace(/[-_]+/g, " ").trim();
  } catch {
    return segment.replace(/[-_]+/g, " ").trim();
  }
}

function inferTabTitleHint(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.replace(/^www\./, "");

    const pullRequest = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (pullRequest) {
      return `${pullRequest[1]}/${pullRequest[2]} PR #${pullRequest[3]}`;
    }

    const issue = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (issue) {
      return `${issue[1]}/${issue[2]} issue #${issue[3]}`;
    }

    const searchQuery = parsed.searchParams.get("q") ?? parsed.searchParams.get("query") ?? parsed.searchParams.get("search");
    if (searchQuery) {
      return `${hostname} search: ${searchQuery}`;
    }

    const pathSegment = getReadablePathSegment(parsed.pathname);
    return pathSegment || hostname;
  } catch {
    return rawUrl.trim();
  }
}

function addTabDisplayTitles(items) {
  const titleCounts = new Map();

  for (const item of items) {
    const key = getTabTitleKey(item.title);
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
  }

  return items.map((item) => {
    const title = item.title.trim();
    const titleKey = getTabTitleKey(title);
    const hint = inferTabTitleHint(item.url);
    const shouldImproveTitle = isWeakTabTitle(title) || titleCounts.get(titleKey) > 1;

    if (!shouldImproveTitle || !hint) {
      return {
        ...item,
        displayTitle: title || hint || item.url || "Untitled tab"
      };
    }

    if (!title || isWeakTabTitle(title)) {
      return {
        ...item,
        displayTitle: hint
      };
    }

    return {
      ...item,
      displayTitle: title.toLowerCase().includes(hint.toLowerCase()) ? title : `${title} - ${hint}`
    };
  });
}

function toTabSwitcherItem(tab, group = null) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? "",
    url: tab.url ?? "",
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    favIconUrl: tab.favIconUrl ?? "",
    lastAccessed: typeof tab.lastAccessed === "number" ? tab.lastAccessed : 0,
    group: group
      ? {
          id: group.id,
          title: group.title ?? "",
          color: group.color ?? "grey",
          collapsed: Boolean(group.collapsed)
        }
      : null
  };
}

function getBookmarkSnapshotFolderTitle(baseTitle) {
  return normalizeBookmarkFolderTitle(baseTitle);
}

async function collectBookmarkedTabIds(tabs, tabGroupsById) {
  const bookmarkedTabIds = new Set();
  const rootFolderId = await findBookmarkFolderId();
  if (!rootFolderId) {
    return bookmarkedTabIds;
  }

  const rootChildren = await chrome.bookmarks.getChildren(rootFolderId);
  const foldersByTitle = new Map(rootChildren.filter((bookmark) => !bookmark.url).map((bookmark) => [bookmark.title, bookmark]));
  const folderBookmarksById = new Map();

  await Promise.all(
    tabs.map(async (tab) => {
      if (typeof tab.id !== "number" || !tab.url) {
        return;
      }

      try {
        const group = typeof tab.groupId === "number" && tab.groupId >= 0 ? tabGroupsById.get(tab.groupId) : null;
        const folderTitle = normalizeBookmarkFolderTitle(group?.title || "Ungrouped");
        const folder = foldersByTitle.get(folderTitle);
        if (!folder?.id) {
          return;
        }

        let folderBookmarks = folderBookmarksById.get(folder.id);
        if (!folderBookmarks) {
          folderBookmarks = await chrome.bookmarks.getChildren(folder.id);
          folderBookmarksById.set(folder.id, folderBookmarks);
        }

        if (folderBookmarks.some((bookmark) => bookmark.url === tab.url)) {
          bookmarkedTabIds.add(tab.id);
        }
      } catch (error) {
        console.warn("Tabcoach bookmark lookup failed", tab.url, error);
      }
    })
  );

  return bookmarkedTabIds;
}

async function collectSmartGroupPromptsByTabId(windowId) {
  const prompts = await readSmartGroupPrompts();
  const cutoff = Date.now() - SMART_GROUP_PROMPT_TTL_MS;
  const byTabId = new Map();

  for (const [promptId, record] of Object.entries(prompts)) {
    if (typeof record?.createdAt !== "number" || record.createdAt <= cutoff) {
      continue;
    }

    if (typeof windowId === "number" && typeof record.windowId === "number" && record.windowId !== windowId) {
      continue;
    }

    byTabId.set(record.tabId, {
      id: promptId,
      kind: record.kind,
      groupId: record.groupId,
      groupTitle: record.groupTitle,
      previousGroupTitle: record.previousGroupTitle ?? ""
    });
  }

  return byTabId;
}

async function collectTabSwitcherItems(windowId) {
  const currentWindowTabs = await chrome.tabs.query({ windowId });
  const tabGroups = await chrome.tabGroups.query({ windowId });
  const tabGroupsById = new Map(tabGroups.map((group) => [group.id, group]));
  const bookmarkedTabIds = await collectBookmarkedTabIds(currentWindowTabs, tabGroupsById);
  const closedBookmarksByGroupId = await collectClosedBookmarksByGroupId(tabGroups);
  const smartGroupPromptsByTabId = await collectSmartGroupPromptsByTabId(windowId);

  const items = currentWindowTabs.map((tab) => {
    const group = typeof tab.groupId === "number" && tab.groupId >= 0 ? tabGroupsById.get(tab.groupId) : null;
    const item = toTabSwitcherItem(tab, group);

    return {
      ...item,
      group: item.group
        ? {
            ...item.group,
            closedBookmarks: group ? closedBookmarksByGroupId.get(group.id) ?? [] : []
          }
        : null,
      bookmarked: Boolean(typeof tab.id === "number" && bookmarkedTabIds.has(tab.id)),
      smartGroupPrompt: smartGroupPromptsByTabId.get(tab.id) ?? null
    };
  });

  return addTabDisplayTitles(items);
}

function getTabSwitcherPopupBounds(sourceWindow, settings) {
  const sourceHeight = typeof sourceWindow?.height === "number" ? Math.max(420, sourceWindow.height) : DEFAULT_SWITCHER_POPUP_HEIGHT;

  if (
    settings.switcherOpenLeft &&
    typeof sourceWindow?.left === "number" &&
    typeof sourceWindow.top === "number"
  ) {
    return {
      width: LEFT_SWITCHER_POPUP_WIDTH,
      height: sourceHeight,
      left: sourceWindow.left - LEFT_SWITCHER_POPUP_WIDTH,
      top: sourceWindow.top
    };
  }

  return {
    width: DEFAULT_SWITCHER_POPUP_WIDTH,
    height: sourceHeight
  };
}

function isInvalidWindowBoundsError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Invalid value for bounds");
}

async function openTabSwitcherPopup() {
  const focusedWindow = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
  const [activeTab] = typeof focusedWindow?.id === "number" ? await chrome.tabs.query({ active: true, windowId: focusedWindow.id }) : [];

  if (!activeTab?.id || typeof activeTab.windowId !== "number") {
    throw new Error("No active tab");
  }

  const settings = await getSettings();
  const popupUrl = chrome.runtime.getURL(`${TAB_SWITCHER_PAGE}?windowId=${activeTab.windowId}`);
  tabSwitcherSourceWindowId = activeTab.windowId;

  if (typeof tabSwitcherPopupWindowId === "number") {
    try {
      const [popupTab] = await chrome.tabs.query({ windowId: tabSwitcherPopupWindowId });
      if (typeof popupTab?.id === "number") {
        await chrome.tabs.update(popupTab.id, { url: popupUrl });
      }
      await chrome.windows.update(tabSwitcherPopupWindowId, { focused: true });
      return;
    } catch {
      tabSwitcherPopupWindowId = null;
    }
  }

  const popupCreateOptions = {
    url: popupUrl,
    type: "popup",
    ...getTabSwitcherPopupBounds(focusedWindow, settings),
    focused: true
  };
  let popupWindow = null;

  try {
    popupWindow = await chrome.windows.create(popupCreateOptions);
  } catch (error) {
    if (!isInvalidWindowBoundsError(error)) {
      throw error;
    }

    console.warn("Tabcoach popup bounds rejected; retrying with default placement", error);
    popupWindow = await chrome.windows.create({
      url: popupUrl,
      type: "popup",
      width: DEFAULT_SWITCHER_POPUP_WIDTH,
      height: DEFAULT_SWITCHER_POPUP_HEIGHT,
      focused: true
    });
  }

  tabSwitcherPopupWindowId = typeof popupWindow.id === "number" ? popupWindow.id : null;
}

function isTabSwitcherUrl(rawUrl) {
  if (typeof rawUrl !== "string") {
    return false;
  }

  try {
    const parsedUrl = new URL(rawUrl);
    const switcherUrl = new URL(chrome.runtime.getURL(TAB_SWITCHER_PAGE));
    return parsedUrl.origin === switcherUrl.origin && parsedUrl.pathname === switcherUrl.pathname;
  } catch {
    return false;
  }
}

async function focusTabSwitcherPopup(commandTab = null) {
  const popupWindowIds = [];

  if (typeof commandTab?.windowId === "number" && isTabSwitcherUrl(commandTab.url)) {
    popupWindowIds.push(commandTab.windowId);
  }

  if (typeof tabSwitcherPopupWindowId === "number") {
    popupWindowIds.push(tabSwitcherPopupWindowId);
  }

  const tabs = await chrome.tabs.query({});
  tabs.forEach((tab) => {
    if (typeof tab.windowId === "number" && isTabSwitcherUrl(tab.url)) {
      popupWindowIds.push(tab.windowId);
    }
  });

  const [windowId] = [...new Set(popupWindowIds)];
  if (typeof windowId !== "number") {
    return false;
  }

  try {
    await chrome.windows.update(windowId, { focused: true });
    await chrome.runtime.sendMessage({ type: FOCUS_TAB_SWITCHER_SEARCH_MESSAGE }).catch(() => {});
  } catch (error) {
    console.warn("Tabcoach tab switcher focus failed", error);
    if (windowId === tabSwitcherPopupWindowId) {
      tabSwitcherPopupWindowId = null;
    }
    return false;
  }

  tabSwitcherPopupWindowId = windowId;
  return true;
}

function getSwitcherContextWindowId(context) {
  if (typeof context?.windowId === "number") {
    return context.windowId;
  }

  if (typeof context?.senderTab?.windowId === "number") {
    return context.senderTab.windowId;
  }

  return null;
}

function assertTabInSwitcherWindow(targetTab, context, action) {
  const windowId = getSwitcherContextWindowId(context);
  if (typeof windowId === "number" && targetTab.windowId !== windowId) {
    throw new Error(`Cannot ${action} a tab outside the current window`);
  }
}

async function getActiveTabInWindow(windowId) {
  if (typeof windowId !== "number") {
    return null;
  }

  const [activeTab] = await chrome.tabs.query({ active: true, windowId });
  return activeTab ?? null;
}

async function getFocusedActiveTab(commandTab = null) {
  const sourceWindowId = getTabSwitcherSourceWindowId(commandTab);
  if (typeof sourceWindowId === "number") {
    tabSwitcherPopupWindowId = typeof commandTab?.windowId === "number" ? commandTab.windowId : tabSwitcherPopupWindowId;
    tabSwitcherSourceWindowId = sourceWindowId;
  }

  const popupSourceWindowId =
    typeof sourceWindowId === "number"
      ? sourceWindowId
      : typeof commandTab?.windowId === "number" &&
          commandTab.windowId === tabSwitcherPopupWindowId &&
          typeof tabSwitcherSourceWindowId === "number"
        ? tabSwitcherSourceWindowId
        : null;

  if (typeof popupSourceWindowId === "number") {
    const sourceActiveTab = await getActiveTabInWindow(popupSourceWindowId);
    if (sourceActiveTab) {
      return sourceActiveTab;
    }
  }

  if (typeof commandTab?.id === "number" && typeof commandTab.windowId === "number") {
    return commandTab;
  }

  const windowId = await getFocusedWindowId();
  const activeTab = await getActiveTabInWindow(windowId);
  if (activeTab) {
    return activeTab;
  }

  const [lastFocusedTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return lastFocusedTab ?? null;
}

function getNumericBookmarkCommandSlot(command, prefix) {
  if (typeof command !== "string" || !command.startsWith(prefix)) {
    return null;
  }

  const slot = Number(command.slice(prefix.length));
  if (!Number.isInteger(slot) || slot < 0 || slot > 9) {
    return null;
  }

  return slot;
}

function getTabSwitcherSourceWindowId(commandTab = null) {
  if (typeof commandTab?.url !== "string") {
    return null;
  }

  try {
    const parsedUrl = new URL(commandTab.url);
    const switcherUrl = new URL(chrome.runtime.getURL(TAB_SWITCHER_PAGE));
    if (parsedUrl.origin !== switcherUrl.origin || parsedUrl.pathname !== switcherUrl.pathname) {
      return null;
    }

    const sourceWindowId = Number(parsedUrl.searchParams.get("windowId"));
    return Number.isInteger(sourceWindowId) ? sourceWindowId : null;
  } catch {
    return null;
  }
}

function truncateNotificationText(text, maxLength = 72) {
  const value = typeof text === "string" ? text.trim() : "";
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

async function showShortcutPageNotification(tabId, message) {
  if (typeof tabId !== "number") {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (text) => {
        const hostId = "__tabcoach_shortcut_toast";
        const existingHost = document.getElementById(hostId);
        if (existingHost) {
          existingHost.remove();
        }

        const host = document.createElement("div");
        host.id = hostId;
        Object.assign(host.style, {
          all: "initial",
          position: "fixed",
          bottom: "20px",
          right: "20px",
          zIndex: "2147483647",
          pointerEvents: "none",
          userSelect: "none",
          WebkitUserSelect: "none"
        });

        const shadow = host.attachShadow({ mode: "open" });
        const style = document.createElement("style");
        style.textContent = `
          .toast {
            box-sizing: border-box;
            max-width: 220px;
            padding: 8px 11px;
            border-radius: 8px;
            background: rgba(15, 23, 42, 0.94);
            color: #fff;
            font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            box-shadow: 0 8px 22px rgba(0, 0, 0, 0.24);
            white-space: normal;
            word-break: break-word;
            pointer-events: none;
            user-select: none;
            -webkit-user-select: none;
            -webkit-touch-callout: none;
          }

          .toast::selection {
            background: transparent;
          }
        `;

        const toast = document.createElement("div");
        toast.className = "toast";
        toast.textContent = text;
        shadow.append(style, toast);
        document.documentElement.appendChild(host);

        setTimeout(() => {
          host.remove();
        }, 1100);
      },
      args: [message]
    });
  } catch (error) {
    console.warn("Tabcoach shortcut notification failed", error);
  }
}

async function showNumericBookmarkFeedback(slot, action, tab = null, title = "") {
  await chrome.action.setBadgeBackgroundColor({ color: action === "assign" ? "#2563eb" : "#7c3aed" });
  await chrome.action.setBadgeText({ text: String(slot) });
  await chrome.action.setTitle({
    title: `${ACTION_TITLE}: numeric bookmark ${slot} ${action === "assign" ? "saved" : "opened"}`
  });
  if (action === "assign") {
    await showShortcutPageNotification(tab?.id, `Bookmark ${slot} saved`);
  }

  if (badgeResetTimer !== null) {
    clearTimeout(badgeResetTimer);
  }

  badgeResetTimer = setTimeout(() => {
    badgeResetTimer = null;
    void restoreServerHealthBadge();
  }, NUMERIC_BOOKMARK_BADGE_MS);
}

async function showNumericBookmarkCommandError(slot, tab, error) {
  await showShortcutPageNotification(
    tab?.id,
    `Bookmark ${slot} failed - ${truncateNotificationText(getErrorMessage(error), 56)}`
  );
}

async function assignNumericBookmarkFromActiveTab(slot, commandTab = null) {
  const activeTab = await getFocusedActiveTab(commandTab);
  if (!activeTab?.url || typeof activeTab.url !== "string") {
    throw new Error("No active tab URL to save as a numeric bookmark");
  }

  const stored = await chrome.storage.sync.get({ [NUMERIC_BOOKMARKS_KEY]: {} });
  const numericBookmarks = stored[NUMERIC_BOOKMARKS_KEY] || {};
  await chrome.storage.sync.set({
    [NUMERIC_BOOKMARKS_KEY]: {
      ...numericBookmarks,
      [slot]: {
        title: activeTab.title || activeTab.url || "Untitled tab",
        url: activeTab.url,
        tabId: activeTab.id,
        windowId: activeTab.windowId,
        normalizedUrl: normalizeUrl(activeTab.url),
        assignedAt: new Date().toISOString()
      }
    }
  });

  await showNumericBookmarkFeedback(slot, "assign", activeTab, activeTab.title || activeTab.url);
}

async function jumpToNumericBookmarkSlot(slot, commandTab = null) {
  const activeTab = await getFocusedActiveTab(commandTab);
  const windowId = typeof activeTab?.windowId === "number" ? activeTab.windowId : await getFocusedWindowId();
  const stored = await chrome.storage.sync.get({ [NUMERIC_BOOKMARKS_KEY]: {} });
  const bookmark = stored[NUMERIC_BOOKMARKS_KEY]?.[slot];

  const targetTab = await jumpToNumericBookmark(bookmark, { windowId }, slot);
  await showNumericBookmarkFeedback(slot, "jump", targetTab, bookmark?.title || bookmark?.url);
}

async function forwardNumericBookmarkCommandToPopup(action, slot, commandTab = null) {
  const sourceWindowId = getTabSwitcherSourceWindowId(commandTab) ?? tabSwitcherSourceWindowId;
  if (typeof commandTab?.windowId !== "number" || typeof sourceWindowId !== "number") {
    return false;
  }

  if (getTabSwitcherSourceWindowId(commandTab) === null && commandTab.windowId !== tabSwitcherPopupWindowId) {
    return false;
  }

  tabSwitcherPopupWindowId = commandTab.windowId;
  tabSwitcherSourceWindowId = sourceWindowId;

  try {
    const response = await chrome.runtime.sendMessage({
      type: POPUP_NUMERIC_BOOKMARK_COMMAND_MESSAGE,
      action,
      slot,
      windowId: sourceWindowId
    });
    return Boolean(response?.ok);
  } catch (error) {
    console.warn("Tabcoach popup numeric bookmark command forwarding failed", error);
    return false;
  }
}

async function logCommandShortcuts() {
  if (!chrome.commands?.getAll) {
    return;
  }

  const commands = await chrome.commands.getAll();
  const trackedCommands = commands.filter(
    (command) =>
      command.name === PREVIOUS_TAB_COMMAND ||
      command.name === NEXT_TAB_IN_HISTORY_COMMAND ||
      command.name?.startsWith(ASSIGN_NUMERIC_BOOKMARK_COMMAND_PREFIX) ||
      command.name?.startsWith(JUMP_NUMERIC_BOOKMARK_COMMAND_PREFIX)
  );

  if (trackedCommands.length === 0) {
    return;
  }

  console.info(
    "Tabcoach command shortcuts",
    trackedCommands.map((command) => ({
      name: command.name,
      shortcut: command.shortcut || ""
    }))
  );

  const unassignedCommands = trackedCommands.filter((command) => !command.shortcut);
  if (unassignedCommands.length > 0) {
    console.warn(
      "Tabcoach command shortcuts are unassigned; set them in chrome://extensions/shortcuts",
      unassignedCommands.map((command) => command.name)
    );
  }
}

async function createTabFromSwitcher(context = {}) {
  const windowId = getSwitcherContextWindowId(context);
  if (typeof windowId !== "number") {
    throw new Error("Invalid window id");
  }

  const activeTab = await getActiveTabInWindow(windowId);
  const tab = await chrome.tabs.create({
    windowId,
    index: typeof activeTab?.index === "number" ? activeTab.index : 0,
    active: true
  });
  markTabCreated(tab.id);

  if (typeof activeTab?.groupId === "number" && activeTab.groupId >= 0 && typeof tab.id === "number") {
    await chrome.tabs.group({ groupId: activeTab.groupId, tabIds: [tab.id] });
  }

  if (typeof tab.windowId === "number") {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

async function duplicateTabFromSwitcher(tabId, context = {}) {
  if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
    throw new Error("Invalid tab id");
  }

  const sourceTab = await chrome.tabs.get(tabId);
  assertTabInSwitcherWindow(sourceTab, context, "duplicate");

  if (!sourceTab.url || typeof sourceTab.url !== "string") {
    throw new Error("Cannot duplicate tab without a URL");
  }

  const duplicatedTab = await chrome.tabs.create({
    windowId: sourceTab.windowId,
    index: typeof sourceTab.index === "number" ? sourceTab.index + 1 : undefined,
    url: sourceTab.url,
    active: true,
    pinned: Boolean(sourceTab.pinned)
  });
  markTabCreated(duplicatedTab.id);

  if (typeof sourceTab.groupId === "number" && sourceTab.groupId >= 0 && typeof duplicatedTab.id === "number") {
    await chrome.tabs.group({ groupId: sourceTab.groupId, tabIds: [duplicatedTab.id] });
  }

  if (typeof duplicatedTab.windowId === "number") {
    await chrome.windows.update(duplicatedTab.windowId, { focused: true });
  }

  return duplicatedTab;
}

async function updateNumericBookmarkTabBinding(slot, bookmark, tab) {
  if (slot === null || slot === undefined || !bookmark || !tab || typeof tab.id !== "number") {
    return;
  }

  const stored = await chrome.storage.sync.get({ [NUMERIC_BOOKMARKS_KEY]: {} });
  const numericBookmarks = stored[NUMERIC_BOOKMARKS_KEY] || {};
  const currentBookmark = numericBookmarks[slot] || bookmark;
  const tabUrl = typeof tab.url === "string" && tab.url ? tab.url : currentBookmark.url;

  await chrome.storage.sync.set({
    [NUMERIC_BOOKMARKS_KEY]: {
      ...numericBookmarks,
      [slot]: {
        ...currentBookmark,
        title: tab.title || currentBookmark.title || tabUrl || "Untitled tab",
        url: tabUrl,
        tabId: tab.id,
        windowId: tab.windowId,
        normalizedUrl: typeof tabUrl === "string" ? normalizeUrl(tabUrl) : currentBookmark.normalizedUrl,
        lastOpenedAt: new Date().toISOString()
      }
    }
  });
}

async function jumpToNumericBookmark(bookmark, context = {}, slot = null) {
  const windowId = getSwitcherContextWindowId(context);
  if (typeof windowId !== "number") {
    throw new Error("Invalid window id");
  }

  if (!bookmark?.url || typeof bookmark.url !== "string") {
    throw new Error("No numeric bookmark saved in this slot");
  }

  if (typeof bookmark.tabId === "number") {
    try {
      const boundTab = await chrome.tabs.get(bookmark.tabId);
      if (boundTab.windowId === windowId && !isTabSwitcherUrl(boundTab.url)) {
        await switchToTab(boundTab.id, context);
        await updateNumericBookmarkTabBinding(slot, bookmark, boundTab);
        return boundTab;
      }
    } catch {
      // The previously bound tab was closed; fall back to URL matching below.
    }
  }

  const normalizedUrl = typeof bookmark.normalizedUrl === "string" ? bookmark.normalizedUrl : normalizeUrl(bookmark.url);
  const windowTabs = await chrome.tabs.query({ windowId });
  const matchingTab = windowTabs.find((tab) => typeof tab.url === "string" && normalizeUrl(tab.url) === normalizedUrl);

  if (typeof matchingTab?.id === "number") {
    await switchToTab(matchingTab.id, context);
    await updateNumericBookmarkTabBinding(slot, bookmark, matchingTab);
    return matchingTab;
  }

  const activeTab = await getActiveTabInWindow(windowId);
  const tab = await chrome.tabs.create({
    windowId,
    index: typeof activeTab?.index === "number" ? activeTab.index : 0,
    url: bookmark.url,
    active: true
  });
  markTabCreated(tab.id);

  if (typeof activeTab?.groupId === "number" && activeTab.groupId >= 0 && typeof tab.id === "number") {
    await chrome.tabs.group({ groupId: activeTab.groupId, tabIds: [tab.id] });
  }

  if (typeof tab.windowId === "number") {
    await chrome.windows.update(tab.windowId, { focused: true });
  }

  await updateNumericBookmarkTabBinding(slot, bookmark, tab);
  return tab;
}

async function switchToTab(tabId, context = {}) {
  if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
    throw new Error("Invalid tab id");
  }

  const targetTab = await chrome.tabs.get(tabId);
  assertTabInSwitcherWindow(targetTab, context, "switch to");
  const sourceWindowId = getSwitcherContextWindowId(context);
  const fromTab = isTabSwitcherUrl(context.senderTab?.url)
    ? await getActiveTabInWindow(sourceWindowId)
    : context.senderTab ?? (await getActiveTabInWindow(sourceWindowId));

  if (typeof targetTab.groupId === "number" && targetTab.groupId >= 0) {
    await chrome.tabGroups.update(targetTab.groupId, { collapsed: false });
  }

  await chrome.tabs.update(tabId, { active: true });

  void logTabSwitchToServer(context, fromTab, targetTab).catch((error) => {
    console.warn("Tabcoach tab switch log failed", error);
  });

  if (typeof targetTab.windowId === "number") {
    await chrome.windows.update(targetTab.windowId, { focused: true });
  }
}

async function logTabSwitchToServer(context, fromTab, targetTab) {
  const settings = await getSettings();
  if (!settings.localServerEnabled) {
    return;
  }

  const response = await fetchLocalServer("tab-switch-log", TAB_SWITCH_LOG_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      source: context.source ?? "chrome-extension:tab-switcher",
      switchedAt: new Date().toISOString(),
      from: fromTab ? normalizeTab(fromTab) : null,
      to: normalizeTab(targetTab)
    })
  });

  if (!response.ok) {
    throw new Error(`Tab switch log server returned ${response.status}`);
  }
}

async function findValidHistoryTab(windowId, tabIds) {
  const staleTabIds = [];

  for (const tabId of tabIds) {
    try {
      const targetTab = await chrome.tabs.get(tabId);
      if (targetTab.windowId !== windowId || isTabSwitcherUrl(targetTab.url)) {
        staleTabIds.push(tabId);
        continue;
      }

      return { targetTab, staleTabIds };
    } catch (error) {
      staleTabIds.push(tabId);
      console.warn("Tabcoach history candidate skipped", error);
    }
  }

  return { targetTab: null, staleTabIds };
}

function getCleanTabHistory(windowId, staleTabIds = []) {
  const staleSet = new Set(staleTabIds);
  return (tabActivationHistoryByWindowId.get(windowId) ?? []).filter((tabId) => !staleSet.has(tabId));
}

function getCleanForwardHistory(windowId, staleTabIds = []) {
  const staleSet = new Set(staleTabIds);
  return (tabForwardHistoryByWindowId.get(windowId) ?? []).filter((tabId) => !staleSet.has(tabId));
}

async function updateHistoryAfterBackNavigation(windowId, currentTabId, targetTabId, staleTabIds = []) {
  const history = getCleanTabHistory(windowId, staleTabIds);
  const forwardHistory = getCleanForwardHistory(windowId, staleTabIds);

  tabActivationHistoryByWindowId.set(windowId, [
    targetTabId,
    ...history.filter((tabId) => tabId !== targetTabId && tabId !== currentTabId)
  ].slice(0, MAX_TAB_ACTIVATION_HISTORY_PER_WINDOW));
  tabForwardHistoryByWindowId.set(windowId, [
    currentTabId,
    ...forwardHistory.filter((tabId) => tabId !== currentTabId && tabId !== targetTabId)
  ].slice(0, MAX_TAB_ACTIVATION_HISTORY_PER_WINDOW));
  await saveTabActivationHistory();
}

async function updateHistoryAfterForwardNavigation(windowId, currentTabId, targetTabId, staleTabIds = []) {
  const history = getCleanTabHistory(windowId, staleTabIds);
  const forwardHistory = getCleanForwardHistory(windowId, staleTabIds);
  const nextForwardHistory = forwardHistory.filter((tabId) => tabId !== targetTabId && tabId !== currentTabId);

  tabActivationHistoryByWindowId.set(windowId, [
    targetTabId,
    currentTabId,
    ...history.filter((tabId) => tabId !== targetTabId && tabId !== currentTabId)
  ].slice(0, MAX_TAB_ACTIVATION_HISTORY_PER_WINDOW));

  if (nextForwardHistory.length > 0) {
    tabForwardHistoryByWindowId.set(windowId, nextForwardHistory.slice(0, MAX_TAB_ACTIVATION_HISTORY_PER_WINDOW));
  } else {
    tabForwardHistoryByWindowId.delete(windowId);
  }

  await saveTabActivationHistory();
}

async function switchToPreviousTab(commandTab = null) {
  const activeTab = await getFocusedActiveTab(commandTab);
  if (!activeTab || typeof activeTab.id !== "number" || typeof activeTab.windowId !== "number") {
    throw new Error("No active tab");
  }

  await recordActivatedTab(activeTab.id, activeTab.windowId, { clearForwardHistory: false });
  const history = tabActivationHistoryByWindowId.get(activeTab.windowId) ?? [];
  const candidates = history.filter((tabId) => tabId !== activeTab.id);
  const { targetTab, staleTabIds } = await findValidHistoryTab(activeTab.windowId, candidates);

  if (!targetTab || typeof targetTab.id !== "number") {
    if (staleTabIds.length > 0) {
      tabActivationHistoryByWindowId.set(activeTab.windowId, getCleanTabHistory(activeTab.windowId, staleTabIds));
      tabForwardHistoryByWindowId.set(activeTab.windowId, getCleanForwardHistory(activeTab.windowId, staleTabIds));
      await saveTabActivationHistory();
    }
    throw new Error("No previous tab in this window");
  }

  suppressedActivationHistoryByWindowId.set(activeTab.windowId, targetTab.id);
  try {
    await switchToTab(targetTab.id, {
      windowId: activeTab.windowId,
      senderTab: activeTab,
      source: "chrome-extension:previous-tab-command"
    });
  } catch (error) {
    suppressedActivationHistoryByWindowId.delete(activeTab.windowId);
    throw error;
  }

  await updateHistoryAfterBackNavigation(activeTab.windowId, activeTab.id, targetTab.id, staleTabIds);
}

async function switchToNextTabInHistory(commandTab = null) {
  const activeTab = await getFocusedActiveTab(commandTab);
  if (!activeTab || typeof activeTab.id !== "number" || typeof activeTab.windowId !== "number") {
    throw new Error("No active tab");
  }

  await recordActivatedTab(activeTab.id, activeTab.windowId, { clearForwardHistory: false });
  const forwardHistory = tabForwardHistoryByWindowId.get(activeTab.windowId) ?? [];
  const { targetTab, staleTabIds } = await findValidHistoryTab(activeTab.windowId, forwardHistory);

  if (!targetTab || typeof targetTab.id !== "number") {
    if (staleTabIds.length > 0) {
      tabForwardHistoryByWindowId.set(activeTab.windowId, getCleanForwardHistory(activeTab.windowId, staleTabIds));
      await saveTabActivationHistory();
    }
    throw new Error("No next tab in this window");
  }

  suppressedActivationHistoryByWindowId.set(activeTab.windowId, targetTab.id);
  try {
    await switchToTab(targetTab.id, {
      windowId: activeTab.windowId,
      senderTab: activeTab,
      source: "chrome-extension:next-tab-history-command"
    });
  } catch (error) {
    suppressedActivationHistoryByWindowId.delete(activeTab.windowId);
    throw error;
  }

  await updateHistoryAfterForwardNavigation(activeTab.windowId, activeTab.id, targetTab.id, staleTabIds);
}

async function closeTabFromSwitcher(tabId, context = {}) {
  if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
    throw new Error("Invalid tab id");
  }

  const targetTab = await chrome.tabs.get(tabId);
  assertTabInSwitcherWindow(targetTab, context, "close");

  await chrome.tabs.remove(tabId);
}

async function moveTabFromSwitcher(tabId, index, groupId, context = {}) {
  if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
    throw new Error("Invalid tab id");
  }

  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    throw new Error("Invalid tab index");
  }

  const targetTab = await chrome.tabs.get(tabId);
  assertTabInSwitcherWindow(targetTab, context, "move");

  if (typeof groupId === "number" && Number.isInteger(groupId) && groupId >= 0) {
    const targetGroup = await chrome.tabGroups.get(groupId);
    if (targetGroup.windowId !== targetTab.windowId) {
      throw new Error("Cannot move a tab into a group outside the current window");
    }

    await chrome.tabs.group({ groupId, tabIds: [tabId] });
  } else if (typeof targetTab.groupId === "number" && targetTab.groupId >= 0) {
    await chrome.tabs.ungroup(tabId);
  }

  await chrome.tabs.move(tabId, { index });
  return collectTabSwitcherItems(targetTab.windowId);
}

async function createGroupFromSwitcher(tabId, title, context = {}) {
  if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
    throw new Error("Invalid tab id");
  }

  if (typeof title !== "string") {
    throw new Error("Invalid group title");
  }

  const targetTab = await chrome.tabs.get(tabId);
  assertTabInSwitcherWindow(targetTab, context, "group");

  if (targetTab.pinned) {
    throw new Error("Pinned tabs cannot be grouped; unpin this tab first");
  }

  const targetWindow = await chrome.windows.get(targetTab.windowId);
  if (targetWindow.type !== "normal") {
    throw new Error("Tab groups are only supported in normal browser windows");
  }

  const groupId = await chrome.tabs.group({
    tabIds: [tabId],
    createProperties: { windowId: targetTab.windowId }
  });
  await chrome.tabGroups.update(groupId, {
    title: title.trim() || "New group"
  });
  return collectTabSwitcherItems(targetTab.windowId);
}

async function setTabGroupFromSwitcher(tabId, groupId, context = {}) {
  if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
    throw new Error("Invalid tab id");
  }

  const targetTab = await chrome.tabs.get(tabId);
  assertTabInSwitcherWindow(targetTab, context, "move to group");

  if (groupId === null || groupId === -1) {
    if (typeof targetTab.groupId === "number" && targetTab.groupId >= 0) {
      await chrome.tabs.ungroup(tabId);
    }
    return collectTabSwitcherItems(targetTab.windowId);
  }

  if (typeof groupId !== "number" || !Number.isInteger(groupId) || groupId < 0) {
    throw new Error("Invalid group id");
  }

  if (targetTab.pinned) {
    throw new Error("Pinned tabs cannot be moved to groups; unpin this tab first");
  }

  const targetWindow = await chrome.windows.get(targetTab.windowId);
  if (targetWindow.type !== "normal") {
    throw new Error("Tab groups are only supported in normal browser windows");
  }

  const targetGroup = await chrome.tabGroups.get(groupId);
  if (targetGroup.windowId !== targetTab.windowId) {
    throw new Error("Cannot move a tab into a group outside the current window");
  }

  await chrome.tabs.group({ groupId, tabIds: [tabId] });
  return collectTabSwitcherItems(targetTab.windowId);
}

function buildGroupingTabPayload(items) {
  return items
    .filter((item) => typeof item.id === "number" && !item.pinned)
    .slice(0, MAX_GROUPING_TABS)
    .map((item) => ({
      id: item.id,
      title: (item.displayTitle || item.title || "").slice(0, MAX_GROUPING_TITLE_LENGTH),
      url: (item.url || "").slice(0, MAX_GROUPING_URL_LENGTH),
      group: item.group?.title || ""
    }));
}

async function suggestTabGroupsFromSwitcher(context = {}) {
  const windowId = getSwitcherContextWindowId(context);
  if (typeof windowId !== "number") {
    throw new Error("Invalid window id");
  }

  const settings = await getSettings();
  if (!settings.localServerEnabled) {
    throw new Error("Group suggestions need the local Tabcoach server; enable it in settings");
  }

  const items = await collectTabSwitcherItems(windowId);
  const payloadTabs = buildGroupingTabPayload(items);
  if (payloadTabs.length < 2) {
    throw new Error("Not enough groupable tabs in this window");
  }

  const response = await fetchLocalServer(
    "suggest-groups",
    SUGGEST_GROUPS_ENDPOINT,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        source: "tab-switcher",
        tabs: payloadTabs,
        rules: settings.smartGroupRules || ""
      })
    },
    settings
  );

  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    throw new Error(result?.error || `Group suggestion server returned ${response.status}`);
  }

  return {
    groups: Array.isArray(result.groups) ? result.groups : [],
    tabs: items,
    model: typeof result.model === "string" ? result.model : ""
  };
}

async function applyTabGroupPlanFromSwitcher(groups, context = {}) {
  const windowId = getSwitcherContextWindowId(context);
  if (typeof windowId !== "number") {
    throw new Error("Invalid window id");
  }

  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error("No groups to apply");
  }

  const targetWindow = await chrome.windows.get(windowId);
  if (targetWindow.type !== "normal") {
    throw new Error("Tab groups are only supported in normal browser windows");
  }

  const windowTabs = await chrome.tabs.query({ windowId });
  const groupableTabIds = new Set(
    windowTabs.filter((tab) => typeof tab.id === "number" && !tab.pinned).map((tab) => tab.id)
  );
  const existingGroups = await chrome.tabGroups.query({ windowId });
  const groupIdsByTitle = new Map(
    existingGroups
      .filter((group) => typeof group.title === "string" && group.title.trim())
      .map((group) => [group.title.trim().toLowerCase(), group.id])
  );

  const usedTabIds = new Set();
  let appliedGroupCount = 0;
  let appliedTabCount = 0;

  for (const group of groups) {
    const title = typeof group?.title === "string" ? group.title.trim().slice(0, 30) : "";
    const color = TAB_GROUP_COLORS.includes(group?.color) ? group.color : "grey";
    const tabIds = (Array.isArray(group?.tabIds) ? group.tabIds : [])
      .map((tabId) => Number(tabId))
      .filter((tabId) => Number.isInteger(tabId) && groupableTabIds.has(tabId) && !usedTabIds.has(tabId));

    if (!title || tabIds.length === 0) {
      continue;
    }

    tabIds.forEach((tabId) => usedTabIds.add(tabId));

    const existingGroupId = groupIdsByTitle.get(title.toLowerCase());
    const groupId = typeof existingGroupId === "number"
      ? await chrome.tabs.group({ groupId: existingGroupId, tabIds })
      : await chrome.tabs.group({ tabIds, createProperties: { windowId } });

    groupIdsByTitle.set(title.toLowerCase(), groupId);
    await chrome.tabGroups.update(groupId, { title, color });
    appliedGroupCount += 1;
    appliedTabCount += tabIds.length;
  }

  if (appliedGroupCount === 0) {
    throw new Error("None of the suggested tabs are still groupable");
  }

  return {
    tabs: await collectTabSwitcherItems(windowId),
    appliedGroupCount,
    appliedTabCount
  };
}

function getHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// A representative slice rather than the first N tabs, so a large group is not
// described only by whatever happens to sit at its left edge.
function pickSpread(items, limit) {
  if (items.length <= limit) {
    return items;
  }

  const step = items.length / limit;
  return Array.from({ length: limit }, (_, index) => items[Math.floor(index * step)]);
}

function summarizeGroupSites(groupTabs) {
  const counts = new Map();

  for (const tab of groupTabs) {
    const host = getHostname(tab.url || "");
    if (host) {
      counts.set(host, (counts.get(host) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_SMART_GROUP_SITES)
    .map(([host, count]) => ({ host, count }));
}

async function collectSmartGroupCandidates(windowId) {
  const groups = await chrome.tabGroups.query({ windowId });
  if (groups.length === 0) {
    return [];
  }

  const windowTabs = await chrome.tabs.query({ windowId });

  return groups.map((group) => {
    const groupTabs = windowTabs.filter((tab) => tab.groupId === group.id);

    return {
      id: group.id,
      title: group.title?.trim() || "Untitled group",
      color: group.color ?? "grey",
      tabCount: groupTabs.length,
      topSites: summarizeGroupSites(groupTabs),
      sampleTabs: pickSpread(groupTabs, MAX_SMART_GROUP_SAMPLE_TITLES).map((tab) => ({
        title: (tab.title || "").slice(0, MAX_GROUPING_TITLE_LENGTH),
        host: getHostname(tab.url || "")
      }))
    };
  });
}

// Which tab spawned this one is a strong hint, so pass it along.
async function describeOpenerTab(openerTabId) {
  if (typeof openerTabId !== "number") {
    return null;
  }

  const opener = await chrome.tabs.get(openerTabId).catch(() => null);
  if (!opener) {
    return null;
  }

  return {
    title: (opener.title || "").slice(0, MAX_GROUPING_TITLE_LENGTH),
    host: getHostname(opener.url || ""),
    groupId: typeof opener.groupId === "number" && opener.groupId >= 0 ? opener.groupId : null
  };
}

async function requestSmartGroupChoice(tab, groups, settings) {
  const response = await fetchLocalServer(
    "suggest-group-for-tab",
    SUGGEST_GROUP_FOR_TAB_ENDPOINT,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        source: tab.source ?? "new-tab",
        tab: {
          id: tab.id,
          title: (tab.title || "").slice(0, MAX_GROUPING_TITLE_LENGTH),
          url: (tab.url || "").slice(0, MAX_GROUPING_URL_LENGTH),
          currentGroupId: typeof tab.groupId === "number" && tab.groupId >= 0 ? tab.groupId : null,
          openedFrom: tab.openedFrom ?? null
        },
        groups,
        rules: settings.smartGroupRules || ""
      })
    },
    settings
  );

  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    throw new Error(result?.error || `Group choice server returned ${response.status}`);
  }

  return result;
}

// The page-injected prompt needs host permissions or an activeTab grant from a
// user gesture, neither of which exists for an automatic background decision.
// System notifications work without either, and survive a service worker restart
// because the pending decision is stored in session storage.
async function readSmartGroupPrompts() {
  try {
    const stored = await getTabHistoryStorageArea().get({ [SMART_GROUP_PROMPTS_KEY]: {} });
    return stored[SMART_GROUP_PROMPTS_KEY] ?? {};
  } catch {
    return {};
  }
}

async function writeSmartGroupPrompts(prompts) {
  try {
    await getTabHistoryStorageArea().set({ [SMART_GROUP_PROMPTS_KEY]: prompts });
  } catch (error) {
    console.warn("Tabcoach smart group prompt persistence failed", error);
  }
}

async function takeSmartGroupPrompt(notificationId) {
  const prompts = await readSmartGroupPrompts();
  const record = prompts[notificationId];
  if (record) {
    delete prompts[notificationId];
    await writeSmartGroupPrompts(prompts);
  }

  return record ?? null;
}

async function createSmartGroupPrompt(record) {
  const notificationId = `${SMART_GROUP_NOTIFICATION_PREFIX}${record.tabId}-${Date.now()}`;
  const isUndo = record.kind === "undo";
  const prompts = await readSmartGroupPrompts();
  const cutoff = Date.now() - SMART_GROUP_PROMPT_TTL_MS;

  for (const [key, value] of Object.entries(prompts)) {
    if (typeof value?.createdAt !== "number" || value.createdAt <= cutoff) {
      delete prompts[key];
    }
  }

  // Store the decision before trying to show it. The notification is only one of
  // two ways to answer it; the tab switcher reads the stored record directly, so
  // a blocked or unavailable notification must not throw the suggestion away.
  prompts[notificationId] = { ...record, createdAt: Date.now() };
  await writeSmartGroupPrompts(prompts);
  logSmartGroup(isUndo ? "move recorded, offering undo" : "suggestion recorded, look for the star in the switcher", {
    tabId: record.tabId,
    group: record.groupTitle,
    notificationId
  });
  notifyTabSwitcherRefresh(record.windowId);

  if (!chrome.notifications?.create) {
    logSmartGroup("notifications are unavailable; answer it in the tab switcher", { tabId: record.tabId });
    return;
  }

  try {
    await chrome.notifications.create(notificationId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon-128.png"),
      title: isUndo ? `Moved to "${record.groupTitle}"` : "Tabcoach",
      message: isUndo
        ? `"${record.tabTitle}" joined "${record.groupTitle}".`
        : record.previousGroupTitle
          ? `Move "${record.tabTitle}" from "${record.previousGroupTitle}" to "${record.groupTitle}"?`
          : `Move "${record.tabTitle}" to "${record.groupTitle}"?`,
      buttons: isUndo ? [{ title: "Undo" }, { title: "Keep" }] : [{ title: "Move" }, { title: "Not now" }],
      requireInteraction: true
    });
    logSmartGroup("notification shown", { tabId: record.tabId, notificationId });
  } catch (error) {
    logSmartGroup("notification could not be shown; answer it in the tab switcher", {
      tabId: record.tabId,
      error: getErrorMessage(error)
    });
  }
}

async function handleSmartGroupPromptButton(notificationId, buttonIndex) {
  if (typeof notificationId !== "string" || !notificationId.startsWith(SMART_GROUP_NOTIFICATION_PREFIX)) {
    return;
  }

  const record = await takeSmartGroupPrompt(notificationId);
  void chrome.notifications?.clear(notificationId).catch(() => {});

  if (!record) {
    logSmartGroup("notification answered but the decision was already gone", { notificationId });
    return;
  }

  if (buttonIndex !== 0) {
    logSmartGroup("notification dismissed", { tabId: record.tabId, group: record.groupTitle });
    return;
  }

  const tab = await chrome.tabs.get(record.tabId).catch(() => null);
  if (!tab) {
    logSmartGroup("notification answered but the tab is gone", { tabId: record.tabId });
    return;
  }

  if (record.kind === "undo") {
    await undoSmartGroupMove(record.tabId, record.previousIndex, record.previousGroupId);
    logSmartGroup("move undone", { tabId: record.tabId, group: record.groupTitle });
    return;
  }

  const liveGroupId = typeof tab.groupId === "number" ? tab.groupId : -1;
  if (liveGroupId !== record.previousGroupId) {
    logSmartGroup("skipped, tab was regrouped before the answer", { tabId: record.tabId, liveGroupId });
    return;
  }

  await moveTabIntoGroup(record.tabId, record.groupId);
  logSmartGroup("moved after the notification", { tabId: record.tabId, group: record.groupTitle });
}

async function moveTabIntoGroup(tabId, groupId) {
  await chrome.tabs.group({ groupId, tabIds: [tabId] });
  await chrome.tabGroups.update(groupId, { collapsed: false });
  notifyTabSwitcherRefresh();
}

async function undoSmartGroupMove(tabId, previousIndex, previousGroupId = -1) {
  if (Number.isInteger(previousGroupId) && previousGroupId >= 0) {
    await chrome.tabs.group({ groupId: previousGroupId, tabIds: [tabId] });
  } else {
    await chrome.tabs.ungroup(tabId);
  }

  if (Number.isInteger(previousIndex) && previousIndex >= 0) {
    await chrome.tabs.move(tabId, { index: previousIndex });
  }
  notifyTabSwitcherRefresh();
}

function isSmartGroupCandidateUrl(url) {
  return typeof url === "string" && /^https?:\/\//.test(url);
}

function logSmartGroup(message, details = {}) {
  console.info(`Tabcoach smart grouping: ${message}`, details);
}

async function maybeSmartGroupNewTab(tabId, { force = false } = {}) {
  if (typeof tabId !== "number") {
    return;
  }

  if (!force && smartGroupEvaluatedTabIds.has(tabId)) {
    logSmartGroup("skipped, tab already evaluated", { tabId });
    return;
  }

  if (!force && !(await isRecentlyCreatedTab(tabId))) {
    logSmartGroup("skipped, not a recently created tab", { tabId });
    return;
  }

  const settings = await getSettings();
  if (settings.smartGroupMode === "off") {
    logSmartGroup("skipped, smart grouping is off in settings", { tabId });
    return;
  }

  if (!settings.localServerEnabled) {
    logSmartGroup("skipped, local server integration is disabled", { tabId });
    return;
  }

  if (smartGroupRequestsInFlight >= MAX_SMART_GROUP_REQUESTS_IN_FLIGHT) {
    logSmartGroup("skipped, too many requests in flight", { tabId, smartGroupRequestsInFlight });
    return;
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    logSmartGroup("skipped, tab is gone", { tabId });
    return;
  }

  if (tab.pinned) {
    logSmartGroup("skipped, tab is pinned", { tabId, url: tab.url });
    return;
  }

  if (!isSmartGroupCandidateUrl(tab.url)) {
    logSmartGroup("skipped, not an http(s) page", { tabId, url: tab.url });
    return;
  }

  // Chrome puts a tab opened from a grouped tab into the opener's group. Such a
  // tab is still worth checking: it only moves when a different group wins.
  const currentGroupId = typeof tab.groupId === "number" && tab.groupId >= 0 ? tab.groupId : -1;

  const targetWindow = await chrome.windows.get(tab.windowId).catch(() => null);
  if (targetWindow?.type !== "normal") {
    logSmartGroup("skipped, window is not a normal browser window", { tabId, windowType: targetWindow?.type });
    return;
  }

  const groups = await collectSmartGroupCandidates(tab.windowId);
  if (groups.length === 0) {
    logSmartGroup("skipped, this window has no tab groups to choose from", { tabId, windowId: tab.windowId });
    return;
  }

  smartGroupEvaluatedTabIds.add(tabId);
  smartGroupRequestsInFlight += 1;
  logSmartGroup("asking the local server", { tabId, title: tab.title, groups: groups.map((group) => group.title) });

  const openedFrom = await describeOpenerTab(tab.openerTabId);

  let choice;
  try {
    choice = await requestSmartGroupChoice({ ...tab, openedFrom }, groups, settings);
  } catch (error) {
    logSmartGroup("server request failed", { tabId, error: getErrorMessage(error) });
    throw error;
  } finally {
    smartGroupRequestsInFlight -= 1;
  }

  const groupId = Number(choice?.groupId);
  const targetGroup = groups.find((group) => group.id === groupId);
  if (!targetGroup) {
    logSmartGroup("no group chosen", {
      tabId,
      confidence: choice?.confidence,
      reason: choice?.reason,
      belowThreshold: choice?.belowThreshold
    });
    return;
  }

  logSmartGroup("group chosen", {
    tabId,
    group: targetGroup.title,
    confidence: choice?.confidence,
    reason: choice?.reason,
    mode: settings.smartGroupMode
  });

  if (groupId === currentGroupId) {
    logSmartGroup("nothing to do, tab is already in the chosen group", { tabId, group: targetGroup.title });
    return;
  }

  const liveTab = await chrome.tabs.get(tabId).catch(() => null);
  if (!liveTab) {
    logSmartGroup("skipped, tab was closed while waiting", { tabId });
    return;
  }

  const liveGroupId = typeof liveTab.groupId === "number" ? liveTab.groupId : -1;
  if (liveGroupId !== currentGroupId) {
    logSmartGroup("skipped, tab was regrouped while waiting", { tabId, liveGroupId });
    return;
  }

  const previousGroupTitle = currentGroupId >= 0 ? groups.find((group) => group.id === currentGroupId)?.title ?? "" : "";

  const promptRecord = {
    tabId,
    windowId: tab.windowId,
    tabTitle: (liveTab.title || tab.title || "This tab").slice(0, 60),
    groupId,
    groupTitle: targetGroup.title,
    previousGroupId: currentGroupId,
    previousGroupTitle,
    previousIndex: liveTab.index
  };

  if (settings.smartGroupMode === "auto") {
    await moveTabIntoGroup(tabId, groupId);
    logSmartGroup("moved automatically", { tabId, group: targetGroup.title });
    await createSmartGroupPrompt({ ...promptRecord, kind: "undo" });
    return;
  }

  await createSmartGroupPrompt({ ...promptRecord, kind: "move" });
}

async function resolveSmartGroupPromptFromSwitcher(promptId, accept, context = {}) {
  if (typeof promptId !== "string" || !promptId) {
    throw new Error("Invalid suggestion id");
  }

  const windowId = getSwitcherContextWindowId(context);
  if (typeof windowId !== "number") {
    throw new Error("Invalid window id");
  }

  await handleSmartGroupPromptButton(promptId, accept ? 0 : 1);
  notifyTabSwitcherRefresh(windowId);
  return collectTabSwitcherItems(windowId);
}

async function suggestGroupForTabFromSwitcher(tabId, context = {}) {
  if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
    throw new Error("Invalid tab id");
  }

  const settings = await getSettings();
  if (!settings.localServerEnabled) {
    throw new Error("Group suggestions need the local Tabcoach server; enable it in settings");
  }

  const tab = await chrome.tabs.get(tabId);
  assertTabInSwitcherWindow(tab, context, "suggest a group for");

  if (!isSmartGroupCandidateUrl(tab.url)) {
    throw new Error("Only http(s) tabs can be placed automatically");
  }

  const groups = await collectSmartGroupCandidates(tab.windowId);
  if (groups.length === 0) {
    throw new Error("This window has no tab groups to choose from yet");
  }

  const choice = await requestSmartGroupChoice(
    { ...tab, source: "tab-switcher", openedFrom: await describeOpenerTab(tab.openerTabId) },
    groups,
    settings
  );
  const chosenGroupId = Number(choice?.groupId);
  const group = Number.isInteger(chosenGroupId) ? await chrome.tabGroups.get(chosenGroupId).catch(() => null) : null;

  return {
    groupId: group ? group.id : null,
    groupTitle: group?.title?.trim() || "Untitled group",
    groupColor: group?.color || "grey",
    confidence: typeof choice?.confidence === "number" ? choice.confidence : null,
    reason: typeof choice?.reason === "string" ? choice.reason : "",
    belowThreshold: Boolean(choice?.belowThreshold),
    model: typeof choice?.model === "string" ? choice.model : ""
  };
}

// Manual trigger for debugging from the service worker console: smartGroupActiveTab()
async function smartGroupActiveTab() {
  const focusedWindow = await chrome.windows.getLastFocused({ populate: true, windowTypes: ["normal"] });
  const activeTab = focusedWindow.tabs?.find((tab) => tab.active);
  if (!activeTab || typeof activeTab.id !== "number") {
    logSmartGroup("no active tab found", {});
    return;
  }

  smartGroupEvaluatedTabIds.delete(activeTab.id);
  return maybeSmartGroupNewTab(activeTab.id, { force: true });
}

async function setGroupCollapsedFromSwitcher(groupId, collapsed, context = {}) {
  if (typeof groupId !== "number" || !Number.isInteger(groupId) || groupId < 0) {
    throw new Error("Invalid group id");
  }

  const windowId = getSwitcherContextWindowId(context);
  if (typeof windowId !== "number") {
    throw new Error("Invalid window id");
  }

  const group = await chrome.tabGroups.get(groupId);
  if (group.windowId !== windowId) {
    throw new Error("Cannot update a group outside the current window");
  }

  await chrome.tabGroups.update(groupId, { collapsed: Boolean(collapsed) });
  return collectTabSwitcherItems(windowId);
}

async function renameGroupFromSwitcher(groupId, title, context = {}) {
  if (typeof groupId !== "number" || !Number.isInteger(groupId) || groupId < 0) {
    throw new Error("Invalid group id");
  }

  if (typeof title !== "string") {
    throw new Error("Invalid group title");
  }

  const windowId = getSwitcherContextWindowId(context);
  if (typeof windowId !== "number") {
    throw new Error("Invalid window id");
  }

  const group = await chrome.tabGroups.get(groupId);
  if (group.windowId !== windowId) {
    throw new Error("Cannot rename a group outside the current window");
  }

  const nextTitle = title.trim();
  await chrome.tabGroups.update(groupId, { title: nextTitle });
  await renameBookmarkSnapshotFolder(group.title || "Unnamed group", nextTitle || "Unnamed group");
  return collectTabSwitcherItems(windowId);
}

async function closeGroupFromSwitcher(groupId, context = {}) {
  const { group, windowId } = await getValidatedGroupInSwitcherWindow(groupId, context);
  const groupTabs = await chrome.tabs.query({ windowId, groupId: group.id });
  const tabIds = groupTabs.map((tab) => tab.id).filter((tabId) => typeof tabId === "number");

  if (tabIds.length === 0) {
    return collectTabSwitcherItems(windowId);
  }

  await chrome.tabs.remove(tabIds);
  return collectTabSwitcherItems(windowId);
}

async function getOrCreateBookmarkFolder() {
  const existingFolderId = await findBookmarkFolderId();
  if (existingFolderId) {
    return existingFolderId;
  }

  const folder = await chrome.bookmarks.create({ title: BOOKMARK_FOLDER_TITLE });
  return folder.id;
}

async function findBookmarkFolderId() {
  const matches = await chrome.bookmarks.search({ title: BOOKMARK_FOLDER_TITLE });
  const existingFolder = matches.find((bookmark) => bookmark.title === BOOKMARK_FOLDER_TITLE && !bookmark.url);

  if (existingFolder?.id) {
    return existingFolder.id;
  }

  return null;
}

async function getOrCreateBookmarkSubfolder(parentId, title) {
  const children = await chrome.bookmarks.getChildren(parentId);
  const existingFolder = children.find((bookmark) => bookmark.title === title && !bookmark.url);

  if (existingFolder?.id) {
    return existingFolder.id;
  }

  const folder = await chrome.bookmarks.create({ parentId, title });
  return folder.id;
}

async function findBookmarkSubfolderId(parentId, title) {
  const children = await chrome.bookmarks.getChildren(parentId);
  const existingFolder = children.find((bookmark) => bookmark.title === title && !bookmark.url);
  return existingFolder?.id ?? null;
}

async function getOrCreateAppBookmarkFolder() {
  const rootFolderId = await getOrCreateBookmarkFolder();
  return getOrCreateBookmarkSubfolder(rootFolderId, APP_BOOKMARK_FOLDER_TITLE);
}

async function findAppBookmarkFolderId() {
  const rootFolderId = await findBookmarkFolderId();
  if (!rootFolderId) {
    return null;
  }

  return findBookmarkSubfolderId(rootFolderId, APP_BOOKMARK_FOLDER_TITLE);
}

function normalizeBookmarkFolderTitle(title) {
  const normalized = typeof title === "string" ? title.trim().replace(/\s+/g, " ") : "";
  return normalized || "Ungrouped";
}

async function createBookmarkSnapshotFolder(parentId, baseTitle) {
  const children = await chrome.bookmarks.getChildren(parentId);
  const snapshotTitle = getBookmarkSnapshotFolderTitle(baseTitle);
  const existingFolder = children.find((bookmark) => bookmark.title === snapshotTitle && !bookmark.url);

  if (existingFolder?.id) {
    return existingFolder;
  }

  return chrome.bookmarks.create({ parentId, title: snapshotTitle });
}

async function findBookmarkSnapshotFolder(parentId, baseTitle) {
  const children = await chrome.bookmarks.getChildren(parentId);
  const snapshotTitle = getBookmarkSnapshotFolderTitle(baseTitle);
  return children.find((bookmark) => bookmark.title === snapshotTitle && !bookmark.url) ?? null;
}

async function getGroupBookmarkFolder(groupTitle) {
  const rootFolderId = await findBookmarkFolderId();
  if (!rootFolderId) {
    return null;
  }

  return findBookmarkSnapshotFolder(rootFolderId, groupTitle || "Unnamed group");
}

function getOpenNormalizedUrls(tabs) {
  return new Set(
    tabs
      .map((tab) => (typeof tab.url === "string" && tab.url ? normalizeUrl(tab.url) : ""))
      .filter(Boolean)
  );
}

async function getClosedBookmarksForGroup(group, openNormalizedUrls) {
  const bookmarkFolder = await getGroupBookmarkFolder(group.title || "Unnamed group");
  if (!bookmarkFolder?.id) {
    return [];
  }

  const bookmarks = await chrome.bookmarks.getChildren(bookmarkFolder.id);
  return bookmarks
    .filter((bookmark) => typeof bookmark.url === "string" && bookmark.url.length > 0)
    .filter((bookmark) => !openNormalizedUrls.has(normalizeUrl(bookmark.url)))
    .map((bookmark, index) => ({
      id: bookmark.id,
      title: bookmark.title || bookmark.url,
      url: bookmark.url,
      index
    }));
}

async function collectClosedBookmarksByGroupId(groups) {
  const openTabs = await chrome.tabs.query({});
  const openNormalizedUrls = getOpenNormalizedUrls(openTabs);
  const entries = await Promise.all(
    groups.map(async (group) => [group.id, await getClosedBookmarksForGroup(group, openNormalizedUrls)])
  );
  return new Map(entries);
}

async function renameBookmarkSnapshotFolder(previousTitle, nextTitle) {
  const previousFolderTitle = getBookmarkSnapshotFolderTitle(previousTitle);
  const nextFolderTitle = getBookmarkSnapshotFolderTitle(nextTitle);
  if (previousFolderTitle === nextFolderTitle) {
    return;
  }

  const rootFolderId = await findBookmarkFolderId();
  if (!rootFolderId) {
    return;
  }

  const existingFolder = await findBookmarkSnapshotFolder(rootFolderId, previousTitle);
  if (!existingFolder?.id) {
    return;
  }

  await chrome.bookmarks.update(existingFolder.id, { title: nextFolderTitle });
}

async function getValidatedGroupInSwitcherWindow(groupId, context = {}) {
  if (typeof groupId !== "number" || !Number.isInteger(groupId) || groupId < 0) {
    throw new Error("Invalid group id");
  }

  const windowId = getSwitcherContextWindowId(context);
  if (typeof windowId !== "number") {
    throw new Error("Invalid window id");
  }

  const group = await chrome.tabGroups.get(groupId);
  if (group.windowId !== windowId) {
    throw new Error("Cannot use a group outside the current window");
  }

  return { group, windowId };
}

async function openGroupBookmarkFromSwitcher(groupId, bookmarkId, insertOffset = 0, context = {}) {
  if (typeof bookmarkId !== "string" || bookmarkId.length === 0) {
    throw new Error("Invalid bookmark id");
  }

  const { group, windowId } = await getValidatedGroupInSwitcherWindow(groupId, context);
  const bookmarkFolder = await getGroupBookmarkFolder(group.title || "Unnamed group");
  if (!bookmarkFolder?.id) {
    throw new Error("No bookmark folder for this group");
  }

  const bookmarks = await chrome.bookmarks.getChildren(bookmarkFolder.id);
  const bookmark = bookmarks.find((item) => item.id === bookmarkId && typeof item.url === "string" && item.url.length > 0);
  if (!bookmark?.url) {
    throw new Error("Bookmark not found in this group");
  }

  const windowTabs = await chrome.tabs.query({ windowId });
  const groupTabs = windowTabs
    .filter((tab) => tab.groupId === groupId)
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  const safeInsertOffset = Number.isInteger(insertOffset) && insertOffset >= 0 ? insertOffset : 0;
  const lastGroupIndex = groupTabs.length > 0
    ? Math.max(...groupTabs.map((tab) => (typeof tab.index === "number" ? tab.index : 0)))
    : windowTabs.length - 1;
  const insertIndex = Math.min(windowTabs.length, lastGroupIndex + 1 + safeInsertOffset);
  const tab = await chrome.tabs.create({
    windowId,
    index: insertIndex,
    url: bookmark.url,
    active: true
  });
  markTabCreated(tab.id);

  if (typeof tab.id === "number") {
    await chrome.tabs.group({ groupId, tabIds: [tab.id] });
  }

  if (typeof tab.windowId === "number") {
    await chrome.windows.update(tab.windowId, { focused: true });
  }

  return {
    tab: tab ? normalizeTab(tab) : null,
    tabs: await collectTabSwitcherItems(windowId)
  };
}

async function toggleBookmarkFromSwitcher(tabId, title, url, groupTitle, context = {}) {
  if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
    throw new Error("Invalid tab id");
  }

  if (typeof url !== "string" || url.length === 0) {
    throw new Error("Invalid bookmark URL");
  }

  const targetTab = await chrome.tabs.get(tabId);
  assertTabInSwitcherWindow(targetTab, context, "bookmark");

  const folderTitle = normalizeBookmarkFolderTitle(groupTitle);
  const existingRootFolderId = await findBookmarkFolderId();
  if (existingRootFolderId) {
    const existingParentId = await findBookmarkSubfolderId(existingRootFolderId, folderTitle);
    if (existingParentId) {
      const existingBookmarks = await chrome.bookmarks.getChildren(existingParentId);
      const matchingBookmarks = existingBookmarks.filter((bookmark) => bookmark.url === url);
      if (matchingBookmarks.length > 0) {
        await Promise.all(matchingBookmarks.map((bookmark) => chrome.bookmarks.remove(bookmark.id)));
        return false;
      }
    }
  }

  const rootFolderId = await getOrCreateBookmarkFolder();
  const parentId = await getOrCreateBookmarkSubfolder(rootFolderId, folderTitle);
  await chrome.bookmarks.create({
    parentId,
    title: typeof title === "string" && title.trim() ? title.trim() : targetTab.title ?? url,
    url
  });
  return true;
}

async function copyTabUrlFromSwitcher(tabId, url, context = {}) {
  if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
    throw new Error("Invalid tab id");
  }

  if (typeof url !== "string" || url.length === 0) {
    throw new Error("Invalid tab URL");
  }

  const targetTab = await chrome.tabs.get(tabId);
  assertTabInSwitcherWindow(targetTab, context, "copy");

  await navigator.clipboard.writeText(url);
}

async function logTabEventFromSwitcher(payload) {
  const settings = await getSettings();
  if (!settings.localServerEnabled) {
    return;
  }

  const response = await fetchLocalServer("tab-event-log", TAB_EVENT_LOG_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      eventType: payload?.eventType,
      occurredAt: payload?.occurredAt,
      source: payload?.source,
      ok: payload?.ok,
      tab: payload?.tab
    })
  });

  if (!response.ok) {
    throw new Error(`Tab event server returned ${response.status}`);
  }
}

function getEmptyTabSwitchStats() {
  return {
    generatedAt: new Date().toISOString(),
    logPath: "local server disabled",
    totalSwitches: 0,
    todaySwitches: 0,
    sevenDaySwitches: 0,
    averageSwitchesPerDay7d: 0,
    totalTrackedFocusTimeMs: 0,
    todayTopTimeByDomain: [],
    todayTopTargetDomains: [],
    todayTopRoutes: [],
    topTimeByDomain: [],
    lastSevenDays: [],
    topTargetDomains: [],
    topRoutes: [],
    topSources: [],
    recentSwitches: []
  };
}

async function getTabSwitchStatsFromServer() {
  const settings = await getSettings();
  if (!settings.localServerEnabled) {
    return getEmptyTabSwitchStats();
  }

  const response = await fetchLocalServer("tab-switch-stats", TAB_SWITCH_STATS_ENDPOINT);
  if (!response.ok) {
    throw new Error(`Tab switch stats server returned ${response.status}`);
  }

  return response.json();
}

async function getDesktopAppsFromServer() {
  const settings = await getSettings();
  if (!settings.localServerEnabled) {
    return [];
  }

  const response = await fetchLocalServer("desktop-apps", DESKTOP_APPS_ENDPOINT);
  if (!response.ok) {
    throw new Error(`Desktop apps server returned ${response.status}`);
  }

  const result = await response.json();
  return Array.isArray(result.apps) ? result.apps : [];
}

async function launchDesktopAppFromServer(appId) {
  const settings = await getSettings();
  if (!settings.localServerEnabled) {
    throw new Error("Local server integration is disabled");
  }

  if (typeof appId !== "string" || appId.length === 0) {
    throw new Error("Invalid desktop app id");
  }

  const response = await fetchLocalServer("desktop-app-launch", DESKTOP_APP_LAUNCH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      source: "chrome-extension:tab-switcher",
      appId
    })
  });

  if (!response.ok) {
    let message = `Desktop app server returned ${response.status}`;
    try {
      const result = await response.json();
      if (typeof result?.error === "string" && result.error.length > 0) {
        message = result.error;
      }
    } catch {
      // Keep the HTTP status fallback when the server does not return JSON.
    }

    throw new Error(message);
  }

  return response.json();
}

async function getWorkspaceLaunchGroups() {
  const settings = await getSettings();
  return settings.workspaceLaunchGroups;
}

async function getAppBookmarkFolderItems() {
  const folderId = await findAppBookmarkFolderId();
  if (!folderId) {
    return [];
  }

  const bookmarks = await chrome.bookmarks.getChildren(folderId);
  return bookmarks
    .filter((bookmark) => typeof bookmark.url === "string" && bookmark.url.length > 0)
    .map((bookmark) => ({
      id: bookmark.id,
      label: bookmark.title || bookmark.url,
      url: bookmark.url,
      source: "bookmarks"
    }));
}

async function getAppBookmarks() {
  return getAppBookmarkFolderItems();
}

async function addAppBookmarkFromSwitcher(tabId, title, url, context = {}) {
  if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
    throw new Error("Invalid tab id");
  }

  if (typeof url !== "string" || url.length === 0) {
    throw new Error("Invalid app bookmark URL");
  }

  const targetTab = await chrome.tabs.get(tabId);
  assertTabInSwitcherWindow(targetTab, context, "add app bookmark");

  const normalizedUrl = normalizeUrl(url);
  const parentId = await getOrCreateAppBookmarkFolder();
  const existingBookmarks = await chrome.bookmarks.getChildren(parentId);
  const existingBookmark = existingBookmarks.find(
    (bookmark) => typeof bookmark.url === "string" && normalizeUrl(bookmark.url) === normalizedUrl
  );
  const bookmarkTitle = typeof title === "string" && title.trim() ? title.trim() : targetTab.title || url;

  if (existingBookmark?.id) {
    if (existingBookmark.title !== bookmarkTitle) {
      await chrome.bookmarks.update(existingBookmark.id, { title: bookmarkTitle });
    }

    return {
      added: false,
      bookmark: {
        id: existingBookmark.id,
        label: bookmarkTitle,
        url: existingBookmark.url || url,
        source: "bookmarks"
      },
      bookmarks: await getAppBookmarks()
    };
  }

  const bookmark = await chrome.bookmarks.create({
    parentId,
    title: bookmarkTitle,
    url
  });

  return {
    added: true,
    bookmark: {
      id: bookmark.id,
      label: bookmark.title || bookmarkTitle,
      url: bookmark.url || url,
      source: "bookmarks"
    },
    bookmarks: await getAppBookmarks()
  };
}

async function resolveAppBookmarkTargetGroupId(groupId, context = {}) {
  if (typeof groupId === "number" && Number.isInteger(groupId) && groupId >= 0) {
    return groupId;
  }

  const windowId = getSwitcherContextWindowId(context);
  const activeTab = await getActiveTabInWindow(windowId);
  if (typeof activeTab?.groupId === "number" && activeTab.groupId >= 0) {
    return activeTab.groupId;
  }

  return null;
}

async function resolveAppBookmarkWindowId(context = {}) {
  const windowId = getSwitcherContextWindowId(context);
  if (typeof windowId === "number") {
    return windowId;
  }

  const focusedWindowId = await getFocusedWindowId();
  if (typeof focusedWindowId === "number") {
    return focusedWindowId;
  }

  throw new Error("Invalid window id");
}

async function openAppBookmarkInGroup(bookmarkId, groupId, insertIndex = null, context = {}) {
  const bookmarks = await getAppBookmarks();
  const bookmark = bookmarks.find((item) => item.id === bookmarkId);
  if (!bookmark) {
    throw new Error("Unknown app bookmark");
  }

  const targetGroupId = await resolveAppBookmarkTargetGroupId(groupId, context);
  const target = targetGroupId === null
    ? { group: null, windowId: await resolveAppBookmarkWindowId(context) }
    : await getValidatedGroupInSwitcherWindow(targetGroupId, context);
  const { group, windowId } = target;
  const normalizedBookmarkUrl = normalizeUrl(bookmark.url);
  const windowTabs = await chrome.tabs.query({ windowId });
  const existingTab = windowTabs.find((tab) => typeof tab.url === "string" && normalizeUrl(tab.url) === normalizedBookmarkUrl);

  if (typeof existingTab?.id === "number") {
    await switchToTab(existingTab.id, context);
    return {
      bookmark,
      openedExisting: true,
      tab: normalizeTab(existingTab),
      tabs: await collectTabSwitcherItems(windowId)
    };
  }

  const activeTab = windowTabs.find((tab) => tab.active) ?? null;
  const groupTabs = targetGroupId === null
    ? []
    : windowTabs
        .filter((tab) => tab.groupId === targetGroupId)
        .sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  const requestedInsertIndex = Number.isInteger(insertIndex) && insertIndex >= 0 ? insertIndex : null;
  const targetInsertIndex = requestedInsertIndex ?? (
    targetGroupId === null
      ? typeof activeTab?.index === "number" ? activeTab.index + 1 : windowTabs.length
      : groupTabs.length > 0
        ? Math.max(...groupTabs.map((tab) => (typeof tab.index === "number" ? tab.index : 0))) + 1
        : typeof activeTab?.index === "number" ? activeTab.index + 1 : windowTabs.length
  );
  const tab = await chrome.tabs.create({
    windowId,
    index: Math.min(windowTabs.length, targetInsertIndex),
    url: bookmark.url,
    active: true
  });
  markTabCreated(tab.id);

  if (group && typeof tab.id === "number") {
    await chrome.tabs.group({ groupId: group.id, tabIds: [tab.id] });
    await chrome.tabGroups.update(group.id, { collapsed: false });
  }

  if (typeof tab.windowId === "number") {
    await chrome.windows.update(tab.windowId, { focused: true });
  }

  scheduleSync("app-bookmark-opened");
  notifyTabSwitcherRefresh(windowId);

  return {
    bookmark,
    openedExisting: false,
    tab: normalizeTab(tab),
    tabs: await collectTabSwitcherItems(windowId)
  };
}

async function launchWorkspaceLaunchGroup(groupId, context = {}) {
  const groups = await getWorkspaceLaunchGroups();
  const group = groups.find((item) => item.id === groupId);
  if (!group) {
    throw new Error("Unknown workspace");
  }

  const windowId = getSwitcherContextWindowId(context);
  const createdTabs = [];
  const existingTabs = [];

  if (group.urls.length > 0) {
    if (typeof windowId !== "number") {
      throw new Error("Invalid window id");
    }

    const targetWindow = await chrome.windows.get(windowId);
    if (targetWindow.type !== "normal") {
      throw new Error("Workspace tabs can only open in a normal browser window");
    }

    const windowTabs = await chrome.tabs.query({ windowId });
    const tabGroups = await chrome.tabGroups.query({ windowId });
    const normalizedWorkspaceTitle = normalizeBookmarkFolderTitle(group.label).toLowerCase();
    const existingWorkspaceGroup = tabGroups.find(
      (tabGroup) => normalizeBookmarkFolderTitle(tabGroup.title || "").toLowerCase() === normalizedWorkspaceTitle
    ) ?? null;
    const existingWorkspaceGroupTabs = existingWorkspaceGroup
      ? windowTabs
          .filter((tab) => tab.groupId === existingWorkspaceGroup.id)
          .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      : [];
    const existingTabsByNormalizedUrl = new Map(
      windowTabs
        .filter((tab) => typeof tab.url === "string" && tab.url.length > 0)
        .map((tab) => [normalizeUrl(tab.url), tab])
    );
    const activeTab = windowTabs.find((tab) => tab.active) ?? null;
    let insertIndex = existingWorkspaceGroupTabs.length > 0
      ? Math.max(...existingWorkspaceGroupTabs.map((tab) => (typeof tab.index === "number" ? tab.index : 0))) + 1
      : typeof activeTab?.index === "number" ? activeTab.index + 1 : windowTabs.length;
    let firstTargetTab = null;

    for (const url of group.urls) {
      const existingTab = existingTabsByNormalizedUrl.get(normalizeUrl(url));
      if (existingTab) {
        firstTargetTab = firstTargetTab ?? existingTab;
        existingTabs.push(existingTab);
        continue;
      }

      const tab = await chrome.tabs.create({
        windowId,
        index: insertIndex,
        url,
        active: firstTargetTab === null
      });
      insertIndex += 1;
      markTabCreated(tab.id);
      firstTargetTab = firstTargetTab ?? tab;
      createdTabs.push(tab);
    }

    const createdTabIds = createdTabs.map((tab) => tab.id).filter((tabId) => typeof tabId === "number");
    if (createdTabIds.length > 0) {
      const tabGroupId = existingWorkspaceGroup
        ? await chrome.tabs.group({
            groupId: existingWorkspaceGroup.id,
            tabIds: createdTabIds
          })
        : await chrome.tabs.group({
            tabIds: createdTabIds,
            createProperties: { windowId }
          });
      await chrome.tabGroups.update(tabGroupId, {
        title: group.label,
        collapsed: false
      });
    }

    const activeCreatedTab = createdTabs.find((tab) => tab.active);
    if (!activeCreatedTab && typeof firstTargetTab?.id === "number") {
      await switchToTab(firstTargetTab.id, context);
    } else {
      await chrome.windows.update(windowId, { focused: true });
    }

    scheduleSync("workspace-launch");
    notifyTabSwitcherRefresh(windowId);
  }

  return {
    workspace: {
      id: group.id,
      label: group.label
    },
    openedTabCount: createdTabs.length,
    existingTabCount: existingTabs.length,
    tabs: typeof windowId === "number" ? await collectTabSwitcherItems(windowId) : []
  };
}

function scheduleSync(reason) {
  if (pendingSyncTimer !== null) {
    clearTimeout(pendingSyncTimer);
  }

  pendingSyncTimer = setTimeout(() => {
    pendingSyncTimer = null;
    void pushSnapshot(reason);
  }, SYNC_DEBOUNCE_MS);
}

function notifyTabSwitcherRefresh(windowId = null) {
  void chrome.runtime
    .sendMessage({
      type: REFRESH_TAB_SWITCHER_MESSAGE,
      windowId: typeof windowId === "number" ? windowId : null
    })
    .catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  void createSyncAlarm();
  void pushSnapshot("installed");
  void logCommandShortcuts().catch((error) => {
    console.warn("Tabcoach command shortcut check failed", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  void createSyncAlarm();
  void pushSnapshot("startup");
  void logCommandShortcuts().catch((error) => {
    console.warn("Tabcoach command shortcut check failed", error);
  });
});

if (chrome.notifications?.onButtonClicked) {
  chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
    void handleSmartGroupPromptButton(notificationId, buttonIndex).catch((error) => {
      console.warn("Tabcoach smart group notification handling failed", error);
    });
  });

  chrome.notifications.onClosed.addListener((notificationId) => {
    if (typeof notificationId === "string" && notificationId.startsWith(SMART_GROUP_NOTIFICATION_PREFIX)) {
      void takeSmartGroupPrompt(notificationId);
    }
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") {
    return;
  }

  settingsCache = null;
  if (changes.syncIntervalMinutes) {
    void createSyncAlarm();
  }
  void pushSnapshot("settings-changed");
});

chrome.action.onClicked.addListener((tab) => {
  void (async () => {
    if (await focusTabSwitcherPopup(tab)) {
      return;
    }

    await openTabSwitcherPopup();
  })().catch((error) => {
    console.error("Tabcoach tab switcher action click failed", error);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) {
    void pushSnapshot("alarm");
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  markTabCreated(tab?.id);
  notifyTabSwitcherRefresh(tab?.windowId);
  scheduleSync("tab-created");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (typeof tabId === "number") {
    cleanupRecentTabCreations();
  }
  if (changeInfo?.status === "complete") {
    void maybeSmartGroupNewTab(tabId).catch((error) => {
      console.warn("Tabcoach smart grouping failed", error);
    });
  }
  notifyTabSwitcherRefresh(tab?.windowId);
  scheduleSync("tab-updated");
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (typeof tabId === "number") {
    recentTabCreations.delete(tabId);
    smartGroupEvaluatedTabIds.delete(tabId);
    void removeTabFromActivationHistory(tabId, removeInfo?.windowId);
  }
  notifyTabSwitcherRefresh(removeInfo?.windowId);
  scheduleSync("tab-removed");
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void recordActivatedTab(activeInfo?.tabId, activeInfo?.windowId).catch((error) => {
    console.warn("Tabcoach tab activation history update failed", error);
  });
  notifyTabSwitcherRefresh(activeInfo?.windowId);
  scheduleSync("tab-activated");
});

if (chrome.tabGroups?.onUpdated) {
  chrome.tabGroups.onUpdated.addListener((group) => {
    notifyTabSwitcherRefresh(group?.windowId);
  });
}

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === tabSwitcherPopupWindowId) {
    tabSwitcherPopupWindowId = null;
    tabSwitcherSourceWindowId = null;
  }
  void clearWindowActivationHistory(windowId).catch((error) => {
    console.warn("Tabcoach window activation history cleanup failed", error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const switcherContext = {
    senderTab: sender.tab,
    windowId: typeof message?.windowId === "number" ? message.windowId : null
  };

  if (message?.type === GET_TAB_SWITCHER_ITEMS_MESSAGE) {
    if (typeof message.windowId !== "number") {
      sendResponse({ ok: false, error: "Invalid window id" });
      return false;
    }

    void collectTabSwitcherItems(message.windowId)
      .then((tabs) => {
        sendResponse({ ok: true, tabs });
      })
      .catch((error) => {
        console.error("Tabcoach tab switcher item collection failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === CREATE_TAB_MESSAGE) {
    void createTabFromSwitcher(switcherContext)
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch((error) => {
        console.error("Tabcoach tab create failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === DUPLICATE_TAB_MESSAGE) {
    void duplicateTabFromSwitcher(message.tabId, switcherContext)
      .then((tab) => {
        sendResponse({ ok: true, tab: tab ? normalizeTab(tab) : null });
      })
      .catch((error) => {
        console.error("Tabcoach tab duplicate failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === JUMP_NUMERIC_BOOKMARK_MESSAGE) {
    void jumpToNumericBookmark(message.bookmark, switcherContext, message.slot)
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch((error) => {
        console.error("Tabcoach numeric bookmark jump failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === LOG_TAB_EVENT_MESSAGE) {
    void logTabEventFromSwitcher(message)
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch((error) => {
        console.error("Tabcoach tab event log failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === GET_TAB_SWITCH_STATS_MESSAGE) {
    void getTabSwitchStatsFromServer()
      .then((stats) => {
        sendResponse({ ok: true, stats });
      })
      .catch((error) => {
        console.error("Tabcoach tab switch stats failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === GET_DESKTOP_APPS_MESSAGE) {
    void getDesktopAppsFromServer()
      .then((apps) => {
        sendResponse({ ok: true, apps });
      })
      .catch((error) => {
        console.error("Tabcoach desktop app list failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === LAUNCH_DESKTOP_APP_MESSAGE) {
    void launchDesktopAppFromServer(message.appId)
      .then((result) => {
        sendResponse({ ok: true, app: result?.app, launched: Boolean(result?.launched) });
      })
      .catch((error) => {
        console.error("Tabcoach desktop app launch failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === GET_APP_BOOKMARKS_MESSAGE) {
    void getAppBookmarks()
      .then((bookmarks) => {
        sendResponse({ ok: true, bookmarks });
      })
      .catch((error) => {
        console.error("Tabcoach app bookmark list failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === ADD_APP_BOOKMARK_MESSAGE) {
    void addAppBookmarkFromSwitcher(message.tabId, message.title, message.url, switcherContext)
      .then((result) => {
        sendResponse({ ok: true, ...result });
      })
      .catch((error) => {
        console.error("Tabcoach app bookmark add failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === OPEN_APP_BOOKMARK_MESSAGE) {
    void openAppBookmarkInGroup(message.bookmarkId, message.groupId, message.insertIndex, switcherContext)
      .then((result) => {
        sendResponse({ ok: true, ...result });
      })
      .catch((error) => {
        console.error("Tabcoach app bookmark open failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === GET_WORKSPACE_LAUNCH_GROUPS_MESSAGE) {
    void getWorkspaceLaunchGroups()
      .then((groups) => {
        sendResponse({ ok: true, groups });
      })
      .catch((error) => {
        console.error("Tabcoach workspace list failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === LAUNCH_WORKSPACE_LAUNCH_GROUP_MESSAGE) {
    void launchWorkspaceLaunchGroup(message.groupId, switcherContext)
      .then((result) => {
        sendResponse({ ok: true, ...result });
      })
      .catch((error) => {
        console.error("Tabcoach workspace launch failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === SUGGEST_TAB_GROUPS_MESSAGE) {
    void suggestTabGroupsFromSwitcher(switcherContext)
      .then((result) => {
        sendResponse({ ok: true, ...result });
      })
      .catch((error) => {
        console.error("Tabcoach tab group suggestion failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === RESOLVE_SMART_GROUP_PROMPT_MESSAGE) {
    void resolveSmartGroupPromptFromSwitcher(message.promptId, Boolean(message.accept), switcherContext)
      .then((tabs) => {
        sendResponse({ ok: true, tabs });
      })
      .catch((error) => {
        console.error("Tabcoach smart group prompt resolve failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === SUGGEST_GROUP_FOR_TAB_MESSAGE) {
    void suggestGroupForTabFromSwitcher(message.tabId, switcherContext)
      .then((result) => {
        sendResponse({ ok: true, ...result });
      })
      .catch((error) => {
        console.error("Tabcoach single tab group suggestion failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === APPLY_TAB_GROUPS_MESSAGE) {
    void applyTabGroupPlanFromSwitcher(message.groups, switcherContext)
      .then((result) => {
        sendResponse({ ok: true, ...result });
      })
      .catch((error) => {
        console.error("Tabcoach tab group apply failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === COPY_TAB_URL_MESSAGE) {
    void copyTabUrlFromSwitcher(message.tabId, message.url, switcherContext)
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch((error) => {
        console.error("Tabcoach copy tab URL failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === TOGGLE_BOOKMARK_MESSAGE) {
    void toggleBookmarkFromSwitcher(message.tabId, message.title, message.url, message.groupTitle, switcherContext)
      .then((bookmarked) => {
        sendResponse({ ok: true, bookmarked });
      })
      .catch((error) => {
        console.error("Tabcoach bookmark toggle failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === MOVE_TAB_MESSAGE) {
    void moveTabFromSwitcher(message.tabId, message.index, message.groupId, switcherContext)
      .then((tabs) => {
        sendResponse({ ok: true, tabs });
      })
      .catch((error) => {
        console.error("Tabcoach tab move failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === CREATE_GROUP_MESSAGE) {
    void createGroupFromSwitcher(message.tabId, message.title, switcherContext)
      .then((tabs) => {
        sendResponse({ ok: true, tabs });
      })
      .catch((error) => {
        console.error("Tabcoach group create failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === SET_TAB_GROUP_MESSAGE) {
    void setTabGroupFromSwitcher(message.tabId, message.groupId, switcherContext)
      .then((tabs) => {
        sendResponse({ ok: true, tabs });
      })
      .catch((error) => {
        console.error("Tabcoach tab group move failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === SET_GROUP_COLLAPSED_MESSAGE) {
    void setGroupCollapsedFromSwitcher(message.groupId, message.collapsed, switcherContext)
      .then((tabs) => {
        sendResponse({ ok: true, tabs });
      })
      .catch((error) => {
        console.error("Tabcoach group collapse update failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === RENAME_GROUP_MESSAGE) {
    void renameGroupFromSwitcher(message.groupId, message.title, switcherContext)
      .then((tabs) => {
        sendResponse({ ok: true, tabs });
      })
      .catch((error) => {
        console.error("Tabcoach group rename failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === CLOSE_GROUP_MESSAGE) {
    void closeGroupFromSwitcher(message.groupId, switcherContext)
      .then((tabs) => {
        sendResponse({ ok: true, tabs });
      })
      .catch((error) => {
        console.error("Tabcoach group close failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === OPEN_GROUP_BOOKMARK_MESSAGE) {
    void openGroupBookmarkFromSwitcher(message.groupId, message.bookmarkId, message.insertOffset, switcherContext)
      .then((result) => {
        sendResponse({ ok: true, ...result });
      })
      .catch((error) => {
        console.error("Tabcoach group bookmark open failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === CLOSE_TAB_MESSAGE) {
    void closeTabFromSwitcher(message.tabId, switcherContext)
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch((error) => {
        console.error("Tabcoach tab close failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type !== SWITCH_TAB_MESSAGE) {
    return false;
  }

  void switchToTab(message.tabId, switcherContext)
    .then(() => {
      sendResponse({ ok: true });
    })
    .catch((error) => {
      console.error("Tabcoach tab switch failed", error);
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });

  return true;
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "show-tab-switcher") {
    void (async () => {
      if (await focusTabSwitcherPopup(tab)) {
        return;
      }

      await openTabSwitcherPopup();
    })().catch((error) => {
      console.error("Tabcoach tab switcher failed", error);
    });
    return;
  }

  if (command === PREVIOUS_TAB_COMMAND) {
    void switchToPreviousTab(tab).catch((error) => {
      console.error("Tabcoach previous tab failed", error);
    });
    return;
  }

  if (command === NEXT_TAB_IN_HISTORY_COMMAND) {
    void switchToNextTabInHistory(tab).catch((error) => {
      console.error("Tabcoach next tab in history failed", error);
    });
    return;
  }

  const assignNumericBookmarkSlot = getNumericBookmarkCommandSlot(command, ASSIGN_NUMERIC_BOOKMARK_COMMAND_PREFIX);
  if (assignNumericBookmarkSlot !== null) {
    void (async () => {
      if (await forwardNumericBookmarkCommandToPopup("assign", assignNumericBookmarkSlot, tab)) {
        return;
      }

      await assignNumericBookmarkFromActiveTab(assignNumericBookmarkSlot, tab);
    })().catch((error) => {
      console.error("Tabcoach numeric bookmark assign failed", error);
      void showNumericBookmarkCommandError(assignNumericBookmarkSlot, tab, error);
    });
    return;
  }

  const jumpNumericBookmarkSlot = getNumericBookmarkCommandSlot(command, JUMP_NUMERIC_BOOKMARK_COMMAND_PREFIX);
  if (jumpNumericBookmarkSlot !== null) {
    void (async () => {
      if (await forwardNumericBookmarkCommandToPopup("jump", jumpNumericBookmarkSlot, tab)) {
        return;
      }

      await jumpToNumericBookmarkSlot(jumpNumericBookmarkSlot, tab);
    })().catch((error) => {
      console.error("Tabcoach numeric bookmark jump failed", error);
      void showNumericBookmarkCommandError(jumpNumericBookmarkSlot, tab, error);
    });
  }
});

// Debug entry points, reachable from the service worker console even if the
// console evaluates outside this script's own scope.
globalThis.smartGroupActiveTab = smartGroupActiveTab;
globalThis.maybeSmartGroupNewTab = maybeSmartGroupNewTab;

void getSettings()
  .then((settings) => {
    console.info(`Tabcoach background loaded (build ${BACKGROUND_BUILD})`, {
      smartGroupMode: settings.smartGroupMode,
      localServerEnabled: settings.localServerEnabled,
      serverBaseUrl: settings.serverBaseUrl
    });
  })
  .catch(() => {
    console.info(`Tabcoach background loaded (build ${BACKGROUND_BUILD})`);
  });
