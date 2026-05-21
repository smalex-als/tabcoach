const GET_TAB_SWITCHER_ITEMS_MESSAGE = "tabcoach:get-tab-switcher-items";
const CREATE_TAB_MESSAGE = "tabcoach:create-tab";
const DUPLICATE_TAB_MESSAGE = "tabcoach:duplicate-tab";
const JUMP_NUMERIC_BOOKMARK_MESSAGE = "tabcoach:jump-numeric-bookmark";
const POPUP_NUMERIC_BOOKMARK_COMMAND_MESSAGE = "tabcoach:popup-numeric-bookmark-command";
const FOCUS_TAB_SWITCHER_SEARCH_MESSAGE = "tabcoach:focus-tab-switcher-search";
const REFRESH_TAB_SWITCHER_MESSAGE = "tabcoach:refresh-tab-switcher";
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
const GET_DESKTOP_APPS_MESSAGE = "tabcoach:get-desktop-apps";
const LAUNCH_DESKTOP_APP_MESSAGE = "tabcoach:launch-desktop-app";
const GET_APP_BOOKMARKS_MESSAGE = "tabcoach:get-app-bookmarks";
const ADD_APP_BOOKMARK_MESSAGE = "tabcoach:add-app-bookmark";
const OPEN_APP_BOOKMARK_MESSAGE = "tabcoach:open-app-bookmark";
const GET_WORKSPACE_LAUNCH_GROUPS_MESSAGE = "tabcoach:get-workspace-launch-groups";
const LAUNCH_WORKSPACE_LAUNCH_GROUP_MESSAGE = "tabcoach:launch-workspace-launch-group";
const NUMERIC_BOOKMARKS_KEY = "numericBookmarks";
const SWITCHER_OPEN_LEFT_KEY = "switcherOpenLeft";
const FOCUSED_GROUPS_KEY = "focusedGroupIdsByWindow";
const TAB_LABELS_KEY = "tabLabelsByWindow";

const groupColors = {
  grey: "#9ca3af",
  blue: "#60a5fa",
  red: "#f87171",
  yellow: "#facc15",
  green: "#4ade80",
  pink: "#f472b6",
  purple: "#c084fc",
  cyan: "#22d3ee",
  orange: "#fb923c"
};
const ungroupedColor = "#6b7280";
const FALLBACK_DESKTOP_APPS = [{ id: "iterm", label: "iTerm" }];
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

const params = new URLSearchParams(window.location.search);
const windowId = Number(params.get("windowId"));
const list = document.getElementById("list");
const desktopApps = document.getElementById("desktopApps");
const searchInput = document.getElementById("searchInput");
const newTabButton = document.getElementById("newTabButton");
const closeButton = document.getElementById("closeButton");
const sortButtons = [...document.querySelectorAll(".sort-button")];
const shell = document.querySelector(".shell");

document.body.classList.toggle("window-blurred", !document.hasFocus());

let tabs = [];
let duplicateCountsByTabId = new Map();
let numericBookmarks = {};
let numericBookmarkSlotsByNormalizedUrl = new Map();
let tabLabelsByUrl = {};
let visibleTabs = [];
let rows = [];
let tabRows = [];
let appBookmarks = [];
let desktopAppItems = FALLBACK_DESKTOP_APPS;
let workspaceLaunchGroups = [];
let launchersExpanded = false;
let sortMode = "window";
let searchQuery = "";
let selectedIndex = 0;
let focusedGroupId = null;
let renamingGroupId = null;
let editingLabelTabId = null;
let editingLabelDraft = "";
let keepOpenAfterSwitch = false;
let draggedTabId = null;
let dropTarget = null;
let refreshTimer = null;
let suppressNextRowClick = false;
let pointerDownRowIndex = null;
let contextMenu = null;
let isReplacingListChildren = false;
const expandedBookmarkGroupIds = new Set();

function sendMessage(message) {
  return chrome.runtime.sendMessage({ windowId, ...message });
}

function getFocusStorageArea() {
  return chrome.storage.session ?? chrome.storage.local;
}

function getTabLabelStorageArea() {
  return chrome.storage.local ?? chrome.storage.sync;
}

function assertResponse(response, fallbackMessage) {
  if (!response?.ok) {
    throw new Error(response?.error || fallbackMessage);
  }

  return response;
}

function formatUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname;
    const pathParts = parsed.pathname.split("/").filter(Boolean);

    if (host.endsWith(".atlassian.net") && pathParts[0] === "browse" && pathParts[1]) {
      return `${host}/browse/${pathParts[1]}`;
    }

    return host;
  } catch {
    return rawUrl;
  }
}

function formatTabTitle(tab) {
  const title = tab?.displayTitle || tab?.title || tab?.url || "Untitled tab";
  const separator = " - ";
  const separatorIndex = title.indexOf(separator);
  if (separatorIndex > 0) {
    const prefix = title.slice(0, separatorIndex).trim();
    const suffix = title.slice(separatorIndex + separator.length).trim();
    const suffixLooksTechnical = suffix.length > 48 && !/\s/.test(suffix);
    if (prefix && suffixLooksTechnical) {
      return prefix;
    }
  }

  return title;
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

function getTabSearchText(tab) {
  return [
    tab.displayTitle,
    tab.title,
    tab.url,
    tab.group?.title,
    tab.label,
    tab.active ? "active" : "",
    tab.pinned ? "pinned" : "",
    tab.bookmarked ? "bookmarked" : ""
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function refreshVisibleTabs() {
  const query = searchQuery.trim().toLowerCase();
  visibleTabs = query ? tabs.filter((tab) => getTabSearchText(tab).includes(query)) : [...tabs];
  if (focusedGroupId !== null && tabs.some((tab) => tab.group?.id === focusedGroupId)) {
    visibleTabs = visibleTabs.filter((tab) => tab.group?.id === focusedGroupId);
  } else {
    const staleFocusedGroupId = focusedGroupId;
    focusedGroupId = null;
    if (staleFocusedGroupId !== null) {
      void persistFocusedGroupId(null).catch(reportActionError);
    }
  }

  if (sortMode === "recent") {
    visibleTabs.sort((left, right) => (right.lastAccessed || 0) - (left.lastAccessed || 0));
  }
}

function findDuplicateCountsByTabId(tabItems) {
  const grouped = new Map();

  for (const tab of tabItems) {
    if (!tab.url || tab.url.startsWith("chrome://")) {
      continue;
    }

    const normalizedUrl = normalizeUrl(tab.url);
    const entries = grouped.get(normalizedUrl) ?? [];
    entries.push(tab);
    grouped.set(normalizedUrl, entries);
  }

  const counts = new Map();
  for (const groupTabs of grouped.values()) {
    if (groupTabs.length <= 1) {
      continue;
    }

    groupTabs.forEach((tab) => {
      counts.set(tab.id, groupTabs.length);
    });
  }

  return counts;
}

function getDuplicateTabsForTab(tab) {
  if (!tab?.url || tab.url.startsWith("chrome://")) {
    return [];
  }

  const normalizedUrl = normalizeUrl(tab.url);
  return tabs.filter(
    (item) => Number.isFinite(item.id) && item.id !== tab.id && item.url && normalizeUrl(item.url) === normalizedUrl
  );
}

function refreshDuplicateCounts() {
  duplicateCountsByTabId = findDuplicateCountsByTabId(tabs);
}

function dedupeTabsById(items) {
  const seenTabIds = new Set();
  return items.filter((tab) => {
    if (seenTabIds.has(tab.id)) {
      return false;
    }

    seenTabIds.add(tab.id);
    return true;
  });
}

function applyTabLabels(items) {
  return items.map((tab) => ({
    ...tab,
    label: typeof tabLabelsByUrl[getTabLabelKey(tab)] === "string" ? tabLabelsByUrl[getTabLabelKey(tab)] : ""
  }));
}

function setTabs(nextTabs) {
  tabs = applyTabLabels(dedupeTabsById(nextTabs));
}

function refreshNumericBookmarkSlots() {
  numericBookmarkSlotsByNormalizedUrl = new Map();

  Object.entries(numericBookmarks).forEach(([slot, bookmark]) => {
    if (!bookmark?.normalizedUrl) {
      return;
    }

    const slots = numericBookmarkSlotsByNormalizedUrl.get(bookmark.normalizedUrl) ?? [];
    slots.push(slot);
    numericBookmarkSlotsByNormalizedUrl.set(bookmark.normalizedUrl, slots);
  });
}

function setError(message) {
  list.replaceChildren();
  const error = document.createElement("div");
  error.className = "error";
  error.textContent = message;
  list.appendChild(error);
}

function reportActionError(error) {
  console.error("Tabcoach tab switcher action failed", error);
  setError(error instanceof Error ? error.message : String(error));
}

function updateSortButtons() {
  for (const button of sortButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.sortMode === sortMode));
  }
}

function getTabActionLabel(tab) {
  return tab ? formatTabTitle(tab) : "selected tab";
}

function getTabById(tabId) {
  return tabs.find((tab) => tab.id === tabId) ?? null;
}

function getGroupById(groupId) {
  return tabs.find((tab) => tab.group?.id === groupId)?.group ?? null;
}

function getGroupOptions({ excludeGroupId = null } = {}) {
  const seenGroupIds = new Set();
  const groups = [];

  tabs.forEach((tab) => {
    if (!tab.group || seenGroupIds.has(tab.group.id) || tab.group.id === excludeGroupId) {
      return;
    }

    seenGroupIds.add(tab.group.id);
    groups.push({
      groupId: tab.group.id,
      label: tab.group.title || "Unnamed group",
      color: getGroupSwatchColor(tab.group)
    });
  });

  return groups;
}

async function loadStoredFocusedGroupId() {
  const stored = await getFocusStorageArea().get({ [FOCUSED_GROUPS_KEY]: {} });
  const groupId = Number(stored[FOCUSED_GROUPS_KEY]?.[String(windowId)]);
  return Number.isInteger(groupId) && groupId >= 0 ? groupId : null;
}

function getTabLabelKey(tab) {
  return tab?.url ? normalizeUrl(tab.url) : "";
}

async function loadStoredTabLabels() {
  const storageArea = getTabLabelStorageArea();
  const stored = await storageArea.get({ [TAB_LABELS_KEY]: {} });
  const labels = stored[TAB_LABELS_KEY]?.[String(windowId)] || {};
  const cleanLabels = Object.fromEntries(Object.entries(labels).filter(([key, label]) => key && typeof label === "string"));
  if (Object.keys(cleanLabels).length > 0 || !chrome.storage.session || storageArea === chrome.storage.session) {
    return cleanLabels;
  }

  const legacyStored = await chrome.storage.session.get({ [TAB_LABELS_KEY]: {} });
  const legacyLabels = legacyStored[TAB_LABELS_KEY]?.[String(windowId)] || {};
  const cleanLegacyLabels = Object.fromEntries(Object.entries(legacyLabels).filter(([key, label]) => key && typeof label === "string"));
  if (Object.keys(cleanLegacyLabels).length > 0) {
    await persistTabLabelsToStorage(cleanLegacyLabels);
  }

  return cleanLegacyLabels;
}

async function persistFocusedGroupId(groupId) {
  const storageArea = getFocusStorageArea();
  const stored = await storageArea.get({ [FOCUSED_GROUPS_KEY]: {} });
  const focusedGroupIdsByWindow = { ...(stored[FOCUSED_GROUPS_KEY] || {}) };

  if (typeof groupId === "number") {
    focusedGroupIdsByWindow[String(windowId)] = groupId;
  } else {
    delete focusedGroupIdsByWindow[String(windowId)];
  }

  await storageArea.set({ [FOCUSED_GROUPS_KEY]: focusedGroupIdsByWindow });
}

async function persistTabLabels() {
  await persistTabLabelsToStorage(tabLabelsByUrl);
}

async function persistTabLabelsToStorage(labelsByUrl) {
  const storageArea = getTabLabelStorageArea();
  const stored = await storageArea.get({ [TAB_LABELS_KEY]: {} });
  const tabLabelsByWindow = { ...(stored[TAB_LABELS_KEY] || {}) };

  if (Object.keys(labelsByUrl).length > 0) {
    tabLabelsByWindow[String(windowId)] = { ...labelsByUrl };
  } else {
    delete tabLabelsByWindow[String(windowId)];
  }

  await storageArea.set({ [TAB_LABELS_KEY]: tabLabelsByWindow });
}

function getGroupSwatchColor(group) {
  return groupColors[group?.color] ?? groupColors.grey;
}

function getGroupRecencyRanks(tabItems) {
  const tabsByGroupId = new Map();

  tabItems.forEach((tab) => {
    if (!tab.group) {
      return;
    }

    const groupTabs = tabsByGroupId.get(tab.group.id) ?? [];
    groupTabs.push(tab);
    tabsByGroupId.set(tab.group.id, groupTabs);
  });

  const ranksByTabId = new Map();
  tabsByGroupId.forEach((groupTabs) => {
    const newestTabs = [...groupTabs]
      .sort((left, right) => (right.lastAccessed || 0) - (left.lastAccessed || 0))
      .slice(0, 3);

    newestTabs.forEach((tab, rank) => {
      ranksByTabId.set(tab.id, 3 - rank);
    });
  });

  return ranksByTabId;
}

function applyRowState(scrollBlock = "nearest") {
  rows.forEach((row, index) => {
    row.setAttribute("aria-selected", String(index === selectedIndex));
  });

  rows[selectedIndex]?.scrollIntoView({ block: scrollBlock });
}

function selectRelative(offset) {
  if (rows.length === 0) {
    return;
  }

  selectedIndex = (selectedIndex + offset + rows.length) % rows.length;
  applyRowState();
}

function getSelectedTabId() {
  const tabId = Number(rows[selectedIndex]?.dataset.tabcoachTabId);
  return Number.isFinite(tabId) ? tabId : null;
}

function getSelectedGroupId() {
  const groupId = Number(rows[selectedIndex]?.dataset.tabcoachGroupId);
  return Number.isInteger(groupId) && groupId >= 0 ? groupId : null;
}

function getSelectedBookmarkTarget() {
  const row = rows[selectedIndex];
  if (row?.dataset.tabcoachRowType !== "bookmark") {
    return null;
  }

  const groupId = Number(row.dataset.tabcoachGroupId);
  const bookmarkId = row.dataset.tabcoachBookmarkId;
  const insertOffset = Number(row.dataset.tabcoachBookmarkIndex);
  if (!Number.isInteger(groupId) || groupId < 0 || !bookmarkId) {
    return null;
  }

  return {
    groupId,
    bookmarkId,
    insertOffset: Number.isInteger(insertOffset) && insertOffset >= 0 ? insertOffset : 0
  };
}

function getRowIndexForTabId(tabId) {
  const rowIndex = rows.findIndex((row) => Number(row.dataset.tabcoachTabId) === tabId);
  return rowIndex >= 0 ? rowIndex : 0;
}

function focusTabLabelInput(tabId) {
  requestAnimationFrame(() => {
    const input = list.querySelector(`[data-tabcoach-label-tab-id="${tabId}"]`);
    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    input.focus();
    input.select();
  });
}

function getRowIndexForGroupId(groupId) {
  const rowIndex = rows.findIndex((row) => Number(row.dataset.tabcoachGroupId) === groupId && !row.dataset.tabcoachTabId);
  return rowIndex >= 0 ? rowIndex : 0;
}

function getRowIndexForTabOrGroup(tabId) {
  const tab = visibleTabs.find((item) => item.id === tabId);
  if (tab?.group?.collapsed) {
    return getRowIndexForGroupId(tab.group.id);
  }

  return getRowIndexForTabId(tabId);
}

function getNumericShortcutSlot(event) {
  const match = event.code.match(/^Digit([0-9])$/);
  return match ? match[1] : null;
}

function closeAfterSwitchIfNeeded() {
  if (!keepOpenAfterSwitch) {
    window.close();
  }
}

function markActiveTab(tabId) {
  if (!keepOpenAfterSwitch || typeof tabId !== "number") {
    return;
  }

  tabs = tabs.map((tab) => ({ ...tab, active: tab.id === tabId }));
  refreshVisibleTabs();
  renderTabs();
  selectedIndex = getRowIndexForTabOrGroup(tabId);
  applyRowState();
}

function insertDuplicatedTab(sourceTabId, duplicatedTab) {
  if (!keepOpenAfterSwitch || !duplicatedTab?.id) {
    markActiveTab(duplicatedTab?.id);
    return;
  }

  const sourceIndex = tabs.findIndex((tab) => tab.id === sourceTabId);
  const sourceTab = sourceIndex >= 0 ? tabs[sourceIndex] : null;
  const optimisticTab = {
    ...sourceTab,
    ...duplicatedTab,
    active: true,
    displayTitle: duplicatedTab.title || sourceTab?.displayTitle || sourceTab?.title || duplicatedTab.url || "Untitled tab",
    bookmarked: Boolean(sourceTab?.bookmarked),
    label: tabLabelsByUrl[getTabLabelKey(duplicatedTab)] || tabLabelsByUrl[getTabLabelKey(sourceTab)] || "",
    group: sourceTab?.group ?? null
  };

  tabs = tabs.filter((tab) => tab.id !== optimisticTab.id).map((tab) => ({ ...tab, active: false }));
  if (sourceIndex >= 0) {
    tabs.splice(sourceIndex + 1, 0, optimisticTab);
  } else {
    tabs.unshift(optimisticTab);
  }

  refreshDuplicateCounts();
  refreshVisibleTabs();
  renderTabs();
  selectedIndex = getRowIndexForTabId(optimisticTab.id);
  applyRowState();
}

async function setGroupCollapsed(groupId, collapsed) {
  if (typeof groupId !== "number") {
    return;
  }

  const selectedTabId = getSelectedTabId();
  const response = await sendMessage({ type: SET_GROUP_COLLAPSED_MESSAGE, groupId, collapsed }).then((result) =>
    assertResponse(result, "Group update failed")
  );
  setTabs(response.tabs);
  refreshDuplicateCounts();
  refreshVisibleTabs();
  renderTabs();

  if (collapsed) {
    selectedIndex = getRowIndexForGroupId(groupId);
  } else {
    const firstGroupTab = visibleTabs.find((tab) => tab.group?.id === groupId);
    selectedIndex = getRowIndexForTabId(selectedTabId || firstGroupTab?.id);
  }

  applyRowState();
}

function focusGroup(groupId) {
  if (typeof groupId !== "number") {
    return;
  }

  const group = getGroupById(groupId);
  if (!group) {
    return;
  }

  focusedGroupId = groupId;
  void persistFocusedGroupId(groupId).catch(reportActionError);
  refreshVisibleTabs();
  renderTabs({ scrollBlock: "center" });
  selectedIndex = getRowIndexForGroupId(groupId);
  applyRowState("center");
}

function leaveFocusGroupMode() {
  const previousGroupId = focusedGroupId;
  focusedGroupId = null;
  void persistFocusedGroupId(null).catch(reportActionError);
  refreshVisibleTabs();
  renderTabs({ scrollBlock: "center" });
  selectedIndex = previousGroupId !== null ? getRowIndexForGroupId(previousGroupId) : 0;
  applyRowState("center");
}

function focusGroupRenameInput(groupId) {
  requestAnimationFrame(() => {
    const input = list.querySelector(`[data-tabcoach-rename-group-id="${groupId}"]`);
    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    input.focus();
    input.select();
  });
}

function startRenameGroup(groupId) {
  if (typeof groupId !== "number") {
    return;
  }

  closeContextMenu();
  renamingGroupId = groupId;
  renderTabs({ scrollBlock: "center" });
  selectedIndex = getRowIndexForGroupId(groupId);
  applyRowState("center");
  focusGroupRenameInput(groupId);
}

function cancelRenameGroup(groupId) {
  if (renamingGroupId !== groupId) {
    return;
  }

  renamingGroupId = null;
  renderTabs();
  selectedIndex = getRowIndexForGroupId(groupId);
  applyRowState();
}

async function renameGroup(groupId, nextTitle) {
  if (typeof groupId !== "number" || typeof nextTitle !== "string") {
    return;
  }

  const group = getGroupById(groupId);
  const currentTitle = group?.title || "";
  const trimmedTitle = nextTitle.trim();
  const selectedTabId = getSelectedTabId();
  renamingGroupId = null;

  if (trimmedTitle === currentTitle.trim()) {
    renderTabs();
    selectedIndex = getRowIndexForGroupId(groupId);
    applyRowState();
    return;
  }

  const response = await sendMessage({ type: RENAME_GROUP_MESSAGE, groupId, title: nextTitle }).then((result) =>
    assertResponse(result, "Group rename failed")
  );
  setTabs(response.tabs);
  refreshDuplicateCounts();
  refreshVisibleTabs();
  renderTabs();
  selectedIndex = getRowIndexForTabOrGroup(selectedTabId) || getRowIndexForGroupId(groupId);
  applyRowState();
}

async function closeGroup(groupId) {
  if (typeof groupId !== "number") {
    return;
  }

  const response = await sendMessage({ type: CLOSE_GROUP_MESSAGE, groupId }).then((result) =>
    assertResponse(result, "Group close failed")
  );
  setTabs(response.tabs);
  refreshDuplicateCounts();
  refreshVisibleTabs();
  renderTabs();
  selectedIndex = Math.min(selectedIndex, Math.max(rows.length - 1, 0));
  applyRowState();
}

async function openGroupBookmark(groupId, bookmarkId, insertOffset = 0) {
  const response = await sendMessage({ type: OPEN_GROUP_BOOKMARK_MESSAGE, groupId, bookmarkId, insertOffset }).then((result) =>
    assertResponse(result, "Open bookmark failed")
  );

  if (!keepOpenAfterSwitch) {
    window.close();
    return;
  }

  setTabs(response.tabs);
  refreshDuplicateCounts();
  refreshVisibleTabs();
  renderTabs();
  selectedIndex = getRowIndexForTabOrGroup(response.tab?.id);
  applyRowState();
}

async function createGroupForTab(tabId) {
  if (typeof tabId !== "number") {
    return;
  }

  const response = await sendMessage({ type: CREATE_GROUP_MESSAGE, tabId, title: "New group" }).then((result) =>
    assertResponse(result, "Group create failed")
  );
  setTabs(response.tabs);
  const createdTab = tabs.find((tab) => tab.id === tabId);
  const createdGroupId = createdTab?.group?.id;
  refreshDuplicateCounts();
  if (typeof createdGroupId === "number") {
    sortMode = "window";
    renamingGroupId = createdGroupId;
  }
  refreshVisibleTabs();
  renderTabs({ scrollBlock: "center" });
  selectedIndex = typeof createdGroupId === "number" ? getRowIndexForGroupId(createdGroupId) : getRowIndexForTabId(tabId);
  applyRowState("center");
  if (typeof createdGroupId === "number") {
    focusGroupRenameInput(createdGroupId);
  }
}

function getMoveTabGroupOptions(tab) {
  if (typeof tab?.id !== "number" || tab.pinned) {
    return [];
  }

  const options = [];
  const seenGroupIds = new Set();
  let hasUngroupOption = false;

  const addUngroupOption = () => {
    if (!tab.group || hasUngroupOption) {
      return;
    }

    options.push({ groupId: -1, label: "Ungroup", color: ungroupedColor });
    hasUngroupOption = true;
  };

  tabs.forEach((item) => {
    if (!item.group) {
      addUngroupOption();
      return;
    }

    if (item.group.id === tab.group?.id || seenGroupIds.has(item.group.id)) {
      return;
    }

    seenGroupIds.add(item.group.id);
    options.push({
      groupId: item.group.id,
      label: item.group.title || "Unnamed group",
      color: getGroupSwatchColor(item.group)
    });
  });

  if (tab.group && !hasUngroupOption) {
    options.unshift({ groupId: -1, label: "Ungroup", color: ungroupedColor });
  }

  return options;
}

async function moveTabToGroup(tab, groupId) {
  if (typeof tab?.id !== "number" || tab.pinned || typeof groupId !== "number") {
    return;
  }

  const selectedTabId = tab.id;
  const response = await sendMessage({ type: SET_TAB_GROUP_MESSAGE, tabId: tab.id, groupId }).then((result) =>
    assertResponse(result, "Tab group move failed")
  );
  setTabs(response.tabs);
  refreshDuplicateCounts();
  refreshVisibleTabs();
  renderTabs();
  selectedIndex = getRowIndexForTabOrGroup(selectedTabId);
  applyRowState();
}

function showShortcutNotification(message) {
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
  toast.textContent = message;
  shadow.append(style, toast);
  document.documentElement.appendChild(host);

  setTimeout(() => {
    host.remove();
  }, 1100);
}

async function switchToSelectedTab() {
  const bookmarkTarget = getSelectedBookmarkTarget();
  if (bookmarkTarget) {
    await openGroupBookmark(bookmarkTarget.groupId, bookmarkTarget.bookmarkId, bookmarkTarget.insertOffset);
    return;
  }

  const tabId = getSelectedTabId();
  if (tabId === null) {
    const groupId = getSelectedGroupId();
    if (groupId !== null) {
      await setGroupCollapsed(groupId, false);
    }
    return;
  }

  await sendMessage({ type: SWITCH_TAB_MESSAGE, tabId }).then((response) => assertResponse(response, "Tab switch failed"));
  markActiveTab(tabId);
  closeAfterSwitchIfNeeded();
}

async function createNewTab() {
  await sendMessage({ type: CREATE_TAB_MESSAGE }).then((response) => assertResponse(response, "New tab failed"));
  closeAfterSwitchIfNeeded();
}

async function duplicateTab(tabId) {
  const response = await sendMessage({ type: DUPLICATE_TAB_MESSAGE, tabId }).then((result) =>
    assertResponse(result, "Tab duplicate failed")
  );
  insertDuplicatedTab(tabId, response.tab);
  closeAfterSwitchIfNeeded();
}

async function assignNumericBookmark(slot) {
  const tabId = getSelectedTabId();
  const tab = tabs.find((item) => item.id === tabId);
  if (!tab?.url) {
    return;
  }

  numericBookmarks = {
    ...numericBookmarks,
    [slot]: {
      title: tab.displayTitle || tab.title || tab.url || "Untitled tab",
      url: tab.url,
      tabId: tab.id,
      windowId: tab.windowId,
      normalizedUrl: normalizeUrl(tab.url),
      assignedAt: new Date().toISOString()
    }
  };
  await chrome.storage.sync.set({ [NUMERIC_BOOKMARKS_KEY]: numericBookmarks });
  refreshNumericBookmarkSlots();
  renderTabs();
  selectedIndex = getRowIndexForTabId(tabId);
  applyRowState();
  showShortcutNotification(`Bookmark ${slot} saved`);
}

async function jumpToNumericBookmark(slot) {
  const bookmark = numericBookmarks[slot];
  await sendMessage({ type: JUMP_NUMERIC_BOOKMARK_MESSAGE, slot, bookmark }).then((response) =>
    assertResponse(response, `No numeric bookmark saved in slot ${slot}`)
  );
  closeAfterSwitchIfNeeded();
}

async function closeTab(tabId) {
  const closedIndex = visibleTabs.findIndex((tab) => tab.id === tabId);
  await sendMessage({ type: CLOSE_TAB_MESSAGE, tabId }).then((response) => assertResponse(response, "Tab close failed"));

  tabs = tabs.filter((tab) => tab.id !== tabId);
  refreshDuplicateCounts();
  refreshVisibleTabs();

  if (tabs.length === 0) {
    window.close();
    return;
  }

  renderTabs();
  selectedIndex = Math.min(closedIndex >= 0 ? closedIndex : selectedIndex, rows.length - 1);
  applyRowState();
}

async function closeDuplicateTabsForTab(tab) {
  const duplicateTabs = getDuplicateTabsForTab(tab);
  if (duplicateTabs.length === 0) {
    return;
  }

  await Promise.all(
    duplicateTabs.map((duplicateTab) =>
      sendMessage({ type: CLOSE_TAB_MESSAGE, tabId: duplicateTab.id }).then((response) =>
        assertResponse(response, "Duplicate tab close failed")
      )
    )
  );

  const closedTabIds = new Set(duplicateTabs.map((duplicateTab) => duplicateTab.id));
  tabs = tabs.filter((item) => !closedTabIds.has(item.id));
  refreshDuplicateCounts();
  refreshVisibleTabs();

  if (tabs.length === 0) {
    window.close();
    return;
  }

  renderTabs();
  selectedIndex = getRowIndexForTabOrGroup(tab.id);
  applyRowState();
  showShortcutNotification(`Closed ${duplicateTabs.length} duplicate${duplicateTabs.length === 1 ? "" : "s"}`);
}

async function toggleBookmark(tabId) {
  const tab = tabs.find((item) => item.id === tabId);
  if (!tab) {
    return;
  }

  const previousScrollTop = list.scrollTop;
  const response = await sendMessage({
    type: TOGGLE_BOOKMARK_MESSAGE,
    tabId,
    title: tab.displayTitle || tab.title || tab.url || "Untitled tab",
    url: tab.url,
    groupTitle: tab.group?.title || "Ungrouped"
  }).then((result) => assertResponse(result, "Bookmark toggle failed"));

  tabs = tabs.map((item) => (item.id === tabId ? { ...item, bookmarked: response.bookmarked } : item));
  refreshDuplicateCounts();
  refreshVisibleTabs();
  renderTabs();
  list.scrollTop = previousScrollTop;
}

async function addAppBookmark(tabId) {
  const tab = getTabById(tabId);
  if (!tab?.url) {
    return;
  }

  const response = await sendMessage({
    type: ADD_APP_BOOKMARK_MESSAGE,
    tabId,
    title: tab.displayTitle || tab.title || tab.url || "Untitled tab",
    url: tab.url
  }).then((result) => assertResponse(result, "App bookmark add failed"));

  if (Array.isArray(response.bookmarks)) {
    renderAppBookmarks(response.bookmarks);
  } else {
    await loadAppBookmarks();
  }

  showShortcutNotification(response.added ? "Added app bookmark" : "App bookmark updated");
}

function startEditTabLabel(tabId) {
  const tab = getTabById(tabId);
  if (!tab) {
    return;
  }

  closeContextMenu();
  editingLabelTabId = tabId;
  editingLabelDraft = tab.label || "";
  renderTabs({ scrollBlock: "center" });
  selectedIndex = getRowIndexForTabId(tabId);
  applyRowState("center");
  focusTabLabelInput(tabId);
}

function cancelEditTabLabel(tabId) {
  if (editingLabelTabId !== tabId) {
    return;
  }

  editingLabelTabId = null;
  editingLabelDraft = "";
  renderTabs();
  selectedIndex = getRowIndexForTabId(tabId);
  applyRowState();
}

async function editTabLabel(tab, nextLabel = editingLabelDraft) {
  if (typeof tab?.id !== "number") {
    return;
  }

  const normalizedLabel = nextLabel.trim();
  const labelKey = getTabLabelKey(tab);
  if (!labelKey) {
    return;
  }

  if (normalizedLabel) {
    tabLabelsByUrl[labelKey] = normalizedLabel;
  } else {
    delete tabLabelsByUrl[labelKey];
  }

  editingLabelTabId = null;
  editingLabelDraft = "";
  await persistTabLabels();
  tabs = applyTabLabels(tabs);
  refreshVisibleTabs();
  renderTabs();
  selectedIndex = getRowIndexForTabId(tab.id);
  applyRowState();
}

async function clearTabLabel(tab) {
  if (typeof tab?.id !== "number") {
    return;
  }

  const labelKey = getTabLabelKey(tab);
  if (!labelKey) {
    return;
  }

  editingLabelTabId = null;
  editingLabelDraft = "";
  delete tabLabelsByUrl[labelKey];
  await persistTabLabels();
  tabs = applyTabLabels(tabs);
  refreshVisibleTabs();
  renderTabs();
  selectedIndex = getRowIndexForTabId(tab.id);
  applyRowState();
}

async function copyTabUrl(tabId) {
  const tab = tabs.find((item) => item.id === tabId);
  if (!tab?.url) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(tab.url);
    return true;
  } catch {
    const response = await sendMessage({ type: COPY_TAB_URL_MESSAGE, tabId, url: tab.url });
    return Boolean(response?.ok);
  }
}

function logCopyTabUrl(tab, copied) {
  void sendMessage({
    type: LOG_TAB_EVENT_MESSAGE,
    eventType: "copy-tab-url",
    occurredAt: new Date().toISOString(),
    source: "chrome-extension:tab-switcher",
    ok: copied,
    tab
  }).catch((error) => {
    console.warn("Tabcoach tab event log failed", error);
  });
}

function setDesktopAppStatus(message, tone = "muted") {
  let status = desktopApps.querySelector(".desktop-app-status");
  if (!message) {
    status?.remove();
    return;
  }

  if (!status) {
    status = document.createElement("div");
    status.className = "desktop-app-status";
    status.setAttribute("role", "status");
    desktopApps.appendChild(status);
  }

  status.dataset.tone = tone;
  status.textContent = message;
}

function getSafeDesktopApps(apps) {
  return Array.isArray(apps)
    ? apps
        .filter((app) => typeof app?.id === "string" && app.id.length > 0 && typeof app?.label === "string" && app.label.length > 0)
        .map((app) => ({ id: app.id, label: app.label }))
    : [];
}

function getSafeWorkspaceLaunchGroups(groups) {
  return Array.isArray(groups)
    ? groups
        .filter(
          (group) =>
            typeof group?.id === "string" &&
            group.id.length > 0 &&
            typeof group?.label === "string" &&
            group.label.length > 0 &&
            Array.isArray(group.urls) &&
            group.urls.length > 0
        )
        .map((group) => ({
          id: group.id,
          label: group.label,
          urlCount: Array.isArray(group.urls) ? group.urls.length : 0
        }))
    : [];
}

function getSafeAppBookmarks(bookmarks) {
  return Array.isArray(bookmarks)
    ? bookmarks
        .filter(
          (bookmark) =>
            typeof bookmark?.id === "string" &&
            bookmark.id.length > 0 &&
            typeof bookmark?.label === "string" &&
            bookmark.label.length > 0 &&
            typeof bookmark?.url === "string" &&
            bookmark.url.length > 0
        )
        .map((bookmark) => ({ id: bookmark.id, label: bookmark.label, url: bookmark.url }))
    : [];
}

function getHostnameForIcon(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function getFaviconUrl(rawUrl) {
  return `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(rawUrl)}&sz=64`;
}

async function launchDesktopApp(app, button) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "...";
  setDesktopAppStatus("");

  try {
    await sendMessage({ type: LAUNCH_DESKTOP_APP_MESSAGE, appId: app.id }).then((response) =>
      assertResponse(response, `Could not open ${app.label}`)
    );
    button.textContent = "✓";
    setTimeout(() => {
      button.disabled = false;
      button.textContent = originalText;
    }, 700);
  } catch (error) {
    button.disabled = false;
    button.textContent = originalText;
    console.error("Tabcoach desktop app launch failed", error);
    setDesktopAppStatus(error instanceof Error ? error.message : String(error), "error");
  }
}

async function launchWorkspaceLaunchGroup(group, button) {
  const originalText = button.textContent;
  const usesRichButton = button.classList.contains("app-launcher-item");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  if (!usesRichButton) {
    button.textContent = "...";
  }
  setDesktopAppStatus("");

  try {
    const response = await sendMessage({ type: LAUNCH_WORKSPACE_LAUNCH_GROUP_MESSAGE, groupId: group.id }).then((result) =>
      assertResponse(result, `Could not open ${group.label}`)
    );
    if (Array.isArray(response.tabs)) {
      setTabs(response.tabs);
      refreshDuplicateCounts();
      refreshVisibleTabs();
      renderTabs();
      selectedIndex = 0;
      applyRowState();
    }

    if (!usesRichButton) {
      button.textContent = "✓";
    }
    setTimeout(() => {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      if (!usesRichButton) {
        button.textContent = originalText;
      }
    }, 700);

    if ((Number(response.openedTabCount) || Number(response.existingTabCount) || 0) > 0) {
      closeAfterSwitchIfNeeded();
    }
  } catch (error) {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    if (!usesRichButton) {
      button.textContent = originalText;
    }
    console.error("Tabcoach workspace launch failed", error);
    setDesktopAppStatus(error instanceof Error ? error.message : String(error), "error");
  }
}

async function openAppBookmark(bookmark, button) {
  const groupId = getSelectedGroupId();
  const originalText = button.textContent;
  const usesRichButton = button.classList.contains("app-launcher-item");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  if (!usesRichButton) {
    button.textContent = "...";
  }
  setDesktopAppStatus("");

  try {
    const response = await sendMessage({ type: OPEN_APP_BOOKMARK_MESSAGE, bookmarkId: bookmark.id, groupId }).then((result) =>
      assertResponse(result, `Could not open ${bookmark.label}`)
    );
    if (Array.isArray(response.tabs)) {
      setTabs(response.tabs);
      refreshDuplicateCounts();
      refreshVisibleTabs();
      renderTabs();
      selectedIndex = getRowIndexForTabId(response.tab?.id) || getRowIndexForGroupId(groupId);
      applyRowState();
    }

    if (!usesRichButton) {
      button.textContent = "✓";
    }
    setTimeout(() => {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      if (!usesRichButton) {
        button.textContent = originalText;
      }
    }, 700);
    closeAfterSwitchIfNeeded();
  } catch (error) {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    if (!usesRichButton) {
      button.textContent = originalText;
    }
    console.error("Tabcoach app bookmark open failed", error);
    setDesktopAppStatus(error instanceof Error ? error.message : String(error), "error");
  }
}

function renderLaunchers() {
  desktopApps.replaceChildren();
  document.querySelector(".app-launcher-panel")?.remove();
  const safeAppBookmarks = getSafeAppBookmarks(appBookmarks);
  const safeWorkspaces = getSafeWorkspaceLaunchGroups(workspaceLaunchGroups);
  const safeApps = getSafeDesktopApps(desktopAppItems);

  if (safeAppBookmarks.length === 0 && safeWorkspaces.length === 0 && safeApps.length === 0) {
    desktopApps.hidden = true;
    return;
  }

  desktopApps.hidden = false;
  const hasRareLaunchers = safeAppBookmarks.length > 0 || safeWorkspaces.length > 0;

  if (hasRareLaunchers) {
    const toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = "launcher-toggle";
    toggleButton.textContent = "Apps";
    toggleButton.title = launchersExpanded ? "Hide app launcher" : "Show app launcher";
    toggleButton.setAttribute("aria-label", toggleButton.title);
    toggleButton.setAttribute("aria-expanded", String(launchersExpanded));
    toggleButton.addEventListener("click", () => {
      launchersExpanded = !launchersExpanded;
      renderLaunchers();
    });
    desktopApps.appendChild(toggleButton);
  }

  if (hasRareLaunchers && launchersExpanded) {
    const panel = document.createElement("section");
    panel.className = "app-launcher-panel";
    panel.setAttribute("aria-label", "App launcher");

    const panelHeader = document.createElement("div");
    panelHeader.className = "app-launcher-header";
    const title = document.createElement("div");
    title.className = "app-launcher-title";
    title.textContent = "Apps";
    panelHeader.appendChild(title);
    panel.appendChild(panelHeader);

    if (safeAppBookmarks.length > 0) {
      const bookmarkGrid = document.createElement("div");
      bookmarkGrid.className = "app-launcher-grid";

      safeAppBookmarks.forEach((bookmark) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "app-launcher-item";
        button.title = `Open ${bookmark.label} in selected group`;
        button.setAttribute("aria-label", `Open ${bookmark.label} in selected group`);
        const icon = document.createElement("span");
        icon.className = "app-launcher-icon";
        const favicon = document.createElement("img");
        favicon.alt = "";
        favicon.src = getFaviconUrl(bookmark.url);
        favicon.addEventListener("error", () => {
          favicon.remove();
          icon.textContent = bookmark.label.slice(0, 1).toUpperCase();
        });
        icon.appendChild(favicon);
        const label = document.createElement("span");
        label.className = "app-launcher-label";
        label.textContent = bookmark.label;
        const meta = document.createElement("span");
        meta.className = "app-launcher-meta";
        meta.textContent = getHostnameForIcon(bookmark.url);
        button.append(icon, label, meta);
        button.addEventListener("click", () => {
          void openAppBookmark(bookmark, button);
        });
        bookmarkGrid.appendChild(button);
      });

      panel.appendChild(bookmarkGrid);
    }

    if (safeWorkspaces.length > 0) {
      const workspaceTitle = document.createElement("div");
      workspaceTitle.className = "app-launcher-section-title";
      workspaceTitle.textContent = "Workspaces";
      const workspaceGrid = document.createElement("div");
      workspaceGrid.className = "app-launcher-grid";

      safeWorkspaces.forEach((group) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "app-launcher-item app-launcher-workspace";
        button.title = `Open ${group.label}`;
        button.setAttribute("aria-label", `Open ${group.label}`);
        const icon = document.createElement("span");
        icon.className = "app-launcher-icon";
        icon.textContent = group.label.slice(0, 1).toUpperCase();
        const label = document.createElement("span");
        label.className = "app-launcher-label";
        label.textContent = group.label;
        const meta = document.createElement("span");
        meta.className = "app-launcher-meta";
        meta.textContent = `${group.urlCount} URL${group.urlCount === 1 ? "" : "s"}`;
        button.append(icon, label, meta);
        button.addEventListener("click", () => {
          void launchWorkspaceLaunchGroup(group, button);
        });
        workspaceGrid.appendChild(button);
      });

      panel.append(workspaceTitle, workspaceGrid);
    }

    shell?.insertBefore(panel, desktopApps);
  }

  if (safeApps.length > 0) {
    const appButtons = document.createElement("div");
    appButtons.className = "desktop-app-buttons";

    safeApps.forEach((app) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "desktop-app-button";
      button.textContent = app.label;
      button.title = `Open ${app.label}`;
      button.setAttribute("aria-label", `Open ${app.label}`);
      button.addEventListener("click", () => {
        void launchDesktopApp(app, button);
      });
      appButtons.appendChild(button);
    });

    desktopApps.appendChild(appButtons);
  }
}

function renderDesktopApps(apps) {
  desktopAppItems = apps;
  renderLaunchers();
}

function renderWorkspaceLaunchGroups(groups) {
  workspaceLaunchGroups = groups;
  renderLaunchers();
}

function renderAppBookmarks(bookmarks) {
  appBookmarks = bookmarks;
  renderLaunchers();
}

async function loadDesktopApps() {
  renderDesktopApps(FALLBACK_DESKTOP_APPS);

  try {
    const response = await sendMessage({ type: GET_DESKTOP_APPS_MESSAGE }).then((result) =>
      assertResponse(result, "Could not load desktop apps")
    );
    renderDesktopApps(response.apps);
  } catch (error) {
    console.warn("Tabcoach desktop app list failed", error);
    setDesktopAppStatus(error instanceof Error ? error.message : String(error), "error");
  }
}

async function loadWorkspaceLaunchGroups() {
  renderWorkspaceLaunchGroups([]);

  try {
    const response = await sendMessage({ type: GET_WORKSPACE_LAUNCH_GROUPS_MESSAGE }).then((result) =>
      assertResponse(result, "Could not load workspaces")
    );
    renderWorkspaceLaunchGroups(response.groups);
  } catch (error) {
    console.warn("Tabcoach workspace list failed", error);
    setDesktopAppStatus(error instanceof Error ? error.message : String(error), "error");
  }
}

async function loadAppBookmarks() {
  renderAppBookmarks([]);

  try {
    const response = await sendMessage({ type: GET_APP_BOOKMARKS_MESSAGE }).then((result) =>
      assertResponse(result, "Could not load app bookmarks")
    );
    renderAppBookmarks(response.bookmarks);
  } catch (error) {
    console.warn("Tabcoach app bookmark list failed", error);
    setDesktopAppStatus(error instanceof Error ? error.message : String(error), "error");
  }
}

function clearDropTarget() {
  dropTarget = null;
  tabRows.forEach((row) => {
    row.classList.remove("drop-before", "drop-after");
  });
}

function updateDropTarget(row, position) {
  const tabId = Number(row.dataset.tabcoachTabId);
  if (!Number.isFinite(tabId)) {
    return;
  }

  clearDropTarget();
  dropTarget = {
    tabId,
    groupId: Number(row.dataset.tabcoachGroupId),
    position
  };
  row.classList.add(position === "before" ? "drop-before" : "drop-after");
}

async function moveDraggedTab() {
  if (sortMode !== "window" || draggedTabId === null || dropTarget === null || draggedTabId === dropTarget.tabId) {
    clearDropTarget();
    return;
  }

  const orderedIds = tabs.map((tab) => tab.id).filter((tabId) => tabId !== draggedTabId);
  const targetIndex = orderedIds.indexOf(dropTarget.tabId);
  if (targetIndex < 0) {
    clearDropTarget();
    return;
  }

  orderedIds.splice(dropTarget.position === "before" ? targetIndex : targetIndex + 1, 0, draggedTabId);
  const moveToIndex = orderedIds.indexOf(draggedTabId);
  const targetGroupId = Number.isInteger(dropTarget.groupId) ? dropTarget.groupId : -1;
  const selectedTabId = getSelectedTabId();

  clearDropTarget();
  try {
    const response = await sendMessage({
      type: MOVE_TAB_MESSAGE,
      tabId: draggedTabId,
      index: moveToIndex,
      groupId: targetGroupId
    }).then((result) => assertResponse(result, "Tab move failed"));

    setTabs(response.tabs);
    refreshDuplicateCounts();
    refreshVisibleTabs();
    renderTabs();
    selectedIndex = getRowIndexForTabOrGroup(selectedTabId) || getRowIndexForTabOrGroup(draggedTabId);
    applyRowState();
  } finally {
    draggedTabId = null;
  }
}

function createButton(className, text, label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-button ${className}`;
  button.textContent = text;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    Promise.resolve(onClick(button)).catch(reportActionError);
  });
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener("dragstart", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  return button;
}

function canMoveTabToGroup(tab) {
  if (!tab || tab.pinned) {
    return false;
  }

  return getMoveTabGroupOptions(tab).length > 0;
}

function closeContextMenu() {
  contextMenu?.remove();
  contextMenu = null;
}

function focusContextMenuItem(offset) {
  if (!contextMenu) {
    return;
  }

  const items = [...contextMenu.querySelectorAll(".context-menu-item:not(:disabled)")].filter(
    (item) => item.getClientRects().length > 0
  );
  if (items.length === 0) {
    return;
  }

  const currentIndex = items.indexOf(document.activeElement);
  const nextIndex = currentIndex >= 0 ? (currentIndex + offset + items.length) % items.length : 0;
  items[nextIndex].focus();
}

function createContextMenuSeparator() {
  const separator = document.createElement("div");
  separator.className = "context-menu-separator";
  separator.setAttribute("role", "separator");
  return separator;
}

function createContextMenuItem(label, onClick, { disabled = false, tone = "", swatchColor = "" } = {}) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "context-menu-item";
  item.setAttribute("role", "menuitem");
  item.disabled = disabled;
  if (swatchColor) {
    const swatch = document.createElement("span");
    swatch.className = "context-menu-swatch";
    swatch.style.background = swatchColor;

    const text = document.createElement("span");
    text.className = "context-menu-label";
    text.textContent = label;

    item.append(swatch, text);
  } else {
    item.textContent = label;
  }
  if (tone) {
    item.dataset.tone = tone;
  }
  item.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (item.disabled) {
      return;
    }

    closeContextMenu();
    Promise.resolve(onClick()).catch(reportActionError);
  });
  return item;
}

function focusFirstSubmenuItem(submenu) {
  submenu?.querySelector(".context-menu-item:not(:disabled)")?.focus();
}

function createContextSubmenuItem(label, submenuItems, { disabled = false, panelClassName = "" } = {}) {
  const host = document.createElement("div");
  host.className = "context-menu-submenu";

  const item = document.createElement("button");
  item.type = "button";
  item.className = "context-menu-item";
  item.setAttribute("role", "menuitem");
  item.setAttribute("aria-haspopup", "menu");
  item.setAttribute("aria-expanded", "false");
  item.dataset.hasSubmenu = "true";
  item.disabled = disabled || submenuItems.length === 0;
  item.textContent = label;

  const submenu = document.createElement("div");
  submenu.className = `context-menu context-menu-submenu-panel${panelClassName ? ` ${panelClassName}` : ""}`;
  submenu.setAttribute("role", "menu");
  submenu.setAttribute("aria-label", label);
  submenu.append(...submenuItems);

  const openSubmenu = () => {
    if (item.disabled) {
      return;
    }

    host.parentElement?.querySelectorAll(".context-menu-submenu[data-open='true']").forEach((openHost) => {
      if (openHost === host) {
        return;
      }

      openHost.dataset.open = "false";
      openHost.querySelector(".context-menu-item[data-has-submenu]")?.setAttribute("aria-expanded", "false");
    });
    host.dataset.open = "true";
    item.setAttribute("aria-expanded", "true");
  };
  const closeSubmenu = () => {
    host.dataset.open = "false";
    item.setAttribute("aria-expanded", "false");
  };

  host.addEventListener("pointerenter", openSubmenu);
  item.addEventListener("focus", openSubmenu);
  host.addEventListener("focusout", (event) => {
    if (!(event.relatedTarget instanceof Node) || !host.contains(event.relatedTarget)) {
      closeSubmenu();
    }
  });
  item.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (item.disabled) {
      return;
    }

    openSubmenu();
    focusFirstSubmenuItem(submenu);
  });

  host.append(item, submenu);
  return host;
}

function positionContextMenu(menu, clientX, clientY) {
  menu.style.left = "0";
  menu.style.top = "0";
  document.body.appendChild(menu);

  const margin = 8;
  const rect = menu.getBoundingClientRect();
  const left = Math.max(margin, Math.min(clientX, window.innerWidth - rect.width - margin));
  const top = Math.max(margin, Math.min(clientY, window.innerHeight - rect.height - margin));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function alignContextMenuSubmenus(menu) {
  const margin = 8;
  const gap = 6;
  const maxPanelHeight = Math.max(80, Math.min(320, window.innerHeight - margin * 2));

  menu.querySelectorAll(".context-menu-submenu").forEach((host) => {
    const panel = host.querySelector(".context-menu-submenu-panel");
    if (!panel) {
      return;
    }

    delete host.dataset.align;
    panel.style.top = "-6px";
    panel.style.maxHeight = `${maxPanelHeight}px`;
    panel.style.display = "block";
    panel.style.visibility = "hidden";

    const hostRect = host.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const fitsRight = hostRect.right + gap + panelRect.width <= window.innerWidth - margin;
    const fitsLeft = hostRect.left - gap - panelRect.width >= margin;
    if (!fitsRight && fitsLeft) {
      host.dataset.align = "left";
    }

    const bottomOverflow = panelRect.bottom - (window.innerHeight - margin);
    if (bottomOverflow > 0) {
      const topShift = Math.min(bottomOverflow, hostRect.top - margin);
      panel.style.top = `${-6 - topShift}px`;
    }

    panel.style.visibility = "";
    panel.style.display = "";
  });
}

function openTabContextMenu(tab, rowIndex, clientX, clientY) {
  closeContextMenu();
  selectedIndex = rowIndex;
  pointerDownRowIndex = null;
  suppressNextRowClick = false;
  applyRowState();

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `Actions for ${getTabActionLabel(tab)}`);

  const canGroupTab = Boolean(tab && !tab.pinned);
  const canMoveTab = canMoveTabToGroup(tab);
  const duplicateTabs = getDuplicateTabsForTab(tab);
  const moveGroupOptions = getMoveTabGroupOptions(tab);
  const menuItems = [
    createContextMenuItem("Switch to tab", () => switchToSelectedTab()),
    createContextMenuItem("Duplicate tab", () => duplicateTab(tab.id)),
    createContextMenuItem(tab.label ? "Edit label" : "Set label", () => startEditTabLabel(tab.id)),
    ...(tab.label ? [createContextMenuItem("Clear label", () => clearTabLabel(tab))] : []),
    createContextMenuItem("Copy URL", async () => {
      const currentTab = getTabById(tab.id) ?? tab;
      const copied = await copyTabUrl(tab.id);
      logCopyTabUrl(currentTab, copied);
      showShortcutNotification(copied ? "Copied URL" : "Copy failed");
    }),
    createContextMenuItem(tab.bookmarked ? "Remove bookmark" : "Bookmark tab", () => toggleBookmark(tab.id)),
    createContextMenuItem("Add to app bookmarks", () => addAppBookmark(tab.id), {
      disabled: !tab.url || tab.url.startsWith("chrome://")
    }),
    createContextMenuSeparator(),
    createContextMenuItem("Create new group", () => createGroupForTab(tab.id), {
      disabled: !canGroupTab
    }),
    createContextSubmenuItem(
      "Move to group",
      moveGroupOptions.map((option) =>
        createContextMenuItem(option.label, () => moveTabToGroup(tab, option.groupId), { swatchColor: option.color })
      ),
      {
        disabled: !canMoveTab,
        panelClassName: "context-menu-submenu-panel-wide"
      }
    ),
    createContextMenuSeparator(),
    ...(duplicateTabs.length > 0
      ? [
          createContextMenuItem(
            `Close duplicate${duplicateTabs.length === 1 ? "" : "s"} (${duplicateTabs.length})`,
            () => closeDuplicateTabsForTab(tab),
            { tone: "danger" }
          )
        ]
      : []),
    createContextMenuItem("Close tab", () => closeTab(tab.id), { tone: "danger" })
  ];
  menu.append(...menuItems);

  contextMenu = menu;
  positionContextMenu(menu, clientX, clientY);
  alignContextMenuSubmenus(menu);
  menu.querySelector(".context-menu-item:not(:disabled)")?.focus();
}

function openGroupContextMenu(group, rowIndex, clientX, clientY) {
  if (!group) {
    return;
  }

  closeContextMenu();
  selectedIndex = rowIndex;
  pointerDownRowIndex = null;
  suppressNextRowClick = false;
  applyRowState();

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `Actions for ${group.title || "Unnamed group"}`);

  const switchGroupOptions = getGroupOptions({ excludeGroupId: group.id });
  const menuItems = [
    createContextMenuItem(focusedGroupId === group.id ? "Refocus group" : "Focus group", () => focusGroup(group.id)),
    createContextSubmenuItem(
      focusedGroupId === null ? "Focus another group" : "Switch focus group",
      switchGroupOptions.map((option) =>
        createContextMenuItem(option.label, () => focusGroup(option.groupId), { swatchColor: option.color })
      ),
      { disabled: switchGroupOptions.length === 0, panelClassName: "context-menu-submenu-panel-wide" }
    ),
    createContextMenuItem("Leave focus mode", leaveFocusGroupMode, { disabled: focusedGroupId === null }),
    createContextMenuSeparator(),
    createContextMenuItem(group.collapsed ? "Expand group" : "Collapse group", () => setGroupCollapsed(group.id, !group.collapsed)),
    createContextMenuItem("Rename group", () => startRenameGroup(group.id)),
    createContextMenuSeparator(),
    createContextMenuItem("Close group", () => closeGroup(group.id), { tone: "danger" })
  ];
  menu.append(...menuItems);

  contextMenu = menu;
  positionContextMenu(menu, clientX, clientY);
  alignContextMenuSubmenus(menu);
  menu.querySelector(".context-menu-item:not(:disabled)")?.focus();
}

function renderBookmarkRow(bookmark, group) {
  const row = document.createElement("div");
  row.className = "row bookmark-row";
  row.setAttribute("role", "option");
  row.tabIndex = -1;
  row.dataset.tabcoachRowType = "bookmark";
  row.dataset.tabcoachBookmarkId = String(bookmark.id ?? "");
  row.dataset.tabcoachBookmarkIndex = String(bookmark.index ?? 0);
  row.dataset.tabcoachGroupId = String(group.id);
  row.dataset.active = "false";
  row.title = "Open saved bookmark";

  const rowIndex = rows.length;
  row.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }

    selectedIndex = rowIndex;
    pointerDownRowIndex = rowIndex;
    applyRowState();
  });
  row.addEventListener("click", () => {
    pointerDownRowIndex = null;
    selectedIndex = rowIndex;
    void openGroupBookmark(group.id, bookmark.id, bookmark.index ?? 0).catch(reportActionError);
  });

  const icon = document.createElement("div");
  icon.className = "favicon bookmark-favicon";
  icon.textContent = "★";

  const text = document.createElement("div");
  text.className = "tab-text";

  const tabTitle = document.createElement("div");
  tabTitle.className = "tab-title";
  const tabTitleLabel = document.createElement("span");
  tabTitleLabel.className = "tab-title-label";
  tabTitleLabel.textContent = bookmark.title || bookmark.url || "Untitled bookmark";
  tabTitle.appendChild(tabTitleLabel);

  const tabUrl = document.createElement("div");
  tabUrl.className = "tab-url";
  tabUrl.textContent = formatUrl(bookmark.url);

  const status = document.createElement("div");
  status.className = "status bookmark-status";
  status.textContent = "Saved";

  text.append(tabTitle, tabUrl);
  row.append(icon, text, status);
  rows.push(row);
  list.appendChild(row);
}

function renderGroupBookmarkRows(group) {
  const bookmarks = Array.isArray(group.closedBookmarks) ? group.closedBookmarks : [];
  bookmarks.forEach((bookmark) => {
    renderBookmarkRow(bookmark, group);
  });
}

async function toggleGroupBookmarkRows(group) {
  if (!group?.id) {
    return;
  }

  const bookmarks = Array.isArray(group.closedBookmarks) ? group.closedBookmarks : [];
  if (bookmarks.length === 0) {
    showShortcutNotification("No unopened bookmarks");
    return;
  }

  const selectedGroupId = group.id;
  if (expandedBookmarkGroupIds.has(selectedGroupId)) {
    expandedBookmarkGroupIds.delete(selectedGroupId);
  } else {
    expandedBookmarkGroupIds.add(selectedGroupId);
    if (group.collapsed) {
      await setGroupCollapsed(selectedGroupId, false);
      return;
    }
  }

  renderTabs();
  selectedIndex = getRowIndexForGroupId(selectedGroupId);
  applyRowState();
}

function renderTabs({ scrollBlock = "nearest" } = {}) {
  closeContextMenu();
  rows = [];
  tabRows = [];
  isReplacingListChildren = true;
  try {
    list.replaceChildren();
  } finally {
    isReplacingListChildren = false;
  }
  updateSortButtons();

  if (visibleTabs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = tabs.length === 0 ? "No tabs" : "No matching tabs";
    list.appendChild(empty);
    applyRowState(scrollBlock);
    return;
  }

  const showGroupSections = (sortMode === "window" || focusedGroupId !== null) && visibleTabs.some((tab) => tab.group);
  const tabCountsBySectionKey = new Map();
  const recencyRanksByTabId = showGroupSections ? getGroupRecencyRanks(visibleTabs) : new Map();
  if (showGroupSections) {
    visibleTabs.forEach((tab) => {
      const sectionKey = tab.group ? `group:${tab.group.id}` : "ungrouped";
      tabCountsBySectionKey.set(sectionKey, (tabCountsBySectionKey.get(sectionKey) ?? 0) + 1);
    });
  }
  let lastSectionKey = null;

  visibleTabs.forEach((tab, index) => {
    const sectionKey = showGroupSections ? (tab.group ? `group:${tab.group.id}` : "ungrouped") : null;
    if (showGroupSections) {
      if (sectionKey !== lastSectionKey) {
        const sectionHeader = document.createElement("div");
        sectionHeader.className = "section-header";

        const swatch = document.createElement("span");
        swatch.className = "swatch";
        swatch.style.background = tab.group ? getGroupSwatchColor(tab.group) : ungroupedColor;

        const isCollapsedInSwitcher = Boolean(tab.group?.collapsed && focusedGroupId !== tab.group.id);
        const sectionTitleText = tab.group
          ? `${tab.group.title || "Unnamed group"}${isCollapsedInSwitcher ? ` (${tabCountsBySectionKey.get(sectionKey) ?? 0} collapsed)` : ""}`
          : "Ungrouped";
        let sectionTitle = null;

        if (tab.group && renamingGroupId === tab.group.id) {
          sectionTitle = document.createElement("input");
          sectionTitle.className = "section-rename-input";
          sectionTitle.type = "text";
          sectionTitle.value = tab.group.title || "";
          sectionTitle.placeholder = "Unnamed group";
          sectionTitle.dataset.tabcoachRenameGroupId = String(tab.group.id);
          sectionTitle.setAttribute("aria-label", `Rename ${tab.group.title || "Unnamed group"}`);

          let renameHandled = false;
          const finishRename = (save) => {
            if (renameHandled) {
              return;
            }

            renameHandled = true;
            if (save) {
              void renameGroup(tab.group.id, sectionTitle.value).catch(reportActionError);
            } else {
              cancelRenameGroup(tab.group.id);
            }
          };

          sectionTitle.addEventListener("pointerdown", (event) => {
            event.stopPropagation();
          });
          sectionTitle.addEventListener("click", (event) => {
            event.stopPropagation();
          });
          sectionTitle.addEventListener("keydown", (event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              finishRename(true);
              return;
            }

            if (event.key === "Escape") {
              event.preventDefault();
              finishRename(false);
            }
          });
          sectionTitle.addEventListener("blur", () => {
            if (isReplacingListChildren) {
              return;
            }

            finishRename(true);
          });
        } else {
          sectionTitle = document.createElement("span");
          sectionTitle.className = "section-title";
          sectionTitle.textContent = sectionTitleText;
        }

        sectionHeader.append(swatch, sectionTitle);
        if (tab.group) {
          const bookmarkRowsButton = createButton(
            "group-bookmarks",
            "☆…",
            `Toggle unopened bookmarks for ${tab.group.title || "Unnamed group"}`,
            () => toggleGroupBookmarkRows(tab.group)
          );
          bookmarkRowsButton.setAttribute("aria-pressed", String(expandedBookmarkGroupIds.has(tab.group.id)));
          const renameButton = createButton(
            "group-rename",
            "✎",
            `Rename ${tab.group.title || "Unnamed group"}`,
            () => startRenameGroup(tab.group.id)
          );
          const menuButton = createButton(
            "group-menu",
            "⋯",
            `Open menu for ${tab.group.title || "Unnamed group"}`,
            (button) => {
              const rect = button.getBoundingClientRect();
              openGroupContextMenu(tab.group, rows.indexOf(sectionHeader), rect.left, rect.bottom + 4);
            }
          );
          sectionHeader.append(bookmarkRowsButton, renameButton, menuButton);
          sectionHeader.classList.add("section-header-clickable");
          sectionHeader.classList.toggle("section-header-focused", focusedGroupId === tab.group.id);
          if (isCollapsedInSwitcher) {
            sectionHeader.classList.add("section-header-collapsed");
          }
          sectionHeader.setAttribute("role", "option");
          sectionHeader.tabIndex = -1;
          sectionHeader.dataset.tabcoachGroupId = String(tab.group.id);
          const rowIndex = rows.length;
          sectionHeader.addEventListener("pointerdown", (event) => {
            if (event.button !== 0 || (event.target instanceof HTMLElement && event.target.closest("button"))) {
              return;
            }

            selectedIndex = rowIndex;
            suppressNextRowClick = true;
            void setGroupCollapsed(tab.group.id, !tab.group.collapsed).catch(reportActionError);
          });
          sectionHeader.addEventListener("click", (event) => {
            if (event.target instanceof HTMLElement && event.target.closest("button")) {
              return;
            }

            if (suppressNextRowClick) {
              suppressNextRowClick = false;
              return;
            }

            selectedIndex = rowIndex;
            void setGroupCollapsed(tab.group.id, !tab.group.collapsed).catch(reportActionError);
          });
          sectionHeader.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            event.stopPropagation();
            openGroupContextMenu(tab.group, rowIndex, event.clientX, event.clientY);
          });
          rows.push(sectionHeader);
        }
        list.appendChild(sectionHeader);
        lastSectionKey = sectionKey;
      }

      if (tab.group?.collapsed && focusedGroupId !== tab.group.id) {
        return;
      }
    }

    const row = document.createElement("div");
    row.className = "row";
    row.setAttribute("role", "option");
    row.tabIndex = -1;
    row.draggable = sortMode === "window";
    row.dataset.tabcoachTabId = String(tab.id ?? "");
    row.dataset.tabcoachGroupId = String(tab.group?.id ?? -1);
    row.dataset.active = String(Boolean(tab.active));
    row.title = "";
    if (showGroupSections && tab.group) {
      const recencyRank = recencyRanksByTabId.get(tab.id) ?? 0;
      if (recencyRank > 0) {
        row.classList.add("row-recency-ladder");
        row.style.setProperty("--tabcoach-recency-indent", `${recencyRank * 12}px`);
      }
    }

    const rowIndex = rows.length;
    row.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || (event.target instanceof HTMLElement && event.target.closest("button"))) {
        return;
      }

      selectedIndex = rowIndex;
      pointerDownRowIndex = rowIndex;
      applyRowState();
    });
    row.addEventListener("click", (event) => {
      if (suppressNextRowClick || pointerDownRowIndex !== rowIndex) {
        suppressNextRowClick = false;
        pointerDownRowIndex = null;
        return;
      }

      pointerDownRowIndex = null;
      selectedIndex = rowIndex;
      void switchToSelectedTab().catch(reportActionError);
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openTabContextMenu(tab, rowIndex, event.clientX, event.clientY);
    });
    row.addEventListener("dragstart", (event) => {
      if (sortMode !== "window") {
        event.preventDefault();
        return;
      }

      if (event.target instanceof HTMLElement && event.target.closest("button")) {
        event.preventDefault();
        return;
      }

      draggedTabId = tab.id;
      pointerDownRowIndex = null;
      suppressNextRowClick = true;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(tab.id));
      row.style.opacity = "0.55";
    });
    row.addEventListener("dragend", () => {
      row.style.opacity = "1";
      clearDropTarget();
      draggedTabId = null;
      pointerDownRowIndex = null;
    });
    row.addEventListener("dragover", (event) => {
      if (sortMode !== "window" || draggedTabId === null || draggedTabId === tab.id) {
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const rect = row.getBoundingClientRect();
      updateDropTarget(row, event.clientY < rect.top + rect.height / 2 ? "before" : "after");
    });
    row.addEventListener("drop", (event) => {
      if (sortMode !== "window") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void moveDraggedTab().catch(reportActionError);
    });

    const icon = document.createElement("div");
    icon.className = "favicon";
    if (tab.favIconUrl) {
      const image = document.createElement("img");
      image.src = tab.favIconUrl;
      image.alt = "";
      image.draggable = false;
      icon.appendChild(image);
    }

    const text = document.createElement("div");
    text.className = "tab-text";

    const tabTitle = document.createElement("div");
    tabTitle.className = "tab-title";
    const tabTitleText = formatTabTitle(tab);
    const tabTitleLabel = document.createElement("span");
    tabTitleLabel.className = "tab-title-label";
    tabTitleLabel.textContent = tabTitleText;
    tabTitle.appendChild(tabTitleLabel);

    if (editingLabelTabId === tab.id) {
      const labelInput = document.createElement("input");
      labelInput.className = "tab-label-input";
      labelInput.type = "text";
      labelInput.value = editingLabelDraft;
      labelInput.placeholder = "Label";
      labelInput.dataset.tabcoachLabelTabId = String(tab.id);
      labelInput.setAttribute("aria-label", `Edit label for ${formatTabTitle(tab)}`);

      let labelHandled = false;
      const finishLabelEdit = (save) => {
        if (labelHandled) {
          return;
        }

        labelHandled = true;
        if (save) {
          void editTabLabel(getTabById(tab.id) ?? tab, labelInput.value).catch(reportActionError);
        } else {
          cancelEditTabLabel(tab.id);
        }
      };

      labelInput.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
      });
      labelInput.addEventListener("click", (event) => {
        event.stopPropagation();
      });
      labelInput.addEventListener("input", () => {
        editingLabelDraft = labelInput.value;
      });
      labelInput.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          finishLabelEdit(true);
          return;
        }

        if (event.key === "Escape") {
          event.preventDefault();
          finishLabelEdit(false);
        }
      });
      labelInput.addEventListener("blur", () => {
        if (isReplacingListChildren) {
          return;
        }

        finishLabelEdit(true);
      });
      tabTitle.appendChild(labelInput);
    } else if (tab.label) {
      const tabLabelPill = document.createElement("span");
      tabLabelPill.className = "tab-label-pill";
      tabLabelPill.textContent = tab.label;
      tabLabelPill.title = `Label: ${tab.label}`;
      tabTitle.appendChild(tabLabelPill);
    }

    const duplicateCount = duplicateCountsByTabId.get(tab.id);
    if (duplicateCount) {
      const duplicatePill = document.createElement("span");
      duplicatePill.className = "duplicate-pill";
      duplicatePill.textContent = `x${duplicateCount}`;
      duplicatePill.title = `${duplicateCount} tabs share this normalized URL`;
      tabTitle.appendChild(duplicatePill);
    }

    const numericSlots = numericBookmarkSlotsByNormalizedUrl.get(normalizeUrl(tab.url)) ?? [];
    numericSlots.forEach((slot) => {
      const slotPill = document.createElement("span");
      slotPill.className = "numeric-bookmark-pill";
      slotPill.textContent = slot;
      slotPill.title = `Ctrl+${slot} jumps to this numeric bookmark`;
      tabTitle.appendChild(slotPill);
    });

    const tabUrl = document.createElement("div");
    tabUrl.className = "tab-url";
    tabUrl.textContent = formatUrl(tab.url);

    const status = document.createElement("div");
    status.className = "status";
    status.textContent = [tab.active ? "Active" : "", tab.pinned ? "Pinned" : ""].filter(Boolean).join(" ");

    const bookmarkButton = createButton(
      "bookmark",
      tab.bookmarked ? "★" : "☆",
      `${tab.bookmarked ? "Remove bookmark for" : "Bookmark"} ${tab.displayTitle || tab.title || tab.url || "tab"}`,
      () => toggleBookmark(tab.id)
    );
    bookmarkButton.dataset.bookmarked = String(Boolean(tab.bookmarked));

    const closeTabButton = createButton("close", "×", `Close ${tab.displayTitle || tab.title || tab.url || "tab"}`, () => closeTab(tab.id));

    text.append(tabTitle, tabUrl);
    row.append(icon, text, status, bookmarkButton, closeTabButton);
    rows.push(row);
    tabRows.push(row);
    list.appendChild(row);

    if (showGroupSections && tab.group && expandedBookmarkGroupIds.has(tab.group.id)) {
      const nextTab = visibleTabs[index + 1];
      const nextSectionKey = nextTab?.group ? `group:${nextTab.group.id}` : nextTab ? "ungrouped" : null;
      if (nextSectionKey !== sectionKey) {
        renderGroupBookmarkRows(tab.group);
      }
    }
  });

  applyRowState(scrollBlock);
}

async function loadTabs() {
  if (!Number.isInteger(windowId)) {
    setError("Invalid window id");
    return;
  }

  try {
    const selectedTabId = document.body.classList.contains("window-blurred") ? null : getSelectedTabId();
    const response = await sendMessage({ type: GET_TAB_SWITCHER_ITEMS_MESSAGE }).then((result) =>
      assertResponse(result, "Could not load tabs")
    );
    const stored = await chrome.storage.sync.get({ [NUMERIC_BOOKMARKS_KEY]: {}, [SWITCHER_OPEN_LEFT_KEY]: false });
    numericBookmarks = stored[NUMERIC_BOOKMARKS_KEY] || {};
    keepOpenAfterSwitch = Boolean(stored[SWITCHER_OPEN_LEFT_KEY]);
    refreshNumericBookmarkSlots();
    tabLabelsByUrl = await loadStoredTabLabels();
    setTabs(response.tabs);
    focusedGroupId = await loadStoredFocusedGroupId();
    refreshDuplicateCounts();
    refreshVisibleTabs();
    const activeRenamingGroupId =
      typeof renamingGroupId === "number" && tabs.some((tab) => tab.group?.id === renamingGroupId) ? renamingGroupId : null;
    const activeEditingLabelTabId =
      typeof editingLabelTabId === "number" && tabs.some((tab) => tab.id === editingLabelTabId) ? editingLabelTabId : null;
    if (renamingGroupId !== null && activeRenamingGroupId === null) {
      renamingGroupId = null;
    }
    if (editingLabelTabId !== null && activeEditingLabelTabId === null) {
      editingLabelTabId = null;
      editingLabelDraft = "";
    }

    renderTabs({ scrollBlock: "center" });
    selectedIndex =
      activeRenamingGroupId !== null
        ? getRowIndexForGroupId(activeRenamingGroupId)
        : activeEditingLabelTabId !== null
          ? getRowIndexForTabId(activeEditingLabelTabId)
        : getRowIndexForTabOrGroup(selectedTabId || visibleTabs.find((tab) => tab.active)?.id);
    applyRowState("center");
    if (activeRenamingGroupId !== null) {
      focusGroupRenameInput(activeRenamingGroupId);
    } else if (activeEditingLabelTabId !== null) {
      focusTabLabelInput(activeEditingLabelTabId);
    } else {
      searchInput.focus();
    }
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}

function scheduleRefreshTabs() {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
  }

  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void loadTabs();
  }, 120);
}

closeButton.addEventListener("click", () => {
  window.close();
});

newTabButton.addEventListener("click", () => {
  void createNewTab().catch(reportActionError);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !changes[NUMERIC_BOOKMARKS_KEY]) {
    return;
  }

  const selectedTabId = getSelectedTabId();
  numericBookmarks = changes[NUMERIC_BOOKMARKS_KEY].newValue || {};
  refreshNumericBookmarkSlots();
  renderTabs();
  selectedIndex = getRowIndexForTabOrGroup(selectedTabId);
  applyRowState();
});

window.addEventListener("focus", () => {
  document.body.classList.remove("window-blurred");
});

window.addEventListener("blur", () => {
  document.body.classList.add("window-blurred");
  closeContextMenu();
});

window.addEventListener("resize", () => {
  closeContextMenu();
});

document.addEventListener("pointerdown", (event) => {
  if (!contextMenu || !(event.target instanceof Node) || contextMenu.contains(event.target)) {
    return;
  }

  closeContextMenu();
});

searchInput.addEventListener("input", () => {
  const selectedTabId = getSelectedTabId();
  searchQuery = searchInput.value;
  refreshVisibleTabs();
  renderTabs({ scrollBlock: "center" });
  selectedIndex = getRowIndexForTabOrGroup(selectedTabId);
  applyRowState("center");
});

sortButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const selectedTabId = getSelectedTabId();
    sortMode = button.dataset.sortMode || "window";
    refreshVisibleTabs();
    renderTabs();
    selectedIndex = getRowIndexForTabOrGroup(selectedTabId);
    applyRowState();
    if (sortMode === "recent") {
      list.scrollTop = 0;
    }
  });
});

list.addEventListener("dragover", (event) => {
  if (sortMode !== "window" || draggedTabId === null || tabRows.length === 0) {
    return;
  }

  event.preventDefault();
  const lastRow = tabRows[tabRows.length - 1];
  const lastRect = lastRow.getBoundingClientRect();
  if (event.clientY > lastRect.bottom) {
    updateDropTarget(lastRow, "after");
  }
});

list.addEventListener("drop", (event) => {
  if (sortMode !== "window") {
    return;
  }

  event.preventDefault();
  void moveDraggedTab().catch(reportActionError);
});

list.addEventListener("scroll", () => {
  closeContextMenu();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === FOCUS_TAB_SWITCHER_SEARCH_MESSAGE) {
    searchInput.focus();
    searchInput.select();
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === REFRESH_TAB_SWITCHER_MESSAGE) {
    if (message.windowId === null || message.windowId === windowId) {
      scheduleRefreshTabs();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type !== POPUP_NUMERIC_BOOKMARK_COMMAND_MESSAGE || message.windowId !== windowId) {
    return false;
  }

  const slot = String(message.slot);
  if (!/^[0-9]$/.test(slot)) {
    sendResponse({ ok: false, error: "Invalid numeric bookmark slot" });
    return true;
  }

  if (message.action === "assign") {
    void assignNumericBookmark(slot)
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch((error) => {
        reportActionError(error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }

  if (message.action === "jump") {
    sendResponse({ ok: true });
    void jumpToNumericBookmark(slot).catch(reportActionError);
    return false;
  }

  sendResponse({ ok: false, error: "Invalid numeric bookmark action" });
  return true;
});

document.addEventListener("keydown", (event) => {
  if (
    event.target instanceof HTMLElement &&
    (event.target.closest(".tab-label-input") || event.target.closest(".section-rename-input"))
  ) {
    return;
  }

  if (contextMenu) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeContextMenu();
      searchInput.focus();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusContextMenuItem(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusContextMenuItem(-1);
      return;
    }

    if (event.key === "ArrowRight") {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && activeElement.dataset.hasSubmenu === "true") {
        const submenu = activeElement.closest(".context-menu-submenu")?.querySelector(".context-menu-submenu-panel");
        if (submenu) {
          event.preventDefault();
          activeElement.click();
          focusFirstSubmenuItem(submenu);
          return;
        }
      }
    }

    if (event.key === "ArrowLeft") {
      const activeElement = document.activeElement;
      const submenu = activeElement instanceof HTMLElement ? activeElement.closest(".context-menu-submenu-panel") : null;
      const submenuTrigger = submenu?.closest(".context-menu-submenu")?.querySelector(".context-menu-item[data-has-submenu]");
      if (submenuTrigger instanceof HTMLElement) {
        event.preventDefault();
        submenuTrigger.focus();
        return;
      }
    }

    if (event.key === "Enter" || event.key === " ") {
      if (document.activeElement instanceof HTMLButtonElement && contextMenu.contains(document.activeElement)) {
        event.preventDefault();
        document.activeElement.click();
        return;
      }
    }
  }

  const numericSlot = getNumericShortcutSlot(event);
  if (event.ctrlKey && !event.metaKey && !event.altKey && numericSlot) {
    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) {
      void assignNumericBookmark(numericSlot).catch(reportActionError);
      return;
    }

    void jumpToNumericBookmark(numericSlot).catch(reportActionError);
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    if (searchInput.value) {
      searchInput.value = "";
      searchInput.dispatchEvent(new Event("input"));
      searchInput.focus();
      return;
    }

    window.close();
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    selectRelative(1);
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    selectRelative(-1);
    return;
  }

  if (event.key === "ArrowLeft") {
    const groupId = getSelectedGroupId();
    if (groupId !== null) {
      event.preventDefault();
      void setGroupCollapsed(groupId, true).catch(reportActionError);
    }
    return;
  }

  if (event.key === "ArrowRight") {
    const groupId = getSelectedGroupId();
    if (groupId !== null) {
      event.preventDefault();
      void setGroupCollapsed(groupId, false).catch(reportActionError);
    }
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    void switchToSelectedTab().catch(reportActionError);
  }
}, { capture: true });

void loadDesktopApps();
void loadAppBookmarks();
void loadWorkspaceLaunchGroups();
void loadTabs();
