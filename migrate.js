import { writeFileSync } from 'fs';

const SUPABASE_URL = 'https://sjolzauhagjnuupectfs.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNqb2x6YXVoYWdqbnV1cGVjdGZzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Mzc1NzYzMCwiZXhwIjoyMDg5MzMzNjMwfQ.sPvjiajtbX-j3tfRYQ5hsSQTvcYo8X-4B7vIfurGJZM';

async function main() {
  let all = [];
  let offset = 0;
  const limit = 100;

  console.log('Fetching snapshots from Supabase...');

  while (true) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/snapshots?select=captured_at,players&order=captured_at.asc&limit=${limit}&offset=${offset}`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const row of rows) {
      all.push({
        t: Math.floor(new Date(row.captured_at).getTime() / 1000),
        players: row.players,
      });
    }

    console.log(`Fetched ${all.length} snapshots so far...`);
    if (rows.length < limit) break;
    offset += limit;
  }

  console.log(`Total: ${all.length} snapshots. Writing history.json...`);
  writeFileSync('history.json', JSON.stringify(all));
  console.log('Done!');
}

main().catch(e => { console.error(e); process.exit(1); });
