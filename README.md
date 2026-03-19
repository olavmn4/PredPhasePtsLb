# MCSR Ranked S10 — Phase Points Leaderboard

## How it works
- **GitHub Pages** hosts the site (`index.html`)
- **GitHub Actions** runs every 5 minutes, fetches MCSR APIs, writes snapshots to Supabase
- **Supabase** stores the history (free Postgres)
- The leaderboard itself still updates every 60 seconds directly from the MCSR API

---

## Setup (one time)

### 1. Create Supabase project
1. Go to [supabase.com](https://supabase.com) → New project (free)
2. Once created, go to **SQL Editor** and run this:

```sql
create table snapshots (
  id bigint generated always as identity primary key,
  captured_at timestamptz not null default now(),
  players jsonb not null
);

-- Allow the frontend to read snapshots
create policy "allow public read" on snapshots
  for select using (true);

alter table snapshots enable row level security;

-- Index for faster queries
create index on snapshots (captured_at desc);
```

3. Go to **Settings → API** and copy:
   - **Project URL** → this is your `SUPABASE_URL`
   - **anon public** key → this is your `SUPABASE_ANON_KEY`

### 2. Add Supabase keys to index.html
Open `index.html` and replace near the top of the script:
```js
const SUPABASE_URL      = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
```

### 3. Push to GitHub
1. Create a new GitHub repo
2. Push this whole folder to it
3. Go to repo **Settings → Pages → Source: Deploy from branch → main → / (root)**

### 4. Add Supabase secrets to GitHub
Go to repo **Settings → Secrets and variables → Actions → New repository secret**:
- `SUPABASE_URL` = your Supabase project URL
- `SUPABASE_KEY` = your Supabase **service_role** key (not anon — this one can write)
  - Find it at Supabase → Settings → API → service_role

### 5. Enable GitHub Actions
Go to repo **Actions** tab → enable workflows if prompted.
The snapshot will now run automatically every 5 minutes.

You can also trigger it manually: **Actions → Snapshot MCSR Leaderboard → Run workflow**

---

## File structure
```
/
  index.html                          ← the website
  scripts/
    snapshot.js                       ← fetches MCSR API, writes to Supabase
  .github/
    workflows/
      snapshot.yml                    ← GitHub Action cron schedule
  README.md
```
