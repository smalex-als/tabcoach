const DEFAULT_SETTINGS = {
  serverBaseUrl: "http://127.0.0.1:3847",
  autoCloseDuplicates: true,
  docsGrouping: true,
  fetchDiagnostics: true,
  syncIntervalMinutes: 1,
  switcherOpenLeft: false,
  badgeMode: "both"
};
const SYNC_ENDPOINT = "/api/sync";
const TTS_SELECTION_ENDPOINT = "/api/tts-selection";
const TAB_SWITCH_LOG_ENDPOINT = "/api/tab-switch";
const TAB_SWITCH_STATS_ENDPOINT = "/api/tab-switch-stats";
const TAB_EVENT_LOG_ENDPOINT = "/api/tab-event";
const DESKTOP_APPS_ENDPOINT = "/api/desktop-apps";
const DESKTOP_APP_LAUNCH_ENDPOINT = "/api/desktop-apps/launch";
const SYNC_ALARM = "tabcoach-sync";
const SYNC_DEBOUNCE_MS = 1500;
const DEFAULT_SWITCHER_POPUP_WIDTH = 940;
const DEFAULT_SWITCHER_POPUP_HEIGHT = 720;
const LEFT_SWITCHER_POPUP_WIDTH = 800;
const NEW_TAB_DUPLICATE_GRACE_MS = 3 * 60 * 1000;
const DOCS_GROUP_TITLE = "Docs";
const DOCS_GROUP_COLOR = "blue";
const TRANSIENT_RETRY_ATTEMPTS = 4;
const TRANSIENT_RETRY_DELAY_MS = 500;
const TTS_SUCCESS_BADGE_MS = 3000;
const NUMERIC_BOOKMARK_BADGE_MS = 1500;
const ACTION_TITLE = "Tabcoach";
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
const BOOKMARK_GROUP_SNAPSHOT_MESSAGE = "tabcoach:bookmark-group-snapshot";
const OPEN_GROUP_SNAPSHOT_BOOKMARKS_MESSAGE = "tabcoach:open-group-snapshot-bookmarks";
const TOGGLE_BOOKMARK_MESSAGE = "tabcoach:toggle-bookmark";
const COPY_TAB_URL_MESSAGE = "tabcoach:copy-tab-url";
const LOG_TAB_EVENT_MESSAGE = "tabcoach:log-tab-event";
const GET_TAB_SWITCH_STATS_MESSAGE = "tabcoach:get-tab-switch-stats";
const GET_DESKTOP_APPS_MESSAGE = "tabcoach:get-desktop-apps";
const LAUNCH_DESKTOP_APP_MESSAGE = "tabcoach:launch-desktop-app";
const BOOKMARK_FOLDER_TITLE = "Tabcoach";
const ASSIGN_NUMERIC_BOOKMARK_COMMAND_PREFIX = "assign-numeric-bookmark-";
const JUMP_NUMERIC_BOOKMARK_COMMAND_PREFIX = "jump-numeric-bookmark-";
const PREVIOUS_TAB_COMMAND = "previous-tab";
const NEXT_TAB_IN_HISTORY_COMMAND = "next-tab-in-history";
const TAB_ACTIVATION_HISTORY_KEY = "tabActivationHistory";
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
const tabActivationHistoryByWindowId = new Map();
const tabForwardHistoryByWindowId = new Map();
const suppressedActivationHistoryByWindowId = new Map();

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
    serverBaseUrl,
    autoCloseDuplicates: Boolean(settings.autoCloseDuplicates),
    docsGrouping: Boolean(settings.docsGrouping),
    fetchDiagnostics: Boolean(settings.fetchDiagnostics),
    syncIntervalMinutes: Number.isFinite(syncIntervalMinutes) && syncIntervalMinutes >= 1 ? syncIntervalMinutes : DEFAULT_SETTINGS.syncIntervalMinutes,
    switcherOpenLeft: Boolean(settings.switcherOpenLeft),
    badgeMode: badgeModes.has(settings.badgeMode) ? settings.badgeMode : DEFAULT_SETTINGS.badgeMode
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

async function restoreServerHealthBadge() {
  if (lastServerHealth.ok === true) {
    await chrome.action.setBadgeText({ text: lastServerHealth.badgeText });
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

  recentTabCreations.set(tabId, Date.now());
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

function isDocsUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);

    if (parsed.hostname !== "docs.google.com") {
      return false;
    }

    return /^\/(document|spreadsheets|presentation)\/d\/[^/]+/.test(parsed.pathname);
  } catch {
    return false;
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

async function ensureDocsGroup(protectedWindowId = null, settings) {
  if (!settings.docsGrouping) {
    return;
  }

  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const docsTabs = windows
    .flatMap((window) => window.tabs ?? [])
    .filter(
      (tab) =>
        typeof tab.id === "number" &&
        typeof tab.url === "string" &&
        isDocsUrl(tab.url) &&
        (protectedWindowId === null || tab.windowId !== protectedWindowId)
    );

  if (docsTabs.length === 0) {
    return;
  }

  const docsTabIds = docsTabs.map((tab) => tab.id);
  const existingGroupIds = [...new Set(docsTabs.map((tab) => tab.groupId).filter((groupId) => typeof groupId === "number" && groupId >= 0))];

  let docsGroupId = null;
  let docsGroupCollapsed = false;

  for (const groupId of existingGroupIds) {
    try {
      const group = await chrome.tabGroups.get(groupId);
      if (group.title === DOCS_GROUP_TITLE) {
        docsGroupId = groupId;
        docsGroupCollapsed = group.collapsed;
        break;
      }
    } catch (error) {
      console.warn("Tabcoach group lookup failed", groupId, error);
    }
  }

  if (docsGroupId === null) {
    docsGroupId = await withTransientRetry(() => chrome.tabs.group({ tabIds: docsTabIds }), "docs-group-create");
  } else {
    await withTransientRetry(() => chrome.tabs.group({ groupId: docsGroupId, tabIds: docsTabIds }), "docs-group-assign");
  }

  await withTransientRetry(
    () =>
      chrome.tabGroups.update(docsGroupId, {
        title: DOCS_GROUP_TITLE,
        color: DOCS_GROUP_COLOR,
        collapsed: docsGroupCollapsed
      }),
    "docs-group-update"
  );
}

async function pushSnapshot(reason) {
  try {
    const settings = await getSettings();
    const protectedWindowId = await getFocusedWindowId();
    const tabs = await collectTabs();
    await closeDuplicateTabs(tabs, settings);
    await ensureDocsGroup(protectedWindowId, settings);
    const refreshedTabs = await collectTabs();
    const response = await fetchLocalServer("sync", SYNC_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        source: `chrome-extension:${reason}`,
        capturedAt: new Date().toISOString(),
        tabs: refreshedTabs
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

async function showTtsSuccessFeedback(selectedText) {
  await chrome.action.setBadgeBackgroundColor({ color: "#1d4ed8" });
  await chrome.action.setBadgeText({ text: "TTS" });

  if (badgeResetTimer !== null) {
    clearTimeout(badgeResetTimer);
  }

  badgeResetTimer = setTimeout(() => {
    badgeResetTimer = null;
    void restoreServerHealthBadge();
  }, TTS_SUCCESS_BADGE_MS);

  const notificationText = "Text-to-speech started";

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

    if (activeTab?.id) {
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: (message) => {
          const getSelectionAnchor = () => {
            const selection = window.getSelection();
            if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
              const range = selection.getRangeAt(0);
              const rects = range.getClientRects();
              const rect = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
              if (rect && (rect.width > 0 || rect.height > 0)) {
                return {
                  left: rect.left + window.scrollX,
                  top: rect.bottom + window.scrollY
                };
              }
            }

            const activeElement = document.activeElement;
            if (
              activeElement instanceof HTMLTextAreaElement ||
              (activeElement instanceof HTMLInputElement &&
                ["text", "search", "url", "tel", "password"].includes(activeElement.type))
            ) {
              const rect = activeElement.getBoundingClientRect();
              return {
                left: rect.left + window.scrollX,
                top: rect.bottom + window.scrollY
              };
            }

            return null;
          };

          const existingToast = document.getElementById("__tabcoach_tts_toast");
          if (existingToast) {
            existingToast.remove();
          }

          const anchor = getSelectionAnchor();
          const margin = 12;
          const toastWidth = 440;
          const horizontalOffset = 48;
          const toast = document.createElement("div");
          toast.id = "__tabcoach_tts_toast";
          toast.textContent = message;
          Object.assign(toast.style, {
            position: "fixed",
            top: anchor
              ? `${Math.max(margin, anchor.top - window.scrollY + 18)}px`
              : "20px",
            left: anchor
              ? `${Math.max(
                  margin,
                  Math.min(
                    anchor.left - window.scrollX + horizontalOffset,
                    window.innerWidth - toastWidth - margin
                  )
                )}px`
              : "",
            right: anchor ? "" : "20px",
            zIndex: "2147483647",
            maxWidth: `${toastWidth}px`,
            padding: "18px 24px",
            borderRadius: "14px",
            background: "rgba(17, 24, 39, 0.96)",
            color: "#ffffff",
            font: "18px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            boxShadow: "0 12px 32px rgba(0, 0, 0, 0.28)",
            whiteSpace: "pre-wrap",
            pointerEvents: "none",
            textAlign: "center"
          });

          document.documentElement.appendChild(toast);
          setTimeout(() => {
            toast.remove();
          }, 3000);
        },
        args: [notificationText]
      });
      return;
    }
  } catch (error) {
    console.warn("Tabcoach toast injection failed", error);
  }

  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon-128.png"),
      title: "Tabcoach TTS started",
      message: notificationText
    });
  } catch (error) {
    console.warn("Tabcoach notification failed", error);
  }
}

async function getSelectedTextFromTab(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const activeElement = document.activeElement;

      if (
        activeElement instanceof HTMLTextAreaElement ||
        (activeElement instanceof HTMLInputElement &&
          ["text", "search", "url", "tel", "password"].includes(activeElement.type))
      ) {
        const start = activeElement.selectionStart ?? 0;
        const end = activeElement.selectionEnd ?? 0;
        return activeElement.value.slice(start, end).trim();
      }

      return window.getSelection()?.toString().trim() ?? "";
    }
  });

  return typeof result?.result === "string" ? result.result.trim() : "";
}

async function sendSelectionToTts() {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  if (!activeTab?.id) {
    throw new Error("No active tab");
  }

  const selectedText = await getSelectedTextFromTab(activeTab.id);
  if (!selectedText) {
    throw new Error("No selected text found");
  }

  const settings = await getSettings();
  const response = await fetchLocalServer("tts-selection", TTS_SELECTION_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      source: "chrome-extension:command",
      text: selectedText,
      pageTitle: activeTab.title ?? "",
      pageUrl: activeTab.url ?? ""
    })
  }, settings);

  if (!response.ok) {
    throw new Error(`TTS server returned ${response.status}`);
  }

  await showTtsSuccessFeedback(selectedText);
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
    const jiraTicket = parsed.pathname.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/);
    if (jiraTicket) {
      return jiraTicket[1];
    }

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
  return `${normalizeBookmarkFolderTitle(baseTitle)} - ${formatBookmarkSnapshotTimestamp()}`;
}

async function collectGroupSnapshotTitles() {
  const rootFolderId = await findBookmarkFolderId();
  if (!rootFolderId) {
    return new Set();
  }

  const children = await chrome.bookmarks.getChildren(rootFolderId);
  return new Set(children.filter((bookmark) => !bookmark.url).map((bookmark) => bookmark.title));
}

async function collectBookmarkedUrls(tabs) {
  const bookmarkedUrls = new Set();

  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.url) {
        return;
      }

      try {
        const bookmarks = await chrome.bookmarks.search({ url: tab.url });
        if (bookmarks.some((bookmark) => bookmark.url === tab.url)) {
          bookmarkedUrls.add(tab.url);
        }
      } catch (error) {
        console.warn("Tabcoach bookmark lookup failed", tab.url, error);
      }
    })
  );

  return bookmarkedUrls;
}

async function collectTabSwitcherItems(windowId) {
  const currentWindowTabs = await chrome.tabs.query({ windowId });
  const tabGroups = await chrome.tabGroups.query({ windowId });
  const tabGroupsById = new Map(tabGroups.map((group) => [group.id, group]));
  const snapshotFolderTitles = await collectGroupSnapshotTitles();
  const bookmarkedUrls = await collectBookmarkedUrls(currentWindowTabs);

  const items = currentWindowTabs.map((tab) => {
    const group = typeof tab.groupId === "number" && tab.groupId >= 0 ? tabGroupsById.get(tab.groupId) : null;
    const groupSnapshotExists = group
      ? snapshotFolderTitles.has(getBookmarkSnapshotFolderTitle(group.title || "Unnamed group"))
      : false;
    const item = toTabSwitcherItem(tab, group);

    return {
      ...item,
      group: item.group
        ? {
            ...item.group,
            snapshotExists: groupSnapshotExists
          }
        : null,
      bookmarked: Boolean(tab.url && bookmarkedUrls.has(tab.url))
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

  const popupWindow = await chrome.windows.create({
    url: popupUrl,
    type: "popup",
    ...getTabSwitcherPopupBounds(focusedWindow, settings),
    focused: true
  });
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

  void fetchLocalServer("tab-switch-log", TAB_SWITCH_LOG_ENDPOINT, {
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
  }).catch((error) => {
    console.warn("Tabcoach tab switch log failed", error);
  });

  if (typeof targetTab.windowId === "number") {
    await chrome.windows.update(targetTab.windowId, { focused: true });
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

  await chrome.tabGroups.update(groupId, { title: title.trim() });
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

function normalizeBookmarkFolderTitle(title) {
  const normalized = typeof title === "string" ? title.trim().replace(/\s+/g, " ") : "";
  return normalized || "Ungrouped";
}

function formatBookmarkSnapshotTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate())
  ].join("");
}

async function createBookmarkSnapshotFolder(parentId, baseTitle) {
  const children = await chrome.bookmarks.getChildren(parentId);
  const snapshotTitle = `${normalizeBookmarkFolderTitle(baseTitle)} - ${formatBookmarkSnapshotTimestamp()}`;
  const existingFolder = children.find((bookmark) => bookmark.title === snapshotTitle && !bookmark.url);

  if (existingFolder?.id) {
    return existingFolder;
  }

  return chrome.bookmarks.create({ parentId, title: snapshotTitle });
}

async function findBookmarkSnapshotFolder(parentId, baseTitle) {
  const children = await chrome.bookmarks.getChildren(parentId);
  const snapshotTitle = `${normalizeBookmarkFolderTitle(baseTitle)} - ${formatBookmarkSnapshotTimestamp()}`;
  return children.find((bookmark) => bookmark.title === snapshotTitle && !bookmark.url) ?? null;
}

async function bookmarkGroupSnapshotFromSwitcher(groupId, context = {}) {
  if (typeof groupId !== "number" || !Number.isInteger(groupId) || groupId < 0) {
    throw new Error("Invalid group id");
  }

  const windowId = getSwitcherContextWindowId(context);
  if (typeof windowId !== "number") {
    throw new Error("Invalid window id");
  }

  const group = await chrome.tabGroups.get(groupId);
  if (group.windowId !== windowId) {
    throw new Error("Cannot bookmark a group outside the current window");
  }

  const groupTabs = (await chrome.tabs.query({ windowId }))
    .filter((tab) => tab.groupId === groupId && typeof tab.url === "string" && tab.url.length > 0)
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0));

  if (groupTabs.length === 0) {
    throw new Error("No bookmarkable tabs in this group");
  }

  const rootFolderId = await getOrCreateBookmarkFolder();
  const snapshotFolder = await createBookmarkSnapshotFolder(rootFolderId, group.title || "Unnamed group");
  const existingSnapshotBookmarks = await chrome.bookmarks.getChildren(snapshotFolder.id);
  const existingSnapshotUrls = new Set(
    existingSnapshotBookmarks
      .map((bookmark) => bookmark.url)
      .filter((url) => typeof url === "string" && url.length > 0)
  );
  let createdCount = 0;

  for (const tab of groupTabs) {
    if (existingSnapshotUrls.has(tab.url)) {
      continue;
    }

    await chrome.bookmarks.create({
      parentId: snapshotFolder.id,
      title: tab.title || tab.url,
      url: tab.url
    });
    existingSnapshotUrls.add(tab.url);
    createdCount += 1;
  }

  return {
    folderId: snapshotFolder.id,
    title: snapshotFolder.title,
    count: groupTabs.length,
    createdCount
  };
}

async function openGroupSnapshotBookmarksFromSwitcher(groupId, context = {}) {
  if (typeof groupId !== "number" || !Number.isInteger(groupId) || groupId < 0) {
    throw new Error("Invalid group id");
  }

  const windowId = getSwitcherContextWindowId(context);
  if (typeof windowId !== "number") {
    throw new Error("Invalid window id");
  }

  const group = await chrome.tabGroups.get(groupId);
  if (group.windowId !== windowId) {
    throw new Error("Cannot open bookmarks for a group outside the current window");
  }

  const rootFolderId = await getOrCreateBookmarkFolder();
  let snapshotFolder = await findBookmarkSnapshotFolder(rootFolderId, group.title || "Unnamed group");
  if (!snapshotFolder?.id) {
    const snapshot = await bookmarkGroupSnapshotFromSwitcher(groupId, context);
    snapshotFolder = {
      id: snapshot.folderId,
      title: snapshot.title
    };
  }

  const bookmarkManagerTab = await chrome.tabs.create({
    windowId,
    url: `chrome://bookmarks/?id=${encodeURIComponent(snapshotFolder.id)}`,
    active: true
  });

  if (typeof bookmarkManagerTab.id === "number") {
    try {
      await chrome.tabs.group({ groupId, tabIds: [bookmarkManagerTab.id] });
    } catch (error) {
      console.warn("Tabcoach could not add bookmark manager tab to source group", error);
    }
  }

  return {
    folderId: snapshotFolder.id,
    title: snapshotFolder.title
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

  const existingBookmarks = await chrome.bookmarks.search({ url });
  const existingBookmark = existingBookmarks.find((bookmark) => bookmark.url === url);

  if (existingBookmark?.id) {
    await chrome.bookmarks.remove(existingBookmark.id);
    return false;
  }

  const rootFolderId = await getOrCreateBookmarkFolder();
  const parentId = await getOrCreateBookmarkSubfolder(rootFolderId, normalizeBookmarkFolderTitle(groupTitle));
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

async function getTabSwitchStatsFromServer() {
  const response = await fetchLocalServer("tab-switch-stats", TAB_SWITCH_STATS_ENDPOINT);
  if (!response.ok) {
    throw new Error(`Tab switch stats server returned ${response.status}`);
  }

  return response.json();
}

async function getDesktopAppsFromServer() {
  const response = await fetchLocalServer("desktop-apps", DESKTOP_APPS_ENDPOINT);
  if (!response.ok) {
    throw new Error(`Desktop apps server returned ${response.status}`);
  }

  const result = await response.json();
  return Array.isArray(result.apps) ? result.apps : [];
}

async function launchDesktopAppFromServer(appId) {
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
    throw new Error(`Desktop app server returned ${response.status}`);
  }

  return response.json();
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
  notifyTabSwitcherRefresh(tab?.windowId);
  scheduleSync("tab-updated");
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (typeof tabId === "number") {
    recentTabCreations.delete(tabId);
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

  if (message?.type === BOOKMARK_GROUP_SNAPSHOT_MESSAGE) {
    void bookmarkGroupSnapshotFromSwitcher(message.groupId, switcherContext)
      .then((snapshot) => {
        sendResponse({ ok: true, snapshot });
      })
      .catch((error) => {
        console.error("Tabcoach group bookmark snapshot failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === OPEN_GROUP_SNAPSHOT_BOOKMARKS_MESSAGE) {
    void openGroupSnapshotBookmarksFromSwitcher(message.groupId, switcherContext)
      .then((snapshot) => {
        sendResponse({ ok: true, snapshot });
      })
      .catch((error) => {
        console.error("Tabcoach group bookmark snapshot open failed", error);
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

  if (command === "speak-selection") {
    void sendSelectionToTts().catch((error) => {
      console.error("Tabcoach TTS selection failed", error);
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
