/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

// ---------------------------------------------------------------------------
// Search business logic
// ---------------------------------------------------------------------------
//
// Turns "search current note / search whole vault" into a series of ai.js
// calls, and keeps progress, cancellation and result ordering in a single
// state snapshot for window.js to render. This file never touches the DOM.
//
// State lives on the controller rather than on the modal, so closing and
// reopening the modal shows exactly what was there before, and a search keeps
// running while the modal is closed. State is memory-only, never persisted --
// caching search results and history is explicitly out of scope.

const { Notice } = require("obsidian");
const {
    NOTICE_DURATION_MS,
    activePreset,
    errorText,
    localizedText,
    normalizeLimit,
} = require("./settings");
const { AiClient } = require("./ai");

// Lines shorter than this are merged into the next one. A bare "1." or
// "- yes" is unjudgeable out of context; merging is both cheaper and more
// accurate.
const MIN_UNIT_CHARS = 10;

// Code blocks and tables skip the per-line split above: each whole block
// becomes one unit. A single table row (`| field | description |`) or a single
// line of code is just as unjudgeable on its own, and a 10-row table split by
// line costs 10 questions instead of 1.

// Rate limit window. Requests per second and tokens per second are both
// tracked over this sliding window.
const RATE_WINDOW_MS = 1000;

// Longest single sleep while waiting on the rate limit, so cancelling takes
// effect quickly.
const RATE_POLL_MS = 200;

const HEADING_RE = /^\s{0,3}#{1,6}\s/;
const FENCE_RE = /^\s{0,3}(?:```|~~~)/;
const FRONTMATTER_DELIM_RE = /^---\s*$/;

// Table row: a pipe makes it a candidate; the following delimiter row decides.
const TABLE_ROW_RE = /\|/;
// One cell of a delimiter row: `---` / `:--` / `--:` / `:-:`.
const TABLE_DELIM_CELL_RE = /^:?-+:?$/;

// A unit needs at least one letter, digit or CJK character, otherwise it is
// just layout punctuation (rules, table borders) with nothing to judge.
const HAS_WORD_RE = /[\p{L}\p{N}]/u;

const SCOPE_FILE = "file";
const SCOPE_VAULT = "vault";

const STATUS_IDLE = "idle";
const STATUS_RUNNING = "running";
const STATUS_DONE = "done";
const STATUS_ABORTED = "aborted";
const STATUS_ERROR = "error";

// ---------------------------------------------------------------------------
// Text splitting
// ---------------------------------------------------------------------------

/** Table delimiter row: `| --- | :-: |`, only hyphens and colons besides pipes. */
function isTableDelimiterRow(text) {
    if (!TABLE_ROW_RE.test(text)) return false;
    const cells = text.replace(/^\|/, "").replace(/\|$/, "").split("|");
    return cells.every((cell) => TABLE_DELIM_CELL_RE.test(cell.trim()));
}

/**
 * A table starts only on a pipe-bearing line immediately followed by a
 * delimiter row -- that structure is required by GFM, so stray pipes in body
 * text are not mistaken for tables.
 */
function isTableStart(lines, index) {
    if (!TABLE_ROW_RE.test(lines[index])) return false;
    return isTableDelimiterRow(index + 1 < lines.length ? lines[index + 1].trim() : "");
}

/**
 * Split a document into judgeable units: one per line, with short lines
 * merged into the next.
 *
 * Code blocks and tables are the exception -- each whole block becomes one
 * unit instead of being split by line: a lone table row or code line is not
 * worth judging, and merging collapses a table's N questions into 1.
 *
 * Skipped: YAML frontmatter (only when `---` is on the first line), blank
 * lines, ATX headings, code fence lines themselves (the fenced code still
 * gets searched), and table delimiter rows.
 *
 * @param {string} content
 * @param {{ minChars?: number }} [options]
 * @returns {{ line: number, text: string }[]} `line` is the 0-based line
 *     number of the unit's first line (the opening fence for code blocks),
 *     used to place the cursor when a result is clicked.
 */
function splitIntoUnits(content, options = {}) {
    const minChars = options.minChars === undefined ? MIN_UNIT_CHARS : options.minChars;
    const lines = String(content === null || content === undefined ? "" : content)
        .split("\n")
        .map((line) => line.replace(/\r$/, "").trim());
    const units = [];
    let pending = null;
    let inFrontmatter = false;

    const flush = () => {
        if (pending !== null && HAS_WORD_RE.test(pending.text)) units.push(pending);
        pending = null;
    };

    // Join a whole block into one unit. Newlines are kept so the body text
    // keeps its structure.
    const pushBlock = (line, parts) => {
        const text = parts.filter((part) => part !== "").join("\n");
        if (HAS_WORD_RE.test(text)) units.push({ line, text });
    };

    for (let index = 0; index < lines.length; index++) {
        const text = lines[index];

        if (index === 0 && FRONTMATTER_DELIM_RE.test(text)) {
            inFrontmatter = true;
            continue;
        }
        if (inFrontmatter) {
            if (FRONTMATTER_DELIM_RE.test(text)) inFrontmatter = false;
            continue;
        }
        if (FENCE_RE.test(text)) {
            flush();
            const start = index;
            const body = [];
            // Consume up to the closing fence (or EOF). Stopping on the
            // closing fence lets the loop's index++ skip it, so neither
            // fence line ends up in the text.
            index += 1;
            while (index < lines.length && !FENCE_RE.test(lines[index])) {
                body.push(lines[index]);
                index += 1;
            }
            pushBlock(start, body);
            continue;
        }
        if (text === "") {
            flush();
            continue;
        }
        if (HEADING_RE.test(text)) {
            flush();
            continue;
        }
        if (isTableStart(lines, index)) {
            flush();
            const start = index;
            const rows = [];
            // The table ends at the first blank or pipe-less line. Delimiter
            // rows are borders only and stay out of the text.
            while (index < lines.length && lines[index] !== ""
                && TABLE_ROW_RE.test(lines[index])) {
                if (!isTableDelimiterRow(lines[index])) rows.push(lines[index]);
                index += 1;
            }
            index -= 1;
            pushBlock(start, rows);
            continue;
        }

        if (pending === null) pending = { line: index, text };
        else pending.text = `${pending.text} ${text}`;
        // Emit the unit once it is long enough; otherwise keep merging.
        if (pending.text.length >= minChars) flush();
    }
    flush();
    return units;
}

/** Plain-text check: cachedRead surfaces NUL bytes for binary files. */
function looksBinary(content) {
    return typeof content === "string" && content.indexOf("\u0000") !== -1;
}

// ---------------------------------------------------------------------------
// File filtering
// ---------------------------------------------------------------------------

/** Folder matching is recursive: the folder itself and any depth below it. */
function isPathUnder(path, folder) {
    if (folder === "") return true;
    return path === folder || path.startsWith(`${folder}/`);
}

/** Exclude wins over include: a folder in both lists is treated as excluded. */
function matchesFolders(path, include, exclude) {
    if (Array.isArray(exclude) && exclude.some((folder) => isPathUnder(path, folder))) {
        return false;
    }
    if (!Array.isArray(include) || include.length === 0) return true;
    return include.some((folder) => isPathUnder(path, folder));
}

/** An empty extension list matches nothing -- settings warns about this. */
function hasAllowedExtension(path, extensions) {
    if (!Array.isArray(extensions) || extensions.length === 0) return false;
    const dot = path.lastIndexOf(".");
    if (dot <= path.lastIndexOf("/")) return false;
    return extensions.includes(path.slice(dot + 1).toLowerCase());
}

/**
 * Candidate files for a whole-vault search.
 * @param {import("obsidian").Vault} vault
 * @param {{ include: string[], exclude: string[], extensions: string[] }} folders
 */
function collectFiles(vault, folders) {
    const files = vault && typeof vault.getFiles === "function" ? vault.getFiles() : [];
    return files.filter((file) => file
        && typeof file.path === "string"
        && hasAllowedExtension(file.path, folders.extensions)
        && matchesFolders(file.path, folders.include, folders.exclude));
}

/**
 * Pack units into batches bounded by max tokens per request.
 *
 * Greedy bin packing: keep adding questions until one more would blow the
 * budget. The first question is sent even when it alone exceeds the budget --
 * it has already been truncated by the per-question limit and there is
 * nowhere left to split it, so better a clear API error than a silent drop.
 *
 * @param {Array} units
 * @param {{
 *   maxTokens: number,
 *   overheadTokens?: number,
 *   questionTokens: (index: number, unit: any) => number,
 * }} budget `overheadTokens` is the fixed cost of model + state + JSON
 *     scaffolding; `questionTokens` gives the extra tokens for packing `unit`
 *     as question `index`. A non-positive or non-finite `maxTokens` means no
 *     limit, so every unit goes into one batch.
 */
function chunkUnits(units, budget = {}) {
    if (units.length === 0) return [];
    const maxTokens = budget.maxTokens;
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) return [units.slice()];
    const overhead = Number.isFinite(budget.overheadTokens) ? budget.overheadTokens : 0;
    const questionTokens = budget.questionTokens || (() => 0);

    const batches = [];
    let current = [];
    let used = overhead;
    for (const unit of units) {
        let cost = questionTokens(current.length, unit);
        if (current.length > 0 && used + cost > maxTokens) {
            batches.push(current);
            current = [];
            used = overhead;
            // In the new batch it becomes question 0, whose shorter id means
            // a different cost.
            cost = questionTokens(0, unit);
        }
        current.push(unit);
        used += cost;
    }
    if (current.length > 0) batches.push(current);
    return batches;
}

/**
 * How many tokens one request may claim, so that `concurrency` of them can be
 * in flight at once.
 *
 * Packing every request to the API's per-request ceiling spends tokens as
 * efficiently as possible and time as badly as possible. jev answers 60
 * questions about as fast as 1 (jev-api.md 1.2), so a fatter request costs
 * roughly the same latency while claiming proportionally more of the
 * tokens-per-second budget -- and the limiter then makes the other workers
 * wait, throttling the very concurrency that was configured. One request is
 * therefore capped at its fair share of the per-second budget, which lets all
 * the workers hold a grant simultaneously.
 *
 * With no per-second budget there is nothing to divide and nothing to gain
 * from splitting (latency being flat in question count), so the API ceiling
 * stands on its own.
 *
 * @returns {number} Possibly Infinity, meaning no limit.
 */
function batchTokenBudget(maxTokensPerRequest, maxTokensPerSecond, concurrency) {
    const fairShare = Number.isFinite(maxTokensPerSecond)
        ? Math.floor(maxTokensPerSecond / concurrency)
        : Infinity;
    return Math.min(maxTokensPerRequest, fairShare);
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Sliding-window limiter over requests per second and tokens per second.
 *
 * `acquire` runs on a single promise chain, so no worker can slip between
 * "check the budget" and "claim the budget" -- otherwise several workers
 * could see the same headroom at once. Queueing also keeps requests going out
 * in order.
 */
class RateLimiter {
    constructor(options = {}) {
        this.maxRequests = options.maxRequestsPerSecond || Infinity;
        this.maxTokens = options.maxTokensPerSecond || Infinity;
        this._now = options.now || (() => Date.now());
        this._sleep = options.sleep
            || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this._events = [];
        this._gate = Promise.resolve();
    }

    _prune(now) {
        const cutoff = now - RATE_WINDOW_MS;
        while (this._events.length > 0 && this._events[0].time <= cutoff) {
            this._events.shift();
        }
    }

    /**
     * Wait for headroom, then claim one request plus `tokens` tokens.
     * @returns {Promise<boolean>} false means it was cancelled while waiting.
     */
    acquire(tokens, isCancelled) {
        const run = async () => {
            for (;;) {
                if (isCancelled && isCancelled()) return false;
                const now = this._now();
                this._prune(now);
                const usedTokens = this._events.reduce((sum, event) => sum + event.tokens, 0);
                const requestOk = this._events.length + 1 <= this.maxRequests;
                // Always let it through on an empty window: a single batch
                // over the per-second cap (tiny cap / huge batch) would
                // otherwise wait for headroom forever.
                const tokenOk = usedTokens + tokens <= this.maxTokens
                    || this._events.length === 0;
                if (requestOk && tokenOk) {
                    this._events.push({ time: now, tokens });
                    return true;
                }
                const oldest = this._events[0];
                const wait = oldest
                    ? Math.max(1, oldest.time + RATE_WINDOW_MS - now)
                    : 1;
                await this._sleep(Math.min(wait, RATE_POLL_MS));
            }
        };
        const chained = this._gate.then(run, run);
        this._gate = chained.then(() => {}, () => {});
        return chained;
    }
}

// ---------------------------------------------------------------------------
// Search state and scheduling
// ---------------------------------------------------------------------------

function emptyState() {
    return {
        query: "",
        status: STATUS_IDLE,
        progress: { completed: 0, total: 0 },
        results: [],
        failedBatches: 0,
        errorMessage: null,
    };
}

function baseNameOf(path) {
    const slash = path.lastIndexOf("/");
    const name = slash === -1 ? path : path.slice(slash + 1);
    const dot = name.lastIndexOf(".");
    return dot <= 0 ? name : name.slice(0, dot);
}

class SearchController {
    /**
     * @param {import("obsidian").Plugin} plugin
     * @param {{ client?: object, makeLimiter?: Function }} [options] Unit test
     *     injection points.
     */
    constructor(plugin, options = {}) {
        this.plugin = plugin;
        this.client = options.client || new AiClient(plugin, options.clientOptions || {});
        this._makeLimiter = options.makeLimiter || ((opts) => new RateLimiter(opts));
        this._listeners = new Set();
        this._activeRun = null;
        this._state = emptyState();
    }

    get state() {
        return this._state;
    }

    get uiText() {
        return this.plugin.uiText;
    }

    isRunning() {
        return this._state.status === STATUS_RUNNING;
    }

    /** window.js subscribes to state changes; returns an unsubscribe function. */
    onChange(listener) {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    _emit() {
        for (const listener of [...this._listeners]) {
            try {
                listener(this._state);
            } catch (error) {
                console.error("ai-search: search state listener failed", error);
            }
        }
    }

    _update(patch) {
        this._state = { ...this._state, ...patch };
        this._emit();
    }

    _notice(key, params = {}) {
        if (this.plugin.__aiSearchUnloaded) return;
        new Notice(localizedText(this.uiText.notice, key, params), NOTICE_DURATION_MS);
    }

    /**
     * The input changed: drop the previous results and cancel any running
     * search -- it judged the old search phrase, so its results should not
     * be shown even if it finishes.
     */
    setQuery(text) {
        const query = String(text === null || text === undefined ? "" : text);
        if (query === this._state.query && this._state.status === STATUS_IDLE) return;
        this.abort();
        // Also detach _activeRun: when the cancelled search wraps up it sees
        // it is no longer the current run, so it neither overwrites this
        // clean state nor shows the "cancelled" notice.
        this._activeRun = null;
        this._state = { ...emptyState(), query };
        this._emit();
    }

    abort() {
        const run = this._activeRun;
        if (run) run.cancelled = true;
    }

    dispose() {
        this.abort();
        this._activeRun = null;
        this._listeners.clear();
    }

    searchCurrentFile() {
        return this._run(SCOPE_FILE);
    }

    searchVault() {
        return this._run(SCOPE_VAULT);
    }

    /** The current preset. */
    get _preset() {
        return activePreset(this.plugin);
    }

    async _run(scope) {
        if (this.isRunning()) {
            this._notice("searchRunning");
            return;
        }
        const query = this._state.query.trim();
        if (query === "") {
            this._notice("emptyQuery");
            return;
        }
        try {
            this.client.assertConfigured();
        } catch (error) {
            // Missing base URL / model name / key: the message is already a
            // full sentence in the current language.
            if (!this.plugin.__aiSearchUnloaded) {
                new Notice(errorText(error), NOTICE_DURATION_MS);
            }
            return;
        }

        const run = { cancelled: false };
        this._activeRun = run;
        // Enter the running state before reading files: scanning the whole
        // vault takes time too, and the modal should already show the
        // progress bar and cancel button while it happens.
        this._update({
            status: STATUS_RUNNING,
            progress: { completed: 0, total: 0 },
            results: [],
            failedBatches: 0,
            errorMessage: null,
        });

        let units = null;
        try {
            units = await this._collectUnits(scope, run);
        } catch (error) {
            console.error("ai-search: failed to collect searchable text", error);
            this._finishWithError(run, error);
            return;
        }
        if (run !== this._activeRun) return;
        if (run.cancelled) {
            this._update({ status: STATUS_ABORTED, progress: { completed: 0, total: 0 } });
            this._notice("aborted", { count: 0 });
            return;
        }
        if (units === null) {
            // The reason (no open note / no matching files) was already
            // shown as a notice.
            this._update({ status: STATUS_IDLE, progress: { completed: 0, total: 0 } });
            return;
        }
        if (units.length === 0) {
            this._update({ status: STATUS_IDLE, progress: { completed: 0, total: 0 } });
            this._notice("noUnits");
            return;
        }

        // _execute computes the progress denominator (the question count
        // after splitting); filling in a unit count here would make the
        // progress bar flash a wrong denominator.
        await this._execute(run, query, units);
    }

    /**
     * Expand units into questions: a unit over the max tokens per question is
     * split into several questions, so one question maps to one passage to be
     * sent, while several questions can come from the same unit.
     */
    _buildEntries(query, units, maxTokensPerQuestion) {
        const entries = [];
        for (const unit of units) {
            const passages = this.client.splitPassage(query, unit.text, maxTokensPerQuestion);
            for (const passage of passages) entries.push({ unit, passage });
        }
        return entries;
    }

    /**
     * Read every judgeable unit in the current scope.
     * @returns {Promise<Array|null>} null means a notice was already shown
     *     and this search should not continue.
     */
    async _collectUnits(scope, run) {
        const app = this.plugin.app;
        const vault = app.vault;
        if (scope === SCOPE_FILE) {
            const file = typeof app.workspace.getActiveFile === "function"
                ? app.workspace.getActiveFile()
                : null;
            if (!file) {
                this._notice("noActiveFile");
                return null;
            }
            // Searching the current note skips the extension filter -- the
            // note the user opened is the target; binary content is still
            // rejected.
            return await this._readUnits(vault, file, true);
        }

        const folders = this.plugin.settings.folders;
        const files = collectFiles(vault, folders);
        if (files.length === 0) {
            this._notice("noFiles");
            return null;
        }
        const units = [];
        for (const file of files) {
            if (run.cancelled) return units;
            const fileUnits = await this._readUnits(vault, file, false);
            if (fileUnits !== null) units.push(...fileUnits);
        }
        return units;
    }

    /**
     * Read one file and split it into units.
     * @returns {Promise<Array|null>} null is only for a read failure (a vault
     *     scan just logs it, otherwise one bad file would flood the screen
     *     with notices); non-plain-text returns an empty array so searching
     *     the current note reaches the "no searchable text" notice instead of
     *     silently doing nothing.
     */
    async _readUnits(vault, file, noticeOnError) {
        let content = null;
        try {
            content = await vault.cachedRead(file);
        } catch (error) {
            console.error("ai-search: failed to read", file.path, error);
            if (noticeOnError && !this.plugin.__aiSearchUnloaded) {
                new Notice(localizedText(this.uiText.error, "readFailed", { path: file.path }),
                    NOTICE_DURATION_MS);
            }
            return null;
        }
        if (looksBinary(content)) return [];
        const basename = file.basename || baseNameOf(file.path);
        return splitIntoUnits(content).map((unit) => ({
            path: file.path,
            basename,
            line: unit.line,
            text: unit.text,
        }));
    }

    /** Run every batch at the configured concurrency and rate limit, then wrap up. */
    async _execute(run, query, units) {
        const preset = this._preset || {};
        const concurrency = normalizeLimit(preset.maxConcurrentRequests) || 1;
        const maxTokensPerRequest = normalizeLimit(preset.maxTokensPerRequest) || Infinity;
        const maxTokensPerQuestion = normalizeLimit(preset.maxTokensPerQuestion) || Infinity;
        const maxTokensPerSecond = normalizeLimit(preset.maxTokensPerSecond) || Infinity;
        const threshold = typeof preset.relevanceThreshold === "number"
            ? preset.relevanceThreshold
            : 0.5;
        const limiter = this._makeLimiter({
            maxRequestsPerSecond: normalizeLimit(preset.maxRequestsPerSecond) || Infinity,
            maxTokensPerSecond,
        });
        // Split by the per-question limit first, then pack by the per-request
        // limit -- packing needs the post-split lengths, or a shortened
        // question would be priced as the original. Splitting can turn one
        // unit into several questions, so progress counts questions, not
        // units.
        const entries = this._buildEntries(query, units, maxTokensPerQuestion);
        const total = entries.length;
        const batches = chunkUnits(entries, {
            maxTokens: batchTokenBudget(maxTokensPerRequest, maxTokensPerSecond, concurrency),
            overheadTokens: this.client.estimateOverheadTokens(query),
            questionTokens: (index, entry) => this.client
                .estimateQuestionTokens(index, entry.passage),
        });
        this._publishProgress(run, 0, total);
        const isCancelled = () => run.cancelled || Boolean(this.plugin.__aiSearchUnloaded);

        let nextBatch = 0;
        let completed = 0;
        let failedBatches = 0;
        let fatalError = null;
        // Keyed by the unit object itself: a unit split into several
        // questions yields one result, scored by the highest of its passages
        // -- any relevant passage makes the unit worth reading.
        const best = new Map();

        const worker = async () => {
            for (;;) {
                if (isCancelled()) return;
                // `nextBatch++` cannot be interrupted on a single thread, so
                // no extra locking is needed.
                const index = nextBatch++;
                if (index >= batches.length) return;
                const batch = batches[index];
                const passages = batch.map((entry) => entry.passage);
                const granted = await limiter.acquire(
                    this.client.estimateBatchTokens(query, passages),
                    isCancelled,
                );
                if (!granted || isCancelled()) return;

                let outcome = null;
                try {
                    outcome = await this.client.judge(query, passages, { isCancelled });
                } catch (error) {
                    if (error && error.fatal) {
                        // Config / auth / malformed request: more batches
                        // will fail the same way, so stop the other workers
                        // too.
                        fatalError = error;
                        run.cancelled = true;
                        return;
                    }
                    // Recoverable error with retries exhausted: record this
                    // batch as failed and move on to the others.
                    failedBatches += 1;
                    completed += batch.length;
                    this._publishProgress(run, completed, total);
                    continue;
                }
                if (outcome === null) return;

                outcome.scores.forEach((score, offset) => {
                    if (score < threshold) return;
                    // Display uses unit.text (the full text), not the passage
                    // that was sent.
                    const unit = batch[offset].unit;
                    const previous = best.get(unit);
                    if (previous === undefined || score > previous) best.set(unit, score);
                });
                completed += batch.length;
                this._publishProgress(run, completed, total);
            }
        };

        const workers = [];
        const parallel = Math.max(1, Math.min(concurrency, batches.length));
        for (let index = 0; index < parallel; index++) workers.push(worker());
        await Promise.all(workers);

        const collected = [...best].map(([unit, score]) => ({ ...unit, score }));
        this._finish(run, { collected, failedBatches, fatalError, completed, total });
    }

    _publishProgress(run, completed, total) {
        if (run !== this._activeRun) return;
        this._update({ progress: { completed, total } });
    }

    /**
     * Sort, commit state, show a notice. Higher relevance first, with ties
     * broken by path then line for a stable order.
     */
    _finish(run, { collected, failedBatches, fatalError, completed, total }) {
        if (run !== this._activeRun) return;
        const results = collected.slice().sort((left, right) => {
            if (right.score !== left.score) return right.score - left.score;
            if (left.path !== right.path) return left.path < right.path ? -1 : 1;
            return left.line - right.line;
        });

        if (fatalError) {
            this._update({
                status: STATUS_ERROR,
                results,
                failedBatches,
                progress: { completed, total },
                errorMessage: errorText(fatalError),
            });
            if (!this.plugin.__aiSearchUnloaded) {
                new Notice(this._state.errorMessage, NOTICE_DURATION_MS);
            }
            return;
        }

        const aborted = run.cancelled;
        this._update({
            status: aborted ? STATUS_ABORTED : STATUS_DONE,
            results,
            failedBatches,
            progress: { completed, total },
        });
        if (aborted) this._notice("aborted", { count: results.length });
        else this._notice("done", { count: results.length });
        if (failedBatches > 0) this._notice("batchFailed", { count: failedBatches });
    }

    _finishWithError(run, error) {
        if (run !== this._activeRun) return;
        const message = errorText(error);
        this._update({ status: STATUS_ERROR, errorMessage: message });
        if (!this.plugin.__aiSearchUnloaded) new Notice(message, NOTICE_DURATION_MS);
    }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
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
    emptyState,
};
