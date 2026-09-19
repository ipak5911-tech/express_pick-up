/* Express Pick-Up — гостевой сценарий: блюда → время → оплата */
(function () {
  const { api, money, hhmm, el, esc, toast, storage, mountHeader, t, loadClass, debounce } = window.EPU;

  const state = {
    venues: [],
    venue: null,
    cart: [],
    step: 1,
    category: null,
    slots: [],
    slot: null,
    payment: 'online',
    areas: [],
    from: null,          // {lat, lon} — откуда гость едет
    mode: 'auto',        // auto | car | walk
    travel: null,        // результат расчёта дороги
    workSeconds: 0,
    minCookSlots: 1,
    busy: false
  };

  const $ = id => document.getElementById(id);

  // ---------- корзина ----------
  const lineKey = line => line.itemId + '|' + line.options.slice().sort().join(',');

  function cartCount() { return state.cart.reduce((n, l) => n + l.qty, 0); }
  function cartTotal() { return state.cart.reduce((n, l) => n + l.qty * l.unitPrice, 0); }

  function addToCart(item, options, qty) {
    const delta = (item.modifiers || []).flatMap(g => g.options || [])
      .filter(o => options.includes(o.id))
      .reduce((s, o) => s + (o.priceDelta || 0), 0);
    const optionNames = (item.modifiers || []).flatMap(g => g.options || [])
      .filter(o => options.includes(o.id)).map(o => o.name);
    const line = { itemId: item.id, name: item.name, options: options.slice(), optionNames, unitPrice: item.price + delta, qty };
    const existing = state.cart.find(l => lineKey(l) === lineKey(line));
    if (existing) existing.qty += qty;
    else state.cart.push(line);
    invalidateSlots();
    renderMenu();
    renderCartBar();
  }

  function changeQty(line, delta) {
    line.qty += delta;
    if (line.qty <= 0) state.cart = state.cart.filter(l => l !== line);
    invalidateSlots();
    renderMenu();
    renderCartBar();
    if (state.step === 2) loadSlots();
    if (state.step === 3) renderPay();
  }

  function invalidateSlots() { state.slot = null; }

  function cartPayload() {
    return state.cart.map(l => ({ itemId: l.itemId, qty: l.qty, options: l.options }));
  }

  // ---------- заведения ----------
  async function loadVenues() {
    state.venues = await api('/api/venues');
    const list = $('venueList');
    list.innerHTML = '';
    for (const v of state.venues) {
      list.appendChild(el('button', {
        class: 'card', type: 'button', style: 'text-align:left;cursor:pointer',
        onclick: () => selectVenue(v.id)
      }, [
        el('div', { class: 'row-between' }, [
          el('b', { text: v.name, style: 'font-size:16px' }),
          el('span', { class: 'badge', text: v.kind })
        ]),
        el('div', { class: 'small muted', text: v.address }),
        el('div', { class: 'tiny faint', style: 'margin-top:6px' },
          `${t('guest.open')} ${v.serviceHours.from}–${v.serviceHours.to} · ${v.itemsAvailable}/${v.itemsTotal} ${t('guest.items')}`),
        el('div', { class: 'tiny', style: 'margin-top:4px;color:var(--brand-text)' }, '→ ' + v.pickupPoint)
      ]));
    }
    const sel = $('lookupVenue');
    sel.innerHTML = '';
    for (const v of state.venues) sel.appendChild(el('option', { value: v.id, text: v.name }));
  }

  async function selectVenue(id) {
    state.venue = await api('/api/venues/' + encodeURIComponent(id));
    storage.set('venueId', id);
    state.cart = [];
    state.category = null;
    state.step = 1;
    state.slot = null;
    $('venueView').classList.add('hidden');
    $('orderView').classList.remove('hidden');
    $('venueName').textContent = state.venue.name;
    $('venuePoint').textContent = t('guest.pickupPoint') + ': ' + state.venue.pickupPoint;
    renderCats();
    renderMenu();
    renderCartBar();
    goStep(1);
    updateRepeatButton();
  }

  function updateRepeatButton() {
    const last = storage.get('lastOrder', null);
    const show = last && state.venue && last.venueId === state.venue.id && last.items && last.items.length;
    $('repeatBtn').classList.toggle('hidden', !show);
  }

  function repeatLast() {
    const last = storage.get('lastOrder', null);
    if (!last) return;
    let missed = 0;
    state.cart = [];
    for (const raw of last.items) {
      const item = state.venue.menu.find(i => i.id === raw.itemId);
      if (!item || !item.available) { missed++; continue; }
      addToCart(item, raw.options || [], raw.qty || 1);
    }
    toast(missed ? t('guest.repeatFail') : t('guest.repeatDone'), !!missed);
  }

  // ---------- меню ----------
  function categories() {
    const set = [];
    for (const i of state.venue.menu) if (!set.includes(i.category)) set.push(i.category);
    return set;
  }

  function renderCats() {
    const host = $('cats');
    host.innerHTML = '';
    const all = el('button', {
      type: 'button', text: t('guest.all'),
      'aria-pressed': state.category === null,
      onclick: () => { state.category = null; renderCats(); renderMenu(); }
    });
    host.appendChild(all);
    for (const c of categories()) {
      host.appendChild(el('button', {
        type: 'button', text: c,
        'aria-pressed': state.category === c,
        onclick: () => { state.category = c; renderCats(); renderMenu(); }
      }));
    }
  }

  function renderMenu() {
    const host = $('menuList');
    host.innerHTML = '';
    const items = state.venue.menu.filter(i => !state.category || i.category === state.category);
    for (const item of items) {
      const inCart = state.cart.filter(l => l.itemId === item.id);
      const qty = inCart.reduce((n, l) => n + l.qty, 0);
      const hasMods = (item.modifiers || []).length > 0;

      const control = !item.available
        ? el('span', { class: 'badge badge-danger', text: t('guest.stopList') })
        : hasMods
          ? el('button', { class: 'btn btn-sm', type: 'button', text: t('guest.add'), onclick: () => openModifiers(item) })
          : qty > 0
            ? el('div', { class: 'qty' }, [
                el('button', { type: 'button', text: '−', onclick: () => changeQty(inCart[0], -1) }),
                el('span', { text: String(qty) }),
                el('button', { type: 'button', text: '+', onclick: () => changeQty(inCart[0], 1) })
              ])
            : el('button', { class: 'btn btn-sm', type: 'button', text: t('guest.add'), onclick: () => addToCart(item, [], 1) });

      host.appendChild(el('div', { class: 'dish' + (item.available ? '' : ' off') }, [
        el('div', { class: 'dish-body' }, [
          el('div', { class: 'dish-name', text: item.name }),
          el('div', { class: 'dish-desc', text: item.desc || '' }),
          el('div', { class: 'dish-meta' }, [
            el('span', { class: 'dish-price', text: money(item.price) }),
            el('span', { class: 'badge', text: t('guest.prep', { n: Math.max(1, Math.round(item.prepSeconds / 60)) }) }),
            hasMods && qty > 0 ? el('span', { class: 'badge badge-brand', text: '×' + qty }) : null
          ])
        ]),
        el('div', {}, [control])
      ]));
    }
    if (!items.length) host.appendChild(el('div', { class: 'empty', text: t('guest.cartEmpty') }));
  }

  // ---------- модификаторы ----------
  let modState = null;

  function openModifiers(item) {
    modState = { item, qty: 1, selected: {} };
    for (const g of item.modifiers || []) {
      if (g.required && g.options.length) modState.selected[g.id] = [g.options[0].id];
      else modState.selected[g.id] = [];
    }
    $('modName').textContent = item.name;
    $('modDesc').textContent = item.desc || '';
    $('modQty').textContent = '1';
    renderModGroups();
    updateModPrice();
    $('modDialog').showModal();
  }

  function renderModGroups() {
    const host = $('modGroups');
    host.innerHTML = '';
    for (const g of modState.item.modifiers || []) {
      const rows = (g.options || []).map(opt => {
        const picked = modState.selected[g.id].includes(opt.id);
        return el('label', {
          class: 'row-between', style: 'padding:7px 0;border-bottom:1px solid var(--border);cursor:pointer'
        }, [
          el('span', { class: 'row', style: 'gap:8px' }, [
            el('input', {
              type: g.required ? 'radio' : 'checkbox', name: 'g-' + g.id, checked: picked,
              style: 'width:auto',
              onchange: ev => {
                if (g.required) modState.selected[g.id] = [opt.id];
                else if (ev.target.checked) modState.selected[g.id].push(opt.id);
                else modState.selected[g.id] = modState.selected[g.id].filter(x => x !== opt.id);
                updateModPrice();
              }
            }),
            el('span', { text: opt.name })
          ]),
          el('span', { class: 'small muted', text: opt.priceDelta ? '+' + money(opt.priceDelta) : '' })
        ]);
      });
      host.appendChild(el('div', { style: 'margin-bottom:12px' }, [
        el('div', { class: 'row', style: 'gap:6px;margin-bottom:2px' }, [
          el('b', { class: 'small', text: g.name }),
          g.required ? el('span', { class: 'badge badge-warn', text: t('guest.required') }) : null
        ]),
        ...rows
      ]));
    }
  }

  function modOptions() {
    return Object.values(modState.selected).flat();
  }

  function updateModPrice() {
    const opts = modOptions();
    const delta = (modState.item.modifiers || []).flatMap(g => g.options || [])
      .filter(o => opts.includes(o.id)).reduce((s, o) => s + (o.priceDelta || 0), 0);
    const sum = (modState.item.price + delta) * modState.qty;
    $('modAdd').textContent = t('guest.addToCart', { sum: Math.round(sum) });
  }

  // ---------- шаги ----------
  function goStep(n) {
    state.step = n;
    for (const id of ['step1', 'step2', 'step3']) $(id).classList.add('hidden');
    $('step' + n).classList.remove('hidden');
    document.querySelectorAll('.step').forEach(node => {
      const s = Number(node.dataset.step);
      node.classList.toggle('active', s === n);
      node.classList.toggle('done', s < n);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (n === 2) loadSlots();
    if (n === 3) renderPay();
    renderCartBar();
  }

  function renderCartBar() {
    const bar = $('cartBar');
    const count = cartCount();
    bar.classList.toggle('hidden', !state.venue || (count === 0 && state.step === 1));
    $('backBtn').classList.toggle('hidden', state.step === 1);
    $('cartCount').textContent = count
      ? t('guest.cartSummary', { n: count, sum: Math.round(cartTotal()) })
      : t('guest.cartEmpty');
    $('cartTotal').textContent = money(cartTotal());

    const main = $('mainBtn');
    if (state.step === 1) {
      main.textContent = t('guest.toTime');
      main.disabled = count === 0;
    } else if (state.step === 2) {
      main.textContent = t('slots.toPay');
      main.disabled = !state.slot;
    } else {
      main.textContent = state.payment === 'online'
        ? t('pay.payNow', { sum: Math.round(cartTotal()) })
        : t('pay.confirm', { sum: Math.round(cartTotal()) });
      main.disabled = state.busy;
    }
  }

  // ---------- карта ----------
  // Leaflet и тайлы OpenStreetMap грузятся лениво и только здесь. Если сети нет,
  // карта молча исчезает, а выбор заведения остаётся списком: экраны кухни и
  // выдачи от внешних ресурсов не зависят вовсе.

  function loadAsset(tag, attrs) {
    return new Promise((resolve, reject) => {
      const node = document.createElement(tag);
      Object.assign(node, attrs);
      node.onload = resolve;
      node.onerror = reject;
      document.head.appendChild(node);
    });
  }

  async function initMap() {
    const host = $('venueMap');
    if (!host) return;
    try {
      await loadAsset('link', { rel: 'stylesheet', href: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css' });
      await loadAsset('script', { src: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js' });
    } catch (e) {
      host.remove();
      return;
    }
    if (!window.L) { host.remove(); return; }

    const points = state.venues.filter(v => v.location);
    if (!points.length) { host.remove(); return; }

    const map = L.map(host, { scrollWheelZoom: false, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap'
    }).addTo(map);

    const bounds = [];
    for (const v of points) {
      // iconSize: null — иначе Leaflet обрежет подпись до размера иконки по умолчанию
      const icon = L.divIcon({
        className: 'epu-pin',
        iconSize: null,
        html: `<span class="epu-pin-dot"></span><span class="epu-pin-label">${esc(v.name)}</span>`
      });
      L.marker([v.location.lat, v.location.lon], { icon })
        .addTo(map)
        .on('click', () => selectVenue(v.id));
      bounds.push([v.location.lat, v.location.lon]);
    }
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 14 });
    setTimeout(() => map.invalidateSize(), 120);
  }

  // ---------- дорога гостя ----------
  // Слот, до которого гость не успевает доехать, бесполезен: блюдо остынет
  // на полке. Поэтому дорога — такое же ограничение, как и мощность кухни.

  async function loadAreas() {
    try {
      state.areas = await api('/api/areas');
    } catch (e) {
      state.areas = [];
    }
    const select = $('areaSelect');
    select.innerHTML = '';
    select.appendChild(el('option', { value: '', text: t('travel.area') }));
    for (const a of state.areas) select.appendChild(el('option', { value: a.id, text: a.name }));
    const saved = storage.get('areaId', null);
    if (saved && state.areas.some(a => a.id === saved)) {
      select.value = saved;
      applyArea(saved, false);
    }
  }

  function applyArea(areaId, reload = true) {
    const area = state.areas.find(a => a.id === areaId);
    state.from = area ? { lat: area.lat, lon: area.lon } : null;
    storage.set('areaId', areaId || '');
    if (reload && state.step === 2) loadSlots();
  }

  function locateMe() {
    if (!navigator.geolocation) return toast(t('travel.denied'), true);
    const btn = $('geoBtn');
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      pos => {
        btn.disabled = false;
        state.from = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        $('areaSelect').value = '';
        storage.set('areaId', '');
        if (state.step === 2) loadSlots();
      },
      () => {
        btn.disabled = false;
        toast(t('travel.denied'), true);
      },
      { timeout: 8000, maximumAge: 120000 }
    );
  }

  function renderTravel() {
    const badge = $('travelBadge');
    const note = $('travelNote');
    document.querySelectorAll('#modeSwitch button').forEach(b =>
      b.setAttribute('aria-pressed', b.dataset.mode === state.mode));

    if (!state.travel) {
      badge.hidden = true;
      note.textContent = t('travel.none');
      return;
    }
    const tr = state.travel;
    badge.hidden = false;
    badge.className = 'badge ' + (tr.level === 'heavy' ? 'badge-danger' : tr.level === 'moderate' ? 'badge-warn' : 'badge-ok');
    badge.textContent = t('travel.eta', { n: tr.minutes, km: String(tr.distanceKm).replace('.', ',') });

    const parts = [t('travel.' + tr.level)];
    if (tr.mode === 'car' && tr.parkingMinutes) parts.push(t('travel.parking', { n: tr.parkingMinutes }));
    parts.push(t('travel.model'));
    note.textContent = parts.join(' · ');
  }

  // ---------- слоты ----------
  const loadSlots = debounce(async function () {
    if (!state.venue || !state.cart.length) return;
    const grid = $('slotGrid');
    grid.innerHTML = '<div class="small muted">' + esc(t('common.loading')) + '</div>';
    let data;
    try {
      data = await api(`/api/venues/${encodeURIComponent(state.venue.id)}/slots`, {
        method: 'POST',
        body: { items: cartPayload(), from: state.from, mode: state.mode === 'auto' ? undefined : state.mode }
      });
    } catch (e) {
      grid.innerHTML = '';
      toast(e.message || t('common.error'), true);
      return;
    }
    state.slots = data.slots;
    state.travel = data.travel;
    state.workSeconds = data.workSeconds;
    state.minCookSlots = data.minCookSlots;
    state.tooLarge = data.tooLarge;
    state.maxWorkMinutes = Math.floor(data.maxWorkSeconds / 60);
    renderTravel();
    renderSlots();
  }, 120);

  function renderSlots() {
    const grid = $('slotGrid');
    grid.innerHTML = '';
    $('workloadNote').textContent = t('slots.workload', {
      n: Math.max(1, Math.round(state.workSeconds / 60)), s: state.minCookSlots
    });

    const visible = state.slots.filter(s => s.reason !== 'closed');
    const free = visible.filter(s => s.available);
    const empty = $('slotEmpty');
    empty.classList.toggle('hidden', free.length > 0);
    empty.textContent = state.tooLarge
      ? t('slots.tooLarge', { n: Math.floor(state.maxWorkMinutes || 0) })
      : t('slots.none');

    for (const slot of visible.slice(0, 24)) {
      const sub = slot.available
        ? `${slot.maxOrders - slot.ordersInSlot} ${t('slots.free')}`
        : slot.reason === 'kitchen_full' ? t('slots.busyKitchen')
        : slot.reason === 'handoff_full' ? t('slots.busyHandoff')
        : slot.reason === 'too_far' ? t('slots.tooFar') : t('slots.closed');

      grid.appendChild(el('button', {
        class: 'slot', type: 'button', disabled: !slot.available,
        'aria-pressed': state.slot && state.slot.start === slot.start,
        onclick: () => {
          state.slot = slot;
          renderSlots();
          renderCartBar();
        }
      }, [
        el('span', { class: 'slot-time', text: slot.label }),
        el('span', { class: 'slot-sub', text: sub }),
        el('span', { class: 'slot-bar' }, [
          el('i', { class: loadClass(slot.loadPct), style: `width:${Math.min(100, slot.loadPct)}%` })
        ])
      ]));
    }

    const chosen = $('slotChosen');
    if (state.slot) {
      chosen.hidden = false;
      chosen.textContent = t('slots.selected', { t: state.slot.label });
    } else {
      chosen.hidden = true;
    }
  }

  // ---------- оплата ----------
  function renderPay() {
    const host = $('paySummary');
    host.innerHTML = '';
    for (const l of state.cart) {
      host.appendChild(el('div', { class: 'line' }, [
        el('div', { class: 'line-name' }, [
          el('div', { text: l.name }),
          l.optionNames.length ? el('div', { class: 'line-opts', text: l.optionNames.join(' · ') }) : null
        ]),
        el('div', { class: 'num', style: 'white-space:nowrap' }, `×${l.qty}  ${money(l.qty * l.unitPrice)}`)
      ]));
    }
    if (state.slot) {
      host.appendChild(el('div', { class: 'row-between', style: 'margin-top:10px' }, [
        el('span', { class: 'small muted', text: t('order.pickupAt', { t: state.slot.label }) }),
        el('span', { class: 'badge badge-brand', text: state.venue.pickupPoint })
      ]));
    }
    $('payTotal').textContent = money(cartTotal());
    $('onlineMark').classList.toggle('hidden', state.payment !== 'online');
    $('onsiteMark').classList.toggle('hidden', state.payment !== 'onsite');
    $('payOnline').style.borderColor = state.payment === 'online' ? 'var(--brand)' : '';
    $('payOnsite').style.borderColor = state.payment === 'onsite' ? 'var(--brand)' : '';
    renderCartBar();
  }

  async function submitOrder() {
    if (state.busy) return;
    state.busy = true;
    renderCartBar();
    try {
      const data = await api(`/api/venues/${encodeURIComponent(state.venue.id)}/orders`, {
        method: 'POST',
        body: {
          items: cartPayload(),
          slotStart: state.slot.start,
          payment: state.payment,
          name: $('guestName').value.trim(),
          phone: $('guestPhone').value.trim(),
          comment: $('guestComment').value.trim()
        }
      });
      storage.set('lastOrder', { venueId: state.venue.id, items: cartPayload() });
      const tokens = storage.get('tokens', []);
      tokens.unshift(data.order.token);
      storage.set('tokens', tokens.slice(0, 10));
      location.href = data.statusUrl;
    } catch (e) {
      state.busy = false;
      const map = {
        kitchen_full: t('slots.busyKitchen'),
        handoff_full: t('slots.busyHandoff'),
        slot_passed: t('slots.none'),
        stop_list: e.message
      };
      toast(map[e.error] || e.message || t('common.error'), true);
      if (['kitchen_full', 'handoff_full', 'slot_passed'].includes(e.error)) {
        state.slot = null;
        goStep(2);
      }
      renderCartBar();
    }
  }

  // ---------- события ----------
  function bind() {
    $('changeVenue').onclick = () => {
      storage.del('venueId');
      state.venue = null;
      state.cart = [];
      $('orderView').classList.add('hidden');
      $('venueView').classList.remove('hidden');
      $('cartBar').classList.add('hidden');
    };

    $('repeatBtn').onclick = repeatLast;

    $('geoBtn').onclick = locateMe;
    $('areaSelect').onchange = ev => applyArea(ev.target.value);
    document.querySelectorAll('#modeSwitch button').forEach(b => {
      b.onclick = () => {
        state.mode = state.mode === b.dataset.mode ? 'auto' : b.dataset.mode;
        renderTravel();
        if (state.step === 2) loadSlots();
      };
    });

    $('backBtn').onclick = () => goStep(Math.max(1, state.step - 1));

    $('mainBtn').onclick = () => {
      if (state.step === 1) goStep(2);
      else if (state.step === 2) goStep(3);
      else if (state.payment === 'online') openPayDialog();
      else submitOrder();
    };

    $('payOnline').onclick = () => { state.payment = 'online'; renderPay(); };
    $('payOnsite').onclick = () => { state.payment = 'onsite'; renderPay(); };

    $('modMinus').onclick = () => { modState.qty = Math.max(1, modState.qty - 1); $('modQty').textContent = modState.qty; updateModPrice(); };
    $('modPlus').onclick = () => { modState.qty = Math.min(20, modState.qty + 1); $('modQty').textContent = modState.qty; updateModPrice(); };
    $('modAdd').onclick = () => {
      addToCart(modState.item, modOptions(), modState.qty);
      $('modDialog').close();
    };

    $('payClose').onclick = () => $('payDialog').close();
    $('payNow').onclick = async () => {
      $('payNow').disabled = true;
      $('payNow').textContent = t('pay.processing');
      setTimeout(async () => {
        $('payDialog').close();
        $('payNow').disabled = false;
        await submitOrder();
      }, 700);
    };

    $('lookupForm').onsubmit = async ev => {
      ev.preventDefault();
      const venueId = $('lookupVenue').value;
      const code = $('lookupCode').value.trim();
      if (!code) return;
      const host = $('lookupResult');
      host.innerHTML = '';
      try {
        const res = await api(`/api/lookup?venue=${encodeURIComponent(venueId)}&code=${encodeURIComponent(code)}`);
        const labels = {
          new: 'order.accepted', cooking: 'order.cooking', ready: 'order.ready',
          picked_up: 'order.picked', cancelled: 'order.cancelled', no_show: 'order.noShow'
        };
        host.appendChild(el('div', {
          class: 'card', style: res.status === 'ready' ? 'border-color:var(--ok)' : ''
        }, [
          el('div', { class: 'row-between' }, [
            el('b', { style: 'font-size:26px;font-variant-numeric:tabular-nums', text: res.code }),
            el('span', {
              class: 'badge ' + (res.status === 'ready' ? 'badge-ok' : 'badge-brand'),
              text: t(labels[res.status] || 'order.accepted')
            })
          ]),
          el('div', { class: 'small muted', style: 'margin-top:6px', text: t('order.pickupAt', { t: hhmm(res.slotStart) }) }),
          res.venue ? el('div', { class: 'tiny faint', text: res.venue.pickupPoint }) : null,
          el('div', { class: 'tiny faint', style: 'margin-top:10px', text: t('lookup.privateHint') })
        ]));
      } catch (e) {
        toast(e.error === 'too_many_lookups' ? e.message : t('lookup.fail'), true);
      }
    };

    document.addEventListener('langchange', () => {
      if (!state.venue) { loadVenues(); return; }
      renderCats(); renderMenu(); renderCartBar();
      if (state.step === 2) { renderTravel(); renderSlots(); }
      if (state.step === 3) renderPay();
      $('venuePoint').textContent = t('guest.pickupPoint') + ': ' + state.venue.pickupPoint;
      updateRepeatButton();
    });
  }

  function openPayDialog() {
    $('payNow').textContent = t('pay.payNow', { sum: Math.round(cartTotal()) });
    $('payDialog').showModal();
  }

  async function init() {
    mountHeader('guest');
    window.I18N.apply();
    bind();
    try {
      await loadVenues();
      await loadAreas();
      initMap();
      const saved = storage.get('venueId', null);
      const preset = window.EPU.qs('venue') || saved;
      if (preset && state.venues.some(v => v.id === preset)) await selectVenue(preset);
    } catch (e) {
      toast(e.message || t('common.error'), true);
    }
  }

  init();
})();
