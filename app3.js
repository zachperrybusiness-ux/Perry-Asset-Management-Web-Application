// ═══════════════════════════════════════════════════════════════════
// PERRY ASSET MANAGEMENT — app3.js (round 6, 2026-07)
// Post-load module: account scoping dropdowns, worker-backed correlation,
// sector breadth cards + S&P bar flow, Themes page overview strip, and the
// Macro page 3-column overview + tab consolidations. Everything here is
// defensive (typeof/element checks) and runs after app.js + app2.js.
// ═══════════════════════════════════════════════════════════════════

// ── 0) Populate account dropdowns from holdings (repeats until data loads) ──
(function populateAccountSelectors() {
  var tries = 0;
  function fill() {
    tries++;
    var hs = window._holdings || [];
    if (!hs.length && tries < 60) { setTimeout(fill, 1000); return; }
    var accts = [];
    hs.forEach(function(h){ var a = h.accountType || 'Individual'; if (accts.indexOf(a) < 0) accts.push(a); });
    ['pfChartAccountSel', 'perfAccountSel'].forEach(function(id) {
      var sel = document.getElementById(id);
      if (!sel) return;
      var cur = sel.value;
      sel.innerHTML = '<option value="all">All Accounts (Aggregate)</option>'
        + accts.map(function(a){ return '<option value="' + a + '">' + a + '</option>'; }).join('');
      if (cur && (cur === 'all' || accts.indexOf(cur) >= 0)) sel.value = cur;
    });
    if (tries < 60) setTimeout(fill, 15000); // refresh as accounts change
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill);
  else fill();
})();

// ── 1) Risk correlation v3 — worker-computed, Firestore-persisted ──
var _riskCorrV3Chart = null;
async function renderRiskCorrV3(insightEl, canvasEl) {
  var hs = (window._holdings || []).filter(function(x){ return !['Cash','Money Market','CD','Bond Position'].includes(x.assetClass); });
  if (!hs.length) { if (insightEl) insightEl.innerHTML = '<span style="color:var(--text-sec);">Add holdings to compute portfolio-vs-market correlation.</span>'; return; }
  // Current-composition weights (top 15 by value)
  var byT = {};
  hs.forEach(function(x){ var t = String(x.ticker).toUpperCase(); byT[t] = (byT[t] || 0) + (x.currentPrice || x.costBasis || 0) * x.quantity; });
  var tks = Object.keys(byT).sort(function(a,b){ return byT[b] - byT[a]; }).slice(0, 15);
  var tot = tks.reduce(function(s,t){ return s + byT[t]; }, 0) || 1;
  var positions = tks.map(function(t){ return t + ':' + (byT[t] / tot).toFixed(4); }).join(',');

  function paint(d, fromCache) {
    if (!d || !d.labels || !d.labels.length) return false;
    var MO3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if (_riskCorrV3Chart) { try { _riskCorrV3Chart.destroy(); } catch(e) {} }
    _riskCorrV3Chart = new Chart(canvasEl.getContext('2d'), {
      type: 'line',
      data: { labels: d.labels, datasets: [
        { label: 'Correlation vs SPY', data: d.corrSpy, borderColor: C.navy, borderWidth: 2, pointRadius: 0, tension: 0.25, fill: false },
        { label: 'Correlation vs QQQ', data: d.corrQqq, borderColor: C.blue, borderWidth: 1.5, borderDash: [4,3], pointRadius: 0, tension: 0.25, fill: false }
      ]},
      options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'top', labels: { font: { size: 11 } } },
          tooltip: Object.assign({}, chartTooltip, { callbacks: { label: function(c){ return c.dataset.label + ': ' + (c.parsed.y != null ? c.parsed.y.toFixed(2) : '—'); } } }) },
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, font: { size: 10 }, callback: function(v){ var s = this.getLabelForValue(v) || ''; return s.length >= 7 ? MO3[parseInt(s.slice(5,7),10)-1] + " '" + s.slice(2,4) : s; } } },
                  y: { min: -0.2, max: 1, grid: chartGrid, ticks: { font: { size: 10 } } } } }
    });
    var ins = d.insight || {};
    function box(title, ret, alpha, n) {
      return '<div style="flex:1;min-width:190px;border:1px solid var(--border);border-radius:6px;padding:9px 13px;">'
        + '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;color:var(--text-sec);">' + title + '</div>'
        + '<div style="font-size:16px;font-weight:800;color:' + (ret != null && ret >= 0 ? 'var(--success)' : 'var(--danger)') + ';">' + (ret != null ? (ret >= 0 ? '+' : '') + ret.toFixed(1) + '% ann.' : '—') + '</div>'
        + '<div style="font-size:11px;color:var(--text-sec);">' + (alpha != null ? 'vs SPY same days: ' + (alpha >= 0 ? '+' : '') + alpha.toFixed(1) + 'pp · ' : '') + n + ' days</div></div>';
    }
    var verdict = (ins.hiPf != null && ins.loPf != null)
      ? (ins.loPf > ins.hiPf ? 'Your differentiated (lower-correlation) stretches have OUTPERFORMED your index-hugging stretches — the active bets are earning their risk.'
                              : 'Your index-hugging stretches have outperformed your differentiated ones — active bets have cost you money vs. simply holding the index.')
      : 'Not enough days in one regime for a fair split yet.';
    if (insightEl) insightEl.innerHTML =
      '<div style="margin-bottom:8px;">Current correlation vs SPY (rolling ' + d.window + '-day): <strong style="color:var(--navy);font-size:14px;">' + (d.current != null ? d.current.toFixed(2) : '—') + '</strong>'
      + (d.trend1m != null ? ' <span style="color:' + (d.trend1m >= 0 ? '#8B6914' : 'var(--success)') + ';font-weight:600;">(' + (d.trend1m >= 0 ? '▲ rising' : '▼ falling') + ' ' + Math.abs(d.trend1m).toFixed(2) + ' past month)</span>' : '')
      + (d.current != null && d.current > 0.9 ? ' — <span style="color:#8B6914;">effectively holding the index with extra steps.</span>' : '')
      + (fromCache ? ' <span style="font-size:10px;color:var(--text-sec);">(showing saved result — refreshing…)</span>' : '')
      + '</div>'
      + '<div style="display:flex;gap:10px;flex-wrap:wrap;">'
      + box('When correlation was HIGH (>0.80)', ins.hiPf, ins.hiPf != null && ins.hiSpy != null ? ins.hiPf - ins.hiSpy : null, ins.hiN || 0)
      + box('When correlation was LOWER (<0.80)', ins.loPf, ins.loPf != null && ins.loSpy != null ? ins.loPf - ins.loSpy : null, ins.loN || 0)
      + '</div>'
      + '<div style="font-size:11px;color:var(--text-sec);margin-top:6px;">' + verdict + ' <span style="opacity:.75;">Computed server-side; result stored permanently in your Firestore analytics.</span></div>';
    return true;
  }

  // Instant paint from the permanent Firestore record, then refresh live
  var painted = false;
  try {
    if (window._getAnalyticsCache) {
      var cached = await window._getAnalyticsCache('riskCorr', 999999);
      if (cached && cached.payload) painted = paint(cached.payload, true);
    }
  } catch(e) {}
  if (!painted && insightEl) insightEl.innerHTML = '<span class="spinner"></span> Computing on the data worker…';
  var r = await fetch(WORKER_URL + '/portfolio-correlation?positions=' + encodeURIComponent(positions));
  var d = await r.json();
  if (d.error) {
    if (!painted && insightEl) insightEl.innerHTML = '<span style="color:#8B6914;">' + d.error + '</span> <button class="btn btn-sm" onclick="renderRiskHeatmap()">Retry</button>';
    return;
  }
  paint(d, false);
  try { if (window._setAnalyticsCache) window._setAnalyticsCache('riskCorr', d); } catch(e) {}
}

// ── 2a) Trend-breadth cards on every Sectors & Stocks sub-tab ──
function renderSsBreadthCards(rows, title) {
  var host = document.getElementById('ssBreadthCards');
  if (!host || !rows || !rows.length) return;
  var trendable = rows.filter(function(r){ return r.above200dma != null; });
  var up = trendable.filter(function(r){ return r.above200dma; }).length;
  var breadth = trendable.length ? Math.round(up / trendable.length * 100) : null;
  var adv1w = rows.filter(function(r){ return r.chg1w != null && r.chg1w > 0; }).length;
  var have1w = rows.filter(function(r){ return r.chg1w != null; }).length;
  var m1 = rows.map(function(r){ return r.chg1m; }).filter(function(v){ return v != null; }).sort(function(a,b){ return a-b; });
  var med1m = m1.length ? m1[Math.floor(m1.length/2)] : null;
  var best = rows.slice().filter(function(r){ return r.chg1m != null; }).sort(function(a,b){ return b.chg1m-a.chg1m; })[0];
  var worst = rows.slice().filter(function(r){ return r.chg1m != null; }).sort(function(a,b){ return a.chg1m-b.chg1m; })[0];
  function card(label, val, sub, color) {
    return '<div style="flex:1;min-width:130px;background:#fff;border:1px solid var(--border);border-radius:6px;padding:9px 13px;text-align:center;">'
      + '<div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;color:var(--text-sec);">' + label + '</div>'
      + '<div style="font-size:19px;font-weight:800;color:' + (color || 'var(--navy)') + ';">' + val + '</div>'
      + (sub ? '<div style="font-size:10px;color:var(--text-sec);">' + sub + '</div>' : '') + '</div>';
  }
  var bColor = breadth == null ? 'var(--text-sec)' : breadth >= 60 ? 'var(--success)' : breadth <= 40 ? 'var(--danger)' : '#8B6914';
  host.innerHTML = '<div style="display:flex;gap:10px;flex-wrap:wrap;">'
    + card('Trend Breadth', breadth == null ? '—' : breadth + '%', 'above 200-day avg', bColor)
    + card('Advancing (1W)', have1w ? adv1w + ' / ' + have1w : '—', 'members up this week', have1w && adv1w/have1w >= 0.5 ? 'var(--success)' : 'var(--danger)')
    + card('Median 1M', med1m == null ? '—' : (med1m >= 0 ? '+' : '') + med1m.toFixed(1) + '%', 'typical member', med1m != null && med1m >= 0 ? 'var(--success)' : 'var(--danger)')
    + (best ? card('Hottest', best.ticker, (best.chg1m >= 0 ? '+' : '') + best.chg1m.toFixed(1) + '% 1M', 'var(--success)') : '')
    + (worst ? card('Coldest', worst.ticker, (worst.chg1m >= 0 ? '+' : '') + worst.chg1m.toFixed(1) + '% 1M', 'var(--danger)') : '')
    + '</div>';
}

// ── 2b) S&P sector money flow as SORTED BARS (lines were unreadable at 11) ──
var _ssFlowBarsChart = null;
async function renderSsFlowBars(cfg) {
  var card = document.getElementById('ssFlowCard');
  if (!card || !cfg) return;
  var ranges = [['1mo','1M'],['3mo','3M'],['6mo','6M'],['1y','1Y']];
  var btns = ranges.map(function(r){
    var active = window._flowRange === r[0];
    return '<button class="btn-outline btn-sm' + (active ? ' active' : '') + '" style="' + (active ? 'background:rgba(255,255,255,0.18);' : 'background:transparent;') + 'color:#fff;border-color:rgba(255,255,255,0.4);" onclick="ssFlowSetRange(\'' + r[0] + '\')">' + r[1] + '</button>';
  }).join('');
  card.innerHTML = '<div class="card" style="margin:0;">'
    + '<div class="card-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">'
    + '<span>' + cfg.title + ' <span class="help-icon" title="Each bar is the sector\'s total return over the selected window, sorted best to worst — the money flow at a glance. Green bars are attracting capital; red bars are bleeding it. Switch windows to see whether leadership is fresh (1M) or established (1Y)." data-heading="Sector Money Flow" style="font-size:11px;">ⓘ</span></span>'
    + '<span style="display:flex;gap:6px;">' + btns + '</span></div>'
    + '<div class="card-body"><div id="ssFlowNote" style="font-size:11.5px;color:var(--text-sec);margin-bottom:8px;"><span class="spinner"></span> Loading…</div>'
    + '<div class="chart-wrap" style="height:300px;"><canvas id="ssFlowChart"></canvas></div></div></div>';
  try {
    var days = { '1mo': 22, '3mo': 64, '6mo': 127, '1y': 253 }[window._flowRange] || 64;
    var HIST = await PerryData.getMany(cfg.syms, 4);
    var out = [];
    cfg.syms.forEach(function(s) {
      var h = HIST[s.toUpperCase()];
      if (!h || h.closes.length < 10) return;
      var cl = h.closes.slice(-days);
      if (cl.length < 2 || cl[0] <= 0) return;
      out.push({ etf: s, name: (cfg.names && cfg.names[s]) || s, v: +(((cl[cl.length-1] / cl[0]) - 1) * 100).toFixed(1), color: (cfg.colors && cfg.colors[s]) || C.navy });
    });
    if (!out.length) { document.getElementById('ssFlowNote').innerHTML = '<span style="color:var(--danger);">No history available.</span>'; return; }
    out.sort(function(a,b){ return b.v - a.v; });
    if (_ssFlowBarsChart) { try { _ssFlowBarsChart.destroy(); } catch(e) {} }
    _ssFlowBarsChart = new Chart(document.getElementById('ssFlowChart').getContext('2d'), {
      type: 'bar',
      data: { labels: out.map(function(o){ return o.name + ' (' + o.etf + ')'; }),
        datasets: [{ data: out.map(function(o){ return o.v; }), backgroundColor: out.map(function(o){ return o.v >= 0 ? 'rgba(46,125,82,0.75)' : 'rgba(139,42,42,0.75)'; }), borderRadius: 3 }] },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: Object.assign({}, chartTooltip, { callbacks: { label: function(c){ return (c.parsed.x >= 0 ? '+' : '') + c.parsed.x.toFixed(1) + '% over the window'; } } }) },
        scales: { x: { grid: chartGrid, ticks: { font: { size: 10 }, callback: function(v){ return (v >= 0 ? '+' : '') + v + '%'; } } },
                  y: { grid: { display: false }, ticks: { font: { size: 10.5 } } } } }
    });
    var top = out.slice(0, 3).map(function(o){ return '<strong style="color:var(--success);">' + o.etf + ' ' + (o.v >= 0 ? '+' : '') + o.v.toFixed(1) + '%</strong>'; }).join(' · ');
    var bot = out.slice(-2).map(function(o){ return '<strong style="color:var(--danger);">' + o.etf + ' ' + (o.v >= 0 ? '+' : '') + o.v.toFixed(1) + '%</strong>'; }).join(' · ');
    document.getElementById('ssFlowNote').innerHTML = 'Money is flowing INTO: ' + top + ' &nbsp;·&nbsp; OUT OF: ' + bot;
  } catch(e) {
    var n = document.getElementById('ssFlowNote');
    if (n) n.innerHTML = '<span style="color:var(--danger);">Flow chart failed: ' + e.message + '</span>';
  }
}

// ── 3) Portfolio Themes page — at-a-glance performance strip ──
(function themesPageStrip() {
  var tries = 0;
  async function build() {
    tries++;
    var page = document.getElementById('page-themes');
    if (!page) return;
    if (typeof PORTFOLIO_THEMES === 'undefined' || typeof WORKER_URL === 'undefined') { if (tries < 20) setTimeout(build, 800); return; }
    if (document.getElementById('themesGlanceStrip')) return;
    var selCard = page.querySelector('.card'); // Theme Selector card is first
    if (!selCard) { if (tries < 20) setTimeout(build, 800); return; }
    var strip = document.createElement('div');
    strip.id = 'themesGlanceStrip';
    strip.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-sec);"><span class="spinner"></span> Loading theme performance…</div>';
    selCard.parentNode.insertBefore(strip, selCard);
    try {
      // One snapshot call covers every constituent + benchmarks
      var themes = PORTFOLIO_THEMES.slice(0, 8).map(function(t){ return { name: t.name, desc: (t.description || '').replace(/&mdash;/g, '—').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), tickers: (t.tickers || []).slice(0, 5) }; });
      var syms = ['SPY','QQQ'];
      themes.forEach(function(t){ t.tickers.forEach(function(x){ if (syms.indexOf(x) < 0) syms.push(x); }); });
      var map = {};
      for (var ci = 0; ci < syms.length; ci += 44) {
        var chunk = syms.slice(ci, ci + 44);
        var r = await fetch(WORKER_URL + '/snapshot?symbols=' + encodeURIComponent(chunk.join(',')));
        var d = await r.json();
        (d.quotes || []).forEach(function(q){ map[q.ticker] = q; });
      }
      function basket(tickers, field) {
        var vals = tickers.map(function(t){ return map[t] && map[t][field]; }).filter(function(v){ return v != null; });
        return vals.length ? vals.reduce(function(s,v){ return s+v; }, 0) / vals.length : null;
      }
      var spy = map.SPY || {}, qqq = map.QQQ || {};
      var rows = themes.map(function(t) {
        return { name: t.name, desc: t.desc,
          m1: basket(t.tickers, 'chg1m'), m3: basket(t.tickers, 'chg3m'), m6: basket(t.tickers, 'chg6m'), y1: basket(t.tickers, 'chg1y'),
          vol: basket(t.tickers, 'vol30') };
      }).filter(function(r){ return r.m3 != null; });
      rows.sort(function(a,b){ return (b.m3 || -999) - (a.m3 || -999); });
      function pct(v){ return v == null ? '<span style="color:var(--text-sec);">—</span>' : '<span style="color:' + (v >= 0 ? 'var(--success)' : 'var(--danger)') + ';font-weight:700;font-family:monospace;">' + (v >= 0 ? '+' : '') + v.toFixed(1) + '%</span>'; }
      var cards = rows.map(function(r, i) {
        return '<div style="flex:1;min-width:220px;max-width:300px;background:#fff;border:1px solid var(--border);border-radius:6px;padding:10px 14px;' + (i === 0 ? 'box-shadow:inset 0 3px 0 var(--success);' : '') + '">'
          + '<div style="display:flex;justify-content:space-between;align-items:center;"><strong style="color:var(--navy);font-size:12.5px;">' + (i === 0 ? '🏆 ' : '') + r.name + '</strong><span class="help-icon" title="' + r.desc.replace(/"/g, '&quot;') + '" data-heading="' + r.name + '" style="font-size:11px;">ⓘ</span></div>'
          + '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin:7px 0 4px;font-size:11px;text-align:center;">'
          + '<div><div style="font-size:9px;color:var(--text-sec);">1M</div>' + pct(r.m1) + '</div>'
          + '<div><div style="font-size:9px;color:var(--text-sec);">3M</div>' + pct(r.m3) + '</div>'
          + '<div><div style="font-size:9px;color:var(--text-sec);">6M</div>' + pct(r.m6) + '</div>'
          + '<div><div style="font-size:9px;color:var(--text-sec);">12M</div>' + pct(r.y1) + '</div>'
          + '</div>'
          + '<div style="font-size:10px;color:var(--text-sec);">Ann. vol ' + (r.vol != null ? r.vol.toFixed(0) + '%' : '—') + ' · vs SPY 3M ' + pct(r.m3 != null && spy.chg3m != null ? r.m3 - spy.chg3m : null) + ' · vs QQQ 3M ' + pct(r.m3 != null && qqq.chg3m != null ? r.m3 - qqq.chg3m : null) + '</div>'
          + '</div>';
      }).join('');
      strip.innerHTML = '<div class="card" style="margin-bottom:14px;">'
        + '<div class="card-title">Themes at a Glance — ranked by 3-month return <span class="help-icon" title="Equal-weight basket of each theme\'s top constituents, refreshed from live market data. Returns over 1/3/6/12 months, 30-day annualized volatility, and excess return vs SPY and QQQ over 3 months. 🏆 marks the current leader. Use this to pick which theme to drill into below." data-heading="Themes at a Glance" style="font-size:11px;">ⓘ</span></div>'
        + '<div class="card-body" style="display:flex;gap:10px;flex-wrap:wrap;">' + cards + '</div>'
        + '<div class="card-sources"><strong>Method:</strong> equal-weight mean of each theme\'s top-5 constituents via the worker <code>/snapshot</code> batch (10-min cache). Benchmarks from the same call — one request, always consistent.</div></div>';
    } catch(e) {
      strip.innerHTML = '<div style="padding:10px;color:var(--danger);font-size:12px;">Theme glance failed: ' + e.message + '</div>';
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else setTimeout(build, 500);
})();

// ── 4) Generic in-place card switcher (breadth consolidations etc.) ──
function makeCardSwitcher(cardEls, title, anchorEl) {
  cardEls = cardEls.filter(Boolean);
  if (cardEls.length < 2 || !anchorEl || !anchorEl.parentNode) return;
  var host = document.createElement('div');
  host.className = 'card';
  var hdr = document.createElement('div');
  hdr.className = 'card-title';
  hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;';
  var btnWrap = document.createElement('span');
  btnWrap.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
  hdr.innerHTML = '<span>' + title + '</span>';
  hdr.appendChild(btnWrap);
  var body = document.createElement('div');
  body.className = 'card-body';
  body.style.padding = '10px 12px';
  host.appendChild(hdr); host.appendChild(body);
  anchorEl.parentNode.insertBefore(host, anchorEl);
  var panes = [];
  cardEls.forEach(function(el, i) {
    var pane = document.createElement('div');
    pane.style.display = i === 0 ? 'block' : 'none';
    body.appendChild(pane); pane.appendChild(el);
    el.style.marginBottom = '0';
    panes.push(pane);
    var t = el.querySelector('.card-title');
    var label = (t ? t.textContent : 'View ' + (i+1)).replace(/[ⓘ?·]/g, '').replace(/\d+\s/, '').replace(/\s+/g, ' ').trim().slice(0, 30);
    var b = document.createElement('button');
    b.className = 'tabview-btn' + (i === 0 ? ' active' : '');
    b.textContent = label;
    b.onclick = function() {
      panes.forEach(function(p, j){ p.style.display = j === i ? 'block' : 'none'; });
      btnWrap.querySelectorAll('.tabview-btn').forEach(function(x){ x.classList.remove('active'); });
      b.classList.add('active');
      setTimeout(function(){ window.dispatchEvent(new Event('resize')); }, 60);
    };
    btnWrap.appendChild(b);
  });
}
function findCardsByTitle(container, patterns) {
  var found = patterns.map(function(){ return null; });
  if (!container) return found;
  container.querySelectorAll('.card').forEach(function(c) {
    var t = c.querySelector('.card-title');
    if (!t) return;
    var txt = t.textContent.replace(/\s+/g, ' ');
    patterns.forEach(function(p, i){ if (!found[i] && p.test(txt)) found[i] = c; });
  });
  return found;
}

// ── 5) MACRO PAGE OVERVIEW v2 (round 7) — REFORMATTED, not relocated ──
// Each of the three boxes is BUILT from the underlying data as a compact,
// no-scroll summary. The old cards those summaries replace are hidden.
function _movQuadStatic(q) {
  var M = {
    'Q1': { label: 'Goldilocks', color: 'var(--success)', favor: 'Tech · Discretionary · Small-Cap · High-Yield', avoid: 'Defensives · Long Duration' },
    'Q2': { label: 'Overheat', color: '#8B6914', favor: 'Energy · Materials · Industrials · TIPS', avoid: 'Long Bonds · Growth Multiples' },
    'Q3': { label: 'Stagflation', color: 'var(--danger)', favor: 'Gold · Energy · Short-Duration Bonds', avoid: 'Tech · Duration · Credit' },
    'Q4': { label: 'Deflation / Recession', color: 'var(--blue)', favor: 'Treasuries · Utilities · Staples · Gold · Cash', avoid: 'Cyclicals · Credit · Small-Cap' }
  };
  return M[q] || M['Q1'];
}
(function macroOverviewV2() {
  var TR = 'padding:3px 8px;border-bottom:1px solid var(--border);';
  function rowKV(k, v, vColor) {
    return '<tr><td style="' + TR + 'font-weight:600;color:var(--text-sec);font-size:11px;white-space:nowrap;">' + k + '</td>'
      + '<td style="' + TR + 'text-align:right;font-weight:700;font-size:11.5px;color:' + (vColor || 'var(--navy)') + ';">' + v + '</td></tr>';
  }
  function buildCol1(d) {
    var body = document.getElementById('movCol1Body');
    if (!body || !d) return;
    var phaseColors = { 'Confirmed Expansion': 'var(--success)', 'Mid-Cycle': 'var(--navy)', 'Late Cycle / Transition': '#8B6914', 'Confirmed Contraction': 'var(--danger)' };
    var pc = phaseColors[d.phase] || 'var(--navy)';
    var rows = (d.pillarScores || []).map(function(p) {
      var c = p.score > 0 ? 'var(--success)' : p.score < 0 ? 'var(--danger)' : 'var(--text-sec)';
      var arrow = p.score > 0 ? '▲' : p.score < 0 ? '▼' : '●';
      return rowKV(p.name, arrow + ' ' + (p.score >= 0 ? '+' : '') + p.score + ' <span style="color:var(--text-sec);font-weight:400;">/ ' + p.count + '</span>', c);
    }).join('');
    body.innerHTML =
      '<div style="text-align:center;margin-bottom:8px;">'
      + '<span style="font-size:34px;font-weight:800;color:' + pc + ';line-height:1;">' + d.totalScore + '</span>'
      + '<span style="font-size:13px;color:var(--text-sec);"> / ' + d.maxScore + '</span>'
      + '<div style="font-size:14px;font-weight:800;color:' + pc + ';margin-top:2px;">' + d.phase + '</div>'
      + '<div style="font-size:10.5px;color:var(--text-sec);line-height:1.4;">' + (d.phaseDescription || '') + '</div>'
      + '</div>'
      + '<table style="width:100%;border-collapse:collapse;margin:0 auto;">' + rows + '</table>'
      + '<div style="font-size:9.5px;color:var(--text-sec);text-align:center;margin-top:6px;">24 FRED indicators · click any tab below for detail</div>';
  }
  function buildCol2(d) {
    var body = document.getElementById('movCol2Body');
    if (!body || !d) return;
    var q = null;
    try { if (typeof computeCurrentQuad === 'function') q = computeCurrentQuad(d); } catch(e) {}
    // Adopt the live canvas ONCE (renderQuadMap keeps drawing into it by id)
    var canvasWrap = document.getElementById('quadMapWrap');
    var slot = document.getElementById('movQuadCanvasSlot');
    if (!slot) {
      body.innerHTML = '<div id="movQuadCanvasSlot" style="height:210px;position:relative;margin-bottom:8px;"></div><div id="movQuadTable"></div>';
      slot = document.getElementById('movQuadCanvasSlot');
    }
    if (canvasWrap && canvasWrap.parentNode !== slot) { slot.appendChild(canvasWrap); canvasWrap.style.height = '100%'; }
    var tbl = document.getElementById('movQuadTable');
    if (tbl) {
      if (q) {
        var st = _movQuadStatic(q.quadNum ? 'Q' + String(q.quadNum).replace(/\D/g, '') : (q.quad || 'Q1'));
        var growthTxt = q.growthDir != null ? (q.growthDir > 0 ? '▲ Accelerating' : '▼ Slowing') : (q.growthLabel || '—');
        var inflTxt = q.inflDir != null ? (q.inflDir > 0 ? '▲ Accelerating' : '▼ Cooling') : (q.inflLabel || '—');
        tbl.innerHTML = '<table style="width:100%;border-collapse:collapse;margin:0 auto;">'
          + rowKV('Quadrant', (q.quadNum || '') + ' — ' + (q.quadLabel || st.label), st.color)
          + rowKV('Growth', growthTxt, q.growthDir > 0 ? 'var(--success)' : 'var(--danger)')
          + rowKV('Inflation', inflTxt, q.inflDir > 0 ? '#8B6914' : 'var(--success)')
          + rowKV('Favors', '<span style="font-weight:600;font-size:10.5px;">' + st.favor + '</span>', 'var(--success)')
          + rowKV('Avoid', '<span style="font-weight:600;font-size:10.5px;">' + st.avoid + '</span>', 'var(--danger)')
          + '</table>';
      } else {
        tbl.innerHTML = '<div style="font-size:11px;color:var(--text-sec);text-align:center;">Quadrant summary loads with FRED data…</div>';
      }
    }
    // Hide the verbose originals — their content now lives here + in the ⓘ
    var dashTab = document.getElementById('macrotab-dashboard');
    if (dashTab && typeof findCardsByTitle === 'function') {
      findCardsByTitle(dashTab, [/Quad Framework/i, /Current Regime Signal/i, /Quad Playbook Summary/i]).forEach(function(c){ if (c) c.style.display = 'none'; });
      var qw = dashTab.querySelector('.quad-map-wrap');
      if (qw) qw.style.display = 'none';
    }
  }
  function buildCol3() {
    var body = document.getElementById('movCol3Body');
    if (!body) return;
    var stateKey = window._briefingState || 'growth';
    var st = (typeof PS_STATES !== 'undefined' ? PS_STATES : []).find(function(s){ return s.key === stateKey; });
    if (!st) return;
    if (!document.getElementById('movStateBlock')) {
      body.innerHTML = '<div id="movStateBlock"></div><div id="movQtrSlot"></div>';
    }
    var blk = document.getElementById('movStateBlock');
    if (blk) {
      blk.innerHTML =
        '<div style="text-align:center;margin-bottom:8px;">'
        + '<span style="display:inline-block;background:' + st.color + ';color:#fff;font-size:14px;font-weight:800;padding:4px 16px;border-radius:14px;">' + st.name + '</span>'
        + '<div style="font-size:10.5px;color:var(--text-sec);margin-top:4px;line-height:1.4;">' + st.posture + '</div>'
        + '</div>'
        + '<table style="width:100%;border-collapse:collapse;margin:0 auto;">'
        + rowKV('Trigger', '<span style="font-weight:500;font-size:10px;white-space:normal;">' + st.trigger + '</span>')
        + rowKV('Instruments', '<span style="font-weight:500;font-size:10px;white-space:normal;">' + st.instruments + '</span>')
        + rowKV('Cash target', st.cash, st.color)
        + rowKV('Historical analogues', '<span style="font-weight:500;font-size:10px;white-space:normal;">' + st.historical + '</span>')
        + '</table>';
    }
    // Adopt the Quarterly Regime History block (compact) + hide the big cards
    var regimePanel = document.getElementById('catab-regime');
    if (regimePanel && typeof findCardsByTitle === 'function') {
      var picks = findCardsByTitle(regimePanel, [/Quarterly Regime History/i, /Current Market Regime/i, /Four Portfolio States/i]);
      var qtrSlot = document.getElementById('movQtrSlot');
      if (picks[0] && qtrSlot && picks[0].parentNode !== qtrSlot) { qtrSlot.appendChild(picks[0]); picks[0].classList.add('slim-pinned'); picks[0].style.margin = '8px 0 0'; }
      if (picks[1]) picks[1].style.display = 'none';   // summarized above
      if (picks[2]) picks[2].style.display = 'none';   // lives in the ⓘ hover
    }
  }
  var lastRendered = 0;
  function tick() {
    try {
      if (!document.getElementById('macroOverviewGrid')) return;   // grid built below
      var d = window._lastMacroData;
      if (d && Date.now() - lastRendered > 45000) {
        lastRendered = Date.now();
        buildCol1(d); buildCol2(d);
      }
      buildCol3._done = buildCol3._done || 0;
      if (Date.now() - buildCol3._done > 45000) { buildCol3._done = Date.now(); buildCol3(); }
    } catch(e) {}
    setTimeout(tick, 2500);
  }
  window._macroOverviewTick = tick;
})();

(function macroRound6() {
  function run() {
    try {
      if (document.getElementById('macroOverviewGrid')) return;
      var macroWrap = document.querySelector('#page-macro .content-wrap');
      var macroTabs = document.querySelector('#page-macro .pf-tabs');
      if (!macroWrap || !macroTabs) return;

      // 5a) Tab rename: Economic Cycle Breakdown → Economic
      var brBtn = macroTabs.querySelector('[data-macrotab="breakdown"]');
      if (brBtn) brBtn.textContent = 'Economic';

      // 5b) THREE-COLUMN OVERVIEW — compact shells; content rendered by
      // macroOverviewV2 from live data (no scroll, fixed heights)
      var grid = document.createElement('div');
      grid.id = 'macroOverviewGrid';
      grid.innerHTML =
        '<div class="card macro-ovr-col" id="movCol1"><div class="card-title" style="justify-content:center;text-align:center;display:block;">Macro Regime Verdict</div><div class="card-body" id="movCol1Body"><div style="text-align:center;color:var(--text-sec);font-size:11px;padding:20px;"><span class="spinner"></span> Loading FRED scorecard…</div></div></div>'
        + '<div class="card macro-ovr-col" id="movCol2"><div class="card-title" style="justify-content:center;text-align:center;display:block;">Quad Map <span class="help-icon" style="font-size:11px;" data-heading="Quad Framework — Quadrant Guide" title="Q1 Goldilocks (growth up, inflation down): best for equities — tech, discretionary, small caps, high yield. Q2 Overheat (growth up, inflation up): commodities and real assets lead — energy, materials, industrials, TIPS. Q3 Stagflation (growth down, inflation up): worst for most assets — gold, energy, short-duration bonds; avoid tech and long duration. Q4 Deflation/Recession (growth down, inflation down): long Treasuries and defensives lead — utilities, staples, gold, cash.">ⓘ</span></div><div class="card-body" id="movCol2Body"><div style="text-align:center;color:var(--text-sec);font-size:11px;padding:20px;"><span class="spinner"></span> Loading quad placement…</div></div></div>'
        + '<div class="card macro-ovr-col" id="movCol3"><div class="card-title" style="justify-content:center;text-align:center;display:block;">Market Regime <span class="help-icon" style="font-size:11px;" data-heading="The Four Portfolio States — Framework Reference" title="LEVERAGED: highest-conviction risk-on — major dip with VIX >30 and risk assets drastically discounted; deploy leveraged ETFs (TQQQ/SOXL/FNGU) with 0–10% cash. NON-LEVERED GROWTH: healthy uptrend, VIX 15–22; normal 1x index exposure with 10–30% dry powder. NEUTRAL: low-growth, elevated VIX, unclear direction; gold, defensives, diversifiers, 30%+ cash. POSITIONED FOR DRAWDOWN: market up 30–50% in under a year, complacent VIX; mostly cash, Treasuries, gold hedges.">ⓘ</span></div><div class="card-body" id="movCol3Body"><div style="text-align:center;color:var(--text-sec);font-size:11px;padding:20px;"><span class="spinner"></span> Loading regime state…</div></div></div>';
      macroWrap.insertBefore(grid, macroTabs);

      // The old full-width verdict banner is superseded by column 1
      var verdict = document.getElementById('macroRegimeVerdict');
      if (verdict) verdict.style.setProperty('display', 'none', 'important');

      // 5c) BUSINESS CYCLE: market-price lens first; duplicative charts hidden
      var bizTab = document.getElementById('macrotab-biz');
      var caBiz = document.getElementById('catab-bizycle');
      if (bizTab && caBiz) {
        var caHdr = null;
        bizTab.querySelectorAll('div').forEach(function(d){ if (!caHdr && /Business Cycle — Market-Price Lens/.test(d.textContent) && d.childElementCount === 0) caHdr = d; });
        bizTab.insertBefore(caBiz, bizTab.firstChild);
        if (caHdr) bizTab.insertBefore(caHdr, caBiz);
        findCardsByTitle(caBiz, [/Phase\s*&(amp;)?\s*Score History/i, /Pillar Score Breakdown/i]).forEach(function(c){ if (c) c.style.display = 'none'; });
      }

      // 5d) YIELD CURVE: cross-asset view + pillar scorecard first; CA's
      // duplicate full-curve chart hidden (FRED "Full Yield Curve" stays)
      var ycTab = document.getElementById('macrotab-yieldcurve');
      var caYc = document.getElementById('catab-yieldcurve');
      if (ycTab && caYc) {
        var ycHdr = null;
        ycTab.querySelectorAll('div').forEach(function(d){ if (!ycHdr && /Yield Curve — Cross-Asset View/.test(d.textContent) && d.childElementCount === 0) ycHdr = d; });
        ycTab.insertBefore(caYc, ycTab.firstChild);
        if (ycHdr) ycTab.insertBefore(ycHdr, caYc);
        findCardsByTitle(caYc, [/Full Treasury Yield Curve/i]).forEach(function(c){ if (c) c.style.display = 'none'; });
      }

      // 5e) BREADTH: rally card pinned; grouped switcher windows
      var caBr = document.getElementById('catab-breadth');
      if (caBr) {
        var picks = findCardsByTitle(caBr, [
          /Is the Rally Broadening/i,
          /Composite Fear\/Greed/i, /Sector Momentum Scorecard/i, /Asset Class Return Heatmap/i, /Intermarket Lead\/Lag/i,
          /Liquidity Moving/i, /Cross-Asset Regime Signals/i, /Quantamental Composite/i
        ]);
        var rally = picks[0];
        if (rally) caBr.insertBefore(rally, caBr.firstChild);
        var anchorEl = document.createElement('div');
        caBr.insertBefore(anchorEl, rally ? rally.nextSibling : caBr.firstChild);
        makeCardSwitcher([picks[1], picks[2], picks[3], picks[4]], 'Breadth & Momentum Explorer', anchorEl);
        var anchorEl2 = document.createElement('div');
        anchorEl.parentNode.insertBefore(anchorEl2, anchorEl.nextSibling);
        makeCardSwitcher([picks[5], picks[6], picks[7]], 'Additional Analysis — Liquidity · Regime Signals · Quantamental', anchorEl2);
      }

      // Start the live overview renderer
      if (typeof window._macroOverviewTick === 'function') window._macroOverviewTick();
    } catch(e) { console.warn('macro round7 restructure failed:', e); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();

// ── 6) PORTFOLIO PAGE: same consolidation treatment as the Macro page ──
// Every remaining multi-card sub-tab folds into one switcher window.
(function portfolioRound7() {
  function run() {
    try {
      if (typeof consolidateTabViews !== 'function') { setTimeout(run, 500); return; }
      // SNAPSHOT: keep the analytics rails + Portfolio Value chart pinned;
      // Holdings table and the Optimization engine become switcher views.
      consolidateTabViews('pftab-snapshot', 2, 'Portfolio Explorer',
        ['Holdings Table', 'Optimization — Regime & Risk-Profile Weights']);
      // THEMES sub-tab: three stacked cards → one window, three views.
      consolidateTabViews('pftab-themes', 0, 'Themes Workspace',
        ['Compare vs Theme Baskets', 'Theme Holdings', 'Create Custom Theme']);
      // CHARACTERISTICS: two cards → one window, two views.
      consolidateTabViews('pftab-characteristics', 0, 'Characteristics Explorer', null);
    } catch(e) { console.warn('portfolio round7 consolidation failed:', e); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function(){ setTimeout(run, 300); });
  else setTimeout(run, 300);
})();

// ═══════════════════════════════════════════════════════════════════
// 7) ROUND 9 — DETERMINISTIC single-window rebuild for the Portfolio
// Performance / Attribution / Risk sub-tabs. Unlike the previous patch
// approach, this gathers every element BY ID from wherever it currently
// sits, moves it into a brand-new single card (summary band on top,
// toggled panes below), then hides everything else in the tab. The
// visual outcome cannot depend on what earlier shims did or didn't do.
// A "v9" build tag renders in each header so a stale cached file is
// instantly recognizable.
// ═══════════════════════════════════════════════════════════════════
(function rebuildPortfolioTabsV9() {
  function topOf(el, tab) {           // el's ancestor that is a direct child of tab
    while (el && el.parentElement && el.parentElement !== tab) el = el.parentElement;
    return el && el.parentElement === tab ? el : null;
  }
  function grab(tab, id) {            // top-level block containing #id — or the element itself wherever it lives
    var el = document.getElementById(id);
    if (!el) return null;
    return topOf(el, tab) || el.closest('.card') || el;
  }
  function grabCardByTitle(scopeEl, re) {
    var cards = scopeEl.querySelectorAll('.card');
    for (var i = 0; i < cards.length; i++) {
      var t = cards[i].querySelector('.card-title');
      if (t && re.test(t.textContent)) return cards[i];
    }
    return null;
  }
  function build(tabId, title, bandParts, panes) {
    var tab = document.getElementById(tabId);
    if (!tab || tab.dataset.r9) return;
    tab.dataset.r9 = '1';
    var card = document.createElement('div');
    card.className = 'card r9-window';
    var hdr = document.createElement('div');
    hdr.className = 'card-title';
    hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;';
    hdr.innerHTML = '<span>' + title + ' <span style="font-size:8px;opacity:.55;font-weight:400;">v9</span></span>';
    var btnWrap = document.createElement('span');
    btnWrap.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
    hdr.appendChild(btnWrap);
    var body = document.createElement('div');
    body.className = 'card-body';
    body.style.padding = '12px 14px';
    card.appendChild(hdr); card.appendChild(body);

    // Summary band — always visible
    var band = document.createElement('div');
    band.className = 'explorer-summary-band';
    body.appendChild(band);
    bandParts.forEach(function(el) { if (el) { band.appendChild(el); el.classList.add('band-item'); el.style.display = ''; } });

    // Toggled panes
    var paneEls = [];
    panes.forEach(function(p, i) {
      if (!p.el) return;
      var pane = document.createElement('div');
      pane.style.display = paneEls.length === 0 ? 'block' : 'none';
      body.appendChild(pane); pane.appendChild(p.el);
      p.el.style.display = ''; p.el.style.marginBottom = '0';
      paneEls.push(pane);
      var b = document.createElement('button');
      b.className = 'tabview-btn' + (paneEls.length === 1 ? ' active' : '');
      b.textContent = p.label;
      (function(idx) {
        b.onclick = function() {
          paneEls.forEach(function(x, j){ x.style.display = j === idx ? 'block' : 'none'; });
          btnWrap.querySelectorAll('.tabview-btn').forEach(function(x){ x.classList.remove('active'); });
          b.classList.add('active');
          setTimeout(function(){ window.dispatchEvent(new Event('resize')); }, 60);
        };
      })(paneEls.length - 1);
      btnWrap.appendChild(b);
    });

    tab.appendChild(card);
    // Decisive: hide EVERYTHING else at the top level — all value has been
    // moved into the new window, leftovers are empty husks from old shims.
    Array.prototype.slice.call(tab.children).forEach(function(c) {
      if (c !== card && c.nodeType === 1) c.style.display = 'none';
    });
  }
  function run() {
    var tab, ok = true;
    try {
      // ── PERFORMANCE ──
      tab = document.getElementById('pftab-performance');
      if (tab && !tab.dataset.r9 && document.getElementById('perfKPIBar')) {
        build('pftab-performance', 'Performance',
          [ grab(tab, 'perfAccountSel') || grab(tab, 'perfTimeframeBtns'),
            document.getElementById('perfKPIBar'),
            document.getElementById('perfSummaryCard'),
            (function(){ var e = document.getElementById('perfBenchScorecard'); return e ? (e.closest('.card') || e) : null; })() ],
          [ { el: (function(){ var e = document.getElementById('perfCumulChart'); return e ? (e.closest('.grid-2') || e.closest('.card')) : null; })(), label: 'Returns vs Benchmarks' },
            { el: (function(){ var e = document.getElementById('perfCalYearChart'); return e ? (e.closest('.grid-2') || e.closest('.card')) : null; })(), label: 'Calendar & Distribution' },
            { el: (function(){ var e = document.getElementById('perfBestWorstTable'); return e ? e.closest('.card') : null; })(), label: 'Best & Worst' },
            { el: (function(){ var e = document.getElementById('perfUnderwaterChart'); return e ? e.closest('.card') : null; })(), label: 'Drawdown' },
            { el: (function(){ var e = document.getElementById('perfMonthlyHeatmap'); return e ? e.closest('.card') : null; })(), label: 'Monthly Heatmap' } ]);
      }
      // ── ATTRIBUTION ──
      tab = document.getElementById('pftab-attribution');
      if (tab && !tab.dataset.r9 && document.getElementById('attrContribCards')) {
        build('pftab-attribution', 'Attribution',
          [ (function(){ var e = document.getElementById('attrAccountFilter'); return e ? (e.closest('.card') || e) : null; })(),
            document.getElementById('attrContribCards'),
            document.getElementById('attrInsightCard') ],
          [ { el: grabCardByTitle(tab, /Brinson/i), label: 'Brinson-Fachler' },
            { el: (function(){ var e = document.getElementById('attrContribChart'); return e ? e.closest('.card') : null; })(), label: 'Contribution by Holding' },
            { el: (function(){ var e = document.getElementById('attrSectorTable'); return e ? e.closest('.card') : null; })(), label: 'Sector Attribution' } ]);
      }
      // ── RISK ──
      tab = document.getElementById('pftab-risk');
      if (tab && !tab.dataset.r9 && document.getElementById('kpiVaR95')) {
        build('pftab-risk', 'Risk',
          [ topOf(document.getElementById('kpiVaR95'), tab) || (function(){ var e = document.getElementById('kpiVaR95'); return e ? e.parentElement.parentElement : null; })(),
            (function(){ var e = document.getElementById('factorRiskBox'); return e ? (e.closest('.card') || e) : null; })(),
            (function(){ var e = document.getElementById('riskMetricsDetail'); return e ? (e.closest('.card') || e) : null; })() ],
          [ { el: (function(){ var e = document.getElementById('mvarTable'); return e ? e.closest('.card') : null; })(), label: 'Marginal VaR' },
            { el: (function(){ var e = document.getElementById('riskFactorChart'); return e ? e.closest('.card') : null; })(), label: 'Factor Attribution' },
            { el: (function(){ var e = document.getElementById('riskCorrChart'); return e ? e.closest('.card') : null; })(), label: 'Correlation Over Time' } ]);
      }
      ok = !!(document.getElementById('pftab-performance') || {}).dataset;
    } catch(e) { console.warn('r9 rebuild:', e); }
    // Retry while the app boots (elements appear as data loads)
    if ((!document.getElementById('pftab-performance') || !document.getElementById('pftab-performance').dataset.r9) && (window._r9Tries = (window._r9Tries || 0) + 1) < 30) setTimeout(run, 700);
  }
  console.log('[Perry] app3 build v9 loaded — portfolio single-window rebuild active');
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function(){ setTimeout(run, 400); });
  else setTimeout(run, 400);
})();

// ═══════════════════════════════════════════════════════════════════
// 8) ROUND 10 — PILLAR OVERVIEW strip (replaces the "Macro Regime
// Verdict" banner, which duplicated the left overview column). One row,
// same footprint: the composite score of EVERY sub-tab — Business Cycle,
// Economic, Yield Curve, Breadth, Credit, Cross-Asset Momentum, Sector
// Rotation — each clickable to jump to its tab. Scores come from the
// cross-asset pillar engine (auto-triggered) and the FRED breakdown.
// ═══════════════════════════════════════════════════════════════════
(function macroPillarOverview() {
  var TABMAP = {
    'Business Cycle': 'biz', 'Economic': 'breakdown', 'Yield Curve': 'yieldcurve',
    'Breadth': 'cabreadth', 'Credit': 'cacredit', 'Cross-Asset Momentum': 'camomentum', 'Sector Rotation': 'casectors'
  };
  var PILLAR_SRC = {  // display name → _tlPillars name
    'Business Cycle': 'Business Cycle', 'Yield Curve': 'Yield Curve', 'Breadth': 'Breadth (Fear/Greed)',
    'Credit': 'Credit Conditions', 'Cross-Asset Momentum': 'Cross-Asset Momentum', 'Sector Rotation': 'Sector Rotation'
  };
  function scoreColor(s) { return s == null ? 'var(--text-sec)' : s >= 65 ? 'var(--success)' : s >= 45 ? 'var(--navy)' : s >= 30 ? '#8B6914' : 'var(--danger)'; }
  function scoreWord(s)  { return s == null ? 'loading' : s >= 65 ? 'Bullish' : s >= 45 ? 'Neutral+' : s >= 30 ? 'Caution' : 'Bearish'; }
  function economicScore() {
    var d = window._breakdownData;
    if (!d || !d.categories) return null;
    var pos = 0, tot = 0;
    d.categories.forEach(function(cat) {
      (cat.indicators || []).forEach(function(ind) {
        if (!ind.phase || ind.phase === 'N/A') return;
        tot++;
        if (ind.phase === 'Expansion' || ind.phase === 'Recovery') pos++;
        else if (ind.phase === 'Neutral') pos += 0.5;
      });
    });
    return tot ? Math.round(pos / tot * 100) : null;
  }
  function render() {
    var host = document.getElementById('macroPillarOverview');
    if (!host) return;
    var tl = {};
    (window._tlPillars || []).forEach(function(p){ tl[p.name] = p; });
    var cards = Object.keys(TABMAP).map(function(name) {
      var s = null, lbl = '';
      if (name === 'Economic') { s = economicScore(); lbl = s != null ? (s >= 55 ? 'Expanding' : s >= 40 ? 'Mixed' : 'Contracting') : ''; }
      else { var p = tl[PILLAR_SRC[name]]; if (p && p.score != null) { s = Math.round(p.score); lbl = p.label || p.detail || ''; } }
      var c = scoreColor(s);
      return '<div onclick="macroShowTab(\'' + TABMAP[name] + '\')" title="Open the ' + name + ' tab" '
        + 'style="flex:1;min-width:105px;background:#fff;border:1px solid var(--border);border-top:3px solid ' + c + ';border-radius:6px;padding:7px 8px;text-align:center;cursor:pointer;">'
        + '<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text-sec);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + name + '</div>'
        + '<div style="font-size:22px;font-weight:800;color:' + c + ';line-height:1.15;">' + (s != null ? s : '—') + '</div>'
        + '<div style="font-size:9px;color:' + c + ';font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + (String(lbl).slice(0, 18) || scoreWord(s)) + '</div>'
        + '</div>';
    }).join('');
    var comp = window._tlComposite;
    host.innerHTML = '<div class="card" style="margin:0 16px 12px;">'
      + '<div class="card-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">'
      + '<span>Overview — Composite Scores by Pillar <span class="help-icon" title="Each card is the 0–100 composite score of one analysis tab, computed from its live indicators (65+ bullish · 45–64 neutral · 30–44 caution · below 30 bearish). Economic = share of FRED cycle indicators in Expansion/Recovery. Click any card to open its tab for the full detail." data-heading="Pillar Overview" style="font-size:11px;">ⓘ</span></span>'
      + (comp != null ? '<span style="font-size:11px;font-weight:600;color:rgba(255,255,255,0.85);">Master composite: <strong style="font-size:14px;color:' + (comp >= 65 ? '#7BE2A8' : comp >= 45 ? '#A8C8E8' : comp >= 30 ? '#F0CE7D' : '#F1948A') + ';">' + Math.round(comp) + '</strong> / 100</span>' : '')
      + '</div>'
      + '<div class="card-body" style="padding:9px 12px;"><div style="display:flex;gap:8px;flex-wrap:wrap;">' + cards + '</div></div>'
      + '</div>';
  }
  var booted = false;
  function tick() {
    var macroWrap = document.querySelector('#page-macro .content-wrap');
    var grid = document.getElementById('macroOverviewGrid');
    if (macroWrap && grid && !document.getElementById('macroPillarOverview')) {
      var host = document.createElement('div');
      host.id = 'macroPillarOverview';
      macroWrap.insertBefore(host, grid);
    }
    var onMacro = document.getElementById('page-macro') && document.getElementById('page-macro').classList.contains('active');
    if (onMacro && !booted) {
      booted = true;
      // Fire the engines that produce the scores (each has its own dedupe)
      try { if (!window._tlPillars && typeof topLineRefreshAll === 'function') topLineRefreshAll(); } catch(e) {}
      try { if (!window._breakdownData && typeof regimeLoadBreakdown === 'function') regimeLoadBreakdown(); } catch(e) {}
    }
    if (document.getElementById('macroPillarOverview')) render();
    setTimeout(tick, 3000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function(){ setTimeout(tick, 500); });
  else setTimeout(tick, 500);
})();
