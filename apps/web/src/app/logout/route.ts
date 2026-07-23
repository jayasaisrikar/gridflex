import { NextResponse } from 'next/server';
import { apiPost } from '@/lib/api';
import { clearSession } from '@/lib/session';

export async function POST(request: Request) {
  try {
    await apiPost('/auth/logout');
  } catch {
    // Cookie removal is the local safety boundary. The API may already be
    // unavailable or the access token expired, so sign-out must still finish.
  }
  await clearSession();
  return NextResponse.redirect(new URL('/login', request.url), 303);
}
