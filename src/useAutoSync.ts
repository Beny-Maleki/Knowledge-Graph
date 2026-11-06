import { useEffect } from 'react';
import { useStore } from './store/store';
import { useSettings } from './lib/settings';
import { pullFromGist, pushToGist } from './lib/gist';

/** When Gist auto-sync is on: pull a newer remote copy at start-up, push after changes. */
export function useAutoSync() {
  useEffect(() => {
    const { sync } = useSettings.getState();
    if (sync.auto && sync.token && sync.gistId) {
      pullFromGist(sync.token, sync.gistId)
        .then((r) => {
          if (r.exportedAt > useSettings.getState().sync.lastSync + 1000) {
            useStore.getState().replaceData(r.data, r.name);
            useSettings.getState().setSync({ lastSync: r.exportedAt });
            useStore.getState().toast('Loaded a newer version from your gist', 'info', { label: 'Undo', run: () => useStore.getState().undo() });
          }
        })
        .catch((e) => useStore.getState().toast(`Sync: ${e instanceof Error ? e.message : e}`, 'error'));
    }
    let timer: number | undefined;
    const unsub = useStore.subscribe((s, prev) => {
      if (s.data === prev.data && s.workspaceName === prev.workspaceName) return;
      const cfg = useSettings.getState().sync;
      if (!cfg.auto || !cfg.token) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const cur = useSettings.getState().sync;
        try {
          const st = useStore.getState();
          const r = await pushToGist(cur.token, cur.gistId, st.data, st.workspaceName);
          useSettings.getState().setSync({ gistId: r.gistId, lastSync: Date.now() });
        } catch (e) {
          useStore.getState().toast(`Sync failed: ${e instanceof Error ? e.message : e}`, 'error');
        }
      }, 15000);
    });
    return () => {
      unsub();
      window.clearTimeout(timer);
    };
  }, []);
}
