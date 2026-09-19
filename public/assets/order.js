/* Express Pick-Up — страница статуса заказа (без регистрации, по ссылке) */
(function () {
  const { api, money, hhmm, mmss, el, toast, storage, mountHeader, live, t } = window.EPU;

  const token = location.pathname.split('/').filter(Boolean)[1] || '';
  let order = null;
  let ticker = null;
  let lastStatus = null;
  let audioCtx = null;
  let titleFlash = null;

  const STEPS = ['new', 'cooking', 'ready', 'picked_up'];

  const statusTitle = {
    new: 'order.accepted', cooking: 'order.cooking', ready: 'order.ready',
    picked_up: 'order.picked', cancelled: 'order.cancelled', no_show: 'order.noShow'
  };
  const statusText = {
    new: 'order.statusAccepted', cooking: 'order.statusCooking', ready: 'order.statusReady',
    picked_up: 'order.statusPicked', cancelled: 'order.statusCancelled', no_show: 'order.noShowDesc'
  };

  // ---------- оповещение о готовности ----------
  // Без сигнала гость обязан держать вкладку открытой. Это и есть то место,
  // где «2 минуты на выдаче» превращаются в «стоял и смотрел в телефон».

  function canNotify() {
    return typeof Notification !== 'undefined';
  }

  /** Разрешение и звук запрашиваются только по нажатию — иначе браузер их блокирует. */
  async function enableAlerts() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx && !audioCtx) audioCtx = new Ctx();
      if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume();
    } catch (e) { /* звук недоступен — не критично */ }
    try {
      if (canNotify() && Notification.permission === 'default') await Notification.requestPermission();
    } catch (e) { /* пользователь отказал */ }
    EPU.storage.set('alerts', true);
    render();
  }

  function beep() {
    if (!audioCtx) return;
    try {
      [0, 0.18].forEach((delay, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.frequency.value = i === 0 ? 880 : 1170;
        gain.gain.setValueAtTime(0.0001, audioCtx.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + delay + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + delay + 0.16);
        osc.start(audioCtx.currentTime + delay);
        osc.stop(audioCtx.currentTime + delay + 0.18);
      });
    } catch (e) { /* звук недоступен */ }
  }

  function flashTitle(text) {
    if (titleFlash) clearInterval(titleFlash);
    const original = 'Express Pick-Up';
    let on = false;
    titleFlash = setInterval(() => {
      document.title = (on = !on) ? text : original;
    }, 1000);
    const stop = () => {
      clearInterval(titleFlash);
      titleFlash = null;
      document.title = original;
      document.removeEventListener('visibilitychange', onVisible);
    };
    const onVisible = () => { if (!document.hidden) stop(); };
    document.addEventListener('visibilitychange', onVisible);
  }

  /** Срабатывает один раз, в момент перехода заказа в «готов». */
  function announceReady() {
    const title = t('order.ready');
    const body = t('order.notifyBody', { code: order.code, point: order.venue ? order.venue.pickupPoint : '' });
    beep();
    try { if (navigator.vibrate) navigator.vibrate([180, 90, 180]); } catch (e) { /* нет вибрации */ }
    try {
      if (canNotify() && Notification.permission === 'granted') new Notification(title, { body, tag: 'epu-' + order.code });
    } catch (e) { /* уведомления недоступны */ }
    if (document.hidden) flashTitle('\u2705 ' + title);
    toast(title);
  }

  function countdownLine() {
    if (!order || ['picked_up', 'cancelled'].includes(order.status)) return '';
    const slot = new Date(order.slotStart).getTime();
    const diff = slot - Date.now();
    if (order.status === 'ready' && order.arrivedAt) {
      return t('order.waitHere', { t: mmss(Date.now() - new Date(order.arrivedAt).getTime()) });
    }
    if (diff >= 0) return t('order.timeLeft', { t: mmss(diff) });
    return t('order.late', { t: mmss(-diff) });
  }

  function render() {
    const host = document.getElementById('content');
    host.innerHTML = '';

    if (!order) {
      host.appendChild(el('div', { class: 'card' }, [
        el('h2', { text: t('order.notFound'), style: 'margin-top:0' }),
        el('p', { class: 'muted', text: t('order.notFoundDesc') }),
        el('a', { class: 'btn btn-primary', href: '/', text: t('order.newOrder') })
      ]));
      return;
    }

    const stepIndex = STEPS.indexOf(order.status);
    const isReady = order.status === 'ready';
    if (order.status !== 'cancelled' && order.status !== 'no_show') { /* обычный ход */ }

    // Герой со статусом и номером
    host.appendChild(el('div', { class: 'status-hero' + (isReady ? ' ready' : ''), style: 'margin-top:20px' }, [
      el('div', { class: 'small muted', text: t('order.yourNumber') }),
      el('div', { class: 'order-code', text: order.code }),
      el('div', { style: 'margin-top:10px;font-weight:700;font-size:18px', text: t(statusTitle[order.status]) }),
      el('div', { class: 'small muted', style: 'margin-top:2px', text: t(statusText[order.status], { t: hhmm(order.slotStart) }) }),
      order.status !== 'cancelled' ? el('div', { class: 'progress-track' },
        STEPS.slice(0, 4).map((s, i) => el('i', { class: i <= stepIndex ? 'on' : '' }))) : null,
      el('div', { id: 'countdown', class: 'small num', style: 'color:var(--text-dim)', text: countdownLine() })
    ]));

    // QR + точка выдачи
    if (!['cancelled'].includes(order.status)) {
      host.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'row', style: 'gap:16px;align-items:flex-start;flex-wrap:wrap' }, [
          el('div', { class: 'qr-box' }, [el('img', { src: `/api/orders/${order.token}/qr.svg`, alt: 'QR' })]),
          el('div', { style: 'flex:1 1 200px;min-width:200px' }, [
            el('div', { class: 'small muted', text: t('order.pickupPoint') }),
            el('b', { style: 'display:block;font-size:16px;margin:2px 0 6px', text: order.venue ? order.venue.pickupPoint : '' }),
            el('div', { class: 'tiny faint', text: order.venue ? order.venue.name + ' · ' + order.venue.address : '' }),
            el('div', { class: 'small', style: 'margin-top:10px', text: t('order.showCode') }),
            el('div', { class: 'row', style: 'margin-top:10px;gap:8px;flex-wrap:wrap' }, [
              el('span', { class: 'badge badge-brand', text: t('order.pickupAt', { t: hhmm(order.slotStart) }) }),
              el('span', {
                class: 'badge ' + (order.paymentStatus === 'paid' ? 'badge-ok' : 'badge-warn'),
                text: order.paymentStatus === 'paid' ? t('order.paid') : t('order.payOnsite') + ': ' + money(order.total)
              })
            ])
          ])
        ])
      ]));
    }

    if (order.status === 'cancelled' && order.cancelledBy === 'venue') {
      host.appendChild(el('div', { class: 'card', style: 'border-color:var(--danger)' }, [
        el('b', { text: t('order.cancelledByVenue') }),
        order.cancelReason ? el('div', { class: 'small muted', style: 'margin-top:4px', text: order.cancelReason }) : null,
        order.refund === 'due'
          ? el('div', { class: 'badge badge-warn', style: 'margin-top:8px', text: t('order.refundDue') })
          : null
      ]));
    }

    if (order.status === 'no_show') {
      host.appendChild(el('div', { class: 'card' }, [
        el('b', { text: t('order.noShow') }),
        el('div', { class: 'small muted', style: 'margin-top:4px', text: t('order.noShowDesc') })
      ]));
    }

    // Состав заказа
    const lines = el('div', { class: 'card' }, [
      el('h3', { text: t('pay.summary') }),
      ...order.lines.map(l => el('div', { class: 'line' }, [
        el('div', { class: 'line-name' }, [
          el('div', { text: l.name }),
          l.optionNames && l.optionNames.length ? el('div', { class: 'line-opts', text: l.optionNames.join(' · ') }) : null
        ]),
        el('div', { class: 'num', style: 'white-space:nowrap' }, `×${l.qty}  ${money(l.total)}`)
      ])),
      el('div', { class: 'sep' }),
      el('div', { class: 'row-between' }, [
        el('b', { text: t('common.total') }),
        el('b', { class: 'num', text: money(order.total) })
      ])
    ]);
    host.appendChild(lines);

    // Действия
    const actions = el('div', { class: 'stack', style: 'margin-top:14px' });

    const alertsOn = EPU.storage.get('alerts', false) &&
      (!canNotify() || Notification.permission === 'granted');
    if (['new', 'cooking'].includes(order.status)) {
      actions.appendChild(alertsOn
        ? el('div', { class: 'badge badge-ok', style: 'align-self:center', text: t('order.notifyOn') })
        : el('button', {
            class: 'btn btn-block', type: 'button', text: t('order.notifyMe'),
            onclick: enableAlerts
          }));
    }

    if (['new', 'cooking', 'ready'].includes(order.status)) {
      if (!order.arrivedAt) {
        actions.appendChild(el('button', {
          class: 'btn btn-ok btn-lg btn-block', type: 'button', text: t('order.arrived'),
          onclick: async () => {
            try { order = await api(`/api/orders/${token}/arrived`, { method: 'POST' }); toast(t('order.arrivedDone')); render(); }
            catch (e) { toast(e.message || t('common.error'), true); }
          }
        }));
      } else {
        actions.appendChild(el('div', { class: 'badge badge-ok', style: 'align-self:center', text: t('order.arrivedDone') }));
      }
    }

    if (['new', 'cooking'].includes(order.status)) {
      actions.appendChild(el('button', {
        class: 'btn btn-danger btn-block', type: 'button', text: t('order.cancel'),
        onclick: async () => {
          if (!confirm(t('order.cancelConfirm'))) return;
          try { order = await api(`/api/orders/${token}/cancel`, { method: 'POST' }); render(); }
          catch (e) { toast(e.error === 'too_late' ? t('order.cancelLate') : (e.message || t('common.error')), true); }
        }
      }));
    }

    if (order.status === 'picked_up') {
      if (order.rating) {
        actions.appendChild(el('div', { class: 'card', style: 'text-align:center' }, [
          el('div', { style: 'font-size:22px', text: '★'.repeat(order.rating) }),
          el('div', { class: 'small muted', text: t('order.rateThanks') })
        ]));
      } else {
        actions.appendChild(el('div', { class: 'card', style: 'text-align:center' }, [
          el('div', { class: 'small muted', style: 'margin-bottom:8px', text: t('order.rate') }),
          el('div', { class: 'row', style: 'justify-content:center;gap:6px' }, [1, 2, 3, 4, 5].map(n =>
            el('button', {
              class: 'btn btn-sm', type: 'button', text: '★ ' + n,
              onclick: async () => {
                try { order = await api(`/api/orders/${token}/rate`, { method: 'POST', body: { rating: n } }); render(); }
                catch (e) { toast(e.message || t('common.error'), true); }
              }
            })
          ))
        ]));
      }
    }

    actions.appendChild(el('div', { class: 'row', style: 'gap:8px;justify-content:center;margin-top:4px' }, [
      el('a', { class: 'btn btn-sm', href: order.venue ? '/?venue=' + order.venue.id : '/', text: t('order.newOrder') }),
      el('button', {
        class: 'btn btn-sm', type: 'button', text: t('common.copy'),
        onclick: async () => {
          try { await navigator.clipboard.writeText(location.href); toast(t('common.copied')); }
          catch (e) { toast(location.href); }
        }
      })
    ]));

    host.appendChild(actions);
  }

  async function refresh() {
    try {
      order = await api('/api/orders/' + encodeURIComponent(token));
    } catch (e) {
      order = null;
    }
    if (order && order.status === 'ready' && lastStatus && lastStatus !== 'ready') announceReady();
    if (order) lastStatus = order.status;
    render();
  }

  function startTicker() {
    if (ticker) clearInterval(ticker);
    ticker = setInterval(() => {
      const node = document.getElementById('countdown');
      if (node) node.textContent = countdownLine();
    }, 1000);
  }

  async function init() {
    mountHeader('guest');
    window.I18N.apply();
    await refresh();
    lastStatus = order ? order.status : null;
    startTicker();
    if (order) {
      const tokens = storage.get('tokens', []);
      if (!tokens.includes(token)) storage.set('tokens', [token, ...tokens].slice(0, 10));
      live(order.venue ? order.venue.id : null, ev => {
        if (ev.type === 'order_status' || ev.type === 'order_created' || ev.type === 'guest_arrived') refresh();
      });
    }
    document.addEventListener('langchange', render);
  }

  init();
})();
