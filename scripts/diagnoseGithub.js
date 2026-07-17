require('dotenv').config();
const axios = require('axios');

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const filePath = process.env.GITHUB_DATA_PATH || 'data/matches.json';
  const branch = process.env.GITHUB_BRANCH || 'main';

  console.log({
    owner,
    repo,
    filePath,
    branch,
    tokenPrefix: `${(token || '').slice(0, 11)}...`,
    tokenLen: (token || '').length,
  });

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'football-live-streaming-backend',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const user = await axios.get('https://api.github.com/user', {
    headers,
    timeout: 20000,
    validateStatus: () => true,
  });
  console.log('USER', user.status, user.data.login || user.data.message);
  console.log('scopes', user.headers['x-oauth-scopes'] || '(fine-grained)');
  console.log(
    'accepted_perms',
    user.headers['x-accepted-github-permissions'] || ''
  );

  const repoRes = await axios.get(`https://api.github.com/repos/${owner}/${repo}`, {
    headers,
    timeout: 20000,
    validateStatus: () => true,
  });
  console.log(
    'REPO',
    repoRes.status,
    repoRes.data.full_name || repoRes.data.message,
    'permissions=',
    repoRes.data.permissions || null
  );

  const getFile = await axios.get(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
    {
      headers,
      params: { ref: branch },
      timeout: 20000,
      validateStatus: () => true,
    }
  );
  console.log(
    'GET_FILE',
    getFile.status,
    getFile.data.path || getFile.data.message,
    getFile.data.sha ? `sha=${String(getFile.data.sha).slice(0, 7)}` : ''
  );
  if (getFile.status >= 400) {
    console.log('GET_BODY', JSON.stringify(getFile.data).slice(0, 500));
  }

  // Try a tiny write test to a dedicated probe file
  const probePath = 'data/.write-probe.json';
  const probeGet = await axios.get(
    `https://api.github.com/repos/${owner}/${repo}/contents/${probePath}`,
    {
      headers,
      params: { ref: branch },
      timeout: 20000,
      validateStatus: () => true,
    }
  );
  const probeContent = {
    ok: true,
    at: new Date().toISOString(),
  };
  const putBody = {
    message: 'chore: write permission probe',
    content: Buffer.from(JSON.stringify(probeContent, null, 2)).toString('base64'),
    branch,
  };
  if (probeGet.status === 200 && probeGet.data.sha) {
    putBody.sha = probeGet.data.sha;
  }

  const put = await axios.put(
    `https://api.github.com/repos/${owner}/${repo}/contents/${probePath}`,
    putBody,
    { headers, timeout: 30000, validateStatus: () => true }
  );
  console.log('PUT_PROBE', put.status, put.data.message || put.data.content?.path || put.data.commit?.sha);
  if (put.status >= 400) {
    console.log('PUT_BODY', JSON.stringify(put.data).slice(0, 800));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
