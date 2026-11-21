import {
  supabase, callManageUsers, fetchMembers, formatHijri, escapeHtml, toast, openModal
} from './lib.js';

export async function renderSuperHome(view) {
  view.innerHTML = '<p class="muted center">جارٍ التحميل…</p>';
  try {
    const { data: assistants, error } = await supabase
      .from('profiles').select('*').eq('role', 'assistant_admin').order('full_name');
    if (error) throw error;

    view.innerHTML = `
      <div class="card">
        <h2>إضافة مشرف مساعد</h2>
        <form id="add-assistant-form" autocomplete="off">
          <div class="field"><label>الاسم الكامل</label><input class="input" id="as-name" /></div>
          <div class="field"><label>البريد الإلكتروني</label><input class="input" id="as-email" type="email" dir="ltr" style="text-align:left" /></div>
          <div class="field"><label>كلمة المرور (6 أحرف على الأقل)</label><input class="input" id="as-pass" type="password" dir="ltr" style="text-align:left" /></div>
          <button type="submit" class="btn btn-primary btn-block">إضافة المشرف</button>
        </form>
      </div>
      <div class="card">
        <h2>المشرفون المساعدون</h2>
        <ul class="list">
          ${(assistants || []).map((a) => `<li>
            <span><strong>${escapeHtml(a.full_name)}</strong><br>
              <span class="small muted" dir="ltr">${escapeHtml(a.email || '')}</span><br>
              <span class="small muted">انضم ${formatHijri(a.joined_at)}</span></span>
            <span class="row">
              ${a.status === 'active' ? '<span class="badge badge-ok">نشط</span>' : '<span class="badge badge-warn">موقوف</span>'}
              <button type="button" class="btn btn-sm" data-edit="${a.id}">تعديل</button>
              ${a.status === 'active'
                ? `<button type="button" class="btn btn-sm" data-suspend="${a.id}">إيقاف</button>`
                : `<button type="button" class="btn btn-sm" data-activate="${a.id}">تفعيل</button>`}
              <button type="button" class="btn btn-sm btn-danger" data-delete="${a.id}">حذف</button>
            </span>
          </li>`).join('') || '<li>لا يوجد مشرفون مساعدون بعد.</li>'}
        </ul>
      </div>`;

    view.querySelector('#add-assistant-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const full_name = view.querySelector('#as-name').value.trim();
      const email = view.querySelector('#as-email').value.trim();
      const password = view.querySelector('#as-pass').value;
      if (!full_name || !email || password.length < 6) return toast('أكمل البيانات (كلمة المرور 6 أحرف على الأقل)', 'error');
      try {
        await callManageUsers('create_assistant', { full_name, email, password });
        toast('تمت إضافة المشرف بنجاح', 'ok');
        renderSuperHome(view);
      } catch (err) { toast('تعذر الإضافة: ' + err.message, 'error'); }
    });

    view.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const a = (assistants || []).find((x) => x.id === b.dataset.edit);
      const { overlay, close } = openModal('تعديل المشرف', `
        <form id="ae-form">
          <div class="field"><label>الاسم الكامل</label><input class="input" id="ae-name" value="${escapeHtml(a.full_name)}" /></div>
          <div class="field"><label>البريد الإلكتروني</label><input class="input" id="ae-email" type="email" value="${escapeHtml(a.email || '')}" dir="ltr" style="text-align:left" /></div>
          <button type="submit" class="btn btn-primary btn-block">حفظ</button>
        </form>`);
      overlay.querySelector('#ae-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await callManageUsers('update_profile', {
            id: a.id,
            full_name: overlay.querySelector('#ae-name').value.trim(),
            email: overlay.querySelector('#ae-email').value.trim()
          });
          toast('تم الحفظ', 'ok'); close(); renderSuperHome(view);
        } catch (err) { toast(err.message, 'error'); }
      });
    }));

    const setStatus = async (id, status) => {
      try {
        await callManageUsers('set_status', { id, status });
        toast('تم تحديث الحالة', 'ok'); renderSuperHome(view);
      } catch (err) { toast(err.message, 'error'); }
    };
    view.querySelectorAll('[data-suspend]').forEach((b) => b.addEventListener('click', () => setStatus(b.dataset.suspend, 'suspended')));
    view.querySelectorAll('[data-activate]').forEach((b) => b.addEventListener('click', () => setStatus(b.dataset.activate, 'active')));
    view.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('حذف هذا المشرف المساعد نهائيًا؟')) return;
      try {
        await callManageUsers('delete_user', { id: b.dataset.delete });
        toast('تم الحذف', 'ok'); renderSuperHome(view);
      } catch (err) { toast(err.message, 'error'); }
    }));
  } catch (e) {
    view.innerHTML = `<div class="card center"><p>حدث خطأ: ${escapeHtml(e.message)}</p></div>`;
  }
}

export async function renderSuperMembers(view) {
  view.innerHTML = '<p class="muted center">جارٍ التحميل…</p>';
  try {
    const members = await fetchMembers();
    view.innerHTML = `
      <div class="card">
        <h2>جميع الأعضاء</h2>
        <p class="muted small">الحذف النهائي متاح للمشرف العام فقط، ويحذف العضو وكل سجلاته نهائيًا.</p>
        <ul class="list">
          ${members.map((m) => `<li>
            <span><a href="#/admin/member/${m.id}">${escapeHtml(m.full_name)}</a><br>
              <span class="small muted" dir="ltr">${escapeHtml(m.phone || '')}</span></span>
            <span class="row">
              ${m.status === 'active' ? '<span class="badge badge-ok">نشط</span>'
                : m.status === 'suspended' ? '<span class="badge badge-warn">موقوف</span>'
                : '<span class="badge badge-muted">مستبعد</span>'}
              <button type="button" class="btn btn-sm btn-danger" data-delete="${m.id}">حذف نهائي</button>
            </span>
          </li>`).join('') || '<li>لا يوجد أعضاء بعد.</li>'}
        </ul>
      </div>`;
    view.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('حذف نهائي لهذا العضو وكل سجلاته؟ لا يمكن التراجع.')) return;
      try {
        await callManageUsers('delete_user', { id: b.dataset.delete });
        toast('تم الحذف النهائي', 'ok'); renderSuperMembers(view);
      } catch (err) { toast(err.message, 'error'); }
    }));
  } catch (e) {
    view.innerHTML = `<div class="card center"><p>حدث خطأ: ${escapeHtml(e.message)}</p></div>`;
  }
}
