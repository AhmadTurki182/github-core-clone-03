// Git smart HTTP: info/refs advertisements, upload-pack (v2 ls-refs/fetch, v0
// fetch) and receive-pack (v0). Everything is in-process against the store's
// object map: no git binary, no subprocess, no shell. Packs are whole objects
// only (never deltas) and are cached per (repo, wants, haves, depth, shallow).

import {
  DEFAULT_BRANCH,
  ZERO_OID,
  collectAncestors,
  collectReachable,
  decodePktLines,
  encodePktLines,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  sideband,
  writePack,
  type GitObj,
  type Repo,
} from './store.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const names = [...repo.refs.keys()].sort();
  return names.map((name) => ({ name, oid: repo.refs.get(name)! }));
}

/** Peel a tag object to its commit, following nested tags. */
function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 8; i += 1) {
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

function refLinesV0(repo: Repo, caps: string): Buffer {
  const lines: (string | 'flush')[] = [];
  const refs = sortedRefs(repo);
  const headOid = repo.headOid;
  const firstCaps = (line: string): string => `${line}\0${caps}\n`;
  if (refs.length === 0) {
    lines.push(firstCaps(`${ZERO_OID} capabilities^{}`));
  } else {
    const headLine = headOid
      ? `${headOid} HEAD`
      : `${ZERO_OID} HEAD`;
    lines.push(firstCaps(headLine));
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const object = repo.objects.get(ref.oid);
      if (object?.type === 'tag') {
        const peeled = peelToCommit(repo, ref.oid);
        if (peeled) lines.push(`${peeled} ${ref.name}^{}\n`);
      }
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** The v0 advertisement for a service, with the service preamble first. */
export function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const preamble = `# service=${service}\n`;
  const caps =
    service === 'git-upload-pack'
      ? 'side-band-64k shallow symref=HEAD:refs/heads/main'
      : 'report-status side-band-64k delete-refs symref=HEAD:refs/heads/main';
  return Buffer.concat([encodePktLines([preamble, 'flush']), refLinesV0(repo, caps)]);
}

/** The v2 advertisement for upload-pack (receive-pack is v0-only). */
export function advertisementV2(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** GET /<owner>/<repo>.git/info/refs?service=... — v2 when Git-Protocol: version=2. */
export function handleInfoRefs(
  repo: Repo | undefined,
  service: string,
  gitProtocol: string | undefined,
): GitResponse {
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json', body: Buffer.from('{"message":"Not Found"}\n', 'utf8') };
  }
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: UPLOAD_AD, body: advertisementV2() };
    }
    return { status: 200, contentType: UPLOAD_AD, body: advertisementV0(repo, 'git-upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: RECEIVE_AD, body: advertisementV0(repo, 'git-receive-pack') };
  }
  return { status: 400, contentType: 'application/json', body: Buffer.from('{"message":"unknown service"}\n', 'utf8') };
}

// ---------------------------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------------------------

export interface LsRefsOptions {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function handleLsRefs(repo: Repo, options: LsRefsOptions): Buffer {
  const lines: (string | 'flush')[] = [];
  const refs = sortedRefs(repo);
  const headOid = repo.headOid;
  const keep = (name: string): boolean =>
    options.prefixes.length === 0 || options.prefixes.some((prefix) => name.startsWith(prefix));
  if (options.prefixes.length === 0) {
    if (headOid) {
      lines.push(
        options.symrefs
          ? `${headOid} HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n`
          : `${headOid} HEAD\n`,
      );
    } else if (options.unborn) {
      lines.push(`unborn HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n`);
    }
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (options.peel) {
      const object = repo.objects.get(ref.oid);
      if (object?.type === 'tag') {
        const peeled = peelToCommit(repo, ref.oid);
        if (peeled) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

// ---------------------------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

export interface FetchPlan {
  objects: GitObj[];
  shallow: string[];
  unshallow: string[];
}

/** All objects under a commit's tree (the tree objects and blobs), not its parents. */
function treeClosure(repo: Repo, treeOid: string): Set<string> {
  const out = new Set<string>();
  const walk = (oid: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree' || out.has(oid)) return;
    out.add(oid);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') walk(entry.oid);
      else if (entry.mode !== '160000') out.add(entry.oid);
    }
  };
  walk(treeOid);
  return out;
}

/**
 * The commits a client holds. A have contributes its full ancestry — unless it is a
 * shallow boundary, in which case the client holds only the boundary itself: a depth-1
 * clone's tip has no history behind it, and a deepen must be able to walk past it.
 */
function heldCommits(repo: Repo, haves: readonly string[], shallow: readonly string[]): Set<string> {
  const shallowSet = new Set(shallow);
  const held = new Set<string>();
  for (const have of haves) {
    if (shallowSet.has(have)) {
      held.add(have);
    } else {
      for (const oid of collectAncestors(have, repo.lookup)) held.add(oid);
    }
  }
  return held;
}

/** The objects a client already holds, with the same shallow-boundary rule as heldCommits. */
function heldObjects(repo: Repo, haves: readonly string[], shallow: readonly string[]): Set<string> {
  const shallowSet = new Set(shallow);
  const held = new Set<string>();
  const addBoundary = (oid: string): void => {
    const object = repo.objects.get(oid);
    if (!object) return;
    held.add(oid);
    if (object.type === 'commit') {
      for (const treeOid of treeClosure(repo, parseCommit(object.data).tree)) held.add(treeOid);
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject?.type === 'commit') {
        held.add(target);
        for (const treeOid of treeClosure(repo, parseCommit(targetObject.data).tree)) held.add(treeOid);
      }
    }
  };
  for (const have of haves) {
    if (shallowSet.has(have)) addBoundary(have);
    else for (const oid of collectReachable([have], repo.lookup, { allowMissing: true })) held.add(oid);
  }
  for (const boundary of shallow) addBoundary(boundary);
  return held;
}

/** The objects a fetch sends: each sent commit's own objects, never its parents' — so a depth-1 fetch carries the tip only, and a deepen carries exactly one more generation. */
function sendClosure(repo: Repo, sent: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const oid of sent) {
    const object = repo.objects.get(oid);
    if (!object) continue;
    out.add(oid);
    if (object.type === 'commit') {
      for (const treeOid of treeClosure(repo, parseCommit(object.data).tree)) out.add(treeOid);
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject?.type === 'tree') {
        for (const treeOid of treeClosure(repo, target)) out.add(treeOid);
      } else if (targetObject) {
        out.add(target);
      }
    }
  }
  return out;
}

function commitParents(repo: Repo, oid: string): string[] {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return [];
  return parseCommit(object.data).parents;
}

/**
 * Which objects a fetch sends. The walk starts at the wants, generation 0, and stops
 * at the depth boundary, at commits the client holds (their ancestry is held too),
 * and at shallow boundaries the client holds (whose parents it does not hold, so
 * the walk continues past them). The send set is the closure of the sent commits
 * minus what the client holds: an incremental fetch never re-sends a held object,
 * and a fetch with the tip held sends an empty pack.
 */
export function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const held = heldCommits(repo, request.haves, request.shallow);
  const shallowSet = new Set(request.shallow);
  const sent = new Set<string>();
  const boundary: string[] = [];
  // BFS by generation from the wants. A want that is a tag contributes its target commit.
  const queue: Array<{ oid: string; gen: number }> = [];
  const seen = new Set<string>();
  for (const want of request.wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      sent.add(want);
      const target = parseTag(object.data).object;
      if (repo.objects.get(target)?.type === 'commit') queue.push({ oid: target, gen: 0 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, gen: 0 });
    } else {
      sent.add(want);
    }
  }
  while (queue.length) {
    const { oid, gen } = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (request.depth !== null && gen >= request.depth) continue;
    if (held.has(oid) && !shallowSet.has(oid)) continue;
    if (!shallowSet.has(oid)) {
      sent.add(oid);
      if (request.depth !== null && gen === request.depth - 1) boundary.push(oid);
    }
    for (const parent of commitParents(repo, oid)) queue.push({ oid: parent, gen: gen + 1 });
  }
  // The unshallow lines: a boundary the client named whose parents are all present now.
  const present = new Set<string>([...sent, ...held, ...shallowSet]);
  const unshallow: string[] = [];
  for (const boundaryOid of request.shallow) {
    const parents = commitParents(repo, boundaryOid);
    if (parents.length > 0 && parents.every((parent) => present.has(parent))) unshallow.push(boundaryOid);
  }
  const heldObjs = heldObjects(repo, request.haves, request.shallow);
  const sendOids = sendClosure(repo, sent);
  // Deterministic order: sent commits first (walk order), then the rest.
  const order = new Map<string, number>();
  let index = 0;
  for (const oid of sent) order.set(oid, index++);
  const pairs: Array<{ oid: string; object: GitObj }> = [];
  for (const oid of sendOids) {
    if (heldObjs.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) pairs.push({ oid, object });
  }
  pairs.sort((a, b) => (order.get(a.oid) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.oid) ?? Number.MAX_SAFE_INTEGER));
  return { objects: pairs.map((pair) => pair.object), shallow: boundary, unshallow };
}

/** A fetch's pack and shallow lines, cached per (repo, wants, haves, depth, shallow). */
export function fetchPack(repo: Repo, request: FetchRequest): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const key = `${request.wants.join(',')}|${request.haves.join(',')}|${request.depth ?? ''}|${request.shallow.join(',')}`;
  const cached = repo.packCache.get(key);
  if (cached) return cached;
  const plan = planFetch(repo, request);
  const result = { pack: writePack(plan.objects), shallow: plan.shallow, unshallow: plan.unshallow };
  if (repo.packCache.size > 64) repo.packCache.clear();
  repo.packCache.set(key, result);
  return result;
}

// ---------------------------------------------------------------------------------------------
// upload-pack POST
// ---------------------------------------------------------------------------------------------

function parseV2Lines(body: Buffer): string[] {
  const lines: string[] = [];
  for (const packet of decodePktLines(body)) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

function parseFetchRequest(lines: readonly string[]): FetchRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const raw of lines) {
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0]!;
      if (isObjectId(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).split(' ')[0]!;
      if (isObjectId(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).split(' ')[0]!;
      if (isObjectId(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  return { wants, haves, shallow, depth };
}

/** POST /<owner>/<repo>.git/git-upload-pack — v2 ls-refs/fetch, or a v0 fetch. */
export function handleUploadPack(repo: Repo | undefined, body: Buffer): GitResponse {
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json', body: Buffer.from('{"message":"Not Found"}\n', 'utf8') };
  }
  let lines: string[];
  try {
    lines = parseV2Lines(body);
  } catch {
    return { status: 400, contentType: 'application/json', body: Buffer.from('{"message":"malformed pkt-line"}\n', 'utf8') };
  }
  const first = lines[0] ?? '';
  if (first.startsWith('command=')) {
    const command = first.slice('command='.length).replace(/\n$/, '');
    if (command === 'ls-refs') {
      const options = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
      for (const raw of lines.slice(1)) {
        const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
        if (line === 'peel') options.peel = true;
        else if (line === 'symrefs') options.symrefs = true;
        else if (line === 'unborn') options.unborn = true;
        else if (line.startsWith('ref-prefix ')) options.prefixes.push(line.slice('ref-prefix '.length));
      }
      return { status: 200, contentType: UPLOAD_RESULT, body: handleLsRefs(repo, options) };
    }
    if (command === 'fetch') {
      const request = parseFetchRequest(lines.slice(1));
      if (request.wants.length === 0) {
        return { status: 200, contentType: UPLOAD_RESULT, body: encodePktLines(['acknowledgments\n', 'NAK\n', 'flush']) };
      }
      const { pack, shallow, unshallow } = fetchPack(repo, request);
      const parts: (string | Buffer | 'flush')[] = ['acknowledgments\n', 'NAK\n', 'flush'];
      if (shallow.length > 0 || unshallow.length > 0) {
        parts.push('shallow-info\n');
        for (const oid of shallow) parts.push(`shallow ${oid}\n`);
        for (const oid of unshallow) parts.push(`unshallow ${oid}\n`);
        parts.push('flush');
      }
      parts.push('packfile\n');
      const head = encodePktLines(parts);
      return { status: 200, contentType: UPLOAD_RESULT, body: Buffer.concat([head, sideband(pack)]) };
    }
    return { status: 400, contentType: 'application/json', body: Buffer.from('{"message":"unknown command"}\n', 'utf8') };
  }
  // v0 fetch: want lines (the first may carry capabilities), shallow/deepen, flush,
  // have lines, done, flush. The response is NAK, shallow lines, then sideband pack.
  const request = parseFetchRequest(lines);
  if (request.wants.length === 0) {
    return { status: 200, contentType: UPLOAD_RESULT, body: Buffer.concat([encodePktLines(['NAK\n']), sideband(writePack([]))]) };
  }
  const { pack, shallow, unshallow } = fetchPack(repo, request);
  const headLines: string[] = ['NAK\n'];
  for (const oid of shallow) headLines.push(`shallow ${oid}\n`);
  for (const oid of unshallow) headLines.push(`unshallow ${oid}\n`);
  return {
    status: 200,
    contentType: UPLOAD_RESULT,
    body: Buffer.concat([encodePktLines(headLines), sideband(pack)]),
  };
}

// ---------------------------------------------------------------------------------------------
// receive-pack POST
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Split a receive-pack body at its first flush packet: commands before it, pack after it. */
function splitPushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer } | null {
  let offset = 0;
  const commands: PushCommand[] = [];
  while (offset + 4 <= body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return null;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      return { commands, pack: body.subarray(offset + 4) };
    }
    if (length < 4 || offset + length > body.length) return null;
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    const line = payload.endsWith('\n') ? payload.slice(0, -1) : payload;
    const nul = line.indexOf('\0');
    const command = nul >= 0 ? line.slice(0, nul) : line;
    const parts = command.split(' ');
    if (parts.length < 3) return null;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) return null;
    commands.push({ oldOid, newOid, ref });
    offset += length;
  }
  return null;
}

/** Is `descendant` a fast-forward of `ancestor` (the ancestor itself counts)? */
function isFastForward(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    for (const parent of commitParents(repo, oid)) queue.push(parent);
  }
  return false;
}

/** POST /<owner>/<repo>.git/git-receive-pack — unpack the pack, then apply each ref update. */
export function handleReceivePack(repo: Repo | undefined, body: Buffer): GitResponse {
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json', body: Buffer.from('{"message":"Not Found"}\n', 'utf8') };
  }
  const split = splitPushBody(body);
  if (split === null || split.commands.length === 0) {
    return { status: 400, contentType: 'application/json', body: Buffer.from('{"message":"malformed push"}\n', 'utf8') };
  }
  // Unpack first: a refused ref still unpacks its objects.
  let unpackError: string | null = null;
  if (split.pack.length > 0) {
    try {
      const objects = readPack(split.pack, repo.lookup);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
  } else {
    reportLines.push('unpack ok\n');
    // Evaluate every command against the pre-push refs, then apply the accepted ones.
    const current = new Map(repo.refs);
    const accepted: Array<{ ref: string; newOid: string | null }> = [];
    for (const command of split.commands) {
      const existing = current.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (existing !== undefined && existing === command.oldOid) {
          reportLines.push(`ok ${command.ref}\n`);
          accepted.push({ ref: command.ref, newOid: null });
        } else {
          reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        }
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (existing === undefined && repo.objects.has(command.newOid)) {
          reportLines.push(`ok ${command.ref}\n`);
          accepted.push({ ref: command.ref, newOid: command.newOid });
        } else if (existing !== undefined) {
          reportLines.push(`ng ${command.ref} already exists\n`);
        } else {
          reportLines.push(`ng ${command.ref} missing object\n`);
        }
      } else if (existing === command.oldOid && repo.objects.has(command.newOid) && isFastForward(repo, command.oldOid, command.newOid)) {
        reportLines.push(`ok ${command.ref}\n`);
        accepted.push({ ref: command.ref, newOid: command.newOid });
      } else {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      }
    }
    for (const update of accepted) {
      if (update.newOid === null) repo.refs.delete(update.ref);
      else repo.refs.set(update.ref, update.newOid);
    }
    if (accepted.length > 0) repo.packCache.clear();
  }
  const report = encodePktLines(reportLines);
  return { status: 200, contentType: RECEIVE_RESULT, body: sideband(report) };
}
