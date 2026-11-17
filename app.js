/* توقيع المستندات – سلمان الصقعبي
 * كل المعالجة تتم داخل المتصفح. لا يُرسل أي ملف إلى أي خادم.
 *
 * نظام الإحداثيات:
 *  تُحفظ مواضع العناصر (x, y, w, h) بوحدة "نقطة PDF" على عرض الصفحة كما تظهر
 *  (viewport بمقياس 1 مع دوران الصفحة)، ومن أعلى يسار الصفحة. لذلك لا يتأثر الموضع
 *  بالتكبير أو التصغير. وعند التصدير تُحوَّل الإحداثيات إلى فضاء PDF الفعلي عبر
 *  viewport.convertToPdfPoint التي تعالج الدوران وإزاحة صندوق الصفحة (CropBox).
 */
(() => {
  'use strict';

  const pdfjsLib = window.pdfjsLib;
  const { PDFDocument, degrees } = window.PDFLib;
  // ملف العامل محمّل مسبقًا عبر <script>، فيعمل PDF.js دون خادم (file://)
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

  const $ = (id) => document.getElementById(id);
  const viewer = $('viewer'), pagesEl = $('pages'), emptyEl = $('empty');
  const fileInput = $('fileInput');

  const MIN_ZOOM = 0.25, MAX_ZOOM = 4;

  const state = {
    pdf: null,          // مستند PDF.js
    bytes: null,        // البايتات الأصلية (Uint8Array)
    fileName: '',
    pages: [],          // { vp, el, canvas, overlay, renderedZoom, task }
    zoom: 1,
    items: [],          // { id, type:'sig'|'stamp', page, x, y, w, h, src }
    selectedId: null,
    history: [],
    dirty: false,
    currentPage: 0,
  };
  let nextId = 1;

  /* ------------------------------------------------------------------ */
  /* أدوات عامة                                                          */
  /* ------------------------------------------------------------------ */
  let toastTimer;
  function toast(msg, isErr = false) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('err', isErr);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), isErr ? 5000 : 2600);
  }
  function busy(on, text) {
    $('busy').hidden = !on;
    if (text) $('busyText').textContent = text;
  }
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

  // نافذة تأكيد داخل الصفحة (بديل confirm الذي لا يعمل في النسخة المستضافة)
  function ask(message, yesLabel = 'متابعة', noLabel = 'إلغاء') {
    return new Promise((resolve) => {
      const m = $('askModal');
      $('askText').textContent = message;
      $('askYes').textContent = yesLabel;
      $('askNo').textContent = noLabel;
      m.hidden = false;
      $('askYes').focus();
      const done = (v) => {
        m.hidden = true;
        $('askYes').onclick = $('askNo').onclick = null;
        resolve(v);
      };
      $('askYes').onclick = () => done(true);
      $('askNo').onclick = () => done(false);
    });
  }

  // في النسخة المستضافة على claude.ai يتم الحفظ عبر قدرة "downloads"
  const downloadsReady = (window.claude && typeof window.claude.use === 'function')
    ? window.claude.use('downloads').catch(() => null)
    : Promise.resolve(null);

  function updateButtons() {
    const has = !!state.pdf;
    $('btnSign').disabled = !has;
    $('btnStamp').disabled = !has;
    $('btnDownload').disabled = !has;
    $('btnNew').disabled = !has;
    $('btnUndo').disabled = state.history.length === 0;
    $('btnDelete').disabled = !state.selectedId;
  }

  /* ------------------------------------------------------------------ */
  /* تحميل المستند                                                       */
  /* ------------------------------------------------------------------ */
  const isPdfFile = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
  const isImageFile = (f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(f.name);

  // يقبل ملف PDF، أو صورة أو أكثر تتحول كل منها إلى صفحة في مستند PDF
  async function openFile(list) {
    const files = [...(list || [])];
    if (!files.length) return;
    const pdfFile = files.find(isPdfFile);
    const images = pdfFile ? [] : files.filter(isImageFile);
    if (!pdfFile && !images.length) {
      fileInput.value = '';
      return toast('الرجاء اختيار ملف PDF أو صورة (JPG أو PNG)', true);
    }
    if (state.pdf && state.items.length &&
        !(await ask('سيتم إغلاق المستند الحالي وحذف التوقيع والختم منه. متابعة؟', 'فتح المستند الجديد'))) {
      fileInput.value = '';
      return;
    }

    busy(true, images.length ? 'جارٍ تحويل الصور إلى PDF…' : 'جارٍ فتح المستند…');
    let opened = false;
    try {
      const bytes = pdfFile ? new Uint8Array(await pdfFile.arrayBuffer()) : await imagesToPdf(images);
      const name = pdfFile ? pdfFile.name : images[0].name.replace(/\.[^.]+$/, '') + '.pdf';
      // نسخة لـ PDF.js لأن البايتات قد تُنقل/تُستهلك
      const pdf = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
      resetDocument();
      state.pdf = pdf;
      state.bytes = bytes;
      state.fileName = name;
      await buildPages();
      $('docName').textContent = name;
      $('docName').title = name;
      $('pageCount').textContent = pdf.numPages;
      $('pageInput').max = pdf.numPages;
      $('subbar').hidden = false;
      emptyEl.hidden = true;
      fitWidth();
      viewer.scrollTop = 0;
      updateButtons();
      opened = true;
    } catch (e) {
      console.error(e);
      toast(e && e.name === 'PasswordException'
        ? 'هذا المستند محمي بكلمة مرور ولا يمكن فتحه'
        : images.length
          ? 'تعذّر قراءة الصورة. جرّب صورة بصيغة JPG أو PNG.'
          : 'تعذّر فتح الملف. تأكد أنه ملف PDF سليم.', true);
    } finally {
      busy(false);
      fileInput.value = '';
    }
    // بعد فتح المستند: عرض خيار الختم مباشرة (من المحفوظ إن وُجد)
    if (!opened) return;
    const stamps = await library.list('stamp');
    if (stamps.length) {
      if (await ask('تم فتح المستند. هل تريد إضافة الختم الآن؟', 'اختيار الختم', 'لاحقًا')) openPicker('stamp', stamps);
    } else if (await ask('تم فتح المستند. هل تريد رفع صورة الختم الآن؟', 'رفع الختم', 'لاحقًا')) {
      addStamp();
    }
  }

  // كل صورة صفحة بعرض A4 (أو A4 بالعرض للصور الأفقية) مع الحفاظ على نسبتها
  async function imagesToPdf(images) {
    const doc = await PDFDocument.create();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const MAX = 3000;
    for (const f of images) {
      const im = await loadImage(f);
      const s = Math.min(1, MAX / Math.max(im.naturalWidth, im.naturalHeight));
      canvas.width = Math.round(im.naturalWidth * s);
      canvas.height = Math.round(im.naturalHeight * s);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(im, 0, 0, canvas.width, canvas.height);
      const jpg = await doc.embedJpg(dataUrlToBytes(canvas.toDataURL('image/jpeg', 0.92)));
      const w = canvas.width >= canvas.height ? 842 : 595;
      const h = w * canvas.height / canvas.width;
      doc.addPage([w, h]).drawImage(jpg, { x: 0, y: 0, width: w, height: h });
    }
    canvas.width = canvas.height = 0;
    return doc.save();
  }

  function resetDocument() {
    for (const p of state.pages) if (p.task) p.task.cancel();
    if (state.pdf) state.pdf.destroy();
    pageObserver.disconnect();
    pagesEl.innerHTML = '';
    Object.assign(state, {
      pdf: null, bytes: null, fileName: '', pages: [], items: [],
      selectedId: null, history: [], dirty: false, currentPage: 0,
    });
    closeSignaturePad(true);
  }

  async function newDocument() {
    if (state.items.length && state.dirty &&
        !(await ask('لم يتم تنزيل المستند الموقّع بعد. هل تريد البدء بمستند جديد؟', 'مستند جديد'))) return;
    resetDocument();
    $('subbar').hidden = true;
    emptyEl.hidden = false;
    updateButtons();
  }

  async function buildPages() {
    const n = state.pdf.numPages;
    for (let i = 1; i <= n; i++) {
      const page = await state.pdf.getPage(i);
      const vp = page.getViewport({ scale: 1 }); // يشمل دوران الصفحة
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.index = i - 1;
      const canvas = document.createElement('canvas');
      canvas.className = 'pdf';
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      const num = document.createElement('div');
      num.className = 'page-num';
      num.textContent = i;
      el.append(canvas, overlay, num);
      pagesEl.appendChild(el);
      overlay.addEventListener('pointerdown', (ev) => {
        if (ev.target === overlay) select(null);
      });
      state.pages.push({ page, vp, el, canvas, overlay, renderedZoom: 0, task: null, visible: false });
    }
  }

  /* ------------------------------------------------------------------ */
  /* العرض والتكبير                                                      */
  /* ------------------------------------------------------------------ */
  const pageObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const p = state.pages[+en.target.dataset.index];
      if (!p) continue;
      p.visible = en.isIntersecting;
      if (p.visible) renderPage(p);
    }
  }, { root: viewer, rootMargin: '600px 0px' });

  function layoutPages() {
    const z = state.zoom;
    for (const p of state.pages) {
      p.el.style.width = p.vp.width * z + 'px';
      p.el.style.height = p.vp.height * z + 'px';
    }
    renderItems();
    $('zoomLabel').textContent = Math.round(z * 100) + '%';
  }

  async function renderPage(p) {
    const z = state.zoom;
    if (p.renderedZoom === z || !state.pdf) return;
    if (p.task) { p.task.cancel(); p.task = null; }
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const vp = p.page.getViewport({ scale: z * dpr });
    const tmp = document.createElement('canvas');
    tmp.width = Math.floor(vp.width);
    tmp.height = Math.floor(vp.height);
    const ctx = tmp.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, tmp.width, tmp.height);
    const task = p.page.render({ canvasContext: ctx, viewport: vp });
    p.task = task;
    try {
      await task.promise;
      if (p.task !== task) return;
      // نرسم على اللوحة الظاهرة بعد اكتمال الرسم لتجنب الوميض
      p.canvas.width = tmp.width;
      p.canvas.height = tmp.height;
      p.canvas.getContext('2d').drawImage(tmp, 0, 0);
      p.renderedZoom = z;
    } catch (e) {
      if (e && e.name !== 'RenderingCancelledException') console.error(e);
    } finally {
      if (p.task === task) p.task = null;
    }
  }

  function setZoom(z, keepCenter = true) {
    z = clamp(Math.round(z * 100) / 100, MIN_ZOOM, MAX_ZOOM);
    if (!state.pdf) { state.zoom = z; return; }
    // نحافظ على النقطة الواقعة في منتصف الشاشة
    const fy = keepCenter ? (viewer.scrollTop + viewer.clientHeight / 2) / Math.max(1, pagesEl.scrollHeight) : 0;
    const fx = keepCenter ? (viewer.scrollLeft + viewer.clientWidth / 2) / Math.max(1, pagesEl.scrollWidth) : 0;
    state.zoom = z;
    layoutPages();
    if (keepCenter) {
      viewer.scrollTop = fy * pagesEl.scrollHeight - viewer.clientHeight / 2;
      viewer.scrollLeft = fx * pagesEl.scrollWidth - viewer.clientWidth / 2;
    }
    for (const p of state.pages) {
      pageObserver.unobserve(p.el);
      pageObserver.observe(p.el);
    }
  }

  function fitWidth() {
    if (!state.pages.length) return;
    const maxW = Math.max(...state.pages.map((p) => p.vp.width));
    const avail = viewer.clientWidth - 48 - 16;
    setZoom(clamp(avail / maxW, MIN_ZOOM, 1.6), false);
  }

  function updateCurrentPage() {
    if (!state.pages.length) return;
    const mid = viewer.getBoundingClientRect().top + viewer.clientHeight / 2;
    let best = 0, bestDist = Infinity;
    state.pages.forEach((p, i) => {
      const r = p.el.getBoundingClientRect();
      const d = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0;
      if (d < bestDist) { bestDist = d; best = i; }
    });
    state.currentPage = best;
    if (document.activeElement !== $('pageInput')) $('pageInput').value = best + 1;
  }

  function goToPage(i) {
    i = clamp(i, 0, state.pages.length - 1);
    const p = state.pages[i];
    viewer.scrollTop = p.el.offsetTop - 16;
    state.currentPage = i;
    $('pageInput').value = i + 1;
  }

  /* ------------------------------------------------------------------ */
  /* العناصر (التوقيع والختم)                                            */
  /* ------------------------------------------------------------------ */
  function snapshot() {
    return state.items.map((it) => ({ ...it }));
  }
  function pushHistory() {
    state.history.push(snapshot());
    if (state.history.length > 100) state.history.shift();
    state.dirty = true;
    updateButtons();
  }
  function undo() {
    if (!state.history.length) return;
    state.items = state.history.pop();
    if (!state.items.find((i) => i.id === state.selectedId)) state.selectedId = null;
    renderItems();
    updateButtons();
  }

  function select(id) {
    state.selectedId = id;
    for (const el of pagesEl.querySelectorAll('.item')) {
      el.classList.toggle('selected', +el.dataset.id === id);
    }
    updateButtons();
  }

  function deleteItem(id = state.selectedId) {
    if (!id) return;
    pushHistory();
    state.items = state.items.filter((i) => i.id !== id);
    state.selectedId = null;
    renderItems();
    updateButtons();
  }

  // يضع عنصرًا جديدًا في منتصف الجزء الظاهر من الصفحة الحالية
  function addItem(type, src, ratio, defaultWidth) {
    updateCurrentPage();
    const pi = state.currentPage;
    const p = state.pages[pi];
    let w = Math.min(defaultWidth, p.vp.width * 0.45);
    let h = w / ratio;
    const maxH = p.vp.height * 0.3;
    if (h > maxH) { h = maxH; w = h * ratio; }

    const vr = viewer.getBoundingClientRect();
    const pr = p.el.getBoundingClientRect();
    const top = Math.max(vr.top, pr.top), bottom = Math.min(vr.bottom, pr.bottom);
    const left = Math.max(vr.left, pr.left), right = Math.min(vr.right, pr.right);
    let cx = p.vp.width / 2, cy = p.vp.height / 2;
    if (bottom > top && right > left) {
      cx = ((left + right) / 2 - pr.left) / state.zoom;
      cy = ((top + bottom) / 2 - pr.top) / state.zoom;
    }
    // إزاحة بسيطة حتى لا يتطابق عنصران فوق بعضهما
    const offset = state.items.filter((i) => i.page === pi).length * 12;
    const it = {
      id: nextId++, type, page: pi, src,
      w, h,
      x: clamp(cx - w / 2 + offset, 0, p.vp.width - w),
      y: clamp(cy - h / 2 + offset, 0, p.vp.height - h),
    };
    pushHistory();
    state.items.push(it);
    state.selectedId = it.id;
    renderItems();
    updateButtons();
  }

  function renderItems() {
    for (const el of pagesEl.querySelectorAll('.item')) el.remove();
    for (const it of state.items) {
      const p = state.pages[it.page];
      if (!p) continue;
      const el = document.createElement('div');
      el.className = 'item' + (it.id === state.selectedId ? ' selected' : '');
      el.dataset.id = it.id;
      el.title = it.type === 'sig' ? 'التوقيع — اسحب لتحريكه' : 'الختم — اسحب لتحريكه';
      const img = document.createElement('img');
      img.src = it.src;
      img.draggable = false;
      img.alt = it.type === 'sig' ? 'توقيع' : 'ختم';
      el.appendChild(img);
      for (const c of ['nw', 'ne', 'sw', 'se']) {
        const h = document.createElement('div');
        h.className = 'h ' + c;
        h.dataset.corner = c;
        el.appendChild(h);
      }
      const x = document.createElement('button');
      x.className = 'x';
      x.textContent = 'حذف';
      x.addEventListener('pointerdown', (e) => e.stopPropagation());
      x.addEventListener('click', (e) => { e.stopPropagation(); deleteItem(it.id); });
      el.appendChild(x);
      positionEl(el, it);
      el.addEventListener('pointerdown', (e) => startInteraction(e, it, el));
      p.overlay.appendChild(el);
    }
  }

  function positionEl(el, it) {
    const z = state.zoom;
    el.style.left = it.x * z + 'px';
    el.style.top = it.y * z + 'px';
    el.style.width = it.w * z + 'px';
    el.style.height = it.h * z + 'px';
  }

  // سحب / تغيير الحجم
  function startInteraction(e, it, el) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    select(it.id);
    const corner = e.target.dataset && e.target.dataset.corner;
    const z = state.zoom;
    const before = { ...it };
    const startX = e.clientX, startY = e.clientY;
    const elRect = el.getBoundingClientRect();
    const ratio = it.w / it.h;
    let moved = false;
    el.setPointerCapture(e.pointerId);

    // الركن الثابت عند تغيير الحجم
    const anchor = corner && {
      x: corner.includes('w') ? it.x + it.w : it.x,
      y: corner.includes('n') ? it.y + it.h : it.y,
    };

    const onMove = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 2) return;
      moved = true;
      if (corner) {
        const p = state.pages[it.page];
        const pr = p.el.getBoundingClientRect();
        const px = (ev.clientX - pr.left) / z, py = (ev.clientY - pr.top) / z;
        // أقصى عرض متاح داخل الصفحة في اتجاه السحب
        const maxW = Math.min(
          corner.includes('w') ? anchor.x : p.vp.width - anchor.x,
          (corner.includes('n') ? anchor.y : p.vp.height - anchor.y) * ratio,
        );
        let w = Math.max(Math.abs(px - anchor.x), Math.abs(py - anchor.y) * ratio);
        w = clamp(w, 12, Math.max(12, maxW));
        const h = w / ratio;
        it.w = w; it.h = h;
        it.x = corner.includes('w') ? anchor.x - w : anchor.x;
        it.y = corner.includes('n') ? anchor.y - h : anchor.y;
        positionEl(el, it);
      } else {
        // تحديد الصفحة الواقعة تحت مركز العنصر (يسمح بنقله بين الصفحات)
        const left = elRect.left + dx, top = elRect.top + dy;
        const cx = left + elRect.width / 2, cy = top + elRect.height / 2;
        let target = it.page, bestD = Infinity;
        state.pages.forEach((p, i) => {
          const r = p.el.getBoundingClientRect();
          const ddx = cx < r.left ? r.left - cx : cx > r.right ? cx - r.right : 0;
          const ddy = cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0;
          const d = ddx + ddy;
          if (d < bestD) { bestD = d; target = i; }
        });
        const tp = state.pages[target];
        if (it.w > tp.vp.width || it.h > tp.vp.height) target = it.page; // لا يتسع
        const p = state.pages[target];
        const pr = p.el.getBoundingClientRect();
        it.x = clamp((left - pr.left) / z, 0, p.vp.width - it.w);
        it.y = clamp((top - pr.top) / z, 0, p.vp.height - it.h);
        if (target !== it.page) {
          it.page = target;
          p.overlay.appendChild(el);
          el.setPointerCapture(ev.pointerId);
        }
        positionEl(el, it);
      }
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      if (moved) {
        const after = { ...it };
        Object.assign(it, before);
        pushHistory();
        Object.assign(it, after);
      }
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  }

  function nudge(dx, dy) {
    const it = state.items.find((i) => i.id === state.selectedId);
    if (!it) return;
    const p = state.pages[it.page];
    pushHistory();
    it.x = clamp(it.x + dx, 0, p.vp.width - it.w);
    it.y = clamp(it.y + dy, 0, p.vp.height - it.h);
    const el = pagesEl.querySelector(`.item[data-id="${it.id}"]`);
    if (el) positionEl(el, it);
  }

  /* ------------------------------------------------------------------ */
  /* المحفوظات: تواقيع وأختام يختار المستخدم حفظها على جهازه فقط          */
  /* ------------------------------------------------------------------ */
  const library = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open('saqeel-sign', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('library', { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => { dbp = null; rej(r.error); };
    }));
    const run = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction('library', mode);
        const req = fn(t.objectStore('library'));
        t.oncomplete = () => res(req.result);
        t.onerror = () => rej(t.error);
      });
    };
    return {
      available: 'indexedDB' in window,
      async list(kind) {
        try {
          const all = await run('readonly', (s) => s.getAll());
          return all.filter((i) => i.kind === kind).sort((a, b) => a.created - b.created);
        } catch { return []; }
      },
      put: (item) => run('readwrite', (s) => s.put(item)),
      remove: (id) => run('readwrite', (s) => s.delete(id)),
    };
  })();

  const KIND = {
    sig: { one: 'التوقيع', saved: 'تواقيعي المحفوظة', fresh: 'رسم توقيع جديد', name: 'توقيعي' },
    stamp: { one: 'الختم', saved: 'الأختام المحفوظة', fresh: 'رفع ختم جديد', name: 'ختم الجمعية' },
  };
  const startNew = (kind) => (kind === 'sig' ? openSignaturePad() : addStamp());

  // يعرض المحفوظات إن وُجدت، وإلا يبدأ بإنشاء جديد مباشرة
  async function chooseOrNew(kind) {
    const items = await library.list(kind);
    if (!items.length) return startNew(kind);
    openPicker(kind, items);
  }

  const libModal = $('libModal');
  function openPicker(kind, items) {
    $('libTitle').textContent = KIND[kind].saved;
    $('libNew').textContent = KIND[kind].fresh;
    $('libNew').onclick = () => { libModal.hidden = true; startNew(kind); };
    const list = $('libList');
    list.replaceChildren();
    for (const it of items) {
      const card = document.createElement('div');
      card.className = 'lib-card';
      const pick = document.createElement('button');
      pick.className = 'lib-pick';
      pick.title = 'إضافة إلى المستند';
      const img = document.createElement('img');
      img.src = it.src; img.alt = '';
      const label = document.createElement('span');
      label.textContent = it.name;
      pick.append(img, label);
      pick.onclick = () => {
        libModal.hidden = true;
        addItem(kind, it.src, it.ratio, it.width);
      };
      const del = document.createElement('button');
      del.className = 'lib-del';
      del.title = 'حذف من الجهاز';
      del.textContent = '×';
      del.onclick = async () => {
        if (!(await ask(`حذف «${it.name}» من هذا الجهاز؟`, 'حذف'))) return;
        await library.remove(it.id);
        card.remove();
        if (!list.children.length) { libModal.hidden = true; toast('لم يبقَ شيء محفوظ'); }
      };
      card.append(pick, del);
      list.append(card);
    }
    libModal.hidden = false;
  }
  $('libClose').onclick = () => (libModal.hidden = true);

  // بعد إنشاء توقيع أو ختم جديد: عرض خيار حفظه
  const saveModal = $('saveModal');
  function offerSave(kind, src, ratio, width) {
    if (!library.available) return;
    $('saveTitle').textContent = `حفظ ${KIND[kind].one} على هذا الجهاز؟`;
    $('saveImg').src = src;
    const name = $('saveName');
    name.value = KIND[kind].name;
    saveModal.hidden = false;
    name.focus();
    name.select();
    const close = () => { saveModal.hidden = true; $('saveYes').onclick = $('saveNo').onclick = null; };
    $('saveNo').onclick = close;
    $('saveYes').onclick = async () => {
      const item = {
        id: `${kind}-${Date.now()}`, kind, src, ratio, width,
        name: name.value.trim() || KIND[kind].name, created: Date.now(),
      };
      close();
      try {
        await library.put(item);
        toast(`تم الحفظ ✓ ستجده عند الضغط على «${kind === 'sig' ? 'إضافة توقيع' : 'إضافة الختم'}»`);
      } catch {
        toast('تعذّر الحفظ في هذا المتصفح', true);
      }
    };
  }
  $('saveName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('saveYes').click(); });

  /* ------------------------------------------------------------------ */
  /* الختم                                                               */
  /* ------------------------------------------------------------------ */
  const stampInput = document.createElement('input');
  stampInput.type = 'file';
  stampInput.accept = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
  stampInput.hidden = true;
  document.body.appendChild(stampInput);

  function addStamp() {
    stampInput.value = '';
    stampInput.click();
  }

  stampInput.onchange = async () => {
    const file = stampInput.files[0];
    stampInput.value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name)) {
      return toast('الرجاء اختيار صورة الختم بصيغة PNG أو JPG', true);
    }
    busy(true, 'جارٍ تجهيز الختم…');
    let stamp = null;
    try {
      stamp = await prepareStamp(file);
      addItem('stamp', stamp.src, stamp.ratio, 115);
    } catch (e) {
      console.error(e);
      toast('تعذّر قراءة صورة الختم. جرّب صورة أخرى بصيغة PNG أو JPG.', true);
    } finally {
      busy(false);
    }
    if (stamp) offerSave('stamp', stamp.src, stamp.ratio, 115);
  };

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      im.src = url;
    });
  }

  // يجهّز صورة الختم: يجعل الخلفية البيضاء شفافة (إن لم تكن الصورة شفافة أصلًا)
  // ثم يقصّ الحواف الفارغة ويعيد صورة PNG
  async function prepareStamp(file) {
    const im = await loadImage(file);
    const MAX = 1600;
    const s = Math.min(1, MAX / Math.max(im.naturalWidth, im.naturalHeight));
    const w = Math.max(1, Math.round(im.naturalWidth * s));
    const h = Math.max(1, Math.round(im.naturalHeight * s));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(im, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;

    let transparent = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) transparent++;
    const hasAlpha = transparent > (w * h) * 0.01;

    if (!hasAlpha) {
      // إزالة الأبيض مع الحفاظ على نعومة الحواف ولون الحبر الأصلي
      const LO = 200, HI = 245; // ما فوق HI يصبح شفافًا تمامًا
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const m = Math.min(r, g, b);
        // كلما زاد بياض البكسل قلّ تعتيمه
        const a = m >= HI ? 0 : Math.min(1, (255 - m) / (255 - LO));
        if (a <= 0) { d[i + 3] = 0; continue; }
        // فصل اللون عن الخلفية البيضاء
        d[i] = clamp(Math.round(255 - (255 - r) / a), 0, 255);
        d[i + 1] = clamp(Math.round(255 - (255 - g) / a), 0, 255);
        d[i + 2] = clamp(Math.round(255 - (255 - b) / a), 0, 255);
        d[i + 3] = Math.round(a * 255);
      }
      ctx.putImageData(img, 0, 0);
    }

    // قص الحواف الشفافة
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 10) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) throw new Error('empty image');
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    const out = document.createElement('canvas');
    out.width = cw; out.height = ch;
    out.getContext('2d').drawImage(c, x0, y0, cw, ch, 0, 0, cw, ch);
    return { src: out.toDataURL('image/png'), ratio: cw / ch };
  }

  /* ------------------------------------------------------------------ */
  /* لوحة التوقيع اليدوي                                                */
  /* ------------------------------------------------------------------ */
  const sigModal = $('sigModal'), sigCanvas = $('sigCanvas');
  const sigCtx = sigCanvas.getContext('2d');
  const SIG_RES = 3; // دقة عالية للحصول على توقيع واضح عند الطباعة
  const sig = { color: '#0b1f5c', width: 3, drawing: false, last: null, mid: null, bbox: null, strokes: 0 };

  function openSignaturePad() {
    sigModal.hidden = false;
    const r = sigCanvas.getBoundingClientRect();
    sigCanvas.width = Math.round(r.width * SIG_RES);
    sigCanvas.height = Math.round(r.height * SIG_RES);
    clearSignature();
  }
  // لا نحتفظ بأي رسم بعد إغلاق النافذة
  function closeSignaturePad() {
    sigModal.hidden = true;
    sig.drawing = false;
    sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
    sig.bbox = null; sig.strokes = 0;
  }
  function clearSignature() {
    sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
    sig.bbox = null;
    sig.strokes = 0;
    $('sigApply').disabled = true;
    $('sigHint').hidden = false;
  }
  function sigPoint(e) {
    const r = sigCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * SIG_RES,
      y: (e.clientY - r.top) * SIG_RES,
      p: e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5,
    };
  }
  function grow(pt, lw) {
    const pad = lw;
    if (!sig.bbox) sig.bbox = { x0: pt.x - pad, y0: pt.y - pad, x1: pt.x + pad, y1: pt.y + pad };
    else {
      sig.bbox.x0 = Math.min(sig.bbox.x0, pt.x - pad); sig.bbox.y0 = Math.min(sig.bbox.y0, pt.y - pad);
      sig.bbox.x1 = Math.max(sig.bbox.x1, pt.x + pad); sig.bbox.y1 = Math.max(sig.bbox.y1, pt.y + pad);
    }
  }
  const lineW = (pt) => sig.width * SIG_RES * (0.55 + pt.p * 0.9);

  sigCanvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    sigCanvas.setPointerCapture(e.pointerId);
    sig.drawing = true;
    const pt = sigPoint(e);
    sig.last = pt; sig.mid = pt;
    sigCtx.fillStyle = sig.color;
    const lw = lineW(pt);
    sigCtx.beginPath();
    sigCtx.arc(pt.x, pt.y, lw / 2, 0, Math.PI * 2);
    sigCtx.fill();
    grow(pt, lw);
    $('sigHint').hidden = true;
  });
  sigCanvas.addEventListener('pointermove', (e) => {
    if (!sig.drawing) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ce of (events.length ? events : [e])) {
      const pt = sigPoint(ce);
      const mid = { x: (sig.last.x + pt.x) / 2, y: (sig.last.y + pt.y) / 2, p: (sig.last.p + pt.p) / 2 };
      const lw = lineW(mid);
      sigCtx.strokeStyle = sig.color;
      sigCtx.lineWidth = lw;
      sigCtx.lineCap = 'round';
      sigCtx.lineJoin = 'round';
      sigCtx.beginPath();
      sigCtx.moveTo(sig.mid.x, sig.mid.y);
      sigCtx.quadraticCurveTo(sig.last.x, sig.last.y, mid.x, mid.y);
      sigCtx.stroke();
      grow(pt, lw);
      sig.last = pt; sig.mid = mid;
    }
  });
  const endStroke = () => {
    if (!sig.drawing) return;
    sig.drawing = false;
    sig.strokes++;
    $('sigApply').disabled = false;
  };
  sigCanvas.addEventListener('pointerup', endStroke);
  sigCanvas.addEventListener('pointercancel', endStroke);

  function applySignature() {
    if (!sig.bbox || !sig.strokes) return;
    const b = sig.bbox;
    const x0 = Math.max(0, Math.floor(b.x0)), y0 = Math.max(0, Math.floor(b.y0));
    const x1 = Math.min(sigCanvas.width, Math.ceil(b.x1)), y1 = Math.min(sigCanvas.height, Math.ceil(b.y1));
    const w = x1 - x0, h = y1 - y0;
    if (w < 4 || h < 4) return toast('التوقيع صغير جدًا، ارسمه مرة أخرى', true);
    // قص التوقيع إلى حدوده بخلفية شفافة
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    out.getContext('2d').drawImage(sigCanvas, x0, y0, w, h, 0, 0, w, h);
    const src = out.toDataURL('image/png');
    // العرض الافتراضي متناسب مع حجم الرسم داخل اللوحة
    const cssW = w / SIG_RES;
    closeSignaturePad(true);
    const width = clamp(cssW * 0.4, 70, 190);
    addItem('sig', src, w / h, width);
    offerSave('sig', src, w / h, width);
  }

  /* ------------------------------------------------------------------ */
  /* التصدير                                                             */
  /* ------------------------------------------------------------------ */
  function dataUrlToBytes(url) {
    const bin = atob(url.split(',')[1]);
    const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }

  // المستند المحمي: نعيد بناءه من صفحات مرسومة بدقة عالية (≈216 نقطة/بوصة)
  async function flattenToImages() {
    const out = await PDFDocument.create();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const SCALE = 3;
    for (let i = 0; i < state.pages.length; i++) {
      busy(true, `جارٍ تجهيز المستند المحمي… (${i + 1}/${state.pages.length})`);
      const page = await state.pdf.getPage(i + 1);
      const vp = page.getViewport({ scale: SCALE });
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const jpg = await out.embedJpg(dataUrlToBytes(canvas.toDataURL('image/jpeg', 0.92)));
      const w = vp.width / SCALE, h = vp.height / SCALE;
      out.addPage([w, h]).drawImage(jpg, { x: 0, y: 0, width: w, height: h });
    }
    canvas.width = canvas.height = 0;
    return out;
  }

  async function exportPdf() {
    if (!state.pdf) return;
    if (!state.items.length &&
        !(await ask('لم تُضف توقيعًا أو ختمًا بعد. هل تريد تنزيل المستند كما هو؟', 'تنزيل'))) return;
    busy(true, 'جارٍ إنشاء ملف PDF…');
    try {
      let doc = await PDFDocument.load(state.bytes, { ignoreEncryption: true, updateMetadata: false });
      const encrypted = doc.isEncrypted;
      // pdf-lib لا يشفّر ما يضيفه، فيقرأ العارض التوقيع في ملف مشفّر بيانات تالفة
      if (encrypted) doc = await flattenToImages();
      const pages = doc.getPages();
      const cache = new Map();
      for (const it of state.items) {
        let img = cache.get(it.src);
        if (!img) {
          img = await doc.embedPng(dataUrlToBytes(it.src));
          cache.set(it.src, img);
        }
        const vp = state.pages[it.page].vp;
        if (encrypted) {
          pages[it.page].drawImage(img, { x: it.x, y: vp.height - it.y - it.h, width: it.w, height: it.h });
          continue;
        }
        // الركن السفلي الأيسر للعنصر كما يظهر ← نقطة في فضاء PDF
        const [px, py] = vp.convertToPdfPoint(it.x, it.y + it.h);
        pages[it.page].drawImage(img, {
          x: px, y: py, width: it.w, height: it.h,
          // تدوير الصورة بمقدار دوران الصفحة حتى تظهر معتدلة
          rotate: degrees(((vp.rotation % 360) + 360) % 360),
        });
      }
      const out = await doc.save({ useObjectStreams: false });
      const base = state.fileName.replace(/\.pdf$/i, '');
      busy(false);
      if (await download(out, `${base} - موقع.pdf`)) {
        state.dirty = false;
        toast('تم حفظ المستند الموقّع ✓');
      }
    } catch (e) {
      console.error(e);
      toast('تعذّر إنشاء الملف: ' + (e && e.message ? e.message : e), true);
    } finally {
      busy(false);
    }
  }

  async function download(bytes, name) {
    const dl = await downloadsReady;
    if (dl) {
      try {
        await dl.save({ filename: name, data: new Blob([bytes], { type: 'application/pdf' }) });
        return true;
      } catch (e) {
        if (e && e.code === 'declined') toast('لم يتم حفظ الملف');
        else if (e && e.code === 'rate_limited') toast('نافذة الحفظ مفتوحة بالفعل، انتظر قليلًا ثم أعد المحاولة', true);
        else toast('تعذّر حفظ الملف في هذه الصفحة', true);
        return false;
      }
    }
    saveViaLink(bytes, name);
    return true;
  }

  function saveViaLink(bytes, name) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  /* ------------------------------------------------------------------ */
  /* الأحداث                                                             */
  /* ------------------------------------------------------------------ */
  $('btnUpload').onclick = $('btnUpload2').onclick = () => fileInput.click();
  fileInput.onchange = () => openFile(fileInput.files);
  $('btnSign').onclick = () => chooseOrNew('sig');
  $('btnStamp').onclick = () => chooseOrNew('stamp');
  $('btnUndo').onclick = undo;
  $('btnDelete').onclick = () => deleteItem();
  $('btnDownload').onclick = exportPdf;
  $('btnNew').onclick = newDocument;

  $('sigClear').onclick = clearSignature;
  $('sigApply').onclick = applySignature;
  $('sigClose').onclick = () => closeSignaturePad(true);
  sigModal.addEventListener('pointerdown', (e) => { if (e.target === sigModal) closeSignaturePad(true); });
  for (const sw of document.querySelectorAll('.swatch')) {
    sw.onclick = () => {
      document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
      sw.classList.add('active');
      sig.color = sw.dataset.color;
    };
  }
  $('sigWidth').oninput = (e) => (sig.width = +e.target.value);

  $('btnZoomIn').onclick = () => setZoom(state.zoom * 1.2);
  $('btnZoomOut').onclick = () => setZoom(state.zoom / 1.2);
  $('btnFit').onclick = fitWidth;
  // ملاحظة: الواجهة من اليمين لليسار، لذا «السابق» على اليمين
  $('btnPrev').onclick = () => goToPage(state.currentPage - 1);
  $('btnNext').onclick = () => goToPage(state.currentPage + 1);
  $('pageInput').onchange = (e) => goToPage((+e.target.value || 1) - 1);

  let scrollRaf = 0;
  viewer.addEventListener('scroll', () => {
    cancelAnimationFrame(scrollRaf);
    scrollRaf = requestAnimationFrame(updateCurrentPage);
  });
  viewer.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !state.pdf) return;
    e.preventDefault();
    setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  // سحب الملف وإفلاته
  viewer.addEventListener('dragover', (e) => { e.preventDefault(); viewer.classList.add('dragover'); });
  viewer.addEventListener('dragleave', () => viewer.classList.remove('dragover'));
  viewer.addEventListener('drop', (e) => {
    e.preventDefault();
    viewer.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length) openFile(e.dataTransfer.files);
  });

  document.addEventListener('keydown', (e) => {
    if (!$('askModal').hidden) {
      if (e.key === 'Escape') $('askNo').click();
      return;
    }
    if (!saveModal.hidden) {
      if (e.key === 'Escape') $('saveNo').click();
      return;
    }
    if (!libModal.hidden) {
      if (e.key === 'Escape') libModal.hidden = true;
      return;
    }
    if (!sigModal.hidden) {
      if (e.key === 'Escape') closeSignaturePad(true);
      return;
    }
    if (e.target.matches('input, textarea')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (!state.selectedId) return;
    const step = e.shiftKey ? 10 : 1;
    switch (e.key) {
      case 'Delete': case 'Backspace': e.preventDefault(); deleteItem(); break;
      case 'Escape': select(null); break;
      case 'ArrowLeft': e.preventDefault(); nudge(-step, 0); break;
      case 'ArrowRight': e.preventDefault(); nudge(step, 0); break;
      case 'ArrowUp': e.preventDefault(); nudge(0, -step); break;
      case 'ArrowDown': e.preventDefault(); nudge(0, step); break;
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty && state.items.length) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ------------------------------------------------------------------ */
  /* التثبيت كتطبيق                                                      */
  /* ------------------------------------------------------------------ */
  const btnInstall = $('btnInstall');
  const iosModal = $('iosModal');
  const installed = () =>
    matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let installPrompt = null;

  if (!installed()) {
    if (isIOS) {
      btnInstall.hidden = false;
      // Chrome/Edge/Firefox على iOS تُظهر الخيار في الإصدارات الحديثة فقط
      $('iosNote').hidden = !/CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent);
    }
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      installPrompt = e;
      btnInstall.hidden = false;
    });
  }
  window.addEventListener('appinstalled', () => {
    btnInstall.hidden = true;
    installPrompt = null;
    toast('تم تثبيت التطبيق ✓');
  });

  btnInstall.onclick = async () => {
    if (installPrompt) {
      installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      installPrompt = null;
      if (outcome === 'accepted') btnInstall.hidden = true;
    } else if (isIOS) {
      iosModal.hidden = false;
      $('iosOk').focus();
    }
  };
  $('iosOk').onclick = $('iosClose').onclick = () => (iosModal.hidden = true);
  iosModal.addEventListener('click', (e) => { if (e.target === iosModal) iosModal.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !iosModal.hidden) iosModal.hidden = true;
  });

  if ('serviceWorker' in navigator && window.isSecureContext && !window.claude) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  updateButtons();
})();
