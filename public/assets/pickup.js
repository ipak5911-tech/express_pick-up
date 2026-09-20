/* Express Pick-Up — экран отдельной точки выдачи */
(function () {
  const { api, money, hhmm, mmss, el, toast, storage, mountHeader, live, t } = window.EPU;

  let venueId = null;
  let data = null;
  let stream = null;
  let mediaStream = null;
  let animationFrame = null;
  let processingScan = false;
  let lastVideoFrame = 0;
  const $ = id => document.getElementById(id);

  /**
   * Только что готовые заказы — сверху табло.
   * Список идёт по времени готовности, и новый готовый заказ вставал в конец:
   * сотрудник за стойкой и гость у табло его не замечали. Пока заказ не
   * выдан и не прошло пять минут, он держится сверху с пометкой.
   */
  const seenReady = new Set();
  const freshReady = new Map();
  const FRESH_MS = 5 * 60 * 1000;
  let firstLoad = true;

  function trackFresh(ready) {
    for (const o of ready) {
      if (seenReady.has(o.id)) continue;
      seenReady.add(o.id);
      if (!firstLoad) freshReady.set(o.id, Date.now());
    }
    firstLoad = false;
    for (const [id, ts] of freshReady) {
      if (!ready.some(o => o.id === id) || Date.now() - ts > FRESH_MS) freshReady.delete(id);
    }
  }

  function orderedReady(ready) {
    const pinned = ready.filter(o => freshReady.has(o.id)).sort((a, b) => freshReady.get(b.id) - freshReady.get(a.id));
    return pinned.concat(ready.filter(o => !freshReady.has(o.id)));
  }

  /**
   * Выдача без сканирования — запасной путь.
   *
   * Основной способ подтверждения — QR гостя: сотрудник сканирует код, и
   * система точно знает, что заказ получил именно он. Но у гостя может сесть
   * телефон, а камера — не поймать код, поэтому ручная выдача остаётся. Она
   * требует подтверждения и отмечается в заказе как ручная.
   */
  async function hand(order) {
    if (!confirm(t('pickup.manualConfirm', { code: order.code }))) return;
    try {
      await api(`/api/kitchen/orders/${encodeURIComponent(order.id)}/status`, {
        method: 'POST', body: { status: 'picked_up' }
      });
      await refresh();
    } catch (e) {
      toast(e.message || t('common.error'), true);
    }
  }

  function setScannerStatus(text, isError) {
    const node = $('scannerStatus');
    node.textContent = text;
    node.classList.toggle('scanner-error', !!isError);
  }

  function tokenFromQr(value) {
    const raw = String(value || '').trim();
    if (/^[a-z2-9]{12}$/.test(raw)) return raw;
    try {
      const url = new URL(raw, location.origin);
      const match = url.pathname.match(/^\/handoff\/([a-z2-9]{12})\/?$/);
      return match ? match[1] : null;
    } catch (e) { return null; }
  }

  function stopCamera() {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = null;
    if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
    const video = $('scannerVideo');
    if (video) video.srcObject = null;
    if ($('scannerViewport')) $('scannerViewport').classList.remove('camera-active');
  }

  function resetScanner() {
    stopCamera();
    processingScan = false;
    lastVideoFrame = 0;
    $('scannerResult').classList.add('hidden');
    $('scannerViewport').classList.remove('hidden');
    $('scannerActions').classList.remove('hidden');
    $('scannerPlaceholder').classList.remove('hidden');
    $('qrImageInput').value = '';
    setScannerStatus(t('pickup.scannerReady'), false);
  }

  function openScanner() {
    resetScanner();
    $('scannerModal').classList.remove('hidden');
    document.body.classList.add('scanner-open');
    $('closeScanner').focus();
    startCamera();
  }

  function closeScanner() {
    stopCamera();
    processingScan = false;
    $('scannerModal').classList.add('hidden');
    document.body.classList.remove('scanner-open');
  }

  function showScanResult(ok, title, text) {
    stopCamera();
    $('scannerViewport').classList.add('hidden');
    $('scannerActions').classList.add('hidden');
    $('scannerResult').classList.remove('hidden');
    $('scannerResult').classList.toggle('success', ok);
    $('scannerResult').classList.toggle('failed', !ok);
    $('scannerResultIcon').textContent = ok ? '✓' : '!';
    $('scannerResultTitle').textContent = title;
    $('scannerResultText').textContent = text || '';
    setScannerStatus('', false);
    $('scanNext').focus();
  }

  async function confirmScannedQr(value) {
    const token = tokenFromQr(value);
    if (!token) {
      processingScan = false;
      setScannerStatus(t('pickup.invalidQr'), true);
      if (mediaStream) animationFrame = requestAnimationFrame(scanVideoFrame);
      return;
    }

    stopCamera();
    try {
      const result = await api('/api/pickup/confirm', {
        method: 'POST', body: { token, venueId }
      });
      try { if (navigator.vibrate) navigator.vibrate([100, 50, 180]); } catch (e) { /* нет вибрации */ }
      showScanResult(true,
        result.alreadyIssued ? t('pickup.alreadyIssued', { code: result.order.code }) : t('pickup.scanSuccess', { code: result.order.code }),
        t('pickup.scanSynced'));
      await refresh();
    } catch (e) {
      const titles = {
        order_not_ready: t('handoff.notReady'),
        wrong_venue: t('pickup.wrongVenue'),
        unknown_order: t('pickup.unknownOrder')
      };
      showScanResult(false, titles[e.error] || t('pickup.scanFailed'), e.message || t('common.error'));
    }
  }

  function decodeCanvas(canvas) {
    if (typeof window.jsQR !== 'function') throw new Error(t('pickup.scannerUnavailable'));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return window.jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
  }

  function scanVideoFrame(now) {
    if (!mediaStream || processingScan) return;
    animationFrame = requestAnimationFrame(scanVideoFrame);
    if (now - lastVideoFrame < 140) return;
    lastVideoFrame = now;

    const video = $('scannerVideo');
    if (video.readyState < 2 || !video.videoWidth) return;
    const canvas = $('scannerCanvas');
    const scale = Math.min(1, 960 / video.videoWidth);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, canvas.width, canvas.height);

    try {
      const found = decodeCanvas(canvas);
      if (found && found.data) {
        processingScan = true;
        setScannerStatus(t('pickup.qrFound'), false);
        confirmScannedQr(found.data);
      }
    } catch (e) {
      stopCamera();
      setScannerStatus(e.message || t('pickup.scannerUnavailable'), true);
    }
  }

  async function startCamera() {
    stopCamera();
    processingScan = false;
    if (typeof window.jsQR !== 'function') {
      setScannerStatus(t('pickup.scannerUnavailable'), true);
      return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setScannerStatus(t('pickup.cameraHttpHint'), false);
      return;
    }
    setScannerStatus(t('pickup.cameraStarting'), false);
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }, audio: false
      });
      const video = $('scannerVideo');
      video.srcObject = mediaStream;
      await video.play();
      $('scannerPlaceholder').classList.add('hidden');
      $('scannerViewport').classList.add('camera-active');
      setScannerStatus(t('pickup.scanning'), false);
      animationFrame = requestAnimationFrame(scanVideoFrame);
    } catch (e) {
      stopCamera();
      setScannerStatus(t(e && e.name === 'NotAllowedError' ? 'pickup.cameraDenied' : 'pickup.cameraFailed'), true);
    }
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error(t('pickup.photoFailed'))); };
      image.src = url;
    });
  }

  async function scanPhoto(file) {
    if (!file || processingScan) return;
    processingScan = true;
    stopCamera();
    setScannerStatus(t('pickup.photoReading'), false);
    try {
      const image = await loadImage(file);
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      const scale = Math.min(1, 1400 / Math.max(width, height));
      const canvas = $('scannerCanvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext('2d', { willReadFrequently: true }).drawImage(image, 0, 0, canvas.width, canvas.height);
      const found = decodeCanvas(canvas);
      if (!found || !found.data) {
        processingScan = false;
        setScannerStatus(t('pickup.qrNotFound'), true);
        return;
      }
      await confirmScannedQr(found.data);
    } catch (e) {
      processingScan = false;
      setScannerStatus(e.message || t('pickup.photoFailed'), true);
    } finally {
      $('qrImageInput').value = '';
    }
  }

  function render() {
    if (!data) return;
    $('pointLine').textContent = data.venue.name + ' · ' + data.venue.pickupPoint;

    const ready = $('readyList');
    ready.innerHTML = '';
    $('readyEmpty').classList.toggle('hidden', data.ready.length > 0);
    for (const o of orderedReady(data.ready)) {
      const isFresh = freshReady.has(o.id);
      ready.appendChild(el('div', { class: 'board-code' + (isFresh ? ' board-fresh' : '') }, [
        isFresh ? el('div', { class: 'badge badge-brand', style: 'margin-bottom:6px', text: t('pickup.newBadge') }) : null,
        el('div', { class: 'c', text: o.code }),
        el('div', { class: 'tiny faint', style: 'margin-top:4px', text: o.guestName || t('pickup.ready') }),
        o.arrivedAt ? el('div', { class: 'badge badge-ok', style: 'margin-top:6px', text: t('pickup.guestHere') }) : null,
        o.paymentStatus !== 'paid'
          ? el('div', { class: 'badge badge-warn', style: 'margin-top:6px', text: money(o.total) })
          : null,
        el('button', {
          class: 'btn btn-primary btn-sm', type: 'button', style: 'margin-top:9px;width:100%',
          text: t('pickup.openScanner'), onclick: openScanner
        }),
        el('button', {
          class: 'btn btn-sm btn-ghost', style: 'margin-top:6px;width:100%;font-size:12px',
          type: 'button', text: t('pickup.manual'), onclick: () => hand(o)
        })
      ]));
    }

    const cooking = $('cookingList');
    cooking.innerHTML = '';
    for (const o of data.cooking) {
      cooking.appendChild(el('div', { class: 'board-waiting' }, [
        el('span', { class: 'c', text: o.code }),
        el('div', { class: 'tiny faint num', text: hhmm(o.slotStart) })
      ]));
    }
    if (!data.cooking.length) cooking.appendChild(el('div', { class: 'tiny faint', text: '—' }));

    const recent = $('recentList');
    recent.innerHTML = '';
    for (const o of data.recentlyPicked) {
      recent.appendChild(el('div', { class: 'row-between small muted' }, [
        el('span', { class: 'num', text: o.code }),
        el('span', { class: 'badge badge-ok', text: t('pickup.issued') }),
        el('span', { class: 'tiny faint num', text: hhmm(o.pickedUpAt) })
      ]));
    }
    if (!data.recentlyPicked.length) recent.appendChild(el('div', { class: 'tiny faint', text: '—' }));
  }

  async function refresh() {
    try {
      data = await api('/api/pickup/' + encodeURIComponent(venueId));
      trackFresh(data.ready);
      render();
    } catch (e) {
      toast(e.message || t('common.error'), true);
    }
  }

  async function init() {
    mountHeader('pickup');
    window.I18N.apply();

    $('openScanner').onclick = openScanner;
    $('closeScanner').onclick = closeScanner;
    $('startCamera').onclick = startCamera;
    $('takeQrPhoto').onclick = () => $('qrImageInput').click();
    $('qrImageInput').onchange = () => scanPhoto($('qrImageInput').files[0]);
    $('scanNext').onclick = () => { resetScanner(); startCamera(); };
    $('scannerModal').onclick = ev => { if (ev.target === $('scannerModal')) closeScanner(); };
    $('closeScanner').setAttribute('aria-label', t('pickup.closeScanner'));
    document.addEventListener('keydown', ev => {
      if (ev.key === 'Escape' && !$('scannerModal').classList.contains('hidden')) closeScanner();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && !$('scannerModal').classList.contains('hidden')) {
        stopCamera();
        setScannerStatus(t('pickup.cameraPaused'), false);
      }
    });
    window.addEventListener('beforeunload', stopCamera);

    const venues = await api('/api/venues');
    venueId = window.EPU.qs('venue') || storage.get('kitchenVenue', null) || venues[0].id;
    if (!venues.some(v => v.id === venueId)) venueId = venues[0].id;

    const select = $('venueSelect');
    for (const v of venues) select.appendChild(el('option', { value: v.id, text: v.name }));
    select.value = venueId;
    select.onchange = async () => {
      closeScanner();
      venueId = select.value;
      storage.set('kitchenVenue', venueId);
      if (stream) stream.update(venueId);
      seenReady.clear(); freshReady.clear(); firstLoad = true;
      await refresh();
    };

    await refresh();
    stream = live(venueId, () => refresh());
    setInterval(() => { $('clock').textContent = window.EPU.venueNow().toISOString().slice(11, 19); }, 1000);
    setInterval(refresh, 20000);
    document.addEventListener('langchange', () => {
      $('closeScanner').setAttribute('aria-label', t('pickup.closeScanner'));
      render();
    });
  }

  // экран персонала открывается только после ввода кода заведения
  window.EPU.staffGate('/api/staff/check', init);
})();
