/* ============================================================================
   Perry Asset Management — Structural Migration  (app-consolidate.js)
   Rewritten 2026-07-25 (second pass).  Load LAST, after app3.js / app-corr.js.

   ─────────────────────────────────────────────────────────────────────────────
   WHAT THIS DOES NOW
   ─────────────────────────────────────────────────────────────────────────────
   The first pass grouped cards inside "More Cross-Asset" into switcher windows.
   That was the wrong call — the tab should not exist at all. Its contents belong
   with the things they describe:

     Risk & Tails          -> Manage Holdings  (portfolio risk)
     Allocation & Sizing   -> Manage Holdings  (portfolio optimisation)
     Correlation Workbench -> Manage Holdings  (your holdings' correlations)
     Market Activity       -> its own page under Portfolio
     Regime Structure      -> DELETED, genuinely duplicated (see below)
     Decision Compass etc. -> retired into the Unified View

   THE REGIME STRUCTURE DUPLICATION, VERIFIED
   Wasserstein Regime Distance appears in THREE tab panels — catab-breadth,
   catab-momentum and catab-analytics — and Intermarket Lead/Lag in TWO. The
   analytics copies are the redundant ones; catab-momentum's "Cross-Asset Regime
   Distance & RMT Correlation Analysis" covers the same ground and sits with the
   other cross-asset regime work. So those cards are removed rather than moved.

   ALSO REVERTED FROM PASS ONE
   Grouping the Sector Rotation and Breadth tabs into switchers made both worse —
   Sector Rotation's two graphs already filled the page side by side, and Breadth
   ended up a wall of buttons over nested windows. Both reverted. The only
   grouping kept is the Yield Curve tab, where two independently-built Treasury
   curve charts genuinely stack on top of each other.

   Everything here is a DOM MOVE, not a copy — no markup is duplicated, and every
   existing loader keeps its element IDs and keeps working.
   ============================================================================ */

(function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════════════════════
     helpers
     ══════════════════════════════════════════════════════════════════════════ */

  function matchesByTitle(root, needle) {
    var out = [], n = needle.toLowerCase();
    (root || document).querySelectorAll('.card').forEach(function (c) {
      var t = c.querySelector('.card-title');
      if (t && t.textContent.toLowerCase().indexOf(n) >= 0) out.push(c);
    });
    return out;
  }
  function byTitle(root, needle) { return matchesByTitle(root, needle)[0] || null; }
  function allByTitles(root, needles) {
    var seen = [], out = [];
    needles.forEach(function (n) {
      matchesByTitle(root, n).forEach(function (c) {
        if (seen.indexOf(c) < 0) { seen.push(c); out.push(c); }
      });
    });
    return out;
  }
  function el(id) { return document.getElementById(id); }

  /** Create a Manage Holdings sub-tab (button + panel) before the Advisor tab. */
  function makeHoldingsTab(id, label, title) {
    if (el('htab-' + id)) return el('htab-' + id);
    var page = el('page-holdings');
    var strip = page ? page.querySelector('.pf-tabs') : null;
    var advBtn = null;
    if (strip) {
      strip.querySelectorAll('button').forEach(function (b) {
        if (!advBtn && b.getAttribute('data-htab') === 'advisor') advBtn = b;
      });
    }
    var advPanel = el('htab-advisor');
    if (!strip || !advPanel) return null;

    var b = document.createElement('button');
    b.className = 'pf-tab';
    b.setAttribute('data-htab', id);
    b.setAttribute('onclick', "holdingsShowTab('" + id + "')");
    b.textContent = label;
    if (title) b.title = title;
    strip.insertBefore(b, advBtn);

    var p = document.createElement('div');
    p.className = 'pf-tab-content';
    p.setAttribute('id', 'htab-' + id);
    advPanel.parentNode.insertBefore(p, advPanel);
    return p;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     1. RETIRE THE DUPLICATED POSTURE CARDS
     ══════════════════════════════════════════════════════════════════════════ */

  function retireDuplicates(root) {
    var dupes = [
      { needle: 'Decision Compass', why: 'The Unified View states one posture with a gross-exposure target, derived from four signals by a stated hierarchy. Decision Compass answered the same question with separate logic and no reconciliation.' },
      { needle: 'Macro Headwinds', why: 'Now covered by the Signal Reconciliation table, which shows each signal WITH its horizon and confidence.' },
      { needle: 'Recommended Portfolio Archetypes', why: 'Superseded by the regime sector tilt plus the Holding Quality Ranker, which acts on your actual positions rather than a generic archetype.' }
    ];
    var found = [];
    dupes.forEach(function (d) { var c = byTitle(root, d.needle); if (c) found.push({ el: c, meta: d }); });
    found.forEach(function (f) { f.el.remove(); });
    return found.length;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     2. DELETE THE GENUINELY DUPLICATED REGIME-STRUCTURE CARDS
     ══════════════════════════════════════════════════════════════════════════ */

  function deleteRegimeStructureDupes(root) {
    // These exist in catab-momentum / catab-breadth as well; the analytics
    // copies are the redundant ones.
    var kill = allByTitles(root, ['Wasserstein Regime Distance', 'Cox Doubly-Stochastic', 'Intermarket Lead/Lag']);
    kill.forEach(function (c) { c.remove(); });
    return kill.length;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     3. MOVE RISK + ALLOCATION TO MANAGE HOLDINGS

     These two share the "Universe Selection & Date Range" control — every card
     in both groups reads the universe it selects. Splitting them into separate
     tabs would orphan that control in one of them, so they live in one tab with
     a two-view switcher and the selector pinned above. Same destination, same
     separation of concerns, without breaking the shared input.
     ══════════════════════════════════════════════════════════════════════════ */

  /* ══════════════════════════════════════════════════════════════════════════
     MARKET-DATA BOOTSTRAP — added 2026-07-25 after the first migration broke it.

     THE BUG: every card moved out of More Cross-Asset (VaR, Rolling Risk, Vol
     Surface, Efficient Frontier, Omega, Rebased Return) reads window.MKT_STATE,
     which is populated by mktInit() + mktLoadAll(). Those were called from ONE
     place — the `camore` branch of macroShowTab — and removing that tab removed
     the only trigger. Result: the universe grid was never built (so the "primary
     asset" dropdown was empty) and every dependent card sat on "Awaiting data"
     forever.

     Now the bootstrap is owned here and fired on first open of whichever tab
     needs it, so it no longer depends on a tab that no longer exists.
     ══════════════════════════════════════════════════════════════════════════ */
  var _mktBooting = false;
  function ensureMarketData(cb) {
    if (window._mktLoadedOnce) { if (cb) cb(); return; }
    if (_mktBooting) { if (cb) setTimeout(function () { ensureMarketData(cb); }, 400); return; }
    _mktBooting = true;
    try {
      if (!window._mktInitialized && typeof mktInit === 'function') {
        mktInit();
        window._mktInitialized = true;
      }
      var endEl = el('mktEndDate');
      if (endEl && !endEl.value) endEl.value = new Date().toISOString().slice(0, 10);
      if (typeof mktLoadAll === 'function') {
        mktLoadAll().then(function () {
          window._mktLoadedOnce = true; _mktBooting = false; if (cb) cb();
        }).catch(function (e) {
          console.warn('[migrate] mktLoadAll failed:', e);
          _mktBooting = false; if (cb) cb();
        });
      } else { _mktBooting = false; if (cb) cb(); }
    } catch (e) {
      console.warn('[migrate] market bootstrap failed:', e);
      _mktBooting = false; if (cb) cb();
    }
  }
  window.PerryEnsureMarketData = ensureMarketData;

  function moveRiskAndAllocation(src) {
    var panel = makeHoldingsTab('riskopt', 'Risk & Optimization',
      'Portfolio risk and allocation modelling, moved here from the Macro page because both operate on portfolio construction.');
    if (!panel) return 0;

    var universe = byTitle(src, 'Universe Selection');
    var risk = allByTitles(src, ['Value at Risk', 'Rolling Risk Metrics', '3D Volatility Surface']);
    var alloc = allByTitles(src, ['Efficient Frontier', 'Omega Ratio Rebalancing']);
    if (!risk.length && !alloc.length) return 0;

    var intro = document.createElement('div');
    intro.style.cssText = 'font-size:11.5px;color:var(--text-sec);line-height:1.6;margin-bottom:10px;';
    intro.innerHTML = 'Risk and allocation modelling for the universe selected below. '
      + '<span class="help-icon" title="Moved here from Macro > More Cross-Asset on 2026-07-25. These operate on portfolio construction, so they belong with Manage Holdings. Both groups read the same Universe Selection control, which is why they share a tab rather than sitting in two.">&#9432;</span>';
    panel.appendChild(intro);
    if (universe) panel.appendChild(universe);

    var wrap = document.createElement('div');
    panel.appendChild(wrap);

    if (typeof makeCardSwitcher === 'function' && risk.length >= 2) {
      var a1 = document.createElement('div'); wrap.appendChild(a1);
      makeCardSwitcher(risk, 'Risk &amp; Tails <span class="help-icon" title="How bad can it get? Value at Risk and Expected Shortfall across estimation methods, rolling Sharpe/Sortino/beta/drawdown, and the realized-volatility term structure (10D–252D windows) — three lenses on the same question." data-heading="Risk and Tails">&#9432;</span>', a1);
      if (a1.parentNode) a1.remove();
    } else risk.forEach(function (c) { wrap.appendChild(c); });

    if (typeof makeCardSwitcher === 'function' && alloc.length >= 2) {
      var a2 = document.createElement('div'); wrap.appendChild(a2);
      makeCardSwitcher(alloc, 'Allocation &amp; Sizing <span class="help-icon" title="How much of each? Markowitz and Omega efficient frontier plus the Omega rebalancing signal. For recommendations against your ACTUAL positions rather than the selected universe, use the Quality Ranker under Analysis." data-heading="Allocation and Sizing">&#9432;</span>', a2);
      if (a2.parentNode) a2.remove();
    } else alloc.forEach(function (c) { wrap.appendChild(c); });

    return risk.length + alloc.length;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     4. MOVE THE CORRELATION WORKBENCH TO MANAGE HOLDINGS
     ══════════════════════════════════════════════════════════════════════════ */

  function moveCorrelation(src) {
    var wb = el('corrWorkbench');
    if (!wb) return 0;
    var panel = makeHoldingsTab('correlation', 'Correlation',
      'Correlation across your holdings, the SPDR sectors, or asset classes — conditioned on market regime.');
    if (!panel) return 0;
    panel.appendChild(wb);
    return 1;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     5. MARKET ACTIVITY AS ITS OWN PAGE UNDER PORTFOLIO
     ══════════════════════════════════════════════════════════════════════════ */

  function makeMarketActivityPage(src) {
    if (el('page-activity')) return 0;
    var cards = allByTitles(src, ['Rebased Return Chart', 'Moving Today']);
    if (!cards.length) return 0;

    var homePage = el('page-home');
    var host = homePage ? homePage.parentNode : null;
    if (!host) return 0;

    var page = document.createElement('div');
    page.className = 'page';
    page.setAttribute('id', 'page-activity');
    var wrap = document.createElement('div');
    wrap.className = 'content-wrap';
    page.appendChild(wrap);

    var hero = document.createElement('div');
    hero.className = 'hero';
    hero.style.padding = '26px 34px';
    hero.innerHTML = '<h1>Market Activity</h1>'
      + '<p>What has actually been moving — today\'s drivers and rebased performance across the selected universe.</p>';
    wrap.appendChild(hero);
    cards.forEach(function (c) { wrap.appendChild(c); });
    host.appendChild(page);

    // Nav entry under Portfolio — located by scanning .nav-child rather than a
    // descendant selector, so it does not depend on the nav's exact nesting.
    var pfDropdown = null;
    document.querySelectorAll('.nav-child').forEach(function (n) {
      if (!pfDropdown && n.getAttribute('data-page') === 'themes') pfDropdown = n;
    });
    if (pfDropdown && pfDropdown.parentNode) {
      var d = document.createElement('div');
      d.className = 'nav-child';
      d.setAttribute('data-page', 'activity');
      d.setAttribute('onclick', "navigateTo('activity')");
      d.textContent = 'Market Activity';
      pfDropdown.parentNode.insertBefore(d, pfDropdown.nextSibling);
    }
    // Mobile drawer.
    var mob = null;
    document.querySelectorAll('.mob-nav-item').forEach(function (n) {
      if (!mob && n.getAttribute('data-mobpage') === 'themes') mob = n;
    });
    if (mob && mob.parentNode) {
      var b = document.createElement('button');
      b.className = 'mob-nav-item';
      b.setAttribute('data-mobpage', 'activity');
      b.setAttribute('onclick', "mobileNav('activity')");
      b.textContent = 'Market Activity';
      mob.parentNode.insertBefore(b, mob.nextSibling);
    }
    // navigateTo() maps unknown pages to a nav parent; register this one.
    try { if (window.parentMap) window.parentMap.activity = 'portfolio'; } catch (e) {}
    return cards.length;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     6. REMOVE THE NOW-EMPTY "MORE CROSS-ASSET" TAB
     ══════════════════════════════════════════════════════════════════════════ */

  function removeMoreTab() {
    var panel = el('macrotab-camore');
    if (!panel) return false;
    // Anything left that we did not explicitly place goes to the Risk tab rather
    // than being destroyed — losing a card silently would be worse than a stray one.
    var leftovers = [];
    panel.querySelectorAll('.card').forEach(function (c) { leftovers.push(c); });
    if (leftovers.length) {
      var risk = el('htab-riskopt');
      if (risk) leftovers.forEach(function (c) { risk.appendChild(c); });
    }
    var btn = null;
    document.querySelectorAll('button').forEach(function (b) {
      if (!btn && b.getAttribute('data-macrotab') === 'camore') btn = b;
    });
    if (btn) btn.remove();
    panel.remove();
    // If it was the active tab, fall back to the macro dashboard.
    try {
      if (typeof macroShowTab === 'function' && !document.querySelector('#page-macro .pf-tab-content.active')) {
        macroShowTab('dashboard');
      }
    } catch (e) {}
    return true;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     7. YIELD CURVE — the one grouping worth keeping
     ══════════════════════════════════════════════════════════════════════════ */

  /* REBUILT 2026-07-26. The old grouping collected every card whose title
     matched "Full Treasury Yield Curve" — which caught BOTH independently-
     built copies of the same chart (one of them hidden), so two of the three
     switcher buttons showed the identical curve and the third pane was empty.
     The tab now presents four genuinely different angles:
       1. Curve Snapshot   — where the curve IS (FRED live + historical overlays)
       2. Curve Dynamics   — how it MOVED (Δ by maturity, steepener/flattener
                             classification, 2s5s10s butterfly) [new]
       3. Spreads & Inversion — 2s10s and 3m10y history, the recession clocks
       4. Pillar Scorecard — how the curve scores inside the macro composite */
  function groupYieldCurve() {
    if (typeof makeCardSwitcher !== 'function') return 0;
    var panel = el('macrotab-yieldcurve');
    if (!panel || panel.getAttribute('data-grouped') === '1') return 0;

    // Kill any surviving duplicate of the CA full-curve chart outright.
    matchesByTitle(panel, 'Full Treasury Yield Curve — Current').forEach(function (c) { c.remove(); });

    var snapshot = byTitle(panel, 'Full Treasury Yield Curve');
    var pillar = byTitle(panel, 'Yield Curve Pillar');
    if (!snapshot || !pillar) return 0;

    // Wrap the 2s10s + 3m10y grid into one "Spreads & Inversion" pane.
    var spreadsPane = null;
    var s2card = byTitle(panel, '2s10s Spread History');
    if (s2card && s2card.parentNode && s2card.parentNode !== panel) {
      var grid = s2card.parentNode;                 // the 2-column grid div
      spreadsPane = document.createElement('div');
      spreadsPane.className = 'card';
      spreadsPane.innerHTML = '<div class="card-title">Spreads &amp; Inversion History &mdash; the Recession Clocks'
        + ' <span class="help-icon" title="2s10s (10Y − 2Y) and 3m10y (10Y − 3M) through time. Inversion (below zero) has preceded every US recession in the modern era; the 3m10y version is the NY Fed’s preferred specification. The dangerous moment is historically the RE-steepening out of inversion, not the inversion itself.">?</span></div>';
      var body = document.createElement('div');
      body.className = 'card-body';
      grid.parentNode.insertBefore(spreadsPane, grid);
      body.appendChild(grid);
      spreadsPane.appendChild(body);
      grid.style.marginBottom = '0';
    }

    // New Curve Dynamics card — rendered by ycRenderDynamics() (app2.js)
    // from the same FRED payload the snapshot chart already fetched.
    var dyn = document.createElement('div');
    dyn.className = 'card';
    dyn.innerHTML = '<div class="card-title">Curve Dynamics &mdash; Steepener / Flattener Decomposition'
      + ' <span class="help-icon" title="Not where the curve is — how it moved. Bars show the yield change at each maturity over 1M/3M/6M/1Y; the banner classifies the 3-month move as a bull/bear steepener/flattener from the sign of Δ2Y vs Δ10Y. Each of the four regimes has a distinct historical playbook.">?</span></div>'
      + '<div class="card-body"><div id="ycDynamicsBody"><div style="text-align:center;padding:24px;color:var(--text-sec);"><span class="spinner"></span> Waiting for FRED curve data…</div></div></div>'
      + '<div class="card-sources"><strong>Sources:</strong><br>&#8226; FRED&reg; — Treasury constant-maturity series (DGS1MO&hellip;DGS30), snapshots today vs 1M/3M/6M/1Y ago. Same payload as the Curve Snapshot; no extra requests.</div>';

    var els = [snapshot, dyn, spreadsPane, pillar].filter(Boolean);
    snapshot.setAttribute('data-switch-label', 'Curve Snapshot');
    dyn.setAttribute('data-switch-label', 'Curve Dynamics');
    if (spreadsPane) spreadsPane.setAttribute('data-switch-label', 'Spreads & Inversion');
    pillar.setAttribute('data-switch-label', 'Pillar Scorecard');

    var anchor = document.createElement('div');
    els[0].parentNode.insertBefore(anchor, els[0]);
    makeCardSwitcher(els, 'Yield Curve <span class="help-icon" title="Four angles on the Treasury curve: today’s shape vs history (Snapshot), how it moved and which steepener/flattener regime that is (Dynamics), the 2s10s / 3m10y recession clocks (Spreads), and how it scores in the macro composite (Pillar)." data-heading="Yield Curve">&#9432;</span>', anchor);
    if (anchor.parentNode) anchor.remove();
    panel.setAttribute('data-grouped', '1');

    // Populate dynamics if the FRED payload is already in memory.
    try { if (typeof ycRenderDynamics === 'function') ycRenderDynamics(); } catch (e) {}
    return 1;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     RUN
     ══════════════════════════════════════════════════════════════════════════ */

  function run() {
    if (typeof makeCardSwitcher !== 'function') { setTimeout(run, 600); return; }
    var src = el('macrotab-camore');
    if (!src) { groupYieldCurve(); return; }
    if (src.getAttribute('data-migrated') === '1') return;
    src.setAttribute('data-migrated', '1');

    var log = {};
    try { log.retired = retireDuplicates(src); } catch (e) { console.warn('[migrate] retire:', e); }
    try { log.regimeDeleted = deleteRegimeStructureDupes(src); } catch (e) { console.warn('[migrate] regime:', e); }
    try { log.riskAlloc = moveRiskAndAllocation(src); } catch (e) { console.warn('[migrate] riskalloc:', e); }
    try { log.correlation = moveCorrelation(src); } catch (e) { console.warn('[migrate] corr:', e); }
    try { log.activity = makeMarketActivityPage(src); } catch (e) { console.warn('[migrate] activity:', e); }
    try { log.tabRemoved = removeMoreTab(); } catch (e) { console.warn('[migrate] remove:', e); }
    try { log.yieldCurve = groupYieldCurve(); } catch (e) { console.warn('[migrate] yc:', e); }

    console.info('[migrate] More Cross-Asset dissolved:', JSON.stringify(log));
  }

  function schedule() { setTimeout(run, 2000); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule);
  else schedule();

  window.PerryConsolidate = { run: run, makeHoldingsTab: makeHoldingsTab };
})();
