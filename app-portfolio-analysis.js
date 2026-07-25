/* ============================================================================
   Perry Asset Management — Portfolio Analysis Workbench
   (app-portfolio-analysis.js)   Added 2026-07-25.
   Load AFTER app.js, app2.js, app-warehouse.js, app-ml.js, app-views.js.

   ─────────────────────────────────────────────────────────────────────────────
   WHAT THIS REPLACES AND WHY
   ─────────────────────────────────────────────────────────────────────────────
   The Analysis tab had two separate things doing overlapping work:

     1. "Account-by-Account Comparison"  — 4 views, 2 canvases, in-place toggles
     2. "Classic Analysis Widgets"       — 4 stacked panels below it:
            Sector Allocation · Asset Class Mix
            Top 10 Positions  · Unrealized G/L by Position

   Sector mix was computed in BOTH (the comparison's stacked bar and the classic
   donut), and everything in the classic block was portfolio-wide with no way to
   scope it to an account or a time window. So you could see your sector mix, or
   your per-account sector mix, but never "sector mix of my top 10 positions in
   the Roth over the last year".

   Also corrected here: the Holding Quality Ranker (the ML ensemble) was moved to
   a collapsed card at the bottom of the tab on 2026-07-24. That read as having
   been dropped. It is now a first-class VIEW inside this workbench, which is what
   consolidation should have meant.

   THE DESIGN
   One card. Three global filters that apply to EVERY view — timeline, accounts,
   top-N — and eight views that switch in place. The filters are the point: they
   are what makes questions like "what share of last year's return came from my
   ten largest positions, and which accounts were they in?" answerable at all.

   Replaces renderAccountComparison() by reassigning window.renderAccountComparison,
   so every existing caller (holdingsShowTab, the Refresh button, loadHoldings)
   keeps working untouched.
   ============================================================================ */

(function () {
  'use strict';

  var PA = {
    filters: {
      timeline: '1y',        // 1m 3m 6m ytd 1y all
      accounts: 'ALL',       // 'ALL' or array of account names
      topN: 'all',           // all | 1 | 5 | 10
      view: 'perf'
    },
    _charts: [],
    _priceCache: {},
    _returnsReady: false
  };

  var CASH_CLASSES = ['Cash', 'Money Market', 'CD'];
  var PALETTE = ['#003C71', '#5B9BD5', '#2E7D52', '#8B6914', '#8B2A2A', '#A23B72',
                 '#4A7C8C', '#6B5B95', '#C47C00', '#5C8A3A', '#8A5C5C', '#3A6B8A'];

  function isCash(h) { return CASH_CLASSES.indexOf(h.assetClass) >= 0; }
  function acctOf(h) { return h.accountType || h.account || 'Individual'; }
  function mvOf(h) {
    return isCash(h) ? (h.costBasis || 0) * (h.quantity || 1)
                     : (h.currentPrice || h.costBasis || 0) * (h.quantity || 0);
  }
  function costOf(h) { return (h.costBasis || 0) * (h.quantity || 0); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function usd(v) {
    if (v == null || !isFinite(v)) return '—';
    var a = Math.abs(v);
    if (a >= 1e6) return (v < 0 ? '-$' : '$') + (a / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (v < 0 ? '-$' : '$') + (a / 1e3).toFixed(1) + 'k';
    return (v < 0 ? '-$' : '$') + a.toFixed(0);
  }
  function pctS(v, d) { return v == null || !isFinite(v) ? '—' : v.toFixed(d == null ? 1 : d) + '%'; }

  /* ══════════════════════════════════════════════════════════════════════════
     TIMELINE RETURNS

     Uses stored OHLC from the warehouse where available. Falls back to
     cost-basis unrealised return when a ticker has no price history, and LABELS
     which one it used — a return measured since purchase is not the same thing
     as a return over the last year, and silently mixing them would make the
     contribution analysis wrong in a way nobody could see.
     ══════════════════════════════════════════════════════════════════════════ */

  var TIMELINES = [
    { key: '1m',  label: '1M',  days: 21 },
    { key: '3m',  label: '3M',  days: 63 },
    { key: '6m',  label: '6M',  days: 126 },
    { key: 'ytd', label: 'YTD', days: null },
    { key: '1y',  label: '1Y',  days: 252 },
    { key: 'all', label: 'All', days: null }
  ];

  /* ── FIXED 2026-07-25: the timeline buttons did nothing ────────────────────
     Price history was only read from the warehouse. On the FMP free tier the
     warehouse fills over roughly a week, so most positions had none and fell
     back to unrealised-return-since-purchase — which is timeline-INDEPENDENT.
     Every timeline button therefore produced identical charts, which correctly
     looked broken.

     Now falls back to the worker's /chart endpoint (Yahoo, free, unmetered) for
     anything the warehouse lacks, exactly as the Correlation Workbench does. The
     timeline works immediately instead of waiting for ingestion to complete. */
  var WORKER_BASE = (typeof WORKER_URL !== 'undefined' && WORKER_URL)
    ? WORKER_URL : 'https://perry-finance-proxy.zachperrybusiness.workers.dev';

  function loadTimelineData(tickers) {
    var need = tickers.filter(function (t) { return PA._priceCache[t] === undefined; });
    if (!need.length) return Promise.resolve();
    var WH = window.PerryWarehouse;

    return Promise.all(need.map(function (t) {
      var whP = (WH && WH.ohlc) ? WH.ohlc(t) : Promise.resolve(null);
      return whP.then(function (o) {
        if (o && o.c && o.c.length > 30) { PA._priceCache[t] = o; return; }
        // Worker fallback — 2y of daily closes covers every timeline except All.
        return fetch(WORKER_BASE + '/chart?symbol=' + encodeURIComponent(t) + '&range=2y&interval=1d')
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            var pts = ((j && j.points) || []).filter(function (p) { return p.close != null; });
            PA._priceCache[t] = pts.length > 30
              ? { d: pts.map(function (p) { return p.date.slice(0, 10); }),
                  c: pts.map(function (p) { return p.close; }) }
              : null;
          })
          .catch(function () { PA._priceCache[t] = null; });
      }).catch(function () { PA._priceCache[t] = null; });
    }));
  }

  /** Return over the selected window, plus the basis used. */
  function windowReturn(h) {
    var t = String(h.ticker || '').toUpperCase();
    var px = PA._priceCache[t];
    var tl = PA.filters.timeline;

    if (isCash(h)) return { ret: 0, basis: 'cash', label: 'Cash — no market return' };

    if (px && px.c && px.d) {
      var c = px.c, d = px.d, startIdx = null;
      if (tl === 'all') startIdx = 0;
      else if (tl === 'ytd') {
        var yr = new Date().getFullYear();
        for (var i = 0; i < d.length; i++) { if (d[i] >= (yr + '-01-01')) { startIdx = i; break; } }
        if (startIdx == null) startIdx = 0;
      } else {
        var n = (TIMELINES.filter(function (x) { return x.key === tl; })[0] || {}).days || 252;
        startIdx = Math.max(0, c.length - 1 - n);
      }
      var a = c[startIdx], b = c[c.length - 1];
      if (a > 0 && b > 0) {
        return { ret: (b / a - 1) * 100, basis: 'price', label: 'Price return ' + d[startIdx] + ' → ' + d[d.length - 1] };
      }
    }

    // Fallback — unrealised since purchase. Explicitly flagged.
    var cost = costOf(h), mv = mvOf(h);
    if (cost > 0) {
      return { ret: (mv / cost - 1) * 100, basis: 'costbasis',
               label: 'No price history — showing unrealised return since purchase, NOT the selected window' };
    }
    return { ret: 0, basis: 'none', label: 'No data' };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     FILTERED POSITION SET
     ══════════════════════════════════════════════════════════════════════════ */

  function activeAccounts() {
    var all = [];
    (window._holdings || []).forEach(function (h) {
      var a = acctOf(h);
      if (all.indexOf(a) < 0) all.push(a);
    });
    all.sort();
    if (PA.filters.accounts === 'ALL') return all;
    var sel = PA.filters.accounts.filter(function (a) { return all.indexOf(a) >= 0; });
    return sel.length ? sel : all;
  }

  /**
   * Positions after applying account and top-N filters.
   * Top-N is computed PER ACCOUNT (the user's framing: "top 1, 5 or 10 top
   * holdings for each account"), not globally.
   */
  function filteredPositions() {
    var accts = activeAccounts();
    var rows = (window._holdings || []).filter(function (h) {
      return h.ticker && accts.indexOf(acctOf(h)) >= 0;
    }).map(function (h) {
      var r = windowReturn(h);
      return {
        ticker: String(h.ticker).toUpperCase(),
        name: h.companyName || h.ticker,
        account: acctOf(h),
        sector: h.sector || 'Unknown',
        assetClass: h.assetClass || 'Unknown',
        mv: mvOf(h), cost: costOf(h),
        isCash: isCash(h),
        ret: r.ret, retBasis: r.basis, retLabel: r.label,
        gl: mvOf(h) - costOf(h),
        raw: h
      };
    });

    if (PA.filters.topN !== 'all') {
      var n = parseInt(PA.filters.topN, 10);
      var byAcct = {};
      rows.forEach(function (r) { (byAcct[r.account] = byAcct[r.account] || []).push(r); });
      var keep = [];
      Object.keys(byAcct).forEach(function (a) {
        byAcct[a].sort(function (x, y) { return y.mv - x.mv; });
        keep = keep.concat(byAcct[a].slice(0, n));
      });
      rows = keep;
    }
    return rows;
  }

  /** Everything grouped by account, with derived stats. */
  function accountStats(rows) {
    var out = {};
    rows.forEach(function (r) {
      var A = out[r.account] = out[r.account] || {
        name: r.account, mv: 0, cost: 0, cash: 0, positions: [], sectors: {}, classes: {}
      };
      A.mv += r.mv; A.cost += r.cost;
      if (r.isCash) A.cash += r.mv;
      A.positions.push(r);
      A.sectors[r.sector] = (A.sectors[r.sector] || 0) + r.mv;
      A.classes[r.assetClass] = (A.classes[r.assetClass] || 0) + r.mv;
    });
    Object.keys(out).forEach(function (a) {
      var A = out[a];
      A.glPct = A.cost > 0 ? (A.mv / A.cost - 1) * 100 : 0;
      A.cashPct = A.mv > 0 ? A.cash / A.mv * 100 : 0;
      var sumSq = 0, topW = 0;
      A.positions.forEach(function (p) {
        var w = A.mv > 0 ? p.mv / A.mv : 0;
        sumSq += w * w;
        if (w > topW) topW = w;
      });
      A.topW = topW * 100;
      A.effN = sumSq > 0 ? 1 / sumSq : 0;
      A.positions.sort(function (x, y) { return y.mv - x.mv; });
      // Weighted window return for the account.
      A.windowRet = A.mv > 0
        ? A.positions.reduce(function (s, p) { return s + (p.mv / A.mv) * p.ret; }, 0) : 0;
    });
    return out;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     RETURN CONTRIBUTION

     The analysis behind "what % of my past year's returns came from my top 10
     holdings, and which accounts were they in?"

     contribution_i = weight_i × return_i

     Two different questions get two different answers, and conflating them is a
     common error, so both are reported:
       • LARGEST-N   — the contribution of your N biggest positions by value
       • TOP-N DRIVERS — the N positions that actually produced the most return,
                         which is frequently NOT the same set
     ══════════════════════════════════════════════════════════════════════════ */

  function contributionAnalysis(rows) {
    var total = rows.reduce(function (s, r) { return s + r.mv; }, 0);
    if (total <= 0) return null;

    var contrib = rows.map(function (r) {
      return {
        ticker: r.ticker, account: r.account, mv: r.mv,
        weight: r.mv / total * 100,
        ret: r.ret,
        contrib: (r.mv / total) * r.ret,   // percentage points of portfolio return
        retBasis: r.retBasis
      };
    });

    var portRet = contrib.reduce(function (s, c) { return s + c.contrib; }, 0);
    var bySize = contrib.slice().sort(function (a, b) { return b.mv - a.mv; });
    var byContrib = contrib.slice().sort(function (a, b) { return b.contrib - a.contrib; });

    /* ── REWORKED 2026-07-25 ─────────────────────────────────────────────────
       The previous table showed Top 1 / Top 5 / Top 10 as independent rows whose
       shares could exceed 100%. The arithmetic was right — contributions sum to
       the portfolio return exactly, verified to 1e-9 — but a "share of return"
       reading 104% looks like a broken calculation, and explaining it in a note
       was the wrong fix.

       Now the rows are explicitly CUMULATIVE TIERS that partition the portfolio:

           Top 1          weight  w1   contribution  c1   share  s1
           Top 2-5        weight  w2   contribution  c2   share  s2
           Top 6-10       weight  w3   contribution  c3   share  s3
           Remaining      weight  w4   contribution  c4   share  s4
           ─────────────────────────────────────────────────────────
           Total          100%              portRet        100%

       Every column now sums to its total, so an individual tier CAN exceed 100%
       only when another tier is negative — and you can see that tier sitting
       right there in the table. That is self-explanatory in a way a footnote
       never was. A running cumulative column is included as well, since "top 10
       gave me 92% of my return" is the phrasing people actually want. */
    function tier(list, from, to, label) {
      var sub = list.slice(from, to);
      var c = sub.reduce(function (s, x) { return s + x.contrib; }, 0);
      return {
        label: label, names: sub, count: sub.length,
        contribPP: c,
        sharePct: Math.abs(portRet) > 0.01 ? c / portRet * 100 : null,
        weightPct: sub.reduce(function (s, x) { return s + x.weight; }, 0)
      };
    }

    /** Partition a ranked list into 1 / 2-5 / 6-10 / remainder, with running totals. */
    function tiers(list) {
      var n = list.length;
      var out = [];
      out.push(tier(list, 0, Math.min(1, n), 'Top 1'));
      if (n > 1) out.push(tier(list, 1, Math.min(5, n), n > 5 ? 'Top 2–5' : 'Top 2–' + n));
      if (n > 5) out.push(tier(list, 5, Math.min(10, n), n > 10 ? 'Top 6–10' : 'Top 6–' + n));
      if (n > 10) out.push(tier(list, 10, n, 'Remaining (' + (n - 10) + ')'));
      // Running cumulative so "top 10 = X% of return" is directly readable.
      var cw = 0, cc = 0;
      out.forEach(function (t) {
        cw += t.weightPct; cc += t.contribPP;
        t.cumWeight = cw; t.cumContrib = cc;
        t.cumShare = Math.abs(portRet) > 0.01 ? cc / portRet * 100 : null;
      });
      return out;
    }

    var mixed = contrib.some(function (c) { return c.retBasis === 'costbasis'; });

    return {
      portRet: portRet,
      total: total,
      largest: tiers(bySize),
      drivers: tiers(byContrib),
      allByContrib: byContrib,
      laggards: byContrib.slice().reverse().slice(0, 5),
      mixedBasis: mixed,
      nPositions: contrib.length
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     CONCENTRATION DRILL-DOWN POPUP
     ══════════════════════════════════════════════════════════════════════════ */

  function closePopup() {
    var p = document.getElementById('paPopup');
    if (p) p.remove();
  }

  PA.showAccountPopup = function (acctName, x, y) {
    closePopup();
    var rows = filteredPositions();
    var stats = accountStats(rows);
    var A = stats[acctName];
    if (!A) return;

    var n = PA.filters.topN === 'all' ? A.positions.length : parseInt(PA.filters.topN, 10);
    var top = A.positions.slice(0, n);
    var shown = top.reduce(function (s, p) { return s + p.mv; }, 0);
    var other = A.mv - shown;

    var host = document.createElement('div');
    host.id = 'paPopup';
    host.style.cssText = 'position:fixed;z-index:9999;background:var(--bg,#fff);border:1px solid var(--border,#ccc);'
      + 'box-shadow:0 6px 24px rgba(0,0,0,.22);border-radius:8px;padding:12px 14px;min-width:230px;max-width:320px;'
      + 'font-size:12px;line-height:1.65;';

    var h = '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:7px;">'
      + '<strong style="color:var(--navy,#003C71);font-size:13px;">'
      +   (PA.filters.topN === 'all' ? 'All Holdings' : 'Top ' + n + ' Holdings')
      +   '<div style="font-weight:400;font-size:11px;color:var(--text-sec,#667);">' + esc(acctName) + ' &middot; ' + usd(A.mv) + '</div>'
      + '</strong>'
      + '<span onclick="PerryPortfolioAnalysis.closePopup()" style="cursor:pointer;font-size:15px;line-height:1;color:var(--text-sec,#667);" title="Close">&times;</span>'
      + '</div>';

    h += '<ul style="margin:0;padding-left:16px;">';
    top.forEach(function (p) {
      var w = A.mv > 0 ? p.mv / A.mv * 100 : 0;
      var rc = p.ret >= 0 ? '#2E7D52' : '#8B2A2A';
      h += '<li style="margin-bottom:3px;">'
        + '<strong>' + esc(p.ticker) + '</strong> &mdash; ' + pctS(w)
        + ' <span style="color:' + rc + ';font-size:11px;">('
        + (p.ret >= 0 ? '+' : '') + pctS(p.ret) + ')</span>'
        + (p.retBasis === 'costbasis' ? '<span title="No price history for this ticker — return shown is unrealised since purchase, not over the selected window." style="color:#8B6914;">*</span>' : '')
        + '</li>';
    });
    if (other > 0.5) {
      h += '<li style="margin-bottom:3px;color:var(--text-sec,#667);">'
        + 'Remaining ' + (A.positions.length - top.length) + ' position'
        + (A.positions.length - top.length === 1 ? '' : 's') + ' &mdash; ' + pctS(other / A.mv * 100) + '</li>';
    }
    h += '</ul>';

    h += '<div style="margin-top:8px;padding-top:7px;border-top:1px solid var(--border,#ddd);font-size:11px;color:var(--text-sec,#667);">'
      + 'Cash held: <strong>' + pctS(A.cashPct) + '</strong>'
      + ' &middot; Effective positions: <strong>' + A.effN.toFixed(1) + '</strong>'
      + '<div style="font-size:10px;margin-top:3px;" title="Inverse Herfindahl index. An account with 20 positions but an effective count of 3 behaves like a 3-position portfolio.">'
      + 'Weighted return this window: <strong style="color:' + (A.windowRet >= 0 ? '#2E7D52' : '#8B2A2A') + ';">'
      + (A.windowRet >= 0 ? '+' : '') + pctS(A.windowRet) + '</strong></div>'
      + '</div>';

    host.innerHTML = h;
    document.body.appendChild(host);

    // Keep the popup on screen.
    var r = host.getBoundingClientRect();
    var left = Math.min(Math.max(8, x - r.width / 2), window.innerWidth - r.width - 8);
    var top2 = y - r.height - 12;
    if (top2 < 8) top2 = y + 16;
    host.style.left = left + 'px';
    host.style.top = top2 + 'px';

    setTimeout(function () {
      document.addEventListener('click', function once(ev) {
        if (host.contains(ev.target)) { document.addEventListener('click', once, { once: true }); return; }
        closePopup();
      }, { once: true });
    }, 60);
  };
  PA.closePopup = closePopup;

  /* ══════════════════════════════════════════════════════════════════════════
     FILTER BAR
     ══════════════════════════════════════════════════════════════════════════ */

  function filterBar() {
    var f = PA.filters;
    var allAccts = [];
    (window._holdings || []).forEach(function (h) {
      var a = acctOf(h); if (allAccts.indexOf(a) < 0) allAccts.push(a);
    });
    allAccts.sort();
    var active = activeAccounts();

    var btn = function (on, click, label, title) {
      return '<button onclick="' + click + '" title="' + esc(title || '') + '" style="'
        + 'padding:3px 9px;font-size:11px;border-radius:4px;cursor:pointer;white-space:nowrap;margin:0;'
        + (on ? 'background:var(--navy);color:#fff;border:1px solid var(--navy);font-weight:700;'
              : 'background:#fff;color:var(--navy);border:1px solid var(--border);') + '">' + label + '</button>';
    };
    var row = function (label, content, tip) {
      return '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap;">'
        + '<span style="font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-sec);'
        + 'min-width:74px;font-weight:600;">' + label
        + (tip ? ' <span class="help-icon" style="font-size:9px;" title="' + esc(tip) + '">?</span>' : '')
        + '</span>' + content + '</div>';
    };

    var h = '';

    h += row('Timeline',
      TIMELINES.map(function (t) {
        return btn(f.timeline === t.key, "PerryPortfolioAnalysis.set('timeline','" + t.key + "')", t.label,
          'Measure returns over ' + t.label + '. Uses stored price history; positions without it fall back to unrealised return since purchase and are marked with an asterisk.');
      }).join(''),
      'Every return, contribution and G/L figure below is measured over this window.');

    var ac = btn(f.accounts === 'ALL', "PerryPortfolioAnalysis.set('accounts','ALL')", 'All',
                 'Include every account.');
    allAccts.forEach(function (a) {
      var on = f.accounts !== 'ALL' && f.accounts.indexOf(a) >= 0;
      ac += btn(on, "PerryPortfolioAnalysis.toggleAccount('" + a.replace(/'/g, "\\'") + "')", esc(a),
                'Click to include or exclude ' + esc(a) + '. Multiple accounts can be active at once.');
    });
    h += row('Accounts', ac || '<span style="font-size:11px;color:var(--text-sec);">No accounts</span>',
      'Toggle accounts on and off. Charts, contribution analysis and the ranker all respect this selection.');

    h += row('Top holdings',
      [['all', 'All'], ['1', 'Top 1'], ['5', 'Top 5'], ['10', 'Top 10']].map(function (t) {
        return btn(f.topN === t[0], "PerryPortfolioAnalysis.set('topN','" + t[0] + "')", t[1],
          t[0] === 'all' ? 'Every position.' : 'Only the ' + t[0] + ' largest positions IN EACH ACCOUNT, by market value.');
      }).join(''),
      'Restricts the position set to the largest N per account — not the largest N overall — so each account is represented.');

    h += row('View',
      VIEWS.map(function (v) {
        return btn(f.view === v.key, "PerryPortfolioAnalysis.set('view','" + v.key + "')", v.label, v.desc);
      }).join(''),
      'All views share the filters above.');

    // Live scope summary so the user always knows what is being measured.
    var rows = filteredPositions();
    var tot = rows.reduce(function (s, r) { return s + r.mv; }, 0);
    var fallback = rows.filter(function (r) { return r.retBasis === 'costbasis'; }).length;
    h += '<div style="margin-top:4px;font-size:10.5px;color:var(--text-sec);">'
      + '<strong>Scope:</strong> ' + rows.length + ' position' + (rows.length === 1 ? '' : 's')
      + ' across ' + active.length + ' account' + (active.length === 1 ? '' : 's')
      + ' &middot; ' + usd(tot)
      + ' &middot; ' + (TIMELINES.filter(function (t) { return t.key === f.timeline; })[0] || {}).label + ' window'
      + (fallback ? ' &middot; <span style="color:#8B6914;" title="These positions have no stored price history, so their return is unrealised-since-purchase rather than the selected window. They are marked with an asterisk wherever they appear.">'
          + fallback + ' using cost-basis fallback*</span>' : '')
      + '</div>';

    return h;
  }

  PA.set = function (k, v) { PA.filters[k] = v; closePopup(); PA.render(true); };
  PA.toggleAccount = function (a) {
    var f = PA.filters;
    if (f.accounts === 'ALL') {
      var all = [];
      (window._holdings || []).forEach(function (h) { var x = acctOf(h); if (all.indexOf(x) < 0) all.push(x); });
      f.accounts = all.filter(function (x) { return x !== a; });
      if (!f.accounts.length) f.accounts = 'ALL';
    } else {
      var i = f.accounts.indexOf(a);
      if (i >= 0) f.accounts.splice(i, 1); else f.accounts.push(a);
      if (!f.accounts.length) f.accounts = 'ALL';
    }
    closePopup();
    PA.render(true);
  };

  /* ══════════════════════════════════════════════════════════════════════════
     VIEWS
     ══════════════════════════════════════════════════════════════════════════ */

  var VIEWS = [
    { key: 'perf',    label: 'Size & Return',   desc: 'Account value and return over the selected window, side by side.' },
    { key: 'sector',  label: 'Sector',          desc: 'Sector allocation — donut for the filtered set plus per-account stacked mix. Absorbed from the old Classic Analysis Widgets.' },
    { key: 'assets',  label: 'Asset Class',     desc: 'Asset class mix — donut plus per-account breakdown. Absorbed from the old Classic Analysis Widgets.' },
    { key: 'conc',    label: 'Concentration',   desc: 'Top-position weight and effective position count. CLICK ANY BAR to see that account\'s top holdings.' },
    { key: 'gl',      label: 'Unrealized G/L',  desc: 'Gain and loss by position. Absorbed from the old Classic Analysis Widgets.' },
    { key: 'contrib', label: 'Contribution',    desc: 'What share of your return came from your largest positions, and which accounts held them.' },
    { key: 'income',  label: 'Income',          desc: 'Weighted dividend yield and projected annual income by account.' },
    { key: 'quality', label: 'Quality Ranker',  desc: 'The factor + ML ensemble ranking of every holding against its industry peers.' }
  ];

  function destroyCharts() {
    PA._charts.forEach(function (c) { try { c.destroy(); } catch (e) {} });
    PA._charts = [];
  }

  function baseOpts(extra) {
    return Object.assign({
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { position: 'top', labels: { font: { size: 10 } } } }
    }, extra || {});
  }

  function twoPane(t1, t2) {
    return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;" class="acct-cmp-grid">'
      + '<div><div style="font-size:11px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px;">' + t1 + '</div>'
      +   '<div style="height:300px;position:relative;"><canvas id="paChartA"></canvas></div></div>'
      + '<div><div style="font-size:11px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px;">' + t2 + '</div>'
      +   '<div style="height:300px;position:relative;"><canvas id="paChartB"></canvas></div></div>'
      + '</div>';
  }

  function donutConfig(labelMap) {
    var labels = Object.keys(labelMap).sort(function (a, b) { return labelMap[b] - labelMap[a]; });
    var total = labels.reduce(function (s, k) { return s + labelMap[k]; }, 0);
    return {
      type: 'doughnut',
      data: { labels: labels, datasets: [{ data: labels.map(function (k) { return labelMap[k]; }),
        backgroundColor: labels.map(function (_, i) { return PALETTE[i % PALETTE.length]; }), borderWidth: 1, borderColor: '#fff' }] },
      options: baseOpts({
        cutout: '55%',
        plugins: { legend: { position: 'right', labels: { font: { size: 10 }, boxWidth: 10 } },
          tooltip: { callbacks: { label: function (c) {
            return c.label + ': ' + usd(c.parsed) + ' (' + (total > 0 ? (c.parsed / total * 100).toFixed(1) : 0) + '%)';
          } } } }
      })
    };
  }

  function stackedByAccount(stats, names, key) {
    var keys = [];
    names.forEach(function (a) { Object.keys(stats[a][key]).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); }); });
    var ds = keys.map(function (k, i) {
      return { label: k, backgroundColor: PALETTE[i % PALETTE.length],
        data: names.map(function (a) {
          var tot = Object.keys(stats[a][key]).reduce(function (s, x) { return s + stats[a][key][x]; }, 0);
          return tot > 0 ? +(((stats[a][key][k] || 0) / tot) * 100).toFixed(1) : 0;
        }) };
    });
    return { type: 'bar', data: { labels: names, datasets: ds },
      options: baseOpts({
        plugins: { legend: { position: 'bottom', labels: { font: { size: 9 }, boxWidth: 10 } },
          tooltip: { callbacks: { label: function (c) { return c.dataset.label + ': ' + c.parsed.y + '%'; } } } },
        scales: { x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 } } },
                  y: { stacked: true, max: 100, ticks: { callback: function (v) { return v + '%'; }, font: { size: 10 } } } }
      }) };
  }

  function renderContribution(rows) {
    var ca = contributionAnalysis(rows);
    if (!ca) return '<p style="font-size:12px;color:var(--text-sec);padding:12px;">No positions in scope.</p>';

    var tlLabel = (TIMELINES.filter(function (t) { return t.key === PA.filters.timeline; })[0] || {}).label;
    var h = '';

    h += '<div style="font-size:11.5px;color:var(--text-sec);line-height:1.7;margin-bottom:10px;">'
      + 'Contribution is <strong>weight &times; return</strong>, so it sums to the portfolio return. '
      + 'Two different questions are answered separately because they usually have different answers: '
      + 'the contribution of your <strong>biggest</strong> positions, and the contribution of your '
      + '<strong>best-performing</strong> ones.'
      + (ca.mixedBasis ? ' <span style="color:#8B6914;">Some positions lack price history and use unrealised-since-purchase return instead of the ' + tlLabel + ' window — those are marked with an asterisk and make the total approximate.</span>' : '')
      + '</div>';

    var pc = ca.portRet >= 0 ? '#2E7D52' : '#8B2A2A';
    h += '<div style="padding:9px 12px;background:' + pc + '10;border-left:4px solid ' + pc + ';border-radius:0 4px 4px 0;margin-bottom:12px;font-size:12px;">'
      + '<strong>Portfolio return over ' + tlLabel + ': <span style="color:' + pc + ';">'
      + (ca.portRet >= 0 ? '+' : '') + pctS(ca.portRet, 2) + '</span></strong>'
      + ' <span style="color:var(--text-sec);">across ' + ca.nPositions + ' positions, ' + usd(ca.total) + '</span>'
      + '</div>';

    function block(title, list, tip) {
      var s = '<div style="font-size:11px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:.4px;margin:10px 0 5px;">'
        + title + ' <span class="help-icon" style="font-size:9px;" title="' + esc(tip) + '">?</span></div>';
      s += '<table style="width:100%;font-size:11px;border-collapse:collapse;">'
        + '<thead><tr style="background:var(--navy);color:#fff;">'
        + '<th style="text-align:left;padding:4px 5px;">Tier</th>'
        + '<th style="text-align:right;padding:4px 5px;">Weight</th>'
        + '<th style="text-align:right;padding:4px 5px;">Contribution</th>'
        + '<th style="text-align:right;padding:4px 5px;" title="This tier\'s share of the total portfolio return. Tiers partition the portfolio, so the column sums to 100%.">Share</th>'
        + '<th style="text-align:right;padding:4px 5px;" title="Running total down the table — read this to answer &quot;what share of my return came from my top N?&quot;">Cumulative</th>'
        + '<th style="text-align:left;padding:4px 5px;">Positions &amp; accounts</th>'
        + '</tr></thead><tbody>';

      list.forEach(function (g) {
        var sc = g.sharePct == null ? 'var(--text-sec)'
               : g.sharePct < 0 ? '#8B2A2A'
               : g.sharePct > 60 ? '#8B6914' : 'var(--text-pri)';
        var acctSet = {};
        g.names.forEach(function (x) { acctSet[x.account] = (acctSet[x.account] || 0) + 1; });
        var isRemainder = /Remaining/.test(g.label);
        s += '<tr style="border-bottom:1px solid var(--border);' + (isRemainder ? 'background:rgba(0,0,0,.025);' : '') + '">'
          + '<td style="padding:3px 5px;font-weight:600;">' + esc(g.label) + '</td>'
          + '<td style="padding:3px 5px;text-align:right;font-family:Courier New,monospace;">' + pctS(g.weightPct) + '</td>'
          + '<td style="padding:3px 5px;text-align:right;font-family:Courier New,monospace;color:' + (g.contribPP >= 0 ? '#2E7D52' : '#8B2A2A') + ';">'
          +   (g.contribPP >= 0 ? '+' : '') + pctS(g.contribPP, 2) + 'pp</td>'
          + '<td style="padding:3px 5px;text-align:right;font-weight:700;color:' + sc + ';">'
          +   (g.sharePct == null ? 'n/a' : pctS(g.sharePct, 0)) + '</td>'
          + '<td style="padding:3px 5px;text-align:right;font-weight:700;font-family:Courier New,monospace;">'
          +   (g.cumShare == null ? 'n/a' : pctS(g.cumShare, 0)) + '</td>'
          + '<td style="padding:3px 5px;font-size:10px;">'
          +   (g.count > 12
                ? g.count + ' positions'
                : g.names.map(function (x) {
                    return '<span title="' + esc(x.ticker + ' — ' + x.account + ' · weight ' + pctS(x.weight) + ' · return ' + pctS(x.ret) + ' · contribution ' + pctS(x.contrib, 2) + 'pp') + '">'
                      + esc(x.ticker) + (x.retBasis === 'costbasis' ? '*' : '') + '</span>';
                  }).join(', '))
          +   '<div style="color:var(--text-sec);font-size:9.5px;">'
          +   Object.keys(acctSet).map(function (a) { return esc(a) + ' (' + acctSet[a] + ')'; }).join(' · ')
          +   '</div></td>'
          + '</tr>';
      });

      // Totals row — proves the partition closes.
      var tw = list.reduce(function (s2, g) { return s2 + g.weightPct; }, 0);
      var tc = list.reduce(function (s2, g) { return s2 + g.contribPP; }, 0);
      s += '<tr style="border-top:2px solid var(--navy);font-weight:800;">'
        + '<td style="padding:4px 5px;">Total</td>'
        + '<td style="padding:4px 5px;text-align:right;font-family:Courier New,monospace;">' + pctS(tw) + '</td>'
        + '<td style="padding:4px 5px;text-align:right;font-family:Courier New,monospace;color:' + (tc >= 0 ? '#2E7D52' : '#8B2A2A') + ';">'
        +   (tc >= 0 ? '+' : '') + pctS(tc, 2) + 'pp</td>'
        + '<td style="padding:4px 5px;text-align:right;">' + (Math.abs(portRet) > 0.01 ? '100%' : 'n/a') + '</td>'
        + '<td style="padding:4px 5px;text-align:right;">' + (Math.abs(portRet) > 0.01 ? '100%' : 'n/a') + '</td>'
        + '<td style="padding:4px 5px;font-size:9.5px;color:var(--text-sec);">' + ca.nPositions + ' positions</td>'
        + '</tr>';
      s += '</tbody></table>';
      return s;
    }

    h += block('By size — your largest positions', ca.largest,
      'Tiers partition the portfolio by position SIZE. Read the Cumulative column to answer "what share of my return came from my top 10 holdings?" A tier whose share far exceeds its weight outperformed; far below means it lagged and something smaller carried you.');
    h += block('By impact — your actual drivers', ca.drivers,
      'The same partition, but ranked by CONTRIBUTION rather than size. When the top tier here holds different tickers than the by-size table, your return is coming from somewhere other than where your money is.');

    if (Math.abs(ca.portRet) <= 0.01) {
      h += '<div style="margin-top:8px;font-size:11px;color:#8B6914;">Portfolio return is near zero over this window, so "share of return" is not meaningful — a share of nothing. The contribution column in percentage points is still valid.</div>';
    }

    /* The old >100% explainer is gone — the cumulative partition makes it
       self-evident. If a tier exceeds 100% of the return, another tier is
       negative and it is visible two rows away, with the Total row closing at
       exactly 100%. */
    var neg = ca.largest.concat(ca.drivers).filter(function (g) { return g.contribPP < 0; });
    // De-duplicate labels across the two tables.
    var seenLbl = {};
    neg = neg.filter(function (g) { if (seenLbl[g.label]) return false; seenLbl[g.label] = 1; return true; });
    if (neg.length) {
      h += '<div style="margin-top:8px;padding:7px 11px;background:#EDF2F8;border-left:4px solid #003C71;border-radius:0 4px 4px 0;font-size:11px;line-height:1.6;">'
        + '<strong>Reading the table:</strong> '
        + neg.map(function (g) { return esc(g.label); }).join(' and ')
        + ' contributed <em>negatively</em>, so the tiers above them account for more than 100% of the net return. '
        + 'The Total row closes at 100% — that is the partition working, not an error.'
        + '</div>';
    }

    h += '<div style="font-size:11px;font-weight:700;color:#8B2A2A;text-transform:uppercase;letter-spacing:.4px;margin:12px 0 5px;">Biggest detractors</div>';
    h += '<div style="font-size:11.5px;">'
      + ca.laggards.filter(function (l) { return l.contrib < 0; }).map(function (l) {
          return '<span style="display:inline-block;background:rgba(139,42,42,.07);border:1px solid rgba(139,42,42,.3);border-radius:10px;padding:1px 8px;margin:2px;font-size:11px;" '
            + 'title="' + esc(l.account + ' · weight ' + pctS(l.weight) + ' · return ' + pctS(l.ret)) + '">'
            + '<strong>' + esc(l.ticker) + '</strong> ' + pctS(l.contrib, 2) + 'pp</span>';
        }).join('') || '<span style="color:var(--success);font-size:11px;">No position detracted over this window.</span>';
    h += '</div>';

    return h;
  }

  function renderGL(rows) {
    var sorted = rows.filter(function (r) { return !r.isCash; })
      .slice().sort(function (a, b) { return b.gl - a.gl; });
    var h = '<div style="font-size:11.5px;color:var(--text-sec);margin-bottom:8px;line-height:1.6;">'
      + 'Unrealised gain and loss per position in dollars, ranked. Hover a bar for the account and percentage return. '
      + 'This is <strong>since purchase</strong> and does not depend on the timeline filter — unlike every other view here, '
      + 'which is why it is stated separately.'
      + '</div>';
    h += '<div style="height:' + Math.max(280, Math.min(560, sorted.length * 24)) + 'px;position:relative;"><canvas id="paChartA"></canvas></div>';
    PA._glRows = sorted;
    return h;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     MAIN RENDER
     ══════════════════════════════════════════════════════════════════════════ */

  PA.render = function (force) {
    var el = document.getElementById('acctCompareBody');
    if (!el) return;
    var hs = window._holdings || [];
    if (!hs.length) {
      el.innerHTML = '<div style="text-align:center;padding:18px;color:var(--text-sec);font-size:12px;">No holdings loaded.</div>';
      return;
    }

    // Load price history for the timeline before measuring anything.
    var tickers = hs.filter(function (h) { return h.ticker && !isCash(h); })
      .map(function (h) { return String(h.ticker).toUpperCase(); });

    /* Simplified 2026-07-25 — this previously painted TWICE when force was set
       and data was already cached (once synchronously, once in the promise),
       which destroyed and rebuilt every chart mid-interaction. */
    var uncached = tickers.filter(function (t) { return PA._priceCache[t] === undefined; });
    if (uncached.length) {
      el.innerHTML = '<div style="text-align:center;padding:18px;color:var(--text-sec);font-size:12px;">'
        + '<span class="spinner"></span> Loading price history for ' + uncached.length + ' position'
        + (uncached.length === 1 ? '' : 's') + '&hellip;</div>';
      loadTimelineData(tickers).then(function () { PA._returnsReady = true; paint(el); });
      return;
    }
    PA._returnsReady = true;
    paint(el);
  };

  function paint(el) {
    destroyCharts();
    var f = PA.filters;
    var rows = filteredPositions();
    var stats = accountStats(rows);
    var names = Object.keys(stats).sort();

    var body = '';
    if (!rows.length) {
      body = '<div style="padding:16px;font-size:12px;color:var(--text-sec);">No positions match the current filters.</div>';
    } else if (f.view === 'contrib') {
      body = renderContribution(rows);
    } else if (f.view === 'gl') {
      body = renderGL(rows);
    } else if (f.view === 'quality') {
      body = '<div id="holdingRanker"></div>';
    } else if (f.view === 'sector') {
      body = twoPane('Sector Allocation (filtered set)', 'Sector Mix by Account (100% stacked)');
    } else if (f.view === 'assets') {
      body = twoPane('Asset Class Mix (filtered set)', 'Asset Class by Account (100% stacked)');
    } else if (f.view === 'conc') {
      body = '<div style="font-size:11.5px;color:var(--text-sec);margin-bottom:8px;line-height:1.6;">'
        + '<strong>Click any bar</strong> to see that account\'s top holdings. '
        + 'Effective position count is the inverse Herfindahl index: an account with 20 positions but an effective count of 3 '
        + 'behaves like a 3-position portfolio.'
        + '</div>' + twoPane('Top Position Weight &amp; Effective # of Positions', 'Cash Buffer % by Account');
    } else {
      body = twoPane('Value &amp; ' + (TIMELINES.filter(function (t) { return t.key === f.timeline; })[0] || {}).label + ' Return by Account',
                     'Sector Mix by Account (100% stacked)');
    }

    el.innerHTML = '<div id="paFilters" style="padding-bottom:8px;border-bottom:1px solid var(--border);margin-bottom:10px;">'
      + filterBar() + '</div><div id="paViewport">' + body + '</div>';

    if (!rows.length) return;

    // ── Quality Ranker: delegate to the existing renderer ──
    if (f.view === 'quality') {
      if (window.PerryViews && window.PerryViews.renderHoldingRanker) {
        try { window.PerryViews.renderHoldingRanker('holdingRanker'); }
        catch (e) { document.getElementById('holdingRanker').innerHTML =
          '<p style="font-size:12px;color:#8B2A2A;padding:10px;">Ranker error: ' + esc(e.message) + '</p>'; }
      }
      return;
    }

    if (typeof Chart === 'undefined') return;
    var A = document.getElementById('paChartA');
    var B = document.getElementById('paChartB');

    if (f.view === 'gl' && A) {
      var g = PA._glRows;
      PA._charts.push(new Chart(A.getContext('2d'), {
        type: 'bar',
        data: { labels: g.map(function (r) { return r.ticker; }),
          datasets: [{ label: 'Unrealised G/L', data: g.map(function (r) { return +r.gl.toFixed(2); }),
            backgroundColor: g.map(function (r) { return r.gl >= 0 ? 'rgba(46,125,82,.75)' : 'rgba(139,42,42,.75)'; }),
            borderRadius: 3 }] },
        options: baseOpts({
          indexAxis: 'y',
          plugins: { legend: { display: false },
            tooltip: { callbacks: { label: function (c) {
              var r = g[c.dataIndex];
              return [usd(r.gl), r.account, 'Return since purchase: ' + pctS(r.cost > 0 ? (r.mv / r.cost - 1) * 100 : 0)];
            } } } },
          scales: { x: { ticks: { callback: function (v) { return usd(v); }, font: { size: 10 } } },
                    y: { ticks: { font: { size: 10 } }, grid: { display: false } } }
        })
      }));
      return;
    }

    if (!A || !B) return;

    if (f.view === 'sector' || f.view === 'assets') {
      var key = f.view === 'sector' ? 'sectors' : 'classes';
      var agg = {};
      rows.forEach(function (r) {
        var k = f.view === 'sector' ? r.sector : r.assetClass;
        agg[k] = (agg[k] || 0) + r.mv;
      });
      PA._charts.push(new Chart(A.getContext('2d'), donutConfig(agg)));
      PA._charts.push(new Chart(B.getContext('2d'), stackedByAccount(stats, names, key)));
      return;
    }

    if (f.view === 'conc') {
      PA._charts.push(new Chart(A.getContext('2d'), {
        type: 'bar',
        data: { labels: names, datasets: [
          { label: 'Top position weight %', data: names.map(function (a) { return +stats[a].topW.toFixed(1); }),
            backgroundColor: 'rgba(139,42,42,.72)', borderRadius: 3, yAxisID: 'y' },
          { label: 'Effective # positions', data: names.map(function (a) { return +stats[a].effN.toFixed(1); }),
            backgroundColor: 'rgba(0,60,113,.7)', borderRadius: 3, yAxisID: 'y1' }
        ] },
        options: baseOpts({
          onClick: function (ev, els2) {
            if (!els2 || !els2.length) return;
            var a = names[els2[0].index];
            var rect = A.getBoundingClientRect();
            PA.showAccountPopup(a, rect.left + (els2[0].element.x || rect.width / 2), rect.top + (els2[0].element.y || 40));
          },
          onHover: function (ev, els2) { A.style.cursor = (els2 && els2.length) ? 'pointer' : 'default'; },
          plugins: { tooltip: { callbacks: { afterBody: function () { return ['Click for top holdings']; } } } },
          scales: {
            x: { grid: { display: false }, ticks: { font: { size: 10 } } },
            y: { position: 'left', ticks: { callback: function (v) { return v + '%'; }, font: { size: 10 } },
                 title: { display: true, text: 'Top weight', font: { size: 9 } } },
            y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { font: { size: 10 } },
                  title: { display: true, text: 'Effective #', font: { size: 9 } } }
          }
        })
      }));
      PA._charts.push(new Chart(B.getContext('2d'), {
        type: 'bar',
        data: { labels: names, datasets: [{ label: 'Cash %', data: names.map(function (a) { return +stats[a].cashPct.toFixed(1); }),
          backgroundColor: 'rgba(91,155,213,.75)', borderRadius: 3 }] },
        options: baseOpts({
          onClick: function (ev, els2) {
            if (!els2 || !els2.length) return;
            var a = names[els2[0].index];
            var rect = B.getBoundingClientRect();
            PA.showAccountPopup(a, rect.left + (els2[0].element.x || rect.width / 2), rect.top + (els2[0].element.y || 40));
          },
          onHover: function (ev, els2) { B.style.cursor = (els2 && els2.length) ? 'pointer' : 'default'; },
          plugins: { legend: { display: false } },
          scales: { x: { grid: { display: false }, ticks: { font: { size: 10 } } },
                    y: { ticks: { callback: function (v) { return v + '%'; }, font: { size: 10 } } } }
        })
      }));
      return;
    }

    if (f.view === 'income') {
      var yld = names.map(function (a) {
        var A2 = stats[a], w = 0;
        A2.positions.forEach(function (p) { w += p.mv * (parseFloat(p.raw.yieldPct) || 0); });
        return A2.mv > 0 ? +(w / A2.mv).toFixed(2) : 0;
      });
      PA._charts.push(new Chart(A.getContext('2d'), {
        type: 'bar', data: { labels: names, datasets: [{ label: 'Weighted yield %', data: yld, backgroundColor: 'rgba(46,125,82,.72)', borderRadius: 3 }] },
        options: baseOpts({ plugins: { legend: { display: false } },
          scales: { x: { grid: { display: false } }, y: { ticks: { callback: function (v) { return v + '%'; }, font: { size: 10 } } } } })
      }));
      PA._charts.push(new Chart(B.getContext('2d'), {
        type: 'bar', data: { labels: names, datasets: [{ label: 'Projected annual income',
          data: names.map(function (a, i) { return +(stats[a].mv * yld[i] / 100).toFixed(0); }),
          backgroundColor: 'rgba(0,60,113,.7)', borderRadius: 3 }] },
        options: baseOpts({ plugins: { legend: { display: false },
          tooltip: { callbacks: { label: function (c) { return usd(c.parsed.y) + '/yr'; } } } },
          scales: { x: { grid: { display: false } }, y: { ticks: { callback: function (v) { return usd(v); }, font: { size: 10 } } } } })
      }));
      return;
    }

    /* Default: Size & Return — COMBO CHART restored 2026-07-25.
       I replaced the original bar+line combo with two bar series, which lost the
       visual distinction between a level (market value) and a rate (return).
       Back to bars for value on the left axis, a line with points for return on
       the right axis. */
    var tl = (TIMELINES.filter(function (t) { return t.key === f.timeline; })[0] || {}).label;
    PA._charts.push(new Chart(A.getContext('2d'), {
      type: 'bar',
      data: { labels: names, datasets: [
        { type: 'bar', label: 'Market value', order: 2,
          data: names.map(function (a) { return +stats[a].mv.toFixed(0); }),
          backgroundColor: 'rgba(0,60,113,.72)', borderRadius: 3, yAxisID: 'y' },
        { type: 'line', label: tl + ' return %', order: 1,
          data: names.map(function (a) { return +stats[a].windowRet.toFixed(2); }),
          borderColor: '#8B6914', borderWidth: 2.5, tension: 0.25, fill: false,
          pointRadius: 5, pointHoverRadius: 7,
          pointBackgroundColor: names.map(function (a) { return stats[a].windowRet >= 0 ? '#2E7D52' : '#8B2A2A'; }),
          pointBorderColor: '#fff', pointBorderWidth: 1.5, yAxisID: 'y1' }
      ] },
      options: baseOpts({
        onClick: function (ev, els2) {
          if (!els2 || !els2.length) return;
          var a = names[els2[0].index];
          var rect = A.getBoundingClientRect();
          PA.showAccountPopup(a, rect.left + (els2[0].element.x || rect.width / 2), rect.top + (els2[0].element.y || 40));
        },
        onHover: function (ev, els2) { A.style.cursor = (els2 && els2.length) ? 'pointer' : 'default'; },
        plugins: { tooltip: { callbacks: { afterBody: function () { return ['Click for top holdings']; } } } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 } } },
          y: { position: 'left', ticks: { callback: function (v) { return usd(v); }, font: { size: 10 } } },
          y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: function (v) { return v + '%'; }, font: { size: 10 } } }
        }
      })
    }));
    PA._charts.push(new Chart(B.getContext('2d'), stackedByAccount(stats, names, 'sectors')));
  }

  /* ══════════════════════════════════════════════════════════════════════════
     INSTALL — override the old renderer, keep every existing caller working
     ══════════════════════════════════════════════════════════════════════════ */

  var _orig = window.renderAccountComparison;
  window.renderAccountComparison = function (force) {
    try { PA.render(force); }
    catch (e) {
      console.warn('[portfolio-analysis] render failed, falling back:', e);
      if (typeof _orig === 'function') { try { _orig(force); } catch (e2) {} }
    }
  };

  PA.VIEWS = VIEWS;
  PA.TIMELINES = TIMELINES;
  PA.filteredPositions = filteredPositions;
  PA.accountStats = accountStats;
  PA.contributionAnalysis = contributionAnalysis;
  PA.windowReturn = windowReturn;

  window.PerryPortfolioAnalysis = PA;

  document.addEventListener('perry:holdings', function () {
    if (document.getElementById('acctCompareBody')) PA.render(true);
  });
})();
