import 'server-only';
import { cookies } from 'next/headers';

/**
 * Session storage.
 *
 * Tokens live in httpOnly cookies and are read ONLY on the server. Spec §18
 * forbids credentials in browser bundles, so the access token must never reach
 * client JavaScript — every authenticated call is made from a server component
 * or route handler.
 */
const ACCESS_COOKIE = 'gf_at';
const REFRESH_COOKIE = 'gf_rt';

export async function getAccessToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(ACCESS_COOKIE)?.value ?? null;
}

export async function getRefreshToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(REFRESH_COOKIE)?.value ?? null;
}

export async function setSession(tokens: {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}): Promise<void> {
  const store = await cookies();
  const secure = process.env.NODE_ENV === 'production';

  store.set(ACCESS_COOKIE, tokens.access_token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: tokens.expires_in,
  });

  store.set(REFRESH_COOKIE, tokens.refresh_token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(ACCESS_COOKIE);
  store.delete(REFRESH_COOKIE);
}
