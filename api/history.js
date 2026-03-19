import { kv } from '@vercel/kv';

export default async function handler(req) {
  try {
    const snapshots = await kv.get('snapshots') ?? [];
    return new Response(JSON.stringify({ ok: true, snapshots }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, s-maxage=30',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
}
