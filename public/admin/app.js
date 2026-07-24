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
      matches: renderMatches,
      streams: renderStreams,
      leagues: renderLeagues,
      teams: renderTeams,
      sources: renderSources,
      config: renderConfig,
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

  async function renderMatches() {
    setTitle('Match Management');
    const [matchData, leagueData, teamData] = await Promise.all([
      api('/matches'),
      api('/leagues'),
      api('/teams'),
    ]);
    state.matches = matchData.matches || [];
    const leagues = (leagueData.leagues || []).filter((l) => l.enabled !== false);
    const teams = (teamData.teams || []).filter((t) => t.enabled !== false);
    const leagueOpts = leagues
      .map((l) => `<option value="${esc(l.standardName)}" data-icon="${esc(l.iconUrl || '')}">${esc(l.standardName)}</option>`)
      .join('');
    const teamOpts = teams
      .map((t) => `<option value="${esc(t.standardName)}" data-logo="${esc(t.logo || '')}">${esc(t.standardName)}</option>`)
      .join('');

    pageEl.innerHTML = `
      <div class="panel">
        <h3>Add Match</h3>
        <form id="match-create-form" class="grid-2">
          <label>League
            <select name="league" required>
              <option value="">Select league</option>
              ${leagueOpts}
            </select>
          </label>
          <label>League icon URL<input name="leagueIcon" placeholder="https://.../league.png" /></label>
          <label>Home team
            <input name="homeTeam" list="team-list" required placeholder="Home team" />
          </label>
          <label>Away team
            <input name="awayTeam" list="team-list" required placeholder="Away team" />
          </label>
          <datalist id="team-list">${teamOpts}</datalist>
          <label>Date<input name="date" type="date" required /></label>
          <label>Time<input name="time" type="time" required /></label>
          <label>Status
            <select name="status">
              <option>Scheduled</option>
              <option>LIVE</option>
              <option>END</option>
            </select>
          </label>
          <label>Stream name<input name="streamName" value="HD" placeholder="HD / Link 1" /></label>
          <label style="grid-column:1/-1">Streaming URL<input name="streamUrl" placeholder="https://.../index.m3u8" /></label>
          <div style="grid-column:1/-1"><button type="submit">Create Match</button></div>
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
              ${state.matches.map((m) => `
                <tr data-id="${esc(m.matchId)}">
                  <td>
                    <strong>${esc(m.homeTeam)} vs ${esc(m.awayTeam)}</strong>
                    <div class="muted" style="font-size:0.75rem">${esc(m.matchId)}${m.isManual || m.manual ? ' · manual' : ''}</div>
                  </td>
                  <td>${esc(m.league || '')}${m.leagueIcon ? `<div><img src="${esc(m.leagueIcon)}" alt="" style="height:18px;margin-top:4px" /></div>` : ''}</td>
                  <td>${esc(m.date || '')} ${esc(m.time || '')}</td>
                  <td><span class="badge ${m.status === 'LIVE' ? 'live' : m.status === 'PREPARING_STREAM' ? 'preparing' : ''}">${esc(m.status || '')}</span></td>
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
                      <input data-act="kickoff" type="datetime-local" style="width:auto" />
                      <button class="secondary" data-act="save-kickoff">Set Time</button>
                      <button class="danger" data-act="delete">${m.isManual || m.manual ? 'Delete' : 'Hide'}</button>
                    </div>
                  </td>
                </tr>`).join('') || '<tr><td colspan="7" class="muted">No matches yet. Add one above or run scraper.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>`;

    const form = $('#match-create-form');
    const leagueSelect = form.league;
    leagueSelect.addEventListener('change', () => {
      const opt = leagueSelect.selectedOptions[0];
      if (opt?.dataset?.icon) form.leagueIcon.value = opt.dataset.icon;
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        await api('/matches', {
          method: 'POST',
          body: JSON.stringify({
            league: fd.get('league'),
            leagueIcon: fd.get('leagueIcon'),
            homeTeam: fd.get('homeTeam'),
            awayTeam: fd.get('awayTeam'),
            date: fd.get('date'),
            time: fd.get('time'),
            status: fd.get('status'),
            streamName: fd.get('streamName'),
            streamUrl: fd.get('streamUrl'),
          }),
        });
        toast('Match created · JSON republished');
        renderMatches();
      } catch (err) {
        toast(err.message, 'error');
      }
    });

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
        try {
          await api(`/matches/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ kickoff: new Date(val).toISOString() }),
          });
          toast('Kickoff updated');
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
    const json = JSON.stringify(data.config || { sources: [] }, null, 2);
    pageEl.innerHTML = `
      <div class="panel">
        <h3>Edit sources.json (domains, selectors, mirrors)</h3>
        <p class="muted">Changes save to local config and GitHub (when configured). No AWS code deploy needed.</p>
        <textarea id="config-json" rows="22" style="width:100%;font-family:ui-monospace,monospace;font-size:0.82rem">${esc(json)}</textarea>
        <div class="row" style="margin-top:0.8rem">
          <button id="btn-save-config">Save Configuration</button>
          <span class="muted">Origin: ${esc(data.configOrigin || 'local')}</span>
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
