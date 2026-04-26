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
const SET_GROUP_COLLAPSED_MESSAGE = "tabcoach:set-group-collapsed";
const RENAME_GROUP_MESSAGE = "tabcoach:rename-group";
const TOGGLE_BOOKMARK_MESSAGE = "tabcoach:toggle-bookmark";
const COPY_TAB_URL_MESSAGE = "tabcoach:copy-tab-url";
const LOG_TAB_EVENT_MESSAGE = "tabcoach:log-tab-event";
const GET_DESKTOP_APPS_MESSAGE = "tabcoach:get-desktop-apps";
const LAUNCH_DESKTOP_APP_MESSAGE = "tabcoach:launch-desktop-app";
const NUMERIC_BOOKMARKS_KEY = "numericBookmarks";
const SWITCHER_OPEN_LEFT_KEY = "switcherOpenLeft";

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
const groupSelectedButton = document.getElementById("groupSelectedButton");
const duplicateSelectedButton = document.getElementById("duplicateSelectedButton");
const closeButton = document.getElementById("closeButton");
const sortButtons = [...document.querySelectorAll(".sort-button")];

document.body.classList.toggle("window-blurred", !document.hasFocus());

let tabs = [];
let duplicateCountsByTabId = new Map();
let numericBookmarks = {};
let numericBookmarkSlotsByNormalizedUrl = new Map();
let visibleTabs = [];
let rows = [];
let tabRows = [];
let sortMode = "window";
let searchQuery = "";
let selectedIndex = 0;
let keepOpenAfterSwitch = false;
let draggedTabId = null;
let dropTarget = null;
let refreshTimer = null;
let suppressNextRowClick = false;
let pointerDownRowIndex = null;

function sendMessage(message) {
  return chrome.runtime.sendMessage({ windowId, ...message });
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
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return rawUrl;
  }
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

function getSelectedTab() {
  const tabId = getSelectedTabId();
  return typeof tabId === "number" ? tabs.find((tab) => tab.id === tabId) ?? null : null;
}

function getTabActionLabel(tab) {
  return tab?.displayTitle || tab?.title || tab?.url || "selected tab";
}

function updateSelectedTabActionButtons() {
  const selectedTab = getSelectedTab();
  const hasSelectedTab = Boolean(selectedTab);

  duplicateSelectedButton.disabled = !hasSelectedTab;
  duplicateSelectedButton.title = hasSelectedTab ? `Duplicate ${getTabActionLabel(selectedTab)}` : "Select a tab to duplicate";
  duplicateSelectedButton.setAttribute("aria-label", duplicateSelectedButton.title);

  const canGroupSelectedTab = Boolean(selectedTab && !selectedTab.pinned);
  groupSelectedButton.disabled = !canGroupSelectedTab;
  groupSelectedButton.title = !hasSelectedTab
    ? "Select a tab to create a group"
    : selectedTab.pinned
      ? "Unpin this tab before creating a group"
      : `Create group for ${getTabActionLabel(selectedTab)}`;
  groupSelectedButton.setAttribute("aria-label", groupSelectedButton.title);
}

function applyRowState(scrollBlock = "nearest") {
  rows.forEach((row, index) => {
    row.setAttribute("aria-selected", String(index === selectedIndex));
  });

  rows[selectedIndex]?.scrollIntoView({ block: scrollBlock });
  updateSelectedTabActionButtons();
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

function getRowIndexForTabId(tabId) {
  const rowIndex = rows.findIndex((row) => Number(row.dataset.tabcoachTabId) === tabId);
  return rowIndex >= 0 ? rowIndex : 0;
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
  tabs = dedupeTabsById(response.tabs);
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

async function renameGroup(groupId, currentTitle) {
  if (typeof groupId !== "number") {
    return;
  }

  const nextTitle = window.prompt("Rename tab group", currentTitle || "");
  if (nextTitle === null) {
    return;
  }

  const selectedTabId = getSelectedTabId();
  const response = await sendMessage({ type: RENAME_GROUP_MESSAGE, groupId, title: nextTitle }).then((result) =>
    assertResponse(result, "Group rename failed")
  );
  tabs = dedupeTabsById(response.tabs);
  refreshDuplicateCounts();
  refreshVisibleTabs();
  renderTabs();
  selectedIndex = getRowIndexForTabOrGroup(selectedTabId) || getRowIndexForGroupId(groupId);
  applyRowState();
}

async function createGroupForTab(tabId, currentTitle = "") {
  if (typeof tabId !== "number") {
    return;
  }

  const selectedTabId = getSelectedTabId();
  const nextTitle = window.prompt("Create tab group", currentTitle || "New group");
  if (nextTitle === null) {
    return;
  }

  const response = await sendMessage({ type: CREATE_GROUP_MESSAGE, tabId, title: nextTitle }).then((result) =>
    assertResponse(result, "Group create failed")
  );
  tabs = dedupeTabsById(response.tabs);
  refreshDuplicateCounts();
  refreshVisibleTabs();
  renderTabs();
  selectedIndex = getRowIndexForTabId(selectedTabId || tabId);
  applyRowState();
}

async function createGroupForSelectedTab() {
  const tab = getSelectedTab();
  if (!tab?.id || tab.pinned) {
    return;
  }

  await createGroupForTab(tab.id, tab.group?.title || "");
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

async function duplicateSelectedTab() {
  const tab = getSelectedTab();
  if (!tab?.id) {
    return;
  }

  await duplicateTab(tab.id);
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

function renderDesktopApps(apps) {
  desktopApps.replaceChildren();
  const safeApps = getSafeDesktopApps(apps);

  if (safeApps.length === 0) {
    desktopApps.hidden = true;
    return;
  }

  desktopApps.hidden = false;
  const appButtons = document.createElement("div");
  appButtons.className = "desktop-app-buttons";

  safeApps.forEach((app) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "desktop-app-button";
    button.textContent = app.label;
    button.title = `Open ${app.label}`;
    button.addEventListener("click", () => {
      void launchDesktopApp(app, button);
    });
    appButtons.appendChild(button);
  });

  desktopApps.appendChild(appButtons);
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

    tabs = dedupeTabsById(response.tabs);
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
  button.setAttribute("aria-label", label);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    Promise.resolve(onClick(button)).catch(reportActionError);
  });
  button.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  button.addEventListener("dragstart", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  return button;
}

function renderTabs({ scrollBlock = "nearest" } = {}) {
  rows = [];
  tabRows = [];
  list.replaceChildren();
  updateSortButtons();

  if (visibleTabs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = tabs.length === 0 ? "No tabs" : "No matching tabs";
    list.appendChild(empty);
    applyRowState(scrollBlock);
    return;
  }

  const showGroupSections = sortMode === "window" && visibleTabs.some((tab) => tab.group);
  const tabCountsBySectionKey = new Map();
  if (showGroupSections) {
    visibleTabs.forEach((tab) => {
      const sectionKey = tab.group ? `group:${tab.group.id}` : "ungrouped";
      tabCountsBySectionKey.set(sectionKey, (tabCountsBySectionKey.get(sectionKey) ?? 0) + 1);
    });
  }
  let lastSectionKey = null;

  visibleTabs.forEach((tab, index) => {
    if (showGroupSections) {
      const sectionKey = tab.group ? `group:${tab.group.id}` : "ungrouped";
      if (sectionKey !== lastSectionKey) {
        const sectionHeader = document.createElement("div");
        sectionHeader.className = "section-header";

        const swatch = document.createElement("span");
        swatch.className = "swatch";
        swatch.style.background = tab.group ? groupColors[tab.group.color] ?? groupColors.grey : "#6b7280";

        const sectionTitle = document.createElement("span");
        sectionTitle.className = "section-title";
        sectionTitle.textContent = tab.group
          ? `${tab.group.title || "Unnamed group"}${tab.group.collapsed ? ` (${tabCountsBySectionKey.get(sectionKey) ?? 0} collapsed)` : ""}`
          : "Ungrouped";

        sectionHeader.append(swatch, sectionTitle);
        if (tab.group) {
          const renameButton = createButton(
            "group-rename",
            "✎",
            `Rename ${tab.group.title || "Unnamed group"}`,
            () => renameGroup(tab.group.id, tab.group.title || "")
          );
          sectionHeader.appendChild(renameButton);
          sectionHeader.classList.add("section-header-clickable");
          if (tab.group.collapsed) {
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
          rows.push(sectionHeader);
        }
        list.appendChild(sectionHeader);
        lastSectionKey = sectionKey;
      }

      if (tab.group?.collapsed) {
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
    row.title = sortMode === "window" ? "Drag to reorder tabs" : "";

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
    const tabTitleText = tab.displayTitle || tab.title || tab.url || "Untitled tab";
    const tabTitleLabel = document.createElement("span");
    tabTitleLabel.className = "tab-title-label";
    tabTitleLabel.textContent = tabTitleText;
    tabTitle.appendChild(tabTitleLabel);

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

    const copyButton = createButton("copy", "⧉", `Copy URL for ${tab.displayTitle || tab.title || tab.url || "tab"}`, async (button) => {
      const copied = await copyTabUrl(tab.id);
      button.textContent = copied ? "✓" : "!";
      button.style.color = copied ? "#86efac" : "#fca5a5";
      logCopyTabUrl(tab, copied);
      setTimeout(() => {
        button.textContent = "⧉";
        button.style.color = "";
      }, 900);
    });

    const closeTabButton = createButton("close", "×", `Close ${tab.displayTitle || tab.title || tab.url || "tab"}`, () => closeTab(tab.id));

    text.append(tabTitle, tabUrl);
    row.append(icon, text, status, bookmarkButton, copyButton, closeTabButton);
    rows.push(row);
    tabRows.push(row);
    list.appendChild(row);
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
    tabs = dedupeTabsById(response.tabs);
    refreshDuplicateCounts();
    refreshVisibleTabs();
    renderTabs({ scrollBlock: "center" });
    selectedIndex = getRowIndexForTabOrGroup(selectedTabId || visibleTabs.find((tab) => tab.active)?.id);
    applyRowState("center");
    searchInput.focus();
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

groupSelectedButton.addEventListener("click", () => {
  void createGroupForSelectedTab().catch(reportActionError);
});

duplicateSelectedButton.addEventListener("click", () => {
  void duplicateSelectedTab().catch(reportActionError);
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
void loadTabs();
