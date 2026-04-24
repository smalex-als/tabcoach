const SERVER_URL = "http://127.0.0.1:3847/api/sync";
const TTS_SELECTION_URL = "http://127.0.0.1:3847/api/tts-selection";
const SYNC_ALARM = "tabcoach-sync";
const SYNC_DEBOUNCE_MS = 1500;
const AUTO_CLOSE_DUPLICATES = true;
const NEW_TAB_DUPLICATE_GRACE_MS = 3 * 60 * 1000;
const DOCS_GROUP_TITLE = "Docs";
const DOCS_GROUP_COLOR = "blue";
const TRANSIENT_RETRY_ATTEMPTS = 4;
const TRANSIENT_RETRY_DELAY_MS = 500;
const TTS_SUCCESS_BADGE_MS = 3000;
const TAB_SWITCHER_MODAL_ID = "__tabcoach_tab_switcher_modal";
const SWITCH_TAB_MESSAGE = "tabcoach:switch-tab";
const CLOSE_TAB_MESSAGE = "tabcoach:close-tab";
const MOVE_TAB_MESSAGE = "tabcoach:move-tab";
const TOGGLE_BOOKMARK_MESSAGE = "tabcoach:toggle-bookmark";
const BOOKMARK_FOLDER_TITLE = "Tabcoach";

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
const recentTabCreations = new Map();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function closeDuplicateTabs(tabs) {
  if (!AUTO_CLOSE_DUPLICATES) {
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

async function ensureDocsGroup(protectedWindowId = null) {
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
    const protectedWindowId = await getFocusedWindowId();
    const tabs = await collectTabs();
    await closeDuplicateTabs(tabs);
    await ensureDocsGroup(protectedWindowId);
    const refreshedTabs = await collectTabs();
    const response = await fetch(SERVER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        source: `chrome-extension:${reason}`,
        capturedAt: new Date().toISOString(),
        tabs: refreshedTabs
      })
    });

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }

    const result = await response.json();
    const badgeText = result.duplicateGroupCount > 0 ? String(result.duplicateGroupCount) : "";
    await chrome.action.setBadgeBackgroundColor({ color: "#b42318" });
    await chrome.action.setBadgeText({ text: badgeText });
  } catch (error) {
    console.error("Tabcoach sync failed", error);
    await chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
    await chrome.action.setBadgeText({ text: "!" });
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
    void chrome.action.setBadgeText({ text: "" });
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

  const response = await fetch(TTS_SELECTION_URL, {
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
  });

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
  const bookmarkedUrls = await collectBookmarkedUrls(currentWindowTabs);

  const items = currentWindowTabs.map((tab) => {
    const group = typeof tab.groupId === "number" && tab.groupId >= 0 ? tabGroupsById.get(tab.groupId) : null;
    return {
      ...toTabSwitcherItem(tab, group),
      bookmarked: Boolean(tab.url && bookmarkedUrls.has(tab.url))
    };
  });

  return addTabDisplayTitles(items);
}

async function showTabSwitcherModal() {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  if (!activeTab?.id) {
    throw new Error("No active tab");
  }

  const tabItems = await collectTabSwitcherItems(activeTab.windowId);

  await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    func: (tabs, modalId, switchTabMessage, closeTabMessage, moveTabMessage, toggleBookmarkMessage) => {
      const existingModal = document.getElementById(modalId);
      if (existingModal) {
        existingModal.remove();
      }

      let sortMode = "window";
      let visibleTabs = [...tabs];
      let selectedIndex = Math.max(
        0,
        visibleTabs.findIndex((tab) => tab.active)
      );
      let draggedTabId = null;
      let dropTarget = null;
      const rows = [];
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

      const formatUrl = (rawUrl) => {
        try {
          const parsed = new URL(rawUrl);
          return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
        } catch {
          return rawUrl;
        }
      };

      const sortTabs = () => {
        visibleTabs = [...tabs];

        if (sortMode === "recent") {
          visibleTabs.sort((left, right) => (right.lastAccessed || 0) - (left.lastAccessed || 0));
        }
      };

      const closeModal = () => {
        document.getElementById(modalId)?.remove();
        document.removeEventListener("keydown", handleKeydown, true);
      };

      const applyRowState = () => {
        rows.forEach((row, index) => {
          const isSelected = index === selectedIndex;
          const isActive = row.dataset.tabcoachActive === "true";
          row.setAttribute("aria-selected", String(isSelected));
          row.style.background = isSelected
            ? "rgba(129, 140, 248, 0.34)"
            : isActive
              ? "rgba(99, 102, 241, 0.22)"
              : "transparent";
          row.style.border = isSelected
            ? "1px solid rgba(199, 210, 254, 0.82)"
            : isActive
              ? "1px solid rgba(129, 140, 248, 0.55)"
              : "1px solid transparent";
        });

        rows[selectedIndex]?.scrollIntoView({ block: "nearest" });
      };

      const selectRelative = (offset) => {
        if (rows.length === 0) {
          return;
        }

        selectedIndex = (selectedIndex + offset + rows.length) % rows.length;
        applyRowState();
      };

      const switchToSelectedTab = () => {
        const row = rows[selectedIndex];
        const tabId = Number(row?.dataset.tabcoachTabId);
        if (!Number.isFinite(tabId)) {
          return;
        }

        void chrome.runtime.sendMessage({ type: switchTabMessage, tabId }).finally(closeModal);
      };

      const closeTab = (tabId) => {
        void chrome.runtime
          .sendMessage({ type: closeTabMessage, tabId })
          .then((response) => {
            if (!response?.ok) {
              return;
            }

            const closedIndex = visibleTabs.findIndex((tab) => tab.id === tabId);
            tabs = tabs.filter((tab) => tab.id !== tabId);
            sortTabs();

            if (visibleTabs.length === 0) {
              closeModal();
              return;
            }

            selectedIndex = Math.min(
              closedIndex >= 0 ? closedIndex : selectedIndex,
              visibleTabs.length - 1
            );
            renderTabs();
            title.textContent = `Tabs in this window (${visibleTabs.length})`;
          });
      };

      const toggleBookmark = (tabId) => {
        const tab = tabs.find((item) => item.id === tabId);
        if (!tab) {
          return;
        }

        void chrome.runtime
          .sendMessage({
            type: toggleBookmarkMessage,
            tabId,
            title: tab.displayTitle || tab.title || tab.url || "Untitled tab",
            url: tab.url,
            groupTitle: tab.group?.title || "Ungrouped"
          })
          .then((response) => {
            if (!response?.ok) {
              return;
            }

            const previousScrollTop = list.scrollTop;
            tabs = tabs.map((item) => (item.id === tabId ? { ...item, bookmarked: response.bookmarked } : item));
            sortTabs();
            renderTabs();
            list.scrollTop = previousScrollTop;
          });
      };

      const clearDropTarget = () => {
        dropTarget = null;
        rows.forEach((row) => {
          row.style.boxShadow = "";
        });
      };

      const updateDropTarget = (row, position) => {
        clearDropTarget();
        dropTarget = {
          tabId: Number(row.dataset.tabcoachTabId),
          groupId: Number(row.dataset.tabcoachGroupId),
          position
        };
        row.style.boxShadow = position === "before"
          ? "inset 0 3px 0 #a5b4fc"
          : "inset 0 -3px 0 #a5b4fc";
      };

      const moveDraggedTab = () => {
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
        const selectedTabId = Number(rows[selectedIndex]?.dataset.tabcoachTabId);

        clearDropTarget();
        void chrome.runtime
          .sendMessage({ type: moveTabMessage, tabId: draggedTabId, index: moveToIndex, groupId: targetGroupId })
          .then((response) => {
            if (!response?.ok || !Array.isArray(response.tabs)) {
              return;
            }

            tabs = response.tabs;
            sortTabs();
            selectedIndex = Math.max(
              0,
              visibleTabs.findIndex((tab) => tab.id === selectedTabId || tab.id === draggedTabId)
            );
            renderTabs();
          })
          .finally(() => {
            draggedTabId = null;
          });
      };

      const handleKeydown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeModal();
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
          switchToSelectedTab();
        }
      };

      const overlay = document.createElement("div");
      overlay.id = modalId;
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-label", "Tabcoach tabs");
      Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483647",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "10vh 18px 18px",
        background: "rgba(15, 23, 42, 0.42)",
        boxSizing: "border-box",
        font: "16px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
      });

      const panel = document.createElement("div");
      panel.tabIndex = -1;
      Object.assign(panel.style, {
        width: "min(920px, 100%)",
        height: "min(80vh, calc(100vh - 36px))",
        overflow: "hidden",
        borderRadius: "8px",
        background: "#1f2937",
        color: "#f9fafb",
        boxShadow: "0 24px 80px rgba(0, 0, 0, 0.32)",
        border: "1px solid rgba(148, 163, 184, 0.3)"
      });

      const header = document.createElement("div");
      Object.assign(header.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "16px",
        padding: "14px 16px",
        borderBottom: "1px solid rgba(148, 163, 184, 0.24)"
      });

      const title = document.createElement("div");
      title.textContent = `Tabs in this window (${tabs.length})`;
      Object.assign(title.style, {
        fontSize: "18px",
        fontWeight: "650"
      });

      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.textContent = "Close";
      Object.assign(closeButton.style, {
        border: "1px solid rgba(148, 163, 184, 0.42)",
        borderRadius: "6px",
        background: "#374151",
        color: "#f9fafb",
        padding: "8px 12px",
        font: "15px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        cursor: "pointer"
      });
      closeButton.addEventListener("click", closeModal);

      const sortControls = document.createElement("div");
      Object.assign(sortControls.style, {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        marginLeft: "auto"
      });

      const createSortButton = (mode, label) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.dataset.tabcoachSortMode = mode;
        Object.assign(button.style, {
          border: "1px solid rgba(148, 163, 184, 0.42)",
          borderRadius: "6px",
          background: "#374151",
          color: "#f9fafb",
          padding: "8px 10px",
          font: "15px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          cursor: "pointer"
        });
        button.addEventListener("click", () => {
          const selectedTabId = Number(rows[selectedIndex]?.dataset.tabcoachTabId);
          const previousScrollTop = list.scrollTop;
          sortMode = mode;
          sortTabs();
          selectedIndex = Math.max(
            0,
            visibleTabs.findIndex((tab) => tab.id === selectedTabId)
          );
          renderTabs();
          list.scrollTop = previousScrollTop;
        });
        return button;
      };

      const windowOrderButton = createSortButton("window", "Window order");
      const recentOrderButton = createSortButton("recent", "Recently visited");
      sortControls.append(windowOrderButton, recentOrderButton);

      const list = document.createElement("div");
      list.setAttribute("role", "listbox");
      list.setAttribute("aria-label", "Tabs in this window");
      Object.assign(list.style, {
        height: "calc(100% - 57px)",
        overflowY: "auto",
        padding: "6px"
      });

      const updateSortButtons = () => {
        for (const button of [windowOrderButton, recentOrderButton]) {
          const isActive = button.dataset.tabcoachSortMode === sortMode;
          button.style.background = isActive ? "#6366f1" : "#374151";
          button.style.border = isActive ? "1px solid rgba(199, 210, 254, 0.78)" : "1px solid rgba(148, 163, 184, 0.42)";
        }
      };

      const renderTabs = () => {
        rows.length = 0;
        list.replaceChildren();
        updateSortButtons();

        const showGroupSections = sortMode === "window" && visibleTabs.some((tab) => tab.group);
        let lastSectionKey = null;

        visibleTabs.forEach((tab, index) => {
          if (showGroupSections) {
            const sectionKey = tab.group ? `group:${tab.group.id}` : "ungrouped";
            if (sectionKey !== lastSectionKey) {
              const sectionHeader = document.createElement("div");
              Object.assign(sectionHeader.style, {
                display: "flex",
                alignItems: "center",
                gap: "9px",
                padding: index === 0 ? "8px 10px 6px" : "18px 10px 6px",
                color: "#e5e7eb",
                fontSize: "13px",
                fontWeight: "700",
                textTransform: "uppercase",
                letterSpacing: "0"
              });

              const swatch = document.createElement("span");
              Object.assign(swatch.style, {
                width: "10px",
                height: "10px",
                borderRadius: "999px",
                background: tab.group ? groupColors[tab.group.color] ?? groupColors.grey : "#6b7280",
                flex: "0 0 auto"
              });

              const sectionTitle = document.createElement("span");
              sectionTitle.textContent = tab.group
                ? `${tab.group.title || "Unnamed group"}${tab.group.collapsed ? " (collapsed)" : ""}`
                : "Ungrouped";
              Object.assign(sectionTitle.style, {
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap"
              });

              sectionHeader.append(swatch, sectionTitle);
              list.appendChild(sectionHeader);
              lastSectionKey = sectionKey;
            }
          }

          const row = document.createElement("div");
          row.setAttribute("role", "option");
          row.tabIndex = -1;
          row.draggable = sortMode === "window";
          row.dataset.tabcoachTabId = String(tab.id ?? "");
          row.dataset.tabcoachGroupId = String(tab.group?.id ?? -1);
          row.dataset.tabcoachActive = String(Boolean(tab.active));
          row.title = sortMode === "window" ? "Drag to reorder tabs" : "";
          Object.assign(row.style, {
            display: "grid",
            gridTemplateColumns: "40px minmax(0, 1fr) auto 34px 34px",
            alignItems: "center",
            gap: "12px",
            padding: "11px 12px",
            borderRadius: "6px",
            background: tab.active ? "rgba(99, 102, 241, 0.22)" : "transparent",
            border: tab.active ? "1px solid rgba(129, 140, 248, 0.55)" : "1px solid transparent",
            cursor: "pointer"
          });
          row.addEventListener("mouseenter", () => {
            selectedIndex = index;
            applyRowState();
          });
          row.addEventListener("click", () => {
            selectedIndex = index;
            switchToSelectedTab();
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
            moveDraggedTab();
          });

          const icon = document.createElement("div");
          icon.draggable = false;
          Object.assign(icon.style, {
            width: "32px",
            height: "32px",
            borderRadius: "6px",
            overflow: "hidden",
            background: "#4b5563"
          });

          if (tab.favIconUrl) {
            const image = document.createElement("img");
            image.src = tab.favIconUrl;
            image.alt = "";
            image.draggable = false;
            Object.assign(image.style, {
              width: "32px",
              height: "32px",
              display: "block"
            });
            icon.appendChild(image);
          }

          const text = document.createElement("div");
          Object.assign(text.style, {
            minWidth: "0"
          });

          const tabTitle = document.createElement("div");
          tabTitle.textContent = tab.displayTitle || tab.title || tab.url || "Untitled tab";
          Object.assign(tabTitle.style, {
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontWeight: tab.active ? "650" : "500"
          });

          const tabUrl = document.createElement("div");
          tabUrl.textContent = formatUrl(tab.url);
          Object.assign(tabUrl.style, {
            marginTop: "2px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "#d1d5db",
            fontSize: "14px"
          });

          const status = document.createElement("div");
          status.textContent = [tab.active ? "Active" : "", tab.pinned ? "Pinned" : ""].filter(Boolean).join(" ");
          Object.assign(status.style, {
            color: "#c7d2fe",
            fontSize: "14px",
            fontWeight: "650",
            minWidth: "58px",
            textAlign: "right"
          });

          const closeTabButton = document.createElement("button");
          closeTabButton.type = "button";
          closeTabButton.draggable = false;
          closeTabButton.textContent = "×";
          closeTabButton.setAttribute("aria-label", `Close ${tab.displayTitle || tab.title || tab.url || "tab"}`);
          Object.assign(closeTabButton.style, {
            width: "28px",
            height: "28px",
            border: "1px solid transparent",
            borderRadius: "6px",
            background: "transparent",
            color: "#d1d5db",
            font: "22px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            cursor: "pointer",
            padding: "0"
          });
          closeTabButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            closeTab(tab.id);
          });
          closeTabButton.addEventListener("pointerdown", (event) => {
            event.stopPropagation();
          });
          closeTabButton.addEventListener("dragstart", (event) => {
            event.preventDefault();
            event.stopPropagation();
          });
          closeTabButton.addEventListener("mouseenter", () => {
            closeTabButton.style.background = "rgba(248, 113, 113, 0.16)";
            closeTabButton.style.color = "#fecaca";
            closeTabButton.style.border = "1px solid rgba(248, 113, 113, 0.42)";
          });
          closeTabButton.addEventListener("mouseleave", () => {
            closeTabButton.style.background = "transparent";
            closeTabButton.style.color = "#d1d5db";
            closeTabButton.style.border = "1px solid transparent";
          });

          const bookmarkButton = document.createElement("button");
          bookmarkButton.type = "button";
          bookmarkButton.draggable = false;
          bookmarkButton.textContent = tab.bookmarked ? "★" : "☆";
          bookmarkButton.setAttribute(
            "aria-label",
            `${tab.bookmarked ? "Remove bookmark for" : "Bookmark"} ${tab.displayTitle || tab.title || tab.url || "tab"}`
          );
          Object.assign(bookmarkButton.style, {
            width: "28px",
            height: "28px",
            border: "1px solid transparent",
            borderRadius: "6px",
            background: "transparent",
            color: tab.bookmarked ? "#facc15" : "#d1d5db",
            font: "22px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            cursor: "pointer",
            padding: "0"
          });
          bookmarkButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            toggleBookmark(tab.id);
          });
          bookmarkButton.addEventListener("pointerdown", (event) => {
            event.stopPropagation();
          });
          bookmarkButton.addEventListener("dragstart", (event) => {
            event.preventDefault();
            event.stopPropagation();
          });
          bookmarkButton.addEventListener("mouseenter", () => {
            bookmarkButton.style.background = "rgba(250, 204, 21, 0.14)";
            bookmarkButton.style.border = "1px solid rgba(250, 204, 21, 0.38)";
          });
          bookmarkButton.addEventListener("mouseleave", () => {
            bookmarkButton.style.background = "transparent";
            bookmarkButton.style.border = "1px solid transparent";
          });

          text.append(tabTitle, tabUrl);
          row.append(icon, text, status, bookmarkButton, closeTabButton);
          rows.push(row);
          list.appendChild(row);
        });

        applyRowState();
      };

      header.append(title, sortControls, closeButton);
      panel.append(header, list);
      overlay.appendChild(panel);
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
        moveDraggedTab();
      });
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
          closeModal();
        }
      });
      document.addEventListener("keydown", handleKeydown, true);
      document.documentElement.appendChild(overlay);
      sortTabs();
      renderTabs();
      panel.focus();
    },
    args: [tabItems, TAB_SWITCHER_MODAL_ID, SWITCH_TAB_MESSAGE, CLOSE_TAB_MESSAGE, MOVE_TAB_MESSAGE, TOGGLE_BOOKMARK_MESSAGE]
  });
}

async function switchToTab(tabId, senderTab) {
  if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
    throw new Error("Invalid tab id");
  }

  const targetTab = await chrome.tabs.get(tabId);
  if (typeof senderTab?.windowId === "number" && targetTab.windowId !== senderTab.windowId) {
    throw new Error("Cannot switch to a tab outside the current window");
  }

  if (typeof targetTab.groupId === "number" && targetTab.groupId >= 0) {
    await chrome.tabGroups.update(targetTab.groupId, { collapsed: false });
  }

  await chrome.tabs.update(tabId, { active: true });

  if (typeof targetTab.windowId === "number") {
    await chrome.windows.update(targetTab.windowId, { focused: true });
  }
}

async function closeTabFromSwitcher(tabId, senderTab) {
  if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
    throw new Error("Invalid tab id");
  }

  const targetTab = await chrome.tabs.get(tabId);
  if (typeof senderTab?.windowId === "number" && targetTab.windowId !== senderTab.windowId) {
    throw new Error("Cannot close a tab outside the current window");
  }

  await chrome.tabs.remove(tabId);
}

async function moveTabFromSwitcher(tabId, index, groupId, senderTab) {
  if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
    throw new Error("Invalid tab id");
  }

  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    throw new Error("Invalid tab index");
  }

  const targetTab = await chrome.tabs.get(tabId);
  if (typeof senderTab?.windowId === "number" && targetTab.windowId !== senderTab.windowId) {
    throw new Error("Cannot move a tab outside the current window");
  }

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

async function getOrCreateBookmarkFolder() {
  const matches = await chrome.bookmarks.search({ title: BOOKMARK_FOLDER_TITLE });
  const existingFolder = matches.find((bookmark) => bookmark.title === BOOKMARK_FOLDER_TITLE && !bookmark.url);

  if (existingFolder?.id) {
    return existingFolder.id;
  }

  const folder = await chrome.bookmarks.create({ title: BOOKMARK_FOLDER_TITLE });
  return folder.id;
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

async function toggleBookmarkFromSwitcher(tabId, title, url, groupTitle, senderTab) {
  if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
    throw new Error("Invalid tab id");
  }

  if (typeof url !== "string" || url.length === 0) {
    throw new Error("Invalid bookmark URL");
  }

  const targetTab = await chrome.tabs.get(tabId);
  if (typeof senderTab?.windowId === "number" && targetTab.windowId !== senderTab.windowId) {
    throw new Error("Cannot bookmark a tab outside the current window");
  }

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

function scheduleSync(reason) {
  if (pendingSyncTimer !== null) {
    clearTimeout(pendingSyncTimer);
  }

  pendingSyncTimer = setTimeout(() => {
    pendingSyncTimer = null;
    void pushSnapshot(reason);
  }, SYNC_DEBOUNCE_MS);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
  void pushSnapshot("installed");
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
  void pushSnapshot("startup");
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) {
    void pushSnapshot("alarm");
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  markTabCreated(tab?.id);
  scheduleSync("tab-created");
});

chrome.tabs.onUpdated.addListener((tabId) => {
  if (typeof tabId === "number") {
    cleanupRecentTabCreations();
  }
  scheduleSync("tab-updated");
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (typeof tabId === "number") {
    recentTabCreations.delete(tabId);
  }
  scheduleSync("tab-removed");
});

chrome.tabs.onActivated.addListener(() => {
  scheduleSync("tab-activated");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === TOGGLE_BOOKMARK_MESSAGE) {
    void toggleBookmarkFromSwitcher(message.tabId, message.title, message.url, message.groupTitle, sender.tab)
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
    void moveTabFromSwitcher(message.tabId, message.index, message.groupId, sender.tab)
      .then((tabs) => {
        sendResponse({ ok: true, tabs });
      })
      .catch((error) => {
        console.error("Tabcoach tab move failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }

  if (message?.type === CLOSE_TAB_MESSAGE) {
    void closeTabFromSwitcher(message.tabId, sender.tab)
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

  void switchToTab(message.tabId, sender.tab)
    .then(() => {
      sendResponse({ ok: true });
    })
    .catch((error) => {
      console.error("Tabcoach tab switch failed", error);
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });

  return true;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "show-tab-switcher") {
    void showTabSwitcherModal().catch((error) => {
      console.error("Tabcoach tab switcher failed", error);
    });
    return;
  }

  if (command === "speak-selection") {
    void sendSelectionToTts().catch((error) => {
      console.error("Tabcoach TTS selection failed", error);
    });
  }
});
