(() => {
  const API = '/api/admin';
  const state = {
    token: localStorage.getItem('adminToken') || '',
    user: null,
    page: 'dashboard',
    matches: [],
    sourcesConfig: null,
  };

  const $ = (sel) => document.querySelector(sel);
  const pageEl = $('#page');

  async function api(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const res = await fetch(`${API}${path}`, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      logout(false);
      throw new Error(data.error || 'Unauthorized');
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || data.reason || `Request failed (${res.status})`);
    }
    return data;
  }

  function toast(message, type = 'ok') {
    const el = $('#toast');
    el.textContent = message;
    el.className = `toast ${type}`;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  /** datetime-local value → { date, time } as Asia/Yangon wall clock (do not use Date/UTC). */
  function yangonDateTimeLocalParts(value) {
    const raw = String(value || '').trim();
    const m = raw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?/);
    if (!m) return null;
    return { date: m[1], time: m[2] };
  }

  function parseClockTo12(timeStr) {
    const raw = String(timeStr || '').trim();
    const withPeriod = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])$/);
    if (withPeriod) {
      let hour = Number(withPeriod[1]);
      const period = withPeriod[3].toUpperCase();
      if (hour === 0) hour = 12;
      if (hour > 12) hour -= 12;
      return { hour, minute: withPeriod[2].padStart(2, '0'), period };
    }
    const hhmm = raw.match(/^(\d{1,2}):(\d{2})/);
    if (!hhmm) return { hour: 7, minute: '00', period: 'PM' };
    const hour24 = Number(hhmm[1]);
    const minute = hhmm[2].padStart(2, '0');
    const period = hour24 >= 12 ? 'PM' : 'AM';
    const hour = hour24 % 12 === 0 ? 12 : hour24 % 12;
    return { hour, minute, period };
  }

  function formatClock12(timeStr) {
    const p = parseClockTo12(timeStr);
    return `${p.hour}:${p.minute} ${p.period}`;
  }

  function clock12SelectsHtml(prefix, timeStr, extra = '') {
    const p = parseClockTo12(timeStr);
    const hours = Array.from({ length: 12 }, (_, i) => i + 1);
    const minutes = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));
    return `
      <label>Hour
        <select name="${prefix}Hour" ${extra} required>
          ${hours.map((h) => `<option value="${h}" ${h === p.hour ? 'selected' : ''}>${h}</option>`).join('')}
        </select>
      </label>
      <label>Minute
        <select name="${prefix}Minute" ${extra} required>
          ${minutes.map((m) => `<option value="${m}" ${m === p.minute ? 'selected' : ''}>${m}</option>`).join('')}
        </select>
      </label>
      <label>AM / PM
        <select name="${prefix}Period" ${extra} required>
          <option value="AM" ${p.period === 'AM' ? 'selected' : ''}>AM</option>
          <option value="PM" ${p.period === 'PM' ? 'selected' : ''}>PM</option>
        </select>
      </label>
    `;
  }

  function time12FromFields(hour, minute, period) {
    const h = String(hour || '').trim();
    const m = String(minute || '00').padStart(2, '0');
    const p = String(period || '').trim().toUpperCase();
    if (!h || (p !== 'AM' && p !== 'PM')) return '';
    return `${h}:${m} ${p}`;
  }

  function logout(clear = true) {
    if (clear) localStorage.removeItem('adminToken');
    state.token = '';
    state.user = null;
    $('#app-view').classList.add('hidden');
    $('#login-view').classList.remove('hidden');
  }

  function showApp() {
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    $('#whoami').textContent = `${state.user.displayName || state.user.username} · ${state.user.role}`;
  }

  async function boot() {
    $('#login-form').addEventListener('submit', onLogin);
    $('#btn-logout').addEventListener('click', () => logout(true));
    $('#btn-refresh').addEventListener('click', () => renderPage(true));
    $('#btn-run-pipeline').addEventListener('click', runPipeline);
    $('#btn-restore-matches')?.addEventListener('click', restoreMatchesFromGithub);
    $('#btn-menu').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
    $('#nav').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-page]');
      if (!btn) return;
      state.page = btn.dataset.page;
      [...$('#nav').querySelectorAll('button')].forEach((b) => b.classList.toggle('active', b === btn));
      $('.sidebar').classList.remove('open');
      renderPage();
    });

    if (!state.token) return;
    try {
      const me = await api('/auth/me');
      state.user = me.user;
      showApp();
      renderPage();
    } catch {
      logout(true);
    }
  }

  async function onLogin(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    $('#login-error').textContent = '';
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username: fd.get('username'),
          password: fd.get('password'),
        }),
      });
      state.token = data.token;
      state.user = data.user;
      localStorage.setItem('adminToken', data.token);
      showApp();
      renderPage();
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  }

  async function restoreMatchesFromGithub() {
    const btn = $('#btn-restore-matches');
    try {
      if (btn) btn.disabled = true;
      toast('Restoring matches.json from GitHub…');
      const result = await api('/matches/restore-from-github', { method: 'POST', body: '{}' });
      toast(`Restored ${result.restored || result.matchCount || 0} matches from GitHub`);
      renderPage(true);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function runPipeline() {
    const btn = $('#btn-run-pipeline');
    try {
      if (btn) btn.disabled = true;
      toast('Scraper started… wait (can take several minutes)');
      const result = await api('/pipeline/run', {
        method: 'POST',
        body: JSON.stringify({ force: true }),
      });
      const h = result.payload?.highlightCount ?? result.payload?.highlights?.length ?? 0;
      const c = result.payload?.channelCount ?? result.payload?.channels?.length ?? 0;
      toast(
        `Scraper OK · ${result.payload?.matches?.length || 0} matches · ${h} highlights · ${c} channels`
      );
      renderPage(true);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function setTitle(title) {
    $('#page-title').textContent = title;
  }

  async function renderPage(force) {
    const map = {
      dashboard: renderDashboard,
      mainlive: renderMainLive,
      matches: renderMatches,
      streams: renderStreams,
      feeds: renderFeeds,
      leagues: renderLeagues,
      teams: renderTeams,
      sources: renderSources,
      config: renderConfig,
      appversion: renderAppVersion,
      notifications: renderNotifications,
      logs: renderLogs,
      users: renderUsers,
    };
    const fn = map[state.page] || renderDashboard;
    try {
      await fn(force);
    } catch (err) {
      pageEl.innerHTML = `<div class="panel error">${esc(err.message)}</div>`;
    }
  }

  async function renderDashboard() {
    setTitle('Dashboard');
    const { dashboard: d } = await api('/dashboard');
    pageEl.innerHTML = `
      <div class="cards">
        ${card('Total Matches', d.totalMatches)}
        ${card('Live', d.liveMatches)}
        ${card('Total Streams', d.totalStreams)}
        ${card('Manual Streams', d.manualStreams)}
        ${card('Active Sources', d.activeSources)}
        ${card('Failed Sources', d.failedSources)}
      </div>
      <div class="grid-2">
        <div class="panel">
          <h3>AWS Server</h3>
          <p>Status: <span class="ok">Online</span></p>
          <p class="muted">Uptime: ${d.awsServerStatus.uptimeSec}s · RSS ${d.awsServerStatus.memoryMb} MB · ${d.awsServerStatus.node}</p>
          <p class="muted">Timezone: ${d.awsServerStatus.timezone}</p>
        </div>
        <div class="panel">
          <h3>Last Scraper Run</h3>
          <pre class="muted" style="white-space:pre-wrap;margin:0">${esc(JSON.stringify(d.lastScraperRun || {}, null, 2))}</pre>
          <h3 style="margin-top:1rem">Last GitHub Upload</h3>
          <pre class="muted" style="white-space:pre-wrap;margin:0">${esc(JSON.stringify(d.lastGithubUpload || {}, null, 2))}</pre>
        </div>
      </div>
      <div class="panel">
        <h3>Sources</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Source</th><th>Enabled</th><th>Last Success</th><th>Last Error</th><th>Streams</th></tr></thead>
            <tbody>
              ${(d.sources || []).map((s) => `
                <tr>
                  <td>${esc(s.name)}</td>
                  <td>${s.enabled ? 'Yes' : 'No'}</td>
                  <td class="muted">${esc(s.lastSuccessAt || '—')}</td>
                  <td class="muted">${esc(s.lastError || '—')}</td>
                  <td>${s.totalStreamsCollected || 0}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  async function renderMainLive() {
    setTitle('MainLive (mainlive.json)');
    const [matchData, leagueData, teamData] = await Promise.all([
      api('/mainlive'),
      api('/leagues'),
      api('/teams'),
    ]);
    state.mainlive = matchData.matches || [];
    const leagues = (leagueData.leagues || []).filter((l) => l.enabled !== false);
    const teams = (teamData.teams || []).filter((t) => t.enabled !== false);
    const leagueOpts = leagues
      .map((l) => `<option value="${esc(l.standardName)}" data-icon="${esc(l.iconUrl || '')}"></option>`)
      .join('');
    const teamOpts = teams
      .map((t) => `<option value="${esc(t.standardName)}" data-logo="${esc(t.logo || '')}">${esc(t.standardName)}</option>`)
      .join('');
    const leagueIconByName = Object.fromEntries(
      leagues.map((l) => [String(l.standardName || '').toLowerCase(), l.iconUrl || ''])
    );

    pageEl.innerHTML = `
      <div class="panel">
        <p class="muted">Admin-only feed published to <code>mainlive.json</code> on GitHub. Separate from scraped <code>matches.json</code>.</p>
        <p class="muted"><strong>Kickoff date/time = Asia/Yangon wall clock</strong> (not UTC, not your browser timezone). Pick hour + <strong>AM or PM</strong>. Example: <code>7:30 PM</code> → <code>19:30 +06:30</code>.</p>
        <h3>Add MainLive Match</h3>
        <form id="mainlive-create-form" class="grid-2">
          <label>League
            <input name="league" list="mainlive-league-list" required placeholder="Type any league name" autocomplete="off" />
            <datalist id="mainlive-league-list">${leagueOpts}</datalist>
          </label>
          <label>League logo URL<input name="leagueIcon" placeholder="https://.../league.png" /></label>
          <label>Home team name
            <input name="homeTeam" list="mainlive-team-list" required placeholder="Home team" />
          </label>
          <label>Home team logo URL<input name="homeLogo" placeholder="https://.../home.png" /></label>
          <label>Away team name
            <input name="awayTeam" list="mainlive-team-list" required placeholder="Away team" />
          </label>
          <label>Away team logo URL<input name="awayLogo" placeholder="https://.../away.png" /></label>
          <datalist id="mainlive-team-list">${teamOpts}</datalist>
          <label>Date (Asia/Yangon)<input name="date" type="date" required /></label>
          ${clock12SelectsHtml('time', '7:00 PM')}
          <label>Status
            <select name="status">
              <option>Scheduled</option>
              <option>LIVE</option>
              <option>END</option>
            </select>
          </label>
          <label>Match page source
            <select name="matchUrlSource">
              <option value="">Auto</option>
              <option value="cakhia">cakhia</option>
              <option value="xoilac">xoilac</option>
              <option value="socolive">socolive</option>
              <option value="mitomtm">mitomtm</option>
            </select>
          </label>
          <label style="grid-column:1/-1">Match page URL (auto-find m3u8)
            <input name="matchUrl" type="url" placeholder="https://…/truc-tiep/…" />
          </label>
          <div style="grid-column:1/-1">
            <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
              <strong>Stream URLs</strong>
              <button type="button" class="secondary" id="mainlive-add-stream">+ Add stream</button>
            </div>
            <p class="muted" style="margin:0 0 8px">Paste a streaming site match page above — the server finds the m3u8 and uploads <code>mainlive.json</code>. You can still add m3u8s by hand below.</p>
            <div id="mainlive-streams"></div>
          </div>
          <div style="grid-column:1/-1"><button type="submit">Create MainLive Match</button></div>
        </form>
      </div>
      <div class="panel">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Match</th><th>League</th><th>Kickoff</th><th>Status</th><th>Streams</th><th>Flags</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${state.mainlive.map((m) => `
                <tr data-id="${esc(m.matchId)}">
                  <td>
                    <strong>${esc(m.homeTeam)} vs ${esc(m.awayTeam)}</strong>
                    <div class="muted" style="font-size:0.75rem">${esc(m.matchId)}</div>
                  </td>
                  <td>${esc(m.league || '')}${m.leagueIcon ? `<div><img src="${esc(m.leagueIcon)}" alt="" style="height:18px;margin-top:4px" /></div>` : ''}</td>
                  <td>${esc(m.date || '')} ${esc(formatClock12(m.time || m.kickoff))} <span class="muted" style="font-size:0.7rem">Yangon</span></td>
                  <td><span class="badge ${m.status === 'LIVE' ? 'live' : ''}">${esc(m.status || '')}</span></td>
                  <td>${(m.streams || []).length}${m.matchUrlStatus ? ` · ${esc(m.matchUrlStatus)}` : ''}</td>
                  <td>
                    ${m.pinned ? '<span class="badge">PIN</span>' : ''}
                    ${m.featured ? '<span class="badge">FEAT</span>' : ''}
                  </td>
                  <td>
                    <div class="row">
                      <button class="secondary" data-act="toggle" data-field="pinned">${m.pinned ? 'Unpin' : 'Pin'}</button>
                      <button class="secondary" data-act="toggle" data-field="featured">${m.featured ? 'Unfeature' : 'Feature'}</button>
                      <button class="secondary" data-act="streams">Streams</button>
                      <select data-act="status">
                        ${['Scheduled', 'LIVE', 'END', 'PREPARING_STREAM'].map((s) => `<option ${m.status === s ? 'selected' : ''}>${s}</option>`).join('')}
                      </select>
                      <input data-act="kickoff-date" type="date" value="${esc(m.date || '')}" title="Asia/Yangon date" />
                      <select data-act="kickoff-hour" title="Hour">
                        ${Array.from({ length: 12 }, (_, i) => i + 1).map((h) => {
                          const cur = parseClockTo12(m.time || m.kickoff);
                          return `<option value="${h}" ${h === cur.hour ? 'selected' : ''}>${h}</option>`;
                        }).join('')}
                      </select>
                      <select data-act="kickoff-minute" title="Minute">
                        ${Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0')).map((min) => {
                          const cur = parseClockTo12(m.time || m.kickoff);
                          return `<option value="${min}" ${min === cur.minute ? 'selected' : ''}>${min}</option>`;
                        }).join('')}
                      </select>
                      <select data-act="kickoff-period" title="AM or PM">
                        ${['AM', 'PM'].map((p) => {
                          const cur = parseClockTo12(m.time || m.kickoff);
                          return `<option value="${p}" ${p === cur.period ? 'selected' : ''}>${p}</option>`;
                        }).join('')}
                      </select>
                      <button class="secondary" data-act="save-kickoff" title="Saved as Asia/Yangon">Set Time (Yangon)</button>
                      <button class="danger" data-act="delete">Delete</button>
                    </div>
                  </td>
                </tr>`).join('') || '<tr><td colspan="7" class="muted">No MainLive matches yet. Add one above.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>`;

    const form = $('#mainlive-create-form');
    const streamsBox = $('#mainlive-streams');
    const defaultQualities = ['HD', 'SD', 'Full HD'];
    const addStreamRow = (name = 'HD', url = '', headers = {}) => {
      const row = document.createElement('div');
      row.className = 'mainlive-stream-row';
      row.style.cssText =
        'border:1px solid var(--border, #333);border-radius:8px;padding:10px;margin-bottom:10px';
      const ua = headers['User-Agent'] || headers.userAgent || '';
      const referer = headers.Referer || headers.referer || '';
      const cookie = headers.Cookie || headers.cookie || '';
      row.innerHTML = `
        <div class="row" style="gap:8px;align-items:flex-end;flex-wrap:wrap">
          <label style="flex:0 0 120px">Name
            <input name="streamName[]" value="${esc(name)}" placeholder="HD / SD" list="mainlive-quality-list" />
          </label>
          <label style="flex:1;min-width:220px">m3u8 URL
            <input name="streamUrl[]" value="${esc(url)}" placeholder="https://.../index.m3u8" />
          </label>
          <button type="button" class="danger" data-remove-stream>Remove</button>
        </div>
        <div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">
          <label style="flex:1;min-width:180px">User-Agent
            <input name="streamUa[]" value="${esc(ua)}" placeholder="Mozilla/5.0 ..." />
          </label>
          <label style="flex:1;min-width:180px">Referer
            <input name="streamReferer[]" value="${esc(referer)}" placeholder="https://source.example/" />
          </label>
          <label style="flex:1;min-width:180px">Cookie (optional)
            <input name="streamCookie[]" value="${esc(cookie)}" placeholder="optional" />
          </label>
        </div>
      `;
      row.querySelector('[data-remove-stream]').addEventListener('click', () => {
        row.remove();
      });
      streamsBox.appendChild(row);
    };
    if (!$('#mainlive-quality-list')) {
      const dl = document.createElement('datalist');
      dl.id = 'mainlive-quality-list';
      dl.innerHTML = defaultQualities.map((q) => `<option value="${q}"></option>`).join('');
      document.body.appendChild(dl);
    }
    addStreamRow('HD');
    $('#mainlive-add-stream').addEventListener('click', () => addStreamRow('SD'));

    const fillLeagueIcon = () => {
      const name = String(form.league.value || '').trim().toLowerCase();
      const icon = leagueIconByName[name];
      if (icon) form.leagueIcon.value = icon;
    };
    form.league.addEventListener('change', fillLeagueIcon);
    form.league.addEventListener('blur', fillLeagueIcon);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const names = fd.getAll('streamName[]');
      const urls = fd.getAll('streamUrl[]');
      const uas = fd.getAll('streamUa[]');
      const referers = fd.getAll('streamReferer[]');
      const cookies = fd.getAll('streamCookie[]');
      const streams = [];
      for (let i = 0; i < Math.max(names.length, urls.length); i += 1) {
        const url = String(urls[i] || '').trim();
        if (!url) continue;
        const headers = {
          'User-Agent': String(uas[i] || '').trim(),
          Referer: String(referers[i] || '').trim(),
        };
        const cookie = String(cookies[i] || '').trim();
        if (cookie) headers.Cookie = cookie;
        streams.push({
          name: String(names[i] || 'HD').trim() || 'HD',
          url,
          headers,
        });
      }
      try {
        const created = await api('/mainlive', {
          method: 'POST',
          body: JSON.stringify({
            league: fd.get('league'),
            leagueIcon: fd.get('leagueIcon'),
            homeTeam: fd.get('homeTeam'),
            awayTeam: fd.get('awayTeam'),
            homeLogo: fd.get('homeLogo'),
            awayLogo: fd.get('awayLogo'),
            date: fd.get('date'),
            time: time12FromFields(fd.get('timeHour'), fd.get('timeMinute'), fd.get('timePeriod')),
            status: fd.get('status'),
            matchUrl: String(fd.get('matchUrl') || '').trim() || undefined,
            matchUrlSource: String(fd.get('matchUrlSource') || '').trim() || undefined,
            streams,
          }),
        });
        const t = formatClock12(
          created?.match?.time ||
            time12FromFields(fd.get('timeHour'), fd.get('timeMinute'), fd.get('timePeriod'))
        );
        const extractNote = created?.extraction?.queued
          ? ' · m3u8 search queued'
          : created?.extraction?.ok
            ? ' · m3u8 found'
            : created?.match?.matchUrl
              ? ` · extract ${created.match.matchUrlStatus || 'done'}`
              : '';
        toast(`MainLive created · kickoff ${t} Asia/Yangon · ${streams.length} stream(s)${extractNote}`);
        renderMainLive();
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    pageEl.querySelectorAll('tr[data-id]').forEach((tr) => {
      const id = tr.dataset.id;
      tr.querySelectorAll('[data-act="toggle"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const field = btn.dataset.field;
          const m = state.mainlive.find((x) => x.matchId === id);
          try {
            await api(`/mainlive/${encodeURIComponent(id)}`, {
              method: 'PATCH',
              body: JSON.stringify({ [field]: !Boolean(m[field]) }),
            });
            toast(`Updated ${field}`);
            renderMainLive();
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      });
      tr.querySelector('[data-act="streams"]')?.addEventListener('click', async () => {
        await manageMainLiveStreams(id);
      });
      tr.querySelector('[data-act="status"]')?.addEventListener('change', async (e) => {
        try {
          await api(`/mainlive/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: e.target.value }),
          });
          toast('Status updated');
          renderMainLive();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      tr.querySelector('[data-act="save-kickoff"]')?.addEventListener('click', async () => {
        const date = tr.querySelector('[data-act="kickoff-date"]')?.value;
        const time = time12FromFields(
          tr.querySelector('[data-act="kickoff-hour"]')?.value,
          tr.querySelector('[data-act="kickoff-minute"]')?.value,
          tr.querySelector('[data-act="kickoff-period"]')?.value
        );
        if (!date || !time) return toast('Pick date, time, and AM/PM', 'error');
        try {
          await api(`/mainlive/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ date, time }),
          });
          toast('Kickoff updated (Asia/Yangon)');
          renderMainLive();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      tr.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
        if (!confirm('Delete this MainLive match from mainlive.json?')) return;
        try {
          await api(`/mainlive/${encodeURIComponent(id)}`, { method: 'DELETE' });
          toast('MainLive match deleted');
          renderMainLive();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  }

  async function manageMainLiveStreams(matchId) {
    const m = state.mainlive.find((x) => x.matchId === matchId);
    if (!m) return;
    let streams = (m.streams || []).map((s) => ({
      id: s.id,
      name: s.name || s.quality || 'HD',
      url: s.url || '',
      headers: {
        'User-Agent': s.headers?.['User-Agent'] || '',
        Referer: s.headers?.Referer || '',
        ...(s.headers?.Cookie ? { Cookie: s.headers.Cookie } : {}),
      },
      active: s.active !== false,
      type: s.type || 'm3u8',
    }));
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:50;display:flex;align-items:center;justify-content:center;padding:16px';
    const card = document.createElement('div');
    card.className = 'panel';
    card.style.cssText = 'width:min(720px,100%);max-height:90vh;overflow:auto';

    const syncFromDom = () => {
      const rows = [...card.querySelectorAll('#ml-stream-list [data-i]')];
      streams = rows.map((row) => {
        const i = Number(row.dataset.i);
        const prev = streams[i] || {};
        const headers = {
          'User-Agent': row.querySelector('[data-ua]')?.value.trim() || '',
          Referer: row.querySelector('[data-referer]')?.value.trim() || '',
        };
        const cookie = row.querySelector('[data-cookie]')?.value.trim() || '';
        if (cookie) headers.Cookie = cookie;
        return {
          id: prev.id,
          name: row.querySelector('[data-name]').value.trim() || 'HD',
          url: row.querySelector('[data-url]').value.trim(),
          headers,
          active: prev.active !== false,
          type: prev.type || 'm3u8',
        };
      });
    };

    const renderList = () => {
      card.innerHTML = `
        <h3>Streams · ${esc(m.homeTeam)} vs ${esc(m.awayTeam)}</h3>
        <p class="muted" style="margin-top:0">Paste a match page URL to auto-find m3u8, or enter m3u8s by hand.</p>
        <div class="row" style="gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:12px">
          <label style="flex:0 0 120px">Source
            <select id="ml-match-source">
              <option value="" ${!m.matchUrlSource ? 'selected' : ''}>Auto</option>
              ${['cakhia', 'xoilac', 'socolive', 'mitomtm'].map((s) =>
                `<option value="${s}" ${m.matchUrlSource === s ? 'selected' : ''}>${s}</option>`
              ).join('')}
            </select>
          </label>
          <label style="flex:1;min-width:220px">Match page URL
            <input id="ml-match-url" type="url" value="${esc(m.matchUrl || '')}" placeholder="https://…/truc-tiep/…" />
          </label>
          <button type="button" class="secondary" id="ml-find-m3u8">Find m3u8</button>
        </div>
        <p class="muted" style="margin-top:0">${m.matchUrlStatus ? `Extract: ${esc(m.matchUrlStatus)}${m.matchUrlExtractError ? ` (${esc(m.matchUrlExtractError)})` : ''}` : ''}</p>
        <div id="ml-stream-list">
          ${streams.map((s, i) => `
            <div style="border:1px solid var(--border,#333);border-radius:8px;padding:10px;margin-bottom:10px" data-i="${i}">
              <div class="row" style="gap:8px;align-items:flex-end;flex-wrap:wrap">
                <label style="flex:0 0 120px">Name<input data-name value="${esc(s.name || 'HD')}" list="mainlive-quality-list" /></label>
                <label style="flex:1;min-width:220px">m3u8 URL<input data-url value="${esc(s.url || '')}" placeholder="https://.../index.m3u8" /></label>
                <button type="button" class="danger" data-del>Remove</button>
              </div>
              <div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">
                <label style="flex:1;min-width:160px">User-Agent<input data-ua value="${esc(s.headers?.['User-Agent'] || '')}" placeholder="Mozilla/5.0 ..." /></label>
                <label style="flex:1;min-width:160px">Referer<input data-referer value="${esc(s.headers?.Referer || '')}" placeholder="https://source.example/" /></label>
                <label style="flex:1;min-width:160px">Cookie (optional)<input data-cookie value="${esc(s.headers?.Cookie || '')}" placeholder="optional" /></label>
              </div>
            </div>
          `).join('') || '<p class="muted">No streams yet.</p>'}
        </div>
        <div class="row" style="gap:8px;margin-top:12px">
          <button type="button" class="secondary" id="ml-add">+ Add</button>
          <button type="button" id="ml-save">Save & publish</button>
          <button type="button" class="ghost" id="ml-close">Close</button>
        </div>
      `;
      card.querySelectorAll('[data-del]').forEach((btn) => {
        btn.addEventListener('click', () => {
          syncFromDom();
          const i = Number(btn.closest('[data-i]').dataset.i);
          streams.splice(i, 1);
          renderList();
        });
      });
      card.querySelector('#ml-add')?.addEventListener('click', () => {
        syncFromDom();
        streams.push({
          name: 'SD',
          url: '',
          headers: { 'User-Agent': '', Referer: '' },
        });
        renderList();
      });
      card.querySelector('#ml-close')?.addEventListener('click', () => overlay.remove());
      card.querySelector('#ml-find-m3u8')?.addEventListener('click', async () => {
        const matchUrl = card.querySelector('#ml-match-url')?.value?.trim();
        const source = card.querySelector('#ml-match-source')?.value;
        if (!matchUrl) {
          toast('Enter a match page URL', 'error');
          return;
        }
        try {
          toast('Searching for m3u8…');
          const result = await api(`/mainlive/${encodeURIComponent(matchId)}/match-url`, {
            method: 'POST',
            body: JSON.stringify({ matchUrl, source }),
          });
          if (result?.extraction?.queued) {
            toast('Match URL saved — extract queued behind the scraper');
          } else if (result?.extraction?.ok) {
            toast(`Found ${result.extraction.streams?.length || 0} stream(s)`);
          } else {
            toast(`Saved URL · ${result?.match?.matchUrlStatus || result?.extraction?.error || 'no m3u8 yet'}`, 'error');
          }
          overlay.remove();
          renderMainLive();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      card.querySelector('#ml-save')?.addEventListener('click', async () => {
        syncFromDom();
        const next = streams.filter((s) => s.url);
        try {
          await api(`/mainlive/${encodeURIComponent(matchId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ streams: next }),
          });
          toast(`Saved ${next.length} stream(s)`);
          overlay.remove();
          renderMainLive();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    };
    renderList();
    overlay.appendChild(card);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
  }

  async function renderMatches() {
    setTitle('Match (admin-match.json)');
    const [matchData, sourceData] = await Promise.all([
      api('/matches'),
      api('/sources').catch(() => ({ sources: [], config: null })),
    ]);
    state.matches = matchData.matches || [];
    const streamingSources = (sourceData.config?.sources || [])
      .filter((s) => s.type === 'streaming' && s.enabled !== false)
      .map((s) => s.name)
      .filter(Boolean);
    const sourceNames = streamingSources.length
      ? streamingSources
      : ['cakhia', 'xoilac', 'socolive', 'luongson', '90phut', 'yyzb'];
    const sourceOpts = sourceNames
      .map((name) => `<option value="${esc(name)}">${esc(name)}</option>`)
      .join('');

    pageEl.innerHTML = `
      <div class="panel">
        <p class="muted">Live <code>admin-match.json</code> feed (${esc(String(matchData.matchCount ?? state.matches.length))} matches) · generated ${esc(matchData.generatedAt || '—')} · ${esc(matchData.timezone || 'Asia/Yangon')}</p>
        <p class="muted">Fixtures come from the scraper. Add a Match URL on a row, or use Manual Streams for m3u8.</p>
      </div>
      <div class="panel">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Match</th><th>League</th><th>Kickoff</th><th>Status</th><th>Match URL</th><th>Stream</th><th>Streams</th><th>Flags</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${state.matches.map((m) => `
                <tr data-id="${esc(m.matchId)}">
                  <td>
                    <strong>${esc(m.homeTeam)} vs ${esc(m.awayTeam)}</strong>
                    <div class="muted" style="font-size:0.75rem">${esc(m.matchId)}${m.isManual || m.manual ? ' · manual' : ''}</div>
                  </td>
                  <td>${esc(m.league || '')}${m.leagueIcon ? `<div><img src="${esc(m.leagueIcon)}" alt="" style="height:18px;margin-top:4px" /></div>` : ''}</td>
                  <td>${esc(m.date || '')} ${esc(m.time || '')}</td>
                  <td><span class="badge ${m.status === 'LIVE' ? 'live' : m.status === 'PREPARING_STREAM' ? 'preparing' : ''}">${esc(m.status || '')}</span></td>
                  <td>
                    <div>${esc(m.matchUrlStatus || '—')}
                      ${m.adminManual?.matchUrl
                        ? ' <span class="badge manual">MANUAL Match URL</span>'
                        : m.matchUrl
                          ? ' <span class="badge">AUTO Match URL</span>'
                          : ''}
                      ${m.adminManual?.streamUrl ? ' <span class="badge manual">MANUAL Stream</span>' : ''}
                    </div>
                    ${m.matchUrl ? `<div class="muted" style="font-size:0.75rem;word-break:break-all">${esc(m.matchUrl)}</div>` : ''}
                    ${(m.override?.manualMatchUrls || []).map((u) => `
                      <div class="muted" style="font-size:0.72rem;margin-top:4px">
                        <span class="badge manual">${esc(u.source)}</span>
                        <span style="word-break:break-all">${esc(u.url)}</span>
                        <button class="secondary" style="padding:2px 6px;font-size:0.7rem;margin-left:4px" data-act="del-match-url" data-source="${esc(u.source)}">×</button>
                      </div>`).join('')}
                    <div class="row" style="margin-top:6px;flex-wrap:wrap;gap:4px">
                      <select data-act="match-url-source" style="width:auto;min-width:88px">
                        ${sourceOpts}
                      </select>
                      <input data-act="match-url" type="url" placeholder="https://.../truc-tiep/..." style="flex:1;min-width:140px" />
                      <button class="secondary" data-act="save-match-url" title="Save page URL — scraper will extract m3u8">Add URL</button>
                    </div>
                  </td>
                  <td>${esc(m.streamStatus || '—')}</td>
                  <td>${(m.streams || []).length}</td>
                  <td>
                    ${m.pinned ? '<span class="badge">PIN</span>' : ''}
                    ${m.featured ? '<span class="badge">FEAT</span>' : ''}
                    ${m.hidden || m.override?.hidden ? '<span class="badge off">HIDDEN</span>' : ''}
                  </td>
                  <td>
                    <div class="row">
                      <button class="secondary" data-act="toggle" data-field="pinned">${m.pinned ? 'Unpin' : 'Pin'}</button>
                      <button class="secondary" data-act="toggle" data-field="featured">${m.featured ? 'Unfeature' : 'Feature'}</button>
                      <button class="secondary" data-act="toggle" data-field="hidden">${m.override?.hidden || m.hidden ? 'Show' : 'Hide'}</button>
                      <select data-act="status">
                        ${['Scheduled', 'LIVE', 'END', 'PREPARING_STREAM'].map((s) => `<option ${m.status === s ? 'selected' : ''}>${s}</option>`).join('')}
                      </select>
                      <input data-act="kickoff" type="datetime-local" style="width:auto" title="Asia/Yangon wall clock" />
                      <button class="secondary" data-act="save-kickoff" title="Saved as Asia/Yangon">Set Time (Yangon)</button>
                      <button class="danger" data-act="delete">${m.isManual || m.manual ? 'Delete' : 'Hide'}</button>
                    </div>
                  </td>
                </tr>`).join('') || '<tr><td colspan="9" class="muted">No matches yet. Run the scraper.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>`;

    pageEl.querySelectorAll('tr[data-id]').forEach((tr) => {
      const id = tr.dataset.id;
      tr.querySelectorAll('[data-act="toggle"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const field = btn.dataset.field;
          const m = state.matches.find((x) => x.matchId === id);
          const current = field === 'hidden' ? Boolean(m.override?.hidden || m.hidden) : Boolean(m[field]);
          try {
            await api(`/matches/${encodeURIComponent(id)}`, {
              method: 'PATCH',
              body: JSON.stringify({ [field]: !current }),
            });
            toast(`Updated ${field}`);
            renderMatches();
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      });
      tr.querySelector('[data-act="status"]')?.addEventListener('change', async (e) => {
        try {
          await api(`/matches/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: e.target.value }),
          });
          toast('Status updated');
          renderMatches();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      tr.querySelector('[data-act="save-kickoff"]')?.addEventListener('click', async () => {
        const val = tr.querySelector('[data-act="kickoff"]').value;
        if (!val) return toast('Pick a kickoff time', 'error');
        const parts = yangonDateTimeLocalParts(val);
        if (!parts) return toast('Invalid date/time', 'error');
        try {
          await api(`/matches/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ date: parts.date, time: parts.time }),
          });
          toast('Kickoff updated (Asia/Yangon)');
          renderMatches();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      tr.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
        if (!confirm('Remove this match from the public feed?')) return;
        try {
          await api(`/matches/${encodeURIComponent(id)}`, { method: 'DELETE' });
          toast('Match removed');
          renderMatches();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      tr.querySelector('[data-act="save-match-url"]')?.addEventListener('click', async () => {
        const source = tr.querySelector('[data-act="match-url-source"]')?.value;
        const matchUrl = tr.querySelector('[data-act="match-url"]')?.value?.trim();
        if (!source) return toast('Select a source', 'error');
        if (!matchUrl) return toast('Enter a match page URL', 'error');
        try {
          const result = await api(`/matches/${encodeURIComponent(id)}/match-url`, {
            method: 'POST',
            body: JSON.stringify({ source, matchUrl }),
          });
          if (result?.extractionQueued) {
            toast('Match URL saved · stream extraction started');
          } else if (result?.extractionEligible === false) {
            toast('Match URL saved · m3u8 extract waits until −30 min');
          } else {
            toast('Match URL saved');
          }
          renderMatches();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      tr.querySelectorAll('[data-act="del-match-url"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const source = btn.dataset.source;
          if (!confirm(`Remove manual match URL for ${source}?`)) return;
          try {
            await api(
              `/matches/${encodeURIComponent(id)}/match-url/${encodeURIComponent(source)}`,
              { method: 'DELETE' }
            );
            toast('Manual match URL removed');
            renderMatches();
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      });
    });
  }


  async function renderStreams() {
    setTitle('Manual Streams');
    const data = await api('/matches');
    state.matches = data.matches || [];
    const options = state.matches
      .map((m) => `<option value="${esc(m.matchId)}">${esc(m.homeTeam)} vs ${esc(m.awayTeam)} · ${esc(m.league || '')}</option>`)
      .join('');

    pageEl.innerHTML = `
      <div class="panel">
        <h3>Add Manual Stream (highest priority)</h3>
        <form id="manual-form" class="grid-2">
          <label>Match<select name="matchId" required>${options || '<option value="">No matches</option>'}</select></label>
          <label>Stream name / Quality<input name="quality" value="HD" placeholder="HD / Link 1 / Full HD" /></label>
          <label style="grid-column:1/-1">m3u8 URL<input name="url" required placeholder="https://.../index.m3u8" /></label>
          <label>User-Agent<input name="userAgent" placeholder="Mozilla/5.0 ..." /></label>
          <label>Referer<input name="referer" placeholder="https://source.example/" /></label>
          <label>Cookie (optional)<input name="cookie" /></label>
          <label>Active<select name="active"><option value="true">Enabled</option><option value="false">Disabled</option></select></label>
          <div style="grid-column:1/-1"><button type="submit">Save Manual Stream</button></div>
        </form>
      </div>
      <div class="panel" id="manual-list"><p class="muted">Select a match to view its manual streams…</p></div>`;

    const form = $('#manual-form');
    const matchSelect = form.matchId;
    const loadList = async () => {
      const id = matchSelect.value;
      if (!id) return;
      const res = await api(`/matches/${encodeURIComponent(id)}/streams`);
      const list = res.manualStreams || [];
      $('#manual-list').innerHTML = `
        <h3>Manual streams for selected match</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Quality</th><th>URL</th><th>Active</th><th></th></tr></thead>
            <tbody>
              ${list.map((s) => `
                <tr>
                  <td><span class="badge manual">${esc(s.name || s.quality)}</span></td>
                  <td style="max-width:360px;word-break:break-all">${esc(s.url)}</td>
                  <td>${s.active !== false ? 'Yes' : 'No'}</td>
                  <td class="row">
                    <button class="secondary" data-toggle="${esc(s.id)}" data-active="${s.active !== false}">${s.active !== false ? 'Disable' : 'Enable'}</button>
                    <button class="danger" data-del="${esc(s.id)}">Delete</button>
                  </td>
                </tr>`).join('') || '<tr><td colspan="4" class="muted">No manual streams</td></tr>'}
            </tbody>
          </table>
        </div>`;

      $('#manual-list').querySelectorAll('[data-del]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          await api(`/matches/${encodeURIComponent(id)}/streams/${btn.dataset.del}`, { method: 'DELETE' });
          toast('Stream removed');
          loadList();
        });
      });
      $('#manual-list').querySelectorAll('[data-toggle]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const active = btn.dataset.active === 'true';
          await api(`/matches/${encodeURIComponent(id)}/streams/${btn.dataset.toggle}`, {
            method: 'PATCH',
            body: JSON.stringify({ active: !active }),
          });
          toast('Stream updated');
          loadList();
        });
      });
    };

    matchSelect.addEventListener('change', () => loadList().catch((e) => toast(e.message, 'error')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        await api(`/matches/${encodeURIComponent(fd.get('matchId'))}/streams`, {
          method: 'POST',
          body: JSON.stringify({
            url: fd.get('url'),
            quality: fd.get('quality'),
            name: fd.get('quality'),
            userAgent: fd.get('userAgent'),
            referer: fd.get('referer'),
            cookie: fd.get('cookie'),
            active: fd.get('active') === 'true',
          }),
        }).then((res) => {
          const gh = res.published?.github;
          if (gh?.uploaded) {
            toast('Manual stream saved · uploaded to GitHub');
          } else if (gh?.reason === 'github_error' || res.published?.warning) {
            toast(
              `Saved locally, but GitHub upload failed: ${gh?.error || res.published?.warning}. Fix GITHUB_TOKEN Contents: Read and write`,
              'error'
            );
          } else {
            toast(`Manual stream saved locally · GitHub: ${gh?.reason || 'skipped'}`);
          }
        });
        form.url.value = '';
        loadList();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    if (matchSelect.value) loadList().catch(() => {});
  }

  const FEED_TABS = [
    { key: 'highlight1', label: 'Highlight 1', file: 'highlight1.json', scraper: '/pipeline/highlights' },
    { key: 'highlight2', label: 'Highlight 2', file: 'highlight2.json', scraper: '/pipeline/highlights' },
    { key: 'tips', label: 'Tips', file: 'tips.json', scraper: '/pipeline/tips' },
    { key: 'myanmartv', label: 'Myanmar TV', file: 'myanmartv.json', scraper: '/pipeline/channels' },
  ];

  async function renderFeeds() {
    setTitle('Delivery Feeds');
    const active = state.feedTab || 'highlight1';
    const res = await api(`/feeds/${encodeURIComponent(active)}`);
    const tab = FEED_TABS.find((t) => t.key === active) || FEED_TABS[0];
    const jsonText = res.data != null ? JSON.stringify(res.data, null, 2) : '{\n}';
    const summary = res.summary || {};

    pageEl.innerHTML = `
      <div class="panel">
        <p class="muted">Edit and publish <code>${esc(tab.file)}</code> when scraping fails. Changes are saved locally and uploaded to GitHub.</p>
        <div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:12px">
          ${FEED_TABS.map((t) => `
            <button class="${t.key === active ? '' : 'secondary'}" data-feed-tab="${esc(t.key)}">${esc(t.label)}</button>
          `).join('')}
        </div>
        <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
          <div class="muted">
            Items: <strong>${esc(String(summary.count ?? 0))}</strong>
            ${summary.scraped_at ? ` · scraped ${esc(summary.scraped_at)}` : ''}
          </div>
          <div class="row" style="flex-wrap:wrap;gap:6px">
            <button type="button" class="secondary" id="feed-select-all">Select all</button>
            <button type="button" class="secondary" id="feed-copy">Copy</button>
            <button type="button" class="secondary" id="feed-paste-all">Paste all</button>
            <button type="button" class="secondary" id="feed-clear">Clear</button>
            <button type="button" class="secondary" id="feed-reload">Reload</button>
            <button type="button" class="secondary" id="feed-run-scraper">Run Scraper</button>
            <button type="button" id="feed-save">Save & Publish</button>
          </div>
        </div>
        <textarea id="feed-json" spellcheck="false" style="width:100%;min-height:420px;font-family:ui-monospace,monospace;font-size:0.82rem;line-height:1.4;padding:12px;border-radius:8px;border:1px solid var(--border);background:var(--panel);color:inherit"></textarea>
        <p class="muted" style="margin-top:8px">
          ${active === 'myanmartv'
            ? 'Paste a JSON array of <code>{ title, img, streamUrl }</code> objects.'
            : active === 'tips'
              ? 'Paste the full tips object with <code>today</code> and <code>tomorrow</code> sections.'
              : 'Paste the full highlight object with a <code>highlights</code> array, or just the highlights array.'}
        </p>
      </div>`;

    $('#feed-json').value = jsonText;

    const feedEditor = $('#feed-json');
    const emptyTemplate = active === 'myanmartv' ? '[]' : '{\n}';

    $('#feed-select-all').addEventListener('click', () => {
      feedEditor.focus();
      feedEditor.select();
    });
    $('#feed-copy').addEventListener('click', async () => {
      try {
        const text = feedEditor.value;
        if (!text) return toast('Nothing to copy', 'error');
        await navigator.clipboard.writeText(text);
        toast('Copied to clipboard');
      } catch {
        feedEditor.select();
        document.execCommand('copy');
        toast('Copied');
      }
    });
    $('#feed-paste-all').addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!text?.trim()) return toast('Clipboard is empty', 'error');
        feedEditor.value = text.trim();
        toast('Replaced all JSON from clipboard');
      } catch {
        toast('Allow clipboard access to paste', 'error');
      }
    });
    $('#feed-clear').addEventListener('click', () => {
      if (feedEditor.value.trim() && !confirm('Clear all JSON? Paste new data then Save & Publish.')) return;
      feedEditor.value = emptyTemplate;
      feedEditor.focus();
      toast('Editor cleared — paste new JSON');
    });

    pageEl.querySelectorAll('[data-feed-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.feedTab = btn.dataset.feedTab;
        renderFeeds();
      });
    });

    $('#feed-reload').addEventListener('click', () => renderFeeds());

    $('#feed-run-scraper').addEventListener('click', async () => {
      const btn = $('#feed-run-scraper');
      try {
        btn.disabled = true;
        toast(`${tab.label} scraper started…`);
        const result = await api(tab.scraper, {
          method: 'POST',
          body: JSON.stringify({ force: true }),
        });
        if (result.github?.uploaded) {
          toast(`${tab.label} scraper OK · uploaded to GitHub`);
        } else {
          toast(`${tab.label} scraper finished · ${result.reason || 'done'}`);
        }
        renderFeeds();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });

    $('#feed-save').addEventListener('click', async () => {
      const btn = $('#feed-save');
      let payload;
      try {
        payload = JSON.parse($('#feed-json').value);
      } catch {
        return toast('Invalid JSON — fix syntax errors first', 'error');
      }
      try {
        btn.disabled = true;
        const result = await api(`/feeds/${encodeURIComponent(active)}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        const gh = result.github;
        if (gh?.uploaded) {
          toast(`${tab.label} saved · uploaded to GitHub`);
        } else if (gh?.reason === 'github_error' || result.warning) {
          toast(`Saved locally, GitHub failed: ${gh?.error || result.warning}`, 'error');
        } else {
          toast(`${tab.label} saved · GitHub: ${gh?.reason || 'unchanged'}`);
        }
        renderFeeds();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  async function renderLeagues() {
    setTitle('League Management');
    const { leagues } = await api('/leagues');
    pageEl.innerHTML = `
      <div class="panel">
        <h3>Add league</h3>
        <form id="league-form" class="grid-2">
          <label>League name<input name="standardName" required placeholder="Premier League" /></label>
          <label>Icon URL<input name="iconUrl" placeholder="https://.../icon.png" /></label>
          <div style="grid-column:1/-1"><button type="submit">Add League</button></div>
        </form>
      </div>
      <div class="panel">
        <h3>Leagues</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Icon</th><th>League</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${leagues.map((l) => `
                <tr data-name="${esc(l.standardName)}">
                  <td>${l.iconUrl ? `<img src="${esc(l.iconUrl)}" alt="" style="height:24px" />` : '—'}</td>
                  <td>${esc(l.standardName)}${l.custom ? ' <span class="badge manual">custom</span>' : ''}</td>
                  <td>${l.enabled ? '<span class="ok">Enabled</span>' : '<span class="error">Disabled</span>'}</td>
                  <td class="row">
                    <input data-act="icon" placeholder="Icon URL" value="${esc(l.iconUrl || '')}" style="min-width:180px" />
                    <button class="secondary" data-act="save-icon">Save Icon</button>
                    <button class="secondary" data-act="toggle" data-enabled="${l.enabled}">${l.enabled ? 'Disable' : 'Enable'}</button>
                    <button class="danger" data-act="delete">Delete</button>
                  </td>
                </tr>`).join('') || '<tr><td colspan="4" class="muted">No leagues</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>`;

    $('#league-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/leagues', {
          method: 'POST',
          body: JSON.stringify({
            standardName: fd.get('standardName'),
            iconUrl: fd.get('iconUrl'),
          }),
        });
        toast('League added');
        renderLeagues();
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    pageEl.querySelectorAll('tr[data-name]').forEach((tr) => {
      const name = tr.dataset.name;
      tr.querySelector('[data-act="toggle"]')?.addEventListener('click', async (btn) => {
        const enabled = tr.querySelector('[data-act="toggle"]').dataset.enabled === 'true';
        try {
          await api(`/leagues/${encodeURIComponent(name)}`, {
            method: 'PATCH',
            body: JSON.stringify({ enabled: !enabled }),
          });
          toast('League updated · JSON republished');
          renderLeagues();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      tr.querySelector('[data-act="save-icon"]')?.addEventListener('click', async () => {
        const iconUrl = tr.querySelector('[data-act="icon"]').value;
        try {
          await api(`/leagues/${encodeURIComponent(name)}`, {
            method: 'PATCH',
            body: JSON.stringify({ iconUrl }),
          });
          toast('League icon saved');
          renderLeagues();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      tr.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
        if (!confirm(`Delete league "${name}"?`)) return;
        try {
          await api(`/leagues/${encodeURIComponent(name)}`, { method: 'DELETE' });
          toast('League deleted');
          renderLeagues();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  }

  async function renderTeams() {
    setTitle('Team Management');
    const { teams } = await api('/teams');
    pageEl.innerHTML = `
      <div class="panel">
        <h3>Add team</h3>
        <form id="team-form" class="grid-2">
          <label>Team name<input name="standardName" required placeholder="Manchester United" /></label>
          <label>Logo URL<input name="logo" placeholder="https://.../logo.png" /></label>
          <label style="grid-column:1/-1">Aliases (comma-separated)<input name="aliases" placeholder="Man Utd, MU" /></label>
          <div style="grid-column:1/-1"><button type="submit">Add Team</button></div>
        </form>
      </div>
      <div class="panel">
        <h3>Teams</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Logo</th><th>Team</th><th>Aliases</th><th></th></tr></thead>
            <tbody>
              ${(teams || []).map((t) => `
                <tr>
                  <td>${t.logo ? `<img src="${esc(t.logo)}" alt="" style="height:24px" />` : '—'}</td>
                  <td>${esc(t.standardName)}</td>
                  <td class="muted">${esc((t.aliases || []).join(', '))}</td>
                  <td><button class="danger" data-del="${esc(t.standardName)}">Delete</button></td>
                </tr>`).join('') || '<tr><td colspan="4" class="muted">No teams</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>`;

    $('#team-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/teams', {
          method: 'POST',
          body: JSON.stringify({
            standardName: fd.get('standardName'),
            logo: fd.get('logo'),
            aliases: fd.get('aliases'),
          }),
        });
        toast('Team added');
        renderTeams();
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    pageEl.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Delete team "${btn.dataset.del}"?`)) return;
        try {
          await api(`/teams/${encodeURIComponent(btn.dataset.del)}`, { method: 'DELETE' });
          toast('Team deleted');
          renderTeams();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  }

  async function renderSources() {
    setTitle('Source Management');
    const data = await api('/sources');
    state.sourcesConfig = data.config;
    pageEl.innerHTML = `
      <div class="panel">
        <h3>Streaming sources</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Source</th><th>Enabled</th><th>Last Success</th><th>Last Error</th><th>Total Streams</th><th></th></tr></thead>
            <tbody>
              ${(data.sources || []).map((s) => `
                <tr>
                  <td>${esc(s.name)}</td>
                  <td>${s.enabled ? 'Yes' : 'No'}</td>
                  <td class="muted">${esc(s.lastSuccessAt || '—')}</td>
                  <td class="muted">${esc(s.lastError || '—')}</td>
                  <td>${s.totalStreamsCollected || 0}</td>
                  <td><button class="secondary" data-src="${esc(s.name)}" data-enabled="${s.enabled}">${s.enabled ? 'Disable' : 'Enable'}</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <p class="muted">Config origin: ${esc(data.configOrigin || 'n/a')}</p>
      </div>`;
    pageEl.querySelectorAll('button[data-src]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/sources/${btn.dataset.src}/enabled`, {
            method: 'PATCH',
            body: JSON.stringify({ enabled: btn.dataset.enabled !== 'true' }),
          });
          toast('Source updated');
          renderSources();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  }

  async function renderConfig() {
    setTitle('Remote Configuration');
    const data = await api('/sources');
    const sourceCount = Array.isArray(data.config?.sources) ? data.config.sources.length : 0;
    const json = JSON.stringify(data.config || { sources: [] }, null, 2);
    const emptyRemote = Boolean(data.remoteEmpty) || (data.configOrigin === 'github' && sourceCount === 0);
    pageEl.innerHTML = `
      <div class="panel">
        <h3>Edit sources.json (domains, selectors, mirrors)</h3>
        <p class="muted">Changes save to local config and GitHub (when configured). No AWS code deploy needed.</p>
        ${emptyRemote || data.remoteError ? `<p class="error">GitHub sources.json is empty${data.remoteError ? ` (${esc(data.remoteError)})` : ''}. Showing local config — push it to GitHub to repair the remote file.</p>` : ''}
        <textarea id="config-json" rows="22" style="width:100%;font-family:ui-monospace,monospace;font-size:0.82rem">${esc(json)}</textarea>
        <div class="row" style="margin-top:0.8rem">
          <button id="btn-save-config">Save Configuration</button>
          <button id="btn-sync-sources" class="secondary" type="button">Push local to GitHub</button>
          <span class="muted">Origin: ${esc(data.configOrigin || 'local')} · ${sourceCount} source${sourceCount === 1 ? '' : 's'}</span>
        </div>
      </div>`;
    $('#btn-save-config').addEventListener('click', async () => {
      try {
        const content = JSON.parse($('#config-json').value);
        await api('/sources/config', {
          method: 'PUT',
          body: JSON.stringify({ content }),
        });
        toast('Configuration saved');
        renderConfig();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    $('#btn-sync-sources').addEventListener('click', async () => {
      try {
        await api('/sources/config/sync', { method: 'POST', body: JSON.stringify({}) });
        toast('Local sources.json pushed to GitHub');
        renderConfig();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  async function renderAppVersion() {
    setTitle('App Version Control');
    const data = await api('/app-version');
    const c = data.content || {};
    pageEl.innerHTML = `
      <div class="panel">
        <h3>Mobile app version / maintenance JSON</h3>
        <p class="muted">Saves locally and publishes to GitHub raw JSON for the Burmese Stream Player app.</p>
        <p class="muted">Raw URL: <a href="${esc(data.rawUrl)}" target="_blank" rel="noopener">${esc(data.rawUrl)}</a></p>
        <p class="muted">Origin: ${esc(data.origin || 'local')} · GitHub: ${data.githubEnabled ? 'configured' : 'not configured (local only)'}</p>
        ${data.remoteError ? `<p class="error">GitHub fetch failed (${esc(data.remoteError)}). Showing local copy.</p>` : ''}
        <form id="app-version-form" class="grid-2">
          <label><input type="checkbox" name="change" ${c.change ? 'checked' : ''} /> Force update prompt (change)</label>
          <label><input type="checkbox" name="con" ${c.con ? 'checked' : ''} /> Maintenance mode (con)</label>
          <label>Title<input name="title" value="${esc(c.title || '')}" required /></label>
          <label>Subtitle<input name="subtitle" value="${esc(c.subtitle || '')}" required /></label>
          <label style="grid-column:1/-1">Play Store link<input name="link" value="${esc(c.link || '')}" required /></label>
          <label>Minimum version<input name="uriversion" value="${esc(c.uriversion || '')}" placeholder="1.0.0" required /></label>
          <label>Version details<input name="uriversionDetails" value="${esc(c.uriversionDetails || '')}" required /></label>
          <label style="grid-column:1/-1">Facebook URL<input name="facebook" value="${esc(c.facebook || '')}" /></label>
          <label style="grid-column:1/-1">Telegram URL<input name="telegram" value="${esc(c.telegram || '')}" /></label>
          <div style="grid-column:1/-1" class="row">
            <button type="submit">Save &amp; Publish</button>
            <button type="button" id="btn-sync-app-version" class="secondary">Push local to GitHub</button>
          </div>
        </form>
      </div>`;

    $('#app-version-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/app-version', {
          method: 'PUT',
          body: JSON.stringify({
            content: {
              change: fd.get('change') === 'on',
              con: fd.get('con') === 'on',
              title: fd.get('title'),
              subtitle: fd.get('subtitle'),
              link: fd.get('link'),
              uriversion: fd.get('uriversion'),
              uriversionDetails: fd.get('uriversionDetails'),
              facebook: fd.get('facebook'),
              telegram: fd.get('telegram'),
            },
          }),
        });
        toast('App version JSON saved');
        renderAppVersion();
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    $('#btn-sync-app-version').addEventListener('click', async () => {
      try {
        await api('/app-version/sync', { method: 'POST', body: JSON.stringify({}) });
        toast('Local app version JSON pushed to GitHub');
        renderAppVersion();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  async function renderNotifications() {
    setTitle('Push Notifications');
    const [tpl, hist] = await Promise.all([
      api('/notifications/templates'),
      api('/notifications/history'),
    ]);
    pageEl.innerHTML = `
      <div class="panel">
        <h3>Send FCM notification</h3>
        <p class="muted">FCM: ${hist.fcmReady ? '<span class="ok">Ready</span>' : `<span class="error">Dry-run (${esc(hist.fcmError || 'not configured')})</span>`}</p>
        <form id="notif-form" class="grid-2">
          <label>Type
            <select name="type">
              ${tpl.templates.map((t) => `<option value="${esc(t.type)}">${esc(t.title)}</option>`).join('')}
            </select>
          </label>
          <label>Target
            <select name="target">
              <option value="all">All users</option>
              <option value="league">By league</option>
              <option value="match">By match</option>
            </select>
          </label>
          <label>Title<input name="title" placeholder="Live Match Started" /></label>
          <label>League (if target=league)<input name="league" /></label>
          <label style="grid-column:1/-1">Body<textarea name="body" rows="3" placeholder="Message body"></textarea></label>
          <label>Match ID (if target=match)<input name="matchId" /></label>
          <div style="grid-column:1/-1"><button type="submit">Send Notification</button></div>
        </form>
      </div>
      <div class="panel">
        <h3>History</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Time</th><th>Type</th><th>Title</th><th>Target</th><th>Result</th></tr></thead>
            <tbody>
              ${(hist.history || []).map((h) => `
                <tr>
                  <td class="muted">${esc(h.at)}</td>
                  <td>${esc(h.type)}</td>
                  <td>${esc(h.title)}</td>
                  <td>${esc(h.target)}${h.league ? ' / ' + esc(h.league) : ''}${h.matchId ? ' / ' + esc(h.matchId) : ''}</td>
                  <td>${h.result?.dryRun ? 'dry-run' : h.result?.ok ? 'sent' : esc(h.result?.error || 'fail')}</td>
                </tr>`).join('') || '<tr><td colspan="5" class="muted">No notifications yet</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>`;

    $('#notif-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/notifications/send', {
          method: 'POST',
          body: JSON.stringify({
            type: fd.get('type'),
            title: fd.get('title'),
            body: fd.get('body'),
            target: fd.get('target'),
            league: fd.get('league') || null,
            matchId: fd.get('matchId') || null,
          }),
        });
        toast('Notification queued/sent');
        renderNotifications();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  async function renderLogs() {
    setTitle('System Logs');
    const { logs } = await api('/logs?limit=300');
    pageEl.innerHTML = `
      <div class="panel">
        <div class="row" style="margin-bottom:0.8rem">
          <select id="log-filter">
            <option value="">All categories</option>
            ${['scraper','stream validation','github','notification','manual_stream','admin'].map((c) => `<option>${c}</option>`).join('')}
          </select>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Time</th><th>Category</th><th>Action</th><th>Message</th><th>Actor</th></tr></thead>
            <tbody id="log-body">
              ${logs.map(logRow).join('') || '<tr><td colspan="5" class="muted">No logs</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>`;
    $('#log-filter').addEventListener('change', async (e) => {
      const cat = e.target.value;
      const q = cat ? `?limit=300&category=${encodeURIComponent(cat)}` : '?limit=300';
      const res = await api(`/logs${q}`);
      $('#log-body').innerHTML = (res.logs || []).map(logRow).join('') || '<tr><td colspan="5" class="muted">No logs</td></tr>';
    });
  }

  function logRow(l) {
    return `<tr>
      <td class="muted">${esc(l.at)}</td>
      <td>${esc(l.category)}</td>
      <td>${esc(l.action)}</td>
      <td>${esc(l.message)}</td>
      <td>${esc(l.actor || '')}</td>
    </tr>`;
  }

  async function renderUsers() {
    setTitle('Admin Users');
    if (!['admin', 'super_admin'].includes(state.user?.role)) {
      pageEl.innerHTML = `<div class="panel error">Admin role required</div>`;
      return;
    }
    let users = [];
    try {
      const res = await api('/users');
      users = res.users || [];
    } catch (err) {
      pageEl.innerHTML = `<div class="panel error">${esc(err.message)}</div>`;
      return;
    }

    pageEl.innerHTML = `
      <div class="panel">
        <h3>Create user</h3>
        <form id="user-form" class="grid-2">
          <label>Username<input name="username" required /></label>
          <label>Password<input name="password" type="password" required /></label>
          <label>Display name<input name="displayName" /></label>
          <label>Role
            <select name="role">
              <option value="viewer">viewer</option>
              <option value="editor" selected>editor</option>
              <option value="admin">admin</option>
              <option value="super_admin">super_admin</option>
            </select>
          </label>
          <div style="grid-column:1/-1"><button type="submit">Create</button></div>
        </form>
      </div>
      <div class="panel">
        <div class="table-wrap">
          <table>
            <thead><tr><th>User</th><th>Role</th><th>Active</th></tr></thead>
            <tbody>
              ${users.map((u) => `
                <tr>
                  <td>${esc(u.displayName || u.username)} <span class="muted">@${esc(u.username)}</span></td>
                  <td>${esc(u.role)}</td>
                  <td>${u.active ? 'Yes' : 'No'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;

    $('#user-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/users', {
          method: 'POST',
          body: JSON.stringify({
            username: fd.get('username'),
            password: fd.get('password'),
            displayName: fd.get('displayName'),
            role: fd.get('role'),
          }),
        });
        toast('User created');
        renderUsers();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  function card(label, value) {
    return `<div class="card"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div></div>`;
  }

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  boot();
})();
