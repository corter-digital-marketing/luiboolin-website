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
    el.innerHTML = '';
  } else {
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:0.625rem;">
        <img src="${avatarUrl(currentUser)}" alt="${currentUser.displayName}" style="width:30px;height:30px;border-radius:50%;border:2px solid rgba(124,58,237,0.5);" />
        <span style="font-size:0.85rem;font-weight:600;color:rgba(255,255,255,0.85);">${currentUser.displayName}</span>
        <a href="/auth/logout" style="font-size:0.75rem;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.35);text-decoration:none;transition:color 0.2s;margin-left:0.25rem;" onmouseover="this.style.color='#fff'" onmouseout="this.style.color='rgba(255,255,255,0.35)'">Logout</a>
      </div>`;
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
