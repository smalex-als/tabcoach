import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const switcher = readFileSync(new URL("../extension/tab-switcher.js", import.meta.url), "utf8");

// Load the actual extension functions without starting its browser event listeners.
function loadFunctions(source, names, globals) {
  const context = vm.createContext(globals);
  for (const name of names) {
    const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"));
    assert.ok(match, `Missing function ${name}`);
    vm.runInContext(match[0], context);
  }
  return context;
}

function makeBrowser(specs) {
  const tabs = specs.map((tab, index) => ({ groupId: -1, pinned: false, windowId: 7, ...tab, index }));
  const moves = [];
  function move(ids, index) {
    const moving = ids.map((id) => tabs.find((tab) => tab.id === id));
    const remaining = tabs.filter((tab) => !ids.includes(tab.id));
    // A move must not split a group or cross the pinned boundary.
    assert.ok(!remaining[index - 1] || !remaining[index] || remaining[index].groupId === -1 ||
      remaining[index - 1].groupId !== remaining[index].groupId);
    remaining.splice(index, 0, ...moving);
    tabs.splice(0, tabs.length, ...remaining);
    tabs.forEach((tab, position) => { tab.index = position; });
    const firstUnpinned = tabs.findIndex((tab) => !tab.pinned);
    assert.ok(firstUnpinned === -1 || tabs.slice(firstUnpinned).every((tab) => !tab.pinned));
    moves.push({ ids, index });
  }
  const chrome = {
    tabs: {
      query: async ({ windowId, groupId }) => tabs
        .filter((tab) => tab.windowId === windowId && (groupId === undefined || tab.groupId === groupId))
        .map((tab) => ({ ...tab })),
      move: async (ids, { index }) => move(Array.isArray(ids) ? ids : [ids], index)
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      move: async (groupId, { index }) => move(tabs.filter((tab) => tab.groupId === groupId).map((tab) => tab.id), index)
    }
  };
  const context = loadFunctions(background, ["getSwitcherContextWindowId", "sortUngroupedTabsFromSwitcher", "sortGroupTabsFromSwitcher"], {
    chrome,
    collectTabSwitcherItems: async () => tabs.map((tab) => ({ ...tab })),
    getValidatedGroupInSwitcherWindow: async (groupId) => ({ group: { id: groupId }, windowId: 7 })
  });
  return { ...context, tabs, moves };
}

test("sorts a window with no groups", async () => {
  const browser = makeBrowser([{ id: 1 }, { id: 2 }, { id: 3 }]);
  await browser.sortUngroupedTabsFromSwitcher([3, 1, 2], { windowId: 7 });
  assert.deepEqual(browser.tabs.map((tab) => tab.id), [3, 1, 2]);
});

test("preserves group slots, contents and other windows", async () => {
  const browser = makeBrowser([
    { id: 1 }, { id: 10, groupId: 5 }, { id: 11, groupId: 5 },
    { id: 2 }, { id: 20, groupId: 6 }, { id: 21, groupId: 6 }, { id: 3 }
  ]);
  browser.tabs.push({ id: 99, windowId: 8, groupId: -1, pinned: false, index: 0 });
  await browser.sortUngroupedTabsFromSwitcher([3, 2, 1], { windowId: 7 });
  assert.deepEqual(browser.tabs.map((tab) => tab.id), [3, 10, 11, 2, 20, 21, 1, 99]);
  assert.deepEqual(browser.tabs.map((tab) => tab.groupId), [-1, 5, 5, -1, 6, 6, -1, -1]);
});

test("sorts pinned and unpinned tabs separately", async () => {
  const browser = makeBrowser([{ id: 1, pinned: true }, { id: 2, pinned: true }, { id: 3 }, { id: 4 }]);
  await browser.sortUngroupedTabsFromSwitcher([2, 1, 4, 3], { windowId: 7 });
  assert.deepEqual(browser.tabs.map((tab) => tab.id), [2, 1, 4, 3]);
});

test("rejects stale, foreign, grouped, duplicate and invalid tab orders before moving", async () => {
  for (const order of [[1], [1, 99], [1, 10], [1, 1], [1, "2"], [2, 1]]) {
    const browser = makeBrowser([{ id: 1, pinned: true }, { id: 10, groupId: 5 }, { id: 2 }]);
    await assert.rejects(browser.sortUngroupedTabsFromSwitcher(order, { windowId: 7 }));
    assert.equal(browser.moves.length, 0);
  }
});

test("requires a valid target window", async () => {
  for (const context of [{}, { windowId: -1 }, { windowId: 1.5 }]) {
    const browser = makeBrowser([{ id: 1 }]);
    await assert.rejects(browser.sortUngroupedTabsFromSwitcher([1], context));
    assert.equal(browser.moves.length, 0);
  }
});

test("already sorted, empty and single-tab scopes perform no moves", async () => {
  for (const ids of [[], [1], [1, 2]]) {
    const browser = makeBrowser(ids.map((id) => ({ id })));
    await browser.sortUngroupedTabsFromSwitcher(ids, { windowId: 7 });
    assert.equal(browser.moves.length, 0);
  }
});

test("existing group sorting still stays within that group", async () => {
  const browser = makeBrowser([{ id: 1 }, { id: 10, groupId: 5 }, { id: 11, groupId: 5 }, { id: 2 }]);
  await browser.sortGroupTabsFromSwitcher(5, [11, 10], { windowId: 7 });
  assert.deepEqual(browser.tabs.map((tab) => tab.id), [1, 11, 10, 2]);
});

test("UI sort scope includes hidden tabs and uses natural title ordering with pinned tabs first", () => {
  const tabs = [
    { id: 1, title: "Page 10", pinned: true }, { id: 2, title: "Page 2", pinned: true },
    { id: 3, title: "zebra", group: { id: 5 } }, { id: 4, title: "apple", group: { id: 5 } },
    { id: 5, title: "Page 10" }, { id: 6, title: "page 2" }
  ];
  const ui = loadFunctions(switcher, ["getTabsInSortScope", "isSortScopeSortedByTitle", "getTabSortKey", "compareTabsByTitle"], {
    tabs, visibleTabs: [tabs[0]], formatTabTitle: (tab) => tab.title
  });
  assert.deepEqual(Array.from(ui.getTabsInSortScope(), (tab) => tab.id), [1, 2, 5, 6]);
  assert.deepEqual(Array.from(ui.getTabsInSortScope(5), (tab) => tab.id), [3, 4]);
  assert.deepEqual(Array.from(ui.getTabsInSortScope().sort(ui.compareTabsByTitle), (tab) => tab.id), [2, 1, 6, 5]);
  assert.equal(ui.isSortScopeSortedByTitle(), false);
  assert.equal(ui.isSortScopeSortedByTitle(5), false);
  assert.equal(ui.isSortScopeSortedByTitle(9), true);
});

test("UI dispatches the appropriate sort and shows window order while preserving selection", async () => {
  for (const groupId of [null, 5]) {
    const messages = [];
    const tabs = [{ id: 1, title: "Zebra" }, { id: 2, title: "Apple" }]
      .map((tab) => ({ ...tab, group: groupId === null ? null : { id: groupId } }));
    const noop = () => {};
    const ui = loadFunctions(switcher, ["getTabsInSortScope", "getTabSortKey", "compareTabsByTitle", "sortTabsByTitle"], {
      tabs, sortMode: "recent", selectedIndex: 1,
      SORT_GROUP_TABS_MESSAGE: "group-sort", SORT_UNGROUPED_TABS_MESSAGE: "ungrouped-sort",
      formatTabTitle: (tab) => tab.title,
      getSelectedTabId: () => 1,
      sendMessage: async (message) => { messages.push(message); return { tabs }; },
      assertResponse: (response) => response,
      setTabs: noop, refreshDuplicateCounts: noop, refreshVisibleTabs: noop, renderTabs: noop,
      getRowIndexForTabOrGroup: (id) => id === 1 ? 2 : 0,
      getRowIndexForGroupId: () => 0,
      applyRowState: noop, showShortcutNotification: noop, pluralizeCount: () => "2 tabs"
    });
    await ui.sortTabsByTitle(groupId);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, groupId === null ? "ungrouped-sort" : "group-sort");
    assert.equal(messages[0].groupId, groupId);
    assert.deepEqual(Array.from(messages[0].tabIds), [2, 1]);
    assert.equal(ui.sortMode, "window");
    assert.equal(ui.selectedIndex, 2);
  }
});
