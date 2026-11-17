# github-core-clone-03

[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/AhmadTurki182/github-core-clone-03/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/AhmadTurki182/github-core-clone-03/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible forge built for the [github-core-clone-01](https://make.fun/bounty/github-core-clone-01)
bounty on make.fun: REST v3 repositories, branches, commits, contents, issues, comments, labels and
pull requests; GraphQL v4 as `gh` sends it; MCP over streamable HTTP; and git smart HTTP (protocol v2
upload-pack, v0 receive-pack) with packfile generation, shallow fetch and fast-forward enforcement.

## Run it

```sh
node --experimental-strip-types main.ts
```

No dependencies and nothing to install: the program imports `node:http`, `node:crypto`,
`node:zlib` and its own modules only. The platform runs `node /bot/main.ts` on Node 22.18 or
later, which strips TypeScript types on its own.

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | The entry ↔ env lifecycle: bind an ephemeral port, register it, wait for done |
| `app.ts` | The HTTP server: routing, auth, request ids, JSON bodies |
| `store.ts` | The in-memory forge: repositories, git objects, packs, pkt-lines |
| `git.ts` | Git smart HTTP: `info/refs`, upload-pack, receive-pack |
| `rest.ts` | REST v3: repos, branches, commits, contents, issues, pulls |
| `graphql.ts` | GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `mcp.ts` | MCP: `server/discover`, `tools/list`, `tools/call` |

## Design notes

- The hot paths are pre-computed: a single-issue GET serves a cached serialised body, and a
  fetch serves a cached pack per (repo, wants, haves, depth). Nothing on a timed path re-hashes,
  re-deflates or re-serialises work it already did.
- Every commit the forge creates uses a fixed timestamp and identity, and every counter advances
  in request order, so a replay of the same requests reaches the same state byte for byte.
- The viewer is the token owner. A repository name under any other owner is a 404, never a 403.
- All responses are `application/json` (git smart HTTP uses its own `application/x-git-*`
  content types) and carry a non-empty `x-github-request-id`.
