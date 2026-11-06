import { useMemo, useState } from 'react';
import { useStore } from '../store/store';
import { analyze, ISSUE_INFO, type Issue, type IssueKind } from '../lib/health';
import { closeDialog, Modal } from './Modal';
import { nodeActions } from './ContextMenu';
import { safeLocalGet, safeLocalSet } from '../store/persist';
import { pathTitles } from '../lib/tree';

const IGNORE_KEY = 'kg:ignored:v1';
const ORDER: IssueKind[] = ['duplicate', 'broken', 'stub', 'chain', 'crowded', 'lonely', 'deep'];

export function HealthDialog() {
  const data = useStore((s) => s.data);
  const [ignored, setIgnored] = useState<Set<string>>(() => new Set(safeLocalGet<string[]>(IGNORE_KEY) ?? []));
  const issues = useMemo(() => analyze(data, ignored), [data, ignored]);
  const st = useStore.getState();
  const grouped = useMemo(() => {
    const m = new Map<IssueKind, Issue[]>();
    for (const i of issues) m.set(i.kind, [...(m.get(i.kind) ?? []), i]);
    return m;
  }, [issues]);

  const ignore = (key: string) => {
    const next = new Set(ignored).add(key);
    setIgnored(next);
    safeLocalSet(IGNORE_KEY, [...next]);
  };
  const open = (id: string) => {
    st.reveal(id);
    closeDialog();
  };
  const title = (id: string) => data.nodes[id]?.title ?? '?';
  const where = (id: string) => pathTitles(data.nodes, id).slice(0, -1).join(' › ') || 'top level';

  const actions = (i: Issue) => {
    const [a, b] = i.ids;
    switch (i.kind) {
      case 'duplicate':
        return (
          <>
            <button className="btn tiny" onClick={() => st.mergeNodes(b, a)} title={`Keep “${title(a)}”`}>
              Merge into first
            </button>
            <button className="btn tiny" onClick={() => st.mergeNodes(a, b)} title={`Keep “${title(b)}”`}>
              Merge into second
            </button>
          </>
        );
      case 'stub':
        return (
          <>
            <button className="btn tiny" onClick={() => st.openDialog('draft', a)}>
              ✨ Write
            </button>
            <button className="btn tiny danger" onClick={() => st.deleteNode(a, 'subtree')}>
              Delete
            </button>
          </>
        );
      case 'broken':
        return (
          <button
            className="btn tiny"
            onClick={() => {
              st.createNode(a, { title: i.missing ?? 'Untitled' }, { select: false });
              st.toast(`Created “${i.missing}”`, 'success');
            }}
          >
            Create page
          </button>
        );
      case 'chain':
        return (
          <button className="btn tiny" onClick={() => st.mergeNodes(b, a)} title={`Merge “${title(b)}” into “${title(a)}”`}>
            Merge levels
          </button>
        );
      case 'crowded':
        return (
          <button className="btn tiny" onClick={() => st.openDialog('review', a ?? null)}>
            ✨ Organise
          </button>
        );
      case 'lonely':
      case 'deep':
        return (
          <button className="btn tiny" onClick={() => nodeActions.moveTo(a)}>
            Move…
          </button>
        );
    }
  };

  return (
    <Modal
      title="Graph health"
      onClose={closeDialog}
      wide
      footer={
        <>
          {ignored.size > 0 && (
            <button
              className="link-btn small"
              onClick={() => {
                setIgnored(new Set());
                safeLocalSet(IGNORE_KEY, []);
              }}
            >
              Show {ignored.size} ignored
            </button>
          )}
          <span className="grow" />
          <button className="btn ai" onClick={() => st.openDialog('review', null)}>
            ✨ AI review of the whole graph
          </button>
          <button className="btn" onClick={closeDialog}>
            Done
          </button>
        </>
      }
    >
      {!issues.length && <p className="ok-banner">✓ No issues found. Your graph is in good shape.</p>}
      {ORDER.filter((k) => grouped.has(k)).map((k) => (
        <section key={k} className="health-group">
          <h4>
            {ISSUE_INFO[k].title} <span className="count">{grouped.get(k)!.length}</span>
          </h4>
          <p className="muted small">{ISSUE_INFO[k].help}</p>
          <ul>
            {grouped
              .get(k)!
              .slice(0, 60)
              .map((i) => (
                <li key={i.key} className="issue">
                  <span className="issue-text">
                    {i.ids.length === 0 && <b>Top level</b>}
                    {i.ids.slice(0, k === 'chain' ? 1 : 2).map((id, j) => (
                      <span key={id}>
                        {j > 0 && <span className="muted"> ≈ </span>}
                        <button className="link-btn" onClick={() => open(id)} title={where(id)}>
                          {title(id)}
                        </button>
                      </span>
                    ))}
                    <span className="muted small"> · {i.detail}</span>
                  </span>
                  <span className="issue-actions">
                    {actions(i)}
                    <button className="btn tiny ghost" onClick={() => ignore(i.key)}>
                      Ignore
                    </button>
                  </span>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </Modal>
  );
}
