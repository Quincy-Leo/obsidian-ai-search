/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

const { Notice, Plugin, setTooltip } = require("obsidian");
const {
    LANGUAGE_OPTIONS,
    NOTICE_DURATION_MS,
    AiSearchSettings,
    AiSearchSettingTab,
    errorText,
} = require("./settings");
const { SearchController } = require("./search");
const { AiSearchModal } = require("./window");

const PLUGIN_VERSION = "0.1.0";
const SEARCH_COMMAND_ID = "ai-search";
const RIBBON_ICON_ID = "scan-search";

class AiSearchPlugin extends Plugin {
    constructor(...args) {
        super(...args);
        this.settings = null;
        this.settingsStore = null;
        this.searchController = null;
        this.searchCommand = null;
        this.ribbonIconEl = null;
        this.modal = null;
        this.__aiSearchUnloaded = false;
        this._settingTabs = new Set();
        this.openSearch = () => {
            this.openSearchModal();
        };
    }

    async onload() {
        this.__aiSearchUnloaded = false;
        this.settingsStore = new AiSearchSettings(this, () => {
            this.settings = this.settingsStore.value;
            this.refreshLocalizedEntryLabels();
        });

        try {
            this.settings = await this.settingsStore.load();
        } catch (error) {
            // Unsupported settings version (missing version / below 1 / above 1):
            // refuse to load. Skipping the command, ribbon icon and setting tab
            // avoids running on settings we cannot read and overwriting them.
            // Notice duration 0 means it never auto-dismisses.
            console.error("ai-search: refusing to load", error);
            new Notice(errorText(error), 0);
            return;
        }

        this.searchController = new SearchController(this);

        this.searchCommand = this.addCommand({
            id: SEARCH_COMMAND_ID,
            name: this.uiText.commandName,
            callback: this.openSearch,
        });

        this.ribbonIconEl = this.addRibbonIcon(
            RIBBON_ICON_ID,
            this.uiText.ribbonTitle,
            this.openSearch,
        );
        if (this.ribbonIconEl && typeof setTooltip === "function") {
            setTooltip(this.ribbonIconEl, this.uiText.ribbonTitle);
        }

        const settingTab = new AiSearchSettingTab(this.app, this.settingsStore);
        this._settingTabs.add(settingTab);
        this.addSettingTab(settingTab);

        console.log(`ai-search ${PLUGIN_VERSION} loaded`);
    }

    onunload() {
        if (this.__aiSearchUnloaded) return;
        // Invalidate the lifecycle before touching async resources: in-flight
        // searches read this flag to decide whether to keep writing state or
        // showing notices.
        this.__aiSearchUnloaded = true;

        for (const tab of this._settingTabs) {
            if (tab && typeof tab.dispose === "function") tab.dispose();
        }
        this._settingTabs.clear();
        if (this.__aiSearchSettingTabs instanceof Set) {
            for (const tab of this.__aiSearchSettingTabs) {
                if (tab && typeof tab.dispose === "function") tab.dispose();
            }
        }

        if (this.modal) {
            try {
                this.modal.close();
            } catch (error) {
                console.error("ai-search: failed to close the search modal", error);
            }
            this.modal = null;
        }

        if (this.searchController) {
            this.searchController.dispose();
            this.searchController = null;
        }
        this.ribbonIconEl = null;
    }

    get uiText() {
        return this.settingsStore
            ? this.settingsStore.uiText
            : LANGUAGE_OPTIONS[0];
    }

    /**
     * The command name and ribbon tooltip are localized, so a language change
     * requires re-registering them. removeCommand is missing on some versions;
     * fall back to patching the name field there.
     */
    refreshLocalizedEntryLabels() {
        if (this.searchCommand) {
            if (typeof this.removeCommand === "function") {
                this.removeCommand(SEARCH_COMMAND_ID);
                this.searchCommand = this.addCommand({
                    id: SEARCH_COMMAND_ID,
                    name: this.uiText.commandName,
                    callback: this.openSearch,
                });
            } else {
                this.searchCommand.name = this.uiText.commandName;
            }
        }
        if (this.ribbonIconEl) {
            if (typeof setTooltip === "function") {
                setTooltip(this.ribbonIconEl, this.uiText.ribbonTitle);
            }
            this.ribbonIconEl.setAttribute("aria-label", this.uiText.ribbonTitle);
        }
    }

    /**
     * Opens the search modal. Every call builds a fresh Modal instance, but the
     * state lives on SearchController, so reopening shows exactly what was
     * there before it was dismissed.
     */
    openSearchModal() {
        if (this.__aiSearchUnloaded || !this.searchController) return;
        try {
            const modal = new AiSearchModal(this, this.searchController);
            this.modal = modal;
            modal.open();
            return modal;
        } catch (error) {
            console.error("ai-search: failed to open the search modal", error);
            const raw = errorText(error);
            const message = /^ai-search[:：]/.test(raw) ? raw : `ai-search: ${raw}`;
            new Notice(message, NOTICE_DURATION_MS);
            return null;
        }
    }
}

// Default export loaded by the Obsidian plugin runtime.
module.exports = AiSearchPlugin;

// Named export used by the Node unit tests.
module.exports.AiSearchPlugin = AiSearchPlugin;
