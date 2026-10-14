/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

const bootstrap = require("./helpers/bootstrap");
const test = require("node:test");
const assert = require("node:assert/strict");

const AiSearchPlugin = require("../src/main");
const { LANGUAGE_OPTIONS } = require("../src/settings");
const { makeFakePlugin, makeFakeFile } = require("./helpers/fakePlugin");

/** Builds a real AiSearchPlugin instance on top of a fake host. */
function makePlugin(overrides = {}) {
    const host = makeFakePlugin(overrides);
    const plugin = new AiSearchPlugin(host.app, host.manifest);
    plugin.loadData = host.loadData;
    plugin.saveData = host.saveData;
    plugin._dataStore = host._dataStore;
    plugin._host = host;
    plugin.addCommand = (spec) => { plugin._command = spec; return spec; };
    plugin.addRibbonIcon = (icon, title, callback) => {
        plugin._ribbon = { icon, title, callback };
        return bootstrap.createFakeEl("div");
    };
    plugin.addSettingTab = (tab) => { plugin._settingTab = tab; };
    plugin.removeCommand = (id) => { plugin._removedCommand = id; plugin._command = null; };
    return plugin;
}

test("onload: 注册 ai-search 命令、scan-search 图标和设置页", async () => {
    const plugin = makePlugin();
    await plugin.onload();
    assert.equal(plugin._command.id, "ai-search");
    assert.equal(plugin._command.name, "AI 模糊搜索");
    assert.equal(plugin._ribbon.icon, "scan-search");
    assert.equal(plugin._ribbon.title, "AI 模糊搜索");
    assert.ok(plugin._settingTab, "应注册设置页");
    assert.ok(plugin.searchController, "应创建 SearchController");
    assert.equal(plugin.settings.version, 1);
    plugin.onunload();
});

test("onload: 配置版本高于插件版本时拒绝加载", async () => {
    const plugin = makePlugin({ data: { version: 2 } });
    bootstrap.resetNotices();
    await plugin.onload();
    assert.equal(plugin._command, undefined, "不注册命令");
    assert.equal(plugin._ribbon, undefined, "不注册 ribbon 图标");
    assert.equal(plugin._settingTab, undefined, "不注册设置页");
    assert.equal(plugin.searchController, null);
    const notice = bootstrap.lastNotice();
    assert.ok(notice.message.includes("高于"));
    assert.equal(notice.duration, 0, "加载失败的提示不自动消失");
});

test("onload: 配置里 version 非法时同样拒绝加载", async () => {
    const plugin = makePlugin({ data: { version: 0, language: "en" } });
    await plugin.onload();
    assert.equal(plugin._command, undefined);
    assert.equal(plugin.searchController, null);
});

test("切换语言后命令名和 ribbon 提示跟着变", async () => {
    const plugin = makePlugin();
    await plugin.onload();
    const english = LANGUAGE_OPTIONS.find((option) => option.value === "en");
    await plugin.settingsStore.setLanguage("en");
    assert.equal(plugin._removedCommand, "ai-search");
    assert.equal(plugin._command.name, english.commandName);
    assert.equal(plugin.ribbonIconEl.aria_label || plugin.ribbonIconEl.attrs["aria-label"],
        english.ribbonTitle);
    plugin.onunload();
});

test("命令和 ribbon 的回调都打开同一个弹窗，状态在两次打开之间保留", async () => {
    const plugin = makePlugin({ files: [makeFakeFile("a.md", "一行足够长的正文内容")] });
    await plugin.onload();

    const first = plugin.openSearchModal();
    first._inputEl.value = "梯次利用";
    first._inputEl.dispatch("input");
    first.close();
    assert.equal(plugin.searchController.state.query, "梯次利用");

    // The command and the ribbon share one callback.
    assert.equal(plugin._command.callback, plugin._ribbon.callback);
    plugin._command.callback();
    assert.equal(plugin.modal._inputEl.value, "梯次利用", "重新打开时内容不变");
    plugin.onunload();
});

test("onunload: 关掉弹窗、dispose controller，且可重复调用", async () => {
    const plugin = makePlugin();
    await plugin.onload();
    const modal = plugin.openSearchModal();
    const tab = plugin._settingTab;
    plugin.onunload();
    assert.equal(modal.closed, true);
    assert.equal(plugin.searchController, null);
    assert.equal(plugin.__aiSearchUnloaded, true);
    assert.equal(tab._disposed, true);
    // A second call must not throw.
    plugin.onunload();
});

test("卸载后再触发命令不会打开弹窗", async () => {
    const plugin = makePlugin();
    await plugin.onload();
    const callback = plugin._command.callback;
    plugin.onunload();
    callback();
    assert.equal(plugin.modal, null);
});
