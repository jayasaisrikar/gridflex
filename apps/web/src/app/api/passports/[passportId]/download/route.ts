import { apiGet } from '@/lib/api';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ passportId: string }> },
) {
  const { passportId } = await params;
  const result = await apiGet<Record<string, unknown>>(
    `/passports/${encodeURIComponent(passportId)}/json`,
  );
  return new Response(`${JSON.stringify(result, null, 2)}\n`, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="gridflex-passport-${passportId}.json"`,
      'cache-control': 'private, no-store',
    },
  });
}
