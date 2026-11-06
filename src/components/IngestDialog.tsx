import { useState } from 'react';
import type { Proposal } from '../types';
import { useStore } from '../store/store';
import { AIRequired, AIStatus, closeDialog, Modal, useAITask } from './Modal';
import { ProposalReview, proposalCounts } from './ProposalReview';
import { pickNode } from './NodePicker';
import { digest, type Granularity } from '../lib/pipeline';
import { parseOutline } from '../lib/outline';
import { fetchUrlAsMarkdown, readSourceFile } from '../lib/files';
import { aiReady, useSettings } from '../lib/settings';
import { pathTitles } from '../lib/tree';

type Tab = 'paste' | 'file' | 'url';
type Method = 'ai' | 'outline';

export function IngestDialog() {
  const data = useStore((s) => s.data);
  const presetTarget = useStore((s) => s.dialogArg);
  const ai = useSettings((s) => s.ai);
  const [tab, setTab] = useState<Tab>('paste');
  const [text, setText] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState<Method>(aiReady(ai) ? 'ai' : 'outline');
  const [target, setTarget] = useState<string | null>(presetTarget && data.nodes[presetTarget] ? presetTarget : null);
  const [granularity, setGranularity] = useState<Granularity>('medium');
  const [instructions, setInstructions] = useState('');
  const [bulletsAsNodes, setBulletsAsNodes] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [wrapTitle, setWrapTitle] = useState('');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [loading, setLoading] = useState('');
  const [loadError, setLoadError] = useState('');
  const task = useAITask<Proposal>();

  const loadFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setLoadError('');
    setLoading(`Reading ${list.length > 1 ? `${list.length} files` : list[0].name}…`);
    try {
      const parts: string[] = [];
      for (const f of list) {
        const t = await readSourceFile(f);
        parts.push(list.length > 1 ? `# ${f.name.replace(/\.[^.]+$/, '')}\n\n${t}` : t);
      }
      setText(parts.join('\n\n'));
      const name = list.length > 1 ? `${list.length} files` : list[0].name;
      setSourceName(name);
      setWrapTitle(list[0].name.replace(/\.[^.]+$/, ''));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading('');
    }
  };

  const loadUrl = async () => {
    setLoadError('');
    setLoading('Fetching page…');
    try {
      const r = await fetchUrlAsMarkdown(url);
      setText(r.text);
      setSourceName(url.trim());
      setWrapTitle(r.title);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading('');
    }
  };

  const run = async () => {
    if (!text.trim()) return;
    if (method === 'outline') {
      setProposal(
        parseOutline(text, {
          bulletsAsNodes,
          parent: target,
          wrapTitle: wrap ? wrapTitle.trim() || sourceName || 'Imported notes' : null,
          source: sourceName,
        }),
      );
      return;
    }
    const p = await task.run((signal, onProgress) =>
      digest(useStore.getState().data, { text, sourceName, scope: target, granularity, instructions }, { signal, onProgress }),
    );
    if (p) setProposal(p);
  };

  const apply = () => {
    if (!proposal) return;
    const r = useStore.getState().applyProposal(proposal);
    const st = useStore.getState();
    st.toast(`Added ${r.created.length} page${r.created.length === 1 ? '' : 's'}, updated ${r.updated.length}, ${r.linksAdded} link${r.linksAdded === 1 ? '' : 's'}`, 'success', {
      label: 'Undo',
      run: () => useStore.getState().undo(),
    });
    const first = r.created[0] ?? r.updated[0];
    if (first) {
      const top = r.created.find((id) => !r.created.includes(st.data.nodes[id]?.parentId ?? '')) ?? first;
      st.reveal(top);
    }
    closeDialog();
  };

  const chars = text.length;
  const counts = proposal ? proposalCounts(proposal) : null;

  if (proposal) {
    return (
      <Modal
        title="Review proposal"
        onClose={closeDialog}
        wide
        footer={
          <>
            <button className="btn" onClick={() => setProposal(null)}>
              ← Back
            </button>
            <span className="grow" />
            <button className="btn primary" disabled={!counts || counts.created + counts.merged + counts.links === 0} onClick={apply}>
              Add to graph
            </button>
          </>
        }
      >
        <p className="muted small">Untick anything you don't want and fix titles inline. Nothing changes until you click “Add to graph” — and it can be undone.</p>
        <ProposalReview proposal={proposal} onChange={setProposal} />
      </Modal>
    );
  }

  return (
    <Modal
      title="Digest new knowledge"
      onClose={closeDialog}
      wide
      footer={
        <>
          <span className="muted small">
            {chars ? `${chars.toLocaleString()} characters (~${Math.ceil(chars / 4).toLocaleString()} tokens)` : 'Add some source material'}
          </span>
          <span className="grow" />
          <button className="btn" onClick={closeDialog}>
            Cancel
          </button>
          <button className="btn primary" disabled={!text.trim() || task.running || (method === 'ai' && !aiReady(ai))} onClick={run}>
            {method === 'ai' ? '✨ Digest with AI' : 'Parse outline'}
          </button>
        </>
      }
    >
      <div className="steps">
        <div className="step">
          <div className="step-head">
            <span className="step-num">1</span> Source
          </div>
          <div className="tabs">
            {(['paste', 'file', 'url'] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                {t === 'paste' ? 'Paste text' : t === 'file' ? 'File' : 'Web page'}
              </button>
            ))}
          </div>
          {tab === 'file' && (
            <label
              className="dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                loadFiles(e.dataTransfer.files);
              }}
            >
              <input type="file" multiple accept=".md,.markdown,.txt,.pdf,.html,.htm,text/*,application/pdf" onChange={(e) => e.target.files && loadFiles(e.target.files)} hidden />
              <span>
                Drop <b>.md</b>, <b>.txt</b>, <b>.pdf</b> or <b>.html</b> files here, or <u>browse</u>
              </span>
            </label>
          )}
          {tab === 'url' && (
            <div className="row gap">
              <input className="grow" placeholder="https://en.wikipedia.org/wiki/Attention_(machine_learning)" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && loadUrl()} />
              <button className="btn" onClick={loadUrl} disabled={!url.trim() || !!loading}>
                Fetch
              </button>
            </div>
          )}
          {tab === 'url' && <p className="muted small">Pages are fetched as Markdown through the public r.jina.ai reader, because browsers can't read other sites directly.</p>}
          {loading && (
            <p className="muted small">
              <span className="spinner" /> {loading}
            </p>
          )}
          {loadError && <p className="error small">{loadError}</p>}
          <textarea
            className="source-text"
            placeholder={'Paste notes, an article, a transcript, a Markdown outline…\n\n# Topic\n## Sub-topic\n- Idea: explanation'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={tab === 'paste' ? 12 : 7}
          />
          <input className="source-name" placeholder="Source name or URL (optional, stored on the new pages)" value={sourceName} onChange={(e) => setSourceName(e.target.value)} />
        </div>

        <div className="step">
          <div className="step-head">
            <span className="step-num">2</span> How to digest
          </div>
          <div className="method-cards">
            <button className={`method ${method === 'ai' ? 'on' : ''}`} onClick={() => setMethod('ai')}>
              <b>✨ AI digest</b>
              <span>Extracts concepts, writes notes, places them into your existing hierarchy and proposes relations.</span>
            </button>
            <button className={`method ${method === 'outline' ? 'on' : ''}`} onClick={() => setMethod('outline')}>
              <b>☰ Outline parser</b>
              <span>Free & offline. Headings, bullets or indentation become pages; text under them becomes notes.</span>
            </button>
          </div>
          {method === 'ai' && <AIRequired />}

          <div className="opt-grid">
            <label>Place into</label>
            <div className="row gap">
              <button
                className="btn small"
                onClick={async () => {
                  const r = await pickNode({ title: 'Place new pages under…', allowRoot: true });
                  if (r) setTarget(r.id);
                }}
              >
                {target && data.nodes[target] ? `📍 ${pathTitles(data.nodes, target).join(' › ')}` : method === 'ai' ? '🧭 Anywhere — AI decides' : '⌂ Top level'}
              </button>
              {target && (
                <button className="link-btn small" onClick={() => setTarget(null)}>
                  reset
                </button>
              )}
            </div>
            {method === 'ai' ? (
              <>
                <label>Detail</label>
                <div className="seg">
                  {(['coarse', 'medium', 'fine'] as Granularity[]).map((g) => (
                    <button key={g} className={granularity === g ? 'on' : ''} onClick={() => setGranularity(g)}>
                      {g === 'coarse' ? 'Main ideas' : g === 'medium' ? 'Balanced' : 'Fine-grained'}
                    </button>
                  ))}
                </div>
                <label>Focus</label>
                <input placeholder="Optional, e.g. “only the methods, skip history” or “answer in Persian”" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
              </>
            ) : (
              <>
                <label>Lists</label>
                <label className="check">
                  <input type="checkbox" checked={bulletsAsNodes} onChange={(e) => setBulletsAsNodes(e.target.checked)} /> Turn bullet points into pages
                </label>
                <label>Wrap</label>
                <div className="row gap">
                  <label className="check">
                    <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Put everything under a new page
                  </label>
                  {wrap && <input className="grow" value={wrapTitle} placeholder="Page title" onChange={(e) => setWrapTitle(e.target.value)} />}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <AIStatus task={task as never} />
    </Modal>
  );
}
