/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

const bootstrap = require("./helpers/bootstrap");
const test = require("node:test");
const assert = require("node:assert/strict");

const { AiSearchModal } = require("../src/window");
const {
    STATUS_IDLE,
    STATUS_RUNNING,
    STATUS_DONE,
    STATUS_ABORTED,
    STATUS_ERROR,
    emptyState,
} = require("../src/search");
const { makeConfiguredPlugin, makeFakeFile } = require("./helpers/fakePlugin");

// --- Test helpers ---------------------------------------------------------

function descendants(el) {
    const out = [];
    for (const child of el.children || []) {
        out.push(child);
        out.push(...descendants(child));
    }
    return out;
}

function tagsOf(el, tag) {
    return descendants(el).filter((child) => child.tag === tag);
}

function textsOf(el) {
    return descendants(el).map((child) => child.text).filter((text) => text !== "");
}

/** Implements only the controller API window.js consumes, so rendering can be checked alone. */
function makeStubController(patch = {}) {
    const listeners = new Set();
    return {
        state: { ...emptyState(), ...patch },
        calls: [],
        onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        listenerCount: () => listeners.size,
        emit(next) {
            if (next) this.state = { ...this.state, ...next };
            for (const listener of [...listeners]) listener(this.state);
        },
        setQuery(text) {
            this.calls.push(["setQuery", text]);
            this.state = { ...this.state, query: text };
        },
        searchCurrentFile() { this.calls.push(["searchCurrentFile"]); },
        searchVault() { this.calls.push(["searchVault"]); },
        abort() { this.calls.push(["abort"]); },
    };
}

function openModal(controllerPatch = {}, pluginOverrides = {}) {
    const plugin = makeConfiguredPlugin(pluginOverrides);
    const controller = makeStubController(controllerPatch);
    const modal = new AiSearchModal(plugin, controller);
    modal.open();
    return { plugin, controller, modal };
}

// --- Layout ---------------------------------------------------------------

test("打开弹窗: 去掉关闭按钮，输入框在左、两个搜索按钮在右", () => {
    const { modal } = openModal();
    assert.equal(modal.modalEl.querySelector(".modal-header-button"), null,
        "需求要求没有关闭按钮");
    assert.equal(modal.modalEl.querySelector(".modal-close-button"), null,
        "老版本 Obsidian 的关闭按钮也要删掉");
    const row = modal.contentEl.children[0];
    assert.equal(row.children[0].tag, "input");
    const buttons = tagsOf(row, "button");
    assert.deepEqual(buttons.map((button) => button.text), ["搜本文", "搜全库"]);
    assert.equal(row.children[row.children.length - 1].text, "搜全库",
        "搜全库在最右侧");
});

test("打开弹窗: 上下不留额外空白，整行高度等于按钮高度", () => {
    const { modal } = openModal();
    const header = modal.modalEl.querySelector(".modal-header");
    assert.equal(header.style.display, "none", "空标题栏会撑出一行空白");
    assert.equal(modal.contentEl.style.padding, "0", "上下留白只由 .modal 提供");
    assert.equal(modal.modalEl.style.minHeight, "0", "min-height 会在搜索框下留白");
    // The input defaults to taller than the buttons (.prompt-input is 40px, buttons use
    // --input-height); pinning both to one height keeps the row from growing.
    const row = modal.contentEl.children[0];
    assert.equal(row.style.height, "var(--input-height)");
    assert.equal(modal._inputEl.style.height, "var(--input-height)");
});

test("打开弹窗: 输入框恢复上次的内容并聚焦", () => {
    const { modal } = openModal({ query: "上次的搜索词" });
    assert.equal(modal._inputEl.value, "上次的搜索词");
    assert.equal(modal._inputEl.focused, true);
    assert.deepEqual(modal._inputEl.selection, [6, 6]);
});

test("关闭弹窗: 退订监听但不动 controller 状态", () => {
    const { modal, controller } = openModal({ query: "保留我", status: STATUS_DONE });
    assert.equal(controller.listenerCount(), 1);
    modal.close();
    assert.equal(controller.listenerCount(), 0);
    assert.equal(controller.state.query, "保留我");
    assert.equal(controller.state.status, STATUS_DONE);
});

// --- Interaction ----------------------------------------------------------

test("输入框: input 事件把内容同步给 controller", () => {
    const { modal, controller } = openModal();
    modal._inputEl.value = "梯次利用";
    modal._inputEl.dispatch("input");
    assert.deepEqual(controller.calls, [["setQuery", "梯次利用"]]);
});

test("输入框: 回车视为「搜本文」，输入法组字中的回车不触发", () => {
    const { modal, controller } = openModal({ query: "q" });
    modal._inputEl.dispatch("keydown", { key: "Enter", isComposing: true });
    assert.deepEqual(controller.calls, []);
    modal._inputEl.dispatch("keydown", { key: "a" });
    assert.deepEqual(controller.calls, []);
    modal._inputEl.dispatch("keydown", { key: "Enter" });
    assert.deepEqual(controller.calls, [["searchCurrentFile"]]);
});

test("输入框: shift+回车视为「搜全库」", () => {
    const { modal, controller } = openModal({ query: "q" });
    modal._inputEl.dispatch("keydown", { key: "Enter", shiftKey: true });
    assert.deepEqual(controller.calls, [["searchVault"]]);
});

test("输入框: ctrl/cmd/alt + 回车一律不响应", () => {
    const { modal, controller } = openModal({ query: "q" });
    for (const modifier of ["ctrlKey", "metaKey", "altKey"]) {
        modal._inputEl.dispatch("keydown", { key: "Enter", [modifier]: true });
        // Combining with shift is no exception: any of these modifiers voids the key.
        modal._inputEl.dispatch("keydown", { key: "Enter", shiftKey: true, [modifier]: true });
    }
    assert.deepEqual(controller.calls, []);
});

test("两个按钮分别触发搜本文与搜全库，并各自带快捷键提示", () => {
    const { modal, controller } = openModal({ query: "q" });
    const buttons = tagsOf(modal.contentEl.children[0], "button");
    assert.deepEqual(buttons.map((button) => button.tooltip),
        ["搜本文（Enter）", "搜全库（Shift+Enter）"]);
    buttons[0].dispatch("click");
    buttons[1].dispatch("click");
    assert.deepEqual(controller.calls, [["searchCurrentFile"], ["searchVault"]]);
});

// --- Progress bar ---------------------------------------------------------

test("进度条: 空闲时不显示", () => {
    const { modal } = openModal();
    assert.equal(modal._progressEl.style.display, "none");
    assert.equal(modal._progressEl.children.length, 0);
});

test("进度条: 搜索中显示「终止」按钮、进度条和百分比", () => {
    const { modal, controller } = openModal({ query: "q" });
    controller.emit({ status: STATUS_RUNNING, progress: { completed: 3, total: 8 } });
    assert.equal(modal._progressEl.style.display, "flex");
    const buttons = tagsOf(modal._progressEl, "button");
    assert.deepEqual(buttons.map((button) => button.text), ["终止"]);
    assert.ok(textsOf(modal._progressEl).includes("3/8（37%）"));
    const track = modal._progressEl.querySelector("ai-search-progress-track");
    assert.equal(track.children[0].style.width, "37%");

    buttons[0].dispatch("click");
    assert.deepEqual(controller.calls, [["abort"]]);
});

test("进度条: 还在统计工作量时显示「正在搜索」", () => {
    const { modal, controller } = openModal({ query: "q" });
    controller.emit({ status: STATUS_RUNNING, progress: { completed: 0, total: 0 } });
    assert.ok(textsOf(modal._progressEl).includes("正在搜索……"));
});

test("进度条: 搜索结束后不再显示", () => {
    const { modal, controller } = openModal({ query: "q" });
    controller.emit({ status: STATUS_RUNNING, progress: { completed: 1, total: 2 } });
    controller.emit({ status: STATUS_DONE, progress: { completed: 2, total: 2 } });
    assert.equal(modal._progressEl.style.display, "none");
});

// --- Search results -------------------------------------------------------

const RESULTS = [
    { path: "笔记/电池.md", basename: "电池", line: 4, text: "退役电池重新分组后装进基站备电", score: 0.98 },
    { path: "笔记/储能.md", basename: "储能", line: 0, text: "家庭储能柜的容量与成本", score: 0.73 },
];

test("结果: 搜索中不展示，结束后展示", () => {
    const { modal, controller } = openModal({ query: "q" });
    controller.emit({ status: STATUS_RUNNING, results: RESULTS });
    assert.equal(modal._resultsEl.style.display, "none");
    controller.emit({ status: STATUS_DONE, results: RESULTS });
    assert.equal(modal._resultsEl.style.display, "block");
});

test("结果: 每条第一行是加粗小字文件名加百分比，第二块是两行正文", () => {
    const { modal, controller } = openModal({ query: "q" });
    controller.emit({ status: STATUS_DONE, results: RESULTS });

    const items = descendants(modal._resultsEl)
        .filter((child) => child.classes.has("ai-search-result"));
    assert.equal(items.length, 2);

    const [header, body] = items[0].children;
    assert.equal(header.children[0].text, "电池");
    assert.equal(header.children[0].style.fontWeight, "var(--font-bold)");
    assert.equal(header.children[0].style.fontSize, "var(--font-ui-smaller)");
    assert.equal(header.children[1].text, "98%");
    assert.equal(body.text, "退役电池重新分组后装进基站备电");
    assert.equal(body.style["-webkit-line-clamp"], "2", "正文截断成两行");
    assert.equal(items[1].children[1].text, "家庭储能柜的容量与成本");
});

test("结果: 顶部显示条数；结果区可滚动", () => {
    const { modal, controller } = openModal({ query: "q" });
    controller.emit({ status: STATUS_DONE, results: RESULTS });
    assert.ok(textsOf(modal._resultsEl).includes("2 个相关段落"));
    assert.equal(modal._resultsEl.style.overflowY, "auto");
    assert.equal(modal._resultsEl.style.maxHeight, "50vh");
});

test("结果: 没有命中时给一句提示", () => {
    const { modal, controller } = openModal({ query: "q" });
    controller.emit({ status: STATUS_DONE, results: [] });
    assert.ok(textsOf(modal._resultsEl).includes("没有找到相关段落。"));
});

test("结果: 出错且无结果时写出错原因而不是「没有找到」", () => {
    const { modal, controller } = openModal({ query: "q" });
    controller.emit({
        status: STATUS_ERROR,
        results: [],
        errorMessage: "ai-search：鉴权失败（HTTP 401）；请检查模型密钥。",
    });
    const texts = textsOf(modal._resultsEl);
    assert.ok(texts.some((text) => text.includes("鉴权失败")));
    assert.ok(!texts.includes("没有找到相关段落。"));
});

test("结果: 终止后的部分结果也会展示", () => {
    const { modal, controller } = openModal({ query: "q" });
    controller.emit({ status: STATUS_ABORTED, results: [RESULTS[0]] });
    assert.equal(modal._resultsEl.style.display, "block");
    assert.ok(textsOf(modal._resultsEl).includes("电池"));
});

test("结果: 点击后打开文件、跳到对应行并关掉弹窗", async () => {
    const file = makeFakeFile("笔记/电池.md", "正文");
    const editorCalls = [];
    const view = {
        editor: {
            setCursor(position) { editorCalls.push(["setCursor", position]); },
            scrollIntoView(range, center) { editorCalls.push(["scrollIntoView", range, center]); },
        },
    };
    const { modal, plugin } = openModal(
        { query: "q", status: STATUS_DONE, results: RESULTS },
        { files: [file], activeView: view },
    );
    const item = descendants(modal._resultsEl)
        .find((child) => child.classes.has("ai-search-result"));
    item.dispatch("click");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(modal.closed, true, "点结果后弹窗消失");
    assert.equal(plugin._openedFiles.length, 1);
    assert.equal(plugin._openedFiles[0].file.path, "笔记/电池.md");
    assert.deepEqual(plugin._openedFiles[0].state, { eState: { line: 4 } });
    assert.deepEqual(editorCalls[0], ["setCursor", { line: 4, ch: 0 }]);
});

test("结果: 文件已不存在时提示而不是静默失败", async () => {
    const { modal } = openModal(
        { query: "q", status: STATUS_DONE, results: RESULTS },
        { files: [] },
    );
    bootstrap.resetNotices();
    const item = descendants(modal._resultsEl)
        .find((child) => child.classes.has("ai-search-result"));
    item.dispatch("click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(bootstrap.lastNotice().message.includes("笔记/电池.md"));
    assert.equal(modal.closed, false);
});

test("结果: 英文界面下按钮与提示也跟着切换", () => {
    const plugin = makeConfiguredPlugin();
    plugin.settings.language = "en";
    const controller = makeStubController({ query: "q", status: STATUS_DONE, results: [] });
    const modal = new AiSearchModal(plugin, controller);
    modal.open();
    const buttons = tagsOf(modal.contentEl.children[0], "button");
    assert.deepEqual(buttons.map((button) => button.text), ["This note", "Whole vault"]);
    assert.ok(textsOf(modal._resultsEl).includes("No relevant passage found."));
    assert.equal(modal._inputEl.placeholder, "Type what to search for…");
});
