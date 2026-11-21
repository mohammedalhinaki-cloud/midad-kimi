import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { supabase, toast, escapeHtml, toArabicDigits } from './lib.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const TOO_FAST_MSG = 'صايدينك! 🧐 ما شاء الله تقرأ بسرعة الضوء؟ ارجع كمّل الصفحة لا تتحمس.';
const PENDING_KEY = 'midad_pending_confirm';

function getPending() {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch { return null; }
}
function setPending(value) {
  try { value ? localStorage.setItem(PENDING_KEY, JSON.stringify(value)) : localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
}

export async function renderReader(view, assignmentId) {
  view.innerHTML = '<p class="muted center">جارٍ تحميل القارئ…</p>';
  let pdf = null;
  let assignment = null;
  let book = null;
  let session = null;
  let position = 0;
  let pageReady = false;
  let navigationInFlight = false;
  let finishing = false;
  let disposed = false;
  let renderVersion = 0;
  let renderTask = null;
  let lastRenderWidth = 0;
  let resizeTimer = null;
  let resizeHandler = null;
  let onlineHandler = null;
  let hashChangeHandler = null;
  let fullscreenHandler = null;

  const total = () => assignment.end_page - assignment.start_page + 1;

  function cleanup() {
    if (disposed) return;
    disposed = true;
    if (resizeTimer) clearTimeout(resizeTimer);
    try { renderTask?.cancel(); } catch { /* render may already have completed */ }
    renderTask = null;
    try {
      const destroyPromise = pdf?.destroy?.();
      if (destroyPromise?.catch) destroyPromise.catch(() => {});
    } catch { /* PDF teardown is best effort */ }
    if (resizeHandler) window.removeEventListener('resize', resizeHandler);
    if (onlineHandler) window.removeEventListener('online', onlineHandler);
    if (hashChangeHandler) window.removeEventListener('hashchange', hashChangeHandler);
    if (fullscreenHandler) document.removeEventListener('fullscreenchange', fullscreenHandler);
    document.body.classList.remove('reader-fallback-fullscreen');
    if (document.fullscreenElement === view) {
      try {
        const exitPromise = document.exitFullscreen?.();
        if (exitPromise?.catch) exitPromise.catch(() => {});
      } catch { /* fullscreen may already be closing */ }
    }
  }

  function showMsg(text) {
    const el = view.querySelector('#reader-msg');
    if (el) el.innerHTML = `<div class="reader-msg">${escapeHtml(text)}</div>`;
  }

  function updateNextAvailability() {
    const button = view.querySelector('#next-btn');
    if (!button) return;
    // Keep Next available at all times; the server decides whether enough time passed.
    button.disabled = false;
    button.setAttribute('aria-busy', String(navigationInFlight));
    if (navigationInFlight) button.title = 'جارٍ التحقق من الصفحة…';
    else button.removeAttribute('title');
  }

  function updateFullscreenButton() {
    const button = view.querySelector('#fullscreen-btn');
    if (!button) return;
    const active = document.fullscreenElement === view
      || document.body.classList.contains('reader-fallback-fullscreen');
    const label = button.querySelector('.fullscreen-label');
    if (label) label.textContent = active ? 'إنهاء ملء الشاشة' : 'ملء الشاشة';
    button.setAttribute('aria-pressed', String(active));
  }

  async function toggleFullscreen() {
    const fallbackActive = document.body.classList.contains('reader-fallback-fullscreen');
    if (document.fullscreenElement === view) {
      try { await document.exitFullscreen(); } catch { /* browser may exit via Esc */ }
    } else if (fallbackActive) {
      document.body.classList.remove('reader-fallback-fullscreen');
    } else {
      try {
        if (typeof view.requestFullscreen !== 'function') throw new Error('Fullscreen API unavailable');
        await view.requestFullscreen();
      } catch {
        document.body.classList.add('reader-fallback-fullscreen');
      }
    }
    updateFullscreenButton();
  }

  function cancelRender() {
    renderVersion += 1;
    try { renderTask?.cancel(); } catch { /* ignore */ }
    renderTask = null;
    return renderVersion;
  }

  function draw() {
    if (disposed || !assignment || !book || !session) return;
    const pageCount = total();
    if (pageCount <= 0) return;
    position = Math.max(0, Math.min(position, pageCount - 1));
    const pdfPage = assignment.start_page + position;
    const renderToken = cancelRender();
    pageReady = false;

    const remaining = Math.max(0, pageCount - session.current_position);
    view.innerHTML = `
      <div class="reader-wrap">
        <div class="row-between">
          <div>
            <strong>${escapeHtml(book.title)}</strong>
            <div class="small muted">
              صفحة PDF ${toArabicDigits(pdfPage)} · التقدم: ${toArabicDigits(session.current_position)} من ${toArabicDigits(pageCount)}
            </div>
          </div>
          <div class="row reader-actions">
            <button type="button" class="btn btn-sm" id="fullscreen-btn" aria-pressed="false">
              <span aria-hidden="true">⛶</span><span class="fullscreen-label">ملء الشاشة</span>
            </button>
            <a class="btn btn-sm" href="#/member">رجوع</a>
          </div>
        </div>
        <div class="reader-canvas-box" id="canvas-box" style="margin-top:10px">
          <canvas id="page-canvas" aria-label="صفحة الكتاب ${toArabicDigits(pdfPage)}"></canvas>
        </div>
        <div id="reader-msg" aria-live="polite"></div>
        <div class="reader-bar">
          <button type="button" class="btn" id="prev-btn" ${position === 0 ? 'disabled' : ''}>السابق</button>
          <span class="small muted">المتبقي: ${toArabicDigits(remaining)} ${remaining === 1 ? 'صفحة' : 'صفحات'}</span>
          <button type="button" class="btn btn-primary" id="next-btn">${position === pageCount - 1 ? 'إنهاء القراءة' : 'التالي'}</button>
        </div>
      </div>`;

    updateNextAvailability();
    updateFullscreenButton();
    void renderCurrentPage(renderToken, pdfPage);

    view.querySelector('#prev-btn').addEventListener('click', () => {
      if (navigationInFlight || position <= 0) return;
      position -= 1;
      draw();
    });
    view.querySelector('#next-btn').addEventListener('click', onNext);
    view.querySelector('#fullscreen-btn').addEventListener('click', () => void toggleFullscreen());

    const box = view.querySelector('#canvas-box');
    let touchX = null;
    box.addEventListener('touchstart', (event) => {
      touchX = event.changedTouches[0].clientX;
    }, { passive: true });
    box.addEventListener('touchend', (event) => {
      if (touchX == null) return;
      const deltaX = event.changedTouches[0].clientX - touchX;
      touchX = null;
      if (Math.abs(deltaX) < 50) return;
      // RTL: swipe left = next, swipe right = previous.
      if (deltaX < 0 && position < pageCount - 1) void onNext();
      else if (deltaX > 0 && position > 0 && !navigationInFlight) {
        position -= 1;
        draw();
      }
    }, { passive: true });
  }

  async function renderCurrentPage(renderToken, pdfPageNumber) {
    const canvas = view.querySelector('#page-canvas');
    if (!canvas || !pdf || disposed) return;
    try {
      const page = await pdf.getPage(pdfPageNumber);
      if (disposed || renderToken !== renderVersion || !canvas.isConnected) return;

      const containerWidth = canvas.parentElement?.clientWidth || view.clientWidth || window.innerWidth;
      lastRenderWidth = containerWidth;
      const baseViewport = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: containerWidth / baseViewport.width });
      const outputScale = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2.5);
      canvas.width = Math.max(1, Math.ceil(viewport.width * outputScale));
      canvas.height = Math.max(1, Math.ceil(viewport.height * outputScale));
      const canvasContext = canvas.getContext('2d', { alpha: false });
      if (!canvasContext) throw new Error('تعذر تجهيز مساحة عرض الصفحة.');

      const renderOptions = { canvasContext, viewport };
      if (outputScale !== 1) renderOptions.transform = [outputScale, 0, 0, outputScale, 0, 0];
      const currentTask = page.render(renderOptions);
      renderTask = currentTask;
      await currentTask.promise;
      if (disposed || renderToken !== renderVersion || !canvas.isConnected) return;

      pageReady = true;
      updateNextAvailability();
    } catch (error) {
      if (error?.name === 'RenderingCancelledException' || error?.name === 'AbortException') return;
      if (!disposed && renderToken === renderVersion) {
        pageReady = false;
        showMsg('تعذر عرض الصفحة بوضوح: ' + (error?.message || 'حاول إعادة فتح القارئ.'));
        updateNextAvailability();
      }
    } finally {
      if (renderToken === renderVersion) renderTask = null;
    }
  }

  async function load() {
    const [assignmentResult, sessionResult] = await Promise.all([
      supabase.from('assignments').select('*').eq('id', assignmentId).single(),
      supabase.rpc('start_or_get_session', { p_assignment_id: assignmentId })
    ]);
    if (assignmentResult.error) throw assignmentResult.error;
    if (sessionResult.error) throw sessionResult.error;
    assignment = assignmentResult.data;
    session = sessionResult.data;
    if (disposed) return;

    if (session.status === 'completed' || session.current_position >= total()) {
      await finishReading();
      return;
    }

    const bookResult = await supabase.from('books').select('*').eq('id', assignment.book_id).single();
    if (bookResult.error) throw bookResult.error;
    book = bookResult.data;

    const { data: signed, error: signError } = await supabase.storage
      .from('books').createSignedUrl(book.storage_path, 3600);
    if (signError || !signed?.signedUrl) throw new Error('تعذر فتح ملف الكتاب');

    pdf = await pdfjsLib.getDocument({ url: signed.signedUrl }).promise;
    if (disposed) return;
    position = session.current_position;
    draw();
  }

  async function confirmCurrentPage() {
    const confirmedPosition = position;
    const { data, error } = await supabase.rpc('confirm_page_view', {
      p_session_id: session.id,
      p_position: confirmedPosition
    });
    if (error) throw error;
    return data;
  }

  async function syncSessionFromServer() {
    const { data: freshSession, error } = await supabase.from('reading_sessions')
      .select('*').eq('id', session.id).single();
    if (error) throw error;
    if (!freshSession) throw new Error('تعذر مزامنة تقدم القراءة.');
    session = freshSession;

    const pending = getPending();
    if (pending?.session_id === session.id && session.current_position > pending.position) setPending(null);
    if (session.status === 'completed' || session.current_position >= total()) {
      await finishReading();
      return;
    }
    // Always resume at the server's next unconfirmed page. Never draw an older
    // page after a stale/wrong-order response.
    position = session.current_position;
    draw();
  }

  async function onNext() {
    const button = view.querySelector('#next-btn');
    if (!button || navigationInFlight || disposed) return;
    if (!pageReady) {
      showMsg('جارٍ عرض الصفحة؛ جرّب الضغط مجددًا بعد اكتمال العرض.');
      return;
    }
    if (session.status === 'completed' || session.current_position >= total()) {
      await finishReading();
      return;
    }

    // Moving through a page that the server already confirmed needs no new RPC.
    if (position < session.current_position) {
      position += 1;
      draw();
      return;
    }
    if (position > session.current_position) {
      try { await syncSessionFromServer(); }
      catch (error) { toast('تعذر مزامنة التقدم: ' + error.message, 'error'); }
      return;
    }

    navigationInFlight = true;
    updateNextAvailability();
    showMsg('جارٍ التحقق من الصفحة…');
    try {
      const confirmation = await confirmCurrentPage();
      if (disposed) return;
      const confirmed = Number(confirmation?.confirmed);
      if (!Number.isInteger(confirmed) || confirmed !== session.current_position + 1 || confirmed > total()) {
        await syncSessionFromServer();
        return;
      }
      setPending(null);
      session.current_position = confirmed;
      if (session.current_position >= total()) {
        await finishReading();
        return;
      }
      position = session.current_position;
      draw();
    } catch (error) {
      if (disposed) return;
      const message = String(error?.message || '');
      if (message.includes('too_fast')) {
        // The server remains authoritative; rejected attempts never advance or
        // redraw the current page, and the student can continue reading.
        showMsg(TOO_FAST_MSG);
      } else if (message.includes('wrong_order') || message.includes('already_finished') || message.includes('already_completed')) {
        try { await syncSessionFromServer(); }
        catch (syncError) { toast('تعذر مزامنة التقدم: ' + syncError.message, 'error'); }
      } else if (!navigator.onLine || message.includes('Failed to fetch') || message.includes('NetworkError')) {
        setPending({ session_id: session.id, position });
        showMsg('انقطع الاتصال. ستبقى في هذه الصفحة، وسيُزامن التقدم عند عودة الاتصال.');
      } else {
        toast('تعذر حفظ الصفحة: ' + message, 'error');
      }
    } finally {
      navigationInFlight = false;
      if (!disposed) updateNextAvailability();
    }
  }

  async function finishReading() {
    if (disposed || finishing) return;
    finishing = true;
    try {
      const { data, error } = await supabase.rpc('complete_reading', { p_session_id: session.id });
      if (error) throw error;
      setPending(null);
      cleanup();
      view.innerHTML = `
        <div class="reader-wrap">
          <div class="card center">
            ${data?.counts
              ? '<div class="success-box">تم تسجيل قراءة اليوم بنجاح.</div>'
              : '<div class="success-box" style="background:#fff7e6;border-color:var(--gold);color:#7a5b12">تمت القراءة بعد انتهاء المهلة — لم تُحتسب ضمن قراءة اليوم.</div>'}
            <p><a href="#/member">العودة للرئيسية</a> · <a href="#/member/history">سجل قراءتي</a></p>
          </div>
        </div>`;
    } catch (error) {
      if (!disposed) {
        const retryMessage = 'اكتملت الصفحات، لكن تعذر تسجيل إنهاء القراءة. تقدمك محفوظ؛ أعد المحاولة.';
        const nextButton = view.querySelector('#next-btn');
        if (nextButton) {
          showMsg(retryMessage);
          nextButton.textContent = 'إعادة المحاولة';
        } else {
          view.innerHTML = `
            <div class="reader-wrap">
              <div class="card center">
                <div class="reader-msg">${escapeHtml(retryMessage)}</div>
                <button type="button" class="btn btn-primary" id="finish-retry">إعادة المحاولة</button>
                <p><a href="#/member">العودة للرئيسية</a></p>
              </div>
            </div>`;
          view.querySelector('#finish-retry').addEventListener('click', () => void finishReading());
        }
        toast('تعذر إنهاء القراءة: ' + error.message, 'error');
      }
    } finally {
      finishing = false;
    }
  }

  async function flushPending() {
    const pending = getPending();
    if (!pending || !navigator.onLine || disposed || navigationInFlight) return;
    navigationInFlight = true;
    updateNextAvailability();
    try {
      const { data, error } = await supabase.rpc('confirm_page_view', {
        p_session_id: pending.session_id,
        p_position: pending.position
      });
      let confirmed = !error;
      let freshSession = null;
      if (error && String(error.message || '').includes('too_fast') && session?.id === pending.session_id) {
        showMsg(TOO_FAST_MSG);
      }
      if (error && ['wrong_order', 'already_finished', 'already_completed'].some((code) => String(error.message || '').includes(code))) {
        const result = await supabase.from('reading_sessions').select('*').eq('id', pending.session_id).single();
        freshSession = result.data;
        confirmed = Boolean(freshSession && freshSession.current_position > pending.position);
      }
      if (!confirmed) return;
      setPending(null);
      if (session?.id === pending.session_id) {
        if (!freshSession) {
          const result = await supabase.from('reading_sessions').select('*').eq('id', session.id).single();
          freshSession = result.data;
        }
        if (freshSession) {
          session = freshSession;
          if (session.status === 'completed' || session.current_position >= total()) {
            await finishReading();
            return;
          }
          position = session.current_position;
          draw();
        } else {
          const confirmedPosition = Number(data?.confirmed);
          if (Number.isInteger(confirmedPosition) && confirmedPosition === pending.position + 1
            && confirmedPosition <= total()) {
            session.current_position = Math.max(session.current_position, confirmedPosition);
            if (session.current_position >= total()) {
              await finishReading();
              return;
            }
            position = session.current_position;
            draw();
          }
        }
      }
      toast('تمت مزامنة تقدمك المحفوظ', 'ok');
    } catch { /* try again when connectivity returns */ }
    finally {
      navigationInFlight = false;
      if (!disposed) updateNextAvailability();
    }
  }

  resizeHandler = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const canvas = view.querySelector('#page-canvas');
      if (disposed || !pdf || !canvas) return;
      const width = canvas.parentElement?.clientWidth || view.clientWidth || window.innerWidth;
      // Mobile browser chrome can trigger frequent height-only resize events.
      // Redraw only when the actual PDF viewport width changed.
      if (Math.abs(width - lastRenderWidth) < 2) return;
      const token = cancelRender();
      pageReady = false;
      updateNextAvailability();
      void renderCurrentPage(token, assignment.start_page + position);
    }, 250);
  };
  onlineHandler = flushPending;
  hashChangeHandler = () => {
    if (location.hash !== `#/read/${assignmentId}`) cleanup();
  };
  fullscreenHandler = updateFullscreenButton;
  window.addEventListener('resize', resizeHandler);
  window.addEventListener('online', onlineHandler);
  window.addEventListener('hashchange', hashChangeHandler);
  document.addEventListener('fullscreenchange', fullscreenHandler);

  try {
    await load();
    if (!disposed) void flushPending();
  } catch (error) {
    if (!disposed) {
      view.innerHTML = `<div class="card center"><p>تعذر فتح القارئ: ${escapeHtml(error.message)}</p><p><a href="#/member">رجوع</a></p></div>`;
    }
  }
}
