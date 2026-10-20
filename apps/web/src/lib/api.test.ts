import { beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  getRefreshToken: vi.fn(),
  setSession: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('./session', () => session);

import { ApiError, apiGet, apiPost } from './api';

const rotatedSession = {
  access_token: 'fresh-access-token',
  refresh_token: 'rotated-refresh-token',
  expires_in: 900,
};

describe('authenticated API requests', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    session.getAccessToken.mockResolvedValue('expired-access-token');
    session.getRefreshToken.mockResolvedValue('valid-refresh-token');
    session.setSession.mockResolvedValue(undefined);
  });

  it('refreshes and safely retries an emergency stop once', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 'TOKEN_EXPIRED', message: 'Access token has expired.' } },
          401,
        ),
      )
      .mockResolvedValueOnce(jsonResponse(rotatedSession))
      .mockResolvedValueOnce(jsonResponse({ stopped: true }));

    const body = {
      reason_code: 'OPERATOR_EMERGENCY_STOP',
      reason_detail: 'Operator activated emergency stop from the drill workbench.',
    };
    await expect(apiPost('/drills/drill-1/emergency-stop', body)).resolves.toEqual({
      stopped: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:4000/api/v1/drills/drill-1/emergency-stop',
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'http://127.0.0.1:4000/api/v1/auth/refresh',
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      'http://127.0.0.1:4000/api/v1/drills/drill-1/emergency-stop',
    );

    const firstRequest = fetchMock.mock.calls[0]?.[1];
    const retriedRequest = fetchMock.mock.calls[2]?.[1];
    expect(firstRequest?.body).toBe(JSON.stringify(body));
    expect(retriedRequest?.body).toBe(firstRequest?.body);
    expect(firstRequest?.headers).toMatchObject({
      authorization: 'Bearer expired-access-token',
    });
    expect(retriedRequest?.headers).toMatchObject({
      authorization: 'Bearer fresh-access-token',
    });
    expect(session.setSession).toHaveBeenCalledWith(rotatedSession);
  });

  it('does not loop when the retried mutation is rejected', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: 'TOKEN_EXPIRED', message: 'Expired.' } }, 401),
      )
      .mockResolvedValueOnce(jsonResponse(rotatedSession))
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: 'TOKEN_EXPIRED', message: 'Still expired.' } }, 401),
      );

    await expect(apiPost('/drills/drill-1/emergency-stop', {})).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
      status: 401,
    } satisfies Partial<ApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(session.getRefreshToken).toHaveBeenCalledTimes(1);
  });

  it('leaves GET refresh handling to the existing redirect route', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'TOKEN_EXPIRED', message: 'Expired.' } }, 401),
    );

    await expect(apiGet('/facilities')).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
      status: 401,
    } satisfies Partial<ApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(session.getRefreshToken).not.toHaveBeenCalled();
    expect(session.setSession).not.toHaveBeenCalled();
  });

  it('refreshes before a mutation when the access cookie is absent', async () => {
    session.getAccessToken.mockResolvedValue(null);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(rotatedSession))
      .mockResolvedValueOnce(jsonResponse({ stopped: true }));

    await expect(apiPost('/drills/drill-1/emergency-stop')).resolves.toEqual({
      stopped: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:4000/api/v1/auth/refresh',
    );
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer fresh-access-token',
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
