/* Express Pick-Up — гостевой сценарий: блюда → время → оплата */
(function () {
  const { api, money, hhmm, el, esc, toast, storage, mountHeader, live, t, loadClass, debounce } = window.EPU;

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
    ignoreTravel: false, // гость сказал, что уже рядом
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
    renderCartList();
    renderCartBar();
  }

  function changeQty(line, delta) {
    line.qty += delta;
    if (line.qty <= 0) state.cart = state.cart.filter(l => l !== line);
    // Выбранный слот теряет силу только если работы стало больше: меньший
    // заказ помещается туда же, куда помещался больший.
    if (delta > 0) invalidateSlots();
    afterCartChange();
  }

  /** Убрать строку целиком — независимо от количества и модификаторов. */
  function removeLine(line) {
    state.cart = state.cart.filter(l => l !== line);
    toast(t('guest.removed'));
    afterCartChange();
  }

  function clearCart() {
    if (!state.cart.length) return;
    state.cart = [];
    state.slot = null;
    toast(t('guest.cartCleared'));
    afterCartChange();
  }

  /** Общие последствия любой правки корзины, с учётом текущего шага. */
  function afterCartChange() {
    if (!state.cart.length && state.step !== 1) {
      goStep(1);
      return;
    }
    renderMenu();
    renderCartList();
    renderCartBar();
    if (state.step === 2) loadSlots();
    if (state.step === 3) renderPay();
  }

  function invalidateSlots() { state.slot = null; }

  /** Строка корзины с управлением — одна и та же на шаге меню и на оплате. */
  function cartLine(line, compact) {
    return el('div', { class: 'line', style: 'align-items:center' }, [
      el('div', { class: 'line-name' }, [
        el('div', { text: line.name }),
        line.optionNames.length ? el('div', { class: 'line-opts', text: line.optionNames.join(' \u00b7 ') }) : null
      ]),
      el('div', { class: 'qty' }, [
        el('button', { type: 'button', text: '\u2212', 'aria-label': t('guest.remove'), onclick: () => changeQty(line, -1) }),
        el('span', { text: String(line.qty) }),
        el('button', { type: 'button', text: '+', onclick: () => changeQty(line, 1) })
      ]),
      el('div', { class: 'num', style: 'min-width:82px;text-align:right;white-space:nowrap', text: money(line.qty * line.unitPrice) }),
      el('button', {
        class: 'btn btn-ghost btn-sm', type: 'button', title: t('guest.remove'),
        'aria-label': t('guest.remove'), text: '\u2715',
        style: 'padding:4px 8px;color:var(--danger)', onclick: () => removeLine(line)
      })
    ]);
  }

  /** Корзина на шаге меню: что уже набрано, с возможностью поправить. */
  function renderCartList() {
    const card = $('cartCard');
    const host = $('cartList');
    if (!card || !host) return;
    card.classList.toggle('hidden', state.cart.length === 0);
    host.innerHTML = '';
    for (const line of state.cart) host.appendChild(cartLine(line));
    if (state.cart.length) {
      host.appendChild(el('div', { class: 'row-between', style: 'margin-top:8px' }, [
        el('b', { text: t('common.total') }),
        el('b', { class: 'num', text: money(cartTotal()) })
      ]));
    }
  }

  function cartPayload() {
    return state.cart.map(l => ({ itemId: l.itemId, qty: l.qty, options: l.options }));
  }

  // ---------- заведения ----------
  /** Живой статус заведения: открыто ли и принимает ли заказы прямо сейчас. */
  function statusBadge(v) {
    const st = v.status;
    if (!st) return el('span', { class: 'badge', text: v.kind });
    if (!st.openNow) {
      return el('span', { class: 'badge', text: t('venue.closed') });
    }
    return el('span', {
      class: 'badge ' + (st.acceptingOrders ? 'badge-ok' : 'badge-warn')
    }, [el('span', { class: 'dot' + (st.acceptingOrders ? ' pulse' : '') }), el('span', { text: t('venue.open') })]);
  }

  function statusLine(v) {
    const st = v.status;
    if (!st) return `${v.serviceHours.from}\u2013${v.serviceHours.to}`;
    const parts = [];
    if (!st.openNow) {
      parts.push(st.opensInMinutes != null && st.opensInMinutes < 120
        ? t('venue.opensIn', { n: st.opensInMinutes })
        : t('venue.opensAt', { t: st.opensAt }));
    } else if (!st.acceptingOrders) {
      parts.push(t('venue.noSlots'));
    } else {
      parts.push(t('venue.nextSlot', { t: st.nextSlotLabel }));
      parts.push(t('venue.slotsLeft', { n: st.freeSlots }));
    }
    if (st.closingSoon && st.closesInMinutes != null) {
      parts.push(t('venue.closesIn', { n: st.closesInMinutes }));
    }
    return parts.join(' \u00b7 ');
  }

  function renderVenueList() {
    const list = $('venueList');
    list.innerHTML = '';
    for (const v of state.venues) {
      const st = v.status || {};
      const dim = st.openNow === false;
      list.appendChild(el('button', {
        class: 'card', type: 'button',
        style: 'text-align:left;cursor:pointer' + (dim ? ';opacity:.62' : ''),
        onclick: () => selectVenue(v.id)
      }, [
        el('div', { class: 'row-between' }, [
          el('b', { text: v.name, style: 'font-size:16px' }),
          statusBadge(v)
        ]),
        el('div', { class: 'small muted', text: v.kind + ' \u00b7 ' + v.address }),
        el('div', {
          class: 'tiny', style: 'margin-top:6px;font-weight:600;' +
            (st.openNow === false ? 'color:var(--text-faint)'
              : st.acceptingOrders ? 'color:var(--ok)' : 'color:var(--warn)'),
          text: statusLine(v)
        }),
        v.travel ? el('div', { class: 'row', style: 'gap:6px;margin-top:6px' }, [
          el('span', {
            class: 'badge ' + (v.travel.level === 'heavy' ? 'badge-danger'
              : v.travel.level === 'moderate' ? 'badge-warn' : 'badge-info'),
            text: t(v.travel.mode === 'walk' ? 'guest.travelWalk' : 'guest.travelCar', {
              n: v.travel.minutes, km: String(v.travel.distanceKm).replace('.', ',')
            })
          })
        ]) : null,
        el('div', { class: 'tiny faint', style: 'margin-top:3px' },
          `${v.serviceHours.from}\u2013${v.serviceHours.to} \u00b7 ${v.itemsAvailable}/${v.itemsTotal} ${t('guest.items')}`),
        el('div', { class: 'tiny', style: 'margin-top:4px;color:var(--brand-text)' }, '\u2192 ' + v.pickupPoint)
      ]));
    }
  }

  async function loadVenues() {
    const from = state.from;
    const qs = from ? `?lat=${encodeURIComponent(from.lat)}&lon=${encodeURIComponent(from.lon)}` : '';
    state.venues = await api('/api/venues' + qs);
    renderVenueList();
    updateMapMarkers();
    const sel = $('lookupVenue');
    if (sel.options.length !== state.venues.length) {
      sel.innerHTML = '';
      for (const v of state.venues) sel.appendChild(el('option', { value: v.id, text: v.name }));
    }
  }

  /**
   * Наблюдение за заведениями в реальном времени.
   * Событий недостаточно: открытие и закрытие происходят по часам, а не по
   * действию пользователя, поэтому нужен и таймер, и поток событий.
   */
  async function refreshVenues() {
    if (state.venue) return; // на экране заказа список не нужен
    try { await loadVenues(); } catch (e) { /* сеть моргнула — попробуем позже */ }
  }

  /** Периодический опрос: работает всегда и ни от чего не зависит. */
  function watchVenuesByTimer() {
    setInterval(refreshVenues, 30000);
  }

  /**
   * Поток событий открывается ПОСЛЕ загрузки карты.
   *
   * SSE — долгоживущее соединение. Если открыть его раньше, оно занимает слот
   * в пуле соединений, и короткие загрузки (скрипт карты, тайлы) могут встать
   * в очередь за бесконечным потоком. Сначала короткое, потом долгое.
   */
  function watchVenuesLive() {
    live(null, ev => {
      if (['order_created', 'order_status', 'settings_updated', 'menu_updated'].includes(ev.type)) {
        refreshVenues();
      }
    });
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
    renderCartList();
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
  // Leaflet лежит в репозитории, тайлы OpenStreetMap грузятся лениво и только
  // здесь. Если сети нет, карта показывает пустую подложку, а выбор заведения
  // работает списком: экраны кухни и выдачи от внешних ресурсов не зависят.

  let mapMarkers = {};
  let map = null;
  let meMarker = null;
  let venueBounds = [];
  let poiLayer = null;
  let poiVisible = false;   // на странице заказа рынок по умолчанию скрыт

  function loadAsset(tag, attrs, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      const node = document.createElement(tag);
      node.onload = () => { clearTimeout(timer); resolve(); };
      node.onerror = () => { clearTimeout(timer); reject(new Error('asset_failed')); };
      const timer = setTimeout(() => reject(new Error('asset_timeout')), timeoutMs);
      Object.assign(node, attrs);
      document.head.appendChild(node);
    });
  }

  async function initMap() {
    const host = $('venueMap');
    if (!host) return;
    // Leaflet лежит в репозитории и отдаётся своим же сервером: заведение не
    // должно зависеть от доступности чужого CDN. Внешними остаются только тайлы.
    try {
      await loadAsset('link', { rel: 'stylesheet', href: '/vendor/leaflet/leaflet.css' });
      await loadAsset('script', { src: '/vendor/leaflet/leaflet.js' });
    } catch (e) {
      host.remove();
      return;
    }
    if (!window.L) { host.remove(); return; }

    const points = state.venues.filter(v => v.location);
    if (!points.length) { host.remove(); return; }

    // Пределы масштаба: ниже 10 город уходит в точку и карта бесполезна,
    // выше 18 тайлы OpenStreetMap просто не существуют.
    map = L.map(host, { scrollWheelZoom: false, attributionControl: true, minZoom: 10, maxZoom: 18 });

    // Колесо мыши по умолчанию выключено, иначе карта перехватывает прокрутку
    // страницы и гость не может пролистать её дальше. Включается нажатием на
    // карту и выключается, когда курсор с неё уходит.
    const wheelHint = el('div', { class: 'epu-map-hint', text: t('guest.mapWheelHint') });
    host.appendChild(wheelHint);
    const enableWheel = () => {
      map.scrollWheelZoom.enable();
      wheelHint.classList.add('hidden');
    };
    host.addEventListener('click', enableWheel);
    host.addEventListener('touchstart', enableWheel, { passive: true });
    host.addEventListener('mouseleave', () => {
      map.scrollWheelZoom.disable();
      wheelHint.classList.remove('hidden');
    });
    // Leaflet 1.9 вшивает в префикс атрибуции украинский флаг. Упоминание
    // библиотеки оставляем, флаг убираем. Строку © OpenStreetMap трогать
    // нельзя: их данные используются по лицензии ODbL, она требует указания.
    map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');

    // Подложка — единственное, что ещё грузится извне. Если тайлы не приходят,
    // карта остаётся рабочей (точки на своих местах), но гость должен понимать,
    // что перед ним не пустое поле, а карта без подложки.
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap'
    });
    // Проверяем по времени, а не по событию ошибки: заблокированный запрос
    // тайла не завершается вовсе, и tileerror в этом случае не наступает.
    let tileLoaded = false;
    tiles.on('tileload', () => { tileLoaded = true; });
    const tileWatch = setTimeout(() => {
      if (tileLoaded || host.querySelector('.epu-map-note')) return;
      host.appendChild(el('div', { class: 'epu-map-note', text: t('guest.mapOffline') }));
    }, 6000);
    tiles.on('tileload', () => clearTimeout(tileWatch));
    tiles.addTo(map);

    mapMarkers = {};
    const bounds = [];
    for (const v of points) {
      // Подписи на всех точках сразу наезжают друг на друга: в центре Алматы
      // заведения стоят плотно. Поэтому на карте — точка, имя во всплывающей
      // подсказке, а подробности и переход к меню — по нажатию.
      // Явный размер и якорь: Leaflet позиционирует маркер собственным
      // inline-transform, поэтому смещать его своим CSS бесполезно.
      const icon = L.divIcon({
        className: 'epu-pin',
        iconSize: [18, 18],
        iconAnchor: [9, 9],
        html: '<span class="epu-pin-dot"></span>'
      });
      const marker = L.marker([v.location.lat, v.location.lon], { icon, title: v.name })
        .addTo(map)
        .bindTooltip(v.name, { direction: 'top', offset: [0, -10] })
        .on('click', () => openVenuePopup(v, marker));
      mapMarkers[v.id] = marker;
      bounds.push([v.location.lat, v.location.lon]);
    }
    poiLayer = L.layerGroup().addTo(map);
    map.on('moveend zoomend', refreshPoi);

    venueBounds = bounds;
    fitAll();
    refreshPoi();
    setTimeout(() => { map.invalidateSize(); fitAll(); }, 120);
    updateMapMarkers();
    updateMeMarker();
  }

  /**
   * Рамка карты охватывает все точки питания и, если она известна, позицию
   * гостя. Иначе после определения геолокации половина заведений уезжает за
   * край, и сравнить «что ко мне ближе» становится невозможно.
   */
  function fitAll() {
    if (!map || !venueBounds.length) return;
    const points = venueBounds.slice();
    if (state.from) points.push([state.from.lat, state.from.lon]);
    map.fitBounds(points, { padding: [42, 42], maxZoom: 15 });
  }

  /**
   * Справочные точки общепита Алматы из OpenStreetMap.
   *
   * Их полторы тысячи, поэтому рисуются только те, что попали в видимую
   * область, и только начиная с масштаба, на котором их можно различить.
   * Визуально они намеренно слабее точек пилота: заказать в них нельзя.
   */
  const refreshPoi = debounce(async () => {
    if (!map || !poiLayer) return;
    const note = $('poiNote');

    // Слой рынка выключен по умолчанию: гость пришёл купить обед, а точки,
    // в которых заказать нельзя, ему только мешают выбрать.
    if (!poiVisible) {
      poiLayer.clearLayers();
      if (note) note.textContent = '';
      return;
    }
    const zoom = map.getZoom();
    const b = map.getBounds();
    let data;
    try {
      data = await api(`/api/poi?north=${b.getNorth()}&south=${b.getSouth()}` +
        `&east=${b.getEast()}&west=${b.getWest()}&zoom=${zoom}`);
    } catch (e) {
      return;
    }

    poiLayer.clearLayers();

    if (data.tooFar) {
      if (note) note.textContent = t('poi.zoomIn', { total: data.total });
      return;
    }

    const icon = L.divIcon({ className: 'epu-poi', iconSize: [9, 9], iconAnchor: [4, 4], html: '<span class="epu-poi-dot"></span>' });
    for (const p of data.points) {
      L.marker([p.lat, p.lon], { icon, interactive: true, keyboard: false })
        .bindTooltip(`${esc(p.n)} · ${esc(p.k)}`, { direction: 'top', offset: [0, -6] })
        .addTo(poiLayer);
    }

    if (note) {
      note.textContent = data.matched > data.shown
        ? t('poi.capped', { n: data.shown, matched: data.matched, total: data.total })
        : t('poi.shown', { n: data.shown, total: data.total });
    }
  }, 300);

  function togglePoi() {
    poiVisible = !poiVisible;
    const btn = $('poiBtn');
    btn.textContent = t(poiVisible ? 'poi.hide' : 'poi.show');
    btn.setAttribute('aria-pressed', poiVisible);
    $('poiLegend').classList.toggle('hidden', !poiVisible);
    refreshPoi();
  }

  /** Карточка точки прямо на карте: статус, дорога и переход к меню. */
  function openVenuePopup(v, marker) {
    const fresh = state.venues.find(x => x.id === v.id) || v;
    const node = el('div', { style: 'min-width:190px' }, [
      el('b', { style: 'display:block;font-size:14px', text: fresh.name }),
      el('div', { class: 'tiny', style: 'color:#5d6672;margin-top:2px', text: fresh.kind + ' · ' + fresh.address }),
      el('div', {
        class: 'tiny', style: 'margin-top:6px;font-weight:700;color:' +
          (fresh.status.openNow === false ? '#8b95a3' : fresh.status.acceptingOrders ? '#15803d' : '#b45309'),
        text: statusLine(fresh)
      }),
      fresh.travel ? el('div', { class: 'tiny', style: 'margin-top:4px;color:#1d4ed8' },
        t(fresh.travel.mode === 'walk' ? 'guest.travelWalk' : 'guest.travelCar', {
          n: fresh.travel.minutes, km: String(fresh.travel.distanceKm).replace('.', ',')
        })) : null,
      el('button', {
        class: 'btn btn-sm btn-primary', style: 'margin-top:9px;width:100%',
        type: 'button', text: t('guest.menu'),
        onclick: () => selectVenue(fresh.id)
      })
    ]);
    marker.bindPopup(node, { closeButton: true, minWidth: 190 }).openPopup();
  }

  /** Точка на карте показывает, принимает ли заведение заказы сейчас. */
  function updateMapMarkers() {
    for (const v of state.venues) {
      const marker = mapMarkers[v.id];
      if (!marker || !marker.getElement) continue;
      const node = marker.getElement();
      if (!node) continue;
      const dot = node.querySelector('.epu-pin-dot');
      if (!dot) continue;
      const st = v.status || {};
      dot.style.background = st.openNow === false ? 'var(--text-faint)'
        : st.acceptingOrders ? 'var(--ok)' : 'var(--warn)';
    }
  }

  /** Своя точка на карте: без неё расстояния — абстракция. */
  function updateMeMarker() {
    if (!map || !window.L) return;
    if (!state.from) {
      if (meMarker) { map.removeLayer(meMarker); meMarker = null; }
      return;
    }
    const pos = [state.from.lat, state.from.lon];
    if (meMarker) { meMarker.setLatLng(pos); return; }
    meMarker = L.marker(pos, {
      icon: L.divIcon({
        className: 'epu-me',
        iconSize: [20, 20],
        iconAnchor: [10, 10],
        html: '<span class="epu-me-dot"></span>'
      }),
      zIndexOffset: 1000
    }).addTo(map).bindTooltip(t('guest.youAreHere'), { direction: 'top', offset: [0, -12] });
  }

  /** Сортировка каталога по времени в пути до каждой точки. */
  async function toggleNearMe() {
    const btn = $('nearMeBtn');
    const note = $('nearMeNote');
    if (state.from) {
      state.from = null;
      storage.del('areaId');
      updateMeMarker();
      fitAll();
      btn.textContent = t('guest.nearMe');
      note.textContent = '';
      await loadVenues();
      return;
    }
    if (!navigator.geolocation) return toast(t('travel.denied'), true);
    btn.disabled = true;
    btn.textContent = t('guest.locating');
    navigator.geolocation.getCurrentPosition(
      async pos => {
        state.from = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        btn.disabled = false;
        btn.textContent = t('guest.nearMeOff');
        note.textContent = t('guest.nearMeOn');
        await loadVenues();
        updateMeMarker();
        fitAll();
      },
      () => {
        btn.disabled = false;
        btn.textContent = t('guest.nearMe');
        toast(t('travel.denied'), true);
      },
      { timeout: 8000, maximumAge: 120000 }
    );
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
        updateMeMarker();
        fitAll();
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
        body: {
          items: cartPayload(),
          from: state.ignoreTravel ? null : state.from,
          mode: state.mode === 'auto' ? undefined : state.mode
        }
      });
    } catch (e) {
      grid.innerHTML = '';
      toast(e.message || t('common.error'), true);
      return;
    }
    state.slots = data.slots;
    state.travel = data.travel;
    state.explain = data;
    state.workSeconds = data.workSeconds;
    state.minCookSlots = data.minCookSlots;
    state.tooLarge = data.tooLarge;
    state.maxWorkMinutes = Math.floor(data.maxWorkSeconds / 60);
    renderTravel();
    renderExplain();
    renderSlots();
  }, 120);

  /**
   * Объяснение, откуда берутся доступные времена.
   *
   * Без него сетка слотов выглядит произволом: гость видит серые клетки и не
   * понимает, почему нельзя на 12:30. Три числа — объём его заказа, ёмкость
   * интервала и ближайшее выполнимое время — делают правило прозрачным.
   */
  function renderExplain() {
    const data = state.explain;
    if (!data) return;
    const grid = $('explainGrid');
    const advice = $('explainAdvice');
    const workMin = Math.max(1, Math.round(data.workSeconds / 60));
    const capMin = Math.round((data.capacityPerSlot / 60) * 10) / 10;

    const tile = (label, value) => el('div', {}, [
      el('div', { class: 'tiny', style: 'color:var(--brand-text);font-weight:600', text: label }),
      el('div', { style: 'font-weight:750;font-size:17px;margin-top:2px', text: value })
    ]);

    grid.innerHTML = '';
    grid.appendChild(tile(t('explain.work'), t('explain.workValue', { n: workMin })));
    grid.appendChild(tile(t('explain.capacity'), t('explain.capacityValue', { n: String(capMin).replace('.', ',') })));
    grid.appendChild(tile(t('explain.first'),
      data.firstAvailable ? data.firstAvailable.label : t('explain.firstNone')));

    // Причина отказа и что с ней делать — по первому непустому основанию
    advice.innerHTML = '';
    const visible = state.slots.filter(s => s.reason !== 'closed');
    const blockedBy = r => visible.some(s => s.reason === r);

    if (data.tooLarge) {
      advice.textContent = t('explain.adviceSplit', { n: Math.floor(data.maxWorkSeconds / 60) });
      advice.style.color = 'var(--danger)';
    } else if (!data.firstAvailable && blockedBy('too_far') && data.firstIfNearby) {
      advice.appendChild(el('span', { text: t('explain.adviceTravel', { t: data.firstIfNearby.label }) }));
      advice.appendChild(el('button', {
        class: 'btn btn-sm', type: 'button', style: 'margin-left:10px',
        text: t('explain.nearby'), onclick: () => { state.ignoreTravel = true; loadSlots(); }
      }));
      advice.style.color = 'var(--warn)';
    } else if (blockedBy('too_far') && data.firstAvailable) {
      advice.appendChild(el('span', { text: t('explain.adviceTravel', { t: data.firstAvailable.label }) }));
      advice.appendChild(el('button', {
        class: 'btn btn-sm', type: 'button', style: 'margin-left:10px',
        text: t('explain.nearby'), onclick: () => { state.ignoreTravel = true; loadSlots(); }
      }));
      advice.style.color = 'var(--warn)';
    } else if (blockedBy('kitchen_full') && data.firstAvailable) {
      advice.textContent = t('explain.adviceKitchen', { t: data.firstAvailable.label });
      advice.style.color = 'var(--warn)';
    } else if (blockedBy('handoff_full') && data.firstAvailable) {
      advice.textContent = t('explain.adviceHandoff', { t: data.firstAvailable.label });
      advice.style.color = 'var(--warn)';
    } else {
      advice.textContent = t('explain.adviceOk');
      advice.style.color = 'var(--ok)';
    }

    if (state.ignoreTravel) {
      advice.appendChild(el('span', {
        class: 'badge badge-info', style: 'margin-left:8px', text: t('explain.nearbyOn')
      }));
    }
  }

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

    // Выбранное время выносится отдельной полосой: в сетке из двух десятков
    // клеток подсветка одной из них слишком легко теряется.
    const bar = $('slotChosenBar');
    if (state.slot) {
      bar.classList.remove('hidden');
      $('slotChosenTime').textContent = state.slot.label;
      $('slotChosenNote').textContent = state.slot.cookStart
        ? t('slots.chosenNote', { t: hhmm(state.slot.cookStart) })
        : '';
    } else {
      bar.classList.add('hidden');
    }
  }

  // ---------- оплата ----------
  function renderPay() {
    const host = $('paySummary');
    host.innerHTML = '';
    // Перед оплатой позицию всё ещё можно убрать: возвращаться на первый шаг
    // ради одной лишней строки — лишний путь.
    for (const l of state.cart) host.appendChild(cartLine(l, true));
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
    $('cartClear').onclick = clearCart;

    $('nearMeBtn').onclick = toggleNearMe;
    $('poiBtn').onclick = togglePoi;
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
      renderCats(); renderMenu(); renderCartList(); renderCartBar();
      if (state.step === 2) { renderTravel(); renderExplain(); renderSlots(); }
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
      // Опрос по таймеру стартует сразу: живой статус не должен зависеть от карты.
      watchVenuesByTimer();
      // Карта — украшение поверх списка, грузится в фоне. Поток событий
      // подключается после неё, чтобы не занимать соединение раньше времени.
      initMap()
        .catch(() => { const m = $('venueMap'); if (m) m.remove(); })
        .then(watchVenuesLive, watchVenuesLive);
      const saved = storage.get('venueId', null);
      const preset = window.EPU.qs('venue') || saved;
      if (preset && state.venues.some(v => v.id === preset)) await selectVenue(preset);
    } catch (e) {
      toast(e.message || t('common.error'), true);
    }
  }

  init();
})();
