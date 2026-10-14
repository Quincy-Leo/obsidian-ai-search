/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

const { Notice, PluginSettingTab, Setting, normalizePath } = require("obsidian");

// Shared by every module that raises a Notice. Declared here because the other
// three files already depend on this one, so there is no import cycle.
const NOTICE_DURATION_MS = 4000;

// Bump this when the on-disk schema changes in a way old code can't read.
// Lower versions are refused as invalid on read (and backed up on write);
// higher versions mean the file was written by a newer plugin build.
const SETTINGS_SCHEMA_VERSION = 1;

const PRESET_JEV = "jev";
const PRESET_CUSTOM = "custom";
const PRESET_IDS = [PRESET_JEV, PRESET_CUSTOM];

// Path appended to the configured base URL. Declared here rather than in
// ai.js because the settings page shows it inside the base-URL description,
// and ai.js already depends on this module (importing the other way round
// would make the two files circular).
const API_PATH = "/v1/systemone";

// Rate-limit defaults for the Jev preset. Hard-coded on purpose: the plugin
// must not have to read jev-api.md at runtime. Values come from the published
// limits — 80 requests/s, 100K tokens/s, 64k tokens per request, and 32k
// tokens for `state` plus the longest single question.
const JEV_PRESET_DEFAULTS = {
    baseUrl: "https://api.typesafe.ai",
    model: "jev-latest",
    apiKey: "",
    maxConcurrentRequests: 8,
    maxTokensPerRequest: 64000,
    maxTokensPerQuestion: 32000,
    maxRequestsPerSecond: 80,
    maxTokensPerSecond: 100000,
    relevanceThreshold: 0.6,
};

// The custom preset knows nothing about the endpoint behind it, so the three
// connection fields start blank and the user fills them in. The limits and the
// threshold keep the same workable defaults as the Jev preset — blank would
// read as "serial" / "unlimited" (see normalizeLimit()), which is a worse
// starting point than a conservative number.
const CUSTOM_PRESET_DEFAULTS = {
    baseUrl: "",
    model: "",
    apiKey: "",
    maxConcurrentRequests: 8,
    maxTokensPerRequest: 64000,
    maxTokensPerQuestion: 32000,
    maxRequestsPerSecond: 80,
    maxTokensPerSecond: 100000,
    relevanceThreshold: 0.6,
};

const FOLDER_DEFAULTS = { include: [], exclude: [], extensions: ["md", "txt"] };

const LANGUAGE_OPTIONS = [
    {
        value: "zh-CN",
        label: "中文",
        commandName: "AI 模糊搜索",
        ribbonTitle: "AI 模糊搜索",
        notice: {
            noActiveFile: "ai-search：请先打开一个文档。",
            searchRunning: "ai-search：已有搜索正在进行中。",
            noFiles: "ai-search：没有符合目录与拓展名设置的文档。",
            noUnits: "ai-search：选中范围内没有可搜索的文本。",
            emptyQuery: "ai-search：请先输入要搜索的内容。",
            done: "ai-search：搜索完成，找到 {count} 个相关段落。",
            aborted: "ai-search：已终止搜索，展示已获得的 {count} 个结果。",
            batchFailed: "ai-search：{count} 个批次请求失败，结果可能不完整。",
        },
        error: {
            settingsMissingVersion:
                "ai-search：配置文件缺少 “version” 字段；期望值为 {expected}。",
            settingsInvalidVersion:
                "ai-search：配置文件的 “version” 字段非法（{actual}）；期望值为 {expected}。",
            settingsVersionTooNew:
                "ai-search：配置版本 {actual} 高于插件支持的版本 {expected}；请升级插件。",
            settingsBackupFailed:
                "ai-search：备份旧配置文件失败：{message}",
            missingBaseUrl: "ai-search：请先在设置中填写模型的 base URL。",
            missingModel: "ai-search：请先在设置中填写模型名称。",
            missingApiKey: "ai-search：请先在设置中填写模型密钥。",
            authFailed: "ai-search：鉴权失败（HTTP {status}）；请检查模型密钥。",
            badRequest: "ai-search：请求不合法（HTTP 400）：{message}",
            validationFailed: "ai-search：请求字段校验失败（HTTP 422）：{message}",
            rateLimited: "ai-search：触发接口限流（HTTP 429），重试 {attempts} 次后仍失败；请降低设置中的并发或速率。",
            overloaded: "ai-search：服务暂时过载（HTTP {status}），重试 {attempts} 次后仍失败；请稍后再试。",
            httpError: "ai-search：接口返回 HTTP {status}：{message}",
            badResponse: "ai-search：接口响应缺少预期的答案字段（{detail}）。",
            networkError: "ai-search：请求发送失败：{message}",
            readFailed: "ai-search：读取文档失败：{path}",
        },
        settingsText: {
            languageName: "Language / 语言",
            languageDesc: "插件显示的界面语言。",
            aiHeading: "模型设置",
            presetName: "预设",
            presetDesc: "切换一组独立保存的 AI 配置。切换后下面各项会显示该预设自己的值。",
            presetJevLabel: "Jev",
            presetCustomLabel: "自定义",
            baseUrlName: "Base URL",
            baseUrlDesc: "模型服务地址，不含路径。请求会发往 {path}。",
            modelName: "模型名称",
            modelDesc: "写进请求体 “model” 字段的模型名。",
            apiKeyName: "模型密钥",
            apiKeyDesc: "作为 Authorization 请求头发送，明文存在 data.json。",
            concurrencyName: "最大并发请求数",
            concurrencyDesc: "同时在途的请求数上限。留空表示串行（一次 1 个请求）。",
            tokensPerRequestName: "每请求最大 token 数",
            tokensPerRequestDesc:
                "一个请求的 token 预算（刻意高估）。留空表示所有段落合并为一个请求。",
            tokensPerQuestionName: "单题最大 token 数",
            tokensPerQuestionDesc:
                "搜索词加单个段落的 token 上限，超长段落发送时拆成多道题。留空表示不拆分。",
            requestsPerSecondName: "每秒请求上限",
            requestsPerSecondDesc: "每秒最多发出多少个请求。留空表示不限制。",
            tokensPerSecondName: "每秒 token 上限",
            tokensPerSecondDesc:
                "每秒最多发出多少 token（按长度估算）。留空表示不限制。",
            thresholdName: "相关度阈值",
            thresholdDesc:
                "相关概率低于该值的段落不进入结果列表。取值 0–1。",
            resetAiName: "重置 AI 设置",
            resetAiDesc: "把当前预设的各项恢复为它的默认值，不影响另一个预设。",
            resetAiButton: "重置 AI 设置",
            resetAiDone: "ai-search：已重置预设 “{preset}” 的 AI 设置。",
            folderHeading: "目录设置",
            includeName: "搜索哪些目录",
            includeDesc:
                "相对于仓库根目录的路径，一行一个，自动包含子目录。留空表示整个仓库。",
            includePlaceholder: "例如：\n笔记\n项目/2026",
            excludeName: "排除哪些目录",
            excludeDesc:
                "相对于仓库根目录的路径，一行一个，自动包含子目录。留空表示不排除。",
            excludePlaceholder: "例如：\n模板\n归档",
            extensionsName: "搜索哪些拓展名",
            extensionsDesc:
                "英文逗号分隔，不含点号。仅支持纯文本文档，PDF、图片等会被忽略。",
            extensionsPlaceholder: "md,txt",
            resetFoldersName: "重置目录设置",
            resetFoldersDesc: "把上面三项恢复为默认值。",
            resetFoldersButton: "重置目录设置",
            resetFoldersDone: "ai-search：已重置目录设置。",
            resetAllName: "重置所有设置",
            resetAllDesc: "把语言、全部预设和目录设置一并恢复为默认值。",
            resetAllButton: "重置所有设置",
            resetAllDone: "ai-search：已重置所有设置。",
            invalidNumber: "ai-search：“{name}” 需要填一个正数，已忽略本次输入。",
            invalidThreshold: "ai-search：“{name}” 需要填 0 到 1 之间的数，已忽略本次输入。",
            saveFailed: "ai-search：保存设置失败：{message}",
        },
        ui: {
            placeholder: "输入要搜索的内容……",
            searchFile: "搜本文",
            searchFileTooltip: "搜本文（Enter）",
            searchVault: "搜全库",
            searchVaultTooltip: "搜全库（Shift+Enter）",
            abort: "终止",
            progress: "{completed}/{total}（{percent}%）",
            running: "正在搜索……",
            noResults: "没有找到相关段落。",
            resultCount: "{count} 个相关段落",
        },
    },
    {
        value: "en",
        label: "English",
        commandName: "AI fuzzy search",
        ribbonTitle: "AI fuzzy search",
        notice: {
            noActiveFile: "ai-search: open a note first.",
            searchRunning: "ai-search: a search is already running.",
            noFiles: "ai-search: no note matches the folder and extension settings.",
            noUnits: "ai-search: no searchable text in the selected scope.",
            emptyQuery: "ai-search: type something to search for first.",
            done: "ai-search: search finished, {count} relevant passage(s) found.",
            aborted: "ai-search: search stopped, showing the {count} result(s) collected so far.",
            batchFailed: "ai-search: {count} batch request(s) failed; results may be incomplete.",
        },
        error: {
            settingsMissingVersion:
                "ai-search: settings file is missing \"version\"; expected {expected}.",
            settingsInvalidVersion:
                "ai-search: settings file has an invalid \"version\" field ({actual}); expected {expected}.",
            settingsVersionTooNew:
                "ai-search: settings version {actual} is newer than the supported version {expected}; please upgrade the plugin.",
            settingsBackupFailed:
                "ai-search: failed to back up the old settings file: {message}",
            missingBaseUrl: "ai-search: set the model base URL in Settings first.",
            missingModel: "ai-search: set the model name in Settings first.",
            missingApiKey: "ai-search: set the model API key in Settings first.",
            authFailed: "ai-search: authentication failed (HTTP {status}); check the API key.",
            badRequest: "ai-search: invalid request (HTTP 400): {message}",
            validationFailed: "ai-search: request validation failed (HTTP 422): {message}",
            rateLimited: "ai-search: rate limited (HTTP 429) after {attempts} attempt(s); lower the concurrency or rate in Settings.",
            overloaded: "ai-search: service temporarily overloaded (HTTP {status}) after {attempts} attempt(s); try again later.",
            httpError: "ai-search: endpoint returned HTTP {status}: {message}",
            badResponse: "ai-search: response is missing the expected answer field ({detail}).",
            networkError: "ai-search: request failed to send: {message}",
            readFailed: "ai-search: failed to read note: {path}",
        },
        settingsText: {
            languageName: "Language",
            languageDesc: "Interface language for plugin.",
            aiHeading: "Model",
            presetName: "Preset",
            presetDesc:
                "Switch between stored AI configurations.",
            presetJevLabel: "Jev",
            presetCustomLabel: "Custom",
            baseUrlName: "Base URL",
            baseUrlDesc: "Endpoint host only. Requests go to {path}.",
            modelName: "Model name",
            modelDesc: "Value sent as the request body's \"model\" field.",
            apiKeyName: "API key",
            apiKeyDesc:
                "Sent as the Authorization header, in plain text.",
            concurrencyName: "Max concurrent requests",
            concurrencyDesc:
                "Max in-flight requests. Blank runs serially.",
            tokensPerRequestName: "Max tokens per request",
            tokensPerRequestDesc:
                "Token budget per request. Blank means no limit.",
            tokensPerQuestionName: "Max tokens per question",
            tokensPerQuestionDesc:
                "Cap on phrase plus passage. Long passages are split into several questions. Blank never splits.",
            requestsPerSecondName: "Max requests per second",
            requestsPerSecondDesc: "Requests sent per second. Blank means no limit.",
            tokensPerSecondName: "Max tokens per second",
            tokensPerSecondDesc:
                "Tokens sent per second. Blank means no limit.",
            thresholdName: "Relevance threshold",
            thresholdDesc:
                "Passages below this probability are dropped. 0–1.",
            resetAiName: "Reset AI settings",
            resetAiDesc:
                "Restore the selected preset to its defaults only.",
            resetAiButton: "Reset AI settings",
            resetAiDone: "ai-search: AI settings of preset \"{preset}\" reset.",
            folderHeading: "Folders",
            includeName: "Folders to search",
            includeDesc:
                "Vault-relative paths, one per line. Blank = all.",
            includePlaceholder: "for example:\nNotes\nProjects/2026",
            excludeName: "Folders to exclude",
            excludeDesc:
                "Vault-relative paths, one per line. Blank = none.",
            excludePlaceholder: "for example:\nTemplates\nArchive",
            extensionsName: "File extensions to search",
            extensionsDesc:
                "Comma-separated, no dots. Plain-text notes only.",
            extensionsPlaceholder: "md,txt",
            resetFoldersName: "Reset folder settings",
            resetFoldersDesc: "Restore the three fields above to their defaults.",
            resetFoldersButton: "Reset folder settings",
            resetFoldersDone: "ai-search: folder settings reset.",
            resetAllName: "Reset all settings",
            resetAllDesc: "Restore language, presets and folders to defaults.",
            resetAllButton: "Reset all settings",
            resetAllDone: "ai-search: all settings reset.",
            invalidNumber: "ai-search: \"{name}\" needs a positive number; input ignored.",
            invalidThreshold: "ai-search: \"{name}\" needs a number between 0 and 1; input ignored.",
            saveFailed: "ai-search: failed to save settings: {message}",
        },
        ui: {
            placeholder: "Type what to search for…",
            searchFile: "This note",
            searchFileTooltip: "This note (Enter)",
            searchVault: "Whole vault",
            searchVaultTooltip: "Whole vault (Shift+Enter)",
            abort: "Stop",
            progress: "{completed}/{total} ({percent}%)",
            running: "Searching…",
            noResults: "No relevant passage found.",
            resultCount: "{count} relevant passage(s)",
        },
    },
];

const DEFAULT_LANGUAGE = LANGUAGE_OPTIONS[0].value;

/**
 * Render an error message in every supported language, joined on newlines.
 * Used ONLY for errors that can fire before we know which language the user
 * picked — chiefly settings-load failures, which happen before
 * `settings.value` exists. Once settings are loaded, prefer
 * `localizedText(uiText.error, …)` so users don't see two languages in one
 * Notice.
 *
 * @param {string} key Key inside each LANGUAGE_OPTIONS entry's `error` object.
 * @param {Record<string, string | number>} [params] Placeholder values.
 */
function bilingualError(key, params = {}) {
    return LANGUAGE_OPTIONS
        .map((option) => formatTemplate(option.error[key] || "", params))
        .filter(Boolean)
        .join("\n");
}

/**
 * Render an `error`/`notice`/`settingsText`/`ui` template in the current
 * language. Error templates already begin with `ai-search:` / `ai-search：`,
 * so callers feeding one into a Notice should NOT prefix it again.
 *
 * @param {Record<string, string>} group One group inside `plugin.uiText`.
 * @param {string} key Key inside that group.
 * @param {Record<string, string | number>} [params] Placeholder values.
 */
function localizedText(group, key, params = {}) {
    const template = (group && group[key]) || "";
    return formatTemplate(template, params);
}

/** A thrown value's human-readable text, whether or not it is an Error. */
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}

/** The preset a search should run with, or null when settings are unreadable. */
function activePreset(plugin) {
    const settings = plugin && plugin.settings;
    return (settings && settings.presets[settings.currentPreset]) || null;
}

function formatTemplate(template, params) {
    let out = template;
    for (const [name, value] of Object.entries(params)) {
        out = out.split(`{${name}}`).join(String(value));
    }
    return out;
}

// ---------------------------------------------------------------------------
// Normalisers — every value that reaches disk or the search engine goes
// through one of these, so a hand-edited data.json cannot inject odd types.
// ---------------------------------------------------------------------------

function presetDefaults(presetId) {
    return presetId === PRESET_CUSTOM
        ? { ...CUSTOM_PRESET_DEFAULTS }
        : { ...JEV_PRESET_DEFAULTS };
}

/**
 * A blank limit means "no opinion". The two batch-size knobs fall back to 1
 * (serial / one question per request) because 0 or Infinity would be
 * nonsense; the two rate knobs fall back to Infinity (unlimited) in
 * search.js. Non-positive or unparsable input is treated as blank.
 * @returns {number | null} Positive integer, or null for blank.
 */
function normalizeLimit(value) {
    if (value === null || value === undefined || value === "") return null;
    const num = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isFinite(num) || num <= 0) return null;
    return Math.floor(num);
}

/** Relevance cut-off, clamped into [0, 1]. Blank or invalid input → 0.5. */
function normalizeThreshold(value) {
    if (value === null || value === undefined) return 0.5;
    const raw = typeof value === "number" ? value : String(value).trim();
    if (raw === "") return 0.5;
    const num = Number(raw);
    if (!Number.isFinite(num)) return 0.5;
    return Math.min(1, Math.max(0, num));
}

/** Trim a vault-relative folder path; the vault root collapses to "". */
function normalizeFolderPath(raw) {
    let path = String(raw ?? "").trim().replace(/\\/g, "/");
    if (path === "") return "";
    path = normalizePath(path);
    path = path.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
    return path === "." ? "" : path;
}

/** Textarea text → folder path list. Blank lines and the root are dropped. */
function parseFolderList(text) {
    const seen = new Set();
    for (const line of String(text ?? "").split(/\r?\n/)) {
        const path = normalizeFolderPath(line);
        if (path !== "") seen.add(path);
    }
    return [...seen];
}

function formatFolderList(list) {
    return Array.isArray(list) ? list.join("\n") : "";
}

/** "MD, .txt" → ["md", "txt"]. Dots and case are normalised away. */
function parseExtensionList(text) {
    const seen = new Set();
    for (const part of String(text ?? "").split(",")) {
        const ext = part.trim().toLowerCase().replace(/^\.+/, "");
        if (ext !== "") seen.add(ext);
    }
    return [...seen];
}

function formatExtensionList(list) {
    return Array.isArray(list) ? list.join(",") : "";
}

function normalizePresetValue(raw, presetId) {
    const defaults = presetDefaults(presetId);
    const saved = raw && typeof raw === "object" ? raw : {};
    const text = (key) => (typeof saved[key] === "string" ? saved[key].trim() : defaults[key]);
    const limit = (key) => (Object.prototype.hasOwnProperty.call(saved, key)
        ? normalizeLimit(saved[key])
        : defaults[key]);
    return {
        baseUrl: text("baseUrl").replace(/\/+$/, ""),
        model: text("model"),
        // The key is kept verbatim — trimming could silently break a key that
        // legitimately ends in whitespace, and users paste these by hand.
        apiKey: typeof saved.apiKey === "string" ? saved.apiKey : defaults.apiKey,
        maxConcurrentRequests: limit("maxConcurrentRequests"),
        maxTokensPerRequest: limit("maxTokensPerRequest"),
        maxTokensPerQuestion: limit("maxTokensPerQuestion"),
        maxRequestsPerSecond: limit("maxRequestsPerSecond"),
        maxTokensPerSecond: limit("maxTokensPerSecond"),
        relevanceThreshold: Object.prototype.hasOwnProperty.call(saved, "relevanceThreshold")
            ? normalizeThreshold(saved.relevanceThreshold)
            : defaults.relevanceThreshold,
    };
}

function normalizeFoldersValue(raw) {
    const saved = raw && typeof raw === "object" ? raw : {};
    const list = (key) => (Array.isArray(saved[key])
        ? parseFolderList(saved[key].join("\n"))
        : [...FOLDER_DEFAULTS[key]]);
    return {
        include: list("include"),
        exclude: list("exclude"),
        extensions: Array.isArray(saved.extensions)
            ? parseExtensionList(saved.extensions.join(","))
            : [...FOLDER_DEFAULTS.extensions],
    };
}

function defaultSettings() {
    return {
        version: SETTINGS_SCHEMA_VERSION,
        language: DEFAULT_LANGUAGE,
        currentPreset: PRESET_JEV,
        presets: {
            [PRESET_JEV]: presetDefaults(PRESET_JEV),
            [PRESET_CUSTOM]: presetDefaults(PRESET_CUSTOM),
        },
        folders: { ...FOLDER_DEFAULTS, include: [], exclude: [], extensions: [...FOLDER_DEFAULTS.extensions] },
    };
}

/**
 * Validate the `version` field of a file we are about to read.
 * @throws {Error} Bilingual message when the file cannot be read by this build.
 */
function assertReadableVersion(saved) {
    if (!Object.prototype.hasOwnProperty.call(saved, "version")) {
        throw new Error(bilingualError("settingsMissingVersion", {
            expected: SETTINGS_SCHEMA_VERSION,
        }));
    }
    const version = saved.version;
    if (!Number.isInteger(version) || version < SETTINGS_SCHEMA_VERSION) {
        // "Smaller than 1" and "not a version at all" are the same failure for
        // the reader: there is no older schema this build knows how to migrate.
        throw new Error(bilingualError("settingsInvalidVersion", {
            actual: JSON.stringify(version),
            expected: SETTINGS_SCHEMA_VERSION,
        }));
    }
    if (version > SETTINGS_SCHEMA_VERSION) {
        throw new Error(bilingualError("settingsVersionTooNew", {
            actual: JSON.stringify(version),
            expected: SETTINGS_SCHEMA_VERSION,
        }));
    }
}

class AiSearchSettings {
    constructor(plugin, onChanged) {
        this.plugin = plugin;
        this.onChanged = onChanged || (() => {});
        this.value = null;
        // Writes are serialised through this chain so two quick edits land on
        // disk in the order the user made them. Each task snapshots `value` at
        // write time, so the last write always persists the newest state.
        this._saveChain = Promise.resolve();
    }

    get uiText() {
        const language = this.value && this.value.language;
        return LANGUAGE_OPTIONS.find((option) => option.value === language)
            || LANGUAGE_OPTIONS[0];
    }

    /** The sub-object of `presets` the user is currently editing. */
    get preset() {
        if (!this.value) return presetDefaults(PRESET_JEV);
        return this.value.presets[this.value.currentPreset]
            || presetDefaults(this.value.currentPreset);
    }

    async load() {
        const savedData = await this.plugin.loadData();
        const isFreshInstall = savedData === null || savedData === undefined;
        const saved = savedData && typeof savedData === "object" ? savedData : {};

        if (!isFreshInstall) assertReadableVersion(saved);

        const language = LANGUAGE_OPTIONS.some((option) => option.value === saved.language)
            ? saved.language
            : DEFAULT_LANGUAGE;
        const currentPreset = PRESET_IDS.includes(saved.currentPreset)
            ? saved.currentPreset
            : PRESET_JEV;
        const savedPresets = saved.presets && typeof saved.presets === "object"
            ? saved.presets
            : {};
        const presets = {};
        for (const id of PRESET_IDS) {
            // Each preset is normalised on its own, so a malformed custom
            // preset cannot corrupt the Jev one (or vice versa).
            presets[id] = normalizePresetValue(savedPresets[id], id);
        }

        this.value = {
            version: SETTINGS_SCHEMA_VERSION,
            language,
            currentPreset,
            presets,
            folders: normalizeFoldersValue(saved.folders),
        };
        return this.value;
    }

    /**
     * Replace `value` with `next` and persist it. The object is replaced
     * rather than mutated so an in-flight write owns an immutable snapshot.
     */
    async _commit(next) {
        this.value = next;
        try {
            await this._enqueueSave();
        } catch (error) {
            // A failed write must not leave the UI showing a value that is not
            // on disk: reload what is actually stored and let the caller report.
            try {
                await this.load();
            } catch (loadError) {
                console.error("ai-search: failed to reload settings after save failure", loadError);
            }
            this.onChanged();
            throw error;
        }
        this.onChanged();
    }

    _enqueueSave() {
        const task = () => this._writeToDisk({ ...this.value });
        const chained = this._saveChain.then(task, task);
        // Keep the chain alive after a rejection so later edits still run.
        this._saveChain = chained.then(() => {}, () => {});
        return chained;
    }

    /**
     * Version-check what is already on disk, then write. A file older than
     * this build is backed up to `data.json.bak` and replaced; a newer file is
     * refused so a downgrade cannot quietly destroy newer settings.
     */
    async _writeToDisk(snapshot) {
        const existing = await this.plugin.loadData();
        if (existing && typeof existing === "object") {
            const version = existing.version;
            if (Number.isInteger(version) && version > SETTINGS_SCHEMA_VERSION) {
                throw new Error(localizedText(this.uiText.error, "settingsVersionTooNew", {
                    actual: JSON.stringify(version),
                    expected: SETTINGS_SCHEMA_VERSION,
                }));
            }
            if (!Number.isInteger(version) || version < SETTINGS_SCHEMA_VERSION) {
                await this._backupLegacyFile(existing);
            }
        }
        await this.plugin.saveData(snapshot);
    }

    async _backupLegacyFile(existing) {
        const adapter = this.plugin.app && this.plugin.app.vault
            && this.plugin.app.vault.adapter;
        const dir = this.plugin.manifest && this.plugin.manifest.dir;
        if (!adapter || typeof adapter.write !== "function" || !dir) {
            throw new Error(localizedText(this.uiText.error, "settingsBackupFailed", {
                message: "vault adapter unavailable",
            }));
        }
        try {
            await adapter.write(
                normalizePath(`${dir}/data.json.bak`),
                JSON.stringify(existing, null, 2),
            );
        } catch (error) {
            throw new Error(localizedText(this.uiText.error, "settingsBackupFailed", {
                message: errorText(error),
            }));
        }
    }

    async setLanguage(language) {
        if (!LANGUAGE_OPTIONS.some((option) => option.value === language)) return;
        await this._commit({ ...this.value, language });
    }

    async setCurrentPreset(presetId) {
        if (!PRESET_IDS.includes(presetId)) return;
        await this._commit({ ...this.value, currentPreset: presetId });
    }

    /** Patch the currently-selected preset; the other preset is untouched. */
    async updatePreset(patch) {
        const id = this.value.currentPreset;
        const next = normalizePresetValue({ ...this.value.presets[id], ...patch }, id);
        await this._commit({
            ...this.value,
            presets: { ...this.value.presets, [id]: next },
        });
    }

    async updateFolders(patch) {
        const next = normalizeFoldersValue({ ...this.value.folders, ...patch });
        await this._commit({ ...this.value, folders: next });
    }

    async resetCurrentPreset() {
        const id = this.value.currentPreset;
        await this._commit({
            ...this.value,
            presets: { ...this.value.presets, [id]: presetDefaults(id) },
        });
    }

    async resetFolders() {
        await this._commit({
            ...this.value,
            folders: normalizeFoldersValue(null),
        });
    }

    async resetAll() {
        await this._commit(defaultSettings());
    }
}

const TEXT_SAVE_DEBOUNCE_MS = 400;

/**
 * Collapse a burst of keystrokes into one save. Returns a function that also
 * exposes `cancel()` so a disposed settings tab drops its pending write.
 */
function debounced(fn, ms = TEXT_SAVE_DEBOUNCE_MS) {
    let timer = null;
    const wrapped = (...args) => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            fn(...args);
        }, ms);
    };
    wrapped.cancel = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };
    return wrapped;
}

class AiSearchSettingTab extends PluginSettingTab {
    constructor(app, settings) {
        super(app, settings.plugin);
        this.settings = settings;
        // A render generation invalidates handlers left behind by an earlier
        // display() pass, the same way the resize-pics tab does.
        this._displayGeneration = 0;
        this._disposed = false;
        this._pending = new Set();

        const plugin = settings.plugin;
        try {
            if (!(plugin.__aiSearchSettingTabs instanceof Set)) {
                plugin.__aiSearchSettingTabs = new Set();
            }
            plugin.__aiSearchSettingTabs.add(this);
        } catch (_) {
            // Optional lifecycle registration; a frozen host object should not
            // make the settings page unusable.
        }
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this._displayGeneration += 1;
        for (const cancel of this._pending) cancel();
        this._pending.clear();
    }

    _isDisposed() {
        return this._disposed
            || Boolean(this.settings.plugin && this.settings.plugin.__aiSearchUnloaded);
    }

    /** Wrap a save so disposal, ordering and error reporting are uniform. */
    _guardedSave(generation, run) {
        return async (...args) => {
            if (this._isDisposed() || generation !== this._displayGeneration) return;
            try {
                await run(...args);
            } catch (error) {
                if (this._isDisposed()) return;
                console.error("ai-search: failed to save settings", error);
                new Notice(localizedText(this.settings.uiText.settingsText, "saveFailed", {
                    message: errorText(error),
                }), NOTICE_DURATION_MS);
            }
        };
    }

    /** Register a debounced handler so dispose() can drop pending writes. */
    _debounce(fn) {
        const wrapped = debounced(fn);
        this._pending.add(wrapped.cancel);
        return wrapped;
    }

    display() {
        if (this._isDisposed()) return;
        const generation = ++this._displayGeneration;
        for (const cancel of this._pending) cancel();
        this._pending.clear();
        this.containerEl.empty();
        const text = this.settings.uiText.settingsText;

        new Setting(this.containerEl)
            .setName(text.languageName)
            .setDesc(text.languageDesc)
            .addDropdown((dropdown) => {
                for (const option of LANGUAGE_OPTIONS) {
                    dropdown.addOption(option.value, option.label);
                }
                dropdown.setValue(this.settings.value.language)
                    .onChange(this._guardedSave(generation, async (language) => {
                        await this.settings.setLanguage(language);
                        // Every label on the page is localised, so redraw.
                        if (!this._isDisposed()) this.display();
                    }));
            });

        this.renderAiSection(generation);
        this.renderFolderSection(generation);
        this.renderResetAllSection(generation);
    }

    /**
     * Add a numeric field bound to one key of the current preset. Invalid
     * input is reported and dropped rather than silently coerced, so a typo
     * cannot turn "80 requests/s" into "0 requests/s".
     */
    _addLimitField(generation, { nameKey, descKey, key, validate }) {
        const text = this.settings.uiText.settingsText;
        const preset = this.settings.preset;
        const current = preset[key];
        new Setting(this.containerEl)
            .setName(text[nameKey])
            .setDesc(text[descKey])
            .addText((input) => {
                input.setValue(current === null || current === undefined ? "" : String(current));
                input.inputEl.type = "number";
                input.inputEl.inputMode = "decimal";
                input.onChange(this._debounce(this._guardedSave(generation, async (raw) => {
                    const trimmed = String(raw).trim();
                    const problem = validate(trimmed);
                    if (problem) {
                        new Notice(localizedText(text, problem, {
                            name: text[nameKey],
                        }), NOTICE_DURATION_MS);
                        return;
                    }
                    await this.settings.updatePreset({ [key]: trimmed === "" ? null : trimmed });
                })));
            });
    }

    renderAiSection(generation) {
        const text = this.settings.uiText.settingsText;
        new Setting(this.containerEl).setName(text.aiHeading).setHeading();

        new Setting(this.containerEl)
            .setName(text.presetName)
            .setDesc(text.presetDesc)
            .addDropdown((dropdown) => {
                dropdown.addOption(PRESET_JEV, text.presetJevLabel);
                dropdown.addOption(PRESET_CUSTOM, text.presetCustomLabel);
                dropdown.setValue(this.settings.value.currentPreset)
                    .onChange(this._guardedSave(generation, async (presetId) => {
                        await this.settings.setCurrentPreset(presetId);
                        // Redraw so every field below shows the new preset's
                        // own stored value instead of the previous one's.
                        if (!this._isDisposed()) this.display();
                    }));
            });

        this._addTextField(generation, {
            nameKey: "baseUrlName",
            desc: localizedText(text, "baseUrlDesc", { path: API_PATH }),
            key: "baseUrl",
            placeholder: JEV_PRESET_DEFAULTS.baseUrl,
        });
        this._addTextField(generation, {
            nameKey: "modelName",
            desc: text.modelDesc,
            key: "model",
            placeholder: JEV_PRESET_DEFAULTS.model,
        });
        this._addTextField(generation, {
            nameKey: "apiKeyName",
            desc: text.apiKeyDesc,
            key: "apiKey",
            placeholder: "sk-…",
            password: true,
        });

        const positive = (raw) => (raw === "" || normalizeLimit(raw) !== null
            ? null
            : "invalidNumber");
        this._addLimitField(generation, {
            nameKey: "concurrencyName",
            descKey: "concurrencyDesc",
            key: "maxConcurrentRequests",
            validate: positive,
        });
        this._addLimitField(generation, {
            nameKey: "tokensPerRequestName",
            descKey: "tokensPerRequestDesc",
            key: "maxTokensPerRequest",
            validate: positive,
        });
        this._addLimitField(generation, {
            nameKey: "tokensPerQuestionName",
            descKey: "tokensPerQuestionDesc",
            key: "maxTokensPerQuestion",
            validate: positive,
        });
        this._addLimitField(generation, {
            nameKey: "requestsPerSecondName",
            descKey: "requestsPerSecondDesc",
            key: "maxRequestsPerSecond",
            validate: positive,
        });
        this._addLimitField(generation, {
            nameKey: "tokensPerSecondName",
            descKey: "tokensPerSecondDesc",
            key: "maxTokensPerSecond",
            validate: positive,
        });
        this._addLimitField(generation, {
            nameKey: "thresholdName",
            descKey: "thresholdDesc",
            key: "relevanceThreshold",
            validate: (raw) => {
                if (raw === "") return null;
                const num = Number(raw);
                return Number.isFinite(num) && num >= 0 && num <= 1 ? null : "invalidThreshold";
            },
        });

        new Setting(this.containerEl)
            .setName(text.resetAiName)
            .setDesc(text.resetAiDesc)
            .addButton((button) => {
                button.setButtonText(text.resetAiButton)
                    .onClick(this._guardedSave(generation, async () => {
                        const presetId = this.settings.value.currentPreset;
                        await this.settings.resetCurrentPreset();
                        if (this._isDisposed()) return;
                        const label = presetId === PRESET_CUSTOM
                            ? text.presetCustomLabel
                            : text.presetJevLabel;
                        new Notice(localizedText(text, "resetAiDone", { preset: label }),
                            NOTICE_DURATION_MS);
                        this.display();
                    }));
            });
    }

    /** Add a free-text field bound to one key of the current preset. */
    _addTextField(generation, { nameKey, desc, key, placeholder, password }) {
        const text = this.settings.uiText.settingsText;
        const current = this.settings.preset[key];
        new Setting(this.containerEl)
            .setName(text[nameKey])
            .setDesc(desc)
            .addText((input) => {
                input.setPlaceholder(placeholder || "");
                input.setValue(current === null || current === undefined ? "" : String(current));
                if (password) input.inputEl.type = "password";
                input.onChange(this._debounce(this._guardedSave(generation, async (raw) => {
                    await this.settings.updatePreset({ [key]: raw });
                })));
            });
    }

    /** Multi-line folder list: one vault-relative path per line. */
    _addFolderListField(generation, { nameKey, descKey, placeholderKey, key }) {
        const text = this.settings.uiText.settingsText;
        new Setting(this.containerEl)
            .setName(text[nameKey])
            .setDesc(text[descKey])
            .addTextArea((area) => {
                area.setPlaceholder(text[placeholderKey]);
                area.setValue(formatFolderList(this.settings.value.folders[key]));
                area.inputEl.rows = 4;
                area.inputEl.style.width = "100%";
                area.onChange(this._debounce(this._guardedSave(generation, async (raw) => {
                    await this.settings.updateFolders({ [key]: parseFolderList(raw) });
                })));
            });
    }

    renderFolderSection(generation) {
        const text = this.settings.uiText.settingsText;
        new Setting(this.containerEl).setName(text.folderHeading).setHeading();

        this._addFolderListField(generation, {
            nameKey: "includeName",
            descKey: "includeDesc",
            placeholderKey: "includePlaceholder",
            key: "include",
        });
        this._addFolderListField(generation, {
            nameKey: "excludeName",
            descKey: "excludeDesc",
            placeholderKey: "excludePlaceholder",
            key: "exclude",
        });

        new Setting(this.containerEl)
            .setName(text.extensionsName)
            .setDesc(text.extensionsDesc)
            .addText((input) => {
                input.setPlaceholder(text.extensionsPlaceholder);
                input.setValue(formatExtensionList(this.settings.value.folders.extensions));
                input.onChange(this._debounce(this._guardedSave(generation, async (raw) => {
                    await this.settings.updateFolders({ extensions: parseExtensionList(raw) });
                })));
            });

        new Setting(this.containerEl)
            .setName(text.resetFoldersName)
            .setDesc(text.resetFoldersDesc)
            .addButton((button) => {
                button.setButtonText(text.resetFoldersButton)
                    .onClick(this._guardedSave(generation, async () => {
                        await this.settings.resetFolders();
                        if (this._isDisposed()) return;
                        new Notice(text.resetFoldersDone, NOTICE_DURATION_MS);
                        this.display();
                    }));
            });
    }

    renderResetAllSection(generation) {
        const text = this.settings.uiText.settingsText;
        new Setting(this.containerEl)
            .setName(text.resetAllName)
            .setDesc(text.resetAllDesc)
            .addButton((button) => {
                button.setButtonText(text.resetAllButton)
                    .setWarning()
                    .onClick(this._guardedSave(generation, async () => {
                        await this.settings.resetAll();
                        if (this._isDisposed()) return;
                        new Notice(this.settings.uiText.settingsText.resetAllDone,
                            NOTICE_DURATION_MS);
                        this.display();
                    }));
            });
    }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
    LANGUAGE_OPTIONS,
    NOTICE_DURATION_MS,
    API_PATH,
    PRESET_JEV,
    PRESET_CUSTOM,
    JEV_PRESET_DEFAULTS,
    CUSTOM_PRESET_DEFAULTS,
    AiSearchSettings,
    AiSearchSettingTab,
    activePreset,
    bilingualError,
    errorText,
    localizedText,
    normalizeLimit,
    normalizeThreshold,
    parseFolderList,
    parseExtensionList,
    defaultSettings,
};
