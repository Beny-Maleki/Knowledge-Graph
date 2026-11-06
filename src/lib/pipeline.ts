/**
 * The knowledge pipeline: digest source material, expand a node, draft a
 * page, or review a branch. Every AI step returns a *proposal* the user
 * reviews before anything touches the graph.
 */
import type { GraphData, Proposal, ProposedLink, ProposedNode, PruneOp, PruneOpKind } from '../types';
import { generateJSON, generateText, type GenOptions } from './llm';
import { ancestors, buildIndex, childrenOf, excerpt, isSelfOrDescendant, normalizeTitle, pathTitles, truncate } from './tree';

export type Granularity = 'coarse' | 'medium' | 'fine';

/* ---------------- outline serialisation ---------------- */

/**
 * Compact indented outline of the forest, `- [id] Title`, for the model.
 * When the graph is large, the `scope` branch is kept in full and the rest
 * is trimmed to the shallowest levels that fit in `maxNodes`.
 */
export function serializeOutline(data: GraphData, opts: { scope?: string | null; maxNodes?: number; snippets?: boolean } = {}): string {
  const max = opts.maxNodes ?? 600;
  const index = buildIndex(data.nodes);
  const include = new Set<string>();
  if (opts.scope && data.nodes[opts.scope]) {
    for (const a of ancestors(data.nodes, opts.scope)) include.add(a);
    const stack = [opts.scope];
    while (stack.length && include.size < max) {
      const id = stack.shift()!;
      include.add(id);
      stack.push(...childrenOf(index, id));
    }
  }
  const queue = [...index.roots];
  while (queue.length && include.size < max) {
    const id = queue.shift()!;
    include.add(id);
    queue.push(...childrenOf(index, id));
  }
  const lines: string[] = [];
  const walk = (id: string, depth: number) => {
    const n = data.nodes[id];
    const kids = childrenOf(index, id);
    const shown = kids.filter((k) => include.has(k));
    const hidden = kids.length - shown.length;
    let line = `${'  '.repeat(depth)}- [${id}] ${n.title}`;
    if (hidden > 0) line += `  (+${hidden} more sub-pages not shown)`;
    if (opts.snippets && n.content.trim()) line += ` — ${excerpt(n.content, 90)}`;
    lines.push(line);
    for (const k of shown) walk(k, depth + 1);
  };
  for (const r of index.roots) if (include.has(r)) walk(r, 0);
  return lines.join('\n') || '(the knowledge base is empty)';
}

/* ---------------- schemas ---------------- */

const PROPOSAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'nodes', 'links'],
  properties: {
    summary: { type: 'string', description: 'One or two sentences describing what was extracted and where it was placed.' },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'title', 'parent', 'merge_into', 'content', 'tags'],
        properties: {
          ref: { type: 'string', description: 'Temporary unique reference for a NEW node, e.g. "r1".' },
          title: { type: 'string' },
          parent: { type: 'string', description: 'Existing node id, the ref of another new node, or "" for a new top-level root.' },
          merge_into: { type: 'string', description: 'Existing node id when this is new information about an existing node, else "".' },
          content: { type: 'string', description: 'Markdown note body.' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    links: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source', 'target', 'label'],
        properties: {
          source: { type: 'string' },
          target: { type: 'string' },
          label: { type: 'string' },
        },
      },
    },
  },
} as const;

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'ops'],
  properties: {
    summary: { type: 'string' },
    ops: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'node', 'target', 'members', 'reason'],
        properties: {
          kind: { type: 'string', enum: ['merge', 'move', 'delete', 'rename', 'group'] },
          node: { type: 'string' },
          target: { type: 'string' },
          members: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const;

interface RawProposal {
  summary?: string;
  nodes?: { ref?: string; title?: string; parent?: string; merge_into?: string; content?: string; tags?: string[] }[];
  links?: { source?: string; target?: string; label?: string }[];
}

/* ---------------- prompts ---------------- */

const CURATOR = `You are a meticulous knowledge-graph curator. You help a learner organise what they learn into a hierarchical knowledge base: a forest of trees whose nodes are pages (concepts, ideas, methods, facts, people, events…). General topics sit near the roots; specific ideas sit deeper. Pages can also be connected by free-form, labelled relations that cut across the hierarchy.

Principles:
- One node = one coherent idea. Titles are short noun phrases (1–6 words), in Title Case, without numbering or trailing punctuation.
- Build real hierarchy: when 3+ sibling ideas share a theme, introduce an intermediate grouping node. Avoid both flat lists of 20 siblings and chains of single children.
- Reuse the existing structure. Place new nodes under the most specific existing node that fits (use its id). Never create a node whose title duplicates an existing node: set merge_into to that node's id instead and put only the NEW information in content.
- Notes (content) are Markdown: crisp definitions, key points as bullets, formulas in LaTeX ($…$ inline, $$…$$ display), short examples. Typically 40–200 words. Do not repeat the title as a heading. Mention other pages with [[Exact Title]] wiki links where natural.
- Relations (links) capture meaningful non-hierarchical connections (never parent/child) between any two nodes, new or existing. Labels are short lower-case verb phrases from the source's point of view, e.g. "uses", "is a special case of", "contrasts with", "causes", "depends on", "is evidence for", "was influenced by".
- Stay faithful to the source material. Don't invent facts; you may add a brief clarifying sentence of widely known background when it helps understanding.
- Write in the same language as the source material.`;

const GRANULARITY: Record<Granularity, string> = {
  coarse: 'Aim for roughly 4–10 nodes: only the main ideas, with richer notes.',
  medium: 'Aim for roughly 10–25 nodes: main ideas plus their important sub-ideas.',
  fine: 'Aim for roughly 25–60 nodes: a detailed breakdown down to individual definitions, methods and examples.',
};

export interface DigestInput {
  text: string;
  sourceName: string;
  /** Restrict placement to this branch (null = anywhere / auto). */
  scope: string | null;
  granularity: Granularity;
  instructions: string;
}

export async function digest(data: GraphData, input: DigestInput, gen: Pick<GenOptions, 'signal' | 'onProgress'>): Promise<Proposal> {
  const outline = serializeOutline(data, { scope: input.scope });
  const scopeLine = input.scope
    ? `Place everything inside the branch rooted at [${input.scope}] “${data.nodes[input.scope]?.title}” (use that id or its descendants as parents; never ""). `
    : 'Place nodes wherever they fit best in the existing forest; use parent "" only for material that belongs to none of the existing trees (it becomes a new root). ';
  const prompt = `## Existing knowledge base
${outline}

## Task
Digest the source material below into knowledge nodes and relations. ${scopeLine}${GRANULARITY[input.granularity]}
Use refs "r1", "r2", … for new nodes; a new node's parent may be an existing id or another new node's ref. Relations may connect any ids/refs.${input.instructions.trim() ? `\n\nThe learner adds: ${input.instructions.trim()}` : ''}

## Source material${input.sourceName ? ` — ${input.sourceName}` : ''}
<source>
${input.text}
</source>`;
  const raw = await generateJSON<RawProposal>({ system: CURATOR, prompt, schema: PROPOSAL_SCHEMA as unknown as Record<string, unknown>, ...gen });
  return normalizeProposal(raw, data, { defaultParent: input.scope, scope: input.scope, sources: input.sourceName ? [input.sourceName] : [] });
}

export interface ExpandInput {
  nodeId: string;
  count: number;
  depth: 1 | 2;
  instructions: string;
  withLinks: boolean;
}

export async function expand(data: GraphData, input: ExpandInput, gen: Pick<GenOptions, 'signal' | 'onProgress'>): Promise<Proposal> {
  const n = data.nodes[input.nodeId];
  const index = buildIndex(data.nodes);
  const kids = childrenOf(index, input.nodeId).map((k) => data.nodes[k].title);
  const outline = serializeOutline(data, { scope: input.nodeId, maxNodes: 400 });
  const prompt = `## Existing knowledge base
${outline}

## The page to expand
[${n.id}] ${pathTitles(data.nodes, n.id).join(' › ')}
${n.content.trim() ? `Current notes:\n<notes>\n${truncate(n.content, 6000)}\n</notes>` : '(no notes yet)'}
${kids.length ? `Existing sub-pages (do not duplicate): ${kids.join('; ')}` : 'It has no sub-pages yet.'}

## Task
Propose about ${input.count} new sub-topics that break “${n.title}” down into its most important components for a learner${input.depth === 2 ? ', and for the richest of them, 2–4 sub-sub-topics each' : ''}. Each gets a concise explanatory note.
Top-level proposals must use parent "${n.id}"; deeper ones use the ref of their new parent. Use refs "r1", "r2", …. Use merge_into only if a proposed idea already exists elsewhere in the knowledge base.
${input.withLinks ? 'Also propose relations between the new nodes and EXISTING nodes elsewhere in the knowledge base where there is a meaningful connection (not the parent).' : 'Do not propose relations to other existing nodes.'}${input.instructions.trim() ? `\n\nThe learner adds: ${input.instructions.trim()}` : ''}`;
  const raw = await generateJSON<RawProposal>({ system: CURATOR, prompt, schema: PROPOSAL_SCHEMA as unknown as Record<string, unknown>, ...gen });
  return normalizeProposal(raw, data, { defaultParent: input.nodeId, scope: input.nodeId, sources: [] });
}

export async function draftPage(data: GraphData, nodeId: string, instructions: string, gen: Pick<GenOptions, 'signal' | 'onProgress'>): Promise<string> {
  const n = data.nodes[nodeId];
  const index = buildIndex(data.nodes);
  const kids = childrenOf(index, nodeId).map((k) => data.nodes[k].title);
  const siblings = childrenOf(index, n.parentId)
    .filter((s) => s !== nodeId)
    .map((s) => data.nodes[s].title);
  const linked = Object.values(data.links)
    .filter((l) => l.source === nodeId || l.target === nodeId)
    .map((l) => (l.source === nodeId ? `${n.title} —${l.label || 'related to'}→ ${data.nodes[l.target]?.title}` : `${data.nodes[l.source]?.title} —${l.label || 'related to'}→ ${n.title}`));
  const prompt = `Write the page “${n.title}” for a personal knowledge base.

Location: ${pathTitles(data.nodes, nodeId).join(' › ')}
${kids.length ? `Its sub-pages (each has its own page; summarise and link them with [[Title]], don't re-explain them in depth): ${kids.join('; ')}` : ''}
${siblings.length ? `Sibling pages: ${siblings.slice(0, 30).join('; ')}` : ''}
${linked.length ? `Relations: ${linked.join('; ')}` : ''}
${n.content.trim() ? `Existing notes to improve and integrate (keep the learner's own points):\n<notes>\n${truncate(n.content, 8000)}\n</notes>` : ''}
${instructions.trim() ? `The learner asks: ${instructions.trim()}` : ''}

Return only the Markdown body (no title heading, no code fences around the whole answer). Keep it focused: a clear definition first, then the key ideas, a formula or example where useful. 120–350 words.`;
  return generateText({ system: CURATOR, prompt, maxTokens: 16000, ...gen });
}

export async function reviewBranch(
  data: GraphData,
  scope: string | null,
  instructions: string,
  gen: Pick<GenOptions, 'signal' | 'onProgress'>,
): Promise<{ summary: string; ops: PruneOp[] }> {
  const outline = serializeOutline(data, { scope, maxNodes: 500, snippets: true });
  const prompt = `## Knowledge base (ids in brackets, with note excerpts)
${outline}

## Task
Review ${scope ? `the branch [${scope}] “${data.nodes[scope]?.title}”` : 'the whole knowledge base'} and propose a SMALL set (at most ~15) of high-value clean-up operations:
- "merge": node is a duplicate / near-duplicate of target (an existing id) → node is merged into target.
- "move": node is misplaced → target is the id of its better parent ("" = top level).
- "delete": node is empty or trivial AND redundant (has no meaningful notes). Its children are kept.
- "rename": target is a clearer title.
- "group": node is the parent id ("" = top level) under which a new grouping page titled target is created; members are the ids of existing children of that parent to move into it. Use this to tame long flat lists.
Use members only for "group" (empty array otherwise). Give each op a one-sentence reason. Prefer fewer, clearly beneficial changes; return an empty list if the structure is already good.${instructions.trim() ? `\n\nThe learner adds: ${instructions.trim()}` : ''}`;
  const raw = await generateJSON<{ summary?: string; ops?: { kind?: string; node?: string; target?: string; members?: string[]; reason?: string }[] }>({
    system: CURATOR,
    prompt,
    schema: REVIEW_SCHEMA as unknown as Record<string, unknown>,
    ...gen,
  });
  const kinds: PruneOpKind[] = ['merge', 'move', 'delete', 'rename', 'group'];
  const ops: PruneOp[] = [];
  for (const o of raw.ops ?? []) {
    const kind = o.kind as PruneOpKind;
    if (!kinds.includes(kind)) continue;
    const node = String(o.node ?? '').trim();
    const target = String(o.target ?? '').trim();
    const members = (o.members ?? []).filter((m) => data.nodes[m]);
    if (kind === 'group') {
      if (node && !data.nodes[node]) continue;
      if (!target || members.length < 2) continue;
    } else {
      if (!data.nodes[node]) continue;
      if (kind === 'merge' && (!data.nodes[target] || target === node)) continue;
      if (kind === 'move' && target && (!data.nodes[target] || isSelfOrDescendant(data.nodes, node, target))) continue;
      if (kind === 'rename' && !target) continue;
    }
    ops.push({ kind, node, target, members, reason: String(o.reason ?? ''), accepted: kind !== 'delete' });
  }
  return { summary: raw.summary ?? '', ops };
}

/* ---------------- normalisation ---------------- */

/**
 * Turn raw model output into a safe Proposal: unique refs, resolvable
 * parents (falling back to `defaultParent`), placement kept inside `scope`,
 * duplicate titles turned into merges, invalid links dropped.
 */
export function normalizeProposal(
  raw: RawProposal,
  data: GraphData,
  opts: { defaultParent: string | null; scope: string | null; sources: string[] },
): Proposal {
  const nodes: ProposedNode[] = [];
  const refMap = new Map<string, string>(); // raw ref → final ref
  const titleToRef = new Map<string, string>();
  const existingByTitle = new Map<string, string[]>();
  for (const n of Object.values(data.nodes)) {
    const k = normalizeTitle(n.title);
    existingByTitle.set(k, [...(existingByTitle.get(k) ?? []), n.id]);
  }
  let seq = 1;
  for (const r of raw.nodes ?? []) {
    const title = String(r.title ?? '').trim().replace(/^#+\s*/, '');
    if (!title) continue;
    let ref = String(r.ref ?? '').trim() || `r${seq}`;
    if (data.nodes[ref] || refMap.has(ref)) ref = `r_${seq}`;
    seq++;
    refMap.set(String(r.ref ?? ref).trim() || ref, ref);
    titleToRef.set(normalizeTitle(title), ref);
    nodes.push({
      ref,
      title,
      parent: String(r.parent ?? '').trim(),
      content: String(r.content ?? '').trim(),
      tags: Array.isArray(r.tags) ? r.tags.map((t) => String(t).trim().replace(/^#/, '')).filter(Boolean).slice(0, 8) : [],
      mergeInto: String(r.merge_into ?? '').trim() || null,
      accepted: true,
    });
  }
  const refs = new Set(nodes.map((n) => n.ref));

  const resolveId = (v: string): string | null => {
    if (!v) return null;
    const bare = v.replace(/^\[|\]$/g, '').trim();
    if (refMap.has(bare)) return refMap.get(bare)!;
    if (refs.has(bare)) return bare;
    if (data.nodes[bare]) return bare;
    const k = normalizeTitle(bare);
    if (titleToRef.has(k)) return titleToRef.get(k)!;
    const ex = existingByTitle.get(k);
    return ex?.length ? ex[0] : null;
  };
  const inScope = (id: string) => !opts.scope || isSelfOrDescendant(data.nodes, opts.scope, id);

  for (const p of nodes) {
    // merges
    if (p.mergeInto) {
      const m = resolveId(p.mergeInto);
      p.mergeInto = m && data.nodes[m] ? m : null;
    }
    // parent
    let parent = resolveId(p.parent ?? '');
    if (parent === p.ref) parent = null;
    if (parent && data.nodes[parent] && !inScope(parent)) parent = opts.defaultParent;
    if (!parent && opts.scope) parent = opts.defaultParent;
    if (!parent && !p.parent) parent = opts.defaultParent;
    p.parent = parent;
    // auto-merge exact duplicates of existing pages under the same parent
    if (!p.mergeInto && (parent === null || data.nodes[parent])) {
      const k = normalizeTitle(p.title);
      // same title under the same parent, or a page proposed under itself
      const same = (existingByTitle.get(k) ?? []).find((id) => data.nodes[id].parentId === parent || id === parent);
      if (same) p.mergeInto = same;
    }
  }

  // children of merged proposals attach to the merge target
  const mergedRef = new Map(nodes.filter((n) => n.mergeInto).map((n) => [n.ref, n.mergeInto!]));
  for (const p of nodes) if (p.parent && mergedRef.has(p.parent) && !p.mergeInto) p.parent = mergedRef.get(p.parent)!;

  const links: ProposedLink[] = [];
  const seen = new Set<string>();
  for (const l of raw.links ?? []) {
    const s = resolveId(String(l.source ?? ''));
    const t = resolveId(String(l.target ?? ''));
    if (!s || !t || s === t) continue;
    const label = String(l.label ?? '')
      .trim()
      .toLowerCase()
      .slice(0, 60);
    const key = `${s}>${t}>${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // skip links that just restate the hierarchy
    const sp = nodes.find((n) => n.ref === s)?.parent ?? data.nodes[s]?.parentId;
    const tp = nodes.find((n) => n.ref === t)?.parent ?? data.nodes[t]?.parentId;
    if (sp === t || tp === s) continue;
    links.push({ source: s, target: t, label, accepted: true });
  }

  return { summary: raw.summary?.trim() ?? '', nodes, links, sources: opts.sources };
}
