const GET_TAB_SWITCHER_ITEMS_MESSAGE = "tabcoach:get-tab-switcher-items";
const CREATE_TAB_MESSAGE = "tabcoach:create-tab";
const JUMP_NUMERIC_BOOKMARK_MESSAGE = "tabcoach:jump-numeric-bookmark";
const POPUP_NUMERIC_BOOKMARK_COMMAND_MESSAGE = "tabcoach:popup-numeric-bookmark-command";
const SWITCH_TAB_MESSAGE = "tabcoach:switch-tab";
const CLOSE_TAB_MESSAGE = "tabcoach:close-tab";
const MOVE_TAB_MESSAGE = "tabcoach:move-tab";
const TOGGLE_BOOKMARK_MESSAGE = "tabcoach:toggle-bookmark";
const COPY_TAB_URL_MESSAGE = "tabcoach:copy-tab-url";
const LOG_TAB_EVENT_MESSAGE = "tabcoach:log-tab-event";
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
const title = document.getElementById("title");
const list = document.getElementById("list");
const searchInput = document.getElementById("searchInput");
const newTabButton = document.getElementById("newTabButton");
const closeButton = document.getElementById("closeButton");
const sortButtons = [...document.querySelectorAll(".sort-button")];

let tabs = [];
let duplicateCountsByTabId = new Map();
let numericBookmarks = {};
let numericBookmarkSlotsByNormalizedUrl = new Map();
let visibleTabs = [];
let rows = [];
let sortMode = "window";
let searchQuery = "";
let selectedIndex = 0;
let keepOpenAfterSwitch = false;
let draggedTabId = null;
let dropTarget = null;

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

function getRowIndexForTabId(tabId) {
  const rowIndex = rows.findIndex((row) => Number(row.dataset.tabcoachTabId) === tabId);
  return rowIndex >= 0 ? rowIndex : 0;
}

function getNumericShortcutSlot(event) {
  const match = event.code.match(/^Digit([1-9])$/);
  return match ? match[1] : null;
}

function closeAfterSwitchIfNeeded() {
  if (!keepOpenAfterSwitch) {
    window.close();
  }
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
    return;
  }

  await sendMessage({ type: SWITCH_TAB_MESSAGE, tabId }).then((response) => assertResponse(response, "Tab switch failed"));
  closeAfterSwitchIfNeeded();
}

async function createNewTab() {
  await sendMessage({ type: CREATE_TAB_MESSAGE }).then((response) => assertResponse(response, "New tab failed"));
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
  await sendMessage({ type: JUMP_NUMERIC_BOOKMARK_MESSAGE, bookmark }).then((response) =>
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

function clearDropTarget() {
  dropTarget = null;
  rows.forEach((row) => {
    row.classList.remove("drop-before", "drop-after");
  });
}

function updateDropTarget(row, position) {
  clearDropTarget();
  dropTarget = {
    tabId: Number(row.dataset.tabcoachTabId),
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

    tabs = response.tabs;
    refreshDuplicateCounts();
    refreshVisibleTabs();
    renderTabs();
    selectedIndex = getRowIndexForTabId(selectedTabId) || getRowIndexForTabId(draggedTabId);
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
  list.replaceChildren();
  updateSortButtons();
  title.textContent = searchQuery.trim()
    ? `Tabs (${visibleTabs.length}/${tabs.length})`
    : `Tabs in this window (${tabs.length})`;

  if (visibleTabs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = tabs.length === 0 ? "No tabs" : "No matching tabs";
    list.appendChild(empty);
    applyRowState(scrollBlock);
    return;
  }

  const showGroupSections = sortMode === "window" && visibleTabs.some((tab) => tab.group);
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
          ? `${tab.group.title || "Unnamed group"}${tab.group.collapsed ? " (collapsed)" : ""}`
          : "Ungrouped";

        sectionHeader.append(swatch, sectionTitle);
        list.appendChild(sectionHeader);
        lastSectionKey = sectionKey;
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
    row.addEventListener("mouseenter", () => {
      selectedIndex = rowIndex;
      applyRowState();
    });
    row.addEventListener("click", () => {
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
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(tab.id));
      row.style.opacity = "0.55";
    });
    row.addEventListener("dragend", () => {
      row.style.opacity = "1";
      clearDropTarget();
      draggedTabId = null;
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
    const response = await sendMessage({ type: GET_TAB_SWITCHER_ITEMS_MESSAGE }).then((result) =>
      assertResponse(result, "Could not load tabs")
    );
    const stored = await chrome.storage.sync.get({ [NUMERIC_BOOKMARKS_KEY]: {}, [SWITCHER_OPEN_LEFT_KEY]: false });
    numericBookmarks = stored[NUMERIC_BOOKMARKS_KEY] || {};
    keepOpenAfterSwitch = Boolean(stored[SWITCHER_OPEN_LEFT_KEY]);
    refreshNumericBookmarkSlots();
    tabs = response.tabs;
    refreshDuplicateCounts();
    refreshVisibleTabs();
    renderTabs({ scrollBlock: "center" });
    selectedIndex = getRowIndexForTabId(visibleTabs.find((tab) => tab.active)?.id);
    applyRowState("center");
    searchInput.focus();
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}

closeButton.addEventListener("click", () => {
  window.close();
});

newTabButton.addEventListener("click", () => {
  void createNewTab().catch(reportActionError);
});

searchInput.addEventListener("input", () => {
  const selectedTabId = getSelectedTabId();
  searchQuery = searchInput.value;
  refreshVisibleTabs();
  renderTabs({ scrollBlock: "center" });
  selectedIndex = getRowIndexForTabId(selectedTabId);
  applyRowState("center");
});

sortButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const selectedTabId = getSelectedTabId();
    sortMode = button.dataset.sortMode || "window";
    refreshVisibleTabs();
    renderTabs();
    selectedIndex = getRowIndexForTabId(selectedTabId);
    applyRowState();
    if (sortMode === "recent") {
      list.scrollTop = 0;
    }
  });
});

list.addEventListener("dragover", (event) => {
  if (sortMode !== "window" || draggedTabId === null || rows.length === 0) {
    return;
  }

  event.preventDefault();
  const lastRow = rows[rows.length - 1];
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
  if (message?.type !== POPUP_NUMERIC_BOOKMARK_COMMAND_MESSAGE || message.windowId !== windowId) {
    return false;
  }

  const slot = String(message.slot);
  if (!/^[1-9]$/.test(slot)) {
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

  if (event.key === "Enter") {
    event.preventDefault();
    void switchToSelectedTab().catch(reportActionError);
  }
}, { capture: true });

void loadTabs();
