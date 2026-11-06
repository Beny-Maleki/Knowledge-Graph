/** Deterministic graph health checks that power the "Health / prune" dialog. */
import type { GraphData } from '../types';
import { buildIndex, childrenOf, implicitLinks, normalizeTitle, titleLookup, titleSimilarity, wikiTargets } from './tree';

export type IssueKind = 'duplicate' | 'stub' | 'broken' | 'lonely' | 'crowded' | 'chain' | 'deep';

export interface Issue {
  key: string;
  kind: IssueKind;
  ids: string[];
  detail: string;
  /** broken: the missing wiki-link title */
  missing?: string;
}

export const ISSUE_INFO: Record<IssueKind, { title: string; help: string }> = {
  duplicate: { title: 'Possible duplicates', help: 'Pages with (nearly) the same title. Merge them to keep one source of truth.' },
  stub: { title: 'Empty pages', help: 'Leaf pages without notes or links. Write them, expand them with AI, or prune them.' },
  broken: { title: 'Broken wiki links', help: '[[Links]] in the text that point to pages that do not exist yet.' },
  lonely: { title: 'Lonely top-level pages', help: 'Roots with no sub-pages and no relations. Move them into a tree or link them.' },
  crowded: { title: 'Crowded groups', help: 'Many direct sub-pages. Consider grouping them (try ✨ Review branch).' },
  chain: { title: 'Single-child chains', help: 'A page whose only sub-page is another page. Often one level can be merged away.' },
  deep: { title: 'Very deep pages', help: 'Nested more than 7 levels deep. Consider flattening the hierarchy.' },
};

export function analyze(data: GraphData, ignored: Set<string> = new Set()): Issue[] {
  const issues: Issue[] = [];
  const nodes = Object.values(data.nodes);
  const index = buildIndex(data.nodes);
  const implicit = implicitLinks(data.nodes);
  const degree = new Map<string, number>();
  const bump = (id: string) => degree.set(id, (degree.get(id) ?? 0) + 1);
  for (const l of Object.values(data.links)) {
    bump(l.source);
    bump(l.target);
  }
  for (const l of implicit) {
    bump(l.source);
    bump(l.target);
  }

  // duplicates (pairwise on normalised titles; bucketed by first token to stay fast)
  const buckets = new Map<string, string[]>();
  for (const n of nodes) {
    const k = normalizeTitle(n.title);
    if (!k || k === 'untitled') continue;
    const b = k.slice(0, 2);
    buckets.set(b, [...(buckets.get(b) ?? []), n.id]);
  }
  for (const ids of buckets.values()) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = data.nodes[ids[i]];
        const b = data.nodes[ids[j]];
        if (a.parentId === b.id || b.parentId === a.id) continue;
        const sim = titleSimilarity(a.title, b.title);
        if (sim >= 0.86) {
          issues.push({ key: `dup:${[a.id, b.id].sort().join('|')}`, kind: 'duplicate', ids: [a.id, b.id], detail: `${Math.round(sim * 100)}% similar` });
        }
      }
    }
  }

  const lookup = titleLookup(data.nodes);
  for (const n of nodes) {
    const kids = childrenOf(index, n.id);
    const deg = degree.get(n.id) ?? 0;
    if (!kids.length && !n.content.trim() && deg === 0) issues.push({ key: `stub:${n.id}`, kind: 'stub', ids: [n.id], detail: 'No notes, no sub-pages, no links' });
    if (!n.parentId && !kids.length && deg === 0 && n.content.trim())
      issues.push({ key: `lonely:${n.id}`, kind: 'lonely', ids: [n.id], detail: 'Top-level page with nothing attached' });
    if (kids.length > 12) issues.push({ key: `crowded:${n.id}`, kind: 'crowded', ids: [n.id], detail: `${kids.length} direct sub-pages` });
    if (kids.length === 1 && (index.children.get(kids[0])?.length ?? 0) > 0)
      issues.push({ key: `chain:${n.id}`, kind: 'chain', ids: [n.id, kids[0]], detail: 'Only one sub-page, which has its own sub-pages' });
    if ((index.depth.get(n.id) ?? 0) >= 7 && !kids.length) issues.push({ key: `deep:${n.id}`, kind: 'deep', ids: [n.id], detail: `Depth ${index.depth.get(n.id)}` });
    if (n.content.includes('[[')) {
      const seen = new Set<string>();
      for (const t of wikiTargets(n.content)) {
        const k = normalizeTitle(t);
        if (seen.has(k) || lookup.has(k)) continue;
        seen.add(k);
        issues.push({ key: `broken:${n.id}:${k}`, kind: 'broken', ids: [n.id], detail: `[[${t}]]`, missing: t });
      }
    }
  }
  if (index.roots.length > 15) {
    issues.push({ key: 'crowded:__root__', kind: 'crowded', ids: [], detail: `${index.roots.length} top-level pages` });
  }
  return issues.filter((i) => !ignored.has(i.key));
}
