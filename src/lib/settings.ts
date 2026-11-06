import { create } from 'zustand';

export type Provider = 'anthropic' | 'openai';
export type Effort = 'low' | 'medium' | 'high';

export interface AISettings {
  provider: Provider;
  anthropicKey: string;
  anthropicModel: string;
  effort: Effort;
  openaiBaseUrl: string;
  openaiKey: string;
  openaiModel: string;
  /** Keep keys in localStorage (true) or only for this browser session (false). */
  rememberKeys: boolean;
  /** Extra guidance appended to every prompt (language, style…). */
  customInstructions: string;
}

export interface SyncSettings {
  token: string;
  gistId: string;
  auto: boolean;
  lastSync: number;
}

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (default)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
];

export const OPENAI_PRESETS = [
  { label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
  { label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', model: 'local-model' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: '' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: '' },
];

const AI_KEY = 'kg:ai:v1';
const AI_SECRET_KEY = 'kg:ai-keys:v1';
const SYNC_KEY = 'kg:sync:v1';

const DEFAULT_AI: AISettings = {
  provider: 'anthropic',
  anthropicKey: '',
  anthropicModel: 'claude-opus-5-5',
  effort: 'medium',
  openaiBaseUrl: 'http://localhost:11434/v1',
  openaiKey: '',
  openaiModel: 'llama3.1',
  rememberKeys: true,
  customInstructions: '',
};

function read<T>(storage: Storage | undefined, key: string): Partial<T> {
  try {
    const raw = storage?.getItem(key);
    return raw ? (JSON.parse(raw) as Partial<T>) : {};
  } catch {
    return {};
  }
}

function write(storage: Storage | undefined, key: string, value: unknown) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

const ls = typeof localStorage !== 'undefined' ? localStorage : undefined;
const ss = typeof sessionStorage !== 'undefined' ? sessionStorage : undefined;

function loadAI(): AISettings {
  const base = { ...DEFAULT_AI, ...read<AISettings>(ls, AI_KEY) };
  const keys = read<Pick<AISettings, 'anthropicKey' | 'openaiKey'>>(base.rememberKeys ? ls : ss, AI_SECRET_KEY);
  return { ...base, anthropicKey: keys.anthropicKey ?? '', openaiKey: keys.openaiKey ?? '' };
}

function saveAI(s: AISettings) {
  const { anthropicKey, openaiKey, ...rest } = s;
  write(ls, AI_KEY, rest);
  const keys = { anthropicKey, openaiKey };
  if (s.rememberKeys) {
    write(ls, AI_SECRET_KEY, keys);
    ss?.removeItem(AI_SECRET_KEY);
  } else {
    write(ss, AI_SECRET_KEY, keys);
    ls?.removeItem(AI_SECRET_KEY);
  }
}

interface SettingsState {
  ai: AISettings;
  sync: SyncSettings;
  setAI: (patch: Partial<AISettings>) => void;
  setSync: (patch: Partial<SyncSettings>) => void;
  forgetKeys: () => void;
}

export const useSettings = create<SettingsState>((set, get) => ({
  ai: loadAI(),
  sync: { token: '', gistId: '', auto: false, lastSync: 0, ...read<SyncSettings>(ls, SYNC_KEY) },
  setAI: (patch) => {
    const ai = { ...get().ai, ...patch };
    saveAI(ai);
    set({ ai });
  },
  setSync: (patch) => {
    const sync = { ...get().sync, ...patch };
    write(ls, SYNC_KEY, sync);
    set({ sync });
  },
  forgetKeys: () => {
    ls?.removeItem(AI_SECRET_KEY);
    ss?.removeItem(AI_SECRET_KEY);
    const ai = { ...get().ai, anthropicKey: '', openaiKey: '' };
    set({ ai });
    const sync = { ...get().sync, token: '' };
    write(ls, SYNC_KEY, sync);
    set({ sync });
  },
}));

export function aiReady(ai: AISettings = useSettings.getState().ai): boolean {
  if (ai.provider === 'anthropic') return !!ai.anthropicKey.trim() && !!ai.anthropicModel.trim();
  return !!ai.openaiBaseUrl.trim() && !!ai.openaiModel.trim();
}
