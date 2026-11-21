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
  app.innerHTML = `
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand">مِداد<small>قليلٌ دائم.. يصنع عالِماً.</small></div>
        <div class="row">
          <span class="small muted">${p.full_name}</span>
          <button type="button" class="btn btn-sm" id="logout-btn">تسجيل الخروج</button>
        </div>
      </div>
      <nav class="nav">${nav}</nav>
    </header>
    <main class="container" id="view"></main>`;
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

export async function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const parts = hash.split('/').filter(Boolean);

  if (!state.user) {
    renderLogin(app);
    return;
  }

  state.profile = await loadProfile();
  if (!state.profile) {
    await supabase.auth.signOut();
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

async function init() {
  const { data: { session } } = await supabase.auth.getSession();
  state.user = session?.user || null;
  supabase.auth.onAuthStateChange((_event, sess) => {
    state.user = sess?.user || null;
    route();
  });
  window.addEventListener('hashchange', route);
  route();
}

init();
