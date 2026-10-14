/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

require("./helpers/bootstrap");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
    AiClient,
    RELEVANCE_TASK,
    RELEVANCE_QUESTION,
    MAX_ATTEMPTS,
    buildRequest,
    parseAnswers,
    classifyStatus,
    extractErrorMessage,
    estimateTokens,
    estimateOverheadTokens,
    estimateQuestionTokens,
    estimateStatePlusQuestionTokens,
    splitToTokenBudget,
    readPayload,
} = require("../src/ai");
const { makeConfiguredPlugin } = require("./helpers/fakePlugin");

// --- Request body ---------------------------------------------------------

test("buildRequest: 搜索词和判定规则进 state，每段正文各占一道 noul 题", () => {
    const body = buildRequest("jev-latest", "梯次利用", ["退役电池重新分组", "宋代青瓷"]);
    assert.deepEqual(body.model, "jev-latest");
    // Everything shared by the batch lives in state, paid for once per request.
    assert.deepEqual(body.state, { query: "梯次利用", task: RELEVANCE_TASK });
    assert.deepEqual(Object.keys(body.questions), ["p0", "p1"]);
    assert.equal(body.questions.p0.type, "noul");
    assert.equal(body.questions.p0.instructions.passage, "退役电池重新分组");
    assert.equal(body.questions.p1.instructions.passage, "宋代青瓷");
    // Both questions share one short English prompt that defers to `task`.
    assert.equal(body.questions.p0.instructions.question, RELEVANCE_QUESTION);
    assert.ok(/`passage`/.test(RELEVANCE_QUESTION) && /`query`/.test(RELEVANCE_QUESTION));
    assert.ok(/`task`/.test(RELEVANCE_QUESTION), "问句需引用 state 里的规则字段");
    assert.ok(/`passage`/.test(RELEVANCE_TASK) && /`query`/.test(RELEVANCE_TASK));
    for (const [name, text] of [["RELEVANCE_QUESTION", RELEVANCE_QUESTION],
        ["RELEVANCE_TASK", RELEVANCE_TASK]]) {
        assert.ok(/^[\x00-\x7F]+$/.test(text), `${name} 必须是英文`);
    }
});

test("buildRequest: 重复的问句不随题数增长，规则只付一次", () => {
    // The whole point of moving the rule into state: per-question cost stays
    // flat, so a fat request spends its tokens on passages, not boilerplate.
    const passage = "正文".repeat(20);
    const perQuestion = estimateQuestionTokens(0, passage);
    assert.ok(perQuestion < estimateOverheadTokens("m", "查询"),
        "单题增量不该再被长问句主导");
    assert.ok(!JSON.stringify(buildRequest("m", "查询", [passage])).includes(RELEVANCE_TASK
        + RELEVANCE_TASK), "规则不该出现多次");
    const body = JSON.stringify(buildRequest("m", "查询", new Array(30).fill(passage)));
    assert.equal(body.split(JSON.stringify(RELEVANCE_TASK).slice(1, -1)).length - 1, 1,
        "30 道题的请求里规则仍只出现 1 次");
});

test("buildRequest: 空批次也生成合法结构", () => {
    const body = buildRequest("m", "q", []);
    assert.deepEqual(body.questions, {});
});

test("estimateTokens: 随请求体变长而变大，且带固定开销", () => {
    const small = estimateTokens(buildRequest("m", "q", ["短"]));
    const large = estimateTokens(buildRequest("m", "q", ["短".repeat(500)]));
    assert.ok(small > 300, "应包含模型侧固定开销");
    assert.ok(large > small);
});

test("estimateOverheadTokens + 逐题增量 ≥ 整请求估算（宁可高估）", () => {
    const passages = ["第一段正文", "第二段稍微长一点的正文", "第三段"];
    const incremental = estimateOverheadTokens("m", "查询")
        + passages.reduce((sum, passage, index) =>
            sum + estimateQuestionTokens(index, passage), 0);
    const whole = estimateTokens(buildRequest("m", "查询", passages));
    assert.ok(incremental >= whole,
        `逐题累加 ${incremental} 不该低于整体估算 ${whole}`);
});

test("estimateQuestionTokens: 正文越长越贵，题 id 变长也更贵", () => {
    assert.ok(estimateQuestionTokens(0, "长".repeat(100))
        > estimateQuestionTokens(0, "短"));
    assert.ok(estimateQuestionTokens(1000000, "同一段正文")
        >= estimateQuestionTokens(0, "同一段正文"));
});

test("splitToTokenBudget: 不超标时原样返回一段", () => {
    const query = "查询";
    const short = "一小段正文";
    assert.deepEqual(splitToTokenBudget("m", query, short, 100000), [short]);
    assert.deepEqual(splitToTokenBudget("m", query, short, Infinity), [short]);
    assert.deepEqual(splitToTokenBudget("m", query, short, 0), [short], "0 表示不限制");
});

test("splitToTokenBudget: 超标时切成多段，每段都在预算内且拼回原文", () => {
    const query = "查询";
    const long = "长".repeat(5000);
    const budget = estimateStatePlusQuestionTokens("m", query, "") + 200;
    const pieces = splitToTokenBudget("m", query, long, budget);

    assert.ok(pieces.length > 1, "超长正文应被切成多段，而不是截断成一段");
    assert.equal(pieces.join(""), long, "各段拼起来等于原文，后半截没丢");
    for (const piece of pieces) {
        assert.ok(piece.length > 0);
        assert.ok(estimateStatePlusQuestionTokens("m", query, piece) <= budget);
    }
    // One more character in the first piece would exceed the budget, so the split is maximal.
    assert.ok(estimateStatePlusQuestionTokens("m", query, long.slice(0, pieces[0].length + 1))
        > budget);
});

test("splitToTokenBudget: 切点落在换行或空格之后", () => {
    const query = "查询";
    // Lines of ~20 chars with a budget for ~100 chars, so split points land on line boundaries.
    const lines = Array.from({ length: 40 }, (_, index) => `第${index}行的正文内容填充到位`);
    const long = lines.join("\n");
    const budget = estimateStatePlusQuestionTokens("m", query, "") + 50;
    const pieces = splitToTokenBudget("m", query, long, budget);

    assert.ok(pieces.length > 1);
    assert.equal(pieces.join(""), long);
    for (const piece of pieces.slice(0, -1)) {
        assert.ok(piece.endsWith("\n"), `切点应在换行之后，实际结尾：${piece.slice(-8)}`);
    }
});

test("splitToTokenBudget: 附近没有空白时按长度硬切", () => {
    const query = "查询";
    const long = "长".repeat(2000);
    const budget = estimateStatePlusQuestionTokens("m", query, "") + 50;
    const pieces = splitToTokenBudget("m", query, long, budget);
    assert.ok(pieces.length > 1);
    assert.equal(pieces.join(""), long);
});

test("splitToTokenBudget: 预算小到连一个字符都放不下时整段发出去", () => {
    assert.deepEqual(splitToTokenBudget("m", "查询", "任意正文", 1), ["任意正文"]);
});

// --- Response parsing -----------------------------------------------------

test("parseAnswers: 按 id 对回顺序并夹到 0–1", () => {
    const scores = parseAnswers({
        answers: {
            p0: { type: "noul", noul: 0.98 },
            p1: { type: "noul", noul: 1.4 },
            p2: { type: "noul", noul: -0.2 },
        },
    }, 3);
    assert.deepEqual(scores, [0.98, 1, 0]);
});

test("parseAnswers: 缺字段时抛出带 detail 的 fatal 错误", () => {
    assert.throws(() => parseAnswers({}, 1), (error) => {
        assert.equal(error.fatal, true);
        assert.equal(error.detail, "answers");
        return true;
    });
    assert.throws(() => parseAnswers({ answers: { p0: {} } }, 1), (error) => {
        assert.equal(error.detail, "answers.p0.noul");
        return true;
    });
    assert.throws(() => parseAnswers({ answers: { p0: { noul: "0.9" } } }, 1), /p0/);
});

test("readPayload: 优先解析 text，坏 JSON 返回 null", () => {
    assert.deepEqual(readPayload({ text: '{"a":1}' }), { a: 1 });
    assert.equal(readPayload({ text: "not json" }), null);
    assert.deepEqual(readPayload({ json: { a: 2 } }), { a: 2 });
    assert.equal(readPayload(null), null);
});

// --- Error classification -------------------------------------------------

test("classifyStatus: 按 jev-api.md 1.4 区分「改了才有用」和「等等再试」", () => {
    assert.deepEqual(classifyStatus(200), { ok: true, retryable: false, errorKey: null });
    for (const status of [401, 403]) {
        assert.deepEqual(classifyStatus(status),
            { ok: false, retryable: false, errorKey: "authFailed" });
    }
    assert.equal(classifyStatus(400).errorKey, "badRequest");
    assert.equal(classifyStatus(400).retryable, false);
    assert.equal(classifyStatus(422).errorKey, "validationFailed");
    assert.equal(classifyStatus(422).retryable, false);
    assert.equal(classifyStatus(404).retryable, false);
    assert.equal(classifyStatus(404).errorKey, "httpError");
    assert.equal(classifyStatus(429).retryable, true);
    assert.equal(classifyStatus(529).retryable, true);
    assert.equal(classifyStatus(500).retryable, true);
    assert.equal(classifyStatus(503).retryable, true);
});

test("extractErrorMessage: 兼容 jev 的 detail 和网关的 error.message", () => {
    assert.equal(extractErrorMessage('{"detail":"Must supply an API key!"}'),
        "Must supply an API key!");
    assert.equal(extractErrorMessage('{"error":{"message":"无可用渠道","type":"one_api_error"}}'),
        "无可用渠道");
    assert.equal(extractErrorMessage("plain failure"), "plain failure");
    assert.equal(extractErrorMessage(""), "(empty body)");
    assert.equal(extractErrorMessage(undefined), "(empty body)");
});

// --- judge ----------------------------------------------------------------

function makeClient(responses, overrides = {}) {
    const calls = [];
    const plugin = makeConfiguredPlugin();
    if (overrides.settingsPatch) Object.assign(plugin.settings, overrides.settingsPatch);
    const client = new AiClient(plugin, {
        backoffMs: 0,
        requestUrl: async (options) => {
            calls.push(options);
            const next = responses.shift();
            if (next === undefined) throw new Error("unexpected extra request");
            if (next instanceof Error) throw next;
            return next;
        },
    });
    return { client, calls, plugin };
}

function okResponse(scores) {
    const answers = {};
    scores.forEach((score, index) => { answers[`p${index}`] = { type: "noul", noul: score }; });
    return {
        status: 200,
        text: JSON.stringify({
            model: "jev-1.13.0",
            answers,
            usage: { input_tokens: 383, output_tokens: 75 },
        }),
    };
}

test("judge: 成功时返回分数与 usage，并带上 Bearer 头", async () => {
    const { client, calls } = makeClient([okResponse([0.98, 0.01])]);
    const result = await client.judge("梯次利用", ["a", "b"]);
    assert.deepEqual(result.scores, [0.98, 0.01]);
    assert.deepEqual(result.usage, { input_tokens: 383, output_tokens: 75 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(calls[0].headers.Authorization, "Bearer sk-test");
    assert.equal(calls[0].throw, false);
    assert.equal(JSON.parse(calls[0].body).model, "jev-latest");
});

test("endpoint: base URL 末尾的斜杠不会造成双斜杠", () => {
    const { client, plugin } = makeClient([]);
    plugin.settings.presets.jev.baseUrl = "https://example.test//";
    assert.equal(client.endpoint, "https://example.test/v1/systemone");
});

test("judge: 401 不重试，直接抛 fatal", async () => {
    const { client, calls } = makeClient([
        { status: 401, text: '{"detail":"Cannot authenticate with the server"}' },
    ]);
    await assert.rejects(() => client.judge("q", ["a"]), (error) => {
        assert.equal(error.fatal, true);
        assert.equal(error.status, 401);
        assert.ok(/鉴权失败/.test(error.message));
        return true;
    });
    assert.equal(calls.length, 1, "鉴权错误重试没有意义");
});

test("judge: 400 / 422 同样不重试", async () => {
    for (const status of [400, 422]) {
        const { client, calls } = makeClient([{ status, text: '{"detail":"bad"}' }]);
        await assert.rejects(() => client.judge("q", ["a"]), (error) => {
            assert.equal(error.fatal, true);
            return true;
        });
        assert.equal(calls.length, 1);
    }
});

test("judge: 429 重试后成功", async () => {
    const { client, calls } = makeClient([
        { status: 429, text: '{"detail":"slow down"}' },
        { status: 429, text: '{"detail":"slow down"}' },
        okResponse([0.7]),
    ]);
    const result = await client.judge("q", ["a"]);
    assert.deepEqual(result.scores, [0.7]);
    assert.equal(calls.length, 3);
});

test("judge: 可重试错误用完额度后抛非 fatal（调用方只记这一批失败）", async () => {
    const responses = [];
    for (let index = 0; index < MAX_ATTEMPTS; index++) {
        responses.push({ status: 529, text: '{"detail":"overloaded"}' });
    }
    const { client, calls } = makeClient(responses);
    await assert.rejects(() => client.judge("q", ["a"]), (error) => {
        assert.equal(error.fatal, false);
        assert.equal(error.status, 529);
        assert.ok(error.message.includes(String(MAX_ATTEMPTS)));
        return true;
    });
    assert.equal(calls.length, MAX_ATTEMPTS);
});

test("judge: 网络异常按可重试处理", async () => {
    const { client, calls } = makeClient([
        new Error("net::ERR_CONNECTION_REFUSED"),
        okResponse([0.5]),
    ]);
    const result = await client.judge("q", ["a"]);
    assert.deepEqual(result.scores, [0.5]);
    assert.equal(calls.length, 2);
});

test("judge: 响应结构不对时抛 fatal badResponse", async () => {
    const { client } = makeClient([{ status: 200, text: '{"model":"x"}' }]);
    await assert.rejects(() => client.judge("q", ["a"]), (error) => {
        assert.equal(error.fatal, true);
        assert.ok(/answers/.test(error.message));
        return true;
    });
});

test("judge: 2xx 但响应不是 JSON 也算 fatal", async () => {
    const { client } = makeClient([{ status: 200, text: "<html>oops</html>" }]);
    await assert.rejects(() => client.judge("q", ["a"]), /ai-search/);
});

test("judge: isCancelled 为真时不发请求，返回 null", async () => {
    const { client, calls } = makeClient([]);
    const result = await client.judge("q", ["a"], { isCancelled: () => true });
    assert.equal(result, null);
    assert.equal(calls.length, 0);
});

test("assertConfigured: 缺 base URL / 模型名 / 密钥时分别报对应的错", async () => {
    const { client, plugin } = makeClient([]);
    const preset = plugin.settings.presets.jev;

    preset.apiKey = "";
    assert.throws(() => client.assertConfigured(), /模型密钥/);
    preset.model = "";
    assert.throws(() => client.assertConfigured(), /模型名称/);
    preset.baseUrl = "";
    assert.throws(() => client.assertConfigured(), /base URL/);
    assert.throws(() => client.assertConfigured(), (error) => {
        assert.equal(error.fatal, true);
        return true;
    });
});

test("自定义预设未填配置时 judge 直接 fatal，不发请求", async () => {
    const { client, calls, plugin } = makeClient([]);
    plugin.settings.currentPreset = "custom";
    await assert.rejects(() => client.judge("q", ["a"]), (error) => {
        assert.equal(error.fatal, true);
        return true;
    });
    assert.equal(calls.length, 0);
});
