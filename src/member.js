import {
  supabase, fetchActiveBook, fetchTodayAssignment, riyadhToday, formatHijri, formatHijriTime,
  formatHijriNumeric, arabicOrdinal, toArabicDigits,
  fetchAllAssignments, fetchCompletions, fetchLeaves, isOnLeave, commitmentStats, escapeHtml, toast
} from './lib.js';
import { state } from './main.js';

function personalHistoryMarkup(profile, assignments, completions, leaves, today) {
  const memberId = profile.id;
  const mine = completions.filter((completion) => completion.member_id === memberId);
  const stats = commitmentStats(assignments, mine, leaves, memberId, today);
  const past = [...assignments]
    .filter((assignment) => assignment.assignment_date < today)
    .sort((a, b) => b.assignment_date.localeCompare(a.assignment_date));

  const rows = past.map((assignment) => {
    const completion = mine.find((item) => item.assignment_id === assignment.id);
    let status;
    if (assignment.is_no_reading) status = '<span class="badge badge-muted">لا قراءة</span>';
    else if (isOnLeave(leaves, memberId, assignment.assignment_date)) status = '<span class="badge badge-muted">إجازة</span>';
    else if (completion?.counts_as_completed) status = `<span class="badge badge-ok">أكمل القراءة</span> <span class="small muted">${formatHijriTime(completion.completed_at)}</span>`;
    else if (completion) status = '<span class="badge badge-muted">أكمل بعد المهلة</span>';
    else status = '<span class="badge badge-danger">لم يقرأ</span>';
    return `<li>
      <span>${formatHijri(assignment.assignment_date)}<br><span class="small muted">صفحات ${assignment.start_page} — ${assignment.end_page}</span></span>
      <span>${status}</span>
    </li>`;
  }).join('');

  return `
    <div class="card">
      <h2>سجل قراءتي</h2>
      <p class="muted">${escapeHtml(profile.full_name)} — انضممت ${formatHijri(profile.joined_at)}</p>
      <div class="stats">
        <div class="stat"><div class="num">${stats.pct}%</div><div class="lbl">نسبة الالتزام</div></div>
        <div class="stat"><div class="num">${stats.done}</div><div class="lbl">أيام قراءة مكتملة</div></div>
      </div>
    </div>
    <div class="card">
      <h3>القراءات السابقة</h3>
      ${rows ? `<ul class="list">${rows}</ul>` : '<p class="muted">لا توجد قراءات سابقة بعد.</p>'}
    </div>`;
}

export async function renderMemberHome(view) {
  await renderReadingHome(view, { includePersonalHistory: false });
}

export async function renderAssistantReading(view) {
  await renderReadingHome(view, { includePersonalHistory: true });
}

async function renderReadingHome(view, { includePersonalHistory }) {
  view.innerHTML = '<p class="muted center">جارٍ التحميل…</p>';
  try {
    const me = state.profile.id;
    const today = riyadhToday();
    const historyPromise = includePersonalHistory
      ? Promise.all([fetchAllAssignments(), fetchCompletions()])
      : Promise.resolve(null);
    const historyLeavesPromise = includePersonalHistory ? fetchLeaves() : Promise.resolve(null);
    const [book, assignment, historyData, historyLeaves] = await Promise.all([
      fetchActiveBook(), fetchTodayAssignment(), historyPromise, historyLeavesPromise
    ]);

    let body;
    let session = null;
    let confirmed = 0;
    let total = 0;

    if (!book) {
      body = '<div class="card center"><h2>لا يوجد كتاب حاليًا</h2><p class="muted">لم تقم الإدارة بإضافة كتاب بعد.</p></div>';
    } else if (book.is_paused) {
      body = `<div class="card center"><h2>${escapeHtml(book.title)}</h2><p class="muted">القراءة متوقفة مؤقتًا.</p></div>`;
    } else if (!assignment) {
      body = `<div class="card center"><h2>${escapeHtml(book.title)}</h2><p class="muted">لم تنشر الإدارة قراءة اليوم بعد.</p></div>`;
    } else {
      const [sessionRes, completionRes, leaves] = await Promise.all([
        supabase.from('reading_sessions').select('*').eq('member_id', me).eq('assignment_id', assignment.id).maybeSingle(),
        supabase.from('completions').select('*').eq('member_id', me).eq('assignment_id', assignment.id).maybeSingle(),
        includePersonalHistory ? Promise.resolve(historyLeaves) : fetchLeaves()
      ]);
      if (sessionRes.error) throw sessionRes.error;
      if (completionRes.error) throw completionRes.error;
      session = sessionRes.data;
      const completion = completionRes.data;
      const onLeave = isOnLeave(leaves, me, assignment.assignment_date);
      total = assignment.end_page - assignment.start_page + 1;
      confirmed = session?.current_position || 0;
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

      body = `
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
      body += '</div>';
    }

    if (includePersonalHistory) {
      const [assignments, completions] = historyData;
      body += personalHistoryMarkup(state.profile, assignments, completions, historyLeaves, today);
    } else {
      body += '<p class="center"><a href="#/member/history">سجل قراءتي</a></p>';
    }
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
              if (includePersonalHistory) {
                await renderAssistantReading(view);
              } else {
                view.innerHTML = `
                  <div class="card center">
                    <div class="success-box">تم تسجيل قراءة اليوم بنجاح.</div>
                    <p><a href="#/member/history">سجل قراءتي</a></p>
                  </div>`;
              }
            } else {
              toast('تمت القراءة بعد انتهاء المهلة — لم تُحتسب ضمن قراءة اليوم');
              if (includePersonalHistory) renderAssistantReading(view);
              else renderMemberHome(view);
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
    const today = riyadhToday();
    const [assignments, completions, leaves] = await Promise.all([
      fetchAllAssignments(), fetchCompletions(), fetchLeaves()
    ]);
    view.innerHTML = personalHistoryMarkup(state.profile, assignments, completions, leaves, today);
  } catch (e) {
    view.innerHTML = `<div class="card center"><p>حدث خطأ: ${escapeHtml(e.message)}</p></div>`;
  }
}
