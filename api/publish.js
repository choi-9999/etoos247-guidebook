const crypto = require('crypto');

const GITHUB_API_BASE = 'https://api.github.com';

function getEnvConfig() {
  const token = (process.env.GITHUB_TOKEN || '').trim();
  const owner = (process.env.GITHUB_OWNER || '').trim();
  const repo = (process.env.GITHUB_REPO || '').trim();
  const branch = (process.env.GITHUB_BRANCH || 'main').trim() || 'main';
  const adminPasswordsRaw = (process.env.ADMIN_PASSWORD || '').trim();
  const allowedPasswords = adminPasswordsRaw
    ? adminPasswordsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : ['2470', 'admin247'];

  return {
    token,
    owner,
    repo,
    branch,
    allowedPasswords,
    configured: Boolean(token && owner && repo)
  };
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'etoos247-guidebook-publisher',
    'Content-Type': 'application/json'
  };
}

async function githubRequest(path, token, options = {}) {
  const res = await fetch(`${GITHUB_API_BASE}${path}`, {
    ...options,
    headers: {
      ...githubHeaders(token),
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = { message: text };
  }
  if (!res.ok) {
    const err = new Error((data && data.message) || `GitHub API error (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function extractMediaFromChapters(chaptersInput) {
  const cloned = JSON.parse(JSON.stringify(chaptersInput));
  const mediaBlobs = new Map(); // repoPath -> base64 content

  const processImageEntry = (imgVal) => {
    if (typeof imgVal !== 'string') return imgVal;
    const match = imgVal.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i);
    if (!match) return imgVal;

    const rawExt = match[1].toLowerCase();
    const ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
    const base64Clean = match[2].replace(/\s+/g, '');
    const hash = crypto.createHash('sha256').update(base64Clean).digest('hex').slice(0, 12);
    const fileName = `upload_${hash}.${ext}`;
    const repoPath = `assets/media/${fileName}`;

    if (!mediaBlobs.has(repoPath)) {
      mediaBlobs.set(repoPath, base64Clean);
    }
    return fileName;
  };

  for (const chap of cloned) {
    if (!chap || !Array.isArray(chap.blocks)) continue;
    for (const block of chap.blocks) {
      if (!block) continue;
      if (Array.isArray(block.images)) {
        block.images = block.images.map(processImageEntry);
      }
      if (Array.isArray(block.rows)) {
        for (const row of block.rows) {
          if (!Array.isArray(row)) continue;
          for (const cell of row) {
            if (cell && Array.isArray(cell.images)) {
              cell.images = cell.images.map(processImageEntry);
            }
          }
        }
      }
    }
  }

  return { cleanedChapters: cloned, mediaBlobs };
}

async function createGitBlob(owner, repo, token, content, encoding) {
  const data = await githubRequest(`/repos/${owner}/${repo}/git/blobs`, token, {
    method: 'POST',
    body: JSON.stringify({ content, encoding })
  });
  return data.sha;
}

async function parseJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const cfg = getEnvConfig();

  // GET /api/publish -> check server publish readiness & latest branch commit SHA
  if (req.method === 'GET') {
    if (!cfg.configured) {
      return res.status(200).json({
        ok: true,
        configured: false,
        message: 'Vercel 환경변수(GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO)가 아직 설정되지 않았습니다.'
      });
    }
    try {
      const refData = await githubRequest(
        `/repos/${cfg.owner}/${cfg.repo}/git/ref/heads/${encodeURIComponent(cfg.branch)}`,
        cfg.token
      );
      return res.status(200).json({
        ok: true,
        configured: true,
        branch: cfg.branch,
        latestCommitSha: refData.object && refData.object.sha ? refData.object.sha : null
      });
    } catch (err) {
      return res.status(200).json({
        ok: false,
        configured: true,
        error: err.message || 'GitHub 브랜치 상태를 조회하지 못했습니다.'
      });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (_) {
    return res.status(400).json({ ok: false, error: '잘못된 JSON 요청입니다.' });
  }

  const action = body.action || 'publish';
  const password = String(body.password || '');

  if (!cfg.allowedPasswords.includes(password)) {
    return res.status(401).json({ ok: false, error: '관리자 비밀번호가 올바르지 않습니다.' });
  }

  if (action === 'verify') {
    return res.status(200).json({ ok: true, configured: cfg.configured });
  }

  if (action !== 'publish') {
    return res.status(400).json({ ok: false, error: '지원하지 않는 요청 작업입니다.' });
  }

  if (!cfg.configured) {
    return res.status(500).json({
      ok: false,
      error: 'Vercel 환경변수(GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO)가 설정되지 않아 서버에 반영할 수 없습니다.'
    });
  }

  const chaptersData = body.chaptersData;
  if (!Array.isArray(chaptersData) || chaptersData.length === 0) {
    return res.status(400).json({ ok: false, error: '유효한 챕터 데이터가 아닙니다.' });
  }

  try {
    // 1. Fetch latest branch commit SHA & verify concurrent edit conflict
    const refData = await githubRequest(
      `/repos/${cfg.owner}/${cfg.repo}/git/ref/heads/${encodeURIComponent(cfg.branch)}`,
      cfg.token
    );
    const latestCommitSha = refData.object && refData.object.sha;
    if (!latestCommitSha) {
      throw new Error('GitHub 브랜치 최신 커밋 SHA를 찾을 수 없습니다.');
    }

    if (body.expectedCommitSha && !body.forceOverwrite && body.expectedCommitSha !== latestCommitSha) {
      return res.status(409).json({
        ok: false,
        conflict: true,
        latestCommitSha,
        error: '다른 관리자가 방금 먼저 운영 서버에 변경 사항을 반영했습니다. 덮어쓰기하거나 페이지를 새로고침한 뒤 다시 시도해 주세요.'
      });
    }

    const commitData = await githubRequest(
      `/repos/${cfg.owner}/${cfg.repo}/git/commits/${latestCommitSha}`,
      cfg.token
    );
    const baseTreeSha = commitData.tree && commitData.tree.sha;
    if (!baseTreeSha) {
      throw new Error('GitHub 기본 트리 SHA를 찾을 수 없습니다.');
    }

    // 2. Separate newly uploaded base64 images into assets/media/ files
    const { cleanedChapters, mediaBlobs } = extractMediaFromChapters(chaptersData);
    const newVersion = Date.now();

    const chaptersJsonStr = JSON.stringify(cleanedChapters, null, 2);
    const chaptersJsStr =
      `window.ETOOS_CHAPTERS_VERSION = ${newVersion};\n` +
      `window.ETOOS_CHAPTERS = ${chaptersJsonStr};\n` +
      `window.ETOOS_ORIGINAL_CHAPTERS = JSON.parse(JSON.stringify(window.ETOOS_CHAPTERS));\n`;

    // 3. Create Git blobs in parallel (chapters.js, chapters.json, and extracted media images)
    const treeEntries = [];

    const [jsBlobSha, jsonBlobSha] = await Promise.all([
      createGitBlob(cfg.owner, cfg.repo, cfg.token, chaptersJsStr, 'utf-8'),
      createGitBlob(cfg.owner, cfg.repo, cfg.token, chaptersJsonStr, 'utf-8')
    ]);

    treeEntries.push(
      { path: 'assets/data/chapters.js', mode: '100644', type: 'blob', sha: jsBlobSha },
      { path: 'assets/data/chapters.json', mode: '100644', type: 'blob', sha: jsonBlobSha }
    );

    for (const [repoPath, base64Content] of mediaBlobs.entries()) {
      const imgSha = await createGitBlob(cfg.owner, cfg.repo, cfg.token, base64Content, 'base64');
      treeEntries.push({ path: repoPath, mode: '100644', type: 'blob', sha: imgSha });
    }

    // 4. Create tree, commit, and update branch reference atomically
    const newTree = await githubRequest(`/repos/${cfg.owner}/${cfg.repo}/git/trees`, cfg.token, {
      method: 'POST',
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: treeEntries
      })
    });

    const commitMsg = (body.commitMessage && String(body.commitMessage).trim())
      || `chore: update guidebook via admin UI (${new Date(newVersion).toISOString()})`;

    const newCommit = await githubRequest(`/repos/${cfg.owner}/${cfg.repo}/git/commits`, cfg.token, {
      method: 'POST',
      body: JSON.stringify({
        message: commitMsg,
        tree: newTree.sha,
        parents: [latestCommitSha]
      })
    });

    await githubRequest(
      `/repos/${cfg.owner}/${cfg.repo}/git/refs/heads/${encodeURIComponent(cfg.branch)}`,
      cfg.token,
      {
        method: 'PATCH',
        body: JSON.stringify({ sha: newCommit.sha, force: false })
      }
    );

    return res.status(200).json({
      ok: true,
      commitSha: newCommit.sha,
      version: newVersion,
      uploadedImages: mediaBlobs.size,
      cleanedChapters
    });
  } catch (err) {
    console.error('Publish error:', err);
    return res.status(err.status || 500).json({
      ok: false,
      error: err.message || 'GitHub 커밋 중 오류가 발생했습니다.'
    });
  }
};
