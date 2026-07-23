import { NextResponse } from 'next/server';
import { apiRefresh } from '@/lib/api';
import { clearSession, getRefreshToken, setSession } from '@/lib/session';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const next = safeConsolePath(url.searchParams.get('next'));
  const refreshToken = await getRefreshToken();

  if (!refreshToken) {
    await clearSession();
    return NextResponse.redirect(new URL('/login?error=SESSION_EXPIRED', url), 303);
  }

  try {
    const tokens = await apiRefresh(refreshToken);
    await setSession(tokens);
    return NextResponse.redirect(new URL(next, url), 303);
  } catch {
    await clearSession();
    return NextResponse.redirect(new URL('/login?error=SESSION_EXPIRED', url), 303);
  }
}

function safeConsolePath(value: string | null): string {
  if (!value || !value.startsWith('/console') || value.startsWith('//')) return '/console';
  return value;
}
