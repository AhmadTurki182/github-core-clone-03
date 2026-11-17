// MCP endpoint: JSON-RPC 2.0 over Streamable HTTP (plain JSON responses, never
// SSE). Modern era 2026-07-28 via `server/discover` first; legacy `initialize`
// is answered as insurance. Tools act on the same store as REST and GraphQL.

import { FIXED_ISO, VIEWER_ID, VIEWER_LOGIN, type IssueRecord, type PullRecord, type Repo, type Store } from './store.ts';
import { doMergePull, issueObject, repoJson } from './rest.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textResult(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError: false,
  };
}

function errorResult(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function missingArg(tool: string, arg: string): Record<string, unknown> {
  return errorResult(`Missing required argument: ${arg} for tool ${tool}`);
}

function getRepoOrError(store: Store, args: Record<string, unknown>): Repo | Record<string, unknown> {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  const repo = store.getRepo(owner, repoName);
  return repo ?? errorResult(`Repository not found: ${owner}/${repoName}`);
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      if (typeof args.name !== 'string' || args.name === '') return missingArg(name, 'name');
      const repo = store.createRepo(
        args.name,
        typeof args.private === 'boolean' ? args.private : false,
        typeof args.description === 'string' ? args.description : '',
      );
      if (repo === null) return errorResult(`Repository already exists: ${args.name}`);
      return textResult(repoJson(repo));
    }
    case 'get_repo': {
      if (typeof args.owner !== 'string') return missingArg(name, 'owner');
      if (typeof args.repo !== 'string') return missingArg(name, 'repo');
      const repo = getRepoOrError(store, args);
      if (!('refs' in repo)) return repo as Record<string, unknown>;
      return textResult(repoJson(repo as Repo));
    }
    case 'create_issue': {
      if (typeof args.owner !== 'string') return missingArg(name, 'owner');
      if (typeof args.repo !== 'string') return missingArg(name, 'repo');
      if (typeof args.title !== 'string' || args.title === '') return missingArg(name, 'title');
      const repo = getRepoOrError(store, args);
      if (!('refs' in repo)) return repo as Record<string, unknown>;
      const target = repo as Repo;
      const issue: IssueRecord = {
        id: store.nextIssueId,
        number: target.nextIssue,
        title: args.title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        json: null,
      };
      store.nextIssueId += 1;
      target.nextIssue += 1;
      target.issues.push(issue);
      return textResult(issueObject(target, issue));
    }
    case 'list_issues': {
      if (typeof args.owner !== 'string') return missingArg(name, 'owner');
      if (typeof args.repo !== 'string') return missingArg(name, 'repo');
      const repo = getRepoOrError(store, args);
      if (!('refs' in repo)) return repo as Record<string, unknown>;
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...(repo as Repo).issues]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.number - a.number)
        .map((issue) => issueObject(repo as Repo, issue));
      return textResult({ issues });
    }
    case 'create_pull_request': {
      if (typeof args.owner !== 'string') return missingArg(name, 'owner');
      if (typeof args.repo !== 'string') return missingArg(name, 'repo');
      if (typeof args.title !== 'string' || args.title === '') return missingArg(name, 'title');
      if (typeof args.head !== 'string' || args.head === '') return missingArg(name, 'head');
      if (typeof args.base !== 'string' || args.base === '') return missingArg(name, 'base');
      const repo = getRepoOrError(store, args);
      if (!('refs' in repo)) return repo as Record<string, unknown>;
      const target = repo as Repo;
      const headOid = target.refs.get(`refs/heads/${args.head}`);
      const baseOid = target.refs.get(`refs/heads/${args.base}`);
      if (!headOid || !baseOid) return errorResult('head or base branch does not exist');
      for (const pr of target.pulls) {
        if (pr.state === 'open' && pr.head === args.head && pr.base === args.base) {
          return errorResult('A pull request already exists for these branches');
        }
      }
      const pr: PullRecord = {
        id: store.nextPullId,
        number: target.nextPull,
        title: args.title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        head: args.head,
        base: args.base,
        headSha: headOid,
        baseSha: baseOid,
        merged: false,
        mergedAt: null,
        mergeSha: null,
      };
      store.nextPullId += 1;
      target.nextPull += 1;
      target.pulls.push(pr);
      return textResult({
        id: pr.id,
        number: pr.number,
        state: pr.state,
        title: pr.title,
        body: pr.body,
        head: { ref: pr.head, sha: headOid, label: `${VIEWER_LOGIN}:${pr.head}` },
        base: { ref: pr.base, sha: baseOid, label: `${VIEWER_LOGIN}:${pr.base}` },
        merged: false,
        user: { login: VIEWER_LOGIN, id: VIEWER_ID },
        created_at: FIXED_ISO,
      });
    }
    case 'merge_pull_request': {
      if (typeof args.owner !== 'string') return missingArg(name, 'owner');
      if (typeof args.repo !== 'string') return missingArg(name, 'repo');
      if (typeof args.pull_number !== 'number') return missingArg(name, 'pull_number');
      const repo = getRepoOrError(store, args);
      if (!('refs' in repo)) return repo as Record<string, unknown>;
      const target = repo as Repo;
      const pr = target.pulls.find((entry) => entry.number === args.pull_number);
      if (!pr) return errorResult(`Pull request not found: #${args.pull_number}`);
      if (pr.merged) return textResult({ merged: true, sha: pr.mergeSha, number: pr.number, state: pr.state });
      if (pr.state !== 'open') return errorResult('Pull request is not open');
      let sha: string | null;
      try {
        sha = doMergePull(target, pr);
      } catch {
        return errorResult('head or base branch does not exist');
      }
      if (sha === null) return errorResult('This branch has conflicts that must be resolved');
      pr.merged = true;
      pr.state = 'closed';
      pr.mergedAt = FIXED_ISO;
      pr.mergeSha = sha;
      return textResult({ merged: true, sha, number: pr.number, state: pr.state });
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

/** POST /mcp — one JSON-RPC 2.0 request. Returns the HTTP status and body. */
export function handleMcp(store: Store, rawBody: Buffer): { status: number; body: Buffer } {
  let request: unknown;
  try {
    request = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), 'utf8'),
    };
  }
  if (!isRecord(request) || typeof request.method !== 'string') {
    return {
      status: 400,
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }), 'utf8'),
    };
  }
  const id = 'id' in request ? request.id : undefined;
  // Notifications (no id) are answered 202 with an empty body.
  if (id === undefined) return { status: 202, body: Buffer.alloc(0) };
  const method = request.method;
  const params = isRecord(request.params) ? request.params : {};
  let result: unknown;
  if (method === 'server/discover') {
    result = {
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    };
  } else if (method === 'initialize') {
    result = {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    };
  } else if (method === 'ping') {
    result = {};
  } else if (method === 'tools/list') {
    result = { tools: TOOLS };
  } else if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const toolArgs = isRecord(params.arguments) ? params.arguments : {};
    if (!TOOLS.some((tool) => tool.name === toolName)) {
      return {
        status: 200,
        body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${toolName}` } }), 'utf8'),
      };
    }
    result = callTool(store, toolName, toolArgs);
  } else {
    return {
      status: 200,
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }), 'utf8'),
    };
  }
  return { status: 200, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }), 'utf8') };
}
