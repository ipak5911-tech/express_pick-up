/* Express Pick-Up — панель заведения: метрики пилота, стоп-лист, ёмкость слотов */
(function () {
  const { api, money, waitLabel, el, toast, storage, mountHeader, live, t } = window.EPU;

  let venueId = null;
  let data = null;
  let stream = null;
  let tab = 'metrics';
  const $ = id => document.getElementById(id);

  // ---------- метрики ----------
  function kpiTile(label, value, sub, hit) {
    return el('div', { class: 'kpi' + (hit === true ? ' hit' : hit === false ? ' miss' : '') }, [
      el('div', { class: 'kpi-label', text: label }),
      el('div', { class: 'kpi-value', text: value }),
      el('div', { class: 'kpi-sub', text: sub })
    ]);
  }

  function renderKpi() {
    const r = data.report;
    const meta = r.meta || {};
    const banner = $('demoBanner');
    banner.classList.toggle('hidden', !meta.demoData && !meta.partiallyDemo);
    $('demoSample').textContent = t('admin.demoSample', {
      n: meta.sampleSize || 0, w: meta.waitSampleSize || 0
    });
    const k = r.kpi;
    const host = $('kpiGrid');
    host.innerHTML = '';

    host.appendChild(kpiTile(
      t('admin.kpiWait'),
      waitLabel(k.p90WaitSeconds),
      t('admin.kpiWaitSub', { base: waitLabel(k.baselineWaitSeconds) }),
      k.p90WaitSeconds == null ? null : k.p90WaitSeconds <= r.targets.p90WaitSeconds
    ));

    host.appendChild(kpiTile(
      t('admin.kpiShare'),
      k.expressSharePeakPct + '%',
      t('admin.kpiShareSub'),
      k.expressSharePeakPct >= r.targets.expressSharePeakPct
    ));

    host.appendChild(kpiTile(
      t('admin.kpiThroughput'),
      k.peakThroughputPerHour + ' / ' + (k.throughputGainPct >= 0 ? '+' : '') + k.throughputGainPct + '%',
      t('admin.kpiThroughputSub', { base: k.baselineThroughputPerHour }),
      k.throughputGainPct == null ? null : k.throughputGainPct >= r.targets.throughputGainPct
    ));

    host.appendChild(kpiTile(
      t('admin.kpiOnTime'),
      k.onTimePct == null ? '—' : k.onTimePct + '%',
      t('admin.kpiOnTimeSub'),
      k.onTimePct == null ? null : k.onTimePct >= r.targets.onTimePct
    ));

    host.appendChild(kpiTile(
      t('admin.kpiRating'),
      k.avgRating == null ? '—' : String(k.avgRating).replace('.', ','),
      t('admin.kpiRatingSub', { n: k.ratingsCount }),
      k.avgRating == null ? null : k.avgRating >= r.targets.avgRating
    ));

    host.appendChild(kpiTile(
      t('admin.kpiCancel'),
      r.totals.cancelRatePct + '%',
      t('admin.kpiCancelSub', { n: r.totals.cancelled, total: r.totals.orders })
    ));

    host.appendChild(kpiTile(
      t('admin.counterWait'),
      waitLabel(k.p90WaitCounterSeconds),
      t('admin.histCounter')
    ));
  }

  function renderHistogram() {
    const r = data.report;
    const host = $('histogram');
    const labels = $('histLabels');
    host.innerHTML = '';
    labels.innerHTML = '';
    const rows = r.histogram;
    if (!rows.length) {
      host.appendChild(el('div', { class: 'tiny faint', text: '—' }));
      return;
    }
    const max = Math.max(1, ...rows.map(b => b.express + b.counter));
    for (const b of rows) {
      const ex = Math.round((b.express / max) * 100);
      const co = Math.round((b.counter / max) * 100);
      host.appendChild(el('div', { class: 'col', title: `${b.label} — Express: ${b.express}, ${t('admin.histCounter')}: ${b.counter}` }, [
        b.express ? el('div', { class: 'seg express', style: `height:${ex}px` }) : null,
        b.counter ? el('div', { class: 'seg counter', style: `height:${co}px` }) : null
      ]));
    }
    // подписи каждые 15 минут
    for (let i = 0; i < rows.length; i++) {
      const show = rows[i].label.endsWith('00') || rows[i].label.endsWith('30');
      labels.appendChild(el('div', {
        style: 'flex:1 1 0;min-width:0;text-align:center',
        class: 'tiny faint num',
        text: show ? rows[i].label : ''
      }));
    }
  }

  function renderLate() {
    const box = $('lateBox');
    box.innerHTML = '';
    const rows = data.report.lateList;
    if (!rows.length) {
      box.appendChild(el('div', { class: 'small muted', text: t('admin.lateEmpty') }));
      return;
    }
    const table = el('table', { class: 'tbl' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: t('admin.lateCode') }),
        el('th', { text: t('admin.lateSlot') }),
        el('th', { text: t('admin.lateReady') }),
        el('th', { text: t('admin.lateDelay') })
      ])]),
      el('tbody', {}, rows.map(row => el('tr', {}, [
        el('td', { class: 'num', text: row.code }),
        el('td', { class: 'num', text: row.slot }),
        el('td', { class: 'num', text: row.readyAt }),
        el('td', {}, [el('span', { class: 'badge badge-danger', text: '+' + waitLabel(row.delaySeconds) })])
      ])))
    ]);
    box.appendChild(table);
  }

  // ---------- меню ----------
  function renderMenu() {
    const body = $('menuBody');
    body.innerHTML = '';
    for (const item of data.menu) {
      const priceInput = el('input', { type: 'number', class: 'input-sm', value: item.price, min: '0', step: '10' });
      const prepInput = el('input', { type: 'number', class: 'input-sm', value: item.prepSeconds, min: '0', step: '5' });
      const toggle = el('input', { type: 'checkbox', checked: item.available });

      const save = async patch => {
        try {
          await api(`/api/admin/${encodeURIComponent(venueId)}/menu/${encodeURIComponent(item.id)}`, {
            method: 'PUT', body: patch
          });
          toast(t('common.saved'));
        } catch (e) {
          toast(e.message || t('common.error'), true);
        }
      };

      priceInput.onchange = () => save({ price: Number(priceInput.value) });
      prepInput.onchange = () => save({ prepSeconds: Number(prepInput.value) });
      toggle.onchange = () => save({ available: toggle.checked });

      body.appendChild(el('tr', {}, [
        el('td', {}, [
          el('div', { text: item.name }),
          el('div', { class: 'tiny faint', text: item.category })
        ]),
        el('td', {}, [priceInput]),
        el('td', {}, [prepInput]),
        el('td', {}, [el('label', { class: 'switch' }, [toggle, el('span', { class: 'track' })])])
      ]));
    }
  }

  // ---------- ёмкость ----------
  const FIELDS = [
    ['slotMinutes', 'admin.slotMinutes', 1, 30, 1],
    ['kitchenThroughputPerMin', 'admin.throughput', 30, 1200, 10],
    ['digitalSharePct', 'admin.digitalShare', 5, 100, 5],
    ['maxOrdersPerSlot', 'admin.maxOrders', 1, 30, 1],
    ['minLeadMinutes', 'admin.minLead', 0, 60, 1],
    ['maxEarlyCookSlots', 'admin.maxEarly', 1, 24, 1],
    ['horizonMinutes', 'admin.horizon', 15, 300, 15],
    ['graceSeconds', 'admin.grace', 0, 600, 15],
    ['baselineWaitSeconds', 'admin.baselineWait', 0, 3600, 30],
    ['baselineOrdersPerHour', 'admin.baselineThroughput', 1, 300, 1]
  ];

  function renderSettings() {
    const host = $('settingsGrid');
    host.innerHTML = '';
    for (const [key, labelKey, min, max, step] of FIELDS) {
      host.appendChild(el('div', {}, [
        el('label', { class: 'field', text: t(labelKey) }),
        el('input', {
          type: 'number', id: 'set-' + key, value: data.settings[key],
          min: String(min), max: String(max), step: String(step),
          oninput: updateCapacityNote
        })
      ]));
    }
    host.appendChild(el('div', {}, [
      el('label', { class: 'field', text: t('admin.hoursFrom') }),
      el('input', { type: 'time', id: 'set-from', value: data.settings.serviceHours.from })
    ]));
    host.appendChild(el('div', {}, [
      el('label', { class: 'field', text: t('admin.hoursTo') }),
      el('input', { type: 'time', id: 'set-to', value: data.settings.serviceHours.to })
    ]));
    updateCapacityNote();
  }

  function updateCapacityNote() {
    const slotMinutes = Number(($('set-slotMinutes') || {}).value || data.settings.slotMinutes);
    const throughput = Number(($('set-kitchenThroughputPerMin') || {}).value || data.settings.kitchenThroughputPerMin);
    const share = Number(($('set-digitalSharePct') || {}).value || data.settings.digitalSharePct);
    const seconds = Math.round(throughput * slotMinutes * (share / 100));
    $('capacityResult').textContent = t('admin.capacityResult', {
      n: seconds, m: (seconds / 60).toFixed(1).replace('.', ',')
    });
  }

  async function saveSettings() {
    const body = { serviceHours: { from: $('set-from').value, to: $('set-to').value } };
    for (const [key] of FIELDS) body[key] = Number($('set-' + key).value);
    try {
      await api(`/api/admin/${encodeURIComponent(venueId)}/settings`, { method: 'PUT', body });
      toast(t('common.saved'));
      await refresh();
    } catch (e) {
      toast(e.message || t('common.error'), true);
    }
  }

  // ---------- калибровка ----------
  let calData = null;

  const VERDICT_LABEL = {
    matches: 'cal.matches', underestimated: 'cal.underestimated',
    overestimated: 'cal.overestimated', few_samples: 'cal.fewSamples', no_data: 'cal.noData'
  };
  const VERDICT_CLASS = {
    matches: 'badge-ok', underestimated: 'badge-warn',
    overestimated: 'badge-warn', few_samples: 'badge', no_data: 'badge'
  };
  const THROUGHPUT_TEXT = {
    too_early: 'cal.vTooEarly', no_data: 'cal.vNoData', matches: 'cal.vMatches',
    idle: 'cal.vIdle', kitchen_behind: 'cal.vBehind', underconfigured: 'cal.vUnder'
  };

  async function loadCalibration() {
    try {
      calData = await api(`/api/admin/${encodeURIComponent(venueId)}/calibration`);
      renderCalibration();
    } catch (e) {
      toast(e.message || t('common.error'), true);
    }
  }

  async function applyItems(rows) {
    if (!rows.length) return;
    try {
      const res = await api(`/api/admin/${encodeURIComponent(venueId)}/calibration/apply`, {
        method: 'POST',
        body: { items: rows.map(r => ({ itemId: r.itemId, prepSeconds: r.suggested })) }
      });
      toast(t('cal.applied', { n: res.applied.length }));
      await loadCalibration();
    } catch (e) {
      toast(e.message || t('common.error'), true);
    }
  }

  function renderCalibration() {
    if (!calData) return;
    const tp = calData.throughput;
    const host = $('calThroughput');
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'grid grid-4' }, [
      kpiTile(t('cal.observed'), tp.observed + ' с/мин', t('cal.window') + ': ' + tp.windowLabel),
      kpiTile(t('cal.configured'), tp.configured + ' с/мин', tp.orders + ' зак. за ' + (tp.elapsedMinutes || 0) + ' мин'),
      kpiTile(t('cal.onTime'), tp.onTimePct == null ? '—' : tp.onTimePct + '%', t('admin.kpiOnTimeSub'),
        tp.onTimePct == null ? null : tp.onTimePct >= 90)
    ]));
    host.appendChild(el('div', {
      class: 'badge ' + (tp.verdict === 'matches' ? 'badge-ok' : tp.verdict === 'kitchen_behind' ? 'badge-danger' : 'badge-warn'),
      style: 'margin-top:10px', text: t(THROUGHPUT_TEXT[tp.verdict] || 'cal.vNoData')
    }));

    const body = $('calBody');
    body.innerHTML = '';
    const actionable = calData.items.filter(i => ['underestimated', 'overestimated'].includes(i.verdict));

    for (const row of calData.items) {
      const canApply = ['underestimated', 'overestimated'].includes(row.verdict);
      body.appendChild(el('tr', {}, [
        el('td', {}, [
          el('div', { text: row.name }),
          el('div', { class: 'tiny faint', text: row.category })
        ]),
        el('td', { class: 'num', text: row.current + ' с' }),
        el('td', { class: 'num', text: row.observed == null ? '—' : row.observed + ' с' }),
        el('td', { class: 'num', text: String(row.samples) }),
        el('td', {}, [
          el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, [
            el('span', {
              class: 'badge ' + (VERDICT_CLASS[row.verdict] || 'badge'),
              text: t(VERDICT_LABEL[row.verdict]) + (row.deltaPct != null && canApply
                ? ' ' + (row.deltaPct > 0 ? '+' : '') + row.deltaPct + '%' : '')
            }),
            canApply ? el('button', {
              class: 'btn btn-sm', type: 'button', text: t('cal.apply'),
              onclick: () => applyItems([row])
            }) : null
          ])
        ])
      ]));
    }

    const btn = $('calApplyAll');
    btn.classList.toggle('hidden', actionable.length === 0);
    btn.textContent = t('cal.applyAll', { n: actionable.length });
    btn.onclick = () => applyItems(actionable);
  }

  // ---------- демо ----------
  async function demo(action, confirmKey) {
    if (confirmKey && !confirm(t(confirmKey))) return;
    try {
      const res = await api(`/api/demo/${encodeURIComponent(venueId)}/${action}`, { method: 'POST' });
      toast(res.created != null ? `+${res.created}` : `−${res.removed}`);
      await refresh();
    } catch (e) {
      toast(e.message || t('common.error'), true);
    }
  }

  // ---------- почта ----------
  const MAIL_STATUS_CLASS = { sent: 'badge-ok', logged: 'badge-brand', failed: 'badge-danger', skipped: '', queued: 'badge-warn' };

  async function loadMail() {
    try {
      const res = await api(`/api/admin/${encodeURIComponent(venueId)}/mail`);
      renderMail(res);
    } catch (e) {
      toast(e.message || t('common.error'), true);
    }
  }

  function renderMail(res) {
    const m = res.mail;
    $('mailStatus').innerHTML = '';
    $('mailStatus').appendChild(m.transport === 'smtp'
      ? el('span', {}, [
          el('span', { class: 'badge badge-ok', text: t('admin.mailSmtpOn') }),
          el('span', { class: 'muted', style: 'margin-left:8px', text: `${m.host}:${m.port} · ${m.from}` })
        ])
      : el('span', {}, [
          el('span', { class: 'badge badge-warn', text: t('admin.mailSmtpOff') }),
          el('span', { class: 'muted', style: 'margin-left:8px', text: t('admin.mailSmtpOffHint') })
        ]));

    const host = $('mailList');
    host.innerHTML = '';
    if (!res.items.length) {
      host.appendChild(el('div', { class: 'small muted', text: t('admin.mailEmpty') }));
      return;
    }
    const table = el('table', { class: 'tbl' }, [
      el('thead', {}, [el('tr', {}, ['admin.mailWhen', 'admin.mailTo', 'admin.mailSubject', 'admin.mailState']
        .map(k => el('th', { text: t(k) })))]),
      el('tbody', {}, res.items.map(item => el('tr', {}, [
        el('td', { class: 'num', text: hhmm(item.at) + (item.orderCode ? ' · №' + item.orderCode : '') }),
        el('td', { text: item.to }),
        el('td', { text: item.subject, title: item.preview || '' }),
        el('td', {}, [
          el('span', { class: 'badge ' + (MAIL_STATUS_CLASS[item.status] || ''), text: t('admin.mail_' + item.status) }),
          item.error ? el('div', { class: 'tiny faint', text: item.error }) : null
        ])
      ])))
    ]);
    host.appendChild(table);
  }

  async function sendTestMail() {
    const to = $('mailTestTo').value.trim();
    if (!to) { $('mailTestTo').focus(); return; }
    $('mailTest').disabled = true;
    try {
      const res = await api(`/api/admin/${encodeURIComponent(venueId)}/mail/test`, { method: 'POST', body: { to } });
      toast(t(res.entry.status === 'sent' ? 'admin.mailTestSent' : 'admin.mailTestLogged'));
    } catch (e) {
      toast(e.entry && e.entry.error ? e.entry.error : (e.message || t('common.error')), true);
    } finally {
      $('mailTest').disabled = false;
      loadMail();
    }
  }

  // ---------- общий рендер ----------
  function render() {
    if (!data) return;
    $('venueLine').textContent = `${data.venue.kind} · ${data.venue.address} · ${data.venue.pickupPoint}`;
    $('autoKitchen').checked = !!data.settings.autoKitchen;
    if (tab === 'metrics') { renderKpi(); renderHistogram(); renderLate(); }
    if (tab === 'menu') renderMenu();
    if (tab === 'capacity') renderSettings();
    if (tab === 'calibration') loadCalibration();
    if (tab === 'mail') loadMail();
  }

  function showTab(next) {
    tab = next;
    for (const name of ['metrics', 'menu', 'capacity', 'calibration', 'mail', 'demo']) {
      $('tab-' + name).classList.toggle('hidden', name !== next);
    }
    document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-pressed', b.dataset.tab === next));
    render();
  }

  async function refresh() {
    try {
      data = await api('/api/admin/' + encodeURIComponent(venueId));
      render();
    } catch (e) {
      toast(e.message || t('common.error'), true);
    }
  }

  async function init() {
    mountHeader('admin');
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

    document.querySelectorAll('#tabs button').forEach(b => {
      b.onclick = () => showTab(b.dataset.tab);
    });

    $('saveSettings').onclick = saveSettings;
    $('mailTest').onclick = sendTestMail;
    $('demoShowcase').onclick = async () => {
      await demo('showcase');
      showTab('metrics');
    };
    $('demoRush').onclick = () => demo('rush');
    $('demoCounter').onclick = () => demo('counter');
    $('demoHistory').onclick = () => demo('history');
    $('demoReset').onclick = () => demo('reset', 'admin.demoResetConfirm');
    $('autoKitchen').onchange = async ev => {
      try {
        await api(`/api/admin/${encodeURIComponent(venueId)}/settings`, {
          method: 'PUT', body: { autoKitchen: ev.target.checked }
        });
        await refresh();
      } catch (e) {
        toast(e.message || t('common.error'), true);
      }
    };

    await refresh();
    stream = live(venueId, ev => {
      if (tab === 'metrics') refresh();
      if (tab === 'mail' && ev && ev.type === 'mail') loadMail();
    });
    setInterval(() => { if (tab === 'metrics') refresh(); }, 30000);
    document.addEventListener('langchange', render);
  }

  // экран персонала открывается только после ввода кода заведения
  window.EPU.staffGate('/api/staff/check', init);
})();
