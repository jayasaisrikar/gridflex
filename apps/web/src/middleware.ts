import { NextResponse, type NextRequest } from 'next/server';

/** Passes the current console route to server-only session recovery. */
export function middleware(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(
    'x-gridflex-pathname',
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
  );
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ['/console/:path*'],
};
