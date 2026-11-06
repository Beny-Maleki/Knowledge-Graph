/**
 * Import / export: JSON backups, Markdown vaults (Obsidian-friendly, folders =
 * hierarchy) and Notion "Markdown & CSV" exports.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { GraphData, KNode, WorkspaceFile } from '../types';
import { sanitizeData } from './ops';
import { buildIndex, childrenOf, makeLink, makeNode, normalizeTitle } from './tree';
import { safeFileName } from './files';

/* ---------------- JSON ---------------- */

export function toWorkspaceFile(data: GraphData, name: string): WorkspaceFile {
  return { app: 'knowledge-graph', version: 1, name, exportedAt: Date.now(), nodes: data.nodes, links: data.links };
}

export function parseWorkspaceJSON(text: string): { name: string; data: GraphData } {
  const raw = JSON.parse(text) as Partial<WorkspaceFile>;
  if (!raw || typeof raw !== 'object' || !('nodes' in raw)) throw new Error('This JSON file is not a Knowledge Graph export.');
  return { name: typeof raw.name === 'string' ? raw.name : 'Imported', data: sanitizeData(raw) };
}

/* ---------------- Markdown export ---------------- */

const RELATIONS_HEADING = '## Relations';

export function exportMarkdownZip(data: GraphData, name: string): Uint8Array {
  const index = buildIndex(data.nodes);
  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  const unique = (path: string) => {
    let p = path;
    let i = 2;
    while (used.has(p.toLowerCase())) p = path.replace(/\.md$/, ` (${i++}).md`);
    used.add(p.toLowerCase());
    return p;
  };
  const write = (id: string, dir: string) => {
    const n = data.nodes[id];
    const kids = childrenOf(index, id);
    const base = safeFileName(n.title);
    const folder = kids.length ? `${dir}${base}/` : dir;
    const path = unique(`${folder}${base}.md`);
    files[path] = strToU8(nodeToMarkdown(data, n));
    for (const k of kids) write(k, folder);
  };
  const root = `${safeFileName(name)}/`;
  for (const r of index.roots) write(r, root);
  return zipSync(files, { level: 6 });
}

function yamlList(items: string[]) {
  return `[${items.map((t) => JSON.stringify(t)).join(', ')}]`;
}

export function nodeToMarkdown(data: GraphData, n: KNode): string {
  const fm = ['---', `id: ${n.id}`];
  if (n.icon) fm.push(`icon: ${JSON.stringify(n.icon)}`);
  if (n.color) fm.push(`color: ${JSON.stringify(n.color)}`);
  if (n.tags.length) fm.push(`tags: ${yamlList(n.tags)}`);
  if (n.sources.length) fm.push(`sources: ${yamlList(n.sources)}`);
  fm.push(`created: ${new Date(n.createdAt).toISOString()}`, `updated: ${new Date(n.updatedAt).toISOString()}`, '---', '');
  const rels = Object.values(data.links)
    .filter((l) => l.source === n.id && data.nodes[l.target])
    .map((l) => `- ${l.label || 'related to'} → [[${data.nodes[l.target].title}]]`);
  let body = n.content.trim();
  if (rels.length) body += `${body ? '\n\n' : ''}${RELATIONS_HEADING}\n\n${rels.join('\n')}`;
  return fm.join('\n') + `# ${n.title}\n\n` + body + '\n';
}

/* ---------------- Markdown / Notion import ---------------- */

export interface MdFile {
  path: string;
  text: string;
}

/** Expand .zip files (including Notion's nested zips) into Markdown files. */
export async function collectMarkdownFiles(files: File[]): Promise<MdFile[]> {
  const out: MdFile[] = [];
  const fromZip = (bytes: Uint8Array, prefix: string, depth: number) => {
    const entries = unzipSync(bytes);
    for (const [path, content] of Object.entries(entries)) {
      if (path.endsWith('/')) continue;
      if (/\.zip$/i.test(path) && depth < 2) fromZip(content, prefix + path.replace(/\.zip$/i, '') + '/', depth + 1);
      else if (/\.(md|markdown|txt)$/i.test(path)) out.push({ path: prefix + path, text: strFromU8(content) });
    }
  };
  for (const f of files) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    if (/\.zip$/i.test(f.name)) fromZip(new Uint8Array(await f.arrayBuffer()), '', 0);
    else if (/\.(md|markdown|txt)$/i.test(f.name)) out.push({ path: rel, text: await f.text() });
  }
  return out;
}

const NOTION_ID = /\s+[0-9a-f]{32}$/i;

function cleanName(segment: string): string {
  return decodeURIComponent(segment)
    .replace(/\.(md|markdown|txt)$/i, '')
    .replace(NOTION_ID, '')
    .trim();
}

interface FrontMatter {
  icon?: string;
  color?: string;
  tags?: string[];
  sources?: string[];
  title?: string;
}

function parseFrontMatter(text: string): { fm: FrontMatter; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text.replace(/\r\n?/g, '\n'));
  if (!m) return { fm: {}, body: text.replace(/\r\n?/g, '\n') };
  const fm: FrontMatter = {};
  for (const line of m[1].split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, k, v] = kv;
    const parseVal = (): string | string[] => {
      const t = v.trim();
      if (t.startsWith('[')) {
        try {
          return JSON.parse(t);
        } catch {
          return t
            .slice(1, -1)
            .split(',')
            .map((s) => s.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean);
        }
      }
      try {
        return JSON.parse(t);
      } catch {
        return t.replace(/^["']|["']$/g, '');
      }
    };
    const val = parseVal();
    if (k === 'tags' || k === 'sources') fm[k] = Array.isArray(val) ? val.map(String) : String(val).split(/[,\s]+/).filter(Boolean);
    else if (k === 'icon' || k === 'color' || k === 'title') fm[k] = String(val);
  }
  return { fm, body: text.replace(/\r\n?/g, '\n').slice(m[0].length) };
}

/**
 * Build a graph from Markdown files. Folder structure becomes the hierarchy;
 * a file named like its folder ("Topic/Topic.md" or "Topic.md" next to
 * "Topic/") becomes that folder's page. Notion ids are stripped, relative
 * Markdown links to other pages become [[wiki links]], and "## Relations"
 * sections written by our exporter become labelled links again.
 */
export function markdownFilesToGraph(files: MdFile[]): GraphData {
  const nodes: Record<string, KNode> = {};
  const byPath = new Map<string, string>(); // folder path (cleaned) → node id
  let order = 1;

  const ensureFolder = (segments: string[]): string | null => {
    if (!segments.length) return null;
    const key = segments.join('/');
    const existing = byPath.get(key);
    if (existing) return existing;
    const parent = ensureFolder(segments.slice(0, -1));
    const n = makeNode({ title: segments[segments.length - 1], parentId: parent, order: order++ });
    nodes[n.id] = n;
    byPath.set(key, n.id);
    return n.id;
  };

  // Skip a single wrapping folder (e.g. the zip / vault name).
  const allSegs = files.map((f) => f.path.split('/').filter(Boolean));
  const firstDirs = new Set(allSegs.map((s) => (s.length > 1 ? s[0] : '')));
  const strip = firstDirs.size === 1 && !firstDirs.has('') ? 1 : 0;

  const sorted = [...files].sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  const pending: { id: string; body: string }[] = [];
  for (const f of sorted) {
    const segs = f.path.split('/').filter(Boolean).slice(strip).map(cleanName);
    if (!segs.length) continue;
    const name = segs[segs.length - 1];
    const dirSegs = segs.slice(0, -1);
    const { fm, body } = parseFrontMatter(f.text);
    let text = body;
    const h1 = /^#\s+(.+)\n?/.exec(text.trimStart());
    let title = fm.title || name;
    if (h1 && normalizeTitle(h1[1]) === normalizeTitle(name)) {
      title = h1[1].trim();
      text = text.trimStart().slice(h1[0].length);
    }
    // Folder note: "Topic/Topic.md" or "Topic.md" beside folder "Topic/"
    const folderNoteKey = dirSegs.length && normalizeTitle(dirSegs[dirSegs.length - 1]) === normalizeTitle(name) ? dirSegs.join('/') : null;
    const siblingFolderKey = [...dirSegs, name].join('/');
    let id: string;
    if (folderNoteKey && byPath.has(folderNoteKey)) id = byPath.get(folderNoteKey)!;
    else if (folderNoteKey) id = ensureFolder(dirSegs)!;
    else if (byPath.has(siblingFolderKey)) id = byPath.get(siblingFolderKey)!;
    else {
      const parent = ensureFolder(dirSegs);
      const n = makeNode({ title, parentId: parent, order: order++ });
      nodes[n.id] = n;
      id = n.id;
      byPath.set(siblingFolderKey, id);
    }
    nodes[id] = {
      ...nodes[id],
      title,
      icon: fm.icon ?? nodes[id].icon,
      color: fm.color ?? nodes[id].color,
      tags: fm.tags ?? nodes[id].tags,
      sources: fm.sources ?? nodes[id].sources,
    };
    pending.push({ id, body: text });
  }

  const titleIdx = new Map<string, string>();
  for (const n of Object.values(nodes)) if (!titleIdx.has(normalizeTitle(n.title))) titleIdx.set(normalizeTitle(n.title), n.id);
  const links: GraphData['links'] = {};
  for (const { id, body } of pending) {
    let text = body;
    // ## Relations section → labelled links
    const relIdx = text.indexOf(`\n${RELATIONS_HEADING}\n`);
    const relStart = text.startsWith(`${RELATIONS_HEADING}\n`) ? 0 : relIdx >= 0 ? relIdx + 1 : -1;
    if (relStart >= 0) {
      const after = text.slice(relStart + RELATIONS_HEADING.length);
      const end = after.search(/\n#{1,2}\s/);
      const section = end >= 0 ? after.slice(0, end) : after;
      for (const m of section.matchAll(/^-\s+(.*?)\s*→\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/gm)) {
        const target = titleIdx.get(normalizeTitle(m[2]));
        if (target && target !== id) {
          const l = makeLink(id, target, m[1] === 'related to' ? '' : m[1]);
          links[l.id] = l;
        }
      }
      text = text.slice(0, relStart) + (end >= 0 ? after.slice(end) : '');
    }
    // relative markdown links to other pages → wiki links
    text = text.replace(/\[([^\]]+)\]\(((?!https?:|mailto:|#)[^)]+?\.md)\)/gi, (_m, label: string, href: string) => {
      const target = cleanName(href.split('/').pop() ?? '');
      return normalizeTitle(label) === normalizeTitle(target) ? `[[${target}]]` : `[[${target}|${label}]]`;
    });
    nodes[id] = { ...nodes[id], content: text.trim() };
  }
  return { nodes, links };
}
