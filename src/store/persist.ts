import { del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval';
import type { GraphData } from '../types';
import { sanitizeData } from '../lib/ops';
import { sampleData } from './sample';
import { useStore, type UIState } from './store';

const GUEST_KEY = 'kg:workspace:v1';
const UI_KEY = 'kg:ui:v1';

/** Where the graph currently shown is saved on this device. */
export type StorageTarget = { kind: 'guest' } | { kind: 'cloud'; workspaceId: string };

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

export function cloudCacheKey(workspaceId: string) {
  return `kg:cloud:v1:${workspaceId}`;
}

let target: StorageTarget = { kind: 'guest' };
let timer: number | undefined;

export function getStorageTarget(): StorageTarget {
  return target;
}

function keyFor(t: StorageTarget) {
  return t.kind === 'guest' ? GUEST_KEY : cloudCacheKey(t.workspaceId);
}

async function save(t: StorageTarget = target) {
  const s = useStore.getState();
  const payload: SavedWorkspace = { name: s.workspaceName, data: s.data, savedAt: Date.now() };
  try {
    await idbSet(keyFor(t), payload);
  } catch {
    useStore.getState().toast('Could not save to browser storage (is it full or disabled?)', 'error');
  }
}

/** Write any pending change for the current target right away. */
export async function flushSave() {
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timer = undefined;
    await save();
  }
}

export async function loadSaved(t: StorageTarget): Promise<{ name: string; data: GraphData } | null> {
  try {
    const saved = await idbGet<SavedWorkspace>(keyFor(t));
    return saved ? { name: saved.name, data: sanitizeData(saved.data) } : null;
  } catch {
    return null;
  }
}

export async function deleteSaved(t: StorageTarget) {
  try {
    await idbDel(keyFor(t));
  } catch {
    /* ignore */
  }
}

/**
 * Show a different graph (guest copy or a cloud workspace). Pending edits of
 * the previous target are written first; undo history starts fresh.
 */
export async function switchTarget(next: StorageTarget, data: GraphData, name: string) {
  await flushSave();
  target = next;
  useStore.getState().setLoaded(data, name, { selectedId: null, focusId: null, ...firstVisitUI(data, false) });
  await save(next);
}

/** Load the guest graph from this browser (or the sample on a first visit). */
export async function loadGuest(): Promise<{ name: string; data: GraphData; firstVisit: boolean }> {
  const saved = await loadSaved({ kind: 'guest' });
  if (saved) return { ...saved, firstVisit: false };
  return { name: 'My knowledge', data: sampleData(), firstVisit: true };
}

export async function initPersistence(initialTarget: StorageTarget = { kind: 'guest' }) {
  const ui = safeLocalGet<Partial<UIState>>(UI_KEY) ?? {};
  let loaded: { name: string; data: GraphData; firstVisit: boolean } | null = null;
  if (initialTarget.kind === 'cloud') {
    const cached = await loadSaved(initialTarget);
    if (cached) {
      target = initialTarget;
      loaded = { ...cached, firstVisit: false };
    }
  }
  loaded ??= await loadGuest();
  const narrow = window.innerWidth <= 900;
  useStore.getState().setLoaded(loaded.data, loaded.name, {
    ...pickUI(ui),
    ...(narrow ? { sidebarOpen: false } : {}),
    ...(loaded.firstVisit ? firstVisitUI(loaded.data, true) : {}),
  });
  if (loaded.firstVisit) void save();

  useStore.subscribe((s, prev) => {
    if (s.data !== prev.data || s.workspaceName !== prev.workspaceName) {
      window.clearTimeout(timer);
      const t = target;
      timer = window.setTimeout(() => {
        timer = undefined;
        void save(t);
      }, 400);
    }
    const nextUi = pickUI(s);
    const prevUi = pickUI(prev);
    if ((Object.keys(nextUi) as (keyof UIState)[]).some((k) => nextUi[k] !== prevUi[k])) safeLocalSet(UI_KEY, nextUi);
  });
  window.addEventListener('beforeunload', () => {
    if (timer !== undefined) void save();
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

function firstVisitUI(data: GraphData, selectStart: boolean): Partial<UIState> {
  const start = Object.values(data.nodes).find((n) => n.title === 'Start here');
  const expanded: Record<string, true> = {};
  for (const n of Object.values(data.nodes)) if (!n.parentId) expanded[n.id] = true;
  return { ...(selectStart ? { selectedId: start?.id ?? null } : {}), expanded, outlineOpen: { ...expanded } };
}
