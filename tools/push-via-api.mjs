/*
 * Push the current HEAD to GitHub through api.github.com.
 *
 * Needed when github.com:443 is unreachable on your network but the API host
 * still resolves. Uploads real git objects and verifies every blob/tree/commit
 * SHA against the local repository before creating the branch ref.
 *
 *   $env:GITHUB_TOKEN="github_pat_xxx"
 *   node tools/push-via-api.mjs --dry-run     # inspect, no network
 *   node tools/push-via-api.mjs               # actually push
 *
 * Env: GITHUB_TOKEN (contents:write), REPO (owner/name), BRANCH (default main)
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.REPO || 'DrCatty/Cave-of-DrCatty';
const BRANCH = process.env.BRANCH || 'main';
const TOKEN = process.env.GITHUB_TOKEN || '';
const DRY = process.argv.includes('--dry-run');
const API = 'https://api.github.com';

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const gitBuf = (args) => execFileSync('git', args, { cwd: ROOT });

function localObjects() {
  const files = git(['ls-files', '-s'])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [, mode, sha, , filePath] = line.match(/^(\d{6})\s([0-9a-f]{40})\s(\d)\t(.*)$/);
      return { mode, sha, path: filePath };
    });
  return {
    files,
    tree: git(['rev-parse', 'HEAD^{tree}']),
    commit: git(['rev-parse', 'HEAD']),
    message: git(['log', '-1', '--format=%B']),
    authorName: git(['log', '-1', '--format=%an']),
    authorEmail: git(['log', '-1', '--format=%ae']),
    authorDate: git(['log', '-1', '--format=%aI']),
    committerName: git(['log', '-1', '--format=%cn']),
    committerEmail: git(['log', '-1', '--format=%ce']),
    committerDate: git(['log', '-1', '--format=%cI']),
  };
}

async function api(route, method = 'GET', body) {
  const res = await fetch(API + route, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'monopoly-online-pusher',
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail = data.message || text.slice(0, 200);
    throw new Error(`${method} ${route} -> ${res.status} ${detail}`);
  }
  return data;
}

const local = localObjects();
console.log(`repo   : ${REPO}  (branch ${BRANCH})`);
console.log(`files  : ${local.files.length}`);
console.log(`tree   : ${local.tree}`);
console.log(`commit : ${local.commit}`);
console.log(`message: ${local.message.split('\n')[0]}`);

if (DRY) {
  for (const f of local.files) console.log(`  ${f.mode} ${f.sha.slice(0, 8)} ${f.path}`);
  console.log('\n(dry run - nothing uploaded)');
  process.exit(0);
}

if (!TOKEN) {
  console.error('\n缺少 GITHUB_TOKEN。请生成仅限该仓库、Contents 读写、短有效期的细粒度令牌，然后：');
  console.error('  $env:GITHUB_TOKEN="github_pat_..."; node tools/push-via-api.mjs');
  process.exit(2);
}

try {
  const info = await api(`/repos/${REPO}`);
  console.log(`\nremote : ${info.full_name} (${info.private ? 'private' : 'public'}) size=${info.size}KB`);

  let parent = null;
  try {
    const ref = await api(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
    parent = ref.object.sha;
    console.log(`existing ${BRANCH} -> ${parent}`);
  } catch {
    console.log(`branch ${BRANCH} 尚不存在（空仓库），将创建`);
  }

  if (parent === local.commit) {
    console.log('\n远端已经指向同一个提交，无需推送。');
    process.exit(0);
  }

  console.log('\n上传 blobs…');
  let mismatched = 0;
  const treeEntries = [];
  for (const file of local.files) {
    const content = gitBuf(['cat-file', 'blob', file.sha]);
    const blob = await api(`/repos/${REPO}/git/blobs`, 'POST', {
      content: content.toString('base64'),
      encoding: 'base64',
    });
    if (blob.sha !== file.sha) {
      mismatched += 1;
      console.log(`  ! ${file.path} sha 不一致（本地 ${file.sha.slice(0, 8)} / 远端 ${blob.sha.slice(0, 8)}）`);
    }
    treeEntries.push({ path: file.path, mode: file.mode, type: 'blob', sha: blob.sha });
  }
  console.log(`  ${local.files.length} 个文件上传完成${mismatched ? `，${mismatched} 个 sha 不一致` : '，全部 sha 校验一致'}`);

  const tree = await api(`/repos/${REPO}/git/trees`, 'POST', { tree: treeEntries });
  console.log(`tree   : ${tree.sha}${tree.sha === local.tree ? ' (与本地一致)' : ` (本地 ${local.tree})`}`);

  const commit = await api(`/repos/${REPO}/git/commits`, 'POST', {
    message: local.message,
    tree: tree.sha,
    parents: parent ? [parent] : [],
    author: { name: local.authorName, email: local.authorEmail, date: local.authorDate },
    committer: { name: local.committerName, email: local.committerEmail, date: local.committerDate },
  });
  console.log(`commit : ${commit.sha}${commit.sha === local.commit ? ' (与本地一致)' : ` (本地 ${local.commit})`}`);

  if (parent) {
    await api(`/repos/${REPO}/git/refs/heads/${BRANCH}`, 'PATCH', { sha: commit.sha, force: false });
  } else {
    await api(`/repos/${REPO}/git/refs`, 'POST', { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
  }
  console.log(`\n完成：https://github.com/${REPO}/tree/${BRANCH}`);
  console.log('接下来去 Render 选 Blueprint 指向该仓库即可。');
} catch (err) {
  console.error(`\n推送失败：${err.message}`);
  process.exit(1);
}
