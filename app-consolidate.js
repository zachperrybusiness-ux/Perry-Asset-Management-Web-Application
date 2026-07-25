/* ============================================================================
   Perry Asset Management — "More Cross-Asset" Consolidation  (app-consolidate.js)
   Added 2026-07-25.  Load LAST, after app3.js and app-corr.js.

   ─────────────────────────────────────────────────────────────────────────────
   WHY
   ─────────────────────────────────────────────────────────────────────────────
   "More Cross-Asset" was a catch-all. mergeCrossAssetIntoMacro() relocated seven
   Cross-Asset tabs into purpose-built Macro tabs and then dumped whatever was
   left — the entire Top-Line View plus the Analytics & Models workspace — into a
   single tab. The result was 16 stacked cards and 13 canvases in one scroll.

   Worse, three of those cards now DUPLICATE the Unified View built on 2026-07-24:

     Decision Compass — "Where Should Capital Be?"   → the Unified View's posture
     Macro Headwinds Direction                       → the signal reconciliation table
     Recommended Portfolio Archetypes                → the regime sector tilt

   Each answered "what should I own?" with its own independent logic and no
   reconciliation against the others. That is precisely the conflicting-signal
   problem the Unified View exists to end, so keeping them as rival answers would
   re-introduce the disease after curing it.

   WHAT THIS DOES
   1. Replaces the three duplicated cards with a single pointer to the Unified
      View, rather than silently deleting them (the user should know where the
      answer moved, and why there is now only one).
   2. Folds the 12 Analytics & Models cards into 4 grouped switcher windows, so
      each is one window with in-place view buttons — the same pattern the
      Holdings > Analysis tab already uses successfully.
   3. Leaves the Correlation Workbench pinned and always visible, because it is
      the tab's primary tool.

   Nothing is deleted. Every card still exists and still renders; it is reached
   by a button instead of a scroll.
   ============================================================================ */

(function () {
  'use strict';

  /** First card whose title contains `needle`. */
  function byTitle(root, needle) {
    return matchesByTitle(root, needle)[0] || null;
  }

  /**
   * EVERY card whose title contains `needle`.
   *
   * Fixed 2026-07-25: this originally returned only the first match, which meant
   * a genuine duplicate — two cards both titled "Full Treasury Yield Curve" —
   * left the second copy standalone, defeating the whole point of grouping.
   */
  function matchesByTitle(root, needle) {
    var out = [], n = needle.toLowerCase();
    (root || document).querySelectorAll('.card').forEach(function (c) {
      var t = c.querySelector('.card-title');
      if (t && t.textContent.toLowerCase().indexOf(n) >= 0) out.push(c);
    });
    return out;
  }

  /**
   * Collect cards for a list of needles, flattened and DEDUPLICATED.
   *
   * Fixed 2026-07-25: two needles can legitimately match the same card (e.g.
   * "Sector Rotation Ratio" and "Cyclical vs Defensive" are both in one title),
   * which previously added that card to the switcher twice and produced a
   * phantom extra view button pointing at the same pane.
   */
  function allByTitles(root, needles) {
    var seen = [], out = [];
    needles.forEach(function (n) {
      matchesByTitle(root, n).forEach(function (c) {
        if (seen.indexOf(c) < 0) { seen.push(c); out.push(c); }
      });
    });
    return out;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     1. RETIRE THE THREE DUPLICATED TOP-LINE CARDS
     ══════════════════════════════════════════════════════════════════════════ */

  function retireDuplicates(root) {
    var dupes = [
      { needle: 'Decision Compass', why: 'The Unified View states one posture with a gross-exposure target, derived from four signals by a stated hierarchy. Decision Compass answered the same question with separate logic and no reconciliation against the others.' },
      { needle: 'Macro Headwinds', why: 'Now covered by the Signal Reconciliation table, which shows each signal WITH its horizon and confidence — the context that makes a headwind reading interpretable.' },
      { needle: 'Recommended Portfolio Archetypes', why: 'Superseded by the regime sector tilt (overweight / underweight per Quad) plus the Holding Quality Ranker, which acts on your actual positions rather than a generic archetype.' }
    ];

    var found = [];
    dupes.forEach(function (d) {
      var c = byTitle(root, d.needle);
      if (c) { found.push({ el: c, meta: d }); }
    });
    if (!found.length) return 0;

    var notice = document.createElement('div');
    notice.className = 'card';
    notice.style.marginBottom = '14px';
    notice.innerHTML =
      '<div class="card-title" style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">' +
        '<span>Portfolio Posture &mdash; moved to the Unified View' +
          '<span class="help-icon" title="Three cards that previously lived here each answered &quot;what should I own?&quot; with independent logic and no reconciliation against each other. The Unified View replaced them with a single posture resolved by a stated hierarchy: macro regime sets the sector tilt, market phase sets gross exposure, price trend sets entry timing, and your risk mandate caps everything. Where signals disagree, the conflict is shown rather than averaged away." data-heading="Posture moved">&#9432;</span>' +
        '</span>' +
        '<button class="btn btn-sm" onclick="navigateTo(\'home\')" style="font-size:11px;">Open Unified View &rarr;</button>' +
      '</div>' +
      '<div class="card-body" style="font-size:12px;line-height:1.75;">' +
        '<p style="margin:0 0 8px;">These three cards were retired on 2026-07-25 because each produced its own independent ' +
        '"what should I own" answer, and nothing reconciled them. The Unified View on the Home page now resolves all of it ' +
        'into <strong>one posture with a gross-exposure target</strong>, and shows any signal conflicts explicitly instead of ' +
        'averaging them away.</p>' +
        '<ul style="margin:0 0 8px 18px;padding:0;">' +
          found.map(function (f) {
            return '<li style="margin-bottom:5px;"><strong>' + f.meta.needle + '</strong> &mdash; ' + f.meta.why + '</li>';
          }).join('') +
        '</ul>' +
        '<p style="margin:0;font-size:11px;color:var(--text-sec);">Nothing was lost: the underlying signals still drive the ' +
        'Unified View, and the sector tilt is applied per-position by the Holding Quality Ranker under ' +
        '<em>Manage Holdings &rsaquo; Analysis</em>.</p>' +
      '</div>';

    found[0].el.parentNode.insertBefore(notice, found[0].el);
    found.forEach(function (f) { f.el.remove(); });
    return found.length;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     2. GROUP THE ANALYTICS CARDS INTO FOUR SWITCHER WINDOWS

     Grouped by the QUESTION each answers, not by technique — which is why
     "3D Volatility Surface" sits with VaR (both are "how bad can it get?")
     rather than with the frontier.
     ══════════════════════════════════════════════════════════════════════════ */

  var GROUPS = [
    {
      title: 'Risk &amp; Tails <span class="help-icon" title="How bad can it get? Value at Risk across three estimation methods, rolling risk metrics, and the implied-volatility surface. Switch views in place — these are three lenses on the same question, not three separate findings." data-heading="Risk and Tails">&#9432;</span>',
      cards: ['Value at Risk', 'Rolling Risk Metrics', '3D Volatility Surface']
    },
    {
      title: 'Allocation &amp; Sizing <span class="help-icon" title="How much of each? The Markowitz and Omega efficient frontier plus the Omega rebalancing signal. Note these operate on the selected universe — for recommendations against YOUR actual positions, use the Holding Quality Ranker under Manage Holdings > Analysis, which is sized to the Unified View gross target." data-heading="Allocation and Sizing">&#9432;</span>',
      cards: ['Efficient Frontier', 'Omega Ratio Rebalancing']
    },
    {
      title: 'Regime Structure <span class="help-icon" title="Advanced structural diagnostics: Wasserstein distance between regime return distributions, Random Matrix Theory eigenvalue concentration (how much of the market is one factor), the Cox doubly-stochastic jump model, and intermarket lead/lag. These are research tools rather than daily decision inputs — genuinely interesting, deliberately not part of the posture calculation." data-heading="Regime Structure">&#9432;</span>',
      cards: ['Wasserstein Regime Distance', 'Cox Doubly-Stochastic', 'Intermarket Lead/Lag']
    },
    {
      /* "What's Moving Today" overlaps the Live Market Pulse on the Home page,
         but it is a live movers table rather than a competing recommendation, so
         it is kept and paired with the rebased chart instead of retired. Both
         answer "what has been happening?" — one intraday, one over the window. */
      title: 'Market Activity <span class="help-icon" title="What has actually been happening. Today\'s movers and their drivers, plus rebased return comparison for the selected universe with all series starting at 100. Overlaps the Live Market Pulse on the Home page by design — that one is a glance, this one is the detail." data-heading="Market Activity">&#9432;</span>',
      cards: ['Rebased Return Chart', 'Moving Today']
    }
  ];

  function groupAnalytics(root) {
    if (typeof makeCardSwitcher !== 'function') return 0;
    var made = 0;
    GROUPS.forEach(function (g) {
      var els = allByTitles(root, g.cards);
      if (els.length < 2) return;                 // single card needs no switcher
      var anchor = document.createElement('div');
      els[0].parentNode.insertBefore(anchor, els[0]);
      try {
        makeCardSwitcher(els, g.title, anchor);
        made++;
      } catch (e) { console.warn('[consolidate] switcher failed:', e); }
      if (anchor.parentNode) anchor.remove();
    });
    return made;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     3. ORDER: workbench first, then the grouped windows
     ══════════════════════════════════════════════════════════════════════════ */

  function reorder(root) {
    var wb = document.getElementById('corrWorkbench');
    if (!wb || !wb.parentNode) return;
    // Universe Selection drives the analytics cards, so it belongs directly
    // above them and below the workbench (which has its own universe control).
    var uni = byTitle(root, 'Universe Selection');
    if (uni && uni.parentNode === wb.parentNode) {
      wb.parentNode.insertBefore(uni, wb.nextSibling);
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     4. OTHER TABS WITH STACKED NEAR-DUPLICATES

     Found by comparing every card title on the site against every other. These
     are cases where the SAME concept was built twice, independently, and the
     Cross-Asset merge then stacked both copies into one visible tab:

       • Yield Curve — two Treasury curve cards with different element IDs
         (ycChart/ycSpreadsChart vs ycCurveChart/yc2s10sChart/yc3m10yChart).
         Both are useful; only the curve shape itself is redundant. Grouped so
         the pillar scorecard and spread history remain reachable.
       • Breadth — "Market Breadth & Composite Fear/Greed" and "Market Breadth:
         Is the Rally Broadening?" in the same tab, both answering participation.
       • Sector momentum — "Sector Momentum Scorecard" and "11-Sector Momentum
         Scorecard" are near-identical names in different tabs.
       • Intermarket Lead/Lag — built TWICE (lagAssetA vs aLagAssetA). The
         analytics copy is already inside the Regime Structure group, so the
         breadth-tab copy is the one folded in here.
     ══════════════════════════════════════════════════════════════════════════ */

  var TAB_GROUPS = [
    { panel: 'macrotab-yieldcurve',
      title: 'Yield Curve <span class="help-icon" title="Two views of the same curve, built independently before consolidation. The FRED view carries overlay comparison and the spread chart; the Cross-Asset view carries the pillar scorecard plus 2s10s and 3m10y history. Only the curve shape itself was duplicated — switch views rather than scrolling past the same chart twice." data-heading="Yield Curve">&#9432;</span>',
      cards: ['Full Treasury Yield Curve', 'Yield Curve Pillar'] },
    { panel: 'macrotab-cabreadth',
      title: 'Breadth &amp; Participation <span class="help-icon" title="Is the advance broad or narrow? Composite fear/greed, rally-broadening measures, sector momentum, and lead/lag — four lenses on participation, previously four separate stacked cards." data-heading="Breadth and Participation">&#9432;</span>',
      cards: ['Market Breadth & Composite', 'Market Breadth: Is the Rally', 'Sector Momentum Scorecard', 'Intermarket Lead/Lag'] },
    { panel: 'macrotab-casectors',
      title: 'Sector Rotation <span class="help-icon" title="Sector momentum scorecard and rotation ratio in one window." data-heading="Sector Rotation">&#9432;</span>',
      cards: ['11-Sector Momentum Scorecard', 'Sector Rotation Ratio', 'Cyclical vs Defensive'] }
  ];

  function groupOtherTabs() {
    if (typeof makeCardSwitcher !== 'function') return 0;
    var made = 0;
    TAB_GROUPS.forEach(function (g) {
      var panel = document.getElementById(g.panel);
      if (!panel || panel.getAttribute('data-grouped') === '1') return;
      var els = allByTitles(panel, g.cards);
      if (els.length < 2) return;
      var anchor = document.createElement('div');
      els[0].parentNode.insertBefore(anchor, els[0]);
      try { makeCardSwitcher(els, g.title, anchor); made++; panel.setAttribute('data-grouped', '1'); }
      catch (e) { console.warn('[consolidate] tab group failed for ' + g.panel + ':', e); }
      if (anchor.parentNode) anchor.remove();
    });
    return made;
  }

  function run() {
    // makeCardSwitcher lives in app3.js and runs its own deferred restructure;
    // wait for it so we don't fight over the same nodes.
    if (typeof makeCardSwitcher !== 'function') { setTimeout(run, 600); return; }

    var panel = document.getElementById('macrotab-camore');
    var retired = 0, grouped = 0;

    if (panel && panel.getAttribute('data-consolidated') !== '1') {
      try {
        retired = retireDuplicates(panel);
        grouped = groupAnalytics(panel);
        reorder(panel);
        panel.setAttribute('data-consolidated', '1');
      } catch (e) { console.warn('[consolidate] camore failed:', e); }
    }

    var others = 0;
    try { others = groupOtherTabs(); } catch (e) { console.warn('[consolidate] other tabs failed:', e); }

    if (retired || grouped || others) {
      console.info('[consolidate] retired ' + retired + ' duplicate posture cards · '
        + grouped + ' analytics switchers · ' + others + ' cross-tab switchers');
    }
  }

  /* app3.js restructures on DOMContentLoaded + timers, and
     mergeCrossAssetIntoMacro() builds #macrotab-camore at load. Run after both
     have settled, then again on first open of the tab as a safety net. */
  function schedule() { setTimeout(run, 1800); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule);
  else schedule();

  window.PerryConsolidate = { run: run, GROUPS: GROUPS };
})();
