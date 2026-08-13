# How this project works

Football live-streaming backend for a Flutter app. It scrapes fixtures and stream URLs, builds JSON feeds, serves them over HTTP, and uploads to GitHub when content changes.

| | |
|---|---|
| **Timezone** | `Asia/Yangon` (stream URL date slugs often use ICT / Asia/Bangkok) |
| **Production host** | AWS EC2 `t3.micro` (1GB RAM) + PM2 + 1GB swap |
| **Runtime** | Node.js ≥ 18 |
| **Entry** | `src/index.js` (PM2: `ecosystem.config.js`) |

**GitHub is delivery + remote config only — not a database.**  
Working store = local `data/`. Flutter can read this server (`/flutter/*.json`) or GitHub raw URLs after upload.

---

## 1. What the system produces

| Feed | Local file | HTTP | Who owns it |
|------|------------|------|-------------|
| **MainLive** | `data/delivery/mainlive.json` | `/flutter/mainlive.json` | Admin panel only |
| **Matches** (SecondLive) | `data/delivery/matches.json` | `/flutter/matches.json` | Scraper (+ admin overrides / manual) |
| **Highlights** | `data/delivery/highlight.json` | `/flutter/highlight.json` | Highlight job (own cron) |
| **Myanmar TV** | `data/delivery/myanmartv.json` | `/flutter/myanmartv.json` | MyanmarTV job (own cron) |

`mainlive.json` uses the **same match JSON shape** as `matches.json`, but the scraper **never** overwrites it. Admin MainLive page is the only writer.

Also useful:

| Path | Role |
|------|------|
| `data/current.json` | Combined local cache (matches + last highlights/channels snapshot) |
| `GET /api/health` | Liveness |
| `GET /` | Index of feeds/endpoints |
| `/admin` | Admin UI |
| `/api/admin/*` | Admin JWT API |

---

## 2. Mental model (end-to-end)

```
FotMob (fixtures, today + tomorrow)
        │
        ▼
Stream sites (cakhia / xoilac / colatv / socolive)
   · discover match pages near kickoff
   · Axios first → Puppeteer fallback
   · validate m3u8 before AVAILABLE
        │
        ▼
matchesSync (expire kickoff+2h, merge streams)
        │
        ▼
Status: Scheduled → PREPARING_STREAM / LIVE → END
        │
        ├──► data/delivery/matches.json  (always)
        └──► GitHub matches.json         (only if changed + auth OK)

Highlights (Hoofoot) and MyanmarTV run on slower separate crons.
Telegram alerts ops events (never auto-edits domains).
```

---

## 3. Boot sequence

`src/index.js`:

1. Load `.env` (`dotenv`)
2. **`assertProductionEnv`** — in `NODE_ENV=production`, refuse weak/placeholder `ADMIN_JWT_SECRET` and `ADMIN_PASSWORD`
3. Create `Pipeline` → admin context → seed admin if none → attach admin
4. Start monitoring (Telegram, memory, PM2 helpers, domain monitor object)
5. Express listen on `HOST`/`PORT` (defaults `0.0.0.0:3000`)
6. Start cron `Scheduler`
7. Staggered boot jobs (**1GB-safe**, no deep scrape):
   - **+10s** → `pipeline.run({ forceStreamCheck: false })`
   - **+15s** → `runHighlights({ force: false })`
   - **+15s** → `runMyanmarTv({ force: false })`
8. On SIGINT/SIGTERM → stop scheduler/monitoring, close HTTP + Puppeteer browser

`forceStreamCheck: false` on boot avoids OOM from deep-scraping every fixture at startup.

---

## 4. Job schedule

Production defaults (`.env.example` / `ecosystem.config.js`):

```
Main pipeline     PIPELINE_CRON      = */15 * * * *
  └── matches.json  (fixtures cache + kickoff stream search + status + publish)

Highlight job     HIGHLIGHT_CRON     = 0 */6 * * *
  └── highlight.json

MyanmarTV job     MYANMARTV_CRON     = 0 */12 * * *

Domain health     DOMAIN_CHECK_CRON  = */30 * * * *
  └── Telegram only (never edits sources.json)
```

**Code fallbacks if env vars are unset** (important on misconfigured hosts):

| Job | Fallback in code |
|-----|------------------|
| Pipeline | every **1** minute |
| Highlights | every **3** hours |
| MyanmarTV | every **12** hours |
| Domain check | every **30** minutes |

Heavy jobs **skip** if another heavy job is already running (pipeline ↔ highlights ↔ MyanmarTV) to avoid OOM on 1GB.

---

## 5. Configuration

### Files

| File | Purpose |
|------|---------|
| `config/sources.json` | Scrapers, domains, priorities, selectors |
| `config/leagues.json` | Allowed leagues / aliases |
| `config/teams.json` | Team catalog / logos helpers |
| `.env` | Secrets, crons, Chromium path, GitHub |

### How config is loaded (`ConfigLoader`)

1. If GitHub credentials exist → try load remote `GITHUB_CONFIG_PATH` (default `config/`)
2. Always load local `LOCAL_CONFIG_DIR` (default `./config`)
3. Merge rules:
   - **`USE_LOCAL_CONFIG=true` (default):** prefer **local `sources.json`** so a stale GitHub copy cannot re-enable removed scrapers / old domains
   - **Leagues:** merge by `standardName`; **local wins** on conflict; drop legacy `AFF Cup` if `ASEAN Championship` exists
   - **Teams:** local list wins if non-empty
4. If GitHub fails → local only

Admin can still edit remote config (Remote Config page / GitHub), but **deployed `config/sources.json` is authoritative** when `USE_LOCAL_CONFIG` is true.

---

## 6. Streaming sources (current allowlist)

From `config/sources.json`:

| Name | Type | Priority | Domain | Notes |
|------|------|----------|--------|-------|
| `fotmob` | fixtures | — | `https://www.fotmob.com` | API fixtures (today + tomorrow) |
| `cakhia` | streaming | 450 | `https://cakhiazvm.tv` | axios-first, generic |
| `xoilac` | streaming | 400 | `https://xoilacxtn.tv` | custom parser `xoilac` |
| `colatv` | streaming | 350 | `https://colatv65.live` | generic |
| `socolive` | streaming | 300 | `https://socoliveoo.tv` | custom parser `socolive` |
| `highlight` | highlights | — | `https://hoofoot.com/` | own cron |
| `myanmartv` | channels | — | `https://www.myanmartvchannels.com/` | own cron |

Removed from production config (must not come back via stale GitHub): `luongson`, `90phut`, `yyzb`.

Sources without a custom parser use `GenericStreamingSource`. Registry may still contain old parser names; if they are not listed/enabled in `sources.json`, they are unused.

### Adding a streaming site

1. Add entry in `config/sources.json` (`type: "streaming"`, domains, paths, `extractionMethod`)
2. Optionally register a parser in `PARSER_REGISTRY`
3. Enable via config and/or admin source toggle
4. Redeploy / restart so `USE_LOCAL_CONFIG` picks it up

---

## 7. Matches pipeline (`matches.json`)

Orchestrated by `src/services/pipeline.js` → `StreamEngine` → publish/sync → GitHub.

```
ConfigLoader.load(true)
  → FotMob fixtures (once per Yangon calendar day; force refreshes)
  → Merge previous streams / streamSearch / pins from cache
  → Build enabled streaming sources (priority desc)
  → StreamEngine.collectForFixtures
       · discover match pages once per source (MultiMatchScraper)
       · process matches sequentially (Match 1 → 2 → …)
       · for each due match, check ALL enabled sources
       · Axios first → Puppeteer fallback → fast health check
       · on first valid stream for a match → persist + GitHub immediately
  → Status enrich (Scheduled / PREPARING_STREAM / LIVE / END)
  → PublishService (overrides, league filter, logos)
       · matchesSyncService (expire + merge)
       · generateFlutterJson
  → data/delivery/matches.json
  → GitHub upload if content changed
```

On fixture failure: **keep previous** data. Never empty-overwrite a previously populated GitHub feed (except intentional expiry cleanup or admin MainLive clear).

The main tick does **not** re-scrape highlights / Myanmar TV; it reuses the last delivery stores for the combined cache.

---

## 8. Stream search (kickoff-relative)

Defined in `src/utils/time.js` and `src/services/streamEngine.js`.

Search is driven by each match’s **existing `kickoff` (UTC/ISO)**. There are **no fixed daily wall-clock search times**.

### Constants

| Constant | Value | Meaning |
|----------|-------|---------|
| `STREAM_FIND_LEAD_MIN` | 30 | Start searching 30 min before kickoff |
| `STREAM_SEARCH_STOP_AFTER_MIN` | 15 | Hard stop searching 15 min after kickoff |
| `MATCH_LIVE_DURATION_MIN` | 120 | Match considered ended; streams stripped |
| `MAX_POST_KICKOFF_ATTEMPTS` | 3 | Cap per source after kickoff |

### Search slots

| When (vs kickoff) | Slot id | Behaviour |
|-------------------|---------|-----------|
| Kickoff − 30 min | `t30` | First search window |
| Kickoff − 15 min | `t15` | |
| Kickoff − 5 min | `t5` | |
| Kickoff | `t0` | Counts as post-kickoff attempt |
| Kickoff + 5 min | `tP5` | Post-kickoff attempt |
| Kickoff + 10 min | `tP10` | Post-kickoff attempt |
| Kickoff + 15 min | — | **Stop all stream searching** for that match |

At stop: keep already-found valid streams; do not search that match again for new streams. Status can still refresh until END (+120 min).

### Poll cadence (`getCheckIntervalMinutes`)

| Situation | Interval |
|-----------|----------|
| Far from kickoff | ~15 min |
| Inside search window (−30 … +15) | ~2 min |
| After +15 while still LIVE/PREPARING | ~5 min |
| END | no stream checks |

### Match-by-match processing

When several matches are due together:

- Do **not** launch all matches in parallel
- Process **Match 1 → Match 2 → Match 3 → …**
- For each match, check **all** enabled sources
- If one source succeeds, **continue** remaining sources (do not stop early)

### Per-source state (`streamSearch`)

Optional field on each match (Flutter may ignore). Example:

```json
{
  "streamSearch": {
    "started": true,
    "stopped": false,
    "stopTime": null,
    "slotsDone": { "t30": true, "t15": true },
    "sources": {
      "cakhia": { "status": "AVAILABLE", "attempts": 1, "postKickoffAttempts": 0 },
      "xoilac": {
        "status": "FAILED",
        "attempts": 2,
        "postKickoffAttempts": 0,
        "lastError": "no_valid_stream"
      }
    }
  }
}
```

| Rule | Detail |
|------|--------|
| Skip `AVAILABLE` | Once AVAILABLE, do not search that source again |
| Retry failures | Failed sources may retry on later slots |
| Post-kickoff cap | At most **3** post-kickoff attempts per source |
| Hydration | Sources that already have a valid stream are treated as AVAILABLE |
| Legacy flags | `streamAttempts` (`t30`, `t15`, …) still synced for older clients |

`streamSearch` does **not** replace match status (`Scheduled` / `PREPARING_STREAM` / `LIVE` / `END`).

---

## 9. Discovering streams (MultiMatch + URL matching)

### MultiMatchScraper (`src/services/multiMatchScraper.js`)

Used by generic streaming sources to map FotMob fixtures → site match pages:

1. Filter fixtures in the search window (−30 … +15) for today/tomorrow
2. Axios GET list pages (`home` + `schedule` from source config)
3. Extract `truc-tiep/...` style links (Cheerio + regex)
4. If list empty / Cloudflare → **Puppeteer** fallback for the list page
5. For each fixture, `matchStreamToFotmob(...)` picks the best URL
6. Soft retry with `skipLeagueCheck` if league tags were too strict

### URL ↔ FotMob matching (`src/utils/streamUrlHelper.js`)

Three layers (all should agree for a confident match):

1. **Time** — kickoffs within ±30 minutes (UTC)
2. **League / country tags** — optional; can be skipped on soft retry
3. **Teams** — both home and away core keywords appear in the URL slug

Typical slug shape:

`{home}-vs-{away}-luc-{HHMM}-ngay-{DD}-{MM}-{YYYY}` (ICT)

Helpers: `parseStreamUrl`, `cleanTeamName`, `isMatchWithinWindow`, `matchStreamToFotmob`.

### Extract playable URL

`httpStreamExtractor.extractStreamsAxiosThenPuppeteer`:

1. **Axios + Cheerio** HTML scrape (`list_stream`, embeds, m3u8 patterns, flv→m3u8)
2. **Fast health check** (HEAD/GET, ~1–2s / `STREAM_FAST_HEALTH_TIMEOUT_MS`) — 2xx = valid; 403/404/timeout = invalid
3. If Axios fails or yields no valid stream → **Puppeteer** network interception
4. Validate Puppeteer results the same way before marking source **AVAILABLE**

Axios should handle most searches; Puppeteer is the fallback.

---

## 10. Puppeteer on 1GB RAM

`src/browser/puppeteerManager.js`:

- Reuse **one** browser instance
- Max **2** concurrent pages (`PUPPETEER_MAX_PAGES`, default 2) via a queue
- Block images, stylesheets, fonts, media
- Low-memory Chromium flags (`--single-process`, `--disable-dev-shm-usage`, small heap, etc.)
- Recycle browser after N pages (`BROWSER_RESTART_EVERY_N_PAGES`, default 5)
- Production: set `PUPPETEER_EXECUTABLE_PATH` to system Chromium (e.g. `/usr/bin/chromium-browser` or `/snap/bin/chromium`)

Because matches are sequential and pages are capped, the server does not open unlimited Chromium tabs when many kickoffs align.

---

## 11. Immediate save on valid stream

As soon as any source returns a **validated** stream for a match:

1. Update that match in memory
2. Run expire/merge sync for delivery
3. Save `matches.json` immediately
4. Trigger GitHub upload if content changed

Do not wait for all sources or all matches in the cycle. End-of-cycle publish still runs for the full fixture set.

---

## 12. Match status system

`src/services/statusService.js` — status is **not** taken from streaming websites’ “live” badges.

| Condition | Status | Streams |
|-----------|--------|---------|
| Before kickoff | `Scheduled` | May be empty |
| Kickoff → +120 min, **no** valid stream | `PREPARING_STREAM` | Empty / not yet verified |
| Kickoff → +120 min, **valid** stream | `LIVE` | Kept |
| After +120 min | `END` | Removed |

- **`LIVE` never from kickoff alone** — requires a playable/validated stream URL
- Admin / `statusLocked` can freeze status
- Live window: `MATCH_LIVE_DURATION_MIN = 120`

---

## 13. Expire & merge (`matchesSyncService`)

Before every save / GitHub push for matches:

1. Drop matches whose kickoff is older than **kickoff + 2 hours** (`MATCH_EXPIRE_AFTER_SEC`, default `7200`)
2. Merge by `matchId`:
   - Append new valid stream URLs
   - Skip streams marked `active: false` or `validation.ok: false`
   - Preserve admin flags: `manual`, `statusLocked`, `pinned`, `featured`
   - Merge `streamAttempts` / `sourcePages` / names; prefer incoming `streamSearch`
3. Append brand-new `matchId`s
4. Change detection decides whether GitHub PUT is needed
5. Intentional empty file is allowed only when expiry cleaned everything; otherwise refuse empty overwrite

---

## 14. GitHub delivery

`src/services/githubService.js`

| Env | Role |
|-----|------|
| `GITHUB_TOKEN` | PAT (classic `repo` or fine-grained **Contents: Read and write**) |
| `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_BRANCH` | Target repo |
| `GITHUB_*_PATH` | File paths (defaults: `matches.json`, `highlight.json`, `myanmartv.json`, `mainlive.json` at repo root) |

Rules:

- Upload **only when content changed** (volatile fields stripped for compare)
- **Refuse empty overwrite** if previous local/remote feed was populated
- Scraper publish **omits** `mainlive` so admin owns it
- `401 Bad credentials` = wrong/missing token or placeholder `YOUR_GITHUB_*` in `.env` — not a scraper bug
- Config path on GitHub is separate from Flutter JSON delivery path

---

## 15. Highlights & Myanmar TV

| Job | Method | Production cron | Behaviour |
|-----|--------|-----------------|-----------|
| Highlights | `runHighlights` | every 6 hours | Hoofoot scrape → merge/dedupe → retention (~7 days) → `highlight.json` |
| MyanmarTV | `runMyanmarTv` | every 12 hours | Channel list → `myanmartv.json` array |

Shared safety:

- Mutual exclusion with the main pipeline
- On scrape failure → keep previous file
- GitHub only if changed; refuse empty wipe of a populated feed
- Main pipeline only **reuses** last stores (does not re-scrape these)

---

## 16. Domain health monitor

`src/monitor/domain.monitor.js` + scheduler cron:

- Probes enabled **streaming** primary domains
- After `DOMAIN_CHECK_FAIL_THRESHOLD` (default **3**) consecutive failures → follow redirects / mirrors / www variants
- Sends Telegram: domain changed vs site down
- State file: `data/domain-check-state.json`
- **Never auto-edits `sources.json`** — humans update domains after the alert

Disable with `DOMAIN_CHECK_ENABLED=false`.

---

## 17. Admin panel

- UI: `http://<host>:3000/admin` (`public/admin/`)
- Auth: JWT (`ADMIN_JWT_SECRET`, `ADMIN_JWT_EXPIRES`)
- Seed: first boot creates user from `ADMIN_USERNAME` / `ADMIN_PASSWORD` (production forbids `admin123` / placeholders)
- Roles: `viewer` < `editor` < `admin` < `super_admin`

Typical capabilities:

| Area | What it does |
|------|----------------|
| Dashboard | High-level status |
| MainLive | CRUD matches/streams → `mainlive.json` only |
| Matches | View scraped matches, pin, status lock, stream edits, manual matches |
| Leagues / teams | Catalog + sync helpers |
| Sources | Enable/disable scrapers; edit config (admin) |
| Notifications | FCM send / templates / history |
| Logs | Admin action log |
| Pipeline run | Manual `POST` with optional `force` |

Publish path applies overrides, league filters, logos/icons, then sync + GitHub.

---

## 18. Flutter JSON shapes

### `matches.json` / `mainlive.json`

```json
{
  "version": 1,
  "generatedAt": "2026-08-13T15:00:00.000Z",
  "timezone": "Asia/Yangon",
  "matchCount": 23,
  "matches": [
    {
      "matchId": "...",
      "league": "...",
      "home": "...",
      "away": "...",
      "homeLogo": null,
      "awayLogo": null,
      "date": "2026-08-13",
      "time": "19:30",
      "kickoff": "2026-08-13T12:30:00.000Z",
      "status": "LIVE",
      "manual": false,
      "statusLocked": false,
      "pinned": false,
      "featured": false,
      "streams": [
        {
          "source": "cakhia",
          "type": "hls",
          "quality": "auto",
          "url": "https://.../index.m3u8",
          "headers": {},
          "active": true
        }
      ],
      "streamSearch": {},
      "streamAttempts": {}
    }
  ],
  "meta": {
    "feed": "matches",
    "liveCount": 1,
    "scheduledCount": 10,
    "endedCount": 0,
    "checksum": "..."
  }
}
```

MainLive sets `meta.feed = "mainlive"` and `meta.source = "admin"`.

### `highlight.json`

```json
{
  "source": "https://hoofoot.com/",
  "scraped_at": "...",
  "count": 8,
  "highlights": [
    {
      "id": "...",
      "title": "...",
      "img": "...",
      "url": "...",
      "match_date": "...",
      "embed_url": "...",
      "m3u8": "...",
      "headers": {},
      "source": "hoofoot"
    }
  ]
}
```

### `myanmartv.json`

Plain array:

```json
[
  { "title": "Channel", "img": "...", "streamUrl": "https://..." }
]
```

---

## 19. HTTP API (public surface)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/flutter/mainlive.json` | Admin MainLive |
| GET | `/flutter/matches.json` | Scraped matches |
| GET | `/flutter/highlight.json` | Highlights |
| GET | `/flutter/myanmartv.json` | Channels |
| GET | `/api/health` | Health |
| GET | `/api/matches` | API-shaped matches (may require `x-api-key`) |
| POST | `/api/pipeline/run` | Trigger pipeline (API key) |
| POST | `/api/admin/auth/login` | Admin JWT |
| * | `/api/admin/*` | Admin APIs |

`ENABLE_PUBLIC_JSON=true` allows unauthenticated GET of Flutter feed paths. Otherwise send `x-api-key` / `apiKey` matching `API_KEY`.

Optional: `TRUST_PROXY=true` when behind nginx/ALB.

---

## 20. Production safety rules

| Rule | Why |
|------|-----|
| Refuse empty GitHub overwrite | Prevent wipe of Flutter feeds on scrape failure |
| Keep previous on fixture/highlight/TV failure | Continuity for the app |
| `forceStreamCheck: false` on boot/schedule | Avoid OOM deep scrape on t3.micro |
| Jobs never overlap | 1GB RAM |
| Strong admin JWT + password required in production | `productionChecks.js` |
| Local sources preferred (`USE_LOCAL_CONFIG`) | Stale remote config cannot revive dead scrapers |
| Domain monitor = Telegram only | No silent domain rewrites |
| Puppeteer max 2 pages | Memory cap |
| Sequential match processing | Predictable load |

---

## 21. Key environment variables (1GB EC2)

```env
NODE_ENV=production
TZ=Asia/Yangon
HOST=0.0.0.0
PORT=3000
LOW_MEMORY_MODE=true
NODE_OPTIONS=--max-old-space-size=256 --expose-gc
USE_LOCAL_CONFIG=true

GITHUB_TOKEN=...
GITHUB_OWNER=...
GITHUB_REPO=...
GITHUB_BRANCH=main

PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser   # or /snap/bin/chromium
PUPPETEER_MAX_PAGES=2
PUPPETEER_TIMEOUT_MS=25000
BROWSER_RESTART_EVERY_N_PAGES=5
STREAM_FAST_HEALTH_TIMEOUT_MS=8000

PIPELINE_CRON=*/15 * * * *
HIGHLIGHT_CRON=0 */6 * * *
MYANMARTV_CRON=0 */12 * * *
DOMAIN_CHECK_CRON=*/30 * * * *

ADMIN_JWT_SECRET=...          # strong, not a placeholder
ADMIN_PASSWORD=...            # strong, not admin123
API_KEY=...
ENABLE_PUBLIC_JSON=true

TELEGRAM_BOT_TOKEN=...        # optional
TELEGRAM_CHAT_ID=...
```

PM2 (`ecosystem.config.js`): 1 fork instance, `max_memory_restart: 350M`, Node heap 256MB, autorestart.

---

## 22. Important source files

| Path | Role |
|------|------|
| `src/index.js` | Boot, listen, staggered jobs, shutdown |
| `src/app.js` | Express routes + Flutter aliases |
| `src/services/pipeline.js` | Orchestration |
| `src/services/streamEngine.js` | Kickoff-slot stream search |
| `src/services/multiMatchScraper.js` | List pages → FotMob match pages |
| `src/utils/streamUrlHelper.js` | URL parse + team/league/time match |
| `src/services/matchesSyncService.js` | Expire + merge before save/GitHub |
| `src/services/githubService.js` | Change-only PUT, refuse empty |
| `src/services/configLoader.js` | Local/GitHub config merge |
| `src/services/scheduler.js` | Crons |
| `src/services/jsonGenerator.js` | Flutter match payload |
| `src/services/statusService.js` | Scheduled / LIVE / END |
| `src/browser/puppeteerManager.js` | Low-memory browser |
| `src/monitor/domain.monitor.js` | Domain Telegram alerts |
| `src/utils/productionChecks.js` | Production boot guards |
| `src/admin/**` | Admin API + services |
| `config/sources.json` | Live scraper allowlist |
| `data/delivery/*.json` | Served / uploaded feeds |
| `ecosystem.config.js` | PM2 process definition |

---

## 23. CLI / npm scripts

| Command | Purpose |
|---------|---------|
| `npm start` | Run server (`src/index.js`) |
| `npm run dev` | Watch mode |
| `npm run scrape` | CLI pipeline (`--force`, `--highlights`, `--myanmartv`) |
| `npm run admin:seed` | Seed admin user |
| `npm run telegram:test` | Smoke Telegram alerts |
| `npm run pm2:start` | `pm2 start ecosystem.config.js` |
| `npm run pm2:logs` | Tail PM2 logs |

---

## 24. Deploy checklist (EC2)

1. Copy `.env.production.example` → `.env` and fill **real** secrets (never leave `YOUR_*`)
2. Confirm `GITHUB_TOKEN` works (`api.github.com/user` must not return 401)
3. Confirm Chromium path + `LOW_MEMORY_MODE=true`
4. Ensure `config/sources.json` has only the intended streaming sites
5. `npm ci` (or `npm install`) → `npm run pm2:start`
6. Open `/api/health` and `/admin`
7. Watch PM2 logs for first pipeline + GitHub upload (`reason: changed` or `unchanged`, not `401`)
8. Rotate any token that was ever committed or pasted into chat

---

## 25. Design constraints (do not break)

- Keep Flutter match JSON shape stable (`matchId`, kickoff, status, `streams[]`)
- Keep plugin/source registry pattern
- Keep `Scheduled` / `PREPARING_STREAM` / `LIVE` / `END` semantics
- GitHub is not a DB — local `data/` is source of working truth
- Never empty-overwrite populated feeds on scrape failure
- Telegram notifies only — never auto-rewrite domains
- Prefer smallest safe changes over rewrites when extending scrapers
