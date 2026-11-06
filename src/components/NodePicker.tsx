import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { useStore } from '../store/store';
import { searchNodes } from '../lib/search';
import { isSelfOrDescendant, pathTitles } from '../lib/tree';

export interface PickOptions {
  title: string;
  exclude?: string[];
  excludeSubtreeOf?: string;
  allowRoot?: boolean;
  withLabel?: boolean;
}

export interface PickResult {
  /** null = top level (only when allowRoot) */
  id: string | null;
  label?: string;
}

interface PickerState {
  opts: PickOptions | null;
  resolve: ((r: PickResult | undefined) => void) | null;
}

const usePicker = create<PickerState>(() => ({ opts: null, resolve: null }));

/** Promise-based modal for choosing a node (resolves undefined on cancel). */
export function pickNode(opts: PickOptions): Promise<PickResult | undefined> {
  return new Promise((resolve) => {
    usePicker.getState().resolve?.(undefined);
    usePicker.setState({ opts, resolve });
  });
}

const LABEL_SUGGESTIONS = ['related to', 'uses', 'depends on', 'is an example of', 'contrasts with', 'causes', 'part of', 'see also'];

export function NodePickerHost() {
  const { opts, resolve } = usePicker();
  const nodes = useStore((s) => s.data.nodes);
  const [q, setQ] = useState('');
  const [label, setLabel] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (opts) {
      setQ('');
      setLabel('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [opts]);

  const items = useMemo(() => {
    if (!opts) return [];
    const ex = new Set(opts.exclude ?? []);
    const hits = searchNodes(nodes, q, 80).filter(
      (h) => !ex.has(h.id) && !(opts.excludeSubtreeOf && isSelfOrDescendant(nodes, opts.excludeSubtreeOf, h.id)),
    );
    const list: { id: string | null; title: string; path: string }[] = hits.map((h) => ({
      id: h.id,
      title: `${nodes[h.id].icon ? nodes[h.id].icon + ' ' : ''}${nodes[h.id].title}`,
      path: pathTitles(nodes, h.id).slice(0, -1).join(' › '),
    }));
    if (opts.allowRoot && (!q || 'top level root'.includes(q.toLowerCase()))) list.unshift({ id: null, title: '⌂ Top level (new tree)', path: '' });
    return list.slice(0, 60);
  }, [opts, nodes, q]);

  if (!opts) return null;
  const close = (r?: PickResult) => {
    resolve?.(r);
    usePicker.setState({ opts: null, resolve: null });
  };
  const choose = (i: number) => {
    const it = items[i];
    if (it) close({ id: it.id, label: label.trim() });
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal picker" role="dialog" aria-label={opts.title}>
        <div className="modal-head">
          <h3>{opts.title}</h3>
          <button className="icon-btn" onClick={() => close()} aria-label="Close">
            ✕
          </button>
        </div>
        {opts.withLabel && (
          <div className="picker-label">
            <input placeholder="Relation label (optional), e.g. “uses”" value={label} onChange={(e) => setLabel(e.target.value)} list="kg-label-suggest" />
            <datalist id="kg-label-suggest">
              {LABEL_SUGGESTIONS.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </div>
        )}
        <input
          ref={inputRef}
          className="picker-search"
          placeholder="Search pages…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(items.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(active);
            } else if (e.key === 'Escape') close();
          }}
        />
        <div className="picker-list">
          {items.map((it, i) => (
            <button key={it.id ?? 'root'} className={`picker-item ${i === active ? 'active' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => choose(i)}>
              <span className="pi-title">{it.title}</span>
              {it.path && <span className="pi-path">{it.path}</span>}
            </button>
          ))}
          {!items.length && <div className="empty">No matching pages</div>}
        </div>
      </div>
    </div>
  );
}
