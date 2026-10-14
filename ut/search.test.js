/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

const bootstrap = require("./helpers/bootstrap");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
    SearchController,
    RateLimiter,
    STATUS_IDLE,
    STATUS_RUNNING,
    STATUS_DONE,
    STATUS_ABORTED,
    STATUS_ERROR,
    splitIntoUnits,
    looksBinary,
    isPathUnder,
    matchesFolders,
    hasAllowedExtension,
    collectFiles,
    chunkUnits,
    batchTokenBudget,
    baseNameOf,
} = require("../src/search");
const { AiRequestError } = require("../src/ai");
const { makeConfiguredPlugin, makeFakeFile } = require("./helpers/fakePlugin");

// --- Text splitting -------------------------------------------------------

test("splitIntoUnits: 每行一个单元，行号是 0 基", () => {
    const units = splitIntoUnits("第一行足够长的正文内容\n第二行也足够长的正文内容");
    assert.deepEqual(units, [
        { line: 0, text: "第一行足够长的正文内容" },
        { line: 1, text: "第二行也足够长的正文内容" },
    ]);
});

test("splitIntoUnits: 过短的行并进下一行，行号取第一行", () => {
    const units = splitIntoUnits("- 短\n接着的这一行补足了长度");
    assert.equal(units.length, 1);
    assert.equal(units[0].line, 0);
    assert.equal(units[0].text, "- 短 接着的这一行补足了长度");
});

test("splitIntoUnits: 空行切断合并，短行自成一个单元", () => {
    const units = splitIntoUnits("短句一\n\n另一段足够长的正文内容");
    assert.deepEqual(units.map((unit) => unit.text), ["短句一", "另一段足够长的正文内容"]);
    assert.deepEqual(units.map((unit) => unit.line), [0, 2]);
});

test("splitIntoUnits: 跳过标题、frontmatter 和代码围栏，保留代码本身", () => {
    const content = [
        "---",
        "title: 测试",
        "---",
        "## 这是一个标题",
        "正文第一句足够长了",
        "```js",
        "const answer = 42; // 代码内容仍然可搜",
        "```",
    ].join("\n");
    const units = splitIntoUnits(content);
    assert.deepEqual(units.map((unit) => unit.text), [
        "正文第一句足够长了",
        "const answer = 42; // 代码内容仍然可搜",
    ]);
    // A fenced block is one unit, and its line number points at the opening fence.
    assert.deepEqual(units.map((unit) => unit.line), [4, 5]);
});

test("splitIntoUnits: 代码块整块拼成一个单元，块内换行保留", () => {
    const content = [
        "```js",
        "const a = 1;",
        "短",
        "return a;",
        "```",
        "块后面的正文足够长了",
    ].join("\n");
    const units = splitIntoUnits(content);
    assert.deepEqual(units, [
        { line: 0, text: "const a = 1;\n短\nreturn a;" },
        { line: 5, text: "块后面的正文足够长了" },
    ]);
});

test("splitIntoUnits: 未闭合的代码块吃到文件结尾", () => {
    const units = splitIntoUnits("~~~\nconst a = 1;\nconst b = 2;");
    assert.deepEqual(units, [{ line: 0, text: "const a = 1;\nconst b = 2;" }]);
});

test("splitIntoUnits: 表格整块拼成一个单元，分隔行不进文本", () => {
    const content = [
        "表格前的一句正文内容",
        "| 字段 | 说明 |",
        "| --- | :-: |",
        "| id | 主键 |",
        "| name | 名称 |",
        "",
        "表格后的一句正文内容",
    ].join("\n");
    const units = splitIntoUnits(content);
    assert.deepEqual(units, [
        { line: 0, text: "表格前的一句正文内容" },
        { line: 1, text: "| 字段 | 说明 |\n| id | 主键 |\n| name | 名称 |" },
        { line: 6, text: "表格后的一句正文内容" },
    ]);
});

test("splitIntoUnits: 没有分隔行的竖线只是普通正文，不当表格", () => {
    const units = splitIntoUnits("这一行里有 | 竖线 | 但不是表格");
    assert.deepEqual(units, [{ line: 0, text: "这一行里有 | 竖线 | 但不是表格" }]);
});

test("splitIntoUnits: 表格到第一行不含竖线的行为止", () => {
    const content = [
        "| 字段 | 说明 |",
        "| --- | --- |",
        "| id | 主键 |",
        "紧跟表格的一句正文内容",
    ].join("\n");
    const units = splitIntoUnits(content);
    assert.deepEqual(units, [
        { line: 0, text: "| 字段 | 说明 |\n| id | 主键 |" },
        { line: 3, text: "紧跟表格的一句正文内容" },
    ]);
});

test("splitIntoUnits: 代码块里的表格与标题不参与块外规则", () => {
    const content = [
        "```md",
        "# 这是代码里的标题",
        "| a | b |",
        "| --- | --- |",
        "```",
    ].join("\n");
    assert.deepEqual(splitIntoUnits(content), [
        { line: 0, text: "# 这是代码里的标题\n| a | b |\n| --- | --- |" },
    ]);
});

test("splitIntoUnits: 只有排版符号的行被丢掉", () => {
    assert.deepEqual(splitIntoUnits("---\n***\n| --- | --- |"), []);
    assert.deepEqual(splitIntoUnits(""), []);
    assert.deepEqual(splitIntoUnits(null), []);
});

test("splitIntoUnits: CRLF 与行尾空白不进文本", () => {
    const units = splitIntoUnits("带回车的一行正文内容\r\n  两侧有空格的正文  \r\n");
    assert.deepEqual(units.map((unit) => unit.text), [
        "带回车的一行正文内容",
        "两侧有空格的正文",
    ]);
});

test("looksBinary / baseNameOf", () => {
    assert.equal(looksBinary("纯文本"), false);
    assert.equal(looksBinary("PK\u0000\u0003"), true);
    assert.equal(baseNameOf("a/b/c.md"), "c");
    assert.equal(baseNameOf("note"), "note");
    assert.equal(baseNameOf("dir/.hidden"), ".hidden");
});

// --- Folder and extension filtering ---------------------------------------

test("isPathUnder: 递归匹配，但不匹配同名前缀目录", () => {
    assert.equal(isPathUnder("笔记/a.md", "笔记"), true);
    assert.equal(isPathUnder("笔记/子/a.md", "笔记"), true);
    assert.equal(isPathUnder("笔记外/a.md", "笔记"), false);
    assert.equal(isPathUnder("任意/a.md", ""), true);
});

test("matchesFolders: 包含为空等于全库，排除优先于包含", () => {
    assert.equal(matchesFolders("a/b.md", [], []), true);
    assert.equal(matchesFolders("a/b.md", ["a"], []), true);
    assert.equal(matchesFolders("c/b.md", ["a"], []), false);
    assert.equal(matchesFolders("a/模板/b.md", ["a"], ["a/模板"]), false);
    assert.equal(matchesFolders("a/b.md", [], ["a"]), false);
});

test("hasAllowedExtension: 大小写无关，无拓展名或空列表都不匹配", () => {
    assert.equal(hasAllowedExtension("a.MD", ["md"]), true);
    assert.equal(hasAllowedExtension("a.txt", ["md", "txt"]), true);
    assert.equal(hasAllowedExtension("a.pdf", ["md", "txt"]), false);
    assert.equal(hasAllowedExtension("dir.v2/README", ["md"]), false);
    assert.equal(hasAllowedExtension("a.md", []), false);
});

test("collectFiles: 同时过拓展名和目录", () => {
    const files = [
        makeFakeFile("笔记/a.md"),
        makeFakeFile("笔记/b.pdf"),
        makeFakeFile("笔记/模板/c.md"),
        makeFakeFile("其他/d.md"),
    ];
    const vault = { getFiles: () => files };
    const picked = collectFiles(vault, {
        include: ["笔记"],
        exclude: ["笔记/模板"],
        extensions: ["md"],
    });
    assert.deepEqual(picked.map((file) => file.path), ["笔记/a.md"]);
});

test("chunkUnits: 按每请求 token 预算贪心装箱", () => {
    // 10 tokens per question plus 5 tokens fixed overhead, budget 35 -> 3 per batch.
    const budget = {
        maxTokens: 35,
        overheadTokens: 5,
        questionTokens: () => 10,
    };
    assert.deepEqual(chunkUnits([1, 2, 3, 4, 5], budget), [[1, 2, 3], [4, 5]]);
    assert.deepEqual(chunkUnits([], budget), []);
});

test("chunkUnits: 预算按实际长度分配，长段落的批次更小", () => {
    const units = [{ n: 1 }, { n: 30 }, { n: 1 }, { n: 1 }];
    const batches = chunkUnits(units, {
        maxTokens: 20,
        overheadTokens: 0,
        questionTokens: (_index, unit) => unit.n,
    });
    assert.deepEqual(batches.map((batch) => batch.map((unit) => unit.n)),
        [[1], [30], [1, 1]]);
});

test("chunkUnits: 单道题就超预算也照样发出去，不丢单元", () => {
    const batches = chunkUnits([1, 2], {
        maxTokens: 5,
        overheadTokens: 0,
        questionTokens: () => 100,
    });
    assert.deepEqual(batches, [[1], [2]]);
});

test("chunkUnits: 预算留空（Infinity / 0 / 非数）时所有单元进一个批次", () => {
    const units = [1, 2, 3];
    const questionTokens = () => 10;
    assert.deepEqual(chunkUnits(units, { maxTokens: Infinity, questionTokens }), [units]);
    assert.deepEqual(chunkUnits(units, { maxTokens: 0, questionTokens }), [units]);
    assert.deepEqual(chunkUnits(units, {}), [units]);
});

test("batchTokenBudget: 单请求只拿每秒预算里属于自己的那一份", () => {
    // 100000 tokens/s split across 8 workers -> 12500 each, well under the
    // 64000 per-request ceiling, so the fair share is what binds.
    assert.equal(batchTokenBudget(64000, 100000, 8), 12500);
    // One worker has the whole per-second budget, so the API ceiling binds.
    assert.equal(batchTokenBudget(64000, 100000, 1), 64000);
    // Whichever is smaller wins.
    assert.equal(batchTokenBudget(8000, 100000, 2), 8000);
});

test("batchTokenBudget: 没有每秒预算时沿用单请求上限", () => {
    // Nothing to divide, and latency is flat in question count, so there is
    // no reason to split below the API ceiling.
    assert.equal(batchTokenBudget(64000, Infinity, 8), 64000);
    assert.equal(batchTokenBudget(Infinity, Infinity, 8), Infinity);
});

test("batchTokenBudget: 两个上限都留空时不限制", () => {
    assert.equal(batchTokenBudget(Infinity, Infinity, 1), Infinity);
});

// --- Rate limiting --------------------------------------------------------

test("RateLimiter: 每秒请求上限生效，窗口滑过后放行", async () => {
    let now = 1000;
    const sleeps = [];
    const limiter = new RateLimiter({
        maxRequestsPerSecond: 2,
        now: () => now,
        sleep: async (ms) => { sleeps.push(ms); now += ms; },
    });
    assert.equal(await limiter.acquire(10), true);
    assert.equal(await limiter.acquire(10), true);
    // The third request must wait until the first slides out of the 1s window.
    assert.equal(await limiter.acquire(10), true);
    assert.ok(sleeps.length > 0, "第三个请求应该等待过");
    assert.ok(now >= 2000);
});

test("RateLimiter: 每秒 token 上限生效", async () => {
    let now = 0;
    const limiter = new RateLimiter({
        maxTokensPerSecond: 100,
        now: () => now,
        sleep: async (ms) => { now += ms; },
    });
    await limiter.acquire(60);
    await limiter.acquire(60);
    assert.ok(now >= 1000, "超出 token 预算时应等到窗口滑过");
});

test("RateLimiter: 单批就超过上限时也不会卡死", async () => {
    let now = 0;
    const limiter = new RateLimiter({
        maxTokensPerSecond: 10,
        now: () => now,
        sleep: async (ms) => { now += ms; },
    });
    assert.equal(await limiter.acquire(5000), true);
    assert.ok(now < 1000, "窗口空着时直接放行");
});

test("RateLimiter: 等待期间被终止则返回 false", async () => {
    let now = 0;
    let cancelled = false;
    const limiter = new RateLimiter({
        maxRequestsPerSecond: 1,
        now: () => now,
        sleep: async () => { cancelled = true; },
    });
    await limiter.acquire(1, () => cancelled);
    assert.equal(await limiter.acquire(1, () => cancelled), false);
});

// --- SearchController -----------------------------------------------------

const LONG = "这是一行足够长的正文内容";

// Token estimates of the fake client: zero fixed overhead, exactly 10 per question.
// So the preset's maxTokensPerRequest divided by 10 is the question count per
// request, which keeps the assertions readable.
const FAKE_QUESTION_TOKENS = 10;

/**
 * Build a controller with a fake AI client injected.
 * options.onJudge intercepts every batch: a returned value becomes the judge
 * result, and a thrown error is handled by _execute with real AiRequestError
 * semantics.
 * options.splitPassage replaces the default "never split" to exercise the
 * per-question token cap.
 */
function makeController(options = {}) {
    const plugin = makeConfiguredPlugin({
        files: options.files || [],
        activeFile: options.activeFile,
        readFails: options.readFails,
    });
    Object.assign(plugin.settings.presets.jev, {
        maxConcurrentRequests: 1,
        maxTokensPerRequest: FAKE_QUESTION_TOKENS,
        maxTokensPerQuestion: null,
    }, options.preset || {});
    if (options.folders) Object.assign(plugin.settings.folders, options.folders);

    const calls = [];
    let inFlight = 0;
    let peakInFlight = 0;
    const client = {
        assertConfigured: () => true,
        estimateBatchTokens: () => 10,
        estimateOverheadTokens: () => 0,
        estimateQuestionTokens: () => FAKE_QUESTION_TOKENS,
        splitPassage: options.splitPassage || ((_query, passage) => [passage]),
        async judge(query, passages, judgeOptions = {}) {
            calls.push({ query, passages });
            inFlight += 1;
            peakInFlight = Math.max(peakInFlight, inFlight);
            try {
                if (options.onJudge) {
                    const result = await options.onJudge({
                        query,
                        passages,
                        calls,
                        isCancelled: judgeOptions.isCancelled,
                    });
                    if (result !== undefined) return result;
                }
                return {
                    scores: passages.map((passage) => (options.scorer
                        ? options.scorer(passage)
                        : 0.9)),
                    usage: null,
                };
            } finally {
                inFlight -= 1;
            }
        },
    };
    const controller = new SearchController(plugin, {
        client,
        makeLimiter: () => ({ acquire: async () => true }),
    });
    return { plugin, controller, calls, stats: () => ({ peakInFlight }) };
}

test("搜本文: 没打开文档时提示并回到空闲", async () => {
    const { controller, calls } = makeController();
    bootstrap.resetNotices();
    controller.setQuery("查询");
    await controller.searchCurrentFile();
    assert.equal(controller.state.status, STATUS_IDLE);
    assert.equal(calls.length, 0);
    assert.ok(bootstrap.lastNotice().message.includes("请先打开一个文档"));
});

test("搜索: 输入为空时提示且不发请求", async () => {
    const { controller, calls } = makeController({
        activeFile: makeFakeFile("a.md", LONG),
    });
    bootstrap.resetNotices();
    controller.setQuery("   ");
    await controller.searchCurrentFile();
    assert.equal(calls.length, 0);
    assert.ok(bootstrap.lastNotice().message.includes("请先输入"));
});

test("搜本文: 低于阈值的段落被过滤，结果按相关度从高到低", async () => {
    const content = `${LONG}A\n${LONG}B\n${LONG}C`;
    const scores = { A: 0.91, B: 0.2, C: 0.73 };
    const { controller, calls } = makeController({
        activeFile: makeFakeFile("笔记/测试.md", content),
        scorer: (passage) => scores[passage.slice(-1)],
    });
    controller.setQuery("查询");
    await controller.searchCurrentFile();

    const state = controller.state;
    assert.equal(state.status, STATUS_DONE);
    assert.equal(calls.length, 3, "每请求 1 个问题，3 段 3 个请求");
    assert.deepEqual(state.progress, { completed: 3, total: 3 });
    assert.deepEqual(state.results.map((result) => result.score), [0.91, 0.73]);
    assert.deepEqual(state.results.map((result) => result.line), [0, 2]);
    assert.equal(state.results[0].path, "笔记/测试.md");
    assert.equal(state.results[0].basename, "测试");
});

test("搜本文: 阈值可配置", async () => {
    const { controller } = makeController({
        activeFile: makeFakeFile("a.md", `${LONG}A\n${LONG}B`),
        scorer: (passage) => (passage.endsWith("A") ? 0.8 : 0.6),
        preset: { relevanceThreshold: 0.75 },
    });
    controller.setQuery("查询");
    await controller.searchCurrentFile();
    assert.equal(controller.state.results.length, 1);
    assert.equal(controller.state.results[0].score, 0.8);
});

test("搜索: 多个问题合并进一个请求", async () => {
    const { controller, calls } = makeController({
        activeFile: makeFakeFile("a.md", `${LONG}A\n${LONG}B\n${LONG}C`),
        preset: { maxTokensPerRequest: FAKE_QUESTION_TOKENS * 2 },
    });
    controller.setQuery("查询");
    await controller.searchCurrentFile();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].passages.length, 2);
    assert.equal(calls[1].passages.length, 1);
});

test("搜索: 单题上限把超长单元切成多道题，结果里仍是完整文本且只出一条", async () => {
    const { controller, calls } = makeController({
        activeFile: makeFakeFile("a.md", `${LONG}A`),
        preset: { maxTokensPerQuestion: 4, maxTokensPerRequest: FAKE_QUESTION_TOKENS * 3 },
        splitPassage: (_query, passage, maxTokens) => {
            assert.equal(maxTokens, 4, "单题上限应原样传给客户端");
            return [passage.slice(0, 5), passage.slice(5)];
        },
        scorer: (passage) => (passage.length === 5 ? 0.7 : 0.95),
    });
    controller.setQuery("查询");
    await controller.searchCurrentFile();

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].passages, [`${LONG}A`.slice(0, 5), `${LONG}A`.slice(5)],
        "发出去的是切分后的各段，后半截没被丢掉");
    assert.deepEqual(controller.state.progress, { completed: 2, total: 2 },
        "进度按题数算");
    assert.equal(controller.state.results.length, 1, "同一个单元只出一条结果");
    assert.equal(controller.state.results[0].text, `${LONG}A`, "展示的是完整文本");
    assert.equal(controller.state.results[0].score, 0.95, "分数取各段里最高的");
});

test("搜索: 并发不超过配置上限", async () => {
    const lines = Array.from({ length: 6 }, (_, index) => `${LONG}${index}`).join("\n");
    const { controller, stats } = makeController({
        activeFile: makeFakeFile("a.md", lines),
        preset: { maxConcurrentRequests: 3 },
        onJudge: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        },
    });
    controller.setQuery("查询");
    await controller.searchCurrentFile();
    assert.equal(stats().peakInFlight, 3);
});

test("搜索: 单请求上限装得下也按每秒预算份额切批，让每个 worker 都有活干", async () => {
    // No per-request cap at all. Previously everything packed into one request
    // and 3 of the 4 workers idled; now each request takes at most
    // maxTokensPerSecond / concurrency = 80 / 4 = 20 tokens, i.e. 2 questions.
    const lines = Array.from({ length: 24 }, (_, index) => `${LONG}${index}`).join("\n");
    const { controller, calls, stats } = makeController({
        activeFile: makeFakeFile("a.md", lines),
        preset: {
            maxConcurrentRequests: 4,
            maxTokensPerRequest: null,
            maxTokensPerSecond: FAKE_QUESTION_TOKENS * 8,
        },
        onJudge: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        },
    });
    controller.setQuery("查询");
    await controller.searchCurrentFile();

    assert.equal(calls.length, 12, "24 题按每批 2 题切成 12 批");
    assert.equal(stats().peakInFlight, 4, "4 个 worker 应同时在飞");
    assert.equal(calls.reduce((sum, call) => sum + call.passages.length, 0), 24,
        "切批不该丢题");
    assert.deepEqual(controller.state.progress, { completed: 24, total: 24 });
});

test("搜索: 每秒预算留空时沿用单请求上限，不额外切批", async () => {
    const lines = Array.from({ length: 6 }, (_, index) => `${LONG}${index}`).join("\n");
    const { controller, calls } = makeController({
        activeFile: makeFakeFile("a.md", lines),
        preset: {
            maxConcurrentRequests: 4,
            maxTokensPerRequest: FAKE_QUESTION_TOKENS * 6,
            maxTokensPerSecond: null,
        },
    });
    controller.setQuery("查询");
    await controller.searchCurrentFile();
    assert.equal(calls.length, 1, "没有每秒预算可分时不该为了并发而切批");
    assert.equal(calls[0].passages.length, 6);
});

test("搜索: 份额小于一道题时每批仍保一题，不产生空批次", async () => {
    const lines = Array.from({ length: 3 }, (_, index) => `${LONG}${index}`).join("\n");
    const { controller, calls } = makeController({
        activeFile: makeFakeFile("a.md", lines),
        preset: {
            maxConcurrentRequests: 8,
            maxTokensPerRequest: null,
            // 8 tokens/s over 8 workers -> 1 token each, below one question's 10.
            maxTokensPerSecond: 8,
        },
    });
    controller.setQuery("查询");
    await controller.searchCurrentFile();
    assert.equal(calls.length, 3);
    for (const call of calls) assert.equal(call.passages.length, 1);
});

test("搜索: 进度单调递增，结束后不再显示进度（状态不是 running）", async () => {
    const lines = Array.from({ length: 4 }, (_, index) => `${LONG}${index}`).join("\n");
    const seen = [];
    const { controller } = makeController({ activeFile: makeFakeFile("a.md", lines) });
    controller.onChange((state) => {
        if (state.status === STATUS_RUNNING) seen.push(state.progress.completed);
    });
    controller.setQuery("查询");
    await controller.searchCurrentFile();
    assert.deepEqual(seen, [0, 0, 1, 2, 3, 4]);
    assert.notEqual(controller.state.status, STATUS_RUNNING);
    assert.equal(controller.state.progress.completed, 4);
});

test("终止: 停止后续批次，并按已拿到的结果排序展示", async () => {
    const lines = Array.from({ length: 5 }, (_, index) => `${LONG}${index}`).join("\n");
    let controllerRef = null;
    const { controller, calls } = makeController({
        activeFile: makeFakeFile("a.md", lines),
        scorer: () => 0.9,
        onJudge: async ({ calls: seen }) => {
            // Cancel just before the second batch returns.
            if (seen.length === 2) controllerRef.abort();
        },
    });
    controllerRef = controller;
    bootstrap.resetNotices();
    controller.setQuery("查询");
    await controller.searchCurrentFile();

    assert.equal(controller.state.status, STATUS_ABORTED);
    assert.equal(calls.length, 2, "终止后不再发新请求");
    assert.equal(controller.state.results.length, 2, "已拿到的结果仍然展示");
    assert.ok(bootstrap.lastNotice().message.includes("已终止搜索"));
});

test("fatal 错误: 整次搜索立即结束", async () => {
    const lines = Array.from({ length: 4 }, (_, index) => `${LONG}${index}`).join("\n");
    const { controller, calls } = makeController({
        activeFile: makeFakeFile("a.md", lines),
        onJudge: async () => {
            throw new AiRequestError("ai-search：鉴权失败（HTTP 401）", { fatal: true, status: 401 });
        },
    });
    controller.setQuery("查询");
    await controller.searchCurrentFile();
    assert.equal(controller.state.status, STATUS_ERROR);
    assert.ok(controller.state.errorMessage.includes("401"));
    assert.equal(calls.length, 1, "fatal 之后不再发请求");
});

test("可恢复错误: 只记这一批失败，其余批次照常跑完", async () => {
    const lines = Array.from({ length: 3 }, (_, index) => `${LONG}${index}`).join("\n");
    const { controller, calls } = makeController({
        activeFile: makeFakeFile("a.md", lines),
        onJudge: async ({ calls: seen }) => {
            if (seen.length === 1) {
                throw new AiRequestError("ai-search：服务暂时过载", { fatal: false, status: 529 });
            }
        },
    });
    bootstrap.resetNotices();
    controller.setQuery("查询");
    await controller.searchCurrentFile();

    assert.equal(controller.state.status, STATUS_DONE);
    assert.equal(calls.length, 3);
    assert.equal(controller.state.failedBatches, 1);
    assert.equal(controller.state.results.length, 2);
    assert.deepEqual(controller.state.progress, { completed: 3, total: 3 });
    assert.ok(bootstrap.noticeLog.some((entry) => entry.message.includes("批次请求失败")));
});

test("改输入: 清掉上次结果并终止在跑的搜索，且不弹「已终止」", async () => {
    const lines = Array.from({ length: 5 }, (_, index) => `${LONG}${index}`).join("\n");
    let controllerRef = null;
    const { controller } = makeController({
        activeFile: makeFakeFile("a.md", lines),
        onJudge: async ({ calls: seen }) => {
            if (seen.length === 1) controllerRef.setQuery("新的查询");
        },
    });
    controllerRef = controller;
    controller.setQuery("查询");
    bootstrap.resetNotices();
    await controller.searchCurrentFile();

    assert.equal(controller.state.query, "新的查询");
    assert.equal(controller.state.status, STATUS_IDLE);
    assert.deepEqual(controller.state.results, []);
    assert.deepEqual(controller.state.progress, { completed: 0, total: 0 });
    assert.equal(bootstrap.noticeLog.length, 0, "改输入不该弹终止提示");
});

test("搜索中再次触发搜索会被挡住", async () => {
    const { controller, calls } = makeController({
        activeFile: makeFakeFile("a.md", `${LONG}A\n${LONG}B`),
        onJudge: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
        },
    });
    controller.setQuery("查询");
    bootstrap.resetNotices();
    const first = controller.searchCurrentFile();
    await controller.searchVault();
    await first;
    assert.ok(bootstrap.noticeLog.some((entry) => entry.message.includes("已有搜索")));
    assert.equal(calls.length, 2, "只有第一次搜索发了请求");
});

test("搜全库: 按目录与拓展名设置取文件，二进制内容被忽略", async () => {
    const files = [
        makeFakeFile("笔记/a.md", `${LONG}A`),
        makeFakeFile("笔记/模板/b.md", `${LONG}B`),
        makeFakeFile("笔记/c.pdf", `${LONG}C`),
        makeFakeFile("笔记/d.md", `${LONG}D\u0000`),
        makeFakeFile("其他/e.md", `${LONG}E`),
    ];
    const { controller, calls } = makeController({
        files,
        folders: { include: ["笔记"], exclude: ["笔记/模板"], extensions: ["md"] },
    });
    controller.setQuery("查询");
    await controller.searchVault();
    assert.equal(calls.length, 1);
    assert.deepEqual(controller.state.results.map((result) => result.path), ["笔记/a.md"]);
});

test("搜全库: 没有匹配文件时提示并回到空闲", async () => {
    const { controller, calls } = makeController({
        files: [makeFakeFile("a.pdf", LONG)],
        folders: { extensions: ["md"] },
    });
    bootstrap.resetNotices();
    controller.setQuery("查询");
    await controller.searchVault();
    assert.equal(calls.length, 0);
    assert.equal(controller.state.status, STATUS_IDLE);
    assert.ok(bootstrap.lastNotice().message.includes("没有符合目录与拓展名"));
});

test("搜全库: 匹配到文件但没有可搜文本时提示", async () => {
    const { controller, calls } = makeController({
        files: [makeFakeFile("a.md", "# 只有标题\n\n---")],
        folders: { extensions: ["md"] },
    });
    bootstrap.resetNotices();
    controller.setQuery("查询");
    await controller.searchVault();
    assert.equal(calls.length, 0);
    assert.ok(bootstrap.lastNotice().message.includes("没有可搜索的文本"));
});

test("搜本文: 内容不是纯文本时提示没有可搜索的文本", async () => {
    const { controller, calls } = makeController({
        activeFile: makeFakeFile("a.pdf", "%PDF-1.7\u0000\u0000"),
    });
    bootstrap.resetNotices();
    controller.setQuery("查询");
    await controller.searchCurrentFile();
    assert.equal(calls.length, 0);
    assert.equal(controller.state.status, STATUS_IDLE);
    assert.ok(bootstrap.lastNotice().message.includes("没有可搜索的文本"));
});

test("搜全库: 单个文件读失败只跳过它，不打断整次搜索", async () => {
    const files = [makeFakeFile("a.md", `${LONG}A`), makeFakeFile("b.md", `${LONG}B`)];
    const { controller, calls } = makeController({
        files,
        readFails: new Set(["a.md"]),
        folders: { extensions: ["md"] },
    });
    controller.setQuery("查询");
    await controller.searchVault();
    assert.equal(calls.length, 1);
    assert.deepEqual(controller.state.results.map((result) => result.path), ["b.md"]);
});

test("onChange 返回退订函数；dispose 后不再回调", async () => {
    const { controller } = makeController({
        activeFile: makeFakeFile("a.md", LONG),
    });
    let hits = 0;
    const unsubscribe = controller.onChange(() => { hits += 1; });
    controller.setQuery("a");
    assert.equal(hits, 1);
    unsubscribe();
    controller.setQuery("ab");
    assert.equal(hits, 1);

    controller.onChange(() => { hits += 1; });
    controller.dispose();
    controller.setQuery("abc");
    assert.equal(hits, 1);
});

test("插件卸载后不再弹提示", async () => {
    const { controller, plugin } = makeController({
        activeFile: makeFakeFile("a.md", LONG),
    });
    plugin.__aiSearchUnloaded = true;
    bootstrap.resetNotices();
    controller.setQuery("查询");
    await controller.searchCurrentFile();
    assert.equal(bootstrap.noticeLog.length, 0);
});
