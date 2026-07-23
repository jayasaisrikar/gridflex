import { apiGet } from '@/lib/api';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ exportId: string }> },
) {
  const { exportId } = await params;
  const result = await apiGet<{
    content_type: string;
    content_encoding: 'utf8' | 'base64';
    filename: string;
    content: string;
  }>(`/exports/${encodeURIComponent(exportId)}`);
  const filename = result.filename.replace(/[^a-zA-Z0-9._-]/g, '-');
  const body = result.content_encoding === 'base64'
    ? Uint8Array.from(Buffer.from(result.content, 'base64'))
    : result.content;
  return new Response(body, {
    headers: {
      'content-type': result.content_type,
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  });
}
