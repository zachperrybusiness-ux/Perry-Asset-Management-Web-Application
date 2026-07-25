/* ============================================================================
   Perry Asset Management — Unified Signal Engine  (app-signals.js)
   Added 2026-07-24.  Load AFTER app-warehouse.js.

   ─────────────────────────────────────────────────────────────────────────────
   WHY THIS EXISTS  —  read this before changing anything below
   ─────────────────────────────────────────────────────────────────────────────
   The site previously ran FIVE independent regime taxonomies with no
   arbitration between them:

     1. psClassifyState()   leveraged / growth / neutral / drawdown
     2. computeCurrentQuad() Goldilocks / Overheat / Stagflation / Deflation
     3. HIT_RATE_DATA        early / mid / late / recession
     4. VIX buckets          <15 / 15-20 / 20-30 / 30+
     5. RISK_PROFILES        conservative / moderate / aggressive / speculative

   The same holding could simultaneously be told "Aligned", "Overweight",
   "45% hit rate", "AVOID", and "trim to target". Each was defensible alone;
   together they were noise.

   THE UNIFIED VIEW implemented here collapses them into a defined hierarchy:

     ┌─ CYCLE  (where the economy is)      ← FRED pillars. Slow, months.
     ├─ REGIME (growth × inflation Quad)   ← FRED pillars. Slow, months.
     ├─ PHASE  (top / bottom / neither)    ← internals + macro. Medium, weeks.
     ├─ TREND  (market state)              ← price/vol. Fast, days-weeks.
     └─ MANDATE (risk capacity)            ← client profile. A CAP, not a signal.

   ARBITRATION RULES (stated, not implied):
     • REGIME sets the sector tilt.        (what to own)
     • PHASE  sets gross exposure.         (how much to own)
     • TREND  sets entry timing.           (when to act)
     • MANDATE caps everything.            (never exceeded)
     • When REGIME and TREND conflict → size down, do not flip. Conflict is
       surfaced to the user, never silently resolved.
     • Horizon is attached to every signal so a 3-day and a 6-month signal are
       never compared as if they were the same claim.

   This module is the ONLY place allowed to output a posture. Every page reads
   from PerrySignals.state(). That is what makes the story cohesive.
   ============================================================================ */

(function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════════════════════
     SECTION 0 — SHARED CONSTANTS  (single source of truth)

     Previously the site contained FIVE different risk-free rates (4.0%, 4.5%,
     5.0%, 5.3%, and "~4-5%" in the glossary) and THREE different forward
     equity return assumptions (28%, 8.5%, trailing-realized). Sharpe ratios on
     different pages were therefore not comparable, and the same portfolio was
     forecast at 28%/yr on one page and 8.5%/yr on another.

     Everything now reads from here.
     ══════════════════════════════════════════════════════════════════════════ */

  var CONST = {
    /* Risk-free rate. Set from the live 3M T-bill (DGS3MO) at load; the literal
       below is only the boot value used before macro data arrives. */
    RF_RATE: 0.0425,
    RF_SOURCE: 'default (awaiting DGS3MO)',

    /* Capital-market assumptions — long-run NOMINAL arithmetic means.
       Deliberately conservative and sourced, replacing the old hardcoded
       +28%/yr "leveraged" drift which was a rebound-conditional realised
       average being misused as a forward expectation. */
    CMA: {
      us_equity:    { mu: 0.077, sig: 0.160, label: 'US Equity' },
      intl_equity:  { mu: 0.079, sig: 0.175, label: 'Intl Developed' },
      em_equity:    { mu: 0.085, sig: 0.220, label: 'EM Equity' },
      us_bond_agg:  { mu: 0.045, sig: 0.060, label: 'US Aggregate' },
      us_bond_long: { mu: 0.047, sig: 0.115, label: 'Long Treasury' },
      hy_credit:    { mu: 0.062, sig: 0.100, label: 'High Yield' },
      tips:         { mu: 0.042, sig: 0.055, label: 'TIPS' },
      commodities:  { mu: 0.045, sig: 0.170, label: 'Commodities' },
      gold:         { mu: 0.040, sig: 0.155, label: 'Gold' },
      reits:        { mu: 0.068, sig: 0.190, label: 'REITs' },
      cash:         { mu: 0.0425, sig: 0.010, label: 'Cash' }
    },
    CMA_SOURCE: 'Blended long-horizon CMAs (equity = ERP over current cash; bonds anchored to current YTM). Nominal, arithmetic.',

    INFLATION: 0.025,
    STOCK_BOND_CORR: 0.15,

    /* Regime TILT applied to CMA drift. Bounded at ±3pp deliberately: regimes
       shift expected returns modestly, they do not triple them. */
    REGIME_TILT_CAP: 0.03,

    TRADING_DAYS: 252
  };

  /* ══════════════════════════════════════════════════════════════════════════
     SECTION 1 — utilities
     ══════════════════════════════════════════════════════════════════════════ */

  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function mean(a) { return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : null; }
  function median(a) {
    if (!a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function pct(v, d) { return v == null ? '—' : (v * 100).toFixed(d == null ? 1 : d) + '%'; }

  /**
   * Maps a raw value onto 0..1 using explicit low/high anchors. Used for every
   * topping component so each contributes on a comparable scale and the weights
   * mean what they say.
   */
  function scale01(v, lo, hi) {
    if (v == null) return null;
    if (hi === lo) return 0.5;
    return clamp((v - lo) / (hi - lo), 0, 1);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     SECTION 2 — MACRO REGIME (the Quad)

     Fixes carried over from the audit:
       • "confidence" previously counted NON-NEUTRAL indicators, so 12 at +1 and
         12 at -1 (maximum disagreement) scored 100% confidence. Now uses
         |Σ score| / Σ|score|, which is actual directional agreement.
       • Normalisation constants were hardcoded (maxGrowth=8, maxInfl=4) and the
         growth axis summed TWO pillars against inflation's ONE, so the axes had
         different implicit weights and broke silently if an indicator count
         changed. Now normalised by actual indicator counts.
     ══════════════════════════════════════════════════════════════════════════ */

  var QUADS = {
    Goldilocks:  { num: 'Q1', label: 'Goldilocks',  growth: 'Accelerating', infl: 'Decelerating', color: '#2E7D52' },
    Overheat:    { num: 'Q2', label: 'Overheat',    growth: 'Accelerating', infl: 'Accelerating', color: '#8B6914' },
    Stagflation: { num: 'Q3', label: 'Stagflation', growth: 'Decelerating', infl: 'Accelerating', color: '#8B2A2A' },
    Deflation:   { num: 'Q4', label: 'Deflation',   growth: 'Decelerating', infl: 'Decelerating', color: '#5B9BD5' }
  };

  function pillarSum(pillars, names) {
    var scores = [];
    (pillars || []).forEach(function (p) {
      if (names.indexOf(p.name) === -1) return;
      (p.indicators || []).forEach(function (ind) {
        var s = num(ind.score);
        if (s != null) scores.push(s);
      });
    });
    return scores;
  }

  function computeRegime(macroData) {
    if (!macroData || !macroData.pillars) return null;
    var P = macroData.pillars;

    var growthScores = pillarSum(P, ['Growth Analysis', 'Labor Market']);
    var inflScores = pillarSum(P, ['Inflation']);
    if (!growthScores.length || !inflScores.length) return null;

    // Normalise by actual count → both axes are a clean mean in [-1, +1],
    // independent of how many indicators each pillar happens to contain.
    var x = mean(growthScores);                 // + = growth accelerating
    var y = -mean(inflScores);                  // FRED: +score = disinflation, so negate → + = inflation rising

    var label = x >= 0
      ? (y >= 0 ? 'Overheat' : 'Goldilocks')
      : (y >= 0 ? 'Stagflation' : 'Deflation');

    // Real agreement, not "count of non-neutral".
    var all = growthScores.concat(inflScores);
    var absSum = all.reduce(function (s, v) { return s + Math.abs(v); }, 0);
    var netAbs = Math.abs(all.reduce(function (s, v) { return s + v; }, 0));
    var agreement = absSum > 0 ? netAbs / absSum : 0;

    // Distance from origin — a reading near (0,0) is a weak regime claim
    // regardless of how much the indicators agree.
    var conviction = Math.sqrt(x * x + y * y) / Math.SQRT2;

    // Confidence blends agreement with conviction. Both must be high to claim
    // a confident regime.
    var confidence = clamp(0.6 * agreement + 0.4 * conviction, 0, 1);

    return {
      label: label, quad: QUADS[label].num, color: QUADS[label].color,
      x: x, y: y,
      growthDir: x >= 0 ? 'Accelerating' : 'Decelerating',
      inflDir: y >= 0 ? 'Accelerating' : 'Decelerating',
      agreement: agreement,
      conviction: conviction,
      confidence: confidence,
      nIndicators: all.length,
      horizon: '3–12 months',
      // Honest qualifier used in the UI headline.
      qualifier: confidence > 0.6 ? 'clear' : confidence > 0.35 ? 'tentative' : 'unresolved'
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     SECTION 3 — BOTTOMING DETECTOR

     Spec (user-defined): VIX rises above 30, then falls back below 30.
     That round-trip is the trigger — not the spike itself. Implemented as a
     state machine over the real VIX series so it can also report how long ago
     the trigger fired and whether it has been confirmed by price.
     ══════════════════════════════════════════════════════════════════════════ */

  var VIX_TRIGGER = 30;
  var VIX_CONFIRM_WINDOW = 30;   // trading days a fresh trigger stays "live"

  function detectBottom(vixHistory, spyCloses) {
    // vixHistory: [{d, v}] ascending
    if (!vixHistory || vixHistory.length < 40) {
      return { state: 'no-data', label: 'Insufficient VIX history', armed: false, triggered: false };
    }

    var armed = false;         // VIX has been above 30 and not yet crossed back
    var armDate = null, armPeak = null;
    var lastTrigger = null;    // { date, index, peak }
    var triggers = [];

    for (var i = 0; i < vixHistory.length; i++) {
      var v = vixHistory[i].v;
      if (v == null) continue;
      if (v > VIX_TRIGGER) {
        if (!armed) { armed = true; armDate = vixHistory[i].d; armPeak = v; }
        else if (v > armPeak) armPeak = v;
      } else if (armed) {
        // The round-trip completed — this is the bottoming signal.
        lastTrigger = { date: vixHistory[i].d, index: i, peak: armPeak, armedOn: armDate };
        triggers.push(lastTrigger);
        armed = false; armDate = null; armPeak = null;
      }
    }

    var last = vixHistory[vixHistory.length - 1];
    var barsSince = lastTrigger ? (vixHistory.length - 1 - lastTrigger.index) : null;
    var live = barsSince != null && barsSince <= VIX_CONFIRM_WINDOW;

    // Price confirmation: is SPY above where it was when the trigger fired?
    var confirmed = null;
    if (lastTrigger && spyCloses && spyCloses.length > lastTrigger.index) {
      var atTrigger = spyCloses[lastTrigger.index];
      var now = spyCloses[spyCloses.length - 1];
      if (atTrigger && now) confirmed = now > atTrigger;
    }

    var state, label, score;
    if (armed) {
      state = 'armed';
      label = 'VIX above ' + VIX_TRIGGER + ' (peak ' + (armPeak || 0).toFixed(1) + ') — waiting for the cross back below';
      score = 0.5;   // stress is present but the buy signal has not fired
    } else if (live) {
      state = 'triggered';
      label = 'Bottoming trigger fired ' + barsSince + ' sessions ago (VIX peaked ' + lastTrigger.peak.toFixed(1) + ', crossed back below ' + VIX_TRIGGER + ' on ' + lastTrigger.date + ')';
      score = 1;
    } else if (lastTrigger) {
      state = 'stale';
      label = 'Last bottoming trigger ' + barsSince + ' sessions ago (' + lastTrigger.date + ') — outside the ' + VIX_CONFIRM_WINDOW + '-session window';
      score = 0;
    } else {
      state = 'none';
      label = 'No VIX round-trip above ' + VIX_TRIGGER + ' in the available history';
      score = 0;
    }

    return {
      state: state, label: label, score: score,
      armed: armed, triggered: state === 'triggered',
      currentVix: last ? last.v : null,
      // Fixed 2026-07-24: armPeak is reset when the round-trip completes, so
      // fall back to the completed trigger's peak. Reporting null here made the
      // triggered state look like it had no stress reading behind it.
      armPeak: armPeak != null ? armPeak : (lastTrigger ? lastTrigger.peak : null),
      lastTrigger: lastTrigger,
      barsSince: barsSince,
      priceConfirmed: confirmed,
      triggerCount: triggers.length,
      recentTriggers: triggers.slice(-5),
      horizon: '1–6 months',
      threshold: VIX_TRIGGER
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     SECTION 4 — TOPPING COMPOSITE

     Nine components, all specified by the user, all computed from real data
     (warehouse internals + verified FRED series). Every component reports its
     own value, its 0-1 normalised reading, whether data was available, and a
     plain-English note. Components with no data are EXCLUDED and the weights
     are renormalised — the composite never silently treats missing data as
     benign, and it always reports how many components actually fired.
     ══════════════════════════════════════════════════════════════════════════ */

  var TOP_COMPONENTS = [
    {
      key: 'concentration', weight: 0.15, label: 'Index Concentration',
      why: 'When the top handful of names dominate index weight, the index is a concentrated bet, and a single-name shock becomes a market shock.',
      compute: function (ctx) {
        var v = num(ctx.internals && ctx.internals.top10_cap_share);
        if (v == null) return null;
        // 25% top-10 share is historically unremarkable; 40% is extreme.
        return { value: v, norm: scale01(v, 0.25, 0.40), display: pct(v) + ' in top 10' };
      }
    },
    {
      key: 'growth_contribution', weight: 0.15, label: 'Top-10 Growth Contribution',
      why: 'Broad participation is healthy. If ten names generate most of the index\'s gain, the advance is narrow and fragile.',
      compute: function (ctx) {
        var v = num(ctx.internals && ctx.internals.top10_growth_contribution);
        if (v == null) return null;
        // 35% is a normal contribution share; 75% is dangerously narrow.
        return { value: v, norm: scale01(v, 0.35, 0.75), display: pct(v) + ' of index gain from top 10' };
      }
    },
    {
      key: 'breadth', weight: 0.14, label: 'Market Breadth',
      why: 'Narrowing breadth — cap-weighted beating equal-weighted while fewer names hold their 200-day — means quality is being bid and everything else left behind. A classic late-stage tell.',
      compute: function (ctx) {
        var above = num(ctx.internals && ctx.internals.pct_above_sma200);
        var diverge = num(ctx.internals && ctx.internals.breadth_divergence_3m);
        if (above == null && diverge == null) return null;
        var parts = [], notes = [];
        if (above != null) {
          // 70% above the 200dma is healthy; 35% is narrow.
          parts.push(scale01(above, 0.70, 0.35));
          notes.push(pct(above) + ' above 200dma');
        }
        if (diverge != null) {
          // Cap-weighted outperforming equal-weighted by 8pp over 3m is extreme.
          parts.push(scale01(diverge, 0.0, 0.08));
          notes.push('cap−equal spread ' + pct(diverge));
        }
        return { value: above != null ? above : diverge, norm: mean(parts), display: notes.join(' · ') };
      }
    },
    {
      key: 'valuation', weight: 0.14, label: 'Valuation Stretch',
      why: 'Expensive markets are not a timing signal on their own, but they set the downside. Measured across four multiples so one distorted metric cannot drive the reading.',
      compute: function (ctx) {
        var I = ctx.internals || {};
        var subs = [];
        // Anchors are long-run median-to-rich ranges for large-cap US equity.
        if (num(I.median_pe) != null)   subs.push({ n: scale01(I.median_pe,   16, 26), d: 'P/E ' + I.median_pe });
        if (num(I.median_pb) != null)   subs.push({ n: scale01(I.median_pb,   2.2, 4.5), d: 'P/B ' + I.median_pb });
        if (num(I.median_ps) != null)   subs.push({ n: scale01(I.median_ps,   1.8, 3.5), d: 'P/S ' + I.median_ps });
        if (num(I.median_pfcf) != null) subs.push({ n: scale01(I.median_pfcf, 18, 34), d: 'P/FCF ' + I.median_pfcf });
        if (!subs.length) return null;
        return {
          value: num(I.median_pe),
          norm: mean(subs.map(function (s) { return s.n; })),
          display: subs.map(function (s) { return s.d; }).join(' · ')
        };
      }
    },
    {
      key: 'margin_debt', weight: 0.12, label: 'Margin Debt',
      why: 'Leverage amplifies both directions. Rapid growth in customer margin balances means the marginal buyer is borrowing — and forced selling becomes the mechanism of the decline.',
      compute: function (ctx) {
        var s = ctx.macro && ctx.macro.margin_debt;
        if (!s) return null;
        var yoy = num(s.chg_12m);
        var z = num(s.z_score);
        var parts = [];
        // +25% y/y growth in margin balances is historically frothy.
        if (yoy != null && num(s.latest_value)) {
          var prev = s.latest_value - yoy;
          if (prev > 0) parts.push(scale01(yoy / prev, 0.05, 0.28));
        }
        if (z != null) parts.push(scale01(z, 0, 2));
        if (!parts.length) return null;
        return {
          value: s.latest_value, norm: mean(parts),
          display: '$' + (s.latest_value / 1e6).toFixed(2) + 'T level, z=' + (z == null ? '—' : z.toFixed(2)),
          stale: s.days_old > 120, asOf: s.latest_date, daysOld: s.days_old
        };
      }
    },
    {
      key: 'yield_30y', weight: 0.10, label: '30Y Treasury Yield',
      why: 'Above roughly 5% the long bond becomes genuine competition for equities and compresses the multiple investors will pay for distant cash flows.',
      compute: function (ctx) {
        var s = ctx.macro && ctx.macro.yield_30y;
        var v = s ? num(s.latest_value) : null;
        if (v == null) return null;
        // Threshold explicitly per spec: 5% is the line, 6% is severe.
        return {
          value: v, norm: scale01(v, 4.0, 6.0),
          display: v.toFixed(2) + '%' + (v > 5 ? ' — above the 5% threshold' : ''),
          breached: v > 5, asOf: s.latest_date, daysOld: s.days_old
        };
      }
    },
    {
      key: 'sentiment', weight: 0.08, label: 'Sentiment Euphoria',
      why: 'Euphoria marks the point where expectations exceed what fundamentals can deliver. Read as a percentile against its own five-year history rather than an absolute level.',
      compute: function (ctx) {
        var s = ctx.macro && ctx.macro.consumer_sentiment;
        if (!s) return null;
        var p = num(s.pct_rank_5y);
        if (p == null) return null;
        return {
          value: s.latest_value, norm: scale01(p, 50, 95),
          display: s.latest_value + ' (' + p.toFixed(0) + 'th pct of 5y)',
          stale: s.days_old > 60, asOf: s.latest_date, daysOld: s.days_old
        };
      }
    },
    {
      key: 'savings_rate', weight: 0.07, label: 'Consumer Savings Rate',
      why: 'A depleted savings rate means household spending is running on borrowed or drawn-down money — it removes the buffer that normally cushions a slowdown.',
      compute: function (ctx) {
        var s = ctx.macro && ctx.macro.savings_rate;
        if (!s) return null;
        var v = num(s.latest_value);
        if (v == null) return null;
        // Inverted: LOW savings = topping risk. 8% comfortable, 3% stretched.
        return {
          value: v, norm: scale01(v, 8.0, 3.0),
          display: v.toFixed(1) + '% (' + (num(s.pct_rank_5y) == null ? '—' : s.pct_rank_5y.toFixed(0) + 'th pct)'),
          asOf: s.latest_date, daysOld: s.days_old
        };
      }
    },
    {
      key: 'ipo_activity', weight: 0.05, label: 'IPO Activity',
      why: 'Issuers sell when buyers are least discriminating. A surge in new listings is a supply-side signal that insiders think prices are generous.',
      compute: function (ctx) {
        var v = num(ctx.internals && ctx.internals.ipo_count_90d);
        if (v == null) return null;
        return { value: v, norm: scale01(v, 25, 120), display: v + ' IPOs in last 90d' };
      }
    }
  ];

  function detectTop(ctx) {
    var results = [], available = 0, totalWeight = 0;

    TOP_COMPONENTS.forEach(function (c) {
      var r = null;
      try { r = c.compute(ctx); } catch (e) { r = null; }
      if (r && r.norm != null) {
        available++; totalWeight += c.weight;
        results.push({
          key: c.key, label: c.label, why: c.why, weight: c.weight,
          value: r.value, norm: r.norm, display: r.display,
          stale: !!r.stale, asOf: r.asOf || null, daysOld: r.daysOld == null ? null : r.daysOld,
          breached: !!r.breached,
          reading: r.norm >= 0.75 ? 'elevated' : r.norm >= 0.5 ? 'building' : 'benign',
          available: true
        });
      } else {
        results.push({
          key: c.key, label: c.label, why: c.why, weight: c.weight,
          available: false, norm: null,
          display: 'No data yet — warehouse coverage incomplete'
        });
      }
    });

    // Renormalise across available components only, and report the coverage so
    // a 3-of-9 composite is never presented with the authority of a 9-of-9 one.
    var score = null;
    if (totalWeight > 0) {
      score = results.reduce(function (s, r) {
        return r.available ? s + r.norm * (r.weight / totalWeight) : s;
      }, 0);
    }

    var coverage = available / TOP_COMPONENTS.length;
    var band, label;
    if (score == null) { band = 'unknown'; label = 'Insufficient data'; }
    else if (score >= 0.70) { band = 'high'; label = 'Elevated topping risk'; }
    else if (score >= 0.50) { band = 'moderate'; label = 'Topping conditions building'; }
    else if (score >= 0.30) { band = 'low'; label = 'Few topping signals'; }
    else { band = 'minimal'; label = 'Topping signals absent'; }

    return {
      score: score, band: band, label: label,
      components: results,
      available: available, total: TOP_COMPONENTS.length, coverage: coverage,
      // Confidence in the composite is limited by how much of it we can measure.
      confidence: score == null ? 0 : clamp(coverage, 0, 1),
      elevated: results.filter(function (r) { return r.available && r.norm >= 0.75; }).map(function (r) { return r.label; }),
      horizon: 'weeks to months',
      note: coverage < 0.7
        ? 'Only ' + available + ' of ' + TOP_COMPONENTS.length + ' components have data. Treat as provisional until warehouse coverage completes.'
        : null
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     SECTION 5 — TREND STATE  (replaces psClassifyState)

     Two fixes from the audit:
       • Naming. The old states were "leveraged / growth / neutral / drawdown",
         where "drawdown" actually meant "market extended, de-risk" and
         "leveraged" meant "deploy into weakness". Users reading "Positioned for
         Drawdown" at an all-time high reasonably assumed a bug. Renamed to
         intent: Accumulate / Risk-On / Neutral / De-Risk.
       • Ties. The old winner loop started at maxScore=0 and iterated in a fixed
         order, so 'leveraged' silently won every tie. Now ties resolve to
         Neutral, which is the honest answer to "the evidence is balanced".
     ══════════════════════════════════════════════════════════════════════════ */

  var TREND_STATES = {
    accumulate: { label: 'Accumulate', color: '#2E7D52', gross: 1.15,
      meaning: 'Deep decline with stress priced in. Historically the best risk-adjusted entry, and the hardest to act on.' },
    risk_on:    { label: 'Risk-On',    color: '#003C71', gross: 1.00,
      meaning: 'Constructive trend with contained volatility. Stay invested, follow strength.' },
    neutral:    { label: 'Neutral',    color: '#8B6914', gross: 0.85,
      meaning: 'Mixed evidence. Hold the plan, avoid new concentrated risk.' },
    de_risk:    { label: 'De-Risk',    color: '#8B2A2A', gross: 0.70,
      meaning: 'Market extended and complacent. Trim into strength, raise quality, build cash.' }
  };

  function computeTrend(sig) {
    // sig: { vix, ret12m, ddFromPeak, fromLow, above200, breadthDiverge }
    var s = { accumulate: 0, risk_on: 0, neutral: 0, de_risk: 0 };
    var why = { accumulate: [], risk_on: [], neutral: [], de_risk: [] };

    if (num(sig.vix) != null) {
      var v = sig.vix;
      if (v >= 30)      { s.accumulate += 3; why.accumulate.push('VIX ' + v.toFixed(1) + ' ≥ 30 — extreme fear'); }
      else if (v >= 22) { s.neutral += 2;    why.neutral.push('VIX ' + v.toFixed(1) + ' elevated'); }
      else if (v <= 14) { s.de_risk += 2;    why.de_risk.push('VIX ' + v.toFixed(1) + ' ≤ 14 — complacency'); }
      else              { s.risk_on += 2;    why.risk_on.push('VIX ' + v.toFixed(1) + ' in the calm band'); }
    }

    if (num(sig.ret12m) != null) {
      var r = sig.ret12m * 100;
      if (r >= 30)       { s.de_risk += 3;    why.de_risk.push('SPY +' + r.toFixed(1) + '% over 12m — extended'); }
      else if (r >= 15)  { s.risk_on += 2;    why.risk_on.push('SPY +' + r.toFixed(1) + '% 12m uptrend'); }
      else if (r <= -15) { s.accumulate += 3; why.accumulate.push('SPY ' + r.toFixed(1) + '% over 12m — deep decline'); }
      else if (r <= 0)   { s.neutral += 2;    why.neutral.push('SPY ' + r.toFixed(1) + '% 12m — flat to down'); }
      else               { s.neutral += 1;    why.neutral.push('SPY +' + r.toFixed(1) + '% 12m — modest'); }
    }

    if (num(sig.ddFromPeak) != null) {
      var dd = sig.ddFromPeak * 100;
      if (dd <= -20)     { s.accumulate += 3; why.accumulate.push(dd.toFixed(1) + '% from the 12m high'); }
      else if (dd <= -10){ s.neutral += 1;    why.neutral.push(dd.toFixed(1) + '% from the 12m high'); }
      else if (dd >= -2) { s.de_risk += 2;    why.de_risk.push('At or near the 12m high (' + dd.toFixed(1) + '%)'); }
    }

    if (num(sig.fromLow) != null) {
      var fl = sig.fromLow * 100;
      if (fl >= 50)      { s.de_risk += 3;    why.de_risk.push('+' + fl.toFixed(1) + '% off the 12m low — large advance'); }
      else if (fl >= 30) { s.de_risk += 2;    why.de_risk.push('+' + fl.toFixed(1) + '% off the 12m low'); }
      else if (fl >= 15) { s.risk_on += 1;    why.risk_on.push('+' + fl.toFixed(1) + '% off the 12m low'); }
    }

    // Breadth participates in TREND too — narrow advances are lower quality.
    if (num(sig.breadthDiverge) != null && sig.breadthDiverge > 0.05) {
      s.de_risk += 2;
      why.de_risk.push('Cap-weighted leading equal-weighted by ' + pct(sig.breadthDiverge) + ' — narrow advance');
    }

    var keys = Object.keys(s);
    var max = Math.max.apply(null, keys.map(function (k) { return s[k]; }));
    var winners = keys.filter(function (k) { return s[k] === max; });
    // Honest tie handling.
    var state = (max === 0 || winners.length > 1) ? 'neutral' : winners[0];
    var total = keys.reduce(function (a, k) { return a + s[k]; }, 0);

    return {
      state: state,
      label: TREND_STATES[state].label,
      color: TREND_STATES[state].color,
      grossTarget: TREND_STATES[state].gross,
      meaning: TREND_STATES[state].meaning,
      scores: s,
      reasons: why[state],
      allReasons: why,
      confidence: total > 0 ? max / total : 0,
      tied: winners.length > 1 && max > 0,
      horizon: 'days to weeks',
      // Stated explicitly because it is the source of the momentum-vs-reversal
      // confusion flagged in the audit.
      methodology: 'Mean-reverting at extremes: strength after a large advance reduces exposure, weakness after a decline increases it. This intentionally opposes the trend-following sector momentum signal, which operates on a 3–12 month horizon.'
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     SECTION 6 — ARBITRATION

     The heart of the unified view. Produces ONE posture from the four signals,
     and — critically — reports every conflict rather than hiding it.
     ══════════════════════════════════════════════════════════════════════════ */

  /* Sector tilts by regime. These are DIRECTIONAL PRIORS from published cycle
     research, not measured hit rates. They deliberately carry no fake
     percentages: the previous version showed invented figures like "74%" that
     contradicted a second hardcoded table on 26 of 44 cells. */
  var REGIME_TILTS = {
    Goldilocks: {
      OW: ['Information Technology', 'Consumer Discretionary', 'Industrials', 'Financials'],
      UW: ['Utilities', 'Consumer Staples', 'Real Estate'],
      rationale: 'Accelerating growth with cooling inflation favours cyclicals and long-duration growth; defensives lag.'
    },
    Overheat: {
      OW: ['Energy', 'Materials', 'Financials', 'Industrials'],
      UW: ['Information Technology', 'Utilities', 'Real Estate'],
      rationale: 'Rising growth AND rising inflation favours real assets and pricing power; rate-sensitive long-duration multiples compress.'
    },
    Stagflation: {
      OW: ['Energy', 'Consumer Staples', 'Health Care', 'Utilities'],
      UW: ['Consumer Discretionary', 'Information Technology', 'Industrials'],
      rationale: 'Weak growth with sticky inflation favours inelastic demand and hard assets; discretionary and cyclical earnings compress.'
    },
    Deflation: {
      OW: ['Consumer Staples', 'Health Care', 'Utilities'],
      UW: ['Energy', 'Materials', 'Financials', 'Consumer Discretionary'],
      rationale: 'Falling growth and falling inflation favours duration and defensive cash flows; commodity and credit-sensitive sectors suffer.'
    }
  };

  function arbitrate(regime, phase, trend, mandate) {
    var conflicts = [], agreements = [], notes = [];

    /* ---- 1. Gross exposure: PHASE leads, TREND adjusts ---- */
    var gross = 1.0;
    var grossWhy = [];

    if (phase && phase.top && phase.top.score != null) {
      // Topping risk reduces gross exposure, scaled by confidence in the reading.
      var topDrag = phase.top.score * 0.30 * phase.top.confidence;
      gross -= topDrag;
      grossWhy.push('Topping composite ' + (phase.top.score * 100).toFixed(0) + '/100 → −' + (topDrag * 100).toFixed(0) + 'pts');
    }
    if (phase && phase.bottom && phase.bottom.triggered) {
      gross += 0.15;
      grossWhy.push('Bottoming trigger live → +15pts');
    }
    if (trend) {
      // Blend rather than override, so one fast signal cannot dominate.
      gross = 0.6 * gross + 0.4 * trend.grossTarget;
      grossWhy.push(trend.label + ' trend target ' + (trend.grossTarget * 100).toFixed(0) + '% (40% weight)');
    }
    gross = clamp(gross, 0.40, 1.20);

    /* ---- 2. MANDATE is a hard cap, never a signal ---- */
    var mandateCap = mandate && num(mandate.maxGross) != null ? mandate.maxGross : 1.0;
    var grossPreCap = gross;
    if (gross > mandateCap) {
      gross = mandateCap;
      notes.push('Signals supported ' + pct(grossPreCap, 0) + ' gross exposure; your mandate caps it at ' + pct(mandateCap, 0) + '. The cap wins — this is the fiduciary constraint working as intended.');
    }

    /* ---- 3. Conflict detection (surfaced, not resolved away) ---- */

    // Regime bullish vs topping risk high
    var regimeBullish = regime && (regime.label === 'Goldilocks' || regime.label === 'Overheat');
    if (regimeBullish && phase && phase.top && phase.top.score >= 0.6) {
      conflicts.push({
        severity: 'high',
        between: ['Macro Regime', 'Topping Composite'],
        text: 'The macro regime (' + regime.label + ') supports risk assets, but topping conditions are elevated (' +
              (phase.top.score * 100).toFixed(0) + '/100). Late-cycle advances can persist for months, so this is not a signal to exit.',
        resolution: 'Stay invested but reduce gross exposure and upgrade quality. Do not flip short on a topping reading alone — tops are processes, not dates.'
      });
    }

    // Trend says de-risk while regime says risk-on
    if (regimeBullish && trend && trend.state === 'de_risk') {
      conflicts.push({
        severity: 'medium',
        between: ['Macro Regime', 'Trend State'],
        text: 'Regime is constructive on a 3–12 month view while the trend signal reads extended on a days-to-weeks view. These operate on different horizons and are not mutually exclusive.',
        resolution: 'Keep the regime-implied sector tilt; express caution through position sizing and entry timing rather than by abandoning the allocation.'
      });
    }

    // Bottoming trigger while regime is deteriorating
    if (phase && phase.bottom && phase.bottom.triggered && regime && (regime.label === 'Deflation' || regime.label === 'Stagflation')) {
      conflicts.push({
        severity: 'medium',
        between: ['Bottoming Trigger', 'Macro Regime'],
        text: 'A VIX round-trip bottoming trigger has fired, but the macro regime (' + regime.label + ') is still deteriorating. Volatility bottoms often precede economic bottoms by months.',
        resolution: 'Scale in rather than committing fully. Favour quality and balance-sheet strength over high-beta names until the macro pillars confirm.'
      });
    }

    // Weak regime conviction
    if (regime && regime.confidence < 0.35) {
      notes.push('Macro regime confidence is low (' + pct(regime.confidence, 0) + ') — the growth/inflation reading is near the origin, so the Quad label is tentative. Weight the trend and phase signals more heavily until the macro data resolves.');
    }

    // Agreements are worth stating too — they justify conviction.
    if (trend && phase && phase.top && trend.state === 'de_risk' && phase.top.score >= 0.6) {
      agreements.push('Trend state and topping composite agree on reducing exposure — this is a genuine confluence, and the strongest de-risking case the framework can produce.');
    }
    if (trend && phase && phase.bottom && trend.state === 'accumulate' && phase.bottom.triggered) {
      agreements.push('Trend state and the VIX bottoming trigger agree on adding exposure — historically the highest-conviction entry this framework produces.');
    }

    /* ---- 4. Posture ---- */
    var posture, postureColor;
    if (gross >= 1.05)      { posture = 'Add Risk';      postureColor = '#2E7D52'; }
    else if (gross >= 0.92) { posture = 'Fully Invested'; postureColor = '#003C71'; }
    else if (gross >= 0.75) { posture = 'Trim & Upgrade'; postureColor = '#8B6914'; }
    else                    { posture = 'Defensive';      postureColor = '#8B2A2A'; }

    var tilt = regime ? REGIME_TILTS[regime.label] : null;

    return {
      posture: posture, postureColor: postureColor,
      grossTarget: gross, grossPreCap: grossPreCap, mandateCap: mandateCap,
      grossReasoning: grossWhy,
      tiltOW: tilt ? tilt.OW : [], tiltUW: tilt ? tilt.UW : [],
      tiltRationale: tilt ? tilt.rationale : null,
      conflicts: conflicts, agreements: agreements, notes: notes,
      // One-sentence plain-English thesis — the sentence every page leads with.
      thesis: buildThesis(regime, phase, trend, posture, gross, conflicts)
    };
  }

  function buildThesis(regime, phase, trend, posture, gross, conflicts) {
    var parts = [];
    if (regime) {
      parts.push('The macro regime reads ' + regime.label + ' (' + regime.growthDir.toLowerCase() +
        ' growth, ' + regime.inflDir.toLowerCase() + ' inflation), ' + regime.qualifier + ' at ' +
        pct(regime.confidence, 0) + ' confidence');
    }
    if (phase && phase.top && phase.top.score != null) {
      parts.push('topping conditions are ' + phase.top.band + ' (' + (phase.top.score * 100).toFixed(0) + '/100)');
    }
    if (phase && phase.bottom && phase.bottom.triggered) {
      parts.push('a VIX bottoming trigger is live');
    }
    if (trend) parts.push('the short-term trend state is ' + trend.label);

    var s = parts.length ? parts.join(', ') + '. ' : '';
    s += 'Net posture: ' + posture + ' at ' + pct(gross, 0) + ' of normal gross exposure';
    if (conflicts.length) {
      s += ', with ' + conflicts.length + ' unresolved signal ' + (conflicts.length === 1 ? 'conflict' : 'conflicts') + ' noted below';
    }
    return s + '.';
  }

  /* ══════════════════════════════════════════════════════════════════════════
     SECTION 7 — PUBLIC ENTRY POINT
     ══════════════════════════════════════════════════════════════════════════ */

  var S = {
    CONST: CONST,
    QUADS: QUADS,
    TREND_STATES: TREND_STATES,
    REGIME_TILTS: REGIME_TILTS,
    TOP_COMPONENTS: TOP_COMPONENTS,
    _cache: null,
    _cacheAt: 0
  };

  /** Sync the canonical risk-free rate from live data. */
  function syncRiskFree(macro) {
    var s = macro && macro.yield_3m;
    if (s && num(s.latest_value) != null) {
      CONST.RF_RATE = s.latest_value / 100;
      CONST.RF_SOURCE = 'DGS3MO (3M T-bill) as of ' + s.latest_date;
      CONST.CMA.cash.mu = CONST.RF_RATE;
    }
  }

  /**
   * Build the complete unified state. Everything on the site should read from
   * this. Cached for 5 minutes so a page with a dozen panels computes once.
   *
   * @param {object} opts
   *   macroData  — the /fred payload (pillars). Falls back to window._lastMacroData.
   *   mandate    — { maxGross, level } from the advisor profile.
   *   force      — bypass cache.
   */
  S.state = function (opts) {
    opts = opts || {};
    if (S._cache && !opts.force && (Date.now() - S._cacheAt) < 5 * 60 * 1000) {
      return Promise.resolve(S._cache);
    }

    var WH = window.PerryWarehouse;
    var macroData = opts.macroData || window._lastMacroData || null;

    return Promise.all([
      WH ? WH.macro() : Promise.resolve({}),
      WH ? WH.internals() : Promise.resolve(null),
      WH ? WH.ohlc('SPY') : Promise.resolve(null),
      WH ? WH.load().catch(function () { return null; }) : Promise.resolve(null)
    ]).then(function (res) {
      var macro = res[0] || {};
      var internals = res[1] || null;
      var spy = res[2] || null;

      syncRiskFree(macro);

      /* --- REGIME --- */
      var regime = computeRegime(macroData);

      /* --- PHASE: bottoming --- */
      var vixHist = (macro.vix && macro.vix.history) ? macro.vix.history : [];
      var bottom = detectBottom(vixHist, spy ? spy.c : null);

      /* --- PHASE: topping --- */
      var top = detectTop({ macro: macro, internals: internals, warehouse: WH });

      /* --- TREND --- */
      var trend = null;
      if (spy && spy.c && spy.c.length > 260) {
        var c = spy.c;
        var last = c[c.length - 1];
        var w = c.slice(-252);
        var hi = Math.max.apply(null, w), lo = Math.min.apply(null, w);
        trend = computeTrend({
          vix: macro.vix ? num(macro.vix.latest_value) : null,
          ret12m: last / c[c.length - 253] - 1,
          ddFromPeak: last / hi - 1,
          fromLow: last / lo - 1,
          breadthDiverge: internals ? num(internals.breadth_divergence_3m) : null
        });
      }

      /* --- MANDATE --- */
      var mandate = opts.mandate || readMandate();

      /* --- ARBITRATE --- */
      var view = arbitrate(regime, { top: top, bottom: bottom }, trend, mandate);

      var out = {
        asOf: new Date().toISOString(),
        regime: regime,
        phase: { top: top, bottom: bottom },
        trend: trend,
        mandate: mandate,
        view: view,
        constants: CONST,
        dataHealth: {
          macroSeries: Object.keys(macro).length,
          internalsAvailable: !!internals,
          universeSize: WH && WH.ready() ? WH.all().length : 0,
          coverage: WH ? WH.coverage() : null,
          spyPoints: spy && spy.c ? spy.c.length : 0
        },
        // Every signal with its horizon, for the reconciliation table.
        signals: [
          regime && { name: 'Macro Regime', value: regime.label, horizon: regime.horizon, confidence: regime.confidence, direction: (regime.label === 'Goldilocks' || regime.label === 'Overheat') ? 'risk-on' : 'risk-off', basis: regime.nIndicators + ' FRED indicators' },
          top.score != null && { name: 'Topping Composite', value: (top.score * 100).toFixed(0) + '/100 — ' + top.band, horizon: top.horizon, confidence: top.confidence, direction: top.score >= 0.5 ? 'risk-off' : 'risk-on', basis: top.available + '/' + top.total + ' components' },
          { name: 'Bottoming Trigger', value: bottom.state, horizon: bottom.horizon, confidence: bottom.state === 'no-data' ? 0 : 1, direction: bottom.triggered ? 'risk-on' : 'neutral', basis: 'VIX round-trip through ' + VIX_TRIGGER },
          trend && { name: 'Trend State', value: trend.label, horizon: trend.horizon, confidence: trend.confidence, direction: trend.state === 'de_risk' ? 'risk-off' : trend.state === 'neutral' ? 'neutral' : 'risk-on', basis: 'SPY price/vol structure' },
          mandate && { name: 'Mandate Cap', value: pct(mandate.maxGross, 0) + ' max gross', horizon: 'structural', confidence: 1, direction: 'constraint', basis: mandate.level || 'default' }
        ].filter(Boolean)
      };

      S._cache = out;
      S._cacheAt = Date.now();
      window._perrySignals = out;   // convenience handle for legacy code paths
      return out;
    });
  };

  /** Mandate from the advisor profile in localStorage, with a safe default. */
  function readMandate() {
    var caps = { conservative: 0.70, moderate: 1.00, aggressive: 1.10, speculative: 1.20 };
    try {
      var p = JSON.parse(localStorage.getItem('perry_client_profile') || 'null');
      var lvl = (p && (p.governingLevel || p.level)) || window._riskProfile || 'moderate';
      return { level: lvl, maxGross: caps[lvl] != null ? caps[lvl] : 1.0,
               source: p ? 'client profile' : 'default (no profile completed)' };
    } catch (e) {
      return { level: 'moderate', maxGross: 1.0, source: 'default' };
    }
  }

  /**
   * Regime-tilted expected return for an asset class. Replaces the old
   * SMC_PARAMS drifts (which reached +28%/yr) with the shared CMA plus a
   * bounded tilt.
   */
  S.expectedReturn = function (assetKey, regimeLabel) {
    var cma = CONST.CMA[assetKey];
    if (!cma) return null;
    var tilt = 0;
    var isEquity = /equity|reits/.test(assetKey);
    var isReal = /commodit|gold|tips/.test(assetKey);
    var isDuration = /bond/.test(assetKey);

    if (regimeLabel === 'Goldilocks')       { if (isEquity) tilt = +0.02; if (isReal) tilt = -0.01; }
    else if (regimeLabel === 'Overheat')    { if (isReal) tilt = +0.02; if (isDuration) tilt = -0.02; if (isEquity) tilt = -0.005; }
    else if (regimeLabel === 'Stagflation') { if (isEquity) tilt = -0.025; if (isReal) tilt = +0.025; if (isDuration) tilt = -0.01; }
    else if (regimeLabel === 'Deflation')   { if (isEquity) tilt = -0.03; if (isDuration) tilt = +0.02; if (isReal) tilt = -0.02; }

    tilt = clamp(tilt, -CONST.REGIME_TILT_CAP, CONST.REGIME_TILT_CAP);
    return { mu: cma.mu + tilt, sig: cma.sig, base: cma.mu, tilt: tilt, label: cma.label };
  };

  S.detectTop = detectTop;
  S.detectBottom = detectBottom;
  S.computeRegime = computeRegime;
  S.computeTrend = computeTrend;
  S.arbitrate = arbitrate;
  S.util = { clamp: clamp, scale01: scale01, pct: pct, median: median, mean: mean };

  window.PerrySignals = S;

  /* Back-compat shim: legacy code reads window._briefingState with the OLD
     state names. Previously that variable silently defaulted to 'growth',
     which made the valuation tab assert a regime that might contradict the
     macro page. It now maps from the unified trend state, and stays null until
     real data arrives so callers can render "not yet loaded" instead of a
     fabricated regime. */
  S.legacyStateName = function (unified) {
    var map = { accumulate: 'leveraged', risk_on: 'growth', neutral: 'neutral', de_risk: 'drawdown' };
    return unified && unified.trend ? map[unified.trend.state] : null;
  };
})();
