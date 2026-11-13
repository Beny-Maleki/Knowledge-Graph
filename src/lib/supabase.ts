import { createClient } from '@supabase/supabase-js';

/**
 * Public connection details. The publishable key is designed to be shipped in
 * browser code: every table is protected by row-level security, so it only
 * lets a visitor sign in and then read or write *their own* rows.
 * Override with VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY to point a
 * fork at a different project.
 */
export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL ?? 'https://jjlakailfjumuywghijy.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY: string = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_Wmup3Q-6OaH76bm8Uin7eQ_U4mwPX_V';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    flowType: 'pkce',
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'kg:auth',
  },
});

/** Where email links (confirmation, magic link, password reset) and OAuth return to. */
export function appRedirectUrl(): string {
  return window.location.origin + window.location.pathname;
}

export type OAuthProvider = 'github' | 'google';

/** Which social logins are enabled in the Supabase dashboard (public endpoint). */
export async function enabledProviders(): Promise<OAuthProvider[]> {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: SUPABASE_PUBLISHABLE_KEY } });
    if (!res.ok) return [];
    const json = (await res.json()) as { external?: Record<string, boolean> };
    return (['github', 'google'] as OAuthProvider[]).filter((p) => json.external?.[p]);
  } catch {
    return [];
  }
}
