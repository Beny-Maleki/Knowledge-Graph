import { useState } from 'react';
import { getIndex, useStore } from '../store/store';
import { childrenOf, nodeColor } from '../lib/tree';
import { openNodeMenu } from './ContextMenu';
import { switchWorkspace, useCloud } from '../lib/cloud';

/** Signed in: pick which cloud workspace is shown. Signed out: hint that sync exists. */
function WorkspaceSwitcher() {
  const user = useCloud((s) => s.user);
  const workspaces = useCloud((s) => s.workspaces);
  const activeId = useCloud((s) => s.activeWorkspaceId);
  const access = useCloud((s) => s.access);
  const openAccount = () => useStore.getState().openDialog('account');
  if (!user)
    return (
      <button className="ws-hint" onClick={openAccount} title="Create a free account to keep this graph in sync on all your devices">
        Saved in this browser only · <u>sign in to sync</u>
      </button>
    );
  if (access !== 'ok' && access !== 'unknown')
    return (
      <button className="ws-hint" onClick={openAccount}>
        {access === 'pending' ? 'Account waiting for approval · this browser only' : 'Finish two-factor sign-in to sync'} · <u>details</u>
      </button>
    );
  return (
    <div className="ws-switch">
      <span aria-hidden>☁</span>
      <select
        aria-label="Workspace"
        value={activeId ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '__manage') openAccount();
          else void switchWorkspace(v).catch((err) => useStore.getState().toast(String(err?.message ?? err), 'error'));
        }}
      >
        {!workspaces.some((w) => w.id === activeId) && <option value={activeId ?? ''}>Loading…</option>}
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
        <option value="__manage">Manage workspaces…</option>
      </select>
    </div>
  );
}

type DropPos = 'before' | 'inside' | 'after';

export function Sidebar() {
  const data = useStore((s) => s.data);
  const name = useStore((s) => s.workspaceName);
  const open = useStore((s) => s.sidebarOpen);
  const index = getIndex(data.nodes);
  const st = useStore.getState();
  const [drag, setDrag] = useState<string | null>(null);
  const [rootDrop, setRootDrop] = useState(false);
  const total = Object.keys(data.nodes).length;
  const links = Object.keys(data.links).length;

  if (!open) return null;
  return (
    <>
      <div className="sidebar-scrim" onClick={() => st.setUI({ sidebarOpen: false })} />
      <aside className="sidebar" aria-label="Outline">
        <div className="side-head">
          <input className="ws-name" value={name} onChange={(e) => st.setWorkspaceName(e.target.value)} aria-label="Workspace name" />
          <button className="icon-btn" title="Hide sidebar" onClick={() => st.setUI({ sidebarOpen: false })}>
            ⟨
          </button>
        </div>
        <WorkspaceSwitcher />
        <button className="search-btn" onClick={() => st.setPalette(true)}>
          <span>🔎 Search pages…</span>
          <kbd>Ctrl K</kbd>
        </button>
        <div className="side-section-head">
          <span>Outline</span>
          <button className="btn tiny" onClick={() => st.createNode(null)} title="New top-level topic">
            + Topic
          </button>
        </div>
        <div
          className={`outline ${rootDrop ? 'root-drop' : ''}`}
          onDragOver={(e) => {
            if (!drag) return;
            if (e.target === e.currentTarget) {
              e.preventDefault();
              setRootDrop(true);
            }
          }}
          onDragLeave={() => setRootDrop(false)}
          onDrop={(e) => {
            if (e.target === e.currentTarget && drag) {
              e.preventDefault();
              st.moveNode(drag, null);
            }
            setRootDrop(false);
            setDrag(null);
          }}
          role="tree"
        >
          {index.roots.map((r) => (
            <Row key={r} id={r} depth={0} drag={drag} setDrag={setDrag} />
          ))}
          {!index.roots.length && <p className="muted small pad">Nothing here yet. Add a topic or use Digest to import notes.</p>}
        </div>
        <div className="side-foot muted small">
          {total} pages · {links} links
        </div>
      </aside>
    </>
  );
}

function Row({ id, depth, drag, setDrag }: { id: string; depth: number; drag: string | null; setDrag: (v: string | null) => void }) {
  const node = useStore((s) => s.data.nodes[id]);
  const nodes = useStore((s) => s.data.nodes);
  const isOpen = useStore((s) => !!s.outlineOpen[id]);
  const selected = useStore((s) => s.selectedId === id);
  const isFocus = useStore((s) => s.focusId === id);
  const flash = useStore((s) => !!s.flash[id]);
  const index = getIndex(nodes);
  const [drop, setDrop] = useState<DropPos | null>(null);
  const st = useStore.getState();
  if (!node) return null;
  const kids = childrenOf(index, id);

  const onDragOver = (e: React.DragEvent) => {
    if (!drag || drag === id) return;
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = e.clientY - r.top;
    setDrop(y < r.height * 0.28 ? 'before' : y > r.height * 0.72 ? 'after' : 'inside');
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const pos = drop;
    setDrop(null);
    if (!drag || !pos || drag === id) return;
    let ok = false;
    if (pos === 'inside') ok = st.moveNode(drag, id);
    else {
      const sibs = childrenOf(index, node.parentId).filter((s) => s !== drag);
      const before = pos === 'before' ? id : (sibs[sibs.indexOf(id) + 1] ?? null);
      ok = st.moveNode(drag, node.parentId, before);
    }
    if (!ok) st.toast('Cannot move a page into itself', 'error');
    setDrag(null);
  };

  return (
    <div role="treeitem" aria-expanded={kids.length ? isOpen : undefined} aria-selected={selected}>
      <div
        className={`row-item ${selected ? 'selected' : ''} ${drop ? 'drop-' + drop : ''} ${flash ? 'flash' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', node.title);
          setDrag(id);
        }}
        onDragEnd={() => {
          setDrag(null);
          setDrop(null);
        }}
        onDragOver={onDragOver}
        onDragLeave={() => setDrop(null)}
        onDrop={onDrop}
        onClick={() => st.reveal(id)}
        onContextMenu={(e) => {
          e.preventDefault();
          openNodeMenu(id, e.clientX, e.clientY);
        }}
      >
        <button
          className={`twisty ${kids.length ? '' : 'none'}`}
          onClick={(e) => {
            e.stopPropagation();
            if (kids.length) st.toggleOutline(id);
          }}
          aria-label={isOpen ? 'Collapse' : 'Expand'}
          tabIndex={-1}
        >
          {kids.length ? (isOpen ? '▾' : '▸') : '•'}
        </button>
        <span className="row-icon" style={{ color: nodeColor(nodes, index, id) }}>
          {node.icon || '●'}
        </span>
        <span className="row-title">{node.title || 'Untitled'}</span>
        {isFocus && <span className="badge">focus</span>}
        {kids.length > 0 && !isOpen && <span className="row-count">{index.descCount.get(id)}</span>}
        <span className="row-actions">
          <button
            title="Add sub-page"
            onClick={(e) => {
              e.stopPropagation();
              st.createNode(id);
            }}
          >
            +
          </button>
          <button
            title="More"
            onClick={(e) => {
              e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              openNodeMenu(id, r.left, r.bottom);
            }}
          >
            ⋯
          </button>
        </span>
      </div>
      {isOpen && kids.length > 0 && (
        <div role="group">
          {kids.map((k) => (
            <Row key={k} id={k} depth={depth + 1} drag={drag} setDrag={setDrag} />
          ))}
        </div>
      )}
    </div>
  );
}
