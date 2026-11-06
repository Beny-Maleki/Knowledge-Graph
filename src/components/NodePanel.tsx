import { useEffect, useMemo, useRef, useState } from 'react';
import { getIndex, useStore } from '../store/store';
import { ancestors, childrenOf, excerpt, implicitLinks, nodeColor, normalizeTitle, PALETTE, relationsOf, titleLookup } from '../lib/tree';
import { renderMarkdown } from '../lib/markdown';
import { MarkdownEditor, type EditorHandle } from './MarkdownEditor';
import { nodeActions, openNodeMenu } from './ContextMenu';

const EMOJIS = ['📌', '💡', '📚', '🧠', '🔬', '🧪', '📐', '🧮', '🤖', '🧬', '🌍', '🏛️', '🎨', '🎵', '💻', '⚙️', '📈', '🔑', '❓', '✅', '⭐', '🔥', '🌱', '🧭', '📝', '🗂️', '🧩', '🔗', '⚠️', '🎯'];

export function NodePanel() {
  const selectedId = useStore((s) => s.selectedId);
  const node = useStore((s) => (s.selectedId ? s.data.nodes[s.selectedId] : undefined));
  const panelWide = useStore((s) => s.panelWide);
  if (!selectedId || !node) return null;
  return (
    <aside className={`panel ${panelWide ? 'wide' : ''}`} aria-label="Page">
      <PageView key={selectedId} id={selectedId} />
    </aside>
  );
}

function PageView({ id }: { id: string }) {
  const data = useStore((s) => s.data);
  const node = data.nodes[id];
  const index = getIndex(data.nodes);
  const st = useStore.getState();
  const panelWide = useStore((s) => s.panelWide);
  const focusId = useStore((s) => s.focusId);
  const editTitleOf = useStore((s) => s.editTitleOf);
  const [mode, setMode] = useState<'read' | 'edit'>('read');
  const [iconOpen, setIconOpen] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const editor = useRef<EditorHandle | null>(null);

  useEffect(() => {
    if (editTitleOf === id && titleRef.current) {
      titleRef.current.focus();
      titleRef.current.select();
      st.clearEditTitle();
    }
  }, [editTitleOf, id, st]);

  useEffect(() => {
    const el = titleRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    }
  }, [node.title, panelWide]);

  const lookup = useMemo(() => titleLookup(data.nodes), [data.nodes]);
  const implicit = useMemo(() => implicitLinks(data.nodes, lookup), [data.nodes, lookup]);
  const rel = useMemo(() => relationsOf(data, id, implicit), [data, id, implicit]);
  const html = useMemo(() => renderMarkdown(node.content, (t) => lookup.has(normalizeTitle(t))), [node.content, lookup]);
  const kids = childrenOf(index, id);
  const path = ancestors(data.nodes, id);
  const color = nodeColor(data.nodes, index, id);
  const count = index.descCount.get(id) ?? 0;

  const onPreviewClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a.wikilink') as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    const title = a.dataset.wiki ?? '';
    const target = lookup.get(normalizeTitle(title));
    if (target) st.reveal(target);
    else {
      const nid = st.createNode(id, { title }, { select: false });
      st.toast(`Created “${title}” under “${node.title}”`, 'success');
      st.reveal(nid);
    }
  };

  return (
    <div className="page" style={{ ['--node-color' as string]: color }}>
      <div className="page-top">
        <nav className="crumbs" aria-label="Location">
          {path.length === 0 && <span className="muted">Top level</span>}
          {path.map((a) => (
            <button key={a} className="crumb" onClick={() => st.reveal(a)}>
              {data.nodes[a].icon} {data.nodes[a].title}
            </button>
          ))}
        </nav>
        <div className="page-top-actions">
          <button className="icon-btn" title={panelWide ? 'Narrow panel' : 'Widen panel'} onClick={() => st.setUI({ panelWide: !panelWide })}>
            {panelWide ? '⇥' : '⇤'}
          </button>
          <button className="icon-btn" title="Close page" onClick={() => st.select(null)}>
            ✕
          </button>
        </div>
      </div>

      <div className="page-head">
        <div className="icon-wrap">
          <button className="page-icon" onClick={() => setIconOpen((v) => !v)} title="Change icon" style={{ borderColor: color }}>
            {node.icon || <span className="dot" style={{ background: color }} />}
          </button>
          {iconOpen && (
            <div className="icon-pop" onMouseLeave={() => setIconOpen(false)}>
              <div className="emoji-grid">
                {EMOJIS.map((e) => (
                  <button
                    key={e}
                    onClick={() => {
                      st.updateNode(id, { icon: e });
                      setIconOpen(false);
                    }}
                  >
                    {e}
                  </button>
                ))}
              </div>
              <div className="row gap">
                <input
                  placeholder="Any emoji…"
                  maxLength={8}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter') {
                      st.updateNode(id, { icon: (ev.target as HTMLInputElement).value.trim() || undefined });
                      setIconOpen(false);
                    }
                  }}
                />
                <button
                  className="btn small"
                  onClick={() => {
                    st.updateNode(id, { icon: undefined });
                    setIconOpen(false);
                  }}
                >
                  Remove
                </button>
              </div>
              <div className="swatches">
                <span className="muted small">Colour</span>
                <button className={`swatch auto ${!node.color ? 'on' : ''}`} title="Inherit from branch" onClick={() => st.updateNode(id, { color: undefined })}>
                  A
                </button>
                {PALETTE.map((c) => (
                  <button key={c} className={`swatch ${node.color === c ? 'on' : ''}`} style={{ background: c }} title={c} onClick={() => st.updateNode(id, { color: c })} />
                ))}
              </div>
            </div>
          )}
        </div>
        <textarea
          ref={titleRef}
          className="page-title"
          value={node.title}
          rows={1}
          placeholder="Untitled"
          onChange={(e) => st.updateNode(id, { title: e.target.value.replace(/\n/g, ' ') })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              setMode('edit');
              setTimeout(() => editor.current?.focus(), 30);
            }
          }}
          onBlur={() => {
            if (!node.title.trim()) st.updateNode(id, { title: 'Untitled' });
          }}
        />
      </div>

      <div className="page-actions">
        <button className="btn small" onClick={() => nodeActions.addChild(id)} title="Add a page inside this one">
          + Sub-page
        </button>
        {count > 0 && id !== focusId && (
          <button className="btn small" onClick={() => st.setFocus(id)} title="Make this the root of every view">
            ⤵ Dive in
          </button>
        )}
        {id === focusId && (
          <button className="btn small" onClick={() => st.setFocus(data.nodes[id].parentId)} title="Leave focus">
            ⤴ Leave focus
          </button>
        )}
        <button className="btn small ai" onClick={() => st.openDialog('expand', id)} title="Suggest sub-topics and links with AI">
          ✨ Expand
        </button>
        <button className="btn small ai" onClick={() => st.openDialog('draft', id)} title="Draft this page with AI">
          ✨ Write
        </button>
        <button
          className="btn small"
          title="More actions: link, move, merge, delete…"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openNodeMenu(id, r.left, r.bottom + 4);
          }}
        >
          ⋯
        </button>
      </div>

      <TagRow id={id} />

      <section className="content-section">
        <div className="content-tabs">
          <button className={mode === 'read' ? 'on' : ''} onClick={() => setMode('read')}>
            Read
          </button>
          <button className={mode === 'edit' ? 'on' : ''} onClick={() => setMode('edit')}>
            Edit
          </button>
          {mode === 'edit' && (
            <div className="fmt-bar" role="toolbar" aria-label="Formatting">
              <button title="Heading" onClick={() => editor.current?.linePrefix('## ')}>
                H
              </button>
              <button title="Bold (Ctrl+B)" onClick={() => editor.current?.wrap('**', '**', 'bold')}>
                <b>B</b>
              </button>
              <button title="Italic (Ctrl+I)" onClick={() => editor.current?.wrap('*', '*', 'italic')}>
                <i>I</i>
              </button>
              <button title="Bullet list" onClick={() => editor.current?.linePrefix('- ')}>
                •
              </button>
              <button title="Task" onClick={() => editor.current?.linePrefix('- [ ] ')}>
                ☐
              </button>
              <button title="Quote" onClick={() => editor.current?.linePrefix('> ')}>
                ❝
              </button>
              <button title="Code" onClick={() => editor.current?.wrap('`', '`', 'code')}>
                {'</>'}
              </button>
              <button title="Math" onClick={() => editor.current?.wrap('$', '$', 'x^2')}>
                ∑
              </button>
              <button title="Link to page (Ctrl+K)" onClick={() => editor.current?.wrap('[[', ']]', 'Page')}>
                [[ ]]
              </button>
              <button title="Web link" onClick={() => editor.current?.wrap('[', '](https://)', 'text')}>
                🔗
              </button>
            </div>
          )}
        </div>
        {mode === 'edit' ? (
          <MarkdownEditor
            value={node.content}
            onChange={(v) => st.updateNode(id, { content: v })}
            placeholder="Write in Markdown… type [[ to link a page, $…$ for math, paste images directly."
            autoFocus
            handleRef={editor}
          />
        ) : node.content.trim() ? (
          <div className="prose" onClick={onPreviewClick} onDoubleClick={() => setMode('edit')} dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <button className="empty-page" onClick={() => setMode('edit')}>
            This page is empty — click to write, or use <b>✨ Write</b>.
          </button>
        )}
      </section>

      <section className="sub-section">
        <div className="section-head">
          <h4>Sub-pages {kids.length > 0 && <span className="count">{kids.length}</span>}</h4>
          <button className="btn tiny" onClick={() => nodeActions.addChild(id)}>
            + Add
          </button>
        </div>
        {kids.length > 0 ? (
          <div className="cards">
            {kids.map((k) => {
              const kn = data.nodes[k];
              const kc = index.descCount.get(k) ?? 0;
              return (
                <button key={k} className="card" onClick={() => st.reveal(k)} style={{ borderLeftColor: nodeColor(data.nodes, index, k) }}>
                  <span className="card-title">
                    {kn.icon} {kn.title}
                    {kc > 0 && <span className="count">{kc}</span>}
                  </span>
                  {kn.content && <span className="card-body">{excerpt(kn.content, 90)}</span>}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="muted small">No sub-pages yet. Break this topic down to build a finer hierarchy.</p>
        )}
      </section>

      <section className="sub-section">
        <div className="section-head">
          <h4>Relations {rel.outgoing.length + rel.incoming.length > 0 && <span className="count">{rel.outgoing.length + rel.incoming.length}</span>}</h4>
          <button className="btn tiny" onClick={() => nodeActions.linkTo(id)}>
            + Link
          </button>
        </div>
        {rel.outgoing.length + rel.incoming.length === 0 && <p className="muted small">No links yet. Shift+drag between nodes in the graph, use + Link, or write [[Page]] in the text.</p>}
        <ul className="relations">
          {rel.outgoing.map((r) => (
            <RelationRow key={(r.linkId ?? 'm') + r.other} dir="out" rel={r} />
          ))}
          {rel.incoming.map((r) => (
            <RelationRow key={(r.linkId ?? 'mi') + r.other} dir="in" rel={r} />
          ))}
        </ul>
      </section>

      <SourcesRow id={id} />

      <footer className="page-meta muted small">
        Created {new Date(node.createdAt).toLocaleDateString()} · Edited {new Date(node.updatedAt).toLocaleString()}
        {count > 0 && ` · ${count} nested page${count > 1 ? 's' : ''}`}
      </footer>
    </div>
  );
}

function RelationRow({ dir, rel }: { dir: 'in' | 'out'; rel: ReturnType<typeof relationsOf>['outgoing'][number] }) {
  const other = useStore((s) => s.data.nodes[rel.other]);
  const st = useStore.getState();
  const [editing, setEditing] = useState(false);
  if (!other) return null;
  return (
    <li className={`relation ${rel.kind}`}>
      <span className="rel-dir" title={dir === 'out' ? 'outgoing' : 'incoming'}>
        {dir === 'out' ? '→' : '←'}
      </span>
      {editing && rel.linkId ? (
        <input
          className="rel-label-input"
          autoFocus
          defaultValue={rel.label}
          onBlur={(e) => {
            st.updateLinkLabel(rel.linkId!, e.target.value.trim());
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <button
          className={`rel-label ${rel.label ? '' : 'empty'}`}
          disabled={!rel.linkId}
          title={rel.linkId ? 'Click to edit label' : 'From a [[wiki link]] in the text'}
          onClick={() => setEditing(true)}
        >
          {rel.label || 'add label'}
        </button>
      )}
      <button className="rel-target" onClick={() => st.reveal(rel.other)}>
        {other.icon} {other.title}
      </button>
      {rel.linkId && (
        <button className="icon-btn tiny" title="Remove link" onClick={() => st.removeLink(rel.linkId!)}>
          ✕
        </button>
      )}
    </li>
  );
}

function TagRow({ id }: { id: string }) {
  const tags = useStore((s) => s.data.nodes[id]?.tags ?? []);
  const st = useStore.getState();
  const [draft, setDraft] = useState('');
  const add = () => {
    const t = draft.trim().replace(/^#/, '');
    if (t && !tags.includes(t)) st.updateNode(id, { tags: [...tags, t] });
    setDraft('');
  };
  return (
    <div className="tag-row">
      {tags.map((t) => (
        <span key={t} className="tag">
          #{t}
          <button aria-label={`Remove tag ${t}`} onClick={() => st.updateNode(id, { tags: tags.filter((x) => x !== t) })}>
            ×
          </button>
        </span>
      ))}
      <input
        className="tag-input"
        placeholder={tags.length ? '+ tag' : '+ add tag'}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add();
          } else if (e.key === 'Backspace' && !draft && tags.length) st.updateNode(id, { tags: tags.slice(0, -1) });
        }}
        onBlur={add}
      />
    </div>
  );
}

function SourcesRow({ id }: { id: string }) {
  const sources = useStore((s) => s.data.nodes[id]?.sources ?? []);
  const st = useStore.getState();
  const [draft, setDraft] = useState('');
  return (
    <section className="sub-section">
      <div className="section-head">
        <h4>Sources {sources.length > 0 && <span className="count">{sources.length}</span>}</h4>
      </div>
      <ul className="sources">
        {sources.map((s) => (
          <li key={s}>
            {/^https?:\/\//.test(s) ? (
              <a href={s} target="_blank" rel="noopener noreferrer">
                {s}
              </a>
            ) : (
              <span>{s}</span>
            )}
            <button className="icon-btn tiny" title="Remove source" onClick={() => st.updateNode(id, { sources: sources.filter((x) => x !== s) })}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      <input
        className="source-input"
        placeholder="+ add a source (URL, book, lecture…) and press Enter"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft.trim()) {
            if (!sources.includes(draft.trim())) st.updateNode(id, { sources: [...sources, draft.trim()] });
            setDraft('');
          }
        }}
      />
    </section>
  );
}
