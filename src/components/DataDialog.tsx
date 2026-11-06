import { useState } from 'react';
import { strToU8 } from 'fflate';
import { useStore } from '../store/store';
import { closeDialog, Modal } from './Modal';
import { confirmDialog } from './Confirm';
import { collectMarkdownFiles, exportMarkdownZip, markdownFilesToGraph, parseWorkspaceJSON, toWorkspaceFile } from '../lib/interchange';
import { downloadBlob, safeFileName } from '../lib/files';
import { sampleData } from '../store/sample';
import type { GraphData } from '../types';

export function DataDialog() {
  const data = useStore((s) => s.data);
  const name = useStore((s) => s.workspaceName);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const stamp = new Date().toISOString().slice(0, 10);

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(toWorkspaceFile(data, name), null, 1)], { type: 'application/json' });
    downloadBlob(blob, `${safeFileName(name)} ${stamp}.json`);
  };
  const exportMd = () => {
    const zip = exportMarkdownZip(data, name);
    downloadBlob(new Blob([zip as BlobPart], { type: 'application/zip' }), `${safeFileName(name)} ${stamp} (markdown).zip`);
  };

  const ingest = async (incoming: GraphData, incomingName: string) => {
    const n = Object.keys(incoming.nodes).length;
    if (!n) {
      setError('No pages were found in that file.');
      return;
    }
    const choice = await confirmDialog({
      title: `Import ${n} page${n > 1 ? 's' : ''}?`,
      body: 'Add them next to your current pages, or replace everything (you can undo either).',
      actions: [
        { id: 'merge', label: 'Add to my graph' },
        { id: 'replace', label: 'Replace everything', danger: true },
      ],
    });
    if (choice === 'merge') useStore.getState().mergeData(incoming);
    else if (choice === 'replace') useStore.getState().replaceData(incoming, incomingName);
    else return;
    useStore.getState().toast(`Imported ${n} pages`, 'success', { label: 'Undo', run: () => useStore.getState().undo() });
    closeDialog();
  };

  const importJSON = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    setError('');
    try {
      const { name: n, data: d } = parseWorkspaceJSON(await f.text());
      await ingest(d, n);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const importMarkdown = async (files: FileList | null) => {
    if (!files?.length) return;
    setError('');
    setBusy('Reading files…');
    try {
      const md = await collectMarkdownFiles(Array.from(files));
      if (!md.length) throw new Error('No .md files found (Notion: export as “Markdown & CSV”).');
      const g = markdownFilesToGraph(md);
      setBusy('');
      await ingest(g, 'Imported');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const reset = async (kind: 'empty' | 'sample') => {
    const choice = await confirmDialog({
      title: kind === 'empty' ? 'Start with an empty graph?' : 'Load the sample graph?',
      body: 'Your current pages will be replaced. Export a backup first if you want to keep them (Undo also works until you reload).',
      actions: [{ id: 'ok', label: kind === 'empty' ? 'Clear everything' : 'Load sample', danger: true }],
    });
    if (choice !== 'ok') return;
    const d: GraphData = kind === 'empty' ? { nodes: {}, links: {} } : sampleData();
    useStore.getState().replaceData(d, kind === 'empty' ? 'My knowledge' : 'Sample');
    if (kind === 'sample') {
      const exp: Record<string, true> = {};
      for (const n of Object.values(d.nodes)) if (!n.parentId) exp[n.id] = true;
      useStore.setState({ expanded: exp, outlineOpen: { ...exp } });
    }
    closeDialog();
  };

  return (
    <Modal title="Your data" onClose={closeDialog} wide>
      <p className="muted small">
        Everything is saved automatically in this browser ({Object.keys(data.nodes).length} pages, {Object.keys(data.links).length} links). Export regularly if this is your only copy, or enable Sync in Settings.
      </p>
      <div className="data-grid">
        <section>
          <h4>Export</h4>
          <button className="btn" onClick={exportJSON}>
            ⬇ JSON backup
          </button>
          <p className="muted small">Complete and lossless — re-import it here any time.</p>
          <button className="btn" onClick={exportMd}>
            ⬇ Markdown vault (.zip)
          </button>
          <p className="muted small">One .md per page, folders = hierarchy, relations as [[wiki links]]. Opens in Obsidian and other editors.</p>
          <button
            className="btn"
            onClick={() => {
              const lines = Object.values(data.nodes).map((n) => n.title);
              downloadBlob(new Blob([strToU8(lines.join('\n')) as BlobPart], { type: 'text/plain' }), `${safeFileName(name)} titles.txt`);
            }}
          >
            ⬇ Page titles (.txt)
          </button>
        </section>
        <section>
          <h4>Import</h4>
          <label className="btn file-btn">
            ⬆ JSON backup
            <input type="file" accept=".json,application/json" hidden onChange={(e) => importJSON(e.target.files)} />
          </label>
          <p className="muted small">A file exported from this app.</p>
          <label className="btn file-btn">
            ⬆ Markdown / Notion / Obsidian files
            <input type="file" multiple accept=".md,.markdown,.txt,.zip" hidden onChange={(e) => importMarkdown(e.target.files)} />
          </label>
          <label className="btn file-btn">
            ⬆ A whole folder
            <input
              type="file"
              hidden
              // @ts-expect-error non-standard but widely supported folder picker
              webkitdirectory=""
              onChange={(e) => importMarkdown(e.target.files)}
            />
          </label>
          <p className="muted small">
            <b>From Notion:</b> ⋯ → Export → “Markdown &amp; CSV”, include sub-pages, then pick the downloaded .zip. Page nesting becomes the hierarchy and links between pages become relations.
          </p>
          {busy && (
            <p className="muted small">
              <span className="spinner" /> {busy}
            </p>
          )}
          {error && <p className="error small">{error}</p>}
        </section>
        <section>
          <h4>Start over</h4>
          <button className="btn" onClick={() => reset('sample')}>
            Load sample graph
          </button>
          <button className="btn danger" onClick={() => reset('empty')}>
            Clear everything
          </button>
        </section>
      </div>
    </Modal>
  );
}
