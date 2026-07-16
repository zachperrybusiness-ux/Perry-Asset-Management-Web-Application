
// ═══ CONSTANTS ═══
const WORKER_URL = "https://perry-finance-proxy.zachperrybusiness.workers.dev";
const C = {
  navy: "#003C71", blue: "#5B9BD5", blueLight: "#A8C8E8",
  bg: "#FFFFFF", panel: "#F4F6F9", border: "#D0D7E0",
  text: "#000000", textOnDark: "#FFFFFF", textSec: "#5A6A7A",
  success: "#2E7D52", warning: "#8B6914", danger: "#8B2A2A",
  highlightGray: "#C8D0D8"
};
const PALETTE = [C.navy, C.blue, C.blueLight, C.success, C.warning, C.danger, C.highlightGray, "#6A4C93", "#3A7CA5", "#D4A373"];

// Mobile helpers — honors BOTH a narrow window AND the explicit
// "Mobile" view toggle (body.view-mobile). Previously only width was
// checked, so toggling Mobile on a desktop kept desktop chart styling.
function isMobile() { return document.body.classList.contains('view-mobile') || window.innerWidth < 768; }
function legendPos() { return isMobile() ? 'bottom' : 'top'; }
function chartFontSize() { return isMobile() ? 9 : 11; }
// Apply Chart.js global defaults for the current view (called on toggle)
function applyChartViewDefaults() {
  try {
    if (typeof Chart === 'undefined') return;
    var m = isMobile();
    Chart.defaults.font.size = m ? 10 : 12;
    if (Chart.defaults.plugins && Chart.defaults.plugins.legend) {
      Chart.defaults.plugins.legend.position = legendPos();
      if (Chart.defaults.plugins.legend.labels) Chart.defaults.plugins.legend.labels.boxWidth = m ? 10 : 40;
    }
  } catch(e) {}
}

// Chart.js defaults — wrapped in guard in case CDN load is slow or partial
try {
  Chart.defaults.font.family = 'Arial, Helvetica, sans-serif';
  Chart.defaults.color = C.textSec;
  if (Chart.defaults.plugins && Chart.defaults.plugins.legend) {
    Chart.defaults.plugins.legend.position = legendPos();
  }
} catch(e) { console.warn('Chart.js defaults not ready:', e); }
window.addEventListener('resize', function() {
  try {
    if (typeof Chart !== 'undefined' && Chart.defaults.plugins && Chart.defaults.plugins.legend) {
      Chart.defaults.plugins.legend.position = legendPos();
    }
  } catch(e) {}
});
const chartTooltip = {
  backgroundColor: C.bg, titleColor: C.text, bodyColor: C.text,
  borderColor: C.border, borderWidth: 1,
  titleFont: { family: 'Arial', size: 12, weight: '600' },
  bodyFont: { family: 'Arial', size: 12 },
  padding: 10
};
const chartGrid = { color: 'rgba(208,215,224,0.5)', drawBorder: false };
const chartTicks = { font: { family: 'Arial', size: 11 }, color: C.textSec };

// ═══ WORKER HEALTH CHECK ═══
(async () => {
  try {
    const r = await fetch(WORKER_URL + "/health");
    const d = await r.json();
    if (d.status === "ok") {
      document.getElementById("worker-status-dot").classList.replace("red", "green");
      document.getElementById("worker-status-text").textContent = "Data Proxy: Connected";
    }
  } catch(e) {}
})();

// ═══ WORKER FETCH HELPERS ═══
// Extract current price from a quote response, accepting either `.current` or `.price` field name
function getQuotePrice(q) {
  if (!q) return null;
  if (typeof q.current === 'number' && q.current > 0) return q.current;
  if (typeof q.price === 'number' && q.price > 0) return q.price;
  return null;
}
function getQuotePrev(q) {
  if (!q) return null;
  if (typeof q.previousClose === 'number' && q.previousClose > 0) return q.previousClose;
  return null;
}
function getQuoteName(q) {
  if (!q) return null;
  return q.name || q.shortName || q.longName || null;
}
async function fetchQuote(t) {
  const r = await fetch(WORKER_URL + "/quote?symbol=" + encodeURIComponent(t));
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
}
async function fetchChart(t, range, interval) {
  // Yahoo Finance accepts: 1d, 5d, 1mo, 3mo, 6mo, ytd, 1y, 2y, 5y, 10y, max
  // Normalize unsupported ranges (e.g. 15y, 20y) to max
  var r2 = range;
  if (range === '15y' || range === '20y' || range === '30y') r2 = 'max';
  const r = await fetch(WORKER_URL + "/chart?symbol=" + encodeURIComponent(t) + "&range=" + r2 + "&interval=" + (interval || "1d"));
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  // If requested 15y/20y, truncate to that window client-side
  if (range !== r2 && d.points && d.points.length) {
    var yrs = parseInt(range, 10);
    if (yrs > 0) {
      var cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - yrs);
      var cutoffStr = cutoff.toISOString().slice(0,10);
      d.points = d.points.filter(function(p){ return p.date.slice(0,10) >= cutoffStr; });
    }
  }
  return d;
}
async function fetchSearch(q) {
  const r = await fetch(WORKER_URL + "/search?q=" + encodeURIComponent(q));
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
}
window.fetchQuote = fetchQuote;

// ═══════════════════════════════════════════════════════════════════
// PERRY DATA LAYER — unified per-ticker market data access.
// Flow per symbol: in-memory → Firestore price_history cache (24h TTL)
// → Cloudflare worker (Yahoo, full 'max' daily history) → written back
// to Firestore. Every consumer (stress test, performance, quant) reads
// the SAME series, so a symbol is fetched once and referenced everywhere.
// ═══════════════════════════════════════════════════════════════════
window.PerryData = {
  _mem: {},
  _pending: {},
  // Full daily history: { dates: ['YYYY-MM-DD',...], closes: [Number,...] }
  getHistory: function(ticker) {
    var self = this;
    var t = String(ticker || '').toUpperCase();
    if (!t) return Promise.reject(new Error('No ticker'));
    if (self._mem[t]) return Promise.resolve(self._mem[t]);
    if (self._pending[t]) return self._pending[t];
    self._pending[t] = (async function() {
      // 1) Firestore cache (available when signed in)
      try {
        if (window._getHistCache) {
          var cached = await window._getHistCache(t);
          if (cached && cached.d && cached.d.length > 30) {
            var hc = { dates: cached.d, closes: cached.c, source: 'firestore' };
            self._mem[t] = hc;
            return hc;
          }
        }
      } catch(e) {}
      // 2) Worker fetch with one retry (Yahoo can rate-limit bursts)
      var d = null, lastErr = null;
      for (var attempt = 0; attempt < 2 && !d; attempt++) {
        try { d = await fetchChart(t, 'max', '1d'); }
        catch(e) { lastErr = e; await new Promise(function(r){ setTimeout(r, 800 + Math.random()*600); }); }
      }
      if (!d || !d.points || !d.points.length) throw (lastErr || new Error('No history for ' + t));
      var dates = [], closes = [];
      d.points.forEach(function(p) {
        if (p.close != null) { dates.push(p.date.slice(0, 10)); closes.push(p.close); }
      });
      var h = { dates: dates, closes: closes, source: 'worker' };
      self._mem[t] = h;
      // 3) Persist to Firestore in background (non-blocking)
      try { if (window._setHistCache) window._setHistCache(t, dates, closes); } catch(e) {}
      return h;
    })();
    return self._pending[t].finally(function(){ delete self._pending[t]; });
  },
  // Fetch many with limited concurrency. Returns { TICKER: hist|null }.
  getMany: async function(tickers, concurrency) {
    var self = this;
    var uniq = []; var seen = {};
    (tickers || []).forEach(function(t) { t = String(t||'').toUpperCase(); if (t && !seen[t]) { seen[t] = 1; uniq.push(t); } });
    var out = {}; var idx = 0; var conc = concurrency || 3;
    async function next() {
      while (idx < uniq.length) {
        var t = uniq[idx++];
        try { out[t] = await self.getHistory(t); }
        catch(e) { out[t] = null; }
      }
    }
    var workers = []; for (var i = 0; i < conc; i++) workers.push(next());
    await Promise.all(workers);
    return out;
  },
  // Does the series cover [start, end]? First data point must be within
  // `tolDays` (default 10) calendar days after `start`.
  covers: function(hist, start, end, tolDays) {
    if (!hist || !hist.dates || !hist.dates.length) return false;
    var tol = tolDays == null ? 10 : tolDays;
    var s = new Date(start); s.setDate(s.getDate() + tol);
    var firstOk = hist.dates[0] <= s.toISOString().slice(0, 10);
    var lastOk = hist.dates[hist.dates.length - 1] >= end || hist.dates[hist.dates.length - 1] >= start;
    return firstOk && lastOk;
  },
  // Total return over [start, end] using actual closes. Null if not covered.
  windowReturn: function(hist, start, end) {
    if (!this.covers(hist, start, end)) return null;
    var startPx = null, endPx = null;
    for (var i = 0; i < hist.dates.length; i++) {
      var dt = hist.dates[i];
      if (startPx == null && dt >= start) startPx = hist.closes[i];
      if (dt <= end) endPx = hist.closes[i];
      if (dt > end) break;
    }
    if (startPx == null || endPx == null || startPx <= 0) return null;
    return (endPx - startPx) / startPx;
  },
  // Array of daily simple returns strictly inside [start, end].
  windowDailyReturns: function(hist, start, end) {
    if (!hist || !hist.dates) return [];
    var rets = [];
    var prev = null;
    for (var i = 0; i < hist.dates.length; i++) {
      var dt = hist.dates[i];
      if (dt < start) { prev = hist.closes[i]; continue; }
      if (dt > end) break;
      if (prev != null && prev > 0) rets.push(hist.closes[i] / prev - 1);
      prev = hist.closes[i];
    }
    return rets;
  },
  // Leveraged product path simulation: compound lev × base daily returns,
  // net of the fund's expense drag (default 0.95%/yr, the standard for 3x
  // products). This is how TQQQ/FNGU actually work — daily reset — so a
  // -28% index window does NOT mean -84%; path matters.
  leveragedWindowReturn: function(baseHist, start, end, lev, annualExpense) {
    var rets = this.windowDailyReturns(baseHist, start, end);
    if (!rets.length) return null;
    var dailyDrag = (annualExpense == null ? 0.0095 : annualExpense) / 252;
    var equity = 1;
    for (var i = 0; i < rets.length; i++) {
      equity *= (1 + lev * rets[i] - dailyDrag);
      if (equity <= 0) return -1; // fund wiped out (circuit-breaker approximation)
    }
    return equity - 1;
  }
};

// ═══ CLASSIFICATION DATABASES ═══
const ETF_DB = {
  SPY:{s:"Broad Market",i:"S&P 500 Index",f:"Large Cap Blend",a:"ETF"},
  VOO:{s:"Broad Market",i:"S&P 500 Index",f:"Large Cap Blend",a:"ETF"},
  IVV:{s:"Broad Market",i:"S&P 500 Index",f:"Large Cap Blend",a:"ETF"},
  VTI:{s:"Broad Market",i:"Total US Market",f:"All Cap Blend",a:"ETF"},
  ITOT:{s:"Broad Market",i:"Total US Market",f:"All Cap Blend",a:"ETF"},
  DIA:{s:"Broad Market",i:"Dow Jones Industrial",f:"Large Cap Value",a:"ETF"},
  RSP:{s:"Broad Market",i:"S&P 500 Equal Weight",f:"Large Cap Blend",a:"ETF"},
  IWM:{s:"Broad Market",i:"Russell 2000 Small Cap",f:"Small Cap Blend",a:"ETF"},
  IWN:{s:"Broad Market",i:"Russell 2000 Value",f:"Small Cap Value",a:"ETF"},
  IWO:{s:"Broad Market",i:"Russell 2000 Growth",f:"Small Cap Growth",a:"ETF"},
  MDY:{s:"Broad Market",i:"S&P MidCap 400",f:"Mid Cap Blend",a:"ETF"},
  VO:{s:"Broad Market",i:"Mid Cap Index",f:"Mid Cap Blend",a:"ETF"},
  VIG:{s:"Broad Market",i:"Dividend Appreciation",f:"Large Cap Blend",a:"ETF"},
  VYM:{s:"Broad Market",i:"High Dividend Yield",f:"Large Cap Value",a:"ETF"},
  SCHD:{s:"Broad Market",i:"Dividend Equity",f:"Large Cap Value",a:"ETF"},
  VUG:{s:"Broad Market",i:"Growth Index",f:"Large Cap Growth",a:"ETF"},
  VTV:{s:"Broad Market",i:"Value Index",f:"Large Cap Value",a:"ETF"},
  IWF:{s:"Broad Market",i:"Russell 1000 Growth",f:"Large Cap Growth",a:"ETF"},
  IWD:{s:"Broad Market",i:"Russell 1000 Value",f:"Large Cap Value",a:"ETF"},
  QQQ:{s:"Information Technology",i:"Nasdaq-100 Index",f:"Large Cap Growth",a:"ETF"},
  QQQM:{s:"Information Technology",i:"Nasdaq-100 Index",f:"Large Cap Growth",a:"ETF"},
  XLK:{s:"Information Technology",i:"Technology Select SPDR",f:"Large Cap Growth",a:"ETF"},
  VGT:{s:"Information Technology",i:"Information Technology",f:"Large Cap Growth",a:"ETF"},
  SMH:{s:"Information Technology",i:"Semiconductors",f:"Large Cap Growth",a:"ETF"},
  SOXX:{s:"Information Technology",i:"Semiconductors",f:"Large Cap Growth",a:"ETF"},
  IGV:{s:"Information Technology",i:"Software",f:"Large Cap Growth",a:"ETF"},
  ARKK:{s:"Information Technology",i:"Disruptive Innovation",f:"Mid Cap Growth",a:"ETF"},
  ARKW:{s:"Information Technology",i:"Next Gen Internet",f:"Mid Cap Growth",a:"ETF"},
  ARKG:{s:"Healthcare",i:"Genomic Revolution",f:"Mid Cap Growth",a:"ETF"},
  HACK:{s:"Information Technology",i:"Cybersecurity",f:"Mid Cap Growth",a:"ETF"},
  CIBR:{s:"Information Technology",i:"Cybersecurity",f:"Mid Cap Growth",a:"ETF"},
  TQQQ:{s:"Information Technology",i:"Nasdaq-100 (3x Leveraged)",f:"Large Cap Growth",a:"Leveraged ETF",lev:"3x Long QQQ"},
  SQQQ:{s:"Information Technology",i:"Nasdaq-100 (3x Inverse)",f:"Large Cap Growth",a:"Leveraged ETF",lev:"3x Short QQQ"},
  SOXL:{s:"Information Technology",i:"Semiconductors (3x Leveraged)",f:"Large Cap Growth",a:"Leveraged ETF",lev:"3x Long SOXX"},
  SOXS:{s:"Information Technology",i:"Semiconductors (3x Inverse)",f:"Large Cap Growth",a:"Leveraged ETF",lev:"3x Short SOXX"},
  UPRO:{s:"Broad Market",i:"S&P 500 (3x Leveraged)",f:"Large Cap Blend",a:"Leveraged ETF",lev:"3x Long SPY"},
  SPXU:{s:"Broad Market",i:"S&P 500 (3x Inverse)",f:"Large Cap Blend",a:"Leveraged ETF",lev:"3x Short SPY"},
  TNA:{s:"Broad Market",i:"Russell 2000 (3x Leveraged)",f:"Small Cap Blend",a:"Leveraged ETF",lev:"3x Long IWM"},
  LABU:{s:"Healthcare",i:"Biotech (3x Leveraged)",f:"Mid Cap Growth",a:"Leveraged ETF",lev:"3x Long XBI"},
  FNGU:{s:"Information Technology",i:"FANG+ (3x Leveraged)",f:"Large Cap Growth",a:"Leveraged ETF",lev:"3x Long FANG+"},
  TMF:{s:"Fixed Income",i:"20+ Year Treasury (3x)",f:"Long Duration Bond",a:"Leveraged ETF",lev:"3x Long TLT"},
  XLF:{s:"Financials",i:"Financial Select SPDR",f:"Large Cap Value",a:"ETF"},
  XLE:{s:"Energy",i:"Energy Select SPDR",f:"Large Cap Value",a:"ETF"},
  XLV:{s:"Healthcare",i:"Health Care Select SPDR",f:"Large Cap Blend",a:"ETF"},
  XLI:{s:"Industrials",i:"Industrial Select SPDR",f:"Large Cap Blend",a:"ETF"},
  XLP:{s:"Consumer Staples",i:"Consumer Staples SPDR",f:"Large Cap Value",a:"ETF"},
  XLY:{s:"Consumer Discretionary",i:"Consumer Disc SPDR",f:"Large Cap Growth",a:"ETF"},
  XLU:{s:"Utilities",i:"Utilities Select SPDR",f:"Large Cap Value",a:"ETF"},
  XLB:{s:"Materials",i:"Materials Select SPDR",f:"Large Cap Blend",a:"ETF"},
  XLRE:{s:"Real Estate",i:"Real Estate Select SPDR",f:"Large Cap Blend",a:"ETF"},
  XLC:{s:"Communication Services",i:"Comm Services SPDR",f:"Large Cap Growth",a:"ETF"},
  BND:{s:"Fixed Income",i:"US Aggregate Bond",f:"Intermediate Bond",a:"Bond ETF"},
  AGG:{s:"Fixed Income",i:"US Aggregate Bond",f:"Intermediate Bond",a:"Bond ETF"},
  TLT:{s:"Fixed Income",i:"20+ Year Treasury",f:"Long Duration Bond",a:"Bond ETF"},
  IEF:{s:"Fixed Income",i:"7-10 Year Treasury",f:"Intermediate Bond",a:"Bond ETF"},
  SHY:{s:"Fixed Income",i:"1-3 Year Treasury",f:"Short Duration Bond",a:"Bond ETF"},
  LQD:{s:"Fixed Income",i:"Investment Grade Corp",f:"IG Bond",a:"Bond ETF"},
  HYG:{s:"Fixed Income",i:"High Yield Corp",f:"HY Bond",a:"Bond ETF"},
  JNK:{s:"Fixed Income",i:"High Yield Corp",f:"HY Bond",a:"Bond ETF"},
  TIP:{s:"Fixed Income",i:"TIPS",f:"TIPS",a:"Bond ETF"},
  EMB:{s:"Fixed Income",i:"EM USD Bond",f:"EM Bond",a:"Bond ETF"},
  GLD:{s:"Commodities",i:"Gold",f:"Precious Metals",a:"Commodity ETF"},
  IAU:{s:"Commodities",i:"Gold",f:"Precious Metals",a:"Commodity ETF"},
  SLV:{s:"Commodities",i:"Silver",f:"Precious Metals",a:"Commodity ETF"},
  GDX:{s:"Commodities",i:"Gold Miners",f:"Mid Cap Value",a:"ETF"},
  GDXJ:{s:"Commodities",i:"Junior Gold Miners",f:"Small Cap Value",a:"ETF"},
  USO:{s:"Commodities",i:"Crude Oil",f:"Energy Commodity",a:"Commodity ETF"},
  UNG:{s:"Commodities",i:"Natural Gas",f:"Energy Commodity",a:"Commodity ETF"},
  DBC:{s:"Commodities",i:"Commodity Index",f:"Diversified Commodity",a:"Commodity ETF"},
  COPX:{s:"Commodities",i:"Copper Miners",f:"Mid Cap Value",a:"ETF"},
  UUP:{s:"Currency",i:"US Dollar Index",f:"Currency",a:"Currency ETF"},
  FXE:{s:"Currency",i:"Euro",f:"Currency",a:"Currency ETF"},
  VNQ:{s:"Real Estate",i:"US REITs",f:"Large Cap Blend",a:"REIT ETF"},
  IYR:{s:"Real Estate",i:"US Real Estate",f:"Large Cap Blend",a:"REIT ETF"},
  EEM:{s:"International",i:"Emerging Markets",f:"Large Cap Blend",a:"ETF"},
  VWO:{s:"International",i:"Emerging Markets",f:"Large Cap Blend",a:"ETF"},
  EFA:{s:"International",i:"Developed Markets ex-US",f:"Large Cap Blend",a:"ETF"},
  VXUS:{s:"International",i:"International ex-US",f:"All Cap Blend",a:"ETF"},
  FXI:{s:"International",i:"China Large Cap",f:"Large Cap Blend",a:"ETF"},
  KWEB:{s:"International",i:"China Internet",f:"Large Cap Growth",a:"ETF"},
  INDA:{s:"International",i:"India",f:"Large Cap Blend",a:"ETF"},
  IBIT:{s:"Digital Assets",i:"Bitcoin",f:"Crypto",a:"Crypto ETF"},
  FBTC:{s:"Digital Assets",i:"Bitcoin",f:"Crypto",a:"Crypto ETF"},
  GBTC:{s:"Digital Assets",i:"Bitcoin Trust",f:"Crypto",a:"Crypto ETF"},
  ETHE:{s:"Digital Assets",i:"Ethereum Trust",f:"Crypto",a:"Crypto ETF"},
  BITO:{s:"Digital Assets",i:"Bitcoin Futures",f:"Crypto",a:"Crypto ETF"},
  XBI:{s:"Healthcare",i:"Biotech",f:"Mid Cap Growth",a:"ETF"},
  IBB:{s:"Healthcare",i:"Biotech",f:"Large Cap Growth",a:"ETF"},
  JETS:{s:"Industrials",i:"Airlines",f:"Mid Cap Blend",a:"ETF"},
  ITA:{s:"Industrials",i:"Aerospace & Defense",f:"Large Cap Blend",a:"ETF"},
  KRE:{s:"Financials",i:"Regional Banks",f:"Mid Cap Value",a:"ETF"},
  ITB:{s:"Consumer Discretionary",i:"Homebuilders",f:"Mid Cap Growth",a:"ETF"},
  ICLN:{s:"Utilities",i:"Clean Energy",f:"Mid Cap Growth",a:"ETF"},
  TAN:{s:"Utilities",i:"Solar Energy",f:"Mid Cap Growth",a:"ETF"},
  LIT:{s:"Materials",i:"Lithium & Battery",f:"Mid Cap Growth",a:"ETF"},
  REMX:{s:"Materials",i:"Rare Earth Metals",f:"Small Cap Value",a:"ETF"}
};

const STOCK_DB = {
  AAPL:{s:"Information Technology",i:"Consumer Electronics",mc:"Mega Cap"},
  MSFT:{s:"Information Technology",i:"Software",mc:"Mega Cap"},
  GOOGL:{s:"Communication Services",i:"Internet Services",mc:"Mega Cap"},
  GOOG:{s:"Communication Services",i:"Internet Services",mc:"Mega Cap"},
  META:{s:"Communication Services",i:"Social Media",mc:"Mega Cap"},
  NVDA:{s:"Information Technology",i:"Semiconductors",mc:"Mega Cap"},
  AVGO:{s:"Information Technology",i:"Semiconductors",mc:"Mega Cap"},
  ORCL:{s:"Information Technology",i:"Enterprise Software",mc:"Mega Cap"},
  CRM:{s:"Information Technology",i:"Enterprise Software",mc:"Large Cap"},
  ADBE:{s:"Information Technology",i:"Software",mc:"Large Cap"},
  AMD:{s:"Information Technology",i:"Semiconductors",mc:"Large Cap"},
  INTC:{s:"Information Technology",i:"Semiconductors",mc:"Large Cap"},
  QCOM:{s:"Information Technology",i:"Semiconductors",mc:"Large Cap"},
  TXN:{s:"Information Technology",i:"Semiconductors",mc:"Large Cap"},
  AMAT:{s:"Information Technology",i:"Semiconductor Equipment",mc:"Large Cap"},
  MU:{s:"Information Technology",i:"Memory Semiconductors",mc:"Large Cap"},
  LRCX:{s:"Information Technology",i:"Semiconductor Equipment",mc:"Large Cap"},
  ARM:{s:"Information Technology",i:"Semiconductor IP",mc:"Large Cap"},
  NOW:{s:"Information Technology",i:"Enterprise Software",mc:"Large Cap"},
  SNOW:{s:"Information Technology",i:"Cloud Data",mc:"Large Cap"},
  PLTR:{s:"Information Technology",i:"Data Analytics",mc:"Large Cap"},
  PANW:{s:"Information Technology",i:"Cybersecurity",mc:"Large Cap"},
  CRWD:{s:"Information Technology",i:"Cybersecurity",mc:"Large Cap"},
  ZS:{s:"Information Technology",i:"Cybersecurity",mc:"Large Cap"},
  NET:{s:"Information Technology",i:"Cloud Infrastructure",mc:"Large Cap"},
  DDOG:{s:"Information Technology",i:"Cloud Monitoring",mc:"Mid Cap"},
  CSCO:{s:"Information Technology",i:"Networking",mc:"Large Cap"},
  IBM:{s:"Information Technology",i:"IT Services",mc:"Large Cap"},
  ACN:{s:"Information Technology",i:"IT Consulting",mc:"Large Cap"},
  INTU:{s:"Information Technology",i:"Financial Software",mc:"Large Cap"},
  SHOP:{s:"Information Technology",i:"E-Commerce Platform",mc:"Large Cap"},
  SQ:{s:"Financials",i:"Fintech",mc:"Large Cap"},
  PYPL:{s:"Financials",i:"Digital Payments",mc:"Large Cap"},
  UBER:{s:"Information Technology",i:"Mobility Platform",mc:"Large Cap"},
  ABNB:{s:"Consumer Discretionary",i:"Travel Platform",mc:"Large Cap"},
  AMZN:{s:"Consumer Discretionary",i:"E-Commerce",mc:"Mega Cap"},
  TSLA:{s:"Consumer Discretionary",i:"Electric Vehicles",mc:"Mega Cap"},
  HD:{s:"Consumer Discretionary",i:"Home Improvement",mc:"Large Cap"},
  LOW:{s:"Consumer Discretionary",i:"Home Improvement",mc:"Large Cap"},
  NKE:{s:"Consumer Discretionary",i:"Athletic Apparel",mc:"Large Cap"},
  SBUX:{s:"Consumer Discretionary",i:"Restaurants",mc:"Large Cap"},
  MCD:{s:"Consumer Discretionary",i:"Quick Service Restaurants",mc:"Mega Cap"},
  F:{s:"Consumer Discretionary",i:"Automobiles",mc:"Large Cap"},
  GM:{s:"Consumer Discretionary",i:"Automobiles",mc:"Large Cap"},
  RIVN:{s:"Consumer Discretionary",i:"Electric Vehicles",mc:"Mid Cap"},
  BKNG:{s:"Consumer Discretionary",i:"Online Travel",mc:"Large Cap"},
  PG:{s:"Consumer Staples",i:"Household Products",mc:"Mega Cap"},
  KO:{s:"Consumer Staples",i:"Beverages",mc:"Mega Cap"},
  PEP:{s:"Consumer Staples",i:"Beverages & Snacks",mc:"Mega Cap"},
  COST:{s:"Consumer Staples",i:"Warehouse Retail",mc:"Large Cap"},
  WMT:{s:"Consumer Staples",i:"Discount Retail",mc:"Mega Cap"},
  PM:{s:"Consumer Staples",i:"Tobacco",mc:"Large Cap"},
  MO:{s:"Consumer Staples",i:"Tobacco",mc:"Large Cap"},
  "BRK.B":{s:"Financials",i:"Diversified Holding",mc:"Mega Cap"},
  JPM:{s:"Financials",i:"Banking",mc:"Mega Cap"},
  BAC:{s:"Financials",i:"Banking",mc:"Large Cap"},
  WFC:{s:"Financials",i:"Banking",mc:"Large Cap"},
  GS:{s:"Financials",i:"Investment Banking",mc:"Large Cap"},
  MS:{s:"Financials",i:"Investment Banking",mc:"Large Cap"},
  V:{s:"Financials",i:"Payment Processing",mc:"Mega Cap"},
  MA:{s:"Financials",i:"Payment Processing",mc:"Mega Cap"},
  BLK:{s:"Financials",i:"Asset Management",mc:"Large Cap"},
  COIN:{s:"Financials",i:"Crypto Exchange",mc:"Large Cap"},
  SOFI:{s:"Financials",i:"Fintech",mc:"Mid Cap"},
  UNH:{s:"Healthcare",i:"Health Insurance",mc:"Mega Cap"},
  JNJ:{s:"Healthcare",i:"Diversified Healthcare",mc:"Mega Cap"},
  LLY:{s:"Healthcare",i:"Pharmaceuticals",mc:"Mega Cap"},
  ABBV:{s:"Healthcare",i:"Pharmaceuticals",mc:"Large Cap"},
  MRK:{s:"Healthcare",i:"Pharmaceuticals",mc:"Large Cap"},
  PFE:{s:"Healthcare",i:"Pharmaceuticals",mc:"Large Cap"},
  TMO:{s:"Healthcare",i:"Life Sciences Tools",mc:"Large Cap"},
  ABT:{s:"Healthcare",i:"Medical Devices",mc:"Large Cap"},
  ISRG:{s:"Healthcare",i:"Surgical Robotics",mc:"Large Cap"},
  AMGN:{s:"Healthcare",i:"Biotechnology",mc:"Large Cap"},
  GILD:{s:"Healthcare",i:"Biotechnology",mc:"Large Cap"},
  MRNA:{s:"Healthcare",i:"Biotechnology (mRNA)",mc:"Large Cap"},
  REGN:{s:"Healthcare",i:"Biotechnology",mc:"Large Cap"},
  VRTX:{s:"Healthcare",i:"Biotechnology",mc:"Large Cap"},
  XOM:{s:"Energy",i:"Oil & Gas Integrated",mc:"Mega Cap"},
  CVX:{s:"Energy",i:"Oil & Gas Integrated",mc:"Mega Cap"},
  COP:{s:"Energy",i:"Oil & Gas E&P",mc:"Large Cap"},
  SLB:{s:"Energy",i:"Oilfield Services",mc:"Large Cap"},
  OXY:{s:"Energy",i:"Oil & Gas E&P",mc:"Large Cap"},
  FSLR:{s:"Energy",i:"Solar Energy",mc:"Mid Cap"},
  ENPH:{s:"Energy",i:"Solar Energy",mc:"Mid Cap"},
  BA:{s:"Industrials",i:"Aerospace & Defense",mc:"Large Cap"},
  RTX:{s:"Industrials",i:"Aerospace & Defense",mc:"Large Cap"},
  LMT:{s:"Industrials",i:"Defense Contractor",mc:"Large Cap"},
  CAT:{s:"Industrials",i:"Heavy Equipment",mc:"Large Cap"},
  DE:{s:"Industrials",i:"Farm Equipment",mc:"Large Cap"},
  GE:{s:"Industrials",i:"Industrial Conglomerate",mc:"Large Cap"},
  HON:{s:"Industrials",i:"Industrial Conglomerate",mc:"Large Cap"},
  UPS:{s:"Industrials",i:"Logistics",mc:"Large Cap"},
  FDX:{s:"Industrials",i:"Logistics",mc:"Large Cap"},
  DIS:{s:"Communication Services",i:"Entertainment",mc:"Large Cap"},
  NFLX:{s:"Communication Services",i:"Streaming",mc:"Large Cap"},
  T:{s:"Communication Services",i:"Telecom",mc:"Large Cap"},
  VZ:{s:"Communication Services",i:"Telecom",mc:"Large Cap"},
  TMUS:{s:"Communication Services",i:"Wireless Telecom",mc:"Large Cap"},
  SPOT:{s:"Communication Services",i:"Music Streaming",mc:"Large Cap"},
  NEE:{s:"Utilities",i:"Renewable Utilities",mc:"Large Cap"},
  DUK:{s:"Utilities",i:"Electric Utilities",mc:"Large Cap"},
  SO:{s:"Utilities",i:"Electric Utilities",mc:"Large Cap"},
  AMT:{s:"Real Estate",i:"Cell Tower REITs",mc:"Large Cap"},
  PLD:{s:"Real Estate",i:"Industrial REITs",mc:"Large Cap"},
  EQIX:{s:"Real Estate",i:"Data Center REITs",mc:"Large Cap"},
  O:{s:"Real Estate",i:"Net Lease REITs",mc:"Large Cap"},
  SPG:{s:"Real Estate",i:"Retail REITs",mc:"Large Cap"},
  LIN:{s:"Materials",i:"Industrial Gases",mc:"Large Cap"},
  SHW:{s:"Materials",i:"Paints & Coatings",mc:"Large Cap"},
  FCX:{s:"Materials",i:"Copper Mining",mc:"Large Cap"},
  NEM:{s:"Materials",i:"Gold Mining",mc:"Large Cap"},
  MSTR:{s:"Information Technology",i:"Bitcoin Treasury Corp",mc:"Large Cap"}
};

const CRYPTO_DB = {
  'BTC':      { s:'Digital Assets', i:'Store of Value / Layer 1', f:'Large Cap Crypto', note:'Bitcoin — the original decentralized currency; primary institutional store-of-value crypto.' },
  'BTC-USD':  { s:'Digital Assets', i:'Store of Value / Layer 1', f:'Large Cap Crypto', note:'Bitcoin — the original decentralized currency; primary institutional store-of-value crypto.' },
  'ETH':      { s:'Digital Assets', i:'Smart Contract Platform', f:'Large Cap Crypto', note:'Ethereum — the leading smart contract platform; powers DeFi, NFTs, and most Web3 applications.' },
  'ETH-USD':  { s:'Digital Assets', i:'Smart Contract Platform', f:'Large Cap Crypto', note:'Ethereum — the leading smart contract platform; powers DeFi, NFTs, and most Web3 applications.' },
  'SOL':      { s:'Digital Assets', i:'Smart Contract Platform', f:'Mid Cap Crypto', note:'Solana — high-throughput Layer 1 competing with Ethereum; known for fast, low-cost transactions.' },
  'SOL-USD':  { s:'Digital Assets', i:'Smart Contract Platform', f:'Mid Cap Crypto', note:'Solana — high-throughput Layer 1 competing with Ethereum; known for fast, low-cost transactions.' },
  'XRP':      { s:'Digital Assets', i:'Payments / Cross-Border', f:'Large Cap Crypto', note:'Ripple/XRP — designed for fast cross-border bank payments; focus on institutional remittance.' },
  'XRP-USD':  { s:'Digital Assets', i:'Payments / Cross-Border', f:'Large Cap Crypto', note:'Ripple/XRP — designed for fast cross-border bank payments; focus on institutional remittance.' },
  'ADA':      { s:'Digital Assets', i:'Smart Contract Platform', f:'Mid Cap Crypto', note:'Cardano — proof-of-stake Layer 1 with academic research-driven development.' },
  'ADA-USD':  { s:'Digital Assets', i:'Smart Contract Platform', f:'Mid Cap Crypto', note:'Cardano — proof-of-stake Layer 1 with academic research-driven development.' },
  'AVAX':     { s:'Digital Assets', i:'Smart Contract Platform', f:'Mid Cap Crypto', note:'Avalanche — fast Layer 1 with subnet architecture; growing DeFi and gaming ecosystem.' },
  'AVAX-USD': { s:'Digital Assets', i:'Smart Contract Platform', f:'Mid Cap Crypto', note:'Avalanche — fast Layer 1 with subnet architecture; growing DeFi and gaming ecosystem.' },
  'DOT':      { s:'Digital Assets', i:'Interoperability / Layer 0', f:'Mid Cap Crypto', note:'Polkadot — multi-chain protocol connecting specialized blockchains (parachains).' },
  'DOT-USD':  { s:'Digital Assets', i:'Interoperability / Layer 0', f:'Mid Cap Crypto', note:'Polkadot — multi-chain protocol connecting specialized blockchains (parachains).' },
  'MATIC':    { s:'Digital Assets', i:'Layer 2 / Scaling', f:'Mid Cap Crypto', note:'Polygon — Ethereum Layer 2 scaling solution; reduces gas fees and increases throughput.' },
  'LINK':     { s:'Digital Assets', i:'Oracle / Infrastructure', f:'Mid Cap Crypto', note:'Chainlink — decentralized oracle network connecting smart contracts to real-world data.' },
  'LINK-USD': { s:'Digital Assets', i:'Oracle / Infrastructure', f:'Mid Cap Crypto', note:'Chainlink — decentralized oracle network connecting smart contracts to real-world data.' },
  'UNI':      { s:'Digital Assets', i:'DeFi / DEX', f:'Mid Cap Crypto', note:'Uniswap — the largest decentralized exchange protocol by volume.' },
  'AAVE':     { s:'Digital Assets', i:'DeFi / Lending', f:'Small Cap Crypto', note:'Aave — leading decentralized lending and borrowing protocol.' },
  'DOGE':     { s:'Digital Assets', i:'Meme / Payments', f:'Large Cap Crypto', note:'Dogecoin — meme-origin currency with large retail following; used for tipping and payments.' },
  'DOGE-USD': { s:'Digital Assets', i:'Meme / Payments', f:'Large Cap Crypto', note:'Dogecoin — meme-origin currency with large retail following; used for tipping and payments.' },
  'SHIB':     { s:'Digital Assets', i:'Meme / Speculative', f:'Small Cap Crypto', note:'Shiba Inu — meme token in the Ethereum ecosystem; highly speculative.' },
  'SHIB-USD': { s:'Digital Assets', i:'Meme / Speculative', f:'Small Cap Crypto', note:'Shiba Inu — meme token in the Ethereum ecosystem; highly speculative.' },
  'LTC':      { s:'Digital Assets', i:'Payments / Layer 1', f:'Mid Cap Crypto', note:'Litecoin — early Bitcoin fork focused on faster payments and lower fees.' },
  'LTC-USD':  { s:'Digital Assets', i:'Payments / Layer 1', f:'Mid Cap Crypto', note:'Litecoin — early Bitcoin fork focused on faster payments and lower fees.' },
  'BCH':      { s:'Digital Assets', i:'Payments / Layer 1', f:'Mid Cap Crypto', note:'Bitcoin Cash — Bitcoin fork with larger block size for cheaper on-chain transactions.' },
  'BCH-USD':  { s:'Digital Assets', i:'Payments / Layer 1', f:'Mid Cap Crypto', note:'Bitcoin Cash — Bitcoin fork with larger block size for cheaper on-chain transactions.' },
  'TON':      { s:'Digital Assets', i:'Smart Contract Platform', f:'Mid Cap Crypto', note:'Toncoin — Telegram\'s blockchain; growing adoption through Telegram mini-app ecosystem.' },
  'SUI':      { s:'Digital Assets', i:'Smart Contract Platform', f:'Small Cap Crypto', note:'Sui — high-performance Layer 1 from ex-Meta engineers using Move programming language.' },
  'APT':      { s:'Digital Assets', i:'Smart Contract Platform', f:'Small Cap Crypto', note:'Aptos — Move-based Layer 1 from ex-Meta Diem team; focused on developer experience.' }
};

function classifyHolding(ticker, quoteData) {
  const etf = ETF_DB[ticker];
  if (etf) return { sector: etf.s, industry: etf.i, assetClass: etf.a, marketCap: 0, mktCapCategory: etf.f, leverage: etf.lev || '' };
  const crypto = CRYPTO_DB[ticker];
  if (crypto) return { sector: crypto.s, industry: crypto.i, assetClass: 'Digital Asset', marketCap: 0, mktCapCategory: crypto.f, leverage: '' };
  const stock = STOCK_DB[ticker];
  if (stock) return { sector: stock.s, industry: stock.i, assetClass: "Equity", marketCap: 0, mktCapCategory: stock.mc, leverage: '' };
  // Fallback: name-based detection
  const name = (quoteData.name || "").toLowerCase();
  let sector = "Other", industry = "Other", assetClass = "Equity", mktCat = "Large Cap";
  if (name.includes("etf") || name.includes("fund") || name.includes("trust") || name.includes("ishares") || name.includes("vanguard") || name.includes("spdr") || name.includes("proshares") || name.includes("invesco")) {
    assetClass = "ETF"; mktCat = "Large Fund";
  }
  if (name.includes("bitcoin") || name.includes("crypto") || name.includes("ethereum")) { sector = "Digital Assets"; industry = "Crypto"; }
  else if (name.includes("gold") || name.includes("silver") || name.includes("platinum")) { sector = "Commodities"; industry = "Precious Metals"; assetClass = "Commodity"; }
  else if (name.includes("oil") || name.includes("energy") || name.includes("petroleum")) { sector = "Energy"; industry = "Oil & Gas"; }
  else if (name.includes("reit") || name.includes("real estate") || name.includes("realty")) { sector = "Real Estate"; industry = "REITs"; assetClass = assetClass === "ETF" ? "REIT ETF" : "REIT"; }
  else if (name.includes("bond") || name.includes("treasury") || name.includes("fixed income")) { sector = "Fixed Income"; industry = "Bonds"; assetClass = "Bond"; }
  else if (name.includes("bank") || name.includes("financial")) { sector = "Financials"; industry = "Financial Services"; }
  else if (name.includes("pharma") || name.includes("biotech") || name.includes("health")) { sector = "Healthcare"; industry = "Biotech / Pharma"; }
  else if (name.includes("semiconductor") || name.includes("software") || name.includes("tech") || name.includes("cloud") || name.includes("cyber")) { sector = "Information Technology"; industry = "Technology"; }
  else if (name.includes("solar") || name.includes("clean energy") || name.includes("renewable")) { sector = "Utilities"; industry = "Renewable Energy"; }
  else if (name.includes("mining") || name.includes("copper") || name.includes("lithium") || name.includes("steel")) { sector = "Materials"; industry = "Mining & Metals"; }
  else if (name.includes("aerospace") || name.includes("defense")) { sector = "Industrials"; industry = "Aerospace & Defense"; }
  if (name.includes("3x") || name.includes("leverag") || name.includes("ultra")) { assetClass = "Leveraged ETF"; }
  return { sector, industry, assetClass, marketCap: 0, mktCapCategory: mktCat, leverage: '' };
}

// ═══ HELPERS ═══
// Toggle between Stock/ETF and Cash input modes
window.toggleHoldingType = function() {
  var val = document.querySelector('input[name="holdingType"]:checked')?.value || 'security';
  document.getElementById('securityFields').style.display = val === 'security' ? '' : 'none';
  document.getElementById('cashFields').style.display = val === 'cash' ? '' : 'none';
};

// Default the Date Purchased field to today on first paint
window.addEventListener('DOMContentLoaded', function(){
  var d = document.getElementById('inputDate');
  if (d && !d.value) d.value = new Date().toISOString().slice(0,10);
});

// Autofill Cost/Share from historical close when ticker + date are present and Cost is empty.
// Debounced; only fires when both fields are populated and Cost is blank.
var _autofillTimer = null;
window.autofillCostBasis = function() {
  if (_autofillTimer) clearTimeout(_autofillTimer);
  _autofillTimer = setTimeout(async function(){
    var ticker = (document.getElementById('inputTicker').value || '').trim().toUpperCase();
    var date = document.getElementById('inputDate').value;
    var costEl = document.getElementById('inputCost');
    var hint = document.getElementById('inputCostHint');
    if (!ticker || !date) { if (hint) hint.textContent = ''; return; }
    // Don't overwrite a manually entered cost
    if (costEl.value && parseFloat(costEl.value) > 0) { if (hint) hint.textContent = ''; return; }
    if (hint) hint.textContent = 'Looking up close for ' + date + '...';
    try {
      var res = await fetch(WORKER_URL + '/historical-close?symbol=' + encodeURIComponent(ticker) + '&date=' + encodeURIComponent(date));
      var d = await res.json();
      if (d.error) { if (hint) { hint.textContent = ''; } return; }
      // Only fill if user still hasn't typed a cost
      if (!costEl.value) {
        costEl.value = d.close.toFixed(2);
        if (hint) hint.innerHTML = '<span style="color:var(--success);">&#10003; Auto-filled from Yahoo (close on ' + d.actualDate + ')</span>';
      }
    } catch(e) { if (hint) hint.textContent = ''; }
  }, 600);
};

// Reverse lookup: given a cost/share, find the most recent date the stock traded near that price.
// Only fires when date is still "today" (not manually overridden) and ticker + cost are both set.
var _estimateDateTimer = null;
window.estimatePurchaseDate = function() {
  if (_estimateDateTimer) clearTimeout(_estimateDateTimer);
  _estimateDateTimer = setTimeout(async function() {
    var ticker = (document.getElementById('inputTicker').value || '').trim().toUpperCase();
    var costEl = document.getElementById('inputCost');
    var dateEl = document.getElementById('inputDate');
    var dateHint = document.getElementById('inputDateHint');
    var targetPrice = parseFloat(costEl.value);
    if (!ticker || !targetPrice || targetPrice <= 0) { if (dateHint) dateHint.textContent = ''; return; }
    // Only auto-estimate if the date is today (user hasn't set a specific date)
    var today = new Date().toISOString().slice(0, 10);
    if (dateEl.value && dateEl.value !== today) { if (dateHint) dateHint.textContent = ''; return; }
    if (dateHint) dateHint.innerHTML = '<span style="color:var(--text-sec);">Searching price history for $' + targetPrice.toFixed(2) + '…</span>';
    try {
      var chartData = await fetchChart(ticker, '5y', '1d');
      var pts = (chartData.points || []).filter(function(p) { return p.close != null; });
      if (!pts.length) { if (dateHint) dateHint.textContent = ''; return; }
      // Try 1% tolerance first, then 3%
      var found = null;
      for (var tol = 0.01; tol <= 0.03 && !found; tol += 0.02) {
        for (var i = pts.length - 1; i >= 0; i--) {
          if (Math.abs(pts[i].close - targetPrice) / targetPrice <= tol) {
            found = { date: pts[i].date.slice(0, 10), close: pts[i].close, tol: tol };
            break;
          }
        }
      }
      if (found) {
        // Only update if date is still today (don't overwrite if user changed it while we were loading)
        if (dateEl.value === today) {
          dateEl.value = found.date;
          var tolLabel = found.tol <= 0.01 ? 'within 1%' : 'within 3%';
          if (dateHint) dateHint.innerHTML = '<span style="color:var(--success);">&#10003; Estimated from price history (' + tolLabel + ' of $' + found.close.toFixed(2) + ') — adjust if needed</span>';
        }
      } else {
        if (dateHint) dateHint.innerHTML = '<span style="color:var(--text-sec);">No close within 3% of $' + targetPrice.toFixed(2) + ' found in 5y history</span>';
      }
    } catch(e) { if (dateHint) dateHint.textContent = ''; }
  }, 800);
};

const fmt = v => "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = v => "$" + Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
const fmtPct = v => (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
const pctColor = v => v >= 0 ? C.success : C.danger;
function showStatus(id, msg, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'status-bar ' + type;
  el.innerHTML = msg;
}

// ═══ STATE ═══
let currentRange = "1y";
let portfolioLineChart = null;

// ═══ CHART.JS PLUGIN: Price Bubble at End of Line ═══
const priceBubblePlugin = {
  id: 'priceBubble',
  afterDatasetsDraw(chart) {
    const ctx = chart.ctx;
    chart.data.datasets.forEach(function(ds, i) {
      const meta = chart.getDatasetMeta(i);
      if (meta.hidden || !meta.data.length) return;
      // Find last non-null data point
      var lastPt = null;
      for (var j = meta.data.length - 1; j >= 0; j--) {
        if (ds.data[j] != null) { lastPt = meta.data[j]; break; }
      }
      if (!lastPt) return;
      var x = lastPt.x, y = lastPt.y;
      var val = ds.data[ds.data.length - 1];
      if (val == null) return;
      // Format label
      var label;
      if (typeof val === 'number') {
        if (Math.abs(val) > 1000) label = '$' + Number(val).toLocaleString('en-US', {maximumFractionDigits: 0});
        else if (Math.abs(val) > 100) label = '$' + val.toFixed(0);
        else label = (val >= 0 ? '+' : '') + val.toFixed(1) + '%';
      } else return;
      var color = ds.borderColor || '#003C71';
      ctx.save();
      ctx.font = '600 10px Arial';
      var tw = ctx.measureText(label).width;
      var px = 6, py = 3, r = 4;
      var bx = chart.chartArea.right + 4;
      var by = y - py - 5;
      // Draw rounded rect bubble
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(bx, by, tw + px * 2, 16, r);
      ctx.fill();
      // Draw text
      ctx.fillStyle = '#FFFFFF';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + px, by + 8);
      ctx.restore();
    });
  }
};
Chart.register(priceBubblePlugin);
let donutCharts = {};

// ═══ NAVIGATION ═══
const parentMap = { home: 'home', about: 'home', resources: 'home', portfolio: 'portfolio', holdings: 'portfolio', 'sector-macro-alignment': 'portfolio', themes: 'portfolio', macro: 'analysis', markets: 'analysis', research: 'analysis' };
function navigateTo(p) {
  document.activeElement.blur();
  document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.nav-parent,.nav-child').forEach(x => x.classList.remove('active'));
  document.getElementById('page-' + p).classList.add('active');
  const pp = parentMap[p] || p;
  const pe = document.querySelector('.nav-parent[data-page="' + pp + '"]');
  if (pe) pe.classList.add('active');
  const ce = document.querySelector('.nav-child[data-page="' + p + '"]');
  if (ce) ce.classList.add('active');
  window.scrollTo(0, 0);
  if (p === 'portfolio') {
    renderPortfolioOverview();
    // Auto-fire factor exposure and forward-return engines on first portfolio visit per session
    setTimeout(function(){
      if (typeof ffRunAnalysis === 'function' && !window._ffAutoRan && window._holdings && window._holdings.length) {
        window._ffAutoRan = true;
        ffRunAnalysis();
      }
      if (typeof pfrRun === 'function' && !window._pfrAutoRan && window._holdings && window._holdings.length) {
        window._pfrAutoRan = true;
        pfrRun();
      }
    }, 1500);
  }
  if (p === 'home') { briefingLoad(); }
  if (p === 'themes' && typeof themesPopulateDropdown === 'function') {
    themesPopulateDropdown();
  }
  if (p === 'macro') {
    // Always land on the dashboard tab; macroShowTab handles lazy loading per tab
    if (typeof macroShowTab === 'function') macroShowTab('dashboard');
    else loadMacroLiveTable();
  }
  if (p === 'sector-macro-alignment') {
    setTimeout(function(){
      if (typeof loadPlaybook === 'function') loadPlaybook();
      if (typeof loadGapAnalysis === 'function') loadGapAnalysis();
    }, 100);
  }
  if (p === 'home') {
    // Re-run briefing every time home is visited
    setTimeout(function(){ if (typeof briefingLoad === 'function') briefingLoad(); }, 100);
  }
  if (p === 'backtest') {
    if (typeof btPageInit === 'function' && !window._btInited) {
      window._btInited = true;
      setTimeout(btPageInit, 100);
    }
  }
  if (p === 'markets') {
    // Show Top-Line tab as the default landing view
    if (typeof caShowTab === 'function') caShowTab('topline');
    if (typeof psRenderFrameworkGrid === 'function') psRenderFrameworkGrid(null);
    if (!window._snapshotLoaded) {
      window._snapshotLoaded = true;
      setTimeout(function() {
        snapshotLoad();
        // Fire topline immediately (user sees this first)
        if (typeof topLineRefreshAll === 'function') setTimeout(topLineRefreshAll, 400);
        // Then stagger-load all other tabs in the background so they're
        // ready before the user clicks them. Staggered to avoid hammering
        // the worker with simultaneous requests. Each block is offset by
        // enough time to not saturate the browser's request queue.
        setTimeout(function() { caAutoLoad('movers'); },    2000);
        setTimeout(function() { caAutoLoad('bizycle'); },   3000);
        setTimeout(function() { caAutoLoad('regime'); },    5000);
        setTimeout(function() { caAutoLoad('credit'); },    7000);
        setTimeout(function() { caAutoLoad('yieldcurve'); },9000);
        setTimeout(function() { caAutoLoad('breadth'); },  11000);
        setTimeout(function() { caAutoLoad('momentum'); }, 13000);
        setTimeout(function() { caAutoLoad('sectors'); },  16000);
        setTimeout(function() {
          if (!window._mktInitialized && typeof mktInit === 'function') {
            mktInit(); window._mktInitialized = true;
          }
          var endEl = document.getElementById('mktEndDate');
          if (endEl && !endEl.value) endEl.value = new Date().toISOString().slice(0, 10);
          if (typeof mktLoadAll === 'function') {
            mktLoadAll().catch(function() {});
          }
        }, 20000);
      }, 100);
    } else {
      // On revisit: re-run topline if stale, other tabs refresh on demand
      if (typeof topLineRefreshAll === 'function' && !window._tlPillars) topLineRefreshAll();
    }
  }
  if (p === 'quant' && typeof quantInit === 'function' && !window._quantInitialized) { quantInit(); window._quantInitialized = true; }
}

// ═══ VIEW TOGGLE (Laptop / Mobile) ═══
function toggleView() {
  var isMobile = document.body.classList.toggle('view-mobile');
  localStorage.setItem('perry_view', isMobile ? 'mobile' : 'laptop');
  var icon  = document.getElementById('viewToggleIcon');
  var label = document.getElementById('viewToggleLabel');
  if (icon)  icon.innerHTML  = isMobile ? '&#128241;' : '&#128187;';
  if (label) label.textContent = isMobile ? 'Mobile' : 'Laptop';
  if (typeof applyChartViewDefaults === 'function') applyChartViewDefaults();
  // Add viewport meta for mobile if not present
  if (isMobile) {
    var meta = document.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'viewport';
      document.head.appendChild(meta);
    }
    meta.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no';
  } else {
    mobileDrawerClose();
    var meta = document.querySelector('meta[name="viewport"]');
    if (meta) meta.content = 'width=device-width, initial-scale=1.0';
  }
  setTimeout(function(){ window.dispatchEvent(new Event('resize')); }, 150);
}

// ── Mobile Drawer ──────────────────────────────────────────────
function mobileDrawerOpen() {
  var drawer  = document.getElementById('mobileDrawer');
  var overlay = document.getElementById('mobileDrawerOverlay');
  if (drawer)  { drawer.classList.add('open'); drawer.style.display = 'block'; }
  if (overlay) overlay.style.display = 'block';
  document.body.style.overflow = 'hidden';
}

function mobileDrawerClose() {
  var drawer  = document.getElementById('mobileDrawer');
  var overlay = document.getElementById('mobileDrawerOverlay');
  if (drawer)  drawer.classList.remove('open');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
}

function mobileNav(page) {
  mobileDrawerClose();
  navigateTo(page);
  // Update drawer active state
  document.querySelectorAll('[data-mobpage]').forEach(function(b) {
    b.classList.toggle('active', b.dataset.mobpage === page);
  });
  // Update bottom bar active state
  document.querySelectorAll('[data-mobbottom]').forEach(function(b) {
    b.classList.toggle('active', b.dataset.mobbottom === page);
  });
  // Scroll to top
  window.scrollTo(0, 0);
}

// Patch navigateTo to also sync mobile nav state
(function() {
  var _origNav = window.navigateTo || function(){};
  window.navigateTo = function(p) {
    _origNav(p);
    // Sync mobile bottom bar + drawer highlights
    document.querySelectorAll('[data-mobpage]').forEach(function(b) {
      b.classList.toggle('active', b.dataset.mobpage === p);
    });
    document.querySelectorAll('[data-mobbottom]').forEach(function(b) {
      b.classList.toggle('active', b.dataset.mobbottom === p);
    });
  };
})();

// Restore view preference on load
(function(){
  var pref = localStorage.getItem('perry_view');
  if (pref === 'mobile') {
    setTimeout(function(){
      document.body.classList.add('view-mobile');
      var icon  = document.getElementById('viewToggleIcon');
      var label = document.getElementById('viewToggleLabel');
      if (icon)  icon.innerHTML  = '&#128241;';
      if (label) label.textContent = 'Mobile';
      var meta = document.querySelector('meta[name="viewport"]');
      if (!meta) { meta = document.createElement('meta'); meta.name = 'viewport'; document.head.appendChild(meta); }
      meta.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no';
    }, 50);
  }
})();

// ═══ HOME FEATURES ═══
const FEATURES = [
  { title: "Portfolio Overview", desc: "Live valuation, benchmark comparison, allocation charts, Morningstar style box, and performance history.", page: "portfolio", tag: "Active" },
  { title: "Manage Holdings", desc: "Add/remove holdings stored in Firebase. Prices refresh from Yahoo Finance via Cloudflare Worker.", page: "holdings", tag: "Active" },
  { title: "Market Research", desc: "Real-time quotes, historical charts, and ticker search via Cloudflare data proxy.", page: "research", tag: "Active" },
  { title: "Macro Regime Analysis", desc: "CFA-based 10-indicator scorecard, business cycle classification, sector rotation, and cross-asset confirmation.", page: "macro", tag: "Active" },
  { title: "Quantitative Models", desc: "Stock decision trees, MLR regression, peer comparison, Monte Carlo simulation, and regime backtesting.", page: "research", tag: "Active" },
  { title: "Risk & Stress Testing", desc: "VaR (3 methods), Cox jump process, 3D volatility surface, efficient frontier, correlation heatmap, and cross-asset regime signals.", page: "markets", tag: "Active" }
];
document.getElementById('featureGrid').innerHTML = FEATURES.map(f =>
  '<div class="feature-card ' + (f.page ? '' : 'disabled') + '" ' +
  (f.page ? 'onclick="navigateTo(\'' + f.page + '\')"' : '') + '>' +
  '<div class="feature-tag ' + (f.tag === 'Coming Soon' ? 'soon' : '') + '">' + f.tag + '</div>' +
  '<div class="feature-title">' + f.title + '</div>' +
  '<div class="feature-desc">' + f.desc + '</div></div>'
).join('');

// ═══ TIMEFRAME BUTTONS ═══
function bindTimeframeBtns() {
  document.querySelectorAll('#pfTimeframeBtns .btn-outline').forEach(function(b) {
    // Remove any old listeners by replacing with a fresh handler
    b.onclick = function() {
      document.querySelectorAll('#pfTimeframeBtns .btn-outline').forEach(function(x) {
        x.classList.remove('active');
      });
      this.classList.add('active');
      currentRange = this.dataset.range;
      // Re-render just the chart (fast) — not the entire portfolio overview
      if (typeof renderPortfolioChart === 'function') {
        renderPortfolioChart();
      }
    };
  });
}

// ═══ SORTABLE TABLE HELPERS ═══
let _holdingsSort = { col: null, asc: true };
let _portfolioSort = { col: null, asc: true };

function sortableHeader(cols, sortState, renderFn, tableId) {
  return cols.map(c => {
    const isActive = sortState.col === c.key;
    const arrow = isActive
      ? (sortState.asc ? ' <span style="color:#A8C8E8;font-size:9px;">▲</span>' : ' <span style="color:#A8C8E8;font-size:9px;">▼</span>')
      : ' <span style="color:rgba(255,255,255,0.25);font-size:9px;">⇅</span>';
    const bg = isActive ? 'background:rgba(255,255,255,0.14);' : '';
    return '<th title="Click to sort by ' + c.label + '" style="' + bg + 'cursor:pointer;user-select:none;" onclick="sortTable_' + tableId + '(\'' + c.key + '\')">' +
      c.label + arrow + '</th>';
  }).join('');
}

function getSortedHoldings(holdings, sortState) {
  if (!sortState.col) return holdings.slice();
  const key = sortState.col;
  const rfOrder = { 'Aligned': 1, 'Neutral': 2, 'Misaligned': 3 };
  function mvOf(h) {
    const isCash = ['Cash','Money Market','CD','Bond Position'].includes(h.assetClass);
    return isCash ? (h.costBasis||0)*(h.quantity||0) : (h.currentPrice||0)*(h.quantity||0);
  }
  return holdings.slice().sort((a, b) => {
    let va, vb;
    if (key === 'marketValue') { va = mvOf(a); vb = mvOf(b); }
    else if (key === 'glPct') {
      va = a.costBasis>0 ? (((a.currentPrice||0)-a.costBasis)/a.costBasis)*100 : 0;
      vb = b.costBasis>0 ? (((b.currentPrice||0)-b.costBasis)/b.costBasis)*100 : 0;
    } else if (key === 'weight') {
      va = a._weight || mvOf(a); vb = b._weight || mvOf(b);
    } else if (key === 'regimeFit') {
      va = rfOrder[a._regimeFitLabel] || 2;
      vb = rfOrder[b._regimeFitLabel] || 2;
    } else if (key === 'currentPrice') {
      va = a.currentPrice || 0; vb = b.currentPrice || 0;
    } else { va = a[key]; vb = b[key]; }
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string') return sortState.asc ? va.localeCompare(vb) : vb.localeCompare(va);
    return sortState.asc ? va - vb : vb - va;
  });
}

window.sortTable_manage = function(key) {
  if (_holdingsSort.col === key) _holdingsSort.asc = !_holdingsSort.asc;
  else { _holdingsSort.col = key; _holdingsSort.asc = true; }
  renderHoldingsTable(window._holdings || []);
};

window.sortTable_portfolio = function(key) {
  if (_portfolioSort.col === key) {
    _portfolioSort.asc = !_portfolioSort.asc;
  } else {
    _portfolioSort.col = key;
    // Text columns: default A→Z; numeric: default largest first
    _portfolioSort.asc = ['ticker','companyName','accountType','sector','assetClass'].includes(key);
  }
  const h = window._holdings || [];
  const af = document.getElementById('portfolioAccountFilter')?.value || 'all';
  function mvOf(hh) {
    const isCash = ['Cash','Money Market','CD','Bond Position'].includes(hh.assetClass);
    return isCash ? (hh.costBasis||0)*hh.quantity : (hh.currentPrice||0)*hh.quantity;
  }
  const allFilt = af === 'all' ? h : h.filter(x => (x.accountType||'Individual') === af);
  const totalTV = allFilt.reduce((s,x)=>s+mvOf(x),0);
  // Respect any active chip filter
  let fh = allFilt;
  const ft = window._pfActiveFilterType, fv = window._pfActiveFilter;
  if (ft && fv && fv !== 'all') fh = allFilt.filter(x => (x[ft]||'') === fv);
  const filtTV = fh.reduce((s,x)=>s+mvOf(x),0);
  renderPortfolioTable(fh, filtTV, totalTV);
};

// Filter Portfolio Holdings table by sector, asset class, or account
window.pfFilterHoldings = function(filterType, filterValue) {
  const h = window._holdings || [];
  const af = document.getElementById('portfolioAccountFilter')?.value || 'all';
  function mvOf(hh) {
    const isCash = hh.assetClass === 'Cash' || hh.assetClass === 'Money Market' || hh.assetClass === 'CD' || hh.assetClass === 'Bond Position';
    return isCash ? (hh.costBasis || 0) * hh.quantity : (hh.currentPrice || 0) * hh.quantity;
  }
  const allFiltered = af === 'all' ? h : h.filter(x => (x.accountType || 'Individual') === af);
  // Apply chip filter
  let fh = allFiltered;
  if (filterType && filterValue && filterValue !== 'all') {
    fh = allFiltered.filter(x => (x[filterType] || '') === filterValue);
  }
  // FILTERED TV: compute from the filtered set only (so % weights sum to 100% within filter)
  // TOTAL TV: still used for % account and % portfolio absolute context
  const tvFiltered = fh.reduce((s, x) => s + mvOf(x), 0);
  window._pfFilteredTV = tvFiltered; // store so table can use it
  window._pfTotalTV = allFiltered.reduce((s, x) => s + mvOf(x), 0); // full portfolio TV
  renderPortfolioTable(fh, tvFiltered, allFiltered.reduce((s, x) => s + mvOf(x), 0));
};

window.filterHoldingsByAccount = function() {
  renderHoldingsTable(window._holdings || []);
  renderHoldingsKPIs(window._holdings || []);
  _hldTabInit.analysis = false;
  var at = document.getElementById('htab-analysis');
  if (at && at.classList.contains('active')) renderHoldingsAnalysis(window._holdings || []);
};

// ═══ MANAGE HOLDINGS TABLE (with Account, Sell, Sort, Total) ═══
function renderHoldingsInsights(holdings) {
  var panel = document.getElementById('holdingsInsightPanel');
  if (!panel) return;
  if (!holdings || !holdings.length) { panel.style.display = 'none'; return; }
  var isCashLike = function(h) { return ['Cash','Money Market','CD','Bond Position'].includes(h.assetClass); };
  var equityH = holdings.filter(function(h){ return !isCashLike(h); });
  var totalMV = holdings.reduce(function(s,h){ return s+(h.currentPrice||0)*h.quantity; }, 0);
  var equityMV = equityH.reduce(function(s,h){ return s+(h.currentPrice||0)*h.quantity; }, 0);
  if (!totalMV) { panel.style.display = 'none'; return; }
  // Get benchmark (risk profile target or SPY)
  var benchModel = 'spy';
  if (window._riskProfile && RISK_PROFILES[window._riskProfile]) benchModel = RISK_PROFILES[window._riskProfile].driftModel;
  var benchWeights = benchModel === 'aggressive_growth' ? AGGRESSIVE_GROWTH_WEIGHTS
    : benchModel === 'conservative' ? CONSERVATIVE_WEIGHTS
    : benchModel === 'balanced' ? BALANCED_WEIGHTS : SPY_SECTOR_WEIGHTS;
  var benchName = benchModel === 'aggressive_growth' ? 'Aggressive Growth benchmark'
    : benchModel === 'conservative' ? 'Conservative benchmark'
    : benchModel === 'balanced' ? 'Balanced benchmark' : 'S&P 500 benchmark';
  // Compute sector weights
  var sectorMV = {};
  equityH.forEach(function(h) {
    var s = (h.sector || 'Other');
    sectorMV[s] = (sectorMV[s] || 0) + (h.currentPrice||0)*h.quantity;
  });
  var insights = [];
  // 1. Heavy / light sector analysis
  Object.keys(sectorMV).forEach(function(s) {
    var cur = totalMV > 0 ? sectorMV[s] / totalMV * 100 : 0;
    var bench = benchWeights[s] || 0;
    var diff = cur - bench;
    if (diff > 10 && cur > 5) insights.push({ icon: '📊', color: '#c47c00', text: 'You are <strong>HEAVY in ' + s + '</strong> (' + cur.toFixed(0) + '% vs ' + bench.toFixed(0) + '% ' + benchName + '). Concentration increases sector-specific risk.', link: null });
    else if (bench > 8 && diff < -8) insights.push({ icon: '📉', color: '#5B9BD5', text: 'You are <strong>LIGHT in ' + s + '</strong> (' + cur.toFixed(0) + '% vs ' + bench.toFixed(0) + '% ' + benchName + '). May miss upside in this sector.', link: null });
  });
  // 2. Largest single-stock concentration
  var byMV = equityH.slice().sort(function(a,b){ return (b.currentPrice||0)*b.quantity - (a.currentPrice||0)*a.quantity; });
  if (byMV.length) {
    var top = byMV[0];
    var topPct = totalMV > 0 ? (top.currentPrice||0)*top.quantity/totalMV*100 : 0;
    if (topPct > 15) insights.push({ icon: '💡', color: '#003C71', text: 'Your largest single-position risk: <strong>' + top.ticker + ' at ' + topPct.toFixed(0) + '% of portfolio</strong>. Conventional wisdom caps single-stock risk at 5–10%.', link: null });
  }
  // 3. Positions with unrealized loss > 15%
  var bigLosers = holdings.filter(function(h) {
    if (isCashLike(h) || !h.costBasis || !h.currentPrice) return false;
    return (h.currentPrice - h.costBasis) / h.costBasis < -0.15;
  });
  if (bigLosers.length) {
    var tickers = bigLosers.map(function(h){ return h.ticker; }).join(', ');
    insights.push({ icon: '⚠️', color: '#8B2020', text: '<strong>' + bigLosers.length + ' position' + (bigLosers.length>1?'s':'') + ' with unrealized losses &gt;15%</strong>: ' + tickers + '. Review for tax-loss harvesting opportunities.', link: 'tlhRender()' });
  }
  // 4. Leveraged ETF exposure warning
  var levPositions = equityH.filter(function(h){ return ETF_DB[h.ticker] && ETF_DB[h.ticker].lev; });
  if (levPositions.length) {
    var levMV = levPositions.reduce(function(s,h){ return s+(h.currentPrice||0)*h.quantity; }, 0);
    var levPct = totalMV > 0 ? levMV/totalMV*100 : 0;
    if (levPct > 0) insights.push({ icon: '⚡', color: '#A23B72', text: '<strong>' + levPositions.length + ' leveraged/inverse ETF' + (levPositions.length>1?'s':'') + '</strong> (' + levPositions.map(function(h){return h.ticker;}).join(', ') + ') make up <strong>' + levPct.toFixed(1) + '%</strong> of portfolio. These decay in sideways markets — monitor closely.', link: null });
  }
  // 5. Too few holdings (concentration risk)
  if (equityH.length > 0 && equityH.length < 5) insights.push({ icon: '🔍', color: '#8B6914', text: 'You hold only <strong>' + equityH.length + ' position' + (equityH.length>1?'s':'') + '</strong>. A concentrated portfolio amplifies both gains and losses. Consider diversifying to at least 10–15 positions.', link: null });
  if (!insights.length) { panel.style.display = 'none'; return; }
  var html = '<div style="display:flex;flex-direction:column;gap:8px;">';
  insights.forEach(function(ins) {
    var linkHtml = ins.link ? ' <a href="#" onclick="'+ins.link+';return false;" style="color:var(--blue);font-size:11px;font-weight:600;">Review &rarr;</a>' : '';
    html += '<div style="display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border-radius:6px;background:var(--panel);border-left:4px solid '+ins.color+';">'
      + '<span style="font-size:16px;line-height:1.2;flex-shrink:0;">'+ins.icon+'</span>'
      + '<div style="font-size:12px;color:var(--text);line-height:1.5;">'+ins.text+linkHtml+'</div>'
      + '</div>';
  });
  html += '</div>';
  panel.style.display = '';
  panel.innerHTML = html;
}

function renderHoldingsTable(holdings) {
  const wrap = document.getElementById('holdingsTableWrap');
  if (!holdings || !holdings.length) {
    wrap.innerHTML = '<div class="empty-state" style="padding:24px;"><h3>No Holdings Yet</h3><p>Use the form above to add your first holding.</p></div>';
    return;
  }
  const filter = document.getElementById('holdingsAccountFilter')?.value || 'all';
  const filtered = filter === 'all' ? holdings : holdings.filter(h => (h.accountType || 'Individual') === filter);
  if (!filtered.length) {
    wrap.innerHTML = '<div class="empty-state" style="padding:24px;"><h3>No Holdings in This Account</h3><p>Switch to "All Accounts" or add holdings to this account type.</p></div>';
    return;
  }
  const sorted = getSortedHoldings(filtered, _holdingsSort);
  const tv = sorted.reduce((s, h) => s + (h.currentPrice || 0) * h.quantity, 0);
  const tc = sorted.reduce((s, h) => s + h.costBasis * h.quantity, 0);
  const tgl = tv - tc;
  const tglp = tc > 0 ? (tgl / tc) * 100 : 0;

  // Group tickers that appear in multiple accounts for visual indicator
  var tickerCounts = {};
  sorted.forEach(function(h){ tickerCounts[h.ticker] = (tickerCounts[h.ticker] || 0) + 1; });
  // Per-ticker account list (2026-07): replaces the old ×N badge. Primary
  // account = the one holding the largest market value of that ticker.
  var tickerAccts = {};
  sorted.forEach(function(h){
    var mvA = (h.currentPrice || h.costBasis || 0) * h.quantity;
    if (!tickerAccts[h.ticker]) tickerAccts[h.ticker] = [];
    tickerAccts[h.ticker].push({ a: h.accountType || 'Individual', mv: mvA });
  });
  Object.keys(tickerAccts).forEach(function(t){ tickerAccts[t].sort(function(x,y){ return y.mv - x.mv; }); });

  // Summary bar for tickers across multiple accounts
  var multiAccountTickers = Object.keys(tickerCounts).filter(function(t){ return tickerCounts[t] > 1; });
  var summaryHtml = '';
  if (multiAccountTickers.length && filter === 'all') {
    summaryHtml = '<div style="background:var(--panel);border:1px solid var(--border);border-left:3px solid var(--blue);border-radius:4px;padding:10px 14px;margin-bottom:12px;font-size:12px;">';
    summaryHtml += '<strong style="color:var(--navy);">&#128279; Multi-account positions:</strong> ';
    multiAccountTickers.forEach(function(t, i){
      var subs = sorted.filter(function(h){ return h.ticker === t; });
      var totalQty = subs.reduce(function(s,h){return s+h.quantity;}, 0);
      var totalCost = subs.reduce(function(s,h){return s+h.costBasis*h.quantity;}, 0);
      var totalMv = subs.reduce(function(s,h){return s+(h.currentPrice||0)*h.quantity;}, 0);
      var glp = totalCost > 0 ? (totalMv - totalCost)/totalCost*100 : 0;
      summaryHtml += (i>0?' &middot; ':'') + '<span style="color:var(--navy);font-weight:700;">'+t+'</span> '
        + '<span style="color:var(--text-sec);">('+subs.length+' accts, '+totalQty+' sh total, '+fmtPct(glp)+')</span>';
    });
    summaryHtml += '<div style="font-size:11px;color:var(--text-sec);margin-top:4px;">Positions in the same ticker but different accounts are tracked separately for tax-lot integrity. Portfolio totals aggregate across accounts.</div>';
    summaryHtml += '</div>';
  }

  const cols = [
    {key:'ticker',label:'Ticker'}, {key:'companyName',label:'Company'}, {key:'quantity',label:'Shares'},
    {key:'costBasis',label:'Cost Basis'}, {key:'currentPrice',label:'Price'}, {key:'marketValue',label:'Mkt Value'},
    {key:'pctOfAccount',label:'% of Acct'},
    {key:'glPct',label:'G/L'}, {key:'yieldPct',label:'Yield'}, {key:'accountType',label:'Account'}, {key:'sector',label:'Sector'},
    {key:'industry',label:'Industry'}, {key:'assetClass',label:'Asset'}
  ];
  // Pre-compute per-account totals for percentage-of-account column
  var acctTotals = {};
  sorted.forEach(function(h){
    var mv = (h.currentPrice || 0) * h.quantity;
    var isCash = h.assetClass === 'Cash' || h.assetClass === 'Money Market' || h.assetClass === 'CD' || h.assetClass === 'Bond Position';
    if (isCash) mv = h.costBasis * h.quantity;
    var a = h.accountType || 'Individual';
    acctTotals[a] = (acctTotals[a] || 0) + mv;
  });

  let html = summaryHtml + '<table><thead><tr>' + sortableHeader(cols, _holdingsSort, null, 'manage') + '<th></th></tr></thead><tbody>';
  sorted.forEach(h => {
    const mv = (h.currentPrice || 0) * h.quantity;
    const cost = h.costBasis * h.quantity;
    const gl = mv - cost;
    const glp = cost > 0 ? (gl / cost) * 100 : 0;
    const gc = gl >= 0 ? C.success : C.danger;
    const isCash = h.assetClass === 'Cash' || h.assetClass === 'Money Market' || h.assetClass === 'CD' || h.assetClass === 'Bond Position';
    const mvDisplay = isCash ? h.costBasis * h.quantity : mv;
    const yieldVal = h.yieldPct ? h.yieldPct.toFixed(2) + '%' : '—';
    const editAge = h.lastEdited ? (Date.now() - new Date(h.lastEdited).getTime()) / (1000*60*60) : 999;
    const canUndo = h.previousVersion && editAge < 24;
    const acct = h.accountType || 'Individual';
    const pctOfAcct = acctTotals[acct] > 0 ? (mvDisplay / acctTotals[acct]) * 100 : 0;
    var acctList = '';
    if (tickerCounts[h.ticker] > 1 && tickerAccts[h.ticker]) {
      acctList = '<div style="font-size:9px;font-weight:500;color:var(--text-sec);line-height:1.3;margin-top:1px;white-space:normal;">'
        + tickerAccts[h.ticker].map(function(x, xi){ return xi === 0 ? '<strong style="color:var(--navy);" title="Primary account (largest position)">' + x.a + '</strong>' : x.a; }).join(' · ')
        + '</div>';
    }
    html += '<tr>' +
      '<td style="font-weight:700;color:' + C.navy + ';">' + h.ticker + acctList + '</td>' +
      '<td>' + h.companyName + '</td>' +
      '<td>' + (isCash ? '—' : h.quantity) + '</td>' +
      '<td>' + (isCash ? fmt(h.costBasis * h.quantity) : fmt(h.costBasis)) + '</td>' +
      '<td>' + (isCash ? '—' : fmt(h.currentPrice || 0)) + '</td>' +
      '<td style="font-weight:600;">' + fmt(mvDisplay) + '</td>' +
      '<td style="font-weight:600;color:' + C.navy + ';">' + pctOfAcct.toFixed(1) + '%</td>' +
      '<td style="color:' + (isCash ? C.textSec : gc) + ';font-weight:600;">' + (isCash ? '—' : fmtPct(glp)) + '</td>' +
      '<td style="color:' + (h.yieldPct ? C.success : C.textSec) + ';">' + yieldVal + '</td>' +
      '<td>' + acct + '</td>' +
      '<td>' + (h.sector || '—') + '</td>' +
      '<td>' + (h.industry || '—') + '</td>' +
      '<td>' + (h.assetClass || 'Equity') + '</td>' +
      '<td style="white-space:nowrap;">' +
        (canUndo ? '<button class="btn-outline btn-sm" onclick="undoEdit(\'' + h.id + '\')" title="Undo last edit" style="margin-right:2px;">&#8617;</button>' : '') +
        '<button class="btn btn-sm" onclick="editHolding(\'' + h.id + '\')" style="margin-right:3px;">Edit</button>' +
        (isCash ? '' : '<button class="btn-outline btn-sm" onclick="sellShares(\'' + h.id + '\')" title="Sell shares — proceeds are credited to a Cash position in the same account and logged" style="margin-right:3px;">Sell</button>') +
        '<button class="btn btn-danger btn-sm" onclick="deleteHolding(\'' + h.id + '\')" title="Remove without recording a sale (data correction)">&#10005;</button>' +
      '</td></tr>';
  });
  // Total row
  html += '<tr style="font-weight:700;background:var(--panel);">' +
    '<td style="color:' + C.navy + ';">TOTAL</td><td>' + sorted.length + ' positions</td>' +
    '<td></td><td></td><td></td>' +
    '<td style="color:' + C.navy + ';">' + fmt(tv) + '</td>' +
    '<td style="color:' + C.navy + ';">100.0%</td>' +
    '<td style="color:' + pctColor(tglp) + ';">' + fmtPct(tglp) + ' (' + fmt(tgl) + ')</td>' +
    '<td></td><td></td><td></td><td></td><td></td><td></td></tr>';
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

// ═══ PORTFOLIO OVERVIEW ═══
async function renderPortfolioOverview() {
  const allHoldings = window._holdings || [];
  const user = window._currentUser;
  if (!user) {
    document.getElementById('portfolioAuth').style.display = '';
    document.getElementById('portfolioEmpty').style.display = 'none';
    document.getElementById('portfolioLive').style.display = 'none';
    return;
  }
  document.getElementById('portfolioAuth').style.display = 'none';
  if (!allHoldings.length) {
    document.getElementById('portfolioEmpty').style.display = '';
    document.getElementById('portfolioLive').style.display = 'none';
    return;
  }
  document.getElementById('portfolioEmpty').style.display = 'none';
  document.getElementById('portfolioLive').style.display = '';

  // Reset lazy-load flags so tabs recompute on this dataset
  window._pfPerfRun = false;
  window._pfBrinsonRun = false;
  window._pfRiskRun = false;
  window._pfCharRun = false;
  // Do NOT reset _themesCmpInit — picker state should persist
  // But reset the comparison run flag so it re-runs on next visit
  window._themesCmpRan = false;

  // Apply account filter
  const af = document.getElementById('portfolioAccountFilter')?.value || 'all';
  const holdings = af === 'all' ? allHoldings : allHoldings.filter(h => (h.accountType || 'Individual') === af);
  if (!holdings.length) {
    document.getElementById('metricsRow').innerHTML = '<div class="empty-state" style="padding:20px;"><p>No holdings in this account.</p></div>';
    document.getElementById('benchmarkRow').innerHTML = '';
    document.getElementById('portfolioTableWrap').innerHTML = '';
    return;
  }

  // Compute totals — cash-like positions use costBasis × qty as market value (cash doesn't have a "current price")
  function mvOf(h) {
    var isCash = h.assetClass === 'Cash' || h.assetClass === 'Money Market' || h.assetClass === 'CD' || h.assetClass === 'Bond Position';
    return isCash ? (h.costBasis || 0) * h.quantity : (h.currentPrice || 0) * h.quantity;
  }
  function pvOf(h) {
    var isCash = h.assetClass === 'Cash' || h.assetClass === 'Money Market' || h.assetClass === 'CD' || h.assetClass === 'Bond Position';
    return isCash ? (h.costBasis || 0) * h.quantity : (h.previousClose || h.currentPrice || 0) * h.quantity;
  }
  const tv = holdings.reduce((s, h) => s + mvOf(h), 0);
  const tc = holdings.reduce((s, h) => s + h.costBasis * h.quantity, 0);
  const tgl = tv - tc;
  const tglp = tc > 0 ? (tgl / tc) * 100 : 0;
  const tpv = holdings.reduce((s, h) => s + pvOf(h), 0);
  const dayChg = tv - tpv;
  const dayPct = tpv > 0 ? (dayChg / tpv) * 100 : 0;

  // Metrics row
  document.getElementById('metricsRow').innerHTML =
    mcBig('Total Portfolio Value', fmtInt(tv), fmtPct(dayPct) + ' today', pctColor(dayPct)) +
    mcBig('Total Gain/Loss', fmtPct(tglp), fmt(tgl), pctColor(tgl)) +
    mcBig('Total Cost Basis', fmtInt(tc), holdings.length + ' positions', C.textSec) +
    mcBig('Day Change', fmt(dayChg), fmtPct(dayPct), pctColor(dayPct));

  // Benchmark cards
  const benchTickers = ["SPY", "QQQ", "IWM", "^VIX", "GLD", "SLV", "UUP"];
  const benchLabels = ["SPY", "QQQ", "IWM", "VIX", "GLD", "SLV", "UUP"];
  document.getElementById('benchmarkRow').innerHTML = benchLabels.map(l =>
    '<div class="bench-card" id="bench-' + l + '">' +
    '<div class="bench-label">' + l + ' (' + rangeLabel() + ')</div>' +
    '<div class="bench-value"><span class="spinner" style="width:12px;height:12px;"></span></div></div>'
  ).join('');
  fetchBenchmarkCards(benchTickers, benchLabels);

  // Tables and charts
  renderPortfolioTable(holdings, tv);
  const group = (key) => {
    const g = {};
    holdings.forEach(h => {
      const mv = mvOf(h);
      const k = h[key] || 'Other';
      g[k] = (g[k] || 0) + mv;
    });
    return Object.entries(g).map(([l, v]) => ({
      label: l,
      value: tv > 0 ? Math.round(v / tv * 100) : 0
    })).sort((a, b) => b.value - a.value);
  };
  // Render allocation charts via unified function (handles account filter + dedup)
  renderAllDonuts();
  bindTimeframeBtns();
  document.querySelectorAll('#pfTimeframeBtns .btn-outline').forEach(b => {
    b.classList.toggle('active', b.dataset.range === currentRange);
  });
  document.getElementById('btnStress').classList.toggle('active', _showStress);
  // btnVixRange removed — VIX regime now uses btnVixRegime
  renderPortfolioChart();
  // Ensure Regime Fit column reflects current state. If state is not yet classified, fire psLoadDiagnostic
  // and re-render the holdings table once state arrives.
  if (!window._briefingState && typeof psLoadDiagnostic === 'function') {
    psLoadDiagnostic().then(function(){
      if (window._briefingState && window._holdings && window._holdings.length) {
        // Recalculate total and re-render table
        var total = window._holdings.reduce(function(s, h){
          var isCashH = h.assetClass === 'Cash' || h.assetClass === 'Money Market' || h.assetClass === 'CD' || h.assetClass === 'Bond Position';
          return s + (isCashH ? h.costBasis * h.quantity : (h.currentPrice || 0) * h.quantity);
        }, 0);
        renderPortfolioTable(window._holdings, total);
      }
    }).catch(function(){});
  }
}

function mcBig(label, value, sub, subColor) {
  return '<div class="metric-card"><div class="metric-label">' + label + '</div>' +
    '<div class="metric-value" style="font-size:18px;">' + value + '</div>' +
    '<div class="metric-sub" style="color:' + subColor + ';">' + sub + '</div></div>';
}

// ═══════════════════════════════════════════════════════
// HOLDINGS PORT-MODULE — Tab Switching, KPIs, Analytics
// ═══════════════════════════════════════════════════════

var _hldTabInit = {};

// Shared tab-toggle helper used by holdings/pf/rq/macro/ca/playbook ShowTab.
// scope: CSS selector for the page (e.g. '#page-holdings')
// dataAttr: data attribute name on tab buttons (e.g. 'data-htab')
// name: tab key (e.g. 'analysis')
// contentIdPrefix: content pane id prefix (e.g. 'htab-')
function _toggleTabs(scope, dataAttr, name, contentIdPrefix) {
  document.querySelectorAll(scope + ' [' + dataAttr + ']').forEach(function(b) {
    b.classList.toggle('active', b.getAttribute(dataAttr) === name);
  });
  document.querySelectorAll(scope + ' .pf-tab-content').forEach(function(c) {
    if (c.id && c.id.indexOf(contentIdPrefix) === 0) {
      c.classList.toggle('active', c.id === contentIdPrefix + name);
    }
  });
}

function holdingsShowTab(name) {
  _toggleTabs('#page-holdings', 'data-htab', name, 'htab-');
  if (name === 'rebalance') {
    if (typeof loadRebalanceContext === 'function') loadRebalanceContext(false);
    // The Current-vs-Target bar chart previously rendered only when the drift
    // model dropdown CHANGED — on first open the canvas stayed blank (2026-07).
    setTimeout(function(){
      try { if (typeof driftRender === 'function') driftRender(); } catch(e) {}
      try { if (typeof renderHldRebalanceChart === 'function') renderHldRebalanceChart(); } catch(e) {}
    }, 250);
  }
  if (name === 'analysis' && typeof renderAccountComparison === 'function') setTimeout(function(){ renderAccountComparison(false); }, 100);
  var h = window._holdings || [];
  if (name === 'analysis') {
    if (!_hldTabInit.analysis) { _hldTabInit.analysis = true; if (h.length) renderHoldingsAnalysis(h); }
  }
  if (name === 'rebalance') {
    _hldTabInit.rebalance = true;
    if (typeof driftRender === 'function') driftRender();
    renderHldRebalanceChart();
    updateHldRiskBanner();
  }
}

function renderHoldingsKPIs(allH) {
  var C = { textSec: 'var(--text-sec)', success: 'var(--success)', danger: 'var(--danger)', amber: '#8B6914', navy: 'var(--navy)' };
  function pctColor(v) { return v > 0 ? C.success : v < 0 ? C.danger : C.textSec; }
  var acctFilter = (document.getElementById('holdingsAccountFilter') || {}).value || 'all';
  var h = acctFilter === 'all' ? allH : allH.filter(function(x){ return x.accountType === acctFilter; });
  var isCashLike = function(x) { return ['Cash','Money Market','CD','Bond Position'].includes(x.assetClass); };
  var fmt = function(v) {
    if (v == null) return '—';
    var abs = Math.abs(v);
    var s = abs >= 1000000 ? (v < 0 ? '-' : '') + '$' + (abs/1000000).toFixed(2) + 'M'
           : abs >= 1000 ? (v < 0 ? '-' : '') + '$' + (abs/1000).toFixed(1) + 'k'
           : (v < 0 ? '-' : '') + '$' + abs.toFixed(2);
    return (v > 0 ? '+' : '') + s;
  };
  var fmtV = function(v) {
    if (v == null) return '—';
    var abs = Math.abs(v);
    return abs >= 1000000 ? '$' + (abs/1000000).toFixed(2) + 'M'
         : abs >= 1000 ? '$' + (abs/1000).toFixed(1) + 'k'
         : '$' + abs.toFixed(0);
  };
  var fmtPct = function(v) { return v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%'; };

  var tv = h.reduce(function(s,x){ return s + (x.currentPrice||0)*x.quantity; }, 0);
  var costBasis = h.reduce(function(s,x){ return s + (x.costBasis||0)*x.quantity; }, 0);
  var tgl = tv - costBasis;
  var tglp = costBasis > 0 ? (tgl/costBasis)*100 : 0;
  var dayChg = h.reduce(function(s,x){
    return s + ((x.currentPrice||0) - (x.previousClose||x.currentPrice||0)) * x.quantity;
  }, 0);
  var prevTV = tv - dayChg;
  var dayPct = prevTV > 0 ? (dayChg/prevTV)*100 : 0;
  var annualIncome = h.reduce(function(s,x){
    return s + (x.currentPrice||0)*x.quantity*(x.yieldPct||0)/100;
  }, 0);
  var wtdYield = tv > 0 ? (annualIncome/tv)*100 : 0;
  var topPos = null, topPct = 0;
  h.filter(function(x){ return !isCashLike(x); }).forEach(function(x){
    var pct = tv > 0 ? ((x.currentPrice||0)*x.quantity/tv)*100 : 0;
    if (pct > topPct) { topPct = pct; topPos = x; }
  });
  var topColor = topPct > 15 ? C.danger : topPct > 10 ? C.amber : C.navy;

  var cards = [
    mcBig('Total Value', fmtV(tv), fmtPct(dayPct) + ' today', pctColor(dayPct)),
    mcBig('Total G/L', fmtPct(tglp), fmt(tgl), pctColor(tgl)),
    mcBig('Day Change', fmt(dayChg), fmtPct(dayPct), pctColor(dayPct)),
    mcBig('Positions', h.length, acctFilter === 'all' ? 'All Accounts' : acctFilter, C.textSec),
    mcBig('Annual Income', fmtV(annualIncome), fmtPct(wtdYield) + ' wtd yield', C.success),
    mcBig('Top Position', topPos ? topPos.ticker : '—', topPos ? topPct.toFixed(1) + '% of portfolio' : 'No holdings', topColor)
  ];
  var el = document.getElementById('hldKpiCards');
  if (el) el.innerHTML = cards.join('');
}

function renderHoldingsAnalysis(allH) {
  var acctFilter = (document.getElementById('holdingsAccountFilter') || {}).value || 'all';
  var h = acctFilter === 'all' ? allH : allH.filter(function(x){ return x.accountType === acctFilter; });
  var isCashLike = function(x) { return ['Cash','Money Market','CD','Bond Position'].includes(x.assetClass); };
  var tv = h.reduce(function(s,x){ return s+(x.currentPrice||0)*x.quantity; }, 0);
  if (!tv) return;

  if (!window._hldCharts) window._hldCharts = {};
  Object.keys(window._hldCharts).forEach(function(k){
    try { window._hldCharts[k].destroy(); } catch(e){}
    delete window._hldCharts[k];
  });

  var PAL = ['#003C71','#5B9BD5','#2E7D52','#8B2A2A','#8B6914','#4A90D9','#7B3F00','#1B6CA8','#A0522D','#2F4F4F','#6B3FA0','#B8860B'];

  // Chart 1 — Sector Donut
  var sectors = {};
  h.forEach(function(x){ var s = x.sector||'Unknown'; sectors[s]=(sectors[s]||0)+(x.currentPrice||0)*x.quantity; });
  var sLabels = Object.keys(sectors).sort(function(a,b){ return sectors[b]-sectors[a]; });
  var sData = sLabels.map(function(s){ return sectors[s]; });
  var sPcts = sData.map(function(v){ return tv>0?(v/tv*100).toFixed(1):'0.0'; });
  var sCtx = document.getElementById('hldSectorDonut');
  if (sCtx) {
    window._hldCharts.sector = new Chart(sCtx.getContext('2d'), {
      type:'doughnut',
      data:{ labels:sLabels, datasets:[{ data:sData, backgroundColor:sLabels.map(function(_,i){ return PAL[i%PAL.length]; }), borderWidth:2, borderColor:'#fff' }] },
      options:{ cutout:'60%', maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:function(c){ return ' '+c.label+': '+sPcts[c.dataIndex]+'%'; } } } } }
    });
    var sc = document.getElementById('hldSectorCount');
    if (sc) sc.innerHTML = sLabels.length+'<br><span style="font-size:10px;font-weight:400;">sectors</span>';
    var sl = document.getElementById('hldSectorLegend');
    if (sl) sl.innerHTML = sLabels.map(function(s,i){
      return '<div style="display:flex;align-items:center;gap:5px;margin-bottom:3px;">'
        +'<span style="width:10px;height:10px;border-radius:2px;background:'+PAL[i%PAL.length]+';flex-shrink:0;display:inline-block;"></span>'
        +'<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="'+s+'">'+s+'</span>'
        +'<span style="color:var(--text-sec);font-size:10px;flex-shrink:0;">'+sPcts[i]+'%</span></div>';
    }).join('');
  }

  // Chart 2 — Asset Class Donut
  var assets = {};
  h.forEach(function(x){
    var ac = x.assetClass || (isCashLike(x)?'Cash / Fixed Income':'Equity');
    if (['Cash','Money Market','CD','Bond Position','Fixed Income'].includes(ac)) ac='Cash / Fixed Income';
    assets[ac]=(assets[ac]||0)+(x.currentPrice||0)*x.quantity;
  });
  var aLabels = Object.keys(assets).sort(function(a,b){ return assets[b]-assets[a]; });
  var aData = aLabels.map(function(a){ return assets[a]; });
  var aPcts = aData.map(function(v){ return tv>0?(v/tv*100).toFixed(1):'0.0'; });
  var aCtx = document.getElementById('hldAssetDonut');
  if (aCtx) {
    window._hldCharts.asset = new Chart(aCtx.getContext('2d'), {
      type:'doughnut',
      data:{ labels:aLabels, datasets:[{ data:aData, backgroundColor:aLabels.map(function(_,i){ return PAL[i%PAL.length]; }), borderWidth:2, borderColor:'#fff' }] },
      options:{ cutout:'60%', maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:function(c){ return ' '+c.label+': '+aPcts[c.dataIndex]+'%'; } } } } }
    });
    var ac2 = document.getElementById('hldAssetCount');
    if (ac2) ac2.innerHTML = aLabels.length+'<br><span style="font-size:10px;font-weight:400;">classes</span>';
    var al = document.getElementById('hldAssetLegend');
    if (al) al.innerHTML = aLabels.map(function(a,i){
      return '<div style="display:flex;align-items:center;gap:5px;margin-bottom:3px;">'
        +'<span style="width:10px;height:10px;border-radius:2px;background:'+PAL[i%PAL.length]+';flex-shrink:0;display:inline-block;"></span>'
        +'<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="'+a+'">'+a+'</span>'
        +'<span style="color:var(--text-sec);font-size:10px;flex-shrink:0;">'+aPcts[i]+'%</span></div>';
    }).join('');
  }

  // Chart 3 — Top 10 Positions (horizontal bar)
  var sorted10 = h.slice().sort(function(a,b){ return (b.currentPrice||0)*b.quantity-(a.currentPrice||0)*a.quantity; }).slice(0,10);
  var tLabels = sorted10.map(function(x){ return x.ticker; });
  var tData = sorted10.map(function(x){ return tv>0?parseFloat(((x.currentPrice||0)*x.quantity/tv*100).toFixed(2)):0; });
  var tColors = tData.map(function(v){ return v>15?'rgba(139,42,42,0.85)':v>10?'rgba(139,105,20,0.85)':'rgba(0,60,113,0.85)'; });
  var tCtx = document.getElementById('hldTopBar');
  if (tCtx) {
    window._hldCharts.topBar = new Chart(tCtx.getContext('2d'), {
      type:'bar',
      data:{ labels:tLabels, datasets:[{ data:tData, backgroundColor:tColors, borderRadius:3 }] },
      options:{ indexAxis:'y', maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:function(c){ return ' '+c.parsed.x.toFixed(2)+'% of portfolio'; } } } },
        scales:{ x:{ ticks:{ callback:function(v){ return v+'%'; }, font:{size:10} }, grid:{color:'rgba(0,0,0,0.05)'} }, y:{ ticks:{font:{size:11}} } }
      }
    });
  }

  // Chart 4 — G/L Waterfall (vertical bar)
  var glH = h.filter(function(x){ return !isCashLike(x)&&x.costBasis>0&&x.currentPrice>0; });
  var glSorted = glH.slice().sort(function(a,b){
    return ((b.currentPrice-b.costBasis)*b.quantity)-((a.currentPrice-a.costBasis)*a.quantity);
  });
  var glLabels = glSorted.map(function(x){ return x.ticker; });
  var glData = glSorted.map(function(x){ return parseFloat(((x.currentPrice-x.costBasis)*x.quantity).toFixed(2)); });
  var glColors = glData.map(function(v){ return v>=0?'rgba(46,125,82,0.8)':'rgba(139,42,42,0.8)'; });
  var glCtx = document.getElementById('hldGLBar');
  if (glCtx) {
    window._hldCharts.glBar = new Chart(glCtx.getContext('2d'), {
      type:'bar',
      data:{ labels:glLabels, datasets:[{ data:glData, backgroundColor:glColors, borderRadius:3 }] },
      options:{ maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:function(c){
          var v=c.parsed.y; return ' '+(v>=0?'+':'')+v.toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0});
        } } } },
        scales:{
          x:{ ticks:{font:{size:10}, maxRotation:45} },
          y:{ ticks:{ callback:function(v){
            var a=Math.abs(v); return (v<0?'-':'')+'$'+(a>=1000?(a/1000).toFixed(1)+'k':a);
          }, font:{size:10} }, grid:{color:'rgba(0,0,0,0.05)'} }
        }
      }
    });
  }

  renderHldStoryCards(h, tv);
}

function renderHldStoryCards(h, tv) {
  var el = document.getElementById('hldStoryStrip');
  if (!el) return;
  var isCashLike = function(x){ return ['Cash','Money Market','CD','Bond Position'].includes(x.assetClass); };
  var equityH = h.filter(function(x){ return !isCashLike(x); });
  var equityMV = equityH.reduce(function(s,x){ return s+(x.currentPrice||0)*x.quantity; }, 0);

  // Story 1 — Sector drift vs SPY
  var benchWeights = window.SPY_SECTOR_WEIGHTS || {};
  var sectorMV = {};
  equityH.forEach(function(x){ var s=x.sector||'Unknown'; sectorMV[s]=(sectorMV[s]||0)+(x.currentPrice||0)*x.quantity; });
  var maxDrift=0, maxDriftSector='', maxDriftDir='';
  Object.keys(benchWeights).forEach(function(sec){
    var cur = equityMV>0?(sectorMV[sec]||0)/equityMV*100:0;
    var tgt = benchWeights[sec]||0;
    var drift = cur-tgt;
    if (Math.abs(drift)>Math.abs(maxDrift)){ maxDrift=drift; maxDriftSector=sec; maxDriftDir=drift>0?'overweight':'underweight'; }
  });
  var sc1 = Math.abs(maxDrift)>5?'warning':'info';

  // Story 2 — Largest position
  var topPct=0, topTicker='';
  equityH.forEach(function(x){
    var pct=tv>0?(x.currentPrice||0)*x.quantity/tv*100:0;
    if (pct>topPct){ topPct=pct; topTicker=x.ticker; }
  });
  var sc2 = topPct>15?'danger':topPct>10?'warning':'success';

  // Story 3 — TLH candidates
  var taxAccts = ['Individual','Joint','Trust','Custodial'];
  var tlhCount = h.filter(function(x){
    if (!taxAccts.includes(x.accountType)||isCashLike(x)) return false;
    var gl=(x.currentPrice-x.costBasis)*x.quantity;
    var glp=x.costBasis>0?(x.currentPrice-x.costBasis)/x.costBasis*100:0;
    return gl<-500&&glp<-3;
  }).length;
  var sc3 = tlhCount>0?'warning':'success';

  // Story 4 — Leveraged ETF exposure
  var levMV=0;
  h.forEach(function(x){
    var info=(window.ETF_DB&&window.ETF_DB[x.ticker])||{};
    if (info.lev) levMV+=(x.currentPrice||0)*x.quantity;
  });
  var levPct=tv>0?levMV/tv*100:0;
  var sc4=levPct>10?'danger':levPct>0?'warning':'success';

  // Story 5 — Unrealized P/L
  var totalCost=equityH.reduce(function(s,x){ return s+(x.costBasis||0)*x.quantity; },0);
  var totalMVeq=equityH.reduce(function(s,x){ return s+(x.currentPrice||0)*x.quantity; },0);
  var totalGL=totalMVeq-totalCost;
  var totalGLPct=totalCost>0?totalGL/totalCost*100:0;
  var sc5=totalGL>=0?'success':'danger';

  var fmtK = function(v){
    var a=Math.abs(v);
    return (v>0?'+':'')+(v<0?'-':'')+'$'+(a>=1000000?(a/1000000).toFixed(2)+'M':a>=1000?(a/1000).toFixed(1)+'k':a.toFixed(0));
  };

  el.innerHTML = [
    '<div class="hld-story-card '+sc1+'"><div class="sc-icon">📐</div><div class="sc-body">'
      +'<div class="sc-headline">Sector Drift (vs S&amp;P 500)</div>'
      +'<div class="sc-value">'+(maxDriftSector?maxDriftSector.replace(' Services','').replace(' Discretionary','Disc.'):'—')+'</div>'
      +'<div class="sc-explain">'+(maxDriftSector?(maxDrift>0?'+':'')+maxDrift.toFixed(1)+'% '+maxDriftDir+' vs benchmark':'Insufficient data')+'</div>'
      +'</div></div>',
    '<div class="hld-story-card '+sc2+'"><div class="sc-icon">🏆</div><div class="sc-body">'
      +'<div class="sc-headline">Largest Position</div>'
      +'<div class="sc-value">'+(topTicker||'—')+'</div>'
      +'<div class="sc-explain">'+(topTicker?topPct.toFixed(1)+'% of portfolio'+(topPct>15?' — consider trimming':topPct>10?' — concentrated':' — well-sized'):'No equity holdings')+'</div>'
      +'</div></div>',
    '<div class="hld-story-card '+sc3+'"><div class="sc-icon">🔍</div><div class="sc-body">'
      +'<div class="sc-headline">TLH Candidates</div>'
      +'<div class="sc-value">'+tlhCount+'</div>'
      +'<div class="sc-explain">'+(tlhCount?'Losses &gt;3% &amp; &gt;$500 in taxable accts — see <a href="javascript:holdingsShowTab(\'rebalance\')" style="color:var(--blue);">Rebalance</a> tab':'No significant TLH candidates')+'</div>'
      +'</div></div>',
    '<div class="hld-story-card '+sc4+'"><div class="sc-icon">&#9889;</div><div class="sc-body">'
      +'<div class="sc-headline">Leveraged ETF Exposure</div>'
      +'<div class="sc-value">'+levPct.toFixed(1)+'%</div>'
      +'<div class="sc-explain">'+(levPct>0?'Volatility drag amplified — monitor closely':'No leveraged ETFs detected')+'</div>'
      +'</div></div>',
    '<div class="hld-story-card '+sc5+'"><div class="sc-icon">'+(totalGL>=0?'📈':'📉')+'</div><div class="sc-body">'
      +'<div class="sc-headline">Unrealized P/L</div>'
      +'<div class="sc-value">'+fmtK(totalGL)+'</div>'
      +'<div class="sc-explain">'+(totalGLPct>0?'+':'')+totalGLPct.toFixed(2)+'% on cost basis</div>'
      +'</div></div>'
  ].join('');
}

function renderHldRebalanceChart() {
  var h = window._holdings || [];
  var isCashLike = function(x){ return ['Cash','Money Market','CD','Bond Position'].includes(x.assetClass); };
  var equityH = h.filter(function(x){ return !isCashLike(x); });
  var equityMV = equityH.reduce(function(s,x){ return s+(x.currentPrice||0)*x.quantity; }, 0);
  var modelEl = document.getElementById('driftModel');
  var tolEl = document.getElementById('driftTol');
  var model = modelEl?modelEl.value:'spy';
  var tol = tolEl?parseFloat(tolEl.value)||3:3;
  var targets = model==='aggressive_growth'?(window.AGGRESSIVE_GROWTH_WEIGHTS||{})
    :model==='conservative'?(window.CONSERVATIVE_WEIGHTS||{})
    :model==='balanced'?(window.BALANCED_WEIGHTS||{})
    :model==='qqq'?(window.QQQ_SECTOR_WEIGHTS||{})
    :(window.SPY_SECTOR_WEIGHTS||{});
  var sectorMV={};
  equityH.forEach(function(x){ var s=x.sector||'Unknown'; sectorMV[s]=(sectorMV[s]||0)+(x.currentPrice||0)*x.quantity; });
  var allSectors = Object.keys(targets).filter(function(s){ return (targets[s]||0)>0||(sectorMV[s]||0)>0; }).sort();
  var curPcts = allSectors.map(function(s){ return equityMV>0?parseFloat(((sectorMV[s]||0)/equityMV*100).toFixed(1)):0; });
  var tgtPcts = allSectors.map(function(s){ return targets[s]||0; });
  var bdrColors = allSectors.map(function(s,i){ return Math.abs(curPcts[i]-tgtPcts[i])>tol?'#8B2A2A':'rgba(0,0,0,0)'; });
  var ctx = document.getElementById('hldRebalanceBar');
  if (!ctx) return;
  if (!window._hldCharts) window._hldCharts={};
  if (window._hldCharts.rebalance) { try{window._hldCharts.rebalance.destroy();}catch(e){} }
  window._hldCharts.rebalance = new Chart(ctx.getContext('2d'), {
    type:'bar',
    data:{
      labels:allSectors.map(function(s){ return s.replace(' Services','').replace(' Discretionary','Disc.').replace(' Staples','Stap.'); }),
      datasets:[
        { label:'Current', data:curPcts, backgroundColor:'rgba(91,155,213,0.8)', borderColor:bdrColors, borderWidth:2 },
        { label:'Target', data:tgtPcts, backgroundColor:'rgba(0,60,113,0.6)' }
      ]
    },
    options:{
      maintainAspectRatio:false,
      plugins:{
        legend:{ position:'top', labels:{font:{size:11}} },
        tooltip:{ callbacks:{ afterBody:function(items){
          if (!items.length) return [];
          var i=items[0].dataIndex;
          var d=curPcts[i]-tgtPcts[i];
          return ['Drift: '+(d>0?'+':'')+d.toFixed(1)+'%'+(Math.abs(d)>tol?' ⚠ Outside tolerance':'')];
        }}}
      },
      scales:{
        x:{ ticks:{font:{size:9}, maxRotation:45} },
        y:{ ticks:{ callback:function(v){ return v+'%'; }, font:{size:10} }, grid:{color:'rgba(0,0,0,0.05)'} }
      }
    }
  });
}

function updateHldRiskBanner() {
  var banner = document.getElementById('hldRiskBanner');
  var empty = document.getElementById('hldRiskBannerEmpty');
  if (!banner||!empty) return;
  var profile = window._riskProfile;
  var profiles = window.RISK_PROFILES;
  if (profile && profiles && profiles[profile]) {
    var p = profiles[profile];
    banner.style.display = 'flex';
    empty.style.display = 'none';
    var badgeEl = document.getElementById('hldRiskBannerBadge');
    var labelEl = document.getElementById('hldRiskBannerLabel');
    var descEl  = document.getElementById('hldRiskBannerDesc');
    if (badgeEl) badgeEl.textContent = p.emoji||'📊';
    if (labelEl) labelEl.textContent = p.label||profile;
    if (descEl)  descEl.textContent  = p.description||('Target model: '+(p.driftModel||'spy').toUpperCase());
  } else {
    banner.style.display = 'none';
    empty.style.display = 'block';
  }
}

function holdingsApplySearch() {
  var h = window._holdings || [];
  var q = ((document.getElementById('holdingsSearch')||{}).value||'').toLowerCase().trim();
  var assetF = ((document.getElementById('holdingsAssetFilter')||{}).value||'all');
  var isCashLike = function(x){ return ['Cash','Money Market','CD','Bond Position'].includes(x.assetClass); };
  var filtered = h.filter(function(x){
    var matchQ = !q
      ||(x.ticker||'').toLowerCase().includes(q)
      ||(x.companyName||'').toLowerCase().includes(q)
      ||(x.sector||'').toLowerCase().includes(q)
      ||(x.industry||'').toLowerCase().includes(q)
      ||(x.accountType||'').toLowerCase().includes(q);
    var matchA = assetF==='all'
      ||(assetF==='equity'&&!isCashLike(x))
      ||(assetF==='cash'&&isCashLike(x));
    return matchQ&&matchA;
  });
  renderHoldingsTable(filtered);
  var countEl = document.getElementById('holdingsCount');
  if (countEl) countEl.textContent = filtered.length?(filtered.length<h.length?'('+filtered.length+' of '+h.length+' positions)':'('+h.length+' positions)'):'(no matches)';
}

function rangeLabel() {
  const m = {"1mo":"1M","3mo":"3M","6mo":"6M","ytd":"YTD","1y":"1Y","3y":"3Y","5y":"5Y","10y":"10Y","15y":"15Y","20y":"20Y"};
  return m[currentRange] || currentRange;
}

// ═══ BENCHMARK CARDS ═══
async function fetchBenchmarkCards(tickers, labels) {
  for (let i = 0; i < tickers.length; i++) {
    const label = labels[i];
    const el = document.getElementById('bench-' + label);
    if (!el) continue;
    try {
      const data = await fetchChart(tickers[i], currentRange, "1d");
      const pts = (data.points || []).filter(p => p.close !== null);
      if (pts.length < 2) { el.querySelector('.bench-value').textContent = '—'; continue; }
      const first = pts[0].close, last = pts[pts.length - 1].close;
      const ret = ((last - first) / first) * 100;
      const isVix = label === "VIX";
      const cc = pctColor(isVix ? -ret : ret);
      el.innerHTML =
        '<div class="bench-label">' + label + ' (' + rangeLabel() + ')</div>' +
        '<div class="bench-value" style="color:' + cc + ';">' + (isVix ? last.toFixed(2) : fmtPct(ret)) + '</div>' +
        '<div class="bench-sub" style="color:' + C.textSec + ';">' + (isVix ? fmtPct(ret) + ' chg' : fmt(last)) + '</div>';
    } catch(e) {
      if (el) el.querySelector('.bench-value').textContent = '—';
    }
  }
}

// ═══ PORTFOLIO TABLE (with Account, Sort, Total, Regime Fit) ═══
function renderPortfolioTable(holdings, tv, totalPortfolioTV) {
  // tv = market value of the filtered set (for within-filter % weights)
  // totalPortfolioTV = market value of the full portfolio (for % of portfolio context)
  if (!totalPortfolioTV) totalPortfolioTV = window._pfTotalTV || tv;
  const sorted = getSortedHoldings(holdings, _portfolioSort);
  const tc = sorted.reduce((s, h) => s + (h.costBasis || 0) * (h.quantity || 0), 0);
  const tgl = tv - tc;
  const tglp = tc > 0 ? (tgl / tc) * 100 : 0;
  const stateKey = window._briefingState || 'growth';
  const stateNames = {leveraged: 'Leveraged', growth: 'Non-Levered Growth', neutral: 'Neutral', drawdown: 'Positioned for Drawdown'};
  const currentStateName = stateNames[stateKey] || stateKey;

  // Pre-compute per-account totals for "% of Account" column
  var acctTotals = {};
  sorted.forEach(function(h){
    var isCashH = h.assetClass === 'Cash' || h.assetClass === 'Money Market' || h.assetClass === 'CD' || h.assetClass === 'Bond Position';
    var mv = isCashH ? h.costBasis * h.quantity : (h.currentPrice || 0) * h.quantity;
    var a = h.accountType || 'Individual';
    acctTotals[a] = (acctTotals[a] || 0) + mv;
  });

  // Build quick filter chips for sector and asset class
  const sectors = [...new Set(sorted.map(h => h.sector || 'Other').filter(Boolean))].sort();
  const assetClasses = [...new Set(sorted.map(h => h.assetClass || 'Equity').filter(Boolean))].sort();
  const chipStyle = 'display:inline-block;padding:3px 9px;border-radius:12px;font-size:11px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:var(--panel);color:var(--text-sec);margin:2px 3px 2px 0;transition:all 0.15s;';
  const chipActiveStyle = 'display:inline-block;padding:3px 9px;border-radius:12px;font-size:11px;font-weight:600;cursor:pointer;border:1px solid var(--navy);background:var(--navy);color:#fff;margin:2px 3px 2px 0;transition:all 0.15s;';

  let filterHtml = '<div style="margin-bottom:10px;padding:8px 10px;background:var(--panel);border:1px solid var(--border);border-radius:5px;">';
  filterHtml += '<div style="font-size:10.5px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px;">Quick Filters</div>';
  filterHtml += '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px;">';
  filterHtml += '<span style="font-size:10.5px;color:var(--text-sec);font-weight:600;margin-right:4px;">Sector:</span>';
  filterHtml += '<span style="' + (window._pfActiveFilter === 'all' || !window._pfActiveFilter ? chipActiveStyle : chipStyle) + '" onclick="window._pfActiveFilter=\'all\';window._pfActiveFilterType=null;renderPortfolioTable(window._holdings||(window._holdings=[]),(' + tv + '))">All</span>';
  sectors.forEach(function(s) {
    const isActive = window._pfActiveFilterType === 'sector' && window._pfActiveFilter === s;
    filterHtml += '<span style="' + (isActive ? chipActiveStyle : chipStyle) + '" onclick="window._pfActiveFilter=\'' + s.replace(/'/g,"\\'") + '\';window._pfActiveFilterType=\'sector\';pfFilterHoldings(\'sector\',\'' + s.replace(/'/g,"\\'") + '\')">' + s + '</span>';
  });
  filterHtml += '</div>';
  filterHtml += '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:4px;">';
  filterHtml += '<span style="font-size:10.5px;color:var(--text-sec);font-weight:600;margin-right:4px;">Asset Class:</span>';
  assetClasses.forEach(function(ac) {
    const isActive = window._pfActiveFilterType === 'assetClass' && window._pfActiveFilter === ac;
    filterHtml += '<span style="' + (isActive ? chipActiveStyle : chipStyle) + '" onclick="window._pfActiveFilter=\'' + ac.replace(/'/g,"\\'") + '\';window._pfActiveFilterType=\'assetClass\';pfFilterHoldings(\'assetClass\',\'' + ac.replace(/'/g,"\\'") + '\')">' + ac + '</span>';
  });
  filterHtml += '</div>';
  filterHtml += '</div>';

  const cols = [
    {key:'ticker',label:'Ticker'}, {key:'companyName',label:'Company'}, {key:'quantity',label:'Shares'},
    {key:'currentPrice',label:'Price'}, {key:'marketValue',label:'Mkt Value'},
    {key:'weight',label:'% Portfolio'}, {key:'pctOfAccount',label:'% Account'},
    {key:'glPct',label:'Gain / Loss %'},
    {key:'regimeFit',label:'Regime Fit'},
    {key:'accountType',label:'Account'}, {key:'sector',label:'Sector'}, {key:'assetClass',label:'Asset Class'}
  ];
  let html = filterHtml;
  html += '<div style="font-size:11px;color:var(--text-sec);margin-bottom:6px;">Regime Fit is scored against current state: <strong style="color:var(--navy);">' + currentStateName + '</strong>. <span style="color:var(--success);">&#10003; Aligned</span> = appropriate &middot; <span style="color:var(--warning);">&#9888; Neutral</span> = acceptable &middot; <span style="color:var(--danger);">&#10007; Misaligned</span> = consider rotating.</div>';
  html += '<table><thead><tr>' + sortableHeader(cols, _portfolioSort, null, 'portfolio') + '</tr></thead><tbody>';
  sorted.forEach(h => {
    const isCash = h.assetClass === 'Cash' || h.assetClass === 'Money Market' || h.assetClass === 'CD' || h.assetClass === 'Bond Position';
    const mv = isCash ? h.costBasis * h.quantity : (h.currentPrice || 0) * h.quantity;
    const cost = h.costBasis * h.quantity;
    const gl = mv - cost;
    const glp = cost > 0 ? (gl / cost) * 100 : 0;
    const pp = tv > 0 ? (mv / tv) * 100 : 0;
    const acct = h.accountType || 'Individual';
    const pctAcct = acctTotals[acct] > 0 ? (mv / acctTotals[acct]) * 100 : 0;
    const gc = gl >= 0 ? C.success : C.danger;
    const ad = h.leverage ? h.assetClass + ' <span style="color:' + C.warning + ';font-size:10px;">(' + h.leverage + ')</span>' : (h.assetClass || 'Equity');

    // Regime fit lookup
    var fit = (typeof rfGetFit === 'function') ? rfGetFit(h, stateKey) : null;
    var fitHtml = '<span style="color:var(--text-sec);font-size:11px;">—</span>';
    if (fit === 'good')      fitHtml = '<span class="regime-fit regime-fit-good" title="Aligned with ' + currentStateName + ' regime — appropriate to hold.">&#10003; Aligned</span>';
    else if (fit === 'warn') fitHtml = '<span class="regime-fit regime-fit-warn" title="Acceptable but not optimal for ' + currentStateName + ' regime.">&#9888; Neutral</span>';
    else if (fit === 'bad')  fitHtml = '<span class="regime-fit regime-fit-bad" title="Contradicts ' + currentStateName + ' regime posture — consider rotating.">&#10007; Misaligned</span>';

    // Hover tooltip on G/L showing the formula
    var glTooltip = isCash ? '' : ' title="Gain/Loss % = (Current Price − Cost Basis) ÷ Cost Basis. Current $' + (h.currentPrice||0).toFixed(2) + ' vs. Cost $' + (h.costBasis||0).toFixed(2) + '."';

    html += '<tr>' +
      '<td style="font-weight:700;color:' + C.navy + ';">' + h.ticker + '</td>' +
      '<td>' + h.companyName + '</td>' +
      '<td>' + (isCash ? '—' : h.quantity) + '</td>' +
      '<td>' + (isCash ? '—' : fmt(h.currentPrice || 0)) + '</td>' +
      '<td style="font-weight:600;">' + fmt(mv) + '</td>' +
      '<td>' + pp.toFixed(1) + '%</td>' +
      '<td style="font-weight:600;color:' + C.navy + ';">' + pctAcct.toFixed(1) + '%</td>' +
      '<td' + glTooltip + ' style="color:' + (isCash ? C.textSec : gc) + ';font-weight:600;cursor:' + (isCash ? 'default' : 'help') + ';">' + (isCash ? '—' : fmtPct(glp)) + '</td>' +
      '<td>' + fitHtml + '</td>' +
      '<td>' + acct + '</td>' +
      '<td>' + (h.sector || '—') + '</td>' +
      '<td>' + ad + '</td></tr>';
  });
  // Total row — note column count now 12
  html += '<tr style="font-weight:700;background:var(--panel);">' +
    '<td style="color:' + C.navy + ';">TOTAL</td><td>' + sorted.length + ' positions</td>' +
    '<td></td><td></td>' +
    '<td style="color:' + C.navy + ';">' + fmt(tv) + '</td><td>100.0%</td>' +
    '<td style="color:' + C.navy + ';">—</td>' +
    '<td style="color:' + pctColor(tglp) + ';">' + fmtPct(tglp) + ' (' + fmt(tgl) + ')</td>' +
    '<td></td><td></td><td></td><td></td></tr>';
  html += '</tbody></table>';
  document.getElementById('portfolioTableWrap').innerHTML = html;
}

// ═══ STRESSED SCENARIOS, VIX, & REGIME OVERLAYS ═══
let _showStress = false;
let _showVixRange = false;
let _showRegimeOverlay = false;
let _vixDateMap = {};
let _regimeByDate = {};   // populated when chart renders
let _spyDateMap = {};
let _chartDatesGlobal = [];

// Helper: update a toggle button and trigger chart redraw
function _pfOverlayToggle(varSetter, btnId) {
  varSetter();
  // Sync all button states
  var btnMap = {
    btnStress: _showStress,
    btnRegimeOverlay: _showRegimeOverlay,
    btnVixRegime: window._showVixRegime
  };
  // Also update btnVixRange if it exists (legacy button name)
  Object.keys(btnMap).forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.classList.toggle('active', !!btnMap[id]);
  });
  // Redraw chart — use window reference which is always available
  if (window.portfolioLineChart) window.portfolioLineChart.update('none');
}

window.toggleStress = function() {
  _showStress = !_showStress;
  var btn = document.getElementById('btnStress');
  if (btn) btn.classList.toggle('active', _showStress);
  // Re-render so any missing data is fetched
  if (typeof renderPortfolioChart === 'function') {
    renderPortfolioChart();
  } else if (window.portfolioLineChart) {
    window.portfolioLineChart.update('none');
  }
};

// toggleVixRange is the OLD function name (still referenced in older code)
window.toggleVixRange = function() {
  // Map to new VIX regime toggle for backwards compat
  window.toggleVixRegime();
};

window.toggleRegimeOverlay = function() {
  _showRegimeOverlay = !_showRegimeOverlay;
  var btn = document.getElementById('btnRegimeOverlay');
  if (btn) btn.classList.toggle('active', _showRegimeOverlay);
  if (typeof renderPortfolioChart === 'function') {
    renderPortfolioChart();
  } else if (window.portfolioLineChart) {
    window.portfolioLineChart.update('none');
  }
};

// VIX Regime toggle — syncs both vars for plugin, triggers full re-render
// (VIX data in _vixDateMap only exists after renderPortfolioChart runs,
//  so we must call renderPortfolioChart not just chart.update)
window.toggleVixRegime = function() {
  window._showVixRegime = !window._showVixRegime;
  _showVixRange = window._showVixRegime; // keep old var in sync — plugin checks _showVixRange
  var btn = document.getElementById('btnVixRegime');
  if (btn) btn.classList.toggle('active', window._showVixRegime);
  // Must re-render (not just update) so VIX data is fetched for the chart window
  if (typeof renderPortfolioChart === 'function') {
    renderPortfolioChart();
  } else if (window.portfolioLineChart) {
    window.portfolioLineChart.update('none');
  }
};

const STRESS_EVENTS = [
  { start: "2001-03-01", end: "2001-11-30", type: "recession", name: "Dot-Com Bust" },
  { start: "2007-12-01", end: "2009-06-30", type: "recession", name: "Great Financial Crisis" },
  { start: "2010-04-23", end: "2010-07-02", type: "correction", name: "Flash Crash" },
  { start: "2011-07-22", end: "2011-10-03", type: "correction", name: "US Debt Downgrade" },
  { start: "2015-08-10", end: "2016-02-11", type: "correction", name: "China / Oil Crash" },
  { start: "2018-01-26", end: "2018-02-08", type: "correction", name: "Volmageddon" },
  { start: "2018-10-03", end: "2018-12-24", type: "correction", name: "Fed Tightening" },
  { start: "2020-02-19", end: "2020-04-07", type: "recession", name: "COVID-19" },
  { start: "2022-01-03", end: "2022-10-12", type: "correction", name: "Inflation / Rate Hikes" },
  { start: "2023-07-31", end: "2023-10-27", type: "correction", name: "Bond Selloff" },
  { start: "2025-02-19", end: "2025-04-08", type: "correction", name: "Tariff Shock" }
];
const VIX_EVENTS = [
  { start: "2008-09-15", end: "2009-03-31", name: "Lehman / GFC" },
  { start: "2010-05-06", end: "2010-06-30", name: "Flash Crash" },
  { start: "2011-08-01", end: "2011-10-15", name: "Debt Ceiling" },
  { start: "2020-02-24", end: "2020-05-15", name: "COVID Panic" },
  { start: "2022-01-20", end: "2022-03-15", name: "Ukraine" },
  { start: "2025-03-10", end: "2025-04-15", name: "Tariff VIX Spike" }
];

function getStressEventForDate(d) { for (const e of STRESS_EVENTS) { if (d >= e.start && d <= e.end) return e; } return null; }
function getVixEventForDate(d) { for (const e of VIX_EVENTS) { if (d >= e.start && d <= e.end) return e; } return null; }

function drawRegion(ctx, xScale, si, ei, top, bottom, ev) {
  const gp = function(idx) { try { var p = xScale.getPixelForValue(idx); return isNaN(p) ? null : p; } catch(e){ return null; } };
  const x1 = gp(si), x2 = gp(Math.max(si, ei));
  if (x1 === null || x2 === null) return;
  const w = Math.abs(x2 - x1);
  if (w < 1) return;
  ctx.fillStyle = ev.type === 'recession' ? 'rgba(139,42,42,0.12)' : 'rgba(200,208,216,0.25)';
  ctx.fillRect(Math.min(x1,x2), top, w, bottom - top);
  if (w > 30) {
    ctx.fillStyle = ev.type === 'recession' ? 'rgba(139,42,42,0.7)' : 'rgba(90,106,122,0.7)';
    ctx.font = (w > 80 ? '600 10px' : '600 8px') + ' Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(w > 80 ? ev.name : ev.name.split(' ')[0], Math.min(x1,x2) + w / 2, top + 4, w - 4);
  }
}
function drawVixRegion(ctx, xScale, si, ei, top, bottom, zone, name) {
  // Robust pixel calculation that works with both category and linear scales
  const safePixel = function(idx) {
    try {
      var px = xScale.getPixelForValue(idx);
      return isNaN(px) ? null : px;
    } catch(e) { return null; }
  };
  const x1 = safePixel(si);
  const x2 = safePixel(Math.max(si, ei));
  if (x1 === null || x2 === null) return;
  const w = Math.abs(x2 - x1);
  if (w < 1) return;
  // Four VIX zones — brand-aligned matte colors
  const zoneColors = {
    calm:     'rgba(46,125,82,0.10)',    // green  — VIX < 15
    normal:   'rgba(91,155,213,0.09)',   // blue   — VIX 15-20
    elevated: 'rgba(139,105,20,0.16)',   // amber  — VIX 20-30
    high:     'rgba(139,42,42,0.20)'     // red    — VIX > 30
  };
  const labelColors = {
    calm: 'rgba(46,125,82,0.7)', normal: 'rgba(0,60,113,0.6)',
    elevated: 'rgba(139,105,20,0.8)', high: 'rgba(139,42,42,0.85)'
  };
  ctx.fillStyle = zoneColors[zone] || 'rgba(91,155,213,0.10)';
  ctx.fillRect(Math.min(x1, x2), top, w, bottom - top);
  if (name && w > 50) {
    ctx.fillStyle = labelColors[zone] || 'rgba(0,0,0,0.5)';
    ctx.font = '600 9px Arial,Helvetica,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const label = name.length > 14 ? name.slice(0, 14) : name;
    ctx.fillText(label, Math.min(x1, x2) + w / 2, top + 3, w - 6);
  }
}

function drawRegimeRegion(ctx, xScale, si, ei, top, bottom, regime) {
  const safePixel = (idx) => { try { var p = xScale.getPixelForValue(idx); return isNaN(p) ? null : p; } catch(e){ return null; } };
  const colors = {
    leveraged: { bg: 'rgba(46,125,82,0.12)',  text: 'rgba(46,125,82,0.8)',  label: 'Leveraged' },
    growth:    { bg: 'rgba(0,60,113,0.10)',   text: 'rgba(0,60,113,0.85)',  label: 'Growth' },
    neutral:   { bg: 'rgba(139,105,20,0.12)', text: 'rgba(139,105,20,0.85)',label: 'Neutral' },
    drawdown:  { bg: 'rgba(139,42,42,0.14)',  text: 'rgba(139,42,42,0.85)', label: 'Drawdown' }
  };
  const c = colors[regime] || colors.growth;
  const x1 = xScale.getPixelForValue(si);
  const x2 = xScale.getPixelForValue(ei);
  const w = x2 - x1;
  ctx.fillStyle = c.bg;
  ctx.fillRect(x1, top, w, bottom - top);
  if (w > 30) {
    ctx.fillStyle = c.text;
    ctx.font = (w > 80 ? '600 10px' : '600 8px') + ' Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(w > 80 ? c.label : c.label.slice(0, 4), x1 + w / 2, top + 4, w - 4);
  }
}

// Custom Chart.js plugin for overlays
// IMPORTANT: Only fires on the portfolio line chart — never on any other Chart instance
const overlayPlugin = {
  id: 'stressVixOverlay',
  afterDatasetsDraw(chart) {
    // Guard: only operate on the portfolio chart canvas
    if (!chart.canvas || chart.canvas.id !== 'portfolioLineChart') return;
    if (!_showStress && !_showVixRange && !_showRegimeOverlay && !window._showVixRegime) return;
    const area = chart.chartArea;
    if (!area || !area.left) return;
    const x = chart.scales.x;
    if (!x) return;
    const dates = _chartDatesGlobal;
    if (!dates || !dates.length) return;
    const { top, bottom } = area;
    const ctx = chart.ctx;
    ctx.save();
    try {
      if (_showRegimeOverlay) {
        let cr = null, rs = null;
        for (let i = 0; i < dates.length; i++) {
          const r = _regimeByDate[dates[i]] || cr; // forward-fill missing dates
          if (r && r !== cr) {
            if (cr && rs !== null) drawRegimeRegion(ctx, x, rs, i, top, bottom, cr); // end at i not i-1 (no gap)
            cr = r; rs = i;
          } else if (!r && cr) {
            // keep cr going (forward-fill) — don't break the band
            // drawRegimeRegion called at state change only
          }
        }
        if (cr && rs !== null) drawRegimeRegion(ctx, x, rs, dates.length - 1, top, bottom, cr);
      }
      if (_showStress) {
        let ce = null, rs = null;
        for (let i = 0; i < dates.length; i++) {
          const ev = getStressEventForDate(dates[i]);
          if (ev && ev !== ce) {
            if (ce && rs !== null) drawRegion(ctx, x, rs, i - 1, top, bottom, ce);
            ce = ev; rs = i;
          } else if (!ev && ce) {
            drawRegion(ctx, x, rs, i - 1, top, bottom, ce);
            ce = null; rs = null;
          }
        }
        if (ce && rs !== null) drawRegion(ctx, x, rs, dates.length - 1, top, bottom, ce);
      }
      if (_showVixRange) {
        // Four-zone VIX classification — every date gets a zone, no gaps
        function vixZone(v) {
          if (v == null) return null;
          if (v >= 30) return 'high';
          if (v >= 20) return 'elevated';
          if (v >= 15) return 'normal';
          return 'calm';
        }
        function vixZoneName(zone, vix) {
          var labels = { calm: 'VIX <15 (Calm)', normal: 'VIX 15-20', elevated: 'VIX 20-30', high: 'VIX >30 (Stress)' };
          return labels[zone] || ('VIX ' + (vix||'').toFixed(0));
        }
        let cz = null, zs = 0;
        // Pre-fill first zone
        cz = vixZone(_vixDateMap[dates[0]]);
        for (let i = 1; i < dates.length; i++) {
          const z = vixZone(_vixDateMap[dates[i]]);
          if (z !== cz) {
            // Close current band (draw from zs to i-1)
            if (cz != null) {
              const sampleVix = _vixDateMap[dates[zs]];
              drawVixRegion(ctx, x, zs, i - 1, top, bottom, cz, vixZoneName(cz, sampleVix));
            }
            cz = z; zs = i;
          }
        }
        // Draw final band
        if (cz != null) {
          const sampleVix = _vixDateMap[dates[zs]];
          drawVixRegion(ctx, x, zs, dates.length - 1, top, bottom, cz, vixZoneName(cz, sampleVix));
        }
      }
    } catch(e) { /* ignore errors during transitions */ }

    // ── Overlay Legend ── (shown in top-right of chart area)
    try {
      var legendItems = [];
      if (_showRegimeOverlay) {
        legendItems.push({ color: 'rgba(46,125,82,0.7)', label: 'Leveraged' });
        legendItems.push({ color: 'rgba(0,60,113,0.6)', label: 'Growth' });
        legendItems.push({ color: 'rgba(139,105,20,0.7)', label: 'Neutral' });
        legendItems.push({ color: 'rgba(139,42,42,0.7)', label: 'Drawdown' });
      }
      if (_showVixRange) {
        legendItems.push({ color: 'rgba(46,125,82,0.7)', label: 'VIX <15' });
        legendItems.push({ color: 'rgba(0,60,113,0.6)', label: 'VIX 15-20' });
        legendItems.push({ color: 'rgba(139,105,20,0.8)', label: 'VIX 20-30' });
        legendItems.push({ color: 'rgba(139,42,42,0.85)', label: 'VIX >30' });
      }
      if (_showStress) {
        legendItems.push({ color: 'rgba(139,42,42,0.35)', label: 'Recession' });
        legendItems.push({ color: 'rgba(139,105,20,0.25)', label: 'Correction' });
      }
      if (legendItems.length) {
        const lx = area.right - 4;
        const ly = area.top + 4;
        const lh = 14;
        const lpad = 6;
        const lw = 120;
        ctx.fillStyle = 'rgba(255,255,255,0.88)';
        ctx.fillRect(lx - lw - lpad, ly - 2, lw + lpad * 2, legendItems.length * lh + 6);
        ctx.strokeStyle = 'rgba(208,215,224,0.8)';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(lx - lw - lpad, ly - 2, lw + lpad * 2, legendItems.length * lh + 6);
        legendItems.forEach(function(item, idx) {
          const iy = ly + idx * lh + 3;
          ctx.fillStyle = item.color;
          ctx.fillRect(lx - lw - lpad + 4, iy, 10, 9);
          ctx.fillStyle = 'rgba(0,0,0,0.75)';
          ctx.font = '9px Arial,Helvetica,sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(item.label, lx - lw - lpad + 18, iy + 4.5);
        });
      }
    } catch(e) {}

    ctx.restore();
  }
};
Chart.register(overlayPlugin);

// ═══ PORTFOLIO CHART ═══
let _chartPortfolioSeries = [];
let _chartBenchmarkSeries = {};

window.renderPortfolioChart = async function() {
  const allH = window._holdings || [];
  if (!allH.length) return;
  // Account scope: the chart's own dropdown (Accounts:) wins; falls back to
  // the page-level filter. 'all' = aggregate of every account type.
  const afChart = window._pfChartAccount || document.getElementById('pfChartAccountSel')?.value;
  const af = (afChart && afChart !== '') ? afChart : (document.getElementById('portfolioAccountFilter')?.value || 'all');
  const holdings = af === 'all' ? allH : allH.filter(h => (h.accountType || 'Individual') === af);
  if (!holdings.length) return;

  const loadEl = document.getElementById('chartLoading');
  loadEl.style.display = 'block';
  document.getElementById('chartStats').innerHTML = '';

  // ── Determine effective date window based on currentRange ──
  // This bounds the chart to what the user actually asked for, regardless of
  // each ticker's inception date or user purchase date.
  var today = new Date();
  var effectiveStart = null;
  var r = currentRange;
  if (r === '1mo') { effectiveStart = new Date(today); effectiveStart.setMonth(today.getMonth() - 1); }
  else if (r === '3mo') { effectiveStart = new Date(today); effectiveStart.setMonth(today.getMonth() - 3); }
  else if (r === '6mo') { effectiveStart = new Date(today); effectiveStart.setMonth(today.getMonth() - 6); }
  else if (r === 'ytd') { effectiveStart = new Date(today.getFullYear(), 0, 1); }
  else if (r === '1y') { effectiveStart = new Date(today); effectiveStart.setFullYear(today.getFullYear() - 1); }
  else if (r === '3y') { effectiveStart = new Date(today); effectiveStart.setFullYear(today.getFullYear() - 3); }
  else if (r === '5y') { effectiveStart = new Date(today); effectiveStart.setFullYear(today.getFullYear() - 5); }
  else if (r === '10y') { effectiveStart = new Date(today); effectiveStart.setFullYear(today.getFullYear() - 10); }
  else if (r === '15y') { effectiveStart = new Date(today); effectiveStart.setFullYear(today.getFullYear() - 15); }
  else if (r === '20y') { effectiveStart = new Date(today); effectiveStart.setFullYear(today.getFullYear() - 20); }
  var effectiveStartStr = effectiveStart ? effectiveStart.toISOString().slice(0,10) : null;

  // Fetch historical data — in parallel for speed
  const hs = {};
  // Helper: determine cash-like
  function isCashH(x) { return x.assetClass === 'Cash' || x.assetClass === 'Money Market' || x.assetClass === 'CD' || x.assetClass === 'Bond Position'; }
  await Promise.all(holdings.map(async function(h){
    if (isCashH(h)) {
      // Cash has no historical price; treat as constant value from purchase date
      hs[h.ticker + '|' + (h.accountType||'Individual')] = {
        isCash: true,
        cashValue: (h.costBasis || 0) * h.quantity,
        quantity: h.quantity,
        datePurchased: h.datePurchased || null,
        ticker: h.ticker,
        map: {}
      };
      return;
    }
    try {
      const d = await fetchChart(h.ticker, currentRange, "1d");
      const pts = (d.points || []).filter(p => p.close !== null);
      const m = {};
      pts.forEach(p => { m[p.date.slice(0, 10)] = p.close; });
      hs[h.ticker + '|' + (h.accountType||'Individual')] = {
        map: m,
        quantity: h.quantity,
        datePurchased: h.datePurchased || null,
        ticker: h.ticker,
        isCash: false
      };
    } catch(e) {
      console.warn('[portfolio chart] fetchChart failed for ' + h.ticker + ' (range='+currentRange+'):', e.message);
    }
  }));

  // Fetch VIX and SPY upfront — SPY drives the x-axis trading-day calendar
  // so the chart spans the full selected window even if the user's portfolio is shorter.
  try {
    const vD = await fetchChart("^VIX", currentRange, "1d");
    const vP = (vD.points || []).filter(p => p.close !== null);
    _vixDateMap = {};
    vP.forEach(p => { _vixDateMap[p.date.slice(0, 10)] = p.close; });
  } catch(e) { _vixDateMap = {}; }

  try {
    // Always fetch enough SPY history to span the selected window AND have 252 prior
    // trading days for the regime classifier
    var spyRange = currentRange;
    if (['1mo','3mo','6mo','ytd','1y'].indexOf(currentRange) >= 0) spyRange = '2y';
    const sD = await fetchChart("SPY", spyRange, "1d");
    const sP = (sD.points || []).filter(p => p.close !== null);
    _spyDateMap = {};
    sP.forEach(p => { _spyDateMap[p.date.slice(0, 10)] = p.close; });
    var spyDatesArr = sP.map(function(p){return p.date.slice(0,10);}).sort();
    var spyClosesArr = spyDatesArr.map(function(d){return _spyDateMap[d];});
    _regimeByDate = {};
    for (var i = 0; i < spyDatesArr.length; i++) {
      var d2 = spyDatesArr[i];
      var px2 = spyClosesArr[i];
      if (i < 252) continue;
      var lookbackSlice = spyClosesArr.slice(i - 252, i + 1);
      var spyHigh2 = Math.max.apply(null, lookbackSlice);
      var spyLow2 = Math.min.apply(null, lookbackSlice);
      var spy12mAgo = spyClosesArr[i - 252];
      var vix2 = _vixDateMap[d2];
      if (vix2 == null) continue;
      var sig2 = {
        vix: vix2,
        spyTrailingReturn: (px2 - spy12mAgo) / spy12mAgo,
        drawdownFromPeak: (px2 - spyHigh2) / spyHigh2,
        spy12mFromLow: (px2 - spyLow2) / spyLow2
      };
      if (typeof psClassifyState === 'function') {
        var cl2 = psClassifyState(sig2);
        _regimeByDate[d2] = cl2.winner;
      }
    }
  } catch(e) { _regimeByDate = {}; _spyDateMap = {}; }

  // Build union of all dates HOLDINGS observe (used for forward-fill source data only;
  // does NOT determine the chart x-axis — that is set by the selected window using SPY's
  // trading-day calendar so benchmarks and overlays span the full window even when the
  // user's portfolio is much shorter).
  const ad = new Set();
  Object.values(hs).forEach(function(s){
    if (s.isCash) return;
    Object.keys(s.map).forEach(function(d){ ad.add(d); });
  });
  const holdingDates = Array.from(ad).sort();

  // Determine the earliest date where the user actually owned ANY of their current holdings
  // (used to mask the portfolio line — values before this are null so the chart shows a gap)
  var earliestOwnedDate = null;
  Object.values(hs).forEach(function(s){
    if (!s.datePurchased) return;
    if (!earliestOwnedDate || s.datePurchased < earliestOwnedDate) earliestOwnedDate = s.datePurchased;
  });
  var hasUndatedHolding = Object.values(hs).some(function(s){ return !s.datePurchased; });
  if (hasUndatedHolding) earliestOwnedDate = null;

  // Forward-fill missing prices so weekend gaps don't create artificial drops
  Object.values(hs).forEach(function(s){
    if (s.isCash) return;
    s._forwardFilled = {};
    var lastSeen = null;
    for (var i=0;i<holdingDates.length;i++) {
      var d = holdingDates[i];
      if (s.map[d] != null) lastSeen = s.map[d];
      s._forwardFilled[d] = lastSeen;
    }
  });

  // Helper: portfolio value at date d (uses forward-filled prices, returns null pre-purchase)
  function portfolioValueAt(d) {
    if (earliestOwnedDate && d < earliestOwnedDate) return null;
    var t = 0;
    var anyPriced = false;
    Object.values(hs).forEach(function(s){
      if (s.datePurchased && d < s.datePurchased) return;
      if (s.isCash) { t += s.cashValue; anyPriced = true; }
      else {
        var px = s._forwardFilled[d];
        if (px != null) { t += px * s.quantity; anyPriced = true; }
      }
    });
    if (!anyPriced) return null;
    return t > 0 ? t : null;
  }

  // ── Build the chart x-axis ──
  // Goal: x-axis = the FULL selected window (e.g., 20Y). Use SPY trading-day calendar so
  // we get clean weekday-only dates. Benchmarks and overlays span the whole window;
  // the portfolio line shows nulls before first purchase, real values after.
  var xAxisDates = [];
  if (_spyDateMap && Object.keys(_spyDateMap).length) {
    // _spyDateMap was populated by the regime overlay fetch above. Filter to selected window.
    xAxisDates = Object.keys(_spyDateMap).sort().filter(function(d){
      return !effectiveStartStr || d >= effectiveStartStr;
    });
  }
  // Fallback: if SPY didn't load, fall back to the holding date union (legacy behavior)
  if (!xAxisDates.length) {
    xAxisDates = holdingDates.filter(function(d){ return !effectiveStartStr || d >= effectiveStartStr; });
  }
  if (!xAxisDates.length) { loadEl.style.display = 'none'; return; }

  // Build portfolio value series across the full x-axis (nulls before first purchase)
  var pvFull = xAxisDates.map(function(d){ return portfolioValueAt(d); });

  // Downsample for performance on very long windows (5Y+ = a lot of points)
  var targetMax = 800;
  var reducedDates = xAxisDates;
  var reducedPV = pvFull;
  if (xAxisDates.length > targetMax) {
    var stride = Math.ceil(xAxisDates.length / targetMax);
    reducedDates = xAxisDates.filter(function(_, i){ return i % stride === 0 || i === xAxisDates.length - 1; });
    reducedPV = reducedDates.map(function(d){ return portfolioValueAt(d); });
  }

  const cd = reducedDates;
  let cv = reducedPV.slice(); // clone so pct mode doesn't mutate original
  _chartDatesGlobal = cd;
  _chartPortfolioSeries = reducedPV; // always keep dollar values

  // ── % Change Axis Mode: rebase to 100 at first non-null value ──
  if (window._pctAxisMode) {
    const pfBase = cv.find(v => v != null && v > 0) || 1;
    cv = cv.map(v => v != null ? v / pfBase * 100 : null);
  }

  // Compute portfolio start/end (first and last non-null values) for stats row
  var pfFirstNonNullIdx = cv.findIndex(function(v){ return v != null; });
  var pfLastNonNullIdx = -1;
  for (var i = cv.length - 1; i >= 0; i--) { if (cv[i] != null) { pfLastNonNullIdx = i; break; } }
  if (pfFirstNonNullIdx === -1) { loadEl.style.display = 'none'; return; }

  const pfS_first = cv[pfFirstNonNullIdx], pfS = pfS_first;
  const pfE = cv[pfLastNonNullIdx];

  // ─────────────────────────────────────────────────────────────────────
  // TIME-WEIGHTED RETURN (TWR) — strips out deposits/withdrawals so the
  // user can see real performance vs benchmarks without confounded "alpha"
  // from money being added. This is the GIPS / industry-standard method.
  //
  // Detection of cash flows (deposits/withdrawals) — uses BOTH:
  //   1. Holding purchase dates: when a new holding first becomes valued, that's
  //      treated as a deposit equal to its first-day market value.
  //   2. Auto-detect: any single-day jump > 5% of prior value AND > $1,000 is
  //      flagged as a likely deposit (catches manual cash moves, dividends
  //      reinvested, etc.). Tunable via _twrJumpThreshold.
  // ─────────────────────────────────────────────────────────────────────
  // Build a per-date set of "expected deposit dates" from holding purchase dates
  var depositDates = new Set();
  Object.values(hs).forEach(function(s){
    if (!s.datePurchased) return;
    // Find the first chart date >= datePurchased
    var firstIdx = cd.findIndex(function(d){ return d >= s.datePurchased; });
    if (firstIdx >= 0) depositDates.add(cd[firstIdx]);
  });
  // Also flag the very first non-null point as a "deposit" (initial funding)
  depositDates.add(cd[pfFirstNonNullIdx]);

  // Build TWR series — rebased so it starts at the same dollar value as the
  // portfolio at its first non-null point. That way both lines start in the
  // same place visually and the TWR shows what the portfolio would have grown to
  // if the user had simply held what they had at start (no deposits).
  var twrSeries = new Array(cv.length).fill(null);
  var rebaseStart = cv[pfFirstNonNullIdx];
  twrSeries[pfFirstNonNullIdx] = rebaseStart;
  // In pct mode, rebaseStart is already 100 (we keep it)
  var compoundFactor = 1.0;
  var _twrJumpThreshold = 0.05;  // 5% single-day move
  var _twrDollarThreshold = 1000; // $1K minimum to flag
  var detectedDeposits = []; // for tooltip
  for (var i = pfFirstNonNullIdx + 1; i <= pfLastNonNullIdx; i++) {
    var prev = cv[i - 1];
    var curr = cv[i];
    if (prev == null || curr == null || prev <= 0) {
      // Carry forward TWR through gaps
      twrSeries[i] = twrSeries[i - 1];
      continue;
    }
    var rawReturn = (curr - prev) / prev;
    var dollarChange = curr - prev;
    // Detect: known purchase date, OR auto-detected jump
    var isDeposit = depositDates.has(cd[i]) ||
      (Math.abs(rawReturn) > _twrJumpThreshold && Math.abs(dollarChange) > _twrDollarThreshold);
    if (isDeposit) {
      // Skip this period — assume the change is entirely from external cash flow,
      // not market performance. TWR carries forward unchanged.
      twrSeries[i] = twrSeries[i - 1];
      detectedDeposits.push({ date: cd[i], dollarChange: dollarChange, rawReturn: rawReturn });
    } else {
      compoundFactor *= (1 + rawReturn);
      twrSeries[i] = rebaseStart * compoundFactor;
    }
  }

  const twrModeOn = !!window._twrModeOnly;
  const ds = [{
    label: 'Portfolio (Total Value, with deposits)',
    data: cv, borderColor: C.navy, backgroundColor: 'rgba(0,60,113,.06)',
    borderWidth: twrModeOn ? 0 : 2.5, pointRadius: twrModeOn ? 0 : 1, pointHoverRadius: twrModeOn ? 0 : 6,
    pointBackgroundColor: C.navy, pointHoverBackgroundColor: C.navy,
    fill: !twrModeOn, tension: .3, yAxisID: 'y', spanGaps: false,
    hidden: twrModeOn
  }, {
    label: twrModeOn ? 'Portfolio (Time-Weighted Return)' : 'Portfolio (TWR, deposits stripped)',
    data: twrSeries,
    borderColor: twrModeOn ? C.navy : '#2E7D52',
    backgroundColor: twrModeOn ? 'rgba(0,60,113,.06)' : 'transparent',
    borderWidth: twrModeOn ? 2.5 : 2, borderDash: twrModeOn ? [] : [4, 3],
    pointRadius: twrModeOn ? 1 : 0, pointHoverRadius: 5,
    pointBackgroundColor: twrModeOn ? C.navy : '#2E7D52',
    fill: twrModeOn, tension: .3, yAxisID: 'y', spanGaps: false,
    hidden: !twrModeOn
  }];

  // Stash for tooltip
  window._twrDeposits = detectedDeposits;
  window._twrSeries = twrSeries;

  // Benchmarks
  _chartBenchmarkSeries = {};
  var _pfVolume = {};
  const ci = [
    document.getElementById('compare1').value.trim().toUpperCase(),
    document.getElementById('compare2').value.trim().toUpperCase()
  ].filter(Boolean);
  const cc2 = [C.blue, C.blueLight];
  for (let i = 0; i < ci.length; i++) {
    const sym = ci[i];
    try {
      const d = await fetchChart(sym, currentRange, "1d");
      const pts = (d.points || []).filter(p => p.close !== null);
      if (pts.length > 1) {
        const pm = {};
        pts.forEach(p => { pm[p.date.slice(0, 10)] = p.close; if (i === 0 && p.volume) _pfVolume[p.date.slice(0,10)] = p.volume; });
        _chartBenchmarkSeries[sym] = pm;
        // Add benchmark on right axis (raw price) AND rebased on left axis
        ds.push({
          label: sym, data: cd.map(d => pm[d] != null ? pm[d] : null),
          borderColor: cc2[i], borderWidth: 2, pointRadius: 1, pointHoverRadius: 5,
          pointBackgroundColor: cc2[i], pointHoverBackgroundColor: cc2[i],
          fill: false, tension: .3, spanGaps: true, yAxisID: 'y1',
          hidden: !!window._benchmarksHidden
        });
        // Rebased benchmark for direct visual comparison on left axis.
        // 2026-07: only rendered in TWR mode (or % axis mode, which is the
        // same normalized concept). In plain dollar view the chart now shows
        // ONLY the benchmark's actual historical price on the right axis.
        const bmValidIdx = cd.findIndex(d => pm[d] != null);
        if (bmValidIdx >= 0 && (window._twrModeOnly || window._pctAxisMode)) {
          const bmStartPrice = pm[cd[bmValidIdx]];
          // In pct mode: rebase benchmark to 100 so it shares the same Y axis as portfolio
          // In dollar mode: scale to match portfolio starting value
          const bmStartPortVal = cv[bmValidIdx] || cv[pfFirstNonNullIdx];
          const bmScaleBase = window._pctAxisMode ? 100 : bmStartPortVal;
          if (bmStartPrice && bmStartPortVal) {
            const rebasedBM = cd.map(d => pm[d] != null ? pm[d] / bmStartPrice * bmScaleBase : null);
            ds.push({
              label: sym + ' (rebased)', data: rebasedBM,
              borderColor: cc2[i], borderWidth: 1.5, borderDash: [5,3],
              pointRadius: 0, fill: false, tension: .3, spanGaps: true,
              // In pct mode, benchmarks rebased to 100 — use same y axis as portfolio
              yAxisID: window._pctAxisMode ? 'y' : 'y',
              pointHoverRadius: 4, backgroundColor: 'transparent',
              hidden: !!window._benchmarksHidden
            });
          }
        }
      }
    } catch(e) {}
  }
  // Volume bars from primary benchmark
  var volData = cd.map(function(d) { return _pfVolume[d] || 0; });
  var maxVol = Math.max.apply(null, volData.length ? volData : [1]);
  if (maxVol > 0) {
    ds.push({
      label: 'Volume', data: volData, type: 'bar',
      backgroundColor: 'rgba(200,208,216,0.35)', borderWidth: 0,
      yAxisID: 'yVol', order: 10, barPercentage: 0.8, categoryPercentage: 1.0
    });
  }

  // ── Watchlist / Trial Portfolio overlay ──
  if (window._watchlistMode && window._watchlistTickers && window._watchlistTickers.length) {
    try {
      var wlSeries = await watchlistBuildSeries(currentRange);
      if (wlSeries && wlSeries.dates.length) {
        // Rebase watchlist to same start dollar-value as the portfolio for visual alignment
        // Since watchlist is already rebased to 100, scale it to match portfolio starting value
        var pfStartVal = null;
        for (var _wi = 0; _wi < cv.length; _wi++) { if (cv[_wi] != null) { pfStartVal = cv[_wi]; break; } }
        var scaleFactor = pfStartVal != null ? pfStartVal / 100 : 1;
        // Map watchlist dates to chart date array (cd)
        var wlDateMap = {};
        wlSeries.dates.forEach(function(d, i){ wlDateMap[d] = wlSeries.values[i]; });
        var wlData = cd.map(function(d) {
          var v = wlDateMap[d];
          return v != null ? v * scaleFactor : null;
        });
        // Build label
        var wlLabel = 'Trial Portfolio';
        if (window._watchlistMode === '__mirror__') wlLabel = 'Mirrored Portfolio';
        else if (window._watchlistMode === '__custom__') wlLabel = 'Custom Watchlist (' + window._watchlistTickers.length + ' tickers)';
        else {
          var th = (window.PORTFOLIO_THEMES||[]).find(function(t){ return t.key === window._watchlistMode; });
          if (th) wlLabel = 'Theme: ' + th.name.replace(/&amp;/g,'&').replace(/&mdash;/g,'—');
        }
        ds.push({
          label: wlLabel,
          data: wlData, borderColor: '#E07B39', backgroundColor: 'rgba(224,123,57,0.08)',
          borderWidth: 2.2, borderDash: [5,3], pointRadius: 0, pointHoverRadius: 5,
          fill: false, tension: .3, yAxisID: 'y', spanGaps: true
        });
        document.getElementById('watchlistStatus').textContent = wlLabel + ' plotted';
      }
    } catch(e) { console.warn('[watchlist chart]', e); }
  }

  // ─────────────────────────────────────────────────────────────────────
  // MONTE CARLO FORECAST OVERLAY — extends portfolio + benchmark 252 days
  // forward under the regime selected in the dropdown.
  // ─────────────────────────────────────────────────────────────────────
  var mcRegimeSel = document.getElementById('mcRegimeSelect');
  var mcRegime = mcRegimeSel ? mcRegimeSel.value : '';
  if (mcRegime && typeof pfrComputeRegimeDrifts === 'function' && document.getElementById('mcFutureOverlay')?.checked !== false) {
    try {
      var regimeDrifts = await pfrComputeRegimeDrifts();
      var mcDailyDrift = regimeDrifts[mcRegime] || regimeDrifts.growth || 0.0003;
      var mcDailyVolByState = { leveraged: 0.022, growth: 0.011, neutral: 0.014, drawdown: 0.025 };
      var mcDailyVol = mcDailyVolByState[mcRegime] || 0.014;

      // Approximate portfolio beta via realized vol vs. SPY baseline (~1.2% daily).
      // Compute portfolio daily sigma inline (sd is declared later in the function).
      var _mcDR = [];
      for (var _mci = 1; _mci < cv.length; _mci++) {
        if (cv[_mci-1] != null && cv[_mci] != null && cv[_mci-1] > 0) {
          _mcDR.push((cv[_mci] - cv[_mci-1]) / cv[_mci-1]);
        }
      }
      var _mcMean = _mcDR.length ? _mcDR.reduce(function(a,b){return a+b;},0)/_mcDR.length : 0;
      var _mcVar = _mcDR.length ? _mcDR.reduce(function(a,r){return a+(r-_mcMean)*(r-_mcMean);},0)/_mcDR.length : 0;
      var portSigma = Math.sqrt(_mcVar);
      if (!isFinite(portSigma) || portSigma <= 0) portSigma = mcDailyVol;
      var portBeta = portSigma / 0.012;
      portBeta = Math.max(0.3, Math.min(3.5, portBeta));

      var nForecast = 252;
      var nPaths = 500;
      // Forecast starts from the endpoint of the currently-displayed series
      // TWR mode → use TWR endpoint (indexed); Dollar mode → use portfolio dollar value
      var startVal = (window._twrModeOnly && twrSeries[pfLastNonNullIdx] != null)
        ? twrSeries[pfLastNonNullIdx]
        : (pfE || (twrSeries[pfLastNonNullIdx] != null ? twrSeries[pfLastNonNullIdx] : 100));
      var paths = [];
      function bmSample(){
        var u1 = Math.random() || 1e-9, u2 = Math.random();
        return Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2);
      }
      var portDrift = mcDailyDrift * portBeta;
      var portVol = mcDailyVol * portBeta;
      for (var pp = 0; pp < nPaths; pp++) {
        var path = [startVal];
        var v = startVal;
        for (var tt = 0; tt < nForecast; tt++) {
          var z = bmSample();
          v = v * Math.exp((portDrift - 0.5*portVol*portVol) + portVol*z);
          path.push(v);
        }
        paths.push(path);
      }
      var p10Path = [], p50Path = [], p90Path = [];
      for (var ti = 0; ti <= nForecast; ti++) {
        var snap = paths.map(function(pa){return pa[ti];}).sort(function(a,b){return a-b;});
        p10Path.push(snap[Math.floor(snap.length*0.10)]);
        p50Path.push(snap[Math.floor(snap.length*0.50)]);
        p90Path.push(snap[Math.floor(snap.length*0.90)]);
      }

      // Future trading days (skip weekends)
      var lastDate = new Date(cd[cd.length-1] + 'T00:00:00Z');
      var futureDates = [];
      var fd = new Date(lastDate);
      while (futureDates.length < nForecast) {
        fd.setUTCDate(fd.getUTCDate() + 1);
        var dow = fd.getUTCDay();
        if (dow !== 0 && dow !== 6) futureDates.push(fd.toISOString().slice(0,10));
      }

      var nHistorical = cd.length;
      cd.push.apply(cd, futureDates);
      _chartDatesGlobal = cd;

      // Pad existing series with nulls for the forecast window
      ds.forEach(function(dataset){
        if (Array.isArray(dataset.data)) {
          for (var k = 0; k < nForecast; k++) dataset.data.push(null);
        }
      });

      // Forecast datasets — bridge starts from last historical TWR value
      var p10Full = new Array(nHistorical - 1).fill(null).concat([startVal]).concat(p10Path.slice(1));
      var p50Full = new Array(nHistorical - 1).fill(null).concat([startVal]).concat(p50Path.slice(1));
      var p90Full = new Array(nHistorical - 1).fill(null).concat([startVal]).concat(p90Path.slice(1));

      var stateColors = { leveraged:'#2E7D52', growth:'#003C71', neutral:'#8B6914', drawdown:'#8B2A2A' };
      var stateNamesMC = { leveraged:'Leveraged', growth:'Non-Levered Growth', neutral:'Neutral', drawdown:'Drawdown' };
      var fcCol = stateColors[mcRegime] || '#003C71';
      function hexToRgba(hex, a){
        var r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
        return 'rgba('+r+','+g+','+b+','+a+')';
      }
      var bandFill = hexToRgba(fcCol, 0.10);

      ds.push({
        label: 'Forecast P10 (' + stateNamesMC[mcRegime] + ')',
        data: p10Full,
        borderColor: fcCol, backgroundColor: bandFill,
        borderWidth: 1, borderDash: [3,3], pointRadius: 0, fill: '+1', tension: .2,
        yAxisID: 'y', spanGaps: false, order: 5
      });
      ds.push({
        label: 'Forecast Median (' + stateNamesMC[mcRegime] + ')',
        data: p50Full,
        borderColor: fcCol, backgroundColor: 'transparent',
        borderWidth: 2.5, borderDash: [6,4], pointRadius: 0, fill: false, tension: .2,
        yAxisID: 'y', spanGaps: false, order: 4
      });
      ds.push({
        label: 'Forecast P90 (' + stateNamesMC[mcRegime] + ')',
        data: p90Full,
        borderColor: fcCol, backgroundColor: 'transparent',
        borderWidth: 1, borderDash: [3,3], pointRadius: 0, fill: false, tension: .2,
        yAxisID: 'y', spanGaps: false, order: 5
      });

      // Project benchmarks forward (median only) — skip if benchmarks are hidden (B2-B)
      if (!window._benchmarksHidden) {
        Object.keys(_chartBenchmarkSeries).forEach(function(sym){
          var bmMap = _chartBenchmarkSeries[sym];
          var lastBmVal = null;
          for (var i = nHistorical - 1; i >= 0 && lastBmVal == null; i--) {
            if (bmMap[cd[i]] != null) lastBmVal = bmMap[cd[i]];
          }
          if (lastBmVal == null) return;
          var bmFcst = [lastBmVal];
          var bmV = lastBmVal;
          for (var bt = 0; bt < nForecast; bt++) {
            bmV = bmV * Math.exp(mcDailyDrift);
            bmFcst.push(bmV);
          }
          var bmFull = new Array(nHistorical - 1).fill(null).concat(bmFcst);
          var bmDataset = ds.find(function(x){return x.label === sym && x.yAxisID === 'y1';});
          var bmColor = bmDataset ? bmDataset.borderColor : C.blue;
          ds.push({
            label: sym + ' Forecast (median)',
            data: bmFull,
            borderColor: bmColor, backgroundColor: 'transparent',
            borderWidth: 1.5, borderDash: [5,5], pointRadius: 0, fill: false, tension: .2,
            yAxisID: window._pctAxisMode ? 'yRight' : 'y1', spanGaps: false, order: 6
          });
        });
      }

      window._mcForecast = {
        regime: mcRegime,
        stateName: stateNamesMC[mcRegime],
        startVal: startVal,
        p10End: p10Path[p10Path.length-1],
        p50End: p50Path[p50Path.length-1],
        p90End: p90Path[p90Path.length-1],
        annDrift: (Math.pow(1+portDrift, 252)-1)*100,
        annVol: portVol*Math.sqrt(252)*100
      };
    } catch(mcErr) {
      window._mcForecast = null;
    }
  } else {
    if (mcRegime) console.warn('[MC forecast] skipped — pfrComputeRegimeDrifts not defined');
    window._mcForecast = null;
  }

  // ─── Stats use the DISPLAYED series (respects TWR mode toggle) ───
  const twrModeActive = !!window._twrModeOnly;

  const pfRetTWR = (twrSeries[pfLastNonNullIdx] != null && rebaseStart > 0)
    ? ((twrSeries[pfLastNonNullIdx] - rebaseStart) / rebaseStart * 100) : 0;
  const pfRetDollar = pfS > 0 ? ((pfE - pfS) / pfS * 100) : 0;
  const pfRetPrimary = twrModeActive ? pfRetTWR : pfRetDollar;
  const primaryLabel  = twrModeActive ? 'Time-Weighted Return' : 'Portfolio Return (Total $)';
  const primaryHint   = twrModeActive ? 'Deposits stripped — pure investment performance' : 'Includes deposits — total dollar performance';

  let bmRet = null, bmSym = ci[0] || '';
  if (bmSym && _chartBenchmarkSeries[bmSym]) {
    var bmMap = _chartBenchmarkSeries[bmSym];
    var bf = null, bl = null;
    for (var i2 = pfFirstNonNullIdx; i2 < cd.length; i2++) { if (bmMap[cd[i2]] != null) { bf = bmMap[cd[i2]]; break; } }
    for (var j2 = pfLastNonNullIdx; j2 >= 0; j2--) { if (bmMap[cd[j2]] != null) { bl = bmMap[cd[j2]]; break; } }
    if (bf != null && bl != null && bf > 0) bmRet = ((bl - bf) / bf) * 100;
  }
  const alpha    = bmRet != null ? (pfRetTWR - bmRet) : null;
  const gPfTWR   = rebaseStart > 0 ? (10000 * (twrSeries[pfLastNonNullIdx] / rebaseStart)) : 10000;
  const gPfDollar = pfS > 0 ? (10000 * (pfE / pfS)) : 10000;
  const gPf      = twrModeActive ? gPfTWR : gPfDollar;
  const gBm      = bmRet != null ? (10000 * (1 + bmRet / 100)) : null;
  const hb       = !window._pctAxisMode && ci.length > 0 && ds.length > 2;

  // Risk — compute from the displayed series
  const activeSeries = twrModeActive ? twrSeries : cv;
  const dr = [];
  for (let j = 1; j < activeSeries.length; j++) {
    if (activeSeries[j-1] != null && activeSeries[j] != null && activeSeries[j-1] > 0)
      dr.push((activeSeries[j] - activeSeries[j-1]) / activeSeries[j-1]);
  }
  const mr = dr.length ? dr.reduce((a, b) => a + b, 0) / dr.length : 0;
  const vr = dr.length ? dr.reduce((a, r) => a + (r - mr) ** 2, 0) / dr.length : 0;
  const sd = Math.sqrt(vr) * Math.sqrt(252) * 100;

  let sh = '';
  if (alpha != null) {
    sh += '<div class="chart-stat-box"><div class="chart-stat-label">Alpha vs ' + bmSym + ' <span class="help-icon" title="Alpha = portfolio TWR minus benchmark return. Always TWR-based so deposits do not distort.">?</span></div>' +
      '<div class="chart-stat-value" style="color:' + pctColor(alpha) + ';">' + fmtPct(alpha) + '</div>' +
      '<div class="chart-stat-sub">TWR ' + fmtPct(pfRetTWR) + ' vs ' + bmSym + ' ' + fmtPct(bmRet) + '</div></div>';
  }
  sh += '<div class="chart-stat-box"><div class="chart-stat-label">' + primaryLabel + ' <span class="help-icon" title="' + (twrModeActive ? 'Time-Weighted Return: strips deposits. Use TWR Mode button to toggle.' : 'Total Dollar Return: includes deposits. Use TWR Mode button to see deposit-stripped performance.') + '">?</span></div>' +
    '<div class="chart-stat-value" style="color:' + pctColor(pfRetPrimary) + ';">' + fmtPct(pfRetPrimary) + '</div>' +
    '<div class="chart-stat-sub">' + primaryHint + '</div></div>';
  if (twrModeActive) {
    sh += '<div class="chart-stat-box"><div class="chart-stat-label">Total Dollar Return</div><div class="chart-stat-value" style="color:' + pctColor(pfRetDollar) + ';font-size:15px;">' + fmtPct(pfRetDollar) + '</div><div class="chart-stat-sub">Incl. ' + (window._twrDeposits ? window._twrDeposits.length : 0) + ' deposit(s)</div></div>';
  } else {
    sh += '<div class="chart-stat-box"><div class="chart-stat-label">Time-Weighted Return</div><div class="chart-stat-value" style="color:' + pctColor(pfRetTWR) + ';font-size:15px;">' + fmtPct(pfRetTWR) + '</div><div class="chart-stat-sub">Deposit-stripped</div></div>';
  }
  sh += '<div class="chart-stat-box"><div class="chart-stat-label">Growth of $10,000 (' + (twrModeActive ? 'TWR' : 'Total $') + ')</div>' +
    '<div class="chart-stat-value">' + fmtInt(gPf) + '</div>' +
    '<div class="chart-stat-sub">' + (gBm != null ? bmSym + ': ' + fmtInt(gBm) : 'Add benchmark') + '</div></div>';
  sh += '<div class="chart-stat-box"><div class="chart-stat-label">Ann. Volatility</div><div class="chart-stat-value">σ ' + sd.toFixed(1) + '%</div><div class="chart-stat-sub">' + (twrModeActive ? 'TWR-based' : 'Dollar-based') + '</div></div>';
  if (window._mcForecast) {
    var mc = window._mcForecast;
    var medRet = ((mc.p50End / mc.startVal) - 1) * 100;
    var p10Ret = ((mc.p10End / mc.startVal) - 1) * 100;
    var p90Ret = ((mc.p90End / mc.startVal) - 1) * 100;
    sh += '<div class="chart-stat-box" style="border-left:3px solid #2E7D52;"><div class="chart-stat-label">12M Forecast (' + mc.stateName + ') <span class="help-icon" title="Monte Carlo 12-month forecast under the selected regime. P10 = pessimistic case (10th percentile), Median = expected outcome, P90 = optimistic case.">?</span></div>' +
      '<div class="chart-stat-value" style="color:' + (medRet >= 0 ? C.success : C.danger) + ';">' + (medRet >= 0 ? '+' : '') + medRet.toFixed(1) + '%</div>' +
      '<div class="chart-stat-sub">P10: ' + (p10Ret >= 0 ? '+' : '') + p10Ret.toFixed(1) + '% / P90: ' + (p90Ret >= 0 ? '+' : '') + p90Ret.toFixed(1) + '%</div></div>';
  }
  document.getElementById('chartStats').innerHTML = sh;

  // ── B2-A: In pct mode, reassign all 'y' datasets to 'yRight' ──
  if (window._pctAxisMode) {
    ds.forEach(function(dataset) {
      if (dataset.yAxisID === 'y') dataset.yAxisID = 'yRight';
    });
  }

  // Build chart
  const ctx = document.getElementById('portfolioLineChart').getContext('2d');
  if (portfolioLineChart) portfolioLineChart.destroy();
  portfolioLineChart = new Chart(ctx, {
    type: 'line',
    data: { labels: cd, datasets: ds },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: hb,
          labels: { font: { family: 'Arial', size: 11 }, color: C.textSec, boxWidth: 10, padding: 16,
            filter: function(item) {
              var t = item.text || '';
              if (t === 'Volume') return false;
              if (t.indexOf('Forecast P10') >= 0 || t.indexOf('Forecast P90') >= 0) return false;
              if (t.indexOf('(rebased)') >= 0) return false; // hide rebased version; price-axis version shows in legend
              return true;
            }
          }
        },
        tooltip: {
          backgroundColor: C.bg, titleColor: C.text, bodyColor: C.text,
          borderColor: C.border, borderWidth: 1,
          titleFont: { family: 'Arial', size: 12, weight: '700' },
          bodyFont: { family: 'Arial', size: 12 },
          footerFont: { family: 'Arial', size: 11, weight: '600' },
          footerColor: C.navy, padding: 12, boxPadding: 4, usePointStyle: true,
          filter: function(item) { return item.dataset.label !== 'Volume'; },
          callbacks: {
            title: function(items) { return items[0]?.label || ''; },
            label: function(c) {
              const v = c.parsed.y;
              if (v == null || c.dataset.label === 'Volume') return null;
              const label = c.dataset.label || '';
              if (c.dataset.yAxisID === 'y1') return ' ' + label + ': $' + (v != null ? v.toFixed(2) : '—');
              if (window._pctAxisMode) {
                var pctChange = (v - 100).toFixed(1);
                return ' ' + label + ': ' + (pctChange >= 0 ? '+' : '') + pctChange + '%';
              }
              if (label.indexOf('Forecast') >= 0) return ' ' + label + ': ' + fmt(v);
              return ' ' + label + ': ' + fmt(v);
            },
            afterBody: function(items) {
              const idx = items[0]?.dataIndex;
              if (idx == null) return [];
              const d = cd[idx];
              const lines = [''];
              // Deposit flag info — surface so user understands the gap between Total and TWR
              if (window._twrDeposits) {
                var dep = window._twrDeposits.find(function(x){ return x.date === d; });
                if (dep) {
                  lines.push('💵 Deposit detected: ' + (dep.dollarChange >= 0 ? '+' : '') + '$' + Math.round(dep.dollarChange).toLocaleString());
                  lines.push('  (excluded from TWR)');
                  lines.push('');
                }
              }
              // Regime overlay info
              if (_showRegimeOverlay) {
                const r = _regimeByDate[d];
                if (r) {
                  const stateNames = {leveraged: 'Leveraged', growth: 'Non-Levered Growth', neutral: 'Neutral', drawdown: 'Positioned for Drawdown'};
                  lines.push('Regime: ' + (stateNames[r] || r));
                  lines.push('');
                }
              }
              // Stress event info
              if (_showStress) {
                const ev = getStressEventForDate(d);
                if (ev) {
                  lines.push('⚠ ' + ev.name + ' (' + ev.type + ')');
                  const es = cd.findIndex(dd => dd >= ev.start);
                  const ee = cd.findIndex(dd => dd > ev.end);
                  const evSlice = cv.slice(Math.max(0, es - 5), ee > 0 ? ee : cv.length).filter(function(v){return v!=null;});
                  const evSlice2 = cv.slice(es, ee > 0 ? ee : cv.length).filter(function(v){return v!=null;});
                  const ep = evSlice.length ? Math.max.apply(null, evSlice) : 0;
                  const et = evSlice2.length ? Math.min.apply(null, evSlice2) : 0;
                  if (ep > 0) lines.push('  Drawdown: ' + fmtPct(((et - ep) / ep) * 100));
                  lines.push('');
                }
              }
              // VIX info
              if (_showVixRange) {
                const vix = _vixDateMap[d];
                if (vix != null) {
                  lines.push('VIX: ' + vix.toFixed(1) + (vix >= 30 ? ' (Extreme)' : vix >= 20 ? ' (Elevated)' : ' (Normal)'));
                  const ev = getVixEventForDate(d);
                  if (ev) lines.push('  ' + ev.name);
                  lines.push('');
                }
              }
              // Point-in-time return
              const pfAt = cv[idx];
              const pfPtR = pfS > 0 ? ((pfAt - pfS) / pfS * 100) : 0;
              lines.push('Return to Date:');
              lines.push('  Portfolio: ' + fmtPct(pfPtR));
              ci.forEach(sym => {
                const pm = _chartBenchmarkSeries[sym];
                if (!pm) return;
                // Find first & current price for this benchmark
                let bf = null;
                for (var bdi = pfFirstNonNullIdx; bdi < cd.length; bdi++) { if (pm[cd[bdi]] != null) { bf = pm[cd[bdi]]; break; } }
                var ba = pm[cd[idx]];
                if (bf != null && bf > 0 && ba != null) lines.push('  ' + sym + ': ' + fmtPct(((ba - bf) / bf) * 100));
              });
              return lines;
            }
          }
        },
        zoom: {
          zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' },
          pan: { enabled: true, mode: 'x' },
          limits: { x: { minRange: 5 } }
        }
      },
      layout: { padding: { right: 70 } },
      scales: {
        x: { grid: chartGrid, ticks: { ...chartTicks, maxTicksLimit: 12 }, border: { display: false } },
        y: {
          type: 'linear', position: 'left', grid: chartGrid,
          // In pct mode, hide left axis — data is shown on right (yRight)
          display: window._pctAxisMode ? false : true,
          ticks: {
            ...chartTicks,
            callback: function(v) {
              if (window._twrModeOnly) {
                return (v != null ? v.toFixed(1) : '0');
              }
              // Dollar mode
              return '$' + (v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(0)+'K' : (v||0).toFixed(0));
            }
          },
          border: { display: false },
          title: {
            display: !window._pctAxisMode,
            text: window._twrModeOnly ? 'Time-Weighted Return (indexed to 100)' : 'Portfolio Value ($)',
            font: { family: 'Arial', size: 12, weight: '600' },
            color: C.textSec
          }
        },
        yRight: {
          type: 'linear', position: 'right',
          display: !!window._pctAxisMode,
          grid: { drawOnChartArea: false },
          ticks: {
            ...chartTicks,
            callback: function(v) {
              // Show as % change from 100 base
              return (v - 100).toFixed(1) + '%';
            }
          },
          border: { display: false },
          title: {
            display: !!window._pctAxisMode,
            text: (function() {
              var startDate = cd[pfFirstNonNullIdx];
              var label = '% Change from Start';
              if (startDate) {
                try { label = '% Change since ' + new Date(startDate + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); } catch(e) {}
              }
              return label;
            })(),
            font: { family: 'Arial', size: 12, weight: '600' },
            color: C.textSec
          }
        },
        y1: {
          type: 'linear', position: 'right',
          // In pct mode, hide y1 since benchmark is also rebased to right axis
          display: window._pctAxisMode ? false : hb,
          grid: { drawOnChartArea: false },
          ticks: { ...chartTicks, callback: function(v) { return '$' + (v||0).toFixed(2); } },
          border: { display: false },
          title: { display: window._pctAxisMode ? false : hb, text: 'Benchmark Price ($)', font: { family: 'Arial', size: 12, weight: '600' }, color: C.textSec }
        },
        yVol: {
          position: 'right', display: false,
          grid: { drawOnChartArea: false },
          min: 0,
          max: maxVol * 5
        }
      }
    }
  });
  // B2-C: touch tap-dismiss for chart tooltip on mobile
  if (portfolioLineChart && portfolioLineChart.canvas) {
    portfolioLineChart.canvas.addEventListener('touchend', function() {
      var active = portfolioLineChart.tooltip.getActiveElements();
      if (active && active.length && window._lastChartTouch) {
        portfolioLineChart.tooltip.setActiveElements([], {});
        portfolioLineChart.update('none');
        window._lastChartTouch = false;
      } else { window._lastChartTouch = true; }
    });
  }

  loadEl.style.display = 'none';
};

// ═══ MORNINGSTAR STYLE BOX ═══
function renderMorningstarBox(holdings) {
  const el = document.getElementById('mstar-card');
  if (!el) return;
  const tv = holdings.reduce((s, h) => s + (h.currentPrice || 0) * h.quantity, 0);
  if (tv === 0) { el.innerHTML = ''; return; }
  let xS = 0, yS = 0;
  const gr = new Set(["Information Technology", "Consumer Discretionary", "Communication Services", "Digital Assets"]);
  const vl = new Set(["Financials", "Energy", "Utilities", "Consumer Staples", "Real Estate", "Materials"]);
  const lg = new Set(["Mega Cap", "Large Cap", "Large Cap Growth", "Large Cap Value", "Large Cap Blend", "Large Fund"]);
  const md = new Set(["Mid Cap", "Mid Cap Growth", "Mid Cap Value", "Mid Cap Blend"]);
  const sm = new Set(["Small Cap", "Small Cap Growth", "Small Cap Value", "Small Cap Blend", "Micro Cap"]);
  holdings.forEach(h => {
    const w = ((h.currentPrice || 0) * h.quantity) / tv;
    let x = 1;
    if (gr.has(h.sector)) x = 2;
    else if (vl.has(h.sector)) x = 0;
    let y = 0;
    const c = h.mktCapCategory || '';
    if (lg.has(c)) y = 0;
    else if (md.has(c)) y = 1;
    else if (sm.has(c)) y = 2;
    xS += x * w;
    yS += y * w;
  });
  const dL = Math.max(9, Math.min(231, (xS / 2) * 240));
  const dT = Math.max(9, Math.min(231, (yS / 2) * 240));
  el.innerHTML = '<div class="card"><div class="card-title">Morningstar Style Box</div><div class="card-body">' +
    '<div class="mstar-labels-top"><span>Value</span><span>Blend</span><span>Growth</span></div>' +
    '<div class="mstar-container"><div class="mstar-labels-left"><span>Large</span><span>Mid</span><span>Small</span></div>' +
    '<div class="mstar-grid">' +
    '<div class="mstar-cell">Large<br>Value</div><div class="mstar-cell">Large<br>Blend</div><div class="mstar-cell">Large<br>Growth</div>' +
    '<div class="mstar-cell">Mid<br>Value</div><div class="mstar-cell">Mid<br>Blend</div><div class="mstar-cell">Mid<br>Growth</div>' +
    '<div class="mstar-cell">Small<br>Value</div><div class="mstar-cell">Small<br>Blend</div><div class="mstar-cell">Small<br>Growth</div>' +
    '<div class="mstar-dot" style="left:' + dL + 'px;top:' + dT + 'px;" title="Your Portfolio"></div>' +
    '</div></div>' +
    '<div style="text-align:center;margin-top:12px;font-size:11px;color:' + C.textSec + ';">Portfolio weighted position</div>' +
    '</div><div class="card-sources"><strong>Sources:</strong><br>&#8226; Perry AM — Holdings sector &amp; market cap</div></div>';
}

// ═══ DONUTS ═══
// Render a donut chart with deduplication and clean legend
function renderDonut(id, title, data) {
  const el = document.getElementById(id);
  if (!el) return;
  // Deduplicate: merge same labels
  const merged = {};
  data.forEach(d => {
    if (merged[d.label]) merged[d.label] += d.value;
    else merged[d.label] = d.value;
  });
  // Filter out zero/tiny slices, sort descending, cap at 15 entries
  let deduped = Object.entries(merged)
    .map(([label, value]) => ({ label, value }))
    .filter(d => d.value >= 0.5)
    .sort((a, b) => b.value - a.value);
  // Group small slices into "Other"
  if (deduped.length > 12) {
    const top = deduped.slice(0, 11);
    const otherVal = deduped.slice(11).reduce((s, d) => s + d.value, 0);
    if (otherVal > 0) top.push({ label: 'Other', value: Math.round(otherVal) });
    deduped = top;
  }
  if (!deduped.length) { el.innerHTML = ''; return; }
  const cid = id + '-c';
  el.innerHTML = '<div style="border:1px solid var(--border);border-radius:6px;overflow:hidden;">' +
    '<div style="background:var(--navy);color:#fff;padding:8px 12px;font-size:12px;font-weight:700;">' + title + '</div>' +
    '<div style="padding:12px;">' +
    '<div style="display:flex;gap:12px;align-items:center;">' +
    '<div style="width:160px;height:160px;flex-shrink:0;position:relative;"><canvas id="' + cid + '"></canvas>' +
    '<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;pointer-events:none;">' +
    '<div style="font-size:18px;font-weight:800;color:var(--navy);">' + deduped.length + '</div>' +
    '<div style="font-size:10px;color:var(--text-sec);white-space:nowrap;">' + (deduped.length === 1 ? 'category' : 'categories') + '</div>' +
    '</div></div>' +
    '<div style="flex:1;min-width:0;max-height:170px;overflow-y:auto;">' +
    deduped.map((d, i) =>
      '<div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid rgba(0,0,0,0.04);">' +
      '<span style="width:10px;height:10px;border-radius:2px;flex-shrink:0;background:' + PALETTE[i % PALETTE.length] + ';"></span>' +
      '<span style="flex:1;font-size:11px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + d.label + '">' + d.label + '</span>' +
      '<span style="font-size:11px;font-weight:700;color:var(--navy);font-family:Courier New,monospace;">' + d.value.toFixed(1) + '%</span>' +
      '</div>'
    ).join('') +
    '</div></div></div></div>';
  const ctx = document.getElementById(cid) ? document.getElementById(cid).getContext('2d') : null;
  if (!ctx) return;
  if (donutCharts[id]) donutCharts[id].destroy();
  donutCharts[id] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: deduped.map(d => d.label),
      datasets: [{
        data: deduped.map(d => d.value),
        backgroundColor: deduped.map((_, i) => PALETTE[i % PALETTE.length]),
        borderWidth: 2,
        borderColor: C.bg,
        hoverBorderWidth: 3
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: true, cutout: '60%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: c => ' ' + c.label + ': ' + (c.parsed != null ? c.parsed.toFixed(1) : '0') + '%'
          }
        }
      }
    }
  });
}

// Render all donuts, respecting the account filter
function renderAllDonuts() {
  const allH = window._holdings || [];
  const af = (document.getElementById('donutAccountFilter') || {}).value || 'all';
  const holdings = af === 'all' ? allH : allH.filter(h => (h.accountType || 'Individual') === af);

  function mvOf(h) {
    const isCash = h.assetClass === 'Cash' || h.assetClass === 'Money Market' || h.assetClass === 'CD' || h.assetClass === 'Bond Position';
    return isCash ? (h.costBasis || 0) * h.quantity : (h.currentPrice || 0) * h.quantity;
  }
  const tv = holdings.reduce((s, h) => s + mvOf(h), 0);
  if (tv <= 0) return;

  const group = (key) => {
    const g = {};
    holdings.forEach(h => {
      const mv = mvOf(h);
      const k = h[key] || 'Other';
      g[k] = (g[k] || 0) + mv;
    });
    return Object.entries(g).map(([l, v]) => ({
      label: l, value: tv > 0 ? Math.round(v / tv * 1000) / 10 : 0
    })).sort((a, b) => b.value - a.value);
  };

  renderDonut('donut-sector', 'By Sector', group('sector'));
  renderDonut('donut-weight', 'By Holding (Top Positions)', 
    holdings.map(h => ({
      label: h.ticker,
      value: tv > 0 ? Math.round(mvOf(h) / tv * 1000) / 10 : 0
    })).sort((a, b) => b.value - a.value)
  );
  renderDonut('donut-mktcap', 'By Market Cap / Style', group('mktCapCategory'));
  renderMorningstarBox(holdings);

  // Populate account filter dropdowns (donut + portfolio optimization + scenarios)
  function populateAccountSelect(selId) {
    var filterEl2 = document.getElementById(selId);
    if (!filterEl2) return;
    while (filterEl2.options.length > 1) filterEl2.remove(1); // clear except "All"
    var accts2 = [...new Set(allH.map(h => h.accountType || 'Individual'))].sort();
    accts2.forEach(function(a) {
      var opt = document.createElement('option');
      opt.value = a; opt.textContent = a;
      filterEl2.appendChild(opt);
    });
  }
  ['donutAccountFilter', 'poeAccount', 'scenarioAccountFilter'].forEach(populateAccountSelect);
}

// ═══ BULK IMPORT ═══
let _bulkRows = [];

// Brokerage / account-type detection from filename and column headers
const BROKERAGE_PATTERNS = [
  { pattern: /fidelity/i,       broker: 'Fidelity',           accountType: 'Individual' },
  { pattern: /schwab/i,         broker: 'Charles Schwab',     accountType: 'Individual' },
  { pattern: /vanguard/i,       broker: 'Vanguard',           accountType: 'Individual' },
  { pattern: /robinhood/i,      broker: 'Robinhood',          accountType: 'Individual' },
  { pattern: /e[\s\-]?trade/i,  broker: 'E*TRADE',            accountType: 'Individual' },
  { pattern: /td\s*ameritrade/i,broker: 'TD Ameritrade',      accountType: 'Individual' },
  { pattern: /merrill/i,        broker: 'Merrill Lynch',      accountType: 'Individual' },
  { pattern: /webull/i,         broker: 'Webull',             accountType: 'Individual' },
  { pattern: /interactive\s*brokers/i, broker: 'IBKR',        accountType: 'Individual' },
  { pattern: /ibkr/i,           broker: 'IBKR',               accountType: 'Individual' },
  { pattern: /coinbase/i,       broker: 'Coinbase',           accountType: 'Individual' }
];
const ACCOUNT_TYPE_PATTERNS = [
  { pattern: /roth[\s_-]*ira/i,       accountType: 'Roth IRA' },
  { pattern: /traditional[\s_-]*ira/i,accountType: 'Traditional IRA' },
  { pattern: /401[\s_-]*k/i,          accountType: '401(k)' },
  { pattern: /sep[\s_-]*ira/i,        accountType: 'SEP IRA' },
  { pattern: /hsa/i,                  accountType: 'HSA' },
  { pattern: /joint/i,                accountType: 'Joint Brokerage' },
  { pattern: /individual|brokerage/i, accountType: 'Individual' }
];

function detectBrokerageFromFile(filename, gridRows) {
  var result = { broker: '', accountType: '' };
  // 1. Scan filename
  var needle = filename.toLowerCase();
  for (var i = 0; i < BROKERAGE_PATTERNS.length; i++) {
    if (BROKERAGE_PATTERNS[i].pattern.test(needle)) { result.broker = BROKERAGE_PATTERNS[i].broker; break; }
  }
  for (var j = 0; j < ACCOUNT_TYPE_PATTERNS.length; j++) {
    if (ACCOUNT_TYPE_PATTERNS[j].pattern.test(needle)) { result.accountType = ACCOUNT_TYPE_PATTERNS[j].accountType; break; }
  }
  if (result.broker && result.accountType) return result;
  // 2. Scan first 5 rows for brokerage / account type keywords
  var firstRows = gridRows.slice(0, 5);
  var flatText = firstRows.map(function(r){ return (r || []).join(' '); }).join(' ');
  if (!result.broker) {
    for (var i = 0; i < BROKERAGE_PATTERNS.length; i++) {
      if (BROKERAGE_PATTERNS[i].pattern.test(flatText)) { result.broker = BROKERAGE_PATTERNS[i].broker; break; }
    }
  }
  if (!result.accountType) {
    for (var j = 0; j < ACCOUNT_TYPE_PATTERNS.length; j++) {
      if (ACCOUNT_TYPE_PATTERNS[j].pattern.test(flatText)) { result.accountType = ACCOUNT_TYPE_PATTERNS[j].accountType; break; }
    }
  }
  // 3. Scan header row for an "Account Type" or "Account" column and read its first data value
  if (!result.accountType && gridRows.length >= 2) {
    var hdrRow = gridRows[0].map(function(c){ return String(c||'').toLowerCase().trim(); });
    var acctCol = hdrRow.findIndex(function(h){ return /account.?type|account\s*name|acct/i.test(h); });
    if (acctCol >= 0 && gridRows[1] && gridRows[1][acctCol]) {
      var cellVal = String(gridRows[1][acctCol]);
      for (var j = 0; j < ACCOUNT_TYPE_PATTERNS.length; j++) {
        if (ACCOUNT_TYPE_PATTERNS[j].pattern.test(cellVal)) { result.accountType = ACCOUNT_TYPE_PATTERNS[j].accountType; break; }
      }
    }
  }
  return result;
}

const dropZone = document.getElementById('dropZone');
if (dropZone) {
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('dragover'); if (e.dataTransfer.files.length) processFile(e.dataTransfer.files[0]); });
}
window.handleFileSelect = function(e) { if (e.target.files.length) processFile(e.target.files[0]); };

async function processFile(file) {
  showStatus('scanStatus', '<span class="spinner"></span> Scanning ' + file.name + '...', 'info');
  _bulkRows = [];
  const ext = file.name.split('.').pop().toLowerCase();
  var gridRows = [];
  try {
    if (ext === 'csv' || ext === 'txt') {
      const text = await file.text();
      gridRows = text.split(/\r?\n/).map(l => l.split(/[,\t]/));
      _bulkRows = parseGrid(gridRows);
    } else if (ext === 'xlsx' || ext === 'xls') {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf);
      const ws = wb.Sheets[wb.SheetNames[0]];
      gridRows = XLSX.utils.sheet_to_json(ws, { header: 1 });
      _bulkRows = parseGrid(gridRows);
    } else {
      showStatus('scanStatus', 'Unsupported: .' + ext, 'error');
      return;
    }
    if (!_bulkRows.length) {
      showStatus('scanStatus', 'No valid rows found.', 'error');
      return;
    }
    // Brokerage / account-type detection
    var detected = detectBrokerageFromFile(file.name, gridRows);
    var detectedMsg = '';
    if (detected.broker || detected.accountType) {
      var parts = [];
      if (detected.broker) parts.push('<strong>' + detected.broker + '</strong>');
      if (detected.accountType) parts.push(detected.accountType);
      detectedMsg = ' &nbsp;<span style="background:rgba(46,125,82,0.12);color:var(--success);padding:2px 8px;border-radius:4px;font-size:11px;">&#10003; Detected: ' + parts.join(' / ') + '</span>';
      // Pre-fill account type dropdown if a match was found
      var atEl = document.getElementById('inputAccountType');
      if (atEl && detected.accountType) {
        var opts = Array.from(atEl.options).map(function(o){ return o.value; });
        var match = opts.find(function(v){ return v.toLowerCase().replace(/[^a-z0-9]/g,'') === detected.accountType.toLowerCase().replace(/[^a-z0-9]/g,''); });
        if (match) atEl.value = match;
      }
    }
    showStatus('scanStatus', '&#10003; Found ' + _bulkRows.length + ' holdings from <strong>' + file.name + '</strong>.' + detectedMsg + ' Review below.', 'success');
    renderValidationTable();
  } catch(e) {
    showStatus('scanStatus', 'Error: ' + e.message, 'error');
  }
}

function parseGrid(rows) {
  if (rows.length < 2) return [];
  const fr = rows[0].map(c => String(c || '').trim());
  const hdr = fr.some(c => /^[a-zA-Z\s\/]+$/.test(c) && c.length > 1 && isNaN(parseFloat(c)));
  const si = hdr ? 1 : 0;
  const nc = Math.max(...rows.map(r => (r || []).length));
  // Score columns by content type
  const cs = [];
  for (let col = 0; col < nc; col++) {
    let ts = 0, ds = 0, ns = 0;
    for (let row = si; row < Math.min(rows.length, 20); row++) {
      const v = String((rows[row] || [])[col] || '').trim();
      if (!v) continue;
      if (/^[A-Za-z]{1,6}(\.[A-Za-z])?$/.test(v)) ts++;
      if (/\d{4}-\d{2}-\d{2}/.test(v) || /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(v)) ds++;
      const cl = v.replace(/[$,\s]/g, '');
      if (/^-?\d+\.?\d*$/.test(cl)) ns++;
    }
    cs.push({ col, ts, ds, ns });
  }
  // Header hints
  const hh = {};
  if (hdr) fr.forEach((h, i) => {
    const hl = h.toLowerCase();
    if (hl.includes('ticker') || hl.includes('symbol') || hl === 'stock' || hl.includes('security')) hh[i] = 'ticker';
    if (hl.includes('date') || hl.includes('purchased') || hl.includes('acquired') || hl.includes('trade')) hh[i] = 'date';
    if (hl.includes('share') || hl.includes('qty') || hl.includes('quantity') || hl.includes('units') || hl.includes('amount')) hh[i] = 'shares';
    if (hl.includes('cost') || hl.includes('price') || hl.includes('basis') || hl.includes('paid') || hl.includes('per share')) hh[i] = 'cost';
  });
  let tc = -1, dc = -1, sc = -1, cc3 = -1;
  Object.entries(hh).forEach(([i, t]) => {
    const idx = parseInt(i);
    if (t === 'ticker' && tc === -1) tc = idx;
    if (t === 'date' && dc === -1) dc = idx;
    if (t === 'shares' && sc === -1) sc = idx;
    if (t === 'cost' && cc3 === -1) cc3 = idx;
  });
  // Content-based fallback
  const used = new Set([tc, dc, sc, cc3].filter(x => x >= 0));
  if (tc === -1) { const b = cs.filter(c => !used.has(c.col)).sort((a, b) => b.ts - a.ts)[0]; if (b && b.ts > 0) { tc = b.col; used.add(b.col); } }
  if (dc === -1) { const b = cs.filter(c => !used.has(c.col)).sort((a, b) => b.ds - a.ds)[0]; if (b && b.ds > 0) { dc = b.col; used.add(b.col); } }
  if (sc === -1 || cc3 === -1) {
    const nc2 = cs.filter(c => !used.has(c.col) && c.ns > 0).sort((a, b) => b.ns - a.ns);
    if (sc === -1 && nc2.length > 0) { sc = nc2[0].col; used.add(nc2[0].col); }
    if (cc3 === -1 && nc2.length > 1) { cc3 = nc2[1].col; used.add(nc2[1].col); }
  }
  if (tc === -1) tc = 0;
  if (dc === -1) dc = 1;
  if (sc === -1) sc = 2;
  if (cc3 === -1) cc3 = 3;

  const result = [];
  for (let i = si; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;
    let ticker = String(r[tc] || '').trim().toUpperCase().replace(/[^A-Z0-9.]/g, '');
    if (!ticker || ticker.length > 10) continue;
    let date = String(r[dc] || '').trim();
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(date)) {
      const p = date.split('/');
      date = (p[2].length === 2 ? '20' + p[2] : p[2]) + '-' + p[0].padStart(2, '0') + '-' + p[1].padStart(2, '0');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = new Date().toISOString().slice(0, 10);
    const shares = parseFloat(String(r[sc] || '').replace(/[$,\s]/g, '')) || 0;
    const cost = parseFloat(String(r[cc3] || '').replace(/[$,\s]/g, '')) || 0;
    if (shares > 0) result.push({ ticker, date, shares, cost: cost || 0 });
  }
  return result;
}

function renderValidationTable() {
  document.getElementById('validateArea').style.display = '';
  document.getElementById('validateCount').textContent = _bulkRows.length + ' holdings';
  let html = '<table><thead><tr><th>Ticker</th><th>Date</th><th>Shares</th><th>Cost/Share</th><th></th></tr></thead><tbody>';
  _bulkRows.forEach((r, i) => {
    html += '<tr>' +
      '<td><input value="' + r.ticker + '" onchange="_bulkRows[' + i + '].ticker=this.value.toUpperCase()" style="text-transform:uppercase;width:70px;"></td>' +
      '<td><input type="date" value="' + r.date + '" onchange="_bulkRows[' + i + '].date=this.value" style="width:130px;"></td>' +
      '<td><input type="number" value="' + r.shares + '" step="any" onchange="_bulkRows[' + i + '].shares=parseFloat(this.value)||0" style="width:70px;"></td>' +
      '<td><input type="number" value="' + r.cost + '" step="0.01" onchange="_bulkRows[' + i + '].cost=parseFloat(this.value)||0" style="width:80px;"></td>' +
      '<td><button class="btn btn-danger btn-sm" onclick="removeBulkRow(' + i + ')">&#10005;</button></td></tr>';
  });
  html += '</tbody></table>';
  document.getElementById('validateTableWrap').innerHTML = html;
}

window.removeBulkRow = function(i) {
  _bulkRows.splice(i, 1);
  if (!_bulkRows.length) { cancelBulkImport(); return; }
  renderValidationTable();
};

window.cancelBulkImport = function() {
  _bulkRows = [];
  document.getElementById('validateArea').style.display = 'none';
  document.getElementById('scanStatus').className = 'status-bar';
  document.getElementById('fileInput').value = '';
};

window.submitBulkHoldings = async function() {
  const valid = _bulkRows.filter(r => r.ticker && r.shares > 0);
  if (!valid.length) { showStatus('scanStatus', 'No valid holdings.', 'error'); return; }
  const btn = document.getElementById('submitBulkBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Submitting...';
  const acctType = document.getElementById('inputAccountType')?.value || 'Individual';
  let n = 0;
  for (const r of valid) {
    try {
      const q = await fetchQuote(r.ticker);
      const meta = classifyHolding(r.ticker, q);
      await window._addHoldingDirect(r.ticker, getQuoteName(q) || r.ticker, r.date, r.shares, r.cost, getQuotePrice(q) || r.cost, getQuotePrev(q) || getQuotePrice(q) || r.cost, meta, acctType);
      n++;
    } catch(e) { console.warn(r.ticker, e); }
  }
  showStatus('scanStatus', '&#10003; Added ' + n + '/' + valid.length + ' new holdings. Existing holdings untouched.', 'success');
  cancelBulkImport();
  await loadHoldings();
  btn.disabled = false;
  btn.textContent = 'Submit to Portfolio';
};

// ═══ ACCOUNT TYPES EDUCATIONAL CARDS ═══
const ACCT_INFO = [
  { name: "Individual Brokerage", tags: ["Taxable", "No Limits"], desc: "Standard taxable investment account. No contribution limits or withdrawal restrictions. Most flexible account type.", tax: "Capital gains taxed at short-term or long-term rates. Dividends taxed annually. Tax-loss harvesting available.", beneficiary: "Transferred via TOD designation outside probate. Beneficiaries receive stepped-up cost basis at death.", death: "Assets pass to named TOD beneficiary immediately. Without TOD, goes through probate.", bestFor: "Investing beyond retirement limits, short-to-medium goals, tax-loss harvesting." },
  { name: "Roth IRA", tags: ["Tax-Free Growth", "After-Tax"], desc: "After-tax contributions with tax-free qualified withdrawals in retirement (59½+). Contributions withdrawable anytime.", tax: "No tax on qualified distributions. 2025 limit: $7,000 ($8,000 if 50+). Income limits apply. Earnings withdrawn early face 10% penalty + tax.", beneficiary: "Spouse can treat as own Roth IRA. Non-spouse must deplete within 10 years (SECURE Act). All distributions tax-free.", death: "No RMDs for original owner. Spouse rolls to own Roth; non-spouse depletes in 10 years tax-free if 5-year rule met.", bestFor: "Younger investors, those expecting higher future tax rates, legacy planning, Roth conversion ladders." },
  { name: "Traditional IRA", tags: ["Tax-Deferred", "Pre-Tax"], desc: "Contributions may be tax-deductible. Growth tax-deferred. Withdrawals in retirement taxed as ordinary income.", tax: "Deductible if below income threshold. 2025 limit: $7,000 ($8,000 if 50+). RMDs at 73. 10% penalty before 59½.", beneficiary: "Non-spouse must deplete in 10 years. All distributions taxed as ordinary income to beneficiary.", death: "RMDs at 73. Spouse rolls to own IRA. Non-spouse: 10-year depletion, all taxable.", bestFor: "Tax deduction in high-income years, tax-deferred growth, no employer plan." },
  { name: "Standard 401(k)", tags: ["Employer-Sponsored", "Pre-Tax"], desc: "Employer-sponsored with pre-tax contributions reducing current AGI. Often includes employer matching.", tax: "Pre-tax contributions. 2025 limit: $23,500 ($31,000 if 50+). Employer match doesn't count toward limit. Withdrawals taxed as income.", beneficiary: "Spouse is default by law (ERISA). Non-spouse requires spousal consent. 10-year depletion for non-spouse.", death: "Spouse can roll to IRA. Non-spouse: full distribution within 10 years, all taxed as income.", bestFor: "Maximizing employer match, high earners seeking deductions, long-term accumulation." },
  { name: "Roth 401(k)", tags: ["Employer-Sponsored", "After-Tax"], desc: "After-tax 401(k) contributions with tax-free qualified withdrawals. Employer match goes to separate pre-tax bucket.", tax: "After-tax (no deduction). Same limits as 401(k). RMDs at 73 (avoid by rolling to Roth IRA). Qualified withdrawals tax-free.", beneficiary: "Spouse is default. Roth portion tax-free; employer match taxable. Non-spouse: 10-year depletion.", death: "Roll to Roth IRA before death to eliminate RMDs. Roth portion tax-free to heirs.", bestFor: "High earners wanting tax-free retirement income, tax diversification." },
  { name: "SEP IRA", tags: ["Self-Employed", "Pre-Tax"], desc: "Simplified Employee Pension for self-employed. Very high contribution limits based on business income.", tax: "Deductible business expense. 2025: 25% of net income up to $70,000. Same withdrawal rules as Traditional IRA.", beneficiary: "Same as Traditional IRA. 10-year rule for non-spouse.", death: "Same as Traditional IRA. RMDs at 73.", bestFor: "Self-employed, freelancers, small business owners seeking maximum pre-tax contributions." },
  { name: "529 Plan", tags: ["Education", "Tax-Advantaged"], desc: "Tax-advantaged education savings. Growth and qualified withdrawals for education are tax-free.", tax: "After-tax contributions (many states offer deduction). Non-qualified: earnings taxed + 10% penalty. Up to $35,000 rollable to Roth IRA.", beneficiary: "Account owner controls. Beneficiary changeable to family member anytime.", death: "Successor owner takes over if named. Otherwise enters estate.", bestFor: "Children's education, state tax deductions, Roth IRA rollover option." },
  { name: "HSA", tags: ["Triple Tax", "Healthcare"], desc: "Triple tax advantage: deductible contributions, tax-free growth, tax-free medical withdrawals. Requires HDHP.", tax: "2025: $4,300 individual / $8,550 family ($1,000 catch-up if 55+). After 65, non-medical withdrawals taxed as income only.", beneficiary: "Spouse: becomes their HSA. Non-spouse: taxable lump sum as ordinary income.", death: "Worst account to leave to non-spouse. Spend it or leave to spouse.", bestFor: "Long-term medical savings, retirement health costs, maximizing triple tax advantage." },
  { name: "Trust Account", tags: ["Estate Planning", "Flexible"], desc: "Investment account within a trust structure for estate planning, asset protection, and controlled distributions.", tax: "Revocable: taxed at grantor's rates. Irrevocable: compressed brackets (37% at ~$14,450).", beneficiary: "Trust document specifies everything. Can include staggered distributions, spendthrift provisions.", death: "Revocable becomes irrevocable. Avoids probate. Revocable assets get stepped-up basis.", bestFor: "Estate planning, probate avoidance, controlled distributions, high-net-worth." },
  { name: "Custodial (UTMA/UGMA)", tags: ["Minor's Account", "Taxable"], desc: "Account for minors. Assets belong irrevocably to the minor and transfer at age of majority.", tax: "First $1,300 unearned income tax-free. Next $1,300 at child's rate. Above $2,600 at parent's rate.", beneficiary: "The minor IS the owner. Cannot be changed. Full control at 18 (UGMA) or 18-21 (UTMA).", death: "Custodian dies: successor takes over. Minor dies: to minor's estate. Cannot revert to parent.", bestFor: "Gifts to minors, non-education goals." },
  { name: "Joint Account", tags: ["Shared Ownership", "Taxable"], desc: "Shared taxable account. Common types: JTWROS (survivor inherits) and Tenants in Common.", tax: "Same as individual taxable. Reporting depends on structure.", beneficiary: "JTWROS: survivor inherits automatically. TIC: deceased share through estate.", death: "JTWROS: passes to survivor with stepped-up basis on decedent's half.", bestFor: "Couples investing together, simple survivorship planning." },
  { name: "Designated Beneficiary", tags: ["Inherited", "Distribution Rules"], desc: "Inherited account subject to specific distribution rules based on relationship and account type.", tax: "Non-spouse: 10-year depletion. Traditional: taxed as income. Roth: tax-free if 5-year rule met.", beneficiary: "Cannot name successor beneficiary. If beneficiary dies, remainder goes to their estate.", death: "10-year clock doesn't reset. Remaining taxed to estate.", bestFor: "Understanding inherited account rules, tax planning for inherited wealth." }
];

function renderAccountInfoCards() {
  const g = document.getElementById('acctInfoGrid');
  if (!g) return;
  g.innerHTML = ACCT_INFO.map(a =>
    '<div class="acct-info-card">' +
    '<h4>' + a.name + '</h4>' +
    '<div style="margin-bottom:8px;">' + a.tags.map(t => '<span class="acct-tag">' + t + '</span>').join('') + '</div>' +
    '<p>' + a.desc + '</p>' +
    '<div class="acct-detail"><strong style="color:' + C.navy + ';">Tax:</strong> ' + a.tax + '</div>' +
    '<div class="acct-detail"><strong style="color:' + C.navy + ';">Beneficiaries:</strong> ' + a.beneficiary + '</div>' +
    '<div class="acct-detail"><strong style="color:' + C.navy + ';">After Death:</strong> ' + a.death + '</div>' +
    '<div class="acct-detail" style="margin-top:4px;"><strong style="color:' + C.success + ';">Best For:</strong> ' + a.bestFor + '</div>' +
    '</div>'
  ).join('');
}
setTimeout(renderAccountInfoCards, 100);


// ═══ RESEARCH ═══
let researchChart = null;
var researchRange = '1y';
var researchTicker = '';
var researchChartMode = 'pct'; // 'pct' or 'price'
var researchShowDividends = false;
var _researchDividendData = null; // cached dividend info for current ticker
var _researchMainPtsCache = null; // cached main chart points

window.toggleResearchChartMode = function(mode) {
  researchChartMode = mode;
  document.getElementById('btnResearchPct').classList.toggle('active', mode === 'pct');
  document.getElementById('btnResearchPrice').classList.toggle('active', mode === 'price');
  if (researchTicker) updateResearchChart();
};

window.toggleResearchDividends = function() {
  researchShowDividends = !researchShowDividends;
  document.getElementById('btnResearchDividends').classList.toggle('active', researchShowDividends);
  if (researchTicker) updateResearchChart();
};

// Bind timeframe buttons for research chart
setTimeout(function() {
  var btns = document.querySelectorAll('#researchTimeframeBtns .btn-outline');
  btns.forEach(function(b) {
    b.addEventListener('click', function() {
      btns.forEach(function(x) { x.classList.remove('active'); });
      b.classList.add('active');
      researchRange = b.getAttribute('data-range');
      if (researchTicker) updateResearchChart();
    });
  });
}, 200);

// ═══ RESEARCH CHART — full interactive chart with benchmarks ═══
// Helper: build dividend cumulative return series from cached dividend data
function buildDividendSeries(labels, mainClose, divData) {
  // divData: { annualDividend, frequency, payoutMonths, lastDividend }
  if (!divData || !divData.annualDividend || divData.annualDividend <= 0) return null;
  var freq = divData.frequency || 4; // quarterly default
  var divPerPayout = divData.annualDividend / freq;
  // Determine payout months based on frequency
  var payoutMonths;
  if (divData.payoutMonths && divData.payoutMonths.length) {
    payoutMonths = divData.payoutMonths;
  } else if (freq === 12) {
    payoutMonths = [1,2,3,4,5,6,7,8,9,10,11,12];
  } else if (freq === 4) {
    payoutMonths = [3,6,9,12];
  } else if (freq === 2) {
    payoutMonths = [6,12];
  } else {
    payoutMonths = [12];
  }
  var payoutSet = {};
  payoutMonths.forEach(function(m) { payoutSet[m] = true; });

  // Build adjusted price series: on payout dates, add dividend to cumulative total
  var cumulativeDividends = 0;
  var adjustedClose = [];
  var lastPayoutMonth = -1;
  for (var i = 0; i < labels.length; i++) {
    var dateStr = labels[i];
    var month = parseInt(dateStr.slice(5, 7));
    // Check if this is a new payout month we haven't paid yet
    if (payoutSet[month] && month !== lastPayoutMonth) {
      cumulativeDividends += divPerPayout;
      lastPayoutMonth = month;
    }
    adjustedClose.push(mainClose[i] + cumulativeDividends);
  }
  return adjustedClose;
}

window.updateResearchChart = async function() {
  if (!researchTicker) return;
  var loadEl = document.getElementById('researchChartLoading');
  if (loadEl) loadEl.style.display = 'block';
  var statsEl = document.getElementById('researchChartStats');
  if (statsEl) statsEl.innerHTML = '';
  var isPriceMode = researchChartMode === 'price';
  var showDiv = researchShowDividends;

  try {
    // Determine interval based on range
    var interval = '1d';
    if (researchRange === '1mo') interval = '1h';

    // Fetch ticker data
    var mainData = await fetchChart(researchTicker, researchRange, interval);
    var mainPts = (mainData.points || []).filter(function(p) { return p.close != null; });
    if (!mainPts.length) { if (loadEl) loadEl.style.display = 'none'; return; }

    // Fetch benchmarks
    var b1 = (document.getElementById('researchBench1')?.value || '').trim().toUpperCase();
    var b2 = (document.getElementById('researchBench2')?.value || '').trim().toUpperCase();
    var benchData = {};
    for (var bk of [b1, b2]) {
      if (bk && bk !== researchTicker) {
        try {
          var bd = await fetchChart(bk, researchRange, interval);
          var bpts = (bd.points || []).filter(function(p) { return p.close != null; });
          var bmap = {};
          var bIsIntraday = interval !== '1d' && interval !== '1wk' && interval !== '1mo';
          bpts.forEach(function(p) {
            var key = bIsIntraday ? p.date.slice(0, 16).replace('T',' ') : p.date.slice(0, 10);
            bmap[key] = p.close;
          });
          benchData[bk] = bmap;
        } catch(e) {}
      }
    }

    // Build date labels and datasets
    // For intraday intervals, keep the full date+time; for daily, truncate to day
    var isIntraday = interval !== '1d' && interval !== '1wk' && interval !== '1mo';
    var labels = mainPts.map(function(p) { return isIntraday ? p.date.slice(0, 16).replace('T',' ') : p.date.slice(0, 10); });
    var mainClose = mainPts.map(function(p) { return p.close; });
    var mainVolume = mainPts.map(function(p) { return p.volume || 0; });
    var mainStart = mainClose[0];

    // Build dividend-adjusted series if enabled
    var divAdjusted = null;
    if (showDiv && _researchDividendData) {
      divAdjusted = buildDividendSeries(labels, mainClose, _researchDividendData);
    }

    // Determine main data series based on mode
    var mainDisplayData, mainLabel, yTickFn, tooltipFn, yTitle;
    if (isPriceMode) {
      // LAST PRICE mode
      var displaySeries = (showDiv && divAdjusted) ? divAdjusted : mainClose;
      mainDisplayData = displaySeries;
      mainLabel = researchTicker + (showDiv && divAdjusted ? ' (w/ Div)' : '');
      yTickFn = function(v) { return '$' + (v >= 1000 ? (v/1000).toFixed(1)+'K' : v.toFixed(2)); };
      tooltipFn = function(ctx) {
        if (ctx.dataset.label === 'Volume') return null;
        var val = ctx.parsed.y;
        if (val == null) return null;
        if (ctx.dataset.yAxisID === 'y1') return ' ' + ctx.dataset.label + ': $' + val.toFixed(2);
        return ' ' + ctx.dataset.label + ': $' + val.toFixed(2);
      };
      yTitle = 'Price ($)';
    } else {
      // % CHANGE mode
      var baseSeries = (showDiv && divAdjusted) ? divAdjusted : mainClose;
      var baseStart = baseSeries[0];
      mainDisplayData = baseSeries.map(function(v) { return ((v / baseStart) - 1) * 100; });
      mainLabel = researchTicker + (showDiv && divAdjusted ? ' (w/ Div)' : '');
      yTickFn = function(v) { return (v >= 0 ? '+' : '') + v.toFixed(1) + '%'; };
      tooltipFn = function(ctx) {
        if (ctx.dataset.label === 'Volume') return null;
        var val = ctx.parsed.y;
        if (val == null) return null;
        return ' ' + ctx.dataset.label + ': ' + (val >= 0 ? '+' : '') + val.toFixed(2) + '%';
      };
      yTitle = 'Return (%)';
    }

    var datasets = [{
      label: mainLabel,
      data: mainDisplayData,
      borderColor: C.navy,
      backgroundColor: 'rgba(0,60,113,0.08)',
      fill: true,
      borderWidth: 2,
      pointRadius: 0,
      pointHitRadius: 8,
      tension: 0.1,
      yAxisID: 'y',
      order: 1
    }];

    // If dividends on and price mode, also show the raw price line for comparison
    if (showDiv && divAdjusted && isPriceMode) {
      datasets.push({
        label: researchTicker + ' (Price Only)',
        data: mainClose,
        borderColor: C.highlightGray,
        borderWidth: 1.5,
        borderDash: [3, 3],
        pointRadius: 0,
        fill: false,
        tension: 0.1,
        yAxisID: 'y',
        order: 1
      });
    }

    // Volume bars dataset
    datasets.push({
      label: 'Volume',
      data: mainVolume,
      type: 'bar',
      backgroundColor: 'rgba(200,208,216,0.4)',
      borderColor: 'rgba(200,208,216,0.6)',
      borderWidth: 0,
      yAxisID: 'yVol',
      order: 2,
      barPercentage: 0.8,
      categoryPercentage: 1.0
    });

    // Benchmark datasets
    var benchColors = [C.blue, '#C8D0D8'];
    var bi = 0;
    var hasBench = false;
    for (var bkey in benchData) {
      var bm = benchData[bkey];
      var firstBv = null;
      if (isPriceMode) {
        // Price mode: benchmarks on secondary axis
        var bArr = labels.map(function(d) { return bm[d] != null ? bm[d] : null; });
        datasets.push({
          label: bkey,
          data: bArr,
          borderColor: benchColors[bi] || '#999',
          borderWidth: 1.5,
          borderDash: [4, 3],
          pointRadius: 0,
          fill: false,
          tension: 0.1,
          yAxisID: 'y1'
        });
      } else {
        // % mode: benchmarks indexed from start
        var bArr = labels.map(function(d) {
          var v = bm[d];
          if (v != null && firstBv == null) firstBv = v;
          return (v != null && firstBv) ? ((v / firstBv) - 1) * 100 : null;
        });
        datasets.push({
          label: bkey,
          data: bArr,
          borderColor: benchColors[bi] || '#999',
          borderWidth: 1.5,
          borderDash: [4, 3],
          pointRadius: 0,
          fill: false,
          tension: 0.1,
          yAxisID: 'y'
        });
      }
      hasBench = true;
      bi++;
    }

    // Stats bar
    var lastPrice = mainClose[mainClose.length - 1];
    var totalReturn = ((lastPrice / mainStart) - 1) * 100;
    var high = Math.max.apply(null, mainClose);
    var low = Math.min.apply(null, mainClose);
    var divReturnStr = '';
    if (showDiv && divAdjusted) {
      var divTotalReturn = ((divAdjusted[divAdjusted.length - 1] / divAdjusted[0]) - 1) * 100;
      divReturnStr = '<span style="margin-left:16px;font-weight:700;color:' + C.navy + ';">Total w/ Div: ' + (divTotalReturn >= 0 ? '+' : '') + divTotalReturn.toFixed(2) + '%</span>';
    }
    if (statsEl) {
      var trc = totalReturn >= 0 ? C.success : C.danger;
      statsEl.innerHTML =
        '<span style="font-weight:700;color:' + trc + ';">' + (totalReturn >= 0 ? '+' : '') + totalReturn.toFixed(2) + '% price return</span>' +
        divReturnStr +
        '<span style="margin-left:16px;color:' + C.textSec + ';">High: $' + high.toFixed(2) + '</span>' +
        '<span style="margin-left:12px;color:' + C.textSec + ';">Low: $' + low.toFixed(2) + '</span>' +
        '<span style="margin-left:12px;color:' + C.textSec + ';">Current: $' + lastPrice.toFixed(2) + '</span>';
    }

    // Render chart
    var ctx = document.getElementById('researchChart').getContext('2d');
    if (researchChart) researchChart.destroy();

    researchChart = new Chart(ctx, {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { right: 70 } },
        plugins: {
          legend: { position: 'top', labels: { usePointStyle: true, font: { family: 'Arial', size: 11 },
            filter: function(item) { return item.text !== 'Volume'; }
          } },
          tooltip: {
            mode: 'index', intersect: false,
            filter: function(item) { return item.dataset.label !== 'Volume'; },
            callbacks: { label: tooltipFn }
          },
          zoom: { zoom: { drag: { enabled: true, backgroundColor: 'rgba(91,155,213,0.15)' }, mode: 'x' }, pan: { enabled: false } }
        },
        scales: {
          x: {
            ticks: { maxTicksLimit: 12, font: { size: 10, family: 'Arial' }, color: C.textSec },
            grid: { color: 'rgba(208,215,224,0.4)' }
          },
          y: {
            position: 'left',
            ticks: { callback: yTickFn, font: { size: 10, family: 'Arial' }, color: C.textSec },
            grid: { color: 'rgba(208,215,224,0.4)' },
            title: { display: true, text: yTitle, font: { family: 'Arial', size: 12, weight: '600' }, color: C.textSec }
          },
          y1: {
            type: 'linear', position: 'right', display: isPriceMode && hasBench,
            grid: { drawOnChartArea: false },
            ticks: { callback: function(v) { return '$' + v.toFixed(2); }, font: { size: 10, family: 'Arial' }, color: C.textSec },
            border: { display: false },
            title: { display: isPriceMode && hasBench, text: 'Benchmark Price ($)', font: { family: 'Arial', size: 12, weight: '600' }, color: C.textSec }
          },
          yVol: {
            position: 'right', display: false,
            grid: { drawOnChartArea: false },
            min: 0,
            max: Math.max.apply(null, mainVolume) * 5
          }
        }
      }
    });

  } catch(e) { console.error('Research chart error:', e); }
  if (loadEl) loadEl.style.display = 'none';
};

// ═══ ETF/FUND DETECTION AND RENDERING ═══
function renderETFAnalysis(ticker, d) {
  var profile = d.profile || {};
  var price = d.price || {};
  var tech = d.technicals || {};
  var at = d.analystTargets || {};
  var chg = price.change || 0;
  var chgPct = price.changePercent || 0;
  var cc = chg >= 0 ? C.success : C.danger;
  var p = price.current || 0;

  var h = '';
  // ETF Header
  h += '<div class="card"><div class="card-title">' + (profile.name || ticker) + ' (' + ticker + ') — ETF / Fund</div><div class="card-body">';
  if (profile.description) h += '<p style="font-size:12px;color:'+C.textSec+';line-height:1.6;margin-bottom:10px;">' + profile.description.substring(0, 500) + '</p>';
  h += '<div style="font-size:11px;color:'+C.textSec+';">';
  if (profile.website) h += '<strong>Website:</strong> ' + profile.website + ' &nbsp;|&nbsp; ';
  if (profile.sector) h += '<strong>Category:</strong> ' + profile.sector + ' &nbsp;|&nbsp; ';
  if (profile.industry) h += profile.industry;
  h += '</div></div></div>';

  // Price Row
  h += '<div class="metrics-row">';
  h += mcBig(ticker, '$' + p.toFixed(2), fmtR(chgPct) + ' ($' + chg.toFixed(2) + ')', cc);
  h += mcBig('AUM / Mkt Cap', profile.marketCap ? fmtB(profile.marketCap) : '—', 'ETF', C.textSec);
  h += mcBig('52-Week', (tech.fiftyTwoWeekLow ? '$'+tech.fiftyTwoWeekLow : '—') + ' — ' + (tech.fiftyTwoWeekHigh ? '$'+tech.fiftyTwoWeekHigh : '—'), '', C.textSec);
  h += mcBig('Volume', price.volume ? Number(price.volume).toLocaleString() : '—', 'Prev: $' + (price.previousClose || 0).toFixed(2), C.textSec);
  h += '</div>';

  // ETF-specific cards
  h += '<div class="grid-3">';
  h += researchTable('Fund Overview', [
    ['Fund Type', profile.type === 'ETF' ? 'Exchange-Traded Fund' : 'Mutual Fund'],
    ['Category', profile.sector || '—'],
    ['Sub-Category', profile.industry || '—'],
    null,
    ['Inception', profile.ipoDate || '—'],
    ['Beta', profile.beta ? profile.beta.toFixed(2) : '—'],
    ['Dividend Yield', profile.lastDividend && p > 0 ? (profile.lastDividend / p * 100).toFixed(2) + '%' : '—'],
    ['Last Dividend', profile.lastDividend ? '$' + profile.lastDividend.toFixed(4) : '—'],
  ]);

  h += researchTable('Technical Indicators', [
    ['Current Price', '$' + p.toFixed(2)],
    ['50-Day Avg', tech.fiftyDayAverage ? '$' + tech.fiftyDayAverage.toFixed(2) : '—'],
    ['200-Day Avg', tech.twoHundredDayAverage ? '$' + tech.twoHundredDayAverage.toFixed(2) : '—'],
    null,
    ['52-Week High', tech.fiftyTwoWeekHigh ? '$' + tech.fiftyTwoWeekHigh.toFixed(2) : '—'],
    ['52-Week Low', tech.fiftyTwoWeekLow ? '$' + tech.fiftyTwoWeekLow.toFixed(2) : '—'],
    ['vs 52W High', tech.fiftyTwoWeekHigh ? ((p / tech.fiftyTwoWeekHigh - 1) * 100).toFixed(1) + '%' : '—', tech.fiftyTwoWeekHigh ? pcC((p / tech.fiftyTwoWeekHigh - 1) * 100) : C.text],
  ]);

  h += researchTable('Analyst Targets', [
    ['Target High', at.high ? '$' + at.high.toFixed(2) : '—'],
    ['Target Mean', at.mean ? '$' + at.mean.toFixed(2) : '—'],
    ['Target Low', at.low ? '$' + at.low.toFixed(2) : '—'],
    null,
    ['Upside (Mean)', at.mean && p > 0 ? fmtR((at.mean / p - 1) * 100) : '—', at.mean && p > 0 ? pcC((at.mean / p - 1) * 100) : C.text],
  ]);
  h += '</div>';

  // Note about data limitations
  h += '<div class="card"><div class="card-title" style="background:var(--blue);">ETF Data Note</div><div class="card-body">';
  h += '<p style="font-size:12px;color:'+C.textSec+';line-height:1.6;">ETFs and mutual funds do not file 10-K annual reports with the SEC in the same format as individual companies. Detailed holdings, expense ratios, and sector breakdowns are reported via N-PORT and N-CEN filings. The data shown above is sourced from FMP company profiles and Yahoo Finance real-time pricing.</p>';
  h += '</div></div>';

  return h;
}

// ═══ CRYPTO DETECTION AND RENDERING ═══
function isCrypto(ticker) {
  return ticker.includes('-USD') || ticker.includes('-EUR') || ticker.includes('-GBP') ||
    ['BTC', 'ETH', 'SOL', 'DOGE', 'ADA', 'XRP', 'DOT', 'AVAX', 'MATIC', 'LINK', 'UNI', 'AAVE', 'LTC', 'BCH', 'SHIB'].indexOf(ticker.replace(/-.*/, '')) >= 0;
}

function renderCryptoAnalysis(ticker, price, tech) {
  var p = price.current || 0;
  var chg = price.change || 0;
  var chgPct = price.changePercent || 0;
  var cc = chg >= 0 ? C.success : C.danger;
  var baseTicker = ticker.replace(/-.*/, '');

  var h = '';
  h += '<div class="card"><div class="card-title">' + baseTicker + ' — Cryptocurrency</div><div class="card-body">';
  h += '<p style="font-size:12px;color:'+C.textSec+';line-height:1.6;">Cryptocurrency pricing data sourced from Yahoo Finance. Cryptocurrencies do not file SEC reports, so financial statement analysis is not available.</p>';
  h += '</div></div>';

  h += '<div class="metrics-row">';
  h += mcBig(baseTicker, '$' + (p >= 1 ? p.toFixed(2) : p.toFixed(6)), fmtR(chgPct) + ' ($' + chg.toFixed(2) + ')', cc);
  h += mcBig('24H Volume', price.volume ? Number(price.volume).toLocaleString() : '—', '', C.textSec);
  h += mcBig('24H Range', (price.dayLow ? '$' + price.dayLow.toFixed(2) : '—') + ' — ' + (price.dayHigh ? '$' + price.dayHigh.toFixed(2) : '—'), '', C.textSec);
  h += mcBig('Prev Close', '$' + (price.previousClose || 0).toFixed(2), price.exchange || '', C.textSec);
  h += '</div>';

  h += '<div class="grid-3">';
  h += researchTable('Price Data', [
    ['Current Price', '$' + p.toFixed(p >= 1 ? 2 : 6)],
    ['24H Change', fmtR(chgPct), cc],
    ['Currency', price.currency || 'USD'],
    null,
    ['Market State', price.marketState || '—'],
    ['Exchange', price.exchange || '—'],
  ]);

  h += researchTable('Technical Levels', [
    ['52-Week High', tech?.fiftyTwoWeekHigh ? '$' + tech.fiftyTwoWeekHigh.toFixed(2) : '—'],
    ['52-Week Low', tech?.fiftyTwoWeekLow ? '$' + tech.fiftyTwoWeekLow.toFixed(2) : '—'],
    null,
    ['50-Day Avg', tech?.fiftyDayAverage ? '$' + tech.fiftyDayAverage.toFixed(2) : '—'],
    ['200-Day Avg', tech?.twoHundredDayAverage ? '$' + tech.twoHundredDayAverage.toFixed(2) : '—'],
    null,
    ['vs 52W High', tech?.fiftyTwoWeekHigh ? ((p / tech.fiftyTwoWeekHigh - 1) * 100).toFixed(1) + '%' : '—', tech?.fiftyTwoWeekHigh ? pcC((p / tech.fiftyTwoWeekHigh - 1) * 100) : C.text],
    ['vs 50D Avg', tech?.fiftyDayAverage ? ((p / tech.fiftyDayAverage - 1) * 100).toFixed(1) + '%' : '—', tech?.fiftyDayAverage ? pcC((p / tech.fiftyDayAverage - 1) * 100) : C.text],
  ]);

  h += researchTable('Crypto Note', [
    ['SEC Filing', 'N/A — Not a registered security'],
    ['Financial Stmts', 'N/A — Decentralized asset'],
    ['Data Source', 'Yahoo Finance (real-time)'],
  ]);
  h += '</div>';

  return h;
}

// Helper: render a data table from key-value pairs
function researchTable(title, rows) {
  let html = '<div class="card"><div class="card-title">' + title + '</div><div class="card-body">' +
    '<table style="font-size:12px;">';
  rows.forEach(function(r) {
    if (r === null) {
      html += '<tr><td colspan="2" style="border-bottom:2px solid var(--border);padding:4px;"></td></tr>';
      return;
    }
    var val = r[1] != null ? r[1] : '—';
    var color = r[2] || C.text;
    html += '<tr><td style="font-weight:600;color:' + C.textSec + ';padding:6px 12px 6px 0;white-space:nowrap;">' + r[0] + '</td>' +
      '<td style="font-weight:600;color:' + color + ';padding:6px 0;">' + val + '</td></tr>';
  });
  html += '</table></div><div class="card-sources"><strong>Sources:</strong><br>&#8226; Yahoo Finance via Cloudflare Worker</div></div>';
  return html;
}

function fmtB(v) {
  if (v == null) return '—';
  if (Math.abs(v) >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
  if (Math.abs(v) >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  return fmt(v);
}
function fmtR(v) { return v != null ? (v >= 0 ? '+' : '') + v.toFixed(2) + '%' : '—'; }
function pcC(v) { return v != null ? (v >= 0 ? C.success : C.danger) : C.text; }

async function fetchFundamentals(ticker) {
  ticker = ticker.toUpperCase();

  // 1. Check Firebase cache first (instant if available)
  if (window._getSecCache) {
    try {
      var cached = await window._getSecCache(ticker);
      if (cached) {
        console.log("SEC data for " + ticker + " loaded from Firebase cache");
        // Still fetch fresh price from Yahoo (cache has stale price)
        try {
          var freshQuote = await fetchQuote(ticker);
          if (freshQuote && freshQuote.current) {
            cached.price = {
              current: freshQuote.current || freshQuote.price,
              previousClose: freshQuote.previousClose,
              change: freshQuote.change,
              changePercent: freshQuote.changePercent,
              volume: freshQuote.volume,
              dayHigh: freshQuote.dayHigh || freshQuote.intradayHigh,
              dayLow: freshQuote.dayLow || freshQuote.intradayLow,
              currency: freshQuote.currency,
              exchange: freshQuote.exchange
            };
          }
        } catch (pe) { /* price refresh failed, use cached price */ }
        return cached;
      }
    } catch (ce) { console.warn("Cache check failed:", ce); }
  }

  // 2. Cache miss — fetch from Worker (SEC EDGAR + FMP + Yahoo)
  var r = await fetch(WORKER_URL + "/fundamentals?symbol=" + encodeURIComponent(ticker));
  var d = await r.json();
  if (d.error) throw new Error(d.error);

  // 3. Store in Firebase cache for next time
  if (window._setSecCache && d.incomeStatement) {
    window._setSecCache(ticker, d); // async, don't await
    console.log("SEC data for " + ticker + " cached to Firebase");
  }

  return d;
}

// ════════════════════════════════════════════════════
// RENDER SEC FINANCIAL DATA — pure JS, no AI needed
// ════════════════════════════════════════════════════
function renderSECAnalysis(ticker, d) {
  var profile = d.profile || {};
  var price = d.price || {};
  var tech = d.technicals || {};
  var inc = d.incomeStatement || {};
  var bs = d.balanceSheet || {};
  var cf = d.cashFlowStatement || {};
  var at = d.analystTargets || {};
  var ar = d.analystRatings || {};

  // Helper: get latest value from a series array
  function L(arr) { return arr && arr.length ? arr[arr.length - 1].value : null; }
  function L2(arr) { return arr && arr.length >= 2 ? arr[arr.length - 2].value : null; }
  function N(v) { if (v == null) return '—'; var a = Math.abs(v); if (a >= 1e12) return '$'+(v/1e12).toFixed(2)+'T'; if (a >= 1e9) return '$'+(v/1e9).toFixed(2)+'B'; if (a >= 1e6) return '$'+(v/1e6).toFixed(1)+'M'; if (a >= 1e3) return '$'+(v/1e3).toFixed(1)+'K'; return '$'+v.toFixed(0); }
  function P(v) { return v != null ? (v >= 0 ? '+' : '') + v.toFixed(2) + '%' : '—'; }
  function D(v) { return v != null ? v.toFixed(2) : '—'; }
  function cl(v) { return v != null ? (v >= 0 ? C.success : C.danger) : C.text; }

  // Compute ratios from SEC data
  var rev = L(inc.revenue);
  var gp = L(inc.grossProfit);
  var opInc = L(inc.operatingIncome);
  var ni = L(inc.netIncome);
  var eps = L(inc.eps);
  var ta = L(bs.totalAssets);
  var tl = L(bs.totalLiabilities);
  var eq = L(bs.stockholdersEquity);
  var ca = L(bs.currentAssets);
  var clb = L(bs.currentLiabilities);
  var cash = L(bs.cash) || 0;
  var stInv = L(bs.shortTermInvestments) || 0;
  var ltDebt = L(bs.longTermDebt) || 0;
  var stDebt = L(bs.shortTermDebt) || 0;
  var shares = L(bs.sharesOutstanding);
  var opCF = L(cf.operatingCashFlow);
  var capex = L(cf.capitalExpenditures) || 0;
  var depAmort = L(inc.depreciationAmortization) || 0;

  var totalCash = cash + stInv;
  var totalDebt = ltDebt + stDebt;
  var fcf = opCF ? opCF - Math.abs(capex) : null;
  var ebitda = opInc ? opInc + depAmort : null;
  var p = price.current || 0;
  var chg = price.change || 0;
  var chgPct = price.changePercent || 0;
  var cc = chg >= 0 ? C.success : C.danger;

  // Margins
  var grossMargin = rev && gp ? (gp / rev * 100) : null;
  var opMargin = rev && opInc ? (opInc / rev * 100) : null;
  var netMargin = rev && ni ? (ni / rev * 100) : null;
  var roe = eq && ni ? (ni / eq * 100) : null;
  var roa = ta && ni ? (ni / ta * 100) : null;
  var currentRatio = ca && clb ? (ca / clb) : null;
  var debtToEquity = eq ? (totalDebt / eq * 100) : null;

  // Price ratios
  var pe = eps && eps > 0 && p > 0 ? (p / eps) : null;
  var bvps = eq && shares ? (eq / shares) : null;
  var pb = bvps && bvps > 0 && p > 0 ? (p / bvps) : null;
  var ps = rev && shares && p > 0 ? (p / (rev / shares)) : null;
  var mktCap = profile.marketCap || (shares && p ? shares * p : null);
  var ev = mktCap ? mktCap + totalDebt - totalCash : null;
  var evRev = ev && rev ? (ev / rev) : null;
  var evEbitda = ev && ebitda && ebitda > 0 ? (ev / ebitda) : null;

  // Growth
  var prevRev = L2(inc.revenue);
  var prevNI = L2(inc.netIncome);
  var revGrowth = rev && prevRev && prevRev > 0 ? ((rev - prevRev) / prevRev * 100) : null;
  var niGrowth = ni && prevNI && prevNI > 0 ? ((ni - prevNI) / prevNI * 100) : null;

  // CAGR (5Y)
  function cagr(arr) {
    if (!arr || arr.length < 2) return null;
    var first = arr[0].value, last = arr[arr.length - 1].value;
    if (!first || first <= 0 || !last || last <= 0) return null;
    return (Math.pow(last / first, 1 / (arr.length - 1)) - 1) * 100;
  }

  // Dividend
  var divPS = d.dividends && d.dividends.length ? d.dividends[d.dividends.length - 1].value : (profile.lastDividend || null);
  var divYield = divPS && p > 0 ? (divPS / p * 100) : null;
  var payoutRatio = divPS && eps && eps > 0 ? (divPS / eps * 100) : null;

  var h = '';

  // ── Company Header ──
  h += '<div class="card"><div class="card-title">' + (profile.name || ticker) + ' (' + ticker + ') — ' + (profile.sector || '') + ' / ' + (profile.industry || '') + '</div><div class="card-body">';
  if (profile.description) h += '<p style="font-size:12px;color:'+C.textSec+';line-height:1.6;margin-bottom:10px;">' + profile.description.substring(0, 500) + (profile.description.length > 500 ? '...' : '') + '</p>';
  h += '<div style="font-size:11px;color:'+C.textSec+';">';
  if (profile.website) h += '<strong>Website:</strong> ' + profile.website + ' &nbsp;|&nbsp; ';
  if (profile.city) h += profile.city + (profile.state ? ', ' + profile.state : '') + ' &nbsp;|&nbsp; ';
  if (profile.employees) h += '<strong>Employees:</strong> ' + Number(profile.employees).toLocaleString() + ' &nbsp;|&nbsp; ';
  if (profile.ceo) h += '<strong>CEO:</strong> ' + profile.ceo;
  h += '</div></div></div>';

  // ── Price Row ──
  h += '<div class="metrics-row">';
  h += mcBig(ticker, '$' + p.toFixed(2), P(chgPct) + ' ($' + chg.toFixed(2) + ')', cc);
  h += mcBig('Market Cap', mktCap ? N(mktCap) : '—', profile.type || '', C.textSec);
  h += mcBig('52-Week', (tech.fiftyTwoWeekLow ? '$'+tech.fiftyTwoWeekLow : '—') + ' — ' + (tech.fiftyTwoWeekHigh ? '$'+tech.fiftyTwoWeekHigh : '—'), (tech.fiftyDayAverage ? '50d: $'+tech.fiftyDayAverage : ''), C.textSec);
  h += mcBig('Volume', price.volume ? Number(price.volume).toLocaleString() : '—', 'Prev Close: $' + (price.previousClose || 0).toFixed(2), C.textSec);
  h += '</div>';

  // ── Valuation + Profitability + Financial Health ──
  h += '<div class="grid-3">';
  h += researchTable('Valuation Ratios', [
    ['P/E Ratio', D(pe)], ['Price/Book', D(pb)], ['Price/Sales', D(ps)],
    null, ['EV/Revenue', D(evRev)], ['EV/EBITDA', D(evEbitda)],
    null, ['Enterprise Value', ev ? N(ev) : '—'],
    ['EPS (Diluted)', eps != null ? '$' + Number(eps).toFixed(2) : '—'],
    ['Book Value/Share', bvps != null ? '$' + bvps.toFixed(2) : '—']
  ]);
  h += researchTable('Profitability', [
    ['Gross Margin', P(grossMargin), cl(grossMargin)],
    ['Operating Margin', P(opMargin), cl(opMargin)],
    ['Net Margin', P(netMargin), cl(netMargin)],
    null,
    ['Return on Equity', P(roe), cl(roe)],
    ['Return on Assets', P(roa), cl(roa)],
    null,
    ['EBITDA', ebitda ? N(ebitda) : '—'],
    ['Free Cash Flow', fcf != null ? N(fcf) : '—'],
    ['Operating CF', opCF ? N(opCF) : '—']
  ]);
  h += researchTable('Financial Health', [
    ['Current Ratio', D(currentRatio)],
    ['Debt/Equity', D(debtToEquity)],
    null,
    ['Total Debt', N(totalDebt)],
    ['Total Cash', N(totalCash)],
    ['Net Debt', N(totalDebt - totalCash)],
    null,
    ['Total Assets', ta ? N(ta) : '—'],
    ['Equity', eq ? N(eq) : '—'],
    ['Shares Out', shares ? N(shares).replace('$','') : '—']
  ]);
  h += '</div>';

  // ── Growth + Dividends + Analyst ──
  h += '<div class="grid-3">';
  h += researchTable('Growth Metrics', [
    ['Revenue (YoY)', P(revGrowth), cl(revGrowth)],
    ['Net Income (YoY)', P(niGrowth), cl(niGrowth)],
    null,
    ['Revenue CAGR', P(cagr(inc.revenue)), cl(cagr(inc.revenue))],
    ['Net Income CAGR', P(cagr(inc.netIncome)), cl(cagr(inc.netIncome))],
    null,
    ['Beta', profile.beta ? D(profile.beta) : '—']
  ]);
  h += researchTable('Dividends', [
    ['Dividend/Share', divPS != null ? '$' + Number(divPS).toFixed(2) : 'None'],
    ['Dividend Yield', divYield != null ? divYield.toFixed(2) + '%' : 'None'],
    ['Payout Ratio', payoutRatio != null ? payoutRatio.toFixed(1) + '%' : '—']
  ]);
  var totalA = (ar.strongBuy||0)+(ar.buy||0)+(ar.hold||0)+(ar.sell||0)+(ar.strongSell||0);
  h += researchTable('Analyst Estimates', [
    ['Target High', at.high ? '$'+at.high.toFixed(2) : '—'],
    ['Target Mean', at.mean ? '$'+at.mean.toFixed(2) : '—'],
    ['Target Low', at.low ? '$'+at.low.toFixed(2) : '—'],
    null,
    ['Strong Buy', ar.strongBuy || 0], ['Buy', ar.buy || 0],
    ['Hold', ar.hold || 0], ['Sell', ar.sell || 0],
    ['# Analysts', totalA || '—']
  ]);
  h += '</div>';

  // ── Financial Statement Tables now live in Financial Statements & Forecasts tab ──
  // (rendered by resRenderFinancials when that tab is visited or data loads)

  return h;
}
// ═══ HEADER RENDERERS
function renderStockHeader(ticker, d) {
  var profile = d.profile || {};
  var price   = d.price   || {};
  var tech    = d.technicals || {};
  var inc     = d.incomeStatement || {};
  var bs      = d.balanceSheet    || {};
  var cf      = d.cashFlowStatement || {};
  var at      = d.analystTargets  || {};
  var ar      = d.analystRatings  || {};

  function L(arr) { return arr && arr.length ? arr[arr.length-1].value : null; }
  function L2(arr){ return arr && arr.length>=2 ? arr[arr.length-2].value : null; }
  function Nm(v)  { if(v==null)return'—'; var a=Math.abs(v); if(a>=1e12)return'$'+(v/1e12).toFixed(2)+'T'; if(a>=1e9)return'$'+(v/1e9).toFixed(2)+'B'; if(a>=1e6)return'$'+(v/1e6).toFixed(1)+'M'; return'$'+v.toFixed(0); }
  function Pct(v) { return v!=null?(v>=0?'+':'')+v.toFixed(1)+'%':'—'; }

  var p    = price.current || 0;
  var chg  = price.change  || 0;
  var chgP = price.changePercent || 0;
  var cc   = chg >= 0 ? C.success : C.danger;
  var rev  = L(inc.revenue);
  var ni   = L(inc.netIncome);
  var eps  = L(inc.eps);
  var ocf  = L(cf.operatingCashFlow);
  var capex= L(cf.capitalExpenditures)||0;
  var fcf  = ocf!=null ? ocf-Math.abs(capex) : null;
  var eq   = L(bs.stockholdersEquity);
  var ta   = L(bs.totalAssets);
  var ltd  = L(bs.longTermDebt)||0;
  var cash = (L(bs.cash)||0)+(L(bs.shortTermInvestments)||0);
  var shares = L(bs.sharesOutstanding);
  var mktCap = profile.marketCap||(shares&&p?shares*p:null);
  var ev   = mktCap!=null?mktCap+ltd-cash:null;
  var prevRev = L2(inc.revenue);
  var revGrowth = (rev&&prevRev&&prevRev>0)?(rev-prevRev)/Math.abs(prevRev)*100:null;
  var prevNI = L2(inc.netIncome);
  var niGrowth = (ni&&prevNI&&prevNI>0)?(ni-prevNI)/Math.abs(prevNI)*100:null;
  var divPS = d.dividends&&d.dividends.length?d.dividends[d.dividends.length-1].value:(profile.lastDividend||null);
  var divYield = divPS&&p>0?divPS/p*100:null;
  var totalA = (ar.strongBuy||0)+(ar.buy||0)+(ar.hold||0)+(ar.sell||0)+(ar.strongSell||0);
  var upside = at.mean&&p>0?(at.mean-p)/p*100:null;
  var SECTOR_PE_MAP = {'Technology':28,'Healthcare':22,'Financials':14,'Consumer Discretionary':22,'Consumer Staples':20,'Energy':12,'Industrials':18,'Materials':16,'Real Estate':20,'Utilities':18,'Communication Services':20};
  var sectorPE = SECTOR_PE_MAP[profile.sector]||20;
  var pe = eps&&eps>0&&p?p/eps:null;
  var ps = rev&&mktCap?mktCap/rev:null;
  var pb = eq&&eq>0&&mktCap?mktCap/eq:null;
  var pfcf = fcf&&fcf>0&&mktCap?mktCap/fcf:null;
  var roe = ni&&eq&&eq>0?ni/eq*100:null;
  var npm = rev&&ni?ni/rev*100:null;
  var ca = L(bs.currentAssets); var clb = L(bs.currentLiabilities);
  var currentRatio = ca&&clb&&clb>0?ca/clb:null;
  var de = ltd&&eq&&eq>0?ltd/eq:null;
  var payoutRatio = eps&&eps>0&&divPS?divPS/eps*100:null;
  var h = '';

  // ── Description card ──
  h += '<div class="card" style="margin-bottom:14px;"><div class="card-title" style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;">';
  h += '<div style="display:flex;flex-direction:column;gap:6px;">';
  h += '<span style="font-size:15px;font-weight:800;color:var(--navy);">'+(profile.name||ticker)+' <span style="font-weight:500;color:var(--text-sec);">('+ticker+')</span></span>';
  if (profile.sector || profile.industry) {
    h += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
    if (profile.sector) h += '<span style="font-size:11px;font-weight:700;background:#003C71;color:#fff;padding:3px 10px;border-radius:12px;">'+profile.sector+'</span>';
    if (profile.industry) h += '<span style="font-size:11px;font-weight:600;background:rgba(0,60,113,0.1);color:var(--navy);padding:3px 10px;border-radius:12px;border:1px solid rgba(0,60,113,0.2);">'+profile.industry+'</span>';
    h += '</div>';
  }
  h += '</div>';
  h += '<span style="font-size:10px;background:var(--panel);border:1px solid var(--border);padding:2px 8px;border-radius:10px;color:var(--text-sec);white-space:nowrap;">'+(profile.type||'EQUITY')+'</span>';
  h += '</div><div class="card-body">';
  if (profile.description) {
    var desc=profile.description, shortD=desc.length>450?desc.substring(0,450)+'…':desc;
    h += '<div style="font-size:12px;color:var(--text-sec);line-height:1.65;margin-bottom:8px;">'+shortD+'</div>';
  }
  h += '<div style="font-size:11px;color:var(--text-sec);display:flex;flex-wrap:wrap;gap:10px;">';
  if (profile.website) h += '<span>🌐 <a href="'+profile.website+'" target="_blank" style="color:var(--navy);">'+profile.website.replace(/^https?:\/\//,'')+'</a></span>';
  if (profile.city)    h += '<span>📍 '+profile.city+(profile.state?', '+profile.state:'')+'</span>';
  if (profile.employees) h += '<span>👥 '+Number(profile.employees).toLocaleString()+' employees</span>';
  if (profile.ceo)     h += '<span>👤 CEO: '+profile.ceo+'</span>';
  h += '</div></div></div>';

  // ── 6 metric cards ──
  function mCard(label,val,sub,col,sub2) {
    return '<div style="background:var(--bg);border:1px solid var(--border);border-top:3px solid '+(col||C.navy)+';border-radius:4px;padding:12px 14px;flex:1;min-width:130px;">'
      +'<div style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-sec);margin-bottom:4px;">'+label+'</div>'
      +'<div style="font-size:20px;font-weight:800;color:'+(col||C.navy)+';">'+val+'</div>'
      +(sub?'<div style="font-size:11px;color:var(--text-sec);margin-top:2px;">'+sub+'</div>':'')
      +(sub2?'<div style="font-size:10px;color:var(--text-sec);">'+sub2+'</div>':'')
      +'</div>';
  }
  h += '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px;">';
  h += mCard('Price / 1D',  '$'+p.toFixed(2), (chg>=0?'+':'')+chg.toFixed(2)+' ('+Pct(chgP)+')', cc, 'Vol: '+(price.volume?Number(price.volume).toLocaleString():'—'));
  h += mCard('Market Cap',  mktCap?Nm(mktCap):'—', ev?'EV: '+Nm(ev):'', C.navy);
  h += mCard('52-Week',     (tech.fiftyTwoWeekLow?'$'+tech.fiftyTwoWeekLow:'—')+' – '+(tech.fiftyTwoWeekHigh?'$'+tech.fiftyTwoWeekHigh:'—'), '50D MA: '+(tech.fiftyDayAverage?'$'+tech.fiftyDayAverage:'—'), C.textSec, '200D MA: '+(tech.twoHundredDayAverage?'$'+tech.twoHundredDayAverage:'—'));
  h += mCard('Prev Close',  '$'+(price.previousClose||0).toFixed(2), 'Day H: $'+(price.dayHigh||p).toFixed(2)+' / L: $'+(price.dayLow||p).toFixed(2), C.textSec);
  h += mCard('Analyst Target', at.mean?'$'+at.mean.toFixed(2):'No Coverage', upside!=null?Pct(upside)+' upside':'', upside!=null&&upside>0?C.success:C.danger, totalA?totalA+' analysts':'');
  h += mCard('EPS / P/E',   eps?'$'+eps.toFixed(2):'—', pe?'P/E: '+pe.toFixed(1)+'x':'', C.navy, 'Sector P/E: '+sectorPE+'x');
  h += '</div>';

  // ── Ratios vs. Sector Benchmarks ──
  var ratioSecs = [
    { name:'Valuation', rows:[
      {label:'P/E',        val:pe,        bench:sectorPE, fmt:function(v){return v!=null?v.toFixed(1)+'x':'—';}, lower:true},
      {label:'P/Sales',    val:ps,        bench:3.0,      fmt:function(v){return v!=null?v.toFixed(1)+'x':'—';}, lower:true},
      {label:'P/Book',     val:pb,        bench:3.5,      fmt:function(v){return v!=null?v.toFixed(1)+'x':'—';}, lower:true},
      {label:'P/FCF',      val:pfcf,      bench:20,       fmt:function(v){return v!=null?v.toFixed(1)+'x':'—';}, lower:true},
      {label:'EV/Rev',     val:ev&&rev?ev/rev:null, bench:4, fmt:function(v){return v!=null?v.toFixed(1)+'x':'—';}, lower:true},
    ]},
    { name:'Profitability', rows:[
      {label:'Gross Margin',  val:rev&&L(inc.grossProfit)?L(inc.grossProfit)/rev*100:null, bench:40, fmt:function(v){return v!=null?v.toFixed(1)+'%':'—';}, lower:false},
      {label:'Op Margin',     val:rev&&L(inc.operatingIncome)?L(inc.operatingIncome)/rev*100:null, bench:15, fmt:function(v){return v!=null?v.toFixed(1)+'%':'—';}, lower:false},
      {label:'Net Margin',    val:npm,    bench:12, fmt:function(v){return v!=null?v.toFixed(1)+'%':'—';}, lower:false},
      {label:'ROE',           val:roe,    bench:15, fmt:function(v){return v!=null?v.toFixed(1)+'%':'—';}, lower:false},
      {label:'FCF Yield',     val:fcf&&mktCap&&mktCap>0?fcf/mktCap*100:null, bench:4, fmt:function(v){return v!=null?v.toFixed(1)+'%':'—';}, lower:false},
    ]},
    { name:'Financial Health', rows:[
      {label:'Current Ratio', val:currentRatio, bench:1.5, fmt:function(v){return v!=null?v.toFixed(2)+'x':'—';}, lower:false},
      {label:'Debt/Equity',   val:de,    bench:1.5, fmt:function(v){return v!=null?v.toFixed(2)+'x':'—';}, lower:true},
      {label:'Net Cash',      val:cash-ltd, bench:null, fmt:Nm, lower:null},
    ]},
    { name:'Growth', rows:[
      {label:'Revenue YoY',   val:revGrowth, bench:8,  fmt:function(v){return v!=null?Pct(v):'—';}, lower:false},
      {label:'NI YoY',        val:niGrowth,  bench:10, fmt:function(v){return v!=null?Pct(v):'—';}, lower:false},
      {label:'Beta',          val:profile.beta||null, bench:1.0, fmt:function(v){return v!=null?v.toFixed(2):'—';}, lower:null},
    ]},
    { name:'Dividends', rows:[
      {label:'Div Yield',     val:divYield,  bench:2.0, fmt:function(v){return v!=null?v.toFixed(2)+'%':'None';}, lower:false},
      {label:'Payout Ratio',  val:payoutRatio, bench:60, fmt:function(v){return v!=null?v.toFixed(1)+'%':'—';}, lower:true},
    ]},
    { name:'Analyst', rows:[
      {label:'Target Mean',   val:at.mean, bench:null, fmt:function(v){return v!=null?'$'+v.toFixed(2):'—';}, lower:null},
      {label:'Target High',   val:at.high, bench:null, fmt:function(v){return v!=null?'$'+v.toFixed(2):'—';}, lower:null},
      {label:'Upside',        val:upside,  bench:0,    fmt:function(v){return v!=null?Pct(v):'—';}, lower:false},
      {label:'Buy %',         val:totalA?((ar.strongBuy||0)+(ar.buy||0))/totalA*100:null, bench:60, fmt:function(v){return v!=null?v.toFixed(0)+'%':'—';}, lower:false},
    ]},
  ];
  h += '<div class="card" style="margin-bottom:14px;">';
  h += '<div class="card-title">Key Ratios vs. Sector &nbsp;<span style="font-size:10px;font-weight:400;opacity:.7;">Green = favorable · Red = unfavorable vs. benchmark</span></div>';
  h += '<div class="card-body" style="padding:10px 14px;">';
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:14px;">';
  ratioSecs.forEach(function(sec) {
    h += '<div><div style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;font-weight:700;color:var(--navy);border-bottom:2px solid var(--navy);padding-bottom:3px;margin-bottom:8px;">'+sec.name+'</div>';
    sec.rows.forEach(function(row) {
      var v=row.val; var fmtd=row.fmt(v); var col=C.text;
      if(v!=null&&row.bench!=null&&row.lower!==null) col=row.lower?(v<=row.bench?C.success:C.danger):(v>=row.bench?C.success:C.danger);
      h += '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border);">';
      h += '<span style="font-size:11px;color:var(--text-sec);">'+row.label+'</span>';
      h += '<span style="font-size:12px;font-weight:700;color:'+col+';font-family:monospace;">'+fmtd+'</span>';
      h += '</div>';
    });
    h += '</div>';
  });
  h += '</div></div>';
  h += '<div class="card-sources"><strong>Sources:</strong> SEC EDGAR XBRL, FMP analyst targets, Yahoo Finance. Sector benchmarks: GICS S&P 500 historical medians.</div>';
  h += '</div>';
  return h;
}

function renderETFHeader(ticker, d) {
  var profile = d.profile || {};
  var price = d.price || {};
  var tech = d.technicals || {};
  var p = price.current || 0;
  var chg = price.change || 0;
  var chgPct = price.changePercent || 0;
  var cc = chg >= 0 ? C.success : C.danger;

  var h = '';
  h += '<div class="card"><div class="card-title">' + (profile.name || ticker) + ' (' + ticker + ') — ETF / Fund</div><div class="card-body">';
  if (profile.description) h += '<p style="font-size:12px;color:'+C.textSec+';line-height:1.6;margin-bottom:10px;">' + profile.description.substring(0, 500) + '</p>';
  h += '<div style="font-size:11px;color:'+C.textSec+';">';
  if (profile.website) h += '<strong>Website:</strong> ' + profile.website + ' &nbsp;|&nbsp; ';
  if (profile.sector) h += '<strong>Category:</strong> ' + profile.sector + ' &nbsp;|&nbsp; ';
  if (profile.industry) h += profile.industry;
  h += '</div></div></div>';

  h += '<div class="metrics-row">';
  h += mcBig(ticker, '$' + p.toFixed(2), fmtR(chgPct) + ' ($' + chg.toFixed(2) + ')', cc);
  h += mcBig('AUM / Mkt Cap', profile.marketCap ? fmtB(profile.marketCap) : '—', 'ETF', C.textSec);
  h += mcBig('52-Week', (tech.fiftyTwoWeekLow ? '$'+tech.fiftyTwoWeekLow : '—') + ' — ' + (tech.fiftyTwoWeekHigh ? '$'+tech.fiftyTwoWeekHigh : '—'), '', C.textSec);
  h += mcBig('Volume', price.volume ? Number(price.volume).toLocaleString() : '—', 'Prev: $' + (price.previousClose || 0).toFixed(2), C.textSec);
  h += '</div>';
  return h;
}

function renderCryptoHeader(ticker, quote, techData) {
  var p = quote.price || quote.current || 0;
  var chg = quote.change || 0;
  var chgPct = quote.changePercent || 0;
  var cc = chg >= 0 ? C.success : C.danger;
  var baseTicker = ticker.replace(/-.*/, '');

  var h = '';
  h += '<div class="card"><div class="card-title">' + baseTicker + ' — Cryptocurrency</div><div class="card-body">';
  h += '<p style="font-size:12px;color:'+C.textSec+';line-height:1.6;">Cryptocurrency pricing data sourced from Yahoo Finance. Cryptocurrencies do not file SEC reports, so financial statement analysis is not available.</p>';
  h += '</div></div>';

  h += '<div class="metrics-row">';
  h += mcBig(baseTicker, '$' + (p >= 1 ? p.toFixed(2) : p.toFixed(6)), fmtR(chgPct) + ' ($' + chg.toFixed(2) + ')', cc);
  h += mcBig('24H Volume', quote.volume ? Number(quote.volume).toLocaleString() : '—', '', C.textSec);
  h += mcBig('24H Range', (quote.dayLow ? '$' + quote.dayLow.toFixed(2) : '—') + ' — ' + (quote.dayHigh ? '$' + quote.dayHigh.toFixed(2) : '—'), '', C.textSec);
  h += mcBig('Prev Close', '$' + (quote.previousClose || 0).toFixed(2), quote.exchange || '', C.textSec);
  h += '</div>';
  return h;
}

// ═══ DIVIDEND DATA EXTRACTION ═══
function extractDividendData(secData) {
  if (!secData) return null;
  var profile = secData.profile || {};
  var divArr = secData.dividends || [];
  var annualDiv = null;
  var frequency = 4; // default quarterly

  // Try to get annual dividend from dividends array
  if (divArr.length) {
    annualDiv = divArr[divArr.length - 1].value;
  } else if (profile.lastDividend) {
    annualDiv = profile.lastDividend;
  }

  if (!annualDiv || annualDiv <= 0) return null;

  // Try to detect frequency from cash flow dividends paid or from profile
  // Most US stocks are quarterly (4), REITs monthly (12), some semi-annual (2)
  var name = (profile.name || '').toLowerCase();
  var sector = (profile.sector || '').toLowerCase();
  if (sector.includes('real estate') || name.includes('reit') || name.includes('realty')) {
    frequency = 12; // monthly for REITs
  }
  // ETFs with monthly distributions
  var etfMonthly = ['JEPI','JEPQ','DIVO','NUSI','QYLD','RYLD','XYLD','SCHD'];
  if (etfMonthly.indexOf(secData.ticker || '') >= 0) frequency = 12;

  return {
    annualDividend: annualDiv,
    frequency: frequency,
    payoutMonths: null, // will use defaults based on frequency
    lastDividend: profile.lastDividend || annualDiv
  };
}

window.runResearch = async function() {
  var ticker = document.getElementById('researchTicker').value.trim().toUpperCase();
  if (!ticker) { alert('Enter a ticker.'); return; }
  researchTicker = ticker;
  _researchDividendData = null; // reset dividend data
  researchShowDividends = false;
  document.getElementById('btnResearchDividends').classList.remove('active');

  // Raw SEC card is hidden by design now; keep it hidden but update output for data caching
  document.getElementById('researchOutput').innerHTML = '';
  document.getElementById('researchChartCard').style.display = 'none';
  document.getElementById('researchHeaderResults').innerHTML = '<div style="padding:20px;text-align:center;"><span class="spinner"></span> Loading data for ' + ticker + '...</div>';
  document.getElementById('researchResults').innerHTML = '';
  // Hide IV + RCR cards until new data loads
  var ivC = document.getElementById('ivCard'); if (ivC) ivC.style.display = 'none';
  var ivExp = document.getElementById('ivExpirySelect'); if (ivExp) ivExp.removeAttribute('data-ticker');
  var rcrC = document.getElementById('rcrCard'); if (rcrC) rcrC.style.display = 'none';
  var ivvC = document.getElementById('ivvCard'); if (ivvC) ivvC.style.display = 'none';
  // Reset new tabs to empty state
  var finContent = document.getElementById('resFinancialsContent');
  var finEmpty   = document.getElementById('resFinancialsEmpty');
  if (finContent) { finContent.style.display = 'none'; }
  if (finEmpty)   { finEmpty.style.display = 'block'; }
  var valContent = document.getElementById('resValuationContent');
  var valEmpty   = document.getElementById('resValuationEmpty');
  if (valContent) { valContent.style.display = 'none'; }
  if (valEmpty)   { valEmpty.style.display = 'block'; }
  var peersContent = document.getElementById('resPeersContent');
  var peersEmpty   = document.getElementById('resPeersEmpty');
  if (peersContent) { peersContent.style.display = 'none'; }
  if (peersEmpty)   { peersEmpty.style.display = 'block'; }
  // Reset moat and insider tabs
  var moatContent = document.getElementById('resMoatContent');
  var moatEmpty   = document.getElementById('resMoatEmpty');
  if (moatContent) { moatContent.style.display = 'none'; }
  if (moatEmpty)   { moatEmpty.style.display = 'block'; }
  var insiderContent = document.getElementById('resInsiderContent');
  var insiderEmpty   = document.getElementById('resInsiderEmpty');
  if (insiderContent) { insiderContent.style.display = 'none'; }
  if (insiderEmpty)   { insiderEmpty.style.display = 'block'; }

  try {
    if (isCrypto(ticker)) {
      // ═══ CRYPTO ═══
      // STEP 1: Fetch quote and show header + metrics first
      var quote = await fetchQuote(ticker);
      var techData = null;
      try {
        var y52 = await fetchChart(ticker, '1y', '1d');
        var closes = (y52.points || []).filter(function(p){return p.close!=null;}).map(function(p){return p.close;});
        if (closes.length) {
          techData = {
            fiftyTwoWeekHigh: +(Math.max.apply(null, closes).toFixed(2)),
            fiftyTwoWeekLow: +(Math.min.apply(null, closes).toFixed(2)),
            fiftyDayAverage: closes.length >= 50 ? +(closes.slice(-50).reduce(function(a,b){return a+b;},0) / 50).toFixed(2) : null,
            twoHundredDayAverage: closes.length >= 200 ? +(closes.slice(-200).reduce(function(a,b){return a+b;},0) / 200).toFixed(2) : null,
          };
        }
      } catch(e) {}

      // Show header above chart
      document.getElementById('researchHeaderResults').innerHTML = renderCryptoHeader(ticker, quote, techData);

      // STEP 2: Show chart
      document.getElementById('researchChartCard').style.display = '';
      document.getElementById('researchChartTitle').textContent = ticker.replace(/-.*/, '') + ' — Price Chart';
      await updateResearchChart();

      // STEP 3: Show remaining analysis below chart
      var html = renderCryptoAnalysis(ticker, quote, techData);
      document.getElementById('researchResults').innerHTML = html;
      document.getElementById('researchOutput').textContent = JSON.stringify(quote, null, 2);
      // Trigger regime-conditioned return distributions
      if (typeof rcrLoad === 'function') rcrLoad(ticker);
      // Crypto typically has no options; ivLoad will gracefully handle that
      if (typeof ivLoad === 'function') ivLoad(ticker);

    } else {
      // ═══ STOCK or ETF ═══
      // STEP 1: Fetch SEC data and show header + metrics first
      document.getElementById('researchHeaderResults').innerHTML =
        '<div style="padding:30px;text-align:center;"><span class="spinner"></span><br><br>' +
        '<strong>Fetching data for ' + ticker + '...</strong></div>';

      var secData = await fetchFundamentals(ticker);
      document.getElementById('researchOutput').textContent = JSON.stringify(secData, null, 2);

      // Cache secData for future features (industry comparison, forecasting)
      window._lastSecData = secData;
      window._lastSecTicker = ticker;

      // Detect if ETF/Fund — only trust profile.type, not absence of revenue data
      // Many stocks have SEC data gaps; don't treat missing revenue as ETF
      var isETF = (secData.profile && (secData.profile.type === 'ETF' || secData.profile.type === 'FUND'));

      // Extract and cache dividend data for chart toggle
      _researchDividendData = extractDividendData(secData);

      // Show header above chart
      if (isETF) {
        document.getElementById('researchHeaderResults').innerHTML = renderETFHeader(ticker, secData);
      } else {
        document.getElementById('researchHeaderResults').innerHTML = renderStockHeader(ticker, secData);
      }

      // STEP 2: Show chart
      document.getElementById('researchChartCard').style.display = '';
      document.getElementById('researchChartTitle').textContent = (secData.profile?.name || ticker) + ' (' + ticker + ') — Price Chart';
      await updateResearchChart();

      // STEP 3: Show remaining analysis below chart
      if (isETF) {
        var html = renderETFAnalysis(ticker, secData);
      } else {
        var html = renderSECAnalysis(ticker, secData);
      }
      document.getElementById('researchResults').innerHTML = html;
      // ── Populate new tabs ──────────────────────────────────────────
      // Financial Statements & Forecasts
      resRenderFinancials(ticker, secData);
      // Valuation tab header (IV + IVV loaded lazily on tab click)
      resRenderValuationHeader(ticker, secData);
      // Peer header (peers loaded lazily on tab click)
      var peersH = document.getElementById('resPeersHeader');
      if (peersH) {
        var prof = secData.profile || {};
        peersH.innerHTML = '<div style="background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:10px 16px;font-size:12px;margin-bottom:4px;">'
          + '<strong>' + (prof.name || ticker) + '</strong>'
          + (prof.sector ? ' &nbsp;·&nbsp; <span style="color:var(--text-sec);">' + prof.sector + ' / ' + (prof.industry||'') + '</span>' : '')
          + '</div>';
      }
      // ──────────────────────────────────────────────────────────────
      // Trigger regime-conditioned return distributions (non-blocking)
      if (typeof rcrLoad === 'function') rcrLoad(ticker);
      // Trigger options IV + IV percentile analysis (non-blocking)
      if (typeof ivLoad === 'function') ivLoad(ticker);
      // Trigger intrinsic value multi-method valuation (stock only; ETFs handled separately)
      if (!isETF && typeof ivvLoad === 'function') ivvLoad(ticker, secData);
    }

  } catch(e) {
    document.getElementById('researchOutput').textContent = 'Error: ' + e.message;
    document.getElementById('researchHeaderResults').innerHTML = '';
    document.getElementById('researchResults').innerHTML =
      '<div class="card"><div class="card-title" style="background:var(--danger);">Error</div><div class="card-body">' +
      '<p style="color:var(--danger);font-weight:600;">Failed to analyze ' + ticker + '</p>' +
      '<p style="font-size:12px;color:var(--text-sec);">Error: ' + e.message + '</p>' +
      '<p style="font-size:12px;color:var(--text-sec);margin-top:8px;">Test: <code>' + WORKER_URL + '/fundamentals?symbol=' + ticker + '</code></p>' +
      '</div></div>';
  }
};

// ════════════════════════════════════════════════════
// MACRO LIVE INDICATOR TABLE — lazy-load on first Macro visit
// ════════════════════════════════════════════════════
// ═══ MACRO PAGE TAB NAVIGATION ════════════════════════════════════
// Mirrors the Cross-Asset tab system but scoped to page-macro.
// Each tab auto-loads its content on first visit.
var _macroTabInit = {};

function macroShowTab(name) {
  _toggleTabs('#page-macro', 'data-macrotab', name, 'macrotab-');
  // Auto-load content on first visit
  if (!_macroTabInit[name]) {
    _macroTabInit[name] = true;
    if (name === 'dashboard') {
      loadMacroLiveTable();
    }
    if (name === 'biz') {
      // Business cycle guide and curve are populated by loadMacroLiveTable
      if (!window._lastMacroData) loadMacroLiveTable();
      // Ensure guide is shown in the biz tab (it renders into macroCycleGuide)
      var guide = document.getElementById('macroCycleGuide');
      if (guide) guide.style.display = 'block';
    }
    if (name === 'breakdown') {
      if (typeof regimeLoadBreakdown === 'function') regimeLoadBreakdown();
    }
    if (name === 'yieldcurve') {
      if (typeof ycLoad === 'function') ycLoad();
    }
    if (name === 'lic') {
      // LIC renders from macro data; ensure macro is loaded first
      if (!window._lastMacroData) {
        loadMacroLiveTable();
      } else if (typeof licRender === 'function') {
        licRender(window._lastMacroData);
      }
    }
    if (name === 'quadmap') {
      if (!window._lastMacroData) {
        loadMacroLiveTable(); // renderQuadMap() is called inside after data loads
      } else {
        renderQuadMap();
      }
    }
  }
}

var _macroLoaded = false;
var _macroLoadedAt = null;
function loadMacroLiveTable(force) {
  if (_macroLoaded && !force) return;
  _macroLoaded = true;
  fetch(WORKER_URL + "/fred").then(function(r) { return r.json(); }).then(function(d) {
    if (d.error) throw new Error(d.error);

    // ── MACRO PHASE BUFFER ──────────────────────────────────────────────
    // Economic cycle phases move on 3–12 month timescales. A single FRED
    // fetch that crosses a threshold should NOT immediately change the
    // displayed phase — that would make the analysis reactive to noisy
    // indicator revisions. We require the new phase to appear on 2
    // consecutive fetches before committing. This gives roughly 8–24h of
    // confirmation before the phase label changes. Additionally, we require
    // the score margin to be meaningful (≥2 points above/below boundaries).
    // Implementation: persist last-committed phase in sessionStorage.
    // ────────────────────────────────────────────────────────────────────
    var phaseKey = 'perry_macro_phase_committed';
    var phaseCountKey = 'perry_macro_phase_candidate';
    var committedPhase = null;
    var candidateData = null;
    try {
      committedPhase = sessionStorage.getItem(phaseKey);
      var candidateRaw = sessionStorage.getItem(phaseCountKey);
      if (candidateRaw) candidateData = JSON.parse(candidateRaw);
    } catch(e) {}

    if (!committedPhase) {
      // First load: commit immediately
      committedPhase = d.phase;
      try { sessionStorage.setItem(phaseKey, committedPhase); } catch(e) {}
    } else if (d.phase !== committedPhase) {
      // New phase detected — check if it was also the candidate last time
      if (candidateData && candidateData.phase === d.phase && candidateData.score === Math.round(d.totalScore / d.maxScore * 100)) {
        // Second consecutive fetch with same new phase + same score bucket → commit
        committedPhase = d.phase;
        try { sessionStorage.setItem(phaseKey, committedPhase); sessionStorage.removeItem(phaseCountKey); } catch(e) {}
      } else {
        // First time seeing this phase — record as candidate but don't commit yet
        try { sessionStorage.setItem(phaseCountKey, JSON.stringify({ phase: d.phase, score: Math.round(d.totalScore / d.maxScore * 100) })); } catch(e) {}
        // Display the committed phase with a "Watching" indicator
        d._phasePending = d.phase;
        d.phase = committedPhase;
      }
    } else {
      // Phase confirmed same — clear any pending candidate
      try { sessionStorage.removeItem(phaseCountKey); } catch(e) {}
    }

    var phaseColors = { "Confirmed Expansion": C.success, "Mid-Cycle": C.navy, "Late Cycle / Transition": '#8B6914', "Confirmed Contraction": C.danger };
    var pc = phaseColors[d.phase] || C.navy;

    // ── Regime Verdict Banner ──
    var verdictEl = document.getElementById('macroRegimeVerdict');
    if (verdictEl) {
      var vh = '<div class="card"><div class="card-title" style="background:'+pc+';">Macro Regime Verdict — ' + new Date().toLocaleDateString() + '</div><div class="card-body">';
      vh += '<div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap;">';
      vh += '<div style="text-align:center;min-width:120px;"><div style="font-size:42px;font-weight:800;color:'+pc+';">' + d.totalScore + '</div><div style="font-size:12px;color:'+C.textSec+';">out of ' + d.maxScore + '</div></div>';
      vh += '<div><div style="font-size:18px;font-weight:700;color:'+pc+';">' + d.phase + (d._phasePending ? ' <span style="font-size:11px;font-weight:600;background:#8B6914;color:#fff;padding:2px 7px;border-radius:10px;margin-left:6px;">WATCHING → '+d._phasePending+'</span>' : '') + '</div>';
      vh += '<div style="font-size:13px;color:'+C.textSec+';margin-top:4px;">' + (d.phaseDescription || '') + '</div></div>';
      vh += '</div>';
      if (d.pillarScores) {
        vh += '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:16px;">';
        d.pillarScores.forEach(function(ps) {
          var psc = ps.score > 0 ? C.success : ps.score < 0 ? C.danger : C.textSec;
          vh += '<div style="background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:8px 14px;text-align:center;min-width:100px;">';
          vh += '<div style="font-size:11px;color:'+C.textSec+';font-weight:600;">' + ps.name + '</div>';
          vh += '<div style="font-size:18px;font-weight:800;color:'+psc+';">' + (ps.score >= 0 ? '+' : '') + ps.score + '</div>';
          vh += '<div style="font-size:10px;color:'+C.textSec+';">' + ps.count + ' indicators</div></div>';
        });
        vh += '</div>';
      }
      vh += '</div></div>';
      verdictEl.innerHTML = vh;
      verdictEl.style.display = 'block';
    }

    // ── Single Unified Indicator Table ──
    var el = document.getElementById('macroLiveTableBody');
    if (!el) return;
    var h = '<div style="overflow-x:auto;"><table style="font-size:12px;border-collapse:collapse;width:100%;">';
    h += '<thead><tr>';
    h += '<th style="padding:10px 14px;text-align:left;background:var(--navy);color:var(--text-on-dark);min-width:130px;border-right:2px solid rgba(255,255,255,0.15);">Indicator Category</th>';
    h += '<th style="padding:10px 14px;text-align:left;background:var(--navy);color:var(--text-on-dark);min-width:170px;">Indicator</th>';
    h += '<th style="padding:10px 14px;text-align:left;background:var(--navy);color:var(--text-on-dark);min-width:100px;">Value</th>';
    h += '<th style="padding:10px 14px;text-align:left;background:var(--navy);color:var(--text-on-dark);min-width:90px;">Date</th>';
    h += '<th style="padding:10px 14px;text-align:left;background:var(--navy);color:var(--text-on-dark);min-width:130px;">Threshold</th>';
    h += '<th style="padding:10px 14px;text-align:center;background:var(--navy);color:var(--text-on-dark);min-width:80px;">Signal</th>';
    h += '<th style="padding:10px 14px;text-align:center;background:var(--navy);color:var(--text-on-dark);min-width:60px;">Score</th>';
    h += '<th style="padding:10px 14px;text-align:left;background:var(--navy);color:var(--text-on-dark);min-width:140px;">Detail</th>';
    h += '</tr></thead><tbody>';
    if (d.pillars) {
      d.pillars.forEach(function(pillar, pIdx) {
        var pillarTotal = pillar.indicators.reduce(function(s, i) { return s + (i.score || 0); }, 0);
        var pillarColor = pillarTotal > 0 ? C.success : pillarTotal < 0 ? C.danger : C.navy;
        var stripe = pIdx % 2 === 0 ? 'rgba(46,125,82,0.04)' : '';
        pillar.indicators.forEach(function(ind, idx) {
          var sc = ind.score > 0 ? C.success : ind.score < 0 ? C.danger : C.textSec;
          var signal = ind.score > 0 ? 'Expansion' : ind.score < 0 ? 'Contraction' : 'Neutral';
          var scoreLabel = ind.score > 0 ? '+1' : ind.score < 0 ? '\u22121' : '0';
          var borderTop = idx === 0 ? 'border-top:2px solid var(--border);' : '';
          h += '<tr style="background:'+stripe+';'+borderTop+';border-bottom:1px solid var(--border);">';
          if (idx === 0) {
            h += '<td rowspan="'+pillar.indicators.length+'" style="padding:12px 14px;font-weight:700;color:'+pillarColor+';vertical-align:top;border-right:2px solid var(--border);line-height:1.5;">';
            h += pillar.name + '<br><span style="font-size:16px;font-weight:800;">' + (pillarTotal >= 0 ? '+' : '') + pillarTotal + '</span></td>';
          }
          var explAttr = ind.explain ? ind.explain.replace(/"/g, '&quot;') : '';
          h += '<td style="padding:8px 14px;font-weight:600;">' + ind.indicator + (explAttr ? ' <span class="help-icon" title="'+explAttr+'" data-heading="'+String(ind.indicator).replace(/"/g,'&quot;')+'" style="font-size:11px;">\u24d8</span>' : '') + '</td>';
          h += '<td style="padding:8px 14px;font-weight:700;color:'+sc+';">' + (ind.value || '\u2014') + '</td>';
          h += '<td style="padding:8px 14px;color:'+C.textSec+';font-size:11px;">' + (ind.date || '') + '</td>';
          h += '<td style="padding:8px 14px;font-size:11px;color:'+C.textSec+';">' + (ind.threshold || '') + '</td>';
          h += '<td style="padding:8px 14px;text-align:center;color:'+sc+';font-weight:700;">' + signal + '</td>';
          h += '<td style="padding:8px 14px;text-align:center;font-weight:800;font-size:14px;color:'+sc+';">' + scoreLabel + '</td>';
          h += '<td style="padding:8px 14px;font-size:11px;color:'+C.textSec+';">' + (ind.detail || '') + '</td>';
          h += '</tr>';
        });
      });
    }
    h += '</tbody></table></div>';
    h += '<div style="padding:16px 20px;border-top:2px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">';
    h += '<div style="font-size:13px;font-weight:700;color:'+pc+';">Regime Score: ' + d.totalScore + ' / ' + d.maxScore + '</div>';
    h += '<div style="font-size:13px;font-weight:700;color:'+pc+';">' + d.phase + '</div>';
    h += '<div style="font-size:11px;color:'+C.textSec+';">Updated: ' + new Date(d.timestamp).toLocaleString() + '</div>';
    h += '</div>';
    el.innerHTML = h;

    // ── CFA Business Cycle Guide ──
    var guideEl = document.getElementById('macroCycleGuide');
    if (guideEl) {
      var gh = '<div class="card"><div class="card-title">CFA Business Cycle Phase Guide <span class="help-icon" title="The 4 standard phases of the business cycle (per CFA L1 Economics) and what historically works in each: Early Expansion, Mid Expansion, Late Expansion / Peak, Contraction.">?</span></div><div class="card-body">';
      gh += '<div style="overflow-x:auto;"><table style="font-size:12px;"><thead><tr><th>Score</th><th>Phase</th><th>Positioning</th><th>Top Equities</th><th>Fixed Income</th><th>Commodities</th></tr></thead><tbody>';
      var phases = [
        { range: "\u2265 70%", phase: "Confirmed Expansion", pos: "OW risk assets, UW duration", eq: "Financials, Discretionary, Small Cap", fi: "Short duration; HY credit", cm: "Industrial metals, Energy", color: C.success },
        { range: "30\u201370%", phase: "Mid-Cycle", pos: "Neutral; lean growth", eq: "Technology, Industrials", fi: "Moderate duration; floaters", cm: "Energy, Agriculture", color: C.navy },
        { range: "\u221220\u201330%", phase: "Late Cycle / Transition", pos: "Reduce cyclicals, add defensives", eq: "Energy, Healthcare, Staples", fi: "TIPS; add duration", cm: "Energy peaks; gold rises", color: '#8B6914' },
        { range: "< \u221220%", phase: "Contraction", pos: "UW equities/credit, OW duration/gold", eq: "Staples, Healthcare, Utilities", fi: "Long duration; govt bonds", cm: "Gold; base metals weak", color: C.danger },
      ];
      phases.forEach(function(p) {
        var isActive = d.phase.includes(p.phase.split(" /")[0]);
        gh += '<tr style="' + (isActive ? 'background:rgba(91,155,213,0.12);font-weight:600;' : '') + '">';
        gh += '<td style="font-weight:700;color:'+p.color+';">' + p.range + '</td>';
        gh += '<td style="color:'+p.color+';font-weight:600;">' + p.phase + (isActive ? ' \u25C4' : '') + '</td>';
        gh += '<td>' + p.pos + '</td><td>' + p.eq + '</td><td>' + p.fi + '</td><td>' + p.cm + '</td></tr>';
      });
      gh += '</tbody></table></div></div></div>';
      guideEl.innerHTML = gh;
      guideEl.style.display = 'block';
    }

    // Render business cycle chart
    if (typeof renderBusinessCycleChart === 'function') renderBusinessCycleChart(d.phase, d.totalScore, d.maxScore);
    // Cache for briefing page and LIC
    window._lastMacroData = d;
    // Render Quad Map if quadmap tab is active (or was first-visited)
    var quadTab = document.getElementById('macrotab-quadmap');
    if (quadTab && quadTab.classList.contains('active')) {
      if (typeof renderQuadMap === 'function') renderQuadMap();
    }
    // Render Leading Indicator Composite only if LIC tab is currently active
    if (typeof licRender === 'function') {
      var licTab = document.getElementById('macrotab-lic');
      if (!licTab || licTab.classList.contains('active')) licRender(d);
    }
    // Show biz cycle guide if biz tab is active
    var bizTab = document.getElementById('macrotab-biz');
    if (bizTab && bizTab.classList.contains('active')) {
      var guide = document.getElementById('macroCycleGuide');
      if (guide) guide.style.display = 'block';
    }
    _macroLoadedAt = new Date();
    mktUpdateStatusBar();
    // Pre-load cycle breakdown in background (cached 12h — cheap after first load)
    if (typeof regimeLoadBreakdown === 'function') {
      setTimeout(function() { regimeLoadBreakdown(); }, 400);
    }

  }).catch(function(e) {
    var el = document.getElementById('macroLiveTableBody');
    if (el) el.innerHTML = '<div style="padding:24px;text-align:center;color:'+C.danger+';"><strong>Failed to load FRED data:</strong> ' + e.message + '. <button class="btn btn-sm" onclick="loadMacroLiveTable(true)">Retry</button></div>';
    _macroLoaded = false;
  });
}

// ════════════════════════════════════════════════════
// MACRO ANALYSIS (placeholder — will use /currentmacroanalysis skill)
// ════════════════════════════════════════════════════
window.runMacroAnalysis = function() {
  // Data is already loaded in the unified table — just scroll to it
  var card = document.getElementById('macroLiveTableCard');
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    card.style.boxShadow = '0 0 0 3px var(--blue)';
    setTimeout(function() { card.style.boxShadow = ''; }, 2000);
  }
};

var _businessCycleChartInstance = null;
window.renderBusinessCycleChart = function(currentPhase, totalScore, maxScore) {
  var ctx = document.getElementById('businessCycleChart');
  if (!ctx) return;
  if (_businessCycleChartInstance) { _businessCycleChartInstance.destroy(); _businessCycleChartInstance = null; }

  // Phase definitions with boundaries on the curve
  // The curve goes: Early Expansion (0-25%) -> Mid-Cycle/Peak (25-50%) -> Late Cycle (50-75%) -> Contraction/Trough (75-100%)
  var phaseConfig = [
    { name: 'Early Expansion', shortName: 'Expansion', xStart: 0, xEnd: 0.25, color: 'rgba(46,125,82,0.15)', borderColor: '#2E7D52',
      topPicks: ['XLF', 'XLY', 'IWM', 'XLI'], matchPhase: 'Confirmed Expansion' },
    { name: 'Mid-Cycle / Peak', shortName: 'Mid-Cycle', xStart: 0.25, xEnd: 0.50, color: 'rgba(0,60,113,0.12)', borderColor: '#003C71',
      topPicks: ['XLK', 'QQQ', 'XLI', 'XLE'], matchPhase: 'Mid-Cycle' },
    { name: 'Late Cycle', shortName: 'Late Cycle', xStart: 0.50, xEnd: 0.75, color: 'rgba(139,105,20,0.15)', borderColor: '#8B6914',
      topPicks: ['XLE', 'XLV', 'XLP', 'GLD'], matchPhase: 'Late Cycle' },
    { name: 'Contraction / Trough', shortName: 'Contraction', xStart: 0.75, xEnd: 1.0, color: 'rgba(139,42,42,0.12)', borderColor: '#8B2A2A',
      topPicks: ['XLP', 'XLU', 'TLT', 'GLD'], matchPhase: 'Contraction' }
  ];

  // Generate smooth sine-like business cycle curve points
  var nPts = 200;
  var labels = [];
  var curveData = [];
  for (var i = 0; i <= nPts; i++) {
    var t = i / nPts;
    labels.push(t);
    // Sine curve: starts at 0, peaks at 0.25 (mid-cycle peak), crosses 0 at 0.5, troughs at 0.75, returns to 0 at 1.0
    curveData.push(Math.sin(2 * Math.PI * (t - 0.0) * 1) * 1);
  }

  // Determine which phase is active
  var activeIdx = -1;
  phaseConfig.forEach(function(p, idx) {
    if (currentPhase && currentPhase.includes(p.matchPhase.split(" /")[0])) activeIdx = idx;
  });

  // Custom plugin to draw phase shading, labels, and top picks
  var businessCyclePlugin = {
    id: 'businessCycleShading',
    beforeDraw: function(chart) {
      var ctx2 = chart.ctx;
      var xAxis = chart.scales.x;
      var yAxis = chart.scales.y;
      var chartArea = chart.chartArea;

      phaseConfig.forEach(function(phase, idx) {
        var xLeft = xAxis.getPixelForValue(phase.xStart * nPts);
        var xRight = xAxis.getPixelForValue(phase.xEnd * nPts);
        var isActive = (idx === activeIdx);

        // Draw phase background
        ctx2.save();
        ctx2.fillStyle = isActive ? phase.color.replace(/[\d.]+\)$/, '0.25)') : phase.color;
        ctx2.fillRect(xLeft, chartArea.top, xRight - xLeft, chartArea.bottom - chartArea.top);

        // Draw active phase border
        if (isActive) {
          ctx2.strokeStyle = phase.borderColor;
          ctx2.lineWidth = 2.5;
          ctx2.setLineDash([6, 4]);
          ctx2.strokeRect(xLeft + 1, chartArea.top + 1, xRight - xLeft - 2, chartArea.bottom - chartArea.top - 2);
          ctx2.setLineDash([]);
        }

        // Draw phase separator lines
        if (idx > 0) {
          ctx2.strokeStyle = 'rgba(90,106,122,0.25)';
          ctx2.lineWidth = 1;
          ctx2.beginPath();
          ctx2.moveTo(xLeft, chartArea.top);
          ctx2.lineTo(xLeft, chartArea.bottom);
          ctx2.stroke();
        }
        ctx2.restore();
      });
    },
    afterDraw: function(chart) {
      var ctx2 = chart.ctx;
      var xAxis = chart.scales.x;
      var yAxis = chart.scales.y;
      var chartArea = chart.chartArea;

      phaseConfig.forEach(function(phase, idx) {
        var xLeft = xAxis.getPixelForValue(phase.xStart * nPts);
        var xRight = xAxis.getPixelForValue(phase.xEnd * nPts);
        var xCenter = (xLeft + xRight) / 2;
        var isActive = (idx === activeIdx);

        // Phase label at top
        ctx2.save();
        ctx2.textAlign = 'center';
        ctx2.textBaseline = 'top';
        ctx2.font = (isActive ? 'bold 13px' : '12px') + ' "Inter", system-ui, sans-serif';
        ctx2.fillStyle = isActive ? phase.borderColor : '#5A6A7A';
        ctx2.fillText(phase.name, xCenter, chartArea.top + 8);

        // "CURRENT" badge for active phase
        if (isActive) {
          ctx2.font = 'bold 10px "Inter", system-ui, sans-serif';
          ctx2.fillStyle = '#fff';
          var badgeW = 68, badgeH = 18;
          var badgeX = xCenter - badgeW / 2, badgeY = chartArea.top + 26;
          ctx2.fillStyle = phase.borderColor;
          ctx2.beginPath();
          ctx2.roundRect(badgeX, badgeY, badgeW, badgeH, 4);
          ctx2.fill();
          ctx2.fillStyle = '#fff';
          ctx2.textBaseline = 'middle';
          ctx2.fillText('CURRENT', xCenter, badgeY + badgeH / 2);
        }

        // Top Picks at bottom
        var yBottom = chartArea.bottom - 12;
        ctx2.font = 'bold 10px "Inter", system-ui, sans-serif';
        ctx2.fillStyle = isActive ? phase.borderColor : '#5A6A7A';
        ctx2.textBaseline = 'bottom';
        ctx2.fillText('Top Picks', xCenter, yBottom - 14);
        ctx2.font = (isActive ? '600 11px' : '11px') + ' "Inter", system-ui, sans-serif';
        ctx2.fillStyle = isActive ? phase.borderColor : '#8494A7';
        ctx2.fillText(phase.topPicks.join(', '), xCenter, yBottom);

        ctx2.restore();
      });
    }
  };

  _businessCycleChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        data: curveData,
        borderColor: '#003C71',
        borderWidth: 3,
        pointRadius: 0,
        tension: 0.4,
        fill: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
        zoom: { zoom: { wheel: { enabled: false } }, pan: { enabled: false } }
      },
      scales: {
        x: {
          display: false,
          min: 0,
          max: nPts
        },
        y: {
          display: false,
          min: -1.5,
          max: 1.5
        }
      },
      layout: {
        padding: { top: 50, bottom: 36 }
      }
    },
    plugins: [businessCyclePlugin]
  });
};

// Render default business cycle chart on page load (no active phase until analysis runs)
document.addEventListener('DOMContentLoaded', function() {
  setTimeout(function() { renderBusinessCycleChart(null, 0, 21); }, 500);
});

window.runQuantAnalysis = async function() {
  var ticker = document.getElementById('quantTicker').value.trim().toUpperCase();
  if (!ticker) { alert('Enter a ticker.'); return; }
  window._quantLastTicker = ticker;
  var lookback = document.getElementById('quantLookback').value;
  var horizon = parseInt(document.getElementById('quantHorizon').value, 10);
  var el = document.getElementById('quantResults');
  el.innerHTML = '<div class="card"><div class="card-body" style="padding:48px;text-align:center;"><span class="spinner"></span><br><br>'
    + '<strong>Running full quantitative analysis for '+ticker+'...</strong><br>'
    + '<span style="font-size:12px;color:var(--text-sec);">Fetching price history, benchmark, VIX, SEC fundamentals, macro regime score. This takes 10–20 seconds.</span></div></div>';
  try {
    var result = await quantFullAnalysis(ticker, lookback, horizon);
    el.innerHTML = quantRenderResults(ticker, horizon, result);
    // Post-render: bind charts
    setTimeout(function(){ quantBindCharts(ticker, result); }, 50);
  } catch(e) {
    console.error(e);
    el.innerHTML = '<div class="card"><div class="card-title" style="background:var(--danger);">Analysis Failed</div>'
      + '<div class="card-body"><p style="color:var(--danger);"><strong>'+e.message+'</strong></p>'
      + '<p style="font-size:12px;color:var(--text-sec);margin-top:8px;">Common causes: ticker not found in Yahoo Finance, insufficient price history, Worker rate limit. Try a different ticker or wait 30 seconds.</p></div></div>';
  }
};

function quantInit() { /* no-op placeholder for navigateTo lazy hook */ }

// ═══════════════════════════════════════════════════════
// ═══════════════ QUANT ENGINE ══════════════════════════
// ═══════════════════════════════════════════════════════

async function quantFullAnalysis(ticker, lookback, horizon) {
  // Parallel fetch: main, SPY, VIX
  var results = await Promise.all([
    fetchChart(ticker, lookback, '1d'),
    fetchChart('SPY', lookback, '1d'),
    fetchChart('^VIX', lookback, '1d').catch(function(){ return { points: [] }; })
  ]);
  var mainRaw = (results[0].points || []).filter(function(p){ return p.close != null; });
  var spyRaw = (results[1].points || []).filter(function(p){ return p.close != null; });
  var vixRaw = (results[2].points || []).filter(function(p){ return p.close != null; });
  if (mainRaw.length < 300) throw new Error('Insufficient price history (need 300+ daily points; got '+mainRaw.length+').');
  // Align by date
  var spyMap = {}; spyRaw.forEach(function(p){ spyMap[p.date.slice(0,10)] = p.close; });
  var vixMap = {}; vixRaw.forEach(function(p){ vixMap[p.date.slice(0,10)] = p.close; });
  var rows = [];
  for (var i=0;i<mainRaw.length;i++) {
    var d = mainRaw[i].date.slice(0,10);
    if (spyMap[d] == null) continue;
    rows.push({ date: d, px: mainRaw[i].close, spy: spyMap[d], vix: vixMap[d] || null });
  }
  if (rows.length < 300) throw new Error('After alignment, only '+rows.length+' common days. Need 300+.');

  // Compute features per observation (daily)
  // log returns
  var lr = []; for (var j=1;j<rows.length;j++) lr.push(Math.log(rows[j].px / rows[j-1].px));
  var lrSpy = []; for (var j2=1;j2<rows.length;j2++) lrSpy.push(Math.log(rows[j2].spy / rows[j2-1].spy));

  // Build feature matrix starting at index 252 (need 1-year trailing window for every feature)
  // Target: forward return over `horizon` trading days
  var N = rows.length;
  var obs = []; // each row: { features: [...], fwdRet, date, px }
  var featureNames = [
    'Trailing 252D Vol',
    'Trailing 63D Beta vs SPY',
    'Trailing 63D Return',
    'Trailing 252D Sharpe',
    'VIX Level',
    'VIX vs 252D Avg',
    'Drawdown from 252D High',
    'Momentum (Last 21D ret)',
    'Mean Reversion (Last 5D ret)',
    'SPY Trailing 21D Return'
  ];
  for (var k=252; k<N-horizon; k++) {
    // window of log returns ending at k-1 (inclusive)
    var win252 = lr.slice(k-252, k);
    var win63 = lr.slice(k-63, k);
    var winSpy63 = lrSpy.slice(k-63, k);
    var win21 = lr.slice(k-21, k);
    var win5 = lr.slice(k-5, k);
    var winSpy21 = lrSpy.slice(k-21, k);
    var sd252 = quantStd(win252);
    var vol = sd252 * Math.sqrt(252);
    // Beta via cov/var over last 63
    var cov = 0, vSpy = 0, m1 = quantMean(win63), mS = quantMean(winSpy63);
    for (var b=0;b<63;b++) { cov += (win63[b]-m1)*(winSpy63[b]-mS); vSpy += (winSpy63[b]-mS)*(winSpy63[b]-mS); }
    var beta = vSpy > 0 ? cov/vSpy : 1;
    var ret63 = Math.exp(quantSum(win63)) - 1;
    var sharpe = sd252 > 0 ? (quantMean(win252)*252 - 0.04) / vol : 0;
    var vixNow = rows[k].vix;
    var vixAvg = null;
    if (vixNow != null) {
      var vixWin = []; for (var v=k-252;v<k;v++) if (rows[v].vix != null) vixWin.push(rows[v].vix);
      vixAvg = vixWin.length ? quantMean(vixWin) : null;
    }
    var vixLevel = vixNow != null ? vixNow : 18;
    var vixVsAvg = (vixNow != null && vixAvg) ? vixNow/vixAvg - 1 : 0;
    // Drawdown from 252D high
    var hi = rows[k-1].px;
    for (var h=k-252;h<k;h++) if (rows[h].px > hi) hi = rows[h].px;
    var dd = (rows[k-1].px - hi) / hi;
    var mom21 = Math.exp(quantSum(win21)) - 1;
    var mr5 = Math.exp(quantSum(win5)) - 1;
    var spyMom = Math.exp(quantSum(winSpy21)) - 1;

    // Forward return
    var fwd = rows[k+horizon].px / rows[k].px - 1;
    obs.push({
      features: [vol, beta, ret63, sharpe, vixLevel, vixVsAvg, dd, mom21, mr5, spyMom],
      fwdRet: fwd,
      date: rows[k].date,
      px: rows[k].px
    });
  }
  if (obs.length < 100) throw new Error('Insufficient observations ('+obs.length+') for regression.');

  // Build X matrix with intercept, y vector
  var nF = featureNames.length;
  // Standardize features for comparability
  var means = new Array(nF).fill(0);
  var stds = new Array(nF).fill(0);
  for (var fi=0; fi<nF; fi++) {
    var col = obs.map(function(o){ return o.features[fi]; });
    means[fi] = quantMean(col);
    stds[fi] = quantStd(col);
    if (stds[fi] === 0) stds[fi] = 1;
  }
  var X = obs.map(function(o){
    var row = [1]; // intercept
    for (var fi2=0; fi2<nF; fi2++) row.push((o.features[fi2] - means[fi2]) / stds[fi2]);
    return row;
  });
  var y = obs.map(function(o){ return o.fwdRet; });

  // OLS via normal equations: beta = (X'X)^-1 X'y
  var beta = quantOLS(X, y);
  var yhat = X.map(function(r){ return quantDot(r, beta); });
  var residuals = y.map(function(yi, idx){ return yi - yhat[idx]; });
  var sse = residuals.reduce(function(a,b){ return a + b*b; }, 0);
  var myBar = quantMean(y);
  var sst = y.reduce(function(a,b){ return a + (b-myBar)*(b-myBar); }, 0);
  var r2 = sst > 0 ? 1 - sse/sst : 0;
  // Adjusted R²
  var nObs = y.length, nParam = beta.length;
  var adjR2 = 1 - (1 - r2) * (nObs - 1) / (nObs - nParam);

  // Bootstrap coefficients — 500 resamples
  var B = 500;
  var bootBetas = [];
  for (var bi=0; bi<B; bi++) {
    var xb = []; var yb = [];
    for (var ii=0; ii<nObs; ii++) {
      var idx = Math.floor(Math.random() * nObs);
      xb.push(X[idx]); yb.push(y[idx]);
    }
    try { bootBetas.push(quantOLS(xb, yb)); } catch(e) { /* singular — skip */ }
  }
  // Confidence intervals (2.5%, 97.5%) and sign-consistency
  var ciLow = [], ciHigh = [], signStable = [];
  for (var p=0; p<nParam; p++) {
    var samp = bootBetas.map(function(bb){ return bb[p]; }).sort(function(a,b){return a-b;});
    ciLow.push(samp[Math.floor(samp.length*0.025)]);
    ciHigh.push(samp[Math.floor(samp.length*0.975)]);
    var same = samp.filter(function(v){ return Math.sign(v) === Math.sign(beta[p]) && v !== 0; }).length / samp.length;
    signStable.push(same);
  }

  // Variable importance by standardized coefficient magnitude
  var importance = [];
  for (var vi=1; vi<nParam; vi++) importance.push({ name: featureNames[vi-1], coef: beta[vi], ci: [ciLow[vi], ciHigh[vi]], stable: signStable[vi], absCoef: Math.abs(beta[vi]) });
  var totalAbs = importance.reduce(function(a,b){ return a + b.absCoef; }, 0) || 1;
  importance.forEach(function(item){ item.pct = item.absCoef / totalAbs * 100; });
  importance.sort(function(a,b){ return b.absCoef - a.absCoef; });

  // VIX regime backtest: bucket obs by VIX level at entry, compute mean fwd return
  var vixBuckets = [
    { label: 'Low VIX (<15)', test: function(v){ return v < 15; }, obs: [] },
    { label: 'Normal (15–20)', test: function(v){ return v >= 15 && v < 20; }, obs: [] },
    { label: 'Elevated (20–30)', test: function(v){ return v >= 20 && v < 30; }, obs: [] },
    { label: 'High (30+)', test: function(v){ return v >= 30; }, obs: [] }
  ];
  obs.forEach(function(o){
    var vix = o.features[4];
    vixBuckets.forEach(function(b){ if (b.test(vix)) b.obs.push(o.fwdRet); });
  });
  var regimeBacktest = vixBuckets.map(function(b){
    var arr = b.obs;
    return {
      label: b.label,
      count: arr.length,
      mean: arr.length ? quantMean(arr) : 0,
      median: arr.length ? quantPct(arr, 50) : 0,
      winRate: arr.length ? arr.filter(function(x){return x>0;}).length / arr.length : 0,
      p10: arr.length ? quantPct(arr, 10) : 0,
      p90: arr.length ? quantPct(arr, 90) : 0
    };
  });

  // Monte Carlo: GBM from current price, with drift calibrated to trailing mean
  var tailLR = lr.slice(-252);
  var mu = quantMean(tailLR);
  var sigma = quantStd(tailLR);
  var S0 = rows[rows.length-1].px;
  var nPaths = 1000;
  var mcTerm = [];
  var mcPathsSample = [];
  for (var pathI=0; pathI<nPaths; pathI++) {
    var S = S0;
    var path = [S];
    for (var tt=1;tt<=horizon;tt++) {
      var z = quantBM();
      S = S * Math.exp((mu - 0.5*sigma*sigma) + sigma*z);
      path.push(S);
    }
    mcTerm.push(S);
    if (pathI % 10 === 0 && mcPathsSample.length < 100) mcPathsSample.push(path);
  }

  // Prediction for current state using latest features
  var lastFeat = [1];
  for (var lf=0; lf<nF; lf++) lastFeat.push((obs[obs.length-1].features[lf] - means[lf]) / stds[lf]);
  var prediction = quantDot(lastFeat, beta);

  // Verdict
  var currentVix = rows[rows.length-1].vix || 18;
  var currentBucket = null;
  for (var vb=0; vb<vixBuckets.length; vb++) if (vixBuckets[vb].test(currentVix)) { currentBucket = vb; break; }
  var currentRegimeData = currentBucket != null ? regimeBacktest[currentBucket] : regimeBacktest[1];

  var verdict;
  if (prediction > 0.05 && currentRegimeData.winRate > 0.55) verdict = { call: 'BUY', color: C.success, rationale: 'MLR forecast positive and historical win rate in current regime favorable.' };
  else if (prediction < -0.05 || currentRegimeData.winRate < 0.35) verdict = { call: 'AVOID', color: C.danger, rationale: 'MLR forecast weak or regime historically unfavorable.' };
  else verdict = { call: 'HOLD', color: C.warning, rationale: 'MLR signal mixed; regime-adjusted expected return near zero.' };

  return {
    featureNames: featureNames,
    beta: beta,
    ciLow: ciLow, ciHigh: ciHigh, signStable: signStable,
    r2: r2, adjR2: adjR2,
    nObs: nObs,
    importance: importance,
    regimeBacktest: regimeBacktest,
    currentVix: currentVix, currentBucket: currentBucket,
    prediction: prediction,
    verdict: verdict,
    S0: S0, mu: mu, sigma: sigma,
    mcTerm: mcTerm, mcPathsSample: mcPathsSample,
    horizon: horizon,
    residuals: residuals,
    yhat: yhat, y: y,
    obsDates: obs.map(function(o){ return o.date; })
  };
}

// ═══ QUANT MATH HELPERS ═══
function quantMean(a){ var s=0; for (var i=0;i<a.length;i++) s+=a[i]; return a.length?s/a.length:0; }
function quantSum(a){ var s=0; for (var i=0;i<a.length;i++) s+=a[i]; return s; }
function quantStd(a){ var m=quantMean(a), s=0; for (var i=0;i<a.length;i++) s+=(a[i]-m)*(a[i]-m); return a.length>1?Math.sqrt(s/(a.length-1)):0; }
function quantDot(a,b){ var s=0; for (var i=0;i<a.length;i++) s+=a[i]*b[i]; return s; }
function quantPct(a,p){ var s=a.slice().sort(function(x,y){return x-y;}); var i=(p/100)*(s.length-1); var lo=Math.floor(i),hi=Math.ceil(i); if (lo===hi) return s[lo]; return s[lo]+(s[hi]-s[lo])*(i-lo); }
function quantBM(){ var u1=Math.random(),u2=Math.random(); while(u1===0) u1=Math.random(); return Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2); }

// OLS via Gauss-Jordan on normal equations: solve X'X * beta = X'y
function quantOLS(X, y) {
  var n = X.length, p = X[0].length;
  // X'X: p × p
  var xtx = []; for (var i=0;i<p;i++) { var row = new Array(p).fill(0); xtx.push(row); }
  for (var r=0;r<n;r++) for (var a=0;a<p;a++) for (var b=0;b<p;b++) xtx[a][b] += X[r][a]*X[r][b];
  // X'y: p × 1
  var xty = new Array(p).fill(0);
  for (var r2=0;r2<n;r2++) for (var a2=0;a2<p;a2++) xty[a2] += X[r2][a2]*y[r2];
  // Augmented matrix [xtx | xty]
  var aug = []; for (var i3=0;i3<p;i3++) aug.push(xtx[i3].concat([xty[i3]]));
  // Gauss-Jordan elimination
  for (var c=0;c<p;c++) {
    // Find pivot
    var pivot = c;
    for (var ri=c+1;ri<p;ri++) if (Math.abs(aug[ri][c]) > Math.abs(aug[pivot][c])) pivot = ri;
    if (Math.abs(aug[pivot][c]) < 1e-12) throw new Error('Matrix is singular in OLS');
    if (pivot !== c) { var tmp = aug[c]; aug[c] = aug[pivot]; aug[pivot] = tmp; }
    // Scale pivot row
    var pv = aug[c][c];
    for (var cc=c;cc<=p;cc++) aug[c][cc] /= pv;
    // Eliminate
    for (var r3=0;r3<p;r3++) {
      if (r3 === c) continue;
      var f = aug[r3][c];
      for (var cc2=c;cc2<=p;cc2++) aug[r3][cc2] -= f * aug[c][cc2];
    }
  }
  var result = []; for (var i4=0;i4<p;i4++) result.push(aug[i4][p]);
  return result;
}

// ═══ QUANT RENDER ═══
var QUANT_FEATURE_LABELS = {
  'Trailing 252D Vol':          'How Volatile This Stock Has Been (1 Year)',
  'Trailing 63D Beta vs SPY':   'How Much It Moves vs. the Market (3 Months)',
  'Trailing 63D Return':        'Recent 3-Month Price Trend',
  'Trailing 252D Sharpe':       'Risk-Adjusted Performance (1 Year)',
  'VIX Level':                  'Market Fear Index (VIX)',
  'VIX vs 252D Avg':            'Fear Level vs. Its Own 1-Year Average',
  'Drawdown from 252D High':    'How Far Below Its 52-Week High',
  'Momentum (Last 21D ret)':    'Short-Term Momentum (Last Month)',
  'Mean Reversion (Last 5D ret)': 'Mean Reversion Signal (Last Week)',
  'SPY Trailing 21D Return':    'Overall Market Trend (Last Month)'
};

function quantRenderResults(ticker, horizon, res) {
  var horizonLabel = horizon === 21 ? '1 Month' : horizon === 63 ? '3 Months' : horizon === 126 ? '6 Months' : '12 Months';
  var html = '';

  // ── Regime Compatibility Card ──
  if (res.currentBucket != null && res.regimeBacktest && res.regimeBacktest[res.currentBucket]) {
    var rb_curr = res.regimeBacktest[res.currentBucket];
    var regVerdict = rb_curr.winRate >= 0.65 ? { label: 'Favorable', color: 'var(--success)', emoji: '✅' }
      : rb_curr.winRate >= 0.45 ? { label: 'Neutral', color: 'var(--warning)', emoji: '⚠️' }
      : { label: 'Unfavorable', color: 'var(--danger)', emoji: '❌' };
    html += '<div class="card" style="border-left:4px solid '+regVerdict.color+';">';
    html += '<div class="card-title">'+regVerdict.emoji+' Regime Compatibility &mdash; Is Now a Good Time to Hold '+ticker+'?</div>';
    html += '<div class="card-body"><div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;">';
    html += '<div style="font-size:30px;font-weight:900;color:'+regVerdict.color+';">'+regVerdict.label+'</div>';
    html += '<div style="font-size:13px;line-height:1.7;color:var(--text-sec);flex:1;min-width:220px;">';
    html += 'The current market regime is <strong>'+rb_curr.label+'</strong> (VIX: <strong>'+res.currentVix.toFixed(1)+'</strong>). ';
    html += 'When VIX was in this range historically, <strong>'+ticker+'</strong> rose over the next '+horizonLabel.toLowerCase()+' in ';
    html += '<strong style="color:'+regVerdict.color+';">'+(rb_curr.winRate*100).toFixed(0)+'%</strong> of cases, ';
    html += 'with an average return of <strong style="color:'+(rb_curr.mean>=0?'var(--success)':'var(--danger)')+';">'+(rb_curr.mean>=0?'+':'')+(rb_curr.mean*100).toFixed(2)+'%</strong>.';
    html += '</div></div></div></div>';
  }

  // ── Verdict Banner ──
  html += '<div class="card">';
  html += '<div class="quant-verdict" style="background:'+res.verdict.color+';border-radius:6px;">';
  html += '<div style="font-size:13px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;opacity:0.85;">'+ticker+' '+horizonLabel+' Verdict</div>';
  html += '<div class="quant-verdict-call">'+res.verdict.call+'</div>';
  html += '<div class="quant-verdict-sub">MLR forecast: <strong>'+(res.prediction*100).toFixed(2)+'%</strong> &middot; Current regime: <strong>'+(res.currentBucket != null ? res.regimeBacktest[res.currentBucket].label : '-')+'</strong> &middot; Historical win rate: <strong>'+((res.currentBucket != null ? res.regimeBacktest[res.currentBucket].winRate : 0)*100).toFixed(0)+'%</strong></div>';
  html += '<div style="font-size:12px;margin-top:10px;opacity:0.85;max-width:720px;margin-left:auto;margin-right:auto;line-height:1.5;">'+res.verdict.rationale+'</div>';
  html += '</div></div>';

  // ── Model fit summary ──
  html += '<div class="card"><div class="card-title">Model Fit Summary — Multiple Linear Regression <span class="help-icon" title="A regression that predicts forward returns from multiple input features simultaneously. R&sup2; tells you what % of return variance the model explains. Adjusted R&sup2; penalizes adding features that don&rsquo;t actually help. Higher = better fit, but watch for overfitting (use the walk-forward backtest below to validate).">?</span></div>';
  html += '<div class="card-body"><div class="chart-stats">';
  html += '<div class="chart-stat-box"><div class="chart-stat-label">R&sup2;</div><div class="chart-stat-value">'+res.r2.toFixed(3)+'</div><div class="chart-stat-sub">Variance explained</div></div>';
  html += '<div class="chart-stat-box"><div class="chart-stat-label">Adj. R&sup2;</div><div class="chart-stat-value">'+res.adjR2.toFixed(3)+'</div><div class="chart-stat-sub">Degrees-of-freedom adj.</div></div>';
  html += '<div class="chart-stat-box"><div class="chart-stat-label">Observations</div><div class="chart-stat-value">'+res.nObs+'</div><div class="chart-stat-sub">Non-overlapping windows</div></div>';
  html += '<div class="chart-stat-box"><div class="chart-stat-label">Features</div><div class="chart-stat-value">'+res.featureNames.length+'</div><div class="chart-stat-sub">Input variables</div></div>';
  html += '<div class="chart-stat-box"><div class="chart-stat-label">Bootstrap Samples</div><div class="chart-stat-value">500</div><div class="chart-stat-sub">Resampling iterations</div></div>';
  html += '</div>';
  var r2Pct = (res.r2 * 100).toFixed(0);
  var r2Qual = res.r2 > 0.4 ? 'a <strong>relatively strong fit</strong> — most stock return models struggle to exceed 30-40%.'
    : res.r2 > 0.2 ? 'a <strong>moderate fit</strong> — the model captures some signal, but much of the return is driven by factors not in the model.'
    : 'a <strong>weak fit</strong> — the model has limited predictive power here. Treat the verdict with caution.';
  html += '<div style="background:rgba(0,60,113,0.05);border-left:3px solid var(--navy);padding:10px 14px;border-radius:0 6px 6px 0;margin-top:12px;font-size:13px;line-height:1.7;">';
  html += 'This model explained <strong>'+r2Pct+'%</strong> of <strong>'+ticker+'</strong>&rsquo;s '+horizonLabel.toLowerCase()+' price movements on the data it was trained on. That is '+r2Qual;
  html += '</div>';
  html += '<p style="font-size:12px;color:var(--text-sec);margin-top:12px;line-height:1.6;">MLR regresses <strong>'+horizonLabel.toLowerCase()+' forward returns</strong> on 10 standardized features derived from price history, volatility, trend, and macro (VIX). Coefficients are estimated via OLS; confidence intervals are computed by bootstrapping (500 resamples with replacement). Sign stability measures what fraction of bootstrap samples agree with the point estimate&apos;s sign &mdash; a proxy for coefficient robustness.</p>';
  html += '</div>';
  html += '<div class="card-sources"><strong>Sources:</strong> Efron, B. (1979) "Bootstrap Methods," <em>Annals of Statistics</em> &middot; Greene, W.H. (2018) <em>Econometric Analysis</em>, 8th ed. &middot; CFA Institute L2 Quantitative Methods.</div></div>';

  // ── Feature Importance ──
  html += '<div class="card"><div class="card-title">Feature Importance &amp; Coefficients <span class="help-icon" title="Ranks each input variable by how much it influences the model&rsquo;s prediction. Coefficient sign tells you direction (positive = feature increase predicts higher returns). Sign Stability shows how often that direction held across 500 bootstrap resamples — &gt; 90% means the relationship is robust, &lt; 75% means weak/unreliable.">?</span></div>';
  html += '<div class="card-body">';
  html += '<p style="font-size:12px;color:var(--text-sec);margin-bottom:12px;">Features ranked by absolute standardized coefficient. Positive coefficient (green) means higher feature &#8594; higher expected forward return. 95% CI shown from bootstrap. Sign stability &gt; 90% indicates a robust estimate.</p>';
  html += '<div class="table-wrap"><table><thead><tr>'
        + '<th>Rank</th><th>Feature</th><th style="text-align:right;">Coefficient</th>'
        + '<th style="text-align:center;">95% Bootstrap CI</th>'
        + '<th style="text-align:center;">Sign Stability</th>'
        + '<th style="text-align:right;">% of Total |&beta;|</th>'
        + '</tr></thead><tbody>';
  for (var ii=0; ii<res.importance.length; ii++) {
    var it = res.importance[ii];
    var coefColor = it.coef >= 0 ? 'var(--success)' : 'var(--danger)';
    var stableColor = it.stable > 0.9 ? 'var(--success)' : it.stable > 0.75 ? 'var(--warning)' : 'var(--danger)';
    var ciStrad = it.ci[0] < 0 && it.ci[1] > 0 ? ' &oslash;' : '';
    html += '<tr>';
    html += '<td style="font-weight:700;">'+(ii+1)+'</td>';
    var plainLabel = QUANT_FEATURE_LABELS[it.name] || it.name;
    html += '<td style="font-weight:600;">'+plainLabel+'<div style="font-size:10px;color:var(--text-sec);font-weight:400;">'+it.name+'</div></td>';
    html += '<td style="text-align:right;font-weight:700;color:'+coefColor+';">'+it.coef.toFixed(4)+'</td>';
    html += '<td style="text-align:center;font-size:11px;color:var(--text-sec);">['+it.ci[0].toFixed(4)+', '+it.ci[1].toFixed(4)+']'+ciStrad+'</td>';
    html += '<td style="text-align:center;font-weight:700;color:'+stableColor+';">'+(it.stable*100).toFixed(0)+'%</td>';
    html += '<td style="text-align:right;font-weight:600;">'+it.pct.toFixed(1)+'%</td>';
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  html += '<p style="font-size:11px;color:var(--text-sec);margin-top:10px;">&oslash; indicates the 95% CI straddles zero &mdash; the coefficient may not be statistically distinguishable from zero.</p>';
  html += '<div style="margin-top:16px;"><div style="background:var(--navy);color:var(--text-on-dark);padding:6px 12px;font-size:12px;font-weight:700;border-radius:4px 4px 0 0;">Visual Ranking</div>';
  html += '<div style="height:320px;border:1px solid var(--border);border-top:none;border-radius:0 0 4px 4px;padding:10px;"><canvas id="quantImportanceChart"></canvas></div></div>';
  html += '</div>';
  html += '<div class="card-sources"><strong>Sources:</strong> Efron &amp; Tibshirani (1993) <em>An Introduction to the Bootstrap</em> &middot; Hastie, Tibshirani &amp; Friedman (2009) <em>The Elements of Statistical Learning</em>, 2nd ed.</div></div>';

  // ── Regime Backtest ──
  html += '<div class="card"><div class="card-title">Macro Regime Backtest &mdash; '+horizonLabel+' Forward Returns by VIX Regime <span class="help-icon" title="Splits historical entries by the VIX level at the time of entry (Low, Moderate, Elevated, High) and shows what happened next. Use this to answer: &lsquo;If I bought this stock when VIX was 30+, did it tend to rally or fall?&rsquo;">?</span></div>';
  html += '<div class="card-body">';
  html += '<p style="font-size:12px;color:var(--text-sec);margin-bottom:12px;">Historical forward returns conditional on VIX level at entry. Each row is an independent regime with its own return distribution. Win rate = fraction of entries with positive forward return.</p>';
  html += '<div class="table-wrap"><table><thead><tr>'
        + '<th>VIX Regime</th>'
        + '<th style="text-align:right;">Entries</th>'
        + '<th style="text-align:right;">Mean Return</th>'
        + '<th style="text-align:right;">Median</th>'
        + '<th style="text-align:right;">Win Rate</th>'
        + '<th style="text-align:right;">10th pctl</th>'
        + '<th style="text-align:right;">90th pctl</th>'
        + '</tr></thead><tbody>';
  for (var ri=0; ri<res.regimeBacktest.length; ri++) {
    var rb = res.regimeBacktest[ri];
    var isCurrent = res.currentBucket === ri;
    var rowBg = isCurrent ? 'background:rgba(91,155,213,0.15);' : '';
    html += '<tr style="'+rowBg+'">';
    html += '<td style="font-weight:600;">'+rb.label+(isCurrent?' <span style="font-size:10px;background:var(--blue);color:white;padding:1px 6px;border-radius:3px;">CURRENT</span>':'')+'</td>';
    html += '<td style="text-align:right;">'+rb.count+'</td>';
    html += '<td style="text-align:right;font-weight:700;color:'+(rb.mean>=0?'var(--success)':'var(--danger)')+';">'+(rb.mean*100).toFixed(2)+'%</td>';
    html += '<td style="text-align:right;">'+(rb.median*100).toFixed(2)+'%</td>';
    html += '<td style="text-align:right;font-weight:600;">'+(rb.winRate*100).toFixed(0)+'%</td>';
    html += '<td style="text-align:right;color:var(--danger);">'+(rb.p10*100).toFixed(2)+'%</td>';
    html += '<td style="text-align:right;color:var(--success);">'+(rb.p90*100).toFixed(2)+'%</td>';
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  html += '<div style="margin-top:16px;"><div style="background:var(--navy);color:var(--text-on-dark);padding:6px 12px;font-size:12px;font-weight:700;border-radius:4px 4px 0 0;">Mean Forward Return by Regime</div>';
  html += '<div style="height:260px;border:1px solid var(--border);border-top:none;border-radius:0 0 4px 4px;padding:10px;"><canvas id="quantRegimeChart"></canvas></div></div>';
  html += '<p style="font-size:11px;color:var(--text-sec);margin-top:10px;">Current VIX: <strong>'+res.currentVix.toFixed(1)+'</strong>. Historical win rate in this regime drives the regime-adjusted verdict.</p>';
  html += '</div>';
  html += '<div class="card-sources"><strong>Sources:</strong> VIX index via CBOE/Yahoo Finance &middot; CFA Institute L3 Capital Market Expectations framework &middot; Whaley, R.E. (2009) "Understanding the VIX," <em>J. Portfolio Management</em>.</div></div>';

  // ── Monte Carlo ──
  var mcSorted = res.mcTerm.slice().sort(function(a,b){return a-b;});
  var mcMean = quantMean(res.mcTerm);
  var mcMed = mcSorted[Math.floor(mcSorted.length*0.5)];
  var mcP10 = mcSorted[Math.floor(mcSorted.length*0.10)];
  var mcP90 = mcSorted[Math.floor(mcSorted.length*0.90)];
  var mcPosFrac = res.mcTerm.filter(function(v){return v>res.S0;}).length / res.mcTerm.length;

  html += '<div class="card"><div class="card-title">Monte Carlo Simulation &mdash; '+horizonLabel+' Price Path (1,000 paths, GBM) <span class="help-icon" title="Generates 1,000 hypothetical price paths assuming the stock follows Geometric Brownian Motion (drift + random walk) calibrated to its actual historical volatility. The fan shows the range of plausible outcomes; the center line is the median.">?</span></div>';
  html += '<div class="card-body">';
  html += '<div class="chart-stats">';
  html += '<div class="chart-stat-box"><div class="chart-stat-label">Current</div><div class="chart-stat-value">$'+res.S0.toFixed(2)+'</div></div>';
  html += '<div class="chart-stat-box"><div class="chart-stat-label">Median '+horizonLabel+'</div><div class="chart-stat-value">$'+mcMed.toFixed(2)+'</div><div class="chart-stat-sub">'+((mcMed/res.S0-1)*100).toFixed(2)+'%</div></div>';
  html += '<div class="chart-stat-box"><div class="chart-stat-label">Expected</div><div class="chart-stat-value">$'+mcMean.toFixed(2)+'</div><div class="chart-stat-sub">'+((mcMean/res.S0-1)*100).toFixed(2)+'%</div></div>';
  html += '<div class="chart-stat-box"><div class="chart-stat-label">Low Estimate (worst 10%)</div><div class="chart-stat-value" style="color:var(--danger);">$'+mcP10.toFixed(2)+'</div><div class="chart-stat-sub">'+((mcP10/res.S0-1)*100).toFixed(2)+'%</div></div>';
  html += '<div class="chart-stat-box"><div class="chart-stat-label">High Estimate (best 10%)</div><div class="chart-stat-value" style="color:var(--success);">$'+mcP90.toFixed(2)+'</div><div class="chart-stat-sub">'+((mcP90/res.S0-1)*100).toFixed(2)+'%</div></div>';
  html += '<div class="chart-stat-box"><div class="chart-stat-label">P(positive)</div><div class="chart-stat-value">'+(mcPosFrac*100).toFixed(1)+'%</div><div class="chart-stat-sub">Prob. gain over '+horizonLabel.toLowerCase()+'</div></div>';
  html += '</div>';
  var mcMedChg = (mcMed/res.S0-1)*100;
  var mcP10Chg = (mcP10/res.S0-1)*100;
  var mcP90Chg = (mcP90/res.S0-1)*100;
  html += '<div style="background:rgba(0,60,113,0.05);border-left:3px solid var(--navy);padding:10px 14px;border-radius:0 6px 6px 0;margin-top:12px;font-size:13px;line-height:1.7;">';
  html += 'In the <strong>most likely scenario</strong>, <strong>'+ticker+'</strong> reaches <strong>$'+mcMed.toFixed(2)+'</strong> ('+(mcMedChg>=0?'+':'')+mcMedChg.toFixed(1)+'%) over the next '+horizonLabel.toLowerCase()+'. ';
  html += 'A <strong style="color:var(--danger);">bad scenario</strong> (worst 1-in-10) puts it at <strong>$'+mcP10.toFixed(2)+'</strong> ('+(mcP10Chg>=0?'+':'')+mcP10Chg.toFixed(1)+'%). ';
  html += 'A <strong style="color:var(--success);">good scenario</strong> (best 1-in-10) puts it at <strong>$'+mcP90.toFixed(2)+'</strong> ('+(mcP90Chg>=0?'+':'')+mcP90Chg.toFixed(1)+'%). ';
  html += 'There is a <strong>'+(mcPosFrac*100).toFixed(0)+'%</strong> probability it is higher than today.';
  html += '</div>';
  html += '<div class="grid-2" style="margin-top:16px;">';
  html += '<div><div style="background:var(--navy);color:var(--text-on-dark);padding:6px 12px;font-size:12px;font-weight:700;border-radius:4px 4px 0 0;">Sample Paths (100 of 1,000)</div>';
  html += '<div style="height:280px;border:1px solid var(--border);border-top:none;border-radius:0 0 4px 4px;padding:10px;"><canvas id="quantMcPathsChart"></canvas></div></div>';
  html += '<div><div style="background:var(--navy);color:var(--text-on-dark);padding:6px 12px;font-size:12px;font-weight:700;border-radius:4px 4px 0 0;">Terminal Price Distribution</div>';
  html += '<div style="height:280px;border:1px solid var(--border);border-top:none;border-radius:0 0 4px 4px;padding:10px;"><canvas id="quantMcHistChart"></canvas></div></div>';
  html += '</div>';
  html += '<p style="font-size:11px;color:var(--text-sec);margin-top:12px;">Calibration: &mu;<sub>daily</sub> = '+(res.mu*100).toFixed(3)+'% (ann. '+(res.mu*252*100).toFixed(1)+'%), &sigma;<sub>daily</sub> = '+(res.sigma*100).toFixed(3)+'% (ann. '+(res.sigma*Math.sqrt(252)*100).toFixed(1)+'%), from last 252 trading days. Paths follow dS/S = &mu;dt + &sigma;dW.</p>';
  html += '</div>';
  html += '<div class="card-sources"><strong>Sources:</strong> Hull, J.C. (2022) <em>Options, Futures &amp; Other Derivatives</em>, 10th ed., Ch. 15 &middot; Glasserman, P. (2004) <em>Monte Carlo Methods in Financial Engineering</em>.</div></div>';

  // ── Residual diagnostics ──
  html += '<div class="card"><div class="card-title">Residual Diagnostics <span class="help-icon" title="Residuals are the gap between the model&rsquo;s prediction and what actually happened. If they&rsquo;re scattered randomly around zero with no pattern, the model is well-specified. If they show a pattern (curve, fan-shape), the model is missing something — its predictions can&rsquo;t be trusted at face value.">?</span></div>';
  html += '<div class="card-body">';
  html += '<p style="font-size:12px;color:var(--text-sec);margin-bottom:12px;">Residuals = actual forward returns &minus; model predictions. Well-behaved residuals should be centered on zero, approximately normally distributed, and not show structure over time. Heavy structure indicates missing features or regime non-stationarity.</p>';
  html += '<div class="grid-2">';
  html += '<div><div style="background:var(--navy);color:var(--text-on-dark);padding:6px 12px;font-size:12px;font-weight:700;border-radius:4px 4px 0 0;">Predicted vs. Actual</div>';
  html += '<div style="height:260px;border:1px solid var(--border);border-top:none;border-radius:0 0 4px 4px;padding:10px;"><canvas id="quantResidScatter"></canvas></div></div>';
  html += '<div><div style="background:var(--navy);color:var(--text-on-dark);padding:6px 12px;font-size:12px;font-weight:700;border-radius:4px 4px 0 0;">Residual Distribution</div>';
  html += '<div style="height:260px;border:1px solid var(--border);border-top:none;border-radius:0 0 4px 4px;padding:10px;"><canvas id="quantResidHist"></canvas></div></div>';
  html += '</div>';
  html += '</div>';
  html += '<div class="card-sources"><strong>Sources:</strong> Greene, W.H. (2018) <em>Econometric Analysis</em> &middot; Fox, J. (2015) <em>Applied Regression Analysis and Generalized Linear Models</em>.</div></div>';

  return html;
}

// Bind charts after render
function quantBindCharts(ticker, res) {
  // Importance bar chart
  var impLabels = res.importance.map(function(i){ return QUANT_FEATURE_LABELS[i.name] || i.name; });
  var impData = res.importance.map(function(i){ return i.coef; });
  var impColors = res.importance.map(function(i){ return i.coef >= 0 ? C.success : C.danger; });
  new Chart(document.getElementById('quantImportanceChart').getContext('2d'), {
    type: 'bar',
    data: { labels: impLabels, datasets: [{ data: impData, backgroundColor: impColors, borderColor: C.navy, borderWidth: 1 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: Object.assign({}, chartTooltip, { callbacks: { label: function(ctx){ return 'β = '+ctx.parsed.x.toFixed(4); } } }) },
      scales: {
        x: { grid: chartGrid, ticks: chartTicks, title: { display: true, text: 'Standardized Coefficient', font: { size: 11 }, color: C.textSec } },
        y: { grid: { display: false }, ticks: Object.assign({}, chartTicks, { font: { size: 11 } }) }
      }
    }
  });
  // Regime bar chart
  var regLabels = res.regimeBacktest.map(function(r){ return r.label; });
  var regData = res.regimeBacktest.map(function(r){ return r.mean * 100; });
  var regColors = res.regimeBacktest.map(function(r,i){
    if (i === res.currentBucket) return C.navy;
    return r.mean >= 0 ? C.success : C.danger;
  });
  new Chart(document.getElementById('quantRegimeChart').getContext('2d'), {
    type: 'bar',
    data: { labels: regLabels, datasets: [{ data: regData, backgroundColor: regColors, borderColor: '#000', borderWidth: 1 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: Object.assign({}, chartTooltip, { callbacks: { label: function(ctx){ return 'Mean: '+ctx.parsed.y.toFixed(2)+'%'; } } }) },
      scales: {
        x: { grid: { display: false }, ticks: chartTicks },
        y: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { callback: function(v){ return v.toFixed(0)+'%'; } }), title: { display: true, text: 'Mean Forward Return', font: { size: 11 }, color: C.textSec } }
      }
    }
  });
  // MC paths
  var pathDatasets = res.mcPathsSample.map(function(path){
    return { data: path, borderColor: 'rgba(0,60,113,0.15)', borderWidth: 0.7, pointRadius: 0, fill: false };
  });
  // Add percentile bands
  var L = res.mcPathsSample[0].length;
  var med = [], p10 = [], p90 = [];
  var allPaths = []; // reconstruct from termination samples using sample paths
  // Use the sample paths only (computing percentiles on 100 paths)
  for (var t=0;t<L;t++) {
    var col = res.mcPathsSample.map(function(p){ return p[t]; }).sort(function(a,b){return a-b;});
    med.push(col[Math.floor(col.length*0.5)]);
    p10.push(col[Math.floor(col.length*0.1)]);
    p90.push(col[Math.floor(col.length*0.9)]);
  }
  pathDatasets.push({ data: med, borderColor: C.danger, borderWidth: 2, pointRadius: 0, fill: false, label: 'Median' });
  pathDatasets.push({ data: p10, borderColor: C.blue, borderWidth: 1.5, borderDash: [5,3], pointRadius: 0, fill: false, label: 'Low Estimate' });
  pathDatasets.push({ data: p90, borderColor: C.blue, borderWidth: 1.5, borderDash: [5,3], pointRadius: 0, fill: false, label: 'High Estimate' });
  var pathLabels = []; for (var pl=0;pl<L;pl++) pathLabels.push(pl);
  new Chart(document.getElementById('quantMcPathsChart').getContext('2d'), {
    type: 'line',
    data: { labels: pathLabels, datasets: pathDatasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'bottom', labels: { filter: function(it){ return it.text && (it.text.indexOf('Median')>=0 || it.text.indexOf('Estimate')>=0); }, font: { size: 10 }, color: C.textSec } },
        tooltip: { enabled: false }
      },
      scales: {
        x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { maxTicksLimit: 6 }), title: { display: true, text: 'Trading Days', font: { size: 10 }, color: C.textSec } },
        y: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { callback: function(v){ return '$'+v.toFixed(0); } }), title: { display: true, text: 'Price', font: { size: 10 }, color: C.textSec } }
      }
    }
  });
  // MC histogram
  var termSorted = res.mcTerm.slice().sort(function(a,b){return a-b;});
  var minT = termSorted[0], maxT = termSorted[termSorted.length-1];
  var nb = 25;
  var bw = (maxT-minT)/nb;
  var bins = new Array(nb).fill(0);
  var binLabels = [];
  for (var bi=0;bi<nb;bi++) binLabels.push('$'+(minT + bi*bw).toFixed(0));
  for (var ti=0;ti<res.mcTerm.length;ti++) {
    var bidx = Math.min(nb-1, Math.floor((res.mcTerm[ti] - minT)/bw));
    bins[bidx]++;
  }
  new Chart(document.getElementById('quantMcHistChart').getContext('2d'), {
    type: 'bar',
    data: { labels: binLabels, datasets: [{ data: bins, backgroundColor: C.navy, borderColor: C.navy, borderWidth: 1 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: Object.assign({}, chartTooltip, { callbacks: { label: function(ctx){ return ctx.parsed.y + ' paths'; } } }) },
      scales: {
        x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { maxTicksLimit: 10, maxRotation: 45, font: { size: 9 } }) },
        y: { grid: chartGrid, ticks: chartTicks, title: { display: true, text: 'Path Count', font: { size: 10 }, color: C.textSec } }
      }
    }
  });
  // Residual scatter
  var scatterData = res.y.map(function(yi, idx){ return { x: res.yhat[idx]*100, y: yi*100 }; });
  new Chart(document.getElementById('quantResidScatter').getContext('2d'), {
    type: 'scatter',
    data: { datasets: [
      { label: 'Obs', data: scatterData, pointRadius: 2.5, pointBackgroundColor: 'rgba(0,60,113,0.45)', pointBorderColor: 'transparent' },
      { type: 'line', label: 'Perfect fit', data: [{x: Math.min.apply(null, scatterData.map(function(p){return p.x;})), y: Math.min.apply(null, scatterData.map(function(p){return p.x;}))}, {x: Math.max.apply(null, scatterData.map(function(p){return p.x;})), y: Math.max.apply(null, scatterData.map(function(p){return p.x;}))}], borderColor: C.danger, borderWidth: 1.5, borderDash: [4,3], pointRadius: 0, fill: false }
    ] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: true, position: 'bottom', labels: { font: { size: 10 }, color: C.textSec } }, tooltip: chartTooltip },
      scales: {
        x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { callback: function(v){return v.toFixed(1)+'%';} }), title: { display: true, text: 'Predicted Return', font: { size: 11 }, color: C.textSec } },
        y: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { callback: function(v){return v.toFixed(1)+'%';} }), title: { display: true, text: 'Actual Return', font: { size: 11 }, color: C.textSec } }
      }
    }
  });
  // Residual histogram
  var resids = res.residuals.map(function(r){ return r*100; }).sort(function(a,b){return a-b;});
  var minR = resids[0], maxR = resids[resids.length-1];
  var nrb = 20;
  var rbw = (maxR-minR)/nrb;
  var rbins = new Array(nrb).fill(0);
  var rbinLabels = [];
  for (var rbi=0;rbi<nrb;rbi++) rbinLabels.push((minR + rbi*rbw).toFixed(1)+'%');
  for (var rti=0;rti<resids.length;rti++) {
    var ridx = Math.min(nrb-1, Math.floor((resids[rti] - minR)/rbw));
    rbins[ridx]++;
  }
  new Chart(document.getElementById('quantResidHist').getContext('2d'), {
    type: 'bar',
    data: { labels: rbinLabels, datasets: [{ data: rbins, backgroundColor: C.blue, borderColor: C.navy, borderWidth: 1 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: chartTooltip },
      scales: {
        x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { maxTicksLimit: 10, maxRotation: 45, font: { size: 9 } }) },
        y: { grid: chartGrid, ticks: chartTicks, title: { display: true, text: 'Frequency', font: { size: 10 }, color: C.textSec } }
      }
    }
  });
}

// ═══════════════════════════════════════════════════════
// ═══════════ COMMAND PALETTE + SHORTCUTS ═══════════════
// ═══════════════════════════════════════════════════════
var CMDK_ITEMS = [
  { section: 'Pages', title: 'Home', desc: 'Platform overview', action: function(){ navigateTo('home'); } },
  { section: 'Pages', title: 'About', desc: 'About Perry Asset Management', action: function(){ navigateTo('about'); } },
  { section: 'Pages', title: 'Portfolio Overview', desc: 'Holdings, allocation, performance', action: function(){ navigateTo('portfolio'); } },
  { section: 'Pages', title: 'Manage Holdings', desc: 'Add, edit, or sell positions', action: function(){ navigateTo('holdings'); } },
  { section: 'Pages', title: 'Financial Analysis', desc: 'Ticker lookup with SEC fundamentals', action: function(){ navigateTo('research'); } },
  { section: 'Pages', title: 'Macro Regime Analysis', desc: 'CFA regime scorecard, FRED data', action: function(){ navigateTo('macro'); loadMacroLiveTable(); } },
  { section: 'Pages', title: 'Quantitative Models', desc: 'MLR, regime backtest, Monte Carlo', action: function(){ navigateTo('research'); setTimeout(function(){ if (typeof rqShowTab === 'function') rqShowTab('quant'); }, 200); } },
  { section: 'Pages', title: 'Markets', desc: 'Cross-asset analytics, VaR, efficient frontier', action: function(){ navigateTo('markets'); } },
  { section: 'Actions', title: 'Analyze a ticker', desc: 'Jump to Financial Analysis and pre-fill', action: null, isTickerPrompt: true },
  { section: 'Actions', title: 'Run Quant analysis', desc: 'Jump to Quant tab in Research', action: function(){ navigateTo('research'); setTimeout(function(){ if (typeof rqShowTab === 'function') rqShowTab('quant'); var el = document.getElementById('quantTicker'); if (el) el.focus(); }, 300); } },
  { section: 'Actions', title: 'Refresh Macro data', desc: 'Re-pull FRED indicators', action: function(){ navigateTo('macro'); loadMacroLiveTable(true); } },
  { section: 'Actions', title: 'Open Markets &mdash; load default universe', desc: 'Auto-load 7 default tickers', action: function(){ navigateTo('markets'); setTimeout(function(){ if (typeof mktLoadAll === 'function') mktLoadAll(); }, 300); } }
];

function openCmdK() {
  var ov = document.getElementById('cmdkOverlay');
  ov.classList.add('open');
  var input = document.getElementById('cmdkInput');
  input.value = '';
  renderCmdKResults('');
  setTimeout(function(){ input.focus(); }, 10);
}
function closeCmdK() {
  document.getElementById('cmdkOverlay').classList.remove('open');
}
function renderCmdKResults(query) {
  var q = query.trim().toLowerCase();
  var results = document.getElementById('cmdkResults');
  var matches = [];
  if (!q) {
    matches = CMDK_ITEMS.slice();
  } else {
    // If query looks like a ticker (1-6 uppercase-ish chars, no spaces)
    var isTicker = /^[A-Z]{1,6}(-[A-Z]{1,4})?$/i.test(query.trim());
    if (isTicker) {
      matches.push({
        section: 'Ticker Action',
        title: 'Analyze '+query.trim().toUpperCase(),
        desc: 'Open Financial Analysis for this ticker',
        action: function(){
          navigateTo('research');
          setTimeout(function(){
            document.getElementById('researchTicker').value = query.trim().toUpperCase();
            if (typeof runResearch === 'function') runResearch();
          }, 200);
        }
      });
      matches.push({
        section: 'Ticker Action',
        title: 'Run Quant on '+query.trim().toUpperCase(),
        desc: 'MLR + Monte Carlo analysis',
        action: function(){
          navigateTo('research');
          setTimeout(function(){
            if (typeof rqShowTab === 'function') rqShowTab('quant');
            setTimeout(function(){
              var el = document.getElementById('quantTicker');
              if (el) { el.value = query.trim().toUpperCase(); runQuantAnalysis(); }
            }, 200);
          }, 200);
        }
      });
    }
    CMDK_ITEMS.forEach(function(it){
      if (it.title.toLowerCase().indexOf(q) >= 0 || it.desc.toLowerCase().indexOf(q) >= 0) matches.push(it);
    });
  }
  var html = '';
  var currentSection = null;
  matches.forEach(function(m, idx){
    if (m.section !== currentSection) { html += '<div class="cmdk-section-label">'+m.section+'</div>'; currentSection = m.section; }
    html += '<div class="cmdk-item'+(idx===0?' active':'')+'" data-idx="'+idx+'">';
    html += '<div class="cmdk-item-icon">'+m.section.charAt(0)+'</div>';
    html += '<div style="flex:1;"><div class="cmdk-item-title">'+m.title+'</div><div class="cmdk-item-desc">'+m.desc+'</div></div>';
    html += '</div>';
  });
  if (!matches.length) html = '<div style="padding:40px;text-align:center;color:var(--text-sec);font-size:13px;">No results. Try typing a page name or ticker.</div>';
  results.innerHTML = html;
  // Bind click
  var nodes = results.querySelectorAll('.cmdk-item');
  nodes.forEach(function(node, ni){
    node.onclick = function(){ var m = matches[ni]; if (m && m.action) { closeCmdK(); m.action(); } };
  });
  window._cmdkMatches = matches;
  window._cmdkActive = 0;
}
// Arrow navigation
document.addEventListener('keydown', function(e){
  // Cmd+K / Ctrl+K to open
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    openCmdK();
    return;
  }
  var ov = document.getElementById('cmdkOverlay');
  if (ov && ov.classList.contains('open')) {
    if (e.key === 'Escape') { closeCmdK(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      var matches = window._cmdkMatches || [];
      if (!matches.length) return;
      var idx = window._cmdkActive || 0;
      idx = idx + (e.key === 'ArrowDown' ? 1 : -1);
      if (idx < 0) idx = matches.length - 1;
      if (idx >= matches.length) idx = 0;
      window._cmdkActive = idx;
      var nodes = document.querySelectorAll('.cmdk-item');
      nodes.forEach(function(n,i){ n.classList.toggle('active', i===idx); });
      return;
    }
    if (e.key === 'Enter') {
      var matches = window._cmdkMatches || [];
      var idx = window._cmdkActive || 0;
      if (matches[idx] && matches[idx].action) { closeCmdK(); matches[idx].action(); }
      return;
    }
    return;
  }
  // Timeframe shortcuts — only when not in an input
  if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'SELECT')) return;
  var shortcutMap = { '1': '1mo', '3': '3mo', '6': '6mo', 'y': 'ytd', 'Y': '1y', '5': '5y' };
  if (e.key in shortcutMap) {
    // Find the active page's timeframe buttons
    var activePage = document.querySelector('.page.active');
    if (!activePage) return;
    var range = shortcutMap[e.key];
    var btns = activePage.querySelectorAll('[data-range="'+range+'"]');
    if (btns.length) { btns[0].click(); }
  }
});
// Wire input
setTimeout(function(){
  var inp = document.getElementById('cmdkInput');
  if (inp) inp.oninput = function(){ renderCmdKResults(inp.value); };
}, 500);

// ═══ GLOBAL STATUS BAR UPDATES ═══
function mktUpdateStatusBar() {
  var elM = document.getElementById('statusMacro');
  var elMk = document.getElementById('statusMarkets');
  if (elM) {
    if (_macroLoadedAt) {
      var mins = Math.floor((Date.now() - _macroLoadedAt.getTime())/60000);
      elM.innerHTML = '<span class="dot" style="background:var(--success);"></span>Macro: '+(mins<1?'just now':mins+'m ago');
      elM.className = 'status-pill ok';
    } else {
      elM.innerHTML = 'Macro: not loaded';
      elM.className = 'status-pill';
    }
  }
  if (elMk) {
    if (window._mktLoadedAt) {
      var minsk = Math.floor((Date.now() - window._mktLoadedAt.getTime())/60000);
      elMk.innerHTML = '<span class="dot" style="background:var(--success);"></span>Markets: '+(minsk<1?'just now':minsk+'m ago');
      elMk.className = 'status-pill ok';
    } else {
      elMk.innerHTML = 'Markets: not loaded';
      elMk.className = 'status-pill';
    }
  }
}
// Refresh status bar every minute
setInterval(function(){ try { mktUpdateStatusBar(); } catch(e){} }, 60000);
// Also call initial
setTimeout(mktUpdateStatusBar, 1000);

// BUILD VERSION — helps debugging: confirm this is the latest deploy
console.log('%c[Perry Asset Management] Build v2026.04.21-pricefix-v3 loaded', 'background:#003C71;color:#fff;padding:4px 10px;border-radius:3px;font-weight:700;');
console.log('[Perry] If prices still show $0 in Holdings table after sign-in, paste this entire console output into the chat.');

// ═══════════════════════════════════════════════════════
// ═══════════ RESOURCES / TRAINING PAGE ═════════════════
// ═══════════════════════════════════════════════════════
var GLOSSARY = [
  // PORTFOLIO METRICS
  { term: 'Total Portfolio Value', cat: 'Portfolio Metrics', pages: ['Portfolio'], eq: 'Σ (Price × Quantity) across all holdings', why: 'The current market value of all your positions. Reported as dollar amount; day-change percent shows intraday move.' },
  { term: 'Total Cost Basis', cat: 'Portfolio Metrics', pages: ['Portfolio', 'Holdings'], eq: 'Σ (Cost/Share × Quantity) across all holdings', why: 'The total amount you paid for all current positions (before dividends or commissions). Used as the anchor point for unrealized gain/loss.' },
  { term: 'Total Gain/Loss', cat: 'Portfolio Metrics', pages: ['Portfolio'], eq: 'Total Value − Total Cost Basis', why: 'Unrealized P&L. Positive = you\'d profit if you sold everything at current prices; negative = you\'d realize a loss.' },
  { term: 'Day Change', cat: 'Portfolio Metrics', pages: ['Portfolio'], eq: 'Current Value − Previous Close Value', why: 'The dollar swing in your portfolio since yesterday\'s market close.' },
  { term: 'Weighted Average Cost Basis', cat: 'Portfolio Metrics', pages: ['Holdings'], eq: '((Existing_Cost × Existing_Qty) + (New_Cost × New_Qty)) / Total_Qty', why: 'Applied when you add to an existing position in the same account. Merges lots into a single average cost per share for reporting (actual tax lots are still tracked separately by your broker).' },
  { term: 'Market Value per Holding', cat: 'Portfolio Metrics', pages: ['Portfolio', 'Holdings'], eq: 'Current Price × Quantity', why: 'What a single position is worth right now. For cash-like positions (SPAXX, CD, Bond), this is the deposit amount.' },

  // VALUATION
  { term: 'P/E Ratio (Price-to-Earnings)', cat: 'Valuation', pages: ['Research'], eq: 'Price / Earnings-Per-Share', why: 'How much investors pay per dollar of earnings. Lower = cheaper (but could mean weak growth); higher = expensive or high growth expected.' },
  { term: 'EV/EBITDA', cat: 'Valuation', pages: ['Research'], eq: '(Market Cap + Debt − Cash) / EBITDA', why: 'Capital-structure-neutral valuation. Good for comparing companies with different debt loads.' },
  { term: 'Price/Book (P/B)', cat: 'Valuation', pages: ['Research'], eq: 'Price / Book Value per Share', why: 'Market value vs accounting book value. Below 1 = trading below net assets; common screen for value stocks.' },
  { term: 'Free Cash Flow Yield', cat: 'Valuation', pages: ['Research'], eq: 'Free Cash Flow / Market Cap', why: 'What percentage of your investment the company generates in cash each year. Key input to DCF valuation.' },
  { term: 'DCF (Discounted Cash Flow)', cat: 'Valuation', pages: ['Research'], eq: 'Σ FCFₜ / (1+r)ᵗ + Terminal Value', why: 'Intrinsic value calculation: sum of all future cash flows discounted to present. r = cost of capital (WACC).' },
  { term: 'Terminal Value (Gordon Growth)', cat: 'Valuation', pages: ['Research'], eq: 'FCF × (1+g) / (r − g)', why: 'Captures value beyond the explicit forecast window. Assumes cash flows grow at rate g forever.' },

  // RISK
  { term: 'Value at Risk (VaR)', cat: 'Risk', pages: ['Markets'], eq: 'VaR_95 = μ − 1.645σ (parametric); 5th percentile (historical); μ − z_CF × σ (Cornish-Fisher)', why: 'Worst expected loss at a confidence level. 1-day 95% VaR of 2% means: 95% of days, you won\'t lose more than 2%.' },
  { term: 'Conditional VaR (CVaR / Expected Shortfall)', cat: 'Risk', pages: ['Markets'], eq: 'E[Loss | Loss ≥ VaR]', why: 'Expected loss given you\'re already in the tail. Unlike VaR, CVaR is a coherent (sub-additive) risk measure (Artzner et al., 1999).' },
  { term: 'Cornish-Fisher Expansion', cat: 'Risk', pages: ['Markets'], eq: 'z_CF = z + (z²−1)S/6 + (z³−3z)K/24 − (2z³−5z)S²/36', why: 'Adjusts z-scores for skewness (S) and excess kurtosis (K). Corrects normal-distribution VaR for real-world fat tails.' },
  { term: 'Maximum Drawdown', cat: 'Risk', pages: ['Markets', 'Portfolio'], eq: 'max over t of [Peak(0..t) − Price(t)] / Peak(0..t)', why: 'Worst peak-to-trough decline. Investors often care more about this than volatility because it captures the actual pain of losses.' },
  { term: 'Sharpe Ratio', cat: 'Risk', pages: ['Markets', 'Quant'], eq: '(μ − r_f) / σ, annualized via ×√252', why: 'Excess return per unit of total volatility. Higher = better risk-adjusted return. r_f = risk-free rate (~4–5%).' },
  { term: 'Sortino Ratio', cat: 'Risk', pages: ['Markets'], eq: '(μ − r_f) / σ_downside', why: 'Like Sharpe but only penalizes downside volatility. Upside volatility is good and shouldn\'t reduce the score.' },
  { term: 'Beta (β)', cat: 'Risk', pages: ['Markets', 'Quant'], eq: 'Cov(R_asset, R_mkt) / Var(R_mkt)', why: 'Sensitivity to market. β = 1 moves with market, β = 2 amplifies it 2x, β = 0 uncorrelated.' },
  { term: 'Annualized Volatility', cat: 'Risk', pages: ['Markets', 'Quant'], eq: 'std(daily log returns) × √252', why: 'Year-equivalent standard deviation. The square-root-of-time scaling assumes i.i.d. returns.' },
  { term: 'Pearson Correlation (ρ)', cat: 'Risk', pages: ['Markets'], eq: 'Σ[(xᵢ−x̄)(yᵢ−ȳ)] / √[Σ(xᵢ−x̄)² × Σ(yᵢ−ȳ)²]', why: 'Linear association between two return series. ρ = 1 perfect positive, ρ = −1 perfect inverse, ρ = 0 none. Foundation of diversification.' },

  // QUANT
  { term: 'Multiple Linear Regression (MLR)', cat: 'Quantitative', pages: ['Quant'], eq: 'y = β₀ + β₁x₁ + ... + βₖxₖ + ε; β = (X\'X)⁻¹X\'y', why: 'Estimates how much each feature (x) predicts y (forward return). Standardized coefficients (β) tell you directional impact after scaling.' },
  { term: 'Bootstrap Confidence Intervals', cat: 'Quantitative', pages: ['Quant'], eq: 'Resample (X,y) with replacement B times; β_CI = [2.5th pct, 97.5th pct]', why: 'Non-parametric alternative to t-tests. Tells you how stable your coefficient estimate is under alternative samples (Efron, 1979).' },
  { term: 'Sign Stability', cat: 'Quantitative', pages: ['Quant'], eq: 'Fraction of bootstrap samples where β has the same sign as the point estimate', why: '>90% = robust estimate. <75% = flip-prone, probably not a real signal.' },
  { term: 'R² (Coefficient of Determination)', cat: 'Quantitative', pages: ['Quant'], eq: '1 − SSE/SST', why: 'Fraction of variance in y explained by the model. R² = 0.30 typical for stock return regressions.' },
  { term: 'Adjusted R²', cat: 'Quantitative', pages: ['Quant'], eq: '1 − (1−R²)(n−1)/(n−p)', why: 'Penalizes for extra predictors. Prevents overfitting from inflating R².' },
  { term: 'Monte Carlo Simulation (GBM)', cat: 'Quantitative', pages: ['Quant', 'Markets'], eq: 'S_t+1 = S_t × exp((μ − 0.5σ²)dt + σ√dt × Z)', why: 'Geometric Brownian Motion. Simulates thousands of possible price paths; percentiles give you a return distribution instead of a point estimate (Hull, 2022).' },
  { term: 'Cox (Doubly Stochastic) Process', cat: 'Quantitative', pages: ['Markets'], eq: 'dλ = κ(θ − λ)dt + σ_λ√λ dW (CIR intensity); N(t) | λ(s) ~ Poisson(∫λds)', why: 'Jump model where crash intensity is itself stochastic. Captures volatility clustering — jumps bunch together in some regimes (Cox, 1955).' },
  { term: 'Efficient Frontier', cat: 'Quantitative', pages: ['Markets'], eq: 'For each target μ_p: min w\'Σw s.t. w\'μ = μ_p, Σw_i = 1', why: 'Upper-left boundary of risk-return space. No rational investor holds a portfolio interior to the frontier (Markowitz, 1952).' },
  { term: 'Tangency (Max Sharpe) Portfolio', cat: 'Quantitative', pages: ['Markets'], eq: 'argmax_w (w\'μ − r_f) / √(w\'Σw)', why: 'Optimal risky portfolio when combined with the risk-free asset. The starting point for every CFA L3 allocation.' },

  // MACRO
  { term: 'Business Cycle Regime', cat: 'Macro', pages: ['Macro'], eq: 'Classified from 10-indicator regime scorecard: Early Exp / Mid / Late / Contraction', why: 'Determines sector tilts. Early = Financials/Cyclicals; Mid = Tech/Industrials; Late = Energy/Staples; Contraction = Utilities/Treasuries (CFA L3).' },
  { term: 'Taylor Rule', cat: 'Macro', pages: ['Macro'], eq: 'FFR* = r* + π + 0.5(π − π*) + 0.5(Y − Y*)', why: 'Model-implied Fed Funds Rate. Gap vs actual tells you if policy is too loose or too tight (Taylor, 1993).' },
  { term: 'Yield Curve Slope', cat: 'Macro', pages: ['Macro'], eq: '10Y Treasury yield − 2Y (or 3M) Treasury yield', why: 'Every U.S. recession since 1970 preceded by 3M/10Y inversion. Steep curve = healthy expansion; inverted = policy too tight.' },
  { term: 'Regime Scorecard', cat: 'Macro', pages: ['Macro'], eq: 'Σ of ±1 per indicator based on threshold tests; range [−10, +10]', why: 'Aggregates ISM, claims, curve, SLOOS, LEI, HY OAS, real FFR, NFP, Core PCE into one number for quick regime read.' },
  { term: 'HY OAS (High-Yield Option-Adjusted Spread)', cat: 'Macro', pages: ['Macro'], eq: 'HY bond yield − duration-matched Treasury yield', why: 'Credit risk premium. Widening HY spreads signal credit stress and typically precede equity drawdowns.' },

  // ACCOUNTS
  { term: 'Cost Basis per Share', cat: 'Accounts', pages: ['Holdings'], eq: 'Total amount paid for the position / number of shares', why: 'The per-share price at which you purchased. Difference with current price = unrealized gain/loss per share.' },
  { term: 'Tax Lot', cat: 'Accounts', pages: ['Holdings'], eq: '—', why: 'A specific block of shares bought at a specific date/price. Real tax lots are tracked by your broker; this app merges same-ticker-same-account positions into one weighted-average row for simplicity.' },
  { term: 'Traditional IRA', cat: 'Accounts', pages: ['Holdings'], eq: '—', why: 'Pre-tax contributions, tax-deferred growth, taxed on withdrawal. 2025 limit: $7,000 ($8,000 if 50+). RMDs at 73.' },
  { term: 'Roth IRA', cat: 'Accounts', pages: ['Holdings'], eq: '—', why: 'After-tax contributions, tax-free growth, tax-free qualified withdrawals. 2025 limit: $7,000 ($8,000 if 50+). No RMDs during owner\'s life. Income phase-outs apply.' },
  { term: 'HSA (Health Savings Account)', cat: 'Accounts', pages: ['Holdings'], eq: '—', why: 'Triple-tax-advantaged: deductible contributions, tax-free growth, tax-free qualified medical withdrawals. Requires HDHP. Best tax-advantaged account in the code if used correctly.' },

  // TECHNICAL
  { term: 'Moving Average (SMA)', cat: 'Technical', pages: ['Markets', 'Research'], eq: 'Σ(last N prices) / N', why: 'Smooths noise. Price crossing above 200-day SMA is a commonly watched bullish signal.' },
  { term: 'Log Return', cat: 'Technical', pages: ['Markets', 'Quant'], eq: 'r_t = ln(P_t / P_{t−1})', why: 'Additive across time (unlike simple returns). Assumed approximately normal for short horizons — foundation for most statistical models.' },
  { term: 'Rebased Index', cat: 'Technical', pages: ['Markets'], eq: 'Rebased(t) = P(t) / P(t₀) × 100', why: 'Compares multiple series on the same scale regardless of starting price. Every series starts at 100.' },
  { term: 'Rolling Window Statistic', cat: 'Technical', pages: ['Markets', 'Quant'], eq: 'Stat computed on [t−N+1, t] for each t', why: 'Lets you see how metrics evolve over time (e.g., is Sharpe improving or deteriorating?).' }
];
var ACCOUNT_INFO = [
  { name: 'Individual Brokerage', tag: 'TAXABLE', limit: 'No limit', tax: 'Dividends/gains taxed annually; long-term capital gains rate if held >1 year', use: 'Flexible, no penalties or age restrictions. Best for goals outside retirement.' },
  { name: 'Traditional IRA', tag: 'PRE-TAX', limit: '$7,000/yr ($8,000 if 50+)', tax: 'Contributions may be deductible; tax-deferred growth; withdrawals taxed as ordinary income', use: 'Lower-tax-bracket retirees or when expecting lower future tax rate. RMDs begin at age 73.' },
  { name: 'Roth IRA', tag: 'POST-TAX', limit: '$7,000/yr ($8,000 if 50+)', tax: 'Contributions not deductible; growth and qualified withdrawals tax-free', use: 'Young investors; anyone expecting higher future tax rate. No RMDs during owner\'s lifetime. Income phase-outs apply.' },
  { name: 'Standard 401(k)', tag: 'PRE-TAX', limit: '$23,500/yr ($31,000 if 50+)', tax: 'Pre-tax contributions; tax-deferred growth; taxed as ordinary income on withdrawal', use: 'Core retirement savings, especially when employer matches. Higher limits than IRAs.' },
  { name: 'Roth 401(k)', tag: 'POST-TAX', limit: '$23,500/yr ($31,000 if 50+)', tax: 'Post-tax contributions; tax-free growth and qualified withdrawals', use: 'Same limits as standard 401(k) but with Roth tax treatment. Ideal for high earners in a moderate tax bracket today who expect higher rates later.' },
  { name: 'BrokerageLink 401(k)', tag: 'SELF-DIRECTED', limit: '401(k) limits apply', tax: 'Inherits underlying 401(k)\'s tax treatment', use: 'Fidelity feature that turns part of a 401(k) into a brokerage window, unlocking individual stocks/ETFs beyond plan fund list.' },
  { name: 'SEP IRA', tag: 'PRE-TAX', limit: 'Up to 25% of compensation, max $70,000', tax: 'Pre-tax; tax-deferred growth; taxed on withdrawal', use: 'Self-employed and small business owners. Very high contribution ceiling.' },
  { name: '529 Plan', tag: 'EDUCATION', limit: 'State-specific aggregate limits ($300K+)', tax: 'Post-tax; tax-free growth and withdrawals for qualified education expenses', use: 'College (and K-12 up to $10K/yr) savings. Some state income tax deductions on contributions.' },
  { name: 'HSA', tag: 'TRIPLE-TAX', limit: '$4,300 single / $8,550 family (2025)', tax: 'Pre-tax contributions; tax-free growth; tax-free qualified medical withdrawals', use: 'The most tax-efficient account type if used as a long-term investment vehicle. Requires HDHP.' },
  { name: 'Trust Account', tag: 'TAXABLE', limit: 'No statutory limit', tax: 'Trust-level or beneficiary-level taxation depending on trust structure', use: 'Estate planning, avoiding probate, controlling asset distribution after death.' },
  { name: 'Custodial (UTMA/UGMA)', tag: 'TAXABLE', limit: 'No limit; gift-tax rules apply', tax: 'Kiddie tax rules apply to unearned income above thresholds', use: 'Gifts/assets for minors. Transfers to minor at age of majority (18–25 depending on state).' },
  { name: 'Joint Account', tag: 'TAXABLE', limit: 'No limit', tax: 'Reported to all owners; survivorship rules vary by titling', use: 'Spouses or partners managing assets together. Joint Tenants with Right of Survivorship (JTWROS) is most common.' },
  { name: 'Designated Beneficiary IRA', tag: 'INHERITED', limit: 'No contributions; RMDs apply', tax: 'Inherits original owner\'s tax treatment; 10-year withdrawal rule (SECURE Act)', use: 'Inherited retirement account. Non-spouse beneficiaries must typically empty account within 10 years.' }
];

function resourcesInit() {
  // Render account types
  var acctGrid = document.getElementById('acctInfoGrid');
  if (acctGrid && !acctGrid.hasChildNodes()) {
    var ah = '';
    for (var i=0;i<ACCOUNT_INFO.length;i++) {
      var a = ACCOUNT_INFO[i];
      ah += '<div class="acct-info-card">';
      ah += '<span class="acct-tag">'+a.tag+'</span>';
      ah += '<h4 style="margin:6px 0 8px;color:var(--navy);font-size:14px;">'+a.name+'</h4>';
      ah += '<div class="acct-detail"><strong>Contribution Limit:</strong> '+a.limit+'</div>';
      ah += '<div class="acct-detail"><strong>Tax Treatment:</strong> '+a.tax+'</div>';
      ah += '<div class="acct-detail"><strong>Best For:</strong> '+a.use+'</div>';
      ah += '</div>';
    }
    acctGrid.innerHTML = ah;
  }
  resFilter();
}

function resFilter() {
  var q = (document.getElementById('resSearch').value || '').toLowerCase().trim();
  var cat = document.getElementById('resCategory').value;
  var page = document.getElementById('resPage').value;
  var filtered = GLOSSARY.filter(function(g){
    if (cat !== 'all' && g.cat !== cat) return false;
    if (page !== 'all' && g.pages.indexOf(page) < 0) return false;
    if (q && g.term.toLowerCase().indexOf(q) < 0 && g.why.toLowerCase().indexOf(q) < 0 && g.eq.toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
  // Group by category
  var grouped = {};
  filtered.forEach(function(g){ if (!grouped[g.cat]) grouped[g.cat]=[]; grouped[g.cat].push(g); });
  var cats = Object.keys(grouped);
  if (!cats.length) { document.getElementById('resGlossary').innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-sec);">No matching terms.</div>'; return; }
  var html = '';
  cats.forEach(function(c){
    html += '<div style="margin-bottom:18px;">';
    html += '<div style="background:var(--navy);color:var(--text-on-dark);padding:8px 14px;font-size:13px;font-weight:700;border-radius:4px 4px 0 0;">'+c+' <span style="opacity:.7;font-weight:400;font-size:11px;">('+grouped[c].length+' terms)</span></div>';
    html += '<div style="border:1px solid var(--border);border-top:none;border-radius:0 0 4px 4px;">';
    grouped[c].forEach(function(g, i){
      html += '<div style="padding:12px 14px;'+(i<grouped[c].length-1?'border-bottom:1px solid var(--border);':'')+'">';
      html += '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:4px;flex-wrap:wrap;">';
      html += '<strong style="font-size:13px;color:var(--navy);">'+g.term+'</strong>';
      html += '<span style="font-size:10px;color:var(--text-sec);">Used on: '+g.pages.join(', ')+'</span>';
      html += '</div>';
      if (g.eq && g.eq !== '—') html += '<div style="background:var(--panel);border:1px solid var(--border);border-radius:3px;padding:5px 10px;font-family:Arial;font-size:11.5px;margin:4px 0;color:var(--navy);">'+g.eq+'</div>';
      html += '<div style="font-size:12px;color:var(--text);line-height:1.5;">'+g.why+'</div>';
      html += '</div>';
    });
    html += '</div></div>';
  });
  document.getElementById('resGlossary').innerHTML = html;
}

// ═══════════════════════════════════════════════════════
// ═══════════ PORTFOLIO STRESS TEST ═════════════════════
// ═══════════════════════════════════════════════════════
var STRESS_SCENARIOS = {
  '2008_gfc':       { name: '2008 Global Financial Crisis', start: '2007-10-09', end: '2009-03-09', spy_ret: -0.55, note: 'Peak to trough. SPY lost ~55%; Financials ~-83%; Real Estate ~-74%.' },
  '2020_covid':     { name: 'COVID Crash', start: '2020-02-19', end: '2020-03-23', spy_ret: -0.34, note: 'Fastest 30%+ decline in S&P history (23 trading days).' },
  '2022_inflation': { name: '2022 Inflation/Rate Shock', start: '2022-01-03', end: '2022-10-12', spy_ret: -0.25, note: 'Fed aggressive tightening; both stocks and bonds down simultaneously — a rare 60/40 disaster year.' },
  '2018_q4':        { name: 'Q4 2018 Selloff', start: '2018-10-01', end: '2018-12-24', spy_ret: -0.19, note: 'Fed hawkishness and trade-war fears.' },
  'dotcom':         { name: 'Dotcom Crash', start: '2000-03-24', end: '2002-10-09', spy_ret: -0.49, note: 'Tech-led crash. NASDAQ lost ~78%; SPY ~-49%.' }
};
// Sector proxy ETF returns during each crisis (fallback when a ticker didn't exist)
var STRESS_SECTOR_PROXIES = {
  '2008_gfc':       { 'Technology': -0.51, 'Financials': -0.83, 'Energy': -0.55, 'Health Care': -0.36, 'Industrials': -0.58, 'Consumer Discretionary': -0.54, 'Consumer Staples': -0.26, 'Materials': -0.56, 'Utilities': -0.37, 'Real Estate': -0.74, 'Communication Services': -0.50, 'Cash': 0.00, 'Money Market': 0.00 },
  '2020_covid':     { 'Technology': -0.30, 'Financials': -0.42, 'Energy': -0.60, 'Health Care': -0.20, 'Industrials': -0.40, 'Consumer Discretionary': -0.34, 'Consumer Staples': -0.17, 'Materials': -0.40, 'Utilities': -0.37, 'Real Estate': -0.43, 'Communication Services': -0.27, 'Cash': 0.00, 'Money Market': 0.00 },
  '2022_inflation': { 'Technology': -0.33, 'Financials': -0.19, 'Energy': +0.40, 'Health Care': -0.09, 'Industrials': -0.14, 'Consumer Discretionary': -0.37, 'Consumer Staples': -0.06, 'Materials': -0.17, 'Utilities': -0.02, 'Real Estate': -0.32, 'Communication Services': -0.43, 'Cash': 0.00, 'Money Market': 0.00 },
  '2018_q4':        { 'Technology': -0.22, 'Financials': -0.24, 'Energy': -0.30, 'Health Care': -0.10, 'Industrials': -0.22, 'Consumer Discretionary': -0.23, 'Consumer Staples': -0.08, 'Materials': -0.22, 'Utilities': -0.01, 'Real Estate': -0.07, 'Communication Services': -0.19, 'Cash': 0.00, 'Money Market': 0.00 },
  'dotcom':         { 'Technology': -0.78, 'Financials': -0.21, 'Energy': -0.01, 'Health Care': -0.24, 'Industrials': -0.32, 'Consumer Discretionary': -0.40, 'Consumer Staples': -0.11, 'Materials': -0.28, 'Utilities': -0.28, 'Real Estate': -0.14, 'Communication Services': -0.68, 'Cash': 0.00, 'Money Market': 0.00 }
};

// Bind scenario selector
setTimeout(function(){
  var btns = document.querySelectorAll('#stressScenarioBtns .btn-outline');
  btns.forEach(function(b){
    b.onclick = function(){
      btns.forEach(function(x){ x.classList.remove('active'); });
      b.classList.add('active');
      var s = b.getAttribute('data-scenario');
      document.getElementById('stressCustomRow').style.display = s === 'custom' ? 'block' : 'none';
    };
  });
}, 800);

// Volatility parameters per scenario for leveraged ETF drag formula
var SCENARIO_VOLS = {
  '2008_gfc':       { t:378, sigma:0.030 },
  '2020_covid':     { t:23,  sigma:0.045 },
  '2022_inflation': { t:197, sigma:0.018 },
  '2018_q4':        { t:63,  sigma:0.020 },
  'dotcom':         { t:588, sigma:0.022 }
};

// Correct leveraged ETF return for a crisis period
// Uses volatility drag formula: levRet ≈ lev*R - (lev²-|lev|)/2 * σ² * T
function _stressLeveragedReturn(baseReturn, levFactor, scenarioKey) {
  var sv = SCENARIO_VOLS[scenarioKey] || { t:100, sigma:0.020 };
  var T = sv.t, sigma = sv.sigma;
  var volDrag = (levFactor*levFactor - Math.abs(levFactor)) / 2 * sigma * sigma * T;
  var raw = levFactor * baseReturn - volDrag;
  return Math.max(-0.99, raw);
}

function _parseLevMultiplier(levStr) {
  if (!levStr) return null;
  var m = String(levStr).match(/^(\d+(?:\.\d+)?)x\s*(Long|Short)/i);
  if (!m) return null;
  var factor = parseFloat(m[1]);
  return m[2].toLowerCase() === 'short' ? -factor : factor;
}

async function runStressTest() {
  var btnEl = document.getElementById('stressRunBtn');
  btnEl.disabled = true; btnEl.innerHTML = '<span class="spinner"></span> Running stress test...';
  var resultsEl = document.getElementById('stressResults');
  resultsEl.innerHTML = '<div style="padding:16px;color:var(--text-sec);"><span class="spinner"></span> Computing per-ticker crisis returns...</div>';
  try {
    var activeBtn = document.querySelector('#stressScenarioBtns .btn-outline.active');
    var key = activeBtn ? activeBtn.getAttribute('data-scenario') : '2008_gfc';
    var scenario;
    if (key === 'custom') {
      var start = document.getElementById('stressStart').value;
      var end = document.getElementById('stressEnd').value;
      var name = document.getElementById('stressName').value || 'Custom '+start+' → '+end;
      if (!start || !end || start >= end) throw new Error('Enter valid start < end date.');
      scenario = { name: name, start: start, end: end, spy_ret: null, note: 'Custom window.' };
    } else {
      scenario = Object.assign({}, STRESS_SCENARIOS[key], { key: key });
    }
    var allH = window._holdings || [];
    if (!allH.length) throw new Error('No holdings. Add positions first.');
    // Use the Scenarios tab's own account filter (was incorrectly reading the
    // Snapshot tab's filter), falling back to the global one.
    var afEl = document.getElementById('scenarioAccountFilter') || document.getElementById('portfolioAccountFilter');
    var af = (afEl && afEl.value) || 'all';
    var holdings = af === 'all' ? allH : allH.filter(function(h){ return (h.accountType||'Individual') === af; });
    if (!holdings.length) throw new Error('No holdings in this account filter.');

    // ── Manual factor overrides (previously rendered but never consumed) ──
    function _ovr(id) { var el2 = document.getElementById(id); if (!el2 || el2.value === '') return null; var n = parseFloat(el2.value); return isNaN(n) ? null : n / 100; }
    var ovrEquity = _ovr('scenarioEquityDrop');
    var ovrDuration = _ovr('scenarioDurationRally');
    var ovrGold = _ovr('scenarioGoldReturn');

    // ── Sector → liquid proxy ETF (actual history preferred over static table) ──
    var SECTOR_PROXY_ETF = { 'Technology':'XLK', 'Information Technology':'XLK', 'Financials':'XLF', 'Energy':'XLE', 'Health Care':'XLV', 'Healthcare':'XLV', 'Industrials':'XLI', 'Consumer Discretionary':'XLY', 'Consumer Staples':'XLP', 'Materials':'XLB', 'Utilities':'XLU', 'Real Estate':'XLRE', 'Communication Services':'XLC', 'Broad Market':'SPY', 'Fixed Income':'AGG' };
    // Base index proxy for leveraged products, parsed from ETF_DB lev string
    // (e.g. "3x Long QQQ" → QQQ; FANG+ has no investable index ticker → QQQ).
    function _parseLevBase(levStr) {
      if (!levStr) return null;
      var m = String(levStr).match(/^\d+(?:\.\d+)?x\s*(?:Long|Short)\s+(.+)$/i);
      if (!m) return null;
      var base = m[1].trim().toUpperCase();
      var BASE_MAP = { 'FANG+': 'QQQ', 'FANG': 'QQQ', 'NASDAQ-100': 'QQQ', 'S&P 500': 'SPY' };
      return BASE_MAP[base] || base;
    }

    // ── Resolve every symbol this run needs, then fetch ALL history through
    //    the PerryData layer (memory → Firestore → worker) with limited
    //    concurrency. One pull per symbol, cached for every other page. ──
    var neededSyms = ['SPY'];
    holdings.forEach(function(h) {
      var isCashH = h.assetClass === 'Cash' || h.assetClass === 'Money Market' || h.assetClass === 'CD' || h.assetClass === 'Bond Position';
      if (isCashH) return;
      neededSyms.push(h.ticker);
      var eE = ETF_DB[h.ticker];
      var lm = eE ? _parseLevMultiplier(eE.lev) : null;
      if (lm !== null) { var lb = _parseLevBase(eE.lev); if (lb) neededSyms.push(lb); }
      var pxy = SECTOR_PROXY_ETF[h.sector]; if (pxy) neededSyms.push(pxy);
    });
    resultsEl.innerHTML = '<div style="padding:16px;color:var(--text-sec);"><span class="spinner"></span> Pulling full daily history for ' + [...new Set(neededSyms)].length + ' symbols through the data layer (Firestore-cached after first pull)…</div>';
    var HIST = await PerryData.getMany(neededSyms, 3);

    // Custom windows: benchmark against SPY's ACTUAL return in that window
    if (scenario.spy_ret == null && HIST.SPY) {
      var spyWin = PerryData.windowReturn(HIST.SPY, scenario.start, scenario.end);
      if (spyWin != null) scenario.spy_ret = spyWin;
    }

    var stressResults = [];
    var sectorProxies = key !== 'custom' ? STRESS_SECTOR_PROXIES[key] : null;
    var failedSyms = [];
    for (var i=0;i<holdings.length;i++) {
      var h = holdings[i];
      var isCash = h.assetClass === 'Cash' || h.assetClass === 'Money Market' || h.assetClass === 'CD' || h.assetClass === 'Bond Position';
      var ret = null; var source = '';
      var etfEntry = ETF_DB[h.ticker];
      var levMult = etfEntry ? _parseLevMultiplier(etfEntry.lev) : null;
      var levBase = etfEntry ? _parseLevBase(etfEntry.lev) : null;
      var hist = HIST[String(h.ticker).toUpperCase()] || null;
      var proxyEtf = SECTOR_PROXY_ETF[h.sector] || null;
      var isBondLike = (etfEntry && etfEntry.s === 'Fixed Income') || /bond|treasur|fixed income/i.test(h.sector || '') || (levBase === 'TLT');
      var isGold = /^(GLD|IAU|GLDM|SGOL|AAAU|PHYS)$/.test(String(h.ticker).toUpperCase());

      if (isCash) {
        ret = 0; source = 'Cash-like (zero decline assumed)';
      }
      // 1) Manual overrides beat everything — that's their purpose
      else if (ovrGold != null && isGold) {
        ret = ovrGold; source = 'Manual gold override';
      }
      else if (ovrDuration != null && isBondLike) {
        ret = levMult !== null ? Math.max(-0.99, levMult * ovrDuration) : ovrDuration;
        source = 'Manual duration override' + (levMult !== null ? ' × ' + levMult + 'x leverage' : '');
      }
      else if (ovrEquity != null && !isBondLike && !isGold) {
        ret = levMult !== null ? _stressLeveragedReturn(ovrEquity, levMult, key) : ovrEquity;
        source = 'Manual equity override' + (levMult !== null ? ' × ' + levMult + 'x (vol-drag adjusted)' : '');
      }
      // 2) The ticker's OWN full history covers the window → use actual decline
      else if (hist && PerryData.windowReturn(hist, scenario.start, scenario.end) != null) {
        ret = PerryData.windowReturn(hist, scenario.start, scenario.end);
        source = 'Actual ' + h.ticker + ' price history ' + scenario.start + ' → ' + scenario.end;
      }
      // 3) Leveraged product without history → DAILY-COMPOUNDED simulation on
      //    the base index (how these funds actually work: leverage resets daily)
      else if (levMult !== null && levBase && HIST[levBase]) {
        var simRet = PerryData.leveragedWindowReturn(HIST[levBase], scenario.start, scenario.end, levMult);
        if (simRet != null) {
          ret = simRet;
          source = 'Simulated: ' + levMult + '× ' + levBase + ' daily returns compounded through the window, net 0.95%/yr expense (' + etfEntry.lev + ')';
        }
      }
      // 4) Non-leveraged without history → sector proxy ETF's ACTUAL window return
      if (ret == null && proxyEtf && HIST[proxyEtf]) {
        if (levMult !== null) {
          var simRet2 = PerryData.leveragedWindowReturn(HIST[proxyEtf], scenario.start, scenario.end, levMult);
          if (simRet2 != null) { ret = simRet2; source = 'Simulated: ' + levMult + '× ' + proxyEtf + ' (sector proxy) daily returns compounded'; }
        } else {
          var pRet = PerryData.windowReturn(HIST[proxyEtf], scenario.start, scenario.end);
          if (pRet != null) { ret = pRet; source = h.ticker + ' didn\'t trade then — actual ' + proxyEtf + ' sector-proxy return'; }
        }
      }
      // 5) Static sector table (named scenarios only; e.g. XLC/XLRE pre-inception)
      if (ret == null && !isCash && sectorProxies && h.sector && sectorProxies[h.sector] != null) {
        var baseRet = sectorProxies[h.sector];
        if (levMult !== null) { ret = _stressLeveragedReturn(baseRet, levMult, key); source = 'Static ' + h.sector + ' proxy × ' + levMult + 'x (vol-drag approx — no daily data available)'; }
        else { ret = baseRet; source = 'Static ' + h.sector + ' sector proxy table'; }
      }
      // 6) Last resort: SPY (actual if we have it)
      if (ret == null && !isCash) {
        var spyBase = (HIST.SPY ? PerryData.windowReturn(HIST.SPY, scenario.start, scenario.end) : null);
        if (spyBase == null) spyBase = scenario.spy_ret != null ? scenario.spy_ret : -0.30;
        if (levMult !== null) {
          var simSpy = HIST.SPY ? PerryData.leveragedWindowReturn(HIST.SPY, scenario.start, scenario.end, levMult) : null;
          ret = simSpy != null ? simSpy : _stressLeveragedReturn(spyBase, levMult, key);
          source = 'SPY fallback × ' + levMult + 'x daily-compounded';
        } else {
          ret = spyBase; source = 'SPY fallback (no ticker/sector history for this window)';
        }
        failedSyms.push(h.ticker);
      }

      var mv = (h.currentPrice || h.costBasis) * h.quantity;
      var newMv = mv * (1 + ret);
      var impact = newMv - mv;
      stressResults.push({
        ticker: h.ticker, sector: h.sector || '—', account: h.accountType || 'Individual',
        mv: mv, ret: ret, newMv: newMv, impact: impact, source: source,
        isLeveraged: levMult !== null
      });
    }
    // Sort by impact (most negative first)
    stressResults.sort(function(a,b){ return a.impact - b.impact; });
    var totalMvBefore = stressResults.reduce(function(s,r){ return s+r.mv; }, 0);
    var totalMvAfter = stressResults.reduce(function(s,r){ return s+r.newMv; }, 0);
    var totalImpact = totalMvAfter - totalMvBefore;
    var totalRet = totalMvBefore > 0 ? totalImpact/totalMvBefore : 0;

    // Build per-sector aggregation (value-weighted)
    var sectorMap = {};
    stressResults.forEach(function(r) {
      var sec = r.sector || '—';
      if (!sectorMap[sec]) sectorMap[sec] = { weightedRet: 0, totalImpact: 0, totalMv: 0 };
      sectorMap[sec].weightedRet += r.ret * r.mv;
      sectorMap[sec].totalImpact += r.impact;
      sectorMap[sec].totalMv += r.mv;
    });
    var sectorResults = Object.keys(sectorMap).map(function(s) {
      var d = sectorMap[s];
      return { sector: s, avgRet: d.totalMv > 0 ? d.weightedRet / d.totalMv : 0, totalImpact: d.totalImpact };
    }).sort(function(a, b) { return a.totalImpact - b.totalImpact; });
    var worstSector = sectorResults[0] || null;
    var bestSector = sectorResults[sectorResults.length - 1] || null;

    var html = '';
    // Scenario header
    html += '<div style="background:var(--navy);color:var(--text-on-dark);padding:16px 20px;border-radius:6px;margin-bottom:16px;">';
    html += '<div style="font-size:11px;opacity:0.85;letter-spacing:.5px;text-transform:uppercase;">Scenario</div>';
    html += '<div style="font-size:18px;font-weight:700;margin-top:2px;">'+scenario.name+'</div>';
    html += '<div style="font-size:11px;opacity:0.8;margin-top:4px;">'+scenario.start+' → '+scenario.end+'. '+scenario.note+'</div>';
    html += '</div>';
    // Summary metric cards
    html += '<div class="chart-stats">';
    html += '<div class="chart-stat-box"><div class="chart-stat-label">Pre-Crisis Value</div><div class="chart-stat-value">'+fmtInt(totalMvBefore)+'</div></div>';
    html += '<div class="chart-stat-box"><div class="chart-stat-label">Post-Crisis Value</div><div class="chart-stat-value" style="color:'+(totalImpact>=0?'var(--success)':'var(--danger)')+';">'+fmtInt(totalMvAfter)+'</div></div>';
    html += '<div class="chart-stat-box"><div class="chart-stat-label">Total Impact</div><div class="chart-stat-value" style="color:'+(totalImpact>=0?'var(--success)':'var(--danger)')+';">'+fmt(totalImpact)+'</div></div>';
    html += '<div class="chart-stat-box"><div class="chart-stat-label">Portfolio Return</div><div class="chart-stat-value" style="color:'+(totalRet>=0?'var(--success)':'var(--danger)')+';">'+(totalRet*100).toFixed(1)+'%</div></div>';
    if (scenario.spy_ret != null) html += '<div class="chart-stat-box"><div class="chart-stat-label">vs SPY in Crisis</div><div class="chart-stat-value" style="color:'+((totalRet-scenario.spy_ret)>=0?'var(--success)':'var(--danger)')+';">'+((totalRet-scenario.spy_ret)*100).toFixed(1)+'% better/worse</div><div class="chart-stat-sub">SPY: '+(scenario.spy_ret*100).toFixed(0)+'%</div></div>';
    if (worstSector) html += '<div class="chart-stat-box"><div class="chart-stat-label">Worst Sector</div><div class="chart-stat-value" style="color:var(--danger);font-size:14px;">'+worstSector.sector+'</div><div class="chart-stat-sub">'+(worstSector.avgRet*100).toFixed(1)+'% / '+fmt(worstSector.totalImpact)+'</div></div>';
    if (bestSector && bestSector !== worstSector) html += '<div class="chart-stat-box"><div class="chart-stat-label">Best Sector</div><div class="chart-stat-value" style="color:var(--success);font-size:14px;">'+bestSector.sector+'</div><div class="chart-stat-sub">'+(bestSector.avgRet*100).toFixed(1)+'% / '+fmt(bestSector.totalImpact)+'</div></div>';
    html += '</div>';
    // Sector drawdown bar chart
    html += '<div style="margin-top:16px;"><div style="background:var(--navy);color:var(--text-on-dark);padding:6px 12px;font-size:12px;font-weight:700;border-radius:4px 4px 0 0;">Return by Sector During Crisis</div>';
    html += '<div style="height:260px;border:1px solid var(--border);border-top:none;border-radius:0 0 4px 4px;padding:10px;"><canvas id="stressSectorChart"></canvas></div></div>';
    // Per-holding table
    html += '<div style="margin-top:16px;"><div style="background:var(--navy);color:var(--text-on-dark);padding:6px 12px;font-size:12px;font-weight:700;border-radius:4px 4px 0 0;">Per-Holding Impact (Sorted by Worst)</div>';
    html += '<div class="table-wrap" style="border:1px solid var(--border);border-top:none;border-radius:0 0 4px 4px;">';
    html += '<table><thead><tr><th>Ticker</th><th>Account</th><th>Sector</th><th style="text-align:right;">Pre-Crisis</th><th style="text-align:right;">Return</th><th style="text-align:right;">Post-Crisis</th><th style="text-align:right;">Impact ($)</th><th>Source</th></tr></thead><tbody>';
    stressResults.forEach(function(r){
      var retColor = r.ret >= 0 ? C.success : C.danger;
      var levBadge = r.isLeveraged ? ' <span style="font-size:9px;background:rgba(255,165,0,0.2);color:#c47c00;padding:1px 4px;border-radius:3px;font-weight:700;">LEV</span>' : '';
      html += '<tr>';
      html += '<td style="font-weight:700;color:var(--navy);">'+r.ticker+levBadge+'</td>';
      html += '<td style="font-size:11px;">'+r.account+'</td>';
      html += '<td style="font-size:11px;">'+r.sector+'</td>';
      html += '<td style="text-align:right;">'+fmtInt(r.mv)+'</td>';
      html += '<td style="text-align:right;font-weight:700;color:'+retColor+';">'+(r.ret*100).toFixed(1)+'%</td>';
      html += '<td style="text-align:right;">'+fmtInt(r.newMv)+'</td>';
      html += '<td style="text-align:right;font-weight:600;color:'+retColor+';">'+fmt(r.impact)+'</td>';
      html += '<td style="font-size:10px;color:var(--text-sec);">'+r.source+'</td>';
      html += '</tr>';
    });
    html += '</tbody></table></div></div>';
    // Waterfall chart: cumulative impact
    html += '<div style="margin-top:16px;"><div style="background:var(--navy);color:var(--text-on-dark);padding:6px 12px;font-size:12px;font-weight:700;border-radius:4px 4px 0 0;">Cumulative Impact Waterfall</div>';
    html += '<div style="height:300px;border:1px solid var(--border);border-top:none;border-radius:0 0 4px 4px;padding:10px;"><canvas id="stressWaterfallChart"></canvas></div></div>';
    // Bubble grid: holdings sized by MV, colored by return
    html += '<div style="margin-top:16px;"><div style="background:var(--navy);color:var(--text-on-dark);padding:6px 12px;font-size:12px;font-weight:700;border-radius:4px 4px 0 0;">Holdings Impact Bubble View (size = $ exposure)</div>';
    html += '<div style="height:300px;border:1px solid var(--border);border-top:none;border-radius:0 0 4px 4px;padding:10px;"><canvas id="stressBubbleChart"></canvas></div></div>';
    resultsEl.innerHTML = html;
    // Render sector bar chart
    if (window._stressSectorChart) window._stressSectorChart.destroy();
    window._stressSectorChart = new Chart(document.getElementById('stressSectorChart').getContext('2d'), {
      type: 'bar',
      data: {
        labels: sectorResults.map(function(s){ return s.sector; }),
        datasets: [{
          label: 'Avg Return During Crisis',
          data: sectorResults.map(function(s){ return parseFloat((s.avgRet*100).toFixed(2)); }),
          backgroundColor: sectorResults.map(function(s){ return s.avgRet < 0 ? 'rgba(178,34,34,0.72)' : 'rgba(46,125,82,0.72)'; }),
          borderWidth: 0
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false },
          tooltip: Object.assign({}, chartTooltip, { callbacks: {
            label: function(ctx){ return 'Return: '+ctx.parsed.y.toFixed(1)+'%  |  Impact: '+fmt(sectorResults[ctx.dataIndex].totalImpact); }
          }})
        },
        scales: {
          x: { grid: { display: false }, ticks: Object.assign({}, chartTicks, { font: { size: 10 } }) },
          y: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { callback: function(v){ return v+'%'; } }),
            title: { display: true, text: '% Return', font: { size: 11 }, color: C.textSec } }
        }
      }
    });
    // Waterfall chart
    if (window._stressWaterfallChart) window._stressWaterfallChart.destroy();
    var wfCtx = document.getElementById('stressWaterfallChart');
    if (wfCtx) {
      var cumImpact = 0;
      var wfLabels = ['Start'];
      var wfData = [0];
      var wfColors = ['rgba(0,60,113,0.6)'];
      var sortedByImpact = stressResults.slice().sort(function(a,b){ return a.impact-b.impact; });
      sortedByImpact.forEach(function(r) {
        wfLabels.push(r.ticker);
        cumImpact += r.impact;
        wfData.push(parseFloat(cumImpact.toFixed(0)));
        wfColors.push(r.impact>=0?'rgba(46,125,82,0.72)':'rgba(139,42,42,0.72)');
      });
      wfLabels.push('Total');
      wfData.push(parseFloat(totalImpact.toFixed(0)));
      wfColors.push(totalImpact>=0?'rgba(46,125,82,0.85)':'rgba(139,42,42,0.85)');
      window._stressWaterfallChart = new Chart(wfCtx.getContext('2d'), { type:'bar',
        data:{ labels:wfLabels, datasets:[{ label:'Cumulative Impact ($)', data:wfData, backgroundColor:wfColors, borderWidth:0 }] },
        options:{ responsive:true, maintainAspectRatio:false,
          plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:function(c){ return 'Cum. Impact: $'+Math.round(c.parsed.y).toLocaleString(); } } } },
          scales:{ x:{ grid:{display:false}, ticks:{ font:{size:9}, maxRotation:45 } }, y:{ ticks:{ callback:function(v){ return '$'+Math.round(v/1000)+'K'; }, font:{size:10} } } }
        }
      });
    }

    // Bubble chart
    if (window._stressBubbleChart) window._stressBubbleChart.destroy();
    var bbCtx = document.getElementById('stressBubbleChart');
    if (bbCtx) {
      var bubData = stressResults.map(function(r,i) {
        return { x: i, y: r.ret*100, r: Math.max(4, Math.min(30, Math.sqrt(Math.abs(r.mv))/80)) };
      });
      window._stressBubbleChart = new Chart(bbCtx.getContext('2d'), { type:'bubble',
        data:{ datasets:[{ label:'Holdings', data:bubData,
          backgroundColor:stressResults.map(function(r){ return r.ret>=0?'rgba(46,125,82,0.65)':'rgba(139,42,42,0.65)'; }),
          borderColor:stressResults.map(function(r){ return r.ret>=0?'#2E7D52':'#8B2A2A'; }), borderWidth:1 }] },
        options:{ responsive:true, maintainAspectRatio:false,
          plugins:{ legend:{display:false}, tooltip:{ callbacks:{
            label:function(c){ var r=stressResults[c.dataIndex]; return r.ticker+': '+(r.ret*100).toFixed(1)+'% | $'+Math.round(r.mv/1000)+'K exposure | Impact: $'+Math.round(r.impact).toLocaleString(); }
          }}},
          scales:{ x:{ display:false }, y:{ title:{display:true,text:'Return %'}, ticks:{ callback:function(v){ return v+'%'; }, font:{size:10} } } }
        }
      });
    }
  } catch(e) {
    resultsEl.innerHTML = '<div style="padding:20px;color:var(--danger);"><strong>Stress test failed:</strong> '+e.message+'</div>';
  }
  btnEl.disabled = false; btnEl.innerHTML = 'Run Stress Test';
}
window.runStressTest = runStressTest;

// Re-run hook used by the account filter and factor-override controls.
// (These controls previously called stressRerun(), which was never defined —
// clicking Apply/Reset threw a silent ReferenceError. Fixed 2026-07.)
function stressRerun() {
  var resultsEl = document.getElementById('stressResults');
  // Only auto-rerun if a test has already been displayed at least once
  if (resultsEl && resultsEl.dataset.hasRun === '1') { runStressTest(); return; }
  if (resultsEl) resultsEl.dataset.hasRun = '1';
  runStressTest();
}
window.stressRerun = stressRerun;

// ═══════════════════════════════════════════════════════
// ═══════════ PORTFOLIO STATE FRAMEWORK ═════════════════
// ═══════════════════════════════════════════════════════
// Perry 4-state regime classifier tied to user's trading framework

var PS_STATES = [
  {
    key: 'leveraged',
    name: 'Leveraged',
    color: '#2E7D52',
    trigger: 'Major dip + VIX >30 + risk assets drastically discounted',
    instruments: 'TQQQ, FNGU, SOXL, crypto (BTC/ETH via IBIT/ETHA), individual high-beta names',
    cash: '0&ndash;10%',
    posture: 'Aggressive contrarian entry. "Blood in the streets." Size up while fear is priced in.',
    historical: 'Mar 2009 (GFC bottom), Mar 2020 (COVID bottom), Oct 2022 (CPI peak reversal)'
  },
  {
    key: 'growth',
    name: 'Non-Levered Positive Growth',
    color: '#003C71',
    trigger: 'Market healthy, uptrend, VIX 15&ndash;22, no recent rip or crash',
    instruments: 'QQQ, SPY, IWM, DIA, sector ETFs, large-cap growth stocks',
    cash: '10&ndash;30%',
    posture: 'Normal bullish exposure. Ride the trend with 1x unleveraged index exposure. Keep dry powder.',
    historical: '2019 (most of year), 2021 H1, mid-2023 through mid-2024'
  },
  {
    key: 'neutral',
    name: 'Neutral',
    color: '#8B6914',
    trigger: 'Low-growth environment, VIX elevated but not extreme, direction unclear',
    instruments: 'GLD, SLV, non-correlated indexes (EEM, EFA), defensive sectors (XLU, XLP), bonds',
    cash: '30%+',
    posture: 'Brace for low growth. Diversify into real assets and defensives. Stay positioned but cautious.',
    historical: '2015&ndash;2016 (commodity cycle), 2022 H2, late 2011'
  },
  {
    key: 'drawdown',
    name: 'Positioned for Drawdown',
    color: '#8B2A2A',
    trigger: 'SPY/QQQ up 30&ndash;50% in &lt;12mo, approaching Fib projection targets, VIX low/complacent',
    instruments: 'Mostly cash, Treasuries (SHV, TLT), GLD as hedge, maybe inverse ETFs at extremes',
    cash: '70%+',
    posture: 'Wait on the sideline. Markets have run far &mdash; downdraft probability elevated. Preserve capital for next Leveraged entry.',
    historical: 'Late 1999, late 2007, Jan 2022, possibly late 2024/early 2025'
  }
];

// Classifier: given live signals, determine which state the market is in
function psClassifyState(signals) {
  // signals = { vix, spy12mFromLow, spyFromHigh, drawdown12m, spyTrailingReturn }
  var scores = { leveraged: 0, growth: 0, neutral: 0, drawdown: 0 };
  var reasons = { leveraged: [], growth: [], neutral: [], drawdown: [] };

  // VIX signals
  if (signals.vix != null) {
    if (signals.vix >= 30) { scores.leveraged += 3; reasons.leveraged.push('VIX ' + signals.vix.toFixed(1) + ' ≥ 30 (extreme fear)'); }
    else if (signals.vix >= 22) { scores.neutral += 2; reasons.neutral.push('VIX ' + signals.vix.toFixed(1) + ' elevated'); }
    else if (signals.vix <= 14) { scores.drawdown += 2; reasons.drawdown.push('VIX ' + signals.vix.toFixed(1) + ' ≤ 14 (complacent)'); }
    else { scores.growth += 2; reasons.growth.push('VIX ' + signals.vix.toFixed(1) + ' in calm range'); }
  }

  // SPY 12-month trailing return — big rips favor drawdown posture
  if (signals.spyTrailingReturn != null) {
    var ret = signals.spyTrailingReturn * 100;
    if (ret >= 30) { scores.drawdown += 3; reasons.drawdown.push('SPY +' + ret.toFixed(1) + '% in 12mo (extended)'); }
    else if (ret >= 15) { scores.growth += 2; reasons.growth.push('SPY +' + ret.toFixed(1) + '% 12mo trend'); }
    else if (ret <= -15) { scores.leveraged += 3; reasons.leveraged.push('SPY ' + ret.toFixed(1) + '% in 12mo (deep decline)'); }
    else if (ret <= 0) { scores.neutral += 2; reasons.neutral.push('SPY ' + ret.toFixed(1) + '% 12mo (flat/down)'); }
    else { scores.neutral += 1; reasons.neutral.push('SPY ' + ret.toFixed(1) + '% modest gain'); }
  }

  // Drawdown from peak
  if (signals.drawdownFromPeak != null) {
    var dd = signals.drawdownFromPeak * 100;
    if (dd <= -20) { scores.leveraged += 3; reasons.leveraged.push('Down ' + dd.toFixed(1) + '% from 12M high'); }
    else if (dd <= -10) { scores.neutral += 1; reasons.neutral.push('Down ' + dd.toFixed(1) + '% from 12M high'); }
    else if (dd >= -2) { scores.drawdown += 2; reasons.drawdown.push('At or near 12M high (' + dd.toFixed(1) + '%)'); }
  }

  // 12-month return from low — big rips favor drawdown
  if (signals.spy12mFromLow != null) {
    var fromLow = signals.spy12mFromLow * 100;
    if (fromLow >= 50) { scores.drawdown += 3; reasons.drawdown.push('SPY +' + fromLow.toFixed(1) + '% off 12M low (massive rip)'); }
    else if (fromLow >= 30) { scores.drawdown += 2; reasons.drawdown.push('SPY +' + fromLow.toFixed(1) + '% off 12M low'); }
    else if (fromLow >= 15) { scores.growth += 1; reasons.growth.push('SPY +' + fromLow.toFixed(1) + '% off 12M low'); }
  }

  // Determine winner
  var maxScore = 0, winner = 'neutral';
  ['leveraged', 'growth', 'neutral', 'drawdown'].forEach(function(k){
    if (scores[k] > maxScore) { maxScore = scores[k]; winner = k; }
  });
  var totalScore = scores.leveraged + scores.growth + scores.neutral + scores.drawdown;
  var confidence = totalScore > 0 ? (maxScore / totalScore) * 100 : 25;

  return { winner: winner, scores: scores, confidence: confidence, reasons: reasons[winner] };
}

// ═══════════════════════════════════════════════════════════════════
// QUARTERLY MARKET REGIME ENGINE
// Regime can shift at most ONCE per calendar quarter to give the user
// a 3-6 month positioning thesis. Daily classifications still computed,
// but regime locks per-quarter to the dominant classification with
// hysteresis (requires 2/3 of last 3 months agreeing to flip).
// ═══════════════════════════════════════════════════════════════════
function quarterKey(date) {
  var d = (typeof date === 'string') ? new Date(date) : date;
  var y = d.getUTCFullYear();
  var q = Math.floor(d.getUTCMonth() / 3) + 1;
  return y + '-Q' + q;
}
function quarterStartDate(qkey) {
  // qkey like "2026-Q2"
  var parts = qkey.split('-Q');
  var y = parseInt(parts[0]); var q = parseInt(parts[1]);
  var m = (q - 1) * 3; // 0,3,6,9
  return new Date(Date.UTC(y, m, 1));
}
function quarterEndDate(qkey) {
  var parts = qkey.split('-Q');
  var y = parseInt(parts[0]); var q = parseInt(parts[1]);
  var m = (q - 1) * 3 + 3; // last day = day before next quarter starts
  var d = new Date(Date.UTC(y, m, 1));
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
}
function nextQuarterStart(qkey) {
  var end = quarterEndDate(qkey);
  end.setUTCDate(end.getUTCDate() + 1);
  return end;
}
// Classify a series of daily snapshots and aggregate to quarterly regimes.
// dailyStates: array of { date: 'YYYY-MM-DD', classification: { winner, ...} }
// Returns: array of { quarter, startDate, endDate, regime, confidence, dominantPct, prevRegime }
function aggregateQuarterlyRegime(dailyStates) {
  if (!dailyStates || !dailyStates.length) return [];
  // Bucket by quarter
  var buckets = {};
  dailyStates.forEach(function(s){
    var qk = quarterKey(s.date);
    if (!buckets[qk]) buckets[qk] = [];
    buckets[qk].push(s);
  });
  var qkeys = Object.keys(buckets).sort();
  var quarterly = [];
  var lastLockedRegime = null;
  qkeys.forEach(function(qk, idx){
    var arr = buckets[qk];
    // Vote
    var votes = { leveraged: 0, growth: 0, neutral: 0, drawdown: 0 };
    arr.forEach(function(s){ if (s.classification && votes[s.classification.winner] != null) votes[s.classification.winner]++; });
    var winner = 'neutral', mx = 0, total = 0;
    Object.keys(votes).forEach(function(k){ total += votes[k]; if (votes[k] > mx) { mx = votes[k]; winner = k; } });
    var dominantPct = total > 0 ? (mx / total) * 100 : 0;
    // Hysteresis: stay with previous regime unless new dominantPct >= 70%
    // 70% threshold requires ~2 of every 3 trading days in the quarter to
    // classify as the new regime before we commit to the flip. This prevents
    // a sharp 2-week drawdown or a 1-month rip from re-positioning the entire
    // portfolio. Regime changes should reflect durable structural shifts, not
    // daily market noise.
    var lockedRegime = winner;
    if (lastLockedRegime && winner !== lastLockedRegime && dominantPct < 70) {
      // Not strong enough to flip — stay
      lockedRegime = lastLockedRegime;
    }
    // Confidence: avg confidence across days that voted for this regime
    var matchingConfidences = arr.filter(function(s){ return s.classification && s.classification.winner === lockedRegime; })
                                  .map(function(s){ return s.classification.confidence; });
    var avgConf = matchingConfidences.length ? matchingConfidences.reduce(function(a,b){return a+b;},0) / matchingConfidences.length : dominantPct;
    quarterly.push({
      quarter: qk,
      startDate: quarterStartDate(qk),
      endDate: quarterEndDate(qk),
      regime: lockedRegime,
      regimeRaw: winner,         // unsmoothed daily winner (for diagnostics)
      confidence: avgConf,
      dominantPct: dominantPct,
      prevRegime: lastLockedRegime,
      flipped: lastLockedRegime != null && lastLockedRegime !== lockedRegime
    });
    lastLockedRegime = lockedRegime;
  });
  return quarterly;
}
// Predict next regime: fits a transition matrix from quarterly history.
function predictNextRegimeQuarter(quarterly) {
  if (!quarterly || quarterly.length < 4) return null;
  var keys = ['leveraged','growth','neutral','drawdown'];
  // Build transition counts
  var counts = {};
  keys.forEach(function(k){ counts[k] = {}; keys.forEach(function(j){ counts[k][j] = 0; }); });
  for (var i = 1; i < quarterly.length; i++) {
    var from = quarterly[i-1].regime;
    var to = quarterly[i].regime;
    if (counts[from] && counts[from][to] != null) counts[from][to]++;
  }
  var current = quarterly[quarterly.length - 1].regime;
  var row = counts[current] || {};
  var rowTotal = keys.reduce(function(s,k){ return s + (row[k]||0); }, 0);
  if (rowTotal === 0) return { mostLikely: current, probabilities: { leveraged:0.25,growth:0.25,neutral:0.25,drawdown:0.25 }, fallback: true };
  var probs = {};
  keys.forEach(function(k){ probs[k] = (row[k]||0) / rowTotal; });
  // Most likely
  var mxK = current, mxP = -1;
  keys.forEach(function(k){ if (probs[k] > mxP) { mxP = probs[k]; mxK = k; } });
  return { mostLikely: mxK, probabilities: probs, fallback: false };
}
// Build daily classification series from SPY+VIX history. Returns array of { date, classification }.
function buildDailyClassificationHistory(spyPts, vixSeries) {
  // spyPts: [{date, close}], vixSeries: { 'YYYY-MM-DD': vixClose } or null
  if (!spyPts || spyPts.length < 252) return [];
  var out = [];
  for (var i = 252; i < spyPts.length; i++) {
    var window = spyPts.slice(i-252, i+1);
    var closes = window.map(function(p){ return p.close; });
    var hi = Math.max.apply(null, closes);
    var lo = Math.min.apply(null, closes);
    var cur = closes[closes.length-1];
    var start = closes[0];
    var dateStr = spyPts[i].date.slice(0,10);
    var vix = vixSeries ? (vixSeries[dateStr] || null) : null;
    var sig = {
      vix: vix,
      spyCurrent: cur,
      spy12mHigh: hi,
      spy12mLow: lo,
      spyTrailingReturn: (cur - start) / start,
      drawdownFromPeak: (cur - hi) / hi,
      spy12mFromLow: (cur - lo) / lo
    };
    var cl = psClassifyState(sig);
    out.push({ date: dateStr, classification: cl, signals: sig });
  }
  return out;
}
window._quarterlyRegimes = null;
async function loadQuarterlyRegimes() {
  if (window._quarterlyRegimesLoading) return window._quarterlyRegimesLoading;
  window._quarterlyRegimesLoading = (async function(){
    var WORKER = "https://perry-finance-proxy.zachperrybusiness.workers.dev";
    try {
      var spyData = await fetch(WORKER + "/chart?symbol=SPY&range=10y&interval=1d").then(function(r){ return r.json(); });
      var vixData = await fetch(WORKER + "/chart?symbol=%5EVIX&range=10y&interval=1d").then(function(r){ return r.json(); }).catch(function(){ return null; });
      var spyPts = (spyData.points || []).filter(function(p){ return p.close != null; });
      var vixSeries = {};
      if (vixData && vixData.points) {
        vixData.points.forEach(function(p){ if (p.close != null) vixSeries[p.date.slice(0,10)] = p.close; });
      }
      var daily = buildDailyClassificationHistory(spyPts, vixSeries);
      var quarterly = aggregateQuarterlyRegime(daily);
      var prediction = predictNextRegimeQuarter(quarterly);
      window._quarterlyRegimes = { quarterly: quarterly, daily: daily, prediction: prediction, spyPts: spyPts };
      return window._quarterlyRegimes;
    } catch(e) {
      console.warn('[loadQuarterlyRegimes] failed:', e);
      return null;
    }
  })();
  return window._quarterlyRegimesLoading;
}
function getCurrentQuarterRegime() {
  if (!window._quarterlyRegimes || !window._quarterlyRegimes.quarterly.length) return null;
  return window._quarterlyRegimes.quarterly[window._quarterlyRegimes.quarterly.length - 1];
}

async function psLoadDiagnostic() {
  var el = document.getElementById('psDiagnostic');
  if (!el) return;
  el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-sec);"><span class="spinner"></span> Analyzing current market state...</div>';
  try {
    var WORKER = "https://perry-finance-proxy.zachperrybusiness.workers.dev";
    // Parallel fetch: SPY 1y daily, VIX quote
    var results = await Promise.all([
      fetch(WORKER + "/chart?symbol=SPY&range=1y&interval=1d").then(function(r){ return r.json(); }),
      fetch(WORKER + "/quote?symbol=%5EVIX").then(function(r){ return r.json(); }),
      fetch(WORKER + "/chart?symbol=QQQ&range=1y&interval=1d").then(function(r){ return r.json(); })
    ]);
    var spyData = results[0];
    var vixQuote = results[1];
    var qqqData = results[2];
    var spyPts = (spyData.points || []).filter(function(p){ return p.close != null; });
    var qqqPts = (qqqData.points || []).filter(function(p){ return p.close != null; });
    if (!spyPts.length) throw new Error('No SPY data returned from Worker');

    var spyClose = spyPts.map(function(p){ return p.close; });
    var spy12mHigh = Math.max.apply(null, spyClose);
    var spy12mLow = Math.min.apply(null, spyClose);
    var spyCurrent = spyClose[spyClose.length - 1];
    var spyStart = spyClose[0];
    var spyTrailingReturn = (spyCurrent - spyStart) / spyStart;
    var spyFromHigh = (spyCurrent - spy12mHigh) / spy12mHigh;
    var spy12mFromLow = (spyCurrent - spy12mLow) / spy12mLow;

    var vix = vixQuote.current || vixQuote.price || null;

    var signals = {
      vix: vix,
      spyCurrent: spyCurrent,
      spy12mHigh: spy12mHigh,
      spy12mLow: spy12mLow,
      spyTrailingReturn: spyTrailingReturn,
      drawdownFromPeak: spyFromHigh,
      spy12mFromLow: spy12mFromLow
    };
    var classification = psClassifyState(signals);

    // ─── QUARTERLY LOCK ───
    // Load (or get cached) quarterly regime history. The displayed regime is the
    // locked-quarter regime, NOT the live daily classification.
    var quarterlyData = await loadQuarterlyRegimes();
    var currentQuarter = getCurrentQuarterRegime();
    var lockedRegimeKey = currentQuarter ? currentQuarter.regime : classification.winner;
    var state = PS_STATES.find(function(s){ return s.key === lockedRegimeKey; }) || PS_STATES[1];

    // Find when current locked regime actually began (walk back through quarters)
    var regimeStartDate = currentQuarter ? currentQuarter.startDate : null;
    if (quarterlyData && quarterlyData.quarterly && quarterlyData.quarterly.length) {
      var qs = quarterlyData.quarterly;
      for (var i = qs.length - 1; i >= 0; i--) {
        if (qs[i].regime === lockedRegimeKey) regimeStartDate = qs[i].startDate;
        else break;
      }
    }
    var nextQuarter = currentQuarter ? nextQuarterStart(currentQuarter.quarter) : null;
    var daysToNext = nextQuarter ? Math.max(0, Math.ceil((nextQuarter - new Date()) / 86400000)) : null;
    var prediction = quarterlyData && quarterlyData.prediction ? quarterlyData.prediction : null;
    var predictedState = prediction ? PS_STATES.find(function(s){ return s.key === prediction.mostLikely; }) : null;

    // Render diagnostic hero — quarterly-locked regime
    var html = '<div class="ps-diagnostic-hero" style="background:'+state.color+';">';
    html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;">';
    html += '<div style="flex:1;min-width:260px;">';
    html += '<div style="font-size:11px;opacity:0.85;text-transform:uppercase;letter-spacing:.6px;">Current Market Regime &middot; Quarterly-Locked</div>';
    html += '<div class="ps-diag-state-name">' + state.name + '</div>';
    if (regimeStartDate) {
      var startStr = regimeStartDate.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric', timeZone:'UTC' });
      var monthsHeld = currentQuarter ? Math.max(1, Math.round((new Date() - regimeStartDate) / (30*86400000))) : 0;
      html += '<div style="font-size:12px;opacity:0.9;margin-top:4px;">Regime started <strong>'+startStr+'</strong> &middot; '+monthsHeld+' month'+(monthsHeld===1?'':'s')+' active</div>';
    }
    html += '<div class="ps-diag-confidence" style="margin-top:6px;">Quarter confidence: ' + (currentQuarter ? currentQuarter.confidence.toFixed(0) : classification.confidence.toFixed(0)) + '% &middot; Daily signal: ' + (PS_STATES.find(function(s){return s.key===classification.winner;}) || {name:'?'}).name + '</div>';
    html += '</div>';
    html += '<div style="background:rgba(0,0,0,0.18);padding:10px 14px;border-radius:6px;min-width:200px;text-align:center;">';
    html += '<div style="font-size:10px;opacity:0.85;text-transform:uppercase;letter-spacing:.6px;">Next Possible Shift</div>';
    if (nextQuarter && daysToNext != null) {
      var nextStr = nextQuarter.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric', timeZone:'UTC' });
      html += '<div style="font-size:18px;font-weight:700;margin:4px 0;">'+nextStr+'</div>';
      html += '<div style="font-size:11px;opacity:0.85;">'+daysToNext+' days &middot; ' + quarterKey(nextQuarter) + '</div>';
    }
    if (predictedState) {
      var probPct = (prediction.probabilities[prediction.mostLikely] * 100).toFixed(0);
      html += '<div style="font-size:10px;opacity:0.85;margin-top:8px;text-transform:uppercase;letter-spacing:.4px;">Most Likely Next Regime</div>';
      html += '<div style="font-size:13px;font-weight:700;">'+predictedState.name+' &middot; '+probPct+'%</div>';
    }
    html += '</div>';
    html += '</div>';
    html += '<div class="ps-diag-signals">';
    html += '<div class="ps-diag-signal"><div class="ps-diag-signal-label">VIX</div><div class="ps-diag-signal-value">' + (vix != null ? vix.toFixed(1) : '—') + '</div><div class="ps-diag-signal-detail">' + (vix == null ? '' : (vix >= 30 ? 'Extreme fear' : vix >= 22 ? 'Elevated' : vix >= 15 ? 'Normal' : 'Complacent')) + '</div></div>';
    html += '<div class="ps-diag-signal"><div class="ps-diag-signal-label">SPY Current</div><div class="ps-diag-signal-value">$' + spyCurrent.toFixed(2) + '</div><div class="ps-diag-signal-detail">52W High: $' + spy12mHigh.toFixed(2) + '</div></div>';
    html += '<div class="ps-diag-signal"><div class="ps-diag-signal-label">SPY 12M Return</div><div class="ps-diag-signal-value">' + (spyTrailingReturn >= 0 ? '+' : '') + (spyTrailingReturn*100).toFixed(1) + '%</div><div class="ps-diag-signal-detail">' + (spyTrailingReturn >= 0.3 ? 'Extended rally' : spyTrailingReturn >= 0.15 ? 'Healthy trend' : spyTrailingReturn >= 0 ? 'Modest gain' : spyTrailingReturn >= -0.15 ? 'Flat/down' : 'Deep decline') + '</div></div>';
    html += '<div class="ps-diag-signal"><div class="ps-diag-signal-label">From 12M High</div><div class="ps-diag-signal-value">' + (spyFromHigh*100).toFixed(1) + '%</div><div class="ps-diag-signal-detail">' + (spyFromHigh >= -0.02 ? 'At/near peak' : spyFromHigh >= -0.1 ? 'Minor pullback' : spyFromHigh >= -0.2 ? 'Correction' : 'Bear market') + '</div></div>';
    html += '<div class="ps-diag-signal"><div class="ps-diag-signal-label">From 12M Low</div><div class="ps-diag-signal-value">+' + (spy12mFromLow*100).toFixed(1) + '%</div><div class="ps-diag-signal-detail">' + (spy12mFromLow >= 0.5 ? 'Massive rip' : spy12mFromLow >= 0.3 ? 'Strong rally' : 'Recovery') + '</div></div>';
    html += '</div>';
    html += '<div class="ps-diag-posture"><strong>Recommended Posture (3–6 month view):</strong> ' + state.posture + '<br><strong>Cash:</strong> ' + state.cash + ' &middot; <strong>Instruments:</strong> ' + state.instruments + '</div>';
    html += '</div>';

    // Quarterly history strip (last 8 quarters)
    if (quarterlyData && quarterlyData.quarterly && quarterlyData.quarterly.length) {
      var recent = quarterlyData.quarterly.slice(-8);
      html += '<div style="margin-top:14px;padding:14px 18px;background:var(--panel);border:1px solid var(--border);border-radius:6px;">';
      html += '<div style="font-size:11px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">Quarterly Regime History &middot; Last 2 Years</div>';
      html += '<div style="display:flex;gap:6px;align-items:stretch;flex-wrap:wrap;">';
      recent.forEach(function(q){
        var s = PS_STATES.find(function(x){ return x.key === q.regime; }) || { color: '#888', name: '?' };
        var isCur = q === currentQuarter;
        html += '<div style="flex:1;min-width:80px;background:'+s.color+';color:#fff;padding:8px 10px;border-radius:4px;'+(isCur?'box-shadow:0 0 0 2px var(--blue),0 2px 6px rgba(0,0,0,0.15);':'')+'">';
        html += '<div style="font-size:10px;font-weight:700;letter-spacing:.4px;opacity:0.9;">'+q.quarter+(isCur?' (NOW)':(q.flipped?' ⟲':''))+'</div>';
        html += '<div style="font-size:11px;font-weight:700;margin-top:2px;">'+s.name+'</div>';
        html += '<div style="font-size:9.5px;opacity:0.85;margin-top:2px;">'+q.confidence.toFixed(0)+'% conf.</div>';
        html += '</div>';
      });
      html += '</div>';
      html += '<p style="font-size:10.5px;color:var(--text-sec);margin-top:10px;line-height:1.5;">Regime is locked per quarter to provide a stable 3–6 month positioning thesis. Hysteresis rule: requires <strong>≥70% daily classification dominance</strong> to flip vs. previous quarter\'s regime, A sharp 4–6 week drawdown or rip is insufficient — the new regime must dominate for the majority of the quarter. Symbols: <strong>⟲</strong> = regime flipped from prior quarter.</p>';
      html += '</div>';
    }

    el.innerHTML = html;

    // Update the framework grid to highlight the locked-quarter state (not raw daily)
    psRenderFrameworkGrid(lockedRegimeKey);

    // Stash the locked regime for downstream consumers (briefing, holdings table)
    window._briefingState = lockedRegimeKey;
  } catch(e) {
    console.error('[psLoadDiagnostic]', e);
    el.innerHTML = '<div style="padding:20px;color:var(--danger);"><strong>Failed to load diagnostic:</strong> ' + e.message + '<br><button class="btn btn-sm" style="margin-top:8px;" onclick="psLoadDiagnostic()">Retry</button></div>';
  }
}

function psRenderFrameworkGrid(activeKey) {
  var grid = document.getElementById('psFrameworkGrid');
  if (!grid) return;
  var html = '';
  PS_STATES.forEach(function(s){
    var isActive = s.key === activeKey;
    html += '<div class="ps-state-card' + (isActive ? ' active' : '') + '">';
    html += '<div class="ps-state-header" style="background:'+s.color+';">';
    html += s.name;
    if (isActive) html += '<span class="ps-state-active-pill">CURRENT</span>';
    html += '</div>';
    html += '<div class="ps-state-body">';
    html += '<div class="ps-state-row"><span class="ps-state-label">Trigger:</span><span class="ps-state-value">'+s.trigger+'</span></div>';
    html += '<div class="ps-state-row"><span class="ps-state-label">Assets:</span><span class="ps-state-value">'+s.instruments+'</span></div>';
    html += '<div class="ps-state-row"><span class="ps-state-label">Cash %:</span><span class="ps-state-value">'+s.cash+'</span></div>';
    html += '<div class="ps-state-row"><span class="ps-state-label">Posture:</span><span class="ps-state-value">'+s.posture+'</span></div>';
    html += '<div class="ps-state-row"><span class="ps-state-label">Examples:</span><span class="ps-state-value" style="color:var(--text-sec);font-style:italic;">'+s.historical+'</span></div>';
    html += '</div>';
    html += '</div>';
  });
  grid.innerHTML = html;
}

// ═══ FIBONACCI PROJECTION ═══
async function psLoadFib() {
  var emptyEl = document.getElementById('psFibEmpty');
  var statsEl = document.getElementById('psFibStats');
  var wrapEl = document.getElementById('psFibWrap');
  if (!emptyEl) return;
  emptyEl.style.display = 'block';
  emptyEl.innerHTML = '<span class="spinner"></span> Loading QQQ data and computing swing extrema...';
  statsEl.style.display = 'none';
  wrapEl.style.display = 'none';
  try {
    var lookback = parseInt(document.getElementById('psFibLookback').value, 10);
    var direction = document.getElementById('psFibDir').value;
    // Decide range based on lookback
    var range = lookback <= 126 ? '6mo' : lookback <= 252 ? '1y' : lookback <= 504 ? '2y' : '5y';
    var WORKER = "https://perry-finance-proxy.zachperrybusiness.workers.dev";
    var res = await fetch(WORKER + "/chart?symbol=QQQ&range=" + range + "&interval=1d");
    var data = await res.json();
    var pts = (data.points || []).filter(function(p){ return p.close != null; });
    if (pts.length < 20) throw new Error('Insufficient QQQ data');

    // Truncate to lookback window if we fetched more
    if (pts.length > lookback) pts = pts.slice(-lookback);
    var closes = pts.map(function(p){ return p.close; });
    var dates = pts.map(function(p){ return p.date.slice(0,10); });

    // ── Proper swing detection ──────────────────────────────────────────────
    // Goal: find the MOST RECENT meaningful swing high and the MOST RECENT
    // meaningful swing low, then orient the Fibonacci from the earlier one
    // to the later one (the "most recent completed swing").
    //
    // Algorithm: scan for local extrema using a larger window (15-day pivot)
    // to filter out noise, then pick the most recent high and low from
    // those pivots. If both exist, orient by whichever is more recent.
    // This correctly identifies e.g. QQQ: low 4/8/2025 ~$416, high 1/12/2026 ~$627.

    var PIVOT_WIN = 15; // 15-day window each side for a "significant" pivot
    var pivotHighs = []; // { idx, value, date }
    var pivotLows  = [];

    for (var pi = PIVOT_WIN; pi < closes.length - PIVOT_WIN; pi++) {
      var isHigh = true, isLow = true;
      for (var pj = pi - PIVOT_WIN; pj <= pi + PIVOT_WIN; pj++) {
        if (pj === pi) continue;
        if (closes[pj] >= closes[pi]) isHigh = false;
        if (closes[pj] <= closes[pi]) isLow  = false;
        if (!isHigh && !isLow) break;
      }
      if (isHigh) pivotHighs.push({ idx: pi, value: closes[pi], date: dates[pi] });
      if (isLow)  pivotLows.push({ idx: pi, value: closes[pi], date: dates[pi] });
    }

    // If too few pivots found (tight window), fall back to 5-day window
    if (pivotHighs.length < 1 || pivotLows.length < 1) {
      var FW = 5;
      for (var fi = FW; fi < closes.length - FW; fi++) {
        var fh = true, fl = true;
        for (var fj = fi - FW; fj <= fi + FW; fj++) {
          if (fj === fi) continue;
          if (closes[fj] >= closes[fi]) fh = false;
          if (closes[fj] <= closes[fi]) fl = false;
        }
        if (fh && !pivotHighs.find(function(p){ return p.idx === fi; })) pivotHighs.push({ idx: fi, value: closes[fi], date: dates[fi] });
        if (fl && !pivotLows.find(function(p){ return p.idx === fi; }))  pivotLows.push({ idx: fi, value: closes[fi], date: dates[fi] });
      }
    }

    // Most recent pivot high and low
    var swingHigh = pivotHighs.length ? pivotHighs[pivotHighs.length - 1] : { idx: 0, value: Math.max.apply(null, closes), date: dates[closes.indexOf(Math.max.apply(null,closes))] };
    var swingLow  = pivotLows.length  ? pivotLows[pivotLows.length - 1]   : { idx: 0, value: Math.min.apply(null, closes), date: dates[closes.indexOf(Math.min.apply(null,closes))] };

    // If direction is auto, orient from whichever pivot came FIRST to whichever came LAST
    // i.e. the "most recent completed move"
    var bullish;
    if (direction === 'bull') bullish = true;
    else if (direction === 'bear') bullish = false;
    else {
      // Find the most recent of (last pivot high, last pivot low)
      // The more recent pivot is the END of the move; the earlier is START
      bullish = swingLow.idx < swingHigh.idx; // low came first → upward move
    }

    var start, end;
    if (bullish) { start = swingLow; end = swingHigh; }
    else { start = swingHigh; end = swingLow; }

    // Fib levels. Retracements based on [start, end] range; projections extend beyond end.
    var range_px = end.value - start.value; // positive if bullish
    var fibLevels = [
      { label: '0%', pct: 0, style: 'solid' },
      { label: '23.6%', pct: 0.236, style: 'dashed' },
      { label: '38.2%', pct: 0.382, style: 'dashed' },
      { label: '50%', pct: 0.50, style: 'solid', weight: 'key' },
      { label: '61.8% (golden)', pct: 0.618, style: 'solid', weight: 'key' },
      { label: '78.6%', pct: 0.786, style: 'dashed' },
      { label: '100%', pct: 1.0, style: 'solid' },
      { label: '127.2% (proj)', pct: 1.272, style: 'dashed', projection: true },
      { label: '161.8% (golden proj)', pct: 1.618, style: 'solid', weight: 'key', projection: true },
      { label: '261.8% (ext proj)', pct: 2.618, style: 'dashed', projection: true }
    ];
    var fibPrices = fibLevels.map(function(fl){
      var price = start.value + range_px * fl.pct;
      return { label: fl.label, price: price, pct: fl.pct, style: fl.style, key: fl.weight === 'key', projection: !!fl.projection };
    });

    var current = closes[closes.length - 1];
    // Determine which zone current price is in
    var zone = null;
    for (var z=0; z<fibPrices.length-1; z++) {
      var lo = Math.min(fibPrices[z].price, fibPrices[z+1].price);
      var hi = Math.max(fibPrices[z].price, fibPrices[z+1].price);
      if (current >= lo && current <= hi) { zone = fibPrices[z].label + ' ↔ ' + fibPrices[z+1].label; break; }
    }

    // Build chart datasets
    var datasets = [
      { label: 'QQQ', data: closes, borderColor: C.navy, borderWidth: 2, pointRadius: 0, fill: false, tension: 0.05 }
    ];
    // Highlight swing points
    datasets.push({
      label: 'Swing Low',
      data: dates.map(function(_,i){ return i === start.idx && bullish ? start.value : (i === end.idx && !bullish ? end.value : null); }),
      borderColor: 'transparent', backgroundColor: C.success, pointRadius: 8, pointStyle: 'triangle', showLine: false, pointBorderColor: '#000', pointBorderWidth: 1.5
    });
    datasets.push({
      label: 'Swing High',
      data: dates.map(function(_,i){ return i === end.idx && bullish ? end.value : (i === start.idx && !bullish ? start.value : null); }),
      borderColor: 'transparent', backgroundColor: C.danger, pointRadius: 8, pointStyle: 'rectRot', showLine: false, pointBorderColor: '#000', pointBorderWidth: 1.5
    });
    // Add each fib level as a horizontal line dataset
    var levelColors = ['#8B2A2A','#8B6914','#5B9BD5','#003C71','#003C71','#5B9BD5','#8B6914','#2E7D52','#2E7D52','#2E7D52'];
    fibPrices.forEach(function(fp, idx){
      datasets.push({
        label: fp.label + ' ($' + fp.price.toFixed(2) + ')',
        data: dates.map(function(){ return fp.price; }),
        borderColor: levelColors[idx] || C.textSec,
        borderWidth: fp.key ? 1.5 : 1,
        borderDash: fp.style === 'dashed' ? [4, 3] : [],
        pointRadius: 0,
        fill: false,
        tension: 0
      });
    });

    // Render
    emptyEl.style.display = 'none';
    statsEl.style.display = 'flex';
    wrapEl.style.display = 'block';
    var change = ((current - start.value) / start.value) * 100;
    statsEl.innerHTML = ''
      + '<div class="chart-stat-box"><div class="chart-stat-label">Swing Low</div><div class="chart-stat-value">$'+start.value.toFixed(2)+'</div><div class="chart-stat-sub">'+dates[start.idx]+'</div></div>'
      + '<div class="chart-stat-box"><div class="chart-stat-label">Swing High</div><div class="chart-stat-value">$'+end.value.toFixed(2)+'</div><div class="chart-stat-sub">'+dates[end.idx]+'</div></div>'
      + '<div class="chart-stat-box"><div class="chart-stat-label">Current</div><div class="chart-stat-value">$'+current.toFixed(2)+'</div><div class="chart-stat-sub">'+(change>=0?'+':'')+change.toFixed(1)+'% from swing'+(bullish?' low':' high')+'</div></div>'
      + '<div class="chart-stat-box"><div class="chart-stat-label">Current Zone</div><div class="chart-stat-value" style="font-size:13px;">'+(zone||'Beyond levels')+'</div><div class="chart-stat-sub">Between Fib levels</div></div>'
      + '<div class="chart-stat-box"><div class="chart-stat-label">Trend Direction</div><div class="chart-stat-value" style="color:'+(bullish?C.success:C.danger)+';">'+(bullish?'UP (low → high)':'DOWN (high → low)')+'</div></div>';

    if (window._psFibChart) window._psFibChart.destroy();
    window._psFibChart = new Chart(document.getElementById('psFibChart').getContext('2d'), {
      type: 'line',
      data: { labels: dates, datasets: datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'nearest', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 10 }, color: C.textSec, boxWidth: 10, filter: function(it){ return it.text.indexOf('%') >= 0 || it.text === 'QQQ' || it.text.indexOf('Swing') === 0; } } },
          tooltip: chartTooltip
        },
        scales: {
          x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { maxTicksLimit: 10, autoSkip: true }) },
          y: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { callback: function(v){ return '$'+v.toFixed(0); } }) }
        }
      }
    });
  } catch(e) {
    console.error('[psLoadFib]', e);
    emptyEl.style.display = 'block';
    emptyEl.innerHTML = '<div style="color:var(--danger);">Failed: '+e.message+' <button class="btn btn-sm" onclick="psLoadFib()" style="margin-left:8px;">Retry</button></div>';
  }
}

// ═══════════════════════════════════════════════════════
// ═══════════════════ MARKETS PAGE ══════════════════════
// ═══════════════════════════════════════════════════════
// All functions prefixed "mkt" to avoid namespace collisions.

var MKT_UNIVERSE = {
  'SPDR Sectors': ['XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLB','XLU','XLRE','XLC'],
  'Real Assets': ['GLD','SLV','VNQ','USO'],
  'Fixed Income': ['TLT','IEF','HYG','LQD','TIP'],
  'Crypto Proxies': ['IBIT','ETHA'],
  'International': ['EEM','EFA','VGK']
};
var MKT_DEFAULT = ['SPY','XLK','XLF','XLE','GLD','TLT','HYG'];
var MKT_STATE = {
  selected: [],
  dataByTicker: {},       // ticker -> array of {date, close}
  alignedDates: [],       // common date array after alignment
  aligned: {},            // ticker -> close[] aligned to alignedDates
  logRetMatrix: null,     // aligned log returns array[T][N]
  primary: 'SPY',
  corrWindow: 63,
  corrHover: { row: -1, col: -1 }
};
var MKT_CHARTS = {};
var MKT_THREE = { renderer: null, scene: null, camera: null, animId: null, mesh: null, sprites: [], width: 0, height: 0 };

// ═══ MODULE BLACK-BOX: INIT ═══
function mktInit() {
  // Set end date to today
  var today = new Date();
  var yyyy = today.getFullYear();
  var mm = String(today.getMonth()+1).padStart(2,'0');
  var dd = String(today.getDate()).padStart(2,'0');
  document.getElementById('mktEndDate').value = yyyy+'-'+mm+'-'+dd;
  mktBuildUniverseGrid();
  mktPreset('default');
  // bind rolling-window buttons for Module 2
  var winBtns = document.querySelectorAll('#page-markets [data-mktwin]');
  for (var i=0; i<winBtns.length; i++) {
    (function(b){
      b.onclick = function(){
        var all = document.querySelectorAll('#page-markets [data-mktwin]');
        for (var j=0;j<all.length;j++) all[j].classList.remove('active');
        b.classList.add('active');
        MKT_STATE.corrWindow = parseInt(b.getAttribute('data-mktwin'),10);
        mktRenderCorrelation();
      };
    })(winBtns[i]);
  }
}

function mktBuildUniverseGrid() {
  var grid = document.getElementById('mktUniverseGrid');
  var html = '';
  // Include SPY at top (for benchmark/beta)
  var all = ['SPY'];
  for (var g in MKT_UNIVERSE) { for (var i=0;i<MKT_UNIVERSE[g].length;i++) all.push(MKT_UNIVERSE[g][i]); }
  // De-dup
  var seen = {}; var uniq = [];
  for (var k=0;k<all.length;k++) { if (!seen[all[k]]) { seen[all[k]]=1; uniq.push(all[k]); } }
  for (var i2=0; i2<uniq.length; i2++) {
    var t = uniq[i2];
    html += '<label style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--panel);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:12px;">'
         + '<input type="checkbox" class="mkt-uni-chk" value="'+t+'" style="cursor:pointer;"> '
         + '<span>'+t+'</span></label>';
  }
  grid.innerHTML = html;
  // Populate primary dropdown
  var sel = document.getElementById('mktPrimary');
  sel.innerHTML = uniq.map(function(t){ return '<option value="'+t+'">'+t+'</option>'; }).join('');
  sel.value = 'SPY';
  // Change handler for checkboxes
  var chks = document.querySelectorAll('.mkt-uni-chk');
  for (var c=0;c<chks.length;c++) {
    chks[c].onchange = function(){ mktSyncSelection(); };
  }
}

function mktSyncSelection() {
  var chks = document.querySelectorAll('.mkt-uni-chk');
  var selected = [];
  for (var i=0;i<chks.length;i++) if (chks[i].checked) selected.push(chks[i].value);
  MKT_STATE.selected = selected;
  // Update primary dropdown to be restricted to selected if any
  var sel = document.getElementById('mktPrimary');
  if (selected.length) {
    sel.innerHTML = selected.map(function(t){ return '<option value="'+t+'">'+t+'</option>'; }).join('');
    if (selected.indexOf(MKT_STATE.primary) >= 0) sel.value = MKT_STATE.primary;
    else { sel.value = selected[0]; MKT_STATE.primary = selected[0]; }
  }
}

function mktPreset(which) {
  var chks = document.querySelectorAll('.mkt-uni-chk');
  var set = [];
  if (which === 'sectors') set = MKT_UNIVERSE['SPDR Sectors'].slice();
  else if (which === 'realassets') set = MKT_UNIVERSE['Real Assets'].slice();
  else if (which === 'fixedincome') set = MKT_UNIVERSE['Fixed Income'].slice();
  else if (which === 'international') set = MKT_UNIVERSE['International'].slice();
  else if (which === 'default') set = MKT_DEFAULT.slice();
  else if (which === 'none') set = [];
  var setMap = {}; for (var i=0;i<set.length;i++) setMap[set[i]]=1;
  for (var j=0;j<chks.length;j++) chks[j].checked = !!setMap[chks[j].value];
  mktSyncSelection();
}

// ═══ CORE: LOAD ALL ═══
function mktSetStatus(msg, kind) {
  var el = document.getElementById('mktStatus');
  var color = kind === 'err' ? 'var(--danger)' : (kind === 'ok' ? 'var(--success)' : 'var(--text-sec)');
  el.innerHTML = '<span style="color:'+color+';">'+msg+'</span>';
}

async function mktLoadAll() {
  mktSyncSelection();
  MKT_STATE.primary = document.getElementById('mktPrimary').value;
  var tickers = MKT_STATE.selected.slice();
  // Ensure SPY in list for beta module
  if (tickers.indexOf('SPY') < 0) tickers.push('SPY');
  if (tickers.length < 2) { mktSetStatus('Select at least 1 asset (SPY auto-added for benchmark).', 'err'); return; }
  var btn = document.getElementById('mktLoadBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Fetching ' + tickers.length + '...';
  mktSetStatus('<span class="spinner"></span> Fetching ' + tickers.length + ' tickers via Cloudflare Worker...', 'info');
  var data = {};
  var errors = [];
  for (var i=0;i<tickers.length;i++) {
    try {
      var d = await fetchChart(tickers[i], '5y', '1d');
      var pts = (d.points || []).filter(function(p){ return p.close != null; });
      data[tickers[i]] = pts.map(function(p){ return { date: p.date.slice(0,10), close: p.close }; });
    } catch(e) {
      errors.push(tickers[i]+': '+e.message);
    }
  }
  MKT_STATE.dataByTicker = data;
  // Filter to user's date window
  var start = document.getElementById('mktStartDate').value;
  var end = document.getElementById('mktEndDate').value;
  mktAlignData(start, end);
  btn.disabled = false; btn.innerHTML = 'Load / Refresh All Modules';
  if (errors.length) mktSetStatus('Loaded with errors: ' + errors.join('; '), 'err');
  else mktSetStatus('Loaded ' + Object.keys(data).length + ' tickers, ' + MKT_STATE.alignedDates.length + ' aligned dates.', 'ok');
  window._mktLoadedAt = new Date();
  if (typeof mktUpdateStatusBar === 'function') mktUpdateStatusBar();
  // Render all
  try { mktRenderRebased(); } catch(e) { console.error('Rebased:', e); }
  try { mktRenderCorrelation(); } catch(e) { console.error('Corr:', e); }
  try { mktRenderVolSurface(); } catch(e) { console.error('Vol:', e); }
  try { mktRenderFrontier(); } catch(e) { console.error('Eff Frontier:', e); }
  try { mktRenderRolling(); } catch(e) { console.error('Rolling:', e); }
  try { mktRenderVaR(); } catch(e) { console.error('VaR:', e); }
  // Module 4 (Cox) is on-demand via its own button
  document.getElementById('mktCoxEmpty').innerHTML = 'Primary asset: <strong>'+MKT_STATE.primary+'</strong>. Adjust parameters and click <strong>Run Simulation</strong>.';
}

function mktAlignData(startDate, endDate) {
  var tickers = Object.keys(MKT_STATE.dataByTicker);
  if (!tickers.length) { MKT_STATE.alignedDates = []; MKT_STATE.aligned = {}; return; }
  // Build date->close maps and filter by range
  var maps = {};
  var commonDates = null;
  for (var i=0;i<tickers.length;i++) {
    var t = tickers[i];
    var pts = MKT_STATE.dataByTicker[t];
    var m = {};
    for (var j=0;j<pts.length;j++) {
      var dt = pts[j].date;
      if ((!startDate || dt >= startDate) && (!endDate || dt <= endDate)) m[dt] = pts[j].close;
    }
    maps[t] = m;
    var keys = Object.keys(m);
    if (commonDates === null) commonDates = keys.slice();
    else {
      var cmap = {}; for (var k=0;k<keys.length;k++) cmap[keys[k]]=1;
      commonDates = commonDates.filter(function(d){ return cmap[d]; });
    }
  }
  commonDates.sort();
  var aligned = {};
  for (var p=0;p<tickers.length;p++) {
    var tt = tickers[p];
    aligned[tt] = commonDates.map(function(d){ return maps[tt][d]; });
  }
  MKT_STATE.alignedDates = commonDates;
  MKT_STATE.aligned = aligned;
  // Build log return matrix (exclude SPY from universe analytics unless user selected)
  var T = commonDates.length;
  if (T < 2) { MKT_STATE.logRetMatrix = null; return; }
  var matrix = { tickers: [], returns: [] };
  for (var q=0;q<tickers.length;q++) matrix.tickers.push(tickers[q]);
  var ret = [];
  for (var r=1;r<T;r++) {
    var row = [];
    for (var s=0;s<matrix.tickers.length;s++) {
      var prev = aligned[matrix.tickers[s]][r-1];
      var cur = aligned[matrix.tickers[s]][r];
      row.push(Math.log(cur / prev));
    }
    ret.push(row);
  }
  matrix.returns = ret;
  MKT_STATE.logRetMatrix = matrix;
}

// ═══ STATISTICAL HELPERS ═══
function mktMean(a){ var s=0; for (var i=0;i<a.length;i++) s+=a[i]; return a.length ? s/a.length : 0; }
function mktStd(a){ var m=mktMean(a); var s=0; for (var i=0;i<a.length;i++) s+=(a[i]-m)*(a[i]-m); return a.length>1 ? Math.sqrt(s/(a.length-1)) : 0; }
function mktPearson(x,y) {
  var n = Math.min(x.length,y.length); if (n<2) return 0;
  var mx = mktMean(x), my = mktMean(y);
  var num=0, dx=0, dy=0;
  for (var i=0;i<n;i++) { var xd=x[i]-mx, yd=y[i]-my; num += xd*yd; dx += xd*xd; dy += yd*yd; }
  var den = Math.sqrt(dx*dy);
  return den > 0 ? num/den : 0;
}
function mktSkew(a){ var m=mktMean(a), n=a.length, s=mktStd(a); if (n<3||s===0) return 0; var sum=0; for (var i=0;i<n;i++) sum += Math.pow((a[i]-m)/s, 3); return (n/((n-1)*(n-2))) * sum; }
function mktKurt(a){ var m=mktMean(a), n=a.length, s=mktStd(a); if (n<4||s===0) return 0; var sum=0; for (var i=0;i<n;i++) sum += Math.pow((a[i]-m)/s, 4); var ekurt = ((n*(n+1))/((n-1)*(n-2)*(n-3))) * sum - (3*(n-1)*(n-1))/((n-2)*(n-3)); return ekurt; }
function mktPercentile(arr, p) {
  var s = arr.slice().sort(function(a,b){return a-b;});
  var idx = (p/100) * (s.length-1);
  var lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi]-s[lo])*(idx-lo);
}
function mktBoxMuller(){
  var u1 = Math.random(), u2 = Math.random();
  while (u1 === 0) u1 = Math.random();
  return Math.sqrt(-2*Math.log(u1)) * Math.cos(2*Math.PI*u2);
}
function mktFmtPct(v, digits){ if (v==null||isNaN(v)) return '-'; return (v*100).toFixed(digits==null?2:digits)+'%'; }
function mktFmtNum(v, digits){ if (v==null||isNaN(v)) return '-'; return (+v).toFixed(digits==null?2:digits); }
function mktPctColor(v){ return v>0 ? 'var(--success)' : (v<0 ? 'var(--danger)' : 'var(--text-sec)'); }

// ═══ MODULE 1: REBASED RETURN CHART ═══
function mktRenderRebased() {
  var tickers = MKT_STATE.selected.slice();
  if (!tickers.length) { document.getElementById('mktRebasedEmpty').style.display='block'; document.getElementById('mktRebasedWrap').style.display='none'; document.getElementById('mktRollingReturnsWrap').innerHTML=''; return; }
  document.getElementById('mktRebasedEmpty').style.display='none';
  document.getElementById('mktRebasedWrap').style.display='block';
  var dates = MKT_STATE.alignedDates;
  var datasets = [];
  for (var i=0;i<tickers.length;i++) {
    var t = tickers[i];
    var series = MKT_STATE.aligned[t];
    if (!series || series.length < 2) continue;
    var base = series[0];
    var rebased = series.map(function(v){ return (v/base)*100; });
    datasets.push({
      label: t,
      data: rebased,
      borderColor: PALETTE[i % PALETTE.length],
      backgroundColor: PALETTE[i % PALETTE.length],
      borderWidth: 1.8,
      pointRadius: 0,
      tension: 0.1
    });
  }
  if (MKT_CHARTS.rebased) { MKT_CHARTS.rebased.destroy(); }
  var ctx = document.getElementById('mktRebasedChart').getContext('2d');
  MKT_CHARTS.rebased = new Chart(ctx, {
    type: 'line',
    data: { labels: dates, datasets: datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 }, color: C.textSec, boxWidth: 10 } },
        tooltip: Object.assign({}, chartTooltip, {
          callbacks: {
            label: function(ctx){
              var pct = ((ctx.parsed.y - 100)).toFixed(2);
              return ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(2) + ' (' + (pct>=0?'+':'') + pct + '%)';
            }
          }
        })
      },
      scales: {
        x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { maxTicksLimit: 10, autoSkip: true }) },
        y: { grid: chartGrid, ticks: chartTicks, title: { display: true, text: 'Rebased (Start = 100)', font: { size: 11, weight: '600' }, color: C.textSec } }
      }
    }
  });
  mktRenderRollingTable();
}

function mktRenderRollingTable() {
  var tickers = MKT_STATE.selected.slice();
  var dates = MKT_STATE.alignedDates;
  if (!tickers.length || dates.length < 2) { document.getElementById('mktRollingReturnsWrap').innerHTML=''; return; }
  var periods = [
    { key:'1W', days:5 }, { key:'1M', days:21 }, { key:'3M', days:63 },
    { key:'6M', days:126 }, { key:'YTD', ytd:true }, { key:'1Y', days:252 }
  ];
  var html = '<div style="background:var(--navy);color:var(--text-on-dark);padding:8px 12px;font-size:12px;font-weight:700;border-radius:4px 4px 0 0;">Rolling Returns by Asset</div>';
  html += '<div class="table-wrap" style="border:1px solid var(--border);border-top:none;border-radius:0 0 4px 4px;">';
  html += '<table><thead><tr><th>Asset</th>';
  for (var p=0;p<periods.length;p++) html += '<th style="text-align:right;">'+periods[p].key+'</th>';
  html += '</tr></thead><tbody>';
  // Determine current year for YTD
  var latestDate = dates[dates.length-1];
  var yearStart = latestDate.slice(0,4) + '-01-01';
  var ytdStartIdx = -1;
  for (var d=0; d<dates.length; d++) if (dates[d] >= yearStart) { ytdStartIdx = d; break; }
  for (var i=0;i<tickers.length;i++) {
    var t = tickers[i];
    var s = MKT_STATE.aligned[t];
    if (!s) continue;
    html += '<tr><td style="font-weight:600;">'+t+'</td>';
    var end = s[s.length-1];
    for (var q=0;q<periods.length;q++) {
      var pr = periods[q];
      var startIdx;
      if (pr.ytd) startIdx = ytdStartIdx >= 0 ? ytdStartIdx : 0;
      else startIdx = Math.max(0, s.length - 1 - pr.days);
      var startVal = s[startIdx];
      var ret = startVal > 0 ? ((end/startVal) - 1) : null;
      var color = ret == null ? 'var(--text-sec)' : mktPctColor(ret);
      html += '<td style="text-align:right;color:'+color+';font-weight:600;">'+ (ret==null?'-':mktFmtPct(ret)) +'</td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  document.getElementById('mktRollingReturnsWrap').innerHTML = html;
}

// ═══ MODULE 2: CORRELATION HEATMAP ═══
function mktRenderCorrelation() {
  var matrix = MKT_STATE.logRetMatrix;
  if (!matrix || matrix.tickers.length < 2) {
    document.getElementById('mktCorrEmpty').style.display='block';
    document.getElementById('mktCorrWrap').style.display='none';
    return;
  }
  // Filter to only selected tickers
  var selected = MKT_STATE.selected.slice();
  var indices = [];
  for (var i=0;i<matrix.tickers.length;i++) if (selected.indexOf(matrix.tickers[i]) >= 0) indices.push(i);
  if (indices.length < 2) {
    document.getElementById('mktCorrEmpty').style.display='block';
    document.getElementById('mktCorrEmpty').innerHTML='Select 2+ assets.';
    document.getElementById('mktCorrWrap').style.display='none';
    return;
  }
  document.getElementById('mktCorrEmpty').style.display='none';
  document.getElementById('mktCorrWrap').style.display='block';

  var labels = indices.map(function(k){ return matrix.tickers[k]; });
  var n = indices.length;
  // Apply rolling window
  var T = matrix.returns.length;
  var win = MKT_STATE.corrWindow;
  var startR = (win > 0 && T > win) ? (T - win) : 0;
  // Build column vectors
  var cols = [];
  for (var c=0;c<n;c++) {
    var vec = [];
    for (var r=startR;r<T;r++) vec.push(matrix.returns[r][indices[c]]);
    cols.push(vec);
  }
  // Compute corr matrix
  var corr = [];
  for (var a=0;a<n;a++) {
    corr.push([]);
    for (var b=0;b<n;b++) {
      if (a===b) corr[a].push(1);
      else if (b<a) corr[a].push(corr[b][a]);
      else corr[a].push(mktPearson(cols[a], cols[b]));
    }
  }
  // Draw on canvas
  var canvas = document.getElementById('mktCorrCanvas');
  var cellSize = Math.max(42, Math.min(72, Math.floor(900 / (n+1))));
  var labelW = 62;
  canvas.width = labelW + cellSize * n + 10;
  canvas.height = labelW + cellSize * n + 10;
  canvas.style.width = canvas.width + 'px';
  canvas.style.height = canvas.height + 'px';
  var ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg; ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.font = 'bold 11px Arial';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.fillStyle = C.navy;
  for (var yi=0;yi<n;yi++) {
    ctx.fillText(labels[yi], labelW-6, labelW + yi*cellSize + cellSize/2);
  }
  ctx.textAlign = 'center';
  ctx.save();
  for (var xi=0;xi<n;xi++) {
    ctx.save();
    ctx.translate(labelW + xi*cellSize + cellSize/2, labelW-8);
    ctx.rotate(-Math.PI/4);
    ctx.fillText(labels[xi], 0, 0);
    ctx.restore();
  }
  ctx.restore();
  // Cells
  for (var row=0;row<n;row++) {
    for (var col=0;col<n;col++) {
      var rho = corr[row][col];
      var color = mktCorrColor(rho);
      ctx.fillStyle = color;
      ctx.fillRect(labelW + col*cellSize, labelW + row*cellSize, cellSize, cellSize);
      ctx.strokeStyle = C.border; ctx.lineWidth = 1;
      ctx.strokeRect(labelW + col*cellSize + 0.5, labelW + row*cellSize + 0.5, cellSize-1, cellSize-1);
      // Text
      var txtColor = Math.abs(rho) > 0.55 ? '#FFFFFF' : C.text;
      ctx.fillStyle = txtColor;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = 'bold 11px Arial';
      ctx.fillText(rho.toFixed(2), labelW + col*cellSize + cellSize/2, labelW + row*cellSize + cellSize/2);
    }
  }
  // Hover interactions
  canvas.onmousemove = function(e) {
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var c = Math.floor((mx - labelW) / cellSize), r = Math.floor((my - labelW) / cellSize);
    if (c >= 0 && c < n && r >= 0 && r < n) {
      var tip = document.getElementById('mktCorrTooltip');
      tip.style.display = 'block';
      tip.style.left = (mx + 12) + 'px';
      tip.style.top = (my + 12) + 'px';
      var winLabel = win === 0 ? 'Full Sample' : (win + 'D');
      tip.innerHTML = '<strong>'+labels[r]+' vs '+labels[c]+'</strong><br>&rho; = '+corr[r][c].toFixed(3)+'<br>Window: '+winLabel;
    }
  };
  canvas.onmouseleave = function(){ document.getElementById('mktCorrTooltip').style.display='none'; };
}

function mktCorrColor(rho) {
  // -1 = danger, 0 = white, 1 = navy
  var danger = { r: 0x8B, g: 0x2A, b: 0x2A };
  var white = { r: 0xFF, g: 0xFF, b: 0xFF };
  var navy = { r: 0x00, g: 0x3C, b: 0x71 };
  var c;
  if (rho < 0) {
    var t = Math.min(1, -rho);
    c = { r: white.r*(1-t) + danger.r*t, g: white.g*(1-t) + danger.g*t, b: white.b*(1-t) + danger.b*t };
  } else {
    var t2 = Math.min(1, rho);
    c = { r: white.r*(1-t2) + navy.r*t2, g: white.g*(1-t2) + navy.g*t2, b: white.b*(1-t2) + navy.b*t2 };
  }
  return 'rgb('+Math.round(c.r)+','+Math.round(c.g)+','+Math.round(c.b)+')';
}

// ═══ MODULE 3: 3D VOL SURFACE (THREE.JS) ═══
function mktRenderVolSurface() {
  var matrix = MKT_STATE.logRetMatrix;
  var selected = MKT_STATE.selected.slice();
  if (!matrix || selected.length < 1 || matrix.returns.length < 252) {
    document.getElementById('mktVolEmpty').style.display='block';
    document.getElementById('mktVolEmpty').innerHTML = matrix ? 'Need at least 252 trading days of data.' : 'Awaiting data.';
    document.getElementById('mktVolContainer').style.display='none';
    document.getElementById('mktVolLegend').style.display='none';
    return;
  }
  document.getElementById('mktVolEmpty').style.display='none';
  document.getElementById('mktVolContainer').style.display='block';
  document.getElementById('mktVolLegend').style.display='block';

  var assets = selected;
  var windows = [10, 21, 42, 63, 126, 252];
  var T = matrix.returns.length;
  // vol[asset][window] = annualized rolling std (most recent)
  var vol = [];
  var tickIndices = {};
  for (var i=0;i<matrix.tickers.length;i++) tickIndices[matrix.tickers[i]] = i;
  for (var a=0;a<assets.length;a++) {
    var idx = tickIndices[assets[a]];
    var row = [];
    for (var w=0;w<windows.length;w++) {
      var win = Math.min(windows[w], T);
      var slice = [];
      for (var k=T-win;k<T;k++) slice.push(matrix.returns[k][idx]);
      var s = mktStd(slice);
      row.push(s * Math.sqrt(252));
    }
    vol.push(row);
  }
  mktBuildThreeSurface(assets, windows, vol);
  mktBuildVolLegend(vol);
}

function mktBuildVolLegend(vol) {
  var flat = [];
  for (var i=0;i<vol.length;i++) for (var j=0;j<vol[i].length;j++) flat.push(vol[i][j]);
  var min = Math.min.apply(null, flat), max = Math.max.apply(null, flat);
  var steps = 10;
  var html = '<div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">'
    + '<span style="font-size:11px;color:var(--text-sec);font-weight:600;margin-right:6px;">Annualized &sigma;:</span>'
    + '<span style="font-size:10px;color:var(--text-sec);">'+(min*100).toFixed(1)+'%</span>';
  for (var s=0;s<steps;s++) {
    var t = s/(steps-1);
    html += '<div style="width:26px;height:14px;background:'+mktVolColor(t)+';border:1px solid var(--border);"></div>';
  }
  html += '<span style="font-size:10px;color:var(--text-sec);">'+(max*100).toFixed(1)+'%</span></div>';
  document.getElementById('mktVolLegend').innerHTML = html;
}

function mktVolColor(t) {
  // t in [0,1]: low (blue) -> mid (white) -> high (danger red)
  t = Math.max(0, Math.min(1, t));
  var blue = { r: 0x5B, g: 0x9B, b: 0xD5 };
  var white = { r: 0xFF, g: 0xFF, b: 0xFF };
  var danger = { r: 0x8B, g: 0x2A, b: 0x2A };
  var c;
  if (t < 0.5) {
    var lt = t / 0.5;
    c = { r: blue.r*(1-lt) + white.r*lt, g: blue.g*(1-lt) + white.g*lt, b: blue.b*(1-lt) + white.b*lt };
  } else {
    var ht = (t - 0.5) / 0.5;
    c = { r: white.r*(1-ht) + danger.r*ht, g: white.g*(1-ht) + danger.g*ht, b: white.b*(1-ht) + danger.b*ht };
  }
  return 'rgb('+Math.round(c.r)+','+Math.round(c.g)+','+Math.round(c.b)+')';
}

function mktVolColorTHREE(t) {
  t = Math.max(0, Math.min(1, t));
  var blue = { r: 0x5B/255, g: 0x9B/255, b: 0xD5/255 };
  var white = { r: 1, g: 1, b: 1 };
  var danger = { r: 0x8B/255, g: 0x2A/255, b: 0x2A/255 };
  if (t < 0.5) {
    var lt = t / 0.5;
    return { r: blue.r*(1-lt) + white.r*lt, g: blue.g*(1-lt) + white.g*lt, b: blue.b*(1-lt) + white.b*lt };
  } else {
    var ht = (t - 0.5) / 0.5;
    return { r: white.r*(1-ht) + danger.r*ht, g: white.g*(1-ht) + danger.g*ht, b: white.b*(1-ht) + danger.b*ht };
  }
}

function mktBuildThreeSurface(assets, windows, vol) {
  var container = document.getElementById('mktVolCanvas');
  // Cleanup previous
  if (MKT_THREE.animId) cancelAnimationFrame(MKT_THREE.animId);
  if (MKT_THREE.renderer) {
    container.innerHTML = '';
    MKT_THREE.renderer.dispose();
  }
  var W = container.clientWidth, H = container.clientHeight;
  MKT_THREE.width = W; MKT_THREE.height = H;

  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0xF4F6F9);

  var camera = new THREE.PerspectiveCamera(45, W/H, 0.1, 1000);
  // Spherical camera setup
  var sph = { radius: 28, theta: Math.PI/4, phi: Math.PI/3.2 };
  function updateCam() {
    camera.position.x = sph.radius * Math.sin(sph.phi) * Math.sin(sph.theta);
    camera.position.y = sph.radius * Math.cos(sph.phi);
    camera.position.z = sph.radius * Math.sin(sph.phi) * Math.cos(sph.theta);
    camera.lookAt(0, 2, 0);
  }
  updateCam();

  var renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(W, H);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  // Lighting
  var ambient = new THREE.AmbientLight(0xffffff, 0.65);
  scene.add(ambient);
  var dir = new THREE.DirectionalLight(0xffffff, 0.85);
  dir.position.set(10, 20, 10);
  scene.add(dir);

  // Compute min/max for coloring
  var flat = []; for (var i=0;i<vol.length;i++) for (var j=0;j<vol[i].length;j++) flat.push(vol[i][j]);
  var vmin = Math.min.apply(null, flat), vmax = Math.max.apply(null, flat);
  var vrange = Math.max(1e-6, vmax - vmin);

  // Grid dimensions
  var nx = assets.length;   // X axis
  var ny = windows.length;  // Y axis (time/window)
  // Surface spans: X from -8..8, Z from -6..6, Y is vol
  var xSpan = 14, zSpan = 10;
  var yScale = 10 / vrange;  // scale vol so peaks show up

  // PlaneGeometry with subdivisions. For meaningful topology between cells, we need enough segments.
  // We'll use nx*2 wide and ny*2 deep for smoother surface.
  var segX = Math.max(nx-1, 1) * 6;
  var segZ = Math.max(ny-1, 1) * 6;
  var geom = new THREE.PlaneGeometry(xSpan, zSpan, segX, segZ);
  geom.rotateX(-Math.PI/2);

  // Apply heights via bilinear interpolation on vol[asset][window]
  var positions = geom.attributes.position;
  var colors = new Float32Array(positions.count * 3);
  for (var p=0; p<positions.count; p++) {
    var x = positions.getX(p); // -xSpan/2..xSpan/2
    var z = positions.getZ(p); // -zSpan/2..zSpan/2
    var ux = (x + xSpan/2) / xSpan; // 0..1
    var uz = (z + zSpan/2) / zSpan; // 0..1
    var fx = ux * (nx - 1);
    var fz = uz * (ny - 1);
    var ix0 = Math.floor(fx), ix1 = Math.min(nx-1, ix0+1);
    var iz0 = Math.floor(fz), iz1 = Math.min(ny-1, iz0+1);
    var tx = fx - ix0, tz = fz - iz0;
    var v00 = vol[ix0][iz0], v10 = vol[ix1][iz0], v01 = vol[ix0][iz1], v11 = vol[ix1][iz1];
    var v = v00*(1-tx)*(1-tz) + v10*tx*(1-tz) + v01*(1-tx)*tz + v11*tx*tz;
    var height = (v - vmin) * yScale;
    positions.setY(p, height);
    var tCol = (v - vmin) / vrange;
    var col = mktVolColorTHREE(tCol);
    colors[p*3] = col.r; colors[p*3+1] = col.g; colors[p*3+2] = col.b;
  }
  positions.needsUpdate = true;
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.computeVertexNormals();

  var mat = new THREE.MeshPhongMaterial({ vertexColors: true, side: THREE.DoubleSide, shininess: 20, flatShading: false });
  var mesh = new THREE.Mesh(geom, mat);
  scene.add(mesh);

  // Wireframe overlay for clarity
  var wireGeom = new THREE.PlaneGeometry(xSpan, zSpan, nx-1, ny-1);
  wireGeom.rotateX(-Math.PI/2);
  var wirePos = wireGeom.attributes.position;
  for (var wp=0; wp<wirePos.count; wp++) {
    var wx = wirePos.getX(wp), wz = wirePos.getZ(wp);
    var wux = (wx + xSpan/2) / xSpan;
    var wuz = (wz + zSpan/2) / zSpan;
    var wfx = wux * (nx-1), wfz = wuz * (ny-1);
    var wix = Math.round(wfx), wiz = Math.round(wfz);
    wix = Math.max(0, Math.min(nx-1, wix));
    wiz = Math.max(0, Math.min(ny-1, wiz));
    wirePos.setY(wp, (vol[wix][wiz] - vmin) * yScale + 0.02);
  }
  wirePos.needsUpdate = true;
  var wireMat = new THREE.LineBasicMaterial({ color: 0x003C71, transparent: true, opacity: 0.35 });
  var wire = new THREE.LineSegments(new THREE.WireframeGeometry(wireGeom), wireMat);
  scene.add(wire);

  // Axis lines
  var axesMat = new THREE.LineBasicMaterial({ color: 0x5A6A7A });
  var axG = new THREE.BufferGeometry();
  axG.setFromPoints([
    new THREE.Vector3(-xSpan/2, 0, zSpan/2), new THREE.Vector3(xSpan/2, 0, zSpan/2),
    new THREE.Vector3(-xSpan/2, 0, zSpan/2), new THREE.Vector3(-xSpan/2, 0, -zSpan/2),
    new THREE.Vector3(-xSpan/2, 0, zSpan/2), new THREE.Vector3(-xSpan/2, 12, zSpan/2)
  ]);
  scene.add(new THREE.LineSegments(axG, axesMat));

  // Sprite labels
  function makeTextSprite(text, opts) {
    opts = opts || {};
    var canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = opts.bg || 'rgba(255,255,255,0.9)';
    ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.strokeStyle = '#D0D7E0'; ctx.lineWidth = 2;
    ctx.strokeRect(0,0,canvas.width,canvas.height);
    ctx.font = 'bold 26px Arial';
    ctx.fillStyle = opts.color || '#003C71';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width/2, canvas.height/2);
    var tex = new THREE.CanvasTexture(canvas);
    var spMat = new THREE.SpriteMaterial({ map: tex, transparent: true });
    var sp = new THREE.Sprite(spMat);
    sp.scale.set(2.4, 0.6, 1);
    return sp;
  }
  // X-axis (asset names) — below surface at z = zSpan/2 + 0.6
  for (var la=0; la<assets.length; la++) {
    var xPos = -xSpan/2 + (la/(Math.max(1,assets.length-1))) * xSpan;
    if (assets.length === 1) xPos = 0;
    var sp = makeTextSprite(assets[la]);
    sp.position.set(xPos, -0.4, zSpan/2 + 1.1);
    scene.add(sp);
  }
  // Z-axis (window labels)
  for (var lw=0; lw<windows.length; lw++) {
    var zPos = -zSpan/2 + (lw/(windows.length-1)) * zSpan;
    var sp2 = makeTextSprite(windows[lw]+'D');
    sp2.position.set(-xSpan/2 - 1.4, -0.4, zPos);
    scene.add(sp2);
  }
  // Y-axis label
  var ysp = makeTextSprite('σ ann.');
  ysp.position.set(-xSpan/2 - 1.4, 12.6, zSpan/2);
  scene.add(ysp);

  // Manual orbit controls
  var isDrag = false;
  var lastX, lastY;
  var dom = renderer.domElement;
  dom.style.cursor = 'grab';
  dom.addEventListener('mousedown', function(e){
    isDrag = true; lastX = e.clientX; lastY = e.clientY;
    dom.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', function(e){
    if (!isDrag) return;
    var dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    sph.theta -= dx * 0.008;
    sph.phi -= dy * 0.008;
    sph.phi = Math.max(0.15, Math.min(Math.PI - 0.15, sph.phi));
    updateCam();
  });
  window.addEventListener('mouseup', function(){ isDrag = false; dom.style.cursor='grab'; });
  dom.addEventListener('wheel', function(e){
    e.preventDefault();
    sph.radius += e.deltaY * 0.02;
    sph.radius = Math.max(10, Math.min(80, sph.radius));
    updateCam();
  }, { passive: false });

  function animate() {
    MKT_THREE.animId = requestAnimationFrame(animate);
    renderer.render(scene, camera);
  }
  animate();

  MKT_THREE.renderer = renderer;
  MKT_THREE.scene = scene;
  MKT_THREE.camera = camera;
  MKT_THREE.mesh = mesh;

  // Handle resize
  window.addEventListener('resize', function(){
    var nw = container.clientWidth, nh = container.clientHeight;
    if (nw && nh && (nw !== MKT_THREE.width || nh !== MKT_THREE.height)) {
      MKT_THREE.width = nw; MKT_THREE.height = nh;
      camera.aspect = nw/nh; camera.updateProjectionMatrix();
      renderer.setSize(nw, nh);
    }
  });
}

// ═══ MODULE 4: COX PROCESS ═══
function mktRunCox() {
  if (!MKT_STATE.logRetMatrix) { alert('Please load data first.'); return; }
  var primary = MKT_STATE.primary;
  var idx = -1;
  var tickers = MKT_STATE.logRetMatrix.tickers;
  for (var i=0;i<tickers.length;i++) if (tickers[i]===primary) { idx = i; break; }
  if (idx < 0) { alert('Primary asset not in loaded data.'); return; }
  // Get calibration: mu, sigma from historical returns
  var retCol = [];
  for (var r=0;r<MKT_STATE.logRetMatrix.returns.length;r++) retCol.push(MKT_STATE.logRetMatrix.returns[r][idx]);
  var muDaily = mktMean(retCol), sigmaDaily = mktStd(retCol);
  var mu = muDaily * 252;
  var sigma = sigmaDaily * Math.sqrt(252);
  var S0 = MKT_STATE.aligned[primary][MKT_STATE.aligned[primary].length-1];

  var kappa = parseFloat(document.getElementById('mktCoxKappa').value);
  var theta = parseFloat(document.getElementById('mktCoxTheta').value);
  var sigmaL = parseFloat(document.getElementById('mktCoxSigmaL').value);
  var muJ = parseFloat(document.getElementById('mktCoxMuJ').value);
  var sigmaJ = parseFloat(document.getElementById('mktCoxSigmaJ').value);
  var nPaths = 200;
  var H = 252;
  var dt = 1/252;
  var kbar = Math.exp(muJ + 0.5*sigmaJ*sigmaJ) - 1; // E[e^J - 1]

  var paths = [];
  var lambdaPaths = [];
  var jumpCounts = [];
  for (var p=0;p<nPaths;p++) {
    var S = [S0];
    var lam = [theta];
    var jc = 0;
    for (var t=1;t<=H;t++) {
      var Z1 = mktBoxMuller(), Z2 = mktBoxMuller();
      var curLam = lam[t-1];
      var lamNew = curLam + kappa*(theta - curLam)*dt + sigmaL*Math.sqrt(Math.max(0,curLam))*Math.sqrt(dt)*Z1;
      if (lamNew < 0) lamNew = 0;
      lam.push(lamNew);
      // Poisson(lamNew * dt) — for small dt, approximate with small-number sampling
      var pmean = lamNew * dt;
      var nJumps = mktPoissonSample(pmean);
      var jumpSum = 0;
      for (var jj=0;jj<nJumps;jj++) jumpSum += muJ + sigmaJ*mktBoxMuller();
      jc += nJumps;
      var Sn = S[t-1] * Math.exp((mu - 0.5*sigma*sigma - lamNew*kbar)*dt + sigma*Math.sqrt(dt)*Z2 + jumpSum);
      S.push(Sn);
    }
    paths.push(S);
    lambdaPaths.push(lam);
    jumpCounts.push(jc);
  }
  mktRenderCoxCharts(paths, lambdaPaths, jumpCounts, S0, theta);
  document.getElementById('mktCoxResults').style.display='block';
  document.getElementById('mktCoxEmpty').style.display='none';
}

function mktPoissonSample(lambda) {
  // Knuth's algorithm; sufficient for small lambda
  if (lambda <= 0) return 0;
  if (lambda > 30) { return Math.max(0, Math.round(lambda + Math.sqrt(lambda)*mktBoxMuller())); }
  var L = Math.exp(-lambda);
  var k = 0, pr = 1;
  do { k++; pr *= Math.random(); } while (pr > L);
  return k - 1;
}

function mktRenderCoxCharts(paths, lambdaPaths, jumpCounts, S0, thetaVal) {
  var H = paths[0].length;
  var labels = []; for (var i=0;i<H;i++) labels.push(i);

  // Chart A: price paths
  var pathDatasets = paths.map(function(p){
    return { data: p, borderColor: 'rgba(0,60,113,0.05)', borderWidth: 0.6, pointRadius: 0, fill: false };
  });
  // Percentile bands at each time step
  var median = [], p10 = [], p90 = [];
  for (var t=0;t<H;t++) {
    var slice = paths.map(function(pp){ return pp[t]; });
    slice.sort(function(a,b){return a-b;});
    median.push(slice[Math.floor(slice.length*0.5)]);
    p10.push(slice[Math.floor(slice.length*0.1)]);
    p90.push(slice[Math.floor(slice.length*0.9)]);
  }
  pathDatasets.push({ data: median, borderColor: C.danger, borderWidth: 2, pointRadius: 0, fill: false, label: 'Median' });
  pathDatasets.push({ data: p10, borderColor: C.blue, borderWidth: 1.5, borderDash: [4,3], pointRadius: 0, fill: false, label: '10th pctl' });
  pathDatasets.push({ data: p90, borderColor: C.blue, borderWidth: 1.5, borderDash: [4,3], pointRadius: 0, fill: false, label: '90th pctl' });

  if (MKT_CHARTS.coxPaths) MKT_CHARTS.coxPaths.destroy();
  MKT_CHARTS.coxPaths = new Chart(document.getElementById('mktCoxPaths').getContext('2d'), {
    type: 'line',
    data: { labels: labels, datasets: pathDatasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'bottom', labels: { filter: function(it){ return it.text && (it.text.indexOf('Median')>=0 || it.text.indexOf('pctl')>=0); }, font: { size: 10 }, color: C.textSec } },
        tooltip: { enabled: false },
        title: { display: true, text: 'Simulated Price Paths (200)', color: C.navy, font: { size: 12, weight: '700' } }
      },
      scales: {
        x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { maxTicksLimit: 6 }), title: { display: true, text: 'Trading Days', font: { size: 10 }, color: C.textSec } },
        y: { grid: chartGrid, ticks: chartTicks, title: { display: true, text: 'Price', font: { size: 10 }, color: C.textSec } }
      }
    }
  });

  // Chart B: 5 lambda paths
  var lamDatasets = [];
  var sampleIdx = [0, Math.floor(lambdaPaths.length*0.25), Math.floor(lambdaPaths.length*0.5), Math.floor(lambdaPaths.length*0.75), lambdaPaths.length-1];
  for (var s=0;s<sampleIdx.length;s++) {
    lamDatasets.push({
      data: lambdaPaths[sampleIdx[s]],
      borderColor: PALETTE[s % PALETTE.length],
      borderWidth: 1.3, pointRadius: 0, fill: false,
      label: 'Path '+(s+1)
    });
  }
  // Long-run theta line
  var thetaLine = []; for (var th=0;th<H+1;th++) thetaLine.push(thetaVal);
  lamDatasets.push({ data: thetaLine, borderColor: C.danger, borderWidth: 1.5, borderDash: [5,3], pointRadius: 0, fill: false, label: 'θ (long-run)' });

  if (MKT_CHARTS.coxLambda) MKT_CHARTS.coxLambda.destroy();
  MKT_CHARTS.coxLambda = new Chart(document.getElementById('mktCoxLambda').getContext('2d'), {
    type: 'line',
    data: { labels: labels.concat([H]), datasets: lamDatasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'bottom', labels: { font: { size: 10 }, color: C.textSec, boxWidth: 8 } },
        tooltip: { enabled: false },
        title: { display: true, text: 'Stochastic Intensity λ(t) — 5 sample paths', color: C.navy, font: { size: 12, weight: '700' } }
      },
      scales: {
        x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { maxTicksLimit: 6 }) },
        y: { grid: chartGrid, ticks: chartTicks, title: { display: true, text: 'λ (jumps/yr)', font: { size: 10 }, color: C.textSec } }
      }
    }
  });

  // Chart C: histogram of jump counts
  var minJ = Math.min.apply(null, jumpCounts), maxJ = Math.max.apply(null, jumpCounts);
  var bins = 12;
  var binW = Math.max(1, Math.ceil((maxJ - minJ + 1)/bins));
  var binLabels = [], binCounts = new Array(bins).fill(0);
  for (var b=0;b<bins;b++) binLabels.push((minJ + b*binW)+'–'+(minJ + (b+1)*binW - 1));
  for (var jc=0;jc<jumpCounts.length;jc++) {
    var bi = Math.min(bins-1, Math.floor((jumpCounts[jc] - minJ)/binW));
    binCounts[bi]++;
  }
  if (MKT_CHARTS.coxJumps) MKT_CHARTS.coxJumps.destroy();
  MKT_CHARTS.coxJumps = new Chart(document.getElementById('mktCoxJumps').getContext('2d'), {
    type: 'bar',
    data: { labels: binLabels, datasets: [{ data: binCounts, backgroundColor: C.navy, borderColor: C.navy, borderWidth: 1 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: Object.assign({}, chartTooltip, { callbacks: { label: function(ctx){ return ctx.parsed.y + ' paths'; } } }),
        title: { display: true, text: 'Total Jump Events (per path, over horizon)', color: C.navy, font: { size: 12, weight: '700' } }
      },
      scales: {
        x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { font: { size: 9 }, maxRotation: 45 }) },
        y: { grid: chartGrid, ticks: chartTicks, title: { display: true, text: 'Path Count', font: { size: 10 }, color: C.textSec } }
      }
    }
  });

  // Stats
  var terminal = paths.map(function(p){ return p[H-1]; });
  terminal.sort(function(a,b){return a-b;});
  var expT = mktMean(terminal);
  var medT = terminal[Math.floor(terminal.length/2)];
  var pCrash20 = terminal.filter(function(v){ return v < S0*0.8; }).length / terminal.length;
  var pCrash30 = terminal.filter(function(v){ return v < S0*0.7; }).length / terminal.length;
  var meanJumps = mktMean(jumpCounts);
  var lamFlat = []; for (var lp=0;lp<lambdaPaths.length;lp++) for (var lq=0;lq<lambdaPaths[lp].length;lq++) lamFlat.push(lambdaPaths[lp][lq]);
  var lamMean = mktMean(lamFlat);
  // Max drawdown on median path
  var medPath = []; for (var tt=0;tt<H;tt++) {
    var slc = paths.map(function(p){ return p[tt]; }); slc.sort(function(a,b){return a-b;});
    medPath.push(slc[Math.floor(slc.length/2)]);
  }
  var peak = -Infinity, mdd = 0;
  for (var md=0;md<medPath.length;md++) { if (medPath[md]>peak) peak = medPath[md]; var ddv = (peak - medPath[md])/peak; if (ddv>mdd) mdd = ddv; }
  var var95 = mktPercentile(terminal, 5);
  var cvar95 = 0, cnt = 0;
  for (var tv=0;tv<terminal.length;tv++) if (terminal[tv] <= var95) { cvar95 += terminal[tv]; cnt++; }
  cvar95 = cnt > 0 ? cvar95/cnt : var95;
  var termRets = terminal.map(function(v){ return (v/S0) - 1; });
  var skewT = mktSkew(termRets), kurtT = mktKurt(termRets);
  var stdT = mktStd(terminal);

  var cards = [
    { l: 'Expected Terminal', v: '$'+mktFmtNum(expT), sub: 'S₀ = $'+mktFmtNum(S0) },
    { l: 'Median Terminal', v: '$'+mktFmtNum(medT), sub: mktFmtPct((medT/S0)-1) },
    { l: 'P(Crash > 20%)', v: (pCrash20*100).toFixed(1)+'%', sub: 'Below $'+mktFmtNum(S0*0.8) },
    { l: 'P(Crash > 30%)', v: (pCrash30*100).toFixed(1)+'%', sub: 'Below $'+mktFmtNum(S0*0.7) },
    { l: 'Expected # Jumps', v: mktFmtNum(meanJumps, 1), sub: 'Over horizon' },
    { l: 'λ Mean (horizon)', v: mktFmtNum(lamMean, 3), sub: 'jumps/yr avg' },
    { l: 'Max DD (median)', v: (mdd*100).toFixed(1)+'%', sub: 'Peak-to-trough' },
    { l: 'VaR 95%', v: '$'+mktFmtNum(var95), sub: mktFmtPct((var95/S0)-1) },
    { l: 'CVaR 95%', v: '$'+mktFmtNum(cvar95), sub: 'Expected shortfall' },
    { l: 'Skewness', v: skewT.toFixed(2), sub: skewT < 0 ? 'Left tail' : 'Right tail' },
    { l: 'Excess Kurtosis', v: kurtT.toFixed(2), sub: kurtT > 0 ? 'Fat tails' : 'Thin tails' },
    { l: 'Std Dev Terminal', v: '$'+mktFmtNum(stdT), sub: 'Dispersion' }
  ];
  var html = '';
  for (var cc=0;cc<cards.length;cc++) {
    html += '<div class="metric-card"><div class="metric-label">'+cards[cc].l+'</div>'
          + '<div class="metric-value">'+cards[cc].v+'</div>'
          + '<div class="metric-sub">'+cards[cc].sub+'</div></div>';
  }
  document.getElementById('mktCoxStats').innerHTML = html;
}

// ═══ MODULE 5: EFFICIENT FRONTIER ═══
function mktRenderFrontier() {
  var matrix = MKT_STATE.logRetMatrix;
  var selected = MKT_STATE.selected.slice();
  // Filter SPY out unless user explicitly selected it (keep simple: use user selection)
  var assets = selected.slice();
  if (!matrix || assets.length < 2) {
    document.getElementById('mktEffEmpty').style.display='block';
    document.getElementById('mktEffResults').style.display='none';
    return;
  }
  document.getElementById('mktEffEmpty').style.display='none';
  document.getElementById('mktEffResults').style.display='block';

  var tickIdx = {}; for (var i=0;i<matrix.tickers.length;i++) tickIdx[matrix.tickers[i]] = i;
  var n = assets.length;
  var T = matrix.returns.length;

  // Mean vector (annualized)
  var muVec = [];
  for (var a=0;a<n;a++) {
    var col = []; for (var r=0;r<T;r++) col.push(matrix.returns[r][tickIdx[assets[a]]]);
    muVec.push(mktMean(col) * 252);
  }
  // Covariance matrix (annualized)
  var cov = [];
  for (var a1=0;a1<n;a1++) {
    cov.push([]);
    var col1 = []; for (var r1=0;r1<T;r1++) col1.push(matrix.returns[r1][tickIdx[assets[a1]]]);
    var m1 = mktMean(col1);
    for (var a2=0;a2<n;a2++) {
      var col2 = []; for (var r2=0;r2<T;r2++) col2.push(matrix.returns[r2][tickIdx[assets[a2]]]);
      var m2 = mktMean(col2);
      var s = 0;
      for (var k=0;k<T;k++) s += (col1[k]-m1)*(col2[k]-m2);
      cov[a1].push((s/(T-1)) * 252);
    }
  }
  // Monte Carlo
  var nSim = 5000;
  var rf = 0.053;
  var pts = [];
  var bestSR = -Infinity, bestSRW = null, bestSRRet = 0, bestSRVol = 0;
  var bestOmega = -Infinity, bestOmegaW = null, bestOmegaRet = 0, bestOmegaVol = 0;
  var minVol = Infinity, minVolW = null, minVolRet = 0, minVolV = 0;
  // Error function approximation (needed for normal CDF in Omega ratio)
  function erf(x) {
    var t = 1/(1+0.3275911*Math.abs(x));
    var y = 1 - (0.254829592*t - 0.284496736*t*t + 1.421413741*t*t*t - 1.453152027*t*t*t*t + 1.061405429*t*t*t*t*t)*Math.exp(-x*x);
    return x < 0 ? -y : y;
  }
  for (var s=0;s<nSim;s++) {
    // Dirichlet via Gamma(1,1) i.e. Exponential(1)
    var w = []; var sum = 0;
    for (var ww=0;ww<n;ww++) { var g = -Math.log(Math.random()); w.push(g); sum += g; }
    for (var ww2=0;ww2<n;ww2++) w[ww2] /= sum;
    var pRet = 0;
    for (var pr=0;pr<n;pr++) pRet += w[pr] * muVec[pr];
    var pVar = 0;
    for (var pi2=0;pi2<n;pi2++) for (var pj=0;pj<n;pj++) pVar += w[pi2]*w[pj]*cov[pi2][pj];
    var pVol = Math.sqrt(Math.max(0, pVar));
    var sr = pVol > 0 ? (pRet - rf) / pVol : 0;
    // Omega ratio — approximate from normal distribution (tractable for simulation)
    // Ω(τ) ≈ [φ((μ-τ)/σ)σ + (μ-τ)Φ((μ-τ)/σ)] / [φ((μ-τ)/σ)σ - (μ-τ)(1-Φ((μ-τ)/σ))]
    // Using τ = 0 (breakeven daily return) for frontier coloring
    var omegaTau = 0;
    var z = pVol > 0 ? (pRet - omegaTau) / pVol : 0;
    var Phi = 0.5*(1+erf(z/Math.SQRT2)); // standard normal CDF
    var phi = Math.exp(-0.5*z*z)/Math.sqrt(2*Math.PI); // standard normal PDF
    var omegaNum = phi*pVol + (pRet-omegaTau)*Phi;
    var omegaDen = phi*pVol - (pRet-omegaTau)*(1-Phi);
    var omega = omegaDen > 1e-9 ? omegaNum/omegaDen : (omegaNum > 0 ? 99 : 0);
    pts.push({ x: pVol, y: pRet, sr: sr, omega: omega });
    if (sr > bestSR) { bestSR = sr; bestSRW = w.slice(); bestSRRet = pRet; bestSRVol = pVol; }
    if (omega > bestOmega) { bestOmega = omega; bestOmegaW = w.slice(); bestOmegaRet = pRet; bestOmegaVol = pVol; }
    if (pVol < minVol) { minVol = pVol; minVolW = w.slice(); minVolRet = pRet; minVolV = pVol; }
  }
  // Equal-weight portfolio
  var ew = []; for (var ei=0;ei<n;ei++) ew.push(1/n);
  var ewRet = 0; for (var er=0;er<n;er++) ewRet += ew[er] * muVec[er];
  var ewVar = 0; for (var ei1=0;ei1<n;ei1++) for (var ei2=0;ei2<n;ei2++) ewVar += ew[ei1]*ew[ei2]*cov[ei1][ei2];
  var ewVol = Math.sqrt(Math.max(0, ewVar));

  // Color by Sharpe
  var srs = pts.map(function(p){return p.sr;});
  var srMin = Math.min.apply(null, srs), srMax = Math.max.apply(null, srs);
  var scatterData = pts.map(function(p){
    var t = (p.sr - srMin) / Math.max(1e-9, srMax - srMin);
    // navy (low) -> blue -> success green (high)
    var r, g, b;
    if (t < 0.5) {
      var lt = t/0.5;
      r = 0x00*(1-lt) + 0x5B*lt; g = 0x3C*(1-lt) + 0x9B*lt; b = 0x71*(1-lt) + 0xD5*lt;
    } else {
      var ht = (t-0.5)/0.5;
      r = 0x5B*(1-ht) + 0x2E*ht; g = 0x9B*(1-ht) + 0x7D*ht; b = 0xD5*(1-ht) + 0x52*ht;
    }
    return { x: p.x, y: p.y, _color: 'rgba('+Math.round(r)+','+Math.round(g)+','+Math.round(b)+',0.5)' };
  });

  if (MKT_CHARTS.eff) MKT_CHARTS.eff.destroy();
  MKT_CHARTS.eff = new Chart(document.getElementById('mktEffChart').getContext('2d'), {
    type: 'scatter',
    data: {
      datasets: [
        { label: 'Random Portfolios', data: scatterData, pointRadius: 2.2, pointBackgroundColor: scatterData.map(function(p){return p._color;}), pointBorderColor: 'transparent' },
        { label: 'Min Variance (MVP)', data: [{x: minVolV, y: minVolRet}], pointRadius: 9, pointStyle: 'triangle', pointBackgroundColor: C.warning, pointBorderColor: '#000', pointBorderWidth: 1.5 },
        { label: 'Max Sharpe (Tangency)', data: [{x: bestSRVol, y: bestSRRet}], pointRadius: 10, pointStyle: 'star', pointBackgroundColor: C.success, pointBorderColor: '#000', pointBorderWidth: 1.5 },
        { label: 'Equal Weight', data: [{x: ewVol, y: ewRet}], pointRadius: 8, pointStyle: 'rectRot', pointBackgroundColor: C.blue, pointBorderColor: '#000', pointBorderWidth: 1.5 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 }, color: C.textSec, boxWidth: 10 } },
        tooltip: Object.assign({}, chartTooltip, {
          callbacks: {
            label: function(ctx){
              return ctx.dataset.label + ': σ ' + (ctx.parsed.x*100).toFixed(2) + '%, μ ' + (ctx.parsed.y*100).toFixed(2) + '%';
            }
          }
        })
      },
      scales: {
        x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { callback: function(v){ return (v*100).toFixed(1)+'%'; } }), title: { display: true, text: 'Annualized Volatility (σ)', font: { size: 11, weight: '600' }, color: C.textSec } },
        y: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { callback: function(v){ return (v*100).toFixed(1)+'%'; } }), title: { display: true, text: 'Annualized Return (μ)', font: { size: 11, weight: '600' }, color: C.textSec } }
      }
    }
  });

  document.getElementById('mktEffMVPStats').innerHTML =
    '<strong>Annualized σ:</strong> '+(minVolV*100).toFixed(2)+'%  &nbsp; <strong>μ:</strong> '+(minVolRet*100).toFixed(2)+'%  &nbsp; <strong>Sharpe:</strong> '+((minVolRet-rf)/Math.max(1e-9,minVolV)).toFixed(2);
  document.getElementById('mktEffMSPStats').innerHTML =
    '<strong>Annualized σ:</strong> '+(bestSRVol*100).toFixed(2)+'%  &nbsp; <strong>μ:</strong> '+(bestSRRet*100).toFixed(2)+'%  &nbsp; <strong>Sharpe:</strong> '+bestSR.toFixed(2)
    + (bestOmegaW ? ' &nbsp; <span style="color:var(--navy);font-size:10px;" title="Max Omega portfolio (Lyu et al. 2023): highest full-distribution risk-adjusted return. Ω='+(bestOmega>90?'>99':bestOmega.toFixed(2))+'">| Max-Ω σ: '+(bestOmegaVol*100).toFixed(2)+'% μ: '+(bestOmegaRet*100).toFixed(2)+'% Ω='+(bestOmega>90?'>99':bestOmega.toFixed(2))+'</span>' : '');

  mktRenderWeightBar('mktEffMVPBar', assets, minVolW, 'MVP');
  mktRenderWeightBar('mktEffMSPBar', assets, bestSRW, 'MSP');
}

function mktRenderWeightBar(canvasId, labels, weights, tag) {
  var key = 'eff_'+canvasId;
  if (MKT_CHARTS[key]) MKT_CHARTS[key].destroy();
  MKT_CHARTS[key] = new Chart(document.getElementById(canvasId).getContext('2d'), {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{ data: weights.map(function(w){return w*100;}), backgroundColor: C.blue, borderColor: C.navy, borderWidth: 1 }]
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: Object.assign({}, chartTooltip, { callbacks: { label: function(ctx){ return ctx.parsed.x.toFixed(2)+'%'; } } })
      },
      scales: {
        x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { callback: function(v){ return v.toFixed(0)+'%'; } }) },
        y: { grid: { display: false }, ticks: Object.assign({}, chartTicks, { font: { size: 10 } }) }
      }
    }
  });
}

// ═══ MODULE 6: ROLLING RISK ═══
function mktRenderRolling() {
  var matrix = MKT_STATE.logRetMatrix;
  if (!matrix || matrix.returns.length < 65) {
    document.getElementById('mktRollEmpty').style.display='block';
    document.getElementById('mktRollResults').style.display='none';
    return;
  }
  var primary = MKT_STATE.primary;
  var tickIdx = {}; for (var i=0;i<matrix.tickers.length;i++) tickIdx[matrix.tickers[i]] = i;
  if (!(primary in tickIdx)) {
    document.getElementById('mktRollEmpty').style.display='block';
    document.getElementById('mktRollEmpty').innerHTML='Primary asset not in loaded data.';
    document.getElementById('mktRollResults').style.display='none';
    return;
  }
  var spy = 'SPY';
  if (!(spy in tickIdx)) {
    document.getElementById('mktRollEmpty').style.display='block';
    document.getElementById('mktRollEmpty').innerHTML='SPY is required as benchmark for beta. It should be auto-fetched.';
    document.getElementById('mktRollResults').style.display='none';
    return;
  }
  document.getElementById('mktRollEmpty').style.display='none';
  document.getElementById('mktRollResults').style.display='block';

  var T = matrix.returns.length;
  var rp = [], rspy = [];
  for (var r=0;r<T;r++) { rp.push(matrix.returns[r][tickIdx[primary]]); rspy.push(matrix.returns[r][tickIdx[spy]]); }
  var WIN = 63;
  var rfDaily = 0.053 / 252;
  var labels = MKT_STATE.alignedDates.slice(1); // returns are T-1 long vs dates T long, so align from 1

  var sharpe = [], sortino = [], beta = [];
  for (var t=WIN-1;t<T;t++) {
    var slice = rp.slice(t-WIN+1, t+1);
    var slSpy = rspy.slice(t-WIN+1, t+1);
    var mu = mktMean(slice);
    var std = mktStd(slice);
    var neg = slice.filter(function(v){ return v < 0; });
    var negVar = 0;
    if (neg.length) { for (var nv=0;nv<neg.length;nv++) negVar += neg[nv]*neg[nv]; negVar = negVar/neg.length; }
    var downside = Math.sqrt(negVar);
    sharpe.push(std > 0 ? (mu - rfDaily)/std * Math.sqrt(252) : 0);
    sortino.push(downside > 0 ? (mu - rfDaily)/downside * Math.sqrt(252) : 0);
    // Beta
    var mSpy = mktMean(slSpy);
    var mA = mu;
    var cov = 0, varSpy = 0;
    for (var k=0;k<WIN;k++) { cov += (slice[k]-mA)*(slSpy[k]-mSpy); varSpy += (slSpy[k]-mSpy)*(slSpy[k]-mSpy); }
    beta.push(varSpy > 0 ? cov/varSpy : 1);
  }
  var rollingLabels = labels.slice(WIN-1);

  // Max drawdown on cumulative price
  var prices = MKT_STATE.aligned[primary];
  var ddSeries = [];
  var peak = -Infinity;
  for (var pi=0;pi<prices.length;pi++) { if (prices[pi] > peak) peak = prices[pi]; ddSeries.push(-((peak - prices[pi])/peak)*100); }

  // Chart A — Sharpe & Sortino
  if (MKT_CHARTS.rollSharpe) MKT_CHARTS.rollSharpe.destroy();
  MKT_CHARTS.rollSharpe = new Chart(document.getElementById('mktRollSharpe').getContext('2d'), {
    type: 'line',
    data: {
      labels: rollingLabels,
      datasets: [
        { label: 'Sharpe (63D ann.)', data: sharpe, borderColor: C.navy, borderWidth: 1.8, pointRadius: 0, fill: false, tension: 0.1 },
        { label: 'Sortino (63D ann.)', data: sortino, borderColor: C.blue, borderWidth: 1.8, pointRadius: 0, fill: false, tension: 0.1 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 }, color: C.textSec, boxWidth: 10 } },
        tooltip: chartTooltip
      },
      scales: {
        x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { maxTicksLimit: 8, autoSkip: true }) },
        y: { grid: chartGrid, ticks: chartTicks, title: { display: true, text: 'Ratio', font: { size: 11 }, color: C.textSec } }
      }
    }
  });
  // Chart B — Beta
  if (MKT_CHARTS.rollBeta) MKT_CHARTS.rollBeta.destroy();
  MKT_CHARTS.rollBeta = new Chart(document.getElementById('mktRollBeta').getContext('2d'), {
    type: 'line',
    data: {
      labels: rollingLabels,
      datasets: [
        { label: 'β vs SPY', data: beta, borderColor: C.navy, borderWidth: 1.8, pointRadius: 0, fill: false, tension: 0.1 },
        { label: 'β = 1', data: beta.map(function(){return 1;}), borderColor: C.textSec, borderWidth: 1, borderDash: [4,3], pointRadius: 0, fill: false }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 }, color: C.textSec, boxWidth: 10 } },
        tooltip: chartTooltip
      },
      scales: {
        x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { maxTicksLimit: 8, autoSkip: true }) },
        y: { grid: chartGrid, ticks: chartTicks, title: { display: true, text: 'β', font: { size: 11 }, color: C.textSec } }
      }
    }
  });
  // Chart C — Drawdown
  if (MKT_CHARTS.rollDD) MKT_CHARTS.rollDD.destroy();
  MKT_CHARTS.rollDD = new Chart(document.getElementById('mktRollDD').getContext('2d'), {
    type: 'line',
    data: {
      labels: MKT_STATE.alignedDates,
      datasets: [
        { label: 'Drawdown %', data: ddSeries, borderColor: C.danger, backgroundColor: 'rgba(139,42,42,0.18)', borderWidth: 1.5, pointRadius: 0, fill: true, tension: 0.05 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: Object.assign({}, chartTooltip, { callbacks: { label: function(ctx){ return 'DD: '+ctx.parsed.y.toFixed(2)+'%'; } } })
      },
      scales: {
        x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { maxTicksLimit: 8, autoSkip: true }) },
        y: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { callback: function(v){ return v.toFixed(0)+'%'; } }), title: { display: true, text: 'Drawdown from Peak', font: { size: 11 }, color: C.textSec }, max: 0 }
      }
    }
  });
}

// ═══ MODULE 7: VaR ═══
function mktRenderVaR() {
  var matrix = MKT_STATE.logRetMatrix;
  if (!matrix) { document.getElementById('mktVarEmpty').style.display='block'; document.getElementById('mktVarResults').style.display='none'; return; }
  var primary = MKT_STATE.primary;
  var tickIdx = {}; for (var i=0;i<matrix.tickers.length;i++) tickIdx[matrix.tickers[i]] = i;
  if (!(primary in tickIdx)) {
    document.getElementById('mktVarEmpty').style.display='block';
    document.getElementById('mktVarEmpty').innerHTML='Primary asset not loaded.';
    document.getElementById('mktVarResults').style.display='none';
    return;
  }
  document.getElementById('mktVarEmpty').style.display='none';
  document.getElementById('mktVarResults').style.display='block';

  var T = matrix.returns.length;
  var rets = [];
  var startK = Math.max(0, T - 252);
  for (var r=startK;r<T;r++) rets.push(matrix.returns[r][tickIdx[primary]]);
  var mu = mktMean(rets), sigma = mktStd(rets);
  var skew = mktSkew(rets), ekurt = mktKurt(rets);

  var z95 = 1.645, z99 = 2.326;
  // Parametric
  var parVaR1_95 = -(mu - z95*sigma);
  var parVaR1_99 = -(mu - z99*sigma);
  var parVaR10_95 = parVaR1_95 * Math.sqrt(10);
  var parVaR10_99 = parVaR1_99 * Math.sqrt(10);
  // Historical
  var sorted = rets.slice().sort(function(a,b){return a-b;});
  var histVaR1_95 = -sorted[Math.floor(sorted.length*0.05)];
  var histVaR1_99 = -sorted[Math.floor(sorted.length*0.01)];
  var histVaR10_95 = histVaR1_95 * Math.sqrt(10);
  var histVaR10_99 = histVaR1_99 * Math.sqrt(10);
  // Cornish-Fisher
  function zCF(z, s, k) { return z + ((z*z-1)/6)*s + ((z*z*z-3*z)/24)*k - ((2*z*z*z-5*z)/36)*s*s; }
  var zcf95 = zCF(z95, skew, ekurt);
  var zcf99 = zCF(z99, skew, ekurt);
  var cfVaR1_95 = -(mu - zcf95*sigma);
  var cfVaR1_99 = -(mu - zcf99*sigma);
  var cfVaR10_95 = cfVaR1_95 * Math.sqrt(10);
  var cfVaR10_99 = cfVaR1_99 * Math.sqrt(10);

  function fmt(v) { return (v*100).toFixed(2)+'%'; }

  var cols = [[parVaR1_95,parVaR1_99,parVaR10_95,parVaR10_99],[histVaR1_95,histVaR1_99,histVaR10_95,histVaR10_99],[cfVaR1_95,cfVaR1_99,cfVaR10_95,cfVaR10_99]];
  // Find max (most conservative) per column
  var maxCol = [0,0,0,0];
  for (var cc=0;cc<4;cc++) {
    var mv = -Infinity, mrow = 0;
    for (var rr=0;rr<3;rr++) if (cols[rr][cc] > mv) { mv = cols[rr][cc]; mrow = rr; }
    maxCol[cc] = mrow;
  }
  var methods = ['Parametric (Gaussian)', 'Historical Simulation', 'Cornish-Fisher (fat-tail)'];
  var html = '<thead><tr><th>Method</th><th style="text-align:right;">1D 95%</th><th style="text-align:right;">1D 99%</th><th style="text-align:right;">10D 95%</th><th style="text-align:right;">10D 99%</th></tr></thead><tbody>';
  for (var m=0;m<3;m++) {
    html += '<tr><td style="font-weight:600;">'+methods[m]+'</td>';
    for (var cc2=0;cc2<4;cc2++) {
      var isMax = maxCol[cc2] === m;
      var style = isMax ? 'background:rgba(139,105,20,0.18);font-weight:700;' : '';
      html += '<td style="text-align:right;'+style+'">'+fmt(cols[m][cc2])+'</td>';
    }
    html += '</tr>';
  }
  html += '</tbody>';
  document.getElementById('mktVarTable').innerHTML = html;

  // Stat cards
  var stats = [
    { l: 'Daily Mean', v: mktFmtPct(mu,3), sub: 'μ over '+rets.length+' days' },
    { l: 'Daily σ', v: mktFmtPct(sigma,3), sub: 'Annualized: '+mktFmtPct(sigma*Math.sqrt(252),2) },
    { l: 'Skewness', v: skew.toFixed(3), sub: skew<0?'Left-tailed':'Right-tailed' },
    { l: 'Excess Kurtosis', v: ekurt.toFixed(3), sub: ekurt>0?'Fat-tailed':'Thin-tailed' }
  ];
  var shtml = '';
  for (var ss=0;ss<stats.length;ss++) {
    shtml += '<div class="chart-stat-box"><div class="chart-stat-label">'+stats[ss].l+'</div><div class="chart-stat-value">'+stats[ss].v+'</div><div class="chart-stat-sub">'+stats[ss].sub+'</div></div>';
  }
  document.getElementById('mktVarMoments').innerHTML = shtml;

  // Histogram
  var bins = 20;
  var minR = Math.min.apply(null, rets), maxR = Math.max.apply(null, rets);
  var binW = (maxR - minR) / bins;
  var binLabels = [], binCounts = new Array(bins).fill(0);
  for (var bn=0;bn<bins;bn++) binLabels.push((100*(minR+bn*binW)).toFixed(2)+'%');
  for (var rn=0;rn<rets.length;rn++) {
    var bi = Math.min(bins-1, Math.floor((rets[rn]-minR)/binW));
    binCounts[bi]++;
  }
  // Build vertical line datasets for each VaR (map -VaR value to bin index)
  function vLine(name, varVal, color) {
    var x = -varVal;
    var idx = Math.min(bins-1, Math.max(0, Math.floor((x - minR)/binW)));
    var d = new Array(bins).fill(null);
    d[idx] = Math.max.apply(null, binCounts) * 1.05;
    return { type:'bar', label: name, data: d, backgroundColor: color, borderColor: color, borderWidth: 0, barPercentage: 0.12, categoryPercentage: 0.5 };
  }
  if (MKT_CHARTS.varHist) MKT_CHARTS.varHist.destroy();
  MKT_CHARTS.varHist = new Chart(document.getElementById('mktVarHist').getContext('2d'), {
    type: 'bar',
    data: {
      labels: binLabels,
      datasets: [
        { label: 'Return Distribution', data: binCounts, backgroundColor: 'rgba(0,60,113,0.75)', borderColor: C.navy, borderWidth: 1 },
        vLine('Par. 95%', parVaR1_95, C.blue),
        vLine('Hist. 95%', histVaR1_95, C.success),
        vLine('CF 99%', cfVaR1_99, C.danger)
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 }, color: C.textSec, boxWidth: 10 } },
        tooltip: chartTooltip,
        title: { display: true, text: '1-Day Return Distribution (last 252 days) with VaR overlays', color: C.navy, font: { size: 13, weight: '700' } }
      },
      scales: {
        x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { maxRotation: 45, font: { size: 9 } }) },
        y: { grid: chartGrid, ticks: chartTicks, title: { display: true, text: 'Frequency', font: { size: 10 }, color: C.textSec } }
      }
    }
  });
}

// ═══ MODULE 8: CROSS-ASSET REGIME ═══
var MKT_REGIME_PAIRS = [
  // ── Original 6 ──
  { a: 'XLY', b: 'XLP', label: 'Cyclicals vs. Defensives', interp: 'Rising = risk appetite expanding; falling = defensive rotation and late-cycle concern.' },
  { a: 'XLF', b: 'XLU', label: 'Financials vs. Utilities', interp: 'Rising = steepening curve favoring banks; falling = flattening curve / flight to duration.' },
  { a: 'GLD', b: 'TLT', label: 'Gold vs. Long Bonds', interp: 'Rising = inflation concern dominant; falling = deflationary / disinflationary regime.' },
  { a: 'HYG', b: 'LQD', label: 'High Yield vs. IG Credit', interp: 'Rising = credit risk appetite healthy; falling = spreads widening, credit deterioration.' },
  { a: 'XLB', b: 'XLU', label: 'Materials vs. Utilities', interp: 'Rising = global growth / reflation signal; falling = defensive positioning.' },
  { a: 'XLRE', b: 'TLT', label: 'Real Estate vs. Bonds', interp: 'Rising = real assets favored over duration; falling = rate sensitivity dominant.' },
  // ── New: Market Broadening ──
  { a: 'RSP', b: 'SPY', label: 'Equal-Weight vs. Cap-Weight S&P', interp: 'Rising = market breadth expanding; participation is broad (bullish). Falling = mega-cap concentration, narrow leadership — historically a late-cycle fragility signal. Horvath et al. (2021): divergence in cross-asset distributions signals regime transition.' },
  // ── New: Small Cap vs. Large Cap ──
  { a: 'IWM', b: 'SPY', label: 'Small Cap vs. Large Cap', interp: 'Rising = domestic growth expectations strengthening; small caps lead early cycle recoveries. Falling = risk-off, quality flight, or dollar strength suppressing earnings.' },
  // ── New: Copper/Gold ratio (growth barometer) ──
  { a: 'CPER', b: 'GLD', label: 'Copper vs. Gold (Growth Barometer)', interp: 'The classic Dr. Copper signal. Rising = global manufacturing demand strengthening relative to safe-haven demand — a reliable leading indicator of global growth. Falling = growth deceleration / recessionary demand.' },
  // ── New: Tech concentration risk ──
  { a: 'XLK', b: 'RSP', label: 'Tech vs. Equal-Weight (Concentration Risk)', interp: 'Rising = index performance increasingly driven by mega-cap tech; market returns concentrated. Elevated readings historically precede mean-reversion when growth premium contracts. Linked to RMT: dominant eigenvalue absorption (Molero-González et al. 2024).' },
  // ── New: Energy sector liquidity ──
  { a: 'XLE', b: 'XLF', label: 'Energy vs. Financials', interp: 'Rising = commodity/inflation cycle dominant over credit cycle; real assets preferred. Falling = financial conditions tightening, credit conditions driving leadership. Quantamental signal: tracks where capital is flowing within cyclicals.' }
];

// ── Regime Signal Composite ──────────────────────────────────────────────────
// After loading regime pairs, compute a composite directional score.
// Each pair contributes +1 (Risk-On: ratio > 20D SMA) or -1 (Risk-Off: ratio < SMA).
// RSP/SPY and IWM/SPY get 2x weight as primary breadth indicators.
// Score is normalized to [0, 100] and stored in window._regimeSignalScore
// for consumption by tlPillar_SectorRotation and the master verdict.
// ─────────────────────────────────────────────────────────────────────────────
function computeRegimeSignalComposite(pairResults) {
  // pairResults: array of { risk: 'Risk-On'|'Risk-Off', pair: MKT_REGIME_PAIRS[i] }
  var totalWeight = 0;
  var weightedScore = 0;
  var BREADTH_PAIRS = ['RSP/SPY', 'IWM/SPY'];
  pairResults.forEach(function(r) {
    var label = r.pair.a + '/' + r.pair.b;
    var w = BREADTH_PAIRS.indexOf(label) >= 0 ? 2 : 1; // breadth pairs weighted 2x
    totalWeight += w;
    weightedScore += (r.risk === 'Risk-On' ? 1 : -1) * w;
  });
  // Normalize to [0, 100]: score of totalWeight = 100, -totalWeight = 0
  var normalized = totalWeight > 0 ? ((weightedScore + totalWeight) / (2 * totalWeight)) * 100 : 50;
  window._regimeSignalScore = normalized;
  window._regimeSignalDetail = pairResults.map(function(r){ return r.pair.a+'/'+r.pair.b+': '+r.risk; }).join(' | ');
  return normalized;
}

async function mktLoadRegime() {
  var emptyEl = document.getElementById('mktRegimeEmpty');
  emptyEl.innerHTML = '<span class="spinner"></span> Loading tickers for ratio pairs...';
  var needed = {};
  for (var p=0;p<MKT_REGIME_PAIRS.length;p++) { needed[MKT_REGIME_PAIRS[p].a] = 1; needed[MKT_REGIME_PAIRS[p].b] = 1; }
  var tickers = Object.keys(needed);
  var data = {};
  var errors = [];
  for (var i=0;i<tickers.length;i++) {
    try {
      var d = await fetchChart(tickers[i], '2y', '1d');
      data[tickers[i]] = (d.points || []).filter(function(p){ return p.close != null; }).map(function(p){ return { date: p.date.slice(0,10), close: p.close }; });
    } catch(e) { errors.push(tickers[i]); }
  }
  if (errors.length > 4) { emptyEl.innerHTML = 'Failed to load: ' + errors.join(', ') + '. <button class="btn btn-sm" onclick="mktLoadRegime()">Retry</button>'; return; }
  emptyEl.style.display = 'none';
  var grid = document.getElementById('mktRegimeGrid');
  grid.style.display = 'block';
  grid.innerHTML = '';

  // First pass: compute all pair ratios and Risk-On/Risk-Off classification
  var pairResults = [];
  for (var pi=0; pi<MKT_REGIME_PAIRS.length; pi++) {
    var pair = MKT_REGIME_PAIRS[pi];
    if (!data[pair.a] || !data[pair.b]) { pairResults.push({ pair: pair, risk: 'Risk-Off', cur: null, curSMA: null, ratio: [], sma: [], dates: [], error: true }); continue; }
    var mapA = {}; data[pair.a].forEach(function(p){ mapA[p.date]=p.close; });
    var mapB = {}; data[pair.b].forEach(function(p){ mapB[p.date]=p.close; });
    var dates = data[pair.a].map(function(p){return p.date;}).filter(function(d){ return mapB[d]; });
    dates.sort();
    var ratio = dates.map(function(d){ return mapA[d]/mapB[d]; });
    var sma63 = []; // 63-day SMA to reduce noise (vs. prior 20D — monthly smoothing)
    for (var k=0;k<ratio.length;k++) {
      if (k < 62) { sma63.push(null); continue; }
      var ss = 0; for (var kk=k-62;kk<=k;kk++) ss += ratio[kk];
      sma63.push(ss/63);
    }
    var cur = ratio[ratio.length-1];
    var curSMA = sma63[sma63.length-1];
    var risk = curSMA != null && cur > curSMA ? 'Risk-On' : 'Risk-Off';
    pairResults.push({ pair: pair, risk: risk, cur: cur, curSMA: curSMA, ratio: ratio, sma: sma63, dates: dates });
  }

  // Compute composite and store for master verdict
  var compositeScore = computeRegimeSignalComposite(pairResults);
  var riskOnCount = pairResults.filter(function(r){ return r.risk === 'Risk-On'; }).length;
  var compositeColor = compositeScore >= 65 ? C.success : compositeScore >= 40 ? '#8B6914' : C.danger;
  var compositeLabel = compositeScore >= 65 ? 'Risk-On Dominant' : compositeScore >= 40 ? 'Mixed / Transitioning' : 'Risk-Off Dominant';

  // ── Composite Header ──
  var headerHtml = '<div style="background:var(--navy);color:#fff;border-radius:4px;padding:12px 16px;margin-bottom:14px;display:flex;align-items:center;gap:20px;flex-wrap:wrap;">'
    + '<div style="flex:1;min-width:200px;">'
    + '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.8px;opacity:.7;margin-bottom:2px;">Cross-Asset Regime Composite</div>'
    + '<div style="font-size:22px;font-weight:800;">' + compositeLabel + '</div>'
    + '<div style="font-size:11px;opacity:.75;margin-top:2px;">' + riskOnCount + ' of ' + pairResults.length + ' pairs in Risk-On &middot; Breadth signals weighted 2×</div>'
    + '</div>'
    + '<div style="text-align:right;">'
    + '<div style="font-size:11px;opacity:.7;margin-bottom:2px;">Regime Score</div>'
    + '<div style="font-size:36px;font-weight:800;color:' + compositeColor + ';">' + Math.round(compositeScore) + '</div>'
    + '<div style="font-size:10px;opacity:.6;">/ 100 (RSP/SPY + IWM/SPY weighted 2×)</div>'
    + '</div>'
    + '</div>'
    // Breadth spotlight
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">';

  // Spotlight: RSP/SPY breadth and CPER/GLD
  ['RSP/SPY', 'CPER/GLD'].forEach(function(label) {
    var pr = pairResults.find(function(r){ return r.pair.a+'/'+r.pair.b === label; });
    if (!pr) return;
    var col = pr.risk === 'Risk-On' ? C.success : C.danger;
    var pctVsSMA = pr.cur && pr.curSMA ? ((pr.cur - pr.curSMA) / pr.curSMA * 100) : null;
    // 3-month vs 12-month ratio change
    var r3m = pr.ratio.length >= 63 ? ((pr.ratio[pr.ratio.length-1] / pr.ratio[pr.ratio.length-64]) - 1) * 100 : null;
    var r12m = pr.ratio.length >= 252 ? ((pr.ratio[pr.ratio.length-1] / pr.ratio[pr.ratio.length-253]) - 1) * 100 : null;
    var spotTitle = label === 'RSP/SPY' ? '🟦 Market Broadening Signal' : '🟤 Growth vs. Safe-Haven (Dr. Copper)';
    headerHtml += '<div style="background:var(--panel);border:1px solid var(--border);border-left:3px solid '+col+';border-radius:4px;padding:10px 14px;">'
      + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text-sec);margin-bottom:4px;">'+spotTitle+'</div>'
      + '<div style="font-size:13px;font-weight:700;color:'+col+';">'+pr.risk+'</div>'
      + '<div style="font-size:11px;color:var(--text-sec);margin-top:4px;">'
      + 'Ratio vs 63D SMA: ' + (pctVsSMA != null ? (pctVsSMA >= 0 ? '+' : '') + pctVsSMA.toFixed(1) + '%' : '—') + ' &nbsp;|&nbsp; '
      + '3M chg: ' + (r3m != null ? (r3m >= 0 ? '+' : '') + r3m.toFixed(1) + '%' : '—') + ' &nbsp;|&nbsp; '
      + '12M chg: ' + (r12m != null ? (r12m >= 0 ? '+' : '') + r12m.toFixed(1) + '%' : '—')
      + '</div>'
      + '<div style="font-size:10.5px;color:var(--text-sec);margin-top:5px;line-height:1.4;">'+pr.pair.interp+'</div>'
      + '</div>';
  });
  headerHtml += '</div>';
  headerHtml += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;" id="mktRegimeGridInner"></div>';
  grid.innerHTML = headerHtml;
    // Align dates
    var mapA = {}; data[pair.a].forEach(function(p){ mapA[p.date]=p.close; });
    var mapB = {}; data[pair.b].forEach(function(p){ mapB[p.date]=p.close; });
    var dates = data[pair.a].map(function(p){return p.date;}).filter(function(d){ return mapB[d]; });
    dates.sort();
    var ratio = dates.map(function(d){ return mapA[d]/mapB[d]; });
    // 20D SMA
    var sma = [];
    for (var k=0;k<ratio.length;k++) {
      if (k < 19) { sma.push(null); continue; }
      var ss = 0; for (var kk=k-19;kk<=k;kk++) ss += ratio[kk];
      sma.push(ss/20);
    }
    var cur = ratio[ratio.length-1];
    var prev = ratio[ratio.length-2];
    var curSMA = sma[sma.length-1];
    var direction = cur > prev ? '▲' : (cur < prev ? '▼' : '●');
    var regime = curSMA != null && cur > curSMA ? 'Risk-On' : 'Risk-Off';
    var regimeColor = regime === 'Risk-On' ? C.success : C.danger;

    var canvasId = 'mktReg_'+pi;
    var html = '<div style="background:var(--bg);border:1px solid var(--border);border-radius:4px;overflow:hidden;">'
      + '<div style="background:var(--navy);color:var(--text-on-dark);padding:6px 10px;font-size:11.5px;font-weight:700;display:flex;justify-content:space-between;align-items:center;">'
      + '<span>'+pair.a+' / '+pair.b+' &mdash; '+pair.label+'</span>'
      + '<span style="font-size:10px;background:'+regimeColor+';padding:2px 8px;border-radius:10px;">'+regime+'</span>'
      + '</div>'
      + '<div style="padding:8px 10px;display:flex;justify-content:space-between;align-items:center;font-size:11px;">'
      + '<div><span style="color:var(--text-sec);">Current:</span> <strong>'+cur.toFixed(3)+'</strong> <span style="color:'+regimeColor+';font-weight:700;">'+direction+'</span></div>'
      + '<div style="color:var(--text-sec);">20D SMA: '+(curSMA != null ? curSMA.toFixed(3) : '-')+'</div>'
      + '</div>'
      + '<div style="height:160px;padding:4px 8px 8px;"><canvas id="'+canvasId+'"></canvas></div>'
      + '<div style="padding:6px 10px;font-size:10.5px;color:var(--text-sec);border-top:1px solid var(--border);background:var(--panel);line-height:1.5;">'+pair.interp+'</div>'
      + '</div>';
  // ── Render individual pair cards into inner grid ──
  var innerGrid = document.getElementById('mktRegimeGridInner');
  for (var pi=0; pi<pairResults.length; pi++) {
    var pr = pairResults[pi];
    var pair = pr.pair;
    var cur = pr.cur, curSMA = pr.curSMA, ratio = pr.ratio, sma = pr.sma, dates = pr.dates;
    var regime = pr.risk;
    var regimeColor = regime === 'Risk-On' ? C.success : C.danger;
    var prev = ratio.length >= 2 ? ratio[ratio.length-2] : cur;
    var direction = cur > prev ? '▲' : (cur < prev ? '▼' : '●');
    var pctVsSMA = cur && curSMA ? ((cur - curSMA) / curSMA * 100) : null;
    var canvasId = 'mktReg_'+pi;
    var html = '<div style="background:var(--bg);border:1px solid var(--border);border-left:3px solid '+regimeColor+';border-radius:4px;overflow:hidden;">'
      + '<div style="background:var(--navy);color:var(--text-on-dark);padding:6px 10px;font-size:11.5px;font-weight:700;display:flex;justify-content:space-between;align-items:center;">'
      + '<span>'+pair.a+' / '+pair.b+' &mdash; '+pair.label+'</span>'
      + '<span style="font-size:10px;background:'+regimeColor+';padding:2px 8px;border-radius:10px;">'+regime+'</span>'
      + '</div>'
      + '<div style="padding:8px 10px;display:flex;justify-content:space-between;align-items:center;font-size:11px;">'
      + '<div><span style="color:var(--text-sec);">Current:</span> <strong>'+(cur != null ? cur.toFixed(3) : '—')+'</strong> <span style="color:'+regimeColor+';font-weight:700;">'+direction+'</span></div>'
      + '<div style="color:var(--text-sec);">63D SMA: '+(curSMA != null ? curSMA.toFixed(3) : '-')+' &nbsp; <span style="color:'+regimeColor+';">'+(pctVsSMA != null ? (pctVsSMA >= 0 ? '+' : '') + pctVsSMA.toFixed(1) + '% vs SMA' : '')+'</span></div>'
      + '</div>'
      + '<div style="height:160px;padding:4px 8px 8px;"><canvas id="'+canvasId+'"></canvas></div>'
      + '<div style="padding:6px 10px;font-size:10.5px;color:var(--text-sec);border-top:1px solid var(--border);background:var(--panel);line-height:1.5;">'+pair.interp+'</div>'
      + '</div>';
    innerGrid.innerHTML += html;
  }

  // ── Render charts ──
  for (var ri=0; ri<pairResults.length; ri++) {
    (function(ri){
      var pr = pairResults[ri];
      if (pr.error || !pr.ratio.length) return;
      var ratio = pr.ratio, sma = pr.sma, dates = pr.dates;
      var aboveData = ratio.map(function(v,idx){ return sma[idx] != null && v >= sma[idx] ? v : null; });
      var belowData = ratio.map(function(v,idx){ return sma[idx] != null && v < sma[idx] ? v : null; });
      var canvas = document.getElementById('mktReg_'+ri);
      if (!canvas) return;
      if (MKT_CHARTS['reg_'+ri]) MKT_CHARTS['reg_'+ri].destroy();
      MKT_CHARTS['reg_'+ri] = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: dates,
          datasets: [
            { label: 'Ratio', data: ratio, borderColor: C.navy, borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.1 },
            { label: '63D SMA', data: sma, borderColor: C.blue, borderWidth: 1.2, borderDash: [5,3], pointRadius: 0, fill: false },
            { label: 'Risk-On', data: aboveData, borderColor: 'transparent', backgroundColor: 'rgba(46,125,82,0.12)', pointRadius: 0, fill: '+1' },
            { label: 'Risk-Off', data: belowData, borderColor: 'transparent', backgroundColor: 'rgba(139,42,42,0.12)', pointRadius: 0, fill: 'origin' }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: Object.assign({}, chartTooltip, { callbacks: { label: function(ctx){ return ctx.parsed.y != null ? ctx.parsed.y.toFixed(3) : ''; } } }) },
          scales: {
            x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { maxTicksLimit: 5, font: { size: 9 }, autoSkip: true }) },
            y: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { font: { size: 9 } }) }
          }
        }
      });
    })(ri);
  }
}

// ═══ MARKET BROADENING ═══
var _mktBroadeningCharts = {};
async function mktLoadBroadening() {
  var resultEl = document.getElementById('mktBroadeningResult');
  resultEl.innerHTML = '<span class="spinner"></span> Loading RSP, IWM, SPY...';
  try {
    var [rspD, iwmD, spyD] = await Promise.all([
      fetchChart('RSP', '2y', '1d'),
      fetchChart('IWM', '2y', '1d'),
      fetchChart('SPY', '2y', '1d')
    ]);
    function toMap(pts) {
      var m = {};
      (pts || []).filter(function(p){ return p.close != null; }).forEach(function(p){ m[p.date.slice(0,10)] = p.close; });
      return m;
    }
    var rspM = toMap(rspD.points), iwmM = toMap(iwmD.points), spyM = toMap(spyD.points);
    var dates = Object.keys(spyM).filter(function(d){ return rspM[d] && iwmM[d]; }).sort();

    function sma63(arr) {
      return arr.map(function(v, i) {
        if (i < 62) return null;
        var s = 0; for (var k = i-62; k <= i; k++) s += arr[k];
        return s / 63;
      });
    }

    var rspSpyRatio = dates.map(function(d){ return rspM[d] / spyM[d]; });
    var iwmSpyRatio = dates.map(function(d){ return iwmM[d] / spyM[d]; });
    var rspSmooth = sma63(rspSpyRatio);
    var iwmSmooth = sma63(iwmSpyRatio);

    var rspCur = rspSpyRatio[rspSpyRatio.length-1];
    var rspSMA = rspSmooth[rspSmooth.length-1];
    var iwmCur = iwmSpyRatio[iwmSpyRatio.length-1];
    var iwmSMA = iwmSmooth[iwmSmooth.length-1];
    var rsp3m = rspSpyRatio.length >= 63 ? ((rspCur / rspSpyRatio[rspSpyRatio.length-64]) - 1) * 100 : null;
    var iwm3m = iwmSpyRatio.length >= 63 ? ((iwmCur / iwmSpyRatio[iwmSpyRatio.length-64]) - 1) * 100 : null;
    var rsp12m = rspSpyRatio.length >= 252 ? ((rspCur / rspSpyRatio[rspSpyRatio.length-253]) - 1) * 100 : null;

    var rspAboveSMA = rspSMA != null && rspCur > rspSMA;
    var iwmAboveSMA = iwmSMA != null && iwmCur > iwmSMA;
    var broadeningSignal = rspAboveSMA && iwmAboveSMA ? 'Broadening' : (!rspAboveSMA && !iwmAboveSMA ? 'Narrowing' : 'Mixed');
    var signalColor = broadeningSignal === 'Broadening' ? C.success : broadeningSignal === 'Narrowing' ? C.danger : '#8B6914';

    resultEl.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:14px;">'
      + '<div style="background:var(--panel);border:1px solid var(--border);border-left:4px solid '+signalColor+';border-radius:4px;padding:10px 14px;">'
      + '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-sec);margin-bottom:4px;">Broadening Signal</div>'
      + '<div style="font-size:20px;font-weight:800;color:'+signalColor+';">'+broadeningSignal+'</div>'
      + '<div style="font-size:11px;color:var(--text-sec);margin-top:4px;">RSP/SPY '+(rspAboveSMA ? '▲ above' : '▼ below')+' 63D SMA &nbsp;·&nbsp; IWM/SPY '+(iwmAboveSMA ? '▲ above' : '▼ below')+' 63D SMA</div>'
      + '</div>'
      + '<div style="background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:10px 14px;">'
      + '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-sec);">RSP/SPY Ratio</div>'
      + '<div style="font-size:15px;font-weight:700;">' + rspCur.toFixed(4) + '</div>'
      + '<div style="font-size:11px;color:var(--text-sec);">3M: '+(rsp3m != null ? (rsp3m >= 0 ? '+' : '') + rsp3m.toFixed(1) + '%' : '—')+' &nbsp;·&nbsp; 12M: '+(rsp12m != null ? (rsp12m >= 0 ? '+' : '') + rsp12m.toFixed(1) + '%' : '—')+'</div>'
      + '</div>'
      + '<div style="background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:10px 14px;">'
      + '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-sec);">IWM/SPY Ratio</div>'
      + '<div style="font-size:15px;font-weight:700;">' + iwmCur.toFixed(4) + '</div>'
      + '<div style="font-size:11px;color:var(--text-sec);">3M: '+(iwm3m != null ? (iwm3m >= 0 ? '+' : '') + iwm3m.toFixed(1) + '%' : '—')+'</div>'
      + '</div>'
      + '</div>';

    // Render charts
    document.getElementById('mktRspSpyWrap').style.display = 'block';
    document.getElementById('mktIwmSpyWrap').style.display = 'block';
    function renderBroadeningChart(canvasId, labels, ratio, smaSmooth, title) {
      var ctx = document.getElementById(canvasId);
      if (!ctx) return;
      if (_mktBroadeningCharts[canvasId]) _mktBroadeningCharts[canvasId].destroy();
      _mktBroadeningCharts[canvasId] = new Chart(ctx.getContext('2d'), {
        type: 'line',
        data: { labels: labels, datasets: [
          { label: title, data: ratio, borderColor: C.navy, borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.1 },
          { label: '63D SMA', data: smaSmooth, borderColor: C.blue, borderWidth: 1.5, borderDash: [5,3], pointRadius: 0, fill: false }
        ]},
        options: { responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: true, labels: { font: { size: 10 }, color: C.textSec } }, tooltip: chartTooltip },
          scales: {
            x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { maxTicksLimit: 5, font: { size: 9 }, autoSkip: true }) },
            y: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { font: { size: 9 }, callback: function(v){ return v.toFixed(3); } }) }
          }
        }
      });
    }
    renderBroadeningChart('mktRspSpyChart', dates, rspSpyRatio, rspSmooth, 'RSP/SPY');
    renderBroadeningChart('mktIwmSpyChart', dates, iwmSpyRatio, iwmSmooth, 'IWM/SPY');
  } catch(e) {
    document.getElementById('mktBroadeningResult').innerHTML = '<span style="color:var(--danger);">Error: ' + e.message + '</span>';
  }
}

// ═══ SECTOR LIQUIDITY FLOW ═══
async function mktLoadSectorFlow() {
  var resultEl = document.getElementById('mktSectorFlowResult');
  resultEl.innerHTML = '<span class="spinner"></span> Loading 11 sectors + SPY...';
  var sectors = [
    { t: 'XLK', name: 'Technology', group: 'Growth' },
    { t: 'XLY', name: 'Consumer Disc.', group: 'Cyclical' },
    { t: 'XLI', name: 'Industrials', group: 'Cyclical' },
    { t: 'XLF', name: 'Financials', group: 'Cyclical' },
    { t: 'XLE', name: 'Energy', group: 'Cyclical' },
    { t: 'XLB', name: 'Materials', group: 'Cyclical' },
    { t: 'XLRE', name: 'Real Estate', group: 'Cyclical' },
    { t: 'XLC', name: 'Comm. Services', group: 'Growth' },
    { t: 'XLP', name: 'Consumer Staples', group: 'Defensive' },
    { t: 'XLV', name: 'Health Care', group: 'Defensive' },
    { t: 'XLU', name: 'Utilities', group: 'Defensive' }
  ];
  var PERIODS = [21, 63]; // 1M = 21 trading days, 3M = 63

  try {
    var data = {};
    await Promise.all(sectors.concat([{t:'SPY'}]).map(async function(s) {
      var d = await fetchChart(s.t, '6mo', '1d');
      data[s.t] = (d.points || []).filter(function(p){ return p.close != null; });
    }));

    function pctRet(pts, nDays) {
      if (!pts || pts.length < nDays + 1) return null;
      var c = pts[pts.length-1].close;
      var p = pts[pts.length - nDays - 1].close;
      return p > 0 ? (c / p - 1) * 100 : null;
    }

    var spyPts = data['SPY'];
    var results = sectors.map(function(s) {
      var pts = data[s.t];
      var r1m = pctRet(pts, 21), spy1m = pctRet(spyPts, 21);
      var r3m = pctRet(pts, 63), spy3m = pctRet(spyPts, 63);
      var ex1m = (r1m != null && spy1m != null) ? r1m - spy1m : null;
      var ex3m = (r3m != null && spy3m != null) ? r3m - spy3m : null;
      // Composite excess: 40% 1M + 60% 3M
      var composite = (ex1m != null && ex3m != null) ? 0.4 * ex1m + 0.6 * ex3m
                    : (ex3m != null ? ex3m : (ex1m != null ? ex1m : null));
      return { ticker: s.t, name: s.name, group: s.group, ex1m: ex1m, ex3m: ex3m, composite: composite };
    });

    // Sort by composite descending
    results.sort(function(a, b) { return (b.composite || -99) - (a.composite || -99); });

    // Assign flow labels
    results.forEach(function(r, i) {
      r.flow = i < 4 ? 'Inflow' : i >= 7 ? 'Outflow' : 'Neutral';
      r.flowColor = r.flow === 'Inflow' ? C.success : r.flow === 'Outflow' ? C.danger : '#8B6914';
    });

    // Narrative: identify dominant rotation theme
    var inflowGroups = results.filter(function(r){ return r.flow === 'Inflow'; }).map(function(r){ return r.group; });
    var outflowGroups = results.filter(function(r){ return r.flow === 'Outflow'; }).map(function(r){ return r.name; });
    function mode(arr) { var counts = {}; arr.forEach(function(v){ counts[v] = (counts[v]||0)+1; }); return Object.keys(counts).sort(function(a,b){return counts[b]-counts[a];})[0]; }
    var inflowTheme = mode(inflowGroups) || '—';
    var narrativeMap = {
      'Defensive': 'Defensive rotation — capital moving to safety. Consistent with Risk-Off / late-cycle positioning.',
      'Cyclical': 'Cyclical inflow — growth and reflation trade active. Early/mid-cycle signal.',
      'Growth': 'Growth leadership — tech/comms leading. Risk appetite elevated but watch for concentration.'
    };
    var narrative = narrativeMap[inflowTheme] || 'Mixed rotation — no dominant theme identified.';

    var html = '<div style="background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:10px 14px;margin-bottom:12px;font-size:12px;">'
      + '<strong>Rotation Narrative:</strong> ' + narrative
      + ' <span style="color:var(--text-sec);">Inflows concentrated in: ' + inflowTheme + ' sectors.</span>'
      + ' <span style="color:var(--text-sec);">Outflows from: ' + outflowGroups.join(', ') + '.</span>'
      + '</div>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;">';

    results.forEach(function(r) {
      html += '<div style="background:var(--bg);border:1px solid var(--border);border-left:4px solid '+r.flowColor+';border-radius:4px;padding:8px 12px;">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">'
        + '<strong style="font-size:12px;">'+r.ticker+'</strong>'
        + '<span style="font-size:10px;background:'+r.flowColor+';color:#fff;padding:1px 7px;border-radius:10px;">'+r.flow+'</span>'
        + '</div>'
        + '<div style="font-size:10.5px;color:var(--text-sec);margin-bottom:4px;">'+r.name+'</div>'
        + '<div style="font-size:11px;display:flex;gap:12px;">'
        + '<span>1M vs SPY: <strong style="color:'+(r.ex1m != null && r.ex1m >= 0 ? C.success : C.danger)+';">'+(r.ex1m != null ? (r.ex1m >= 0 ? '+' : '') + r.ex1m.toFixed(1) + '%' : '—')+'</strong></span>'
        + '<span>3M vs SPY: <strong style="color:'+(r.ex3m != null && r.ex3m >= 0 ? C.success : C.danger)+';">'+(r.ex3m != null ? (r.ex3m >= 0 ? '+' : '') + r.ex3m.toFixed(1) + '%' : '—')+'</strong></span>'
        + '</div>'
        + '</div>';
    });
    html += '</div>';
    resultEl.innerHTML = html;
  } catch(e) {
    resultEl.innerHTML = '<span style="color:var(--danger);">Error: ' + e.message + '</span>';
  }
}

// ═══ QUANTAMENTAL COMPOSITE (Cain 2023) ═══
// Combines FRED macro fundamental scores with price momentum technical scores.
// Each macro pillar is mapped to its most representative sector ETF.
// F_score = FRED pillar score normalized to [-1,+1]
// T_score = 3M excess return vs SPY normalized to [-1,+1] via rank
// Quadrant: both+ = Quant-Confirm (high conviction), mixed = divergence, both- = Quant-Avoid
async function mktLoadQuantamental() {
  var el = document.getElementById('mktQuantResult');
  el.innerHTML = '<span class="spinner"></span> Building quantamental composite...';

  // Map macro pillars to sector ETFs
  var PILLAR_SECTOR_MAP = [
    { pillar: 'Growth Analysis',    etfs: ['XLI','XLB'],     label: 'Growth / Industrial' },
    { pillar: 'Labor Market',       etfs: ['XLY','XLC'],     label: 'Consumer / Services' },
    { pillar: 'Inflation',          etfs: ['XLE','GLD'],     label: 'Energy / Real Assets' },
    { pillar: 'Monetary Policy',    etfs: ['XLF','TLT'],     label: 'Financials / Duration' },
    { pillar: 'Fiscal Policy',      etfs: ['XLK','QQQ'],     label: 'Tech / Growth' },
    { pillar: 'Global Liquidity',   etfs: ['XLP','XLV'],     label: 'Defensive / Staples' }
  ];

  try {
    // Get FRED pillar scores (already loaded if user has visited Macro page)
    var macroData = window._lastMacroData;
    if (!macroData || !macroData.pillarScores) {
      el.innerHTML = '<div style="color:var(--text-sec);font-size:12px;padding:10px;">Navigate to <button class="btn btn-sm" onclick="navigateTo(\'macro\');loadMacroLiveTable(true)">Macro Regime Analysis</button> first to load FRED data, then return here.</div>';
      return;
    }

    // Build fundamental score map
    var fScoreMap = {};
    macroData.pillarScores.forEach(function(ps) {
      var maxPossible = ps.count; // each indicator ∈ {-1,0,+1}
      fScoreMap[ps.name] = maxPossible > 0 ? ps.score / maxPossible : 0; // normalize to [-1,+1]
    });

    // Fetch technical momentum for all needed ETFs
    var allEtfs = [];
    PILLAR_SECTOR_MAP.forEach(function(p){ p.etfs.forEach(function(e){ if(allEtfs.indexOf(e)<0) allEtfs.push(e); }); });
    allEtfs.push('SPY');
    var techData = {};
    await Promise.all(allEtfs.map(async function(t) {
      try {
        var d = await fetchChart(t, '6mo', '1d');
        techData[t] = (d.points||[]).filter(function(p){return p.close!=null;});
      } catch(e) { techData[t] = []; }
    }));

    function pctRet3m(pts) {
      if (!pts || pts.length < 64) return null;
      return (pts[pts.length-1].close / pts[pts.length-64].close) - 1;
    }
    var spy3m = pctRet3m(techData['SPY']);

    // Compute T_score for each pillar (avg excess return of mapped ETFs)
    var tScores = {};
    PILLAR_SECTOR_MAP.forEach(function(p) {
      var exRets = p.etfs.map(function(e) {
        var r3m = pctRet3m(techData[e]);
        return (r3m != null && spy3m != null) ? r3m - spy3m : null;
      }).filter(function(v){return v!=null;});
      tScores[p.pillar] = exRets.length ? exRets.reduce(function(s,v){return s+v;},0)/exRets.length : null;
    });

    // Normalize T_scores to [-1,+1] via rank (6 pillars)
    var tScoreVals = PILLAR_SECTOR_MAP.map(function(p){return {pillar:p.pillar, raw:tScores[p.pillar]};}).filter(function(x){return x.raw!=null;});
    tScoreVals.sort(function(a,b){return a.raw-b.raw;});
    var tNorm = {};
    tScoreVals.forEach(function(x,i){ tNorm[x.pillar] = (tScoreVals.length > 1) ? -1 + 2*i/(tScoreVals.length-1) : 0; });

    // Compute quadrant and conviction score
    var results = PILLAR_SECTOR_MAP.map(function(p) {
      var fScore = fScoreMap[p.pillar] != null ? fScoreMap[p.pillar] : 0;
      var tScore = tNorm[p.pillar] != null ? tNorm[p.pillar] : 0;
      var conviction = fScore * tScore; // [-1,+1], positive = both agree
      var quadrant, qColor;
      if (fScore > 0.1 && tScore > 0.1)        { quadrant='Quant-Confirm ✓';   qColor=C.success; }
      else if (fScore > 0.1 && tScore <= 0.1)  { quadrant='Fund-Led (Early?)'; qColor=C.navy; }
      else if (fScore <= 0.1 && tScore > 0.1)  { quadrant='Tech-Led (Caution)';qColor='#8B6914'; }
      else                                      { quadrant='Quant-Avoid ✗';     qColor=C.danger; }
      return { pillar: p.pillar, label: p.label, etfs: p.etfs, fScore: fScore, tScore: tScore, conviction: conviction, quadrant: quadrant, qColor: qColor };
    });
    results.sort(function(a,b){return b.conviction-a.conviction;});

    // ── Render ──
    var html = '<div style="margin-bottom:10px;font-size:11px;color:var(--text-sec);">F-Score = FRED pillar normalized score [-1,+1] &nbsp;·&nbsp; T-Score = 3M sector excess return vs. SPY, ranked [-1,+1] &nbsp;·&nbsp; Conviction = F × T</div>';
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;">';
    results.forEach(function(r) {
      var convW = Math.abs(r.conviction) * 100;
      var convColor = r.conviction > 0 ? C.success : C.danger;
      html += '<div style="background:var(--bg);border:1px solid var(--border);border-left:4px solid '+r.qColor+';border-radius:4px;padding:10px 14px;">'
        + '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">'
        + '<div><div style="font-size:12px;font-weight:700;">'+r.label+'</div>'
        + '<div style="font-size:10px;color:var(--text-sec);">'+r.etfs.join(' · ')+'</div></div>'
        + '<span style="font-size:10px;background:'+r.qColor+';color:#fff;padding:2px 7px;border-radius:10px;white-space:nowrap;">'+r.quadrant+'</span>'
        + '</div>'
        + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;font-size:11px;margin-bottom:6px;">'
        + '<div style="text-align:center;"><div style="color:var(--text-sec);font-size:9px;margin-bottom:1px;">F-SCORE</div><div style="font-weight:700;color:'+(r.fScore>=0?C.success:C.danger)+'">'+(r.fScore>=0?'+':'')+r.fScore.toFixed(2)+'</div></div>'
        + '<div style="text-align:center;"><div style="color:var(--text-sec);font-size:9px;margin-bottom:1px;">T-SCORE</div><div style="font-weight:700;color:'+(r.tScore>=0?C.success:C.danger)+'">'+(r.tScore>=0?'+':'')+r.tScore.toFixed(2)+'</div></div>'
        + '<div style="text-align:center;"><div style="color:var(--text-sec);font-size:9px;margin-bottom:1px;">CONVICTION</div><div style="font-weight:700;color:'+convColor+'">'+(r.conviction>=0?'+':'')+r.conviction.toFixed(2)+'</div></div>'
        + '</div>'
        + '<div style="background:var(--border);border-radius:2px;height:5px;overflow:hidden;">'
        + '<div style="width:'+convW.toFixed(0)+'%;height:100%;background:'+convColor+';border-radius:2px;"></div>'
        + '</div>'
        + '</div>';
    });
    html += '</div>';
    html += '<div style="margin-top:12px;font-size:11px;color:var(--text-sec);line-height:1.5;"><strong>Interpretation:</strong> <strong>Quant-Confirm</strong> = both macro fundamentals and price momentum agree → highest conviction thesis. <strong>Fundamental-Led</strong> = fundamentals bullish but price not yet reflecting → potential early entry or value trap. <strong>Technical-Led</strong> = price momentum ahead of fundamentals → momentum regime, watch for reversal. <strong>Quant-Avoid</strong> = both signals negative → underweight.</div>';
    el.innerHTML = html;
  } catch(e) {
    el.innerHTML = '<span style="color:var(--danger);">Error: '+e.message+'</span>';
  }
}

// ═══ OMEGA RATIO (Lyu et al. 2023) ═══
// Ω(τ) = E[max(R-τ,0)] / E[max(τ-R,0)]
// Computed from empirical 63-day rolling return distribution.
// Regime-conditioned: threshold adjusted per Perry state.
async function mktLoadOmega() {
  var el = document.getElementById('mktOmegaResult');
  el.innerHTML = '<span class="spinner"></span> Computing Omega ratios...';
  var tauBase = parseFloat(document.getElementById('omegaTau').value) || 0.0002;
  var perryState = window._perryState || 'neutral';
  // Regime-condition the threshold per Lyu et al. (2023): in stress regimes,
  // use a lower threshold (more conservative); in leveraged regime, raise threshold.
  var tauMult = { leveraged: 1.5, growth: 1.0, neutral: 0.8, drawdown: 0.5 };
  var tau = tauBase * (tauMult[perryState] || 1.0);
  var assets = [
    { t:'SPY',  label:'S&P 500 (SPY)',    group:'Equity' },
    { t:'QQQ',  label:'Nasdaq 100 (QQQ)', group:'Equity' },
    { t:'IWM',  label:'Small Cap (IWM)',  group:'Equity' },
    { t:'TLT',  label:'Long Bonds (TLT)', group:'Fixed Income' },
    { t:'GLD',  label:'Gold (GLD)',        group:'Real Asset' },
    { t:'HYG',  label:'High Yield (HYG)', group:'Credit' }
  ];
  try {
    var data = {};
    await Promise.all(assets.map(async function(a) {
      try {
        var d = await fetchChart(a.t, '6mo', '1d');
        data[a.t] = (d.points||[]).filter(function(p){return p.close!=null;});
      } catch(e) { data[a.t]=[]; }
    }));

    function omegaRatio(pts, tau) {
      if (!pts || pts.length < 30) return null;
      var recent = pts.slice(-63);
      var rets = [];
      for (var i=1;i<recent.length;i++) rets.push(Math.log(recent[i].close/recent[i-1].close));
      var upside=0, downside=0;
      rets.forEach(function(r){ upside+=Math.max(r-tau,0); downside+=Math.max(tau-r,0); });
      return downside > 0 ? upside/downside : (upside > 0 ? 99 : 1);
    }

    var results = assets.map(function(a) {
      var omega = omegaRatio(data[a.t], tau);
      var signal, sigColor;
      if (omega == null)    { signal='No data';    sigColor='#aaa'; }
      else if (omega >= 1.5){ signal='Add';        sigColor=C.success; }
      else if (omega >= 1.0){ signal='Hold';       sigColor=C.navy; }
      else if (omega >= 0.8){ signal='Trim';       sigColor='#8B6914'; }
      else                  { signal='Reduce';     sigColor=C.danger; }
      return { label:a.label, group:a.group, omega:omega, signal:signal, sigColor:sigColor };
    }).sort(function(a,b){ return (b.omega||0)-(a.omega||0); });

    var stateLabels = { leveraged:'Leveraged', growth:'Growth', neutral:'Neutral', drawdown:'Drawdown' };
    var html = '<div style="background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:8px 14px;margin-bottom:10px;font-size:11px;">'
      + '<strong>Regime-conditioned threshold:</strong> τ = '+(tau*100).toFixed(4)+'%/day (base '+(tauBase*100).toFixed(4)+'% × '+(tauMult[perryState]||1)+'× for '+stateLabels[perryState]+' regime) &nbsp;·&nbsp; 63-day rolling empirical distribution'
      + '</div>';
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;">';
    results.forEach(function(r) {
      var barW = r.omega != null ? Math.min(100, (r.omega/2)*100) : 0;
      html += '<div style="background:var(--bg);border:1px solid var(--border);border-left:4px solid '+r.sigColor+';border-radius:4px;padding:8px 12px;">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">'
        + '<div style="font-size:11px;font-weight:600;">'+r.label+'</div>'
        + '<span style="font-size:10px;background:'+r.sigColor+';color:#fff;padding:1px 7px;border-radius:10px;">'+r.signal+'</span>'
        + '</div>'
        + '<div style="font-size:22px;font-weight:800;color:'+r.sigColor+';margin-bottom:4px;">'+(r.omega!=null?r.omega.toFixed(2):'—')+'</div>'
        + '<div style="font-size:9.5px;color:var(--text-sec);margin-bottom:4px;">Ω(τ) · 1.0 = breakeven</div>'
        + '<div style="background:var(--border);border-radius:2px;height:4px;overflow:hidden;">'
        + '<div style="width:'+barW+'%;height:100%;background:'+r.sigColor+';border-radius:2px;"></div></div>'
        + '</div>';
    });
    html += '</div>';
    html += '<div style="margin-top:10px;font-size:11px;color:var(--text-sec);line-height:1.5;"><strong>Ω interpretation:</strong> Ω > 1.5 = expected upside well exceeds downside → Add. Ω 1.0–1.5 = modest upside edge → Hold. Ω 0.8–1.0 = marginal → Trim. Ω < 0.8 = downside dominant → Reduce. Unlike Sharpe ratio, Omega captures full return distribution including skewness and kurtosis. Threshold τ is scaled by Perry regime state per Lyu et al. (2023).</div>';
    el.innerHTML = html;
  } catch(e) {
    el.innerHTML = '<span style="color:var(--danger);">Error: '+e.message+'</span>';
  }
}

// ═══════════════════════════════════════════════════════════════════
// PILLAR TAB RENDERERS — auto-called by caAutoLoad for each new tab
// Each function fetches data and populates its dedicated DOM elements.
// ═══════════════════════════════════════════════════════════════════

// ── Shared: pillar score header chip ──────────────────────────────
function renderPillarHeader(elId, pillarName, score, detail) {
  var el = document.getElementById(elId);
  if (!el) return;
  var col = score >= 65 ? C.success : score >= 45 ? C.navy : score >= 30 ? '#8B6914' : C.danger;
  el.innerHTML = '<div style="background:var(--navy);color:#fff;border-radius:4px;padding:10px 18px;display:flex;align-items:center;gap:20px;margin-bottom:6px;">'
    + '<div><div style="font-size:10px;text-transform:uppercase;letter-spacing:.8px;opacity:.7;">Composite Pillar Score</div>'
    + '<div style="font-size:11px;opacity:.8;margin-top:2px;">' + pillarName + '</div></div>'
    + '<div style="font-size:36px;font-weight:800;color:' + col + ';">' + Math.round(score) + '</div>'
    + '<div style="font-size:13px;font-weight:600;">' + detail + '</div>'
    + '</div>';
}

// ── Shared: indicator scorecard table ─────────────────────────────
function renderIndicatorTable(elId, indicators) {
  var el = document.getElementById(elId);
  if (!el) return;
  var rows = indicators.map(function(ind) {
    var sCol = ind.score > 0 ? C.success : ind.score < 0 ? C.danger : '#8B6914';
    var sLbl = ind.score > 0 ? '▲ +1' : ind.score < 0 ? '▼ −1' : '● 0';
    return '<tr>'
      + '<td style="padding:5px 8px;font-weight:600;font-size:11px;">' + ind.indicator + '</td>'
      + '<td style="padding:5px 8px;font-size:11px;color:var(--text-sec);">' + (ind.value || '—') + '</td>'
      + '<td style="padding:5px 8px;font-size:11px;color:var(--text-sec);">' + (ind.date || '') + '</td>'
      + '<td style="padding:5px 8px;font-weight:700;color:' + sCol + ';text-align:center;">' + sLbl + '</td>'
      + '<td style="padding:5px 8px;font-size:10px;color:var(--text-sec);">' + (ind.detail || '') + '</td>'
      + '</tr>';
  }).join('');
  el.innerHTML = '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;">'
    + '<thead><tr style="background:var(--panel);font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-sec);">'
    + '<th style="padding:5px 8px;text-align:left;">Indicator</th><th style="padding:5px 8px;text-align:left;">Value</th>'
    + '<th style="padding:5px 8px;text-align:left;">As Of</th><th style="padding:5px 8px;text-align:center;">Score</th>'
    + '<th style="padding:5px 8px;text-align:left;">Detail</th></tr></thead>'
    + '<tbody>' + rows + '</tbody></table></div>';
}

// ── TAB 1: Business Cycle ─────────────────────────────────────────
async function bcTabLoad() {
  try {
    if (!window._lastMacroData) {
      var r = await fetch((window.WORKER_TL || 'https://perry-finance-proxy.zachperrybusiness.workers.dev') + '/fred');
      window._lastMacroData = await r.json();
    }
    var d = window._lastMacroData;
    var pillars = d.pillars || [];
    var total = d.totalScore || 0, max = d.maxScore || 1;
    var score = Math.max(0, Math.min(100, ((total + max) / (2 * max)) * 100));
    renderPillarHeader('bcPillarHeader', 'Business Cycle (FRED Scorecard)', score, d.phase || '—');

    var growth = pillars.find(function(p){return p.name==='Growth Analysis';}) || {indicators:[]};
    var labor  = pillars.find(function(p){return p.name==='Labor Market';})   || {indicators:[]};
    var infl   = pillars.find(function(p){return p.name==='Inflation';})      || {indicators:[]};
    var mon    = pillars.find(function(p){return p.name==='Monetary Policy';})|| {indicators:[]};
    var fisc   = pillars.find(function(p){return p.name==='Fiscal Policy';})  || {indicators:[]};
    var glob   = pillars.find(function(p){return p.name==='Global Liquidity';})||{indicators:[]};

    renderIndicatorTable('bcGrowthTable', growth.indicators.concat(labor.indicators));
    renderIndicatorTable('bcInflTable', infl.indicators.concat(mon.indicators));
    renderIndicatorTable('bcFiscalTable', fisc.indicators.concat(glob.indicators));

    // Gauge chart
    var gaugeEl = document.getElementById('bcGaugeChart');
    var phaseColors = {'Confirmed Expansion':C.success,'Mid-Cycle':C.navy,'Late Cycle / Transition':'#8B6914','Confirmed Contraction':C.danger};
    var phaseCol = phaseColors[d.phase] || C.navy;
    var phaseEl = document.getElementById('bcPhaseDisplay');
    if (phaseEl) phaseEl.innerHTML = '<div style="font-size:22px;font-weight:800;color:'+phaseCol+';margin-bottom:4px;">'+d.phase+'</div>'
      + '<div style="font-size:13px;color:var(--text-sec);">' + (d.phaseDescription||'') + '</div>'
      + '<div style="font-size:12px;margin-top:8px;color:var(--text-sec);">Score: <strong>'+total+'</strong> / '+max+'</div>';

    if (gaugeEl) {
      if (window._bcGaugeChart) window._bcGaugeChart.destroy();
      window._bcGaugeChart = new Chart(gaugeEl.getContext('2d'), {
        type: 'doughnut',
        data: {
          datasets: [{
            data: [Math.max(0, total + max), Math.max(0, 2*max - (total + max))],
            backgroundColor: [phaseCol, 'rgba(200,210,220,0.2)'],
            borderWidth: 0, circumference: 180, rotation: 270
          }]
        },
        options: { responsive:true, maintainAspectRatio:false, cutout:'72%',
          plugins: { legend:{display:false}, tooltip:{enabled:false} }
        }
      });
    }

    // Pillar breakdown bars
    var barEl = document.getElementById('bcPillarBars');
    if (barEl) {
      var bHtml = '<div style="display:flex;flex-direction:column;gap:8px;">';
      (d.pillarScores||[]).forEach(function(ps) {
        var pct = ps.count > 0 ? ((ps.score + ps.count) / (2*ps.count)) * 100 : 50;
        var bCol = pct >= 60 ? C.success : pct >= 40 ? C.navy : pct >= 25 ? '#8B6914' : C.danger;
        bHtml += '<div>'
          + '<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;">'
          + '<span style="font-weight:600;">'+ps.name+'</span>'
          + '<span style="color:'+bCol+';font-weight:700;">'+(ps.score>=0?'+':'')+ps.score+' / '+ps.count+'</span>'
          + '</div>'
          + '<div style="background:var(--border);border-radius:2px;height:8px;overflow:hidden;">'
          + '<div style="width:'+Math.round(pct)+'%;height:100%;background:'+bCol+';border-radius:2px;transition:width .4s;"></div>'
          + '</div></div>';
      });
      bHtml += '</div>';
      barEl.innerHTML = bHtml;
    }
  } catch(e) {
    console.error('[bcTabLoad]', e);
  }
}

// ── TAB 4: Credit Conditions ──────────────────────────────────────
var _creditCharts = {};
async function creditTabLoad() {
  try {
    if (!window._lastMacroData) {
      var r = await fetch((window.WORKER_TL || 'https://perry-finance-proxy.zachperrybusiness.workers.dev') + '/fred');
      window._lastMacroData = await r.json();
    }
    var d = window._lastMacroData;
    var pillars = d.pillars || [];
    var mon = pillars.find(function(p){return p.name==='Monetary Policy';}) || {indicators:[]};
    var hy = mon.indicators.find(function(i){return i.indicator.indexOf('HY OAS')>=0;});
    var hyVal = hy && hy.value ? parseFloat(hy.value) : null;
    var sloos = mon.indicators.find(function(i){return i.indicator.indexOf('SLOOS')>=0;});
    var score = hyVal != null ? Math.max(0,Math.min(100,100-(hyVal-3)*12)) : 50;
    var lbl = score>=70?'Tight (Risk-On)':score>=50?'Normal':score>=30?'Widening':'Stress';
    renderPillarHeader('creditPillarHeader','Credit Conditions',score,lbl + (hyVal?' · HY OAS '+hyVal.toFixed(2)+'%':''));

    // HY OAS display
    var hyEl = document.getElementById('creditHYDisplay');
    if (hyEl && hyVal != null) {
      var col = score>=70?C.success:score>=50?C.navy:score>=30?'#8B6914':C.danger;
      hyEl.innerHTML = '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;">'
        + '<div style="background:var(--panel);border:1px solid var(--border);border-left:4px solid '+col+';border-radius:4px;padding:12px;">'
        + '<div style="font-size:10px;text-transform:uppercase;color:var(--text-sec);">HY OAS</div>'
        + '<div style="font-size:28px;font-weight:800;color:'+col+';">'+hyVal.toFixed(2)+'%</div>'
        + '<div style="font-size:11px;color:'+col+';">'+lbl+'</div></div>'
        + '<div style="background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:12px;">'
        + '<div style="font-size:10px;text-transform:uppercase;color:var(--text-sec);">Pillar Score</div>'
        + '<div style="font-size:28px;font-weight:800;color:'+col+';">'+Math.round(score)+'</div>'
        + '<div style="font-size:11px;color:var(--text-sec);">/ 100</div></div>'
        + '<div style="background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:12px;">'
        + '<div style="font-size:10px;text-transform:uppercase;color:var(--text-sec);">Threshold</div>'
        + '<div style="font-size:14px;font-weight:700;">&lt;3.5% = Tight</div>'
        + '<div style="font-size:11px;color:var(--text-sec);">&gt;5% = Stress · &gt;8% = Crisis</div></div>'
        + '</div>';
    }

    // HYG/LQD chart
    try {
      var [hygD, lqdD] = await Promise.all([
        fetchChart('HYG','1y','1d'), fetchChart('LQD','1y','1d')
      ]);
      var hygPts = (hygD.points||[]).filter(function(p){return p.close!=null;});
      var lqdPts = (lqdD.points||[]).filter(function(p){return p.close!=null;});
      var mapL = {}; lqdPts.forEach(function(p){mapL[p.date.slice(0,10)]=p.close;});
      var hygDates = hygPts.map(function(p){return p.date.slice(0,10);}).filter(function(d){return mapL[d];});
      hygDates.sort();
      var ratio = hygDates.map(function(d){return hygPts.find(function(p){return p.date.slice(0,10)===d;}).close / mapL[d];});
      var sma63 = ratio.map(function(v,i){
        if(i<62) return null;
        var s=0; for(var k=i-62;k<=i;k++) s+=ratio[k];
        return s/63;
      });
      var hygIgEl = document.getElementById('creditHYIGDisplay');
      var wrap = document.getElementById('creditHYIGWrap');
      var curR = ratio[ratio.length-1], curS = sma63[sma63.length-1];
      var aboveSMA = curS && curR > curS;
      var rCol = aboveSMA ? C.success : C.danger;
      if (hygIgEl) hygIgEl.innerHTML = '<div style="display:flex;gap:16px;margin-bottom:10px;">'
        + '<div style="background:var(--panel);border:1px solid var(--border);border-left:4px solid '+rCol+';border-radius:4px;padding:10px 14px;">'
        + '<div style="font-size:10px;text-transform:uppercase;color:var(--text-sec);">HYG/LQD Ratio</div>'
        + '<div style="font-size:22px;font-weight:800;color:'+rCol+';">'+curR.toFixed(4)+'</div>'
        + '<div style="font-size:11px;color:'+rCol+';">'+(aboveSMA?'▲ Above 63D SMA — Credit Risk-On':'▼ Below 63D SMA — Caution')+'</div>'
        + '</div></div>';
      if (wrap) wrap.style.display='block';
      var canvas = document.getElementById('creditHYIGChart');
      if (canvas) {
        if (_creditCharts.hyig) _creditCharts.hyig.destroy();
        _creditCharts.hyig = new Chart(canvas.getContext('2d'), {
          type:'line', data:{labels:hygDates,datasets:[
            {label:'HYG/LQD',data:ratio,borderColor:C.navy,borderWidth:1.5,pointRadius:0,fill:false},
            {label:'63D SMA',data:sma63,borderColor:C.blue,borderWidth:1.2,borderDash:[5,3],pointRadius:0,fill:false}
          ]},
          options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true,labels:{font:{size:10}}},tooltip:chartTooltip},
            scales:{x:{grid:chartGrid,ticks:Object.assign({},chartTicks,{maxTicksLimit:6,font:{size:9}})},y:{grid:chartGrid,ticks:Object.assign({},chartTicks,{font:{size:9}})}}}
        });
      }
    } catch(e) {}

    // SLOOS display
    var sloosEl = document.getElementById('creditSLOOSDisplay');
    if (sloosEl && sloos) {
      var sv = parseFloat(sloos.value||0);
      var sCol2 = sv<0?C.success:sv>20?C.danger:'#8B6914';
      sloosEl.innerHTML = '<div style="text-align:center;padding:10px 0;">'
        + '<div style="font-size:11px;text-transform:uppercase;color:var(--text-sec);margin-bottom:4px;">SLOOS C&amp;I Standards</div>'
        + '<div style="font-size:38px;font-weight:800;color:'+sCol2+';">'+sv.toFixed(1)+'%</div>'
        + '<div style="font-size:12px;color:'+sCol2+';font-weight:600;">'+(sv<0?'Easing — Bullish':sv>20?'Significant Tightening':'Moderate Tightening')+'</div>'
        + '<div style="font-size:11px;color:var(--text-sec);margin-top:4px;">As of '+sloos.date+'</div>'
        + '</div>';
    }

    renderIndicatorTable('creditScorecardDisplay', mon.indicators);

    // Card 4: HYG vs TLT flight-to-safety
    try {
      var [hygFlight, tltFlight] = await Promise.all([
        fetchChart('HYG','6mo','1d'), fetchChart('TLT','6mo','1d')
      ]);
      var hygPts2 = (hygFlight.points||[]).filter(function(p){return p.close!=null;});
      var tltPts2 = (tltFlight.points||[]).filter(function(p){return p.close!=null;});
      var tltMap2 = {}; tltPts2.forEach(function(p){tltMap2[p.date.slice(0,10)]=p.close;});
      var fDates = hygPts2.map(function(p){return p.date.slice(0,10);}).filter(function(d){return tltMap2[d];});
      fDates.sort();
      var hygStart2=null,tltStart2=null;
      var hygReb2=[],tltReb2=[],spreadArr2=[];
      fDates.forEach(function(d){
        var hp=hygPts2.find(function(p){return p.date.slice(0,10)===d;});
        var tp=tltMap2[d];
        if(!hygStart2) hygStart2=hp.close; if(!tltStart2) tltStart2=tp;
        var hr=hp.close/hygStart2*100, tr=tp/tltStart2*100;
        hygReb2.push(hr); tltReb2.push(tr); spreadArr2.push(hr-tr);
      });
      var latestSpread = spreadArr2[spreadArr2.length-1];
      var flightSignal = latestSpread > 0 ? 'HYG Leading — Risk Appetite' : 'TLT Leading — Flight-to-Safety Active';
      var flightCol = latestSpread > 0 ? C.success : C.danger;
      var flightEl = document.getElementById('creditFlightDisplay');
      if (flightEl) flightEl.innerHTML = '<div style="display:flex;gap:12px;margin-bottom:8px;">'
        + '<div style="background:var(--panel);border:1px solid var(--border);border-left:4px solid '+flightCol+';border-radius:4px;padding:8px 12px;flex:1;">'
        + '<div style="font-size:10px;text-transform:uppercase;color:var(--text-sec);">Signal</div>'
        + '<div style="font-size:14px;font-weight:700;color:'+flightCol+';">'+flightSignal+'</div>'
        + '<div style="font-size:11px;color:var(--text-sec);">HYG−TLT relative return: '+(latestSpread>=0?'+':'')+latestSpread.toFixed(1)+'%</div>'
        + '</div></div>';
      var flightWrap = document.getElementById('creditFlightWrap');
      if (flightWrap) flightWrap.style.display='block';
      var fc = document.getElementById('creditFlightChart');
      if (fc) {
        if (_creditCharts.flight) _creditCharts.flight.destroy();
        _creditCharts.flight = new Chart(fc.getContext('2d'), {
          type:'line', data:{labels:fDates, datasets:[
            {label:'HYG (HY Credit)',data:hygReb2,borderColor:C.navy,borderWidth:1.8,pointRadius:0,fill:false},
            {label:'TLT (Long Bond)',data:tltReb2,borderColor:C.blue,borderWidth:1.8,pointRadius:0,fill:false,borderDash:[5,3]}
          ]},
          options:{responsive:true,maintainAspectRatio:false,
            plugins:{legend:{display:true,labels:{font:{size:10}}},tooltip:chartTooltip},
            scales:{x:{grid:chartGrid,ticks:Object.assign({},chartTicks,{maxTicksLimit:6,font:{size:9},autoSkip:true})},
              y:{grid:chartGrid,ticks:Object.assign({},chartTicks,{callback:function(v){return v.toFixed(0);},font:{size:9}})}}}
        });
      }
    } catch(e) {}
  } catch(e) { console.error('[creditTabLoad]', e); }
}

// ── TAB 5: Yield Curve ────────────────────────────────────────────
var _ycCharts = {};
async function ycTabLoad() {
  try {
    var WORKER = window.WORKER_TL || 'https://perry-finance-proxy.zachperrybusiness.workers.dev';
    // Fetch from yield curve endpoint
    var ycData = null;
    try {
      var ycR = await fetch(WORKER + '/yieldcurve');
      ycData = await ycR.json();
    } catch(e) {}

    if (!window._lastMacroData) {
      var r = await fetch(WORKER + '/fred');
      window._lastMacroData = await r.json();
    }
    var d = window._lastMacroData;
    var pillars = d.pillars || [];
    var mon = pillars.find(function(p){return p.name==='Monetary Policy';}) || {indicators:[]};
    var yc2 = mon.indicators.find(function(i){return i.indicator.indexOf('2Y/10Y')>=0;});
    var yc3m = mon.indicators.find(function(i){return i.indicator.indexOf('3M/10Y')>=0;});
    var v2 = yc2&&yc2.value!=null?parseFloat(yc2.value):null;
    var v3m = yc3m&&yc3m.value!=null?parseFloat(yc3m.value):null;
    var avg = v2!=null&&v3m!=null?(v2+v3m)/2:(v2!=null?v2:v3m)||0;
    var score = Math.max(0,Math.min(100,50+avg*30));
    var lbl = score>=65?'Steepening':score>=45?'Flat':'Inverted';
    renderPillarHeader('ycPillarHeader','Yield Curve',score,lbl+' · 2s10s '+(v2!=null?v2.toFixed(2)+'%':'—')+' · 3m10y '+(v3m!=null?v3m.toFixed(2)+'%':'—'));

    // Full yield curve chart
    if (ycData && ycData.snapshots && ycData.snapshots.current && ycData.snapshots.current.length) {
      var snaps = ycData.snapshots;
      var mats = snaps.current.map(function(p){return p.maturity;});
      var curRates = snaps.current.map(function(p){return p.rate;});
      var h1mRates = (snaps.oneMonthAgo||[]).map(function(p){return p.rate;});
      var h3mRates = (snaps.threeMonthsAgo||[]).map(function(p){return p.rate;});
      var h1yRates = (snaps.oneYearAgo||[]).map(function(p){return p.rate;});

      var ycWrap = document.getElementById('ycCurveWrap');
      var ycDisp = document.getElementById('ycCurveDisplay');
      if (ycWrap) ycWrap.style.display='block';
      if (ycDisp) ycDisp.style.display='none';
      var canvas = document.getElementById('ycCurveChart');
      if (canvas) {
        if (_ycCharts.curve) _ycCharts.curve.destroy();
        _ycCharts.curve = new Chart(canvas.getContext('2d'), {
          type:'line',
          data:{labels:mats,datasets:[
            {label:'Current',data:curRates,borderColor:C.navy,borderWidth:2.5,pointRadius:4,fill:false,tension:0.3},
            {label:'1M Ago', data:h1mRates,borderColor:C.blue,borderWidth:1.5,pointRadius:2,borderDash:[4,3],fill:false,tension:0.3},
            {label:'3M Ago', data:h3mRates,borderColor:'#8B6914',borderWidth:1.5,pointRadius:2,borderDash:[6,4],fill:false,tension:0.3},
            {label:'1Y Ago', data:h1yRates,borderColor:C.danger,borderWidth:1.2,pointRadius:2,borderDash:[2,4],fill:false,tension:0.3}
          ]},
          options:{responsive:true,maintainAspectRatio:false,
            plugins:{legend:{display:true,labels:{font:{size:11}}},tooltip:Object.assign({},chartTooltip,{callbacks:{label:function(ctx){return ctx.dataset.label+': '+ctx.parsed.y.toFixed(2)+'%';}}})},
            scales:{
              x:{grid:chartGrid,ticks:Object.assign({},chartTicks,{font:{size:10}})},
              y:{grid:chartGrid,ticks:Object.assign({},chartTicks,{callback:function(v){return v.toFixed(1)+'%';},font:{size:10}}),title:{display:true,text:'Yield (%)',font:{size:10},color:C.textSec}}
            }
          }
        });
      }

      // Spread charts from ycData.spreads
      if (ycData.spreads && ycData.spreads.dates && ycData.spreads.dates.length) {
        var sdates = ycData.spreads.dates;
        function renderSpreadChart(canvasId, wrapId, dispId, spreadArr, title) {
          var w = document.getElementById(wrapId); var dp = document.getElementById(dispId);
          if (w) w.style.display='block'; if (dp) dp.style.display='none';
          var c = document.getElementById(canvasId); if (!c) return;
          var colArr = spreadArr.map(function(v){return v>=0?'rgba(46,125,82,0.7)':'rgba(139,42,42,0.7)';});
          if (_ycCharts[canvasId]) _ycCharts[canvasId].destroy();
          _ycCharts[canvasId] = new Chart(c.getContext('2d'), {
            type:'bar',
            data:{labels:sdates,datasets:[{label:title,data:spreadArr,backgroundColor:colArr,borderWidth:0}]},
            options:{responsive:true,maintainAspectRatio:false,
              plugins:{legend:{display:false},tooltip:Object.assign({},chartTooltip,{callbacks:{label:function(ctx){return title+': '+(ctx.parsed.y>=0?'+':'')+ctx.parsed.y.toFixed(2)+'%';}}})},
              scales:{
                x:{grid:chartGrid,ticks:Object.assign({},chartTicks,{maxTicksLimit:8,font:{size:9},autoSkip:true})},
                y:{grid:chartGrid,ticks:Object.assign({},chartTicks,{callback:function(v){return v.toFixed(1)+'%';},font:{size:9}})}
              }
            }
          });
        }
        renderSpreadChart('yc2s10sChart','yc2s10sWrap','yc2s10sDisplay',ycData.spreads['2s10s']||[],'2s10s Spread');
        renderSpreadChart('yc3m10yChart','yc3m10yWrap','yc3m10yDisplay',ycData.spreads['3m10y']||[],'3M/10Y Spread');
      }
    }
    renderIndicatorTable('ycScorecardDisplay', mon.indicators.filter(function(i){return i.indicator.indexOf('Yield Curve')>=0||i.indicator.indexOf('HY OAS')>=0||i.indicator.indexOf('Real FFR')>=0;}));
  } catch(e) { console.error('[ycTabLoad]', e); }
}

// ── TAB 6: Cross-Asset Momentum ───────────────────────────────────
var _momCharts = {};
var _momScorecardData = {};

function momScorecardTF(btn, days) {
  document.querySelectorAll('.mom-tf').forEach(function(b) {
    var active = parseInt(b.dataset.tf) === days;
    b.style.background = active ? 'var(--navy)' : 'var(--panel)';
    b.style.color = active ? '#fff' : 'var(--text-sec)';
    b.style.border = active ? 'none' : '1px solid var(--border)';
  });
  renderMomScorecard(days);
}

function renderMomScorecard(days) {
  var scoreEl = document.getElementById('momScorecardDisplay');
  if (!scoreEl || !_momScorecardData.data) return;
  var data = _momScorecardData.data;
  var labels = {SPY:'S&P 500',QQQ:'Nasdaq 100',IWM:'Small Cap',TLT:'Long Bonds',GLD:'Gold',USO:'Oil',HYG:'High Yield',UUP:'US Dollar',EEM:'Em. Markets',XLE:'Energy',VNQ:'REITs'};
  var rets = Object.keys(data).map(function(t) {
    var pts = data[t];
    if (!pts || pts.length < days + 1) return {t:t, label:labels[t]||t, r:null};
    return {t:t, label:labels[t]||t, r:(pts[pts.length-1].close/pts[pts.length-1-days].close-1)*100};
  }).filter(function(x){return x.r!=null;}).sort(function(a,b){return b.r-a.r;});
  var html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;">';
  rets.forEach(function(x) {
    var col = x.r >= 0 ? C.success : C.danger;
    html += '<div style="background:var(--bg);border:1px solid var(--border);border-left:4px solid '+col+';border-radius:4px;padding:7px 10px;">'
      + '<div style="font-size:10px;color:var(--text-sec);">'+x.label+'</div>'
      + '<div style="font-size:17px;font-weight:800;color:'+col+';">'+(x.r>=0?'+':'')+x.r.toFixed(1)+'%</div>'
      + '<div style="font-size:9px;color:var(--text-sec);">'+days+'D Return</div></div>';
  });
  html += '</div>';
  scoreEl.innerHTML = html;
}

var _momCharts = {};
async function momTabLoad() {
  try {
    var assets = ['SPY','TLT','GLD','USO','QQQ','IWM','HYG','UUP','EEM','XLE','VNQ'];
    var data = {};
    await Promise.all(assets.map(async function(t) {
      try { var d = await fetchChart(t,'6mo','1d'); data[t]=(d.points||[]).filter(function(p){return p.close!=null;}); }
      catch(e){ data[t]=[]; }
    }));

    function pctRet(pts, n) {
      if (!pts||pts.length<n+1) return null;
      return (pts[pts.length-1].close/pts[pts.length-1-n].close-1)*100;
    }

    var spy3m = pctRet(data.SPY,63), tlt3m = pctRet(data.TLT,63), gld3m = pctRet(data.GLD,63);
    var score = 50;
    if (spy3m!=null) score += spy3m*2;
    if (tlt3m!=null) score -= tlt3m*1;
    score = Math.max(0,Math.min(100,score));
    var lbl = score>=65?'Risk-On Momentum':score>=45?'Mixed / Transitioning':'Risk-Off';
    renderPillarHeader('momPillarHeader','Cross-Asset Momentum',score,lbl+' · SPY '+(spy3m!=null?(spy3m>=0?'+':'')+spy3m.toFixed(1)+'%':'—')+' · TLT '+(tlt3m!=null?(tlt3m>=0?'+':'')+tlt3m.toFixed(1)+'%':'—'));

    // Store for TF selector
    _momScorecardData.data = data;
    renderMomScorecard(63); // default 3M

    // Rebased chart SPY/TLT/GLD/USO
    var core = ['SPY','TLT','GLD','USO'];
    var coreColors = [C.navy,C.blue,'#8B6914',C.danger];
    var allDates = data.SPY.map(function(p){return p.date.slice(0,10);});
    var datasets = core.map(function(t,i) {
      var map = {}; data[t].forEach(function(p){map[p.date.slice(0,10)]=p.close;});
      var start = null;
      var rebased = allDates.map(function(d){
        var v = map[d]; if (!v) return null;
        if (start==null) start=v;
        return v/start*100;
      });
      return {label:t,data:rebased,borderColor:coreColors[i],borderWidth:1.8,pointRadius:0,fill:false,tension:0.1,spanGaps:true};
    });
    var mWrap = document.getElementById('momRebasedWrap'); if (mWrap) mWrap.style.display='block';
    var mDisp = document.getElementById('momRebasedDisplay'); if(mDisp) mDisp.style.display='none';
    var mc = document.getElementById('momRebasedChart');
    if (mc) {
      if (_momCharts.rebased) _momCharts.rebased.destroy();
      _momCharts.rebased = new Chart(mc.getContext('2d'), {
        type:'line',data:{labels:allDates,datasets:datasets},
        options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true,labels:{font:{size:10}}},tooltip:chartTooltip},
          scales:{x:{grid:chartGrid,ticks:Object.assign({},chartTicks,{maxTicksLimit:7,font:{size:9},autoSkip:true})},
            y:{grid:chartGrid,ticks:Object.assign({},chartTicks,{callback:function(v){return v.toFixed(0);},font:{size:9}}),title:{display:true,text:'Rebased (100=start)',font:{size:9},color:C.textSec}}}}
      });
    }

    // Rolling correlation chart (replaces DXY vs commodities)
    var PAIRS = [
      {a:'SPY',b:'TLT',label:'SPY/TLT',color:C.navy},
      {a:'SPY',b:'GLD',label:'SPY/GLD',color:'#8B6914'},
      {a:'SPY',b:'HYG',label:'SPY/HYG',color:C.success},
      {a:'TLT',b:'GLD',label:'TLT/GLD',color:C.blue}
    ];
    var WIN = 63;
    var corrDates = allDates.slice(WIN);
    var corrDatasets = PAIRS.map(function(pair) {
      var mapA={}; (data[pair.a]||[]).forEach(function(p){mapA[p.date.slice(0,10)]=p.close;});
      var mapB={}; (data[pair.b]||[]).forEach(function(p){mapB[p.date.slice(0,10)]=p.close;});
      var rollingCorr = allDates.slice(WIN).map(function(d, ii) {
        var window = allDates.slice(ii, ii+WIN);
        var rA=[],rB=[];
        for (var w=1;w<window.length;w++) {
          var a0=mapA[window[w-1]],a1=mapA[window[w]],b0=mapB[window[w-1]],b1=mapB[window[w]];
          if(a0&&a1&&b0&&b1){rA.push(Math.log(a1/a0));rB.push(Math.log(b1/b0));}
        }
        if(rA.length<10) return null;
        var mA=rA.reduce(function(s,v){return s+v;},0)/rA.length;
        var mB=rB.reduce(function(s,v){return s+v;},0)/rB.length;
        var cov=0,vA=0,vB=0;
        for(var k=0;k<rA.length;k++){cov+=(rA[k]-mA)*(rB[k]-mB);vA+=(rA[k]-mA)*(rA[k]-mA);vB+=(rB[k]-mB)*(rB[k]-mB);}
        return vA>0&&vB>0?cov/Math.sqrt(vA*vB):null;
      });
      return {label:pair.label,data:rollingCorr,borderColor:pair.color,borderWidth:1.5,pointRadius:0,fill:false,tension:0.2,spanGaps:true};
    });
    var corrWrap = document.getElementById('momCorrWrap'); if(corrWrap) corrWrap.style.display='block';
    var corrDisp = document.getElementById('momCorrDisplay');
    var latestSpyTlt = corrDatasets[0].data[corrDatasets[0].data.length-1];
    if(corrDisp && latestSpyTlt!=null) {
      var corrCol = latestSpyTlt<0?C.success:'#8B6914';
      corrDisp.innerHTML='<div style="font-size:11px;margin-bottom:6px;">SPY/TLT 63D corr: <strong style="color:'+corrCol+';">'+(latestSpyTlt>=0?'+':'')+latestSpyTlt.toFixed(2)+'</strong>'+(latestSpyTlt<0?' (diversification intact — negative correlation)':' ⚠️ Positive — 60/40 diversification compromised')+'</div>';
    }
    var cc = document.getElementById('momCorrChart');
    if(cc){
      if(_momCharts.corr) _momCharts.corr.destroy();
      _momCharts.corr = new Chart(cc.getContext('2d'),{
        type:'line',data:{labels:corrDates,datasets:corrDatasets},
        options:{responsive:true,maintainAspectRatio:false,
          plugins:{legend:{display:true,labels:{font:{size:10}}},tooltip:Object.assign({},chartTooltip,{callbacks:{label:function(ctx){return ctx.dataset.label+': '+(ctx.parsed.y!=null?ctx.parsed.y.toFixed(2):'—');}}})},
          scales:{
            x:{grid:chartGrid,ticks:Object.assign({},chartTicks,{maxTicksLimit:6,font:{size:9},autoSkip:true})},
            y:{grid:chartGrid,ticks:Object.assign({},chartTicks,{font:{size:9},callback:function(v){return v.toFixed(1);}}),
               title:{display:true,text:'Pearson ρ',font:{size:9},color:C.textSec},
               min:-1,max:1,
               afterDataLimits: function(scale){scale.min=-1.05;scale.max=1.05;}}
          },
          plugins:{annotation:{annotations:{zero:{type:'line',yMin:0,yMax:0,borderColor:'rgba(0,0,0,0.2)',borderWidth:1,borderDash:[4,4]}}}}
        }
      });
    }

    // Risk-On/Off classifier
    var regEl = document.getElementById('momRegimeDisplay');
    if (regEl && spy3m!=null && tlt3m!=null && gld3m!=null) {
      var uso3m = pctRet(data.USO,63);
      var regime, regCol, regDesc;
      if (spy3m>0 && spy3m>tlt3m && spy3m>gld3m) { regime='Risk-On'; regCol=C.success; regDesc='Equities leading bonds and gold. Risk appetite dominant.'; }
      else if (tlt3m>0 && gld3m>0 && spy3m<tlt3m) { regime='Risk-Off'; regCol=C.danger; regDesc='Bonds and gold leading equities. Defensive positioning dominant.'; }
      else if (uso3m!=null && uso3m>5 && spy3m>0 && tlt3m<0) { regime='Reflation'; regCol='#8B6914'; regDesc='Commodities and equities up, bonds down. Inflation expectations rising.'; }
      else if (uso3m!=null && uso3m>5 && spy3m<0 && tlt3m<0) { regime='Stagflation'; regCol=C.danger; regDesc='Commodities up, equities and bonds both down.'; }
      else { regime='Mixed / Transitioning'; regCol=C.blue; regDesc='No dominant cross-asset theme. Monitor for regime clarification.'; }
      regEl.innerHTML = '<div style="background:var(--panel);border:1px solid var(--border);border-left:4px solid '+regCol+';border-radius:4px;padding:16px 20px;">'
        + '<div style="font-size:10px;text-transform:uppercase;color:var(--text-sec);margin-bottom:4px;">Current Cross-Asset Regime</div>'
        + '<div style="font-size:26px;font-weight:800;color:'+regCol+';margin-bottom:6px;">'+regime+'</div>'
        + '<div style="font-size:12px;color:var(--text-sec);line-height:1.5;margin-bottom:12px;">'+regDesc+'</div>'
        + '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;font-size:11px;">'
        + '<div style="text-align:center;"><div style="color:var(--text-sec);font-size:9px;">SPY 3M</div><div style="font-weight:700;color:'+(spy3m>=0?C.success:C.danger)+';">'+(spy3m>=0?'+':'')+spy3m.toFixed(1)+'%</div></div>'
        + '<div style="text-align:center;"><div style="color:var(--text-sec);font-size:9px;">TLT 3M</div><div style="font-weight:700;color:'+(tlt3m>=0?C.success:C.danger)+';">'+(tlt3m>=0?'+':'')+tlt3m.toFixed(1)+'%</div></div>'
        + '<div style="text-align:center;"><div style="color:var(--text-sec);font-size:9px;">GLD 3M</div><div style="font-weight:700;color:'+(gld3m>=0?C.success:C.danger)+';">'+(gld3m>=0?'+':'')+gld3m.toFixed(1)+'%</div></div>'
        + '<div style="text-align:center;"><div style="color:var(--text-sec);font-size:9px;">USO 3M</div><div style="font-weight:700;color:'+(uso3m!=null&&uso3m>=0?C.success:C.danger)+';">'+(uso3m!=null?(uso3m>=0?'+':'')+uso3m.toFixed(1)+'%':'—')+'</div></div>'
        + '</div></div>';
    }
  } catch(e) { console.error('[momTabLoad]', e); }
}


// ── TAB 7: Sector Rotation ────────────────────────────────────────
var _sectorCharts = {};

// Sector rotation ratio signals definition
var SECTOR_RATIO_SIGNALS = {
  cyc_def: {
    label: 'Cyclicals / Defensives',
    fetchA: async function() {
      var cyc = ['XLK','XLY','XLI','XLF','XLE','XLB','XLRE','XLC'];
      var def_ = ['XLP','XLV','XLU'];
      var all = cyc.concat(def_); var data = {};
      await Promise.all(all.map(async function(t){ try{ var d=await fetchChart(t,'1y','1d'); data[t]=(d.points||[]).filter(function(p){return p.close!=null;}); }catch(e){data[t]=[];} }));
      var dates = data.XLK.map(function(p){return p.date.slice(0,10);});
      var ratio = [], ratioLabels = [];
      dates.forEach(function(d) {
        var c=0,cN=0,df=0,dfN=0;
        cyc.forEach(function(t){var p=data[t]&&data[t].find(function(p2){return p2.date.slice(0,10)===d;});if(p){c+=p.close;cN++;}});
        def_.forEach(function(t){var p=data[t]&&data[t].find(function(p2){return p2.date.slice(0,10)===d;});if(p){df+=p.close;dfN++;}});
        if(cN>0&&dfN>0){ratio.push((c/cN)/(df/dfN));ratioLabels.push(d);}
      });
      return {ratio:ratio, dates:ratioLabels};
    }
  },
  small_large: { label: 'Small Cap / Large Cap (IWM÷SPY)', tickers: ['IWM','SPY'] },
  value_growth: { label: 'Value / Growth (IVE÷IVW)', tickers: ['IVE','IVW'] },
  energy_fins:  { label: 'Energy / Financials (XLE÷XLF)', tickers: ['XLE','XLF'] },
  intl_us:      { label: 'International / US (EFA÷SPY)', tickers: ['EFA','SPY'] },
  rsp_spy:      { label: 'Equal-Weight / Cap-Weight (RSP÷SPY)', tickers: ['RSP','SPY'] }
};

var _sectorCharts = {};
var _sectorData = {};  // cached: key=signal, {ratio, dates}
var _sectorStockData = {};

// Switch ratio signal
async function sectorsUpdateRatio() {
  var sig = document.getElementById('sectorsRatioSignal').value;
  var disp = document.getElementById('sectorsRatioDisplay');
  var wrap = document.getElementById('sectorsRatioWrap');
  if (!disp) return;
  if (_sectorData[sig]) { renderSectorRatioChart(sig, _sectorData[sig]); return; }
  disp.innerHTML = '<span class="spinner"></span>';
  try {
    var def = SECTOR_RATIO_SIGNALS[sig];
    var result;
    if (def.fetchA) {
      result = await def.fetchA();
    } else {
      var dA = await fetchChart(def.tickers[0],'1y','1d');
      var dB = await fetchChart(def.tickers[1],'1y','1d');
      var ptsA=(dA.points||[]).filter(function(p){return p.close!=null;});
      var ptsB=(dB.points||[]).filter(function(p){return p.close!=null;});
      var mapB={}; ptsB.forEach(function(p){mapB[p.date.slice(0,10)]=p.close;});
      var ratio=[],ratioLabels=[];
      ptsA.forEach(function(p){var d=p.date.slice(0,10);if(mapB[d]){ratio.push(p.close/mapB[d]);ratioLabels.push(d);}});
      result = {ratio:ratio, dates:ratioLabels};
    }
    _sectorData[sig] = result;
    renderSectorRatioChart(sig, result);
  } catch(e) { if(disp) disp.innerHTML='<span style="color:var(--danger);">Error: '+e.message+'</span>'; }
}

function renderSectorRatioChart(sig, result) {
  var ratio = result.ratio, dates = result.dates;
  var def = SECTOR_RATIO_SIGNALS[sig];
  var disp = document.getElementById('sectorsRatioDisplay');
  var wrap = document.getElementById('sectorsRatioWrap');
  var rStart = ratio[0]||1;
  var ratioReb = ratio.map(function(v){return v/rStart*100;});
  var sma63 = ratioReb.map(function(v,i){if(i<62) return null; var s=0;for(var k=i-62;k<=i;k++)s+=ratioReb[k];return s/63;});
  var cur=ratioReb[ratioReb.length-1], sma=sma63[sma63.length-1];
  var abv = sma&&cur>sma; var col=abv?C.success:C.danger;
  if(disp) disp.innerHTML = '<div style="display:flex;gap:10px;margin-bottom:8px;font-size:11px;">'
    + '<div style="background:var(--panel);border-left:4px solid '+col+';border-radius:4px;padding:6px 12px;">'
    + '<div style="color:var(--text-sec);font-size:9px;text-transform:uppercase;">Signal</div>'
    + '<div style="font-weight:700;color:'+col+';">'+(abv?'▲ Outperforming (63D SMA)':'▼ Underperforming (63D SMA)')+'</div>'
    + '</div></div>';
  if(wrap) wrap.style.display='block';
  var c = document.getElementById('sectorsRatioChart');
  if(!c) return;
  if(_sectorCharts.ratio) _sectorCharts.ratio.destroy();
  _sectorCharts.ratio = new Chart(c.getContext('2d'), {
    type:'line', data:{labels:dates, datasets:[
      {label:def.label,data:ratioReb,borderColor:C.navy,borderWidth:1.8,pointRadius:0,fill:false,tension:0.1},
      {label:'63D SMA',data:sma63,borderColor:C.blue,borderWidth:1.2,borderDash:[5,3],pointRadius:0,fill:false}
    ]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true,labels:{font:{size:10}}},tooltip:chartTooltip},
      scales:{x:{grid:chartGrid,ticks:Object.assign({},chartTicks,{maxTicksLimit:7,font:{size:9},autoSkip:true})},
        y:{grid:chartGrid,ticks:Object.assign({},chartTicks,{callback:function(v){return v.toFixed(0);},font:{size:9}})}}}
  });
}

// Sector momentum TF selector
var _sectorMomData = {};
function sectorsMomentumTF(btn, days) {
  document.querySelectorAll('.sec-tf').forEach(function(b) {
    var a=parseInt(b.dataset.tf)===days;
    b.style.background=a?'var(--navy)':'var(--panel)'; b.style.color=a?'#fff':'var(--text-sec)'; b.style.border=a?'none':'1px solid var(--border)';
  });
  renderSectorMomentum(days);
}

function renderSectorMomentum(days) {
  var el = document.getElementById('sectorsMomentumDisplay');
  if (!el || !_sectorMomData.data) return;
  var data = _sectorMomData.data, spyPts = data['SPY'];
  var SECT_LABELS = {XLK:'Technology',XLE:'Energy',XLF:'Financials',XLI:'Industrials',XLY:'Cons. Disc.',XLP:'Staples',XLV:'Health Care',XLU:'Utilities',XLB:'Materials',XLRE:'Real Estate',XLC:'Comm. Svcs.'};
  var ALL11 = ['XLK','XLY','XLI','XLF','XLE','XLB','XLRE','XLC','XLP','XLV','XLU'];
  function exRet(ticker) {
    var pts=data[ticker], spy=spyPts;
    if(!pts||pts.length<days+1||!spy||spy.length<days+1) return null;
    var sr=(pts[pts.length-1].close/pts[pts.length-1-days].close-1)*100;
    var spyr=(spy[spy.length-1].close/spy[spy.length-1-days].close-1)*100;
    return sr-spyr;
  }
  var results = ALL11.map(function(t){return {t:t,name:SECT_LABELS[t]||t,ex:exRet(t)};}).filter(function(x){return x.ex!=null;}).sort(function(a,b){return b.ex-a.ex;});
  var inflowN=4, outflowN=4;
  results.forEach(function(r,i){r.flow=i<inflowN?'Inflow':i>=results.length-outflowN?'Outflow':'Neutral';r.col=r.flow==='Inflow'?C.success:r.flow==='Outflow'?C.danger:'#8B6914';});
  // Narrative
  var inflowGroups=results.filter(function(r){return r.flow==='Inflow';}).map(function(r){return r.t;}).join(', ');
  var html='<div style="background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:8px 12px;margin-bottom:10px;font-size:11px;">'
    +'<strong>'+days+'D vs SPY — Inflows:</strong> '+inflowGroups+'</div>'
    +'<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:6px;">';
  results.forEach(function(r){
    html+='<div style="background:var(--bg);border:1px solid var(--border);border-left:4px solid '+r.col+';border-radius:4px;padding:7px 10px;">'
      +'<div style="display:flex;justify-content:space-between;align-items:center;">'
      +'<span style="font-size:11px;font-weight:700;">'+r.t+'</span>'
      +'<span style="font-size:10px;background:'+r.col+';color:#fff;padding:1px 6px;border-radius:10px;">'+r.flow+'</span>'
      +'</div>'
      +'<div style="font-size:10px;color:var(--text-sec);">'+r.name+'</div>'
      +'<div style="font-size:15px;font-weight:800;color:'+r.col+';">'+(r.ex>=0?'+':'')+r.ex.toFixed(1)+'%</div>'
      +'<div style="font-size:9px;color:var(--text-sec);">vs SPY '+days+'D</div>'
      +'</div>';
  });
  html+='</div>';
  el.innerHTML=html;
}


function sectorToggleStocks(el) {
  var sub = el.querySelector('.sec-stocks');
  if (sub) sub.style.display = sub.style.display === 'none' ? 'block' : 'none';
}

async function sectorsTabLoad() {
  try {
    var ALL11 = ['XLK','XLY','XLI','XLF','XLE','XLB','XLRE','XLC','XLP','XLV','XLU'];
    var data = {};
    await Promise.all(['SPY'].concat(ALL11).map(async function(t){
      try { var d=await fetchChart(t,'1y','1d'); data[t]=(d.points||[]).filter(function(p){return p.close!=null;}); }
      catch(e){data[t]=[];}
    }));
    _sectorMomData.data = data;

    function pctRet(pts,n){if(!pts||pts.length<n+1) return null; return (pts[pts.length-1].close/pts[pts.length-1-n].close-1)*100;}
    var cyc3m = ['XLK','XLY','XLI','XLF'].map(function(t){return pctRet(data[t],63)||0;}).reduce(function(s,v){return s+v;},0)/4;
    var def3m = ['XLP','XLV','XLU'].map(function(t){return pctRet(data[t],63)||0;}).reduce(function(s,v){return s+v;},0)/3;
    var spread = cyc3m-def3m;
    var score=Math.max(0,Math.min(100,50+spread*4));
    var lbl=score>=65?'Cyclicals Leading':score>=45?'Mixed':'Defensives Leading';
    renderPillarHeader('sectorsPillarHeader','Sector Rotation',score,lbl);

    // Load default ratio (cyc/def)
    sectorsUpdateRatio();
    // Load momentum scorecard at default 1W
    renderSectorMomentum(5);

    // Expanded sector heatmap with top-5 stocks
    var SECTOR_TOPS = {"XLK": ["AAPL", "MSFT", "NVDA", "AVGO", "ORCL"], "XLE": ["XOM", "CVX", "COP", "EOG", "SLB"], "XLF": ["BRK-B", "JPM", "V", "MA", "BAC"], "XLI": ["GE", "RTX", "HON", "UNP", "CAT"], "XLY": ["AMZN", "TSLA", "HD", "MCD", "NKE"], "XLP": ["PG", "KO", "PEP", "COST", "WMT"], "XLV": ["LLY", "UNH", "JNJ", "ABBV", "MRK"], "XLU": ["NEE", "SO", "DUK", "CEG", "AEP"], "XLB": ["LIN", "APD", "SHW", "FCX", "NUE"], "XLRE": ["AMT", "PLD", "CCI", "EQIX", "PSA"], "XLC": ["META", "GOOGL", "NFLX", "CMCSA", "DIS"]};
    var SECT_LABELS2 = {XLK:'Technology',XLE:'Energy',XLF:'Financials',XLI:'Industrials',XLY:'Cons. Disc.',XLP:'Staples',XLV:'Health Care',XLU:'Utilities',XLB:'Materials',XLRE:'Real Estate',XLC:'Comm. Svcs.'};
    var hmEl = document.getElementById('sectorsHeatmapDisplay');
    if (hmEl) {
      var hmData = ALL11.map(function(t){return {t:t,label:SECT_LABELS2[t]||t,r:pctRet(data[t],21),holdings:SECTOR_TOPS[t]||[]};}).filter(function(x){return x.r!=null;}).sort(function(a,b){return b.r-a.r;});
      // Fetch stock returns for top-5 in each sector in background
      var allStocks = [];
      hmData.forEach(function(s){s.holdings.forEach(function(tk){if(allStocks.indexOf(tk)<0)allStocks.push(tk);});});
      var stockData = {};
      var stockFetches = allStocks.map(async function(tk){
        try{var d=await fetchChart(tk,'3mo','1d');stockData[tk]=(d.points||[]).filter(function(p){return p.close!=null;});}catch(e){stockData[tk]=[];}
      });

      // Render heatmap immediately with ETF data, then update with stock returns
      function renderHeatmap(stockData) {
        var html='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;">';
        hmData.forEach(function(s){
          var intensity=Math.min(1,Math.abs(s.r)/5);
          var bg=s.r>=0?'rgba(46,125,82,'+(.08+intensity*.6)+')':'rgba(139,42,42,'+(.08+intensity*.6)+')';
          var tc=intensity>0.5?'#fff':'var(--text)';
          // Compute top-5 stock returns
          var stockRows='';
          if(stockData){
            s.holdings.forEach(function(tk){
              var pts=stockData[tk]||[];
              var sr=pts.length>=22?(pts[pts.length-1].close/pts[pts.length-22].close-1)*100:null;
              if(sr!=null){
                var sc=sr>=0?'rgba(46,125,82,0.8)':'rgba(139,42,42,0.8)';
                stockRows+='<div style="display:flex;justify-content:space-between;font-size:9px;padding:1px 0;border-top:1px solid rgba(255,255,255,0.15);">'
                  +'<span>'+tk+'</span><span style="color:'+sc+';font-weight:700;">'+(sr>=0?'+':'')+sr.toFixed(1)+'%</span></div>';
              }
            });
          }
          html+='<div style="background:'+bg+';border-radius:4px;padding:10px;cursor:pointer;" onclick="sectorToggleStocks(this)" >'
            +'<div style="display:flex;justify-content:space-between;align-items:flex-start;">'
            +'<div><div style="font-size:11px;font-weight:700;color:'+tc+';">'+s.label+'</div>'
            +'<div style="font-size:9px;color:'+tc+';opacity:.75;">'+s.t+'</div></div>'
            +'<div style="text-align:right;"><div style="font-size:18px;font-weight:800;color:'+tc+';">'+(s.r>=0?'+':'')+s.r.toFixed(1)+'%</div>'
            +'<div style="font-size:9px;color:'+tc+';opacity:.75;">1M</div></div>'
            +'</div>'
            +(stockRows?'<div class="sec-stocks" style="display:none;margin-top:6px;border-top:1px solid rgba(255,255,255,0.2);padding-top:6px;"><div style="font-size:9px;color:'+tc+';opacity:.7;margin-bottom:3px;font-weight:600;">TOP 5 CONTRIBUTORS</div>'+stockRows+'</div>':'')
            +'</div>';
        });
        html+='</div><div style="font-size:10px;color:var(--text-sec);margin-top:8px;">Click any sector to show/hide top-5 stock contributors (1M returns).</div>';
        if(hmEl) hmEl.innerHTML=html;
      }

      renderHeatmap(null); // first pass without stocks
      Promise.all(stockFetches).then(function(){renderHeatmap(stockData);}); // update with stocks
    }

    // Quantamental
    if (typeof mktLoadQuantamental === 'function') {
      var origEl2 = document.getElementById('mktQuantResult');
      var targetEl2 = document.getElementById('sectorsQuantDisplay');
      if (origEl2 && targetEl2) {
        var origId2=origEl2.id; origEl2.id='_quantTmp'; targetEl2.id='mktQuantResult';
        await mktLoadQuantamental();
        targetEl2.id='sectorsQuantDisplay'; origEl2.id=origId2;
      }
    }
  } catch(e) { console.error('[sectorsTabLoad]', e); }
}



// ── Analytics tab shims (renamed IDs to avoid duplicates with breadth/regime tabs) ──
function aRegimeDistanceRun() {
  // Temporarily swap IDs so regimeDistanceRun reads/writes to analytics elements
  var winEl = document.getElementById('aRegDistWin');
  var resEl = document.getElementById('aRegDistResults');
  var origWin = document.getElementById('regDistWin');
  var origRes = document.getElementById('regDistResults');
  if (!winEl || !resEl) return;
  if (origWin) origWin.id = '_rdwTmp';
  if (origRes) origRes.id = '_rdrTmp';
  winEl.id = 'regDistWin'; resEl.id = 'regDistResults';
  regimeDistanceRun().finally(function() {
    winEl.id = 'aRegDistWin'; resEl.id = 'aRegDistResults';
    if (origWin) origWin.id = 'regDistWin';
    if (origRes) origRes.id = 'regDistResults';
  });
}
function aLoadOmega() {
  var tauEl = document.getElementById('aOmegaTau');
  var resEl = document.getElementById('aMktOmegaResult');
  var origTau = document.getElementById('omegaTau');
  var origRes = document.getElementById('mktOmegaResult');
  if (!tauEl || !resEl) return;
  if (origTau) origTau.id = '_otTmp';
  if (origRes) origRes.id = '_orTmp';
  tauEl.id = 'omegaTau'; resEl.id = 'mktOmegaResult';
  mktLoadOmega().finally(function() {
    tauEl.id = 'aOmegaTau'; resEl.id = 'aMktOmegaResult';
    if (origTau) origTau.id = 'omegaTau';
    if (origRes) origRes.id = 'mktOmegaResult';
  });
}
function aRunLeadLag() {
  var aEl = document.getElementById('aLagAssetA');
  var bEl = document.getElementById('aLagAssetB');
  var lbEl = document.getElementById('aLagLookback');
  var resEl = document.getElementById('aMktLeadLagResult');
  var wrapEl = document.getElementById('aMktLeadLagWrap');
  var cEl = document.getElementById('aMktLeadLagChart');
  var oA = document.getElementById('lagAssetA');
  var oB = document.getElementById('lagAssetB');
  var oLb = document.getElementById('lagLookback');
  var oRes = document.getElementById('mktLeadLagResult');
  var oWrap = document.getElementById('mktLeadLagWrap');
  var oC = document.getElementById('mktLeadLagChart');
  if (!aEl) return;
  if (oA) oA.id='_laaTmp'; if (oB) oB.id='_labTmp'; if (oLb) oLb.id='_llbTmp';
  if (oRes) oRes.id='_lrTmp'; if (oWrap) oWrap.id='_lwTmp'; if (oC) oC.id='_lcTmp';
  if (aEl) aEl.id='lagAssetA'; if (bEl) bEl.id='lagAssetB'; if (lbEl) lbEl.id='lagLookback';
  if (resEl) resEl.id='mktLeadLagResult'; if (wrapEl) wrapEl.id='mktLeadLagWrap'; if (cEl) cEl.id='mktLeadLagChart';
  Promise.resolve(mktRunLeadLag()).finally(function() {
    if (aEl) aEl.id='aLagAssetA'; if (bEl) bEl.id='aLagAssetB'; if (lbEl) lbEl.id='aLagLookback';
    if (resEl) resEl.id='aMktLeadLagResult'; if (wrapEl) wrapEl.id='aMktLeadLagWrap'; if (cEl) cEl.id='aMktLeadLagChart';
    if (oA) oA.id='lagAssetA'; if (oB) oB.id='lagAssetB'; if (oLb) oLb.id='lagLookback';
    if (oRes) oRes.id='mktLeadLagResult'; if (oWrap) oWrap.id='mktLeadLagWrap'; if (oC) oC.id='mktLeadLagChart';
  });
}
// ═══════════════════════════════════════════════════════════════════
// CYCLE BREAKDOWN TABLE — Consumer, Business, Real Estate, Supply Chain
// Calls /fred-breakdown endpoint and renders the phase matrix.
// ═══════════════════════════════════════════════════════════════════

var _breakdownLoaded = false;
var _breakdownData = null;

async function regimeLoadBreakdown(force) {
  if (_breakdownLoaded && !force && _breakdownData) { renderCycleBreakdown(_breakdownData); return; }
  var el = document.getElementById('cycleBreakdownResult');
  if (!el) return;
  el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-sec);"><span class="spinner"></span> Fetching ' +
    'consumer, business, real estate, and supply chain indicators from FRED...</div>';
  try {
    var WORKER = window.WORKER_URL || 'https://perry-finance-proxy.zachperrybusiness.workers.dev';
    var res = await fetch(WORKER + '/fred-breakdown');
    var data = await res.json();
    if (data.error) throw new Error(data.error);
    _breakdownLoaded = true;
    _breakdownData = data;
    renderCycleBreakdown(data);
  } catch(e) {
    var el2 = document.getElementById('cycleBreakdownResult');
    if (el2) el2.innerHTML = '<div style="padding:24px;text-align:center;color:var(--danger);">Failed to load breakdown data: ' + e.message +
      ' <button class="btn btn-sm" onclick="regimeLoadBreakdown(true)" style="margin-left:8px;">Retry</button></div>';
  }
}

function renderCycleBreakdown(data) {
  var el = document.getElementById('cycleBreakdownResult');
  if (!el) return;

  var PHASE_CONFIG = {
    'Expansion':   { bg: 'rgba(46,125,82,0.12)',  border: '#2E7D52', text: '#1A5C38',  badge: '#2E7D52',  label: 'Expansion'   },
    'Recovery':    { bg: 'rgba(91,155,213,0.12)', border: '#5B9BD5', text: '#003C71',  badge: '#5B9BD5',  label: 'Recovery'    },
    'Neutral':     { bg: 'rgba(90,106,122,0.07)', border: '#A0AABB', text: '#5A6A7A',  badge: '#A0AABB',  label: 'Neutral'     },
    'Slowdown':    { bg: 'rgba(139,105,20,0.10)', border: '#8B6914', text: '#5C4500',  badge: '#8B6914',  label: 'Slowdown'    },
    'Contraction': { bg: 'rgba(139,42,42,0.10)',  border: '#8B2A2A', text: '#5C0000',  badge: '#8B2A2A',  label: 'Contraction' },
    'N/A':         { bg: 'rgba(0,0,0,0.03)',       border: '#D0D7E0', text: '#A0AABB',  badge: '#D0D7E0',  label: 'N/A'         }
  };

  function phaseColor(phase) { return PHASE_CONFIG[phase] || PHASE_CONFIG['Neutral']; }

  // ── Category summary bar ──────────────────────────────────────────
  var summaryHtml = '<div style="display:flex;gap:10px;flex-wrap:wrap;padding:14px 18px;border-bottom:2px solid var(--border);background:var(--panel);">';
  (data.categories || []).forEach(function(cat) {
    var s = cat.summary;
    var dom = s.dominant;
    var pc = phaseColor(dom);
    // mini phase tally bar
    var phases = ['Expansion','Recovery','Neutral','Slowdown','Contraction'];
    var tallyHtml = '<div style="display:flex;gap:2px;margin-top:4px;">';
    phases.forEach(function(ph) {
      var cnt = s.counts[ph] || 0;
      if (!cnt) return;
      var ppc = phaseColor(ph);
      tallyHtml += '<div title="' + ph + ': ' + cnt + '" style="height:6px;width:' + Math.round(cnt/s.total*60) + 'px;background:' + ppc.badge + ';border-radius:2px;"></div>';
    });
    tallyHtml += '</div>';
    summaryHtml += '<div style="background:' + pc.bg + ';border:1px solid ' + pc.border + ';border-radius:6px;padding:8px 14px;min-width:140px;">'
      + '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;font-weight:700;color:' + pc.text + ';">' + cat.name + '</div>'
      + '<div style="font-size:16px;font-weight:800;color:' + pc.badge + ';margin:2px 0;">' + dom + '</div>'
      + '<div style="font-size:10px;color:var(--text-sec);">' + s.total + ' indicators</div>'
      + tallyHtml
      + '</div>';
  });
  summaryHtml += '</div>';

  // ── Phase legend ──────────────────────────────────────────────────
  var legendHtml = '<div style="display:flex;gap:12px;flex-wrap:wrap;padding:10px 18px;border-bottom:1px solid var(--border);background:var(--panel);font-size:10.5px;">';
  legendHtml += '<span style="font-weight:600;color:var(--text-sec);">Phase key:</span>';
  ['Recovery','Expansion','Neutral','Slowdown','Contraction'].forEach(function(ph) {
    var pc = phaseColor(ph);
    legendHtml += '<span style="display:flex;align-items:center;gap:4px;">'
      + '<span style="width:10px;height:10px;border-radius:2px;background:' + pc.badge + ';display:inline-block;"></span>'
      + '<span style="color:' + pc.text + ';font-weight:600;">' + ph + '</span></span>';
  });
  legendHtml += '<span style="color:var(--text-sec);margin-left:6px;">· 3M Chg = trailing 3-month % change</span>';
  legendHtml += '</div>';

  // ── Per-category tables ───────────────────────────────────────────
  var tablesHtml = '';
  (data.categories || []).forEach(function(cat) {
    var catSummary = cat.summary;
    var catPc = phaseColor(catSummary.dominant);

    tablesHtml += '<div style="margin-bottom:0;">';
    // Category header row
    tablesHtml += '<div style="background:var(--navy);color:#fff;padding:8px 18px;display:flex;align-items:center;justify-content:space-between;">';
    tablesHtml += '<span style="font-size:12px;font-weight:700;letter-spacing:.3px;">' + cat.name + '</span>';
    tablesHtml += '<span style="font-size:11px;background:' + catPc.badge + ';color:#fff;padding:2px 10px;border-radius:10px;font-weight:600;">' + catSummary.dominant + '</span>';
    tablesHtml += '</div>';

    tablesHtml += '<div style="overflow-x:auto;"><table style="width:100%;font-size:11.5px;border-collapse:collapse;">';
    tablesHtml += '<thead><tr style="background:var(--panel);">';
    tablesHtml += '<th style="padding:7px 14px;text-align:left;color:var(--text-sec);font-weight:600;min-width:200px;border-bottom:1px solid var(--border);">Indicator</th>';
    tablesHtml += '<th style="padding:7px 14px;text-align:right;color:var(--text-sec);font-weight:600;min-width:90px;border-bottom:1px solid var(--border);">Value</th>';
    tablesHtml += '<th style="padding:7px 14px;text-align:center;color:var(--text-sec);font-weight:600;min-width:50px;border-bottom:1px solid var(--border);">Dir</th>';
    tablesHtml += '<th style="padding:7px 14px;text-align:right;color:var(--text-sec);font-weight:600;min-width:80px;border-bottom:1px solid var(--border);">3M Chg</th>';
    tablesHtml += '<th style="padding:7px 14px;text-align:left;color:var(--text-sec);font-weight:600;min-width:90px;border-bottom:1px solid var(--border);">As Of</th>';
    tablesHtml += '<th style="padding:7px 14px;text-align:center;color:var(--text-sec);font-weight:600;min-width:120px;border-bottom:1px solid var(--border);">Cycle Phase</th>';
    tablesHtml += '<th style="padding:7px 14px;text-align:left;color:var(--text-sec);font-weight:600;min-width:140px;border-bottom:1px solid var(--border);">Recovery &nbsp; Expansion &nbsp; Slowdown &nbsp; Contraction</th>';
    tablesHtml += '</tr></thead><tbody>';

    cat.indicators.forEach(function(ind, i) {
      var pc = phaseColor(ind.phase);
      var dirColor = ind.direction === '▲' ? C.success : ind.direction === '▼' ? C.danger : C.textSec;
      var pctFmt = ind.pctChange != null ? (ind.pctChange >= 0 ? '+' : '') + ind.pctChange.toFixed(1) + '%' : '—';
      var pctColor = ind.pctChange != null ? (ind.pctChange >= 0 ? C.success : C.danger) : C.textSec;
      var valFmt = ind.value != null ? (ind.value > 1000 ? ind.value.toLocaleString(undefined, {maximumFractionDigits:0}) : ind.value.toFixed(ind.value < 10 ? 2 : 1)) : '—';
      var rowBg = i % 2 === 0 ? '' : 'background:rgba(0,0,0,0.02);';

      // Phase bar — 5 phase slots, filled for current phase
      var phases = ['Recovery','Expansion','Neutral','Slowdown','Contraction'];
      var phaseBarHtml = '<div style="display:flex;gap:3px;align-items:center;">';
      phases.forEach(function(ph) {
        var active = ind.phase === ph;
        var ppc = phaseColor(ph);
        phaseBarHtml += '<div title="' + ph + '" style="width:18px;height:18px;border-radius:3px;background:' + (active ? ppc.badge : 'var(--border)') + ';'
          + 'border:1px solid ' + (active ? ppc.border : 'var(--border)') + ';'
          + 'display:flex;align-items:center;justify-content:center;font-size:8px;color:' + (active ? '#fff' : 'transparent') + ';font-weight:700;" >'
          + (active ? ph.slice(0,1) : '') + '</div>';
      });
      phaseBarHtml += '</div>';

      var indExpl = ind.explain ? String(ind.explain).replace(/"/g, '&quot;') : '';
      tablesHtml += '<tr style="' + rowBg + 'border-bottom:1px solid var(--border);">';
      tablesHtml += '<td style="padding:7px 14px;font-weight:600;">' + ind.name
        + (indExpl ? ' <span class="help-icon" title="' + indExpl + '" data-heading="' + String(ind.name).replace(/"/g,'&quot;') + '" style="font-size:11px;">ⓘ</span>' : '')
        + '</td>';
      tablesHtml += '<td style="padding:7px 14px;text-align:right;font-weight:700;font-family:monospace;">' + valFmt + '</td>';
      tablesHtml += '<td style="padding:7px 14px;text-align:center;font-size:13px;font-weight:700;color:' + dirColor + ';">' + ind.direction + '</td>';
      tablesHtml += '<td style="padding:7px 14px;text-align:right;font-weight:700;color:' + pctColor + ';font-family:monospace;">' + pctFmt + '</td>';
      tablesHtml += '<td style="padding:7px 14px;font-size:10.5px;color:var(--text-sec);">' + (ind.date || '—') + '</td>';
      tablesHtml += '<td style="padding:7px 14px;text-align:center;">'
        + '<span style="background:' + pc.badge + ';color:#fff;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;">' + ind.phase + '</span>'
        + '</td>';
      tablesHtml += '<td style="padding:7px 14px;">' + phaseBarHtml + '</td>';
      tablesHtml += '</tr>';
    });

    tablesHtml += '</tbody></table></div>';
    tablesHtml += '</div>';
  });

  // ── Timestamp ─────────────────────────────────────────────────────
  var footer = '<div style="padding:10px 18px;font-size:10.5px;color:var(--text-sec);border-top:1px solid var(--border);background:var(--panel);">'
    + 'FRED data as of: ' + new Date(data.timestamp).toLocaleString()
    + ' &nbsp;·&nbsp; Phase = level threshold (where defined) or 3M trend (>±1.5%). N/A = series unavailable for this account.'
    + ' &nbsp;·&nbsp; <a href="https://fred.stlouisfed.org" target="_blank" style="color:var(--navy);">fred.stlouisfed.org</a>'
    + '</div>';

  el.innerHTML = summaryHtml + legendHtml + tablesHtml + footer;
}

// ═══════════════════════════════════════════════════════════════════
// RESEARCH PAGE — NEW TAB RENDERERS
// Financial Statements · Valuation · Peer Comparison
// ═══════════════════════════════════════════════════════════════════

// ── Shared helpers ──────────────────────────────────────────────────
function resN(v) { // format number
  if (v == null) return '—';
  var a = Math.abs(v);
  if (a >= 1e12) return '$'+(v/1e12).toFixed(2)+'T';
  if (a >= 1e9)  return '$'+(v/1e9).toFixed(2)+'B';
  if (a >= 1e6)  return '$'+(v/1e6).toFixed(1)+'M';
  return '$'+v.toLocaleString(undefined,{maximumFractionDigits:0});
}
function resP(v) { return v!=null ? (v>=0?'+':'')+v.toFixed(1)+'%' : '—'; }
function resX(v) { return v!=null ? v.toFixed(1)+'x' : '—'; }
function resPct(cur, prev) { return (cur!=null&&prev!=null&&prev!==0) ? (cur-prev)/Math.abs(prev)*100 : null; }

function resFinTable(rows, years) {
  // rows: [{label, data:[{year,value},...]}]
  // Returns an HTML table string
  var h = '<table style="width:100%;font-size:12px;border-collapse:collapse;">';
  h += '<thead><tr style="background:var(--navy);color:#fff;">';
  h += '<th style="padding:8px 14px;text-align:left;min-width:180px;">Metric</th>';
  years.forEach(function(y){ h += '<th style="padding:8px 12px;text-align:right;">'+y+'</th>'; });
  h += '<th style="padding:8px 12px;text-align:right;color:rgba(255,255,255,0.7);">YoY</th>';
  h += '</tr></thead><tbody>';
  rows.forEach(function(row, ri) {
    if (row.separator) {
      h += '<tr><td colspan="'+(years.length+2)+'" style="padding:4px 14px;background:var(--panel);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-sec);">'+row.label+'</td></tr>';
      return;
    }
    var vals = {};
    (row.data||[]).forEach(function(d){ vals[d.year]=d.value; });
    var bg = ri%2===0?'':'background:rgba(0,0,0,0.02);';
    h += '<tr style="'+bg+'border-bottom:1px solid var(--border);">';
    h += '<td style="padding:7px 14px;font-weight:600;">'+row.label+'</td>';
    var prevVal = null;
    years.forEach(function(y, yi) {
      var v = vals[y];
      var fmtFn = row.fmt || resN;
      var txt = fmtFn(v);
      // Color direction vs prev year
      var col = '';
      if (v!=null && prevVal!=null) {
        var better = row.higherBetter !== false ? v > prevVal : v < prevVal;
        col = 'color:'+(better?C.success:C.danger)+';';
      }
      h += '<td style="padding:7px 12px;text-align:right;font-family:monospace;'+col+'">'+txt+'</td>';
      prevVal = v;
    });
    // YoY (last 2 years)
    var lastYr = years[years.length-1], prevYr = years[years.length-2];
    var yoy = resPct(vals[lastYr], vals[prevYr]);
    var yoyCol = yoy==null?C.textSec:(yoy>=0?C.success:C.danger);
    h += '<td style="padding:7px 12px;text-align:right;font-weight:700;color:'+yoyCol+';font-size:11px;">'+(yoy!=null?resP(yoy):'—')+'</td>';
    h += '</tr>';
  });
  h += '</tbody></table>';
  return h;
}

// ── Financial Statements & Forecasts ────────────────────────────────
function resRenderFinancials(ticker, d) {
  var finContent = document.getElementById('resFinancialsContent');
  var finEmpty   = document.getElementById('resFinancialsEmpty');
  if (!finContent) return;
  finContent.style.display = '';
  if (finEmpty) finEmpty.style.display = 'none';

  var inc = d.incomeStatement || {};
  var bs  = d.balanceSheet    || {};
  var cf  = d.cashFlowStatement || {};
  var at  = d.analystTargets  || {};
  var ar  = d.analystRatings  || {};
  var profile = d.profile || {};

  function getYears(arr) { return arr&&arr.length ? arr.map(function(r){return r.year||(r.period?r.period.slice(0,4):'');}) : []; }
  function getVals(arr)  { var m={}; (arr||[]).forEach(function(r){m[r.year||(r.period?r.period.slice(0,4):'')]=r.value;}); return m; }

  // ── Build 3-year forward projections ────────────────────────────
  // Use: last 3-yr CAGR for revenue and earnings, then project forward
  // Clamp growth rates to sane ranges
  function cagr(arr, yrs) {
    if (!arr||arr.length<2) return 0.07; // default 7%
    var n = Math.min(arr.length-1, yrs||3);
    var first = arr[arr.length-1-n]?.value, last = arr[arr.length-1]?.value;
    if (!first||!last||first<=0||last<=0) return 0.07;
    return Math.pow(last/first, 1/n) - 1;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  var revArr = inc.revenue||[];
  var epsArr = inc.eps||[];
  var niArr  = inc.netIncome||[];
  var ocfArr = cf.operatingCashFlow||[];
  var capexArr = cf.capitalExpenditures||[];

  var revCAGR  = clamp(cagr(revArr),  -0.10, 0.30);
  var niCAGR   = clamp(cagr(niArr),   -0.15, 0.40);
  var epsCAGR  = clamp(cagr(epsArr),  -0.15, 0.40);
  var ocfCAGR  = clamp(cagr(ocfArr),  -0.10, 0.30);

  var baseYear = parseInt(getYears(revArr).slice(-1)[0]||new Date().getFullYear());
  var projYears = [baseYear+1, baseYear+2, baseYear+3];

  function projectVal(arr, rate, yr) {
    var base = arr&&arr.length?arr[arr.length-1].value:null;
    if (base==null) return null;
    return base * Math.pow(1+rate, yr-baseYear);
  }

  // Industry benchmarks (GICS sector medians)
  var SECTOR_BENCHMARKS = {
    'Technology':           { revCAGR:0.12, niCAGR:0.15, grossMargin:60, opMargin:22, netMargin:18, roe:25, de:0.5  },
    'Healthcare':           { revCAGR:0.09, niCAGR:0.11, grossMargin:55, opMargin:18, netMargin:14, roe:18, de:0.7  },
    'Financials':           { revCAGR:0.07, niCAGR:0.08, grossMargin:null, opMargin:25, netMargin:20, roe:12, de:3.0 },
    'Consumer Discretionary':{ revCAGR:0.08, niCAGR:0.10, grossMargin:35, opMargin:10, netMargin:6,  roe:25, de:1.5 },
    'Consumer Staples':     { revCAGR:0.05, niCAGR:0.07, grossMargin:30, opMargin:12, netMargin:7,  roe:20, de:1.2  },
    'Energy':               { revCAGR:0.03, niCAGR:0.05, grossMargin:35, opMargin:12, netMargin:8,  roe:12, de:0.5  },
    'Industrials':          { revCAGR:0.07, niCAGR:0.09, grossMargin:35, opMargin:12, netMargin:7,  roe:18, de:1.0  },
    'Materials':            { revCAGR:0.05, niCAGR:0.07, grossMargin:30, opMargin:12, netMargin:8,  roe:14, de:0.8  },
    'Real Estate':          { revCAGR:0.06, niCAGR:0.07, grossMargin:65, opMargin:30, netMargin:20, roe:8,  de:1.5  },
    'Utilities':            { revCAGR:0.04, niCAGR:0.05, grossMargin:30, opMargin:20, netMargin:12, roe:10, de:1.2  },
    'Communication Services':{ revCAGR:0.08, niCAGR:0.11, grossMargin:45, opMargin:18, netMargin:12, roe:18, de:1.0 },
  };
  var bench = SECTOR_BENCHMARKS[profile.sector]||{revCAGR:0.07,niCAGR:0.09,grossMargin:35,opMargin:12,netMargin:8,roe:15,de:1.0};

  // ── Generic financial table with historical years + 3 projection cols + industry col ──
  function resFinTable2(rows, histYears) {
    if (!histYears.length) return '<p style="padding:14px;color:var(--text-sec);">No data available.</p>';
    var h = '<div style="overflow-x:auto;"><table style="width:100%;font-size:11.5px;border-collapse:collapse;white-space:nowrap;">';
    h += '<thead><tr style="background:var(--navy);color:#fff;">';
    h += '<th style="padding:7px 12px;text-align:left;min-width:170px;">Metric</th>';
    histYears.forEach(function(y){ h += '<th style="padding:7px 10px;text-align:right;">'+y+'</th>'; });
    projYears.forEach(function(y){ h += '<th style="padding:7px 10px;text-align:right;background:rgba(91,155,213,0.3);font-style:italic;">'+y+'E</th>'; });
    h += '<th style="padding:7px 10px;text-align:right;background:rgba(46,125,82,0.2);">Sector</th>';
    h += '</tr></thead><tbody>';
    rows.forEach(function(row, ri) {
      if (row.separator) {
        h += '<tr><td colspan="'+(histYears.length+projYears.length+2)+'" style="padding:4px 12px;background:var(--panel);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-sec);">'+row.label+'</td></tr>';
        return;
      }
      var bg = ri%2===0?'':'background:rgba(0,0,0,0.02);';
      h += '<tr style="'+bg+'border-bottom:1px solid var(--border);">';
      h += '<td style="padding:6px 12px;font-weight:600;">'+row.label+'</td>';
      var vals = getVals(row.data);
      var prevV = null;
      histYears.forEach(function(y) {
        var v = vals[y];
        var txt = row.fmt ? row.fmt(v) : (v!=null?(Math.abs(v)>=1e9?(v/1e9).toFixed(2)+'B':(Math.abs(v)>=1e6?(v/1e6).toFixed(1)+'M':'$'+v.toFixed(0))):'—');
        var col='';
        if (v!=null&&prevV!=null&&row.higherBetter!=null) col='color:'+(row.higherBetter?(v>prevV?C.success:C.danger):(v<prevV?C.success:C.danger))+';';
        h += '<td style="padding:6px 10px;text-align:right;font-family:monospace;'+col+'">'+txt+'</td>';
        prevV=v;
      });
      // Projection columns
      projYears.forEach(function(y) {
        var pv = row.projFn ? row.projFn(y) : null;
        var ptxt = pv!=null?(Math.abs(pv)>=1e9?(pv/1e9).toFixed(2)+'B':(Math.abs(pv)>=1e6?(pv/1e6).toFixed(1)+'M':'$'+pv.toFixed(0))):'—';
        if (row.fmt) ptxt = pv!=null?row.fmt(pv):'—';
        h += '<td style="padding:6px 10px;text-align:right;font-family:monospace;font-style:italic;color:var(--navy);background:rgba(91,155,213,0.06);">'+ptxt+'</td>';
      });
      // Industry benchmark
      var bv = row.benchVal;
      var btxt = bv!=null?(row.fmt?row.fmt(bv):bv.toFixed(1)):'—';
      h += '<td style="padding:6px 10px;text-align:right;font-family:monospace;color:#2E7D52;font-weight:600;background:rgba(46,125,82,0.05);">'+btxt+'</td>';
      h += '</tr>';
    });
    h += '</tbody></table></div>';
    h += '<div style="font-size:10px;color:var(--text-sec);padding:6px 12px;border-top:1px solid var(--border);">Italic columns = estimates based on trailing '+Math.round((revCAGR*100))+'% revenue CAGR &amp; '+Math.round(niCAGR*100)+'% earnings CAGR (clamped). Green column = sector median benchmark.</div>';
    return h;
  }

  var histYears = getYears(revArr).slice(-5);
  if (!histYears.length) histYears = getYears(epsArr).slice(-5);

  // ── Income Statement ──
  var incRows = [
    {label:'Revenue',        data:inc.revenue,        higherBetter:true,  projFn:function(y){return projectVal(revArr,revCAGR,y);},  benchVal:null,        fmt:null},
    {label:'Gross Profit',   data:inc.grossProfit,    higherBetter:true,  projFn:function(y){return projectVal(revArr,revCAGR,y)*(bench.grossMargin/100);}, benchVal:null, fmt:null},
    {label:'Gross Margin',   data:(inc.grossProfit||[]).map(function(r,i){var rv=(inc.revenue||[])[i];return rv&&r.value&&rv.value?{year:r.year,value:r.value/rv.value*100}:{year:r.year,value:null};}), higherBetter:true, projFn:function(){return bench.grossMargin;}, benchVal:bench.grossMargin, fmt:function(v){return v!=null?v.toFixed(1)+'%':'—';}},
    {separator:true,label:'Operating'},
    {label:'Operating Income',data:inc.operatingIncome,higherBetter:true, projFn:function(y){return projectVal(revArr,revCAGR,y)*(bench.opMargin/100);}, benchVal:null, fmt:null},
    {label:'Operating Margin',data:(inc.operatingIncome||[]).map(function(r,i){var rv=(inc.revenue||[])[i];return rv&&r.value&&rv.value?{year:r.year,value:r.value/rv.value*100}:{year:r.year,value:null};}),higherBetter:true,projFn:function(){return bench.opMargin;},benchVal:bench.opMargin,fmt:function(v){return v!=null?v.toFixed(1)+'%':'—';}},
    {separator:true,label:'Bottom Line'},
    {label:'Net Income',     data:inc.netIncome,      higherBetter:true,  projFn:function(y){return projectVal(niArr,niCAGR,y);},    benchVal:null, fmt:null},
    {label:'Net Margin',     data:(inc.netIncome||[]).map(function(r,i){var rv=(inc.revenue||[])[i];return rv&&r.value&&rv.value?{year:r.year,value:r.value/rv.value*100}:{year:r.year,value:null};}),higherBetter:true,projFn:function(){return bench.netMargin;},benchVal:bench.netMargin,fmt:function(v){return v!=null?v.toFixed(1)+'%':'—';}},
    {label:'EPS (Diluted)',  data:inc.eps,            higherBetter:true,  projFn:function(y){return projectVal(epsArr,epsCAGR,y);},  benchVal:null, fmt:function(v){return v!=null?'$'+v.toFixed(2):'—';}},
    {separator:true,label:'Expenses'},
    {label:'R&D',            data:inc.researchAndDev, higherBetter:null,  projFn:null, benchVal:null, fmt:null},
    {label:'SG&A',           data:inc.sgAndA,         higherBetter:false, projFn:null, benchVal:null, fmt:null},
  ];
  var incEl = document.getElementById('resIncomeStatement');
  if (incEl) incEl.innerHTML = resFinTable2(incRows, histYears);

  // ── Balance Sheet ──
  var bsYears = getYears(bs.totalAssets||bs.cash||[]).slice(-5);
  var bsRows = [
    {label:'Total Assets',   data:bs.totalAssets,      higherBetter:true,  projFn:null,benchVal:null,fmt:null},
    {label:'Current Assets', data:bs.currentAssets,    higherBetter:true,  projFn:null,benchVal:null,fmt:null},
    {label:'Cash & Equiv.',  data:bs.cash,             higherBetter:true,  projFn:null,benchVal:null,fmt:null},
    {separator:true,label:'Liabilities'},
    {label:'Total Liabilities',data:bs.totalLiabilities,higherBetter:false,projFn:null,benchVal:null,fmt:null},
    {label:'Current Liab.',  data:bs.currentLiabilities,higherBetter:false,projFn:null,benchVal:null,fmt:null},
    {label:'Long-Term Debt', data:bs.longTermDebt,     higherBetter:false, projFn:null,benchVal:null,fmt:null},
    {separator:true,label:'Equity & Ratios'},
    {label:'Stockholders Eq.',data:bs.stockholdersEquity,higherBetter:true,projFn:null,benchVal:null,fmt:null},
    {label:'Current Ratio',  data:(bs.currentAssets||[]).map(function(r,i){var cl=(bs.currentLiabilities||[])[i];return cl&&cl.value&&r.value?{year:r.year,value:r.value/cl.value}:{year:r.year,value:null};}),higherBetter:true,projFn:null,benchVal:1.5,fmt:function(v){return v!=null?v.toFixed(2)+'x':'—';}},
    {label:'Debt/Equity',    data:(bs.longTermDebt||[]).map(function(r,i){var eq2=(bs.stockholdersEquity||[])[i];return eq2&&eq2.value&&r.value&&eq2.value>0?{year:r.year,value:r.value/eq2.value}:{year:r.year,value:null};}),higherBetter:false,projFn:null,benchVal:bench.de,fmt:function(v){return v!=null?v.toFixed(2)+'x':'—';}},
  ];
  var bsEl = document.getElementById('resBalanceSheet');
  if (bsEl) bsEl.innerHTML = resFinTable2(bsRows, bsYears.length?bsYears:histYears);

  // ── Cash Flow ──
  var cfYears = getYears(cf.operatingCashFlow||[]).slice(-5);
  var baseOCF = ocfArr&&ocfArr.length?ocfArr[ocfArr.length-1].value:null;
  var cfRows = [
    {label:'Operating CF',   data:cf.operatingCashFlow,higherBetter:true, projFn:function(y){return projectVal(ocfArr,ocfCAGR,y);},benchVal:null,fmt:null},
    {label:'CapEx',          data:(cf.capitalExpenditures||[]).map(function(r){return {year:r.year,value:r.value!=null?Math.abs(r.value):null};}),higherBetter:false,projFn:null,benchVal:null,fmt:null},
    {label:'Free Cash Flow', data:(cf.operatingCashFlow||[]).map(function(r,i){var cx=(cf.capitalExpenditures||[])[i];var cxv=cx&&cx.value!=null?Math.abs(cx.value):0;return {year:r.year,value:r.value!=null?r.value-cxv:null};}),higherBetter:true,projFn:function(y){return projectVal(ocfArr,ocfCAGR,y)-(baseOCF?Math.abs(capexArr&&capexArr.length?capexArr[capexArr.length-1].value:0):0);},benchVal:null,fmt:null},
    {separator:true,label:'Capital Returns'},
    {label:'Share Buybacks', data:(cf.stockRepurchases||[]).map(function(r){return {year:r.year,value:r.value!=null?Math.abs(r.value):null};}),higherBetter:null,projFn:null,benchVal:null,fmt:null},
    {label:'Dividends Paid', data:(cf.dividendsPaid||[]).map(function(r){return {year:r.year,value:r.value!=null?Math.abs(r.value):null};}),higherBetter:null,projFn:null,benchVal:null,fmt:null},
    {label:'Stock-Based Comp',data:cf.stockBasedComp,  higherBetter:false,projFn:null,benchVal:null,fmt:null},
  ];
  var cfEl = document.getElementById('resCashFlow');
  if (cfEl) cfEl.innerHTML = resFinTable2(cfRows, cfYears.length?cfYears:histYears);

  // ── Analyst Forecasts ──
  var afEl = document.getElementById('resAnalystForecasts');
  if (afEl) {
    var totalA2 = (ar.strongBuy||0)+(ar.buy||0)+(ar.hold||0)+(ar.sell||0)+(ar.strongSell||0);
    var px2 = d.price&&d.price.current?d.price.current:null;
    var upside2 = at.mean&&px2?(at.mean-px2)/px2*100:null;
    var afHtml = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:14px;">';
    function aBox(lbl,val,sub,col){return '<div style="background:var(--panel);border:1px solid var(--border);border-left:4px solid '+(col||C.navy)+';border-radius:4px;padding:10px 12px;"><div style="font-size:10px;color:var(--text-sec);">'+lbl+'</div><div style="font-size:20px;font-weight:800;color:'+(col||C.navy)+';">'+val+'</div>'+(sub?'<div style="font-size:11px;color:var(--text-sec);">'+sub+'</div>':'')+'</div>';}
    if(at.mean)  afHtml += aBox('Target (Mean)','$'+at.mean.toFixed(2),upside2!=null?(upside2>=0?'+':'')+upside2.toFixed(1)+'% upside':'',upside2>0?C.success:C.danger);
    if(at.high)  afHtml += aBox('Target High','$'+at.high.toFixed(2),'Bull case',C.success);
    if(at.low)   afHtml += aBox('Target Low','$'+at.low.toFixed(2),'Bear case',C.danger);
    if(at.median)afHtml += aBox('Target Median','$'+at.median.toFixed(2),'Median consensus',C.navy);
    afHtml += '</div>';
    if(totalA2>0){
      afHtml += '<div style="font-size:11px;font-weight:700;color:var(--text-sec);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Rating Distribution ('+totalA2+' analysts)</div>';
      afHtml += '<div style="display:flex;gap:8px;flex-wrap:wrap;">';
      [{lbl:'Strong Buy',cnt:ar.strongBuy||0,col:C.success},{lbl:'Buy',cnt:ar.buy||0,col:'#5CB85C'},{lbl:'Hold',cnt:ar.hold||0,col:'#8B6914'},{lbl:'Sell',cnt:ar.sell||0,col:'#D9534F'},{lbl:'Strong Sell',cnt:ar.strongSell||0,col:C.danger}].forEach(function(r){
        if(!r.cnt)return;
        afHtml += '<div style="background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:8px 12px;text-align:center;min-width:80px;">'
          +'<div style="font-size:10px;color:var(--text-sec);">'+r.lbl+'</div>'
          +'<div style="font-size:18px;font-weight:800;color:'+r.col+';">'+r.cnt+'</div>'
          +'<div style="font-size:10px;color:var(--text-sec);">'+(r.cnt/totalA2*100).toFixed(0)+'%</div></div>';
      });
      afHtml += '</div>';
    }
    if(!totalA2&&!at.mean) afHtml += '<p style="color:var(--text-sec);font-size:12px;">No analyst estimates available.</p>';
    afEl.innerHTML = afHtml;
  }

  // ── Bear / Base / Bull scenario table ────────────────────────────
  var scenEl = document.getElementById('resScenarioCard');
  var scenTableEl = document.getElementById('resScenarioTable');
  if (scenEl && scenTableEl && revArr.length) {
    scenEl.style.display = '';
    var bearRate  = revCAGR * 0.4;
    var bullRate  = revCAGR * 1.6;
    var bearNiRate= niCAGR  * 0.4;
    var bullNiRate= niCAGR  * 1.6;
    var bearEpsRate= epsCAGR * 0.4;
    var bullEpsRate= epsCAGR * 1.6;
    var baseRev = revArr.length ? revArr[revArr.length-1].value : null;
    var baseNI  = niArr.length  ? niArr[niArr.length-1].value   : null;
    var baseEPS = epsArr.length ? epsArr[epsArr.length-1].value : null;
    function Nm2(v){if(v==null)return'—';var a=Math.abs(v);if(a>=1e12)return'$'+(v/1e12).toFixed(2)+'T';if(a>=1e9)return'$'+(v/1e9).toFixed(2)+'B';if(a>=1e6)return'$'+(v/1e6).toFixed(1)+'M';return'$'+v.toFixed(0);}
    var sh = '<div style="overflow-x:auto;"><table style="width:100%;font-size:12px;border-collapse:collapse;">';
    sh += '<thead><tr style="background:var(--navy);color:#fff;"><th style="padding:7px 12px;text-align:left;">Metric</th>';
    projYears.forEach(function(y) {
      sh += '<th style="padding:7px 8px;text-align:right;background:rgba(178,34,34,0.35);">'+y+' Bear</th>';
      sh += '<th style="padding:7px 8px;text-align:right;background:rgba(0,60,113,0.35);">'+y+' Base</th>';
      sh += '<th style="padding:7px 8px;text-align:right;background:rgba(46,125,82,0.35);">'+y+' Bull</th>';
    });
    sh += '</tr></thead><tbody>';
    [
      {label:'Revenue', base:baseRev, br:bearRate, bl:bullRate, fmt:Nm2},
      {label:'Net Income', base:baseNI, br:bearNiRate, bl:bullNiRate, fmt:Nm2},
      {label:'EPS (Diluted)', base:baseEPS, br:bearEpsRate, bl:bullEpsRate, fmt:function(v){return v!=null?'$'+v.toFixed(2):'—';}}
    ].forEach(function(row, ri) {
      sh += '<tr style="'+(ri%2===0?'':'background:rgba(0,0,0,0.02);')+'border-bottom:1px solid var(--border);">';
      sh += '<td style="padding:6px 12px;font-weight:600;">'+row.label+'</td>';
      projYears.forEach(function(y) {
        var n = y - baseYear;
        var bear = row.base != null ? row.base * Math.pow(1+row.br, n) : null;
        var base = row.base != null ? row.base * Math.pow(1+revCAGR*(row.br===bearRate?1:row.br===bearNiRate?niCAGR/bearNiRate*0.4:1), n) : null;
        // Simpler: just use the correct CAGR for each row
        var baseV = row.base != null ? row.base * Math.pow(1+(row.bl===bullRate?revCAGR:row.bl===bullNiRate?niCAGR:epsCAGR), n) : null;
        var bull = row.base != null ? row.base * Math.pow(1+row.bl, n) : null;
        sh += '<td style="padding:6px 8px;text-align:right;font-family:monospace;color:var(--danger);font-style:italic;">'+row.fmt(bear)+'</td>';
        sh += '<td style="padding:6px 8px;text-align:right;font-family:monospace;color:var(--navy);font-weight:700;">'+row.fmt(baseV)+'</td>';
        sh += '<td style="padding:6px 8px;text-align:right;font-family:monospace;color:var(--success);font-style:italic;">'+row.fmt(bull)+'</td>';
      });
      sh += '</tr>';
    });
    sh += '</tbody></table></div>';
    sh += '<div style="font-size:10.5px;color:var(--text-sec);margin-top:6px;">Bear = 40% of trailing CAGR ('+( revCAGR*100).toFixed(1)+'% → '+(bearRate*100).toFixed(1)+'%). Base = trailing CAGR. Bull = 160% of trailing CAGR (→'+(bullRate*100).toFixed(1)+'%).</div>';
    scenTableEl.innerHTML = sh;
  }

  // ── Revenue trend + projection bar chart ─────────────────────────
  var revChartCard = document.getElementById('resRevChartCard');
  var revChartEl = document.getElementById('resRevChart');
  if (revChartCard && revChartEl && revArr.length) {
    revChartCard.style.display = '';
    var revLabels = histYears.concat(projYears.map(function(y){return y+'E';}));
    var revActual = histYears.map(function(y){ var v = getVals(revArr)[y]; return v!=null?parseFloat((v/1e9).toFixed(3)):null; });
    var baseRevBase = revArr.length ? revArr[revArr.length-1].value : 0;
    var revProj = projYears.map(function(y){ return parseFloat((baseRevBase*Math.pow(1+revCAGR,y-baseYear)/1e9).toFixed(3)); });
    var revBear = projYears.map(function(y){ return parseFloat((baseRevBase*Math.pow(1+revCAGR*0.4,y-baseYear)/1e9).toFixed(3)); });
    var revBull = projYears.map(function(y){ return parseFloat((baseRevBase*Math.pow(1+revCAGR*1.6,y-baseYear)/1e9).toFixed(3)); });
    var prevRevChart = Chart.getChart(revChartEl); if (prevRevChart) prevRevChart.destroy();
    new Chart(revChartEl.getContext('2d'), {
      type: 'bar',
      data: { labels: revLabels, datasets: [
        { label: 'Actual Revenue ($B)', data: revActual.concat(new Array(projYears.length).fill(null)), backgroundColor: C.navy, borderRadius: 3 },
        { label: 'Base Projection', data: new Array(histYears.length).fill(null).concat(revProj), backgroundColor: 'rgba(91,155,213,0.7)', borderRadius: 3 },
        { label: 'Bear', data: new Array(histYears.length).fill(null).concat(revBear), backgroundColor: 'rgba(178,34,34,0.5)', borderRadius: 3 },
        { label: 'Bull', data: new Array(histYears.length).fill(null).concat(revBull), backgroundColor: 'rgba(46,125,82,0.5)', borderRadius: 3 }
      ]},
      options: { responsive:true, maintainAspectRatio:false, plugins: { legend:{position:'bottom',labels:{font:{size:10},color:C.textSec}}, tooltip: Object.assign({},chartTooltip,{callbacks:{label:function(ctx){return ctx.dataset.label+': $'+ctx.parsed.y.toFixed(2)+'B';}}}) },
        scales: { x:{grid:{display:false},ticks:chartTicks}, y:{grid:chartGrid,ticks:Object.assign({},chartTicks,{callback:function(v){return '$'+v+'B';}}),title:{display:true,text:'Revenue ($B)',font:{size:10},color:C.textSec}} } }
    });
  }

  // ── Margin evolution line chart ────────────────────────────────────
  var marginChartCard = document.getElementById('resMarginChartCard');
  var marginChartEl = document.getElementById('resMarginChart');
  if (marginChartCard && marginChartEl && histYears.length) {
    marginChartCard.style.display = '';
    var revMap = getVals(revArr), gpMap = getVals(inc.grossProfit||[]), oiMap = getVals(inc.operatingIncome||[]), niMap2 = getVals(inc.netIncome||[]);
    var gmData = histYears.map(function(y){ var r=revMap[y],g=gpMap[y]; return r&&g&&r>0?parseFloat((g/r*100).toFixed(1)):null; });
    var omData = histYears.map(function(y){ var r=revMap[y],o=oiMap[y]; return r&&o!=null&&r>0?parseFloat((o/r*100).toFixed(1)):null; });
    var nmData = histYears.map(function(y){ var r=revMap[y],n=niMap2[y]; return r&&n!=null&&r>0?parseFloat((n/r*100).toFixed(1)):null; });
    var prevMarginChart = Chart.getChart(marginChartEl); if (prevMarginChart) prevMarginChart.destroy();
    new Chart(marginChartEl.getContext('2d'), {
      type: 'line',
      data: { labels: histYears, datasets: [
        { label: 'Gross Margin', data: gmData, borderColor: C.success, backgroundColor:'rgba(46,125,82,0.1)', borderWidth:2, pointRadius:3, tension:0.2, fill:false },
        { label: 'Operating Margin', data: omData, borderColor: C.navy, backgroundColor:'rgba(0,60,113,0.08)', borderWidth:2, pointRadius:3, tension:0.2, fill:false },
        { label: 'Net Margin', data: nmData, borderColor: C.blue, backgroundColor:'rgba(91,155,213,0.08)', borderWidth:2, pointRadius:3, tension:0.2, fill:false }
      ]},
      options: { responsive:true, maintainAspectRatio:false, plugins: { legend:{position:'bottom',labels:{font:{size:10},color:C.textSec}}, tooltip: Object.assign({},chartTooltip,{callbacks:{label:function(ctx){return ctx.dataset.label+': '+(ctx.parsed.y!=null?ctx.parsed.y.toFixed(1)+'%':'—');}}}) },
        scales: { x:{grid:{display:false},ticks:chartTicks}, y:{grid:chartGrid,ticks:Object.assign({},chartTicks,{callback:function(v){return v+'%';}}),title:{display:true,text:'Margin %',font:{size:10},color:C.textSec}} } }
    });
  }

  // ── FCF vs Net Income divergence chart ─────────────────────────────
  var fcfNiCard = document.getElementById('resFcfNiChartCard');
  var fcfNiEl   = document.getElementById('resFcfNiChart');
  if (fcfNiCard && fcfNiEl && histYears.length) {
    var ocfMap  = getVals(cf.operatingCashFlow||[]);
    var capexMap = {};
    (cf.capitalExpenditures||[]).forEach(function(r){ capexMap[r.year||(r.period?r.period.slice(0,4):'')] = Math.abs(r.value||0); });
    var niMap3  = getVals(inc.netIncome||[]);
    var fcfData2 = histYears.map(function(y){ var o=ocfMap[y],cx=capexMap[y]||0; return o!=null?parseFloat(((o-cx)/1e9).toFixed(3)):null; });
    var niData2  = histYears.map(function(y){ var n=niMap3[y]; return n!=null?parseFloat((n/1e9).toFixed(3)):null; });
    var hasFcf = fcfData2.some(function(v){return v!=null;});
    var hasNI  = niData2.some(function(v){return v!=null;});
    if (hasFcf || hasNI) {
      fcfNiCard.style.display = '';
      var prevFcfNiChart = Chart.getChart(fcfNiEl); if (prevFcfNiChart) prevFcfNiChart.destroy();
      new Chart(fcfNiEl.getContext('2d'), {
        type: 'bar',
        data: { labels: histYears, datasets: [
          { label: 'Free Cash Flow ($B)', data: fcfData2, backgroundColor: fcfData2.map(function(v){return v!=null&&v>=0?'rgba(46,125,82,0.7)':'rgba(178,34,34,0.7)';}), borderRadius: 3, order: 2 },
          { type: 'line', label: 'Net Income ($B)', data: niData2, borderColor: C.navy, backgroundColor:'transparent', borderWidth:2, pointRadius:3, tension:0.2, fill:false, order: 1 }
        ]},
        options: { responsive:true, maintainAspectRatio:false, plugins: { legend:{position:'bottom',labels:{font:{size:10},color:C.textSec}}, tooltip: Object.assign({},chartTooltip,{callbacks:{label:function(ctx){return ctx.dataset.label+': $'+ctx.parsed.y.toFixed(2)+'B';}}}) },
          scales: { x:{grid:{display:false},ticks:chartTicks}, y:{grid:chartGrid,ticks:Object.assign({},chartTicks,{callback:function(v){return '$'+v+'B';}}),title:{display:true,text:'$B',font:{size:10},color:C.textSec}} } }
      });
    }
  }
}

// ── Valuation Header + Ratios ────────────────────────────────────────
var SECTOR_PE = { 'Technology':28,'Healthcare':22,'Financials':14,'Consumer Discretionary':22,'Consumer Staples':20,'Energy':12,'Industrials':18,'Materials':16,'Real Estate':20,'Utilities':18,'Communication Services':20 };

function resRenderValuationHeader(ticker, d) {
  var valContent = document.getElementById('resValuationContent');
  var valEmpty   = document.getElementById('resValuationEmpty');
  if (!valContent) return;
  // Always show content when data is loaded — lazy load ensures ratios render
  valContent.style.display = '';
  if (valEmpty) valEmpty.style.display = 'none';
  resRenderValuationRatios(ticker, d);
}

function resRenderValuationRatios(ticker, d) {
  var el = document.getElementById('resValuationRatios');
  if (!el) return;
  var inc = d.incomeStatement||{}, bs = d.balanceSheet||{}, cf = d.cashFlowStatement||{};
  var px = d.price&&d.price.current?d.price.current:null;
  var prof = d.profile||{};
  function L(arr){return arr&&arr.length?arr[arr.length-1].value:null;}

  var rev   = L(inc.revenue);
  var ni    = L(inc.netIncome);
  var eps   = L(inc.eps);
  var ocf   = L(cf.operatingCashFlow);
  var capex = cf.capitalExpenditures&&cf.capitalExpenditures.length ? Math.abs(cf.capitalExpenditures[cf.capitalExpenditures.length-1].value) : 0;
  var fcf   = ocf!=null ? ocf-capex : null;
  var eq    = L(bs.stockholdersEquity);
  var ta    = L(bs.totalAssets);
  var ltd   = L(bs.longTermDebt)||0;
  var cash  = (L(bs.cash)||0)+(L(bs.shortTermInvestments)||0);
  var shares= L(bs.sharesOutstanding);
  var mktCap= prof.marketCap || (px&&shares?px*shares:null);
  var ev    = mktCap!=null ? mktCap+ltd-cash : null;
  var sector = prof.sector||'';
  var sectorPE = SECTOR_PE[sector]||20;

  var metrics = [
    { label:'P/E Ratio (Trailing)',   val: eps&&eps>0&&px?px/eps:null,        fmt: resX, bench: sectorPE,     unit:'x', note:'Sector median: '+sectorPE+'x' },
    { label:'Price / Sales',          val: rev&&mktCap?mktCap/rev:null,        fmt: resX, bench: 3,           unit:'x', note:'S&P 500 median ~3x' },
    { label:'Price / Book',           val: eq&&eq>0&&mktCap?mktCap/eq:null,    fmt: resX, bench: 3.5,         unit:'x', note:'Book value per share' },
    { label:'Price / FCF',            val: fcf&&fcf>0&&mktCap?mktCap/fcf:null, fmt: resX, bench: 20,          unit:'x', note:'Market cap / free cash flow' },
    { label:'EV / Revenue',           val: ev&&rev?ev/rev:null,                fmt: resX, bench: 4,           unit:'x', note:'Enterprise value vs. revenue' },
    { label:'EV / EBITDA (proxy)',     val: ev&&ni&&ni>0?ev/ni:null,           fmt: resX, bench: 15,          unit:'x', note:'Approximate (uses net income)' },
    { label:'Return on Equity (ROE)', val: ni&&eq&&eq>0?ni/eq*100:null,        fmt: function(v){return v!=null?v.toFixed(1)+'%':'—';}, bench: 15, benchDir:'higher', unit:'%', note:'Sector median ~15%' },
    { label:'Return on Assets (ROA)', val: ni&&ta&&ta>0?ni/ta*100:null,        fmt: function(v){return v!=null?v.toFixed(1)+'%':'—';}, bench: 5,  benchDir:'higher', unit:'%', note:'S&P 500 median ~5%' },
    { label:'Net Profit Margin',      val: rev&&ni?ni/rev*100:null,            fmt: function(v){return v!=null?v.toFixed(1)+'%':'—';}, bench: 12, benchDir:'higher', unit:'%', note:'S&P 500 median ~12%' },
    { label:'FCF Yield',              val: fcf&&mktCap&&mktCap>0?fcf/mktCap*100:null, fmt:function(v){return v!=null?v.toFixed(1)+'%':'—';}, bench:4, benchDir:'higher', unit:'%', note:'FCF / Market Cap — higher is better' },
    { label:'Debt / Equity',          val: ltd&&eq&&eq>0?ltd/eq:null,          fmt: resX, bench: 1.5,         benchDir:'lower', unit:'x', note:'Net leverage — lower is better' },
    { label:'Market Cap',             val: mktCap,                             fmt: resN, bench:null, unit:'', note:'' },
    { label:'Enterprise Value',       val: ev,                                 fmt: resN, bench:null, unit:'', note:'' },
  ];

  var html = '<div style="overflow-x:auto;"><table style="width:100%;font-size:12px;border-collapse:collapse;">';
  html += '<thead><tr style="background:var(--navy);color:#fff;">'
    + '<th style="padding:8px 14px;text-align:left;">Metric</th>'
    + '<th style="padding:8px 12px;text-align:right;">Value</th>'
    + '<th style="padding:8px 12px;text-align:right;">Benchmark</th>'
    + '<th style="padding:8px 12px;text-align:center;">Signal</th>'
    + '<th style="padding:8px 14px;text-align:left;">Note</th>'
    + '</tr></thead><tbody>';
  metrics.forEach(function(m, i) {
    var v = m.val;
    var fmtd = m.fmt ? m.fmt(v) : (v!=null?v.toFixed(2):' — ');
    var signal = '', sigCol = C.textSec;
    if (v!=null && m.bench!=null) {
      var cheaper = m.benchDir==='higher' ? v>m.bench : v<m.bench;
      if (cheaper) { signal='✓ Favorable'; sigCol=C.success; }
      else          { signal='↑ Above Bench'; sigCol='#8B6914'; }
    }
    var bg = i%2===0?'':'background:rgba(0,0,0,0.02);';
    html += '<tr style="'+bg+'border-bottom:1px solid var(--border);">'
      + '<td style="padding:7px 14px;font-weight:600;">'+m.label+'</td>'
      + '<td style="padding:7px 12px;text-align:right;font-family:monospace;font-weight:700;">'+fmtd+'</td>'
      + '<td style="padding:7px 12px;text-align:right;font-size:11px;color:var(--text-sec);">'+(m.bench!=null?m.bench+m.unit:'—')+'</td>'
      + '<td style="padding:7px 12px;text-align:center;font-size:11px;font-weight:600;color:'+sigCol+';">'+signal+'</td>'
      + '<td style="padding:7px 14px;font-size:11px;color:var(--text-sec);">'+m.note+'</td>'
      + '</tr>';
  });
  html += '</tbody></table></div>';
  el.innerHTML = html;
}

// ── Peer Comparison ──────────────────────────────────────────────────
// Pre-mapped sector peers — top 6-8 by market cap within sector/industry
var SECTOR_PEERS = {
  'Technology': {
    'Semiconductors & Semiconductor Equipment': ['NVDA','AMD','AVGO','QCOM','TXN','MU','INTC','AMAT'],
    'Software': ['MSFT','ADBE','CRM','ORCL','SAP','NOW','INTU','WDAY'],
    'Internet': ['GOOGL','META','AMZN','SNAP','PINS','TWTR','SPOT'],
    'Hardware': ['AAPL','DELL','HPQ','STX','WDC'],
    'default': ['AAPL','MSFT','NVDA','GOOGL','META','AVGO','ORCL','CRM']
  },
  'Healthcare': {
    'Pharmaceuticals': ['JNJ','LLY','PFE','MRK','AZN','BMY','ABBV','AMGN'],
    'Biotechnology': ['GILD','REGN','VRTX','BIIB','MRNA','ILMN'],
    'Medical Devices': ['MDT','ABT','SYK','BSX','EW','ISRG'],
    'Health Care Providers': ['UNH','CVS','CI','HUM','CNC'],
    'default': ['LLY','UNH','JNJ','ABBV','MRK','PFE','TMO','ABT']
  },
  'Financials': {
    'Banks': ['JPM','BAC','WFC','C','GS','MS','USB','TFC'],
    'Insurance': ['BRK-B','MET','PRU','AFL','ALL','AIG'],
    'Asset Management': ['BLK','SCHW','STT','BEN'],
    'default': ['JPM','BAC','GS','MS','WFC','BLK','AXP','V']
  },
  'Consumer Discretionary': {
    'Retail': ['AMZN','HD','TGT','COST','WMT','LOW','TJX'],
    'Automotive': ['TSLA','GM','F','STLA','TM','HMC'],
    'Hotels & Entertainment': ['MAR','HLT','DIS','NFLX','CMCSA'],
    'default': ['AMZN','TSLA','HD','MCD','NKE','SBUX','BKNG','GM']
  },
  'Consumer Staples': {
    'default': ['PG','KO','PEP','COST','WMT','PM','MO','CL']
  },
  'Energy': {
    'Integrated Oil': ['XOM','CVX','BP','SHEL','TTE'],
    'E&P': ['COP','EOG','PXD','DVN','HES','MRO'],
    'default': ['XOM','CVX','COP','EOG','SLB','MPC','PSX','VLO']
  },
  'Industrials': {
    'Aerospace': ['RTX','LMT','NOC','GD','BA'],
    'Industrial Machinery': ['HON','GE','EMR','ROK','ETN','PH'],
    'Transportation': ['UNP','CSX','NSC','UPS','FDX'],
    'default': ['GE','HON','RTX','CAT','UNP','UPS','BA','LMT']
  },
  'Materials': {
    'default': ['LIN','APD','SHW','FCX','NUE','NEM','AA','CF']
  },
  'Real Estate': {
    'default': ['AMT','PLD','CCI','EQIX','PSA','O','SPG','AVB']
  },
  'Utilities': {
    'default': ['NEE','SO','DUK','CEG','AEP','EXC','PCG','XEL']
  },
  'Communication Services': {
    'Telecom': ['VZ','T','TMUS','CHTR','CMCSA'],
    'Media & Entertainment': ['META','GOOGL','NFLX','DIS','SPOT'],
    'default': ['META','GOOGL','NFLX','CMCSA','T','VZ','DIS','TMUS']
  }
};

function resPeerAutoDetect() {
  var d = window._lastSecData;
  if (!d) return;
  var sector = (d.profile||{}).sector||'';
  var industry = (d.profile||{}).industry||'';
  var ticker = window._lastSecTicker||'';
  var peerMap = SECTOR_PEERS[sector]||{};
  // Try to match industry
  var peers = null;
  Object.keys(peerMap).forEach(function(key) {
    if (key !== 'default' && industry.toLowerCase().indexOf(key.toLowerCase()) >= 0) peers = peerMap[key];
  });
  if (!peers) peers = peerMap['default'] || ['SPY','QQQ','IWM'];
  // Remove the current ticker from peer list
  peers = peers.filter(function(p){return p.toUpperCase()!==ticker.toUpperCase();}).slice(0,7);
  var inputEl = document.getElementById('resPeerTickers');
  if (inputEl) inputEl.value = peers.join(', ');
  var msgEl = document.getElementById('resPeerAutoMsg');
  if (msgEl) msgEl.innerHTML = 'Auto-detected '+peers.length+' peers from <strong>'+sector+'</strong>'+(industry?' / '+industry:'')+'&nbsp;·&nbsp; Edit list then click <strong>Compare Peers</strong>.';
  resPeerRun();
}

async function resPeerRun() {
  var resultEl = document.getElementById('resPeersResult');
  if (!resultEl) return;
  var inputEl = document.getElementById('resPeerTickers');
  var peerStr = inputEl ? inputEl.value.trim() : '';
  var peers = peerStr.split(',').map(function(p){return p.trim().toUpperCase();}).filter(Boolean).slice(0,8);
  var anchor = (window._lastSecTicker||'').toUpperCase();
  if (!anchor) { resultEl.innerHTML = '<p style="color:var(--text-sec);">Analyze a stock first.</p>'; return; }
  resultEl.innerHTML = '<div style="text-align:center;padding:24px;"><span class="spinner"></span> Loading peer data for '+([anchor].concat(peers)).join(', ')+'...</div>';

  var all = [anchor].concat(peers);
  var WORKER = 'https://perry-finance-proxy.zachperrybusiness.workers.dev';
  var peerData = {};
  // Batch FMP pack runs in parallel with the per-ticker SEC pulls — used to
  // backfill any metric the SEC/Yahoo path fails to produce, so every peer
  // row populates even when one source is rate-limited.
  var peerFinPromise = fetch(WORKER+'/peer-financials?symbols='+all.join(',')).then(function(r){return r.json();}).catch(function(){return null;});
  await Promise.all(all.map(async function(tk) {
    try {
      var [fund, quote, chart] = await Promise.all([
        fetch(WORKER+'/fundamentals?symbol='+tk).then(function(r){return r.json();}),
        fetch(WORKER+'/quote?symbol='+tk).then(function(r){return r.json();}),
        fetch(WORKER+'/chart?symbol='+tk+'&range=1y&interval=1d').then(function(r){return r.json();})
      ]);
      peerData[tk] = { fund, quote, chart };
    } catch(e) { peerData[tk] = { error: e.message }; }
  }));
  var peerFin = await peerFinPromise;
  var peerFinMap = {};
  if (peerFin && peerFin.peers) peerFin.peers.forEach(function(p){ peerFinMap[p.symbol] = p; });

  function getMetrics(tk) {
    var pd = peerData[tk];
    var fb = peerFinMap[tk] || {};       // FMP batch fallback pack
    var fbR = fb.ratios || {};
    var fbB = fb.balance || {};
    if ((!pd || pd.error) && !fb.symbol) return null;
    var d = (pd && pd.fund) || {}; var q = (pd && pd.quote) || {}; var ch = (pd && pd.chart) || {};
    var inc = d.incomeStatement||{}, bs = d.balanceSheet||{}, cf = d.cashFlowStatement||{};
    function L(arr){return arr&&arr.length?arr[arr.length-1].value:null;}
    function P(arr){return arr&&arr.length>1?arr[arr.length-2].value:null;}
    var px  = q.current || (d.price&&d.price.current) || fb.price || null;
    var rev = L(inc.revenue);
    var revPrev = P(inc.revenue);
    var ni  = L(inc.netIncome);
    var eps = L(inc.eps);
    var gp  = L(inc.grossProfit);
    var ocf = L(cf.operatingCashFlow);
    var capex = cf.capitalExpenditures&&cf.capitalExpenditures.length?Math.abs(cf.capitalExpenditures[cf.capitalExpenditures.length-1].value):0;
    var fcf = ocf!=null?ocf-capex:null;
    var eq  = L(bs.stockholdersEquity);
    var ltd = L(bs.longTermDebt)||0;
    var cash = (L(bs.cash)||0)+(L(bs.shortTermInvestments)||0);
    var shares = L(bs.sharesOutstanding);
    var assets = L(bs.totalAssets);
    var liabs  = L(bs.totalLiabilities);
    var mktCap = (d.profile&&d.profile.marketCap)||fb.marketCap||(px&&shares?px*shares:null);
    var ev = mktCap!=null?mktCap+ltd-cash:null;
    // 1Y and 3M returns from chart
    var pts = (ch.points||[]).filter(function(p){return p.close!=null;});
    var ret1y = pts.length>=252 ? (pts[pts.length-1].close/pts[pts.length-252].close-1)*100 : (pts.length>1?(pts[pts.length-1].close/pts[0].close-1)*100:null);
    var ret3m = pts.length>=63  ? (pts[pts.length-1].close/pts[pts.length-63].close-1)*100  : null;
    var pe = eps&&eps>0&&px?px/eps:null;
    var ps = rev&&mktCap?mktCap/rev:null;
    var pb = eq&&eq>0&&mktCap?mktCap/eq:null;
    var roe= ni&&eq&&eq>0?ni/eq*100:null;
    var npm= rev&&ni?ni/rev*100:null;
    var gm = rev&&gp!=null?gp/rev*100:null;
    var revG = (rev!=null&&revPrev)?((rev-revPrev)/Math.abs(revPrev))*100:null;
    var de = eq&&eq>0?(ltd/eq):null;
    var pfcf=fcf&&fcf>0&&mktCap?mktCap/fcf:null;
    var profile = d.profile||{};
    // ── FMP fallback backfill: any metric the SEC/Yahoo path missed ──
    if (pe==null && fbR.pe!=null) pe = fbR.pe;
    if (ps==null && fbR.ps!=null) ps = fbR.ps;
    if (pb==null && fbR.pb!=null) pb = fbR.pb;
    if (roe==null && fbR.roe!=null) roe = fbR.roe*100;
    if (npm==null && fbR.netMargin!=null) npm = fbR.netMargin*100;
    if (gm==null && fbR.grossMargin!=null) gm = fbR.grossMargin*100;
    if (de==null && fbR.debtToEquity!=null) de = fbR.debtToEquity;
    if (revG==null && fb.revenueGrowthYoY!=null) revG = fb.revenueGrowthYoY;
    if (assets==null && fbB.totalAssets!=null) assets = fbB.totalAssets;
    if (liabs==null && fbB.totalLiabilities!=null) liabs = fbB.totalLiabilities;
    if (rev==null && fb.income && fb.income.length) rev = fb.income[fb.income.length-1].revenue;
    if (ni==null && fb.income && fb.income.length) ni = fb.income[fb.income.length-1].netIncome;
    return { ticker:tk, name:profile.name||fb.name||tk, sector:profile.sector||fb.sector||'', px, mktCap, ev, rev, ni, eps, fcf, pe, ps, pb, roe, npm, gm, revG, de, assets, liabs, pfcf, ret1y, ret3m, ltd, cash };
  }

  var metrics = all.map(getMetrics);
  var valid = metrics.filter(Boolean);
  if (!valid.length) { resultEl.innerHTML = '<p style="color:var(--danger);">Failed to load peer data.</p>'; return; }

  // ── Return performance chart data ──
  // Fetch returns for sparkline comparison — just use ret1y/ret3m already loaded

  var cols = [
    { label:'Company',      key:'name',   fmt:function(v,m){return '<span style="font-weight:700;">'+m.ticker+'</span><br><span style="font-size:10px;color:var(--text-sec);">'+String(v||'').slice(0,22)+'</span>';}, raw:false },
    { label:'Price',        key:'px',     fmt:function(v){return v!=null?'$'+v.toFixed(2):'—';}, color:false },
    { label:'Mkt Cap',      key:'mktCap', fmt:resN, color:false },
    { label:'Revenue',      key:'rev',    fmt:resN, color:false },
    { label:'Rev Growth',   key:'revG',   fmt:function(v){return v!=null?(v>=0?'+':'')+v.toFixed(1)+'%':'—';}, higher:true },
    { label:'Assets',       key:'assets', fmt:resN, color:false },
    { label:'Liabilities',  key:'liabs',  fmt:resN, color:false },
    { label:'D/E',          key:'de',     fmt:resX, higher:false },
    { label:'P/E',          key:'pe',     fmt:resX, higher:false },
    { label:'P/S',          key:'ps',     fmt:resX, higher:false },
    { label:'P/Book',       key:'pb',     fmt:resX, higher:false },
    { label:'P/FCF',        key:'pfcf',   fmt:resX, higher:false },
    { label:'Gross Margin', key:'gm',     fmt:function(v){return v!=null?v.toFixed(1)+'%':'—';}, higher:true },
    { label:'Net Margin',   key:'npm',    fmt:function(v){return v!=null?v.toFixed(1)+'%':'—';}, higher:true },
    { label:'ROE',          key:'roe',    fmt:function(v){return v!=null?v.toFixed(1)+'%':'—';}, higher:true },
    { label:'1Y Return',    key:'ret1y',  fmt:function(v){return v!=null?(v>=0?'+':'')+v.toFixed(1)+'%':'—';}, higher:true },
    { label:'3M Return',    key:'ret3m',  fmt:function(v){return v!=null?(v>=0?'+':'')+v.toFixed(1)+'%':'—';}, higher:true },
  ];

  // Compute best/worst for coloring each column
  function colRank(col, vals) {
    var nums = vals.map(function(v){return typeof v==='number'?v:null;}).filter(function(v){return v!=null;});
    if (!nums.length) return {};
    var sorted = nums.slice().sort(function(a,b){return a-b;});
    var best = col.higher ? sorted[sorted.length-1] : sorted[0];
    var worst = col.higher ? sorted[0] : sorted[sorted.length-1];
    return { best, worst };
  }

  var html = '<div style="overflow-x:auto;"><table style="width:100%;font-size:12px;border-collapse:collapse;">';
  html += '<thead><tr style="background:var(--navy);color:#fff;">';
  cols.forEach(function(c){ html += '<th style="padding:8px 12px;text-align:'+(c.key==='name'?'left':'right')+';">'+c.label+'</th>'; });
  html += '</tr></thead><tbody>';

  var colVals = {};
  cols.forEach(function(c){ colVals[c.key] = valid.map(function(m){return m[c.key];}); });
  var colRanks = {};
  cols.forEach(function(c){ if (c.higher!==undefined) colRanks[c.key] = colRank(c, colVals[c.key]); });

  valid.forEach(function(m, i) {
    var isAnchor = m.ticker === anchor;
    var bg = isAnchor ? 'background:rgba(0,60,113,0.08);' : (i%2===0?'':'background:rgba(0,0,0,0.02);');
    html += '<tr style="'+bg+'border-bottom:1px solid var(--border);'+(isAnchor?'border-left:3px solid var(--navy);':'border-left:3px solid transparent;')+'">';
    cols.forEach(function(c) {
      var v = m[c.key];
      var fmtd = c.fmt ? c.fmt(v, m) : (v!=null?String(v):'—');
      var col = '';
      if (c.higher!==undefined && typeof v==='number') {
        var rk = colRanks[c.key]||{};
        if (v===rk.best) col='color:'+C.success+';';
        else if (v===rk.worst) col='color:'+C.danger+';';
      }
      var align = c.key==='name'?'left':'right';
      var mono = c.key!=='name'?'font-family:monospace;':'';
      html += '<td style="padding:7px 12px;text-align:'+align+';'+col+mono+'">'+fmtd+'</td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  html += '<div style="font-size:10.5px;color:var(--text-sec);margin-top:8px;padding:0 4px;">Green = best in group · Red = worst. Anchor ticker highlighted in blue. Primary source: SEC EDGAR audited 10-K data + Yahoo Finance prices; any gap is automatically backfilled from the FMP batch endpoint (<code>/peer-financials</code>) so every peer row populates. Valuation multiples use last-annual fundamentals vs. current price.</div>';
  resultEl.innerHTML = html;

  // ── Visual comparison charts ──
  var chartsEl = document.getElementById('resPeersCharts');
  if (chartsEl && valid.length > 1) {
    chartsEl.style.display = '';
    var tickers = valid.map(function(m){ return m.ticker; });
    var anchorColors = valid.map(function(m){ return m.ticker === anchor ? C.navy : 'rgba(91,155,213,0.7)'; });
    var anchorBorders = valid.map(function(m){ return m.ticker === anchor ? C.navy : 'rgba(91,155,213,1)'; });
    function makePeerBar(canvasId, values, label, fmtCb, colorsFn) {
      var el = document.getElementById(canvasId);
      if (!el) return;
      var prev = Chart.getChart(el);
      if (prev) prev.destroy();
      var colors = colorsFn ? colorsFn(values) : anchorColors;
      new Chart(el.getContext('2d'), {
        type: 'bar',
        data: { labels: tickers, datasets: [{ label: label, data: values, backgroundColor: colors, borderColor: anchorBorders, borderWidth: 1 }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: Object.assign({}, chartTooltip, { callbacks: { label: function(ctx){ return label + ': ' + (fmtCb ? fmtCb(ctx.parsed.y) : ctx.parsed.y); } } }) },
          scales: {
            x: { grid: { display: false }, ticks: chartTicks },
            y: { grid: chartGrid, ticks: chartTicks }
          }
        }
      });
    }
    // P/E chart
    makePeerBar('peerPEChart', valid.map(function(m){ return m.pe != null ? parseFloat(m.pe.toFixed(1)) : null; }), 'P/E',
      function(v){ return v != null ? v.toFixed(1) + 'x' : '—'; },
      function(vals) {
        var nums = vals.filter(function(v){return v!=null;}); var med = nums.length ? nums.slice().sort(function(a,b){return a-b;})[Math.floor(nums.length/2)] : null;
        return valid.map(function(m,i){ return m.ticker===anchor ? C.navy : (vals[i]!=null&&med!=null&&vals[i]>med*1.5?'rgba(178,34,34,0.65)':'rgba(91,155,213,0.65)'); });
      });
    // Revenue growth chart
    makePeerBar('peerRevGrowthChart', valid.map(function(m){
      var pd = peerData[m.ticker]; if (!pd||pd.error) return null;
      var revArr = ((pd.fund||{}).incomeStatement||{}).revenue||[];
      if (revArr.length < 2) return null;
      var r1=revArr[revArr.length-1].value, r2=revArr[revArr.length-2].value;
      return r2>0 ? parseFloat(((r1-r2)/Math.abs(r2)*100).toFixed(1)) : null;
    }), 'Rev Growth %',
      function(v){ return v!=null?(v>=0?'+':'')+v.toFixed(1)+'%':'—'; },
      function(vals){ return valid.map(function(m,i){ return m.ticker===anchor?C.navy:(vals[i]!=null&&vals[i]>=0?'rgba(46,125,82,0.65)':'rgba(178,34,34,0.65)'); }); });
    // Net margin chart
    makePeerBar('peerMarginChart', valid.map(function(m){ return m.npm != null ? parseFloat(m.npm.toFixed(1)) : null; }), 'Net Margin %',
      function(v){ return v!=null?(v>=0?'+':'')+v.toFixed(1)+'%':'—'; },
      function(vals){ return valid.map(function(m,i){ return m.ticker===anchor?C.navy:(vals[i]!=null&&vals[i]>=0?'rgba(46,125,82,0.65)':'rgba(178,34,34,0.65)'); }); });
    // 1Y return chart
    makePeerBar('peerReturnChart', valid.map(function(m){ return m.ret1y != null ? parseFloat(m.ret1y.toFixed(1)) : null; }), '1Y Return %',
      function(v){ return v!=null?(v>=0?'+':'')+v.toFixed(1)+'%':'—'; },
      function(vals){ return valid.map(function(m,i){ return m.ticker===anchor?C.navy:(vals[i]!=null&&vals[i]>=0?'rgba(46,125,82,0.65)':'rgba(178,34,34,0.65)'); }); });
  }
}

// ═══════════════════════════════════════════════════════════════════
// COMPANY MOAT ANALYSIS — AI-powered via Claude API
// ═══════════════════════════════════════════════════════════════════
async function resMoatRun() {
  var el = document.getElementById('resMoatResult');
  if (!el) return;
  var d = window._lastSecData;
  var tk = window._lastSecTicker;
  if (!d || !tk) { el.innerHTML = '<p style="color:var(--text-sec);">Load a ticker first.</p>'; return; }
  // Kick off executives fetch in parallel — we'll await it later
  var execPromise = fetch('https://perry-finance-proxy.zachperrybusiness.workers.dev/executives?symbol='+tk).then(function(r){return r.json();}).catch(function(){return null;});

  var profile = d.profile||{};
  var inc = d.incomeStatement||{};
  var bs  = d.balanceSheet||{};
  var cf  = d.cashFlowStatement||{};
  var at  = d.analystTargets||{};
  var ar  = d.analystRatings||{};

  function L(arr){return arr&&arr.length?arr[arr.length-1].value:null;}
  function L2(arr){return arr&&arr.length>=2?arr[arr.length-2].value:null;}
  function Nm(v){if(v==null)return'N/A';var a=Math.abs(v);if(a>=1e12)return'$'+(v/1e12).toFixed(2)+'T';if(a>=1e9)return'$'+(v/1e9).toFixed(2)+'B';if(a>=1e6)return'$'+(v/1e6).toFixed(1)+'M';return'$'+v.toFixed(0);}

  var rev   = L(inc.revenue), prevRev = L2(inc.revenue);
  var ni    = L(inc.netIncome), prevNI = L2(inc.netIncome);
  var gp    = L(inc.grossProfit);
  var oi    = L(inc.operatingIncome);
  var rnd   = L(inc.researchAndDev)||0;
  var ocf   = L(cf.operatingCashFlow);
  var capex = Math.abs(L(cf.capitalExpenditures)||0);
  var fcf   = ocf!=null?ocf-capex:null;
  var sbc   = L(cf.stockBasedComp)||0;
  var eq    = L(bs.stockholdersEquity);
  var ta    = L(bs.totalAssets);
  var ltd   = L(bs.longTermDebt)||0;
  var cash  = (L(bs.cash)||0)+(L(bs.shortTermInvestments)||0);
  var shares= L(bs.sharesOutstanding);
  var mktCap= profile.marketCap||(shares&&(d.price&&d.price.current)?shares*d.price.current:null);
  var px    = d.price&&d.price.current?d.price.current:null;

  var grossMargin = rev&&gp?gp/rev:null;
  var opMargin    = rev&&oi?oi/rev:null;
  var netMargin   = rev&&ni?ni/rev:null;
  var roe         = ni&&eq&&eq>0?ni/eq:null;
  var roa         = ni&&ta&&ta>0?ni/ta:null;
  var de          = ltd&&eq&&eq>0?ltd/eq:null;
  var rndPct      = rev&&rnd?rnd/rev:null;
  var revGrowth   = rev&&prevRev&&prevRev>0?(rev-prevRev)/Math.abs(prevRev):null;
  var niGrowth    = ni&&prevNI&&prevNI>0?(ni-prevNI)/Math.abs(prevNI):null;
  var fcfConv     = ni&&ni>0&&fcf!=null?fcf/ni:null;
  var sbcPct      = rev&&sbc?sbc/rev:null;
  var netCash     = cash-ltd;
  var ev          = mktCap!=null?mktCap+ltd-cash:null;

  var SECTOR_PE_MAP = {'Technology':28,'Healthcare':22,'Financials':14,'Consumer Discretionary':22,'Consumer Staples':20,'Energy':12,'Industrials':18,'Materials':16,'Real Estate':20,'Utilities':18,'Communication Services':20};
  var sectorPE = SECTOR_PE_MAP[profile.sector]||20;
  var pe = (d.incomeStatement&&d.incomeStatement.eps&&d.incomeStatement.eps.length&&px) ? px/d.incomeStatement.eps[d.incomeStatement.eps.length-1].value : null;

  var totalA = (ar.strongBuy||0)+(ar.buy||0)+(ar.hold||0)+(ar.sell||0)+(ar.strongSell||0);
  var buyPct = totalA?((ar.strongBuy||0)+(ar.buy||0))/totalA:null;
  var upside = at.mean&&px?(at.mean-px)/px:null;

  // ── Score functions ──────────────────────────────────────────────
  function scoreGauge(val, thresholds, labels, colors) {
    // thresholds: [bad_lo, ok_lo, good_lo] ascending
    var idx = 0;
    for (var i=0;i<thresholds.length;i++) if (val>=thresholds[i]) idx=i+1;
    var cols = colors||[C.danger,'#8B6914',C.navy,C.success];
    var lbls = labels||['Weak','Fair','Good','Strong'];
    return {label:lbls[Math.min(idx,lbls.length-1)], color:cols[Math.min(idx,cols.length-1)]};
  }
  function pill(label,color){return '<span style="background:'+color+';color:#fff;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;">'+label+'</span>';}
  function metric(label,val,fmt,bench,lowerBetter){
    var fmtd=val!=null?fmt(val):'N/A';
    var col=C.text;
    if(val!=null&&bench!=null) col=lowerBetter?(val<=bench?C.success:C.danger):(val>=bench?C.success:C.danger);
    return '<tr><td style="padding:5px 10px;color:var(--text-sec);font-size:11px;">'+label+'</td><td style="padding:5px 10px;font-weight:700;color:'+col+';font-family:monospace;">'+fmtd+'</td>'+(bench!=null?'<td style="padding:5px 10px;font-size:10px;color:var(--text-sec);">'+(lowerBetter?'<'+fmt(bench):'>'+fmt(bench))+'</td>':'<td></td>')+'</tr>';
  }
  function pct(v){return v!=null?(v*100).toFixed(1)+'%':'N/A';}
  function x(v){return v!=null?v.toFixed(1)+'x':'N/A';}
  function dp(v){return v!=null?v.toFixed(2):'N/A';}

  // ── Section builder ──────────────────────────────────────────────
  function section(title, icon, body) {
    return '<div class="card" style="margin-bottom:14px;">'
      +'<div class="card-title">'+icon+' '+title+'</div>'
      +'<div class="card-body">'+body+'</div></div>';
  }

  var html = '';

  // ── 1. Business Model Overview ────────────────────────────────
  var moatScore = null;
  var moatLabel = '—'; var moatColor = C.textSec;
  // Estimate moat via proxy signals
  var moatPoints = 0;
  if (grossMargin!=null&&grossMargin>0.40) moatPoints++;
  if (opMargin!=null&&opMargin>0.15) moatPoints++;
  if (roe!=null&&roe>0.20) moatPoints++;
  if (rndPct!=null&&rndPct>0.08) moatPoints++;
  if (revGrowth!=null&&revGrowth>0.10) moatPoints++;
  if (fcfConv!=null&&fcfConv>0.80) moatPoints++;
  if (moatPoints>=5){moatLabel='Wide Moat';moatColor=C.success;}
  else if(moatPoints>=3){moatLabel='Narrow Moat';moatColor=C.navy;}
  else{moatLabel='No Clear Moat';moatColor=C.danger;}

  var bizBody = '<div style="display:flex;align-items:center;gap:16px;margin-bottom:14px;">';
  bizBody += '<div style="background:var(--panel);border:1px solid var(--border);border-left:4px solid '+moatColor+';border-radius:4px;padding:12px 18px;min-width:160px;">';
  bizBody += '<div style="font-size:10px;color:var(--text-sec);text-transform:uppercase;letter-spacing:.6px;">Moat Estimate</div>';
  bizBody += '<div style="font-size:20px;font-weight:800;color:'+moatColor+';">'+moatLabel+'</div>';
  bizBody += '<div style="font-size:10px;color:var(--text-sec);margin-top:3px;">Based on '+moatPoints+'/6 proxy signals</div></div>';
  if (profile.description) {
    bizBody += '<div style="font-size:12px;color:var(--text-sec);line-height:1.65;flex:1;">'+profile.description.substring(0,500)+(profile.description.length>500?'…':'')+'</div>';
  }
  bizBody += '</div>';
  bizBody += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">';
  [{label:'Sector',val:profile.sector||'—'},{label:'Industry',val:profile.industry||'—'},
   {label:'Employees',val:profile.employees?Number(profile.employees).toLocaleString():'—'},
   {label:'HQ',val:profile.city?(profile.city+(profile.state?', '+profile.state:'')):'—'},
   {label:'CEO',val:profile.ceo||'—'},{label:'Website',val:profile.website?'<a href="'+profile.website+'" target="_blank" style="color:var(--navy);">'+profile.website.replace(/^https?:\/\//,'').substring(0,30)+'</a>':'—'}
  ].forEach(function(item){
    bizBody += '<div style="background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:8px 12px;">'
      +'<div style="font-size:10px;color:var(--text-sec);text-transform:uppercase;letter-spacing:.5px;">'+item.label+'</div>'
      +'<div style="font-size:12px;font-weight:600;margin-top:2px;">'+item.val+'</div></div>';
  });
  bizBody += '</div>';
  html += section('Business Model & Company Overview','🏢', bizBody);

  // ── 1b. Leadership ──────────────────────────────────────────────
  var execData = await execPromise;
  var execBody = '';
  var execs = Array.isArray(execData) ? execData : (execData && Array.isArray(execData.executives) ? execData.executives : null);
  if (execs && execs.length) {
    execBody += '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;">';
    execBody += '<thead><tr style="background:var(--panel);"><th style="padding:6px 12px;text-align:left;">Name</th><th style="padding:6px 12px;text-align:left;">Title</th><th style="padding:6px 12px;text-align:right;">Year Joined</th><th style="padding:6px 12px;text-align:right;">Compensation</th></tr></thead><tbody>';
    execs.slice(0, 8).forEach(function(e, i) {
      var bg = i % 2 === 0 ? '' : 'background:rgba(0,0,0,0.02);';
      var comp = e.pay != null ? '$' + Number(e.pay).toLocaleString() : (e.totalPay != null ? '$' + Number(e.totalPay).toLocaleString() : '—');
      var yr = e.yearBorn ? '' : (e.since || '—');
      execBody += '<tr style="border-bottom:1px solid var(--border);' + bg + '">'
        + '<td style="padding:6px 12px;font-weight:700;">' + (e.name || '—') + '</td>'
        + '<td style="padding:6px 12px;color:var(--text-sec);">' + (e.title || e.titleSince || '—') + '</td>'
        + '<td style="padding:6px 12px;text-align:right;font-family:monospace;">' + yr + '</td>'
        + '<td style="padding:6px 12px;text-align:right;font-family:monospace;">' + comp + '</td>'
        + '</tr>';
    });
    execBody += '</tbody></table></div>';
    execBody += '<div style="font-size:10.5px;color:var(--text-sec);margin-top:6px;">Source: Financial Modeling Prep key-executives endpoint.</div>';
  } else {
    execBody = '<div style="display:flex;gap:12px;flex-wrap:wrap;">';
    if (profile.ceo) execBody += '<div style="background:var(--panel);border:1px solid var(--border);border-left:4px solid var(--navy);border-radius:4px;padding:10px 14px;min-width:160px;"><div style="font-size:10px;color:var(--text-sec);text-transform:uppercase;">CEO</div><div style="font-weight:700;font-size:13px;">' + profile.ceo + '</div></div>';
    execBody += '<div style="font-size:12px;color:var(--text-sec);padding:10px;">Full leadership table unavailable — worker endpoint may not be deployed yet.</div></div>';
  }
  var _secLeadership = section('Leadership Team', '👔', execBody);  // deferred — appended after the decision sections (reordered 2026-07)

  // ── 2. Revenue Quality & Profitability ───────────────────────
  var profBody = '<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:var(--panel);"><th style="padding:5px 10px;text-align:left;">Metric</th><th style="padding:5px 10px;text-align:left;">Value</th><th style="padding:5px 10px;text-align:left;">Signal</th></tr></thead><tbody>';
  profBody += metric('Revenue (LTM)', rev, Nm, null, false);
  profBody += metric('Revenue Growth YoY', revGrowth, pct, 0.08, false);
  profBody += metric('Gross Margin', grossMargin, pct, 0.35, false);
  profBody += metric('Operating Margin', opMargin, pct, 0.15, false);
  profBody += metric('Net Margin', netMargin, pct, 0.10, false);
  profBody += metric('FCF Conversion (FCF/NI)', fcfConv, x, 0.80, false);
  profBody += metric('R&D as % of Revenue', rndPct, pct, null, false);
  profBody += metric('Stock-Based Comp %', sbcPct, pct, 0.05, true);
  profBody += '</tbody></table>';
  profBody += '<div style="font-size:11px;color:var(--text-sec);margin-top:8px;">FCF Conversion >0.8x = high-quality earnings. SBC >5% = dilution risk. R&D intensity signals innovation investment.</div>';
  var _secRevQuality = section('Revenue Quality & Profitability Signals','📈', profBody);  // deferred

  // ── 3. Competitive Moat Signals ─────────────────────────────
  var moatSignals = [
    {name:'Gross Margin >40%',     pass:grossMargin!=null&&grossMargin>0.40,   val:grossMargin!=null?pct(grossMargin):'N/A', note:'High gross margin = pricing power / intangible asset moat'},
    {name:'Operating Margin >15%', pass:opMargin!=null&&opMargin>0.15,          val:opMargin!=null?pct(opMargin):'N/A',       note:'Sustained op margin = cost advantage or scale'},
    {name:'ROE >20%',              pass:roe!=null&&roe>0.20,                    val:roe!=null?pct(roe):'N/A',                 note:'High ROE = efficient capital deployment / moat returns'},
    {name:'R&D >8% of Rev',        pass:rndPct!=null&&rndPct>0.08,             val:rndPct!=null?pct(rndPct):'None',          note:'R&D intensity = innovation moat (tech/pharma)'},
    {name:'Revenue CAGR >10%',     pass:revGrowth!=null&&revGrowth>0.10,        val:revGrowth!=null?pct(revGrowth):'N/A',    note:'Consistent growth = demand/network moat'},
    {name:'FCF Conversion >80%',   pass:fcfConv!=null&&fcfConv>0.80,           val:fcfConv!=null?x(fcfConv):'N/A',          note:'High FCF conversion = real cash earnings quality'},
  ];
  var moatBody = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">';
  moatSignals.forEach(function(s){
    moatBody += '<div style="background:var(--panel);border:1px solid var(--border);border-left:4px solid '+(s.pass?C.success:C.danger)+';border-radius:4px;padding:8px 12px;">'
      +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">'
      +'<span style="font-size:11px;font-weight:600;">'+s.name+'</span>'
      +pill(s.pass?'✓ Pass':'✗ Fail', s.pass?C.success:C.danger)
      +'</div>'
      +'<div style="font-size:17px;font-weight:800;font-family:monospace;color:'+(s.pass?C.success:C.danger)+';">'+s.val+'</div>'
      +'<div style="font-size:10.5px;color:var(--text-sec);margin-top:2px;">'+s.note+'</div>'
      +'</div>';
  });
  moatBody += '</div>';
  moatBody += '<div style="background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:10px 14px;font-size:12px;">'
    +'<strong>Moat Assessment:</strong> '+moatPoints+'/6 signals passing → '+pill(moatLabel,moatColor)
    +'<span style="color:var(--text-sec);margin-left:8px;font-size:11px;">Wide Moat = 5-6 · Narrow = 3-4 · No Moat = 0-2</span></div>';
  html += section('Competitive Moat Signals','🏰', moatBody);

  // ── 4. Balance Sheet & Leverage ──────────────────────────────
  var levBody = '<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:var(--panel);"><th style="padding:5px 10px;text-align:left;">Metric</th><th style="padding:5px 10px;text-align:left;">Value</th><th style="padding:5px 10px;text-align:left;">Signal</th></tr></thead><tbody>';
  levBody += metric('Net Cash (Cash − Debt)', netCash, Nm, 0, false);
  levBody += metric('Debt/Equity', de, x, 1.5, true);
  levBody += metric('Total Long-Term Debt', ltd, Nm, null, false);
  levBody += metric('Total Cash + Short-Term Inv.', cash, Nm, null, false);
  levBody += metric('Return on Assets (ROA)', roa, pct, 0.05, false);
  levBody += metric('Return on Equity (ROE)', roe, pct, 0.15, false);
  var caL = L(bs.currentAssets), clL = L(bs.currentLiabilities);
  var currRatio = caL&&clL&&clL>0?caL/clL:null;
  levBody += metric('Current Ratio', currRatio, x, 1.5, false);
  levBody += '</tbody></table>';
  var levSignal = de!=null ? (de<0.5?'Under-leveraged (balance sheet room to deploy capital)':de<1.5?'Moderate leverage (sector-appropriate)':de<3.0?'Elevated leverage (monitor debt service)':'Over-leveraged (stress risk)') : 'Leverage N/A';
  var levCol = de!=null ? (de<1.5?C.success:de<3.0?'#8B6914':C.danger) : C.textSec;
  levBody += '<div style="margin-top:10px;background:var(--panel);border:1px solid var(--border);border-left:4px solid '+levCol+';border-radius:4px;padding:8px 12px;font-size:12px;">'
    +'<strong>Leverage Assessment:</strong> D/E = '+(de!=null?de.toFixed(2)+'x':'N/A')+' → <span style="color:'+levCol+';font-weight:700;">'+levSignal+'</span></div>';
  var _secBalance = section('Balance Sheet & Leverage','💰', levBody);  // deferred

  // ── 5. Analyst Consensus & Market Positioning ────────────────
  var analBody = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:12px;">';
  function aMetricBox(lbl,val,sub,col){return '<div style="background:var(--panel);border:1px solid var(--border);border-left:4px solid '+(col||C.navy)+';border-radius:4px;padding:10px 12px;"><div style="font-size:10px;color:var(--text-sec);">'+lbl+'</div><div style="font-size:18px;font-weight:800;color:'+(col||C.navy)+';">'+val+'</div>'+(sub?'<div style="font-size:10px;color:var(--text-sec);">'+sub+'</div>':'')+'</div>';}
  analBody += aMetricBox('Price Target (Mean)', at.mean?'$'+at.mean.toFixed(2):'N/A', upside!=null?(upside>=0?'+':'')+pct(upside)+' upside':'', upside!=null&&upside>0?C.success:C.danger);
  analBody += aMetricBox('Target High', at.high?'$'+at.high.toFixed(2):'N/A', 'Bull case', C.success);
  analBody += aMetricBox('Target Low', at.low?'$'+at.low.toFixed(2):'N/A', 'Bear case', C.danger);
  analBody += aMetricBox('Buy Ratings', totalA?((ar.strongBuy||0)+(ar.buy||0))+'/'+totalA:'N/A', buyPct!=null?pct(buyPct)+' of analysts':'', buyPct!=null&&buyPct>0.6?C.success:C.danger);
  analBody += aMetricBox('P/E vs. Sector', pe?pe.toFixed(1)+'x':'N/A', 'Sector: '+sectorPE+'x', pe!=null?(pe<sectorPE?C.success:pe<sectorPE*1.5?'#8B6914':C.danger):C.textSec);
  analBody += aMetricBox('Market Cap', mktCap?Nm(mktCap):'N/A', ev?'EV: '+Nm(ev):'', C.navy);
  analBody += '</div>';
  html += section('Analyst Consensus & Valuation Context','📊', analBody);

  // ── 6. Where Could This Stock Go? ───────────────────────────────
  if (px && (at.low || at.mean || at.high)) {
    var rangeMin = Math.min(px, at.low||px) * 0.92;
    var rangeMax = Math.max(px, at.high||px) * 1.05;
    var span = rangeMax - rangeMin || 1;
    function barPct(v) { return v != null ? Math.max(0, Math.min(100, (v - rangeMin) / span * 100)).toFixed(1) : null; }
    var pxPct = barPct(px), lowPct = barPct(at.low), meanPct = barPct(at.mean), highPct = barPct(at.high);
    var targetBody = '<div style="font-size:12px;color:var(--text-sec);margin-bottom:14px;">Three independent estimates of where <strong>' + tk + '</strong> could trade. When all three agree on direction, conviction is high.</div>';
    targetBody += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:20px;">';
    if (at.low != null) targetBody += '<div style="background:rgba(178,34,34,0.07);border:1px solid rgba(178,34,34,0.25);border-left:4px solid var(--danger);border-radius:4px;padding:12px 14px;"><div style="font-size:10px;color:var(--text-sec);text-transform:uppercase;letter-spacing:.5px;">Bear Case (Analyst Low)</div><div style="font-size:22px;font-weight:800;color:var(--danger);">$' + at.low.toFixed(2) + '</div><div style="font-size:11px;color:var(--text-sec);">' + ((at.low/px-1)*100>=0?'+':'') + ((at.low/px-1)*100).toFixed(1) + '% vs current</div></div>';
    if (at.mean != null) targetBody += '<div style="background:rgba(0,60,113,0.07);border:1px solid rgba(0,60,113,0.25);border-left:4px solid var(--navy);border-radius:4px;padding:12px 14px;"><div style="font-size:10px;color:var(--text-sec);text-transform:uppercase;letter-spacing:.5px;">Base Case (Analyst Mean)</div><div style="font-size:22px;font-weight:800;color:var(--navy);">$' + at.mean.toFixed(2) + '</div><div style="font-size:11px;color:var(--text-sec);">' + ((at.mean/px-1)*100>=0?'+':'') + ((at.mean/px-1)*100).toFixed(1) + '% vs current</div></div>';
    if (at.high != null) targetBody += '<div style="background:rgba(46,125,82,0.07);border:1px solid rgba(46,125,82,0.25);border-left:4px solid var(--success);border-radius:4px;padding:12px 14px;"><div style="font-size:10px;color:var(--text-sec);text-transform:uppercase;letter-spacing:.5px;">Bull Case (Analyst High)</div><div style="font-size:22px;font-weight:800;color:var(--success);">$' + at.high.toFixed(2) + '</div><div style="font-size:11px;color:var(--text-sec);">' + ((at.high/px-1)*100>=0?'+':'') + ((at.high/px-1)*100).toFixed(1) + '% vs current</div></div>';
    targetBody += '</div>';
    // Visual range bar
    targetBody += '<div style="position:relative;height:36px;background:linear-gradient(90deg,rgba(178,34,34,0.15),rgba(0,60,113,0.1),rgba(46,125,82,0.15));border-radius:6px;margin:0 8px 6px;">';
    if (lowPct != null)  targetBody += '<div style="position:absolute;left:' + lowPct + '%;top:4px;bottom:4px;width:3px;background:var(--danger);border-radius:2px;" title="Low: $' + at.low.toFixed(2) + '"></div><div style="position:absolute;left:calc(' + lowPct + '% + 5px);top:50%;transform:translateY(-50%);font-size:9px;color:var(--danger);font-weight:700;">Low</div>';
    if (meanPct != null) targetBody += '<div style="position:absolute;left:' + meanPct + '%;top:2px;bottom:2px;width:3px;background:var(--navy);border-radius:2px;" title="Mean: $' + at.mean.toFixed(2) + '"></div><div style="position:absolute;left:calc(' + meanPct + '% + 5px);top:50%;transform:translateY(-50%);font-size:9px;color:var(--navy);font-weight:700;">Mean</div>';
    if (highPct != null) targetBody += '<div style="position:absolute;left:' + highPct + '%;top:4px;bottom:4px;width:3px;background:var(--success);border-radius:2px;" title="High: $' + at.high.toFixed(2) + '"></div>';
    if (pxPct != null)   targetBody += '<div style="position:absolute;left:' + pxPct + '%;top:0;bottom:0;width:3px;background:#F18F01;border-radius:2px;" title="Current: $' + px.toFixed(2) + '"></div><div style="position:absolute;left:calc(' + pxPct + '% + 5px);top:50%;transform:translateY(-50%);font-size:9px;color:#F18F01;font-weight:700;">Now</div>';
    targetBody += '</div>';
    targetBody += '<div style="font-size:10px;color:var(--text-sec);margin-top:4px;padding:0 8px;">Bar spans analyst low to 5% above high. Orange = current price · Red = bear target · Blue = mean target · Green = bull target.</div>';
    html += section('Where Could This Stock Go?', '🎯', targetBody);
  }

  // Reordered 2026-07 per review: decision sections first (Overview → Moat
  // Signals → Analyst Consensus → Where Could This Go), supporting detail after.
  html += _secRevQuality + _secBalance + _secLeadership;

  // ── 7. Macro Sensitivity ────────────────────────────────────────
  var MACRO_IMPACT = {
    'Technology':              [{e:'Rate hike (+50bps)',impact:'Negative',why:'Higher discount rate compresses DCF valuations on growth stocks'},{e:'Strong GDP growth',impact:'Positive',why:'Enterprise IT budgets expand; cloud adoption accelerates'},{e:'Dollar strengthens',impact:'Mixed',why:'Overseas revenue shrinks when translated; domestic unaffected'},{e:'Inflation spike',impact:'Negative',why:'Labor/compute costs rise; consumer discretionary tech spend cut'},{e:'Recession',impact:'Mixed',why:'Ad spend cut fast; SaaS/cloud stickier; enterprise deals delayed'}],
    'Financials':              [{e:'Rate hike (+50bps)',impact:'Positive',why:'Net interest margin expands — banks earn more on loans vs deposits'},{e:'Strong GDP growth',impact:'Positive',why:'Loan demand rises; fewer defaults; capital markets activity up'},{e:'Recession',impact:'Negative',why:'Loan losses spike; credit card delinquency rises; deal flow dries up'},{e:'Inflation spike',impact:'Mixed',why:'Short-term NIM boost; long-term credit quality risk if rates overshoot'},{e:'Dollar strengthens',impact:'Mixed',why:'Foreign earnings shrink; domestic loan book unaffected'}],
    'Healthcare':              [{e:'Rate hike (+50bps)',impact:'Low',why:'Defensive sector — demand for drugs/devices inelastic to rates'},{e:'Recession',impact:'Low',why:'Healthcare spending highly inelastic; people still need treatment'},{e:'Regulation tightening',impact:'Negative',why:'Drug pricing legislation can compress pharma margins significantly'},{e:'Aging demographics',impact:'Positive',why:'Long-run tailwind — aging population increases demand across sector'},{e:'Strong GDP growth',impact:'Positive',why:'Elective procedures increase; medical device volumes rise'}],
    'Energy':                  [{e:'Oil price spike (+$20)',impact:'Positive',why:'Revenue and margins expand directly with commodity price'},{e:'Oil price drop (-$20)',impact:'Negative',why:'Revenue and margins compress; E&P capex cuts follow'},{e:'Recession',impact:'Negative',why:'Industrial demand drops; energy prices and volumes fall together'},{e:'Energy transition policy',impact:'Mixed',why:'Renewable mandates hurt fossil fuel producers; utilities benefit'},{e:'Dollar strengthens',impact:'Negative',why:'Oil is priced in USD — strong dollar suppresses oil prices globally'}],
    'Consumer Discretionary':  [{e:'Rate hike (+50bps)',impact:'Negative',why:'Higher mortgage/credit costs reduce consumer spending power'},{e:'Strong GDP growth',impact:'Positive',why:'Employment and wages rise; discretionary spend increases'},{e:'Recession',impact:'Negative',why:'First category cut in household budget — demand falls sharply'},{e:'Inflation spike',impact:'Negative',why:'Real purchasing power drops; trade-down to staples accelerates'},{e:'Dollar strengthens',impact:'Mixed',why:'Import costs fall; export competitiveness of US brands weakens'}],
    'Consumer Staples':        [{e:'Rate hike (+50bps)',impact:'Low',why:'Demand inelastic — people still buy food/hygiene regardless'},{e:'Recession',impact:'Positive',why:'Trade-up from discretionary; safety/defensive allocation increases'},{e:'Inflation spike',impact:'Mixed',why:'Can pass through input cost inflation; private label competition rises'},{e:'Strong GDP growth',impact:'Low',why:'Stable demand — limited upside from economic expansion'},{e:'Dollar strengthens',impact:'Negative',why:'Major multinationals earn significant overseas revenue'}],
    'Industrials':             [{e:'Rate hike (+50bps)',impact:'Mixed',why:'Higher borrowing costs slow capex; infrastructure investment continues'},{e:'Strong GDP growth',impact:'Positive',why:'Manufacturing output and freight volumes rise with economic activity'},{e:'Recession',impact:'Negative',why:'Factory orders drop; transportation volumes fall; layoffs follow'},{e:'Infrastructure spending',impact:'Positive',why:'Government capex directly boosts construction and machinery demand'},{e:'Dollar strengthens',impact:'Negative',why:'US exports become less competitive internationally'}],
    'default':                 [{e:'Rate hike (+50bps)',impact:'Mixed',why:'Impact depends on leverage and growth vs. value characteristics'},{e:'Strong GDP growth',impact:'Positive',why:'Broad economic expansion typically lifts most sectors'},{e:'Recession',impact:'Negative',why:'Revenue and earnings pressure across most industries'},{e:'Inflation spike',impact:'Mixed',why:'Input cost pressure; ability to pass through varies by sector'},{e:'Dollar strengthens',impact:'Mixed',why:'Depends on international revenue exposure'}]
  };
  var macroRows = MACRO_IMPACT[profile.sector] || MACRO_IMPACT['default'];
  var macroBody = '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;">';
  macroBody += '<thead><tr style="background:var(--panel);"><th style="padding:6px 12px;text-align:left;">Macro Event</th><th style="padding:6px 12px;text-align:center;">Likely Impact</th><th style="padding:6px 12px;text-align:left;">Why</th></tr></thead><tbody>';
  macroRows.forEach(function(row, i) {
    var bg = i % 2 === 0 ? '' : 'background:rgba(0,0,0,0.02);';
    var impColor = row.impact === 'Positive' ? C.success : row.impact === 'Negative' ? C.danger : '#8B6914';
    macroBody += '<tr style="border-bottom:1px solid var(--border);' + bg + '">'
      + '<td style="padding:7px 12px;font-weight:600;">' + row.e + '</td>'
      + '<td style="padding:7px 12px;text-align:center;"><span style="background:' + impColor + ';color:#fff;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;">' + row.impact + '</span></td>'
      + '<td style="padding:7px 12px;color:var(--text-sec);">' + row.why + '</td>'
      + '</tr>';
  });
  macroBody += '</tbody></table></div>';
  macroBody += '<div style="font-size:10.5px;color:var(--text-sec);margin-top:6px;">Based on sector classification: <strong>' + (profile.sector||'Unknown') + '</strong>. These are general historical tendencies, not guarantees.</div>';
  html += section('Macro Sensitivity — How Macro Events Affect This Company', '🌐', macroBody);

  el.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════
// INSIDER ACTIONS — SEC EDGAR Form 4 scraper
// ═══════════════════════════════════════════════════════════════════
async function resInsiderLoad(ticker) {
  var summaryEl = document.getElementById('resInsiderSummary');
  var tableEl   = document.getElementById('resInsiderTable');
  if (!summaryEl || !tableEl) return;
  summaryEl.innerHTML = '<span class="spinner"></span> Fetching insider transactions from SEC EDGAR via Cloudflare Worker...';
  tableEl.innerHTML = '';
  try {
    var WORKER = 'https://perry-finance-proxy.zachperrybusiness.workers.dev';
    var cik = window._lastSecData && window._lastSecData.profile && window._lastSecData.profile.cik
              ? window._lastSecData.profile.cik : null;
    var url = WORKER + '/insider?symbol=' + encodeURIComponent(ticker);
    if (cik) url += '&cik=' + encodeURIComponent(cik);
    var res = await fetch(url);
    var data = await res.json();
    if (data.error) throw new Error(data.error);

    var s = data.summary || {};
    var transactions = data.transactions || [];
    var netCol = s.netSentiment==='Net Buying'?C.success:s.netSentiment==='Net Selling'?C.danger:'#8B6914';

    // ── Summary header ──
    var sHtml = '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;">';
    function sBubble(lbl,val,sub,col){return '<div style="background:var(--panel);border:1px solid var(--border);border-left:4px solid '+(col||C.navy)+';border-radius:4px;padding:10px 14px;min-width:120px;">'
      +'<div style="font-size:10px;color:var(--text-sec);text-transform:uppercase;letter-spacing:.5px;">'+lbl+'</div>'
      +'<div style="font-size:20px;font-weight:800;color:'+(col||C.navy)+';">'+val+'</div>'
      +(sub?'<div style="font-size:10px;color:var(--text-sec);">'+sub+'</div>':'')+'</div>';}
    sHtml += sBubble('Net Sentiment', s.netSentiment||'N/A', 'Last 24 months', netCol);
    sHtml += sBubble('Open Mkt Buys', s.openMarketBuys||0, 'Form 4 Code P', C.success);
    sHtml += sBubble('Open Mkt Sells', s.openMarketSells||0, 'Form 4 Code S', C.danger);
    sHtml += sBubble('Awards/Grants', s.awards||0, 'Codes A/M', '#8B6914');
    sHtml += sBubble('Form 4 Filings', data.totalForm4s||0, '24 months', C.navy);
    sHtml += '</div>';
    sHtml += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px;">';
    if(s.totalBuyValue) sHtml += sBubble('Total Buy Value', ('$'+(s.totalBuyValue/1e6>1?(s.totalBuyValue/1e6).toFixed(1)+'M':(s.totalBuyValue/1e3).toFixed(0)+'K')), 'Open market purchases', C.success);
    if(s.totalSellValue) sHtml += sBubble('Total Sell Value', ('$'+(s.totalSellValue/1e6>1?(s.totalSellValue/1e6).toFixed(1)+'M':(s.totalSellValue/1e3).toFixed(0)+'K')), 'Open market sales', C.danger);
    sHtml += '<div style="flex:1;background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:8px 12px;">'
      +'<div style="font-size:10px;color:var(--text-sec);">Company · CIK</div>'
      +'<div style="font-size:12px;font-weight:700;">'+(data.companyName||ticker)+' &nbsp; <span style="font-weight:400;color:var(--text-sec);">CIK: '+data.cik+'</span></div>'
      +'<a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK='+data.cik+'&type=4&dateb=&owner=include&count=40" target="_blank" style="font-size:11px;color:var(--navy);">View All Form 4s on EDGAR →</a>'
      +'</div>';
    sHtml += '</div>';
    sHtml += '<div style="font-size:11px;color:var(--text-sec);padding:8px 12px;background:var(--panel);border-radius:4px;margin-bottom:2px;">'
      +'Form 4 = Statement of Changes in Beneficial Ownership. Filed by officers, directors, &gt;10% shareholders within 2 business days of any transaction. '
      +'<strong>Transaction codes:</strong> P = Open Market Purchase (most bullish) · S = Open Market Sale · A = Award/Grant · M = Exercise · D = Disposition to company.</div>';
    // 6-month bar chart section
    sHtml += '<div style="margin-top:16px;"><div style="background:var(--navy);color:#fff;padding:6px 12px;font-size:12px;font-weight:700;border-radius:4px 4px 0 0;">Monthly Insider Activity — Last 6 Months (Open Market Only)</div>'
      + '<div style="height:220px;border:1px solid var(--border);border-top:none;border-radius:0 0 4px 4px;padding:10px;"><canvas id="resInsiderBarChart"></canvas></div></div>';
    summaryEl.innerHTML = sHtml;

    // ── 6-month bar chart ──
    (function renderInsiderBarChart() {
      var ctx = document.getElementById('resInsiderBarChart');
      if (!ctx) return;
      var now = new Date();
      var months = [];
      for (var m = 5; m >= 0; m--) {
        var d = new Date(now.getFullYear(), now.getMonth() - m, 1);
        months.push({ key: d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0'), label: d.toLocaleString('en-US',{month:'short', year:'2-digit'}) });
      }
      var buyMap = {}, sellMap = {}, buyDetails = {}, sellDetails = {};
      months.forEach(function(m){ buyMap[m.key]=0; sellMap[m.key]=0; buyDetails[m.key]=[]; sellDetails[m.key]=[]; });
      transactions.forEach(function(tx) {
        if (!tx.reportDate) return;
        var mk = tx.reportDate.slice(0,7);
        if (!(mk in buyMap)) return;
        var shares = Math.abs(tx.shares||0);
        var name = (tx.filerName||'Unknown').split(' ').slice(0,2).join(' ');
        var role = tx.role ? tx.role.replace(/Chief|Officer|Executive/g,'').trim() : '';
        var detail = name + (role?' ('+role+')':'') + ': ' + Number(shares).toLocaleString() + ' shares';
        if (tx.txType === 'P') { buyMap[mk] += shares; buyDetails[mk].push(detail); }
        else if (tx.txType === 'S') { sellMap[mk] += shares; sellDetails[mk].push(detail); }
      });
      var labels = months.map(function(m){ return m.label; });
      var buyData = months.map(function(m){ return buyMap[m.key]; });
      var sellData = months.map(function(m){ return -(sellMap[m.key]); });
      if (window._resInsiderBarChartObj) window._resInsiderBarChartObj.destroy();
      window._resInsiderBarChartObj = new Chart(ctx, {
        type: 'bar',
        data: { labels: labels,
          datasets: [
            { label: 'Open Mkt Purchases', data: buyData, backgroundColor: 'rgba(46,125,82,0.75)', borderWidth: 0 },
            { label: 'Open Mkt Sales', data: sellData, backgroundColor: 'rgba(178,34,34,0.72)', borderWidth: 0 }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          plugins: {
            legend: { position: 'top', labels: { font: { size: 11 }, color: '#1A2733', boxWidth: 12, padding: 12 } },
            tooltip: Object.assign({}, chartTooltip, { callbacks: {
              title: function(items) { return items[0] ? months[items[0].dataIndex].label : ''; },
              label: function(ctx) {
                var mk = months[ctx.dataIndex].key;
                var isBuy = ctx.dataset.label.includes('Purchase');
                var details = isBuy ? buyDetails[mk] : sellDetails[mk];
                var shares = Math.abs(ctx.parsed.y);
                var lines = [ctx.dataset.label + ': ' + Number(shares).toLocaleString() + ' shares'];
                details.forEach(function(d){ lines.push('  ' + d); });
                return lines;
              }
            }})
          },
          scales: {
            x: { stacked: true, grid: { display: false }, ticks: Object.assign({}, chartTicks) },
            y: { stacked: true, grid: chartGrid,
              ticks: Object.assign({}, chartTicks, { callback: function(v){ return v < 0 ? '-' + Number(-v).toLocaleString() : Number(v).toLocaleString(); } }),
              title: { display: true, text: 'Shares (+ Buys / − Sells)', font: { size: 11 }, color: C.textSec }
            }
          }
        }
      });
    })();

    // ── Transaction table ──
    if (!transactions.length) {
      tableEl.innerHTML = '<p style="padding:16px;color:var(--text-sec);">No parsed transactions found in the last 24 months. <a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK='+data.cik+'&type=4&dateb=&owner=include&count=40" target="_blank" style="color:var(--navy);">View on SEC EDGAR</a>.</p>';
      return;
    }

    var TX_LABELS = {
      'P':'Open Mkt Purchase','S':'Open Mkt Sale','A':'Award/Grant',
      'M':'Option Exercise','D':'Disposition','F':'Tax Withholding',
      'G':'Gift','J':'Other','C':'Conversion','W':'Inheritance','X':'Option Expire'
    };

    var tHtml = '<div style="overflow-x:auto;"><table style="width:100%;font-size:11.5px;border-collapse:collapse;white-space:nowrap;">';
    tHtml += '<thead><tr style="background:var(--navy);color:#fff;">';
    ['Tx Date','Insider Name','Role','Action','Acq / Disp','Shares Transacted','Shares Before','Shares After','Price / Share','Est. Value','Filing'].forEach(function(h){
      tHtml += '<th style="padding:7px 10px;text-align:left;font-size:11px;">'+h+'</th>';
    });
    tHtml += '</tr></thead><tbody>';
    transactions.forEach(function(tx, i) {
      var isBuy  = tx.txType==='P';
      var isSell = tx.txType==='S';
      var isOpen = isBuy||isSell;
      var acqDisp = tx.acquiredDisposed==='A'||isBuy;
      var codeCol = isBuy?C.success:isSell?C.danger:'#8B6914';
      var bg = i%2===0?'':'background:rgba(0,0,0,0.02);';
      var borderLeft = isOpen?'border-left:3px solid '+codeCol+';':'border-left:3px solid transparent;';
      var actionLabel = TX_LABELS[tx.txType]||tx.txType||'—';
      var adLabel = acqDisp?'▲ Acquired':'▼ Disposed';
      var adCol   = acqDisp?C.success:C.danger;
      function fs(v){return v!=null&&!isNaN(v)?Number(v).toLocaleString(undefined,{maximumFractionDigits:0}):'—';}
      function fm(v){if(v==null||isNaN(v))return'—';if(v>=1e6)return'$'+(v/1e6).toFixed(2)+'M';if(v>=1e3)return'$'+(v/1e3).toFixed(1)+'K';return'$'+v.toFixed(2);}
      tHtml += '<tr style="'+bg+borderLeft+'border-bottom:1px solid var(--border);">';
      tHtml += '<td style="padding:6px 10px;font-family:monospace;font-size:11px;">'+(tx.reportDate||'—')+'</td>';
      tHtml += '<td style="padding:6px 10px;font-weight:700;">'+(tx.filerName||'—')+'</td>';
      tHtml += '<td style="padding:6px 10px;color:var(--text-sec);font-size:10px;">'+(tx.role||'—')+'</td>';
      tHtml += '<td style="padding:6px 10px;font-weight:600;color:'+codeCol+';">'+actionLabel+'</td>';
      tHtml += '<td style="padding:6px 10px;font-weight:600;color:'+adCol+';">'+adLabel+'</td>';
      tHtml += '<td style="padding:6px 10px;font-family:monospace;text-align:right;font-weight:700;color:'+codeCol+';">'+fs(tx.shares)+'</td>';
      tHtml += '<td style="padding:6px 10px;font-family:monospace;text-align:right;color:var(--text-sec);">'+fs(tx.sharesBefore)+'</td>';
      tHtml += '<td style="padding:6px 10px;font-family:monospace;text-align:right;color:var(--text-sec);">'+fs(tx.sharesOwnedAfter)+'</td>';
      tHtml += '<td style="padding:6px 10px;font-family:monospace;text-align:right;">'+(tx.pricePerShare!=null?'$'+tx.pricePerShare.toFixed(2):'—')+'</td>';
      tHtml += '<td style="padding:6px 10px;font-family:monospace;text-align:right;font-weight:600;color:'+(isOpen?codeCol:C.textSec)+';">'+fm(tx.value)+'</td>';
      tHtml += '<td style="padding:6px 10px;"><a href="'+tx.filingUrl+'" target="_blank" style="color:var(--navy);font-size:10px;text-decoration:none;">SEC ↗</a></td>';
      tHtml += '</tr>';
    });
    tHtml += '</tbody></table></div>';
    tHtml += '<div style="font-size:10.5px;color:var(--text-sec);padding:8px 12px;margin-top:6px;background:var(--panel);border-radius:4px;">'
      +'<strong>P</strong>=Open Mkt Purchase &nbsp;·&nbsp; <strong>S</strong>=Open Mkt Sale &nbsp;·&nbsp; <strong>A</strong>=Award/Grant &nbsp;·&nbsp; <strong>M</strong>=Option Exercise &nbsp;·&nbsp; <strong>F</strong>=Tax Withholding &nbsp;·&nbsp; <strong>D</strong>=Disposition &nbsp;·&nbsp; <strong>G</strong>=Gift &nbsp;|&nbsp; '
      +'Shares Before = Shares After ∓ Transaction Shares. Green border = open market purchase. Red border = open market sale.</div>';
    tableEl.innerHTML = tHtml;
  } catch(e) {
    summaryEl.innerHTML = '<div style="color:var(--danger);padding:12px;">Error loading insider data: '+e.message+'.<br><a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0&type=4&dateb=&owner=include&count=40&search_text=" target="_blank" style="color:var(--navy);">Search EDGAR directly →</a></div>';
    console.error('[insiderLoad]', e);
  }
}

// ═══════════════════════════════════════════════════════════════════
// PEER COMPARISON — Comprehensive pre-mapped peer groups
// ═══════════════════════════════════════════════════════════════════
var SECTOR_PEERS = {
  'Technology': {
    'Semiconductors': ['NVDA','AMD','AVGO','QCOM','TXN','MU','INTC','AMAT','LRCX','KLAC','MRVL','ON'],
    'Software—Application': ['MSFT','ADBE','CRM','INTU','WDAY','NOW','SNOW','HUBS','MNDY','ZM','DOCN'],
    'Software—Infrastructure': ['ORCL','SAP','IBM','CSCO','PANW','CRWD','FTNT','ZS','OKTA'],
    'Internet': ['GOOGL','META','SNAP','PINS','TWTR','RDDT','BMBL'],
    'Hardware': ['AAPL','DELL','HPQ','STX','WDC','NTAP'],
    'IT Services': ['ACN','CTSH','IT','EPAM','GLOB'],
    'default': ['AAPL','MSFT','NVDA','GOOGL','META','AVGO','ORCL','CRM','CSCO','IBM']
  },
  'Healthcare': {
    'Drug Manufacturers': ['LLY','PFE','MRK','AZN','BMY','ABBV','NVO','RHHBY','GSK'],
    'Biotechnology': ['AMGN','GILD','REGN','VRTX','BIIB','MRNA','ILMN','EXAS','RARE'],
    'Medical Devices': ['MDT','ABT','SYK','BSX','EW','ISRG','ZBH','BDX','HOLX'],
    'Health Care Plans': ['UNH','CVS','CI','HUM','CNC','MOH','ELV'],
    'default': ['LLY','UNH','JNJ','ABBV','MRK','PFE','TMO','ABT','AMGN','GILD']
  },
  'Financials': {
    'Banks—Diversified': ['JPM','BAC','WFC','C','USB','TFC','FITB','KEY','RF'],
    'Banks—Regional': ['SIVB','ZION','CMA','WAL','HBAN','CFG'],
    'Capital Markets': ['GS','MS','BLK','SCHW','STT','BEN','IVZ'],
    'Insurance': ['BRK-B','MET','PRU','AFL','ALL','AIG','TRV','CB'],
    'default': ['JPM','BAC','GS','MS','WFC','BLK','AXP','V','MA','SCHW']
  },
  'Consumer Discretionary': {
    'Internet Retail': ['AMZN','EBAY','ETSY','CHWY','W','OSTK'],
    'Auto Manufacturers': ['TSLA','GM','F','STLA','TM','HMC','RIVN','LCID'],
    'Restaurants': ['MCD','SBUX','CMG','YUM','DPZ','QSR','WEN'],
    'Hotels & Entertainment': ['MAR','HLT','H','IHG','WH','EXPE','BKNG'],
    'default': ['AMZN','TSLA','HD','MCD','NKE','SBUX','BKNG','CMG','GM','LVS']
  },
  'Consumer Staples': {
    'Beverages': ['KO','PEP','MNST','KDP','STZ','BUD'],
    'Packaged Foods': ['GIS','K','CPB','SJM','CAG','HRL','MKC'],
    'Household Products': ['PG','CL','CHD','EL','KMB'],
    'default': ['PG','KO','PEP','COST','WMT','PM','MO','CL','GIS','KMB']
  },
  'Energy': {
    'Oil & Gas—Integrated': ['XOM','CVX','BP','SHEL','TTE','COP'],
    'Oil & Gas—E&P': ['EOG','PXD','DVN','HES','MRO','APA','FANG'],
    'Oil & Gas—Refining': ['MPC','VLO','PSX','DK','PBF'],
    'Oil Equipment': ['SLB','HAL','BKR','NOV'],
    'Pipelines': ['ET','ENB','WMB','KMI','OKE','TRGP'],
    'default': ['XOM','CVX','COP','EOG','SLB','MPC','PSX','VLO','OXY','HES']
  },
  'Industrials': {
    'Aerospace & Defense': ['RTX','LMT','NOC','GD','BA','HII','TDG','HEI'],
    'Diversified Industrials': ['GE','HON','MMM','EMR','ETN','IR'],
    'Machinery': ['CAT','DE','PCAR','ROK','PH','CMI','DOV'],
    'Transportation': ['UNP','CSX','NSC','CP','CNI','EXPD','XPO'],
    'default': ['GE','HON','RTX','CAT','UNP','UPS','BA','LMT','DE','EMR']
  },
  'Materials': {
    'Chemicals': ['LIN','APD','DD','DOW','PPG','SHW','ECL','IFF'],
    'Mining': ['NEM','FCX','AA','X','CLF','MP','VALE','RIO'],
    'default': ['LIN','APD','SHW','FCX','NUE','NEM','AA','CF','MOS','PPG']
  },
  'Real Estate': {
    'Industrial REITs': ['PLD','REXR','EGP','FR'],
    'Data Center REITs': ['EQIX','AMT','CCI','SBAC','DLR'],
    'Residential REITs': ['AVB','EQR','MAA','UDR','CPT','NXT'],
    'Retail REITs': ['SPG','O','NNN','ROIC','KIM'],
    'default': ['AMT','PLD','CCI','EQIX','PSA','O','SPG','AVB','DLR','VICI']
  },
  'Utilities': {
    'Electric': ['NEE','SO','DUK','D','AEP','EXC','PCG','SRE','XEL'],
    'Multi-Utility': ['ED','WEC','CMS','NI','ATO'],
    'default': ['NEE','SO','DUK','D','CEG','AEP','EXC','PCG','SRE','XEL']
  },
  'Communication Services': {
    'Telecom': ['VZ','T','TMUS','CHTR','CMCSA','LBRDA'],
    'Entertainment': ['DIS','NFLX','PARA','WBD','AMCX'],
    'Social Media': ['META','SNAP','PINS','RDDT'],
    'default': ['META','GOOGL','NFLX','CMCSA','T','VZ','DIS','TMUS','SNAP','EA']
  }
};

// ─── Comprehensive known-peer overrides for major S&P 500 stocks ────────────
var KNOWN_PEERS = {
  // Mega-cap tech
  'AAPL': ['MSFT','GOOGL','META','AMZN','NVDA','DELL','HPQ','SONY'],
  'MSFT': ['AAPL','GOOGL','AMZN','ORCL','CRM','SAP','IBM','NOW'],
  'NVDA': ['AMD','INTC','AVGO','QCOM','TXN','AMAT','MU','KLAC'],
  'GOOGL': ['META','MSFT','AMZN','SNAP','PINS','TWTR','BIDU'],
  'META':  ['GOOGL','SNAP','PINS','TWTR','RDDT','BMBL','MTCH'],
  'AMZN': ['MSFT','GOOGL','BABA','JD','EBAY','WMT','COST','TGT'],
  'TSLA': ['GM','F','RIVN','LCID','NIO','LI','BYD','STLA'],
  // Finance
  'JPM':  ['BAC','WFC','C','GS','MS','USB','TFC'],
  'BRK-B':['AIG','MET','PRU','ALL','TRV','CB','AFL'],
  'V':    ['MA','AXP','DFS','PYPL','SQ','FIS','FI'],
  'MA':   ['V','AXP','DFS','PYPL','SQ','FIS','FI'],
  // Healthcare
  'LLY':  ['PFE','MRK','ABBV','BMY','AZN','NVO','RHHBY'],
  'UNH':  ['CVS','CI','HUM','CNC','MOH','ELV','ANTM'],
  // Consumer
  'WMT':  ['COST','TGT','AMZN','KR','DG','DLTR','BJ'],
  'COST': ['WMT','TGT','BJ','SFM'],
  'MCD':  ['YUM','SBUX','CMG','DPZ','QSR','JACK','WEN'],
  // Energy
  'XOM':  ['CVX','BP','SHEL','COP','TTE','OXY'],
  'CVX':  ['XOM','BP','COP','OXY','PXD','HES'],
};

function resPeerAutoDetect() {
  var d = window._lastSecData;
  if (!d) return;
  var tk = (window._lastSecTicker||'').toUpperCase();
  var sector = (d.profile||{}).sector||'';
  var industry = (d.profile||{}).industry||'';

  // 1. Check known-peer overrides first
  var peers = KNOWN_PEERS[tk];

  // 2. Then try industry match within sector
  if (!peers) {
    var sectorMap = SECTOR_PEERS[sector]||{};
    Object.keys(sectorMap).forEach(function(key) {
      if (key!=='default' && industry.toLowerCase().indexOf(key.toLowerCase())>=0) peers=sectorMap[key];
    });
  }

  // 3. Fall back to sector default
  if (!peers) {
    var def = (SECTOR_PEERS[sector]||{})['default'];
    peers = def || ['SPY','QQQ','IWM','XLK','XLF'];
  }

  // Remove self, dedupe, cap at 8
  peers = peers.filter(function(p){return p.toUpperCase()!==tk;}).filter(function(p,i,a){return a.indexOf(p)===i;}).slice(0,8);

  var inputEl = document.getElementById('resPeerTickers');
  if (inputEl) inputEl.value = peers.join(', ');
  var msgEl = document.getElementById('resPeerAutoMsg');
  if (msgEl) msgEl.innerHTML = 'Pre-loaded <strong>'+peers.length+' peers</strong> for <strong>'+tk+'</strong> ('+sector+(industry?' / '+industry.substring(0,30):'')+'). Edit the list or click <strong>Compare Peers</strong>.';
  resPeerRun();
}

// ═══════════════════════════════════════════════════════════════════════
// STRATEGY BACKTESTING ENGINE
// Supports rule-based strategies evaluated against daily historical prices.
// Data: Yahoo Finance via Cloudflare Worker (/chart endpoint).
// Signal evaluation: end-of-day. Execution: next-day open price.
// ═══════════════════════════════════════════════════════════════════════

var BT_STATE = {
  strategyId: null,
  config: {},
  data: {},     // { ticker: [{date, open, high, low, close, volume},...] }
  results: null
};

var BT_CHARTS = {};

// ── Strategy registry ──────────────────────────────────────────────────────
var BT_STRATEGIES = {

  lvm: {
    name: 'Leveraged Volatility Management',
    description: 'Enters leveraged ETFs when QQQ draws down 15%+ from its ATH AND VIX > 30. Exits back into unleveraged positions progressively as QQQ recovers: rotates 20% of portfolio into QQQ/SPY each time QQQ rises 5% above its ATH.',
    tickers: ['QQQ','VIX','TQQQ','SPXL','TECL','SOXL','SPY'],
    configHTML: `
<div class="card" style="margin-bottom:14px;">
  <div class="card-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
    ⚡ Leveraged Volatility Management — Full Configuration
    <div style="display:flex;gap:6px;">
      <button onclick="btLVMPreset('conservative')" style="font-size:10px;padding:3px 10px;border-radius:3px;border:1px solid var(--border);background:var(--panel);cursor:pointer;">Conservative</button>
      <button onclick="btLVMPreset('moderate')"     style="font-size:10px;padding:3px 10px;border-radius:3px;border:1px solid var(--navy);background:var(--navy);color:#fff;cursor:pointer;">Moderate ★</button>
      <button onclick="btLVMPreset('aggressive')"   style="font-size:10px;padding:3px 10px;border-radius:3px;border:1px solid var(--danger);background:var(--danger);color:#fff;cursor:pointer;">Aggressive</button>
    </div>
  </div>
  <div class="card-body">

    <div style="background:#E8F4FD;border-left:4px solid #5B9BD5;border-radius:4px;padding:10px 14px;margin-bottom:16px;font-size:11.5px;line-height:1.7;">
      <strong>Strategy logic:</strong> Always invested — starts 50/50 QQQ+SPY.
      When QQQ drops ≥X% from ATH AND VIX ≥Y → rotate into TQQQ (3 tranches).
      <strong>Three exit mechanisms work together:</strong>
      (1) <strong>Trailing stop</strong> — exits TQQQ to QQQ+SPY if it falls Z% from its peak since entry. Protects against riding a bear all the way down.
      (2) <strong>VIX-gated de-lever</strong> — only de-levers when VIX is calm (below gate). Prevents selling your recovery while the market is still fearful.
      (3) <strong>ATH stepwise de-lever</strong> — as QQQ sets new highs above the entry ATH, progressively rotates TQQQ → QQQ+SPY.
      Re-entry fires when entry signal triggers again (sells QQQ+SPY → 100% TQQQ).
    </div>

    <!-- BACKTEST WINDOW -->
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--navy);border-bottom:2px solid var(--navy);padding-bottom:3px;margin-bottom:10px;">Backtest Window</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:18px;">
      <div class="form-group">
        <label>Start Date</label>
        <input type="date" id="bt_start_date" value="2019-01-01" style="width:100%;">
      </div>
      <div class="form-group">
        <label>End Date (blank = today)</label>
        <input type="date" id="bt_end_date" value="" style="width:100%;">
      </div>
      <div class="form-group">
        <label>Starting Capital ($)</label>
        <input type="number" id="bt_capital" value="100000" step="1000" min="1000" style="width:100%;">
      </div>
      <div class="form-group">
        <label>Benchmark</label>
        <select id="bt_benchmark" style="width:100%;">
          <option value="QQQ" selected>QQQ</option>
          <option value="SPY">SPY</option>
          <option value="TQQQ">TQQQ B&H</option>
        </select>
      </div>
    </div>

    <!-- ENTRY -->
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--navy);border-bottom:2px solid var(--navy);padding-bottom:3px;margin-bottom:10px;">Entry Conditions (BOTH required)</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:18px;">
      <div class="form-group">
        <label>QQQ Drawdown from ATH &nbsp;<span id="bt_dd_val" style="font-weight:800;color:var(--danger);">-25%</span></label>
        <input type="range" id="bt_dd_thresh" min="5" max="40" value="25" step="1"
          oninput="document.getElementById('bt_dd_val').textContent='-'+this.value+'%'" style="width:100%;">
      </div>
      <div class="form-group">
        <label>VIX must be ≥ &nbsp;<span id="bt_vix_val" style="font-weight:800;">30</span></label>
        <input type="range" id="bt_vix_thresh" min="15" max="60" value="30" step="1"
          oninput="document.getElementById('bt_vix_val').textContent=this.value" style="width:100%;">
      </div>
      <div class="form-group">
        <label>Confirmation (consecutive days)</label>
        <input type="number" id="bt_confirm_days" value="1" min="1" max="10" step="1" style="width:100%;">
        <div style="font-size:10px;color:var(--text-sec);">1 = same-day. 2+ = filter noise.</div>
      </div>
    </div>

    <!-- SCALE-IN TRANCHES -->
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--navy);border-bottom:2px solid var(--navy);padding-bottom:3px;margin-bottom:10px;">Scale-In Tranches</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:18px;">
      <div class="form-group">
        <label>T1 at first signal &nbsp;<span id="bt_t1_val" style="font-weight:800;">50%</span></label>
        <input type="range" id="bt_tranche1" min="10" max="100" value="50" step="5"
          oninput="document.getElementById('bt_t1_val').textContent=this.value+'%';btLVMUpdateTranches()" style="width:100%;">
      </div>
      <div class="form-group">
        <label>T2 size &nbsp;<span id="bt_t2_val" style="font-weight:800;">30%</span></label>
        <input type="range" id="bt_tranche2" min="0" max="90" value="30" step="5"
          oninput="document.getElementById('bt_t2_val').textContent=this.value+'%';btLVMUpdateTranches()" style="width:100%;">
      </div>
      <div class="form-group">
        <label>T2 triggers if QQQ falls another &nbsp;<span id="bt_t2_dd_val" style="font-weight:800;">5%</span></label>
        <input type="range" id="bt_tranche2_dd" min="1" max="20" value="5" step="1"
          oninput="document.getElementById('bt_t2_dd_val').textContent=this.value+'%'" style="width:100%;">
      </div>
      <div class="form-group">
        <label>T3 size &nbsp;<span id="bt_t3_val" style="font-weight:800;">20%</span></label>
        <input type="range" id="bt_tranche3" min="0" max="80" value="20" step="5"
          oninput="document.getElementById('bt_t3_val').textContent=this.value+'%';btLVMUpdateTranches()" style="width:100%;">
      </div>
      <div class="form-group">
        <label>T3 triggers if QQQ falls another &nbsp;<span id="bt_t3_dd_val" style="font-weight:800;">5%</span></label>
        <input type="range" id="bt_tranche3_dd" min="1" max="20" value="5" step="1"
          oninput="document.getElementById('bt_t3_dd_val').textContent=this.value+'%'" style="width:100%;">
      </div>
      <div class="form-group" style="display:flex;align-items:center;">
        <div id="bt_tranche_msg" style="font-size:12px;font-weight:600;padding:8px 12px;background:var(--panel);border:1px solid var(--border);border-radius:4px;width:100%;">T1+T2+T3 = 100% ✓</div>
      </div>
    </div>

    <!-- EXIT MECHANISMS -->
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--navy);border-bottom:2px solid var(--navy);padding-bottom:3px;margin-bottom:10px;">Exit Mechanisms</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-bottom:8px;">

      <!-- Mechanism 1: Trailing Stop -->
      <div style="background:rgba(139,42,42,0.06);border:1px solid rgba(139,42,42,0.3);border-radius:6px;padding:12px;">
        <div style="font-size:11px;font-weight:700;color:var(--danger);margin-bottom:8px;">① TRAILING STOP (Downside protection)</div>
        <div class="form-group" style="margin-bottom:6px;">
          <label>TQQQ drops this % from its peak since entry &nbsp;<span id="bt_trail_val" style="font-weight:800;color:var(--danger);">-35%</span></label>
          <input type="range" id="bt_trailing_stop" min="0" max="70" value="35" step="5"
            oninput="document.getElementById('bt_trail_val').textContent=this.value==0?'OFF':'-'+this.value+'%'" style="width:100%;">
          <div style="font-size:10px;color:var(--text-sec);margin-top:3px;">0 = disabled. Exits to QQQ+SPY (not cash). Re-entry re-engages if signal fires again.</div>
        </div>
      </div>

      <!-- Mechanism 2: VIX-Gated De-Lever -->
      <div style="background:rgba(0,60,113,0.06);border:1px solid rgba(0,60,113,0.3);border-radius:6px;padding:12px;">
        <div style="font-size:11px;font-weight:700;color:var(--navy);margin-bottom:8px;">② VIX GATE (Hold TQQQ while market still fearful)</div>
        <div class="form-group" style="margin-bottom:6px;">
          <label>Only de-lever when VIX is below &nbsp;<span id="bt_vix_gate_val" style="font-weight:800;">25</span></label>
          <input type="range" id="bt_vix_gate" min="0" max="50" value="25" step="1"
            oninput="document.getElementById('bt_vix_gate_val').textContent=this.value==0?'OFF (always de-lever)':this.value" style="width:100%;">
          <div style="font-size:10px;color:var(--text-sec);margin-top:3px;">0 = de-lever regardless of VIX. Recommended: 25. Prevents selling during panics when TQQQ is undervalued.</div>
        </div>
      </div>

      <!-- Mechanism 3: ATH De-Lever -->
      <div style="background:rgba(46,125,82,0.06);border:1px solid rgba(46,125,82,0.3);border-radius:6px;padding:12px;">
        <div style="font-size:11px;font-weight:700;color:var(--success,#2E7D52);margin-bottom:8px;">③ ATH STEPWISE DE-LEVER (Lock in gains)</div>
        <div class="form-group" style="margin-bottom:6px;">
          <label>QQQ % above entry ATH per step &nbsp;<span id="bt_delever_val" style="font-weight:800;">10%</span></label>
          <input type="range" id="bt_delever_step" min="1" max="25" value="10" step="1"
            oninput="document.getElementById('bt_delever_val').textContent=this.value+'%'" style="width:100%;">
        </div>
        <div class="form-group" style="margin-bottom:6px;">
          <label>Sell this % of TQQQ per step &nbsp;<span id="bt_delever_pct_val" style="font-weight:800;">10%</span></label>
          <input type="range" id="bt_delever_pct" min="5" max="100" value="10" step="5"
            oninput="document.getElementById('bt_delever_pct_val').textContent=this.value+'%'" style="width:100%;">
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label>Hard ceiling — sell ALL TQQQ when QQQ exceeds ATH by &nbsp;<span id="bt_full_exit_val" style="font-weight:800;">Never</span></label>
          <input type="range" id="bt_full_exit" min="0" max="100" value="0" step="5"
            oninput="document.getElementById('bt_full_exit_val').textContent=this.value==0?'Never':'+'+this.value+'%'" style="width:100%;">
        </div>
      </div>

      <!-- Re-entry -->
      <div style="background:rgba(139,105,20,0.06);border:1px solid rgba(139,105,20,0.3);border-radius:6px;padding:12px;">
        <div style="font-size:11px;font-weight:700;color:#8B6914;margin-bottom:8px;">④ RE-ENTRY</div>
        <div class="form-group" style="margin-bottom:6px;">
          <label style="display:flex;align-items:flex-start;gap:8px;">
            <input type="checkbox" id="bt_re_entry_on_signal" checked style="margin-top:2px;">
            <span>Sell QQQ+SPY → 100% TQQQ if entry signal fires again while de-leveraging</span>
          </label>
          <div style="font-size:10px;color:var(--text-sec);margin-top:4px;">Strongly recommended ON — captures second-leg crashes.</div>
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label>Slippage per trade (%)<span id="bt_slip_val" style="font-weight:700;"> 0.05%</span></label>
          <input type="range" id="bt_slippage" min="0" max="0.5" value="0.05" step="0.05"
            oninput="document.getElementById('bt_slip_val').textContent=' '+parseFloat(this.value).toFixed(2)+'%'" style="width:100%;">
        </div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px;">
      <div class="form-group">
        <label>Starting Capital ($)</label>
        <input type="number" id="bt_capital2" value="100000" step="1000" style="width:100%;" oninput="document.getElementById('bt_capital').value=this.value">
        <div style="font-size:10px;color:var(--text-sec);">Same as above — synced.</div>
      </div>
      <div class="form-group">
        <label>Commission per trade ($)</label>
        <input type="number" id="bt_commission" value="0" step="0.5" min="0" style="width:100%;">
      </div>
    </div>
  </div>
</div>`,
    run: btRunLVM
  },

  dca: {
    name: 'Systematic Dollar-Cost Averaging',
    description: 'Invest a fixed amount into selected tickers on a regular schedule (monthly/weekly), with optional VIX-based boost.',
    tickers: ['SPY','QQQ'],
    configHTML: `
      <div class="card" style="margin-bottom:14px;">
        <div class="card-title">📅 Systematic DCA — Configuration</div>
        <div class="card-body">
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:14px;">
            <div class="form-group"><label>Ticker</label><input type="text" id="bt_dca_ticker" value="SPY" style="text-transform:uppercase;width:100%;"></div>
            <div class="form-group"><label>Invest Amount ($ per period)</label><input type="number" id="bt_dca_amount" value="1000" min="100"></div>
            <div class="form-group"><label>Frequency</label>
              <select id="bt_dca_freq"><option value="monthly" selected>Monthly</option><option value="weekly">Weekly</option><option value="quarterly">Quarterly</option></select>
            </div>
            <div class="form-group"><label>Backtest Period</label>
              <select id="bt_period"><option value="5y" selected>5 Years</option><option value="10y">10 Years</option><option value="15y">15 Years</option></select>
            </div>
            <div class="form-group"><label>Benchmark</label>
              <select id="bt_benchmark"><option value="SPY" selected>SPY Lump Sum</option><option value="QQQ">QQQ Lump Sum</option></select>
            </div>
          </div>
          <div class="form-group">
            <label style="display:flex;align-items:center;gap:8px;">
              <input type="checkbox" id="bt_dca_vix_boost"> VIX Boost: Double investment when VIX &gt; 30
            </label>
          </div>
        </div>
      </div>`,
    run: btRunDCA
  },

  momentum: {
    name: 'Dual Momentum (Gary Antonacci)',
    description: 'Absolute + relative momentum. Each month: if SPY 12M return > T-Bill, hold SPY or QQQ (whichever has higher 12M return). Else hold AGG (bonds).',
    tickers: ['SPY','QQQ','AGG','SHY'],
    configHTML: `
      <div class="card" style="margin-bottom:14px;">
        <div class="card-title">📈 Dual Momentum — Configuration</div>
        <div class="card-body">
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;">
            <div class="form-group"><label>Lookback (months)</label>
              <select id="bt_mom_lookback"><option value="6">6M</option><option value="12" selected>12M</option><option value="3">3M</option></select>
            </div>
            <div class="form-group"><label>Risk-Off Asset</label>
              <select id="bt_mom_riskoff"><option value="AGG" selected>AGG (Bonds)</option><option value="SHY">SHY (Short Bonds)</option><option value="CASH">Cash</option></select>
            </div>
            <div class="form-group"><label>Starting Capital ($)</label>
              <input type="number" id="bt_capital" value="100000" step="10000"></div>
            <div class="form-group"><label>Backtest Period</label>
              <select id="bt_period"><option value="5y" selected>5 Years</option><option value="10y">10 Years</option><option value="15y">15 Years</option></select>
            </div>
            <div class="form-group"><label>Benchmark</label>
              <select id="bt_benchmark"><option value="SPY" selected>SPY Buy &amp; Hold</option><option value="QQQ">QQQ B&amp;H</option></select>
            </div>
          </div>
        </div>
        <div class="card-sources"><strong>Reference:</strong> Antonacci (2012) "Risk Premia Harvesting Through Dual Momentum".</div>
      </div>`,
    run: btRunMomentum
  },

  custom: {
    name: 'Custom Strategy',
    description: 'Define your own entry/exit rules using simple conditions.',
    tickers: [],
    configHTML: `
      <div class="card" style="margin-bottom:14px;">
        <div class="card-title">🔧 Custom Strategy Builder</div>
        <div class="card-body">
          <p style="font-size:12px;color:var(--text-sec);margin-bottom:12px;">Define a primary asset, an entry condition, and an exit condition. Supports moving average crossovers, RSI thresholds, and drawdown triggers.</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
            <div class="form-group"><label>Primary Asset</label><input type="text" id="bt_cust_ticker" value="SPY" style="text-transform:uppercase;width:100%;"></div>
            <div class="form-group"><label>Benchmark</label><input type="text" id="bt_benchmark" value="SPY" style="text-transform:uppercase;width:100%;"></div>
            <div class="form-group"><label>Starting Capital ($)</label><input type="number" id="bt_capital" value="100000" step="10000"></div>
            <div class="form-group"><label>Backtest Period</label>
              <select id="bt_period"><option value="5y" selected>5 Years</option><option value="10y">10 Years</option></select>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
            <div class="form-group">
              <label>Entry Condition</label>
              <select id="bt_cust_entry">
                <option value="ma_cross_up">Price crosses above 50D MA</option>
                <option value="ma200_cross_up">Price crosses above 200D MA</option>
                <option value="rsi_oversold">RSI(14) crosses above 30</option>
                <option value="dd_entry">Drawdown from ATH exceeds 15%</option>
              </select>
            </div>
            <div class="form-group">
              <label>Exit Condition</label>
              <select id="bt_cust_exit">
                <option value="ma_cross_down">Price crosses below 50D MA</option>
                <option value="ma200_cross_down">Price crosses below 200D MA</option>
                <option value="rsi_overbought">RSI(14) crosses above 70</option>
                <option value="dd_exit">Return to ATH</option>
              </select>
            </div>
          </div>
        </div>
      </div>`,
    run: btRunCustom
  }
};

// ── Strategy loader ─────────────────────────────────────────────────────────
function btLoadStrategy(id) {
  BT_STATE.strategyId = id;
  var strat = BT_STRATEGIES[id];
  if (!strat) return;

  // Highlight active button
  Object.keys(BT_STRATEGIES).forEach(function(k) {
    var btn = document.getElementById('btStratBtn_' + k);
    if (btn) { btn.className = k === id ? 'btn' : 'btn-outline'; }
  });

  document.getElementById('btConfigPanel').innerHTML = strat.configHTML;
  document.getElementById('btRunRow').style.display = 'flex';
  document.getElementById('btRunRow').style.alignItems = 'center';
  document.getElementById('btResults').style.display = 'none';
  document.getElementById('btRunStatus').textContent = '';

  if (id === 'lvm') btUpdateWeightSum();
}

function btUpdateWeightSum() {
  var tickers = ['TQQQ','SPXL','TECL','SOXL'];
  var total = 0;
  tickers.forEach(function(t) {
    var el = document.getElementById('bt_w_' + t);
    var val = el ? parseInt(el.value) : 0;
    var labelEl = document.getElementById('bt_wv_' + t);
    if (labelEl) labelEl.textContent = val + '%';
    total += val;
  });
  var msg = document.getElementById('bt_weight_sum_msg');
  if (msg) {
    msg.textContent = 'Total: ' + total + '%';
    msg.style.color = total === 100 ? C.success : C.danger;
  }
}

// ── Shared: fetch daily price series ───────────────────────────────────────
async function btFetchPrices(ticker, period) {
  var WORKER = 'https://perry-finance-proxy.zachperrybusiness.workers.dev';
  var vixTicker = ticker === '^VIX' ? '%5EVIX' : encodeURIComponent(ticker);
  var res = await fetch(WORKER + '/chart?symbol=' + vixTicker + '&range=' + period + '&interval=1d');
  var d = await res.json();
  if (d.error) throw new Error('Price fetch failed for ' + ticker + ': ' + d.error);
  return (d.points || []).filter(function(p) { return p.close != null; }).map(function(p) {
    return { date: p.date.slice(0, 10), open: p.open || p.close, close: p.close };
  });
}

// ── Shared: build date-aligned price map ───────────────────────────────────
function btAlignPrices(seriesMap) {
  // seriesMap: { ticker: [{date, open, close},...] }
  // Returns { dates:[], prices:{ ticker: {date: {open,close}} } }
  var allDates = new Set();
  Object.values(seriesMap).forEach(function(pts) {
    pts.forEach(function(p) { allDates.add(p.date); });
  });
  var dates = Array.from(allDates).sort();
  var prices = {};
  Object.entries(seriesMap).forEach(function([tk, pts]) {
    prices[tk] = {};
    pts.forEach(function(p) { prices[tk][p.date] = p; });
  });
  return { dates: dates, prices: prices };
}

// ── Shared: render KPI cards ────────────────────────────────────────────────
function btRenderKPI(kpis) {
  var el = document.getElementById('btKPIRow');
  if (!el) return;
  el.innerHTML = kpis.map(function(k) {
    var col = k.color || C.navy;
    return '<div style="background:var(--bg);border:1px solid var(--border);border-top:3px solid '+col+';border-radius:4px;padding:12px 16px;flex:1;min-width:130px;">'
      + '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-sec);">'+k.label+'</div>'
      + '<div style="font-size:22px;font-weight:800;color:'+col+';">'+k.value+'</div>'
      + (k.sub ? '<div style="font-size:10px;color:var(--text-sec);">'+k.sub+'</div>' : '')
      + '</div>';
  }).join('');
}

// ── Shared: render equity + drawdown + exposure charts ─────────────────────
function btRenderCharts(dates, stratEquity, benchEquity, exposureData, stratLabel, benchLabel) {
  document.getElementById('btResults').style.display = '';

  // Equity curve
  var ec = document.getElementById('btEquityChart');
  if (ec) {
    if (BT_CHARTS.equity) BT_CHARTS.equity.destroy();
    BT_CHARTS.equity = new Chart(ec.getContext('2d'), {
      type: 'line',
      data: { labels: dates, datasets: [
        { label: stratLabel, data: stratEquity, borderColor: C.success, borderWidth: 2, pointRadius: 0, fill: false, tension: 0.1 },
        { label: benchLabel + ' (B&H)', data: benchEquity, borderColor: C.navy, borderWidth: 1.5, borderDash: [5,3], pointRadius: 0, fill: false, tension: 0.1 }
      ]},
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: true, labels: { font: { size: 11 } } }, tooltip: chartTooltip },
        scales: {
          x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { maxTicksLimit: 10, font: { size: 9 }, autoSkip: true }) },
          y: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { callback: function(v) { return '$' + (v/1000).toFixed(0) + 'K'; }, font: { size: 9 } }) }
        }
      }
    });
  }

  // Drawdown
  function toDrawdown(equity) {
    var peak = -Infinity, dd = [];
    equity.forEach(function(v) { peak = Math.max(peak, v); dd.push(v > 0 ? (v - peak) / peak * 100 : 0); });
    return dd;
  }
  var stratDD = toDrawdown(stratEquity);
  var benchDD = toDrawdown(benchEquity);
  var dc = document.getElementById('btDrawdownChart');
  if (dc) {
    if (BT_CHARTS.drawdown) BT_CHARTS.drawdown.destroy();
    BT_CHARTS.drawdown = new Chart(dc.getContext('2d'), {
      type: 'line',
      data: { labels: dates, datasets: [
        { label: stratLabel + ' DD', data: stratDD, borderColor: C.danger, borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: 'rgba(139,42,42,0.12)', tension: 0.1 },
        { label: benchLabel + ' DD', data: benchDD, borderColor: '#8B6914', borderWidth: 1, borderDash: [4,3], pointRadius: 0, fill: false, tension: 0.1 }
      ]},
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: true, labels: { font: { size: 11 } } }, tooltip: chartTooltip },
        scales: {
          x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { maxTicksLimit: 10, font: { size: 9 }, autoSkip: true }) },
          y: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { callback: function(v) { return v.toFixed(1) + '%'; }, font: { size: 9 } }), suggestedMax: 0 }
        }
      }
    });
  }

  // Exposure
  if (exposureData && exposureData.datasets && exposureData.datasets.length) {
    var xc = document.getElementById('btExposureChart');
    if (xc) {
      if (BT_CHARTS.exposure) BT_CHARTS.exposure.destroy();
      BT_CHARTS.exposure = new Chart(xc.getContext('2d'), {
        type: 'line',
        data: { labels: dates, datasets: exposureData.datasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: true, labels: { font: { size: 10 } } }, tooltip: chartTooltip },
          scales: {
            x: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { maxTicksLimit: 10, font: { size: 9 }, autoSkip: true }) },
            y: { grid: chartGrid, ticks: Object.assign({}, chartTicks, { callback: function(v) { return v + '%'; }, font: { size: 9 } }), min: 0, max: 100 }
          }
        }
      });
    }
  }
}

// ── Shared: render trade log ────────────────────────────────────────────────
function btRenderTradeLog(trades) {
  var el = document.getElementById('btTradeLog');
  if (!el) return;
  if (!trades.length) { el.innerHTML = '<p style="padding:16px;color:var(--text-sec);">No trades generated.</p>'; return; }
  var h = '<table style="width:100%;font-size:11.5px;border-collapse:collapse;white-space:nowrap;">';
  h += '<thead><tr style="background:var(--navy);color:#fff;position:sticky;top:0;">';
  ['Date','Action','Ticker','Shares','Price','Value','Portfolio Value','Notes'].forEach(function(col) {
    h += '<th style="padding:7px 10px;text-align:left;">'+col+'</th>';
  });
  h += '</tr></thead><tbody>';
  trades.forEach(function(t, i) {
    var isBuy = t.action && t.action.includes('BUY');
    var col = isBuy ? C.success : t.action && t.action.includes('SELL') ? C.danger : '#8B6914';
    var bg = i%2===0?'':'background:rgba(0,0,0,0.02);';
    h += '<tr style="'+bg+'border-bottom:1px solid var(--border);border-left:3px solid '+col+';">';
    h += '<td style="padding:6px 10px;font-family:monospace;">'+t.date+'</td>';
    h += '<td style="padding:6px 10px;font-weight:700;color:'+col+';">'+t.action+'</td>';
    h += '<td style="padding:6px 10px;font-weight:600;">'+(t.ticker||'—')+'</td>';
    h += '<td style="padding:6px 10px;font-family:monospace;text-align:right;">'+(t.shares!=null?t.shares.toLocaleString(undefined,{maximumFractionDigits:2}):'—')+'</td>';
    h += '<td style="padding:6px 10px;font-family:monospace;text-align:right;">'+(t.price!=null?'$'+t.price.toFixed(2):'—')+'</td>';
    h += '<td style="padding:6px 10px;font-family:monospace;text-align:right;font-weight:600;color:'+col+';">'+(t.value!=null?'$'+t.value.toLocaleString(undefined,{maximumFractionDigits:0}):'—')+'</td>';
    h += '<td style="padding:6px 10px;font-family:monospace;text-align:right;">'+(t.portfolio!=null?'$'+t.portfolio.toLocaleString(undefined,{maximumFractionDigits:0}):'—')+'</td>';
    h += '<td style="padding:6px 10px;font-size:10.5px;color:var(--text-sec);">'+(t.notes||'')+'</td>';
    h += '</tr>';
  });
  h += '</tbody></table>';
  el.innerHTML = h;
}

// ── Shared: compute statistics ─────────────────────────────────────────────
function btStats(equity, benchEquity, capital) {
  if (!equity.length) return {};
  var finalVal = equity[equity.length-1];
  var totalReturn = (finalVal - capital) / capital * 100;
  var years = equity.length / 252;

  // CAGR
  var cagr = years > 0 ? (Math.pow(finalVal / capital, 1 / years) - 1) * 100 : 0;

  // Max drawdown
  var peak = -Infinity, maxDD = 0;
  equity.forEach(function(v) {
    peak = Math.max(peak, v);
    var dd = (v - peak) / peak * 100;
    maxDD = Math.min(maxDD, dd);
  });

  // Daily returns → Sharpe (annualized, rf=4%)
  var rf_daily = 0.04 / 252;
  var dailyRets = [];
  for (var i = 1; i < equity.length; i++) {
    if (equity[i-1] > 0) dailyRets.push(equity[i] / equity[i-1] - 1);
  }
  var meanRet = dailyRets.reduce(function(s,v){return s+v;},0) / Math.max(1,dailyRets.length);
  var variance = dailyRets.reduce(function(s,v){return s+(v-meanRet)*(v-meanRet);},0) / Math.max(1,dailyRets.length-1);
  var sharpe = variance > 0 ? (meanRet - rf_daily) / Math.sqrt(variance) * Math.sqrt(252) : 0;

  // Sortino (downside std only)
  var downRets = dailyRets.filter(function(r){return r < rf_daily;});
  var downVar = downRets.reduce(function(s,v){return s+(v-rf_daily)*(v-rf_daily);},0) / Math.max(1,downRets.length-1);
  var sortino = downVar > 0 ? (meanRet - rf_daily) / Math.sqrt(downVar) * Math.sqrt(252) : 0;

  // Calmar
  var calmar = maxDD !== 0 ? cagr / Math.abs(maxDD) : 0;

  // Benchmark comparison
  var benchReturn = benchEquity.length ? (benchEquity[benchEquity.length-1] - capital) / capital * 100 : null;
  var alpha = benchReturn != null ? totalReturn - benchReturn : null;

  // Win rate (monthly)
  var monthlyRets = [];
  for (var m = 21; m < equity.length; m += 21) {
    if (equity[m-21] > 0) monthlyRets.push(equity[m] / equity[m-21] - 1);
  }
  var winRate = monthlyRets.length ? monthlyRets.filter(function(r){return r > 0;}).length / monthlyRets.length * 100 : null;

  return {
    totalReturn: totalReturn.toFixed(1),
    cagr: cagr.toFixed(2),
    maxDD: maxDD.toFixed(1),
    sharpe: sharpe.toFixed(2),
    sortino: sortino.toFixed(2),
    calmar: calmar.toFixed(2),
    finalVal: finalVal,
    benchReturn: benchReturn != null ? benchReturn.toFixed(1) : null,
    alpha: alpha != null ? alpha.toFixed(1) : null,
    winRate: winRate != null ? winRate.toFixed(1) : null,
    years: years.toFixed(1)
  };
}

// ── STRATEGY 1: Leveraged Volatility Management ────────────────────────────
// THREE EXIT MECHANISMS:
//   ① Trailing stop (TQQQ drops X% from its peak since entry → shift to QQQ+SPY)
//   ② VIX gate (only de-lever when VIX < gate — hold during panics)
//   ③ ATH stepwise de-lever (sell TQQQ % at each QQQ ATH milestone)
// Always invested: QQQ+SPY when not in TQQQ. Never cash.
// ─────────────────────────────────────────────────────────────────────────────

function btLVMPreset(mode) {
  var p = {
    conservative: {dd:20,vix:35,conf:1,t1:100,t2:0,t2dd:5,t3:0,t3dd:5, trail:25,gate:20,ds:10,dp:15,fe:30, re:false,slip:0.10},
    moderate:     {dd:25,vix:30,conf:1,t1:50, t2:30,t2dd:5,t3:20,t3dd:5,trail:35,gate:25,ds:10,dp:10,fe:0,  re:true, slip:0.05},
    aggressive:   {dd:30,vix:25,conf:1,t1:34, t2:33,t2dd:5,t3:33,t3dd:5,trail:45,gate:30,ds:15,dp:10,fe:0,  re:true, slip:0.05},
  }[mode];
  if (!p) return;
  function sv(id,v){var el=document.getElementById(id);if(el){el.value=v;el.dispatchEvent(new Event('input'));}}
  sv('bt_dd_thresh',p.dd);sv('bt_vix_thresh',p.vix);sv('bt_confirm_days',p.conf);
  sv('bt_tranche1',p.t1);sv('bt_tranche2',p.t2);sv('bt_tranche2_dd',p.t2dd);
  sv('bt_tranche3',p.t3);sv('bt_tranche3_dd',p.t3dd);
  sv('bt_trailing_stop',p.trail);sv('bt_vix_gate',p.gate);
  sv('bt_delever_step',p.ds);sv('bt_delever_pct',p.dp);sv('bt_full_exit',p.fe);
  sv('bt_slippage',p.slip);
  var re=document.getElementById('bt_re_entry_on_signal');if(re)re.checked=p.re;
  btLVMUpdateTranches();
}

function btLVMUpdateTranches(){
  var t1=parseInt(document.getElementById('bt_tranche1')?.value||100);
  var t2=parseInt(document.getElementById('bt_tranche2')?.value||0);
  var t3=parseInt(document.getElementById('bt_tranche3')?.value||0);
  var tot=t1+t2+t3;
  var msg=document.getElementById('bt_tranche_msg');
  if(!msg)return;
  var col=tot===100?'var(--success,#2E7D52)':tot>100?'var(--danger)':'#8B6914';
  msg.innerHTML='T1 <strong>'+t1+'%</strong> + T2 <strong>'+t2+'%</strong> + T3 <strong>'+t3+'%</strong> = <strong style="color:'+col+';">'+tot+'%</strong>'+(tot!==100?' ⚠ must = 100%':' ✓');
}

async function btRunLVM() {
  var status=document.getElementById('btRunStatus');
  var btn=document.getElementById('btRunBtn');
  btn.disabled=true; status.textContent='Reading configuration…';
  try {
    // ── Read params ────────────────────────────────────────────────
    var ddThresh    = parseFloat(document.getElementById('bt_dd_thresh').value)/100;
    var vixEntry    = parseFloat(document.getElementById('bt_vix_thresh').value);
    var confirmDays = parseInt(document.getElementById('bt_confirm_days').value)||1;
    var t1Pct       = parseFloat(document.getElementById('bt_tranche1').value)/100;
    var t2Pct       = parseFloat(document.getElementById('bt_tranche2').value)/100;
    var t2DD        = parseFloat(document.getElementById('bt_tranche2_dd').value)/100;
    var t3Pct       = parseFloat(document.getElementById('bt_tranche3').value)/100;
    var t3DD        = parseFloat(document.getElementById('bt_tranche3_dd').value)/100;
    var trailStop   = parseFloat(document.getElementById('bt_trailing_stop').value)/100; // 0=off
    var vixGate     = parseFloat(document.getElementById('bt_vix_gate').value);           // 0=off
    var deleverStep = parseFloat(document.getElementById('bt_delever_step').value)/100;
    var deleverPct  = parseFloat(document.getElementById('bt_delever_pct').value)/100;
    var fullExitPct = parseFloat(document.getElementById('bt_full_exit').value)/100;     // 0=never
    var reEntryOn   = document.getElementById('bt_re_entry_on_signal').checked;
    var capital     = parseFloat(document.getElementById('bt_capital').value)||100000;
    var slippage    = parseFloat(document.getElementById('bt_slippage').value)/100;
    var commission  = parseFloat(document.getElementById('bt_commission').value)||0;
    var benchTicker = document.getElementById('bt_benchmark').value;
    var startDate   = document.getElementById('bt_start_date').value||'2019-01-01';
    var endDate     = document.getElementById('bt_end_date').value||'';

    var totT=Math.round((t1Pct+t2Pct+t3Pct)*100);
    if(totT!==100){status.textContent='Tranches must sum to 100% (currently '+totT+'%)';btn.disabled=false;return;}

    // ── Fetch max history ─────────────────────────────────────────
    var fetchList=['QQQ','^VIX','TQQQ','SPY'];
    if(['QQQ','SPY','TQQQ'].indexOf(benchTicker)<0)fetchList.push(benchTicker);
    fetchList=fetchList.filter(function(t,i,a){return a.indexOf(t)===i;});
    var raw={};
    for(var fi=0;fi<fetchList.length;fi++){
      var ft=fetchList[fi];
      status.textContent='Fetching '+ft+' ('+(fi+1)+'/'+fetchList.length+')…';
      try{raw[ft]=await btFetchPrices(ft,'max');}
      catch(e){try{raw[ft]=await btFetchPrices(ft,'15y');}catch(e2){raw[ft]=[];}}
    }
    var px={};
    fetchList.forEach(function(t){
      px[t]={};
      (raw[t]||[]).forEach(function(p){px[t][p.date]={open:p.open||p.close,close:p.close};});
    });
    var allDates=(raw['QQQ']||[]).map(function(p){return p.date;}).sort();
    if(!allDates.length)throw new Error('No QQQ data');

    var simDates=allDates.filter(function(d){return d>=startDate&&(!endDate||d<=endDate);});
    if(!simDates.length)throw new Error('No dates in range '+startDate+' – '+(endDate||'today'));

    // ── ATH warm-up ──────────────────────────────────────────────
    var qqqATH=-Infinity, warmCt=0;
    for(var wi=0;wi<allDates.length;wi++){
      if(allDates[wi]>=simDates[0])break;
      var wc=(px['QQQ'][allDates[wi]]||{}).close;
      if(wc>0){qqqATH=Math.max(qqqATH,wc);warmCt++;}
    }
    if(!isFinite(qqqATH)||qqqATH<=0){
      qqqATH=(px['QQQ'][simDates[0]]||{}).close||1;
      console.warn('[LVM] No warm-up; ATH=first price');
    }

    // ── State ────────────────────────────────────────────────────
    var sharesTQQQ=0,sharesQQQ=0,sharesSPY=0;
    var IN_UNLEV=0,IN_TQQQ=1;
    var state=IN_UNLEV;
    var entryATH=null,entryTQQQPx=null,trailHigh=null;
    var deleverFired={},fullExitFired=false;
    var scalePhase=0,t1QQQPx=null,t2QQQPx=null;
    var confirmCt=0;
    var benchShares=null;
    var lastPx={}; fetchList.forEach(function(t){lastPx[t]=0;});
    var equityCurve=[],benchCurve=[],tradeLog=[];
    var expTQQQ=[],expUnlev=[];

    // ── Helpers ──────────────────────────────────────────────────
    function portVal(){
      return sharesTQQQ*(lastPx['TQQQ']||0)+sharesQQQ*(lastPx['QQQ']||0)+sharesSPY*(lastPx['SPY']||0);
    }
    function slip(dollars){return dollars*slippage+commission;}
    function log(date,action,ticker,shrs,price,note){
      tradeLog.push({date:date,action:action,ticker:ticker,shares:Math.abs(shrs),
        price:price,value:Math.abs(shrs)*price,portfolio:portVal(),notes:note});
    }
    function getOpen(t,d){return(px[t][d]||{}).open||lastPx[t]||0;}

    function buyWith(execD,ticker,dollars,note){
      if(dollars<1)return;
      var ep=getOpen(ticker,execD);if(ep<=0)return;
      var net=dollars-slip(dollars);
      var shrs=net/ep;
      if(ticker==='TQQQ')sharesTQQQ+=shrs;
      else if(ticker==='QQQ')sharesQQQ+=shrs;
      else if(ticker==='SPY')sharesSPY+=shrs;
      log(execD,'BUY '+ticker,ticker,shrs,ep,note);
    }
    function sellAll(execD,ticker,note){
      var shrs,ep,proc;
      if(ticker==='TQQQ'){if(sharesTQQQ<0.0001)return 0;shrs=sharesTQQQ;ep=getOpen('TQQQ',execD);proc=shrs*ep-slip(shrs*ep);sharesTQQQ=0;}
      else if(ticker==='QQQ'){if(sharesQQQ<0.0001)return 0;shrs=sharesQQQ;ep=getOpen('QQQ',execD);proc=shrs*ep-slip(shrs*ep);sharesQQQ=0;}
      else if(ticker==='SPY'){if(sharesSPY<0.0001)return 0;shrs=sharesSPY;ep=getOpen('SPY',execD);proc=shrs*ep-slip(shrs*ep);sharesSPY=0;}
      else return 0;
      if(ep<=0)return 0;
      log(execD,'SELL '+ticker,ticker,shrs,ep,note);
      return proc;
    }
    function sellFrac(execD,ticker,frac,note){
      var shrs,ep,proc;
      frac=Math.min(1,frac);
      if(ticker==='TQQQ'){if(sharesTQQQ<0.0001)return 0;shrs=sharesTQQQ*frac;ep=getOpen('TQQQ',execD);proc=shrs*ep-slip(shrs*ep);sharesTQQQ-=shrs;}
      else return 0;
      if(ep<=0)return 0;
      log(execD,'SELL '+ticker+' ('+Math.round(frac*100)+'%)',ticker,shrs,ep,note);
      return proc;
    }
    // Shift dollars of QQQ+SPY → TQQQ (sells proportionally from each)
    function shiftQQQSPYtoTQQQ(execD,dollars,note){
      var qv=sharesQQQ*(lastPx['QQQ']||0),sv=sharesSPY*(lastPx['SPY']||0),uv=qv+sv;
      if(uv<1||dollars<1)return;
      var frac=Math.min(1,dollars/uv);
      var p1=sellFrac2(execD,'QQQ',frac,note);
      var p2=sellFrac2(execD,'SPY',frac,note);
      buyWith(execD,'TQQQ',p1+p2,note);
    }
    function sellFrac2(execD,ticker,frac,note){
      var shrs,ep,proc;
      frac=Math.min(1,Math.max(0,frac));
      if(ticker==='QQQ'){if(sharesQQQ<0.0001)return 0;shrs=sharesQQQ*frac;ep=getOpen('QQQ',execD);if(ep<=0)return 0;proc=shrs*ep-slip(shrs*ep);sharesQQQ-=shrs;}
      else if(ticker==='SPY'){if(sharesSPY<0.0001)return 0;shrs=sharesSPY*frac;ep=getOpen('SPY',execD);if(ep<=0)return 0;proc=shrs*ep-slip(shrs*ep);sharesSPY-=shrs;}
      else return 0;
      log(execD,'SELL '+ticker,ticker,shrs,ep,note);
      return proc;
    }
    // Shift TQQQ proceeds → QQQ+SPY 50/50
    function shiftTQQQtoUnlev(execD,tqqqFrac,note){
      var proc=sellFrac(execD,'TQQQ',tqqqFrac,note);
      if(proc<1)return;
      buyWith(execD,'QQQ',proc/2,note+' → QQQ');
      buyWith(execD,'SPY',proc/2,note+' → SPY');
    }
    function resetLevState(){
      state=IN_UNLEV;entryATH=null;entryTQQQPx=null;trailHigh=null;
      deleverFired={};fullExitFired=false;scalePhase=0;
      t1QQQPx=null;t2QQQPx=null;confirmCt=0;
    }

    // ── Simulation ───────────────────────────────────────────────
    for(var di=0;di<simDates.length;di++){
      var d=simDates[di];
      var execD=di+1<simDates.length?simDates[di+1]:d;

      // Update last-known prices
      fetchList.forEach(function(t){var c=(px[t][d]||{}).close;if(c&&c>0)lastPx[t]=c;});
      var vRaw=(px['^VIX'][d]||{}).close;if(vRaw&&vRaw>0)lastPx['^VIX']=vRaw;

      var qqqC=lastPx['QQQ'],tqqqC=lastPx['TQQQ'],spyC=lastPx['SPY']||0;
      var vixC=lastPx['^VIX']||null;
      if(!qqqC||!tqqqC)continue;
      qqqATH=Math.max(qqqATH,qqqC);
      if(benchShares===null&&lastPx[benchTicker]>0)benchShares=capital/lastPx[benchTicker];

      // Day 1: deploy capital 50/50 QQQ+SPY
      if(di===0){
        var h0=capital/2;
        var q0=(px['QQQ'][d]||{}).close||qqqC,s0=(px['SPY'][d]||{}).close||spyC;
        if(q0>0)sharesQQQ=(h0-slip(h0))/q0;
        if(s0>0)sharesSPY=(h0-slip(h0))/s0;
        log(d,'INIT','QQQ+SPY',sharesQQQ+sharesSPY,q0,'Day 1: 50/50 QQQ+SPY');
      }

      // Update trailing high
      if(state===IN_TQQQ&&tqqqC>0){if(!trailHigh||tqqqC>trailHigh)trailHigh=tqqqC;}

      // ══ ① TRAILING STOP ══════════════════════════════════════
      // Fires when TQQQ falls trailStop% below its peak since entry
      if(trailStop>0&&state===IN_TQQQ&&trailHigh&&entryTQQQPx){
        var tDD=(tqqqC-trailHigh)/trailHigh;
        if(tDD<=-trailStop){
          var tNote='TRAILING STOP: TQQQ '+(tDD*100).toFixed(1)+'% from peak $'+trailHigh.toFixed(2)+' → QQQ+SPY';
          shiftTQQQtoUnlev(execD,1.0,tNote);
          resetLevState();
        }
      }

      // ══ ENTRY SIGNAL ═════════════════════════════════════════
      var dd=(qqqC-qqqATH)/qqqATH;
      var sig=dd<=-ddThresh&&vixC!=null&&vixC>=vixEntry;
      if(sig)confirmCt=Math.min(confirmCt+1,confirmDays);else confirmCt=0;
      var confirmed=confirmCt>=confirmDays;

      // T1: first entry from unleveraged state
      if(confirmed&&state===IN_UNLEV&&scalePhase===0){
        var t1Note='T1 ('+Math.round(t1Pct*100)+'%): QQQ DD='+(dd*100).toFixed(1)+'% VIX='+(vixC||0).toFixed(0);
        var uv0=sharesQQQ*qqqC+sharesSPY*spyC;
        if(uv0>0){
          var f1=Math.min(1,(portVal()*t1Pct)/uv0);
          var p1a=sellFrac2(execD,'QQQ',f1,t1Note);
          var p1b=sellFrac2(execD,'SPY',f1,t1Note);
          buyWith(execD,'TQQQ',p1a+p1b,t1Note);
        }
        state=IN_TQQQ;entryATH=qqqATH;entryTQQQPx=tqqqC;trailHigh=tqqqC;
        deleverFired={};fullExitFired=false;scalePhase=1;t1QQQPx=qqqC;confirmCt=0;
      }

      // Re-entry: signal fires while holding QQQ/SPY from de-lever
      if(confirmed&&reEntryOn&&state===IN_TQQQ&&(sharesQQQ>0.001||sharesSPY>0.001)){
        var reNote='RE-ENTRY: QQQ DD='+(dd*100).toFixed(1)+'% VIX='+(vixC||0).toFixed(0);
        var rp1=sellAll(execD,'QQQ',reNote);
        var rp2=sellAll(execD,'SPY',reNote);
        if(rp1+rp2>1)buyWith(execD,'TQQQ',rp1+rp2,reNote+' → 100% TQQQ');
        entryATH=qqqATH;entryTQQQPx=tqqqC;trailHigh=tqqqC;
        deleverFired={};fullExitFired=false;scalePhase=1;t1QQQPx=qqqC;confirmCt=0;
      }

      // T2
      if(state===IN_TQQQ&&scalePhase===1&&t2Pct>0.001&&t1QQQPx){
        if((qqqC-t1QQQPx)/t1QQQPx<=-t2DD){
          var t2Note='T2 ('+Math.round(t2Pct*100)+'%): QQQ '+(((qqqC-t1QQQPx)/t1QQQPx)*100).toFixed(1)+'% from T1';
          var uv2=sharesQQQ*qqqC+sharesSPY*spyC;
          if(uv2>0){
            var f2=Math.min(1,(portVal()*t2Pct)/uv2);
            var p2a=sellFrac2(execD,'QQQ',f2,t2Note);
            var p2b=sellFrac2(execD,'SPY',f2,t2Note);
            buyWith(execD,'TQQQ',p2a+p2b,t2Note);
          }
          scalePhase=2;t2QQQPx=qqqC;
        }
      }

      // T3
      if(state===IN_TQQQ&&scalePhase===2&&t3Pct>0.001&&t2QQQPx){
        if((qqqC-t2QQQPx)/t2QQQPx<=-t3DD){
          var t3Note='T3 ('+Math.round(t3Pct*100)+'%): QQQ '+(((qqqC-t2QQQPx)/t2QQQPx)*100).toFixed(1)+'% from T2';
          var p3a=sellAll(execD,'QQQ',t3Note);
          var p3b=sellAll(execD,'SPY',t3Note);
          if(p3a+p3b>1)buyWith(execD,'TQQQ',p3a+p3b,t3Note);
          scalePhase=3;
        }
      }

      // ══ ③ ATH DE-LEVER (only when VIX < gate) ════════════════
      if(state===IN_TQQQ&&entryATH&&entryATH>0&&sharesTQQQ>0.001){
        // VIX gate: skip de-lever if market still fearful
        var vixOK=vixGate<=0||(vixC!=null&&vixC<vixGate);
        var aboveATH=(qqqC-entryATH)/entryATH;

        // Full-exit ceiling (ignores VIX gate — it's a hard cap)
        if(fullExitPct>0&&aboveATH>=fullExitPct&&!fullExitFired){
          fullExitFired=true;
          shiftTQQQtoUnlev(execD,1.0,'FULL EXIT: QQQ +'+(aboveATH*100).toFixed(1)+'% above ATH');
          resetLevState();
        } else if(vixOK){
          // Stepwise de-lever
          var steps=aboveATH>0?Math.floor(aboveATH/deleverStep):0;
          for(var step=1;step<=steps;step++){
            if(deleverFired[step])continue;
            deleverFired[step]=true;
            shiftTQQQtoUnlev(execD,deleverPct,
              'DE-LEVER step '+step+' [VIX='+(vixC||0).toFixed(0)+'<'+vixGate+']: QQQ +'
              +(aboveATH*100).toFixed(1)+'% above ATH → sell '+(deleverPct*100).toFixed(0)+'% TQQQ');
          }
        } else if(!vixOK&&aboveATH>0){
          // VIX too high — pause de-lever, log it once per new step
        }

        if(sharesTQQQ<0.0001)resetLevState();
      }

      // Mark-to-market
      var pv=portVal();
      equityCurve.push(pv);
      benchCurve.push(benchShares?benchShares*(lastPx[benchTicker]||0):capital);
      var pvS=pv>0?pv:1;
      expTQQQ.push(parseFloat((sharesTQQQ*tqqqC/pvS*100).toFixed(1)));
      expUnlev.push(parseFloat(((sharesQQQ*qqqC+sharesSPY*spyC)/pvS*100).toFixed(1)));
    }

    var stats=btStats(equityCurve,benchCurve,capital);

    btRenderKPI([
      {label:'Total Return',  value:stats.totalReturn+'%', color:parseFloat(stats.totalReturn)>=0?C.success:C.danger},
      {label:'CAGR',          value:stats.cagr+'%',        color:parseFloat(stats.cagr)>=0?C.success:C.danger},
      {label:'Max Drawdown',  value:stats.maxDD+'%',       color:C.danger},
      {label:'Sharpe',        value:stats.sharpe,          color:parseFloat(stats.sharpe)>=1?C.success:'#8B6914'},
      {label:'Sortino',       value:stats.sortino,         color:parseFloat(stats.sortino)>=1.5?C.success:'#8B6914'},
      {label:'Calmar',        value:stats.calmar,          color:parseFloat(stats.calmar)>=0.5?C.success:'#8B6914'},
      {label:'vs. '+benchTicker, value:(parseFloat(stats.alpha)>=0?'+':'')+stats.alpha+'%',
        color:parseFloat(stats.alpha)>=0?C.success:C.danger, sub:benchTicker+' B&H: '+stats.benchReturn+'%'},
      {label:'Win Rate',      value:stats.winRate+'%',     color:parseFloat(stats.winRate)>=55?C.success:'#8B6914'},
      {label:'Period',        value:stats.years+' yrs',    color:C.navy},
      {label:'Trades',        value:tradeLog.length,       color:C.navy},
    ]);

    btRenderCharts(simDates,equityCurve,benchCurve,{
      datasets:[
        {label:'TQQQ',    data:expTQQQ,  borderColor:C.danger, backgroundColor:'rgba(139,42,42,0.22)',borderWidth:1.5,fill:true,pointRadius:0,tension:0.1},
        {label:'QQQ+SPY', data:expUnlev, borderColor:C.navy,   backgroundColor:'rgba(0,60,113,0.14)', borderWidth:1.5,fill:true,pointRadius:0,tension:0.1},
      ]
    },'LVM',benchTicker);

    btRenderTradeLog(tradeLog);

    status.textContent='Complete — '+tradeLog.length+' trades · '+simDates[0]+' → '+simDates[simDates.length-1]
      +' | ATH warm-up: $'+qqqATH.toFixed(2)+' ('+warmCt+' days)'
      +' | Entry: -'+(ddThresh*100).toFixed(0)+'% & VIX≥'+vixEntry
      +(trailStop>0?' | Trail: -'+(trailStop*100).toFixed(0)+'%':'')
      +(vixGate>0?' | VIX gate: <'+vixGate:'');

  }catch(e){status.textContent='Error: '+e.message;console.error('[btRunLVM]',e);}
  btn.disabled=false;
}

// ── STRATEGY 2: Systematic DCA ─────────────────────────────────────────────
async function btRunDCA() {
  var status = document.getElementById('btRunStatus');
  var btn = document.getElementById('btRunBtn');
  btn.disabled = true; status.textContent = 'Fetching data…';
  try {
    var ticker    = (document.getElementById('bt_dca_ticker')?.value||'SPY').toUpperCase();
    var amount    = parseFloat(document.getElementById('bt_dca_amount')?.value)||1000;
    var freq      = document.getElementById('bt_dca_freq')?.value||'monthly';
    var period    = document.getElementById('bt_period')?.value||'5y';
    var benchT    = document.getElementById('bt_benchmark')?.value||'SPY';
    var vixBoost  = document.getElementById('bt_dca_vix_boost')?.checked||false;

    var seriesMap = {};
    seriesMap[ticker] = await btFetchPrices(ticker, period);
    if (benchT !== ticker) seriesMap[benchT] = await btFetchPrices(benchT, period);
    if (vixBoost) { try { seriesMap['^VIX'] = await btFetchPrices('^VIX', period); } catch(e){} }

    var pts = seriesMap[ticker];
    var priceMap = {}; pts.forEach(function(p){priceMap[p.date]={open:p.open||p.close,close:p.close};});
    var benchMap = {}; (seriesMap[benchT]||pts).forEach(function(p){benchMap[p.date]={close:p.close};});
    var vixMap2 = {}; (seriesMap['^VIX']||[]).forEach(function(p){vixMap2[p.date]=p.close;});

    var dates = pts.map(function(p){return p.date;});
    var capital = 0, shares = 0, totalInvested = 0;
    var equityCurve = [], benchCurve = [], benchShares = null, benchInvested = 0;
    var tradeLog = [], daysSinceLast = 0;
    var freqDays = freq==='weekly'?5:freq==='quarterly'?63:21;

    dates.forEach(function(d, di) {
      var px = priceMap[d]?.close;
      if (!px) return;
      daysSinceLast++;
      var invest = 0;
      if (daysSinceLast >= freqDays) {
        daysSinceLast = 0;
        invest = amount;
        if (vixBoost && vixMap2[d] && vixMap2[d] > 30) invest *= 2;
        var execPx = priceMap[d]?.open || px;
        shares += invest / execPx;
        capital += invest; totalInvested += invest;
        tradeLog.push({ date: d, action: 'BUY', ticker: ticker,
          shares: invest/execPx, price: execPx, value: invest, portfolio: shares*px,
          notes: 'Periodic DCA' + (invest>amount?' (VIX boost)':'') });
        // Benchmark: same cadence, lump sum simulation
        if (benchShares === null) { benchInvested += invest; benchShares = invest / (benchMap[d]?.close||px); }
        else { benchInvested += invest; benchShares += invest / (benchMap[d]?.close||px); }
      }
      equityCurve.push(shares * px);
      benchCurve.push((benchShares||0) * (benchMap[d]?.close||px));
    });

    var stats = btStats(equityCurve, benchCurve, totalInvested);
    var finalVal = equityCurve[equityCurve.length-1]||0;
    var gain = finalVal - totalInvested;
    btRenderKPI([
      { label: 'Final Value',    value: '$'+(finalVal/1e3).toFixed(1)+'K', color: C.navy },
      { label: 'Total Invested', value: '$'+(totalInvested/1e3).toFixed(1)+'K', color: C.textSec },
      { label: 'Total Gain',     value: '$'+(gain/1e3).toFixed(1)+'K', color: gain>=0?C.success:C.danger },
      { label: 'CAGR',           value: stats.cagr+'%', color: parseFloat(stats.cagr)>=0?C.success:C.danger },
      { label: 'Max Drawdown',   value: stats.maxDD+'%', color: C.danger },
      { label: 'Sharpe',         value: stats.sharpe, color: parseFloat(stats.sharpe)>=1?C.success:'#8B6914' },
      { label: 'vs. '+benchT,   value: (parseFloat(stats.alpha)>=0?'+':'')+stats.alpha+'%', color: parseFloat(stats.alpha)>=0?C.success:C.danger },
      { label: 'Purchases',      value: tradeLog.length, color: C.navy },
    ]);
    btRenderCharts(dates, equityCurve, benchCurve, {}, 'DCA Strategy', benchT);
    btRenderTradeLog(tradeLog);
    status.textContent = 'DCA backtest complete.';
  } catch(e) { status.textContent = 'Error: '+e.message; }
  btn.disabled = false;
}

// ── STRATEGY 3: Dual Momentum ─────────────────────────────────────────────
async function btRunMomentum() {
  var status = document.getElementById('btRunStatus');
  var btn = document.getElementById('btRunBtn');
  btn.disabled = true; status.textContent = 'Fetching data…';
  try {
    var lookback  = parseInt(document.getElementById('bt_mom_lookback')?.value||12) * 21;
    var riskOff   = document.getElementById('bt_mom_riskoff')?.value||'AGG';
    var capital   = parseFloat(document.getElementById('bt_capital')?.value)||100000;
    var period    = document.getElementById('bt_period')?.value||'5y';
    var benchT    = document.getElementById('bt_benchmark')?.value||'SPY';

    var tickers = ['SPY','QQQ',riskOff,benchT].filter(function(t,i,a){return a.indexOf(t)===i;});
    var seriesMap = {};
    for (var ti=0;ti<tickers.length;ti++) {
      try { seriesMap[tickers[ti]] = await btFetchPrices(tickers[ti],period); } catch(e){ seriesMap[tickers[ti]]=[]; }
      status.textContent = 'Fetching '+tickers[ti]+'…';
    }
    var pm = {};
    tickers.forEach(function(t){ pm[t]={}; (seriesMap[t]||[]).forEach(function(p){pm[t][p.date]={open:p.open||p.close,close:p.close};}); });

    var dates = (seriesMap.SPY||[]).map(function(p){return p.date;});
    var portfolio = capital, shares = 0, currentHolding = null;
    var equityCurve = [], benchCurve = [], tradeLog = [];
    var lastRebalance = -21;
    var benchShares2 = capital / (pm[benchT][dates[0]]?.close||1);

    dates.forEach(function(d, di) {
      var spyPx = pm.SPY[d]?.close, qqqPx = pm.QQQ[d]?.close;
      if (!spyPx) return;

      // Monthly rebalance
      if (di - lastRebalance >= 21 && di >= lookback) {
        lastRebalance = di;
        var pastDate = dates[di - lookback];
        var spy12m = pm.SPY[pastDate]?.close;
        var qqq12m = pm.QQQ[pastDate]?.close;
        var riskOff12m = pm[riskOff][pastDate]?.close;
        var spyRet  = spy12m  ? spyPx/spy12m-1  : 0;
        var qqqRet  = qqqPx && qqq12m ? qqqPx/qqq12m-1 : 0;
        var target;
        if (spyRet > 0 || qqqRet > 0) {
          target = qqqRet > spyRet ? 'QQQ' : 'SPY';
        } else {
          target = riskOff;
        }
        if (target !== currentHolding) {
          var execD = di+1<dates.length?dates[di+1]:d;
          var execPx = pm[target][execD]?.open || pm[target][d]?.close || 1;
          var val = shares * (pm[currentHolding||target][execD]?.open || 1);
          if (currentHolding) {
            val = shares * (pm[currentHolding][execD]?.open || pm[currentHolding][d]?.close || 1);
            tradeLog.push({ date: execD, action: 'SELL', ticker: currentHolding, shares: shares, price: pm[currentHolding][execD]?.open, value: val, portfolio: val, notes: 'Momentum rebalance' });
          } else { val = capital; }
          shares = val / execPx;
          currentHolding = target;
          tradeLog.push({ date: execD, action: 'BUY', ticker: target, shares: shares, price: execPx, value: val, portfolio: val, notes: 'Momentum: SPY='+( spyRet*100).toFixed(1)+'% QQQ='+(qqqRet*100).toFixed(1)+'%' });
        }
      }
      var px = pm[currentHolding||'SPY'][d]?.close || spyPx;
      equityCurve.push(shares > 0 ? shares * px : capital);
      benchCurve.push(benchShares2 * (pm[benchT][d]?.close||spyPx));
    });

    var stats = btStats(equityCurve, benchCurve, capital);
    btRenderKPI([
      { label:'Total Return',  value:stats.totalReturn+'%', color:parseFloat(stats.totalReturn)>=0?C.success:C.danger },
      { label:'CAGR',          value:stats.cagr+'%', color:parseFloat(stats.cagr)>=0?C.success:C.danger },
      { label:'Max Drawdown',  value:stats.maxDD+'%', color:C.danger },
      { label:'Sharpe',        value:stats.sharpe, color:parseFloat(stats.sharpe)>=1?C.success:'#8B6914' },
      { label:'vs. '+benchT,  value:(parseFloat(stats.alpha)>=0?'+':'')+stats.alpha+'%', color:parseFloat(stats.alpha)>=0?C.success:C.danger },
      { label:'Rebalances',    value:tradeLog.filter(function(t){return t.action==='BUY';}).length, color:C.navy },
    ]);
    btRenderCharts(dates, equityCurve, benchCurve, {}, 'Dual Momentum', benchT);
    btRenderTradeLog(tradeLog);
    status.textContent = 'Dual Momentum backtest complete.';
  } catch(e) { status.textContent = 'Error: '+e.message; }
  btn.disabled = false;
}

// ── STRATEGY 4: Custom ────────────────────────────────────────────────────
async function btRunCustom() {
  var status = document.getElementById('btRunStatus');
  var btn = document.getElementById('btRunBtn');
  btn.disabled = true; status.textContent = 'Fetching data…';
  try {
    var ticker  = (document.getElementById('bt_cust_ticker')?.value||'SPY').toUpperCase();
    var capital = parseFloat(document.getElementById('bt_capital')?.value)||100000;
    var period  = document.getElementById('bt_period')?.value||'5y';
    var benchT  = document.getElementById('bt_benchmark')?.value||'SPY';
    var entry   = document.getElementById('bt_cust_entry')?.value||'ma_cross_up';
    var exit    = document.getElementById('bt_cust_exit')?.value||'ma_cross_down';

    var pts = await btFetchPrices(ticker, period);
    var benchPts = benchT !== ticker ? await btFetchPrices(benchT, period) : pts;
    var bm = {}; benchPts.forEach(function(p){bm[p.date]=p.close;});
    var closes = pts.map(function(p){return p.close;});
    var dates  = pts.map(function(p){return p.date;});

    // Pre-compute indicators
    function sma(n, i) { if(i<n-1)return null; var s=0;for(var k=i-n+1;k<=i;k++)s+=closes[k];return s/n; }
    function rsi(n, i) {
      if(i<n)return null;
      var g=0,l=0;
      for(var k=i-n+1;k<=i;k++){var d=closes[k]-closes[k-1];if(d>0)g+=d;else l-=d;}
      var rs=l===0?100:g/l;return 100-100/(1+rs);
    }
    var ath2 = -Infinity;

    var portfolio = capital, shares = 0, inPos = false;
    var equityCurve = [], benchCurve = [], tradeLog = [];
    var benchShares3 = capital / (bm[dates[0]]||closes[0]);

    for (var i=0; i<dates.length; i++) {
      var d = dates[i]; var px = closes[i];
      if (!px) continue;
      ath2 = Math.max(ath2, px);
      var ma50 = sma(50,i), ma200 = sma(200,i);
      var rsi14 = rsi(14,i);
      var dd2 = (px-ath2)/ath2;
      var prevPx = closes[i-1]||px;
      var prevMa50 = i>=1?sma(50,i-1):null;
      var prevMa200= i>=1?sma(200,i-1):null;
      var prevRsi  = i>=1?rsi(14,i-1):null;

      var shouldEnter = false, shouldExit = false;
      if (!inPos) {
        if (entry==='ma_cross_up'    && ma50!=null  && prevMa50!=null  && prevPx<=prevMa50  && px>ma50)  shouldEnter=true;
        if (entry==='ma200_cross_up' && ma200!=null && prevMa200!=null && prevPx<=prevMa200 && px>ma200) shouldEnter=true;
        if (entry==='rsi_oversold'   && rsi14!=null && prevRsi!=null   && prevRsi<=30       && rsi14>30) shouldEnter=true;
        if (entry==='dd_entry'       && dd2<=-0.15) shouldEnter=true;
      } else {
        if (exit==='ma_cross_down'    && ma50!=null  && prevMa50!=null  && prevPx>=prevMa50  && px<ma50)  shouldExit=true;
        if (exit==='ma200_cross_down' && ma200!=null && prevMa200!=null && prevPx>=prevMa200 && px<ma200) shouldExit=true;
        if (exit==='rsi_overbought'   && rsi14!=null && prevRsi!=null   && prevRsi<=70       && rsi14>70) shouldExit=true;
        if (exit==='dd_exit'          && px>=ath2) shouldExit=true;
      }
      if (shouldEnter) {
        shares = portfolio / px; inPos = true;
        tradeLog.push({ date:d, action:'BUY', ticker:ticker, shares:shares, price:px, value:portfolio, portfolio:portfolio, notes: entry });
      }
      if (shouldExit && inPos) {
        portfolio = shares * px; shares = 0; inPos = false;
        tradeLog.push({ date:d, action:'SELL', ticker:ticker, shares:shares+portfolio/px, price:px, value:portfolio, portfolio:portfolio, notes: exit });
      }
      equityCurve.push(inPos ? shares*px : portfolio);
      benchCurve.push(benchShares3*(bm[d]||px));
    }

    var stats = btStats(equityCurve, benchCurve, capital);
    btRenderKPI([
      { label:'Total Return', value:stats.totalReturn+'%', color:parseFloat(stats.totalReturn)>=0?C.success:C.danger },
      { label:'CAGR',         value:stats.cagr+'%', color:parseFloat(stats.cagr)>=0?C.success:C.danger },
      { label:'Max DD',       value:stats.maxDD+'%', color:C.danger },
      { label:'Sharpe',       value:stats.sharpe, color:parseFloat(stats.sharpe)>=1?C.success:'#8B6914' },
      { label:'vs. '+benchT, value:(parseFloat(stats.alpha)>=0?'+':'')+stats.alpha+'%', color:parseFloat(stats.alpha)>=0?C.success:C.danger },
      { label:'Trades',       value:tradeLog.length, color:C.navy },
    ]);
    btRenderCharts(dates, equityCurve, benchCurve, {}, ticker+' Custom', benchT);
    btRenderTradeLog(tradeLog);
    status.textContent = 'Custom strategy backtest complete.';
  } catch(e) { status.textContent = 'Error: '+e.message; }
  btn.disabled = false;
}

// ── Main run dispatcher ─────────────────────────────────────────────────────
function btRun() {
  var id = BT_STATE.strategyId;
  if (!id) return;
  var strat = BT_STRATEGIES[id];
  if (strat && strat.run) strat.run();
}

// Auto-load LVM strategy on page entry
function btPageInit() {
  btLoadStrategy('lvm');
}

// ═══════════ END BACKTESTING ENGINE ═══════════

