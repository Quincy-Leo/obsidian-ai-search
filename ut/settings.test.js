/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

require("./helpers/bootstrap");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
    LANGUAGE_OPTIONS,
    AiSearchSettings,
    AiSearchSettingTab,
    PRESET_JEV,
    PRESET_CUSTOM,
    JEV_PRESET_DEFAULTS,
    CUSTOM_PRESET_DEFAULTS,
    bilingualError,
    localizedText,
    normalizeLimit,
    normalizeThreshold,
    parseFolderList,
    parseExtensionList,
} = require("../src/settings");
const { makeFakePlugin } = require("./helpers/fakePlugin");

// --- UI copy --------------------------------------------------------------

test("bilingualError 合并所有语言的模板并填参数", () => {
    const message = bilingualError("settingsVersionTooNew", { actual: "2", expected: 1 });
    assert.ok(message.includes("ai-search：配置版本 2 高于插件支持的版本 1"), "zh line");
    assert.ok(message.includes("ai-search: settings version 2 is newer"), "en line");
    assert.equal(message.split("\n").length, LANGUAGE_OPTIONS.length);
});

test("localizedText 只用当前 uiText 里的模板", () => {
    const zh = LANGUAGE_OPTIONS.find((option) => option.value === "zh-CN");
    assert.equal(localizedText(zh.error, "missingApiKey"), "ai-search：请先在设置中填写模型密钥。");
});

test("两种语言的文案 key 完全一致", () => {
    const [zh, en] = LANGUAGE_OPTIONS;
    for (const group of ["notice", "error", "settingsText", "ui"]) {
        assert.deepEqual(Object.keys(zh[group]).sort(), Object.keys(en[group]).sort(),
            `${group} keys differ`);
    }
});

// --- Normalization --------------------------------------------------------

test("normalizeLimit: 空与非正数都变 null，正数取整", () => {
    assert.equal(normalizeLimit(""), null);
    assert.equal(normalizeLimit(null), null);
    assert.equal(normalizeLimit("abc"), null);
    assert.equal(normalizeLimit(0), null);
    assert.equal(normalizeLimit(-3), null);
    assert.equal(normalizeLimit("8"), 8);
    assert.equal(normalizeLimit(7.9), 7);
});

test("normalizeThreshold: 空回落 0.5，越界被夹到 0–1", () => {
    assert.equal(normalizeThreshold(""), 0.5);
    assert.equal(normalizeThreshold(null), 0.5);
    assert.equal(normalizeThreshold("  "), 0.5);
    assert.equal(normalizeThreshold("abc"), 0.5);
    assert.equal(normalizeThreshold(-1), 0);
    assert.equal(normalizeThreshold(3), 1);
    assert.equal(normalizeThreshold("0.8"), 0.8);
});

test("parseFolderList: 多行、去重、去掉根目录与空行", () => {
    const list = parseFolderList("笔记\n\n  项目/2026  \n/笔记/\n/\n./\n归档//子目录");
    assert.deepEqual(list, ["笔记", "项目/2026", "归档/子目录"]);
});

test("parseExtensionList: 逗号分隔、去点、小写、去重", () => {
    assert.deepEqual(parseExtensionList(" MD , .txt,md,, .MD "), ["md", "txt"]);
    assert.deepEqual(parseExtensionList(""), []);
});

// --- version field --------------------------------------------------------

test("load: 新装（loadData 返回 null）时写入全套默认值", async () => {
    const plugin = makeFakePlugin();
    const store = new AiSearchSettings(plugin);
    const value = await store.load();
    assert.equal(value.version, 1);
    assert.equal(value.language, "zh-CN");
    assert.equal(value.currentPreset, PRESET_JEV);
    assert.deepEqual(value.presets[PRESET_JEV], JEV_PRESET_DEFAULTS);
    assert.deepEqual(value.presets[PRESET_CUSTOM], CUSTOM_PRESET_DEFAULTS);
    assert.deepEqual(value.folders, { include: [], exclude: [], extensions: ["md", "txt"] });
});

test("load: 缺 version 字段直接抛错，错误含双语提示", async () => {
    const plugin = makeFakePlugin({ data: { language: "en" } });
    const store = new AiSearchSettings(plugin);
    await assert.rejects(() => store.load(), (error) => {
        assert.ok(error.message.includes("version"));
        assert.equal(error.message.split("\n").length, LANGUAGE_OPTIONS.length);
        return true;
    });
});

test("load: version 小于 1 报非法字段", async () => {
    const plugin = makeFakePlugin({ data: { version: 0 } });
    const store = new AiSearchSettings(plugin);
    await assert.rejects(() => store.load(), /非法|invalid/);
});

test("load: version 非整数也按非法字段处理", async () => {
    const plugin = makeFakePlugin({ data: { version: "1" } });
    const store = new AiSearchSettings(plugin);
    await assert.rejects(() => store.load(), /非法|invalid/);
});

test("load: version 大于 1 报配置版本高于插件版本", async () => {
    const plugin = makeFakePlugin({ data: { version: 2 } });
    const store = new AiSearchSettings(plugin);
    await assert.rejects(() => store.load(), /高于|newer/);
});

test("load: 非法 language / currentPreset 回退到默认值", async () => {
    const plugin = makeFakePlugin({
        data: { version: 1, language: "fr-FR", currentPreset: "nope" },
    });
    const store = new AiSearchSettings(plugin);
    const value = await store.load();
    assert.equal(value.language, "zh-CN");
    assert.equal(value.currentPreset, PRESET_JEV);
});

test("save: 磁盘上是旧版本时先备份 .bak 再写新文件", async () => {
    const plugin = makeFakePlugin();
    const store = new AiSearchSettings(plugin);
    await store.load();
    // Simulate the on-disk file being swapped for an older version after load.
    plugin._dataStore.current = { version: 0, language: "en" };
    await store.setLanguage("en");
    const backup = plugin.app.vault.adapter.files.get(".obsidian/plugins/ai-search/data.json.bak");
    assert.ok(backup, "应写出 data.json.bak");
    assert.deepEqual(JSON.parse(backup), { version: 0, language: "en" });
    assert.equal(plugin._dataStore.current.version, 1);
    assert.equal(plugin._dataStore.current.language, "en");
});

test("save: 磁盘上是更高版本时拒绝写入", async () => {
    const plugin = makeFakePlugin();
    const store = new AiSearchSettings(plugin);
    await store.load();
    plugin._dataStore.current = { version: 2 };
    await assert.rejects(() => store.setLanguage("en"), /高于|newer/);
    // After a rejected write the in-memory value rolls back to what is on disk.
    assert.equal(plugin._dataStore.current.version, 2);
});

// --- Per-preset storage ---------------------------------------------------

test("updatePreset 只改当前预设，另一个预设原样保留", async () => {
    const plugin = makeFakePlugin();
    const store = new AiSearchSettings(plugin);
    await store.load();
    await store.updatePreset({ baseUrl: "https://example.test/", model: "x-1" });
    assert.equal(store.value.presets[PRESET_JEV].baseUrl, "https://example.test");
    assert.deepEqual(store.value.presets[PRESET_CUSTOM], CUSTOM_PRESET_DEFAULTS);

    await store.setCurrentPreset(PRESET_CUSTOM);
    assert.equal(store.preset.baseUrl, "");
    await store.updatePreset({ baseUrl: "http://127.0.0.1:8000", maxConcurrentRequests: "4" });
    assert.equal(store.value.presets[PRESET_CUSTOM].maxConcurrentRequests, 4);
    // Switch back; the Jev preset still holds its own values.
    await store.setCurrentPreset(PRESET_JEV);
    assert.equal(store.preset.model, "x-1");
    assert.equal(store.preset.maxConcurrentRequests, JEV_PRESET_DEFAULTS.maxConcurrentRequests);
});

test("预设在 data.json 里各存一个子对象", async () => {
    const plugin = makeFakePlugin();
    const store = new AiSearchSettings(plugin);
    await store.load();
    await store.updatePreset({ apiKey: "sk-jev" });
    const saved = plugin._dataStore.current;
    assert.deepEqual(Object.keys(saved.presets).sort(), [PRESET_CUSTOM, PRESET_JEV].sort());
    assert.equal(saved.presets[PRESET_JEV].apiKey, "sk-jev");
    assert.equal(saved.presets[PRESET_CUSTOM].apiKey, "");
});

test("resetCurrentPreset 只重置当前预设", async () => {
    const plugin = makeFakePlugin();
    const store = new AiSearchSettings(plugin);
    await store.load();
    await store.updatePreset({ apiKey: "sk-jev", model: "changed" });
    await store.setCurrentPreset(PRESET_CUSTOM);
    await store.updatePreset({ apiKey: "sk-custom" });
    await store.resetCurrentPreset();
    assert.deepEqual(store.value.presets[PRESET_CUSTOM], CUSTOM_PRESET_DEFAULTS);
    assert.equal(store.value.presets[PRESET_JEV].apiKey, "sk-jev");
});

test("resetFolders / resetAll 恢复默认值", async () => {
    const plugin = makeFakePlugin();
    const store = new AiSearchSettings(plugin);
    await store.load();
    await store.updateFolders({ include: ["a"], exclude: ["b"], extensions: ["org"] });
    await store.setLanguage("en");
    await store.resetFolders();
    assert.deepEqual(store.value.folders, { include: [], exclude: [], extensions: ["md", "txt"] });
    assert.equal(store.value.language, "en", "重置目录不碰语言");

    await store.updatePreset({ apiKey: "sk-x" });
    await store.resetAll();
    assert.equal(store.value.language, "zh-CN");
    assert.equal(store.value.presets[PRESET_JEV].apiKey, "");
});

test("setLanguage 合法值写盘并触发 onChanged；非法值无副作用", async () => {
    const plugin = makeFakePlugin();
    let changed = 0;
    const store = new AiSearchSettings(plugin, () => { changed += 1; });
    await store.load();
    await store.setLanguage("fr-FR");
    assert.equal(changed, 0);
    await store.setLanguage("en");
    assert.equal(changed, 1);
    assert.equal(plugin._dataStore.current.language, "en");
});

// --- Settings tab ---------------------------------------------------------

function settingsOf(tab) {
    return tab.containerEl.children;
}

test("display 渲染语言、AI、目录三组设置和三个重置按钮", async () => {
    const plugin = makeFakePlugin();
    const store = new AiSearchSettings(plugin);
    await store.load();
    const tab = new AiSearchSettingTab(plugin.app, store);
    tab.display();

    const names = settingsOf(tab).map((setting) => setting.name);
    const text = store.uiText.settingsText;
    for (const expected of [
        text.languageName, text.aiHeading, text.presetName, text.baseUrlName,
        text.modelName, text.apiKeyName, text.concurrencyName,
        text.tokensPerRequestName, text.tokensPerQuestionName, text.requestsPerSecondName,
        text.tokensPerSecondName, text.thresholdName, text.resetAiName,
        text.folderHeading, text.includeName, text.excludeName,
        text.extensionsName, text.resetFoldersName, text.resetAllName,
    ]) {
        assert.ok(names.includes(expected), `missing setting: ${expected}`);
    }
    // The base URL description spells out the actual request path.
    const baseUrlSetting = settingsOf(tab).find((s) => s.name === text.baseUrlName);
    assert.ok(baseUrlSetting.desc.includes("/v1/systemone"));
});

test("display: Jev 预设显示硬编码默认值，切到自定义后只清空接入信息", async () => {
    const plugin = makeFakePlugin();
    const store = new AiSearchSettings(plugin);
    await store.load();
    const tab = new AiSearchSettingTab(plugin.app, store);
    tab.display();

    const text = store.uiText.settingsText;
    const valueOf = (name) => settingsOf(tab)
        .find((setting) => setting.name === name).components[0].value;
    assert.equal(valueOf(text.baseUrlName), JEV_PRESET_DEFAULTS.baseUrl);
    assert.equal(valueOf(text.modelName), JEV_PRESET_DEFAULTS.model);
    assert.equal(valueOf(text.apiKeyName), "");
    assert.equal(valueOf(text.concurrencyName), "8");
    assert.equal(valueOf(text.tokensPerRequestName), "64000");
    assert.equal(valueOf(text.tokensPerQuestionName), "32000");
    assert.equal(valueOf(text.requestsPerSecondName), "80");
    assert.equal(valueOf(text.tokensPerSecondName), "100000");
    assert.equal(valueOf(text.thresholdName), String(JEV_PRESET_DEFAULTS.relevanceThreshold));

    const presetDropdown = settingsOf(tab)
        .find((setting) => setting.name === text.presetName).components[0];
    await presetDropdown.simulate(PRESET_CUSTOM);
    // The custom preset cannot know which service is behind it, so base URL,
    // model and key are left blank for the user; rate limits and the threshold
    // still get usable defaults rather than empty values.
    assert.equal(valueOf(text.baseUrlName), "");
    assert.equal(valueOf(text.modelName), "");
    assert.equal(valueOf(text.apiKeyName), "");
    assert.equal(valueOf(text.concurrencyName),
        String(CUSTOM_PRESET_DEFAULTS.maxConcurrentRequests));
    assert.equal(valueOf(text.requestsPerSecondName),
        String(CUSTOM_PRESET_DEFAULTS.maxRequestsPerSecond));
    assert.equal(valueOf(text.thresholdName),
        String(CUSTOM_PRESET_DEFAULTS.relevanceThreshold));
});

test("display: 非法数值输入被拒绝并提示，不写盘", async () => {
    const bootstrap = require("./helpers/bootstrap");
    const plugin = makeFakePlugin();
    const store = new AiSearchSettings(plugin);
    await store.load();
    const tab = new AiSearchSettingTab(plugin.app, store);
    tab.display();
    const text = store.uiText.settingsText;
    const field = settingsOf(tab)
        .find((setting) => setting.name === text.concurrencyName).components[0];

    bootstrap.resetNotices();
    // The input is debounced, so call the underlying callback to test validation.
    await field._onChange("-1");
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(store.preset.maxConcurrentRequests, 8, "非法输入不应改掉原值");
    assert.ok(bootstrap.lastNotice().message.includes(text.concurrencyName));

    await field._onChange("3");
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(store.preset.maxConcurrentRequests, 3);
    tab.dispose();
});

test("重置按钮调用对应的 settings 方法", async () => {
    const plugin = makeFakePlugin();
    const store = new AiSearchSettings(plugin);
    await store.load();
    await store.updatePreset({ apiKey: "sk-x" });
    await store.updateFolders({ include: ["a"] });
    const tab = new AiSearchSettingTab(plugin.app, store);
    tab.display();
    const text = store.uiText.settingsText;
    const buttonOf = (name) => settingsOf(tab)
        .find((setting) => setting.name === name).components[0];

    await buttonOf(text.resetAiName).simulate();
    assert.equal(store.preset.apiKey, "");
    assert.deepEqual(store.value.folders.include, ["a"], "重置 AI 不碰目录");

    await buttonOf(text.resetFoldersName).simulate();
    assert.deepEqual(store.value.folders.include, []);
    tab.dispose();
});
