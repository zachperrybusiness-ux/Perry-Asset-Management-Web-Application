/*=============================================================================
  app-status.js — PerryStatus
  Added 2026-07-27 by the UI/UX/data audit. See UI-UX-DATA-AUDIT-2026-07-27.md.

  WHY THIS EXISTS
  ---------------
  UX-01 (Critical). The app had 299 catch blocks, 18 of which contained a
  console.error, and no user-facing error channel at all — zero toast /
  notification infrastructure, plus 11 blocking alert() calls. So when a fetch
  failed the panel either went blank or, worse, silently kept displaying the
  previous load's values with nothing to indicate they were stale.

  That failure path is documented as having reached production: the comments in
  cloudflare-worker/wrangler.toml record that exceeding the FMP free tier
  returned 429 and "every FMP-backed panel went blank". INGEST_DAILY_BUDGET is
  240 against a 250/day cap — roughly 96% utilisation — so it is a live risk,
  not a hypothetical one.

  A portfolio tool that shows stale prices as current is worse than one that is
  down, because down is honest.

  DEC-01 (High). The ingestion cron runs macro daily, fundamentals across six
  slots with a ~6-day full-universe cycle, and prices hourly. Two numbers
  sitting on the same panel can therefore be six days apart in vintage, and
  nothing on screen indicated it. Every panel now carries source, as-of, age.

  UX-03 (High). "No data" was rendered both for a new user with no holdings and
  for an upstream 429 — same pixels, opposite meanings, opposite user actions.
  empty() and error() are now separate calls with separate treatments.

  USAGE
  -----
    PerryStatus.loading('holdings');                  // skeleton
    PerryStatus.ok('holdings');                       // clear, render normally
    PerryStatus.empty('holdings', {                   // no data is CORRECT
      title: 'No holdings yet',
      msg:   'Add a position to see analytics.',
      action: { label: 'Add holding', fn: 'showAddHolding()' }
    });
    PerryStatus.error('holdings', err, retryFn);      // something BROKE
    PerryStatus.stale('holdings', asOfDate);          // showing old numbers

    PerryStatus.provenance('holdings', {
      source: 'FMP', asOf: '2026-07-21', maxAgeHours: 24
    });

    PerryStatus.toast('Export complete', 'ok');
    await PerryStatus.guard('holdings', () => fetchHoldings());

  A scope is either an element id or an element. Registering a panel is
  optional — an unregistered scope degrades to a toast rather than throwing,
  so this can be adopted incrementally without a big-bang refactor.
=============================================================================*/

(function (global) {
  'use strict';

  var STATES = { LOADING: 'loading', OK: 'ok', EMPTY: 'empty', ERROR: 'error', STALE: 'stale' };

  var registry = {};   // scope -> { el, lastOk, state, meta }
  var toastHost = null;

  /*---------------------------------------------------------------- helpers */

  function el(scope) {
    if (!scope) return null;
    if (scope.nodeType === 1) return scope;
    return document.getElementById(scope);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function entry(scope) {
    var key = (scope && scope.nodeType === 1) ? (scope.id || '_anon') : scope;
    if (!registry[key]) registry[key] = { el: el(scope), lastOk: null, state: null, meta: {} };
    if (!registry[key].el) registry[key].el = el(scope);
    return registry[key];
  }

  /* Human-readable age. Deliberately coarse — false precision on a staleness
     indicator invites the same over-trust the indicator exists to prevent. */
  function ageText(then) {
    if (!then) return 'unknown';
    var t = (then instanceof Date) ? then : new Date(then);
    if (isNaN(t.getTime())) return 'unknown';
    var mins = Math.floor((Date.now() - t.getTime()) / 60000);
    if (mins < 1)    return 'just now';
    if (mins < 60)   return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24)    return hrs + 'h ago';
    var days = Math.floor(hrs / 24);
    if (days === 1)  return 'yesterday';
    if (days < 30)   return days + 'd ago';
    return t.toISOString().slice(0, 10);
  }

  function ageHours(then) {
    if (!then) return Infinity;
    var t = (then instanceof Date) ? then : new Date(then);
    if (isNaN(t.getTime())) return Infinity;
    return (Date.now() - t.getTime()) / 3600000;
  }

  function render(scope, cls, icon, title, msg, action) {
    var e = entry(scope), node = e.el;
    if (!node) { toast(title + (msg ? ' — ' + msg : ''), cls === 'error' ? 'error' : 'warn'); return; }

    var actHtml = '';
    if (action && action.label) {
      var handler = typeof action.fn === 'string'
        ? action.fn
        : "PerryStatus._act('" + esc(e.key || scope) + "')";
      actHtml = '<button type="button" class="perry-state-act" onclick="' + esc(handler) + '">'
              + esc(action.label) + '</button>';
    }

    node.innerHTML =
      '<div class="perry-state perry-state--' + esc(cls) + '" role="status" aria-live="polite">' +
        '<span class="perry-state-icon" aria-hidden="true">' + icon + '</span>' +
        '<span class="perry-state-body">' +
          '<span class="perry-state-title">' + esc(title) + '</span>' +
          (msg ? '<div class="perry-state-msg">' + esc(msg) + '</div>' : '') +
        '</span>' + actHtml +
      '</div>';
  }

  /*------------------------------------------------------------ the states */

  function loading(scope, label) {
    var e = entry(scope); e.state = STATES.LOADING;
    if (!e.el) return;
    e.el.classList.remove('is-stale');
    e.el.innerHTML = '<div class="perry-skeleton" role="status" aria-live="polite" '
      + 'aria-label="' + esc(label || 'Loading') + '"></div>';
  }

  /* Marks the panel healthy and records the timestamp used by stale checks. */
  function ok(scope, asOf) {
    var e = entry(scope);
    e.state = STATES.OK;
    e.lastOk = asOf ? new Date(asOf) : new Date();
    if (e.el) e.el.classList.remove('is-stale');
    return e.lastOk;
  }

  /* UX-03: genuinely no data. This is a success path — offer the next action. */
  function empty(scope, opts) {
    opts = opts || {};
    entry(scope).state = STATES.EMPTY;
    render(scope, 'empty', '&#9633;',
      opts.title || 'Nothing here yet',
      opts.msg   || '',
      opts.action);
  }

  /* UX-01: something broke. Say what, say when it last worked, offer retry. */
  function error(scope, err, retryFn, opts) {
    opts = opts || {};
    var e = entry(scope);
    e.state = STATES.ERROR;

    var detail = '';
    if (err) {
      if (typeof err === 'string')       detail = err;
      else if (err.status === 429)       detail = 'Data provider rate limit reached (429). The daily quota is nearly exhausted — see INGEST_DAILY_BUDGET.';
      else if (err.status === 403)       detail = 'Request rejected (403). The worker origin allowlist may not include this domain.';
      else if (err.status)               detail = 'Request failed with status ' + err.status + '.';
      else if (err.message)              detail = err.message;
    }
    if (e.lastOk) detail += (detail ? ' ' : '') + 'Last successful load ' + ageText(e.lastOk) + '.';

    if (retryFn) { e.meta.retry = retryFn; e.key = e.key || scope; }

    render(scope, 'error', '&#9888;',
      opts.title || 'Could not load this panel',
      detail || 'An unexpected error occurred.',
      retryFn ? { label: 'Retry', fn: "PerryStatus._act('" + String(scope) + "')" } : null);

    if (typeof console !== 'undefined' && console.error) {
      console.error('[PerryStatus] ' + scope + ':', err);
    }
  }

  /* UX-01/DEC-01: values are showing but they are old. Degrade them visibly. */
  function stale(scope, asOf, opts) {
    opts = opts || {};
    var e = entry(scope);
    e.state = STATES.STALE;
    if (e.el) e.el.classList.add('is-stale');
    toast('Showing data from ' + ageText(asOf) + (opts.label ? ' for ' + opts.label : '')
        + '. A refresh did not succeed.', 'warn');
  }

  function _act(scope) {
    var e = registry[scope];
    if (e && typeof e.meta.retry === 'function') { loading(scope); e.meta.retry(); }
  }

  /*--------------------------------------------------------- DEC-01 footer */

  /* Appends "Source · as-of · age" to a panel and flags it when the data is
     older than its expected refresh interval.

     Suggested maxAgeHours, from cloudflare-worker/wrangler.toml:
       prices        2      (hourly cron)
       macro        30      (06:00 UTC daily)
       fundamentals 168     (~6-day full-universe cycle)  */
  function provenance(scope, meta) {
    meta = meta || {};
    var node = el(scope);
    if (!node) return;

    var prev = node.querySelector(':scope > .perry-prov');
    if (prev) prev.remove();

    var hrs   = ageHours(meta.asOf);
    var isOld = meta.maxAgeHours != null && hrs > meta.maxAgeHours;

    var d = document.createElement('div');
    d.className = 'perry-prov' + (isOld ? ' perry-prov--stale' : '');
    d.innerHTML =
      (meta.source ? '<span class="perry-prov-src">' + esc(meta.source) + '</span>' : '') +
      (meta.asOf   ? '<span>as of ' + esc(String(meta.asOf).slice(0, 16).replace('T', ' ')) + '</span>' : '') +
      '<span class="perry-prov-age">' + esc(ageText(meta.asOf)) + '</span>' +
      (meta.note   ? '<span>' + esc(meta.note) + '</span>' : '');

    if (isOld) d.title = 'Older than the expected ' + meta.maxAgeHours
      + 'h refresh interval — treat this value as provisional.';

    node.appendChild(d);
    if (isOld && node.classList) node.classList.add('is-stale');
  }

  /*----------------------------------------------------------------- toast */

  function toast(msg, kind, ms) {
    if (!toastHost) {
      toastHost = document.getElementById('perryToastHost');
      if (!toastHost) {
        toastHost = document.createElement('div');
        toastHost.id = 'perryToastHost';
        document.body.appendChild(toastHost);
      }
    }
    var t = document.createElement('div');
    t.className = 'perry-toast perry-toast--' + (kind || 'info');
    t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    t.innerHTML = '<span>' + esc(msg) + '</span>'
      + '<button type="button" class="perry-toast-x" aria-label="Dismiss">&times;</button>';
    t.querySelector('.perry-toast-x').onclick = function () { t.remove(); };
    toastHost.appendChild(t);

    var life = ms != null ? ms : (kind === 'error' ? 12000 : 6000);
    if (life > 0) setTimeout(function () { t.remove(); }, life);
    return t;
  }

  /*----------------------------------------------------------------- guard */

  /* Wraps an async load in the full state machine. This is the migration
     target for the 299 silent catch blocks — replacing them one panel at a
     time rather than in a single risky sweep.

       PerryStatus.guard('holdings', () => fetchHoldings(), {
         source: 'FMP', maxAgeHours: 168,
         isEmpty: r => !r || !r.length,
         empty:   { title: 'No holdings yet' }
       }); */
  function guard(scope, fn, opts) {
    opts = opts || {};
    loading(scope, opts.label);
    return Promise.resolve()
      .then(fn)
      .then(function (res) {
        var e = entry(scope);
        if (opts.isEmpty ? opts.isEmpty(res) : (res == null || (Array.isArray(res) && !res.length))) {
          empty(scope, opts.empty);
          return res;
        }
        var asOf = opts.asOf || (res && res.asOf) || new Date();
        ok(scope, asOf);
        if (opts.source) provenance(scope, { source: opts.source, asOf: asOf, maxAgeHours: opts.maxAgeHours });
        return res;
      })
      .catch(function (err) {
        var e = entry(scope);
        /* If we have previously-good data, showing it stale is more useful than
           showing nothing — but it must be visibly marked, never silent. */
        if (e.lastOk && opts.keepStale) stale(scope, e.lastOk, { label: opts.label });
        else error(scope, err, opts.retry);
        return opts.rethrow ? Promise.reject(err) : null;
      });
  }

  /*-------------------------------------------------- VIS-10 document title */

  function setTitle(view) {
    document.title = view ? (view + ' · Perry Asset Management')
                          : 'Perry Asset Management';
  }

  /*------------------------------------------------------- global handlers */

  /* Nothing should fail silently at the top level either. */
  global.addEventListener('error', function (ev) {
    if (ev && ev.message && /ResizeObserver/.test(ev.message)) return;  // benign
    toast('Unexpected error: ' + (ev.message || 'unknown'), 'error');
  });
  global.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    toast('Request failed: ' + ((r && (r.message || r.status)) || 'unknown'), 'error');
  });

  /*------------------------------------------------- VIS-10 / VIS-08 wiring */

  /* app.js already uses a monkey-patch pattern on navigateTo (see the mobile
     nav sync block), so this follows the same convention. It must run after
     app.js has defined navigateTo, hence DOMContentLoaded — app-status.js
     itself loads first so that PerryStatus exists for the data modules. */
  var PAGE_TITLES = {
    home: 'Home', about: 'About', resources: 'Resources',
    portfolio: 'Portfolio Overview', holdings: 'Manage Holdings',
    themes: 'Portfolio Themes', macro: 'Macro & Cross-Asset',
    research: 'Stock Research', backtest: 'Strategy Backtesting'
  };

  /* VIS-08: give the skip link a live target.

     NOTE: this deliberately does NOT rename the page element's id. An earlier
     draft moved id="mainContent" onto the active page, which would have broken
     every getElementById('page-<name>') lookup in app.js. Instead the page is
     only made programmatically focusable, and skipToMain() focuses whichever
     page is currently visible. */
  var _activePage = null;
  function markMain(page) {
    var next = document.getElementById('page-' + page);
    if (next) { next.setAttribute('tabindex', '-1'); _activePage = next; }
  }

  function skipToMain(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    var target = _activePage;
    if (!target) {
      var pages = document.querySelectorAll('.page');
      for (var i = 0; i < pages.length; i++) {
        if (pages[i].offsetParent !== null) { target = pages[i]; break; }
      }
    }
    if (!target) return;
    target.setAttribute('tabindex', '-1');
    target.focus();
    target.scrollIntoView({ block: 'start' });
  }

  function wireNav() {
    var orig = global.navigateTo;
    if (typeof orig !== 'function') return;
    global.navigateTo = function (p) {
      var r = orig.apply(this, arguments);
      try { setTitle(PAGE_TITLES[p] || p); markMain(p); } catch (e) { /* never break nav */ }
      return r;
    };
    /* Set the initial title from whichever page is active at load. */
    var active = document.querySelector('.nav-parent.active[data-page]');
    if (active) { setTitle(PAGE_TITLES[active.dataset.page] || null); markMain(active.dataset.page); }

    var skip = document.querySelector('.skip-link');
    if (skip) skip.addEventListener('click', skipToMain);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(wireNav, 0); });
  } else {
    setTimeout(wireNav, 0);
  }

  global.PerryStatus = {
    STATES: STATES,
    loading: loading, ok: ok, empty: empty, error: error, stale: stale,
    provenance: provenance, toast: toast, guard: guard,
    ageText: ageText, ageHours: ageHours, setTitle: setTitle, skipToMain: skipToMain,
    _act: _act, _registry: registry
  };

})(window);
