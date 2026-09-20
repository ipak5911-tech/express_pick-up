/* Express Pick-Up — подтверждение выдачи после сканирования QR сотрудником */
(function () {
  const { api, el, mountHeader, staffGate, t } = window.EPU;
  const parts = location.pathname.split('/').filter(Boolean);
  const token = parts[0] === 'handoff' ? (parts[1] || '') : '';
  const host = document.getElementById('handoffResult');

  function show(title, text, ok) {
    host.innerHTML = '';
    host.style.borderColor = ok ? 'var(--ok)' : 'var(--danger)';
    host.appendChild(el('div', { style: 'font-size:48px', text: ok ? '✓' : '!' }));
    host.appendChild(el('h2', { style: 'margin:8px 0', text: title }));
    if (text) host.appendChild(el('p', { class: 'muted', text }));
    host.appendChild(el('a', { class: 'btn btn-primary', href: '/pickup', text: t('handoff.openPickup') }));
  }

  async function confirmHandoff() {
    if (!/^[a-z2-9]{12}$/.test(token)) {
      show(t('handoff.invalid'), t('handoff.invalidDesc'), false);
      return;
    }
    try {
      const result = await api('/api/pickup/confirm', { method: 'POST', body: { token } });
      const title = result.alreadyIssued
        ? t('handoff.already', { code: result.order.code })
        : t('handoff.success', { code: result.order.code });
      show(title, t('handoff.synced'), true);
    } catch (e) {
      const notReady = e.error === 'order_not_ready';
      show(notReady ? t('handoff.notReady') : t('handoff.failed'), e.message || t('common.error'), false);
    }
  }

  function init() {
    mountHeader('pickup');
    window.I18N.apply();
    staffGate('/api/staff/check', confirmHandoff);
  }

  init();
})();
