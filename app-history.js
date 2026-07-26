/* ============================================================================
   Perry Asset Management — Portfolio History  (app-history.js)
   Added 2026-07-25.  Load after app.js (needs window._holdings and PerryDb).

   ─────────────────────────────────────────────────────────────────────────────
   WHY THIS EXISTS
   ─────────────────────────────────────────────────────────────────────────────
   The site could tell you what your portfolio is worth RIGHT NOW and what each
   position cost. It could not tell you what the portfolio was worth on any
   given day in the past, because nothing was ever recorded.

   Everything time-based was therefore being RECONSTRUCTED: take today's
   positions, pull their price histories, and pretend you held exactly those
   shares the whole way back. That reconstruction is wrong in a specific and
   flattering direction — it assumes you always held today's winners. A
   position sold at a loss last year simply vanishes from the history, and one
   bought last month is projected backwards as though owned for years.

   That is survivorship bias applied to your own account, and it inflates every
   backward-looking number the site produces: return, Sharpe, drawdown, and the
   "what share of my gains came from the top 10" answer specifically.

   A daily NAV snapshot fixes it at the source. Once recorded, a day's value is
   a fact and never changes:

     • Time-weighted return that neutralises deposits and withdrawals, which is
       the only way to compare your performance to an index honestly.
     • Real max drawdown, measured on what the account actually did.
     • Contribution analysis over a true window rather than an assumed one.

   HONESTY ABOUT THE START DATE
   This begins accumulating today. It cannot retroactively know last year's
   values. The UI must say "since <first snapshot>" and never imply more, so
   `PerryHistory.coverage()` returns the real first date for callers to print.
   ============================================================================ */

(function () {
  'use strict';

  var COLL = 'portfolio_history';
  var CASH_LIKE = ['Cash', 'Money Market', 'CD'];

  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  /* ══════════════════════════════════════════════════════════════════════════
     SNAPSHOT
     ══════════════════════════════════════════════════════════════════════════ */

  /**
   * Value the book as of now, broken out by account and asset class.
   *
   * Cost basis is carried alongside market value so that a later reader can
   * separate price movement from contributions WITHOUT needing the transaction
   * log — a day where NAV rose because money was added looks identical to a
   * day where it rose on performance unless cost basis is stored too.
   */
  function snapshot() {
    var hs = window._holdings || [];
    if (!hs.length) return null;

    var out = {
      date: todayKey(),
      asOf: new Date().toISOString(),
      total_value: 0,
      total_cost: 0,
      n_positions: 0,
      priced_positions: 0,
      accounts: {},
      asset_classes: {},
      // Per-position values, kept so contribution analysis can attribute a
      // move to specific names later without re-fetching anything.
      positions: {}
    };

    hs.forEach(function (h) {
      if (!h.ticker) return;
      var qty = Number(h.quantity) || 0;
      if (!qty) return;

      var px = Number(h.currentPrice);
      var basis = Number(h.costBasis) || 0;
      var priced = isFinite(px) && px > 0;

      /* A position with no live price is recorded at cost and FLAGGED, not
         silently dropped. Dropping it would make NAV fall on any day a quote
         failed, which would then be indistinguishable from a real loss —
         a data outage would be permanently baked into the return series. */
      var mv = priced ? qty * px : qty * basis;

      var acct = h.accountType || h.account || 'Individual';
      var cls = h.assetClass || (CASH_LIKE.indexOf(h.assetClass) >= 0 ? 'Cash' : 'Equity');
      var t = String(h.ticker).toUpperCase();

      out.total_value += mv;
      out.total_cost += qty * basis;
      out.n_positions += 1;
      if (priced) out.priced_positions += 1;

      if (!out.accounts[acct]) out.accounts[acct] = { value: 0, cost: 0, n: 0 };
      out.accounts[acct].value += mv;
      out.accounts[acct].cost += qty * basis;
      out.accounts[acct].n += 1;

      out.asset_classes[cls] = (out.asset_classes[cls] || 0) + mv;

      if (!out.positions[t]) out.positions[t] = { v: 0, c: 0, q: 0, priced: priced };
      out.positions[t].v += mv;
      out.positions[t].c += qty * basis;
      out.positions[t].q += qty;
      if (!priced) out.positions[t].priced = false;
    });

    // Round for storage — sub-cent precision on a NAV is noise, and these
    // documents are written every day for years.
    out.total_value = Math.round(out.total_value * 100) / 100;
    out.total_cost = Math.round(out.total_cost * 100) / 100;
    Object.keys(out.accounts).forEach(function (k) {
      out.accounts[k].value = Math.round(out.accounts[k].value * 100) / 100;
      out.accounts[k].cost = Math.round(out.accounts[k].cost * 100) / 100;
    });
    Object.keys(out.asset_classes).forEach(function (k) {
      out.asset_classes[k] = Math.round(out.asset_classes[k] * 100) / 100;
    });
    Object.keys(out.positions).forEach(function (k) {
      out.positions[k].v = Math.round(out.positions[k].v * 100) / 100;
      out.positions[k].c = Math.round(out.positions[k].c * 100) / 100;
    });

    /* Quality flag. A snapshot taken when half the quotes failed is not
       comparable to a clean one, and the return series should be able to skip
       it rather than treat a data gap as a price move. */
    out.quality = out.n_positions === 0 ? 'empty'
      : out.priced_positions / out.n_positions >= 0.95 ? 'good'
        : out.priced_positions / out.n_positions >= 0.60 ? 'partial' : 'poor';

    return out;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     RECORD — once per day, first load wins
     ══════════════════════════════════════════════════════════════════════════ */

  var _recordedThisSession = false;

  function record(force) {
    if (_recordedThisSession && !force) return Promise.resolve(null);
    if (!window.PerryDb || !window.PerryDb.ready) return Promise.resolve(null);

    var snap = snapshot();
    if (!snap) return Promise.resolve(null);

    /* Never overwrite a good snapshot with a worse one. Reloading the page
       mid-session while quotes are still resolving would otherwise degrade a
       day that had already been captured cleanly. */
    if (snap.quality === 'poor' || snap.quality === 'empty') {
      console.info('[history] snapshot skipped — quality=' + snap.quality +
        ' (' + snap.priced_positions + '/' + snap.n_positions + ' priced)');
      return Promise.resolve(null);
    }

    _recordedThisSession = true;
    return window.PerryDb.setDoc(COLL, snap.date, snap)
      .then(function () {
        console.info('[history] NAV recorded ' + snap.date + ' = $' +
          snap.total_value.toLocaleString() + ' (' + snap.quality + ')');
        _cache = null;                 // series is stale now
        return snap;
      })
      .catch(function (e) {
        _recordedThisSession = false;  // let a later attempt retry
        console.warn('[history] record failed:', e.message);
        return null;
      });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     READ + DERIVED SERIES
     ══════════════════════════════════════════════════════════════════════════ */

  var _cache = null;

  function series() {
    if (_cache) return Promise.resolve(_cache);
    if (!window.PerryDb || !window.PerryDb.ready) return Promise.resolve([]);
    return window.PerryDb.listDocs(COLL, 'date')
      .then(function (rows) {
        _cache = rows.filter(function (r) {
          return r.date && r.total_value > 0 && r.quality !== 'poor';
        });
        return _cache;
      })
      .catch(function () { return []; });
  }

  /**
   * Time-weighted return.
   *
   * WHY NOT SIMPLE NAV CHANGE: if you deposit $10,000 the NAV jumps and a naive
   * return calculation reads that as a gain. TWR removes the effect of cash
   * flows by chaining daily returns, which is what makes the number comparable
   * to an index. This is the GIPS-standard treatment.
   *
   * Cash flow is INFERRED from the change in cost basis, since a deposit that
   * gets invested raises cost basis while market movement does not. The
   * inference is imperfect for same-day buy-and-sell activity, so any day whose
   * implied flow exceeds 0.5% of NAV is marked and excluded from the chain
   * rather than silently distorting it.
   */
  function twr(rows) {
    if (!rows || rows.length < 2) return null;
    var chain = 1, used = 0, skipped = 0;

    for (var i = 1; i < rows.length; i++) {
      var p = rows[i - 1], c = rows[i];
      if (!p.total_value || !c.total_value) continue;

      var flow = (c.total_cost || 0) - (p.total_cost || 0);
      // Treat trivial basis drift as noise, not a cash flow.
      if (Math.abs(flow) < Math.max(1, p.total_value * 0.0005)) flow = 0;

      // Subtracting the flow isolates the performance component.
      var r = (c.total_value - flow) / p.total_value - 1;

      // A day that moves more than 25% after flow adjustment is almost
      // certainly a data problem, not a market move. Excluded and counted.
      if (!isFinite(r) || Math.abs(r) > 0.25) { skipped++; continue; }

      chain *= (1 + r);
      used++;
    }

    if (used < 2) return null;
    var days = (new Date(rows[rows.length - 1].date) - new Date(rows[0].date)) / 864e5;
    var years = days / 365.25;

    return {
      cumulative: chain - 1,
      annualized: years >= 0.25 ? Math.pow(chain, 1 / years) - 1 : null,
      days_used: used,
      days_skipped: skipped,
      span_days: Math.round(days),
      // Annualizing a two-week sample produces a meaningless number, so the
      // caller is told when it is safe to show.
      annualized_reliable: years >= 1
    };
  }

  /** Peak-to-trough on recorded NAV — the real one, not a reconstruction. */
  function maxDrawdown(rows) {
    if (!rows || rows.length < 2) return null;
    var peak = -Infinity, mdd = 0, peakDate = null, troughDate = null, curPeak = null;
    rows.forEach(function (r) {
      if (r.total_value > peak) { peak = r.total_value; curPeak = r.date; }
      var dd = (r.total_value - peak) / peak;
      if (dd < mdd) { mdd = dd; peakDate = curPeak; troughDate = r.date; }
    });
    return { drawdown: mdd, peak_date: peakDate, trough_date: troughDate };
  }

  /**
   * What share of the period's gain came from the top N positions, and which
   * accounts held them — the question that prompted this module.
   *
   * Measured across positions present at BOTH ends of the window. Names opened
   * or closed mid-window are reported separately rather than folded in, because
   * attributing a full-period gain to a position held for three weeks would
   * overstate its contribution.
   */
  function contribution(rows, topN) {
    if (!rows || rows.length < 2) return null;
    var first = rows[0], last = rows[rows.length - 1];
    if (!first.positions || !last.positions) return null;

    var items = [], entered = [], exited = [];

    Object.keys(last.positions).forEach(function (t) {
      var a = first.positions[t], b = last.positions[t];
      if (!a) { entered.push({ ticker: t, gain: (b.v || 0) - (b.c || 0) }); return; }
      // Gain net of any basis added during the window.
      var gain = (b.v - a.v) - ((b.c || 0) - (a.c || 0));
      items.push({ ticker: t, gain: gain, start: a.v, end: b.v });
    });
    Object.keys(first.positions).forEach(function (t) {
      if (!last.positions[t]) exited.push({ ticker: t });
    });

    items.sort(function (x, y) { return y.gain - x.gain; });

    var totalGain = items.reduce(function (s, x) { return s + x.gain; }, 0);
    var n = topN || 10;
    var top = items.slice(0, n);
    var topGain = top.reduce(function (s, x) { return s + x.gain; }, 0);

    // Which accounts hold those names today.
    var acctOf = {};
    (window._holdings || []).forEach(function (h) {
      if (!h.ticker) return;
      var t = String(h.ticker).toUpperCase();
      var a = h.accountType || h.account || 'Individual';
      if (!acctOf[t]) acctOf[t] = [];
      if (acctOf[t].indexOf(a) < 0) acctOf[t].push(a);
    });
    top.forEach(function (x) { x.accounts = acctOf[x.ticker] || []; });

    var byAcct = {};
    top.forEach(function (x) {
      (x.accounts.length ? x.accounts : ['Unknown']).forEach(function (a) {
        byAcct[a] = (byAcct[a] || 0) + x.gain / (x.accounts.length || 1);
      });
    });

    return {
      from: first.date, to: last.date,
      total_gain: totalGain,
      top_n: n,
      top_gain: topGain,
      /* Share can legitimately exceed 100% when losers offset winners. That is
         real information — it means the top names carried the whole book — so
         it is not clamped, only labelled. */
      top_share: totalGain !== 0 ? topGain / totalGain : null,
      top_share_exceeds_100: totalGain !== 0 && (topGain / totalGain) > 1,
      positions: top,
      by_account: byAcct,
      entered_midwindow: entered,
      exited_midwindow: exited,
      note: (entered.length || exited.length)
        ? entered.length + ' position(s) opened and ' + exited.length +
          ' closed during the window; these are listed separately rather than '
          + 'attributed a full-period contribution.'
        : null
    };
  }

  function coverage(rows) {
    if (!rows || !rows.length) {
      return { available: false, message: 'No NAV history recorded yet. The first snapshot is taken the next time you open the site while signed in.' };
    }
    var days = (new Date(rows[rows.length - 1].date) - new Date(rows[0].date)) / 864e5;
    return {
      available: true,
      first: rows[0].date,
      last: rows[rows.length - 1].date,
      n: rows.length,
      span_days: Math.round(days),
      // Stated plainly so no view can imply a longer record than exists.
      message: 'Recorded daily since ' + rows[0].date + ' (' + rows.length + ' snapshots, ' +
        Math.round(days) + ' days).'
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     PUBLIC API
     ══════════════════════════════════════════════════════════════════════════ */

  window.PerryHistory = {
    snapshot: snapshot,
    record: record,
    series: series,
    coverage: function () { return series().then(coverage); },
    twr: function () { return series().then(twr); },
    maxDrawdown: function () { return series().then(maxDrawdown); },
    contribution: function (topN) { return series().then(function (r) { return contribution(r, topN); }); },
    // Exposed for testing with injected rows.
    _twr: twr, _maxDrawdown: maxDrawdown, _contribution: contribution, _coverage: coverage
  };

  /* ══════════════════════════════════════════════════════════════════════════
     AUTO-RECORD

     Fires once, a few seconds after holdings load, giving live quotes time to
     resolve so the snapshot lands as 'good' rather than 'partial'. Deliberately
     not tied to a button — a history with gaps on the days you forgot to click
     is worse than useless, because the gaps correlate with market conditions.
     ══════════════════════════════════════════════════════════════════════════ */

  var _tries = 0;
  function tryRecord() {
    _tries++;
    if (_tries > 12) return;                       // ~2 min then give up
    if (!window.PerryDb || !window.PerryDb.ready || !(window._holdings || []).length) {
      setTimeout(tryRecord, 10000);
      return;
    }
    record().then(function (r) {
      // A 'partial' snapshot means quotes were still resolving — try once more
      // later in the session to upgrade it.
      if (!r && _tries <= 12) setTimeout(tryRecord, 15000);
    });
  }

  if (document.readyState === 'complete') setTimeout(tryRecord, 8000);
  else window.addEventListener('load', function () { setTimeout(tryRecord, 8000); });

})();
