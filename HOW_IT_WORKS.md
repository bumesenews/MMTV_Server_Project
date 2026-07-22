# Football Live Streaming Backend — Project Description

Production Node.js backend that collects football fixtures and live stream URLs, builds Flutter-ready JSON feeds, serves them over HTTP, and optionally publishes them to GitHub when content changes.

**Timezone:** Asia/Yangon everywhere (kickoff times, cron, date filters).

**Runtime target:** small AWS EC2 (e.g. t3.micro 1GB) with PM2, low-memory Chromium usage, and jobs that never overlap heavy work.

---

## 1. Purpose

Flutter (and other clients) need stable JSON endpoints for:

1. **Live matches** — which games are on today/tomorrow, status, and playable m3u8 links
2. **Soco feed** — a second live list scraped from the Soco site, grouped by league
3. **Highlights** — recent match highlight clips with embed/m3u8
4. **Myanmar TV** — local TV channel streams

This server is the scraper + publisher. It is **not** a full database. Local files under `data/` are the working store; GitHub is delivery/backup only.

---

## 2. What it produces (four feeds)

| Feed | Local path | HTTP | Shape (summary) |
|------|------------|------|-----------------|
| **matches** | `data/delivery/matches.json` | `/flutter/matches.json` | `{ matches: [...], meta }` — FotMob fixtures + merged streams |
| **soco** | `data/delivery/soco.json` | `/flutter/soco.json` | `{ leagues: [{ league_name, league_icon, matches }] }` |
| **highlight** | `data/delivery/highlight.json` | `/flutter/highlight.json` | `{ highlights: [...], count, scraped_at }` |
| **myanmartv** | `data/delivery/myanmartv.json` | `/flutter/myanmartv.json` | `[{ title, img, streamUrl }, ...]` |

Also kept: `data/current.json` (combined cache used by the pipeline and admin).

When GitHub is configured, the same four files are uploaded to the delivery repo **only if** content changed (empty overwrites are refused).

---

## 3. Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│  Express API + Admin UI  (src/index.js → app.js)             │
│  /flutter/*.json  /api/*  /admin                            │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│  Scheduler (cron, Asia/Yangon)                              │
│                                                             │
│  Main pipeline     → matches + soco                         │
│  Highlight job 3h  → highlight.json                         │
│  MyanmarTV job 12h → myanmartv.json                         │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│  Pipeline / dedicated jobs                                  │
│  ConfigLoader → sources → merge → status → cache → GitHub   │
└────────────────────────────┬────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
   FotMob API          Stream sites            Soco / Hoofoot /
   (fixtures)          (Puppeteer m3u8)        MyanmarTV (HTTP)
```

### Important directories

| Path | Role |
|------|------|
| `src/sources/` | Per-website scrapers |
| `src/services/` | Pipeline, status, streams, cache, GitHub, scheduler |
| `src/admin/` | Admin auth, overrides, league/source toggles, publish |
| `src/browser/` | Shared Puppeteer/Chromium manager |
| `config/` | Local fallback for sources / leagues / teams |
| `data/` | Runtime JSON (`current.json`, `delivery/`, admin store) |
| `public/admin/` | Admin web UI |
| `secrets/` | Firebase service account (not committed) |

---

## 4. Scheduled jobs

```
Main pipeline tick (PIPELINE_CRON, e.g. */5 * * * *)
└── matches.json + soco.json

Highlight Job (HIGHLIGHT_CRON = 0 */3 * * *)   ← every 3 hours
└── Highlights → highlight.json

MyanmarTV Job (MYANMARTV_CRON = 0 */12 * * *)  ← every 12 hours
└── Channels → myanmartv.json
```

Jobs skip if another heavy job is already running (avoids OOM on 1GB hosts).

On boot (`npm start`): pipeline → then highlights → then MyanmarTV, each delayed so they do not overlap.

---

## 5. Feed rules in detail

### 5.1 `matches.json` (main live feed)

**Fixtures (FotMob)**

- Source of truth for *which* matches exist and *when* they kick off
- Only **today and tomorrow** (Yangon)
- Scraped **once per Yangon calendar day** (in-memory cache)
- Forced refresh: `npm run scrape -- --force`
- League filter via `config/leagues.json` (+ admin league toggles)

**Status — from fixture kickoff time, not streaming sites**

Streaming sites change domains often, so status must not depend on them.

| Time vs kickoff | Status | Streams |
|-----------------|--------|---------|
| Before kickoff | `Scheduled` | May be empty |
| Kickoff → +120 minutes | `LIVE` | Kept if found |
| After +120 minutes | `END` | **Cleared** |

**Stream URL discovery**

- First attempt at **T−30 minutes** (e.g. 05:00 for 05:30 kickoff)
- Retry at **T−15 minutes** if still missing
- During LIVE, can still find if missing
- After +120m: stop and remove URLs

**Stream sources (Puppeteer)** — e.g. LuongSon, Socolive, Xoilac, Cakhia, …
Configured in `config/sources.json` (`type: "streaming"`). Domain, selectors, attrs, mirrors are editable without code changes. The stream engine walks **all** enabled sources and merges URLs onto the same match.

**Soco merge:** if Soco finds the same `matchId`, its m3u8 links can be merged into `matches.json` as an extra source.

### 5.2 `soco.json` (separate Soco feed)

Independent of FotMob status rules.

- Scrapes Soco **today + tomorrow** section APIs (HTTP + Cheerio)
- **Status from the Soco website** (`data-status` codes, live class, score/period text)
- **Streaming URL fetched only when website status is `LIVE`**
- Scheduled / END → empty `links`
- Optional `leagueFilter` (UEFA CL, FIF, AFF Cup, KOR D1, BRA D1, …)
- Team logos from card HTML or `data-home-team-id` / `data-away-team-id`
- Domain / paths / selectors / attrs fully config-driven

Output shape for Flutter:

```json
{
  "leagues": [
    {
      "league_name": "...",
      "league_icon": "...",
      "matches": [
        {
          "home_team": { "name": "...", "logo": "..." },
          "away_team": { "name": "...", "logo": "..." },
          "month": "7/23/2026",
          "time": "5:30:00 AM",
          "links": [{ "name": "HD 1", "url": "https://...m3u8", "reffer": "..." }]
        }
      ]
    }
  ]
}
```

### 5.3 `highlight.json`

- Source: Hoofoot (Puppeteer)
- Dedicated job every **3 hours**
- Merge + dedupe + retention (default ~7 days)
- GitHub upload only when changed; never overwrite with empty on failure

### 5.4 `myanmartv.json`

- Source: myanmartvchannels.com (HTTP)
- Dedicated job every **12 hours**
- Main pipeline only **reuses** the last successful channel list (no scrape every tick)
- GitHub upload only when changed

---

## 6. Configuration

### Local / remote config

1. Prefer remote config from GitHub (`GITHUB_*` + config path)
2. Fall back to `./config` if GitHub is unavailable

| File | Purpose |
|------|---------|
| `config/sources.json` | Enable sources; domains; mirrors; paths; selectors; attrs; priorities |
| `config/leagues.json` | Allowed leagues + name aliases (normalize Vietnamese/English names) |
| `config/teams.json` | Team name aliases for stable `matchId` matching |

When a streaming site moves, update **domain / href / attr / selectors** in `sources.json` (admin can edit this too). Do not hardcode domains in scrapers beyond safe fallbacks.

### Environment (see `.env.example`)

| Area | Examples |
|------|----------|
| Server | `HOST`, `PORT`, `TZ=Asia/Yangon`, `LOW_MEMORY_MODE` |
| Cron | `PIPELINE_CRON`, `HIGHLIGHT_CRON`, `MYANMARTV_CRON` |
| GitHub delivery | `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH`, path vars |
| API | `API_KEY`, `ENABLE_PUBLIC_JSON` |
| Admin | `ADMIN_JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` |
| Browser | `PUPPETEER_EXECUTABLE_PATH`, timeouts, resource blocking |
| Concurrency | `SOCO_CONCURRENCY`, `MYANMARTV_CONCURRENCY` |

---

## 7. Core modules (who does what)

| Module | Responsibility |
|--------|----------------|
| `src/index.js` | Boot API, admin, scheduler, initial jobs |
| `src/app.js` | Express routes, Flutter JSON aliases, API key gate |
| `src/services/pipeline.js` | Main run + `runHighlights` + `runMyanmarTv` |
| `src/services/scheduler.js` | Three cron jobs |
| `src/services/fixtureService.js` / `fotmob.js` | Today/tomorrow fixtures |
| `src/services/streamEngine.js` | When to deep-extract streams (−30 / −15 / LIVE) |
| `src/services/statusService.js` | matches.json Scheduled / LIVE / END from kickoff |
| `src/services/matchMerger.js` | Merge multi-source streams onto one match |
| `src/services/deliveryFormats.js` | Flutter JSON shapes |
| `src/services/cacheService.js` | Local delivery + previous-data safety |
| `src/services/githubService.js` | Upload if changed |
| `src/services/configLoader.js` | GitHub or local config |
| `src/sources/soco.js` | Soco discover + LIVE-only stream extract |
| `src/sources/*` | Site-specific scrapers |
| `src/utils/normalize.js` | League/team alias folding |
| `src/utils/time.js` | Yangon time, fixture status helpers, stream windows |
| `src/admin/*` | Login, dashboard, overrides, league/source toggles, FCM notify |

---

## 8. HTTP API (summary)

| Endpoint | Role |
|----------|------|
| `GET /flutter/matches.json` | Main feed |
| `GET /flutter/soco.json` | Soco leagues feed |
| `GET /flutter/highlight.json` | Highlights |
| `GET /flutter/myanmartv.json` | Channels |
| `GET /api/health` | Process + last run flags |
| `GET /api/matches` | Cached combined payload |
| `POST /api/pipeline/run` | Trigger main pipeline |
| `POST /api/pipeline/highlights` | Trigger highlight job |
| `POST /api/pipeline/channels` | Trigger MyanmarTV job |
| `POST /api/admin/auth/login` | Admin JWT |
| `/admin` | Admin UI |

Public Flutter GETs can be opened without API key when `ENABLE_PUBLIC_JSON=true`.

---

## 9. Admin panel

- URL: `http://<host>:3000/admin`
- Seed user: `npm run admin:seed`
- Typical controls: enable/disable sources & leagues, edit source config (domains/selectors), manual stream overrides, view logs/dashboard, publish/notify

Overrides can pin/featured matches or inject manual stream URLs without waiting for scrapers.

---

## 10. How to run

```bash
cp .env.example .env    # fill secrets
npm install
npm start               # API + all crons

# One-shot jobs
npm run scrape                     # matches + soco
npm run scrape -- --highlights     # highlights only
npm run scrape -- --channels       # MyanmarTV only
npm run scrape -- --force          # force fixture refresh + stream checks

# Process manager
npm run pm2:start
npm run pm2:logs
npm run pm2:restart
```

Requires **Node.js ≥ 18** and a system Chrome/Chromium path for Puppeteer-core.

---

## 11. Safety / production behaviour

- Never upload **empty** JSON when a scrape fails — keep previous valid data
- Skip overlapping pipeline / highlight / MyanmarTV runs
- Do not share Chromium between pipeline and highlight on small hosts
- Per-source failures are logged; other sources continue
- Compare payloads before GitHub upload (ignore volatile timestamps)
- Low-memory mode caps heap and shortens force-extract windows

---

## 12. Mental model (short)

1. **FotMob** → which matches exist today/tomorrow and exact kickoff.
2. **Stream sites** → m3u8 links near kickoff (−30m / −15m), for `matches.json`.
3. **matches.json status** → from kickoff clock (LIVE for 120 minutes, then END + drop streams).
4. **Soco** → own website status; fetch stream URL only when site says LIVE.
5. **Highlights every 3h**, **Myanmar TV every 12h** — separate from the live match tick.
6. Flutter reads the four JSON files from this server or GitHub raw URLs.

---

## 13. Related docs / files

- This file: full project description
- `.env.example`: all environment variables
- `config/sources.json`: live scraper configuration
- `ecosystem.config.js`: PM2 process settings
