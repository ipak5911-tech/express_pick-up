/* Express Pick-Up — экран отдельной точки выдачи */
(function () {
  const { api, money, hhmm, mmss, el, toast, storage, mountHeader, live, t } = window.EPU;

  let venueId = null;
  let data = null;
  let stream = null;
  const $ = id => document.getElementById(id);

  async function hand(order) {
    try {
      await api(`/api/kitchen/orders/${encodeURIComponent(order.id)}/status`, {
        method: 'POST', body: { status: 'picked_up' }
      });
      await refresh();
    } catch (e) {
      toast(e.message || t('common.error'), true);
    }
  }

  function render() {
    if (!data) return;
    $('pointLine').textContent = data.venue.name + ' · ' + data.venue.pickupPoint;

    const ready = $('readyList');
    ready.innerHTML = '';
    $('readyEmpty').classList.toggle('hidden', data.ready.length > 0);
    for (const o of data.ready) {
      ready.appendChild(el('div', { class: 'board-code' }, [
        el('div', { class: 'c', text: o.code }),
        el('div', { class: 'tiny faint', style: 'margin-top:4px', text: o.guestName || t('pickup.ready') }),
        o.arrivedAt ? el('div', { class: 'badge badge-ok', style: 'margin-top:6px', text: t('pickup.guestHere') }) : null,
        o.paymentStatus !== 'paid'
          ? el('div', { class: 'badge badge-warn', style: 'margin-top:6px', text: money(o.total) })
          : null,
        el('button', {
          class: 'btn btn-sm btn-ok', style: 'margin-top:9px;width:100%', type: 'button',
          text: t('pickup.hand'), onclick: () => hand(o)
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
        el('span', { class: 'tiny faint num', text: hhmm(o.pickedUpAt) })
      ]));
    }
    if (!data.recentlyPicked.length) recent.appendChild(el('div', { class: 'tiny faint', text: '—' }));
  }

  async function refresh() {
    try {
      data = await api('/api/pickup/' + encodeURIComponent(venueId));
      render();
    } catch (e) {
      toast(e.message || t('common.error'), true);
    }
  }

  async function init() {
    mountHeader('pickup');
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
    setInterval(() => { $('clock').textContent = window.EPU.venueNow().toISOString().slice(11, 19); }, 1000);
    setInterval(refresh, 20000);
    document.addEventListener('langchange', render);
  }

  init();
})();
