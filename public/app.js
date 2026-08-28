// Picture EMR — single-page client. No framework, no build step.

const CATEGORIES = [
  { key: 'identity', label: 'Identity Page' },
  { key: 'chart', label: 'Patient Chart' },
  { key: 'lab', label: 'Lab' },
  { key: 'radiology', label: 'Radiology' },
];

const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,application/pdf';

/**
 * Who is carrying the patient. Both kinds of record have a leader; the second
 * option differs because the situation does — an admission can be shared with
 * the team that leads it, a clinic visit can be a consult another department
 * asked for. `partner` is how the other party is introduced, and its presence is
 * what makes naming them required.
 */
const CARE_STATUS = {
  leader: { badge: 'LEADER', cls: 'badge-lead', long: () => 'Leader' },
  shared: {
    badge: 'SHARED CARE',
    cls: 'badge-shared',
    partner: 'led by',
    long: (who) => `Shared care — led by ${who}`,
  },
  consult: {
    badge: 'CONSULT',
    cls: 'badge-consult',
    partner: 'asked by',
    long: (who) => `Consult — asked by ${who}`,
  },
};

const CARE_OPTIONS = {
  inpatient: [['', 'Not recorded'], ['leader', 'Leader'], ['shared', 'Shared care']],
  outpatient: [['', 'Not recorded'], ['leader', 'Leader'], ['consult', 'Consult from another dept']],
};

const CARE_HINT = {
  inpatient: 'Leader — this patient is ours. Shared care — another team leads and we consult.',
  outpatient: 'Leader — this patient is ours. Consult — another department asked us to see them.',
};

const CARE_PARTNER_FIELD = {
  shared: {
    label: 'Who leads the care? *',
    hint: 'The doctor or team carrying the case — required for shared care.',
    placeholder: 'e.g. Dr Rahman — Cardiology',
  },
  consult: {
    label: 'Which department asked? *',
    hint: 'The department or doctor who asked for the consult — required.',
    placeholder: 'e.g. Bedah — Dr Andi',
  },
};

const state = {
  user: null,
  needsSetup: false,
  today: '',
  defaultRange: { from: '', to: '' },
  compress: localStorage.getItem('emr.compress') !== 'off',
};

// ------------------------------------------------------------------- helpers

const root = document.getElementById('root');

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function toast(message, isError = false) {
  const node = el('div', { class: `toast${isError ? ' err' : ''}`, text: message });
  document.getElementById('toasts').append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .3s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 300);
  }, isError ? 4200 : 2400);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401 && !path.endsWith('/bootstrap')) {
    state.user = null;
    renderGate();
    throw new Error('Please sign in.');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : {};
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function prettyDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(d)} ${months[Number(m) - 1]} ${y}`;
}

function ageFrom(dob, onDate) {
  if (!dob || !onDate) return null;
  const [by, bm, bd] = dob.split('-').map(Number);
  const [ry, rm, rd] = onDate.split('-').map(Number);
  let age = ry - by;
  if (rm < bm || (rm === bm && rd < bd)) age -= 1;
  return age >= 0 && age < 150 ? age : null;
}

/**
 * One line covering what the chart says about a death — "Died 12 Aug 2026 at
 * 04:20 — Septic shock" — with each part left out when it was never recorded.
 * Returns '' for a living patient, so callers can use it as the condition too.
 */
function deathSummary(patient) {
  if (!patient.deceased) return '';
  const when = patient.deathDate
    ? `Died ${prettyDate(patient.deathDate)}${patient.deathTime ? ` at ${patient.deathTime}` : ''}`
    : 'Died — date not recorded';
  const cause = (patient.causeOfDeath || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' · ');
  return cause ? `${when} — ${cause}` : when;
}

/**
 * Ward order for the admitted list. A round is walked ward by ward, so that is
 * the order the list has to be in — and "Melati 10" belongs after "Melati 9",
 * which is exactly what a plain string sort gets wrong. Patients with no ward
 * recorded go last rather than first, where an empty string would put them:
 * they are the ones nobody can walk to yet.
 */
function byWard(a, b) {
  const left = (a.ward || '').trim();
  const right = (b.ward || '').trim();
  if (!left !== !right) return left ? -1 : 1;
  const ward = left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
  if (ward) return ward;
  return a.patient.name.localeCompare(b.patient.name, undefined, { sensitivity: 'base' });
}

function typeLabel(type, plural = false) {
  const base = type === 'inpatient' ? 'Inpatient' : 'Outpatient';
  return plural ? `${base}s` : base;
}

function dateLabel(type) {
  return type === 'inpatient' ? 'Admission date' : 'Visit date';
}

// --------------------------------------------------------------------- gate

function renderGate() {
  document.body.classList.add('gated');
  root.replaceChildren(state.needsSetup ? setupCard() : loginCard());
}

function gateWrap(...children) {
  return el('div', { class: 'gate' }, el('div', { class: 'card' }, ...children));
}

function loginCard() {
  const error = el('div', { class: 'notice notice-error', style: 'display:none' });
  const username = el('input', { type: 'text', id: 'u', autocomplete: 'username', autofocus: true });
  const password = el('input', { type: 'password', id: 'p', autocomplete: 'current-password' });
  const button = el('button', { class: 'btn btn-primary', type: 'submit', style: 'width:100%' }, 'Sign in');

  const form = el(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        error.style.display = 'none';
        button.disabled = true;
        button.textContent = 'Signing in…';
        try {
          const data = await api('/api/login', {
            method: 'POST',
            body: { username: username.value, password: password.value },
          });
          state.user = data.user;
          document.body.classList.remove('gated');
          route();
        } catch (err) {
          error.textContent = err.message;
          error.style.display = '';
          password.value = '';
          password.focus();
        } finally {
          button.disabled = false;
          button.textContent = 'Sign in';
        }
      },
    },
    el('h1', { text: 'Picture EMR' }),
    el('p', { class: 'sub', style: 'margin-bottom:20px', text: 'Sign in to open patient records.' }),
    error,
    el('div', { class: 'field' }, el('label', { for: 'u', text: 'Username' }), username),
    el('div', { class: 'field' }, el('label', { for: 'p', text: 'Password' }), password),
    button
  );

  return gateWrap(form);
}

function setupCard() {
  const error = el('div', { class: 'notice notice-error', style: 'display:none' });
  const fullName = el('input', { type: 'text', id: 'fn', autocomplete: 'name' });
  const username = el('input', { type: 'text', id: 'u', autocomplete: 'username', autofocus: true });
  const password = el('input', { type: 'password', id: 'p', autocomplete: 'new-password' });
  const confirm = el('input', { type: 'password', id: 'p2', autocomplete: 'new-password' });
  const button = el('button', { class: 'btn btn-primary', type: 'submit', style: 'width:100%' }, 'Create account');

  const form = el(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        error.style.display = 'none';
        if (password.value !== confirm.value) {
          error.textContent = 'The two passwords do not match.';
          error.style.display = '';
          return;
        }
        button.disabled = true;
        try {
          await api('/api/setup', {
            method: 'POST',
            body: {
              username: username.value.trim().toLowerCase(),
              password: password.value,
              fullName: fullName.value,
            },
          });
          state.needsSetup = false;
          await bootstrap();
          document.body.classList.remove('gated');
          location.hash = '#/inpatient';
          route();
        } catch (err) {
          error.textContent = err.message;
          error.style.display = '';
        } finally {
          button.disabled = false;
        }
      },
    },
    el('h1', { text: 'Set up Picture EMR' }),
    el('p', {
      class: 'sub',
      style: 'margin-bottom:20px',
      text: 'This is the first run. Create the account you will use to sign in.',
    }),
    error,
    el('div', { class: 'field' }, el('label', { for: 'fn', text: 'Your name' }), fullName),
    el(
      'div',
      { class: 'field' },
      el('label', { for: 'u', text: 'Username' }),
      username,
      el('div', { class: 'field-hint', text: 'Letters, numbers, dot, dash or underscore.' })
    ),
    el(
      'div',
      { class: 'field' },
      el('label', { for: 'p', text: 'Password' }),
      password,
      el('div', { class: 'field-hint', text: 'At least 10 characters. Choose something only you know.' })
    ),
    el('div', { class: 'field' }, el('label', { for: 'p2', text: 'Confirm password' }), confirm),
    button
  );

  return gateWrap(form);
}

// -------------------------------------------------------------------- shell

function shell(view) {
  const hash = location.hash || '#/inpatient';
  const link = (href, label) =>
    el('a', { href, class: hash.startsWith(href) ? 'active' : '', text: label });

  root.replaceChildren(
    el(
      'header',
      { class: 'topbar' },
      el(
        'div',
        { class: 'brand' },
        el('span', {
          html:
            '<svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">' +
            '<rect width="32" height="32" rx="7" fill="currentColor" opacity=".12"/>' +
            '<path d="M16 9v14M9 16h14" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/></svg>',
          style: 'color:var(--accent);display:flex',
        }),
        'Picture EMR'
      ),
      el('nav', { class: 'nav' }, link('#/inpatient', 'Inpatient'), link('#/outpatient', 'Outpatient'), link('#/reports', 'Reports')),
      el(
        'div',
        { class: 'topbar-user' },
        el('a', {
          class: `who-link${hash.startsWith('#/account') ? ' active' : ''}`,
          href: '#/account',
          text: state.user?.fullName || state.user?.username || '',
          title: 'Your account',
        }),
        el(
          'button',
          {
            class: 'btn btn-sm btn-ghost',
            onclick: async () => {
              await api('/api/logout', { method: 'POST' });
              state.user = null;
              renderGate();
            },
          },
          'Sign out'
        )
      )
    ),
    el('main', {}, view)
  );
}

// -------------------------------------------------------------- daily chart

/** Look-back windows, matching the ones /api/stats/daily accepts. */
const CHART_WINDOWS = [14, 30, 90];

/**
 * What the columns count. An admitted patient produces two different daily
 * numbers — the day they arrived, and every day since that somebody went to see
 * them — and a ward asks about the second far more often, so both are offered.
 * A clinic visit is only ever the one day, so there is nothing to choose.
 */
const CHART_METRICS = {
  inpatient: [
    { key: 'visits', tab: 'Admissions', title: 'Admissions per day', one: 'admission', many: 'admissions' },
    { key: 'seen', tab: 'Ward round', title: 'Patients seen per day', one: 'patient seen', many: 'patients seen' },
  ],
  outpatient: [
    { key: 'visits', tab: 'Visits', title: 'Clinic visits per day', one: 'visit', many: 'visits' },
  ],
};

/** The shortest form that still reads as a date under an axis: "24 Aug". */
function axisDate(iso) {
  return prettyDate(iso).split(' ').slice(0, 2).join(' ');
}

/**
 * A round number for the top of the scale, so the two ticks land on values a
 * person would actually say. Small counts keep a tight scale — a ward that saw
 * three patients should not be drawn against a top of ten, with every column a
 * stub — and every top is even, so the midpoint tick is a whole number.
 */
function niceTop(peak) {
  const value = Math.max(peak, 2);
  const step = value <= 10 ? 2 : value <= 50 ? 10 : 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / step) * step;
}

/** A row of mutually exclusive buttons — the range and metric pickers. */
function segmented(options, initial, onPick) {
  const buttons = options.map((option) =>
    el('button', { type: 'button', text: option.label, onclick: () => choose(option.value) })
  );
  function choose(value, notify = true) {
    options.forEach((option, i) => {
      const on = option.value === value;
      buttons[i].classList.toggle('on', on);
      buttons[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (notify) onPick(value);
  }
  choose(initial, false);
  return el('div', { class: 'seg' }, ...buttons);
}

/**
 * One column per day, for the last few weeks.
 *
 * The stat cards above answer "how many this month". The shape of the month is a
 * different question — which days are busy, which day nothing was written down
 * at all, whether last week looked like this one — and it is the question a
 * single running total can never answer. Clicking a column narrows the list
 * below to that day, so a spike can be read as well as seen.
 */
function dailyChart(type, onPickDate) {
  const metrics = CHART_METRICS[type];
  let metric = metrics[0];
  let days = 30;
  let data = null;
  let request = 0;

  const title = el('h2');
  const caption = el('p', { class: 'sub' });
  const axisY = el('div', { class: 'chart-y' });
  const plot = el('div', { class: 'chart-plot' });
  const axisX = el('div', { class: 'chart-x' });
  const body = el('div', { class: 'chart-body' }, axisY, plot);
  const tip = el('div', { class: 'chart-tip', hidden: true });
  const table = el('details', { class: 'chart-table' });
  const controls = el('div', { class: 'chart-controls' });

  if (metrics.length > 1) {
    controls.append(
      segmented(
        metrics.map((m) => ({ value: m.key, label: m.tab })),
        metric.key,
        (key) => {
          // Both metrics come down in the same response, so switching is a redraw
          // rather than a round trip.
          metric = metrics.find((m) => m.key === key);
          draw();
        }
      )
    );
  }
  controls.append(
    segmented(
      CHART_WINDOWS.map((n) => ({ value: n, label: `${n} d` })),
      days,
      (n) => {
        days = n;
        load();
      }
    )
  );

  const hideTip = () => {
    tip.hidden = true;
  };

  /** Parks the readout above the hovered column, kept inside the plot's edges. */
  function showTip(slot, date, reading, fraction) {
    tip.replaceChildren(el('b', { text: reading }), el('span', { text: prettyDate(date) }));
    tip.hidden = false;
    tip.style.bottom = `calc(${fraction * 100}% + 9px)`;
    const half = tip.offsetWidth / 2;
    const centre = slot.offsetLeft + slot.offsetWidth / 2;
    tip.style.left = `${Math.min(Math.max(centre, half), Math.max(plot.clientWidth - half, half))}px`;
  }

  function draw() {
    if (!data) return;
    const counts = data.points.map((point) => point[metric.key] ?? 0);
    const total = counts.reduce((sum, n) => sum + n, 0);
    const peak = Math.max(...counts);
    const busiest = data.points[counts.indexOf(peak)];
    // Only a day that stands alone at the top gets its number written on it. On a
    // ward where three days running all hit three, singling out the first one
    // reads as though it meant something.
    const soleBusiest = counts.filter((n) => n === peak).length === 1;
    const top = niceTop(peak);
    const reading = (n) => `${n} ${n === 1 ? metric.one : metric.many}`;

    title.textContent = metric.title;
    caption.textContent = total
      ? `${reading(total)} in ${data.days} days · busiest ${axisDate(busiest.date)} — ${peak}`
      : `Nothing recorded in the last ${data.days} days.`;

    axisY.replaceChildren(
      ...[top, top / 2, 0].map((value) =>
        el('span', { style: `bottom:${(value / top) * 100}%`, text: value.toLocaleString() })
      )
    );

    const bars = el('div', { class: 'chart-cols' });
    data.points.forEach((point, i) => {
      const n = counts[i];
      const slot = el('button', {
        type: 'button',
        class: 'chart-col-slot',
        // The whole column is the target, not the drawn bar: a quiet day is a few
        // pixels tall, and on a phone that is nothing to aim at.
        'aria-label': `${prettyDate(point.date)} — ${reading(n)}. Show this day.`,
        onclick: () => onPickDate?.(point.date),
      });
      if (n) {
        const bar = el('span', { class: 'chart-col', style: `height:${(n / top) * 100}%` });
        // The peak is the one column worth naming outright; every other value is
        // a hover away, or a row in the table below. Past a month the columns are
        // too narrow to hold the number without it overhanging its neighbours.
        if (point === busiest && soleBusiest && data.days <= 30) {
          bar.append(el('span', { class: 'chart-col-val', text: String(n) }));
        }
        slot.append(bar);
      }
      const show = () => showTip(slot, point.date, reading(n), n / top);
      slot.addEventListener('pointerenter', show);
      slot.addEventListener('focus', show);
      slot.addEventListener('pointerleave', hideTip);
      slot.addEventListener('blur', hideTip);
      bars.append(slot);
    });

    hideTip();
    plot.replaceChildren(
      ...[0, 50, 100].map((pct) => el('div', { class: 'gridline', style: `bottom:${pct}%` })),
      bars,
      tip
    );

    const middle = data.points[Math.floor((data.points.length - 1) / 2)];
    axisX.replaceChildren(
      el('span', { text: axisDate(data.from) }),
      el('span', { text: axisDate(middle.date) }),
      el('span', { text: axisDate(data.to) })
    );

    // Every value the tooltip can show, reachable without a pointer at all —
    // and the thing to copy from when the number is wanted on paper.
    table.replaceChildren(
      el('summary', { text: 'Show the numbers' }),
      el(
        'div',
        { class: 'chart-rows-scroll' },
        el(
          'table',
          { class: 'chart-rows' },
          el(
            'tbody',
            {},
            ...[...data.points].reverse().map((point) =>
              el(
                'tr',
                {},
                el('th', { scope: 'row', text: prettyDate(point.date) }),
                el('td', { text: String(point[metric.key] ?? 0) })
              )
            )
          )
        )
      )
    );
  }

  async function load() {
    const ticket = (request += 1);
    // A reload holds the previous columns at half strength rather than blanking
    // the card — changing the range should not make the page jump.
    if (data) body.classList.add('loading');
    else plot.replaceChildren(el('div', { class: 'chart-note', text: 'Loading…' }));
    try {
      const fresh = await api(`/api/stats/daily?type=${type}&days=${days}`);
      if (ticket !== request) return;
      data = fresh;
      draw();
    } catch (err) {
      if (ticket !== request) return;
      data = null;
      title.textContent = metric.title;
      caption.textContent = '';
      table.replaceChildren();
      plot.replaceChildren(el('div', { class: 'chart-note', text: err.message }));
    } finally {
      if (ticket === request) body.classList.remove('loading');
    }
  }

  load();

  return el(
    'section',
    { class: 'card chart-card' },
    el('div', { class: 'chart-head' }, el('div', {}, title, caption), controls),
    body,
    axisX,
    table
  );
}

// --------------------------------------------------------------- list view

async function listView(type) {
  const container = el('div');
  shell(container);

  const search = el('input', {
    type: 'search',
    class: 'search',
    placeholder: `Search ${typeLabel(type, true).toLowerCase()} by name, MR number or diagnosis…`,
  });
  const fromInput = el('input', { type: 'date' });
  const toInput = el('input', { type: 'date' });
  const results = el('div', { class: 'enc-list' });
  const summary = el('div', { class: 'sub' });
  const statsRow = el('div', { class: 'stats' });

  let timer;
  const debounced = () => {
    clearTimeout(timer);
    timer = setTimeout(load, 220);
  };
  search.addEventListener('input', debounced);
  fromInput.addEventListener('change', load);
  toInput.addEventListener('change', load);

  const chart = dailyChart(type, (date) => {
    fromInput.value = date;
    toInput.value = date;
    load();
    // On a phone the list starts below the fold, so a column that quietly filters
    // something off-screen reads as a tap that did nothing.
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  container.replaceChildren(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', { text: typeLabel(type, true) }),
        el('p', {
          class: 'sub',
          text:
            type === 'inpatient'
              ? 'Admitted patients and their scanned chart pages.'
              : 'Clinic visits and their scanned chart pages.',
        })
      ),
      el(
        'a',
        { class: 'btn btn-primary', href: `#/new/${type}` },
        `+ New ${type === 'inpatient' ? 'admission' : 'visit'}`
      )
    ),
    statsRow,
    chart,
    el(
      'div',
      { class: 'toolbar' },
      search,
      el('div', { class: 'row' }, el('span', { class: 'label', style: 'margin:0', text: 'From' }), fromInput),
      el('div', { class: 'row' }, el('span', { class: 'label', style: 'margin:0', text: 'To' }), toInput),
      el(
        'button',
        {
          class: 'btn btn-sm btn-ghost',
          onclick: () => {
            search.value = '';
            fromInput.value = '';
            toInput.value = '';
            load();
          },
        },
        'Clear'
      )
    ),
    summary,
    el('div', { style: 'height:10px' }),
    results
  );

  api('/api/stats')
    .then((stats) => {
      const card = (n, k) => el('div', { class: 'card stat' }, el('div', { class: 'n', text: String(n) }), el('div', { class: 'k', text: k }));
      const cards = [
        card(type === 'inpatient' ? stats.inpatient : stats.outpatient, `${typeLabel(type, true)} this month`),
        card(stats.patients, 'Patients on file'),
        card(stats.attachments, 'Pages stored'),
      ];
      // A clinic session is counted at the end of the day, so the day's own
      // tally goes first — ahead of the running month.
      if (type === 'outpatient' && stats.today) {
        cards.unshift(card(stats.today.outpatient, 'Outpatients today'));
      }
      statsRow.replaceChildren(...cards);
    })
    .catch(() => {});

  async function load() {
    results.replaceChildren(el('div', { class: 'sub', text: 'Loading…' }));
    const params = new URLSearchParams({ type, limit: '200' });
    if (search.value.trim()) params.set('q', search.value.trim());
    if (fromInput.value) params.set('from', fromInput.value);
    if (toInput.value) params.set('to', toInput.value);
    try {
      const data = await api(`/api/encounters?${params}`);
      summary.textContent = data.total
        ? `${data.total} record${data.total === 1 ? '' : 's'}${data.total > data.items.length ? ` — showing the ${data.items.length} most recent` : ''}`
        : '';
      if (!data.items.length) {
        results.replaceChildren(
          el(
            'div',
            { class: 'empty' },
            el('p', { text: search.value || fromInput.value || toInput.value ? 'No records match those filters.' : `No ${typeLabel(type, true).toLowerCase()} yet.` }),
            el('p', { style: 'font-size:13px', text: 'Use the button above to add one.' })
          )
        );
        return;
      }
      // Each list leads with the patients still in front of you — the ward's
      // admitted patients, the clinic's visits from today — and puts the rest
      // under its own heading, instead of leaving both mixed in one date-sorted
      // pile you have to read through.
      const split =
        type === 'inpatient'
          ? {
              // Ward order, not date order: the admitted list is what a round is
              // walked from, and a round goes bed by bed down a corridor. When
              // they were admitted decides nothing about where you find them.
              lead: data.items.filter((e) => !e.dischargeDate).sort(byWard),
              leadTitle: 'Admitted',
              restTitle: 'Discharged',
              noun: 'patient',
              countSeen: true,
            }
          : {
              lead: data.items.filter((e) => e.admissionDate === state.today),
              leadTitle: `Today — ${prettyDate(state.today)}`,
              restTitle: 'Earlier',
              noun: 'visit',
            };

      if (!split.lead.length) {
        results.replaceChildren(...data.items.map((enc) => encounterRow(enc)));
        return;
      }
      const leading = new Set(split.lead.map((e) => e.id));
      const rest = data.items.filter((e) => !leading.has(e.id));
      results.replaceChildren(
        listSection(split.leadTitle, split.lead, split.noun, split.countSeen),
        ...(rest.length ? [listSection(split.restTitle, rest, split.noun)] : [])
      );
    } catch (err) {
      results.replaceChildren(el('div', { class: 'notice notice-error', text: err.message }));
    }
  }

  load();
}

function listSection(title, items, noun, showSeen = false) {
  // The tally is a live node rather than a string: ticking a patient off from
  // this list has to move the count in the heading, or the one number saying
  // how much of the round is left would be wrong until the next reload.
  const tally = el('span', { class: 'sub' });
  const refreshTally = () => {
    const seen = items.filter((e) => e.visitedToday).length;
    tally.textContent =
      `${items.length} ${noun}${items.length === 1 ? '' : 's'}` +
      (showSeen ? ` · ${seen} seen today` : '');
  };
  refreshTally();

  return el(
    'div',
    { class: 'enc-section' },
    el('div', { class: 'enc-section-head' }, el('h2', { text: title }), tally),
    el('div', { class: 'enc-list' }, ...items.map((enc) => encounterRow(enc, refreshTally)))
  );
}

/**
 * Today's ward round, as one tap.
 *
 * A round is walked with the phone in one hand, and the thing that actually
 * gets lost is not what was found at each bed but which beds have been been to
 * at all — especially when two people split a ward between them. The button
 * carries who ticked it, because "has anyone seen bed 4" is the question being
 * asked out loud.
 */
function roundButton(enc, onChange) {
  const button = el('button', { type: 'button', class: 'round-btn' });

  const paint = () => {
    button.classList.toggle('on', !!enc.visitedToday);
    button.textContent = enc.visitedToday ? '✓ Seen today' : 'Mark seen';
    button.title = enc.visitedToday
      ? `Seen today${enc.lastVisitBy ? ` by ${enc.lastVisitBy}` : ''} — tap to undo`
      : enc.lastVisit
        ? `Last seen ${prettyDate(enc.lastVisit)}. Tap to mark seen today.`
        : 'Not seen yet on this admission. Tap to mark seen today.';
  };

  button.addEventListener('click', async (event) => {
    // The whole row behind this is a link into the record, and a tick is not a
    // request to open it.
    event.preventDefault();
    event.stopPropagation();

    button.disabled = true;
    try {
      const updated = await api(`/api/encounters/${enc.id}/round`, {
        method: enc.visitedToday ? 'DELETE' : 'POST',
      });
      enc.visitedToday = updated.visitedToday;
      enc.lastVisit = updated.lastVisit;
      enc.lastVisitBy = updated.lastVisitBy;
      paint();
      onChange?.();
    } catch (err) {
      toast(err.message, true);
    } finally {
      button.disabled = false;
    }
  });

  paint();
  return button;
}

function encounterRow(enc, onRoundChange) {
  // Only a patient still in a bed can be on today's round: a discharged record
  // and a clinic visit are both finished, and a tick on either would mean
  // nothing anybody could act on.
  const onRound = enc.type === 'inpatient' && !enc.dischargeDate;
  const pages = CATEGORIES.map((c) =>
    el(
      'span',
      { class: `pill${enc.attachmentCounts[c.key] ? ' has' : ''}`, title: c.label },
      `${c.label.split(' ')[0]} ${enc.attachmentCounts[c.key] || 0}`
    )
  );

  const care = CARE_STATUS[enc.careRole];

  const died = deathSummary(enc.patient);

  const meta = [
    el('span', { class: 'mr', text: enc.patient.mrNumber }),
    el('span', { text: enc.patient.sex === 'M' ? 'Male' : 'Female' }),
    enc.age !== null ? el('span', { text: `${enc.age} y` }) : null,
    enc.ward ? el('span', { text: enc.ward }) : null,
    // First of the badges: nothing else about the record matters as much, and it
    // has to be visible without opening the chart.
    died ? el('span', { class: 'badge badge-died', text: 'DECEASED', title: died }) : null,
    died && enc.patient.deathDate
      ? el('span', { text: `d. ${prettyDate(enc.patient.deathDate)}` })
      : null,
    // No ADMITTED badge: the list is split into Admitted and Discharged, so every
    // row that would carry one already sits under a heading saying so.
    care
      ? el('span', {
          class: `badge ${care.cls}`,
          text: care.badge,
          title: care.partner && enc.careLeader ? care.long(enc.careLeader) : '',
        })
      : null,
    care && care.partner && enc.careLeader
      ? el('span', { text: `${care.partner} ${enc.careLeader}` })
      : null,
    // Who we have asked to see them. Only ever set on a patient we lead, so it
    // reads as ours to chase rather than somebody else's note.
    enc.careRole === 'leader' && enc.consultedTo
      ? el('span', {
          class: 'consulted',
          text: `→ ${enc.consultedTo}`,
          title: `Consulted to ${enc.consultedTo}`,
        })
      : null,
    // Said in days rather than left to an unlit button: "last seen Tuesday" is
    // the difference between a patient not yet reached this morning and one who
    // has been missed for three days.
    onRound && !enc.visitedToday && enc.lastVisit
      ? el('span', { class: 'stale', text: `last seen ${prettyDate(enc.lastVisit)}` })
      : null,
  ].filter(Boolean);

  const firstLines = (enc.diagnosis || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  return el(
    'a',
    { class: 'enc', href: `#/e/${enc.id}` },
    el(
      'div',
      { class: 'enc-main' },
      el('div', { class: 'enc-name', text: enc.patient.name }),
      el('div', { class: 'enc-meta' }, ...meta),
      firstLines.length
        ? el('div', {
            class: 'enc-dx',
            text: firstLines.join(' · '),
            title: enc.diagnosis,
          })
        : el('div', { class: 'enc-dx', style: 'font-style:italic', text: 'No diagnosis recorded' })
    ),
    el(
      'div',
      { class: 'enc-side' },
      el('div', { class: 'enc-date', text: prettyDate(enc.admissionDate) }),
      enc.dischargeDate
        ? el('div', { class: 'sub', style: 'font-size:12px', text: `dc ${prettyDate(enc.dischargeDate)}` })
        : null,
      el('div', { class: 'pills' }, ...pages),
      onRound ? roundButton(enc, onRoundChange) : null
    )
  );
}

// ------------------------------------------------------- identity form bits

function identityFields(type, initial = {}) {
  const mrNumber = el('input', { type: 'text', value: initial.mrNumber || '', placeholder: 'e.g. 00-12-34-56' });
  const name = el('input', { type: 'text', value: initial.name || '', placeholder: 'Full name as written on the chart' });
  const sex = el(
    'select',
    {},
    el('option', { value: 'M', selected: (initial.sex || 'M') === 'M' }, 'Male'),
    el('option', { value: 'F', selected: initial.sex === 'F' }, 'Female')
  );
  const dob = el('input', { type: 'date', value: initial.dob || '', max: state.today });
  const ageManual = el('input', {
    type: 'number',
    min: '0',
    max: '149',
    placeholder: '—',
    value: initial.ageManual ?? '',
  });
  const admissionDate = el('input', {
    type: 'date',
    value: initial.admissionDate || state.today,
    max: state.today,
  });
  const dischargeDate = el('input', { type: 'date', value: initial.dischargeDate || '' });
  const deceased = el('input', { type: 'checkbox', id: 'died', checked: !!initial.deceased });
  const deathDate = el('input', { type: 'date', value: initial.deathDate || '', max: state.today });
  const deathTime = el('input', { type: 'time', value: initial.deathTime || '' });
  const causeOfDeath = el(
    'textarea',
    { style: 'min-height:70px', placeholder: 'e.g. Septic shock\nCommunity-acquired pneumonia' },
    initial.causeOfDeath || ''
  );
  const careRole = el('select', {});
  const careLeader = el('input', { type: 'text', value: initial.careLeader || '' });
  const consultedTo = el('input', {
    type: 'text',
    value: initial.consultedTo || '',
    placeholder: 'e.g. Cardiology, Nephrology',
  });
  const ward = el('input', {
    type: 'text',
    value: initial.ward || '',
    placeholder: type === 'inpatient' ? 'Ward / room' : 'Clinic / poly',
  });
  const diagnosis = el(
    'textarea',
    { placeholder: 'One diagnosis per line:\n\nCHF NYHA III\nDM type 2\nCKD stage 3' },
    initial.diagnosis || ''
  );

  const ageHint = el('div', { class: 'field-hint' });
  const refreshAge = () => {
    const computed = ageFrom(dob.value, admissionDate.value);
    if (computed !== null) {
      ageHint.textContent = `Age at ${dateLabel(type).toLowerCase()}: ${computed} years — this is what the report will use.`;
      ageManual.disabled = true;
      ageManual.placeholder = String(computed);
    } else {
      ageManual.disabled = false;
      ageManual.placeholder = '—';
      ageHint.textContent = dob.value
        ? 'Check the date of birth — it must be on or before the visit date.'
        : 'No date of birth: the report will use the age typed here.';
    }
  };
  dob.addEventListener('change', refreshAge);
  admissionDate.addEventListener('change', refreshAge);
  refreshAge();

  // A phone's native date picker has no way to empty a field it has already
  // filled, so a patient wrongly marked discharged could not be put back to
  // admitted from the ward. This button is that undo.
  const clearDischarge = el(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-ghost',
      title: 'Clear the discharge date — puts the patient back to still admitted',
      onclick: () => {
        dischargeDate.value = '';
        refreshDischarge();
        dischargeDate.focus();
      },
    },
    'Clear'
  );

  const dischargeHint = el('div', { class: 'field-hint' });
  const refreshDischarge = () => {
    clearDischarge.disabled = !dischargeDate.value;
    dischargeHint.textContent = dischargeDate.value
      ? 'Discharged. Use Clear to put this patient back to still admitted.'
      : 'Leave empty while the patient is still admitted.';
    // The death hint reads the discharge date, so it moves with it.
    refreshDeath();
  };
  dischargeDate.addEventListener('change', refreshDischarge);

  const dischargeField = el(
    'div',
    { class: 'field', style: type === 'inpatient' ? '' : 'display:none' },
    el('label', { text: 'Discharge date' }),
    el('div', { class: 'input-row' }, dischargeDate, clearDischarge),
    dischargeHint
  );

  // The details of a death are all optional: the ward knows the patient died
  // long before the chart says when or of what, and a record that refuses to
  // save without them just means the status never gets recorded at all.
  const deathHint = el('div', { class: 'field-hint' });
  const deathDetails = el(
    'div',
    {},
    el(
      'div',
      { class: 'grid-2' },
      el('div', { class: 'field' }, el('label', { text: 'Date of death' }), deathDate),
      el('div', { class: 'field' }, el('label', { text: 'Time of death' }), deathTime)
    ),
    el('div', { class: 'field' }, el('label', { text: 'Cause of death' }), causeOfDeath),
    deathHint
  );

  function refreshDeath() {
    deathDetails.style.display = deceased.checked ? '' : 'none';
    if (!deceased.checked) return;
    // An admission left open would keep a dead patient sitting in the ward's
    // Admitted list, which is the one place the status has to be right.
    deathHint.textContent =
      type === 'inpatient' && !dischargeDate.value
        ? 'All three are optional. This admission is still open — set the discharge date so the ward list stops showing this patient as admitted.'
        : 'All three are optional. Leave any of them blank if the chart does not say.';
  }
  deceased.addEventListener('change', refreshDeath);

  const deathBlock = el(
    'div',
    { class: 'death-block' },
    el(
      'div',
      { class: 'check' },
      deceased,
      el('label', { for: 'died', text: 'Patient is deceased' })
    ),
    deathDetails
  );

  refreshDischarge();

  const careLeaderLabel = el('label', {});
  const careLeaderHint = el('div', { class: 'field-hint' });
  const careLeaderField = el('div', { class: 'field' }, careLeaderLabel, careLeader, careLeaderHint);
  const careHint = el('div', { class: 'field-hint' });

  // The mirror image of the field above it. Where shared care and a consult ask
  // who is carrying the patient, this asks who we have asked to come and look —
  // a question that only makes sense about a patient we are carrying ourselves.
  const consultedField = el(
    'div',
    { class: 'field' },
    el('label', { text: 'Consulted to' }),
    consultedTo,
    el('div', {
      class: 'field-hint',
      text: 'Departments you have asked to see this patient. Separate several with commas.',
    })
  );

  // Only the statuses that name somebody else reveal the second field, and the
  // wording follows the status — a leading team and a referring department are
  // not the same thing to write down.
  const refreshCare = () => {
    const partner = CARE_PARTNER_FIELD[careRole.value];
    careLeaderField.style.display = partner ? '' : 'none';
    consultedField.style.display = careRole.value === 'leader' ? '' : 'none';
    if (partner) {
      careLeaderLabel.textContent = partner.label;
      careLeaderHint.textContent = partner.hint;
      careLeader.placeholder = partner.placeholder;
    }
  };

  // Rebuilt on every type change: shared care has no clinic equivalent and a
  // consult none on the ward, so a status the new kind of record does not offer
  // falls back to blank rather than being saved as something it cannot mean.
  const fillCareOptions = (nextType) => {
    const chosen = careRole.value;
    careRole.replaceChildren(
      ...CARE_OPTIONS[nextType].map(([value, label]) => el('option', { value }, label))
    );
    careRole.value = chosen;
    careHint.textContent = CARE_HINT[nextType];
    refreshCare();
  };

  careRole.addEventListener('change', refreshCare);
  fillCareOptions(type);
  careRole.value = initial.careRole || '';
  refreshCare();

  const careBlock = el(
    'div',
    {},
    el('div', { class: 'field' }, el('label', { text: 'Patient status' }), careRole, careHint),
    careLeaderField,
    consultedField
  );

  const admissionLabel = el('label', { text: `${dateLabel(type)} *` });
  const wardLabel = el('label', { text: type === 'inpatient' ? 'Ward / room' : 'Clinic' });

  const node = el(
    'div',
    {},
    el(
      'div',
      { class: 'field' },
      el('label', { text: 'MR number *' }),
      mrNumber,
      el('div', { class: 'field-hint', text: 'Reusing an existing MR number links this to the same patient.' })
    ),
    el('div', { class: 'field' }, el('label', { text: 'Name *' }), name),
    el(
      'div',
      { class: 'grid-2' },
      el('div', { class: 'field' }, el('label', { text: 'Sex *' }), sex),
      el('div', { class: 'field' }, el('label', { text: 'Date of birth' }), dob)
    ),
    el('div', { class: 'field' }, el('label', { text: 'Age (only if DOB unknown)' }), ageManual, ageHint),
    el('div', { class: 'field' }, admissionLabel, admissionDate),
    dischargeField,
    deathBlock,
    careBlock,
    el('div', { class: 'field' }, wardLabel, ward),
    el(
      'div',
      { class: 'field' },
      el('label', { text: 'Diagnosis' }),
      diagnosis,
      el('div', { class: 'field-hint', text: 'Multi-line. Each line is kept exactly as typed in the CSV report.' })
    )
  );

  return {
    node,
    setType(next) {
      type = next;
      dischargeField.style.display = next === 'inpatient' ? '' : 'none';
      admissionLabel.textContent = `${dateLabel(next)} *`;
      wardLabel.textContent = next === 'inpatient' ? 'Ward / room' : 'Clinic';
      ward.placeholder = next === 'inpatient' ? 'Ward / room' : 'Clinic / poly';
      refreshAge();
      refreshDeath();
      fillCareOptions(next);
    },
    fill(patient) {
      name.value = patient.name;
      sex.value = patient.sex;
      dob.value = patient.dob || '';
      ageManual.value = patient.ageManual ?? '';
      // Carried over with the rest of the identity: saving this record writes the
      // patient row back, so a status left behind here would quietly undo it.
      deceased.checked = !!patient.deceased;
      deathDate.value = patient.deathDate || '';
      deathTime.value = patient.deathTime || '';
      causeOfDeath.value = patient.causeOfDeath || '';
      refreshAge();
      refreshDeath();
    },
    onMrBlur(handler) {
      mrNumber.addEventListener('blur', () => handler(mrNumber.value.trim()));
    },
    value() {
      return {
        mrNumber: mrNumber.value.trim(),
        name: name.value.trim(),
        sex: sex.value,
        dob: dob.value || null,
        ageManual: ageManual.disabled || ageManual.value === '' ? null : Number(ageManual.value),
        deceased: deceased.checked,
        deathDate: deceased.checked ? deathDate.value || null : null,
        deathTime: deceased.checked ? deathTime.value || null : null,
        causeOfDeath: deceased.checked ? causeOfDeath.value.trim() : '',
        admissionDate: admissionDate.value,
        dischargeDate: dischargeDate.value || null,
        careRole: careRole.value,
        careLeader: careLeader.value.trim(),
        consultedTo: consultedTo.value.trim(),
        ward: ward.value.trim(),
        diagnosis: diagnosis.value,
      };
    },
    /** Returns a message to show, or null when the form is ready to send. */
    validate() {
      if (deceased.checked && deathTime.value && !deathDate.value) {
        deathDate.focus();
        return 'A time of death needs the date it happened on.';
      }
      // Reaching this on a new record almost always means the MR number picked up
      // somebody else's chart, so the message points there first.
      if (deceased.checked && deathDate.value && deathDate.value < admissionDate.value) {
        deathDate.focus();
        const who = name.value.trim() || 'This patient';
        return `${who} is recorded as having died on ${prettyDate(deathDate.value)}, before this ${dateLabel(type).toLowerCase()}. Check the MR number and the dates.`;
      }
      if (CARE_PARTNER_FIELD[careRole.value] && !careLeader.value.trim()) {
        careLeader.focus();
        return careRole.value === 'shared'
          ? 'Shared care needs the name of the leading doctor or team.'
          : 'A consult needs the department or doctor who asked for it.';
      }
      return null;
    },
    focusFirst() {
      mrNumber.focus();
    },
  };
}

// ---------------------------------------------------------------- new record

function newView(initialType) {
  const container = el('div');
  shell(container);

  let type = initialType;
  const error = el('div', { class: 'notice notice-error', style: 'display:none' });
  const lookupNote = el('div', { class: 'field-hint', style: 'margin-bottom:12px' });
  const fields = identityFields(type, {});

  fields.onMrBlur(async (mr) => {
    lookupNote.textContent = '';
    lookupNote.className = 'field-hint';
    if (!mr) return;
    try {
      const data = await api(`/api/patients/lookup?mr=${encodeURIComponent(mr)}`);
      if (data.found) {
        fields.fill(data.patient);
        lookupNote.className = 'notice notice-info';
        lookupNote.replaceChildren(
          ...[
            `Existing patient: ${data.patient.name} — ${data.visits} previous record${data.visits === 1 ? '' : 's'}. Identity filled in.`,
            // Nothing has been typed yet but the MR number, so looking at what
            // the patient already has costs nothing to come back from — and it
            // is the moment you most want to know what was photographed before.
            data.visits
              ? el('a', { href: `#/p/${data.id}`, style: 'margin-left:6px' }, 'See their pages →')
              : null,
          ].filter(Boolean)
        );
      } else {
        lookupNote.textContent = 'New MR number — a new patient will be created.';
      }
    } catch {
      /* lookup is a convenience; failures are silent */
    }
  });

  const typeToggle = el(
    'div',
    { class: 'seg' },
    ...['inpatient', 'outpatient'].map((value) =>
      el(
        'button',
        {
          type: 'button',
          class: type === value ? 'on' : '',
          onclick: (event) => {
            type = value;
            [...typeToggle.children].forEach((b) => b.classList.remove('on'));
            event.currentTarget.classList.add('on');
            fields.setType(type);
          },
        },
        typeLabel(value)
      )
    )
  );

  const save = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Create record');

  const form = el(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        error.style.display = 'none';
        const payload = { ...fields.value(), type };
        const problem = !payload.mrNumber || !payload.name
          ? 'MR number and name are both required.'
          : fields.validate();
        if (problem) {
          error.textContent = problem;
          error.style.display = '';
          return;
        }
        save.disabled = true;
        save.textContent = 'Saving…';
        try {
          const enc = await api('/api/encounters', { method: 'POST', body: payload });
          toast('Record created — add chart photos next.');
          location.hash = `#/e/${enc.id}`;
        } catch (err) {
          error.textContent = err.message;
          error.style.display = '';
        } finally {
          save.disabled = false;
          save.textContent = 'Create record';
        }
      },
    },
    error,
    lookupNote,
    fields.node,
    el(
      'div',
      { class: 'row', style: 'margin-top:6px' },
      save,
      el('a', { class: 'btn btn-ghost', href: `#/${type}` }, 'Cancel')
    )
  );

  container.replaceChildren(
    el(
      'div',
      { class: 'page-head' },
      el('div', {}, el('h1', { text: 'New record' }), el('p', { class: 'sub', text: 'Identity page — you can attach chart photos on the next screen.' })),
      typeToggle
    ),
    el('div', { class: 'card', style: 'max-width:620px' }, form)
  );

  fields.focusFirst();
}

// ------------------------------------------------------------- detail view

async function detailView(id) {
  const container = el('div');
  shell(container);
  container.replaceChildren(el('div', { class: 'sub', text: 'Loading record…' }));

  let enc;
  try {
    enc = await api(`/api/encounters/${id}`);
  } catch (err) {
    container.replaceChildren(el('div', { class: 'notice notice-error', text: err.message }));
    return;
  }

  let type = enc.type;
  const error = el('div', { class: 'notice notice-error', style: 'display:none' });
  const fields = identityFields(type, {
    mrNumber: enc.patient.mrNumber,
    name: enc.patient.name,
    sex: enc.patient.sex,
    dob: enc.patient.dob,
    ageManual: enc.patient.ageManual,
    deceased: enc.patient.deceased,
    deathDate: enc.patient.deathDate,
    deathTime: enc.patient.deathTime,
    causeOfDeath: enc.patient.causeOfDeath,
    admissionDate: enc.admissionDate,
    dischargeDate: enc.dischargeDate,
    careRole: enc.careRole,
    careLeader: enc.careLeader,
    consultedTo: enc.consultedTo,
    ward: enc.ward,
    diagnosis: enc.diagnosis,
  });

  const typeToggle = el(
    'div',
    { class: 'seg' },
    ...['inpatient', 'outpatient'].map((value) =>
      el(
        'button',
        {
          type: 'button',
          class: type === value ? 'on' : '',
          onclick: (event) => {
            type = value;
            [...typeToggle.children].forEach((b) => b.classList.remove('on'));
            event.currentTarget.classList.add('on');
            fields.setType(type);
          },
        },
        typeLabel(value)
      )
    )
  );

  const save = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save changes');
  const savedNote = el('span', { class: 'sub', style: 'font-size:12.5px' });

  const headTitle = el('h1', {});
  const headSub = el('p', { class: 'sub' });
  // Death is the one fact on this screen that changes how everything else should
  // be read, so it gets its own line above the chart rather than a word buried
  // in the run of identity details.
  const deathNotice = el('div', { class: 'notice notice-death', style: 'display:none' });
  function refreshHead() {
    headTitle.textContent = enc.patient.name;
    headSub.textContent = [
      enc.patient.mrNumber,
      enc.patient.sex === 'M' ? 'Male' : 'Female',
      enc.age !== null ? `${enc.age} y` : null,
      typeLabel(enc.type),
      prettyDate(enc.admissionDate),
      CARE_STATUS[enc.careRole] ? CARE_STATUS[enc.careRole].long(enc.careLeader) : null,
      enc.careRole === 'leader' && enc.consultedTo ? `Consulted to ${enc.consultedTo}` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    const died = deathSummary(enc.patient);
    deathNotice.textContent = died;
    deathNotice.style.display = died ? '' : 'none';
  }

  const identityCard = el(
    'form',
    {
      class: 'card',
      onsubmit: async (event) => {
        event.preventDefault();
        error.style.display = 'none';
        const problem = fields.validate();
        if (problem) {
          error.textContent = problem;
          error.style.display = '';
          return;
        }
        save.disabled = true;
        save.textContent = 'Saving…';
        try {
          const updated = await api(`/api/encounters/${id}`, {
            method: 'PATCH',
            body: { ...fields.value(), type },
          });
          enc = updated;
          refreshHead();
          savedNote.textContent = `Saved ${new Date().toLocaleTimeString()}`;
          toast('Changes saved.');
        } catch (err) {
          error.textContent = err.message;
          error.style.display = '';
        } finally {
          save.disabled = false;
          save.textContent = 'Save changes';
        }
      },
    },
    el('div', { class: 'row', style: 'margin-bottom:14px' }, el('h2', { style: 'margin:0', text: 'Identity page' }), el('div', { class: 'spacer' }), typeToggle),
    error,
    fields.node,
    el('div', { class: 'row', style: 'margin-top:4px' }, save, savedNote),
    el(
      'div',
      { style: 'margin-top:18px;padding-top:14px;border-top:1px solid var(--border)' },
      el(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-danger',
          onclick: async () => {
            const total = Object.values(enc.attachmentCounts).reduce((a, b) => a + b, 0);
            const warning =
              `Delete this record for ${enc.patient.name} (${enc.patient.mrNumber})?` +
              (total ? `\n\n${total} stored page${total === 1 ? '' : 's'} will be permanently deleted.` : '') +
              '\n\nThis cannot be undone.';
            if (!confirm(warning)) return;
            try {
              await api(`/api/encounters/${id}`, { method: 'DELETE' });
              toast('Record deleted.');
              location.hash = `#/${type}`;
            } catch (err) {
              toast(err.message, true);
            }
          },
        },
        'Delete this record'
      )
    )
  );

  const pane = el('div', { class: 'card' });
  const tabs = el('div', { class: 'tabs' });
  // Owned by the view, not by renderPane: an upload finishing re-renders the
  // pane, and a host rebuilt in there would be detached mid-batch, leaving every
  // page after the first uploading into nothing you can see.
  const uploads = el('div');
  let active = CATEGORIES[1].key;

  /**
   * The pages of one section, newest first. The server stores them in page order
   * (page 1 first) and the numbering follows that, so a five-page chart reads
   * 5, 4, 3, 2, 1 — today's page is at the top where the ward needs it, without
   * renumbering the chart.
   */
  function displayShots(category) {
    return enc.attachments.filter((a) => a.category === category).reverse();
  }

  function renderTabs() {
    tabs.replaceChildren(
      ...CATEGORIES.map((cat) => {
        const n = enc.attachments.filter((a) => a.category === cat.key).length;
        return el(
          'button',
          {
            type: 'button',
            class: active === cat.key ? 'on' : '',
            onclick: () => {
              active = cat.key;
              renderTabs();
              renderPane();
            },
          },
          cat.label,
          el('span', { class: 'count', text: String(n) })
        );
      })
    );
  }

  function renderPane() {
    const shots = displayShots(active);
    const gallery = shots.length
      ? el('div', { class: 'gallery' }, ...shots.map((a, i) => shotCard(a, shots, i)))
      : el(
          'div',
          { class: 'empty' },
          el('p', { text: `No ${CATEGORIES.find((c) => c.key === active).label.toLowerCase()} pages yet.` }),
          el('p', { style: 'font-size:13px', text: 'Photograph the page and drop it above.' })
        );

    const orderHint =
      shots.length > 1
        ? el('p', {
            class: 'sub',
            style: 'margin:0 0 10px;font-size:12.5px',
            text: 'Newest page first. The number is the page number. Drag by ⠿ to move one, or use ← →.',
          })
        : null;

    pane.replaceChildren(dropZone(active), uploads, ...(orderHint ? [orderHint] : []), gallery);
  }

  function dropZone(category) {
    const picker = el('input', { type: 'file', accept: ACCEPT, multiple: true, style: 'display:none' });
    const camera = el('input', { type: 'file', accept: 'image/*', capture: 'environment', multiple: true, style: 'display:none' });

    const zone = el(
      'div',
      { class: 'drop' },
      el('p', { style: 'margin:0 0 10px;font-size:13.5px', text: 'Drop photos here, or' }),
      el(
        'div',
        { class: 'row' },
        el('button', { type: 'button', class: 'btn btn-sm', onclick: () => picker.click() }, 'Choose files'),
        el('button', { type: 'button', class: 'btn btn-sm', onclick: () => camera.click() }, 'Take photo'),
        picker,
        camera
      ),
      el('div', {
        class: 'field-hint',
        style: 'margin-top:10px',
        text: 'JPEG, PNG, WebP, HEIC or PDF.',
      })
    );

    const handle = (files) => queueUploads([...files], category);
    picker.addEventListener('change', () => { handle(picker.files); picker.value = ''; });
    camera.addEventListener('change', () => { handle(camera.files); camera.value = ''; });

    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      zone.classList.add('over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('over');
      if (event.dataTransfer?.files?.length) handle(event.dataTransfer.files);
    });

    return zone;
  }

  async function queueUploads(files, category) {
    // Pages are stored in the order they upload, and a phone's picker hands a
    // multi-selection back in whatever order it likes. Sorting by capture time
    // keeps the chart in the order it was photographed. Equal or missing
    // timestamps keep the order they were handed over in.
    const ordered = [...files].sort((a, b) => (a.lastModified || 0) - (b.lastModified || 0));

    // Every page in the batch gets its row up front. Uploading is still one at a
    // time — a ward phone on hospital wifi does not thank you for six parallel
    // 3 MB posts — but you can see the whole queue rather than one lone bar with
    // no way to tell whether it means this page or all of them.
    const summary = el('div', { class: 'upload-summary' });
    const batch = el('div', { class: 'upload-batch' }, summary);
    const rows = ordered.map((file) => {
      const bar = el('i', { style: 'width:0%' });
      const status = el('span', { class: 'upload-status', text: 'waiting' });
      const row = el(
        'div',
        { class: 'upload-row' },
        el('span', { class: 'upload-name', text: file.name }),
        el('div', { class: 'bar' }, bar),
        status
      );
      batch.append(row);
      return { file, row, bar, status };
    });
    uploads.append(batch);

    let finished = 0;
    let failed = 0;
    const total = rows.length;
    const page = (n) => `${n} page${n === 1 ? '' : 's'}`;
    const setSummary = (current) => {
      summary.textContent =
        finished + failed === total
          ? failed
            ? `${page(finished)} saved, ${failed} failed — the failed ones were not stored.`
            : `${page(finished)} saved.`
          : `Uploading ${page(total)} — ${finished + failed + 1} of ${total}${current ? `: ${current}` : ''}`;
    };
    setSummary();

    for (const item of rows) {
      item.row.classList.add('active');
      item.status.textContent = 'preparing…';
      setSummary(item.file.name);
      try {
        const { full, thumb } = await prepareImage(item.file);
        const size = formatBytes(full.size);
        const created = await uploadOne(full, item.file.name, category, (pct) => {
          item.bar.style.width = `${Math.max(3, pct)}%`;
          item.status.textContent = `${Math.round(pct)}%`;
        });
        enc.attachments.push(created);

        // Follows the page up rather than holding the queue behind it — the next
        // page starts uploading while this one's thumbnail is still in the air.
        if (thumb) {
          sendThumb(created.id, thumb)
            .then(replaceShot)
            .catch(() => {
              /* the gallery falls back to the full page */
            });
        }
        item.bar.style.width = '100%';
        item.row.classList.remove('active');
        item.row.classList.add('done');
        item.status.textContent = `saved · ${size}`;
        finished += 1;
        renderTabs();
        renderPane();
      } catch (err) {
        item.row.classList.remove('active');
        item.row.classList.add('failed');
        item.status.textContent = err.message;
        item.bar.style.width = '100%';
        failed += 1;
        toast(`${item.file.name}: ${err.message}`, true);
      }
      setSummary();
    }

    // A clean batch clears itself; a batch with failures stays put so the pages
    // that did not save can be seen and retried.
    if (!failed) setTimeout(() => batch.remove(), 2500);
  }

  function uploadOne(blob, filename, category, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/encounters/${id}/attachments`);
      xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
      xhr.setRequestHeader('X-Category', category);
      xhr.setRequestHeader('X-Filename', encodeURIComponent(filename));
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress((event.loaded / event.total) * 100);
      });
      xhr.addEventListener('load', () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch { /* fall through to status check */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || `Upload failed (${xhr.status})`));
      });
      xhr.addEventListener('error', () => reject(new Error('Network error during upload.')));
      xhr.send(blob);
    });
  }

  /**
   * Moves one page within its own section and persists the new order. The move
   * is applied on screen first — waiting for the round trip makes tapping the
   * arrows on a ward phone feel broken.
   */
  function moveShot(category, from, to) {
    const shown = displayShots(category);
    if (from === to || from < 0 || to < 0 || to >= shown.length) return;
    shown.splice(to, 0, ...shown.splice(from, 1));
    // Back to page order to store it: the gallery reads newest first, the record
    // is kept page 1 first. Each pane filters by category, so only the order
    // within this one matters.
    const pageOrder = [...shown].reverse();
    enc.attachments = [...enc.attachments.filter((a) => a.category !== category), ...pageOrder];
    renderPane();
    saveOrder(category, pageOrder.map((a) => a.id));
  }

  /**
   * Puts an edited page back where it was. Rotating or cropping replaces the
   * bytes behind the same row, so nothing about its place in the chart changes.
   */
  function replaceShot(updated) {
    enc.attachments = enc.attachments.map((a) => (a.id === updated.id ? updated : a));
    renderPane();
  }

  async function saveOrder(category, ids) {
    try {
      const data = await api(`/api/encounters/${id}/attachments/order`, {
        method: 'POST',
        body: { category, ids },
      });
      enc.attachments = data.attachments;
    } catch (err) {
      toast(err.message, true);
      // The order on screen is now a claim the server never accepted. Pull the
      // record back rather than leave the two disagreeing.
      try {
        enc = await api(`/api/encounters/${id}`);
      } catch {
        /* offline — the next load will show what actually stuck */
      }
    }
    renderTabs();
    renderPane();
  }

  function shotCard(att, siblings, index) {
    const caption = el('input', {
      class: 'shot-cap',
      type: 'text',
      value: att.caption,
      placeholder: 'Add a note…',
      onchange: async (event) => {
        try {
          await api(`/api/attachments/${att.id}`, { method: 'PATCH', body: { caption: event.target.value } });
          att.caption = event.target.value;
        } catch (err) {
          toast(err.message, true);
        }
      },
    });

    const preview =
      att.mime === 'application/pdf'
        ? el(
            'button',
            {
              class: 'shot-pdf',
              type: 'button',
              onclick: () => openLightbox(siblings, index, (item) => openEditor(item, replaceShot)),
            },
            el('span', { style: 'font-size:22px', text: '📄' }),
            el('span', { text: 'PDF' })
          )
        : el('img', {
            // The thumbnail, not the page: a card is two hundred pixels wide and
            // the photograph behind it is two and a half thousand. The lightbox
            // still opens the full one, which is the only place it can be read.
            class: 'shot-img',
            src: att.thumbUrl || att.url,
            alt: att.caption || att.originalName,
            loading: 'lazy',
            decoding: 'async',
            onclick: () => openLightbox(siblings, index, (item) => openEditor(item, replaceShot)),
          });

    const card = el('div', { class: 'shot', dataset: { attId: String(att.id) } });

    const moveButton = (delta, glyph, hint) =>
      el(
        'button',
        {
          type: 'button',
          title: hint,
          'aria-label': hint,
          disabled: delta < 0 ? index === 0 : index === siblings.length - 1,
          onclick: () => moveShot(att.category, index, index + delta),
        },
        glyph
      );

    const grab = el('span', { class: 'shot-grab', title: 'Drag to reorder', 'aria-hidden': 'true' }, '⠿');

    // Pointer events, not HTML5 drag-and-drop: dragstart and drop are never fired
    // by a finger, so the handle did nothing at all on the phones this is used
    // from. One path now covers mouse, pen and touch.
    grab.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      let over = null;
      let edgeSpeed = 0;
      const clearOver = () => {
        if (over) over.classList.remove('drop-target');
        over = null;
      };

      // A phone shows two pages at a time, so without this you could only ever
      // drop onto something already on screen.
      const scroller = setInterval(() => {
        if (edgeSpeed) window.scrollBy(0, edgeSpeed);
      }, 16);

      const onMove = (moveEvent) => {
        const margin = 90;
        edgeSpeed =
          moveEvent.clientY < margin ? -11
          : moveEvent.clientY > window.innerHeight - margin ? 11
          : 0;

        const under = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
        const target = under && under.closest ? under.closest('.shot') : null;
        if (target === over) return;
        clearOver();
        if (target && target !== card && pane.contains(target)) {
          over = target;
          over.classList.add('drop-target');
        }
      };

      const end = (endEvent) => {
        clearInterval(scroller);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        card.classList.remove('dragging');
        const target = over;
        clearOver();
        if (!target || endEvent.type !== 'pointerup') return;
        const shown = displayShots(att.category);
        const from = shown.findIndex((a) => a.id === att.id);
        const to = shown.findIndex((a) => String(a.id) === target.dataset.attId);
        if (from >= 0 && to >= 0) moveShot(att.category, from, to);
      };

      card.classList.add('dragging');
      // Capture keeps the events coming if the finger leaves the handle, but the
      // listeners sit on the window so the drag still works where it is refused.
      try {
        grab.setPointerCapture(event.pointerId);
      } catch {
        /* no capture available — the window listeners below carry the drag */
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });

    const orderBar =
      siblings.length > 1
        ? el(
            'div',
            { class: 'shot-order' },
            moveButton(-1, '←', 'Move this page up the list'),
            moveButton(1, '→', 'Move this page down the list'),
            grab
          )
        : null;

    card.append(
      preview,
      // The number is the page number, counted from the first page of the chart.
      // The list runs newest first, so these count down.
      el('span', { class: 'shot-num', text: String(siblings.length - index) }),
      ...(orderBar ? [orderBar] : []),
      el(
        'div',
        { class: 'shot-foot' },
        caption,
        el(
          'div',
          { class: 'shot-sub' },
          el('span', { text: formatBytes(att.size) }),
          att.mime === 'application/pdf'
            ? null
            : el(
                'button',
                {
                  class: 'shot-edit',
                  type: 'button',
                  title: 'Rotate or crop this page',
                  onclick: () => openEditor(att, replaceShot),
                },
                'Edit'
              ),
          el(
            'button',
            {
              class: 'shot-del',
              type: 'button',
              onclick: async () => {
                if (!confirm('Delete this page? This cannot be undone.')) return;
                try {
                  await api(`/api/attachments/${att.id}`, { method: 'DELETE' });
                  enc.attachments = enc.attachments.filter((a) => a.id !== att.id);
                  renderTabs();
                  renderPane();
                  toast('Page deleted.');
                } catch (err) {
                  toast(err.message, true);
                }
              },
            },
            'Delete'
          )
        )
      )
    );

    return card;
  }

  const compressToggle = el('input', { type: 'checkbox', id: 'cmp', checked: state.compress });
  compressToggle.addEventListener('change', () => {
    state.compress = compressToggle.checked;
    localStorage.setItem('emr.compress', state.compress ? 'on' : 'off');
  });

  refreshHead();
  renderTabs();
  renderPane();

  container.replaceChildren(
    el(
      'div',
      { class: 'page-head' },
      el('div', {}, headTitle, headSub),
      el(
        'div',
        { class: 'row' },
        enc.type === 'inpatient' && !enc.dischargeDate ? roundButton(enc) : null,
        // Only worth offering once there is a second visit to gather: on a first
        // admission the whole chart is this screen, and the link would lead back
        // to what you are already looking at.
        (enc.patientTotals?.visits ?? 1) > 1
          ? el(
              'a',
              {
                class: 'btn',
                href: `#/p/${enc.patient.id}`,
                title: 'Every page this patient has, grouped by visit',
              },
              `All pages for this patient — ${enc.patientTotals.visits} visits · ${enc.patientTotals.pages} page${enc.patientTotals.pages === 1 ? '' : 's'}`
            )
          : null,
        el('a', { class: 'btn btn-ghost', href: `#/${enc.type}` }, '← Back to list')
      )
    ),
    deathNotice,
    el(
      'div',
      { class: 'detail' },
      identityCard,
      el(
        'div',
        {},
        el(
          'div',
          { class: 'row', style: 'margin-bottom:10px' },
          el('h2', { style: 'margin:0', text: 'Scanned pages' }),
          el('div', { class: 'spacer' }),
          el('div', { class: 'check' }, compressToggle, el('label', { for: 'cmp', text: 'Shrink photos before upload' }))
        ),
        tabs,
        pane
      )
    )
  );
}

// -------------------------------------------------------- whole-patient chart

/**
 * Every page this patient has, in one place, each one under the visit it was
 * taken on.
 *
 * The record screen answers "what is in this admission". A patient who keeps
 * coming back raises the other question — "what have we ever photographed for
 * this person" — and answering that from the record screen means opening every
 * visit in turn. Here the pages are all on one screen, and the visit heading
 * above each group is what says which is which: nothing is pooled into an
 * undated pile.
 */
async function patientView(patientId) {
  const container = el('div');
  shell(container);
  container.replaceChildren(el('div', { class: 'sub', text: 'Loading chart…' }));

  let chart;
  try {
    chart = await api(`/api/patients/${patientId}/chart`);
  } catch (err) {
    container.replaceChildren(el('div', { class: 'notice notice-error', text: err.message }));
    return;
  }

  let filter = 'all';
  const chips = el('div', { class: 'chips' });
  const body = el('div');

  // Rebuilt on every render: the pages currently on screen, in the order the
  // screen reads them. The lightbox walks this, so one run of swipes crosses the
  // whole chart — visit to visit — instead of stopping at the end of a section.
  let run = [];

  /** Puts an edited page back where it was, whichever visit it belongs to. */
  function replacePage(updated) {
    for (const visit of chart.visits) {
      visit.attachments = visit.attachments.map((a) => (a.id === updated.id ? updated : a));
    }
    render();
  }

  function openAt(index) {
    openLightbox(run, index, (item) => openEditor(item, replacePage));
  }

  function pageCard(att, index, pageNumber) {
    const preview =
      att.mime === 'application/pdf'
        ? el(
            'button',
            { class: 'shot-pdf', type: 'button', onclick: () => openAt(index) },
            el('span', { style: 'font-size:22px', text: '📄' }),
            el('span', { text: 'PDF' })
          )
        : el('img', {
            class: 'shot-img',
            src: att.thumbUrl || att.url,
            alt: att.caption || att.originalName,
            loading: 'lazy',
            decoding: 'async',
            onclick: () => openAt(index),
          });

    return el(
      'div',
      { class: 'shot' },
      preview,
      // Same number as on the record: the page number counted from the front of
      // that visit's section, so a page found here can be found there.
      el('span', { class: 'shot-num', text: String(pageNumber) }),
      el(
        'div',
        { class: 'shot-foot' },
        el('div', {
          class: 'shot-cap-static',
          text: att.caption || 'No note',
          style: att.caption ? '' : 'font-style:italic;color:var(--faint)',
          title: att.caption || '',
        }),
        el('div', { class: 'shot-sub' }, el('span', { text: formatBytes(att.size) }))
      )
    );
  }

  function visitHead(visit, pageCount) {
    const care = CARE_STATUS[visit.careRole];
    const when =
      visit.type === 'inpatient'
        ? `${prettyDate(visit.admissionDate)}${visit.dischargeDate ? ` → ${prettyDate(visit.dischargeDate)}` : ''}`
        : prettyDate(visit.admissionDate);

    const meta = [
      el('span', {
        class: `badge ${visit.type === 'inpatient' ? 'badge-in' : 'badge-out'}`,
        text: typeLabel(visit.type),
      }),
      visit.type === 'inpatient' && !visit.dischargeDate
        ? el('span', { class: 'badge badge-open', text: 'STILL ADMITTED' })
        : null,
      visit.ward ? el('span', { text: visit.ward }) : null,
      visit.age !== null ? el('span', { text: `${visit.age} y at this visit` }) : null,
      care
        ? el('span', {
            class: `badge ${care.cls}`,
            text: care.badge,
            title: care.partner && visit.careLeader ? care.long(visit.careLeader) : '',
          })
        : null,
      care && care.partner && visit.careLeader
        ? el('span', { text: `${care.partner} ${visit.careLeader}` })
        : null,
      visit.careRole === 'leader' && visit.consultedTo
        ? el('span', { class: 'consulted', text: `→ ${visit.consultedTo}` })
        : null,
    ].filter(Boolean);

    const dx = (visit.diagnosis || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    return el(
      'div',
      { class: 'visit-head' },
      el(
        'div',
        { class: 'visit-headings' },
        el('div', { class: 'visit-title', text: when }),
        el('div', { class: 'visit-meta' }, ...meta),
        dx.length ? el('div', { class: 'visit-dx', text: dx.join(' · '), title: visit.diagnosis }) : null
      ),
      el(
        'div',
        { class: 'visit-side' },
        // Under a section filter the count says what it is counting, rather than
        // appearing to claim a five-page admission only ever had one page.
        el('span', {
          class: 'sub',
          style: 'font-size:12.5px',
          text:
            pageCount === visit.attachments.length
              ? `${pageCount} page${pageCount === 1 ? '' : 's'}`
              : `${pageCount} of ${visit.attachments.length} pages`,
        }),
        el('a', { class: 'btn btn-sm btn-ghost', href: `#/e/${visit.id}` }, 'Open record →')
      )
    );
  }

  function renderChips() {
    const chip = (key, label, n) =>
      el(
        'button',
        {
          type: 'button',
          class: `chip${filter === key ? ' on' : ''}`,
          // A section this patient has nothing in would filter to an empty
          // screen, so it cannot be chosen — the count still says it is empty.
          disabled: key !== 'all' && n === 0,
          onclick: () => {
            filter = key;
            render();
          },
        },
        label,
        el('span', { class: 'count', text: String(n) })
      );

    chips.replaceChildren(
      chip('all', 'All pages', chart.total),
      ...CATEGORIES.map((cat) => chip(cat.key, cat.label, chart.counts[cat.key] || 0))
    );
  }

  function render() {
    renderChips();
    run = [];

    const wanted = CATEGORIES.filter((cat) => filter === 'all' || cat.key === filter);
    const blocks = [];

    for (const visit of chart.visits) {
      const sections = [];
      let shownHere = 0;

      for (const cat of wanted) {
        // Newest page first, exactly as the record screen shows it, so the two
        // screens never disagree about what the top of a section is.
        const pages = visit.attachments.filter((a) => a.category === cat.key).reverse();
        if (!pages.length) continue;
        shownHere += pages.length;

        const cards = pages.map((att, i) => {
          const pageNumber = pages.length - i;
          // The lightbox has only the caption to say where a page came from, and
          // "which visit was this" is the whole point of the screen — so the
          // visit and section are written into it, ahead of any note typed on
          // the page itself.
          const where = `${prettyDate(visit.admissionDate)} · ${cat.label} ${pageNumber}/${pages.length}`;
          run.push({ ...att, caption: att.caption ? `${where} — ${att.caption}` : where });
          return pageCard(att, run.length - 1, pageNumber);
        });

        sections.push(
          el(
            'div',
            { class: 'visit-cat' },
            el(
              'div',
              { class: 'visit-cat-head' },
              el('span', { text: cat.label }),
              el('span', { class: 'count', text: String(pages.length) })
            ),
            el('div', { class: 'gallery' }, ...cards)
          )
        );
      }

      // Under a section filter a visit holding nothing of that kind is not an
      // answer, so it drops out. With no filter it stays and says it is empty —
      // a visit with no pages photographed is itself worth seeing.
      if (!sections.length && filter !== 'all') continue;

      blocks.push(
        el(
          'div',
          { class: 'card visit' },
          visitHead(visit, shownHere),
          el(
            'div',
            { class: 'visit-body' },
            sections.length
              ? sections
              : el('p', {
                  class: 'sub',
                  style: 'margin:0;font-size:13px',
                  text: 'No pages photographed for this visit yet.',
                })
          )
        )
      );
    }

    body.replaceChildren(
      ...(blocks.length
        ? blocks
        : [
            el(
              'div',
              { class: 'empty' },
              el('p', { text: chart.visits.length ? 'No pages in this section yet.' : 'This patient has no records.' }),
              el('p', { style: 'font-size:13px', text: 'Open a record to photograph pages into it.' })
            ),
          ])
    );
  }

  const died = deathSummary(chart.patient);
  const visits = chart.visits.length;
  const newest = chart.visits[0];

  render();

  // Built as one list and filtered: replaceChildren takes a null literally and
  // writes the word into the page, where el() would have dropped it.
  const parts = [
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', { text: chart.patient.name }),
        el('p', {
          class: 'sub',
          text: [
            chart.patient.mrNumber,
            chart.patient.sex === 'M' ? 'Male' : 'Female',
            `${visits} visit${visits === 1 ? '' : 's'}`,
            `${chart.total} page${chart.total === 1 ? '' : 's'}`,
          ].join(' · '),
        })
      ),
      el(
        'a',
        { class: 'btn btn-ghost', href: `#/${newest ? newest.type : 'inpatient'}` },
        '← Back to list'
      )
    ),
    died ? el('div', { class: 'notice notice-death', text: died }) : null,
    chips,
    body,
  ];

  container.replaceChildren(...parts.filter(Boolean));
}

// ---------------------------------------------------------- image shrinking

/** The long edge a stored page is kept at — enough to read handwriting from. */
const MAX_DIM = 2600;

/**
 * Quality per codec, and deliberately not one number for both.
 *
 * A quality figure means different things to different encoders, so the same
 * 0.82 that is generous for WebP is visibly worse than what this app used to
 * store as JPEG. Measured on a photographed observation chart, WebP at 0.86
 * comes out slightly *better* than the old JPEG 0.90 — 38.5 dB against 38.0,
 * and 38.3 against 38.0 across the numbers themselves — while still landing
 * about a third smaller.
 *
 * The JPEG figure is the one this app has always stored at. A browser that
 * cannot write WebP is usually an older phone, and the page it keeps of a chart
 * should not be the worse one for that.
 */
const PAGE_QUALITY = { 'image/webp': 0.86, 'image/jpeg': 0.9 };

/** What a gallery card actually needs, at twice the pixels for a sharp screen. */
const THUMB_DIM = 480;
const THUMB_QUALITY = { 'image/webp': 0.72, 'image/jpeg': 0.75 };

let webpWriter = null;

/**
 * Whether this browser can *write* WebP. Reading it is near-universal; writing
 * it is what matters here, and toBlob quietly hands back a PNG where it cannot,
 * which would make pages larger rather than smaller. The probe is the only way
 * to tell, so it is done once and remembered.
 */
function canWriteWebp() {
  if (webpWriter === null) {
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    webpWriter = probe.toDataURL('image/webp').startsWith('data:image/webp');
  }
  return webpWriter;
}

/**
 * WebP where it can be written, JPEG everywhere else, each at its own quality.
 * At matched fidelity WebP lands about a third smaller, which on a ward phone
 * pushing a twenty-page chart over hospital wifi is a third of the wait.
 */
function encodeCanvas(canvas, quality) {
  const type = canWriteWebp() ? 'image/webp' : 'image/jpeg';
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality[type]));
}

/**
 * Draws a bitmap or canvas down to fit maxDim and encodes the result. `quality`
 * is a per-codec map, because the encoder is chosen in here rather than by the
 * caller.
 */
function scaleTo(source, maxDim, quality) {
  const scale = Math.min(1, maxDim / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return encodeCanvas(canvas, quality);
}

/**
 * The page to store and the small copy a gallery should draw, from one decode.
 *
 * Phone photos are 4–12 MB each and a chart is many pages. Keeping the long edge
 * at 2600 px keeps handwriting legible while cutting storage roughly tenfold;
 * the thumbnail exists because a record screen draws twenty cards at a couple of
 * hundred pixels and was fetching twenty full photographs to do it.
 *
 * Decoding a 12-megapixel photograph is the expensive part on a phone, so it
 * happens once and both outputs come off the same bitmap. Anything the browser
 * cannot decode — HEIC, PDF — passes straight through untouched, and the gallery
 * falls back to the page itself: nothing is ever lost to make it faster.
 */
async function prepareImage(file) {
  const asIs = { full: file, thumb: null };
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return asIs;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return asIs;
  }

  try {
    // Made whether or not shrinking is switched on: the toggle is about what
    // gets stored, and the thumbnail is about what gets drawn.
    const thumb = await scaleTo(bitmap, THUMB_DIM, THUMB_QUALITY);

    let full = file;
    if (state.compress) {
      const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
      // Re-encoding a picture that is already small buys nothing and can cost.
      const worthIt = file.size >= 900 * 1024 && (scale < 1 || file.size >= 2.5 * 1024 * 1024);
      if (worthIt) {
        const shrunk = await scaleTo(bitmap, MAX_DIM, PAGE_QUALITY);
        if (shrunk && shrunk.size < file.size) full = shrunk;
      }
    }
    return { full, thumb };
  } finally {
    bitmap.close();
  }
}

/**
 * Sends the small copy up after the page it belongs to. Deliberately not awaited
 * by the upload and deliberately silent when it fails: a chart that is on the
 * server is the thing that mattered, and a page without a thumbnail is merely
 * slower to draw.
 */
async function sendThumb(attachmentId, thumb) {
  const res = await fetch(`/api/attachments/${attachmentId}/thumb`, {
    method: 'POST',
    headers: { 'Content-Type': thumb.type },
    body: thumb,
  });
  if (!res.ok) throw new Error(`Thumbnail rejected (${res.status})`);
  return res.json();
}

// -------------------------------------------------------------- photo editor

/**
 * Rotate and crop a page that is already stored. Uploading comes first and is
 * never blocked by editing — get the chart photographed, straighten it later.
 *
 * All the work happens in the browser: the server has no image library and this
 * app has no dependencies to add one. The edited page is sent back over the same
 * attachment, so its caption, its place in the order and its id all survive.
 */
async function openEditor(att, onSaved) {
  if (att.mime === 'application/pdf') {
    toast('PDF pages cannot be rotated here.', true);
    return;
  }

  const stage = el('div', { class: 'editor-stage' });
  const status = el('span', { class: 'editor-status', text: 'Loading…' });
  const save = el('button', { class: 'btn btn-sm btn-primary', disabled: true }, 'Save');

  const box = el('div', { class: 'editor' });
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    box.remove();
  }
  function onKey(event) {
    if (event.key === 'Escape') close();
  }

  let rotation = 0;
  // Kept as fractions of the rotated image, so it survives the stage being
  // resized and maps onto the source with one multiply.
  let crop = { x: 0, y: 0, w: 1, h: 1 };
  let bitmap = null;
  const work = document.createElement('canvas');

  const rotateButton = (delta, label) =>
    el(
      'button',
      {
        class: 'btn btn-sm',
        type: 'button',
        onclick: () => {
          rotation = (rotation + delta + 360) % 360;
          // A crop chosen in the old orientation means nothing in the new one.
          crop = { x: 0, y: 0, w: 1, h: 1 };
          paint();
          markDirty();
        },
      },
      label
    );

  const reset = el(
    'button',
    {
      class: 'btn btn-sm btn-ghost',
      type: 'button',
      onclick: () => {
        rotation = 0;
        crop = { x: 0, y: 0, w: 1, h: 1 };
        paint();
        markDirty();
      },
    },
    'Reset'
  );

  const markDirty = () => {
    const changed = rotation !== 0 || crop.x > 0 || crop.y > 0 || crop.w < 1 || crop.h < 1;
    save.disabled = !changed;
    status.textContent = changed
      ? `${rotation ? `Rotated ${rotation}°` : 'Not rotated'}${crop.w < 1 || crop.h < 1 ? ' · cropped' : ''}`
      : 'No changes yet';
  };

  /** Draws the source at the current rotation; crop is an overlay, not a redraw. */
  function paint() {
    if (!bitmap) return;
    const turned = rotation === 90 || rotation === 270;
    work.width = turned ? bitmap.height : bitmap.width;
    work.height = turned ? bitmap.width : bitmap.height;
    const ctx = work.getContext('2d');
    ctx.save();
    ctx.translate(work.width / 2, work.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    ctx.restore();
    placeCrop();
  }

  const cropBox = el('div', { class: 'crop-box' });
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    cropBox.append(el('span', { class: `crop-handle crop-${corner}`, dataset: { corner } }));
  }

  /** Puts the crop rectangle over the canvas as it is actually being displayed. */
  function placeCrop() {
    const rect = work.getBoundingClientRect();
    const host = stage.getBoundingClientRect();
    cropBox.style.left = `${rect.left - host.left + crop.x * rect.width}px`;
    cropBox.style.top = `${rect.top - host.top + crop.y * rect.height}px`;
    cropBox.style.width = `${crop.w * rect.width}px`;
    cropBox.style.height = `${crop.h * rect.height}px`;
  }

  // Dragging a corner resizes, dragging the middle moves. Pointer events so a
  // finger works the same as a mouse.
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const MIN_CROP = 0.05;

  cropBox.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const corner = event.target.dataset ? event.target.dataset.corner : null;
    const rect = work.getBoundingClientRect();
    const originX = event.clientX;
    const originY = event.clientY;
    const from = { ...crop };

    const onMove = (moveEvent) => {
      const dx = (moveEvent.clientX - originX) / rect.width;
      const dy = (moveEvent.clientY - originY) / rect.height;

      if (!corner) {
        // Moving: the frame keeps its size and stays inside the image.
        crop = {
          ...from,
          x: clamp(from.x + dx, 0, 1 - from.w),
          y: clamp(from.y + dy, 0, 1 - from.h),
        };
      } else {
        // Resizing: the dragged corner moves, the opposite one stays put.
        let { x, y, w, h } = from;
        if (corner.includes('w')) {
          const nx = clamp(from.x + dx, 0, from.x + from.w - MIN_CROP);
          w = from.w + (from.x - nx);
          x = nx;
        }
        if (corner.includes('n')) {
          const ny = clamp(from.y + dy, 0, from.y + from.h - MIN_CROP);
          h = from.h + (from.y - ny);
          y = ny;
        }
        if (corner.includes('e')) w = clamp(from.w + dx, MIN_CROP, 1 - from.x);
        if (corner.includes('s')) h = clamp(from.h + dy, MIN_CROP, 1 - from.y);
        crop = { x, y, w, h };
      }
      placeCrop();
    };

    const end = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      markDirty();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  });

  box.append(
    el(
      'div',
      { class: 'editor-bar' },
      rotateButton(-90, '⟲ Rotate left'),
      rotateButton(90, '⟳ Rotate right'),
      reset,
      status,
      el('div', { class: 'spacer', style: 'flex:1' }),
      save,
      el('button', { class: 'btn btn-sm', type: 'button', onclick: close }, 'Cancel')
    ),
    stage,
    el('div', {
      class: 'editor-hint',
      text: 'Drag inside the frame to move it, drag a corner to crop. Rotating clears the crop.',
    })
  );
  stage.append(work, cropBox);
  document.addEventListener('keydown', onKey);
  document.body.append(box);

  try {
    const blob = await (await fetch(att.url)).blob();
    bitmap = await createImageBitmap(blob);
  } catch {
    status.textContent = 'This browser cannot open this image for editing.';
    return;
  }
  paint();
  markDirty();
  window.addEventListener('resize', placeCrop);

  save.addEventListener('click', async () => {
    save.disabled = true;
    status.textContent = 'Saving…';
    try {
      const sx = Math.round(crop.x * work.width);
      const sy = Math.round(crop.y * work.height);
      const sw = Math.max(1, Math.round(crop.w * work.width));
      const sh = Math.max(1, Math.round(crop.h * work.height));
      const out = document.createElement('canvas');
      out.width = sw;
      out.height = sh;
      const ctx = out.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(work, sx, sy, sw, sh, 0, 0, sw, sh);

      const edited = await new Promise((resolve) => out.toBlob(resolve, 'image/jpeg', 0.92));
      if (!edited) throw new Error('The browser could not produce the edited image.');

      const res = await fetch(`/api/attachments/${att.id}/file`, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: edited,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`);

      // Saving retired the old thumbnail with the old bytes, so send one of the
      // page as it now is — off the same canvas, which is already the right
      // picture. If it does not make it, the gallery loads the full page.
      let saved = data;
      const thumb = await scaleTo(out, THUMB_DIM, THUMB_QUALITY);
      if (thumb) {
        try {
          saved = await sendThumb(att.id, thumb);
        } catch {
          /* the gallery falls back to the full page */
        }
      }

      window.removeEventListener('resize', placeCrop);
      close();
      toast('Page updated.');
      onSaved(saved);
    } catch (err) {
      status.textContent = err.message;
      save.disabled = false;
    }
  });
}

// ------------------------------------------------------------------ lightbox

function openLightbox(items, startIndex, onEdit) {
  let index = startIndex;

  const stage = el('div', { class: 'lightbox-stage' });
  const label = el('span', { class: 'lb-label' });
  const hint = el('div', {
    class: 'lightbox-hint',
    text: 'Pinch or double-tap to zoom · swipe to change page · swipe down to close',
  });

  // The words drop out on a narrow screen, leaving the symbols. Six full labels
  // do not fit across a phone: they squeeze until each one wraps onto two lines
  // and the last button falls off the edge.
  const word = (text) => el('span', { class: 'lb-word', text });

  const editButton = onEdit
    ? el(
        'button',
        {
          type: 'button',
          title: 'Rotate or crop this page',
          onclick: () => {
            const item = items[index];
            close();
            onEdit(item);
          },
        },
        'Rotate',
        word(' / crop')
      )
    : null;

  const box = el(
    'div',
    { class: 'lightbox' },
    el(
      'div',
      { class: 'lightbox-bar' },
      el('button', { type: 'button', title: 'Previous page', onclick: () => step(-1) }, '‹', word(' Prev')),
      el('button', { type: 'button', title: 'Next page', onclick: () => step(1) }, word('Next '), '›'),
      // The label doubles as the spacer: it grows into whatever is left over.
      label,
      editButton,
      el(
        'a',
        { class: 'btn btn-sm', id: 'lb-open', target: '_blank', rel: 'noopener', title: 'Open full size' },
        word('Open '),
        'full size'
      ),
      el('button', { type: 'button', title: 'Close', onclick: close }, word('Close '), '✕')
    ),
    stage,
    hint
  );

  function draw() {
    const item = items[index];
    label.textContent = `${index + 1} / ${items.length}${item.caption ? ` — ${item.caption}` : ''}`;
    box.querySelector('#lb-open').href = item.url;
    // Rotating a PDF is not something a canvas can do, so the shortcut only
    // shows on the pages it can actually act on.
    if (editButton) editButton.style.display = item.mime === 'application/pdf' ? 'none' : '';
    if (item.mime === 'application/pdf') {
      // A PDF gets its own scrolling viewer; taking its gestures away would make
      // it unreadable. Prev/Next still move off the page — and the hint goes,
      // rather than promising a swipe that this one page will not answer.
      stage.classList.remove('gestures');
      hint.style.display = 'none';
      stage.replaceChildren(el('iframe', { src: item.url, title: item.originalName }));
    } else {
      stage.classList.add('gestures');
      hint.style.display = '';
      stage.replaceChildren(
        el('img', {
          src: item.url,
          alt: item.caption || item.originalName,
          // Otherwise a slow drag on the desktop starts a native image drag
          // halfway through the pan.
          draggable: 'false',
        })
      );
    }
    // Every page starts fitted, and no half-finished gesture carries over.
    pointers.clear();
    mode = null;
    resetView();
  }

  function step(delta) {
    index = (index + delta + items.length) % items.length;
    draw();
  }

  // --- zoom and pan --------------------------------------------------------
  // A ward photo is only half useful fitted to the screen: the point is usually
  // a number on a monitor readout or a dose written into a margin. Pinch, wheel
  // and double-tap all drive the same three figures below, and the picture is
  // moved with a transform rather than by scrolling the stage, so it can follow
  // the fingers exactly instead of lagging a scroll behind them.
  const MAX_SCALE = 6;
  let scale = 1;
  let tx = 0;
  let ty = 0;

  const currentImage = () => stage.querySelector('img');
  const clampScale = (value) => Math.min(MAX_SCALE, Math.max(1, value));

  // Panning stops where the picture does — there is nothing to read in the
  // empty space past its edges, and letting it drift off is how a photo gets
  // lost and has to be reopened.
  function clampPan() {
    const img = currentImage();
    if (!img) return;
    const maxX = Math.max(0, (img.offsetWidth * scale - stage.clientWidth) / 2);
    const maxY = Math.max(0, (img.offsetHeight * scale - stage.clientHeight) / 2);
    tx = Math.min(maxX, Math.max(-maxX, tx));
    ty = Math.min(maxY, Math.max(-maxY, ty));
  }

  function apply(animate = false) {
    const img = currentImage();
    if (!img) return;
    img.style.transition = animate ? 'transform .2s, opacity .2s' : 'none';
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    img.style.opacity = '';
    stage.classList.toggle('zoomed', scale > 1);
  }

  function resetView(animate = false) {
    scale = 1;
    tx = 0;
    ty = 0;
    apply(animate);
  }

  // Where the image sits with no transform on it. Read back from the live
  // rectangle rather than measured once, so a rotated phone or a toolbar that
  // has wrapped onto a second row never leaves a stale centre behind.
  function layoutCentre() {
    const rect = currentImage().getBoundingClientRect();
    return { x: rect.left + rect.width / 2 - tx, y: rect.top + rect.height / 2 - ty };
  }

  // Zoom about a point on the screen: whatever was under the fingers, or under
  // the cursor, stays under them.
  function zoomTo(next, px, py) {
    if (!currentImage()) return;
    const target = clampScale(next);
    const centre = layoutCentre();
    const k = target / scale;
    tx = px - centre.x - k * (px - centre.x - tx);
    ty = py - centre.y - k * (py - centre.y - ty);
    scale = target;
    clampPan();
  }

  stage.addEventListener(
    'wheel',
    (event) => {
      if (!stage.classList.contains('gestures')) return;
      // A trackpad pinch arrives here as ctrl+wheel; a plain wheel is treated
      // the same, because on a photo there is nothing else for it to do.
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
      zoomTo(scale * Math.exp(-delta * 0.0018), event.clientX, event.clientY);
      apply();
    },
    { passive: false }
  );

  // --- gestures ------------------------------------------------------------
  // Prev/Next buttons are a reach on a phone held one-handed over a bed. Fitted
  // to the screen, a horizontal drag changes page and a downward one closes.
  // Zoomed in, that same drag pans instead — the buttons are still there for
  // changing page, and a swipe would otherwise fight the thing being read.
  const SWIPE = 55;
  const pointers = new Map();
  let mode = null;
  let swiped = false;
  let startX = 0;
  let startY = 0;
  let startTx = 0;
  let startTy = 0;
  let pinch = null;
  let lastTap = 0;
  let lastTapX = 0;
  let lastTapY = 0;

  const points = () => [...pointers.values()];

  function beginDrag(point) {
    mode = scale > 1 ? 'pan' : 'swipe';
    swiped = false;
    startX = point.x;
    startY = point.y;
    startTx = tx;
    startTy = ty;
  }

  function beginPinch() {
    // A swipe caught mid-drag hands its offset back first, so the zoom does not
    // begin with the picture already halfway off the screen.
    if (mode === 'swipe') {
      tx = startTx;
      ty = startTy;
      apply();
    }
    const [a, b] = points();
    mode = 'pinch';
    swiped = true;
    pinch = {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      scale,
      tx,
      ty,
      centre: layoutCentre(),
    };
  }

  // Double-tap, not single: a single tap cannot be told apart from the tap that
  // ends a swipe or lands after a pinch, and toggling zoom on those was the
  // old viewer's habit of jumping when it was meant to sit still.
  function tap(event) {
    const now = Date.now();
    const quick =
      now - lastTap < 300 && Math.hypot(event.clientX - lastTapX, event.clientY - lastTapY) < 40;
    lastTap = quick ? 0 : now;
    lastTapX = event.clientX;
    lastTapY = event.clientY;
    if (!quick) return;
    if (scale > 1) {
      resetView(true);
    } else {
      zoomTo(2.5, event.clientX, event.clientY);
      apply(true);
    }
  }

  stage.addEventListener('pointerdown', (event) => {
    if (!stage.classList.contains('gestures')) return;
    // Two fingers are all a pinch needs; a third resting on the glass is noise.
    if (pointers.size >= 2) return;
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) beginDrag({ x: event.clientX, y: event.clientY });
    else beginPinch();
  });

  stage.addEventListener('pointermove', (event) => {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    point.x = event.clientX;
    point.y = event.clientY;

    if (mode === 'pinch') {
      const [a, b] = points();
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const target = clampScale((pinch.scale * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.dist);
      const k = target / pinch.scale;
      // Two fingers zoom and carry at once: the spot that was between them when
      // the pinch started stays between them wherever they move it to.
      tx = midX - pinch.centre.x - k * (pinch.midX - pinch.centre.x - pinch.tx);
      ty = midY - pinch.centre.y - k * (pinch.midY - pinch.centre.y - pinch.ty);
      scale = target;
      clampPan();
      apply();
      return;
    }

    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) swiped = true;

    if (mode === 'pan') {
      tx = startTx + dx;
      ty = startTy + dy;
      clampPan();
      apply();
      return;
    }

    const img = currentImage();
    if (!img) return;
    img.style.transition = 'none';
    img.style.transform =
      Math.abs(dx) >= Math.abs(dy)
        ? `translateX(${dx}px)`
        : `translateY(${Math.max(0, dy)}px)`;
    img.style.opacity = String(Math.max(0.35, 1 - Math.abs(dy) / 400));
  });

  const endGesture = (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);

    if (pointers.size === 1) {
      // One finger lifted out of a pinch: carry on panning from wherever the
      // other one still is, rather than snapping away from under it.
      beginDrag(points()[0]);
      swiped = true;
      return;
    }
    if (pointers.size > 0) return;

    const lifted = event.type === 'pointerup';
    if (mode === 'swipe') {
      const dx = lifted ? event.clientX - startX : 0;
      const dy = lifted ? event.clientY - startY : 0;
      mode = null;
      resetView(true);
      if (Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) > SWIPE) {
        // Swiping left pulls the next page in from the right, as everywhere else.
        step(dx < 0 ? 1 : -1);
      } else if (dy > SWIPE * 1.6) {
        close();
      } else if (!swiped && lifted) {
        tap(event);
      }
      return;
    }

    const wasTap = mode === 'pan' && !swiped && lifted;
    mode = null;
    // Pinching back below the fitted size springs to the fit rather than
    // leaving the picture stranded small.
    if (scale <= 1) resetView(true);
    else {
      clampPan();
      apply(true);
    }
    if (wasTap) tap(event);
  };

  stage.addEventListener('pointerup', endGesture);
  stage.addEventListener('pointercancel', endGesture);

  function onKey(event) {
    if (event.key === 'Escape') close();
    else if (event.key === 'ArrowRight') step(1);
    else if (event.key === 'ArrowLeft') step(-1);
  }

  // A zoomed picture that stays put while the screen turns ends up off the
  // edge of it.
  const onResize = () => {
    clampPan();
    apply();
  };

  function close() {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    box.remove();
  }

  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  document.body.append(box);
  draw();
}

// ------------------------------------------------------------- report view

function reportView() {
  const container = el('div');
  shell(container);

  let type = 'inpatient';
  const from = el('input', { type: 'date', value: state.defaultRange.from });
  const to = el('input', { type: 'date', value: state.defaultRange.to });
  const dateFormat = el(
    'select',
    {},
    el('option', { value: 'iso' }, 'YYYY-MM-DD'),
    el('option', { value: 'dmy' }, 'DD/MM/YYYY')
  );
  const flatten = el('input', { type: 'checkbox', id: 'flat' });
  const includeMr = el('input', { type: 'checkbox', id: 'mr' });
  const includeConsults = el('input', { type: 'checkbox', id: 'cons' });

  const preview = el('div');
  const count = el('div', { class: 'sub' });

  const typeToggle = el(
    'div',
    { class: 'seg' },
    ...['inpatient', 'outpatient'].map((value) =>
      el(
        'button',
        {
          type: 'button',
          class: type === value ? 'on' : '',
          onclick: (event) => {
            type = value;
            [...typeToggle.children].forEach((b) => b.classList.remove('on'));
            event.currentTarget.classList.add('on');
            load();
          },
        },
        typeLabel(value, true)
      )
    )
  );

  function shiftMonth(delta) {
    const base = new Date(`${from.value || state.defaultRange.from}T00:00:00`);
    const target = new Date(base.getFullYear(), base.getMonth() + delta, 1);
    const last = new Date(target.getFullYear(), target.getMonth() + 1, 0);
    const iso = (d) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    from.value = iso(target);
    to.value = iso(last);
    load();
  }

  function params() {
    const p = new URLSearchParams({ type, from: from.value, to: to.value, dateFormat: dateFormat.value });
    if (flatten.checked) p.set('flatten', '1');
    if (includeMr.checked) p.set('includeMr', '1');
    if (includeConsults.checked) p.set('includeConsults', '1');
    return p;
  }

  async function load() {
    preview.replaceChildren(el('div', { class: 'sub', text: 'Building preview…' }));
    try {
      const report = await api(`/api/report?${params()}`);
      count.textContent = `${report.rows.length} ${typeLabel(type, report.rows.length !== 1).toLowerCase()} between ${prettyDate(report.from)} and ${prettyDate(report.to)}`;
      if (!report.rows.length) {
        preview.replaceChildren(
          el('div', { class: 'empty' }, el('p', { text: 'No records in this period.' }), el('p', { style: 'font-size:13px', text: 'Try a wider date range or the other patient type.' }))
        );
        return;
      }
      const table = el(
        'table',
        {},
        el('thead', {}, el('tr', {}, ...report.header.map((h) => el('th', { text: h })))),
        el(
          'tbody',
          {},
          ...report.rows.slice(0, 300).map((row) =>
            el(
              'tr',
              {},
              ...row.map((cell, i) => {
                const name = report.header[i];
                const cls = name === 'Dx' ? 'dx' : name === 'No' ? 'num' : name === 'Admission Date' ? 'nowrap' : '';
                return el('td', { class: cls, text: cell });
              })
            )
          )
        )
      );
      const parts = [el('div', { class: 'report-table-wrap' }, table)];
      if (report.rows.length > 300) {
        parts.push(
          el('p', {
            class: 'sub',
            style: 'margin-top:8px',
            text: `Preview shows the first 300 rows — the CSV contains all ${report.rows.length}.`,
          })
        );
      }
      preview.replaceChildren(...parts);
    } catch (err) {
      preview.replaceChildren(el('div', { class: 'notice notice-error', text: err.message }));
    }
  }

  [from, to, dateFormat].forEach((input) => input.addEventListener('change', load));
  [flatten, includeMr, includeConsults].forEach((input) => input.addEventListener('change', load));

  container.replaceChildren(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', { text: 'Create a report' }),
        el('p', { class: 'sub', text: 'Export a patient register to CSV. Defaults to the current month.' })
      ),
      typeToggle
    ),
    el(
      'div',
      { class: 'card', style: 'margin-bottom:18px' },
      el(
        'div',
        { class: 'grid-3' },
        el('div', { class: 'field' }, el('label', { text: 'From' }), from),
        el('div', { class: 'field' }, el('label', { text: 'To' }), to),
        el('div', { class: 'field' }, el('label', { text: 'Date format in CSV' }), dateFormat)
      ),
      el(
        'div',
        { class: 'row', style: 'margin-bottom:14px' },
        el('button', { type: 'button', class: 'btn btn-sm', onclick: () => shiftMonth(-1) }, '← Previous month'),
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm',
            onclick: () => {
              from.value = state.defaultRange.from;
              to.value = state.defaultRange.to;
              load();
            },
          },
          'This month'
        ),
        el('button', { type: 'button', class: 'btn btn-sm', onclick: () => shiftMonth(1) }, 'Next month →')
      ),
      el(
        'div',
        { class: 'row', style: 'gap:20px;margin-bottom:16px' },
        el('div', { class: 'check' }, flatten, el('label', { for: 'flat', text: 'Put each diagnosis on one line (separated by ;)' })),
        el('div', { class: 'check' }, includeMr, el('label', { for: 'mr', text: 'Include MR number column' })),
        el(
          'div',
          { class: 'check' },
          includeConsults,
          el('label', { for: 'cons', text: 'Include consulted-to column' })
        )
      ),
      el(
        'div',
        { class: 'row' },
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary',
            onclick: () => {
              window.location.href = `/api/report.csv?${params()}`;
              toast('CSV download started.');
            },
          },
          '⬇ Download CSV'
        ),
        el('button', { type: 'button', class: 'btn', onclick: () => window.print() }, 'Print preview'),
        count
      )
    ),
    preview
  );

  load();
}

// ------------------------------------------------------------ account view

async function accountView() {
  const container = el('div');
  shell(container);
  container.replaceChildren(el('div', { class: 'sub', text: 'Loading account…' }));

  let me;
  try {
    me = await api('/api/account');
  } catch (err) {
    container.replaceChildren(el('div', { class: 'notice notice-error', text: err.message }));
    return;
  }

  const blocks = [
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', { text: 'Your account' }),
        el('p', {
          class: 'sub',
          text: `Signed in as ${me.username}${me.role === 'admin' ? ' — administrator' : ''}.`,
        })
      )
    ),
    profileCard(me),
    passwordCard(),
  ];

  if (me.role === 'admin') blocks.push(await peopleCard(me));

  container.replaceChildren(...blocks);
}

function profileCard(me) {
  const fullName = el('input', { type: 'text', value: me.fullName, placeholder: 'Your name' });
  const note = el('span', { class: 'sub', style: 'font-size:12.5px' });

  return el(
    'form',
    {
      class: 'card',
      style: 'max-width:620px;margin-bottom:18px',
      onsubmit: async (event) => {
        event.preventDefault();
        try {
          const updated = await api('/api/account', {
            method: 'PATCH',
            body: { fullName: fullName.value },
          });
          state.user = { ...state.user, fullName: updated.fullName };
          note.textContent = 'Saved.';
          toast('Name updated.');
        } catch (err) {
          toast(err.message, true);
        }
      },
    },
    el('h2', { text: 'Profile' }),
    el(
      'div',
      { class: 'grid-2' },
      el('div', { class: 'field' }, el('label', { text: 'Display name' }), fullName),
      el(
        'div',
        { class: 'field' },
        el('label', { text: 'Username' }),
        el('input', { type: 'text', value: me.username, disabled: true }),
        el('div', { class: 'field-hint', text: 'Usernames cannot be changed.' })
      )
    ),
    el(
      'p',
      { class: 'sub', style: 'font-size:12.5px;margin:0 0 12px' },
      me.passwordChangedAt
        ? `Password last changed ${prettyDate(me.passwordChangedAt.slice(0, 10))}.`
        : 'Password has not been changed since the account was created.'
    ),
    el('div', { class: 'row' }, el('button', { class: 'btn', type: 'submit' }, 'Save name'), note)
  );
}

function passwordCard() {
  const error = el('div', { class: 'notice notice-error', style: 'display:none' });
  const current = el('input', { type: 'password', autocomplete: 'current-password' });
  const next = el('input', { type: 'password', autocomplete: 'new-password' });
  const confirm = el('input', { type: 'password', autocomplete: 'new-password' });
  const button = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Change password');

  const fail = (message) => {
    error.textContent = message;
    error.style.display = '';
  };

  return el(
    'form',
    {
      class: 'card',
      style: 'max-width:620px;margin-bottom:18px',
      onsubmit: async (event) => {
        event.preventDefault();
        error.style.display = 'none';
        if (next.value !== confirm.value) return fail('The two new passwords do not match.');
        if (next.value.length < 10) return fail('The new password must be at least 10 characters.');

        button.disabled = true;
        button.textContent = 'Changing…';
        try {
          await api('/api/account/password', {
            method: 'POST',
            body: { currentPassword: current.value, newPassword: next.value },
          });
          current.value = next.value = confirm.value = '';
          toast('Password changed. Other devices have been signed out.');
        } catch (err) {
          fail(err.message);
        } finally {
          button.disabled = false;
          button.textContent = 'Change password';
        }
      },
    },
    el('h2', { text: 'Change password' }),
    error,
    el('div', { class: 'field' }, el('label', { text: 'Current password' }), current),
    el(
      'div',
      { class: 'grid-2' },
      el('div', { class: 'field' }, el('label', { text: 'New password' }), next),
      el('div', { class: 'field' }, el('label', { text: 'Confirm new password' }), confirm)
    ),
    el('div', {
      class: 'notice notice-info',
      text:
        'Changing your password signs you out on every other phone, tablet and computer. ' +
        'This browser stays signed in.',
    }),
    button
  );
}

async function peopleCard(me) {
  const card = el('div', { class: 'card', style: 'max-width:820px' });

  async function render() {
    let users = [];
    try {
      users = (await api('/api/users')).users;
    } catch (err) {
      card.replaceChildren(el('div', { class: 'notice notice-error', text: err.message }));
      return;
    }

    const rows = users.map((u) =>
      el(
        'tr',
        {},
        el(
          'td',
          {},
          el('div', { style: 'font-weight:600', text: u.fullName || u.username }),
          el('div', { class: 'mr', text: u.username })
        ),
        el(
          'td',
          { class: 'nowrap' },
          el(
            'select',
            {
              disabled: u.id === me.id,
              title: u.id === me.id ? 'You cannot change your own role.' : '',
              onchange: async (event) => {
                try {
                  await api(`/api/users/${u.id}`, { method: 'PATCH', body: { role: event.target.value } });
                  toast(`${u.username} is now ${event.target.value === 'admin' ? 'an administrator' : 'a standard user'}.`);
                  render();
                } catch (err) {
                  toast(err.message, true);
                  render();
                }
              },
            },
            el('option', { value: 'user', selected: u.role === 'user' }, 'Standard'),
            el('option', { value: 'admin', selected: u.role === 'admin' }, 'Administrator')
          )
        ),
        el('td', { class: 'nowrap sub', style: 'font-size:12.5px' },
          u.passwordChangedAt ? prettyDate(u.passwordChangedAt.slice(0, 10)) : '—'),
        el(
          'td',
          { class: 'nowrap' },
          el(
            'button',
            {
              class: 'btn btn-sm',
              type: 'button',
              onclick: () => promptSetPassword(u, render),
            },
            'Set password'
          ),
          ' ',
          u.id === me.id
            ? el('span', { class: 'sub', style: 'font-size:12px', text: 'you' })
            : el(
                'button',
                {
                  class: 'btn btn-sm btn-danger',
                  type: 'button',
                  onclick: async () => {
                    if (!confirm(`Remove ${u.username}'s access?\n\nPatient records they created are not affected.`)) return;
                    try {
                      await api(`/api/users/${u.id}`, { method: 'DELETE' });
                      toast(`${u.username} removed.`);
                      render();
                    } catch (err) {
                      toast(err.message, true);
                    }
                  },
                },
                'Remove'
              )
        )
      )
    );

    card.replaceChildren(
      el('h2', { text: 'People with access' }),
      el('p', {
        class: 'sub',
        style: 'margin:-8px 0 14px',
        text: 'Everyone here can see and edit every patient record. Administrators can also manage this list.',
      }),
      el(
        'div',
        { class: 'report-table-wrap', style: 'margin-bottom:18px' },
        el(
          'table',
          {},
          el('thead', {}, el('tr', {},
            el('th', { text: 'Person' }),
            el('th', { text: 'Role' }),
            el('th', { text: 'Password set' }),
            el('th', { text: '' })
          )),
          el('tbody', {}, ...rows)
        )
      ),
      addPersonForm(render)
    );
  }

  await render();
  return card;
}

function addPersonForm(onDone) {
  const error = el('div', { class: 'notice notice-error', style: 'display:none' });
  const fullName = el('input', { type: 'text', placeholder: 'Dr Siti' });
  const username = el('input', { type: 'text', placeholder: 'drsiti' });
  const password = el('input', { type: 'password', autocomplete: 'new-password' });
  const role = el(
    'select',
    {},
    el('option', { value: 'user' }, 'Standard'),
    el('option', { value: 'admin' }, 'Administrator')
  );
  const button = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Add person');

  return el(
    'form',
    {
      style: 'border-top:1px solid var(--border);padding-top:16px',
      onsubmit: async (event) => {
        event.preventDefault();
        error.style.display = 'none';
        button.disabled = true;
        try {
          await api('/api/users', {
            method: 'POST',
            body: {
              username: username.value.trim().toLowerCase(),
              password: password.value,
              fullName: fullName.value,
              role: role.value,
            },
          });
          toast(`${username.value.trim().toLowerCase()} can now sign in.`);
          fullName.value = username.value = password.value = '';
          onDone();
        } catch (err) {
          error.textContent = err.message;
          error.style.display = '';
        } finally {
          button.disabled = false;
        }
      },
    },
    el('h2', { text: 'Add someone' }),
    error,
    el(
      'div',
      { class: 'grid-2' },
      el('div', { class: 'field' }, el('label', { text: 'Name' }), fullName),
      el('div', { class: 'field' }, el('label', { text: 'Username' }), username)
    ),
    el(
      'div',
      { class: 'grid-2' },
      el(
        'div',
        { class: 'field' },
        el('label', { text: 'Temporary password' }),
        password,
        el('div', { class: 'field-hint', text: 'At least 10 characters. Tell them to change it once they sign in.' })
      ),
      el('div', { class: 'field' }, el('label', { text: 'Role' }), role)
    ),
    button
  );
}

async function promptSetPassword(user, onDone) {
  const value = prompt(
    `Set a new password for ${user.username}.\n\nAt least 10 characters. They will be signed out everywhere.`
  );
  if (value === null) return;
  if (value.length < 10) {
    toast('Password must be at least 10 characters.', true);
    return;
  }
  try {
    await api(`/api/users/${user.id}/password`, { method: 'POST', body: { newPassword: value } });
    toast(`Password set for ${user.username}.`);
    onDone();
  } catch (err) {
    toast(err.message, true);
  }
}

// -------------------------------------------------------------------- router

function route() {
  if (!state.user) return renderGate();

  const hash = location.hash || '#/inpatient';
  const detail = hash.match(/^#\/e\/(\d+)/);
  const patient = hash.match(/^#\/p\/(\d+)/);
  const fresh = hash.match(/^#\/new\/(inpatient|outpatient)/);

  if (detail) return detailView(Number(detail[1]));
  if (patient) return patientView(Number(patient[1]));
  if (fresh) return newView(fresh[1]);
  if (hash.startsWith('#/outpatient')) return listView('outpatient');
  if (hash.startsWith('#/reports')) return reportView();
  if (hash.startsWith('#/account')) return accountView();
  if (hash.startsWith('#/inpatient')) return listView('inpatient');

  location.hash = '#/inpatient';
}

async function bootstrap() {
  const data = await api('/api/bootstrap');
  state.user = data.user;
  state.needsSetup = data.needsSetup;
  state.today = data.today;
  state.defaultRange = data.defaultRange;
}

window.addEventListener('hashchange', route);

bootstrap()
  .then(route)
  .catch((err) => {
    root.replaceChildren(
      el('div', { class: 'gate' }, el('div', { class: 'card notice notice-error', text: `Cannot reach the server: ${err.message}` }))
    );
  });
