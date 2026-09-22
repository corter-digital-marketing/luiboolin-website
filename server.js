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
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT, display_name TEXT, avatar TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS ranked_wins INTEGER DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS casual_wins INTEGER DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS embark_id TEXT;
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
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject); req.write(encoded); req.end();
  });
}

function discordGet(p, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'discord.com', path: p,
      headers: { Authorization: `Bearer ${token}` },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
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
    await pool.query('UPDATE users SET ranked_wins = COALESCE(ranked_wins,0) + 1 WHERE id=$1', [userId]);
    return;
  }
  const db = readDb();
  if (!db.users[userId]) db.users[userId] = {};
  db.users[userId].rankedWins = (db.users[userId].rankedWins || 0) + 1;
  writeDb(db);
}

async function addCasualWin(userId) {
  if (pool) {
    await pool.query('UPDATE users SET casual_wins = COALESCE(casual_wins,0) + 1 WHERE id=$1', [userId]);
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
    await pool.query('UPDATE users SET embark_id=$1 WHERE id=$2', [embarkId || null, userId]);
    return;
  }
  const db = readDb();
  if (!db.users[userId]) db.users[userId] = {};
  db.users[userId].embarkId = embarkId || null;
  writeDb(db);
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
      `SELECT id, display_name, avatar, ${column} AS wins FROM users WHERE ${column} > 0 ORDER BY ${column} DESC, updated_at ASC LIMIT $1`,
      [limit]);
    return r.rows.map(row => ({ userId: row.id, displayName: row.display_name, avatar: row.avatar, wins: row.wins }));
  }
  const db = readDb();
  const field = column === 'ranked_wins' ? 'rankedWins' : 'casualWins';
  return Object.entries(db.users)
    .map(([id, u]) => ({ userId: id, displayName: u.displayName || u.display_name || id, avatar: u.avatar, wins: u[field] || 0 }))
    .filter(u => u.wins > 0)
    .sort((a, b) => b.wins - a.wins)
    .slice(0, limit);
}

async function makePugLobby(mode, players) {
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
    if (embarkId) p.displayName = embarkId;
  }

  const winsGetter = mode === 'competitive' ? getRankedWins : getCasualWins;
  const winCounts = await Promise.all(allPlayers.map(p => winsGetter(p.userId)));
  if (mode === 'competitive') {
    allPlayers.forEach((p, i) => { p.rankedWins = winCounts[i]; });
  }
  let hostIdx = 0;
  for (let i = 1; i < allPlayers.length; i++) if (winCounts[i] > winCounts[hostIdx]) hostIdx = i;
  const host = allPlayers[hostIdx].userId;

  const lobby = {
    id, mode, map, weapon, host,
    code: null,
    teamA, teamB,
    votes: {},   // userId -> 'teamA' | 'teamB'
    chat: [],    // [{ userId, displayName, text, ts }]
    result: null,
    createdAt: Date.now(),
  };
  pugLobbies[id] = lobby;
  [...teamA, ...teamB].forEach(p => { userLobbyId[p.userId] = id; });
  return lobby;
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
    const counts    = { casual: pugQueues.casual.length, competitive: pugQueues.competitive.length };
    const gamesLive = { casual: 0, competitive: 0 };
    Object.values(pugLobbies).forEach(l => { if (!l.result) gamesLive[l.mode]++; });
    let lobby = null, inQueue = null, rankedWins = null;
    if (user) {
      const lobbyId = userLobbyId[user.userId];
      if (lobbyId && pugLobbies[lobbyId]) lobby = serializePugLobby(pugLobbies[lobbyId], user.userId);
      if (!lobby) {
        if (pugQueues.casual.some(p => p.userId === user.userId)) inQueue = 'casual';
        else if (pugQueues.competitive.some(p => p.userId === user.userId)) inQueue = 'competitive';
      }
      rankedWins = await getRankedWins(user.userId);
    }
    json(res, 200, { counts, gamesLive, inQueue, lobby, rankedWins });
    return;
  }

  // ── Pugs: join queue ──────────────────────────────────────────────────────────
  if (pathname === '/api/pugs/queue/join' && req.method === 'POST') {
    if (!user) { json(res, 401, { error: 'Log in with Discord to queue.' }); return; }
    if (userLobbyId[user.userId]) { json(res, 409, { error: 'You are already in a lobby.' }); return; }
    const body = await readBody(req);
    const mode = body.mode === 'competitive' ? 'competitive' : 'casual';
    if (pugQueues.casual.some(p => p.userId === user.userId) || pugQueues.competitive.some(p => p.userId === user.userId)) {
      json(res, 409, { error: 'You are already in a queue.' }); return;
    }
    pugQueues[mode].push({ userId: user.userId, displayName: user.displayName, avatar: user.avatar });
    let lobby = null;
    if (pugQueues[mode].length >= 6) {
      const players = pugQueues[mode].splice(0, 6);
      lobby = await makePugLobby(mode, players);
    }
    json(res, 200, { ok: true, lobby: lobby ? serializePugLobby(lobby, user.userId) : null });
    return;
  }

  // ── Pugs: leave queue ─────────────────────────────────────────────────────────
  if (pathname === '/api/pugs/queue/leave' && req.method === 'POST') {
    if (!user) { json(res, 401, { error: 'Not logged in' }); return; }
    removeFromPugQueues(user.userId);
    json(res, 200, { ok: true });
    return;
  }

  // ── Pugs: host sets the lobby code ────────────────────────────────────────────
  if (pathname === '/api/pugs/lobby/code' && req.method === 'POST') {
    if (!user) { json(res, 401, { error: 'Not logged in' }); return; }
    const lobby = pugLobbies[userLobbyId[user.userId]];
    if (!lobby) { json(res, 404, { error: 'No active lobby.' }); return; }
    if (lobby.host !== user.userId) { json(res, 403, { error: 'Only the host can set the lobby code.' }); return; }
    const body = await readBody(req);
    const code = (body.code || '').trim().slice(0, 32);
    if (!code) { json(res, 400, { error: 'Code is required.' }); return; }
    lobby.code = code;
    json(res, 200, { ok: true, lobby: serializePugLobby(lobby, user.userId) });
    return;
  }

  // ── Pugs: send a lobby chat message ───────────────────────────────────────────
  if (pathname === '/api/pugs/lobby/chat' && req.method === 'POST') {
    if (!user) { json(res, 401, { error: 'Not logged in' }); return; }
    const lobby = pugLobbies[userLobbyId[user.userId]];
    if (!lobby) { json(res, 404, { error: 'No active lobby.' }); return; }
    const body = await readBody(req);
    const text = (body.text || '').trim().slice(0, 300);
    if (!text) { json(res, 400, { error: 'Message is empty.' }); return; }
    const me = [...lobby.teamA, ...lobby.teamB].find(p => p.userId === user.userId);
    lobby.chat.push({ userId: user.userId, displayName: (me && me.displayName) || user.displayName, text, ts: Date.now() });
    if (lobby.chat.length > 100) lobby.chat = lobby.chat.slice(-100);
    json(res, 200, { ok: true, lobby: serializePugLobby(lobby, user.userId) });
    return;
  }

  // ── Pugs: vote for the winning team (4 votes finalizes it) ───────────────────
  if (pathname === '/api/pugs/lobby/vote' && req.method === 'POST') {
    if (!user) { json(res, 401, { error: 'Not logged in' }); return; }
    const lobby = pugLobbies[userLobbyId[user.userId]];
    if (!lobby) { json(res, 404, { error: 'No active lobby.' }); return; }
    if (!lobby.result) {
      const body = await readBody(req);
      if (body.team !== 'teamA' && body.team !== 'teamB') { json(res, 400, { error: 'Invalid team.' }); return; }
      lobby.votes[user.userId] = body.team;
      const counts = { teamA: 0, teamB: 0 };
      Object.values(lobby.votes).forEach(v => { counts[v]++; });
      if (counts.teamA >= 4) lobby.result = 'teamA';
      else if (counts.teamB >= 4) lobby.result = 'teamB';
      if (lobby.result) {
        const winners = lobby.result === 'teamA' ? lobby.teamA : lobby.teamB;
        for (const p of winners) await (lobby.mode === 'competitive' ? addRankedWin(p.userId) : addCasualWin(p.userId));
      }
    }
    json(res, 200, { ok: true, lobby: serializePugLobby(lobby, user.userId) });
    return;
  }

  // ── Pugs: leave the lobby / return to the mode select screen ─────────────────
  if (pathname === '/api/pugs/lobby/leave' && req.method === 'POST') {
    if (!user) { json(res, 401, { error: 'Not logged in' }); return; }
    const lobbyId = userLobbyId[user.userId];
    delete userLobbyId[user.userId];
    if (lobbyId) {
      const lobby = pugLobbies[lobbyId];
      const stillIn = lobby && [...lobby.teamA, ...lobby.teamB].some(p => userLobbyId[p.userId] === lobbyId);
      if (!stillIn) delete pugLobbies[lobbyId];
    }
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
