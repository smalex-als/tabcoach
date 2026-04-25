const DEFAULT_SETTINGS = {
  serverBaseUrl: "http://127.0.0.1:3847",
  autoCloseDuplicates: true,
  docsGrouping: true,
  fetchDiagnostics: true,
  syncIntervalMinutes: 1,
  badgeMode: "both"
};

const form = document.getElementById("settingsForm");
const status = document.getElementById("status");
const resetButton = document.getElementById("resetButton");
const fields = {
  serverBaseUrl: document.getElementById("serverBaseUrl"),
  autoCloseDuplicates: document.getElementById("autoCloseDuplicates"),
  docsGrouping: document.getElementById("docsGrouping"),
  fetchDiagnostics: document.getElementById("fetchDiagnostics"),
  syncIntervalMinutes: document.getElementById("syncIntervalMinutes"),
  badgeMode: document.getElementById("badgeMode")
};

let statusTimer = null;

function showStatus(message) {
  status.textContent = message;
  if (statusTimer !== null) {
    clearTimeout(statusTimer);
  }

  statusTimer = setTimeout(() => {
    statusTimer = null;
    status.textContent = "";
  }, 1800);
}

function sanitizeServerBaseUrl(value) {
  return value.trim().replace(/\/+$/, "");
}

function readFormSettings() {
  return {
    serverBaseUrl: sanitizeServerBaseUrl(fields.serverBaseUrl.value),
    autoCloseDuplicates: fields.autoCloseDuplicates.checked,
    docsGrouping: fields.docsGrouping.checked,
    fetchDiagnostics: fields.fetchDiagnostics.checked,
    syncIntervalMinutes: Number(fields.syncIntervalMinutes.value),
    badgeMode: fields.badgeMode.value
  };
}

function writeFormSettings(settings) {
  fields.serverBaseUrl.value = settings.serverBaseUrl;
  fields.autoCloseDuplicates.checked = Boolean(settings.autoCloseDuplicates);
  fields.docsGrouping.checked = Boolean(settings.docsGrouping);
  fields.fetchDiagnostics.checked = Boolean(settings.fetchDiagnostics);
  fields.syncIntervalMinutes.value = String(settings.syncIntervalMinutes);
  fields.badgeMode.value = settings.badgeMode;
}

async function loadSettings() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  writeFormSettings(settings);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const settings = readFormSettings();

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

void loadSettings();
