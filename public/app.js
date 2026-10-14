/**
 * Agentic Drive — browser UI (plain script, no modules, no libraries).
 *
 * IN SIMPLE WORDS:
 * This file is the whole front end. It asks the server for your files, shows
 * them in folders, lets you upload/drag-drop files, and gives you the three
 * agent tools (Ask, Synthesize, Automations). Every 3 seconds it checks the
 * activity feed so files that agents create in the background just appear.
 *
 * DO NOT: insert unescaped text. File names, file contents, answers, tags and
 * error messages all come from users or from an AI, so anything that goes into
 * innerHTML must pass through escapeHtml() first (or be a constant written in
 * this file). A file named `<img src=x onerror=alert(1)>.txt` must show up as
 * text, never run. The Markdown/CSV renderers escape FIRST and format after.
 */
(function () {
  'use strict';

  /* ───────────────────────── Constants ───────────────────────── */

  var POLL_MS = 3000;
  var MAX_UPLOAD_BATCH = 20; // server limit per request
  var MAX_TABLE_ROWS = 500;
  var MAX_TAGS = 4;
  var GENERATED_FOLDER = 'Generated';
  var EMPTY_DRIVE_TEXT = 'Your drive is empty. Upload files or load the samples to see the agents work.';
  var KNOWN_TYPES = ['invoice', 'meeting', 'data', 'report'];
  var KNOWN_AGENTS = ['organizer', 'search', 'synthesizer', 'automations', 'drive'];
  var PROVIDER_LABELS = { gemini: 'Gemini', claude: 'Claude' };

  // Inline SVG icons (constants — safe to put into innerHTML).
  var ICONS = {
    folder: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7a2 2 0 0 1 2-2h3.5l2 2H18a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>',
    stack: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4"/><path d="M4 16l8 4 8-4"/></svg>',
    trash: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>',
    download: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v12m0 0l-5-5m5 5l5-5M4 20h16"/></svg>',
    close: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    check: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    alert: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v6M12 17h.01"/></svg>',
    info: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 11v6M12 7h.01"/></svg>',
    spark: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2 6.2L20.5 11 14 13 12 19.5 10 13 3.5 11 10 9.2z"/></svg>',
    upload: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0l-5 5m5-5l5 5M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
    search: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>',
  };

  /* ───────────────────────── Escaping ───────────────────────── */

  var ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  /** The ONE escaping helper. Use it for every interpolated value in HTML strings. */
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) { return ESCAPES[ch]; });
  }

  /* ───────────────────────── API helper ───────────────────────── */

  /**
   * fetch() wrapper. Sends `json` as a JSON body, parses the JSON reply, and
   * throws an Error carrying the server's `{error}` message on any non-2xx.
   * The parsed body is attached as `err.data` (upload errors list lives there).
   */
  function api(path, options) {
    var opts = options || {};
    var init = { method: opts.method || 'GET', headers: {} };
    if (opts.json !== undefined) {
      init.method = opts.method || 'POST';
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.json);
    } else if (opts.body !== undefined) {
      init.body = opts.body;
    }
    return fetch(path, init).then(
      function (res) {
        return res.text().then(function (raw) {
          var data = null;
          try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
          if (!res.ok) {
            var message = data && typeof data.error === 'string' && data.error
              ? data.error
              : 'Request failed (' + res.status + ').';
            var err = new Error(message);
            err.status = res.status;
            err.data = data;
            throw err;
          }
          return data;
        });
      },
      function () {
        var err = new Error("Can't reach the server. Is it running?");
        err.status = 0;
        throw err;
      }
    );
  }

  /* ───────────────────────── State ───────────────────────── */

  var state = {
    files: [],
    filesLoaded: false,
    folder: null,          // null = "All files"
    filter: '',
    selected: new Set(),   // file ids ticked for synthesis
    viewerId: null,
    viewerToken: 0,
    rules: [],
    activity: [],
    newestActivityId: null,
    activityLoaded: false,
    polling: false,
    asking: false,
    synthesizing: false,
  };

  /* ───────────────────────── DOM refs ───────────────────────── */

  function $(id) { return document.getElementById(id); }
  var el = {
    status: $('ai-status'),
    btnUpload: $('btn-upload'),
    fileInput: $('file-input'),
    btnSamples: $('btn-samples'),
    dropOverlay: $('drop-overlay'),
    folderList: $('folder-list'),
    fileList: $('file-list'),
    filesHeading: $('files-heading'),
    filesCount: $('files-count'),
    filesCol: document.querySelector('.col-files'),
    filter: $('filter'),
    viewer: $('viewer'),
    askForm: $('ask-form'),
    askInput: $('ask-input'),
    askAnswer: $('ask-answer'),
    btnAsk: $('btn-ask'),
    synthCount: $('synth-count'),
    synthChips: $('synth-chips'),
    synthFormat: $('synth-format'),
    btnSynth: $('btn-synth'),
    btnClearSel: $('btn-clear-selection'),
    ruleList: $('rule-list'),
    activityList: $('activity-list'),
    toasts: $('toasts'),
  };

  /* ───────────────────────── Small helpers ───────────────────────── */

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function formatSize(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function formatClock(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '--:--:--';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function formatDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function extOf(file) {
    if (file.ext) return String(file.ext).toLowerCase();
    var m = /\.[^.]+$/.exec(file.name || '');
    return m ? m[0].toLowerCase() : '';
  }

  function typeClass(type) { return KNOWN_TYPES.indexOf(type) >= 0 ? type : 'other'; }

  function agentClass(agent) {
    var a = String(agent || '').toLowerCase();
    return KNOWN_AGENTS.indexOf(a) >= 0 ? a : 'other';
  }

  function findFile(id) {
    for (var i = 0; i < state.files.length; i++) if (state.files[i].id === id) return state.files[i];
    return null;
  }

  function setBusy(button, busy, busyLabel) {
    var label = button.querySelector('.btn-label');
    if (busy) {
      if (label && !button.dataset.label) button.dataset.label = label.textContent;
      if (label && busyLabel) label.textContent = busyLabel;
      button.classList.add('is-busy');
      button.setAttribute('aria-busy', 'true');
      button.disabled = true;
    } else {
      if (label && button.dataset.label) label.textContent = button.dataset.label;
      delete button.dataset.label;
      button.classList.remove('is-busy');
      button.removeAttribute('aria-busy');
      button.disabled = false;
    }
  }

  /* ───────────────────────── Toasts ───────────────────────── */

  /**
   * toast(kind, title, details?) — kind is success | error | info.
   * `details` is an optional array of plain strings shown as a list.
   */
  function toast(kind, title, details) {
    var node = document.createElement('div');
    node.className = 'toast toast-' + kind;
    node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    var icon = kind === 'success' ? ICONS.check : kind === 'error' ? ICONS.alert : ICONS.info;
    var list = details && details.length
      ? '<ul class="toast-list">' + details.map(function (d) { return '<li>' + escapeHtml(d) + '</li>'; }).join('') + '</ul>'
      : '';
    node.innerHTML =
      '<span class="toast-icon">' + icon + '</span>' +
      '<div class="toast-body"><p class="toast-title">' + escapeHtml(title) + '</p>' + list + '</div>' +
      '<button type="button" class="toast-close" aria-label="Dismiss">' + ICONS.close + '</button>';
    var timer = null;
    function dismiss() {
      if (!node.isConnected || node.classList.contains('is-leaving')) return;
      clearTimeout(timer);
      node.classList.add('is-leaving');
      setTimeout(function () { node.remove(); }, 200);
    }
    function arm() { timer = setTimeout(dismiss, kind === 'error' || (details && details.length) ? 8000 : 4500); }
    node.querySelector('.toast-close').addEventListener('click', dismiss);
    node.addEventListener('mouseenter', function () { clearTimeout(timer); });
    node.addEventListener('mouseleave', arm);
    el.toasts.appendChild(node);
    while (el.toasts.children.length > 4) el.toasts.firstElementChild.remove();
    arm();
  }

  /* ───────────────────────── Status pill ───────────────────────── */

  function renderStatus(status) {
    var label = el.status.querySelector('.pill-label');
    if (status && status.aiProvider) {
      var name = PROVIDER_LABELS[status.aiProvider] || status.aiProvider;
      label.textContent = status.model ? name + ' · ' + status.model : name;
      el.status.className = 'pill pill-ai';
      el.status.title = 'Agents use ' + name + ', with offline rules as a fallback.';
    } else {
      label.textContent = 'Offline agents';
      el.status.className = 'pill pill-muted';
      el.status.title = status === null
        ? 'Could not reach the server.'
        : 'No AI key set — the agents run on built-in offline rules.';
    }
  }

  function loadStatus() {
    return api('/api/status').then(renderStatus, function () { renderStatus(null); });
  }

  /* ───────────────────────── Files & folders ───────────────────────── */

  function sortNewestFirst(files) {
    return files
      .map(function (f, i) { return { f: f, i: i }; })
      .sort(function (a, b) {
        var ta = String(a.f.createdAt || '');
        var tb = String(b.f.createdAt || '');
        if (ta !== tb) return ta < tb ? 1 : -1;
        return b.i - a.i; // later insertions first on ties
      })
      .map(function (x) { return x.f; });
  }

  function loadFiles() {
    return api('/api/files').then(function (data) {
      state.files = sortNewestFirst((data && data.files) || []);
      state.filesLoaded = true;
      // Drop selections / folder / viewer that point at files that no longer exist.
      state.selected.forEach(function (id) { if (!findFile(id)) state.selected.delete(id); });
      if (state.folder && !state.files.some(function (f) { return f.folder === state.folder; })) state.folder = null;
      if (state.viewerId && !findFile(state.viewerId)) closeViewer();
      renderFolders();
      renderFiles();
      renderSynth();
    });
  }

  function folderNames() {
    var counts = {};
    state.files.forEach(function (f) {
      var name = f.folder || 'General';
      counts[name] = (counts[name] || 0) + 1;
    });
    var names = Object.keys(counts).sort(function (a, b) {
      if (a === GENERATED_FOLDER) return 1;
      if (b === GENERATED_FOLDER) return -1;
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });
    return { names: names, counts: counts };
  }

  function folderButton(value, label, count, icon) {
    var active = (state.folder || '') === value;
    return '<li><button type="button" class="folder' + (active ? ' is-active' : '') + '" data-folder="' + escapeHtml(value) + '"' +
      (active ? ' aria-current="true"' : '') + '>' + icon +
      '<span class="folder-name">' + escapeHtml(label) + '</span>' +
      '<span class="folder-count">' + escapeHtml(count) + '</span></button></li>';
  }

  function renderFolders() {
    var info = folderNames();
    var html = folderButton('', 'All files', state.files.length, ICONS.stack);
    info.names.forEach(function (name) {
      html += folderButton(name, name, info.counts[name], name === GENERATED_FOLDER ? ICONS.spark : ICONS.folder);
    });
    el.folderList.innerHTML = html;
  }

  function visibleFiles() {
    var q = state.filter.trim().toLowerCase();
    return state.files.filter(function (f) {
      if (state.folder && f.folder !== state.folder) return false;
      if (!q) return true;
      var hay = [f.name, f.summary].concat(f.tags || []).join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function typeBadge(type) {
    if (!type) return '';
    return '<span class="badge badge-' + escapeHtml(typeClass(type)) + '">' + escapeHtml(type) + '</span>';
  }

  function tagChips(tags, limit) {
    return (tags || []).slice(0, limit).map(function (t) {
      return '<span class="tag">' + escapeHtml(t) + '</span>';
    }).join('');
  }

  function fileRow(f) {
    var selected = state.selected.has(f.id);
    var open = state.viewerId === f.id;
    var ext = extOf(f).replace('.', '') || 'file';
    var summary = f.summary || '';
    return '<li class="file-row' + (selected ? ' is-selected' : '') + (open ? ' is-open' : '') + '" data-id="' + escapeHtml(f.id) + '">' +
      '<label class="file-check" title="Select for Synthesize">' +
        '<input type="checkbox" class="file-select" data-id="' + escapeHtml(f.id) + '"' + (selected ? ' checked' : '') +
        ' aria-label="Select ' + escapeHtml(f.name) + ' for synthesis"></label>' +
      '<span class="file-icon type-' + escapeHtml(typeClass(f.type)) + '" aria-hidden="true">' + escapeHtml(ext.slice(0, 4)) + '</span>' +
      '<div class="file-main">' +
        '<div class="file-line">' +
          '<button type="button" class="file-open" data-id="' + escapeHtml(f.id) + '">' + escapeHtml(f.name) + '</button>' +
          typeBadge(f.type) +
          (f.generated ? '<span class="badge badge-generated">' + ICONS.spark + 'generated</span>' : '') +
        '</div>' +
        (summary ? '<p class="file-summary" title="' + escapeHtml(summary) + '">' + escapeHtml(summary) + '</p>' : '') +
        '<div class="file-meta">' +
          (!state.folder ? '<span class="file-folder">' + ICONS.folder + escapeHtml(f.folder || 'General') + '</span>' : '') +
          tagChips(f.tags, MAX_TAGS) +
        '</div>' +
      '</div>' +
      '<div class="file-actions">' +
        '<button type="button" class="icon-btn danger file-delete" data-id="' + escapeHtml(f.id) + '" aria-label="Delete ' + escapeHtml(f.name) + '" title="Delete">' + ICONS.trash + '</button>' +
      '</div>' +
    '</li>';
  }

  function renderFiles() {
    el.filesHeading.textContent = state.folder || 'All files';
    if (!state.filesLoaded) {
      el.filesCount.textContent = '';
      el.fileList.innerHTML = '<li class="viewer-loading"><span class="spinner"></span>Loading your files…</li>';
      return;
    }
    if (state.files.length === 0) {
      el.filesCount.textContent = '';
      el.fileList.innerHTML =
        '<li class="empty">' +
          '<span class="empty-art">' + ICONS.upload + '</span>' +
          '<p class="empty-title">' + escapeHtml(EMPTY_DRIVE_TEXT) + '</p>' +
          '<p class="empty-text">Drop .txt, .md, .csv or .pdf files anywhere on this page. The Organizer files them, and Automations act on invoices and meeting notes.</p>' +
          '<div class="empty-actions">' +
            '<button type="button" class="btn btn-primary" data-action="upload">' + ICONS.upload + '<span>Upload files</span></button>' +
            '<button type="button" class="btn btn-secondary" data-action="samples">' + ICONS.folder + '<span>Load sample files</span></button>' +
          '</div>' +
        '</li>';
      return;
    }
    var rows = visibleFiles();
    var scopeCount = state.folder ? folderNames().counts[state.folder] || 0 : state.files.length;
    el.filesCount.textContent = state.filter.trim()
      ? rows.length + ' of ' + plural(scopeCount, 'file')
      : plural(rows.length, 'file');
    if (rows.length === 0) {
      el.fileList.innerHTML =
        '<li class="empty empty-small">' +
          '<span class="empty-art">' + ICONS.search + '</span>' +
          '<p class="empty-title">No files match “' + escapeHtml(state.filter.trim()) + '”</p>' +
          '<p class="empty-text">Try a different word, or clear the filter.</p>' +
        '</li>';
      return;
    }
    el.fileList.innerHTML = rows.map(fileRow).join('');
  }

  /* ───────────────────────── Upload ───────────────────────── */

  var uploading = false;

  function uploadFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length || uploading) return;
    uploading = true;
    setBusy(el.btnUpload, true, 'Uploading…');

    var batches = [];
    for (var i = 0; i < files.length; i += MAX_UPLOAD_BATCH) batches.push(files.slice(i, i + MAX_UPLOAD_BATCH));

    var uploaded = [];
    var problems = [];
    var fatal = null;

    var chain = Promise.resolve();
    batches.forEach(function (batch) {
      chain = chain.then(function () {
        var fd = new FormData();
        batch.forEach(function (f) { fd.append('files', f, f.name); });
        return api('/api/upload', { method: 'POST', body: fd }).then(function (data) {
          uploaded = uploaded.concat((data && data.files) || []);
          problems = problems.concat((data && data.errors) || []);
        }, function (err) {
          var errs = err.data && Array.isArray(err.data.errors) ? err.data.errors : [];
          if (errs.length) problems = problems.concat(errs);
          else fatal = fatal || err.message;
        });
      });
    });

    chain.then(function () {
      var details = problems.map(function (p) { return (p.name || 'File') + ': ' + (p.error || 'failed'); });
      if (uploaded.length) {
        toast(problems.length || fatal ? 'info' : 'success', 'Uploaded ' + plural(uploaded.length, 'file'), fatal ? details.concat([fatal]) : details);
      } else if (details.length === 1 && !fatal) {
        toast('error', details[0]);
      } else {
        toast('error', fatal || 'No files were uploaded.', details);
      }
      return Promise.all([loadFiles(), pollActivity()]).then(function () {
        if (uploaded.length === 1) openViewer(uploaded[0].id);
      });
    }).catch(function (err) {
      toast('error', err.message);
    }).then(function () {
      uploading = false;
      setBusy(el.btnUpload, false);
      el.fileInput.value = '';
    });
  }

  function loadSamples() {
    if (el.btnSamples.disabled) return;
    setBusy(el.btnSamples, true, 'Loading samples…');
    api('/api/samples', { method: 'POST' }).then(function (data) {
      var loaded = (data && data.loaded) || [];
      var skipped = (data && data.skipped) || [];
      if (loaded.length) toast('success', 'Loaded ' + plural(loaded.length, 'sample file'), ['Watch the activity feed to see what the agents did.']);
      else if (skipped.length) toast('info', 'Sample files are already in your drive');
      else toast('info', 'No sample files were found');
      state.folder = null;
      return Promise.all([loadFiles(), pollActivity()]);
    }).catch(function (err) {
      toast('error', err.message);
    }).then(function () {
      setBusy(el.btnSamples, false);
    });
  }

  /* ───────────────────────── Delete ───────────────────────── */

  function deleteFile(id) {
    var f = findFile(id);
    var name = f ? f.name : 'File';
    var row = el.fileList.querySelector('.file-row[data-id="' + cssEscape(id) + '"]');
    if (row) row.style.opacity = '0.5';
    api('/api/files/' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {
      state.selected.delete(id);
      if (state.viewerId === id) closeViewer();
      toast('success', 'Deleted ' + name);
      return Promise.all([loadFiles(), pollActivity()]);
    }).catch(function (err) {
      if (row) row.style.opacity = '';
      toast('error', 'Could not delete ' + name + ': ' + err.message);
      if (err.status === 404) loadFiles();
    });
  }

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
  }

  /* ───────────────────────── CSV + Markdown renderers ───────────────────────── */

  /** RFC-4180-ish CSV parser: quoted fields, "" escapes, commas and newlines inside quotes. */
  function parseCsv(text) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    var s = String(text || '');
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
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
    return rows.filter(function (r) { return !(r.length === 1 && r[0] === ''); });
  }

  function renderCsvTable(text) {
    var rows = parseCsv(text);
    if (!rows.length) return '<p class="table-note">This CSV file is empty.</p>';
    var head = rows[0];
    var body = rows.slice(1, MAX_TABLE_ROWS + 1);
    var width = rows.reduce(function (w, r) { return Math.max(w, r.length); }, 0);
    function cells(r, tag) {
      var out = '';
      for (var i = 0; i < width; i++) out += '<' + tag + '>' + escapeHtml(r[i] == null ? '' : r[i]) + '</' + tag + '>';
      return out;
    }
    var html = '<div class="table-wrap"><table class="data-table"><thead><tr>' + cells(head, 'th') + '</tr></thead><tbody>' +
      body.map(function (r) { return '<tr>' + cells(r, 'td') + '</tr>'; }).join('') +
      '</tbody></table></div>';
    var total = rows.length - 1;
    html += '<p class="table-note">' + escapeHtml(plural(total, 'row')) +
      (total > MAX_TABLE_ROWS ? escapeHtml(' — showing the first ' + MAX_TABLE_ROWS) : '') + '</p>';
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
    var t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return t.split('|').map(function (c) { return c.trim(); });
  }

  /**
   * Tiny safe Markdown renderer. Each line is escaped FIRST, then block and
   * inline formatting is applied to the escaped text, so no raw HTML survives.
   */
  function renderMarkdown(text) {
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var para = [];
    var list = null; // { tag, cls, items: [] }
    var table = null; // rows of escaped cells

    function flushPara() {
      if (para.length) out.push('<p>' + para.join('<br>') + '</p>');
      para = [];
    }
    function flushList() {
      if (list) out.push('<' + list.tag + (list.cls ? ' class="' + list.cls + '"' : '') + '>' + list.items.join('') + '</' + list.tag + '>');
      list = null;
    }
    function flushTable() {
      if (table && table.length) {
        var head = table[0];
        var html = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
          head.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr></thead><tbody>' +
          table.slice(1).map(function (r) {
            var cellsHtml = '';
            for (var i = 0; i < head.length; i++) cellsHtml += '<td>' + (r[i] || '') + '</td>';
            return '<tr>' + cellsHtml + '</tr>';
          }).join('') + '</tbody></table></div>';
        out.push(html);
      }
      table = null;
    }
    function flushAll() { flushPara(); flushList(); flushTable(); }
    function pushItem(tag, cls, itemHtml) {
      flushPara(); flushTable();
      if (!list || list.tag !== tag || list.cls !== cls) { flushList(); list = { tag: tag, cls: cls, items: [] }; }
      list.items.push(itemHtml);
    }

    lines.forEach(function (rawLine) {
      var line = escapeHtml(rawLine); // escape first — everything below works on safe text
      var trimmed = line.trim();
      var m;

      if (!trimmed) { flushAll(); return; }

      if (/^\|.*\|$/.test(trimmed)) {
        flushPara(); flushList();
        var cells = splitTableRow(trimmed);
        if (cells.every(function (c) { return /^:?-{2,}:?$/.test(c); })) return; // separator row
        table = table || [];
        table.push(cells.map(mdInline));
        return;
      }
      if (table) flushTable();

      if ((m = /^(#{1,6})\s+(.*)$/.exec(trimmed))) {
        flushAll();
        var level = Math.min(m[1].length, 4);
        out.push('<h' + level + '>' + mdInline(m[2].replace(/\s#+$/, '')) + '</h' + level + '>');
        return;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flushAll(); out.push('<hr>'); return; }
      if ((m = /^[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(trimmed))) {
        var done = m[1] !== ' ';
        pushItem('ul', 'checklist', '<li' + (done ? ' class="done"' : '') + '><input type="checkbox" disabled' + (done ? ' checked' : '') +
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

  function renderBody(file) {
    var ext = extOf(file);
    var text = file.text || '';
    if (!text.trim()) return '<p class="table-note">(no readable text)</p>';
    if (ext === '.csv') return renderCsvTable(text);
    if (ext === '.md') return renderMarkdown(text);
    return '<pre class="plain-text">' + escapeHtml(text) + '</pre>';
  }

  /* ───────────────────────── Viewer ───────────────────────── */

  function viewerHead(f) {
    var downloadHref = '/api/files/' + encodeURIComponent(f.id) + '/download';
    var created = formatDate(f.createdAt);
    return '<header class="viewer-head">' +
      '<div class="viewer-top">' +
        '<h2 class="viewer-title" id="viewer-title">' + escapeHtml(f.name) + '</h2>' +
        '<div class="viewer-tools">' +
          '<a class="btn btn-secondary btn-small" href="' + escapeHtml(downloadHref) + '" download="' + escapeHtml(f.name) + '">' + ICONS.download + '<span>Download</span></a>' +
          '<button type="button" class="icon-btn viewer-close" aria-label="Close viewer" title="Close (Esc)">' + ICONS.close + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="viewer-meta">' +
        typeBadge(f.type) +
        (f.generated ? '<span class="badge badge-generated">' + ICONS.spark + 'generated</span>' : '') +
        '<span>' + escapeHtml(f.folder || 'General') + '</span><span class="sep" aria-hidden="true"></span>' +
        '<span>' + escapeHtml(formatSize(f.size)) + '</span>' +
        (created ? '<span class="sep" aria-hidden="true"></span><span>' + escapeHtml(created) + '</span>' : '') +
      '</div>' +
      (f.summary ? '<p class="viewer-summary"><span class="viewer-summary-label">Summary</span>' + escapeHtml(f.summary) + '</p>' : '') +
      ((f.tags && f.tags.length) ? '<div class="viewer-tags">' + tagChips(f.tags, 12) + '</div>' : '') +
    '</header>';
  }

  function openViewer(id) {
    if (!id) return;
    var token = ++state.viewerToken;
    var known = findFile(id);
    state.viewerId = id;
    el.viewer.hidden = false;
    el.filesCol.classList.add('has-viewer');
    el.viewer.setAttribute('aria-labelledby', 'viewer-title');
    el.viewer.innerHTML = (known ? viewerHead(known) : '') +
      '<div class="viewer-body"><div class="viewer-loading"><span class="spinner"></span>Opening file…</div></div>';
    markOpenRow();
    revealViewer();

    api('/api/files/' + encodeURIComponent(id)).then(function (file) {
      if (token !== state.viewerToken) return;
      el.viewer.innerHTML = viewerHead(file) + '<div class="viewer-body">' + renderBody(file) + '</div>';
    }).catch(function (err) {
      if (token !== state.viewerToken) return;
      toast('error', err.status === 404 ? 'That file no longer exists.' : err.message);
      closeViewer();
      if (err.status === 404) loadFiles();
    });
  }

  function revealViewer() {
    // On the stacked (mobile) layout the viewer sits below the list; bring it into view.
    if (window.matchMedia('(max-width: 999.98px)').matches) {
      var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.viewer.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    }
  }

  function closeViewer() {
    state.viewerToken++;
    state.viewerId = null;
    el.viewer.hidden = true;
    el.viewer.textContent = '';
    el.filesCol.classList.remove('has-viewer');
    markOpenRow();
  }

  function markOpenRow() {
    Array.prototype.forEach.call(el.fileList.querySelectorAll('.file-row'), function (row) {
      row.classList.toggle('is-open', row.getAttribute('data-id') === state.viewerId);
    });
  }

  /* ───────────────────────── Ask ───────────────────────── */

  function renderAnswer(question, data) {
    var citations = (data && data.citations) || [];
    var byN = {};
    citations.forEach(function (c) { byN[c.n] = c; });

    // Escape the whole answer first, then turn [n] markers into citation buttons.
    var paragraphs = String((data && data.answer) || '').split(/\n+/).filter(function (p) { return p.trim(); });
    var answerHtml = paragraphs.map(function (p) {
      var safe = escapeHtml(p).replace(/\[(\d+)\]/g, function (match, n) {
        var c = byN[n];
        if (!c) return match;
        return '<button type="button" class="cite" data-file-id="' + escapeHtml(c.fileId) + '" title="Open ' + escapeHtml(c.fileName) + '" aria-label="Source ' + escapeHtml(n) + ': ' + escapeHtml(c.fileName) + '">' + escapeHtml(n) + '</button>';
      });
      return '<p>' + mdInline(safe) + '</p>';
    }).join('');

    var by = data && data.by === 'ai' ? 'AI answer' : 'Offline search';
    var html = '<div class="answer-box">' +
      '<p class="answer-q"><strong>' + escapeHtml(question) + '</strong><span class="answer-by">' + escapeHtml(by) + '</span></p>' +
      '<div class="answer-text">' + answerHtml + '</div>' +
    '</div>';

    if (citations.length) {
      html += '<p class="citations-label">Sources</p><ol class="citations">' + citations.map(function (c) {
        return '<li><button type="button" class="citation" data-file-id="' + escapeHtml(c.fileId) + '">' +
          '<span class="cite-n">' + escapeHtml(c.n) + '</span>' +
          '<span class="citation-name">' + escapeHtml(c.fileName) + '</span>' +
          '<span class="citation-snippet">' + escapeHtml(c.snippet) + '</span>' +
        '</button></li>';
      }).join('') + '</ol>';
    }
    el.askAnswer.innerHTML = html;
  }

  function ask(question) {
    var q = String(question || '').trim();
    if (!q) { el.askInput.focus(); return; }
    if (state.asking) return;
    state.asking = true;
    el.btnAsk.disabled = true;
    el.askAnswer.innerHTML = '<div class="answer-box"><div class="answer-loading"><span class="spinner"></span>Searching your files…</div></div>';
    api('/api/ask', { json: { question: q } }).then(function (data) {
      renderAnswer(q, data);
      pollActivity();
    }).catch(function (err) {
      el.askAnswer.innerHTML = '<div class="answer-box is-error" role="alert">' + escapeHtml(err.message) + '</div>';
    }).then(function () {
      state.asking = false;
      el.btnAsk.disabled = false;
    });
  }

  /* ───────────────────────── Synthesize ───────────────────────── */

  function renderSynth() {
    var ids = [];
    state.selected.forEach(function (id) { ids.push(id); });
    var n = ids.length;
    var ready = n >= 2;
    el.synthCount.textContent = plural(n, 'file') + ' selected' + (ready ? '' : ' (pick at least 2)');
    el.synthCount.classList.toggle('is-ready', ready);
    el.btnSynth.disabled = !ready || state.synthesizing;
    el.btnClearSel.hidden = n === 0;
    el.synthChips.innerHTML = ids.map(function (id) {
      var f = findFile(id);
      var name = f ? f.name : id;
      return '<li class="synth-chip"><span title="' + escapeHtml(name) + '">' + escapeHtml(name) + '</span>' +
        '<button type="button" data-unselect="' + escapeHtml(id) + '" aria-label="Remove ' + escapeHtml(name) + ' from selection">' + ICONS.close + '</button></li>';
    }).join('');
  }

  function toggleSelected(id, on) {
    if (on) state.selected.add(id); else state.selected.delete(id);
    var row = el.fileList.querySelector('.file-row[data-id="' + cssEscape(id) + '"]');
    if (row) {
      row.classList.toggle('is-selected', on);
      var box = row.querySelector('.file-select');
      if (box) box.checked = on;
    }
    renderSynth();
  }

  function synthesize() {
    var ids = [];
    state.selected.forEach(function (id) { ids.push(id); });
    if (ids.length < 2 || state.synthesizing) return;
    state.synthesizing = true;
    setBusy(el.btnSynth, true, 'Synthesizing…');
    api('/api/synthesize', { json: { fileIds: ids, format: el.synthFormat.value } }).then(function (record) {
      toast('success', 'Created ' + (record && record.name ? record.name : 'a new document'), ['Saved in the Generated folder.']);
      return Promise.all([loadFiles(), pollActivity()]).then(function () {
        if (record && record.id) openViewer(record.id);
      });
    }).catch(function (err) {
      toast('error', err.message);
      if (err.status === 404) loadFiles();
    }).then(function () {
      state.synthesizing = false;
      setBusy(el.btnSynth, false);
      renderSynth();
    });
  }

  /* ───────────────────────── Automations ───────────────────────── */

  function renderRules() {
    if (!state.rules.length) {
      el.ruleList.innerHTML = '<li class="empty empty-small"><p class="empty-text">No automations are set up.</p></li>';
      return;
    }
    el.ruleList.innerHTML = state.rules.map(function (r) {
      var inputId = 'rule-' + r.id;
      return '<li><label class="rule' + (r.enabled ? '' : ' is-off') + '" for="' + escapeHtml(inputId) + '">' +
        '<span class="rule-text"><span class="rule-name">' + escapeHtml(r.name) + '</span>' +
        '<span class="rule-desc" id="' + escapeHtml(inputId + '-desc') + '">' + escapeHtml(r.description) + '</span></span>' +
        '<input type="checkbox" role="switch" class="switch" id="' + escapeHtml(inputId) + '" data-rule-id="' + escapeHtml(r.id) + '"' +
        (r.enabled ? ' checked' : '') + ' aria-describedby="' + escapeHtml(inputId + '-desc') + '">' +
      '</label></li>';
    }).join('');
  }

  function loadRules() {
    return api('/api/automations').then(function (data) {
      state.rules = (data && data.rules) || [];
      renderRules();
    }, function (err) {
      el.ruleList.innerHTML = '<li class="empty empty-small"><p class="empty-text">' + escapeHtml('Could not load automations: ' + err.message) + '</p></li>';
    });
  }

  function setRule(input) {
    var id = input.getAttribute('data-rule-id');
    var enabled = input.checked;
    input.disabled = true;
    api('/api/automations/' + encodeURIComponent(id), { method: 'PUT', json: { enabled: enabled } }).then(function (rule) {
      state.rules = state.rules.map(function (r) { return r.id === id ? rule : r; });
      renderRules();
      toast('success', (rule.enabled ? 'Turned on: ' : 'Turned off: ') + rule.name);
      pollActivity();
    }).catch(function (err) {
      input.checked = !enabled;
      input.disabled = false;
      toast('error', err.message);
    });
  }

  /* ───────────────────────── Activity feed + polling ───────────────────────── */

  function activityItem(a, isNew) {
    return '<li class="activity' + (isNew ? ' is-new' : '') + '">' +
      '<time class="activity-time" datetime="' + escapeHtml(a.at) + '">' + escapeHtml(formatClock(a.at)) + '</time>' +
      '<p class="activity-body"><span class="agent-chip agent-' + escapeHtml(agentClass(a.agent)) + '">' + escapeHtml(a.agent) + '</span>' +
      escapeHtml(a.message) + '</p>' +
    '</li>';
  }

  function renderActivity(prevIds) {
    if (!state.activity.length) {
      el.activityList.innerHTML = '<li class="empty empty-small"><p class="empty-text">No agent activity yet. Upload a file and watch the agents work.</p></li>';
      return;
    }
    el.activityList.innerHTML = state.activity.map(function (a) {
      return activityItem(a, prevIds && !prevIds.has(a.id));
    }).join('');
  }

  /**
   * Fetches the activity feed. If the newest entry changed since the last
   * poll, an agent did something — re-fetch the file list too.
   */
  function pollActivity() {
    if (state.polling) return Promise.resolve();
    state.polling = true;
    return api('/api/activity').then(function (data) {
      var list = (data && data.activity) || [];
      var newest = list.length ? list[0].id : null;
      var changed = newest !== state.newestActivityId || !state.activityLoaded;
      var prevIds = state.activityLoaded ? new Set(state.activity.map(function (a) { return a.id; })) : null;
      var hadPrevious = state.activityLoaded;
      var previousNewest = state.newestActivityId;
      state.activity = list;
      state.newestActivityId = newest;
      state.activityLoaded = true;
      if (changed) renderActivity(prevIds);
      if (hadPrevious && newest !== previousNewest) return loadFiles();
    }).catch(function () {
      /* transient network error — try again on the next tick */
    }).then(function () {
      state.polling = false;
    });
  }

  function startPolling() {
    setInterval(function () {
      if (!document.hidden) pollActivity();
    }, POLL_MS);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) pollActivity();
    });
  }

  /* ───────────────────────── Tabs ───────────────────────── */

  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));

  function selectTab(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) tab.focus();
  }

  /* ───────────────────────── Event wiring ───────────────────────── */

  function wire() {
    el.btnUpload.addEventListener('click', function () { el.fileInput.click(); });
    el.fileInput.addEventListener('change', function () { uploadFiles(el.fileInput.files); });
    el.btnSamples.addEventListener('click', loadSamples);

    // Folders
    el.folderList.addEventListener('click', function (e) {
      var btn = e.target.closest('.folder');
      if (!btn) return;
      state.folder = btn.getAttribute('data-folder') || null;
      renderFolders();
      renderFiles();
    });

    // Filter
    el.filter.addEventListener('input', function () {
      state.filter = el.filter.value;
      renderFiles();
    });

    // File list: open / select / delete / empty-state actions
    el.fileList.addEventListener('click', function (e) {
      var action = e.target.closest('[data-action]');
      if (action) {
        if (action.getAttribute('data-action') === 'upload') el.fileInput.click();
        else loadSamples();
        return;
      }
      var del = e.target.closest('.file-delete');
      if (del) { e.stopPropagation(); deleteFile(del.getAttribute('data-id')); return; }
      if (e.target.closest('.file-check')) return; // checkbox handles itself
      var row = e.target.closest('.file-row');
      if (row) openViewer(row.getAttribute('data-id'));
    });
    el.fileList.addEventListener('change', function (e) {
      if (e.target.classList.contains('file-select')) toggleSelected(e.target.getAttribute('data-id'), e.target.checked);
    });

    // Viewer close
    el.viewer.addEventListener('click', function (e) {
      if (!e.target.closest('.viewer-close')) return;
      var openId = state.viewerId;
      closeViewer();
      var opener = openId && el.fileList.querySelector('.file-open[data-id="' + cssEscape(openId) + '"]');
      if (opener) opener.focus();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !el.viewer.hidden) closeViewer();
    });

    // Ask
    el.askForm.addEventListener('submit', function (e) {
      e.preventDefault();
      ask(el.askInput.value);
    });
    document.querySelector('.examples').addEventListener('click', function (e) {
      var ex = e.target.closest('.example');
      if (!ex) return;
      el.askInput.value = ex.getAttribute('data-question');
      ask(el.askInput.value);
    });
    el.askAnswer.addEventListener('click', function (e) {
      var c = e.target.closest('[data-file-id]');
      if (c) openViewer(c.getAttribute('data-file-id'));
    });

    // Synthesize
    el.btnSynth.addEventListener('click', synthesize);
    el.btnClearSel.addEventListener('click', function () {
      state.selected.clear();
      renderFiles();
      renderSynth();
    });
    el.synthChips.addEventListener('click', function (e) {
      var b = e.target.closest('[data-unselect]');
      if (b) toggleSelected(b.getAttribute('data-unselect'), false);
    });

    // Automations
    el.ruleList.addEventListener('change', function (e) {
      if (e.target.matches('.switch')) setRule(e.target);
    });

    // Tabs (click + optional arrow keys)
    tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function () { selectTab(tab, false); });
      tab.addEventListener('keydown', function (e) {
        var next = null;
        if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
        else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
        if (next) { e.preventDefault(); selectTab(next, true); }
      });
    });

    wireDragAndDrop();
  }

  function wireDragAndDrop() {
    var depth = 0;
    function hasFiles(e) {
      var types = e.dataTransfer && e.dataTransfer.types;
      return !!types && Array.prototype.indexOf.call(types, 'Files') >= 0;
    }
    function hide() { depth = 0; el.dropOverlay.hidden = true; }

    window.addEventListener('dragenter', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      el.dropOverlay.hidden = false;
    });
    window.addEventListener('dragover', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', function (e) {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0 || e.relatedTarget === null && e.clientX <= 0 && e.clientY <= 0) hide();
    });
    window.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      hide();
      uploadFiles(e.dataTransfer.files);
    });
    window.addEventListener('dragend', hide);
  }

  /* ───────────────────────── Boot ───────────────────────── */

  function init() {
    wire();
    renderFiles();
    renderSynth();
    loadStatus();
    loadRules();
    loadFiles().catch(function (err) {
      state.filesLoaded = true;
      el.fileList.innerHTML = '<li class="empty"><p class="empty-title">Could not load your files</p><p class="empty-text">' + escapeHtml(err.message) + '</p></li>';
    });
    pollActivity();
    startPolling();
  }

  init();
})();
