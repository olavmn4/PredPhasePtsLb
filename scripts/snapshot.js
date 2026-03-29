import { writeFileSync, readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const PP_TABLE = [
  75,71,67,63,60,56,53,50,48,45,43,41,39,37,35,33,32,30,29,27,
  26,25,24,23,22,21,20,19,18,17,16,15,14,14,13,13,12,12,11,11,
  11,10,10,10,9,9,9,8,8,8,8,8,7,7,7,7,7,7,7,6,6,6,6,6,6,5,5,
  5,5,5,5,5,5,5,5,5,5,5,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4
];
const p3Points = r => (r >= 1 && r <= 100) ? PP_TABLE[r - 1] : 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_LP_FETCHES = 30;
const MAX_SNAPSHOTS = 2000;
const HISTORY_FILE = 'history.json';

async function fetchLastPlayed(uuid) {
  try {
    const r = await fetch(`https://api.mcsrranked.com/users/${uuid}/matches?count=1&type=2&excludedecay=true`);
    const j = await r.json();
    if (j.status === 'success' && j.data?.length) return j.data[0].date;
  } catch {}
  return null;
}

async function main() {
  const [phaseRes, eloRes] = await Promise.all([
    fetch('https://api.mcsrranked.com/phase-leaderboard?predicted=true'),
    fetch('https://api.mcsrranked.com/leaderboard'),
  ]);
  const phaseJson = await phaseRes.json();
  const eloJson   = await eloRes.json();

  if (phaseJson.status !== 'success' || eloJson.status !== 'success') {
    throw new Error('MCSR API returned non-success');
  }

  const rawPhase = phaseJson.data.users || [];
  const rawElo   = eloJson.data.users   || [];

  const eloSorted = [...rawElo].sort((a, b) => (b.eloRate ?? 0) - (a.eloRate ?? 0));
  const eloByRank = {};
  eloSorted.forEach((u, i) => { eloByRank[i + 1] = u.eloRate ?? 0; });

  const eloMap = {};
  for (const u of rawElo) eloMap[u.uuid] = { eloRate: u.eloRate, eloRank: u.eloRank };

  const sorted = [...rawPhase].sort((a, b) =>
    b.predPhasePoint - a.predPhasePoint || a.eloRank - b.eloRank
  );

  const lcqPP = sorted.length >= 100 ? sorted[99].predPhasePoint : null;

  function simulateQual(currentPP, eloRate, eloRk, targetPosition) {
    const boundary = sorted[targetPosition - 1];
    if (!boundary) return null;
    const bCurrentPP = boundary.seasonResult?.phasePoint ?? 0;
    const bEloRk = eloMap[boundary.uuid]?.eloRank ?? boundary.eloRank ?? targetPosition;
    for (let r = eloRk; r >= 1; r--) {
      const myNew = currentPP + p3Points(r);
      let bNewEloRk = bEloRk;
      if (bEloRk >= r && bEloRk < eloRk) bNewEloRk++;
      const bNew = bCurrentPP + p3Points(bNewEloRk);
      if (myNew > bNew) return Math.max(0, (eloByRank[r] ?? 0) - eloRate);
      if (myNew === bNew && (eloByRank[r] ?? 0) > (eloByRank[bNewEloRk] ?? 0))
        return Math.max(0, (eloByRank[r] ?? 0) - eloRate);
    }
    return null;
  }

  // Load existing history from file
  let history = [];
  if (existsSync(HISTORY_FILE)) {
    try { history = JSON.parse(readFileSync(HISTORY_FILE, 'utf8')); } catch {}
  }

  // Get previous snapshot for last-played cache
  const prevPlayers = history.length ? history[history.length - 1].players : [];
  const prevMap = {};
  for (const p of prevPlayers) prevMap[p.uuid] = { eloRate: p.eloRate, lastPlayed: p.lastPlayed ?? null };

  const phaseUuids = new Set(rawPhase.map(u => u.uuid));
  const allUuids = [
    ...sorted.map(u => u.uuid),
    ...rawElo.filter(u => !phaseUuids.has(u.uuid)).map(u => u.uuid),
  ];

  const needsFetch = [];
  for (const uuid of allUuids) {
    const prev = prevMap[uuid];
    const currElo = eloMap[uuid]?.eloRate ?? 0;
    if (!prev || prev.lastPlayed === null) { needsFetch.push(uuid); continue; }
    const diff = currElo - prev.eloRate;
    if (diff !== 0 && diff !== -5) needsFetch.push(uuid);
  }

  const toFetch = needsFetch.slice(0, MAX_LP_FETCHES);
  console.log(`Fetching lastPlayed for ${toFetch.length}/${needsFetch.length} needed, reusing ${allUuids.length - needsFetch.length} from cache`);

  const lastPlayedMap = {};
  for (const uuid of allUuids) {
    if (!needsFetch.includes(uuid)) lastPlayedMap[uuid] = prevMap[uuid]?.lastPlayed ?? null;
  }
  for (const uuid of toFetch) {
    lastPlayedMap[uuid] = await fetchLastPlayed(uuid);
    await sleep(100);
  }

  const players = sorted.map((u, idx) => {
    const eloRate   = eloMap[u.uuid]?.eloRate ?? u.eloRate ?? 0;
    const eloRk     = eloMap[u.uuid]?.eloRank ?? u.eloRank ?? 0;
    const currentPP = u.seasonResult?.phasePoint ?? 0;
    const predPP    = u.predPhasePoint;
    const ppRk      = idx + 1;
    let qualType, qualGap;
    if (ppRk === 1)                             { qualType = 'top';       qualGap = 0; }
    else if (ppRk <= 12)                        { qualType = 'seed';      qualGap = simulateQual(currentPP, eloRate, eloRk, ppRk - 1); }
    else if (lcqPP !== null && predPP >= lcqPP) { qualType = 'lcq_to_po'; qualGap = simulateQual(currentPP, eloRate, eloRk, 12); }
    else                                        { qualType = 'lcq';       qualGap = simulateQual(currentPP, eloRate, eloRk, 100); }
    return { uuid: u.uuid, eloRate, ppRk, qualType, qualGap, lastPlayed: lastPlayedMap[u.uuid] ?? null };
  });

  for (const u of rawElo) {
    if (phaseUuids.has(u.uuid)) continue;
    const eloRate   = u.eloRate ?? 0;
    const eloRk     = u.eloRank ?? 999;
    const currentPP = u.seasonResult?.phasePoint ?? 0;
    players.push({ uuid: u.uuid, eloRate, ppRk: sorted.length + 1, qualType: 'lcq', qualGap: simulateQual(currentPP, eloRate, eloRk, 100), lastPlayed: lastPlayedMap[u.uuid] ?? null });
  }

  // Append new snapshot and prune old ones
  const now = Math.floor(Date.now() / 1000);
  history.push({ t: now, players });
  if (history.length > MAX_SNAPSHOTS) history.splice(0, history.length - MAX_SNAPSHOTS);

  writeFileSync(HISTORY_FILE, JSON.stringify(history));
  console.log(`Saved ${players.length} players, ${history.length} total snapshots`);

  // Write lastplayed.json — flat map of uuid → timestamp for instant page load
  const lastPlayedOut = {};
  for (const p of players) {
    if (p.lastPlayed) lastPlayedOut[p.uuid] = p.lastPlayed;
  }
  writeFileSync('lastplayed.json', JSON.stringify(lastPlayedOut));

  // Commit and push
  execSync('git config user.name "github-actions[bot]"');
  execSync('git config user.email "github-actions[bot]@users.noreply.github.com"');
  execSync(`git add ${HISTORY_FILE} lastplayed.json`);
  try {
    execSync('git diff --staged --quiet');
    console.log('No changes to commit');
  } catch {
    execSync(`git commit -m "snapshot ${new Date().toISOString()} [skip ci]"`);
    execSync('git push');
    console.log('Pushed history.json');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
