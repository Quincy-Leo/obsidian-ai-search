/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

// ---------------------------------------------------------------------------
// In-memory Vault + Plugin, standing in for the Obsidian host in tests
// ---------------------------------------------------------------------------
//
// Mapped from the real API:
//   vault.getFiles()                  -> TFile[]
//   vault.cachedRead(file)            -> Promise<string>
//   vault.getAbstractFileByPath(path) -> TFile | null
//   vault.adapter.write(path, data)   -> Promise<void>
//   workspace.getActiveFile()         -> TFile | null
//   workspace.getLeaf(newLeaf)        -> WorkspaceLeaf
//
// A file is just { path, basename, extension, __contents }, enough for src/.

require("./bootstrap");
const { LANGUAGE_OPTIONS, defaultSettings } = require("../../src/settings");

function makeFakeFile(filePath, contents = "") {
    const slash = filePath.lastIndexOf("/");
    const name = slash === -1 ? filePath : filePath.slice(slash + 1);
    const dot = name.lastIndexOf(".");
    return {
        path: filePath,
        name,
        basename: dot <= 0 ? name : name.slice(0, dot),
        extension: dot <= 0 ? "" : name.slice(dot + 1),
        __contents: contents,
    };
}

function makeFakeAdapter() {
    const files = new Map();
    return {
        files,
        async exists(p) { return files.has(p); },
        async read(p) {
            if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
            return files.get(p);
        },
        async write(p, data) { files.set(p, data); },
        async remove(p) { files.delete(p); },
    };
}

function makeFakePlugin(overrides = {}) {
    const adapter = overrides.adapter || makeFakeAdapter();
    const dataStore = { current: overrides.data === undefined ? null : overrides.data };
    const vaultFiles = overrides.files || [];
    const openedFiles = [];

    const plugin = {
        manifest: { id: "ai-search", dir: ".obsidian/plugins/ai-search" },
        settings: null,
        __aiSearchUnloaded: false,
        app: {
            vault: {
                adapter,
                getFiles() { return vaultFiles; },
                getAbstractFileByPath(p) {
                    return vaultFiles.find((file) => file.path === p) || null;
                },
                async cachedRead(file) {
                    if (overrides.readFails && overrides.readFails.has(file.path)) {
                        throw new Error(`read failed: ${file.path}`);
                    }
                    return file.__contents === null ? "" : file.__contents;
                },
            },
            workspace: {
                getActiveFile() {
                    return overrides.activeFile === undefined ? null : overrides.activeFile;
                },
                getActiveViewOfType() {
                    return overrides.activeView === undefined ? null : overrides.activeView;
                },
                getLeaf() {
                    return {
                        async openFile(file, state) { openedFiles.push({ file, state }); },
                    };
                },
            },
        },
        addCommand(spec) { this._command = spec; return spec; },
        addRibbonIcon(icon, title, cb) {
            this._ribbon = { icon, title, cb };
            return { setAttribute(key, value) { this[key] = value; } };
        },
        addSettingTab(tab) { this._settingTab = tab; },
        removeCommand(_id) { this._command = null; },
        async loadData() { return dataStore.current; },
        async saveData(data) { dataStore.current = JSON.parse(JSON.stringify(data)); },
        // Test hooks.
        _dataStore: dataStore,
        _openedFiles: openedFiles,
    };

    Object.defineProperty(plugin, "uiText", {
        get() {
            const language = plugin.settings && plugin.settings.language;
            return LANGUAGE_OPTIONS.find((option) => option.value === language)
                || LANGUAGE_OPTIONS[0];
        },
    });
    return plugin;
}

/** Plugin with the Jev preset configured (key included), for ai.js / search.js cases. */
function makeConfiguredPlugin(overrides = {}, settingsPatch = {}) {
    const plugin = makeFakePlugin(overrides);
    const settings = defaultSettings();
    settings.presets.jev.apiKey = "sk-test";
    plugin.settings = { ...settings, ...settingsPatch };
    return plugin;
}

module.exports = { makeFakeAdapter, makeFakeFile, makeFakePlugin, makeConfiguredPlugin };
