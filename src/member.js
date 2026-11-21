import {
  supabase, fetchActiveBook, fetchTodayAssignment, riyadhToday, formatHijri, formatHijriTime,
  formatHijriNumeric, arabicOrdinal, toArabicDigits,
  fetchAllAssignments, fetchCompletions, fetchLeaves, isOnLeave, commitmentStats, escapeHtml, toast
} from './lib.js';
import { state } from './main.js';

export async function renderMemberHome(view) {
  view.innerHTML = '<p class="muted center">جارٍ التحميل…</p>';
  try {
    const [book, assignment] = await Promise.all([fetchActiveBook(), fetchTodayAssignment()]);
    const today = riyadhToday();
    const me = state.profile.id;

    if (!book) {
      view.innerHTML = `<div class="card center"><h2>لا يوجد كتاب حاليًا</h2><p class="muted">لم تقم الإدارة بإضافة كتاب بعد.</p></div>`;
      return;
    }
    if (book.is_paused) {
      view.innerHTML = `<div class="card center"><h2>${escapeHtml(book.title)}</h2><p class="muted">القراءة متوقفة مؤقتًا.</p></div>`;
      return;
    }
    if (!assignment) {
      view.innerHTML = `<div class="card center"><h2>${escapeHtml(book.title)}</h2><p class="muted">لم تنشر الإدارة قراءة اليوم بعد.</p></div>`;
      return;
    }

    const [sessionRes, completionRes, leaves] = await Promise.all([
      supabase.from('reading_sessions').select('*').eq('member_id', me).eq('assignment_id', assignment.id).maybeSingle(),
      supabase.from('completions').select('*').eq('member_id', me).eq('assignment_id', assignment.id).maybeSingle(),
      fetchLeaves()
    ]);
    const session = sessionRes.data;
    const completion = completionRes.data;
    const onLeave = isOnLeave(leaves, me, assignment.assignment_date);
    const total = assignment.end_page - assignment.start_page + 1;
    const confirmed = session?.current_position || 0;
    const dayNumber = Number(assignment.day_number);
    const fromQuote = assignment.from_quote?.trim();
    const toQuote = assignment.to_quote?.trim();
    const hasReadingDayNumber = Number.isInteger(dayNumber) && dayNumber > 0;
    const assignmentDetails = assignment.is_no_reading
      ? ''
      : hasReadingDayNumber
        ? `<div class="reading-announcement">
            <strong class="reading-announcement-title">مقدار اليوم ${escapeHtml(arabicOrdinal(dayNumber))}</strong>
            <span class="reading-announcement-date">${formatHijriNumeric(assignment.assignment_date)}</span>
            <p>من ص${toArabicDigits(assignment.start_page)} إلى ص ${toArabicDigits(assignment.end_page)}</p>
            ${fromQuote ? `<p><strong>من قوله:</strong> ${escapeHtml(fromQuote)}</p>` : ''}
            ${toQuote ? `<p><strong>إلى قوله:</strong> ${escapeHtml(toQuote)}</p>` : ''}
          </div>`
        : `<p>صفحات اليوم: <strong>${assignment.start_page} — ${assignment.end_page}</strong>
            <span class="muted">(${total} ${total === 1 ? 'صفحة' : 'صفحات'})</span></p>`;

    let body = `
      <div class="card">
        ${hasReadingDayNumber && !assignment.is_no_reading ? '' : `<p class="muted small" style="margin:0">${formatHijri(assignment.assignment_date)}</p>`}
        <h2 style="margin-top:4px">${escapeHtml(book.title)}</h2>
        ${assignmentDetails}`;

    if (assignment.is_no_reading) {
      body += `
        <div class="success-box" style="background:#f0f0f0;border-color:var(--border);color:var(--ink)">
          لا يوجد قراءة لهذا اليوم
        </div>
        ${assignment.no_reading_reason ? `<p class="muted center">${escapeHtml(assignment.no_reading_reason)}</p>` : ''}`;
    } else if (onLeave) {
      body += `<div class="success-box" style="background:#f0f0f0;border-color:var(--border);color:var(--ink)">أنت في إجازة اليوم</div>`;
    } else if (completion?.counts_as_completed) {
      body += `
        <div class="success-box">تم تسجيل قراءة اليوم بنجاح.</div>
        <p class="muted center small">وقت الإكمال: ${formatHijriTime(completion.completed_at)}</p>`;
    } else if (completion) {
      body += `
        <div class="success-box" style="background:#fff7e6;border-color:var(--gold);color:#7a5b12">
          تمت القراءة، لكن بعد انتهاء المهلة فلم تُحتسب ضمن قراءة اليوم.
        </div>`;
    } else {
      const now = new Date();
      const published = new Date(assignment.published_at);
      const inGrace = now > new Date(published.getTime() + 24 * 3600 * 1000) && now <= new Date(published.getTime() + 48 * 3600 * 1000);
      const expired = now > new Date(published.getTime() + 48 * 3600 * 1000);
      let btnLabel = 'ابدأ القراءة';
      if (confirmed > 0 && confirmed < total) btnLabel = 'استكمل القراءة';
      if (confirmed >= total) btnLabel = 'إنهاء القراءة';

      body += `
        <div class="progress" style="margin:10px 0"><div style="width:${total ? Math.round((confirmed / total) * 100) : 0}%"></div></div>
        <p class="muted small center">أنجزت ${confirmed} من ${total} صفحات</p>
        ${expired ? '<p class="center small" style="color:var(--muted)">انتهت مهلة الاحتساب لهذا اليوم، لكن يمكنك القراءة للاستفادة الشخصية.</p>' : ''}
        ${inGrace ? '<p class="center small" style="color:var(--warn)">أنت في المهلة الإضافية — أكمل القراءة الآن لتُحتسب.</p>' : ''}
        <button type="button" class="btn btn-primary btn-block" id="start-reading">${btnLabel}</button>`;
    }

    body += `
      </div>
      <p class="center"><a href="#/member/history">سجل قراءتي</a></p>`;
    view.innerHTML = body;

    const btn = view.querySelector('#start-reading');
    if (btn) {
      btn.addEventListener('click', async () => {
        if (confirmed >= total) {
          btn.disabled = true; btn.textContent = 'جارٍ الحفظ…';
          try {
            const { data, error } = await supabase.rpc('complete_reading', { p_session_id: session.id });
            if (error) throw error;
            if (data?.counts) {
              view.innerHTML = `
                <div class="card center">
                  <div class="success-box">تم تسجيل قراءة اليوم بنجاح.</div>
                  <p><a href="#/member/history">سجل قراءتي</a></p>
                </div>`;
            } else {
              toast('تمت القراءة بعد انتهاء المهلة — لم تُحتسب ضمن قراءة اليوم');
              renderMemberHome(view);
            }
          } catch (e) {
            toast('تعذر الحفظ: ' + e.message, 'error');
            btn.disabled = false;
          }
          return;
        }
        location.hash = `#/read/${assignment.id}`;
      });
    }
  } catch (e) {
    view.innerHTML = `<div class="card center"><p>حدث خطأ: ${escapeHtml(e.message)}</p></div>`;
  }
}

export async function renderMemberHistory(view) {
  view.innerHTML = '<p class="muted center">جارٍ التحميل…</p>';
  try {
    const me = state.profile.id;
    const today = riyadhToday();
    const [book, assignments, completions, leaves] = await Promise.all([
      fetchActiveBook(), fetchAllAssignments(), fetchCompletions(), fetchLeaves()
    ]);
    const mine = completions.filter((c) => c.member_id === me);
    const stats = commitmentStats(assignments, mine, leaves, me, today);

    const past = [...assignments]
      .filter((a) => a.assignment_date < today)
      .sort((a, b) => b.assignment_date.localeCompare(a.assignment_date));

    const rows = past.map((a) => {
      const c = mine.find((x) => x.assignment_id === a.id);
      let status;
      if (a.is_no_reading) status = '<span class="badge badge-muted">لا قراءة</span>';
      else if (isOnLeave(leaves, me, a.assignment_date)) status = '<span class="badge badge-muted">إجازة</span>';
      else if (c?.counts_as_completed) status = `<span class="badge badge-ok">أكمل القراءة</span> <span class="small muted">${formatHijriTime(c.completed_at)}</span>`;
      else if (c) status = '<span class="badge badge-muted">أكمل بعد المهلة</span>';
      else status = '<span class="badge badge-danger">لم يقرأ</span>';
      return `<li>
        <span>${formatHijri(a.assignment_date)}<br><span class="small muted">صفحات ${a.start_page} — ${a.end_page}</span></span>
        <span>${status}</span>
      </li>`;
    }).join('');

    view.innerHTML = `
      <div class="card">
        <h2>سجل قراءتي</h2>
        <p class="muted">${escapeHtml(state.profile.full_name)} — انضممت ${formatHijri(state.profile.joined_at)}</p>
        <div class="stats">
          <div class="stat"><div class="num">${stats.pct}%</div><div class="lbl">نسبة الالتزام</div></div>
          <div class="stat"><div class="num">${stats.done}</div><div class="lbl">أيام قراءة مكتملة</div></div>
        </div>
      </div>
      <div class="card">
        <h3>القراءات السابقة</h3>
        ${rows ? `<ul class="list">${rows}</ul>` : '<p class="muted">لا توجد قراءات سابقة بعد.</p>'}
      </div>`;
  } catch (e) {
    view.innerHTML = `<div class="card center"><p>حدث خطأ: ${escapeHtml(e.message)}</p></div>`;
  }
}
