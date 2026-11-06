import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { getIndex, useStore } from '../store/store';
import { pickNode } from './NodePicker';
import { confirmDialog } from './Confirm';

interface MenuState {
  nodeId: string | null;
  x: number;
  y: number;
}

const useMenu = create<MenuState>(() => ({ nodeId: null, x: 0, y: 0 }));

export function openNodeMenu(nodeId: string, x: number, y: number) {
  useMenu.setState({ nodeId, x, y });
}

export function closeNodeMenu() {
  useMenu.setState({ nodeId: null });
}

/** Shared actions used by the context menu, page panel and keyboard shortcuts. */
export const nodeActions = {
  addChild(id: string | null) {
    useStore.getState().createNode(id);
  },
  addSibling(id: string) {
    const st = useStore.getState();
    const n = st.data.nodes[id];
    if (!n) return;
    const sibs = getIndex(st.data.nodes).children.get(n.parentId ?? '__root__') ?? [];
    const next = sibs[sibs.indexOf(id) + 1];
    const newId = st.createNode(n.parentId);
    if (next) st.moveNode(newId, n.parentId, next);
  },
  async linkTo(id: string) {
    const st = useStore.getState();
    const target = await pickNode({ title: `Link “${st.data.nodes[id]?.title}” to…`, exclude: [id], withLabel: true });
    if (!target || target.id === null) return;
    const linkId = useStore.getState().addLink(id, target.id, target.label ?? '');
    if (linkId) useStore.getState().toast('Link added', 'success');
  },
  async moveTo(id: string) {
    const st = useStore.getState();
    const target = await pickNode({ title: `Move “${st.data.nodes[id]?.title}” under…`, exclude: [id], excludeSubtreeOf: id, allowRoot: true });
    if (!target) return;
    if (!useStore.getState().moveNode(id, target.id)) useStore.getState().toast('Cannot move a node into its own subtree', 'error');
    else useStore.getState().reveal(id);
  },
  async mergeInto(id: string) {
    const st = useStore.getState();
    const target = await pickNode({ title: `Merge “${st.data.nodes[id]?.title}” into…`, exclude: [id] });
    if (!target || !target.id) return;
    useStore.getState().mergeNodes(id, target.id);
  },
  async remove(id: string) {
    const st = useStore.getState();
    const n = st.data.nodes[id];
    if (!n) return;
    const count = getIndex(st.data.nodes).descCount.get(id) ?? 0;
    if (count === 0) {
      st.deleteNode(id, 'subtree');
      return;
    }
    const choice = await confirmDialog({
      title: `Delete “${n.title}”?`,
      body: `This page contains ${count} nested page${count > 1 ? 's' : ''}.`,
      actions: [
        { id: 'lift', label: 'Delete page, keep children' },
        { id: 'subtree', label: `Delete all ${count + 1} pages`, danger: true },
      ],
    });
    if (choice === 'lift' || choice === 'subtree') st.deleteNode(id, choice);
  },
};

export function ContextMenuHost() {
  const { nodeId, x, y } = useMenu();
  const data = useStore((s) => s.data);
  const expanded = useStore((s) => s.expanded);
  const focusId = useStore((s) => s.focusId);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    if (!nodeId || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
  }, [nodeId, x, y]);

  useEffect(() => {
    if (!nodeId) return;
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      closeNodeMenu();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && closeNodeMenu();
    window.addEventListener('mousedown', close, true);
    window.addEventListener('wheel', close, true);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('wheel', close, true);
      window.removeEventListener('keydown', esc);
    };
  }, [nodeId]);

  if (!nodeId || !data.nodes[nodeId]) return null;
  const n = data.nodes[nodeId];
  const index = getIndex(data.nodes);
  const hasKids = (index.descCount.get(nodeId) ?? 0) > 0;
  const st = useStore.getState();
  const run = (fn: () => void) => () => {
    closeNodeMenu();
    fn();
  };

  return (
    <div className="ctx-menu" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu">
      <div className="ctx-title">
        {n.icon} {n.title}
      </div>
      <button role="menuitem" onClick={run(() => st.select(nodeId))}>
        Open page
      </button>
      <button role="menuitem" onClick={run(() => nodeActions.addChild(nodeId))}>
        Add sub-page
      </button>
      <button role="menuitem" onClick={run(() => nodeActions.addSibling(nodeId))}>
        Add sibling page
      </button>
      <hr />
      {hasKids && nodeId !== focusId && (
        <button role="menuitem" onClick={run(() => st.toggleExpanded(nodeId))}>
          {expanded[nodeId] ? 'Fold group' : 'Unfold group'}
        </button>
      )}
      {hasKids && (
        <button
          role="menuitem"
          onClick={run(() => {
            const exp = { ...useStore.getState().expanded };
            exp[nodeId] = true;
            for (const d of [nodeId, ...collectDesc(index, nodeId)]) if ((index.children.get(d)?.length ?? 0) > 0) exp[d] = true;
            useStore.setState({ expanded: exp });
          })}
        >
          Unfold everything inside
        </button>
      )}
      {hasKids && nodeId !== focusId && (
        <button role="menuitem" onClick={run(() => st.setFocus(nodeId))}>
          Dive in (focus)
        </button>
      )}
      <hr />
      <button role="menuitem" onClick={run(() => st.openDialog('ingest', nodeId))}>
        ＋ Digest notes into this…
      </button>
      <button role="menuitem" onClick={run(() => st.openDialog('expand', nodeId))}>
        ✨ Expand with AI…
      </button>
      <button role="menuitem" onClick={run(() => st.openDialog('draft', nodeId))}>
        ✨ Write page with AI…
      </button>
      {hasKids && (
        <button role="menuitem" onClick={run(() => st.openDialog('review', nodeId))}>
          ✨ Review this branch…
        </button>
      )}
      <hr />
      <button role="menuitem" onClick={run(() => nodeActions.linkTo(nodeId))}>
        Link to…
      </button>
      <button role="menuitem" onClick={run(() => nodeActions.moveTo(nodeId))}>
        Move to…
      </button>
      <button role="menuitem" onClick={run(() => nodeActions.mergeInto(nodeId))}>
        Merge into…
      </button>
      <button role="menuitem" className="danger" onClick={run(() => nodeActions.remove(nodeId))}>
        Delete…
      </button>
    </div>
  );
}

function collectDesc(index: ReturnType<typeof getIndex>, id: string): string[] {
  const out: string[] = [];
  const stack = [...(index.children.get(id) ?? [])];
  while (stack.length) {
    const c = stack.pop()!;
    out.push(c);
    stack.push(...(index.children.get(c) ?? []));
  }
  return out;
}
