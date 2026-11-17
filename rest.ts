// REST v3: repositories, branches, commits, contents, issues, comments, labels
// and pull requests. The single-issue GET serves a cached serialised body; the
// list endpoints build on demand (they are never on a timed path).

import {
  DEFAULT_BRANCH,
  FIXED_ISO,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  ZERO_OID,
  buildCommit,
  buildTreeFromFiles,
  collectAncestors,
  diffFileMaps,
  diffLines,
  flattenTree,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTree,
  type FileEntry,
  type IssueRecord,
  type PullRecord,
  type Repo,
  type Store,
} from './store.ts';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RestResponse {
  status: number;
  body: Buffer;
  headers?: Record<string, string>;
}

export interface RestCtx {
  store: Store;
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  origin: string;
}

function jsonResponse(status: number, value: unknown, headers?: Record<string, string>): RestResponse {
  return { status, body: Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'), headers };
}

function err(status: number, message: string): HttpError {
  return new HttpError(status, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Parse an author line `Name <email> ts +0000` into its parts. */
function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: FIXED_ISO };
  const ts = Number.parseInt(match[3]!, 10);
  return {
    name: match[1]!,
    email: match[2]!,
    date: Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : FIXED_ISO,
  };
}

function userJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${VIEWER_LOGIN}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: VIEWER_LOGIN, id: VIEWER_ID },
    html_url: `https://github.com/${VIEWER_LOGIN}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

/** The REST issue object. The record caches its serialised form for the hot read path. */
export function issueObject(repo: Repo, issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://github.com/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
  };
}

export function refreshIssueJson(repo: Repo, issue: IssueRecord): Buffer {
  const buf = Buffer.from(`${JSON.stringify(issueObject(repo, issue))}\n`, 'utf8');
  issue.json = buf;
  return buf;
}

function pullObject(repo: Repo, pr: PullRecord): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pr.head}`) ?? pr.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pr.base}`) ?? pr.baseSha;
  return {
    id: pr.id,
    number: pr.number,
    state: pr.state,
    title: pr.title,
    body: pr.body,
    head: { ref: pr.head, sha: headSha, label: `${VIEWER_LOGIN}:${pr.head}` },
    base: { ref: pr.base, sha: baseSha, label: `${VIEWER_LOGIN}:${pr.base}` },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeSha,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://github.com/${VIEWER_LOGIN}/${repo.name}/pull/${pr.number}`,
  };
}

/** Resolve a ref argument (branch name, full ref, or raw oid) to a commit oid. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.headOid ?? null;
  if (ref.startsWith('refs/')) {
    const oid = repo.refs.get(ref);
    return oid ?? null;
  }
  const branchOid = repo.refs.get(`refs/heads/${ref}`);
  if (branchOid) return branchOid;
  if (isObjectId(ref)) {
    const object = repo.objects.get(ref);
    return object?.type === 'commit' ? ref : null;
  }
  return null;
}

/** The file map at a commit, via the repo's flattened-tree cache. */
function filesAt(repo: Repo, commitOid: string): Map<string, FileEntry> {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return new Map();
  return flattenTree(parseCommit(object.data).tree, repo.lookup, repo.treeCache);
}

/** The commit history from a tip, newest first (first-parent order; histories here are linear). */
function historyFrom(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = tip;
  while (current && isObjectId(current) && !seen.has(current)) {
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object || object.type !== 'commit') break;
    out.push(current);
    current = parseCommit(object.data).parents[0];
  }
  return out;
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid)!;
  const commit = parseCommit(object.data);
  const author = parseIdentity(commit.author);
  const committer = parseIdentity(commit.committer);
  return {
    sha: oid,
    commit: {
      message: commit.message,
      author,
      committer,
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

interface ContentWrite {
  commitSha: string;
  contentSha: string;
  status: 200 | 201;
}

/**
 * Write (or delete) one file on a branch and commit it. A missing branch is
 * created from the default branch's tip (or from nothing when the repo is
 * unborn); a missing repo branch for a read is a 404. `expectedSha` is the
 * blob sha the caller believes is current: a mismatch is a 409.
 */
function writeContent(
  repo: Repo,
  options: {
    branch?: string;
    path: string;
    content: Buffer | null;
    message: string;
    expectedSha?: string;
  },
): ContentWrite {
  const branch = options.branch ?? repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const files = tip ? new Map(filesAt(repo, tip)) : new Map<string, FileEntry>();
  const existing = files.get(options.path);
  if (options.expectedSha !== undefined) {
    if (!existing || existing.oid !== options.expectedSha) {
      throw err(409, 'the file has changed since the given sha');
    }
  }
  let contentSha = '';
  if (options.content === null) {
    if (!existing) throw err(404, 'Not Found');
    files.delete(options.path);
    contentSha = existing.oid;
  } else {
    contentSha = repo.putObject('blob', options.content);
    files.set(options.path, { oid: contentSha, mode: '100644' });
  }
  const treeOid = buildTreeFromFiles(files, (type, data) => repo.putObject(type, data));
  const parents = tip ? [tip] : [];
  const commitData = buildCommit(treeOid, parents, options.message);
  const commitSha = repo.putObject('commit', commitData);
  repo.refs.set(ref, commitSha);
  repo.packCache.clear();
  return { commitSha, contentSha, status: options.expectedSha !== undefined || existing ? 200 : 201 };
}

/** The paginated slice of a list, with a Link header when more pages follow. */
function paginate<T>(
  items: readonly T[],
  query: URLSearchParams,
  origin: string,
  basePath: string,
): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const next = `${origin}${basePath}?per_page=${perPage}&page=${page + 1}`;
    const last = `${origin}${basePath}?per_page=${perPage}&page=${Math.ceil(items.length / perPage)}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return { page: [...slice], headers };
}

// ---------------------------------------------------------------------------------------------
// repositories
// ---------------------------------------------------------------------------------------------

function createRepo(ctx: RestCtx): RestResponse {
  const body = ctx.body;
  if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
    throw err(422, 'name is required');
  }
  const repo = ctx.store.createRepo(body.name, bool(body.private, false), str(body.description));
  if (repo === null) throw err(422, 'Repository already exists');
  return jsonResponse(201, repoJson(repo));
}

function listViewerRepos(ctx: RestCtx): RestResponse {
  const repos = ctx.store.listRepos();
  const { page, headers } = paginate(repos, ctx.query, ctx.origin, '/api/v3/user/repos');
  return jsonResponse(200, page.map((repo) => repoJson(repo)), headers);
}

function getRepo(ctx: RestCtx, owner: string, name: string): RestResponse {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) throw err(404, 'Not Found');
  return jsonResponse(200, repoJson(repo));
}

function patchRepo(ctx: RestCtx, owner: string, name: string): RestResponse {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) throw err(404, 'Not Found');
  if (isRecord(ctx.body)) {
    if (typeof ctx.body.description === 'string') repo.description = ctx.body.description;
    if (typeof ctx.body.private === 'boolean') repo.isPrivate = ctx.body.private;
  }
  return jsonResponse(200, repoJson(repo));
}

function deleteRepo(ctx: RestCtx, owner: string, name: string): RestResponse {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) throw err(404, 'Not Found');
  ctx.store.deleteRepo(owner, name);
  return { status: 204, body: Buffer.alloc(0) };
}

// ---------------------------------------------------------------------------------------------
// branches, refs, commits
// ---------------------------------------------------------------------------------------------

function listBranches(repo: Repo): RestResponse {
  const names = [...repo.refs.keys()]
    .filter((name) => name.startsWith('refs/heads/'))
    .map((name) => name.slice('refs/heads/'.length))
    .sort();
  return jsonResponse(200, names.map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) } })));
}

function getBranch(repo: Repo, branch: string): RestResponse {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (!oid) throw err(404, 'Not Found');
  return jsonResponse(200, { name: branch, commit: { sha: oid } });
}

function createRef(ctx: RestCtx, repo: Repo): RestResponse {
  if (!isRecord(ctx.body) || typeof ctx.body.ref !== 'string' || typeof ctx.body.sha !== 'string') {
    throw err(422, 'ref and sha are required');
  }
  const ref = ctx.body.ref;
  const sha = ctx.body.sha;
  if (!ref.startsWith('refs/') || !isObjectId(sha) || !repo.objects.has(sha)) {
    throw err(422, 'invalid ref or sha');
  }
  if (repo.refs.has(ref)) throw err(422, 'Reference already exists');
  repo.refs.set(ref, sha);
  repo.packCache.clear();
  const object = repo.objects.get(sha)!;
  return jsonResponse(201, { ref, object: { sha, type: object.type } });
}

function getRef(repo: Repo, ref: string): RestResponse {
  const oid = repo.refs.get(ref);
  if (!oid) throw err(404, 'Not Found');
  const object = repo.objects.get(oid);
  return jsonResponse(200, { ref, object: { sha: oid, type: object?.type ?? 'commit' } });
}

function listCommits(ctx: RestCtx, repo: Repo): RestResponse {
  const shaParam = ctx.query.get('sha');
  const tip = shaParam ? resolveRef(repo, shaParam) : (repo.headOid ?? null);
  if (tip === null) return jsonResponse(200, []);
  const history = historyFrom(repo, tip);
  const commits = history.map((oid) => commitJson(repo, oid));
  const { page, headers } = paginate(commits, ctx.query, ctx.origin, `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/commits`);
  return jsonResponse(200, page, headers);
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function contentsPath(ctx: RestCtx, start: number): string {
  const rest = ctx.segments.slice(start).join('/');
  try {
    return decodeURIComponent(rest);
  } catch {
    throw err(400, 'bad path encoding');
  }
}

function getContents(ctx: RestCtx, repo: Repo, path: string): RestResponse {
  const refParam = ctx.query.get('ref');
  const tip = refParam ? resolveRef(repo, refParam) : (repo.headOid ?? null);
  if (tip === null) throw err(404, 'Not Found');
  const object = repo.objects.get(tip)!;
  const treeOid = parseCommit(object.data).tree;
  if (path === '') {
    const entries = parseTree(repo.objects.get(treeOid)!.data);
    return jsonResponse(200, entries.map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: entry.name,
      sha: entry.oid,
    })));
  }
  const files = flattenTree(treeOid, repo.lookup, repo.treeCache);
  const file = files.get(path);
  if (file) {
    const blob = repo.objects.get(file.oid)!;
    return jsonResponse(200, {
      type: 'file',
      name: path.split('/').at(-1),
      path,
      encoding: 'base64',
      content: blob.data.toString('base64'),
      sha: file.oid,
      size: blob.data.length,
    });
  }
  // A directory: walk the tree to the segment path and list its children.
  const segments = path.split('/');
  let currentTree = treeOid;
  for (const segment of segments) {
    const treeObject = repo.objects.get(currentTree);
    if (!treeObject) throw err(404, 'Not Found');
    const entry = parseTree(treeObject.data).find((child) => child.name === segment && child.mode === '40000');
    if (!entry) throw err(404, 'Not Found');
    currentTree = entry.oid;
  }
  const entries = parseTree(repo.objects.get(currentTree)!.data);
  return jsonResponse(200, entries.map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: `${path}/${entry.name}`,
    sha: entry.oid,
  })));
}

function putContents(ctx: RestCtx, repo: Repo, path: string): RestResponse {
  if (!isRecord(ctx.body) || typeof ctx.body.content !== 'string' || typeof ctx.body.message !== 'string') {
    throw err(422, 'content and message are required');
  }
  let content: Buffer;
  try {
    content = Buffer.from(ctx.body.content, 'base64');
  } catch {
    throw err(422, 'content must be base64');
  }
  const branch = typeof ctx.body.branch === 'string' ? ctx.body.branch : undefined;
  const result = writeContent(repo, {
    branch,
    path,
    content,
    message: ctx.body.message,
    expectedSha: typeof ctx.body.sha === 'string' ? ctx.body.sha : undefined,
  });
  return jsonResponse(result.status, {
    content: { name: path.split('/').at(-1), path, sha: result.contentSha, encoding: 'base64', size: content.length },
    commit: { sha: result.commitSha },
  });
}

function deleteContents(ctx: RestCtx, repo: Repo, path: string): RestResponse {
  if (!isRecord(ctx.body) || typeof ctx.body.message !== 'string') {
    throw err(422, 'message is required');
  }
  const branch = typeof ctx.body.branch === 'string' ? ctx.body.branch : undefined;
  const result = writeContent(repo, {
    branch,
    path,
    content: null,
    message: ctx.body.message,
    expectedSha: typeof ctx.body.sha === 'string' ? ctx.body.sha : undefined,
  });
  return jsonResponse(200, { commit: { sha: result.commitSha } });
}

// ---------------------------------------------------------------------------------------------
// issues, labels, comments
// ---------------------------------------------------------------------------------------------

function createIssue(ctx: RestCtx, repo: Repo): RestResponse {
  if (!isRecord(ctx.body) || typeof ctx.body.title !== 'string' || ctx.body.title === '') {
    throw err(422, 'title is required');
  }
  const labels: string[] = [];
  if (Array.isArray(ctx.body.labels)) {
    for (const label of ctx.body.labels) {
      const name = typeof label === 'string' ? label : str(isRecord(label) ? label.name : undefined);
      if (!repo.labels.has(name)) throw err(422, `label does not exist: ${name}`);
      labels.push(name);
    }
  }
  const issue: IssueRecord = {
    id: ctx.store.nextIssueId,
    number: repo.nextIssue,
    title: ctx.body.title,
    body: str(ctx.body.body),
    state: 'open',
    labels,
    comments: [],
    json: null,
  };
  ctx.store.nextIssueId += 1;
  repo.nextIssue += 1;
  repo.issues.push(issue);
  return { status: 201, body: refreshIssueJson(repo, issue) };
}

function listIssues(ctx: RestCtx, repo: Repo): RestResponse {
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const { page, headers } = paginate(issues, ctx.query, ctx.origin, `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/issues`);
  return jsonResponse(200, page.map((issue) => issueObject(repo, issue)), headers);
}

function getIssue(repo: Repo, number: number): RestResponse {
  const issue = repo.issues.find((entry) => entry.number === number);
  if (!issue) throw err(404, 'Not Found');
  if (!issue.json) refreshIssueJson(repo, issue);
  return { status: 200, body: issue.json! };
}

function patchIssue(ctx: RestCtx, repo: Repo, number: number): RestResponse {
  const issue = repo.issues.find((entry) => entry.number === number);
  if (!issue) throw err(404, 'Not Found');
  if (isRecord(ctx.body)) {
    if (typeof ctx.body.state === 'string' && (ctx.body.state === 'open' || ctx.body.state === 'closed')) {
      issue.state = ctx.body.state;
    }
    if (typeof ctx.body.title === 'string') issue.title = ctx.body.title;
    if (typeof ctx.body.body === 'string') issue.body = ctx.body.body;
  }
  return { status: 200, body: refreshIssueJson(repo, issue) };
}

function createLabel(ctx: RestCtx, repo: Repo): RestResponse {
  if (!isRecord(ctx.body) || typeof ctx.body.name !== 'string' || ctx.body.name === '') {
    throw err(422, 'name is required');
  }
  const name = ctx.body.name;
  const color = typeof ctx.body.color === 'string' ? ctx.body.color : 'ededed';
  if (!repo.labels.has(name)) repo.labels.set(name, { name, color });
  return jsonResponse(201, { name, color });
}

function createComment(ctx: RestCtx, repo: Repo, number: number): RestResponse {
  const issue = repo.issues.find((entry) => entry.number === number);
  if (!issue) throw err(404, 'Not Found');
  if (!isRecord(ctx.body) || typeof ctx.body.body !== 'string') throw err(422, 'body is required');
  const id = repo.nextComment;
  repo.nextComment += 1;
  issue.comments.push({ id, body: ctx.body.body });
  return jsonResponse(201, { id, body: ctx.body.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, created_at: FIXED_ISO });
}

function listComments(repo: Repo, number: number): RestResponse {
  const issue = repo.issues.find((entry) => entry.number === number);
  if (!issue) throw err(404, 'Not Found');
  return jsonResponse(200, issue.comments.map((comment) => ({
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: FIXED_ISO,
  })));
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function createPull(ctx: RestCtx, repo: Repo): RestResponse {
  if (!isRecord(ctx.body)) throw err(422, 'head, base and title are required');
  const head = str(ctx.body.head);
  const base = str(ctx.body.base);
  const title = str(ctx.body.title);
  if (!head || !base || !title) throw err(422, 'head, base and title are required');
  const headOid = repo.refs.get(`refs/heads/${head}`);
  const baseOid = repo.refs.get(`refs/heads/${base}`);
  if (!headOid || !baseOid) throw err(422, 'head or base branch does not exist');
  for (const pr of repo.pulls) {
    if (pr.state === 'open' && pr.head === head && pr.base === base) {
      throw err(422, 'A pull request already exists for these branches');
    }
  }
  const pr: PullRecord = {
    id: ctx.store.nextPullId,
    number: repo.nextPull,
    title,
    body: str(ctx.body.body),
    state: 'open',
    head,
    base,
    headSha: headOid,
    baseSha: baseOid,
    merged: false,
    mergedAt: null,
    mergeSha: null,
  };
  ctx.store.nextPullId += 1;
  repo.nextPull += 1;
  repo.pulls.push(pr);
  return jsonResponse(201, pullObject(repo, pr));
}

function listPulls(ctx: RestCtx, repo: Repo): RestResponse {
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls];
  if (state !== 'all') pulls = pulls.filter((pr) => pr.state === state);
  pulls.sort((a, b) => b.number - a.number);
  const { page, headers } = paginate(pulls, ctx.query, ctx.origin, `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/pulls`);
  return jsonResponse(200, page.map((pr) => pullObject(repo, pr)), headers);
}

function getPull(repo: Repo, number: number): RestResponse {
  const pr = repo.pulls.find((entry) => entry.number === number);
  if (!pr) throw err(404, 'Not Found');
  return jsonResponse(200, pullObject(repo, pr));
}

function blobText(repo: Repo, oid: string | undefined): string {
  if (!oid) return '';
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'blob') return '';
  return object.data.toString('utf8');
}

function pullFiles(repo: Repo, number: number): RestResponse {
  const pr = repo.pulls.find((entry) => entry.number === number);
  if (!pr) throw err(404, 'Not Found');
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  if (!headTip || !baseTip) throw err(404, 'Not Found');
  const baseOid = mergeBase(baseTip, headTip, repo.lookup);
  const baseFiles = baseOid ? filesAt(repo, baseOid) : new Map<string, FileEntry>();
  const headFiles = filesAt(repo, headTip);
  const changes = diffFileMaps(baseFiles, headFiles);
  const files = changes.map((change) => {
    const oldText = blobText(repo, baseFiles.get(change.path)?.oid);
    const newText = blobText(repo, headFiles.get(change.path)?.oid);
    const diff = diffLines(oldText, newText);
    return {
      filename: change.path,
      status: change.status,
      additions: diff.additions,
      deletions: diff.deletions,
      changes: diff.additions + diff.deletions,
    };
  });
  return jsonResponse(200, files);
}

/**
 * Squash-merge a pull request: a single commit on the base branch whose tree is
 * the three-way merge of base and head. Returns the merge commit sha, or null
 * when a path changed on both sides with different content. Throws a 404 when
 * the head or base branch is missing. The caller marks the PR merged.
 */
export function doMergePull(repo: Repo, pr: PullRecord): string | null {
  const baseRef = `refs/heads/${pr.base}`;
  const headRef = `refs/heads/${pr.head}`;
  const baseTip = repo.refs.get(baseRef);
  const headTip = repo.refs.get(headRef);
  if (!baseTip || !headTip) throw err(404, 'Not Found');
  const baseOid = mergeBase(baseTip, headTip, repo.lookup);
  const base0Files = baseOid ? filesAt(repo, baseOid) : new Map<string, FileEntry>();
  const baseFiles = filesAt(repo, baseTip);
  const headFiles = filesAt(repo, headTip);
  const headChanges = diffFileMaps(base0Files, headFiles);
  const baseChanges = new Map(diffFileMaps(base0Files, baseFiles).map((change) => [change.path, change]));
  for (const change of headChanges) {
    const baseChange = baseChanges.get(change.path);
    if (!baseChange) continue;
    const headOid = headFiles.get(change.path)?.oid;
    const baseOidNow = baseFiles.get(change.path)?.oid;
    if (headOid !== baseOidNow) return null;
  }
  const mergedFiles = new Map(baseFiles);
  for (const change of headChanges) {
    if (change.status === 'removed') mergedFiles.delete(change.path);
    else mergedFiles.set(change.path, headFiles.get(change.path)!);
  }
  const treeOid = buildTreeFromFiles(mergedFiles, (type, data) => repo.putObject(type, data));
  const commitSha = repo.putObject('commit', buildCommit(treeOid, [baseTip], `Merge pull request #${pr.number} from ${pr.head}`));
  repo.refs.set(baseRef, commitSha);
  repo.packCache.clear();
  return commitSha;
}

function mergePull(ctx: RestCtx, repo: Repo, number: number): RestResponse {
  const pr = repo.pulls.find((entry) => entry.number === number);
  if (!pr) throw err(404, 'Not Found');
  if (pr.merged) throw err(405, 'Pull request has already been merged');
  if (pr.state !== 'open') throw err(405, 'Pull request is not open');
  const commitSha = doMergePull(repo, pr);
  if (commitSha === null) throw err(405, 'This branch has conflicts that must be resolved');
  pr.merged = true;
  pr.state = 'closed';
  pr.mergedAt = FIXED_ISO;
  pr.mergeSha = commitSha;
  return jsonResponse(200, { merged: true, sha: commitSha, message: 'Pull request successfully merged' });
}

// ---------------------------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------------------------

function parseNumber(segment: string | undefined): number {
  const n = Number.parseInt(segment ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : -1;
}

/** Handle a /api/v3 route. Returns null when the path is not a REST route. */
export function handleRest(ctx: RestCtx): RestResponse | null {
  const seg = ctx.segments;
  const method = ctx.method;

  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'POST') return createRepo(ctx);
    if (method === 'GET') return listViewerRepos(ctx);
    return null;
  }
  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = seg[1]!;
    const name = seg[2]!;
    if (seg.length === 3) {
      if (method === 'GET') return getRepo(ctx, owner, name);
      if (method === 'PATCH') return patchRepo(ctx, owner, name);
      if (method === 'DELETE') return deleteRepo(ctx, owner, name);
      return null;
    }
    const repo = ctx.store.getRepo(owner, name);
    if (!repo) throw err(404, 'Not Found');
    const tail = seg[3]!;
    if (tail === 'branches') {
      if (method === 'GET' && seg.length === 4) return listBranches(repo);
      if (method === 'GET' && seg.length > 4) return getBranch(repo, seg.slice(4).join('/'));
      return null;
    }
    if (tail === 'git' && seg[4] === 'refs') {
      if (method === 'POST' && seg.length === 5) return createRef(ctx, repo);
      if (method === 'GET' && seg.length > 5) return getRef(repo, `refs/${seg.slice(5).join('/')}`);
      return null;
    }
    if (tail === 'commits') {
      if (method === 'GET') return listCommits(ctx, repo);
      return null;
    }
    if (tail === 'contents') {
      const path = contentsPath(ctx, 4);
      if (method === 'GET') return getContents(ctx, repo, path);
      if (method === 'PUT') return putContents(ctx, repo, path);
      if (method === 'DELETE') return deleteContents(ctx, repo, path);
      return null;
    }
    if (tail === 'issues') {
      if (seg.length === 4) {
        if (method === 'POST') return createIssue(ctx, repo);
        if (method === 'GET') return listIssues(ctx, repo);
        return null;
      }
      const number = parseNumber(seg[4]);
      if (number < 0) return null;
      if (seg.length === 5) {
        if (method === 'GET') return getIssue(repo, number);
        if (method === 'PATCH') return patchIssue(ctx, repo, number);
        return null;
      }
      if (seg[5] === 'comments' && seg.length === 6) {
        if (method === 'POST') return createComment(ctx, repo, number);
        if (method === 'GET') return listComments(repo, number);
        return null;
      }
      return null;
    }
    if (tail === 'labels') {
      if (method === 'POST') return createLabel(ctx, repo);
      return null;
    }
    if (tail === 'pulls') {
      if (seg.length === 4) {
        if (method === 'POST') return createPull(ctx, repo);
        if (method === 'GET') return listPulls(ctx, repo);
        return null;
      }
      const number = parseNumber(seg[4]);
      if (number < 0) return null;
      if (seg.length === 5) {
        if (method === 'GET') return getPull(repo, number);
        return null;
      }
      if (seg[5] === 'files' && seg.length === 6 && method === 'GET') return pullFiles(repo, number);
      if (seg[5] === 'merge' && seg.length === 6 && method === 'PUT') return mergePull(ctx, repo, number);
      return null;
    }
  }
  return null;
}
