/** Optional sync: mirror the workspace to a private GitHub Gist with a personal token. */
import type { GraphData } from '../types';
import { parseWorkspaceJSON, toWorkspaceFile } from './interchange';

const FILE = 'knowledge-graph.json';
const API = 'https://api.github.com';

function headers(token: string) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token.trim()}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

async function check(res: Response) {
  if (res.ok) return;
  if (res.status === 401) throw new Error('GitHub rejected the token (401). It needs the “gist” scope.');
  if (res.status === 404) throw new Error('Gist not found (404). Clear the Gist ID to create a new one.');
  throw new Error(`GitHub API error ${res.status}`);
}

export async function pushToGist(token: string, gistId: string, data: GraphData, name: string): Promise<{ gistId: string; url: string }> {
  const content = JSON.stringify(toWorkspaceFile(data, name));
  const body = JSON.stringify({ description: `Knowledge Graph — ${name}`, ...(gistId ? {} : { public: false }), files: { [FILE]: { content } } });
  const res = await fetch(gistId ? `${API}/gists/${gistId}` : `${API}/gists`, { method: gistId ? 'PATCH' : 'POST', headers: headers(token), body });
  await check(res);
  const json = (await res.json()) as { id: string; html_url: string };
  return { gistId: json.id, url: json.html_url };
}

export async function pullFromGist(token: string, gistId: string): Promise<{ name: string; data: GraphData; exportedAt: number }> {
  const res = await fetch(`${API}/gists/${gistId}`, { headers: headers(token) });
  await check(res);
  const json = (await res.json()) as { files: Record<string, { content?: string; truncated?: boolean; raw_url?: string }> };
  const f = json.files[FILE];
  if (!f) throw new Error(`The gist has no ${FILE} file.`);
  let text = f.content ?? '';
  if (f.truncated && f.raw_url) {
    const raw = await fetch(f.raw_url);
    text = await raw.text();
  }
  const parsed = parseWorkspaceJSON(text);
  let exportedAt = 0;
  try {
    exportedAt = (JSON.parse(text) as { exportedAt?: number }).exportedAt ?? 0;
  } catch {
    /* ignore */
  }
  return { ...parsed, exportedAt };
}
