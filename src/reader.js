import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { supabase, toast, escapeHtml } from './lib.js';
import { state } from './main.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const TOO_FAST_MSG = 'صايدينك! 🧐 ما شاء الله تقرأ بسرعة الضوء؟ ارجع كمّل الصفحة لا تتحمس';
const PENDING_KEY = 'midad_pending_confirm';

function getPending() {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch { return null; }
}
function setPending(v) {
  try { v ? localStorage.setItem(PENDING_KEY, JSON.stringify(v)) : localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
}

export async function renderReader(view, assignmentId) {
  view.innerHTML = '<p class="muted center">جارٍ تحميل القارئ…</p>';
  let pdf = null;
  let assignment = null;
  let book = null;
  let session = null;
  let minSeconds = 60;
  let position = 0;       // index of the page currently displayed (0-based within assignment)
  let pageShownAt = Date.now();
  let rendering = false;

  const total = () => assignment.end_page - assignment.start_page + 1;

  async function load() {
    const [aRes, sRes] = await Promise.all([
      supabase.from('assignments').select('*').eq('id', assignmentId).single(),
      supabase.rpc('start_or_get_session', { p_assignment_id: assignmentId })
    ]);
    if (aRes.error) throw aRes.error;
    if (sRes.error) throw sRes.error;
    assignment = aRes.data;
    session = sRes.data;
    position = Math.min(session.current_position, total() - 1);

    const bRes = await supabase.from('books').select('*').eq('id', assignment.book_id).single();
    if (bRes.error) throw bRes.error;
    book = bRes.data;

    const setRes = await supabase.from('app_settings').select('min_page_seconds').eq('id', 1).maybeSingle();
    if (setRes.data) minSeconds = setRes.data.min_page_seconds;

    const { data: signed, error: signErr } = await supabase.storage
      .from('books').createSignedUrl(book.storage_path, 3600);
    if (signErr || !signed?.signedUrl) throw new Error('تعذر فتح ملف الكتاب');

    pdf = await pdfjsLib.getDocument({ url: signed.signedUrl }).promise;
    draw();
  }

  function draw() {
    const pdfPage = assignment.start_page + position;
    const remaining = total() - session.current_position;
    view.innerHTML = `
      <div class="reader-wrap">
        <div class="row-between">
          <div>
            <strong>${escapeHtml(book.title)}</strong>
            <div class="small muted">
              صفحة PDF ${pdfPage} · التقدم: ${session.current_position} من ${total()}
            </div>
          </div>
          <a class="btn btn-sm" href="#/member">رجوع</a>
        </div>
        <div class="reader-canvas-box" id="canvas-box" style="margin-top:10px">
          <canvas id="page-canvas"></canvas>
        </div>
        <div id="reader-msg"></div>
        <div class="reader-bar">
          <button type="button" class="btn" id="prev-btn" ${position === 0 ? 'disabled' : ''}>السابق</button>
          <span class="small muted">المتبقي: ${remaining} ${remaining === 1 ? 'صفحة' : 'صفحات'}</span>
          <button type="button" class="btn btn-primary" id="next-btn">${position === total() - 1 ? 'إنهاء القراءة' : 'التالي'}</button>
        </div>
      </div>`;

    renderCurrentPage();
    pageShownAt = Date.now();

    view.querySelector('#prev-btn').addEventListener('click', () => {
      if (position > 0) { position -= 1; draw(); }
    });
    view.querySelector('#next-btn').addEventListener('click', onNext);

    // Swipe navigation (mobile)
    const box = view.querySelector('#canvas-box');
    let touchX = null;
    box.addEventListener('touchstart', (e) => { touchX = e.changedTouches[0].clientX; }, { passive: true });
    box.addEventListener('touchend', (e) => {
      if (touchX == null) return;
      const dx = e.changedTouches[0].clientX - touchX;
      touchX = null;
      if (Math.abs(dx) < 50) return;
      // RTL: swipe left = next, swipe right = previous
      if (dx < 0 && position < total() - 1) onNext();
      else if (dx > 0 && position > 0) { position -= 1; draw(); }
    }, { passive: true });
  }

  async function renderCurrentPage() {
    if (rendering) return;
    rendering = true;
    try {
      const canvas = view.querySelector('#page-canvas');
      if (!canvas) return;
      const pdfPage = assignment.start_page + position;
      const page = await pdf.getPage(pdfPage);
      const boxWidth = canvas.parentElement.clientWidth || window.innerWidth - 24;
      const base = page.getViewport({ scale: 1 });
      const scale = boxWidth / base.width;
      const viewport = page.getViewport({ scale });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    } catch (e) {
      toast('تعذر عرض الصفحة: ' + e.message, 'error');
    } finally {
      rendering = false;
    }
  }

  function showMsg(text) {
    const el = view.querySelector('#reader-msg');
    if (el) el.innerHTML = `<div class="reader-msg">${escapeHtml(text)}</div>`;
  }

  async function confirmCurrentPage() {
    // Server-side trusted verification: order + minimum duration via DB timestamps.
    const { data, error } = await supabase.rpc('confirm_page_view', {
      p_session_id: session.id, p_position: position
    });
    if (error) throw error;
    return data;
  }

  async function onNext() {
    const btn = view.querySelector('#next-btn');
    if (!btn || btn.disabled) return;

    // Already-confirmed page: just move forward without re-confirming.
    if (position < session.current_position) {
      position += 1;
      draw();
      return;
    }

    // Local pre-check so the message appears immediately; the server re-verifies.
    const elapsed = (Date.now() - pageShownAt) / 1000;
    if (elapsed < minSeconds) {
      showMsg(TOO_FAST_MSG);
      return;
    }

    btn.disabled = true;
    try {
      await confirmCurrentPage();
      setPending(null);
      session.current_position += 1;
      await supabase.from('reading_sessions').update({ last_activity_at: new Date().toISOString() }).eq('id', session.id);
      if (session.current_position >= total()) {
        await finishReading();
        return;
      }
      position += 1;
      draw();
    } catch (e) {
      const msg = String(e.message || '');
      if (msg.includes('too_fast')) {
        showMsg(TOO_FAST_MSG);
      } else if (msg.includes('wrong_order') || msg.includes('already_finished')) {
        // Re-sync with server state (e.g. after offline queue flush)
        const { data: fresh } = await supabase.from('reading_sessions').select('*').eq('id', session.id).single();
        if (fresh) session = fresh;
        draw();
      } else if (!navigator.onLine || msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
        // Offline: keep pending progress locally; it is NOT counted until the server confirms it.
        setPending({ session_id: session.id, position });
        showMsg('انقطع الاتصال — سيتم حفظ تقدمك ومزامنته عند عودة الاتصال.');
      } else {
        toast('تعذر الحفظ: ' + msg, 'error');
      }
      btn.disabled = false;
    }
  }

  async function finishReading() {
    try {
      const { data, error } = await supabase.rpc('complete_reading', { p_session_id: session.id });
      if (error) throw error;
      setPending(null);
      view.innerHTML = `
        <div class="reader-wrap">
          <div class="card center">
            ${data?.counts
              ? '<div class="success-box">تم تسجيل قراءة اليوم بنجاح.</div>'
              : '<div class="success-box" style="background:#fff7e6;border-color:var(--gold);color:#7a5b12">تمت القراءة بعد انتهاء المهلة — لم تُحتسب ضمن قراءة اليوم.</div>'}
            <p><a href="#/member">العودة للرئيسية</a> · <a href="#/member/history">سجل قراءتي</a></p>
          </div>
        </div>`;
    } catch (e) {
      toast('تعذر إنهاء القراءة: ' + e.message, 'error');
    }
  }

  // Flush any locally-pending confirmation when connectivity returns.
  async function flushPending() {
    const p = getPending();
    if (!p || !navigator.onLine) return;
    try {
      const { error } = await supabase.rpc('confirm_page_view', { p_session_id: p.session_id, p_position: p.position });
      if (!error) {
        setPending(null);
        toast('تمت مزامنة تقدمك المحفوظ', 'ok');
      }
    } catch { /* retry later */ }
  }
  window.addEventListener('online', flushPending);

  // Re-render on resize for crisp pages
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderCurrentPage, 250);
  });

  try {
    await load();
    flushPending();
  } catch (e) {
    view.innerHTML = `<div class="card center"><p>تعذر فتح القارئ: ${escapeHtml(e.message)}</p><p><a href="#/member">رجوع</a></p></div>`;
  }
}
