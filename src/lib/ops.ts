/**
 * Pure graph operations. Each takes a GraphData and returns a new one
 * (structural sharing: only touched objects are copied), so the store can
 * keep cheap snapshots for undo/redo.
 */
import type { GraphData, KLink, KNode, Proposal, PruneOp } from '../types';
import { buildIndex, childrenOf, descendants, isSelfOrDescendant, makeLink, makeNode, nextOrder, normalizeTitle, uid } from './tree';

export function addNode(data: GraphData, node: KNode): GraphData {
  return { ...data, nodes: { ...data.nodes, [node.id]: node } };
}

export function updateNode(data: GraphData, id: string, patch: Partial<KNode>): GraphData {
  const n = data.nodes[id];
  if (!n) return data;
  return { ...data, nodes: { ...data.nodes, [id]: { ...n, ...patch, id, updatedAt: Date.now() } } };
}

/**
 * Delete a node. `subtree` removes all descendants too; `lift` re-attaches
 * the children to the deleted node's parent (keeping their order).
 */
export function deleteNode(data: GraphData, id: string, mode: 'subtree' | 'lift'): GraphData {
  const n = data.nodes[id];
  if (!n) return data;
  const index = buildIndex(data.nodes);
  const nodes = { ...data.nodes };
  const removed = new Set<string>([id]);
  if (mode === 'subtree') {
    for (const d of descendants(index, id)) removed.add(d);
  } else {
    const kids = childrenOf(index, id);
    const siblings = childrenOf(index, n.parentId);
    const pos = siblings.indexOf(id);
    // Re-number so the lifted children take the deleted node's slot.
    const ordered = [...siblings.slice(0, pos), ...kids, ...siblings.slice(pos + 1)];
    ordered.forEach((sid, i) => {
      const cur = nodes[sid];
      nodes[sid] = { ...cur, parentId: n.parentId, order: i + 1 };
    });
  }
  for (const r of removed) delete nodes[r];
  const links: Record<string, KLink> = {};
  for (const l of Object.values(data.links)) {
    if (!removed.has(l.source) && !removed.has(l.target)) links[l.id] = l;
  }
  return { nodes, links };
}

/**
 * Move `id` under `newParent` (null = root). If `beforeId` is given the node
 * is placed right before that sibling, otherwise at the end.
 * Moving a node into its own subtree is rejected (returns data unchanged).
 */
export function moveNode(data: GraphData, id: string, newParent: string | null, beforeId?: string | null): GraphData {
  const n = data.nodes[id];
  if (!n) return data;
  if (newParent && (!data.nodes[newParent] || isSelfOrDescendant(data.nodes, id, newParent))) return data;
  const index = buildIndex(data.nodes);
  const siblings = childrenOf(index, newParent).filter((s) => s !== id);
  let pos = beforeId ? siblings.indexOf(beforeId) : -1;
  if (pos < 0) pos = siblings.length;
  siblings.splice(pos, 0, id);
  const nodes = { ...data.nodes };
  siblings.forEach((sid, i) => {
    const cur = nodes[sid];
    if (sid === id) nodes[sid] = { ...cur, parentId: newParent, order: i + 1, updatedAt: Date.now() };
    else if (cur.order !== i + 1) nodes[sid] = { ...cur, order: i + 1 };
  });
  return { ...data, nodes };
}

export function addLink(data: GraphData, source: string, target: string, label = ''): { data: GraphData; link: KLink | null } {
  if (source === target || !data.nodes[source] || !data.nodes[target]) return { data, link: null };
  const dup = Object.values(data.links).find(
    (l) => l.source === source && l.target === target && l.label.trim().toLowerCase() === label.trim().toLowerCase(),
  );
  if (dup) return { data, link: dup };
  const link = makeLink(source, target, label.trim());
  return { data: { ...data, links: { ...data.links, [link.id]: link } }, link };
}

export function updateLink(data: GraphData, id: string, patch: Partial<KLink>): GraphData {
  const l = data.links[id];
  if (!l) return data;
  return { ...data, links: { ...data.links, [id]: { ...l, ...patch, id } } };
}

export function removeLink(data: GraphData, id: string): GraphData {
  if (!data.links[id]) return data;
  const links = { ...data.links };
  delete links[id];
  return { ...data, links };
}

function appendContent(base: string, extra: string, heading?: string): string {
  const e = extra.trim();
  if (!e) return base;
  if (!base.trim()) return e;
  if (base.includes(e)) return base;
  return `${base.trimEnd()}\n\n${heading ? `### ${heading}\n\n` : ''}${e}`;
}

/** Merge `sourceId` into `targetId`: content, tags, sources, children and links move over. */
export function mergeNodes(data: GraphData, sourceId: string, targetId: string): GraphData {
  const s = data.nodes[sourceId];
  const t = data.nodes[targetId];
  if (!s || !t || sourceId === targetId) return data;
  // Merging a node into its own descendant would orphan the target: lift instead.
  if (isSelfOrDescendant(data.nodes, sourceId, targetId)) {
    data = moveNode(data, targetId, s.parentId, sourceId);
  }
  const index = buildIndex(data.nodes);
  const nodes = { ...data.nodes };
  let order = nextOrder(nodes, index, targetId);
  for (const c of childrenOf(index, sourceId)) {
    if (c === targetId) continue;
    nodes[c] = { ...nodes[c], parentId: targetId, order: order++ };
  }
  nodes[targetId] = {
    ...t,
    content: appendContent(t.content, s.content, s.title !== t.title ? `From “${s.title}”` : undefined),
    tags: Array.from(new Set([...t.tags, ...s.tags])),
    sources: Array.from(new Set([...t.sources, ...s.sources])),
    icon: t.icon ?? s.icon,
    updatedAt: Date.now(),
  };
  delete nodes[sourceId];
  const links: Record<string, KLink> = {};
  const seen = new Set<string>();
  for (const l of Object.values(data.links)) {
    const source = l.source === sourceId ? targetId : l.source;
    const target = l.target === sourceId ? targetId : l.target;
    if (source === target) continue;
    const key = `${source}>${target}>${l.label.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links[l.id] = source === l.source && target === l.target ? l : { ...l, source, target };
  }
  return { nodes, links };
}

export interface ApplyResult {
  data: GraphData;
  created: string[];
  updated: string[];
  linksAdded: number;
}

/** Commit the accepted parts of a pipeline proposal into the graph. */
export function applyProposal(data: GraphData, proposal: Proposal): ApplyResult {
  const accepted = proposal.nodes.filter((n) => n.accepted);
  const refToId = new Map<string, string>();
  const created: string[] = [];
  const updated: string[] = [];
  let nodes = { ...data.nodes };

  // Merges first: they resolve refs to existing ids.
  for (const p of accepted) {
    if (p.mergeInto && nodes[p.mergeInto]) {
      refToId.set(p.ref, p.mergeInto);
      const t = nodes[p.mergeInto];
      nodes[p.mergeInto] = {
        ...t,
        content: appendContent(t.content, p.content),
        tags: Array.from(new Set([...t.tags, ...p.tags])),
        sources: Array.from(new Set([...t.sources, ...proposal.sources])),
        updatedAt: Date.now(),
      };
      updated.push(p.mergeInto);
    }
  }
  const fresh = accepted.filter((p) => !(p.mergeInto && data.nodes[p.mergeInto]));
  for (const p of fresh) refToId.set(p.ref, uid());

  const resolve = (ref: string | null): string | null => {
    if (!ref) return null;
    if (refToId.has(ref)) return refToId.get(ref)!;
    if (nodes[ref]) return ref;
    return null;
  };

  // Create in an order where parents come before children.
  const pending = new Map(fresh.map((p) => [p.ref, p]));
  const orderCounter = new Map<string, number>();
  const index = buildIndex(nodes);
  const nextFor = (parent: string | null) => {
    const key = parent ?? '';
    const v = orderCounter.get(key) ?? nextOrder(nodes, index, parent);
    orderCounter.set(key, v + 1);
    return v;
  };
  let guard = 0;
  while (pending.size && guard++ < 10000) {
    let progressed = false;
    for (const [ref, p] of pending) {
      const parentIsPending = p.parent && pending.has(p.parent) && p.parent !== ref;
      if (parentIsPending) continue;
      const id = refToId.get(ref)!;
      const parentId = p.parent === ref ? null : resolve(p.parent);
      nodes[id] = makeNode({
        id,
        title: p.title.trim() || 'Untitled',
        parentId,
        order: nextFor(parentId),
        content: p.content,
        tags: p.tags,
        sources: proposal.sources,
      });
      created.push(id);
      pending.delete(ref);
      progressed = true;
    }
    if (!progressed) {
      // Cycle among proposed parents: break it by making one a root.
      const [ref, p] = pending.entries().next().value!;
      pending.set(ref, { ...p, parent: null });
    }
  }

  let next: GraphData = { nodes, links: { ...data.links } };
  let linksAdded = 0;
  for (const l of proposal.links) {
    if (!l.accepted) continue;
    const s = resolve(l.source);
    const t = resolve(l.target);
    if (!s || !t || s === t) continue;
    const r = addLink(next, s, t, l.label);
    if (r.link && !data.links[r.link.id]) linksAdded++;
    next = r.data;
  }
  return { data: next, created, updated, linksAdded };
}

/** Apply accepted prune / reorganisation operations, skipping any that became invalid. */
export function applyPruneOps(data: GraphData, ops: PruneOp[]): { data: GraphData; applied: number; createdGroups: string[] } {
  let applied = 0;
  const createdGroups: string[] = [];
  for (const op of ops) {
    if (!op.accepted) continue;
    const before = data;
    switch (op.kind) {
      case 'merge':
        if (data.nodes[op.node] && data.nodes[op.target]) data = mergeNodes(data, op.node, op.target);
        break;
      case 'move':
        if (data.nodes[op.node] && (op.target === '' || data.nodes[op.target])) data = moveNode(data, op.node, op.target || null);
        break;
      case 'delete':
        if (data.nodes[op.node]) data = deleteNode(data, op.node, 'lift');
        break;
      case 'rename':
        if (data.nodes[op.node] && op.target.trim()) data = updateNode(data, op.node, { title: op.target.trim() });
        break;
      case 'group': {
        const parent = op.node === '' ? null : op.node;
        if (parent && !data.nodes[parent]) break;
        const members = (op.members ?? []).filter((m) => data.nodes[m] && (!parent || !isSelfOrDescendant(data.nodes, m, parent)));
        if (!members.length || !op.target.trim()) break;
        const index = buildIndex(data.nodes);
        const group = makeNode({ title: op.target.trim(), parentId: parent, order: nextOrder(data.nodes, index, parent) });
        data = addNode(data, group);
        for (const m of members) data = moveNode(data, m, group.id);
        createdGroups.push(group.id);
        break;
      }
    }
    if (data !== before) applied++;
  }
  return { data, applied, createdGroups };
}

/**
 * Merge another workspace into this one. Incoming ids that collide get fresh
 * ids; nodes whose title already exists at the same place are merged.
 */
export function mergeWorkspaces(data: GraphData, incoming: GraphData): GraphData {
  const remap = new Map<string, string>();
  for (const id of Object.keys(incoming.nodes)) remap.set(id, data.nodes[id] ? uid() : id);
  const nodes = { ...data.nodes };
  const index = buildIndex(data.nodes);
  const rootOrder = nextOrder(data.nodes, index, null);
  for (const n of Object.values(incoming.nodes)) {
    const id = remap.get(n.id)!;
    const parentId = n.parentId ? (remap.get(n.parentId) ?? null) : null;
    nodes[id] = { ...n, id, parentId, order: parentId ? n.order : rootOrder + n.order / 1e6 };
  }
  const links = { ...data.links };
  for (const l of Object.values(incoming.links)) {
    const s = remap.get(l.source);
    const t = remap.get(l.target);
    if (!s || !t) continue;
    const id = data.links[l.id] ? uid('l') : l.id;
    links[id] = { ...l, id, source: s, target: t };
  }
  return { nodes, links };
}

/** Basic structural validation / repair of loaded data. */
export function sanitizeData(raw: unknown): GraphData {
  const obj = (raw ?? {}) as Partial<GraphData>;
  const nodes: Record<string, KNode> = {};
  const inNodes = obj.nodes && typeof obj.nodes === 'object' ? obj.nodes : {};
  const list = Array.isArray(inNodes) ? (inNodes as KNode[]) : Object.values(inNodes);
  for (const n of list) {
    if (!n || typeof n !== 'object' || typeof n.id !== 'string') continue;
    nodes[n.id] = makeNode({
      ...n,
      title: typeof n.title === 'string' && n.title.trim() ? n.title : 'Untitled',
      content: typeof n.content === 'string' ? n.content : '',
      tags: Array.isArray(n.tags) ? n.tags.filter((t) => typeof t === 'string') : [],
      sources: Array.isArray(n.sources) ? n.sources.filter((t) => typeof t === 'string') : [],
      parentId: typeof n.parentId === 'string' ? n.parentId : null,
      order: typeof n.order === 'number' && isFinite(n.order) ? n.order : 0,
    });
  }
  for (const n of Object.values(nodes)) if (n.parentId && !nodes[n.parentId]) n.parentId = null;
  const links: Record<string, KLink> = {};
  const inLinks = obj.links && typeof obj.links === 'object' ? obj.links : {};
  const llist = Array.isArray(inLinks) ? (inLinks as KLink[]) : Object.values(inLinks);
  for (const l of llist) {
    if (!l || !nodes[l.source] || !nodes[l.target] || l.source === l.target) continue;
    const id = typeof l.id === 'string' ? l.id : uid('l');
    links[id] = { id, source: l.source, target: l.target, label: typeof l.label === 'string' ? l.label : '', createdAt: l.createdAt ?? Date.now() };
  }
  return { nodes, links };
}

/** Find an existing node by (normalised) title, preferring one under `parentId`. */
export function findByTitle(data: GraphData, title: string, parentId?: string | null): string | null {
  const k = normalizeTitle(title);
  let fallback: string | null = null;
  for (const n of Object.values(data.nodes)) {
    if (normalizeTitle(n.title) !== k) continue;
    if (parentId === undefined || n.parentId === parentId) return n.id;
    fallback ??= n.id;
  }
  return fallback;
}
