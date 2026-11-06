import { Fragment, useMemo, useState } from 'react';
import type { Proposal, ProposedNode } from '../types';
import { useStore } from '../store/store';
import { excerpt, pathTitles } from '../lib/tree';
import { renderMarkdown } from '../lib/markdown';

interface Props {
  proposal: Proposal;
  onChange: (p: Proposal) => void;
}

/**
 * Review step of the pipeline: shows proposed pages as trees under the
 * existing pages they attach to, merges into existing pages, and links.
 */
export function ProposalReview({ proposal, onChange }: Props) {
  const nodes = useStore((s) => s.data.nodes);
  const [openRef, setOpenRef] = useState<string | null>(null);
  const byRef = useMemo(() => new Map(proposal.nodes.map((n) => [n.ref, n])), [proposal]);
  const kidsOf = useMemo(() => {
    const m = new Map<string, ProposedNode[]>();
    for (const n of proposal.nodes) {
      if (n.mergeInto || !n.parent || !byRef.has(n.parent)) continue;
      m.set(n.parent, [...(m.get(n.parent) ?? []), n]);
    }
    return m;
  }, [proposal, byRef]);
  const anchors = useMemo(() => {
    const m = new Map<string, ProposedNode[]>();
    for (const n of proposal.nodes) {
      if (n.mergeInto) continue;
      if (n.parent && byRef.has(n.parent)) continue;
      const key = n.parent && nodes[n.parent] ? n.parent : '__root__';
      m.set(key, [...(m.get(key) ?? []), n]);
    }
    return m;
  }, [proposal, byRef, nodes]);
  const merges = proposal.nodes.filter((n) => n.mergeInto);

  const descRefs = (ref: string): string[] => {
    const out: string[] = [];
    for (const k of kidsOf.get(ref) ?? []) out.push(k.ref, ...descRefs(k.ref));
    return out;
  };
  const ancRefs = (ref: string): string[] => {
    const out: string[] = [];
    let cur = byRef.get(ref)?.parent;
    while (cur && byRef.has(cur) && !out.includes(cur)) {
      out.push(cur);
      cur = byRef.get(cur)?.parent;
    }
    return out;
  };

  const setAccepted = (ref: string, v: boolean) => {
    const affected = new Set([ref, ...(v ? ancRefs(ref) : descRefs(ref))]);
    onChange({ ...proposal, nodes: proposal.nodes.map((n) => (affected.has(n.ref) ? { ...n, accepted: v } : n)) });
  };
  const setTitle = (ref: string, title: string) => onChange({ ...proposal, nodes: proposal.nodes.map((n) => (n.ref === ref ? { ...n, title } : n)) });
  const setAll = (v: boolean) => onChange({ ...proposal, nodes: proposal.nodes.map((n) => ({ ...n, accepted: v })), links: proposal.links.map((l) => ({ ...l, accepted: v })) });

  const nameOf = (id: string) => byRef.get(id)?.title ?? nodes[id]?.title ?? id;
  const isAcceptedEnd = (id: string) => (byRef.has(id) ? byRef.get(id)!.accepted : !!nodes[id]);

  // A render function (not a component) so inputs keep focus while typing.
  const renderRow = (n: ProposedNode, depth: number): React.ReactNode => (
    <Fragment key={n.ref}>
      <div className={`prop-row ${n.accepted ? '' : 'off'}`} style={{ paddingLeft: 8 + depth * 18 }}>
        <input type="checkbox" checked={n.accepted} onChange={(e) => setAccepted(n.ref, e.target.checked)} aria-label={`Include ${n.title}`} />
        <span className="badge new">new</span>
        <input className="prop-title" value={n.title} onChange={(e) => setTitle(n.ref, e.target.value)} />
        {n.content && (
          <button className="link-btn small" onClick={() => setOpenRef(openRef === n.ref ? null : n.ref)}>
            {openRef === n.ref ? 'hide' : 'notes'}
          </button>
        )}
      </div>
      {openRef === n.ref ? (
        <div className="prop-notes prose" style={{ marginLeft: 34 + depth * 18 }} dangerouslySetInnerHTML={{ __html: renderMarkdown(n.content) }} />
      ) : (
        n.content && (
          <div className="prop-excerpt" style={{ paddingLeft: 34 + depth * 18 }}>
            {excerpt(n.content, 120)}
          </div>
        )
      )}
      {(kidsOf.get(n.ref) ?? []).map((k) => renderRow(k, depth + 1))}
    </Fragment>
  );

  const counts = {
    created: proposal.nodes.filter((n) => n.accepted && !n.mergeInto).length,
    merged: merges.filter((n) => n.accepted).length,
    links: proposal.links.filter((l) => l.accepted && isAcceptedEnd(l.source) && isAcceptedEnd(l.target)).length,
  };

  return (
    <div className="proposal">
      {proposal.summary && <p className="prop-summary">{proposal.summary}</p>}
      <div className="row gap small muted">
        <span>
          {counts.created} new · {counts.merged} updates · {counts.links} links selected
        </span>
        <span className="grow" />
        <button className="link-btn" onClick={() => setAll(true)}>
          select all
        </button>
        <button className="link-btn" onClick={() => setAll(false)}>
          select none
        </button>
      </div>
      {[...anchors.entries()].map(([anchor, list]) => (
        <div key={anchor} className="prop-group">
          <div className="prop-anchor">
            {anchor === '__root__' ? '⌂ New top-level topic' : `📍 ${pathTitles(nodes, anchor).join(' › ')}`}
          </div>
          {list.map((n) => renderRow(n, 0))}
        </div>
      ))}
      {merges.length > 0 && (
        <div className="prop-group">
          <div className="prop-anchor">↪ Additions to existing pages</div>
          {merges.map((n) => (
            <div key={n.ref}>
              <div className={`prop-row ${n.accepted ? '' : 'off'}`}>
                <input type="checkbox" checked={n.accepted} onChange={(e) => setAccepted(n.ref, e.target.checked)} />
                <span className="badge upd">append</span>
                <span className="prop-merge-title">{nodes[n.mergeInto!]?.title}</span>
                {n.content && (
                  <button className="link-btn small" onClick={() => setOpenRef(openRef === n.ref ? null : n.ref)}>
                    {openRef === n.ref ? 'hide' : 'notes'}
                  </button>
                )}
              </div>
              {openRef === n.ref ? (
                <div className="prop-notes prose" style={{ marginLeft: 34 }} dangerouslySetInnerHTML={{ __html: renderMarkdown(n.content) }} />
              ) : (
                n.content && (
                  <div className="prop-excerpt" style={{ paddingLeft: 34 }}>
                    {excerpt(n.content, 120)}
                  </div>
                )
              )}
            </div>
          ))}
        </div>
      )}
      {proposal.links.length > 0 && (
        <div className="prop-group">
          <div className="prop-anchor">🔗 Relations</div>
          {proposal.links.map((l, i) => {
            const usable = isAcceptedEnd(l.source) && isAcceptedEnd(l.target);
            return (
              <label key={i} className={`prop-row link ${l.accepted && usable ? '' : 'off'}`}>
                <input
                  type="checkbox"
                  checked={l.accepted}
                  disabled={!usable}
                  onChange={(e) => onChange({ ...proposal, links: proposal.links.map((x, j) => (j === i ? { ...x, accepted: e.target.checked } : x)) })}
                />
                <span className="prop-link">
                  <b>{nameOf(l.source)}</b> <span className="muted">— {l.label || 'related to'} →</span> <b>{nameOf(l.target)}</b>
                </span>
              </label>
            );
          })}
        </div>
      )}
      {!proposal.nodes.length && !proposal.links.length && <p className="muted">Nothing was proposed.</p>}
    </div>
  );
}

export function proposalCounts(p: Proposal) {
  return {
    created: p.nodes.filter((n) => n.accepted && !n.mergeInto).length,
    merged: p.nodes.filter((n) => n.accepted && n.mergeInto).length,
    links: p.links.filter((l) => l.accepted).length,
  };
}
