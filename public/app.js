/**
 * Agentic Drive — browser UI (plain script, no modules, no libraries).
 *
 * ── IN SIMPLE WORDS ──
 * This file is the whole front end. It asks the server for your files and
 * shows them like a tidy desk: a sidebar of categories (Invoices, Meeting
 * Notes, Reports…) and topics, a list or grid of files, and a side panel that
 * previews a file. You can ask the drive a question from the bar at the top,
 * tick files and combine them into a new document, fix a file the agents put
 * in the wrong place ("Move to…"), and watch what the agents are doing. Every
 * 3 seconds it checks the activity feed, so files the agents create in the
 * background simply appear.
 *
 * ── BUSINESS RULES ──
 * - Categories are document kinds from GET /api/meta (spec §3); empty kinds
 *   are hidden in the sidebar except "Other" (spec §7).
 * - A topic is a second label and acts as an AND filter on the current view
 *   (plan Task 5).
 * - "Needs a look" = confidence 'low' and not pinned. Once a person moves a
 *   file (PATCH → pinned: true) it is theirs; we stop nagging about it.
 * - Recent = the 10 newest files by createdAt (plan Task 5).
 * - Combine needs at least 2 selected files; the result opens in the drawer.
 * - Polling every 3 s; files are re-fetched only when the newest activity id
 *   changes (an agent did something).
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - Every view is rebuilt from `state` by a render function. Patching DOM in
 *   place drifted out of sync with counts/selection in the old UI.
 * - Moves are optimistic and roll back on error, so the list never shows a
 *   kind the server rejected.
 * - The drawer only re-renders when its record actually changed, otherwise
 *   the 3 s poll would reset the reader's scroll position.
 * - /api/meta has a built-in fallback (same ids/labels as the spec) so the UI
 *   still renders against a server that is mid-upgrade.
 *
 * ── DO NOT ──
 * DO NOT: insert unescaped text. File names, file contents, answers, tags,
 * topics and error messages all come from users or from an AI, so anything
 * that goes into innerHTML must pass through escapeHtml() first (or be a
 * constant written in this file). A file named `<img src=x onerror=alert(1)>.txt`
 * must show up as text, never run. The Markdown/CSV renderers escape FIRST
 * and format after.
 * - Do not use alert/confirm/prompt; destructive actions use a second click.
 * - Do not build class names from raw server values; map them through the
 *   whitelists (kindOf / topicClass / agentClass).
 */
(function () {
  'use strict';

  /* ───────────────────────── Constants ───────────────────────── */

  const POLL_MS = 3000;
  const MAX_UPLOAD_BATCH = 20; // server limit per request
  const MAX_TABLE_ROWS = 500;
  const RECENT_COUNT = 10;
  const LAYOUT_KEY = 'agentic-drive:layout';

  const DEFAULT_KINDS = [
    { id: 'invoice', label: 'Invoices & Receipts' },
    { id: 'meeting', label: 'Meeting Notes' },
    { id: 'contract', label: 'Contracts & Agreements' },
    { id: 'proposal', label: 'Proposals & Briefs' },
    { id: 'spec', label: 'Specs & Plans' },
    { id: 'report', label: 'Reports' },
    { id: 'data', label: 'Spreadsheets & Data' },
    { id: 'people', label: 'People & HR' },
    { id: 'other', label: 'Other' },
  ];
  const DEFAULT_TOPICS = ['Finance', 'Marketing', 'Engineering', 'Sales', 'HR', 'Legal', 'Operations', 'Product'];
  const KIND_IDS = DEFAULT_KINDS.map((k) => k.id);
  const TOPIC_CLASSES = { finance: 1, marketing: 1, engineering: 1, sales: 1, hr: 1, legal: 1, operations: 1, product: 1 };
  const KNOWN_AGENTS = ['organizer', 'search', 'synthesizer', 'automations', 'drive'];
  const PROVIDER_LABELS = { gemini: 'Gemini', claude: 'Claude' };
  const EXAMPLES = [
    'What was the Q3 marketing budget?',
    'Who owns the campaign brief?',
    'How much did we spend on travel?',
  ];
  const FORMATS = [
    { id: 'requirements', label: 'Requirements' },
    { id: 'summary', label: 'Summary' },
    { id: 'compare', label: 'Compare' },
  ];
  const DRIVE_VIEWS = [
    { id: 'all', label: 'All files', icon: 'stack' },
    { id: 'recent', label: 'Recent', icon: 'clock' },
    { id: 'generated', label: 'Generated', icon: 'sparkle' },
    { id: 'review', label: 'Needs a look', icon: 'eye' },
  ];
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

  /* ───────────────────────── Escaping ───────────────────────── */

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  /** The ONE escaping helper. Use it for every interpolated value in HTML strings. */
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
  }

  /** Inline SVG icon from the sprite in index.html. `name` is a constant or a whitelisted kind id. */
  function icon(name, cls) {
    return '<svg class="i' + (cls ? ' ' + escapeHtml(cls) : '') + '" aria-hidden="true"><use href="#i-' + escapeHtml(name) + '"></use></svg>';
  }

  /* ───────────────────────── API helper ───────────────────────── */

  /**
   * fetch() wrapper. Sends `json` as a JSON body, parses the JSON reply, and
   * throws an Error carrying the server's `{error}` message on any non-2xx.
   * The parsed body is attached as `err.data` (upload errors list lives there).
   */
  function api(path, options) {
    const opts = options || {};
    const init = { method: opts.method || 'GET', headers: {} };
    if (opts.json !== undefined) {
      init.method = opts.method || 'POST';
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.json);
    } else if (opts.body !== undefined) {
      init.body = opts.body;
    }
    return fetch(path, init).then(
      (res) => res.text().then((raw) => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
        if (!res.ok) {
          const message = data && typeof data.error === 'string' && data.error ? data.error : 'Request failed (' + res.status + ').';
          const err = new Error(message);
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      }),
      () => {
        const err = new Error("Can't reach the server. Is it running?");
        err.status = 0;
        throw err;
      }
    );
  }

  /* ───────────────────────── State ───────────────────────── */

  const state = {
    meta: { kinds: DEFAULT_KINDS, topics: DEFAULT_TOPICS },
    files: [],
    filesLoaded: false,
    filesError: null,
    knownIds: null,            // ids seen on the previous load (for the "new row" flash)
    freshIds: new Set(),
    view: 'all',               // all | recent | generated | review | kind:<id>
    topic: null,               // AND filter
    filter: '',
    sort: { key: 'updated', dir: 'desc' },
    layout: 'list',
    selected: new Set(),
    anchorId: null,            // for shift-click range select
    drawer: { id: null, file: null, loading: false, token: 0, confirmDelete: false, sig: '' },
    cmd: { open: false, status: 'idle', question: '', data: null, error: '' },
    combining: null,           // format id while a combine runs
    rules: [],
    rulesError: '',
    activity: [],
    activityLoaded: false,
    newestActivityId: null,
    seenActivityId: null,
    freshActivity: new Set(),
    polling: false,
    uploading: false,
    status: undefined,
  };

  /* ───────────────────────── DOM refs ───────────────────────── */

  const $ = (id) => document.getElementById(id);
  const el = {
    status: $('ai-status'),
    btnUpload: $('btn-upload'),
    fileInput: $('file-input'),
    btnSamples: $('btn-samples'),
    btnMenu: $('btn-menu'),
    sidebar: $('sidebar'),
    navScrim: $('nav-scrim'),
    navDrive: $('nav-drive'),
    navKinds: $('nav-kinds'),
    navTopics: $('nav-topics'),
    navTopicsSection: $('nav-topics-section'),
    btnAuto: $('btn-automations'),
    autoCount: $('auto-count'),
    btnActivity: $('btn-activity'),
    unread: $('activity-unread'),
    viewTitle: $('view-title'),
    topicFilter: $('topic-filter'),
    viewCount: $('view-count'),
    filter: $('filter'),
    layoutList: $('layout-list'),
    layoutGrid: $('layout-grid'),
    files: $('files'),
    drawer: $('drawer'),
    drawerScrim: $('drawer-scrim'),
    panelScrim: $('panel-scrim'),
    selbar: $('selbar'),
    autoPanel: $('auto-panel'),
    ruleList: $('rule-list'),
    activityPanel: $('activity-panel'),
    activityList: $('activity-list'),
    menu: $('menu'),
    dropOverlay: $('drop-overlay'),
    toasts: $('toasts'),
    cmd: $('cmd'),
    askForm: $('ask-form'),
    askInput: $('ask-input'),
    cmdPanel: $('cmd-panel'),
    cmdBody: $('cmd-body'),
    cmdKbd: $('cmd-kbd'),
  };

  /* ───────────────────────── Small helpers ───────────────────────── */

  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function toDate(iso) {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }

  function shortDate(d) {
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
  }

  /** "just now", "4m ago", "3h ago", "2d ago", then "Sep 28". */
  function relTime(iso) {
    const d = toDate(iso);
    if (!d) return '';
    const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 7 * 86400) return Math.floor(s / 86400) + 'd ago';
    return shortDate(d);
  }

  function fullDate(iso) {
    const d = toDate(iso);
    return d ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  }

  function clockOrDate(iso) {
    const d = toDate(iso);
    if (!d) return '';
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return shortDate(d);
  }

  function extOf(file) {
    if (file.ext) return String(file.ext).toLowerCase();
    const m = /\.[^.]+$/.exec(file.name || '');
    return m ? m[0].toLowerCase() : '';
  }

  /** Whitelisted kind id (safe for class names / icon ids). */
  function kindOf(value) {
    const k = value && typeof value === 'object' ? value.kind : value;
    return KIND_IDS.indexOf(k) >= 0 ? k : 'other';
  }

  function kindLabel(id) {
    const k = state.meta.kinds.find((x) => x.id === id) || DEFAULT_KINDS.find((x) => x.id === id);
    return k ? k.label : 'Other';
  }

  function topicClass(topic) {
    const key = String(topic || '').toLowerCase();
    return TOPIC_CLASSES[key] ? 't-' + key : '';
  }

  function agentClass(agent) {
    const a = String(agent || '').toLowerCase();
    return 'ag-' + (KNOWN_AGENTS.indexOf(a) >= 0 ? a : 'drive');
  }

  const needsLook = (f) => f.confidence === 'low' && !f.pinned;
  const findFile = (id) => state.files.find((f) => f.id === id) || null;

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
  }

  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isNarrow = () => window.matchMedia('(max-width: 999.98px)').matches;

  function topicChip(topic) {
    if (!topic) return '';
    return '<span class="chip ' + escapeHtml(topicClass(topic)) + '" title="Topic: ' + escapeHtml(topic) + '"><span class="dot"></span><span class="chip-label">' + escapeHtml(topic) + '</span></span>';
  }

  function kindIcon(kind, extra) {
    const k = kindOf(kind);
    return icon(k, 'kind-icon k-' + k + (extra ? ' ' + extra : ''));
  }

  function setBusy(button, busy, busyLabel) {
    if (busy) {
      if (!button.dataset.idle) button.dataset.idle = button.innerHTML; // constant markup from index.html
      button.innerHTML = '<span class="spinner" aria-hidden="true"></span><span class="btn-label">' + escapeHtml(busyLabel || 'Working…') + '</span>';
      button.classList.add('is-busy');
      button.setAttribute('aria-busy', 'true');
      button.disabled = true;
    } else {
      if (button.dataset.idle) button.innerHTML = button.dataset.idle;
      delete button.dataset.idle;
      button.classList.remove('is-busy');
      button.removeAttribute('aria-busy');
      button.disabled = false;
    }
  }

  function setOpen(node, open) {
    node.dataset.open = open ? 'true' : 'false';
    node.inert = !open;
  }

  function triggerDownload(f) {
    const a = document.createElement('a');
    a.href = '/api/files/' + encodeURIComponent(f.id) + '/download';
    a.download = f.name || 'file';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* ───────────────────────── Toasts ───────────────────────── */

  /**
   * toast(kind, title, details?) — kind is success | error | info.
   * `details` is an optional array of plain strings shown as a list.
   */
  function toast(kind, title, details) {
    const node = document.createElement('div');
    node.className = 'toast toast-' + (kind === 'error' ? 'error' : kind === 'success' ? 'success' : 'info');
    node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    const ic = kind === 'success' ? 'check' : kind === 'error' ? 'alert' : 'info';
    const list = details && details.length
      ? '<ul class="toast-list">' + details.map((d) => '<li>' + escapeHtml(d) + '</li>').join('') + '</ul>'
      : '';
    node.innerHTML =
      '<span class="toast-icon">' + icon(ic) + '</span>' +
      '<div class="toast-body"><p class="toast-title">' + escapeHtml(title) + '</p>' + list + '</div>' +
      '<button type="button" class="icon-btn toast-close" aria-label="Dismiss">' + icon('close') + '</button>';
    let timer = null;
    function dismiss() {
      if (!node.isConnected || node.classList.contains('is-leaving')) return;
      clearTimeout(timer);
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), reduceMotion() ? 0 : 160);
    }
    const arm = () => { timer = setTimeout(dismiss, kind === 'error' || (details && details.length) ? 7000 : 4000); };
    node.querySelector('.toast-close').addEventListener('click', dismiss);
    node.addEventListener('mouseenter', () => clearTimeout(timer));
    node.addEventListener('mouseleave', arm);
    el.toasts.appendChild(node);
    while (el.toasts.children.length > 3) el.toasts.firstElementChild.remove();
    arm();
  }

  /* ───────────────────────── Status pill + meta ───────────────────────── */

  function renderStatus() {
    const s = state.status;
    const label = el.status.querySelector('.status-label');
    if (s && s.aiProvider) {
      const name = PROVIDER_LABELS[s.aiProvider] || String(s.aiProvider);
      label.textContent = name;
      el.status.classList.add('is-ai');
      el.status.title = 'Agents use ' + name + (s.model ? ' (' + s.model + ')' : '') + ', with offline rules as a fallback.';
    } else {
      label.textContent = s === null ? 'Disconnected' : 'Offline mode';
      el.status.classList.remove('is-ai');
      el.status.title = s === null ? 'Could not reach the server.' : 'No AI key set. The agents run on built-in offline rules.';
    }
  }

  function loadStatus() {
    return api('/api/status').then((s) => { state.status = s || {}; renderStatus(); }, () => { state.status = null; renderStatus(); });
  }

  function loadMeta() {
    return api('/api/meta').then((m) => {
      const kinds = m && Array.isArray(m.kinds) ? m.kinds.filter((k) => k && KIND_IDS.indexOf(k.id) >= 0 && k.label) : [];
      if (kinds.length) state.meta.kinds = kinds;
      if (m && Array.isArray(m.topics) && m.topics.length) state.meta.topics = m.topics.filter((t) => typeof t === 'string');
    }).catch(() => { /* keep the built-in fallback */ });
  }

  /* ───────────────────────── Files: load, scope, sort ───────────────────────── */

  function loadFiles() {
    return api('/api/files').then((data) => {
      const list = (data && data.files) || [];
      const prev = state.knownIds;
      state.freshIds = new Set();
      if (prev) list.forEach((f) => { if (!prev.has(f.id)) state.freshIds.add(f.id); });
      state.knownIds = new Set(list.map((f) => f.id));
      state.files = list;
      state.filesLoaded = true;
      state.filesError = null;
      state.selected.forEach((id) => { if (!findFile(id)) state.selected.delete(id); });
      if (state.drawer.id && !findFile(state.drawer.id)) closeDrawer(false);
      renderAll();
    }, (err) => {
      state.filesError = err.message;
      if (!state.filesLoaded) state.filesLoaded = true;
      renderMain();
      throw err;
    });
  }

  const byNewest = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''));

  function scopeFiles(view) {
    const v = view || state.view;
    if (v === 'recent') return state.files.slice().sort(byNewest).slice(0, RECENT_COUNT);
    if (v === 'generated') return state.files.filter((f) => f.generated);
    if (v === 'review') return state.files.filter(needsLook);
    if (v.indexOf('kind:') === 0) {
      const k = v.slice(5);
      return state.files.filter((f) => kindOf(f) === k);
    }
    return state.files.slice();
  }

  function matchesFilter(f, q) {
    if (!q) return true;
    const hay = [f.name, f.summary, f.topic, kindLabel(kindOf(f))].concat(f.tags || []).join(' ').toLowerCase();
    return hay.indexOf(q) >= 0;
  }

  function sortFiles(list) {
    const { key, dir } = state.sort;
    const mul = dir === 'asc' ? 1 : -1;
    const cmpText = (a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
    return list.slice().sort((a, b) => {
      let r = 0;
      if (key === 'name') r = cmpText(a.name, b.name);
      else if (key === 'topic') {
        if (!a.topic !== !b.topic) return a.topic ? -1 : 1; // no-topic always last
        r = cmpText(a.topic || '', b.topic || '');
      } else if (key === 'kind') r = cmpText(kindLabel(kindOf(a)), kindLabel(kindOf(b)));
      else if (key === 'size') r = (Number(a.size) || 0) - (Number(b.size) || 0);
      else r = String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
      if (r === 0) r = String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || cmpText(a.name, b.name);
      return r * mul;
    });
  }

  function visibleFiles() {
    const q = state.filter.trim().toLowerCase();
    return sortFiles(scopeFiles().filter((f) => (!state.topic || f.topic === state.topic) && matchesFilter(f, q)));
  }

  function viewTitle(view) {
    const v = view || state.view;
    const d = DRIVE_VIEWS.find((x) => x.id === v);
    if (d) return d.label;
    if (v.indexOf('kind:') === 0) return kindLabel(v.slice(5));
    return 'All files';
  }

  /* ───────────────────────── Sidebar ───────────────────────── */

  function navItem(view, label, iconHtml, count, extraClass, countClass) {
    const active = state.view === view;
    return '<li><button type="button" class="nav-item' + (extraClass ? ' ' + extraClass : '') + '" data-view="' + escapeHtml(view) + '"' +
      (active ? ' aria-current="page"' : '') + '>' + iconHtml +
      '<span class="nav-label">' + escapeHtml(label) + '</span>' +
      '<span class="nav-count' + (countClass ? ' ' + countClass : '') + '">' + escapeHtml(count) + '</span></button></li>';
  }

  function renderSidebar() {
    const files = state.files;
    const ready = state.filesLoaded && !(state.filesError && !files.length);
    el.navKinds.closest('.nav-section').hidden = !ready;
    if (!ready) {
      el.navDrive.innerHTML = DRIVE_VIEWS.map((v) => navItem(v.id, v.label, icon(v.icon), '')).join('');
      el.navKinds.innerHTML = '';
      el.navTopicsSection.hidden = true;
      el.btnSamples.hidden = true;
      return;
    }
    const counts = {
      all: files.length,
      recent: Math.min(RECENT_COUNT, files.length),
      generated: files.filter((f) => f.generated).length,
      review: files.filter(needsLook).length,
    };
    el.navDrive.innerHTML = DRIVE_VIEWS.map((v) => {
      const n = counts[v.id];
      const warn = v.id === 'review' && n > 0;
      return navItem(v.id, v.label, icon(v.icon), n || (v.id === 'all' ? 0 : ''), '', warn ? 'is-warn' : '');
    }).join('');

    const kindCounts = {};
    files.forEach((f) => { const k = kindOf(f); kindCounts[k] = (kindCounts[k] || 0) + 1; });
    el.navKinds.innerHTML = state.meta.kinds.map((k) => {
      const n = kindCounts[k.id] || 0;
      const view = 'kind:' + k.id;
      if (!n && k.id !== 'other' && state.view !== view) return '';
      return navItem(view, k.label, kindIcon(k.id), n || '', n ? '' : 'is-empty');
    }).join('');

    // Topics: chips for topics present in the drive; counts are within the current view.
    const inDrive = {};
    files.forEach((f) => { if (f.topic) inDrive[f.topic] = true; });
    const scoped = scopeFiles();
    const topics = state.meta.topics.filter((t) => inDrive[t] || state.topic === t);
    el.navTopicsSection.hidden = topics.length === 0;
    el.navTopics.innerHTML = topics.map((t) => {
      const n = scoped.filter((f) => f.topic === t).length;
      const on = state.topic === t;
      return '<button type="button" class="topic-btn ' + escapeHtml(topicClass(t)) + (n || on ? '' : ' is-zero') + '" data-topic="' + escapeHtml(t) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
        '<span class="dot"></span>' + escapeHtml(t) + '<span class="topic-count">' + escapeHtml(n) + '</span></button>';
    }).join('');

    // Offer the demo files until they are loaded, even when the drive already holds the user's own uploads.
    el.btnSamples.hidden = !(state.filesLoaded && !state.filesError && !files.some((f) => f.source === 'sample'));
  }

  /* ───────────────────────── Main area ───────────────────────── */

  function renderHeader(rows) {
    el.viewTitle.textContent = viewTitle();
    document.title = (state.view === 'all' ? '' : viewTitle() + ' · ') + 'Agentic Drive';
    el.topicFilter.innerHTML = state.topic
      ? '<span class="chip ' + escapeHtml(topicClass(state.topic)) + '"><span class="dot"></span><span class="chip-label">' + escapeHtml(state.topic) + '</span>' +
        '<button type="button" class="chip-x" data-clear-topic aria-label="Clear topic filter ' + escapeHtml(state.topic) + '">' + icon('close') + '</button></span>'
      : '';
    if (!state.filesLoaded || (state.filesError && !state.files.length) || !state.files.length) {
      el.viewCount.textContent = '';
      return;
    }
    const scopeN = scopeFiles().filter((f) => !state.topic || f.topic === state.topic).length;
    el.viewCount.textContent = state.filter.trim() ? rows.length + ' of ' + scopeN : String(rows.length);
  }

  function skeleton() {
    const widths = [62, 44, 70, 38, 56, 48, 66, 40, 52];
    return '<div class="list" aria-busy="true" aria-label="Loading files">' + widths.map((w, i) =>
      '<div class="skeleton-row" style="opacity:' + (1 - i * 0.08).toFixed(2) + '">' +
        '<span></span>' +
        '<span class="sk-name"><span class="sk sk-icon"></span><span class="sk" style="width:' + w + '%"></span></span>' +
        '<span class="sk" style="width:64px"></span>' +
        '<span class="sk sk-hide" style="width:96px"></span>' +
        '<span class="sk sk-hide" style="width:48px;margin-left:auto"></span>' +
        '<span class="sk sk-hide sk-size" style="width:36px;margin-left:auto"></span><span></span>' +
      '</div>').join('') + '</div>';
  }

  const EMPTY_ART =
    '<svg class="state-art empty-art" width="168" height="124" viewBox="0 0 168 124" aria-hidden="true">' +
      '<g class="float-a"><rect class="a-back" x="26" y="24" width="64" height="82" rx="9" stroke-width="1" transform="rotate(-9 58 65)"/></g>' +
      '<g class="float-b"><rect class="a-mid" x="78" y="20" width="64" height="82" rx="9" stroke-width="1" transform="rotate(8 110 61)"/>' +
        '<path class="a-line" d="M92 76h28M92 86h20" stroke-width="3" stroke-linecap="round" transform="rotate(8 110 61)"/></g>' +
      '<rect class="a-front" x="52" y="32" width="64" height="84" rx="9" stroke-width="1"/>' +
      '<rect class="a-accent-soft" x="62" y="42" width="22" height="22" rx="6"/>' +
      '<path class="a-spark" transform="translate(66 46.5)" d="M7 2c.45 3.1 1.4 4.05 4.5 4.5-3.1.45-4.05 1.4-4.5 4.5-.45-3.1-1.4-4.05-4.5-4.5C5.6 6.05 6.55 5.1 7 2z"/>' +
      '<path class="a-line" d="M62 78h42M62 88h32M62 98h38" stroke-width="3" stroke-linecap="round"/>' +
      '<path class="a-spark" d="M140 6c.9 6 2.8 7.9 8.8 8.8-6 .9-7.9 2.8-8.8 8.8-.9-6-2.8-7.9-8.8-8.8 6-.9 7.9-2.8 8.8-8.8z" opacity=".9"/>' +
      '<path class="a-spark" d="M24 98c.5 3.2 1.5 4.2 4.7 4.7-3.2.5-4.2 1.5-4.7 4.7-.5-3.2-1.5-4.2-4.7-4.7 3.2-.5 4.2-1.5 4.7-4.7z" opacity=".55"/>' +
    '</svg>';

  function stateBlock(o) {
    return '<div class="state' + (o.big ? ' state-big' : '') + '">' +
      (o.art || ('<span class="state-icon' + (o.tone ? ' is-' + o.tone : '') + '">' + icon(o.icon || 'search') + '</span>')) +
      '<p class="state-title">' + escapeHtml(o.title) + '</p>' +
      (o.text ? '<p class="state-text">' + escapeHtml(o.text) + '</p>' : '') +
      (o.actions ? '<div class="state-actions">' + o.actions + '</div>' : '') +
      (o.hint ? '<p class="state-hint">' + o.hint + '</p>' : '') +
    '</div>';
  }

  function emptyFor(rows) {
    const q = state.filter.trim();
    if (q) {
      return stateBlock({ icon: 'search', title: 'No files match “' + q + '”', text: 'Try another word, or clear the filter to see everything in ' + viewTitle() + '.',
        actions: '<button type="button" class="btn btn-secondary" data-action="clear-filter">Clear filter</button>' });
    }
    if (state.topic) {
      return stateBlock({ icon: 'hash', title: 'No ' + state.topic + ' files here', text: 'Nothing in ' + viewTitle() + ' has the ' + state.topic + ' topic. Clear the topic to see all of them.',
        actions: '<button type="button" class="btn btn-secondary" data-action="clear-topic">Clear topic</button>' });
    }
    if (state.view === 'review') {
      return stateBlock({ icon: 'check', tone: 'ok', title: 'Nothing needs a look', text: 'Every file was filed with confidence. Files the agents are unsure about will show up here.' });
    }
    if (state.view === 'generated') {
      return stateBlock({ icon: 'sparkle', title: 'No generated files yet', text: 'Select two or more files and combine them, or let an automation create one for you.' });
    }
    if (state.view.indexOf('kind:') === 0) {
      return stateBlock({ icon: kindOf(state.view.slice(5)), title: 'No ' + viewTitle().toLowerCase() + ' yet', text: 'Files the Organizer files here, or that you move here, will show up in this list.' });
    }
    return stateBlock({ icon: 'search', title: 'Nothing here', text: '' });
  }

  function sortHeader(key, label, extraClass) {
    const sorted = state.sort.key === key;
    const ariaSort = sorted ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
    return '<div class="th' + (extraClass ? ' ' + extraClass : '') + '" role="columnheader" aria-sort="' + ariaSort + '">' +
      '<button type="button" class="sort-btn' + (sorted ? ' is-sorted' : '') + (sorted && state.sort.dir === 'asc' ? ' is-asc' : '') + '" data-sort="' + escapeHtml(key) + '">' +
      escapeHtml(label) + icon('sort') + '</button></div>';
  }

  function flags(f) {
    let out = '';
    if (f.generated) out += '<span class="flag flag-gen" title="Generated by an agent">' + icon('sparkle') + '<span class="visually-hidden">Generated</span></span>';
    if (f.pinned) out += '<span class="flag" title="Pinned by you: agents won\'t re-sort it">' + icon('pin') + '<span class="visually-hidden">Pinned</span></span>';
    return out;
  }

  function kindCell(f) {
    if (needsLook(f)) return '<span class="look" title="The Organizer wasn\'t sure what this is. Use Move to… to file it.">Needs a look</span>';
    return '<span>' + escapeHtml(kindLabel(kindOf(f))) + '</span>';
  }

  function fileRow(f) {
    const sel = state.selected.has(f.id);
    const open = state.drawer.id === f.id;
    const id = escapeHtml(f.id);
    const name = escapeHtml(f.name);
    const sub = (needsLook(f) ? '<span class="look-text">Needs a look</span>' : escapeHtml(kindLabel(kindOf(f)))) + ' · ' + escapeHtml(relTime(f.createdAt));
    return '<div class="row' + (sel ? ' is-selected' : '') + (open ? ' is-open' : '') + (state.freshIds.has(f.id) ? ' is-new' : '') + '" role="row" data-id="' + id + '">' +
      '<div class="cell cell-check" role="cell"><input type="checkbox" class="cb" data-select="' + id + '"' + (sel ? ' checked' : '') + ' aria-label="Select ' + name + '"></div>' +
      '<div class="cell cell-name" role="cell">' + kindIcon(f) +
        '<div class="name-wrap"><div class="name-line"><button type="button" class="row-open" data-open="' + id + '" title="' + name + '">' + name + '</button>' + flags(f) + '</div>' +
        '<div class="row-sub">' + sub + '</div></div>' +
      '</div>' +
      '<div class="cell cell-topic" role="cell">' + topicChip(f.topic) + '</div>' +
      '<div class="cell cell-kind" role="cell">' + kindCell(f) + '</div>' +
      '<div class="cell cell-time" role="cell"><time datetime="' + escapeHtml(f.createdAt) + '" data-time="' + escapeHtml(f.createdAt) + '" title="' + escapeHtml(fullDate(f.createdAt)) + '">' + escapeHtml(relTime(f.createdAt)) + '</time></div>' +
      '<div class="cell cell-size" role="cell">' + escapeHtml(formatSize(f.size)) + '</div>' +
      '<div class="cell cell-more" role="cell"><button type="button" class="icon-btn" data-more="' + id + '" aria-haspopup="menu" aria-expanded="false" aria-label="More actions for ' + name + '">' + icon('more') + '</button></div>' +
    '</div>';
  }

  function fileCard(f) {
    const sel = state.selected.has(f.id);
    const open = state.drawer.id === f.id;
    const id = escapeHtml(f.id);
    const name = escapeHtml(f.name);
    const k = kindOf(f);
    const left = needsLook(f) ? '<span class="look">Needs a look</span>' : (topicChip(f.topic) || '<span>' + escapeHtml(kindLabel(k)) + '</span>');
    return '<div class="card' + (sel ? ' is-selected' : '') + (open ? ' is-open' : '') + (state.freshIds.has(f.id) ? ' is-new' : '') + '" data-id="' + id + '">' +
      '<div class="card-top"><span class="kind-tile k-' + escapeHtml(k) + '" title="' + escapeHtml(kindLabel(k)) + '">' + icon(k) + '</span>' +
        '<div class="card-top-right">' +
          '<button type="button" class="icon-btn" data-more="' + id + '" aria-haspopup="menu" aria-expanded="false" aria-label="More actions for ' + name + '">' + icon('more') + '</button>' +
          '<input type="checkbox" class="cb" data-select="' + id + '"' + (sel ? ' checked' : '') + ' aria-label="Select ' + name + '">' +
        '</div></div>' +
      '<div class="card-name-line"><button type="button" class="row-open" data-open="' + id + '" title="' + name + '">' + name + '</button>' + flags(f) + '</div>' +
      '<p class="card-summary">' + escapeHtml(f.summary || 'No summary yet.') + '</p>' +
      '<div class="card-foot">' + left + '<time datetime="' + escapeHtml(f.createdAt) + '" data-time="' + escapeHtml(f.createdAt) + '" title="' + escapeHtml(fullDate(f.createdAt)) + '">' + escapeHtml(relTime(f.createdAt)) + '</time></div>' +
    '</div>';
  }

  /** Remember which control had focus inside the file area so a re-render doesn't drop it. */
  function captureFocus() {
    const a = document.activeElement;
    if (!a || !el.files.contains(a)) return null;
    for (const attr of ['data-open', 'data-select', 'data-more', 'data-sort']) {
      if (a.hasAttribute(attr)) return { attr, value: a.getAttribute(attr) };
    }
    return null;
  }
  function restoreFocus(f) {
    if (!f) return;
    const n = el.files.querySelector('[' + f.attr + '="' + cssEscape(f.value) + '"]');
    if (n) n.focus({ preventScroll: true });
  }

  function renderMain() {
    const focus = captureFocus();
    document.body.classList.toggle('has-selection', state.selected.size > 0);
    el.files.closest('.main').classList.toggle('is-empty-drive', state.filesLoaded && !state.filesError && !state.files.length);
    el.layoutList.setAttribute('aria-pressed', state.layout === 'list' ? 'true' : 'false');
    el.layoutGrid.setAttribute('aria-pressed', state.layout === 'grid' ? 'true' : 'false');

    if (!state.filesLoaded) { renderHeader([]); el.files.innerHTML = skeleton(); return; }
    if (state.filesError && !state.files.length) {
      renderHeader([]);
      el.files.innerHTML = stateBlock({ icon: 'alert', tone: 'err', title: "Couldn't load your files", text: state.filesError,
        actions: '<button type="button" class="btn btn-secondary" data-action="retry">' + icon('refresh') + '<span>Try again</span></button>' });
      return;
    }
    if (!state.files.length) {
      renderHeader([]);
      el.files.innerHTML = stateBlock({
        big: true, art: EMPTY_ART, title: 'Your drive is empty',
        text: 'Drop in invoices, meeting notes, contracts or spreadsheets. The agents sort them, pull out what matters, and answer questions about them.',
        actions: '<button type="button" class="btn btn-primary" data-action="samples">' + icon('sparkle') + '<span class="btn-label">Load sample files</span></button>' +
                 '<button type="button" class="btn btn-secondary" data-action="upload">' + icon('upload') + '<span>Upload</span></button>',
        hint: icon('info') + '<span>Or drag files anywhere onto this window</span>',
      });
      return;
    }

    const rows = visibleFiles();
    renderHeader(rows);
    if (!rows.length) { el.files.innerHTML = emptyFor(rows); return; }

    if (state.layout === 'grid') {
      el.files.innerHTML = '<div class="grid" aria-label="Files">' + rows.map(fileCard).join('') + '</div>';
    } else {
      const allSel = rows.every((f) => state.selected.has(f.id));
      const someSel = !allSel && rows.some((f) => state.selected.has(f.id));
      el.files.innerHTML = '<div class="list" role="table" aria-label="Files">' +
        '<div class="list-head" role="row">' +
          '<div class="th" role="columnheader"><input type="checkbox" class="cb cb-all" data-select-all' + (allSel ? ' checked' : '') + ' aria-label="Select all ' + escapeHtml(plural(rows.length, 'file')) + '"></div>' +
          sortHeader('name', 'Name') + sortHeader('topic', 'Topic') + sortHeader('kind', 'Kind', 'th-kind') +
          sortHeader('updated', 'Updated', 'th-num th-time') + sortHeader('size', 'Size', 'th-num th-size') +
          '<div class="th" role="columnheader"><span class="visually-hidden">Actions</span></div>' +
        '</div>' + rows.map(fileRow).join('') + '</div>';
      const all = el.files.querySelector('.cb-all');
      if (all) all.indeterminate = someSel;
    }
    state.freshIds = new Set(); // flash only once
    restoreFocus(focus);
  }

  function renderAll() {
    renderSidebar();
    renderMain();
    renderSelbar();
    syncDrawer();
  }

  function setView(view) {
    state.view = view;
    if (state.topic && !scopeFiles().some((f) => f.topic === state.topic)) {
      // keep the topic: an empty AND result explains itself with a "Clear topic" action
    }
    renderSidebar();
    renderMain();
    el.files.scrollTop = 0;
    if (isNarrow()) toggleNav(false);
  }

  /* ───────────────────────── Selection + selection bar ───────────────────────── */

  function toggleSelected(id, on, range) {
    if (range && state.anchorId && state.anchorId !== id) {
      const ids = visibleFiles().map((f) => f.id);
      const a = ids.indexOf(state.anchorId);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((x) => { if (on) state.selected.add(x); else state.selected.delete(x); });
      }
    } else if (on) state.selected.add(id); else state.selected.delete(id);
    state.anchorId = id;
    renderMain();
    renderSelbar();
  }

  function clearSelection() {
    if (!state.selected.size) return;
    state.selected.clear();
    renderMain();
    renderSelbar();
  }

  function renderSelbar() {
    const n = state.selected.size;
    const open = n > 0;
    if (open) {
      const ready = n >= 2;
      const busy = state.combining;
      el.selbar.innerHTML = '<div class="selbar-inner">' +
        '<span class="selbar-count"><span class="selbar-num">' + escapeHtml(n) + '</span><span class="selbar-word">selected</span></span>' +
        '<span class="selbar-sep" aria-hidden="true"></span>' +
        '<span class="selbar-label">Combine into</span>' +
        FORMATS.map((fm) => {
          const isBusy = busy === fm.id;
          const disabled = !ready || (busy && !isBusy);
          const tip = !ready ? 'Select at least 2 files to combine' : 'Combine ' + n + ' files into one ' + fm.label.toLowerCase() + ' doc';
          return '<button type="button" class="selbar-btn' + (isBusy ? ' is-busy' : '') + '" data-combine="' + escapeHtml(fm.id) + '"' +
            (disabled ? ' aria-disabled="true"' : '') + (busy ? '' : ' data-tip="' + escapeHtml(tip) + '"') + ' aria-label="' + escapeHtml(tip) + '">' +
            (isBusy ? '<span class="spinner" aria-hidden="true"></span>' : icon(fm.id === 'compare' ? 'list' : fm.id === 'summary' ? 'sparkle' : 'spec')) +
            '<span>' + escapeHtml(isBusy ? 'Combining…' : fm.label) + '</span></button>';
        }).join('') +
        '<span class="selbar-sep" aria-hidden="true"></span>' +
        '<button type="button" class="selbar-btn selbar-clear" data-clear-selection aria-label="Clear selection">' + icon('close') + '<span class="selbar-clear-label">Clear</span></button>' +
      '</div>';
    }
    setOpen(el.selbar, open);
  }

  function combine(format) {
    const ids = Array.from(state.selected);
    if (ids.length < 2 || state.combining) return;
    state.combining = format;
    renderSelbar();
    api('/api/synthesize', { json: { fileIds: ids, format } }).then((record) => {
      const name = record && record.name ? record.name : 'a new document';
      toast('success', 'Created ' + name, ['Combined ' + ids.length + ' files. Find it under Generated.']);
      state.selected.clear();
      return Promise.all([loadFiles(), pollActivity()]).then(() => { if (record && record.id) openDrawer(record.id); });
    }).catch((err) => {
      toast('error', "Couldn't combine those files", [err.message]);
      if (err.status === 404) loadFiles();
    }).then(() => {
      state.combining = null;
      renderSelbar();
      renderMain();
    });
  }

  /* ───────────────────────── Menu (row more / Move to… / Topic) ───────────────────────── */

  const menu = { anchor: null, stack: [], align: 'end' };

  /**
   * Item: {label, icon (html, constant or escaped), action(), submenu() → items,
   *        checked (bool → menuitemradio), danger, confirm (two-step delete)} or {sep:true}.
   */
  function openMenu(anchor, title, items, align) {
    closeMenu(false);
    menu.anchor = anchor;
    menu.align = align || 'end';
    menu.stack = [{ title, items }];
    anchor.setAttribute('aria-expanded', 'true');
    el.menu.hidden = false;
    el.menu.setAttribute('aria-label', title || 'Actions');
    renderMenu();
    requestAnimationFrame(() => { el.menu.dataset.open = 'true'; });
    focusMenuItem(0);
  }

  function renderMenu() {
    const level = menu.stack[menu.stack.length - 1];
    let html = '';
    if (menu.stack.length > 1) {
      html += '<button type="button" class="menu-item" role="menuitem" data-back>' + icon('chevron-left') + '<span class="menu-label">Back</span></button><div class="menu-sep" role="separator"></div>';
    }
    if (level.title && menu.stack.length > 1) html += '<div class="menu-title">' + escapeHtml(level.title) + '</div>';
    html += level.items.map((it, i) => {
      if (it.sep) return '<div class="menu-sep" role="separator"></div>';
      const radio = typeof it.checked === 'boolean';
      const end = it.submenu ? '<span class="menu-end">' + icon('chevron-right') + '</span>'
        : radio && it.checked ? '<span class="menu-end">' + icon('check') + '</span>' : '';
      return '<button type="button" class="menu-item' + (it.danger ? ' danger' : '') + (it.armed ? ' is-confirm confirm-delete' : '') + '"' +
        ' role="' + (radio ? 'menuitemradio' : 'menuitem') + '"' + (radio ? ' aria-checked="' + (it.checked ? 'true' : 'false') + '"' : '') +
        (it.submenu ? ' aria-haspopup="menu"' : '') + ' data-index="' + i + '">' +
        (it.icon || '') + '<span class="menu-label">' + escapeHtml(it.armed ? 'Click again to delete' : it.label) + '</span>' + end + '</button>';
    }).join('');
    el.menu.innerHTML = html;
    positionMenu();
  }

  function positionMenu() {
    if (!menu.anchor) return;
    const r = menu.anchor.getBoundingClientRect();
    const mw = el.menu.offsetWidth;
    const mh = el.menu.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = menu.align === 'start' ? r.left : r.right - mw;
    left = Math.max(8, Math.min(left, vw - mw - 8));
    let top = r.bottom + 4;
    let up = false;
    if (top + mh > vh - 8 && r.top - mh - 4 > 8) { top = r.top - mh - 4; up = true; }
    top = Math.max(8, Math.min(top, vh - mh - 8));
    el.menu.style.left = left + 'px';
    el.menu.style.top = top + 'px';
    el.menu.classList.toggle('is-up', up);
    el.menu.style.transformOrigin = (up ? 'bottom ' : 'top ') + (menu.align === 'start' ? 'left' : 'right');
  }

  function menuItems() { return Array.from(el.menu.querySelectorAll('.menu-item')); }
  function focusMenuItem(i) {
    const items = menuItems();
    if (!items.length) return;
    const idx = (i + items.length) % items.length;
    items[idx].focus({ preventScroll: true });
  }

  function closeMenu(returnFocus) {
    if (!menu.anchor) return;
    const anchor = menu.anchor;
    anchor.setAttribute('aria-expanded', 'false');
    menu.anchor = null;
    menu.stack = [];
    el.menu.dataset.open = 'false';
    el.menu.hidden = true;
    el.menu.innerHTML = '';
    if (returnFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
  }

  function onMenuClick(e) {
    if (e.target.closest('[data-back]')) {
      menu.stack.pop();
      renderMenu();
      focusMenuItem(0);
      return;
    }
    const btn = e.target.closest('[data-index]');
    if (!btn) return;
    const level = menu.stack[menu.stack.length - 1];
    const item = level.items[Number(btn.getAttribute('data-index'))];
    if (!item) return;
    if (item.submenu) {
      menu.stack.push({ title: item.label, items: item.submenu() });
      renderMenu();
      const checked = el.menu.querySelector('[aria-checked="true"]');
      if (checked) checked.focus({ preventScroll: true }); else focusMenuItem(1);
      return;
    }
    if (item.confirm && !item.armed) {
      item.armed = true;
      const idx = Number(btn.getAttribute('data-index'));
      renderMenu();
      const again = el.menu.querySelector('[data-index="' + idx + '"]');
      if (again) again.focus({ preventScroll: true });
      return;
    }
    closeMenu(true);
    item.action();
  }

  function onMenuKey(e) {
    const items = menuItems();
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusMenuItem(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusMenuItem(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusMenuItem(0); }
    else if (e.key === 'End') { e.preventDefault(); focusMenuItem(items.length - 1); }
    else if (e.key === 'ArrowRight' && document.activeElement && document.activeElement.hasAttribute('aria-haspopup')) { e.preventDefault(); document.activeElement.click(); }
    else if ((e.key === 'ArrowLeft' || e.key === 'Escape') && menu.stack.length > 1) { e.preventDefault(); e.stopPropagation(); menu.stack.pop(); renderMenu(); focusMenuItem(0); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    else if (e.key === 'Tab') { closeMenu(false); }
  }

  function kindItems(f) {
    return state.meta.kinds.map((k) => ({
      label: k.label, icon: kindIcon(k.id), checked: kindOf(f) === k.id,
      action: () => { if (kindOf(f) !== k.id || !f.pinned) patchFile(f.id, { kind: k.id }); },
    }));
  }

  function topicItems(f) {
    return [{ label: 'No topic', icon: '<span class="dot" style="background:transparent;border:1px dashed var(--faint)"></span>', checked: !f.topic, action: () => { if (f.topic) patchFile(f.id, { topic: null }); } }]
      .concat(state.meta.topics.map((t) => ({
        label: t, icon: '<span class="dot ' + escapeHtml(topicClass(t)) + '"></span>', checked: f.topic === t,
        action: () => { if (f.topic !== t) patchFile(f.id, { topic: t }); },
      })));
  }

  function openRowMenu(anchor, id) {
    const f = findFile(id);
    if (!f) return;
    openMenu(anchor, 'Actions for ' + f.name, [
      { label: 'Open', icon: icon('open'), action: () => openDrawer(id) },
      { label: 'Move to…', icon: icon('move'), submenu: () => kindItems(f) },
      { label: 'Set topic…', icon: icon('hash'), submenu: () => topicItems(f) },
      { sep: true },
      { label: 'Download', icon: icon('download'), action: () => triggerDownload(f) },
      { label: 'Delete', icon: icon('trash'), danger: true, confirm: true, action: () => deleteFile(id) },
    ]);
  }

  /* ───────────────────────── Move / topic (PATCH) ───────────────────────── */

  function patchFile(id, patch) {
    const f = findFile(id);
    if (!f) return;
    const before = { kind: f.kind, topic: f.topic, pinned: f.pinned };
    Object.assign(f, patch, { pinned: true });
    if (state.drawer.file && state.drawer.id === id) Object.assign(state.drawer.file, patch, { pinned: true });
    renderAll();
    api('/api/files/' + encodeURIComponent(id), { method: 'PATCH', json: patch }).then((rec) => {
      const cur = findFile(id);
      if (cur && rec && typeof rec === 'object') Object.assign(cur, rec);
      if (state.drawer.file && state.drawer.id === id && rec) Object.assign(state.drawer.file, rec, { text: state.drawer.file.text });
      renderAll();
      const what = 'kind' in patch ? 'Moved to ' + kindLabel(kindOf(patch.kind)) : patch.topic ? 'Topic set to ' + patch.topic : 'Topic cleared';
      toast('success', what, ['“' + f.name + '” is pinned, so agents won\'t re-sort it.']);
      pollActivity();
    }).catch((err) => {
      const cur = findFile(id);
      if (cur) Object.assign(cur, before);
      if (state.drawer.file && state.drawer.id === id) Object.assign(state.drawer.file, before);
      renderAll();
      toast('error', "Couldn't move " + f.name, [err.message]);
      if (err.status === 404) loadFiles();
    });
  }

  /* ───────────────────────── Delete ───────────────────────── */

  function deleteFile(id) {
    const f = findFile(id);
    const name = f ? f.name : 'file';
    const row = el.files.querySelector('[data-id="' + cssEscape(id) + '"]');
    if (row) row.style.opacity = '0.4';
    api('/api/files/' + encodeURIComponent(id), { method: 'DELETE' }).then(() => {
      state.selected.delete(id);
      if (state.drawer.id === id) closeDrawer(false);
      toast('success', 'Deleted ' + name);
      return Promise.all([loadFiles(), pollActivity()]);
    }).catch((err) => {
      if (row) row.style.opacity = '';
      toast('error', "Couldn't delete " + name, [err.message]);
      if (err.status === 404) loadFiles();
    });
  }

  /* ───────────────────────── CSV + Markdown renderers ───────────────────────── */

  /** RFC-4180-ish CSV parser: quoted fields, "" escapes, commas and newlines inside quotes. */
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQuotes) {
        if (ch === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field); field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && s[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else {
        field += ch;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => !(r.length === 1 && r[0] === ''));
  }

  function renderCsvTable(text) {
    const rows = parseCsv(text);
    if (!rows.length) return '<p class="table-note">This CSV file is empty.</p>';
    const head = rows[0];
    const body = rows.slice(1, MAX_TABLE_ROWS + 1);
    const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
    // Right-align columns whose every non-empty value looks like a number or amount.
    const numeric = [];
    for (let i = 0; i < width; i++) {
      const vals = body.map((r) => String(r[i] == null ? '' : r[i]).trim()).filter(Boolean);
      numeric[i] = vals.length > 0 && vals.every((v) => /^[-+$€£]?\s?[\d,]+(\.\d+)?%?$/.test(v));
    }
    const cells = (r, tag) => {
      let out = '';
      for (let i = 0; i < width; i++) out += '<' + tag + (numeric[i] ? ' class="num"' : '') + '>' + escapeHtml(r[i] == null ? '' : r[i]) + '</' + tag + '>';
      return out;
    };
    let html = '<div class="table-wrap"><table class="data-table is-csv"><thead><tr>' + cells(head, 'th') + '</tr></thead><tbody>' +
      body.map((r) => '<tr>' + cells(r, 'td') + '</tr>').join('') + '</tbody></table></div>';
    const total = rows.length - 1;
    if (total > MAX_TABLE_ROWS) html += '<p class="table-note">' + escapeHtml('Showing the first ' + MAX_TABLE_ROWS + ' of ' + total + ' rows') + '</p>';
    return html;
  }

  /** Inline formatting on ALREADY-ESCAPED text: **bold**, *italic* / _italic_ and `code`. */
  function mdInline(escaped) {
    return escaped
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
      // Italic only at word edges, so snake_case names like q3_budget stay intact.
      .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=$|[\s.,;:!?)])/g, '$1<em>$2</em>');
  }

  function splitTableRow(line) {
    const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return t.split('|').map((c) => c.trim());
  }

  /**
   * Tiny safe Markdown renderer. Each line is escaped FIRST, then block and
   * inline formatting is applied to the escaped text, so no raw HTML survives.
   */
  function renderMarkdown(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [];
    let list = null; // { tag, cls, items: [] }
    let table = null; // rows of escaped cells

    const flushPara = () => { if (para.length) out.push('<p>' + para.join('<br>') + '</p>'); para = []; };
    const flushList = () => {
      if (list) out.push('<' + list.tag + (list.cls ? ' class="' + list.cls + '"' : '') + '>' + list.items.join('') + '</' + list.tag + '>');
      list = null;
    };
    const flushTable = () => {
      if (table && table.length) {
        const head = table[0];
        out.push('<div class="table-wrap"><table class="data-table"><thead><tr>' +
          head.map((c) => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>' +
          table.slice(1).map((r) => {
            let cellsHtml = '';
            for (let i = 0; i < head.length; i++) cellsHtml += '<td>' + (r[i] || '') + '</td>';
            return '<tr>' + cellsHtml + '</tr>';
          }).join('') + '</tbody></table></div>');
      }
      table = null;
    };
    const flushAll = () => { flushPara(); flushList(); flushTable(); };
    const pushItem = (tag, cls, itemHtml) => {
      flushPara(); flushTable();
      if (!list || list.tag !== tag || list.cls !== cls) { flushList(); list = { tag, cls, items: [] }; }
      list.items.push(itemHtml);
    };

    lines.forEach((rawLine) => {
      const line = escapeHtml(rawLine); // escape first — everything below works on safe text
      const trimmed = line.trim();
      let m;

      if (!trimmed) { flushAll(); return; }

      if (/^\|.*\|$/.test(trimmed)) {
        flushPara(); flushList();
        const cells = splitTableRow(trimmed);
        if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return; // separator row
        table = table || [];
        table.push(cells.map(mdInline));
        return;
      }
      if (table) flushTable();

      if ((m = /^(#{1,6})\s+(.*)$/.exec(trimmed))) {
        flushAll();
        const level = Math.min(m[1].length, 3);
        out.push('<h' + level + '>' + mdInline(m[2].replace(/\s#+$/, '')) + '</h' + level + '>');
        return;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flushAll(); out.push('<hr>'); return; }
      if ((m = /^[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(trimmed))) {
        const done = m[1] !== ' ';
        pushItem('ul', 'checklist', '<li' + (done ? ' class="done"' : '') + '><input type="checkbox" class="cb" disabled' + (done ? ' checked' : '') +
          ' aria-label="' + (done ? 'Done' : 'Not done') + '"><span>' + mdInline(m[2]) + '</span></li>');
        return;
      }
      if ((m = /^[-*]\s+(.*)$/.exec(trimmed))) { pushItem('ul', '', '<li>' + mdInline(m[1]) + '</li>'); return; }
      if ((m = /^\d+[.)]\s+(.*)$/.exec(trimmed))) { pushItem('ol', '', '<li>' + mdInline(m[1]) + '</li>'); return; }

      flushList();
      para.push(mdInline(trimmed));
    });
    flushAll();
    return '<div class="md">' + out.join('') + '</div>';
  }

  function bodyInfo(file) {
    const ext = extOf(file);
    const text = file.text || '';
    if (ext === '.csv') { const n = Math.max(0, parseCsv(text).length - 1); return 'CSV · ' + plural(n, 'row'); }
    if (ext === '.md') return 'Markdown';
    if (ext === '.pdf') return 'PDF · extracted text';
    return 'Plain text';
  }

  function renderBody(file) {
    const ext = extOf(file);
    const text = file.text || '';
    if (!text.trim()) return '<p class="table-note">No readable text in this file.</p>';
    if (ext === '.csv') return renderCsvTable(text);
    if (ext === '.md') return renderMarkdown(text);
    return '<pre class="plain-text">' + escapeHtml(text) + '</pre>';
  }

  /* ───────────────────────── Drawer ───────────────────────── */

  function drawerSig(f) {
    return f ? [f.id, f.name, f.kind, f.topic, f.confidence, f.pinned, f.size, f.summary, (f.tags || []).join('|'), f.generated, typeof f.text === 'string' ? f.text.length : -1].join('¦') : '';
  }

  function renderDrawer() {
    const d = state.drawer;
    const f = d.file;
    if (!f) return;
    const k = kindOf(f);
    const scrollTop = (el.drawer.querySelector('.drawer-body') || {}).scrollTop || 0;
    const downloadHref = '/api/files/' + encodeURIComponent(f.id) + '/download';
    const meta = [];
    meta.push('<span class="meta-kind">' + kindIcon(k) + escapeHtml(kindLabel(k)) + '</span>');
    if (f.topic) meta.push(topicChip(f.topic));
    if (needsLook(f)) meta.push('<span class="look">Needs a look</span>');
    else if (f.confidence === 'medium' && !f.pinned) meta.push('<span class="meta-flag" title="The Organizer was fairly, but not fully, sure">Medium confidence</span>');
    if (f.pinned) meta.push('<span class="meta-flag" title="You placed this file. Agents won\'t re-sort it.">' + icon('pin') + 'Pinned</span>');
    if (f.generated) meta.push('<span class="meta-flag is-gen">' + icon('sparkle') + 'Generated</span>');
    const metaHtml = meta.join('<span class="sep" aria-hidden="true"></span>');
    const created = fullDate(f.createdAt);
    const sub = [created ? 'Added ' + created : '', formatSize(f.size), f.source === 'upload' ? 'Uploaded by you' : f.source === 'sample' ? 'Sample file' : ''].filter(Boolean).join(' · ');

    const topicBtn = f.topic
      ? '<span class="dot ' + escapeHtml(topicClass(f.topic)) + '"></span><span>' + escapeHtml(f.topic) + '</span>'
      : icon('hash') + '<span>No topic</span>';

    const del = d.confirmDelete
      ? '<button type="button" class="btn btn-danger btn-sm confirm-delete" data-drawer-delete>' + icon('trash') + '<span>Confirm delete</span></button>'
      : '<button type="button" class="icon-btn danger" data-drawer-delete aria-label="Delete ' + escapeHtml(f.name) + '" title="Delete">' + icon('trash') + '</button>';

    let body = '';
    if (needsLook(f)) {
      body += '<div class="callout callout-warn">' + icon('eye') + '<div><strong>Needs a look.</strong> The Organizer wasn\'t confident what this is, so it went to Other. ' +
        'Pick the right category and it stays there.<br><button type="button" class="btn btn-secondary btn-sm" data-drawer-move>' + icon('move') + '<span>Move to…</span></button></div></div>';
    }
    if (f.summary) {
      body += '<div class="summary-card"><p class="summary-label">' + icon('sparkle') + 'Summary</p><p class="summary-text">' + escapeHtml(f.summary) + '</p></div>';
    }
    if (f.tags && f.tags.length) body += '<div class="tags">' + f.tags.slice(0, 16).map((t) => '<span class="tag">' + escapeHtml(t) + '</span>').join('') + '</div>';
    if (typeof f.text === 'string') {
      body += '<div class="body-label"><span>Contents</span><span>' + escapeHtml(bodyInfo(f)) + '</span></div>' + renderBody(f);
    } else if (d.loading) {
      body += '<div class="body-label"><span>Contents</span><span></span></div><div class="drawer-loading" aria-label="Loading file">' +
        [92, 78, 85, 60, 88, 70].map((w) => '<span class="sk" style="width:' + w + '%"></span>').join('') + '</div>';
    } else if (d.error) {
      body += '<div class="callout">' + icon('alert') + '<div>' + escapeHtml(d.error) + '</div></div>';
    }

    el.drawer.innerHTML =
      '<header class="drawer-head">' +
        '<div class="drawer-title-row">' +
          '<span class="kind-tile k-' + escapeHtml(k) + '">' + icon(k) + '</span>' +
          '<h2 id="drawer-title" class="drawer-title" tabindex="-1" title="' + escapeHtml(f.name) + '">' + escapeHtml(f.name) + '</h2>' +
          '<button type="button" class="icon-btn" data-drawer-close aria-label="Close preview" title="Close (Esc)">' + icon('close') + '</button>' +
        '</div>' +
        '<div class="drawer-meta">' + metaHtml + '</div>' +
        '<p class="drawer-sub">' + escapeHtml(sub) + '</p>' +
        '<div class="drawer-actions">' +
          '<button type="button" class="btn btn-secondary btn-sm" data-drawer-move aria-haspopup="menu" aria-expanded="false">' + icon('move') + '<span>Move to…</span>' + icon('chevron-down', 'chev') + '</button>' +
          '<button type="button" class="btn btn-secondary btn-sm" data-drawer-topic aria-haspopup="menu" aria-expanded="false" aria-label="Topic: ' + escapeHtml(f.topic || 'none') + '">' + topicBtn + icon('chevron-down', 'chev') + '</button>' +
          '<span class="spacer"></span>' +
          '<a class="icon-btn" href="' + escapeHtml(downloadHref) + '" download="' + escapeHtml(f.name) + '" aria-label="Download ' + escapeHtml(f.name) + '" title="Download">' + icon('download') + '</a>' +
          del +
        '</div>' +
      '</header>' +
      '<div class="drawer-body">' + body + '</div>';
    const nb = el.drawer.querySelector('.drawer-body');
    if (nb && scrollTop) nb.scrollTop = scrollTop;
    d.sig = drawerSig(f);
  }

  /** After the file list changes, refresh the drawer only if its record changed. */
  function syncDrawer() {
    const d = state.drawer;
    if (!d.id || !d.file) return;
    const cur = findFile(d.id);
    if (cur) Object.assign(d.file, cur, { text: d.file.text });
    if (drawerSig(d.file) !== d.sig) renderDrawer();
  }

  function openDrawer(id) {
    if (!id) return;
    const d = state.drawer;
    const known = findFile(id);
    const token = ++d.token;
    const wasOpen = !!d.id;
    d.id = id;
    d.file = known ? Object.assign({}, known) : { id, name: 'Loading…', size: 0 };
    d.loading = true;
    d.error = '';
    d.confirmDelete = false;
    renderDrawer();
    setOpen(el.drawer, true);
    document.body.classList.add('drawer-open');
    el.drawerScrim.classList.toggle('is-open', window.matchMedia('(max-width: 759.98px)').matches);
    markOpen();
    const title = $('drawer-title');
    if (title) title.focus({ preventScroll: true });
    if (!wasOpen && el.drawer.querySelector('.drawer-body')) el.drawer.querySelector('.drawer-body').scrollTop = 0;

    api('/api/files/' + encodeURIComponent(id)).then((file) => {
      if (token !== d.token) return;
      d.file = file;
      d.loading = false;
      const t = $('drawer-title');
      const hadFocus = t && document.activeElement === t;
      renderDrawer();
      if (hadFocus) $('drawer-title').focus({ preventScroll: true });
    }).catch((err) => {
      if (token !== d.token) return;
      d.loading = false;
      if (err.status === 404) {
        toast('error', 'That file no longer exists.');
        closeDrawer(false);
        loadFiles();
      } else {
        d.error = "Couldn't open this file: " + err.message;
        renderDrawer();
      }
    });
  }

  function closeDrawer(returnFocus) {
    const d = state.drawer;
    const openId = d.id;
    d.token++;
    d.id = null;
    d.file = null;
    d.confirmDelete = false;
    d.sig = '';
    setOpen(el.drawer, false);
    document.body.classList.remove('drawer-open');
    el.drawerScrim.classList.remove('is-open');
    markOpen();
    if (returnFocus && openId) {
      const opener = el.files.querySelector('[data-open="' + cssEscape(openId) + '"]');
      if (opener) opener.focus({ preventScroll: true });
    }
  }

  function markOpen() {
    el.files.querySelectorAll('[data-id]').forEach((n) => n.classList.toggle('is-open', n.getAttribute('data-id') === state.drawer.id));
  }

  let confirmTimer = null;
  function onDrawerClick(e) {
    const f = state.drawer.file;
    if (!f) return;
    if (e.target.closest('[data-drawer-close]')) { closeDrawer(true); return; }
    const mv = e.target.closest('[data-drawer-move]');
    if (mv) {
      const target = el.drawer.querySelector('.drawer-actions [data-drawer-move]');
      openMenu(target, 'Move to', kindItems(f), 'start');
      return;
    }
    const tp = e.target.closest('[data-drawer-topic]');
    if (tp) { openMenu(tp, 'Topic', topicItems(f), 'start'); return; }
    if (e.target.closest('[data-drawer-delete]')) {
      if (state.drawer.confirmDelete) {
        clearTimeout(confirmTimer);
        deleteFile(f.id);
        return;
      }
      state.drawer.confirmDelete = true;
      renderDrawer();
      const b = el.drawer.querySelector('[data-drawer-delete]');
      if (b) b.focus({ preventScroll: true });
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => {
        if (state.drawer.confirmDelete) { state.drawer.confirmDelete = false; renderDrawer(); }
      }, 4000);
    }
  }

  /* ───────────────────────── Command bar (Ask) ───────────────────────── */

  function renderCmd() {
    const c = state.cmd;
    let html = '';
    if (c.status === 'loading') {
      html = '<div class="answer-loading" role="status"><p class="answer-loading-label"><span class="spinner" aria-hidden="true"></span>Searching ' +
        escapeHtml(plural(state.files.length, 'file')) + '…</p><div class="drawer-loading">' +
        [96, 88, 64].map((w) => '<span class="sk" style="width:' + w + '%"></span>').join('') + '</div></div>';
    } else if (c.status === 'error') {
      html = '<div class="answer-error" role="alert">' + icon('alert') + '<div><p>' + escapeHtml(c.error) + '</p>' +
        '<button type="button" class="btn btn-secondary btn-sm" data-retry-ask>' + icon('refresh') + '<span>Try again</span></button></div></div>';
    } else if (c.status === 'answer' && c.data) {
      html = renderAnswer(c.question, c.data);
    } else {
      html = '<p class="cmd-section-label">Try asking</p>' + EXAMPLES.map((q) =>
        '<button type="button" class="cmd-example" data-question="' + escapeHtml(q) + '">' + icon('search') + '<span>' + escapeHtml(q) + '</span>' +
        '<span class="cmd-example-go">' + icon('enter') + '</span></button>').join('');
    }
    el.cmdBody.innerHTML = html;
  }

  function renderAnswer(question, data) {
    const citations = (data && Array.isArray(data.citations)) ? data.citations : [];
    const byN = {};
    citations.forEach((c) => { byN[c.n] = c; });

    // Escape the whole answer first, then turn [n] markers into citation buttons.
    const paragraphs = String((data && data.answer) || '').split(/\n+/).filter((p) => p.trim());
    const answerHtml = paragraphs.map((p) => {
      const safe = mdInline(escapeHtml(p)).replace(/\[(\d+)\]/g, (match, n) => {
        const c = byN[n];
        if (!c) return match;
        return '<button type="button" class="cite" data-file-id="' + escapeHtml(c.fileId) + '" title="Open ' + escapeHtml(c.fileName) + '" aria-label="Source ' + escapeHtml(n) + ': ' + escapeHtml(c.fileName) + '">' + escapeHtml(n) + '</button>';
      });
      return '<p>' + safe + '</p>';
    }).join('') || '<p>' + escapeHtml('No answer came back.') + '</p>';

    const ai = data && data.by === 'ai';
    let html = '<div class="answer">' +
      '<div class="answer-head"><p class="answer-q">' + escapeHtml(question) + '</p>' +
      '<span class="badge' + (ai ? ' badge-ai' : '') + '" title="' + (ai ? 'Answered by the AI model' : 'Answered by offline keyword search') + '">' + (ai ? icon('sparkle') + 'AI' : 'Offline') + '</span></div>' +
      '<div class="answer-text">' + answerHtml + '</div>';
    if (citations.length) {
      html += '<div class="sources"><p class="sources-label">Sources</p>' + citations.map((c) => {
        const f = findFile(c.fileId);
        return '<button type="button" class="source" data-file-id="' + escapeHtml(c.fileId) + '">' +
          '<span class="cite" aria-hidden="true">' + escapeHtml(c.n) + '</span>' + kindIcon(f) +
          '<span class="source-name">' + escapeHtml(c.fileName) + '</span>' +
          (c.snippet ? '<span class="source-snippet">' + escapeHtml(c.snippet) + '</span>' : '') +
        '</button>';
      }).join('') + '</div>';
    }
    return html + '</div>';
  }

  function openCmd() {
    if (state.cmd.open) return;
    closeMenu(false);
    state.cmd.open = true;
    renderCmd();
    setOpen(el.cmdPanel, true);
    el.askInput.setAttribute('aria-expanded', 'true');
  }

  function closeCmd() {
    if (!state.cmd.open) return;
    state.cmd.open = false;
    setOpen(el.cmdPanel, false);
    el.askInput.setAttribute('aria-expanded', 'false');
  }

  function ask(question) {
    const q = String(question || '').trim().slice(0, 500);
    if (!q) { el.askInput.focus(); return; }
    if (state.cmd.status === 'loading') return;
    Object.assign(state.cmd, { status: 'loading', question: q, data: null, error: '' });
    openCmd();
    renderCmd();
    api('/api/ask', { json: { question: q } }).then((data) => {
      if (state.cmd.question !== q) return;
      Object.assign(state.cmd, { status: 'answer', data });
      renderCmd();
      pollActivity();
    }).catch((err) => {
      Object.assign(state.cmd, { status: 'error', error: err.message });
      renderCmd();
    });
  }

  /* ───────────────────────── Upload + samples ───────────────────────── */

  function uploadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length || state.uploading) return;
    state.uploading = true;
    setBusy(el.btnUpload, true, 'Uploading…');

    const batches = [];
    for (let i = 0; i < files.length; i += MAX_UPLOAD_BATCH) batches.push(files.slice(i, i + MAX_UPLOAD_BATCH));
    let uploaded = [];
    let problems = [];
    let fatal = null;
    let chain = Promise.resolve();
    batches.forEach((batch) => {
      chain = chain.then(() => {
        const fd = new FormData();
        batch.forEach((f) => fd.append('files', f, f.name));
        return api('/api/upload', { method: 'POST', body: fd }).then((data) => {
          uploaded = uploaded.concat((data && data.files) || []);
          problems = problems.concat((data && data.errors) || []);
        }, (err) => {
          const errs = err.data && Array.isArray(err.data.errors) ? err.data.errors : [];
          if (errs.length) problems = problems.concat(errs); else fatal = fatal || err.message;
        });
      });
    });

    chain.then(() => {
      const details = problems.map((p) => (p.name || 'File') + ': ' + (p.error || 'failed'));
      if (uploaded.length) {
        toast(problems.length || fatal ? 'info' : 'success', 'Uploaded ' + plural(uploaded.length, 'file'),
          (fatal ? details.concat([fatal]) : details).concat(problems.length ? [] : ['The Organizer is filing them now.']));
      } else if (details.length === 1 && !fatal) {
        toast('error', "Couldn't upload " + (problems[0].name || 'that file'), [problems[0].error || 'failed']);
      } else {
        toast('error', fatal || 'No files were uploaded.', details);
      }
      return Promise.all([loadFiles(), pollActivity()]).then(() => { if (uploaded.length === 1) openDrawer(uploaded[0].id); });
    }).catch((err) => {
      toast('error', err.message);
    }).then(() => {
      state.uploading = false;
      setBusy(el.btnUpload, false);
      el.fileInput.value = '';
    });
  }

  let samplesBusy = false;
  function loadSamples(button) {
    if (samplesBusy) return;
    samplesBusy = true;
    const btn = button || el.btnSamples;
    setBusy(btn, true, 'Loading samples…');
    api('/api/samples', { method: 'POST' }).then((data) => {
      const loaded = (data && data.loaded) || [];
      const skipped = (data && data.skipped) || [];
      if (loaded.length) toast('success', 'Loaded ' + plural(loaded.length, 'sample file'), ['Open Agent activity to see what the agents did.']);
      else if (skipped.length) toast('info', 'The sample files are already in your drive');
      else toast('info', 'No sample files were found');
      state.view = 'all';
      state.topic = null;
      return Promise.all([loadFiles(), pollActivity()]);
    }).catch((err) => {
      toast('error', "Couldn't load the samples", [err.message]);
    }).then(() => {
      samplesBusy = false;
      if (btn.isConnected) setBusy(btn, false);
    });
  }

  /* ───────────────────────── Automations ───────────────────────── */

  const RULE_ICON = { 'invoice-to-csv': 'data', 'meeting-action-items': 'meeting' };

  function renderRules() {
    const on = state.rules.filter((r) => r.enabled).length;
    el.autoCount.textContent = state.rules.length ? on + ' on' : '';
    if (state.rulesError) {
      el.ruleList.innerHTML = '<li class="act-empty">' + escapeHtml("Couldn't load automations: " + state.rulesError) + '</li>';
      return;
    }
    if (!state.rules.length) {
      el.ruleList.innerHTML = '<li class="act-empty">No automations are set up.</li>';
      return;
    }
    el.ruleList.innerHTML = state.rules.map((r) => {
      const inputId = 'rule-' + String(r.id).replace(/[^\w-]/g, '_');
      const k = kindOf(RULE_ICON[r.id] || 'other');
      return '<li><label class="rule' + (r.enabled ? '' : ' is-off') + '" for="' + escapeHtml(inputId) + '">' +
        '<span class="kind-tile k-' + escapeHtml(k) + '">' + icon(k) + '</span>' +
        '<span><span class="rule-name">' + escapeHtml(r.name) + '</span>' +
        '<span class="rule-desc" id="' + escapeHtml(inputId + '-desc') + '">' + escapeHtml(r.description) + '</span></span>' +
        '<input type="checkbox" role="switch" class="switch" id="' + escapeHtml(inputId) + '" data-rule-id="' + escapeHtml(r.id) + '"' +
        (r.enabled ? ' checked' : '') + ' aria-describedby="' + escapeHtml(inputId + '-desc') + '">' +
      '</label></li>';
    }).join('');
  }

  function loadRules() {
    return api('/api/automations').then((data) => {
      state.rules = (data && data.rules) || [];
      state.rulesError = '';
      renderRules();
    }, (err) => {
      state.rulesError = err.message;
      renderRules();
    });
  }

  function setRule(input) {
    const id = input.getAttribute('data-rule-id');
    const enabled = input.checked;
    input.disabled = true;
    api('/api/automations/' + encodeURIComponent(id), { method: 'PUT', json: { enabled } }).then((rule) => {
      state.rules = state.rules.map((r) => (r.id === id ? rule : r));
      renderRules();
      const again = el.ruleList.querySelector('[data-rule-id="' + cssEscape(id) + '"]');
      if (again) again.focus({ preventScroll: true });
      toast('success', (rule.enabled ? 'Turned on: ' : 'Turned off: ') + rule.name);
      pollActivity();
    }).catch((err) => {
      input.checked = !enabled;
      input.disabled = false;
      toast('error', "Couldn't change that automation", [err.message]);
    });
  }

  /* ───────────────────────── Panels (automations / activity) + mobile nav ───────────────────────── */

  const panels = {
    auto: { node: () => el.autoPanel, btn: () => el.btnAuto },
    activity: { node: () => el.activityPanel, btn: () => el.btnActivity },
  };

  function isPanelOpen(name) { return panels[name].node().dataset.open === 'true'; }

  function togglePanel(name, force) {
    const p = panels[name];
    const open = typeof force === 'boolean' ? force : !isPanelOpen(name);
    if (open === isPanelOpen(name)) return;
    if (open && isNarrow()) {
      toggleNav(false);
      Object.keys(panels).forEach((other) => { if (other !== name) togglePanel(other, false); });
    }
    setOpen(p.node(), open);
    p.btn().setAttribute('aria-expanded', open ? 'true' : 'false');
    el.panelScrim.classList.toggle('is-open', isPanelOpen('auto') || isPanelOpen('activity'));
    if (name === 'activity' && open) markActivitySeen();
    if (open) {
      const first = p.node().querySelector(name === 'auto' ? '.switch' : '.icon-btn');
      if (first) setTimeout(() => first.focus({ preventScroll: true }), 30);
    }
  }

  function toggleNav(force) {
    const open = typeof force === 'boolean' ? force : !el.sidebar.classList.contains('is-open');
    el.sidebar.classList.toggle('is-open', open);
    el.navScrim.classList.toggle('is-open', open);
    el.btnMenu.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      const cur = el.sidebar.querySelector('[aria-current="page"]');
      if (cur) cur.focus({ preventScroll: true });
    }
  }

  /* ───────────────────────── Activity feed + polling ───────────────────────── */

  function renderActivity() {
    if (!state.activity.length) {
      el.activityList.innerHTML = '<li class="act-empty">No agent activity yet. Upload a file and watch the agents work.</li>';
      return;
    }
    el.activityList.innerHTML = state.activity.map((a) =>
      '<li class="act ' + escapeHtml(agentClass(a.agent)) + (state.freshActivity.has(a.id) ? ' is-new' : '') + '">' +
        '<span class="act-dot" aria-hidden="true"></span>' +
        '<div><div class="act-head"><span class="act-agent">' + escapeHtml(a.agent || 'Drive') + '</span>' +
        '<time class="act-time" datetime="' + escapeHtml(a.at) + '" title="' + escapeHtml(fullDate(a.at)) + '">' + escapeHtml(clockOrDate(a.at)) + '</time></div>' +
        '<p class="act-msg">' + escapeHtml(a.message) + '</p></div>' +
      '</li>').join('');
    state.freshActivity = new Set();
  }

  function renderUnread() {
    let n = 0;
    if (state.seenActivityId) {
      for (const a of state.activity) { if (a.id === state.seenActivityId) break; n++; }
    }
    el.unread.hidden = n === 0;
    el.btnMenu.classList.toggle('has-unread', n > 0);
    el.unread.textContent = n > 99 ? '99+' : String(n);
    el.btnActivity.setAttribute('aria-label', 'Agent activity' + (n ? ', ' + n + ' new' : ''));
  }

  function markActivitySeen() {
    state.seenActivityId = state.newestActivityId;
    renderUnread();
  }

  /**
   * Fetches the activity feed. If the newest entry changed since the last
   * poll, an agent did something — re-fetch the file list too.
   */
  function pollActivity() {
    if (state.polling) return Promise.resolve();
    state.polling = true;
    return api('/api/activity').then((data) => {
      const list = (data && data.activity) || [];
      const newest = list.length ? list[0].id : null;
      const hadPrevious = state.activityLoaded;
      const changed = newest !== state.newestActivityId || !hadPrevious;
      if (hadPrevious) {
        const prev = new Set(state.activity.map((a) => a.id));
        list.forEach((a) => { if (!prev.has(a.id)) state.freshActivity.add(a.id); });
      }
      const previousNewest = state.newestActivityId;
      state.activity = list;
      state.newestActivityId = newest;
      state.activityLoaded = true;
      if (!hadPrevious) state.seenActivityId = newest; // don't greet people with 37 "unread"
      if (isPanelOpen('activity')) state.seenActivityId = newest;
      if (changed) renderActivity();
      renderUnread();
      if (hadPrevious && newest !== previousNewest) return loadFiles();
    }).catch(() => {
      /* transient network error — try again on the next tick */
    }).then(() => {
      state.polling = false;
    });
  }

  function startPolling() {
    setInterval(() => { if (!document.hidden) pollActivity(); }, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollActivity(); });
    // Keep "2m ago" honest without re-rendering rows.
    setInterval(() => {
      document.querySelectorAll('[data-time]').forEach((t) => { t.textContent = relTime(t.getAttribute('data-time')); });
    }, 30000);
  }

  /* ───────────────────────── Layout persistence ───────────────────────── */

  function loadLayout() {
    try {
      const v = window.localStorage.getItem(LAYOUT_KEY);
      if (v === 'grid' || v === 'list') state.layout = v;
    } catch (e) { /* storage blocked — default to list */ }
  }
  function setLayout(v) {
    if (state.layout === v) return;
    state.layout = v;
    try { window.localStorage.setItem(LAYOUT_KEY, v); } catch (e) { /* ignore */ }
    renderMain();
  }

  /* ───────────────────────── Event wiring ───────────────────────── */

  function wire() {
    el.cmdKbd.textContent = IS_MAC ? '⌘K' : 'Ctrl K';
    el.btnUpload.addEventListener('click', () => el.fileInput.click());
    el.fileInput.addEventListener('change', () => uploadFiles(el.fileInput.files));
    el.btnSamples.addEventListener('click', () => loadSamples(el.btnSamples));
    el.btnMenu.addEventListener('click', () => toggleNav());
    $('btn-nav-close').addEventListener('click', () => { toggleNav(false); el.btnMenu.focus(); });
    el.navScrim.addEventListener('click', () => toggleNav(false));
    el.drawerScrim.addEventListener('click', () => closeDrawer(true));
    el.panelScrim.addEventListener('click', () => { togglePanel('auto', false); togglePanel('activity', false); });

    // Sidebar
    el.sidebar.addEventListener('click', (e) => {
      const v = e.target.closest('[data-view]');
      if (v) { setView(v.getAttribute('data-view')); return; }
      const t = e.target.closest('[data-topic]');
      if (t) {
        const topic = t.getAttribute('data-topic');
        state.topic = state.topic === topic ? null : topic;
        renderSidebar();
        renderMain();
        if (isNarrow()) toggleNav(false);
      }
    });
    el.btnAuto.addEventListener('click', () => togglePanel('auto'));
    el.btnActivity.addEventListener('click', () => togglePanel('activity'));
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => {
      const name = b.getAttribute('data-close');
      togglePanel(name, false);
      panels[name].btn().focus({ preventScroll: true });
    }));
    el.ruleList.addEventListener('change', (e) => { if (e.target.matches('.switch')) setRule(e.target); });

    // Header
    el.topicFilter.addEventListener('click', (e) => {
      if (e.target.closest('[data-clear-topic]')) { state.topic = null; renderSidebar(); renderMain(); }
    });
    el.filter.addEventListener('input', () => { state.filter = el.filter.value; renderMain(); });
    el.filter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && el.filter.value) { e.stopPropagation(); el.filter.value = ''; state.filter = ''; renderMain(); }
    });
    el.layoutList.addEventListener('click', () => setLayout('list'));
    el.layoutGrid.addEventListener('click', () => setLayout('grid'));

    // File area
    el.files.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]');
      if (action) {
        const a = action.getAttribute('data-action');
        if (a === 'upload') el.fileInput.click();
        else if (a === 'samples') loadSamples(action);
        else if (a === 'clear-filter') { el.filter.value = ''; state.filter = ''; renderMain(); el.filter.focus(); }
        else if (a === 'clear-topic') { state.topic = null; renderSidebar(); renderMain(); }
        else if (a === 'retry') { state.filesLoaded = false; state.filesError = null; renderMain(); loadFiles().catch(() => {}); }
        return;
      }
      const sort = e.target.closest('[data-sort]');
      if (sort) {
        const key = sort.getAttribute('data-sort');
        if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
        else state.sort = { key, dir: key === 'updated' || key === 'size' ? 'desc' : 'asc' };
        renderMain();
        return;
      }
      const more = e.target.closest('[data-more]');
      if (more) {
        e.stopPropagation();
        if (menu.anchor === more) closeMenu(false); else openRowMenu(more, more.getAttribute('data-more'));
        return;
      }
      const sel = e.target.closest('[data-select]');
      if (sel) {
        toggleSelected(sel.getAttribute('data-select'), sel.checked, e.shiftKey);
        return;
      }
      const all = e.target.closest('[data-select-all]');
      if (all) {
        const rows = visibleFiles();
        const on = all.checked;
        rows.forEach((f) => { if (on) state.selected.add(f.id); else state.selected.delete(f.id); });
        renderMain();
        renderSelbar();
        return;
      }
      const open = e.target.closest('[data-open]');
      if (open) {
        const id = open.getAttribute('data-open');
        if (e.metaKey || e.ctrlKey) { toggleSelected(id, !state.selected.has(id), false); return; }
        if (e.shiftKey && state.anchorId) { toggleSelected(id, true, true); return; }
        openDrawer(id);
      }
    });

    // Drawer
    el.drawer.addEventListener('click', onDrawerClick);

    // Selection bar
    el.selbar.addEventListener('click', (e) => {
      if (e.target.closest('[data-clear-selection]')) { clearSelection(); return; }
      const c = e.target.closest('[data-combine]');
      if (c && c.getAttribute('aria-disabled') !== 'true') combine(c.getAttribute('data-combine'));
    });

    // Menu
    el.menu.addEventListener('click', onMenuClick);
    el.menu.addEventListener('keydown', onMenuKey);

    // Command bar
    el.askForm.addEventListener('submit', (e) => { e.preventDefault(); ask(el.askInput.value); });
    el.askInput.addEventListener('focus', openCmd);
    el.askInput.addEventListener('click', openCmd);
    el.askInput.addEventListener('input', () => {
      if (!el.askInput.value.trim() && state.cmd.status !== 'loading') { state.cmd.status = 'idle'; state.cmd.data = null; renderCmd(); }
      openCmd();
    });
    el.askInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCmd(); el.askInput.blur(); }
      else if (e.key === 'ArrowDown' && state.cmd.open) {
        const first = el.cmdBody.querySelector('button');
        if (first) { e.preventDefault(); first.focus(); }
      }
    });
    el.cmdPanel.addEventListener('keydown', (e) => {
      const btns = Array.from(el.cmdBody.querySelectorAll('button'));
      const i = btns.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCmd(); el.askInput.focus(); el.askInput.blur(); }
      else if (e.key === 'ArrowDown' && i >= 0) { e.preventDefault(); (btns[i + 1] || btns[0]).focus(); }
      else if (e.key === 'ArrowUp' && i >= 0) { e.preventDefault(); if (i === 0) el.askInput.focus(); else btns[i - 1].focus(); }
    });
    el.cmdBody.addEventListener('click', (e) => {
      const ex = e.target.closest('[data-question]');
      if (ex) { el.askInput.value = ex.getAttribute('data-question'); ask(el.askInput.value); return; }
      if (e.target.closest('[data-retry-ask]')) { ask(state.cmd.question); return; }
      const src = e.target.closest('[data-file-id]');
      if (src) { closeCmd(); openDrawer(src.getAttribute('data-file-id')); }
    });

    // Outside clicks close popovers
    document.addEventListener('pointerdown', (e) => {
      if (menu.anchor && !el.menu.contains(e.target) && !menu.anchor.contains(e.target)) closeMenu(false);
      if (state.cmd.open && !el.cmd.contains(e.target)) closeCmd();
      if (isPanelOpen('auto') && !el.autoPanel.contains(e.target) && !el.btnAuto.contains(e.target)) togglePanel('auto', false);
    });
    window.addEventListener('resize', () => closeMenu(false));
    el.files.addEventListener('scroll', () => closeMenu(false), { passive: true });

    // Global keys
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        el.askInput.focus();
        el.askInput.select();
        openCmd();
        return;
      }
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (menu.anchor) { closeMenu(true); return; }
      if (state.cmd.open) { closeCmd(); return; }
      if (isPanelOpen('auto')) { togglePanel('auto', false); el.btnAuto.focus(); return; }
      if (state.drawer.id) { closeDrawer(true); return; }
      if (el.sidebar.classList.contains('is-open')) { toggleNav(false); el.btnMenu.focus(); return; }
      if (isPanelOpen('activity')) { togglePanel('activity', false); return; }
      if (state.selected.size) clearSelection();
    });

    wireDragAndDrop();
  }

  function wireDragAndDrop() {
    let depth = 0;
    const hasFiles = (e) => {
      const types = e.dataTransfer && e.dataTransfer.types;
      return !!types && Array.prototype.indexOf.call(types, 'Files') >= 0;
    };
    const show = (on) => { el.dropOverlay.dataset.open = on ? 'true' : 'false'; };
    const hide = () => { depth = 0; show(false); };

    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      show(true);
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0 || (e.relatedTarget === null && e.clientX <= 0 && e.clientY <= 0)) hide();
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      hide();
      uploadFiles(e.dataTransfer.files);
    });
    window.addEventListener('dragend', hide);
  }

  /* ───────────────────────── Boot ───────────────────────── */

  function init() {
    loadLayout();
    wire();
    renderSidebar();
    renderMain();
    renderSelbar();
    renderCmd();
    loadStatus();
    loadRules();
    loadMeta().then(() => loadFiles()).catch(() => { /* error state already rendered */ });
    pollActivity();
    startPolling();
  }

  init();
})();
