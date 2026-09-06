# How this project works

Football live-streaming backend for a Flutter app. It scrapes FotMob fixtures and streaming Match URLs / m3u8 streams, builds JSON feeds, serves them over HTTP, and uploads to GitHub when content changes.

| | |
|---|---|
| **Package** | `football-live-streaming-backend` |
| **Timezone** | `Asia/Yangon` (canonical). Streaming URL clocks are often ICT / `Asia/Bangkok` and are converted to Yangon before matching. |
| **Production host** | AWS EC2 (~1GB RAM) + PM2 + low-memory Chromium |
| **Runtime** | Node.js ≥ 18 |
| **Entry** | `src/index.js` (PM2: `ecosystem.config.js`, process `football-streaming`) |

**GitHub is delivery + remote config only — not a database.**  
Working store = local `data/`. Flutter can read this server (`/flutter/*.json`) or GitHub raw URLs after upload.

**Architecture rule:** FotMob is the fixture source of truth. Streaming sites are stream sources only. Do not invent matches from streaming sites.

---

## 1. What the system produces

| Feed | Local file | HTTP | Who owns it |
|------|------------|------|-------------|
| **MainLive** | `data/delivery/mainlive.json` | `/flutter/mainlive.json` | Admin panel only |
| **Matches** (SecondLive) | `data/delivery/matches.json` | `/flutter/matches.json` | Scraper (+ admin overrides / manual) |
| **Highlight 1** | `data/delivery/highlight1.json` | `/flutter/highlight1.json` (also `/flutter/highlight.json`) | Highlight job (Hoofoot) |
| **Highlight 2** | `data/delivery/highlight2.json` | `/flutter/highlight2.json` | Highlight job (Socolive) |
| **Myanmar TV** | `data/delivery/myanmartv.json` | `/flutter/myanmartv.json` | MyanmarTV job |
| **Tips** | `data/delivery/tips.json` | `/flutter/tips.json` | Tips job (PredictZ) |
| **App version** | admin store | `/flutter/app-version.json` | Admin |

`mainlive.json` uses the **same match JSON shape** as `matches.json`, but the scraper **never** overwrites it. Admin MainLive is the only writer.

Also useful:

| Path | Role |
|------|------|
| `data/current.json` | Combined local cache (matches + last highlight/TV snapshot) |
| `GET /api/health` | Liveness + last job flags |
| `GET /` | Index of feeds/endpoints |
| `/admin` | Admin UI (`public/admin/`) |
| `/api/admin/*` | Admin JWT API |

Default GitHub delivery repo paths: `matches.json`, `mainlive.json`, `highlight.json` / `highlight1.json`, `highlight2.json`, `myanmartv.json`, `tips.json`.

---

## 2. Mental model (end-to-end)

```
FotMob fixtures (today + tomorrow)     ← source of truth for teams / date / kickoff
        │
        ▼
Match URL discovery (Today / schedule page per streaming source)
   · −60 / −45 / −30 minutes before kickoff (max 3 pre-kickoff attempts per source)
   · live catch-up: kickoff → +2h if still missing (cooldown ~5 min)
   · identity: home + away + Yangon date + kickoff
   · stop that source once a URL is saved
        │
        ▼
Stream extract (saved Match URL only)
   · −30 / −15 / −5, then kickoff / +5 / +10  →  STOP at +15
   · Axios first → Puppeteer only if Axios has no *validated* stream
   · header-aware HLS validation (Referer / UA / Origin / Cookie)
   · AVAILABLE only after validation.ok === true
        │
        ▼
matchesSync (expire kickoff+2h, merge streams, preserve Match URL state)
        │
        ▼
Match status (kickoff clock):  Scheduled → PREPARING_STREAM → LIVE → END
Stream status (search):        PREPARING_STREAM / SEARCHING / AVAILABLE / FAILED
        │
        ├──► data/delivery/matches.json  (always)
        └──► GitHub matches.json         (only if changed + auth OK)

Dedicated jobs (own crons, mutually exclusive with pipeline on 1GB):
  · Highlights → highlight1.json + highlight2.json
  · Tips       → tips.json (PredictZ today + tomorrow)
  · MyanmarTV  → myanmartv.json (tokens ~10 min; cron every 8 min)
  · Domain check → Telegram only (never auto-edits sources.json)
```

Example for kickoff **20:00 Yangon**:

| Time | Match URL | Stream extract |
|------|-----------|----------------|
| 19:00 | attempt 1 (−60m) | — |
| 19:15 | attempt 2 (−45m) if still missing | — |
| 19:30 | attempt 3 (−30m) if still missing | starts if Match URL saved (−30 slot) |
| 19:45 | — | retry (−15) if needed |
| 19:55 | — | retry (−5) if needed |
| 20:00 | live hunt if still missing | kickoff extract |
| 20:05 | live hunt (cooldown) | +5 |
| 20:10 | live hunt (cooldown) | +10 |
| 20:15 | live hunt continues until +2h | **STOP** extract |
| 22:00 | live Match URL window ends | — |

---

## 3. Boot sequence

`src/index.js`:

1. Load `.env` (`dotenv`)
2. **`assertProductionEnv`** — in `NODE_ENV=production`, refuse weak/placeholder `ADMIN_JWT_SECRET` and `ADMIN_PASSWORD`
3. Create `Pipeline` → admin context → seed admin if none → attach admin
4. Start monitoring (Telegram, memory, PM2 helpers, domain monitor)
5. Express listen on `HOST`/`PORT` (defaults `0.0.0.0:3000`)
6. Start cron `Scheduler`
7. Staggered boot jobs (**1GB-safe**):
   - **+10s** → `pipeline.run({ forceStreamCheck: false })`
   - **+15s** → `runHighlights({ force: false })`
   - **+15s** → `runMyanmarTv({ force: false })`
   - **+15s** → `runTips({ force: false })`
8. On SIGINT/SIGTERM → stop scheduler/monitoring, close HTTP + Puppeteer

`forceStreamCheck: false` on boot avoids OOM from deep-scraping every fixture at startup.

---

## 4. Job schedule

All crons use timezone **`Asia/Yangon`**. Module: `src/services/scheduler.js`.

### Production defaults (`ecosystem.config.js`)

| Job | Env | Cron | Output |
|-----|-----|------|--------|
| Main pipeline | `PIPELINE_CRON` | `*/5 * * * *` | `matches.json` (fixtures + Match URL + extract + status + publish) |
| Highlights | `HIGHLIGHT_CRON` | `0 */6 * * *` | `highlight1.json` + `highlight2.json` |
| MyanmarTV | `MYANMARTV_CRON` | `*/8 * * * *` | `myanmartv.json` |
| Tips | `TIPS_CRON` | `7 8,20 * * *` | `tips.json` (08:07 & 20:07) |
| Domain check | `DOMAIN_CHECK_CRON` | `0 * * * *` | Telegram only |

Each pipeline tick also calls `expireStaleMatches()` (remove matches past kickoff+2h) before scrape.

### Code fallbacks if env vars are unset

| Job | Fallback |
|-----|----------|
| Pipeline | every **1** minute |
| Highlights | every **3** hours |
| MyanmarTV | every **8** minutes |
| Tips | `7 8,20 * * *` |
| Domain check | every **1** hour |

**Cadence note:** stream extract slots are 5 minutes apart (`STREAM_SEARCH_INTERVAL_MINUTES=5`). Keep `PIPELINE_CRON` at `*/5` (or tighter) so kickoff / +5 / +10 are not missed. `*/15` will miss slots.

### Mutual exclusion (1GB RAM)

Pipeline ↔ highlights ↔ MyanmarTV ↔ tips **never run Chromium-heavy work at the same time**.

| If busy | What happens |
|---------|----------------|
| Tips / MyanmarTV tick while pipeline running | **Queued** (`_pendingTips` / `_pendingMyanmarTv`) → drained when free |
| Highlights tick while pipeline / tips / TV running | **Queued** (`_pendingHighlights`) → drained when free |
| Pipeline tick while highlight/tips/TV running | **Skipped** this tick |

### Stuck locks

Flags `running`, `highlightRunning`, `channelsRunning`, `tipsRunning` can stick after OOM/crash/hang and starve other feeds.

- Cleared by `_clearStuckJobLocks()` when older than `PIPELINE_MAX_RUN_MS` (default **20 minutes**)
- Orphan locks with no start timestamp are cleared immediately
- Collect timeouts: tips ~180s (`TIPS_TIMEOUT_MS`), MyanmarTV ~120s (`MYANMARTV_TIMEOUT_MS`), highlight1 ~90s, highlight2 ~180s

---

## 5. Configuration

### Files (`LOCAL_CONFIG_DIR`, default `./config`)

| File | Purpose |
|------|---------|
| `config/sources.json` | Scrapers, domains, priorities, selectors, `playbackHeaders` |
| `config/leagues.json` | Allowed leagues / aliases / FotMob IDs |
| `config/teams.json` | Team catalog / aliases / logos |
| `.env` | Secrets, crons, Chromium path, GitHub, search slots |
| `src/utils/scraperConfig.js` | Reads search/concurrency env once at process start |

### How config is loaded (`ConfigLoader`)

1. If GitHub credentials exist → try load remote `GITHUB_CONFIG_PATH` (default `config/`)
2. Always load local `./config`
3. Merge rules:
   - **`USE_LOCAL_CONFIG=true` (default):** prefer **local `sources.json`** so a stale GitHub copy cannot re-enable removed scrapers / old domains
   - **Leagues:** merge by name; **local wins** on conflict
   - **Teams:** local list wins if non-empty
4. If GitHub fails → local only

**Deployed `config/sources.json` is authoritative** when `USE_LOCAL_CONFIG` is true. After changing domains on EC2, restart PM2.

### Runtime search settings

| Variable | Default | Meaning |
|----------|---------|---------|
| `MATCH_URL_PRE_KICKOFF_MINUTES` | `60,45,30` | Today-page Match URL slots |
| `MATCH_URL_EARLY_DISCOVERY` | `false` | Optional early slot before −60 |
| `STREAM_EXTRACT_PRE_KICKOFF_MINUTES` | `30,15,5` | Pre-kickoff m3u8 extract slots |
| `STREAM_SEARCH_INTERVAL_MINUTES` | `5` | Post-kickoff spacing + live Match URL cooldown |
| `STREAM_MAX_ATTEMPTS` | `3` | Post-kickoff extract attempts (0 / +5 / +10) |
| `STREAM_POST_KICKOFF_MAX_MINUTES` | `15` | Hard stop extract; cancel pending jobs |
| `SCRAPER_CONCURRENCY` | `2` | Max simultaneous extract jobs |
| `PUPPETEER_CONCURRENCY` | `1` | Match URL browser queue |
| `PUPPETEER_MAX_PAGES` | `2` | Max Chromium pages |
| `MATCH_TIME_TOLERANCE_MIN` | `10` | \|FotMob − URL kickoff\| (Yangon) |
| `MAX_STREAM_RETRIES` | `1` | Per-request HTTP/Puppeteer retry — **not** search attempts |
| `PIPELINE_MAX_RUN_MS` | `1200000` (20 min) | Stuck job lock clear threshold |
| `MATCH_EXPIRE_AFTER_SEC` | `7200` | Expire matches at kickoff+2h |

Do not alias `MAX_STREAM_RETRIES` to `STREAM_MAX_ATTEMPTS`.

---

## 6. Streaming sources (current allowlist)

From `config/sources.json` (domains change often — always check the file):

| Name | Type | Priority | Domain (example) | Notes |
|------|------|----------|------------------|-------|
| `fotmob` | fixtures | — | `https://www.fotmob.com` | API today + tomorrow |
| `cakhia` | streaming | 450 | `https://cakhiazaa.tv` | axios-first / generic |
| `xoilac` | streaming | 400 | `https://xoilacxbg.tv` | custom parser `xoilac` |
| `mitomtm` | streaming | 350 | `https://mitomzd.cc` | generic |
| `socolive` | streaming | 300 | `https://socoliveza.tv` | custom parser + playback Referer |
| `highlight1` | highlights | — | `https://hoofoot.com/` | → `highlight1.json` |
| `highlight2` | highlights | — | `https://socoliveza.tv/` | → `highlight2.json` |
| `myanmartv` | channels | — | `https://www.myanmartvchannels.com/` | own cron |
| `tips` | tips | — | `https://www.predictz.com/` | own cron |

Each streaming source has `playbackHeaders` (User-Agent + Referer, Origin/Cookie if required). Those headers are used for **validation and Flutter playback**, not for HTML list-page scraping.

Sources without a custom parser use `GenericStreamingSource`. Registry may still contain old parser names; if they are not listed/enabled in `sources.json`, they are unused.

### Adding a streaming site

1. Add entry in `config/sources.json` (`type: "streaming"`, domains, paths, `extractionMethod`, `playbackHeaders`)
2. Optionally register a parser in `PARSER_REGISTRY`
3. Enable via config and/or admin source toggle
4. Redeploy / restart so `USE_LOCAL_CONFIG` picks it up

---

## 7. Matches pipeline (`matches.json`)

Orchestrated by `src/services/pipeline.js` → `StreamEngine` → `PublishService` / `matchesSyncService` → `GitHubService`.

```
ConfigLoader.load(true)
  → FotMob fixtures (today + tomorrow; short day cache; force refreshes)
  → Admin league filter + merge previous streams / matchUrlSearch / streamSearch / pins
  → buildEngineStreamingSources (priority desc)
  → StreamEngine.collectForFixtures
       · Match URL discovery: one list-page fetch per source for fixtures due
         in −60/−45/−30 (or live window)
       · process matches sequentially
       · enqueue extract jobs only when:
           saved Match URL exists
           current slot is −30/−15/−5 / kickoff / +5 / +10
           source is not already AVAILABLE or permanently FAILED
           search has not stopped (+15)
       · JobQueue at SCRAPER_CONCURRENCY=2
       · Axios first → Puppeteer fallback → header-aware HLS validate
       · on first validated stream for a match → persist + GitHub immediately
  → Status enrich (Scheduled / PREPARING_STREAM / LIVE / END)
  → PublishService (overrides, logos, sync, expire)
  → data/delivery/matches.json
  → GitHub upload if content changed
```

On fixture failure: **keep previous** data. Never empty-overwrite a previously populated GitHub feed (`refuse_empty`), except intentional expiry cleanup or admin MainLive clear.

The main tick does **not** re-scrape highlights / tips / Myanmar TV; it reuses the last delivery stores for the combined cache.

**Fixtures-only refresh** (some helper scripts) updates match rows **without** running StreamEngine discovery — that leaves `matchUrl` / `sourcePages` empty even when sites already list the games. Use a full **Run Scraper** / `pipeline.run` for Match URLs.

Manual triggers:

- CLI: `npm run scrape` (`src/cli/runPipeline.js`) — flags `--force`, `--highlights`, `--channels` / `--myanmartv`, `--tips`
- Admin: `POST /api/admin/pipeline/run`, `/highlights`, `/channels`, `/tips`
- Empty local matches → `restoreMatchesFromGithub` (auto in pipeline + admin endpoint)

---

## 8. Two clocks: Match URL vs stream extract

Defined in `src/utils/scraperConfig.js`, `src/utils/time.js`, `src/utils/matchUrlDiscovery.js`, `src/utils/streamExtractPolicy.js`, `src/services/streamEngine.js`.

Search is driven by each match’s **existing `kickoff`**. There are **no fixed daily wall-clock search times**.

### 8a. Match URL discovery (Today / schedule page)

| When (vs kickoff) | Slot | Attempt |
|-------------------|------|---------|
| −60 min | `t60` | 1 |
| −45 min | `t45` | 2 |
| −30 min | `t30` | 3 |
| Kickoff → +2h (still missing) | `tLive` | liveAttempts (cooldown ~5 min) |
| After a URL is saved | — | no more search for that source |

Rules:

- Max 3 **pre-kickoff** attempts per source (`MATCH_URL_PRE_KICKOFF_MINUTES` length).
- **Stop that source** as soon as a Match URL is saved (`MATCH_URL_FOUND` or `MATCH_URL_CONFIRMED`).
- After 3 pre-kickoff misses → `MATCH_URL_FAILED`; live window may still hunt.
- List-page scrape is gated: if no fixture in this cycle still needs discovery, the Today page is not fetched.
- Transient HTTP/DNS/timeout/403/404/Cloudflare errors do **not** burn an attempt.
- Per-source state lives under `match.matchUrlSearch.sources[name]` (`matchUrl`, `status`, `attempts`, `liveAttempts`, `slotsDone`, `lastAttemptAt`, `confidence`).
- Aggregate fields: `matchUrl`, `matchUrlStatus`, `matchUrlAttempts`, `sourcePages`.

States: `MATCH_URL_PENDING` | `MATCH_URL_SEARCHING` | `MATCH_URL_FOUND` | `MATCH_URL_CONFIRMED` | `MATCH_URL_FAILED` (legacy: `MATCH_URL_NOT_FOUND`, `MATCH_CONFIRMED`).

**`attempts: 0` with empty `matchUrlSearch`** usually means discovery **never ran** for that row (wrong time window, stuck pipeline, fixtures-only push) — not “searched and empty”.

### 8b. Stream extract (m3u8)

| When (vs kickoff) | Slot | Attempt |
|-------------------|------|---------|
| −30 / −15 / −5 | pre-kickoff | if Match URL already saved |
| Kickoff | `t0` | 1 |
| +5 min | `tP5` | 2 |
| +10 min | `tP10` | 3 |
| +15 min | — | **STOP** — cancel pending extract jobs |

| Rule | Detail |
|------|--------|
| Skip `AVAILABLE` | Validated stream already saved for that source |
| Retry failures | Miss stays `SEARCHING` until attempts exhausted |
| Permanent `FAILED` | Only after **3** post-kickoff misses (`STREAM_MAX_ATTEMPTS`) |
| Stop | `STREAM_POST_KICKOFF_MAX_MINUTES` (15). Keep already-found valid streams. |
| No Match URL | Skip extract; do **not** count as FAILED |

Keep **`status`** (match clock) and **`streamStatus`** (search/playback) separate.

### Match-by-match processing

- Do **not** launch all matches in parallel
- Process **Match 1 → Match 2 → …**
- For each match, consider **all** enabled sources
- Extract jobs run through `JobQueue` (concurrency 2)
- If one source succeeds, **continue** remaining sources (do not stop early)

---

## 9. Fixture → Match URL matching

FotMob fixture is the identity. Streaming sites only supply a page URL.

### Identity (all required)

**home + away + Yangon date + kickoff.** Both teams required. League is secondary.

### Scoring (`src/utils/streamUrlHelper.js`)

| Signal | Points |
|--------|--------|
| Home team | 40 |
| Away team | 40 |
| Date (Yangon) | 10 |
| Kickoff time | 10 |

| Total | Result |
|-------|--------|
| 90–100 | `MATCH_URL_CONFIRMED` — accepted |
| 75–89 | possible — extra league check |
| &lt; 75 | reject |

Time tolerance: `MATCH_TIME_TOLERANCE_MIN` (default 10). URL times are parsed as **ICT**, then converted to Yangon before compare.

Team names go through `Normalizer` + `config/teams.json`. Typical slug:

`{home}-vs-{away}-luc-{HHMM}-ngay-{DD}-{MM}-{YYYY}` (ICT clock in the URL)

### MultiMatchScraper (`src/services/multiMatchScraper.js`)

1. Only fixtures that still need Match URL discovery
2. Axios GET list pages (`paths.lists` / `schedule`)
3. Extract `truc-tiep/...` style links
4. If list empty / Cloudflare → **Puppeteer** fallback for the list page
5. Score each candidate against the FotMob fixture; keep the best accepted URL
6. Ambiguous close scores → reject (avoid wrong Match URL)

Helper script to verify sites vs today’s fixtures: `node scripts/checkTodayMatchUrls.js`  
(optional `CHECK_SOURCES=cakhia,xoilac`).

---

## 10. Dedicated jobs

### Highlights — `Pipeline.runHighlights`

- Cron: every 6 hours in production (`HIGHLIGHT_CRON`)
- Runs **highlight1** (Hoofoot) then **highlight2** (Socolive video-highlight) sequentially
- Writes `highlight1.json` (+ legacy `highlight.json` mirror) and `highlight2.json`
- Empty / failed scrape → keep previous; GitHub `refuse_empty`

### Tips — `Pipeline.runTips`

- Cron: **08:07** and **20:07** Yangon
- PredictZ today + tomorrow → `tips.json`
- Axios first, Puppeteer if blocked
- Queued if pipeline / highlights / TV busy

### MyanmarTV — `Pipeline.runMyanmarTv`

- Cron: every **8** minutes (stream tokens last ~10 minutes)
- Writes channel array to `myanmartv.json`
- Empty scrape → keep previous streams when possible
- Queued if other heavy jobs busy

### Domain check

- Telegram alert if enabled streaming domains are down or changed
- **Never** auto-edits `sources.json`
- State: `data/domain-check-state.json`

---

## 11. Publish / GitHub / `refuse_empty`

| Module | Role |
|--------|------|
| `src/admin/services/publishService.js` | Overrides, league filter, logos → sync → local delivery → GitHub |
| `src/services/matchesSyncService.js` | Expire kickoff+2h, merge streams, preserve Match URL / admin flags |
| `src/services/githubService.js` | Change-only PUT; strip volatile timestamps for compare |

**`refuse_empty`:** if payload is empty **and** previous local/remote was populated → skip upload (`reason: 'refuse_empty'`), unless `allowEmpty` (admin clear). Scraper publish **omits** `mainlive` (admin-owned).

Immediate save on first validated stream still goes through sync + refuse rules.

---

## 12. Admin panel

- UI: `http://<host>:3000/admin`
- Auth: JWT (`ADMIN_JWT_SECRET`, `ADMIN_JWT_EXPIRES`, default 12h)
- Seed: first boot from `ADMIN_USERNAME` / `ADMIN_PASSWORD`
- Roles: `viewer` < `editor` < `admin` < `super_admin`

| Area | What it does |
|------|----------------|
| Dashboard | High-level status |
| MainLive | CRUD matches/streams → `mainlive.json` only (UA / Referer / Cookie supported) |
| Matches | View scraped matches, pin, status lock, stream edits, Match URL, restore-from-github |
| Leagues / teams | Catalog + sync helpers |
| Sources | Enable/disable scrapers; edit config |
| Feeds | Publish highlight1/2, tips, myanmartv |
| Pipeline | Manual run matches / highlights / channels / tips |
| Notifications | FCM templates / send / history |
| Logs / users | Action log; user create for super_admin |

---

## 13. Flutter HTTP feeds

| Path | Delivery key |
|------|----------------|
| `/flutter/mainlive.json` | `mainlive` |
| `/flutter/matches.json` | `matches` (fallback `current.json`) |
| `/flutter/highlight.json` / `highlight1.json` | `highlight1` |
| `/flutter/highlight2.json` | `highlight2` |
| `/flutter/myanmartv.json` / `channels.json` | `myanmartv` |
| `/flutter/tips.json` | `tips` |
| `/flutter/app-version.json` | app-version store |

`ENABLE_PUBLIC_JSON=true` → unauthenticated GET; else require `x-api-key` / `apiKey`.

### Match JSON (matches / mainlive)

Required Flutter fields that must not disappear: `matchId`, `league`, `homeTeam`, `awayTeam`, `date`, `time`, `kickoff`, `timezone`, `status`, `streams`, `hasStreams`, `streamCount`, `originalNames`, `sourcePages`, `streamAttempts`.

There is **no** duplicate `matchStatus` field — use `status`.  
`streamStatus` = search/playback. `streams[].headers` is what the player should send.

Important Match URL fields:

```json
{
  "matchUrl": "https://cakhiazaa.tv/truc-tiep/...",
  "matchUrlStatus": "MATCH_URL_CONFIRMED",
  "matchUrlAttempts": 1,
  "sourcePages": { "cakhia": "https://cakhiazaa.tv/truc-tiep/..." },
  "matchUrlSearch": {
    "sources": {
      "cakhia": {
        "matchUrl": "https://cakhiazaa.tv/truc-tiep/...",
        "status": "MATCH_URL_CONFIRMED",
        "attempts": 1,
        "liveAttempts": 0
      }
    }
  },
  "streamStatus": "AVAILABLE",
  "streams": [
    {
      "source": "cakhia",
      "type": "m3u8",
      "url": "https://....m3u8",
      "headers": { "User-Agent": "...", "Referer": "..." },
      "active": true
    }
  ]
}
```

MainLive sets `meta.feed = "mainlive"` and `meta.source = "admin"`.

### `highlight1.json` / `highlight2.json`

```json
{
  "generatedAt": "...",
  "count": 8,
  "highlights": [
    {
      "id": "...",
      "title": "...",
      "img": "...",
      "url": "...",
      "m3u8": "...",
      "embed_url": "...",
      "headers": {}
    }
  ]
}
```

### `myanmartv.json`

Plain array of channels (`title`, `streamUrl`, `headers`, …). Tokens expire ~10 minutes — refresh often.

### `tips.json`

```json
{
  "generatedAt": "...",
  "timezone": "Asia/Yangon",
  "today": { "count": 100, "tips": [] },
  "tomorrow": { "count": 80, "tips": [] },
  "count": 180
}
```

---

## 14. Key directories / files

```
AWS_Server/
├── src/index.js                 # boot
├── src/app.js                   # Express + Flutter aliases
├── src/routes/api.js            # public API
├── src/services/
│   ├── pipeline.js              # orchestration + dedicated jobs + stuck locks
│   ├── scheduler.js             # crons
│   ├── streamEngine.js          # Match URL gate + extract queue
│   ├── multiMatchScraper.js     # Today-page discovery + scoring
│   ├── fixtureService.js        # FotMob
│   ├── matchesSyncService.js    # expire + merge
│   ├── githubService.js         # PUT if changed / refuse_empty
│   ├── jsonGenerator.js         # Flutter match payload
│   ├── statusService.js         # match clock status
│   ├── streamValidator.js       # header-aware HLS
│   ├── configLoader.js          # local/GitHub merge
│   ├── cacheService.js          # data/ + data/delivery/
│   └── deliveryFormats.js
├── src/utils/
│   ├── scraperConfig.js         # env slots/concurrency
│   ├── matchUrlDiscovery.js     # per-source Match URL state
│   ├── streamExtractPolicy.js   # AVAILABLE/SEARCHING/FAILED
│   ├── streamUrlHelper.js       # parse + score + MATCH_URL_STATUS
│   └── jobQueue.js
├── src/sources/                 # fotmob, generic, xoilac, socolive, highlight, tips, TV
├── src/admin/                   # routes + publish / mainLive / feeds
├── src/browser/puppeteerManager.js
├── src/monitor/                 # telegram, domain, github, system, pm2
├── config/{sources,leagues,teams}.json
├── data/                        # current.json, previous.json
│   └── delivery/                # matches, mainlive, highlight*, myanmartv, tips
├── public/admin/
├── scripts/
│   ├── checkTodayMatchUrls.js   # manual site vs fixture Match URL check
│   └── testMatchUrlMatching.js  # unit tests for matching / slots
├── ecosystem.config.js
└── How_It_works.md              # this file
```

---

## 15. Monitoring / Telegram

Typical alerts: scraper crash, source scrape exception, website timeout, all-sources-failed, GitHub upload failed, high memory, PM2 restart, domain down/changed, daily report.

**Stream validation failures** (HTTP_403, NOT_HLS, empty playlist, …) do **not** send scraper-failed Telegram messages. Those are expected retry states until `STREAM_MAX_ATTEMPTS` is exhausted.

---

## 16. Operational notes (EC2)

| Topic | Detail |
|-------|--------|
| **`USE_LOCAL_CONFIG=true`** | Deployed `config/sources.json` wins over GitHub |
| **Stuck locks** | Clear after ~20 min so tips/highlights/TV are not starved |
| **Pending drain** | Dedicated jobs queue behind pipeline, then run |
| **Low memory** | `LOW_MEMORY_MODE`, heap ~256MB, `SCRAPER_CONCURRENCY=2`, `PUPPETEER_MAX_PAGES=2`, Chrome system binary (avoid snap Chromium under PM2), `max_memory_restart` ~350M |
| **Full scrape vs fixtures-only** | Only full `pipeline.run` / Run Scraper fills Match URLs |
| **GitHub from Windows** | Uploads often fail (`ECONNRESET`); refresh on EC2 |
| **Restore** | Empty local matches → pull from GitHub (`POST /api/admin/matches/restore-from-github`) |
| **Domain monitor** | Telegram only; never auto-edits domains |

### Useful commands

```bash
npm start
npm run pm2:start
npm run scrape
npm run scrape -- --highlights
npm run scrape -- --tips
npm run scrape -- --myanmartv
node scripts/checkTodayMatchUrls.js
node scripts/testMatchUrlMatching.js
```

---

## 17. Quick troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| Matches exist but `matchUrl` null, `attempts: 0`, empty `matchUrlSearch` | Discovery never ran (fixtures-only refresh, stuck lock, outside −60…+2h) |
| Sites have `/truc-tiep/...` but feed empty | Same — run full scraper on EC2 |
| Highlights / tips / TV stale | Stuck `tipsRunning` / mutual exclusion / cron not firing — check `/api/health`, restart PM2 after deploy |
| GitHub `refuse_empty` | Local delivery empty; sync would wipe remote — restore or fix scrape first |
| Wrong / missing Match URL for one team | Scoring reject, name alias gap in `teams.json`, or listing not on Today page yet |
| m3u8 `FAILED` with valid Match URL | Extract slots missed, headers wrong, or stream not live until closer to kickoff |

---

*Keep this document in sync with `ecosystem.config.js`, `config/sources.json`, and `src/services/scheduler.js` when crons or domains change.*
