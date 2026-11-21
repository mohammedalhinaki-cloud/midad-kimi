import './style.css';
import { supabase } from './lib.js';
import { renderLogin } from './login.js';
import { renderMemberHome, renderMemberHistory } from './member.js';
import { renderReader } from './reader.js';
import {
  renderAdminDashboard, renderAdminMembers, renderMemberDetail,
  renderBooks, renderReports, renderLogs
} from './admin.js';
import { renderSuperHome, renderSuperMembers } from './super.js';

const app = document.getElementById('app');
export const state = { user: null, profile: null };

async function loadProfile() {
  if (!state.user) return null;
  const { data } = await supabase.from('profiles').select('*').eq('id', state.user.id).maybeSingle();
  return data || null;
}

function renderShell(active) {
  const p = state.profile;
  let nav = '';
  if (p.role === 'member') {
    nav = `
      <a href="#/member" class="${active === 'member' ? 'active' : ''}">الرئيسية</a>
      <a href="#/member/history" class="${active === 'history' ? 'active' : ''}">سجل القراءة</a>`;
  } else if (p.role === 'assistant_admin') {
    nav = `
      <a href="#/admin" class="${active === 'admin' ? 'active' : ''}">الرئيسية</a>
      <a href="#/admin/members" class="${active === 'members' ? 'active' : ''}">الأعضاء</a>
      <a href="#/admin/books" class="${active === 'books' ? 'active' : ''}">الكتاب</a>
      <a href="#/admin/reports" class="${active === 'reports' ? 'active' : ''}">التقارير</a>
      <a href="#/admin/logs" class="${active === 'logs' ? 'active' : ''}">سجل النشاط</a>`;
  } else if (p.role === 'super_admin') {
    nav = `
      <a href="#/super" class="${active === 'super' ? 'active' : ''}">المشرفون</a>
      <a href="#/super/members" class="${active === 'super-members' ? 'active' : ''}">الأعضاء</a>
      <a href="#/admin/books" class="${active === 'books' ? 'active' : ''}">الكتاب</a>
      <a href="#/admin/reports" class="${active === 'reports' ? 'active' : ''}">التقارير</a>
      <a href="#/super/logs" class="${active === 'logs' ? 'active' : ''}">سجل النشاط</a>`;
  }
  const viewClass = active === 'read' ? 'reader-page' : 'container';
  app.innerHTML = `
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand brand-lockup">
          <img src="./midad-logo.png" alt="" width="40" height="40" />
          <span>مِداد<small>قليلٌ دائم.. يصنع عالِماً.</small></span>
        </div>
        <div class="row">
          <span class="small muted">${p.full_name}</span>
          <button type="button" class="btn btn-sm" id="logout-btn">تسجيل الخروج</button>
        </div>
      </div>
      <nav class="nav">${nav}</nav>
    </header>
    <main class="${viewClass}" id="view"></main>`;
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await supabase.auth.signOut();
    state.user = null; state.profile = null;
    location.hash = '#/login';
    route();
  });
}

function renderBlocked() {
  const p = state.profile;
  const msg = p.status === 'suspended'
    ? 'حسابك موقوف مؤقتًا. تواصل مع إدارة المجموعة.'
    : 'تم استبعادك من المجموعة. تواصل مع إدارة المجموعة لمزيد من المعلومات.';
  app.innerHTML = `
    <div class="login-wrap"><div class="card login-card center">
      <h1>مِداد</h1>
      <p>${msg}</p>
      <button type="button" class="btn btn-block" id="logout-btn">تسجيل الخروج</button>
    </div></div>`;
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await supabase.auth.signOut();
    state.user = null; state.profile = null;
    location.hash = '#/login';
    route();
  });
}

let routeRequestId = 0;

export async function route() {
  const requestId = ++routeRequestId;
  const hash = location.hash.replace(/^#/, '') || '/';
  const parts = hash.split('/').filter(Boolean);

  if (!state.user) {
    renderLogin(app);
    return;
  }

  state.profile = await loadProfile();
  if (requestId !== routeRequestId) return;
  if (!state.profile) {
    await supabase.auth.signOut();
    if (requestId !== routeRequestId) return;
    state.user = null;
    renderLogin(app);
    return;
  }
  if (state.profile.status !== 'active') {
    renderBlocked();
    return;
  }

  const role = state.profile.role;

  // Reader is full-width (no standard container padding)
  if (parts[0] === 'read' && parts[1]) {
    renderShell('read');
    renderReader(document.getElementById('view'), parts[1]);
    return;
  }

  if (role === 'member') {
    renderShell(parts[0] === 'member' && parts[1] === 'history' ? 'history' : 'member');
    const view = document.getElementById('view');
    if (parts[0] === 'member' && parts[1] === 'history') renderMemberHistory(view);
    else renderMemberHome(view);
    return;
  }

  if (role === 'assistant_admin' || role === 'super_admin') {
    const view = () => document.getElementById('view');
    if (parts[0] === 'super' && role === 'super_admin') {
      renderShell(parts[1] === 'members' ? 'super-members' : parts[1] === 'logs' ? 'logs' : 'super');
      if (parts[1] === 'members') renderSuperMembers(view());
      else if (parts[1] === 'logs') renderLogs(view(), true);
      else renderSuperHome(view());
      return;
    }
    if (parts[0] === 'admin') {
      const sub = parts[1];
      renderShell(sub === 'members' || sub === 'member' ? 'members' : sub === 'books' ? 'books' : sub === 'reports' ? 'reports' : sub === 'logs' ? 'logs' : 'admin');
      if (sub === 'members') renderAdminMembers(view());
      else if (sub === 'member' && parts[2]) renderMemberDetail(view(), parts[2]);
      else if (sub === 'books') renderBooks(view());
      else if (sub === 'reports') renderReports(view());
      else if (sub === 'logs') renderLogs(view(), false);
      else renderAdminDashboard(view());
      return;
    }
    // Default landing by role
    location.hash = role === 'super_admin' ? '#/super' : '#/admin';
    return;
  }
}

let appListenersBound = false;

async function init() {
  const { data: { session } } = await supabase.auth.getSession();
  state.user = session?.user || null;
  if (!appListenersBound) {
    supabase.auth.onAuthStateChange((event, sess) => {
      const previousUserId = state.user?.id || null;
      const nextUser = sess?.user || null;
      const nextUserId = nextUser?.id || null;
      state.user = nextUser;

      // Ignore duplicate sign-in notifications for the same session; they can
      // otherwise redraw the whole view and look like an unsolicited refresh.
      if (event === 'SIGNED_IN' && previousUserId === nextUserId) return;
      if (event === 'SIGNED_OUT' && previousUserId === null && nextUserId === null) return;
      if (['SIGNED_IN', 'SIGNED_OUT', 'USER_UPDATED', 'PASSWORD_RECOVERY', 'MFA_CHALLENGE_VERIFIED'].includes(event)) {
        void route();
      }
    });
    window.addEventListener('hashchange', () => { void route(); });
    appListenersBound = true;
  }
  await route();
}

const introScreen = document.getElementById('intro-screen');
const launchButton = document.getElementById('launch-button');
const introError = document.getElementById('intro-error');
let appStarted = false;

function revealLaunchButton() {
  if (!launchButton) return;
  launchButton.hidden = false;
  requestAnimationFrame(() => launchButton.classList.add('is-ready'));
}

if (introScreen && launchButton) {
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) revealLaunchButton();
  else window.setTimeout(revealLaunchButton, 1750);

  launchButton.addEventListener('click', async () => {
    if (appStarted) return;
    appStarted = true;
    launchButton.disabled = true;
    launchButton.querySelector('.launch-button-label').textContent = 'جارٍ فتح مِداد…';
    if (introError) introError.hidden = true;

    try {
      await init();
      app.hidden = false;
      app.removeAttribute('aria-hidden');
      document.body.classList.remove('intro-active');
      introScreen.classList.add('is-exiting');
      window.setTimeout(() => introScreen.remove(), 560);
    } catch (error) {
      appStarted = false;
      launchButton.disabled = false;
      launchButton.querySelector('.launch-button-label').textContent = 'انطلق';
      if (introError) {
        introError.textContent = 'تعذر فتح مِداد الآن. تحقق من الاتصال ثم حاول مرة أخرى.';
        introError.hidden = false;
      }
      console.error('[مِداد] تعذر بدء التطبيق:', error);
    }
  });
} else {
  app.hidden = false;
  app.removeAttribute('aria-hidden');
  void init();
}
