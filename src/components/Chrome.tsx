import { useEffect, useMemo, useRef, useState } from 'react';
import { getIndex, useStore } from '../store/store';
import { ancestors, excerpt, pathTitles } from '../lib/tree';
import { searchNodes } from '../lib/search';
import { closeDialog, Modal } from './Modal';
import type { ViewMode } from '../types';
import { useCloud } from '../lib/cloud';
import { statusText } from './AccountDialog';

/* ---------------- top bar ---------------- */

export function TopBar() {
  const view = useStore((s) => s.view);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const theme = useStore((s) => s.theme);
  const st = useStore.getState();
  const views: { id: ViewMode; label: string; title: string }[] = [
    { id: 'graph', label: 'Graph', title: 'Force-directed network with foldable groups' },
    { id: 'map', label: 'Map', title: 'Zoomable nested circles of the hierarchy' },
    { id: 'tree', label: 'Tree', title: 'Left-to-right mind map' },
  ];
  return (
    <header className="topbar">
      {!sidebarOpen && (
        <button className="icon-btn" title="Show outline" onClick={() => st.setUI({ sidebarOpen: true })}>
          ☰
        </button>
      )}
      <div className="brand" title="Knowledge Graph">
        <svg viewBox="0 0 64 64" width="22" height="22" aria-hidden>
          <g stroke="var(--accent)" strokeWidth="4" fill="none">
            <path d="M32 18 L18 42 M32 18 L46 42 M18 42 L46 42" />
          </g>
          <circle cx="32" cy="18" r="8" fill="var(--accent)" />
          <circle cx="18" cy="42" r="7" fill="#4fd1a5" />
          <circle cx="46" cy="42" r="7" fill="#f6ad55" />
        </svg>
        <span>Knowledge Graph</span>
      </div>
      <nav className="view-switch" aria-label="View">
        {views.map((v) => (
          <button key={v.id} className={view === v.id ? 'on' : ''} title={v.title} onClick={() => st.setUI({ view: v.id })}>
            {v.label}
          </button>
        ))}
      </nav>
      <span className="grow" />
      <button className="btn primary" onClick={() => st.openDialog('ingest')} title="Turn notes, articles or files into pages">
        ＋<span className="hide-sm"> Digest</span>
      </button>
      <div className="tb-group tb-history">
        <button className="icon-btn" disabled={!canUndo} onClick={st.undo} title="Undo (Ctrl+Z)">
          ↶
        </button>
        <button className="icon-btn" disabled={!canRedo} onClick={st.redo} title="Redo (Ctrl+Shift+Z)">
          ↷
        </button>
      </div>
      <div className="tb-group">
        <button className="icon-btn tb-optional" onClick={() => st.setPalette(true)} title="Search (Ctrl+K)">
          🔎
        </button>
        <button className="icon-btn" onClick={() => st.openDialog('health')} title="Graph health & pruning">
          🩺
        </button>
        <button className="icon-btn" onClick={() => st.openDialog('data')} title="Import / export">
          💾
        </button>
        <button className="icon-btn tb-optional" onClick={() => st.setUI({ theme: theme === 'dark' ? 'light' : 'dark' })} title="Toggle theme">
          {theme === 'dark' ? '☀' : '☾'}
        </button>
        <button className="icon-btn" onClick={() => st.openDialog('settings')} title="Settings">
          ⚙
        </button>
        <button className="icon-btn tb-optional" onClick={() => st.openDialog('help')} title="Help & shortcuts (?)">
          ?
        </button>
      </div>
      <AccountButton />
    </header>
  );
}

function AccountButton() {
  const user = useCloud((s) => s.user);
  const displayName = useCloud((s) => s.displayName);
  const status = useCloud((s) => s.status);
  const open = () => useStore.getState().openDialog('account');
  if (!user)
    return (
      <button className="btn small account-btn" onClick={open} title="Sign in to sync your graph across devices">
        ☁ Sign in
      </button>
    );
  const label = (displayName || user.email).trim();
  return (
    <button className={`avatar-btn ${status}`} onClick={open} title={`${user.email} · ${statusText(status)}`}>
      <span className="avatar">{label.slice(0, 1).toUpperCase()}</span>
      <span className="sync-dot" />
    </button>
  );
}

/* ---------------- view toolbar (breadcrumbs + controls) ---------------- */

export function ViewToolbar() {
  const data = useStore((s) => s.data);
  const view = useStore((s) => s.view);
  const focusId = useStore((s) => s.focusId);
  const showLinks = useStore((s) => s.showLinks);
  const showHulls = useStore((s) => s.showHulls);
  const st = useStore.getState();
  const index = getIndex(data.nodes);
  const crumbs = focusId && data.nodes[focusId] ? [...ancestors(data.nodes, focusId), focusId] : [];
  const maxDepth = useMemo(() => {
    let m = 0;
    const base = focusId ? (index.depth.get(focusId) ?? 0) : 0;
    for (const d of index.depth.values()) m = Math.max(m, d - base);
    return Math.min(8, m + 1);
  }, [index, focusId]);

  return (
    <div className="view-toolbar">
      <nav className="focus-crumbs" aria-label="Focus">
        <button className={`crumb ${!focusId ? 'on' : ''}`} onClick={() => st.setFocus(null)} title="Show the whole forest">
          ⌂ All
        </button>
        {crumbs.map((c) => (
          <span key={c} className="crumb-wrap">
            <span className="sep">›</span>
            <button className={`crumb ${c === focusId ? 'on' : ''}`} onClick={() => st.setFocus(c)}>
              {data.nodes[c].icon} {data.nodes[c].title}
            </button>
          </span>
        ))}
      </nav>
      <span className="grow" />
      {view !== 'map' && (
        <div className="vt-group" title="Unfold every group down to this level">
          <span className="muted small">Levels</span>
          {Array.from({ length: Math.max(1, maxDepth) }, (_, i) => i + 1).map((d) => (
            <button key={d} className="chip" onClick={() => st.expandToDepth(d)}>
              {d}
            </button>
          ))}
          <button className="chip" onClick={() => st.collapseAll()} title="Fold everything">
            ⊖
          </button>
        </div>
      )}
      <div className="vt-group">
        <button className={`chip ${showLinks ? 'on' : ''}`} onClick={() => st.setUI({ showLinks: !showLinks })} title="Show relations">
          Relations
        </button>
        {view === 'graph' && (
          <button className={`chip ${showHulls ? 'on' : ''}`} onClick={() => st.setUI({ showHulls: !showHulls })} title="Shade unfolded groups">
            Groups
          </button>
        )}
        {view !== 'map' && (
          <button className="chip" onClick={() => window.dispatchEvent(new Event('kg:fit'))} title="Fit to screen">
            ⤢ Fit
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------------- command palette ---------------- */

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const nodes = useStore((s) => s.data.nodes);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);
  const hits = useMemo(() => (open ? searchNodes(nodes, q, 40) : []), [open, nodes, q]);
  if (!open) return null;
  const st = useStore.getState();
  const close = () => st.setPalette(false);
  const createRow = q.trim() ? 1 : 0;
  const choose = (i: number) => {
    if (i < hits.length) {
      st.reveal(hits[i].id);
    } else if (q.trim()) {
      const parent = st.selectedId;
      st.createNode(parent, { title: q.trim() });
    }
    close();
  };
  return (
    <div className="modal-backdrop top" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="Search">
        <input
          ref={inputRef}
          autoFocus
          placeholder="Search pages, tags and notes… (Enter to open)"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(hits.length - 1 + createRow, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(active);
            } else if (e.key === 'Escape') close();
          }}
        />
        <div className="palette-list">
          {hits.map((h, i) => {
            const n = nodes[h.id];
            return (
              <button key={h.id} className={`palette-item ${i === active ? 'active' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => choose(i)}>
                <span className="pi-title">
                  {n.icon} {n.title}
                </span>
                <span className="pi-path">{h.inContent ? excerpt(n.content, 80) : pathTitles(nodes, h.id).slice(0, -1).join(' › ')}</span>
              </button>
            );
          })}
          {q.trim() && (
            <button className={`palette-item create ${active === hits.length ? 'active' : ''}`} onMouseEnter={() => setActive(hits.length)} onClick={() => choose(hits.length)}>
              <span className="pi-title">＋ Create “{q.trim()}”</span>
              <span className="pi-path">{st.selectedId && nodes[st.selectedId] ? `inside ${nodes[st.selectedId].title}` : 'as a new top-level topic'}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- toasts ---------------- */

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span>{t.text}</span>
          {t.action && (
            <button
              className="link-btn"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="icon-btn tiny" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/* ---------------- help ---------------- */

export function HelpDialog() {
  const rows: [string, string][] = [
    ['Ctrl/⌘ K', 'Search & jump to a page (or create one)'],
    ['N', 'New sub-page of the selected page (new topic if none)'],
    ['Delete', 'Delete the selected page'],
    ['Ctrl/⌘ Z  ·  Ctrl/⌘ Shift Z', 'Undo · redo'],
    ['Esc', 'Close the page / dialog'],
    ['1 · 2 · 3', 'Graph · Map · Tree view'],
    ['Double-click group', 'Fold / unfold it (Graph & Tree)'],
    ['Shift + drag node', 'Draw a relation to another node (Graph)'],
    ['Right-click', 'Actions for a node (any view)'],
    ['Drag in outline', 'Reorder or re-parent pages'],
    ['[[Title]] in notes', 'Wiki link — becomes a dotted relation'],
  ];
  return (
    <Modal title="Help & shortcuts" onClose={closeDialog}>
      <p>
        Organise knowledge as a <b>forest</b>: each page can contain sub-pages (the hierarchy) and link to any other page (relations). Zoom in to see finer detail — unfold groups in the <b>Graph</b>, or click
        into circles in the <b>Map</b>.
      </p>
      <table className="keys">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td>
                <kbd>{k}</kbd>
              </td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Open source ·{' '}
        <a href="https://github.com/Beny-Maleki/Knowledge-Graph" target="_blank" rel="noopener noreferrer">
          github.com/Beny-Maleki/Knowledge-Graph
        </a>
      </p>
    </Modal>
  );
}
