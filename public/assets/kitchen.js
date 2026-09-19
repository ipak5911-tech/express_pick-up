/* Express Pick-Up — кухонный экран: единая очередь, время «к которому нужен заказ» */
(function () {
  const { api, hhmm, mmss, el, toast, storage, mountHeader, live, t, loadClass } = window.EPU;

  let venueId = null;
  let data = null;
  let stream = null;
  const $ = id => document.getElementById(id);

  function ticketClass(order) {
    if (order.status === 'ready') return 'ticket ready';
    const cookBy = new Date(order.cookStart || order.slotStart).getTime();
    const diff = cookBy - Date.now();
    if (order.status === 'new' && diff <= 0) return 'ticket now';
    if (diff <= 5 * 60000) return 'ticket soon';
    return 'ticket';
  }

  function timingLine(order) {
    const slotTs = new Date(order.slotStart).getTime();
    const cookTs = new Date(order.cookStart || order.slotStart).getTime();
    const now = Date.now();
    if (order.status === 'ready') return { text: t('kitchen.readyBy', { t: hhmm(order.slotStart) }), cls: 'badge badge-ok' };
    if (order.status === 'new' && now >= cookTs) {
      return { text: t('kitchen.startNow'), cls: 'badge badge-danger' };
    }
    if (order.status === 'cooking' && now > slotTs) {
      return { text: t('kitchen.overdue') + ' ' + mmss(now - slotTs), cls: 'badge badge-danger' };
    }
    if (order.status === 'cooking') {
      return { text: t('kitchen.readyBy', { t: hhmm(order.slotStart) }) + ' · ' + mmss(slotTs - now), cls: 'badge badge-warn' };
    }
    return { text: t('kitchen.startBy', { t: hhmm(order.cookStart || order.slotStart) }), cls: 'badge' };
  }

  function actionFor(order) {
    if (order.status === 'new') return { label: t('kitchen.start'), cls: 'btn btn-sm btn-primary' };
    if (order.status === 'cooking') return { label: t('kitchen.done'), cls: 'btn btn-sm btn-ok' };
    return { label: t('kitchen.handed'), cls: 'btn btn-sm' };
  }

  /** Снятие заказа заведением: кончился продукт, сломалось оборудование. */
  async function cancelOrder(order) {
    const reason = prompt(t('kitchen.cancelReason'), '');
    if (reason === null) return;
    try {
      const res = await api(`/api/kitchen/orders/${encodeURIComponent(order.id)}/cancel`, {
        method: 'POST', body: { reason }
      });
      if (res.refund === 'due') toast(t('kitchen.refundDue'));
      await refresh();
    } catch (e) {
      toast(e.message || t('common.error'), true);
    }
  }

  async function markNoShow(order) {
    try {
      await api(`/api/kitchen/orders/${encodeURIComponent(order.id)}/no-show`, { method: 'POST' });
      await refresh();
    } catch (e) {
      toast(e.message || t('common.error'), true);
    }
  }

  async function advance(order) {
    try {
      await api(`/api/kitchen/orders/${encodeURIComponent(order.id)}/advance`, { method: 'POST' });
      await refresh();
    } catch (e) {
      toast(e.message || t('common.error'), true);
    }
  }

  function renderForecast() {
    const host = $('forecast');
    host.innerHTML = '';
    host.style.alignItems = 'flex-start';
    const H = 78;
    const rows = data.forecast;
    // шкала от зарезервированной доли: именно её наполнение решает, отдавать ли слот гостю
    const scale = Math.max(1, ...rows.map(f => Math.max(f.capacitySeconds, f.workSeconds + f.counterSeconds)));
    const px = sec => Math.round((sec / scale) * H);

    for (const f of rows) {
      const expressH = f.workSeconds ? Math.max(2, px(f.workSeconds)) : 0;
      const counterH = f.counterSeconds ? Math.max(2, px(f.counterSeconds)) : 0;
      const tone = f.loadPct >= 90 ? 'danger' : f.loadPct >= 60 ? 'warn' : 'ok';

      host.appendChild(el('div', { style: 'flex:1 1 0;min-width:0;text-align:center' }, [
        el('div', {
          style: `height:${H + 4}px;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;position:relative`,
          title: `${f.label} — Express ${Math.round(f.workSeconds / 60)}/${Math.round(f.capacitySeconds / 60)} ${t('common.min')}, ` +
                 `${t('kitchen.channelCounter')} ${Math.round(f.counterSeconds / 60)} ${t('common.min')}, ` +
                 `${t('kitchen.totalLoad')} ${f.totalLoadPct}%`
        }, [
          // пунктир — граница зарезервированной цифровой доли
          el('div', {
            style: `position:absolute;bottom:${px(f.capacitySeconds)}px;left:0;right:0;border-top:1px dashed var(--brand);opacity:.65`
          }),
          counterH ? el('div', {
            style: `width:70%;height:${counterH}px;background:var(--border-strong);border-radius:3px 3px 0 0`
          }) : null,
          expressH ? el('div', {
            style: `width:70%;height:${expressH}px;background:var(--${tone});border-radius:${counterH ? '0' : '3px 3px 0 0'}`
          }) : null
        ]),
        el('div', { class: 'tiny faint num', text: f.label }),
        // высота фиксирована, иначе колонки без выдач выравниваются по низу и график «пляшет»
        el('div', { class: 'tiny', style: 'color:var(--text-faint);min-height:15px', text: f.handoffs ? '\u00d7' + f.handoffs : '' })
      ]));
    }

    const capMin = Math.round(rows[0].capacitySeconds / 60 * 10) / 10;
    $('capacityNote').textContent =
      `${t('kitchen.reserved')} ${data.settings.digitalSharePct}% \u00b7 ${capMin} ${t('common.min')} / ${data.settings.slotMinutes} ${t('common.min')}`;
  }

  function render() {
    if (!data) return;
    $('venueLine').textContent = data.venue.name + ' · ' + data.venue.pickupPoint;
    $('queueCount').textContent = data.queue.length;
    $('queueEmpty').classList.toggle('hidden', data.queue.length > 0);
    renderForecast();

    const host = $('queue');
    host.innerHTML = '';
    for (const order of data.queue) {
      const timing = timingLine(order);
      const action = actionFor(order);
      host.appendChild(el('div', { class: ticketClass(order) }, [
        el('div', { class: 'ticket-head' }, [
          el('span', { class: 'ticket-code', text: order.code }),
          el('span', { class: timing.cls, text: timing.text })
        ]),
        el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, [
          el('span', {
            class: 'badge ' + (order.channel === 'counter' ? '' : 'badge-brand'),
            text: order.channel === 'counter' ? t('kitchen.channelCounter') : t('kitchen.channelExpress')
          }),
          el('span', { class: 'badge', text: t('kitchen.work', { n: Math.max(1, Math.round(order.workSeconds / 60)) }) }),
          order.paymentStatus !== 'paid' ? el('span', { class: 'badge badge-warn', text: t('kitchen.unpaid') }) : null,
          order.arrivedAt ? el('span', { class: 'badge badge-ok', text: t('kitchen.guestHere') }) : null
        ]),
        el('ul', { class: 'ticket-items' }, order.lines.map(l => el('li', {}, [
          el('b', { text: l.qty + '× ' }),
          el('span', { text: l.name }),
          l.optionNames && l.optionNames.length
            ? el('div', { class: 'tiny faint', text: l.optionNames.join(' · ') })
            : null
        ]))),
        order.comment ? el('div', { class: 'tiny', style: 'color:var(--warn)', text: '⚑ ' + order.comment }) : null,
        el('div', { class: 'row-between' }, [
          el('span', { class: 'tiny faint num', text: order.guestName || '—' }),
          el('div', { class: 'row', style: 'gap:6px' }, [
            order.status === 'ready'
              ? el('button', {
                  class: 'btn btn-sm btn-ghost', type: 'button', text: t('kitchen.noShow'),
                  title: t('kitchen.noShowHint'), onclick: () => markNoShow(order)
                })
              : el('button', {
                  class: 'btn btn-sm btn-ghost', type: 'button', text: t('kitchen.cancel'),
                  title: t('kitchen.cancelHint'), onclick: () => cancelOrder(order)
                }),
            el('button', { class: action.cls, type: 'button', text: action.label, onclick: () => advance(order) })
          ])
        ])
      ]));
    }
  }

  async function refresh() {
    try {
      data = await api('/api/kitchen/' + encodeURIComponent(venueId));
      render();
    } catch (e) {
      toast(e.message || t('common.error'), true);
    }
  }

  async function init() {
    mountHeader('kitchen');
    window.I18N.apply();

    const venues = await api('/api/venues');
    venueId = window.EPU.qs('venue') || storage.get('kitchenVenue', null) || venues[0].id;
    if (!venues.some(v => v.id === venueId)) venueId = venues[0].id;

    const select = $('venueSelect');
    for (const v of venues) select.appendChild(el('option', { value: v.id, text: v.name }));
    select.value = venueId;
    select.onchange = async () => {
      venueId = select.value;
      storage.set('kitchenVenue', venueId);
      if (stream) stream.update(venueId);
      await refresh();
    };

    await refresh();
    stream = live(venueId, () => refresh());

    setInterval(() => {
      $('clock').textContent = window.EPU.venueNow().toISOString().slice(11, 19);
      render();
    }, 1000);
    setInterval(refresh, 20000);

    document.addEventListener('langchange', render);
  }

  // экран персонала открывается только после ввода кода заведения
  window.EPU.staffGate('/api/staff/check', init);
})();
