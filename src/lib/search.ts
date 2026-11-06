import type { KNode } from '../types';
import { normalizeTitle } from './tree';

/** Fuzzy subsequence score of `q` in `text` (higher is better, -1 = no match). */
export function fuzzyScore(q: string, text: string): number {
  if (!q) return 0;
  const t = text.toLowerCase();
  const query = q.toLowerCase();
  const direct = t.indexOf(query);
  if (direct >= 0) return 1000 - direct * 2 - (t.length - query.length) * 0.5 + (direct === 0 || t[direct - 1] === ' ' ? 200 : 0);
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of query) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 6 - Math.min(10, found - ti);
    if (found === 0 || t[found - 1] === ' ') score += 12;
    ti = found + 1;
  }
  return score;
}

export interface SearchHit {
  id: string;
  score: number;
  inContent: boolean;
}

export function searchNodes(nodes: Record<string, KNode>, q: string, limit = 50): SearchHit[] {
  const query = q.trim();
  const all = Object.values(nodes);
  if (!query) return all.slice(0, limit).map((n) => ({ id: n.id, score: 0, inContent: false }));
  const nq = normalizeTitle(query);
  const hits: SearchHit[] = [];
  for (const n of all) {
    let s = fuzzyScore(query, n.title);
    let inContent = false;
    if (s < 0 && nq.length >= 3) {
      const tagHit = n.tags.some((t) => t.toLowerCase().includes(nq));
      if (tagHit) s = 60;
      else if (n.content.toLowerCase().includes(query.toLowerCase())) {
        s = 20;
        inContent = true;
      }
    }
    if (s >= 0) hits.push({ id: n.id, score: s, inContent });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}
