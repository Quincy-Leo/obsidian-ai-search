/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

// ---------------------------------------------------------------------------
// Search modal
// ---------------------------------------------------------------------------
//
// Pure view layer: all state lives on SearchController in search.js, this file
// only subscribes to changes and repaints. So closing and reopening the modal
// shows exactly what was there before, and closing it never cancels a search.
//
// Styles are inline rather than in styles.css -- same as resize-pics, the build
// output is only main.js + manifest.json, no extra style file to copy.

const { MarkdownView, Modal, Notice, setTooltip } = require("obsidian");
const { NOTICE_DURATION_MS, localizedText } = require("./settings");
const { STATUS_IDLE, STATUS_RUNNING } = require("./search");

// Results area caps out at this height; beyond it a scrollbar appears.
const RESULTS_MAX_HEIGHT = "50vh";

// Shared height for the search box and the buttons. Matching them makes the row
// exactly as tall as a button, so the only padding above and below is .modal's
// own -- the same width as the gap on the right.
const CONTROL_HEIGHT = "var(--input-height)";

class AiSearchModal extends Modal {
    /**
     * @param {import("obsidian").Plugin} plugin
     * @param {import("./search").SearchController} controller
     */
    constructor(plugin, controller) {
        super(plugin.app);
        this.plugin = plugin;
        this.controller = controller;
        this._unsubscribe = null;
        this._inputEl = null;
        this._progressEl = null;
        this._resultsEl = null;
    }

    get uiText() {
        return this.plugin.uiText;
    }

    onOpen() {
        // By design the modal has no close button; clicking outside dismisses it
        // (Modal closes on backdrop click by default). The close button's class
        // changed across Obsidian versions (modal-header-button on newer,
        // modal-close-button on older), so check both.
        for (const selector of [".modal-header-button", ".modal-close-button"]) {
            const button = this.modalEl.querySelector(selector);
            if (button) button.remove();
        }
        // setTitle is never called, so the header is empty, but its margin-bottom
        // still leaves a blank row above the search box. Hide the whole thing.
        const header = this.modalEl.querySelector(".modal-header");
        if (header) header.style.display = "none";
        this.modalEl.addClass("ai-search-modal");
        this.modalEl.style.width = "min(760px, 90vw)";
        // .modal ships min-height: 100px, but the idle state is a single search
        // row, and .modal-content's flex-grow eats the surplus height as blank
        // space below the box. Size to content instead; results grow it anyway.
        this.modalEl.style.minHeight = "0";

        this.contentEl.empty();
        // No extra vertical padding; .modal's own 16px is enough -- matches the
        // horizontal gap.
        this.contentEl.style.padding = "0";
        this._buildSearchRow(this.contentEl);
        this._progressEl = this.contentEl.createDiv({ cls: "ai-search-progress" });
        this._progressEl.style.display = "none";
        this._progressEl.style.alignItems = "center";
        this._progressEl.style.gap = "0.6em";
        this._progressEl.style.marginTop = "0.8em";
        this._resultsEl = this.contentEl.createDiv({ cls: "ai-search-results" });
        this._resultsEl.style.maxHeight = RESULTS_MAX_HEIGHT;
        this._resultsEl.style.overflowY = "auto";
        this._resultsEl.style.marginTop = "0.8em";

        this._unsubscribe = this.controller.onChange(() => this.render());
        this.render();

        // Caret goes to the end of the input, so the previous query is easy to
        // edit.
        this._inputEl.focus();
        const caret = this._inputEl.value.length;
        try {
            this._inputEl.setSelectionRange(caret, caret);
        } catch (_) {
            // Some input types do not support the selection API; ignore.
        }
    }

    onClose() {
        if (this._unsubscribe) this._unsubscribe();
        this._unsubscribe = null;
        // Tear down the DOM only, leave controller state alone -- the next open
        // has to restore it as-is.
        this.contentEl.empty();
        this._inputEl = null;
        this._progressEl = null;
        this._resultsEl = null;
    }

    /**
     * Input on the far left, "search current note" then "search whole vault"
     * at the right.
     */
    _buildSearchRow(parent) {
        const ui = this.uiText.ui;
        const row = parent.createDiv({ cls: "ai-search-row" });
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.gap = "0.5em";
        row.style.height = CONTROL_HEIGHT;

        const input = row.createEl("input", { cls: "prompt-input" });
        input.type = "text";
        input.placeholder = ui.placeholder;
        input.value = this.controller.state.query;
        input.style.flex = "1 1 auto";
        input.style.minWidth = "0";
        // .prompt-input is designed for the full-width box in the quick switcher:
        // 40px tall with 24px padding all round. In this row it would out-grow
        // the buttons and stretch the row, padding the buttons top and bottom.
        // Clamp it to the button height and shrink padding to normal input size.
        input.style.height = CONTROL_HEIGHT;
        input.style.padding = "0 var(--size-4-2)";
        input.addEventListener("input", () => {
            // By design, any edit to the input (added or deleted) drops the
            // previous results.
            this.controller.setQuery(input.value);
        });
        input.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" || event.isComposing) return;
            // Ignore Ctrl/Cmd/Alt + Enter: reserved for future shortcuts, and it
            // keeps a mistyped combo from firing a search.
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            event.preventDefault();
            if (event.shiftKey) void this.controller.searchVault();
            else void this.controller.searchCurrentFile();
        });
        this._inputEl = input;

        const fileButton = row.createEl("button", { text: ui.searchFile });
        fileButton.style.flex = "0 0 auto";
        // Shortcuts are documented in the tooltip only; button labels stay short.
        setTooltip(fileButton, ui.searchFileTooltip);
        fileButton.addEventListener("click", () => {
            void this.controller.searchCurrentFile();
        });

        const vaultButton = row.createEl("button", { text: ui.searchVault });
        vaultButton.style.flex = "0 0 auto";
        setTooltip(vaultButton, ui.searchVaultTooltip);
        vaultButton.addEventListener("click", () => {
            void this.controller.searchVault();
        });
    }

    render() {
        if (!this._progressEl || !this._resultsEl) return;
        const state = this.controller.state;
        this._renderProgress(state);
        this._renderResults(state);
    }

    /**
     * Only visible while a search runs: cancel button on the left, progress bar
     * and percentage on the right.
     */
    _renderProgress(state) {
        const row = this._progressEl;
        row.empty();
        if (state.status !== STATUS_RUNNING) {
            row.style.display = "none";
            return;
        }
        row.style.display = "flex";

        const ui = this.uiText.ui;
        const abortButton = row.createEl("button", { text: ui.abort });
        abortButton.style.flex = "0 0 auto";
        abortButton.addEventListener("click", () => this.controller.abort());

        const { completed, total } = state.progress;
        const track = row.createDiv({ cls: "ai-search-progress-track" });
        track.style.flex = "1 1 auto";
        track.style.height = "6px";
        track.style.borderRadius = "3px";
        track.style.background = "var(--background-modifier-border)";
        track.style.overflow = "hidden";

        const percent = total > 0 ? Math.floor((completed / total) * 100) : 0;
        const fill = track.createDiv();
        fill.style.height = "100%";
        fill.style.width = `${percent}%`;
        fill.style.background = "var(--interactive-accent)";
        fill.style.transition = "width 120ms linear";

        const label = row.createDiv({
            // total 0 means we are still counting what to search, so all we can
            // show is a plain "running" line.
            text: total > 0
                ? localizedText(ui, "progress", { completed, total, percent })
                : ui.running,
        });
        label.style.flex = "0 0 auto";
        label.style.fontSize = "var(--font-ui-smaller)";
        label.style.color = "var(--text-muted)";
    }

    /** Results only show once the search ends; while running, just the bar. */
    _renderResults(state) {
        const container = this._resultsEl;
        container.empty();
        if (state.status === STATUS_RUNNING || state.status === STATUS_IDLE) {
            container.style.display = "none";
            return;
        }
        container.style.display = "block";

        const ui = this.uiText.ui;
        if (state.results.length === 0) {
            // On an error with zero results, the error reason is more accurate
            // than "no results".
            const empty = container.createDiv({
                text: state.errorMessage ? state.errorMessage : ui.noResults,
            });
            empty.style.padding = "0.6em 0.2em";
            empty.style.color = "var(--text-muted)";
            empty.style.fontSize = "var(--font-ui-smaller)";
            return;
        }

        const count = container.createDiv({
            text: localizedText(ui, "resultCount", { count: state.results.length }),
        });
        count.style.padding = "0 0.2em 0.4em";
        count.style.color = "var(--text-muted)";
        count.style.fontSize = "var(--font-ui-smaller)";

        for (const result of state.results) {
            this._renderResultItem(container, result);
        }
    }

    _renderResultItem(container, result) {
        const item = container.createDiv({ cls: "ai-search-result" });
        item.style.padding = "0.5em 0.4em";
        item.style.borderTop = "1px solid var(--background-modifier-border)";
        item.style.cursor = "pointer";
        item.addEventListener("mouseenter", () => {
            item.style.background = "var(--background-modifier-hover)";
        });
        item.addEventListener("mouseleave", () => {
            item.style.background = "";
        });
        item.addEventListener("click", () => {
            void this._openResult(result);
        });
        setTooltip(item, result.path);

        // First line: bold small file name + relevance score percentage.
        const header = item.createDiv();
        header.style.display = "flex";
        header.style.alignItems = "baseline";
        header.style.gap = "0.5em";
        const name = header.createDiv({ text: result.basename });
        name.style.fontWeight = "var(--font-bold)";
        name.style.fontSize = "var(--font-ui-smaller)";
        name.style.flex = "1 1 auto";
        name.style.overflow = "hidden";
        name.style.textOverflow = "ellipsis";
        name.style.whiteSpace = "nowrap";
        const score = header.createDiv({ text: `${Math.round(result.score * 100)}%` });
        score.style.flex = "0 0 auto";
        score.style.fontSize = "var(--font-ui-smaller)";
        score.style.color = "var(--text-muted)";

        // Next two lines: the matched passage. CSS clamps the overflow, the body
        // text itself is untouched.
        const body = item.createDiv({ text: result.text });
        body.style.marginTop = "0.15em";
        body.style.fontSize = "var(--font-ui-small)";
        body.style.lineHeight = "1.4";
        body.style.overflow = "hidden";
        body.style.setProperty("display", "-webkit-box");
        body.style.setProperty("-webkit-line-clamp", "2");
        body.style.setProperty("-webkit-box-orient", "vertical");
    }

    /**
     * Clicking a result opens the file, puts the caret on the matched line,
     * then closes the modal.
     */
    async _openResult(result) {
        const file = this.app.vault.getAbstractFileByPath(result.path);
        if (!file) {
            new Notice(localizedText(this.uiText.error, "readFailed", { path: result.path }),
                NOTICE_DURATION_MS);
            return;
        }
        this.close();
        try {
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(file, { eState: { line: result.line } });
            // eState does not scroll in some views, so position explicitly too.
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            const editor = view && view.editor;
            if (editor) {
                const position = { line: result.line, ch: 0 };
                editor.setCursor(position);
                editor.scrollIntoView({ from: position, to: position }, true);
            }
        } catch (error) {
            console.error("ai-search: failed to open", result.path, error);
            new Notice(localizedText(this.uiText.error, "readFailed", { path: result.path }),
                NOTICE_DURATION_MS);
        }
    }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
    AiSearchModal,
};
