// ══════════════════════════════════════
// MOBILE MENU
// ══════════════════════════════════════
function toggleMobileMenu() {
  const menu = document.getElementById('mobile-menu');
  if (!menu) return;
  const open = menu.classList.toggle('open');
  menu.setAttribute('aria-hidden', String(!open));
}
function closeMobileMenu() {
  const menu = document.getElementById('mobile-menu');
  if (menu) { menu.classList.remove('open'); menu.setAttribute('aria-hidden', 'true'); }
}

// ══════════════════════════════════════
// AUTH (nav-auth widget, shown on every page)
// ══════════════════════════════════════
let currentUser = null;

function avatarUrl(user) {
  if (user.avatar) {
    return `https://cdn.discordapp.com/avatars/${user.userId}/${user.avatar}.png?size=64`;
  }
  return `https://cdn.discordapp.com/embed/avatars/${parseInt(user.userId) % 5}.png`;
}

function renderNavAuth() {
  const el = document.getElementById('nav-auth');
  if (!el) return;
  if (!currentUser) {
    el.innerHTML = `
      <a href="/auth/discord" style="display:inline-flex;align-items:center;gap:0.4rem;font-size:0.8rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#fff;background:linear-gradient(135deg,#7c3aed 0%,#4c1d95 100%);padding:0.55rem 1.15rem;border-radius:4px;text-decoration:none;box-shadow:0 2px 10px rgba(124,58,237,0.4);transition:transform 0.2s;" onmouseover="this.style.transform='translateY(-1px)'" onmouseout="this.style.transform='translateY(0)'">Login</a>`;
  } else {
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:0.625rem;">
        <button type="button" onclick="openProfileModal()" style="display:flex;align-items:center;gap:0.625rem;background:none;border:none;padding:0;cursor:pointer;">
          <img src="${avatarUrl(currentUser)}" alt="${currentUser.displayName}" style="width:30px;height:30px;border-radius:50%;border:2px solid rgba(124,58,237,0.5);" />
          <span style="font-size:0.85rem;font-weight:600;color:rgba(255,255,255,0.85);">${currentUser.displayName}</span>
        </button>
        <a href="/auth/logout" style="font-size:0.75rem;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.35);text-decoration:none;transition:color 0.2s;margin-left:0.25rem;" onmouseover="this.style.color='#fff'" onmouseout="this.style.color='rgba(255,255,255,0.35)'">Logout</a>
      </div>`;
  }
}

// ══════════════════════════════════════
// PROFILE MODAL (stats + Embark ID)
// ══════════════════════════════════════
function _blEscapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function openProfileModal() {
  let profile;
  try {
    const res = await fetch('/api/profile');
    profile = await res.json();
  } catch (_) { return; }
  if (!profile || profile.error) return;

  let overlay = document.getElementById('bl-profile-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'bl-profile-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999;padding:1.5rem;';
    overlay.onclick = e => { if (e.target === overlay) closeProfileModal(); };
    document.body.appendChild(overlay);
  }

  overlay.innerHTML = `
    <div style="background:#0d0912;border:1px solid rgba(124,58,237,0.4);max-width:380px;width:100%;padding:2rem;position:relative;">
      <button type="button" onclick="closeProfileModal()" style="position:absolute;top:0.6rem;right:0.75rem;background:none;border:none;color:rgba(255,255,255,0.5);font-size:1.4rem;cursor:pointer;line-height:1;">&times;</button>
      <div style="display:flex;align-items:center;gap:0.85rem;margin-bottom:1.75rem;">
        <img src="${avatarUrl(profile)}" alt="" style="width:48px;height:48px;border-radius:50%;border:2px solid rgba(124,58,237,0.5);" />
        <div>
          <div style="font-weight:700;color:#fff;font-size:1.05rem;">${_blEscapeHtml(profile.embarkId || profile.displayName)}</div>
          <div style="font-size:0.75rem;color:rgba(255,255,255,0.4);">${_blEscapeHtml(profile.displayName)}</div>
        </div>
      </div>
      <div style="display:flex;gap:2rem;margin-bottom:1.75rem;">
        <div>
          <div style="font-size:1.6rem;font-weight:800;color:#fff;">${profile.casualWins}</div>
          <div style="font-size:0.7rem;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.5);">Casual Wins</div>
        </div>
        <div>
          <div style="font-size:1.6rem;font-weight:800;color:#fff;">${profile.rankedWins}</div>
          <div style="font-size:0.7rem;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.5);">Ranked Wins</div>
        </div>
      </div>
      <label style="display:block;font-size:0.7rem;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.5);margin-bottom:0.4rem;">Embark ID</label>
      <div style="display:flex;gap:0.5rem;">
        <input id="bl-embark-input" type="text" value="${_blEscapeHtml(profile.embarkId || '')}" placeholder="e.g. Player#1234" maxlength="40" style="flex:1;min-width:0;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.2);color:#fff;padding:0.6rem 0.8rem;font-size:0.9rem;" />
        <button type="button" onclick="saveEmbarkId()" style="background:linear-gradient(135deg,#7c3aed 0%,#4c1d95 100%);border:none;color:#fff;font-weight:700;font-size:0.8rem;letter-spacing:0.05em;text-transform:uppercase;padding:0.6rem 1rem;cursor:pointer;">Save</button>
      </div>
      <p style="font-size:0.75rem;color:rgba(255,255,255,0.35);margin-top:0.6rem;">This is what shows in Pugs lobbies instead of your Discord name.</p>
    </div>`;
}

function closeProfileModal() {
  const overlay = document.getElementById('bl-profile-overlay');
  if (overlay) overlay.remove();
}

async function saveEmbarkId() {
  const input = document.getElementById('bl-embark-input');
  if (!input) return;
  const embarkId = input.value.trim();
  try {
    const res = await fetch('/api/profile/embark-id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embarkId }),
    });
    if (!res.ok) throw new Error();
    closeProfileModal();
  } catch (_) {
    alert('Failed to save Embark ID.');
  }
}

async function initAuth() {
  try {
    const res = await fetch('/auth/me');
    currentUser = await res.json();
  } catch (_) { currentUser = null; }
  renderNavAuth();
}

// ══════════════════════════════════════
// SCROLL ANIMATIONS (elements with class="fade-up")
// ══════════════════════════════════════
const _fadeObserver = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('visible'); _fadeObserver.unobserve(e.target); } });
}, { threshold: 0.1 });
document.querySelectorAll('.fade-up').forEach(el => _fadeObserver.observe(el));

// ══════════════════════════════════════
// NAVBAR SCROLL
// ══════════════════════════════════════
const _navEl = document.querySelector('.nav');
if (_navEl) {
  window.addEventListener('scroll', () => {
    _navEl.style.background = window.scrollY > 40 ? 'rgba(5,3,8,0.95)' : 'rgba(5,3,8,0.7)';
  }, { passive: true });
}

// ══════════════════════════════════════
// KEYBOARD: ESC closes the player modal, on pages that have one
// ══════════════════════════════════════
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && typeof closePlayerModal === 'function') closePlayerModal(true);
});

initAuth();

// ══════════════════════════════════════
// PRESENCE (site-wide "how many people are online" — tracked on every
// page so any page can show it via a #bl-online-count element)
// ══════════════════════════════════════
async function blSendHeartbeat() {
  try {
    const res = await fetch('/api/presence/heartbeat', { method: 'POST' });
    const data = await res.json();
    const el = document.getElementById('bl-online-count');
    if (el && typeof data.online === 'number') el.textContent = data.online;
  } catch (_) {}
}
blSendHeartbeat();
setInterval(blSendHeartbeat, 20000);
