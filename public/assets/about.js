/* Express Pick-Up — страница проекта: что решаем, как устроено, что видно прямо сейчас */
(function () {
  const { api, el, waitLabel, mountHeader, t, toast } = window.EPU;
  const EPU = window.EPU;
  const $ = id => document.getElementById(id);

  const SOLUTION_ROWS = [
    ['about.row1a', 'about.row1b'],
    ['about.row2a', 'about.row2b'],
    ['about.row3a', 'about.row3b'],
    ['about.row4a', 'about.row4b'],
    ['about.row5a', 'about.row5b']
  ];

  const HONEST_ITEMS = [
    'about.honest1', 'about.honest2', 'about.honest3', 'about.honest4', 'about.honest5'
  ];

  function renderStaticLists() {
    const table = $('solutionTable');
    table.innerHTML = '';
    for (const [a, b] of SOLUTION_ROWS) {
      table.appendChild(el('tr', {}, [
        el('td', { style: 'color:var(--text-dim)', text: t(a) }),
        el('td', {}, [el('b', { text: t(b) })])
      ]));
    }
    const list = $('honestList');
    list.innerHTML = '';
    for (const key of HONEST_ITEMS) list.appendChild(el('li', { text: t(key), style: 'margin-bottom:6px' }));
  }

  /** Схема: работа кухни раскладывается назад от времени выдачи. */
  function renderEngine() {
    const host = $('engineDiagram');
    host.innerHTML = '';
    const slots = [
      { label: '11:40', fill: 0 },
      { label: '11:45', fill: 35 },
      { label: '11:50', fill: 100 },
      { label: '11:55', fill: 100 },
      { label: '12:00', handoff: true }
    ];
    host.appendChild(el('div', { class: 'row', style: 'gap:6px;align-items:flex-end' },
      slots.map(s => el('div', { style: 'flex:1 1 0;text-align:center;min-width:0' }, [
        el('div', {
          style: 'height:64px;display:flex;align-items:flex-end;justify-content:center;' +
                 'border:1px solid var(--border);border-radius:8px;overflow:hidden;' +
                 (s.handoff ? 'background:var(--brand-soft);border-color:var(--brand)' : 'background:var(--surface-2)')
        }, [
          s.handoff
            ? el('div', { style: 'align-self:center;font-size:22px', text: '\u{1F371}' })
            : el('div', { style: `width:100%;height:${s.fill}%;background:var(--ok)` })
        ]),
        el('div', { class: 'tiny faint num', style: 'margin-top:4px', text: s.label })
      ]))
    ));
    host.appendChild(el('div', {
      class: 'tiny', style: 'text-align:center;margin-top:8px;color:var(--brand-text)',
      text: t('about.engineArrow')
    }));
  }

  /** Суточный профиль пробок Алматы, на котором строится оценка дороги. */
  async function renderTraffic() {
    const host = $('trafficChart');
    host.innerHTML = '';
    let data;
    try {
      data = await api('/api/traffic');
    } catch (e) {
      host.remove();
      return;
    }
    const max = Math.max(...data.hourly);
    host.appendChild(el('div', { class: 'row', style: 'gap:2px;align-items:flex-end;height:96px' },
      data.hourly.map((factor, hour) => {
        const h = Math.round((factor / max) * 84);
        const tone = factor >= 1.75 ? 'danger' : factor >= 1.35 ? 'warn' : 'ok';
        const lunch = hour >= 12 && hour < 14;
        return el('div', {
          style: 'flex:1 1 0;min-width:0;display:flex;flex-direction:column;justify-content:flex-end;gap:3px',
          title: `${String(hour).padStart(2, '0')}:00 — ×${factor.toFixed(2)}`
        }, [
          el('div', {
            style: `height:${h}px;border-radius:2px 2px 0 0;background:var(--${tone});` +
                   (lunch ? 'outline:2px solid var(--brand);outline-offset:1px' : '')
          }),
          el('div', { class: 'tiny faint', style: 'text-align:center;font-size:9px', text: hour % 3 === 0 ? String(hour) : '' })
        ]);
      })
    ));
    host.appendChild(el('div', {
      class: 'tiny', style: 'margin-top:10px;color:var(--brand-text)', text: t('about.trafficLunch')
    }));
  }

  function kpiTile(label, value, sub, hit) {
    return el('div', { class: 'kpi' + (hit === true ? ' hit' : hit === false ? ' miss' : '') }, [
      el('div', { class: 'kpi-label', text: label }),
      el('div', { class: 'kpi-value', text: value }),
      el('div', { class: 'kpi-sub', text: sub })
    ]);
  }

  async function renderLive() {
    let data;
    try {
      data = await api('/api/impact');
    } catch (e) {
      toast(e.message || t('common.error'), true);
      return;
    }
    const k = data.totals;
    const tg = data.targets;
    const host = $('liveKpi');
    host.innerHTML = '';

    host.appendChild(kpiTile(t('admin.kpiWait'), waitLabel(k.p90WaitSeconds),
      t('about.vsCounter', { n: waitLabel(k.p90WaitCounterSeconds) }),
      k.p90WaitSeconds == null ? null : k.p90WaitSeconds <= tg.p90WaitSeconds));

    host.appendChild(kpiTile(t('admin.kpiThroughput'),
      (k.throughputGainPct >= 0 ? '+' : '') + k.throughputGainPct + '%',
      t('about.vsBaseline'),
      k.throughputGainPct == null ? null : k.throughputGainPct >= tg.throughputGainPct));

    host.appendChild(kpiTile(t('admin.kpiOnTime'),
      k.onTimePct == null ? '—' : k.onTimePct + '%', t('admin.kpiOnTimeSub'),
      k.onTimePct == null ? null : k.onTimePct >= tg.onTimePct));

    const table = $('venueTable');
    table.innerHTML = '';
    for (const row of data.venues) {
      table.appendChild(el('tr', {}, [
        el('td', {}, [
          el('div', { text: row.venue }),
          el('div', { class: 'tiny faint', text: row.address })
        ]),
        el('td', { class: 'num', text: waitLabel(row.p90WaitSeconds) }),
        el('td', { class: 'num', text: row.onTimePct == null ? '—' : row.onTimePct + '%' }),
        el('td', {}, [el('span', {
          class: 'badge ' + (row.throughputGainPct >= 25 ? 'badge-ok' : 'badge-warn'),
          text: (row.throughputGainPct >= 0 ? '+' : '') + row.throughputGainPct + '%'
        })])
      ]));
    }
  }

  /**
   * Маршрут жюри: одно заведение во всех ссылках и QR, закодированный на
   * текущий адрес страницы. Открытая на localhost страница даёт QR, который
   * телефон не откроет, — об этом надо предупредить прямо, а не молчать.
   */
  const DEMO_VENUE = 'kaganat-abay';

  function renderJudgeFlow() {
    const steps = ['judge.s1', 'judge.s2', 'judge.s3', 'judge.s4', 'judge.s5', 'judge.s6'];
    const list = $('judgeSteps');
    list.innerHTML = '';
    for (const key of steps) list.appendChild(el('li', { text: t(key) }));

    $('judgeQr').src = '/api/guest-link-qr.svg?venue=' + encodeURIComponent(DEMO_VENUE);

    const q = '?venue=' + encodeURIComponent(DEMO_VENUE);
    $('linkGuest').href = '/' + q;
    $('linkKitchen').href = '/kitchen' + q;
    $('linkPickup').href = '/pickup' + q;
    $('linkAdmin').href = '/admin' + q;

    const host = location.host;
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])/.test(host);
    const note = $('judgeHost');
    note.textContent = isLocal ? t('judge.localhost') : t('judge.lan', { host });
    note.style.color = isLocal ? 'var(--danger)' : 'var(--text-faint)';
  }

  /**
   * «Попробуйте сломать обещание» — главный довод показа.
   *
   * Обычное приложение приняло бы все заказы и переложило ожидание на гостя.
   * Здесь жюри своими руками создаёт наплыв и видит, что невыполнимое время
   * перестаёт продаваться. Действие защищено кодом персонала, поэтому при
   * первом нажатии спрашивается код.
   */
  async function runStress() {
    const btn = $('stressBtn');
    const host = $('stressResult');
    btn.disabled = true;
    try {
      const res = await api(`/api/demo/${DEMO_VENUE}/rush`, { method: 'POST' });
      host.innerHTML = '';

      const rows = [
        el('div', { style: 'font-weight:700;font-size:16px', text: t('stress.accepted', { n: res.created }) }),
        el('div', {
          class: 'small', style: 'margin-top:4px',
          text: res.closedSlots && res.closedSlots.length
            ? t('stress.closed', { list: res.closedSlots.join(', ') })
            : t('stress.closedNone')
        }),
        el('div', {
          class: 'small', style: 'margin-top:4px;font-weight:600',
          text: res.nextGuaranteed ? t('stress.next', { t: res.nextGuaranteed }) : t('stress.none')
        })
      ];
      if (res.saturated) {
        rows.push(el('div', {
          class: 'badge badge-danger', style: 'margin-top:8px;white-space:normal;text-align:left',
          text: t('stress.saturated')
        }));
      }
      rows.push(el('div', { class: 'tiny', style: 'margin-top:10px;color:var(--text-dim)', text: t('stress.point') }));
      rows.forEach(r => host.appendChild(r));
      $('stressReset').classList.remove('hidden');
      renderLive();
    } catch (e) {
      if (e.error === 'staff_auth') {
        EPU.storage.del('staffPin');
        EPU.staffGate('/api/staff/check', runStress);
      } else {
        toast(e.message || t('common.error'), true);
      }
    } finally {
      btn.disabled = false;
    }
  }

  async function resetShowcase() {
    const btn = $('stressReset');
    btn.disabled = true;
    try {
      await api(`/api/demo/${DEMO_VENUE}/showcase`, { method: 'POST' });
      $('stressResult').innerHTML = '';
      btn.classList.add('hidden');
      renderLive();
    } catch (e) {
      toast(e.message || t('common.error'), true);
    } finally {
      btn.disabled = false;
    }
  }

  function renderAll() {
    renderStaticLists();
    renderEngine();
    renderJudgeFlow();
    $('stressBtn').onclick = runStress;
    $('stressReset').onclick = resetShowcase;
    $('pinHint').textContent = t('about.pinHint');
  }

  async function init() {
    mountHeader('about');
    window.I18N.apply();
    renderAll();
    await Promise.all([renderTraffic(), renderLive()]);
    document.addEventListener('langchange', () => { renderAll(); renderLive(); });
  }

  init();
})();
