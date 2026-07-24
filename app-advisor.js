/* ============================================================================
   Perry Asset Management — Advisor Suite  (app-advisor.js)
   Added 2026-07. Advisor-grade planning tools for the Manage Holdings page.

   Modules:
     • Client Profile (risk tolerance + risk capacity → governing risk level)
     • Overview (profile, governing risk, regime, allocation snapshot)
     • Recommendation Engine (buy/sell/trim + asset location + rationale)
     • Glide Path & De-Risking
     • Cash-Flow & Liquidity Planner
     • Retirement Readiness (Monte Carlo)
     • Decumulation & Withdrawal Sequencer
     • Tax-Planning Center
     • Life-Event Re-Planner

   Reads existing globals: window._holdings, window._riskProfile, RISK_PROFILES,
   window._regimeSignalScore.  Persists to localStorage.
   NOT financial advice — model output for educational use.
   ========================================================================== */
(function () {
  'use strict';

  var ADV = window.ADV = { _charts: {}, section: 'overview' };

  /* ---------- constants ------------------------------------------------- */
  var LS_PROFILE = 'perry_client_profile';
  var LS_REGIME  = 'perry_adv_regime';

  var LEVELS = ['conservative', 'moderate', 'aggressive', 'speculative'];
  var LEVEL_META = {
    conservative: { label: 'Conservative', emoji: '🛡️', color: '#5B9BD5' },
    moderate:     { label: 'Moderate',     emoji: '⚖️', color: '#003C71' },
    aggressive:   { label: 'Aggressive',   emoji: '🚀', color: '#2E7D52' },
    speculative:  { label: 'Speculative',  emoji: '⚡', color: '#A23B72' }
  };

  // base strategic stock / bond / cash split by level
  var BASE_ALLOC = {
    conservative: { s: 30, b: 50, c: 20 },
    moderate:     { s: 60, b: 30, c: 10 },
    aggressive:   { s: 85, b: 10, c: 5 },
    speculative:  { s: 95, b: 0,  c: 5 }
  };
  var RET_EQUITY_FLOOR = { conservative: 20, moderate: 40, aggressive: 55, speculative: 60 };

  // long-run nominal capital-market assumptions (per asset bucket)
  var CMA = {
    stock: { mu: 0.085, sig: 0.16 },
    bond:  { mu: 0.040, sig: 0.065 },
    cash:  { mu: 0.030, sig: 0.012 }
  };
  var INFLATION = 0.025;

  var REGIMES = {
    expansion:   { label: 'Expansion / Growth',      tilt: 5,  note: 'Risk-on. Overweight cyclical & growth equity.' },
    slowdown:    { label: 'Slowdown / Late Cycle',   tilt: 0,  note: 'Neutral. Favor quality and defensives.' },
    contraction: { label: 'Contraction / Recession', tilt: -8, note: 'Risk-off. Raise bonds & cash; defensive sectors.' },
    recovery:    { label: 'Early Recovery',          tilt: 8,  note: 'Add risk. Cyclicals, small caps, credit.' }
  };

  // account-type → tax treatment bucket
  var TAX_TYPE = {
    'Individual': 'taxable', 'Joint': 'taxable', 'Trust': 'taxable',
    'Custodial': 'taxable', 'Designated Beneficiary': 'taxable',
    'Traditional IRA': 'deferred', '401(k)': 'deferred',
    'BrokerageLink 401(k)': 'deferred', 'SEP IRA': 'deferred',
    'Roth IRA': 'roth', 'Roth 401(k)': 'roth', 'BrokerageLink Roth IRA': 'roth',
    'HSA': 'hsa', '529 Plan': 'college'
  };
  function taxTypeOf(acct) { return TAX_TYPE[acct] || 'taxable'; }
  var TAX_LABEL = { taxable: 'Taxable', deferred: 'Tax-Deferred', roth: 'Roth (Tax-Free)', hsa: 'HSA', college: '529' };

  // 2025 federal ordinary brackets (single / MFJ) — top of bracket thresholds
  var BRACKETS = {
    single: [[0,0.10],[11925,0.12],[48475,0.22],[103350,0.24],[197300,0.32],[250525,0.35],[626350,0.37]],
    married:[[0,0.10],[23850,0.12],[96950,0.22],[206700,0.24],[394600,0.32],[501050,0.35],[751600,0.37]]
  };
  // IRS Uniform Lifetime Table (post-2022) — RMD divisors
  var RMD_FACTORS = { 73:26.5,74:25.5,75:24.6,76:23.7,77:22.9,78:22.0,79:21.1,80:20.2,81:19.4,82:18.5,83:17.7,84:16.8,85:16.0,86:15.2,87:14.4,88:13.7,89:12.9,90:12.2,91:11.5,92:10.8,93:10.1,94:9.5,95:8.9,96:8.4,97:7.8,98:7.3,99:6.8,100:6.4 };

  /* ---------- small helpers -------------------------------------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]; }); }
  function usd(v) {
    if (v == null || isNaN(v)) return '—';
    var a = Math.abs(v), s;
    if (a >= 1e6) s = '$' + (a/1e6).toFixed(2) + 'M';
    else if (a >= 1e3) s = '$' + (a/1e3).toFixed(1) + 'k';
    else s = '$' + a.toFixed(0);
    return (v < 0 ? '-' : '') + s;
  }
  function usd0(v){ if(v==null||isNaN(v))return '—'; return (v<0?'-':'')+'$'+Math.abs(Math.round(v)).toLocaleString(); }
  function pct(v, d) { return (v == null || isNaN(v)) ? '—' : v.toFixed(d == null ? 1 : d) + '%'; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function levelIdx(l) { return Math.max(0, LEVELS.indexOf(l)); }
  function minLevel(a, b) { return LEVELS[Math.min(levelIdx(a), levelIdx(b))]; }

  var _g_spare = null;
  function gauss() { // Box-Muller standard normal
    if (_g_spare != null) { var s = _g_spare; _g_spare = null; return s; }
    var u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    var mag = Math.sqrt(-2.0 * Math.log(u));
    _g_spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  }

  /* ---------- holdings normalization ----------------------------------- */
  var CASH_CLASSES = ['Cash', 'Money Market', 'CD', 'Bond Position'];
  function bucketOf(h) {
    var ac = (h.assetClass || '').toLowerCase();
    var sec = (h.sector || '').toLowerCase();
    if (ac === 'cash' || ac === 'money market' || ac === 'cd') return 'cash';
    if (ac.indexOf('bond') >= 0 || ac.indexOf('fixed') >= 0 || sec === 'fixed income') return 'bond';
    return 'stock'; // equity, ETF, REIT, leveraged, digital, commodity → risk sleeve
  }
  function mvOf(h) {
    var isCash = CASH_CLASSES.indexOf(h.assetClass) >= 0;
    return isCash ? (h.costBasis || 0) * (h.quantity || 0) : (h.currentPrice || 0) * (h.quantity || 0);
  }
  function getHoldings() {
    return (window._holdings || []).map(function (h) {
      var mv = mvOf(h);
      var cost = (h.costBasis || 0) * (h.quantity || 0);
      return {
        id: h.id, ticker: h.ticker || '—', name: h.companyName || h.ticker || '',
        account: h.accountType || 'Individual', taxType: taxTypeOf(h.accountType || 'Individual'),
        sector: h.sector || 'Other', assetClass: h.assetClass || 'Equity',
        bucket: bucketOf(h), qty: h.quantity || 0, price: h.currentPrice || 0,
        costPer: h.costBasis || 0, mv: mv, cost: cost, gain: mv - cost,
        gainPct: cost > 0 ? ((mv - cost) / cost) * 100 : 0, yieldPct: h.yieldPct || 0
      };
    });
  }
  function totalMV(hs) { return hs.reduce(function (s, h) { return s + h.mv; }, 0); }
  function allocOf(hs) {
    var t = totalMV(hs) || 1, o = { stock: 0, bond: 0, cash: 0 };
    hs.forEach(function (h) { o[h.bucket] += h.mv; });
    return { s: o.stock / t * 100, b: o.bond / t * 100, c: o.cash / t * 100, $s: o.stock, $b: o.bond, $c: o.cash, total: totalMV(hs) };
  }

  /* ---------- profile store -------------------------------------------- */
  function defaultProfile() {
    return {
      name: '', age: 45, retirementAge: 65, lifeExpectancy: 92,
      annualIncome: 150000, annualSavings: 25000, filingStatus: 'married',
      taxableIncome: 130000, stateTaxRate: 5, incomeStability: 'stable',
      currentlyRetired: false, annualSpendNeed: 80000,
      socialSecurityAnnual: 30000, pensionAnnual: 0,
      emergencyMonths: 6,
      goals: [{ name: 'Retirement', targetYear: (new Date().getFullYear() + 20), targetAmount: 2000000 }],
      liquidityNeeds: [],
      toleranceScore: null, toleranceLevel: null,
      capGainsBudget: 0, ytdRealizedGains: 0,
      _saved: false
    };
  }
  function loadProfile() {
    try { var s = localStorage.getItem(LS_PROFILE); if (s) return Object.assign(defaultProfile(), JSON.parse(s)); } catch (e) {}
    return defaultProfile();
  }
  function saveProfile(p) { p._saved = true; try { localStorage.setItem(LS_PROFILE, JSON.stringify(p)); } catch (e) {} ADV.profile = p; }
  ADV.profile = loadProfile();

  /* ---------- risk tolerance / capacity / governing -------------------- */
  var TOL_QUESTIONS = [
    { q: 'A well-diversified portfolio you own drops 20% in a month. You:', a: [
      ['Sell everything to stop the bleeding', 1], ['Sell some to reduce risk', 2],
      ['Do nothing and wait it out', 3], ['Buy more — it’s on sale', 4] ] },
    { q: 'Which portfolio would you rather hold for 10 years?', a: [
      ['+4%/yr, barely ever down', 1], ['+6%/yr, mild dips', 2],
      ['+8%/yr, occasional −20% years', 3], ['+10%/yr, possible −40% years', 4] ] },
    { q: 'How much investing experience do you have?', a: [
      ['Very little', 1], ['Some — funds/ETFs', 2], ['Comfortable with stocks', 3], ['Active / sophisticated', 4] ] },
    { q: 'My income over the next 10 years is:', a: [
      ['Uncertain / variable', 1], ['Somewhat stable', 2], ['Stable', 3], ['Very stable & growing', 4] ] },
    { q: 'If markets fell sharply, my sleep would be:', a: [
      ['Wrecked — I’d panic', 1], ['Uneasy', 2], ['Fine — expected', 3], ['Excited to deploy cash', 4] ] },
    { q: 'My primary goal for this money is:', a: [
      ['Preserve it', 1], ['Steady income & modest growth', 2], ['Long-term growth', 3], ['Maximum growth', 4] ] }
  ];
  function toleranceLevelFromScore(sc) {
    if (sc == null) return null;
    if (sc <= 11) return 'conservative';
    if (sc <= 16) return 'moderate';
    if (sc <= 21) return 'aggressive';
    return 'speculative';
  }
  function computeCapacity(p) {
    var yrs = p.currentlyRetired ? 0 : Math.max(0, (p.retirementAge || 65) - (p.age || 45));
    var horizonPts = yrs >= 20 ? 4 : yrs >= 10 ? 3 : yrs >= 5 ? 2 : 1;
    // withdrawal load: spending need vs investable assets (only meaningful near/in retirement)
    var pv = totalMV(getHoldings());
    var netNeed = Math.max(0, (p.annualSpendNeed || 0) - (p.socialSecurityAnnual || 0) - (p.pensionAnnual || 0));
    var loadPts = 4;
    if (yrs <= 10 && pv > 0) {
      var wr = netNeed / pv;
      loadPts = wr < 0.02 ? 4 : wr < 0.035 ? 3 : wr < 0.05 ? 2 : 1;
    }
    var stabPts = p.incomeStability === 'stable' ? 4 : p.incomeStability === 'variable' ? 2 : 3;
    var emergPts = (p.emergencyMonths || 0) >= 6 ? 4 : (p.emergencyMonths || 0) >= 3 ? 3 : 2;
    var raw = horizonPts * 0.45 + loadPts * 0.30 + stabPts * 0.15 + emergPts * 0.10; // 1..4
    var lvl = raw >= 3.5 ? 'aggressive' : raw >= 2.6 ? 'aggressive' : raw >= 1.8 ? 'moderate' : 'conservative';
    // never award "speculative" from capacity alone; cap at aggressive
    return { score: raw, level: lvl, yearsToRet: yrs, netNeed: netNeed, detail: { horizonPts: horizonPts, loadPts: loadPts, stabPts: stabPts, emergPts: emergPts } };
  }
  function governing(p) {
    var tol = p.toleranceLevel || 'moderate';
    var cap = computeCapacity(p);
    var gov = minLevel(tol, cap.level);
    var cappedByCapacity = levelIdx(cap.level) < levelIdx(tol);
    return { tolerance: tol, capacity: cap, governing: gov, cappedByCapacity: cappedByCapacity };
  }

  /* ---------- regime ---------------------------------------------------- */
  function currentRegimeKey() {
    var k = null;
    try { k = localStorage.getItem(LS_REGIME); } catch (e) {}
    if (k && REGIMES[k]) return k;
    // fall back to the site's regime signal if present (coarse mapping)
    var sc = window._regimeSignalScore;
    if (typeof sc === 'number') {
      if (sc >= 70) return 'contraction';
      if (sc >= 50) return 'slowdown';
      if (sc >= 30) return 'expansion';
      return 'recovery';
    }
    return 'slowdown';
  }
  function setRegime(k) { try { localStorage.setItem(LS_REGIME, k); } catch (e) {} render(); }
  ADV.setRegime = setRegime;

  /* ---------- target allocation (glide + regime) ----------------------- */
  function targetAllocation(p, opts) {
    opts = opts || {};
    var g = governing(p);
    var lvl = opts.level || g.governing;
    var base = BASE_ALLOC[lvl] || BASE_ALLOC.moderate;
    var age = opts.age != null ? opts.age : p.age;
    var retAge = opts.retirementAge != null ? opts.retirementAge : p.retirementAge;
    var yrs = (p.currentlyRetired && opts.age == null) ? 0 : (retAge - age);
    var floor = RET_EQUITY_FLOOR[lvl];
    var equity;
    if (yrs >= 20) equity = base.s;
    else if (yrs <= 0) equity = clamp(floor + yrs * 0.4, 20, floor);
    else equity = floor + (base.s - floor) * (yrs / 20);
    // near/in retirement: lift cash buffer
    var cash = base.c + (yrs <= 5 ? (5 - Math.max(yrs, 0)) * 1.5 : 0);
    cash = clamp(cash, base.c, 25);
    // regime tilt
    var reg = REGIMES[opts.regime || currentRegimeKey()];
    var tilt = opts.noRegime ? 0 : reg.tilt;
    equity = clamp(equity + tilt, 10, 100);
    var bonds = Math.max(0, 100 - equity - cash);
    return { s: equity, b: bonds, c: cash, level: lvl, yearsToRet: yrs, regime: reg, glideEquityNoTilt: clamp((yrs>=20?base.s:yrs<=0?clamp(floor+yrs*0.4,20,floor):floor+(base.s-floor)*(yrs/20)),10,100) };
  }

  /* ==================================================================== *
   *  UI SHELL
   * ==================================================================== */
  function injectCSS() {
    if ($('advCSS')) return;
    var css = '' +
      '.adv-nav{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0 16px;}' +
      '.adv-nav button{border:1px solid var(--border);background:#fff;color:var(--navy);padding:7px 13px;border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;}' +
      '.adv-nav button.active{background:var(--navy);color:#fff;border-color:var(--navy);}' +
      '.adv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;}' +
      '.adv-metric{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px 14px;}' +
      '.adv-metric .lbl{font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:var(--text-sec);font-weight:700;}' +
      '.adv-metric .val{font-size:22px;font-weight:800;color:var(--navy);line-height:1.15;margin-top:3px;}' +
      '.adv-metric .sub{font-size:11px;color:var(--text-sec);margin-top:2px;}' +
      '.adv-pill{display:inline-block;padding:2px 9px;border-radius:12px;font-size:11px;font-weight:700;color:#fff;}' +
      '.adv-bar{height:16px;border-radius:4px;overflow:hidden;display:flex;background:var(--panel);font-size:9px;color:#fff;font-weight:700;line-height:16px;}' +
      '.adv-bar span{display:flex;align-items:center;justify-content:center;white-space:nowrap;overflow:hidden;}' +
      '.adv-tbl{width:100%;border-collapse:collapse;font-size:12px;}' +
      '.adv-tbl th{background:var(--navy);color:#fff;text-align:left;padding:7px 9px;font-size:10px;letter-spacing:.03em;text-transform:uppercase;position:sticky;top:0;}' +
      '.adv-tbl td{padding:7px 9px;border-bottom:1px solid var(--border);vertical-align:top;}' +
      '.adv-tbl tr:hover td{background:var(--panel);}' +
      '.adv-act{font-weight:800;padding:2px 8px;border-radius:4px;font-size:11px;color:#fff;}' +
      '.adv-note{font-size:11px;color:var(--text-sec);line-height:1.5;}' +
      '.adv-disc{background:#FFF7E6;border:1px solid #F0C36D;border-radius:6px;padding:9px 12px;font-size:11px;color:#7A5B00;line-height:1.5;margin-bottom:14px;}' +
      '.adv-input{width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:4px;font-size:13px;box-sizing:border-box;}' +
      '.adv-field{margin-bottom:10px;}' +
      '.adv-field label{display:block;font-size:11px;font-weight:600;color:var(--navy);margin-bottom:3px;}' +
      '.adv-le-btn{border:1px solid var(--border);background:#fff;border-radius:8px;padding:12px;text-align:left;cursor:pointer;font-size:12px;}' +
      '.adv-le-btn:hover{border-color:var(--navy);box-shadow:0 2px 6px rgba(0,0,0,.08);}' +
      '.adv-le-btn .t{font-weight:800;color:var(--navy);font-size:13px;display:block;margin-bottom:3px;}';
    var st = document.createElement('style'); st.id = 'advCSS'; st.textContent = css; document.head.appendChild(st);
  }

  var SECTIONS = [
    ['overview', '📋 Overview'], ['reco', '🎯 Recommendations'], ['glide', '📉 Glide Path'],
    ['cash', '💵 Cash & Liquidity'], ['retire', '🎲 Retirement (Monte Carlo)'],
    ['decum', '🏖️ Decumulation'], ['tax', '🧾 Tax Center'], ['life', '🔄 Life Events']
  ];

  function destroyCharts() { Object.keys(ADV._charts).forEach(function (k) { try { ADV._charts[k].destroy(); } catch (e) {} delete ADV._charts[k]; }); }

  window.advisorOnShow = function () { injectCSS(); render(); };
  ADV.go = function (sec) { ADV.section = sec; render(); };

  function render() {
    var root = $('advisorRoot'); if (!root) return;
    destroyCharts();
    var p = ADV.profile;
    var nav = '<div class="adv-nav">' + SECTIONS.map(function (s) {
      return '<button class="' + (ADV.section === s[0] ? 'active' : '') + '" onclick="ADV.go(\'' + s[0] + '\')">' + s[1] + '</button>';
    }).join('') + '</div>';

    var disc = '<div class="adv-disc"><strong>⚠️ Advisor Mode — model-generated recommendations.</strong> These are directive, rules-based outputs for educational purposes, generated from your saved profile, holdings, and the current market regime. They are <strong>not</strong> personalized investment, tax, or legal advice, and nothing here executes a trade. Verify with a licensed fiduciary before acting.</div>';

    var body;
    if (!p._saved && ADV.section === 'overview') body = renderProfilePrompt();
    else {
      switch (ADV.section) {
        case 'overview': body = renderOverview(); break;
        case 'reco':     body = renderReco(); break;
        case 'glide':    body = renderGlide(); break;
        case 'cash':     body = renderCash(); break;
        case 'retire':   body = renderRetire(); break;
        case 'decum':    body = renderDecum(); break;
        case 'tax':      body = renderTax(); break;
        case 'life':     body = renderLife(); break;
        default: body = renderOverview();
      }
    }
    root.innerHTML = disc + nav + body;
    // post-render hooks (charts etc.)
    if (ADV._afterRender) { var f = ADV._afterRender; ADV._afterRender = null; setTimeout(f, 30); }
  }
  ADV.render = render;

  function card(title, inner, sources) {
    return '<div class="card" style="margin-bottom:16px;"><div class="card-title">' + title + '</div><div class="card-body">' + inner + '</div>' +
      (sources ? '<div class="card-sources">' + sources + '</div>' : '') + '</div>';
  }
  function allocBar(a) {
    function seg(w, col, lab) { return w > 0.5 ? '<span style="width:' + w + '%;background:' + col + ';">' + (w >= 8 ? lab + ' ' + Math.round(w) + '%' : '') + '</span>' : ''; }
    return '<div class="adv-bar">' + seg(a.s, '#2E7D52', 'Stocks') + seg(a.b, '#003C71', 'Bonds') + seg(a.c, '#8B6914', 'Cash') + '</div>';
  }

  /* ==================================================================== *
   *  PROFILE
   * ==================================================================== */
  function renderProfilePrompt() {
    return card('Set Up Your Client Profile',
      '<p class="adv-note" style="margin-bottom:12px;">The advisor engine needs to know your situation before it can tell you what to buy or sell. This is the difference between a generic risk label and real financial planning — it captures your age, when you’ll need the money, income, tax bracket, goals, and risk tolerance, then derives your <strong>risk capacity</strong> and the <strong>governing risk level</strong> that drives every recommendation.</p>' +
      '<button class="btn" onclick="ADV.editProfile()">Start Profile Questionnaire</button>');
  }

  ADV.editProfile = function () {
    var p = ADV.profile;
    var fs = function (v, val, lab) { return '<option value="' + v + '"' + (val === v ? ' selected' : '') + '>' + lab + '</option>'; };
    var goalsRows = (p.goals || []).map(function (g, i) {
      return '<div class="form-row" data-goal="' + i + '" style="gap:6px;margin-bottom:6px;">' +
        '<input class="adv-input" style="flex:2;" value="' + esc(g.name) + '" data-gf="name" placeholder="Goal">' +
        '<input class="adv-input" style="flex:1;" type="number" value="' + g.targetYear + '" data-gf="targetYear" placeholder="Year">' +
        '<input class="adv-input" style="flex:1.4;" type="number" value="' + g.targetAmount + '" data-gf="targetAmount" placeholder="$ target">' +
        '<button class="btn-outline btn-sm" onclick="ADV._delGoal(' + i + ')">✕</button></div>';
    }).join('');
    var html =
      '<div id="advProfileModal" class="modal-overlay" onclick="if(event.target===this)this.remove()">' +
      '<div class="modal-box" style="max-width:640px;max-height:88vh;overflow:auto;padding:22px;">' +
      '<h3 style="margin:0 0 4px;color:var(--navy);">Client Profile</h3>' +
      '<p class="adv-note" style="margin:0 0 14px;">Everything the recommendation engine uses. Saved locally to your browser.</p>' +
      '<div class="adv-grid" style="grid-template-columns:1fr 1fr;">' +
        fld('Name (optional)', '<input class="adv-input" id="pf_name" value="' + esc(p.name) + '">') +
        fld('Current age', '<input class="adv-input" id="pf_age" type="number" value="' + p.age + '">') +
        fld('Target retirement age', '<input class="adv-input" id="pf_retAge" type="number" value="' + p.retirementAge + '">') +
        fld('Life-expectancy assumption', '<input class="adv-input" id="pf_life" type="number" value="' + p.lifeExpectancy + '">') +
        fld('Currently retired?', '<select class="adv-input" id="pf_retired">' + fs('no', p.currentlyRetired ? 'yes':'no', 'No') + fs('yes', p.currentlyRetired ? 'yes':'no', 'Yes') + '</select>') +
        fld('Income stability', '<select class="adv-input" id="pf_stab">' + fs('stable', p.incomeStability, 'Stable') + fs('somewhat', p.incomeStability, 'Somewhat stable') + fs('variable', p.incomeStability, 'Variable') + '</select>') +
        fld('Annual income ($)', '<input class="adv-input" id="pf_income" type="number" value="' + p.annualIncome + '">') +
        fld('Annual savings ($/yr)', '<input class="adv-input" id="pf_savings" type="number" value="' + p.annualSavings + '">') +
        fld('Filing status', '<select class="adv-input" id="pf_filing">' + fs('single', p.filingStatus, 'Single') + fs('married', p.filingStatus, 'Married filing jointly') + '</select>') +
        fld('Taxable income ($)', '<input class="adv-input" id="pf_taxinc" type="number" value="' + p.taxableIncome + '">') +
        fld('State tax rate (%)', '<input class="adv-input" id="pf_state" type="number" step="0.1" value="' + p.stateTaxRate + '">') +
        fld('Emergency reserve (months)', '<input class="adv-input" id="pf_emerg" type="number" value="' + p.emergencyMonths + '">') +
        fld('Annual spending need in retirement ($)', '<input class="adv-input" id="pf_spend" type="number" value="' + p.annualSpendNeed + '">') +
        fld('Social Security ($/yr)', '<input class="adv-input" id="pf_ss" type="number" value="' + p.socialSecurityAnnual + '">') +
        fld('Pension ($/yr)', '<input class="adv-input" id="pf_pension" type="number" value="' + p.pensionAnnual + '">') +
      '</div>' +
      '<div style="margin-top:10px;"><label style="font-size:11px;font-weight:700;color:var(--navy);">Goals</label>' + goalsRows +
        '<button class="btn-outline btn-sm" onclick="ADV._addGoal()">+ Add goal</button></div>' +
      '<div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border);">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">' +
        '<div><strong style="color:var(--navy);">Risk tolerance</strong> <span class="adv-note">' +
          (p.toleranceLevel ? '— current: <strong>' + LEVEL_META[p.toleranceLevel].label + '</strong> (score ' + p.toleranceScore + '/24)' : '— not yet assessed') + '</span></div>' +
        '<button class="btn-outline btn-sm" onclick="ADV.toleranceQuiz()">' + (p.toleranceLevel ? 'Retake' : 'Take') + ' 6-question quiz</button></div></div>' +
      '<div class="modal-actions" style="margin-top:18px;">' +
        '<button class="btn" onclick="ADV._saveProfileForm()">Save Profile</button>' +
        '<button class="btn-outline" onclick="document.getElementById(\'advProfileModal\').remove()">Cancel</button></div>' +
      '</div></div>';
    var el = document.createElement('div'); el.innerHTML = html; document.body.appendChild(el.firstChild);
    function fld(l, i) { return '<div class="adv-field"><label>' + l + '</label>' + i + '</div>'; }
  };
  function fld(l, i) { return '<div class="adv-field"><label>' + l + '</label>' + i + '</div>'; }

  ADV._addGoal = function () { ADV.profile.goals = ADV.profile.goals || []; ADV.profile.goals.push({ name: '', targetYear: new Date().getFullYear() + 10, targetAmount: 100000 }); var m = $('advProfileModal'); if (m) m.remove(); ADV.editProfile(); };
  ADV._delGoal = function (i) { ADV.profile.goals.splice(i, 1); var m = $('advProfileModal'); if (m) m.remove(); ADV.editProfile(); };
  ADV._saveProfileForm = function () {
    var p = ADV.profile;
    p.name = $('pf_name').value;
    p.age = +$('pf_age').value || 45;
    p.retirementAge = +$('pf_retAge').value || 65;
    p.lifeExpectancy = +$('pf_life').value || 92;
    p.currentlyRetired = $('pf_retired').value === 'yes';
    p.incomeStability = $('pf_stab').value;
    p.annualIncome = +$('pf_income').value || 0;
    p.annualSavings = +$('pf_savings').value || 0;
    p.filingStatus = $('pf_filing').value;
    p.taxableIncome = +$('pf_taxinc').value || 0;
    p.stateTaxRate = +$('pf_state').value || 0;
    p.emergencyMonths = +$('pf_emerg').value || 0;
    p.annualSpendNeed = +$('pf_spend').value || 0;
    p.socialSecurityAnnual = +$('pf_ss').value || 0;
    p.pensionAnnual = +$('pf_pension').value || 0;
    // goals
    var rows = document.querySelectorAll('#advProfileModal [data-goal]'); var goals = [];
    rows.forEach(function (r) {
      var g = {};
      r.querySelectorAll('[data-gf]').forEach(function (inp) { var f = inp.getAttribute('data-gf'); g[f] = f === 'name' ? inp.value : +inp.value; });
      if (g.name) goals.push(g);
    });
    p.goals = goals;
    saveProfile(p);
    var m = $('advProfileModal'); if (m) m.remove();
    render();
  };

  ADV.toleranceQuiz = function () {
    var html = '<div id="advTolModal" class="modal-overlay" onclick="if(event.target===this)this.remove()">' +
      '<div class="modal-box" style="max-width:560px;max-height:88vh;overflow:auto;padding:22px;">' +
      '<h3 style="margin:0 0 4px;color:var(--navy);">Risk Tolerance Questionnaire</h3>' +
      '<p class="adv-note" style="margin:0 0 14px;">Measures your <em>willingness</em> to take risk. Your <em>ability</em> (capacity) is computed separately from your profile — the lower of the two governs.</p>' +
      TOL_QUESTIONS.map(function (q, qi) {
        return '<div style="margin-bottom:14px;"><div style="font-size:13px;font-weight:600;color:var(--navy);margin-bottom:6px;">' + (qi + 1) + '. ' + q.q + '</div>' +
          q.a.map(function (a) { return '<label style="display:block;font-size:12px;margin:3px 0;cursor:pointer;"><input type="radio" name="tq' + qi + '" value="' + a[1] + '"> ' + a[0] + '</label>'; }).join('') + '</div>';
      }).join('') +
      '<div class="modal-actions" style="margin-top:8px;"><button class="btn" onclick="ADV._scoreTol()">Score</button>' +
      '<button class="btn-outline" onclick="document.getElementById(\'advTolModal\').remove()">Cancel</button></div></div></div>';
    var el = document.createElement('div'); el.innerHTML = html; document.body.appendChild(el.firstChild);
  };
  ADV._scoreTol = function () {
    var sc = 0, answered = 0;
    for (var i = 0; i < TOL_QUESTIONS.length; i++) {
      var sel = document.querySelector('input[name="tq' + i + '"]:checked');
      if (sel) { sc += +sel.value; answered++; }
    }
    if (answered < TOL_QUESTIONS.length) { alert('Please answer all ' + TOL_QUESTIONS.length + ' questions.'); return; }
    ADV.profile.toleranceScore = sc;
    ADV.profile.toleranceLevel = toleranceLevelFromScore(sc);
    var m = $('advTolModal'); if (m) m.remove();
    // reflect into legacy risk profile so drift/rebalance stay in sync
    try { window._riskProfile = ADV.profile.toleranceLevel; localStorage.setItem('perry_risk_profile', ADV.profile.toleranceLevel); } catch (e) {}
    var pm = $('advProfileModal'); if (pm) { pm.remove(); ADV.editProfile(); } else render();
  };

  /* ==================================================================== *
   *  OVERVIEW
   * ==================================================================== */
  function govPill(lvl) { var m = LEVEL_META[lvl]; return '<span class="adv-pill" style="background:' + m.color + ';">' + m.emoji + ' ' + m.label + '</span>'; }

  function renderOverview() {
    var p = ADV.profile, g = governing(p), hs = getHoldings(), cur = allocOf(hs), tgt = targetAllocation(p);
    var regKey = currentRegimeKey(), reg = REGIMES[regKey];
    var regSel = '<select class="adv-input" style="width:auto;display:inline-block;font-size:12px;padding:4px 8px;" onchange="ADV.setRegime(this.value)">' +
      Object.keys(REGIMES).map(function (k) { return '<option value="' + k + '"' + (k === regKey ? ' selected' : '') + '>' + REGIMES[k].label + '</option>'; }).join('') + '</select>';

    var profSummary = card('Client Profile <button class="btn-outline btn-sm" style="float:right;" onclick="ADV.editProfile()">Edit</button>',
      '<div class="adv-grid">' +
        metric('Age → Retirement', p.age + ' → ' + p.retirementAge, g.capacity.yearsToRet + ' yrs to retirement' + (p.currentlyRetired ? ' (retired)' : '')) +
        metric('Annual Income', usd(p.annualIncome), 'Saving ' + usd(p.annualSavings) + '/yr') +
        metric('Retirement Spend Need', usd(p.annualSpendNeed), 'Net of SS/pension: ' + usd(g.capacity.netNeed) + '/yr') +
        metric('Portfolio Value', usd(cur.total), hs.length + ' positions') +
      '</div>');

    var riskCard = card('Governing Risk Level — Tolerance vs. Capacity',
      '<div class="adv-grid" style="grid-template-columns:1fr 1fr 1fr;">' +
        '<div class="adv-metric"><div class="lbl">Risk Tolerance (willingness)</div><div class="val" style="font-size:16px;">' + (p.toleranceLevel ? govPill(p.toleranceLevel) : '<span class="adv-note">Not assessed — <a href="javascript:ADV.toleranceQuiz()">take quiz</a></span>') + '</div><div class="sub">' + (p.toleranceScore != null ? 'Quiz score ' + p.toleranceScore + '/24' : '') + '</div></div>' +
        '<div class="adv-metric"><div class="lbl">Risk Capacity (ability)</div><div class="val" style="font-size:16px;">' + govPill(g.capacity.level) + '</div><div class="sub">Horizon, withdrawal load, income stability</div></div>' +
        '<div class="adv-metric" style="border:2px solid ' + LEVEL_META[g.governing].color + ';"><div class="lbl">Governing Level (drives everything)</div><div class="val" style="font-size:16px;">' + govPill(g.governing) + '</div><div class="sub">' + (g.cappedByCapacity ? '⚠️ Capped by capacity — your ability to take risk is lower than your appetite' : 'Tolerance and capacity aligned') + '</div></div>' +
      '</div>' +
      (g.cappedByCapacity ? '<p class="adv-note" style="margin-top:10px;">This is exactly what a fiduciary does: even though you’re comfortable with more risk, your time horizon and cash needs cap how much you <em>should</em> take. The engine uses <strong>' + LEVEL_META[g.governing].label + '</strong>.</p>' : ''),
      'Governing level = min(tolerance, capacity). Capacity blends years-to-retirement (45%), withdrawal load (30%), income stability (15%), emergency reserve (10%).');

    var allocCard = card('Current vs. Target Allocation &nbsp;<span class="adv-note">Regime: ' + regSel + '</span>',
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;">' +
        '<div><div class="adv-note" style="font-weight:700;margin-bottom:4px;">Current</div>' + allocBar(cur) +
          '<div class="adv-note" style="margin-top:4px;">Stocks ' + pct(cur.s) + ' · Bonds ' + pct(cur.b) + ' · Cash ' + pct(cur.c) + '</div></div>' +
        '<div><div class="adv-note" style="font-weight:700;margin-bottom:4px;">Target (' + LEVEL_META[tgt.level].label + ', glide + regime)</div>' + allocBar(tgt) +
          '<div class="adv-note" style="margin-top:4px;">Stocks ' + pct(tgt.s) + ' · Bonds ' + pct(tgt.b) + ' · Cash ' + pct(tgt.c) + '</div></div>' +
      '</div>' +
      '<p class="adv-note" style="margin-top:12px;"><strong>Regime overlay:</strong> ' + reg.note + ' (equity tilt ' + (reg.tilt >= 0 ? '+' : '') + reg.tilt + ' pts)</p>' +
      '<div style="margin-top:12px;"><button class="btn" onclick="ADV.go(\'reco\')">See what to buy / sell →</button></div>');

    return profSummary + riskCard + allocCard;
  }
  function metric(l, v, s) { return '<div class="adv-metric"><div class="lbl">' + l + '</div><div class="val">' + v + '</div><div class="sub">' + (s || '') + '</div></div>'; }

  /* ==================================================================== *
   *  RECOMMENDATION ENGINE
   * ==================================================================== */
  function buildRecommendations(p) {
    var hs = getHoldings(); if (!hs.length) return { recs: [], hs: hs };
    var cur = allocOf(hs), tgt = targetAllocation(p), total = cur.total;
    var recs = [];

    // 1) asset-class drift → dollar moves
    var driftS = (tgt.s - cur.s) / 100 * total;  // + means buy stocks
    var driftB = (tgt.b - cur.b) / 100 * total;
    var driftC = (tgt.c - cur.c) / 100 * total;
    var band = 0.03 * total; // 3% tolerance band

    // 2) concentration flags (single position > 10% of portfolio)
    hs.forEach(function (h) {
      if (h.mv > 0.10 * total && h.bucket === 'stock') {
        recs.push(makeRec('TRIM', h, Math.min(h.mv - 0.10 * total, h.mv * 0.5),
          'Concentration: ' + h.ticker + ' is ' + pct(h.mv / total * 100) + ' of the portfolio (>10% cap). Trim to reduce single-name risk.', p, 3));
      }
    });

    // 3) equity sleeve over/under
    if (driftS < -band) {
      // overweight equities → sell; prefer tax-deferred, then loss lots in taxable, then biggest winners last
      var sellAmt = -driftS;
      var candidates = hs.filter(function (h) { return h.bucket === 'stock'; })
        .sort(function (a, b) { return sellPriority(a) - sellPriority(b); });
      allocateTrades(candidates, sellAmt, 'TRIM', 'Equities are ' + pct(cur.s) + ' vs. ' + pct(tgt.s) + ' target (' + LEVEL_META[tgt.level].label + ', regime ' + tgt.regime.label + '). Reduce equity risk.', p, recs, total);
    } else if (driftS > band) {
      recs.push({ action: 'BUY', ticker: 'Equity', name: 'Add to equity sleeve', account: bestBuyAccount('stock', hs), amount: driftS,
        rationale: 'Equities are ' + pct(cur.s) + ' vs. ' + pct(tgt.s) + ' target. Add broad, tax-efficient equity (e.g., VTI/VOO). Regime favors: ' + tgt.regime.note, sev: 2, bucket: 'stock' });
    }
    // 4) bond sleeve
    if (driftB > band) {
      recs.push({ action: 'BUY', ticker: 'Bonds', name: 'Add to fixed income', account: bestBuyAccount('bond', hs), amount: driftB,
        rationale: 'Bonds are ' + pct(cur.b) + ' vs. ' + pct(tgt.b) + ' target. Hold bond funds in tax-deferred accounts (asset location). Near-retirement glide raises fixed income.', sev: 2, bucket: 'bond' });
    } else if (driftB < -band) {
      recs.push({ action: 'TRIM', ticker: 'Bonds', name: 'Reduce fixed income', account: preferAccount('bond', hs), amount: -driftB,
        rationale: 'Bonds are ' + pct(cur.b) + ' vs. ' + pct(tgt.b) + ' target. Trim in tax-deferred to avoid taxable events.', sev: 1, bucket: 'bond' });
    }
    // 5) cash buffer
    if (driftC > band) {
      recs.push({ action: 'RAISE CASH', ticker: 'Cash', name: 'Build cash buffer', account: 'Taxable / MMF', amount: driftC,
        rationale: 'Cash is ' + pct(cur.c) + ' vs. ' + pct(tgt.c) + ' target. Near/in retirement the glide lifts the cash buffer to fund ~1–2 yrs of spending (sequence-of-returns protection).', sev: 2, bucket: 'cash' });
    }

    // sort by severity then $ size
    recs.sort(function (a, b) { return (b.sev - a.sev) || (b.amount - a.amount); });
    return { recs: recs, hs: hs, cur: cur, tgt: tgt, total: total };
  }
  function sellPriority(h) {
    // lower = sell first. Prefer tax-deferred/roth (no cap gains), then taxable losses, winners last.
    if (h.taxType === 'deferred' || h.taxType === 'roth' || h.taxType === 'hsa') return 0;
    if (h.gain < 0) return 1;                 // harvest losses
    return 2 + h.gainPct / 1000;              // winners last, biggest gains latest
  }
  function makeRec(action, h, amt, rationale, p, sev) {
    return { action: action, ticker: h.ticker, name: h.name, account: h.account, amount: amt, rationale: taxTag(h) + rationale, sev: sev || 2, bucket: h.bucket, gain: h.gain };
  }
  function taxTag(h) {
    if (h.taxType === 'taxable' && h.gain < 0) return '📉 Harvest loss (' + usd(h.gain) + '). ';
    if (h.taxType === 'taxable' && h.gain > 0) return '⚠️ Taxable gain (' + usd(h.gain) + ') if sold. ';
    if (h.taxType === 'deferred' || h.taxType === 'roth') return '✅ No tax on sale (' + TAX_LABEL[h.taxType] + '). ';
    return '';
  }
  function allocateTrades(cands, amount, action, baseRationale, p, recs, total) {
    var remaining = amount;
    for (var i = 0; i < cands.length && remaining > 1; i++) {
      var h = cands[i]; var take = Math.min(remaining, h.mv);
      if (take < Math.max(200, 0.002 * total)) continue;
      recs.push(makeRec(action, h, take, baseRationale, p, 3));
      remaining -= take;
    }
  }
  function bestBuyAccount(bucket, hs) {
    // asset location: bonds/REIT → tax-deferred; high-growth → Roth; tax-efficient equity → taxable
    var have = {}; hs.forEach(function (h) { have[h.taxType] = (have[h.taxType] || 0); });
    if (bucket === 'bond') return firstAccountOfType(hs, 'deferred') || 'Traditional IRA / 401(k)';
    if (bucket === 'stock') return firstAccountOfType(hs, 'roth') || firstAccountOfType(hs, 'taxable') || 'Roth IRA / Taxable';
    return 'Taxable / MMF';
  }
  function preferAccount(bucket, hs) { return firstAccountOfType(hs, 'deferred') || 'Tax-deferred'; }
  function firstAccountOfType(hs, tt) { var f = hs.find(function (h) { return h.taxType === tt; }); return f ? f.account : null; }

  var ACT_COLOR = { 'SELL': '#C0392B', 'TRIM': '#C0392B', 'BUY': '#2E7D52', 'ADD': '#2E7D52', 'RAISE CASH': '#8B6914', 'HOLD': '#7A7A7A' };

  function renderReco() {
    var p = ADV.profile;
    if (!p._saved) return card('Recommendations', '<p class="adv-note">Set up your <a href="javascript:ADV.editProfile()">Client Profile</a> first — recommendations depend on your governing risk level.</p>');
    var out = buildRecommendations(p);
    if (!out.hs.length) return card('Recommendations', '<p class="adv-note">No holdings loaded. Add holdings on the Holdings tab.</p>');
    var g = governing(p);
    var head = '<p class="adv-note" style="margin-bottom:10px;">Governing level <strong>' + LEVEL_META[g.governing].label + '</strong> · Regime <strong>' + out.tgt.regime.label + '</strong> · Portfolio ' + usd(out.total) + '. Each action is a function of your profile × glide path × regime × tax. Nothing executes — export to your custodian.</p>';
    if (!out.recs.length) return card('🎯 Recommended Actions', head + '<p class="adv-note">✅ Portfolio is within tolerance bands of target. No trades recommended right now.</p>');
    var rows = out.recs.map(function (r) {
      return '<tr><td><span class="adv-act" style="background:' + (ACT_COLOR[r.action] || '#555') + ';">' + r.action + '</span></td>' +
        '<td><strong>' + esc(r.ticker) + '</strong><div class="adv-note">' + esc(r.name || '') + '</div></td>' +
        '<td>' + usd(r.amount) + '</td>' +
        '<td>' + esc(r.account) + '</td>' +
        '<td class="adv-note">' + r.rationale + '</td></tr>';
    }).join('');
    var tbl = '<div class="table-wrap" style="max-height:520px;overflow:auto;"><table class="adv-tbl"><thead><tr><th>Action</th><th>Position</th><th>Amount</th><th>Account (asset location)</th><th>Why</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    var totBuy = out.recs.filter(function(r){return r.action==='BUY';}).reduce(function(s,r){return s+r.amount;},0);
    var totSell = out.recs.filter(function(r){return r.action==='TRIM'||r.action==='SELL';}).reduce(function(s,r){return s+r.amount;},0);
    var summary = '<div class="adv-grid" style="margin-top:12px;">' + metric('Sell / Trim', usd(totSell), '') + metric('Buy / Add', usd(totBuy), '') + metric('Net', usd(totBuy - totSell), 'Positive = deploy cash') + '</div>';
    return card('🎯 Recommended Actions', head + tbl + summary,
      'Layered pipeline: governing risk → glide-adjusted target → regime tilt → asset-class drift vs. 3% bands → concentration caps (>10%) → tax-aware account & lot selection. Sells prioritize tax-deferred/Roth and loss lots; buys follow asset-location rules.');
  }

  /* ==================================================================== *
   *  GLIDE PATH
   * ==================================================================== */
  function renderGlide() {
    var p = ADV.profile;
    if (!p._saved) return card('Glide Path', '<p class="adv-note">Set up your <a href="javascript:ADV.editProfile()">Client Profile</a> first.</p>');
    var g = governing(p), hs = getHoldings(), cur = allocOf(hs);
    var tgtNow = targetAllocation(p);
    var ageNow = p.age, retAge = p.retirementAge, life = p.lifeExpectancy;
    var ages = [], eq = [], eqTilt = [];
    for (var a = Math.min(ageNow, 25); a <= life; a++) {
      var t = targetAllocation(p, { age: a, retirementAge: retAge, noRegime: true });
      ages.push(a); eq.push(+t.s.toFixed(1));
      eqTilt.push(a === ageNow ? +tgtNow.s.toFixed(1) : null);
    }
    ADV._afterRender = function () {
      var ctx = $('advGlideChart'); if (!ctx || !window.Chart) return;
      ADV._charts.glide = new Chart(ctx, {
        type: 'line',
        data: { labels: ages, datasets: [
          { label: 'Target equity % (glide)', data: eq, borderColor: '#2E7D52', backgroundColor: 'rgba(46,125,82,.08)', fill: true, tension: .25, pointRadius: 0, borderWidth: 2 },
          { label: 'Your equity today', data: ages.map(function (a) { return a === ageNow ? +cur.s.toFixed(1) : null; }), borderColor: '#C0392B', backgroundColor: '#C0392B', pointRadius: 5, showLine: false },
          { label: 'Target today (w/ regime)', data: eqTilt, borderColor: '#003C71', backgroundColor: '#003C71', pointRadius: 5, showLine: false }
        ] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { font: { size: 11 } } },
          annotation: {} }, scales: { x: { title: { display: true, text: 'Age' } }, y: { title: { display: true, text: 'Equity %' }, min: 0, max: 100 } } }
      });
    };
    var gap = cur.s - tgtNow.s;
    var status = Math.abs(gap) <= 5
      ? '<span style="color:var(--success);font-weight:700;">On track</span> — within 5 pts of your age-appropriate equity target.'
      : (gap > 0
        ? '<span style="color:var(--danger);font-weight:700;">' + pct(gap) + ' too much equity</span> for your point on the glide path. De-risk toward ' + pct(tgtNow.s) + '.'
        : '<span style="color:#8B6914;font-weight:700;">' + pct(-gap) + ' under target equity</span> — you could add growth given your horizon.');
    var chart = card('Equity Glide Path — De-Risking Toward Retirement',
      '<div style="height:300px;position:relative;"><canvas id="advGlideChart"></canvas></div>' +
      '<p class="adv-note" style="margin-top:10px;"><strong>Where you are:</strong> ' + status + '</p>' +
      '<div style="margin-top:8px;"><button class="btn btn-sm" onclick="ADV.go(\'reco\')">Generate de-risking trades →</button></div>',
      'Glide target starts at your strategic equity (' + LEVEL_META[tgtNow.level].label + ') and declines linearly over the final 20 years to a retirement floor (' + RET_EQUITY_FLOOR[tgtNow.level] + '% equity), then eases lower in retirement. Regime overlay applies only to "today" markers.');
    var band = card('De-Risking Triggers',
      '<div class="adv-grid">' +
        metric('Current equity', pct(cur.s), 'of ' + usd(cur.total)) +
        metric('Age-appropriate target', pct(tgtNow.glideEquityNoTilt), 'before regime tilt') +
        metric('Gap', pct(gap), Math.abs(gap) > 5 ? 'Outside 5-pt band → rebalance' : 'Within band') +
        metric('Years to retirement', g.capacity.yearsToRet, p.currentlyRetired ? 'Retired' : '') +
      '</div>');
    return chart + band;
  }

  /* ==================================================================== *
   *  CASH & LIQUIDITY
   * ==================================================================== */
  function renderCash() {
    var p = ADV.profile, hs = getHoldings(), cur = allocOf(hs);
    var monthlySpend = (p.annualSpendNeed || p.annualIncome * 0.6) / 12;
    var emergencyReserve = monthlySpend * (p.emergencyMonths || 6);
    var needs = p.liquidityNeeds || [];
    var near = needs.filter(function (n) { return (n.monthsAway || 0) <= 12; });
    var nearTotal = near.reduce(function (s, n) { return s + (+n.amount || 0); }, 0);
    var reserveTarget = emergencyReserve + nearTotal;
    var cashNow = cur.$c;
    var shortfall = reserveTarget - cashNow;

    var needRows = needs.length ? needs.map(function (n, i) {
      return '<tr><td>' + esc(n.label || 'Need') + '</td><td>' + usd(n.amount) + '</td><td>' + (n.monthsAway || 0) + ' mo</td>' +
        '<td>' + ((n.monthsAway || 0) <= 12 ? '<span style="color:var(--danger);">In reserve</span>' : '<span class="adv-note">Long-dated</span>') + '</td>' +
        '<td><button class="btn-outline btn-sm" onclick="ADV._delNeed(' + i + ')">✕</button></td></tr>';
    }).join('') : '<tr><td colspan="5" class="adv-note">No upcoming needs entered.</td></tr>';

    var addForm = '<div class="form-row" style="gap:6px;margin-top:8px;align-items:flex-end;">' +
      '<div class="adv-field" style="flex:2;margin:0;"><label>Description</label><input class="adv-input" id="ln_label" placeholder="e.g., Kitchen remodel"></div>' +
      '<div class="adv-field" style="flex:1;margin:0;"><label>Amount ($)</label><input class="adv-input" id="ln_amt" type="number" placeholder="40000"></div>' +
      '<div class="adv-field" style="flex:1;margin:0;"><label>Months away</label><input class="adv-input" id="ln_mo" type="number" placeholder="8"></div>' +
      '<button class="btn btn-sm" onclick="ADV._addNeed()">Add</button></div>';

    var statusBox;
    if (shortfall > 0) {
      // propose raising cash: taxable loss lots first, then overweight winners in tax-advantaged
      var raise = hs.filter(function (h) { return h.bucket === 'stock'; }).sort(function (a, b) { return sellPriority(a) - sellPriority(b); });
      var plan = [], rem = shortfall;
      for (var i = 0; i < raise.length && rem > 1; i++) { var h = raise[i]; var take = Math.min(rem, h.mv); if (take < 200) continue; plan.push({ h: h, take: take }); rem -= take; }
      var planRows = plan.map(function (x) { return '<tr><td><strong>' + esc(x.h.ticker) + '</strong></td><td>' + usd(x.take) + '</td><td>' + esc(x.h.account) + '</td><td class="adv-note">' + taxTag(x.h) + '</td></tr>'; }).join('');
      statusBox = '<div class="adv-disc" style="background:#FDEDEC;border-color:#E6A9A0;color:#922B21;"><strong>Liquidity shortfall of ' + usd(shortfall) + '.</strong> Your cash (' + usd(cashNow) + ') is below the recommended reserve (' + usd(reserveTarget) + '). Suggested tax-efficient raise (loss lots & tax-advantaged first):</div>' +
        '<table class="adv-tbl"><thead><tr><th>Sell</th><th>Amount</th><th>Account</th><th>Tax</th></tr></thead><tbody>' + planRows + '</tbody></table>';
    } else {
      statusBox = '<div class="adv-disc" style="background:#EAF7EE;border-color:#A6D9B8;color:#1E7A43;"><strong>Fully funded.</strong> Cash (' + usd(cashNow) + ') covers your reserve target (' + usd(reserveTarget) + ') with ' + usd(-shortfall) + ' to spare. This buffer is carved out of the risk sleeve so market drops don’t force a bad-timing sale.</div>';
    }

    var riskSleeve = Math.max(0, cur.total - reserveTarget);
    return card('Cash-Flow & Liquidity Planner',
      '<div class="adv-grid">' +
        metric('Emergency reserve', usd(emergencyReserve), (p.emergencyMonths || 6) + ' mo × ' + usd(monthlySpend) + '/mo') +
        metric('Near-term needs (≤12mo)', usd(nearTotal), near.length + ' item(s)') +
        metric('Reserve target', usd(reserveTarget), 'Held in cash / MMF / T-bills') +
        metric('Risk sleeve', usd(riskSleeve), 'Total − reserve; allocation applies here') +
      '</div>' +
      '<h4 style="margin:16px 0 6px;color:var(--navy);font-size:13px;">Upcoming Cash Needs</h4>' +
      '<table class="adv-tbl"><thead><tr><th>Description</th><th>Amount</th><th>When</th><th>Treatment</th><th></th></tr></thead><tbody>' + needRows + '</tbody></table>' + addForm +
      '<div style="margin-top:14px;">' + statusBox + '</div>',
      'Reserve = emergency (months × monthly spend) + needs due within 12 months. Needs beyond 12 months stay invested. Raise-cash plan reuses the tax-aware sell priority (tax-advantaged accounts and loss lots first).');
  }
  ADV._addNeed = function () {
    var l = ($('ln_label') || {}).value, a = +($('ln_amt') || {}).value, m = +($('ln_mo') || {}).value;
    if (!l || !a) { alert('Enter a description and amount.'); return; }
    ADV.profile.liquidityNeeds = ADV.profile.liquidityNeeds || [];
    ADV.profile.liquidityNeeds.push({ label: l, amount: a, monthsAway: m || 0 });
    saveProfile(ADV.profile); render();
  };
  ADV._delNeed = function (i) { ADV.profile.liquidityNeeds.splice(i, 1); saveProfile(ADV.profile); render(); };

  /* ==================================================================== *
   *  RETIREMENT — MONTE CARLO
   * ==================================================================== */
  function portMuSig(a) {
    var ws = a.s / 100, wb = a.b / 100, wc = a.c / 100;
    var mu = ws * CMA.stock.mu + wb * CMA.bond.mu + wc * CMA.cash.mu;
    var varr = Math.pow(ws * CMA.stock.sig, 2) + Math.pow(wb * CMA.bond.sig, 2) + Math.pow(wc * CMA.cash.sig, 2)
      + 2 * 0.15 * (ws * CMA.stock.sig) * (wb * CMA.bond.sig); // mild stock/bond covar
    return { mu: mu, sig: Math.sqrt(varr) };
  }
  function runMonteCarlo(p, over) {
    over = over || {};
    var hs = getHoldings(), pv = totalMV(hs);
    var alloc = targetAllocation(p, { noRegime: true });
    var ms = portMuSig(alloc);
    var retAge = (over.retAge != null ? over.retAge : p.retirementAge);
    var age = p.age;
    var yrsAcc = Math.max(0, retAge - age);
    var yrsRet = Math.max(1, p.lifeExpectancy - retAge);
    var savings = (over.savings != null ? over.savings : p.annualSavings);
    var netSpend = Math.max(0, (over.spend != null ? over.spend : p.annualSpendNeed) - p.socialSecurityAnnual - p.pensionAnnual);
    var N = 1500, total = yrsAcc + yrsRet, success = 0;
    var bands = { p10: [], p50: [], p90: [] };
    var yearVals = [];
    for (var y = 0; y <= total; y++) yearVals.push([]);
    for (var s = 0; s < N; s++) {
      var v = pv, sp = netSpend; yearVals[0].push(v);
      for (var y2 = 1; y2 <= total; y2++) {
        var r = ms.mu + ms.sig * gauss();
        v = v * (1 + r);
        if (y2 <= yrsAcc) v += savings; else { v -= sp; sp *= (1 + INFLATION); }
        if (v < 0) v = 0;
        yearVals[y2].push(v);
      }
      if (v > 0) success++;
    }
    for (var y3 = 0; y3 <= total; y3++) {
      var arr = yearVals[y3].sort(function (a, b) { return a - b; });
      bands.p10.push(arr[Math.floor(0.10 * N)]); bands.p50.push(arr[Math.floor(0.50 * N)]); bands.p90.push(arr[Math.floor(0.90 * N)]);
    }
    return { success: success / N, bands: bands, ages: yearVals.map(function (_, i) { return age + i; }), mu: ms.mu, sig: ms.sig, alloc: alloc, pv: pv, yrsAcc: yrsAcc, yrsRet: yrsRet, retAge: retAge };
  }
  function renderRetire() {
    var p = ADV.profile;
    if (!p._saved) return card('Retirement Readiness', '<p class="adv-note">Set up your <a href="javascript:ADV.editProfile()">Client Profile</a> first.</p>');
    if (!totalMV(getHoldings())) return card('Retirement Readiness', '<p class="adv-note">No holdings loaded.</p>');
    var mc = runMonteCarlo(p);
    var base = Math.round(mc.success * 100);
    // levers
    var lever = function (lbl, res) { var d = Math.round(res.success * 100) - base; return metric(lbl, Math.round(res.success * 100) + '%', (d >= 0 ? '+' : '') + d + ' pts'); };
    var save5 = runMonteCarlo(p, { savings: p.annualSavings + 10000 });
    var late2 = runMonteCarlo(p, { retAge: p.retirementAge + 3 });
    var spendLess = runMonteCarlo(p, { spend: p.annualSpendNeed * 0.9 });

    var color = base >= 85 ? 'var(--success)' : base >= 70 ? '#8B6914' : 'var(--danger)';
    ADV._afterRender = function () {
      var ctx = $('advMCChart'); if (!ctx || !window.Chart) return;
      ADV._charts.mc = new Chart(ctx, {
        type: 'line',
        data: { labels: mc.ages, datasets: [
          { label: '90th pct', data: mc.bands.p90, borderColor: 'rgba(46,125,82,.5)', backgroundColor: 'rgba(46,125,82,.10)', fill: '+1', pointRadius: 0, borderWidth: 1, tension: .2 },
          { label: 'Median', data: mc.bands.p50, borderColor: '#003C71', backgroundColor: 'rgba(0,60,113,.05)', fill: false, pointRadius: 0, borderWidth: 2, tension: .2 },
          { label: '10th pct', data: mc.bands.p10, borderColor: 'rgba(192,57,43,.5)', backgroundColor: 'rgba(192,57,43,.08)', fill: false, pointRadius: 0, borderWidth: 1, tension: .2 }
        ] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { font: { size: 11 } } } },
          scales: { x: { title: { display: true, text: 'Age' } }, y: { title: { display: true, text: 'Portfolio value' }, ticks: { callback: function (v) { return usd(v); } } } } }
      });
    };
    return card('Retirement Readiness — Monte Carlo',
      '<div style="display:grid;grid-template-columns:200px 1fr;gap:18px;align-items:center;">' +
        '<div style="text-align:center;"><div style="font-size:52px;font-weight:800;color:' + color + ';line-height:1;">' + base + '%</div>' +
          '<div class="adv-note" style="margin-top:4px;">probability your money lasts to age ' + p.lifeExpectancy + '</div></div>' +
        '<div class="adv-note">Across <strong>1,500 simulations</strong> of your <strong>' + LEVEL_META[mc.alloc.level].label + '</strong> allocation ' +
          '(exp. return ' + pct(mc.mu * 100) + ', vol ' + pct(mc.sig * 100) + '). Starting ' + usd(mc.pv) + ', saving ' + usd(p.annualSavings) + '/yr for ' + mc.yrsAcc + ' yrs, then drawing ' + usd(Math.max(0, p.annualSpendNeed - p.socialSecurityAnnual - p.pensionAnnual)) + '/yr (net of SS/pension, inflation-adjusted) for ' + mc.yrsRet + ' yrs.</div>' +
      '</div>' +
      '<div style="height:280px;position:relative;margin-top:16px;"><canvas id="advMCChart"></canvas></div>' +
      '<h4 style="margin:16px 0 6px;color:var(--navy);font-size:13px;">What moves the needle</h4>' +
      '<div class="adv-grid">' + lever('Save +$10k/yr', save5) + lever('Retire 3 yrs later', late2) + lever('Spend 10% less', spendLess) + '</div>',
      'Monte Carlo with normally-distributed annual returns from long-run capital-market assumptions (stocks μ8.5%/σ16%, bonds μ4%/σ6.5%, cash μ3%). Inflation 2.5%. Simplification: constant allocation, no glide within the sim, mild stock/bond covariance. Success = ending value > 0 at life expectancy.');
  }

  /* ==================================================================== *
   *  DECUMULATION
   * ==================================================================== */
  function balancesByTax(hs) { var o = { taxable: 0, deferred: 0, roth: 0, hsa: 0, college: 0 }; hs.forEach(function (h) { o[h.taxType] += h.mv; }); return o; }
  function renderDecum() {
    var p = ADV.profile, hs = getHoldings(), pv = totalMV(hs), bal = balancesByTax(hs);
    var regKey = currentRegimeKey(), reg = REGIMES[regKey];
    var swrBase = 0.04, initWithdrawal = pv * swrBase;
    var netNeed = Math.max(0, p.annualSpendNeed - p.socialSecurityAnnual - p.pensionAnnual);
    var actualRate = pv > 0 ? netNeed / pv : 0;
    // Guyton-Klinger guardrails around 4% (±20%)
    var upper = swrBase * 1.2, lower = swrBase * 0.8;
    var guard;
    if (actualRate > upper) guard = { c: 'var(--danger)', t: 'Above upper guardrail (' + pct(upper * 100) + '). Guyton-Klinger: <strong>cut spending ~10%</strong> to protect longevity.' };
    else if (actualRate < lower) guard = { c: 'var(--success)', t: 'Below lower guardrail (' + pct(lower * 100) + '). You have room to <strong>raise spending ~10%</strong> or gift/convert.' };
    else guard = { c: '#8B6914', t: 'Within guardrails (' + pct(lower * 100) + '–' + pct(upper * 100) + '). Hold spending steady.' };
    var regimeCut = (reg.tilt <= -8) ? '<div class="adv-disc" style="background:#FDEDEC;border-color:#E6A9A0;color:#922B21;margin-top:10px;"><strong>Regime alert (' + reg.label + '):</strong> in a drawdown regime, skip this year’s inflation raise and draw from the cash bucket first — this is the sequence-of-returns defense that separates a plan from a static withdrawal.</div>' : '';

    // RMD
    var rmdBox = '';
    if (p.age >= 73 && bal.deferred > 0) {
      var f = RMD_FACTORS[Math.min(100, p.age)] || 6.4; var rmd = bal.deferred / f;
      rmdBox = card('Required Minimum Distributions (RMD)',
        '<div class="adv-grid">' + metric('Tax-deferred balance', usd(bal.deferred), '') + metric('IRS divisor (age ' + p.age + ')', f, 'Uniform Lifetime Table') + metric('This year’s RMD', usd(rmd), 'Must withdraw — taxed as ordinary income') + '</div>',
        'IRS Uniform Lifetime Table (post-SECURE 2.0). RMD = prior year-end tax-deferred balance ÷ divisor. Roth IRAs are exempt.');
    } else if (!p.currentlyRetired && p.age < 73) {
      rmdBox = card('RMD Planning', '<p class="adv-note">RMDs begin at age 73. You have ' + (73 - p.age) + ' years — the window before then is prime time for <strong>Roth conversions</strong> to shrink future RMDs. See the Tax Center.</p>');
    }

    var order = [
      ['1. Taxable accounts', bal.taxable, 'Spend first — lets tax-advantaged accounts keep compounding. Use specific-lot selection & harvest losses.'],
      ['2. Tax-deferred (IRA/401k)', bal.deferred, 'Next — ordinary-income taxed. Fill low brackets; coordinate with RMDs after 73.'],
      ['3. Roth (last)', bal.roth, 'Preserve for last — tax-free growth and no RMDs; ideal for legacy or late-life care costs.'],
      ['HSA', bal.hsa, 'Tax-free for qualified medical — pair with health costs.']
    ].filter(function (x) { return x[1] > 0; });
    var orderRows = order.map(function (o) { return '<tr><td><strong>' + o[0] + '</strong></td><td>' + usd(o[1]) + '</td><td class="adv-note">' + o[2] + '</td></tr>'; }).join('');

    return card('Decumulation & Withdrawal Sequencer',
      '<div class="adv-grid">' +
        metric('Portfolio', usd(pv), '') +
        metric('Net spending need', usd(netNeed), 'After SS ' + usd(p.socialSecurityAnnual) + ' + pension ' + usd(p.pensionAnnual)) +
        metric('Current withdrawal rate', pct(actualRate * 100), 'vs. 4% base') +
        metric('Sustainable @4%', usd(initWithdrawal), 'Bengen starting point') +
      '</div>' +
      '<div class="adv-disc" style="background:#FEF9E7;border-color:#F4D35E;color:#7A5B00;margin-top:12px;border-left:4px solid ' + guard.c + ';"><strong>Guardrail status:</strong> ' + guard.t + '</div>' + regimeCut +
      '<h4 style="margin:16px 0 6px;color:var(--navy);font-size:13px;">Withdrawal Order (tax sequencing)</h4>' +
      '<table class="adv-tbl"><thead><tr><th>Source</th><th>Balance</th><th>Rationale</th></tr></thead><tbody>' + orderRows + '</tbody></table>',
      'Dynamic withdrawal: 4% Bengen base with Guyton-Klinger guardrails (±20%). Regime engine triggers spending freezes in drawdowns (sequence-of-returns defense). Withdrawal order: taxable → tax-deferred → Roth, HSA for medical.') + rmdBox;
  }

  /* ==================================================================== *
   *  TAX CENTER
   * ==================================================================== */
  function idealLocation(h) {
    var ac = (h.assetClass || '').toLowerCase(), sec = (h.sector || '').toLowerCase();
    if (h.bucket === 'bond' || sec === 'fixed income') return 'deferred';       // interest = ordinary income
    if (sec === 'real estate' || ac.indexOf('reit') >= 0) return 'deferred';    // non-qualified dividends
    if (ac.indexOf('leveraged') >= 0 || ac === 'digital asset') return 'roth';  // high growth/turnover → tax-free
    return 'taxable';                                                           // tax-efficient equity/ETF fine in taxable
  }
  function renderTax() {
    var p = ADV.profile, hs = getHoldings();
    // asset location misplacements
    var misplaced = hs.filter(function (h) { var ideal = idealLocation(h); return ideal !== h.taxType && !(ideal === 'taxable' && h.taxType === 'roth'); });
    var locRows = misplaced.length ? misplaced.map(function (h) {
      var ideal = idealLocation(h);
      return '<tr><td><strong>' + esc(h.ticker) + '</strong></td><td>' + esc(h.assetClass) + '</td><td>' + TAX_LABEL[h.taxType] + '</td><td>→ ' + TAX_LABEL[ideal] + '</td><td class="adv-note">' + locReason(h, ideal) + '</td></tr>';
    }).join('') : '<tr><td colspan="5" class="adv-note">✅ No obvious asset-location issues — tax-inefficient assets are in sheltered accounts.</td></tr>';

    // TLH summary (taxable losses)
    var losses = hs.filter(function (h) { return h.taxType === 'taxable' && h.gain < 0; });
    var totalLoss = losses.reduce(function (s, h) { return s + h.gain; }, 0);
    var tlhRows = losses.length ? losses.sort(function (a, b) { return a.gain - b.gain; }).map(function (h) {
      return '<tr><td><strong>' + esc(h.ticker) + '</strong></td><td>' + esc(h.account) + '</td><td style="color:var(--danger);">' + usd(h.gain) + '</td><td>' + pct(h.gainPct) + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="adv-note">No harvestable losses in taxable accounts.</td></tr>';

    // Roth conversion headroom
    var br = BRACKETS[p.filingStatus] || BRACKETS.married;
    var ti = p.taxableIncome || 0, topOfBracket = null, curRate = null;
    for (var i = 0; i < br.length; i++) { if (ti >= br[i][0]) { curRate = br[i][1]; topOfBracket = (i + 1 < br.length) ? br[i + 1][0] : Infinity; } }
    var headroom = (topOfBracket === Infinity) ? 0 : Math.max(0, topOfBracket - ti);
    var bal = balancesByTax(hs);
    var rothBox = card('Roth Conversion Opportunity',
      '<div class="adv-grid">' +
        metric('Current bracket', pct((curRate || 0) * 100, 0), p.filingStatus === 'married' ? 'MFJ' : 'Single') +
        metric('Headroom to next bracket', usd(headroom), 'Taxable income ' + usd(ti)) +
        metric('Traditional IRA/401k', usd(bal.deferred), 'Convertible balance') +
        metric('Suggested conversion', usd(Math.min(headroom, bal.deferred)), 'Fills current bracket') +
      '</div>' +
      '<p class="adv-note" style="margin-top:10px;">Converting up to <strong>' + usd(Math.min(headroom, bal.deferred)) + '</strong> keeps you in the ' + pct((curRate || 0) * 100, 0) + ' bracket while moving money to tax-free growth. <strong>Best executed in down markets</strong> (convert more shares per tax dollar) and low-income years before RMDs start at 73.</p>',
      '2025 federal brackets. Headroom = top of current bracket − taxable income. Not state-adjusted (your state: ' + pct(p.stateTaxRate) + ').');

    var cgBudget = card('Capital-Gains Budget',
      '<div class="form-row" style="gap:10px;align-items:flex-end;">' +
        '<div class="adv-field" style="margin:0;"><label>Annual gains budget ($)</label><input class="adv-input" id="cg_budget" type="number" value="' + (p.capGainsBudget || 0) + '" style="width:140px;"></div>' +
        '<div class="adv-field" style="margin:0;"><label>YTD realized gains ($)</label><input class="adv-input" id="cg_ytd" type="number" value="' + (p.ytdRealizedGains || 0) + '" style="width:140px;"></div>' +
        '<button class="btn btn-sm" onclick="ADV._saveCG()">Save</button></div>' +
      '<p class="adv-note" style="margin-top:8px;">Remaining budget: <strong>' + usd(Math.max(0, (p.capGainsBudget || 0) - (p.ytdRealizedGains || 0))) + '</strong>. The recommendation engine caps taxable rebalancing sells to this budget, harvesting offsetting losses first.</p>');

    return card('Tax-Planning Center',
      '<h4 style="margin:0 0 6px;color:var(--navy);font-size:13px;">Asset Location Optimizer</h4>' +
      '<p class="adv-note" style="margin-bottom:8px;">Puts the least tax-efficient assets (bonds, REITs) in sheltered accounts and highest-growth assets in Roth.</p>' +
      '<table class="adv-tbl"><thead><tr><th>Holding</th><th>Type</th><th>Now</th><th>Ideal</th><th>Why</th></tr></thead><tbody>' + locRows + '</tbody></table>' +
      '<h4 style="margin:16px 0 6px;color:var(--navy);font-size:13px;">Tax-Loss Harvesting — Taxable Accounts (total: <span style="color:var(--danger);">' + usd(totalLoss) + '</span>)</h4>' +
      '<table class="adv-tbl"><thead><tr><th>Holding</th><th>Account</th><th>Unrealized loss</th><th>%</th></tr></thead><tbody>' + tlhRows + '</tbody></table>' +
      '<p class="adv-note" style="margin-top:6px;">⚠️ <strong>Wash-sale (IRC §1091):</strong> don’t rebuy the same/substantially-identical security within 30 days. The Rebalance tab has the full TLH scanner with thresholds.</p>',
      'Asset-location rules: interest-bearing & non-qualified-dividend assets → tax-deferred; highest-growth/high-turnover → Roth; tax-efficient equity index → taxable.') + rothBox + cgBudget;
  }
  function locReason(h, ideal) {
    if (ideal === 'deferred') return 'Generates ordinary-income taxed distributions — shelter in tax-deferred.';
    if (ideal === 'roth') return 'High growth/turnover — maximize tax-free compounding in Roth.';
    return 'Tax-efficient — fine in taxable.';
  }
  ADV._saveCG = function () { ADV.profile.capGainsBudget = +($('cg_budget') || {}).value || 0; ADV.profile.ytdRealizedGains = +($('cg_ytd') || {}).value || 0; saveProfile(ADV.profile); render(); };

  /* ==================================================================== *
   *  LIFE EVENTS
   * ==================================================================== */
  var LIFE_EVENTS = {
    retire:   { t: '🏖️ Nearing Retirement', d: 'Pull retirement in to 2 years out', apply: function (p) { p.retirementAge = p.age + 2; p.emergencyMonths = Math.max(p.emergencyMonths, 12); } },
    child:    { t: '👶 New Child', d: 'Add an 18-year education goal + raise reserve', apply: function (p) { p.goals.push({ name: 'College', targetYear: new Date().getFullYear() + 18, targetAmount: 250000 }); p.emergencyMonths = Math.max(p.emergencyMonths, 9); } },
    inherit:  { t: '💰 Inheritance / Windfall', d: 'Model a lump sum & step up reserve', apply: function (p) { p.annualSavings += 0; p._windfall = 250000; } },
    jobloss:  { t: '📉 Job Loss', d: 'Raise emergency reserve to 12 mo, cut savings, lower capacity', apply: function (p) { p.emergencyMonths = 12; p.annualSavings = 0; p.incomeStability = 'variable'; } },
    purchase: { t: '🏠 Large Purchase', d: 'Add a near-term liquidity need', apply: function (p) { p.liquidityNeeds = p.liquidityNeeds || []; p.liquidityNeeds.push({ label: 'Home / large purchase', amount: 100000, monthsAway: 10 }); } },
    crash:    { t: '🌩️ Market Crash', d: 'Switch regime to Contraction & review de-risking', apply: function (p) { setRegime('contraction'); } }
  };
  function renderLife() {
    var buttons = Object.keys(LIFE_EVENTS).map(function (k) {
      var e = LIFE_EVENTS[k];
      return '<button class="adv-le-btn" onclick="ADV.previewLife(\'' + k + '\')"><span class="t">' + e.t + '</span><span class="adv-note">' + e.d + '</span></button>';
    }).join('');
    var preview = ADV._lifePreview || '<p class="adv-note">Select a life event to see how your governing risk level, glide target, and liquidity change — then apply it or discard.</p>';
    return card('Life-Event Re-Planner',
      '<p class="adv-note" style="margin-bottom:10px;">This is what proves the tool <em>adapts</em>. Each event re-runs risk capacity, the glide path, liquidity reserve, and recommendations — exactly what an advisor does when your life changes.</p>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:14px;">' + buttons + '</div>' +
      '<div id="advLifePreview">' + preview + '</div>');
  }
  ADV.previewLife = function (k) {
    var e = LIFE_EVENTS[k]; if (!e) return;
    var before = governing(ADV.profile), bTgt = targetAllocation(ADV.profile);
    var clone = JSON.parse(JSON.stringify(ADV.profile));
    clone.goals = clone.goals || []; clone.liquidityNeeds = clone.liquidityNeeds || [];
    e.apply(clone);
    var after = governing(clone), aTgt = targetAllocation(clone);
    function chip(x) { return govPill(x); }
    var rows = '<table class="adv-tbl"><thead><tr><th>Factor</th><th>Before</th><th>After</th></tr></thead><tbody>' +
      '<tr><td>Governing risk level</td><td>' + chip(before.governing) + '</td><td>' + chip(after.governing) + '</td></tr>' +
      '<tr><td>Years to retirement</td><td>' + before.capacity.yearsToRet + '</td><td>' + after.capacity.yearsToRet + '</td></tr>' +
      '<tr><td>Target equity %</td><td>' + pct(bTgt.s) + '</td><td>' + pct(aTgt.s) + '</td></tr>' +
      '<tr><td>Emergency reserve (mo)</td><td>' + ADV.profile.emergencyMonths + '</td><td>' + clone.emergencyMonths + '</td></tr>' +
      '<tr><td>Goals</td><td>' + (ADV.profile.goals || []).length + '</td><td>' + clone.goals.length + '</td></tr>' +
      '</tbody></table>';
    var note = after.governing !== before.governing
      ? '<div class="adv-disc" style="margin-top:10px;">This event changes your governing level from <strong>' + LEVEL_META[before.governing].label + '</strong> to <strong>' + LEVEL_META[after.governing].label + '</strong>. Applying it will shift every recommendation accordingly.</div>'
      : '<div class="adv-disc" style="margin-top:10px;background:#EAF7EE;border-color:#A6D9B8;color:#1E7A43;">Governing level holds, but target equity moves from ' + pct(bTgt.s) + ' to ' + pct(aTgt.s) + ' and liquidity/goals update.</div>';
    ADV._lifePreview = '<h4 style="margin:0 0 8px;color:var(--navy);font-size:13px;">' + e.t + ' — Preview</h4>' + rows + note +
      '<div style="margin-top:10px;"><button class="btn btn-sm" onclick="ADV.applyLife(\'' + k + '\')">Apply to my profile</button> ' +
      '<button class="btn-outline btn-sm" onclick="ADV._lifePreview=null;ADV.render()">Discard</button></div>';
    render();
    setTimeout(function () { var el = $('advLifePreview'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 50);
  };
  ADV.applyLife = function (k) {
    var e = LIFE_EVENTS[k]; if (!e) return;
    ADV.profile.goals = ADV.profile.goals || []; ADV.profile.liquidityNeeds = ADV.profile.liquidityNeeds || [];
    e.apply(ADV.profile); saveProfile(ADV.profile); ADV._lifePreview = null;
    ADV.section = 'overview'; render();
  };

  /* ---------- boot ------------------------------------------------------ */
  // If the advisor tab is already active on load, render it.
  document.addEventListener('DOMContentLoaded', function () {
    var t = $('htab-advisor');
    if (t && t.classList.contains('active')) { injectCSS(); render(); }
  });

})();
