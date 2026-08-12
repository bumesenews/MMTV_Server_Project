# How this project works

Football live-streaming backend for Flutter. It scrapes fixtures and stream URLs, builds JSON feeds, serves them over HTTP, and optionally uploads to GitHub when data changes.

**Timezone:** Asia/Yangon  
**Production target:** AWS EC2 `t3.micro` (1GB RAM) + PM2 + 1GB swap  

GitHub is **delivery / backup / remote config only**. It is not the database. Local `data/` is the working store.

---

## What it produces

| Feed | Local file | HTTP URL | Source of truth |
|------|------------|----------|-----------------|
| MainLive | `data/delivery/mainlive.json` | `/flutter/mainlive.json` | Admin panel only |
| Matches | `data/delivery/matches.json` | `/flutter/matches.json` | Scraper (+ optional admin manual / overrides) |
| Highlights | `data/delivery/highlight.json` | `/flutter/highlight.json` | Highlight scraper (own cron) |
| Myanmar TV | `data/delivery/myanmartv.json` | `/flutter/myanmartv.json` | MyanmarTV scraper (own cron) |

`mainlive.json` uses the same match JSON shape as `matches.json`, but is managed only from the admin **MainLive** page. The scraper **never** overwrites it.

Flutter (or any client) can read from this server or from GitHub raw URLs after upload.

---

## Mental model

1. **FotMob** → which matches exist (today + tomorrow) and their kickoff time (UTC/ISO).
2. **Stream sites** → find m3u8 URLs near each match’s kickoff using a kickoff-relative schedule.
3. **Status** → from FotMob kickoff + whether a validated stream exists (`Scheduled` → `PREPARING_STREAM` / `LIVE` → `END`).
4. **Publish** → write local delivery JSON; upload to GitHub only when content changed.
5. **Highlights / Myanmar TV** → separate slower jobs; not re-scraped on every matches tick.

---

## Job schedule

Defaults below match production `.env.example` / `ecosystem.config.js`. Code fallbacks differ if env vars are unset (`PIPELINE_CRON` → every 1 min, `HIGHLIGHT_CRON` → every 3 hours).

```
Main pipeline (PIPELINE_CRON = */15 * * * *)
└── matches.json  (fixtures cache + kickoff stream search + status + publish)

Highlight Job (HIGHLIGHT_CRON = 0 */6 * * *)
└── highlight.json

MyanmarTV Job (MYANMARTV_CRON = 0 */12 * * *)
└── myanmartv.json
```

Jobs skip if another heavy job is already running (avoids OOM on 1GB).

**Boot sequence** (one at a time): wait 10s → pipeline (`forceStreamCheck: false`) → wait 15s → highlights → wait 15s → MyanmarTV.

---

## Config: GitHub first, local fallback

When `GITHUB_TOKEN` + `GITHUB_OWNER` + `GITHUB_REPO` are set, the server loads:

- `config/sources.json`
- `config/leagues.json`
- `config/teams.json`

from GitHub (`GITHUB_CONFIG_PATH`, default `config/`).

If GitHub fails or is not configured → uses local `./config/` (`LOCAL_CONFIG_DIR`).

Edit remote config via:

1. Admin → **Remote Config** → Save  
2. Or edit the files on GitHub directly  

Leagues are often merged so a stale remote file does not wipe local league settings.

---

## Matches pipeline (`matches.json`)

```
ConfigLoader (GitHub → local fallback)
  → FotMob fixtures once per Yangon calendar day (today + tomorrow)
  → Merge previous streams / streamSearch / streamAttempts from cache
  → Build enabled streaming sources from sources.json (+ admin toggles)
  → StreamEngine.collectForFixtures
       · discover match pages once per source
       · process matches sequentially (Match 1 → 2 → …)
       · for each due match, check ALL enabled sources
       · Axios first → Puppeteer fallback → fast health check
       · on first valid stream → save matches.json + GitHub immediately
  → Status enrich (Scheduled / PREPARING_STREAM / LIVE / END)
  → PublishService (manual matches, league filter, logos, overrides)
       or generateFlutterJson fallback
  → data/delivery/matches.json
  → GitHub upload if changed
```

On fixture failure: **keep previous** data. Never upload an empty overwrite over a previously populated feed.

The main tick does **not** re-scrape highlights / Myanmar TV; it reuses the last delivery stores for the combined cache payload.

---

## Stream search (kickoff-relative)

Defined in `src/utils/time.js` and `src/services/streamEngine.js`.

Search is driven by each match’s **existing `kickoff` (UTC/ISO)**. There are **no fixed daily wall-clock search times**.

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

At stop: keep already-found valid streams; never search that match again for new streams. Match status can still refresh until END (+120 min).

Inside the active search window (−30 … +15), the pipeline polls about every **2 minutes** so each slot is hit. After +15 until END, light status refresh only (~5 min). Far from kickoff, slower polling (~15 min).

### Match-by-match processing

When several matches are due together:

- Do **not** launch all matches in parallel.
- Process **Match 1 → Match 2 → Match 3 → …**
- For each match, check **all** enabled sources.
- If one source succeeds, **continue** the remaining sources (do not stop early).

### Per-source state (`streamSearch`)

Optional field on each match (Flutter-safe to ignore). Example:

```json
{
  "streamSearch": {
    "started": true,
    "stopped": false,
    "stopTime": null,
    "slotsDone": { "t30": true, "t15": true },
    "sources": {
      "luongson": { "status": "AVAILABLE", "attempts": 1, "postKickoffAttempts": 0 },
      "xoilac": { "status": "FAILED", "attempts": 2, "postKickoffAttempts": 0, "lastError": "no_valid_stream" }
    }
  }
}
```

Rules:

| Rule | Detail |
|------|--------|
| Skip `AVAILABLE` | Once a source is AVAILABLE, do not search it again in later rounds |
| Retry failures | Failed sources may retry on later slots |
| Post-kickoff cap | At most **3** post-kickoff attempts per source (`t0`, `tP5`, `tP10`) |
| Hydration | Sources that already have a valid stream on the match are treated as AVAILABLE |
| Legacy flags | `streamAttempts` (`t30`, `t15`, …) is still synced for backward compatibility |

`SCHEDULED` / `LIVE` / `END` (and `PREPARING_STREAM`) remain the match-status system — `streamSearch` does not replace them.

### Axios → Puppeteer fallback

For every enabled streaming source (`httpStreamExtractor.extractStreamsAxiosThenPuppeteer`):

1. Try **Axios + Cheerio** HTML scrape first (`list_stream`, embeds, m3u8 patterns, flv→m3u8).
2. Run a **fast HEAD/GET health check** (~1–2s). HTTP **2xx** = valid; **403 / 404 / timeout / connection failure** = invalid.
3. If Axios fails **or** returns no valid stream → **Puppeteer** network interception.
4. Validate Puppeteer results the same way before marking the source **AVAILABLE**.

Axios should handle most searches; Puppeteer is only the fallback.

Match-page **discovery** (finding the fixture URL on a site) may still use Puppeteer.

### Puppeteer on 1GB RAM

`src/browser/puppeteerManager.js`:

- Reuse **one** browser instance
- Maximum **2** concurrent pages (`PUPPETEER_MAX_PAGES`, default 2) via a page-slot queue
- Block images, stylesheets, fonts, media (and related heavy types)
- Low-memory Chromium flags (`--single-process`, `--disable-dev-shm-usage`, small JS heap, etc.)
- Recycle browser after N idle pages

Because matches are processed sequentially and pages are capped at 2, the server does not launch unlimited browser tasks when many matches are due.

### Immediate save on valid stream

As soon as any source returns a **validated** stream for a match:

1. Update that match in memory  
2. Save `matches.json` immediately (`CacheService` / delivery)  
3. Trigger the existing GitHub upload/sync path  

Do not wait for all sources or all matches in the cycle. End-of-cycle publish still runs for the full fixture set.

---

## Match status system

`src/services/statusService.js` — status is **not** taken from streaming websites’ “live” badges.

| Condition | Status | Streams |
|-----------|--------|---------|
| Before kickoff | `Scheduled` | May be empty |
| Kickoff → +120 min, **no** valid stream | `PREPARING_STREAM` | Empty / not yet verified |
| Kickoff → +120 min, **valid** stream | `LIVE` | Kept |
| After +120 min | `END` | Removed |

- **`LIVE` never from kickoff alone** — requires a playable/validated stream URL  
- Admin / `statusLocked` can freeze status  
- Live window length: `MATCH_LIVE_DURATION_MIN = 120`

---

## Source / plugin system

Configured in `config/sources.json`. Engine sources are built by `src/sources/registry.js`.

| Source | Type | Role |
|--------|------|------|
| `fotmob` | fixtures | Today + tomorrow fixtures (API), cached once per Yangon day |
| `luongson`, `xoilac` | streaming | Custom parsers + shared axios→Puppeteer extract |
| `cakhia` (and similar) | streaming | `GenericStreamingSource` (config-driven selectors) |
| `90phut`, `yyzb`, `socolive` | streaming | Present in config; often disabled |
| `highlight` | highlights | Dedicated cron → `highlight.json` |
| `myanmartv` | channels | Dedicated cron → `myanmartv.json` |

**MainLive** is not a scraper source — admin-owned feed only.

To add a streaming site:

1. Add an entry in `sources.json` (`type: "streaming"`, `enabled`, domains, selectors, `extractionMethod`)  
2. Optionally register a custom parser in `PARSER_REGISTRY`  
3. Enable the source (admin toggle and/or config)  

Sources without a custom parser use `GenericStreamingSource`.

---

## Admin panel

- UI: `http://<host>:3000/admin` (`public/admin/`)
- Auth: JWT (`ADMIN_JWT_*`; seed with `npm run admin:seed`)

Capabilities:

- **Overrides** — hide / pin / feature, status lock, kickoff edits, manual streams (manual beats auto sources)
- **Manual matches** — merged into scraper matches on publish
- **MainLive** — separate CRUD → `publishMainLive()` only
- **Leagues / teams / sources** — filters, icons, enable/disable
- **Remote config** — edit GitHub `sources.json` / related config
- **Publish / pipeline trigger**, notifications (FCM), logs, dashboard

`PublishService.publish`: merge manuals → league filter → enrich status → apply overrides → `generateFlutterJson` → local cache/delivery → GitHub.

---

## Delivery files and GitHub sync

| Feed | Local | GitHub path (env default) |
|------|-------|---------------------------|
| MainLive | `data/delivery/mainlive.json` | `GITHUB_MAINLIVE_PATH` → `mainlive.json` |
| Matches | `data/delivery/matches.json` | `GITHUB_MATCHES_PATH` / `GITHUB_DATA_PATH` |
| Highlights | `data/delivery/highlight.json` | `GITHUB_HIGHLIGHTS_PATH` |
| Myanmar TV | `data/delivery/myanmartv.json` | `GITHUB_CHANNELS_PATH` |

Rules:

- Upload only when content changed (volatile timestamps ignored in compare)
- Refuse empty overwrite if the previous feed had data
- Scraper publish omits MainLive from its bundle so admin ownership stays intact

Delivery shapes (`deliveryFormats.js`):

- `matches` / `mainlive`: `{ version, generatedAt, timezone, matchCount, matches, meta }`
- `highlight`: `{ source, scraped_at, count, highlights }`
- `myanmartv`: array of `{ title, img, streamUrl, … }`

---

## Flutter compatibility

`generateFlutterJson` match fields:

- Identity / display: `matchId`, league/teams/logos, `date`, `time`, `kickoff`, `timezone`
- Status flags: `status`, `manual`, `statusLocked`, `pinned`, `featured`, `hasStreams`, `streamCount`
- `originalNames`, `sourcePages`
- `streams[]`: `source`, `type`, `quality` / `name`, `url`, `headers` (User-Agent / Referer / Cookie), `active`, `checkedAt`, optional `manualId`
- `streamAttempts` (legacy slot flags)
- **`streamSearch` (optional)** — only included when present; clients may ignore it

Statuses to handle: `Scheduled` | `PREPARING_STREAM` | `LIVE` | `END`.

---

## Low-memory production (1GB)

| Setting | Typical value |
|---------|----------------|
| `LOW_MEMORY_MODE` | `true` |
| Node heap | `--max-old-space-size=256 --expose-gc` |
| PM2 `max_memory_restart` | `350M` |
| Pipeline cron | every **15 min** |
| Highlights | every **6 hours** |
| MyanmarTV | every **12 hours** |
| Puppeteer max pages | **2** |
| Puppeteer timeout | `25000` ms |
| Browser restart | every **5** pages (idle) |
| `PUPPETEER_HEADLESS` | `new` |
| Chromium | `--single-process`, block images/CSS/fonts/media, small JS heap |

Also recommended on Ubuntu EC2: **1GB swap** + `vm.swappiness=10`.

See `.env.example` and `ecosystem.config.js` for the full tuned values.

---

## Monitoring (optional Telegram)

When `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are set (`src/monitor/`, `telegram.service.js`):

- Scraper failures / timeouts  
- GitHub upload failures  
- Memory / PM2 health  
- Daily report (default 09:00 Yangon)  
- Crash hooks on fatal errors  

Test with `npm run telegram:test`.

---

## Main modules

| Path | Role |
|------|------|
| `src/index.js` | Boot API, admin, scheduler, staggered initial jobs, shutdown |
| `src/app.js` | Express app, `/flutter/*`, API key gate, admin static |
| `src/routes/api.js` | Health, matches, pipeline triggers, cache/feeds |
| `src/cli/runPipeline.js` | One-shot scrape CLI |
| `ecosystem.config.js` | PM2 process + low-mem env |
| `src/services/pipeline.js` | Matches pipeline + highlight + MyanmarTV jobs; immediate stream persist |
| `src/services/streamEngine.js` | Kickoff slots, `streamSearch`, sequential multi-source extract |
| `src/services/scheduler.js` | Three Yangon-timezone cron jobs |
| `src/utils/time.js` | Yangon time, search slots, check intervals, LIVE duration |
| `src/services/statusService.js` | Scheduled / PREPARING_STREAM / LIVE / END |
| `src/services/jsonGenerator.js` | Flutter payload shape (+ optional `streamSearch`) |
| `src/services/deliveryFormats.js` | Split delivery files for HTTP/GitHub |
| `src/services/githubService.js` | Change-only GitHub JSON upload |
| `src/services/cacheService.js` | Local `current` / `previous` + `data/delivery/*` |
| `src/services/configLoader.js` | GitHub or local config load |
| `src/services/fixtureService.js` | FotMob fixture collection |
| `src/services/streamValidator.js` | Fast health check + full validate / rank |
| `src/services/matchMerger.js` | Merge multi-source streams onto a match |
| `src/sources/registry.js` | Parser registry + build engine sources |
| `src/sources/httpStreamExtractor.js` | Shared Axios-first → Puppeteer extract |
| `src/sources/genericStreamingSource.js` | Config-driven discover + extract |
| `src/sources/fotmob.js` | Fixture source |
| `src/sources/luongson.js` / `xoilac.js` / `socolive.js` | Site-specific streaming parsers |
| `src/sources/highlight.js` / `myanmartv.js` | Highlight & channel scrapers |
| `src/browser/puppeteerManager.js` | Shared Chromium, max 2 pages, resource blocking |
| `src/admin/services/publishService.js` | Overrides + publish matches / MainLive |
| `src/admin/services/mainLiveService.js` | Admin-owned MainLive store |
| `src/admin/services/overrideService.js` | Persistent match/stream overrides |
| `src/monitor/` + `telegram.service.js` | Optional ops alerts |

---

## How to run

```bash
cp .env.example .env    # fill secrets
npm install
npm start               # or: pm2 start ecosystem.config.js

npm run scrape                     # matches
npm run scrape -- --highlights     # highlights only
npm run scrape -- --channels       # MyanmarTV only
npm run scrape -- --force          # force fixture refresh / stream check

pm2 restart football-streaming --update-env
pm2 logs football-streaming
```

Admin UI: `http://<host>:3000/admin`  
Health: `http://<host>:3000/api/health`

---

## Safety behaviour / architecture constraints

1. **GitHub is not a DB** — local `data/` is source of truth  
2. **Never upload empty JSON** over a previously populated feed on scrape failure  
3. **`mainlive.json` is admin-only** — scraper must not overwrite it  
4. **Status from FotMob kickoff + stream validity** — not from stream-site live badges; `LIVE` requires a valid stream  
5. **Stream search is kickoff-relative** (−30 / −15 / −5 / 0 / +5 / +10; hard stop +15) — not fixed wall-clock times  
6. **Fixtures: today + tomorrow only**, scraped **once per Yangon day** (unless `--force`)  
7. **1GB safety** — no overlapping heavy jobs; cap Puppeteer pages (default 2); do not share Chromium across heavy jobs; avoid boot `forceStreamCheck: true`  
8. **Per-source failures continue** — one source down must not abort the whole run  
9. **Preserve streams / `streamSearch`** across fixture refreshes via merge-from-previous  
10. **Flutter contract** — keep matches.json field shape stable; `streamSearch` stays optional  
11. **Compare-before-upload** (ignore volatile timestamps)  
12. **Timezone Asia/Yangon** for scheduling, kickoff math, and generated timestamps  
