import { kv } from '@vercel/kv';

// Phase 3 points table indexed by rank
const PP_TABLE = [
  75,71,67,63,60,56,53,50,48,45,43,41,39,37,35,33,32,30,29,27,
  26,25,24,23,22,21,20,19,18,17,16,15,14,14,13,13,12,12,11,11,
  11,10,10,10,9,9,9,8,8,8,8,8,7,7,7,7,7,7,7,6,6,6,6,6,6,5,5,
  5,5,5,5,5,5,5,5,5,5,5,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,
  4,4,4,4,4,4
];
const p3Points = r => (r >= 1 && r <= 100) ? PP_TABLE[r - 1] : 0;

export const config = { maxDuration: 30 };

export default async function handler(req) {
  // Vercel cron requests include an Authorization header
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const [phaseRes, eloRes] = await Promise.all([
      fetch('https://api.mcsrranked.com/phase-leaderboard?predicted=true'),
      fetch('https://api.mcsrranked.com/leaderboard'),
    ]);
    const phaseJson = await phaseRes.json();
    const eloJson   = await eloRes.json();

    if (phaseJson.status !== 'success' || eloJson.status !== 'success') {
      return new Response('API error', { status: 502 });
    }

    const rawPhase = phaseJson.data.users || [];
    const rawElo   = eloJson.data.users   || [];

    // Build eloByRank from rawElo sorted by eloRate desc
    const eloSorted = [...rawElo].sort((a, b) => (b.eloRate ?? 0) - (a.eloRate ?? 0));
    const eloByRank = {};
    eloSorted.forEach((u, i) => { eloByRank[i + 1] = u.eloRate ?? 0; });

    const eloMap = {};
    for (const u of rawElo) eloMap[u.uuid] = { eloRate: u.eloRate, eloRank: u.eloRank };

    // Sort phase players by predPhasePoint desc, eloRank asc as tiebreak
    const sorted = [...rawPhase].sort((a, b) =>
      b.predPhasePoint - a.predPhasePoint || a.eloRank - b.eloRank
    );

    // Thresholds
    const playoffsPP = sorted.length >= 12  ? sorted[11].predPhasePoint : null;
    const lcqPP      = sorted.length >= 100 ? sorted[99].predPhasePoint : null;

    const now = Math.floor(Date.now() / 1000);

    // Build snapshot: one entry per player
    const snapshot = sorted.map((u, idx) => {
      const eloRate   = eloMap[u.uuid]?.eloRate  ?? u.eloRate  ?? 0;
      const eloRk     = eloMap[u.uuid]?.eloRank  ?? u.eloRank  ?? 0;
      const currentPP = u.seasonResult?.phasePoint ?? 0;
      const predPP    = u.predPhasePoint;
      const ppRk      = idx + 1; // positional, no tie grouping

      // Qual gap calculation (same simulation logic as frontend)
      function simulateQual(targetPosition) {
        const boundaryPlayer = sorted[targetPosition - 1];
        if (!boundaryPlayer) return null;
        const boundaryCurrentPP = boundaryPlayer.seasonResult?.phasePoint ?? 0;
        const boundaryEloRk     = eloMap[boundaryPlayer.uuid]?.eloRank ?? boundaryPlayer.eloRank ?? targetPosition;

        for (let r = eloRk; r >= 1; r--) {
          const myNewPredPP = currentPP + p3Points(r);
          let boundaryNewEloRk = boundaryEloRk;
          if (boundaryEloRk >= r && boundaryEloRk < eloRk) boundaryNewEloRk = boundaryEloRk + 1;
          const boundaryNewPredPP = boundaryCurrentPP + p3Points(boundaryNewEloRk);

          if (myNewPredPP > boundaryNewPredPP) {
            return Math.max(0, (eloByRank[r] ?? 0) - eloRate);
          }
          if (myNewPredPP === boundaryNewPredPP) {
            const boundaryNewElo = eloByRank[boundaryNewEloRk] ?? 0;
            const targetElo      = eloByRank[r] ?? 0;
            if (targetElo > boundaryNewElo) return Math.max(0, targetElo - eloRate);
          }
        }
        return null;
      }

      let qualType, qualGap;
      if (ppRk === 1) {
        qualType = 'top'; qualGap = 0;
      } else if (ppRk <= 12) {
        qualType = 'seed'; qualGap = simulateQual(ppRk - 1);
      } else if (lcqPP !== null && predPP >= lcqPP) {
        qualType = 'lcq_to_po'; qualGap = simulateQual(12);
      } else {
        qualType = 'lcq'; qualGap = simulateQual(100);
      }

      return {
        uuid:    u.uuid,
        name:    u.nickname,
        country: u.country ?? null,
        eloRate,
        eloRk,
        predPP,
        currentPP,
        ppRk,
        qualType,
        qualGap,
      };
    });

    // Also include zero-PP players from elo leaderboard
    const phaseUuids = new Set(rawPhase.map(u => u.uuid));
    for (const u of rawElo) {
      if (phaseUuids.has(u.uuid)) continue;
      snapshot.push({
        uuid:    u.uuid,
        name:    u.nickname,
        country: u.country ?? null,
        eloRate: u.eloRate ?? 0,
        eloRk:   u.eloRank ?? 0,
        predPP:  0,
        currentPP: u.seasonResult?.phasePoint ?? 0,
        ppRk:    sorted.length + 1,
        qualType: 'lcq',
        qualGap:  simulateQualZero(u, sorted, eloMap, eloByRank, lcqPP),
      });
    }

    // Store snapshot to KV
    // Key: snapshot list (capped at 2000 entries) and latest snapshot
    const SNAPSHOTS_KEY = 'snapshots';
    const MAX_SNAPSHOTS = 2000;

    const existing = await kv.get(SNAPSHOTS_KEY) ?? [];
    const updated  = [...existing, { t: now, players: snapshot }];
    if (updated.length > MAX_SNAPSHOTS) updated.splice(0, updated.length - MAX_SNAPSHOTS);
    await kv.set(SNAPSHOTS_KEY, updated);

    return new Response(JSON.stringify({ ok: true, t: now, count: updated.length }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
}

function simulateQualZero(u, sorted, eloMap, eloByRank, lcqPP) {
  if (lcqPP === null) return null;
  const eloRate   = u.eloRate ?? 0;
  const eloRk     = u.eloRank ?? 999;
  const currentPP = u.seasonResult?.phasePoint ?? 0;
  const boundary  = sorted[99];
  if (!boundary) return null;
  const boundaryCurrentPP = boundary.seasonResult?.phasePoint ?? 0;
  const boundaryEloRk     = eloMap[boundary.uuid]?.eloRank ?? boundary.eloRank ?? 100;

  for (let r = eloRk; r >= 1; r--) {
    const myNew = currentPP + p3Points(r);
    let bEloRk  = boundaryEloRk;
    if (bEloRk >= r && bEloRk < eloRk) bEloRk++;
    const bNew  = boundaryCurrentPP + p3Points(bEloRk);
    if (myNew > bNew) return Math.max(0, (eloByRank[r] ?? 0) - eloRate);
    if (myNew === bNew && (eloByRank[r] ?? 0) > (eloByRank[bEloRk] ?? 0))
      return Math.max(0, (eloByRank[r] ?? 0) - eloRate);
  }
  return null;
}
