/**
 * Pure graph logic for the Claude (MCP) connector. No I/O here, so the same
 * file runs in the Supabase Edge Function (Deno) and in the app's unit tests.
 * Shapes match the web app's KNode / KLink exactly, so pages written by Claude
 * look like any other page once they sync.
 */

export interface NodeData {
  id: string;
  title: string;
  parentId: string | null;
  order: number;
  content: string;
  icon?: string;
  color?: string;
  tags: string[];
  sources: string[];
  createdAt: number;
  updatedAt: number;
}

export interface LinkData {
  id: string;
  source: string;
  target: string;
  label: string;
  createdAt: number;
}

/** Light view of a page (enough for outlines, placement and de-duplication). */
export interface LightNode {
  id: string;
  title: string;
  parentId: string | null;
  order: number;
  icon?: string | null;
}

export interface PageInput {
  ref?: string;
  title: string;
  parent?: string | null;
  content?: string;
  tags?: string[];
  sources?: string[];
  icon?: string;
}

export interface LinkInput {
  source: string;
  target: string;
  label?: string;
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function uid(prefix = 'n'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = '';
  for (const b of bytes) s += ALPHABET[b % 36];
  return `${prefix}_${s}`;
}

export function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export class InputError extends Error {}

/* ---------------- tree helpers ---------------- */

export interface Tree {
  byId: Map<string, LightNode>;
  children: Map<string | null, string[]>;
}

export function buildTree(nodes: LightNode[]): Tree {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string | null, string[]>();
  for (const n of nodes) {
    const p = n.parentId && byId.has(n.parentId) ? n.parentId : null;
    const arr = children.get(p) ?? [];
    arr.push(n.id);
    children.set(p, arr);
  }
  for (const arr of children.values()) arr.sort((a, b) => (byId.get(a)!.order ?? 0) - (byId.get(b)!.order ?? 0));
  return { byId, children };
}

export function pathOf(tree: Tree, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = id;
  while (cur && tree.byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    out.unshift(tree.byId.get(cur)!.title);
    const p: string | null = tree.byId.get(cur)!.parentId;
    cur = p && tree.byId.has(p) ? p : null;
  }
  return out;
}

export function isSelfOrDescendant(tree: Tree, ancestor: string, id: string): boolean {
  let cur: string | null = id;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = tree.byId.get(cur)?.parentId ?? null;
  }
  return false;
}

function countDesc(tree: Tree, id: string): number {
  let n = 0;
  for (const c of tree.children.get(id) ?? []) n += 1 + countDesc(tree, c);
  return n;
}

/** Indented outline `- [id] Title`, optionally limited to a branch and depth. */
export function renderOutline(tree: Tree, rootId: string | null, maxDepth: number, maxLines = 1500): string {
  const lines: string[] = [];
  let truncated = false;
  const walk = (id: string, depth: number) => {
    if (lines.length >= maxLines) {
      truncated = true;
      return;
    }
    const n = tree.byId.get(id)!;
    const kids = tree.children.get(id) ?? [];
    let line = `${'  '.repeat(depth)}- [${id}] ${n.icon ? n.icon + ' ' : ''}${n.title}`;
    if (kids.length && depth + 1 >= maxDepth) line += `  (+${countDesc(tree, id)} nested pages not shown)`;
    lines.push(line);
    if (depth + 1 < maxDepth) for (const k of kids) walk(k, depth + 1);
  };
  const roots = rootId ? [rootId] : (tree.children.get(null) ?? []);
  for (const r of roots) walk(r, 0);
  if (truncated) lines.push(`… (outline truncated at ${maxLines} lines — use root_page_id to look at one branch)`);
  return lines.join('\n');
}

/* ---------------- resolving references ---------------- */

/** Resolve a page reference: existing id, a ref from this call, or an exact (unique) existing title. */
function makeResolver(tree: Tree, refMap: Map<string, string>) {
  const byTitle = new Map<string, string[]>();
  for (const n of tree.byId.values()) {
    const k = normalizeTitle(n.title);
    byTitle.set(k, [...(byTitle.get(k) ?? []), n.id]);
  }
  return (value: string | null | undefined): { id: string | null; error?: string } => {
    const v = (value ?? '').trim().replace(/^\[|\]$/g, '');
    if (!v) return { id: null };
    if (refMap.has(v)) return { id: refMap.get(v)! };
    if (tree.byId.has(v)) return { id: v };
    const matches = byTitle.get(normalizeTitle(v)) ?? [];
    if (matches.length === 1) return { id: matches[0] };
    if (matches.length > 1) return { id: null, error: `“${v}” matches ${matches.length} pages — use the page id instead (${matches.join(', ')})` };
    return { id: null, error: `no page, ref or title “${v}” found` };
  };
}

/* ---------------- planning writes ---------------- */

export interface AddPlan {
  create: NodeData[];
  /** Existing pages that receive extra content / tags / sources. */
  append: { id: string; content: string; tags: string[]; sources: string[] }[];
  links: LinkData[];
  refMap: Record<string, string>;
  notes: string[];
}

const MAX_PAGES = 200;
const MAX_CONTENT = 200_000;

function cleanList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((x) => String(x).trim().replace(/^#/, '')).filter(Boolean))].slice(0, max);
}

/**
 * Turn an `add_knowledge` request into concrete rows. Pages whose title already
 * exists under the same parent are merged (content appended) instead of duplicated.
 */
export function planAddKnowledge(
  existing: LightNode[],
  existingLinks: Pick<LinkData, 'source' | 'target' | 'label'>[],
  pages: PageInput[],
  links: LinkInput[],
  now = Date.now(),
): AddPlan {
  if (pages.length > MAX_PAGES) throw new InputError(`Too many pages in one call (max ${MAX_PAGES}). Split it up.`);
  const tree = buildTree(existing);
  const notes: string[] = [];
  const problems: string[] = [];

  // 1. give every new page a ref and a provisional id
  const refMap = new Map<string, string>();
  const items = pages.map((p, i) => {
    const title = String(p.title ?? '').trim().replace(/^#+\s*/, '').slice(0, 200);
    if (!title) problems.push(`pages[${i}] has no title`);
    const content = String(p.content ?? '');
    if (content.length > MAX_CONTENT) problems.push(`pages[${i}] content is too long (max ${MAX_CONTENT} characters)`);
    const ref = String(p.ref ?? '').trim() || `#${i}`;
    if (refMap.has(ref)) problems.push(`duplicate ref “${ref}”`);
    const id = uid();
    refMap.set(ref, id);
    return { ...p, title, content, ref, id };
  });
  const resolve = makeResolver(tree, refMap);

  // 2. resolve parents
  const parentOf = new Map<string, string | null>();
  for (const it of items) {
    const r = resolve(it.parent);
    if (r.error) problems.push(`parent of “${it.title}”: ${r.error}`);
    if (r.id === it.id) problems.push(`“${it.title}” cannot be its own parent`);
    parentOf.set(it.id, r.id);
  }
  // cycles among new pages
  for (const it of items) {
    const seen = new Set<string>();
    let cur: string | null = it.id;
    while (cur && parentOf.has(cur)) {
      if (seen.has(cur)) {
        problems.push(`parent cycle involving “${it.title}”`);
        break;
      }
      seen.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
  }
  if (problems.length) throw new InputError(`Nothing was written:\n- ${problems.join('\n- ')}`);

  // 3. de-duplicate against existing siblings (and within this call), in parent-first order
  const finalId = new Map<string, string>(); // provisional id → real id (merged or new)
  const create: NodeData[] = [];
  const appendMap = new Map<string, { id: string; content: string[]; tags: string[]; sources: string[] }>();
  const siblingTitles = new Map<string, Map<string, string>>(); // parentKey → normTitle → id
  const sibKey = (p: string | null) => p ?? '__root__';
  const titlesUnder = (p: string | null) => {
    const key = sibKey(p);
    let m = siblingTitles.get(key);
    if (!m) {
      m = new Map();
      for (const c of tree.children.get(p) ?? []) m.set(normalizeTitle(tree.byId.get(c)!.title), c);
      siblingTitles.set(key, m);
    }
    return m;
  };
  const nextOrder = new Map<string, number>();
  const orderFor = (p: string | null) => {
    const key = sibKey(p);
    let v = nextOrder.get(key);
    if (v === undefined) {
      const sibs = tree.children.get(p) ?? [];
      v = sibs.length ? Math.max(...sibs.map((s) => tree.byId.get(s)!.order ?? 0)) + 1 : 1;
    }
    nextOrder.set(key, v + 1);
    return v;
  };

  const pending = [...items];
  let guard = 0;
  while (pending.length && guard++ < 10_000) {
    const idx = pending.findIndex((it) => {
      const p = parentOf.get(it.id);
      return !p || !items.some((o) => o.id === p) || finalId.has(p);
    });
    const it = pending.splice(idx < 0 ? 0 : idx, 1)[0];
    const rawParent = parentOf.get(it.id) ?? null;
    const parent = rawParent && finalId.has(rawParent) ? finalId.get(rawParent)! : rawParent;
    const norm = normalizeTitle(it.title);
    const siblings = titlesUnder(parent);
    const dup = siblings.get(norm);
    const tags = cleanList(it.tags, 12);
    const sources = cleanList(it.sources, 20);
    if (dup) {
      finalId.set(it.id, dup);
      const created = create.find((c) => c.id === dup);
      if (created) {
        if (it.content.trim()) created.content = [created.content, it.content.trim()].filter(Boolean).join('\n\n');
        created.tags = [...new Set([...created.tags, ...tags])];
        created.sources = [...new Set([...created.sources, ...sources])];
      } else {
        const a = appendMap.get(dup) ?? { id: dup, content: [], tags: [], sources: [] };
        if (it.content.trim()) a.content.push(it.content.trim());
        a.tags.push(...tags);
        a.sources.push(...sources);
        appendMap.set(dup, a);
        notes.push(`“${it.title}” already existed there, so the new notes were added to it (${dup}).`);
      }
      continue;
    }
    finalId.set(it.id, it.id);
    siblings.set(norm, it.id);
    create.push({
      id: it.id,
      title: it.title,
      parentId: parent,
      order: orderFor(parent),
      content: it.content.trim(),
      ...(it.icon ? { icon: String(it.icon).slice(0, 8) } : {}),
      tags,
      sources,
      createdAt: now,
      updatedAt: now,
    });
  }

  const refOut: Record<string, string> = {};
  for (const it of items) refOut[it.ref] = finalId.get(it.id)!;

  // 4. links
  const finalRefMap = new Map<string, string>([...refMap].map(([ref, id]) => [ref, finalId.get(id) ?? id]));
  const resolveLink = makeResolver(tree, finalRefMap);
  const known = new Set(existingLinks.map((l) => `${l.source}>${l.target}>${l.label.toLowerCase()}`));
  const outLinks: LinkData[] = [];
  for (const l of links) {
    const s = resolveLink(l.source);
    const t = resolveLink(l.target);
    if (s.error || t.error || !s.id || !t.id) {
      notes.push(`Skipped relation ${l.source} → ${l.target}: ${s.error ?? t.error ?? 'missing end'}`);
      continue;
    }
    if (s.id === t.id) continue;
    const label = String(l.label ?? '').trim().toLowerCase().slice(0, 60);
    const key = `${s.id}>${t.id}>${label}`;
    if (known.has(key)) continue;
    known.add(key);
    outLinks.push({ id: uid('l'), source: s.id, target: t.id, label, createdAt: now });
  }

  return {
    create,
    append: [...appendMap.values()].map((a) => ({ id: a.id, content: a.content.join('\n\n'), tags: [...new Set(a.tags)], sources: [...new Set(a.sources)] })),
    links: outLinks,
    refMap: refOut,
    notes,
  };
}

export function appendContent(base: string, extra: string): string {
  const e = extra.trim();
  if (!e) return base;
  if (!base.trim()) return e;
  if (base.includes(e)) return base;
  return `${base.trimEnd()}\n\n${e}`;
}

/** Plain-text excerpt for search results. */
export function excerpt(md: string, n = 160): string {
  const plain = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > n ? plain.slice(0, n - 1) + '…' : plain;
}
