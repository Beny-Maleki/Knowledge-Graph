import { create } from 'zustand';
import type { GraphData, KNode, Proposal, PruneOp, ViewMode } from '../types';
import * as ops from '../lib/ops';
import { ancestors, buildIndex, makeNode, nextOrder } from '../lib/tree';

const HISTORY_LIMIT = 100;
const COALESCE_MS = 1200;

export type DialogKind = null | 'ingest' | 'settings' | 'data' | 'health' | 'help' | 'expand' | 'draft' | 'review';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'error';
  action?: { label: string; run: () => void };
}

export interface UIState {
  view: ViewMode;
  selectedId: string | null;
  /** "Dive in" root shared by all views (null = whole forest). */
  focusId: string | null;
  /** Expanded groups in the graph & tree views. */
  expanded: Record<string, true>;
  /** Expanded rows in the sidebar outline. */
  outlineOpen: Record<string, true>;
  sidebarOpen: boolean;
  panelWide: boolean;
  showLinks: boolean;
  showHulls: boolean;
  showLabels: boolean;
  theme: 'dark' | 'light';
}

interface State extends UIState {
  data: GraphData;
  workspaceName: string;
  loaded: boolean;
  past: GraphData[];
  future: GraphData[];
  lastCommit: { key: string; at: number } | null;
  /** Bumped to ask the active view to centre on a node. */
  centerRequest: { id: string; nonce: number } | null;
  /** Recently created nodes, briefly highlighted. */
  flash: Record<string, true>;
  dialog: DialogKind;
  dialogArg: string | null;
  paletteOpen: boolean;
  toasts: Toast[];
  /** Node id to edit-title-on-open (fresh nodes). */
  editTitleOf: string | null;

  // data mutations
  commit: (next: GraphData, coalesceKey?: string) => void;
  createNode: (parentId: string | null, partial?: Partial<KNode>, opts?: { select?: boolean }) => string;
  updateNode: (id: string, patch: Partial<KNode>) => void;
  deleteNode: (id: string, mode: 'subtree' | 'lift') => void;
  moveNode: (id: string, parentId: string | null, beforeId?: string | null) => boolean;
  addLink: (source: string, target: string, label?: string) => string | null;
  updateLinkLabel: (id: string, label: string) => void;
  removeLink: (id: string) => void;
  mergeNodes: (sourceId: string, targetId: string) => void;
  applyProposal: (p: Proposal) => ops.ApplyResult;
  applyPruneOps: (o: PruneOp[]) => number;
  replaceData: (data: GraphData, name?: string) => void;
  mergeData: (data: GraphData) => void;
  undo: () => void;
  redo: () => void;
  setWorkspaceName: (name: string) => void;

  // UI
  setUI: (patch: Partial<UIState>) => void;
  select: (id: string | null) => void;
  reveal: (id: string, opts?: { center?: boolean; select?: boolean }) => void;
  setFocus: (id: string | null) => void;
  toggleExpanded: (id: string, value?: boolean) => void;
  expandToDepth: (depth: number) => void;
  collapseAll: () => void;
  toggleOutline: (id: string, value?: boolean) => void;
  openDialog: (d: DialogKind, arg?: string | null) => void;
  setPalette: (open: boolean) => void;
  toast: (text: string, kind?: Toast['kind'], action?: Toast['action']) => void;
  dismissToast: (id: number) => void;
  flashNodes: (ids: string[]) => void;
  setLoaded: (data: GraphData, name: string, ui?: Partial<UIState>) => void;
  clearEditTitle: () => void;
}

let toastSeq = 1;

const prefersDark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches === false;

export const useStore = create<State>()((set, get) => ({
  data: { nodes: {}, links: {} },
  workspaceName: 'My knowledge',
  loaded: false,
  past: [],
  future: [],
  lastCommit: null,
  centerRequest: null,
  flash: {},
  dialog: null,
  dialogArg: null,
  paletteOpen: false,
  toasts: [],
  editTitleOf: null,

  view: 'graph',
  selectedId: null,
  focusId: null,
  expanded: {},
  outlineOpen: {},
  sidebarOpen: typeof window === 'undefined' ? true : window.innerWidth > 900,
  panelWide: false,
  showLinks: true,
  showHulls: true,
  showLabels: true,
  theme: prefersDark ? 'dark' : 'light',

  commit: (next, coalesceKey) => {
    const { data, past, lastCommit } = get();
    if (next === data) return;
    const now = Date.now();
    const coalesce = coalesceKey && lastCommit && lastCommit.key === coalesceKey && now - lastCommit.at < COALESCE_MS;
    set({
      data: next,
      past: coalesce ? past : [...past, data].slice(-HISTORY_LIMIT),
      future: [],
      lastCommit: coalesceKey ? { key: coalesceKey, at: now } : null,
    });
    // Drop UI references to nodes that no longer exist.
    const s = get();
    const patch: Partial<State> = {};
    if (s.selectedId && !next.nodes[s.selectedId]) patch.selectedId = null;
    if (s.focusId && !next.nodes[s.focusId]) patch.focusId = null;
    if (Object.keys(patch).length) set(patch);
  },

  createNode: (parentId, partial = {}, opts = { select: true }) => {
    const { data } = get();
    const index = buildIndex(data.nodes);
    const node = makeNode({ title: 'Untitled', ...partial, parentId, order: partial.order ?? nextOrder(data.nodes, index, parentId) });
    get().commit(ops.addNode(data, node));
    if (parentId) {
      const exp = { ...get().expanded, [parentId]: true as const };
      const out = { ...get().outlineOpen, [parentId]: true as const };
      for (const a of ancestors(get().data.nodes, parentId)) {
        exp[a] = true;
        out[a] = true;
      }
      set({ expanded: exp, outlineOpen: out });
    }
    get().flashNodes([node.id]);
    if (opts.select) set({ selectedId: node.id, editTitleOf: node.id });
    return node.id;
  },

  updateNode: (id, patch) => {
    const key = `upd:${id}:${Object.keys(patch).sort().join(',')}`;
    get().commit(ops.updateNode(get().data, id, patch), key);
  },

  deleteNode: (id, mode) => {
    const before = get().data;
    const title = before.nodes[id]?.title ?? 'node';
    get().commit(ops.deleteNode(before, id, mode));
    get().toast(`Deleted “${title}”`, 'info', { label: 'Undo', run: () => get().undo() });
  },

  moveNode: (id, parentId, beforeId) => {
    const before = get().data;
    const next = ops.moveNode(before, id, parentId, beforeId);
    if (next === before) return false;
    get().commit(next);
    if (parentId) set({ outlineOpen: { ...get().outlineOpen, [parentId]: true } });
    return true;
  },

  addLink: (source, target, label = '') => {
    const r = ops.addLink(get().data, source, target, label);
    get().commit(r.data);
    return r.link?.id ?? null;
  },

  updateLinkLabel: (id, label) => get().commit(ops.updateLink(get().data, id, { label }), `link:${id}`),
  removeLink: (id) => get().commit(ops.removeLink(get().data, id)),

  mergeNodes: (sourceId, targetId) => {
    const d = get().data;
    const st = d.nodes[sourceId]?.title;
    const tt = d.nodes[targetId]?.title;
    get().commit(ops.mergeNodes(d, sourceId, targetId));
    if (get().selectedId === null || get().selectedId === sourceId) set({ selectedId: targetId });
    get().toast(`Merged “${st}” into “${tt}”`, 'success', { label: 'Undo', run: () => get().undo() });
  },

  applyProposal: (p) => {
    const r = ops.applyProposal(get().data, p);
    get().commit(r.data);
    // Expand the branches that received new material so it is visible.
    const nodes = r.data.nodes;
    const exp = { ...get().expanded };
    const out = { ...get().outlineOpen };
    for (const id of [...r.created, ...r.updated]) {
      for (const a of ancestors(nodes, id)) {
        exp[a] = true;
        out[a] = true;
      }
    }
    set({ expanded: exp, outlineOpen: out });
    get().flashNodes([...r.created, ...r.updated]);
    return r;
  },

  applyPruneOps: (o) => {
    const r = ops.applyPruneOps(get().data, o);
    get().commit(r.data);
    get().flashNodes(r.createdGroups);
    return r.applied;
  },

  replaceData: (data, name) => {
    get().commit(data);
    set({ selectedId: null, focusId: null, expanded: {}, outlineOpen: {}, ...(name ? { workspaceName: name } : {}) });
  },

  mergeData: (incoming) => get().commit(ops.mergeWorkspaces(get().data, incoming)),

  undo: () => {
    const { past, data, future } = get();
    if (!past.length) return;
    set({ data: past[past.length - 1], past: past.slice(0, -1), future: [data, ...future].slice(0, HISTORY_LIMIT), lastCommit: null });
    const s = get();
    if (s.selectedId && !s.data.nodes[s.selectedId]) set({ selectedId: null });
    if (s.focusId && !s.data.nodes[s.focusId]) set({ focusId: null });
  },

  redo: () => {
    const { past, data, future } = get();
    if (!future.length) return;
    set({ data: future[0], future: future.slice(1), past: [...past, data].slice(-HISTORY_LIMIT), lastCommit: null });
    const s = get();
    if (s.selectedId && !s.data.nodes[s.selectedId]) set({ selectedId: null });
    if (s.focusId && !s.data.nodes[s.focusId]) set({ focusId: null });
  },

  setWorkspaceName: (name) => set({ workspaceName: name }),

  setUI: (patch) => set(patch),

  select: (id) => {
    set({ selectedId: id });
    if (id) {
      const out = { ...get().outlineOpen };
      let changed = false;
      for (const a of ancestors(get().data.nodes, id)) {
        if (!out[a]) {
          out[a] = true;
          changed = true;
        }
      }
      if (changed) set({ outlineOpen: out });
    }
  },

  reveal: (id, opts = { center: true, select: true }) => {
    const { data, focusId } = get();
    if (!data.nodes[id]) return;
    const anc = ancestors(data.nodes, id);
    // If the node lives outside the current focus, widen the focus.
    let focus = focusId;
    if (focus && focus !== id && !anc.includes(focus)) focus = null;
    const exp = { ...get().expanded };
    const out = { ...get().outlineOpen };
    for (const a of anc) {
      exp[a] = true;
      out[a] = true;
    }
    set({
      focusId: focus,
      expanded: exp,
      outlineOpen: out,
      ...(opts.select !== false ? { selectedId: id } : {}),
      ...(opts.center !== false ? { centerRequest: { id, nonce: Date.now() } } : {}),
    });
  },

  setFocus: (id) => {
    if (id) set({ expanded: { ...get().expanded, [id]: true } });
    set({ focusId: id });
  },

  toggleExpanded: (id, value) => {
    const exp = { ...get().expanded };
    const v = value ?? !exp[id];
    if (v) exp[id] = true;
    else delete exp[id];
    set({ expanded: exp });
  },

  expandToDepth: (depth) => {
    const { data, focusId } = get();
    const index = buildIndex(data.nodes);
    const base = focusId ? (index.depth.get(focusId) ?? 0) + 1 : 0;
    const exp: Record<string, true> = {};
    for (const [id, d] of index.depth) {
      if (d - base < depth - 1 && (index.children.get(id)?.length ?? 0) > 0) exp[id] = true;
    }
    if (focusId) {
      exp[focusId] = true;
      for (const a of ancestors(data.nodes, focusId)) exp[a] = true;
    }
    set({ expanded: exp });
  },

  collapseAll: () => {
    const { focusId, data } = get();
    const exp: Record<string, true> = {};
    if (focusId) {
      exp[focusId] = true;
      for (const a of ancestors(data.nodes, focusId)) exp[a] = true;
    }
    set({ expanded: exp });
  },

  toggleOutline: (id, value) => {
    const out = { ...get().outlineOpen };
    const v = value ?? !out[id];
    if (v) out[id] = true;
    else delete out[id];
    set({ outlineOpen: out });
  },

  openDialog: (d, arg = null) => set({ dialog: d, dialogArg: arg }),
  setPalette: (open) => set({ paletteOpen: open }),

  toast: (text, kind = 'info', action) => {
    const id = toastSeq++;
    set({ toasts: [...get().toasts, { id, text, kind, action }].slice(-4) });
    setTimeout(() => get().dismissToast(id), action ? 7000 : 4000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  flashNodes: (ids) => {
    if (!ids.length) return;
    const f = { ...get().flash };
    for (const id of ids) f[id] = true;
    set({ flash: f });
    setTimeout(() => {
      const cur = { ...get().flash };
      for (const id of ids) delete cur[id];
      set({ flash: cur });
    }, 4000);
  },

  setLoaded: (data, name, ui) => set({ data, workspaceName: name, loaded: true, past: [], future: [], ...(ui ?? {}) }),
  clearEditTitle: () => set({ editTitleOf: null }),
}));

/** Memoised tree index for the current data (recomputed only when nodes change). */
let idxCache: { nodes: GraphData['nodes']; index: ReturnType<typeof buildIndex> } | null = null;
export function getIndex(nodes: GraphData['nodes']) {
  if (!idxCache || idxCache.nodes !== nodes) idxCache = { nodes, index: buildIndex(nodes) };
  return idxCache.index;
}
export function useIndex() {
  const nodes = useStore((s) => s.data.nodes);
  return getIndex(nodes);
}
