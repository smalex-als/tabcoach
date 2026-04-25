const GET_TAB_SWITCHER_ITEMS_MESSAGE = "tabcoach:get-tab-switcher-items";
const SWITCH_TAB_MESSAGE = "tabcoach:switch-tab";
const CLOSE_TAB_MESSAGE = "tabcoach:close-tab";
const MOVE_TAB_MESSAGE = "tabcoach:move-tab";
const TOGGLE_BOOKMARK_MESSAGE = "tabcoach:toggle-bookmark";
const COPY_TAB_URL_MESSAGE = "tabcoach:copy-tab-url";
const LOG_TAB_EVENT_MESSAGE = "tabcoach:log-tab-event";

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

const params = new URLSearchParams(window.location.search);
const windowId = Number(params.get("windowId"));
const title = document.getElementById("title");
const list = document.getElementById("list");
const closeButton = document.getElementById("closeButton");
const sortButtons = [...document.querySelectorAll(".sort-button")];

let tabs = [];
let visibleTabs = [];
let rows = [];
let sortMode = "window";
let selectedIndex = 0;
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

function sortTabs() {
  visibleTabs = [...tabs];

  if (sortMode === "recent") {
    visibleTabs.sort((left, right) => (right.lastAccessed || 0) - (left.lastAccessed || 0));
  }
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

async function switchToSelectedTab() {
  const tabId = getSelectedTabId();
  if (tabId === null) {
    return;
  }

  await sendMessage({ type: SWITCH_TAB_MESSAGE, tabId }).then((response) => assertResponse(response, "Tab switch failed"));
  window.close();
}

async function closeTab(tabId) {
  const closedIndex = visibleTabs.findIndex((tab) => tab.id === tabId);
  await sendMessage({ type: CLOSE_TAB_MESSAGE, tabId }).then((response) => assertResponse(response, "Tab close failed"));

  tabs = tabs.filter((tab) => tab.id !== tabId);
  sortTabs();

  if (visibleTabs.length === 0) {
    window.close();
    return;
  }

  selectedIndex = Math.min(closedIndex >= 0 ? closedIndex : selectedIndex, visibleTabs.length - 1);
  renderTabs();
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
  sortTabs();
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
    sortTabs();
    selectedIndex = Math.max(
      0,
      visibleTabs.findIndex((tab) => tab.id === selectedTabId || tab.id === draggedTabId)
    );
    renderTabs();
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
  title.textContent = `Tabs in this window (${visibleTabs.length})`;

  if (visibleTabs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No tabs";
    list.appendChild(empty);
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

    row.addEventListener("mouseenter", () => {
      selectedIndex = index;
      applyRowState();
    });
    row.addEventListener("click", () => {
      selectedIndex = index;
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
    tabTitle.textContent = tab.displayTitle || tab.title || tab.url || "Untitled tab";

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
    tabs = response.tabs;
    sortTabs();
    selectedIndex = Math.max(
      0,
      visibleTabs.findIndex((tab) => tab.active)
    );
    renderTabs({ scrollBlock: "center" });
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}

closeButton.addEventListener("click", () => {
  window.close();
});

sortButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const selectedTabId = getSelectedTabId();
    const previousScrollTop = list.scrollTop;
    sortMode = button.dataset.sortMode || "window";
    sortTabs();
    selectedIndex = Math.max(
      0,
      visibleTabs.findIndex((tab) => tab.id === selectedTabId)
    );
    renderTabs();
    list.scrollTop = previousScrollTop;
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

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
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
});

void loadTabs();
