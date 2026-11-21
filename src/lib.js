import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, PIN_SUFFIX, TIME_ZONE } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true, // remain logged in after closing the browser
    autoRefreshToken: true,
    detectSessionInUrl: false
  }
});

// ---------------------------------------------------------------------------
// Digits / phone / PIN normalization (Arabic-Indic, Persian, English)
// ---------------------------------------------------------------------------
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export function toWesternDigits(value) {
  if (value == null) return '';
  return String(value)
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)));
}

/** Normalize a Saudi mobile number to E.164 (+9665xxxxxxxx) or return null. */
export function normalizeSaudiPhone(raw) {
  let d = toWesternDigits(raw).replace(/[\s\-()]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('966')) {
    // already international
  } else if (d.startsWith('0')) {
    d = '966' + d.slice(1);
  } else if (d.startsWith('5')) {
    d = '966' + d;
  }
  if (!/^9665\d{8}$/.test(d)) return null;
  return '+' + d;
}

/** Validate a 4-digit PIN (leading zeros preserved) or return null. */
export function normalizePin(raw) {
  const d = toWesternDigits(raw).replace(/\D/g, '');
  return /^\d{4}$/.test(d) ? d : null;
}

export function pinToPassword(pin) {
  return pin + PIN_SUFFIX;
}

// ---------------------------------------------------------------------------
// Dates & time — stored as Gregorian ISO, displayed in Hijri (Umm al-Qura),
// always in the Asia/Riyadh timezone. Times use 12-hour format with ص / م.
// ---------------------------------------------------------------------------
export function riyadhToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Midnight of a YYYY-MM-DD date in Asia/Riyadh (UTC+3, no DST) as ISO string. */
export function riyadhMidnightISO(dateStr) {
  return new Date(dateStr + 'T00:00:00+03:00').toISOString();
}

const hijriDateFmt = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura', {
  timeZone: TIME_ZONE, day: 'numeric', month: 'long', year: 'numeric'
});
const hijriTimeFmt = new Intl.DateTimeFormat('ar-SA', {
  timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit', hour12: true
});

export function formatHijri(input) {
  if (!input) return '—';
  return hijriDateFmt.format(new Date(input));
}

export function formatHijriTime(input) {
  if (!input) return '—';
  const d = new Date(input);
  return `${hijriDateFmt.format(d)} — ${hijriTimeFmt.format(d)}`;
}

export function formatTime(input) {
  if (!input) return '—';
  return hijriTimeFmt.format(new Date(input));
}

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function toast(message, tone = 'info') {
  const wrap = document.getElementById('toast-wrap') || (() => {
    const el = document.createElement('div');
    el.id = 'toast-wrap';
    document.body.appendChild(el);
    return el;
  })();
  const el = document.createElement('div');
  el.className = `toast toast-${tone}`;
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

export function openModal(title, bodyHtml) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <strong>${escapeHtml(title)}</strong>
        <button type="button" class="btn btn-ghost btn-sm" data-close>إغلاق</button>
      </div>
      <div class="modal-body">${bodyHtml}</div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('[data-close]').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  return { overlay, close };
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------
export async function callManageUsers(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke('manage-users', {
    body: { action, ...payload }
  });
  if (error) {
    // Fetch errors usually mean a network/CORS failure; retain the underlying
    // browser error in the console so it can be diagnosed without exposing it
    // as an English SDK message to the user.
    if (error.name === 'FunctionsFetchError') {
      console.error('[مِداد] تعذّر الاتصال بدالة manage-users:', error.context);
      const networkError = new Error('تعذّر الاتصال بخدمة الحسابات ولم يصل رد يؤكد إتمام العملية. تحقّق من الاتصال قبل إعادة المحاولة.');
      networkError.code = 'manage_users_fetch';
      throw networkError;
    }

    let msg = error.message || 'تعذر تنفيذ العملية';
    let diagnosticCode = null;
    try {
      const ctx = await error.context.json();
      if (ctx?.error) msg = ctx.error;
      if (ctx?.reason) {
        const labels = {
          service_key_rejected: 'رفض Supabase مفتاح خدمة الحسابات',
          database_permission_denied: 'صلاحية قراءة قاعدة البيانات مرفوضة',
          rest_endpoint_not_found: 'مسار REST غير موجود',
          database_api_error: 'فشل استعلام قاعدة البيانات'
        };
        msg = `${labels[ctx.reason] || 'فشل فحص قاعدة البيانات'}${ctx.upstream_status ? ` (HTTP ${ctx.upstream_status})` : ''}`;
        diagnosticCode = 'manage_users_backend';
      }
    } catch { /* keep default message */ }
    const operationError = new Error(msg);
    if (diagnosticCode) operationError.code = diagnosticCode;
    throw operationError;
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function logActivity(action, targetType, targetId, details) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  await supabase.from('activity_logs').insert({
    actor_id: user.id,
    action,
    target_type: targetType || null,
    target_id: targetId != null ? String(targetId) : null,
    details: details || null
  });
}

export async function fetchActiveBook() {
  const { data, error } = await supabase
    .from('books').select('*').eq('is_active', true)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data;
}

export async function fetchTodayAssignment() {
  const { data, error } = await supabase.rpc('get_today_assignment');
  if (error) throw error;
  return data; // single assignment row or null
}

export async function fetchMembers() {
  const { data, error } = await supabase
    .from('profiles').select('*').eq('role', 'member')
    .order('full_name', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function fetchAllAssignments(bookId) {
  let q = supabase.from('assignments').select('*').order('assignment_date', { ascending: true });
  if (bookId) q = q.eq('book_id', bookId);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function fetchCompletions() {
  const { data, error } = await supabase.from('completions').select('*');
  if (error) throw error;
  return data || [];
}

export async function fetchLeaves() {
  const { data, error } = await supabase.from('leaves').select('*');
  if (error) throw error;
  return data || [];
}

export async function fetchSessions() {
  const { data, error } = await supabase.from('reading_sessions').select('*');
  if (error) throw error;
  return data || [];
}

export function isOnLeave(leaves, memberId, dateStr) {
  return (leaves || []).some(
    (l) => l.member_id === memberId && l.start_date <= dateStr && dateStr <= l.end_date
  );
}

/** Status of one member for one assignment. Returns { key, label, tone, time }. */
export function memberDayStatus({ assignment, completion, session, leave, now = new Date() }) {
  if (leave) return { key: 'leave', label: 'في إجازة', tone: 'muted' };
  if (completion?.counts_as_completed) {
    return { key: 'done', label: 'أكمل القراءة', tone: 'ok', time: completion.completed_at };
  }
  if (completion) {
    return { key: 'late_done', label: 'أكمل بعد المهلة', tone: 'muted', time: completion.completed_at };
  }
  const published = new Date(assignment.published_at);
  const deadline24 = new Date(published.getTime() + 24 * 3600 * 1000);
  const deadline48 = new Date(published.getTime() + 48 * 3600 * 1000);
  if (now > deadline48) return { key: 'missed', label: 'لم يقرأ اليوم', tone: 'danger' };
  if (now > deadline24) return { key: 'grace', label: 'لم يقرأ بعد — مهلة إضافية', tone: 'warn' };
  if (session && session.current_position > 0) return { key: 'reading', label: 'قيد القراءة', tone: 'info' };
  return { key: 'not_started', label: 'لم يبدأ القراءة', tone: 'muted' };
}

/** Consecutive missed reading days (excluding no-reading days and leave). */
export function consecutiveAbsence(assignments, completions, leaves, memberId, todayStr) {
  const sorted = [...(assignments || [])].sort((a, b) => b.assignment_date.localeCompare(a.assignment_date));
  let count = 0;
  for (const a of sorted) {
    if (a.assignment_date >= todayStr) continue;
    if (a.is_no_reading) continue;
    if (isOnLeave(leaves, memberId, a.assignment_date)) continue;
    const done = (completions || []).some(
      (c) => c.member_id === memberId && c.assignment_id === a.id && c.counts_as_completed
    );
    if (done) break;
    count += 1;
  }
  return count;
}

/** Commitment stats for one member up to (not including) today. */
export function commitmentStats(assignments, completions, leaves, memberId, todayStr) {
  const relevant = (assignments || []).filter(
    (a) => a.assignment_date < todayStr && !a.is_no_reading && !isOnLeave(leaves, memberId, a.assignment_date)
  );
  const done = relevant.filter((a) =>
    (completions || []).some((c) => c.member_id === memberId && c.assignment_id === a.id && c.counts_as_completed)
  ).length;
  return {
    done,
    total: relevant.length,
    pct: relevant.length ? Math.round((done / relevant.length) * 100) : 0
  };
}

export function printedPage(book, pdfPage) {
  if (!book || book.printed_page_offset == null) return null;
  return pdfPage + book.printed_page_offset;
}
