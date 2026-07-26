/* ============================================================================
   Perry Asset Management — Correlation Workbench  (app-corr.js)
   Added 2026-07-25.  Load after app-warehouse.js / app-signals.js.

   ─────────────────────────────────────────────────────────────────────────────
   WHY THIS REPLACES FIVE SEPARATE THINGS
   ─────────────────────────────────────────────────────────────────────────────
   Correlation was computed in five places, by five different code paths, with
   five different universes and no shared controls:

     mktRenderCorrelation()  app.js:7556   Markets "Pairwise Correlation Heatmap"
     rccRun() / rccRender()  app2.js:4075  "Regime-Conditional & Downside Correlation"
     renderRiskHeatmap()     app2.js:5707  Portfolio Risk tab heatmap
     renderRiskCorrV3()      app3.js:34    a later card-switcher variant
     corrMatrix()            app2.js:7105  helper used by RMT / Wasserstein

   Every one of them re-fetched its own price history, and none of them could
   answer the question that actually matters: "given my real positions, which of
   these move together WHEN IT COUNTS?"

   Specific problems this fixes:
     • Holdings appeared MULTIPLE TIMES when the same ticker was held in more
       than one account, which silently inflated the apparent size of the
       portfolio and put a spurious 1.00 correlation on the diagonal blocks.
     • No account filter — you could not look at just the Roth, or just taxable.
     • No SPDR sector universe and no asset-class universe as presets.
     • Regime conditioning existed but was buried in its own card with a fixed
       default universe, so it never described YOUR portfolio.
     • Each view was a separate card, so comparing them meant scrolling.

   THE DESIGN
   One card. One viewport. Four control rows that recombine the same underlying
   return matrix. Switching a control repaints in place — nothing is stacked and
   nothing is re-fetched, because prices are cached per ticker for the session.
   ============================================================================ */

(function () {
  'use strict';

  var WORKER = (typeof WORKER_URL !== 'undefined' && WORKER_URL)
    ? WORKER_URL
    : 'https://perry-finance-proxy.zachperrybusiness.workers.dev';

  var CW = {
    _px: {},            // ticker -> { d:[dates], c:[closes] }  session cache
    _regimeByDate: null,
    _spyRet: null,      // date -> SPY daily log return, for the downside filter
    _state: {
      universe: 'holdings',
      account: 'ALL',
      regime: 'all',
      lookback: '3y',
      view: 'heatmap'
    },
    _lastMatrix: null,
    _charts: {}
  };

  /* ══════════════════════════════════════════════════════════════════════════
     UNIVERSES
     ══════════════════════════════════════════════════════════════════════════ */

  /* SPDR sector ETFs — the 11 GICS sectors plus the two most-watched industry
     slices (homebuilders, semis), which behave differently enough from their
     parent sectors to be worth seeing separately. */
  var SPDR_SECTORS = [
    { t: 'XLK',  n: 'Technology' },
    { t: 'XLF',  n: 'Financials' },
    { t: 'XLV',  n: 'Health Care' },
    { t: 'XLY',  n: 'Cons. Discretionary' },
    { t: 'XLP',  n: 'Cons. Staples' },
    { t: 'XLE',  n: 'Energy' },
    { t: 'XLI',  n: 'Industrials' },
    { t: 'XLB',  n: 'Materials' },
    { t: 'XLU',  n: 'Utilities' },
    { t: 'XLRE', n: 'Real Estate' },
    { t: 'XLC',  n: 'Communication Svcs' },
    { t: 'XHB',  n: 'Homebuilders' },
    { t: 'SMH',  n: 'Semiconductors' }
  ];

  /* Asset classes — equities, duration, metals, energy, dollar, crypto.
     Crypto uses Yahoo's -USD suffix, which the worker's chart endpoint passes
     through unchanged. */
  var ASSET_CLASSES = [
    { t: 'SPY',     n: 'US Large Cap' },
    { t: 'QQQ',     n: 'US Nasdaq 100' },
    { t: 'IWM',     n: 'US Small Cap' },
    { t: 'EFA',     n: 'Intl Developed' },
    { t: 'EEM',     n: 'Emerging Mkts' },
    { t: 'TLT',     n: 'Long Treasuries' },
    { t: 'IEF',     n: '7-10Y Treasuries' },
    { t: 'HYG',     n: 'High Yield Credit' },
    { t: 'GLD',     n: 'Gold' },
    { t: 'SLV',     n: 'Silver' },
    { t: 'USO',     n: 'Crude Oil' },
    { t: 'DBC',     n: 'Commodities' },
    { t: 'UUP',     n: 'US Dollar' },
    { t: 'VNQ',     n: 'REITs' },
    { t: 'BTC-USD', n: 'Bitcoin' },
    { t: 'ETH-USD', n: 'Ethereum' },
    { t: 'XRP-USD', n: 'XRP' }
  ];

  /* ══════════════════════════════════════════════════════════════════════════
     HOLDINGS: DEDUPE ACROSS ACCOUNTS

     The bug this solves: holding AAPL in both a taxable account and a Roth
     produced TWO rows in every previous correlation view, with a correlation of
     exactly 1.00 between them. That is not information — it is the same asset
     counted twice, and it made the matrix look more diversified than it was
     (two perfectly-correlated rows drag the average pair correlation around).

     Positions are aggregated to one row per unique ticker, with market value
     summed across accounts so the weighting stays honest.
     ══════════════════════════════════════════════════════════════════════════ */

  var CASH_LIKE = ['Cash', 'Money Market', 'CD'];

  function accountsList() {
    var seen = {}, out = [];
    (window._holdings || []).forEach(function (h) {
      var a = h.accountType || h.account || 'Individual';
      if (!seen[a]) { seen[a] = 1; out.push(a); }
    });
    return out.sort();
  }

  function dedupedHoldings(account) {
    var byTicker = {};
    (window._holdings || []).forEach(function (h) {
      if (!h.ticker) return;
      if (CASH_LIKE.indexOf(h.assetClass) >= 0) return;
      var acct = h.accountType || h.account || 'Individual';
      if (account && account !== 'ALL' && acct !== account) return;

      var t = String(h.ticker).toUpperCase();
      var mv = (h.quantity || 0) * (h.currentPrice || h.costBasis || 0);
      if (!byTicker[t]) {
        byTicker[t] = { ticker: t, name: h.companyName || t, mv: 0, accounts: [], sector: h.sector || '' };
      }
      byTicker[t].mv += mv;
      if (byTicker[t].accounts.indexOf(acct) < 0) byTicker[t].accounts.push(acct);
    });
    var arr = Object.keys(byTicker).map(function (k) { return byTicker[k]; });
    arr.sort(function (a, b) { return b.mv - a.mv; });
    return arr;
  }

  function currentUniverse() {
    var st = CW._state;
    if (st.universe === 'sectors') {
      return SPDR_SECTORS.map(function (x) { return { ticker: x.t, name: x.n, mv: null }; });
    }
    if (st.universe === 'assets') {
      return ASSET_CLASSES.map(function (x) { return { ticker: x.t, name: x.n, mv: null }; });
    }
    return dedupedHoldings(st.account);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     PRICE LOADING — warehouse first, worker as fallback, cached per session
     ══════════════════════════════════════════════════════════════════════════ */

  var RANGE_DAYS = { '1y': 252, '3y': 756, '5y': 1260, 'max': 100000 };

  function loadPrices(tickers, range) {
    var need = tickers.filter(function (t) { return !CW._px[t]; });
    if (!need.length) return Promise.resolve();

    return Promise.all(need.map(function (t) {
      // Warehouse copy is free and already stored; only fall back when absent.
      var whPromise = (window.PerryWarehouse && window.PerryWarehouse.ohlc)
        ? window.PerryWarehouse.ohlc(t) : Promise.resolve(null);
      return whPromise.then(function (wh) {
        if (wh && wh.d && wh.c && wh.c.length > 120) {
          CW._px[t] = { d: wh.d, c: wh.c, src: 'warehouse' };
          return;
        }
        var r = (range === 'max' || range === '5y') ? '5y' : range;
        return fetch(WORKER + '/chart?symbol=' + encodeURIComponent(t) + '&range=' + r + '&interval=1d')
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (j) {
            var pts = (j && j.points || []).filter(function (p) { return p.close != null; });
            if (pts.length > 60) {
              CW._px[t] = {
                d: pts.map(function (p) { return p.date.slice(0, 10); }),
                c: pts.map(function (p) { return p.close; }),
                src: 'worker'
              };
            } else {
              CW._px[t] = null;   // cache the failure so we don't retry all session
            }
          })
          .catch(function () { CW._px[t] = null; });
      });
    }));
  }

  /* ══════════════════════════════════════════════════════════════════════════
     REGIME CLASSIFICATION PER DAY

     Uses the same daily classifier the rest of the site uses
     (buildDailyClassificationHistory in app.js), so the regime labels here match
     the Portfolio State shown everywhere else. Renamed to the unified intent
     labels — Accumulate / Risk-On / Neutral / De-Risk — rather than the old
     leveraged/growth/neutral/drawdown internals.
     ══════════════════════════════════════════════════════════════════════════ */

  var REGIMES = [
    { key: 'all',        label: 'All History',  color: '#5A6A7A', desc: 'Every session in the lookback window — the unconditional correlation.' },
    { key: 'accumulate', label: 'Accumulate',   color: '#2E7D52', desc: 'Deep-decline sessions with stress priced in (VIX 30+, SPY well off its high). Historically the best entry, and the hardest to act on.' },
    { key: 'risk_on',    label: 'Risk-On',      color: '#003C71', desc: 'Constructive trend, contained volatility.' },
    { key: 'neutral',    label: 'Neutral',      color: '#8B6914', desc: 'Mixed evidence — no dominant signal.' },
    { key: 'de_risk',    label: 'De-Risk',      color: '#8B2A2A', desc: 'Market extended and complacent — near highs after a large advance with low VIX.' },
    { key: 'downside1',  label: 'SPY < −1%',    color: '#8B2A2A', desc: 'Sessions where SPY fell more than 1%. This is the correlation that decides whether your diversification actually works, because it is measured on the days you need it.' },
    { key: 'downside2',  label: 'SPY < −2%',    color: '#5C0000', desc: 'Sessions where SPY fell more than 2% — genuine stress days. Sample is small by construction; treat as directional.' },
    { key: 'vix_stress', label: 'VIX > 25',     color: '#8B2A2A', desc: 'Elevated-volatility sessions regardless of direction.' },
    { key: 'vix_calm',   label: 'VIX < 15',     color: '#2E7D52', desc: 'Calm sessions — correlations are usually LOWEST here, which is exactly why calm-period diversification is misleading.' }
  ];

  var LEGACY_TO_UNIFIED = { leveraged: 'accumulate', growth: 'risk_on', neutral: 'neutral', drawdown: 'de_risk' };

  function loadRegimeSeries() {
    if (CW._regimeByDate) return Promise.resolve();
    return Promise.all([
      fetch(WORKER + '/chart?symbol=SPY&range=5y&interval=1d').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
      fetch(WORKER + '/chart?symbol=%5EVIX&range=5y&interval=1d').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
    ]).then(function (res) {
      var spyPts = ((res[0] && res[0].points) || []).filter(function (p) { return p.close != null; });
      var vixSeries = {};
      ((res[1] && res[1].points) || []).forEach(function (p) { if (p.close != null) vixSeries[p.date.slice(0, 10)] = p.close; });

      CW._vix = vixSeries;
      CW._regimeByDate = {};
      CW._spyRet = {};

      // SPY daily returns drive the downside filters.
      for (var i = 1; i < spyPts.length; i++) {
        var d = spyPts[i].date.slice(0, 10);
        var prev = spyPts[i - 1].close, cur = spyPts[i].close;
        if (prev > 0) CW._spyRet[d] = cur / prev - 1;
      }

      if (typeof buildDailyClassificationHistory === 'function') {
        try {
          var hist = buildDailyClassificationHistory(spyPts, vixSeries) || [];
          hist.forEach(function (h) {
            var w = h.classification && h.classification.winner;
            if (w) CW._regimeByDate[h.date] = LEGACY_TO_UNIFIED[w] || w;
          });
        } catch (e) { console.warn('[corr] regime classify failed:', e.message); }
      }
    });
  }

  /** Which dates belong to the selected regime. */
  function regimeDateFilter(key) {
    if (key === 'all') return null;                 // null = keep everything
    return function (date) {
      if (key === 'downside1') return CW._spyRet[date] != null && CW._spyRet[date] < -0.01;
      if (key === 'downside2') return CW._spyRet[date] != null && CW._spyRet[date] < -0.02;
      if (key === 'vix_stress') return CW._vix[date] != null && CW._vix[date] > 25;
      if (key === 'vix_calm') return CW._vix[date] != null && CW._vix[date] < 15;
      return CW._regimeByDate[date] === key;
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     MATRIX CONSTRUCTION
     ══════════════════════════════════════════════════════════════════════════ */

  function pearson(x, y) {
    var n = Math.min(x.length, y.length);
    if (n < 3) return null;
    var mx = 0, my = 0;
    for (var i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    var num = 0, dx = 0, dy = 0;
    for (var j = 0; j < n; j++) {
      var a = x[j] - mx, b = y[j] - my;
      num += a * b; dx += a * a; dy += b * b;
    }
    return (dx > 0 && dy > 0) ? num / Math.sqrt(dx * dy) : null;
  }

  var MIN_OBS = 20;   // below this a correlation is noise, and we say so

  function buildMatrix(universe, regimeKey, lookback) {
    var valid = universe.filter(function (u) { return CW._px[u.ticker] && CW._px[u.ticker].c.length > 60; });
    if (valid.length < 2) return { error: 'Need at least 2 assets with price history. Loaded ' + valid.length + '.' };

    // Common date set across all assets.
    var maps = {};
    valid.forEach(function (u) {
      var p = CW._px[u.ticker], m = {};
      for (var i = 0; i < p.d.length; i++) m[p.d[i]] = p.c[i];
      maps[u.ticker] = m;
    });
    var dates = Object.keys(maps[valid[0].ticker]).filter(function (d) {
      return valid.every(function (u) { return maps[u.ticker][d] != null; });
    }).sort();

    // Lookback trim.
    var lim = RANGE_DAYS[lookback] || 756;
    if (dates.length > lim) dates = dates.slice(-lim);
    if (dates.length < 40) return { error: 'Only ' + dates.length + ' overlapping sessions across these assets. Crypto trades weekends while equities do not, which shrinks the common set — try a longer lookback or a narrower universe.' };

    // Log returns on the common grid.
    var rets = {}, retDates = [];
    for (var k = 1; k < dates.length; k++) retDates.push(dates[k]);
    valid.forEach(function (u) {
      var arr = [];
      for (var i = 1; i < dates.length; i++) {
        var a = maps[u.ticker][dates[i - 1]], b = maps[u.ticker][dates[i]];
        arr.push(a > 0 && b > 0 ? Math.log(b / a) : 0);
      }
      rets[u.ticker] = arr;
    });

    // Regime subset.
    var filt = regimeDateFilter(regimeKey);
    var idx = [];
    for (var t = 0; t < retDates.length; t++) if (!filt || filt(retDates[t])) idx.push(t);

    if (idx.length < MIN_OBS) {
      return {
        error: 'Only ' + idx.length + ' sessions match "' + (REGIMES.filter(function (r) { return r.key === regimeKey; })[0] || {}).label +
               '" in this window — below the ' + MIN_OBS + '-session minimum for a meaningful correlation. ' +
               'Widen the lookback, or pick a less restrictive regime. Reporting a number here would be noise dressed as signal.',
        insufficient: true, n: idx.length
      };
    }

    var sub = {};
    valid.forEach(function (u) {
      sub[u.ticker] = idx.map(function (i) { return rets[u.ticker][i]; });
    });

    var tickers = valid.map(function (u) { return u.ticker; });
    var M = [];
    for (var a = 0; a < tickers.length; a++) {
      M.push([]);
      for (var b = 0; b < tickers.length; b++) {
        M[a].push(a === b ? 1 : (pearson(sub[tickers[a]], sub[tickers[b]]) || 0));
      }
    }

    // Average pair correlation per asset (excluding self) — the diversification read.
    var avg = tickers.map(function (tk, i) {
      var s = 0, c = 0;
      for (var j = 0; j < tickers.length; j++) if (i !== j) { s += M[i][j]; c++; }
      return { ticker: tk, name: (valid[i].name || tk), avg: c ? s / c : 0, mv: valid[i].mv, accounts: valid[i].accounts };
    });

    // Portfolio-level mean pair correlation — equal-weighted AND value-weighted.
    // The MV-weighted version (added 2026-07-26) is what the portfolio actually
    // experiences: a 0.95 correlation between two 1% positions matters far less
    // than 0.95 between two 20% positions. weight_ij = w_i · w_j.
    var tot = 0, cnt = 0;
    for (var p1 = 0; p1 < tickers.length; p1++) for (var p2 = p1 + 1; p2 < tickers.length; p2++) { tot += M[p1][p2]; cnt++; }
    var meanPairW = null;
    var mvTot = valid.reduce(function (s, u) { return s + (u.mv || 0); }, 0);
    if (mvTot > 0) {
      var wTot = 0, wSum = 0;
      for (var q1 = 0; q1 < tickers.length; q1++) for (var q2 = q1 + 1; q2 < tickers.length; q2++) {
        var w12 = ((valid[q1].mv || 0) / mvTot) * ((valid[q2].mv || 0) / mvTot);
        wSum += M[q1][q2] * w12; wTot += w12;
      }
      meanPairW = wTot > 0 ? wSum / wTot : null;
    }

    /* Statistical significance floor (added 2026-07-26): with n observations,
       a sample correlation is indistinguishable from zero below roughly
       1.96/√(n−3) (Fisher z, 95% two-sided). Cells under this are rendered
       muted so noise doesn't read as signal — especially important for the
       small-sample stress regimes. */
    var rCrit = idx.length > 4 ? 1.96 / Math.sqrt(idx.length - 3) : 1;

    return {
      tickers: tickers, names: valid.map(function (u) { return u.name || u.ticker; }),
      matrix: M, avg: avg, meanPair: cnt ? tot / cnt : 0, meanPairW: meanPairW, rCrit: rCrit,
      nObs: idx.length, nTotal: retDates.length,
      dateFrom: retDates[idx[0]], dateTo: retDates[idx[idx.length - 1]],
      universe: valid, missing: universe.filter(function (u) { return !CW._px[u.ticker]; }).map(function (u) { return u.ticker; })
    };
  }

  /* Seriation (added 2026-07-26): order assets so correlated blocks sit next
     to each other. Greedy clusters (threshold 0.65) come first, ordered by
     cluster size, members ordered by average within-cluster correlation;
     unclustered names follow, ordered by average correlation. A matrix in
     this order shows structure as visible blocks instead of scattered cells. */
  function clusterOrder(m, thr) {
    thr = thr || 0.65;
    var n = m.tickers.length, assigned = {}, clusters = [];
    for (var pass = 0; pass < n; pass++) {
      var best = null;
      for (var i = 0; i < n; i++) {
        if (assigned[i]) continue;
        for (var j = i + 1; j < n; j++) {
          if (assigned[j]) continue;
          if (m.matrix[i][j] >= thr && (!best || m.matrix[i][j] > best.v)) best = { i: i, j: j, v: m.matrix[i][j] };
        }
      }
      if (!best) break;
      var members = [best.i, best.j];
      assigned[best.i] = assigned[best.j] = 1;
      for (var k = 0; k < n; k++) {
        if (assigned[k]) continue;
        var meanTo = members.reduce(function (s, mm) { return s + m.matrix[k][mm]; }, 0) / members.length;
        if (meanTo >= thr) { members.push(k); assigned[k] = 1; }
      }
      clusters.push(members);
    }
    clusters.sort(function (a, b) { return b.length - a.length; });
    var order = [], bounds = [];
    clusters.forEach(function (c) {
      c.sort(function (a, b) { return m.avg[b].avg - m.avg[a].avg; });
      order = order.concat(c);
      bounds.push(order.length);   // index AFTER each cluster block
    });
    var singles = [];
    for (var q = 0; q < n; q++) if (!assigned[q]) singles.push(q);
    singles.sort(function (a, b) { return m.avg[b].avg - m.avg[a].avg; });
    order = order.concat(singles);
    return { order: order, bounds: bounds, nClusters: clusters.length };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     RENDERING — one viewport, four views, repaint in place
     ══════════════════════════════════════════════════════════════════════════ */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function el(id) { return document.getElementById(id); }

  function corrColor(v) {
    /* Diverging scale on white, matte per the brand system:
       positive = muted danger red (moves together — diversification risk),
       negative = brand blues (hedge). White at zero. */
    if (v == null) return '#EEEEEE';
    if (v >= 0) {
      var t = Math.min(1, v);
      return 'rgba(139,42,42,' + (0.05 + t * 0.85).toFixed(3) + ')';
    }
    var u = Math.min(1, -v);
    return 'rgba(0,60,113,' + (0.05 + u * 0.85).toFixed(3) + ')';
  }

  function shortTicker(t) { return t.replace('-USD', ''); }

  /* One-time CSS for the heatmap: row/column crosshair on hover, cluster
     separators, smooth cells. Injected once. (Rebuilt 2026-07-26.) */
  function injectHeatmapCSS() {
    if (document.getElementById('corrHeatCSS')) return;
    var st = document.createElement('style');
    st.id = 'corrHeatCSS';
    st.textContent =
      '#corrViewport table.corr-hm { border-collapse:separate; border-spacing:1px; table-layout:fixed; margin:0 auto; font-family:Arial,Helvetica,sans-serif; }' +
      '#corrViewport table.corr-hm td { transition: box-shadow .06s ease; cursor:default; border-radius:2px; }' +
      '#corrViewport table.corr-hm td.hm-cell:hover { box-shadow: inset 0 0 0 2px #003C71; }' +
      '#corrViewport table.corr-hm tr:hover th.hm-rowlab { background:#003C71 !important; color:#fff !important; }' +
      '#corrViewport table.corr-hm td.hm-clusterR { border-right:2px solid #003C71; }' +
      '#corrViewport table.corr-hm tr.hm-clusterB > * { border-bottom:2px solid #003C71; }';
    document.head.appendChild(st);
  }

  function viewHeatmap(m) {
    /* REBUILT 2026-07-26. Three upgrades over the old table:
       1. SERIATION — assets are cluster-ordered so correlated blocks are
          visibly contiguous (navy separators mark cluster boundaries).
       2. SIGNIFICANCE — cells with |r| below the 95% significance floor for
          this sample size render hollow (white with a gray value): with few
          sessions those numbers are statistically indistinguishable from 0.
       3. LEGIBILITY — horizontal column labels up to 10 assets, a continuous
          legend gradient, hover crosshair, and no internal scrolling. */
    injectHeatmapCSS();
    var co = clusterOrder(m);
    var ord = co.order;
    var n = ord.length;
    var cell = n > 16 ? 24 : n > 13 ? 28 : n > 10 ? 33 : n > 7 ? 40 : 48;
    var fs   = n > 16 ? 8  : n > 13 ? 8.5 : n > 10 ? 9 : 10.5;
    var labFs = n > 16 ? 8.5 : n > 13 ? 9 : 10;
    var horizLabels = n <= 10;
    var boundSet = {};
    co.bounds.forEach(function (b) { if (b < n) boundSet[b - 1] = 1; });   // draw after these row/col positions

    var h = '<div style="width:100%;overflow-x:auto;">';
    h += '<table class="corr-hm" style="font-size:' + fs + 'px;">';
    h += '<tr><th style="width:60px;"></th>';
    ord.forEach(function (oi, jj) {
      var lbl = esc(shortTicker(m.tickers[oi]));
      h += '<th class="' + (boundSet[jj] ? 'hm-clusterR' : '') + '" style="width:' + cell + 'px;padding:2px 0;font-size:' + labFs + 'px;font-weight:600;color:#5A6A7A;'
        + (horizLabels ? '' : 'writing-mode:vertical-rl;transform:rotate(180deg);height:56px;vertical-align:bottom;')
        + '" title="' + esc(m.names[oi]) + '">' + lbl + '</th>';
    });
    h += '</tr>';
    for (var ii = 0; ii < n; ii++) {
      var i = ord[ii];
      h += '<tr class="' + (boundSet[ii] ? 'hm-clusterB' : '') + '">'
        + '<th class="hm-rowlab" style="background:#F4F6F9;text-align:right;padding:2px 7px;font-size:' + labFs + 'px;font-weight:600;color:#5A6A7A;white-space:nowrap;border-radius:2px;" title="' + esc(m.names[i]) + '">' + esc(shortTicker(m.tickers[i])) + '</th>';
      for (var jj2 = 0; jj2 < n; jj2++) {
        var j = ord[jj2];
        var v = m.matrix[i][j];
        var isDiag = i === j;
        var insig = !isDiag && Math.abs(v) < (m.rCrit || 0);
        var bg = isDiag ? '#003C71' : (insig ? '#FFFFFF' : corrColor(v));
        var col = isDiag ? '#FFFFFF' : (insig ? '#A8B4C0' : (Math.abs(v) > 0.55 ? '#FFFFFF' : '#000000'));
        var tip = shortTicker(m.tickers[i]) + ' vs ' + shortTicker(m.tickers[j]) + ': ' + v.toFixed(3) + ' (' + m.nObs + ' sessions)'
          + (insig ? ' — below the ±' + (m.rCrit || 0).toFixed(2) + ' significance floor for this sample; statistically indistinguishable from zero' : '');
        h += '<td class="hm-cell ' + (boundSet[jj2] ? 'hm-clusterR' : '') + '" title="' + esc(tip) + '" '
          + 'style="width:' + cell + 'px;height:' + cell + 'px;text-align:center;background:' + bg + ';color:' + col + ';'
          + (insig ? 'border:1px dashed #D0D7E0;' : '')
          + 'font-variant-numeric:tabular-nums;font-weight:' + (Math.abs(v) >= 0.8 && !isDiag ? '700' : '400') + ';">'
          + (isDiag ? '' : (n > 14 && Math.abs(v) < 0.4 && !insig ? '' : (v < 0 ? '−' : '') + Math.abs(v).toFixed(2).replace(/^0/, '')))
          + '</td>';
      }
      h += '</tr>';
    }
    h += '</table></div>';

    // Continuous legend gradient + reading notes.
    h += '<div style="margin-top:10px;display:flex;align-items:center;gap:12px;font-size:10px;color:#5A6A7A;flex-wrap:wrap;">'
      + '<span style="display:inline-flex;align-items:center;gap:6px;">−1.0'
      + '<span style="width:130px;height:12px;border:1px solid #D0D7E0;border-radius:2px;display:inline-block;background:linear-gradient(to right, rgba(0,60,113,0.9), rgba(0,60,113,0.15), #FFFFFF, rgba(139,42,42,0.15), rgba(139,42,42,0.9));"></span>'
      + '+1.0</span>'
      + '<span><span style="color:#003C71;font-weight:700;">blue</span> = hedge · <span style="color:#8B2A2A;font-weight:700;">red</span> = moves together</span>'
      + '<span style="display:inline-flex;align-items:center;gap:4px;"><span style="width:13px;height:11px;border:1px dashed #D0D7E0;display:inline-block;background:#fff;"></span>below significance floor (±' + (m.rCrit || 0).toFixed(2) + ' at n=' + m.nObs + ')</span>'
      + (co.nClusters ? '<span>· navy lines separate the ' + co.nClusters + ' correlation cluster' + (co.nClusters > 1 ? 's' : '') + ' (see Clusters view)</span>' : '')
      + '</div>';
    return h;
  }

  function viewDiversification(m) {
    var sorted = m.avg.slice().sort(function (a, b) { return b.avg - a.avg; });
    var h = '<div style="font-size:11px;color:var(--text-sec);margin-bottom:8px;line-height:1.6;">'
      +  'Average correlation of each asset against every other asset in this universe. '
      +  '<strong>High = redundant</strong> (it moves with everything else, so it adds little diversification). '
      +  '<strong>Low or negative = genuine diversifier.</strong> This is the single most actionable view here: '
      +  'the names at the top are candidates for consolidation, the names at the bottom are earning their place.'
      +  '</div>';
    // Font scales with row count so long lists still fit without scrolling.
    var dfs = m.avg.length > 16 ? 10 : m.avg.length > 12 ? 10.8 : 11.5;
    h += '<div style="width:100%;"><table style="width:100%;font-size:' + dfs + 'px;border-collapse:collapse;">';
    h += '<thead><tr><th style="text-align:left;padding:4px;">Asset</th>'
      +  '<th style="text-align:right;padding:4px;">Avg corr</th>'
      +  '<th style="padding:4px;width:45%;">Diversification benefit</th>';
    if (m.universe[0] && m.universe[0].mv != null) h += '<th style="text-align:right;padding:4px;">Weight</th>';
    h += '</tr></thead><tbody>';
    var totMV = m.avg.reduce(function (s, a) { return s + (a.mv || 0); }, 0);
    sorted.forEach(function (a) {
      var pctBar = Math.max(0, Math.min(100, (1 - a.avg) * 100));
      var col = a.avg > 0.7 ? '#8B2A2A' : a.avg > 0.45 ? '#8B6914' : '#2E7D52';
      var verdict = a.avg > 0.7 ? 'Redundant' : a.avg > 0.45 ? 'Partial' : 'Diversifier';
      h += '<tr style="border-bottom:1px solid var(--border);">'
        +  '<td style="padding:4px;font-weight:600;" title="' + esc(a.name) + (a.accounts && a.accounts.length > 1 ? ' — held in ' + a.accounts.length + ' accounts, counted once' : '') + '">'
        +    esc(shortTicker(a.ticker))
        +    (a.accounts && a.accounts.length > 1 ? ' <span style="font-size:9px;color:var(--text-sec);" title="Held in ' + esc(a.accounts.join(', ')) + '. Counted once — the same asset in two accounts is not diversification.">×' + a.accounts.length + '</span>' : '')
        +  '</td>'
        +  '<td style="padding:4px;text-align:right;font-family:Courier New,monospace;color:' + col + ';font-weight:700;">' + a.avg.toFixed(3) + '</td>'
        +  '<td style="padding:4px;"><div style="background:#E6E9ED;border-radius:5px;height:9px;overflow:hidden;">'
        +    '<div style="width:' + pctBar.toFixed(1) + '%;height:100%;background:' + col + ';"></div></div>'
        +    '<div style="font-size:9px;color:' + col + ';">' + verdict + '</div></td>';
      if (a.mv != null) h += '<td style="padding:4px;text-align:right;font-family:Courier New,monospace;">' + (totMV > 0 ? (a.mv / totMV * 100).toFixed(1) + '%' : '—') + '</td>';
      h += '</tr>';
    });
    h += '</tbody></table></div>';
    return h;
  }

  /**
   * THE VIEW THE USER ASKED FOR: the same universe across every regime, side by
   * side, so correlation BREAKDOWN is visible rather than inferred. This is what
   * "properly executed" means for regime-conditional correlation — a comparison,
   * not four separate charts you have to remember.
   */
  function viewRegimeCompare(universe, lookback) {
    var keys = ['all', 'risk_on', 'de_risk', 'downside1', 'vix_stress'];
    var results = keys.map(function (k) {
      var m = buildMatrix(universe, k, lookback);
      return { key: k, meta: REGIMES.filter(function (r) { return r.key === k; })[0], m: m };
    });

    var base = results[0].m;
    if (base.error) return '<p style="color:#8B2A2A;font-size:12px;padding:12px;">' + esc(base.error) + '</p>';

    var h = '<div style="font-size:11px;color:var(--text-sec);margin-bottom:10px;line-height:1.6;">'
      +  'Mean pairwise correlation for the <strong>same universe</strong> under each condition. '
      +  'Diversification that only exists in calm markets is not diversification — what matters is the '
      +  '<strong>SPY&nbsp;&lt;&nbsp;&minus;1%</strong> and <strong>VIX&nbsp;&gt;&nbsp;25</strong> columns, because those are the '
      +  'sessions when correlations converge and a portfolio discovers what it actually owns.'
      +  '</div>';

    // Summary strip
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:12px;">';
    results.forEach(function (r) {
      if (r.m.error) {
        h += '<div style="padding:8px;border:1px dashed var(--border);border-radius:5px;text-align:center;opacity:.6;" title="' + esc(r.m.error) + '">'
          +  '<div style="font-size:10px;color:var(--text-sec);">' + esc(r.meta.label) + '</div>'
          +  '<div style="font-size:11px;color:#8B6914;">n=' + (r.m.n || 0) + '</div>'
          +  '<div style="font-size:9px;color:var(--text-sec);">too few</div></div>';
        return;
      }
      var delta = r.key === 'all' ? null : r.m.meanPair - base.meanPair;
      h += '<div style="padding:8px;border:2px solid ' + r.meta.color + '55;border-radius:5px;text-align:center;background:' + r.meta.color + '0D;" title="' + esc(r.meta.desc) + '">'
        +  '<div style="font-size:10px;color:var(--text-sec);">' + esc(r.meta.label)
        +    ' <span class="help-icon" style="font-size:8px;" title="' + esc(r.meta.desc) + '">?</span></div>'
        +  '<div style="font-size:20px;font-weight:800;color:' + r.meta.color + ';line-height:1.1;">' + r.m.meanPair.toFixed(2) + '</div>'
        +  (delta != null
              ? '<div style="font-size:10px;font-weight:700;color:' + (delta > 0.05 ? '#8B2A2A' : delta < -0.05 ? '#2E7D52' : 'var(--text-sec)') + ';">'
                + (delta >= 0 ? '+' : '') + delta.toFixed(2) + ' vs all</div>'
              : '<div style="font-size:10px;color:var(--text-sec);">baseline</div>')
        +  '<div style="font-size:9px;color:var(--text-sec);">' + r.m.nObs + ' sessions</div>'
        +  '</div>';
    });
    h += '</div>';

    // Per-asset table across regimes
    /* FIXED 2026-07-25: this line referenced `order` before its `var` assignment
       further down. `var` hoists the declaration but not the value, so `order`
       was undefined and `.length` threw
           "Cannot read properties of undefined (reading 'length')"
       which is exactly what the Regime Compare view reported. Row count now
       comes from base.avg, which is already in scope here. */
    var rfs = base.avg.length > 16 ? 9.5 : base.avg.length > 12 ? 10.2 : 11;
    h += '<div style="width:100%;"><table style="width:100%;font-size:' + rfs + 'px;border-collapse:collapse;">';
    h += '<thead><tr><th style="text-align:left;padding:4px;position:sticky;top:0;background:var(--navy);color:#fff;">Asset</th>';
    results.forEach(function (r) {
      h += '<th style="text-align:right;padding:4px;position:sticky;top:0;background:var(--navy);color:#fff;font-size:10px;" title="' + esc(r.meta.desc) + '">' + esc(r.meta.label) + '</th>';
    });
    h += '<th style="text-align:right;padding:4px;position:sticky;top:0;background:var(--navy);color:#fff;font-size:10px;" title="How much this asset\'s average correlation rises from calm conditions to SPY down days. A large positive number means its diversification disappears exactly when you need it.">Stress&nbsp;Δ</th>';
    h += '</tr></thead><tbody>';

    var order = base.avg.slice().sort(function (a, b) { return b.avg - a.avg; });
    order.forEach(function (row) {
      h += '<tr style="border-bottom:1px solid var(--border);"><td style="padding:4px;font-weight:600;">' + esc(shortTicker(row.ticker)) + '</td>';
      var vals = {};
      results.forEach(function (r) {
        if (r.m.error) { h += '<td style="padding:4px;text-align:right;color:var(--text-sec);">—</td>'; return; }
        var found = r.m.avg.filter(function (a) { return a.ticker === row.ticker; })[0];
        var v = found ? found.avg : null;
        vals[r.key] = v;
        var col = v == null ? 'var(--text-sec)' : v > 0.7 ? '#8B2A2A' : v > 0.45 ? '#8B6914' : '#2E7D52';
        h += '<td style="padding:4px;text-align:right;font-family:Courier New,monospace;color:' + col + ';">' + (v == null ? '—' : v.toFixed(2)) + '</td>';
      });
      var d = (vals.downside1 != null && vals.risk_on != null) ? vals.downside1 - vals.risk_on : null;
      var dc = d == null ? 'var(--text-sec)' : d > 0.15 ? '#8B2A2A' : d > 0.05 ? '#8B6914' : '#2E7D52';
      h += '<td style="padding:4px;text-align:right;font-family:Courier New,monospace;font-weight:700;color:' + dc + ';" '
        +  'title="Average correlation on SPY down days minus average correlation in Risk-On conditions.">'
        +  (d == null ? '—' : (d >= 0 ? '+' : '') + d.toFixed(2)) + '</td>';
      h += '</tr>';
    });
    h += '</tbody></table></div>';
    return h;
  }

  function viewClusters(m) {
    /* Greedy correlation clustering: repeatedly seed a cluster with the
       highest-correlation unassigned pair and absorb anything above threshold.
       Not hierarchical clustering — deliberately simple and explainable, since
       the point is "these names are the same bet", not a dendrogram. */
    var THR = 0.65;
    var n = m.tickers.length, assigned = {}, clusters = [];
    for (var pass = 0; pass < n; pass++) {
      var best = null;
      for (var i = 0; i < n; i++) {
        if (assigned[i]) continue;
        for (var j = i + 1; j < n; j++) {
          if (assigned[j]) continue;
          if (m.matrix[i][j] >= THR && (!best || m.matrix[i][j] > best.v)) best = { i: i, j: j, v: m.matrix[i][j] };
        }
      }
      if (!best) break;
      var members = [best.i, best.j];
      assigned[best.i] = assigned[best.j] = 1;
      for (var k = 0; k < n; k++) {
        if (assigned[k]) continue;
        var meanToCluster = members.reduce(function (s, mm) { return s + m.matrix[k][mm]; }, 0) / members.length;
        if (meanToCluster >= THR) { members.push(k); assigned[k] = 1; }
      }
      clusters.push(members);
    }
    var singles = [];
    for (var q = 0; q < n; q++) if (!assigned[q]) singles.push(q);

    var totMV = m.avg.reduce(function (s, a) { return s + (a.mv || 0); }, 0);
    var h = '<div style="font-size:11px;color:var(--text-sec);margin-bottom:10px;line-height:1.6;">'
      +  'Groups whose members correlate above <strong>' + THR + '</strong> with each other. Each cluster is effectively '
      +  '<strong>one bet</strong> — if you hold five names from the same cluster you have concentration, not diversification, '
      +  'however many tickers the position count shows.'
      +  '</div>';

    if (!clusters.length) {
      h += '<div style="padding:12px;background:#E8F3EC;border-left:4px solid #2E7D52;border-radius:0 4px 4px 0;font-size:12px;">'
        +  '<strong>No tight clusters found.</strong> No pair in this universe correlates above ' + THR + ' under the selected condition — '
        +  'genuinely diversified on this measure.</div>';
    }
    clusters.forEach(function (c, ci) {
      var mv = c.reduce(function (s, i) { return s + (m.avg[i].mv || 0); }, 0);
      var inner = 0, cnt = 0;
      for (var a = 0; a < c.length; a++) for (var b = a + 1; b < c.length; b++) { inner += m.matrix[c[a]][c[b]]; cnt++; }
      h += '<div style="margin-bottom:8px;padding:9px 12px;background:rgba(139,42,42,.06);border-left:4px solid #8B2A2A;border-radius:0 4px 4px 0;">'
        +  '<div style="font-size:11px;font-weight:700;color:#8B2A2A;">Cluster ' + (ci + 1)
        +    ' <span style="font-weight:400;color:var(--text-sec);">— ' + c.length + ' names, internal corr '
        +    (cnt ? (inner / cnt).toFixed(2) : '—')
        +    (totMV > 0 ? ', ' + (mv / totMV * 100).toFixed(1) + '% of portfolio' : '') + '</span></div>'
        +  '<div style="font-size:12px;margin-top:3px;">' + c.map(function (i) { return esc(shortTicker(m.tickers[i])); }).join(' · ') + '</div>'
        +  '</div>';
    });
    if (singles.length) {
      h += '<div style="margin-top:10px;padding:9px 12px;background:#E8F3EC;border-left:4px solid #2E7D52;border-radius:0 4px 4px 0;">'
        +  '<div style="font-size:11px;font-weight:700;color:#2E7D52;">Independent <span style="font-weight:400;color:var(--text-sec);">— ' + singles.length + ' names below the clustering threshold</span></div>'
        +  '<div style="font-size:12px;margin-top:3px;">' + singles.map(function (i) { return esc(shortTicker(m.tickers[i])); }).join(' · ') + '</div>'
        +  '</div>';
    }
    return h;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     CONTROLS + MAIN RENDER
     ══════════════════════════════════════════════════════════════════════════ */

  var VIEWS = [
    { key: 'heatmap',  label: 'Heatmap',          desc: 'Full pairwise matrix.' },
    { key: 'diversify', label: 'Diversification', desc: 'Average correlation per asset — who is redundant and who is earning their place.' },
    { key: 'regimes',  label: 'Regime Compare',   desc: 'The same universe under every condition side by side, with a stress delta per asset.' },
    { key: 'clusters', label: 'Clusters',         desc: 'Groups that are effectively one bet.' }
  ];

  function controlsHtml() {
    var st = CW._state;
    var btn = function (active, onclick, label, title) {
      return '<button onclick="' + onclick + '" title="' + esc(title || '') + '" style="'
        + 'padding:3px 9px;font-size:11px;border-radius:4px;cursor:pointer;white-space:nowrap;'
        + (active ? 'background:var(--navy);color:#fff;border:1px solid var(--navy);font-weight:700;'
                  : 'background:#fff;color:var(--navy);border:1px solid var(--border);')
        + '">' + label + '</button>';
    };
    var row = function (label, content, tip) {
      return '<div style="display:flex;align-items:center;gap:7px;margin-bottom:6px;flex-wrap:wrap;">'
        + '<span style="font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-sec);min-width:66px;font-weight:600;">'
        + label + (tip ? ' <span class="help-icon" style="font-size:9px;" title="' + esc(tip) + '">?</span>' : '') + '</span>'
        + content + '</div>';
    };

    var h = '';

    // Universe
    h += row('Universe',
      btn(st.universe === 'holdings', "PerryCorr.set('universe','holdings')", 'My Holdings', 'Your actual positions, deduplicated across accounts.')
      + btn(st.universe === 'sectors', "PerryCorr.set('universe','sectors')", 'SPDR Sectors', 'The 11 GICS sector ETFs plus homebuilders and semis.')
      + btn(st.universe === 'assets', "PerryCorr.set('universe','assets')", 'Asset Classes', 'Equities, duration, credit, metals, energy, dollar and crypto.'),
      'Which set of assets to correlate.');

    // Account — only meaningful for holdings
    if (st.universe === 'holdings') {
      var accts = accountsList();
      var ac = btn(st.account === 'ALL', "PerryCorr.set('account','ALL')", 'All Accounts',
                   'Every account combined. A ticker held in two accounts appears ONCE — the same asset in two wrappers is not diversification.');
      accts.forEach(function (a) {
        ac += btn(st.account === a, "PerryCorr.set('account','" + a.replace(/'/g, "\\'") + "')", esc(a), 'Only positions in ' + esc(a) + '.');
      });
      h += row('Account', ac || '<span style="font-size:11px;color:var(--text-sec);">No holdings loaded</span>',
        'Filter to one account, or combine them all with duplicate tickers collapsed.');
    }

    // Regime
    var rg = '';
    REGIMES.forEach(function (r) {
      rg += btn(st.regime === r.key, "PerryCorr.set('regime','" + r.key + "')", esc(r.label), r.desc);
    });
    h += row('Condition', rg, 'Restrict the calculation to sessions matching a market condition. Correlations are not stable across regimes — that instability is the point.');

    // Lookback
    h += row('Lookback',
      ['1y', '3y', '5y'].map(function (r) {
        return btn(st.lookback === r, "PerryCorr.set('lookback','" + r + "')", r.toUpperCase(), 'Use the last ' + r + ' of sessions.');
      }).join(''),
      'How far back to draw sessions from.');

    // View
    var vw = '';
    VIEWS.forEach(function (v) {
      vw += btn(st.view === v.key, "PerryCorr.set('view','" + v.key + "')", esc(v.label), v.desc);
    });
    h += row('View', vw, 'All four views read the same return matrix — switching repaints in place without refetching.');

    return h;
  }

  CW.set = function (key, val) {
    CW._state[key] = val;
    CW.render();
  };

  CW.render = function () {
    var host = el('corrWorkbench');
    if (!host) return;
    var st = CW._state;

    // Controls always paint immediately so the UI never feels stuck.
    var ctrlEl = el('corrControls');
    if (ctrlEl) ctrlEl.innerHTML = controlsHtml();

    var view = el('corrViewport');
    if (!view) return;

    var universe = currentUniverse();
    if (!universe.length) {
      view.innerHTML = '<div style="padding:20px;text-align:center;font-size:12px;color:var(--text-sec);">'
        + (st.universe === 'holdings'
            ? 'No holdings in this selection. Add positions on the Holdings tab, or switch to SPDR Sectors / Asset Classes.'
            : 'Universe is empty.')
        + '</div>';
      return;
    }
    if (universe.length < 2) {
      view.innerHTML = '<div style="padding:20px;text-align:center;font-size:12px;color:var(--text-sec);">'
        + 'Correlation needs at least 2 distinct assets — this selection has ' + universe.length + '.</div>';
      return;
    }

    view.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-sec);font-size:12px;">'
      + '<span class="spinner"></span> Loading ' + universe.length + ' assets&hellip;</div>';

    Promise.all([loadRegimeSeries(), loadPrices(universe.map(function (u) { return u.ticker; }), st.lookback)])
      .then(function () {
        var body;
        if (st.view === 'regimes') {
          body = viewRegimeCompare(universe, st.lookback);
          CW._lastMatrix = buildMatrix(universe, 'all', st.lookback);
        } else {
          var m = buildMatrix(universe, st.regime, st.lookback);
          CW._lastMatrix = m;
          if (m.error) {
            body = '<div style="padding:16px;background:' + (m.insufficient ? '#FBF3E0' : '#F7E9E6')
              + ';border-left:4px solid ' + (m.insufficient ? '#8B6914' : '#8B2A2A')
              + ';border-radius:0 4px 4px 0;font-size:12px;line-height:1.7;">' + esc(m.error) + '</div>';
          } else if (st.view === 'heatmap')   body = viewHeatmap(m);
          else if (st.view === 'diversify')   body = viewDiversification(m);
          else if (st.view === 'clusters')    body = viewClusters(m);
          else                                body = viewHeatmap(m);
        }

        // Context header — always states what was actually measured.
        var m2 = CW._lastMatrix;
        var hdr = '';
        if (m2 && !m2.error) {
          var rmeta = REGIMES.filter(function (r) { return r.key === st.regime; })[0] || REGIMES[0];
          hdr = '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;'
            +  'padding:7px 10px;background:var(--panel);border-radius:4px;margin-bottom:10px;font-size:11px;">'
            +  '<span><strong>' + m2.tickers.length + ' assets</strong>'
            +    (st.universe === 'holdings' ? ' · ' + esc(st.account === 'ALL' ? 'all accounts' : st.account) : '')
            +    ' · <strong>' + (st.view === 'regimes' ? 'all conditions' : esc(rmeta.label)) + '</strong>'
            +    ' · ' + m2.nObs + ' of ' + m2.nTotal + ' sessions'
            +    (m2.dateFrom ? ' (' + m2.dateFrom + ' → ' + m2.dateTo + ')' : '')
            +  '</span>'
            +  '<span style="display:inline-flex;gap:10px;align-items:center;">'
            +  '<span style="font-weight:700;color:' + (m2.meanPair > 0.6 ? '#8B2A2A' : m2.meanPair > 0.4 ? '#8B6914' : '#2E7D52') + ';" '
            +    'title="Equal-weighted mean of every unique pair correlation. Above 0.6 the portfolio is effectively one bet.">'
            +    'mean pair corr ' + m2.meanPair.toFixed(2) + '</span>'
            +  (m2.meanPairW != null
                 ? '<span style="font-weight:700;color:' + (m2.meanPairW > 0.6 ? '#8B2A2A' : m2.meanPairW > 0.4 ? '#8B6914' : '#2E7D52') + ';" '
                   + 'title="Position-size-weighted mean pair correlation (w_i × w_j weights) — what the portfolio actually experiences. A high value here with a low equal-weight value means your BIG positions are the correlated ones.">'
                   + '$-weighted ' + m2.meanPairW.toFixed(2) + '</span>'
                 : '')
            +  '</span>'
            +  '</div>';
          if (m2.missing && m2.missing.length) {
            hdr += '<div style="font-size:10px;color:#8B6914;margin-bottom:8px;">'
              + 'No price history for: ' + m2.missing.map(esc).join(', ')
              + ' — excluded rather than zero-filled.</div>';
          }
          // Dedupe disclosure — the fix the user specifically asked for.
          if (st.universe === 'holdings' && st.account === 'ALL') {
            var dupes = (m2.avg || []).filter(function (a) { return a.accounts && a.accounts.length > 1; });
            if (dupes.length) {
              hdr += '<div style="font-size:10px;color:var(--text-sec);margin-bottom:8px;" '
                + 'title="' + esc(dupes.map(function (d) { return d.ticker + ': ' + d.accounts.join(', '); }).join('\n')) + '">'
                + dupes.length + ' ticker' + (dupes.length > 1 ? 's are' : ' is') + ' held in more than one account and counted <strong>once</strong> '
                + '(' + dupes.map(function (d) { return esc(shortTicker(d.ticker)); }).join(', ') + '). '
                + 'Duplicating them would show a spurious 1.00 correlation and overstate diversification.</div>';
            }
          }
        }
        view.innerHTML = hdr + body;
      })
      .catch(function (e) {
        view.innerHTML = '<div style="padding:16px;color:#8B2A2A;font-size:12px;">Correlation workbench error: ' + esc(e.message) + '</div>';
      });
  };

  CW.init = function () {
    if (!el('corrWorkbench')) return;
    if (CW._inited) return;
    CW._inited = true;
    CW.render();
  };

  CW.REGIMES = REGIMES;
  CW.SPDR_SECTORS = SPDR_SECTORS;
  CW.ASSET_CLASSES = ASSET_CLASSES;
  CW.dedupedHoldings = dedupedHoldings;
  CW.accountsList = accountsList;
  CW.buildMatrix = buildMatrix;

  window.PerryCorr = CW;

  // Repaint when holdings arrive, but only if the user is on the holdings universe.
  document.addEventListener('perry:holdings', function () {
    if (CW._inited && CW._state.universe === 'holdings') CW.render();
  });
})();
