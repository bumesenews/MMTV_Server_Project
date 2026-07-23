# How this project works

Football live streaming backend for Flutter. It scrapes fixtures and stream URLs, builds four JSON feeds, serves them over HTTP, and optionally uploads to GitHub when data changes.

**Timezone:** Asia/Yangon  
**Production target:** AWS EC2 `t3.micro` (1GB RAM) + PM2 + 1GB swap  

---

## What it produces

| Feed | File | URL |
|------|------|-----|
| Main live matches | `data/delivery/matches.json` | `/flutter/matches.json` |
| Soco leagues feed | `data/delivery/soco.json` | `/flutter/soco.json` |
| Highlights | `data/delivery/highlight.json` | `/flutter/highlight.json` |
| Myanmar TV | `data/delivery/myanmartv.json` | `/flutter/myanmartv.json` |

GitHub is **delivery/backup only** (upload when content changes). It is not the database. Local `data/` is the working store.

---

## Job schedule

```
Main pipeline (PIPELINE_CRON = */15 * * * *)
└── matches.json + soco.json

Highlight Job (HIGHLIGHT_CRON = 0 */6 * * *)   ← every 6 hours
└── Highlights → highlight.json

MyanmarTV Job (MYANMARTV_CRON = 0 */12 * * *)  ← every 12 hours
└── Channels → myanmartv.json
```

Jobs skip if another heavy job is already running (avoids OOM).

**Boot sequence** (one at a time): wait 10s → pipeline (`forceStreamCheck: false`) → wait 15s → highlights → wait 15s → MyanmarTV.

---

## Config: GitHub first, local fallback

When `GITHUB_TOKEN` + `GITHUB_OWNER` + `GITHUB_REPO` are set, the server loads:

- `config/sources.json`
- `config/leagues.json`
- `config/teams.json`

from GitHub (`GITHUB_CONFIG_PATH`, default `config/`).

If GitHub fails or is not configured → uses local `./config/`.

**`soco` and `socolive` are different sources.** Changing one domain does not change the other.

Edit GitHub config via:

1. Admin → **Remote Config** → Save  
2. Or edit `config/sources.json` on GitHub directly  

---

## `matches.json` rules

Fixtures come from **FotMob** (today + tomorrow only, scraped **once per Yangon day**).

**Status from fixture kickoff time** (not streaming websites):

| Time vs kickoff | Status | Streams |
|-----------------|--------|---------|
| Before kickoff | `Scheduled` | May be empty |
| Kickoff → +120 min | `LIVE` | Kept if found |
| After +120 min | `END` | Removed |

**Stream find windows:**

- First try at **T−30 min** (e.g. 05:00 for 05:30 kickoff)  
- Retry at **T−15 min** if still missing  
- During LIVE, can still find if missing  

Stream sites (LuongSon, Socolive, Xoilac, …) are Puppeteer-based. Domains/selectors live in `sources.json`.

---

## `soco.json` rules

Independent of FotMob.

- Scrapes Soco **today + tomorrow** (HTTP + Cheerio)  
- **Status from the Soco website** (`data-status` / live class / score text)  
- **Streaming URL only when website status is `LIVE`**  
- Optional `leagueFilter` (UEFA CL, FIF, AFF Cup, KOR D1, BRA D1, …)  
- On 1GB hosts: `SOCO_CONCURRENCY=1`, `scrapeFull({ fetchStreams: false })` by default (set `true` when you need m3u8)  
- Domain / paths / selectors / attrs are config-driven  

---

## Low-memory production (1GB)

| Setting | Value |
|---------|--------|
| `LOW_MEMORY_MODE` | `true` |
| Node heap | `--max-old-space-size=256 --expose-gc` |
| PM2 `max_memory_restart` | `350M` |
| Pipeline cron | every **15 min** |
| Highlights | every **6 hours** |
| MyanmarTV | every **12 hours** |
| Concurrency | `SOCO` / `MYANMARTV` / retries = **1** |
| `HIGHLIGHT_LIMIT` | `8` |
| Puppeteer timeout | `25000` ms |
| Browser restart | every **5** pages |
| `PUPPETEER_HEADLESS` | `new` |
| Chromium | `--single-process`, `--disable-dev-shm-usage`, js heap 128MB, image blocking, etc. |

Also recommended on Ubuntu EC2: **1GB swap** + `vm.swappiness=10`.

See `.env.example` and `ecosystem.config.js` for the full tuned values.

---

## Main modules

| Path | Role |
|------|------|
| `src/index.js` | Boot API, admin, scheduler, staggered initial jobs |
| `src/services/pipeline.js` | Main run + `runHighlights` + `runMyanmarTv` |
| `src/services/scheduler.js` | Three cron jobs |
| `src/services/streamEngine.js` | When to deep-extract streams |
| `src/services/statusService.js` | matches.json Scheduled / LIVE / END |
| `src/services/configLoader.js` | GitHub or local config |
| `src/services/githubService.js` | Upload feeds if changed |
| `src/sources/fotmob.js` | Fixtures only |
| `src/sources/soco.js` | Soco HTTP scraper |
| `src/sources/socolive.js` / `luongson.js` / … | Puppeteer stream sites |
| `src/browser/puppeteerManager.js` | Shared Chromium (low-RAM args) |
| `src/admin/` | Login, overrides, remote config editor |

---

## How to run

```bash
cp .env.example .env    # fill secrets
npm install
npm start               # or: pm2 start ecosystem.config.js

npm run scrape                     # matches + soco
npm run scrape -- --highlights     # highlights only
npm run scrape -- --channels       # MyanmarTV only
npm run scrape -- --force          # force fixture refresh

pm2 restart football-streaming --update-env
pm2 logs football-streaming
```

Admin UI: `http://<host>:3000/admin`  
Health: `http://<host>:3000/api/health`

---

## Safety behaviour

- Never upload empty JSON on scrape failure — keep previous data  
- Skip overlapping pipeline / highlight / MyanmarTV runs  
- Do not share Chromium between heavy jobs on 1GB hosts  
- Per-source failures are logged; other sources continue  
- Compare payloads before GitHub upload (ignore volatile timestamps)  

---

## Mental model

1. **FotMob** → which matches exist today/tomorrow and kickoff time.  
2. **Stream sites** → m3u8 near kickoff (−30m / −15m) for `matches.json`.  
3. **matches.json status** → from kickoff clock (LIVE 120 min, then END).  
4. **Soco** → own website status; stream URL only when site says LIVE.  
5. **Highlights every 6h**, **Myanmar TV every 12h** — separate from live tick.  
6. Flutter reads the four JSON files from this server or GitHub raw URLs.  
