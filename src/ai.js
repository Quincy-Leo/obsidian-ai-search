/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

// ---------------------------------------------------------------------------
// AI API layer
// ---------------------------------------------------------------------------
//
// Turns a batch of passages plus one search phrase into a set of relevance
// probabilities. It knows nothing about Obsidian files and does not decide
// ordering — concurrency, rate limiting and progress belong to search.js.
//
// The request body follows jev's systemone shape: one `state` plus many
// `questions`. Our direction is the inverse (one search phrase, many
// passages), so the phrase goes into `state` and each passage into its own
// question's `instructions`. That lets a single request judge many passages
// at once without them interfering with each other.
//
// Anything shared by every question belongs in `state`, not in the questions.
// A full request holds several hundred questions, so a sentence repeated in
// each one is paid for several hundred times -- and the token estimates below
// drive both batching and rate limiting, so the copies cost wall-clock time,
// not just bytes. Hence the split between RELEVANCE_TASK (once, in `state`)
// and RELEVANCE_QUESTION (per question, and kept short).

const { requestUrl } = require("obsidian");
const { API_PATH, activePreset, errorText, localizedText } = require("./settings");

// Both texts are always English, as specified. Backticks reference field names
// inside `state` / `instructions`, per systemone convention.

// The judging rule, shared by every question in the request and therefore
// carried once in `state`.
const RELEVANCE_TASK =
    "Judge the text in `passage` as relevant to the search phrase in `query` "
    + "if someone searching for `query` would want to read `passage`, "
    + "even when the two share no words in common.";

// What each individual question asks. It names `passage` (its own field) and
// `task` (the rule in `state`), so one short sentence pulls in the whole rule.
const RELEVANCE_QUESTION = "Is `passage` relevant to `query`, judged by `task`?";

// Maximum attempts per request, including the first. Only retryable errors
// are retried.
const MAX_ATTEMPTS = 3;
const RETRY_BASE_BACKOFF_MS = 500;

// While backing off, wake up at this interval to check for cancellation so a
// cancel request takes effect within 50ms.
const CANCEL_POLL_MS = 50;

// Characters-to-tokens factor. Rate limiting and length caps must budget
// before sending, but the real token count only arrives with the response's
// usage, so this deliberately overestimates: better to under-send than to hit
// 429 or 422. The constant term is the model-side fixed cost (measured: 100
// Chinese characters + 2 questions is roughly 425 input tokens, far more than
// the passage text alone).
const TOKENS_PER_CHAR = 0.5;
const TOKENS_FIXED_OVERHEAD = 300;

/** API error carrying a `fatal` flag: fatal means the whole search should stop. */
class AiRequestError extends Error {
    constructor(message, { fatal = false, status = null } = {}) {
        super(message);
        this.name = "AiRequestError";
        this.fatal = fatal;
        this.status = status;
    }
}

/**
 * A question's id in the request body. Never sent to the model; it only maps
 * answers back to their passages.
 */
function questionId(index) {
    return `p${index}`;
}

/**
 * One question's body fragment. `passage` is its text; `question` is the same
 * short sentence in every question and defers the actual rule to `task` in
 * `state`, so the rule's wording is paid for once per request rather than once
 * per passage.
 */
function buildQuestion(passage) {
    return {
        type: "noul",
        instructions: { question: RELEVANCE_QUESTION, passage },
    };
}

/**
 * Assemble a systemone request body. Pure, so unit tests can assert the shape
 * directly.
 *
 * `state` carries the two things every question in the batch shares: the
 * search phrase and the judging rule. Questions reference both by field name.
 *
 * @param {string} model
 * @param {string} query The user's search phrase.
 * @param {string[]} passages The passages to judge in this batch.
 */
function buildRequest(model, query, passages) {
    const questions = {};
    passages.forEach((passage, index) => {
        questions[questionId(index)] = buildQuestion(passage);
    });
    return { model, state: { query, task: RELEVANCE_TASK }, questions };
}

function tokensForChars(chars) {
    return Math.ceil(chars * TOKENS_PER_CHAR);
}

/** Overestimate a body's token count, for search.js's tokens-per-second limiter. */
function estimateTokens(body) {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return tokensForChars(text.length) + TOKENS_FIXED_OVERHEAD;
}

/**
 * The passage-independent part of a request: `model`, `state` and the outer
 * JSON skeleton. Batching pays this once up front, then adds
 * {@link estimateQuestionTokens} per question, avoiding a full re-serialize of
 * the body on every question added.
 */
function estimateOverheadTokens(model, query) {
    return estimateTokens(buildRequest(model, query, []));
}

/**
 * Tokens added by one more question: its id, the question text, the passage
 * and the JSON wrapper. The trailing character is the comma between
 * questions. Each term rounds up, so `overhead + Σ this` is never below the
 * whole-body estimate — overestimating is the safe direction.
 * @param {number} index This question's position in the batch (sets id length).
 */
function estimateQuestionTokens(index, passage) {
    const chars = JSON.stringify(questionId(index)).length
        + 1
        + JSON.stringify(buildQuestion(passage)).length
        + 1;
    return tokensForChars(chars);
}

/**
 * Token estimate for "`state` plus this one question", matching the combined
 * cap on state and the longest single question in jev-api.md 1.2. The fixed
 * overhead is included so this uses the same yardstick as the whole-request
 * estimate.
 */
function estimateStatePlusQuestionTokens(model, query, passage) {
    return estimateOverheadTokens(model, query) + estimateQuestionTokens(0, passage);
}

// Prefer cut points at a newline or space, searching back at most this
// fraction of the distance. Each piece is judged on its own, and cutting
// mid-word or mid-line makes both pieces harder to judge; but the search
// cannot go back indefinitely, or a long passage with no whitespace would be
// cut into ever-shorter pieces.
const BOUNDARY_SEARCH_RATIO = 0.2;

/**
 * Length of the longest prefix that fits. The estimate is monotonic in
 * length, so binary search is safe.
 */
function longestPrefixWithin(fits, text) {
    let low = 0;
    let high = text.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(text.slice(0, mid))) low = mid;
        else high = mid - 1;
    }
    return low;
}

/**
 * Move the cut point back from `take` to just after the nearest newline or
 * space. Returns `take` unchanged when there is no whitespace nearby.
 * The return value is the first piece's length, and the separator stays at the
 * end of that piece, so concatenating the pieces still yields the original.
 */
function snapToBoundary(text, take) {
    const floor = Math.ceil(take * (1 - BOUNDARY_SEARCH_RATIO));
    const cut = Math.max(text.lastIndexOf("\n", take - 1), text.lastIndexOf(" ", take - 1));
    return cut + 1 >= floor && cut + 1 < take ? cut + 1 : take;
}

/**
 * Split a passage into pieces where each satisfies "state + this question"
 * within `maxTokens`.
 *
 * Passages already within budget are returned as a single piece, which is the
 * common path and costs one estimate. Oversized ones repeatedly take the
 * longest prefix that fits and continue splitting the remainder. Each piece
 * becomes its own question, so the tail of an oversized passage still gets
 * judged instead of being dropped. Splitting by characters rather than tokens
 * is necessary because the real token count only arrives with the response.
 *
 * @param {number} maxTokens Non-positive or non-finite means unlimited.
 * @returns {string[]} At least one piece; concatenating them yields the
 *     original (except when the budget is too small for even one character,
 *     see the comment in the body).
 */
function splitToTokenBudget(model, query, passage, maxTokens) {
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) return [passage];
    const fits = (text) => estimateStatePlusQuestionTokens(model, query, text) <= maxTokens;
    if (fits(passage)) return [passage];

    const pieces = [];
    let rest = passage;
    while (rest !== "") {
        const take = longestPrefixWithin(fits, rest);
        // Budget too small for even one character (an absurdly low cap):
        // splitting further would produce thousands of empty questions, so
        // send the remainder whole and let the API report a clear error — the
        // same tradeoff as search.js sending an over-budget first question.
        if (take === 0) {
            pieces.push(rest);
            break;
        }
        const length = snapToBoundary(rest, take);
        pieces.push(rest.slice(0, length));
        rest = rest.slice(length);
    }
    return pieces;
}

/**
 * HTTP status code to retryability plus the error message to show.
 * Per jev-api.md 1.4 and 3.1: 401/403 auth, 400 malformed request and 422
 * field validation are all errors that only a change can fix, so retrying
 * just burns quota; 429 rate limiting, 529 overload and gateway 5xx may well
 * clear on their own after a wait.
 */
function classifyStatus(status) {
    if (status >= 200 && status < 300) return { ok: true, retryable: false, errorKey: null };
    if (status === 401 || status === 403) {
        return { ok: false, retryable: false, errorKey: "authFailed" };
    }
    if (status === 400) return { ok: false, retryable: false, errorKey: "badRequest" };
    if (status === 422) return { ok: false, retryable: false, errorKey: "validationFailed" };
    if (status === 429) return { ok: false, retryable: true, errorKey: "rateLimited" };
    if (status === 529) return { ok: false, retryable: true, errorKey: "overloaded" };
    if (status >= 500) return { ok: false, retryable: true, errorKey: "overloaded" };
    return { ok: false, retryable: false, errorKey: "httpError" };
}

/**
 * Pull a human-readable explanation out of an error body. jev returns
 * `{"detail": …}` and the OneAPI gateway returns `{"error": {"message": …}}`;
 * both are handled.
 */
function extractErrorMessage(rawText) {
    const text = typeof rawText === "string" ? rawText.trim() : "";
    if (text === "") return "(empty body)";
    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch (_) {
        return text.length > 300 ? `${text.slice(0, 300)}…` : text;
    }
    if (parsed && typeof parsed === "object") {
        if (parsed.detail !== undefined) {
            return typeof parsed.detail === "string"
                ? parsed.detail
                : JSON.stringify(parsed.detail);
        }
        if (parsed.error && typeof parsed.error === "object"
            && typeof parsed.error.message === "string") {
            return parsed.error.message;
        }
    }
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * Map the response's `answers` back onto this batch's passage order.
 * A noul answer is simply the probability of "yes" (0–1); there is no
 * confidence field. A malformed shape throws an error carrying `detail`, which
 * the caller localizes — that keeps this function pure so unit tests can feed
 * it JSON and assert directly.
 * @returns {number[]} Probabilities, same length as passages.
 */
function parseAnswers(payload, count) {
    const answers = payload && typeof payload === "object" ? payload.answers : null;
    if (!answers || typeof answers !== "object") {
        const error = new AiRequestError("missing \"answers\"", { fatal: true });
        error.detail = "answers";
        throw error;
    }
    const scores = [];
    for (let index = 0; index < count; index++) {
        const answer = answers[questionId(index)];
        const score = answer && typeof answer === "object" ? answer.noul : undefined;
        if (typeof score !== "number" || !Number.isFinite(score)) {
            const detail = `answers.${questionId(index)}.noul`;
            const error = new AiRequestError(`missing "${detail}"`, { fatal: true });
            error.detail = detail;
            throw error;
        }
        // jev rounds to two decimals and should already be within 0–1; clamp
        // anyway so a custom endpoint returning out-of-range values cannot
        // scramble the ordering.
        scores.push(Math.min(1, Math.max(0, score)));
    }
    return scores;
}

/** Interruptible sleep: wakes every CANCEL_POLL_MS to check for cancellation. */
async function sleepCancellable(ms, isCancelled) {
    if (ms <= 0) return;
    let remaining = ms;
    while (remaining > 0) {
        if (isCancelled && isCancelled()) return;
        const chunk = Math.min(CANCEL_POLL_MS, remaining);
        await new Promise((resolve) => setTimeout(resolve, chunk));
        remaining -= chunk;
    }
}

class AiClient {
    /**
     * @param {import("obsidian").Plugin} plugin Source of plugin.settings / uiText.
     * @param {{ requestUrl?: Function, backoffMs?: number }} [options]
     *     Lets unit tests inject a fake requestUrl and zero backoff.
     */
    constructor(plugin, options = {}) {
        this.plugin = plugin;
        this._requestUrl = options.requestUrl || requestUrl;
        this._backoffMs = options.backoffMs !== undefined
            ? options.backoffMs
            : RETRY_BASE_BACKOFF_MS;
    }

    get uiText() {
        return this.plugin.uiText;
    }

    /** The active preset: base URL, model name, API key and rate-limit params. */
    get preset() {
        return activePreset(this.plugin);
    }

    /**
     * Check the settings are complete before sending. Missing fields throw
     * fatal: retrying cannot help, and pointing the user at the settings beats
     * failing silently.
     */
    assertConfigured() {
        const preset = this.preset;
        const missing = !preset || !preset.baseUrl
            ? "missingBaseUrl"
            : !preset.model
                ? "missingModel"
                : !preset.apiKey
                    ? "missingApiKey"
                    : null;
        if (missing) {
            throw new AiRequestError(localizedText(this.uiText.error, missing), { fatal: true });
        }
        return preset;
    }

    get endpoint() {
        const preset = this.preset;
        const baseUrl = preset && preset.baseUrl ? preset.baseUrl.replace(/\/+$/, "") : "";
        return `${baseUrl}${API_PATH}`;
    }

    /** Estimated tokens for this batch's body, for the caller's tokens-per-second limiter. */
    estimateBatchTokens(query, passages) {
        return estimateTokens(buildRequest(this._model, query, passages));
    }

    /**
     * The active model name; empty when unconfigured, which only inflates the
     * estimate slightly.
     */
    get _model() {
        const preset = this.preset;
        return preset && preset.model ? preset.model : "";
    }

    /**
     * The two estimates batching needs: a request's fixed overhead, and the
     * incremental cost of one more question. They are exposed separately so
     * search.js can accumulate while filling a batch instead of re-serializing
     * the whole body per question.
     */
    estimateOverheadTokens(query) {
        return estimateOverheadTokens(this._model, query);
    }

    estimateQuestionTokens(index, passage) {
        return estimateQuestionTokens(index, passage);
    }

    /**
     * Split a passage into pieces whose "state + this question" each stay
     * within `maxTokens`. Backs the "max tokens per question" setting:
     * oversized passages become several questions on send, so their tails are
     * not dropped.
     * @returns {string[]} At least one piece.
     */
    splitPassage(query, passage, maxTokens) {
        return splitToTokenBudget(this._model, query, passage, maxTokens);
    }

    _badResponse(error) {
        const detail = (error && error.detail) || "body";
        return new AiRequestError(
            localizedText(this.uiText.error, "badResponse", { detail }),
            { fatal: true },
        );
    }

    /**
     * Score a batch of passages against the search phrase.
     *
     * Returns null when the caller has cancelled, which is not a failure. On a
     * thrown AiRequestError, `fatal` true means the caller should end the whole
     * search (settings, auth or request-format errors); false means the retry
     * budget is exhausted and the caller may record just this batch as failed.
     *
     * @param {string} query
     * @param {string[]} passages
     * @param {{ isCancelled?: () => boolean }} [options]
     * @returns {Promise<{ scores: number[], usage: object | null } | null>}
     */
    async judge(query, passages, options = {}) {
        const isCancelled = options.isCancelled || (() => false);
        const preset = this.assertConfigured();
        const body = JSON.stringify(buildRequest(preset.model, query, passages));
        const headers = {
            Authorization: `Bearer ${preset.apiKey}`,
            "Content-Type": "application/json",
        };
        let lastError = null;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (isCancelled()) return null;

            let response = null;
            try {
                response = await this._requestUrl({
                    url: this.endpoint,
                    method: "POST",
                    headers,
                    body,
                    // Classify status codes here; otherwise requestUrl throws
                    // on non-2xx and the explanation in detail is lost.
                    throw: false,
                });
            } catch (error) {
                // Network-level failure (offline, DNS, timeout): may clear
                // after a wait.
                lastError = new AiRequestError(
                    localizedText(this.uiText.error, "networkError", {
                        message: errorText(error),
                    }),
                    { fatal: false },
                );
                if (attempt < MAX_ATTEMPTS) {
                    await sleepCancellable(this._retryDelay(attempt), isCancelled);
                    continue;
                }
                break;
            }

            if (isCancelled()) return null;

            const status = Number(response && response.status);
            const verdict = classifyStatus(status);
            if (verdict.ok) {
                const payload = readPayload(response);
                if (payload === null) throw this._badResponse({ detail: "body" });
                try {
                    return {
                        scores: parseAnswers(payload, passages.length),
                        usage: payload.usage || null,
                    };
                } catch (error) {
                    throw this._badResponse(error);
                }
            }

            const message = extractErrorMessage(response && response.text);
            const params = { status, message, attempts: MAX_ATTEMPTS };
            if (!verdict.retryable) {
                throw new AiRequestError(
                    localizedText(this.uiText.error, verdict.errorKey, params),
                    { fatal: true, status },
                );
            }
            lastError = new AiRequestError(
                localizedText(this.uiText.error, verdict.errorKey, params),
                { fatal: false, status },
            );
            if (attempt < MAX_ATTEMPTS) {
                await sleepCancellable(this._retryDelay(attempt), isCancelled);
            }
        }

        if (isCancelled()) return null;
        throw lastError || new AiRequestError(
            localizedText(this.uiText.error, "networkError", { message: "unknown" }),
            { fatal: false },
        );
    }

    /** Exponential backoff — 500ms, 1s, 2s … between retryable failures. */
    _retryDelay(attempt) {
        return this._backoffMs * Math.pow(2, attempt - 1);
    }
}

/**
 * Extract JSON from a response. requestUrl's `.json` is a getter that can
 * throw, so parse `.text` first and return null when both paths fail.
 */
function readPayload(response) {
    if (response && typeof response.text === "string" && response.text !== "") {
        try {
            return JSON.parse(response.text);
        } catch (_) {
            return null;
        }
    }
    try {
        const payload = response && response.json;
        return payload === undefined ? null : payload;
    } catch (_) {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
    AiClient,
    AiRequestError,
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
};
