import { get as idbGet, set as idbSet } from 'idb-keyval';
import type { GraphData } from '../types';
import { sanitizeData } from '../lib/ops';
import { sampleData } from './sample';
import { useStore, type UIState } from './store';

const WS_KEY = 'kg:workspace:v1';
const UI_KEY = 'kg:ui:v1';

interface SavedWorkspace {
  name: string;
  data: GraphData;
  savedAt: number;
}

export function safeLocalGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function safeLocalSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked — non-fatal */
  }
}

let lastSavedAt = 0;
export function getLastSavedAt() {
  return lastSavedAt;
}

export async function initPersistence() {
  let saved: SavedWorkspace | undefined;
  try {
    saved = await idbGet<SavedWorkspace>(WS_KEY);
  } catch {
    saved = undefined;
  }
  const ui = safeLocalGet<Partial<UIState>>(UI_KEY) ?? {};
  const isFirstVisit = !saved;
  const data = saved ? sanitizeData(saved.data) : sampleData();
  const name = saved?.name ?? 'My knowledge';
  lastSavedAt = saved?.savedAt ?? 0;
  const narrow = window.innerWidth <= 900;
  useStore.getState().setLoaded(data, name, {
    ...pickUI(ui),
    ...(narrow ? { sidebarOpen: false } : {}),
    ...(isFirstVisit ? firstVisitUI(data) : {}),
  });

  let timer: number | undefined;
  const save = () => {
    const s = useStore.getState();
    const payload: SavedWorkspace = { name: s.workspaceName, data: s.data, savedAt: Date.now() };
    idbSet(WS_KEY, payload)
      .then(() => {
        lastSavedAt = payload.savedAt;
        window.dispatchEvent(new CustomEvent('kg:saved'));
      })
      .catch(() => {
        useStore.getState().toast('Could not save to browser storage (is it full or disabled?)', 'error');
      });
  };
  if (isFirstVisit) save();

  useStore.subscribe((s, prev) => {
    if (s.data !== prev.data || s.workspaceName !== prev.workspaceName) {
      window.clearTimeout(timer);
      timer = window.setTimeout(save, 400);
      window.dispatchEvent(new CustomEvent('kg:dirty'));
    }
    const ui = pickUI(s);
    const prevUi = pickUI(prev);
    if ((Object.keys(ui) as (keyof UIState)[]).some((k) => ui[k] !== prevUi[k])) safeLocalSet(UI_KEY, ui);
  });
  window.addEventListener('beforeunload', () => {
    if (timer) save();
  });
}

function pickUI(s: Partial<UIState>): Partial<UIState> {
  const out: Partial<UIState> = {};
  const keys: (keyof UIState)[] = [
    'view',
    'selectedId',
    'focusId',
    'expanded',
    'outlineOpen',
    'sidebarOpen',
    'panelWide',
    'showLinks',
    'showHulls',
    'showLabels',
    'theme',
  ];
  for (const k of keys) if (s[k] !== undefined) (out as Record<string, unknown>)[k] = s[k];
  return out;
}

function firstVisitUI(data: GraphData): Partial<UIState> {
  const start = Object.values(data.nodes).find((n) => n.title === 'Start here');
  const expanded: Record<string, true> = {};
  for (const n of Object.values(data.nodes)) if (!n.parentId) expanded[n.id] = true;
  return { selectedId: start?.id ?? null, expanded, outlineOpen: { ...expanded } };
}
