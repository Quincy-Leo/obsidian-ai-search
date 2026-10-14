# obsidian-ai-search

**English** | [简体中文](./README.zh-CN.md)

**Fuzzy search a note or a whole vault** with an **AI decision model** — no exact word matching, no search engine to set up.

The default preset targets [Jev](https://docs.typesafe.ai) (TypeSafe's decision model), whose `systemone` endpoint returns a probability instead of text. Any endpoint speaking the same protocol works through the Custom preset.

This plugin was written entirely by Claude Opus 5.

- **Minimum Obsidian version**: 1.4.0
- **Platforms**: Desktop only
- **UI languages**: Simplified Chinese / English
- **License**: MIT

---

## ✨ Features

- 🔎 **Two scopes**: search the current note, or the whole vault filtered by folder and extension.
- 📊 **Ranked by relevance**: every hit carries the model's probability, shown as a percentage and used as the sort key.
- 🚦 **Budgeted calls**: configurable concurrency, tokens per request, tokens per question, requests/second and tokens/second.
- ⏹️ **Interruptible**: a live progress bar with a Stop button; stopping keeps and ranks whatever came back.
- 🌏 **Bilingual UI**: every label, notice and error message exists in Chinese and English.
- 🙈 **No traces**: no index, no search history, nothing written to disk except the settings file.

## 🚀 Installation

```bash
git clone <this repo>
cd obsidian-ai-search
npm install
# Point TARGET_DIR at <your vault>/.obsidian/plugins/ai-search, then:
./build.sh
```

`build.sh` runs `npm run build` (esbuild bundles `src/*.js` into `main.js`) and copies `main.js` + `manifest.json` into the target folder. Enable **ai-search** in *Settings → Community plugins*, then fill in the API key.

## 🖱️ Triggering

| Entry point | How |
| --- | --- |
| Command palette | `ai-search` → "AI fuzzy search" |
| Ribbon icon | the `text-search` icon in the left sidebar |

Both open the same search popup:

- The text field is on the left; **This note** and **Whole vault** sit on the right. In the field, <kbd>Enter</kbd> runs **This note** and <kbd>Shift</kbd>+<kbd>Enter</kbd> runs **Whole vault**; <kbd>Enter</kbd> with any other modifier does nothing. Hovering either button shows its shortcut.
- The popup has no close button — click anywhere outside it to dismiss. Re-opening restores exactly what was there, and a search that was running keeps running while the popup is closed.
- Editing the query (adding *or* deleting) drops the previous results and stops a running search, because those results answer the old question.
- While searching, a progress bar with a **Stop** button replaces the result list. Stopping ranks and shows what has arrived so far.
- Each result shows the file name in bold small type with the relevance percentage, then up to two lines of the matching passage. Clicking one opens the file at that line and dismisses the popup.

## ⚙️ Settings

### Language

Interface language, Chinese by default. Applies to the command name, the ribbon tooltip and every message.

### AI

| Setting | Jev preset default | Custom preset default |
| --- | --- | --- |
| Preset | `Jev` | — |
| Base URL | `https://api.typesafe.ai` | blank |
| Model name | `jev-latest` | blank |
| API key | blank | blank |
| Max concurrent requests | 8 | blank → serial |
| Max tokens per request | 64000 | blank → bounded only by the per-second share |
| Max tokens per question | 32000 | blank → never split |
| Max requests per second | 80 | blank → unlimited |
| Max tokens per second | 100000 | blank → unlimited |
| Relevance threshold | 0.5 | 0.5 |

Each preset is stored, updated and read as its own object under `presets` in `data.json`, so switching presets never overwrites the other one's values. The Jev defaults are hard-coded in `src/settings.js` from the published limits — 80 requests/s, 100K tokens/s, 64k tokens per request, and 32k tokens for `state` plus the longest single question; the plugin never reads them from a document at runtime. **Reset AI settings** restores the selected preset only.

The request path `/v1/systemone` is appended to the base URL.

### Folders

| Setting | Default | Notes |
| --- | --- | --- |
| Folders to search | blank → whole vault | one vault-relative path per line, recursive |
| Folders to exclude | blank → nothing excluded | one path per line, recursive; wins over the include list |
| File extensions | `md,txt` | comma-separated, no dots |

Plain-text notes only. Binary files are ignored — by extension, and as a second line of defence any file whose content contains a NUL byte is skipped. **Reset folder settings** restores all three; **Reset all settings** also restores the language and both presets.

## 🏗️ How a search runs

1. **Split** each file into judgement units: one per line, but a line shorter than 10 characters is merged into the next one. Code blocks and tables are the exception — each is joined into a single unit rather than split per line (one table row or one line of code is meaningless on its own, and joining turns a table's N questions into 1). Blank lines, ATX headings, both code-fence markers, table delimiter rows and leading YAML frontmatter are skipped; code inside a fence is still searched. A unit made only of layout punctuation (`---`, `| --- |`) is dropped. Each unit remembers its first line number (the opening fence, for a code block), which is where clicking the result jumps to.
2. **Batch** units into requests. The search phrase and the judging rule go into `state`; each unit becomes its own `noul` question carrying the passage in `instructions`. One request therefore judges many passages, the passages cannot interfere with each other, and the rule shared by the whole batch is paid for once in `state` rather than once per passage. A unit whose *search phrase + passage* exceeds *max tokens per question* is split into several questions for the request (cutting at a newline or space where possible), so its tail is judged rather than dropped; the unit still yields a single result scored by its best-matching piece, and the full text is what you see.
3. **Schedule** the batches across *max concurrent requests* workers, behind a sliding-window limiter enforcing both rate caps. Token cost is estimated from the request body before sending (deliberately an over-estimate). One request is sized at the smaller of *max tokens per request* and *max tokens per second ÷ concurrency*: packing a request to the API ceiling spends tokens most efficiently and time worst — Jev answers 60 questions about as fast as 1, so a fatter request takes the same latency while claiming proportionally more of the per-second budget, leaving the limiter to stall every other worker and making the configured concurrency moot. Capping each request at its fair share lets all the workers hold a grant at once.
4. **Retry** on HTTP 429 / 529 / 5xx and on network errors — 3 attempts with 500 ms exponential backoff. HTTP 400 / 401 / 403 / 422 abort the whole search instead, since they cannot be fixed by retrying. A batch that exhausts its retries is counted as failed and reported at the end; the other batches still finish.
5. **Rank** the units whose probability reached the threshold, highest first, and render them.

## 🧱 Code layout

| File | Responsibility |
| --- | --- |
| `src/main.js` | plugin registration: command, ribbon icon, settings tab, lifecycle |
| `src/settings.js` | localized strings, schema versioning, presets, settings page |
| `src/search.js` | text splitting, file filtering, scheduling, rate limiting, state |
| `src/window.js` | the search popup (presentation only) |
| `src/ai.js` | request building, HTTP, error classification, retry |

Search state lives on `SearchController` in `search.js`, not on the modal — that is what makes "close and re-open unchanged" work, and what keeps a search alive while the popup is closed.

## 🔐 Settings file

`data.json` carries a `version` field, currently `1`.

- **On read**: a missing, non-integer or lower version is reported as an invalid field; a higher version is reported as "newer than the plugin". In both cases the plugin **refuses to load** — no command, no ribbon icon, no settings tab — rather than risk overwriting a file it cannot read.
- **On write**: if the file on disk turns out to be older, it is copied to `data.json.bak` before being replaced; if it is newer, the write is refused.

The API key is stored in plain text in `data.json`, like every other Obsidian plugin credential. It is sent only to the base URL you configured, as an `Authorization: Bearer` header.

## ⚠️ Known limitations

- **Text search only.** For simplicity, only text is searchable for now. If you need to search images or other non-plain-text documents, issues and PRs are welcome.
- **Cost and latency scale linearly with vault size.** Every line is judged by a model call. With the default limits a request holds a few hundred average-length lines, so a vault with 100k lines means a few hundred requests. Start with a folder filter.
- **No cache.** Repeating a search repeats every call, by design.
- **Single-line context.** A line is judged on its own (after short-line merging), so a pronoun-heavy sentence may score lower than its paragraph would.
- **Custom endpoints must match the `systemone` shape**: `{state, questions}` in, `{answers: {id: {noul}}}` out.

## 🛠️ Development notes

```bash
npm test          # node --test ut/*.test.js
npm run check     # bundle, then syntax-check the bundle
```

`ut/helpers/bootstrap.js` stubs `require("obsidian")` and enough DOM to render and click the popup in plain Node; `ut/helpers/fakePlugin.js` provides an in-memory vault and settings store.

## 📄 License

MIT — see [LICENSE](./LICENSE).
