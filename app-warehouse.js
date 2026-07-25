/* ============================================================================
   Perry Asset Management — Warehouse Client  (app-warehouse.js)
   Added 2026-07-24.  Load AFTER app.js, BEFORE app-ml.js / app-signals.js.

   WHY THIS EXISTS
   ---------------
   Every "compare this holding to its peers" question needs a CROSS-SECTIONAL
   panel: the same fields for every stock, at the same moment, in memory. The
   old code could only ever fetch one ticker at a time from a nested Firestore
   blob, so peer comparison was structurally impossible.

   This module owns exactly one job: get the panel, normalise it, and answer
   ranking questions about it. It computes NOTHING opinionated — no scores, no
   verdicts. That separation is deliberate: app-ml.js and app-signals.js are
   the only places allowed to form a view, so there is one place to audit when
   a recommendation looks wrong.

   PUBLIC API
   ----------
   await PerryWarehouse.load()                  → { rows, asOf, coverage }
   PerryWarehouse.get(ticker)                   → metrics row or null
   PerryWarehouse.peers(ticker, {by, n})        → nearest peers in industry/sector
   PerryWarehouse.zScore(ticker, field, scope)  → cross-sectional z
   PerryWarehouse.percentile(ticker, field, scope)
   PerryWarehouse.rank(field, {dir, scope, limit})
   PerryWarehouse.sectorStats(field)            → per-sector median/mean/n
   PerryWarehouse.coverage()                    → freshness + completeness
   await PerryWarehouse.ohlc(ticker)            → { d, o, h, l, c, v }
   await PerryWarehouse.macro()                 → { key: series, ... }
   await PerryWarehouse.internals(history)      → breadth/concentration
   ============================================================================ */

(function () {
  'use strict';

  var WORKER = (typeof WORKER_URL !== 'undefined' && WORKER_URL)
    ? WORKER_URL
    : 'https://perry-finance-proxy.zachperrybusiness.workers.dev';

  var LS_KEY = 'perry_warehouse_panel_v1';
  var LS_TTL_MIN = 90;          // panel is rebuilt nightly; 90min memory cache is plenty

  var W = {
    _rows: null,
    _byTicker: null,
    _asOf: null,
    _loading: null,
    _macro: null,
    _internals: null,
    _ohlcCache: {}
  };

  /* ══════════════ numeric helpers (local — no dependency on app.js) ══════════ */

  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
  function mean(a) { return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : null; }
  function median(a) {
    if (!a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function stdev(a) {
    if (a.length < 2) return null;
    var m = mean(a);
    return Math.sqrt(a.reduce(function (s, v) { return s + (v - m) * (v - m); }, 0) / (a.length - 1));
  }

  /**
   * Winsorised, robust z-score. Financial ratios have brutal outliers (a P/E of
   * 4,000 on a near-zero-earnings name would otherwise dominate any standard
   * deviation), so we clip to the 2nd/98th percentile before scaling and use
   * median/MAD rather than mean/sd. This is the single most important detail in
   * making cross-sectional factor scores behave.
   */
  function robustZ(values, v) {
    if (v == null || !values.length) return null;
    var s = values.slice().sort(function (a, b) { return a - b; });
    var lo = s[Math.floor(s.length * 0.02)];
    var hi = s[Math.floor(s.length * 0.98)];
    var clip = function (x) { return Math.max(lo, Math.min(hi, x)); };
    var med = median(s);
    var mad = median(s.map(function (x) { return Math.abs(x - med); }));
    // 1.4826 scales MAD to be a consistent estimator of sigma for normal data
    var scale = mad != null && mad > 0 ? mad * 1.4826 : stdev(s);
    if (!scale) return 0;
    return (clip(v) - med) / scale;
  }

  function pctRank(values, v) {
    if (v == null || !values.length) return null;
    var below = 0;
    for (var i = 0; i < values.length; i++) if (values[i] <= v) below++;
    return (below / values.length) * 100;
  }

  /* ══════════════ field catalogue ══════════════
     Direction matters: for value ratios LOWER is better, for quality HIGHER is
     better. Encoding this once here prevents every consumer from re-deciding
     (and eventually disagreeing about) which way is good — one of the root
     causes of the conflicting signals in the old code. */

  var FIELDS = {
    // value — lower is better
    pe:            { label: 'P/E',              group: 'value',      better: 'low'  },
    pb:            { label: 'P/B',              group: 'value',      better: 'low'  },
    ps:            { label: 'P/S',              group: 'value',      better: 'low'  },
    pfcf:          { label: 'P/FCF',            group: 'value',      better: 'low'  },
    ev_ebitda:     { label: 'EV/EBITDA',        group: 'value',      better: 'low'  },
    ev_sales:      { label: 'EV/Sales',         group: 'value',      better: 'low'  },
    peg:           { label: 'PEG',              group: 'value',      better: 'low'  },
    // yield — higher is better
    fcf_yield:     { label: 'FCF Yield',        group: 'value',      better: 'high' },
    earnings_yield:{ label: 'Earnings Yield',   group: 'value',      better: 'high' },
    dividend_yield:{ label: 'Dividend Yield',   group: 'income',     better: 'high' },
    // quality — higher is better
    roe:           { label: 'ROE',              group: 'quality',    better: 'high' },
    roa:           { label: 'ROA',              group: 'quality',    better: 'high' },
    roic:          { label: 'ROIC',             group: 'quality',    better: 'high' },
    gross_margin:  { label: 'Gross Margin',     group: 'quality',    better: 'high' },
    operating_margin:{ label: 'Op. Margin',     group: 'quality',    better: 'high' },
    net_margin:    { label: 'Net Margin',       group: 'quality',    better: 'high' },
    interest_coverage:{ label: 'Int. Coverage', group: 'quality',    better: 'high' },
    quality_flags: { label: 'Quality Score',    group: 'quality',    better: 'high' },
    // leverage — lower is better
    debt_to_equity:{ label: 'Debt/Equity',      group: 'leverage',   better: 'low'  },
    net_debt_to_ebitda:{ label: 'NetDebt/EBITDA',group:'leverage',   better: 'low'  },
    current_ratio: { label: 'Current Ratio',    group: 'leverage',   better: 'high' },
    // momentum / technical — higher is better
    mom_12_1:      { label: 'Momentum 12-1',    group: 'momentum',   better: 'high' },
    ret_3m:        { label: '3M Return',        group: 'momentum',   better: 'high' },
    ret_6m:        { label: '6M Return',        group: 'momentum',   better: 'high' },
    ret_12m:       { label: '12M Return',       group: 'momentum',   better: 'high' },
    rel_str_3m:    { label: 'Rel. Strength 3M', group: 'momentum',   better: 'high' },
    rsi_14:        { label: 'RSI(14)',          group: 'technical',  better: 'mid'  },
    pct_from_52w_high:{ label: '% from 52w High',group:'technical',  better: 'high' },
    // risk — lower is better
    vol_ann:       { label: 'Ann. Volatility',  group: 'risk',       better: 'low'  },
    beta_spy:      { label: 'Beta vs SPY',      group: 'risk',       better: 'mid'  },
    max_dd_1y:     { label: 'Max DD 1Y',        group: 'risk',       better: 'high' },
    // scale
    market_cap:    { label: 'Market Cap',       group: 'scale',      better: 'high' },
    avg_dollar_vol_3m:{ label: 'Avg $ Volume',  group: 'scale',      better: 'high' }
  };

  /* ══════════════ loading ══════════════ */

  function readLS() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o.asOf || !o.rows) return null;
      if ((Date.now() - new Date(o.asOf).getTime()) / 60000 > LS_TTL_MIN) return null;
      return o;
    } catch (e) { return null; }
  }

  function writeLS(o) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(o)); }
    catch (e) { /* panel can exceed quota on small budgets — non-fatal */ }
  }

  /* ── COVERAGE TIERS, computed client-side — added 2026-07-25 ──────────────
     The worker now writes has_technicals / has_fundamentals / coverage_tier,
     but rows ingested before that change carry the old brittle `data_complete`
     flag, which excluded every ETF (FMP returns no P/E or P/S for a fund).
     Recomputing here means the fix takes effect immediately instead of waiting
     for the whole universe to be re-ingested over the following nights. */
  function applyTiers(rows) {
    rows.forEach(function (r) {
      if (!r) return;
      r.has_technicals = (r.px_last != null && r.ret_3m != null);
      r.has_fundamentals = (r.pe != null || r.ps != null || r.pb != null ||
                            r.roe != null || r.fcf_yield != null);
      r.coverage_tier = !r.has_technicals ? 'none'
                      : r.has_fundamentals ? 'full' : 'technical';
      // Overwrite the stored flag so every downstream consumer agrees.
      r.data_complete = r.has_technicals;
    });
    return rows;
  }

  function index(rows) {
    var m = {};
    rows.forEach(function (r) { if (r && r.ticker) m[r.ticker] = r; });
    return m;
  }

  /**
   * Load the panel. Safe to call repeatedly — concurrent callers share one
   * in-flight promise so a page with six widgets makes one network request.
   */
  W.load = function (opts) {
    opts = opts || {};
    if (W._rows && !opts.force) return Promise.resolve(W.snapshot());
    if (W._loading && !opts.force) return W._loading;

    if (!opts.force) {
      var cached = readLS();
      if (cached) {
        W._rows = applyTiers(cached.rows);
        W._byTicker = index(cached.rows);
        W._asOf = cached.asOf;
        return Promise.resolve(W.snapshot());
      }
    }

    W._loading = fetch(WORKER + '/warehouse/panel?limit=1200')
      .then(function (r) {
        if (!r.ok) throw new Error('panel HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        var rows = applyTiers((j.rows || []).filter(function (r) { return r && r.ticker; }));
        W._rows = rows;
        W._byTicker = index(rows);
        W._asOf = j.asOf || new Date().toISOString();
        writeLS({ rows: rows, asOf: W._asOf });
        W._loading = null;
        return W.snapshot();
      })
      .catch(function (e) {
        W._loading = null;
        console.warn('[warehouse] load failed:', e.message);
        // Degrade gracefully — consumers check .ready and hide themselves.
        W._rows = W._rows || [];
        W._byTicker = W._byTicker || {};
        return W.snapshot();
      });

    return W._loading;
  };

  W.snapshot = function () {
    return { rows: W._rows || [], asOf: W._asOf, coverage: W.coverage(), ready: !!(W._rows && W._rows.length) };
  };

  W.ready = function () { return !!(W._rows && W._rows.length); };
  W.get = function (t) { return (W._byTicker || {})[String(t || '').toUpperCase()] || null; };
  W.all = function () { return W._rows || []; };

  /* ══════════════ scope resolution ══════════════
     A z-score is meaningless without saying "relative to what". Comparing a
     utility's P/E to a software company's is exactly how the old sector
     benchmark table went wrong. Default scope is INDUSTRY, falling back to
     sector then market when the cohort is too small to be meaningful. */

  var MIN_COHORT = 8;

  W.cohort = function (ticker, scope) {
    var row = W.get(ticker);
    var rows = W.all();
    if (!row) return { scope: 'market', rows: rows };

    if (scope === 'market') return { scope: 'market', rows: rows };

    if (scope !== 'sector' && row.industry) {
      var ind = rows.filter(function (r) { return r.industry === row.industry; });
      if (ind.length >= MIN_COHORT) return { scope: 'industry', label: row.industry, rows: ind };
    }
    if (row.sector) {
      var sec = rows.filter(function (r) { return r.sector === row.sector; });
      if (sec.length >= MIN_COHORT) return { scope: 'sector', label: row.sector, rows: sec };
    }
    return { scope: 'market', rows: rows };
  };

  function colOf(rows, field) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var v = num(rows[i][field]);
      if (v != null) out.push(v);
    }
    return out;
  }

  W.zScore = function (ticker, field, scope) {
    var row = W.get(ticker); if (!row) return null;
    var c = W.cohort(ticker, scope);
    var z = robustZ(colOf(c.rows, field), num(row[field]));
    if (z == null) return null;
    // Flip so that positive ALWAYS means "better", regardless of field polarity.
    var meta = FIELDS[field];
    if (meta && meta.better === 'low') z = -z;
    return z;
  };

  /** Raw (unflipped) z — for display where direction is shown separately. */
  W.rawZ = function (ticker, field, scope) {
    var row = W.get(ticker); if (!row) return null;
    var c = W.cohort(ticker, scope);
    return robustZ(colOf(c.rows, field), num(row[field]));
  };

  W.percentile = function (ticker, field, scope) {
    var row = W.get(ticker); if (!row) return null;
    var c = W.cohort(ticker, scope);
    var p = pctRank(colOf(c.rows, field), num(row[field]));
    if (p == null) return null;
    var meta = FIELDS[field];
    if (meta && meta.better === 'low') p = 100 - p;
    return p;
  };

  /* ══════════════ ranking + peers ══════════════ */

  W.rank = function (field, opts) {
    opts = opts || {};
    var rows = opts.rows || W.all();
    if (opts.sector) rows = rows.filter(function (r) { return r.sector === opts.sector; });
    if (opts.industry) rows = rows.filter(function (r) { return r.industry === opts.industry; });
    if (opts.minCap) rows = rows.filter(function (r) { return num(r.market_cap) >= opts.minCap; });
    if (opts.minDollarVol) rows = rows.filter(function (r) { return num(r.avg_dollar_vol_3m) >= opts.minDollarVol; });

    var meta = FIELDS[field] || {};
    var dir = opts.dir || (meta.better === 'low' ? 'asc' : 'desc');

    var withVal = rows.filter(function (r) { return num(r[field]) != null; });
    withVal.sort(function (a, b) {
      return dir === 'asc' ? a[field] - b[field] : b[field] - a[field];
    });
    return opts.limit ? withVal.slice(0, opts.limit) : withVal;
  };

  /**
   * Peers = same industry (or sector), closest in size. Size matters because a
   * $3T mega-cap and a $2B small-cap in "Software" are not comparable on
   * margins, multiples, or beta.
   */
  W.peers = function (ticker, opts) {
    opts = opts || {};
    var n = opts.n || 8;
    var row = W.get(ticker);
    if (!row) return [];
    var c = W.cohort(ticker, opts.scope);
    var cap = num(row.market_cap);
    var pool = c.rows.filter(function (r) { return r.ticker !== row.ticker; });

    if (cap) {
      pool.sort(function (a, b) {
        var da = Math.abs(Math.log((num(a.market_cap) || cap) / cap));
        var db = Math.abs(Math.log((num(b.market_cap) || cap) / cap));
        return da - db;
      });
    }
    return pool.slice(0, n);
  };

  W.sectorStats = function (field) {
    var bySector = {};
    W.all().forEach(function (r) {
      var s = r.sector || 'Unknown';
      var v = num(r[field]);
      if (v == null) return;
      (bySector[s] = bySector[s] || []).push(v);
    });
    var out = {};
    Object.keys(bySector).forEach(function (s) {
      out[s] = {
        n: bySector[s].length,
        median: median(bySector[s]),
        mean: mean(bySector[s]),
        std: stdev(bySector[s])
      };
    });
    return out;
  };

  /**
   * Every field, z-scored within cohort, for one ticker. This is the feature
   * vector the ML ranker consumes and the peer table renders.
   */
  W.profile = function (ticker, scope) {
    var row = W.get(ticker);
    if (!row) return null;
    var c = W.cohort(ticker, scope);
    var out = { ticker: row.ticker, name: row.name, sector: row.sector, industry: row.industry,
                cohort: c.scope, cohortLabel: c.label || 'Market', cohortN: c.rows.length, fields: {} };
    Object.keys(FIELDS).forEach(function (f) {
      var v = num(row[f]);
      if (v == null) return;
      out.fields[f] = {
        value: v,
        label: FIELDS[f].label,
        group: FIELDS[f].group,
        better: FIELDS[f].better,
        z: W.zScore(ticker, f, scope),
        pct: W.percentile(ticker, f, scope),
        cohortMedian: median(colOf(c.rows, f))
      };
    });
    return out;
  };

  /* ══════════════ freshness / coverage ══════════════
     Surfaced in the UI so nothing is ever presented as more current than it is
     — the fix for "all indicators shown as equally fresh". */

  W.coverage = function () {
    var rows = W.all();
    if (!rows.length) return { n: 0, complete: 0, pctComplete: 0, oldestDays: null, newestDays: null };
    var ages = rows.map(function (r) {
      return r.updatedAt ? (Date.now() - new Date(r.updatedAt).getTime()) / 864e5 : null;
    }).filter(function (v) { return v != null; });
    var complete = rows.filter(function (r) { return r.data_complete; }).length;
    return {
      n: rows.length,
      complete: complete,
      pctComplete: rows.length ? complete / rows.length : 0,
      oldestDays: ages.length ? Math.max.apply(null, ages) : null,
      newestDays: ages.length ? Math.min.apply(null, ages) : null,
      medianAgeDays: ages.length ? median(ages) : null
    };
  };

  W.status = function () {
    return fetch(WORKER + '/warehouse/status').then(function (r) { return r.json(); }).catch(function () { return null; });
  };

  /** Renders the standard freshness chip. Call anywhere a panel shows warehouse data. */
  W.freshnessChip = function () {
    var c = W.coverage();
    if (!c.n) {
      return '<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:#F5E6E0;color:#8B2A2A;">'
        + 'Warehouse empty — nightly ingest has not run</span>';
    }
    var age = c.medianAgeDays == null ? null : Math.round(c.medianAgeDays);
    var stale = age != null && age > 3;
    var col = stale ? { bg: '#FBF3E0', fg: '#8B6914' } : { bg: '#E8F3EC', fg: '#2E7D52' };
    return '<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:' + col.bg + ';color:' + col.fg + ';" '
      + 'title="' + c.complete + ' of ' + c.n + ' names have complete fundamentals. Universe fills over several nights on the FMP free tier.">'
      + c.n + ' names · ' + Math.round(c.pctComplete * 100) + '% complete'
      + (age != null ? ' · median age ' + age + 'd' : '') + '</span>';
  };

  /* ══════════════ secondary datasets ══════════════ */

  W.ohlc = function (ticker) {
    var t = String(ticker || '').toUpperCase();
    if (W._ohlcCache[t]) return Promise.resolve(W._ohlcCache[t]);
    return fetch(WORKER + '/warehouse/ohlc?symbol=' + encodeURIComponent(t))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.c && j.c.length) { W._ohlcCache[t] = j; return j; }
        return null;
      })
      .catch(function () { return null; });
  };

  W.macro = function (force) {
    if (W._macro && !force) return Promise.resolve(W._macro);
    return fetch(WORKER + '/warehouse/macro')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (j) { W._macro = j || {}; return W._macro; })
      .catch(function () { return {}; });
  };

  W.internals = function (withHistory) {
    if (W._internals && !withHistory) return Promise.resolve(W._internals);
    return fetch(WORKER + '/warehouse/internals' + (withHistory ? '?history=1' : ''))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j) { W._internals = j.latest || null; if (withHistory) W._internalsHistory = j.history || []; }
        return withHistory ? j : W._internals;
      })
      .catch(function () { return null; });
  };

  /* ══════════════ holdings enrichment ══════════════
     Joins the user's positions to the warehouse. Anything the warehouse does
     not yet cover is flagged rather than silently omitted, so a half-filled
     universe never produces a misleadingly short comparison table. */

  W.enrichHoldings = function (holdings) {
    var out = { covered: [], missing: [] };
    (holdings || []).forEach(function (h) {
      var row = W.get(h.ticker);
      if (row && row.data_complete) out.covered.push(Object.assign({}, h, { _wh: row }));
      else out.missing.push(h.ticker);
    });
    return out;
  };

  W.FIELDS = FIELDS;
  W.util = { robustZ: robustZ, pctRank: pctRank, median: median, mean: mean, stdev: stdev };

  window.PerryWarehouse = W;
})();
