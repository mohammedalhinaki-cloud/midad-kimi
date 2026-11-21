import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  supabase, callManageUsers, logActivity, fetchActiveBook, fetchMembers, fetchAllAssignments,
  fetchCompletions, fetchLeaves, fetchSessions, riyadhToday, addDays,
  formatHijri, formatHijriTime, formatTime, arabicOrdinal, toArabicDigits, toWesternDigits,
  isOnLeave, memberDayStatus, consecutiveAbsence, commitmentStats,
  normalizeSaudiPhone, normalizePin, escapeHtml, toast, openModal
} from './lib.js';
import { state } from './main.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const BOOK_DRAFT_KEY = 'midad_admin_book_draft_v1';
let pendingBookFile = null;

function readBookDraft() {
  const empty = { title: '', author: '', daily_pages: '3' };
  try {
    const draft = JSON.parse(sessionStorage.getItem(BOOK_DRAFT_KEY) || '{}');
    return {
      title: typeof draft.title === 'string' ? draft.title : empty.title,
      author: typeof draft.author === 'string' ? draft.author : empty.author,
      daily_pages: typeof draft.daily_pages === 'string' ? draft.daily_pages : empty.daily_pages
    };
  } catch {
    return empty;
  }
}

function saveBookDraft(view) {
  try {
    sessionStorage.setItem(BOOK_DRAFT_KEY, JSON.stringify({
      title: view.querySelector('#bf-title')?.value || '',
      author: view.querySelector('#bf-author')?.value || '',
      daily_pages: view.querySelector('#bf-daily')?.value ?? '3'
    }));
  } catch { /* session storage may be disabled; current form state still stays intact */ }
}

function clearBookDraft() {
  pendingBookFile = null;
  try { sessionStorage.removeItem(BOOK_DRAFT_KEY); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
export async function renderAdminDashboard(view) {
  view.innerHTML = '<p class="muted center">جارٍ التحميل…</p>';
  try {
    const today = riyadhToday();
    const [assignmentRes, members, completions, leaves, sessions, book] = await Promise.all([
      supabase.rpc('get_today_assignment'),
      fetchMembers(),
      fetchCompletions(),
      fetchLeaves(),
      fetchSessions(),
      fetchActiveBook()
    ]);
    if (assignmentRes.error) throw assignmentRes.error;
    const assignment = assignmentRes.data;
    const allAssignments = book ? await fetchAllAssignments(book.id) : [];
    const now = new Date();

    const activeMembers = members.filter((m) => m.status === 'active');
    let doneCount = 0;
    let rows = '';

    for (const m of members) {
      let statusHtml;
      if (m.status !== 'active') {
        statusHtml = m.status === 'suspended'
          ? '<span class="badge badge-warn">موقوف</span>'
          : '<span class="badge badge-muted">مستبعد</span>';
      } else if (!assignment) {
        statusHtml = '<span class="badge badge-muted">لم تُنشر قراءة اليوم</span>';
      } else if (assignment.is_no_reading) {
        statusHtml = '<span class="badge badge-muted">لا قراءة اليوم</span>';
      } else {
        const completion = completions.find((c) => c.member_id === m.id && c.assignment_id === assignment.id);
        const session = sessions.find((s) => s.member_id === m.id && s.assignment_id === assignment.id);
        const leave = isOnLeave(leaves, m.id, assignment.assignment_date);
        const st = memberDayStatus({ assignment, completion, session, leave, now });
        if (st.key === 'done') doneCount += 1;
        const abs = consecutiveAbsence(allAssignments, completions, leaves, m.id, today);
        const absHtml = abs >= 3
          ? `<br><span class="small" style="color:var(--danger)">غائب ${abs} أيام متتالية — مؤهل للاستبعاد</span>`
          : abs > 0 ? `<br><span class="small muted">غائب ${abs} ${abs === 1 ? 'يوم' : 'أيام'} متتالية</span>` : '';
        statusHtml = `<span class="badge badge-${st.tone}">${st.label}</span>${
          st.time ? `<br><span class="small muted">${formatTime(st.time)}</span>` : ''}${absHtml}`;
      }
      rows += `<li>
        <span><a href="#/admin/member/${m.id}">${escapeHtml(m.full_name)}</a><br><span class="small muted" dir="ltr">${escapeHtml(m.phone || '')}</span></span>
        <span>${statusHtml}</span>
      </li>`;
    }

    const notDone = assignment && !assignment.is_no_reading ? activeMembers.length - doneCount : 0;

    view.innerHTML = `
      <div class="card">
        <div class="row-between">
          <div>
            <p class="muted small" style="margin:0">${formatHijri(today)}</p>
            <h2 style="margin:2px 0">${book ? escapeHtml(book.title) : 'لا يوجد كتاب'}</h2>
            ${assignment && !assignment.is_no_reading
              ? `<p class="muted small">صفحات اليوم: ${assignment.start_page} — ${assignment.end_page}</p>` : ''}
            ${assignment?.is_no_reading ? '<p class="muted small">لا يوجد قراءة لهذا اليوم</p>' : ''}
            ${!assignment ? '<p class="muted small">لم تُنشر قراءة اليوم بعد.</p>' : ''}
          </div>
          <div class="row no-print">
            <a class="btn btn-sm" href="#/admin/members">إضافة عضو</a>
            <a class="btn btn-sm" href="#/admin/books">إدارة الكتاب</a>
            <a class="btn btn-sm" href="#/admin/reports">التقارير</a>
          </div>
        </div>
        ${assignment && !assignment.is_no_reading ? `
        <div class="stats">
          <div class="stat"><div class="num" style="color:var(--ok)">${doneCount}</div><div class="lbl">أكملوا قراءة اليوم</div></div>
          <div class="stat"><div class="num" style="color:var(--danger)">${notDone}</div><div class="lbl">لم يكملوا بعد</div></div>
        </div>` : ''}
      </div>
      <div class="card">
        <div class="field">
          <input class="input" id="member-search" placeholder="بحث بالاسم…" />
        </div>
        <ul class="list" id="member-list">${rows}</ul>
      </div>`;

    const search = view.querySelector('#member-search');
    search.addEventListener('input', () => {
      const q = search.value.trim();
      view.querySelectorAll('#member-list li').forEach((li) => {
        li.style.display = !q || li.textContent.includes(q) ? '' : 'none';
      });
    });
  } catch (e) {
    view.innerHTML = `<div class="card center"><p>حدث خطأ: ${escapeHtml(e.message)}</p></div>`;
  }
}

// ---------------------------------------------------------------------------
// Members management
// ---------------------------------------------------------------------------
export async function renderAdminMembers(view) {
  view.innerHTML = '<p class="muted center">جارٍ التحميل…</p>';
  try {
    const members = await fetchMembers();
    view.innerHTML = `
      <div class="card">
        <h2>إضافة عضو جديد</h2>
        <form id="add-member-form" autocomplete="off">
          <div class="field"><label>الاسم الكامل</label><input class="input" id="nm-name" /></div>
          <div class="field"><label>رقم الجوال</label><input class="input" id="nm-phone" inputmode="numeric" placeholder="5xxxxxxxxx" dir="ltr" style="text-align:left" /></div>
          <div class="field"><label>الرقم السري (4 أرقام)</label><input class="input" id="nm-pin" type="password" inputmode="numeric" maxlength="4" dir="ltr" style="text-align:left;letter-spacing:6px" /></div>
          <button type="submit" class="btn btn-primary btn-block">إضافة العضو</button>
        </form>
      </div>
      <div class="card">
        <div class="field"><input class="input" id="member-search" placeholder="بحث بالاسم…" /></div>
        <ul class="list" id="member-list">
          ${members.map((m) => `<li data-name="${escapeHtml(m.full_name)}">
            <span><a href="#/admin/member/${m.id}">${escapeHtml(m.full_name)}</a><br>
              <span class="small muted" dir="ltr">${escapeHtml(m.phone || '')}</span></span>
            <span>${m.status === 'active' ? '<span class="badge badge-ok">نشط</span>'
              : m.status === 'suspended' ? '<span class="badge badge-warn">موقوف</span>'
              : '<span class="badge badge-muted">مستبعد</span>'}</span>
          </li>`).join('') || '<li>لا يوجد أعضاء بعد.</li>'}
        </ul>
      </div>`;

    view.querySelector('#member-search').addEventListener('input', (e) => {
      const q = e.target.value.trim();
      view.querySelectorAll('#member-list li').forEach((li) => {
        li.style.display = !q || (li.dataset.name || '').includes(q) ? '' : 'none';
      });
    });

    view.querySelector('#add-member-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const full_name = view.querySelector('#nm-name').value.trim();
      const phone = normalizeSaudiPhone(view.querySelector('#nm-phone').value);
      const pin = normalizePin(view.querySelector('#nm-pin').value);
      if (!full_name) return toast('أدخل اسم العضو', 'error');
      if (!phone) return toast('أدخل رقم جوال سعودي صحيح', 'error');
      if (!pin) return toast('الرقم السري يجب أن يكون 4 أرقام', 'error');
      try {
        await callManageUsers('create_member', { full_name, phone, pin });
        toast('تمت إضافة العضو بنجاح', 'ok');
        renderAdminMembers(view);
      } catch (err) {
        toast('تعذر الإضافة: ' + err.message, 'error');
      }
    });
  } catch (e) {
    view.innerHTML = `<div class="card center"><p>حدث خطأ: ${escapeHtml(e.message)}</p></div>`;
  }
}

// ---------------------------------------------------------------------------
// Member detail
// ---------------------------------------------------------------------------
export async function renderMemberDetail(view, memberId) {
  view.innerHTML = '<p class="muted center">جارٍ التحميل…</p>';
  try {
    const today = riyadhToday();
    const [mRes, book, assignments, completions, leaves, historyRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', memberId).single(),
      fetchActiveBook(),
      fetchAllAssignments(),
      fetchCompletions(),
      fetchLeaves(),
      supabase.from('member_status_history').select('*').eq('member_id', memberId).order('changed_at', { ascending: false })
    ]);
    if (mRes.error) throw mRes.error;
    const m = mRes.data;
    const stats = commitmentStats(assignments, completions, leaves, memberId, today);
    const abs = consecutiveAbsence(assignments, completions, leaves, memberId, today);
    const myLeaves = leaves.filter((l) => l.member_id === memberId).sort((a, b) => b.start_date.localeCompare(a.start_date));
    const past = [...assignments]
      .filter((a) => a.assignment_date < today)
      .sort((a, b) => b.assignment_date.localeCompare(a.assignment_date))
      .slice(0, 30);

    const pastRows = past.map((a) => {
      const c = completions.find((x) => x.member_id === memberId && x.assignment_id === a.id);
      let status;
      if (a.is_no_reading) status = '<span class="badge badge-muted">لا قراءة</span>';
      else if (isOnLeave(leaves, memberId, a.assignment_date)) status = '<span class="badge badge-muted">إجازة</span>';
      else if (c?.counts_as_completed) status = `<span class="badge badge-ok">أكمل القراءة</span> <span class="small muted">${formatHijriTime(c.completed_at)}</span>`;
      else if (c) status = '<span class="badge badge-muted">أكمل بعد المهلة</span>';
      else status = '<span class="badge badge-danger">لم يقرأ</span>';
      return `<li><span>${formatHijri(a.assignment_date)}<br><span class="small muted">صفحات ${a.start_page} — ${a.end_page}</span></span><span>${status}</span></li>`;
    }).join('');

    const historyRows = (historyRes.data || []).map((h) => `<li>
      <span>${h.status === 'active' ? 'نشط' : h.status === 'suspended' ? 'موقوف' : 'مستبعد'}
        ${h.note ? `<br><span class="small muted">${escapeHtml(h.note)}</span>` : ''}</span>
      <span class="small muted">${formatHijriTime(h.changed_at)}</span></li>`).join('');

    view.innerHTML = `
      <div class="card">
        <div class="row-between">
          <div>
            <h2>${escapeHtml(m.full_name)}</h2>
            <p class="muted small" dir="ltr" style="text-align:right">${escapeHtml(m.phone || '')}</p>
            <p class="muted small">انضم ${formatHijri(m.joined_at)}</p>
          </div>
          <span>${m.status === 'active' ? '<span class="badge badge-ok">نشط</span>'
            : m.status === 'suspended' ? '<span class="badge badge-warn">موقوف</span>'
            : '<span class="badge badge-muted">مستبعد</span>'}</span>
        </div>
        <div class="stats">
          <div class="stat"><div class="num">${stats.pct}%</div><div class="lbl">نسبة الالتزام</div></div>
          <div class="stat"><div class="num">${stats.done}</div><div class="lbl">أيام مكتملة</div></div>
          <div class="stat"><div class="num">${abs}</div><div class="lbl">غياب متتالٍ</div></div>
          <div class="stat"><div class="num">${stats.total}</div><div class="lbl">أيام قراءة</div></div>
        </div>
        ${abs >= 3 && m.status === 'active' ? '<p style="color:var(--danger)">هذا العضو مؤهل للاستبعاد (3 أيام غياب متتالية) — القرار للإدارة.</p>' : ''}
      </div>

      <div class="card">
        <h3>إجراءات</h3>
        <div class="row">
          <button type="button" class="btn btn-sm" id="act-edit">تعديل البيانات</button>
          <button type="button" class="btn btn-sm" id="act-pin">إعادة تعيين الرقم السري</button>
          ${m.status === 'active'
            ? '<button type="button" class="btn btn-sm" id="act-suspend">إيقاف</button>'
            : '<button type="button" class="btn btn-sm" id="act-activate">تفعيل</button>'}
          ${m.status !== 'excluded'
            ? '<button type="button" class="btn btn-sm" id="act-exclude">استبعاد</button>'
            : '<button type="button" class="btn btn-sm" id="act-restore">استعادة</button>'}
          <button type="button" class="btn btn-sm" id="act-leave">منح إجازة</button>
          ${state.profile.role === 'super_admin' ? '<button type="button" class="btn btn-sm btn-danger" id="act-delete">حذف نهائي</button>' : ''}
        </div>
      </div>

      <div class="card">
        <h3>الإجازات</h3>
        ${myLeaves.length ? `<ul class="list">${myLeaves.map((l) => `<li>
          <span>${formatHijri(l.start_date)} — ${formatHijri(l.end_date)}${l.reason ? `<br><span class="small muted">${escapeHtml(l.reason)}</span>` : ''}</span>
          <button type="button" class="btn btn-sm btn-ghost" data-del-leave="${l.id}">حذف</button></li>`).join('')}</ul>`
          : '<p class="muted">لا توجد إجازات.</p>'}
      </div>

      <div class="card">
        <h3>سجل القراءة</h3>
        ${pastRows ? `<ul class="list">${pastRows}</ul>` : '<p class="muted">لا توجد قراءات سابقة.</p>'}
      </div>

      <div class="card">
        <h3>سجل الحالة</h3>
        ${historyRows ? `<ul class="list">${historyRows}</ul>` : '<p class="muted">لا يوجد سجل.</p>'}
      </div>`;

    const refresh = () => renderMemberDetail(view, memberId);

    view.querySelector('#act-edit').addEventListener('click', () => {
      const { overlay, close } = openModal('تعديل بيانات العضو', `
        <form id="edit-form">
          <div class="field"><label>الاسم الكامل</label><input class="input" id="ef-name" value="${escapeHtml(m.full_name)}" /></div>
          <div class="field"><label>رقم الجوال</label><input class="input" id="ef-phone" inputmode="numeric" value="${escapeHtml(m.phone || '')}" dir="ltr" style="text-align:left" /></div>
          <button type="submit" class="btn btn-primary btn-block">حفظ</button>
        </form>`);
      overlay.querySelector('#edit-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const full_name = overlay.querySelector('#ef-name').value.trim();
        const phone = normalizeSaudiPhone(overlay.querySelector('#ef-phone').value);
        if (!full_name || !phone) return toast('أدخل الاسم ورقم جوال صحيح', 'error');
        try {
          await callManageUsers('update_profile', { id: memberId, full_name, phone });
          toast('تم الحفظ', 'ok'); close(); refresh();
        } catch (err) { toast(err.message, 'error'); }
      });
    });

    view.querySelector('#act-pin').addEventListener('click', () => {
      const { overlay, close } = openModal('إعادة تعيين الرقم السري', `
        <form id="pin-form">
          <div class="field"><label>الرقم السري الجديد (4 أرقام)</label>
            <input class="input" id="pf-pin" type="password" inputmode="numeric" maxlength="4" dir="ltr" style="text-align:left;letter-spacing:6px" /></div>
          <button type="submit" class="btn btn-primary btn-block">تعيين</button>
        </form>`);
      overlay.querySelector('#pin-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const pin = normalizePin(overlay.querySelector('#pf-pin').value);
        if (!pin) return toast('الرقم السري يجب أن يكون 4 أرقام', 'error');
        try {
          await callManageUsers('reset_pin', { member_id: memberId, pin });
          toast('تم تعيين الرقم السري', 'ok'); close();
        } catch (err) { toast(err.message, 'error'); }
      });
    });

    const setStatus = async (status, note) => {
      try {
        await callManageUsers('set_status', { id: memberId, status, note });
        toast('تم تحديث الحالة', 'ok'); refresh();
      } catch (err) { toast(err.message, 'error'); }
    };
    view.querySelector('#act-suspend')?.addEventListener('click', () => setStatus('suspended', 'suspended_by_admin'));
    view.querySelector('#act-activate')?.addEventListener('click', () => setStatus('active', 'reactivated'));
    view.querySelector('#act-exclude')?.addEventListener('click', () => {
      if (confirm('استبعاد هذا العضو؟ سيُحفظ سجل قراءته ويمكن استعادته لاحقًا.')) setStatus('excluded', 'excluded_by_admin');
    });
    view.querySelector('#act-restore')?.addEventListener('click', () => setStatus('active', 'restored'));

    view.querySelector('#act-delete')?.addEventListener('click', async () => {
      if (!confirm('حذف نهائي لهذا العضو وكل سجلاته؟ لا يمكن التراجع.')) return;
      try {
        await callManageUsers('delete_user', { id: memberId });
        toast('تم الحذف النهائي', 'ok');
        location.hash = '#/admin/members';
      } catch (err) { toast(err.message, 'error'); }
    });

    view.querySelector('#act-leave').addEventListener('click', () => {
      const { overlay, close } = openModal('منح إجازة', `
        <form id="leave-form">
          <div class="field"><label>من تاريخ</label><input class="input" id="lf-from" type="date" value="${today}" /></div>
          <div class="field"><label>إلى تاريخ</label><input class="input" id="lf-to" type="date" value="${today}" /></div>
          <p class="small muted" id="lf-hijri"></p>
          <div class="field"><label>السبب (اختياري)</label><input class="input" id="lf-reason" /></div>
          <button type="submit" class="btn btn-primary btn-block">منح الإجازة</button>
        </form>`);
      const updateHijri = () => {
        const from = overlay.querySelector('#lf-from').value;
        const to = overlay.querySelector('#lf-to').value;
        overlay.querySelector('#lf-hijri').textContent =
          from && to ? `بالتقويم الهجري: من ${formatHijri(from)} إلى ${formatHijri(to)}` : '';
      };
      overlay.querySelector('#lf-from').addEventListener('change', updateHijri);
      overlay.querySelector('#lf-to').addEventListener('change', updateHijri);
      updateHijri();
      overlay.querySelector('#leave-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const start_date = overlay.querySelector('#lf-from').value;
        const end_date = overlay.querySelector('#lf-to').value;
        const reason = overlay.querySelector('#lf-reason').value.trim() || null;
        if (!start_date || !end_date || end_date < start_date) return toast('تحقق من التاريخين', 'error');
        const { error } = await supabase.from('leaves').insert({
          member_id: memberId, start_date, end_date, reason, created_by: state.profile.id
        });
        if (error) return toast(error.message, 'error');
        await logActivity('grant_leave', 'profile', memberId, { start_date, end_date });
        toast('تم منح الإجازة', 'ok'); close(); refresh();
      });
    });

    view.querySelectorAll('[data-del-leave]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('حذف هذه الإجازة؟')) return;
      await supabase.from('leaves').delete().eq('id', b.dataset.delLeave);
      refresh();
    }));
  } catch (e) {
    view.innerHTML = `<div class="card center"><p>حدث خطأ: ${escapeHtml(e.message)}</p></div>`;
  }
}

// ---------------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------------
export async function renderBooks(view) {
  view.innerHTML = '<p class="muted center">جارٍ التحميل…</p>';
  try {
    const book = await fetchActiveBook();
    const settingsRes = await supabase.from('app_settings').select('*').eq('id', 1).single();
    const settings = settingsRes.data;
    const bookDraft = readBookDraft();

    view.innerHTML = `
      <div class="card">
        <h2>الكتاب الحالي</h2>
        ${book ? `
          <p><strong>${escapeHtml(book.title)}</strong>${book.author ? ` — ${escapeHtml(book.author)}` : ''}</p>
          <p class="muted small">
            الصفحات: ${book.start_page} — ${book.end_page ?? '…'} · ${book.daily_pages} صفحات يوميًا
            · الحالة: ${book.is_paused ? 'متوقف مؤقتًا' : 'نشط'}
          </p>
          <p class="small muted">عند الانتهاء استخدم «استبدال ملف PDF»؛ هذا النظام مخصص لكتاب واحد.</p>
          <div class="row">
            <button type="button" class="btn btn-sm" id="bk-toggle-pause">${book.is_paused ? 'استئناف القراءة' : 'إيقاف مؤقت'}</button>
            <button type="button" class="btn btn-sm" id="bk-edit">تعديل</button>
            <button type="button" class="btn btn-sm" id="bk-replace">استبدال ملف PDF</button>
            <input type="file" id="bk-replace-file" accept=".pdf,application/pdf" hidden />
          </div>
        ` : '<p class="muted">لم يُضف كتاب بعد.</p>'}
      </div>

      ${!book ? `
      <div class="card">
        <h2>إضافة كتاب</h2>
        <form id="book-form" autocomplete="off">
          <div class="field"><label>عنوان الكتاب</label><input class="input" id="bf-title" value="${escapeHtml(bookDraft.title)}" /></div>
          <div class="field"><label>المؤلف (اختياري)</label><input class="input" id="bf-author" value="${escapeHtml(bookDraft.author)}" /></div>
          <div class="field">
            <label>ملف PDF</label>
            <div class="row">
              <input class="file-input-hidden" id="bf-file" type="file" accept=".pdf,application/pdf" />
              <label class="btn btn-primary file-picker-label" for="bf-file">اختيار ملف PDF</label>
              <span class="small muted" id="bf-file-status" aria-live="polite" dir="auto">${pendingBookFile ? `تم اختيار: ${escapeHtml(pendingBookFile.name)}` : 'اضغط لاختيار ملف PDF'}</span>
            </div>
          </div>
          <div class="field"><label>صفحات يوميًا (اقتراح تلقائي للنطاق)</label><input class="input" id="bf-daily" type="number" min="1" value="${escapeHtml(bookDraft.daily_pages)}" /></div>
          <p class="small muted">لا تُنشر القراءة تلقائيًا. بعد إضافة الكتاب تُحدَّد الصفحات ثم يضغط المشرف «نشر القراءة».</p>
          <button type="submit" class="btn btn-primary btn-block">حفظ الكتاب</button>
          <p class="small" id="bf-save-status" aria-live="polite"></p>
        </form>
      </div>` : ''}

      ${book ? `
      <div class="card">
        <h2>نشر قراءة</h2>
        <div class="field"><label>تاريخ القراءة</label><input class="input" id="ov-date" type="date" value="${riyadhToday()}" />
          <p class="small muted" id="ov-hijri"></p></div>
        <p class="small muted">اضغط على صفحة البداية ثم صفحة النهاية. سيُقترح النطاق التالي من إعدادات الكتاب؛ لا تظهر القراءة للأعضاء حتى تضغط «نشر القراءة». الصفحات قبل البداية تظهر باهتة لأنها متجاوزة عمدًا.</p>
        <div id="ov-status" class="small" style="margin-bottom:8px"></div>
        <div class="page-grid" id="ov-grid"></div>
        <div class="row" style="margin-top:12px">
          <button type="button" class="btn btn-primary" id="ov-open-publish" aria-expanded="false" aria-controls="ov-publish-options">نشر القراءة</button>
          <button type="button" class="btn" id="ov-clear">مسح التحديد</button>
        </div>

        <div id="ov-publish-options" hidden>
          <div class="publication-options">
            <h3>معلومات إضافية للمنشور</h3>
            <div class="field"><label>رقم مقدار اليوم</label>
              <input class="input" id="ov-day-number" type="number" min="1" step="1" value="1" />
              <p class="small muted" id="ov-next-day-hint"></p></div>
            <div class="field"><label>من قوله (اختياري)</label><input class="input" id="ov-from-quote" /></div>
            <div class="field"><label>إلى قوله (اختياري)</label><input class="input" id="ov-to-quote" /></div>
            <button type="button" class="btn btn-primary btn-block" id="ov-publish">نشر القراءة</button>
          </div>
        </div>

        <details class="compact-disclosure">
          <summary><span>لا يوجد قراءة لهذا اليوم</span><span class="small muted" id="nr-status">إعداد اختياري</span></summary>
          <div class="disclosure-body">
            <label class="row" style="gap:8px"><input type="checkbox" id="nr-check" /> <span>تسجيل اليوم بلا قراءة</span></label>
            <div class="field" style="margin-top:8px"><label>السبب (اختياري)</label><input class="input" id="nr-reason" /></div>
            <button type="button" class="btn" id="nr-save">حفظ حالة اليوم</button>
          </div>
        </details>
      </div>` : ''}

      <div class="card compact-settings-card">
        <details class="compact-disclosure">
          <summary><span>إعدادات القراءة</span><span class="small muted">إعدادات متقدمة</span></summary>
          <div class="disclosure-body">
            <div class="field"><label>الحد الأدنى لبقاء الصفحة معروضة (بالثواني)</label>
              <input class="input" id="set-seconds" type="number" min="0" value="${settings?.min_page_seconds ?? 60}" /></div>
            <button type="button" class="btn btn-primary" id="set-save">حفظ الإعدادات</button>
          </div>
        </details>
      </div>`;

    const bookForm = view.querySelector('#book-form');
    const bookFileInput = view.querySelector('#bf-file');
    const bookFileStatus = view.querySelector('#bf-file-status');
    const bookSaveStatus = view.querySelector('#bf-save-status');
    const persistDraft = () => saveBookDraft(view);
    if (bookForm) {
      bookForm.addEventListener('input', persistDraft);
      bookForm.addEventListener('change', persistDraft);
      bookFileInput.addEventListener('change', () => {
        pendingBookFile = bookFileInput.files?.item(0) || null;
        bookFileStatus.textContent = pendingBookFile
          ? `تم اختيار: ${pendingBookFile.name}`
          : 'اضغط لاختيار ملف PDF';
        persistDraft();
      });
    }

    // Hijri hint for the selected date; it is only a display, not the publication timestamp.
    const bindHijri = (inputId, hintId) => {
      const inp = view.querySelector('#' + inputId);
      const hint = view.querySelector('#' + hintId);
      const upd = () => { hint.textContent = inp.value ? `بالتقويم الهجري: ${formatHijri(inp.value)}` : ''; };
      inp.addEventListener('change', upd); upd();
    };
    if (book) bindHijri('ov-date', 'ov-hijri');

    view.querySelector('#set-save').addEventListener('click', async () => {
      const secs = parseInt(view.querySelector('#set-seconds').value, 10);
      if (isNaN(secs) || secs < 0) return toast('أدخل عددًا صحيحًا', 'error');
      const { error } = await supabase.from('app_settings').update({ min_page_seconds: secs }).eq('id', 1);
      if (error) return toast(error.message, 'error');
      await logActivity('update_settings', 'app_settings', 1, { min_page_seconds: secs });
      toast('تم حفظ الإعدادات', 'ok');
    });

    if (book) {
      view.querySelector('#bk-toggle-pause').addEventListener('click', async () => {
        const { error } = await supabase.from('books').update({ is_paused: !book.is_paused }).eq('id', book.id);
        if (error) return toast(error.message, 'error');
        await logActivity(book.is_paused ? 'resume_book' : 'pause_book', 'book', book.id, {});
        renderBooks(view);
      });

      view.querySelector('#bk-edit').addEventListener('click', () => {
        const { overlay, close } = openModal('تعديل الكتاب', `
          <form id="be-form">
            <div class="field"><label>العنوان</label><input class="input" id="be-title" value="${escapeHtml(book.title)}" /></div>
            <div class="field"><label>المؤلف</label><input class="input" id="be-author" value="${escapeHtml(book.author || '')}" /></div>
            <div class="field"><label>صفحات يوميًا</label><input class="input" id="be-daily" type="number" min="1" value="${book.daily_pages}" /></div>
            <button type="submit" class="btn btn-primary btn-block">حفظ</button>
          </form>`);
        overlay.querySelector('#be-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const { error } = await supabase.from('books').update({
            title: overlay.querySelector('#be-title').value.trim(),
            author: overlay.querySelector('#be-author').value.trim() || null,
            daily_pages: parseInt(overlay.querySelector('#be-daily').value, 10)
          }).eq('id', book.id);
          if (error) return toast(error.message, 'error');
          await logActivity('update_book', 'book', book.id, {});
          toast('تم الحفظ', 'ok'); close(); renderBooks(view);
        });
      });

      view.querySelector('#bk-replace').addEventListener('click', () => view.querySelector('#bk-replace-file').click());
      view.querySelector('#bk-replace-file').addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (!isPdfFile(file)) {
          toast('اختر ملفًا بصيغة PDF', 'error');
          e.target.value = '';
          return;
        }

        let uploadedPath = null;
        let cleanupAfterDbError = false;
        let stage = 'فحص ملف PDF';
        try {
          const pageCount = await countPdfPages(file);
          const path = newPdfStoragePath(`${book.id}/`);
          stage = 'رفع ملف PDF إلى التخزين الخاص';
          const { error: upErr } = await supabase.storage.from('books').upload(path, file, {
            cacheControl: '3600', contentType: 'application/pdf', upsert: false
          });
          if (upErr) throw upErr;
          uploadedPath = path;

          stage = 'تحديث سجل الكتاب';
          const { error } = await supabase.from('books').update({
            storage_path: path, file_name: file.name, page_count: pageCount,
            start_page: 1, end_page: pageCount
          }).eq('id', book.id);
          if (error) {
            cleanupAfterDbError = Boolean(error.code || error.status);
            throw error;
          }

          const previousPath = book.storage_path;
          uploadedPath = null;
          if (previousPath && previousPath !== path) {
            const { error: removeError } = await supabase.storage.from('books').remove([previousPath]);
            if (removeError) console.warn('[مِداد] تعذر حذف نسخة PDF السابقة:', removeError.message);
          }
          await logActivity('replace_book_pdf', 'book', book.id, { file_name: file.name });
          toast('تم استبدال ملف PDF', 'ok');
          await renderBooks(view);
        } catch (err) {
          if (uploadedPath && cleanupAfterDbError) {
            try {
              const { error: cleanupError } = await supabase.storage.from('books').remove([uploadedPath]);
              if (cleanupError) console.warn('[مِداد] تعذر تنظيف ملف PDF غير المرتبط:', cleanupError.message);
            } catch (cleanupError) {
              console.warn('[مِداد] تعذر تنظيف ملف PDF غير المرتبط:', cleanupError);
            }
          }
          console.error('[مِداد] فشل استبدال ملف PDF:', stage, err);
          toast(bookFileError(stage, err), 'error');
        } finally {
          e.target.value = '';
        }
      });

      await setupPagePicker(view, book);
    }

    if (bookForm) bookForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = view.querySelector('#bf-title').value.trim();
      const author = view.querySelector('#bf-author').value.trim() || null;
      const file = pendingBookFile || bookFileInput.files?.item(0) || null;
      const daily_pages = parseInt(view.querySelector('#bf-daily').value, 10);
      const start_date = riyadhToday();
      if (!title) return toast('أدخل عنوان الكتاب', 'error');
      if (!file) return toast('اضغط «اختيار ملف PDF» وحدد الملف أولًا.', 'error');
      if (!isPdfFile(file)) return toast('الملف المحدد ليس بصيغة PDF', 'error');
      if (!Number.isInteger(daily_pages) || daily_pages < 1) return toast('عدد الصفحات اليومية غير صحيح', 'error');

      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'جارٍ الرفع…';
      bookSaveStatus.textContent = 'جارٍ التحقق من ملف PDF ورفعه…';
      let uploadedPath = null;
      let cleanupAfterDbError = false;
      let stage = 'فحص ملف PDF';
      try {
        const pageCount = await countPdfPages(file);
        const path = newPdfStoragePath();
        stage = 'رفع ملف PDF إلى التخزين الخاص';
        const { error: upErr } = await supabase.storage.from('books').upload(path, file, {
          cacheControl: '3600', contentType: 'application/pdf', upsert: false
        });
        if (upErr) throw upErr;
        uploadedPath = path;

        stage = 'حفظ بيانات الكتاب';
        const { data, error } = await supabase.from('books').insert({
          title, author, storage_path: path, file_name: file.name, page_count: pageCount,
          start_page: 1, end_page: pageCount, daily_pages, start_date, created_by: state.profile.id
        }).select().single();
        if (error) {
          cleanupAfterDbError = Boolean(error.code || error.status);
          throw error;
        }
        if (!data?.id) throw new Error('لم يصل تأكيد حفظ الكتاب من قاعدة البيانات؛ احتفظت ببياناتك للمحاولة التالية.');
        uploadedPath = null;
        await logActivity('add_book', 'book', data.id, { title });
        clearBookDraft();
        toast('تمت إضافة الكتاب بنجاح', 'ok');
        await renderBooks(view);
      } catch (err) {
        if (uploadedPath && cleanupAfterDbError) {
          try {
            const { error: cleanupError } = await supabase.storage.from('books').remove([uploadedPath]);
            if (cleanupError) console.warn('[مِداد] تعذر تنظيف ملف PDF غير المرتبط:', cleanupError.message);
          } catch (cleanupError) {
            console.warn('[مِداد] تعذر تنظيف ملف PDF غير المرتبط:', cleanupError);
          }
        }
        const message = bookFileError(stage, err);
        saveBookDraft(view);
        bookSaveStatus.textContent = message;
        console.error('[مِداد] فشل إضافة ملف الكتاب:', stage, err);
        toast(message, 'error');
        btn.disabled = false; btn.textContent = 'حفظ الكتاب';
      }
    });
  } catch (e) {
    view.innerHTML = `<div class="card center"><p>حدث خطأ: ${escapeHtml(e.message)}</p></div>`;
  }
}

function isPdfFile(file) {
  return Boolean(file && (
    file.type?.toLowerCase() === 'application/pdf' ||
    file.name?.toLowerCase().endsWith('.pdf')
  ));
}

function newPdfStoragePath(prefix = '') {
  const id = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}${id}.pdf`;
}

function bookFileError(stage, error) {
  const status = String(error?.statusCode ?? error?.status ?? '');
  const message = String(error?.message || error || 'خطأ غير معروف');
  if (status === '413' || /payload too large|entity too large|file.{0,20}too large|size limit/i.test(message)) {
    return 'حجم ملف PDF يتجاوز الحد المسموح به في مشروع Supabase.';
  }
  if (status === '401') return 'انتهت جلسة المشرف؛ سجّل الدخول مجددًا ثم حاول رفع الملف.';
  if (status === '403' || /row-level security|not authorized|permission denied/i.test(message)) {
    return 'رفضت صلاحيات Supabase رفع الملف أو حفظ بياناته. تأكد من الدخول بحساب مشرف نشط.';
  }
  return `تعذر ${stage}: ${message}`;
}

async function countPdfPages(file) {
  if (!file?.size) throw new Error('الملف فارغ.');
  try {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    if (!pdf.numPages) throw new Error('لم يعثر النظام على صفحات في الملف.');
    return pdf.numPages;
  } catch (error) {
    if (error?.name === 'PasswordException') {
      throw new Error('ملف PDF محمي بكلمة مرور؛ أزل الحماية قبل رفعه.');
    }
    if (error?.message === 'الملف فارغ.' || error?.message === 'لم يعثر النظام على صفحات في الملف.') throw error;
    throw new Error(`تعذر قراءة ملف PDF: ${error?.message || 'الملف تالف أو غير صالح'}`);
  }
}

async function setupPagePicker(view, book) {
  const grid = view.querySelector('#ov-grid');
  const dateInput = view.querySelector('#ov-date');
  const statusEl = view.querySelector('#ov-status');
  const dayNumberInput = view.querySelector('#ov-day-number');
  const dayNumberHint = view.querySelector('#ov-next-day-hint');
  const fromQuoteInput = view.querySelector('#ov-from-quote');
  const toQuoteInput = view.querySelector('#ov-to-quote');
  const openPublishButton = view.querySelector('#ov-open-publish');
  const publishOptions = view.querySelector('#ov-publish-options');
  const noReadingInput = view.querySelector('#nr-check');
  const noReadingReasonInput = view.querySelector('#nr-reason');
  const noReadingStatus = view.querySelector('#nr-status');
  const publishButton = view.querySelector('#ov-publish');
  let selStart = null;
  let selEnd = null;
  let pdf = null;
  let assignedRanges = [];

  async function loadPdf() {
    if (pdf) return;
    const { data: signed, error } = await supabase.storage.from('books').createSignedUrl(book.storage_path, 3600);
    if (error) throw error;
    if (!signed?.signedUrl) throw new Error('تعذر فتح ملف الكتاب');
    pdf = await pdfjsLib.getDocument({ url: signed.signedUrl }).promise;
  }

  function previousAssignment(date) {
    return assignedRanges
      .filter((a) => a.assignment_date < date && a.is_override && !a.is_no_reading)
      .sort((a, b) => b.assignment_date.localeCompare(a.assignment_date))[0] || null;
  }

  function suggestedRange(date) {
    const previous = previousAssignment(date);
    const start = previous ? Number(previous.end_page) + 1 : Number(book.start_page || 1);
    const total = Number(book.page_count || book.end_page || pdf?.numPages || 0);
    if (!Number.isInteger(start) || (total && start > total)) return { start: null, end: null };
    const pagesPerDay = Math.max(1, Number(book.daily_pages) || 1);
    const end = total ? Math.min(start + pagesPerDay - 1, total) : start + pagesPerDay - 1;
    return { start, end };
  }

  function suggestedDayNumber(date) {
    const previous = assignedRanges
      .filter((a) => a.assignment_date < date && a.is_override && !a.is_no_reading && Number.isInteger(Number(a.day_number)) && Number(a.day_number) > 0)
      .sort((a, b) => b.assignment_date.localeCompare(a.assignment_date))[0];
    return previous ? Number(previous.day_number) + 1 : 1;
  }

  function updateDayNumberHint() {
    const value = Number.parseInt(toWesternDigits(dayNumberInput.value), 10);
    dayNumberHint.textContent = Number.isInteger(value) && value > 0
      ? `بعد نشر مقدار اليوم ${arabicOrdinal(value)}، سيكون الرقم المقترح للقراءة التالية ${arabicOrdinal(value + 1)} (${toArabicDigits(value + 1)}). ويمكنك تغييره.`
      : 'أدخل رقم اليوم؛ سيُقترح الرقم التالي تلقائيًا بعد النشر.';
  }

  async function refresh() {
    const date = dateInput.value;
    if (!date) return;
    const { data: rows, error } = await supabase.from('assignments').select('*').eq('book_id', book.id);
    if (error) throw error;
    assignedRanges = rows || [];
    const existing = assignedRanges.find((a) => a.assignment_date === date);

    if (existing && !existing.is_no_reading) {
      selStart = existing.start_page;
      selEnd = existing.end_page;
    } else {
      const range = suggestedRange(date);
      selStart = range.start;
      selEnd = range.end;
    }

    noReadingInput.checked = Boolean(existing?.is_no_reading);
    noReadingReasonInput.value = existing?.is_no_reading ? (existing.no_reading_reason || '') : '';
    noReadingStatus.textContent = existing?.is_no_reading ? 'مفعّل لهذا التاريخ' : 'غير مفعّل';
    dayNumberInput.value = String(
      existing && !existing.is_no_reading && Number(existing.day_number) > 0
        ? existing.day_number
        : suggestedDayNumber(date)
    );
    fromQuoteInput.value = existing?.from_quote || '';
    toQuoteInput.value = existing?.to_quote || '';
    updateDayNumberHint();

    if (existing?.is_no_reading) {
      statusEl.textContent = 'هذا التاريخ مسجل بلا قراءة.';
    } else if (existing?.is_override) {
      statusEl.textContent = `قراءة منشورة: صفحات ${existing.start_page} — ${existing.end_page}. يمكن تعديلها ثم إعادة النشر.`;
    } else if (existing) {
      statusEl.textContent = `يوجد نطاق قديم لم يُنشر يدويًا: صفحات ${existing.start_page} — ${existing.end_page}. اضغط «نشر القراءة» لإظهاره للأعضاء.`;
    } else if (selStart != null && selEnd != null) {
      statusEl.textContent = `نطاق مقترح غير منشور: صفحات ${selStart} — ${selEnd}. لن يظهر للأعضاء حتى تضغط «نشر القراءة».`;
    } else {
      statusEl.textContent = 'لا توجد صفحات متبقية في الملف لتحديد نطاق جديد.';
    }
    drawGrid();
  }

  function isAssigned(page) {
    return assignedRanges.some((a) => a.is_override && !a.is_no_reading && page >= a.start_page && page <= a.end_page);
  }

  function drawGrid() {
    const total = book.page_count || pdf?.numPages || 0;
    if (!total) { grid.innerHTML = '<p class="muted">عدد صفحات PDF غير معروف بعد.</p>'; return; }
    let html = '';
    for (let p = 1; p <= total; p++) {
      const cls = ['page-card'];
      if (isAssigned(p)) cls.push('assigned');
      if (selStart != null && p < selStart) cls.push('skipped');
      if (p === selStart) cls.push('sel-start');
      if (p === selEnd) cls.push('sel-end');
      html += `<div class="${cls.join(' ')}" data-page="${p}">
        <button type="button" class="preview-btn" data-preview="${p}" title="معاينة">👁</button>
        <div class="num">${toArabicDigits(p)}</div>
      </div>`;
    }
    grid.innerHTML = html;
    grid.querySelectorAll('.page-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-preview]')) return;
        const page = Number.parseInt(card.dataset.page, 10);
        if (selStart == null || selEnd != null) {
          selStart = page;
          selEnd = null;
        } else if (page >= selStart) {
          selEnd = page;
        } else {
          selEnd = selStart;
          selStart = page;
        }
        statusEl.textContent = selEnd != null
          ? `النطاق المحدد وغير المنشور: صفحات ${selStart} — ${selEnd}`
          : `بداية النطاق: صفحة ${selStart}. اختر صفحة النهاية.`;
        drawGrid();
      });
    });
    grid.querySelectorAll('[data-preview]').forEach((button) => button.addEventListener('click', async (e) => {
      e.stopPropagation();
      const pageNumber = Number.parseInt(button.dataset.preview, 10);
      const { overlay } = openModal(`صفحة ${toArabicDigits(pageNumber)}`, '<p class="muted center">جارٍ التحميل…</p>');
      try {
        await loadPdf();
        const page = await pdf.getPage(pageNumber);
        const base = page.getViewport({ scale: 1 });
        const scale = 480 / base.width;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        overlay.querySelector('.modal-body').innerHTML = '';
        overlay.querySelector('.modal-body').appendChild(canvas);
      } catch (error) {
        overlay.querySelector('.modal-body').innerHTML = `<p class="center">تعذر العرض: ${escapeHtml(error.message)}</p>`;
      }
    }));
  }

  dateInput.addEventListener('change', () => refresh().catch((error) => toast('تعذر تحميل تخصيص التاريخ: ' + error.message, 'error')));
  dayNumberInput.addEventListener('input', updateDayNumberHint);
  openPublishButton.addEventListener('click', () => {
    publishOptions.hidden = false;
    openPublishButton.setAttribute('aria-expanded', 'true');
    publishOptions.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  view.querySelector('#ov-clear').addEventListener('click', () => {
    selStart = null;
    selEnd = null;
    drawGrid();
    statusEl.textContent = 'تم مسح التحديد؛ لن يُنشر شيء حتى تختار نطاقًا وتضغط «نشر القراءة».';
  });

  publishButton.addEventListener('click', async () => {
    const date = dateInput.value;
    if (!date) return toast('اختر تاريخ القراءة', 'error');
    if (noReadingInput.checked) return toast('أزل تحديد «لا يوجد قراءة» أو احفظ حالة اليوم بلا قراءة.', 'error');
    if (selStart == null || selEnd == null) return toast('حدد صفحة البداية والنهاية', 'error');
    const dayNumber = Number.parseInt(toWesternDigits(dayNumberInput.value), 10);
    if (!Number.isInteger(dayNumber) || dayNumber < 1) return toast('أدخل رقم اليوم بصيغة صحيحة', 'error');

    publishButton.disabled = true;
    publishButton.textContent = 'جارٍ النشر…';
    try {
      const { data, error } = await supabase.rpc('publish_assignment', {
        p_book_id: book.id,
        p_date: date,
        p_start_page: selStart,
        p_end_page: selEnd,
        p_day_number: dayNumber,
        p_from_quote: fromQuoteInput.value.trim() || null,
        p_to_quote: toQuoteInput.value.trim() || null
      });
      if (error) throw error;
      const published = Array.isArray(data) ? data[0] : data;
      if (!published?.id) throw new Error('لم يصل تأكيد نشر القراءة من قاعدة البيانات.');
      await logActivity('publish_reading', 'assignment', date, {
        start_page: selStart, end_page: selEnd, day_number: dayNumber
      });
      toast('تم نشر القراءة', 'ok');
      await refresh();
    } catch (error) {
      toast('تعذر نشر القراءة: ' + error.message, 'error');
    } finally {
      publishButton.disabled = false;
      publishButton.textContent = 'نشر القراءة';
    }
  });

  view.querySelector('#nr-save').addEventListener('click', async () => {
    const date = dateInput.value;
    const isNoReading = noReadingInput.checked;
    const reason = noReadingReasonInput.value.trim() || null;
    if (!date) return toast('اختر تاريخ القراءة', 'error');

    const existing = assignedRanges.find((assignment) => assignment.assignment_date === date);
    if (isNoReading) {
      if (existing && !existing.is_no_reading && !confirm('سيؤدي ذلك إلى استبدال القراءة المنشورة لهذا التاريخ بيوم بلا قراءة. هل تريد المتابعة؟')) return;
      const startPage = selStart ?? Number(book.start_page || 1);
      const endPage = selEnd ?? startPage;
      const { error } = await supabase.from('assignments').upsert({
        book_id: book.id,
        assignment_date: date,
        start_page: startPage,
        end_page: Math.max(startPage, endPage),
        published_at: new Date().toISOString(),
        is_override: true,
        is_no_reading: true,
        no_reading_reason: reason,
        created_by: state.profile.id,
        day_number: null,
        from_quote: null,
        to_quote: null
      }, { onConflict: 'book_id,assignment_date' });
      if (error) return toast('تعذر حفظ اليوم بلا قراءة: ' + error.message, 'error');
      await logActivity('no_reading_day', 'assignment', date, { reason });
      toast('تم تسجيل اليوم بلا قراءة', 'ok');
    } else {
      if (!existing?.is_no_reading) return toast('لا توجد حالة «لا يوجد قراءة» لإلغائها.', 'info');
      const { error } = await supabase.from('assignments').delete().eq('id', existing.id);
      if (error) return toast('تعذر إلغاء حالة اليوم: ' + error.message, 'error');
      await logActivity('clear_no_reading_day', 'assignment', date, {});
      toast('تم إلغاء حالة اليوم بلا قراءة', 'ok');
    }
    await refresh();
  });

  try { await loadPdf(); } catch { /* previews can retry; the page grid uses the stored page count */ }
  await refresh();
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
export async function renderReports(view) {
  view.innerHTML = '<p class="muted center">جارٍ التحميل…</p>';
  try {
    const today = riyadhToday();
    const book = await fetchActiveBook();
    const members = await fetchMembers();
    const activeMembers = members.filter((m) => m.status === 'active');

    view.innerHTML = `
      <div class="card">
        <h2>التقارير</h2>
        <div class="row">
          <div class="field grow"><label>تقرير يومي — التاريخ</label>
            <input class="input" id="rep-date" type="date" value="${today}" /></div>
          <button type="button" class="btn" id="rep-daily-btn">عرض</button>
          <button type="button" class="btn" id="rep-print">طباعة / حفظ PDF</button>
        </div>
        <p class="small muted" id="rep-hijri"></p>
        <div id="rep-output"></div>
      </div>
      <div class="card">
        <h3>التقرير الأسبوعي (آخر 7 أيام)</h3>
        <div id="rep-weekly"><p class="muted">جارٍ التحميل…</p></div>
      </div>
      <div class="card">
        <h3>نسبة التزام الأعضاء</h3>
        <div id="rep-commitment"><p class="muted">جارٍ التحميل…</p></div>
      </div>`;

    const dateInput = view.querySelector('#rep-date');
    const updHijri = () => {
      view.querySelector('#rep-hijri').textContent = dateInput.value ? `بالتقويم الهجري: ${formatHijri(dateInput.value)}` : '';
    };
    dateInput.addEventListener('change', updHijri); updHijri();

    view.querySelector('#rep-print').addEventListener('click', () => window.print());

    async function dailyReport() {
      const date = dateInput.value;
      if (!date || !book) return;
      const out = view.querySelector('#rep-output');
      out.innerHTML = '<p class="muted">جارٍ التحميل…</p>';
      const { data: assignment, error: assignmentError } = await supabase.from('assignments').select('*')
        .eq('book_id', book.id).eq('assignment_date', date).eq('is_override', true).maybeSingle();
      if (assignmentError) throw assignmentError;
      const [completions, leaves, sessions] = await Promise.all([fetchCompletions(), fetchLeaves(), fetchSessions()]);
      if (!assignment) {
        out.innerHTML = '<p class="muted">لم تُنشر قراءة لهذا التاريخ.</p>';
        return;
      }
      const now = new Date();
      let done = 0;
      const rows = activeMembers.map((m) => {
        const c = completions.find((x) => x.member_id === m.id && x.assignment_id === assignment.id);
        const s = sessions.find((x) => x.member_id === m.id && x.assignment_id === assignment.id);
        const leave = isOnLeave(leaves, m.id, date);
        const st = assignment.is_no_reading
          ? { label: 'لا قراءة', tone: 'muted' }
          : memberDayStatus({ assignment, completion: c, session: s, leave, now });
        if (st.key === 'done') done += 1;
        return `<tr><td>${escapeHtml(m.full_name)}</td>
          <td><span class="badge badge-${st.tone}">${st.label}</span></td>
          <td class="small muted">${st.time ? formatHijriTime(st.time) : '—'}</td></tr>`;
      }).join('');
      out.innerHTML = `
        <h3>تقرير ${formatHijri(date)}</h3>
        <p class="muted small">${escapeHtml(book.title)} — صفحات ${assignment.start_page} — ${assignment.end_page}
          · أكملوا: ${done} من ${activeMembers.length}</p>
        <table class="tbl"><thead><tr><th>العضو</th><th>الحالة</th><th>وقت الإكمال</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
    }
    view.querySelector('#rep-daily-btn').addEventListener('click', dailyReport);
    await dailyReport();

    // Weekly
    if (book) {
      const dates = [];
      for (let i = 6; i >= 0; i--) dates.push(addDays(today, -i));
      const allAssignments = await fetchAllAssignments(book.id);
      const weekAssignments = dates
        .map((date) => allAssignments.find((assignment) => assignment.assignment_date === date))
        .filter((assignment) => assignment?.is_override);
      const [completions, leaves] = await Promise.all([fetchCompletions(), fetchLeaves()]);
      const weeklyRows = activeMembers.map((m) => {
        const relevant = weekAssignments.filter((a) => !a.is_no_reading && !isOnLeave(leaves, m.id, a.assignment_date));
        const done = relevant.filter((a) => completions.some((c) => c.member_id === m.id && c.assignment_id === a.id && c.counts_as_completed)).length;
        return `<tr><td>${escapeHtml(m.full_name)}</td><td>${done} / ${relevant.length}</td></tr>`;
      }).join('');
      const totalExpected = activeMembers.length * weekAssignments.filter((a) => !a.is_no_reading).length;
      const totalDone = weekAssignments.filter((a) => !a.is_no_reading).reduce(
        (sum, a) => sum + completions.filter((c) => c.assignment_id === a.id && c.counts_as_completed && activeMembers.some((m) => m.id === c.member_id)).length, 0);
      view.querySelector('#rep-weekly').innerHTML = `
        <p class="muted small">تقدم المجموعة هذا الأسبوع: ${totalDone} من ${totalExpected} قراءة
          (${totalExpected ? Math.round((totalDone / totalExpected) * 100) : 0}%)</p>
        <table class="tbl"><thead><tr><th>العضو</th><th>قراءات مكتملة</th></tr></thead><tbody>${weeklyRows}</tbody></table>`;

      // Commitment
      const commitRows = activeMembers.map((m) => {
        const s = commitmentStats(allAssignments, completions, leaves, m.id, today);
        return `<tr><td>${escapeHtml(m.full_name)}</td><td>${s.pct}%</td><td>${s.done} / ${s.total}</td></tr>`;
      }).join('');
      view.querySelector('#rep-commitment').innerHTML =
        `<table class="tbl"><thead><tr><th>العضو</th><th>النسبة</th><th>الأيام</th></tr></thead><tbody>${commitRows}</tbody></table>`;
    }
  } catch (e) {
    view.innerHTML = `<div class="card center"><p>حدث خطأ: ${escapeHtml(e.message)}</p></div>`;
  }
}

// ---------------------------------------------------------------------------
// Activity logs
// ---------------------------------------------------------------------------
export async function renderLogs(view, isSuper) {
  view.innerHTML = '<p class="muted center">جارٍ التحميل…</p>';
  try {
    const { data: logs, error } = await supabase
      .from('activity_logs').select('*').order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    const actionLabels = {
      create_member: 'إضافة عضو', reset_pin: 'إعادة تعيين رقم سري', update_profile: 'تعديل بيانات',
      set_status: 'تغيير حالة', delete_user: 'حذف نهائي', create_assistant: 'إضافة مشرف مساعد',
      add_book: 'إضافة كتاب', update_book: 'تعديل كتاب', replace_book_pdf: 'استبدال PDF',
      pause_book: 'إيقاف الكتاب', resume_book: 'استئناف الكتاب', override_assignment: 'تخصيص صفحات',
      publish_reading: 'نشر قراءة', no_reading_day: 'يوم بلا قراءة', clear_no_reading_day: 'إلغاء يوم بلا قراءة',
      grant_leave: 'منح إجازة', update_settings: 'تعديل إعدادات', bootstrap_super_admin: 'تهيئة النظام'
    };
    const rows = (logs || []).map((l) => `<li>
      <span>${actionLabels[l.action] || escapeHtml(l.action)}
        <br><span class="small muted">${l.target_type ? escapeHtml(l.target_type) : ''} ${l.target_id ? escapeHtml(l.target_id) : ''}</span></span>
      <span class="small muted">${formatHijriTime(l.created_at)}</span></li>`).join('');
    view.innerHTML = `
      <div class="card">
        <h2>سجل النشاط</h2>
        <p class="muted small">${isSuper ? 'جميع العمليات الإدارية في النظام.' : 'عملياتك الإدارية.'}</p>
        ${rows ? `<ul class="list">${rows}</ul>` : '<p class="muted">لا يوجد نشاط مسجل بعد.</p>'}
      </div>`;
  } catch (e) {
    view.innerHTML = `<div class="card center"><p>حدث خطأ: ${escapeHtml(e.message)}</p></div>`;
  }
}
