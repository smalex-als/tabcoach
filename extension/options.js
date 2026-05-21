const DEFAULT_SETTINGS = {
  serverBaseUrl: "http://127.0.0.1:3847",
  autoCloseDuplicates: true,
  fetchDiagnostics: true,
  syncIntervalMinutes: 1,
  switcherOpenLeft: false,
  badgeMode: "both",
  appBookmarks: [],
  workspaceLaunchGroups: []
};

const form = document.getElementById("settingsForm");
const status = document.getElementById("status");
const resetButton = document.getElementById("resetButton");
const statsButton = document.getElementById("statsButton");
const fields = {
  serverBaseUrl: document.getElementById("serverBaseUrl"),
  autoCloseDuplicates: document.getElementById("autoCloseDuplicates"),
  fetchDiagnostics: document.getElementById("fetchDiagnostics"),
  syncIntervalMinutes: document.getElementById("syncIntervalMinutes"),
  switcherOpenLeft: document.getElementById("switcherOpenLeft"),
  badgeMode: document.getElementById("badgeMode"),
  appBookmarks: document.getElementById("appBookmarks"),
  workspaceLaunchGroups: document.getElementById("workspaceLaunchGroups")
};

let statusTimer = null;

function showStatus(message, tone = "success") {
  status.textContent = message;
  status.dataset.tone = tone;
  if (statusTimer !== null) {
    clearTimeout(statusTimer);
  }

  statusTimer = setTimeout(() => {
    statusTimer = null;
    status.textContent = "";
    delete status.dataset.tone;
  }, 1800);
}

function sanitizeServerBaseUrl(value) {
  return value.trim().replace(/\/+$/, "");
}

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

function getAppBookmarkId(bookmark, index) {
  if (typeof bookmark?.id === "string" && bookmark.id.trim().length > 0) {
    return bookmark.id.trim();
  }

  if (typeof bookmark?.label === "string" && bookmark.label.trim().length > 0) {
    const slug = bookmark.label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug) {
      return slug;
    }
  }

  return `app-bookmark-${index + 1}`;
}

function sanitizeAppBookmarks(bookmarks) {
  return bookmarks
    .map((bookmark, index) => ({
      id: getAppBookmarkId(bookmark, index),
      label: typeof bookmark?.label === "string" ? bookmark.label.trim() : "",
      url: sanitizeWorkspaceUrl(bookmark?.url)
    }))
    .filter((bookmark) => bookmark.label && bookmark.url);
}

function sanitizeWorkspaceLaunchGroups(groups) {
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

function readWorkspaceLaunchGroups() {
  const rawValue = fields.workspaceLaunchGroups.value.trim();
  if (!rawValue) {
    return { groups: [], error: "" };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return { groups: [], error: "Workspace JSON is invalid" };
  }

  if (!Array.isArray(parsed)) {
    return { groups: [], error: "Workspace JSON must be an array" };
  }

  const groups = sanitizeWorkspaceLaunchGroups(parsed);
  if (groups.length === 0 && parsed.length > 0) {
    return { groups: [], error: "Each workspace needs a label and at least one URL" };
  }

  return { groups, error: "" };
}

function readAppBookmarks() {
  const rawValue = fields.appBookmarks.value.trim();
  if (!rawValue) {
    return { bookmarks: [], error: "" };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return { bookmarks: [], error: "App bookmarks JSON is invalid" };
  }

  if (!Array.isArray(parsed)) {
    return { bookmarks: [], error: "App bookmarks JSON must be an array" };
  }

  const bookmarks = sanitizeAppBookmarks(parsed);
  if (bookmarks.length === 0 && parsed.length > 0) {
    return { bookmarks: [], error: "Each app bookmark needs a label and URL" };
  }

  return { bookmarks, error: "" };
}

function readFormSettings(appBookmarks, workspaceLaunchGroups) {
  return {
    serverBaseUrl: sanitizeServerBaseUrl(fields.serverBaseUrl.value),
    autoCloseDuplicates: fields.autoCloseDuplicates.checked,
    fetchDiagnostics: fields.fetchDiagnostics.checked,
    syncIntervalMinutes: Number(fields.syncIntervalMinutes.value),
    switcherOpenLeft: fields.switcherOpenLeft.checked,
    badgeMode: fields.badgeMode.value,
    appBookmarks,
    workspaceLaunchGroups
  };
}

function writeFormSettings(settings) {
  fields.serverBaseUrl.value = settings.serverBaseUrl;
  fields.autoCloseDuplicates.checked = Boolean(settings.autoCloseDuplicates);
  fields.fetchDiagnostics.checked = Boolean(settings.fetchDiagnostics);
  fields.syncIntervalMinutes.value = String(settings.syncIntervalMinutes);
  fields.switcherOpenLeft.checked = Boolean(settings.switcherOpenLeft);
  fields.badgeMode.value = settings.badgeMode;
  fields.appBookmarks.value = JSON.stringify(settings.appBookmarks || [], null, 2);
  fields.workspaceLaunchGroups.value = JSON.stringify(settings.workspaceLaunchGroups || [], null, 2);
}

async function loadSettings() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  writeFormSettings(settings);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const appBookmarkResult = readAppBookmarks();
  if (appBookmarkResult.error) {
    fields.appBookmarks.focus();
    showStatus(appBookmarkResult.error, "error");
    return;
  }

  const workspaceResult = readWorkspaceLaunchGroups();
  if (workspaceResult.error) {
    fields.workspaceLaunchGroups.focus();
    showStatus(workspaceResult.error, "error");
    return;
  }

  const settings = readFormSettings(appBookmarkResult.bookmarks, workspaceResult.groups);

  if (!settings.serverBaseUrl) {
    fields.serverBaseUrl.focus();
    return;
  }

  if (!Number.isFinite(settings.syncIntervalMinutes) || settings.syncIntervalMinutes < 1) {
    fields.syncIntervalMinutes.focus();
    return;
  }

  void chrome.storage.sync.set(settings).then(() => {
    writeFormSettings(settings);
    showStatus("Saved");
  });
});

resetButton.addEventListener("click", () => {
  void chrome.storage.sync.set(DEFAULT_SETTINGS).then(() => {
    writeFormSettings(DEFAULT_SETTINGS);
    showStatus("Reset");
  });
});

statsButton.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("stats.html") });
});

void loadSettings();
