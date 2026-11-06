import type { GraphData, KLink, KNode } from '../types';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Short random id (8 chars ≈ 41 bits) — compact enough to hand to an LLM. */
export function uid(prefix = 'n'): string {
  let s = '';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  for (const b of bytes) s += ALPHABET[b % 36];
  return `${prefix}_${s}`;
}

export const ROOT_KEY = '__root__';

export interface TreeIndex {
  /** parent id (or ROOT_KEY) → ordered child ids */
  children: Map<string, string[]>;
  /** id → number of descendants (excluding itself) */
  descCount: Map<string, number>;
  /** id → depth (roots = 0) */
  depth: Map<string, number>;
  /** id → id of the top-level root of its tree */
  rootOf: Map<string, string>;
  /** ordered list of root ids */
  roots: string[];
}

export function buildIndex(nodes: Record<string, KNode>): TreeIndex {
  const children = new Map<string, string[]>();
  const all = Object.values(nodes);
  for (const n of all) {
    // A parent that no longer exists turns the node into a root.
    const key = n.parentId && nodes[n.parentId] ? n.parentId : ROOT_KEY;
    let arr = children.get(key);
    if (!arr) children.set(key, (arr = []));
    arr.push(n.id);
  }
  for (const arr of children.values()) {
    arr.sort((a, b) => nodes[a].order - nodes[b].order || nodes[a].createdAt - nodes[b].createdAt);
  }
  const roots = children.get(ROOT_KEY) ?? [];
  const descCount = new Map<string, number>();
  const depth = new Map<string, number>();
  const rootOf = new Map<string, string>();
  const visit = (id: string, d: number, root: string): number => {
    depth.set(id, d);
    rootOf.set(id, root);
    let count = 0;
    for (const c of children.get(id) ?? []) {
      if (depth.has(c)) continue; // cycle guard
      count += 1 + visit(c, d + 1, root);
    }
    descCount.set(id, count);
    return count;
  };
  for (const r of roots) visit(r, 0, r);
  // Nodes caught in a parent cycle are unreachable from any root: surface them as roots.
  for (const n of all) {
    if (!depth.has(n.id)) {
      roots.push(n.id);
      visit(n.id, 0, n.id);
    }
  }
  return { children, descCount, depth, rootOf, roots };
}

export function childrenOf(index: TreeIndex, id: string | null): string[] {
  return index.children.get(id ?? ROOT_KEY) ?? [];
}

/** Ancestors from the top-level root down to (but excluding) `id`. */
export function ancestors(nodes: Record<string, KNode>, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let cur = nodes[id]?.parentId ?? null;
  while (cur && nodes[cur] && !seen.has(cur)) {
    out.unshift(cur);
    seen.add(cur);
    cur = nodes[cur].parentId;
  }
  return out;
}

export function descendants(index: TreeIndex, id: string): string[] {
  const out: string[] = [];
  const stack = [...childrenOf(index, id)];
  const seen = new Set<string>();
  while (stack.length) {
    const c = stack.pop()!;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    stack.push(...childrenOf(index, c));
  }
  return out;
}

/** True if `maybeDesc` is `id` itself or lies somewhere below it. */
export function isSelfOrDescendant(nodes: Record<string, KNode>, id: string, maybeDesc: string): boolean {
  if (id === maybeDesc) return true;
  return ancestors(nodes, maybeDesc).includes(id);
}

export function pathTitles(nodes: Record<string, KNode>, id: string): string[] {
  return [...ancestors(nodes, id), id].map((a) => nodes[a]?.title ?? '?');
}

export function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function titleLookup(nodes: Record<string, KNode>): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of Object.values(nodes)) {
    const k = normalizeTitle(n.title);
    if (k && !m.has(k)) m.set(k, n.id);
  }
  return m;
}

const WIKI_RE = /\[\[([^\]|\n]+?)(?:\|([^\]\n]+))?\]\]/g;

/** Titles referenced by [[Wiki Links]] in a markdown string. */
export function wikiTargets(content: string): string[] {
  const out: string[] = [];
  // ignore fenced code blocks and inline code
  const text = content.replace(/(```|~~~)[\s\S]*?\1/g, ' ').replace(/`[^`\n]*`/g, ' ');
  for (const m of text.matchAll(WIKI_RE)) out.push(m[1].trim());
  return out;
}

export interface ImplicitLink {
  source: string;
  target: string;
}

/** Links implied by [[Wiki Links]] inside page content. */
export function implicitLinks(nodes: Record<string, KNode>, lookup = titleLookup(nodes)): ImplicitLink[] {
  const out: ImplicitLink[] = [];
  for (const n of Object.values(nodes)) {
    if (!n.content.includes('[[')) continue;
    const seen = new Set<string>();
    for (const t of wikiTargets(n.content)) {
      const target = lookup.get(normalizeTitle(t));
      if (target && target !== n.id && !seen.has(target)) {
        seen.add(target);
        out.push({ source: n.id, target });
      }
    }
  }
  return out;
}

export interface Relation {
  /** The other node. */
  other: string;
  label: string;
  linkId?: string;
  kind: 'link' | 'mention';
}

/** Outgoing and incoming relations of a node (explicit links + wiki mentions). */
export function relationsOf(data: GraphData, id: string, implicit: ImplicitLink[]) {
  const outgoing: Relation[] = [];
  const incoming: Relation[] = [];
  for (const l of Object.values(data.links)) {
    if (l.source === id && data.nodes[l.target]) outgoing.push({ other: l.target, label: l.label, linkId: l.id, kind: 'link' });
    else if (l.target === id && data.nodes[l.source]) incoming.push({ other: l.source, label: l.label, linkId: l.id, kind: 'link' });
  }
  for (const l of implicit) {
    if (l.source === id) outgoing.push({ other: l.target, label: 'mentions', kind: 'mention' });
    else if (l.target === id) incoming.push({ other: l.source, label: 'mentions', kind: 'mention' });
  }
  return { outgoing, incoming };
}

/* ---------- colours ---------- */

export const PALETTE = [
  '#7c9cff', // periwinkle
  '#4fd1a5', // mint
  '#f6ad55', // amber
  '#f687b3', // pink
  '#b794f4', // lavender
  '#63b3ed', // sky
  '#f56565', // coral
  '#9ae6b4', // pale green
  '#fbd38d', // sand
  '#76e4f7', // cyan
];

export function nodeColor(nodes: Record<string, KNode>, index: TreeIndex, id: string): string {
  let cur: string | null = id;
  const seen = new Set<string>();
  while (cur && nodes[cur] && !seen.has(cur)) {
    seen.add(cur);
    if (nodes[cur].color) return nodes[cur].color!;
    cur = nodes[cur].parentId;
  }
  const root = index.rootOf.get(id) ?? id;
  const i = index.roots.indexOf(root);
  return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
}

/* ---------- misc ---------- */

export function makeNode(partial: Partial<KNode> & { title: string }): KNode {
  const now = Date.now();
  return {
    id: partial.id ?? uid(),
    title: partial.title,
    parentId: partial.parentId ?? null,
    order: partial.order ?? now,
    content: partial.content ?? '',
    icon: partial.icon,
    color: partial.color,
    tags: partial.tags ?? [],
    sources: partial.sources ?? [],
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
  };
}

export function makeLink(source: string, target: string, label = ''): KLink {
  return { id: uid('l'), source, target, label, createdAt: Date.now() };
}

export function nextOrder(nodes: Record<string, KNode>, index: TreeIndex, parentId: string | null): number {
  const sibs = childrenOf(index, parentId);
  if (!sibs.length) return 1;
  return Math.max(...sibs.map((s) => nodes[s].order)) + 1;
}

/** Similarity of two titles in [0,1] using token overlap and edit distance. */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const singular = (s: string) => s.split(' ').map((w) => (w.length > 3 ? w.replace(/(es|s)$/, '') : w)).join(' ');
  if (singular(na) === singular(nb)) return 0.97;
  const ta = new Set(singular(na).split(' '));
  const tb = new Set(singular(nb).split(' '));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const jaccard = inter / (ta.size + tb.size - inter);
  const lev = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
  return Math.max(jaccard, lev);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

/** Plain-text excerpt of a markdown body. */
export function excerpt(md: string, n = 140): string {
  const plain = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$([^$\n]+)\$/g, '$1')
    .replace(/\\(?:to|rightarrow)\b/g, '→')
    .replace(/\\([a-zA-Z]+)/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t, a) => a ?? t)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(plain, n);
}
