/**
 * Offline "outline parser" ingest: turns Markdown headings, bullet lists or
 * an indented plain-text outline into a proposal — no AI needed.
 */
import type { Proposal, ProposedNode } from '../types';
import { truncate } from './tree';

export interface OutlineOptions {
  /** Treat list items as nodes (otherwise lists stay in the page body). */
  bulletsAsNodes: boolean;
  /** Parent for top-level items (existing id or null). */
  parent: string | null;
  /** If set, wrap everything in a new page with this title. */
  wrapTitle: string | null;
  source: string;
}

interface Item {
  ref: string;
  title: string;
  content: string[];
  level: number; // heading level (1-6) or 10 + list indent
  parentRef: string | null;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const DEF_SPLIT = /^(.{1,70}?)\s*(?::|\s[—–-]\s)\s*(.+)$/;

function cleanTitle(s: string) {
  return s
    .replace(/\*\*|__|`/g, '')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t, a) => a ?? t)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[.:;,]+$/, '')
    .trim();
}

function splitItem(text: string): { title: string; body: string } {
  const t = text.trim();
  const m = DEF_SPLIT.exec(t);
  if (m && m[1].split(/\s+/).length <= 8) return { title: cleanTitle(m[1]), body: m[2].trim() };
  if (t.length <= 80) return { title: cleanTitle(t), body: '' };
  const firstSentence = /^(.{10,90}?[.!?])\s/.exec(t)?.[1];
  const title = cleanTitle(firstSentence ?? truncate(t, 60));
  return { title: truncate(title, 70), body: t };
}

export function parseOutline(text: string, opts: OutlineOptions): Proposal {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const items: Item[] = [];
  const stack: Item[] = []; // open containers
  let seq = 1;
  let inFence = false;
  const preamble: string[] = [];
  let current: Item | null = null;
  let listBase: Item | null = null; // heading that owns the current list
  let listIndents: number[] = [];

  const hasHeadings = lines.some((l) => HEADING.test(l));
  const hasBullets = lines.some((l) => BULLET.test(l));
  const plainOutline = !hasHeadings && !hasBullets && looksLikeIndentedOutline(lines);

  const push = (title: string, level: number, body = ''): Item => {
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const it: Item = { ref: `o${seq++}`, title, content: body ? [body] : [], level, parentRef: stack.length ? stack[stack.length - 1].ref : null };
    items.push(it);
    stack.push(it);
    return it;
  };

  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) inFence = !inFence;
    if (!inFence) {
      const h = HEADING.exec(raw);
      if (h) {
        current = push(cleanTitle(h[2]), h[1].length);
        listBase = current;
        listIndents = [];
        continue;
      }
      if (opts.bulletsAsNodes || plainOutline) {
        const b = BULLET.exec(raw) ?? (plainOutline && raw.trim() ? /^(\s*)(.*)$/.exec(raw.replace(/\t/g, '    ')) : null);
        if (b) {
          const indent = b[1].replace(/\t/g, '    ').length;
          while (listIndents.length && listIndents[listIndents.length - 1] > indent) listIndents.pop();
          if (!listIndents.length || listIndents[listIndents.length - 1] < indent) listIndents.push(indent);
          const depth = listIndents.length - 1;
          // list levels sit below whatever heading owns them
          const baseLevel = listBase ? listBase.level : 0;
          const { title, body } = splitItem(b[2]);
          if (!title) continue;
          current = push(title, baseLevel + 10 + depth, body);
          continue;
        }
        if (current && current.level >= 10 && /^\s{2,}\S/.test(raw)) {
          current.content.push(raw.trim());
          continue;
        }
      }
    }
    if (current) current.content.push(raw);
    else preamble.push(raw);
  }

  const nodes: ProposedNode[] = [];
  let wrapRef: string | null = null;
  const topCount = items.filter((i) => !i.parentRef).length;
  const pre = preamble.join('\n').trim();
  if (opts.wrapTitle || !items.length) {
    wrapRef = 'o0';
    nodes.push({
      ref: wrapRef,
      title: opts.wrapTitle?.trim() || 'Imported notes',
      parent: opts.parent,
      content: items.length ? pre : text.trim(),
      tags: [],
      mergeInto: null,
      accepted: true,
    });
  } else if (pre && topCount === 1) {
    // preamble before a single H1 belongs to it
    const top = items.find((i) => !i.parentRef)!;
    top.content.unshift(pre);
  } else if (pre) {
    wrapRef = 'o0';
    nodes.push({ ref: wrapRef, title: 'Imported notes', parent: opts.parent, content: pre, tags: [], mergeInto: null, accepted: true });
  }
  for (const it of items) {
    nodes.push({
      ref: it.ref,
      title: it.title,
      parent: it.parentRef ?? wrapRef ?? opts.parent,
      content: dedent(it.content.join('\n')).trim(),
      tags: [],
      mergeInto: null,
      accepted: true,
    });
  }
  return {
    summary: `${nodes.length} page${nodes.length === 1 ? '' : 's'} parsed from the outline.`,
    nodes,
    links: [],
    sources: opts.source ? [opts.source] : [],
  };
}

function looksLikeIndentedOutline(lines: string[]): boolean {
  const nonEmpty = lines.filter((l) => l.trim());
  if (nonEmpty.length < 3) return false;
  const indented = nonEmpty.filter((l) => /^(\t|\s{2,})\S/.test(l)).length;
  const short = nonEmpty.filter((l) => l.trim().length <= 90).length;
  return indented >= 2 && short / nonEmpty.length > 0.8;
}

function dedent(s: string): string {
  const ls = s.split('\n');
  const indents = ls.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return min ? ls.map((l) => l.slice(min)).join('\n') : s;
}
