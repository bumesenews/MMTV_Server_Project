# How this project works

Football live-streaming backend for a Flutter app. It scrapes fixtures and stream URLs, builds JSON feeds, serves them over HTTP, and uploads to GitHub when content changes.

| | |
|---|---|
| **Timezone** | `Asia/Yangon` (canonical). Streaming URL clocks are often ICT / `Asia/Bangkok` and are converted to Yangon before matching. |
| **Production host** | AWS EC2 `t3.micro` (1GB RAM) + PM2 + 1GB swap |
| **Runtime** | Node.js ≥ 18 |
| **Entry** | `src/index.js` (PM2: `ecosystem.config.js`) |

**GitHub is delivery + remote config only — not a database.**  
Working store = local `data/`. Flutter can read this server (`/flutter/*.json`) or GitHub raw URLs after upload.

**Architecture rule:** FotMob is the fixture source of truth. Streaming sites are stream sources only. Do not invent matches from streaming sites.

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
FotMob (fixtures, today + tomorrow)     ← source of truth for teams / date / kickoff
        │
        ▼
Match URL discovery (Today page only)
   · −60 / −45 / −30 minutes before kickoff (max 3 attempts per source)
   · identity: home + away + Yangon date + kickoff
   · stop that source once a URL is saved
        │
        ▼
Stream extract (confirmed Match URL only)
   · kickoff / +5 / +10  →  stop at +15
   · Axios first → Puppeteer only if Axios has no *validated* stream
   · header-aware HLS validation (Referer / UA / Origin / Cookie)
   · AVAILABLE only after validation.ok === true
        │
        ▼
matchesSync (expire kickoff+2h, merge streams)
        │
        ▼
Match status (kickoff clock):  Scheduled → PREPARING_STREAM → LIVE → END
Stream status (search):        PREPARING_STREAM / SEARCHING / AVAILABLE / FAILED
        │
        ├──► data/delivery/matches.json  (always)
        └──► GitHub matches.json         (only if changed + auth OK)

Highlights (Hoofoot) and MyanmarTV run on slower separate crons.
Telegram alerts ops events (never auto-edits domains).
```

Example for kickoff **20:00 Yangon**:

| Time | Match URL | Stream extract |
|------|-----------|----------------|
| 19:00 | attempt 1 (−60m) | — |
| 19:15 | attempt 2 (−45m) if still missing | — |
| 19:30 | attempt 3 (−30m) if still missing | starts (read saved Match URL) |
| 19:45 | stopped | retry if needed |
| 19:55 | — | retry if needed |
| 20:00 | — | kickoff extract |
| 20:05 | — | +5 |
| 20:10 | — | +10 |
| 20:15 | — | **STOP** — cancel pending jobs |

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
Main pipeline     PIPELINE_CRON      = */15 * * * *     ← see warning below
  └── matches.json  (fixtures + Match URL discovery + stream extract + status + publish)

Highlight job     HIGHLIGHT_CRON     = 0 */6 * * *
  └── highlight.json

MyanmarTV job     MYANMARTV_CRON     = 0 */12 * * *

Domain health     DOMAIN_CHECK_CRON  = */30 * * * *
  └── Telegram only (never edits sources.json)
```

**Code fallbacks if env vars are unset:**

| Job | Fallback in code |
|-----|------------------|
| Pipeline | every **1** minute |
| Highlights | every **3** hours |
| MyanmarTV | every **12** hours |
| Domain check | every **30** minutes |

**Important:** stream-search slots are 5 minutes apart (`STREAM_SEARCH_INTERVAL_MINUTES=5`). A `PIPELINE_CRON` of `*/15` will miss kickoff+5 / +10. To hit every slot, use `PIPELINE_CRON=*/5 * * * *`. The default `*/15` is a 1GB RAM trade-off, not a slot design.

Heavy jobs **skip** if another heavy job is already running (pipeline ↔ highlights ↔ MyanmarTV) to avoid OOM on 1GB.

---

## 5. Configuration

### Files

| File | Purpose |
|------|---------|
| `config/sources.json` | Scrapers, domains, priorities, selectors, `playbackHeaders` |
| `config/leagues.json` | Allowed leagues / aliases |
| `config/teams.json` | Team catalog / aliases / logos |
| `.env` | Secrets, crons, Chromium path, GitHub, search slots |
| `src/utils/scraperConfig.js` | Reads search/concurrency env once at process start |

### How config is loaded (`ConfigLoader`)

1. If GitHub credentials exist → try load remote `GITHUB_CONFIG_PATH` (default `config/`)
2. Always load local `LOCAL_CONFIG_DIR` (default `./config`)
3. Merge rules:
   - **`USE_LOCAL_CONFIG=true` (default):** prefer **local `sources.json`** so a stale GitHub copy cannot re-enable removed scrapers / old domains
   - **Leagues:** merge by `standardName`; **local wins** on conflict; drop legacy `AFF Cup` if `ASEAN Championship` exists
   - **Teams:** local list wins if non-empty
4. If GitHub fails → local only

Admin can still edit remote config (Remote Config page / GitHub), but **deployed `config/sources.json` is authoritative** when `USE_LOCAL_CONFIG` is true.

### Runtime search settings (`.env`)

These must not be hard-coded in business logic. `src/utils/scraperConfig.js` is the single reader.

| Variable | Default | Meaning |
|----------|---------|---------|
| `STREAM_SEARCH_INTERVAL_MINUTES` | `5` | Minutes between post-kickoff extract attempts, and poll interval inside the search window |
| `STREAM_MAX_ATTEMPTS` | `3` | Post-kickoff extract attempts per source (kickoff / +5 / +10) |
| `STREAM_POST_KICKOFF_MAX_MINUTES` | `15` | Hard stop; cancel pending extract jobs |
| `SCRAPER_CONCURRENCY` | `2` | Max simultaneous extract jobs (1GB) |
| `MATCH_URL_PRE_KICKOFF_MINUTES` | `60,45,30` | Today-page Match URL discovery schedule |
| `MATCH_TIME_TOLERANCE_MIN` | `10` | Max \|FotMob kickoff − URL kickoff\| after both are Yangon |
| `PUPPETEER_CONCURRENCY` | `1` | Global Puppeteer task queue for Match URL browser fallback |
| `PUPPETEER_MAX_PAGES` | `2` (or `SCRAPER_CONCURRENCY`) | Max Chromium pages for stream extract |
| `STREAM_VALIDATION_TIMEOUT_MS` | `12000` | HLS playlist GET timeout |
| `MAX_STREAM_RETRIES` | `1` | **Not** stream-search attempts. Per-request Puppeteer/HTTP retry only. |

Do not alias `MAX_STREAM_RETRIES` to `STREAM_MAX_ATTEMPTS`.

---

## 6. Streaming sources (current allowlist)

From `config/sources.json`:

| Name | Type | Priority | Domain | Notes |
|------|------|----------|--------|-------|
| `fotmob` | fixtures | — | `https://www.fotmob.com` | API fixtures (today + tomorrow) |
| `cakhia` | streaming | 450 | `https://cakhiazvm.tv` | axios-first, generic |
| `xoilac` | streaming | 400 | `https://xoilacxtn.tv` | custom parser `xoilac` |
| `colatv` | streaming | 350 | `https://colatv65.live` | generic |
| `socolive` | streaming | 300 | `https://socolivepp.tv` | custom parser `socolive`; playback Referer is `https://soco.textliveupdaterz.com/` |
| `highlight` | highlights | — | `https://hoofoot.com/` | own cron |
| `myanmartv` | channels | — | `https://www.myanmartvchannels.com/` | own cron |

Each streaming source has `playbackHeaders` (User-Agent + Referer, Origin only if required). Those headers are used for **validation and Flutter playback**, not for HTML list-page scraping.

Removed from production config (must not come back via stale GitHub): `luongson`, `90phut`, `yyzb`.

Sources without a custom parser use `GenericStreamingSource`. Registry may still contain old parser names; if they are not listed/enabled in `sources.json`, they are unused.

### Adding a streaming site

1. Add entry in `config/sources.json` (`type: "streaming"`, domains, paths, `extractionMethod`, `playbackHeaders`)
2. Optionally register a parser in `PARSER_REGISTRY`
3. Enable via config and/or admin source toggle
4. Redeploy / restart so `USE_LOCAL_CONFIG` picks it up

---

## 7. Matches pipeline (`matches.json`)

Orchestrated by `src/services/pipeline.js` → `StreamEngine` → publish/sync → GitHub.

```
ConfigLoader.load(true)
  → FotMob fixtures (once per Yangon calendar day; force refreshes)
  → Merge previous streams / streamSearch / matchUrlSearch / pins from cache
  → Build enabled streaming sources (priority desc)
  → StreamEngine.collectForFixtures
       · Match URL discovery: one Today-page fetch per source, only for
         fixtures in −60/−45/−30 that do not already have a saved URL
       · process matches sequentially (Match 1 → 2 → …)
       · enqueue extract jobs only when:
           confirmed Match URL exists
           current slot is −30 / −15 / −5 / kickoff / +5 / +10
           source is not already AVAILABLE or permanently FAILED
           search has not stopped (+15)
       · JobQueue at SCRAPER_CONCURRENCY=2
       · Axios first → Puppeteer fallback → header-aware HLS validate
       · on first validated stream for a match → persist + GitHub immediately
  → Status enrich (kickoff clock: Scheduled / PREPARING_STREAM / LIVE / END)
  → PublishService (overrides, league filter, logos)
       · matchesSyncService (expire + merge)
       · generateFlutterJson
  → data/delivery/matches.json
  → GitHub upload if content changed
```

On fixture failure: **keep previous** data. Never empty-overwrite a previously populated GitHub feed (except intentional expiry cleanup or admin MainLive clear).

The main tick does **not** re-scrape highlights / Myanmar TV; it reuses the last delivery stores for the combined cache.

No extract without a confirmed Match URL. That miss does **not** burn a FAILED attempt.

---

## 8. Two clocks: Match URL vs stream extract

Defined in `src/utils/scraperConfig.js`, `src/utils/time.js`, `src/utils/matchUrlDiscovery.js`, `src/utils/streamExtractPolicy.js`, `src/services/streamEngine.js`.

Search is driven by each match’s **existing `kickoff`**. There are **no fixed daily wall-clock search times**.

### 8a. Match URL discovery (Today page)

| When (vs kickoff) | Slot | Attempt |
|-------------------|------|---------|
| −60 min | `t60` | 1 |
| −45 min | `t45` | 2 |
| −30 min | `t30` | 3 |
| After a URL is saved, or after kickoff | — | no more Today-page search |

Rules:

- Max 3 attempts per source (`MATCH_URL_PRE_KICKOFF_MINUTES` length).
- **Stop that source** as soon as a Match URL is saved (`MATCH_URL_FOUND` or `MATCH_URL_CONFIRMED`).
- After kickoff or 3 misses → `matchUrlStatus = MATCH_URL_FAILED` (never left unknown).
- List-page scrape is gated: if no fixture in this cycle still needs discovery, the Today page is not fetched.
- Transient HTTP/DNS/timeout/403/404 errors do **not** burn an attempt; the next scheduled slot still runs.
- `MATCH_CONFIRMED` from older `matches.json` rows is treated as `MATCH_URL_CONFIRMED`.

States: `MATCH_URL_PENDING` | `MATCH_URL_SEARCHING` | `MATCH_URL_FOUND` | `MATCH_URL_CONFIRMED` | `MATCH_URL_FAILED` (legacy: `MATCH_URL_NOT_FOUND`, `MATCH_CONFIRMED`).

### 8b. Stream extract (m3u8)

| When (vs kickoff) | Slot | Attempt |
|-------------------|------|---------|
| Kickoff | `t0` | 1 |
| +5 min | `tP5` | 2 |
| +10 min | `tP10` | 3 |
| +15 min | — | **STOP** — cancel pending jobs for that match |

Pre-kickoff extract **does** run from −30m once a Match URL is saved. Match URL discovery still runs first in the same tick, then stream extract.

| Rule | Detail |
|------|--------|
| Skip `AVAILABLE` | Validated stream already saved for that source |
| Retry failures | Miss at kickoff / +5 stays `SEARCHING` |
| Permanent `FAILED` | Only after **3** post-kickoff misses (`STREAM_MAX_ATTEMPTS`) |
| Stop | `STREAM_POST_KICKOFF_MAX_MINUTES` (15). Keep already-found valid streams. A delayed job must not start a new search after stop. |
| No Match URL | Skip extract; do not count as FAILED |

### Poll cadence (`getCheckIntervalMinutes`)

| Situation | Interval |
|-----------|----------|
| Far from kickoff | ~15 min |
| Inside window (−30 … +15) | `STREAM_SEARCH_INTERVAL_MINUTES` (default 5) |
| After +15 while still LIVE/PREPARING | ~5 min |
| END | no stream checks |

### Match-by-match processing

When several matches are due together:

- Do **not** launch all matches in parallel
- Process **Match 1 → Match 2 → Match 3 → …**
- For each match, consider **all** enabled sources
- Extract jobs then run through `JobQueue` (concurrency 2)
- If one source succeeds, **continue** remaining sources (do not stop early)

---

## 9. Fixture → Match URL matching

FotMob fixture is the identity. Streaming sites only supply a page URL.

### Identity (all required)

**home + away + Yangon date + kickoff.** Both teams required. League is secondary only.

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
| 75–89 | `POSSIBLE_MATCH` — extra league check |
| &lt; 75 | reject |

Time tolerance: `MATCH_TIME_TOLERANCE_MIN` (default 10). URL times are parsed as **ICT**, then converted to Yangon before compare.

Team names go through `Normalizer` + `config/teams.json`, plus `stripClubAffixes` / `stripGenderPrefix` / `teamMatchKey`. Query params and trailing random IDs are stripped from slugs.

Typical slug:

`{home}-vs-{away}-luc-{HHMM}-ngay-{DD}-{MM}-{YYYY}` (ICT clock in the URL)

Helpers: `parseStreamUrl`, `scoreStreamMatch`.

### MultiMatchScraper (`src/services/multiMatchScraper.js`)

1. Only fixtures that still need Match URL discovery in −60/−45/−30
2. Axios GET list pages (`home` + `schedule`)
3. Extract `truc-tiep/...` style links (Cheerio + regex)
4. If list empty / Cloudflare → **Puppeteer** fallback for the list page
5. Score each candidate against the FotMob fixture; keep the best accepted URL

---

## 10. Extracting a playable stream

Requires a **confirmed Match URL**. Pipeline: `httpStreamExtractor.runAxiosThenPuppeteer`.

1. **Axios + Cheerio** HTML scrape (`list_stream`, embeds, m3u8 patterns, flv→m3u8)
2. Attach merged **playback headers** (see §11)
3. **Header-aware HLS validation** (not HTTP 200 alone)
4. If Axios yields no *validated* stream → **Puppeteer** network interception (one page, then `safeClosePage`)
5. Validate Puppeteer results the same way
6. Only then mark the source **AVAILABLE**

Axios should handle most searches; Puppeteer is the fallback. Axios success with a validated playlist does **not** launch Chromium.

---

## 11. Stream validation (header-aware HLS)

`src/services/streamValidator.js` + `src/utils/streamHeaders.js`.

Some CDNs (example: `live2.streambylivepulse.com`) return 401/403/empty unless Referer / User-Agent / Origin are sent. Validating with a bare `GET <m3u8>` falsely marks a working stream FAILED.

### Header priority

```
stream-specific headers
        ↓
source playbackHeaders (or source.headers playback keys)
        ↓
global / default User-Agent
```

Guessed match-page Referer and default desktop UA do **not** override configured source `playbackHeaders`. A distinct captured embed Referer does.

On **401/403**, retry once with source playback headers before INVALID.

### AVAILABLE requires all of

1. Valid `http(s)` URL
2. GET succeeds **with** the merged headers
3. Body is HLS (`#EXTM3U`) — a `.m3u8` suffix is not enough
4. Playlist is not empty
5. Master playlist has variant URIs (first media playlist fetched when practical)
6. Media playlist has usable segments (or `#EXT-X-MAP`)

### Internal `validation.state`

`VALIDATING` · `AVAILABLE` · `INVALID` · `TIMEOUT` · `HTTP_401` · `HTTP_403` · `HTTP_404` · `NOT_HLS` · `EMPTY_PLAYLIST` · `NO_SEGMENTS`

These go to `validationStatus` / `validationReason` on the match. They do **not** replace Flutter `streamStatus`.

On success, the headers that worked are saved as `streamHeaders` / `streams[].headers` so Flutter playback uses the same Referer/UA/Origin. Cookies may be in the JSON for playback; logs and Telegram never print cookie/token values (`configured` / `none` only).

---

## 12. Status separation

Keep these independent. Flutter `status` is **match** status (kickoff clock). Playback readiness is `streamStatus`.

| Field | Values | Meaning |
|-------|--------|---------|
| `status` (match) | `Scheduled` · `PREPARING_STREAM` · `LIVE` · `END` | Kickoff vs now. After kickoff+15m, **LIVE requires a stream URL**; otherwise `END`. |
| `matchUrlStatus` | `MATCH_URL_PENDING` · `MATCH_URL_FOUND` · `MATCH_URL_CONFIRMED` · `MATCH_URL_FAILED` | Today-page result |
| `streamStatus` | `PREPARING_STREAM` · `SEARCHING` · `AVAILABLE` · `FAILED` | Extract/search outcome |
| `validationStatus` | `VALIDATING` · `AVAILABLE` · `HTTP_403` · `NOT_HLS` · … | Last HLS check |

Example while a match is on and the scraper is still looking:

```
status            = LIVE
matchUrlStatus    = MATCH_URL_CONFIRMED
streamStatus      = SEARCHING
validationStatus  = VALIDATING   (or HTTP_403 after a failed try)
```

`streamStatus` becomes `AVAILABLE` only when `validation.ok === true`.

`src/services/statusService.js` match clock:

| Condition | `status` |
|-----------|----------|
| Before kickoff − lead | `Scheduled` |
| Kickoff − lead … kickoff | `PREPARING_STREAM` |
| Kickoff … kickoff + 15m | `LIVE` (stream search may still be running) |
| Kickoff + 15m … +120m, with a stream URL | `LIVE` |
| Kickoff + 15m … +120m, **no stream URL** | `END` (so Flutter does not keep it live) |
| After +120m | `END` (streams stripped) |

Admin / `statusLocked` can freeze match status. Live window: `MATCH_LIVE_DURATION_MIN = 120`.

---

## 13. Job queue, concurrency, +15 cancel

`src/utils/jobQueue.js`

- Concurrency = `SCRAPER_CONCURRENCY` (default **2**)
- Job key: `matchId:source:stream:attemptN`  
  `match123:soco:stream:attempt1` and `…:attempt2` are different jobs. The same attempt never runs twice simultaneously.
- Duplicate keys in one cycle are skipped.
- At kickoff +15: `cancelMatch(matchId)` drops pending jobs; in-flight extract sees `shouldAbort` / `isCancelled` and must not start Puppeteer.
- Puppeteer: one shared browser, max 2 pages, `safeClosePage` in `finally` after every attempt. Axios success does not open a second Chromium.

---

## 14. Immediate save on valid stream

As soon as any source returns a **validated** stream for a match:

1. Update that match in memory
2. Run expire/merge sync for delivery
3. Save `matches.json` immediately
4. Trigger GitHub upload if content changed

Do not wait for all sources or all matches in the cycle. End-of-cycle publish still runs for the full fixture set.

---

## 15. Expire & merge (`matchesSyncService`)

Before every save / GitHub push for matches:

1. Drop matches whose kickoff is older than **kickoff + 2 hours** (`MATCH_EXPIRE_AFTER_SEC`, default `7200`)
2. Merge by `matchId`:
   - Append new valid stream URLs
   - Skip streams marked `active: false` or `validation.ok: false`
   - Preserve admin flags: `manual`, `statusLocked`, `pinned`, `featured`
   - Merge `streamAttempts` / `sourcePages` / names / headers / `streamHeaders`
   - Prefer incoming `streamSearch` / `matchUrlSearch`
3. Append brand-new `matchId`s
4. Change detection decides whether GitHub PUT is needed
5. Intentional empty file is allowed only when expiry cleaned everything; otherwise refuse empty overwrite

---

## 16. GitHub delivery

`src/services/githubService.js`

| Env | Role |
|-----|------|
| `GITHUB_TOKEN` | PAT (classic `repo` or fine-grained **Contents: Read and write**) |
| `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_BRANCH` | Target repo |
| `GITHUB_*_PATH` | File paths (defaults: `matches.json`, `highlight.json`, `myanmartv.json`, `mainlive.json` at repo root) |

Rules:

- Upload **only when content changed** (volatile fields stripped: `generatedAt`, `updatedAt`, `checkedAt`, attempt timestamps)
- **Refuse empty overwrite** if previous local/remote feed was populated
- Scraper publish **omits** `mainlive` so admin owns it
- `401 Bad credentials` = wrong/missing token or placeholder `YOUR_GITHUB_*` in `.env` — not a scraper bug
- Config path on GitHub is separate from Flutter JSON delivery path

---

## 17. Highlights & Myanmar TV

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

## 18. Domain health monitor

`src/monitor/domain.monitor.js` + scheduler cron:

- Probes enabled **streaming** primary domains
- After `DOMAIN_CHECK_FAIL_THRESHOLD` (default **3**) consecutive failures → follow redirects / mirrors / www variants
- Sends Telegram: domain changed vs site down
- State file: `data/domain-check-state.json`
- **Never auto-edits `sources.json`** — humans update domains after the alert

Disable with `DOMAIN_CHECK_ENABLED=false`.

---

## 19. Telegram

`src/services/telegram.service.js` — cooldown + fingerprint so the same alert is not spammed (`TELEGRAM_ALERT_COOLDOWN_MS`, default 15 min).

Typical alerts: scraper crash, source scrape exception, website timeout, all-sources-failed, GitHub upload failed, high memory, PM2 restart, domain down/changed, daily report.

**Stream validation failures** (HTTP_403, NOT_HLS, empty playlist, …) do **not** send scraper-failed Telegram messages. Those are expected retry states until `STREAM_MAX_ATTEMPTS` is exhausted.

---

## 20. Admin panel

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

Publish path applies overrides, league filters, logos/icons, then sync + GitHub. Manual streams can carry Referer / User-Agent / Origin / Cookie for Flutter playback.

---

## 21. Flutter JSON shapes

### `matches.json` / `mainlive.json`

Flutter contract stays compatible. Additive fields from Match URL / extract / validation must not rename existing keys.

`status` = match clock. `streamStatus` = search/playback. `streams[].headers` is what the player should send.

```json
{
  "version": 1,
  "generatedAt": "2026-08-15T13:00:00.000+06:30",
  "timezone": "Asia/Yangon",
  "matchCount": 23,
  "matches": [
    {
      "matchId": "inter_juventus_20260815",
      "league": "Serie A",
      "leagueName": "Serie A",
      "fotmobMatchId": 55,
      "leagueId": 13,
      "homeTeam": "Inter",
      "awayTeam": "Juventus",
      "date": "2026-08-15",
      "time": "20:00",
      "kickoff": "2026-08-15T13:30:00.000Z",
      "kickoffTime": "20:00",
      "timezone": "Asia/Yangon",
      "status": "LIVE",
      "matchUrl": "https://socolivepp.tv/truc-tiep/...",
      "matchUrlStatus": "MATCH_CONFIRMED",
      "matchUrlAttempts": 1,
      "streamUrl": "https://live2.streambylivepulse.com/live/channel1.m3u8",
      "streamHeaders": {
        "User-Agent": "Mozilla/5.0 (Linux; Android 13; Mobile) ...",
        "Referer": "https://soco.textliveupdaterz.com/"
      },
      "streamStatus": "AVAILABLE",
      "validationStatus": "AVAILABLE",
      "validationReason": null,
      "attempts": 1,
      "streams": [
        {
          "source": "socolive",
          "type": "m3u8",
          "quality": "HD",
          "url": "https://live2.streambylivepulse.com/live/channel1.m3u8",
          "headers": {
            "User-Agent": "Mozilla/5.0 (Linux; Android 13; Mobile) ...",
            "Referer": "https://soco.textliveupdaterz.com/"
          },
          "streamHeaders": {
            "User-Agent": "Mozilla/5.0 (Linux; Android 13; Mobile) ...",
            "Referer": "https://soco.textliveupdaterz.com/"
          },
          "active": true
        }
      ],
      "hasStreams": true,
      "streamCount": 1,
      "originalNames": {},
      "sourcePages": { "socolive": "https://socolivepp.tv/truc-tiep/..." },
      "streamAttempts": { "t0": true },
      "streamSearch": {
        "started": true,
        "stopped": false,
        "sources": {
          "socolive": { "status": "AVAILABLE", "postKickoffAttempts": 1 }
        }
      },
      "matchUrlSearch": {
        "sources": {
          "socolive": {
            "matchUrl": "https://socolivepp.tv/truc-tiep/...",
            "status": "MATCH_CONFIRMED",
            "attempts": 1
          }
        }
      }
    }
  ],
  "highlights": [],
  "channels": [],
  "meta": { "feed": "matches", "checksum": "..." }
}
```

Required Flutter fields that must not disappear: `matchId`, `league`, `homeTeam`, `awayTeam`, `date`, `time`, `kickoff`, `timezone`, `status`, `streams`, `hasStreams`, `streamCount`, `originalNames`, `sourcePages`, `streamAttempts`.

There is **no** duplicate `matchStatus` field — use `status`.

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

## 22. HTTP API (public surface)

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

## 23. Production safety rules

| Rule | Why |
|------|-----|
| Refuse empty GitHub overwrite | Prevent wipe of Flutter feeds on scrape failure |
| Keep previous on fixture/highlight/TV failure | Continuity for the app |
| `forceStreamCheck: false` on boot/schedule | Avoid OOM deep scrape on t3.micro |
| Jobs never overlap | 1GB RAM |
| `SCRAPER_CONCURRENCY=2` | Cap extract + Puppeteer |
| Strong admin JWT + password required in production | `productionChecks.js` |
| Local sources preferred (`USE_LOCAL_CONFIG`) | Stale remote config cannot revive dead scrapers |
| Domain monitor = Telegram only | No silent domain rewrites |
| Puppeteer max 2 pages, close after every attempt | Memory cap |
| Sequential match processing + queued extract | Predictable load |
| Do not validate protected m3u8 without playback headers | Avoid false FAILED |
| Do not set `streamStatus=AVAILABLE` without `validation.ok` | Flutter must receive working headers |

---

## 24. Key environment variables (1GB EC2)

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
PUPPETEER_CONCURRENCY=1
PUPPETEER_TIMEOUT_MS=25000
BROWSER_RESTART_EVERY_N_PAGES=5
SCRAPER_CONCURRENCY=2
STREAM_SEARCH_INTERVAL_MINUTES=5
STREAM_MAX_ATTEMPTS=3
STREAM_POST_KICKOFF_MAX_MINUTES=15
MATCH_URL_PRE_KICKOFF_MINUTES=60,45,30
MATCH_TIME_TOLERANCE_MIN=10
STREAM_VALIDATION_TIMEOUT_MS=12000
MAX_STREAM_RETRIES=1

# Use */5 to hit kickoff / +5 / +10. */15 will miss some extract slots.
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

## 25. Important source files

| Path | Role |
|------|------|
| `src/index.js` | Boot, listen, staggered jobs, shutdown |
| `src/app.js` | Express routes + Flutter aliases |
| `src/services/pipeline.js` | Orchestration |
| `src/services/streamEngine.js` | Match URL gating + queued extract |
| `src/services/streamValidator.js` | Header-aware HLS validation |
| `src/services/multiMatchScraper.js` | Today page → candidate Match URLs |
| `src/utils/streamUrlHelper.js` | URL parse + home/away/date/time score |
| `src/utils/matchUrlDiscovery.js` | Per-source Match URL state (−60/−45/−30) |
| `src/utils/streamExtractPolicy.js` | AVAILABLE / SEARCHING / FAILED policy |
| `src/utils/streamHeaders.js` | Playback header merge + log redaction |
| `src/utils/scraperConfig.js` | `.env` search/concurrency settings |
| `src/utils/jobQueue.js` | Concurrency 2, dedupe, +15 cancel |
| `src/sources/httpStreamExtractor.js` | Axios first, Puppeteer fallback |
| `src/services/matchesSyncService.js` | Expire + merge before save/GitHub |
| `src/services/githubService.js` | Change-only PUT, refuse empty |
| `src/services/configLoader.js` | Local/GitHub config merge |
| `src/services/scheduler.js` | Crons |
| `src/services/jsonGenerator.js` | Flutter match payload |
| `src/services/statusService.js` | Kickoff match status |
| `src/browser/puppeteerManager.js` | Low-memory browser |
| `src/monitor/domain.monitor.js` | Domain Telegram alerts |
| `src/utils/productionChecks.js` | Production boot guards |
| `src/admin/**` | Admin API + services |
| `config/sources.json` | Live scraper allowlist + `playbackHeaders` |
| `data/delivery/*.json` | Served / uploaded feeds |
| `ecosystem.config.js` | PM2 process definition |

---

## 26. CLI / npm scripts

| Command | Purpose |
|---------|---------|
| `npm start` | Run server (`src/index.js`) |
| `npm run dev` | Watch mode |
| `npm run scrape` | CLI pipeline (`--force`, `--highlights`, `--myanmartv`) |
| `npm run admin:seed` | Seed admin user |
| `npm run telegram:test` | Smoke Telegram alerts |
| `npm run test:match-url` | Fixture → Match URL matching tests |
| `npm run test:stream-extract` | Extract / retry / queue tests |
| `npm run test:stream-validate` | Header-aware HLS validation tests |
| `npm run test:config-state` | Env, slots, jobs, Flutter/GitHub/Telegram compatibility |
| `npm run pm2:start` | `pm2 start ecosystem.config.js` |
| `npm run pm2:logs` | Tail PM2 logs |

---

## 27. Deploy checklist (EC2)

1. Copy `.env.production.example` → `.env` and fill **real** secrets (never leave `YOUR_*`)
2. Confirm `GITHUB_TOKEN` works (`api.github.com/user` must not return 401)
3. Confirm Chromium path + `LOW_MEMORY_MODE=true` + `SCRAPER_CONCURRENCY=2`
4. Ensure `config/sources.json` has only the intended streaming sites and `playbackHeaders`
5. Decide `PIPELINE_CRON`: `*/5` to hit every extract slot, or `*/15` to spare RAM
6. `npm ci` (or `npm install`) → `npm run pm2:start`
7. Open `/api/health` and `/admin`
8. Watch PM2 logs for first pipeline + GitHub upload (`reason: changed` or `unchanged`, not `401`)
9. Rotate any token that was ever committed or pasted into chat

---

## 28. Design constraints (do not break)

- Keep Flutter match JSON shape stable (`matchId`, `homeTeam`, `awayTeam`, kickoff, `status`, `streams[]` with `headers`)
- Keep `status` (match clock) separate from `streamStatus` (search/playback)
- Do not mark `AVAILABLE` without validated HLS + playback headers in the JSON
- Keep plugin/source registry pattern
- Keep `Scheduled` / `PREPARING_STREAM` / `LIVE` / `END` match-status semantics
- GitHub is not a DB — local `data/` is source of working truth
- Never empty-overwrite populated feeds on scrape failure
- Telegram notifies only — never auto-rewrite domains
- Prefer smallest safe changes over rewrites when extending scrapers
- Do not rewrite the scraper architecture to add a source or header
