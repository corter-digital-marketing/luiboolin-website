// ══════════════════════════════════════
// BOOLIN PUGS — 3v3 matchmaking (queue → lobby → confirm winner)
// ══════════════════════════════════════

const PUGS_POLL_MS = 3000;
let pugsBusy = false;
let pugsUser = null;

const PUGS_MAP_IMAGES = {
  'Fangwai City':      '/map-photos/FangwaiCity.png',
  'NOZOMI/CITADEL':    '/map-photos/NOZOMICITADEL.png',
  'Las Vegas Stadium': '/map-photos/LasvegasStadium.jpg',
  'Bernal':            '/map-photos/Bernal_Map.png',
  'Fortune Stadium':   '/map-photos/Fortune_Stadium_Map.png',
  'Kyoto':             '/map-photos/Kyoto_Map.png',
  'SYS$HORIZON':       '/map-photos/SYS$HORIZON_Map.png',
  'Skyway Stadium':    '/map-photos/Skyway_Stadium_Map.png',
  'Seoul':             '/map-photos/Seoul_Map.png',
  'Monoco':            '/map-photos/Monaco_Map.png',
};

const PUGS_RANK_TIERS = [
  { wins: 30, name: 'BOOLIN' },
  { wins: 15, name: 'Beamer' },
  { wins: 10, name: 'Gamer' },
  { wins: 5,  name: 'Pup' },
  { wins: 1,  name: 'Trainee' },
];
function pugsRankName(wins) {
  for (const t of PUGS_RANK_TIERS) if (wins >= t.wins) return t.name;
  return 'Unranked';
}

async function pugsLoadUser() {
  try {
    const res = await fetch('/auth/me');
    pugsUser = await res.json();
  } catch (_) {
    pugsUser = null;
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function pugsAvatarUrl(p) {
  if (p.avatar) return `https://cdn.discordapp.com/avatars/${p.userId}/${p.avatar}.png?size=64`;
  return `https://cdn.discordapp.com/embed/avatars/${parseInt(p.userId, 10) % 5 || 0}.png`;
}

async function pugsApi(path, opts) {
  const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
  let body = null;
  try { body = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error((body && body.error) || 'Something went wrong.');
  return body;
}

function pugsSetButtonState(mode, state, extra) {
  const btn = document.getElementById(`${mode}-queue-btn`);
  if (!btn) return;
  btn.classList.remove('pugs-btn-cancel', 'pugs-btn-queued');
  btn.disabled = false;
  if (state === 'login') {
    btn.textContent = 'Login to Queue';
    btn.onclick = () => { window.location.href = '/auth/discord'; };
  } else if (state === 'queue') {
    btn.textContent = 'Queue';
    btn.onclick = () => pugsQueueClick(mode);
  } else if (state === 'searching') {
    btn.textContent = `Searching… (${extra}/6) — Cancel`;
    btn.classList.add('pugs-btn-queued');
    btn.onclick = () => pugsLeaveQueue();
  } else if (state === 'busy') {
    btn.textContent = 'Queued Elsewhere';
    btn.disabled = true;
  }
}

async function pugsQueueClick(mode) {
  if (pugsBusy) return;
  pugsBusy = true;
  try {
    const result = await pugsApi('/api/pugs/queue/join', { method: 'POST', body: JSON.stringify({ mode }) });
    if (result.lobby) pugsRenderLobby(result.lobby);
    else await pugsRefresh();
  } catch (e) {
    alert(e.message);
  } finally {
    pugsBusy = false;
  }
}

async function pugsLeaveQueue() {
  if (pugsBusy) return;
  pugsBusy = true;
  try {
    await pugsApi('/api/pugs/queue/leave', { method: 'POST' });
    await pugsRefresh();
  } catch (e) {
    alert(e.message);
  } finally {
    pugsBusy = false;
  }
}

async function pugsSetCode() {
  const input = document.getElementById('pugs-code-input');
  if (!input) return;
  const code = input.value.trim().toUpperCase();
  if (!code) return;
  try {
    const result = await pugsApi('/api/pugs/lobby/code', { method: 'POST', body: JSON.stringify({ code }) });
    pugsRenderLobby(result.lobby);
  } catch (e) {
    alert(e.message);
  }
}

async function pugsBanMap(map) {
  try {
    const result = await pugsApi('/api/pugs/lobby/ban-map', { method: 'POST', body: JSON.stringify({ map }) });
    pugsRenderLobby(result.lobby);
  } catch (e) {
    alert(e.message);
  }
}

async function pugsVote(team) {
  try {
    const result = await pugsApi('/api/pugs/lobby/vote', { method: 'POST', body: JSON.stringify({ team }) });
    pugsRenderLobby(result.lobby);
  } catch (e) {
    alert(e.message);
  }
}

async function pugsSendChat() {
  const input = document.getElementById('pugs-chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    const result = await pugsApi('/api/pugs/lobby/chat', { method: 'POST', body: JSON.stringify({ text }) });
    pugsRenderLobby(result.lobby);
  } catch (e) {
    alert(e.message);
  }
}

async function pugsBackToQueue() {
  pugsStopMapBanTimer();
  try {
    await pugsApi('/api/pugs/lobby/leave', { method: 'POST' });
  } catch (_) {}
  document.getElementById('pugs-lobby-view').style.display = 'none';
  document.getElementById('pugs-queue-view').style.display = 'flex';
  await pugsRefresh();
}

function pugsPlayerRow(p, showWins, hostId) {
  const you = pugsUser && p.userId === pugsUser.userId;
  return `
    <div class="pugs-player-row">
      <img src="${pugsAvatarUrl(p)}" alt="" />
      <span class="pugs-player-name">${escapeHtml(p.displayName)}${you ? ' (You)' : ''}</span>
      ${showWins && typeof p.rankedWins === 'number' ? `<span class="pugs-player-rank-badge">${p.rankedWins}</span>` : ''}
      ${p.userId === hostId ? '<span class="pugs-crown" title="Lobby Maker">👑</span>' : ''}
    </div>`;
}

function pugsMapCardHtml(mapName) {
  const img = PUGS_MAP_IMAGES[mapName];
  return `
    <div class="pugs-map-card">
      <div class="pugs-map-card-label">Map:</div>
      ${img ? `<img src="${img}" alt="${escapeHtml(mapName)}" class="pugs-map-card-photo" />` : ''}
      <div class="pugs-map-card-name">${escapeHtml(mapName)}</div>
    </div>`;
}

function pugsMapBanHtml(lobby) {
  const turn = lobby.mapBanTurn;
  const turnLabel = turn === 'teamA' ? 'Team A' : 'Team B';
  const isMyTurn = lobby.myTeam === turn;
  const bannedMaps = [lobby.mapBans.teamA, lobby.mapBans.teamB].filter(Boolean);
  const tally = lobby.mapBanTally || {};

  const cards = lobby.mapCandidates.map(m => {
    const banned = bannedMaps.includes(m);
    const img = PUGS_MAP_IMAGES[m];
    const clickable = isMyTurn && !banned;
    const voted = lobby.myMapBanVote === m;
    const count = tally[m];
    return `
      <div class="pugs-mapban-card ${banned ? 'banned' : ''} ${clickable ? 'clickable' : ''} ${voted ? 'voted' : ''}"
           ${clickable ? `onclick="pugsBanMap('${m.replace(/'/g, "\\'")}')"` : ''}>
        ${img ? `<img src="${img}" alt="${escapeHtml(m)}" class="pugs-mapban-photo" />` : ''}
        <div class="pugs-mapban-name">${escapeHtml(m)}</div>
        ${banned ? '<div class="pugs-mapban-tag">BANNED</div>' : (typeof count === 'number' ? `<div class="pugs-mapban-votes">${count}/3 votes</div>` : '')}
      </div>`;
  }).join('');

  return `
    <div class="pugs-map-card pugs-mapban">
      <div class="pugs-map-card-label">Map Ban — ${isMyTurn ? 'Your Team is Voting' : `Waiting on ${turnLabel}`}</div>
      ${lobby.mapBanDeadline ? `<div class="pugs-mapban-timer">You have <span id="pugs-mapban-countdown">30</span> seconds to vote</div>` : ''}
      <div class="pugs-mapban-grid">${cards}</div>
      <p class="pugs-note" style="margin-top:0.75rem;margin-bottom:0;">${isMyTurn ? "Vote for the map your team should ban — majority decides, ties are broken randomly." : `Waiting for ${turnLabel} to finish voting on their ban.`}</p>
    </div>`;
}

let pugsMapBanTimer = null;

function pugsStopMapBanTimer() {
  if (pugsMapBanTimer) { clearInterval(pugsMapBanTimer); pugsMapBanTimer = null; }
}

function pugsStartMapBanTimer(deadline) {
  pugsStopMapBanTimer();
  if (!deadline) return;
  const tick = () => {
    const node = document.getElementById('pugs-mapban-countdown');
    if (!node) { pugsStopMapBanTimer(); return; }
    node.textContent = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  };
  tick();
  pugsMapBanTimer = setInterval(tick, 1000);
}

function pugsChatHtml(lobby) {
  const messages = (lobby.chat && lobby.chat.length)
    ? lobby.chat.map(m => `<div class="pugs-chat-msg"><b>${escapeHtml(m.displayName)}:</b> ${escapeHtml(m.text)}</div>`).join('')
    : '<div class="pugs-chat-empty">No messages yet.</div>';
  return `
    <div class="pugs-chat">
      <div class="pugs-chat-messages" id="pugs-chat-messages">${messages}</div>
      <div class="pugs-chat-input-row">
        <input type="text" id="pugs-chat-input" class="pugs-chat-input" placeholder="Message the lobby…" maxlength="300" />
        <button type="button" class="pugs-queue-btn pugs-btn-sm" onclick="pugsSendChat()">Send</button>
      </div>
    </div>`;
}

function pugsRenderLobby(lobby) {
  document.getElementById('pugs-queue-view').style.display = 'none';
  const view = document.getElementById('pugs-lobby-view');
  view.style.display = 'block';

  // Preserve anything the player was mid-typing / scroll position across the 3s poll re-render.
  const prevChatInput = document.getElementById('pugs-chat-input');
  const prevCodeInput = document.getElementById('pugs-code-input');
  const chatDraft = prevChatInput ? prevChatInput.value : '';
  const codeDraft = prevCodeInput ? prevCodeInput.value : '';
  const chatWasFocused = document.activeElement === prevChatInput;
  const codeWasFocused = document.activeElement === prevCodeInput;
  const prevChatMessages = document.getElementById('pugs-chat-messages');
  const chatWasAtBottom = prevChatMessages
    ? (prevChatMessages.scrollHeight - prevChatMessages.scrollTop - prevChatMessages.clientHeight < 40)
    : true;

  const isCompetitive = lobby.mode === 'competitive';
  const you = pugsUser;
  const myEntry = you ? [...lobby.teamA, ...lobby.teamB].find(p => p.userId === you.userId) : null;
  const hostEntry = [...lobby.teamA, ...lobby.teamB].find(p => p.userId === lobby.host);

  const headLines = [];
  if (!isCompetitive) {
    headLines.push(`
      <div class="pugs-weapon-box">
        <div class="pugs-lobby-line">Everyone uses the same weapon</div>
        <div class="pugs-lobby-line">Random Weapon: ${escapeHtml(lobby.weapon)}</div>
      </div>`);
  }
  if (isCompetitive && myEntry) headLines.push(`<span class="pugs-ranked-wins">Rank: <b>${pugsRankName(myEntry.rankedWins || 0)}</b></span>`);

  let codeSectionHtml;
  if (lobby.code) {
    codeSectionHtml = `
      <div class="pugs-lobby-code-box">
        <span class="pugs-lobby-code-label">LOBBY CODE:</span>
        <span class="pugs-lobby-code-value">${escapeHtml(lobby.code.toUpperCase())}</span>
      </div>`;
  } else if (lobby.isHost) {
    codeSectionHtml = `
      <div class="pugs-lobby-code-box">
        <span class="pugs-lobby-code-label">LOBBY CODE:</span>
        <div class="pugs-code-input-row">
          <input type="text" id="pugs-code-input" class="pugs-code-input" style="text-transform:uppercase;" placeholder="Paste the code" maxlength="32" />
          <button type="button" class="pugs-queue-btn pugs-btn-sm" onclick="pugsSetCode()">Set</button>
        </div>
      </div>`;
  } else {
    codeSectionHtml = `
      <div class="pugs-lobby-code-box">
        <span class="pugs-lobby-code-label">LOBBY CODE:</span>
        <span class="pugs-lobby-code-value" style="color:rgba(255,255,255,0.35);">Waiting on host…</span>
      </div>`;
  }

  let voteHtml = '';
  if (lobby.result) {
    const winnerLabel = lobby.result === 'teamA' ? 'Team A' : 'Team B';
    voteHtml = `<div class="pugs-result-banner">${winnerLabel} Wins!</div>
      <button type="button" class="pugs-queue-btn pugs-btn-cancel" style="width:100%;" onclick="pugsBackToQueue()">Back to Queue</button>`;
  } else if (lobby.code) {
    voteHtml = `
      <div class="pugs-lobby-code-label" style="text-align:center;margin-bottom:0.75rem;">Which team won? (needs 4 votes)</div>
      <div class="pugs-vote-row">
        <button type="button" class="pugs-vote-btn ${lobby.myVote === 'teamA' ? 'voted' : ''}" onclick="pugsVote('teamA')">
          Team A Won
          <span class="pugs-vote-tally">${lobby.voteCounts.teamA}/4 votes</span>
        </button>
        <button type="button" class="pugs-vote-btn ${lobby.myVote === 'teamB' ? 'voted' : ''}" onclick="pugsVote('teamB')">
          Team B Won
          <span class="pugs-vote-tally">${lobby.voteCounts.teamB}/4 votes</span>
        </button>
      </div>`;
  }

  view.innerHTML = `
    <div class="pugs-lobby">
      <div class="pugs-lobby-found">Lobby Found</div>
      <div class="pugs-lobby-maker-line">Lobby Maker: <b>${escapeHtml((hostEntry && hostEntry.displayName) || 'Unknown')}</b></div>
      ${lobby.isHost ? '<div class="pugs-lobby-maker-banner">You are the Lobby Maker</div>' : ''}

      <div class="pugs-lobby-head">
        ${headLines.join('')}
      </div>

      ${lobby.map ? pugsMapCardHtml(lobby.map) : pugsMapBanHtml(lobby)}

      ${codeSectionHtml}

      <div class="pugs-teams">
        <div class="pugs-team">
          <div class="pugs-team-name">Team A</div>
          ${lobby.teamA.map(p => pugsPlayerRow(p, isCompetitive, lobby.host)).join('')}
        </div>
        ${pugsChatHtml(lobby)}
        <div class="pugs-team">
          <div class="pugs-team-name">Team B</div>
          ${lobby.teamB.map(p => pugsPlayerRow(p, isCompetitive, lobby.host)).join('')}
        </div>
      </div>

      ${voteHtml}
    </div>`;

  const chatInput = document.getElementById('pugs-chat-input');
  if (chatInput) {
    chatInput.value = chatDraft;
    chatInput.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); pugsSendChat(); } };
    if (chatWasFocused) chatInput.focus();
  }
  const codeInput = document.getElementById('pugs-code-input');
  if (codeInput) {
    codeInput.value = codeDraft;
    if (codeWasFocused) codeInput.focus();
  }
  const chatMessages = document.getElementById('pugs-chat-messages');
  if (chatMessages && chatWasAtBottom) chatMessages.scrollTop = chatMessages.scrollHeight;

  if (!lobby.map && lobby.mapBanDeadline) pugsStartMapBanTimer(lobby.mapBanDeadline);
  else pugsStopMapBanTimer();
}

async function pugsRefresh() {
  let status;
  try {
    status = await pugsApi('/api/pugs/status');
  } catch (_) {
    return;
  }

  if (status.lobby) {
    pugsRenderLobby(status.lobby);
    return;
  }

  document.getElementById('pugs-lobby-view').style.display = 'none';
  document.getElementById('pugs-queue-view').style.display = 'flex';

  document.getElementById('casual-queue-count').textContent = status.counts.casual;
  document.getElementById('competitive-queue-count').textContent = status.counts.competitive;
  document.getElementById('casual-live-count').textContent = status.gamesLive.casual;
  document.getElementById('competitive-live-count').textContent = status.gamesLive.competitive;

  const loggedIn = !!pugsUser;
  ['casual', 'competitive'].forEach(mode => {
    if (!loggedIn) pugsSetButtonState(mode, 'login');
    else if (status.inQueue === mode) pugsSetButtonState(mode, 'searching', status.counts[mode]);
    else if (status.inQueue) pugsSetButtonState(mode, 'busy');
    else pugsSetButtonState(mode, 'queue');
  });
}

function pugsRenderLeaderboard(elId, list, showRank) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!list.length) { el.innerHTML = '<p class="pugs-note">No wins recorded yet.</p>'; return; }
  el.innerHTML = list.map((p, i) => `
    <div class="pugs-leaderboard-row">
      <span class="pugs-leaderboard-rank">#${i + 1}</span>
      <img src="${pugsAvatarUrl(p)}" alt="" />
      <span class="pugs-leaderboard-name">${escapeHtml(p.displayName || 'Unknown')}</span>
      ${showRank ? `<span class="pugs-leaderboard-tier">${pugsRankName(p.wins)}</span>` : ''}
      <span class="pugs-leaderboard-wins">${p.wins}</span>
    </div>`).join('');
}

async function pugsLoadLeaderboard() {
  try {
    const data = await pugsApi('/api/pugs/leaderboard');
    pugsRenderLeaderboard('pugs-leaderboard-casual', data.casual, false);
    pugsRenderLeaderboard('pugs-leaderboard-ranked', data.ranked, true);
  } catch (_) {}
}

async function pugsInit() {
  await pugsLoadUser();
  await pugsRefresh();
  await pugsLoadLeaderboard();
  setInterval(pugsRefresh, PUGS_POLL_MS);
  setInterval(pugsLoadLeaderboard, PUGS_POLL_MS);
}

pugsInit();
