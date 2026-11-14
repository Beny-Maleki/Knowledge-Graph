import { useEffect } from 'react';
import { useStore } from './store/store';
import { Sidebar } from './components/Sidebar';
import { GraphView } from './components/GraphView';
import { MapView } from './components/MapView';
import { TreeView } from './components/TreeView';
import { NodePanel } from './components/NodePanel';
import { CommandPalette, HelpDialog, Toasts, TopBar, ViewToolbar } from './components/Chrome';
import { ContextMenuHost, nodeActions } from './components/ContextMenu';
import { NodePickerHost } from './components/NodePicker';
import { ConfirmHost } from './components/Confirm';
import { IngestDialog } from './components/IngestDialog';
import { DraftDialog, ExpandDialog, ReviewDialog } from './components/AIDialogs';
import { HealthDialog } from './components/HealthDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { DataDialog } from './components/DataDialog';
import { AccountDialog } from './components/AccountDialog';
import { AdminDialog } from './components/AdminDialog';
import { useAutoSync } from './useAutoSync';

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || !!t.closest('.cm-editor'));
}

export default function App() {
  const view = useStore((s) => s.view);
  const theme = useStore((s) => s.theme);
  const dialog = useStore((s) => s.dialog);
  const selectedId = useStore((s) => s.selectedId);
  const empty = useStore((s) => Object.keys(s.data.nodes).length === 0);
  useAutoSync();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        st.setPalette(!st.paletteOpen);
        return;
      }
      if (isTyping(e) || st.dialog || st.paletteOpen) return;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        st.redo();
      } else if (!mod && (e.key === 'Delete' || e.key === 'Backspace') && st.selectedId) {
        e.preventDefault();
        nodeActions.remove(st.selectedId);
      } else if (!mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        st.createNode(st.selectedId);
      } else if (!mod && e.key === 'Escape') {
        if (st.selectedId) st.select(null);
      } else if (!mod && ['1', '2', '3'].includes(e.key)) {
        st.setUI({ view: (['graph', 'map', 'tree'] as const)[Number(e.key) - 1] });
      } else if (!mod && e.key === '?') {
        st.openDialog('help');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={`app ${selectedId ? 'has-panel' : ''}`}>
      <TopBar />
      <div className="main">
        <Sidebar />
        <section className="stage" aria-label="Visualisation">
          <ViewToolbar />
          <div className="stage-body">
            {view === 'graph' && <GraphView />}
            {view === 'map' && <MapView />}
            {view === 'tree' && <TreeView />}
            {empty && (
              <div className="empty-state">
                <h2>Your knowledge forest is empty</h2>
                <p>Start a topic, or digest some notes to grow it automatically.</p>
                <div className="row gap center">
                  <button className="btn" onClick={() => useStore.getState().createNode(null, { title: 'New topic' })}>
                    + New topic
                  </button>
                  <button className="btn primary" onClick={() => useStore.getState().openDialog('ingest')}>
                    ＋ Digest notes
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
        <NodePanel />
      </div>
      {dialog === 'ingest' && <IngestDialog />}
      {dialog === 'expand' && <ExpandDialog />}
      {dialog === 'draft' && <DraftDialog />}
      {dialog === 'review' && <ReviewDialog />}
      {dialog === 'health' && <HealthDialog />}
      {dialog === 'settings' && <SettingsDialog />}
      {dialog === 'data' && <DataDialog />}
      {dialog === 'help' && <HelpDialog />}
      {dialog === 'account' && <AccountDialog />}
      {dialog === 'admin' && <AdminDialog />}
      <CommandPalette />
      <ContextMenuHost />
      <NodePickerHost />
      <ConfirmHost />
      <Toasts />
    </div>
  );
}
