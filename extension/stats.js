const GET_TAB_SWITCH_STATS_MESSAGE = "tabcoach:get-tab-switch-stats";

const elements = {
  meta: document.getElementById("meta"),
  refreshButton: document.getElementById("refreshButton"),
  settingsButton: document.getElementById("settingsButton"),
  totalSwitches: document.getElementById("totalSwitches"),
  todaySwitches: document.getElementById("todaySwitches"),
  sevenDaySwitches: document.getElementById("sevenDaySwitches"),
  averageSwitchesPerDay: document.getElementById("averageSwitchesPerDay"),
  totalTrackedFocusTime: document.getElementById("totalTrackedFocusTime"),
  todayTopTimeByDomain: document.getElementById("todayTopTimeByDomain"),
  todayTopTargetDomains: document.getElementById("todayTopTargetDomains"),
  todayTopRoutes: document.getElementById("todayTopRoutes"),
  topTimeByDomain: document.getElementById("topTimeByDomain"),
  lastSevenDays: document.getElementById("lastSevenDays"),
  topTargetDomains: document.getElementById("topTargetDomains"),
  topRoutes: document.getElementById("topRoutes"),
  topSources: document.getElementById("topSources"),
  recentSwitches: document.getElementById("recentSwitches")
};

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function assertResponse(response, fallbackMessage) {
  if (!response?.ok) {
    throw new Error(response?.error || fallbackMessage);
  }

  return response;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function formatAverage(value) {
  const number = Number(value) || 0;
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: number >= 10 ? 0 : 1
  }).format(number);
}

function formatDuration(value) {
  const totalMinutes = Math.max(0, Math.round((Number(value) || 0) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${minutes}m`;
  }

  return `${hours}h ${minutes}m`;
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "-";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatDayLabel(value) {
  const date = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(date.getTime())) {
    return value || "-";
  }

  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric"
  }).format(date);
}

function clearAndAppendEmpty(container, message, className = "empty") {
  container.replaceChildren();
  const empty = document.createElement("div");
  empty.className = className;
  empty.textContent = message;
  container.appendChild(empty);
}

function renderRankList(container, items) {
  container.replaceChildren();
  const safeItems = Array.isArray(items) ? items : [];

  if (safeItems.length === 0) {
    clearAndAppendEmpty(container, "No data yet");
    return;
  }

  const maxCount = Math.max(...safeItems.map((item) => Number(item.count) || 0), 1);
  safeItems.forEach((item) => {
    const row = document.createElement("div");
    row.className = "rank-row";

    const label = document.createElement("div");
    label.className = "rank-label";
    label.textContent = item.label || "(unknown)";
    label.title = label.textContent;

    const count = document.createElement("div");
    count.className = "rank-count";
    count.textContent = formatNumber(item.count);

    const bar = document.createElement("div");
    bar.className = "bar";

    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = `${Math.max(4, ((Number(item.count) || 0) / maxCount) * 100)}%`;

    bar.appendChild(fill);
    row.append(label, count, bar);
    container.appendChild(row);
  });
}

function renderDurationList(container, items) {
  container.replaceChildren();
  const safeItems = Array.isArray(items) ? items : [];

  if (safeItems.length === 0) {
    clearAndAppendEmpty(container, "No data yet");
    return;
  }

  const maxDuration = Math.max(...safeItems.map((item) => Number(item.durationMs) || 0), 1);
  safeItems.forEach((item) => {
    const row = document.createElement("div");
    row.className = "duration-row";

    const label = document.createElement("div");
    label.className = "duration-label";
    label.textContent = item.label || "(unknown)";
    label.title = label.textContent;

    const duration = document.createElement("div");
    duration.className = "duration-value";
    duration.textContent = formatDuration(item.durationMs);

    const bar = document.createElement("div");
    bar.className = "bar";

    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = `${Math.max(4, ((Number(item.durationMs) || 0) / maxDuration) * 100)}%`;

    bar.appendChild(fill);
    row.append(label, duration, bar);
    container.appendChild(row);
  });
}

function renderDayList(container, items) {
  container.replaceChildren();
  const safeItems = Array.isArray(items) ? items : [];

  if (safeItems.length === 0) {
    clearAndAppendEmpty(container, "No data yet");
    return;
  }

  const maxCount = Math.max(...safeItems.map((item) => Number(item.count) || 0), 1);
  safeItems.forEach((item) => {
    const row = document.createElement("div");
    row.className = "day-row";

    const label = document.createElement("div");
    label.className = "day-label";
    label.textContent = formatDayLabel(item.date);

    const count = document.createElement("div");
    count.className = "day-count";
    count.textContent = formatNumber(item.count);

    const bar = document.createElement("div");
    bar.className = "bar";

    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = `${Math.max(4, ((Number(item.count) || 0) / maxCount) * 100)}%`;

    bar.appendChild(fill);
    row.append(label, count, bar);
    container.appendChild(row);
  });
}

function createRecentColumn(title, domain) {
  const column = document.createElement("div");
  column.className = "recent-tab";

  const titleElement = document.createElement("div");
  titleElement.className = "recent-title";
  titleElement.textContent = title || "(unknown)";
  titleElement.title = titleElement.textContent;

  const domainElement = document.createElement("div");
  domainElement.className = "domain";
  domainElement.textContent = domain || "(unknown)";

  column.append(titleElement, domainElement);
  return column;
}

function renderRecentSwitches(container, items) {
  container.replaceChildren();
  const safeItems = Array.isArray(items) ? items : [];

  if (safeItems.length === 0) {
    clearAndAppendEmpty(container, "No switches logged yet");
    return;
  }

  safeItems.forEach((item) => {
    const row = document.createElement("div");
    row.className = "recent-row";

    const time = document.createElement("div");
    time.className = "recent-time";
    time.textContent = formatDateTime(item.switchedAt);

    const from = createRecentColumn(item.fromTitle, item.fromDomain);
    const to = createRecentColumn(item.toTitle, item.toDomain);

    const duration = document.createElement("div");
    duration.className = "recent-duration";
    duration.textContent = item.ignoredIdle
      ? "idle"
      : item.durationMs === null || item.durationMs === undefined
        ? "active"
        : formatDuration(item.durationMs);
    duration.title = "Estimated time spent before the next switch";

    const source = document.createElement("div");
    source.className = "recent-source";
    source.textContent = item.source || "unknown";
    source.title = source.textContent;

    row.append(time, from, to, duration, source);
    container.appendChild(row);
  });
}

function renderStats(stats) {
  elements.totalSwitches.textContent = formatNumber(stats.totalSwitches);
  elements.todaySwitches.textContent = formatNumber(stats.todaySwitches);
  elements.sevenDaySwitches.textContent = formatNumber(stats.sevenDaySwitches);
  elements.averageSwitchesPerDay.textContent = formatAverage(stats.averageSwitchesPerDay7d);
  elements.totalTrackedFocusTime.textContent = formatDuration(stats.totalTrackedFocusTimeMs);
  elements.meta.textContent = `Generated ${formatDateTime(stats.generatedAt)} from ${stats.logPath || "tab switch log"}`;

  renderDurationList(elements.todayTopTimeByDomain, stats.todayTopTimeByDomain);
  renderRankList(elements.todayTopTargetDomains, stats.todayTopTargetDomains);
  renderRankList(elements.todayTopRoutes, stats.todayTopRoutes);
  renderDurationList(elements.topTimeByDomain, stats.topTimeByDomain);
  renderDayList(elements.lastSevenDays, stats.lastSevenDays);
  renderRankList(elements.topTargetDomains, stats.topTargetDomains);
  renderRankList(elements.topRoutes, stats.topRoutes);
  renderRankList(elements.topSources, stats.topSources);
  renderRecentSwitches(elements.recentSwitches, stats.recentSwitches);
}

async function loadStats() {
  elements.refreshButton.disabled = true;
  elements.meta.textContent = "Loading";

  try {
    const response = await sendMessage({ type: GET_TAB_SWITCH_STATS_MESSAGE }).then((result) =>
      assertResponse(result, "Could not load tab movement stats")
    );
    renderStats(response.stats || {});
  } catch (error) {
    elements.meta.textContent = "Could not load stats";
    clearAndAppendEmpty(elements.todayTopTimeByDomain, "No data", "empty");
    clearAndAppendEmpty(elements.todayTopTargetDomains, "No data", "empty");
    clearAndAppendEmpty(elements.todayTopRoutes, "No data", "empty");
    clearAndAppendEmpty(elements.topTimeByDomain, "No data", "empty");
    clearAndAppendEmpty(elements.lastSevenDays, "No data", "empty");
    clearAndAppendEmpty(elements.topTargetDomains, error instanceof Error ? error.message : String(error), "error");
    clearAndAppendEmpty(elements.topRoutes, "No data", "empty");
    clearAndAppendEmpty(elements.topSources, "No data", "empty");
    clearAndAppendEmpty(elements.recentSwitches, "No data", "empty");
  } finally {
    elements.refreshButton.disabled = false;
  }
}

elements.refreshButton.addEventListener("click", () => {
  void loadStats();
});

elements.settingsButton.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

void loadStats();
