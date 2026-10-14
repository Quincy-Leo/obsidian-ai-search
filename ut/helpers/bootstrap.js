/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

// ---------------------------------------------------------------------------
// Test environment setup
// ---------------------------------------------------------------------------
//
// Goal: let modules under src/ be required and called in a plain Node process
// (no Obsidian host, no browser DOM). Same strategy as resize-pics -- replace
// every missing runtime dependency with a minimal fake:
//
//   1. `obsidian` is a runtime module provided by the host and not installed
//      here, so Module._resolveFilename is patched to make
//      `require("obsidian")` hit the test stub.
//   2. The DOM is a just-enough subset built by createFakeEl (createDiv /
//      createEl / addEventListener / style), which makes window.js rendering
//      and clicks testable.
//   3. requestUrl is injected per case to simulate HTTP status codes and
//      response bodies.
//
// Each test file only needs `require("./helpers/bootstrap")` at the top.
// This file is idempotent: repeated requires install the stubs once.

const Module = require("node:module");
const path = require("node:path");

if (globalThis.__aiSearchBootstrapped) {
    module.exports = globalThis.__aiSearchBootstrap;
    return;
}
globalThis.__aiSearchBootstrapped = true;

// --- Notice collector -----------------------------------------------------
// Lets tests assert on notice text without mocking the Notice class itself.
const noticeLog = [];

class Notice {
    constructor(message, duration) {
        this.message = message;
        this.duration = duration;
        noticeLog.push({ message, duration });
    }
}

// --- DOM stub -------------------------------------------------------------

/**
 * Subset of Obsidian's DOM helpers. Implements only the members src/ actually
 * uses, plus test hooks such as `dispatch` / `findByText`.
 */
function createFakeEl(tag = "div") {
    const el = {
        tag,
        children: [],
        parent: null,
        classes: new Set(),
        text: "",
        attrs: {},
        listeners: new Map(),
        value: "",
        placeholder: "",
        type: "",
        rows: 0,
        style: makeFakeStyle(),
    };

    const attach = (child, opts) => {
        if (opts) {
            if (opts.text !== undefined) child.text = String(opts.text);
            if (opts.cls) {
                for (const name of String(opts.cls).split(/\s+/)) {
                    if (name) child.classes.add(name);
                }
            }
            if (opts.attr && typeof opts.attr === "object") {
                Object.assign(child.attrs, opts.attr);
            }
        }
        child.parent = el;
        el.children.push(child);
        return child;
    };

    el.createDiv = (opts) => attach(createFakeEl("div"), opts);
    el.createSpan = (opts) => attach(createFakeEl("span"), opts);
    el.createEl = (childTag, opts) => attach(createFakeEl(childTag), opts);
    el.empty = () => {
        for (const child of el.children) child.parent = null;
        el.children = [];
    };
    el.remove = () => {
        if (!el.parent) return;
        const index = el.parent.children.indexOf(el);
        if (index !== -1) el.parent.children.splice(index, 1);
        el.parent = null;
    };
    el.setText = (value) => { el.text = String(value); };
    el.addClass = (name) => { el.classes.add(name); };
    el.removeClass = (name) => { el.classes.delete(name); };
    el.hasClass = (name) => el.classes.has(name);
    el.setAttribute = (key, value) => { el.attrs[key] = value; };
    el.getAttribute = (key) => el.attrs[key];
    el.focus = () => { el.focused = true; };
    el.setSelectionRange = (start, end) => { el.selection = [start, end]; };
    el.addEventListener = (type, handler) => {
        if (!el.listeners.has(type)) el.listeners.set(type, []);
        el.listeners.get(type).push(handler);
    };
    el.removeEventListener = (type, handler) => {
        const list = el.listeners.get(type) || [];
        const index = list.indexOf(handler);
        if (index !== -1) list.splice(index, 1);
    };
    /** Test hook: fire every handler registered for an event type. */
    el.dispatch = (type, event = {}) => {
        for (const handler of [...(el.listeners.get(type) || [])]) {
            handler({ preventDefault() {}, stopPropagation() {}, ...event });
        }
    };
    /** Test hook: find an element in the subtree by class name. */
    el.querySelector = (selector) => {
        const wanted = String(selector).replace(/^\./, "");
        for (const child of el.children) {
            if (child.classes.has(wanted) || child.tag === wanted) return child;
            const nested = child.querySelector(selector);
            if (nested) return nested;
        }
        return null;
    };
    return el;
}

function makeFakeStyle() {
    const style = {};
    style.setProperty = (name, value) => { style[name] = value; };
    style.getPropertyValue = (name) => style[name];
    style.removeProperty = (name) => { delete style[name]; };
    return style;
}

// --- obsidian stub --------------------------------------------------------
// Only the members referenced from src/. Each Setting control exposes
// inspectable state so tests can assert which fields the settings tab rendered
// and what their defaults are.

class Plugin {
    constructor(app, manifest) {
        this.app = app || {};
        this.manifest = manifest || {};
    }
    addCommand(spec) { return spec; }
    addRibbonIcon(_icon, _title, _cb) { return createFakeEl("div"); }
    addSettingTab(_tab) {}
    removeCommand(_id) {}
    async loadData() { return null; }
    async saveData(_data) {}
}

class MarkdownView {}

class PluginSettingTab {
    constructor(app, plugin) {
        this.app = app;
        this.plugin = plugin;
        this.containerEl = createFakeEl("div");
    }
}

class Modal {
    constructor(app) {
        this.app = app;
        this.modalEl = createFakeEl("div");
        this.modalEl.classes.add("modal");
        // Mirror the real Modal structure: close button, header, content area.
        // window.js removes the close button and hides an empty header.
        this.modalEl.createDiv({ cls: "modal-header-button" });
        this.headerEl = this.modalEl.createDiv({ cls: "modal-header" });
        this.titleEl = this.headerEl.createDiv({ cls: "modal-title" });
        this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
        this.opened = false;
        this.closed = false;
    }
    open() {
        this.opened = true;
        this.closed = false;
        if (typeof this.onOpen === "function") this.onOpen();
    }
    close() {
        this.closed = true;
        this.opened = false;
        if (typeof this.onClose === "function") this.onClose();
    }
}

class FakeValueComponent {
    constructor(inputEl) {
        this.inputEl = inputEl;
        this.value = "";
        this.placeholder = "";
    }
    setValue(value) { this.value = value; this.inputEl.value = value; return this; }
    getValue() { return this.value; }
    setPlaceholder(text) { this.placeholder = text; this.inputEl.placeholder = text; return this; }
    setDisabled(flag) { this.disabled = flag; return this; }
    onChange(cb) { this._onChange = cb; return this; }
    /** Test hook: simulate user input. */
    simulate(next) {
        this.value = next;
        this.inputEl.value = next;
        return this._onChange ? this._onChange(next) : undefined;
    }
}

class FakeDropdown {
    constructor() { this.options = []; this.value = null; }
    addOption(value, label) { this.options.push({ value, label }); return this; }
    setValue(value) { this.value = value; return this; }
    onChange(cb) { this._onChange = cb; return this; }
    simulate(next) {
        this.value = next;
        return this._onChange ? this._onChange(next) : undefined;
    }
}

class FakeButton {
    setButtonText(text) { this.text = text; return this; }
    setDisabled(flag) { this.disabled = flag; return this; }
    setWarning() { this.warning = true; return this; }
    setTooltip(text) { this.tooltip = text; return this; }
    onClick(cb) { this._onClick = cb; return this; }
    simulate() { return this._onClick ? this._onClick() : undefined; }
}

class Setting {
    constructor(containerEl) {
        this.containerEl = containerEl;
        this.descEl = createFakeEl("div");
        this.name = "";
        this.desc = "";
        this.heading = false;
        this.components = [];
        containerEl.children.push(this);
    }
    setName(value) { this.name = value; return this; }
    setDesc(value) { this.desc = value; return this; }
    setHeading() { this.heading = true; return this; }
    addText(cb) {
        const component = new FakeValueComponent(createFakeEl("input"));
        this.components.push(component);
        cb(component);
        return this;
    }
    addTextArea(cb) {
        const component = new FakeValueComponent(createFakeEl("textarea"));
        this.components.push(component);
        cb(component);
        return this;
    }
    addDropdown(cb) {
        const component = new FakeDropdown();
        this.components.push(component);
        cb(component);
        return this;
    }
    addButton(cb) {
        const component = new FakeButton();
        this.components.push(component);
        cb(component);
        return this;
    }
}

/** The real impl sets a native tooltip; here it is recorded on the element. */
function setTooltip(el, text) {
    if (el) el.tooltip = text;
}

function normalizePath(p) {
    // Mirror Obsidian's behaviour just enough: collapse `//`, strip trailing `/`.
    return String(p).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

// requestUrl is injected per case. The default throws to flag a case that
// forgot to install a stub.
let requestUrlImpl = async () => { throw new Error("requestUrl not stubbed"); };
function setRequestUrl(fn) { requestUrlImpl = fn; }
async function requestUrl(options) { return requestUrlImpl(options); }

const obsidianStub = {
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    Modal,
    MarkdownView,
    setTooltip,
    normalizePath,
    requestUrl,
};

// Patch Module resolver: `require("obsidian")` -> test stub. Other names
// resolve as usual.
const originalResolve = Module._resolveFilename;
const OBSIDIAN_STUB_ID = path.join(__dirname, "__obsidian_stub__.js");
require.cache[OBSIDIAN_STUB_ID] = {
    id: OBSIDIAN_STUB_ID,
    filename: OBSIDIAN_STUB_ID,
    loaded: true,
    exports: obsidianStub,
    children: [],
    paths: [],
};
Module._resolveFilename = function patched(request, parent, ...rest) {
    if (request === "obsidian") return OBSIDIAN_STUB_ID;
    return originalResolve.call(this, request, parent, ...rest);
};

// --- Exported hooks -------------------------------------------------------
const api = {
    obsidian: obsidianStub,
    noticeLog,
    resetNotices() { noticeLog.length = 0; },
    lastNotice() { return noticeLog.length === 0 ? null : noticeLog[noticeLog.length - 1]; },
    setRequestUrl,
    createFakeEl,
};
globalThis.__aiSearchBootstrap = api;
module.exports = api;
