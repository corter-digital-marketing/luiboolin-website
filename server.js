const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const url    = require('url');

const PORT = process.env.PORT || 3000;
const BASE = __dirname;

// ── Config ───────────────────────────────────────────────────────
let localConfig = {};
try { localConfig = JSON.parse(fs.readFileSync(path.join(BASE, 'config.json'), 'utf8')); } catch (_) {}

const CLIENT_ID     = process.env.DISCORD_CLIENT_ID     || localConfig.DISCORD_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || localConfig.DISCORD_CLIENT_SECRET || '';
const REDIRECT_URI  = process.env.REDIRECT_URI          || localConfig.REDIRECT_URI          || `http://localhost:${PORT}/auth/discord/callback`;

// ── PostgreSQL (production) ───────────────────────────────────────
// Vercel's own Postgres storage integration names its connection string
// POSTGRES_URL rather than DATABASE_URL — accept either so connecting a
// database there doesn't also require manually renaming an env var.
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
let pool = null;
if (DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT, display_name TEXT, avatar TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS ranked_wins INTEGER DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS casual_wins INTEGER DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS embark_id TEXT;
    CREATE TABLE IF NOT EXISTS pug_queue (
      user_id TEXT PRIMARY KEY, mode TEXT NOT NULL,
      display_name TEXT, avatar TEXT,
      joined_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pug_lobbies (
      id TEXT PRIMARY KEY, mode TEXT NOT NULL,
      map TEXT, weapon TEXT, host TEXT, code TEXT,
      team_a JSONB NOT NULL, team_b JSONB NOT NULL,
      votes JSONB NOT NULL DEFAULT '{}', chat JSONB NOT NULL DEFAULT '[]',
      result TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pug_user_lobby (
      user_id TEXT PRIMARY KEY, lobby_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, captain_id TEXT NOT NULL,
      invite_code TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL, user_id TEXT NOT NULL,
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (team_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS tournament_entries (
      tournament TEXT NOT NULL, team_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (tournament, team_id)
    );
  `).then(() => console.log('DB ready')).catch(e => console.error('DB init error:', e.message));
}

// ── Local file DB ────────────────────────────────────────────────
const DB_PATH = process.env.VERCEL ? '/tmp/db.json' : path.join(BASE, 'db.json');

function readDb() {
  try {
    const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    return {
      users:               data.users               || {},
      teams:               data.teams               || {},
      team_members:        data.team_members        || {},
      tournament_entries:  data.tournament_entries  || {},
      matches:             data.matches             || [],
    };
  } catch (_) {
    return { users: {}, teams: {}, team_members: {}, tournament_entries: {}, matches: [] };
  }
}
function writeDb(data) { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); }

// ── Helpers ──────────────────────────────────────────────────────
function generateId()   { return crypto.randomBytes(8).toString('hex'); }
function generateCode() { return crypto.randomBytes(3).toString('hex').toUpperCase(); }
function randomToken()  { return crypto.randomBytes(32).toString('hex'); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function parseCookies(h) {
  const out = {};
  if (!h) return out;
  h.split(';').forEach(c => { const [k, v] = c.trim().split('='); if (k) out[k.trim()] = (v || '').trim(); });
  return out;
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function discordPost(p, body) {
  return new Promise((resolve, reject) => {
    const encoded = new URLSearchParams(body).toString();
    const req = https.request({
      hostname: 'discord.com', path: p, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(encoded) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error(`Discord token exchange failed (${res.statusCode}): ${d}`)); return; }
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(`Discord token exchange returned invalid JSON: ${d}`)); }
      });
    });
    req.on('error', reject); req.write(encoded); req.end();
  });
}

function discordGet(p, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'discord.com', path: p,
      headers: { Authorization: `Bearer ${token}` },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error(`Discord API request failed (${res.statusCode}): ${d}`)); return; }
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(`Discord API returned invalid JSON: ${d}`)); }
      });
    });
    req.on('error', reject); req.end();
  });
}

// ── Live status (Twitch / YouTube) ────────────────────────────────
const LIVE_CHANNELS = [
  { url: 'https://www.twitch.tv/luiboolin',     platform: 'twitch',  channel: 'luiboolin' },
  { url: 'https://www.twitch.tv/nvrlive',       platform: 'twitch',  channel: 'nvrlive' },
  { url: 'https://www.twitch.tv/tecniqttv',     platform: 'twitch',  channel: 'tecniqttv' },
  { url: 'https://www.twitch.tv/icecoldboard',  platform: 'twitch',  channel: 'icecoldboard' },
  { url: 'https://www.twitch.tv/wasdwsadstf',   platform: 'twitch',  channel: 'wasdwsadstf' },
];

// Twitch's public web Client-Id (used by twitch.tv itself) — no app registration needed.
const TWITCH_WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

function isTwitchLive(login) {
  return new Promise(resolve => {
    const body = JSON.stringify({ query: `{ user(login: "${login}") { stream { id } } }` });
    const req = https.request({
      hostname: 'gql.twitch.tv', path: '/gql', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Client-Id': TWITCH_WEB_CLIENT_ID, 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(!!JSON.parse(d).data.user.stream); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(8000, () => req.destroy());
    req.write(body); req.end();
  });
}

function isYoutubeLive(handle) {
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'www.youtube.com', path: `/@${handle}/live`,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve(d.includes('"isLive":true')));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(8000, () => req.destroy());
    req.end();
  });
}

let liveStatusCache = { data: {}, ts: 0 };
const LIVE_CACHE_TTL = 30000;

async function getLiveStatus() {
  if (Date.now() - liveStatusCache.ts < LIVE_CACHE_TTL) return liveStatusCache.data;
  const results = await Promise.all(LIVE_CHANNELS.map(c =>
    (c.platform === 'twitch' ? isTwitchLive(c.channel) : isYoutubeLive(c.channel))
      .catch(() => false)
  ));
  const data = {};
  LIVE_CHANNELS.forEach((c, i) => { data[c.url] = results[i]; });
  liveStatusCache = { data, ts: Date.now() };
  return data;
}

// ── User DB ──────────────────────────────────────────────────────
async function dbSaveUser(u) {
  if (pool) {
    await pool.query(
      `INSERT INTO users (id,username,display_name,avatar,updated_at) VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (id) DO UPDATE SET username=$2,display_name=$3,avatar=$4,updated_at=NOW()`,
      [u.id, u.username, u.display_name, u.avatar]);
    return;
  }
  const db = readDb(); db.users[u.id] = u; writeDb(db);
}

// ── Team DB ──────────────────────────────────────────────────────
function normalizeTeam(t) {
  if (!t) return null;
  return {
    id:         t.id,
    name:       t.name,
    captainId:  t.captain_id  || t.captainId,
    inviteCode: t.invite_code || t.inviteCode,
    createdAt:  t.created_at  || t.createdAt,
  };
}

async function dbGetTeamByUser(userId) {
  if (pool) {
    const r = await pool.query(
      'SELECT t.* FROM teams t JOIN team_members tm ON tm.team_id=t.id WHERE tm.user_id=$1', [userId]);
    return normalizeTeam(r.rows[0]);
  }
  const db = readDb();
  const m = Object.values(db.team_members).find(m => m.userId === userId);
  return m ? normalizeTeam(db.teams[m.teamId]) : null;
}

async function dbGetTeamMembers(teamId) {
  if (pool) {
    const r = await pool.query(
      `SELECT u.id, u.display_name, u.avatar FROM team_members tm
       JOIN users u ON u.id=tm.user_id WHERE tm.team_id=$1 ORDER BY tm.joined_at`, [teamId]);
    return r.rows.map(r => ({ id: r.id, displayName: r.display_name, avatar: r.avatar }));
  }
  const db = readDb();
  return Object.values(db.team_members)
    .filter(m => m.teamId === teamId)
    .map(m => {
      const u = db.users[m.userId] || {};
      return { id: m.userId, displayName: u.display_name || u.displayName, avatar: u.avatar };
    });
}

async function dbCreateTeam(team) {
  if (pool) {
    await pool.query('INSERT INTO teams (id,name,captain_id,invite_code) VALUES ($1,$2,$3,$4)',
      [team.id, team.name, team.captainId, team.inviteCode]);
    await pool.query('INSERT INTO team_members (team_id,user_id) VALUES ($1,$2)', [team.id, team.captainId]);
    return;
  }
  const db = readDb();
  if (Object.values(db.teams).some(t => t.name.toLowerCase() === team.name.toLowerCase()))
    throw new Error('UNIQUE constraint: name');
  db.teams[team.id] = team;
  db.team_members[`${team.id}_${team.captainId}`] = { teamId: team.id, userId: team.captainId, joinedAt: new Date().toISOString() };
  writeDb(db);
}

async function dbJoinTeam(teamId, userId) {
  if (pool) {
    await pool.query('INSERT INTO team_members (team_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [teamId, userId]);
    return;
  }
  const db = readDb();
  db.team_members[`${teamId}_${userId}`] = { teamId, userId, joinedAt: new Date().toISOString() };
  writeDb(db);
}

async function dbLeaveTeam(teamId, userId) {
  if (pool) {
    await pool.query('DELETE FROM team_members WHERE team_id=$1 AND user_id=$2', [teamId, userId]);
    const c = await pool.query('SELECT COUNT(*) FROM team_members WHERE team_id=$1', [teamId]);
    if (parseInt(c.rows[0].count, 10) === 0) {
      await pool.query('DELETE FROM tournament_entries WHERE team_id=$1', [teamId]);
      await pool.query('DELETE FROM teams WHERE id=$1', [teamId]);
    }
    return;
  }
  const db = readDb();
  delete db.team_members[`${teamId}_${userId}`];
  if (!Object.values(db.team_members).some(m => m.teamId === teamId)) {
    delete db.tournament_entries[`season1_${teamId}`];
    delete db.teams[teamId];
  }
  writeDb(db);
}

async function dbGetTeamByInviteCode(code) {
  if (pool) {
    const r = await pool.query('SELECT * FROM teams WHERE UPPER(invite_code)=$1', [code.toUpperCase()]);
    return normalizeTeam(r.rows[0]);
  }
  const db = readDb();
  const t = Object.values(db.teams).find(t => (t.inviteCode || '').toUpperCase() === code.toUpperCase());
  return normalizeTeam(t) || null;
}

// ── Tournament entry DB ──────────────────────────────────────────
async function dbRegisterTeam(tournament, teamId) {
  if (pool) {
    await pool.query('INSERT INTO tournament_entries (tournament,team_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [tournament, teamId]);
    return;
  }
  const db = readDb();
  db.tournament_entries[`${tournament}_${teamId}`] = { tournament, teamId, registeredAt: new Date().toISOString() };
  writeDb(db);
}

async function dbGetTeamEntry(tournament, teamId) {
  if (pool) {
    const r = await pool.query('SELECT * FROM tournament_entries WHERE tournament=$1 AND team_id=$2', [tournament, teamId]);
    return r.rows[0] || null;
  }
  return readDb().tournament_entries[`${tournament}_${teamId}`] || null;
}

async function dbCountEntries(tournament) {
  if (pool) {
    const r = await pool.query('SELECT COUNT(*) FROM tournament_entries WHERE tournament=$1', [tournament]);
    return parseInt(r.rows[0].count, 10);
  }
  return Object.values(readDb().tournament_entries).filter(e => e.tournament === tournament).length;
}

async function dbGetTournamentEntries(tournament) {
  if (pool) {
    const r = await pool.query(
      `SELECT te.team_id, te.registered_at, t.name as team_name, t.captain_id
       FROM tournament_entries te JOIN teams t ON t.id=te.team_id
       WHERE te.tournament=$1 ORDER BY te.registered_at`, [tournament]);
    return r.rows;
  }
  const db = readDb();
  return Object.values(db.tournament_entries)
    .filter(e => e.tournament === tournament)
    .map(e => {
      const t = db.teams[e.teamId] || {};
      return { team_id: e.teamId, registered_at: e.registeredAt, team_name: t.name, captain_id: t.captainId };
    });
}

// ── Season 1 Bracket ─────────────────────────────────────────────────────────
function defaultBracket() {
  return {
    seeds: {
      qf1: { team1: null, team2: null },
      qf2: { team1: null, team2: null },
      qf3: { team1: null, team2: null },
      qf4: { team1: null, team2: null },
    },
    results: { qf1: null, qf2: null, qf3: null, qf4: null, sf1: null, sf2: null, f1: null },
  };
}

function readBracket() {
  const db = readDb();
  return db.s1_bracket || defaultBracket();
}

function writeBracket(b) {
  const db = readDb();
  db.s1_bracket = b;
  writeDb(db);
}

function deriveBracket(b) {
  const s = b.seeds; const r = b.results;
  return {
    qf: [
      { id: 'qf1', team1: s.qf1.team1, team2: s.qf1.team2, winner: r.qf1 },
      { id: 'qf2', team1: s.qf2.team1, team2: s.qf2.team2, winner: r.qf2 },
      { id: 'qf3', team1: s.qf3.team1, team2: s.qf3.team2, winner: r.qf3 },
      { id: 'qf4', team1: s.qf4.team1, team2: s.qf4.team2, winner: r.qf4 },
    ],
    sf: [
      { id: 'sf1', team1: r.qf1 || null, team2: r.qf2 || null, winner: r.sf1 },
      { id: 'sf2', team1: r.qf3 || null, team2: r.qf4 || null, winner: r.sf2 },
    ],
    final: { id: 'f1', team1: r.sf1 || null, team2: r.sf2 || null, winner: r.f1 },
  };
}

// ── Leaderboard ─────────────────────────────────────────────────────────────
function computeLeaderboard(matches) {
  const teams = {};
  for (const m of matches) {
    if (!teams[m.team1]) teams[m.team1] = { team: m.team1, wins: 0, losses: 0, gp: 0, points: 0 };
    if (!teams[m.team2]) teams[m.team2] = { team: m.team2, wins: 0, losses: 0, gp: 0, points: 0 };
    teams[m.team1].gp++;
    teams[m.team2].gp++;
    if (m.winner === m.team1) {
      teams[m.team1].wins++;   teams[m.team1].points += 3;
      teams[m.team2].losses++;
    } else {
      teams[m.team2].wins++;   teams[m.team2].points += 3;
      teams[m.team1].losses++;
    }
  }
  return Object.values(teams).sort((a, b) => b.points - a.points || b.wins - a.wins);
}

// ── Pugs (3v3 matchmaking) ─────────────────────────────────────────────────
const MAP_POOL = [
  { name: 'Fangwai City',      banned: false },
  { name: 'NOZOMI/CITADEL',    banned: false },
  { name: 'Las Vegas Stadium', banned: false },
  { name: 'Bernal',            banned: false },
  { name: 'Fortune Stadium',   banned: false },
  { name: 'Kyoto',             banned: true  },
  { name: 'SYS$HORIZON',       banned: false },
  { name: 'Skyway Stadium',    banned: false },
  { name: 'Seoul',             banned: true  },
  { name: 'Monoco',            banned: false },
];

const WEAPON_POOL = [
  '93R','ARN-220','DAGGER','LH1','M11','M26 MATTER','RECURVE BOW','SH1900','SR-84','SWORD',
  'THROWING KNIVES','V9S','XP-54','AKM','CB-01 REPEATER','CERBERUS 12GA','CHIMERA-XB','CL-40',
  'DUAL BLADES','FAMAS','FCAR','MODEL 1887','P90','PIKE-556','R.357','RIOT SHIELD','.50 AKIMBO',
  'BFR TITAN','FLAMETHROWER','KS-23','LEWIS GUN','M134 MINIGUN','M60','MGL32','SA1216','SHAK-50',
  'SLEDGEHAMMER','SPEAR',
];

function pick(arr)    { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const pugQueues = { casual: [], competitive: [] }; // [{ userId, displayName, avatar }]
const pugLobbies = {};   // lobbyId -> lobby
const userLobbyId = {};  // userId -> lobbyId

async function getRankedWins(userId) {
  if (pool) {
    const r = await pool.query('SELECT ranked_wins FROM users WHERE id=$1', [userId]);
    return (r.rows[0] && r.rows[0].ranked_wins) || 0;
  }
  const db = readDb();
  return (db.users[userId] && db.users[userId].rankedWins) || 0;
}

async function addRankedWin(userId) {
  if (pool) {
    await pool.query(
      `INSERT INTO users (id, ranked_wins) VALUES ($1, 1)
       ON CONFLICT (id) DO UPDATE SET ranked_wins = COALESCE(users.ranked_wins,0) + 1`,
      [userId]);
    return;
  }
  const db = readDb();
  if (!db.users[userId]) db.users[userId] = {};
  db.users[userId].rankedWins = (db.users[userId].rankedWins || 0) + 1;
  writeDb(db);
}

async function addCasualWin(userId) {
  if (pool) {
    await pool.query(
      `INSERT INTO users (id, casual_wins) VALUES ($1, 1)
       ON CONFLICT (id) DO UPDATE SET casual_wins = COALESCE(users.casual_wins,0) + 1`,
      [userId]);
    return;
  }
  const db = readDb();
  if (!db.users[userId]) db.users[userId] = {};
  db.users[userId].casualWins = (db.users[userId].casualWins || 0) + 1;
  writeDb(db);
}

async function getCasualWins(userId) {
  if (pool) {
    const r = await pool.query('SELECT casual_wins FROM users WHERE id=$1', [userId]);
    return (r.rows[0] && r.rows[0].casual_wins) || 0;
  }
  const db = readDb();
  return (db.users[userId] && db.users[userId].casualWins) || 0;
}

async function getEmbarkId(userId) {
  if (pool) {
    const r = await pool.query('SELECT embark_id FROM users WHERE id=$1', [userId]);
    return (r.rows[0] && r.rows[0].embark_id) || null;
  }
  const db = readDb();
  return (db.users[userId] && db.users[userId].embarkId) || null;
}

async function setEmbarkId(userId, embarkId) {
  if (pool) {
    await pool.query(
      `INSERT INTO users (id, embark_id) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET embark_id = $2`,
      [userId, embarkId || null]);
    return;
  }
  const db = readDb();
  if (!db.users[userId]) db.users[userId] = {};
  db.users[userId].embarkId = embarkId || null;
  writeDb(db);
}

// Embark IDs look like "Name#1957" — display everywhere without the tag.
function stripEmbarkTag(name) {
  return name ? name.replace(/#\d+$/, '') : name;
}

const RANK_TIERS = [
  { wins: 30, name: 'BOOLIN' },
  { wins: 15, name: 'Beamer' },
  { wins: 10, name: 'Gamer' },
  { wins: 5,  name: 'Pup' },
  { wins: 1,  name: 'Trainee' },
];
function getRankName(wins) {
  for (const tier of RANK_TIERS) if (wins >= tier.wins) return tier.name;
  return 'Unranked';
}

async function getWinsLeaderboard(column, limit) {
  if (pool) {
    const r = await pool.query(
      `SELECT id, COALESCE(NULLIF(embark_id, ''), display_name, username, 'Unknown Player') AS display_name, avatar, ${column} AS wins
       FROM users WHERE ${column} > 0 ORDER BY ${column} DESC, updated_at ASC LIMIT $1`,
      [limit]);
    return r.rows.map(row => ({ userId: row.id, displayName: stripEmbarkTag(row.display_name), avatar: row.avatar, wins: row.wins }));
  }
  const db = readDb();
  const field = column === 'ranked_wins' ? 'rankedWins' : 'casualWins';
  return Object.entries(db.users)
    .map(([id, u]) => ({ userId: id, displayName: stripEmbarkTag(u.embarkId || u.displayName || u.display_name || id), avatar: u.avatar, wins: u[field] || 0 }))
    .filter(u => u.wins > 0)
    .sort((a, b) => b.wins - a.wins)
    .slice(0, limit);
}

// Pure construction of a lobby's contents — no storage side effects, so it's
// safe to call from either the Postgres path or the in-memory path.
async function buildPugLobby(mode, players) {
  const id = generateId();
  const eligibleMaps = MAP_POOL.filter(m => mode === 'casual' || !m.banned).map(m => m.name);
  const map = pick(eligibleMaps);
  const weapon = mode === 'casual' ? pick(WEAPON_POOL) : null;
  const shuffled = shuffle(players);
  const teamA = shuffled.slice(0, 3);
  const teamB = shuffled.slice(3, 6);
  const allPlayers = [...teamA, ...teamB];

  for (const p of allPlayers) {
    const embarkId = await getEmbarkId(p.userId);
    if (embarkId) p.displayName = stripEmbarkTag(embarkId);
  }

  const winsGetter = mode === 'competitive' ? getRankedWins : getCasualWins;
  const winCounts = await Promise.all(allPlayers.map(p => winsGetter(p.userId)));
  if (mode === 'competitive') {
    allPlayers.forEach((p, i) => { p.rankedWins = winCounts[i]; });
  }
  let hostIdx = 0;
  for (let i = 1; i < allPlayers.length; i++) if (winCounts[i] > winCounts[hostIdx]) hostIdx = i;
  const host = allPlayers[hostIdx].userId;

  return { id, mode, map, weapon, host, code: null, teamA, teamB, votes: {}, chat: [], result: null };
}

function serializePugLobby(lobby, forUserId) {
  const voteCounts = { teamA: 0, teamB: 0 };
  Object.values(lobby.votes).forEach(v => { voteCounts[v]++; });
  return {
    id: lobby.id,
    mode: lobby.mode,
    map: lobby.map,
    weapon: lobby.weapon,
    host: lobby.host,
    isHost: lobby.host === forUserId,
    code: lobby.code,
    teamA: lobby.teamA,
    teamB: lobby.teamB,
    myVote: lobby.votes[forUserId] || null,
    voteCounts,
    chat: lobby.chat,
    result: lobby.result,
  };
}

function pugRowToLobby(row) {
  return {
    id: row.id, mode: row.mode, map: row.map, weapon: row.weapon, host: row.host, code: row.code,
    teamA: row.team_a, teamB: row.team_b, votes: row.votes, chat: row.chat, result: row.result,
  };
}

// ── Pugs: unified queue/lobby operations ──────────────────────────
// Each of these branches on `pool`: with Postgres configured, queue/lobby
// state is a shared DB row so it's consistent across every Vercel serverless
// instance; without it (local dev), it falls back to the original in-memory
// objects, which is safe there because local dev is always a single process.

async function pugQueueCounts() {
  if (pool) {
    const r = await pool.query('SELECT mode, COUNT(*)::int AS n FROM pug_queue GROUP BY mode');
    const counts = { casual: 0, competitive: 0 };
    r.rows.forEach(row => { counts[row.mode] = row.n; });
    return counts;
  }
  return { casual: pugQueues.casual.length, competitive: pugQueues.competitive.length };
}

async function pugGamesLiveCounts() {
  if (pool) {
    const r = await pool.query('SELECT mode, COUNT(*)::int AS n FROM pug_lobbies WHERE result IS NULL GROUP BY mode');
    const counts = { casual: 0, competitive: 0 };
    r.rows.forEach(row => { counts[row.mode] = row.n; });
    return counts;
  }
  const counts = { casual: 0, competitive: 0 };
  Object.values(pugLobbies).forEach(l => { if (!l.result) counts[l.mode]++; });
  return counts;
}

async function pugUserQueueMode(userId) {
  if (pool) {
    const r = await pool.query('SELECT mode FROM pug_queue WHERE user_id=$1', [userId]);
    return r.rows[0] ? r.rows[0].mode : null;
  }
  if (pugQueues.casual.some(p => p.userId === userId)) return 'casual';
  if (pugQueues.competitive.some(p => p.userId === userId)) return 'competitive';
  return null;
}

async function pugFindUserLobby(userId) {
  if (pool) {
    const r = await pool.query(
      `SELECT l.* FROM pug_lobbies l JOIN pug_user_lobby ul ON ul.lobby_id = l.id WHERE ul.user_id = $1`,
      [userId]);
    return r.rows[0] ? pugRowToLobby(r.rows[0]) : null;
  }
  const lobbyId = userLobbyId[userId];
  return (lobbyId && pugLobbies[lobbyId]) || null;
}

async function pugJoinQueue(mode, player) {
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize all join attempts for this mode so two players can't both
      // read "5 in queue" and both think they're the one completing the 6th.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [mode]);
      const inLobby = await client.query('SELECT 1 FROM pug_user_lobby WHERE user_id=$1', [player.userId]);
      if (inLobby.rows[0]) { await client.query('ROLLBACK'); return { error: 'You are already in a lobby.' }; }
      const inQueue = await client.query('SELECT 1 FROM pug_queue WHERE user_id=$1', [player.userId]);
      if (inQueue.rows[0]) { await client.query('ROLLBACK'); return { error: 'You are already in a queue.' }; }
      await client.query(
        'INSERT INTO pug_queue (user_id, mode, display_name, avatar) VALUES ($1,$2,$3,$4)',
        [player.userId, mode, player.displayName, player.avatar]);
      const queued = await client.query(
        'SELECT user_id, display_name, avatar FROM pug_queue WHERE mode=$1 ORDER BY joined_at ASC LIMIT 6',
        [mode]);
      let lobby = null;
      if (queued.rows.length >= 6) {
        const players = queued.rows.map(r => ({ userId: r.user_id, displayName: r.display_name, avatar: r.avatar }));
        await client.query('DELETE FROM pug_queue WHERE user_id = ANY($1::text[])', [players.map(p => p.userId)]);
        lobby = await buildPugLobby(mode, players);
        await client.query(
          `INSERT INTO pug_lobbies (id, mode, map, weapon, host, code, team_a, team_b, votes, chat, result)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [lobby.id, lobby.mode, lobby.map, lobby.weapon, lobby.host, lobby.code,
           JSON.stringify(lobby.teamA), JSON.stringify(lobby.teamB), JSON.stringify(lobby.votes), JSON.stringify(lobby.chat), lobby.result]);
        for (const p of players) {
          await client.query('INSERT INTO pug_user_lobby (user_id, lobby_id) VALUES ($1,$2)', [p.userId, lobby.id]);
        }
      }
      await client.query('COMMIT');
      return { lobby };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  if (userLobbyId[player.userId]) return { error: 'You are already in a lobby.' };
  if (pugQueues.casual.some(p => p.userId === player.userId) || pugQueues.competitive.some(p => p.userId === player.userId)) {
    return { error: 'You are already in a queue.' };
  }
  pugQueues[mode].push(player);
  let lobby = null;
  if (pugQueues[mode].length >= 6) {
    const players = pugQueues[mode].splice(0, 6);
    lobby = await buildPugLobby(mode, players);
    pugLobbies[lobby.id] = lobby;
    [...lobby.teamA, ...lobby.teamB].forEach(p => { userLobbyId[p.userId] = lobby.id; });
  }
  return { lobby };
}

async function pugLeaveQueue(userId) {
  if (pool) { await pool.query('DELETE FROM pug_queue WHERE user_id=$1', [userId]); return; }
  removeFromPugQueues(userId);
}

async function pugSetLobbyCode(userId, code) {
  const lobby = await pugFindUserLobby(userId);
  if (!lobby) return { error: 'No active lobby.', status: 404 };
  if (lobby.host !== userId) return { error: 'Only the host can set the lobby code.', status: 403 };
  lobby.code = code;
  if (pool) await pool.query('UPDATE pug_lobbies SET code=$1 WHERE id=$2', [code, lobby.id]);
  return { lobby };
}

async function pugSendChat(userId, text, fallbackDisplayName) {
  const lobby = await pugFindUserLobby(userId);
  if (!lobby) return { error: 'No active lobby.', status: 404 };
  const me = [...lobby.teamA, ...lobby.teamB].find(p => p.userId === userId);
  lobby.chat.push({ userId, displayName: (me && me.displayName) || fallbackDisplayName, text, ts: Date.now() });
  if (lobby.chat.length > 100) lobby.chat = lobby.chat.slice(-100);
  if (pool) await pool.query('UPDATE pug_lobbies SET chat=$1 WHERE id=$2', [JSON.stringify(lobby.chat), lobby.id]);
  return { lobby };
}

async function pugVote(userId, team) {
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Lock this lobby row for the duration of the read-modify-write so two
      // concurrent votes can't clobber each other or double-finalize a result.
      const r = await client.query(
        `SELECT l.* FROM pug_lobbies l JOIN pug_user_lobby ul ON ul.lobby_id = l.id WHERE ul.user_id = $1 FOR UPDATE OF l`,
        [userId]);
      if (!r.rows[0]) { await client.query('ROLLBACK'); return { error: 'No active lobby.', status: 404 }; }
      const lobby = pugRowToLobby(r.rows[0]);
      let justResolved = false;
      if (!lobby.result) {
        lobby.votes[userId] = team;
        const counts = { teamA: 0, teamB: 0 };
        Object.values(lobby.votes).forEach(v => { counts[v]++; });
        if (counts.teamA >= 4) { lobby.result = 'teamA'; justResolved = true; }
        else if (counts.teamB >= 4) { lobby.result = 'teamB'; justResolved = true; }
        await client.query('UPDATE pug_lobbies SET votes=$1, result=$2 WHERE id=$3', [JSON.stringify(lobby.votes), lobby.result, lobby.id]);
      }
      await client.query('COMMIT');
      if (justResolved) {
        const winners = lobby.result === 'teamA' ? lobby.teamA : lobby.teamB;
        for (const p of winners) await (lobby.mode === 'competitive' ? addRankedWin(p.userId) : addCasualWin(p.userId));
      }
      return { lobby };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  const lobby = await pugFindUserLobby(userId);
  if (!lobby) return { error: 'No active lobby.', status: 404 };
  if (!lobby.result) {
    lobby.votes[userId] = team;
    const counts = { teamA: 0, teamB: 0 };
    Object.values(lobby.votes).forEach(v => { counts[v]++; });
    if (counts.teamA >= 4) lobby.result = 'teamA';
    else if (counts.teamB >= 4) lobby.result = 'teamB';
    if (lobby.result) {
      const winners = lobby.result === 'teamA' ? lobby.teamA : lobby.teamB;
      for (const p of winners) await (lobby.mode === 'competitive' ? addRankedWin(p.userId) : addCasualWin(p.userId));
    }
  }
  return { lobby };
}

async function pugLeaveLobby(userId) {
  if (pool) {
    const r = await pool.query('DELETE FROM pug_user_lobby WHERE user_id=$1 RETURNING lobby_id', [userId]);
    const lobbyId = r.rows[0] && r.rows[0].lobby_id;
    if (lobbyId) {
      const remaining = await pool.query('SELECT COUNT(*)::int AS n FROM pug_user_lobby WHERE lobby_id=$1', [lobbyId]);
      if (remaining.rows[0].n === 0) await pool.query('DELETE FROM pug_lobbies WHERE id=$1', [lobbyId]);
    }
    return;
  }
  const lobbyId = userLobbyId[userId];
  delete userLobbyId[userId];
  if (lobbyId) {
    const lobby = pugLobbies[lobbyId];
    const stillIn = lobby && [...lobby.teamA, ...lobby.teamB].some(p => userLobbyId[p.userId] === lobbyId);
    if (!stillIn) delete pugLobbies[lobbyId];
  }
}

function removeFromPugQueues(userId) {
  pugQueues.casual      = pugQueues.casual.filter(p => p.userId !== userId);
  pugQueues.competitive = pugQueues.competitive.filter(p => p.userId !== userId);
}

// ── MIME types ───────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.mov': 'video/quicktime', '.mp4': 'video/mp4',
};

// ── Sessions & OAuth state ────────────────────────────────────────
// Stateless: sessions and OAuth CSRF state are carried in signed/short-lived
// cookies rather than server memory, since Vercel serverless functions don't
// share memory across invocations (a different instance can handle the
// callback than the one that started the OAuth flow, or the next request).
const adminSessions = new Set();
const ADMIN_HASH = crypto.createHash('sha256').update('Boolin2026').digest('hex');

const SESSION_SECRET = crypto.createHash('sha256').update(`bl-session:${CLIENT_SECRET || 'insecure-dev-secret'}`).digest();

function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySession(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  const sigBuf = Buffer.from(sig), expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  try { return JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { return null; }
}

// ── HTTP Server ──────────────────────────────────────────────────
const handler = async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const cookies  = parseCookies(req.headers['cookie']);
  const sid      = cookies['bl_session'];
  const user     = verifySession(sid);

  // Discord OAuth start
  if (pathname === '/auth/discord') {
    if (!CLIENT_ID) { res.writeHead(500); res.end('Discord credentials not configured.'); return; }
    const state = randomToken();
    const isSecure = REDIRECT_URI.startsWith('https');
    res.writeHead(302, {
      Location: `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify&state=${state}`,
      'Set-Cookie': `bl_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${isSecure ? '; Secure' : ''}`,
    });
    res.end(); return;
  }

  // Discord OAuth callback
  if (pathname === '/auth/discord/callback') {
    const { code, state, error } = parsed.query;
    const isSecure = REDIRECT_URI.startsWith('https');
    const clearStateCookie = `bl_oauth_state=; Path=/; Max-Age=0`;
    if (error || !code || !state || state !== cookies['bl_oauth_state']) {
      res.writeHead(302, { Location: '/?auth=failed', 'Set-Cookie': clearStateCookie }); res.end(); return;
    }
    try {
      const tokenData = await discordPost('/api/oauth2/token', {
        client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
      });
      if (!tokenData.access_token) throw new Error('No access token');
      const du = await discordGet('/api/users/@me', tokenData.access_token);
      if (!du.id || !du.username) throw new Error('Discord user response missing id/username');
      await dbSaveUser({ id: du.id, username: du.username, display_name: du.global_name || du.username, avatar: du.avatar });
      const sessionToken = signSession({ userId: du.id, username: du.username, displayName: du.global_name || du.username, avatar: du.avatar });
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': [
          `bl_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${isSecure ? '; Secure' : ''}`,
          clearStateCookie,
        ],
      });
      res.end();
    } catch (e) {
      console.error('OAuth error:', e.message);
      res.writeHead(302, { Location: '/?auth=failed', 'Set-Cookie': clearStateCookie }); res.end();
    }
    return;
  }

  // Logout
  if (pathname === '/auth/logout') {
    res.writeHead(302, { Location: '/', 'Set-Cookie': 'bl_session=; Path=/; Max-Age=0' });
    res.end(); return;
  }

  // Current user
  if (pathname === '/auth/me') {
    if (!user) { json(res, 200, null); return; }
    json(res, 200, { ...user });
    return;
  }

  // ── Profile: stats + Embark ID ────────────────────────────────────────────────
  if (pathname === '/api/profile') {
    if (!user) { json(res, 401, { error: 'Not logged in' }); return; }
    const [casualWins, rankedWins, embarkId] = await Promise.all([
      getCasualWins(user.userId),
      getRankedWins(user.userId),
      getEmbarkId(user.userId),
    ]);
    json(res, 200, { ...user, casualWins, rankedWins, embarkId });
    return;
  }

  if (pathname === '/api/profile/embark-id' && req.method === 'POST') {
    if (!user) { json(res, 401, { error: 'Not logged in' }); return; }
    const body = await readBody(req);
    const embarkId = (body.embarkId || '').trim().slice(0, 40);
    await setEmbarkId(user.userId, embarkId || null);
    json(res, 200, { ok: true, embarkId: embarkId || null });
    return;
  }

  // ── Team: get mine ────────────────────────────────────────────
  if (pathname === '/api/teams/mine') {
    if (!user) { json(res, 401, { error: 'Not logged in' }); return; }
    const team = await dbGetTeamByUser(user.userId);
    if (!team) { json(res, 200, { team: null }); return; }
    const members = await dbGetTeamMembers(team.id);
    const tournamentEntry = await dbGetTeamEntry('season1', team.id);
    const isCaptain = team.captainId === user.userId;
    json(res, 200, {
      team: { ...team, inviteCode: isCaptain ? team.inviteCode : null },
      members,
      role: isCaptain ? 'captain' : 'member',
      tournamentEntry: tournamentEntry || null,
    });
    return;
  }

  // ── Team: create ─────────────────────────────────────────────
  if (pathname === '/api/teams/create' && req.method === 'POST') {
    if (!user) { json(res, 401, { error: 'Not logged in' }); return; }
    const body = await readBody(req);
    const name = (body.name || '').trim();
    if (!name) { json(res, 400, { error: 'Team name is required.' }); return; }
    if (name.length > 32) { json(res, 400, { error: 'Team name too long (max 32 chars).' }); return; }
    const existing = await dbGetTeamByUser(user.userId);
    if (existing) { json(res, 409, { error: 'You are already in a team. Leave your current team first.' }); return; }
    const team = { id: generateId(), name, captainId: user.userId, inviteCode: generateCode(), createdAt: new Date().toISOString() };
    try {
      await dbCreateTeam(team);
      const members = await dbGetTeamMembers(team.id);
      json(res, 200, { success: true, team, members, role: 'captain', tournamentEntry: null });
    } catch (e) {
      if (e.message.includes('UNIQUE') || e.message.includes('unique'))
        json(res, 409, { error: 'A team with that name already exists.' });
      else
        json(res, 500, { error: 'Failed to create team.' });
    }
    return;
  }

  // ── Team: join by invite code ─────────────────────────────────
  if (pathname === '/api/teams/join' && req.method === 'POST') {
    if (!user) { json(res, 401, { error: 'Not logged in' }); return; }
    const body = await readBody(req);
    const code = (body.code || '').trim().toUpperCase();
    if (!code) { json(res, 400, { error: 'Invite code is required.' }); return; }
    const existing = await dbGetTeamByUser(user.userId);
    if (existing) { json(res, 409, { error: 'You are already in a team.' }); return; }
    const team = await dbGetTeamByInviteCode(code);
    if (!team) { json(res, 404, { error: 'Invalid invite code.' }); return; }
    await dbJoinTeam(team.id, user.userId);
    const members = await dbGetTeamMembers(team.id);
    const tournamentEntry = await dbGetTeamEntry('season1', team.id);
    json(res, 200, { success: true, team: { ...team, inviteCode: null }, members, role: 'member', tournamentEntry: tournamentEntry || null });
    return;
  }

  // ── Team: leave ───────────────────────────────────────────────
  if (pathname === '/api/teams/leave' && req.method === 'POST') {
    if (!user) { json(res, 401, { error: 'Not logged in' }); return; }
    const team = await dbGetTeamByUser(user.userId);
    if (!team) { json(res, 404, { error: 'You are not in a team.' }); return; }
    if (team.captainId === user.userId) {
      const members = await dbGetTeamMembers(team.id);
      if (members.length > 1) {
        json(res, 409, { error: 'As captain, you cannot leave while other members are in the team. Remove them first or disband.' });
        return;
      }
    }
    await dbLeaveTeam(team.id, user.userId);
    json(res, 200, { success: true }); return;
  }

  // ── Tournament: register team for Season 1 ───────────────────
  if (pathname === '/api/tournaments/season1/register' && req.method === 'POST') {
    if (!user) { json(res, 401, { error: 'Not logged in' }); return; }
    const team = await dbGetTeamByUser(user.userId);
    if (!team) { json(res, 400, { error: 'You must be in a team to register.' }); return; }
    if (team.captainId !== user.userId) { json(res, 403, { error: 'Only the team captain can register for tournaments.' }); return; }
    const existing = await dbGetTeamEntry('season1', team.id);
    if (existing) { json(res, 200, { success: true }); return; }
    const count = await dbCountEntries('season1');
    if (count >= 8) { json(res, 409, { error: 'Season 1 is full (8/8 teams registered).' }); return; }
    await dbRegisterTeam('season1', team.id);
    json(res, 200, { success: true }); return;
  }

  // ── Tournament: unregister team from Season 1 ────────────────
  if (pathname === '/api/tournaments/season1/unregister' && req.method === 'POST') {
    if (!user) { json(res, 401, { error: 'Not logged in' }); return; }
    const team = await dbGetTeamByUser(user.userId);
    if (!team) { json(res, 400, { error: 'You are not in a team.' }); return; }
    if (team.captainId !== user.userId) { json(res, 403, { error: 'Only the team captain can unregister.' }); return; }
    if (pool) {
      await pool.query('DELETE FROM tournament_entries WHERE tournament=$1 AND team_id=$2', ['season1', team.id]);
    } else {
      const db = readDb();
      delete db.tournament_entries[`season1_${team.id}`];
      writeDb(db);
    }
    json(res, 200, { success: true }); return;
  }

  // ── Tournament: list registered teams ─────────────────────────
  if (pathname === '/api/tournaments/season1/teams') {
    const entries = await dbGetTournamentEntries('season1');
    const teams = await Promise.all(entries.map(async e => {
      const members = await dbGetTeamMembers(e.team_id);
      return { teamId: e.team_id, teamName: e.team_name, members };
    }));
    json(res, 200, { teams, total: teams.length, max: 8 }); return;
  }

  // ── Admin: login ────────────────────────────────────────────────────────────
  if (pathname === '/admin/login' && req.method === 'POST') {
    const body = await readBody(req);
    const hash = crypto.createHash('sha256').update(body.password || '').digest('hex');
    if (hash !== ADMIN_HASH) { json(res, 401, { ok: false, error: 'Wrong password.' }); return; }
    const token = randomToken();
    adminSessions.add(token);
    json(res, 200, { ok: true, token });
    return;
  }

  if (pathname === '/admin/logout' && req.method === 'POST') {
    const token = req.headers['x-admin-token'];
    if (token) adminSessions.delete(token);
    json(res, 200, { ok: true });
    return;
  }

  // ── Admin: matches ───────────────────────────────────────────────────────────
  if (pathname === '/api/admin/matches') {
    if (!adminSessions.has(req.headers['x-admin-token'])) { json(res, 401, { error: 'Unauthorized' }); return; }
    if (req.method === 'GET') {
      json(res, 200, readDb().matches);
      return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const { team1, team2, score1, score2, winner } = body;
      if (!team1 || !team2 || !winner) { json(res, 400, { error: 'Missing fields.' }); return; }
      if (winner !== team1 && winner !== team2) { json(res, 400, { error: 'Winner must be one of the two teams.' }); return; }
      const match = { id: generateId(), team1, team2, score1: score1 ?? null, score2: score2 ?? null, winner, date: new Date().toISOString() };
      const db = readDb(); db.matches.push(match); writeDb(db);
      json(res, 200, { ok: true, match });
      return;
    }
  }

  if (pathname.startsWith('/api/admin/matches/') && req.method === 'DELETE') {
    if (!adminSessions.has(req.headers['x-admin-token'])) { json(res, 401, { error: 'Unauthorized' }); return; }
    const matchId = pathname.split('/').pop();
    const db = readDb(); db.matches = db.matches.filter(m => m.id !== matchId); writeDb(db);
    json(res, 200, { ok: true });
    return;
  }

  // ── Live status (Twitch / YouTube) ────────────────────────────────────────────
  if (pathname === '/api/live-status') {
    const status = await getLiveStatus();
    json(res, 200, status);
    return;
  }

  // ── Public leaderboard ───────────────────────────────────────────────────────
  if (pathname === '/api/leaderboard') {
    json(res, 200, computeLeaderboard(readDb().matches));
    return;
  }

  // ── Public bracket ────────────────────────────────────────────────────────────
  if (pathname === '/api/bracket/s1') {
    json(res, 200, deriveBracket(readBracket()));
    return;
  }

  // ── Admin: bracket seeds ──────────────────────────────────────────────────────
  if (pathname === '/api/admin/bracket/s1/seeds' && req.method === 'POST') {
    if (!adminSessions.has(req.headers['x-admin-token'])) { json(res, 401, { error: 'Unauthorized' }); return; }
    const body = await readBody(req);
    const b = readBracket();
    ['qf1','qf2','qf3','qf4'].forEach(id => {
      if (body[id]) {
        b.seeds[id].team1 = body[id].team1 || null;
        b.seeds[id].team2 = body[id].team2 || null;
      }
    });
    writeBracket(b);
    json(res, 200, { ok: true, bracket: deriveBracket(b) });
    return;
  }

  // ── Admin: bracket result ─────────────────────────────────────────────────────
  if (pathname === '/api/admin/bracket/s1/result' && req.method === 'POST') {
    if (!adminSessions.has(req.headers['x-admin-token'])) { json(res, 401, { error: 'Unauthorized' }); return; }
    const body = await readBody(req);
    const { matchId, winner } = body;
    const valid = ['qf1','qf2','qf3','qf4','sf1','sf2','f1'];
    if (!valid.includes(matchId)) { json(res, 400, { error: 'Invalid match ID.' }); return; }
    const b = readBracket();
    b.results[matchId] = winner || null;
    // Clear downstream results when a result changes
    const downstream = { qf1:['sf1','f1'], qf2:['sf1','f1'], qf3:['sf2','f1'], qf4:['sf2','f1'], sf1:['f1'], sf2:['f1'] };
    (downstream[matchId] || []).forEach(id => { b.results[id] = null; });
    writeBracket(b);
    json(res, 200, { ok: true, bracket: deriveBracket(b) });
    return;
  }

  // ── Pugs: map pool ────────────────────────────────────────────────────────────
  if (pathname === '/api/pugs/maps') {
    json(res, 200, MAP_POOL);
    return;
  }

  // ── Pugs: win leaderboards (casual + ranked) ──────────────────────────────────
  if (pathname === '/api/pugs/leaderboard') {
    const [casual, ranked] = await Promise.all([
      getWinsLeaderboard('casual_wins', 20),
      getWinsLeaderboard('ranked_wins', 20),
    ]);
    json(res, 200, { casual, ranked });
    return;
  }

  // ── Pugs: status (poll target) ───────────────────────────────────────────────
  if (pathname === '/api/pugs/status') {
    const counts = await pugQueueCounts();
    const gamesLive = await pugGamesLiveCounts();
    let lobby = null, inQueue = null, rankedWins = null;
    if (user) {
      const found = await pugFindUserLobby(user.userId);
      if (found) lobby = serializePugLobby(found, user.userId);
      if (!lobby) inQueue = await pugUserQueueMode(user.userId);
      rankedWins = await getRankedWins(user.userId);
    }
    json(res, 200, { counts, gamesLive, inQueue, lobby, rankedWins });
    return;
  }

  // ── Pugs: join queue ──────────────────────────────────────────────────────────
  if (pathname === '/api/pugs/queue/join' && req.method === 'POST') {
    if (!user) { json(res, 401, { error: 'Log in with Discord to queue.' }); return; }
    const body = await readBody(req);
    const mode = body.mode === 'competitive' ? 'competitive' : 'casual';
    const result = await pugJoinQueue(mode, { userId: user.userId, displayName: user.displayName, avatar: user.avatar });
    if (result.error) { json(res, 409, { error: result.error }); return; }
    json(res, 200, { ok: true, lobby: result.lobby ? serializePugLobby(result.lobby, user.userId) : null });
    return;
  }

  // ── Pugs: leave queue ─────────────────────────────────────────────────────────
  if (pathname === '/api/pugs/queue/leave' && req.method === 'POST') {
    if (!user) { json(res, 401, { error: 'Not logged in' }); return; }
    await pugLeaveQueue(user.userId);
    json(res, 200, { ok: true });
    return;
  }

  // ── Pugs: host sets the lobby code ────────────────────────────────────────────
  if (pathname === '/api/pugs/lobby/code' && req.method === 'POST') {
    if (!user) { json(res, 401, { error: 'Not logged in' }); return; }
    const body = await readBody(req);
    const code = (body.code || '').trim().slice(0, 32).toUpperCase();
    if (!code) { json(res, 400, { error: 'Code is required.' }); return; }
    const result = await pugSetLobbyCode(user.userId, code);
    if (result.error) { json(res, result.status, { error: result.error }); return; }
    json(res, 200, { ok: true, lobby: serializePugLobby(result.lobby, user.userId) });
    return;
  }

  // ── Pugs: send a lobby chat message ───────────────────────────────────────────
  if (pathname === '/api/pugs/lobby/chat' && req.method === 'POST') {
    if (!user) { json(res, 401, { error: 'Not logged in' }); return; }
    const body = await readBody(req);
    const text = (body.text || '').trim().slice(0, 300);
    if (!text) { json(res, 400, { error: 'Message is empty.' }); return; }
    const result = await pugSendChat(user.userId, text, user.displayName);
    if (result.error) { json(res, result.status, { error: result.error }); return; }
    json(res, 200, { ok: true, lobby: serializePugLobby(result.lobby, user.userId) });
    return;
  }

  // ── Pugs: vote for the winning team (4 votes finalizes it) ───────────────────
  if (pathname === '/api/pugs/lobby/vote' && req.method === 'POST') {
    if (!user) { json(res, 401, { error: 'Not logged in' }); return; }
    const body = await readBody(req);
    if (body.team !== 'teamA' && body.team !== 'teamB') { json(res, 400, { error: 'Invalid team.' }); return; }
    const result = await pugVote(user.userId, body.team);
    if (result.error) { json(res, result.status, { error: result.error }); return; }
    json(res, 200, { ok: true, lobby: serializePugLobby(result.lobby, user.userId) });
    return;
  }

  // ── Pugs: leave the lobby / return to the mode select screen ─────────────────
  if (pathname === '/api/pugs/lobby/leave' && req.method === 'POST') {
    if (!user) { json(res, 401, { error: 'Not logged in' }); return; }
    await pugLeaveLobby(user.userId);
    json(res, 200, { ok: true });
    return;
  }

  // ── Static files ──────────────────────────────────────────────
  const BLOCKED = new Set(['config.json','db.json','.gitignore','package.json','package-lock.json','server.js']);
  // Clean-URL routing: extensionless paths map to a same-named .html file
  // (e.g. /schedule -> schedule.html), with a few special cases below.
  let safePath;
  if (pathname === '/') safePath = '/index.html';
  else if (pathname === '/admin') safePath = '/admin.html';
  else if (pathname === '/league') safePath = '/league.html';
  else if (pathname.startsWith('/shop/') && pathname !== '/shop/') safePath = '/shop-product.html';
  else if (path.extname(pathname)) safePath = pathname;
  else safePath = pathname + '.html';
  const filePath = path.join(BASE, safePath);
  if (!filePath.startsWith(BASE)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (BLOCKED.has(path.basename(filePath))) { res.writeHead(404); res.end('Not found'); return; }
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
};

if (!process.env.VERCEL) {
  http.createServer(handler).listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
}

module.exports = handler;
