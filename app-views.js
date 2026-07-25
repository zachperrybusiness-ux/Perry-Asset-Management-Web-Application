/* ============================================================================
   Perry Asset Management — Unified View Renderers  (app-views.js)
   Added 2026-07-24.  Load LAST, after app-ml.js and app-advisor.js.

   WHY THIS EXISTS
   ---------------
   The audit found the site's core structural problem was not any single wrong
   number — it was that five regime taxonomies produced five unreconciled
   opinions, and no page ever stated a single view. This file renders that single
   view, and deliberately gives CONFLICT its own visible section.

   Renders:
     1. renderUnifiedView()   — thesis, posture, signal reconciliation, conflicts
     2. renderPhasePanel()    — topping composite + bottoming trigger
     3. renderHoldingRanker() — ML + factor ranking of every holding, with
                                upgrade candidates and rebalance actions
   ============================================================================ */

(function () {
  'use strict';

  var V = {};

  /* ══════════════ small helpers ══════════════ */

  function pct(v, d) { return v == null ? '—' : (v * 100).toFixed(d == null ? 1 : d) + '%'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  }); }
  function el(id) { return document.getElementById(id); }
  function usd(v) {
    if (v == null || !isFinite(v)) return '—';
    var a = Math.abs(v);
    if (a >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    return '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  var DIR_STYLE = {
    'risk-on':    { bg: '#E8F3EC', fg: '#2E7D52', label: 'Risk-On' },
    'risk-off':   { bg: '#F7E9E6', fg: '#8B2A2A', label: 'Risk-Off' },
    'neutral':    { bg: '#FBF3E0', fg: '#8B6914', label: 'Neutral' },
    'constraint': { bg: '#EDF2F8', fg: '#003C71', label: 'Constraint' }
  };

  /* ══════════════════════════════════════════════════════════════════════════
     1. UNIFIED VIEW
     ══════════════════════════════════════════════════════════════════════════ */

  V.renderUnifiedView = function (sig) {
    var host = el('unifiedView');
    if (!host) return;
    if (!sig || !sig.view) {
      host.innerHTML = '<div style="padding:16px;border:1px solid var(--border);border-radius:6px;font-size:13px;color:var(--text-sec);">'
        + 'Signal engine could not resolve — macro data unavailable. Open the Macro page to load the FRED scorecard.</div>';
      return;
    }

    var v = sig.view;
    var h = '';

    /* ---- Posture header: the single sentence the whole site now leads with ---- */
    h += '<div class="card" style="margin-bottom:0;">';
    h += '<div class="card-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">'
      +  '<span>Unified View &mdash; One Posture</span>'
      +  '<span style="font-size:11px;font-weight:400;opacity:.85;">Macro sets the tilt &middot; Phase sets exposure &middot; Trend sets timing &middot; Mandate caps all</span>'
      +  '</div>';
    h += '<div class="card-body">';

    h += '<div style="display:grid;grid-template-columns:minmax(160px,200px) 1fr;gap:20px;align-items:center;">';
    h += '<div style="text-align:center;padding:14px;border-radius:8px;background:' + v.postureColor + '12;border:2px solid ' + v.postureColor + ';">'
      +  '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-sec);">Posture</div>'
      +  '<div style="font-size:22px;font-weight:800;color:' + v.postureColor + ';line-height:1.2;margin:4px 0;">' + esc(v.posture) + '</div>'
      +  '<div style="font-size:28px;font-weight:800;color:' + v.postureColor + ';">' + pct(v.grossTarget, 0) + '</div>'
      +  '<div style="font-size:10px;color:var(--text-sec);">of normal gross exposure</div>'
      +  '</div>';
    h += '<div>';
    h += '<div style="font-size:14px;line-height:1.75;color:var(--text-pri);">' + esc(v.thesis) + '</div>';

    // Sector tilt from the regime
    if (v.tiltOW && v.tiltOW.length) {
      h += '<div style="margin-top:12px;font-size:12px;line-height:1.8;">'
        +  '<strong style="color:#2E7D52;">Overweight:</strong> ' + v.tiltOW.map(esc).join(', ') + '<br>'
        +  '<strong style="color:#8B2A2A;">Underweight:</strong> ' + v.tiltUW.map(esc).join(', ')
        +  '</div>';
      if (v.tiltRationale) {
        h += '<div style="margin-top:6px;font-size:11px;color:var(--text-sec);line-height:1.6;font-style:italic;">' + esc(v.tiltRationale) + '</div>';
      }
    }
    h += '</div></div>';

    /* ---- How the exposure number was built (traceability) ---- */
    if (v.grossReasoning && v.grossReasoning.length) {
      h += '<div style="margin-top:14px;padding:10px 12px;background:var(--panel);border-radius:4px;font-size:11px;color:var(--text-sec);line-height:1.8;">'
        +  '<strong style="color:var(--navy);">How ' + pct(v.grossTarget, 0) + ' was derived:</strong> '
        +  v.grossReasoning.map(esc).join(' &nbsp;·&nbsp; ')
        +  (v.grossPreCap > v.mandateCap
              ? ' &nbsp;·&nbsp; <strong>capped at ' + pct(v.mandateCap, 0) + ' by your mandate</strong>'
              : '')
        +  '</div>';
    }

    /* ---- SIGNAL RECONCILIATION TABLE — the core of the fix ---- */
    h += '<div style="margin-top:16px;">';
    h += '<div style="font-size:12px;font-weight:700;color:var(--navy);margin-bottom:6px;">Signal Reconciliation</div>';
    h += '<div class="table-wrap"><table style="font-size:12px;"><thead><tr>'
      +  '<th style="text-align:left;">Signal</th><th style="text-align:left;">Reading</th>'
      +  '<th style="text-align:center;">Direction</th><th style="text-align:center;">Horizon</th>'
      +  '<th style="text-align:center;">Confidence</th><th style="text-align:left;">Basis</th>'
      +  '</tr></thead><tbody>';
    (sig.signals || []).forEach(function (s) {
      var ds = DIR_STYLE[s.direction] || DIR_STYLE.neutral;
      h += '<tr>'
        +  '<td style="font-weight:600;">' + esc(s.name) + '</td>'
        +  '<td>' + esc(s.value) + '</td>'
        +  '<td style="text-align:center;"><span style="background:' + ds.bg + ';color:' + ds.fg + ';padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">' + ds.label + '</span></td>'
        +  '<td style="text-align:center;font-size:11px;color:var(--text-sec);">' + esc(s.horizon) + '</td>'
        +  '<td style="text-align:center;font-family:Courier New,monospace;">' + (s.confidence == null ? '—' : pct(s.confidence, 0)) + '</td>'
        +  '<td style="font-size:11px;color:var(--text-sec);">' + esc(s.basis) + '</td>'
        +  '</tr>';
    });
    h += '</tbody></table></div>';
    h += '<div style="font-size:11px;color:var(--text-sec);margin-top:6px;line-height:1.6;">'
      +  'Horizon is shown on every row deliberately. A days-to-weeks trend signal and a 3–12 month regime signal '
      +  'pointing opposite ways is not a contradiction — it is two different questions. Comparing them as if they '
      +  'were the same claim was the root of the conflicting recommendations this framework replaces.'
      +  '</div>';
    h += '</div>';

    /* ---- CONFLICTS — surfaced, never silently resolved ---- */
    if (v.conflicts && v.conflicts.length) {
      h += '<div style="margin-top:16px;">';
      h += '<div style="font-size:12px;font-weight:700;color:#8B2A2A;margin-bottom:6px;">Unresolved Conflicts (' + v.conflicts.length + ')</div>';
      v.conflicts.forEach(function (c) {
        var sev = c.severity === 'high' ? { bg: '#F7E9E6', bd: '#8B2A2A' } : { bg: '#FBF3E0', bd: '#8B6914' };
        h += '<div style="background:' + sev.bg + ';border-left:4px solid ' + sev.bd + ';padding:10px 14px;border-radius:0 4px 4px 0;margin-bottom:8px;font-size:12px;line-height:1.7;">'
          +  '<strong style="color:' + sev.bd + ';">' + c.between.map(esc).join(' vs ') + '</strong><br>'
          +  esc(c.text)
          +  '<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(0,0,0,.08);"><strong>Resolution:</strong> ' + esc(c.resolution) + '</div>'
          +  '</div>';
      });
      h += '</div>';
    }

    /* ---- AGREEMENTS — these justify conviction ---- */
    if (v.agreements && v.agreements.length) {
      h += '<div style="margin-top:10px;">';
      v.agreements.forEach(function (a) {
        h += '<div style="background:#E8F3EC;border-left:4px solid #2E7D52;padding:10px 14px;border-radius:0 4px 4px 0;margin-bottom:8px;font-size:12px;line-height:1.7;">'
          +  '<strong style="color:#2E7D52;">Signals agree.</strong> ' + esc(a) + '</div>';
      });
      h += '</div>';
    }

    if (v.notes && v.notes.length) {
      h += '<div style="margin-top:10px;font-size:11px;color:var(--text-sec);line-height:1.7;">';
      v.notes.forEach(function (n) { h += '<div style="margin-bottom:4px;">• ' + esc(n) + '</div>'; });
      h += '</div>';
    }

    /* ---- Data health, so confidence is always contextualised ---- */
    var dh = sig.dataHealth || {};
    h += '<div style="margin-top:14px;padding-top:10px;border-top:1px solid var(--border);font-size:10px;color:var(--text-sec);">'
      +  '<strong>Data behind this view:</strong> ' + (dh.macroSeries || 0) + ' macro series &middot; '
      +  (dh.universeSize || 0) + ' names in warehouse &middot; '
      +  (dh.internalsAvailable ? 'market internals current' : '<span style="color:#8B6914;">internals unavailable</span>') + ' &middot; '
      +  'risk-free ' + pct(sig.constants.RF_RATE, 2) + ' from ' + esc(sig.constants.RF_SOURCE)
      +  '</div>';

    h += '</div>';  // card-body
    h += '<div class="card-sources"><strong>Method:</strong> Four signals resolved by a stated hierarchy — regime sets sector tilt, market phase sets gross exposure, trend sets entry timing, and the risk mandate caps everything. Conflicts are reported rather than averaged away. All capital-market assumptions come from a single shared constant block.</div>';
    h += '</div>';

    host.innerHTML = h;
  };

  /* ══════════════════════════════════════════════════════════════════════════
     2. PHASE PANEL — topping composite + bottoming trigger
     ══════════════════════════════════════════════════════════════════════════ */

  V.renderPhasePanel = function (sig) {
    var host = el('phasePanel');
    if (!host || !sig || !sig.phase) return;

    var top = sig.phase.top, bot = sig.phase.bottom;
    var h = '';

    h += '<div class="card"><div class="card-title">Market Phase &mdash; Topping &amp; Bottoming Signals</div><div class="card-body">';

    /* ---- BOTTOMING ---- */
    var botColor = bot.triggered ? '#2E7D52' : bot.armed ? '#8B6914' : '#5A6A7A';
    h += '<div style="display:flex;gap:14px;align-items:flex-start;padding:12px;border-radius:6px;background:' + botColor + '10;border:1px solid ' + botColor + '55;margin-bottom:14px;">';
    h += '<div style="min-width:110px;text-align:center;">'
      +  '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-sec);">Bottoming</div>'
      +  '<div style="font-size:16px;font-weight:800;color:' + botColor + ';text-transform:capitalize;">' + esc(bot.state) + '</div>'
      +  '<div style="font-size:11px;color:var(--text-sec);">VIX ' + (bot.currentVix == null ? '—' : bot.currentVix.toFixed(1)) + '</div>'
      +  '</div>';
    h += '<div style="font-size:12px;line-height:1.7;">'
      +  esc(bot.label)
      +  '<div style="margin-top:5px;color:var(--text-sec);font-size:11px;">'
      +  'Rule: VIX closes above ' + bot.threshold + ', then crosses back below it. The round-trip is the signal — '
      +  'the spike alone only tells you stress is present, not that it is resolving.'
      +  (bot.priceConfirmed != null
            ? ' <strong>Price confirmation:</strong> SPY is ' + (bot.priceConfirmed ? 'above' : 'below') + ' its level at the trigger.'
            : '')
      +  (bot.triggerCount ? ' Found ' + bot.triggerCount + ' completed round-trips in the available history.' : '')
      +  '</div></div></div>';

    /* ---- TOPPING COMPOSITE ---- */
    var tc = top.score == null ? '#5A6A7A'
      : top.score >= 0.70 ? '#8B2A2A' : top.score >= 0.50 ? '#8B6914' : '#2E7D52';

    h += '<div style="display:flex;gap:14px;align-items:center;margin-bottom:12px;">';
    h += '<div style="min-width:110px;text-align:center;">'
      +  '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-sec);">Topping</div>'
      +  '<div style="font-size:30px;font-weight:800;color:' + tc + ';line-height:1;">' + (top.score == null ? '—' : (top.score * 100).toFixed(0)) + '</div>'
      +  '<div style="font-size:10px;color:var(--text-sec);">out of 100</div>'
      +  '</div>';
    h += '<div style="flex:1;">'
      +  '<div style="font-size:14px;font-weight:700;color:' + tc + ';">' + esc(top.label) + '</div>'
      +  '<div style="font-size:11px;color:var(--text-sec);margin-top:3px;">'
      +  top.available + ' of ' + top.total + ' components have data'
      +  (top.elevated && top.elevated.length ? ' &middot; elevated: <strong>' + top.elevated.map(esc).join(', ') + '</strong>' : '')
      +  '</div>'
      + (top.note ? '<div style="font-size:11px;color:#8B6914;margin-top:4px;">' + esc(top.note) + '</div>' : '')
      +  '</div></div>';

    // Component table — every input visible, with its own reading and provenance.
    h += '<div class="table-wrap"><table style="font-size:12px;"><thead><tr>'
      +  '<th style="text-align:left;">Component</th><th style="text-align:right;">Weight</th>'
      +  '<th style="text-align:left;">Current reading</th><th style="text-align:center;">Signal</th>'
      +  '<th style="text-align:center;">As of</th>'
      +  '</tr></thead><tbody>';
    top.components.forEach(function (c) {
      var rc = !c.available ? '#8A97A3'
        : c.norm >= 0.75 ? '#8B2A2A' : c.norm >= 0.5 ? '#8B6914' : '#2E7D52';
      var bar = c.available ? Math.round(c.norm * 100) : 0;
      h += '<tr' + (c.available ? '' : ' style="opacity:.55;"') + '>'
        +  '<td style="font-weight:600;" title="' + esc(c.why) + '">' + esc(c.label)
        +  '<div style="font-size:10px;font-weight:400;color:var(--text-sec);line-height:1.5;max-width:340px;">' + esc(c.why) + '</div></td>'
        +  '<td style="text-align:right;font-family:Courier New,monospace;">' + (c.weight * 100).toFixed(0) + '%</td>'
        +  '<td style="font-size:11px;">' + esc(c.display) + '</td>'
        +  '<td style="text-align:center;min-width:110px;">'
        +    (c.available
              ? '<div style="background:#E6E9ED;border-radius:6px;height:8px;overflow:hidden;"><div style="width:' + bar + '%;height:100%;background:' + rc + ';"></div></div>'
                + '<div style="font-size:10px;color:' + rc + ';margin-top:2px;text-transform:capitalize;">' + esc(c.reading) + '</div>'
              : '<span style="font-size:10px;color:var(--text-sec);">no data</span>')
        +  '</td>'
        +  '<td style="text-align:center;font-size:10px;color:' + (c.stale ? '#8B6914' : 'var(--text-sec)') + ';">'
        +    (c.asOf ? esc(c.asOf) + (c.daysOld != null ? '<br>' + c.daysOld + 'd old' : '') : 'live')
        +  '</td>'
        +  '</tr>';
    });
    h += '</tbody></table></div>';

    h += '<div style="font-size:11px;color:var(--text-sec);margin-top:10px;line-height:1.7;">'
      +  '<strong>How to read the composite.</strong> Each component is normalised to 0–1 against explicit anchors, '
      +  'then weighted. Components with no data are <em>excluded and the weights renormalised</em> — missing data is '
      +  'never treated as a benign reading, and the coverage count above tells you how much of the composite is '
      +  'actually measured. A high score is not a sell signal: tops are processes that can run for months. It is a '
      +  'reason to reduce gross exposure and upgrade quality, which is exactly what the unified view does with it.'
      +  '</div>';

    h += '</div>';
    h += '<div class="card-sources"><strong>Sources:</strong> FRED series — margin loans (BOGZ1FL663067003Q), personal saving rate (PSAVERT), U. Michigan sentiment (UMCSENT), 30Y Treasury (DGS30), financial conditions (NFCI), VIX (VIXCLS). Concentration, breadth, growth contribution and valuation medians are computed cross-sectionally from the warehouse universe. IPO counts from FMP, US venues only, SPACs excluded.</div>';
    h += '</div>';

    host.innerHTML = h;
  };

  /* ══════════════════════════════════════════════════════════════════════════
     3. HOLDING RANKER — "is this the best stock to be holding?"
     ══════════════════════════════════════════════════════════════════════════ */

  V.renderHoldingRanker = function (containerId) {
    var host = el(containerId || 'holdingRanker');
    if (!host) return;

    var WH = window.PerryWarehouse, ML = window.PerryML;
    if (!WH || !ML) { host.innerHTML = ''; return; }

    if (!WH.ready()) {
      host.innerHTML = '<div class="card"><div class="card-title">Holding Quality Ranker</div><div class="card-body">'
        + '<p style="font-size:13px;color:var(--text-sec);">The market warehouse has not been populated yet. '
        + 'The nightly ingestion job builds it — on the FMP free tier the universe fills over roughly two weeks, '
        + 'with your own holdings ingested first. Until then this panel stays hidden rather than showing a partial ranking.</p>'
        + '</div></div>';
      return;
    }

    var holdings = (window._holdings || []).filter(function (h) {
      return h.ticker && !['Cash', 'Money Market', 'CD'].includes(h.assetClass);
    });
    if (!holdings.length) {
      host.innerHTML = '<div class="card"><div class="card-title">Holding Quality Ranker</div><div class="card-body">'
        + '<p style="font-size:13px;color:var(--text-sec);">Add holdings to see them ranked against their industry peers.</p>'
        + '</div></div>';
      return;
    }

    var opt;
    try { opt = ML.optimizePortfolio(holdings, {}); }
    catch (e) {
      host.innerHTML = '<div class="card"><div class="card-body"><p style="color:#8B2A2A;font-size:12px;">Ranker error: ' + esc(e.message) + '</p></div></div>';
      return;
    }
    if (opt.error) {
      host.innerHTML = '<div class="card"><div class="card-body"><p style="font-size:12px;color:var(--text-sec);">' + esc(opt.error) + '</p></div></div>';
      return;
    }

    var model = opt.model;
    var h = '';

    h += '<div class="card"><div class="card-title">Holding Quality Ranker &mdash; Factor + ML Ensemble</div><div class="card-body">';

    /* ---- Model skill disclosure FIRST. If the model has no edge, say so before
           showing anything it produced. ---- */
    if (model && model.skill) {
      var sk = model.skill;
      var skColor = sk.best > 0.15 ? '#2E7D52' : sk.best > 0.05 ? '#8B6914' : '#8B2A2A';
      h += '<div style="background:' + skColor + '10;border-left:4px solid ' + skColor + ';padding:10px 14px;border-radius:0 4px 4px 0;margin-bottom:14px;font-size:12px;line-height:1.75;">'
        +  '<strong style="color:' + skColor + ';">Model skill, stated before the results.</strong> ' + esc(sk.verdict)
        +  '<div style="margin-top:6px;font-family:Courier New,monospace;font-size:11px;color:var(--text-sec);">'
        +  'Random forest out-of-bag: R&sup2; ' + (sk.rf_oob_r2 == null ? '—' : sk.rf_oob_r2.toFixed(3))
        +  ', rank corr ' + (sk.rf_oob_spearman == null ? '—' : sk.rf_oob_spearman.toFixed(3))
        +  ' (n=' + (sk.rf_oob_n || 0) + ')<br>'
        +  'Gradient boosting validation: R&sup2; ' + (sk.gb_val_r2 == null ? '—' : sk.gb_val_r2.toFixed(3))
        +  ', rank corr ' + (sk.gb_val_spearman == null ? '—' : sk.gb_val_spearman.toFixed(3))
        +  ' (n=' + (sk.gb_val_n || 0) + ', stopped at round ' + (sk.gb_best_round || 0) + ')'
        +  '</div>'
        +  '<div style="margin-top:5px;font-size:11px;color:var(--text-sec);">'
        +  'Negative R&sup2; on equity returns is normal and expected — rank correlation is the metric that matters for a '
        +  'ranking model. The ML weight is derived from measured skill, so a model that has not earned influence does not get any.'
        +  '</div></div>';
    }

    h += '<div style="font-size:12px;color:var(--text-sec);margin-bottom:12px;line-height:1.7;">'
      +  'Every holding is scored on five factor blocks, each computed as a <strong>cohort-relative z-score</strong> '
      +  '(industry peers first, falling back to sector then market when a cohort is too small). Raw ratios are never '
      +  'compared across industries — a 32&times; P/E means something different in software than in utilities. '
      +  'Factor weights shift with the macro regime'
      +  (opt.regime ? ', currently <strong>' + esc(opt.regime) + '</strong>' : '')
      +  '. ' + esc(opt.derivation)
      +  '</div>';

    // Regime factor weights, visible so the tilt is auditable.
    if (opt.ranked && opt.ranked.weights) {
      h += '<div style="font-size:11px;color:var(--text-sec);margin-bottom:12px;padding:8px 10px;background:var(--panel);border-radius:4px;">'
        +  '<strong>Factor weights in this regime:</strong> '
        +  Object.keys(opt.ranked.weights).map(function (k) {
             return esc(k) + ' ' + (opt.ranked.weights[k] * 100).toFixed(0) + '%';
           }).join(' &middot; ')
        +  (opt.mlWeight > 0 ? ' &nbsp;|&nbsp; <strong>ML contribution:</strong> ' + (opt.mlWeight * 100).toFixed(0) + '%' : ' &nbsp;|&nbsp; ML contribution: 0% (no measured skill)')
        +  '</div>';
    }

    /* ---- Main ranking table ---- */
    h += '<div class="table-wrap"><table style="font-size:12px;"><thead><tr>'
      +  '<th style="text-align:left;">#</th><th style="text-align:left;">Holding</th>'
      +  '<th style="text-align:left;">Cohort</th>'
      +  '<th style="text-align:center;">Value</th><th style="text-align:center;">Quality</th>'
      +  '<th style="text-align:center;">Momentum</th><th style="text-align:center;">Low Vol</th>'
      +  '<th style="text-align:right;">Composite</th>'
      +  '<th style="text-align:right;" title="CAPM expected return: risk-free + Blume-adjusted beta x regime-tilted equity premium, plus a bounded factor tilt. A ranking and sizing input, not a price target.">Exp. Return</th>'
      +  '<th style="text-align:right;" title="Expected excess return divided by measured annualised volatility. This is what drives position sizing.">Fwd Sharpe</th>'
      +  '<th style="text-align:center;">Regime Fit</th>'
      +  '<th style="text-align:left;">Verdict</th>'
      +  '<th style="text-align:right;">Weight &rarr; Target</th>'
      +  '</tr></thead><tbody>';

    var zCell = function (z) {
      if (z == null) return '<td style="text-align:center;color:var(--text-sec);">—</td>';
      var c = z >= 0.5 ? '#2E7D52' : z <= -0.5 ? '#8B2A2A' : '#8B6914';
      return '<td style="text-align:center;font-family:Courier New,monospace;color:' + c + ';font-weight:600;">' + (z >= 0 ? '+' : '') + z.toFixed(2) + '</td>';
    };

    opt.actions.forEach(function (a, i) {
      if (!a.covered) {
        h += '<tr style="opacity:.5;"><td>' + (i + 1) + '</td><td style="font-weight:600;">' + esc(a.ticker) + '</td>'
          +  '<td colspan="9" style="font-size:11px;color:var(--text-sec);">' + esc(a.note || 'No warehouse data') + '</td></tr>';
        return;
      }
      var r = opt.ranked.rows.filter(function (x) { return x.ticker === a.ticker; })[0] || {};
      var b = r.blocks || {};
      var fitColor = a.regimeFit.fit === 'favoured' ? '#2E7D52' : a.regimeFit.fit === 'unfavoured' ? '#8B2A2A' : '#8B6914';
      var actColor = a.action === 'Add' ? '#2E7D52' : a.action === 'Trim' ? '#8B2A2A' : '#5A6A7A';

      h += '<tr>';
      h += '<td style="font-weight:700;">' + a.rank + '</td>';
      h += '<td style="font-weight:600;">' + esc(a.ticker)
        +  '<div style="font-size:10px;font-weight:400;color:var(--text-sec);">' + esc((a.name || '').slice(0, 28)) + '</div></td>';
      h += '<td style="font-size:10px;color:var(--text-sec);">' + esc(r.cohortLabel || '—')
        +  '<br>n=' + (r.cohortN || 0) + '</td>';
      h += zCell(b.value ? b.value.z : null);
      h += zCell(b.quality ? b.quality.z : null);
      h += zCell(b.momentum ? b.momentum.z : null);
      h += zCell(b.lowvol ? b.lowvol.z : null);
      var compColor = a.composite >= 0.5 ? '#2E7D52' : a.composite <= -0.5 ? '#8B2A2A' : '#8B6914';
      h += '<td style="text-align:right;font-weight:800;font-family:Courier New,monospace;color:' + compColor + ';">'
        +  (a.composite >= 0 ? '+' : '') + a.composite.toFixed(2)
        +  '<div style="font-size:9px;font-weight:400;color:var(--text-sec);">' + a.percentile.toFixed(0) + 'th pct</div></td>';
      // Forecast columns — the price-forecast engine is now wired into sizing.
      var fc = a.forecast;
      h += '<td style="text-align:right;font-family:Courier New,monospace;font-size:11px;">'
        +  (fc ? pct(fc.expectedReturn, 1) : '—')
        +  (fc ? '<div style="font-size:9px;color:var(--text-sec);">&beta; ' + fc.beta.toFixed(2)
                 + (fc.betaMeasured ? '' : '<span title="Warehouse coverage pending — beta defaulted to 1.0">*</span>') + '</div>' : '')
        +  '</td>';
      h += '<td style="text-align:right;font-family:Courier New,monospace;font-size:11px;">'
        +  (fc && fc.forwardSharpe != null ? fc.forwardSharpe.toFixed(2) : '—')
        +  (a.sharpeTilt != null && Math.abs(a.sharpeTilt - 1) > 0.02
              ? '<div style="font-size:9px;color:' + (a.sharpeTilt > 1 ? 'var(--success)' : '#8B6914') + ';">'
                + (a.sharpeTilt > 1 ? '+' : '') + ((a.sharpeTilt - 1) * 100).toFixed(0) + '% size</div>'
              : '')
        +  '</td>';
      h += '<td style="text-align:center;font-size:10px;color:' + fitColor + ';">' + esc(a.regimeFit.label) + '</td>';
      h += '<td><span style="color:' + a.verdict.color + ';font-weight:700;font-size:11px;">' + esc(a.verdict.call) + '</span>'
        +  '<div style="font-size:10px;color:var(--text-sec);line-height:1.5;max-width:230px;">' + esc(a.verdict.action) + '</div></td>';
      h += '<td style="text-align:right;font-family:Courier New,monospace;font-size:11px;">'
        +  pct(a.currentWeight, 1) + ' &rarr; ' + pct(a.targetWeight, 1)
        +  '<div style="color:' + actColor + ';font-weight:700;">' + esc(a.action)
        +  (Math.abs(a.dollarDelta) > 1 ? ' ' + usd(Math.abs(a.dollarDelta)) : '') + '</div>'
        +  (a.positionCapped || a.sectorCapped
              ? '<div style="font-size:9px;color:#8B6914;" title="The model wanted a larger weight; diversification caps limited it.">'
                + (a.positionCapped ? 'position cap' : 'sector cap') + '</div>'
              : '')
        +  '</td>';
      h += '</tr>';

      // Upgrade candidates for weak holdings — constructive rather than just "sell".
      if (a.upgrades && a.upgrades.length) {
        h += '<tr><td></td><td colspan="10" style="background:rgba(139,105,20,.06);font-size:11px;padding:8px 10px;">'
          +  '<strong style="color:#8B6914;">Higher-ranked alternatives in ' + esc(a.sector) + ':</strong> '
          +  a.upgrades.map(function (u) {
               return '<strong>' + esc(u.ticker) + '</strong> (+' + u.edge.toFixed(2) + ' composite'
                 + (u.betterOn.length ? ', stronger on ' + u.betterOn.map(esc).join(' & ') : '') + ')';
             }).join(' &nbsp;·&nbsp; ')
          +  '<div style="color:var(--text-sec);margin-top:3px;">Screened for the same sector, minimum $2B market cap and $10M average daily dollar volume. Identify the replacement before selling — this is a swap, not an exit.</div>'
          +  '</td></tr>';
      }
    });

    h += '</tbody></table></div>';

    if (opt.cashTarget > 0.01) {
      h += '<div style="margin-top:10px;padding:9px 12px;background:#EDF2F8;border-radius:4px;font-size:12px;line-height:1.7;">'
        +  '<strong>Cash target: ' + pct(opt.cashTarget, 0) + '</strong> — the unified view sets gross exposure at '
        +  pct(opt.grossTarget, 0) + ', so the balance is held in cash rather than forced into the ranking.'
        +  (opt.capShortfallNote ? '<br><span style="color:#8B6914;">' + esc(opt.capShortfallNote) + '</span>' : '')
        +  '</div>';
    }
    if (opt.capsBinding && opt.capsBinding.length) {
      h += '<div style="margin-top:8px;font-size:11px;color:#8B6914;line-height:1.7;">'
        +  '<strong>Diversification caps binding:</strong> ' + opt.capsBinding.map(esc).join(', ')
        +  '. Limits are ' + pct(opt.maxPosition, 0) + ' per position and ' + pct(opt.maxSector, 0)
        +  ' per sector, applied as absolute percentages of the portfolio — deliberately not scaled by the exposure '
        +  'target, since a concentration limit that loosened when signals turned bullish would defeat its purpose.'
        +  '</div>';
    }

    // Permutation importance — which factors are actually doing work.
    if (model && model.importance && model.importance.features) {
      h += '<div style="margin-top:16px;"><div style="font-size:12px;font-weight:700;color:var(--navy);margin-bottom:6px;">'
        +  'Permutation Importance <span style="font-weight:400;font-size:11px;color:var(--text-sec);">'
        +  '(measured by degrading held-out rank correlation, not by coefficient size)</span></div>';
      h += '<div class="table-wrap"><table style="font-size:11px;"><thead><tr><th style="text-align:left;">Feature</th>'
        +  '<th style="text-align:right;">Importance</th><th style="text-align:right;">Share</th><th style="text-align:left;">Note</th></tr></thead><tbody>';
      model.importance.features.slice(0, 12).forEach(function (f) {
        h += '<tr' + (f.noise ? ' style="opacity:.55;"' : '') + '>'
          +  '<td>' + esc(f.feature) + '</td>'
          +  '<td style="text-align:right;font-family:Courier New,monospace;">' + f.importance.toFixed(4) + '</td>'
          +  '<td style="text-align:right;">' + f.pctOfTotal.toFixed(1) + '%</td>'
          +  '<td style="font-size:10px;color:var(--text-sec);">' + (f.noise ? 'Shuffling improved the score — treat as noise' : '') + '</td>'
          +  '</tr>';
      });
      h += '</tbody></table></div></div>';
    }

    // Collinearity, for the same reason it was added to the quant page.
    if (model && model.vif) {
      var sev = model.vif.filter(function (x) { return x.severity === 'severe'; });
      if (sev.length) {
        h += '<div style="margin-top:10px;font-size:11px;color:#8B6914;">'
          +  '<strong>Collinearity note:</strong> ' + sev.map(function (x) { return esc(x.feature); }).join(', ')
          +  ' show VIF above 10, so their individual contributions are not separately identifiable. '
          +  'The composite is unaffected — only the per-feature attribution should be read with care.</div>';
      }
    }

    if (opt.ranked.missing && opt.ranked.missing.length) {
      h += '<div style="margin-top:10px;font-size:11px;color:var(--text-sec);">'
        +  '<strong>Not yet covered:</strong> ' + opt.ranked.missing.map(esc).join(', ')
        +  ' — awaiting warehouse ingestion. These are excluded from the ranking rather than scored on partial data.</div>';
    }

    h += '</div>';
    h += '<div class="card-sources"><strong>Method:</strong> Cohort-relative robust z-scores (median/MAD, winsorised at the 2nd/98th percentile) across value, quality, momentum, growth and low-volatility blocks, weighted by macro regime. Random forest (bagged CART, out-of-bag scored) and gradient boosting (stagewise, early-stopped on a held-out split) trained in-browser on the warehouse panel. ML weight is a function of measured out-of-sample rank correlation and is zero when no skill is detected. Fundamentals via FMP, prices via Yahoo, both stored in Firestore.</div>';
    h += '</div>';

    host.innerHTML = h;
  };

  /* ══════════════════════════════════════════════════════════════════════════
     WIRING — one listener, driven by the signal engine rather than timers
     ══════════════════════════════════════════════════════════════════════════ */

  document.addEventListener('perry:signals', function (e) {
    var sig = e.detail;
    try { V.renderUnifiedView(sig); } catch (err) { console.warn('[views] unified:', err); }
    try { V.renderPhasePanel(sig); } catch (err) { console.warn('[views] phase:', err); }
    try { V.renderHoldingRanker(); } catch (err) { console.warn('[views] ranker:', err); }
  });

  // Holdings can load after signals resolve; re-render the ranker when they do.
  document.addEventListener('perry:holdings', function () {
    try { V.renderHoldingRanker(); } catch (err) { console.warn('[views] ranker:', err); }
  });

  window.PerryViews = V;
})();
