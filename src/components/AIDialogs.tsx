import { useState } from 'react';
import type { Proposal, PruneOp } from '../types';
import { useStore } from '../store/store';
import { AIRequired, AIStatus, closeDialog, Modal, useAITask } from './Modal';
import { ProposalReview, proposalCounts } from './ProposalReview';
import { draftPage, expand, reviewBranch } from '../lib/pipeline';
import { aiReady, useSettings } from '../lib/settings';
import { pathTitles } from '../lib/tree';
import { renderMarkdown } from '../lib/markdown';

/* ---------------- Expand ---------------- */

export function ExpandDialog() {
  const id = useStore((s) => s.dialogArg);
  const node = useStore((s) => (id ? s.data.nodes[id] : undefined));
  const ai = useSettings((s) => s.ai);
  const [count, setCount] = useState(5);
  const [depth, setDepth] = useState<1 | 2>(1);
  const [withLinks, setWithLinks] = useState(true);
  const [instructions, setInstructions] = useState('');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const task = useAITask<Proposal>();
  if (!id || !node) return null;

  const run = async () => {
    const p = await task.run((signal, onProgress) => expand(useStore.getState().data, { nodeId: id, count, depth, instructions, withLinks }, { signal, onProgress }));
    if (p) setProposal(p);
  };
  const apply = () => {
    if (!proposal) return;
    const r = useStore.getState().applyProposal(proposal);
    useStore.getState().setUI({ expanded: { ...useStore.getState().expanded, [id]: true } });
    useStore.getState().toast(`Added ${r.created.length} sub-page${r.created.length === 1 ? '' : 's'} and ${r.linksAdded} link${r.linksAdded === 1 ? '' : 's'}`, 'success', {
      label: 'Undo',
      run: () => useStore.getState().undo(),
    });
    useStore.getState().reveal(id);
    closeDialog();
  };

  if (proposal) {
    const c = proposalCounts(proposal);
    return (
      <Modal
        title={`Expand “${node.title}”`}
        onClose={closeDialog}
        wide
        footer={
          <>
            <button className="btn" onClick={() => setProposal(null)}>
              ← Back
            </button>
            <button className="btn" onClick={run} disabled={task.running}>
              ↻ Try again
            </button>
            <span className="grow" />
            <button className="btn primary" disabled={c.created + c.merged + c.links === 0} onClick={apply}>
              Add to graph
            </button>
          </>
        }
      >
        <AIStatus task={task as never} />
        <ProposalReview proposal={proposal} onChange={setProposal} />
      </Modal>
    );
  }

  return (
    <Modal
      title={`✨ Expand “${node.title}”`}
      onClose={closeDialog}
      footer={
        <>
          <span className="grow" />
          <button className="btn" onClick={closeDialog}>
            Cancel
          </button>
          <button className="btn primary" onClick={run} disabled={task.running || !aiReady(ai)}>
            Suggest sub-topics
          </button>
        </>
      }
    >
      <p className="muted small">{pathTitles(useStore.getState().data.nodes, id).join(' › ')}</p>
      <AIRequired />
      <div className="opt-grid">
        <label>How many</label>
        <div className="seg">
          {[3, 5, 8, 12].map((n) => (
            <button key={n} className={count === n ? 'on' : ''} onClick={() => setCount(n)}>
              {n}
            </button>
          ))}
        </div>
        <label>Depth</label>
        <div className="seg">
          <button className={depth === 1 ? 'on' : ''} onClick={() => setDepth(1)}>
            One level
          </button>
          <button className={depth === 2 ? 'on' : ''} onClick={() => setDepth(2)}>
            Two levels
          </button>
        </div>
        <label>Relations</label>
        <label className="check">
          <input type="checkbox" checked={withLinks} onChange={(e) => setWithLinks(e.target.checked)} /> Also suggest links to related pages I already have
        </label>
        <label>Focus</label>
        <input placeholder="Optional, e.g. “from an exam-prep angle” or “practical applications”" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      </div>
      <AIStatus task={task as never} />
    </Modal>
  );
}

/* ---------------- Draft page ---------------- */

export function DraftDialog() {
  const id = useStore((s) => s.dialogArg);
  const node = useStore((s) => (id ? s.data.nodes[id] : undefined));
  const ai = useSettings((s) => s.ai);
  const [instructions, setInstructions] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const task = useAITask<string>();
  if (!id || !node) return null;

  const run = async () => {
    const t = await task.run((signal, onProgress) => draftPage(useStore.getState().data, id, instructions, { signal, onProgress }));
    if (t) setDraft(t);
  };
  const put = (mode: 'replace' | 'append') => {
    if (draft == null) return;
    const cur = useStore.getState().data.nodes[id]?.content ?? '';
    useStore.getState().updateNode(id, { content: mode === 'replace' || !cur.trim() ? draft : `${cur.trimEnd()}\n\n${draft}` });
    useStore.getState().toast('Page updated', 'success', { label: 'Undo', run: () => useStore.getState().undo() });
    closeDialog();
  };

  return (
    <Modal
      title={`✨ Write “${node.title}”`}
      onClose={closeDialog}
      wide={draft != null}
      footer={
        draft != null ? (
          <>
            <button className="btn" onClick={run} disabled={task.running}>
              ↻ Regenerate
            </button>
            <span className="grow" />
            {node.content.trim() && (
              <button className="btn" onClick={() => put('append')}>
                Append to page
              </button>
            )}
            <button className="btn primary" onClick={() => put('replace')}>
              {node.content.trim() ? 'Replace page' : 'Use this'}
            </button>
          </>
        ) : (
          <>
            <span className="grow" />
            <button className="btn" onClick={closeDialog}>
              Cancel
            </button>
            <button className="btn primary" onClick={run} disabled={task.running || !aiReady(ai)}>
              Write page
            </button>
          </>
        )
      }
    >
      {draft == null && (
        <>
          <p className="muted small">The draft uses the page's place in the hierarchy, its sub-pages, relations and your existing notes. You'll see it before anything changes.</p>
          <AIRequired />
          <div className="opt-grid">
            <label>Guidance</label>
            <input placeholder="Optional, e.g. “include a worked example” or “explain like I'm new to this”" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          </div>
        </>
      )}
      <AIStatus task={task as never} />
      {draft != null && <div className="prose draft-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(draft) }} />}
    </Modal>
  );
}

/* ---------------- AI review (prune / reorganise) ---------------- */

const OP_TEXT: Record<PruneOp['kind'], string> = {
  merge: 'Merge',
  move: 'Move',
  delete: 'Delete',
  rename: 'Rename',
  group: 'Group',
};

export function ReviewDialog() {
  const scope = useStore((s) => s.dialogArg);
  const data = useStore((s) => s.data);
  const ai = useSettings((s) => s.ai);
  const [instructions, setInstructions] = useState('');
  const [result, setResult] = useState<{ summary: string; ops: PruneOp[] } | null>(null);
  const task = useAITask<{ summary: string; ops: PruneOp[] }>();
  const title = scope && data.nodes[scope] ? `“${data.nodes[scope].title}”` : 'whole graph';

  const run = async () => {
    const r = await task.run((signal, onProgress) => reviewBranch(useStore.getState().data, scope && data.nodes[scope] ? scope : null, instructions, { signal, onProgress }));
    if (r) setResult(r);
  };
  const apply = () => {
    if (!result) return;
    const n = useStore.getState().applyPruneOps(result.ops);
    useStore.getState().toast(`Applied ${n} change${n === 1 ? '' : 's'}`, 'success', { label: 'Undo', run: () => useStore.getState().undo() });
    closeDialog();
  };
  const name = (id: string) => (id ? (data.nodes[id]?.title ?? id) : 'top level');

  return (
    <Modal
      title={`✨ Review ${title}`}
      onClose={closeDialog}
      wide={!!result}
      footer={
        result ? (
          <>
            <button className="btn" onClick={() => setResult(null)}>
              ← Back
            </button>
            <span className="grow" />
            <button className="btn primary" onClick={apply} disabled={!result.ops.some((o) => o.accepted)}>
              Apply selected
            </button>
          </>
        ) : (
          <>
            <span className="grow" />
            <button className="btn" onClick={closeDialog}>
              Cancel
            </button>
            <button className="btn primary" onClick={run} disabled={task.running || !aiReady(ai)}>
              Review structure
            </button>
          </>
        )
      }
    >
      {!result && (
        <>
          <p className="muted small">The model looks for duplicates, misplaced pages, trivial pages and long flat lists, and proposes merges, moves, renames, deletions and new groups. You choose what to apply.</p>
          <AIRequired />
          <div className="opt-grid">
            <label>Guidance</label>
            <input placeholder="Optional, e.g. “be aggressive about merging” or “don't delete anything”" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          </div>
        </>
      )}
      <AIStatus task={task as never} />
      {result && (
        <div className="proposal">
          {result.summary && <p className="prop-summary">{result.summary}</p>}
          {!result.ops.length && <p className="muted">No changes suggested — the structure looks good.</p>}
          {result.ops.map((op, i) => (
            <label key={i} className={`op-row ${op.accepted ? '' : 'off'}`}>
              <input
                type="checkbox"
                checked={op.accepted}
                onChange={(e) => setResult({ ...result, ops: result.ops.map((o, j) => (j === i ? { ...o, accepted: e.target.checked } : o)) })}
              />
              <span className={`badge op-${op.kind}`}>{OP_TEXT[op.kind]}</span>
              <span className="op-text">
                {op.kind === 'merge' && (
                  <>
                    <b>{name(op.node)}</b> into <b>{name(op.target)}</b>
                  </>
                )}
                {op.kind === 'move' && (
                  <>
                    <b>{name(op.node)}</b> under <b>{name(op.target)}</b>
                  </>
                )}
                {op.kind === 'delete' && <b>{name(op.node)}</b>}
                {op.kind === 'rename' && (
                  <>
                    <b>{name(op.node)}</b> → <b>{op.target}</b>
                  </>
                )}
                {op.kind === 'group' && (
                  <>
                    new page <b>{op.target}</b> under <b>{name(op.node)}</b> containing {(op.members ?? []).map(name).join(', ')}
                  </>
                )}
                {op.reason && <span className="muted small"> — {op.reason}</span>}
              </span>
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}
