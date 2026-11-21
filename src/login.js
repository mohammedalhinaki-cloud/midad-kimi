import { supabase, normalizeSaudiPhone, normalizePin, pinToPassword, escapeHtml } from './lib.js';

export function renderLogin(root) {
  root.innerHTML = `
    <div class="login-wrap">
      <div class="card login-card">
        <div class="center" style="margin-bottom:14px">
          <h1 style="margin-bottom:2px">مِداد</h1>
          <p class="muted small" style="margin:0">قليلٌ دائم.. يصنع عالِماً.</p>
        </div>
        <div class="tabs">
          <button type="button" id="tab-member" class="active">دخول الأعضاء</button>
          <button type="button" id="tab-admin">دخول الإدارة</button>
        </div>
        <div id="login-error"></div>

        <form id="member-form" autocomplete="off">
          <div class="field">
            <label for="phone">رقم الجوال</label>
            <input class="input" id="phone" inputmode="numeric" autocomplete="tel"
              placeholder="5xxxxxxxxx" dir="ltr" style="text-align:left" />
          </div>
          <div class="field">
            <label for="pin">الرقم السري (4 أرقام)</label>
            <input class="input" id="pin" type="password" inputmode="numeric"
              autocomplete="current-password" maxlength="4" placeholder="••••"
              dir="ltr" style="text-align:left; letter-spacing:6px" />
          </div>
          <button type="submit" class="btn btn-primary btn-block" id="member-btn">دخول</button>
        </form>

        <form id="admin-form" autocomplete="off" hidden>
          <div class="field">
            <label for="email">البريد الإلكتروني</label>
            <input class="input" id="email" type="email" autocomplete="username" dir="ltr" style="text-align:left" />
          </div>
          <div class="field">
            <label for="password">كلمة المرور</label>
            <input class="input" id="password" type="password" autocomplete="current-password" dir="ltr" style="text-align:left" />
          </div>
          <button type="submit" class="btn btn-primary btn-block" id="admin-btn">دخول</button>
        </form>
      </div>
    </div>`;

  const errBox = root.querySelector('#login-error');
  const showError = (msg) => { errBox.innerHTML = `<div class="error-box">${escapeHtml(msg)}</div>`; };
  const clearError = () => { errBox.innerHTML = ''; };

  const tabMember = root.querySelector('#tab-member');
  const tabAdmin = root.querySelector('#tab-admin');
  const memberForm = root.querySelector('#member-form');
  const adminForm = root.querySelector('#admin-form');

  tabMember.addEventListener('click', () => {
    tabMember.classList.add('active'); tabAdmin.classList.remove('active');
    memberForm.hidden = false; adminForm.hidden = true; clearError();
  });
  tabAdmin.addEventListener('click', () => {
    tabAdmin.classList.add('active'); tabMember.classList.remove('active');
    adminForm.hidden = false; memberForm.hidden = true; clearError();
  });

  memberForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const phone = normalizeSaudiPhone(root.querySelector('#phone').value);
    const pin = normalizePin(root.querySelector('#pin').value);
    if (!phone) return showError('أدخل رقم جوال سعودي صحيح يبدأ بـ 5xxxxxxxxx');
    if (!pin) return showError('الرقم السري يجب أن يكون 4 أرقام بالضبط');
    const btn = root.querySelector('#member-btn');
    btn.disabled = true; btn.textContent = 'جارٍ الدخول…';
    const { error } = await supabase.auth.signInWithPassword({ phone, password: pinToPassword(pin) });
    btn.disabled = false; btn.textContent = 'دخول';
    if (error) return showError('بيانات الدخول غير صحيحة');
    location.hash = '#/member';
  });

  adminForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const email = root.querySelector('#email').value.trim();
    const password = root.querySelector('#password').value;
    if (!email || !password) return showError('أدخل البريد الإلكتروني وكلمة المرور');
    const btn = root.querySelector('#admin-btn');
    btn.disabled = true; btn.textContent = 'جارٍ الدخول…';
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    btn.disabled = false; btn.textContent = 'دخول';
    if (error) return showError('بيانات الدخول غير صحيحة');
    location.hash = '#/admin';
  });
}
