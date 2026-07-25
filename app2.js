// ═══════════════════════════════════════════════════════════════════
// ══════════  MORNING BRIEFING ENGINE  ══════════════════════════════
// ═══════════════════════════════════════════════════════════════════
async function briefingLoad(force) {
  // Skip refetch if loaded < 5 minutes ago (unless explicit refresh via button)
  var BRIEFING_TTL_MS = 5 * 60 * 1000;
  if (!force && window._briefingLastLoaded && (Date.now() - window._briefingLastLoaded) < BRIEFING_TTL_MS) {
    return;
  }
  window._briefingLastLoaded = Date.now();
  document.getElementById('briefingDate').textContent = new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  var WORKER = 'https://perry-finance-proxy.zachperrybusiness.workers.dev';
  // ── Pulse row (live quotes) ──
  var pulseTickets = [
    {sym:'SPY',label:'S&P 500'},{sym:'QQQ',label:'NASDAQ 100'},
    {sym:'%5EVIX',label:'VIX'},{sym:'GLD',label:'Gold'},{sym:'BTC-USD',label:'Bitcoin'}
  ];
  var pulseEl = document.getElementById('briefingPulse');
  pulseEl.innerHTML = pulseTickets.map(function(t){ return '<div class="briefing-pulse-card"><div class="briefing-pulse-ticker">'+t.label+'</div><div class="briefing-pulse-price" id="bp_'+t.sym+'"><span class="spinner" style="width:12px;height:12px;"></span></div><div class="briefing-pulse-chg" id="bpc_'+t.sym+'">—</div></div>'; }).join('');
  pulseTickets.forEach(async function(t){
    try {
      var r = await fetch(WORKER+'/quote?symbol='+encodeURIComponent(t.sym.replace('%5E','^')));
      var d = await r.json();
      var px = d.current || d.price || 0;
      var chg = d.changePercent || 0;
      var col = chg >= 0 ? C.success : C.danger;
      var el = document.getElementById('bp_'+t.sym);
      var cel = document.getElementById('bpc_'+t.sym);
      if(el) el.textContent = px >= 1000 ? '$'+px.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : px < 10 ? px.toFixed(2) : '$'+px.toFixed(2);
      if(cel){ cel.textContent = (chg>=0?'+':'')+chg.toFixed(2)+'%'; cel.style.color = col; }
    } catch(e) {}
  });

  // ── Regime banner (reuse psClassifyState) ──
  var regimeEl = document.getElementById('briefingRegime');
  try {
    var [spyR, vixR, qqqR] = await Promise.all([
      fetch(WORKER+'/chart?symbol=SPY&range=1y&interval=1d').then(function(r){return r.json();}),
      fetch(WORKER+'/quote?symbol=%5EVIX').then(function(r){return r.json();}),
      fetch(WORKER+'/quote?symbol=QQQ').then(function(r){return r.json();})
    ]);
    var spyPts = (spyR.points||[]).filter(function(p){return p.close!=null;});
    if(spyPts.length >= 2) {
      var closes = spyPts.map(function(p){return p.close;});
      var spy12mHigh = Math.max.apply(null,closes), spy12mLow = Math.min.apply(null,closes);
      var spyCur = closes[closes.length-1], spyStart = closes[0];
      var signals = { vix: vixR.current||vixR.price||null, spyTrailingReturn:(spyCur-spyStart)/spyStart, drawdownFromPeak:(spyCur-spy12mHigh)/spy12mHigh, spy12mFromLow:(spyCur-spy12mLow)/spy12mLow };
      var cl = psClassifyState(signals);
      // Prefer quarterly-locked regime (computed by loadQuarterlyRegimes) when available.
      // This keeps the morning briefing's state stable across the quarter.
      try {
        if (!window._quarterlyRegimes) await loadQuarterlyRegimes();
      } catch(e) { /* fall back to daily */ }
      var lockedKey = (window._quarterlyRegimes && window._quarterlyRegimes.quarterly && window._quarterlyRegimes.quarterly.length)
        ? window._quarterlyRegimes.quarterly[window._quarterlyRegimes.quarterly.length - 1].regime
        : cl.winner;
      window._briefingState = lockedKey;
      var st = PS_STATES.find(function(s){return s.key===lockedKey;}) || PS_STATES[1];
      var qqqPx = qqqR.current || qqqR.price || 0;
      regimeEl.innerHTML = '<div class="briefing-regime-hero" style="background:'+st.color+';border-radius:4px;">'
        + '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;">'
        + '<div><div style="font-size:11px;opacity:.8;text-transform:uppercase;letter-spacing:.6px;">Current Portfolio State</div>'
        + '<div style="font-size:26px;font-weight:800;margin:3px 0;">'+st.name+'</div>'
        + '<div style="font-size:11px;opacity:.8;">Confidence: '+cl.confidence.toFixed(0)+'% &middot; '+cl.reasons.join(' &middot; ')+'</div>'
        + '<div style="margin-top:8px;font-size:12px;background:rgba(0,0,0,.2);padding:8px 12px;border-radius:3px;">'
        + '<strong>Posture:</strong> '+st.posture+' &nbsp;<strong>Cash:</strong> '+st.cash+'</div>'
        + '</div>'
        + '<div style="text-align:right;font-size:12px;opacity:.9;">'
        + '<div>SPY: $'+spyCur.toFixed(2)+' ('+(signals.spyTrailingReturn*100>=0?'+':'')+(signals.spyTrailingReturn*100).toFixed(1)+'% 12M)</div>'
        + '<div>QQQ: $'+qqqPx.toFixed(2)+'</div>'
        + '<div>VIX: '+(signals.vix!=null?signals.vix.toFixed(1):'—')+'</div>'
        + '</div></div></div>';
      // trigger regime audit now that state is known
      if(window._holdings && window._holdings.length && typeof renderPortfolioTable === 'function'){
        // Re-render holdings table now that regime state is known so Regime Fit column shows
        var portfolioTotal = window._holdings.reduce(function(s, h){
          var isCashH = h.assetClass === 'Cash' || h.assetClass === 'Money Market' || h.assetClass === 'CD' || h.assetClass === 'Bond Position';
          return s + (isCashH ? h.costBasis * h.quantity : (h.currentPrice || 0) * h.quantity);
        }, 0);
        renderPortfolioTable(window._holdings, portfolioTotal);
      }
    }
  } catch(e){ regimeEl.innerHTML='<div style="padding:14px;color:var(--danger);">Failed to load regime data: '+e.message+'</div>'; }

  // ── Portfolio snapshot ──
  var pfEl = document.getElementById('briefingPortfolio');
  var h = window._holdings || [];
  if(!h.length){ pfEl.innerHTML='<div style="font-size:12px;color:var(--text-sec);padding:10px 0;">Sign in and add holdings to see your portfolio snapshot here.</div>'; }
  else {
    var tv=0,tc=0;
    h.forEach(function(x){
      var isCash=x.assetClass==='Cash'||x.assetClass==='Money Market'||x.assetClass==='CD'||x.assetClass==='Bond Position';
      tv += isCash ? (x.costBasis||0)*x.quantity : (x.currentPrice||0)*x.quantity;
      tc += (x.costBasis||0)*x.quantity;
    });
    var gl=tv-tc, glp=tc>0?(gl/tc)*100:0;
    var topHolder = h.filter(function(x){var isCash=x.assetClass==='Cash'||x.assetClass==='Money Market';return !isCash;}).sort(function(a,b){return (b.currentPrice||0)*b.quantity-(a.currentPrice||0)*a.quantity;})[0];
    pfEl.innerHTML='<div class="briefing-portfolio-snap">'
      + '<div class="briefing-pf-card"><div class="briefing-pf-label">Total Value</div><div class="briefing-pf-value">'+fmtInt(tv)+'</div><div class="briefing-pf-sub" style="color:'+pctColor(glp)+'">'+(glp>=0?'+':'')+glp.toFixed(1)+'% all-time</div></div>'
      + '<div class="briefing-pf-card"><div class="briefing-pf-label">Total G/L</div><div class="briefing-pf-value" style="color:'+pctColor(gl)+'">'+(gl>=0?'+':'')+fmt(gl)+'</div><div class="briefing-pf-sub">vs cost basis '+fmt(tc)+'</div></div>'
      + '<div class="briefing-pf-card"><div class="briefing-pf-label">Positions</div><div class="briefing-pf-value">'+h.length+'</div><div class="briefing-pf-sub">across all accounts</div></div>'
      + (topHolder?'<div class="briefing-pf-card"><div class="briefing-pf-label">Largest Position</div><div class="briefing-pf-value">'+topHolder.ticker+'</div><div class="briefing-pf-sub">'+fmt((topHolder.currentPrice||0)*topHolder.quantity)+'</div></div>':'')
      + '</div>';
  }

  // ── Macro snapshot (pull from _lastMacroData if available) ──
  var macroEl = document.getElementById('briefingMacroSnap');
  if(window._lastMacroData) {
    var d = window._lastMacroData;
    var rows = (d.pillarScores||[]).slice(0,6).map(function(p){
      var pct = Math.round(((p.score+p.count)/(p.count*2))*100);
      var col = pct>=60?C.success:pct>=40?C.warning:C.danger;
      return '<div class="briefing-macro-row"><span>'+p.name+'</span><span style="font-weight:700;color:'+col+';">'+(p.score>=0?'+':'')+p.score+'/'+p.count+'</span></div>';
    }).join('');
    var phase=d.phase||'—', total=d.totalScore, max=d.maxScore;
    macroEl.innerHTML='<div style="font-size:12px;font-weight:700;color:var(--navy);margin-bottom:6px;">Phase: '+phase+' ('+total+'/'+max+')</div>'+rows
      +'<div style="margin-top:8px;"><button class="btn btn-sm" onclick="navigateTo(\'macro\');loadMacroLiveTable(true)">Full Scorecard →</button></div>';
  } else {
    macroEl.innerHTML='<div style="text-align:center;padding:10px;color:var(--text-sec);font-size:12px;">Navigate to <button class="btn btn-sm" onclick="navigateTo(\'macro\')">Macro Regime Analysis</button> first to load scorecard data, then return here.</div>';
  }

  // ── Economic calendar ──
  var calEl = document.getElementById('briefingCalendar');
  var today = new Date(); var dom = today.getDate(); var dow = today.getDay(); // 0=Sun
  var releases = [
    {name:'ISM Manufacturing PMI',note:'1st business day',impact:'High'},
    {name:'Nonfarm Payrolls / Unemployment',note:'First Friday',impact:'Very High'},
    {name:'CPI Headline & Core',note:'~10th of month',impact:'Very High'},
    {name:'PPI Final Demand',note:'~11th of month',impact:'High'},
    {name:'Retail Sales',note:'~15th of month',impact:'High'},
    {name:'PCE / Core PCE',note:'Last business day',impact:'Very High'},
    {name:'FOMC Decision',note:'8x per year',impact:'Very High'},
    {name:'Initial Jobless Claims',note:'Every Thursday',impact:'Medium'},
  ];
  var impactColor = {'Very High':C.danger,'High':C.warning,'Medium':C.navy,'Low':C.textSec};
  calEl.innerHTML = releases.slice(0,5).map(function(r){
    var ic = impactColor[r.impact]||C.textSec;
    return '<div class="briefing-cal-row">'
      +'<span class="briefing-cal-name">'+r.name+'</span>'
      +'<span class="briefing-cal-meta">'+r.note+'</span>'
      +'<span class="briefing-cal-impact" style="background:'+ic+';color:#fff;">'+r.impact+'</span>'
      +'</div>';
  }).join('');
}

// Auto-run briefingLoad on DOMContentLoaded and on every home visit
(function() {
  document.addEventListener('DOMContentLoaded', function() {
    // Event delegation for timeframe buttons — survives DOM re-renders
    document.addEventListener('click', function(e) {
      var btn = e.target.closest && e.target.closest('#pfTimeframeBtns .btn-outline');
      if (!btn || !btn.dataset || !btn.dataset.range) return;
      document.querySelectorAll('#pfTimeframeBtns .btn-outline').forEach(function(b) {
        b.classList.remove('active');
      });
      btn.classList.add('active');
      currentRange = btn.dataset.range;
      if (typeof renderPortfolioChart === 'function') renderPortfolioChart();
    });

    // Small delay to let Firebase auth initialize
    setTimeout(function() {
      if (typeof briefingLoad === 'function') briefingLoad();
    }, 800);
  });
})();

// ═══════════════════════════════════════════════════════════════════
// ════════  REGIME-AWARE ALLOCATION AUDIT  ══════════════════════════
// ═══════════════════════════════════════════════════════════════════

// Maps ticker patterns to which states they're appropriate for
var REGIME_FIT_DB = {
  // Leveraged — only fits Leveraged state
  'TQQQ':['leveraged'],'SOXL':['leveraged'],'FNGU':['leveraged'],'UPRO':['leveraged'],
  'SPXL':['leveraged'],'TECL':['leveraged'],'LABU':['leveraged'],'UDOW':['leveraged'],
  'BTC-USD':['leveraged'],'ETH-USD':['leveraged'],'IBIT':['leveraged'],'ETHA':['leveraged'],
  // Non-levered growth — fits growth and leveraged
  'QQQ':['leveraged','growth'],'SPY':['leveraged','growth'],'IWM':['leveraged','growth'],
  'DIA':['leveraged','growth'],'VOO':['leveraged','growth'],'VTI':['leveraged','growth'],
  'VGT':['leveraged','growth'],'XLK':['leveraged','growth'],'ARKK':['leveraged','growth'],
  'NVDA':['leveraged','growth'],'AAPL':['growth','neutral'],'MSFT':['growth','neutral'],
  'AMZN':['growth'],'GOOGL':['growth'],'META':['growth'],
  // Neutral/safe — fits neutral and drawdown
  'GLD':['neutral','drawdown'],'SLV':['neutral','drawdown'],'IAU':['neutral','drawdown'],
  'GDX':['neutral','drawdown'],'GDXJ':['neutral','drawdown'],
  'TLT':['neutral','drawdown'],'IEF':['neutral','drawdown'],'SHV':['neutral','drawdown'],
  'BND':['neutral','drawdown'],'AGG':['neutral','drawdown'],
  'XLU':['neutral','drawdown'],'XLP':['neutral','drawdown'],'XLV':['neutral','drawdown'],
  'VNQ':['neutral'],'EFA':['neutral'],'EEM':['neutral'],
  // Cash — fits neutral and drawdown
  'CASH':['neutral','drawdown'],'CD':['neutral','drawdown'],'BOND':['neutral','drawdown'],
  'SPAXX':['neutral','drawdown'],'FDRXX':['neutral','drawdown'],'FZFXX':['neutral','drawdown'],
  'SPRXX':['neutral','drawdown'],'VMFXX':['neutral','drawdown'],'SWVXX':['neutral','drawdown'],
};

// Classify by asset class if ticker not in DB
function rfGetFit(h, stateKey) {
  var t = (h.ticker||'').toUpperCase();
  var isCash = h.assetClass==='Cash'||h.assetClass==='Money Market'||h.assetClass==='CD'||h.assetClass==='Bond Position';
  var goodStates;
  if(REGIME_FIT_DB[t]) goodStates = REGIME_FIT_DB[t];
  else if(isCash) goodStates = ['neutral','drawdown'];
  else if(h.leverage && (h.assetClass||'').toLowerCase().indexOf('etf')>=0) goodStates = ['leveraged'];
  else if(h.assetClass==='ETF') goodStates = ['leveraged','growth'];
  else goodStates = ['leveraged','growth','neutral']; // Unknown equity — assume generic
  if(goodStates.indexOf(stateKey)>=0) return 'good';
  // Adjacent states get neutral
  var adjacent = {leveraged:['growth'],growth:['leveraged','neutral'],neutral:['growth','drawdown'],drawdown:['neutral']};
  if((adjacent[stateKey]||[]).some(function(s){return goodStates.indexOf(s)>=0;})) return 'warn';
  return 'bad';
}

function renderRegimeAudit(stateKey) {
  var el = document.getElementById('regimeAuditWrap');
  if(!el) return;
  var holdings = window._holdings || [];
  if(!holdings.length){ el.innerHTML='<div style="color:var(--text-sec);text-align:center;padding:14px;font-size:12px;">No holdings to audit.</div>'; return; }
  var stateLabel = (PS_STATES.find(function(s){return s.key===stateKey;})||{}).name||stateKey;
  var good=0,warn=0,bad=0;
  var rows = holdings.map(function(h){
    var fit = rfGetFit(h, stateKey);
    if(fit==='good') good++;
    else if(fit==='warn') warn++;
    else bad++;
    var isCash = h.assetClass==='Cash'||h.assetClass==='Money Market';
    var mv = isCash ? (h.costBasis||0)*h.quantity : (h.currentPrice||0)*h.quantity;
    var badge,label;
    if(fit==='good'){ badge='regime-fit-good'; label='✓ Aligned'; }
    else if(fit==='warn'){ badge='regime-fit-warn'; label='⚠ Neutral'; }
    else { badge='regime-fit-bad'; label='✗ Misaligned'; }
    return '<tr>'
      +'<td style="font-weight:700;color:var(--navy);">'+h.ticker+'</td>'
      +'<td>'+h.companyName+'</td>'
      +'<td>'+fmt(mv)+'</td>'
      +'<td>'+(h.accountType||'Individual')+'</td>'
      +'<td><span class="regime-fit '+badge+'">'+label+'</span></td>'
      +'<td style="font-size:11px;color:var(--text-sec);">'+(fit==='bad'?'Consider rotating for '+stateLabel+' posture':fit==='warn'?'Acceptable, not optimal':'Appropriate for '+stateLabel)+'</td>'
      +'</tr>';
  }).join('');
  var summary='<div style="display:flex;gap:14px;margin-bottom:10px;flex-wrap:wrap;">'
    +'<span class="regime-fit regime-fit-good">✓ Aligned: '+good+'</span>'
    +'<span class="regime-fit regime-fit-warn">⚠ Neutral: '+warn+'</span>'
    +'<span class="regime-fit regime-fit-bad">✗ Misaligned: '+bad+'</span>'
    +'<span style="font-size:12px;color:var(--text-sec);align-self:center;">for <strong>'+stateLabel+'</strong> state</span>'
    +'</div>';
  el.innerHTML=summary+'<div class="table-wrap"><table><thead><tr>'
    +'<th>Ticker</th><th>Name</th><th>Mkt Value</th><th>Account</th><th>Regime Fit</th><th>Guidance</th>'
    +'</tr></thead><tbody>'+rows+'</tbody></table></div>';
}

// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// ════════  PORTFOLIO FORWARD RETURN ENGINE (1/3/5 YR)  ═════════════
// ═══════════════════════════════════════════════════════════════════
async function pfrRun() {
  var el = document.getElementById('pfrResults');
  el.innerHTML = '<div class="metric-card" style="grid-column:1/-1;text-align:center;color:var(--text-sec);"><span class="spinner"></span> Loading holdings, fetching fundamentals, computing fair values...</div>';

  if (!window._holdings || !window._holdings.length) {
    el.innerHTML = '<div class="metric-card" style="grid-column:1/-1;color:var(--warning);">No holdings loaded. Add positions on the Manage Holdings page first.</div>';
    return;
  }

  try {
    var WORKER = "https://perry-finance-proxy.zachperrybusiness.workers.dev";
    // Filter to actual securities (skip cash positions)
    var holdings = window._holdings.filter(function(h){
      var ac = h.assetClass || '';
      return ac !== 'Cash' && ac !== 'Money Market' && ac !== 'CD' && ac !== 'Bond Position';
    });
    if (!holdings.length) { el.innerHTML = '<div style="color:var(--warning);padding:10px;">All holdings are cash. Add some equity positions to see forward projections.</div>'; return; }

    // Aggregate by ticker (across multiple accounts)
    var byTicker = {};
    holdings.forEach(function(h){
      if (!byTicker[h.ticker]) byTicker[h.ticker] = { ticker: h.ticker, name: h.companyName, qty: 0, mv: 0, sector: h.sector, assetClass: h.assetClass, currentPrice: h.currentPrice || 0 };
      var mv = (h.currentPrice || 0) * h.quantity;
      byTicker[h.ticker].qty += h.quantity;
      byTicker[h.ticker].mv += mv;
    });
    var tickers = Object.keys(byTicker);
    var totalMV = tickers.reduce(function(s,t){return s + byTicker[t].mv;}, 0);

    // Fetch fundamentals for each ticker in parallel (capped)
    var fundamentalsByTicker = {};
    await Promise.all(tickers.slice(0, 25).map(async function(t){
      try {
        var r = await fetch(WORKER + '/fundamentals?symbol=' + encodeURIComponent(t));
        var d = await r.json();
        fundamentalsByTicker[t] = d;
      } catch(e) { fundamentalsByTicker[t] = null; }
    }));

    // Build regime-conditioned drift table from SPY 5y history
    var regimeDrifts = await pfrComputeRegimeDrifts();
    var curState = window._briefingState || 'growth';
    var regimeDailyDrift = regimeDrifts[curState] || regimeDrifts.growth || 0.0003;
    var regimeAnnualDrift = Math.pow(1 + regimeDailyDrift, 252) - 1;
    // Sector P/E benchmarks already declared globally (SECTOR_PE)

    // For each ticker compute fundamental fair value + regime drift forecast
    var rows = [];
    tickers.forEach(function(t){
      var info = byTicker[t];
      var d = fundamentalsByTicker[t];
      var px = info.currentPrice;
      if (!px || px <= 0) { return; }
      var weight = totalMV > 0 ? info.mv / totalMV : 0;

      // Method A: Fundamental fair value (Forward P/E for stocks, trailing CAGR for ETFs)
      var fundFV = null;
      var fundConf = 'Low';
      var assetClass = info.assetClass || '';
      var sector = (d && d.profile && d.profile.sector) || info.sector || '';
      var sectorPE = SECTOR_PE[sector] || 20;

      if (d && d.incomeStatement && d.incomeStatement.eps && d.incomeStatement.eps.length >= 2) {
        var epsArr = d.incomeStatement.eps;
        var lastEps = epsArr[epsArr.length-1].value;
        var yrs = Math.min(epsArr.length-1, 3);
        var firstEps = epsArr[epsArr.length-1-yrs].value;
        var epsCAGR = (lastEps > 0 && firstEps > 0) ? Math.pow(lastEps/firstEps, 1/yrs) - 1 : 0;
        epsCAGR = Math.max(-0.10, Math.min(0.30, epsCAGR));
        var fwdEps = lastEps * (1 + epsCAGR);
        fundFV = fwdEps * sectorPE;
        if (d.analystTargets && d.analystTargets.mean) {
          fundFV = (fundFV + d.analystTargets.mean) / 2;
          fundConf = 'Medium';
        }
      } else if (assetClass === 'ETF' || assetClass === 'Fund') {
        // For ETFs without earnings: project at trailing 3yr CAGR
        // We'd need price history; use conservative 7% nominal expected return
        fundFV = px * Math.pow(1.07, 1); // 1yr fund FV at 7%
        fundConf = 'Low';
      }

      /* ── Method B: Regime-conditioned drift ─────────────────────────────
         REWRITTEN 2026-07-24 to use MEASURED risk instead of sector guesses.

         WAS: betaProxy hardcoded by sector name — every Technology holding got
         beta 1.2, every Utility 0.8, regardless of the actual stock. NVDA and
         a mature software name were treated identically. Volatility was a flat
         18% for everything, scaled by that same guessed beta.

         NOW: the warehouse stores a real regression beta vs SPY and a real
         annualised volatility per ticker. Those are used when available, with
         the old sector proxy retained purely as a fallback for names the
         warehouse has not yet ingested — and the source of each number is
         reported in the output so the user can see which is which. */
      var whRow = (window.PerryWarehouse && window.PerryWarehouse.ready())
        ? window.PerryWarehouse.get(t) : null;

      var betaProxy, betaSource, sigma1y, sigmaSource;

      if (whRow && whRow.beta_spy != null && isFinite(whRow.beta_spy)) {
        // Shrink toward 1.0 (Blume adjustment) — raw 2-year betas are noisy and
        // regress toward the market over time.
        betaProxy = 0.67 * whRow.beta_spy + 0.33 * 1.0;
        betaSource = 'measured (2y regression vs SPY, Blume-adjusted)';
      } else {
        betaProxy = 1.0;
        if (sector === 'Technology' || sector === 'Information Technology' || sector === 'Communication Services') betaProxy = 1.2;
        else if (sector === 'Consumer Staples' || sector === 'Utilities' || sector === 'Health Care' || sector === 'Healthcare') betaProxy = 0.8;
        else if (sector === 'Energy' || sector === 'Materials' || sector === 'Basic Materials') betaProxy = 1.1;
        else if (sector === 'Financials' || sector === 'Financial Services') betaProxy = 1.1;
        betaSource = 'sector proxy (warehouse coverage pending)';
      }

      // Leveraged ETFs genuinely are multiples and are not in the equity universe.
      if (info.assetClass === 'Leveraged ETF' || /^(TQQQ|SOXL|SPXL|UPRO|FNGU|TECL|LABU|UDOW)$/.test(t)) {
        betaProxy = 3.0; betaSource = 'leveraged ETF (3x stated exposure)';
      }

      if (whRow && whRow.vol_ann != null && isFinite(whRow.vol_ann) && whRow.vol_ann > 0) {
        sigma1y = whRow.vol_ann;
        sigmaSource = 'measured (252-day realised, annualised)';
      } else {
        sigma1y = 0.18 * betaProxy;
        sigmaSource = 'estimated (18% base × beta)';
      }

      // Apply beta scaling to regime drift, then cap.
      var tickerAnnualDrift = regimeAnnualDrift * betaProxy;
      tickerAnnualDrift = Math.max(-0.40, Math.min(0.50, tickerAnnualDrift));

      info._betaUsed = betaProxy;
      info._betaSource = betaSource;
      info._sigmaUsed = sigma1y;
      info._sigmaSource = sigmaSource;
      var p1y_base = px * (1 + tickerAnnualDrift);
      var p1y_bull = px * (1 + tickerAnnualDrift + sigma1y);
      var p1y_bear = px * (1 + tickerAnnualDrift - sigma1y);

      // Blend fundamental FV (60%) with drift FV (40%) for 1Y if fundFV exists
      if (fundFV != null) {
        p1y_base = 0.6 * fundFV + 0.4 * p1y_base;
      }

      var p3y_base = px * Math.pow(1 + tickerAnnualDrift, 3);
      var p3y_bull = px * Math.pow(1 + tickerAnnualDrift + sigma1y * 0.8, 3);
      var p3y_bear = px * Math.pow(1 + tickerAnnualDrift - sigma1y * 0.8, 3);

      var p5y_base = px * Math.pow(1 + tickerAnnualDrift, 5);
      var p5y_bull = px * Math.pow(1 + tickerAnnualDrift + sigma1y * 0.6, 5);
      var p5y_bear = px * Math.pow(1 + tickerAnnualDrift - sigma1y * 0.6, 5);

      // For 3Y/5Y, also blend in fundamental compounding if fundFV exists
      if (fundFV != null) {
        var fundCagr = (fundFV / px) - 1; // implied 1Y CAGR from fundamental FV
        p3y_base = 0.5 * (px * Math.pow(1 + fundCagr * 0.6, 3)) + 0.5 * p3y_base;
        p5y_base = 0.4 * (px * Math.pow(1 + fundCagr * 0.5, 5)) + 0.6 * p5y_base;
      }

      rows.push({
        ticker: t, name: info.name, weight: weight, mv: info.mv, currentPrice: px,
        sector: sector, beta: betaProxy, fundFV: fundFV, fundConf: fundConf,
        p1y: { bear: p1y_bear, base: p1y_base, bull: p1y_bull },
        p3y: { bear: p3y_bear, base: p3y_base, bull: p3y_bull },
        p5y: { bear: p5y_bear, base: p5y_base, bull: p5y_bull }
      });
    });

    if (!rows.length) { el.innerHTML = '<div style="color:var(--warning);padding:10px;">Could not project any holdings — likely missing price data.</div>'; return; }

    // Aggregate to portfolio level
    function pctReturn(target, cur){ return (target/cur - 1) * 100; }
    var portStart = totalMV;
    function aggregatePort(period){
      var bear = 0, base = 0, bull = 0;
      rows.forEach(function(r){
        var qty = byTicker[r.ticker].qty;
        bear += r[period].bear * qty;
        base += r[period].base * qty;
        bull += r[period].bull * qty;
      });
      // Add cash holdings (frozen)
      var cashMV = 0;
      window._holdings.forEach(function(h){
        var ac = h.assetClass || '';
        if (ac === 'Cash' || ac === 'Money Market' || ac === 'CD' || ac === 'Bond Position') cashMV += (h.costBasis||0) * (h.quantity||1);
      });
      bear += cashMV; base += cashMV; bull += cashMV;
      // Update portStart to include cash for accurate return %
      return { bear: bear, base: base, bull: bull };
    }
    var totalCash = 0;
    window._holdings.forEach(function(h){
      var ac = h.assetClass || '';
      if (ac === 'Cash' || ac === 'Money Market' || ac === 'CD' || ac === 'Bond Position') totalCash += (h.costBasis||0) * (h.quantity||1);
    });
    var portStartFull = totalMV + totalCash;

    var port1y = aggregatePort('p1y');
    var port3y = aggregatePort('p3y');
    var port5y = aggregatePort('p5y');

    function fmtPx(v){ return '$'+v.toFixed(2); }
    function fmtPct(v){ var c = v >= 0 ? C.success : C.danger; return '<span style="color:'+c+';font-weight:600;">' + (v>=0?'+':'') + v.toFixed(1) + '%</span>'; }

    // Build per-holding table
    rows.sort(function(a,b){ return b.mv - a.mv; });
    var tableRows = rows.map(function(r){
      var ret1y = pctReturn(r.p1y.base, r.currentPrice);
      var ret3y = pctReturn(r.p3y.base, r.currentPrice);
      var ret5y = pctReturn(r.p5y.base, r.currentPrice);
      return '<tr>'
        + '<td style="font-weight:700;color:var(--navy);">'+r.ticker+'</td>'
        + '<td style="font-size:11px;">'+(r.weight*100).toFixed(1)+'%</td>'
        + '<td>'+fmtPx(r.currentPrice)+'</td>'
        + '<td title="Bear / Base / Bull">'+fmtPx(r.p1y.base)+' '+fmtPct(ret1y)+'</td>'
        + '<td title="Bear / Base / Bull">'+fmtPx(r.p3y.base)+' '+fmtPct(ret3y)+'</td>'
        + '<td title="Bear / Base / Bull">'+fmtPx(r.p5y.base)+' '+fmtPct(ret5y)+'</td>'
        + '<td style="font-size:11px;color:var(--text-sec);">β'+r.beta.toFixed(2)+(r.fundFV?', FV $'+r.fundFV.toFixed(0):', drift only')+'</td>'
        + '</tr>';
    }).join('');

    var stateNames = {leveraged: 'Leveraged', growth: 'Non-Levered Growth', neutral: 'Neutral', drawdown: 'Positioned for Drawdown'};
    var stateName = stateNames[curState] || curState;
    var ret1y = ((port1y.base/portStartFull-1)*100);
    var ret3y = ((port3y.base/portStartFull-1)*100);
    var ret5y = ((port5y.base/portStartFull-1)*100);
    function fcastCol(v){ return v >= 0 ? C.success : C.danger; }

    var html = '';
    // Regime context card
    html += '<div class="metric-card" title="Current macro regime classification driving the forecast drift assumption.">'
      + '<div class="metric-label">Current Regime</div>'
      + '<div class="metric-value" style="font-size:15px;">'+stateName+'</div>'
      + '<div class="metric-sub" style="color:var(--text-sec);font-weight:400;">Drift: '+(((Math.pow(1+regimeDailyDrift,252)-1)*100).toFixed(1))+'% annualized</div>'
      + '</div>';
    // Forecast cards
    html += '<div class="metric-card" title="1-year base case portfolio value combining fundamental fair value and regime-conditioned drift.">'
      + '<div class="metric-label">1-Year Forecast</div>'
      + '<div class="metric-value">$'+port1y.base.toLocaleString(undefined,{maximumFractionDigits:0})+'</div>'
      + '<div class="metric-sub" style="color:'+fcastCol(ret1y)+';">'+(ret1y>=0?'+':'')+ret1y.toFixed(1)+'%</div>'
      + '<div class="metric-sub" style="color:var(--text-sec);font-weight:400;">Bear $'+(port1y.bear/1000).toFixed(0)+'K / Bull $'+(port1y.bull/1000).toFixed(0)+'K</div>'
      + '</div>';
    html += '<div class="metric-card" title="3-year base case portfolio value.">'
      + '<div class="metric-label">3-Year Forecast</div>'
      + '<div class="metric-value">$'+port3y.base.toLocaleString(undefined,{maximumFractionDigits:0})+'</div>'
      + '<div class="metric-sub" style="color:'+fcastCol(ret3y)+';">'+(ret3y>=0?'+':'')+ret3y.toFixed(1)+'%</div>'
      + '<div class="metric-sub" style="color:var(--text-sec);font-weight:400;">Bear $'+(port3y.bear/1000).toFixed(0)+'K / Bull $'+(port3y.bull/1000).toFixed(0)+'K</div>'
      + '</div>';
    html += '<div class="metric-card" title="5-year base case portfolio value.">'
      + '<div class="metric-label">5-Year Forecast</div>'
      + '<div class="metric-value">$'+port5y.base.toLocaleString(undefined,{maximumFractionDigits:0})+'</div>'
      + '<div class="metric-sub" style="color:'+fcastCol(ret5y)+';">'+(ret5y>=0?'+':'')+ret5y.toFixed(1)+'%</div>'
      + '<div class="metric-sub" style="color:var(--text-sec);font-weight:400;">Bear $'+(port5y.bear/1000).toFixed(0)+'K / Bull $'+(port5y.bull/1000).toFixed(0)+'K</div>'
      + '</div>';
    html += '<div class="metric-card" title="Number of holdings successfully projected; cash held flat at face value.">'
      + '<div class="metric-label">Holdings Projected</div>'
      + '<div class="metric-value">'+rows.length+' / '+tickers.length+'</div>'
      + '<div class="metric-sub" style="color:var(--text-sec);font-weight:400;">Cash flat: $'+(totalCash/1000).toFixed(1)+'K</div>'
      + '</div>';
    // Per-holding detail — full-width row at bottom, hidden by default
    html += '<div id="pfrDetailWrap" style="grid-column:1/-1;display:none;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:16px;">'
      + '<div style="overflow-x:auto;"><table><thead><tr>'
      +   '<th>Ticker</th><th>% Port</th><th>Current</th><th>1-Year</th><th>3-Year</th><th>5-Year</th><th>Inputs</th>'
      + '</tr></thead><tbody>' + tableRows + '</tbody></table></div>'
      + '<div style="font-size:11px;color:var(--text-sec);margin-top:10px;line-height:1.5;"><strong>Reading the table:</strong> "1-Year" cell shows the base case price target and implied % return. Sector beta-proxy and fundamental FV (if available) are shown in the rightmost column. Cash held flat at face value. Bull/bear bands are wider on shorter horizons.</div>'
      + '</div>';

    el.innerHTML = html;
    // Reveal the toggle button now that data is loaded
    var toggleBtn = document.getElementById('pfrToggleDetail');
    if (toggleBtn) { toggleBtn.style.display = ''; toggleBtn.textContent = 'Show Per-Ticker Detail'; }
  } catch(e) {
    el.innerHTML = '<div class="metric-card" style="grid-column:1/-1;color:var(--danger);">Forecast error: '+e.message+'</div>';
  }
}

// Toggle the per-holding detail table on/off (default hidden)
window.pfrToggleDetail = function() {
  var wrap = document.getElementById('pfrDetailWrap');
  var btn = document.getElementById('pfrToggleDetail');
  if (!wrap || !btn) return;
  if (wrap.style.display === 'none') {
    wrap.style.display = '';
    btn.textContent = 'Hide Per-Ticker Detail';
  } else {
    wrap.style.display = 'none';
    btn.textContent = 'Show Per-Ticker Detail';
  }
};

// Compute per-state daily drift from 5yr SPY history (simple, sufficient signal)
async function pfrComputeRegimeDrifts() {
  if (window._pfrCachedDrifts) return window._pfrCachedDrifts;
  try {
    var WORKER = "https://perry-finance-proxy.zachperrybusiness.workers.dev";
    var [spyR, vixR] = await Promise.all([
      fetch(WORKER + '/chart?symbol=SPY&range=5y&interval=1d').then(function(r){return r.json();}),
      fetch(WORKER + '/chart?symbol=%5EVIX&range=5y&interval=1d').then(function(r){return r.json();})
    ]);
    var spyPts = (spyR.points||[]).filter(function(p){return p.close!=null;});
    var vixPts = (vixR.points||[]).filter(function(p){return p.close!=null;});
    var vixMap = {}; vixPts.forEach(function(p){vixMap[p.date.slice(0,10)] = p.close;});
    var dates = spyPts.map(function(p){return p.date.slice(0,10);});
    var closes = spyPts.map(function(p){return p.close;});
    var lookback = 252;
    var stateRets = { leveraged: [], growth: [], neutral: [], drawdown: [] };
    for (var i = lookback; i < closes.length - 1; i++) {
      var cur = closes[i];
      var past = closes[i-lookback];
      var slice = closes.slice(i-lookback, i+1);
      var spyHigh = Math.max.apply(null, slice);
      var spyLow = Math.min.apply(null, slice);
      var vix = vixMap[dates[i]];
      if (!vix) continue;
      var signals = { vix: vix, spyTrailingReturn: (cur-past)/past, drawdownFromPeak: (cur-spyHigh)/spyHigh, spy12mFromLow: (cur-spyLow)/spyLow };
      var cl = psClassifyState(signals);
      var ret = (closes[i+1] - closes[i]) / closes[i];
      if (stateRets[cl.winner]) stateRets[cl.winner].push(ret);
    }
    var avg = {};
    Object.keys(stateRets).forEach(function(k){
      var arr = stateRets[k];
      avg[k] = arr.length ? arr.reduce(function(a,b){return a+b;},0)/arr.length : 0.0003;
    });
    window._pfrCachedDrifts = avg;
    return avg;
  } catch(e) {
    return { leveraged: 0.0008, growth: 0.0004, neutral: 0.0001, drawdown: -0.0005 };
  }
}

// ═══════════════════════════════════════════════════════════════════
// ════════  PORTFOLIO OPTIMIZATION ENGINE  ══════════════════════════
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// REBALANCE CONTEXT — answers "what regime are we in, what risk profile
// do I have, what should I be buying, and what am I comparing against?"
// before any rebalance trade is proposed. Fresh data on every refresh.
// ═══════════════════════════════════════════════════════════════════
var _rebCtxCache = null;
async function loadRebalanceContext(force) {
  var el = document.getElementById('rebalanceContextPanel');
  if (!el) return;
  if (_rebCtxCache && !force) { renderRebalanceContext(_rebCtxCache); return; }
  el.innerHTML = '<div style="text-align:center;padding:14px;color:var(--text-sec);"><span class="spinner"></span> Pulling fresh regime research…</div>';
  try {
    var WORKER = window.WORKER_URL || 'https://perry-finance-proxy.zachperrybusiness.workers.dev';
    // Regime: prefer the committed macro phase (stable), fall back to tactical state
    var regime = null;
    try { regime = sessionStorage.getItem('perry_macro_phase_committed'); } catch(e) {}
    if (!regime) regime = window._briefingState || 'growth';
    var profileKey = window._riskProfile || 'moderate';
    var r = await fetch(WORKER + '/optimize-research?regime=' + encodeURIComponent(regime) + '&profile=' + encodeURIComponent(profileKey) + (force ? '&fresh=1' : ''));
    var d = await r.json();
    if (d.error) throw new Error(d.error);
    _rebCtxCache = d;
    renderRebalanceContext(d);
  } catch(e) {
    el.innerHTML = '<div style="color:var(--danger);padding:10px;">Could not load research: ' + e.message + ' <button class="btn btn-sm" onclick="loadRebalanceContext(true)">Retry</button></div>';
  }
}

function renderRebalanceContext(d) {
  var el = document.getElementById('rebalanceContextPanel');
  if (!el) return;
  var cons = d.constraints || {};
  var profileSet = !!window._riskProfile;
  var favored = (d.sectorMomentum || []).filter(function(m){ return m.favored; });
  var avoided = (d.sectorMomentum || []).filter(function(m){ return m.avoided; });
  var fmtM = function(m) {
    var mc = (m.momentumScore != null && m.momentumScore >= 0) ? C.success : C.danger;
    return '<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px dashed var(--border);">'
      + '<span><strong>'+m.etf+'</strong>'+(m.above200dma===false?' <span title="Below 200-day average — no live trend confirmation" style="color:#8B6914;">⚠</span>':'')+'</span>'
      + '<span style="color:'+mc+';font-weight:600;">'+(m.momentumScore!=null?(m.momentumScore>=0?'+':'')+m.momentumScore.toFixed(1)+'%':'—')+'</span></div>';
  };
  var candChips = '';
  (d.candidates || []).slice(0, 5).forEach(function(grp) {
    (grp.tickers || []).slice(0, 3).forEach(function(t) {
      if (t.price == null) return;
      var cc = (t.chg3m != null && t.chg3m >= 0) ? C.success : C.danger;
      candChips += '<span onclick="navigateTo(\'research\');var ri=document.getElementById(\'researchTicker\');if(ri){ri.value=\''+t.ticker+'\';runResearch();}" style="display:inline-block;cursor:pointer;background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:3px 10px;margin:2px;font-size:11px;" title="Open full research for '+t.ticker+'"><strong style="color:var(--navy);">'+t.ticker+'</strong> $'+(t.price||0).toLocaleString(undefined,{maximumFractionDigits:2})+(t.chg3m!=null?' <span style="color:'+cc+';font-weight:600;">'+(t.chg3m>=0?'+':'')+t.chg3m.toFixed(1)+'% 3M</span>':'')+'</span>';
    });
  });
  el.innerHTML =
    '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px;">'
    + '<div style="flex:1;min-width:180px;background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:10px 14px;"><div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-sec);font-weight:700;">Current Regime</div><div style="font-size:15px;font-weight:800;color:var(--navy);">'+d.regime+'</div><div style="font-size:11px;color:var(--text-sec);margin-top:2px;">'+(d.regimeNote||'')+'</div></div>'
    + '<div style="flex:1;min-width:180px;background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:10px 14px;"><div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-sec);font-weight:700;">Your Risk Profile</div><div style="font-size:15px;font-weight:800;color:var(--navy);">'+(cons.label||d.profile)+(profileSet?'':' <span style="font-size:10px;color:#8B6914;">(default — not set)</span>')+'</div><div style="font-size:11px;color:var(--text-sec);margin-top:2px;">'+(cons.description||'')+'</div>'+(profileSet?'':'<button class="btn-outline btn-sm" style="margin-top:6px;" onclick="showRiskQuestionnaire()">Set your profile →</button>')+'</div>'
    + '</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:10px;">'
    +   '<div><div style="font-size:11px;font-weight:700;color:var(--success);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">Favor in this regime (live momentum)</div>'+favored.map(fmtM).join('')+'</div>'
    +   '<div><div style="font-size:11px;font-weight:700;color:var(--danger);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">Reduce / avoid in this regime</div>'+avoided.map(fmtM).join('')+'</div>'
    + '</div>'
    + (candChips ? '<div style="font-size:11px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">What to buy — candidates with fresh quotes (click for research)</div><div style="margin-bottom:8px;">'+candChips+'</div>' : '')
    + '<div style="font-size:11px;color:var(--text-sec);border-top:1px solid var(--border);padding-top:6px;">'
    +   '<strong>What you\'re comparing against:</strong> the drift table below measures your portfolio vs. the <em>'+(cons.label||d.profile)+'</em> target model; the playbook above tells you which direction to lean <em>within</em> the tolerance band. Constraints: max '+Math.round((cons.maxSinglePosition||1)*100)+'% per position · max '+Math.round((cons.maxLeveragedETF||0)*100)+'% leveraged ETFs'+(cons.minDefensive!=null?' · ≥'+Math.round(cons.minDefensive*100)+'% defensive':'')+'.'
    +   ' Data pulled ' + new Date(d.timestamp).toLocaleTimeString() + '.'
    + '</div>';
}

// ── Leveraged ETF detection (used to enforce risk-profile leverage caps) ──
var LEVERAGED_TICKERS = {'TQQQ':1,'SQQQ':1,'UPRO':1,'SPXU':1,'SPXL':1,'SPXS':1,'SOXL':1,'SOXS':1,'SSO':1,'SDS':1,'QLD':1,'QID':1,'TMF':1,'TMV':1,'UDOW':1,'SDOW':1,'TNA':1,'TZA':1,'FAS':1,'FAZ':1,'LABU':1,'LABD':1,'NUGT':1,'DUST':1,'ERX':1,'ERY':1,'UCO':1,'SCO':1,'BOIL':1,'KOLD':1,'TECL':1,'TECS':1,'FNGU':1,'FNGD':1,'WEBL':1,'WEBS':1,'BULZ':1,'BERZ':1,'ROM':1,'REW':1,'MVV':1,'UWM':1,'DDM':1,'DXD':1,'URTY':1,'SRTY':1,'YINN':1,'YANG':1,'EDC':1,'EDZ':1,'DRN':1,'DRV':1,'CURE':1,'DFEN':1,'DPST':1,'MSTU':1,'MSTZ':1,'NVDL':1,'NVDU':1,'TSLL':1,'TSLQ':1,'CONL':1,'BITX':1,'ETHU':1};
function poeIsLeveraged(t) { return !!LEVERAGED_TICKERS[String(t||'').toUpperCase()]; }

// Enforce per-position + leveraged-sleeve caps on a weight vector (long-only simplex).
// Iterative clip-and-redistribute: caps are HARD (excess redistributed pro-rata to uncapped names).
function poeApplyConstraints(w, tickers, cons) {
  var maxPos = cons && cons.maxSinglePosition != null ? cons.maxSinglePosition : 1;
  var maxLev = cons && cons.maxLeveragedETF != null ? cons.maxLeveragedETF : 1;
  var n = w.length;
  w = w.slice();
  for (var pass = 0; pass < 12; pass++) {
    var changed = false;
    // 1) Per-position cap
    var excess = 0; var free = [];
    for (var i = 0; i < n; i++) {
      if (w[i] > maxPos + 1e-9) { excess += w[i] - maxPos; w[i] = maxPos; changed = true; }
      else if (w[i] < maxPos - 1e-9) free.push(i);
    }
    if (excess > 0 && free.length) {
      var freeSum = free.reduce(function(s,i){return s + w[i];}, 0) || 1;
      free.forEach(function(i){ w[i] += excess * (w[i] / freeSum); });
    }
    // 2) Leveraged sleeve cap
    var levIdx = []; var levSum = 0;
    for (var i = 0; i < n; i++) { if (poeIsLeveraged(tickers[i])) { levIdx.push(i); levSum += w[i]; } }
    if (levSum > maxLev + 1e-9) {
      var scale = maxLev / levSum; var freed = 0;
      levIdx.forEach(function(i){ freed += w[i] * (1 - scale); w[i] *= scale; });
      var nonLev = []; for (var i = 0; i < n; i++) if (!poeIsLeveraged(tickers[i])) nonLev.push(i);
      if (nonLev.length) {
        var nlSum = nonLev.reduce(function(s,i){return s + w[i];}, 0) || 1;
        nonLev.forEach(function(i){ w[i] += freed * (w[i] / nlSum); });
      }
      changed = true;
    }
    // 3) Renormalize
    var sum = w.reduce(function(a,b){return a+b;}, 0);
    if (Math.abs(sum - 1) > 1e-9) { for (var i = 0; i < n; i++) w[i] /= sum; }
    if (!changed) break;
  }
  return w;
}

async function poeRun() {
  var el = document.getElementById('poeResults');
  var chartWrap = document.getElementById('poeChartWrap');
  el.innerHTML = '<div style="padding:14px;text-align:center;"><span class="spinner"></span> Loading holdings history, pulling fresh regime research, computing constrained covariance optimization...</div>';
  chartWrap.style.display = 'none';

  if (!window._holdings || !window._holdings.length) {
    el.innerHTML = '<div style="color:var(--warning);padding:10px;">No holdings loaded.</div>'; return;
  }

  try {
    var WORKER = "https://perry-finance-proxy.zachperrybusiness.workers.dev";
    var targetState = document.getElementById('poeTarget').value;
    var btYears = parseInt(document.getElementById('poeBacktest').value);
    if (targetState === 'current') targetState = window._briefingState || 'growth';

    // ── Risk profile: the optimizer is conditioned on BOTH regime and profile ──
    var profileKey = window._riskProfile || 'moderate';
    var profileMeta = (typeof RISK_PROFILES !== 'undefined' && RISK_PROFILES[profileKey]) ? RISK_PROFILES[profileKey] : null;

    // ── Fresh research pack: pulled from the worker on EVERY run (fresh=1
    //    bypasses the 15-min edge cache). Contains live sector momentum,
    //    the regime playbook, profile constraints, and candidate buys. ──
    var researchPromise = fetch(WORKER + '/optimize-research?regime=' + encodeURIComponent(targetState) + '&profile=' + encodeURIComponent(profileKey) + '&fresh=1')
      .then(function(r){ return r.json(); }).catch(function(){ return null; });

    // Filter to securities, aggregate by ticker
    var holdings = window._holdings.filter(function(h){
      var ac = h.assetClass || '';
      return ac !== 'Cash' && ac !== 'Money Market' && ac !== 'CD' && ac !== 'Bond Position';
    });
    if (holdings.length < 2) { el.innerHTML = '<div style="color:var(--warning);padding:10px;">Need at least 2 non-cash holdings to optimize.</div>'; return; }

    var byTicker = {};
    holdings.forEach(function(h){
      if (!byTicker[h.ticker]) byTicker[h.ticker] = { ticker: h.ticker, mv: 0 };
      byTicker[h.ticker].mv += (h.currentPrice||0) * h.quantity;
    });
    var tickers = Object.keys(byTicker);
    var totalMV = tickers.reduce(function(s,t){return s+byTicker[t].mv;}, 0);
    var actualWeights = tickers.map(function(t){ return byTicker[t].mv / totalMV; });

    // Cap to 12 tickers (optimization scales poorly beyond that)
    if (tickers.length > 12) {
      // Sort by MV and keep top 12
      var sorted = tickers.slice().sort(function(a,b){return byTicker[b].mv-byTicker[a].mv;});
      tickers = sorted.slice(0, 12);
      actualWeights = tickers.map(function(t){ return byTicker[t].mv / totalMV; });
      // Renormalize
      var s = actualWeights.reduce(function(a,b){return a+b;},0);
      actualWeights = actualWeights.map(function(w){return w/s;});
    }

    // Fetch prices
    var range = btYears <= 1 ? '1y' : btYears <= 3 ? '3y' : '5y';
    var prices = {};
    await Promise.all(tickers.map(async function(t){
      try {
        var r = await fetch(WORKER + '/chart?symbol='+encodeURIComponent(t)+'&range='+range+'&interval=1d');
        var d = await r.json();
        var pts = (d.points||[]).filter(function(p){return p.close!=null;});
        if (pts.length > 100) prices[t] = pts;
      } catch(e) {}
    }));
    var validTickers = tickers.filter(function(t){return prices[t];});
    if (validTickers.length < 2) { el.innerHTML = '<div style="color:var(--danger);padding:10px;">Could not load enough price history.</div>'; return; }

    // Align dates
    var minLen = Math.min.apply(null, validTickers.map(function(t){return prices[t].length;}));
    validTickers.forEach(function(t){ prices[t] = prices[t].slice(-minLen); });
    var dates = prices[validTickers[0]].map(function(p){return p.date;});

    // Compute return matrix [days x tickers]
    var nDays = minLen - 1;
    var nT = validTickers.length;
    var R = []; // returns per day per ticker
    for (var i = 1; i < minLen; i++) {
      var row = validTickers.map(function(t){ return (prices[t][i].close - prices[t][i-1].close) / prices[t][i-1].close; });
      R.push(row);
    }

    // Mean and covariance
    var mu = new Array(nT).fill(0);
    R.forEach(function(r){ r.forEach(function(v,j){ mu[j] += v; }); });
    mu = mu.map(function(v){ return v / R.length; });
    var cov = []; for (var i=0;i<nT;i++){ cov.push(new Array(nT).fill(0)); }
    R.forEach(function(r){
      for (var i=0;i<nT;i++) for (var j=0;j<nT;j++) cov[i][j] += (r[i]-mu[i])*(r[j]-mu[j]);
    });
    for (var i=0;i<nT;i++) for (var j=0;j<nT;j++) cov[i][j] /= (R.length-1);

    // Adjust mu to regime — get state drift uplift
    var regimeDrifts = await pfrComputeRegimeDrifts();
    var stateMult = 1.0;
    if (regimeDrifts.growth && regimeDrifts[targetState]) {
      // Multiplier = ratio of target-state daily drift to overall mean SPY drift
      stateMult = regimeDrifts[targetState] / Math.max(1e-6, Object.values(regimeDrifts).reduce(function(a,b){return a+b;},0)/4);
      stateMult = Math.max(-2, Math.min(3, stateMult));
    }
    var muAdjusted = mu.map(function(v){ return v * stateMult; });

    // Optimize: maximize Sharpe ratio. Use simple grid + refine via gradient projection.
    // Long-only, sum-to-1 simplex. Since this can be expensive, use Dirichlet sampling + best-pick.
    function portfolioStats(w) {
      var ret = 0; for (var i=0;i<nT;i++) ret += w[i]*muAdjusted[i];
      var vari = 0; for (var i=0;i<nT;i++) for (var j=0;j<nT;j++) vari += w[i]*w[j]*cov[i][j];
      var vol = Math.sqrt(Math.max(0, vari));
      return { ret: ret*252, vol: vol*Math.sqrt(252), sharpe: vol > 0 ? (ret*252 - 0.04)/(vol*Math.sqrt(252)) : -999 };
    }
    function dirichlet(n, alpha) {
      var w = new Array(n);
      for (var i=0;i<n;i++) {
        // gamma sample via -ln(U) for alpha=1 (exponential)
        var s = 0;
        for (var k=0;k<alpha;k++) s += -Math.log(1 - Math.random() + 1e-12);
        w[i] = s;
      }
      var sum = w.reduce(function(a,b){return a+b;},0);
      return w.map(function(v){return v/sum;});
    }
    // ── Await the fresh research pack (constraints + playbook + momentum) ──
    var research = await researchPromise;
    var cons = (research && research.constraints) ? research.constraints : {
      // Offline fallback mirrors the worker's PROFILE_CONSTRAINTS
      conservative: { label:'Conservative', maxSinglePosition:0.10, maxLeveragedETF:0.00 },
      moderate:     { label:'Moderate', maxSinglePosition:0.15, maxLeveragedETF:0.05 },
      aggressive:   { label:'Aggressive Growth', maxSinglePosition:0.25, maxLeveragedETF:0.15 },
      speculative:  { label:'Speculative', maxSinglePosition:0.35, maxLeveragedETF:0.50 }
    }[profileKey] || { label:'Moderate', maxSinglePosition:0.15, maxLeveragedETF:0.05 };

    var bestW = null; var bestS = -Infinity;
    // 2000 random portfolios — every candidate is projected onto the
    // risk-profile constraint set BEFORE scoring, so the optimum is
    // feasible by construction (not clipped after the fact).
    for (var trial = 0; trial < 2000; trial++) {
      var w = poeApplyConstraints(dirichlet(nT, 1), validTickers, cons);
      var st = portfolioStats(w);
      if (st.sharpe > bestS) { bestS = st.sharpe; bestW = w; }
    }
    if (!bestW) { el.innerHTML = '<div style="color:var(--danger);padding:10px;">No feasible allocation under the '+(cons.label||profileKey)+' constraints.</div>'; return; }
    // Local refinement: try ±2% bumps on each pair, keep improvements (re-projected each step)
    for (var iter = 0; iter < 50; iter++) {
      var improved = false;
      for (var i=0;i<nT;i++) {
        for (var j=0;j<nT;j++) {
          if (i===j) continue;
          var bump = 0.02;
          if (bestW[j] >= bump) {
            var w2 = bestW.slice();
            w2[i] += bump; w2[j] -= bump;
            w2 = poeApplyConstraints(w2, validTickers, cons);
            var s2 = portfolioStats(w2);
            if (s2.sharpe > bestS + 1e-6) { bestS = s2.sharpe; bestW = w2; improved = true; }
          }
        }
      }
      if (!improved) break;
    }

    // Backtest: hold actual weights vs. optimal weights
    function backtestEquity(weights) {
      var equity = [10000];
      for (var i = 0; i < R.length; i++) {
        var dayRet = 0;
        for (var j = 0; j < nT; j++) dayRet += weights[j] * R[i][j];
        equity.push(equity[equity.length-1] * (1 + dayRet));
      }
      return equity;
    }
    var actualEq = backtestEquity(actualWeights);
    var optEq = backtestEquity(bestW);
    var actualStats = portfolioStats(actualWeights);
    var optStats = portfolioStats(bestW);

    // Build rotation actions table
    var stateNames = {leveraged: 'Leveraged', growth: 'Non-Levered Growth', neutral: 'Neutral', drawdown: 'Positioned for Drawdown'};
    var rotations = validTickers.map(function(t, i){
      var diff = bestW[i] - actualWeights[i];
      return { ticker: t, current: actualWeights[i], optimal: bestW[i], diff: diff };
    });
    rotations.sort(function(a,b){return Math.abs(b.diff) - Math.abs(a.diff);});

    var rotRows = rotations.map(function(r){
      var diffPct = r.diff * 100;
      var action = diffPct > 1 ? '<span style="color:'+C.success+';font-weight:700;">▲ INCREASE</span>' : diffPct < -1 ? '<span style="color:'+C.danger+';font-weight:700;">▼ REDUCE</span>' : '<span style="color:var(--text-sec);">— hold</span>';
      var diffMV = r.diff * totalMV;
      return '<tr>'
        + '<td style="font-weight:700;color:var(--navy);">'+r.ticker+'</td>'
        + '<td>'+(r.current*100).toFixed(1)+'%</td>'
        + '<td style="font-weight:600;color:var(--navy);">'+(r.optimal*100).toFixed(1)+'%</td>'
        + '<td style="color:'+(diffPct>=0?C.success:C.danger)+';font-weight:600;">'+(diffPct>=0?'+':'')+diffPct.toFixed(1)+'pp</td>'
        + '<td style="color:'+(diffPct>=0?C.success:C.danger)+';">'+(diffPct>=0?'+':'')+'$'+Math.abs(diffMV).toLocaleString(undefined,{maximumFractionDigits:0})+'</td>'
        + '<td>'+action+'</td>'
        + '</tr>';
    }).join('');

    // ── Research panel: what to buy, which sectors, and why — fresh data ──
    var researchHtml = '';
    if (research && research.sectorMomentum) {
      var favored = research.sectorMomentum.filter(function(m){ return m.favored; });
      var topMomentum = research.sectorMomentum.slice(0, 5);
      var candChips = '';
      (research.candidates || []).slice(0, 6).forEach(function(grp) {
        (grp.tickers || []).slice(0, 4).forEach(function(t) {
          if (t.price == null) return;
          var chg = t.chg3m != null ? (t.chg3m >= 0 ? '+' : '') + t.chg3m.toFixed(1) + '% 3M' : '';
          var cc = t.chg3m != null && t.chg3m >= 0 ? C.success : C.danger;
          candChips += '<span onclick="navigateTo(\'research\');var ri=document.getElementById(\'researchTicker\');if(ri){ri.value=\''+t.ticker+'\';runResearch();}" '
            + 'style="display:inline-block;cursor:pointer;background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:3px 10px;margin:2px;font-size:11px;" '
            + 'title="Click to open full research for '+t.ticker+'">'
            + '<strong style="color:var(--navy);">'+t.ticker+'</strong> $'+(t.price||0).toLocaleString(undefined,{maximumFractionDigits:2})
            + (chg ? ' <span style="color:'+cc+';font-weight:600;">'+chg+'</span>' : '') + '</span>';
        });
      });
      researchHtml = '<div style="border:1px solid var(--border);border-radius:6px;margin-bottom:16px;overflow:hidden;">'
        + '<div style="background:var(--navy);color:#fff;padding:8px 14px;font-size:12px;font-weight:700;display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;">'
        +   '<span>📡 Live Regime Research — pulled fresh at '+new Date(research.timestamp).toLocaleTimeString()+' <span class="help-icon" data-help="rebalanceContext" style="font-size:11px;">ⓘ</span></span>'
        +   '<span style="font-weight:500;opacity:.85;">Regime: '+research.regime+' &middot; Profile: '+(cons.label||profileKey)+'</span>'
        + '</div>'
        + '<div style="padding:12px 14px;font-size:12px;">'
        +   '<div style="margin-bottom:8px;color:var(--text-sec);line-height:1.5;"><strong style="color:var(--navy);">Playbook:</strong> '+(research.regimeNote||'')+'</div>'
        +   '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:10px;">'
        +     '<div><div style="font-size:11px;font-weight:700;color:var(--success);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">Sectors to Favor (playbook ∩ live momentum)</div>'
        +       favored.map(function(m){ var mc = (m.momentumScore!=null && m.momentumScore>=0)?C.success:C.danger; return '<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px dashed var(--border);"><span><strong>'+m.etf+'</strong>'+(m.above200dma===false?' <span title="Below its 200-day average — playbook pick lacks live trend confirmation" style="color:#8B6914;">⚠</span>':'')+'</span><span style="color:'+mc+';font-weight:600;">'+(m.momentumScore!=null?(m.momentumScore>=0?'+':'')+m.momentumScore.toFixed(1)+'%':'—')+'</span></div>'; }).join('')
        +     '</div>'
        +     '<div><div style="font-size:11px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">Top 5 by Live Momentum (all groups)</div>'
        +       topMomentum.map(function(m){ var mc = (m.momentumScore!=null && m.momentumScore>=0)?C.success:C.danger; return '<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px dashed var(--border);"><span><strong>'+m.etf+'</strong>'+(m.avoided?' <span style="font-size:10px;color:var(--danger);">(playbook: avoid)</span>':'')+'</span><span style="color:'+mc+';font-weight:600;">'+(m.momentumScore!=null?(m.momentumScore>=0?'+':'')+m.momentumScore.toFixed(1)+'%':'—')+'</span></div>'; }).join('')
        +     '</div>'
        +   '</div>'
        +   (candChips ? '<div style="font-size:11px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">Candidate Buys (fresh quotes — click any ticker for full research)</div><div>'+candChips+'</div>' : '')
        +   (research.avoidGroups && research.avoidGroups.length ? '<div style="margin-top:8px;font-size:11px;color:var(--text-sec);"><strong style="color:var(--danger);">Reduce/avoid in this regime:</strong> '+research.avoidGroups.join(', ')+'</div>' : '')
        +   '<div style="margin-top:8px;font-size:11px;color:var(--text-sec);border-top:1px solid var(--border);padding-top:6px;"><strong>Your '+(cons.label||profileKey)+' constraints (hard caps applied to the optimizer):</strong> max '+Math.round((cons.maxSinglePosition||1)*100)+'% per position &middot; max '+Math.round((cons.maxLeveragedETF||0)*100)+'% total in leveraged ETFs'+(cons.minDefensive!=null?' &middot; target ≥'+Math.round(cons.minDefensive*100)+'% defensive sleeve':'')+(cons.guidelineBasis?'<br><em>'+cons.guidelineBasis+'</em>':'')+'</div>'
        + '</div></div>';
    } else {
      researchHtml = '<div style="background:rgba(139,105,20,0.08);border:1px solid #8B6914;border-radius:4px;padding:8px 12px;margin-bottom:12px;font-size:12px;color:#5C4500;">Live research unavailable (worker /optimize-research unreachable) — optimization ran with local '+(cons.label||profileKey)+' constraints only.</div>';
    }

    el.innerHTML = '<div style="text-align:left;">'
      + researchHtml
      + '<div style="background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:10px 14px;margin-bottom:14px;font-size:12px;">'
      +   '<strong>Optimizing for:</strong> '+stateNames[targetState]+' regime &middot; <strong>Risk profile:</strong> '+(cons.label||profileKey)+' &middot; <strong>Backtest window:</strong> '+btYears+' year(s) &middot; <strong>Tickers:</strong> '+validTickers.length
      +   ((cons.maxSinglePosition && validTickers.length * cons.maxSinglePosition < 0.999)
          ? '<div style="margin-top:6px;color:#8B6914;font-weight:600;">⚠ Note: your '+(cons.label||profileKey)+' profile caps positions at '+Math.round(cons.maxSinglePosition*100)+'%, but with only '+validTickers.length+' holdings that cap cannot sum to 100%. Weights were relaxed proportionally — consider adding more positions (see candidate buys above) to make the cap enforceable.'
          : '')
      + '</div>'
      // Actual vs Optimal stats
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px;">'
      + '<div style="border:1px solid var(--border);border-radius:4px;padding:12px;"><div style="font-size:11px;color:var(--text-sec);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Your Current Allocation</div>'
      +   '<div style="font-size:13px;line-height:1.6;">Annualized Return: <strong>'+(actualStats.ret*100).toFixed(1)+'%</strong><br>'
      +   'Annualized Vol: <strong>'+(actualStats.vol*100).toFixed(1)+'%</strong><br>'
      +   'Sharpe Ratio: <strong>'+actualStats.sharpe.toFixed(2)+'</strong></div></div>'
      + '<div style="border:2px solid var(--navy);border-radius:4px;padding:12px;background:rgba(0,60,113,0.04);"><div style="font-size:11px;color:var(--navy);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-weight:700;">Optimal Allocation ('+stateNames[targetState]+')</div>'
      +   '<div style="font-size:13px;line-height:1.6;">Annualized Return: <strong style="color:var(--success);">'+(optStats.ret*100).toFixed(1)+'%</strong><br>'
      +   'Annualized Vol: <strong>'+(optStats.vol*100).toFixed(1)+'%</strong><br>'
      +   'Sharpe Ratio: <strong style="color:var(--success);">'+optStats.sharpe.toFixed(2)+'</strong></div></div>'
      + '</div>'
      // Rotation table
      + '<div style="overflow-x:auto;"><table><thead><tr>'
      +   '<th>Ticker</th><th>Current %</th><th>Optimal %</th><th>Δ Weight</th><th>Δ Dollars</th><th>Action</th>'
      + '</tr></thead><tbody>' + rotRows + '</tbody></table></div>'
      + '<div style="font-size:11px;color:var(--text-sec);margin-top:8px;">Backtest equity curves below show how each weight set would have performed historically. Past performance does not guarantee future results.</div>'
      + '</div>';

    // Backtest chart
    chartWrap.style.display = 'block';
    if (window._poeChart) window._poeChart.destroy();
    window._poeChart = new Chart(document.getElementById('poeChart').getContext('2d'), {
      type: 'line',
      data: {
        labels: dates,
        datasets: [
          { label: 'Actual Allocation', data: actualEq, borderColor: C.textSec, backgroundColor: 'transparent', borderWidth: 1.5, borderDash:[4,3], pointRadius: 0, tension: 0.05 },
          { label: 'Optimal Allocation ('+stateNames[targetState]+')', data: optEq, borderColor: C.navy, backgroundColor: 'rgba(0,60,113,0.06)', borderWidth: 2, pointRadius: 0, fill: false, tension: 0.05 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: {font:{size:10}, color:C.textSec} }, tooltip: Object.assign({}, chartTooltip, { callbacks: { label: function(ctx){return ctx.dataset.label+': $'+ctx.parsed.y.toFixed(0);} } }) },
        scales: {
          x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { maxTicksLimit: 10, autoSkip: true }) },
          y: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { callback: function(v){return '$'+Math.round(v/1000)+'K';} }), title:{display:true, text:'Equity ($10K start)', color:C.textSec, font:{size:11}} }
        }
      }
    });
  } catch(e) {
    el.innerHTML = '<div style="color:var(--danger);padding:10px;">Optimization error: '+e.message+'</div>';
  }
}

// ═══════════════════════════════════════════════════════════════════
// ════════  FAMA-FRENCH FACTOR EXPOSURE  ════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// Factor proxies: Mkt=SPY, SMB=IWM-SPY(excess), HML=VTV-VUG(excess),
//                 MOM=MTUM, RMW=quality proxy, CMA=conservative-aggressive via IJJ
async function ffRunAnalysis() {
  var el = document.getElementById('ffResults');
  el.innerHTML='<div class="metric-card" style="grid-column:1/-1;text-align:center;color:var(--text-sec);"><span class="spinner"></span> Fetching 3-year price history for portfolio and factor proxies...</div>';
  var holdings = window._holdings||[];
  if(!holdings.length){ el.innerHTML='<div style="color:var(--danger);padding:10px;">No holdings to analyze.</div>'; return; }
  var WORKER='https://perry-finance-proxy.zachperrybusiness.workers.dev';
  var range='3y'; var interval='1d';
  try {
    // Get unique equity tickers
    var eqTickers=[]; var seen={};
    holdings.forEach(function(h){
      var isCash=h.assetClass==='Cash'||h.assetClass==='Money Market'||h.assetClass==='CD'||h.assetClass==='Bond Position';
      if(!isCash&&h.ticker&&!seen[h.ticker]){seen[h.ticker]=1;eqTickers.push(h.ticker);}
    });
    // Factor proxies
    var factorTickers=['SPY','IWM','VTV','VUG','MTUM','IJJ','QUAL'];
    var allTickers=eqTickers.concat(factorTickers);
    // Fetch all in parallel
    var results={};
    await Promise.all(allTickers.map(async function(t){
      try{
        var r=await fetch(WORKER+'/chart?symbol='+encodeURIComponent(t)+'&range='+range+'&interval='+interval);
        var d=await r.json();
        var pts=(d.points||[]).filter(function(p){return p.close!=null;});
        if(pts.length>5){
          var closes=pts.map(function(p){return p.close;});
          var rets=[]; for(var i=1;i<closes.length;i++) rets.push((closes[i]-closes[i-1])/closes[i-1]);
          results[t]={closes:closes,returns:rets,dates:pts.map(function(p){return p.date.slice(0,10);})};
        }
      }catch(e){}
    }));
    if(!results['SPY']){ el.innerHTML='<div style="color:var(--danger);padding:10px;">Could not fetch SPY data for factor analysis.</div>'; return; }
    var mktRets=results['SPY'].returns;
    var n=mktRets.length;
    // Build factor return series (aligned to SPY dates)
    function alignReturns(tickerRets, refLen){
      // Simple: truncate or pad with zeros to match reference length
      if(tickerRets.length>=refLen) return tickerRets.slice(tickerRets.length-refLen);
      var pad=new Array(refLen-tickerRets.length).fill(0);
      return pad.concat(tickerRets);
    }
    function compFactorRet(tickerA, tickerB){
      if(!results[tickerA]||!results[tickerB]) return new Array(n).fill(0);
      var a=alignReturns(results[tickerA].returns,n);
      var b=alignReturns(results[tickerB].returns,n);
      return a.map(function(v,i){return v-b[i];});
    }
    var RF_DAILY=0.0525/252; // risk-free ~5.25% annual
    var factors={
      'Market (Mkt-RF)': mktRets.map(function(v){return v-RF_DAILY;}),
      'Size (SMB)': compFactorRet('IWM','SPY'),
      'Value (HML)': compFactorRet('VTV','VUG'),
      'Momentum (MOM)': (results['MTUM']?alignReturns(results['MTUM'].returns,n):new Array(n).fill(0)),
    };
    // Build portfolio daily return series (market-value weighted)
    var totalMV=0;
    var weights={};
    holdings.forEach(function(h){
      var isCash=h.assetClass==='Cash'||h.assetClass==='Money Market'||h.assetClass==='CD'||h.assetClass==='Bond Position';
      var mv=isCash?(h.costBasis||0)*h.quantity:(h.currentPrice||0)*h.quantity;
      weights[h.ticker]=(weights[h.ticker]||0)+mv; totalMV+=mv;
    });
    var portRets=new Array(n).fill(0);
    Object.keys(weights).forEach(function(t){
      var w=totalMV>0?weights[t]/totalMV:0;
      if(results[t]){ var tr=alignReturns(results[t].returns,n); tr.forEach(function(v,i){portRets[i]+=v*w;}); }
    });
    var excessPort=portRets.map(function(v){return v-RF_DAILY;});
    // OLS: regress excessPort on factors using normal equations
    function olsRegress(y, Xs){
      var m=Xs.length; var T=y.length;
      // Add intercept
      var X=[]; for(var t2=0;t2<T;t2++){var row=[1];Xs.forEach(function(f){row.push(f[t2]);});X.push(row);}
      var k=m+1;
      // X'X and X'y
      var XtX=[];for(var i=0;i<k;i++){XtX.push(new Array(k).fill(0));}
      var Xty=new Array(k).fill(0);
      X.forEach(function(row,t3){
        for(var i=0;i<k;i++){Xty[i]+=row[i]*y[t3];for(var j=0;j<k;j++){XtX[i][j]+=row[i]*row[j];}}
      });
      // Gauss-Jordan inversion
      var aug=XtX.map(function(r,i){var id=new Array(k).fill(0);id[i]=1;return r.concat(id);});
      for(var col=0;col<k;col++){
        var maxRow=col; for(var row=col+1;row<k;row++) if(Math.abs(aug[row][col])>Math.abs(aug[maxRow][col])) maxRow=row;
        var tmp=aug[col];aug[col]=aug[maxRow];aug[maxRow]=tmp;
        if(Math.abs(aug[col][col])<1e-12) continue;
        var div=aug[col][col]; for(var j2=0;j2<2*k;j2++) aug[col][j2]/=div;
        for(var row2=0;row2<k;row2++){if(row2===col)continue;var factor=aug[row2][col];for(var j3=0;j3<2*k;j3++)aug[row2][j3]-=factor*aug[col][j3];}
      }
      var inv=aug.map(function(r){return r.slice(k);});
      var betas=new Array(k).fill(0); for(var i2=0;i2<k;i2++) for(var j4=0;j4<k;j4++) betas[i2]+=inv[i2][j4]*Xty[j4];
      var yhat=X.map(function(row){var s=0;row.forEach(function(v,i){s+=v*betas[i];});return s;});
      var ss_res=y.reduce(function(s,v,i){return s+(v-yhat[i])*(v-yhat[i]);},0);
      var ymean=y.reduce(function(a,b){return a+b;})/y.length;
      var ss_tot=y.reduce(function(s,v){return s+(v-ymean)*(v-ymean);},0);
      var r2=ss_tot>0?1-ss_res/ss_tot:0;
      return {betas:betas,r2:r2,alpha_annual:betas[0]*252};
    }
    var factorKeys=Object.keys(factors);
    var Xs=factorKeys.map(function(k){return factors[k];});
    var ols=olsRegress(excessPort,Xs);
    var alphaAnn=ols.alpha_annual*100;
    var r2=ols.r2;
    // Render as metric-card grid (compatible with .metrics-row container)
    var factorDescs={
      'Market (Mkt-RF)':'Excess market sensitivity. >1 = more volatile than SPY.',
      'Size (SMB)':'Small-cap tilt. >0 = small-cap exposure, <0 = large-cap.',
      'Value (HML)':'Value tilt. >0 = value stocks, <0 = growth stocks.',
      'Momentum (MOM)':'Momentum exposure. >0 = riding winners, <0 = contrarian.'
    };
    var cardHtml='';
    factorKeys.forEach(function(k2,i){
      var beta=ols.betas[i+1];
      var col=beta>0?C.navy:C.danger;
      if(Math.abs(beta)<0.1) col=C.textSec;
      cardHtml+='<div class="metric-card" title="'+factorDescs[k2]+'">'
        +'<div class="metric-label">'+k2+'</div>'
        +'<div class="metric-value" style="color:'+col+';">'+(beta>=0?'+':'')+beta.toFixed(3)+'</div>'
        +'<div class="metric-sub" style="color:var(--text-sec);font-weight:400;">'+factorDescs[k2]+'</div>'
        +'</div>';
    });
    var alphaCol=alphaAnn>0?C.success:C.danger;
    cardHtml+='<div class="metric-card" title="Annualized Jensen\'s alpha — return that is NOT explained by the systematic factors above. Positive = true outperformance.">'
      +'<div class="metric-label">Jensen&apos;s Alpha (ann.)</div>'
      +'<div class="metric-value" style="color:'+alphaCol+';">'+(alphaAnn>=0?'+':'')+alphaAnn.toFixed(2)+'%</div>'
      +'<div class="metric-sub" style="color:var(--text-sec);font-weight:400;">Unexplained return. Positive = true alpha.</div>'
      +'</div>';
    cardHtml+='<div class="metric-card" title="How much of your portfolio return is explained by these systematic factors. Higher = more factor-driven.">'
      +'<div class="metric-label">R&sup2; (Factor Explained)</div>'
      +'<div class="metric-value" style="color:'+C.navy+';">'+(r2*100).toFixed(1)+'%</div>'
      +'<div class="metric-sub" style="color:var(--text-sec);font-weight:400;">'+n+' day window</div>'
      +'</div>';
    el.innerHTML=cardHtml;
    // Mirror to the Risk tab factor-risk box (if loaded there)
    var frEl=document.getElementById('factorRiskBox');
    if(frEl){ frEl.style.textAlign=''; frEl.innerHTML='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;">'+cardHtml+'</div>'; }

    // Store last result for risk tab factor chart
    // factorKeys: ['Market (Mkt-RF)', 'Size (SMB)', 'Value (HML)', 'Momentum (MOM)']
    window._ffLastResult = {
      mkt: ols.betas[1] || 0,
      smb: ols.betas[2] || 0,
      hml: ols.betas[3] || 0,
      rmw: 0,
      cma: 0,
      mom: ols.betas[4] || 0,
      alpha: ols.alpha_annual,
      r2: r2
    };

    // Render factor chart in risk tab
    var riskFcEl = document.getElementById('riskFactorChart');
    if (riskFcEl && window._ffLastResult) {
      if (window._riskFactorChart) window._riskFactorChart.destroy();
      var ffR = window._ffLastResult;
      var factors = ['Market (Mkt-RF)', 'Size (SMB)', 'Value (HML)', 'Momentum (MOM)'];
      var fvals = [ffR.mkt||0, ffR.smb||0, ffR.hml||0, ffR.mom||0];
      window._riskFactorChart = new Chart(riskFcEl.getContext('2d'), { type:'bar',
        data:{ labels:factors, datasets:[{ label:'Factor Loading', data:fvals.map(function(v){ return parseFloat((v||0).toFixed(3)); }),
          backgroundColor:fvals.map(function(v){ return (v||0)>=0?'rgba(0,60,113,0.7)':'rgba(139,42,42,0.7)'; }), borderWidth:0 }] },
        options:{ indexAxis:'y', responsive:true, maintainAspectRatio:false,
          plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:function(c){ return 'Loading: '+c.parsed.x.toFixed(3); } } } },
          scales:{ x:{ ticks:{ font:{size:10} } }, y:{ ticks:{ font:{size:11} }, grid:{display:false} } }
        }
      });
    }

  } catch(e){ el.innerHTML='<div class="metric-card" style="grid-column:1/-1;color:var(--danger);">Error: '+e.message+'</div>'; }
}

// ═══════════════════════════════════════════════════════════════════
// ════  REGIME-CONDITIONED RETURN DISTRIBUTIONS (Research)  ═════════
// ═══════════════════════════════════════════════════════════════════
async function rcrLoad(ticker) {
  var card=document.getElementById('rcrCard');
  var content=document.getElementById('rcrContent');
  var tickerEl=document.getElementById('rcrTicker');
  var chartWrap=document.getElementById('rcrChartWrap');
  if(!card||!content) return;
  card.style.display='';
  tickerEl.textContent=ticker;
  content.innerHTML='<div style="text-align:center;padding:14px;"><span class="spinner"></span> Computing regime-conditioned return distributions for '+ticker+'...</div>';
  chartWrap.style.display='none';
  var WORKER='https://perry-finance-proxy.zachperrybusiness.workers.dev';
  try {
    var [tickerData, spyData, vixData] = await Promise.all([
      fetch(WORKER+'/chart?symbol='+encodeURIComponent(ticker)+'&range=5y&interval=1d').then(function(r){return r.json();}),
      fetch(WORKER+'/chart?symbol=SPY&range=5y&interval=1d').then(function(r){return r.json();}),
      fetch(WORKER+'/chart?symbol=%5EVIX&range=5y&interval=1d').then(function(r){return r.json();})
    ]);
    if(tickerData.error){ content.innerHTML='<div style="color:var(--danger);padding:10px;"><strong>Worker error fetching '+ticker+':</strong> '+tickerData.error+'</div>'; return; }
    if(spyData.error || vixData.error){ content.innerHTML='<div style="color:var(--danger);padding:10px;"><strong>Worker error fetching SPY/VIX:</strong> '+(spyData.error||vixData.error)+'. Retry in a moment &mdash; Yahoo may be rate-limiting.</div>'; return; }
    var tPts=(tickerData.points||[]).filter(function(p){return p.close!=null;});
    var sPts=(spyData.points||[]).filter(function(p){return p.close!=null;});
    var vPts=(vixData.points||[]).filter(function(p){return p.close!=null;});
    if(tPts.length<63||sPts.length<252){ content.innerHTML='<div style="color:var(--warning);padding:10px;">Got '+tPts.length+' points for '+ticker+' and '+sPts.length+' for SPY &mdash; need 252+ SPY points and 63+ ticker points. Worker may be rate-limited; retry in a moment.</div>'; return; }
    // Build date → value maps
    var spyMap={},vixMap={};
    sPts.forEach(function(p){spyMap[p.date.slice(0,10)]=p.close;});
    vPts.forEach(function(p){vixMap[p.date.slice(0,10)]=p.close;});
    // For each trading day in ticker history, compute:
    //   - trailing 21-day ticker return
    //   - the regime (using SPY 252-day trailing return + VIX at that date)
    var dates=tPts.map(function(p){return p.date.slice(0,10);});
    var closes=tPts.map(function(p){return p.close;});
    // SPY closes aligned
    var spyCloses=dates.map(function(d){return spyMap[d]||null;});
    var vixCloses=dates.map(function(d){return vixMap[d]||null;});
    // Segment: for each date i >= 252+21, classify the regime at i-21 and record 21-day fwd return
    var stateReturns={leveraged:[],growth:[],neutral:[],drawdown:[]};
    var lookback=252; var fwd=21;
    for(var i=lookback+fwd;i<closes.length-fwd;i++){
      var spyNow=spyCloses[i];
      var spy12mAgo=spyCloses[i-lookback];
      var vixNow=vixCloses[i];
      if(!spyNow||!spy12mAgo||!vixNow) continue;
      var spyTrail=(spyNow-spy12mAgo)/spy12mAgo;
      var spyHigh=Math.max.apply(null,spyCloses.slice(i-lookback,i+1).filter(Boolean));
      var ddFromPeak=(spyNow-spyHigh)/spyHigh;
      var spyLow=Math.min.apply(null,spyCloses.slice(i-lookback,i+1).filter(Boolean));
      var fromLow=(spyNow-spyLow)/spyLow;
      var signals={vix:vixNow,spyTrailingReturn:spyTrail,drawdownFromPeak:ddFromPeak,spy12mFromLow:fromLow};
      var cl=psClassifyState(signals);
      var fwdRet=(closes[i+fwd]-closes[i])/closes[i]*100;
      stateReturns[cl.winner].push(fwdRet);
    }
    // Compute stats per state
    function pct(arr,p){var s=arr.slice().sort(function(a,b){return a-b;});return s[Math.floor(p*s.length/100)]||0;}
    function median(arr){return pct(arr,50);}
    function hitRate(arr){return arr.length?arr.filter(function(v){return v>0;}).length/arr.length*100:0;}
    var stateColors={leveraged:PS_STATES[0].color,growth:PS_STATES[1].color,neutral:PS_STATES[2].color,drawdown:PS_STATES[3].color};
    var stateNames={leveraged:'Leveraged',growth:'Non-Levered Growth',neutral:'Neutral',drawdown:'Positioned for Drawdown'};
    var stateKeys=['leveraged','growth','neutral','drawdown'];
    var tableHtml='<div class="rcr-grid">';
    stateKeys.forEach(function(sk){
      var arr=stateReturns[sk];
      if(!arr.length){ tableHtml+='<div class="rcr-card"><div class="rcr-card-header" style="background:'+stateColors[sk]+';">'+stateNames[sk]+'</div><div class="rcr-card-body" style="color:var(--text-sec);font-size:11px;font-style:italic;">Insufficient historical observations</div></div>'; return; }
      var med=median(arr), p10=pct(arr,10), p90=pct(arr,90), hr=hitRate(arr), n=arr.length;
      var medCol=med>=0?C.success:C.danger;
      tableHtml+='<div class="rcr-card">'
        +'<div class="rcr-card-header" style="background:'+stateColors[sk]+';">'+stateNames[sk]+' (n='+n+')</div>'
        +'<div class="rcr-card-body">'
        +'<div class="rcr-stat-row"><span>Median 21D Return</span><span style="font-weight:700;color:'+medCol+';">'+(med>=0?'+':'')+med.toFixed(2)+'%</span></div>'
        +'<div class="rcr-stat-row"><span>P10 – P90</span><span style="font-weight:600;">'+(p10>=0?'+':'')+p10.toFixed(1)+'% to +'+(p90>=0?'+':'')+p90.toFixed(1)+'%</span></div>'
        +'<div class="rcr-stat-row"><span>Hit Rate (>0%)</span><span style="font-weight:600;color:'+(hr>=50?C.success:C.danger)+';">'+hr.toFixed(0)+'%</span></div>'
        +'</div></div>';
    });
    tableHtml+='</div>';
    content.innerHTML=tableHtml;
    // Bar chart: median returns per state
    chartWrap.style.display='block';
    if(window._rcrChart) window._rcrChart.destroy();
    window._rcrChart=new Chart(document.getElementById('rcrChart').getContext('2d'),{
      type:'bar',
      data:{
        labels:stateKeys.map(function(sk){return stateNames[sk];}),
        datasets:[
          {label:'Median 21-Day Return (%)',data:stateKeys.map(function(sk){var a=stateReturns[sk];return a.length?+median(a).toFixed(2):null;}),backgroundColor:stateKeys.map(function(sk){return stateColors[sk];}),borderWidth:0,borderRadius:3},
          {label:'P90',data:stateKeys.map(function(sk){var a=stateReturns[sk];return a.length?+pct(a,90).toFixed(2):null;}),type:'scatter',pointBackgroundColor:stateKeys.map(function(sk){return stateColors[sk];}),pointRadius:6,showLine:false},
          {label:'P10',data:stateKeys.map(function(sk){var a=stateReturns[sk];return a.length?+pct(a,10).toFixed(2):null;}),type:'scatter',pointBackgroundColor:stateKeys.map(function(sk){return stateColors[sk];}),pointRadius:6,showLine:false,pointStyle:'triangle'},
        ]
      },
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{font:{size:10},color:C.textSec}},tooltip:chartTooltip},
        scales:{x:{grid:chartGrid,ticks:chartTicks},y:{grid:chartGrid,ticks:Object.assign({},chartTicks,{callback:function(v){return v+'%';}}),title:{display:true,text:'21-Day Return (%)',color:C.textSec,font:{size:11}}}}}
    });
  } catch(e){ content.innerHTML='<div style="color:var(--danger);padding:10px;">Error: '+e.message+'</div>'; }
}

// ═══════════════════════════════════════════════════════════════════
// ══════  PORTFOLIO-STATE MONTE CARLO  ══════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// State-conditioned parameters (annualized drift, vol) derived from SPY history
/* ════════════════════════════════════════════════════════════════════════════
   STATE-CONDITIONED MONTE CARLO PARAMETERS — rebuilt 2026-07-24.

   WHAT WAS HERE:
     leveraged: driftAnn +0.28  volAnn 0.35
     growth:    driftAnn +0.14  volAnn 0.18
     neutral:   driftAnn +0.04  volAnn 0.14
     drawdown:  driftAnn -0.12  volAnn 0.28
   commented "derived from SPY history".

   WHY IT WAS WRONG:
   Those are REALISED, STATE-CONDITIONAL averages being used as FORWARD drifts.
   The "leveraged" state is defined by SPY already being down 15-20%, so its
   +28% figure is the average rebound that historically followed — conditioning
   on the outcome. A user whose portfolio was flagged "leveraged" saw a forecast
   compounding at 28%/yr, while the Advisor page told the same user 8.5%. Same
   portfolio, same site, a 20-point disagreement.

   WHAT IT IS NOW:
   The shared capital-market assumption (PerrySignals.CONST.CMA.us_equity) plus a
   bounded regime tilt (±3pp, enforced by REGIME_TILT_CAP). Volatility IS
   genuinely state-dependent — realised vol really does run ~2x higher in stress
   than in calm — so the vol multipliers are retained, and now documented as
   multipliers on the base rather than as absolute levels.
   ════════════════════════════════════════════════════════════════════════════ */
function _smcBase() {
  var S = window.PerrySignals;
  return S ? { mu: S.CONST.CMA.us_equity.mu, sig: S.CONST.CMA.us_equity.sig }
           : { mu: 0.077, sig: 0.160 };
}

/* Drift tilt in pp, and vol as a MULTIPLE of the base. State keys keep their
   legacy names for back-compat; the unified labels come from
   PerrySignals.TREND_STATES so the naming is consistent site-wide. */
var SMC_STATE_ADJ = {
  leveraged: { driftTilt: +0.03, volMult: 1.9, label: 'Accumulate (post-decline)', color: '#2E7D52',
               note: 'Volatility runs high after a large decline; the drift tilt is capped at +3pp rather than extrapolating the historical rebound.' },
  growth:    { driftTilt: +0.02, volMult: 1.1, label: 'Risk-On',    color: '#003C71',
               note: 'Constructive trend, contained volatility.' },
  neutral:   { driftTilt:  0.00, volMult: 1.0, label: 'Neutral',    color: '#8B6914',
               note: 'Base-case assumption with no tilt applied.' },
  drawdown:  { driftTilt: -0.02, volMult: 1.6, label: 'De-Risk',    color: '#8B2A2A',
               note: 'Extended market with elevated realised volatility; modest negative drift tilt.' }
};

/** Built as a getter so it always reflects the current shared CMA. */
function smcParams() {
  var base = _smcBase();
  var out = {};
  Object.keys(SMC_STATE_ADJ).forEach(function (k) {
    var a = SMC_STATE_ADJ[k];
    out[k] = {
      driftAnn: base.mu + a.driftTilt,
      volAnn: base.sig * a.volMult,
      label: a.label, color: a.color, note: a.note,
      baseMu: base.mu, tilt: a.driftTilt, volMult: a.volMult
    };
  });
  return out;
}

/* Kept as a live object for the existing consumers that index it directly. */
var SMC_PARAMS = smcParams();

async function smcRun() {
  var tabsEl=document.getElementById('smcTabs');
  var resultsEl=document.getElementById('smcResults');
  var wrapEl=document.getElementById('smcChartWrap');
  var statsEl=document.getElementById('smcStats');
  // Card was removed and Monte Carlo is now part of the Portfolio Value chart.
  // Quietly no-op if the legacy card DOM isn't present.
  if (!tabsEl || !resultsEl || !wrapEl || !statsEl) { console.info('[smcRun] standalone card removed; use the Forecast Regime dropdown on the Portfolio Value chart instead.'); return; }
  resultsEl.innerHTML='<div style="text-align:center;padding:14px;"><span class="spinner"></span> Running Monte Carlo simulation across 4 portfolio states...</div>';
  resultsEl.style.display='block';
  tabsEl.style.display='none'; wrapEl.style.display='none'; statsEl.style.display='none';
  var holdings=window._holdings||[];
  if(!holdings.length){ resultsEl.innerHTML='<div style="color:var(--danger);padding:10px;">No holdings to simulate. Add holdings first.</div>'; return; }
  // Compute portfolio current value
  var tv=0;
  holdings.forEach(function(h){ var isCash=h.assetClass==='Cash'||h.assetClass==='Money Market'||h.assetClass==='CD'||h.assetClass==='Bond Position'; tv+=isCash?(h.costBasis||0)*h.quantity:(h.currentPrice||0)*h.quantity; });
  if(tv<=0){ resultsEl.innerHTML='<div style="color:var(--danger);padding:10px;">Portfolio value is $0 — ensure prices are refreshed.</div>'; return; }
  var N=1000, T=252;
  // Box-Muller normal sampler
  function randn(){ var u=0,v=0; while(!u)u=Math.random(); while(!v)v=Math.random(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); }
  // Run GBM for all states
  var smcData={};
  var dt=1/252;
  Object.keys(SMC_PARAMS).forEach(function(sk){
    var p=SMC_PARAMS[sk];
    var mu=p.driftAnn, sig=p.volAnn;
    var paths=[];
    for(var path=0;path<N;path++){
      var vals=[tv];
      for(var t3=1;t3<=T;t3++){
        var prev=vals[vals.length-1];
        vals.push(prev*Math.exp((mu-0.5*sig*sig)*dt+sig*Math.sqrt(dt)*randn()));
      }
      paths.push(vals);
    }
    // Compute percentile bands
    var p10=[],p50=[],p90=[];
    for(var day=0;day<=T;day++){
      var dayVals=paths.map(function(p2){return p2[day];}).sort(function(a,b){return a-b;});
      p10.push(dayVals[Math.floor(0.10*N)]); p50.push(dayVals[Math.floor(0.50*N)]); p90.push(dayVals[Math.floor(0.90*N)]);
    }
    smcData[sk]={p10:p10,p50:p50,p90:p90,terminalPaths:paths.map(function(p2){return p2[T];})};
  });
  // Build tabs + chart
  var stateKeys=Object.keys(SMC_PARAMS);
  window._smcData=smcData; window._smcActiveState=stateKeys[0];
  tabsEl.style.display='flex';
  tabsEl.innerHTML=stateKeys.map(function(sk){
    var p=SMC_PARAMS[sk]; return '<div class="smc-tab'+(sk===stateKeys[0]?' active':'')+'" style="'+(sk===stateKeys[0]?'background:'+p.color+';color:#fff;':'')+'border-color:'+p.color+';" onclick="smcSetState(\''+sk+'\')">'+p.label+'</div>';
  }).join('');
  resultsEl.style.display='none';
  wrapEl.style.display='block'; statsEl.style.display='flex';
  smcRenderChart(stateKeys[0],tv);
}

function smcSetState(sk){
  window._smcActiveState=sk;
  document.querySelectorAll('.smc-tab').forEach(function(t,i){
    var stateKeys=Object.keys(SMC_PARAMS);
    var thisSk=stateKeys[i];
    var p=SMC_PARAMS[thisSk];
    t.className='smc-tab'+(thisSk===sk?' active':'');
    if(thisSk===sk){t.style.background=p.color;t.style.color='#fff';}
    else{t.style.background='';t.style.color='';}
  });
  var tv=0;(window._holdings||[]).forEach(function(h){var isCash=h.assetClass==='Cash'||h.assetClass==='Money Market'||h.assetClass==='CD'||h.assetClass==='Bond Position';tv+=isCash?(h.costBasis||0)*h.quantity:(h.currentPrice||0)*h.quantity;});
  smcRenderChart(sk,tv);
}

function smcRenderChart(sk,tv){
  var d=window._smcData[sk]; var p=SMC_PARAMS[sk];
  var statsEl=document.getElementById('smcStats');
  var termMed=d.p50[d.p50.length-1];
  var termP10=d.p10[d.p10.length-1];
  var termP90=d.p90[d.p90.length-1];
  var retMed=(termMed-tv)/tv*100;
  var prob0=d.terminalPaths.filter(function(v){return v>tv;}).length/d.terminalPaths.length*100;
  statsEl.innerHTML=
    '<div class="chart-stat-box"><div class="chart-stat-label">Starting Value</div><div class="chart-stat-value">'+fmtInt(tv)+'</div></div>'
    +'<div class="chart-stat-box"><div class="chart-stat-label">P50 Outcome (1Y)</div><div class="chart-stat-value">'+fmtInt(termMed)+'</div><div class="chart-stat-sub">'+(retMed>=0?'+':'')+retMed.toFixed(1)+'% return</div></div>'
    +'<div class="chart-stat-box"><div class="chart-stat-label">P10 (Bear)</div><div class="chart-stat-value">'+fmtInt(termP10)+'</div><div class="chart-stat-sub">'+(((termP10-tv)/tv*100)).toFixed(1)+'%</div></div>'
    +'<div class="chart-stat-box"><div class="chart-stat-label">P90 (Bull)</div><div class="chart-stat-value">'+fmtInt(termP90)+'</div><div class="chart-stat-sub">+'+((termP90-tv)/tv*100).toFixed(1)+'%</div></div>'
    +'<div class="chart-stat-box"><div class="chart-stat-label">Prob. Gain</div><div class="chart-stat-value" style="color:'+(prob0>=50?C.success:C.danger)+';">'+prob0.toFixed(0)+'%</div></div>';
  var labels=Array.from({length:253},function(_,i){return i===0?'Today':i===252?'12M':i%63===0?(i/21)+'M':'';});
  var datasets=[
    {label:'P90 (Bull)',data:d.p90,borderColor:'rgba('+hexToRgb(p.color)+',0.3)',borderWidth:1,borderDash:[3,2],pointRadius:0,fill:false},
    {label:'Median (P50)',data:d.p50,borderColor:p.color,borderWidth:2.5,pointRadius:0,fill:false},
    {label:'P10 (Bear)',data:d.p10,borderColor:'rgba('+hexToRgb(p.color)+',0.3)',borderWidth:1,borderDash:[3,2],pointRadius:0,fill:'-2',backgroundColor:'rgba('+hexToRgb(p.color)+',0.08)'},
    {label:'Starting Value',data:Array(253).fill(tv),borderColor:C.textSec,borderWidth:1,borderDash:[4,4],pointRadius:0,fill:false},
  ];
  if(window._smcChart) window._smcChart.destroy();
  window._smcChart=new Chart(document.getElementById('smcChart').getContext('2d'),{
    type:'line',data:{labels:labels,datasets:datasets},
    options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'nearest',intersect:false},
      plugins:{legend:{position:'bottom',labels:{font:{size:10},color:C.textSec}},tooltip:Object.assign({},chartTooltip,{callbacks:{label:function(ctx){return ctx.dataset.label+': '+fmtInt(ctx.parsed.y);}}})},
      scales:{x:{grid:chartGrid,ticks:chartTicks},y:{grid:chartGrid,ticks:Object.assign({},chartTicks,{callback:function(v){return '$'+Math.round(v/1000)+'K';}})}}}
  });
}

function hexToRgb(hex){ hex=hex.replace('#',''); var r=parseInt(hex.substring(0,2),16),g=parseInt(hex.substring(2,4),16),b=parseInt(hex.substring(4,6),16); return r+','+g+','+b; }

// ═══════════════════════════════════════════════════════════════════
// ══════════  LEADING INDICATOR COMPOSITE ENGINE  ═══════════════════
// ═══════════════════════════════════════════════════════════════════
function licRender(macroData) {
  var el=document.getElementById('licContent');
  var chartWrap=document.getElementById('licChartWrap');
  if(!el) return;
  if(!macroData||!macroData.pillars){el.innerHTML='<div style="color:var(--text-sec);font-size:12px;">FRED data not yet loaded. Navigate back to Macro Regime Analysis and wait for the scorecard to load, then return to see this composite.</div>';return;}
  var tiers=[
    {
      label:'Tier 1 — 6-12 Month Lead (Earliest Signal)',
      indicators:[
        {name:'Yield Curve (3M/10Y)',pillar:'Monetary Policy',lookup:'T10Y3M'},
        {name:'JOLTS Job Openings',pillar:'Labor Market',lookup:'JOLTS'},
        {name:'HY OAS vs 12M Avg',pillar:'Monetary Policy',lookup:'BAMLH0A0HYM2'},
        {name:'SLOOS C&I Standards',pillar:'Monetary Policy',lookup:'DRTSCILM'},
      ]
    },
    {
      label:'Tier 2 — 4-6 Month Lead',
      indicators:[
        {name:'Initial Claims 4W MA',pillar:'Labor Market',lookup:'IC4WSA'},
        {name:'5Y5Y Breakeven',pillar:'Inflation',lookup:'T5YIFR'},
        {name:'Core PCE YoY Trend',pillar:'Inflation',lookup:'PCEPILFE'},
      ]
    },
    {
      label:'Tier 3 — 2-3 Month Lead (Shortest Signal)',
      indicators:[
        {name:'Industrial Production',pillar:'Growth Analysis',lookup:'INDPRO'},
        {name:'NFP 3-Month Avg',pillar:'Labor Market',lookup:'PAYEMS'},
        {name:'Capacity Utilization',pillar:'Growth Analysis',lookup:'TCU'},
        {name:'Durable Goods Orders',pillar:'Growth Analysis',lookup:'DGORDER'},
      ]
    }
  ];
  // Build lookup of indicator scores from macroData.pillars
  var scoreByName={};
  (macroData.pillars||[]).forEach(function(p){
    (p.indicators||[]).forEach(function(ind){
      scoreByName[ind.indicator]={score:ind.score,value:ind.value,detail:ind.detail};
    });
  });
  // Partial match function
  function findScore(name){
    var keys=Object.keys(scoreByName);
    for(var i=0;i<keys.length;i++) if(keys[i].toLowerCase().indexOf(name.toLowerCase().split(' ')[0])>=0) return scoreByName[keys[i]];
    return null;
  }
  var tierScores=[0,0,0];
  var tierCounts=[0,0,0];
  var html='';
  tiers.forEach(function(tier,ti){
    html+='<div class="lic-tier-header">'+tier.label+'</div>';
    html+='<div style="border:1px solid var(--border);border-top:none;border-radius:0 0 4px 4px;margin-bottom:10px;">';
    tier.indicators.forEach(function(ind){
      var sd=findScore(ind.name);
      var score=sd?sd.score:null;
      var val=sd?sd.value:'—';
      var detail=sd?sd.detail:'';
      var col=score===1?C.success:score===-1?C.danger:C.textSec;
      var label=score===1?'Expansion':score===-1?'Contraction':'Neutral';
      if(score!==null){tierScores[ti]+=score;tierCounts[ti]++;}
      var barW=score===1?100:score===-1?100:50;
      var barCol=score===1?C.success:score===-1?C.danger:C.textSec;
      html+='<div class="lic-indicator-row">'
        +'<span style="flex:1;font-weight:600;">'+ind.name+'</span>'
        +'<span style="color:var(--text-sec);font-size:11px;margin-right:10px;">'+val+(detail?' | '+detail:'')+'</span>'
        +'<span style="font-size:11px;font-weight:700;color:'+col+';min-width:80px;text-align:right;">'+label+'</span>'
        +'<div class="lic-bar-wrap"><div class="lic-bar-fill" style="width:'+barW+'%;background:'+barCol+';"></div></div>'
        +'</div>';
    });
    html+='</div>';
  });
  // Summary divergence signal
  var t1Pct=tierCounts[0]>0?(tierScores[0]/tierCounts[0]):0;
  var t3Pct=tierCounts[2]>0?(tierScores[2]/tierCounts[2]):0;
  var signal='';
  if(t1Pct<-0.3&&t3Pct>0.3) signal='<strong style="color:var(--danger);">⚠ DIVERGENCE SIGNAL: Tier 1 deteriorating while Tier 3 still solid → consider early de-risking.</strong>';
  else if(t1Pct>0.3&&t3Pct<-0.3) signal='<strong style="color:var(--success);">▲ OPPORTUNITY SIGNAL: Tier 1 recovering while Tier 3 still weak → consider early re-risking.</strong>';
  else signal='<span style="color:var(--text-sec);">No tier divergence detected — indicators moving in parallel.</span>';
  el.innerHTML='<div style="background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:10px 14px;margin-bottom:12px;font-size:12px;">'+signal+'</div>'+html;
}

// Hook: render LIC whenever macro data loads
var _origLoadMacroLiveTable=window.loadMacroLiveTable;

// ═══════════════════════════════════════════════════════════════════
// ═══════════ 1. OPTIONS IV + IV PERCENTILE ENGINE ══════════════════
// ═══════════════════════════════════════════════════════════════════
async function ivLoad(ticker, expiry) {
  var card = document.getElementById('ivCard');
  var statsEl = document.getElementById('ivStats');
  var wrapEl = document.getElementById('ivChartWrap');
  var tickerEl = document.getElementById('ivTicker');
  var expiryRow = document.getElementById('ivExpiryRow');
  var expirySel = document.getElementById('ivExpirySelect');
  var strikeTableEl = document.getElementById('ivStrikeTable');
  if (!statsEl) return; // card may be in hidden tab — elements still exist in DOM
  // Don't require card visibility — just update DOM elements; tab will show them when active
  if (tickerEl) tickerEl.textContent = ticker;
  statsEl.innerHTML = '<div style="padding:10px;"><span class="spinner"></span> Loading options chain for '+ticker+(expiry?' (exp '+expiry+')':'')+'...</div>';
  if (wrapEl) wrapEl.style.display = 'none';
  if (strikeTableEl) strikeTableEl.style.display = 'none';
  try {
    var WORKER = "https://perry-finance-proxy.zachperrybusiness.workers.dev";
    var url = WORKER + '/options?symbol=' + encodeURIComponent(ticker);
    if (expiry) url += '&expiry=' + encodeURIComponent(expiry);
    var res;
    try { res = await fetch(url); }
    catch(netErr) {
      statsEl.innerHTML = '<div style="color:var(--danger);padding:10px;"><strong>Network error:</strong> Cannot reach Cloudflare Worker.<br><span style="font-size:11px;">'+netErr.message+'</span></div>';
      if(expiryRow) expiryRow.style.display='none'; return;
    }
    if (!res.ok) {
      statsEl.innerHTML = '<div style="color:var(--danger);padding:10px;"><strong>Worker returned HTTP '+res.status+':</strong> the /options endpoint may not be deployed. Push the latest cloudflare-worker.js to the perry-finance-proxy Worker.</div>';
      if(expiryRow) expiryRow.style.display='none'; return;
    }
    var d;
    try { d = await res.json(); }
    catch(parseErr) {
      statsEl.innerHTML = '<div style="color:var(--danger);padding:10px;"><strong>Could not parse Worker response:</strong> '+parseErr.message+'</div>';
      if(expiryRow) expiryRow.style.display='none'; return;
    }
    if (d.error) { statsEl.innerHTML = '<div style="color:var(--warning);padding:10px;"><strong>Worker:</strong> '+d.error+'<br><span style="font-size:11px;color:var(--text-sec);">This is normal for crypto, some mutual funds, or thinly-traded names without listed options.</span></div>'; if(expiryRow) expiryRow.style.display='none'; return; }
    if (!d.fetchedExpiry && !d.nearestExpiry) { statsEl.innerHTML = '<div style="color:var(--warning);padding:10px;">No expiry data returned for '+ticker+'.</div>'; if(expiryRow) expiryRow.style.display='none'; return; }

    // Populate expiry selector if not yet populated for this ticker
    if (expirySel && d.expiryInfo && d.expiryInfo.length) {
      var currentTicker = expirySel.getAttribute('data-ticker') || '';
      if (currentTicker !== ticker) {
        expirySel.innerHTML = '';
        d.expiryInfo.forEach(function(e){
          var opt = document.createElement('option');
          opt.value = e.timestamp;
          opt.textContent = e.date + '  (' + e.daysToExpiry + ' days out)';
          expirySel.appendChild(opt);
        });
        expirySel.setAttribute('data-ticker', ticker);
      }
      // Sync selector to currently fetched expiry
      var fetched = d.fetchedExpiry || d.nearestExpiry;
      if (fetched && fetched.timestamp) expirySel.value = fetched.timestamp;
      if(expiryRow) expiryRow.style.display = '';
    }

    // Sanity-check IV. Yahoo returns IV as a decimal (e.g., 0.45 = 45%). If a value
    // comes back > 5, assume it's already in percent form and divide by 100.
    function normIV(v){ if(v==null||v<=0) return null; return v > 5 ? v/100 : v; }
    var atmIV = normIV(d.atmImpliedVol);
    var hv20 = d.hv20Day;
    var ivPct = d.ivPercentile;

    var pctCol = ivPct == null ? C.textSec : ivPct >= 80 ? C.danger : ivPct >= 50 ? C.warning : ivPct >= 20 ? C.navy : C.success;
    var pctLabel = ivPct == null ? 'N/A' : ivPct >= 80 ? 'Expensive' : ivPct >= 50 ? 'Elevated' : ivPct >= 20 ? 'Normal' : 'Cheap';
    var pcRatio = d.putCallOIRatio;
    var pcCol = pcRatio == null ? C.textSec : pcRatio > 1.2 ? C.success : pcRatio < 0.7 ? C.danger : C.textSec;
    var pcLabel = pcRatio == null ? '—' : pcRatio > 1.2 ? 'Bearish positioning (contrarian bull)' : pcRatio < 0.7 ? 'Bullish positioning (contrarian bear)' : 'Neutral';
    var mpDiff = (d.maxPain != null && d.currentPrice) ? ((d.maxPain - d.currentPrice) / d.currentPrice * 100) : null;
    var ivHvSpread = (atmIV != null && hv20 != null) ? (atmIV - hv20) : null;
    var fetchedExp = d.fetchedExpiry || d.nearestExpiry;

    statsEl.innerHTML =
      '<div class="chart-stat-box"><div class="chart-stat-label">ATM IV (Annualized) <span class="help-icon" title="Implied Volatility on the at-the-money option, annualized. Reflects the market\'s expected move size.">?</span></div><div class="chart-stat-value">' + (atmIV != null ? (atmIV*100).toFixed(1)+'%' : '—') + '</div><div class="chart-stat-sub">'+(fetchedExp ? 'Expiry: '+fetchedExp.date+' ('+fetchedExp.daysToExpiry+'d)' : '—')+'</div></div>' +
      '<div class="chart-stat-box"><div class="chart-stat-label">IV Percentile (1Y) <span class="help-icon" title="Where today\'s ATM IV sits in the past year\'s distribution. 80%+ = expensive options, 20%- = cheap options.">?</span></div><div class="chart-stat-value" style="color:'+pctCol+';">' + (ivPct != null ? ivPct.toFixed(0)+'%' : '—') + '</div><div class="chart-stat-sub">'+pctLabel+'</div></div>' +
      '<div class="chart-stat-box"><div class="chart-stat-label">20-Day Realized Vol <span class="help-icon" title="Actual price volatility over last 20 trading days, annualized. Compare to ATM IV.">?</span></div><div class="chart-stat-value">' + (hv20 != null ? (hv20*100).toFixed(1)+'%' : '—') + '</div><div class="chart-stat-sub">IV-HV spread: ' + (ivHvSpread != null ? (ivHvSpread >= 0 ? '+' : '')+(ivHvSpread*100).toFixed(1)+'%' : '—') + '</div></div>' +
      '<div class="chart-stat-box"><div class="chart-stat-label">Put/Call OI Ratio <span class="help-icon" title="Ratio of put OI to call OI. &gt; 1.2 = bearish, &lt; 0.7 = bullish, around 1 = neutral.">?</span></div><div class="chart-stat-value" style="color:'+pcCol+';">' + (pcRatio != null ? pcRatio.toFixed(2) : '—') + '</div><div class="chart-stat-sub">'+pcLabel+'</div></div>' +
      '<div class="chart-stat-box"><div class="chart-stat-label">Max Pain <span class="help-icon" title="Strike where total option-writer losses are minimized at expiry.">?</span></div><div class="chart-stat-value">' + (d.maxPain != null ? '$'+d.maxPain.toFixed(2) : '—') + '</div><div class="chart-stat-sub">'+(mpDiff != null ? (mpDiff >= 0 ? '+' : '')+mpDiff.toFixed(1)+'% from price' : '—')+'</div></div>';

    // Build strike distribution chart, filter only strikes with meaningful data
    var calls = (d.callStrikes || []).filter(function(c){ return (c.openInterest||0) > 0 || (c.volume||0) > 0; });
    var puts  = (d.putStrikes  || []).filter(function(p){ return (p.openInterest||0) > 0 || (p.volume||0) > 0; });
    if (calls.length === 0 && puts.length === 0) {
      wrapEl.style.display = 'none';
      strikeTableEl.style.display = 'block';
      strikeTableEl.innerHTML = '<div style="background:#fff8e8;border:1px solid #f0e0a8;border-radius:4px;padding:10px;font-size:12px;color:#8B6914;">No open interest at any strike for this expiration. Try a different expiration with more activity.</div>';
      return;
    }
    var allStrikes = [];
    var seen = {};
    calls.forEach(function(c){ if(!seen[c.strike]){ seen[c.strike]=true; allStrikes.push(c.strike); } });
    puts.forEach(function(p){ if(!seen[p.strike]){ seen[p.strike]=true; allStrikes.push(p.strike); } });
    allStrikes.sort(function(a,b){return a-b;});
    // If too many strikes, focus on those nearest to current price
    var px = d.currentPrice || 0;
    if (allStrikes.length > 30 && px > 0) {
      allStrikes.sort(function(a,b){ return Math.abs(a-px) - Math.abs(b-px); });
      allStrikes = allStrikes.slice(0, 30).sort(function(a,b){return a-b;});
    }
    var callMap={}, putMap={};
    calls.forEach(function(c){ callMap[c.strike] = c; });
    puts.forEach(function(p){ putMap[p.strike] = p; });
    var callOI = allStrikes.map(function(s){ return callMap[s] ? (callMap[s].openInterest||0) : 0; });
    var putOI  = allStrikes.map(function(s){ return putMap[s]  ? (putMap[s].openInterest||0)  : 0; });
    var callIV = allStrikes.map(function(s){ var c=callMap[s]; var v=c?normIV(c.impliedVolatility):null; return v!=null ? +(v*100).toFixed(1) : null; });
    var putIV  = allStrikes.map(function(s){ var p=putMap[s];  var v=p?normIV(p.impliedVolatility):null; return v!=null ? +(v*100).toFixed(1) : null; });

    wrapEl.style.display = 'block';
    try {
      if (window._ivChart) window._ivChart.destroy();
      window._ivChart = new Chart(document.getElementById('ivChart').getContext('2d'), {
      data: {
        labels: allStrikes.map(function(s){return '$'+s;}),
        datasets: [
          { type: 'bar', label: 'Call Open Interest', data: callOI, backgroundColor: 'rgba(0,60,113,0.55)', borderColor: C.navy, borderWidth: 1, yAxisID: 'yOI', order: 2 },
          { type: 'bar', label: 'Put Open Interest', data: putOI, backgroundColor: 'rgba(139,42,42,0.55)', borderColor: C.danger, borderWidth: 1, yAxisID: 'yOI', order: 2 },
          { type: 'line', label: 'Call IV %', data: callIV, borderColor: C.blue, backgroundColor: C.blue, borderWidth: 2, pointRadius: 3, fill: false, yAxisID: 'yIV', tension: 0.2, spanGaps: true, order: 1 },
          { type: 'line', label: 'Put IV %', data: putIV, borderColor: C.warning, backgroundColor: C.warning, borderWidth: 2, pointRadius: 3, fill: false, yAxisID: 'yIV', tension: 0.2, spanGaps: true, order: 1 }
        ]
      },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { font:{size:10}, color: C.textSec } }, tooltip: chartTooltip },
        scales: {
          x: { grid: chartGrid, ticks: chartTicks, title: { display: true, text: 'Strike Price (current spot $'+(px||0).toFixed(2)+')', color: C.textSec, font:{size:11} } },
          yOI: { type: 'linear', position: 'left', grid: chartGrid, ticks: chartTicks, title: { display: true, text: 'Open Interest', color: C.textSec, font:{size:11} } },
          yIV: { type: 'linear', position: 'right', grid: { display: false }, ticks: Object.assign({}, chartTicks, { callback: function(v){return v+'%';} }), title: { display: true, text: 'IV (%)', color: C.textSec, font:{size:11} } }
        }
      }
    });
    } catch(chartErr) {
      // Chart failed but stats already rendered — show a warning, keep going
      wrapEl.style.display = 'none';
      console.error('IV chart render failed:', chartErr);
    }

    // Render compact ATM strike table — top 5 strikes around the spot price
    if (strikeTableEl && px > 0) {
      var nearStrikes = allStrikes.slice().sort(function(a,b){ return Math.abs(a-px) - Math.abs(b-px); }).slice(0, 7).sort(function(a,b){ return a-b; });
      var rows = nearStrikes.map(function(s){
        var c = callMap[s] || {};
        var p = putMap[s] || {};
        var cIV = normIV(c.impliedVolatility);
        var pIV = normIV(p.impliedVolatility);
        return '<tr>' +
          '<td style="font-weight:700;color:'+(s>=px?C.success:C.danger)+';">$'+s.toFixed(2)+'</td>' +
          '<td>'+(c.lastPrice != null ? '$'+c.lastPrice.toFixed(2) : '—')+'</td>' +
          '<td>'+(c.openInterest||0).toLocaleString()+'</td>' +
          '<td>'+(cIV != null ? (cIV*100).toFixed(1)+'%' : '—')+'</td>' +
          '<td>'+(p.lastPrice != null ? '$'+p.lastPrice.toFixed(2) : '—')+'</td>' +
          '<td>'+(p.openInterest||0).toLocaleString()+'</td>' +
          '<td>'+(pIV != null ? (pIV*100).toFixed(1)+'%' : '—')+'</td>' +
          '</tr>';
      }).join('');
      strikeTableEl.style.display = 'block';
      strikeTableEl.innerHTML = '<div style="background:var(--navy);color:#fff;padding:6px 12px;font-size:12px;font-weight:700;border-radius:4px 4px 0 0;">Strike Detail (nearest to spot)</div>'
        + '<div style="border:1px solid var(--border);border-top:none;border-radius:0 0 4px 4px;overflow-x:auto;">'
        + '<table style="margin:0;"><thead><tr><th>Strike</th><th>Call $</th><th>Call OI</th><th>Call IV</th><th>Put $</th><th>Put OI</th><th>Put IV</th></tr></thead><tbody>'
        + rows + '</tbody></table></div>';
    }
  } catch(e) { 
    statsEl.innerHTML = '<div style="color:var(--danger);padding:10px;"><strong>Options load error:</strong> '+e.message+'<br><span style="font-size:11px;color:var(--text-sec);">Check browser console for full stack trace. If this persists, the Cloudflare Worker may not be running the latest code with the /options route.</span></div>';
    console.error('ivLoad error:', e);
  }
}

// ═══════════════════════════════════════════════════════════════════
// ═══════════ INTRINSIC VALUE — MULTI-METHOD VALUATION ══════════════
// ═══════════════════════════════════════════════════════════════════
// Sector P/E benchmarks (S&P 500 GICS sector medians, rolling 5yr) — used as
// fallback when peer multiples aren't available.
var SECTOR_PE = {
  'Information Technology': 28, 'Technology': 28,
  'Health Care': 19, 'Healthcare': 19,
  'Financials': 13, 'Financial Services': 13,
  'Consumer Discretionary': 22,
  'Consumer Staples': 21,
  'Consumer Defensive': 21,
  'Industrials': 19,
  'Communication Services': 18,
  'Energy': 12,
  'Utilities': 17,
  'Materials': 16, 'Basic Materials': 16,
  'Real Estate': 25
};

async function ivvLoad(ticker, secData){
  var resEl = document.getElementById('ivvResults');
  if (!resEl) return;
  resEl.innerHTML = '<div style="padding:14px;text-align:center;"><span class="spinner"></span> Computing intrinsic value via Forward P/E, DCF, and Dividend Discount...</div>';

  try {
    var WORKER = "https://perry-finance-proxy.zachperrybusiness.workers.dev";
    var d = secData || window._lastSecData;
    if (!d) {
      var fr = await fetch(WORKER + '/fundamentals?symbol=' + encodeURIComponent(ticker));
      d = await fr.json();
    }

    var px = d.price && d.price.current ? d.price.current : null;
    var sector = d.profile && d.profile.sector ? d.profile.sector : '';
    var sharesOut = null;
    if (d.balanceSheet && d.balanceSheet.sharesOutstanding && d.balanceSheet.sharesOutstanding.length) {
      sharesOut = d.balanceSheet.sharesOutstanding[d.balanceSheet.sharesOutstanding.length-1].value;
    }
    var marketCap = d.profile && d.profile.marketCap ? d.profile.marketCap : (px && sharesOut ? px * sharesOut : null);

    if (!px) { resEl.innerHTML = '<div style="color:var(--warning);padding:10px;">Cannot compute intrinsic value &mdash; current price missing.</div>'; return; }

    // Fetch 10Y Treasury for discount rate
    var tenY = 4.2; // sane fallback
    try {
      var fr2 = await fetch(WORKER + '/fred');
      var fred = await fr2.json();
      var t10obs = fred && fred.pillars ? null : null;
      // Try to find a 10Y or yield-curve reading; otherwise stick with fallback
      // FRED endpoint scorecard exposes 3M/10Y spread; extract from raw if available
      // Safer: just keep fallback unless FRED clearly provides DGS10 elsewhere
    } catch(e) {}

    // Method 1: FORWARD P/E
    // EPS estimate = trailing EPS × (1 + growth rate)
    // Multiple = sector median P/E
    var fwd = null;
    var fwdDetail = '';
    if (d.incomeStatement && d.incomeStatement.eps && d.incomeStatement.eps.length >= 2) {
      var epsArr = d.incomeStatement.eps;
      var lastEps = epsArr[epsArr.length-1].value;
      // 3-yr EPS CAGR (or as many years as available)
      var yrs = Math.min(epsArr.length-1, 3);
      var firstEps = epsArr[epsArr.length-1-yrs].value;
      var epsCAGR = (lastEps > 0 && firstEps > 0) ? Math.pow(lastEps/firstEps, 1/yrs) - 1 : 0;
      // Cap CAGR sanity bounds [-15%, +35%]
      epsCAGR = Math.max(-0.15, Math.min(0.35, epsCAGR));
      var fwdEps = lastEps * (1 + epsCAGR);
      var sectorPE = SECTOR_PE[sector] || 20;
      var fwdLow = fwdEps * (sectorPE * 0.75);
      var fwdMid = fwdEps * sectorPE;
      var fwdHigh = fwdEps * (sectorPE * 1.25);
      // If analyst consensus exists, blend it in for the mid case
      if (d.analystTargets && d.analystTargets.mean) {
        fwdMid = (fwdMid + d.analystTargets.mean) / 2;
      }
      fwd = { low: fwdLow, mid: fwdMid, high: fwdHigh };
      fwdDetail = 'EPS: $'+lastEps.toFixed(2)+' &times; ('+(epsCAGR>=0?'+':'')+(epsCAGR*100).toFixed(1)+'% CAGR) = $'+fwdEps.toFixed(2)+' fwd EPS &times; '+sectorPE+'x sector P/E';
    }

    // Method 2: SIMPLIFIED DCF
    // FCF = OperatingCF - CapEx, projected forward at growth rate, discounted at 10Y + risk premium
    var dcf = null;
    var dcfDetail = '';
    if (d.cashFlowStatement && d.cashFlowStatement.operatingCashFlow && d.cashFlowStatement.operatingCashFlow.length >= 2 && sharesOut) {
      var ocfArr = d.cashFlowStatement.operatingCashFlow;
      var capexArr = d.cashFlowStatement.capitalExpenditures || [];
      var lastOCF = ocfArr[ocfArr.length-1].value;
      var lastCapex = 0;
      // capex stored as negative outflow; take absolute
      if (capexArr.length) lastCapex = Math.abs(capexArr[capexArr.length-1].value);
      var lastFCF = lastOCF - lastCapex;
      // 5-yr FCF growth (or fewer years)
      var fcfYrs = Math.min(ocfArr.length-1, 5);
      var firstOCF = ocfArr[ocfArr.length-1-fcfYrs].value;
      var firstCapex = capexArr.length>=fcfYrs+1 ? Math.abs(capexArr[capexArr.length-1-fcfYrs].value) : 0;
      var firstFCF = firstOCF - firstCapex;
      var fcfCAGR = (lastFCF > 0 && firstFCF > 0) ? Math.pow(lastFCF/firstFCF, 1/fcfYrs) - 1 : 0.05;
      // Cap CAGR sanity bounds
      fcfCAGR = Math.max(-0.10, Math.min(0.25, fcfCAGR));
      // Discount rate = 10Y yield + 5% equity risk premium
      var discRate = tenY/100 + 0.05;
      // Terminal growth rate (perpetuity) = lower of 3% or 10Y yield - 1%
      var termG = Math.min(0.03, tenY/100 - 0.01);
      if (termG < 0) termG = 0.02;
      // 5-year explicit projection + Gordon Growth terminal
      var pv = 0;
      var fcfT = lastFCF;
      for (var t=1; t<=5; t++) {
        fcfT = lastFCF * Math.pow(1+fcfCAGR, t);
        pv += fcfT / Math.pow(1+discRate, t);
      }
      var terminalFCF = fcfT * (1+termG);
      var terminalValue = terminalFCF / (discRate - termG);
      pv += terminalValue / Math.pow(1+discRate, 5);
      var dcfMid = pv / sharesOut;
      // Sensitivity: ±200bps on discount rate
      function dcfAt(disc, g) {
        var pv2 = 0; var f = lastFCF;
        for (var t=1;t<=5;t++){ f = lastFCF*Math.pow(1+g, t); pv2 += f/Math.pow(1+disc,t); }
        var tFCF = f*(1+termG);
        if (disc - termG <= 0) return null;
        var tv = tFCF/(disc-termG);
        pv2 += tv/Math.pow(1+disc, 5);
        return pv2/sharesOut;
      }
      var dcfHigh = dcfAt(discRate - 0.02, fcfCAGR + 0.02) || dcfMid * 1.4;
      var dcfLow = dcfAt(discRate + 0.02, fcfCAGR - 0.02) || dcfMid * 0.6;
      dcf = { low: Math.max(0, dcfLow), mid: Math.max(0, dcfMid), high: Math.max(0, dcfHigh) };
      dcfDetail = 'FCF: $'+(lastFCF/1e9).toFixed(2)+'B &times; ('+(fcfCAGR>=0?'+':'')+(fcfCAGR*100).toFixed(1)+'% CAGR) discounted at '+(discRate*100).toFixed(1)+'% over 5yr + Gordon terminal at '+(termG*100).toFixed(1)+'%';
    }

    // Method 3: DIVIDEND DISCOUNT (Gordon Growth)
    // Only for stocks with consistent dividend history
    var ddm = null;
    var ddmDetail = '';
    if (d.dividends && d.dividends.length >= 3) {
      var divArr = d.dividends;
      var lastDiv = divArr[divArr.length-1].value;
      var divYrs = Math.min(divArr.length-1, 5);
      var firstDiv = divArr[divArr.length-1-divYrs].value;
      var divCAGR = (lastDiv > 0 && firstDiv > 0) ? Math.pow(lastDiv/firstDiv, 1/divYrs) - 1 : 0.03;
      // Cap dividend growth sanity bounds
      divCAGR = Math.max(0, Math.min(0.12, divCAGR));
      var requiredReturn = tenY/100 + 0.05; // CAPM-ish: rf + 5% ERP
      // Gordon Growth: P = D1 / (r - g)
      if (requiredReturn > divCAGR) {
        var d1 = lastDiv * (1 + divCAGR);
        var ddmMid = d1 / (requiredReturn - divCAGR);
        // Sensitivity: vary growth by ±100bps and required return by ±100bps
        var ddmHigh = (lastDiv*(1+divCAGR+0.01)) / Math.max(0.001, requiredReturn-0.01-(divCAGR+0.01));
        var ddmLow = (lastDiv*(1+Math.max(0,divCAGR-0.01))) / Math.max(0.001, requiredReturn+0.01-(Math.max(0,divCAGR-0.01)));
        ddm = { low: Math.max(0, ddmLow), mid: Math.max(0, ddmMid), high: Math.max(0, ddmHigh) };
        ddmDetail = 'Last DPS: $'+lastDiv.toFixed(2)+' &times; ('+(divCAGR*100).toFixed(1)+'% growth) / ('+(requiredReturn*100).toFixed(1)+'% req return - g)';
      }
    }

    // Render
    function pctUpside(target){ return ((target/px - 1) * 100); }
    function colorForUp(u){ return u >= 15 ? C.success : u >= -10 ? C.warning : C.danger; }
    function row(label, m, detail, conf){
      if (!m) return '<tr><td style="font-weight:600;">'+label+'</td><td colspan="5" style="color:var(--text-sec);font-style:italic;">Insufficient data ('+detail+')</td></tr>';
      var up = pctUpside(m.mid);
      return '<tr>'
        +'<td style="font-weight:600;color:var(--navy);">'+label+'</td>'
        +'<td>$'+m.low.toFixed(2)+'</td>'
        +'<td style="font-weight:700;font-size:14px;">$'+m.mid.toFixed(2)+'</td>'
        +'<td>$'+m.high.toFixed(2)+'</td>'
        +'<td style="color:'+colorForUp(up)+';font-weight:700;">'+(up>=0?'+':'')+up.toFixed(1)+'%</td>'
        +'<td style="font-size:11px;color:var(--text-sec);">'+(conf||'Medium')+'</td>'
        +'</tr><tr><td colspan="6" style="font-size:11px;color:var(--text-sec);background:var(--panel);padding:6px 12px;border-bottom:2px solid var(--border);">'+detail+'</td></tr>';
    }

    // Consensus — average of mid estimates from methods that returned a value
    var validMids = [fwd, dcf, ddm].filter(function(m){return m;}).map(function(m){return m.mid;});
    var validLows = [fwd, dcf, ddm].filter(function(m){return m;}).map(function(m){return m.low;});
    var validHighs = [fwd, dcf, ddm].filter(function(m){return m;}).map(function(m){return m.high;});
    var consensusMid = validMids.length ? validMids.reduce(function(a,b){return a+b;},0)/validMids.length : null;
    var consensusLow = validLows.length ? Math.min.apply(null, validLows) : null;
    var consensusHigh = validHighs.length ? Math.max.apply(null, validHighs) : null;
    var consensusUp = consensusMid != null ? pctUpside(consensusMid) : null;

    // Compute method dispersion as a rough confidence flag
    var dispersion = 0;
    if (validMids.length > 1) {
      var meanMid = validMids.reduce(function(a,b){return a+b;},0)/validMids.length;
      dispersion = Math.sqrt(validMids.reduce(function(s,v){return s+(v-meanMid)*(v-meanMid);},0)/validMids.length) / meanMid;
    }
    var conviction = validMids.length === 0 ? 'Cannot estimate' : validMids.length === 1 ? 'Low (1 method)' : dispersion < 0.15 ? 'High (methods agree)' : dispersion < 0.30 ? 'Medium (some disagreement)' : 'Low (methods disagree)';
    var convictionColor = dispersion < 0.15 ? C.success : dispersion < 0.30 ? C.warning : C.danger;

    // Macro context flag — current regime affects discount rate validity
    /* ── SILENT REGIME DEFAULT REMOVED — 2026-07-24 ────────────────────────
       This previously read `window._briefingState || 'growth'`. Landing directly
       on Research → Valuation before the briefing had loaded therefore asserted
       "In Growth regime, valuations typically converge toward the MID estimate"
       regardless of the actual regime — and the Macro page could be showing
       Stagflation at the same moment. A fabricated regime is worse than no
       regime, so the state is now read from the unified engine and left NULL
       when unknown, with the UI saying so. */
    var stateNames = { leveraged: 'Accumulate', growth: 'Risk-On', neutral: 'Neutral', drawdown: 'De-Risk' };
    var sigNow = window._perrySignals || null;
    var curState = (sigNow && window.PerrySignals && window.PerrySignals.legacyStateName(sigNow))
                || window._briefingState
                || null;
    var regimeFlag = '';
    if (!curState) {
      regimeFlag = '<em>Market state not yet loaded.</em> Open the Macro page (or wait for the signal engine to finish) '
        + 'and this note will state how the current regime should shift your read of the bands below. '
        + 'No regime assumption is being applied to these numbers.';
    }
    else if (curState === 'drawdown') regimeFlag = 'In a <strong>De-Risk</strong> state the discount rate deserves to be higher than the ' + (window.PerrySignals ? 'CAPM-based rate' : 'base rate') + ' used here, so treat the LOW band as the more realistic anchor.';
    else if (curState === 'leveraged') regimeFlag = 'In an <strong>Accumulate</strong> state (post-decline), valuations have historically expanded off the bottom, and the HIGH band has been the better guide.';
    else if (curState === 'neutral') regimeFlag = 'In a <strong>Neutral</strong> state valuations tend to be range-bound, and the MID band tracks reality most closely.';
    else regimeFlag = 'In a <strong>Risk-On</strong> state valuations tend to converge toward the MID estimate over 12–18 months.';

    var html = '<div style="text-align:left;padding:0 4px;">'
      + '<div style="background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:10px 14px;margin-bottom:14px;font-size:13px;">'
      +   '<strong style="color:var(--navy);">Current Price:</strong> $'+px.toFixed(2)
      +   ' &middot; <strong>Sector:</strong> '+(sector||'—')
      +   ' &middot; <strong>Sector P/E benchmark:</strong> '+(SECTOR_PE[sector]||20)+'x'
      +   ' &middot; <strong>10Y Treasury (discount rate proxy):</strong> '+tenY.toFixed(2)+'%'
      + '</div>'
      + '<div style="overflow-x:auto;"><table><thead><tr>'
      +   '<th>Method</th><th>Low</th><th>Mid (Fair Value)</th><th>High</th><th>Upside (Mid)</th><th>Notes</th>'
      + '</tr></thead><tbody>'
      +   row('Forward P/E', fwd, fwdDetail || 'No EPS history available', 'Medium')
      +   row('Simplified DCF', dcf, dcfDetail || 'No FCF history or share count available', 'Medium')
      +   row('Dividend Discount (Gordon)', ddm, ddmDetail || 'Stock does not pay a consistent dividend', 'Medium')
      + '</tbody></table></div>';

    if (consensusMid != null) {
      html += '<div style="background:var(--navy);color:#fff;padding:14px 18px;border-radius:4px;margin-top:14px;display:flex;flex-wrap:wrap;align-items:center;gap:14px;">'
        + '<div style="flex:1;min-width:200px;"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;opacity:.85;">Consensus Fair Value</div>'
        + '<div style="font-size:24px;font-weight:800;margin-top:2px;">$'+consensusMid.toFixed(2)+'</div>'
        + '<div style="font-size:11px;opacity:.85;">Range: $'+consensusLow.toFixed(2)+' &mdash; $'+consensusHigh.toFixed(2)+'</div></div>'
        + '<div style="flex:1;min-width:200px;"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;opacity:.85;">Implied Upside</div>'
        + '<div style="font-size:24px;font-weight:800;margin-top:2px;color:'+(consensusUp>=0?'#A8E8B8':'#F8B8B8')+';">'+(consensusUp>=0?'+':'')+consensusUp.toFixed(1)+'%</div>'
        + '<div style="font-size:11px;opacity:.85;">From current $'+px.toFixed(2)+'</div></div>'
        + '<div style="flex:1;min-width:200px;"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;opacity:.85;">Conviction</div>'
        + '<div style="font-size:18px;font-weight:700;margin-top:2px;color:'+(dispersion<0.15?'#A8E8B8':dispersion<0.30?'#F8E8A8':'#F8B8B8')+';">'+conviction+'</div>'
        + '<div style="font-size:11px;opacity:.85;">Dispersion: '+(dispersion*100).toFixed(0)+'%</div></div>'
        + '</div>';
      html += '<div style="margin-top:12px;background:#fff8e8;border:1px solid #f0e0a8;border-radius:4px;padding:8px 12px;font-size:11px;color:#5A4A1A;"><strong>Macro context (' + (stateNames[curState]||curState) + ' regime):</strong> ' + regimeFlag + '</div>';
    } else {
      html += '<div style="background:#fff8e8;border:1px solid #f0e0a8;border-radius:4px;padding:10px 14px;margin-top:14px;font-size:12px;color:#8B6914;">Could not run any of the three valuation methods &mdash; likely due to incomplete fundamentals data from SEC EDGAR for this ticker. Try a more established large-cap.</div>';
    }
    html += '</div>';

    resEl.innerHTML = html;
  } catch(e) {
    resEl.innerHTML = '<div style="color:var(--danger);padding:10px;">Intrinsic value error: '+e.message+'</div>';
  }
}

// ═══════════════════════════════════════════════════════════════════
// ═══════════ 2. FULL YIELD CURVE VISUALIZATION ═════════════════════
// ═══════════════════════════════════════════════════════════════════
var _ycData = null;
var _ycChart = null;
var _ycSpreadsChart = null;
async function ycLoad() {
  var statsEl = document.getElementById('ycStats');
  if (!statsEl) return;
  statsEl.innerHTML = '<div class="chart-stat-box" style="flex:1;text-align:center;"><span class="spinner"></span> Fetching full Treasury yield curve from FRED...</div>';
  try {
    var WORKER = "https://perry-finance-proxy.zachperrybusiness.workers.dev";
    var res = await fetch(WORKER + '/yieldcurve');
    var d = await res.json();
    if (d.error) { statsEl.innerHTML = '<div style="color:var(--danger);padding:10px;">'+d.error+'</div>'; return; }
    _ycData = d;
    ycRender();
  } catch(e) { statsEl.innerHTML = '<div style="color:var(--danger);padding:10px;">Error: '+e.message+'</div>'; }
}

function ycRender() {
  if (!_ycData) return;
  var d = _ycData;
  var overlay = document.getElementById('ycOverlay').value;
  var statsEl = document.getElementById('ycStats');

  // Build stats from current snapshot
  var cur = d.snapshots.current;
  var r1m = cur.find(function(p){return p.maturity==='1M';});
  var r2y = cur.find(function(p){return p.maturity==='2Y';});
  var r10y = cur.find(function(p){return p.maturity==='10Y';});
  var r30y = cur.find(function(p){return p.maturity==='30Y';});
  var r3m = cur.find(function(p){return p.maturity==='3M';});
  var spread2s10s = r2y && r10y ? (r10y.rate - r2y.rate) : null;
  var spread3m10y = r3m && r10y ? (r10y.rate - r3m.rate) : null;
  var spread2s30s = r2y && r30y ? (r30y.rate - r2y.rate) : null;

  function fmt2(v){ return v != null ? v.toFixed(2)+'%' : '—'; }
  function spreadCol(v){ return v == null ? C.textSec : v > 0 ? C.success : C.danger; }
  function spreadLabel(v){ return v == null ? '—' : v > 0.5 ? 'Normal' : v > 0 ? 'Flat' : v > -0.5 ? 'Mild Inversion' : 'Deep Inversion'; }

  statsEl.innerHTML =
    '<div class="chart-stat-box"><div class="chart-stat-label">1M Treasury</div><div class="chart-stat-value">'+fmt2(r1m && r1m.rate)+'</div></div>' +
    '<div class="chart-stat-box"><div class="chart-stat-label">2Y Treasury</div><div class="chart-stat-value">'+fmt2(r2y && r2y.rate)+'</div></div>' +
    '<div class="chart-stat-box"><div class="chart-stat-label">10Y Treasury</div><div class="chart-stat-value">'+fmt2(r10y && r10y.rate)+'</div></div>' +
    '<div class="chart-stat-box"><div class="chart-stat-label">30Y Treasury</div><div class="chart-stat-value">'+fmt2(r30y && r30y.rate)+'</div></div>' +
    '<div class="chart-stat-box"><div class="chart-stat-label">2s10s Spread <span class="help-icon" title="The 10-year Treasury yield minus the 2-year. Positive = normal upward-sloping curve. Negative (inverted) = recession warning — has preceded every US recession since 1955.">?</span></div><div class="chart-stat-value" style="color:'+spreadCol(spread2s10s)+';">'+(spread2s10s!=null?(spread2s10s>=0?'+':'')+spread2s10s.toFixed(2)+'%':'—')+'</div><div class="chart-stat-sub">'+spreadLabel(spread2s10s)+'</div></div>' +
    '<div class="chart-stat-box"><div class="chart-stat-label">3M/10Y Spread <span class="help-icon" title="The 10-year Treasury yield minus the 3-month T-bill. The Fed&apos;s preferred recession indicator (per NY Fed research). Inversion has preceded every US recession in the past 50 years with no false positives.">?</span></div><div class="chart-stat-value" style="color:'+spreadCol(spread3m10y)+';">'+(spread3m10y!=null?(spread3m10y>=0?'+':'')+spread3m10y.toFixed(2)+'%':'—')+'</div><div class="chart-stat-sub">'+spreadLabel(spread3m10y)+'</div></div>';

  // Build overlay datasets
  var snaps = d.snapshots;
  var labels = snaps.current.map(function(p){return p.maturity;});
  var datasets = [];
  if (overlay === '1m' || overlay === 'all') datasets.push({ label: '1M Ago', data: snaps.oneMonthAgo.map(function(p){return p.rate;}), borderColor: 'rgba(168,200,232,0.9)', backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [4,3], pointRadius: 3, tension: 0.3 });
  if (overlay === '3m' || overlay === 'all') datasets.push({ label: '3M Ago', data: snaps.threeMonthsAgo.map(function(p){return p.rate;}), borderColor: 'rgba(91,155,213,0.85)', backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [4,3], pointRadius: 3, tension: 0.3 });
  if (overlay === '6m' || overlay === 'all') datasets.push({ label: '6M Ago', data: snaps.sixMonthsAgo.map(function(p){return p.rate;}), borderColor: 'rgba(139,105,20,0.85)', backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [4,3], pointRadius: 3, tension: 0.3 });
  if (overlay === '1y' || overlay === 'all') datasets.push({ label: '1Y Ago', data: snaps.oneYearAgo.map(function(p){return p.rate;}), borderColor: 'rgba(200,208,216,0.85)', backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [4,3], pointRadius: 3, tension: 0.3 });
  // Always include current (drawn last, thickest)
  datasets.push({ label: 'Current', data: snaps.current.map(function(p){return p.rate;}), borderColor: C.navy, backgroundColor: 'rgba(0,60,113,0.08)', borderWidth: 3, pointRadius: 5, pointBackgroundColor: C.navy, tension: 0.3, fill: false });

  if (_ycChart) _ycChart.destroy();
  _ycChart = new Chart(document.getElementById('ycChart').getContext('2d'), {
    type: 'line',
    data: { labels: labels, datasets: datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { font:{size:11}, color: C.textSec } }, tooltip: Object.assign({}, chartTooltip, { callbacks: { label: function(ctx){ return ctx.dataset.label+': '+ctx.parsed.y.toFixed(2)+'%'; } }}) },
      scales: {
        x: { grid: chartGrid, ticks: chartTicks, title: { display: true, text: 'Maturity', color: C.textSec, font:{size:11} } },
        y: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { callback: function(v){ return v.toFixed(1)+'%'; }}), title: { display: true, text: 'Yield (%)', color: C.textSec, font:{size:11} } }
      }
    }
  });

  // Spreads chart
  var spreads = d.spreads;
  if (spreads && spreads.dates && spreads.dates.length > 20) {
    // Downsample for performance if >500 points
    var step = Math.max(1, Math.ceil(spreads.dates.length / 500));
    var sampledDates = [], s2s10s = [], s3m10y = [], s2s30s = [];
    for (var i = 0; i < spreads.dates.length; i += step) {
      sampledDates.push(spreads.dates[i]);
      s2s10s.push(spreads['2s10s'][i]);
      s3m10y.push(spreads['3m10y'][i]);
      s2s30s.push(spreads['2s30s'][i]);
    }
    if (_ycSpreadsChart) _ycSpreadsChart.destroy();
    _ycSpreadsChart = new Chart(document.getElementById('ycSpreadsChart').getContext('2d'), {
      type: 'line',
      data: {
        labels: sampledDates,
        datasets: [
          { label: '2s10s Spread', data: s2s10s, borderColor: C.navy, backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, tension: 0.1 },
          { label: '3M/10Y Spread', data: s3m10y, borderColor: C.blue, backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, tension: 0.1 },
          { label: '2s30s Spread', data: s2s30s, borderColor: C.warning, backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, tension: 0.1 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: {font:{size:10}, color: C.textSec} }, tooltip: chartTooltip,
          annotation: { annotations: { zeroLine: { type: 'line', yMin: 0, yMax: 0, borderColor: C.textSec, borderDash:[2,2] }}}
        },
        scales: {
          x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { maxTicksLimit: 10, autoSkip: true }) },
          y: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { callback: function(v){return v.toFixed(2)+'%';}}), title:{display:true, text:'Spread (%)', color:C.textSec, font:{size:11}} }
        }
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════════════
// ═══════════ 3. PORTFOLIO THEMES ═══════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
var PORTFOLIO_THEMES = [
  {
    key: 'ai_infra', name: 'AI Infrastructure',
    description: 'Semiconductors, hyperscaler clouds, and AI-exposed large caps driving the build-out phase.',
    regimeFit: 'leveraged,growth',
    tickers: ['NVDA','AMD','MSFT','GOOGL','AMZN','META','SMCI','AVGO','ARM','PLTR']
  },
  {
    key: 'energy_transition', name: 'Energy Transition',
    description: 'Renewable generation, storage, utilities adapting to grid modernization, and battery material suppliers.',
    regimeFit: 'growth,neutral',
    tickers: ['FSLR','ENPH','NEE','RUN','SEDG','ICLN','LIT','TAN','PBW']
  },
  {
    key: 'defensive_yield', name: 'Defensive Yield',
    description: 'Utilities, staples, telecoms, REITs &mdash; low-beta dividend payers for late-cycle or defensive postures.',
    regimeFit: 'neutral,drawdown',
    tickers: ['XLU','XLP','VZ','JNJ','KO','PEP','O','MO','PFE','SO']
  },
  {
    key: 'leveraged_basket', name: 'Leveraged Regime Basket',
    description: '3x leveraged ETFs and high-beta names for high-conviction entries at market bottoms (VIX &gt; 30).',
    regimeFit: 'leveraged',
    tickers: ['TQQQ','SOXL','FNGU','UPRO','TECL','LABU','UDOW']
  },
  {
    key: 'real_assets', name: 'Gold &amp; Real Asset Inflation Hedge',
    description: 'Precious metals miners, commodities, real estate &mdash; hedges for inflation persistence and USD weakness.',
    regimeFit: 'neutral,drawdown',
    tickers: ['GLD','SLV','GDX','GDXJ','PDBC','USO','SCHH','VNQ']
  },
  {
    key: 'usd_pairs', name: 'Dollar Strength / FX Pairs',
    description: 'USD long vs. EM/developed ex-US for cycles when DXY strengthens. Add currency ETFs for tactical overlay.',
    regimeFit: 'growth,drawdown',
    tickers: ['UUP','EEM','EFA','FXE','FXY','FXB','DXJ']
  },
  {
    key: 'credit_cycle', name: 'Credit Cycle Barbell',
    description: 'High-yield and investment-grade credit plus long and short duration &mdash; track spread cycle and rate moves.',
    regimeFit: 'growth,neutral',
    tickers: ['HYG','JNK','LQD','TLT','SHV','BKLN','IEF']
  }
];

function themesPopulateDropdown() {
  var sel = document.getElementById('themeSelect');
  if (!sel) return;
  // Already populated
  if (sel.options.length > 1) return;
  PORTFOLIO_THEMES.forEach(function(t){
    var opt = document.createElement('option');
    opt.value = t.key;
    // Strip HTML entities for option text — they don't render in <option>
    var nameClean = t.name.replace(/&amp;/g, '&').replace(/&mdash;/g, '—');
    opt.textContent = nameClean + ' (' + t.tickers.length + ' tickers)';
    sel.appendChild(opt);
  });
}

async function themesLoadDetail(themeKey) {
  // Empty selection
  if (!themeKey) {
    document.getElementById('themeMeta').style.display = 'none';
    document.getElementById('themeDetailStats').innerHTML = '';
    document.getElementById('themeChartWrap').style.display = 'none';
    document.getElementById('themeDetailTable').innerHTML = '';
    return;
  }
  var theme = PORTFOLIO_THEMES.find(function(t){return t.key===themeKey;});
  if (!theme) return;
  // Render the description meta band
  var currentState = window._briefingState || null;
  var stateNames = {leveraged: 'Leveraged', growth: 'Non-Levered Growth', neutral: 'Neutral', drawdown: 'Positioned for Drawdown'};
  var fits = theme.regimeFit.split(',');
  var fitLabels = fits.map(function(f){ return stateNames[f]; }).join(' / ');
  var fitsCurrent = currentState && fits.indexOf(currentState) >= 0;
  var fitBadge = fitsCurrent
    ? '<span style="background:#2E7D52;color:#fff;padding:2px 7px;border-radius:3px;font-size:10px;font-weight:700;margin-left:6px;">FITS CURRENT REGIME</span>'
    : '';
  var metaEl = document.getElementById('themeMeta');
  metaEl.innerHTML =
    '<div style="font-weight:700;color:var(--navy);font-size:14px;margin-bottom:4px;">' + theme.name + fitBadge + '</div>' +
    '<div style="margin-bottom:4px;">' + theme.description + '</div>' +
    '<div><strong>Best for regime:</strong> ' + fitLabels + ' &middot; <strong>' + theme.tickers.length + ' tickers:</strong> ' + theme.tickers.join(', ') + '</div>';
  metaEl.style.display = '';
  document.getElementById('themeDetailStats').innerHTML = '<div class="chart-stat-box" style="flex:1;text-align:center;"><span class="spinner"></span> Loading 1-year price data for '+theme.tickers.length+' constituents...</div>';
  document.getElementById('themeChartWrap').style.display = 'none';
  document.getElementById('themeDetailTable').innerHTML = '';

  var WORKER = "https://perry-finance-proxy.zachperrybusiness.workers.dev";
  var dataByTicker = {};
  await Promise.all(theme.tickers.map(async function(t){
    try {
      var r = await fetch(WORKER + '/chart?symbol='+encodeURIComponent(t)+'&range=1y&interval=1d');
      var d = await r.json();
      var pts = (d.points||[]).filter(function(p){return p.close!=null;});
      if (pts.length > 20) {
        dataByTicker[t] = { closes: pts.map(function(p){return p.close;}), dates: pts.map(function(p){return p.date.slice(0,10);}) };
      }
    } catch(e) {}
  }));

  // Also fetch SPY for benchmark
  try {
    var spyR = await fetch(WORKER + '/chart?symbol=SPY&range=1y&interval=1d');
    var spyD = await spyR.json();
    var spyPts = (spyD.points||[]).filter(function(p){return p.close!=null;});
    if (spyPts.length > 20) dataByTicker['SPY'] = { closes: spyPts.map(function(p){return p.close;}), dates: spyPts.map(function(p){return p.date.slice(0,10);}) };
  } catch(e) {}

  var tickers = Object.keys(dataByTicker);
  if (!tickers.length) { document.getElementById('themeDetailStats').innerHTML = '<div style="color:var(--danger);padding:10px;">No price data loaded.</div>'; return; }

  // Build rebased performance (all start at 100)
  var minLen = Math.min.apply(null, tickers.map(function(t){return dataByTicker[t].closes.length;}));
  tickers.forEach(function(t){ dataByTicker[t].closes = dataByTicker[t].closes.slice(-minLen); dataByTicker[t].dates = dataByTicker[t].dates.slice(-minLen); });
  var commonDates = dataByTicker[tickers[0]].dates;
  tickers.forEach(function(t){
    var first = dataByTicker[t].closes[0];
    dataByTicker[t].rebased = dataByTicker[t].closes.map(function(c){return (c/first)*100;});
    // Returns
    var rets = []; for (var i = 1; i < dataByTicker[t].closes.length; i++) rets.push((dataByTicker[t].closes[i] - dataByTicker[t].closes[i-1]) / dataByTicker[t].closes[i-1]);
    dataByTicker[t].returns = rets;
    var first30 = dataByTicker[t].closes[Math.max(0, dataByTicker[t].closes.length-22)];
    var first90 = dataByTicker[t].closes[Math.max(0, dataByTicker[t].closes.length-63)];
    var first180 = dataByTicker[t].closes[Math.max(0, dataByTicker[t].closes.length-126)];
    var cur = dataByTicker[t].closes[dataByTicker[t].closes.length-1];
    dataByTicker[t].r1m = (cur-first30)/first30*100;
    dataByTicker[t].r3m = (cur-first90)/first90*100;
    dataByTicker[t].r6m = (cur-first180)/first180*100;
    dataByTicker[t].r12m = (cur-first)/first*100;
    var mean = rets.reduce(function(s,v){return s+v;},0)/rets.length;
    var vari = rets.reduce(function(s,v){return s+(v-mean)*(v-mean);},0)/(rets.length-1);
    dataByTicker[t].volAnn = Math.sqrt(vari)*Math.sqrt(252)*100;
  });

  // Compute internal correlation matrix (theme tickers only, not SPY)
  var corrTickers = theme.tickers.filter(function(t){return dataByTicker[t];});
  function pearson(x, y) {
    var n = Math.min(x.length, y.length);
    var mx = 0, my = 0;
    for (var i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    var num = 0, dx = 0, dy = 0;
    for (var i = 0; i < n; i++) { var ax = x[i] - mx, ay = y[i] - my; num += ax*ay; dx += ax*ax; dy += ay*ay; }
    return num / Math.sqrt(dx * dy);
  }
  var corrSum = 0, corrCount = 0;
  for (var i = 0; i < corrTickers.length; i++) {
    for (var j = i+1; j < corrTickers.length; j++) {
      var r = pearson(dataByTicker[corrTickers[i]].returns, dataByTicker[corrTickers[j]].returns);
      if (!isNaN(r)) { corrSum += r; corrCount++; }
    }
  }
  var avgCorr = corrCount > 0 ? corrSum / corrCount : 0;

  // Equal-weight theme performance (avg of rebased)
  var themePerf = new Array(minLen).fill(0);
  corrTickers.forEach(function(t){ dataByTicker[t].rebased.forEach(function(v, i){ themePerf[i] += v / corrTickers.length; }); });
  var themeReturn = (themePerf[themePerf.length-1] - 100);
  var spyReturn = dataByTicker['SPY'] ? (dataByTicker['SPY'].rebased[dataByTicker['SPY'].rebased.length-1] - 100) : null;

  // Stats row
  document.getElementById('themeDetailStats').innerHTML =
    '<div class="chart-stat-box"><div class="chart-stat-label">Theme Performance (1Y)</div><div class="chart-stat-value" style="color:'+(themeReturn>=0?C.success:C.danger)+';">'+(themeReturn>=0?'+':'')+themeReturn.toFixed(1)+'%</div></div>' +
    (spyReturn != null ? '<div class="chart-stat-box"><div class="chart-stat-label">vs. SPY Benchmark</div><div class="chart-stat-value" style="color:'+((themeReturn-spyReturn)>=0?C.success:C.danger)+';">'+((themeReturn-spyReturn)>=0?'+':'')+(themeReturn-spyReturn).toFixed(1)+'%</div><div class="chart-stat-sub">SPY: '+(spyReturn>=0?'+':'')+spyReturn.toFixed(1)+'%</div></div>' : '') +
    '<div class="chart-stat-box"><div class="chart-stat-label">Avg Internal Correlation</div><div class="chart-stat-value">'+avgCorr.toFixed(2)+'</div><div class="chart-stat-sub">'+(avgCorr>0.7?'High (concentrated)':avgCorr>0.4?'Moderate':'Low (diversified)')+'</div></div>' +
    '<div class="chart-stat-box"><div class="chart-stat-label">Constituents</div><div class="chart-stat-value">'+corrTickers.length+' / '+theme.tickers.length+'</div><div class="chart-stat-sub">tickers with data</div></div>';

  // Rebased chart
  var datasets = corrTickers.slice(0, 8).map(function(t, idx){
    var colors = [C.navy, C.blue, '#A8C8E8', '#2E7D52', '#8B6914', '#8B2A2A', '#003C71', '#5B9BD5'];
    return { label: t, data: dataByTicker[t].rebased, borderColor: colors[idx % colors.length], backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, tension: 0.1 };
  });
  // Theme avg
  datasets.push({ label: theme.name+' (Equal-Weight)', data: themePerf, borderColor: C.navy, backgroundColor: 'rgba(0,60,113,0.08)', borderWidth: 3, pointRadius: 0, tension: 0.1, fill: false });
  if (dataByTicker['SPY']) datasets.push({ label: 'SPY Benchmark', data: dataByTicker['SPY'].rebased, borderColor: C.textSec, backgroundColor: 'transparent', borderWidth: 1.5, borderDash:[4,3], pointRadius: 0, tension: 0.1 });

  if (window._themeChart) window._themeChart.destroy();
  document.getElementById('themeChartWrap').style.display = 'block';
  window._themeChart = new Chart(document.getElementById('themePriceChart').getContext('2d'), {
    type: 'line',
    data: { labels: commonDates, datasets: datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: { legend: { position: 'bottom', labels: {font:{size:10}, color:C.textSec, boxWidth:10} }, tooltip: chartTooltip },
      scales: {
        x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { maxTicksLimit: 10, autoSkip: true }) },
        y: { grid: chartGrid, ticks: chartTicks, title: { display: true, text: 'Rebased (Start = 100)', color: C.textSec, font:{size:11} } }
      }
    }
  });

  // Constituent table
  var rows = corrTickers.map(function(t){
    var d = dataByTicker[t];
    function col(v){ return v>=0 ? C.success : C.danger; }
    function pct(v){ return (v>=0?'+':'')+v.toFixed(1)+'%'; }
    return '<tr>'
      +'<td style="font-weight:700;color:var(--navy);">'+t+'</td>'
      +'<td>$'+d.closes[d.closes.length-1].toFixed(2)+'</td>'
      +'<td style="color:'+col(d.r1m)+';">'+pct(d.r1m)+'</td>'
      +'<td style="color:'+col(d.r3m)+';">'+pct(d.r3m)+'</td>'
      +'<td style="color:'+col(d.r6m)+';">'+pct(d.r6m)+'</td>'
      +'<td style="color:'+col(d.r12m)+';font-weight:600;">'+pct(d.r12m)+'</td>'
      +'<td>'+d.volAnn.toFixed(1)+'%</td>'
      +'</tr>';
  }).join('');
  document.getElementById('themeDetailTable').innerHTML = '<table><thead><tr>'
    +'<th>Ticker</th><th>Price</th><th>1M</th><th>3M</th><th>6M</th><th>12M</th><th>Ann. Vol</th>'
    +'</tr></thead><tbody>'+rows+'</tbody></table>';
}

function themesBackToGrid() {
  // Inline UX: clear the dropdown selection and the detail panel.
  var sel = document.getElementById('themeSelect');
  if (sel) sel.value = '';
  themesLoadDetail('');
}

// ═══════════════════════════════════════════════════════════════════
// ═══════════ 4. BAYESIAN REGIME TRANSITION MATRIX ══════════════════
// ═══════════════════════════════════════════════════════════════════
async function brtRun() {
  var el = document.getElementById('brtResults');
  var wrapEl = document.getElementById('brtChartWrap');
  el.innerHTML = '<div style="padding:14px;text-align:center;"><span class="spinner"></span> Building regime transition matrix from 5-year SPY history...</div>';
  wrapEl.style.display = 'none';

  try {
    var WORKER = "https://perry-finance-proxy.zachperrybusiness.workers.dev";
    var [spyR, vixR] = await Promise.all([
      fetch(WORKER + '/chart?symbol=SPY&range=5y&interval=1d').then(function(r){return r.json();}),
      fetch(WORKER + '/chart?symbol=%5EVIX&range=5y&interval=1d').then(function(r){return r.json();})
    ]);
    var spyPts = (spyR.points||[]).filter(function(p){return p.close!=null;});
    var vixPts = (vixR.points||[]).filter(function(p){return p.close!=null;});
    if (spyR.error || vixR.error) { el.innerHTML = '<div style="color:var(--danger);padding:10px;"><strong>Worker error:</strong> '+(spyR.error||vixR.error)+'. Yahoo may be rate-limiting; try again in a few minutes.</div>'; return; }
    if (spyPts.length < 300) { el.innerHTML = '<div style="color:var(--warning);padding:10px;">Got only '+spyPts.length+' SPY points &mdash; need 300+ for transition matrix. Worker may be rate-limited.</div>'; return; }

    // Align VIX to SPY dates
    var vixMap = {};
    vixPts.forEach(function(p){ vixMap[p.date.slice(0,10)] = p.close; });
    var dates = spyPts.map(function(p){return p.date.slice(0,10);});
    var closes = spyPts.map(function(p){return p.close;});

    // Classify every day's regime
    var lookback = 252;
    var dailyStates = [];
    for (var i = lookback; i < closes.length; i++) {
      var cur = closes[i];
      var past = closes[i-lookback];
      var recentSlice = closes.slice(i-lookback, i+1);
      var spyHigh = Math.max.apply(null, recentSlice);
      var spyLow = Math.min.apply(null, recentSlice);
      var vix = vixMap[dates[i]];
      if (!vix) continue;
      var signals = {
        vix: vix,
        spyTrailingReturn: (cur - past) / past,
        drawdownFromPeak: (cur - spyHigh) / spyHigh,
        spy12mFromLow: (cur - spyLow) / spyLow
      };
      var cl = psClassifyState(signals);
      dailyStates.push({ date: dates[i], state: cl.winner });
    }

    if (dailyStates.length < 100) { el.innerHTML = '<div style="color:var(--warning);padding:10px;">Insufficient classified observations.</div>'; return; }

    // Build transition counts at different horizons
    var stateKeys = ['leveraged','growth','neutral','drawdown'];
    function buildMatrix(horizonDays) {
      var counts = {};
      stateKeys.forEach(function(s){ counts[s] = {leveraged:0, growth:0, neutral:0, drawdown:0}; });
      for (var i = 0; i < dailyStates.length - horizonDays; i++) {
        var from = dailyStates[i].state;
        var to = dailyStates[i + horizonDays].state;
        counts[from][to]++;
      }
      // Convert counts to probabilities
      var probs = {};
      stateKeys.forEach(function(from){
        var total = stateKeys.reduce(function(s, to){return s + counts[from][to];}, 0);
        probs[from] = {};
        stateKeys.forEach(function(to){ probs[from][to] = total > 0 ? counts[from][to] / total : 0; });
      });
      return probs;
    }

    var m30 = buildMatrix(21);  // ~30 calendar days = 21 trading days
    var m60 = buildMatrix(42);
    var m90 = buildMatrix(63);

    // Current state
    var currentState = window._briefingState || dailyStates[dailyStates.length-1].state;
    var stateName = {leveraged: 'Leveraged', growth: 'Non-Levered Growth', neutral: 'Neutral', drawdown: 'Positioned for Drawdown'};
    var stateColor = {leveraged: '#2E7D52', growth: '#003C71', neutral: '#8B6914', drawdown: '#8B2A2A'};
    var curColor = stateColor[currentState];

    // Build table
    function renderRow(horizonLabel, matrix) {
      var row = matrix[currentState];
      var bars = stateKeys.map(function(to){
        var pct = row[to] * 100;
        var width = Math.max(2, pct * 2.5); // scale
        return '<div style="display:flex;align-items:center;gap:8px;margin:4px 0;">'
          +'<div style="width:140px;font-size:11px;color:'+(to===currentState?'var(--navy)':'var(--text-sec)')+';font-weight:'+(to===currentState?'700':'500')+';">'+stateName[to]+(to===currentState?' (stays)':'')+'</div>'
          +'<div style="flex:1;height:18px;background:#F4F6F9;border-radius:3px;overflow:hidden;position:relative;">'
          +'<div style="height:100%;width:'+pct+'%;background:'+stateColor[to]+';"></div>'
          +'</div>'
          +'<div style="width:60px;text-align:right;font-size:11px;font-weight:700;color:'+stateColor[to]+';">'+pct.toFixed(1)+'%</div>'
          +'</div>';
      }).join('');
      return '<div style="margin-bottom:16px;"><div style="font-size:12px;font-weight:700;color:var(--navy);margin-bottom:4px;">'+horizonLabel+'</div>'+bars+'</div>';
    }

    el.innerHTML = '<div style="text-align:left;padding:4px;">'
      +'<div style="background:'+curColor+';color:#fff;padding:10px 14px;border-radius:4px;margin-bottom:14px;">'
      +'<div style="font-size:11px;opacity:.85;text-transform:uppercase;letter-spacing:.5px;">Current Classified State</div>'
      +'<div style="font-size:18px;font-weight:800;margin-top:2px;">'+stateName[currentState]+'</div>'
      +'<div style="font-size:11px;opacity:.85;margin-top:2px;">Based on '+dailyStates.length+' historical daily observations from past 5 years.</div>'
      +'</div>'
      +renderRow('30 Days Forward', m30)
      +renderRow('60 Days Forward', m60)
      +renderRow('90 Days Forward', m90)
      +'</div>';

    // Stacked bar chart: transition probs at 30/60/90
    wrapEl.style.display = 'block';
    var labels = ['30 Days', '60 Days', '90 Days'];
    var datasets = stateKeys.map(function(to){
      return {
        label: stateName[to],
        data: [m30[currentState][to]*100, m60[currentState][to]*100, m90[currentState][to]*100],
        backgroundColor: stateColor[to],
        borderWidth: 0
      };
    });
    if (window._brtChart) window._brtChart.destroy();
    window._brtChart = new Chart(document.getElementById('brtChart').getContext('2d'), {
      type: 'bar',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: {font:{size:10}, color:C.textSec} }, tooltip: Object.assign({}, chartTooltip, { callbacks: { label: function(ctx){ return ctx.dataset.label+': '+ctx.parsed.y.toFixed(1)+'%'; } } }) },
        scales: {
          x: { stacked: true, grid: chartGrid, ticks: chartTicks, title:{display:true,text:'Forward Horizon',color:C.textSec,font:{size:11}}},
          y: { stacked: true, grid: chartGrid, ticks: Object.assign({}, chartTicks, { callback: function(v){return v+'%';}}), max: 100, title:{display:true,text:'Probability (%)',color:C.textSec,font:{size:11}}}
        }
      }
    });
  } catch(e) { el.innerHTML = '<div style="color:var(--danger);padding:10px;">Error: '+e.message+'</div>'; }
}

// ═══════════════════════════════════════════════════════════════════
// ═══════════ 5. WALK-FORWARD BACKTESTING ═══════════════════════════
// ═══════════════════════════════════════════════════════════════════
async function wfbRun() {
  var ticker = (document.getElementById('wfbTicker').value || '').trim().toUpperCase();
  if (!ticker) { alert('Enter a ticker first.'); return; }
  var trainFrac = parseFloat(document.getElementById('wfbTrainFrac').value);
  var testFrac = parseFloat(document.getElementById('wfbTestFrac').value);
  var threshold = parseFloat(document.getElementById('wfbThreshold').value);
  var el = document.getElementById('wfbResults');
  var equityWrap = document.getElementById('wfbEquityWrap');
  var predWrap = document.getElementById('wfbPredWrap');
  el.innerHTML = '<div style="padding:14px;text-align:center;"><span class="spinner"></span> Running walk-forward validation for '+ticker+'...</div>';
  equityWrap.style.display = 'none'; predWrap.style.display = 'none';

  try {
    var WORKER = "https://perry-finance-proxy.zachperrybusiness.workers.dev";
    var [tickerR, vixR] = await Promise.all([
      fetch(WORKER + '/chart?symbol='+encodeURIComponent(ticker)+'&range=10y&interval=1d').then(function(r){return r.json();}),
      fetch(WORKER + '/chart?symbol=%5EVIX&range=10y&interval=1d').then(function(r){return r.json();})
    ]);
    var pts = (tickerR.points||[]).filter(function(p){return p.close!=null;});
    if (tickerR.error) { el.innerHTML = '<div style="color:var(--danger);padding:10px;"><strong>Worker error:</strong> '+tickerR.error+'</div>'; return; }
    if (pts.length < 300) { el.innerHTML = '<div style="color:var(--warning);padding:10px;">Got only '+pts.length+' price points for '+ticker+' &mdash; need at least 300 for walk-forward (about 14 months of daily data). The Worker may be rate-limited; retry in a few minutes.</div>'; return; }
    var vixPts = (vixR.points||[]).filter(function(p){return p.close!=null;});
    var vixMap = {}; vixPts.forEach(function(p){vixMap[p.date.slice(0,10)] = p.close;});

    var closes = pts.map(function(p){return p.close;});
    var dates = pts.map(function(p){return p.date.slice(0,10);});
    var N = closes.length;

    // Build features for each day t (need lookback data)
    var lookback = 63;  // need 63 days of history for features
    var fwdHorizon = 21;  // predict 21-day forward return
    var features = []; // feature vectors
    var targets = [];  // forward returns
    var featDates = [];
    for (var t = lookback; t < N - fwdHorizon; t++) {
      var window21 = closes.slice(t-21, t);
      var window63 = closes.slice(t-63, t);
      // Momentum (21d return)
      var mom21 = (closes[t-1] - closes[t-21]) / closes[t-21];
      // 63-day volatility
      var rets63 = []; for (var k = 1; k < window63.length; k++) rets63.push((window63[k] - window63[k-1])/window63[k-1]);
      var mean63 = rets63.reduce(function(s,v){return s+v;},0)/rets63.length;
      var vari63 = rets63.reduce(function(s,v){return s+(v-mean63)*(v-mean63);},0)/(rets63.length-1);
      var vol63 = Math.sqrt(vari63) * Math.sqrt(252);
      // Mean reversion (10d return)
      var mr10 = (closes[t-1] - closes[t-11]) / closes[t-11];
      // 252-day trailing return
      var tr252 = t >= 252 ? (closes[t-1] - closes[t-252]) / closes[t-252] : 0;
      // VIX level
      var vix = vixMap[dates[t]] || 20;
      // RSI14 proxy
      var gains = 0, losses = 0;
      for (var k = 1; k < 15; k++) { var ch = closes[t-k] - closes[t-k-1]; if (ch > 0) gains += ch; else losses -= ch; }
      var rsi = losses > 0 ? 100 - (100 / (1 + gains/losses)) : 50;
      // Forward 21-day return (target)
      var fwdRet = (closes[t + fwdHorizon] - closes[t]) / closes[t];
      features.push([1, mom21, vol63, mr10, tr252, vix/100, rsi/100]); // with intercept
      targets.push(fwdRet);
      featDates.push(dates[t]);
    }

    var TT = features.length;
    if (TT < 200) { el.innerHTML = '<div style="color:var(--warning);padding:10px;">Not enough observations after feature construction.</div>'; return; }

    // Walk-forward setup
    var initialTrainEnd = Math.floor(TT * trainFrac);
    var testStep = Math.max(20, Math.floor(TT * testFrac));
    var folds = [];
    var trainEnd = initialTrainEnd;
    while (trainEnd + testStep <= TT) {
      folds.push({ trainStart: 0, trainEnd: trainEnd, testStart: trainEnd, testEnd: Math.min(trainEnd + testStep, TT) });
      trainEnd += testStep;
    }

    // OLS solver (Gauss-Jordan)
    function olsFit(X, y) {
      var n = X.length, k = X[0].length;
      var XtX = []; for (var i = 0; i < k; i++) XtX.push(new Array(k).fill(0));
      var Xty = new Array(k).fill(0);
      X.forEach(function(row, t){ for (var i = 0; i < k; i++) { Xty[i] += row[i]*y[t]; for (var j = 0; j < k; j++) XtX[i][j] += row[i]*row[j]; } });
      var aug = XtX.map(function(r, i){ var id = new Array(k).fill(0); id[i] = 1; return r.concat(id); });
      for (var col = 0; col < k; col++) {
        var maxRow = col; for (var r2 = col+1; r2 < k; r2++) if (Math.abs(aug[r2][col]) > Math.abs(aug[maxRow][col])) maxRow = r2;
        var tmp = aug[col]; aug[col] = aug[maxRow]; aug[maxRow] = tmp;
        if (Math.abs(aug[col][col]) < 1e-12) continue;
        var div = aug[col][col]; for (var j = 0; j < 2*k; j++) aug[col][j] /= div;
        for (var r2 = 0; r2 < k; r2++) { if (r2 === col) continue; var f = aug[r2][col]; for (var j = 0; j < 2*k; j++) aug[r2][j] -= f*aug[col][j]; }
      }
      var inv = aug.map(function(r){return r.slice(k);});
      var betas = new Array(k).fill(0); for (var i = 0; i < k; i++) for (var j = 0; j < k; j++) betas[i] += inv[i][j]*Xty[j];
      return betas;
    }

    // Run walk-forward
    var predictions = []; // {date, actual, predicted, signal, insample: false}
    folds.forEach(function(fold){
      var Xtrain = features.slice(fold.trainStart, fold.trainEnd);
      var ytrain = targets.slice(fold.trainStart, fold.trainEnd);
      var Xtest = features.slice(fold.testStart, fold.testEnd);
      var ytest = targets.slice(fold.testStart, fold.testEnd);
      var datesTest = featDates.slice(fold.testStart, fold.testEnd);
      var betas = olsFit(Xtrain, ytrain);
      Xtest.forEach(function(row, i){
        var pred = 0; row.forEach(function(v, k){ pred += v*betas[k]; });
        predictions.push({ date: datesTest[i], actual: ytest[i], predicted: pred, signal: pred >= threshold });
      });
    });

    // Compute OOS performance metrics
    var nPreds = predictions.length;
    var correctDir = predictions.filter(function(p){ return (p.predicted >= 0 && p.actual >= 0) || (p.predicted < 0 && p.actual < 0); }).length;
    var dirAccuracy = correctDir / nPreds * 100;
    var signalPreds = predictions.filter(function(p){return p.signal;});
    var signalHit = signalPreds.filter(function(p){return p.actual > 0;}).length;
    var signalHitRate = signalPreds.length > 0 ? signalHit / signalPreds.length * 100 : 0;
    var signalAvgRet = signalPreds.length > 0 ? signalPreds.reduce(function(s,p){return s+p.actual;},0)/signalPreds.length*100 : 0;
    // IS/OOS R² sanity
    var meanY = targets.slice(initialTrainEnd).reduce(function(s,v){return s+v;},0)/(targets.length-initialTrainEnd);
    var ssRes = predictions.reduce(function(s,p){return s + (p.actual-p.predicted)*(p.actual-p.predicted);}, 0);
    var ssTot = predictions.reduce(function(s,p){return s + (p.actual-meanY)*(p.actual-meanY);}, 0);
    var oosR2 = ssTot > 0 ? 1 - ssRes/ssTot : 0;

    // Build strategy equity curve (signal-based, hold 21d)
    var equity = [10000];
    var equityDates = [];
    var bhEquity = [10000];
    var signalDays = {}; // track which days are "in position"
    // Process each prediction day
    predictions.forEach(function(p, idx){
      equityDates.push(p.date);
      // Strategy: hold if signal, scale returns by 1/21 per day held (spreading the 21d move)
      var dailyRet = p.signal ? p.actual / fwdHorizon : 0;
      equity.push(equity[equity.length-1] * (1 + dailyRet));
      // Buy-and-hold: scale similarly
      bhEquity.push(bhEquity[bhEquity.length-1] * (1 + p.actual / fwdHorizon));
    });
    var finalStrat = equity[equity.length-1];
    var finalBH = bhEquity[bhEquity.length-1];
    var stratRet = (finalStrat / 10000 - 1) * 100;
    var bhRet = (finalBH / 10000 - 1) * 100;

    // Render stats
    el.innerHTML = '<div style="text-align:left;padding:0 4px;">'
      +'<div class="chart-stats" style="margin-bottom:14px;">'
      +'<div class="chart-stat-box"><div class="chart-stat-label">OOS Observations <span class="help-icon" title="Total number of out-of-sample test predictions made across all walk-forward folds. More observations = more statistical confidence in the metrics.">?</span></div><div class="chart-stat-value">'+nPreds+'</div><div class="chart-stat-sub">across '+folds.length+' folds</div></div>'
      +'<div class="chart-stat-box"><div class="chart-stat-label">Direction Accuracy <span class="help-icon" title="% of times the model predicted the correct sign (up vs down) for forward returns. 50% = random; &gt; 55% on a large sample is a meaningful edge.">?</span></div><div class="chart-stat-value" style="color:'+(dirAccuracy>=50?C.success:C.danger)+';">'+dirAccuracy.toFixed(1)+'%</div><div class="chart-stat-sub">vs. 50% random</div></div>'
      +'<div class="chart-stat-box"><div class="chart-stat-label">OOS R² <span class="help-icon" title="Out-of-Sample R-squared. The fraction of return variance the model explains on data it has never seen. &gt; 2% is genuinely good for monthly stock-return prediction. Negative = model is worse than predicting the mean.">?</span></div><div class="chart-stat-value" style="color:'+(oosR2>0?C.success:C.danger)+';">'+(oosR2*100).toFixed(2)+'%</div><div class="chart-stat-sub">'+(oosR2>0?'Predictive':'No predictive power')+'</div></div>'
      +'<div class="chart-stat-box"><div class="chart-stat-label">Signal Hit Rate <span class="help-icon" title="When the model fired a buy signal (predicted return above your threshold), what % of the time did the actual return turn out positive?">?</span></div><div class="chart-stat-value" style="color:'+(signalHitRate>=50?C.success:C.danger)+';">'+signalHitRate.toFixed(1)+'%</div><div class="chart-stat-sub">'+signalPreds.length+' signals fired</div></div>'
      +'<div class="chart-stat-box"><div class="chart-stat-label">Avg Signal Return <span class="help-icon" title="Average actual 21-day forward return when the model fired a buy signal. Should be meaningfully greater than the unconditional average return.">?</span></div><div class="chart-stat-value" style="color:'+(signalAvgRet>=0?C.success:C.danger)+';">'+(signalAvgRet>=0?'+':'')+signalAvgRet.toFixed(2)+'%</div><div class="chart-stat-sub">per 21d signal</div></div>'
      +'<div class="chart-stat-box"><div class="chart-stat-label">Strategy vs Buy &amp; Hold <span class="help-icon" title="The signal-based strategy&apos;s total return minus the buy-and-hold baseline. Positive = the model added value beyond simply holding the stock. Negative = you would have done better just holding through the whole period.">?</span></div><div class="chart-stat-value" style="color:'+((stratRet-bhRet)>=0?C.success:C.danger)+';">'+(stratRet-bhRet>=0?'+':'')+(stratRet-bhRet).toFixed(1)+'%</div><div class="chart-stat-sub">Strat: '+(stratRet>=0?'+':'')+stratRet.toFixed(1)+'% | BH: '+(bhRet>=0?'+':'')+bhRet.toFixed(1)+'%</div></div>'
      +'</div>'
      +'<div style="font-size:12px;color:var(--text-sec);margin-top:6px;">'
      +'<strong>Interpretation:</strong> '+(oosR2>0.02?'Model has measurable out-of-sample predictive power. ':oosR2>0?'Weak predictive power — likely overfit. ':'No predictive power — model should not be used as-is. ')
      +(stratRet>bhRet?'Signal-based strategy outperformed buy-and-hold':'Signal-based strategy did not outperform buy-and-hold')+' over the backtest window.'
      +'</div></div>';

    // Equity curve chart
    equityWrap.style.display = 'block';
    if (window._wfbEquity) window._wfbEquity.destroy();
    window._wfbEquity = new Chart(document.getElementById('wfbEquityChart').getContext('2d'), {
      type: 'line',
      data: {
        labels: equityDates,
        datasets: [
          { label: 'Walk-Forward Strategy', data: equity.slice(1), borderColor: C.navy, backgroundColor: 'rgba(0,60,113,0.06)', borderWidth: 2, pointRadius: 0, fill: false, tension: 0.05 },
          { label: 'Buy & Hold Baseline', data: bhEquity.slice(1), borderColor: C.textSec, backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [4,3], pointRadius: 0, fill: false, tension: 0.05 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: {font:{size:10}, color:C.textSec} }, tooltip: Object.assign({}, chartTooltip, { callbacks: { label: function(ctx){return ctx.dataset.label+': $'+ctx.parsed.y.toFixed(0);}}})},
        scales: {
          x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { maxTicksLimit: 10, autoSkip: true }) },
          y: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { callback: function(v){return '$'+Math.round(v/1000)+'K';}}), title:{display:true, text:'Equity ($10K start)', color:C.textSec, font:{size:11}} }
        }
      }
    });

    // Predicted vs Actual scatter
    predWrap.style.display = 'block';
    if (window._wfbPred) window._wfbPred.destroy();
    window._wfbPred = new Chart(document.getElementById('wfbPredChart').getContext('2d'), {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'OOS Predictions',
          data: predictions.map(function(p){return {x: p.predicted*100, y: p.actual*100};}),
          backgroundColor: 'rgba(0,60,113,0.35)',
          pointRadius: 3
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: Object.assign({}, chartTooltip, { callbacks: { label: function(ctx){ return 'Predicted: '+ctx.parsed.x.toFixed(2)+'% | Actual: '+ctx.parsed.y.toFixed(2)+'%'; }}})},
        scales: {
          x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { callback: function(v){return v.toFixed(1)+'%';}}), title:{display:true, text:'Predicted 21d Return (%)', color:C.textSec, font:{size:11}} },
          y: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { callback: function(v){return v.toFixed(1)+'%';}}), title:{display:true, text:'Actual 21d Return (%)', color:C.textSec, font:{size:11}} }
        }
      }
    });
  } catch(e) {
    el.innerHTML = '<div style="color:var(--danger);padding:10px;"><strong>Walk-forward failed:</strong> '+e.message+'</div>';
  }
}

// ═══════════════════════════════════════════════════════════════════
// FIXES #2–#6 — Themes tab, What-If, Recommended-State overlay,
// Holdings collapse, Research/Quant merge, Regime-conditional correlation
// ═══════════════════════════════════════════════════════════════════

// ────────── Holdings card collapse (Fix #3) ──────────
window._pfHoldingsCollapsed = false;
function pfHoldingsToggle() {
  var body = document.getElementById('pfHoldingsBody');
  var src = document.getElementById('pfHoldingsSources');
  var caret = document.getElementById('pfHoldingsCaret');
  if (!body) return;
  window._pfHoldingsCollapsed = !window._pfHoldingsCollapsed;
  body.style.display = window._pfHoldingsCollapsed ? 'none' : '';
  if (src) src.style.display = window._pfHoldingsCollapsed ? 'none' : '';
  if (caret) caret.style.transform = window._pfHoldingsCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
}

// ────────── Research / Quant Models tab merger (Fix #4) ──────────
// ═══════════════════════════════════════════════════════════════════
// MARKET BASELINE TAB — top-down sector / asset-class / theme scan
// with curated baseline tickers. Fresh Yahoo data per pull.
// ═══════════════════════════════════════════════════════════════════
var _baselineData = null;
async function loadMarketBaseline(force) {
  var el = document.getElementById('baselineContent');
  if (!el) return;
  if (_baselineData && !force) { renderMarketBaseline(_baselineData); return; }
  el.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-sec);"><span class="spinner"></span><br><br>Pulling fresh quotes for ~70 baseline tickers…</div>';
  try {
    var WORKER = window.WORKER_URL || 'https://perry-finance-proxy.zachperrybusiness.workers.dev';
    var r = await fetch(WORKER + '/baseline' + (force ? '?fresh=1' : ''));
    var d = await r.json();
    if (d.error) throw new Error(d.error);
    _baselineData = d;
    renderMarketBaseline(d);
  } catch(e) {
    el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--danger);">Failed to load baseline: '+e.message+' <button class="btn btn-sm" onclick="loadMarketBaseline(true)">Retry</button></div>';
  }
}

function baselinePickTicker(t) {
  var ri = document.getElementById('researchTicker');
  if (ri) { ri.value = t; rqShowTab('research'); if (typeof runResearch === 'function') runResearch(); }
}

function renderMarketBaseline(d) {
  var el = document.getElementById('baselineContent');
  if (!el) return;
  var ts = document.getElementById('baselineTimestamp');
  if (ts) ts.textContent = 'Data as of ' + new Date(d.timestamp).toLocaleString();
  // Current regime (committed macro phase) for alignment stars
  var regime = null;
  try { regime = sessionStorage.getItem('perry_macro_phase_committed'); } catch(e) {}
  var fmtPct = function(v) {
    if (v == null) return '<span style="color:var(--text-sec);">—</span>';
    var c = v >= 0 ? C.success : C.danger;
    return '<span style="color:'+c+';font-weight:600;font-family:monospace;">'+(v>=0?'+':'')+v.toFixed(1)+'%</span>';
  };
  var chip = function(t) {
    if (!t || t.price == null) return t ? '<span style="display:inline-block;background:var(--panel);border:1px dashed var(--border);border-radius:12px;padding:2px 8px;margin:1px;font-size:10.5px;color:var(--text-sec);">'+t.ticker+' n/a</span>' : '';
    var cc = (t.chg3m != null && t.chg3m >= 0) ? C.success : C.danger;
    return '<span onclick="baselinePickTicker(\''+t.ticker+'\')" title="Click to research '+t.ticker+' — $'+t.price+' · 1Y '+(t.chg1y!=null?(t.chg1y>=0?'+':'')+t.chg1y.toFixed(1)+'%':'n/a')+'" '
      + 'style="display:inline-block;cursor:pointer;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:2px 8px;margin:1px;font-size:10.5px;">'
      + '<strong style="color:var(--navy);">'+t.ticker+'</strong> <span style="color:'+cc+';font-weight:600;">'+(t.chg3m!=null?(t.chg3m>=0?'+':'')+t.chg3m.toFixed(0)+'%':'')+'</span></span>';
  };
  function sectionTable(title, rows, showThesis) {
    var h = '<div style="background:var(--navy);color:#fff;padding:8px 16px;font-size:12px;font-weight:700;letter-spacing:.3px;">'+title+'</div>';
    h += '<div style="overflow-x:auto;"><table style="width:100%;font-size:11.5px;border-collapse:collapse;">';
    h += '<thead><tr style="background:var(--panel);">'
      + '<th style="padding:7px 12px;text-align:left;color:var(--text-sec);border-bottom:1px solid var(--border);min-width:150px;">Group</th>'
      + '<th style="padding:7px 12px;text-align:left;color:var(--text-sec);border-bottom:1px solid var(--border);">ETF</th>'
      + '<th style="padding:7px 12px;text-align:right;color:var(--text-sec);border-bottom:1px solid var(--border);">Price</th>'
      + '<th style="padding:7px 12px;text-align:right;color:var(--text-sec);border-bottom:1px solid var(--border);">1M</th>'
      + '<th style="padding:7px 12px;text-align:right;color:var(--text-sec);border-bottom:1px solid var(--border);">3M</th>'
      + '<th style="padding:7px 12px;text-align:right;color:var(--text-sec);border-bottom:1px solid var(--border);">6M</th>'
      + '<th style="padding:7px 12px;text-align:right;color:var(--text-sec);border-bottom:1px solid var(--border);">1Y</th>'
      + '<th style="padding:7px 12px;text-align:center;color:var(--text-sec);border-bottom:1px solid var(--border);" title="Above or below the 200-day moving average">Trend</th>'
      + '<th style="padding:7px 12px;text-align:left;color:var(--text-sec);border-bottom:1px solid var(--border);min-width:220px;">Baseline Tickers (click to research)</th>'
      + '</tr></thead><tbody>';
    rows.forEach(function(row, i) {
      var q = row.etfData || {};
      var aligned = regime && row.regimes && row.regimes.indexOf(regime) >= 0;
      var trendBadge = q.above200dma == null ? '—' : (q.above200dma ? '<span style="color:'+C.success+';font-weight:700;">▲ Up</span>' : '<span style="color:'+C.danger+';font-weight:700;">▼ Down</span>');
      h += '<tr style="'+(i%2?'background:rgba(0,0,0,0.02);':'')+'border-bottom:1px solid var(--border);'+(aligned?'box-shadow:inset 3px 0 0 '+C.success+';':'')+'">'
        + '<td style="padding:7px 12px;font-weight:600;">'+(aligned?'<span title="Favored by the playbook for the current regime ('+regime+')">⭐ </span>':'')+row.name+(showThesis&&row.thesis?' <span class="help-icon" title="'+String(row.thesis).replace(/"/g,'&quot;')+'" data-heading="'+row.name+'" style="font-size:10px;">ⓘ</span>':'')+'</td>'
        + '<td style="padding:7px 12px;"><strong style="color:var(--navy);cursor:pointer;" onclick="baselinePickTicker(\''+row.etf+'\')" title="Click to research '+row.etf+'">'+row.etf+'</strong></td>'
        + '<td style="padding:7px 12px;text-align:right;font-family:monospace;">'+(q.price!=null?'$'+q.price.toLocaleString(undefined,{maximumFractionDigits:2}):'—')+'</td>'
        + '<td style="padding:7px 12px;text-align:right;">'+fmtPct(q.chg1m)+'</td>'
        + '<td style="padding:7px 12px;text-align:right;">'+fmtPct(q.chg3m)+'</td>'
        + '<td style="padding:7px 12px;text-align:right;">'+fmtPct(q.chg6m)+'</td>'
        + '<td style="padding:7px 12px;text-align:right;">'+fmtPct(q.chg1y)+'</td>'
        + '<td style="padding:7px 12px;text-align:center;">'+trendBadge+'</td>'
        + '<td style="padding:7px 12px;">'+(row.baselineData||[]).map(chip).join('')+'</td>'
        + '</tr>';
    });
    h += '</tbody></table></div>';
    return h;
  }
  var html = '';
  if (regime) {
    html += '<div style="padding:8px 16px;background:rgba(46,125,82,0.06);border-bottom:1px solid var(--border);font-size:11.5px;color:var(--text-sec);">Current macro regime: <strong style="color:var(--navy);">'+regime+'</strong> — ⭐ rows are the groups the cycle playbook favors right now. (Regime comes from the Macro Regime Analysis scorecard.)</div>';
  } else {
    html += '<div style="padding:8px 16px;background:rgba(139,105,20,0.06);border-bottom:1px solid var(--border);font-size:11.5px;color:var(--text-sec);">Visit <a href="javascript:navigateTo(\'macro\')" style="color:var(--navy);font-weight:600;">Macro Regime Analysis</a> first to load the current regime — then ⭐ markers will show which groups the playbook favors.</div>';
  }
  html += sectionTable('SECTORS — 11 GICS sectors via SPDR ETFs', d.sectors || [], false);
  html += sectionTable('ASSET CLASSES — equity, duration, credit, real assets, cash', d.assetClasses || [], false);
  html += sectionTable('PORTFOLIO THEMES — curated secular baskets (hover ⓘ for thesis)', d.themes || [], true);
  el.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════
// LINE ITEM EXPLORER — any statement line: 5y actuals + 3y CAGR
// projection + optional peer overlay (income items). Added 2026-07.
// ═══════════════════════════════════════════════════════════════════
var _liExplorerChart = null;
var LI_ITEMS = [
  { key:'revenue',        label:'Revenue',              stmt:'incomeStatement',  peer:'revenue' },
  { key:'grossProfit',    label:'Gross Profit',         stmt:'incomeStatement',  peer:'grossProfit' },
  { key:'operatingIncome',label:'Operating Income',     stmt:'incomeStatement',  peer:'operatingIncome' },
  { key:'netIncome',      label:'Net Income',           stmt:'incomeStatement',  peer:'netIncome' },
  { key:'eps',            label:'EPS (Diluted)',        stmt:'incomeStatement',  peer:'eps' },
  { key:'researchAndDev', label:'R&D Expense',          stmt:'incomeStatement',  peer:null },
  { key:'totalAssets',    label:'Total Assets',         stmt:'balanceSheet',     peer:null },
  { key:'totalLiabilities',label:'Total Liabilities',   stmt:'balanceSheet',     peer:null },
  { key:'stockholdersEquity',label:'Shareholders’ Equity', stmt:'balanceSheet', peer:null },
  { key:'cash',           label:'Cash & Equivalents',   stmt:'balanceSheet',     peer:null },
  { key:'longTermDebt',   label:'Long-Term Debt',       stmt:'balanceSheet',     peer:null },
  { key:'operatingCashFlow',label:'Operating Cash Flow',stmt:'cashFlowStatement',peer:null },
  { key:'capitalExpenditures',label:'Capital Expenditures',stmt:'cashFlowStatement',peer:null },
  { key:'stockRepurchases',label:'Share Buybacks',      stmt:'cashFlowStatement',peer:null }
];
// ── Asset-type banner (2026-07): ETFs/funds/crypto don't file 10-Ks, so
// instead of empty statement tables the tab explains what applies and shows
// fund facts (expense ratio, AUM, top holdings, sector weights) when available.
function resAssetTypeBanner(tk, d) {
  var host = document.getElementById('resFinancialsContent');
  if (!host) return;
  var banner = document.getElementById('resAssetBanner');
  if (!banner) { banner = document.createElement('div'); banner.id = 'resAssetBanner'; host.insertBefore(banner, host.firstChild); }
  var type = d.assetType || (d.profile && d.profile.type) || 'EQUITY';
  if (type === 'EQUITY') { banner.innerHTML = ''; banner.style.display = 'none'; return; }
  banner.style.display = 'block';
  var h = '<div class="card" style="margin-bottom:14px;">'
    + '<div class="card-title">' + (type === 'CRYPTO' ? '🪙 ' + tk + ' is a Crypto Asset' : '📦 ' + tk + ' is a ' + (type === 'FUND' ? 'Mutual Fund' : 'Fund (ETF)')) + '</div>'
    + '<div class="card-body">'
    + '<div style="font-size:12.5px;color:var(--text-sec);line-height:1.6;margin-bottom:10px;">'
    + (type === 'CRYPTO'
        ? 'Crypto assets have no income statements, balance sheets, or analyst estimates — the fundamental tables below don\'t apply. Use the Overview chart, Quant Models, and regime analytics for this asset.'
        : 'Funds don\'t file 10-K financial statements — they hold OTHER companies\' securities. The statement tables below don\'t apply; the fund facts here and the Overview/Quant tabs do. To research fundamentals, analyze the fund\'s top holdings directly (click any below).')
    + '</div>';
  var info = d.etfInfo || {};
  var facts = [
    ['Expense Ratio', info.expenseRatio != null ? (info.expenseRatio * (info.expenseRatio < 1 ? 100 : 1)).toFixed(2) + '%' : null],
    ['AUM', info.aum != null ? '$' + (info.aum >= 1e9 ? (info.aum/1e9).toFixed(1) + 'B' : (info.aum/1e6).toFixed(0) + 'M') : null],
    ['NAV', info.nav != null ? '$' + Number(info.nav).toFixed(2) : null],
    ['Holdings', info.holdingsCount != null ? info.holdingsCount : null],
    ['Issuer', info.etfCompany || null],
    ['Inception', info.inceptionDate || null]
  ].filter(function(f){ return f[1] != null; });
  if (facts.length) {
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:10px;">'
      + facts.map(function(f){ return '<div style="background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:8px 12px;"><div style="font-size:10px;color:var(--text-sec);text-transform:uppercase;">'+f[0]+'</div><div style="font-size:15px;font-weight:800;color:var(--navy);">'+f[1]+'</div></div>'; }).join('')
      + '</div>';
  }
  if (info.topHoldings && info.topHoldings.length) {
    h += '<div style="font-size:11px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">Top Holdings (click to research)</div><div style="margin-bottom:8px;">'
      + info.topHoldings.map(function(x){ return '<span onclick="baselinePickTicker(\''+String(x.asset||'').replace(/[^A-Za-z0-9\.\-]/g,'')+'\')" style="display:inline-block;cursor:pointer;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:2px 9px;margin:2px;font-size:11px;"><strong style="color:var(--navy);">'+(x.asset||'—')+'</strong>'+(x.weight!=null?' <span style="color:var(--text-sec);">'+Number(x.weight).toFixed(1)+'%</span>':'')+'</span>'; }).join('')
      + '</div>';
  }
  if (info.sectorWeights && info.sectorWeights.length) {
    h += '<div style="font-size:11px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">Sector Weights</div><div>'
      + info.sectorWeights.map(function(x){ var w = Number(String(x.weight).replace('%',''))||0; return '<div style="display:flex;align-items:center;gap:8px;font-size:11.5px;padding:2px 0;"><span style="min-width:150px;">'+x.sector+'</span><div style="flex:1;height:8px;background:var(--panel);border-radius:4px;"><div style="width:'+Math.min(100,w)+'%;height:100%;background:rgba(0,60,113,0.6);border-radius:4px;"></div></div><span style="min-width:44px;text-align:right;font-family:monospace;">'+w.toFixed(1)+'%</span></div>'; }).join('')
      + '</div>';
  }
  h += '</div><div class="card-sources"><strong>Source:</strong> FMP fund data via Cloudflare Worker <code>/fundamentals</code>. Fields unavailable for some funds show nothing rather than junk.</div></div>';
  banner.innerHTML = h;
}

function liExplorerInit() {
  var sel = document.getElementById('liExplorerItem');
  if (!sel) return;
  if (!sel.options.length) {
    sel.innerHTML = LI_ITEMS.map(function(it){ return '<option value="'+it.key+'">'+it.label+'</option>'; }).join('');
  }
  liExplorerRender();
}
async function liExplorerRender() {
  var d = window._lastSecData, tk = window._lastSecTicker;
  var note = document.getElementById('liExplorerNote');
  var canvas = document.getElementById('liExplorerChart');
  if (!canvas || !d || !tk) return;
  var key = (document.getElementById('liExplorerItem')||{}).value || 'revenue';
  var wantPeers = !!(document.getElementById('liExplorerPeers')||{}).checked;
  var item = LI_ITEMS.find(function(i){ return i.key === key; }) || LI_ITEMS[0];
  // Anchor series from SEC; FMP backfill for income items when SEC came back thin
  var series = ((d[item.stmt]||{})[item.key]) || [];
  var pts = series.map(function(s){ return { year: s.year, value: s.value }; }).filter(function(p){ return p.value != null; });
  var usedFmp = false;
  if (pts.length < 3 && item.peer) {
    try {
      var fb = await fetch(WORKER_URL + '/peer-financials?symbols=' + encodeURIComponent(tk)).then(function(r){ return r.json(); });
      var inc = fb && fb.peers && fb.peers[0] && fb.peers[0].income;
      if (inc && inc.length) { pts = inc.map(function(r){ return { year: r.year, value: r[item.peer] }; }).filter(function(p){ return p.value != null; }); usedFmp = true; }
    } catch(e) {}
  }
  if (pts.length < 2) { if (note) note.innerHTML = '<span style="color:#8B6914;">Not enough history for '+item.label+' on '+tk+' — SEC and FMP both returned fewer than 2 annual points.</span>'; return; }
  // 3-year projection from trailing CAGR (guards: needs positive endpoints)
  var years = pts.map(function(p){ return p.year; });
  var vals = pts.map(function(p){ return p.value; });
  var n = vals.length;
  var cagr = (vals[0] > 0 && vals[n-1] > 0) ? Math.pow(vals[n-1]/vals[0], 1/(n-1)) - 1 : null;
  var projYears = [], projVals = [];
  if (cagr != null) {
    var lastY = parseInt(years[n-1], 10), lastV = vals[n-1];
    for (var pi = 1; pi <= 3; pi++) { projYears.push(String(lastY+pi)+'E'); lastV = lastV*(1+cagr); projVals.push(+lastV.toFixed(4)); }
  }
  var labels = years.concat(projYears);
  var actualData = vals.concat(projYears.map(function(){ return null; }));
  var projData = years.map(function(){ return null; }); projData[years.length-1] = vals[n-1]; projData = projData.concat(projVals);
  var datasets = [
    { label: tk + ' (actual'+(usedFmp?' — FMP':'')+')', data: actualData, borderColor: C.navy, backgroundColor: 'rgba(0,60,113,0.08)', borderWidth: 2.5, pointRadius: 3, tension: 0.15, fill: false },
    { label: tk + ' projection ('+(cagr!=null?(cagr>=0?'+':'')+(cagr*100).toFixed(1)+'%/yr':'n/a')+')', data: projData, borderColor: C.navy, borderDash: [6,4], borderWidth: 2, pointRadius: 3, pointStyle: 'rectRot', tension: 0.15, fill: false }
  ];
  var peerNote = '';
  if (wantPeers && item.peer) {
    try {
      var peerStr = (document.getElementById('resPeerTickers')||{}).value || '';
      var peers = peerStr.split(',').map(function(p){ return p.trim().toUpperCase(); }).filter(Boolean).slice(0, 5);
      if (peers.length) {
        var pk = await fetch(WORKER_URL + '/peer-financials?symbols=' + encodeURIComponent(peers.join(','))).then(function(r){ return r.json(); });
        (pk.peers || []).forEach(function(p, i2) {
          if (!p.income || !p.income.length) return;
          var m = {}; p.income.forEach(function(r){ if (r[item.peer] != null) m[r.year] = r[item.peer]; });
          var dta = labels.map(function(y){ return m[String(y).replace('E','')] != null && String(y).indexOf('E') < 0 ? m[y] : null; });
          if (dta.some(function(v){ return v != null; })) datasets.push({ label: p.symbol, data: dta, borderColor: PALETTE[(i2+3) % PALETTE.length], borderWidth: 1.4, pointRadius: 2, tension: 0.15, fill: false, spanGaps: true });
        });
        peerNote = ' Peer overlay: ' + peers.join(', ') + ' (from the Peer Comparison list — edit it on the Stock vs. Peers tab).';
      } else {
        peerNote = ' <span style="color:#8B6914;">No peers listed — run Auto-Detect on the Stock vs. Peers tab first.</span>';
      }
    } catch(e) { peerNote = ' <span style="color:var(--danger);">Peer overlay failed: '+e.message+'</span>'; }
  } else if (wantPeers && !item.peer) {
    peerNote = ' <span style="color:#8B6914;">Peer overlay is available for income-statement items only.</span>';
  }
  if (note) note.innerHTML = '<strong>'+item.label+'</strong> — '+n+' years of actuals'+(usedFmp?' (SEC thin; using FMP statements)':'')+', 3-year mechanical projection at trailing CAGR.'+peerNote;
  if (_liExplorerChart) { try { _liExplorerChart.destroy(); } catch(e){} }
  var isEps = item.key === 'eps';
  _liExplorerChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels: labels, datasets: datasets },
    options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', labels: { font: { size: 10 }, boxWidth: 12 } },
        tooltip: Object.assign({}, chartTooltip, { callbacks: { label: function(c){ var v = c.parsed.y; if (v == null) return null; return c.dataset.label+': '+(isEps ? '$'+v.toFixed(2) : '$'+(Math.abs(v)>=1e9?(v/1e9).toFixed(1)+'B':(v/1e6).toFixed(0)+'M')); } } }) },
      scales: { x: { grid: { display: false }, ticks: { font: { size: 10 } } },
                y: { grid: chartGrid, ticks: { font: { size: 10 }, callback: function(v){ return isEps ? '$'+v : (Math.abs(v)>=1e9?'$'+(v/1e9).toFixed(0)+'B':'$'+(v/1e6).toFixed(0)+'M'); } } } } }
  });
}

function rqShowTab(name) {
  _toggleTabs('#page-research', 'data-rqtab', name, 'rqtab-');
  if (name === 'baseline' && typeof loadMarketBaseline === 'function') loadMarketBaseline(false);
  // Lazy-load content when tab first visited (if data already loaded)
  var d = window._lastSecData, tk = window._lastSecTicker;
  if (name === 'financials' && d && tk) {
    // Always re-render to ensure latest data is shown
    resRenderFinancials(tk, d);
    resAssetTypeBanner(tk, d);
    setTimeout(liExplorerInit, 150);
    // Ensure RCR card is visible in this tab
    var rcrC = document.getElementById('rcrCard');
    if (rcrC) rcrC.style.display = '';
  }
  // 'peers' is now merged into valuation — redirect
  if (name === 'peers') name = 'valuation';
  if (name === 'valuation' && d && tk) {
    var el2 = document.getElementById('resValuationContent');
    if (el2 && el2.style.display === 'none') {
      el2.style.display = '';
      document.getElementById('resValuationEmpty').style.display = 'none';
      resRenderValuationRatios(tk, d);
      if (typeof ivvLoad === 'function') ivvLoad(tk, d);
      if (typeof ivLoad === 'function') ivLoad(tk);
    }
    // Auto-run peer comparison whenever ticker changes
    if (window._lastPeerAutoTicker !== tk) {
      window._lastPeerAutoTicker = tk;
      setTimeout(resPeerAutoDetect, 250);
    }
  }
  if (name === 'moat' && d && tk) {
    var moatEmpty = document.getElementById('resMoatEmpty');
    var moatContent = document.getElementById('resMoatContent');
    if (moatContent && moatContent.style.display === 'none') {
      moatContent.style.display = '';
      if (moatEmpty) moatEmpty.style.display = 'none';
      resMoatRun();
    }
  }
  if (name === 'insider' && tk) {
    var insiderEmpty = document.getElementById('resInsiderEmpty');
    var insiderContent = document.getElementById('resInsiderContent');
    if (insiderContent && insiderContent.style.display === 'none') {
      insiderContent.style.display = '';
      if (insiderEmpty) insiderEmpty.style.display = 'none';
      resInsiderLoad(tk);
    }
  }
  if (name === 'quant') {
    rqLiftQuantContent();
    // Auto-sync ticker from research bar → quant ticker input, then run if not already run for this ticker
    var resTk = (document.getElementById('researchTicker') || {}).value;
    var qtEl = document.getElementById('quantTicker');
    if (resTk && qtEl) {
      var normalized = resTk.trim().toUpperCase();
      if (qtEl.value !== normalized) {
        qtEl.value = normalized;
        if (typeof runQuantAnalysis === 'function') setTimeout(runQuantAnalysis, 80);
      } else if (!window._quantLastTicker || window._quantLastTicker !== normalized) {
        if (typeof runQuantAnalysis === 'function') setTimeout(runQuantAnalysis, 80);
      }
    }
  }
}
// Lift quant page contents into research's quant tab on first navigation
window._rqQuantLifted = false;
function rqLiftQuantContent() {
  if (window._rqQuantLifted) return;
  var src = document.getElementById('page-quant');
  var dst = document.getElementById('rqQuantContainer');
  if (!src || !dst) return;
  // Move children of src .content-wrap (skip hero, since combined page has its own hero)
  var wrap = src.querySelector('.content-wrap');
  if (!wrap) return;
  // Drop hero from quant before moving
  var hero = wrap.querySelector('.hero');
  if (hero) hero.parentNode.removeChild(hero);
  // Move children to dst
  dst.innerHTML = '';
  while (wrap.firstChild) dst.appendChild(wrap.firstChild);
  // Hide source page so old anchor link still doesn't show duplicate
  src.style.display = 'none';
  window._rqQuantLifted = true;
}
function rqSyncQuantTickerAndRun() {
  rqLiftQuantContent();
  rqShowTab('quant');
  var t = document.getElementById('researchTicker');
  var qt = document.getElementById('quantTicker');
  if (t && qt && t.value) qt.value = t.value.toUpperCase();
  if (typeof runQuantAnalysis === 'function') {
    setTimeout(runQuantAnalysis, 80);
  }
}
// Hook into navigateTo so /quant route still works (redirect to /research with quant tab)
(function(){
  document.addEventListener('DOMContentLoaded', function(){
    var orig = window.navigateTo;
    if (typeof orig !== 'function') return;
    window.navigateTo = function(p) {
      if (p === 'quant') {
        orig('research');
        setTimeout(function(){ rqLiftQuantContent(); rqShowTab('quant'); }, 30);
        return;
      }
      orig(p);
      if (p === 'research') {
        setTimeout(rqLiftQuantContent, 60);
      }
    };
  });
})();

// ────────── Add Ticker to Portfolio Chart (Fix #2 — overlay individual ticker on portfolio chart) ──────────
window._pfChartExtraTickers = []; // [{ticker, color}]
function pfAddTickerToChart() {
  var t = prompt('Enter a ticker to overlay on the Portfolio Value chart (e.g., NVDA, BTC-USD):');
  if (!t) return;
  t = t.toUpperCase().trim();
  if (window._pfChartExtraTickers.find(function(x){ return x.ticker === t; })) {
    alert(t + ' already on chart. Click "Update Chart" to refresh.');
    return;
  }
  var palette = ['#A23B72','#F18F01','#48A9A6','#7B68EE','#C84B31','#0F4C81','#5E8C61'];
  var color = palette[window._pfChartExtraTickers.length % palette.length];
  window._pfChartExtraTickers.push({ ticker: t, color: color });
  if (typeof renderPortfolioChart === 'function') renderPortfolioChart();
}
function pfRemoveExtraTicker(t) {
  window._pfChartExtraTickers = window._pfChartExtraTickers.filter(function(x){ return x.ticker !== t; });
  if (typeof renderPortfolioChart === 'function') renderPortfolioChart();
}

// ────────── Recommended Portfolio State backtest overlay (Fix #5) ──────────
window._showRecState = false;
window.toggleRecState = function() {
  window._showRecState = !window._showRecState;
  var btn = document.getElementById('btnRecState');
  if (btn) btn.classList.toggle('active', window._showRecState);
  if (typeof renderPortfolioChart === 'function') renderPortfolioChart();
};

// Toggle benchmark line visibility on portfolio chart
window._benchmarksHidden = false;
window.toggleBenchmarkVisibility = function() {
  window._benchmarksHidden = !window._benchmarksHidden;
  var btn = document.getElementById('btnHideBenchmarks');
  if (btn) {
    btn.classList.toggle('active', !window._benchmarksHidden);
    btn.textContent = window._benchmarksHidden ? 'Benchmarks (Hidden)' : 'Benchmarks';
  }
  // Re-render chart with the hidden flag — renderPortfolioChart reads this flag
  if (typeof renderPortfolioChart === 'function') renderPortfolioChart();
};

// % Change Y-axis toggle
window._pctAxisMode = false;
window.togglePctAxis = function() {
  window._pctAxisMode = !window._pctAxisMode;
  var btn = document.getElementById('btnPctAxis');
  if (btn) btn.classList.toggle('active', window._pctAxisMode);
  if (typeof renderPortfolioChart === 'function') renderPortfolioChart();
};

// B1-B: tap-to-reveal tooltips on metric-cards inside #pftab-risk (event delegation)
document.addEventListener('click', function(e) {
  var card = e.target.closest('#pftab-risk .metric-card');
  if (card) { card.classList.toggle('tip-active'); }
});

// toggleVixRegime is defined earlier in the file (search for _pfOverlayToggle)
// TWR Mode toggle — when ON: chart foregrounds only the TWR line; Portfolio Value line is hidden
// Also adjusts the Forecast Regime overlay to operate on TWR basis
window._twrModeOnly = false;
window.toggleTWRMode = function() {
  window._twrModeOnly = !window._twrModeOnly;
  var btn = document.getElementById('btnTWR');
  if (btn) {
    btn.classList.toggle('active', window._twrModeOnly);
    btn.textContent = window._twrModeOnly ? '📊 Portfolio Value' : '📊 TWR Mode';
    btn.title = window._twrModeOnly
      ? 'Showing Time-Weighted Return — click to switch to Portfolio Dollar Value'
      : 'Showing Portfolio Dollar Value — click to switch to TWR only';
  }
  if (typeof renderPortfolioChart === 'function') renderPortfolioChart();
};

// ═══════════════════════════════════════════════
// ════════  WATCHLIST / TRIAL PORTFOLIO ENGINE  ══
// ═══════════════════════════════════════════════
window._watchlistTickers = []; // array of ticker strings for custom watchlist
window._watchlistMode = '';    // '', '__custom__', '__mirror__', or a PORTFOLIO_THEMES key

// Populate the watchlist select with themed portfolios (matches Themes tab)
function watchlistPopulateSelect() {
  var builtin = document.getElementById('watchlistBuiltinGroup');
  if (!builtin || builtin.children.length) return; // already populated
  (window.PORTFOLIO_THEMES || []).forEach(function(t) {
    var opt = document.createElement('option');
    opt.value = t.key;
    opt.textContent = t.name.replace(/&amp;/g,'&').replace(/&mdash;/g,'—');
    builtin.appendChild(opt);
  });
}

window.watchlistLoad = function() {
  var sel = document.getElementById('watchlistSelect');
  if (!sel) return;
  var val = sel.value;
  window._watchlistMode = val;
  var editor = document.getElementById('watchlistEditor');
  var runBtn = document.getElementById('btnWatchlistRun');
  var status = document.getElementById('watchlistStatus');
  if (!val) {
    if (editor) editor.style.display = 'none';
    if (runBtn) runBtn.style.display = 'none';
    if (status) status.textContent = '';
    window._watchlistTickers = [];
    if (typeof renderPortfolioChart === 'function') renderPortfolioChart();
    return;
  }
  if (val === '__custom__') {
    window._watchlistTickers = [];
    if (editor) editor.style.display = 'flex';
    if (runBtn) runBtn.style.display = '';
    if (status) status.textContent = 'Add tickers then click Compare';
    watchlistRenderChips();
    return;
  }
  if (val === '__mirror__') {
    // Pre-populate with current holdings tickers
    var h = window._holdings || [];
    window._watchlistTickers = [...new Set(h.map(function(hh){ return hh.ticker; }).filter(Boolean))];
    if (editor) editor.style.display = 'flex';
    if (runBtn) runBtn.style.display = '';
    if (status) status.textContent = 'Mirroring your portfolio — add or remove tickers then click Compare';
    watchlistRenderChips();
    return;
  }
  // Built-in theme
  var theme = (window.PORTFOLIO_THEMES || []).find(function(t){ return t.key === val; });
  if (theme) {
    window._watchlistTickers = theme.tickers.slice();
    if (editor) editor.style.display = 'none';
    if (runBtn) runBtn.style.display = '';
    if (status) status.textContent = theme.tickers.length + ' tickers loaded from theme';
    if (typeof renderPortfolioChart === 'function') renderPortfolioChart();
  }
};

window.watchlistAddTicker = function() {
  var inp = document.getElementById('watchlistAddTicker');
  if (!inp) return;
  var t = inp.value.toUpperCase().trim();
  if (!t) return;
  if (!window._watchlistTickers.includes(t)) window._watchlistTickers.push(t);
  inp.value = '';
  watchlistRenderChips();
};

function watchlistRenderChips() {
  var el = document.getElementById('watchlistTickers');
  if (!el) return;
  el.innerHTML = window._watchlistTickers.map(function(t) {
    return '<span style="background:var(--navy);color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;cursor:pointer;" title="Click to remove" onclick="watchlistRemoveTicker(\'' + t + '\')">' + t + ' ×</span>';
  }).join('');
}

window.watchlistRemoveTicker = function(t) {
  window._watchlistTickers = window._watchlistTickers.filter(function(x){ return x !== t; });
  watchlistRenderChips();
};

// Build equal-weight value series for watchlist tickers over given range
// Returns same structure as pfBuildValueSeries
async function watchlistBuildSeries(range) {
  var tickers = window._watchlistTickers;
  if (!tickers.length) return null;
  var WORKER = 'https://perry-finance-proxy.zachperrybusiness.workers.dev';
  var seriesMap = {};
  await Promise.all(tickers.map(async function(t) {
    try {
      var c = await fetchChart(t, range, '1d');
      seriesMap[t] = (c.points || []).filter(function(p){ return p.close != null; });
    } catch(e) { seriesMap[t] = []; }
  }));
  // Union of all dates
  var allDates = new Set();
  Object.values(seriesMap).forEach(function(pts){ pts.forEach(function(p){ allDates.add(p.date.slice(0,10)); }); });
  var dates = Array.from(allDates).sort();
  if (!dates.length) return null;
  // Forward-fill prices
  var priceMap = {};
  tickers.forEach(function(t) {
    priceMap[t] = {};
    (seriesMap[t]||[]).forEach(function(p){ priceMap[t][p.date.slice(0,10)] = p.close; });
  });
  var filledPrices = {};
  tickers.forEach(function(t) {
    var pm = priceMap[t]; var last = null;
    filledPrices[t] = dates.map(function(d){ if (pm[d] != null) last = pm[d]; return last; });
  });
  // Equal-weight rebased index starting at 100
  var basePrices = {};
  tickers.forEach(function(t){ basePrices[t] = filledPrices[t][0] || 1; });
  var values = dates.map(function(d, i) {
    var v = 0; var count = 0;
    tickers.forEach(function(t) {
      var px = filledPrices[t][i]; var b = basePrices[t];
      if (px != null && b > 0) { v += px/b; count++; }
    });
    return count > 0 ? v / count * 100 : 100; // rebased to 100
  });
  return { dates: dates, values: values, rebased: true };
}

// Initialize watchlist select on DOMContentLoaded
document.addEventListener('DOMContentLoaded', function() {
  setTimeout(watchlistPopulateSelect, 1200);
});

// Build a synthetic "Recommended State" return series.
// For each day, the regime is the locked quarterly regime; allocate per state's posture.
async function buildRecommendedStateSeries(rangeKey) {
  // Recommended state weights — proxy ETFs that align with PS_STATES instruments/cash
  var STATE_WEIGHTS = {
    leveraged: { TQQQ: 0.4, SOXL: 0.2, SPY: 0.3, CASH: 0.1 },
    growth:    { QQQ: 0.4, SPY: 0.4, IWM: 0.1, CASH: 0.1 },
    neutral:   { GLD: 0.2, XLU: 0.15, XLP: 0.15, EFA: 0.1, IEF: 0.1, CASH: 0.3 },
    drawdown:  { SHV: 0.45, TLT: 0.2, GLD: 0.05, CASH: 0.3 }
  };
  // Load quarterly regimes if not yet available
  if (!window._quarterlyRegimes) {
    try { await loadQuarterlyRegimes(); } catch(e) {}
  }
  var quarterly = window._quarterlyRegimes ? window._quarterlyRegimes.quarterly : null;
  // Fallback: if still no quarterly data, use a simple SPY-based series
  if (!quarterly || !quarterly.length) {
    try {
      var spy = await fetchChart('SPY', rangeKey === 'ytd' ? '1y' : rangeKey, '1d');
      var pts = (spy.points||[]).filter(function(p){return p.close!=null;});
      if (pts.length < 2) return null;
      var base = pts[0].close;
      return { dates: pts.map(function(p){return p.date.slice(0,10);}), values: pts.map(function(p){return p.close/base*100;}) };
    } catch(e) { return null; }
  }
  // Determine date window
  var today = new Date();
  var start = new Date(today);
  if (rangeKey === '1mo') start.setMonth(today.getMonth() - 1);
  else if (rangeKey === '3mo') start.setMonth(today.getMonth() - 3);
  else if (rangeKey === '6mo') start.setMonth(today.getMonth() - 6);
  else if (rangeKey === 'ytd') start = new Date(today.getFullYear(), 0, 1);
  else if (rangeKey === '1y') start.setFullYear(today.getFullYear() - 1);
  else if (rangeKey === '3y') start.setFullYear(today.getFullYear() - 3);
  else if (rangeKey === '5y') start.setFullYear(today.getFullYear() - 5);
  else if (rangeKey === '10y') start.setFullYear(today.getFullYear() - 10);
  else start.setFullYear(today.getFullYear() - 1);
  // Collect every ticker we may need
  var tickers = {};
  Object.values(STATE_WEIGHTS).forEach(function(w){ Object.keys(w).forEach(function(t){ if (t !== 'CASH') tickers[t] = true; }); });
  var tickerArr = Object.keys(tickers);
  // Fetch all in parallel
  var data = {};
  var fetchRange = (rangeKey === '1mo' || rangeKey === '3mo' || rangeKey === '6mo' || rangeKey === 'ytd' || rangeKey === '1y') ? '1y'
                  : (rangeKey === '3y') ? '3y' : (rangeKey === '5y') ? '5y' : '10y';
  await Promise.all(tickerArr.map(async function(t){
    try {
      var c = await fetchChart(t, fetchRange, '1d');
      var m = {};
      (c.points||[]).forEach(function(p){ if (p.close != null) m[p.date.slice(0,10)] = p.close; });
      data[t] = m;
    } catch(e) { data[t] = {}; }
  }));
  // Master date series — use SPY (if present) otherwise first ticker
  var masterTicker = data.SPY ? 'SPY' : (data.QQQ ? 'QQQ' : tickerArr[0]);
  var masterDates = Object.keys(data[masterTicker]).filter(function(d){ return d >= start.toISOString().slice(0,10); }).sort();
  if (!masterDates.length) return null;
  // Build state-by-date map from quarterly
  function regimeForDate(dateStr) {
    var d = new Date(dateStr + 'T00:00:00Z');
    for (var i = quarterly.length - 1; i >= 0; i--) {
      if (d >= quarterly[i].startDate) return quarterly[i].regime;
    }
    return quarterly[0].regime;
  }
  // Compute daily returns per ticker; CASH = 0% return (or 4.5%/252 short rate)
  function tickerDailyReturn(t, idx, dateArr) {
    if (t === 'CASH') return 0.045 / 252; // approximate risk-free
    var prev = data[t][dateArr[idx-1]]; var cur = data[t][dateArr[idx]];
    if (prev != null && cur != null && prev > 0) return Math.log(cur/prev);
    return 0;
  }
  // Walk dates, compute daily portfolio return based on state weights at quarter start (rebalanced quarterly)
  var values = [100];
  var labels = [masterDates[0]];
  for (var i = 1; i < masterDates.length; i++) {
    var regime = regimeForDate(masterDates[i]);
    var w = STATE_WEIGHTS[regime] || STATE_WEIGHTS.neutral;
    var dayRet = 0;
    Object.keys(w).forEach(function(t){
      dayRet += w[t] * tickerDailyReturn(t, i, masterDates);
    });
    values.push(values[values.length-1] * Math.exp(dayRet));
    labels.push(masterDates[i]);
  }
  return { dates: labels, values: values };
}

// ────────── Themes tab — compare portfolio vs themes (Fix #2) ──────────
function themePopulatePicker() {
  var picker = document.getElementById('themeCmpPicker');
  if (!picker) return;
  if (picker.dataset.built) return;
  picker.dataset.built = '1';
  picker.innerHTML = '<span id="themeCmpCustomSlot"></span>';
  var frag = document.createDocumentFragment();
  (window.PORTFOLIO_THEMES || []).forEach(function(t, idx) {
    var isChecked = idx < 3;
    var label = document.createElement('label');
    label.style.cssText = 'font-size:11px;font-weight:600;padding:4px 10px;border-radius:12px;border:1px solid var(--border);cursor:pointer;display:inline-flex;align-items:center;gap:5px;margin:2px;transition:all 0.15s;' + (isChecked ? 'background:var(--navy);color:#fff;border-color:var(--navy);' : 'background:#fff;color:var(--navy);border-color:var(--border);');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.themecmp = t.key;
    cb.checked = isChecked;
    cb.style.display = 'none';
    cb.addEventListener('change', function() {
      label.style.background = cb.checked ? 'var(--navy)' : '#fff';
      label.style.color = cb.checked ? '#fff' : 'var(--navy)';
      label.style.borderColor = cb.checked ? 'var(--navy)' : 'var(--border)';
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(t.name.replace(/&amp;/g,'&').replace(/&mdash;/g,'—')));
    frag.appendChild(label);
  });
  picker.insertBefore(frag, picker.firstChild);
}
function themeCmpRenderCustom() {
  var slot = document.getElementById('themeCmpCustomSlot');
  if (!slot) return;
  var customs = window._customThemes || [];
  var html = '';
  customs.forEach(function(t){
    html += '<label style="font-size:11px;font-weight:600;color:var(--navy);background:var(--blue-pale,#EAF2FA);padding:3px 8px;border-radius:3px;border:1px solid var(--blue);cursor:pointer;display:inline-flex;align-items:center;gap:5px;">'+
      '<input type="checkbox" data-themecmpcustom="'+t.id+'" style="margin:0;">'+
      '★ '+t.name+
      '</label>';
  });
  slot.innerHTML = html;
}
async function themeCompareRun() {
  var range = document.getElementById('themeCmpRange').value;
  themePopulatePicker(); themeCmpRenderCustom();
  var pickedThemes = Array.from(document.querySelectorAll('#themeCmpPicker input[data-themecmp]:checked')).map(function(i){ return i.dataset.themecmp; });
  var pickedCustom = Array.from(document.querySelectorAll('#themeCmpPicker input[data-themecmpcustom]:checked')).map(function(i){ return i.dataset.themecmpcustom; });
  // Auto-select first 3 themes if none checked
  if (!pickedThemes.length && !pickedCustom.length) {
    var allCbs = Array.from(document.querySelectorAll('#themeCmpPicker input[data-themecmp]'));
    var toCheck = allCbs.slice(0, 3);
    toCheck.forEach(function(cb) {
      cb.checked = true;
      // Update parent label style
      var lbl = cb.closest('label');
      if (lbl) { lbl.style.background='var(--navy)'; lbl.style.color='#fff'; lbl.style.borderColor='var(--navy)'; }
    });
    pickedThemes = toCheck.map(function(cb){ return cb.dataset.themecmp; });
  }
  if (!pickedThemes.length && !pickedCustom.length) {
    document.getElementById('themeCmpStats').innerHTML = '<span style="color:var(--text-sec);">Select at least one theme to compare.</span>';
    return;
  }
  var statsEl = document.getElementById('themeCmpStats');
  statsEl.innerHTML = '<span class="spinner"></span> Loading data…';
  // Build portfolio series
  var pfSeries = await pfBuildValueSeries(range === 'ytd' ? '1y' : range);
  if (!pfSeries.dates || !pfSeries.dates.length) { statsEl.innerHTML = '<span style="color:var(--danger);">No portfolio data — add holdings first.</span>'; return; }
  // For each theme, fetch all its tickers and build equal-weight rebased series
  var themesToRun = [];
  pickedThemes.forEach(function(k){ var t = PORTFOLIO_THEMES.find(function(x){ return x.key===k; }); if (t) themesToRun.push({key:t.key, name:t.name.replace(/&amp;/g,'&').replace(/&mdash;/g,'—'), tickers:t.tickers}); });
  pickedCustom.forEach(function(id){ var t = (window._customThemes||[]).find(function(x){ return x.id===id; }); if (t) themesToRun.push({key:t.id, name:'★ '+t.name, tickers:t.tickers, weights:t.weights}); });
  var fetchRange = range;
  var allData = {};
  var allTickers = new Set();
  themesToRun.forEach(function(t){ t.tickers.forEach(function(tk){ allTickers.add(tk); }); });
  await Promise.all(Array.from(allTickers).map(async function(tk){
    try { var c = await fetchChart(tk, fetchRange === 'ytd' ? '1y' : fetchRange, '1d'); allData[tk] = (c.points || []).filter(function(p){ return p.close != null; }); } catch(e) { allData[tk] = []; }
  }));
  // Determine common starting date — use portfolio start or YTD start
  var startStr = pfSeries.dates[0];
  if (range === 'ytd') {
    var ytdStart = new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0,10);
    startStr = ytdStart;
  }
  // Build series
  var datasets = [];
  // Portfolio (rebased to 100 from startStr)
  var pfStartIdx = 0;
  for (var i = 0; i < pfSeries.dates.length; i++) {
    if (pfSeries.dates[i] >= startStr) { pfStartIdx = i; break; }
  }
  var pfDates = pfSeries.dates.slice(pfStartIdx);
  var pfVals = pfSeries.values.slice(pfStartIdx);
  if (!pfVals.length || pfVals[0] <= 0) { statsEl.innerHTML = '<span style="color:var(--danger);">Insufficient portfolio data for selected window.</span>'; return; }
  var pfBase = pfVals[0];
  var pfRebased = pfVals.map(function(v){ return pfBase > 0 ? v / pfBase * 100 : 100; });
  // Portfolio dataset — use labels array with flat values (not {x,y} objects)
  datasets.push({
    label: 'Your Portfolio',
    data: pfRebased,
    _dates: pfDates,
    borderColor:'#003C71', backgroundColor:'rgba(0,60,113,0.1)',
    borderWidth: 2.5, pointRadius:0, tension:0.15, fill: true
  });

  // Theme baskets — equal-weighted (or custom-weighted) daily-rebalanced rebased
  var themeColors = ['#5B9BD5','#A23B72','#F18F01','#48A9A6','#7B68EE','#C84B31','#0F4C81','#5E8C61'];

  // Build a master date union across portfolio + all themes for aligned x-axis
  var masterDateSet = new Set();
  pfDates.forEach(function(d){ masterDateSet.add(d); });

  var themeSeriesData = []; // collect before rendering so we can align x-axis
  themesToRun.forEach(function(theme, ti){
    var weights = theme.weights || {};
    if (!Object.keys(weights).length) {
      var ew = 1 / theme.tickers.length;
      theme.tickers.forEach(function(t){ weights[t] = ew; });
    }
    var validTickers = theme.tickers.filter(function(t){ return allData[t] && allData[t].length > 2; });
    if (!validTickers.length) return;
    var priceMapTh = {};
    validTickers.forEach(function(t){
      priceMapTh[t] = {};
      (allData[t]||[]).forEach(function(p){ if (p.close != null) priceMapTh[t][p.date.slice(0,10)] = p.close; });
    });
    var theDateSet = new Set();
    validTickers.forEach(function(t){ Object.keys(priceMapTh[t]).forEach(function(d){ if (d >= startStr) theDateSet.add(d); }); });
    var themeDates = Array.from(theDateSet).sort();
    if (!themeDates.length) return;
    themeDates.forEach(function(d){ masterDateSet.add(d); });
    var filledPricesTh = {};
    validTickers.forEach(function(t){
      var pm = priceMapTh[t]; var last = null;
      filledPricesTh[t] = themeDates.map(function(d){ if (pm[d] != null) last = pm[d]; return last; });
    });
    var wSum = 0;
    validTickers.forEach(function(t){ wSum += (weights[t] || (1/validTickers.length)); });
    var normWeights = {};
    validTickers.forEach(function(t){ normWeights[t] = (weights[t] || (1/validTickers.length)) / Math.max(wSum, 0.0001); });
    // date->value map for alignment
    var dateValMap = {};
    var lastFilled = null;
    themeDates.forEach(function(d, i){
      var v = 0;
      validTickers.forEach(function(t){
        var px = filledPricesTh[t][i]; var b = filledPricesTh[t][0] || 1;
        if (px != null && b > 0) v += normWeights[t] * (px/b);
      });
      dateValMap[d] = v * 100;
      lastFilled = dateValMap[d];
    });
    themeSeriesData.push({ label: theme.name, dateValMap: dateValMap, color: themeColors[ti % themeColors.length] });
  });

  // Build aligned master dates array
  var masterDates = Array.from(masterDateSet).sort().filter(function(d){ return d >= startStr; });
  // Thin to max 500 labels for performance
  var step = Math.max(1, Math.floor(masterDates.length / 500));
  var chartDates = masterDates.filter(function(d, i){ return i % step === 0 || i === masterDates.length-1; });

  // Rebuild portfolio data aligned to chartDates (forward-fill)
  var pfDateValMap = {};
  pfDates.forEach(function(d, i){ pfDateValMap[d] = pfRebased[i]; });
  var pfAligned = []; var pfLast = null;
  chartDates.forEach(function(d){ if (pfDateValMap[d] != null) pfLast = pfDateValMap[d]; pfAligned.push(pfLast); });
  datasets[0].data = pfAligned;
  delete datasets[0]._dates;

  // Build theme data aligned to chartDates
  themeSeriesData.forEach(function(ts){
    var aligned = []; var last = null;
    chartDates.forEach(function(d){ if (ts.dateValMap[d] != null) last = ts.dateValMap[d]; aligned.push(last); });
    datasets.push({ label: ts.label, data: aligned, borderColor: ts.color, backgroundColor: 'transparent', borderWidth:1.8, pointRadius:0, tension:0.15, fill: false });
  });

  // Render with labels array
  var ctx = document.getElementById('themeCmpChart');
  if (window._themeCmpChartObj) window._themeCmpChartObj.destroy();
  window._themeCmpChartObj = new Chart(ctx, {
    type: 'line',
    data: { labels: chartDates, datasets: datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation:false,
      plugins: {
        legend: { position:'top', labels:{color:'#1A2733', font:{size:11}, boxWidth:12, padding:14} },
        tooltip: {
          mode:'index', intersect:false,
          callbacks: {
            title: function(items){ return items[0] ? chartDates[items[0].dataIndex] : ''; },
            label: function(ctx){ var v=ctx.parsed.y; return ctx.dataset.label+': '+(v!=null?v.toFixed(2)+'%':'—'); }
          }
        }
      },
      scales: {
        x: { ticks: { color:'#5A6772', maxTicksLimit: 10, maxRotation:0 }, grid: { color:'rgba(208,215,224,0.4)' } },
        y: { ticks: { color:'#5A6772', callback: function(v){ return v!=null?v.toFixed(0):''; } }, grid: { color:'rgba(208,215,224,0.4)' }, title:{display:true, text:'Return indexed to 100', color:'#5A6772', font:{size:11}} }
      }
    }
  });
  // ── Stats table (plain-number arrays — NOT {x,y} objects) ──
  var pfData = datasets[0] ? datasets[0].data : [];
  var statsRows = '<table style="width:100%;border-collapse:collapse;font-size:13px;font-family:Arial;margin-top:6px;line-height:1.5;">';
  statsRows += '<thead><tr style="background:var(--navy);color:#fff;">'
    + '<th style="padding:7px 10px;text-align:left;">Series</th>'
    + '<th style="padding:7px;text-align:right;">Period Return</th>'
    + '<th style="padding:7px;text-align:right;">Vol (Ann.)</th>'
    + '<th style="padding:7px;text-align:right;">Sharpe (Est.)</th>'
    + '<th style="padding:7px;text-align:right;">Max Drawdown</th>'
    + '<th style="padding:7px;text-align:right;">Corr. vs Portfolio</th>'
    + '</tr></thead><tbody>';
  var seriesStats = [];
  datasets.forEach(function(ds) {
    if (!ds.data || !ds.data.length) return;
    var firstIdx = 0;
    while (firstIdx < ds.data.length && (ds.data[firstIdx] == null || ds.data[firstIdx] <= 0)) firstIdx++;
    var lastIdx = ds.data.length - 1;
    while (lastIdx > firstIdx && ds.data[lastIdx] == null) lastIdx--;
    if (firstIdx >= lastIdx) return;
    var first = ds.data[firstIdx], last = ds.data[lastIdx];
    var ret = (last / first - 1) * 100;
    var dailyRets = [];
    for (var ri = firstIdx + 1; ri <= lastIdx; ri++) {
      var rp = ds.data[ri-1], rc = ds.data[ri];
      if (rp != null && rc != null && rp > 0 && rc > 0) dailyRets.push(Math.log(rc/rp));
    }
    var rmean = dailyRets.length ? dailyRets.reduce(function(s,v){return s+v;},0)/dailyRets.length : 0;
    var rvar = dailyRets.length > 1 ? dailyRets.reduce(function(s,x){return s+(x-rmean)*(x-rmean);},0)/(dailyRets.length-1) : 0;
    var volAnn = Math.sqrt(rvar) * Math.sqrt(252) * 100;
    var sharpe = rvar > 0 ? ((rmean - 0.05/252) / Math.sqrt(rvar)) * Math.sqrt(252) : 0;
    var peak = -Infinity, maxDD = 0;
    for (var di = firstIdx; di <= lastIdx; di++) {
      var dv = ds.data[di]; if (dv == null) continue;
      if (dv > peak) peak = dv;
      var dd = peak > 0 ? (dv - peak) / peak : 0;
      if (dd < maxDD) maxDD = dd;
    }
    var ddSeries = []; var pk2 = null;
    for (var ddi = 0; ddi < ds.data.length; ddi++) {
      var ddv = ds.data[ddi];
      if (ddv == null) { ddSeries.push(null); continue; }
      if (pk2 === null || ddv > pk2) pk2 = ddv;
      ddSeries.push(pk2 > 0 ? (ddv - pk2) / pk2 * 100 : 0);
    }
    var corrStr = '—';
    if (ds !== datasets[0] && pfData.length) {
      var xs = [], ys = [];
      for (var ci = 0; ci < Math.min(ds.data.length, pfData.length); ci++) {
        if (ds.data[ci] != null && pfData[ci] != null) { xs.push(ds.data[ci]); ys.push(pfData[ci]); }
      }
      if (xs.length > 10) {
        var mx = xs.reduce(function(s,v){return s+v;},0)/xs.length;
        var my = ys.reduce(function(s,v){return s+v;},0)/ys.length;
        var cnum = 0, cdx2 = 0, cdy2 = 0;
        xs.forEach(function(x,j){ var dx=x-mx, dy=ys[j]-my; cnum+=dx*dy; cdx2+=dx*dx; cdy2+=dy*dy; });
        var corr = cdx2>0&&cdy2>0 ? cnum/Math.sqrt(cdx2*cdy2) : 0;
        var corrColor = Math.abs(corr) > 0.85 ? '#c47c00' : (Math.abs(corr) < 0.4 ? C.success : C.text);
        var corrLabel = Math.abs(corr) > 0.85 ? '(highly correlated)' : (Math.abs(corr) < 0.4 ? '(diversifying!)' : '');
        corrStr = '<span style="color:'+corrColor+';font-weight:600;">'+corr.toFixed(2)+'</span> <span style="font-size:10px;color:var(--text-sec);">'+corrLabel+'</span>';
      }
    } else if (ds === datasets[0]) {
      corrStr = '<span style="color:var(--text-sec);font-size:10px;">baseline</span>';
    }
    seriesStats.push({ label: ds.label, ret: ret, volAnn: volAnn, sharpe: sharpe, maxDD: maxDD, ddSeries: ddSeries, color: ds.borderColor });
    var retColor = ret >= 0 ? C.success : C.danger;
    var sharpeColor = sharpe > 1 ? C.success : (sharpe > 0 ? '#c47c00' : C.danger);
    statsRows += '<tr style="border-bottom:1px solid var(--border-light,#E5E9EF);">'
      + '<td style="padding:6px 10px;color:'+ds.borderColor+';font-weight:700;">'+ds.label+'</td>'
      + '<td style="padding:6px 8px;text-align:right;font-family:Courier New,monospace;color:'+retColor+';font-weight:700;">'+(ret>=0?'+':'')+ret.toFixed(2)+'%</td>'
      + '<td style="padding:6px 8px;text-align:right;font-family:Courier New,monospace;">'+volAnn.toFixed(1)+'%</td>'
      + '<td style="padding:6px 8px;text-align:right;font-family:Courier New,monospace;color:'+sharpeColor+';">'+sharpe.toFixed(2)+'</td>'
      + '<td style="padding:6px 8px;text-align:right;font-family:Courier New,monospace;color:var(--danger);">'+(maxDD*100).toFixed(1)+'%</td>'
      + '<td style="padding:6px 8px;text-align:right;">'+corrStr+'</td>'
      + '</tr>';
  });
  statsRows += '</tbody></table>';

  // Sector composition for each theme (using ETF_DB / STOCK_DB)
  var sectorDonutHtml = '';
  if (themesToRun.length) {
    sectorDonutHtml = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;align-items:start;">';
    themesToRun.forEach(function(theme, ti) {
      sectorDonutHtml += '<div style="text-align:center;"><div style="font-size:11px;font-weight:700;color:'+themeColors[ti%themeColors.length]+';margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+theme.name+'</div><div style="height:170px;position:relative;"><canvas id="themeSectorDonut'+ti+'"></canvas></div></div>';
    });
    sectorDonutHtml += '</div>';
  }

  // How-to walkthrough (collapsible)
  var pfTotalVal2 = pfSeries.values.length ? pfSeries.values[pfSeries.values.length-1] : 0;
  var walkHtml = '';
  if (themesToRun.length) {
    var ft = themesToRun[0];
    walkHtml = '<div style="margin-top:20px;border:1px solid var(--border);border-radius:6px;overflow:hidden;">'
      + '<button onclick="var p=this.nextElementSibling;p.style.display=p.style.display===\'none\'?\'block\':\'none\'" style="width:100%;text-align:left;background:var(--panel);border:none;padding:10px 16px;font-size:13px;font-weight:700;color:var(--navy);cursor:pointer;display:flex;justify-content:space-between;align-items:center;">'
      + '<span>How would I add a theme to my portfolio?</span><span style="font-size:16px;">&#9660;</span></button>'
      + '<div style="display:none;padding:16px;font-size:13px;line-height:1.7;">'
      + '<p><strong>Step 1 — Decide your allocation.</strong> Most investors start with 5&ndash;10% of their portfolio in a single theme. '
      + (pfTotalVal2 > 0 ? 'At your current size, 5% = <strong>'+fmtInt(pfTotalVal2*0.05)+'</strong>.' : '') + '</p>'
      + '<p><strong>Step 2 — Pick your tickers.</strong> The <em>'+ft.name+'</em> basket includes: <span style="font-family:Courier New;background:var(--panel);padding:2px 6px;border-radius:3px;">'+ft.tickers.slice(0,8).join(', ')+(ft.tickers.length>8?' &hellip;':'')+'</span>. Dividing equally means buying the same dollar amount of each.</p>'
      + '<p><strong>Step 3 — Add to Manage Holdings.</strong> Go to <a href="#" onclick="showPage(\'holdings\');return false;" style="color:var(--blue);">Manage Holdings</a> and add each ticker. The app will automatically track them as part of your portfolio.</p>'
      + '<p style="color:var(--text-sec);font-size:11px;">This is informational only, not financial advice. Consider tax implications and your risk profile before making changes.</p>'
      + '</div></div>';
  }

  // ── Assemble the below-chart area as a coherent panel grid ──
  // (Was previously a loose stack of headings, floating donuts and toggle
  //  charts; now each element has a framed panel and a fixed place.)
  function _themePanel(headerHtml, bodyHtml) {
    return '<div style="border:1px solid var(--border);border-radius:6px;overflow:hidden;background:#fff;">'
      + '<div style="background:var(--navy);color:#fff;padding:7px 14px;font-size:12px;font-weight:700;letter-spacing:.3px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">'+headerHtml+'</div>'
      + '<div style="padding:12px 14px;">'+bodyHtml+'</div></div>';
  }
  document.getElementById('themeCmpTable').innerHTML =
    _themePanel('<span>Head-to-Head Statistics <span class="help-icon" data-help="sharpe" style="font-size:11px;">ⓘ</span></span>', statsRows)
    + '<div class="theme-panel-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px;align-items:stretch;">'
    +   _themePanel(
          '<span>Risk Lens <span class="help-icon" title="Three views of the same series: Rolling Sharpe (risk-adjusted consistency — above 1.0 is strong), Drawdown (peak-to-trough losses you would have lived through), and Cumulative Return (total growth rebased to 100). Use the buttons to switch." data-heading="Risk Lens" style="font-size:11px;">ⓘ</span></span>'
          + '<span id="themeChartTypeRow" style="display:flex;gap:6px;flex-wrap:wrap;">'
          + '<button class="btn-outline btn-sm active" style="background:rgba(255,255,255,0.12);color:#fff;border-color:rgba(255,255,255,0.4);" data-theme-chart="sharpe" onclick="themeSetChartType(\'sharpe\',this)">Rolling Sharpe</button>'
          + '<button class="btn-outline btn-sm" style="background:transparent;color:#fff;border-color:rgba(255,255,255,0.4);" data-theme-chart="drawdown" onclick="themeSetChartType(\'drawdown\',this)">Drawdown</button>'
          + '<button class="btn-outline btn-sm" style="background:transparent;color:#fff;border-color:rgba(255,255,255,0.4);" data-theme-chart="cumulative" onclick="themeSetChartType(\'cumulative\',this)">Cumulative</button>'
          + '</span>',
          '<div id="themeRollingSharpeChartWrap">'
          + '<div style="font-size:11px;color:var(--text-sec);margin-bottom:8px;">Rolling 90-day Sharpe — higher and more stable = better risk-adjusted consistency.</div>'
          + '<div style="height:240px;position:relative;"><canvas id="themeRollingSharpeChart"></canvas></div>'
          + '</div>'
          + '<div id="themeDrawdownChartWrap" style="display:none;">'
          + '<div style="font-size:11px;color:var(--text-sec);margin-bottom:8px;">Peak-to-trough losses over the window — the pain you would have sat through.</div>'
          + '<div style="height:240px;position:relative;"><canvas id="themeDrawdownChart"></canvas></div>'
          + '</div>'
          + '<div id="themeCumulChartWrap" style="display:none;">'
          + '<div style="font-size:11px;color:var(--text-sec);margin-bottom:8px;">Total growth of 100 invested at window start.</div>'
          + '<div style="height:240px;position:relative;"><canvas id="themeCumulChart"></canvas></div>'
          + '</div>'
        )
    +   (sectorDonutHtml ? _themePanel('<span>Sector Composition <span class="help-icon" title="What each theme basket is actually made of at the sector level. Two themes with similar returns can carry very different sector risk — a theme that is 80% Technology adds concentration, not diversification, to a tech-heavy portfolio." data-heading="Sector Composition" style="font-size:11px;">ⓘ</span></span>', sectorDonutHtml) : '')
    + '</div>'
    + walkHtml;

  // Populate theme holdings panel for first selected theme
  var themeHoldingsPanelEl = document.getElementById('themeHoldingsPanel');
  var themeHoldingsBodyEl = document.getElementById('themeHoldingsBody');
  if (themeHoldingsPanelEl && themeHoldingsBodyEl && themesToRun.length) {
    var th = themesToRun[0];
    var tickers2 = th.tickers || [];
    if (tickers2.length) {
      themeHoldingsPanelEl.style.display = '';
      themeHoldingsBodyEl.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:8px;padding:4px 0;">'
        + tickers2.map(function(t) {
          var sym = typeof t === 'string' ? t : (t.ticker || t.symbol || String(t));
          var wt = typeof t === 'object' && t.weight ? ' ('+(t.weight*100).toFixed(0)+'%)' : '';
          return '<span style="background:var(--panel);border:1px solid var(--border);border-radius:20px;padding:4px 12px;font-size:12px;font-weight:600;color:var(--navy);">'+sym+wt+'</span>';
        }).join('')
        + '</div>';
    }
  }

  statsEl.innerHTML = '';

  // Drawdown chart
  if (seriesStats.length) {
    if (window._themeDrawdownChart) window._themeDrawdownChart.destroy();
    window._themeDrawdownChart = new Chart(document.getElementById('themeDrawdownChart').getContext('2d'), {
      type: 'line',
      data: { labels: chartDates, datasets: seriesStats.map(function(s){ return { label: s.label, data: s.ddSeries, borderColor: s.color, backgroundColor:'transparent', borderWidth:1.5, pointRadius:0, tension:0.1, fill:false }; }) },
      options: { responsive:true, maintainAspectRatio:false, animation:false,
        plugins: { legend:{position:'top',labels:{color:'#1A2733',font:{size:10},boxWidth:10,padding:10}},
          tooltip:{mode:'index',intersect:false,callbacks:{title:function(it){return it[0]?chartDates[it[0].dataIndex]:'';},label:function(ctx){var v=ctx.parsed.y;return ctx.dataset.label+': '+(v!=null?v.toFixed(2)+'%':'—');}}}
        },
        scales:{
          x:{ticks:{color:'#5A6772',maxTicksLimit:8,maxRotation:0},grid:{color:'rgba(208,215,224,0.4)'}},
          y:{ticks:{color:'#5A6772',callback:function(v){return v+'%';}},grid:{color:'rgba(208,215,224,0.4)'},title:{display:true,text:'Drawdown %',color:'#5A6772',font:{size:11}}}
        }
      }
    });
  }

  // Rolling 90-day Sharpe chart
  var sharpeEl = document.getElementById('themeRollingSharpeChart');
  if (sharpeEl && seriesStats.length && chartDates.length > 90) {
    var WINDOW = 90;
    var RF_DAILY = 0.05 / 252; // 5% annual risk-free rate
    function rollingSharpeSeries(data) {
      var out = new Array(data.length).fill(null);
      for (var i = WINDOW; i < data.length; i++) {
        var rets = [];
        for (var j = i - WINDOW + 1; j <= i; j++) {
          if (data[j] != null && data[j-1] != null && data[j-1] > 0) {
            rets.push(Math.log(data[j] / data[j-1]));
          }
        }
        if (rets.length < WINDOW * 0.7) continue;
        var mu = rets.reduce(function(s,v){return s+v;},0) / rets.length;
        var vr = rets.reduce(function(s,v){return s+(v-mu)*(v-mu);},0) / Math.max(rets.length-1,1);
        var sd = Math.sqrt(vr);
        out[i] = sd > 0 ? parseFloat(((mu - RF_DAILY) / sd * Math.sqrt(252)).toFixed(3)) : null;
      }
      return out;
    }
    // Build rolling Sharpe from aligned data arrays used in seriesStats
    // seriesStats[i].ddSeries was built from ds.data — we need the original price-indexed series
    // Re-derive from datasets (which are already aligned to chartDates)
    var sharpeDatasets = datasets.map(function(ds, di) {
      var ss = seriesStats[di];
      if (!ss) return null;
      var sharpeData = rollingSharpeSeries(ds.data);
      return { label: ds.label, data: sharpeData, borderColor: ds.borderColor, backgroundColor:'transparent', borderWidth: ds === datasets[0] ? 2 : 1.5, pointRadius: 0, tension: 0.2, fill: false };
    }).filter(Boolean);
    // Add a reference line at Sharpe = 1.0
    sharpeDatasets.push({ label: 'Sharpe = 1.0', data: new Array(chartDates.length).fill(1.0), borderColor: 'rgba(139,105,20,0.4)', borderWidth: 1, borderDash: [4,4], pointRadius: 0, fill: false });
    if (window._themeRollingSharpeChart) window._themeRollingSharpeChart.destroy();
    window._themeRollingSharpeChart = new Chart(sharpeEl.getContext('2d'), {
      type: 'line',
      data: { labels: chartDates, datasets: sharpeDatasets },
      options: { responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { position:'top', labels:{color:'#1A2733',font:{size:10},boxWidth:10,padding:10} },
          tooltip: { mode:'index', intersect:false, callbacks: { title:function(it){return it[0]?chartDates[it[0].dataIndex]:'';}, label:function(ctx){var v=ctx.parsed.y; return ctx.dataset.label+': '+(v!=null?v.toFixed(2):'—');} } }
        },
        scales: {
          x: { ticks:{color:'#5A6772',maxTicksLimit:8,maxRotation:0}, grid:{color:'rgba(208,215,224,0.4)'} },
          y: { ticks:{color:'#5A6772',callback:function(v){return v.toFixed(1);}}, grid:{color:'rgba(208,215,224,0.4)'}, title:{display:true,text:'Sharpe (90D rolling)',color:'#5A6772',font:{size:11}} }
        }
      }
    });
  }

  // Cumulative return chart (rebased to 100)
  var cumulEl = document.getElementById('themeCumulChart');
  if (cumulEl && datasets.length) {
    if (window._themeCumulChart) window._themeCumulChart.destroy();
    window._themeCumulChart = new Chart(cumulEl.getContext('2d'), {
      type: 'line',
      data: { labels: chartDates, datasets: datasets.map(function(ds){ return { label: ds.label, data: ds.data, borderColor: ds.borderColor, backgroundColor: 'transparent', borderWidth: ds.label === 'Your Portfolio' ? 2.5 : 1.8, pointRadius: 0, tension: 0.15, fill: false }; }) },
      options: { responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { position:'top', labels:{color:'#1A2733',font:{size:10},boxWidth:10,padding:10} },
          tooltip: { mode:'index', intersect:false, callbacks: { title:function(it){return it[0]?chartDates[it[0].dataIndex]:'';}, label:function(ctx){var v=ctx.parsed.y; return ctx.dataset.label+': '+(v!=null?v.toFixed(2):'—');} } }
        },
        scales: {
          x: { ticks:{color:'#5A6772',maxTicksLimit:10,maxRotation:0}, grid:{color:'rgba(208,215,224,0.4)'} },
          y: { ticks:{color:'#5A6772',callback:function(v){return v!=null?v.toFixed(0):''}}, grid:{color:'rgba(208,215,224,0.4)'}, title:{display:true,text:'Return indexed to 100',color:'#5A6772',font:{size:11}} }
        }
      }
    });
  }

  // Sector donut charts
  if (themesToRun.length) {
    var donutPalette = ['#003C71','#5B9BD5','#A23B72','#F18F01','#48A9A6','#7B68EE','#C84B31','#0F4C81','#5E8C61','#E8B74A','#D4526E','#8B6914'];
    themesToRun.forEach(function(theme, ti) {
      var ctx2 = document.getElementById('themeSectorDonut'+ti);
      if (!ctx2) return;
      var tw = theme.weights || {};
      var tew = 1 / (theme.tickers.length || 1);
      var sm = {};
      theme.tickers.forEach(function(t) {
        var w = tw[t] || tew;
        var ee = ETF_DB[t];
        var sec = ee ? ee.s : (typeof STOCK_DB !== 'undefined' && STOCK_DB[t] ? STOCK_DB[t].s : 'Other');
        sm[sec] = (sm[sec] || 0) + w;
      });
      var st = Object.values(sm).reduce(function(s,v){return s+v;},0) || 1;
      var sl = Object.keys(sm).sort(function(a,b){return sm[b]-sm[a];});
      // Limit to top 8 labels; collapse rest into "Other"
      if (sl.length > 8) {
        var othW = sl.slice(8).reduce(function(s,k){ return s+sm[k]; }, 0);
        sl = sl.slice(0,8);
        if (othW > 0) { sl.push('Other'); sm['Other'] = (sm['Other']||0) + othW; }
      }
      var sv = sl.map(function(s){ return parseFloat((sm[s]/st*100).toFixed(1)); });
      var ec = Chart.getChart ? Chart.getChart(ctx2) : null;
      if (ec) ec.destroy();
      new Chart(ctx2, { type:'doughnut',
        data:{labels:sl,datasets:[{data:sv,backgroundColor:donutPalette.slice(0,sl.length),borderWidth:1}]},
        options:{responsive:true,maintainAspectRatio:false,animation:false,
          // Legend bubbles removed (2026-07) — they crowded every donut and
          // repeated across themes. Hover any slice for sector + weight.
          plugins:{legend:{display:false},
            tooltip:{callbacks:{label:function(ctx){return ctx.label+': '+ctx.parsed.toFixed(1)+'%';}}}}}
      });
    });
  }
}

// ────────── Theme chart type toggle ──────────
function themeSetChartType(type, btn) {
  var row = document.getElementById('themeChartTypeRow');
  if (row) row.querySelectorAll('.btn-outline').forEach(function(b){ b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  ['themeRollingSharpeChartWrap','themeDrawdownChartWrap','themeCumulChartWrap'].forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  var showId = type==='sharpe'?'themeRollingSharpeChartWrap':type==='drawdown'?'themeDrawdownChartWrap':'themeCumulChartWrap';
  var showEl = document.getElementById(showId);
  if (showEl) showEl.style.display = '';
}

// ────────── Custom themed portfolios — Firestore CRUD (Fix #2) ──────────
window._customThemeBuilder = { tickers: {} }; // ticker -> weight (0-1)
window._customThemes = []; // [{ id, name, description, regimeFit, tickers:[], weights:{} }]
function customThemeRefreshUI() {
  var el = document.getElementById('ctTickersList');
  if (!el) return;
  var keys = Object.keys(window._customThemeBuilder.tickers);
  if (!keys.length) { el.innerHTML = '<p style="color:var(--text-sec);font-size:12px;font-style:italic;">No tickers yet. Add a ticker above.</p>'; return; }
  var totalW = keys.reduce(function(s,k){ return s + window._customThemeBuilder.tickers[k]; }, 0);
  var html = '<table style="width:100%;border-collapse:collapse;font-size:12px;font-family:Arial;"><thead><tr style="background:var(--navy);color:#fff;">'+
    '<th style="padding:7px;text-align:left;">Ticker</th>'+
    '<th style="padding:7px;text-align:right;">Weight</th>'+
    '<th style="padding:7px;text-align:right;">% of Theme</th>'+
    '<th></th></tr></thead><tbody>';
  keys.forEach(function(t){
    var w = window._customThemeBuilder.tickers[t];
    var pct = totalW > 0 ? w/totalW*100 : 0;
    html += '<tr style="border-bottom:1px solid var(--border-light,#E5E9EF);">'+
      '<td style="padding:6px 8px;font-weight:700;color:var(--navy);">'+t+'</td>'+
      '<td style="padding:6px 8px;text-align:right;"><input type="number" value="'+w.toFixed(2)+'" min="0" step="0.01" style="width:70px;text-align:right;" onchange="customThemeSetWeight(\''+t+'\', this.value)"></td>'+
      '<td style="padding:6px 8px;text-align:right;font-family:Courier New,monospace;">'+pct.toFixed(1)+'%</td>'+
      '<td style="padding:6px 8px;text-align:right;"><button class="btn-outline btn-sm" onclick="customThemeRemove(\''+t+'\')">×</button></td></tr>';
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}
function customThemeAddTicker() {
  var t = (document.getElementById('ctAddTicker').value || '').toUpperCase().trim();
  var w = parseFloat(document.getElementById('ctAddWeight').value);
  if (!t) return;
  if (isNaN(w) || w <= 0) {
    // Default equal weight
    var n = Object.keys(window._customThemeBuilder.tickers).length + 1;
    w = 1/n;
    // Re-distribute existing
    Object.keys(window._customThemeBuilder.tickers).forEach(function(k){ window._customThemeBuilder.tickers[k] = 1/n; });
  } else {
    w = w / 100; // user enters as %
  }
  window._customThemeBuilder.tickers[t] = w;
  document.getElementById('ctAddTicker').value = '';
  document.getElementById('ctAddWeight').value = '';
  customThemeRefreshUI();
}
function customThemeSetWeight(t, v) {
  var w = parseFloat(v) / 100;
  if (isNaN(w) || w < 0) return;
  window._customThemeBuilder.tickers[t] = w;
  customThemeRefreshUI();
}
function customThemeRemove(t) {
  delete window._customThemeBuilder.tickers[t];
  customThemeRefreshUI();
}
function customThemeNormalize() {
  var keys = Object.keys(window._customThemeBuilder.tickers);
  if (!keys.length) return;
  var ew = 1 / keys.length;
  keys.forEach(function(k){ window._customThemeBuilder.tickers[k] = ew; });
  customThemeRefreshUI();
}
function customThemeReset() {
  window._customThemeBuilder = { tickers: {} };
  document.getElementById('ctName').value = '';
  document.getElementById('ctDesc').value = '';
  document.getElementById('ctStatus').textContent = '';
  customThemeRefreshUI();
}
async function customThemeSave() {
  var user = window._currentUser;
  var statusEl = document.getElementById('ctStatus');
  if (!user) { statusEl.textContent = 'Sign in to save custom themes.'; statusEl.style.color = 'var(--danger)'; return; }
  var name = (document.getElementById('ctName').value || '').trim();
  var desc = (document.getElementById('ctDesc').value || '').trim();
  var regime = document.getElementById('ctRegime').value;
  var tickers = Object.keys(window._customThemeBuilder.tickers);
  if (!name) { statusEl.textContent = 'Name required.'; statusEl.style.color = 'var(--danger)'; return; }
  if (!tickers.length) { statusEl.textContent = 'Add at least one ticker.'; statusEl.style.color = 'var(--danger)'; return; }
  // Normalize weights to sum to 1
  var sum = tickers.reduce(function(s,k){ return s + window._customThemeBuilder.tickers[k]; }, 0);
  var weights = {}; tickers.forEach(function(t){ weights[t] = sum > 0 ? window._customThemeBuilder.tickers[t]/sum : 1/tickers.length; });
  var theme = {
    name: name, description: desc, regimeFit: regime,
    tickers: tickers, weights: weights,
    createdAt: new Date().toISOString(), uid: user.uid
  };
  try {
    statusEl.textContent = 'Saving…'; statusEl.style.color = 'var(--text-sec)';
    var fb = window.__fb; var db = window.__fbDb;
    var docRef = await fb.addDoc(fb.collection(db, 'customThemes'), theme);
    theme.id = docRef.id;
    window._customThemes.push(theme);
    statusEl.textContent = 'Saved ✓ Theme available in compare.'; statusEl.style.color = 'var(--success)';
    customThemeReset();
    customThemeRenderSavedList();
    themeCmpRenderCustom();
  } catch(e) {
    statusEl.textContent = 'Save failed: ' + e.message; statusEl.style.color = 'var(--danger)';
  }
}
async function customThemeLoad() {
  var user = window._currentUser; if (!user) return;
  try {
    var fb = window.__fb; var db = window.__fbDb;
    var q = fb.query(fb.collection(db, 'customThemes'), fb.where('uid','==', user.uid));
    var snap = await fb.getDocs(q);
    var list = [];
    snap.forEach(function(d){ list.push(Object.assign({id:d.id}, d.data())); });
    window._customThemes = list;
    customThemeRenderSavedList();
    themeCmpRenderCustom();
  } catch(e) { console.warn('[customThemeLoad]', e); }
}
async function customThemeDelete(id) {
  if (!confirm('Delete this custom theme?')) return;
  try {
    var fb = window.__fb; var db = window.__fbDb;
    await fb.deleteDoc(fb.doc(db, 'customThemes', id));
    window._customThemes = window._customThemes.filter(function(t){ return t.id !== id; });
    customThemeRenderSavedList();
    themeCmpRenderCustom();
  } catch(e) { alert('Delete failed: '+e.message); }
}
function customThemeRenderSavedList() {
  var el = document.getElementById('ctSavedList');
  if (!el) return;
  var list = window._customThemes || [];
  if (!list.length) { el.innerHTML = '<p style="color:var(--text-sec);font-size:11.5px;font-style:italic;margin-top:10px;">No saved custom themes.</p>'; return; }
  var html = '<div style="font-size:11px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:.4px;margin:14px 0 8px;">Your Saved Themes</div>';
  list.forEach(function(t){
    html += '<div style="background:var(--panel);border:1px solid var(--border);border-left:3px solid var(--blue);padding:8px 12px;margin-bottom:6px;border-radius:3px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">'+
      '<div style="flex:1;min-width:200px;"><strong style="color:var(--navy);">★ '+t.name+'</strong> <span style="font-size:11px;color:var(--text-sec);">('+t.tickers.length+' tickers · regime: '+t.regimeFit+')</span><div style="font-size:10.5px;color:var(--text-sec);margin-top:2px;">'+(t.description||'')+'</div></div>'+
      '<div><button class="btn-outline btn-sm" onclick="customThemeDelete(\''+t.id+'\')">Delete</button></div>'+
      '</div>';
  });
  el.innerHTML = html;
}

// ────────── What-If Simulator (Fix #2) ──────────
async function whatIfRun() {
  var ticker = (document.getElementById('whatifTicker').value || '').toUpperCase().trim();
  var w = parseFloat(document.getElementById('whatifWeight').value);
  var range = document.getElementById('whatifRange').value;
  var method = document.getElementById('whatifMethod').value;
  var statsEl = document.getElementById('whatifStats');
  if (!ticker) { statsEl.innerHTML = '<span style="color:var(--danger);">Enter a ticker symbol.</span>'; return; }
  if (isNaN(w) || w <= 0 || w > 100) { statsEl.innerHTML = '<span style="color:var(--danger);">Weight must be between 0 and 100.</span>'; return; }
  statsEl.innerHTML = '<div style="padding:8px;"><span class="spinner"></span> Running simulation…</div>';
  try {
    var fetchRange = (range === 'ytd') ? '1y' : range;
    var results = await Promise.all([
      pfBuildValueSeries(fetchRange),
      fetchChart(ticker, fetchRange, '1d')
    ]);
    var pfSeries = results[0]; var tickerChart = results[1];
    if (!pfSeries.dates || !pfSeries.values.length) {
      statsEl.innerHTML = '<span style="color:var(--danger);">No portfolio data — add holdings first.</span>'; return;
    }
    var tMap = {};
    (tickerChart.points||[]).filter(function(p){return p.close!=null;}).forEach(function(p){ tMap[p.date.slice(0,10)] = p.close; });
    var pfMap = {};
    pfSeries.dates.forEach(function(d,i){ if(pfSeries.values[i]!=null) pfMap[d] = pfSeries.values[i]; });
    var allDatesSet = new Set(Object.keys(pfMap).concat(Object.keys(tMap)));
    var commonDates = Array.from(allDatesSet).sort().filter(function(d){ return pfMap[d]!=null && tMap[d]!=null; });
    if (range === 'ytd') {
      var ytdStart = new Date().getFullYear() + '-01-01';
      commonDates = commonDates.filter(function(d){ return d >= ytdStart; });
    }
    if (commonDates.length < 5) {
      statsEl.innerHTML = '<span style="color:var(--danger);">Insufficient overlapping data between portfolio and ' + ticker + '. Try a longer window.</span>'; return;
    }
    var pfA = commonDates.map(function(d){ return pfMap[d]; });
    var tA  = commonDates.map(function(d){ return tMap[d]; });
    var pfBase = pfA[0];
    var actualReb = pfA.map(function(v){ return v / pfBase * 100; });
    var tickerReb = tA.map(function(v){ return v / tA[0] * 100; });
    var pfLogR = []; var tLogR = [];
    for (var i = 1; i < pfA.length; i++) {
      pfLogR.push(pfA[i-1]>0&&pfA[i]>0 ? Math.log(pfA[i]/pfA[i-1]) : 0);
      tLogR.push(tA[i-1]>0&&tA[i]>0   ? Math.log(tA[i]/tA[i-1])  : 0);
    }
    var weightT = w / 100;
    var hypReb = [100]; var hypLogR = [];
    for (var i = 0; i < pfLogR.length; i++) {
      var dayRet = method==='dilute' ? (1-weightT)*pfLogR[i]+weightT*tLogR[i] : pfLogR[i]+weightT*tLogR[i];
      hypLogR.push(dayRet);
      hypReb.push(hypReb[hypReb.length-1] * Math.exp(dayRet));
    }
    // Thin for chart
    var step = Math.max(1, Math.floor(commonDates.length / 400));
    var chartDates = []; var chartActual = []; var chartHyp = []; var chartTicker = [];
    for (var i = 0; i < commonDates.length; i += step) {
      chartDates.push(commonDates[i]);
      chartActual.push(parseFloat(actualReb[i].toFixed(3)));
      chartHyp.push(parseFloat(hypReb[i].toFixed(3)));
      chartTicker.push(parseFloat(tickerReb[i].toFixed(3)));
    }
    var ctxEl = document.getElementById('whatifChart');
    if (window._whatifChart) { window._whatifChart.destroy(); window._whatifChart = null; }
    var lblStep = Math.max(1, Math.floor(chartDates.length / 10));
    window._whatifChart = new Chart(ctxEl, {
      type: 'line',
      data: {
        labels: chartDates,
        datasets: [
          { label: 'Your Portfolio (actual)', data: chartActual, borderColor:'#003C71', backgroundColor:'rgba(0,60,113,0.08)', fill:true, borderWidth:2.5, pointRadius:0, tension:0.15 },
          { label: 'Hypothetical (+'+ ticker +' @ '+ w +'%, '+ (method==='dilute'?'pro-rata':'add-on') +')', data: chartHyp, borderColor:'#A23B72', backgroundColor:'rgba(162,59,114,0.08)', fill:false, borderWidth:2.2, pointRadius:0, tension:0.15, borderDash:[6,3] },
          { label: ticker + ' standalone', data: chartTicker, borderColor:'#F18F01', backgroundColor:'transparent', fill:false, borderWidth:1.5, pointRadius:0, tension:0.15, borderDash:[3,2] }
        ]
      },
      options: {
        responsive:true, maintainAspectRatio:false, animation:false,
        plugins: {
          legend: { position:'top', labels:{color:'#1A2733',font:{size:11},boxWidth:12,padding:12} },
          tooltip: { mode:'index', intersect:false, callbacks: {
            title: function(items){ return items[0] ? chartDates[items[0].dataIndex] : ''; },
            label: function(ctx){ return ctx.dataset.label + ': ' + (ctx.parsed.y!=null ? ctx.parsed.y.toFixed(2) : '—'); }
          }}
        },
        scales: {
          x: { ticks:{color:'#5A6772',maxTicksLimit:10,maxRotation:0,callback:function(v,i){return i%lblStep===0?chartDates[i]:'';}}, grid:{color:'rgba(208,215,224,0.35)'} },
          y: { ticks:{color:'#5A6772',callback:function(v){return v.toFixed(0);}}, grid:{color:'rgba(208,215,224,0.35)'},
               title:{display:true,text:'Return indexed to 100',color:'#5A6772',font:{size:11}} }
        }
      }
    });
    function annVol(rets) {
      if (rets.length < 2) return null;
      var m = rets.reduce(function(s,v){return s+v;},0)/rets.length;
      var v = rets.reduce(function(s,r){return s+(r-m)*(r-m);},0)/(rets.length-1);
      return Math.sqrt(v)*Math.sqrt(252)*100;
    }
    var actRet = actualReb[actualReb.length-1] - 100;
    var hypRet = hypReb[hypReb.length-1] - 100;
    var tkrRet = tickerReb[tickerReb.length-1] - 100;
    var diff   = hypRet - actRet;
    var volAct = annVol(pfLogR); var volHyp = annVol(hypLogR);
    function statBox(label, ret, sub, color) {
      return '<div style="background:var(--panel);padding:7px 12px;border-radius:4px;border-left:3px solid '+color+';min-width:120px;">'+
        '<div style="font-size:10.5px;color:var(--text-sec);">'+label+'</div>'+
        '<div style="font-size:16px;font-weight:700;color:'+(ret>=0?'var(--success)':'var(--danger)')+';">'+(ret>=0?'+':'')+ret.toFixed(2)+'%</div>'+
        '<div style="font-size:10.5px;color:var(--text-sec);">'+sub+'</div></div>';
    }
    statsEl.innerHTML = '<div style="display:flex;gap:10px;flex-wrap:wrap;font-size:12px;">'+
      statBox('Your Portfolio', actRet, 'Vol: '+(volAct!=null?volAct.toFixed(1)+'%':'—'), '#003C71')+
      statBox('Hypothetical', hypRet, 'Vol: '+(volHyp!=null?volHyp.toFixed(1)+'%':'—'), '#A23B72')+
      statBox(ticker+' standalone', tkrRet, '', '#F18F01')+
      '<div style="background:'+(diff>=0?'rgba(46,125,82,0.12)':'rgba(139,42,42,0.12)')+';padding:7px 12px;border-radius:4px;border-left:3px solid '+(diff>=0?'var(--success)':'var(--danger)')+';min-width:120px;">'+
      '<div style="font-size:10.5px;color:var(--text-sec);">Impact</div>'+
      '<div style="font-size:16px;font-weight:700;color:'+(diff>=0?'var(--success)':'var(--danger)')+';">'+(diff>=0?'+':'')+diff.toFixed(2)+' pp</div>'+
      '<div style="font-size:10.5px;color:var(--text-sec);">vs actual</div></div>'+
      '</div>';
  } catch(e) {
    statsEl.innerHTML = '<span style="color:var(--danger);">Error: '+e.message+'</span>';
    console.error('[whatIfRun]', e);
  }
}

// ────────── Patch pfShowTab

// ────────── Patch pfShowTab to also init themes/whatif tabs ──────────
(function(){
  var origShow = window.pfShowTab;
  if (typeof origShow !== 'function') return;
  window.pfShowTab = function(name) {
    origShow(name);
    if (name === 'themes') {
      if (!window._themesCmpInit) {
        window._themesCmpInit = true;
        themePopulatePicker();
        customThemeLoad();
        customThemeRefreshUI();
        watchlistPopulateSelect();
      }
      if (window._currentUser) {
        var gate = document.getElementById('customThemeAuthGate');
        if (gate) gate.style.display = 'none';
      } else {
        var gate = document.getElementById('customThemeAuthGate');
        if (gate) gate.style.display = '';
      }
      // Always run comparison when tab is activated
      setTimeout(themeCompareRun, 80);
    }
  };
})();

// ────────── Regime-Conditional Correlation (Fix #6) ──────────
window._rccData = null;
async function rccRun() {
  var statusEl = document.getElementById('rccStatus');
  var resultsEl = document.getElementById('rccResults');
  statusEl.textContent = 'Loading SPY history + Perry regime classification…';
  resultsEl.innerHTML = '<span class="spinner"></span> Computing regime-conditional correlations…';
  try {
    // Use the universe selected in Markets module if available; else default
    var tickers = (window._mktSelectedAssets && window._mktSelectedAssets.length >= 3) ? window._mktSelectedAssets.slice(0, 12) : ['SPY','QQQ','TLT','GLD','HYG','UUP','USO','VNQ'];
    // Make sure SPY is included as benchmark
    if (tickers.indexOf('SPY') === -1) tickers.unshift('SPY');
    // Load 5y daily data for each + classify Perry regime daily
    var WORKER = 'https://perry-finance-proxy.zachperrybusiness.workers.dev';
    var spyData = await fetch(WORKER + '/chart?symbol=SPY&range=5y&interval=1d').then(function(r){ return r.json(); });
    var vixData = await fetch(WORKER + '/chart?symbol=%5EVIX&range=5y&interval=1d').then(function(r){ return r.json(); }).catch(function(){ return null; });
    var spyPts = (spyData.points || []).filter(function(p){ return p.close != null; });
    var vixSeries = {};
    if (vixData && vixData.points) {
      vixData.points.forEach(function(p){ if (p.close != null) vixSeries[p.date.slice(0,10)] = p.close; });
    }
    statusEl.textContent = 'Classifying daily regimes (5y window)…';
    // Build daily classification (rolling 252-day)
    var dailyClass = buildDailyClassificationHistory(spyPts, vixSeries);
    var classByDate = {};
    dailyClass.forEach(function(d){ classByDate[d.date] = d.classification.winner; });
    statusEl.textContent = 'Fetching '+tickers.length+' assets…';
    // Fetch each asset
    var data = {};
    await Promise.all(tickers.map(async function(tk){
      try {
        var c = await fetch(WORKER + '/chart?symbol='+encodeURIComponent(tk)+'&range=5y&interval=1d').then(function(r){ return r.json(); });
        data[tk] = (c.points||[]).filter(function(p){ return p.close != null; });
      } catch(e) { data[tk] = []; }
    }));
    // Align all on common date set
    var validTickers = tickers.filter(function(tk){ return data[tk] && data[tk].length > 100; });
    if (validTickers.length < 3) { resultsEl.innerHTML = '<p style="color:var(--danger);">Insufficient data — need at least 3 assets.</p>'; return; }
    // Build price maps + log returns aligned to common date set
    var priceMaps = {};
    validTickers.forEach(function(tk){
      priceMaps[tk] = {};
      data[tk].forEach(function(p){ priceMaps[tk][p.date.slice(0,10)] = p.close; });
    });
    var spyMap = priceMaps['SPY'];
    var commonDates = Object.keys(spyMap).filter(function(d){
      return validTickers.every(function(tk){ return priceMaps[tk][d] != null; }) && classByDate[d] != null;
    }).sort();
    var returns = {};
    validTickers.forEach(function(tk){
      var r = [];
      for (var i = 1; i < commonDates.length; i++) {
        var prev = priceMaps[tk][commonDates[i-1]];
        var cur = priceMaps[tk][commonDates[i]];
        r.push(prev > 0 ? Math.log(cur/prev) : 0);
      }
      returns[tk] = r;
    });
    var dateAligned = commonDates.slice(1);
    statusEl.textContent = 'Computed '+dateAligned.length+' daily observations across '+validTickers.length+' assets.';
    window._rccData = { returns: returns, dates: dateAligned, classByDate: classByDate, tickers: validTickers };
    rccRender();
  } catch(e) { resultsEl.innerHTML = '<p style="color:var(--danger);">RCC failed: '+e.message+'</p>'; statusEl.textContent = ''; }
}
function rccCorrSubset(returns, tickers, indices) {
  // returns: {ticker: [r1, r2, ...]}, indices: array of position indices to include
  var m = {};
  tickers.forEach(function(t1){
    m[t1] = {};
    tickers.forEach(function(t2){
      if (t1 === t2) { m[t1][t2] = 1.0; return; }
      var x1 = indices.map(function(i){ return returns[t1][i]; });
      var x2 = indices.map(function(i){ return returns[t2][i]; });
      var n = x1.length;
      if (n < 5) { m[t1][t2] = NaN; return; }
      var m1 = x1.reduce(function(s,v){return s+v;},0)/n;
      var m2 = x2.reduce(function(s,v){return s+v;},0)/n;
      var cov=0, v1=0, v2=0;
      for (var i = 0; i < n; i++) {
        cov += (x1[i]-m1)*(x2[i]-m2);
        v1 += (x1[i]-m1)*(x1[i]-m1);
        v2 += (x2[i]-m2)*(x2[i]-m2);
      }
      m[t1][t2] = (v1>0&&v2>0) ? cov/Math.sqrt(v1*v2) : 0;
    });
  });
  return m;
}
function rccRender() {
  if (!window._rccData) return;
  var d = window._rccData;
  var mode = document.getElementById('rccMode').value;
  var regimeFilter = document.getElementById('rccRegime').value;
  var resultsEl = document.getElementById('rccResults');
  var tickers = d.tickers;
  var dates = d.dates;
  var classByDate = d.classByDate;
  var returns = d.returns;
  // Build index sets
  var allIdx = []; for (var i = 0; i < dates.length; i++) allIdx.push(i);
  var spyR = returns['SPY'];
  var downsideIdx = [];
  for (var i = 0; i < dates.length; i++) if (spyR[i] != null && spyR[i] <= 0) downsideIdx.push(i);
  var upsideIdx = [];
  for (var i = 0; i < dates.length; i++) if (spyR[i] != null && spyR[i] > 0) upsideIdx.push(i);
  var regimeIdx = { leveraged:[], growth:[], neutral:[], drawdown:[] };
  for (var i = 0; i < dates.length; i++) {
    var k = classByDate[dates[i]];
    if (k && regimeIdx[k]) regimeIdx[k].push(i);
  }

  function renderHeatmap(matrix, label, indicesCount) {
    var html = '<div style="font-size:12px;font-weight:700;color:var(--navy);margin:10px 0 6px;text-transform:uppercase;letter-spacing:0.5px;">'+label+' <span style="font-weight:400;color:var(--text-sec);font-size:10.5px;">(n='+indicesCount+' days)</span></div>';
    html += '<div style="overflow-x:auto;"><table class="corr-matrix"><thead><tr><th></th>';
    tickers.forEach(function(t){ html += '<th>'+t+'</th>'; });
    html += '</tr></thead><tbody>';
    for (var ii = 0; ii < tickers.length; ii++) {
      html += '<tr><td>'+tickers[ii]+'</td>';
      for (var jj = 0; jj < tickers.length; jj++) {
        var v = matrix[tickers[ii]][tickers[jj]];
        if (isNaN(v)) { html += '<td style="background:#eee;color:#999;">—</td>'; continue; }
        var c = Math.abs(v);
        var bg, fg;
        if (v >= 0) { bg = 'rgba(0,60,113,'+(c*0.85+0.05).toFixed(2)+')'; fg = c > 0.55 ? '#fff' : '#1A2733'; }
        else { bg = 'rgba(139,42,42,'+(c*0.85+0.05).toFixed(2)+')'; fg = c > 0.55 ? '#fff' : '#1A2733'; }
        html += '<td style="background:'+bg+';color:'+fg+';">'+v.toFixed(2)+'</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    return html;
  }

  var html = '';
  if (mode === 'regime') {
    var regimes = regimeFilter === 'all' ? ['leveraged','growth','neutral','drawdown'] : [regimeFilter];
    regimes.forEach(function(r){
      var idx = regimeIdx[r];
      if (idx.length < 10) {
        html += '<div style="font-size:12px;font-weight:700;color:var(--navy);margin:10px 0 6px;">'+r.toUpperCase()+' regime</div><p style="color:var(--text-sec);font-size:11.5px;">Insufficient data ('+idx.length+' days). Need 10+.</p>';
        return;
      }
      var stateName = (PS_STATES.find(function(s){return s.key===r;})||{name:r}).name;
      var matrix = rccCorrSubset(returns, tickers, idx);
      // average off-diagonal
      var avg = 0, count = 0;
      tickers.forEach(function(t1){ tickers.forEach(function(t2){ if (t1!==t2 && !isNaN(matrix[t1][t2])) { avg += matrix[t1][t2]; count++; } }); });
      avg = count > 0 ? avg / count : 0;
      html += renderHeatmap(matrix, stateName + ' &middot; Avg ρ = ' + avg.toFixed(3), idx.length);
    });
  } else if (mode === 'downside') {
    var fullM = rccCorrSubset(returns, tickers, allIdx);
    var downM = rccCorrSubset(returns, tickers, downsideIdx);
    var upM = rccCorrSubset(returns, tickers, upsideIdx);
    function avgOff(M) { var a=0,c=0; tickers.forEach(function(t1){ tickers.forEach(function(t2){ if (t1!==t2 && !isNaN(M[t1][t2])) { a+=M[t1][t2]; c++; } }); }); return c>0?a/c:0; }
    html += '<div style="background:var(--panel);border:1px solid var(--border);padding:12px 16px;border-radius:4px;margin-bottom:12px;font-size:12.5px;">'+
      '<strong style="color:var(--navy);">Asymmetry summary (avg off-diagonal ρ across universe)</strong><br>'+
      '<span style="display:inline-block;margin-right:14px;margin-top:6px;">Full sample: <strong style="font-family:Courier New,monospace;">'+avgOff(fullM).toFixed(3)+'</strong></span>'+
      '<span style="display:inline-block;margin-right:14px;">Upside days only: <strong style="font-family:Courier New,monospace;color:var(--success);">'+avgOff(upM).toFixed(3)+'</strong></span>'+
      '<span style="display:inline-block;margin-right:14px;">Downside days only: <strong style="font-family:Courier New,monospace;color:var(--danger);">'+avgOff(downM).toFixed(3)+'</strong></span>'+
      '<span style="display:inline-block;background:rgba(139,42,42,0.12);padding:2px 8px;border-radius:3px;font-weight:700;">Δρ (downside − full): '+(avgOff(downM)-avgOff(fullM)>=0?'+':'')+(avgOff(downM)-avgOff(fullM)).toFixed(3)+'</span>'+
      '<p style="font-size:11px;color:var(--text-sec);margin-top:8px;line-height:1.5;">A positive Δρ means correlations rise during drawdowns — your diversification benefit erodes precisely when you need it most. This is the empirically documented "correlation breakdown" or asymmetric correlation effect (Longin &amp; Solnik 2001; Ang &amp; Chen 2002).</p>'+
      '</div>';
    html += renderHeatmap(fullM, 'Full Sample', allIdx.length);
    html += renderHeatmap(downM, 'Downside Days Only (R<sub>SPY</sub> ≤ 0)', downsideIdx.length);
    html += renderHeatmap(upM, 'Upside Days Only (R<sub>SPY</sub> > 0)', upsideIdx.length);
  } else if (mode === 'rolling') {
    // Rolling 60D average pairwise correlation
    var W = 60;
    var labels = [], avgs = [], regimes = [];
    for (var s = W; s < dates.length; s++) {
      var slice = []; for (var k = s - W; k < s; k++) slice.push(k);
      var M = rccCorrSubset(returns, tickers, slice);
      var a=0,c=0; tickers.forEach(function(t1){ tickers.forEach(function(t2){ if (t1!==t2 && !isNaN(M[t1][t2])) { a+=M[t1][t2]; c++; } }); });
      labels.push(dates[s]);
      avgs.push(c>0?a/c:0);
      regimes.push(classByDate[dates[s]] || 'neutral');
    }
    html += '<div style="font-size:12px;font-weight:700;color:var(--navy);margin:10px 0 6px;text-transform:uppercase;letter-spacing:0.5px;">Rolling 60-Day Average Pairwise Correlation (universe of '+tickers.length+' assets)</div>';
    html += '<div class="chart-wrap" style="height:300px;"><canvas id="rccRollingChart"></canvas></div>';
    html += '<p style="font-size:11px;color:var(--text-sec);margin-top:8px;line-height:1.5;">Background bands tinted by Perry regime that day. Spikes coincide with stress regimes — corroborating Longin &amp; Solnik (2001).</p>';
    resultsEl.innerHTML = html;
    // Render chart with regime-tinted points
    var ctx = document.getElementById('rccRollingChart');
    if (window._rccRollingChart) window._rccRollingChart.destroy();
    var stateColors = { leveraged:'#2E7D52', growth:'#5B9BD5', neutral:'#8B6914', drawdown:'#8B2A2A' };
    var pointColors = regimes.map(function(r){ return stateColors[r] || '#999'; });
    window._rccRollingChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Avg Pairwise ρ (60D)',
          data: avgs,
          borderColor: '#003C71',
          backgroundColor: pointColors,
          pointBackgroundColor: pointColors,
          pointRadius: 1.5,
          pointBorderColor: pointColors,
          borderWidth: 1.5,
          fill: false,
          tension: 0.05
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(ctx){ var i = ctx.dataIndex; return 'ρ='+avgs[i].toFixed(3)+' &middot; Regime: '+regimes[i]; }}}},
        scales: {
          x: { ticks: { color:'#5A6772', maxTicksLimit:10 }, grid: { color:'rgba(208,215,224,0.4)' } },
          y: { min: 0, max: 1, ticks: { color:'#5A6772' }, grid: { color:'rgba(208,215,224,0.4)' } }
        }
      }
    });
    return;
  }
  resultsEl.innerHTML = html;
}

// ────────── Patch renderPortfolioChart for Recommended-State + historical-regime overlays + extra tickers ──────────
(function(){
  var orig = window.renderPortfolioChart;
  if (typeof orig !== 'function') return;
  window.renderPortfolioChart = async function() {
    await orig.apply(this, arguments);
    // Now add overlays if their toggles are on, by appending to the chart's datasets
    var chart = window._chartRef || window.__pfChart || null;
    // Search for the chart instance by canvas id
    if (!chart && typeof Chart !== 'undefined') {
      var cv = document.getElementById('portfolioLineChart');
      if (cv) chart = Chart.getChart(cv);
    }
    if (!chart) return;
    try {
      // Recommended State overlay
      if (window._showRecState) {
        var range = (typeof currentRange !== 'undefined' ? currentRange : '1y');
        var recSeries = await buildRecommendedStateSeries(range);
        if (recSeries && recSeries.values.length && chart.data.labels && chart.data.labels.length) {
          var chartLabels = chart.data.labels;
          // Find the first non-null portfolio value to rebase
          var pfDataset = chart.data.datasets.find(function(d){ return d.label && (d.label.indexOf('Total Value') >= 0 || d.label.indexOf('Time-Weighted') >= 0); });
          var startVal = null;
          if (pfDataset && pfDataset.data) { for (var ri=0; ri<pfDataset.data.length; ri++) { if (pfDataset.data[ri]!=null && pfDataset.data[ri]>0) { startVal=pfDataset.data[ri]; break; } } }
          if (!startVal) startVal = recSeries.values[0] || 100;
          var startBase = recSeries.values[0] || 1;
          // Build date->value map for rec series
          var recMap = {};
          recSeries.dates.forEach(function(d,i){ recMap[d] = recSeries.values[i]; });
          // Align to chart labels (forward-fill)
          var aligned = []; var lastRec = null;
          chartLabels.forEach(function(d){ if(recMap[d]!=null) lastRec=recMap[d]; aligned.push(lastRec!=null ? lastRec/startBase*startVal : null); });
          chart.data.datasets = chart.data.datasets.filter(function(d){ return d.label !== 'Recommended State (Backtest)'; });
          chart.data.datasets.push({
            label: 'Recommended State (Backtest)',
            data: aligned, borderColor: '#A23B72', backgroundColor: 'rgba(162,59,114,0.05)',
            borderWidth: 2, borderDash: [4,3], pointRadius: 0, tension: 0.1,
            fill: false, yAxisID: pfDataset && pfDataset.yAxisID ? pfDataset.yAxisID : 'y',
            spanGaps: true
          });
          chart.update('none');
        }
      } else {
        chart.data.datasets = chart.data.datasets.filter(function(d){ return d.label !== 'Recommended State (Backtest)'; });
        chart.update('none');
      }
      // Forecast historical overlay
      var mcSel = document.getElementById('mcRegimeSelect').value;
      var histChk = document.getElementById('mcHistOverlay');
      if (mcSel && histChk && histChk.checked && window._quarterlyRegimes) {
        // Show how this regime would have performed on the SAME days the user actually held
        // Use the active dataset: TWR series if TWR mode is on, Portfolio Value otherwise
        var pfDataset2 = chart.data.datasets.find(function(d) {
          if (!d.label) return false;
          return window._twrModeOnly
            ? d.label.indexOf('Time-Weighted Return') >= 0
            : d.label.indexOf('Total Value') >= 0;
        });
        if (!pfDataset2) pfDataset2 = chart.data.datasets.find(function(d){ return d.label && d.label.indexOf('Total Value') >= 0; });
        if (pfDataset2 && pfDataset2.data && pfDataset2.data.length > 1) {
          // data entries are plain numbers (chart uses labels+data array format), not {x,y} objects
          var firstEntry = pfDataset2.data[0];
          var rangeKey = (typeof currentRange !== 'undefined' ? currentRange : '1y');
          var recAll = await buildRecommendedStateSeries(rangeKey);
          if (recAll) {
            // We just rebuild a series fixing the regime
            var fixed = await buildFixedRegimeSeries(mcSel, rangeKey);
            if (fixed) {
              var sBase = fixed.values[0];
              var sStart = (typeof firstEntry === 'object' && firstEntry !== null ? (firstEntry.y || 100) : (firstEntry || 100));
              var sRescaled = fixed.values.map(function(v){ return v / sBase * sStart; });
              chart.data.datasets = chart.data.datasets.filter(function(d){ return d.label !== 'Forecast Regime — Historical'; });
              chart.data.datasets.push({
                label: 'Forecast Regime — Historical',
                data: fixed.dates.map(function(d, i){ return { x: d, y: sRescaled[i] }; }),
                borderColor: '#F18F01',
                borderWidth: 1.8,
                borderDash: [2,3],
                pointRadius: 0,
                tension: 0.1,
                fill: false,
                yAxisID: pfDataset2.yAxisID
              });
              chart.update('none');
            }
          }
        }
      } else if (chart.data.datasets.find(function(d){ return d.label === 'Forecast Regime — Historical'; })) {
        chart.data.datasets = chart.data.datasets.filter(function(d){ return d.label !== 'Forecast Regime — Historical'; });
        chart.update('none');
      }
      // Extra tickers
      if (window._pfChartExtraTickers && window._pfChartExtraTickers.length) {
        for (var i = 0; i < window._pfChartExtraTickers.length; i++) {
          var x = window._pfChartExtraTickers[i];
          var lbl = x.ticker + ' (overlay)';
          if (chart.data.datasets.find(function(d){ return d.label === lbl; })) continue;
          try {
            var c = await fetchChart(x.ticker, currentRange, '1d');
            var pts = (c.points || []).filter(function(p){ return p.close != null; });
            if (!pts.length) continue;
            var pfDataset3 = chart.data.datasets.find(function(d){ return d.label && d.label.indexOf('Total Value') >= 0; });
            var pfStart = pfDataset3 && pfDataset3.data && pfDataset3.data.length ? pfDataset3.data[0].y || 100 : 100;
            var firstClose = pts[0].close;
            var rescaled = pts.map(function(p){ return { x: p.date.slice(0,10), y: p.close / firstClose * pfStart }; });
            chart.data.datasets.push({
              label: lbl,
              data: rescaled,
              borderColor: x.color,
              borderWidth: 1.4,
              pointRadius: 0,
              tension: 0.1,
              fill: false,
              borderDash: [3,2],
              yAxisID: pfDataset3 && pfDataset3.yAxisID ? pfDataset3.yAxisID : undefined
            });
          } catch(e) {}
        }
        chart.update('none');
      }
    } catch(e) { console.warn('[renderPortfolioChart overlays]', e); }
  };
})();

async function buildFixedRegimeSeries(regime, rangeKey) {
  var STATE_WEIGHTS = {
    leveraged: { TQQQ: 0.4, SOXL: 0.2, SPY: 0.3, CASH: 0.1 },
    growth:    { QQQ: 0.4, SPY: 0.4, IWM: 0.1, CASH: 0.1 },
    neutral:   { GLD: 0.2, XLU: 0.15, XLP: 0.15, EFA: 0.1, IEF: 0.1, CASH: 0.3 },
    drawdown:  { SHV: 0.45, TLT: 0.2, GLD: 0.05, CASH: 0.3 }
  };
  var w = STATE_WEIGHTS[regime] || STATE_WEIGHTS.neutral;
  var tickerArr = Object.keys(w).filter(function(t){ return t !== 'CASH'; });
  var fetchRange = (rangeKey === 'ytd' || rangeKey === '1mo' || rangeKey === '3mo' || rangeKey === '6mo' || rangeKey === '1y') ? '1y'
                  : (rangeKey === '3y') ? '3y' : (rangeKey === '5y') ? '5y' : '10y';
  var data = {};
  await Promise.all(tickerArr.map(async function(t){
    try { var c = await fetchChart(t, fetchRange, '1d'); var m = {}; (c.points||[]).forEach(function(p){ if (p.close!=null) m[p.date.slice(0,10)] = p.close; }); data[t] = m; } catch(e){ data[t] = {}; }
  }));
  var anchor = data.SPY || data.QQQ || data[tickerArr[0]]; if (!anchor) return null;
  var dates = Object.keys(anchor).sort();
  var today = new Date();
  var startStr;
  if (rangeKey === '1mo') { var s = new Date(today); s.setMonth(today.getMonth()-1); startStr = s.toISOString().slice(0,10); }
  else if (rangeKey === '3mo') { var s = new Date(today); s.setMonth(today.getMonth()-3); startStr = s.toISOString().slice(0,10); }
  else if (rangeKey === '6mo') { var s = new Date(today); s.setMonth(today.getMonth()-6); startStr = s.toISOString().slice(0,10); }
  else if (rangeKey === 'ytd') { startStr = new Date(today.getFullYear(),0,1).toISOString().slice(0,10); }
  else if (rangeKey === '1y') { var s = new Date(today); s.setFullYear(today.getFullYear()-1); startStr = s.toISOString().slice(0,10); }
  else { startStr = dates[0]; }
  dates = dates.filter(function(d){ return d >= startStr; });
  var values = [100];
  for (var i = 1; i < dates.length; i++) {
    var dayRet = 0;
    Object.keys(w).forEach(function(t){
      if (t === 'CASH') { dayRet += w[t] * (0.045/252); return; }
      var prev = data[t][dates[i-1]], cur = data[t][dates[i]];
      if (prev != null && cur != null && prev > 0) dayRet += w[t] * Math.log(cur/prev);
    });
    values.push(values[values.length-1] * Math.exp(dayRet));
  }
  return { dates: dates, values: values };
}

// Auto-load quarterly regimes early (kicks off when user signs in or page first loads)
(function(){
  document.addEventListener('DOMContentLoaded', function(){
    setTimeout(function(){ if (typeof loadQuarterlyRegimes === 'function') loadQuarterlyRegimes(); }, 800);
  });
  // Also load custom themes once user signs in
  document.addEventListener('DOMContentLoaded', function(){
    setTimeout(function(){
      if (window._currentUser && typeof customThemeLoad === 'function') customThemeLoad();
    }, 1500);
  });
})();

// ────────── Tab switcher ──────────
function pfShowTab(name) {
  _toggleTabs('#page-portfolio', 'data-pftab', name, 'pftab-');
  // Lazy-load tab content on first activation
  try {
    if (name === 'performance' && !window._pfPerfRun) { window._pfPerfRun = true; pfRenderPerformance(); }
    if (name === 'performance') {
      renderPerformanceTab();
      setTimeout(function(){
        var perfBtns = document.querySelectorAll('#perfTimeframeBtns .btn-outline');
        perfBtns.forEach(function(b){
          b.onclick = function(){
            perfBtns.forEach(function(x){ x.classList.remove('active'); });
            b.classList.add('active');
            renderPerformanceTab();
          };
        });
      }, 500);
    }
    if (name === 'attribution') { renderAttributionTab(); }
    if (name === 'risk') {
      // Correlation card renders INDEPENDENTLY of pfRenderRisk — previously it
      // was only invoked at the very end of pfRenderRisk, so any early return
      // (short history) or mid-function error meant it never appeared at all.
      setTimeout(function(){ if (typeof renderRiskHeatmap === 'function') renderRiskHeatmap(); }, 200);
      var holdingHash = (window._holdings||[]).length + '_' + ((window._holdings||[])[0]||{}).ticker;
      if (!window._pfRiskRun || window._pfRiskHoldingHash !== holdingHash) {
        window._pfRiskRun = true; window._pfRiskHoldingHash = holdingHash; pfRenderRisk();
      }
      // Also render heatmap when tab is opened
      if (typeof renderRiskHeatmap === 'function') {
        var heatWrap = document.getElementById('riskHeatmapWrap');
        if (heatWrap && !heatWrap.querySelector('table')) renderRiskHeatmap();
      }
    }
    if (name === 'characteristics' && !window._pfCharRun) { window._pfCharRun = true; pfRenderCharacteristics(); }
    if (name === 'themes') {
      themePopulatePicker(); themeCmpRenderCustom();
      // Auto-run comparison if themes are checked or auto-select first
      if (typeof themeCompareRun === 'function') {
        setTimeout(function() { themeCompareRun(); }, 100);
      }
    }
    if (name === 'scenarios') {
      // Activate first scenario button if none active
      var active = document.querySelector('#stressScenarioBtns .btn-outline.active');
      if (!active) { var first = document.querySelector('#stressScenarioBtns .btn-outline'); if (first) first.click(); }
    }
  } catch(e) { console.warn('Tab init error', e); }
}

// ────────── AI Commentary engine ──────────
async function aiCallProxy(messages, max_tokens) {
  const res = await fetch('https://perry-finance-proxy.zachperrybusiness.workers.dev/analyze', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: max_tokens || 1200, messages: messages })
  });
  if (!res.ok) throw new Error('AI proxy HTTP ' + res.status);
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || j.error);
  const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  return text || '(no response)';
}
function aiSummarizePortfolio() {
  // Build a compact, factual JSON snapshot for the model
  const h = window._holdings || [];
  if (!h.length) return null;
  const isCash = x => ['Cash','Money Market','CD','Bond Position'].includes(x.assetClass);
  const mvOf = x => isCash(x) ? (x.costBasis||0)*x.quantity : (x.currentPrice||0)*x.quantity;
  const tv = h.reduce((s,x)=>s+mvOf(x),0);
  const tc = h.reduce((s,x)=>s+x.costBasis*x.quantity,0);
  const sectors = {};
  h.forEach(x => { const k = x.sector || 'Other'; sectors[k] = (sectors[k]||0) + mvOf(x); });
  const sectorPct = Object.entries(sectors).map(([k,v])=>({sector:k, weight: tv>0 ? +(v/tv*100).toFixed(1) : 0}))
    .sort((a,b)=>b.weight-a.weight);
  const top = h.slice().sort((a,b)=>mvOf(b)-mvOf(a)).slice(0,8).map(x => ({
    ticker: x.ticker,
    weight: tv>0 ? +(mvOf(x)/tv*100).toFixed(1) : 0,
    sector: x.sector,
    glPct: x.costBasis>0 ? +(((x.currentPrice||x.costBasis)/x.costBasis - 1)*100).toFixed(1) : null
  }));
  return {
    totalValue: Math.round(tv),
    totalCost: Math.round(tc),
    totalGainLossPct: tc>0 ? +(((tv/tc)-1)*100).toFixed(1) : null,
    positions: h.length,
    sectorWeights: sectorPct,
    topPositions: top,
    regime: window._briefingState ? window._briefingState.label : null
  };
}
async function aiExplainPosition(ticker) {
  const h = (window._holdings || []).find(x => x.ticker === ticker);
  if (!h) return;
  const box = document.getElementById('aiPosBox-'+ticker);
  if (!box) return;
  box.innerHTML = '<div class="ai-loading"></div><div class="ai-loading" style="width:80%;"></div>';
  const isCash = ['Cash','Money Market','CD','Bond Position'].includes(h.assetClass);
  const mv = isCash ? h.costBasis*h.quantity : (h.currentPrice||0)*h.quantity;
  const tv = (window._holdings||[]).reduce((s,x)=>{
    var c = ['Cash','Money Market','CD','Bond Position'].includes(x.assetClass);
    return s + (c ? x.costBasis*x.quantity : (x.currentPrice||0)*x.quantity);
  }, 0);
  const ctx = {
    ticker: h.ticker, name: h.companyName, sector: h.sector, industry: h.industry,
    weight: tv>0 ? +(mv/tv*100).toFixed(1) : 0,
    glPct: h.costBasis>0 ? +(((h.currentPrice||h.costBasis)/h.costBasis - 1)*100).toFixed(1) : null,
    accountType: h.accountType,
    regime: window._briefingState ? window._briefingState.label : null
  };
  const sys = 'You are an investment analyst. In 3-4 short sentences, explain (1) what this position contributes to a portfolio, (2) any concentration or fit concerns at the given weight, (3) how it fits the current regime if known. Do not give buy/sell advice. Plain prose.';
  try {
    const text = await aiCallProxy([
      { role: 'user', content: sys + '\n\nPosition context:\n' + JSON.stringify(ctx) }
    ], 600);
    box.textContent = text;
  } catch(e) { box.textContent = 'Could not generate: '+e.message; }
}
async function aiExplainMarket() {
  const box = document.getElementById('aiMarketBox');
  box.style.display = '';
  box.innerHTML = '<div class="ai-panel"><div class="ai-panel-header"><div class="ai-panel-title">Today\'s Market Read</div></div><div class="ai-panel-body" id="aiMarketBody"><div class="ai-loading"></div><div class="ai-loading" style="width:85%;"></div><div class="ai-loading" style="width:92%;"></div></div></div>';
  const body = document.getElementById('aiMarketBody');
  // Build market snapshot from current data
  const cells = window._snapshotCells || [];
  if (!cells.length) { body.textContent = 'Load market snapshot first.'; return; }
  const data = cells.map(c => ({
    ticker: c.ticker, asset: c.label,
    pct: c.changePct != null ? +c.changePct.toFixed(2) : null
  }));
  const sys = 'You are a global macro analyst. In 4 short sentences, explain (1) the overall risk-on/risk-off tone today, (2) which asset class moved most and a likely driver, (3) any cross-asset tension or alignment (e.g., USD up + commodities down = dollar liquidity; rates up + stocks up = growth). Be factual. No advice. Plain prose.';
  try {
    const text = await aiCallProxy([
      { role: 'user', content: sys + '\n\nToday\'s cross-asset moves:\n' + JSON.stringify(data) }
    ], 600);
    body.textContent = text;
  } catch(e) { body.textContent = 'Could not generate: '+e.message; }
}

// ────────── Performance tab ──────────
async function pfRenderPerformance() {
  const el = document.getElementById('pfPerfTable');
  if (!el) return;
  const h = window._holdings || [];
  if (!h.length) { el.innerHTML = '<p style="color:var(--text-sec);">Add holdings to compute period returns.</p>'; return; }

  el.innerHTML = '<div style="padding:16px;text-align:center;"><span class="spinner"></span> Computing period returns…</div>';
  try {
    // Fetch 2Y series so we can compute all sub-periods accurately
    const pfSeries = await pfBuildValueSeries('2y');
    const spy = await fetchChart('SPY', '2y', '1d');
    const qqq = await fetchChart('QQQ', '2y', '1d');
    if (!pfSeries.dates.length || !pfSeries.values.length) {
      el.innerHTML = '<p style="color:var(--text-sec);">Insufficient data — add holdings to compute period returns.</p>'; return;
    }

    // Helper: return from N trading days ago to today within a series
    // Uses the actual date array, not assumed calendar-day counts
    function seriesReturn(values, n) {
      const nonNull = values.map((v,i) => v != null ? i : -1).filter(i => i >= 0);
      if (nonNull.length < 2) return null;
      const lastIdx = nonNull[nonNull.length - 1];
      const startIdx = Math.max(0, lastIdx - n);
      const a = values[startIdx], b = values[lastIdx];
      if (!a || !b || a <= 0) return null;
      return ((b - a) / a) * 100;
    }
    function benchReturn(points, n) {
      const valid = (points || []).filter(p => p.close != null);
      if (valid.length < 2) return null;
      const lastIdx = valid.length - 1;
      const startIdx = Math.max(0, lastIdx - n);
      const a = valid[startIdx].close, b = valid[lastIdx].close;
      if (!a || !b || a <= 0) return null;
      return ((b - a) / a) * 100;
    }
    // YTD: find first date in pfSeries >= Jan 1 of current year
    function ytdReturn(dates, values) {
      const yearStart = new Date().getFullYear() + '-01-01';
      const idx = dates.findIndex(d => d >= yearStart);
      if (idx < 0 || idx >= values.length - 1) return null;
      const nonNull = values.slice(idx).filter(v => v != null);
      if (nonNull.length < 2) return null;
      const a = nonNull[0], b = nonNull[nonNull.length - 1];
      if (!a || a <= 0) return null;
      return ((b - a) / a) * 100;
    }
    function ytdBenchReturn(points) {
      const yearStart = new Date().getFullYear() + '-01-01';
      const valid = (points || []).filter(p => p.close != null && p.date >= yearStart);
      if (valid.length < 2) return null;
      const a = valid[0].close, b = valid[valid.length-1].close;
      if (!a || a <= 0) return null;
      return ((b - a) / a) * 100;
    }

    const periods = [
      { label: '1 Day',     pfR: seriesReturn(pfSeries.values, 1),   spyR: benchReturn(spy.points, 1),   qqqR: benchReturn(qqq.points, 1) },
      { label: '1 Week',    pfR: seriesReturn(pfSeries.values, 5),   spyR: benchReturn(spy.points, 5),   qqqR: benchReturn(qqq.points, 5) },
      { label: '1 Month',   pfR: seriesReturn(pfSeries.values, 21),  spyR: benchReturn(spy.points, 21),  qqqR: benchReturn(qqq.points, 21) },
      { label: '3 Months',  pfR: seriesReturn(pfSeries.values, 63),  spyR: benchReturn(spy.points, 63),  qqqR: benchReturn(qqq.points, 63) },
      { label: '6 Months',  pfR: seriesReturn(pfSeries.values, 126), spyR: benchReturn(spy.points, 126), qqqR: benchReturn(qqq.points, 126) },
      { label: 'YTD',       pfR: ytdReturn(pfSeries.dates, pfSeries.values), spyR: ytdBenchReturn(spy.points), qqqR: ytdBenchReturn(qqq.points) },
      { label: '1 Year',    pfR: seriesReturn(pfSeries.values, 252), spyR: benchReturn(spy.points, 252), qqqR: benchReturn(qqq.points, 252) }
    ].map(p => ({ ...p, active: p.pfR != null && p.spyR != null ? p.pfR - p.spyR : null }));

    const fmt = v => v == null ? '<span style="color:var(--text-sec);">—</span>' : '<span style="color:'+(v>=0?'var(--success)':'var(--danger)')+';font-weight:700;">'+(v>=0?'+':'')+v.toFixed(2)+'%</span>';
    const fmtN = v => v == null ? '<span style="color:var(--text-sec);">—</span>' : '<span style="color:'+(v>=0?'var(--success)':'var(--danger)')+';">'+(v>=0?'+':'')+v.toFixed(2)+'%</span>';

    let html = '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;font-family:Arial;">';
    html += '<thead><tr style="background:var(--navy);color:#fff;">'+
      '<th style="padding:9px 10px;text-align:left;">Period</th>'+
      '<th style="padding:9px 10px;text-align:right;">Portfolio</th>'+
      '<th style="padding:9px 10px;text-align:right;">SPY</th>'+
      '<th style="padding:9px 10px;text-align:right;">QQQ</th>'+
      '<th style="padding:9px 10px;text-align:right;">vs SPY</th></tr></thead><tbody>';
    periods.forEach(r => {
      html += '<tr style="border-bottom:1px solid var(--border-light,#E5E9EF);">'+
        '<td style="padding:8px 10px;font-weight:600;color:var(--text);">'+r.label+'</td>'+
        '<td style="padding:8px 10px;text-align:right;font-family:Courier New,monospace;">'+fmt(r.pfR)+'</td>'+
        '<td style="padding:8px 10px;text-align:right;font-family:Courier New,monospace;">'+fmtN(r.spyR)+'</td>'+
        '<td style="padding:8px 10px;text-align:right;font-family:Courier New,monospace;">'+fmtN(r.qqqR)+'</td>'+
        '<td style="padding:8px 10px;text-align:right;font-family:Courier New,monospace;">'+fmt(r.active)+'</td></tr>';
    });

    // Risk metrics from daily returns
    const pfRets = dailyLogReturns(pfSeries.values.filter(v => v != null));
    const spyPts = (spy.points || []).filter(p => p.close != null);
    const spyRets = chartLogReturns(spyPts);
    const minLen = Math.min(pfRets.length, spyRets.length);

    if (minLen >= 30) {
      const pfSlice = pfRets.slice(-minLen);
      const spySlice = spyRets.slice(-minLen);
      const active = pfSlice.map((r,i) => r - spySlice[i]);
      const meanA = active.reduce((s,v)=>s+v,0)/active.length;
      const varA = active.reduce((s,v)=>s+(v-meanA)*(v-meanA),0)/Math.max(active.length-1,1);
      const teAnn = Math.sqrt(varA) * Math.sqrt(252) * 100;
      const irAnn = varA > 0 ? (meanA / Math.sqrt(varA)) * Math.sqrt(252) : 0;

      // Annualized Sharpe
      const pfMean = pfSlice.reduce((s,v)=>s+v,0)/pfSlice.length;
      const pfVar = pfSlice.reduce((s,v)=>s+(v-pfMean)*(v-pfMean),0)/Math.max(pfSlice.length-1,1);
      const pfAnnVol = Math.sqrt(pfVar) * Math.sqrt(252);
      const pfAnnRet = (pfMean + pfVar/2) * 252;
      const sharpe = pfAnnVol > 0 ? (pfAnnRet - 0.045) / pfAnnVol : 0;

      // Sortino (downside deviation only)
      const negRets = pfSlice.filter(r => r < 0);
      const downVar = negRets.length > 1 ? negRets.reduce((s,v)=>s+v*v,0)/negRets.length : pfVar;
      const sortino = Math.sqrt(downVar)*Math.sqrt(252) > 0 ? (pfAnnRet - 0.045) / (Math.sqrt(downVar)*Math.sqrt(252)) : 0;

      // Max drawdown 1Y
      const nonNull1Y = pfSeries.values.slice(-252).filter(v=>v!=null);
      let peak1Y = nonNull1Y[0]||0, mdd1Y = 0;
      nonNull1Y.forEach(v=>{ if(v>peak1Y) peak1Y=v; const dd=(v-peak1Y)/peak1Y; if(dd<mdd1Y) mdd1Y=dd; });

      html += '<tr style="background:var(--panel);border-top:2px solid var(--border);"><td colspan="5" style="padding:10px 10px;font-size:11.5px;">'+
        '<div style="display:flex;flex-wrap:wrap;gap:20px;">'+
        '<span><strong>Tracking Error:</strong> '+teAnn.toFixed(2)+'%</span>'+
        '<span><strong>Information Ratio:</strong> '+irAnn.toFixed(2)+'</span>'+
        '<span><strong>Sharpe (1Y):</strong> '+sharpe.toFixed(2)+'</span>'+
        '<span><strong>Sortino (1Y):</strong> '+sortino.toFixed(2)+'</span>'+
        '<span><strong>Max Drawdown (1Y):</strong> <span style="color:var(--danger);">'+((mdd1Y*100).toFixed(1))+'%</span></span>'+
        '<span><strong>Ann. Vol:</strong> '+(pfAnnVol*100).toFixed(1)+'%</span>'+
        '</div></td></tr>';
    }

    html += '</tbody></table></div>';
    el.innerHTML = html;

    // Rolling active return chart with proper dates
    if (typeof Chart !== 'undefined' && minLen >= 60) {
      const pfSlice2 = pfRets.slice(-minLen);
      const spySlice2 = spyRets.slice(-minLen);
      const active2 = pfSlice2.map((r,i)=>(r - spySlice2[i])*100);
      const WIN = 21; const rollAct = []; const rollDates = [];
      const recentDates = pfSeries.dates.slice(-minLen);
      for (let i = WIN; i < active2.length; i++) {
        const sl = active2.slice(i-WIN, i);
        rollAct.push(sl.reduce((s,v)=>s+v,0)/sl.length);
        rollDates.push(recentDates[i] || String(i));
      }
      // Thin labels
      const labelStep = Math.max(1, Math.floor(rollDates.length / 10));
      const cv = document.getElementById('pfActiveChart');
      if (cv && rollAct.length) {
        if (window._pfActiveChart) window._pfActiveChart.destroy();
        window._pfActiveChart = new Chart(cv, {
          type: 'line',
          data: {
            labels: rollDates,
            datasets: [
              { label: 'Rolling 21D Active Return vs SPY (%)', data: rollAct,
                borderColor: '#5B9BD5', backgroundColor: ctx2 => {
                  const v = ctx2.parsed && ctx2.parsed.y;
                  return v >= 0 ? 'rgba(46,125,82,0.12)' : 'rgba(139,42,42,0.12)';
                },
                fill: 'origin', borderWidth: 2, pointRadius: 0, tension: 0.2 },
              { label: 'Zero', data: new Array(rollAct.length).fill(0),
                borderColor: 'rgba(0,0,0,0.2)', borderWidth: 1, borderDash:[3,3],
                pointRadius:0, fill:false }
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            plugins: {
              legend: { display: true, position: 'top', labels: { color: '#1A2733', font: { size: 11 } } },
              tooltip: { mode: 'index', intersect: false, callbacks: {
                title: function(items){ return items[0] ? rollDates[items[0].dataIndex] : ''; },
                label: function(ctx){ return ctx.dataset.label === 'Zero' ? null : ctx.dataset.label+': '+(ctx.parsed.y||0).toFixed(3)+'%'; }
              }}
            },
            scales: {
              x: { ticks: { color:'#5A6772', maxTicksLimit:8, maxRotation:0, callback: function(v,i){ return i%labelStep===0 ? rollDates[i] : ''; } }, grid: {color:'rgba(208,215,224,0.3)'} },
              y: { ticks: { color:'#5A6772', callback: v => v.toFixed(2)+'%' }, grid: {color:'rgba(208,215,224,0.3)'},
                   title: {display:true, text:'Active Return (%)', color:'#5A6772', font:{size:11}} }
            }
          }
        });
      }
    }
  } catch(e) {
    el.innerHTML = '<p style="color:var(--danger);">Could not compute: '+e.message+'</p>';
    console.error('[pfRenderPerformance]', e);
  }
}
// ── Performance Tab ──────────────────────────────────────────────
async function renderPerformanceTab() {
  var holdings = window._holdings || [];
  if (!holdings.length) { return; }
  var rangeBtn = document.querySelector('#perfTimeframeBtns .btn-outline.active');
  var range = rangeBtn ? rangeBtn.getAttribute('data-perf-range') : '1y';
  var kpiEl = document.getElementById('perfKPIBar');
  var summaryEl = document.getElementById('perfSummaryCard');
  var summaryTextEl = document.getElementById('perfSummaryText');
  if (kpiEl) kpiEl.innerHTML = '<span class="spinner"></span> Computing...';
  try {
    var pfSeries = await pfBuildValueSeries(range, window._perfAccount);
    if (!pfSeries || !pfSeries.dates || pfSeries.dates.length < 5) {
      if (kpiEl) kpiEl.innerHTML = '<span style="color:var(--text-sec);font-size:12px;">Not enough history for selected period'+(window._perfAccount && window._perfAccount!=='all' ? ' in the '+window._perfAccount+' account' : '')+'. Add holdings and try again.</span>';
      return;
    }
    var now = new Date();
    var cutoff = new Date(now);
    if (range === '1mo') cutoff.setMonth(cutoff.getMonth()-1);
    else if (range === '3mo') cutoff.setMonth(cutoff.getMonth()-3);
    else if (range === '6mo') cutoff.setMonth(cutoff.getMonth()-6);
    else if (range === 'ytd') cutoff = new Date(now.getFullYear(),0,1);
    else if (range === '1y') cutoff.setFullYear(cutoff.getFullYear()-1);
    else if (range === '3y') cutoff.setFullYear(cutoff.getFullYear()-3);
    else if (range === '5y') cutoff.setFullYear(cutoff.getFullYear()-5);
    var cutStr = cutoff.toISOString().slice(0,10);
    var allDates = pfSeries.dates;
    var allValues = pfSeries.values;
    var filteredPairs = [];
    for (var fi = 0; fi < allDates.length; fi++) {
      if (allDates[fi] >= cutStr && allValues[fi] != null && allValues[fi] > 0) filteredPairs.push({ date: allDates[fi], value: allValues[fi], twr: (pfSeries.twrValues && pfSeries.twrValues[fi] != null && pfSeries.twrValues[fi] > 0) ? pfSeries.twrValues[fi] : null });
    }
    if (filteredPairs.length < 5) { if (kpiEl) kpiEl.innerHTML = '<span style="color:var(--text-sec);font-size:12px;">Not enough history for selected period.</span>'; return; }
    var dates = filteredPairs.map(function(p){ return p.date; });
    var values = filteredPairs.map(function(p){ return p.value; });
    // ── All PERFORMANCE math runs on the TWR (time-weighted) series when
    //    available. The raw dollar series jumps when you deposit or buy —
    //    which previously counted contributions as "returns". TWR strips
    //    cash-flow effects (GIPS standard). Falls back to raw values. ──
    var twrArr = filteredPairs.map(function(p){ return p.twr; });
    var perf = twrArr.every(function(v){ return v != null; }) ? twrArr : values;
    var startVal = values[0], endVal = values[values.length-1];
    var totalReturn = (perf[perf.length-1] - perf[0]) / perf[0];
    var dailyRets = [];
    for (var i = 1; i < perf.length; i++) { if (perf[i-1] > 0) dailyRets.push((perf[i]-perf[i-1])/perf[i-1]); }
    var avgDaily = dailyRets.reduce(function(s,r){ return s+r; },0) / (dailyRets.length||1);
    var varDaily = dailyRets.reduce(function(s,r){ return s+(r-avgDaily)*(r-avgDaily); },0) / (dailyRets.length||1);
    var stdDaily = Math.sqrt(varDaily);
    var annVol = stdDaily * Math.sqrt(252);
    var annRet = Math.pow(1+totalReturn, 252/(dailyRets.length||252)) - 1;
    // Annualizing very short windows produces absurd extrapolations
    // (a +4% month becomes "+60% annualized"). Only meaningful ≥ ~6 months.
    var annRetMeaningful = dailyRets.length >= 120;
    var rf = 0.05/252;
    var sharpe = stdDaily > 0 ? (avgDaily - rf) / stdDaily * Math.sqrt(252) : 0;
    var peak = perf[0], maxDD = 0;
    perf.forEach(function(v){ if (v>peak) peak=v; var dd=(peak-v)/peak; if (dd>maxDD) maxDD=dd; });
    // ── Benchmarks: aligned to the PORTFOLIO's date array by date lookup
    //    with carry-forward. (Previously plotted positionally — different
    //    array lengths made the lines drift and dates go wonky.) ──
    function alignBenchmark(chartResp) {
      var m = {};
      (chartResp.points || []).forEach(function(p){ if (p.close != null) m[p.date.slice(0,10)] = p.close; });
      var lastPx = null;
      var aligned = dates.map(function(d){ if (m[d] != null) lastPx = m[d]; return lastPx; });
      var fIdx = -1;
      for (var ai2 = 0; ai2 < aligned.length; ai2++) { if (aligned[ai2] != null) { fIdx = ai2; break; } }
      if (fIdx < 0) return null;
      var base = aligned[fIdx];
      return dates.map(function(d, i2){ return { date: d, val: aligned[i2] != null ? (aligned[i2]/base)*startVal : null }; });
    }
    var spyData = null, qqqData = null;
    try {
      var frange = range === 'ytd' ? '1y' : range;
      var spyR = await fetchChart('SPY', frange, '1d');
      spyData = alignBenchmark(spyR);
      var qqqR = await fetchChart('QQQ', frange, '1d');
      qqqData = alignBenchmark(qqqR);
    } catch(e2) {}
    var spyReturn = (spyData && spyData[spyData.length-1].val != null) ? (spyData[spyData.length-1].val - startVal)/startVal : null;
    var alpha = spyReturn !== null ? totalReturn - spyReturn : null;
    // Short, readable x-axis dates ("Mar 25") — used by every chart below
    var MONTHS3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    function perfTickFmt(isoOrIdx, labels) {
      var iso = typeof isoOrIdx === 'string' ? isoOrIdx : (labels && labels[isoOrIdx]) || '';
      if (!iso || iso.length < 7) return iso;
      return MONTHS3[parseInt(iso.slice(5,7),10)-1] + " '" + iso.slice(2,4);
    }
    var perfXTicks = { maxTicksLimit: 8, font: { size: 10 }, maxRotation: 0, callback: function(v){ return perfTickFmt(this.getLabelForValue(v)); } };
    var fmt2 = function(v){ return (v>=0?'+':'')+((v||0)*100).toFixed(1)+'%'; };
    if (kpiEl) {
      kpiEl.innerHTML = [
        { l:'Total Return (TWR)', v:fmt2(totalReturn), c:totalReturn>=0?'var(--success)':'var(--danger)' },
        { l:'Ann. Return', v:annRetMeaningful?fmt2(annRet):'— (<6mo)', c:annRetMeaningful?(annRet>=0?'var(--success)':'var(--danger)'):'var(--text-sec)' },
        { l:'Ann. Volatility', v:((annVol||0)*100).toFixed(1)+'%', c:'var(--text)' },
        { l:'Sharpe Ratio', v:(sharpe||0).toFixed(2), c:sharpe>1?'var(--success)':sharpe>0?'var(--warning)':'var(--danger)' },
        { l:'Max Drawdown', v:'-'+((maxDD||0)*100).toFixed(1)+'%', c:'var(--danger)' },
        alpha!==null ? { l:'vs SPY (Alpha)', v:fmt2(alpha), c:alpha>=0?'var(--success)':'var(--danger)' } : null
      ].filter(Boolean).map(function(s){ return '<div class="chart-stat-box"><div class="chart-stat-label">'+s.l+'</div><div class="chart-stat-value" style="color:'+s.c+';">'+s.v+'</div></div>'; }).join('');
    }
    if (summaryEl && summaryTextEl) {
      summaryEl.style.display = '';
      var spyTxt = spyReturn !== null ? (totalReturn > spyReturn ? 'outperforming SPY by <strong>'+fmt2(alpha)+'</strong>' : 'underperforming SPY by <strong>'+fmt2(alpha)+'</strong>') : '';
      var bestDay = Math.max.apply(null,dailyRets); var worstDay = Math.min.apply(null,dailyRets);
      summaryTextEl.innerHTML = 'Over the selected period, your portfolio returned <strong style="color:'+(totalReturn>=0?'var(--success)':'var(--danger)')+'">'+fmt2(totalReturn)+'</strong> (annualized: <strong>'+fmt2(annRet)+'</strong>)'+(spyTxt?', '+spyTxt:'')
        +'. Annual volatility was <strong>'+((annVol||0)*100).toFixed(1)+'%</strong> with a Sharpe ratio of <strong>'+(sharpe||0).toFixed(2)+'</strong>. The worst peak-to-valley drawdown was <strong>'+((maxDD||0)*100).toFixed(1)+'%</strong>.'
        +' Best single day: <strong style="color:var(--success)">'+fmt2(bestDay)+'</strong>. Worst single day: <strong style="color:var(--danger)">'+fmt2(worstDay)+'</strong>.';
    }
    var ctx1 = document.getElementById('perfCumulChart');
    if (ctx1) {
      if (window._perfCumulChart) window._perfCumulChart.destroy();
      var pfNorm = perf.map(function(v){ return (v/perf[0]-1)*100; });
      var ds = [{ label:'Portfolio (TWR)', data:pfNorm, borderColor:C.navy, backgroundColor:'rgba(0,60,113,0.08)', fill:true, tension:0.25, pointRadius:0, borderWidth:2 }];
      if (spyData) ds.push({ label:'SPY', data:spyData.map(function(p){ return p.val!=null?(p.val/startVal-1)*100:null; }), borderColor:C.blue, borderWidth:1.5, pointRadius:0, tension:0.25, fill:false, spanGaps:true });
      if (qqqData) ds.push({ label:'QQQ', data:qqqData.map(function(p){ return p.val!=null?(p.val/startVal-1)*100:null; }), borderColor:C.success, borderWidth:1.5, pointRadius:0, tension:0.25, fill:false, spanGaps:true });
      window._perfCumulChart = new Chart(ctx1.getContext('2d'), { type:'line', data:{ labels:dates, datasets:ds },
        options:{ responsive:true, maintainAspectRatio:false, animation:false, interaction:{mode:'index',intersect:false},
          plugins:{ legend:{ position:'top', labels:{font:{size:11}} }, tooltip:{ callbacks:{ label:function(c){ return c.dataset.label+': '+(c.parsed.y>=0?'+':'')+c.parsed.y.toFixed(1)+'%'; } } } },
          scales:{ x:{ ticks:perfXTicks, grid:{display:false} }, y:{ ticks:{ callback:function(v){ return v.toFixed(0)+'%'; }, font:{size:10} } } } }
      });
    }
    var ctx2 = document.getElementById('perfRollingChart');
    if (ctx2 && perf.length > 20) {
      if (window._perfRollingChart) window._perfRollingChart.destroy();
      var roll = [], rollDates = [];
      var window12 = Math.min(252, Math.floor(perf.length/2));
      for (var ri = window12; ri < perf.length; ri++) { var r12 = (perf[ri]-perf[ri-window12])/perf[ri-window12]*100; roll.push(parseFloat(r12.toFixed(2))); rollDates.push(dates[ri]); }
      window._perfRollingChart = new Chart(ctx2.getContext('2d'), { type:'line', data:{ labels:rollDates, datasets:[{ label:'Rolling '+window12+'-Day Return', data:roll, borderColor:C.navy, borderWidth:1.5, pointRadius:0, tension:0.25, fill:{target:'origin'}, backgroundColor:'rgba(0,60,113,0.10)' }] },
        options:{ responsive:true, maintainAspectRatio:false, animation:false, plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:function(c){ return (c.parsed.y>=0?'+':'')+c.parsed.y.toFixed(1)+'%'; } } } }, scales:{ x:{ ticks:perfXTicks, grid:{display:false} }, y:{ ticks:{ callback:function(v){ return v.toFixed(0)+'%'; }, font:{size:10} } } } }
      });
    }
    var ctx3 = document.getElementById('perfCalYearChart');
    if (ctx3) {
      if (window._perfCalYearChart) window._perfCalYearChart.destroy();
      var yearMap = {};
      for (var ci = 0; ci < dates.length; ci++) { var yr = dates[ci].slice(0,4); if (!yearMap[yr]) yearMap[yr]=[]; yearMap[yr].push(perf[ci]); }
      var yrs = Object.keys(yearMap).sort();
      var yrRets = yrs.map(function(y){ var vs=yearMap[y]; return vs.length>1?((vs[vs.length-1]-vs[0])/vs[0]*100):0; });
      window._perfCalYearChart = new Chart(ctx3.getContext('2d'), { type:'bar', data:{ labels:yrs, datasets:[{ label:'Annual Return %', data:yrRets, backgroundColor:yrRets.map(function(v){ return v>=0?'rgba(46,125,82,0.72)':'rgba(139,42,42,0.72)'; }), borderWidth:0 }] },
        options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:function(c){ return c.parsed.y.toFixed(1)+'%'; } } } }, scales:{ x:{ grid:{display:false}, ticks:{font:{size:10}} }, y:{ ticks:{ callback:function(v){ return v.toFixed(0)+'%'; }, font:{size:10} } } } }
      });
    }
    var ctx4 = document.getElementById('perfDistChart');
    if (ctx4 && dailyRets.length > 10) {
      if (window._perfDistChart) window._perfDistChart.destroy();
      var minR = Math.min.apply(null,dailyRets)*100, maxR = Math.max.apply(null,dailyRets)*100;
      var bins = 20; var step = (maxR-minR)/bins; var counts = new Array(bins).fill(0); var binLabels = [];
      for (var bi = 0; bi < bins; bi++) binLabels.push((minR+bi*step).toFixed(1)+'%');
      dailyRets.forEach(function(r){ var ri2=Math.min(bins-1,Math.floor((r*100-minR)/step)); if(ri2>=0) counts[ri2]++; });
      window._perfDistChart = new Chart(ctx4.getContext('2d'), { type:'bar', data:{ labels:binLabels, datasets:[{ label:'Frequency', data:counts, backgroundColor:binLabels.map(function(l){ return parseFloat(l)>=0?'rgba(46,125,82,0.65)':'rgba(139,42,42,0.65)'; }), borderWidth:0 }] },
        options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{display:false} }, scales:{ x:{ ticks:{ maxTicksLimit:8, font:{size:10} }, grid:{display:false} }, y:{ title:{display:true,text:'# Days'} } } }
      });
    }
    var tbEl = document.querySelector('#perfBestWorstTable tbody');
    if (tbEl) {
      var periods = ['Day','Week','Month']; var windows = [1,5,21];
      tbEl.innerHTML = periods.map(function(p,pi){ var w=windows[pi]; var rets=[];
        for (var ki=w;ki<perf.length;ki++) { var r=(perf[ki]-perf[ki-w])/perf[ki-w]; rets.push({r:r,d:dates[ki]}); }
        if (!rets.length) return '';
        rets.sort(function(a,b){ return b.r-a.r; }); var best=rets[0],worst=rets[rets.length-1];
        return '<tr><td style="font-weight:600;">Best/Worst '+p+'</td><td style="color:var(--success);font-weight:700;">'+(best.r*100).toFixed(1)+'%</td><td style="font-size:11px;">'+best.d+'</td><td style="color:var(--danger);font-weight:700;">'+(worst.r*100).toFixed(1)+'%</td><td style="font-size:11px;">'+worst.d+'</td></tr>';
      }).join('');
    }
    var bsEl = document.getElementById('perfBenchScorecard');
    if (bsEl) {
      // Build SPY daily-return lookup keyed by date (date-aligned, not positional)
      var spyDateRetMap = {};
      if (spyData && spyData.length > 1) {
        for (var sdi=1; sdi<spyData.length; sdi++) {
          if (spyData[sdi-1].val > 0) spyDateRetMap[spyData[sdi].date] = (spyData[sdi].val - spyData[sdi-1].val) / spyData[sdi-1].val;
        }
      }
      // Align portfolio returns with SPY returns by matching date strings
      var alignedPf=[], alignedSpy=[];
      for (var ai=1; ai<dates.length; ai++) {
        var sr = spyDateRetMap[dates[ai]];
        if (sr !== undefined && dailyRets[ai-1] !== undefined) {
          alignedPf.push(dailyRets[ai-1]);
          alignedSpy.push(sr);
        }
      }
      var nCommon = alignedPf.length;
      var beta=1, trackErr=0, infoRatio=0, upCapture=100, downCapture=100;
      if (nCommon > 10) {
        var pfAvg2=0, spyAvg2=0;
        for (var si=0;si<nCommon;si++){pfAvg2+=alignedPf[si];spyAvg2+=alignedSpy[si];}
        pfAvg2/=nCommon; spyAvg2/=nCommon;
        var covSum=0,varSpy=0;
        for (var si2=0;si2<nCommon;si2++){covSum+=(alignedPf[si2]-pfAvg2)*(alignedSpy[si2]-spyAvg2);varSpy+=(alignedSpy[si2]-spyAvg2)*(alignedSpy[si2]-spyAvg2);}
        beta = varSpy>0?covSum/varSpy:1;
        var diffs=alignedPf.map(function(r,ii){return r-alignedSpy[ii];});
        var diffMean=diffs.reduce(function(s,r){return s+r;},0)/diffs.length;
        var diffVar=diffs.reduce(function(s,r){return s+(r-diffMean)*(r-diffMean);},0)/diffs.length;
        trackErr=Math.sqrt(diffVar)*Math.sqrt(252); infoRatio=trackErr>0?(diffMean/Math.sqrt(diffVar))*Math.sqrt(252):0;
        // Cumulative-product capture ratio (Morningstar standard — avoids daily-average distortion)
        var upPfCum=1,upSpyCum=1,downPfCum=1,downSpyCum=1,upCount=0,downCount=0;
        for (var si3=0;si3<nCommon;si3++){
          if(alignedSpy[si3]>0){ upPfCum*=(1+alignedPf[si3]); upSpyCum*=(1+alignedSpy[si3]); upCount++; }
          else if(alignedSpy[si3]<0){ downPfCum*=(1+alignedPf[si3]); downSpyCum*=(1+alignedSpy[si3]); downCount++; }
        }
        upCapture   = upCount>0   && (upSpyCum-1)!==0   ? (upPfCum-1)/(upSpyCum-1)*100   : 100;
        downCapture = downCount>0 && (downSpyCum-1)!==0 ? (downPfCum-1)/(downSpyCum-1)*100 : 100;
        upCapture   = Math.max(-500, Math.min(500, upCapture));
        downCapture = Math.max(-500, Math.min(500, downCapture));
      }
      bsEl.innerHTML=[
        {l:'Beta vs SPY',v:beta.toFixed(2),c:beta<1.2?'var(--success)':'var(--warning)'},
        {l:'Tracking Error',v:((trackErr||0)*100).toFixed(1)+'%',c:'var(--text)'},
        {l:'Information Ratio',v:(infoRatio||0).toFixed(2),c:infoRatio>0.5?'var(--success)':infoRatio>0?'var(--warning)':'var(--danger)'},
        {l:'Up Capture',v:(upCapture||0).toFixed(0)+'%',c:upCapture>100?'var(--success)':'var(--text)',tip:'Portfolio cumulative return on SPY up-days ÷ SPY cumulative return on same days. >100% = captured more upside than SPY.'},
        {l:'Down Capture',v:(downCapture||0).toFixed(0)+'%',c:downCapture<100?'var(--success)':'var(--danger)',tip:'Portfolio cumulative return on SPY down-days ÷ SPY cumulative return on same days. <100% = lost less than SPY on bad days (good).'}
      ].map(function(s){return '<div class="chart-stat-box" title="'+(s.tip||'')+'"><div class="chart-stat-label">'+s.l+'</div><div class="chart-stat-value" style="color:'+s.c+';">'+s.v+'</div></div>';}).join('');
    }
  } catch(e) { console.error('renderPerformanceTab error:',e); if (kpiEl) kpiEl.innerHTML = '<span style="color:var(--danger);font-size:12px;">Error: '+e.message+'</span>'; }
}

// ── Attribution Tab ──────────────────────────────────────────────
function renderAttributionTab() {
  var allH = window._holdings || [];
  if (!allH.length) return;
  var af = (document.getElementById('attrAccountFilter')||{}).value || 'all';
  var holdings = af === 'all' ? allH : allH.filter(function(h){ return (h.accountType||'Individual')===af; });
  if (!holdings.length) return;
  var afEl = document.getElementById('attrAccountFilter');
  if (afEl && afEl.options.length <= 1) {
    var accts = [];
    allH.forEach(function(h){ var a=h.accountType||'Individual'; if (accts.indexOf(a)<0) accts.push(a); });
    accts.forEach(function(a){ var o=document.createElement('option'); o.value=a; o.textContent=a; afEl.appendChild(o); });
  }
  var totalMV = holdings.reduce(function(s,h){ return s+(h.currentPrice||0)*h.quantity; }, 0);
  if (!totalMV) return;
  var contributions = holdings.map(function(h) {
    var mv=(h.currentPrice||0)*h.quantity; var cost=(h.costBasis||h.currentPrice||0)*h.quantity;
    var ret=cost>0?(mv-cost)/cost:0; var weight=mv/totalMV; var contrib=weight*ret;
    return {ticker:h.ticker,sector:h.sector||'Other',mv:mv,ret:ret,weight:weight,contrib:contrib};
  }).sort(function(a,b){ return b.contrib-a.contrib; });
  var totalContrib = contributions.reduce(function(s,c){ return s+c.contrib; }, 0);
  var contribCardsEl = document.getElementById('attrContribCards');
  if (contribCardsEl) {
    var sorted=contributions.slice().sort(function(a,b){return b.contrib-a.contrib;});
    var top3=sorted.slice(0,3); var bot3=sorted.slice(-3).reverse(); var cards='';
    top3.forEach(function(c,i){
      cards+='<div class="chart-stat-box" style="border-left:3px solid var(--success);"><div class="chart-stat-label">#'+(i+1)+' Contributor</div>'
        +'<div class="chart-stat-value" style="color:var(--navy);font-size:15px;">'+c.ticker+'</div>'
        +'<div style="font-size:11px;color:var(--success);">+'+(c.contrib*100).toFixed(2)+'% to portfolio</div>'
        +'<div style="font-size:11px;color:var(--text-sec);">Wt: '+(c.weight*100).toFixed(1)+'% &middot; Ret: '+(c.ret*100>=0?'+':'')+((c.ret||0)*100).toFixed(1)+'%</div></div>';
    });
    bot3.forEach(function(c,i){
      cards+='<div class="chart-stat-box" style="border-left:3px solid var(--danger);"><div class="chart-stat-label">#'+(i+1)+' Detractor</div>'
        +'<div class="chart-stat-value" style="color:var(--navy);font-size:15px;">'+c.ticker+'</div>'
        +'<div style="font-size:11px;color:var(--danger);">'+(c.contrib*100>=0?'+':'')+((c.contrib||0)*100).toFixed(2)+'% to portfolio</div>'
        +'<div style="font-size:11px;color:var(--text-sec);">Wt: '+(c.weight*100).toFixed(1)+'% &middot; Ret: '+(c.ret*100>=0?'+':'')+((c.ret||0)*100).toFixed(1)+'%</div></div>';
    });
    contribCardsEl.innerHTML = cards;
  }
  var sectorMap = {};
  contributions.forEach(function(c){ if (!sectorMap[c.sector]) sectorMap[c.sector]={contrib:0,weight:0}; sectorMap[c.sector].contrib+=c.contrib; sectorMap[c.sector].weight+=c.weight; });
  var insightCardEl=document.getElementById('attrInsightCard'); var insightTextEl=document.getElementById('attrInsightText');
  if (insightCardEl && insightTextEl) {
    insightCardEl.style.display='';
    var secKeys=Object.keys(sectorMap);
    var topSec=secKeys.slice().sort(function(a,b){return sectorMap[b].contrib-sectorMap[a].contrib;})[0];
    var botSec=secKeys.slice().sort(function(a,b){return sectorMap[a].contrib-sectorMap[b].contrib;})[0];
    var topH=contributions[0],botH=contributions[contributions.length-1];
    // Enriched 2026-07: same footprint, four extra decision stats —
    // hit rate, concentration of return, weight-vs-payoff mismatches.
    var winners = contributions.filter(function(c){ return (c.ret||0) > 0; }).length;
    var hitRatePct = contributions.length ? (winners/contributions.length*100) : 0;
    var posContribs = contributions.filter(function(c){ return c.contrib > 0; }).sort(function(a,b){ return b.contrib-a.contrib; });
    var totPos = posContribs.reduce(function(s,c){ return s+c.contrib; }, 0);
    var top3Share = totPos > 0 ? posContribs.slice(0,3).reduce(function(s,c){ return s+c.contrib; },0)/totPos*100 : 0;
    // Biggest mismatch: large weight, weak payoff
    var mismatch = contributions.slice().filter(function(c){ return c.weight > 0.03; }).sort(function(a,b){ return (a.contrib/Math.max(a.weight,1e-6)) - (b.contrib/Math.max(b.weight,1e-6)); })[0];
    insightTextEl.innerHTML=(topSec?'<strong>'+topSec+'</strong> contributed the most to returns (<strong style="color:var(--success)">+'+(sectorMap[topSec].contrib*100).toFixed(2)+'%</strong>), led by <strong>'+topH.ticker+'</strong>. ':'')
      +(botSec&&botSec!==topSec?'<strong>'+botSec+'</strong> was the biggest drag (<strong style="color:var(--danger)">'+(sectorMap[botSec].contrib*100>=0?'+':'')+((sectorMap[botSec].contrib||0)*100).toFixed(2)+'%</strong>), driven by <strong>'+botH.ticker+'</strong>. ':'')
      +'Total portfolio gain/loss from current positions: <strong style="color:'+(totalContrib>=0?'var(--success)':'var(--danger)')+';">'+(totalContrib*100>=0?'+':'')+((totalContrib||0)*100).toFixed(2)+'%</strong>.'
      +'<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;padding-top:8px;border-top:1px dashed var(--border);font-size:12px;">'
      +'<span><strong style="color:var(--navy);">Hit rate:</strong> '+hitRatePct.toFixed(0)+'% of positions positive'+(hitRatePct<50?' <span style="color:#8B6914;">(fewer than half your picks are working — returns rely on a few big winners)</span>':'')+'</span>'
      +'<span><strong style="color:var(--navy);">Return concentration:</strong> top 3 winners = '+top3Share.toFixed(0)+'% of all positive contribution'+(top3Share>70?' <span style="color:#8B6914;">(one stumble changes the story)</span>':'')+'</span>'
      +(mismatch && mismatch.contrib/Math.max(mismatch.weight,1e-6) < 0 ? '<span><strong style="color:var(--navy);">Capital misallocation:</strong> <strong>'+mismatch.ticker+'</strong> holds '+(mismatch.weight*100).toFixed(1)+'% of capital but contributes '+((mismatch.contrib||0)*100).toFixed(2)+'% — your largest weight-vs-payoff mismatch</span>' : '')
      +'</div>';
  }
  var attrCtx=document.getElementById('attrContribChart');
  if (attrCtx) {
    if (window._attrContribChart) window._attrContribChart.destroy();
    var top20=contributions.slice(0,20);
    window._attrContribChart=new Chart(attrCtx.getContext('2d'),{type:'bar',
      data:{labels:top20.map(function(c){return c.ticker;}),datasets:[{label:'Contribution to Return',data:top20.map(function(c){return parseFloat((c.contrib*100).toFixed(3));}),backgroundColor:top20.map(function(c){return c.contrib>=0?'rgba(46,125,82,0.7)':'rgba(139,42,42,0.7)';}),borderWidth:0}]},
      options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:function(c){return 'Contribution: '+(c.parsed.x>=0?'+':'')+c.parsed.x.toFixed(2)+'%';}}}},scales:{x:{ticks:{callback:function(v){return v.toFixed(1)+'%';},font:{size:10}}},y:{ticks:{font:{size:10}},grid:{display:false}}}}
    });
  }
  var stEl=document.querySelector('#attrSectorTable tbody');
  if (stEl) {
    var sectorData=Object.keys(sectorMap).map(function(s){return{sector:s,weight:sectorMap[s].weight,contrib:sectorMap[s].contrib,ret:sectorMap[s].weight>0?sectorMap[s].contrib/sectorMap[s].weight:0};}).sort(function(a,b){return b.contrib-a.contrib;});
    stEl.innerHTML=sectorData.map(function(s){
      return '<tr><td style="font-weight:600;">'+s.sector+'</td><td style="text-align:right;">'+(s.weight*100).toFixed(1)+'%</td>'
        +'<td style="text-align:right;color:'+(s.ret>=0?'var(--success)':'var(--danger)')+';">'+(s.ret*100>=0?'+':'')+((s.ret||0)*100).toFixed(1)+'%</td>'
        +'<td style="text-align:right;font-weight:600;color:'+(s.contrib>=0?'var(--success)':'var(--danger)')+';">'+(s.contrib*100>=0?'+':'')+((s.contrib||0)*100).toFixed(2)+'%</td></tr>';
    }).join('');
  }
  // Auto-run Brinson-Fachler attribution whenever attribution tab renders
  if (typeof brinsonRun === 'function') brinsonRun();
}

function ytdDays() {
  const today = new Date();
  const start = new Date(today.getFullYear(), 0, 1);
  return Math.floor((today - start) / 86400000 * (252/365));
}
function pctReturn(arr, lookback) {
  if (!arr || arr.length < lookback + 1) return null;
  const a = arr[arr.length - 1 - lookback];
  const b = arr[arr.length - 1];
  if (!a) return null;
  return ((b/a) - 1) * 100;
}
function chartReturn(points, lookback) {
  if (!points || points.length < 2) return null;
  const valid = points.filter(function(p){ return p && p.close != null && p.close > 0; });
  if (valid.length < 2) return null;
  // Use min(lookback, available) so short series still return a value
  const effectiveLookback = Math.min(lookback, valid.length - 1);
  const a = valid[valid.length - 1 - effectiveLookback].close;
  const b = valid[valid.length - 1].close;
  if (!a || a <= 0) return null;
  return ((b / a) - 1) * 100;
}
function dailyLogReturns(values) {
  const r = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i-1] > 0 && values[i] > 0) r.push(Math.log(values[i] / values[i-1]));
  }
  return r;
}
function chartLogReturns(points) {
  const r = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i-1].close > 0 && points[i].close > 0) r.push(Math.log(points[i].close / points[i-1].close));
  }
  return r;
}
async function pfBuildValueSeries(range, acctFilter) {
  // Optional account scoping (2026-07): when acctFilter is set and not 'all',
  // the series is reconstructed from that account's positions only.
  // Reconstruct daily portfolio dollar-value series
  let h = window._holdings || [];
  if (acctFilter && acctFilter !== 'all') h = h.filter(x => (x.accountType || 'Individual') === acctFilter);
  const isCashFn = x => ['Cash','Money Market','CD','Bond Position'].includes(x.assetClass);
  const securities = h.filter(x => !isCashFn(x));
  const cashHoldings = h.filter(isCashFn);
  const cashValue = cashHoldings.reduce((s,x) => s + (x.costBasis||0)*(x.quantity||1), 0);
  if (!securities.length && !cashValue) return { dates: [], values: [], twrValues: [] };
  if (!securities.length) return { dates: [], values: [cashValue], twrValues: [100] };

  // Map range to a valid Yahoo Finance range string
  const validRanges = {'1mo':'1mo','3mo':'3mo','6mo':'6mo','ytd':'1y','1y':'1y','2y':'2y','3y':'5y','5y':'5y','10y':'10y','15y':'max','20y':'max','max':'max'};
  const fetchRange = validRanges[range] || range;

  // Aggregate by ticker across accounts (sum quantities, use earliest purchase date)
  const byTicker = {};
  securities.forEach(s => {
    const key = s.ticker;
    if (!byTicker[key]) byTicker[key] = { ticker: key, quantity: 0, datePurchased: s.datePurchased || null };
    byTicker[key].quantity += (s.quantity || 0);
    const dp = s.datePurchased || s.purchaseDate || null;
    if (dp && (!byTicker[key].datePurchased || dp < byTicker[key].datePurchased)) byTicker[key].datePurchased = dp;
  });
  const aggSecs = Object.values(byTicker);

  // Fetch price series in parallel
  const seriesMap = {};
  await Promise.all(aggSecs.map(async s => {
    try {
      const c = await fetchChart(s.ticker, fetchRange, '1d');
      seriesMap[s.ticker] = (c.points || []).filter(p => p.close != null);
    } catch(e) { seriesMap[s.ticker] = []; }
  }));

  // Build date->price maps
  const priceMap = {};
  aggSecs.forEach(s => {
    priceMap[s.ticker] = {};
    (seriesMap[s.ticker] || []).forEach(p => { priceMap[s.ticker][p.date.slice(0,10)] = p.close; });
  });

  // Union of all dates across all tickers
  const allDatesSet = new Set();
  Object.values(seriesMap).forEach(pts => pts.forEach(p => allDatesSet.add(p.date.slice(0,10))));
  const dates = [...allDatesSet].sort();
  if (!dates.length) return { dates: [], values: [], twrValues: [] };

  // Filter to requested range window
  let cutoff = null;
  const today = new Date();
  if (range==='1mo') { cutoff=new Date(today); cutoff.setMonth(today.getMonth()-1); }
  else if (range==='3mo') { cutoff=new Date(today); cutoff.setMonth(today.getMonth()-3); }
  else if (range==='6mo') { cutoff=new Date(today); cutoff.setMonth(today.getMonth()-6); }
  else if (range==='ytd') { cutoff=new Date(today.getFullYear(),0,1); }
  else if (range==='1y') { cutoff=new Date(today); cutoff.setFullYear(today.getFullYear()-1); }
  else if (range==='2y') { cutoff=new Date(today); cutoff.setFullYear(today.getFullYear()-2); }
  else if (range==='3y') { cutoff=new Date(today); cutoff.setFullYear(today.getFullYear()-3); }
  else if (range==='5y') { cutoff=new Date(today); cutoff.setFullYear(today.getFullYear()-5); }
  else if (range==='10y') { cutoff=new Date(today); cutoff.setFullYear(today.getFullYear()-10); }
  const cutoffStr = cutoff ? cutoff.toISOString().slice(0,10) : null;
  const filteredDates = cutoffStr ? dates.filter(d => d >= cutoffStr) : dates;
  if (!filteredDates.length) return { dates: [], values: [], twrValues: [] };

  // Forward-fill prices across the filtered date array
  const filledPrices = {};
  aggSecs.forEach(s => {
    const pm = priceMap[s.ticker];
    let last = null;
    // Pre-warm with any price from before the window
    dates.filter(d => cutoffStr && d < cutoffStr).forEach(d => { if (pm[d]!=null) last=pm[d]; });
    filledPrices[s.ticker] = filteredDates.map(d => { if (pm[d]!=null) last=pm[d]; return last; });
  });

  // Build portfolio value series — only include a security after its purchase date
  const values = filteredDates.map((d, i) => {
    let v = cashValue;
    let anyPriced = cashValue > 0;
    aggSecs.forEach(s => {
      if (s.datePurchased && d < s.datePurchased) return; // not yet purchased
      const px = filledPrices[s.ticker][i];
      if (px != null) { v += px * s.quantity; anyPriced = true; }
    });
    return anyPriced ? v : null;
  });

  // Build TWR series rebased to 100 (strips large cash-flow jumps)
  const twrValues = [];
  let twrBase = null;
  let compound = 1.0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null) { twrValues.push(null); continue; }
    if (twrBase == null) { twrBase = values[i]; twrValues.push(100); continue; }
    if (values[i-1] == null || values[i-1] <= 0) { twrValues.push(twrValues[i-1]||100); continue; }
    const dailyRet = (values[i] - values[i-1]) / values[i-1];
    // Treat jumps >15% as cash flows, carry forward
    if (Math.abs(dailyRet) > 0.15) { twrValues.push(twrValues[i-1]); continue; }
    compound *= (1 + dailyRet);
    twrValues.push(parseFloat((100 * compound).toFixed(4)));
  }

  return { dates: filteredDates, values, twrValues };
}

// ────────── Brinson-Fachler Attribution ──────────
async function brinsonRun() {
  const el = document.getElementById('brinsonResults');
  const elContrib = document.getElementById('brinsonContrib');
  if (!el) return;
  const h = window._holdings || [];
  const isCash = x => ['Cash','Money Market','CD','Bond Position'].includes(x.assetClass);
  const sec = h.filter(x => !isCash(x));
  if (!sec.length) { el.innerHTML = '<p style="color:var(--text-sec);">Add holdings to compute attribution.</p>'; return; }

  el.innerHTML = '<span class="spinner"></span> Running Brinson-Fachler attribution…';
  const lookback = parseInt(document.getElementById('brinsonWindow').value);
  const benchSym = document.getElementById('brinsonBench').value;

  // Sector ETF benchmarks (SPDR sectors)
  const SEC_ETF = {
    'Technology':'XLK', 'Information Technology':'XLK',
    'Energy':'XLE',
    'Financials':'XLF', 'Financial Services':'XLF',
    'Healthcare':'XLV', 'Health Care':'XLV',
    'Industrials':'XLI',
    'Consumer Discretionary':'XLY',
    'Consumer Staples':'XLP', 'Consumer Defensive':'XLP',
    'Utilities':'XLU',
    'Materials':'XLB', 'Basic Materials':'XLB',
    'Real Estate':'XLRE',
    'Communication Services':'XLC', 'Communications':'XLC'
  };
  const SPY_BENCH_WT = { // Approximate S&P 500 GICS sector weights (Q4 2025 reference)
    'Technology': 30.5, 'Financials': 13.5, 'Healthcare': 11.0,
    'Consumer Discretionary': 10.5, 'Communication Services': 9.5,
    'Industrials': 8.5, 'Consumer Staples': 6.0, 'Energy': 3.5,
    'Utilities': 2.5, 'Real Estate': 2.5, 'Materials': 2.0
  };

  try {
    // Compute portfolio sector weights (mv-weighted)
    const tv = sec.reduce((s,x) => s + (x.currentPrice||0)*x.quantity, 0);
    const sectorMV = {};
    sec.forEach(x => { const k = normSector(x.sector); sectorMV[k] = (sectorMV[k]||0) + (x.currentPrice||0)*x.quantity; });

    // Fetch sector ETF returns over lookback + benchmark
    const range = lookback <= 65 ? '3mo' : lookback <= 130 ? '6mo' : '1y';
    const benchData = await fetchChart(benchSym, range, '1d');
    const benchRet = chartReturn(benchData.points, Math.min(lookback, benchData.points.length-1));

    const sectorRets = {};
    const uniqSectors = Object.keys(sectorMV);
    await Promise.all(uniqSectors.map(async k => {
      const etf = SEC_ETF[k];
      if (!etf) { sectorRets[k] = null; return; }
      try {
        const c = await fetchChart(etf, range, '1d');
        sectorRets[k] = chartReturn(c.points, Math.min(lookback, c.points.length-1));
      } catch(e) { sectorRets[k] = null; }
    }));

    // Compute portfolio sector returns (weighted average of holding returns within sector)
    const holdingRets = {};
    await Promise.all(sec.map(async x => {
      try {
        const c = await fetchChart(x.ticker, range, '1d');
        holdingRets[x.ticker] = chartReturn(c.points, Math.min(lookback, c.points.length-1));
      } catch(e) { holdingRets[x.ticker] = null; }
    }));
    const pfSectorRet = {};
    uniqSectors.forEach(k => {
      const inSec = sec.filter(x => normSector(x.sector) === k);
      const totMV = inSec.reduce((s,x) => s + (x.currentPrice||0)*x.quantity, 0);
      let wr = 0, hasData = false;
      inSec.forEach(x => {
        const r = holdingRets[x.ticker];
        if (r != null && totMV > 0) {
          wr += ((x.currentPrice||0)*x.quantity / totMV) * r;
          hasData = true;
        }
      });
      pfSectorRet[k] = hasData ? wr : null;
    });

    // Brinson-Fachler decomposition per sector
    // Allocation_i = (w_p,i - w_b,i) * (R_b,i - R_b)
    // Selection_i  = w_b,i * (R_p,i - R_b,i)
    // Interaction_i = (w_p,i - w_b,i) * (R_p,i - R_b,i)
    const rows = [];
    let totAlloc = 0, totSelect = 0, totInteract = 0;
    uniqSectors.forEach(k => {
      const wp = tv > 0 ? (sectorMV[k] || 0) / tv * 100 : 0;
      const wb = SPY_BENCH_WT[k] || 0;
      const Rb = sectorRets[k];
      const Rp = pfSectorRet[k];
      const Rbench = benchRet != null ? benchRet : 0;
      let alloc = null, sel = null, inter = null;
      if (Rb != null && isFinite(Rb)) alloc = ((wp - wb)/100) * (Rb - Rbench);
      if (Rb != null && Rp != null && isFinite(Rb) && isFinite(Rp)) sel = (wb/100) * (Rp - Rb);
      if (Rb != null && Rp != null && isFinite(Rb) && isFinite(Rp)) inter = ((wp - wb)/100) * (Rp - Rb);
      if (alloc != null && isFinite(alloc)) totAlloc += alloc;
      if (sel != null && isFinite(sel)) totSelect += sel;
      if (inter != null && isFinite(inter)) totInteract += inter;
      rows.push({ sector: k, wp, wb, Rp, Rb, alloc, sel, inter });
    });
    const totalActive = totAlloc + totSelect + totInteract;

    // Render
    const maxAbs = Math.max(0.5,
      ...rows.flatMap(r => [Math.abs(r.alloc||0), Math.abs(r.sel||0), Math.abs(r.inter||0)])
    );
    const barFor = (v) => {
      if (v == null) return '<div class="brinson-bar"><div class="brinson-bar-label" style="color:var(--text-sec);">—</div></div>';
      const w = Math.min(100, Math.abs(v) / maxAbs * 50);
      const left = v >= 0 ? 50 : (50 - w);
      const cls = v >= 0 ? 'pos' : 'neg';
      const sign = v >= 0 ? '+' : '';
      return '<div class="brinson-bar"><div class="brinson-bar-fill '+cls+'" style="left:'+left+'%;width:'+w+'%;"></div><div class="brinson-bar-label">'+sign+v.toFixed(2)+'%</div></div>';
    };

    let html = '<div class="brinson-row header"><div>Sector</div><div>Allocation</div><div class="brinson-col-3">Selection</div><div class="brinson-col-4">Interaction</div><div>Total Effect</div></div>';
    rows.sort((a,b) => Math.abs((b.alloc||0)+(b.sel||0)+(b.inter||0)) - Math.abs((a.alloc||0)+(a.sel||0)+(a.inter||0)));
    rows.forEach(r => {
      const tot = (r.alloc||0) + (r.sel||0) + (r.inter||0);
      html += '<div class="brinson-row">'+
        '<div style="font-weight:700;color:var(--navy);font-size:11px;">'+r.sector+'<br><span style="font-weight:400;color:var(--text-sec);font-size:10px;">w<sub>p</sub>='+r.wp.toFixed(1)+'% w<sub>b</sub>='+r.wb.toFixed(1)+'%</span></div>'+
        '<div>'+barFor(r.alloc)+'</div>'+
        '<div class="brinson-col-3">'+barFor(r.sel)+'</div>'+
        '<div class="brinson-col-4">'+barFor(r.inter)+'</div>'+
        '<div>'+barFor(tot)+'</div>'+
        '</div>';
    });
    html += '<div class="brinson-row" style="background:var(--navy);color:#fff;border-radius:3px;padding:10px 8px;margin-top:8px;font-weight:700;">'+
      '<div>TOTAL ACTIVE RETURN</div>'+
      '<div style="font-family:Courier New,monospace;text-align:right;">'+(totAlloc>=0?'+':'')+totAlloc.toFixed(2)+'%</div>'+
      '<div class="brinson-col-3" style="font-family:Courier New,monospace;text-align:right;">'+(totSelect>=0?'+':'')+totSelect.toFixed(2)+'%</div>'+
      '<div class="brinson-col-4" style="font-family:Courier New,monospace;text-align:right;">'+(totInteract>=0?'+':'')+totInteract.toFixed(2)+'%</div>'+
      '<div style="font-family:Courier New,monospace;text-align:right;">'+(totalActive>=0?'+':'')+totalActive.toFixed(2)+'%</div>'+
      '</div>';
    html += '<p style="font-size:11px;color:var(--text-sec);margin-top:10px;line-height:1.5;"><strong>Reading the table.</strong> <strong>Allocation</strong> measures whether your sector tilt vs. '+benchSym+' added value (overweight a strong sector, underweight a weak one). <strong>Selection</strong> measures whether your picks within each sector beat the sector benchmark (XLK for Tech, XLE for Energy, etc.). <strong>Interaction</strong> is a cross-effect — being overweight in a sector where your picks also outperformed.</p>';
    el.innerHTML = html;

    // ── Grouped bar chart: Allocation / Selection / Interaction per sector ──
    var brinsonChartWrap = document.getElementById('brinsonChartWrap');
    var brinsonCtx = document.getElementById('brinsonChart');
    if (brinsonCtx && rows.length) {
      if (window._brinsonChart) { try { window._brinsonChart.destroy(); } catch(e2){} }
      if (brinsonChartWrap) brinsonChartWrap.style.display = '';
      window._brinsonChart = new Chart(brinsonCtx.getContext('2d'), {
        type: 'bar',
        data: {
          labels: rows.map(function(r){ return r.sector; }),
          datasets: [
            { label: 'Allocation',   data: rows.map(function(r){ return r.alloc  != null ? parseFloat(r.alloc.toFixed(3))  : 0; }), backgroundColor: 'rgba(0,60,113,0.78)',   borderWidth: 0 },
            { label: 'Selection',    data: rows.map(function(r){ return r.sel    != null ? parseFloat(r.sel.toFixed(3))    : 0; }), backgroundColor: 'rgba(46,125,82,0.78)',  borderWidth: 0 },
            { label: 'Interaction',  data: rows.map(function(r){ return r.inter  != null ? parseFloat(r.inter.toFixed(3))  : 0; }), backgroundColor: 'rgba(139,100,20,0.78)', borderWidth: 0 }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          plugins: {
            legend: { position: 'top', labels: { font: { size: 11 }, color: '#1A2733' } },
            tooltip: { callbacks: { label: function(c){ return c.dataset.label+': '+(c.parsed.y>=0?'+':'')+c.parsed.y.toFixed(2)+'%'; } } }
          },
          scales: {
            x: { ticks: { font: { size: 10 }, maxRotation: 35 }, grid: { display: false } },
            y: {
              ticks: { callback: function(v){ return (v>=0?'+':'')+v.toFixed(2)+'%'; }, font: { size: 10 } },
              title: { display: true, text: 'Active Return (%)', font: { size: 11 }, color: '#5A6772' }
            }
          }
        }
      });
    }

    // Per-position contribution
    let cHtml = '<table style="width:100%;border-collapse:collapse;font-size:12px;font-family:Arial;">';
    cHtml += '<thead><tr style="background:var(--navy);color:#fff;">'+
      '<th style="padding:8px;text-align:left;">Ticker</th>'+
      '<th style="padding:8px;text-align:left;">Sector</th>'+
      '<th style="padding:8px;text-align:right;">Weight</th>'+
      '<th style="padding:8px;text-align:right;">Position Return</th>'+
      '<th style="padding:8px;text-align:right;">Sector Return (Bench)</th>'+
      '<th style="padding:8px;text-align:right;">Contribution to Active</th></tr></thead><tbody>';
    const contribRows = sec.map(x => {
      const r = holdingRets[x.ticker];
      const k = normSector(x.sector);
      const Rb = sectorRets[k];
      const w = tv > 0 ? (x.currentPrice||0)*x.quantity / tv : 0;
      const contrib = r != null && Rb != null ? w * (r - Rb) : null;
      return { ticker: x.ticker, sector: k, w, r, Rb, contrib };
    }).sort((a,b) => Math.abs(b.contrib||0) - Math.abs(a.contrib||0));
    contribRows.slice(0, 15).forEach(c => {
      const fmt = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
      const col = v => v == null ? 'var(--text-sec)' : v >= 0 ? 'var(--success)' : 'var(--danger)';
      cHtml += '<tr style="border-bottom:1px solid var(--border-light,#E5E9EF);">'+
        '<td style="padding:6px 8px;font-weight:700;color:var(--navy);">'+c.ticker+'</td>'+
        '<td style="padding:6px 8px;color:var(--text-sec);">'+c.sector+'</td>'+
        '<td style="padding:6px 8px;text-align:right;font-family:Courier New,monospace;">'+(c.w*100).toFixed(1)+'%</td>'+
        '<td style="padding:6px 8px;text-align:right;font-family:Courier New,monospace;color:'+col(c.r)+';">'+fmt(c.r)+'</td>'+
        '<td style="padding:6px 8px;text-align:right;font-family:Courier New,monospace;color:var(--text-sec);">'+fmt(c.Rb)+'</td>'+
        '<td style="padding:6px 8px;text-align:right;font-family:Courier New,monospace;font-weight:700;color:'+col(c.contrib)+';">'+fmt(c.contrib)+'</td></tr>';
    });
    cHtml += '</tbody></table>';
    if (elContrib) { elContrib.innerHTML = cHtml; elContrib.style.display = ''; }
  } catch(e) {
    el.innerHTML = '<p style="color:var(--danger);">Attribution failed: '+e.message+'</p>';
  }
}
function normSector(s) {
  if (!s) return 'Other';
  const m = {
    'Information Technology':'Technology', 'Tech':'Technology',
    'Financial Services':'Financials',
    'Health Care':'Healthcare',
    'Consumer Defensive':'Consumer Staples',
    'Basic Materials':'Materials',
    'Communications':'Communication Services'
  };
  return m[s] || s;
}

// ────────── Risk tab ──────────
async function pfRenderRisk() {
  const h = window._holdings || [];
  if (!h.length) return;
  try {
    const series = await pfBuildValueSeries('1y');
    if (!series.values.length || series.values.length < 10) {
      ['kpiVaR95','kpiVaR99','kpiCVaR','kpiVol','kpiMDD','kpiBeta','kpiSharpe','kpiActShare'].forEach(id => {
        const e = document.getElementById(id); if (e) e.textContent = 'n/a';
      });
      return;
    }
    const rets = dailyLogReturns(series.values);
    if (rets.length < 20) {
      ['kpiVaR95','kpiVaR99','kpiCVaR','kpiVol','kpiMDD','kpiBeta','kpiSharpe','kpiActShare'].forEach(id => {
        const e = document.getElementById(id); if (e) e.textContent = 'n/a';
      });
      return;
    }
    const sortedR = rets.slice().sort((a,b)=>a-b);
    const tv = series.values[series.values.length-1];
    const mean = rets.reduce((s,v)=>s+v,0)/rets.length;
    const variance = rets.reduce((s,v)=>s+(v-mean)*(v-mean),0)/(rets.length-1);
    const sigma = Math.sqrt(variance); // daily sigma (log return)

    // Historical 95% VaR (1-day) — floor at 5th percentile loss
    // VaR is expressed as a positive dollar loss number
    const idx95 = Math.max(0, Math.floor(sortedR.length * 0.05) - 1);
    const var95LogRet = sortedR[idx95]; // negative log return
    const var95Dol = Math.max(0, -var95LogRet * tv); // positive loss
    document.getElementById('kpiVaR95').textContent = '$' + Math.round(var95Dol).toLocaleString();

    // Parametric 99% VaR: VaR = -(μ - z*σ) × TV
    // z_0.99 = 2.326 for one-tailed 99%
    const var99LogRet = mean - 2.326 * sigma;
    const var99Dol = Math.max(0, -var99LogRet * tv);
    document.getElementById('kpiVaR99').textContent = '$' + Math.round(var99Dol).toLocaleString();

    // CVaR (Expected Shortfall) at 95% — average of worst 5% days
    const tail = sortedR.slice(0, idx95 + 1);
    const cvarLogRet = tail.reduce((s,v)=>s+v,0) / Math.max(tail.length, 1);
    const cvarDol = Math.max(0, -cvarLogRet * tv);
    document.getElementById('kpiCVaR').textContent = '$' + Math.round(cvarDol).toLocaleString();

    // Annualized vol (log returns × √252 × 100)
    const volAnn = sigma * Math.sqrt(252) * 100;
    document.getElementById('kpiVol').textContent = volAnn.toFixed(1) + '%';

    // Max drawdown — track peak-to-trough properly
    let peak = series.values[0], maxDD = 0;
    for (let i = 1; i < series.values.length; i++) {
      if (series.values[i] > peak) peak = series.values[i];
      if (peak > 0) {
        const dd = (series.values[i] - peak) / peak;
        if (dd < maxDD) maxDD = dd;
      }
    }
    document.getElementById('kpiMDD').textContent = (maxDD * 100).toFixed(1) + '%';

    // Beta vs SPY and Sharpe
    try {
      const spy = await fetchChart('SPY', '1y', '1d');
      const spyR = chartLogReturns(spy.points);
      const minLen = Math.min(rets.length, spyR.length);
      if (minLen >= 30) {
        const a = rets.slice(-minLen), b = spyR.slice(-minLen);
        const ma = a.reduce((s,v)=>s+v,0)/a.length, mb = b.reduce((s,v)=>s+v,0)/b.length;
        let cov = 0, varB = 0;
        for (let i = 0; i < minLen; i++) { cov += (a[i]-ma)*(b[i]-mb); varB += (b[i]-mb)*(b[i]-mb); }
        cov /= (minLen - 1); varB /= (minLen - 1);
        const beta = varB > 0 ? cov / varB : 0;
        document.getElementById('kpiBeta').textContent = beta.toFixed(2);

        // Sharpe = (annualized arithmetic return − RF) / annualized vol
        // Daily arithmetic mean = exp(μ_log + σ²/2) − 1 ≈ μ_log + σ²/2
        const dailyArithMean = mean + variance / 2;
        const annArithR = dailyArithMean * 252;
        const annVol = sigma * Math.sqrt(252);
        const rf = 0.045; // 4.5% risk-free
        const sharpe = annVol > 0 ? (annArithR - rf) / annVol : 0;
        document.getElementById('kpiSharpe').textContent = sharpe.toFixed(2);
      }
    } catch(e) { document.getElementById('kpiBeta').textContent = 'n/a'; document.getElementById('kpiSharpe').textContent = 'n/a'; }

    // Active Share — sum of |w_p - w_b|/2; we approximate using SPY top weights
    // For non-SPY tickers, treat w_b=0 and w_p contributes fully
    const isCash = x => ['Cash','Money Market','CD','Bond Position'].includes(x.assetClass);
    const sec = h.filter(x => !isCash(x));
    const totMV = sec.reduce((s,x) => s + (x.currentPrice||0)*x.quantity, 0);
    // Simplified: treat as 1 - sum of overlap with SPY; SPY top 50 covers ~60% of weight
    // Use a heuristic: if portfolio has many small/non-SPY positions, active share is high
    const SPY_TOP = ['AAPL','MSFT','NVDA','AMZN','META','GOOGL','GOOG','TSLA','BRK.B','JPM','LLY','V','XOM','UNH','MA','AVGO','PG','HD','JNJ','MRK'];
    let overlap = 0;
    sec.forEach(x => {
      const wp = totMV > 0 ? (x.currentPrice||0)*x.quantity / totMV : 0;
      if (SPY_TOP.includes(x.ticker)) overlap += Math.min(wp, 0.06); // cap at typical SPY weight
    });
    const activeShare = (1 - overlap) * 100;
    document.getElementById('kpiActShare').textContent = activeShare.toFixed(0) + '%';

    // Marginal VaR table
    const mvarEl = document.getElementById('mvarTable');
    if (mvarEl) {
      mvarEl.innerHTML = '<span class="spinner"></span> Computing marginal VaR…';
      const mvarRows = [];
      for (const x of sec) {
        try {
          const c = await fetchChart(x.ticker, '1y', '1d');
          const r = chartLogReturns(c.points);
          const n = Math.min(r.length, rets.length);
          if (n < 30) continue;
          const a = r.slice(-n), b = rets.slice(-n);
          const ma = a.reduce((s,v)=>s+v,0)/n, mb = b.reduce((s,v)=>s+v,0)/n;
          let cov = 0;
          for (let i = 0; i < n; i++) cov += (a[i]-ma)*(b[i]-mb);
          cov /= (n-1);
          const w = totMV > 0 ? (x.currentPrice||0)*x.quantity / totMV : 0;
          // Marginal VaR = w_i × (cov(R_i, R_p) / σ_p) × z_0.95
          // sigma here is daily sigma of portfolio log returns
          const mvar = sigma > 0 ? w * (cov / sigma) * 1.645 : 0;
          mvarRows.push({ ticker: x.ticker, w, mvar, mvarDol: mvar * tv });
        } catch(e) {}
      }
      mvarRows.sort((a,b) => Math.abs(b.mvar) - Math.abs(a.mvar));
      let mh = '<table style="width:100%;border-collapse:collapse;font-size:12px;font-family:Arial;">';
      mh += '<thead><tr style="background:var(--navy);color:#fff;">'+
        '<th style="padding:8px;text-align:left;">Ticker</th>'+
        '<th style="padding:8px;text-align:right;">Weight</th>'+
        '<th style="padding:8px;text-align:right;">Marginal VaR (%)</th>'+
        '<th style="padding:8px;text-align:right;">Marginal VaR ($)</th></tr></thead><tbody>';
      mvarRows.slice(0, 10).forEach(r => {
        mh += '<tr style="border-bottom:1px solid var(--border-light,#E5E9EF);">'+
          '<td style="padding:6px 8px;font-weight:700;color:var(--navy);">'+r.ticker+'</td>'+
          '<td style="padding:6px 8px;text-align:right;font-family:Courier New,monospace;">'+(r.w*100).toFixed(1)+'%</td>'+
          '<td style="padding:6px 8px;text-align:right;font-family:Courier New,monospace;font-weight:700;">'+(r.mvar*100).toFixed(3)+'%</td>'+
          '<td style="padding:6px 8px;text-align:right;font-family:Courier New,monospace;color:'+(r.mvar>=0?'var(--danger)':'var(--success)')+';">$'+Math.round(r.mvarDol).toLocaleString()+'</td></tr>';
      });
      mh += '</tbody></table>';
      mvarEl.innerHTML = mh;
    }

    // Styled risk metrics detail
    var rmdEl = document.getElementById('riskMetricsDetail');
    if (rmdEl) {
      var sharpeVal = 0, sortinoVal = 0, betaVal = 1;
      // Try to read computed values from KPI elements
      var kpiSharpeEl = document.getElementById('kpiSharpe');
      var kpiBetaEl = document.getElementById('kpiBeta');
      if (kpiSharpeEl && kpiSharpeEl.textContent !== '—' && kpiSharpeEl.textContent !== 'n/a') sharpeVal = parseFloat(kpiSharpeEl.textContent) || 0;
      if (kpiBetaEl && kpiBetaEl.textContent !== '—' && kpiBetaEl.textContent !== 'n/a') betaVal = parseFloat(kpiBetaEl.textContent) || 1;
      var var95PctVal = sigma > 0 ? Math.abs(var95LogRet) * 100 : 0;
      var volAnnVal = sigma * Math.sqrt(252) * 100;
      var maxDDPct = Math.abs(maxDD) * 100;
      // Sortino: downside deviation
      var downRets = rets.filter(function(v){ return v < 0; });
      var downVar = downRets.length > 1 ? downRets.reduce(function(s,v){ return s + v*v; }, 0) / downRets.length : 0;
      var downSigma = Math.sqrt(downVar);
      var annArithMean2 = (mean + variance/2) * 252;
      sortinoVal = downSigma > 0 ? (annArithMean2 - 0.045) / (downSigma * Math.sqrt(252)) : 0;

      // Comparative render: same metrics computed for SPY and QQQ over the
      // same 1-year window, side by side — a number means nothing without
      // its benchmark (redesigned 2026-07).
      rmdEl.innerHTML = '<div style="color:var(--text-sec);font-size:12px;"><span class="spinner"></span> Comparing against SPY and QQQ…</div>';
      (async function renderRmdComparison() {
        var pfM = { sharpe: sharpeVal, sortino: sortinoVal, maxDD: maxDDPct, var95: var95PctVal, vol: volAnnVal, beta: betaVal };
        var idxM = { SPY: null, QQQ: null };
        try {
          var HISTc = await PerryData.getMany(['SPY','QQQ'], 2);
          ['SPY','QQQ'].forEach(function(sym) {
            var hh = HISTc[sym]; if (!hh || hh.closes.length < 260) return;
            var cl = hh.closes.slice(-253);
            var rr = []; for (var q = 1; q < cl.length; q++) rr.push(cl[q]/cl[q-1]-1);
            var mn = rr.reduce(function(s,v){return s+v;},0)/rr.length;
            var vr = rr.reduce(function(s,v){return s+(v-mn)*(v-mn);},0)/(rr.length-1);
            var sd = Math.sqrt(vr);
            var dn = rr.filter(function(v){return v<0;});
            var dnSd = Math.sqrt(dn.length>1 ? dn.reduce(function(s,v){return s+v*v;},0)/dn.length : 0);
            var pk = cl[0], mdd = 0;
            cl.forEach(function(v){ if (v>pk) pk=v; var dd=(pk-v)/pk; if (dd>mdd) mdd=dd; });
            idxM[sym] = {
              sharpe: sd>0 ? (mn - 0.05/252)/sd*Math.sqrt(252) : 0,
              sortino: dnSd>0 ? ((mn*252) - 0.045)/(dnSd*Math.sqrt(252)) : 0,
              maxDD: mdd*100, var95: 1.645*sd*100, vol: sd*Math.sqrt(252)*100,
              beta: sym === 'SPY' ? 1.0 : null
            };
          });
          // QQQ beta vs SPY
          if (HISTc.QQQ && HISTc.SPY && idxM.QQQ) {
            var qc = HISTc.QQQ.closes.slice(-253), sc = HISTc.SPY.closes.slice(-253);
            var n2 = Math.min(qc.length, sc.length);
            var qr=[], sr=[];
            for (var w2=1; w2<n2; w2++){ qr.push(qc[w2]/qc[w2-1]-1); sr.push(sc[w2]/sc[w2-1]-1); }
            var mq=qr.reduce(function(s,v){return s+v;},0)/qr.length, ms=sr.reduce(function(s,v){return s+v;},0)/sr.length;
            var cv=0, vs=0;
            for (var w3=0; w3<qr.length; w3++){ cv+=(qr[w3]-mq)*(sr[w3]-ms); vs+=(sr[w3]-ms)*(sr[w3]-ms); }
            idxM.QQQ.beta = vs>0 ? cv/vs : null;
          }
        } catch(e) {}
        var defs = [
          { key:'sharpe', label:'Sharpe Ratio', fmt:function(v){return v.toFixed(2);}, higher:true, help:'sharpe' },
          { key:'sortino', label:'Sortino Ratio', fmt:function(v){return v.toFixed(2);}, higher:true, help:'sharpe' },
          { key:'vol', label:'Ann. Volatility', fmt:function(v){return v.toFixed(1)+'%';}, higher:false, help:'sharpe' },
          { key:'maxDD', label:'Max Drawdown', fmt:function(v){return '-'+v.toFixed(1)+'%';}, higher:false, help:'maxDrawdown' },
          { key:'var95', label:'VaR (95%, 1-day)', fmt:function(v){return v.toFixed(2)+'%';}, higher:false, help:'var95' },
          { key:'beta', label:'Beta vs SPY', fmt:function(v){return v.toFixed(2);}, higher:null, help:'beta' }
        ];
        var hh2 = '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;">'
          + '<thead><tr><th style="padding:8px 10px;text-align:left;">Metric</th><th style="padding:8px 10px;text-align:right;">Your Portfolio</th><th style="padding:8px 10px;text-align:right;">SPY</th><th style="padding:8px 10px;text-align:right;">QQQ</th><th style="padding:8px 10px;text-align:left;">Read</th></tr></thead><tbody>';
        defs.forEach(function(d) {
          var pv = pfM[d.key], sv = idxM.SPY ? idxM.SPY[d.key] : null, qv = idxM.QQQ ? idxM.QQQ[d.key] : null;
          var verdict = '', vc = 'var(--text-sec)';
          if (d.higher !== null && pv != null && sv != null) {
            var better = d.higher ? pv > sv : pv < sv;
            verdict = better ? 'Better than SPY' : 'Worse than SPY';
            vc = better ? 'var(--success)' : 'var(--danger)';
          } else if (d.key === 'beta' && pv != null) {
            verdict = pv > 1.2 ? 'Amplified market risk' : pv < 0.8 ? 'Defensive vs market' : 'Market-like';
            vc = pv > 1.2 ? '#8B6914' : 'var(--text-sec)';
          }
          hh2 += '<tr style="border-bottom:1px solid var(--border);">'
            + '<td style="padding:7px 10px;font-weight:600;color:var(--navy);">'+d.label+' <span class="help-icon" data-help="'+d.help+'">ⓘ</span></td>'
            + '<td style="padding:7px 10px;text-align:right;font-family:monospace;font-weight:700;">'+(pv!=null?d.fmt(pv):'—')+'</td>'
            + '<td style="padding:7px 10px;text-align:right;font-family:monospace;color:var(--text-sec);">'+(sv!=null?d.fmt(sv):'—')+'</td>'
            + '<td style="padding:7px 10px;text-align:right;font-family:monospace;color:var(--text-sec);">'+(qv!=null?d.fmt(qv):'—')+'</td>'
            + '<td style="padding:7px 10px;font-size:11px;font-weight:600;color:'+vc+';">'+verdict+'</td></tr>';
        });
        hh2 += '</tbody></table></div><div style="font-size:10.5px;color:var(--text-sec);margin-top:6px;">All figures computed over the same trailing 1-year daily window. SPY/QQQ series via the PerryData layer.</div>';
        rmdEl.innerHTML = hh2;
      })();
    }

    // Render correlation heatmap
    if (typeof renderRiskHeatmap === 'function') renderRiskHeatmap();

  } catch(e) {
    console.error('Risk tab error:', e);
  }
}

// ────────── Portfolio vs Market Rolling Correlation (redesigned 2026-07) ──
// Replaces the pairwise top-holdings heatmap (which double-counted the same
// ticker held in multiple accounts). Answers: is my portfolio becoming more
// or less correlated with the market over time — and did high correlation
// pay me better or worse returns?
var _riskCorrChart = null;
var _riskCorrBusy = false;
async function renderRiskHeatmap() {
  var insightEl = document.getElementById('riskCorrInsight');
  var canvasEl = document.getElementById('riskCorrChart');
  if (!canvasEl || _riskCorrBusy) return;
  _riskCorrBusy = true;
  // v3 (2026-07): computed SERVER-SIDE by the worker /portfolio-correlation
  // endpoint and persisted to Firestore — one GET, no client-side data
  // assembly to fail. The v2 client path below remains only as a fallback.
  if (typeof renderRiskCorrV3 === 'function') {
    try { await renderRiskCorrV3(insightEl, canvasEl); }
    catch (e3) { if (insightEl) insightEl.innerHTML = '<span style="color:var(--danger);">Correlation failed: ' + e3.message + ' <button class="btn btn-sm" onclick="renderRiskHeatmap()">Retry</button></span>'; }
    _riskCorrBusy = false;
    return;
  }
  if (insightEl) insightEl.innerHTML = '<span class="spinner"></span> Computing rolling correlation vs SPY and QQQ…';
  try {
    if (!window._holdings || !window._holdings.length) {
      if (insightEl) insightEl.innerHTML = '<span style="color:var(--text-sec);">Add holdings to compute portfolio-vs-market correlation.</span>';
      _riskCorrBusy = false; return;
    }
    var pfRetByDate = {};
    var proxyNote = '';
    // Path 1: actual reconstructed portfolio series (TWR, deposit-proof)
    var pf = null;
    try { pf = await pfBuildValueSeries('1y'); } catch(ePf) { pf = null; }
    if (pf && pf.dates && pf.dates.length >= 90) {
      var perfSeries = (pf.twrValues && pf.twrValues.length === pf.values.length && pf.twrValues.every(function(v){return v!=null&&v>0;})) ? pf.twrValues : pf.values;
      for (var i = 1; i < pf.dates.length; i++) {
        if (perfSeries[i] != null && perfSeries[i-1] != null && perfSeries[i-1] > 0) pfRetByDate[pf.dates[i]] = perfSeries[i]/perfSeries[i-1] - 1;
      }
    } else {
      // Path 2 (fallback — guarantees the chart ALWAYS computes): current-
      // composition proxy. Take today's weights, weight each holding's own
      // 1-year daily returns. Standard "current portfolio backtest" method.
      var isCashR = function(x){ return ['Cash','Money Market','CD','Bond Position'].includes(x.assetClass); };
      var byT = {};
      (window._holdings||[]).forEach(function(x){
        if (isCashR(x)) return;
        var t = String(x.ticker).toUpperCase();
        byT[t] = (byT[t]||0) + (x.currentPrice||x.costBasis||0)*x.quantity;
      });
      var tks = Object.keys(byT).sort(function(a,b){ return byT[b]-byT[a]; }).slice(0, 12);
      var totW = tks.reduce(function(s,t){ return s+byT[t]; }, 0) || 1;
      var HISTp = await PerryData.getMany(tks, 3);
      var retMaps = {};
      tks.forEach(function(t){
        var hh = HISTp[t]; if (!hh) return;
        var m = {};
        for (var j2 = Math.max(1, hh.dates.length-300); j2 < hh.dates.length; j2++) {
          if (hh.closes[j2-1] > 0) m[hh.dates[j2]] = hh.closes[j2]/hh.closes[j2-1] - 1;
        }
        retMaps[t] = m;
      });
      // Portfolio return per date = Σ w_i × r_i (renormalized over tickers with data)
      var dateSet = {};
      Object.keys(retMaps).forEach(function(t){ Object.keys(retMaps[t]).forEach(function(d2){ dateSet[d2]=1; }); });
      Object.keys(dateSet).sort().forEach(function(d2){
        var num = 0, den = 0;
        tks.forEach(function(t){ var r = retMaps[t] && retMaps[t][d2]; if (r != null) { num += byT[t]*r; den += byT[t]; } });
        if (den > totW*0.5) pfRetByDate[d2] = num/den;   // require half the book priced that day
      });
      proxyNote = ' <span style="color:#8B6914;">(current-composition proxy: today\'s weights applied to each holding\'s 1-year history — used because the reconstructed portfolio series is under 4 months)</span>';
    }
    var HIST = await PerryData.getMany(['SPY','QQQ'], 2);
    function idxRets(h) {
      var m = {};
      if (!h) return m;
      for (var j = 1; j < h.dates.length; j++) { if (h.closes[j-1] > 0) m[h.dates[j]] = h.closes[j]/h.closes[j-1] - 1; }
      return m;
    }
    var spyRet = idxRets(HIST.SPY), qqqRet = idxRets(HIST.QQQ);
    // Common dates (works for both the actual-series and proxy paths)
    var dates = Object.keys(pfRetByDate).sort().filter(function(d){ return spyRet[d] != null; });
    if (dates.length < 70) { if (insightEl) insightEl.innerHTML = '<span style="color:var(--text-sec);">Not enough overlapping history yet ('+dates.length+' common trading days — need ~70). This fills in automatically as data accumulates.</span>'; _riskCorrBusy = false; return; }
    var pfArr = dates.map(function(d){ return pfRetByDate[d]; });
    var spyArr = dates.map(function(d){ return spyRet[d]; });
    var qqqArr = dates.map(function(d){ return qqqRet[d] != null ? qqqRet[d] : 0; });
    function rollCorr(a, b, w, idx) {
      var s = idx - w + 1; if (s < 0) return null;
      var ma=0, mb=0; for (var k=s;k<=idx;k++){ ma+=a[k]; mb+=b[k]; } ma/=w; mb/=w;
      var num=0, da=0, db=0;
      for (var k2=s;k2<=idx;k2++){ var xa=a[k2]-ma, xb=b[k2]-mb; num+=xa*xb; da+=xa*xa; db+=xb*xb; }
      return (da>0&&db>0) ? num/Math.sqrt(da*db) : null;
    }
    var W = Math.min(63, Math.floor(dates.length / 2));   // adapt window to available history
    var corrSpy = [], corrQqq = [], labels = [];
    for (var ci = W-1; ci < dates.length; ci++) {
      labels.push(dates[ci]);
      corrSpy.push(rollCorr(pfArr, spyArr, W, ci));
      corrQqq.push(rollCorr(pfArr, qqqArr, W, ci));
    }
    if (_riskCorrChart) { try { _riskCorrChart.destroy(); } catch(e){} }
    var MO3b = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    _riskCorrChart = new Chart(canvasEl.getContext('2d'), {
      type: 'line',
      data: { labels: labels, datasets: [
        { label: 'Correlation vs SPY', data: corrSpy, borderColor: C.navy, borderWidth: 2, pointRadius: 0, tension: 0.25, fill: false },
        { label: 'Correlation vs QQQ', data: corrQqq, borderColor: C.blue, borderWidth: 1.5, borderDash: [4,3], pointRadius: 0, tension: 0.25, fill: false }
      ]},
      options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'top', labels: { font: { size: 11 } } },
          tooltip: Object.assign({}, chartTooltip, { callbacks: { label: function(c){ return c.dataset.label+': '+(c.parsed.y!=null?c.parsed.y.toFixed(2):'—'); } } }) },
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, font: { size: 10 }, callback: function(v){ var d=this.getLabelForValue(v)||''; return d.length>=7?MO3b[parseInt(d.slice(5,7),10)-1]+" '"+d.slice(2,4):d; } } },
                  y: { min: -0.2, max: 1, grid: chartGrid, ticks: { font: { size: 10 } } } } }
    });
    // ── Insight: did high correlation pay? Split days by trailing corr regime ──
    var hi = { pf: [], spy: [] }, lo = { pf: [], spy: [] };
    for (var di = 0; di < corrSpy.length; di++) {
      var cval = corrSpy[di];
      if (cval == null) continue;
      var dayIdx = di + W - 1;
      if (dayIdx + 1 >= dates.length) break;
      // NEXT day's return, classified by today's correlation regime (no lookahead)
      var bucket = cval >= 0.8 ? hi : lo;
      bucket.pf.push(pfArr[dayIdx + 1]); bucket.spy.push(spyArr[dayIdx + 1]);
    }
    function annRetOf(arr) { if (!arr.length) return null; var c = 1; arr.forEach(function(r){ c *= (1+r); }); return (Math.pow(c, 252/arr.length) - 1) * 100; }
    var hiPf = annRetOf(hi.pf), hiSpy = annRetOf(hi.spy), loPf = annRetOf(lo.pf), loSpy = annRetOf(lo.spy);
    var curCorr = corrSpy[corrSpy.length-1];
    var trend = corrSpy.length > 21 && corrSpy[corrSpy.length-22] != null ? curCorr - corrSpy[corrSpy.length-22] : null;
    function box(title, ret, alpha, n) {
      return '<div style="flex:1;min-width:200px;border:1px solid var(--border);border-radius:6px;padding:10px 14px;">'
        + '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;color:var(--text-sec);">'+title+'</div>'
        + '<div style="font-size:17px;font-weight:800;color:'+(ret!=null&&ret>=0?'var(--success)':'var(--danger)')+';">'+(ret!=null?(ret>=0?'+':'')+ret.toFixed(1)+'% ann.':'—')+'</div>'
        + '<div style="font-size:11px;color:var(--text-sec);">'+(alpha!=null?('vs SPY same days: '+(alpha>=0?'+':'')+alpha.toFixed(1)+'pp'):'')+' · '+n+' days</div></div>';
    }
    if (insightEl) {
      insightEl.innerHTML = '<div style="margin-bottom:8px;">Current correlation vs SPY (rolling '+W+'-day): <strong style="color:var(--navy);font-size:14px;">'+(curCorr!=null?curCorr.toFixed(2):'—')+'</strong>'+proxyNote
        + (trend!=null ? ' <span style="color:'+(trend>=0?'#8B6914':'var(--success)')+';font-weight:600;">('+(trend>=0?'▲ rising':'▼ falling')+' '+Math.abs(trend).toFixed(2)+' over the last month)</span>' : '')
        + (curCorr!=null && curCorr>0.9 ? ' — <span style="color:#8B6914;">you are effectively holding the index with extra steps; your stock picks are adding risk but little differentiation.</span>' : '')
        + '</div>'
        + '<div style="display:flex;gap:10px;flex-wrap:wrap;">'
        + box('When correlation was HIGH (>0.80)', hiPf, hiPf!=null&&hiSpy!=null?hiPf-hiSpy:null, hi.pf.length)
        + box('When correlation was LOWER (<0.80)', loPf, loPf!=null&&loSpy!=null?loPf-loSpy:null, lo.pf.length)
        + '</div>'
        + '<div style="font-size:11px;color:var(--text-sec);margin-top:6px;">'
        + ((hiPf!=null&&loPf!=null) ? (loPf>hiPf ? 'Your differentiated (lower-correlation) stretches have OUTPERFORMED your index-hugging stretches — your active bets are earning their risk.' : 'Your index-hugging stretches have outperformed your differentiated ones — your active bets have cost you money vs. simply holding the index.') : 'Not enough days in one of the regimes for a fair comparison yet.')
        + '</div>';
    }
  } catch(e) {
    if (insightEl) insightEl.innerHTML = '<span style="color:var(--danger);">Correlation analysis failed: '+e.message+' <button class="btn btn-sm" onclick="renderRiskHeatmap()">Retry</button></span>';
  }
  _riskCorrBusy = false;
}

// ────────── Characteristics tab ──────────
async function pfRenderCharacteristics() {
  const el = document.getElementById('pfCharacteristics');
  if (!el) return;
  const h = window._holdings || [];
  if (!h.length) { el.innerHTML = '<p style="color:var(--text-sec);padding:12px;">Add holdings to see portfolio characteristics.</p>'; return; }
  el.innerHTML = '<div style="padding:16px;text-align:center;"><span class="spinner"></span> Loading characteristics…</div>';
  const isCash = x => ['Cash','Money Market','CD','Bond Position'].includes(x.assetClass);
  const sec = h.filter(x => !isCash(x));
  if (!sec.length) { el.innerHTML = '<p>No security positions.</p>'; return; }
  const totMV = sec.reduce((s,x) => s + (x.currentPrice||0)*x.quantity, 0);

  // Style/cap mix
  const capCounts = {}; const sectorCounts = {};
  sec.forEach(x => {
    const c = x.mktCapCategory || 'Unknown';
    const s = normSector(x.sector || 'Other');
    const w = totMV > 0 ? (x.currentPrice||0)*x.quantity / totMV : 0;
    capCounts[c] = (capCounts[c]||0) + w;
    sectorCounts[s] = (sectorCounts[s]||0) + w;
  });
  // Weighted yield
  const wYield = sec.reduce((s,x) => {
    const w = totMV > 0 ? (x.currentPrice||0)*x.quantity / totMV : 0;
    return s + w * (parseFloat(x.yieldPct)||0);
  }, 0);
  // Cash drag
  const cashMV = h.filter(isCash).reduce((s,x) => s + x.costBasis*x.quantity, 0);
  const totalAll = totMV + cashMV;
  const cashPct = totalAll > 0 ? cashMV / totalAll * 100 : 0;

  let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;">';
  html += '<div style="background:var(--panel);border:1px solid var(--border);padding:12px;border-radius:4px;">'+
    '<div style="font-size:10px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Weighted Avg Yield</div>'+
    '<div style="font-size:22px;font-weight:700;font-family:Courier New,monospace;color:var(--navy);">'+wYield.toFixed(2)+'%</div>'+
    '<div style="font-size:11px;color:var(--text-sec);">SPY ~1.3% (Q4 2025)</div></div>';
  html += '<div style="background:var(--panel);border:1px solid var(--border);padding:12px;border-radius:4px;">'+
    '<div style="font-size:10px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Cash Allocation</div>'+
    '<div style="font-size:22px;font-weight:700;font-family:Courier New,monospace;color:var(--navy);">'+cashPct.toFixed(1)+'%</div>'+
    '<div style="font-size:11px;color:var(--text-sec);">Cash & equivalents</div></div>';
  html += '<div style="background:var(--panel);border:1px solid var(--border);padding:12px;border-radius:4px;">'+
    '<div style="font-size:10px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Position Count</div>'+
    '<div style="font-size:22px;font-weight:700;font-family:Courier New,monospace;color:var(--navy);">'+sec.length+'</div>'+
    '<div style="font-size:11px;color:var(--text-sec);">'+h.length+' total holdings</div></div>';
  // Concentration: top 10
  const sorted = sec.slice().sort((a,b) => (b.currentPrice||0)*b.quantity - (a.currentPrice||0)*a.quantity);
  const top10MV = sorted.slice(0,10).reduce((s,x) => s + (x.currentPrice||0)*x.quantity, 0);
  const top10Pct = totMV > 0 ? top10MV/totMV*100 : 0;
  html += '<div style="background:var(--panel);border:1px solid var(--border);padding:12px;border-radius:4px;">'+
    '<div style="font-size:10px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Top 10 Concentration</div>'+
    '<div style="font-size:22px;font-weight:700;font-family:Courier New,monospace;color:'+(top10Pct>70?'var(--danger)':top10Pct>50?'var(--warning)':'var(--success)')+';">'+top10Pct.toFixed(1)+'%</div>'+
    '<div style="font-size:11px;color:var(--text-sec);">SPY ~31% (top 10)</div></div>';

  // ── New cards: Top Industry, Highest Risk Asset, Best/Worst Performing, Longest/Avg Held ──
  // Top Industry by weight
  const industryCounts = {};
  sec.forEach(x => {
    const ind = x.industry || x.sector || 'Unknown';
    const w = totMV > 0 ? (x.currentPrice||0)*x.quantity / totMV : 0;
    industryCounts[ind] = (industryCounts[ind]||0) + w;
  });
  const topInd = Object.entries(industryCounts).sort((a,b)=>b[1]-a[1])[0];
  html += '<div style="background:var(--panel);border:1px solid var(--border);padding:12px;border-radius:4px;">'+
    '<div style="font-size:10px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Top Industry</div>'+
    '<div style="font-size:16px;font-weight:700;color:var(--navy);line-height:1.3;">'+(topInd ? topInd[0] : '—')+'</div>'+
    '<div style="font-size:11px;color:var(--text-sec);">'+(topInd ? (topInd[1]*100).toFixed(1)+'% of portfolio' : '')+'</div></div>';

  // Highest Risk Asset (largest individual weight as proxy for concentration risk)
  const highRisk = sorted[0];
  const highRiskW = highRisk && totMV > 0 ? (highRisk.currentPrice||0)*highRisk.quantity/totMV*100 : 0;
  html += '<div style="background:var(--panel);border:1px solid var(--border);padding:12px;border-radius:4px;">'+
    '<div style="font-size:10px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Highest Risk Asset</div>'+
    '<div style="font-size:22px;font-weight:700;font-family:Courier New,monospace;color:var(--danger);">'+(highRisk ? highRisk.ticker : '—')+'</div>'+
    '<div style="font-size:11px;color:var(--text-sec);">'+(highRisk ? highRiskW.toFixed(1)+'% weight (largest position)' : '')+'</div></div>';

  // Best and Worst Performing (by G/L %)
  const withGL = sec.filter(x => x.costBasis > 0 && x.currentPrice != null);
  withGL.sort((a,b) => {
    const ga = (a.currentPrice/a.costBasis-1)*100;
    const gb = (b.currentPrice/b.costBasis-1)*100;
    return gb - ga;
  });
  const bestPos = withGL[0];
  const worstPos = withGL[withGL.length-1];
  const bestGl = bestPos ? ((bestPos.currentPrice/bestPos.costBasis-1)*100).toFixed(1) : null;
  const worstGl = worstPos ? ((worstPos.currentPrice/worstPos.costBasis-1)*100).toFixed(1) : null;
  html += '<div style="background:var(--panel);border:1px solid var(--border);padding:12px;border-radius:4px;">'+
    '<div style="font-size:10px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Best Performing</div>'+
    '<div style="font-size:22px;font-weight:700;font-family:Courier New,monospace;color:var(--success);">'+(bestPos ? bestPos.ticker : '—')+'</div>'+
    '<div style="font-size:11px;color:var(--text-sec);">'+(bestGl != null ? (parseFloat(bestGl)>=0?'+':'')+bestGl+'% unrealized' : 'No cost basis')+'</div></div>';
  html += '<div style="background:var(--panel);border:1px solid var(--border);padding:12px;border-radius:4px;">'+
    '<div style="font-size:10px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Worst Performing</div>'+
    '<div style="font-size:22px;font-weight:700;font-family:Courier New,monospace;color:var(--danger);">'+(worstPos && worstPos !== bestPos ? worstPos.ticker : '—')+'</div>'+
    '<div style="font-size:11px;color:var(--text-sec);">'+(worstGl != null && worstPos !== bestPos ? (parseFloat(worstGl)>=0?'+':'')+worstGl+'% unrealized' : 'No data')+'</div></div>';

  // Longest Held and Avg Days Held
  const today = new Date();
  const withDates = sec.filter(x => x.datePurchased);
  var longestHeld = null, longestDays = 0, totalDays = 0;
  withDates.forEach(x => {
    try {
      var d = new Date(x.datePurchased + 'T00:00:00Z');
      var days = Math.floor((today - d) / 86400000);
      if (days > longestDays) { longestDays = days; longestHeld = x; }
      totalDays += days;
    } catch(e) {}
  });
  var avgDays = withDates.length > 0 ? Math.round(totalDays / withDates.length) : null;
  html += '<div style="background:var(--panel);border:1px solid var(--border);padding:12px;border-radius:4px;">'+
    '<div style="font-size:10px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Longest Held</div>'+
    '<div style="font-size:22px;font-weight:700;font-family:Courier New,monospace;color:var(--navy);">'+(longestHeld ? longestHeld.ticker : '—')+'</div>'+
    '<div style="font-size:11px;color:var(--text-sec);">'+(longestHeld ? longestDays+' days' : 'No date data')+'</div></div>';
  html += '<div style="background:var(--panel);border:1px solid var(--border);padding:12px;border-radius:4px;">'+
    '<div style="font-size:10px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Avg Days Held</div>'+
    '<div style="font-size:22px;font-weight:700;font-family:Courier New,monospace;color:var(--navy);">'+(avgDays != null ? avgDays : '—')+'</div>'+
    '<div style="font-size:11px;color:var(--text-sec);">'+(withDates.length ? withDates.length+' positions with dates' : 'No date data')+'</div></div>';

  html += '</div>';
  el.innerHTML = html;
}

// ────────── Drift Panel ──────────
const SPY_SECTOR_WEIGHTS = {
  'Technology':30.5,'Financials':13.5,'Healthcare':11.0,'Consumer Discretionary':10.5,
  'Communication Services':9.5,'Industrials':8.5,'Consumer Staples':6.0,'Energy':3.5,
  'Utilities':2.5,'Real Estate':2.5,'Materials':2.0
};
const QQQ_SECTOR_WEIGHTS = {
  'Technology':62.0,'Communication Services':15.0,'Consumer Discretionary':14.0,
  'Healthcare':5.0,'Industrials':2.5,'Consumer Staples':1.0,'Utilities':0.5
};
const AGGRESSIVE_GROWTH_WEIGHTS = {
  'Technology':40.0,'Communication Services':20.0,'Consumer Discretionary':15.0,
  'Healthcare':10.0,'Industrials':5.0,'Financials':5.0,'Materials':2.5,'Energy':2.5
};
const CONSERVATIVE_WEIGHTS = {
  'Healthcare':20.0,'Financials':18.0,'Consumer Staples':15.0,'Utilities':12.0,
  'Real Estate':12.0,'Energy':8.0,'Industrials':7.0,'Technology':5.0,'Materials':3.0
};
const BALANCED_WEIGHTS = {
  'Technology':20.0,'Healthcare':14.0,'Financials':12.0,'Industrials':10.0,
  'Consumer Discretionary':9.0,'Consumer Staples':8.0,'Communication Services':8.0,
  'Energy':6.0,'Utilities':5.0,'Real Estate':5.0,'Materials':3.0
};

/* ── EXPORTED TO window — added 2026-07-25 ────────────────────────────────────
   The five objects above are declared with `const`. A top-level `const` in a
   classic script creates a binding in the global LEXICAL scope but, unlike
   `var`, does NOT create a property on `window`. app.js read them as
   `window.SPY_SECTOR_WEIGHTS`, got undefined, fell through to `|| {}` and drew
   the "Current vs. Target Allocation" chart with an empty target set — an axis
   with no bars, and no error in the console to explain it.

   Exporting them explicitly fixes that chart and any future consumer that
   reasonably expects these to be reachable from `window`. TARGET_MODELS is the
   preferred handle going forward; the individual aliases are kept for the
   existing call sites. */
window.SPY_SECTOR_WEIGHTS        = SPY_SECTOR_WEIGHTS;
window.QQQ_SECTOR_WEIGHTS        = QQQ_SECTOR_WEIGHTS;
window.AGGRESSIVE_GROWTH_WEIGHTS = AGGRESSIVE_GROWTH_WEIGHTS;
window.CONSERVATIVE_WEIGHTS      = CONSERVATIVE_WEIGHTS;
window.BALANCED_WEIGHTS          = BALANCED_WEIGHTS;
window.TARGET_MODELS = {
  spy: SPY_SECTOR_WEIGHTS,
  qqq: QQQ_SECTOR_WEIGHTS,
  aggressive_growth: AGGRESSIVE_GROWTH_WEIGHTS,
  conservative: CONSERVATIVE_WEIGHTS,
  balanced: BALANCED_WEIGHTS
};

function driftRender() {
  const el = document.getElementById('driftPanel');
  if (!el) return;
  const h = window._holdings || [];
  const isCash = x => ['Cash','Money Market','CD','Bond Position'].includes(x.assetClass);
  const sec = h.filter(x => !isCash(x));
  if (!sec.length) { el.innerHTML = '<p>Add holdings to compute drift.</p>'; return; }
  const totMV = sec.reduce((s,x) => s + (x.currentPrice||0)*x.quantity, 0);
  const tol = parseFloat(document.getElementById('driftTol').value) || 3;
  const model = document.getElementById('driftModel').value;
  let target;
  if (model === 'spy') target = SPY_SECTOR_WEIGHTS;
  else if (model === 'qqq') target = QQQ_SECTOR_WEIGHTS;
  else if (model === 'equal') {
    const sectors = [...new Set(sec.map(x => normSector(x.sector || 'Other')))];
    target = {}; sectors.forEach(s => target[s] = 100/sectors.length);
  } else {
    target = window._customDriftTarget || SPY_SECTOR_WEIGHTS;
  }

  // Compute current weights
  const cur = {};
  sec.forEach(x => {
    const k = normSector(x.sector || 'Other');
    cur[k] = (cur[k]||0) + (x.currentPrice||0)*x.quantity;
  });
  const allKeys = [...new Set([...Object.keys(target), ...Object.keys(cur)])];
  // Sort modes cycle via the Drift header: |drift| desc → drift desc → drift asc
  const sortMode = window._driftSort || 'absdesc';
  const sortArrow = sortMode === 'absdesc' ? '↕' : sortMode === 'desc' ? '▼' : '▲';
  let html = '<div class="drift-row header"><div>Sector</div>'
    + '<div onclick="driftToggleSort()" style="cursor:pointer;user-select:none;" title="Click to sort: largest absolute drift → most overweight → most underweight">Drift <span style="font-size:10px;">'+sortArrow+'</span></div>'
    + '<div class="drift-col-target" title="Click any target value to edit it — the model switches to Custom and everything recalculates">Target ✎</div><div>Current</div></div>';
  let breaches = 0;
  const driftRows = [];
  allKeys.forEach(k => {
    const c = totMV > 0 ? (cur[k]||0)/totMV*100 : 0;
    const t = target[k] || 0;
    const d = c - t; // positive = overweight
    const isBreach = Math.abs(d) > tol;
    if (isBreach) breaches++;
    driftRows.push({ sector: k, c, t, d, breach: isBreach });
  });
  if (sortMode === 'desc') driftRows.sort((a,b) => b.d - a.d);
  else if (sortMode === 'asc') driftRows.sort((a,b) => a.d - b.d);
  else driftRows.sort((a,b) => Math.abs(b.d) - Math.abs(a.d));
  driftRows.forEach(r => {
    // Bar centered at 50%; left for under, right for over; max scale ±10%
    const maxScale = Math.max(10, tol * 2);
    const w = Math.min(50, Math.abs(r.d) / maxScale * 50);
    const left = r.d >= 0 ? 50 : (50 - w);
    let cls = 'under';
    if (r.breach && r.d > 0) cls = 'over';
    if (r.breach && Math.abs(r.d) > tol * 2) cls = 'breach';
    html += '<div class="drift-row">'+
      '<div style="font-weight:700;color:var(--navy);">'+r.sector+(r.breach?' <span style="color:var(--warning,#8B6914);font-size:11px;">●</span>':'')+'</div>'+
      '<div class="drift-bar"><div class="drift-bar-center"></div><div class="drift-bar-fill '+cls+'" style="left:'+left+'%;width:'+w+'%;"></div></div>'+
      '<div class="drift-col-target drift-status"><input type="number" value="'+r.t.toFixed(1)+'" min="0" max="100" step="0.5" '+
        'style="width:58px;font-size:11px;padding:2px 4px;border:1px dashed var(--border);border-radius:3px;background:transparent;color:var(--text-sec);text-align:right;" '+
        'title="Edit target weight — switches model to Custom" onchange="driftSetTarget(\''+r.sector.replace(/'/g,"\\'")+'\', this.value)">%</div>'+
      '<div class="drift-status" style="color:'+(r.breach?'var(--warning,#8B6914)':'var(--navy)')+';">'+r.c.toFixed(1)+'% <span style="font-size:10px;color:'+(r.d>=0?'var(--success)':'var(--danger)')+';">'+(r.d>=0?'+':'')+r.d.toFixed(1)+'</span></div>'+
      '</div>';
  });
  const targetSum = driftRows.reduce((s,r) => s + r.t, 0);
  html += '<p style="font-size:11px;color:var(--text-sec);margin-top:10px;line-height:1.5;"><strong>'+breaches+' sector(s)</strong> outside ±'+tol+'% tolerance band. Targets are editable in-line (switches model to Custom). '
    + (Math.abs(targetSum - 100) > 0.5 ? '<strong style="color:#8B6914;">⚠ Targets sum to '+targetSum.toFixed(1)+'% — <a href="javascript:driftNormalizeTargets()" style="color:var(--blue);">normalize to 100%</a>.</strong> ' : '')
    + 'Click <strong>Propose Rebalance</strong> above to generate the order list.</p>';
  el.innerHTML = html;
  window._driftRows = driftRows;
  window._driftTol = tol;
  window._driftTargetMap = target;
}

// ═══════════════════════════════════════════════════════════════════
// HOLDINGS METADATA ENRICHMENT (added 2026-07)
// Backfills missing Sector / Industry / Asset type / Yield per holding:
// 1) local ETF_DB classification, 2) FMP profile via /fundamentals
// (sector, industry, type, last dividend → yield). Writes fixes back to
// Firestore so the table stays clean permanently.
// ═══════════════════════════════════════════════════════════════════
// v2 (2026-07): also RE-EXAMINES anything marked "Other"/"Equity"/generic, and
// classifies every holding into a full taxonomy: Stock, ETF, 2x/3x Leveraged
// ETF, Inverse Leveraged ETF, REIT, Crypto, Mutual Fund, Bond ETF (Cash /
// Money Market / CD / Bond Position rows are respected and left alone).
function classifyAssetType(ticker, etfEntry, profile) {
  var t = String(ticker || '').toUpperCase();
  if (t.endsWith('-USD') || /^(BTC|ETH|SOL|ADA|XRP|DOGE)$/.test(t)) return 'Crypto';
  var levStr = etfEntry && etfEntry.lev ? String(etfEntry.lev) : null;
  if (levStr || (typeof LEVERAGED_TICKERS !== 'undefined' && LEVERAGED_TICKERS[t])) {
    var mult = levStr ? (levStr.match(/^(\d+(?:\.\d+)?)x/i) || [])[1] : '3';
    var isShort = levStr ? /short/i.test(levStr) : /^(SQQQ|SPXU|SPXS|SOXS|SDS|QID|TMV|SDOW|TZA|FAZ|LABD|DUST|ERY|SCO|KOLD|TECS|FNGD|WEBS|BERZ|REW|DXD|SRTY|YANG|EDZ|DRV|MSTZ|TSLQ)$/.test(t);
    return (isShort ? 'Inverse ' : '') + (mult || '3') + 'x Leveraged ETF';
  }
  var ind = (profile && profile.industry) || (etfEntry && etfEntry.i) || '';
  var sec = (profile && profile.sector) || (etfEntry && etfEntry.s) || '';
  if (/reit/i.test(ind) || (/real estate/i.test(sec) && profile && !profile.isEtf && (profile.type !== 'ETF'))) return 'REIT';
  if (etfEntry) return /bond|treasury|fixed income/i.test((etfEntry.s||'') + ' ' + (etfEntry.i||'')) ? 'Bond ETF' : 'ETF';
  if (profile) {
    if (profile.type === 'ETF' || profile.isEtf) return 'ETF';
    if (profile.type === 'FUND' || profile.isFund) return 'Mutual Fund';
    return 'Stock';
  }
  return null; // unknown — leave as-is
}

async function enrichHoldingsMetadata() {
  var hs = window._holdings || [];
  if (!hs.length) return;
  var isCashE = function(x){ return ['Cash','Money Market','CD','Bond Position'].includes(x.assetClass); };
  var GENERIC = { '': 1, '—': 1, 'Other': 1, 'other': 1, 'Unknown': 1, 'N/A': 1 };
  var GENERIC_ASSET = { '': 1, '—': 1, 'Other': 1, 'Unknown': 1, 'Equity': 1, 'Leveraged ETF': 1, 'Security': 1 };
  var fixed = 0, checked = 0;
  if (typeof showStatus === 'function') showStatus('holdingsStatus', '<span class="spinner"></span> Scanning holdings — including anything marked "Other" — for reclassification…', 'info');
  for (var i = 0; i < hs.length; i++) {
    var x = hs[i];
    if (isCashE(x)) continue;
    // FULL RESCAN (2026-07): every non-cash holding is re-examined — not just
    // blanks. Fresh profile data OVERRIDES anything generic or previously
    // mis-pulled; yield is always recomputed from the latest dividend + price.
    var needSector = true;
    var needInd    = true;
    var needAsset  = true;
    var needYield  = true;
    checked++;
    var upd = {};
    var tU = String(x.ticker).toUpperCase();
    var e = ETF_DB[tU];
    var profile = null;
    // Curated ETF_DB is the most trusted source — apply first
    var bestSector = (e && e.s && !GENERIC[e.s]) ? e.s : null;
    var bestInd = (e && e.i) ? e.i : null;
    try {
      var d = await fetch(WORKER_URL + '/fundamentals?symbol=' + encodeURIComponent(x.ticker)).then(function(r){ return r.json(); });
      profile = d && d.profile ? d.profile : null;
      if (profile) {
        if (!bestSector && profile.sector && !GENERIC[profile.sector]) bestSector = profile.sector;
        if (!bestInd && profile.industry) bestInd = profile.industry;
        // Yield: ALWAYS recompute on rescan. Crypto/no-dividend → explicit 0.
        var isCrypto = tU.endsWith('-USD') || (d.assetType === 'CRYPTO');
        var newYield = isCrypto ? 0
          : (profile.lastDividend && x.currentPrice > 0 ? +((profile.lastDividend / x.currentPrice) * 100).toFixed(2)
          : (profile.lastDividend === 0 || profile.lastDividend == null ? 0 : null));
        if (newYield != null && newYield !== x.yieldPct) upd.yieldPct = newYield;
      }
    } catch(e2) {}
    if (bestSector && bestSector !== x.sector) upd.sector = bestSector;
    if (bestInd && bestInd !== x.industry) upd.industry = bestInd;
    var cls = classifyAssetType(tU, e, profile);
    if (cls && cls !== x.assetClass) upd.assetClass = cls;
    if (Object.keys(upd).length) {
      upd.lastUpdated = new Date().toISOString();
      try { await updateHoldingDoc(x.id, upd); fixed++; } catch(e3) {}
    }
  }
  if (typeof loadHoldings === 'function') await loadHoldings();
  if (typeof showStatus === 'function') showStatus('holdingsStatus', '&#10003; Auto-fill v2 complete: ' + fixed + ' of ' + checked + ' flagged holdings enriched / reclassified (taxonomy: Stock, ETF, 2x/3x Leveraged ETF, Inverse Leveraged ETF, REIT, Crypto, Mutual Fund, Bond ETF).', 'success');
}

// ═══════════════════════════════════════════════════════════════════
// ACCOUNT-BY-ACCOUNT COMPARISON (added 2026-07)
// Size + unrealized performance bars · sector mix stacked columns ·
// pairwise holdings overlap · underperformer flags per account.
// ═══════════════════════════════════════════════════════════════════
var _acctCmpCharts = [];
function renderAccountComparison(force) {
  var el = document.getElementById('acctCompareBody');
  if (!el) return;
  if (el.dataset.rendered === '1' && !force) return;
  var all = window._holdings || [];
  if (!all.length) { el.innerHTML = '<div style="color:var(--text-sec);padding:10px;">Add holdings to compare accounts.</div>'; return; }
  el.dataset.rendered = '1';
  var isCashX = function(x){ return ['Cash','Money Market','CD','Bond Position'].includes(x.assetClass); };
  // Group by account
  var accts = {};
  all.forEach(function(h) {
    var a = h.accountType || 'Individual';
    if (!accts[a]) accts[a] = { name: a, mv: 0, cost: 0, positions: [], sectors: {} };
    var mv = isCashX(h) ? (h.costBasis||0)*(h.quantity||1) : (h.currentPrice||0)*h.quantity;
    var cost = (h.costBasis||0)*(h.quantity||1);
    accts[a].mv += mv;
    if (!isCashX(h)) {
      accts[a].cost += cost;
      var glp = h.costBasis > 0 && h.currentPrice ? (h.currentPrice/h.costBasis - 1)*100 : null;
      accts[a].positions.push({ ticker: h.ticker, mv: mv, glp: glp });
      var s = (typeof normSector === 'function' ? normSector(h.sector||'Other') : (h.sector||'Other'));
      accts[a].sectors[s] = (accts[a].sectors[s]||0) + mv;
    }
  });
  var names = Object.keys(accts);
  if (names.length < 1) { el.innerHTML = '<div style="color:var(--text-sec);">No accounts found.</div>'; return; }
  // Median position return across the whole portfolio (underperformer baseline)
  var allGlp = [];
  names.forEach(function(a){ accts[a].positions.forEach(function(p){ if (p.glp != null) allGlp.push(p.glp); }); });
  allGlp.sort(function(x,y){ return x-y; });
  var medGlp = allGlp.length ? allGlp[Math.floor(allGlp.length/2)] : 0;
  // Pairwise overlap
  var overlapHtml = '';
  if (names.length > 1) {
    var pairs = [];
    for (var i = 0; i < names.length; i++) for (var j = i+1; j < names.length; j++) {
      var setA = {}; accts[names[i]].positions.forEach(function(p){ setA[p.ticker]=1; });
      var shared = accts[names[j]].positions.filter(function(p){ return setA[p.ticker]; }).map(function(p){ return p.ticker; });
      var uniq = [...new Set(shared)];
      if (uniq.length) pairs.push({ a: names[i], b: names[j], n: uniq.length, t: uniq.slice(0,6).join(', ') });
    }
    pairs.sort(function(x,y){ return y.n-x.n; });
    overlapHtml = pairs.length
      ? '<div style="font-size:11px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:.4px;margin:12px 0 4px;">Holdings Overlap Between Accounts</div>'
        + pairs.slice(0,5).map(function(p){ return '<div style="font-size:12px;padding:3px 0;border-bottom:1px dashed var(--border);"><strong>'+p.a+'</strong> ↔ <strong>'+p.b+'</strong>: '+p.n+' shared ticker'+(p.n>1?'s':'')+' <span style="color:var(--text-sec);">('+p.t+')</span></div>'; }).join('')
        + '<div style="font-size:10.5px;color:var(--text-sec);margin-top:4px;">High overlap = the accounts move together; a drawdown hits all of them at once.</div>'
      : '<div style="font-size:11px;color:var(--text-sec);margin-top:10px;">No overlapping tickers between accounts — good structural diversification.</div>';
  }
  // Underperformers per account
  var underHtml = '';
  names.forEach(function(a) {
    var under = accts[a].positions.filter(function(p){ return p.glp != null && p.glp < -5 && p.glp < medGlp; })
      .sort(function(x,y){ return x.glp-y.glp; }).slice(0,4);
    if (under.length) {
      underHtml += '<div style="font-size:12px;padding:4px 0;"><strong style="color:var(--navy);">'+a+':</strong> '
        + under.map(function(p){ return '<span style="display:inline-block;background:rgba(139,42,42,0.07);border:1px solid rgba(139,42,42,0.3);border-radius:10px;padding:1px 8px;margin:1px;font-size:11px;"><strong>'+p.ticker+'</strong> <span style="color:var(--danger);font-weight:600;">'+p.glp.toFixed(1)+'%</span></span>'; }).join(' ') + '</div>';
    }
  });
  // ── View toggles: four lenses, same footprint (no extra scrolling) ──
  var view = window._acctCmpView || 'perf';
  var VIEWS = [['perf','Size & Return'],['sector','Sector Mix'],['conc','Concentration'],['income','Income']];
  var toggles = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">'
    + VIEWS.map(function(v){ return '<button class="btn-outline btn-sm'+(view===v[0]?' active':'')+'" onclick="window._acctCmpView=\''+v[0]+'\';renderAccountComparison(true)">'+v[1]+'</button>'; }).join('')
    + '</div>';
  var TITLES = {
    perf:   ['Value & Unrealized Return by Account', 'Sector Mix by Account (100% stacked)'],
    sector: ['Sector Mix by Account (100% stacked)', 'Largest Sector Weight per Account'],
    conc:   ['Concentration: Top Position Weight & Effective # of Positions', 'Cash Buffer % by Account'],
    income: ['Weighted Dividend Yield by Account', 'Projected Annual Income ($) by Account']
  };
  el.innerHTML = toggles
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;" class="acct-cmp-grid">'
    + '<div><div style="font-size:11px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px;">'+TITLES[view][0]+'</div><div style="height:310px;position:relative;"><canvas id="acctValueChart"></canvas></div></div>'
    + '<div><div style="font-size:11px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px;">'+TITLES[view][1]+'</div><div style="height:310px;position:relative;"><canvas id="acctSectorChart"></canvas></div></div>'
    + '</div>'
    + overlapHtml
    + (underHtml ? '<div style="font-size:11px;font-weight:700;color:var(--danger);text-transform:uppercase;letter-spacing:.4px;margin:12px 0 4px;">Underperforming Positions to Review (< −5% and below portfolio median)</div>'+underHtml : '<div style="font-size:11px;color:var(--success);margin-top:10px;">✓ No positions flagged as underperformers right now.</div>');
  // Charts
  _acctCmpCharts.forEach(function(c){ try { c.destroy(); } catch(e){} });
  _acctCmpCharts = [];
  var baseOpts = function(extra) {
    return Object.assign({ responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { position: 'top', labels: { font: { size: 10 } } } } }, extra || {});
  };
  // Per-account derived stats used by multiple views
  var stats = {};
  names.forEach(function(a) {
    var A = accts[a];
    var secMv = A.positions.reduce(function(s,p){ return s+p.mv; }, 0);
    var topW = 0; var sumSq = 0;
    A.positions.forEach(function(p){ var w = secMv > 0 ? p.mv/secMv : 0; if (w > topW) topW = w; sumSq += w*w; });
    var hSrc = (window._holdings||[]).filter(function(x){ return (x.accountType||'Individual') === a; });
    var cashMv = hSrc.filter(isCashX).reduce(function(s,x){ return s + (x.costBasis||0)*(x.quantity||1); }, 0);
    var wYield = 0;
    hSrc.forEach(function(x){ var mv2 = isCashX(x) ? (x.costBasis||0)*(x.quantity||1) : (x.currentPrice||0)*x.quantity; wYield += mv2 * (parseFloat(x.yieldPct)||0); });
    stats[a] = {
      glp: A.cost > 0 ? (secMv/A.cost - 1)*100 : 0,
      topW: topW*100,
      effN: sumSq > 0 ? 1/sumSq : 0,             // inverse Herfindahl — "how many positions does this account really behave like?"
      cashPct: A.mv > 0 ? cashMv/A.mv*100 : 0,
      yieldPct: A.mv > 0 ? wYield/A.mv : 0,
      incomeDol: wYield/100
    };
  });
  function sectorStackedConfig() {
    var allSectors = [...new Set(names.reduce(function(arr,a){ return arr.concat(Object.keys(accts[a].sectors)); }, []))];
    var ds = allSectors.map(function(s, i) {
      return { label: s, data: names.map(function(a){ var tot = Object.values(accts[a].sectors).reduce(function(x,y){return x+y;},0); return tot>0 ? +((accts[a].sectors[s]||0)/tot*100).toFixed(1) : 0; }), backgroundColor: PALETTE[i % PALETTE.length] };
    });
    return { type: 'bar', data: { labels: names, datasets: ds },
      options: baseOpts({ plugins: { legend: { position: 'bottom', labels: { font: { size: 9 }, boxWidth: 10 } }, tooltip: { callbacks: { label: function(c){ return c.dataset.label+': '+c.parsed.y+'%'; } } } },
        scales: { x: { stacked: true, ticks: { font:{size:10} }, grid: { display: false } }, y: { stacked: true, max: 100, ticks: { callback: function(v){ return v+'%'; }, font:{size:10} } } } }) };
  }
  function barConfig(label, data, fmtY, color) {
    return { type: 'bar', data: { labels: names, datasets: [{ label: label, data: data, backgroundColor: color || 'rgba(0,60,113,0.7)', borderRadius: 3 }] },
      options: baseOpts({ scales: { y: { ticks: { callback: fmtY, font:{size:10} } }, x: { ticks: { font:{size:10} }, grid: { display: false } } } }) };
  }
  var cfg1, cfg2;
  if (view === 'perf') {
    cfg1 = { data: { labels: names, datasets: [
        { type: 'bar', label: 'Market Value ($)', data: names.map(function(a){ return +accts[a].mv.toFixed(0); }), backgroundColor: 'rgba(0,60,113,0.7)', yAxisID: 'y', borderRadius: 3 },
        { type: 'line', label: 'Unrealized Return (%)', data: names.map(function(a){ return +stats[a].glp.toFixed(1); }), borderColor: '#2E7D52', backgroundColor: '#2E7D52', yAxisID: 'y1', pointRadius: 4, borderWidth: 2 }
      ]},
      options: baseOpts({ scales: { y: { ticks: { callback: function(v){ return '$'+Math.round(v/1000)+'K'; }, font:{size:10} } }, y1: { position: 'right', grid: { display: false }, ticks: { callback: function(v){ return v+'%'; }, font:{size:10} } }, x: { ticks: { font:{size:10} }, grid: { display: false } } } }) };
    cfg2 = sectorStackedConfig();
  } else if (view === 'sector') {
    cfg1 = sectorStackedConfig();
    cfg2 = barConfig('Largest Sector Weight (%)', names.map(function(a){ var mx=0; var tot=Object.values(accts[a].sectors).reduce(function(x,y){return x+y;},0); Object.values(accts[a].sectors).forEach(function(v){ var w=tot>0?v/tot*100:0; if(w>mx)mx=w; }); return +mx.toFixed(1); }), function(v){ return v+'%'; }, 'rgba(139,105,20,0.7)');
  } else if (view === 'conc') {
    cfg1 = { data: { labels: names, datasets: [
        { type: 'bar', label: 'Top Position Weight (%)', data: names.map(function(a){ return +stats[a].topW.toFixed(1); }), backgroundColor: 'rgba(139,42,42,0.65)', yAxisID: 'y', borderRadius: 3 },
        { type: 'line', label: 'Effective # of Positions', data: names.map(function(a){ return +stats[a].effN.toFixed(1); }), borderColor: C.blue, backgroundColor: C.blue, yAxisID: 'y1', pointRadius: 4, borderWidth: 2 }
      ]},
      options: baseOpts({ scales: { y: { ticks: { callback: function(v){ return v+'%'; }, font:{size:10} } }, y1: { position: 'right', grid: { display: false }, ticks: { font:{size:10} } }, x: { ticks: { font:{size:10} }, grid: { display: false } } } }) };
    cfg2 = barConfig('Cash Buffer (%)', names.map(function(a){ return +stats[a].cashPct.toFixed(1); }), function(v){ return v+'%'; }, 'rgba(46,125,82,0.65)');
  } else { // income
    var anyYield = names.some(function(a){ return stats[a].yieldPct > 0.01; });
    if (!anyYield) {
      // No yield data yet — show an explicit empty state instead of blank bars,
      // with the one-click fix (the holdings rescan populates dividend yields).
      var grid = el.querySelector('.acct-cmp-grid');
      if (grid) grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px 20px;color:var(--text-sec);font-size:13px;line-height:1.7;">'
        + '<div style="font-size:26px;">💤</div>'
        + '<strong style="color:var(--navy);">No dividend yields on file yet.</strong><br>'
        + 'The Income view charts weighted yield and projected annual dollars per account — it needs each holding\'s dividend yield.<br>'
        + '<button class="btn btn-sm" style="margin-top:10px;" onclick="enrichHoldingsMetadata().then(function(){renderAccountComparison(true);})">🪄 Rescan holdings to pull yields</button></div>';
      return;
    }
    cfg1 = barConfig('Weighted Yield (%)', names.map(function(a){ return +stats[a].yieldPct.toFixed(2); }), function(v){ return v+'%'; }, 'rgba(46,125,82,0.7)');
    cfg2 = barConfig('Projected Annual Income ($)', names.map(function(a){ return +stats[a].incomeDol.toFixed(0); }), function(v){ return '$'+Math.round(v).toLocaleString(); });
  }
  var vEl = document.getElementById('acctValueChart');
  if (vEl && cfg1) _acctCmpCharts.push(new Chart(vEl.getContext('2d'), cfg1));
  var sEl = document.getElementById('acctSectorChart');
  if (sEl && cfg2) _acctCmpCharts.push(new Chart(sEl.getContext('2d'), cfg2));
}

// Compact the legacy analysis widgets below the comparison card into a
// collapsible block so the tab keeps the same footprint (2026-07).
(function compactLegacyAnalysis() {
  function doCompact() {
    try {
      var tab = document.getElementById('htab-analysis');
      if (!tab || document.getElementById('legacyAnalysisWrap')) return;
      var cmpCard = tab.querySelector('.card'); // the comparison card is first
      if (!cmpCard) return;
      var det = document.createElement('details');
      det.id = 'legacyAnalysisWrap';
      det.style.cssText = 'border:1px solid var(--border);border-radius:6px;margin-top:4px;background:#fff;';
      det.innerHTML = '<summary style="cursor:pointer;padding:10px 16px;font-size:13px;font-weight:700;color:var(--navy);user-select:none;">📂 Classic Analysis Widgets (story cards, characteristics & detail views) — click to expand</summary><div id="legacyAnalysisBody" style="padding:10px 14px;"></div>';
      var body = null;
      // Move everything AFTER the comparison card into the collapsible
      var toMove = [];
      var node = cmpCard.nextSibling;
      while (node) { var nxt = node.nextSibling; if (node.nodeType === 1) toMove.push(node); node = nxt; }
      tab.appendChild(det);
      body = det.querySelector('#legacyAnalysisBody');
      toMove.forEach(function(n){ if (n !== det) body.appendChild(n); });
    } catch(e) { console.warn('legacy analysis compact failed:', e); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', doCompact);
  else doCompact();
})();

// ── In-line target editing + drift sorting (added 2026-07) ──
function driftToggleSort() {
  var m = window._driftSort || 'absdesc';
  window._driftSort = m === 'absdesc' ? 'desc' : m === 'desc' ? 'asc' : 'absdesc';
  driftRender();
}
function driftSetTarget(sector, val) {
  var v = parseFloat(val);
  if (isNaN(v) || v < 0) return;
  // Seed the custom map from whatever model is currently displayed
  if (!window._customDriftTarget) window._customDriftTarget = Object.assign({}, window._driftTargetMap || SPY_SECTOR_WEIGHTS);
  window._customDriftTarget[sector] = v;
  var sel = document.getElementById('driftModel');
  if (sel) sel.value = 'custom';
  driftRender();
  if (typeof renderHldRebalanceChart === 'function') renderHldRebalanceChart();
}
function driftNormalizeTargets() {
  var map = window._customDriftTarget || Object.assign({}, window._driftTargetMap || SPY_SECTOR_WEIGHTS);
  var sum = Object.keys(map).reduce(function(s,k){ return s + (map[k]||0); }, 0);
  if (sum <= 0) return;
  Object.keys(map).forEach(function(k){ map[k] = +(map[k] / sum * 100).toFixed(1); });
  window._customDriftTarget = map;
  var sel = document.getElementById('driftModel');
  if (sel) sel.value = 'custom';
  driftRender();
  if (typeof renderHldRebalanceChart === 'function') renderHldRebalanceChart();
}
function driftProposeRebalance() {
  const rows = window._driftRows || [];
  const tol = window._driftTol || 3;
  const sec = (window._holdings || []).filter(x => !['Cash','Money Market','CD','Bond Position'].includes(x.assetClass));
  const totMV = sec.reduce((s,x) => s + (x.currentPrice||0)*x.quantity, 0);
  if (!rows.length || !totMV) { showStatus('holdingsStatus', 'Run drift analysis first.', 'error'); return; }
  const blotter = window._blotter = window._blotter || [];
  let added = 0;
  rows.forEach(r => {
    if (!r.breach) return;
    // Find largest position in that sector
    const inSec = sec.filter(x => normSector(x.sector||'Other') === r.sector).sort((a,b) => (b.currentPrice||0)*b.quantity - (a.currentPrice||0)*a.quantity);
    if (!inSec.length) return;
    const target = inSec[0];
    const targetMV = (target.currentPrice||0)*target.quantity;
    const sectorMV = inSec.reduce((s,x) => s + (x.currentPrice||0)*x.quantity, 0);
    const desiredSectorMV = (r.t/100) * totMV;
    const adjustMV = desiredSectorMV - sectorMV; // positive = buy more; negative = sell
    // Allocate proportionally to largest position
    const portionMV = adjustMV * (targetMV / Math.max(sectorMV, 1));
    const px = target.currentPrice || 0;
    if (px <= 0) return;
    const shares = Math.round(portionMV / px);
    if (Math.abs(shares) < 1) return;
    blotter.push({
      ticker: target.ticker, sector: r.sector,
      action: shares > 0 ? 'BUY' : 'SELL',
      shares: Math.abs(shares),
      price: px, dollar: Math.abs(shares*px),
      reason: 'Drift '+(r.d>=0?'+':'')+r.d.toFixed(1)+'% (tol ±'+tol+'%)'
    });
    added++;
  });
  blotterRender();
  showStatus('holdingsStatus', added ? 'Added '+added+' proposed trade(s) to blotter.' : 'No trades needed (all within tolerance).', added ? 'success' : 'info');
}

// ────────── TLH Scanner ──────────
const TAXABLE_ACCTS = ['Individual','Joint','Trust','Custodial','Designated Beneficiary'];
function tlhRender() {
  const el = document.getElementById('tlhPanel');
  if (!el) return;
  const h = window._holdings || [];
  const threshold = parseFloat(document.getElementById('tlhThreshold').value) || 0;
  const minPct = parseFloat(document.getElementById('tlhMinPct').value) || 0;
  const candidates = h.filter(x => {
    if (['Cash','Money Market','CD','Bond Position'].includes(x.assetClass)) return false;
    const acct = x.accountType || 'Individual';
    if (!TAXABLE_ACCTS.includes(acct)) return false;
    const cb = x.costBasis || 0;
    const cp = x.currentPrice || 0;
    if (cb <= 0 || cp <= 0) return false;
    const lossDol = (cp - cb) * x.quantity;
    const lossPct = ((cp - cb) / cb) * 100;
    return lossDol <= -threshold && lossPct <= -minPct;
  });
  if (!candidates.length) {
    el.innerHTML = '<p style="padding:14px;color:var(--success);">No qualifying TLH candidates found at threshold $'+threshold+' / '+minPct+'%. ✓</p>';
    return;
  }
  candidates.sort((a,b) => ((a.currentPrice-a.costBasis)*a.quantity) - ((b.currentPrice-b.costBasis)*b.quantity));
  let html = '<div style="margin-bottom:10px;font-size:12px;color:var(--text-sec);"><strong>'+candidates.length+'</strong> qualifying candidate(s) in taxable accounts. Wash-sale rule: do not repurchase the same or substantially identical security within 30 days.</div>';
  candidates.forEach(x => {
    const lossDol = (x.currentPrice - x.costBasis) * x.quantity;
    const lossPct = ((x.currentPrice - x.costBasis) / x.costBasis) * 100;
    const datePurch = x.datePurchased ? new Date(x.datePurchased) : null;
    const daysHeld = datePurch ? Math.floor((Date.now() - datePurch.getTime())/86400000) : null;
    const isLT = daysHeld != null && daysHeld > 365;
    html += '<div class="tlh-card">'+
      '<div class="tlh-ticker">'+x.ticker+'</div>'+
      '<div><div style="font-size:11px;color:var(--text-sec);">'+(x.companyName||x.ticker)+' &middot; '+(x.accountType||'Individual')+'</div>'+
      '<div style="font-size:11px;color:var(--text-sec);margin-top:2px;">Held '+(daysHeld||'?')+'d &middot; <span class="lot-status '+(isLT?'lt':'st')+'">'+(isLT?'Long-term':'Short-term')+'</span></div></div>'+
      '<div class="tlh-loss">$'+Math.round(lossDol).toLocaleString()+'</div>'+
      '<div class="tlh-loss">'+lossPct.toFixed(1)+'%</div>'+
      '<button class="btn-outline btn-sm" onclick="tlhAddToBlotter(\''+x.id+'\')">Harvest</button>'+
      '</div>';
  });
  el.innerHTML = html;
}
function tlhAddToBlotter(id) {
  const x = (window._holdings||[]).find(h => h.id === id);
  if (!x) return;
  const blotter = window._blotter = window._blotter || [];
  blotter.push({
    ticker: x.ticker, sector: normSector(x.sector||'Other'),
    action: 'SELL', shares: x.quantity, price: x.currentPrice||0,
    dollar: (x.currentPrice||0)*x.quantity,
    reason: 'TLH — Loss $'+Math.round((x.currentPrice-x.costBasis)*x.quantity).toLocaleString()
  });
  blotterRender();
  showStatus('holdingsStatus', 'Added '+x.ticker+' SELL to blotter (TLH).', 'success');
}

// ────────── Trade Blotter ──────────
function blotterRender() {
  const inlineEl = document.getElementById('blotterInline');
  const card = document.getElementById('blotterCard');
  const t = document.getElementById('blotterTable');
  const blotter = window._blotter || [];
  if (!blotter.length) {
    if (inlineEl) inlineEl.style.display = 'none';
    if (card) card.style.display = 'none';
    return;
  }
  if (inlineEl) { inlineEl.style.display = ''; }
  else if (card) { card.style.display = ''; }
  // Risk profile badge in blotter header
  var profileHtml = '';
  if (window._riskProfile && RISK_PROFILES[window._riskProfile]) {
    var rp = RISK_PROFILES[window._riskProfile];
    profileHtml = ' <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:12px;background:'+rp.color+';color:#fff;margin-left:6px;">'+rp.emoji+' '+rp.label+'</span>';
  }
  var blotterTitleEl = document.querySelector('#blotterInline > div > span');
  if (blotterTitleEl && !blotterTitleEl.querySelector('.rp-badge')) {
    var badge = document.createElement('span');
    badge.className = 'rp-badge';
    badge.innerHTML = profileHtml;
    blotterTitleEl.appendChild(badge);
  }
  // Separate sells and buys so we can pair them
  var sells = blotter.filter(function(b){ return b.action === 'SELL'; });
  var buys  = blotter.filter(function(b){ return b.action === 'BUY'; });
  // Build paired display: each SELL immediately followed by its suggested BUY counterpart
  var ordered = [];
  sells.forEach(function(s, si) {
    ordered.push(s);
    if (buys[si]) ordered.push(buys[si]); // pair each sell with the next available buy
  });
  // Any remaining buys not yet paired
  if (buys.length > sells.length) buys.slice(sells.length).forEach(function(b){ ordered.push(b); });
  var html = '<div class="blotter-row header">'
    + '<div>Action</div><div>Ticker / Reason</div>'
    + '<div class="blotter-col-px" style="text-align:right;">Price</div>'
    + '<div style="text-align:right;">$ Notional</div>'
    + '<div class="blotter-col-tax" style="text-align:right;">Shares</div><div></div></div>';
  var buyDol = 0, sellDol = 0;
  ordered.forEach(function(b) {
    var origIdx = blotter.indexOf(b);
    if (b.action === 'BUY') buyDol += b.dollar; else sellDol += b.dollar;
    var actionStyle = b.action === 'BUY'
      ? 'background:rgba(46,125,82,0.12);border-left:3px solid var(--success);'
      : 'background:rgba(178,34,34,0.07);border-left:3px solid var(--danger);';
    html += '<div class="blotter-row" style="'+actionStyle+'">'
      + '<div><span class="blotter-action '+b.action.toLowerCase()+'">'+b.action+'</span></div>'
      + '<div><strong style="color:var(--navy);">'+b.ticker+'</strong> <span style="color:var(--text-sec);font-size:10px;">'+b.sector+'</span>'
      + '<div style="font-size:10px;color:var(--text-sec);margin-top:1px;">'+b.reason+'</div></div>'
      + '<div class="blotter-col-px" style="text-align:right;font-family:Courier New,monospace;">$'+(b.price||0).toFixed(2)+'</div>'
      + '<div style="text-align:right;font-family:Courier New,monospace;font-weight:700;">$'+Math.round(b.dollar).toLocaleString()+'</div>'
      + '<div class="blotter-col-tax" style="text-align:right;font-family:Courier New,monospace;">'+b.shares+'</div>'
      + '<div class="blotter-rm" onclick="blotterRemove('+origIdx+')" title="Remove">×</div>'
      + '</div>';
  });
  t.innerHTML = html;
  var net = buyDol - sellDol;
  document.getElementById('blotterSummary').innerHTML = blotter.length+' trade(s) &middot; Buy $'+Math.round(buyDol).toLocaleString()+' &middot; Sell $'+Math.round(sellDol).toLocaleString()
    + (Math.abs(net) > 1 ? ' &middot; Net: <span style="color:'+(net>0?'var(--danger)':'var(--success)')+'">'+(net>0?'+':'')+fmt(net)+'</span>' : ' &middot; <span style="color:var(--success);">&#10003; Self-funding</span>');
}
function blotterRemove(i) {
  (window._blotter||[]).splice(i,1);
  blotterRender();
}
function blotterClear() {
  window._blotter = [];
  blotterRender();
}
function blotterExportCSV() {
  const blotter = window._blotter || [];
  if (!blotter.length) return;
  const rows = [['Action','Ticker','Sector','Shares','Price','Notional','Reason']];
  blotter.forEach(b => rows.push([b.action,b.ticker,b.sector,b.shares,(b.price||0).toFixed(2),b.dollar.toFixed(0),b.reason]));
  const csv = rows.map(r => r.map(c => '"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\n');
  const blob = new Blob([csv],{type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'perry-trade-blotter-'+new Date().toISOString().slice(0,10)+'.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ────────── Risk Questionnaire + Profile System ──────────
var RISK_PROFILES = {
  conservative: {
    label: 'Conservative', emoji: '🛡️',
    color: '#5B9BD5', driftModel: 'conservative',
    description: 'Preserve wealth. Lower volatility, bonds and defensives over growth.',
    targetAssets: { 'Fixed Income': 50, 'Defensive Equities': 30, 'Cash / Equivalents': 20 }
  },
  moderate: {
    label: 'Moderate', emoji: '⚖️',
    color: '#003C71', driftModel: 'balanced',
    description: 'Steady growth. Balanced between stocks and bonds with manageable drawdowns.',
    targetAssets: { 'Equities': 60, 'Fixed Income': 30, 'Alternatives / Cash': 10 }
  },
  aggressive: {
    label: 'Aggressive Growth', emoji: '🚀',
    color: '#2E7D52', driftModel: 'aggressive_growth',
    description: 'Maximize long-term returns. High equity concentration, tolerates large drawdowns.',
    targetAssets: { 'Equities': 85, 'Alternatives': 10, 'Cash': 5 }
  },
  speculative: {
    label: 'Speculative', emoji: '⚡',
    color: '#A23B72', driftModel: 'aggressive_growth',
    description: 'Maximum risk / reward. Includes leveraged ETFs, crypto, and high-beta names.',
    targetAssets: { 'High-Beta Equities / Crypto': 95, 'Cash': 5 }
  }
};

// Restore persisted risk profile on load (survives refresh — the optimizer,
// rebalancer, and drift model all read window._riskProfile).
try {
  var _savedRiskProfile = localStorage.getItem('perry_risk_profile');
  if (_savedRiskProfile && RISK_PROFILES[_savedRiskProfile]) {
    window._riskProfile = _savedRiskProfile;
    setTimeout(function() {
      var p = RISK_PROFILES[_savedRiskProfile];
      var badge = document.getElementById('riskProfileBadge');
      if (badge && p) { badge.style.display = ''; badge.style.background = p.color; badge.textContent = p.emoji + ' ' + p.label; }
    }, 500);
  }
} catch(e) {}

// Simple dropdown risk-profile selector (replaces the 5-question questionnaire)
window.showRiskQuestionnaire = function() {
  if (document.getElementById('riskQuizModal')) return;
  var current = window._riskProfile || 'moderate';
  var opts = Object.keys(RISK_PROFILES).map(function(k) {
    var p = RISK_PROFILES[k];
    return '<option value="'+k+'"'+(k===current?' selected':'')+'>'+p.emoji+' '+p.label+'</option>';
  }).join('');
  var html = '<div id="riskQuizModal" class="modal-overlay" onclick="if(event.target===this)this.remove()">'
    + '<div class="modal-box" style="max-width:460px;padding:24px;">'
    + '<h3 style="margin:0 0 6px;font-size:16px;color:var(--navy);">&#9881; Target Risk Profile</h3>'
    + '<p style="font-size:12px;color:var(--text-sec);margin:0 0 14px;">Sets the target model used for drift analysis and rebalance recommendations.</p>'
    + '<select id="riskProfileSelect" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:4px;font-size:13px;margin-bottom:10px;">'+opts+'</select>'
    + '<div id="riskProfileDesc" style="font-size:12px;color:var(--text-sec);line-height:1.5;margin-bottom:16px;padding:10px;background:var(--panel);border-radius:4px;"></div>'
    + '<div class="modal-actions">'
    + '<button class="btn" onclick="submitRiskQuestionnaire()">Apply</button>'
    + '<button class="btn-outline" onclick="document.getElementById(\'riskQuizModal\').remove()">Cancel</button>'
    + '</div></div></div>';
  var el = document.createElement('div');
  el.innerHTML = html;
  document.body.appendChild(el.firstChild);
  var updateDesc = function() {
    var k = document.getElementById('riskProfileSelect').value;
    var p = RISK_PROFILES[k];
    document.getElementById('riskProfileDesc').innerHTML = '<strong style="color:'+p.color+';">'+p.label+'</strong> — '+p.description;
  };
  document.getElementById('riskProfileSelect').addEventListener('change', updateDesc);
  updateDesc();
};

window.submitRiskQuestionnaire = function() {
  var sel = document.getElementById('riskProfileSelect');
  if (!sel) return;
  var profileKey = sel.value;
  var profile = RISK_PROFILES[profileKey];
  if (!profile) return;
  window._riskProfile = profileKey;
  try { localStorage.setItem('perry_risk_profile', profileKey); } catch(e) {}
  var driftSel = document.getElementById('driftModel');
  if (driftSel) { driftSel.value = profile.driftModel; if (typeof driftRender === 'function') driftRender(); }
  var badge = document.getElementById('riskProfileBadge');
  if (badge) {
    badge.style.display = '';
    badge.style.background = profile.color;
    badge.textContent = profile.emoji + ' ' + profile.label;
  }
  var poeBadge = document.getElementById('poeProfileBadge');
  if (poeBadge) poeBadge.innerHTML = '<span style="color:'+profile.color+';">'+profile.emoji+' '+profile.label+'</span>';
  var rebCtx = document.getElementById('rebalanceContextPanel');
  if (rebCtx && typeof loadRebalanceContext === 'function') loadRebalanceContext(true);
  var modal = document.getElementById('riskQuizModal');
  if (modal) modal.remove();
};

// ────────── Bloomberg WEI-style Global Snapshot ──────────
const SNAPSHOT_UNIVERSE = [
  { group: 'Equities — US', items: [
    { ticker: 'SPY', label: 'S&P 500' },
    { ticker: 'QQQ', label: 'Nasdaq 100' },
    { ticker: 'IWM', label: 'Russell 2000' },
    { ticker: 'DIA', label: 'Dow 30' }
  ]},
  { group: 'Equities — International', items: [
    { ticker: 'EFA', label: 'Developed ex-US' },
    { ticker: 'EEM', label: 'Emerging Markets' },
    { ticker: 'EWJ', label: 'Japan' },
    { ticker: 'FXI', label: 'China Large-Cap' }
  ]},
  { group: 'Rates & Credit', items: [
    { ticker: 'TLT', label: 'US 20Y+ Treasury' },
    { ticker: 'IEF', label: 'US 7-10Y Treasury' },
    { ticker: 'SHY', label: 'US 1-3Y Treasury' },
    { ticker: 'LQD', label: 'IG Corporate' },
    { ticker: 'HYG', label: 'High Yield' }
  ]},
  { group: 'FX & Dollar', items: [
    { ticker: 'UUP', label: 'USD Index' },
    { ticker: 'FXE', label: 'EUR/USD' },
    { ticker: 'FXY', label: 'JPY/USD' },
    { ticker: 'CYB', label: 'CNY/USD' }
  ]},
  { group: 'Commodities', items: [
    { ticker: 'GLD', label: 'Gold' },
    { ticker: 'SLV', label: 'Silver' },
    { ticker: 'USO', label: 'Crude Oil (WTI)' },
    { ticker: 'UNG', label: 'Natural Gas' },
    { ticker: 'DBA', label: 'Agriculture' }
  ]},
  { group: 'Volatility', items: [
    { ticker: '^VIX', label: 'VIX' },
    { ticker: '^MOVE', label: 'MOVE Index (Bonds)' }
  ]}
];
var _snapTF = '1d'; // active timeframe

function snapshotSetTF(btn, tf) {
  _snapTF = tf;
  document.querySelectorAll('.snap-tf-btn').forEach(function(b) {
    var active = b.dataset.tf === tf;
    b.style.background = active ? 'var(--navy)' : 'var(--panel)';
    b.style.color = active ? '#fff' : 'var(--text-sec)';
    b.style.border = active ? 'none' : '1px solid var(--border)';
  });
  snapshotRenderTF();
}

function snapshotRenderTF() {
  // Re-render existing cached data with new timeframe highlight
  if (!window._snapshotCells || !window._snapshotCells.length) { snapshotLoad(); return; }
  var tf = _snapTF;
  var el = document.getElementById('snapshotGrid');
  if (!el) return;
  // Update each cell's highlighted value
  document.querySelectorAll('.snap-cell').forEach(function(cell) {
    var ticker = cell.querySelector('.snap-ticker');
    if (!ticker) return;
    var sym = ticker.textContent;
    var item = window._snapshotCells.find(function(c) { return c.ticker.replace('^','') === sym || c.ticker === sym; });
    if (!item) return;
    var val = tf === '1d' ? item.changePct : tf === '1w' ? item.change1W : tf === '1m' ? item.change1M : item.change3M;
    var col = val == null ? '#5A6A7A' : val >= 0 ? '#2E7D52' : '#8B2A2A';
    var fmt = val == null ? '—' : (val >= 0 ? '+' : '') + val.toFixed(2) + '%';
    var sub = cell.querySelector('.snap-tf-val');
    if (sub) { sub.textContent = fmt; sub.style.color = col; }
    cell.className = 'snap-cell ' + (val == null ? '' : val >= 0 ? 'up' : 'down');
  });
}

async function snapshotLoad() {
  const el = document.getElementById('snapshotGrid');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;padding:16px;color:#5A6A7A;font-size:12px;"><span class="spinner"></span> Loading...</div>';
  const cells = [];
  let html = '<div class="snapshot-grid">';
  for (const grp of SNAPSHOT_UNIVERSE) {
    html += '<div class="snap-row-header">'+grp.group+'</div>';
    for (const item of grp.items) {
      const cellId = 'snap-'+item.ticker.replace(/[^A-Z0-9]/gi,'_');
      html += '<div class="snap-cell" id="'+cellId+'" onclick="navigateTo(\'research\');document.getElementById(\'researchTicker\') && (document.getElementById(\'researchTicker\').value=\''+item.ticker+'\')">'+
        '<div style="display:flex;justify-content:space-between;align-items:center;">'+
        '<span class="snap-ticker" style="font-size:10px;font-weight:700;color:var(--navy);">'+item.ticker.replace('^','')+'</span>'+
        '<span class="snap-tf-val" style="font-size:10px;font-weight:700;font-family:monospace;">—</span>'+
        '</div>'+
        '<div class="snap-name" style="font-size:9px;color:var(--text-sec);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+item.label+'</div>'+
        '<div class="snap-price" style="font-size:11px;font-weight:700;margin-top:2px;">—</div>'+
        '</div>';
      cells.push({ ...item, id: cellId });
    }
  }
  html += '</div>';
  el.innerHTML = html;

  const results = [];
  await Promise.all(cells.map(async c => {
    try {
      const [q, chart] = await Promise.all([
        fetchQuote(c.ticker),
        fetchChart(c.ticker, '3mo', '1d').catch(function() { return { points: [] }; })
      ]);
      const cell = document.getElementById(c.id);
      if (!cell) return;
      const px = getQuotePrice(q);
      const prev = getQuotePrev(q);
      const chg = px - prev;
      const chgPct = prev > 0 ? chg/prev*100 : 0;
      let chg1W = null, chg1M = null, chg3M = null;
      if (chart.points && chart.points.length > 5) {
        const closes = chart.points.filter(p => p.close != null).map(p => p.close);
        const last = closes[closes.length - 1];
        if (closes.length >= 6)  chg1W = (last - closes[closes.length - 6])  / closes[closes.length - 6]  * 100;
        if (closes.length >= 22) chg1M = (last - closes[closes.length - 22]) / closes[closes.length - 22] * 100;
        if (closes.length >= 63) chg3M = (last - closes[closes.length - 63]) / closes[closes.length - 63] * 100;
      }
      var activeVal = _snapTF === '1d' ? chgPct : _snapTF === '1w' ? chg1W : _snapTF === '1m' ? chg1M : chg3M;
      var col = activeVal == null ? '#5A6A7A' : activeVal >= 0 ? '#2E7D52' : '#8B2A2A';
      var fmt = activeVal == null ? '—' : (activeVal >= 0 ? '+' : '') + activeVal.toFixed(2) + '%';
      cell.className = 'snap-cell ' + (activeVal == null ? '' : activeVal >= 0 ? 'up' : 'down');
      var priceStr = px > 1000 ? px.toLocaleString(undefined,{maximumFractionDigits:0}) : px.toFixed(2);
      cell.querySelector('.snap-price').textContent = priceStr;
      var tfEl = cell.querySelector('.snap-tf-val');
      if (tfEl) { tfEl.textContent = fmt; tfEl.style.color = col; }
      results.push({ ticker: c.ticker, label: c.label, price: px, change: chg, changePct: chgPct, change1W: chg1W, change1M: chg1M, change3M: chg3M });
    } catch(e) {
      const cell = document.getElementById(c.id);
      if (cell) { const p = cell.querySelector('.snap-price'); if (p) p.textContent = 'n/a'; }
    }
  }));
  window._snapshotCells = results;
  if (typeof tlRenderMovingToday === 'function' && document.getElementById('movingToday')) {
    tlRenderMovingToday();
  }
}

// ────────────────────────────────────────────────────────────────────────
// REGIME DISTANCE — Wasserstein-1 + Frobenius + RMT Eigenvalue Analysis
//
// Paper implementations:
//   Wasserstein: Horvath, Issa & Muguruza (2021) "Clustering Market Regimes
//     using the Wasserstein Distance." W₁ between empirical CDFs of rolling
//     returns. Measures full distributional shift (tail behavior, skewness)
//     unlike Frobenius which only captures pairwise correlations.
//
//   RMT / ICR: Molero-González et al. (2024) "The random matrix-based
//     informative content of correlation matrices in stock markets."
//     Marchenko-Pastur upper bound λ_max = σ²(1+1/√q)². Eigenvalues above
//     λ_max carry genuine cross-asset information. ICR = fraction of total
//     eigenvalue mass above the noise floor.
// ────────────────────────────────────────────────────────────────────────

// Wasserstein-1 distance between two sets of returns (1D, empirical CDF approach).
// W₁(P,Q) ≈ (1/N) Σ |F_P⁻¹(i/N) - F_Q⁻¹(i/N)|  (quantile-matching)
function wasserstein1(a, b) {
  if (!a.length || !b.length) return null;
  var sa = a.slice().sort(function(x,y){return x-y;});
  var sb = b.slice().sort(function(x,y){return x-y;});
  // Interpolate to same length
  var n = Math.max(sa.length, sb.length);
  function interp(arr, i, n) {
    var t = i / (n-1) * (arr.length-1);
    var lo = Math.floor(t), hi = Math.ceil(t);
    if (lo === hi) return arr[lo];
    return arr[lo] + (t-lo)*(arr[hi]-arr[lo]);
  }
  var sum = 0;
  for (var i = 0; i < n; i++) { sum += Math.abs(interp(sa,i,n) - interp(sb,i,n)); }
  return sum / n;
}

// Marchenko-Pastur RMT analysis of a correlation matrix.
// Returns: { eigenvalues, lambdaMax, noiseFloor, signalEigenvalues, ICR, nSignal }
// ICR = Informative Content Ratio per Molero-González et al. (2024)
function rmtAnalysis(corrMat, tickers, T) {
  var N = tickers.length;
  var q = T / N;  // ratio of observations to assets
  // Build flat matrix
  var mat = [];
  for (var i = 0; i < N; i++) {
    mat.push([]);
    for (var j = 0; j < N; j++) { mat[i].push(corrMat[tickers[i]][tickers[j]] || 0); }
  }
  // Power-iteration eigenvalue approximation (no LAPACK in browser).
  // We use the trace decomposition: sum of eigenvalues = trace = N.
  // For a 6×6 matrix, we can use the characteristic polynomial approach
  // or power iteration for top eigenvalues. Using power iteration for top-3.
  function matVec(A, v) {
    var n = v.length, r = new Array(n).fill(0);
    for (var i=0;i<n;i++) for (var j=0;j<n;j++) r[i] += A[i][j]*v[j];
    return r;
  }
  function norm(v) { return Math.sqrt(v.reduce(function(s,x){return s+x*x;},0)); }
  function normalize(v) { var n=norm(v); return v.map(function(x){return x/n;}); }
  function deflate(A, lambda, v) {
    var n=v.length, B=[];
    for (var i=0;i<n;i++){B.push([]);for(var j=0;j<n;j++)B[i].push(A[i][j]-lambda*v[i]*v[j]);}
    return B;
  }
  var eigenvalues = [];
  var workMat = mat.map(function(r){return r.slice();});
  var numEig = Math.min(N, 6);
  for (var e=0; e<numEig; e++) {
    var vec = new Array(N).fill(0).map(function(_,i){return i===e?1:0.1;});
    vec = normalize(vec);
    for (var it=0; it<80; it++) {
      vec = normalize(matVec(workMat, vec));
    }
    var Av = matVec(workMat, vec);
    var lambda = vec.reduce(function(s,v,i){return s+v*Av[i];},0);
    eigenvalues.push(Math.max(0, lambda));
    workMat = deflate(workMat, lambda, vec);
  }
  // Pad remaining eigenvalues from trace conservation: trace = N
  var sumTop = eigenvalues.reduce(function(s,v){return s+v;},0);
  var remaining = Math.max(0, N - sumTop) / Math.max(1, N - numEig);
  for (var r=numEig; r<N; r++) eigenvalues.push(remaining);
  eigenvalues.sort(function(a,b){return b-a;});

  // Marchenko-Pastur upper bound (σ²=1 since correlation matrix)
  var lambdaMax = Math.pow(1 + 1/Math.sqrt(q), 2);
  var lambdaMin = Math.pow(1 - 1/Math.sqrt(q), 2);
  var noiseEigs = eigenvalues.filter(function(l){return l <= lambdaMax;});
  var signalEigs = eigenvalues.filter(function(l){return l > lambdaMax;});
  var noiseMean = noiseEigs.length ? noiseEigs.reduce(function(s,v){return s+v;},0)/noiseEigs.length : 1;
  var totalVar = eigenvalues.reduce(function(s,v){return s+v;},0);
  var signalVar = signalEigs.reduce(function(s,v){return s+v;},0);
  var ICR = totalVar > 0 ? signalVar/totalVar : 0;

  return {
    eigenvalues: eigenvalues,
    lambdaMax: lambdaMax,
    lambdaMin: lambdaMin,
    noiseMean: noiseMean,
    signalEigenvalues: signalEigs,
    noiseEigenvalues: noiseEigs,
    ICR: ICR,
    nSignal: signalEigs.length,
    totalVar: totalVar,
    signalVar: signalVar,
    q: q, N: N, T: T
  };
}

async function regimeDistanceRun() {
  var el = document.getElementById('regDistResults');
  if (!el) return;
  el.innerHTML = '<span class="spinner"></span> Loading cross-asset data for Wasserstein + RMT analysis…';
  var win = parseInt(document.getElementById('regDistWin').value) || 60;
  var universe = ['SPY','TLT','GLD','UUP','USO','HYG'];
  try {
    var data = {};
    await Promise.all(universe.map(async function(t) {
      try {
        var c = await fetchChart(t, '1y', '1d');
        data[t] = c.points.map(function(p){return {date:p.date.slice(0,10),close:p.close};});
      } catch(e) { data[t] = []; }
    }));
    var valid = universe.filter(function(t){return data[t] && data[t].length > win+5;});
    if (valid.length < 4) { el.innerHTML='<p style="color:var(--danger);">Insufficient data.</p>'; return; }

    // Align on common dates, compute log returns
    var allDates = data[valid[0]].map(function(p){return p.date;});
    var aligned = {};
    valid.forEach(function(t){ var map={}; data[t].forEach(function(p){map[p.date]=p.close;}); aligned[t]=allDates.map(function(d){return map[d]||null;}); });
    var returns = {};
    valid.forEach(function(t){
      var r=[]; var a=aligned[t];
      for (var i=1;i<a.length;i++){ if(a[i-1]&&a[i]) r.push(Math.log(a[i]/a[i-1])); else r.push(null); }
      returns[t]=r;
    });

    // Current window returns (last `win` valid observations per asset)
    var curReturns = {};
    valid.forEach(function(t){
      curReturns[t] = returns[t].filter(function(v){return v!=null;}).slice(-win);
    });

    // ── Correlation matrix (current window) ──
    var curMat = corrMatrix(returns, valid, returns[valid[0]].length - win, returns[valid[0]].length);

    // ── RMT analysis ──
    var T = win, N = valid.length;
    var rmt = rmtAnalysis(curMat, valid, T);
    // Store ICR globally so the Master Verdict can use it as a diversification modifier
    window._rmtICR = rmt.ICR;

    // ── Stylized reference regime return distributions (parametric) ──
    // For Wasserstein we define reference distributions by their moments
    // (mean daily return, std, skew) from documented regime statistics.
    var REF_DISTS = {
      '2008 GFC':          { SPY:{mu:-0.0025,sig:0.026,skew:-1.2}, TLT:{mu:0.0018,sig:0.012,skew:0.3}, GLD:{mu:0.0005,sig:0.017,skew:0.1}, UUP:{mu:0.0012,sig:0.007,skew:0.2}, USO:{mu:-0.0030,sig:0.035,skew:-0.8}, HYG:{mu:-0.0020,sig:0.020,skew:-1.0} },
      '2020 COVID':        { SPY:{mu:-0.0060,sig:0.045,skew:-2.1}, TLT:{mu:0.0010,sig:0.020,skew:0.5}, GLD:{mu:-0.0005,sig:0.022,skew:-0.2}, UUP:{mu:0.0008,sig:0.008,skew:0.4}, USO:{mu:-0.0100,sig:0.060,skew:-1.5}, HYG:{mu:-0.0045,sig:0.030,skew:-1.8} },
      '2022 Inflation':    { SPY:{mu:-0.0015,sig:0.018,skew:-0.6}, TLT:{mu:-0.0022,sig:0.016,skew:-0.3}, GLD:{mu:0.0000,sig:0.012,skew:0.0}, UUP:{mu:0.0005,sig:0.005,skew:0.1}, USO:{mu:0.0010,sig:0.025,skew:0.4}, HYG:{mu:-0.0012,sig:0.010,skew:-0.5} },
      'Bull Market':       { SPY:{mu:0.0008,sig:0.010,skew:0.1},  TLT:{mu:-0.0002,sig:0.008,skew:0.0}, GLD:{mu:0.0002,sig:0.009,skew:0.0}, UUP:{mu:-0.0002,sig:0.004,skew:0.0}, USO:{mu:0.0005,sig:0.015,skew:0.2}, HYG:{mu:0.0005,sig:0.006,skew:0.1} }
    };
    // Generate synthetic return series from parametric distributions (Box-Muller)
    function syntheticReturns(mu, sig, skew, n) {
      var r = [];
      for (var i=0;i<n;i++){
        var u1=Math.random(), u2=Math.random();
        var z = Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2);
        // Cornish-Fisher skewness adjustment
        var z_cf = z + (skew/6)*(z*z-1);
        r.push(mu + sig*z_cf);
      }
      return r;
    }

    // Compute Wasserstein-1 distances (average across assets)
    var wassersteinDists = {};
    Object.keys(REF_DISTS).forEach(function(regime){
      var dists = [];
      valid.forEach(function(t){
        var refDist = REF_DISTS[regime][t];
        if (!refDist) return;
        var refSeries = syntheticReturns(refDist.mu, refDist.sig, refDist.skew, win);
        var curSeries = curReturns[t];
        var d = wasserstein1(curSeries, refSeries);
        if (d != null) dists.push(d);
      });
      wassersteinDists[regime] = dists.length ? dists.reduce(function(s,v){return s+v;},0)/dists.length : 999;
    });

    // Compute Frobenius distances (on correlation matrices, for comparison)
    var REF_MATS = {
      '2008 GFC':       stylizedMatrix(valid, {'SPY-HYG':0.85,'SPY-TLT':-0.45,'SPY-GLD':-0.10,'SPY-UUP':-0.55,'SPY-USO':0.40,'TLT-HYG':-0.35,'TLT-GLD':0.25,'TLT-UUP':0.30}),
      '2020 COVID':     stylizedMatrix(valid, {'SPY-HYG':0.80,'SPY-TLT':-0.30,'SPY-GLD':0.30,'SPY-UUP':-0.20,'SPY-USO':0.65,'TLT-HYG':-0.20,'TLT-GLD':0.10,'TLT-UUP':-0.10}),
      '2022 Inflation': stylizedMatrix(valid, {'SPY-HYG':0.70,'SPY-TLT':0.55,'SPY-GLD':0.20,'SPY-UUP':-0.40,'SPY-USO':0.20,'TLT-HYG':0.55,'TLT-GLD':0.10,'TLT-UUP':-0.40}),
      'Bull Market':    stylizedMatrix(valid, {'SPY-HYG':0.45,'SPY-TLT':-0.25,'SPY-GLD':0.05,'SPY-UUP':-0.15,'SPY-USO':0.25,'TLT-HYG':0.10,'TLT-GLD':0.15,'TLT-UUP':0.05})
    };
    var frobDists = {};
    Object.keys(REF_MATS).forEach(function(regime){ frobDists[regime]=frobeniusDistance(curMat,REF_MATS[regime],valid); });

    // Sort by Wasserstein
    var wSorted = Object.keys(wassersteinDists).sort(function(a,b){return wassersteinDists[a]-wassersteinDists[b];});
    var closest = wSorted[0];
    var wMin = wassersteinDists[wSorted[0]], wMax = wassersteinDists[wSorted[wSorted.length-1]];

    // ICR interpretation
    var icrLabel, icrColor;
    if (rmt.ICR >= 0.5)      { icrLabel='High Structure (≥50% signal)';  icrColor=C.danger; }
    else if (rmt.ICR >= 0.3) { icrLabel='Moderate Structure';              icrColor='#8B6914'; }
    else                     { icrLabel='Low Structure (Noise-Dominated)'; icrColor=C.success; }
    // High ICR = market is highly structured/correlated = diversification is low = warning

    var html = '';

    // ── Header: Wasserstein closest analogue ──
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">';

    // Wasserstein panel
    html += '<div style="background:var(--navy);color:#fff;border-radius:4px;padding:12px 16px;">';
    html += '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.8px;opacity:.7;margin-bottom:4px;">Wasserstein-1 Closest Analogue</div>';
    html += '<div style="font-size:20px;font-weight:800;">' + closest + '</div>';
    html += '<div style="font-size:11px;opacity:.75;margin-top:4px;">W₁ = ' + wassersteinDists[closest].toFixed(5) + ' · Avg across ' + valid.length + ' assets</div>';
    html += '<div style="font-size:10px;opacity:.6;margin-top:3px;">Measures full distributional shift incl. tails &amp; skew (Horvath et al. 2021)</div>';
    html += '</div>';

    // RMT panel
    html += '<div style="background:var(--panel);border:1px solid var(--border);border-left:4px solid '+icrColor+';border-radius:4px;padding:12px 16px;">';
    html += '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--text-sec);margin-bottom:4px;">RMT Informative Content Ratio (ICR)</div>';
    html += '<div style="font-size:28px;font-weight:800;color:'+icrColor+';">' + (rmt.ICR*100).toFixed(1) + '%</div>';
    html += '<div style="font-size:11px;color:'+icrColor+';font-weight:600;">' + icrLabel + '</div>';
    html += '<div style="font-size:10.5px;color:var(--text-sec);margin-top:4px;">' + rmt.nSignal + ' of ' + rmt.N + ' eigenvalues above MP noise ceiling (λ_max=' + rmt.lambdaMax.toFixed(3) + ')</div>';
    html += '<div style="font-size:10px;color:var(--text-sec);margin-top:2px;">High ICR = structured regime, genuine cross-asset factor exposure. Low ICR = returns are uncorrelated noise.</div>';
    html += '</div>';
    html += '</div>';

    // ── Wasserstein distance bars ──
    html += '<div style="margin-bottom:14px;">';
    html += '<div style="font-size:11px;font-weight:700;color:var(--text-sec);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Wasserstein-1 Distance by Regime (lower = closer)</div>';
    wSorted.forEach(function(regime) {
      var d = wassersteinDists[regime];
      var pct = wMax > wMin ? ((d-wMin)/(wMax-wMin))*100 : 50;
      var isClosest = regime === closest;
      html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">';
      html += '<div style="width:130px;font-size:11px;font-weight:'+(isClosest?700:400)+';color:var(--'+(isClosest?'navy':'text-sec')+');">' + regime + (isClosest?' ✓':'') + '</div>';
      html += '<div style="flex:1;background:var(--border);border-radius:2px;height:8px;overflow:hidden;">';
      html += '<div style="width:'+pct+'%;height:100%;background:'+(isClosest?C.navy:C.blue)+';border-radius:2px;"></div></div>';
      html += '<div style="width:70px;text-align:right;font-size:11px;font-family:monospace;">' + d.toFixed(5) + '</div>';
      html += '<div style="width:60px;text-align:right;font-size:10px;color:var(--text-sec);">Frob: '+frobDists[regime].toFixed(3)+'</div>';
      html += '</div>';
    });
    html += '</div>';

    // ── RMT Eigenvalue spectrum ──
    html += '<div style="margin-bottom:14px;">';
    html += '<div style="font-size:11px;font-weight:700;color:var(--text-sec);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Eigenvalue Spectrum vs. Marchenko-Pastur Noise Ceiling (λ_max=' + rmt.lambdaMax.toFixed(3) + ')</div>';
    html += '<div style="display:flex;gap:4px;align-items:flex-end;height:60px;">';
    var maxEig = rmt.eigenvalues[0] || 1;
    rmt.eigenvalues.forEach(function(lam, i) {
      var isSignal = lam > rmt.lambdaMax;
      var h = Math.round((lam/maxEig)*56);
      html += '<div title="λ'+(i+1)+'='+lam.toFixed(3)+' '+(isSignal?'(SIGNAL)':'(NOISE)')+'" style="flex:1;height:'+h+'px;background:'+(isSignal?C.navy:C.blue)+';opacity:'+(isSignal?1:0.35)+';border-radius:2px 2px 0 0;position:relative;"></div>';
    });
    html += '</div>';
    html += '<div style="display:flex;gap:4px;">';
    rmt.eigenvalues.forEach(function(lam,i){ html += '<div style="flex:1;text-align:center;font-size:8.5px;color:var(--text-sec);">λ'+(i+1)+'<br>'+lam.toFixed(2)+'</div>'; });
    html += '</div>';
    html += '<div style="font-size:10px;color:var(--text-sec);margin-top:4px;"><span style="display:inline-block;width:10px;height:10px;background:'+C.navy+';border-radius:1px;margin-right:4px;"></span>Signal &nbsp; <span style="display:inline-block;width:10px;height:10px;background:'+C.blue+';opacity:.35;border-radius:1px;margin-right:4px;"></span>Noise (MP floor)</div>';
    html += '</div>';

    // ── Current correlation matrix ──
    html += '<div style="font-size:11px;font-weight:700;color:var(--text-sec);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Current '+win+'-Day Correlation Matrix (RMT-contextualized)</div>';
    html += '<div style="overflow-x:auto;"><table class="corr-matrix"><thead><tr><th></th>';
    valid.forEach(function(t){html+='<th>'+t+'</th>';});
    html += '</tr></thead><tbody>';
    for (var i=0;i<valid.length;i++) {
      html += '<tr><td>'+valid[i]+'</td>';
      for (var j=0;j<valid.length;j++) {
        var v = curMat[valid[i]][valid[j]];
        var ci = Math.abs(v);
        var bg = v>=0 ? 'rgba(0,60,113,'+(ci*0.85+0.05).toFixed(2)+')' : 'rgba(139,42,42,'+(ci*0.85+0.05).toFixed(2)+')';
        var fg = ci>0.55?'#fff':'#1A2733';
        html += '<td style="background:'+bg+';color:'+fg+';">'+v.toFixed(2)+'</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    html += '<p style="font-size:10.5px;color:var(--text-sec);margin-top:8px;line-height:1.5;">Wasserstein-1 distance measures the earth-mover cost of transforming today\'s return distribution into each reference regime\'s distribution — capturing tail shifts and skewness changes that pure correlation analysis misses. ICR = fraction of total eigenvalue variance above the Marchenko-Pastur noise ceiling; interpretation: high ICR means the market is in a structured, factor-driven regime with genuine cross-asset co-movement. Low ICR means assets are moving independently (noise-dominated), which is typically a calm, mid-cycle condition.</p>';

    el.innerHTML = html;
  } catch(e) {
    el.innerHTML = '<p style="color:var(--danger);">Regime distance failed: '+e.message+'</p>';
    console.error('[regimeDistance]', e);
  }
}

function corrMatrix(returns, tickers, sIdx, eIdx) {
  var m = {};
  tickers.forEach(function(t1) {
    m[t1] = {};
    tickers.forEach(function(t2) {
      var r1 = returns[t1].slice(sIdx, eIdx).filter(function(v,i){ return v!=null && returns[t2][sIdx+i]!=null; });
      var r2 = returns[t2].slice(sIdx, eIdx).filter(function(v,i){ return v!=null && returns[t1][sIdx+i]!=null; });
      var n = Math.min(r1.length, r2.length);
      if (n < 5) { m[t1][t2] = 0; return; }
      var m1 = r1.slice(0,n).reduce(function(s,v){return s+v;},0)/n;
      var m2 = r2.slice(0,n).reduce(function(s,v){return s+v;},0)/n;
      var cov=0,v1=0,v2=0;
      for (var i=0;i<n;i++){ cov+=(r1[i]-m1)*(r2[i]-m2); v1+=(r1[i]-m1)*(r1[i]-m1); v2+=(r2[i]-m2)*(r2[i]-m2); }
      m[t1][t2] = (v1>0&&v2>0) ? cov/Math.sqrt(v1*v2) : 0;
    });
  });
  return m;
}
function stylizedMatrix(tickers, pairs) {
  var m = {};
  tickers.forEach(function(t1){ m[t1]={}; tickers.forEach(function(t2){ m[t1][t2]=t1===t2?1.0:0.0; }); });
  Object.keys(pairs).forEach(function(k){ var ab=k.split('-'); if(m[ab[0]]&&m[ab[0]][ab[1]]!=null){ m[ab[0]][ab[1]]=pairs[k]; m[ab[1]][ab[0]]=pairs[k]; } });
  return m;
}
function frobeniusDistance(m1, m2, tickers) {
  var sum=0, count=0;
  for (var i=0;i<tickers.length;i++) for (var j=i+1;j<tickers.length;j++) {
    var a=m1[tickers[i]][tickers[j]]||0, b=m2[tickers[i]][tickers[j]]||0;
    sum+=(a-b)*(a-b); count++;
  }
  return Math.sqrt(sum/Math.max(count,1));
}

// ═══════════════════════════════════════════════════════════════════
// ════  CROSS-ASSET ANALYSIS — FEAR/GREED + HEATMAP + LEAD/LAG + MOMENTUM ════
// ═══════════════════════════════════════════════════════════════════

var WORKER_URL_CA = 'https://perry-finance-proxy.zachperrybusiness.workers.dev';

// ── FEAR/GREED COMPOSITE ──────────────────────────────────────────
window.mktLoadFearGreed = async function() {
  var el = document.getElementById('mktFGResult');
  el.innerHTML = '<span class="spinner"></span> Computing 7-signal composite…';
  try {
    // Fetch all needed series in parallel
    var tickers = ['SPY', 'QQQ', 'TLT', 'GLD', 'HYG', 'LQD', 'VIX'];
    var charts = {};
    await Promise.all(['SPY','QQQ','TLT','GLD','HYG','LQD'].map(async function(t) {
      try {
        var r = await fetch(WORKER_URL_CA + '/chart?symbol=' + t + '&range=1y&interval=1d');
        var d = await r.json();
        charts[t] = (d.points || []).filter(function(p) { return p.close != null; });
      } catch(e) { charts[t] = []; }
    }));
    var vixR = await fetch(WORKER_URL_CA + '/quote?symbol=%5EVIX').then(function(r){return r.json();});
    var vixCur = vixR.current || vixR.price || 20;

    function closes(t) { return (charts[t] || []).map(function(p) { return p.close; }); }
    function last(arr) { return arr[arr.length - 1]; }
    function pctChange(arr, n) {
      if (arr.length < n + 1) return 0;
      return (arr[arr.length-1] - arr[arr.length-1-n]) / arr[arr.length-1-n];
    }
    function sma(arr, n) {
      if (arr.length < n) return arr[arr.length-1] || 0;
      return arr.slice(-n).reduce(function(s,v){return s+v;}, 0) / n;
    }
    function normalize(val, minV, maxV) {
      if (maxV === minV) return 50;
      return Math.max(0, Math.min(100, (val - minV) / (maxV - minV) * 100));
    }
    function rollingVals(arr, fn, window) {
      var vals = [];
      for (var i = window; i < arr.length; i++) vals.push(fn(arr.slice(0, i+1)));
      return vals;
    }

    var spyC = closes('SPY');
    var tltC = closes('TLT');
    var gldC = closes('GLD');
    var hygC = closes('HYG');
    var lqdC = closes('LQD');
    var qqqC = closes('QQQ');

    if (spyC.length < 20) { el.innerHTML = '<span style="color:var(--danger);">Insufficient data — try again.</span>'; return; }

    // Signal 1: VIX level (inverted — high VIX = fear)
    var vixSig = 100 - normalize(vixCur, 10, 45);

    // Signal 2: VIX vs 20D SMA (VIX below SMA = greed)
    var vixHist = [];
    try {
      var vixHR = await fetch(WORKER_URL_CA + '/chart?symbol=%5EVIX&range=3mo&interval=1d').then(function(r){return r.json();});
      vixHist = (vixHR.points || []).filter(function(p){return p.close!=null;}).map(function(p){return p.close;});
    } catch(e) {}
    var vixSma20 = vixHist.length >= 20 ? vixHist.slice(-20).reduce(function(s,v){return s+v;},0)/20 : vixCur;
    var vixVsSma = vixSma20 > 0 ? vixCur / vixSma20 : 1;
    var vixSmaSig = 100 - normalize(vixVsSma, 0.7, 1.5);

    // Signal 3: SPY vs 52W high (momentum — distance from high = fear)
    var spy52High = Math.max.apply(null, spyC);
    var spyDist = (last(spyC) - spy52High) / spy52High; // negative
    var spyDistSig = normalize(spyDist, -0.35, 0);

    // Signal 4: TLT vs SPY 20D relative return (safe haven demand = fear)
    var tltRel20 = spyC.length >= 20 && tltC.length >= 20 ? pctChange(tltC, 20) - pctChange(spyC, 20) : 0;
    var safeHavenSig = 100 - normalize(tltRel20, -0.08, 0.08);

    // Signal 5: GLD vs SPY 20D relative return (gold > stocks = fear)
    var gldRel20 = spyC.length >= 20 && gldC.length >= 20 ? pctChange(gldC, 20) - pctChange(spyC, 20) : 0;
    var goldSig = 100 - normalize(gldRel20, -0.06, 0.06);

    // Signal 6: HYG/LQD spread proxy (HYG underperforms LQD = credit stress = fear)
    var hygLqdRel = hygC.length >= 20 && lqdC.length >= 20 ? pctChange(hygC, 20) - pctChange(lqdC, 20) : 0;
    var creditSig = normalize(hygLqdRel, -0.05, 0.05);

    // Signal 7: QQQ vs SPY 20D (QQQ leads in risk-on)
    var riskAppetite = qqqC.length >= 20 && spyC.length >= 20 ? pctChange(qqqC, 20) - pctChange(spyC, 20) : 0;
    var riskAppSig = normalize(riskAppetite, -0.05, 0.05);

    var signals = [
      { name: 'VIX Level', score: vixSig, desc: 'Current: ' + vixCur.toFixed(1), icon: '📊' },
      { name: 'VIX vs 20D SMA', score: vixSmaSig, desc: vixVsSma.toFixed(2) + 'x ratio', icon: '📈' },
      { name: 'SPY vs 52W High', score: spyDistSig, desc: (spyDist * 100).toFixed(1) + '% from peak', icon: '🏔️' },
      { name: 'Safe-Haven Demand', score: safeHavenSig, desc: 'TLT/SPY 20D rel: ' + (tltRel20*100).toFixed(1) + '%', icon: '🛡️' },
      { name: 'Gold Demand', score: goldSig, desc: 'GLD/SPY 20D rel: ' + (gldRel20*100).toFixed(1) + '%', icon: '🥇' },
      { name: 'Credit Risk Appetite', score: creditSig, desc: 'HYG/LQD 20D rel: ' + (hygLqdRel*100).toFixed(1) + '%', icon: '💳' },
      { name: 'Risk Appetite (QQQ vs SPY)', score: riskAppSig, desc: 'QQQ/SPY 20D rel: ' + (riskAppetite*100).toFixed(1) + '%', icon: '🚀' }
    ];
    var composite = signals.reduce(function(s, sg) { return s + sg.score; }, 0) / signals.length;
    var compLabel, compColor;
    // Brand palette: navy=extreme fear, blue=fear, warning=neutral, danger shades=greed
    if (composite >= 75) { compLabel = 'Extreme Greed'; compColor = '#8B2A2A'; }
    else if (composite >= 60) { compLabel = 'Greed'; compColor = '#8B6914'; }
    else if (composite >= 45) { compLabel = 'Neutral'; compColor = '#5A6A7A'; }
    else if (composite >= 25) { compLabel = 'Fear'; compColor = '#5B9BD5'; }
    else { compLabel = 'Extreme Fear'; compColor = '#003C71'; }

    // Gauge HTML
    var gaugeAngle = ((composite / 100) * 180) - 90; // -90 to +90 degrees
    var html = '<div style="display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start;font-family:Arial,Helvetica,sans-serif;">';
    // Gauge
    html += '<div style="text-align:center;min-width:180px;">';
    html += '<svg viewBox="0 0 200 120" width="180" height="110" style="overflow:visible;">';
    // Background arc
    html += '<path d="M 20 100 A 80 80 0 0 1 180 100" stroke="#eee" stroke-width="16" fill="none" stroke-linecap="round"/>';
    // Colored arcs
    // Brand arc colors: navy (extreme fear) → blue (fear) → gray (neutral) → warning (greed) → danger (extreme greed)
    html += '<path d="M 20 100 A 80 80 0 0 1 60 30" stroke="#003C71" stroke-width="16" fill="none" stroke-linecap="round" opacity="0.9"/>';
    html += '<path d="M 60 30 A 80 80 0 0 1 100 20" stroke="#5B9BD5" stroke-width="16" fill="none" stroke-linecap="round" opacity="0.9"/>';
    html += '<path d="M 100 20 A 80 80 0 0 1 140 30" stroke="#8B6914" stroke-width="16" fill="none" stroke-linecap="round" opacity="0.9"/>';
    html += '<path d="M 140 30 A 80 80 0 0 1 180 100" stroke="#8B2A2A" stroke-width="16" fill="none" stroke-linecap="round" opacity="0.9"/>';
    // Needle
    var needleRad = (gaugeAngle - 90) * Math.PI / 180;
    var nx = 100 + 70 * Math.cos(needleRad); var ny = 100 + 70 * Math.sin(needleRad);
    html += '<line x1="100" y1="100" x2="' + nx.toFixed(1) + '" y2="' + ny.toFixed(1) + '" stroke="' + compColor + '" stroke-width="3" stroke-linecap="round"/>';
    html += '<circle cx="100" cy="100" r="6" fill="' + compColor + '"/>';
    html += '</svg>';
    html += '<div style="font-size:28px;font-weight:800;color:' + compColor + ';">' + Math.round(composite) + '</div>';
    html += '<div style="font-size:14px;font-weight:700;color:' + compColor + ';">' + compLabel + '</div>';
    html += '<div style="font-size:10.5px;color:var(--text-sec);margin-top:4px;">0 = Extreme Fear &nbsp;|&nbsp; 100 = Extreme Greed</div>';
    html += '</div>';
    // Signal breakdown
    html += '<div style="flex:1;min-width:240px;">';
    html += '<div style="font-size:11px;font-weight:700;color:#003C71;margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px;font-family:Arial,sans-serif;">Signal Breakdown</div>';
    signals.forEach(function(sg) {
      var sc = sg.score;
      var barColor = sc >= 75 ? '#8B2A2A' : sc >= 60 ? '#8B6914' : sc >= 45 ? '#5A6A7A' : sc >= 25 ? '#5B9BD5' : '#003C71';
      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px;">';
      html += '<span style="font-size:14px;">' + sg.icon + '</span>';
      html += '<div style="flex:1;min-width:0;">';
      html += '<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px;">';
      html += '<span style="font-weight:600;">' + sg.name + '</span><span style="font-family:Courier New;font-weight:700;color:' + barColor + ';">' + sg.score.toFixed(0) + '</span>';
      html += '</div>';
      html += '<div style="height:6px;background:#eee;border-radius:3px;overflow:hidden;">';
      html += '<div style="height:100%;width:' + sg.score.toFixed(0) + '%;background:' + barColor + ';border-radius:3px;transition:width 0.5s;"></div></div>';
      html += '<div style="font-size:10px;color:var(--text-sec);">' + sg.desc + '</div>';
      html += '</div></div>';
    });
    html += '</div></div>';
    el.innerHTML = html;
  } catch(e) {
    el.innerHTML = '<span style="color:var(--danger);">Error: ' + e.message + '</span>';
    console.error('[FearGreed]', e);
  }
};

// ── ASSET CLASS RETURN HEATMAP ─────────────────────────────────────
var HEATMAP_ASSETS = [
  {t:'SPY', l:'US Equity (SPY)'}, {t:'QQQ', l:'US Tech (QQQ)'},
  {t:'IWM', l:'US Small Cap (IWM)'}, {t:'EFA', l:'Intl Dev. (EFA)'},
  {t:'EEM', l:'Emerging Mkts (EEM)'}, {t:'TLT', l:'Long Bonds (TLT)'},
  {t:'IEF', l:'Int. Bonds (IEF)'}, {t:'LQD', l:'IG Credit (LQD)'},
  {t:'HYG', l:'HY Credit (HYG)'}, {t:'GLD', l:'Gold (GLD)'},
  {t:'USO', l:'Oil (USO)'}, {t:'VNQ', l:'REITs (VNQ)'}
];
window.mktLoadReturnHeatmap = async function() {
  var el = document.getElementById('mktReturnHeatmap');
  el.innerHTML = '<span class="spinner"></span> Fetching 12 asset classes…';
  try {
    var charts = {};
    await Promise.all(HEATMAP_ASSETS.map(async function(a) {
      try {
        var r = await fetch(WORKER_URL_CA + '/chart?symbol=' + a.t + '&range=1y&interval=1d');
        var d = await r.json();
        charts[a.t] = (d.points || []).filter(function(p){return p.close!=null;});
      } catch(e) { charts[a.t] = []; }
    }));
    var today = new Date();
    function ytdStart() { return new Date(today.getFullYear(), 0, 1); }
    function retOverDays(arr, n) {
      if (!arr || arr.length < 2) return null;
      const eff = Math.min(n, arr.length - 1);
      const a = arr[arr.length - 1 - eff].close, b = arr[arr.length-1].close;
      if (!a || a <= 0) return null;
      return (b - a) / a * 100;
    }
    function ytdRet(arr) {
      if (!arr || arr.length < 2) return null;
      const ysStr = ytdStart().toISOString().slice(0,10);
      const start = arr.find(function(p){ return p.date >= ysStr; });
      if (!start) return null;
      return (arr[arr.length-1].close - start.close) / start.close * 100;
    }
    const periods = [{l:'1W',d:5},{l:'1M',d:21},{l:'3M',d:63},{l:'6M',d:126},{l:'YTD',d:-1},{l:'1Y',d:252}];
    const rows = HEATMAP_ASSETS.map(function(a) {
      const pts = charts[a.t] || [];
      const rets = periods.map(function(p) { return p.d === -1 ? ytdRet(pts) : retOverDays(pts, p.d); });
      const ytdVal = rets[4];
      return { label: a.l, ticker: a.t, rets: rets, ytd: ytdVal };
    }).sort(function(a, b) { return (b.ytd || -999) - (a.ytd || -999); }); // sort by YTD desc

    // Brand-compliant heat colors: success green -> white -> danger red
    // Matte, no neon/saturation
    function heatColor(v) {
      if (v == null) return 'background:#F4F6F9;color:#5A6A7A;';
      var abs = Math.abs(v);
      if (v > 0) {
        // Positive: white -> muted green (#2E7D52)
        var t = Math.min(abs / 20, 1);
        var r = Math.round(255 - t * (255 - 46));
        var g = Math.round(255 - t * (255 - 125));
        var b = Math.round(255 - t * (255 - 82));
        var textCol = t > 0.55 ? '#FFFFFF' : '#000000';
        return 'background:rgb(' + r + ',' + g + ',' + b + ');color:' + textCol + ';';
      } else {
        // Negative: white -> muted danger (#8B2A2A)
        var t2 = Math.min(abs / 20, 1);
        var r2 = Math.round(255 - t2 * (255 - 139));
        var g2 = Math.round(255 - t2 * (255 - 42));
        var b2 = Math.round(255 - t2 * (255 - 42));
        var textCol2 = t2 > 0.55 ? '#FFFFFF' : '#000000';
        return 'background:rgb(' + r2 + ',' + g2 + ',' + b2 + ');color:' + textCol2 + ';';
      }
    }
    var html = '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;">';
    html += '<thead><tr style="background:#003C71;color:#FFFFFF;font-family:Arial,sans-serif;">';
    html += '<th style="padding:9px 10px;text-align:left;position:sticky;left:0;background:#003C71;font-size:12px;font-weight:600;">Asset Class</th>';
    periods.forEach(function(p) { html += '<th style="padding:9px 10px;text-align:center;font-size:12px;font-weight:600;">' + p.l + '</th>'; });
    html += '</tr></thead><tbody>';
    rows.forEach(function(row, ri) {
      html += '<tr style="border-bottom:1px solid var(--border-light,#E5E9EF);">';
      html += '<td style="padding:7px 10px;font-weight:700;white-space:nowrap;position:sticky;left:0;background:#FFFFFF;color:#003C71;font-family:Arial,sans-serif;font-size:12px;">' + row.label + '</td>';
      row.rets.forEach(function(v) {
        html += '<td style="padding:6px 8px;text-align:center;font-family:Courier New,monospace;font-weight:700;' + heatColor(v) + '">';
        html += v != null ? (v >= 0 ? '+' : '') + v.toFixed(1) + '%' : '—';
        html += '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    html += '<div style="font-size:11px;color:#5A6A7A;margin-top:8px;font-family:Arial,sans-serif;">Green = positive return, Red = negative. Sorted by YTD return (best to worst). Intensity scales with magnitude (20% = full saturation).</div>';
    el.innerHTML = html;
  } catch(e) {
    el.innerHTML = '<span style="color:var(--danger);">Error: ' + e.message + '</span>';
  }
};

// ── LEAD/LAG ANALYSIS ─────────────────────────────────────────────
window.mktRunLeadLag = async function() {
  var assetA = document.getElementById('lagAssetA').value;
  var assetB = document.getElementById('lagAssetB').value;
  var lookback = parseInt(document.getElementById('lagLookback').value) || 252;
  var el = document.getElementById('mktLeadLagResult');
  var wrap = document.getElementById('mktLeadLagWrap');
  el.innerHTML = '<span class="spinner"></span> Computing cross-correlation…';
  if (wrap) wrap.style.display = 'none';
  try {
    var [dA, dB] = await Promise.all([
      fetch(WORKER_URL_CA + '/chart?symbol=' + assetA + '&range=' + (lookback > 252 ? '2y' : '1y') + '&interval=1d').then(function(r){return r.json();}),
      fetch(WORKER_URL_CA + '/chart?symbol=' + assetB + '&range=' + (lookback > 252 ? '2y' : '1y') + '&interval=1d').then(function(r){return r.json();})
    ]);
    var ptsA = (dA.points||[]).filter(function(p){return p.close!=null;});
    var ptsB = (dB.points||[]).filter(function(p){return p.close!=null;});
    if (ptsA.length < 30 || ptsB.length < 30) { el.innerHTML = '<span style="color:var(--danger);">Insufficient data.</span>'; return; }
    // Build date-aligned returns
    var mapA = {}; ptsA.forEach(function(p){ mapA[p.date.slice(0,10)] = p.close; });
    var mapB = {}; ptsB.forEach(function(p){ mapB[p.date.slice(0,10)] = p.close; });
    var dates = Object.keys(mapA).filter(function(d){ return mapB[d]!=null; }).sort().slice(-lookback);
    var rA = [], rB = [];
    for (var i = 1; i < dates.length; i++) {
      var pa = mapA[dates[i-1]], ca = mapA[dates[i]];
      var pb = mapB[dates[i-1]], cb = mapB[dates[i]];
      if (pa>0&&ca>0&&pb>0&&cb>0) { rA.push(Math.log(ca/pa)); rB.push(Math.log(cb/pb)); }
    }
    if (rA.length < 40) { el.innerHTML = '<span style="color:var(--danger);">Insufficient overlap.</span>'; return; }
    function pearson(x, y) {
      var n = x.length;
      if (n < 2) return 0;
      var mx = x.reduce(function(s,v){return s+v;},0)/n, my = y.reduce(function(s,v){return s+v;},0)/n;
      var cov = 0, sx = 0, sy = 0;
      for (var i = 0; i < n; i++) { cov+=(x[i]-mx)*(y[i]-my); sx+=(x[i]-mx)*(x[i]-mx); sy+=(y[i]-my)*(y[i]-my); }
      return (sx>0&&sy>0) ? cov/Math.sqrt(sx*sy) : 0;
    }
    var maxLag = 20;
    var lags = [], ccf = [];
    for (var k = -maxLag; k <= maxLag; k++) {
      lags.push(k);
      if (k === 0) { ccf.push(pearson(rA, rB)); continue; }
      var xa, xb;
      if (k > 0) { xa = rA.slice(0, rA.length - k); xb = rB.slice(k); }
      else { xa = rA.slice(-k); xb = rB.slice(0, rB.length + k); }
      ccf.push(pearson(xa, xb));
    }
    var ciLine = 1.96 / Math.sqrt(rA.length);
    var peakLag = lags[ccf.indexOf(Math.max.apply(null, ccf))];
    var peakCorr = Math.max.apply(null, ccf);
    var interpretation = peakLag < -2 ? assetB + ' leads ' + assetA + ' by ~' + Math.abs(peakLag) + ' days' :
      peakLag > 2 ? assetA + ' leads ' + assetB + ' by ~' + peakLag + ' days' :
      'Contemporaneous (no significant lead/lag)';
    el.innerHTML = '<div style="background:var(--panel);padding:8px 12px;border-radius:4px;font-size:12px;border-left:3px solid var(--navy);margin-bottom:8px;">' +
      '<strong>Peak correlation: ' + peakCorr.toFixed(3) + ' at lag ' + peakLag + ' days</strong><br>' +
      '<span style="color:var(--text-sec);">' + interpretation + ' (n=' + rA.length + ' days, 95% CI: ±' + ciLine.toFixed(3) + ')</span></div>';
    if (wrap) wrap.style.display = '';
    var ctx = document.getElementById('mktLeadLagChart');
    if (window._leadLagChart) window._leadLagChart.destroy();
    window._leadLagChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: lags,
        // Brand palette for CCF bars
        datasets: [
          { label: 'Cross-Correlation', data: ccf, backgroundColor: ccf.map(function(v, i) {
            if (lags[i] === peakLag) return '#003C71';
            return v > ciLine ? 'rgba(46,125,82,0.65)' : v < -ciLine ? 'rgba(139,42,42,0.65)' : '#A8C8E8';
          }), borderColor: 'transparent', borderRadius: 2 },
          { label: '95% CI +', data: new Array(lags.length).fill(ciLine), type: 'line', borderColor: '#8B6914', borderDash: [4,3], borderWidth: 1.5, pointRadius: 0, fill: false },
          { label: '95% CI −', data: new Array(lags.length).fill(-ciLine), type: 'line', borderColor: '#8B6914', borderDash: [4,3], borderWidth: 1.5, pointRadius: 0, fill: false }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          title: function(items){ return 'Lag ' + lags[items[0].dataIndex] + ' days'; },
          label: function(ctx){ return 'ρ = ' + (ctx.parsed.y||0).toFixed(4); }
        }}},
        scales: {
          x: { title: { display: true, text: 'Lag (days) — negative = B leads A, positive = A leads B', font: {size:11}, color: 'var(--text-sec)' }, ticks: { color: 'var(--text-sec)' } },
          y: { min: -1, max: 1, title: { display: true, text: 'Pearson ρ', font: {size:11}, color: 'var(--text-sec)' }, ticks: { color: 'var(--text-sec)' } }
        }
      }
    });
  } catch(e) { el.innerHTML = '<span style="color:var(--danger);">Error: ' + e.message + '</span>'; }
};

// ── SECTOR MOMENTUM SCORECARD ──────────────────────────────────────
var SECTOR_ETFS = [
  {t:'XLK',s:'Technology'},{t:'XLF',s:'Financials'},{t:'XLV',s:'Healthcare'},
  {t:'XLY',s:'Cons. Discretionary'},{t:'XLC',s:'Comm. Services'},{t:'XLI',s:'Industrials'},
  {t:'XLP',s:'Cons. Staples'},{t:'XLE',s:'Energy'},{t:'XLU',s:'Utilities'},
  {t:'XLRE',s:'Real Estate'},{t:'XLB',s:'Materials'}
];
window.mktLoadSectorMomentum = async function() {
  var el = document.getElementById('mktSectorMomentum');
  el.innerHTML = '<span class="spinner"></span> Fetching 11 sector ETFs…';
  try {
    var charts = {};
    await Promise.all(SECTOR_ETFS.map(async function(s) {
      try {
        var r = await fetch(WORKER_URL_CA + '/chart?symbol=' + s.t + '&range=1y&interval=1d');
        var d = await r.json();
        charts[s.t] = (d.points||[]).filter(function(p){return p.close!=null;});
      } catch(e) { charts[s.t] = []; }
    }));
    // SPY for relative strength
    var spyR = await fetch(WORKER_URL_CA + '/chart?symbol=SPY&range=1y&interval=1d').then(function(r){return r.json();});
    var spyPts = (spyR.points||[]).filter(function(p){return p.close!=null;});
    function pctRet(arr, n) {
      if (!arr || arr.length < n+1) return null;
      var a = arr[arr.length-1-n].close, b = arr[arr.length-1].close;
      return a > 0 ? (b-a)/a*100 : null;
    }
    function ytdRetSec(arr) {
      if (!arr||arr.length<2) return null;
      var ys = new Date().getFullYear() + '-01-01';
      var start = arr.find(function(p){return p.date>=ys;});
      return start ? (arr[arr.length-1].close - start.close)/start.close*100 : null;
    }
    var rows = SECTOR_ETFS.map(function(s) {
      var pts = charts[s.t] || [];
      var r1m = pctRet(pts, 21), r3m = pctRet(pts, 63), r6m = pctRet(pts, 126), r12m = pctRet(pts, 252);
      var ytd = ytdRetSec(pts);
      var spy1m = pctRet(spyPts, 21);
      var rs1m = r1m != null && spy1m != null ? r1m - spy1m : null;
      return { ticker: s.t, sector: s.s, r1m, r3m, r6m, r12m, ytd, rs1m };
    });
    // Rank each period (1 = best)
    function rankCol(rows, key) {
      var valid = rows.filter(function(r){return r[key]!=null;}).sort(function(a,b){return b[key]-a[key];});
      valid.forEach(function(r,i){ r['rank_'+key] = i+1; });
      rows.filter(function(r){return r[key]==null;}).forEach(function(r){ r['rank_'+key] = valid.length+1; });
    }
    ['r1m','r3m','r6m','r12m'].forEach(function(k){ rankCol(rows, k); });
    rows.forEach(function(r) {
      var rankCols = ['r1m','r3m','r6m','r12m'].filter(function(k){ return r[k]!=null; });
      r.compRank = rankCols.length > 0 ? rankCols.reduce(function(s,k){ return s+r['rank_'+k]; }, 0) / rankCols.length : 99;
    });
    rows.sort(function(a,b){ return a.compRank - b.compRank; });
    // Brand-compliant momentum cell colors
    function fmtR(v, rank) {
      if (v==null) return '<td style="text-align:right;color:#5A6A7A;font-size:11.5px;padding:7px 8px;">—</td>';
      var col = v>=0?'#2E7D52':'#8B2A2A';
      var bg = rank===1?'rgba(46,125,82,0.12)':rank<=3?'rgba(46,125,82,0.05)':rank>=SECTOR_ETFS.length-1?'rgba(139,42,42,0.08)':'transparent';
      return '<td style="text-align:right;font-family:Courier New,monospace;font-size:11.5px;font-weight:700;color:'+col+';background:'+bg+';padding:7px 8px;">'+(v>=0?'+':'')+v.toFixed(1)+'%</td>';
    }
    var html = '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;">';
    html += '<thead><tr style="background:#003C71;color:#FFFFFF;font-family:Arial,sans-serif;">';
    html += '<th style="padding:9px 10px;text-align:left;font-size:12px;font-weight:600;">Rank</th>';
    html += '<th style="padding:9px 10px;text-align:left;font-size:12px;font-weight:600;">Sector (ETF)</th>';
    html += '<th style="padding:9px 10px;text-align:right;font-size:12px;font-weight:600;">1M</th>';
    html += '<th style="padding:9px 10px;text-align:right;font-size:12px;font-weight:600;">3M</th>';
    html += '<th style="padding:9px 10px;text-align:right;font-size:12px;font-weight:600;">6M</th>';
    html += '<th style="padding:9px 10px;text-align:right;font-size:12px;font-weight:600;">1Y</th>';
    html += '<th style="padding:9px 10px;text-align:right;font-size:12px;font-weight:600;">YTD</th>';
    html += '<th style="padding:9px 10px;text-align:right;font-size:12px;font-weight:600;">1M vs SPY</th></tr></thead><tbody>';
    rows.forEach(function(r, i) {
      var medal = i===0?'▲ ':i===1?'▲ ':i===2?'▲ ':i>=SECTOR_ETFS.length-2?'▼ ':'  ';
      var rowBg = i < 3 ? 'background:rgba(91,155,213,0.06);' : i >= SECTOR_ETFS.length-2 ? 'background:rgba(139,42,42,0.04);' : '';
      html += '<tr style="border-bottom:1px solid var(--border-light);'+rowBg+'">';
      var medalColor = i < 3 ? '#003C71' : i >= SECTOR_ETFS.length-2 ? '#8B2A2A' : '#5A6A7A';
      html += '<td style="padding:7px 8px;font-weight:700;color:' + medalColor + ';font-family:Arial,sans-serif;">' + medal + '#' + (i+1) + '</td>';
      html += '<td style="padding:7px 8px;font-weight:700;font-family:Arial,sans-serif;color:#000000;">' + r.sector + ' <span style="font-size:10px;color:#5A6A7A;">(' + r.ticker + ')</span></td>';
      html += fmtR(r.r1m, r.rank_r1m);
      html += fmtR(r.r3m, r.rank_r3m);
      html += fmtR(r.r6m, r.rank_r6m);
      html += fmtR(r.r12m, r.rank_r12m);
      html += fmtR(r.ytd, null);
      var rsBg = r.rs1m==null?'':r.rs1m>0?'rgba(91,155,213,0.12)':'rgba(139,42,42,0.08)';
      html += '<td style="text-align:right;font-family:Courier New,monospace;font-size:11.5px;font-weight:700;color:'+(r.rs1m==null?'#5A6A7A':r.rs1m>=0?'#2E7D52':'#8B2A2A')+';background:'+rsBg+';padding:7px 8px;">';
      html += r.rs1m!=null?(r.rs1m>=0?'+':'')+r.rs1m.toFixed(1)+'%':'—';
      html += '</td></tr>';
    });
    html += '</tbody></table></div>';
    html += '<div style="font-size:11px;color:#5A6A7A;margin-top:6px;font-family:Arial,sans-serif;">▲ = Momentum leaders (top 3) &nbsp;&bull;&nbsp; ▼ = Laggards (bottom 2) &nbsp;&bull;&nbsp; Composite rank = average of 1M, 3M, 6M, 1Y ranks. Blue shading = top 3 in that period.</div>';
    el.innerHTML = html;
  } catch(e) { el.innerHTML = '<span style="color:var(--danger);">Error: ' + e.message + '</span>'; }
};

// ═══════════════════════════════════════════════════
// ════  CROSS-ASSET TAB CONTROLLER  ══════════════════
// ═══════════════════════════════════════════════════

// Wrapper to re-run stress test with current account/factor filters
window.stressRerun = function() {
  // Get the active scenario button
  var activeBtn = document.querySelector('#stressScenarioBtns .btn-outline.active');
  if (!activeBtn) { activeBtn = document.querySelector('#stressScenarioBtns .btn-outline'); }
  if (activeBtn) activeBtn.click();
};

// Populate scenario account filter on portfolio load
function populateScenarioAccountFilter() {
  var sel = document.getElementById('scenarioAccountFilter');
  if (!sel) return;
  var h = window._holdings || [];
  var accts = [...new Set(h.map(x => x.accountType || 'Individual'))].sort();
  while (sel.options.length > 1) sel.remove(1);
  accts.forEach(function(a) {
    var opt = document.createElement('option');
    opt.value = a; opt.textContent = a;
    sel.appendChild(opt);
  });
}

window._caTabLoadedAt = window._caTabLoadedAt || {};  // staleness tracker for caShowTab

// ═══════════════════════════════════════════════════════════════════
// ════  TOP-LINE VIEW ENGINE — Master Macro Decision Pipeline  ══════
// ═══════════════════════════════════════════════════════════════════
// Pulls data from FRED + Yahoo + existing modules and produces
// a unified portfolio-posture verdict.

var WORKER_TL = 'https://perry-finance-proxy.zachperrybusiness.workers.dev';

// Helper: fetch chart with 1y range
async function tlFetchChart(sym, range) {
  range = range || '1y';
  try {
    var r = await fetch(WORKER_TL + '/chart?symbol=' + encodeURIComponent(sym) + '&range=' + range + '&interval=1d');
    var d = await r.json();
    return (d.points || []).filter(function(p) { return p.close != null; });
  } catch (e) { return []; }
}

async function tlFetchQuote(sym) {
  try {
    var r = await fetch(WORKER_TL + '/quote?symbol=' + encodeURIComponent(sym));
    return await r.json();
  } catch (e) { return null; }
}

// Compute % return over N trading days (returns null if insufficient data)
function tlPctRet(pts, n) {
  if (!pts || pts.length < 2) return null;
  var lastIdx = pts.length - 1;
  var startIdx = Math.max(0, lastIdx - n);
  var a = pts[startIdx].close, b = pts[lastIdx].close;
  return a > 0 ? (b - a) / a * 100 : null;
}

// Z-score given a window of values (clamped to ±3)
function tlZScore(arr, val) {
  if (!arr || arr.length < 5) return 0;
  var m = arr.reduce(function(s, v) { return s + v; }, 0) / arr.length;
  var v = arr.reduce(function(s, x) { return s + (x - m) * (x - m); }, 0) / Math.max(arr.length - 1, 1);
  var sd = Math.sqrt(v);
  if (sd === 0) return 0;
  return Math.max(-3, Math.min(3, (val - m) / sd));
}

// Brand color helper for score [0..100]
function tlScoreColor(score) {
  if (score >= 70) return '#2E7D52'; // strong green
  if (score >= 55) return '#5B9BD5'; // brand blue
  if (score >= 45) return '#5A6A7A'; // neutral gray
  if (score >= 30) return '#8B6914'; // warning amber
  return '#8B2A2A'; // danger red
}
function tlScoreLabel(score, perryState) {
  // If Perry state is drawdown, never say "Bullish" — say "Positioned for Drawdown" variants
  var ps = perryState || window._perryState || null;
  if (ps === 'drawdown') {
    if (score >= 40) return 'Reduce Risk (Economy Intact)';
    return 'Defensive / Preserve Capital';
  }
  if (ps === 'neutral') {
    if (score >= 55) return 'Cautiously Constructive';
    if (score >= 40) return 'Neutral / Hold';
    return 'Defensive';
  }
  if (ps === 'leveraged') return 'Contrarian Buy (Leveraged)';
  // Normal growth state — score-based
  if (score >= 70) return 'Constructive / Growth';
  if (score >= 55) return 'Selective Risk-On';
  if (score >= 40) return 'Neutral';
  if (score >= 25) return 'Cautious';
  return 'Defensive';
}

// ═══════════════════════════════════════════════
// ═  MASTER VERDICT — runs all 7 pillars and aggregates
// ═══════════════════════════════════════════════
window.topLineRefreshAll = async function() {
  // Reset spinners on every panel
  var verd = document.getElementById('masterVerdictStrip');
  if (verd) verd.innerHTML = '<div style="text-align:center;color:#5A6A7A;font-size:13px;padding:8px;font-family:Arial,Helvetica,sans-serif;"><span class="spinner"></span> Computing master verdict from 7 signal pillars...</div>';
  ['decisionCompass', 'movingToday', 'macroHeadwinds', 'portfolioArchetypes'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = '<div style="padding:18px;text-align:center;color:#5A6A7A;font-family:Arial,Helvetica,sans-serif;font-size:13px;"><span class="spinner"></span> Loading...</div>';
  });

  // Compute pillars in parallel
  try {
    var pillarResults = await Promise.all([
      tlPillar_BusinessCycle(),
      tlPillar_MarketRegime(),
      tlPillar_Breadth(),
      tlPillar_Credit(),
      tlPillar_YieldCurve(),
      tlPillar_CrossAssetMomentum(),
      tlPillar_SectorRotation()
    ]);
    var pillars = [
      { name: 'Business Cycle',      weight: 0.25, ...pillarResults[0] },
      { name: 'Market Regime State', weight: 0.20, ...pillarResults[1] },
      { name: 'Breadth (Fear/Greed)',weight: 0.15, ...pillarResults[2] },
      { name: 'Credit Conditions',   weight: 0.12, ...pillarResults[3] },
      { name: 'Yield Curve',         weight: 0.08, ...pillarResults[4] },
      { name: 'Cross-Asset Momentum',weight: 0.10, ...pillarResults[5] },
      { name: 'Sector Rotation',     weight: 0.10, ...pillarResults[6] }
    ];
    // Weighted composite score
    var totalW = pillars.reduce(function(s, p) { return s + (p.score != null ? p.weight : 0); }, 0);
    var weightedSum = pillars.reduce(function(s, p) { return s + (p.score != null ? p.score * p.weight : 0); }, 0);
    var rawComposite = totalW > 0 ? weightedSum / totalW : 50;

    // ── Perry Regime Gate ──
    // The Perry state is a PRICE-ACTION ceiling. No matter how good the
    // economic data looks, if markets have already priced in that good news
    // (SPY +30%+ from lows, near 52W high, low VIX), the forward risk/reward
    // has shifted. The composite cannot exceed the Perry gate.
    //
    //   Drawdown  → composite capped at 42  (reduce risk; economy good but priced in)
    //   Neutral   → composite capped at 58  (hold; modest risk budget)
    //   Growth    → composite uncapped (economic + price confirm each other)
    //   Leveraged → composite floor at 80   (deep discount; load up)
    //
    var perryState = window._perryState || 'neutral';
    var perryCaps = { drawdown: 42, neutral: 58, growth: 100, leveraged: 100 };
    var perryFloors = { drawdown: 0, neutral: 0, growth: 0, leveraged: 80 };
    var cap   = perryCaps[perryState]   != null ? perryCaps[perryState]   : 100;
    var floor = perryFloors[perryState] != null ? perryFloors[perryState] : 0;

    // ── RMT ICR Diversification Modifier (Molero-González et al. 2024) ──
    // When the correlation matrix ICR is high (≥50%), cross-asset
    // correlations are genuinely elevated — diversification is compromised
    // and the market is in a structured, factor-driven regime. This historically
    // precedes larger drawdowns because all assets move together.
    // We apply a penalty to the composite cap: up to -8 points when ICR ≥ 50%.
    // This is a conservative modifier: it never adds risk, only reduces the ceiling.
    var icr = window._rmtICR != null ? window._rmtICR : null;
    var icrPenalty = 0;
    if (icr != null && icr >= 0.5)       icrPenalty = 8;   // high structure → reduce cap
    else if (icr != null && icr >= 0.35) icrPenalty = 4;   // moderate
    cap = Math.max(floor, cap - icrPenalty);
    window._icrPenalty = icrPenalty;
    window._icrUsed = icr;

    var composite = Math.max(floor, Math.min(cap, rawComposite));

    window._tlPillars = pillars;
    window._tlComposite = composite;
    window._tlRawComposite = rawComposite;

    // Render all panels
    tlRenderMasterVerdict(composite, pillars, rawComposite);
    tlRenderDecisionCompass(composite, pillars);
    tlRenderMacroHeadwinds(pillars);
    tlRenderPortfolioArchetypes(composite, pillars);
    tlRenderMovingToday();

  } catch (e) {
    if (verd) verd.innerHTML = '<div style="color:#8B2A2A;padding:12px;font-family:Arial,Helvetica,sans-serif;font-size:13px;">Error computing verdict: ' + e.message + '</div>';
    console.error('[topLine]', e);
  }
};

// ─────────────────────────────────────────────
// PILLAR 1 — Business Cycle (FRED scorecard)
// ─────────────────────────────────────────────
async function tlPillar_BusinessCycle() {
  try {
    if (!window._lastMacroData) {
      var r = await fetch(WORKER_TL + '/fred');
      window._lastMacroData = await r.json();
    }
    var d = window._lastMacroData;
    var total = d.totalScore || 0;
    var max = d.maxScore || 1;
    // Convert to 0-100 score: max=100 (all positive), -max=0 (all negative)
    var score = Math.max(0, Math.min(100, ((total + max) / (2 * max)) * 100));
    return { score: score, detail: d.phase || 'Unknown', subdetail: total + ' / ' + max };
  } catch (e) {
    return { score: null, detail: 'unavailable', subdetail: '' };
  }
}

// ─────────────────────────────────────────────
// PILLAR 2 — Market Regime (Perry State)
// This pillar uses the SAME psClassifyState logic as the Regime tab
// so both systems stay in sync. Perry regime maps directly to score:
//   leveraged   → 85 (deep contrarian buy)
//   growth      → 65 (normal bullish)
//   neutral     → 40 (caution)
//   drawdown    → 20 (reduce risk, wait)
// This pillar also sets window._perryState so other renderers can
// read it directly for language and posture gating.
// ─────────────────────────────────────────────
async function tlPillar_MarketRegime() {
  try {
    var [spyPts, vixQ, qqqPts] = await Promise.all([
      tlFetchChart('SPY', '1y'),
      tlFetchQuote('%5EVIX'),
      tlFetchChart('QQQ', '1y')
    ]);
    if (spyPts.length < 30) return { score: null, detail: 'insufficient data', subdetail: '' };
    var closes = spyPts.map(function(p) { return p.close; });
    var spy12mHigh = Math.max.apply(null, closes);
    var spy12mLow  = Math.min.apply(null, closes);
    var spyCur   = closes[closes.length - 1];
    var spyStart = closes[0];
    var vix = (vixQ && (vixQ.current || vixQ.price)) || 20;

    var signals = {
      vix: vix,
      spyTrailingReturn: (spyCur - spyStart) / spyStart,
      drawdownFromPeak:  (spyCur - spy12mHigh) / spy12mHigh,
      spy12mFromLow:     spy12mLow > 0 ? (spyCur - spy12mLow) / spy12mLow : 0
    };

    // Use the same classifier as psClassifyState (Perry 4-state)
    var cl = typeof psClassifyState === 'function'
      ? psClassifyState(signals)
      : { winner: 'neutral', confidence: 50, reasons: [] };

    // Also use the quarterly-locked regime if available (same as Regime tab)
    var perryState = cl.winner;
    if (window._quarterlyRegimes && window._quarterlyRegimes.quarterly && window._quarterlyRegimes.quarterly.length) {
      var latestQ = window._quarterlyRegimes.quarterly[window._quarterlyRegimes.quarterly.length - 1];
      if (latestQ && latestQ.regime) perryState = latestQ.regime;
    }

    // Store for use by Decision Compass and archetype ranker
    window._perryState = perryState;
    window._perrySignals = signals;

    // Map Perry state to score — this is a POSITIONING score, not an economic score
    var stateScores = { leveraged: 85, growth: 65, neutral: 40, drawdown: 20 };
    var stateLabels = {
      leveraged: 'Leveraged (Contrarian Buy)',
      growth:    'Non-Levered Growth',
      neutral:   'Neutral / Cautious',
      drawdown:  'Positioned for Drawdown'
    };
    var score = stateScores[perryState] != null ? stateScores[perryState] : 40;
    var trail = (spyCur - spyStart) / spyStart;
    var dd    = (spyCur - spy12mHigh) / spy12mHigh;

    return {
      score: score,
      detail: stateLabels[perryState] || perryState,
      subdetail: 'VIX ' + vix.toFixed(1) + ' | 12M +' + (trail * 100).toFixed(1) + '% | DD ' + (dd * 100).toFixed(1) + '%',
      perryState: perryState,
      perryConfidence: cl.confidence,
      perryReasons: cl.reasons
    };
  } catch (e) {
    return { score: null, detail: 'unavailable', subdetail: '' };
  }
}

// ─────────────────────────────────────────────
// PILLAR 3 — Breadth (Fear/Greed composite)
// ─────────────────────────────────────────────
async function tlPillar_Breadth() {
  try {
    var [spy, qqq, tlt, gld, hyg, lqd] = await Promise.all([
      tlFetchChart('SPY', '1y'), tlFetchChart('QQQ', '1y'),
      tlFetchChart('TLT', '1y'), tlFetchChart('GLD', '1y'),
      tlFetchChart('HYG', '1y'), tlFetchChart('LQD', '1y')
    ]);
    var vixQ = await tlFetchQuote('%5EVIX');
    var vixCur = (vixQ && (vixQ.current || vixQ.price)) || 20;
    if (spy.length < 30) return { score: null, detail: 'insufficient data', subdetail: '' };
    var spyC = spy.map(function(p) { return p.close; });
    var spyHigh = Math.max.apply(null, spyC);
    var spyDist = (spyC[spyC.length - 1] - spyHigh) / spyHigh;

    function pct(arr, n) {
      if (!arr || arr.length < n + 1) return 0;
      var c = arr.map(function(p) { return p.close; });
      return (c[c.length - 1] - c[c.length - 1 - n]) / c[c.length - 1 - n];
    }
    function norm(val, lo, hi) { return Math.max(0, Math.min(100, (val - lo) / (hi - lo) * 100)); }

    var s1 = 100 - norm(vixCur, 10, 45);
    var s2 = norm(spyDist, -0.30, 0);
    var s3 = 100 - norm(pct(tlt, 20) - pct(spy, 20), -0.08, 0.08);
    var s4 = 100 - norm(pct(gld, 20) - pct(spy, 20), -0.06, 0.06);
    var s5 = norm(pct(hyg, 20) - pct(lqd, 20), -0.05, 0.05);
    var s6 = norm(pct(qqq, 20) - pct(spy, 20), -0.05, 0.05);
    var score = (s1 + s2 + s3 + s4 + s5 + s6) / 6;
    var lbl = score >= 70 ? 'Greed' : score >= 50 ? 'Neutral' : score >= 30 ? 'Caution' : 'Fear';
    return { score: score, detail: lbl, subdetail: Math.round(score) + ' / 100' };
  } catch (e) { return { score: null, detail: 'unavailable', subdetail: '' }; }
}

// ─────────────────────────────────────────────
// PILLAR 4 — Credit Conditions (HY OAS via FRED)
// ─────────────────────────────────────────────
async function tlPillar_Credit() {
  try {
    if (!window._lastMacroData) {
      var r = await fetch(WORKER_TL + '/fred');
      window._lastMacroData = await r.json();
    }
    var d = window._lastMacroData;
    // Find HY OAS indicator
    var pillars = d.pillars || [];
    var monetary = pillars.find(function(p) { return p.name === 'Monetary Policy'; });
    if (!monetary) return { score: null, detail: 'unavailable', subdetail: '' };
    var hy = monetary.indicators.find(function(i) { return i.indicator.indexOf('HY OAS') >= 0; });
    if (!hy || hy.value == null) return { score: null, detail: 'unavailable', subdetail: '' };
    var hyVal = parseFloat(hy.value);
    // HY OAS: < 3.5% = tight, 3.5-5 = normal, > 5 = stress, > 8 = crisis
    var score = Math.max(0, Math.min(100, 100 - (hyVal - 3) * 12));
    var lbl = score >= 70 ? 'Tight (Risk-On)' : score >= 50 ? 'Normal' : score >= 30 ? 'Widening' : 'Stress';
    return { score: score, detail: lbl, subdetail: 'HY OAS: ' + hyVal.toFixed(2) + '%' };
  } catch (e) { return { score: null, detail: 'unavailable', subdetail: '' }; }
}

// ─────────────────────────────────────────────
// PILLAR 5 — Yield Curve (2s10s + 3m10y)
// ─────────────────────────────────────────────
async function tlPillar_YieldCurve() {
  try {
    if (!window._lastMacroData) {
      var r = await fetch(WORKER_TL + '/fred');
      window._lastMacroData = await r.json();
    }
    var d = window._lastMacroData;
    var pillars = d.pillars || [];
    var monetary = pillars.find(function(p) { return p.name === 'Monetary Policy'; });
    if (!monetary) return { score: null, detail: 'unavailable', subdetail: '' };
    var yc2 = monetary.indicators.find(function(i) { return i.indicator.indexOf('2Y/10Y') >= 0; });
    var yc3m = monetary.indicators.find(function(i) { return i.indicator.indexOf('3M/10Y') >= 0; });
    var v2 = yc2 && yc2.value != null ? parseFloat(yc2.value) : null;
    var v3m = yc3m && yc3m.value != null ? parseFloat(yc3m.value) : null;
    if (v2 == null && v3m == null) return { score: null, detail: 'unavailable', subdetail: '' };
    var avg = v2 != null && v3m != null ? (v2 + v3m) / 2 : (v2 != null ? v2 : v3m);
    // > 100bps positive = 80, 0bps = 50, -100bps inverted = 20
    var score = Math.max(0, Math.min(100, 50 + avg * 30));
    var lbl = score >= 65 ? 'Steepening' : score >= 45 ? 'Flat' : 'Inverted';
    return { score: score, detail: lbl, subdetail: '2s10s ' + (v2 != null ? v2.toFixed(2) + '%' : '—') + ' / 3m10y ' + (v3m != null ? v3m.toFixed(2) + '%' : '—') };
  } catch (e) { return { score: null, detail: 'unavailable', subdetail: '' }; }
}

// ─────────────────────────────────────────────
// PILLAR 6 — Cross-Asset Momentum (rebased SPY/TLT/GLD/USO weighted)
// ─────────────────────────────────────────────
async function tlPillar_CrossAssetMomentum() {
  try {
    var [spy, tlt, gld, uso, dxy] = await Promise.all([
      tlFetchChart('SPY', '6mo'), tlFetchChart('TLT', '6mo'),
      tlFetchChart('GLD', '6mo'), tlFetchChart('USO', '6mo'),
      tlFetchChart('UUP', '6mo')
    ]);
    if (spy.length < 30) return { score: null, detail: 'insufficient', subdetail: '' };
    function ret63(arr) { return tlPctRet(arr, 63); }
    var spy3m = ret63(spy), tlt3m = ret63(tlt), gld3m = ret63(gld);
    // Risk-on regime: equity up, bonds down, gold neutral, dollar weakening
    var riskOnScore = 50;
    if (spy3m != null) riskOnScore += spy3m * 2;
    if (tlt3m != null) riskOnScore -= tlt3m * 1;
    riskOnScore = Math.max(0, Math.min(100, riskOnScore));
    var lbl = riskOnScore >= 65 ? 'Risk-On Momentum' : riskOnScore >= 45 ? 'Mixed' : 'Risk-Off';
    var sub = 'SPY ' + (spy3m != null ? (spy3m >= 0 ? '+' : '') + spy3m.toFixed(1) + '%' : '—') + ' | TLT ' + (tlt3m != null ? (tlt3m >= 0 ? '+' : '') + tlt3m.toFixed(1) + '%' : '—');
    return { score: riskOnScore, detail: lbl, subdetail: sub };
  } catch (e) { return { score: null, detail: 'unavailable', subdetail: '' }; }
}

// ─────────────────────────────────────────────
// PILLAR 7 — Sector Rotation + Cross-Asset Regime Composite
// If the regime signal composite (from mktLoadRegime) is available,
// blend it 50/50 with the sector momentum signal. Both capture the same
// underlying regime but via different lenses:
//   Sector momentum → internal leadership shift (1-2 week signal)
//   Cross-asset composite → structural positioning across 11 pairs (monthly signal)
// The blend provides a more stable, multi-timeframe regime read.
// ─────────────────────────────────────────────
async function tlPillar_SectorRotation() {
  try {
    var cyc = ['XLK','XLY','XLI','XLF'];
    var def = ['XLP','XLV','XLU'];
    var all = cyc.concat(def);
    var data = {};
    await Promise.all(all.map(async function(t) {
      data[t] = await tlFetchChart(t, '3mo');
    }));
    function avgRet(tickers, n) {
      var rets = [];
      tickers.forEach(function(t) {
        var r = tlPctRet(data[t], n);
        if (r != null) rets.push(r);
      });
      return rets.length ? rets.reduce(function(s, v) { return s + v; }, 0) / rets.length : null;
    }
    var cyc60 = avgRet(cyc, 60);
    var def60 = avgRet(def, 60);
    if (cyc60 == null || def60 == null) return { score: null, detail: 'unavailable', subdetail: '' };
    var spread = cyc60 - def60;
    var sectorScore = Math.max(0, Math.min(100, 50 + spread * 4));

    // Blend with cross-asset composite if available (populated by mktLoadRegime)
    var regScore = window._regimeSignalScore != null ? window._regimeSignalScore : null;
    var finalScore, blendNote;
    if (regScore != null) {
      finalScore = sectorScore * 0.50 + regScore * 0.50;
      blendNote = 'Sector Momentum ' + sectorScore.toFixed(0) + ' | Cross-Asset Regime ' + regScore.toFixed(0) + ' → Blended';
    } else {
      finalScore = sectorScore;
      blendNote = 'Sector momentum only (load Cross-Asset Regime Signals for enhanced composite)';
    }

    var lbl = finalScore >= 65 ? 'Cyclicals Leading' : finalScore >= 45 ? 'Mixed' : 'Defensives Leading';
    return {
      score: finalScore,
      detail: lbl,
      subdetail: 'Cyc ' + (cyc60 >= 0 ? '+' : '') + cyc60.toFixed(1) + '% vs Def ' + (def60 >= 0 ? '+' : '') + def60.toFixed(1) + '% | ' + blendNote
    };
  } catch (e) { return { score: null, detail: 'unavailable', subdetail: '' }; }
}

// ═══════════════════════════════════════════════
// ═  RENDERERS
// ═══════════════════════════════════════════════
function tlRenderMasterVerdict(composite, pillars, rawComposite) {
  var el = document.getElementById('masterVerdictStrip');
  if (!el) return;

  var perryState = window._perryState || 'neutral';
  var perryLabels = {
    leveraged: 'Leveraged (Contrarian Buy)',
    growth:    'Non-Levered Growth',
    neutral:   'Neutral / Cautious',
    drawdown:  'Positioned for Drawdown'
  };
  var perryColors = {
    leveraged: '#2E7D52', growth: '#003C71', neutral: '#8B6914', drawdown: '#8B2A2A'
  };
  var perryCol = perryColors[perryState] || '#5A6A7A';
  var perryName = perryLabels[perryState] || perryState;

  var col = tlScoreColor(composite);
  var lbl = tlScoreLabel(composite);

  // Was composite clipped by Perry gate?
  var wasClipped = rawComposite != null && Math.abs(rawComposite - composite) > 1;
  var perryPillar = pillars.find(function(p) { return p.name === 'Market Regime State'; });
  var bcPillar    = pillars.find(function(p) { return p.name === 'Business Cycle'; });

  var html = '<div style="font-family:Arial,Helvetica,sans-serif;">';

  // ── Row 1: Two verdicts side by side ──
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">';

  // Economic Cycle verdict (FRED)
  var bcScore = bcPillar ? bcPillar.score : null;
  var bcCol = bcScore != null ? tlScoreColor(bcScore) : '#5A6A7A';
  var bcLbl = bcPillar ? bcPillar.detail : '—';
  html += '<div style="border:1px solid #D0D7E0;border-radius:6px;overflow:hidden;">';
  html += '<div style="background:#003C71;color:#FFFFFF;padding:7px 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">Economic Cycle (FRED)</div>';
  html += '<div style="padding:10px 14px;background:#FFFFFF;display:flex;align-items:center;gap:14px;">';
  html += '<div style="font-size:28px;font-weight:800;color:' + bcCol + ';">' + (bcScore != null ? Math.round(bcScore) : '—') + '</div>';
  html += '<div>';
  html += '<div style="font-size:13px;font-weight:700;color:#000000;">' + bcLbl + '</div>';
  html += '<div style="font-size:11px;color:#5A6A7A;margin-top:2px;">' + (bcPillar ? bcPillar.subdetail : '') + '</div>';
  html += '<div style="font-size:11px;color:#5A6A7A;margin-top:2px;">Macro conditions via 24 FRED indicators</div>';
  html += '</div>';
  html += '</div>';
  html += '</div>';

  // Market Regime (Perry — price-action driven)
  html += '<div style="border:1px solid #D0D7E0;border-radius:6px;overflow:hidden;">';
  html += '<div style="background:' + perryCol + ';color:#FFFFFF;padding:7px 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">Market Regime (Perry State)</div>';
  html += '<div style="padding:10px 14px;background:#FFFFFF;display:flex;align-items:center;gap:14px;">';
  html += '<div style="font-size:28px;font-weight:800;color:' + perryCol + ';">' + (perryPillar && perryPillar.score != null ? Math.round(perryPillar.score) : '—') + '</div>';
  html += '<div>';
  html += '<div style="font-size:13px;font-weight:700;color:#000000;">' + perryName + '</div>';
  html += '<div style="font-size:11px;color:#5A6A7A;margin-top:2px;">' + (perryPillar ? perryPillar.subdetail : '') + '</div>';
  html += '<div style="font-size:11px;color:#5A6A7A;margin-top:2px;">Price-action, VIX, drawdown signals</div>';
  html += '</div>';
  html += '</div>';
  html += '</div>';

  html += '</div>';

  // ── Reconciliation note if signals diverge ──
  if (wasClipped || (bcScore != null && perryPillar && perryPillar.score != null && Math.abs(bcScore - perryPillar.score) > 25)) {
    html += '<div style="background:#FFF8E1;border:1px solid #8B6914;border-left:4px solid #8B6914;padding:9px 14px;border-radius:4px;margin-bottom:10px;font-size:12px;line-height:1.6;color:#4A3F00;">';
    html += '<strong>Why these signals diverge:</strong> ';
    if (perryState === 'drawdown') {
      html += 'The economy is in <strong>' + bcLbl + '</strong> — FRED data is positive. ';
      html += 'However, equity markets have already <em>priced in</em> that good news: SPY has rallied sharply from its lows, ';
      html += 'is near its 52-week high, and VIX is low/complacent. In this setup, the risk/reward of adding exposure is asymmetric — ';
      html += 'upside is limited while downside could be swift. <strong>The recommended action: maintain equity exposure but reduce leverage, ';
      html += 'raise cash, and prepare for a better entry point.</strong> This is not a call for full exit — it is a call for discipline.';
    } else if (perryState === 'neutral') {
      html += 'Economic conditions are mixed (' + bcLbl + ') and market price-action is sending caution signals. ';
      html += 'Hold balanced exposure; avoid new aggressive longs until either the economic picture clarifies or the market pulls back to a better risk/reward entry.';
    } else {
      html += 'Economic cycle and market regime are broadly aligned. Follow the composite verdict.';
    }
    html += '</div>';
  }

  // ── Composite + pillar bars ──
  html += '<div style="display:grid;grid-template-columns:auto 1fr;gap:14px;align-items:center;">';
  // Composite block
  html += '<div style="background:' + col + ';color:#FFFFFF;padding:12px 20px;border-radius:6px;text-align:center;min-width:150px;">';
  html += '<div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;opacity:.85;">Composite Verdict</div>';
  html += '<div style="font-size:30px;font-weight:800;line-height:1.1;margin:4px 0;">' + Math.round(composite) + '</div>';
  html += '<div style="font-size:12px;font-weight:700;">' + lbl + '</div>';
  if (wasClipped) {
    html += '<div style="font-size:9.5px;opacity:.8;margin-top:3px;">Perry-gated from ' + Math.round(rawComposite) + '</div>';
  }
  var icrPen = window._icrPenalty || 0;
  var icrVal = window._icrUsed;
  if (icrPen > 0 && icrVal != null) {
    html += '<div style="font-size:9.5px;opacity:.8;margin-top:2px;">RMT ICR penalty: −' + icrPen + ' pts (ICR=' + (icrVal*100).toFixed(0) + '%)</div>';
  }
  html += '</div>';
  // Pillar mini-bars
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:7px;">';
  pillars.forEach(function(p) {
    var sc = p.score;
    var pCol = sc != null ? tlScoreColor(sc) : '#A8C8E8';
    var pTxt = sc != null ? Math.round(sc) : '—';
    var wPct = (p.weight * 100).toFixed(0);
    html += '<div style="background:#FFFFFF;border:1px solid #D0D7E0;border-radius:4px;padding:5px 8px;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">';
    html += '<span style="font-size:10px;font-weight:700;color:#003C71;">' + p.name + '</span>';
    html += '<span style="font-size:9px;color:#5A6A7A;">' + wPct + '%</span>';
    html += '</div>';
    html += '<div style="display:flex;align-items:center;gap:5px;">';
    html += '<span style="font-size:14px;font-weight:800;color:' + pCol + ';font-family:Arial,Helvetica,sans-serif;min-width:22px;">' + pTxt + '</span>';
    if (sc != null) {
      html += '<div style="flex:1;height:5px;background:#F4F6F9;border-radius:2px;overflow:hidden;">';
      html += '<div style="height:100%;width:' + sc.toFixed(0) + '%;background:' + pCol + ';transition:width 0.4s;"></div></div>';
    }
    html += '</div>';
    html += '<div style="font-size:9.5px;color:#5A6A7A;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + p.detail + '</div>';
    html += '</div>';
  });
  html += '</div>';
  html += '</div>';
  html += '</div>';
  el.innerHTML = html;
}

function tlRenderDecisionCompass(composite, pillars) {
  var el = document.getElementById('decisionCompass');
  if (!el) return;

  // Read the Perry state that was set by Pillar 2
  var perryState = window._perryState || 'neutral';
  var bcPillar = pillars.find(function(p) { return p.name === 'Business Cycle'; });
  var bcScore  = bcPillar ? (bcPillar.score || 50) : 50;

  // ── Posture is driven by Perry state, NOT numeric composite ──
  // The composite adds nuance within the Perry band (e.g., a "drawdown"
  // regime with very good FRED data = gentle reduction vs. panic exit).
  var posture, postureDetail, riskBudget, equityWt, durationWt, creditWt, cashWt, actionItems;

  if (perryState === 'leveraged') {
    posture = 'Leveraged / Aggressive Entry';
    postureDetail = 'Markets in deep discount. VIX elevated, SPY far below recent highs. This is the contrarian buy window — add levered exposure with defined risk.';
    equityWt = 75; durationWt = 10; creditWt = 10; cashWt = 5;
    riskBudget = 'High (Levered)';
    actionItems = ['Increase TQQQ / SOXL / UPRO exposure to target', 'Buy quality beaten-down names', 'Add to SPY / QQQ at current levels', 'Reduce cash to minimum buffer'];
  } else if (perryState === 'growth') {
    posture = 'Non-Levered Growth / Constructive';
    // Sub-nuance from FRED
    if (bcScore >= 65) {
      postureDetail = 'Healthy price-action confirmed by strong macro. Hold full 1x equity exposure. Rotate toward growth factors (tech, small caps, cyclicals).';
      equityWt = 65; durationWt = 12; creditWt = 13; cashWt = 10;
      riskBudget = 'Moderate-High';
      actionItems = ['Maintain core SPY / QQQ allocation', 'Tilt toward growth factors: XLK, IWM, IGM', 'Hold IG credit (LQD) as carry', 'Keep 10% cash reserve for pullback buys'];
    } else {
      postureDetail = 'Price-action is healthy but macro data is mixed. Maintain unleveraged equity exposure; add defensives for ballast.';
      equityWt = 55; durationWt = 18; creditWt = 12; cashWt = 15;
      riskBudget = 'Moderate';
      actionItems = ['Hold SPY / QQQ at target weight', 'Add quality/dividend tilt: QUAL, VYM', 'Increase IEF / TLT for duration hedge', 'Build cash toward 15%'];
    }
  } else if (perryState === 'neutral') {
    posture = 'Neutral / Cautious Hold';
    postureDetail = 'Mixed signals. Hold current positions but do not add risk. Shift incrementally toward defensives and real assets.';
    equityWt = 50; durationWt = 20; creditWt = 10; cashWt = 20;
    riskBudget = 'Moderate-Low';
    actionItems = ['Hold core equity; do not add', 'Increase GLD and TIPS allocation', 'Reduce HY credit (HYG) toward IG', 'Build cash to 20%, deploy on confirmed signal'];
  } else if (perryState === 'drawdown') {
    // Sub-nuance: "Positioned for Drawdown" does NOT mean sell everything.
    // It means the market is extended — systematically reduce leverage and
    // raise cash so you have dry powder when the reversion comes.
    if (bcScore >= 60) {
      // Economy fine, market extended — gentle reduction
      posture = 'Reduce Leverage / Raise Cash (Economy Intact)';
      postureDetail = 'The economy is healthy (' + (bcPillar ? bcPillar.detail : 'Mid-Cycle') + '), but equity markets have priced in that good news and then some. SPY has run sharply off lows. Expected forward returns have compressed. This is NOT a crash call — it is a signal to systematically de-risk: reduce position sizes, eliminate leverage, raise cash for the next better entry.';
      equityWt = 45; durationWt = 22; creditWt = 8; cashWt = 25;
      riskBudget = 'Low (Preservation Mode)';
      actionItems = [
        'Trim overweight positions; take gains on leaders',
        'Eliminate any leveraged ETF exposure (TQQQ, SOXL, etc.)',
        'Raise cash target to 25–35% — this is your next entry fund',
        'Rotate from growth to quality/dividend: QUAL, VYM, SPHD',
        'Add TLT / IEF as asymmetric hedge if rates peak',
        'Add GLD as portfolio insurance (5–10%)',
        'DO NOT short — this is not a crash, it is a pause'
      ];
    } else {
      // Economy also weakening — more defensive
      posture = 'Defensive / Capital Preservation';
      postureDetail = 'Market extended AND macro showing late-cycle stress. Reduce equity meaningfully. Long duration bonds and gold offer best risk-adjusted return in this setup.';
      equityWt = 30; durationWt = 35; creditWt = 5; cashWt = 30;
      riskBudget = 'Capital Preservation';
      actionItems = [
        'Reduce equity to 30% or below',
        'Eliminate all speculative / high-beta names',
        'Increase TLT to 25%+ (duration play on rate peak)',
        'Add GLD to 10% — real asset hedge',
        'Hold 30%+ cash for next contrarian entry',
        'Consider tail hedges: TAIL, VIXM, put spreads on QQQ'
      ];
    }
  } else {
    posture = 'Neutral';
    postureDetail = 'Regime unclassified. Hold current allocation and wait for signal clarification.';
    equityWt = 50; durationWt = 20; creditWt = 10; cashWt = 20;
    riskBudget = 'Moderate';
    actionItems = ['Hold current allocation', 'Wait for regime signal to clarify'];
  }

  var col = tlScoreColor(composite);

  var html = '<div style="font-family:Arial,Helvetica,sans-serif;text-align:left;">';
  // Headline posture
  html += '<div style="background:' + col + ';color:#FFFFFF;padding:14px 16px;border-radius:6px;margin-bottom:12px;">';
  html += '<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;opacity:.85;font-weight:600;">Recommended Posture</div>';
  html += '<div style="font-size:18px;font-weight:800;margin:4px 0;line-height:1.2;">' + posture + '</div>';
  html += '<div style="font-size:11.5px;line-height:1.55;opacity:.95;margin-top:6px;">' + postureDetail + '</div>';
  html += '<div style="margin-top:8px;font-size:11px;opacity:.85;"><strong>Risk Budget:</strong> ' + riskBudget + '</div>';
  html += '</div>';

  // Action items
  if (actionItems && actionItems.length) {
    html += '<div style="margin-bottom:10px;">';
    html += '<div style="font-size:10.5px;font-weight:700;color:#003C71;text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px;">Action Checklist</div>';
    html += '<div style="display:flex;flex-direction:column;gap:4px;">';
    actionItems.forEach(function(item) {
      var isDontItem = item.toUpperCase().indexOf('DO NOT') >= 0 || item.toUpperCase().indexOf('AVOID') >= 0;
      var itemCol = isDontItem ? '#8B2A2A' : '#000000';
      var itemBg  = isDontItem ? 'rgba(139,42,42,0.06)' : 'transparent';
      var icon    = isDontItem ? '✕' : '✓';
      var iconCol = isDontItem ? '#8B2A2A' : '#2E7D52';
      html += '<div style="display:flex;align-items:flex-start;gap:8px;padding:4px 8px;background:' + itemBg + ';border-radius:3px;">';
      html += '<span style="color:' + iconCol + ';font-weight:700;font-size:12px;margin-top:1px;flex-shrink:0;">' + icon + '</span>';
      html += '<span style="font-size:12px;color:' + itemCol + ';line-height:1.4;">' + item + '</span>';
      html += '</div>';
    });
    html += '</div></div>';
  }

  // Asset allocation horizontal bar
  html += '<div style="margin-bottom:5px;font-size:10.5px;font-weight:700;color:#003C71;text-transform:uppercase;letter-spacing:.4px;">Target Allocation</div>';
  html += '<div style="display:flex;height:28px;border-radius:4px;overflow:hidden;border:1px solid #D0D7E0;">';
  var segs = [
    { lbl: 'Equity', pct: equityWt, col: '#003C71' },
    { lbl: 'Duration', pct: durationWt, col: '#5B9BD5' },
    { lbl: 'Credit', pct: creditWt, col: '#A8C8E8' },
    { lbl: 'Cash', pct: cashWt, col: '#C8D0D8' }
  ];
  segs.forEach(function(s) {
    if (s.pct < 4) return;
    var textCol = (s.col === '#A8C8E8' || s.col === '#C8D0D8') ? '#000000' : '#FFFFFF';
    html += '<div style="width:' + s.pct + '%;background:' + s.col + ';color:' + textCol + ';display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:700;">' + s.pct + '%</div>';
  });
  html += '</div>';
  html += '<div style="display:flex;justify-content:space-between;margin-top:5px;font-size:10px;color:#5A6A7A;">';
  segs.forEach(function(s) {
    html += '<span><span style="display:inline-block;width:7px;height:7px;background:' + s.col + ';margin-right:3px;border-radius:1px;"></span>' + s.lbl + ' ' + s.pct + '%</span>';
  });
  html += '</div>';
  html += '</div>';
  el.innerHTML = html;
}

function tlRenderMacroHeadwinds(pillars) {
  var el = document.getElementById('macroHeadwinds');
  if (!el) return;
  // Build six force vectors mapped from pillars
  var forces = [
    { name: 'Growth', score: getPillarScore(pillars, 'Business Cycle'), positive: 'Expansion', negative: 'Contraction' },
    { name: 'Inflation', score: getInflationScore(pillars), positive: 'Disinflation', negative: 'Inflation Shock' },
    { name: 'Rates', score: getPillarScore(pillars, 'Yield Curve'), positive: 'Steepening', negative: 'Inverted/Tight' },
    { name: 'Credit', score: getPillarScore(pillars, 'Credit Conditions'), positive: 'Tight (Risk-On)', negative: 'Stress' },
    { name: 'Liquidity', score: getLiquidityScore(pillars), positive: 'Ample', negative: 'Tightening' },
    { name: 'Risk Appetite', score: getPillarScore(pillars, 'Breadth (Fear/Greed)'), positive: 'Greed', negative: 'Fear' }
  ];
  var html = '<div style="font-family:Arial,Helvetica,sans-serif;text-align:left;">';
  forces.forEach(function(f) {
    var sc = f.score;
    var col = sc != null ? tlScoreColor(sc) : '#A8C8E8';
    var pct = sc != null ? sc : 50;
    html += '<div style="margin-bottom:11px;">';
    html += '<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;">';
    html += '<span style="font-weight:700;color:#003C71;">' + f.name + '</span>';
    html += '<span style="color:' + col + ';font-weight:700;">' + (sc != null ? Math.round(sc) : '—') + '</span>';
    html += '</div>';
    // Bidirectional bar — center is 50, positive goes right, negative goes left
    html += '<div style="position:relative;height:18px;background:#F4F6F9;border:1px solid #D0D7E0;border-radius:3px;overflow:hidden;">';
    html += '<div style="position:absolute;top:0;bottom:0;left:50%;width:1px;background:#5A6A7A;"></div>';
    if (sc != null) {
      if (sc >= 50) {
        var w = (sc - 50) * 2; // 0 to 100
        html += '<div style="position:absolute;top:0;bottom:0;left:50%;width:' + (w / 2) + '%;background:' + col + ';"></div>';
      } else {
        var w2 = (50 - sc) * 2;
        html += '<div style="position:absolute;top:0;bottom:0;right:50%;width:' + (w2 / 2) + '%;background:' + col + ';"></div>';
      }
    }
    html += '</div>';
    html += '<div style="display:flex;justify-content:space-between;margin-top:2px;font-size:9.5px;color:#5A6A7A;">';
    html += '<span>← ' + f.negative + '</span><span>' + f.positive + ' →</span>';
    html += '</div>';
    html += '</div>';
  });
  html += '</div>';
  el.innerHTML = html;
}

function getPillarScore(pillars, name) {
  var p = pillars.find(function(x) { return x.name === name; });
  return p ? p.score : null;
}
function getInflationScore(pillars) {
  // Pull from FRED data if available
  if (window._lastMacroData && window._lastMacroData.pillars) {
    var infl = window._lastMacroData.pillars.find(function(p) { return p.name === 'Inflation'; });
    if (infl && infl.indicators) {
      var positive = 0, total = 0;
      infl.indicators.forEach(function(i) {
        if (typeof i.score === 'number') { positive += (i.score + 1) / 2; total++; }
      });
      return total > 0 ? (positive / total) * 100 : null;
    }
  }
  return null;
}
function getLiquidityScore(pillars) {
  if (window._lastMacroData && window._lastMacroData.pillars) {
    var glob = window._lastMacroData.pillars.find(function(p) { return p.name === 'Global Liquidity'; });
    if (glob && glob.indicators) {
      var positive = 0, total = 0;
      glob.indicators.forEach(function(i) {
        if (typeof i.score === 'number') { positive += (i.score + 1) / 2; total++; }
      });
      return total > 0 ? (positive / total) * 100 : null;
    }
  }
  return null;
}

function tlRenderPortfolioArchetypes(composite, pillars) {
  var el = document.getElementById('portfolioArchetypes');
  if (!el) return;
  // 5 archetypes with their target weights
  var archetypes = [
    { name: 'All-Weather (Bridgewater)', weights: { equity: 30, longBonds: 40, intlBonds: 15, gold: 7.5, commodities: 7.5 },
      bestRegime: 'neutral', fitScore: 0,
      rationale: 'Ray Dalio (1996). Performs across growth/inflation/recession quadrants. Long duration and commodities diversify equity beta.',
      etfs: 'SPY 30 / TLT 40 / IEF 15 / GLD 7.5 / DBC 7.5' },
    { name: 'Permanent Portfolio (Browne)', weights: { equity: 25, longBonds: 25, gold: 25, cash: 25 },
      bestRegime: 'risk-off', fitScore: 0,
      rationale: 'Harry Browne (1981). Survives any of 4 macro regimes. Heavy gold/cash anchor — lowest drawdowns historically.',
      etfs: 'SPY 25 / TLT 25 / GLD 25 / SHY 25' },
    { name: '60/40 Classic (Shiller bench)', weights: { equity: 60, intermBonds: 40 },
      bestRegime: 'neutral', fitScore: 0,
      rationale: 'Standard pension benchmark. Works in disinflationary expansion; struggles when bonds + stocks correlate (2022).',
      etfs: 'SPY 60 / IEF 40' },
    { name: 'Risk-On Growth Tilt', weights: { equity: 75, smallCap: 10, em: 10, hyCredit: 5 },
      bestRegime: 'risk-on', fitScore: 0,
      rationale: 'Aggressive allocation for confirmed expansion + steepening yield curve. Tech/SmallCap/EM lead the cycle up.',
      etfs: 'QQQ 40 / SPY 25 / IWM 10 / EEM 10 / VTV 10 / HYG 5' },
    { name: 'Defensive Quality', weights: { qualEquity: 50, longBonds: 25, gold: 10, cash: 15 },
      bestRegime: 'defensive', fitScore: 0,
      rationale: 'Late-cycle posture: large-cap quality, dividend payers, long duration as recession hedge.',
      etfs: 'QUAL 30 / SPHD 20 / TLT 25 / GLD 10 / SHY 15' }
  ];
  // Score each archetype based on regime alignment
  var brScore = getPillarScore(pillars, 'Business Cycle');
  var crScore = getPillarScore(pillars, 'Credit Conditions');
  var bdScore = getPillarScore(pillars, 'Breadth (Fear/Greed)');
  // Use Perry state directly for archetype fit scoring
  var perryStateArch = window._perryState || 'neutral';
  var perryToArchFit = {
    // For each Perry state, score each archetype bestRegime
    leveraged: { 'risk-on': 90, 'neutral': 50, 'defensive': 30, 'risk-off': 20 },
    growth:    { 'risk-on': 75, 'neutral': 65, 'defensive': 35, 'risk-off': 15 },
    neutral:   { 'risk-on': 35, 'neutral': 70, 'defensive': 60, 'risk-off': 40 },
    drawdown:  { 'risk-on': 15, 'neutral': 55, 'defensive': 75, 'risk-off': 85 }
  };
  var fitMap = perryToArchFit[perryStateArch] || perryToArchFit['neutral'];
  archetypes.forEach(function(a) {
    // Base fit from Perry state
    var baseFit = fitMap[a.bestRegime] || 50;
    // Nudge ±10 from FRED macro for nuance within the band
    var bcPillarArch = pillars.find(function(p) { return p.name === 'Business Cycle'; });
    var bcNudge = bcPillarArch && bcPillarArch.score != null ? (bcPillarArch.score - 50) / 10 : 0;
    a.fitScore = Math.max(0, Math.min(100, baseFit + bcNudge));
  });
  archetypes.sort(function(a, b) { return b.fitScore - a.fitScore; });

  var html = '<div style="font-family:Arial,Helvetica,sans-serif;text-align:left;">';
  archetypes.forEach(function(a, i) {
    var col = tlScoreColor(a.fitScore);
    var rank = i + 1;
    var rankBg = i === 0 ? '#003C71' : i === 1 ? '#5B9BD5' : '#A8C8E8';
    var rankTxt = i === 0 ? '#FFFFFF' : i === 1 ? '#FFFFFF' : '#000000';
    html += '<div style="display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:10px 12px;border:1px solid #D0D7E0;border-radius:4px;margin-bottom:7px;background:' + (i === 0 ? '#F4F6F9' : '#FFFFFF') + ';">';
    html += '<div style="background:' + rankBg + ';color:' + rankTxt + ';width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;">#' + rank + '</div>';
    html += '<div>';
    html += '<div style="font-size:13px;font-weight:700;color:#003C71;">' + a.name + '</div>';
    html += '<div style="font-size:10.5px;color:#5A6A7A;line-height:1.5;margin-top:2px;">' + a.rationale + '</div>';
    html += '<div style="font-size:10px;color:#000000;margin-top:4px;font-family:Arial,Helvetica,sans-serif;background:#F4F6F9;padding:3px 6px;border-radius:3px;display:inline-block;">' + a.etfs + '</div>';
    html += '</div>';
    html += '<div style="text-align:right;min-width:60px;">';
    html += '<div style="font-size:11px;color:#5A6A7A;font-weight:600;">Fit</div>';
    html += '<div style="font-size:18px;font-weight:800;color:' + col + ';">' + Math.round(a.fitScore) + '</div>';
    html += '</div>';
    html += '</div>';
  });
  html += '</div>';
  el.innerHTML = html;
}

async function tlRenderMovingToday() {
  var el = document.getElementById('movingToday');
  if (!el) return;
  // Get the snapshot cells (already loaded by snapshotLoad if available)
  if (!window._snapshotCells || !window._snapshotCells.length) {
    // Trigger load and retry
    if (typeof snapshotLoad === 'function') await snapshotLoad();
  }
  var cells = window._snapshotCells || [];
  if (!cells.length) {
    el.innerHTML = '<div style="padding:14px;color:#5A6A7A;font-size:12px;font-family:Arial,Helvetica,sans-serif;">Load Global Snapshot first.</div>';
    return;
  }
  // Sort by abs change %
  var sorted = cells.slice().sort(function(a, b) { return Math.abs(b.changePct) - Math.abs(a.changePct); });
  var top5 = sorted.slice(0, 5);

  // Driver classification heuristic
  function classify(c) {
    var t = c.ticker.replace('^', '');
    if (['TLT','IEF','SHY'].indexOf(t) >= 0) return c.changePct > 0 ? 'Duration Bid (Risk-Off)' : 'Duration Sold (Yields Up)';
    if (['HYG','LQD'].indexOf(t) >= 0) return c.changePct > 0 ? 'Credit Demand' : 'Credit Spreads Widening';
    if (['UUP','FXE','FXY','CYB'].indexOf(t) >= 0) return 'FX Move';
    if (['GLD','SLV'].indexOf(t) >= 0) return c.changePct > 0 ? 'Safe-Haven Flight' : 'Risk Appetite Returning';
    if (['USO','UNG','DBA'].indexOf(t) >= 0) return 'Commodity Move';
    if (['VIX'].indexOf(t) >= 0) return c.changePct > 0 ? 'Volatility Spike' : 'Vol Compressing';
    if (['SPY','QQQ','DIA','IWM'].indexOf(t) >= 0) return c.changePct > 0 ? 'US Equity Rally' : 'US Equity Selloff';
    if (['EFA','EEM','EWJ','FXI'].indexOf(t) >= 0) return c.changePct > 0 ? 'Intl Equity Rally' : 'Intl Equity Selloff';
    return 'Other';
  }

  var html = '<table style="width:100%;border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:12px;">';
  html += '<thead><tr><th style="background:#003C71;color:#FFFFFF;padding:8px 10px;text-align:left;font-size:12px;font-weight:600;">Ticker</th><th style="background:#003C71;color:#FFFFFF;padding:8px 10px;text-align:right;font-size:12px;font-weight:600;">1-Day</th><th style="background:#003C71;color:#FFFFFF;padding:8px 10px;text-align:left;font-size:12px;font-weight:600;">Driver</th></tr></thead><tbody>';
  top5.forEach(function(c, i) {
    var col = c.changePct >= 0 ? '#2E7D52' : '#8B2A2A';
    var rowBg = i % 2 === 0 ? '#FFFFFF' : '#F4F6F9';
    html += '<tr style="background:' + rowBg + ';">';
    html += '<td style="padding:8px 10px;font-weight:700;color:#003C71;border-bottom:1px solid #D0D7E0;">' + c.ticker.replace('^','') + '</td>';
    html += '<td style="padding:8px 10px;text-align:right;font-weight:700;color:' + col + ';border-bottom:1px solid #D0D7E0;font-family:Courier New,monospace;">' + (c.changePct >= 0 ? '+' : '') + c.changePct.toFixed(2) + '%</td>';
    html += '<td style="padding:8px 10px;color:#000000;border-bottom:1px solid #D0D7E0;">' + classify(c) + '</td>';
    html += '</tr>';
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

// ═══════════════════════════════════════════════
// MOVERS LEADERBOARD (full universe ranked, multi-timeframe)
// ═══════════════════════════════════════════════
window.moversRender = async function(tf) {
  tf = tf || '1d';
  var el = document.getElementById('moversLeaderboard');
  if (!el) return;
  // Update button state
  document.querySelectorAll('.ca-mover-tf-btn').forEach(function(b) {
    b.style.background = b.dataset.tf === tf ? '#5B9BD5' : '#A8C8E8';
  });
  el.innerHTML = '<span class="spinner"></span> Computing ' + tf + ' moves across universe...';
  try {
    if (!window._snapshotCells || !window._snapshotCells.length) {
      if (typeof snapshotLoad === 'function') await snapshotLoad();
    }
    var cells = window._snapshotCells || [];
    if (!cells.length) { el.innerHTML = '<span style="color:#8B2A2A;">Snapshot data unavailable.</span>'; return; }
    var n = tf === '1d' ? 1 : tf === '1w' ? 5 : 21;
    // For 1w / 1m we need to fetch the chart (1d data is already in cells)
    if (tf === '1d') {
      // use existing cell.changePct
      var rows = cells.map(function(c) { return { ticker: c.ticker, label: c.label, ret: c.changePct }; })
                      .filter(function(r) { return r.ret != null; })
                      .sort(function(a, b) { return b.ret - a.ret; });
      tlRenderMoversTable(rows, tf);
    } else {
      // Fetch chart for each ticker
      var rows2 = [];
      await Promise.all(cells.map(async function(c) {
        try {
          var pts = await tlFetchChart(c.ticker.replace('^', '%5E'), '3mo');
          if (pts.length >= n + 1) {
            var ret = (pts[pts.length - 1].close - pts[pts.length - 1 - n].close) / pts[pts.length - 1 - n].close * 100;
            rows2.push({ ticker: c.ticker, label: c.label, ret: ret });
          }
        } catch (e) {}
      }));
      rows2.sort(function(a, b) { return b.ret - a.ret; });
      tlRenderMoversTable(rows2, tf);
    }
  } catch (e) { el.innerHTML = '<span style="color:#8B2A2A;">' + e.message + '</span>'; }
};

function tlRenderMoversTable(rows, tf) {
  var el = document.getElementById('moversLeaderboard');
  if (!el) return;
  var topN = rows.slice(0, 8);
  var botN = rows.slice(-8).reverse();
  var label = tf === '1d' ? '1-Day' : tf === '1w' ? '1-Week' : '1-Month';
  var html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;font-family:Arial,Helvetica,sans-serif;">';
  // Top gainers
  html += '<div>';
  html += '<div style="background:#003C71;color:#FFFFFF;padding:7px 12px;font-size:12px;font-weight:700;border-radius:4px 4px 0 0;">▲ Top Gainers — ' + label + '</div>';
  html += '<table style="width:100%;border-collapse:collapse;font-size:12px;border:1px solid #D0D7E0;border-top:none;border-radius:0 0 4px 4px;">';
  topN.forEach(function(r, i) {
    html += '<tr style="background:' + (i % 2 === 0 ? '#FFFFFF' : '#F4F6F9') + ';">';
    html += '<td style="padding:6px 10px;color:#003C71;font-weight:700;border-bottom:1px solid #D0D7E0;">' + r.ticker.replace('^', '') + '</td>';
    html += '<td style="padding:6px 10px;color:#000000;border-bottom:1px solid #D0D7E0;font-size:11px;">' + r.label + '</td>';
    html += '<td style="padding:6px 10px;text-align:right;color:#2E7D52;font-weight:700;font-family:Courier New,monospace;border-bottom:1px solid #D0D7E0;">+' + r.ret.toFixed(2) + '%</td>';
    html += '</tr>';
  });
  html += '</table></div>';
  // Top losers
  html += '<div>';
  html += '<div style="background:#003C71;color:#FFFFFF;padding:7px 12px;font-size:12px;font-weight:700;border-radius:4px 4px 0 0;">▼ Top Losers — ' + label + '</div>';
  html += '<table style="width:100%;border-collapse:collapse;font-size:12px;border:1px solid #D0D7E0;border-top:none;border-radius:0 0 4px 4px;">';
  botN.forEach(function(r, i) {
    html += '<tr style="background:' + (i % 2 === 0 ? '#FFFFFF' : '#F4F6F9') + ';">';
    html += '<td style="padding:6px 10px;color:#003C71;font-weight:700;border-bottom:1px solid #D0D7E0;">' + r.ticker.replace('^', '') + '</td>';
    html += '<td style="padding:6px 10px;color:#000000;border-bottom:1px solid #D0D7E0;font-size:11px;">' + r.label + '</td>';
    html += '<td style="padding:6px 10px;text-align:right;color:#8B2A2A;font-weight:700;font-family:Courier New,monospace;border-bottom:1px solid #D0D7E0;">' + r.ret.toFixed(2) + '%</td>';
    html += '</tr>';
  });
  html += '</table></div>';
  html += '</div>';
  el.innerHTML = html;
}

// ═══════════════════════════════════════════════
// DRIVER THEME MAP
// ═══════════════════════════════════════════════
window.driverThemeMapRun = async function() {
  var el = document.getElementById('driverThemeMap');
  if (!el) return;
  el.innerHTML = '<span class="spinner"></span> Classifying market drivers...';
  try {
    var [spy, qqq, iwm, xlp, xlu, xlv, tlt, hyg, lqd, gld, uup, uso, vix] = await Promise.all([
      tlFetchChart('SPY', '3mo'), tlFetchChart('QQQ', '3mo'), tlFetchChart('IWM', '3mo'),
      tlFetchChart('XLP', '3mo'), tlFetchChart('XLU', '3mo'), tlFetchChart('XLV', '3mo'),
      tlFetchChart('TLT', '3mo'), tlFetchChart('HYG', '3mo'), tlFetchChart('LQD', '3mo'),
      tlFetchChart('GLD', '3mo'), tlFetchChart('UUP', '3mo'), tlFetchChart('USO', '3mo'),
      tlFetchChart('%5EVIX', '3mo')
    ]);
    function r(arr, n) { return tlPctRet(arr, n) || 0; }
    var spy20 = r(spy, 20), qqq20 = r(qqq, 20), iwm20 = r(iwm, 20);
    var xlp20 = r(xlp, 20), xlu20 = r(xlu, 20), xlv20 = r(xlv, 20);
    var tlt20 = r(tlt, 20), hyg20 = r(hyg, 20), lqd20 = r(lqd, 20);
    var gld20 = r(gld, 20), uup20 = r(uup, 20), uso20 = r(uso, 20);
    var vixCur = vix.length ? vix[vix.length - 1].close : 20;
    var defensiveAvg = (xlp20 + xlu20 + xlv20) / 3;

    var themes = [
      {
        name: 'Disinflation Trade',
        active: tlt20 > 2 && qqq20 > spy20 && uup20 < 0,
        latent: tlt20 > 0 && qqq20 > spy20,
        rationale: 'Long bonds rallying, tech leading, dollar weakening. Falling rates supporting long-duration assets.'
      },
      {
        name: 'Re-Flation / Cyclical',
        active: iwm20 > spy20 && uso20 > 5 && tlt20 < 0,
        latent: iwm20 > spy20 || uso20 > 3,
        rationale: 'Small caps and commodities leading, bonds selling. Growth + inflation expectations rising.'
      },
      {
        name: 'Defensive Rotation',
        active: defensiveAvg > spy20 && tlt20 > 0,
        latent: defensiveAvg > spy20,
        rationale: 'Staples/utilities/healthcare outperforming with bonds rallying. Late-cycle / risk-off positioning.'
      },
      {
        name: 'Risk-Off Flight',
        active: gld20 > 5 && uup20 > 2 && hyg20 < 0,
        latent: gld20 > 3 || hyg20 < -1,
        rationale: 'Gold + dollar bid, HY credit selling. Classic safe-haven flight pattern.'
      },
      {
        name: 'Vol Spike / Tail Risk',
        active: vixCur > 25,
        latent: vixCur > 18,
        rationale: 'Implied vol elevated. Markets pricing tail risk. Hedge demand active.'
      },
      {
        name: 'Credit Stress',
        active: hyg20 < lqd20 - 2,
        latent: hyg20 < lqd20,
        rationale: 'HY underperforming IG credit — early warning for risk assets.'
      },
      {
        name: 'Dollar Strength',
        active: uup20 > 3,
        latent: uup20 > 1,
        rationale: 'USD rally — typically EM negative, commodity negative, growth-headwind.'
      },
      {
        name: 'Tech / AI Leadership',
        active: qqq20 > spy20 + 3 && qqq20 > 5,
        latent: qqq20 > spy20,
        rationale: 'Mega-cap tech leadership. Growth narrative dominant.'
      }
    ];
    var html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;font-family:Arial,Helvetica,sans-serif;text-align:left;">';
    themes.forEach(function(t) {
      var status = t.active ? 'Active' : t.latent ? 'Latent' : 'Inactive';
      var col = t.active ? '#2E7D52' : t.latent ? '#8B6914' : '#C8D0D8';
      var bgCol = t.active ? 'rgba(46,125,82,0.08)' : t.latent ? 'rgba(139,105,20,0.08)' : '#F4F6F9';
      var textCol = t.active || t.latent ? '#000000' : '#5A6A7A';
      html += '<div style="border:1px solid #D0D7E0;border-left:3px solid ' + col + ';padding:10px 12px;background:' + bgCol + ';border-radius:4px;">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">';
      html += '<div style="font-size:12px;font-weight:700;color:#003C71;">' + t.name + '</div>';
      html += '<div style="font-size:10px;font-weight:700;color:#FFFFFF;background:' + col + ';padding:2px 8px;border-radius:8px;text-transform:uppercase;letter-spacing:.4px;">' + status + '</div>';
      html += '</div>';
      html += '<div style="font-size:11px;color:' + textCol + ';line-height:1.5;">' + t.rationale + '</div>';
      html += '</div>';
    });
    html += '</div>';
    el.innerHTML = html;
  } catch (e) { el.innerHTML = '<span style="color:#8B2A2A;">' + e.message + '</span>'; }
};

// ═══════════════════════════════════════════════
// SECTOR ROTATION MAP CHART
// ═══════════════════════════════════════════════
window.rotationMapRun = async function() {
  var emptyEl = document.getElementById('rotationMapEmpty');
  var wrapEl = document.getElementById('rotationMapWrap');
  if (!emptyEl) return;
  emptyEl.innerHTML = '<span class="spinner"></span> Computing rotation ratio...';
  try {
    var cyc = ['XLK','XLY','XLI','XLF','XLE','XLB','XLRE','XLC'];
    var def = ['XLP','XLV','XLU'];
    var data = {};
    var allSec = cyc.concat(def);
    await Promise.all(allSec.map(async function(t) {
      data[t] = await tlFetchChart(t, '1y');
    }));
    if (!data['XLK'].length) { emptyEl.innerHTML = '<span style="color:#8B2A2A;">Sector data unavailable.</span>'; return; }
    // Find common dates
    var allDatesSet = new Set();
    cyc.forEach(function(t) { (data[t]||[]).forEach(function(p) { allDatesSet.add(p.date.slice(0,10)); }); });
    var dates = Array.from(allDatesSet).sort();
    // Build price maps with forward-fill
    var fillMap = {};
    allSec.forEach(function(t) {
      var pm = {};
      (data[t]||[]).forEach(function(p) { pm[p.date.slice(0,10)] = p.close; });
      var last = null;
      fillMap[t] = dates.map(function(d) { if (pm[d] != null) last = pm[d]; return last; });
    });
    // Build cyclical and defensive equal-weight indices
    var cycIdx = [], defIdx = [];
    for (var i = 0; i < dates.length; i++) {
      var cAvg = 0, cN = 0, dAvg = 0, dN = 0;
      cyc.forEach(function(t) {
        var bp = fillMap[t][0];
        var p = fillMap[t][i];
        if (bp && p) { cAvg += p / bp; cN++; }
      });
      def.forEach(function(t) {
        var bp = fillMap[t][0];
        var p = fillMap[t][i];
        if (bp && p) { dAvg += p / bp; dN++; }
      });
      cycIdx.push(cN > 0 ? cAvg / cN : null);
      defIdx.push(dN > 0 ? dAvg / dN : null);
    }
    // Ratio rebased to 100
    var ratio = [], baseRatio = null;
    for (var i = 0; i < dates.length; i++) {
      if (cycIdx[i] != null && defIdx[i] != null && defIdx[i] > 0) {
        var r = cycIdx[i] / defIdx[i];
        if (baseRatio == null) baseRatio = r;
        ratio.push(r / baseRatio * 100);
      } else { ratio.push(null); }
    }
    // 60-day SMA
    var sma60 = [];
    for (var i = 0; i < ratio.length; i++) {
      if (i < 59) { sma60.push(null); continue; }
      var s = 0, c = 0;
      for (var j = i - 59; j <= i; j++) { if (ratio[j] != null) { s += ratio[j]; c++; } }
      sma60.push(c > 30 ? s / c : null);
    }
    // Thin labels
    var step = Math.max(1, Math.floor(dates.length / 12));
    emptyEl.style.display = 'none';
    if (wrapEl) wrapEl.style.display = '';
    var ctx = document.getElementById('rotationMapChart');
    if (window._rotMapChart) window._rotMapChart.destroy();
    window._rotMapChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: dates,
        datasets: [
          { label: 'Cyclicals / Defensives Ratio', data: ratio, borderColor: '#003C71', backgroundColor: 'rgba(0,60,113,0.08)', borderWidth: 2.5, pointRadius: 0, tension: 0.15, fill: true },
          { label: '60-Day SMA', data: sma60, borderColor: '#5B9BD5', backgroundColor: 'transparent', borderWidth: 1.8, borderDash: [5,3], pointRadius: 0, tension: 0.15, fill: false }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { position: 'top', labels: { font: { family: 'Arial,Helvetica,sans-serif', size: 11 }, color: '#5A6A7A', boxWidth: 12, padding: 12 } },
          tooltip: {
            backgroundColor: '#FFFFFF', titleColor: '#000000', bodyColor: '#000000',
            borderColor: '#D0D7E0', borderWidth: 1,
            titleFont: { family: 'Arial,Helvetica,sans-serif', size: 12, weight: '600' },
            bodyFont: { family: 'Arial,Helvetica,sans-serif', size: 12 }
          }
        },
        scales: {
          x: {
            ticks: { font: { family: 'Arial,Helvetica,sans-serif', size: 11 }, color: '#5A6A7A', maxTicksLimit: 10, maxRotation: 0, callback: function(v, i) { return i % step === 0 ? dates[i] : ''; } },
            grid: { color: 'rgba(208,215,224,0.5)' }
          },
          y: {
            ticks: { font: { family: 'Arial,Helvetica,sans-serif', size: 11 }, color: '#5A6A7A', callback: function(v) { return v.toFixed(1); } },
            grid: { color: 'rgba(208,215,224,0.5)' },
            title: { display: true, text: 'Cyc/Def Ratio (rebased to 100)', font: { family: 'Arial,Helvetica,sans-serif', size: 11 }, color: '#5A6A7A' }
          }
        }
      }
    });
  } catch (e) { emptyEl.innerHTML = '<span style="color:#8B2A2A;">' + e.message + '</span>'; }
};

// ── Cross-Asset tab auto-load timestamps ──────────────────────────────────
// Tracks when each tab's data was last fetched. Skips re-fetch if fresh.
// Market data: 4h staleness window. Macro/regime: 12h.
window._caTabLoadedAt = {};
var CA_STALE_MARKET = 4 * 60 * 60 * 1000;   // 4 hours
var CA_STALE_MACRO  = 12 * 60 * 60 * 1000;  // 12 hours

function caIsStale(name, windowMs) {
  var t = window._caTabLoadedAt[name];
  return !t || (Date.now() - t) > (windowMs || CA_STALE_MARKET);
}
function caMarkLoaded(name) { window._caTabLoadedAt[name] = Date.now(); }

window.caShowTab = function(name) {
  _toggleTabs('#page-markets', 'data-catab', name, 'catab-');
  caAutoLoad(name);
};

// caAutoLoad: fires all data-loading functions for a given tab.
// Each function is guarded by a staleness check so returning to a tab
// within 4h does not trigger redundant network requests.
function caAutoLoad(name) {
  if (name === 'topline') {
    // Always refresh top-line on visit — it's the primary decision surface.
    // topLineRefreshAll has its own internal dedup via window._tlLoading.
    if (typeof topLineRefreshAll === 'function') {
      setTimeout(topLineRefreshAll, 80);
    }
  }

  if (name === 'bizycle') {
    if (caIsStale('bizycle', CA_STALE_MACRO)) {
      caMarkLoaded('bizycle');
      setTimeout(bcTabLoad, 100);
    }
  }

  if (name === 'movers') {
    if (caIsStale('movers')) {
      caMarkLoaded('movers');
      setTimeout(function() {
        if (typeof moversRender === 'function') moversRender('1d');
        if (typeof driverThemeMapRun === 'function') driverThemeMapRun();
        if (typeof rotationMapRun === 'function') rotationMapRun();
      }, 150);
    }
  }

  if (name === 'regime') {
    // Perry State diagnostic — always refresh to reflect latest quarterly lock
    if (typeof psLoadDiagnostic === 'function') {
      setTimeout(function() { psLoadDiagnostic(); }, 100);
    }
    // Fibonacci levels — load once per session (price-history dependent)
    if (typeof psLoadFib === 'function' && !window._caFibLoaded) {
      window._caFibLoaded = true;
      setTimeout(function() { psLoadFib(); }, 400);
    }
    // Bayesian regime transition — load once, stale after 12h
    if (typeof brtRun === 'function' && caIsStale('regime_brt', CA_STALE_MACRO)) {
      caMarkLoaded('regime_brt');
      setTimeout(function() { brtRun(); }, 600);
    }
    // Regime distance + RMT (Wasserstein / eigenvalue) — stale after 4h
    if (typeof regimeDistanceRun === 'function' && caIsStale('regime_dist')) {
      caMarkLoaded('regime_dist');
      setTimeout(function() { regimeDistanceRun(); }, 800);
    }
    // Cycle breakdown table — auto-loads on macro page; not needed here
    // (regimeLoadBreakdown is called from loadMacroLiveTable instead)
  }

  if (name === 'breadth') {
    if (caIsStale('breadth')) {
      caMarkLoaded('breadth');
      setTimeout(function() {
        if (typeof mktLoadFearGreed === 'function') mktLoadFearGreed();
        if (typeof mktLoadSectorMomentum === 'function') mktLoadSectorMomentum();
        if (typeof mktLoadReturnHeatmap === 'function') mktLoadReturnHeatmap();
        if (typeof mktLoadBroadening === 'function') mktLoadBroadening();
      }, 150);
      setTimeout(function() {
        if (typeof mktLoadQuantamental === 'function') mktLoadQuantamental();
      }, 2000);
      setTimeout(function() {
        if (typeof mktLoadOmega === 'function') mktLoadOmega();
      }, 1500);
    }
  }

  if (name === 'credit') {
    if (caIsStale('credit', CA_STALE_MACRO)) {
      caMarkLoaded('credit');
      setTimeout(creditTabLoad, 100);
    }
  }

  if (name === 'yieldcurve') {
    if (caIsStale('yieldcurve', CA_STALE_MACRO)) {
      caMarkLoaded('yieldcurve');
      setTimeout(ycTabLoad, 100);
    }
  }

  if (name === 'momentum') {
    if (caIsStale('momentum')) {
      caMarkLoaded('momentum');
      setTimeout(momTabLoad, 100);
    }
  }

  if (name === 'sectors') {
    if (caIsStale('sectors')) {
      caMarkLoaded('sectors');
      setTimeout(sectorsTabLoad, 100);
    }
  }

  if (name === 'analytics') {
    if (!window._mktInitialized && typeof mktInit === 'function') {
      mktInit(); window._mktInitialized = true;
    }
    var endEl0 = document.getElementById('mktEndDate');
    if (endEl0 && !endEl0.value) endEl0.value = new Date().toISOString().slice(0, 10);
    if (caIsStale('analytics')) {
      caMarkLoaded('analytics');
      setTimeout(function() {
        if (typeof mktLoadAll === 'function') mktLoadAll();
      }, 300);
      if (typeof regimeDistanceRun === 'function' && caIsStale('regime_dist')) {
        caMarkLoaded('regime_dist');
        setTimeout(regimeDistanceRun, 1500);
      }
      setTimeout(function() {
        if (typeof mktLoadOmega === 'function') mktLoadOmega();
      }, 800);
    }
  }

  if (name === 'universe' || name === 'correlation' || name === 'risk' || name === 'quant') {
    // These tabs are consolidated into analytics
    caAutoLoad('analytics');
  }
}

// Auto-load snapshot when Markets page becomes active
(function bindMarketsAutoload() {
  document.addEventListener('DOMContentLoaded', function() {
    var orig = window.navigateTo;
    if (typeof orig === 'function') {
      window.navigateTo = function(p) {
        orig(p);
        if (p === 'markets') {
          // Default to Top-Line View
          if (typeof caShowTab === 'function') caShowTab('topline');
          if (!window._snapshotLoaded) {
            window._snapshotLoaded = true;
            setTimeout(function() {
              snapshotLoad();
              if (typeof topLineRefreshAll === 'function') setTimeout(topLineRefreshAll, 600);
            }, 100);
          }
        }
        if (p === 'holdings' && window._holdings && window._holdings.length) {
          setTimeout(driftRender, 200);
        }
      };
    }
  });
})();

// ═══════════════════════════════════════════════════════════
// ══  RICH HELP POPOVER SYSTEM                             ══
// ═══════════════════════════════════════════════════════════
var HELP_CONTENT = {
  // ── Portfolio / Performance ──────────────────────────────
  twr: {
    title: 'Time-Weighted Return (TWR)',
    body: 'Shows how well your investments actually performed — ignoring the timing of money you moved in or out. Think of it as your portfolio\'s "grade" as a money manager. If your TWR is beating the S&P 500 line, you\'re outperforming the market regardless of how much you deposited.',
    formula: 'TWR = (1 + R₁) × (1 + R₂) × … × (1 + Rₙ) − 1',
    action: 'If your TWR is consistently below SPY over 1+ years, consider simplifying into low-cost index funds.'
  },
  sharpe: {
    title: 'Sharpe Ratio',
    body: 'Measures how much return you\'re earning for each unit of risk you take. A Sharpe above 1.0 means you\'re being well compensated for your risk. Below 0 means a savings account would have served you better.',
    formula: 'Sharpe = (Portfolio Return − Risk-Free Rate) ÷ Volatility',
    action: 'If your Sharpe is below 0.5, your portfolio may be taking on more risk than the return justifies. Consider diversifying.'
  },
  montecarlo: {
    title: 'Monte Carlo Prediction',
    body: 'Runs thousands of "what if" simulations to show you a high estimate, low estimate, and middle estimate of where your portfolio could be in 1 year. Like a weather forecast — not a guarantee, but a realistic range of outcomes based on your portfolio\'s past behavior.',
    formula: null,
    action: 'If even the low estimate (10th percentile) is an acceptable outcome for you, your risk level is appropriate.'
  },
  var95: {
    title: 'Value at Risk — 95% (VaR)',
    body: 'On your worst day out of 20, this is roughly the most you\'d expect to lose. Example: a 1-Day VaR of $5,000 means 95% of the time your single-day loss will be less than $5,000.',
    formula: 'VaR = Portfolio Value × z(95%) × Daily Volatility',
    action: 'If this number makes you uncomfortable, reduce your allocation to volatile positions like single stocks or leveraged ETFs.'
  },
  var99: {
    title: 'Value at Risk — 99% (VaR)',
    body: 'On your worst day out of 100, this is roughly the most you\'d expect to lose. A stricter measure than VaR 95% — it captures rarer, more severe loss events.',
    formula: 'VaR = Portfolio Value × z(99%) × Daily Volatility',
    action: 'Compare this to your liquid savings. If it exceeds what you could absorb in a bad month, reduce risk.'
  },
  cvar: {
    title: 'Conditional VaR / Expected Shortfall (CVaR)',
    body: 'The average loss you\'d expect on your very worst days — not just the cutoff, but what happens beyond it. It answers: "When things go really badly, how bad does it typically get?"',
    formula: 'CVaR = Average of all losses beyond the VaR threshold',
    action: 'CVaR much larger than VaR signals "fat tail" risk — rare but extreme losses. Defensive positions like bonds or gold can help.'
  },
  maxDrawdown: {
    title: 'Maximum Drawdown',
    body: 'The largest peak-to-valley loss your portfolio has experienced — measured from the highest point down to the lowest before recovering. It tells you the worst historical loss you\'ve actually lived through.',
    formula: 'Max Drawdown = (Trough Value − Peak Value) ÷ Peak Value',
    action: 'Drawdowns over 30% often cause investors to panic-sell at the worst time. If yours is that high, consider adding lower-volatility positions.'
  },
  beta: {
    title: 'Beta vs. S&P 500',
    body: 'Measures how much your portfolio moves relative to the overall stock market. Beta = 1.0 means you move exactly with the S&P 500. Beta = 1.5 means you move 50% more (up AND down). Beta = 0.5 means half the swings.',
    formula: 'Beta = Covariance(Portfolio, SPY) ÷ Variance(SPY)',
    action: 'Beta above 1.2 in a Neutral or Defensive regime increases your downside risk. Consider trimming high-beta names.'
  },
  stressTest: {
    title: 'Historical Stress Test',
    body: 'Applies the actual returns from a past market crisis to your current holdings. This answers: "If the 2008 financial crisis happened again today with exactly what I own right now — how much would I lose?" It uses real per-stock data from the crisis period.',
    formula: null,
    action: 'If a 2008-style scenario would drop your portfolio more than you could tolerate, add uncorrelated assets like bonds, gold, or cash.'
  },
  famaFrench: {
    title: 'Factor Exposure (Fama-French)',
    body: 'Breaks down WHY your portfolio performs the way it does. It separates your returns into: market timing, small-company tilt, value-stock tilt, profitability, investment style, and momentum. This separates "luck" from intentional factor bets.',
    formula: 'Return = α + β·Market + β·Size + β·Value + β·Profitability + β·Investment + β·Momentum + ε',
    action: 'If most of your outperformance comes from one factor (e.g., momentum), know that factor can underperform for years at a time.'
  },
  regimeFit: {
    title: 'Market Regime Fit',
    body: 'The current market environment is scored as one of 4 states based on live economic data: Leveraged Growth, Normal Growth, Neutral/Cautious, or Drawdown/Defensive. This shows how well your portfolio is positioned for the environment we\'re currently in.',
    formula: null,
    action: 'A "Poor Fit" means your portfolio is built for a different environment than what we\'re in now. Review your heaviest positions.'
  },
  sectorExposure: {
    title: 'Sector Exposure',
    body: 'Shows which parts of the economy your money is working in. A well-diversified portfolio spreads exposure across multiple sectors. Being heavily concentrated in one sector (e.g., 60% Technology) amplifies both gains and losses.',
    formula: null,
    action: 'No single sector should typically exceed 25–30% of your portfolio unless you have a very high conviction view.'
  },
  // ── Stock Research ───────────────────────────────────────
  dcf: {
    title: 'Discounted Cash Flow (DCF) Valuation',
    body: 'Estimates what a company is worth TODAY based on the cash it\'s expected to generate in the future. The idea: a dollar received 5 years from now is worth less than a dollar today, so future cash flows are "discounted" back. If the result is higher than the current stock price, the stock may be undervalued.',
    formula: 'Intrinsic Value = FCF₁/(1+r) + FCF₂/(1+r)² + … + Terminal Value/(1+r)ⁿ',
    action: 'If the current stock price is more than 20% above DCF value, the stock may be priced for perfection. If 20%+ below, it may be a bargain.'
  },
  peRatio: {
    title: 'Price-to-Earnings Ratio (P/E)',
    body: 'How much investors are paying for each dollar of a company\'s profit. A P/E of 20 means you\'re paying $20 for every $1 the company earns annually. Higher P/E = investors expect faster growth. Lower P/E = may be undervalued OR slower growth expected.',
    formula: 'P/E = Stock Price ÷ Earnings Per Share (EPS)',
    action: 'Compare the P/E to the company\'s own historical average and its industry peers — a P/E only tells a story in context.'
  },
  evEbitda: {
    title: 'EV/EBITDA',
    body: 'A valuation measure that compares a company\'s total value (including debt) to its operating earnings before accounting adjustments. Better than P/E for comparing companies with different debt levels or tax situations.',
    formula: 'EV/EBITDA = Enterprise Value ÷ Earnings Before Interest, Taxes, Depreciation & Amortization',
    action: 'Below 10x is generally considered value territory for mature businesses. High-growth companies often trade at 20–40x.'
  },
  insiderTransactions: {
    title: 'Insider Transactions',
    body: 'Shows when company executives and board members buy or sell their own company\'s stock. Insiders have deep knowledge of the business — buying with their own money is a strong vote of confidence. Heavy selling can be a warning sign (though it\'s sometimes just diversification).',
    formula: null,
    action: 'Multiple insiders buying simultaneously, especially at market prices (not options), is one of the strongest bullish signals available.'
  },
  moat: {
    title: 'Competitive Moat (Durable Advantage)',
    body: 'Describes how defensible a company\'s business is from competitors. A wide moat means the company has strong advantages — like a powerful brand, patents, network effects, or cost advantages — that protect its profits long-term.',
    formula: null,
    action: 'Invest in wide-moat companies for long-term holds. Narrow or no-moat companies require more frequent re-evaluation.'
  },
  // ── Macro / Regime ───────────────────────────────────────
  yieldCurve: {
    title: 'Yield Curve',
    body: 'A chart of U.S. Treasury interest rates across different time periods (2-year, 5-year, 10-year, 30-year). A normal curve slopes upward (longer = higher rate). An inverted curve (short-term rates higher than long-term) has historically predicted recessions 6–18 months ahead.',
    formula: 'Yield Curve Spread = 10-Year Treasury Yield − 2-Year Treasury Yield',
    action: 'When the yield curve inverts (spread goes negative), historically a recession follows. Consider reducing equity exposure and adding defensive positions.'
  },
  vix: {
    title: 'VIX — Market Fear Index',
    body: 'The CBOE Volatility Index measures how much fear and uncertainty is priced into the stock market. VIX below 15 = calm markets. VIX 20–30 = elevated anxiety. VIX above 30 = fear / crisis mode. Historically, buying into high-VIX periods has been profitable over the long run.',
    formula: null,
    action: 'VIX spikes above 30 are often buying opportunities for long-term investors, but short-term pain can continue.'
  },
  macroRegime: {
    title: 'Macro Regime Score',
    body: 'Scores the current economy across 6 pillars: Growth, Labor, Inflation, Monetary Policy, Fiscal, and Global/Liquidity. Each pillar gets a score from 1–10 based on real Federal Reserve data. The combined score determines which of 4 portfolio states is currently recommended.',
    formula: null,
    action: 'A score in the top third ("Leveraged Growth") historically favors aggressive positions. Bottom third ("Drawdown") historically favors cash, bonds, and hedges.'
  },
  // ── Quant Models ─────────────────────────────────────────
  mlr: {
    title: 'Multiple Linear Regression (MLR)',
    body: 'A statistical model that uses several factors at once (like VIX level, economic growth, inflation) to predict where a stock\'s price might go. It\'s like asking: "Based on everything happening in the economy right now, what does history suggest about this stock\'s next 12 months?"',
    formula: 'Predicted Return = α + β₁·VIX + β₂·GDP_Growth + β₃·Inflation + … + ε',
    action: 'The model\'s prediction is most reliable when the R² (explained variance) is above 0.25 and the current regime matches the training data regime.'
  },
  rSquared: {
    title: 'R² — Model Fit Score',
    body: 'Shows what percentage of the stock\'s price movements were explained by the model\'s inputs. R² of 0.40 means the model explained 40% of price movement. Higher is better, but no model explains everything — markets are partly unpredictable.',
    formula: 'R² = 1 − (Sum of Squared Residuals ÷ Total Sum of Squares)',
    action: 'Below 0.15 means the model has weak explanatory power for this stock. Take the predictions with extra caution.'
  },
  walkForward: {
    title: 'Walk-Forward Validation',
    body: 'Tests the model on data it has NEVER seen during training — the gold standard for validating predictions. It trains on old data, then predicts the next period, then trains on more data, and so on. If predictions are accurate out-of-sample, the model is genuinely useful.',
    formula: null,
    action: 'A model that performs well in-sample but poorly out-of-sample is "overfit" — it memorized history rather than learning patterns.'
  },
  // ── Holdings / Manage ────────────────────────────────────
  costBasis: {
    title: 'Cost Basis / Average Cost',
    body: 'The average price you paid per share across all your purchases. Used to calculate your unrealized gain or loss. If you bought 10 shares at $100 and 10 more at $120, your cost basis is $110.',
    formula: 'Average Cost = Total Amount Invested ÷ Total Shares Owned',
    action: 'Keep your cost basis records accurate — they directly affect your tax liability when you eventually sell.'
  },
  unrealizedGL: {
    title: 'Unrealized Gain / Loss',
    body: 'The profit or loss on a position you STILL own. "Unrealized" means no taxes are owed yet — it\'s only when you sell that it becomes a taxable event. A paper loss can become real if you sell, or can recover if you hold.',
    formula: 'Unrealized G/L = (Current Price − Cost Basis) × Shares',
    action: 'Unrealized losses held over 1 year can be harvested for tax purposes (tax-loss harvesting) if you believe in the position long-term.'
  },
  tlh: {
    title: 'Tax-Loss Harvesting',
    body: 'Selling a position at a loss to offset capital gains elsewhere in your portfolio, reducing your tax bill. You can then buy a similar (but not identical) investment to maintain your market exposure.',
    formula: null,
    action: 'IRS wash-sale rule: wait 30 days before buying back the same security after harvesting a loss, or the loss will be disallowed.'
  },
  // ── Portfolio visualizations (added 2026-07) ─────────────
  allocation: {
    title: 'Portfolio Allocation',
    body: 'Shows how your money is split across sectors, asset classes, and accounts. Allocation — not stock picking — explains roughly 90% of the variation in a portfolio\'s returns over time (Brinson, Hood & Beebower 1986). This is the single most important picture of your portfolio.',
    formula: 'Weight = Position Market Value ÷ Total Portfolio Value',
    action: 'Check this against your risk profile\'s target mix. If any slice looks dramatically bigger than you intended, that\'s your portfolio drifting — markets moved it, not you.'
  },
  contribution: {
    title: 'Contribution to Return',
    body: 'Breaks your total portfolio return into the piece each holding was responsible for. A stock that\'s up 50% but is only 1% of your portfolio contributes less than a stock up 8% that\'s 30% of your portfolio. This separates "what went up" from "what actually made you money."',
    formula: 'Contribution = Holding Weight × Holding Return',
    action: 'If one position drives most of your gains, your results depend on one bet — consider whether that concentration is intentional.'
  },
  brinson: {
    title: 'Brinson-Fachler Attribution',
    body: 'The institutional standard for answering: did you beat the benchmark because you picked the right SECTORS (allocation effect) or the right STOCKS within sectors (selection effect)? Each sector gets scored on both dimensions.',
    formula: 'Allocation = (wₚ − w_b) × (R_b,sector − R_b,total) · Selection = w_b × (Rₚ,sector − R_b,sector)',
    action: 'Consistently negative allocation effect means your sector tilts are hurting you — the Macro Regime page is designed to fix exactly that.'
  },
  marginalVar: {
    title: 'Marginal VaR — Risk Contributors',
    body: 'Shows which holdings contribute the most to your total portfolio risk — not just which are the biggest. A volatile position that\'s correlated with everything else can contribute far more risk than its dollar weight suggests.',
    formula: 'Marginal VaR ≈ Weight × Covariance(Holding, Portfolio) ÷ Portfolio Volatility',
    action: 'If one holding contributes 40%+ of total risk, trimming it is the fastest single way to de-risk the whole portfolio.'
  },
  correlationMatrix: {
    title: 'Correlation Matrix',
    body: 'Shows how much each pair of holdings moves together, from −1 (perfect opposites) to +1 (identical movement). Diversification only works when correlations are LOW — owning 10 stocks that all move together is really owning one big bet.',
    formula: 'ρ(A,B) = Covariance(A,B) ÷ (σ_A × σ_B)',
    action: 'Pairs above +0.8 are effectively the same position. In a crash, correlations rise toward 1 — so build in diversifiers (bonds, gold) BEFORE stress hits.'
  },
  // ── Macro page visualizations ─────────────────────────────
  quadMap: {
    title: 'Business Cycle Quad Map',
    body: 'A 2×2 grid classifying the economy by whether GROWTH is accelerating or slowing (x-axis) and whether INFLATION is accelerating or slowing (y-axis). The four quadrants — Goldilocks, Overheat, Stagflation, Deflation — each historically favor different assets. The dot shows where live FRED data places the economy today.',
    formula: 'Growth axis: Industrial Production MoM trend · Inflation axis: Core PCE YoY trend',
    action: 'Position for the quadrant we\'re IN, not the one you hope comes next. The Quad Playbook panel lists exactly which sectors historically led in each quadrant.'
  },
  macroDashboard: {
    title: 'Macro Indicator Dashboard',
    body: '24 live indicators from the Federal Reserve\'s FRED database, organized into 6 pillars (Growth, Labor, Inflation, Monetary Policy, Fiscal, Global Liquidity). Each indicator scores +1 (expansionary), 0 (neutral), or −1 (contractionary) against a defined threshold, and the total score determines the macro regime phase. Click the ⓘ on any indicator row for what it measures and why it matters.',
    formula: 'Regime Score = Σ indicator scores · Phase = score vs. thresholds (with ±2pt hysteresis buffer)',
    action: 'Don\'t react to any single indicator — the whole point of a 24-indicator scorecard is that the WEIGHT of evidence, not one data point, defines the regime.'
  },
  businessCycle: {
    title: 'Business Cycle Curve',
    body: 'The classic 4-phase economic cycle from the CFA curriculum: Early Expansion → Mid Expansion → Late Expansion/Peak → Contraction. The dot shows where the regime scorecard currently places the US economy. Each phase historically favors different sectors — early expansion favors financials and discretionary; late cycle favors energy and staples; contraction favors bonds and utilities.',
    formula: null,
    action: 'The biggest portfolio mistakes happen at phase TRANSITIONS. When the dot approaches a boundary, that\'s when to review your sector tilts — see Sector & Macro Alignment.'
  },
  cycleBreakdown: {
    title: 'Economic Cycle Breakdown',
    body: 'Where is cycle pressure building? Each category (Consumer, Business, Real Estate, Supply Chain, Labor Breadth) contains FRED indicators scored into one of five phases: Recovery, Expansion, Neutral, Slowdown, or Contraction. This granular view often catches sector-level stress the headline regime score smooths over — e.g., housing can be contracting while the consumer still expands.',
    formula: 'Level-based: value vs. expansion/contraction thresholds · Trend-based: 3M and 12M % change',
    action: 'Categories in Slowdown/Contraction flag sectors to underweight; categories in Recovery often mark where the NEXT cycle\'s winners are forming. Click each indicator\'s ⓘ for its specific meaning.'
  },
  lic: {
    title: 'Leading Indicator Composite',
    body: 'Combines forward-looking indicators (building permits, yield curve, claims, manufacturing hours, credit spreads) into one composite designed to turn BEFORE the overall economy does. Leading indicators typically peak 6–12 months ahead of recessions.',
    formula: 'Composite = weighted average of standardized leading indicator z-scores',
    action: 'Three consecutive months of composite decline has historically been an early-warning signal — time to review equity exposure, not necessarily exit.'
  },
  // ── Research / valuation visualizations ──────────────────
  incomeStatement: {
    title: 'Income Statement (5-Year)',
    body: 'The company\'s profit engine, straight from audited SEC 10-K filings: Revenue at the top, then costs subtracted layer by layer down to Net Income and EPS. The 5-year view reveals the TREND — is the growth story accelerating or decaying? Are margins expanding (pricing power) or compressing (competition)?',
    formula: 'Revenue − COGS = Gross Profit · − OpEx = Operating Income · − Interest & Tax = Net Income',
    action: 'Revenue growth with EXPANDING margins is the highest-quality combination. Revenue growth with shrinking margins means the company is buying growth.'
  },
  balanceSheet: {
    title: 'Balance Sheet (5-Year)',
    body: 'A snapshot of what the company OWNS (assets), OWES (liabilities), and what\'s left for shareholders (equity), from SEC filings. The balance sheet determines whether a company survives bad times — earnings are opinion, balance sheets are fact.',
    formula: 'Assets = Liabilities + Shareholders\' Equity · Current Ratio = Current Assets ÷ Current Liabilities',
    action: 'Watch debt trends vs. cash trends. Rising debt + falling cash while buying back stock is how quality companies quietly become fragile ones.'
  },
  cashFlow: {
    title: 'Cash Flow Statement (5-Year)',
    body: 'Follows actual CASH — the hardest number to fake in accounting. Operating cash flow shows what the business generates; capex shows what it must reinvest; what remains (free cash flow) funds dividends, buybacks, and acquisitions.',
    formula: 'Free Cash Flow = Operating Cash Flow − Capital Expenditures',
    action: 'Net income growing while operating cash flow stagnates is the classic earnings-quality red flag — profits are being manufactured on paper.'
  },
  analystEstimates: {
    title: 'Analyst Estimates & Price Targets',
    body: 'Wall Street consensus: the high, mean, median, and low 12-month price targets, plus the distribution of Buy/Hold/Sell ratings. Useful as a sentiment gauge — but remember analysts herd, anchor to current prices, and are systematically optimistic.',
    formula: null,
    action: 'The SPREAD between high and low targets is often more informative than the mean — a wide spread means genuine disagreement, i.e., higher uncertainty and higher potential mispricing.'
  },
  scenarioOutlook: {
    title: 'Bear / Base / Bull Scenarios',
    body: 'Mechanical 3-year projections: the Base case extends the company\'s trailing growth rate; Bear assumes growth slows to 40% of trend; Bull assumes 160% of trend. These are NOT analyst forecasts — they\'re disciplined brackets around "what if the trend bends."',
    formula: 'Base = trailing 3Y CAGR · Bear = 0.4 × CAGR · Bull = 1.6 × CAGR',
    action: 'Ask yourself: if the BEAR case played out, would I still want to own this at today\'s price? That answer tells you whether the position is sized correctly.'
  },
  peerComparison: {
    title: 'Peer Comparison',
    body: 'Lines up the stock against its closest sector/industry competitors on valuation (P/E, P/S, EV/EBITDA), profitability (margins, ROE), growth (revenue CAGR), and balance-sheet strength — all pulled fresh from SEC EDGAR and FMP. No metric means anything in isolation; a 30× P/E is cheap for a company growing 40%/yr and absurd for one growing 5%/yr.',
    formula: null,
    action: 'Look for the outlier and ask WHY: the cheapest stock in a peer group is either the opportunity or the one the market knows is broken. The financials usually tell you which.'
  },
  ddm: {
    title: 'Dividend Discount Model (DDM)',
    body: 'Values a stock as the sum of all its future dividends, discounted to today. Best suited to mature, stable dividend payers (utilities, staples, banks) — meaningless for non-payers or hypergrowth names.',
    formula: 'Value = D₁ ÷ (r − g)   [Gordon Growth: next dividend ÷ (required return − dividend growth rate)]',
    action: 'The model is hypersensitive to the (r − g) gap. Always test a range: if the stock only looks cheap when g is within 1% of r, the "value" is an artifact.'
  },
  forwardPE: {
    title: 'Forward P/E',
    body: 'Price divided by NEXT year\'s expected earnings (vs. trailing P/E which uses last year\'s actuals). It bakes in growth expectations — but those expectations are analyst estimates that get revised, usually downward, ~60% of the time.',
    formula: 'Forward P/E = Current Price ÷ Consensus Next-Twelve-Months EPS',
    action: 'A stock whose forward P/E is far below its trailing P/E implies big expected earnings growth — verify you believe the estimate before you trust the multiple.'
  },
  optionsChain: {
    title: 'Options Chain & Implied Volatility',
    body: 'Live options market data: what traders are paying for the right to buy (calls) or sell (puts) the stock at various strike prices. The prices imply a forecast of how much the stock will move — implied volatility (IV). Options markets are where sophisticated investors express views, making this a window into "smart money" expectations.',
    formula: 'IV−HV spread = Implied Volatility − 20-day Historical Volatility (positive = options expensive vs. recent reality)',
    action: 'High IV percentile (>70%) = options are expensive — favors selling premium. Low IV (<30%) = cheap insurance — favors buying protection.'
  },
  maxPain: {
    title: 'Max Pain',
    body: 'The strike price where the total value of all expiring options is MINIMIZED — i.e., where option buyers collectively lose the most and option sellers (often dealers) keep the most premium. Prices sometimes gravitate toward this level near expiry due to dealer hedging flows.',
    formula: 'Max Pain = strike K that minimizes Σ call OI × max(0, S−K) + Σ put OI × max(0, K−S)',
    action: 'Treat it as a magnet hypothesis near expiration weeks, not a prediction — the effect is real but weak, and disappears in strong trends.'
  },
  putCallRatio: {
    title: 'Put/Call Ratio',
    body: 'The volume (or open interest) of bearish puts relative to bullish calls. Extremes are CONTRARIAN signals: when everyone owns puts (ratio > ~1.2), fear is peaking and bottoms form; when nobody wants protection (< ~0.6), complacency reigns.',
    formula: 'P/C Ratio = Put Volume ÷ Call Volume',
    action: 'Use extremes only. A P/C ratio in the middle of its range tells you nothing — this is a sentiment thermometer, not a timing system.'
  },
  regimeBacktest: {
    title: 'Regime Backtest — Forward Returns by VIX Level',
    body: 'Splits history by what the VIX (fear index) was at each entry point, then shows what the stock did over the following period. It answers: "When fear was THIS high before, was buying rewarded?" For most quality assets, high-VIX entries have produced above-average forward returns — fear compensates buyers.',
    formula: 'Group entries by VIX bucket (<15, 15-20, 20-30, >30) → compute forward return distribution per bucket',
    action: 'If the stock\'s high-VIX forward returns are POOR, it\'s a fragile asset that gets hurt worse in stress — size it accordingly.'
  },
  levETF: {
    title: 'Leveraged ETF Signals',
    body: 'Leveraged ETFs (TQQQ, UPRO, SOXL…) deliver 2-3× the DAILY index move — not the long-term move. Daily rebalancing means chop erodes them (volatility decay) while smooth trends compound them beautifully. These signals assess whether the current regime favors holding them.',
    formula: 'Decay ≈ −(L² − L) × σ²/2 per period (L = leverage, σ = daily volatility)',
    action: 'Leveraged ETFs are trend vehicles, not buy-and-hold-forever assets. The signal matters most on EXIT: in high-VIX chop, decay accelerates dramatically.'
  },
  // ── Optimization / rebalance (rebuilt 2026-07) ───────────
  optimization: {
    title: 'Portfolio Optimization — Regime & Risk-Profile Conditioned',
    body: 'Solves for the weight mix with the best risk-adjusted return (max Sharpe ratio) using Markowitz mean-variance optimization — then constrains the answer by YOUR risk profile: hard caps on single positions, leveraged ETFs, and sector concentration, plus a defensive-asset floor. It also pulls fresh regime research (live sector momentum + cycle playbook) on every run so recommendations reflect today\'s market, not a stale snapshot.',
    formula: 'max_w (w·μ − r_f) ÷ √(wᵀΣw)  subject to: Σw=1, 0 ≤ wᵢ ≤ profile caps',
    action: 'Run it after any regime change or profile change. The "what to buy" panel shows candidates OUTSIDE your current holdings — the optimizer can only re-weight what you own; the research panel shows what you\'re missing.'
  },
  driftBlotter: {
    title: 'Sector Drift & Rebalance Blotter',
    body: 'Compares your current sector weights to your target model and flags any sector outside the tolerance band (±3% is the institutional convention). The blotter converts gaps into a concrete trade list — dollars to buy/sell per sector — without executing anything. Your risk profile sets the target model; the current macro regime tells you which direction to lean within the band.',
    formula: 'Drift = Current Sector Weight − Target Weight · Trade $ = Drift × Portfolio Value',
    action: 'Rebalancing is a discipline, not a market call: it systematically sells what ran up and buys what lagged. Do it on a schedule (quarterly) or on tolerance breach — not on emotion.'
  },
  rebalanceContext: {
    title: 'Rebalance Context — Regime + Profile',
    body: 'Before acting on any rebalance recommendation, you need three facts: (1) WHAT regime we\'re in (drives which sectors to favor), (2) WHAT risk profile you\'ve set (drives the target mix and caps), and (3) WHAT the live market is doing (momentum confirms or challenges the playbook). This panel pulls all three fresh so every trade recommendation is traceable to its inputs.',
    formula: null,
    action: 'If the regime playbook and live momentum DISAGREE (e.g., playbook says defensives but momentum favors tech), reduce trade size — conflicting signals mean lower conviction, not zero action.'
  },
  baseline: {
    title: 'Market Baseline — Sectors, Asset Classes & Themes',
    body: 'The top-down starting point for stock research: before picking a stock, decide which SECTORS, ASSET CLASSES, and THEMES deserve your money in the current regime. Each row shows fresh momentum data (1M/3M/6M/1Y returns, volatility, 200-day trend) for the group\'s ETF plus a curated set of baseline stocks to use as comparison anchors. Data refreshes from Yahoo Finance on every request.',
    formula: 'Momentum Score = mean(1M, 3M, 6M return) · Trend = price vs. 200-day moving average',
    action: 'Work top-down: pick 2-3 groups aligned with the regime AND showing positive momentum, THEN research individual names within them. A great stock in a collapsing sector still usually loses.'
  },
  sectorMomentum: {
    title: 'Live Sector Momentum',
    body: 'Ranks the 11 sector ETFs plus core asset classes by recent momentum (average of 1, 3, and 6-month returns). Momentum is one of the most robust return factors ever documented (Jegadeesh & Titman 1993) — sectors that led over 3-6 months tend to keep leading over the next 1-3 months.',
    formula: 'Momentum Score = (R_1M + R_3M + R_6M) ÷ 3',
    action: 'The strongest signal is AGREEMENT: when a sector is favored by the regime playbook AND ranks top-3 in live momentum, that\'s where conviction positions belong.'
  }
};

// Global popover element
var _helpPopoverEl = null;

function initHelpPopovers() {
  // Create the popover DOM element if not already present
  if (!document.getElementById('helpPopover')) {
    var el = document.createElement('div');
    el.id = 'helpPopover';
    el.innerHTML = '<button class="hp-close" id="helpPopoverClose" aria-label="Close">×</button><div class="hp-title" id="hpTitle"></div><div class="hp-body" id="hpBody"></div><div class="hp-formula" id="hpFormula" style="display:none;"></div><div class="hp-action" id="hpAction" style="display:none;"></div>';
    document.body.appendChild(el);
  }
  _helpPopoverEl = document.getElementById('helpPopover');

  // Close button
  var closeBtn = document.getElementById('helpPopoverClose');
  if (closeBtn) closeBtn.addEventListener('click', function(e){ e.stopPropagation(); hideHelpPopover(); });

  // Click on ANY help-icon. Priority: (1) curated HELP_CONTENT entry via
  // data-help, (2) fallback — render the icon's title attribute in the same
  // rich popover, using the parent card's title as the heading. This
  // guarantees every "?" on the site opens a readable explanation instead
  // of relying on the browser's tiny hover tooltip.
  document.addEventListener('click', function(e) {
    var icon = e.target.closest('.help-icon');
    if (icon) {
      e.stopPropagation();
      // Tap the same icon again to close (mobile-friendly un-tap)
      if (_helpPopoverEl && _helpPopoverEl.classList.contains('visible') && window._helpAnchorEl === icon) {
        hideHelpPopover(); window._helpAnchorEl = null; return;
      }
      window._helpAnchorEl = icon;
      var key = icon.getAttribute('data-help');
      var data = key ? HELP_CONTENT[key] : null;
      if (!data) {
        var titleText = icon.getAttribute('title') || icon.getAttribute('data-title') || '';
        if (!titleText) { hideHelpPopover(); return; }
        // Derive a heading from the nearest card title / label context
        var heading = icon.getAttribute('data-heading') || 'What is this?';
        var cardTitle = icon.closest('.card-title');
        var label = icon.closest('label');
        var src = icon.getAttribute('data-heading') ? null : (cardTitle || label);
        if (src) {
          var clone = src.cloneNode(true);
          var icons = clone.querySelectorAll('.help-icon, button, select, input, .btn, .btn-sm, .btn-outline');
          for (var ci = 0; ci < icons.length; ci++) icons[ci].remove();
          heading = (clone.textContent || '').replace(/\s+/g, ' ').trim() || heading;
        }
        data = { title: heading, body: titleText, formula: null, action: null };
      }
      showHelpPopover(icon, data);
      return;
    }
    // Click outside closes popover
    if (_helpPopoverEl && !_helpPopoverEl.contains(e.target)) {
      hideHelpPopover();
    }
  });

  // Keyboard close
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') hideHelpPopover();
  });
}

function showHelpPopover(anchor, data) {
  if (!_helpPopoverEl) return;
  document.getElementById('hpTitle').textContent = data.title;
  document.getElementById('hpBody').textContent = data.body;
  var fEl = document.getElementById('hpFormula');
  if (data.formula) { fEl.textContent = data.formula; fEl.style.display = ''; }
  else { fEl.style.display = 'none'; }
  var aEl = document.getElementById('hpAction');
  if (data.action) { aEl.textContent = '💡 ' + data.action; aEl.style.display = ''; }
  else { aEl.style.display = 'none'; }

  _helpPopoverEl.classList.add('visible');

  // Mobile: CSS pins the popover as a bottom sheet — skip JS positioning
  // (and clear any stale inline coords so the CSS wins).
  if (typeof isMobile === 'function' && isMobile()) {
    _helpPopoverEl.style.left = '';
    _helpPopoverEl.style.top = '';
    return;
  }
  // Position near the anchor
  var rect = anchor.getBoundingClientRect();
  var pw = 340, ph = _helpPopoverEl.offsetHeight || 200;
  var left = Math.min(rect.left, window.innerWidth - pw - 12);
  var top = rect.bottom + 8;
  if (top + ph > window.innerHeight - 12) top = rect.top - ph - 8;
  if (top < 8) top = 8;
  _helpPopoverEl.style.left = Math.max(8, left) + 'px';
  _helpPopoverEl.style.top = top + 'px';
}

function hideHelpPopover() {
  if (_helpPopoverEl) _helpPopoverEl.classList.remove('visible');
}

// Boot the popover system once DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initHelpPopovers);
} else {
  initHelpPopovers();
}

// ═══════════════════════════════════════════════════════════════════
// GLOBAL 3-STATE TABLE SORTING — click any column header to sort
// descending; click again for ascending; a third click restores the
// original order. Works on every table site-wide via event delegation.
// Skips: tables with data-nosort, headers with their own onclick,
// grouped tables (rowspan), and clicks on controls inside headers.
// ═══════════════════════════════════════════════════════════════════
(function initGlobalTableSort() {
  function cellSortValue(td) {
    if (!td) return { n: null, s: '' };
    var t = (td.textContent || '').replace(/−/g, '-').trim();
    if (!t || t === '—' || t === '-' || /^n\/a$/i.test(t)) return { n: null, s: '' };
    // Suffixed magnitudes: $3.2T / 45.1B / 320M / 12K
    var m = t.match(/(-?[\d.,]+)\s*([TBMK])\b/);
    if (m) {
      var mult = { T: 1e12, B: 1e9, M: 1e6, K: 1e3 }[m[2]];
      var base = parseFloat(m[1].replace(/,/g, ''));
      if (!isNaN(base)) return { n: base * mult, s: t.toLowerCase() };
    }
    var num = parseFloat(t.replace(/[$,%+]/g, '').replace(/,/g, ''));
    if (!isNaN(num) && /[\d]/.test(t)) return { n: num, s: t.toLowerCase() };
    return { n: null, s: t.toLowerCase() };
  }
  document.addEventListener('click', function(e) {
    if (e.target.closest('.help-icon, button, select, input, a')) return;
    var th = e.target.closest('th');
    if (!th || th.getAttribute('onclick')) return;
    var table = th.closest('table');
    if (!table || table.hasAttribute('data-nosort')) return;
    var tbody = table.tBodies && table.tBodies[0];
    if (!tbody || tbody.rows.length < 3) return;
    if (tbody.querySelector('td[rowspan], th[rowspan]')) return; // grouped layout — row order is structural
    var headRow = th.parentNode;
    var idx = Array.prototype.indexOf.call(headRow.children, th);
    var rows = Array.prototype.slice.call(tbody.rows);
    rows.forEach(function(r, i) { if (!r.dataset.gsOrig) r.dataset.gsOrig = String(i + 1); });
    // Cycle: (none) → desc → asc → original
    var prev = th.dataset.gsState || '';
    var state = prev === 'desc' ? 'asc' : prev === 'asc' ? 'orig' : 'desc';
    Array.prototype.forEach.call(headRow.children, function(x) {
      if (x !== th) { x.dataset.gsState = ''; var ar = x.querySelector('.gsort'); if (ar) ar.textContent = ''; }
    });
    th.dataset.gsState = state === 'orig' ? '' : state;
    var arrow = th.querySelector('.gsort');
    if (!arrow) { arrow = document.createElement('span'); arrow.className = 'gsort'; arrow.style.cssText = 'margin-left:4px;font-size:9px;'; th.appendChild(arrow); }
    arrow.textContent = state === 'desc' ? '▼' : state === 'asc' ? '▲' : '';
    var sorted;
    if (state === 'orig') {
      sorted = rows.slice().sort(function(a, b) { return (+a.dataset.gsOrig) - (+b.dataset.gsOrig); });
    } else {
      var dir = state === 'desc' ? -1 : 1;
      sorted = rows.slice().sort(function(a, b) {
        var va = cellSortValue(a.cells[idx]), vb = cellSortValue(b.cells[idx]);
        // Nulls always sink to the bottom regardless of direction
        if (va.n == null && vb.n == null) return dir * va.s.localeCompare(vb.s);
        if (va.n == null) return 1;
        if (vb.n == null) return -1;
        return dir * (va.n - vb.n);
      });
    }
    sorted.forEach(function(r) { tbody.appendChild(r); });
  });
})();

// ═══════════════════════════════════════════════════════════════════
// UNIFIED MACRO + CROSS-ASSET PAGE (2026-07)
// The Cross-Asset Analysis page is relocated INSIDE the Macro Regime
// page as a "Cross-Asset Analysis" sub-tab. Nothing is deleted — the
// entire #page-markets DOM (with all its own sub-tabs: Top-Line, Movers,
// Business Cycle, Regime, Credit, Yield Curve, Breadth, Momentum, Sector
// Rotation…) moves under the macro tab strip, and every existing loader
// (caShowTab/caAutoLoad, scoped to #page-markets by id) keeps working.
// navigateTo('markets') now routes to the unified page's Cross-Asset tab.
// ═══════════════════════════════════════════════════════════════════
(function mergeCrossAssetIntoMacro() {
  // v2 (2026-07): TRUE integration, not a page-in-a-tab. Cross-Asset content
  // is dissolved into universal tabs on the Macro page:
  //   Macro Regime      = Indicator Dashboard + Quad Map + Leading Indicator
  //                       Composite + Cross-Asset "Market Regime"
  //   Business Cycle    = FRED cycle view + Cross-Asset business-cycle view
  //   Yield Curve       = FRED curve view + Cross-Asset curve view
  //   Economic Cycle Breakdown = its own tab (unchanged)
  //   Breadth / Credit / Cross-Asset Momentum / Sector Rotation = own tabs
  //   More Cross-Asset  = Top-Line dashboard + Analytics & Models workspace
  // All loaders keep working: relocated catab-* panels are pinned visible and
  // macroShowTab triggers the matching caAutoLoad() on tab open.
  function doMerge() {
    try {
      var macroTabs = document.querySelector('#page-macro .pf-tabs');
      var macroWrap = document.querySelector('#page-macro .content-wrap');
      var marketsPage = document.getElementById('page-markets');
      if (!macroTabs || !macroWrap || !marketsPage || document.getElementById('macrotab-camore')) return;

      function sectionHdr(txt, sub) {
        var d = document.createElement('div');
        d.style.cssText = 'background:var(--navy);color:#fff;padding:8px 16px;font-size:12.5px;font-weight:700;letter-spacing:.3px;border-radius:6px 6px 0 0;margin:18px 0 0;';
        d.innerHTML = txt + (sub ? ' <span style="font-weight:400;opacity:.8;font-size:11px;">— ' + sub + '</span>' : '');
        return d;
      }
      function pinCa(name) {
        var el = document.getElementById('catab-' + name);
        if (!el) return null;
        el.classList.add('active');
        el.style.display = 'block';
        return el;
      }
      function moveChildrenInto(fromId, toEl, hdr) {
        var from = document.getElementById(fromId);
        if (!from || !toEl) return;
        if (hdr) toEl.appendChild(hdr);
        while (from.firstChild) toEl.appendChild(from.firstChild);
        from.remove(); // empty shell out of the toggler's way
      }

      // ── 1) MACRO REGIME tab: dashboard + Quad Map + LIC + CA Market Regime ──
      var dash = document.getElementById('macrotab-dashboard');
      if (dash) {
        moveChildrenInto('macrotab-quadmap', dash, sectionHdr('Quad Map', 'growth × inflation placement (FRED data)'));
        moveChildrenInto('macrotab-lic', dash, sectionHdr('Leading Indicator Composite', 'forward-looking signals, 6–12 months ahead'));
        var caRegime = pinCa('regime');
        if (caRegime) { dash.appendChild(sectionHdr('Market Regime', 'the market-price lens — VIX, momentum, trend (Cross-Asset)')); dash.appendChild(caRegime); }
      }
      // ── 2) BUSINESS CYCLE tab: FRED view + CA view ──
      var biz = document.getElementById('macrotab-biz');
      if (biz) {
        var caBiz = pinCa('bizycle');
        if (caBiz) { biz.appendChild(sectionHdr('Business Cycle — Market-Price Lens', 'markets lead the economy 6–12 months; disagreement with the FRED view above is itself a signal')); biz.appendChild(caBiz); }
      }
      // ── 3) YIELD CURVE tab: FRED curve + CA curve ──
      var yc = document.getElementById('macrotab-yieldcurve');
      if (yc) {
        var caYc = pinCa('yieldcurve');
        if (caYc) { yc.appendChild(sectionHdr('Yield Curve — Cross-Asset View', 'spreads, inversions, and rate expectations from market pricing')); yc.appendChild(caYc); }
      }
      // ── 4) Own tabs: Breadth, Credit, Cross-Asset Momentum, Sector Rotation ──
      var NEW_TABS = [
        { macro: 'cabreadth',  ca: 'breadth',  label: 'Breadth' },
        { macro: 'cacredit',   ca: 'credit',   label: 'Credit' },
        { macro: 'camomentum', ca: 'momentum', label: 'Cross-Asset Momentum' },
        { macro: 'casectors',  ca: 'sectors',  label: 'Sector Rotation' },
        { macro: 'camore',     ca: null,       label: '🌍 More Cross-Asset' }
      ];
      NEW_TABS.forEach(function(t) {
        var b = document.createElement('button');
        b.className = 'pf-tab';
        b.setAttribute('data-macrotab', t.macro);
        b.setAttribute('onclick', "macroShowTab('" + t.macro + "')");
        b.textContent = t.label;
        macroTabs.appendChild(b);
        var panel = document.createElement('div');
        panel.className = 'pf-tab-content';
        panel.id = 'macrotab-' + t.macro;
        macroWrap.appendChild(panel);
        if (t.ca) { var caEl = pinCa(t.ca); if (caEl) panel.appendChild(caEl); }
      });
      // ── 5) "More Cross-Asset" holds the remaining markets page (Top-Line,
      //       Analytics & Models, master verdict, snapshot) intact ──
      var morePanel = document.getElementById('macrotab-camore');
      if (morePanel) {
        marketsPage.classList.remove('page', 'active');
        marketsPage.style.display = 'block';
        var mHero = marketsPage.querySelector('.hero');
        if (mHero) mHero.style.padding = '14px 22px';
        // Remove CA strip buttons whose content moved to universal tabs
        ['bizycle','regime','breadth','credit','yieldcurve','momentum','sectors'].forEach(function(n) {
          var btn2 = marketsPage.querySelector('[data-catab="' + n + '"]');
          if (btn2) btn2.remove();
        });
        morePanel.appendChild(marketsPage);
      }
      // ── 6) Tab strip labels: remove Quad Map & LIC buttons (content merged),
      //       relabel Dashboard → Macro Regime ──
      var qmBtn = macroTabs.querySelector('[data-macrotab="quadmap"]'); if (qmBtn) qmBtn.remove();
      var licBtn = macroTabs.querySelector('[data-macrotab="lic"]'); if (licBtn) licBtn.remove();
      var dashBtn = macroTabs.querySelector('[data-macrotab="dashboard"]'); if (dashBtn) dashBtn.textContent = 'Macro Regime';
      var bizBtn = macroTabs.querySelector('[data-macrotab="biz"]'); if (bizBtn) bizBtn.textContent = 'Business Cycle';

      // ── 7) Loader wiring: opening a merged tab fires its cross-asset loader ──
      // cabreadth also fires the sectors + momentum loaders: the Sector
      // Momentum Scorecard on that tab is populated by those engines (2026-07)
      var CA_LOAD_MAP = { dashboard: ['regime'], biz: ['bizycle'], yieldcurve: ['yieldcurve'], cabreadth: ['breadth', 'sectors', 'momentum'], cacredit: ['credit'], camomentum: ['momentum'], casectors: ['sectors'] };
      function waitForMacroData(cb, tries) {
        if (window._lastMacroData) { cb(); return; }
        if ((tries || 0) > 40) return;
        setTimeout(function(){ waitForMacroData(cb, (tries || 0) + 1); }, 500);
      }
      var _origMacroShowTab = window.macroShowTab;
      window.macroShowTab = function(name) {
        _origMacroShowTab(name);
        (CA_LOAD_MAP[name] || []).forEach(function(n) {
          if (typeof caAutoLoad === 'function') setTimeout(function(){ caAutoLoad(n); }, 200);
        });
        if (name === 'dashboard') {
          // Quad Map + LIC now live on this tab — render once FRED data lands
          waitForMacroData(function() {
            try { if (typeof renderQuadMap === 'function') renderQuadMap(); } catch(e) {}
            try { if (typeof licRender === 'function') licRender(window._lastMacroData); } catch(e) {}
          });
        }
        if (name === 'camore') {
          if (typeof caShowTab === 'function' && !window._caMergedShown) { window._caMergedShown = true; caShowTab('topline'); }
          if (!window._snapshotLoaded) {
            window._snapshotLoaded = true;
            setTimeout(function() {
              if (typeof snapshotLoad === 'function') snapshotLoad();
              if (typeof topLineRefreshAll === 'function') setTimeout(topLineRefreshAll, 400);
              if (typeof caAutoLoad === 'function') setTimeout(function(){ caAutoLoad('movers'); }, 2000);
              setTimeout(function() {
                if (!window._mktInitialized && typeof mktInit === 'function') { mktInit(); window._mktInitialized = true; }
                var endEl = document.getElementById('mktEndDate');
                if (endEl && !endEl.value) endEl.value = new Date().toISOString().slice(0, 10);
                if (typeof mktLoadAll === 'function') mktLoadAll().catch(function(){});
              }, 6000);
            }, 100);
          } else if (typeof topLineRefreshAll === 'function' && !window._tlPillars) {
            topLineRefreshAll();
          }
        }
      };

      // ── 8) Route 'markets' navigation into the unified page ──
      var _origNavMerged = window.navigateTo;
      window.navigateTo = function(p) {
        if (p === 'markets') {
          _origNavMerged('macro');
          setTimeout(function(){ window.macroShowTab('camore'); }, 60);
          return;
        }
        _origNavMerged(p);
      };

      // ── 9) Labels ──
      document.querySelectorAll('.nav-child[data-page="macro"]').forEach(function(el){ el.textContent = 'Macro & Cross-Asset Analysis'; });
      document.querySelectorAll('.nav-child[data-page="markets"]').forEach(function(el){ el.innerHTML = 'Cross-Asset Analysis <span style="font-size:9px;opacity:.7;">(merged)</span>'; });
      var macroHeroP = document.querySelector('#page-macro .hero p');
      if (macroHeroP) macroHeroP.textContent = 'One unified workspace: each tab pairs the FRED economic lens with the matching market-price lens. Macro Regime (scorecard + quad map + leading indicators + market regime), Business Cycle, Yield Curve, cycle breakdown, plus breadth, credit, momentum and sector rotation.';
    } catch(e) { console.warn('Cross-asset merge v2 failed:', e); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', doMerge);
  else doMerge();
})();

// ═══════════════════════════════════════════════════════════════════
// B4 — SECTORS & STOCKS TAB
// ═══════════════════════════════════════════════════════════════════

var SPY_SECTORS = [
  { etf:'XLK',  name:'Technology',        color:'#003C71' },
  { etf:'XLC',  name:'Comm. Services',    color:'#0057A8' },
  { etf:'XLY',  name:'Consumer Disc.',    color:'#7B3F00' },
  { etf:'XLP',  name:'Consumer Staples',  color:'#2E7D52' },
  { etf:'XLE',  name:'Energy',            color:'#5C4033' },
  { etf:'XLF',  name:'Financials',        color:'#1A237E' },
  { etf:'XLV',  name:'Health Care',       color:'#00695C' },
  { etf:'XLI',  name:'Industrials',       color:'#37474F' },
  { etf:'XLB',  name:'Materials',         color:'#558B2F' },
  { etf:'XLRE', name:'Real Estate',       color:'#6A1B9A' },
  { etf:'XLU',  name:'Utilities',         color:'#0277BD' }
];

var SPY_SECTOR_STOCKS = {
  'XLK':  { etfs:['QQQ','VGT','SMH','SOXX','IGV'],  stocks:['AAPL','MSFT','NVDA','AVGO','META','GOOGL','ORCL','ADBE','CRM','CSCO','AMD','QCOM','TXN','NOW','INTU'] },
  'XLC':  { etfs:['VOX','FCOM','IYZ','PBS','OGIG'],  stocks:['GOOGL','META','NFLX','TMUS','DIS','CMCSA','VZ','T','EA','TTWO','CHTR','PARA','WBD','ATVI','OMC'] },
  'XLY':  { etfs:['VCR','FDIS','XRT','RTH','FXD'],   stocks:['AMZN','TSLA','HD','MCD','NKE','LOW','SBUX','TJX','BKNG','CMG','ORLY','AZO','GM','F','ROST'] },
  'XLP':  { etfs:['VDC','FSTA','IYK','KXI','RSPS'],  stocks:['WMT','PG','COST','KO','PEP','PM','MO','MDLZ','CL','KHC','STZ','GIS','SYY','K','CHD'] },
  'XLE':  { etfs:['VDE','IYE','XOP','OIH','FCG'],    stocks:['XOM','CVX','COP','EOG','SLB','MPC','VLO','PSX','OXY','BKR','HES','DVN','FANG','HAL','APA'] },
  'XLF':  { etfs:['VFH','KRE','KBE','IAT','KBWB'],   stocks:['BRK-B','JPM','V','MA','BAC','WFC','GS','MS','BLK','AXP','SCHW','C','USB','PNC','COF'] },
  'XLV':  { etfs:['XBI','IBB','IHI','VHT','FBT'],    stocks:['UNH','LLY','JNJ','ABBV','MRK','TMO','ABT','ISRG','DHR','PFE','AMGN','MDT','BMY','GILD','CVS'] },
  'XLI':  { etfs:['VIS','FIDU','IYT','XTN','JETS'],  stocks:['GE','HON','UPS','RTX','CAT','DE','LMT','BA','MMM','NOC','EMR','ITW','ETN','FDX','WM'] },
  'XLB':  { etfs:['VAW','FMAT','IYM','MXI','LIT'],   stocks:['LIN','SHW','APD','ECL','FCX','NEM','NUE','VMC','MLM','PKG','DOW','PPG','CF','MOS','IFF'] },
  'XLRE': { etfs:['VNQ','IYR','SCHH','RWR','REZ'],   stocks:['AMT','PLD','CCI','EQIX','PSA','SPG','WELL','DLR','O','VICI','EXR','AVB','EQR','WY','SBA'] },
  'XLU':  { etfs:['VPU','IDU','FUTY','RYU','FXU'],   stocks:['NEE','DUK','SO','D','AEP','EXC','SRE','XEL','ED','ETR','WEC','ES','AWK','CMS','CNP'] }
};

var NASDAQ_TOP_STOCKS  = ['AAPL','MSFT','NVDA','AMZN','META','GOOGL','TSLA','AVGO','COST','NFLX','ADBE','AMD','QCOM','INTC','CSCO','TMUS','INTU','ISRG','AMAT','TXN','BKNG','SBUX','MDLZ','GILD','REGN','VRTX','KLAC','LRCX','SNPS','CDNS','PANW','CRWD','MRVL','MU','MELI','PYPL','ADP','ARM','DDOG','ZS'];
var CRYPTO_TICKERS     = ['BTC-USD','ETH-USD','BNB-USD','SOL-USD','XRP-USD','ADA-USD','AVAX-USD','DOT-USD','LINK-USD','ATOM-USD','LTC-USD','NEAR-USD','ALGO-USD'];
var COMMODITY_TICKERS  = ['GC=F','SI=F','CL=F','NG=F','HG=F','ZC=F','ZS=F','ZW=F','KC=F','CC=F','LE=F'];
var INDICATOR_TICKERS  = ['^VIX','^TNX','^TYX','^IRX','UUP','TLT','SHY','HYG','LQD','EMB','TIP','GLD','USO','UNG'];
var COMMODITY_NAMES    = {'GC=F':'Gold','SI=F':'Silver','CL=F':'Crude Oil','NG=F':'Natural Gas','HG=F':'Copper','ZC=F':'Corn','ZS=F':'Soybeans','ZW=F':'Wheat','KC=F':'Coffee','CC=F':'Cocoa','LE=F':'Live Cattle'};
var INDICATOR_NAMES    = {'^VIX':'Volatility (VIX)','^TNX':'10Y Treasury Yield','^TYX':'30Y Treasury Yield','^IRX':'3-Month T-Bill','UUP':'US Dollar Index','TLT':'20Y Bond ETF','SHY':'Short-Term Bond','HYG':'High-Yield Corp','LQD':'Investment Grade Corp','EMB':'Emerging Mkt Bond','TIP':'TIPS (Inflation)','GLD':'Gold ETF','USO':'Oil ETF','UNG':'Natural Gas ETF'};

window._sectorsMode     = 'spy';
window._sectorsSel      = 'XLK';
window._sectorsCache    = {};
window._sectorsRendered = false;

function sectorsSetMode(mode) {
  window._sectorsMode = mode;
  var modeMap = {spy:'Spy',nasdaq:'Nasdaq',crypto:'Crypto',commodities:'Commodities',indicators:'Indicators'};
  Object.keys(modeMap).forEach(function(m) {
    var b = document.getElementById('sectorsBtn'+modeMap[m]);
    if (b) b.classList.toggle('active', m === mode);
  });
  // Sector chip buttons removed 2026-07: they re-rendered the panel per click
  // and fought with the flow chart. Sectors are now evaluated side-by-side
  // through their ETFs (XLK, XLY, XLF…) in one sortable table.
  var hmWrap = document.getElementById('sectorsHeatmapWrap');
  if (hmWrap) hmWrap.style.display = 'none';
  renderSectorsContent();
}

async function renderSectorsTab() {
  if (window._sectorsRendered) return;
  window._sectorsRendered = true;
  var hmWrap = document.getElementById('sectorsHeatmapWrap');
  if (hmWrap) hmWrap.style.display = 'none';
  renderSectorsContent();
}

async function renderSectorsHeatmap() {
  var wrap = document.getElementById('sectorsHeatmapWrap');
  if (!wrap) return;
  wrap.innerHTML = SPY_SECTORS.map(function(s) {
    return '<div class="sector-chip" id="schip-'+s.etf+'" onclick="sectorSelect(\''+s.etf+'\')" style="background:'+s.color+'20;border:1px solid '+s.color+'50;border-radius:8px;padding:8px 12px;cursor:pointer;min-width:90px;text-align:center;">'
      + '<div style="font-size:11px;font-weight:700;color:var(--text);">'+s.name+'</div>'
      + '<div id="schipc-'+s.etf+'" style="font-size:12px;color:var(--text-sec);">…</div>'
      + '</div>';
  }).join('');
  sectorSelect(window._sectorsSel || 'XLK');
  await Promise.allSettled(SPY_SECTORS.map(async function(s) {
    try {
      var q = await fetchQuoteWithCache(s.etf);
      var pct = typeof q.changePct==='number' ? q.changePct : (typeof q.changePercent==='number' ? q.changePercent : null);
      var el = document.getElementById('schipc-'+s.etf);
      if (el) { el.style.color = pct===null?'var(--text-sec)':pct>=0?'var(--success)':'var(--danger)'; el.textContent = pct===null?'—':(pct>=0?'+':'')+pct.toFixed(2)+'%'; }
      var chip = document.getElementById('schip-'+s.etf);
      if (chip && pct!==null) { var int = Math.min(Math.abs(pct)/2,1); chip.style.background = pct>=0?'rgba(46,125,82,'+(0.08+int*0.25)+')':'rgba(183,28,28,'+(0.08+int*0.25)+')'; }
    } catch(e) {}
  }));
}

function sectorSelect(etf) {
  window._sectorsSel = etf;
  document.querySelectorAll('.sector-chip').forEach(function(c){ c.style.outline=''; });
  var chip = document.getElementById('schip-'+etf);
  if (chip) chip.style.outline = '2px solid var(--blue)';
  if (window._sectorsMode === 'spy') renderSectorsContent();
}

async function fetchQuoteWithCache(ticker) {
  if (window._sectorsCache[ticker]) return window._sectorsCache[ticker];
  var q = await fetchQuote(ticker);
  window._sectorsCache[ticker] = q;
  return q;
}

async function renderSectorsContent() {
  var outer = document.getElementById('sectorsContentWrap');
  if (!outer) return;
  var mode = window._sectorsMode || 'spy';
  // Money-flow comparison chart sits ABOVE the table for every tab —
  // see all groups move together instead of clicking through one by one.
  outer.innerHTML = '<div id="ssBreadthCards" style="margin-bottom:12px;"></div><div id="ssFlowCard" style="margin-bottom:14px;"></div><div id="ssPanelBody"></div>';
  var wrap = document.getElementById('ssPanelBody');
  var flowCfgs = {
    spy:         { syms: SPY_SECTORS.map(function(s){return s.etf;}), names: SPY_SECTORS.reduce(function(m,s){ m[s.etf]=s.name; return m; },{}), colors: SPY_SECTORS.reduce(function(m,s){ m[s.etf]=s.color; return m; },{}), title: 'Sector Money Flow — all 11 GICS sectors', style: 'bars' },
    nasdaq:      { syms: ['QQQ','AAPL','MSFT','NVDA','AMZN','META','GOOGL','AVGO'], names: {}, title: 'Nasdaq Leaders vs QQQ — where is the money flowing?' },
    crypto:      { syms: CRYPTO_TICKERS.slice(0,6), names: {}, title: 'Major Crypto Assets — relative flows' },
    commodities: { syms: COMMODITY_TICKERS.slice(0,6), names: COMMODITY_NAMES, title: 'Commodity Complex — relative flows' },
    indicators:  { syms: ['^VIX','^TNX','UUP','TLT','HYG','GLD'], names: INDICATOR_NAMES, title: 'Macro Indicators — rates, vol, dollar, credit, gold' }
  };
  window._lastFlowCfg = flowCfgs[mode];
  renderSsFlowChart(window._lastFlowCfg); // async — renders independently of the table
  if (mode==='spy') {
    // One unified table of the 11 sector ETFs — each sector evaluated
    // independently through its ticker (chip buttons removed).
    var secNames = SPY_SECTORS.reduce(function(m,s){ m[s.etf] = s.name; return m; }, {});
    await renderSnapshotPanel(wrap, SPY_SECTORS.map(function(s){ return s.etf; }), 'S&P 500 Sectors — all 11 GICS sector ETFs', function(t){ return secNames[t] || t; });
  }
  else if (mode==='nasdaq')    await renderSnapshotPanel(wrap, NASDAQ_TOP_STOCKS, 'Nasdaq 100 — Top Stocks', null);
  else if (mode==='crypto')    await renderSnapshotPanel(wrap, CRYPTO_TICKERS, 'Crypto — Major Assets', function(t){ return t.replace('-USD',''); });
  else if (mode==='commodities') await renderSnapshotPanel(wrap, COMMODITY_TICKERS, 'Commodities — Front-Month Futures', function(t){ return COMMODITY_NAMES[t]||t; });
  else if (mode==='indicators')  await renderSnapshotPanel(wrap, INDICATOR_TICKERS, 'Macro Indicators — Rates, Credit, Vol & Dollar', function(t){ return INDICATOR_NAMES[t]||t; });
}

// ── Money-flow chart: every symbol in the group rebased to 0% over the
//    selected window, drawn on one axis. Data flows through PerryData
//    (Firestore-cached full history) so switching ranges is instant. ──
window._flowRange = window._flowRange || '3mo';
var _ssFlowChart = null;
function ssFlowSetRange(r) { window._flowRange = r; renderSsFlowChart(window._lastFlowCfg); }
async function renderSsFlowChart(cfg) {
  var card = document.getElementById('ssFlowCard');
  if (!card || !cfg) return;
  // 11 overlapping lines were unreadable for the S&P sectors — that tab uses
  // sorted return BARS instead (defined in app3.js); line style stays for
  // smaller groups like Nasdaq/crypto where it reads well.
  if (cfg.style === 'bars' && typeof renderSsFlowBars === 'function') { renderSsFlowBars(cfg); return; }
  var ranges = [['1mo','1M'],['3mo','3M'],['6mo','6M'],['1y','1Y']];
  var btns = ranges.map(function(r){
    var active = window._flowRange === r[0];
    return '<button class="btn-outline btn-sm'+(active?' active':'')+'" style="'+(active?'background:rgba(255,255,255,0.18);':'background:transparent;')+'color:#fff;border-color:rgba(255,255,255,0.4);" onclick="ssFlowSetRange(\''+r[0]+'\')">'+r[1]+'</button>';
  }).join('');
  card.innerHTML = '<div class="card" style="margin:0;">'
    + '<div class="card-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">'
    + '<span>'+cfg.title+' <span class="help-icon" title="Every line is rebased to 0% at the window start, so the vertical spread IS the money flow: lines climbing the panel are attracting capital, lines sinking are losing it. Use the range buttons to see whether leadership is new (1M) or established (1Y)." data-heading="Money Flow" style="font-size:11px;">ⓘ</span></span>'
    + '<span style="display:flex;gap:6px;">'+btns+'</span></div>'
    + '<div class="card-body"><div id="ssFlowNote" style="font-size:11.5px;color:var(--text-sec);margin-bottom:8px;"><span class="spinner"></span> Loading comparison…</div>'
    + '<div class="chart-wrap" style="height:320px;"><canvas id="ssFlowChart"></canvas></div></div></div>';
  try {
    var days = { '1mo':22, '3mo':64, '6mo':127, '1y':253 }[window._flowRange] || 64;
    var HIST = await PerryData.getMany(cfg.syms, 4);
    // Master date axis: longest available series' last N dates
    var master = null;
    cfg.syms.forEach(function(s){ var h = HIST[s.toUpperCase()]; if (h && (!master || h.dates.length > master.dates.length)) master = h; });
    if (!master) { document.getElementById('ssFlowNote').innerHTML = '<span style="color:var(--danger);">No history available.</span>'; return; }
    var labels = master.dates.slice(-days);
    var finals = [];
    var datasets = [];
    cfg.syms.forEach(function(s, i) {
      var h = HIST[s.toUpperCase()];
      if (!h) return;
      var map = {}; h.dates.forEach(function(d, j){ map[d] = h.closes[j]; });
      var lastPx = null;
      var aligned = labels.map(function(d){ if (map[d] != null) lastPx = map[d]; return lastPx; });
      var fIdx = -1; for (var k = 0; k < aligned.length; k++) { if (aligned[k] != null) { fIdx = k; break; } }
      if (fIdx < 0) return;
      var base = aligned[fIdx];
      var pct = aligned.map(function(v){ return v != null ? +(((v/base)-1)*100).toFixed(2) : null; });
      var label = (cfg.names && cfg.names[s]) ? cfg.names[s] : s;
      var color = (cfg.colors && cfg.colors[s]) ? cfg.colors[s] : PALETTE[i % PALETTE.length];
      finals.push({ label: label, v: pct[pct.length-1] });
      datasets.push({ label: label, data: pct, borderColor: color, borderWidth: 1.6, pointRadius: 0, tension: 0.2, fill: false, spanGaps: true });
    });
    if (_ssFlowChart) { try { _ssFlowChart.destroy(); } catch(e){} }
    var ctxEl = document.getElementById('ssFlowChart');
    if (!ctxEl) return;
    var MO3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    _ssFlowChart = new Chart(ctxEl.getContext('2d'), {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: isMobile()?'bottom':'top', labels: { font: { size: 10 }, boxWidth: 10 } },
          tooltip: Object.assign({}, chartTooltip, { callbacks: { label: function(c){ return c.dataset.label+': '+(c.parsed.y>=0?'+':'')+(c.parsed.y||0).toFixed(1)+'%'; } } }) },
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, font: { size: 10 }, callback: function(v){ var d = this.getLabelForValue(v)||''; return d.length>=7 ? MO3[parseInt(d.slice(5,7),10)-1]+" '"+d.slice(2,4) : d; } } },
                  y: { grid: chartGrid, ticks: { font: { size: 10 }, callback: function(v){ return (v>=0?'+':'')+v+'%'; } } } } }
    });
    finals.sort(function(a,b){ return (b.v||-999)-(a.v||-999); });
    var top = finals.slice(0,3).map(function(f){ return '<strong style="color:var(--success);">'+f.label+' '+(f.v>=0?'+':'')+(f.v||0).toFixed(1)+'%</strong>'; }).join(' · ');
    var bot = finals.slice(-2).map(function(f){ return '<strong style="color:var(--danger);">'+f.label+' '+(f.v>=0?'+':'')+(f.v||0).toFixed(1)+'%</strong>'; }).join(' · ');
    document.getElementById('ssFlowNote').innerHTML = 'Money is flowing INTO: '+top+' &nbsp;·&nbsp; OUT OF: '+bot+' <span style="color:var(--text-sec);">('+({'1mo':'1-month','3mo':'3-month','6mo':'6-month','1y':'1-year'}[window._flowRange])+' window)</span>';
  } catch(e) {
    var note = document.getElementById('ssFlowNote');
    if (note) note.innerHTML = '<span style="color:var(--danger);">Flow chart failed: '+e.message+'</span>';
  }
}

// ── Unified snapshot data + rendering (all 5 tabs share this look) ──
window._snapshotCache = {};
async function fetchSnapshotRows(tickers) {
  var key = tickers.join(',');
  var hit = window._snapshotCache[key];
  if (hit && (Date.now() - hit.ts) < 10*60*1000) return hit.map;
  var r = await fetch(WORKER_URL + '/snapshot?symbols=' + encodeURIComponent(key));
  var d = await r.json();
  if (d.error) throw new Error(d.error);
  var map = {};
  (d.quotes || []).forEach(function(q){ map[q.ticker] = q; });
  window._snapshotCache[key] = { ts: Date.now(), map: map };
  return map;
}

function _ssPct(v, digits) {
  if (v == null) return '<span style="color:var(--text-sec);">—</span>';
  var c = v >= 0 ? 'var(--success)' : 'var(--danger)';
  return '<span style="color:'+c+';font-weight:600;font-family:monospace;">'+(v>=0?'+':'')+v.toFixed(digits==null?1:digits)+'%</span>';
}
function _ssMc(mc) {
  if (!mc) return '<span style="color:var(--text-sec);">—</span>';
  return mc>=1e12 ? '$'+(mc/1e12).toFixed(2)+'T' : mc>=1e9 ? '$'+(mc/1e9).toFixed(1)+'B' : '$'+(mc/1e6).toFixed(0)+'M';
}
function _heldTickerSet() {
  var set = {};
  (window._holdings||[]).forEach(function(h){ if (h.ticker) set[String(h.ticker).toUpperCase()] = 1; });
  return set;
}

// Story strip: leaders, laggards, what's hot this week, trend breadth, portfolio overlap
function snapshotStoryStrip(rows, groupLabel) {
  var withM = rows.filter(function(r){ return r.chg1m != null; });
  if (!withM.length) return '';
  var byM = withM.slice().sort(function(a,b){ return b.chg1m - a.chg1m; });
  var byW = withM.filter(function(r){ return r.chg1w != null; }).sort(function(a,b){ return Math.abs(b.chg1w) - Math.abs(a.chg1w); });
  var leaders = byM.slice(0,3), laggards = byM.slice(-3).reverse();
  var hot = byW.slice(0,3);
  var trendable = rows.filter(function(r){ return r.above200dma != null; });
  var up = trendable.filter(function(r){ return r.above200dma; }).length;
  var held = _heldTickerSet();
  var heldRows = rows.filter(function(r){ return held[r.ticker]; });
  function chips(arr, useW) {
    return arr.map(function(r){
      var v = useW ? r.chg1w : r.chg1m;
      var c = v >= 0 ? 'var(--success)' : 'var(--danger)';
      return '<span style="display:inline-block;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:2px 9px;margin:1px 2px;font-size:11px;cursor:pointer;" onclick="resNavToTicker(\''+r.ticker+'\')"><strong style="color:var(--navy);">'+r.ticker+'</strong> <span style="color:'+c+';font-weight:600;">'+(v>=0?'+':'')+v.toFixed(1)+'%</span></span>';
    }).join('');
  }
  var breadthPct = trendable.length ? Math.round(up/trendable.length*100) : null;
  var breadthColor = breadthPct == null ? 'var(--text-sec)' : breadthPct >= 60 ? 'var(--success)' : breadthPct <= 40 ? 'var(--danger)' : '#8B6914';
  return '<div style="background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:10px 14px;margin-bottom:12px;font-size:12px;">'
    + '<div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start;">'
    + '<div><div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;color:var(--success);margin-bottom:2px;">Leading (1M)</div>'+chips(leaders)+'</div>'
    + '<div><div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;color:var(--danger);margin-bottom:2px;">Lagging (1M)</div>'+chips(laggards)+'</div>'
    + '<div><div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;color:#8B6914;margin-bottom:2px;">Biggest 1W Moves</div>'+chips(hot, true)+'</div>'
    + '<div style="min-width:130px;"><div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;color:var(--navy);margin-bottom:2px;">Trend Breadth</div>'
    +   '<span style="font-size:16px;font-weight:800;color:'+breadthColor+';">'+(breadthPct==null?'—':breadthPct+'%')+'</span> <span style="color:var(--text-sec);font-size:11px;">above 200-day avg</span></div>'
    + (heldRows.length ? '<div><div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;color:var(--blue);margin-bottom:2px;">In Your Portfolio ('+heldRows.length+')</div>'+chips(heldRows.slice(0,5))+'</div>' : '')
    + '</div></div>';
}

function buildSnapshotTable(rows, title, labelFn, showMc) {
  var held = _heldTickerSet();
  var h = '<div class="card" style="margin:0 0 14px;"><div class="card-header"><span class="card-title">'+title+'</span></div>'
    + '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch;"><table style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:640px;">'
    + '<thead><tr style="border-bottom:2px solid var(--border);background:var(--panel);">'
    + '<th style="text-align:left;padding:7px 8px;color:var(--text-sec);font-weight:600;">Ticker</th>'
    + '<th style="text-align:left;padding:7px 8px;color:var(--text-sec);font-weight:600;">Name</th>'
    + '<th style="text-align:right;padding:7px 8px;color:var(--text-sec);font-weight:600;">Price</th>'
    + '<th style="text-align:right;padding:7px 8px;color:var(--text-sec);font-weight:600;">1D%</th>'
    + '<th style="text-align:right;padding:7px 8px;color:var(--text-sec);font-weight:600;">1W%</th>'
    + '<th style="text-align:right;padding:7px 8px;color:var(--text-sec);font-weight:600;">1M%</th>'
    + '<th style="text-align:right;padding:7px 8px;color:var(--text-sec);font-weight:600;">52W%</th>'
    + '<th style="text-align:center;padding:7px 8px;color:var(--text-sec);font-weight:600;" title="Price vs. 200-day moving average">Trend</th>'
    + (showMc ? '<th style="text-align:right;padding:7px 8px;color:var(--text-sec);font-weight:600;">Mkt Cap</th>' : '')
    + '</tr></thead><tbody>';
  rows.forEach(function(r) {
    var label = labelFn ? labelFn(r.ticker) : (r.name || '');
    var nm = labelFn ? (r.name || '') : label;
    var display = labelFn ? label : r.ticker;
    var nameCell = labelFn ? label : ((r.name||'').length > 24 ? (r.name||'').slice(0,22)+'…' : (r.name||''));
    var priceStr = r.price == null ? '—' : (r.price < 1 ? '$'+r.price.toFixed(4) : '$'+r.price.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}));
    var trend = r.above200dma == null ? '<span style="color:var(--text-sec);">—</span>' : (r.above200dma ? '<span style="color:var(--success);font-weight:700;">▲</span>' : '<span style="color:var(--danger);font-weight:700;">▼</span>');
    var heldBadge = held[r.ticker] ? ' <span style="font-size:8.5px;background:rgba(91,155,213,0.18);color:var(--navy);padding:1px 5px;border-radius:3px;font-weight:700;vertical-align:middle;">HELD</span>' : '';
    h += '<tr style="border-bottom:1px solid var(--border);cursor:pointer;" onclick="resNavToTicker(\''+r.ticker+'\');">'
      + '<td style="padding:7px 8px;font-weight:700;color:var(--blue);white-space:nowrap;">'+r.ticker+heldBadge+'</td>'
      + '<td style="padding:7px 8px;color:var(--text-sec);font-size:11px;max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="'+(nm||'')+'">'+(nameCell||'—')+'</td>'
      + '<td style="padding:7px 8px;text-align:right;font-family:monospace;">'+priceStr+'</td>'
      + '<td style="padding:7px 8px;text-align:right;">'+_ssPct(r.chg1d, 2)+'</td>'
      + '<td style="padding:7px 8px;text-align:right;">'+_ssPct(r.chg1w)+'</td>'
      + '<td style="padding:7px 8px;text-align:right;">'+_ssPct(r.chg1m)+'</td>'
      + '<td style="padding:7px 8px;text-align:right;">'+_ssPct(r.chg1y)+'</td>'
      + '<td style="padding:7px 8px;text-align:center;">'+trend+'</td>'
      + (showMc ? '<td style="padding:7px 8px;text-align:right;color:var(--text-sec);">'+_ssMc(r.marketCap)+'</td>' : '')
      + '</tr>';
  });
  h += '</tbody></table></div></div>';
  return h;
}

async function renderSnapshotPanel(wrap, tickers, title, labelFn) {
  wrap.innerHTML = '<div style="text-align:center;padding:40px 0;color:var(--text-sec);"><div class="spinner" style="margin:0 auto 10px;"></div>Loading '+title+'…</div>';
  try {
    var map = await fetchSnapshotRows(tickers);
    var rows = tickers.map(function(t){ return map[t] || { ticker: t, price: null }; });
    // Sort by market cap when available, else by 1M momentum
    var haveMc = rows.some(function(r){ return r.marketCap; });
    rows.sort(function(a,b){ return haveMc ? (b.marketCap||0)-(a.marketCap||0) : (b.chg1m||-999)-(a.chg1m||-999); });
    if (typeof renderSsBreadthCards === 'function') renderSsBreadthCards(rows, title);
    wrap.innerHTML = snapshotStoryStrip(rows, title) + buildSnapshotTable(rows, title, labelFn, haveMc);
  } catch(e) {
    wrap.innerHTML = '<div style="padding:24px;text-align:center;color:var(--danger);">Failed to load: '+e.message+' <button class="btn btn-sm" onclick="renderSectorsContent()">Retry</button></div>';
  }
}

async function renderSectorStocksPanel(wrap) {
  var etf    = window._sectorsSel || 'XLK';
  var sector = SPY_SECTORS.find(function(s){ return s.etf===etf; }) || SPY_SECTORS[0];
  var data   = SPY_SECTOR_STOCKS[etf] || SPY_SECTOR_STOCKS['XLK'];
  var tickers = [etf].concat(data.stocks).concat(data.etfs);
  wrap.innerHTML = '<div style="text-align:center;padding:40px 0;color:var(--text-sec);"><div class="spinner" style="margin:0 auto 10px;"></div>Loading '+(sector?sector.name:etf)+'…</div>';
  try {
    var map = await fetchSnapshotRows(tickers);
    var stockRows = data.stocks.map(function(t){ return map[t] || { ticker:t, price:null }; })
      .sort(function(a,b){ return (b.marketCap||0)-(a.marketCap||0); });
    var etfRows = data.etfs.map(function(t){ return map[t] || { ticker:t, price:null }; });
    var secRow = map[etf];
    // Sector context banner: the sector ETF's own momentum anchors the story
    var banner = '';
    if (secRow) {
      banner = '<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;background:'+(sector?sector.color:'#003C71')+'10;border:1px solid '+(sector?sector.color:'#003C71')+'40;border-radius:6px;padding:10px 14px;margin-bottom:12px;">'
        + '<div><span style="font-size:15px;font-weight:800;color:var(--navy);">'+(sector?sector.name:etf)+' ('+etf+')</span>'
        + (secRow.price!=null?' <span style="font-family:monospace;font-size:13px;">$'+secRow.price.toFixed(2)+'</span>':'')+'</div>'
        + '<div style="font-size:12px;">1W '+_ssPct(secRow.chg1w)+' &middot; 1M '+_ssPct(secRow.chg1m)+' &middot; 52W '+_ssPct(secRow.chg1y)
        + ' &middot; Trend '+(secRow.above200dma==null?'—':(secRow.above200dma?'<span style="color:var(--success);font-weight:700;">▲ above 200d</span>':'<span style="color:var(--danger);font-weight:700;">▼ below 200d</span>'))+'</div>'
        + '</div>';
    }
    wrap.innerHTML = banner
      + snapshotStoryStrip(stockRows, sector?sector.name:etf)
      + '<div style="display:grid;grid-template-columns:1.4fr 1fr;gap:16px;" class="ss-two-col">'
      + '<div>'+buildSnapshotTable(stockRows,(sector?sector.name:etf)+' — Top Stocks', null, true)+'</div>'
      + '<div>'+buildSnapshotTable(etfRows,  (sector?sector.name:etf)+' — Related ETFs', null, false)+'</div>'
      + '</div>';
  } catch(e) {
    wrap.innerHTML = '<div style="padding:24px;text-align:center;color:var(--danger);">Failed to load: '+e.message+' <button class="btn btn-sm" onclick="renderSectorsContent()">Retry</button></div>';
  }
}

function resNavToTicker(ticker) {
  try {
    navigateTo('research');
    setTimeout(function(){
      var inp=document.getElementById('resSearchInput');
      if(inp) inp.value=ticker;
      if(typeof resRun==='function') resRun(ticker);
      else if(typeof resSearch==='function') resSearch(ticker);
    }, 200);
  } catch(e) {}
}

async function renderTickerListPanel(wrap, tickers, title) {
  wrap.innerHTML='<div style="text-align:center;padding:40px 0;color:var(--text-sec);"><div class="spinner" style="margin:0 auto 10px;"></div>Loading '+title+'…</div>';
  var results={};
  await Promise.allSettled(tickers.map(async function(t){ try { results[t]=await fetchQuoteWithCache(t); } catch(e){ results[t]=null; } }));
  var rows=tickers.map(function(t){ var q=results[t]; var rawP=q?(q.current||q.price||null):null; return { t:t, price:typeof rawP==='number'&&rawP>0?rawP:null, pct:q&&typeof q.changePct==='number'?q.changePct:(q&&typeof q.changePercent==='number'?q.changePercent:null), name:q?(q.shortName||q.name||''):'', mc:q&&q.marketCap?q.marketCap:null }; }).sort(function(a,b){ return (b.mc||0)-(a.mc||0); });
  var h='<div class="card"><div class="card-header"><span class="card-title">'+title+'</span></div><div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr style="border-bottom:1px solid var(--border);"><th style="text-align:left;padding:6px 8px;color:var(--text-sec);font-weight:600;">Ticker</th><th style="text-align:left;padding:6px 8px;color:var(--text-sec);font-weight:600;">Name</th><th style="text-align:right;padding:6px 8px;color:var(--text-sec);font-weight:600;">Price</th><th style="text-align:right;padding:6px 8px;color:var(--text-sec);font-weight:600;">1D%</th><th style="text-align:right;padding:6px 8px;color:var(--text-sec);font-weight:600;">Mkt Cap</th></tr></thead><tbody>';
  rows.forEach(function(r){
    var pctStr=r.pct===null?'—':(r.pct>=0?'+':'')+r.pct.toFixed(2)+'%', pctColor=r.pct===null?'var(--text-sec)':r.pct>=0?'var(--success)':'var(--danger)';
    var priceStr=r.price===null?'—':'$'+r.price.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
    var mcStr=r.mc?(r.mc>=1e12?'$'+(r.mc/1e12).toFixed(2)+'T':r.mc>=1e9?'$'+(r.mc/1e9).toFixed(1)+'B':'$'+(r.mc/1e6).toFixed(0)+'M'):'—';
    var nm=(r.name||''); var ns=nm.length>30?nm.slice(0,28)+'…':nm;
    h+='<tr style="border-bottom:1px solid var(--border);cursor:pointer;" onclick="resNavToTicker(\''+r.t+'\');">'
      +'<td style="padding:7px 8px;font-weight:700;color:var(--blue);">'+r.t+'</td>'
      +'<td style="padding:7px 8px;color:var(--text-sec);font-size:11px;">'+ns+'</td>'
      +'<td style="padding:7px 8px;text-align:right;font-family:monospace;">'+priceStr+'</td>'
      +'<td style="padding:7px 8px;text-align:right;font-weight:600;color:'+pctColor+';">'+pctStr+'</td>'
      +'<td style="padding:7px 8px;text-align:right;color:var(--text-sec);">'+mcStr+'</td></tr>';
  });
  h+='</tbody></table></div></div>'; wrap.innerHTML=h;
}

async function renderTickerGridPanel(wrap, tickers, labelFn) {
  wrap.innerHTML='<div style="text-align:center;padding:40px 0;color:var(--text-sec);"><div class="spinner" style="margin:0 auto 10px;"></div>Loading…</div>';
  var results={};
  await Promise.allSettled(tickers.map(async function(t){ try { results[t]=await fetchQuoteWithCache(t); } catch(e){ results[t]=null; } }));
  var h='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;">';
  tickers.forEach(function(t){
    var q=results[t]; var rawP2=q?(q.current||q.price||null):null; var price=typeof rawP2==='number'&&rawP2>0?rawP2:null; var pct=q&&typeof q.changePct==='number'?q.changePct:(q&&typeof q.changePercent==='number'?q.changePercent:null); var change=q&&typeof q.change==='number'?q.change:null;
    var label=labelFn?labelFn(t):t;
    var pctStr=pct===null?'—':(pct>=0?'+':'')+pct.toFixed(2)+'%', pctColor=pct===null?'var(--text-sec)':pct>=0?'var(--success)':'var(--danger)';
    var chgStr=change===null?'':(change>=0?'+':'')+change.toFixed(2);
    var priceStr=price===null?'—':(price<1?price.toFixed(4):price.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}));
    var bg=pct===null?'':(pct>=0?'rgba(46,125,82,0.06)':'rgba(183,28,28,0.06)');
    h+='<div class="card" style="margin:0;padding:14px 16px;background:'+bg+';cursor:pointer;" onclick="resNavToTicker(\''+t+'\');">'
      +'<div style="font-size:13px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="'+label+'">'+label+'</div>'
      +'<div style="font-size:11px;color:var(--text-sec);margin-bottom:8px;">'+t+'</div>'
      +'<div style="font-size:22px;font-weight:700;font-family:monospace;color:var(--text);">'+priceStr+'</div>'
      +'<div style="font-size:13px;font-weight:600;color:'+pctColor+';margin-top:2px;">'+pctStr+'<span style="font-weight:400;font-size:11px;margin-left:4px;">'+chgStr+'</span></div>'
      +'</div>';
  });
  h+='</div>'; wrap.innerHTML=h;
}

// Wire pfShowTab for sectors tab — wrap once after all patches are done
(function() {
  var _origPfShowTab_sectors = window.pfShowTab;
  window.pfShowTab = function(name) {
    if (typeof _origPfShowTab_sectors === 'function') _origPfShowTab_sectors(name);
    if (name === 'sectors') setTimeout(function(){ if (typeof renderSectorsTab==='function') renderSectorsTab(); }, 50);
  };
})();

// ═══════════════════════════════════════════════════════════
// ════  PERFORMANCE TAB ADDITIONS  ══════════════════════════
// ═══════════════════════════════════════════════════════════

// ── Underwater / Drawdown Chart (Portfolio Performance tab) ──
function renderPerfUnderwaterChart(values, dates, spyData) {
  var ctx = document.getElementById('perfUnderwaterChart');
  if (!ctx || !values || values.length < 2) return;
  if (window._perfUnderwaterChart) { try { window._perfUnderwaterChart.destroy(); } catch(e){} }

  // Compute drawdown series
  function toDD(arr) {
    var peak = -Infinity, dd = [];
    arr.forEach(function(v) { peak = Math.max(peak, v); dd.push(v > 0 ? (v - peak) / peak * 100 : 0); });
    return dd;
  }
  var pfDD = toDD(values);
  var datasets = [
    { label: 'Portfolio Drawdown', data: pfDD,
      borderColor: 'rgba(139,42,42,0.9)', borderWidth: 1.5, pointRadius: 0,
      fill: true, backgroundColor: 'rgba(139,42,42,0.12)', tension: 0.2 }
  ];
  if (spyData && spyData.length > 1) {
    var spyVals = spyData.map(function(p){ return p.val; });
    var spyDD = toDD(spyVals);
    // Align spy dates to portfolio dates count
    var aligned = [];
    for (var i = 0; i < pfDD.length; i++) { aligned.push(spyDD[Math.round(i * (spyDD.length-1) / Math.max(pfDD.length-1,1))]||0); }
    datasets.push({ label: 'SPY Drawdown', data: aligned,
      borderColor: 'rgba(91,155,213,0.8)', borderWidth: 1, borderDash: [4,3], pointRadius: 0,
      fill: false, tension: 0.2 });
  }
  window._perfUnderwaterChart = new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: { labels: dates, datasets: datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { position: 'top', labels: { font: { size: 11 } } },
        tooltip: { callbacks: { label: function(c){ return c.dataset.label+': '+(c.parsed.y||0).toFixed(1)+'%'; } } }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 10, font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { callback: function(v){ return v.toFixed(0)+'%'; }, font: { size: 10 } },
             suggestedMax: 0, suggestedMin: null }
      }
    }
  });

  // Top-5 drawdown table
  var ddEl = document.getElementById('perfDrawdownTable');
  if (ddEl) {
    var drawdowns = [], inDD = false, start = 0, peak2 = 0;
    for (var i2 = 0; i2 < values.length; i2++) {
      if (values[i2] >= peak2) {
        if (inDD) { drawdowns.push({ start: dates[start], trough: dates[i2-1], depth: (peak2 - Math.min.apply(null,values.slice(start,i2)))/peak2*100, len: i2-start }); }
        peak2 = values[i2]; inDD = false;
      } else { if (!inDD) { start = i2-1; inDD = true; } }
    }
    drawdowns.sort(function(a,b){ return b.depth-a.depth; });
    var top5 = drawdowns.slice(0,5);
    if (top5.length) {
      var html = '<table style="width:100%;border-collapse:collapse;font-size:11px;"><thead><tr style="background:var(--panel);"><th style="padding:4px 8px;text-align:left;">Start</th><th style="padding:4px 8px;text-align:left;">Trough</th><th style="padding:4px 8px;text-align:right;color:var(--danger);">Depth</th><th style="padding:4px 8px;text-align:right;">Duration</th></tr></thead><tbody>';
      top5.forEach(function(d,i){
        html += '<tr style="border-bottom:1px solid var(--border);"><td style="padding:4px 8px;">'+(i+1)+'. '+d.start+'</td><td style="padding:4px 8px;">'+d.trough+'</td><td style="padding:4px 8px;text-align:right;color:var(--danger);font-weight:700;">−'+d.depth.toFixed(1)+'%</td><td style="padding:4px 8px;text-align:right;">'+d.len+' days</td></tr>';
      });
      html += '</tbody></table>';
      ddEl.innerHTML = '<p style="font-size:11px;font-weight:600;color:var(--navy);margin-bottom:6px;">Top Drawdown Periods</p>' + html;
    }
  }
}

// ── Monthly Returns Heatmap ──
function renderPerfMonthlyHeatmap(values, dates) {
  var el = document.getElementById('perfMonthlyHeatmap');
  if (!el || !values || values.length < 2) return;
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var monthMap = {}; // { '2023': { 0: [v1,v2...], 1: [...] } }
  for (var i = 1; i < values.length; i++) {
    if (!values[i-1] || !values[i]) continue;
    var d = new Date(dates[i]+'T00:00:00');
    var yr = d.getFullYear(), mo = d.getMonth();
    if (!monthMap[yr]) monthMap[yr] = {};
    if (!monthMap[yr][mo]) monthMap[yr][mo] = [];
    monthMap[yr][mo].push({ from: values[i-1], to: values[i] });
  }
  var years = Object.keys(monthMap).sort();
  if (!years.length) { el.innerHTML = '<p style="color:var(--text-sec);font-size:12px;">Not enough data.</p>'; return; }

  // For each month, compute compound return
  function moRet(pts) {
    if (!pts || !pts.length) return null;
    var cum = 1;
    pts.forEach(function(p){ cum *= p.to/p.from; });
    return (cum - 1) * 100;
  }
  function cellColor(r) {
    if (r === null) return '#F4F6F9';
    if (r >= 5)  return '#1B6B3A';
    if (r >= 3)  return '#2E7D52';
    if (r >= 1)  return '#4CAF78';
    if (r >= 0)  return '#A8D5B5';
    if (r >= -1) return '#F4B8B8';
    if (r >= -3) return '#D45D5D';
    if (r >= -5) return '#B73030';
    return '#8B1515';
  }
  function textColor(r) { return (r !== null && Math.abs(r) >= 2) ? '#fff' : 'var(--text)'; }

  var html = '<table style="border-collapse:collapse;width:100%;font-size:11px;">';
  html += '<thead><tr><th style="padding:3px 6px;text-align:left;color:var(--text-sec);font-weight:600;">Year</th>';
  MONTHS.forEach(function(m){ html += '<th style="padding:3px 6px;text-align:center;color:var(--text-sec);font-weight:600;">'+m+'</th>'; });
  html += '<th style="padding:3px 6px;text-align:right;color:var(--text-sec);font-weight:600;">Full Year</th></tr></thead><tbody>';
  years.forEach(function(yr) {
    var yrTotal = 1;
    html += '<tr><td style="padding:4px 6px;font-weight:700;color:var(--navy);">'+yr+'</td>';
    for (var m = 0; m < 12; m++) {
      var r = moRet(monthMap[yr][m]);
      if (r !== null) yrTotal *= (1 + r/100);
      var bg = cellColor(r), tc = textColor(r);
      html += '<td style="padding:3px 4px;text-align:center;background:'+bg+';color:'+tc+';border-radius:2px;font-family:monospace;">'
        + (r !== null ? (r >= 0 ? '+' : '') + r.toFixed(1)+'%' : '—') + '</td>';
    }
    var yrRet = (yrTotal - 1) * 100;
    html += '<td style="padding:4px 6px;text-align:right;font-weight:700;font-family:monospace;color:'+(yrRet>=0?'var(--success)':'var(--danger)')+';">'+(yrRet>=0?'+':'')+yrRet.toFixed(1)+'%</td>';
    html += '</tr>';
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

// ── Patch renderPerformanceTab to call new charts and add Calmar/Time-Underwater ──
var _origRenderPerfTab = window.renderPerformanceTab;
window.renderPerformanceTab = async function() {
  if (typeof _origRenderPerfTab === 'function') await _origRenderPerfTab.call(this);

  // Retrieve values/dates/spyData that were computed inside the original function
  // Re-run the data preparation (fast, cached) to get these values
  try {
    var holdings = window._holdings || [];
    if (!holdings.length) return;
    var rangeBtn = document.querySelector('#perfTimeframeBtns .btn-outline.active');
    var range = rangeBtn ? rangeBtn.getAttribute('data-perf-range') : '1y';
    var pfSeries = await pfBuildValueSeries(range, window._perfAccount);
    if (!pfSeries || !pfSeries.dates || pfSeries.dates.length < 5) return;
    var now = new Date();
    var cutoff = new Date(now);
    if (range==='1mo') cutoff.setMonth(cutoff.getMonth()-1);
    else if (range==='3mo') cutoff.setMonth(cutoff.getMonth()-3);
    else if (range==='6mo') cutoff.setMonth(cutoff.getMonth()-6);
    else if (range==='ytd') cutoff=new Date(now.getFullYear(),0,1);
    else if (range==='1y') cutoff.setFullYear(cutoff.getFullYear()-1);
    else if (range==='3y') cutoff.setFullYear(cutoff.getFullYear()-3);
    else if (range==='5y') cutoff.setFullYear(cutoff.getFullYear()-5);
    var cutStr = cutoff.toISOString().slice(0,10);
    var filtPairs = [];
    for (var fi=0;fi<pfSeries.dates.length;fi++) {
      if (pfSeries.dates[fi]>=cutStr && pfSeries.values[fi]!=null && pfSeries.values[fi]>0)
        filtPairs.push({date:pfSeries.dates[fi],
          // Prefer TWR series — deposits/purchases don't register as gains
          value:(pfSeries.twrValues && pfSeries.twrValues[fi]!=null && pfSeries.twrValues[fi]>0) ? pfSeries.twrValues[fi] : pfSeries.values[fi]});
    }
    if (filtPairs.length < 5) return;
    var dates = filtPairs.map(function(p){return p.date;});
    var values = filtPairs.map(function(p){return p.value;});

    // SPY data
    var spyData = null;
    try {
      var spyR = await fetchChart('SPY', range==='ytd'?'1y':range, '1d');
      var spyPts = (spyR.points||[]).filter(function(p){return p.date && p.close && p.date>=cutStr;});
      if (spyPts.length) { var s0=spyPts[0].close; spyData=spyPts.map(function(p){return{date:p.date,val:(p.close/s0)*values[0]};}); }
    } catch(e2){}

    // Render underwater chart
    renderPerfUnderwaterChart(values, dates, spyData);
    // Render monthly heatmap
    renderPerfMonthlyHeatmap(values, dates);

    // Add Calmar ratio and Time-Underwater to the scorecard
    var bsEl = document.getElementById('perfBenchScorecard');
    if (bsEl && values.length > 5) {
      var totalReturn = (values[values.length-1] - values[0]) / values[0];
      var annRet2 = Math.pow(1+totalReturn, 252/(Math.max(values.length-1,1))) - 1;
      var peak3 = values[0], maxDD2 = 0;
      values.forEach(function(v){ if(v>peak3) peak3=v; var dd=(peak3-v)/peak3; if(dd>maxDD2) maxDD2=dd; });
      var calmar = maxDD2 > 0 ? (annRet2 / maxDD2) : 0;
      // Time Underwater = % of days in drawdown
      var peakTU = values[0], uwDays = 0;
      values.forEach(function(v){ if(v>=peakTU) peakTU=v; else uwDays++; });
      var timeUW = values.length > 1 ? uwDays / (values.length - 1) * 100 : 0;

      // Append to existing scorecard HTML
      var newCards = [
        {l:'Calmar Ratio', v: calmar.toFixed(2), c: calmar>1?'var(--success)':calmar>0.5?'var(--warning)':'var(--danger)',
         tip:'Ann. Return ÷ Max Drawdown. >1.0 = excellent risk-adjusted return per drawdown unit.'},
        {l:'Time Underwater', v: timeUW.toFixed(0)+'%', c: timeUW<25?'var(--success)':timeUW<50?'var(--warning)':'var(--danger)',
         tip:'% of trading days spent below the previous portfolio high. Lower = more time at or near new highs.'}
      ].map(function(s){
        return '<div class="chart-stat-box" title="'+(s.tip||'')+'"><div class="chart-stat-label">'+s.l+'</div><div class="chart-stat-value" style="color:'+s.c+';">'+s.v+'</div></div>';
      }).join('');
      bsEl.innerHTML += newCards;
    }
  } catch(e3) { console.warn('[renderPerformanceTab extension]', e3); }
};

// ═══════════════════════════════════════════════════════════
// ════  LEVERAGED ETF SIGNALS MODULE  ═══════════════════════
// ═══════════════════════════════════════════════════════════

document.getElementById('levETFTicker') && document.getElementById('levETFTicker').addEventListener('change', function(){
  var customEl = document.getElementById('levETFCustom');
  if (customEl) customEl.style.display = this.value === 'custom' ? '' : 'none';
});

async function levETFRun() {
  var tickerSel = document.getElementById('levETFTicker');
  var customEl  = document.getElementById('levETFCustom');
  var multEl    = document.getElementById('levETFMult');
  var statusEl  = document.getElementById('levETFStatus');
  var ticker = tickerSel && tickerSel.value === 'custom' ? (customEl ? customEl.value.trim().toUpperCase() : '') : (tickerSel ? tickerSel.value : 'TQQQ');
  if (!ticker) { if(statusEl) statusEl.textContent = 'Enter a ticker.'; return; }
  var L = parseInt(multEl ? multEl.value : 3) || 3;
  if (statusEl) statusEl.textContent = '⏳ Fetching data…';

  // Underlying ticker (strip leverage)
  var UNDERLYING = {
    'TQQQ':'QQQ','SOXL':'SOXX','UPRO':'SPY','TECL':'XLK','FNGU':'FNGU',
    'QLD':'QQQ','SSO':'SPY','SPXL':'SPY','LABU':'XBI','TNA':'IWM'
  };
  var underlying = UNDERLYING[ticker] || (L > 1 ? 'SPY' : ticker);

  try {
    // Fetch in parallel: leveraged ETF 5yr, underlying 5yr, SPY 1yr (for 200-SMA), VIX quote
    var [levR, undR, spyR, vixQ] = await Promise.allSettled([
      fetchChart(ticker, '5y', '1d'),
      fetchChart(underlying, '5y', '1d'),
      fetchChart('SPY', '1y', '1d'),
      fetchQuote('%5EVIX')
    ]);

    var levPts  = levR.status  === 'fulfilled' ? (levR.value.points  ||[]).filter(function(p){return p.close!=null;}) : [];
    var undPts  = undR.status  === 'fulfilled' ? (undR.value.points  ||[]).filter(function(p){return p.close!=null;}) : [];
    var spy1Pts = spyR.status  === 'fulfilled' ? (spyR.value.points  ||[]).filter(function(p){return p.close!=null;}) : [];
    var vixQ2   = vixQ.status  === 'fulfilled' ? vixQ.value : null;

    // ── Decay Calculator ──
    var decayEl = document.getElementById('levETFDecayBox');
    if (decayEl && undPts.length > 20) {
      var closes = undPts.map(function(p){return p.close;});
      var rets = [];
      for (var i=1;i<closes.length;i++) rets.push((closes[i]-closes[i-1])/closes[i-1]);
      var recentRets = rets.slice(-63); // 3-month window
      var mean = recentRets.reduce(function(s,r){return s+r;},0)/recentRets.length;
      var variance = recentRets.reduce(function(s,r){return s+(r-mean)*(r-mean);},0)/recentRets.length;
      var sigma = Math.sqrt(variance);
      var decayPerDay = L*(L-1)/2*variance;
      var decayAnn    = (1-Math.pow(1-decayPerDay,252))*100;
      var sigmaAnn    = sigma*Math.sqrt(252)*100;

      decayEl.innerHTML =
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">'
        +'<div class="metric-card" style="background:var(--panel);">'
          +'<div class="metric-label">Daily Volatility Decay</div>'
          +'<div class="metric-value" style="color:var(--danger);font-size:22px;">−'+(decayPerDay*100).toFixed(3)+'%</div>'
          +'<div class="metric-sub">per trading day</div></div>'
        +'<div class="metric-card" style="background:var(--panel);">'
          +'<div class="metric-label">Annualized Decay</div>'
          +'<div class="metric-value" style="color:var(--danger);font-size:22px;">−'+decayAnn.toFixed(1)+'%</div>'
          +'<div class="metric-sub">pure vol drag / year</div></div>'
        +'<div class="metric-card" style="background:var(--panel);">'
          +'<div class="metric-label">Underlying Ann. Vol</div>'
          +'<div class="metric-value" style="color:var(--navy);font-size:20px;">'+sigmaAnn.toFixed(1)+'%</div>'
          +'<div class="metric-sub">3-month realized</div></div>'
        +'<div class="metric-card" style="background:var(--panel);">'
          +'<div class="metric-label">Leverage Multiplier</div>'
          +'<div class="metric-value" style="color:var(--navy);font-size:20px;">'+L+'×</div>'
          +'<div class="metric-sub">'+ticker+' on '+underlying+'</div></div>'
        +'</div>'
        +'<div style="font-size:11px;color:var(--text-sec);background:var(--panel);padding:8px 10px;border-radius:4px;">'
          +'<strong>Formula:</strong> Decay/day = L×(L−1)/2 × σ² = '+L+'×'+(L-1)+'/2 × '+(variance*10000).toFixed(2)+'bp = '+(decayPerDay*100).toFixed(3)+'%/day &bull; '
          +'This means '+ticker+' must earn <strong>>'+(decayPerDay*100).toFixed(2)+'% per day</strong> just to stay flat after decay.'
        +'</div>';
    }

    // ── Suitability Score ──
    var signalEl = document.getElementById('levETFSignalBox');
    var scoreBanner = document.getElementById('levETFScoreBanner');
    if (signalEl && spy1Pts.length > 200) {
      var spyCloses = spy1Pts.map(function(p){return p.close;});
      var spy200 = spyCloses.slice(-200).reduce(function(s,v){return s+v;},0)/200;
      var spyCurrent = spyCloses[spyCloses.length-1];
      var spyAbove200 = spyCurrent > spy200;

      // VIX
      var vixLevel = vixQ2 ? (vixQ2.current || vixQ2.price || 20) : 20;
      var vixBelow25 = vixLevel < 25;
      var vixBelow30 = vixLevel < 30;

      // RSI(14) on SPY
      function rsi14(closes) {
        var gains=0,losses=0;
        var recent=closes.slice(-15);
        for(var i=1;i<recent.length;i++){var d=recent[i]-recent[i-1];if(d>0)gains+=d;else losses-=d;}
        var rs=losses>0?gains/losses:100; return 100-100/(1+rs);
      }
      var spyRSI = rsi14(spyCloses);
      var rsiOK = spyRSI >= 30 && spyRSI <= 70;

      // SPY drawdown from recent peak
      var spyPeak = Math.max.apply(null,spyCloses.slice(-252));
      var spyDD = (spyCurrent - spyPeak) / spyPeak * 100;
      var spyDDOK = spyDD > -15;

      // Score
      var score = 0;
      if (spyAbove200) score += 30;
      if (vixBelow25)  score += 25;
      if (vixBelow30 && !vixBelow25) score += 10;
      if (rsiOK)       score += 15;
      if (spyDDOK)     score += 15;
      if (vixLevel > 30) score -= 30;
      if (spyDD < -15) score -= 20;
      score = Math.max(-20, Math.min(100, score));

      var scoreColor = score >= 75 ? 'var(--success)' : score >= 50 ? '#8B6914' : score >= 25 ? 'var(--warning)' : 'var(--danger)';
      var scoreLabel = score >= 75 ? '✅ Conditions Favorable — Leverage Appropriate'
                     : score >= 50 ? '⚠️ Mixed Signals — Consider Reducing Leverage'
                     : score >= 25 ? '🔶 Caution — Conditions Deteriorating'
                     : '🚫 Risk-Off — Reduce / Exit Leverage';
      var scoreAction = score >= 75 ? '100% leveraged position appropriate per composite signal.'
                      : score >= 50 ? '50% leveraged / 50% underlying or index ETF.'
                      : score >= 25 ? '100% unleveraged ETF or index.'
                      : '50% defensive (TLT, SHV, GLD, XLP) or cash.';

      // Render signal panel
      signalEl.innerHTML =
        '<div style="display:grid;gap:8px;">'
        +sigRow('SPY above 200-SMA', spyAbove200, 'SPY $'+spyCurrent.toFixed(2)+' vs 200-SMA $'+spy200.toFixed(2), '+30 pts')
        +sigRow('VIX < 25', vixBelow25, 'VIX = '+vixLevel.toFixed(1), vixBelow25?'+25 pts':vixBelow30?'+10 pts (below 30)':'−30 pts (above 30)')
        +sigRow('RSI(14) 30–70', rsiOK, 'SPY RSI = '+spyRSI.toFixed(0), rsiOK?'+15 pts':'0 pts')
        +sigRow('SPY < −15% from peak', spyDDOK, 'SPY drawdown = '+spyDD.toFixed(1)+'%', spyDDOK?'+15 pts':'−20 pts')
        +'</div>'
        +'<div style="margin-top:12px;padding:10px;background:var(--panel);border-radius:4px;font-size:12px;">'
          +'<strong>Suggested Action:</strong> '+scoreAction+'</div>';

      // Score banner
      if (scoreBanner) {
        scoreBanner.style.display = 'flex';
        scoreBanner.style.alignItems = 'center';
        scoreBanner.style.gap = '16px';
        scoreBanner.style.padding = '14px 18px';
        scoreBanner.style.background = 'linear-gradient(135deg,var(--navy),#002A50)';
        scoreBanner.style.borderRadius = 'var(--radius)';
        scoreBanner.style.marginBottom = '14px';
        scoreBanner.innerHTML =
          '<div style="font-size:48px;font-weight:900;color:'+scoreColor+';font-family:Courier New,monospace;line-height:1;">'+score+'</div>'
          +'<div style="flex:1;">'
            +'<div style="font-size:13px;font-weight:700;color:#fff;margin-bottom:2px;">'+scoreLabel+'</div>'
            +'<div style="font-size:11px;color:rgba(255,255,255,0.65);">Suitability score out of 100 &bull; Based on: SPY 200-SMA (+30), VIX (+25), RSI (+15), Drawdown (+15), Penalties (−30/−20)</div>'
          +'</div>';
      }
    }

    // KPI strip
    var kpiEl = document.getElementById('levETFKPIs');
    if (kpiEl && levPts.length > 5) {
      var lev0=levPts[0].close, levN=levPts[levPts.length-1].close;
      var levRet=(levN-lev0)/lev0*100;
      var und0=undPts.length?undPts[0].close:null, undN=undPts.length?undPts[undPts.length-1].close:null;
      var undRet=und0&&undN?(undN-und0)/und0*100:null;
      var levDDs=[]; var levPk=levPts[0].close;
      levPts.forEach(function(p){levPk=Math.max(levPk,p.close);levDDs.push((p.close-levPk)/levPk*100);});
      var levMDD=Math.min.apply(null,levDDs);

      kpiEl.innerHTML=[
        {l:ticker+' 5Y Return',v:(levRet>=0?'+':'')+levRet.toFixed(0)+'%',c:levRet>=0?'var(--success)':'var(--danger)'},
        undRet!==null?{l:underlying+' 5Y Return',v:(undRet>=0?'+':'')+undRet.toFixed(0)+'%',c:undRet>=0?'var(--success)':'var(--danger)'}:null,
        {l:ticker+' Max Drawdown',v:levMDD.toFixed(1)+'%',c:'var(--danger)'},
        vixQ2?{l:'VIX (Live)',v:(vixQ2.current||vixQ2.price||'—').toFixed?((vixQ2.current||vixQ2.price||0)).toFixed(1):'—',c:'var(--navy)'}:null
      ].filter(Boolean).map(function(s){return '<div class="chart-stat-box"><div class="chart-stat-label">'+s.l+'</div><div class="chart-stat-value" style="color:'+s.c+';">'+s.v+'</div></div>';}).join('');
    }

    // ── Drawdown comparison chart ──
    var ddLoading = document.getElementById('levETFDDLoading');
    var ddWrap    = document.getElementById('levETFDDWrap');
    var ddCtx     = document.getElementById('levETFDDChart');
    var ddStats   = document.getElementById('levETFDDStats');
    if (ddCtx && levPts.length > 5 && undPts.length > 5) {
      if (window._levETFDDChart) { try{window._levETFDDChart.destroy();}catch(e){} }
      if (ddLoading) ddLoading.style.display='none';
      if (ddWrap)    ddWrap.style.display='';

      function toDD2(pts) { var pk=pts[0].close,dd=[]; pts.forEach(function(p){pk=Math.max(pk,p.close);dd.push((p.close-pk)/pk*100);}); return dd; }
      var levDD2 = toDD2(levPts);
      var undDD2 = toDD2(undPts);
      var ddLabels = levPts.map(function(p){return p.date?p.date.slice(0,10):'';});
      // Align underlying to lev length
      var undDDAligned = undDD2.slice(-levDD2.length);
      if (undDDAligned.length < levDD2.length) {
        var pad = new Array(levDD2.length-undDDAligned.length).fill(0);
        undDDAligned = pad.concat(undDDAligned);
      }

      window._levETFDDChart = new Chart(ddCtx.getContext('2d'), {
        type:'line',
        data:{ labels:ddLabels, datasets:[
          { label:ticker+' Drawdown', data:levDD2, borderColor:'rgba(139,42,42,0.9)', borderWidth:1.5,
            pointRadius:0, fill:true, backgroundColor:'rgba(139,42,42,0.15)', tension:0.2 },
          { label:underlying+' Drawdown', data:undDDAligned, borderColor:'rgba(91,155,213,0.8)', borderWidth:1,
            borderDash:[4,3], pointRadius:0, fill:false, tension:0.2 }
        ]},
        options:{
          responsive:true, maintainAspectRatio:false, animation:false,
          plugins:{ legend:{display:true,labels:{font:{size:11}}},
            tooltip:{callbacks:{label:function(c){return c.dataset.label+': '+(c.parsed.y||0).toFixed(1)+'%';}}}},
          scales:{ x:{ticks:{maxTicksLimit:10,font:{size:9}},grid:{display:false}},
            y:{ticks:{callback:function(v){return v.toFixed(0)+'%';},font:{size:9}},suggestedMax:0} }
        }
      });
      var levMDD3=Math.min.apply(null,levDD2), undMDD3=Math.min.apply(null,undDDAligned);
      if (ddStats) ddStats.innerHTML='<strong>'+ticker+' Max Drawdown: </strong><span style="color:var(--danger);font-weight:700;">'+levMDD3.toFixed(1)+'%</span> &bull; <strong>'+underlying+' Max Drawdown: </strong><span style="color:#8B6914;font-weight:700;">'+undMDD3.toFixed(1)+'%</span> &bull; <span style="font-size:11px;color:var(--text-sec);">Recovery math: a '+Math.abs(levMDD3).toFixed(0)+'% loss requires a '+((1/(1+levMDD3/100)-1)*100).toFixed(0)+'% gain to recover.</span>';
    }

    if (statusEl) statusEl.textContent = '✓ Done';
  } catch(e) {
    if (statusEl) statusEl.textContent = '⚠ Error: ' + e.message;
    console.error('[levETFRun]', e);
  }
}

function sigRow(label, pass, detail, pts) {
  var color = pass ? 'var(--success)' : 'var(--danger)';
  var icon  = pass ? '✅' : '❌';
  return '<div style="display:flex;align-items:center;gap:10px;padding:7px 10px;background:var(--panel);border-radius:4px;border-left:3px solid '+color+';">'
    +'<span style="font-size:16px;">'+icon+'</span>'
    +'<div style="flex:1;">'
      +'<div style="font-size:12px;font-weight:600;color:var(--navy);">'+label+'</div>'
      +'<div style="font-size:11px;color:var(--text-sec);">'+detail+'</div>'
    +'</div>'
    +'<div style="font-size:11px;font-family:Courier New,monospace;color:'+color+';font-weight:700;">'+pts+'</div>'
    +'</div>';
}

// ── Wire rqShowTab to handle levETF tab ──
var _origRqShowTab = window.rqShowTab;
window.rqShowTab = function(name) {
  if (typeof _origRqShowTab === 'function') _origRqShowTab(name);
  if (name === 'levETF') {
    // Auto-run if not yet run
    var ddLoading = document.getElementById('levETFDDLoading');
    if (ddLoading && ddLoading.style.display !== 'none') levETFRun();
  }
};

// Wire pfShowTab for sectors tab — wrap once after all patches are done
(function() {
  var _origPfShowTab_sectors = window.pfShowTab;
  window.pfShowTab = function(name) {
    if (typeof _origPfShowTab_sectors === 'function') _origPfShowTab_sectors(name);
    if (name === 'sectors') setTimeout(function(){ if (typeof renderSectorsTab==='function') renderSectorsTab(); }, 50);
  };
})();

// ════════════════════════════════════════════════════════════════════
// QUAD MAP — Business Cycle Visualization (Hedgeye GIP / Fidelity AART)
// ════════════════════════════════════════════════════════════════════

// Static playbook data (Fidelity AART framework)
var PLAYBOOK_DATA = {
  'Goldilocks': {
    label: 'Goldilocks', quadNum: 'Q1', emoji: '☀️',
    growthDir: 'Accelerating', inflDir: 'Decelerating',
    color: '#2E7D52',
    narrative: 'Growth is accelerating while inflation cools — the most favorable environment for risk assets. Equities historically outperform, with cyclicals and growth stocks leading. The Fed is likely on hold or cutting.',
    sectors: [
      { name: 'Technology', rec: 'OW', hit: 74, etfs: 'XLK, QQQ, SOXX' },
      { name: 'Consumer Discretionary', rec: 'OW', hit: 68, etfs: 'XLY, AMZN, RIVN' },
      { name: 'Financials', rec: 'OW', hit: 63, etfs: 'XLF, KRE, BRK' },
      { name: 'Industrials', rec: 'OW', hit: 61, etfs: 'XLI, ITA, JETS' },
      { name: 'Communication Services', rec: 'OW', hit: 59, etfs: 'XLC, META, GOOGL' },
      { name: 'Healthcare', rec: 'NEUT', hit: 48, etfs: 'XLV, IBB, ARKG' },
      { name: 'Materials', rec: 'NEUT', hit: 45, etfs: 'XLB, GDX, COPX' },
      { name: 'Energy', rec: 'NEUT', hit: 42, etfs: 'XLE, USO, XOM' },
      { name: 'Consumer Staples', rec: 'UW', hit: 38, etfs: 'XLP, KO, PG' },
      { name: 'Utilities', rec: 'UW', hit: 32, etfs: 'XLU, NEE, DUK' },
      { name: 'Real Estate', rec: 'UW', hit: 30, etfs: 'XLRE, VNQ, O' }
    ],
    assets: [
      { name: 'US Equities', rec: 'OW', hit: 72, note: 'Core overweight — broad SPY or QQQ' },
      { name: 'Intl Developed', rec: 'OW', hit: 60, note: 'EFA, VEA — benefits from USD softening' },
      { name: 'HY Credit', rec: 'OW', hit: 65, note: 'Spreads compress in goldilocks; HYG, JNK' },
      { name: 'Commodities', rec: 'NEUT', hit: 48, note: 'Moderate; copper benefits from growth' },
      { name: 'EM Equities', rec: 'NEUT', hit: 52, note: 'EEM — limited upside vs. US growth' },
      { name: 'Gold', rec: 'UW', hit: 38, note: 'Inflation falling = headwind for gold' },
      { name: 'Long Duration UST', rec: 'UW', hit: 35, note: 'Rising risk appetite pressures bonds' },
      { name: 'Cash', rec: 'UW', hit: 28, note: 'Opportunity cost high in goldilocks' }
    ]
  },
  'Overheat': {
    label: 'Overheat', quadNum: 'Q2', emoji: '🔥',
    growthDir: 'Accelerating', inflDir: 'Accelerating',
    color: '#8B6914',
    narrative: 'Growth is still strong but inflation is rising. Commodities and real assets shine. The Fed is likely hiking. Risk assets remain positive but momentum slows. Avoid long-duration bonds.',
    sectors: [
      { name: 'Energy', rec: 'OW', hit: 76, etfs: 'XLE, USO, MRO' },
      { name: 'Materials', rec: 'OW', hit: 70, etfs: 'XLB, COPX, GDX' },
      { name: 'Financials', rec: 'OW', hit: 62, etfs: 'XLF, KBE, JPM' },
      { name: 'Industrials', rec: 'OW', hit: 58, etfs: 'XLI, ITA, DE' },
      { name: 'Real Estate', rec: 'NEUT', hit: 45, etfs: 'XLRE, VNQ, SPG' },
      { name: 'Healthcare', rec: 'NEUT', hit: 50, etfs: 'XLV, UNH, JNJ' },
      { name: 'Consumer Discretionary', rec: 'NEUT', hit: 43, etfs: 'XLY, AMZN, HD' },
      { name: 'Consumer Staples', rec: 'NEUT', hit: 47, etfs: 'XLP, PG, KO' },
      { name: 'Technology', rec: 'UW', hit: 36, etfs: 'XLK — valuation compression' },
      { name: 'Communication Services', rec: 'UW', hit: 34, etfs: 'XLC — ad spend slows' },
      { name: 'Utilities', rec: 'UW', hit: 30, etfs: 'XLU — rising rates = headwind' }
    ],
    assets: [
      { name: 'Commodities', rec: 'OW', hit: 78, note: 'DJP, PDBC — inflation hedge' },
      { name: 'Gold', rec: 'OW', hit: 68, note: 'GLD, IAU — rising inflation premium' },
      { name: 'TIPS', rec: 'OW', hit: 65, note: 'TIP, VTIP — inflation protection' },
      { name: 'US Equities', rec: 'NEUT', hit: 52, note: 'Still positive but rate risk rising' },
      { name: 'EM Equities', rec: 'NEUT', hit: 48, note: 'EEM — commodity producers benefit' },
      { name: 'HY Credit', rec: 'UW', hit: 40, note: 'Spreads vulnerable to rate shock' },
      { name: 'Long Duration UST', rec: 'UW', hit: 28, note: 'TLT — worst asset in overheat' },
      { name: 'Cash', rec: 'NEUT', hit: 50, note: 'Yields rising; short-T-bills attractive' }
    ]
  },
  'Stagflation': {
    label: 'Stagflation', quadNum: 'Q3', emoji: '⚠️',
    growthDir: 'Decelerating', inflDir: 'Accelerating',
    color: '#8B2A2A',
    narrative: 'The worst quadrant: growth is falling while inflation stays elevated. The Fed is stuck. Real assets and defensives preserve capital best. Avoid growth equities and long duration.',
    sectors: [
      { name: 'Energy', rec: 'OW', hit: 72, etfs: 'XLE, USO, VLO' },
      { name: 'Consumer Staples', rec: 'OW', hit: 68, etfs: 'XLP, KO, WMT' },
      { name: 'Healthcare', rec: 'OW', hit: 65, etfs: 'XLV, MDT, ABBV' },
      { name: 'Utilities', rec: 'OW', hit: 60, etfs: 'XLU, NEE, D' },
      { name: 'Materials', rec: 'NEUT', hit: 50, etfs: 'XLB — mixed; gold miners OW' },
      { name: 'Real Estate', rec: 'UW', hit: 38, etfs: 'XLRE — hurt by rates + weak economy' },
      { name: 'Financials', rec: 'UW', hit: 35, etfs: 'XLF — credit losses rise' },
      { name: 'Industrials', rec: 'UW', hit: 32, etfs: 'XLI — demand collapse' },
      { name: 'Technology', rec: 'UW', hit: 28, etfs: 'XLK — growth premium deflates' },
      { name: 'Consumer Discretionary', rec: 'UW', hit: 25, etfs: 'XLY — consumers squeezed' },
      { name: 'Communication Services', rec: 'UW', hit: 30, etfs: 'XLC — ad spend collapses' }
    ],
    assets: [
      { name: 'Gold', rec: 'OW', hit: 76, note: 'GLD — classic stagflation hedge' },
      { name: 'Commodities', rec: 'OW', hit: 65, note: 'PDBC — supply shock driven' },
      { name: 'TIPS', rec: 'OW', hit: 62, note: 'TIP — inflation floor protection' },
      { name: 'Cash', rec: 'OW', hit: 60, note: 'Yields high; T-bills preserve optionality' },
      { name: 'EM Equities', rec: 'UW', hit: 35, note: 'Dollar strength = EM headwind' },
      { name: 'US Equities', rec: 'UW', hit: 32, note: 'Margin compression + rate pressure' },
      { name: 'HY Credit', rec: 'UW', hit: 28, note: 'Default risk spikes in stagflation' },
      { name: 'Long Duration UST', rec: 'UW', hit: 30, note: 'Inflation keeps long yields elevated' }
    ]
  },
  'Deflation': {
    label: 'Deflation', quadNum: 'Q4', emoji: '❄️',
    growthDir: 'Decelerating', inflDir: 'Decelerating',
    color: '#5B9BD5',
    narrative: 'Growth is slowing and inflation is falling. The Fed is cutting. Long-duration bonds rally sharply. Defensives outperform. Cash flow businesses with pricing power hold up best.',
    sectors: [
      { name: 'Healthcare', rec: 'OW', hit: 70, etfs: 'XLV, JNJ, UNH' },
      { name: 'Consumer Staples', rec: 'OW', hit: 67, etfs: 'XLP, PG, COST' },
      { name: 'Utilities', rec: 'OW', hit: 72, etfs: 'XLU, NEE, DUK' },
      { name: 'Real Estate', rec: 'OW', hit: 58, etfs: 'XLRE, VNQ — cuts = cap rate relief' },
      { name: 'Financials', rec: 'NEUT', hit: 45, etfs: 'XLF — NIM compression' },
      { name: 'Technology', rec: 'NEUT', hit: 50, etfs: 'XLK — durable cash flows help' },
      { name: 'Communication Services', rec: 'NEUT', hit: 45, etfs: 'XLC — defensive revenue mix' },
      { name: 'Industrials', rec: 'UW', hit: 38, etfs: 'XLI — capex dries up' },
      { name: 'Energy', rec: 'UW', hit: 32, etfs: 'XLE — demand falls, oil drops' },
      { name: 'Materials', rec: 'UW', hit: 30, etfs: 'XLB — deflationary pressure on PPI' },
      { name: 'Consumer Discretionary', rec: 'UW', hit: 35, etfs: 'XLY — consumer retrenchment' }
    ],
    assets: [
      { name: 'Long Duration UST', rec: 'OW', hit: 78, note: 'TLT, EDV — best asset in deflation' },
      { name: 'Gold', rec: 'OW', hit: 65, note: 'GLD — negative real rates boost gold' },
      { name: 'Intl Developed', rec: 'NEUT', hit: 50, note: 'EFA — depends on global cycle sync' },
      { name: 'US Equities', rec: 'NEUT', hit: 48, note: 'Quality factor (QUAL) outperforms' },
      { name: 'Cash', rec: 'NEUT', hit: 52, note: 'Short T-bills until cuts materialize' },
      { name: 'HY Credit', rec: 'UW', hit: 35, note: 'Recession risk = wider spreads' },
      { name: 'Commodities', rec: 'UW', hit: 30, note: 'PDBC — demand destruction' },
      { name: 'EM Equities', rec: 'UW', hit: 38, note: 'EEM — slower global growth' }
    ]
  }
};

/* ════════════════════════════════════════════════════════════════════════════
   SECTOR PRIORS BY REGIME — replaced 2026-07-24.

   WHAT WAS HERE: a HIT_RATE_DATA table of precise-looking percentages
   (Technology early 68%, mid 74%, late 45%, recession 28%, and so on) footnoted
   "Fidelity AART framework" and, on the Playbook page, "Asset class performance
   data 1972–2023".

   TWO PROBLEMS, BOTH SERIOUS:

   1. THE NUMBERS WERE INVENTED. Nothing in the codebase ever computed them.
      Presenting fabricated figures under the names of real institutions is
      worse than presenting no citation at all.

   2. THEY CONTRADICTED THE OTHER TABLE. populateHitRateTable() mapped Quads to
      cycle phases {Goldilocks→early, Overheat→mid, Stagflation→late,
      Deflation→recession} and rendered THIS table, while the Playbook rendered
      PLAYBOOK_DATA. A cell-by-cell comparison found 26 of 44 sector-regime
      cells disagreeing, with gaps up to 38 points:

        Overheat / Technology .......... Playbook 36% (UW)  vs  table 74%
        Goldilocks / Real Estate ....... Playbook 30% (UW)  vs  table 58%
        Overheat / Consumer Disc. ...... Playbook 43%       vs  table 68%
        Deflation / Technology ......... Playbook 50%       vs  table 28%

      Technology in Overheat was simultaneously marked underweight on one page
      and highlighted at 74% on another — opposite conclusions, two clicks apart.

   3. THE MAPPING ITSELF WAS A CATEGORY ERROR. Quads (growth × inflation
      DIRECTION) and cycle phases (early/mid/late/recession) are different
      taxonomies. Overheat is characteristically LATE cycle, not mid.

   THE FIX: one table, keyed directly on the Quad (no phase mapping), carrying
   ORDINAL tilts and a stated rationale instead of fake precision. Where a real
   measured hit rate is available from the warehouse it is shown alongside, with
   its sample size — see renderSectorPriors(). PLAYBOOK_DATA now derives its
   tilts from this same object, so the two pages cannot diverge again.
   ════════════════════════════════════════════════════════════════════════════ */

var SECTOR_PRIORS = {
  // tilt: +2 strong OW, +1 OW, 0 neutral, -1 UW, -2 strong UW
  Goldilocks: {
    rationale: 'Accelerating growth with cooling inflation. Falling discount rates and rising earnings both help long-duration growth and cyclicals; defensives lag because there is no reason to pay for safety.',
    tilts: { 'Information Technology': 2, 'Consumer Discretionary': 2, 'Industrials': 1, 'Financials': 1,
             'Communication Services': 1, 'Materials': 0, 'Health Care': 0, 'Energy': -1,
             'Consumer Staples': -1, 'Real Estate': -1, 'Utilities': -2 }
  },
  Overheat: {
    rationale: 'Growth and inflation both rising. Pricing power and real assets win; long-duration multiples compress as rates climb. This is characteristically a LATE-cycle condition, not a mid-cycle one.',
    tilts: { 'Energy': 2, 'Materials': 2, 'Financials': 1, 'Industrials': 1,
             'Health Care': 0, 'Consumer Staples': 0, 'Consumer Discretionary': -1,
             'Real Estate': -1, 'Information Technology': -1, 'Communication Services': -1, 'Utilities': -2 }
  },
  Stagflation: {
    rationale: 'Weak growth with sticky inflation — the hardest regime for equities generally. Inelastic demand and hard assets hold up; anything cyclical or discretionary sees earnings compress while costs stay high.',
    tilts: { 'Energy': 2, 'Consumer Staples': 2, 'Health Care': 1, 'Utilities': 1,
             'Materials': 0, 'Financials': -1, 'Real Estate': -1, 'Industrials': -1,
             'Communication Services': -1, 'Information Technology': -2, 'Consumer Discretionary': -2 }
  },
  Deflation: {
    rationale: 'Growth and inflation both falling. Duration and defensive cash flows win; commodity-sensitive and credit-sensitive sectors suffer most. Quality of balance sheet matters more than quality of growth.',
    tilts: { 'Consumer Staples': 2, 'Health Care': 2, 'Utilities': 1, 'Real Estate': 0,
             'Information Technology': 0, 'Communication Services': 0, 'Industrials': -1,
             'Consumer Discretionary': -1, 'Financials': -1, 'Materials': -2, 'Energy': -2 }
  }
};

var TILT_LABELS = {
  '2':  { label: 'Strong OW', color: '#1E5E3A' },
  '1':  { label: 'Overweight', color: '#2E7D52' },
  '0':  { label: 'Neutral',    color: '#5A6A7A' },
  '-1': { label: 'Underweight',color: '#8B6914' },
  '-2': { label: 'Strong UW',  color: '#8B2A2A' }
};

/**
 * Measured hit rate from the warehouse, when coverage allows. Returns null when
 * it cannot be computed — the UI then shows the ordinal prior alone rather than
 * inventing a number. This is the mechanism by which the priors get progressively
 * replaced by evidence as the warehouse accumulates history.
 */
function measuredSectorHitRate(sector) {
  var WH = window.PerryWarehouse;
  if (!WH || !WH.ready()) return null;
  var rows = WH.all().filter(function (r) {
    return r.sector === sector && r.ret_3m != null;
  });
  if (rows.length < 8) return null;
  var spy = WH.get('SPY');
  var bench = spy && spy.ret_3m != null ? spy.ret_3m : null;
  if (bench == null) {
    var all = WH.all().filter(function (r) { return r.ret_3m != null; });
    if (all.length < 30) return null;
    bench = WH.util.median(all.map(function (r) { return r.ret_3m; }));
  }
  var beat = rows.filter(function (r) { return r.ret_3m > bench; }).length;
  return {
    pct: beat / rows.length * 100,
    n: rows.length,
    // Honest label: this is CURRENT cross-sectional breadth vs the benchmark
    // over one trailing window — not a multi-cycle historical hit rate.
    basis: 'share of ' + rows.length + ' names in this sector beating the benchmark over the trailing 3 months'
  };
}

/* Back-compat: legacy callers still reference HIT_RATE_DATA. It is now DERIVED
   from SECTOR_PRIORS so the two can never diverge, and the phase columns are
   generated from the Quad that actually corresponds to each phase rather than
   from an arbitrary mapping. Values are ordinal tilts, not percentages. */
var HIT_RATE_DATA = (function () {
  var phaseToQuad = { early: 'Goldilocks', mid: 'Goldilocks', late: 'Overheat', recession: 'Deflation' };
  var sectors = Object.keys(SECTOR_PRIORS.Goldilocks.tilts);
  return sectors.map(function (s) {
    var row = { sector: s };
    Object.keys(phaseToQuad).forEach(function (ph) {
      row[ph] = SECTOR_PRIORS[phaseToQuad[ph]].tilts[s];
    });
    return row;
  });
})();

/* ════════════════════════════════════════════════════════════════════════════
   RECONCILE PLAYBOOK_DATA WITH SECTOR_PRIORS — added 2026-07-24.

   PLAYBOOK_DATA was authored independently of the hit-rate table, which is how
   the two drifted into disagreeing on 26 of 44 sector-regime cells. Rather than
   hand-editing two lists and hoping they stay in sync, the Playbook's sector
   recommendations are now OVERWRITTEN from SECTOR_PRIORS at load time.

   The ETF suggestions and narrative text in PLAYBOOK_DATA are genuine editorial
   content and are preserved. Only `rec` and `hit` — the two fields that
   conflicted — are replaced. `hit` becomes null, and the renderer shows the
   ordinal tilt instead of a fabricated percentage.
   ════════════════════════════════════════════════════════════════════════════ */
(function reconcilePlaybookWithPriors() {
  if (typeof PLAYBOOK_DATA === 'undefined') return;

  // PLAYBOOK_DATA uses 'Technology' / 'Healthcare'; GICS (and the warehouse)
  // use 'Information Technology' / 'Health Care'. Bridge the two.
  var alias = {
    'Technology': 'Information Technology',
    'Healthcare': 'Health Care',
    'Health Care': 'Health Care',
    'Information Technology': 'Information Technology'
  };
  var recFromTilt = function (t) { return t > 0 ? 'OW' : t < 0 ? 'UW' : 'NEUT'; };

  Object.keys(SECTOR_PRIORS).forEach(function (quad) {
    var pd = PLAYBOOK_DATA[quad];
    if (!pd || !pd.sectors) return;
    var tilts = SECTOR_PRIORS[quad].tilts;

    pd.sectors.forEach(function (s) {
      var canonical = alias[s.name] || s.name;
      var tilt = tilts[canonical];
      if (tilt == null) return;
      s.rec = recFromTilt(tilt);
      s.tilt = tilt;
      s.tiltLabel = (TILT_LABELS[String(tilt)] || TILT_LABELS['0']).label;
      s.hit = null;                       // no more invented percentages
      s.canonicalSector = canonical;
    });

    // Order the grid by conviction so the strongest calls read first.
    pd.sectors.sort(function (a, b) { return (b.tilt || 0) - (a.tilt || 0); });
    pd.priorRationale = SECTOR_PRIORS[quad].rationale;
  });

  // Asset-class hit rates were invented too. Convert to ordinal tilts derived
  // from the existing rec, and drop the numbers.
  Object.keys(PLAYBOOK_DATA).forEach(function (quad) {
    var pd = PLAYBOOK_DATA[quad];
    if (!pd || !pd.assets) return;
    pd.assets.forEach(function (a) {
      a.tilt = a.rec === 'OW' ? 1 : a.rec === 'UW' ? -1 : 0;
      a.tiltLabel = (TILT_LABELS[String(a.tilt)] || TILT_LABELS['0']).label;
      a.hit = null;
    });
  });
})();

// Compute current Quad from macro pillar data
function computeCurrentQuad(macroData) {
  if (!macroData || !macroData.pillars) return null;
  var pillars = macroData.pillars;

  // Growth score: Growth Analysis + Labor Market pillars
  var growthPillar = pillars.filter(function(p) { return p.name === 'Growth Analysis' || p.name === 'Labor Market'; });
  var growthScore = growthPillar.reduce(function(sum, p) {
    return sum + p.indicators.reduce(function(s, ind) { return s + (ind.score || 0); }, 0);
  }, 0);

  // Inflation score: Inflation pillar (positive = rising inflation)
  var inflPillar = pillars.find(function(p) { return p.name === 'Inflation'; });
  // In FRED scoring, positive inflation score = decelerating (good). Invert for Y axis.
  var inflScore = inflPillar ? -inflPillar.indicators.reduce(function(s, ind) { return s + (ind.score || 0); }, 0) : 0;

  // Normalize to -1..+1 range
  var maxGrowth = 8, maxInfl = 4;
  var xRaw = Math.max(-maxGrowth, Math.min(maxGrowth, growthScore));
  var yRaw = Math.max(-maxInfl, Math.min(maxInfl, inflScore));
  var x = xRaw / maxGrowth;  // positive = growth accelerating
  var y = yRaw / maxInfl;    // positive = inflation rising

  // Assign quadrant label
  var quadLabel, quadNum, quadColor;
  if (x >= 0 && y < 0)       { quadLabel = 'Goldilocks'; quadNum = 'Q1'; quadColor = '#2E7D52'; }
  else if (x >= 0 && y >= 0) { quadLabel = 'Overheat';   quadNum = 'Q2'; quadColor = '#8B6914'; }
  else if (x < 0 && y >= 0)  { quadLabel = 'Stagflation';quadNum = 'Q3'; quadColor = '#8B2A2A'; }
  else                        { quadLabel = 'Deflation';  quadNum = 'Q4'; quadColor = '#5B9BD5'; }

  // Confidence: how strongly the indicators agree (0–100%)
  var totalIndicators = pillars.reduce(function(s, p) { return s + p.indicators.length; }, 0);
  var agreedIndicators = pillars.reduce(function(s, p) {
    return s + p.indicators.filter(function(ind) { return ind.score !== 0; }).length;
  }, 0);
  var confidence = totalIndicators > 0 ? Math.round(agreedIndicators / totalIndicators * 100) : 50;

  return { quadLabel: quadLabel, quadNum: quadNum, quadColor: quadColor, x: x, y: y,
           growthScore: growthScore, inflScore: -inflScore, confidence: confidence };
}

// Chart.js instance for Quad Map
var _quadMapChart = null;

function renderQuadMap() {
  var macroData = window._lastMacroData;
  var canvasEl = document.getElementById('quadMapCanvas');
  if (!canvasEl) return;

  var qd = macroData ? computeCurrentQuad(macroData) : null;

  // Default position if no data
  var dotX = qd ? qd.x : 0;
  var dotY = qd ? -qd.y : 0; // Chart Y: up = positive; our y = inflation rising = up

  if (_quadMapChart) { try { _quadMapChart.destroy(); } catch(e){} _quadMapChart = null; }

  var quadPlugin = {
    id: 'quadBackground',
    beforeDraw: function(chart) {
      var ctx = chart.ctx;
      var xAxis = chart.scales.x;
      var yAxis = chart.scales.y;
      var midX = xAxis.getPixelForValue(0);
      var midY = yAxis.getPixelForValue(0);
      var left = chart.chartArea.left;
      var right = chart.chartArea.right;
      var top = chart.chartArea.top;
      var bottom = chart.chartArea.bottom;
      // Q2 Overheat (top-left): Growth ↑, Inflation ↑ — but on chart: x<0 top
      // Our mapping: x = growth (right=positive), y on chart = -inflation (up=inflation falling)
      // So: top-right = Goldilocks (x>0, inflFalling), top-left = Deflation (x<0, inflFalling)
      //     bottom-right = Overheat (x>0, inflRising), bottom-left = Stagflation (x<0, inflRising)
      var quads = [
        { l: left,  r: midX, t: top,    b: midY,    color: 'rgba(91,155,213,0.12)',  label: 'Deflation ❄️'    }, // top-left
        { l: midX,  r: right,t: top,    b: midY,    color: 'rgba(46,125,82,0.12)',   label: 'Goldilocks ☀️'   }, // top-right
        { l: left,  r: midX, t: midY,   b: bottom,  color: 'rgba(139,42,42,0.12)',   label: 'Stagflation ⚠️' }, // bottom-left
        { l: midX,  r: right,t: midY,   b: bottom,  color: 'rgba(139,105,20,0.12)',  label: 'Overheat 🔥'     }  // bottom-right
      ];
      quads.forEach(function(q) {
        ctx.save();
        ctx.fillStyle = q.color;
        ctx.fillRect(q.l, q.t, q.r - q.l, q.b - q.t);
        ctx.restore();
      });
      // Draw axes
      ctx.save();
      ctx.strokeStyle = 'rgba(0,60,113,0.3)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(midX, top); ctx.lineTo(midX, bottom); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(left, midY); ctx.lineTo(right, midY); ctx.stroke();
      ctx.restore();
      // Quadrant labels
      ctx.save();
      ctx.font = '11px Arial, sans-serif';
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.textAlign = 'center';
      var pad = 8;
      ctx.fillText('Deflation ❄️',    (left + midX) / 2,   top + pad + 6);
      ctx.fillText('Goldilocks ☀️',   (midX + right) / 2,  top + pad + 6);
      ctx.fillText('Stagflation ⚠️', (left + midX) / 2,   bottom - pad - 2);
      ctx.fillText('Overheat 🔥',     (midX + right) / 2,  bottom - pad - 2);
      ctx.restore();
    }
  };

  _quadMapChart = new Chart(canvasEl, {
    type: 'scatter',
    plugins: [quadPlugin],
    data: {
      datasets: [{
        label: 'Current Position',
        data: [{ x: dotX, y: -dotY }],
        pointStyle: 'circle',
        pointRadius: 14,
        pointHoverRadius: 16,
        backgroundColor: qd ? qd.quadColor : '#003C71',
        borderColor: '#fff',
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 600 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              if (!qd) return 'No data';
              return qd.quadLabel + ' (Confidence: ' + qd.confidence + '%)';
            }
          }
        }
      },
      scales: {
        x: {
          min: -1.2, max: 1.2,
          title: { display: true, text: '← Growth Decelerating | Growth Accelerating →', font: { size: 11 } },
          grid: { display: false },
          ticks: { display: false }
        },
        y: {
          min: -1.2, max: 1.2,
          title: { display: true, text: '↑ Inflation Decelerating | Inflation Accelerating ↓', font: { size: 11 } },
          grid: { display: false },
          ticks: { display: false }
        }
      }
    }
  });

  // Update narrative panel
  var body = document.getElementById('quadNarrativeBody');
  if (body && qd) {
    var pd = PLAYBOOK_DATA[qd.quadLabel] || {};
    body.innerHTML =
      '<div class="quad-badge" style="background:' + qd.quadColor + ';color:#fff;display:inline-block;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:700;margin-bottom:8px;">' +
      qd.quadNum + ' — ' + qd.quadLabel + ' ' + (pd.emoji || '') + '</div>' +
      '<div class="quad-signal-row" style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:10px;">' +
      '<div><span style="font-size:11px;color:var(--text-sec);">GROWTH</span><br><strong style="color:' + (qd.growthScore >= 0 ? '#2E7D52' : '#8B2A2A') + ';">' + (qd.growthScore >= 0 ? '↑ Accelerating' : '↓ Decelerating') + '</strong></div>' +
      '<div><span style="font-size:11px;color:var(--text-sec);">INFLATION</span><br><strong style="color:' + (qd.inflScore <= 0 ? '#2E7D52' : '#8B2A2A') + ';">' + (qd.inflScore <= 0 ? '↓ Decelerating' : '↑ Accelerating') + '</strong></div>' +
      '<div><span style="font-size:11px;color:var(--text-sec);">CONFIDENCE</span><br><strong>' + qd.confidence + '%</strong></div>' +
      '</div>' +
      '<p style="font-size:12px;color:var(--text-sec);line-height:1.5;">' + (pd.narrative || '') + '</p>';
  } else if (body) {
    body.innerHTML = '<div style="padding:16px;color:var(--text-sec);">Load macro data to see current quad position. <button class="btn btn-sm" onclick="loadMacroLiveTable(true)">Load Now</button></div>';
  }

  var summary = document.getElementById('quadPlaybookSummary');
  if (summary && qd) {
    var pd2 = PLAYBOOK_DATA[qd.quadLabel] || {};
    var topSectors = (pd2.sectors || []).filter(function(s){ return s.rec === 'OW'; }).slice(0,3);
    var h = '<div style="font-size:12px;font-weight:700;color:var(--navy);margin-bottom:6px;">Top Sectors in ' + qd.quadLabel + '</div>';
    topSectors.forEach(function(s) {
      h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">' +
           '<span style="background:#2E7D52;color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;">OW</span>' +
           '<span style="font-size:12px;font-weight:600;">' + s.name + '</span>' +
           '<span style="font-size:11px;color:var(--text-sec);">Hit: ' + s.hit + '%</span>' +
           '</div>';
    });
    h += '<div style="margin-top:10px;"><a href="javascript:navigateTo(\'playbook\')" style="font-size:12px;color:var(--blue);">See full playbook → </a></div>';
    summary.innerHTML = h;
  }
}

// ════════════════════════════════════════════════════════════════════
// ASSET PLAYBOOK PAGE
// ════════════════════════════════════════════════════════════════════

function loadPlaybook() {
  var authEl = document.getElementById('sectorMacroAuthGate');
  var panelEl = document.getElementById('sectorMacroPanel');
  var user = window._currentUser;

  if (!user) {
    if (authEl) authEl.style.display = '';
    if (panelEl) panelEl.style.display = 'none';
    return;
  }
  if (authEl) authEl.style.display = 'none';
  if (panelEl) panelEl.style.display = '';

  var macroData = window._lastMacroData;
  var qd = macroData ? computeCurrentQuad(macroData) : null;
  var quadLabel = qd ? qd.quadLabel : null;

  // Update regime banner
  var regimeBanner = document.getElementById('playbookRegimeBody');
  if (regimeBanner) {
    if (qd) {
      var pd = PLAYBOOK_DATA[qd.quadLabel] || {};
      regimeBanner.innerHTML =
        '<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">' +
        '<div style="font-size:28px;">' + (pd.emoji || '📊') + '</div>' +
        '<div><div style="font-size:16px;font-weight:800;color:' + qd.quadColor + ';">' +
        qd.quadNum + ' — ' + qd.quadLabel + '</div>' +
        '<div style="font-size:12px;color:var(--text-sec);">Growth ' + (qd.growthScore >= 0 ? '↑' : '↓') + ' · Inflation ' + (qd.inflScore <= 0 ? '↓' : '↑') + ' · Confidence: ' + qd.confidence + '%</div>' +
        '<div style="font-size:12px;margin-top:4px;">' + (pd.narrative || '') + '</div></div>' +
        '<div style="margin-left:auto;"><button class="btn btn-sm" onclick="navigateTo(\'macro\');macroShowTab(\'quadmap\')">View Quad Map →</button></div>' +
        '</div>';
    } else {
      regimeBanner.innerHTML = '<div style="color:var(--text-sec);font-size:13px;">Loading regime data… <button class="btn btn-sm" onclick="loadMacroLiveTable(true);setTimeout(loadPlaybook,800);">Refresh</button></div>';
      if (!macroData) loadMacroLiveTable();
    }
  }

  renderPlaybook(quadLabel);
  populateHitRateTable(quadLabel);
}

function playbookShowTab(name) {
  // Scope updated 2026-07-25: the alignment content moved from its own page
  // into the Manage Holdings tab strip, so the sub-tabs now live under #htab-alignment.
  _toggleTabs('#htab-alignment', 'data-pbtab', name, 'pbtab-');
  // Lazy-load RRG only when its tab is opened
  if (name === 'rrg' && !window._rrgLoaded) {
    loadRRG();
  }
}

function renderPlaybook(quadLabel) {
  var pd = PLAYBOOK_DATA[quadLabel] || PLAYBOOK_DATA['Goldilocks']; // fallback

  // Sector Grid
  var grid = document.getElementById('pbSectorGrid');
  if (grid) {
    var h = '';
    (pd.sectors || []).forEach(function(s) {
      var recClass = s.rec === 'OW' ? 'ow' : s.rec === 'UW' ? 'uw' : 'neut';
      var recColor = s.rec === 'OW' ? '#2E7D52' : s.rec === 'UW' ? '#8B2A2A' : '#8B6914';
      h += '<div class="playbook-tile ' + recClass + '">' +
           '<div class="playbook-tile-name">' + s.name + '</div>' +
           '<div class="playbook-tile-rec" style="background:' + recColor + ';color:#fff;display:inline-block;padding:2px 10px;border-radius:10px;font-size:11px;font-weight:700;">' + (s.tiltLabel || s.rec) + '</div>' +
           /* "Hit rate: X%" removed 2026-07-24 — those percentages were invented
              and contradicted the sector table. Replaced with the measured
              breadth figure where the warehouse can supply one, or nothing. */
           (function () {
             var m = typeof measuredSectorHitRate === 'function'
               ? measuredSectorHitRate(s.canonicalSector || s.name) : null;
             return m
               ? '<div class="playbook-tile-hit" style="font-size:11px;margin-top:4px;" title="' + m.basis + '">Beating benchmark: <strong>' + m.pct.toFixed(0) + '%</strong> <span style="font-size:9px;color:var(--text-sec);">(n=' + m.n + ')</span></div>'
               : '<div class="playbook-tile-hit" style="font-size:10px;margin-top:4px;color:var(--text-sec);">Directional prior</div>';
           })() +
           '<div class="playbook-tile-etfs" style="font-size:10px;color:var(--text-sec);margin-top:4px;">' + s.etfs + '</div>' +
           '</div>';
    });
    grid.innerHTML = h || '<p style="color:var(--text-sec);">No playbook data available.</p>';
  }

  // Asset Class Grid
  var agrid = document.getElementById('pbAssetGrid');
  if (agrid) {
    var ah = '';
    (pd.assets || []).forEach(function(a) {
      var recClass = a.rec === 'OW' ? 'ow' : a.rec === 'UW' ? 'uw' : 'neut';
      var recColor = a.rec === 'OW' ? '#2E7D52' : a.rec === 'UW' ? '#8B2A2A' : '#8B6914';
      ah += '<div class="playbook-tile ' + recClass + '">' +
            '<div class="playbook-tile-name">' + a.name + '</div>' +
            '<div class="playbook-tile-rec" style="background:' + recColor + ';color:#fff;display:inline-block;padding:2px 10px;border-radius:10px;font-size:11px;font-weight:700;">' + a.rec + '</div>' +
            /* Invented asset-class hit rates removed 2026-07-24 (they carried a
               "1972–2023 data" citation for numbers nothing ever computed). */
            '<div class="playbook-tile-hit" style="font-size:10px;margin-top:4px;color:var(--text-sec);">' + (a.tiltLabel || 'Directional prior') + '</div>' +
            '<div class="playbook-tile-etfs" style="font-size:11px;color:var(--text-sec);margin-top:4px;">' + a.note + '</div>' +
            '</div>';
    });
    agrid.innerHTML = ah || '<p style="color:var(--text-sec);">No playbook data available.</p>';
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   SECTOR TILT TABLE — rewritten 2026-07-24.

   Now renders across the four QUADS directly (the taxonomy the rest of the site
   uses) rather than mapping Quads onto cycle phases, which was a category error
   and the source of the 26-of-44 disagreement with the Playbook page. Shows
   ordinal tilts plus the measured breadth figure when the warehouse can supply
   one, and never a fabricated percentage.
   ════════════════════════════════════════════════════════════════════════════ */
function populateHitRateTable(activeQuadLabel) {
  var body = document.getElementById('hitRateBody');
  if (!body) return;

  var sig = window._perrySignals;
  var qd = activeQuadLabel
        || (sig && sig.regime && sig.regime.label)
        || (window._lastMacroData ? (computeCurrentQuad(window._lastMacroData) || {}).quadLabel : null);

  var quads = ['Goldilocks', 'Overheat', 'Stagflation', 'Deflation'];
  var sectors = Object.keys(SECTOR_PRIORS.Goldilocks.tilts);

  var h = '';
  sectors.forEach(function (sector) {
    var measured = measuredSectorHitRate(sector);
    h += '<tr><td style="font-weight:600;padding:7px 12px;">' + sector + '</td>';
    quads.forEach(function (q) {
      var tilt = SECTOR_PRIORS[q].tilts[sector];
      var meta = TILT_LABELS[String(tilt)] || TILT_LABELS['0'];
      var isActive = q === qd;
      h += '<td style="text-align:center;font-weight:' + (isActive ? '800' : '500') + ';'
        +  'color:' + (isActive ? meta.color : '#8A97A3') + ';'
        +  'background:' + (isActive ? 'rgba(91,155,213,0.12)' : 'transparent') + ';'
        +  '" title="' + SECTOR_PRIORS[q].rationale.replace(/"/g, '&quot;') + '">'
        +  meta.label + '</td>';
    });
    h += '<td style="text-align:center;font-size:11px;color:var(--text-sec);">'
      +  (measured
            ? '<strong>' + measured.pct.toFixed(0) + '%</strong><span style="font-size:9px;"> (n=' + measured.n + ')</span>'
            : '&mdash;')
      +  '</td>';
    h += '</tr>';
  });
  body.innerHTML = h;

  // Rewrite the header to match the new columns, if the table shell allows it.
  var head = document.getElementById('hitRateHead');
  if (head) {
    head.innerHTML = '<tr><th style="text-align:left;padding:7px 12px;">Sector</th>'
      + quads.map(function (q) {
          return '<th style="text-align:center;' + (q === qd ? 'background:rgba(91,155,213,0.18);' : '') + '">' + q + '</th>';
        }).join('')
      + '<th style="text-align:center;" title="Share of names in this sector currently beating the benchmark over the trailing 3 months. This is measured live from the warehouse — it is current breadth, not a multi-cycle historical hit rate.">Measured breadth</th></tr>';
  }

  var note = document.getElementById('hitRateNote');
  if (note) {
    note.innerHTML = '<strong>How to read this:</strong> the four Quad columns are <em>directional priors</em> '
      + 'drawn from published cycle research — deliberately ordinal (Strong OW through Strong UW) rather than '
      + 'false-precision percentages, because no multi-cycle hit rate has been measured on this dataset. '
      + 'The final column <em>is</em> measured: it is the share of names in each sector currently beating the '
      + 'benchmark over the trailing three months, with its sample size. As the warehouse accumulates history, '
      + 'measured figures will progressively replace the priors.'
      + (qd ? ' The highlighted column is the current regime (<strong>' + qd + '</strong>).' : '');
  }
}

// ════════════════════════════════════════════════════════════════════
// RRG — Relative Rotation Graph
// ════════════════════════════════════════════════════════════════════

var _rrgLoaded = false;
var _rrgChart = null;
var SECTOR_ETFS = ['XLC','XLY','XLP','XLE','XLF','XLV','XLI','XLB','XLRE','XLK','XLU'];

function loadRRG(force) {
  if (_rrgLoaded && !force) return;
  var status = document.getElementById('rrgStatus');
  var sectorList = document.getElementById('rrgSectorList');
  if (status) status.textContent = 'Fetching sector price data…';
  if (sectorList) sectorList.innerHTML = '';

  // Fetch SPY and all 11 sector ETFs in parallel — 1 YEAR of daily closes,
  // keyed by DATE so series align even when one ETF misses a session.
  var tickers = SECTOR_ETFS.concat(['SPY']);
  var fetchFns = tickers.map(function(t) {
    return fetch(WORKER_URL + '/chart?symbol=' + t + '&range=1y&interval=1d')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var byDate = {};
        if (d && d.points && d.points.length) {
          d.points.forEach(function(p) { if (p.close != null) byDate[p.date.slice(0,10)] = p.close; });
        }
        return { ticker: t, byDate: byDate, closes: Object.keys(byDate).sort().map(function(k){ return byDate[k]; }) };
      })
      .catch(function() { return { ticker: t, byDate: {}, closes: [] }; });
  });

  Promise.all(fetchFns).then(function(results) {
    var byTicker = {};
    results.forEach(function(r) { byTicker[r.ticker] = r; });
    var spy = byTicker['SPY'];
    if (!spy || spy.closes.length < 30) {
      if (status) status.textContent = 'Failed to load SPY data. Please retry.';
      return;
    }
    _rrgLoaded = true;
    var sectorData = computeRRG(byTicker, spy);
    renderRRG(sectorData);
    if (status) status.textContent = 'Updated ' + new Date().toLocaleTimeString();

    // Populate sector list
    if (sectorList) {
      var listH = '';
      sectorData.forEach(function(s) {
        var qColor = s.quadrant === 'Leading' ? '#2E7D52' : s.quadrant === 'Weakening' ? '#8B6914' : s.quadrant === 'Lagging' ? '#8B2A2A' : '#5B9BD5';
        listH += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;">' +
                 '<span style="background:' + qColor + ';color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:8px;min-width:70px;text-align:center;">' + s.quadrant + '</span>' +
                 '<span style="font-size:12px;font-weight:600;">' + s.ticker + '</span>' +
                 '<span style="font-size:11px;color:var(--text-sec);">RS: ' + s.rsRatio.toFixed(1) + ' Mom: ' + (s.rsMom >= 0 ? '+' : '') + s.rsMom.toFixed(1) + '</span>' +
                 '</div>';
      });
      sectorList.innerHTML = listH;
    }
  }).catch(function(e) {
    if (status) status.textContent = 'Error: ' + e.message;
    _rrgLoaded = false;
  });
}

function computeRRG(byTicker, spy) {
  // ── FIXED 2026-07. The previous version computed sector_price ÷ SPY_price
  // × 100 (≈37 for XLK, ≈8 for XLF — a share-price artifact, not relative
  // strength) and then required ≥100 for "strong RS". Since no sector ETF's
  // share price exceeds SPY's, EVERY sector was classified weak-RS and
  // "Leading"/"Weakening" could never occur. Correct JdK method: normalize
  // each sector's price RATIO against its own trailing average, so 100 =
  // performing in line with its own recent relative trend.
  //   RS-Ratio    = 100 × (sector/SPY ratio today) ÷ SMA₆₃(sector/SPY ratio)
  //   RS-Momentum = % change of RS-Ratio over the last 15 trading days
  var results = [];
  var spyDates = Object.keys(spy.byDate || {}).sort();
  if (spyDates.length < 80) return results;

  SECTOR_ETFS.forEach(function(ticker) {
    var d = byTicker[ticker];
    if (!d || !d.byDate) return;
    // Date-intersected ratio series (sector/SPY on common trading days)
    var ratios = [];
    spyDates.forEach(function(dt) {
      var sc = d.byDate[dt], py = spy.byDate[dt];
      if (sc != null && py != null && py > 0) ratios.push(sc / py);
    });
    if (ratios.length < 80) return;

    function sma(arr, w, idx) {
      var s = 0, cnt = 0;
      for (var j = Math.max(0, idx - w + 1); j <= idx; j++) { s += arr[j]; cnt++; }
      return cnt ? s / cnt : null;
    }
    // RS-Ratio series over the last ~40 sessions (enough for the momentum leg)
    var rsSeries = [];
    for (var i = ratios.length - 40; i < ratios.length; i++) {
      var base = sma(ratios, 63, i);
      rsSeries.push(base ? 100 * ratios[i] / base : null);
    }
    var rsNow = rsSeries[rsSeries.length - 1];
    var rsThen = rsSeries[rsSeries.length - 1 - 15] != null ? rsSeries[rsSeries.length - 1 - 15] : rsSeries[0];
    if (rsNow == null || rsThen == null || rsThen === 0) return;
    var momNow = ((rsNow / rsThen) - 1) * 100;  // % change of RS-Ratio, 0-centered

    var quadrant;
    if (rsNow >= 100 && momNow >= 0)      quadrant = 'Leading';
    else if (rsNow >= 100 && momNow < 0)  quadrant = 'Weakening';
    else if (rsNow < 100 && momNow < 0)   quadrant = 'Lagging';
    else                                  quadrant = 'Improving';

    results.push({ ticker: ticker, rsRatio: rsNow, rsMom: momNow, quadrant: quadrant });
  });
  return results;
}

function renderRRG(sectorData) {
  var canvasEl = document.getElementById('rrgChart');
  if (!canvasEl) return;
  if (_rrgChart) { try { _rrgChart.destroy(); } catch(e){} _rrgChart = null; }

  var qColors = { Leading: '#2E7D52', Weakening: '#8B6914', Lagging: '#8B2A2A', Improving: '#5B9BD5' };

  var quadPlugin = {
    id: 'rrgQuadBackground',
    beforeDraw: function(chart) {
      var ctx = chart.ctx;
      var xAxis = chart.scales.x;
      var yAxis = chart.scales.y;
      var midX = xAxis.getPixelForValue(100);
      var midY = yAxis.getPixelForValue(0);
      var left = chart.chartArea.left, right = chart.chartArea.right;
      var top = chart.chartArea.top, bottom = chart.chartArea.bottom;
      var zones = [
        { l: midX, r: right, t: top,    b: midY,    color: 'rgba(46,125,82,0.10)',   label: 'Leading'   },
        { l: midX, r: right, t: midY,   b: bottom,  color: 'rgba(139,105,20,0.10)',  label: 'Weakening' },
        { l: left,  r: midX, t: midY,   b: bottom,  color: 'rgba(139,42,42,0.10)',   label: 'Lagging'   },
        { l: left,  r: midX, t: top,    b: midY,    color: 'rgba(91,155,213,0.10)',  label: 'Improving' }
      ];
      zones.forEach(function(z) {
        ctx.save();
        ctx.fillStyle = z.color;
        ctx.fillRect(z.l, z.t, z.r - z.l, z.b - z.t);
        ctx.font = '11px Arial';
        ctx.fillStyle = 'rgba(0,0,0,0.40)';
        ctx.textAlign = 'center';
        ctx.fillText(z.label, (z.l + z.r) / 2, z.t + 14);
        ctx.restore();
      });
      ctx.save();
      ctx.strokeStyle = 'rgba(0,60,113,0.25)'; ctx.lineWidth = 1; ctx.setLineDash([4,4]);
      ctx.beginPath(); ctx.moveTo(midX, top); ctx.lineTo(midX, bottom); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(left, midY); ctx.lineTo(right, midY); ctx.stroke();
      ctx.restore();
    }
  };

  var datasets = sectorData.map(function(s) {
    return {
      label: s.ticker,
      data: [{ x: s.rsRatio, y: s.rsMom }],
      pointStyle: 'circle',
      pointRadius: 10,
      pointHoverRadius: 13,
      backgroundColor: qColors[s.quadrant] || '#003C71',
      borderColor: '#fff', borderWidth: 1.5
    };
  });

  _rrgChart = new Chart(canvasEl, {
    type: 'scatter',
    plugins: [quadPlugin],
    data: { datasets: datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              return ctx.dataset.label + ': RS ' + ctx.parsed.x.toFixed(1) + ' | Mom ' + (ctx.parsed.y >= 0 ? '+' : '') + ctx.parsed.y.toFixed(1);
            }
          }
        }
      },
      scales: {
        x: { title: { display: true, text: 'RS-Ratio (relative strength vs SPY, 100 = neutral)' }, grid: { display: false } },
        y: { title: { display: true, text: 'RS-Momentum (14-EMA minus 28-EMA)' }, grid: { display: false } }
      }
    }
  });

  // Draw ticker labels
  setTimeout(function() {
    if (!_rrgChart) return;
    var chart = _rrgChart;
    var ctx = chart.ctx;
    ctx.save();
    ctx.font = 'bold 10px Arial';
    ctx.textAlign = 'center';
    sectorData.forEach(function(s) {
      var meta = chart.getDatasetMeta(SECTOR_ETFS.indexOf(s.ticker));
      if (meta && meta.data && meta.data[0]) {
        var point = meta.data[0];
        ctx.fillStyle = '#000';
        ctx.fillText(s.ticker, point.x, point.y - 13);
      }
    });
    ctx.restore();
  }, 50);
}

// ════════════════════════════════════════════════════════════════════
// GAP ANALYSIS — Portfolio Drift vs Playbook Targets
// ════════════════════════════════════════════════════════════════════

var _gapBarChart = null;
var _gapData = null;

function loadGapAnalysis(force) {
  var authEl = document.getElementById('sectorMacroAuthGate');
  var panelEl = document.getElementById('sectorMacroPanel');
  var user = window._currentUser;

  if (!user) {
    if (authEl) authEl.style.display = '';
    if (panelEl) panelEl.style.display = 'none';
    return;
  }
  if (authEl) authEl.style.display = 'none';
  if (panelEl) panelEl.style.display = '';

  var holdings = window._holdings || [];
  var macroData = window._lastMacroData;
  var qd = macroData ? computeCurrentQuad(macroData) : null;

  // Get target weights for current quadrant
  var quadLabel = qd ? qd.quadLabel : null;
  var pd = quadLabel ? PLAYBOOK_DATA[quadLabel] : null;
  var targetSectors = {};
  if (pd) {
    pd.sectors.forEach(function(s) {
      var w = s.rec === 'OW' ? 1.3 : s.rec === 'UW' ? 0.5 : 1.0;
      targetSectors[s.name] = w;
    });
    // Normalize targets to sum to 100%
    var totalW = Object.keys(targetSectors).reduce(function(s, k) { return s + targetSectors[k]; }, 0);
    Object.keys(targetSectors).forEach(function(k) { targetSectors[k] = targetSectors[k] / totalW * 100; });
  } else {
    // Default to SPY weights
    targetSectors = Object.assign({}, SPY_SECTOR_WEIGHTS);
  }

  // Compute current sector weights from holdings
  var isCash = function(h) { return ['Cash','Money Market','CD','Bond Position'].includes(h.assetClass); };
  var equityHoldings = holdings.filter(function(h) { return !isCash(h) && h.currentPrice; });
  var totalMV = equityHoldings.reduce(function(sum, h) { return sum + (h.currentPrice * h.quantity); }, 0);

  var currentSectors = {};
  equityHoldings.forEach(function(h) {
    var sec = h.sector || 'Other';
    var mv = h.currentPrice * h.quantity;
    currentSectors[sec] = (currentSectors[sec] || 0) + mv;
  });
  // Convert to percentages
  if (totalMV > 0) {
    Object.keys(currentSectors).forEach(function(k) { currentSectors[k] = currentSectors[k] / totalMV * 100; });
  }

  // Build gap rows — union of all sectors in target or current
  var allSectors = {};
  Object.keys(targetSectors).forEach(function(k) { allSectors[k] = true; });
  Object.keys(currentSectors).forEach(function(k) { allSectors[k] = true; });

  var rows = Object.keys(allSectors).map(function(sec) {
    var cur = currentSectors[sec] || 0;
    var tgt = targetSectors[sec] || 0;
    return { sector: sec, current: cur, target: tgt, gap: cur - tgt };
  }).sort(function(a, b) { return Math.abs(b.gap) - Math.abs(a.gap); });

  // Drift calculation: Σ|actual-target|/2
  var drift = rows.reduce(function(sum, r) { return sum + Math.abs(r.gap); }, 0) / 2;

  _gapData = { rows: rows, drift: drift, quadLabel: quadLabel, qd: qd, totalMV: totalMV, holdings: holdings.length };

  // Update KPIs
  var kpiDrift = document.getElementById('gapDriftVal');
  var kpiRegime = document.getElementById('gapRegimeVal');
  var kpiLargest = document.getElementById('gapLargestVal');
  var kpiPositions = document.getElementById('gapPositionsVal');
  if (kpiDrift) kpiDrift.textContent = drift.toFixed(1) + '%';
  if (kpiRegime) kpiRegime.textContent = quadLabel ? (qd.quadNum + ' ' + quadLabel) : '—';
  var largestGap = rows[0];
  if (kpiLargest) kpiLargest.textContent = largestGap ? largestGap.sector.split(' ')[0] + ' (' + (largestGap.gap >= 0 ? '+' : '') + largestGap.gap.toFixed(1) + '%)' : '—';
  if (kpiPositions) kpiPositions.textContent = equityHoldings.length;

  // Drift banner
  var banner = document.getElementById('gapDriftBanner');
  if (banner) {
    var needsRebal = drift > 3;
    banner.style.background = needsRebal ? 'rgba(139,42,42,0.08)' : 'rgba(46,125,82,0.08)';
    banner.style.border = '1px solid ' + (needsRebal ? 'rgba(139,42,42,0.3)' : 'rgba(46,125,82,0.3)');
    banner.innerHTML = '<strong style="color:' + (needsRebal ? '#8B2A2A' : '#2E7D52') + ';">' +
      (needsRebal ? '⚠️ Rebalance Needed' : '✅ Within Tolerance') + '</strong> — Portfolio drift is ' +
      drift.toFixed(1) + '% vs. ' + (quadLabel || 'SPY') + ' targets. Betterment-style threshold: 3%. ' +
      (needsRebal ? '<a href="javascript:navigateTo(\'holdings\');holdingsShowTab(\'rebalance\')" style="color:var(--blue);">Go to Rebalancer →</a>' : 'No action required.');
  }

  // Render bar chart
  renderGapChart(rows);

  // Render detail table — visual current-vs-target bars + dollar impact so
  // the row reads as a sentence: "you're X, playbook says Y, move $Z".
  var tbody = document.getElementById('gapDetailBody');
  if (tbody) {
    var maxPct = Math.max(8, Math.max.apply(null, rows.map(function(r){ return Math.max(r.current, r.target); })));
    var h = '';
    rows.forEach(function(r) {
      // OVERWEIGHT (gap>0) = trim = red action; UNDERWEIGHT = add = green
      var gc = Math.abs(r.gap) < 1 ? '#5A6A7A' : (r.gap > 0 ? '#8B2A2A' : '#2E7D52');
      var action = Math.abs(r.gap) < 1 ? '— in line' : (r.gap > 0 ? '▼ Trim' : '▲ Add');
      var gapDollars = totalMV > 0 ? Math.abs(r.gap) / 100 * totalMV : null;
      var curW = Math.min(100, r.current / maxPct * 100), tgtW = Math.min(100, r.target / maxPct * 100);
      var bar = '<div style="position:relative;height:16px;background:var(--panel);border-radius:3px;overflow:hidden;min-width:120px;" title="Blue bar = current weight, dark marker = playbook target">'
        + '<div style="position:absolute;left:0;top:2px;bottom:2px;width:' + curW + '%;background:rgba(91,155,213,0.55);border-radius:2px;"></div>'
        + '<div style="position:absolute;left:' + tgtW + '%;top:0;bottom:0;width:2.5px;background:var(--navy);"></div>'
        + '</div>';
      h += '<tr>' +
           '<td style="font-weight:600;padding:7px 12px;">' + r.sector + '</td>' +
           '<td style="padding:7px 12px;">' + bar + '</td>' +
           '<td style="text-align:right;padding:7px 12px;">' + r.current.toFixed(1) + '%</td>' +
           '<td style="text-align:right;padding:7px 12px;color:var(--text-sec);">' + r.target.toFixed(1) + '%</td>' +
           '<td style="text-align:right;padding:7px 12px;font-weight:700;color:' + gc + ';">' + (r.gap >= 0 ? '+' : '') + r.gap.toFixed(1) + '%</td>' +
           '<td style="text-align:right;padding:7px 12px;color:' + gc + ';">' + (gapDollars != null && Math.abs(r.gap) >= 1 ? '$' + Math.round(gapDollars).toLocaleString() : '—') + '</td>' +
           '<td style="text-align:center;padding:7px 12px;font-weight:600;color:' + gc + ';white-space:nowrap;">' + action + '</td>' +
           '</tr>';
    });
    tbody.innerHTML = h || '<tr><td colspan="7" style="text-align:center;color:var(--text-sec);padding:16px;">Add holdings to see gap analysis.</td></tr>';
  }

  // ── Rebalancing Actions card (was stuck on a permanent spinner — never
  //    populated). Now: shows concrete trades ONLY when drift exceeds the
  //    3% tolerance band; otherwise states clearly that no action is needed. ──
  var rebEl = document.getElementById('gapRebalanceSuggestions');
  if (rebEl) {
    var needsRebal2 = drift > 3;
    if (!equityHoldings.length) {
      rebEl.innerHTML = '<div style="color:var(--text-sec);padding:6px;">Add holdings to generate rebalancing actions.</div>';
    } else if (!needsRebal2) {
      rebEl.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:6px;">'
        + '<span style="font-size:22px;">✅</span>'
        + '<div><strong style="color:var(--success);">No rebalancing required.</strong> '
        + '<span style="color:var(--text-sec);">Portfolio drift is ' + drift.toFixed(1) + '% — inside the ±3% institutional tolerance band vs. the ' + (quadLabel || 'SPY') + ' playbook targets. Rebalancing now would only generate trading costs and taxable events. Recheck after the next regime change or quarterly.</span></div></div>';
    } else {
      var actions = rows.filter(function(r){ return Math.abs(r.gap) >= 1.5; }).slice(0, 6);
      var items = actions.map(function(r) {
        var dollars = totalMV > 0 ? Math.abs(r.gap) / 100 * totalMV : 0;
        var isTrim = r.gap > 0;
        return '<div style="display:flex;align-items:center;gap:10px;padding:7px 10px;border:1px solid var(--border);border-radius:5px;margin-bottom:6px;background:' + (isTrim ? 'rgba(139,42,42,0.05)' : 'rgba(46,125,82,0.05)') + ';">'
          + '<span style="font-weight:800;color:' + (isTrim ? 'var(--danger)' : 'var(--success)') + ';min-width:52px;">' + (isTrim ? '▼ TRIM' : '▲ ADD') + '</span>'
          + '<span style="font-weight:600;min-width:150px;">' + r.sector + '</span>'
          + '<span style="color:var(--text-sec);">' + r.current.toFixed(1) + '% → ' + r.target.toFixed(1) + '%</span>'
          + '<span style="margin-left:auto;font-weight:700;color:' + (isTrim ? 'var(--danger)' : 'var(--success)') + ';">' + (isTrim ? '−' : '+') + '$' + Math.round(dollars).toLocaleString() + '</span>'
          + '</div>';
      }).join('');
      rebEl.innerHTML = '<div style="margin-bottom:8px;color:var(--text-sec);">Drift of <strong style="color:var(--danger);">' + drift.toFixed(1) + '%</strong> exceeds the 3% band. Closing the largest gaps vs. the <strong>' + (quadLabel || 'SPY') + '</strong> playbook:</div>'
        + items
        + '<div style="font-size:11px;color:var(--text-sec);margin-top:8px;">Dollar amounts = gap × portfolio equity value ($' + Math.round(totalMV).toLocaleString() + '). Use the Rebalancer for a per-ticker trade blotter with your risk-profile constraints applied.</div>';
    }
  }

  // Show no-holdings message if needed
  if (!equityHoldings.length) {
    if (panelEl) panelEl.innerHTML += '';
    var empty = document.getElementById('gapEmptyMsg');
    if (!empty && panelEl) {
      var msg = document.createElement('div');
      msg.id = 'gapEmptyMsg';
      msg.style.cssText = 'padding:24px;text-align:center;color:var(--text-sec);';
      msg.innerHTML = 'No equity holdings found. <a href="javascript:navigateTo(\'holdings\');holdingsShowTab(\'import\')">Add holdings →</a>';
      panelEl.prepend(msg);
    }
  }
}

function renderGapChart(rows) {
  var canvasEl = document.getElementById('gapBarChart');
  if (!canvasEl) return;
  if (_gapBarChart) { try { _gapBarChart.destroy(); } catch(e){} _gapBarChart = null; }

  var top12 = rows.slice(0, 12);
  var labels = top12.map(function(r) { return r.sector.length > 16 ? r.sector.substring(0, 14) + '…' : r.sector; });
  var data = top12.map(function(r) { return +r.gap.toFixed(2); });
  var colors = data.map(function(v) { return v >= 0 ? 'rgba(46,125,82,0.75)' : 'rgba(139,42,42,0.75)'; });

  _gapBarChart = new Chart(canvasEl, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Gap (Current − Target)',
        data: data,
        backgroundColor: colors,
        borderRadius: 3
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              var v = ctx.raw;
              return (v >= 0 ? 'Overweight +' : 'Underweight ') + Math.abs(v).toFixed(1) + '%';
            }
          }
        }
      },
      scales: {
        x: {
          title: { display: true, text: 'Gap vs. Target (%)' },
          grid: { color: 'rgba(0,0,0,0.06)' },
          ticks: { callback: function(v) { return (v >= 0 ? '+' : '') + v + '%'; } }
        },
        y: { grid: { display: false } }
      }
    }
  });
}

function gapExportCSV() {
  if (!_gapData || !_gapData.rows || !_gapData.rows.length) {
    alert('No gap data to export. Please refresh.');
    return;
  }
  var lines = ['Sector,Current %,Target %,Gap %,Action'];
  _gapData.rows.forEach(function(r) {
    var action = Math.abs(r.gap) < 1 ? 'Hold' : r.gap > 0 ? 'Trim' : 'Add';
    lines.push([
      '"' + r.sector + '"',
      r.current.toFixed(2),
      r.target.toFixed(2),
      (r.gap >= 0 ? '+' : '') + r.gap.toFixed(2),
      action
    ].join(','));
  });
  lines.push('"Portfolio Drift",' + _gapData.drift.toFixed(2) + ',,,"' + (_gapData.quadLabel || 'SPY') + ' Targets"');

  var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'gap-analysis-' + new Date().toISOString().slice(0,10) + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}


// ═══════════════════════════════════════════════════════════════════
// CONSOLIDATED TAB VIEWS (2026-07) — Performance, Attribution and Risk
// were long vertical scrolls of stacked cards. Each tab's cards are now
// panels inside ONE card with a toggle bar (same pattern as the
// Account-by-Account Comparison). Nothing is removed: every chart,
// table and renderer keeps its original element id and logic — panels
// are just shown/hidden, and Chart.js auto-resizes on reveal.
// ═══════════════════════