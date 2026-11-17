// GraphQL executor for the fixed document set the suite sends (gh's documents).
// A small recursive-descent parser for the GraphQL subset in use (operations,
// aliases, arguments, object/list/enum/variable values, inline fragments), then
// a resolver tree keyed by object type. Unknown fields are HTTP 200 with an
// `errors` array naming the field, never an HTTP 400.

import {
  DEFAULT_BRANCH,
  FIXED_ISO,
  VIEWER_ID,
  VIEWER_LOGIN,
  diffFileMaps,
  flattenTree,
  globalId,
  mergeBase,
  parseCommit,
  parseGlobalId,
  type FileEntry,
  type IssueRecord,
  type PullRecord,
  type Repo,
  type Store,
} from './store.ts';
import { doMergePull, refreshIssueJson } from './rest.ts';

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

export type GqlValue =
  | string
  | number
  | boolean
  | null
  | GqlValue[]
  | { [key: string]: GqlValue }
  | { __var: string };

export interface FieldSelection {
  kind: 'field';
  name: string;
  alias: string;
  args: Record<string, GqlValue>;
  children: Selection[];
}

export interface FragmentSelection {
  kind: 'fragment';
  typeCondition: string | null;
  children: Selection[];
}

export type Selection = FieldSelection | FragmentSelection;

export interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

class ParseError extends Error {}

class Scanner {
  private pos = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  private skipIgnored(): void {
    for (;;) {
      const ch = this.source[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
        this.pos += 1;
        continue;
      }
      if (ch === '#') {
        while (this.pos < this.source.length && this.source[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  peek(): string {
    this.skipIgnored();
    return this.source[this.pos] ?? '';
  }

  peekAt(offset: number): string {
    return this.source[this.pos + offset] ?? '';
  }

  expect(ch: string): void {
    this.skipIgnored();
    if (this.source[this.pos] !== ch) throw new ParseError(`expected '${ch}' at ${this.pos}`);
    this.pos += 1;
  }

  accept(ch: string): boolean {
    this.skipIgnored();
    if (this.source[this.pos] === ch) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  acceptSpread(): boolean {
    this.skipIgnored();
    if (this.source.startsWith('...', this.pos)) {
      this.pos += 3;
      return true;
    }
    return false;
  }

  readName(): string {
    this.skipIgnored();
    const start = this.pos;
    while (/[A-Za-z0-9_]/.test(this.source[this.pos] ?? '')) this.pos += 1;
    if (this.pos === start) throw new ParseError(`expected a name at ${this.pos}`);
    return this.source.slice(start, this.pos);
  }

  peekName(): string | null {
    this.skipIgnored();
    const start = this.pos;
    if (!/[A-Za-z_]/.test(this.source[this.pos] ?? '')) return null;
    let end = this.pos;
    while (/[A-Za-z0-9_]/.test(this.source[end] ?? '')) end += 1;
    return this.source.slice(start, end);
  }

  readString(): string {
    this.skipIgnored();
    if (this.source[this.pos] !== '"') throw new ParseError(`expected a string at ${this.pos}`);
    this.pos += 1;
    let out = '';
    for (;;) {
      const ch = this.source[this.pos];
      if (ch === undefined) throw new ParseError('unterminated string');
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        const esc = this.source[this.pos + 1];
        this.pos += 2;
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else if (esc === '"') out += '"';
        else if (esc === '\\') out += '\\';
        else if (esc === '/') out += '/';
        else if (esc === 'u') {
          out += String.fromCharCode(Number.parseInt(this.source.slice(this.pos, this.pos + 4), 16));
          this.pos += 4;
        } else out += esc ?? '';
        continue;
      }
      out += ch;
      this.pos += 1;
    }
  }

  readNumber(): number {
    this.skipIgnored();
    const start = this.pos;
    if (this.source[this.pos] === '-') this.pos += 1;
    while (/[0-9.]/.test(this.source[this.pos] ?? '')) this.pos += 1;
    const text = this.source.slice(start, this.pos);
    const value = Number(text);
    if (!Number.isFinite(value)) throw new ParseError(`bad number '${text}'`);
    return value;
  }

  atEnd(): boolean {
    this.skipIgnored();
    return this.pos >= this.source.length;
  }
}

function parseValue(scanner: Scanner): GqlValue {
  const ch = scanner.peek();
  if (ch === '$') {
    scanner.expect('$');
    return { __var: scanner.readName() };
  }
  if (ch === '"') return scanner.readString();
  if (ch === '[') {
    scanner.expect('[');
    const items: GqlValue[] = [];
    while (!scanner.accept(']')) items.push(parseValue(scanner));
    return items;
  }
  if (ch === '{') {
    scanner.expect('{');
    const object: Record<string, GqlValue> = {};
    while (!scanner.accept('}')) {
      const name = scanner.readName();
      scanner.expect(':');
      object[name] = parseValue(scanner);
    }
    return object;
  }
  if (ch === '-' || /[0-9]/.test(ch)) return scanner.readNumber();
  const name = scanner.readName();
  if (name === 'true') return true;
  if (name === 'false') return false;
  if (name === 'null') return null;
  return name;
}

function skipBalanced(scanner: Scanner, open: string, close: string): void {
  scanner.expect(open);
  let depth = 1;
  while (depth > 0) {
    const ch = scanner.peek();
    if (ch === '') throw new ParseError(`unterminated '${open}'`);
    if (ch === open) depth += 1;
    else if (ch === close) depth -= 1;
    scanner.expect(ch);
  }
}

function parseSelectionSet(scanner: Scanner): Selection[] {
  scanner.expect('{');
  const selections: Selection[] = [];
  while (!scanner.accept('}')) {
    if (scanner.acceptSpread()) {
      let typeCondition: string | null = null;
      if (scanner.peekName() === 'on') {
        scanner.readName();
        typeCondition = scanner.readName();
      }
      selections.push({ kind: 'fragment', typeCondition, children: parseSelectionSet(scanner) });
      continue;
    }
    const first = scanner.readName();
    let alias = first;
    let name = first;
    if (scanner.accept(':')) {
      name = scanner.readName();
    }
    const args: Record<string, GqlValue> = {};
    if (scanner.peek() === '(') {
      scanner.expect('(');
      while (!scanner.accept(')')) {
        const argName = scanner.readName();
        scanner.expect(':');
        args[argName] = parseValue(scanner);
      }
    }
    const children = scanner.peek() === '{' ? parseSelectionSet(scanner) : [];
    selections.push({ kind: 'field', name, alias, args, children });
  }
  return selections;
}

export function parseDocument(source: string): Operation[] {
  const scanner = new Scanner(source);
  const operations: Operation[] = [];
  while (!scanner.atEnd()) {
    let type: 'query' | 'mutation' = 'query';
    const word = scanner.peekName();
    if (word === 'query' || word === 'mutation') {
      type = word;
      scanner.readName();
    }
    let name: string | null = null;
    const maybeName = scanner.peekName();
    if (maybeName !== null && maybeName !== 'on') name = scanner.readName();
    if (scanner.peek() === '(') skipBalanced(scanner, '(', ')');
    operations.push({ type, name, selections: parseSelectionSet(scanner) });
  }
  if (operations.length === 0) throw new ParseError('empty document');
  return operations;
}

/** Resolve argument values against the operation's variables. */
function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if ('__var' in value) return variables[(value as { __var: string }).__var];
    if (Array.isArray(value)) return value.map((item) => resolveValue(item, variables));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveValue(item, variables);
    return out;
  }
  return value;
}

function resolveArgs(args: Record<string, GqlValue>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = resolveValue(value, variables);
  return out;
}

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

const TYPE = Symbol('type');
const DATA = Symbol('data');

type Wrapped = Record<string | symbol, unknown>;

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
}

interface GqlError {
  message: string;
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];
const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
  'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MARKETPLACE', 'ORGANIZATION'];

function wrap(type: string, data: unknown): Wrapped {
  return { [TYPE]: type, [DATA]: data };
}

function encodeCursor(number: number): string {
  return Buffer.from(String(number), 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const n = Number.parseInt(Buffer.from(cursor, 'base64').toString('utf8'), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function filesAt(repo: Repo, commitOid: string): Map<string, FileEntry> {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return new Map();
  return flattenTree(parseCommit(object.data).tree, repo.lookup, repo.treeCache);
}

/** MERGEABLE when the three-way merge has no conflicting path, CONFLICTING otherwise. */
function computeMergeable(repo: Repo, pr: PullRecord): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  const baseOid = mergeBase(baseTip, headTip, repo.lookup);
  if (baseOid === null) return 'MERGEABLE';
  const base0Files = filesAt(repo, baseOid);
  const baseFiles = filesAt(repo, baseTip);
  const headFiles = filesAt(repo, headTip);
  const baseChanges = new Map(diffFileMaps(base0Files, baseFiles).map((change) => [change.path, change]));
  for (const change of diffFileMaps(base0Files, headFiles)) {
    if (!baseChanges.has(change.path)) continue;
    if (headFiles.get(change.path)?.oid !== baseFiles.get(change.path)?.oid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/** Apply a squash merge via the shared REST core. Null on conflict or missing branch. */
function applyMerge(repo: Repo, pr: PullRecord): string | null {
  try {
    return doMergePull(repo, pr);
  } catch {
    return null;
  }
}

function issueObj(repo: Repo, issue: IssueRecord): Wrapped {
  return wrap('Issue', { repo, issue });
}

function pullObj(repo: Repo, pr: PullRecord): Wrapped {
  return wrap('PullRequest', { repo, pr });
}

function repoObj(repo: Repo): Wrapped {
  return wrap('Repository', repo);
}

type Resolver = (parent: Wrapped, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => wrap('Viewer', null),
    repository: (_parent, args, ctx) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = ctx.store.getRepo(owner, name);
      return repo ? repoObj(repo) : null;
    },
    node: (_parent, args, ctx) => {
      const id = typeof args.id === 'string' ? args.id : '';
      const parsed = parseGlobalId(id);
      if (!parsed || parsed.kind !== 'R') return null;
      const repo = ctx.store.getRepo(parsed.parts[0]!, parsed.parts[1]!);
      return repo ? repoObj(repo) : null;
    },
    __type: (_parent, args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      if (name === 'Issue') return wrap('__Type', { name, fields: ISSUE_FIELDS, enumValues: [] });
      if (name === 'PullRequest') return wrap('__Type', { name, fields: PULL_REQUEST_FIELDS, enumValues: [] });
      if (name === 'Repository') return wrap('__Type', { name, fields: REPOSITORY_FIELDS, enumValues: [] });
      if (name === 'SearchType') return wrap('__Type', { name, fields: [], enumValues: SEARCH_TYPE_VALUES });
      return null;
    },
    createIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
      if (!parsed || parsed.kind !== 'R') throw new Error('unknown repository');
      const repo = ctx.store.getRepo(parsed.parts[0]!, parsed.parts[1]!);
      if (!repo) throw new Error('unknown repository');
      const issue: IssueRecord = {
        id: ctx.store.nextIssueId,
        number: repo.nextIssue,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        json: null,
      };
      ctx.store.nextIssueId += 1;
      repo.nextIssue += 1;
      repo.issues.push(issue);
      refreshIssueJson(repo, issue);
      return wrap('CreateIssuePayload', { issue: issueObj(repo, issue) });
    },
    closeIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(typeof input.issueId === 'string' ? input.issueId : '');
      if (!parsed || parsed.kind !== 'I') throw new Error('unknown issue');
      const repo = ctx.store.getRepo(parsed.parts[0]!, parsed.parts[1]!);
      const issue = repo?.issues.find((entry) => entry.number === Number(parsed.parts[2]));
      if (!issue) throw new Error('unknown issue');
      issue.state = 'closed';
      refreshIssueJson(repo!, issue);
      return wrap('CloseIssuePayload', { issue: issueObj(repo!, issue) });
    },
    createPullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
      if (!parsed || parsed.kind !== 'R') throw new Error('unknown repository');
      const repo = ctx.store.getRepo(parsed.parts[0]!, parsed.parts[1]!);
      if (!repo) throw new Error('unknown repository');
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headOid = repo.refs.get(`refs/heads/${head}`);
      const baseOid = repo.refs.get(`refs/heads/${base}`);
      if (!headOid || !baseOid) throw new Error('head or base branch does not exist');
      for (const pr of repo.pulls) {
        if (pr.state === 'open' && pr.head === head && pr.base === base) {
          throw new Error('A pull request already exists for these branches');
        }
      }
      const pr: PullRecord = {
        id: ctx.store.nextPullId,
        number: repo.nextPull,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
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
      return wrap('CreatePullRequestPayload', { pullRequest: pullObj(repo, pr) });
    },
    mergePullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(typeof input.pullRequestId === 'string' ? input.pullRequestId : '');
      if (!parsed || parsed.kind !== 'P') throw new Error('unknown pull request');
      const repo = ctx.store.getRepo(parsed.parts[0]!, parsed.parts[1]!);
      const pr = repo?.pulls.find((entry) => entry.number === Number(parsed.parts[2]));
      if (!pr) throw new Error('unknown pull request');
      if (!pr.merged) {
        const sha = applyMerge(repo!, pr);
        if (sha === null) throw new Error('This branch has conflicts that must be resolved');
        pr.merged = true;
        pr.state = 'closed';
        pr.mergedAt = FIXED_ISO;
        pr.mergeSha = sha;
      }
      return wrap('MergePullRequestPayload', { pullRequest: pullObj(repo!, pr) });
    },
    addComment: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(typeof input.subjectId === 'string' ? input.subjectId : '');
      if (!parsed || parsed.kind !== 'I') throw new Error('unknown subject');
      const repo = ctx.store.getRepo(parsed.parts[0]!, parsed.parts[1]!);
      const issue = repo?.issues.find((entry) => entry.number === Number(parsed.parts[2]));
      if (!issue) throw new Error('unknown issue');
      const id = repo!.nextComment;
      repo!.nextComment += 1;
      const body = typeof input.body === 'string' ? input.body : '';
      issue.comments.push({ id, body });
      return wrap('AddCommentPayload', {
        commentEdge: wrap('IssueCommentEdge', {
          node: wrap('IssueComment', { id: globalId('C', [parsed.parts[0]!, parsed.parts[1]!, String(issue.number), String(id)]), body }),
        }),
      });
    },
  },
  Viewer: {
    login: () => VIEWER_LOGIN,
  },
  Repository: {
    id: (parent) => globalId('R', [VIEWER_LOGIN, (parent[DATA] as Repo).name]),
    databaseId: (parent) => (parent[DATA] as Repo).id,
    name: (parent) => (parent[DATA] as Repo).name,
    nameWithOwner: (parent) => `${VIEWER_LOGIN}/${(parent[DATA] as Repo).name}`,
    owner: () => wrap('User', null),
    defaultBranchRef: (parent) => {
      const repo = parent[DATA] as Repo;
      return repo.headOid ? wrap('Ref', { name: repo.defaultBranch }) : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (parent, args) => {
      const repo = parent[DATA] as Repo;
      const number = typeof args.number === 'number' ? args.number : -1;
      const issue = repo.issues.find((entry) => entry.number === number);
      return issue ? issueObj(repo, issue) : null;
    },
    issues: (parent, args) => {
      const repo = parent[DATA] as Repo;
      const first = typeof args.first === 'number' ? args.first : undefined;
      const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      const desc = orderBy?.direction === 'DESC';
      let issues = [...repo.issues];
      if (states) {
        issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
      }
      issues.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
      if (after !== null) issues = issues.filter((issue) => (desc ? issue.number < after : issue.number > after));
      const page = first !== undefined ? issues.slice(0, first) : issues;
      const hasNextPage = first !== undefined ? issues.length > first : false;
      const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null;
      return wrap('IssueConnection', {
        nodes: page.map((issue) => issueObj(repo, issue)),
        pageInfo: wrap('PageInfo', { hasNextPage, endCursor }),
      });
    },
    pullRequests: (parent, args) => {
      const repo = parent[DATA] as Repo;
      const first = typeof args.first === 'number' ? args.first : undefined;
      const pulls = [...repo.pulls]
        .filter((pr) => pr.state === 'open')
        .sort((a, b) => b.number - a.number);
      const page = first !== undefined ? pulls.slice(0, first) : pulls;
      return wrap('PullRequestConnection', { nodes: page.map((pr) => pullObj(repo, pr)) });
    },
    pullRequest: (parent, args) => {
      const repo = parent[DATA] as Repo;
      const number = typeof args.number === 'number' ? args.number : -1;
      const pr = repo.pulls.find((entry) => entry.number === number);
      return pr ? pullObj(repo, pr) : null;
    },
  },
  User: {
    login: () => VIEWER_LOGIN,
  },
  Ref: {
    name: (parent) => (parent[DATA] as { name: string }).name,
  },
  Issue: {
    id: (parent) => {
      const { repo, issue } = parent[DATA] as { repo: Repo; issue: IssueRecord };
      return globalId('I', [VIEWER_LOGIN, repo.name, String(issue.number)]);
    },
    number: (parent) => (parent[DATA] as { issue: IssueRecord }).issue.number,
    title: (parent) => (parent[DATA] as { issue: IssueRecord }).issue.title,
    state: (parent) => ((parent[DATA] as { issue: IssueRecord }).issue.state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (parent) => (parent[DATA] as { issue: IssueRecord }).issue.body,
  },
  PullRequest: {
    id: (parent) => {
      const { repo, pr } = parent[DATA] as { repo: Repo; pr: PullRecord };
      return globalId('P', [VIEWER_LOGIN, repo.name, String(pr.number)]);
    },
    number: (parent) => (parent[DATA] as { pr: PullRecord }).pr.number,
    headRefName: (parent) => (parent[DATA] as { pr: PullRecord }).pr.head,
    baseRefName: (parent) => (parent[DATA] as { pr: PullRecord }).pr.base,
    mergeable: (parent) => {
      const { repo, pr } = parent[DATA] as { repo: Repo; pr: PullRecord };
      return computeMergeable(repo, pr);
    },
    state: (parent) => {
      const pr = (parent[DATA] as { pr: PullRecord }).pr;
      return pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (parent) => (parent[DATA] as { pr: PullRecord }).pr.merged,
    files: (parent, args) => {
      const { repo, pr } = parent[DATA] as { repo: Repo; pr: PullRecord };
      const first = typeof args.first === 'number' ? args.first : undefined;
      const headTip = repo.refs.get(`refs/heads/${pr.head}`);
      const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
      let paths: string[] = [];
      if (headTip && baseTip) {
        const baseOid = mergeBase(baseTip, headTip, repo.lookup);
        const baseFiles = baseOid ? filesAt(repo, baseOid) : new Map<string, FileEntry>();
        const headFiles = filesAt(repo, headTip);
        paths = diffFileMaps(baseFiles, headFiles).map((change) => change.path);
      }
      const page = first !== undefined ? paths.slice(0, first) : paths;
      return wrap('PullRequestFileConnection', {
        nodes: page.map((path) => wrap('PullRequestFile', { path })),
      });
    },
  },
  PullRequestFile: {
    path: (parent) => (parent[DATA] as { path: string }).path,
  },
  IssueConnection: {
    nodes: (parent) => (parent[DATA] as { nodes: Wrapped[] }).nodes,
    pageInfo: (parent) => (parent[DATA] as { pageInfo: Wrapped }).pageInfo,
  },
  PullRequestConnection: {
    nodes: (parent) => (parent[DATA] as { nodes: Wrapped[] }).nodes,
  },
  PullRequestFileConnection: {
    nodes: (parent) => (parent[DATA] as { nodes: Wrapped[] }).nodes,
  },
  PageInfo: {
    hasNextPage: (parent) => (parent[DATA] as { hasNextPage: boolean }).hasNextPage,
    endCursor: (parent) => (parent[DATA] as { endCursor: string | null }).endCursor,
  },
  __Type: {
    fields: (parent) => (parent[DATA] as { fields: string[] }).fields.map((name) => wrap('__Field', { name })),
    enumValues: (parent) => (parent[DATA] as { enumValues: string[] }).enumValues.map((name) => wrap('__EnumValue', { name })),
  },
  __Field: {
    name: (parent) => (parent[DATA] as { name: string }).name,
  },
  __EnumValue: {
    name: (parent) => (parent[DATA] as { name: string }).name,
  },
  CreateIssuePayload: {
    issue: (parent) => (parent[DATA] as { issue: Wrapped }).issue,
  },
  CloseIssuePayload: {
    issue: (parent) => (parent[DATA] as { issue: Wrapped }).issue,
  },
  CreatePullRequestPayload: {
    pullRequest: (parent) => (parent[DATA] as { pullRequest: Wrapped }).pullRequest,
  },
  MergePullRequestPayload: {
    pullRequest: (parent) => (parent[DATA] as { pullRequest: Wrapped }).pullRequest,
  },
  AddCommentPayload: {
    commentEdge: (parent) => (parent[DATA] as { commentEdge: Wrapped }).commentEdge,
  },
  IssueCommentEdge: {
    node: (parent) => (parent[DATA] as { node: Wrapped }).node,
  },
  IssueComment: {
    id: (parent) => (parent[DATA] as { id: string }).id,
    body: (parent) => (parent[DATA] as { body: string }).body,
  },
};

function resolveObject(
  object: Wrapped,
  selections: Selection[],
  ctx: ExecCtx,
): { data: Record<string, unknown>; errors: GqlError[] } {
  const data: Record<string, unknown> = {};
  const errors: GqlError[] = [];
  const type = object[TYPE] as string;
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== type) continue;
      const sub = resolveObject(object, selection.children, ctx);
      Object.assign(data, sub.data);
      errors.push(...sub.errors);
      continue;
    }
    const resolver = RESOLVERS[type]?.[selection.name];
    if (!resolver) {
      errors.push({ message: `Cannot query field "${selection.name}" on type "${type}".` });
      data[selection.alias] = null;
      continue;
    }
    const args = resolveArgs(selection.args, ctx.variables);
    let value: unknown;
    try {
      value = resolver(object, args, ctx);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err) });
      data[selection.alias] = null;
      continue;
    }
    if (value === undefined) value = null;
    if (selection.children.length > 0) {
      if (value === null) {
        data[selection.alias] = null;
      } else if (Array.isArray(value)) {
        const items: unknown[] = [];
        for (const item of value) {
          if (item !== null && typeof item === 'object' && TYPE in item) {
            const sub = resolveObject(item as Wrapped, selection.children, ctx);
            items.push(sub.data);
            errors.push(...sub.errors);
          } else {
            items.push(item);
          }
        }
        data[selection.alias] = items;
      } else if (typeof value === 'object' && TYPE in value) {
        const sub = resolveObject(value as Wrapped, selection.children, ctx);
        data[selection.alias] = sub.data;
        errors.push(...sub.errors);
      } else {
        errors.push({ message: `Field "${selection.name}" of type "${type}" must not have a sub selection.` });
        data[selection.alias] = null;
      }
    } else {
      data[selection.alias] = value;
    }
  }
  return { data, errors };
}

function executeOne(
  store: Store,
  document: Record<string, unknown>,
): Record<string, unknown> {
  const query = typeof document.query === 'string' ? document.query : '';
  const variables = (document.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof document.operationName === 'string' ? document.operationName : null;
  if (query === '') return { errors: [{ message: 'query is required' }] };
  let operations: Operation[];
  try {
    operations = parseDocument(query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let operation: Operation | undefined;
  if (operationName !== null) {
    operation = operations.find((candidate) => candidate.name === operationName);
    if (!operation) return { errors: [{ message: `unknown operation "${operationName}"` }] };
  } else if (operations.length === 1) {
    operation = operations[0];
  } else {
    return { errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }
  const ctx: ExecCtx = { store, variables };
  const root = wrap('Query', store);
  const { data, errors } = resolveObject(root, operation!.selections, ctx);
  if (errors.length > 0) return { data, errors };
  return { data };
}

/** POST /api/graphql — one operation document, or a JSON array of them. */
export function handleGraphQL(store: Store, body: unknown): { status: number; body: Buffer } {
  let result: unknown;
  if (Array.isArray(body)) {
    result = body.map((document) =>
      document !== null && typeof document === 'object' ? executeOne(store, document as Record<string, unknown>) : { errors: [{ message: 'invalid operation document' }] },
    );
  } else if (body !== null && typeof body === 'object') {
    result = executeOne(store, body as Record<string, unknown>);
  } else {
    result = { errors: [{ message: 'invalid request body' }] };
  }
  return { status: 200, body: Buffer.from(`${JSON.stringify(result)}\n`, 'utf8') };
}
