# Xero Evidence Assistant

A small JavaScript web app that gathers a focused set of public Xero Australia pages, stores useful evidence locally, retrieves relevant chunks for each question, and uses a real local model to answer only from that evidence.

## Demo video

[Watch the demo video on Google Drive](https://drive.google.com/file/d/1AjBLK_EREh7CBu6a0yvt0NLiz4wIuvxa/view?usp=drive_link)

## Setup and usage

Requirements: Node.js 20+ and [Ollama](https://ollama.com/) for live question answering. The app has no third-party npm dependencies and needs no API key or account.

```bash
npm install                 # no third-party packages; creates/validates the lockfile
ollama pull llama3.2:3b
ollama serve                 # if Ollama is not already running
cp .env.example .env         # optional; defaults already match the example
npm start
```

Open `http://localhost:3000`. Run **Gather / Reuse Research**, ask a question, inspect its cited evidence, then ask again or gather again to observe reuse. **Refresh Research** explicitly refetches and reprocesses configured pages.

Sources are configured in `config/sources.json`. Adding, replacing or removing a source takes effect on the next gather. The initial four sources cover Xero's company positioning, small-business use, product features and Australian pricing terms.

```bash
npm test                   # offline, credential-free tests
npm run demo:failure       # offline synthetic 503 demonstration
npm run evaluate:refresh   # live pages + real Ollama model; writes evaluation/latest.json
```

`npm test` and `npm run demo:failure` use temporary data directories and do not alter live research. Before submission, run `npm run evaluate:refresh`, review the output, and commit `evaluation/latest.json`. The real research cache under `data/` is gitignored so extracted website content is not committed in bulk.

## System Design

```text
config/sources.json
       |
       v
research.js --HTTP fetch--> public Xero pages
       |                       |
       |                 extract.js
       |                clean + chunk
       v
 data/research.json  <--- atomic snapshot writes
       |
       v
retrieval.js -- top relevant chunks --> model.js (Ollama)
                                      |
                           validated claim/evidence IDs
                                      |
                                      v
                                  web UI

activity events ---------------------> UI + evaluation record
```

The activity log records fetch/reuse decisions, retrieval details, model timing and safe failures.

`research.js` decides when to fetch, reuse or refresh. `extract.js` keeps useful page text and chunks it. `retrieval.js` uses deterministic lexical scoring with per-source diversity. `model.js` receives only retrieved evidence and cannot introduce citation IDs outside that set. `qa.js` can reject clearly unrelated questions before a model call. Stored source metadata includes title, URL, retrieval time, content hash, chunks and the latest fetch-attempt status.

If an explicit refresh fails, the last successful snapshot stays available and its original retrieval time is preserved. The UI shows the failed attempt separately instead of presenting old evidence as freshly retrieved.

### Design decision 1: local JSON + lexical retrieval

**Choice:** atomic JSON snapshots and a small lexical scorer. **Alternative:** SQLite plus embeddings/vector search. For four pages, JSON is easy to inspect and deterministic retrieval is cheap to test. The assumption is that lexical retrieval is adequate for this small corpus; the recorded evaluation checks that assumption. I would reconsider if the corpus became much larger, concurrent writes mattered, or evaluation showed repeated semantic misses.

### Design decision 2: structured claims validated by application code

**Choice:** Ollama is given a JSON response schema whose citation IDs are limited to the retrieved evidence. The model returns supported claims and explicit unknowns; application code validates citations and derives whether the result is answered, partial or insufficient before attaching the stored title, URL and retrieval time. **Alternative:** let the model choose the overall status or accept free-form prose and model-written citations. Keeping status and citation validation in application code makes the safety boundary deterministic. I would reconsider the exact schema if the answer format became richer, but would keep server-side evidence validation.

## AI Usage

I used ChatGPT as a development assistant to review the requirements, brainstorm implementation options, debug specific failures, and suggest test cases. I reviewed suggestions against the exercise requirements and the application's observed behaviour before keeping them.

One substantive suggestion I accepted was to derive `answered` / `partial` / `insufficient` status in application code rather than relying on the model to classify its own response. I kept this change after manual partial-answer testing showed inconsistent model status, and added regression coverage around citation IDs and insufficient-evidence behaviour. I also used AI suggestions while investigating retrieval and grounding issues, but did not keep every proposed change: a later, more aggressive grounding/retrieval filter caused regressions in otherwise stable questions, so I rolled that change back and retained the simpler version.

Runtime Q&A uses the configured local Ollama model; the development assistant is not part of the application.

## Limitations and cost

Live dependencies are public Xero webpages and a local Ollama installation. There is no per-call API fee, but the model must be downloaded and local inference speed depends on the reviewer's hardware; CPU-only use may be slower. Model output is capped at 512 tokens by default and the local model is kept warm for 10 minutes to keep the demo responsive. The first gather fetches and processes the configured pages, later questions reuse stored evidence and make only a new model call, and explicit refresh refetches sources.

HTML extraction is lightweight and may miss heavily client-rendered content. Retrieval is lexical rather than semantic, so compound questions can occasionally retrieve tangential but grounded evidence or miss a relevant chunk when lexical overlap is weak. Citation IDs are validated in application code, while semantic relevance is also checked through the recorded evaluation and manual review. The app handles fetch and model failures safely, but is not a production crawler or multi-user service.

Recorded evaluation: `evaluation/latest.json` after running the live evaluation command.
