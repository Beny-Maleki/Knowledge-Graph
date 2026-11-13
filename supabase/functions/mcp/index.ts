// Knowledge Graph — MCP connector for Claude.
//
// URL:  https://<project>.supabase.co/functions/v1/mcp/<token>
//       (or send the token as `Authorization: Bearer <token>`)
//
// Tokens are created by users in the web app (Account → Connect Claude). Only a
// SHA-256 hash is stored. Every query below is filtered by the token owner's id,
// so a token can only ever read or write its owner's workspaces.
//
// Deploy with JWT verification OFF (the token is checked here instead).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0';
import { McpServer } from 'npm:@modelcontextprotocol/sdk@1.32.2/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from 'npm:@modelcontextprotocol/sdk@1.32.2/server/webStandardStreamableHttp.js';
import { z } from 'npm:zod@4.6.7';
import {
  appendContent,
  buildTree,
  excerpt,
  InputError,
  isSelfOrDescendant,
  pathOf,
  planAddKnowledge,
  renderOutline,
  type LightNode,
  type LinkData,
  type NodeData,
} from './logic.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
function secretKey(): string {
  const keys = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (keys) {
    try {
      const k = JSON.parse(keys)?.default;
      if (k) return k;
    } catch {
      /* fall back */
    }
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
}
const admin = createClient(SUPABASE_URL, secretKey(), { auth: { persistSession: false, autoRefreshToken: false } });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id',
  'Access-Control-Expose-Headers': 'mcp-session-id, mcp-protocol-version',
};

/* ---------------- auth ---------------- */

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function extractToken(req: Request): string | null {
  const auth = req.headers.get('authorization') ?? '';
  const bearer = /^Bearer\s+(kgm_[A-Za-z0-9_-]{20,})$/.exec(auth.trim());
  if (bearer) return bearer[1];
  const m = /\/mcp\/(kgm_[A-Za-z0-9_-]{20,})\/?$/.exec(new URL(req.url).pathname);
  return m ? m[1] : null;
}

async function authenticate(token: string): Promise<{ ownerId: string } | null> {
  const hash = await sha256Hex(token);
  const { data, error } = await admin.from('mcp_tokens').select('id, owner_id, expires_at, last_used_at').eq('token_hash', hash).maybeSingle();
  if (error || !data) return null;
  if (data.expires_at && Date.parse(data.expires_at) < Date.now()) return null;
  if (!data.last_used_at || Date.now() - Date.parse(data.last_used_at) > 5 * 60_000) {
    await admin.from('mcp_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', data.id);
  }
  return { ownerId: data.owner_id };
}

/* ---------------- data access (always scoped to the owner) ---------------- */

interface Ctx {
  db: SupabaseClient;
  ownerId: string;
}

interface Workspace {
  id: string;
  name: string;
  updated_at: string;
}

async function workspaces(ctx: Ctx): Promise<Workspace[]> {
  const { data, error } = await ctx.db.from('workspaces').select('id,name,updated_at').eq('owner_id', ctx.ownerId).order('updated_at', { ascending: false });
  if (error) throw error;
  return data as Workspace[];
}

async function pickWorkspace(ctx: Ctx, wanted?: string): Promise<Workspace> {
  const list = await workspaces(ctx);
  if (!list.length) throw new InputError('This account has no workspace yet. Open the Knowledge Graph app, sign in once, and try again.');
  if (!wanted?.trim()) return list[0];
  const w = wanted.trim();
  const hit = list.find((x) => x.id === w) ?? list.find((x) => x.name.toLowerCase() === w.toLowerCase());
  if (!hit) throw new InputError(`No workspace “${w}”. Available: ${list.map((x) => `${x.name} (${x.id})`).join(', ')}`);
  return hit;
}

async function lightNodes(ctx: Ctx, wsId: string): Promise<LightNode[]> {
  const out: LightNode[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await ctx.db
      .from('kg_nodes')
      .select('id, title:data->>title, parentId:data->>parentId, sort:data->order, icon:data->>icon')
      .eq('workspace_id', wsId)
      .eq('owner_id', ctx.ownerId)
      .eq('deleted', false)
      .order('id')
      .range(from, from + 999);
    if (error) throw error;
    for (const r of data as { id: string; title: string; parentId: string | null; sort: number | null; icon: string | null }[]) {
      out.push({ id: r.id, title: r.title ?? 'Untitled', parentId: r.parentId || null, order: Number(r.sort ?? 0), icon: r.icon });
    }
    if (data.length < 1000) break;
  }
  return out;
}

async function allLinks(ctx: Ctx, wsId: string): Promise<LinkData[]> {
  const out: LinkData[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await ctx.db
      .from('kg_links')
      .select('data')
      .eq('workspace_id', wsId)
      .eq('owner_id', ctx.ownerId)
      .eq('deleted', false)
      .order('id')
      .range(from, from + 999);
    if (error) throw error;
    out.push(...(data as { data: LinkData }[]).map((r) => r.data));
    if (data.length < 1000) break;
  }
  return out;
}

async function fullNodes(ctx: Ctx, wsId: string, ids: string[]): Promise<Map<string, NodeData>> {
  const m = new Map<string, NodeData>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await ctx.db
      .from('kg_nodes')
      .select('id, data')
      .eq('workspace_id', wsId)
      .eq('owner_id', ctx.ownerId)
      .eq('deleted', false)
      .in('id', ids.slice(i, i + 200));
    if (error) throw error;
    for (const r of data as { id: string; data: NodeData }[]) m.set(r.id, r.data);
  }
  return m;
}

async function upsertNodes(ctx: Ctx, wsId: string, nodes: NodeData[]) {
  for (let i = 0; i < nodes.length; i += 200) {
    const rows = nodes.slice(i, i + 200).map((n) => ({ workspace_id: wsId, id: n.id, owner_id: ctx.ownerId, data: n, deleted: false }));
    const { error } = await ctx.db.from('kg_nodes').upsert(rows, { onConflict: 'workspace_id,id' });
    if (error) throw error;
  }
}

async function upsertLinks(ctx: Ctx, wsId: string, links: LinkData[]) {
  for (let i = 0; i < links.length; i += 500) {
    const rows = links.slice(i, i + 500).map((l) => ({ workspace_id: wsId, id: l.id, owner_id: ctx.ownerId, data: l, deleted: false }));
    const { error } = await ctx.db.from('kg_links').upsert(rows, { onConflict: 'workspace_id,id' });
    if (error) throw error;
  }
}

async function tombstone(ctx: Ctx, table: 'kg_nodes' | 'kg_links', wsId: string, ids: string[]) {
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await ctx.db
      .from(table)
      .update({ deleted: true, data: {} })
      .eq('workspace_id', wsId)
      .eq('owner_id', ctx.ownerId)
      .in('id', ids.slice(i, i + 200));
    if (error) throw error;
  }
}

/* ---------------- MCP server ---------------- */

const INSTRUCTIONS = `This connector reads and writes the user's personal knowledge graph (the Knowledge Graph web app).
The graph is a forest: every page has a title, a Markdown body and an optional parent page; pages can also be linked by free-form labelled relations.
How to add knowledge well:
1. Call get_outline first to see the existing structure (and list_workspaces if the user has several).
2. Use add_knowledge to create several pages at once: put each idea in the most specific existing parent (use its id), create intermediate grouping pages when 3+ siblings share a theme, keep titles short noun phrases, and write concise Markdown notes (definitions, key points, $LaTeX$ math, examples). Use [[Exact Title]] to mention other pages.
3. Add relations between related pages (labels like "uses", "contrasts with", "is an example of").
Don't create duplicates: a page with the same title under the same parent is merged automatically. Changes appear in the user's app within about 30 seconds.`;

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

function buildServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: 'knowledge-graph', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  const ws = z.string().optional().describe('Workspace name or id. Omit to use the most recently used workspace.');

  server.registerTool(
    'list_workspaces',
    {
      title: 'List workspaces',
      description: "List the user's knowledge-graph workspaces (separate graphs, e.g. one per subject) with page counts.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const list = await workspaces(ctx);
      if (!list.length) return text('No workspaces yet. The user should open the app and sign in once.');
      const lines = await Promise.all(
        list.map(async (w, i) => {
          const { count } = await ctx.db.from('kg_nodes').select('id', { count: 'exact', head: true }).eq('workspace_id', w.id).eq('owner_id', ctx.ownerId).eq('deleted', false);
          return `- ${w.name} (id ${w.id}) — ${count ?? 0} pages${i === 0 ? ' — default' : ''}`;
        }),
      );
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'get_outline',
    {
      title: 'Get outline',
      description: 'Show the hierarchy of pages as an indented outline with page ids, for the whole workspace or one branch. Call this before adding knowledge so new pages go in the right place.',
      inputSchema: {
        workspace: ws,
        root_page_id: z.string().optional().describe('Only show this page and what is nested under it.'),
        max_depth: z.number().int().min(1).max(20).optional().describe('How many levels to show (default 6).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspace, root_page_id, max_depth }) => {
      const w = await pickWorkspace(ctx, workspace);
      const tree = buildTree(await lightNodes(ctx, w.id));
      if (root_page_id && !tree.byId.has(root_page_id)) throw new InputError(`No page with id ${root_page_id}.`);
      if (!tree.byId.size) return text(`Workspace “${w.name}” is empty.`);
      return text(`Workspace: ${w.name}\n${renderOutline(tree, root_page_id ?? null, max_depth ?? 6)}`);
    },
  );

  server.registerTool(
    'search_pages',
    {
      title: 'Search pages',
      description: 'Find pages whose title or notes contain the query (case-insensitive). Returns ids, locations and snippets.',
      inputSchema: { query: z.string().min(1), workspace: ws, limit: z.number().int().min(1).max(50).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ query, workspace, limit }) => {
      const w = await pickWorkspace(ctx, workspace);
      const q = query.replace(/[%_,()*\\]/g, ' ').trim();
      if (!q) throw new InputError('Query is empty after removing special characters.');
      const { data, error } = await ctx.db
        .from('kg_nodes')
        .select('id, data')
        .eq('workspace_id', w.id)
        .eq('owner_id', ctx.ownerId)
        .eq('deleted', false)
        .or(`data->>title.ilike.*${q}*,data->>content.ilike.*${q}*`)
        .limit(limit ?? 20);
      if (error) throw error;
      const rows = data as { id: string; data: NodeData }[];
      if (!rows.length) return text(`No pages match “${query}” in ${w.name}.`);
      const tree = buildTree(await lightNodes(ctx, w.id));
      rows.sort((a, b) => Number(b.data.title.toLowerCase().includes(q.toLowerCase())) - Number(a.data.title.toLowerCase().includes(q.toLowerCase())));
      return text(
        rows
          .map((r) => {
            const path = pathOf(tree, r.id).slice(0, -1).join(' › ') || 'top level';
            const lower = r.data.content.toLowerCase();
            const at = lower.indexOf(q.toLowerCase());
            const snippet = at >= 0 ? '…' + excerpt(r.data.content.slice(Math.max(0, at - 60)), 180) : excerpt(r.data.content, 140);
            return `- [${r.id}] ${r.data.title}  (in ${path})${snippet ? `\n  ${snippet}` : ''}`;
          })
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'get_page',
    {
      title: 'Read a page',
      description: 'Read one page in full: location, notes (Markdown), tags, sources, sub-pages and relations.',
      inputSchema: { page_id: z.string(), workspace: ws },
      annotations: { readOnlyHint: true },
    },
    async ({ page_id, workspace }) => {
      const w = await pickWorkspace(ctx, workspace);
      const n = (await fullNodes(ctx, w.id, [page_id])).get(page_id);
      if (!n) throw new InputError(`No page with id ${page_id} in ${w.name}.`);
      const tree = buildTree(await lightNodes(ctx, w.id));
      const links = (await allLinks(ctx, w.id)).filter((l) => l.source === page_id || l.target === page_id);
      const title = (id: string) => tree.byId.get(id)?.title ?? id;
      const kids = (tree.children.get(page_id) ?? []).map((k) => `- [${k}] ${title(k)}`);
      const rels = links.map((l) =>
        l.source === page_id ? `- → ${l.label || 'related to'} → [${l.target}] ${title(l.target)} (link ${l.id})` : `- ← [${l.source}] ${title(l.source)} ${l.label || 'related to'} → this (link ${l.id})`,
      );
      return text(
        [
          `# ${n.icon ? n.icon + ' ' : ''}${n.title}  [${n.id}]`,
          `Location: ${pathOf(tree, page_id).slice(0, -1).join(' › ') || 'top level'}${n.parentId ? ` (parent ${n.parentId})` : ''}`,
          n.tags.length ? `Tags: ${n.tags.join(', ')}` : '',
          n.sources.length ? `Sources: ${n.sources.join('; ')}` : '',
          `\n## Notes\n${n.content || '(empty)'}`,
          `\n## Sub-pages\n${kids.join('\n') || '(none)'}`,
          `\n## Relations\n${rels.join('\n') || '(none)'}`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    },
  );

  const pageSchema = z.object({
    ref: z.string().optional().describe('Your temporary name for this page, so other pages / relations in the same call can refer to it.'),
    title: z.string().min(1).describe('Short noun phrase, e.g. "Backpropagation".'),
    parent: z.string().optional().describe('Existing page id, a ref from this call, or an exact existing title. Omit or "" for a new top-level topic.'),
    content: z.string().optional().describe('Markdown notes. Supports $math$, tables, code and [[Page Title]] mentions.'),
    tags: z.array(z.string()).optional(),
    sources: z.array(z.string()).optional().describe('Where this knowledge came from (URL, book, lecture…).'),
    icon: z.string().optional().describe('Optional single emoji.'),
  });
  const linkSchema = z.object({
    source: z.string().describe('Page id, ref from this call, or exact title.'),
    target: z.string().describe('Page id, ref from this call, or exact title.'),
    label: z.string().optional().describe('Short lower-case verb phrase, e.g. "uses", "contrasts with".'),
  });

  server.registerTool(
    'add_knowledge',
    {
      title: 'Add knowledge',
      description:
        'Add one or more pages (with nesting) and relations to the knowledge graph in a single call. Pages whose title already exists under the same parent are merged (notes appended) instead of duplicated. Returns the ids of everything written.',
      inputSchema: { workspace: ws, pages: z.array(pageSchema).max(200).default([]), relations: z.array(linkSchema).max(500).default([]) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ workspace, pages, relations }) => {
      const w = await pickWorkspace(ctx, workspace);
      const [nodes, links] = await Promise.all([lightNodes(ctx, w.id), allLinks(ctx, w.id)]);
      const plan = planAddKnowledge(nodes, links, pages, relations);
      const now = Date.now();
      const toAppend = await fullNodes(ctx, w.id, plan.append.map((a) => a.id));
      const updated = plan.append
        .filter((a) => toAppend.has(a.id))
        .map((a) => {
          const n = toAppend.get(a.id)!;
          return {
            ...n,
            content: appendContent(n.content, a.content),
            tags: [...new Set([...n.tags, ...a.tags])],
            sources: [...new Set([...n.sources, ...a.sources])],
            updatedAt: now,
          };
        });
      await upsertNodes(ctx, w.id, [...plan.create, ...updated]);
      await upsertLinks(ctx, w.id, plan.links);
      const tree = buildTree([...nodes, ...plan.create.map((n) => ({ id: n.id, title: n.title, parentId: n.parentId, order: n.order }))]);
      const lines = [
        `Workspace “${w.name}”: created ${plan.create.length} page(s), added notes to ${updated.length} existing page(s), added ${plan.links.length} relation(s).`,
        ...plan.create.map((n) => `+ [${n.id}] ${pathOf(tree, n.id).join(' › ')}`),
        ...updated.map((n) => `~ [${n.id}] ${pathOf(tree, n.id).join(' › ')} (notes appended)`),
        ...plan.links.map((l) => `↔ ${tree.byId.get(l.source)?.title} —${l.label || 'related to'}→ ${tree.byId.get(l.target)?.title}`),
        ...plan.notes.map((x) => `note: ${x}`),
      ];
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'update_page',
    {
      title: 'Update a page',
      description: 'Edit an existing page: rename it, replace or append to its notes, change tags/sources/icon, or move it under another parent.',
      inputSchema: {
        page_id: z.string(),
        workspace: ws,
        title: z.string().min(1).optional(),
        content: z.string().optional().describe('Replaces the notes entirely.'),
        append_content: z.string().optional().describe('Added to the end of the notes.'),
        tags: z.array(z.string()).optional().describe('Replaces the tags.'),
        sources: z.array(z.string()).optional().describe('Replaces the sources.'),
        icon: z.string().optional().describe('Single emoji, or "" to remove.'),
        move_to_parent: z.string().optional().describe('New parent page id, or "" to make it a top-level topic.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (a) => {
      const w = await pickWorkspace(ctx, a.workspace);
      const n = (await fullNodes(ctx, w.id, [a.page_id])).get(a.page_id);
      if (!n) throw new InputError(`No page with id ${a.page_id} in ${w.name}.`);
      const next: NodeData = { ...n, updatedAt: Date.now() };
      if (a.title !== undefined) next.title = a.title.trim().slice(0, 200);
      if (a.content !== undefined) next.content = a.content;
      if (a.append_content) next.content = appendContent(next.content, a.append_content);
      if (a.tags) next.tags = [...new Set(a.tags.map((t) => t.trim().replace(/^#/, '')).filter(Boolean))];
      if (a.sources) next.sources = [...new Set(a.sources.map((t) => t.trim()).filter(Boolean))];
      if (a.icon !== undefined) {
        if (a.icon.trim()) next.icon = a.icon.trim().slice(0, 8);
        else delete next.icon;
      }
      if (a.move_to_parent !== undefined) {
        const tree = buildTree(await lightNodes(ctx, w.id));
        const p = a.move_to_parent.trim() || null;
        if (p && !tree.byId.has(p)) throw new InputError(`No page with id ${p}.`);
        if (p && isSelfOrDescendant(tree, a.page_id, p)) throw new InputError('Cannot move a page inside itself.');
        next.parentId = p;
        const sibs = (tree.children.get(p) ?? []).filter((s) => s !== a.page_id);
        next.order = sibs.length ? Math.max(...sibs.map((s) => tree.byId.get(s)!.order)) + 1 : 1;
      }
      await upsertNodes(ctx, w.id, [next]);
      return text(`Updated [${next.id}] ${next.title}.`);
    },
  );

  server.registerTool(
    'remove_relation',
    {
      title: 'Remove a relation',
      description: 'Remove a relation by its link id (shown by get_page).',
      inputSchema: { link_id: z.string(), workspace: ws },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ link_id, workspace }) => {
      const w = await pickWorkspace(ctx, workspace);
      await tombstone(ctx, 'kg_links', w.id, [link_id]);
      return text(`Removed relation ${link_id}.`);
    },
  );

  server.registerTool(
    'delete_page',
    {
      title: 'Delete a page',
      description:
        'Delete a page. mode "keep_children" (default) moves its sub-pages up to its parent; "with_children" deletes the whole branch. Only use when the user asks — they can still undo it in the app only until the deletion syncs.',
      inputSchema: { page_id: z.string(), workspace: ws, mode: z.enum(['keep_children', 'with_children']).default('keep_children') },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ page_id, workspace, mode }) => {
      const w = await pickWorkspace(ctx, workspace);
      const tree = buildTree(await lightNodes(ctx, w.id));
      const n = tree.byId.get(page_id);
      if (!n) throw new InputError(`No page with id ${page_id} in ${w.name}.`);
      const removed = new Set<string>([page_id]);
      const kids = tree.children.get(page_id) ?? [];
      if (mode === 'with_children') {
        const stack = [...kids];
        while (stack.length) {
          const c = stack.pop()!;
          removed.add(c);
          stack.push(...(tree.children.get(c) ?? []));
        }
      } else if (kids.length) {
        const full = await fullNodes(ctx, w.id, kids);
        const sibs = (tree.children.get(n.parentId) ?? []).filter((s) => s !== page_id);
        let order = sibs.length ? Math.max(...sibs.map((s) => tree.byId.get(s)!.order)) + 1 : 1;
        await upsertNodes(
          ctx,
          w.id,
          kids.filter((k) => full.has(k)).map((k) => ({ ...full.get(k)!, parentId: n.parentId, order: order++, updatedAt: Date.now() })),
        );
      }
      const deadLinks = (await allLinks(ctx, w.id)).filter((l) => removed.has(l.source) || removed.has(l.target)).map((l) => l.id);
      await tombstone(ctx, 'kg_nodes', w.id, [...removed]);
      await tombstone(ctx, 'kg_links', w.id, deadLinks);
      return text(`Deleted “${n.title}”${removed.size > 1 ? ` and ${removed.size - 1} nested page(s)` : ''}${mode === 'keep_children' && kids.length ? `; moved ${kids.length} sub-page(s) up` : ''}.`);
    },
  );

  return server;
}

/* ---------------- HTTP entry ---------------- */

function jsonError(status: number, message: string) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const token = extractToken(req);
  if (!token) return jsonError(401, 'Missing token. Use the connector URL from Knowledge Graph → Account → Connect Claude.');
  let auth: { ownerId: string } | null = null;
  try {
    auth = await authenticate(token);
  } catch {
    return jsonError(503, 'Could not verify the token right now. Try again.');
  }
  if (!auth) return jsonError(401, 'This connector token is invalid, expired or revoked. Create a new one in Knowledge Graph → Account → Connect Claude.');
  // Stateless server: no SSE stream or sessions to resume.
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { ...CORS, Allow: 'POST, OPTIONS' } });

  const server = buildServer({ db: admin, ownerId: auth.ownerId });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(req);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  } catch (err) {
    console.error('mcp error', err);
    return jsonError(500, 'Internal error');
  }
});
