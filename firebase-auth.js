  import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
  import {
    getAuth, signInWithPopup, signOut, GoogleAuthProvider, onAuthStateChanged
  } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
  import {
    getFirestore, collection, addDoc, getDocs, deleteDoc, doc,
    query, where, orderBy, serverTimestamp, updateDoc,
    setDoc, getDoc
  } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

  // ── Firebase Config ──
  const firebaseConfig = {
    apiKey: "AIzaSyA4_lv0YrI3haIhfKRVIRqgPAYBWbo7hfI",
    authDomain: "perry-asset-management-w-aa049.firebaseapp.com",
    projectId: "perry-asset-management-w-aa049",
    storageBucket: "perry-asset-management-w-aa049.firebasestorage.app",
    messagingSenderId: "346583395966",
    appId: "1:346583395966:web:63ce7775adf5f3d876b22f",
    measurementId: "G-EJXQWCKNBD"
  };

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const provider = new GoogleAuthProvider();

  // Status indicator
  document.getElementById("firebase-status-dot").classList.replace("red", "green");
  document.getElementById("firebase-status-text").textContent = "Firebase: Connected";

  // ── Auth ──
  window.handleLogin = async function() {
    try {
      await signInWithPopup(auth, provider);
    } catch(e) {
      console.error(e);
      alert("Login failed: " + e.message);
    }
  };

  window.handleLogout = async function() {
    await signOut(auth);
  };

  onAuthStateChanged(auth, (user) => {
    window._currentUser = user;
    if (user) {
      document.getElementById('userBadge').textContent = user.email;
      document.getElementById('loginBtn').style.display = 'none';
      document.getElementById('logoutBtn').style.display = '';
      document.querySelectorAll('.auth-gate').forEach(el => el.style.display = 'none');
      document.getElementById('holdingsPanel').style.display = '';
      loadHoldings();
    } else {
      document.getElementById('userBadge').textContent = '';
      document.getElementById('loginBtn').style.display = '';
      document.getElementById('logoutBtn').style.display = 'none';
      document.querySelectorAll('.auth-gate').forEach(el => el.style.display = '');
      document.getElementById('holdingsPanel').style.display = 'none';
      document.getElementById('portfolioLive').style.display = 'none';
      document.getElementById('portfolioEmpty').style.display = 'none';
      window._holdings = [];
    }
  });

  // ── Add Holding (with duplicate detection) ──
  window.addHolding = async function() {
    const user = window._currentUser;
    if (!user) { alert("Sign in first."); return; }

    const ticker = document.getElementById('inputTicker').value.trim().toUpperCase();
    const date = document.getElementById('inputDate').value;
    const qty = parseFloat(document.getElementById('inputQty').value);
    const cost = parseFloat(document.getElementById('inputCost').value);
    const acctType = document.getElementById('inputAccountType').value;

    if (!ticker) { showStatus('addStatus', 'Enter a ticker.', 'error'); return; }
    if (!date) { showStatus('addStatus', 'Select date.', 'error'); return; }
    if (!qty || qty <= 0) { showStatus('addStatus', 'Enter valid quantity.', 'error'); return; }
    if (isNaN(cost) || cost < 0) { showStatus('addStatus', 'Enter cost/share.', 'error'); return; }

    // Check for duplicate: same ticker + same account type
    const existing = (window._holdings || []).find(
      h => h.ticker === ticker && (h.accountType || 'Individual') === acctType
    );

    if (existing) {
      const yes = confirm(
        'You already hold ' + ticker + ' in your ' + acctType + ' account (' +
        existing.quantity + ' shares at $' + existing.costBasis.toFixed(2) + '/share).\n\n' +
        'Merge? This will add ' + qty + ' shares and update to a weighted average cost basis.\n\n' +
        'Click OK to merge, or Cancel to abort.'
      );
      if (!yes) return;

      // Merge: weighted average cost basis
      const totalShares = existing.quantity + qty;
      const waCost = ((existing.costBasis * existing.quantity) + (cost * qty)) / totalShares;
      const btn = document.getElementById('addBtn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Merging...';
      try {
        await updateDoc(doc(db, "holdings", existing.id), {
          quantity: totalShares,
          costBasis: Math.round(waCost * 100) / 100,
          datePurchased: date,
          lastUpdated: new Date().toISOString()
        });
        showStatus('addStatus',
          '&#10003; Merged into existing ' + ticker + ' (' + totalShares +
          ' shares, avg cost $' + waCost.toFixed(2) + ')', 'success');
        document.getElementById('inputTicker').value = '';
        document.getElementById('inputDate').value = '';
        document.getElementById('inputQty').value = '';
        document.getElementById('inputCost').value = '';
        await loadHoldings();
      } catch(e) {
        showStatus('addStatus', 'Error: ' + e.message, 'error');
      }
      btn.disabled = false;
      btn.textContent = 'Add Holding';
      return;
    }

    // New holding
    const btn = document.getElementById('addBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Adding...';
    showStatus('addStatus', '<span class="spinner"></span> Fetching quote & saving...', 'info');

    try {
      const q = await fetchQuote(ticker);
      var meta = classifyHolding(ticker, q);

      // If sector is "Other", try SEC API for better classification
      if (meta.sector === 'Other' || meta.industry === 'Other') {
        try {
          var secProfile = await fetch(WORKER_URL + "/fundamentals?symbol=" + encodeURIComponent(ticker));
          var secData = await secProfile.json();
          if (secData.profile) {
            if (secData.profile.sector) meta.sector = secData.profile.sector;
            if (secData.profile.industry) meta.industry = secData.profile.industry;
            if (secData.profile.type === 'ETF') meta.assetClass = 'ETF';
            if (secData.profile.type === 'FUND') meta.assetClass = 'Mutual Fund';
            if (secData.profile.marketCap) meta.marketCap = secData.profile.marketCap;
          }
        } catch(se) { /* SEC lookup failed, use fallback */ }
      }
      await addDoc(collection(db, "holdings"), {
        uid: user.uid,
        ticker: ticker,
        companyName: q.name || ticker,
        datePurchased: date,
        quantity: qty,
        costBasis: cost,
        currentPrice: q.price || 0,
        previousClose: q.previousClose || 0,
        sector: meta.sector,
        industry: meta.industry,
        assetClass: meta.assetClass,
        marketCap: meta.marketCap,
        mktCapCategory: meta.mktCapCategory,
        leverage: meta.leverage || '',
        accountType: acctType,
        lastUpdated: new Date().toISOString(),
        createdAt: serverTimestamp()
      });
      showStatus('addStatus', '&#10003; Added ' + ticker + ' to ' + acctType, 'success');
      document.getElementById('inputTicker').value = '';
      document.getElementById('inputDate').value = '';
      document.getElementById('inputQty').value = '';
      document.getElementById('inputCost').value = '';
      await loadHoldings();
    } catch(e) {
      showStatus('addStatus', 'Error: ' + e.message, 'error');
    }
    btn.disabled = false;
    btn.textContent = 'Add Holding';
  };

  // ── Load Holdings ──
  window.loadHoldings = async function() {
    const user = window._currentUser;
    if (!user) return;
    try {
      const q = query(
        collection(db, "holdings"),
        where("uid", "==", user.uid),
        orderBy("createdAt", "desc")
      );
      const snap = await getDocs(q);
      const h = [];
      snap.forEach(d => h.push({ id: d.id, ...d.data() }));
      window._holdings = h;
      renderHoldingsTable(h);
      document.getElementById('holdingsCount').textContent =
        h.length ? '(' + h.length + ' positions)' : '';
    } catch(e) {
      console.error(e);
      showStatus('holdingsStatus', 'Error: ' + e.message, 'error');
    }
  };

  // ── Delete Holding ──
  window.deleteHolding = async function(docId) {
    if (!confirm('Remove this entire holding?')) return;
    try {
      await deleteDoc(doc(db, "holdings", docId));
      await loadHoldings();
    } catch(e) {
      alert(e.message);
    }
  };

  // ── Update Holding Doc ──
  window.updateHoldingDoc = async function(docId, data) {
    try {
      await updateDoc(doc(db, "holdings", docId), data);
    } catch(e) {
      console.error(e);
    }
  };

  // ── Sell Shares (partial or full) ──
  window.sellShares = async function(docId) {
    const h = (window._holdings || []).find(x => x.id === docId);
    if (!h) return;

    const m = document.createElement('div');
    m.className = 'modal-overlay';
    m.innerHTML =
      '<div class="modal-box">' +
        '<h3>Sell Shares of ' + h.ticker + '</h3>' +
        '<p style="font-size:12px;color:#5A6A7A;margin-bottom:12px;">' +
          'Current: ' + h.quantity + ' shares in ' + (h.accountType || 'Individual') +
          ' at $' + (h.currentPrice || 0).toFixed(2) +
        '</p>' +
        '<div class="form-group" style="margin-bottom:12px;">' +
          '<label>Shares to Sell</label>' +
          '<input type="number" id="sellQtyInput" placeholder="e.g. 10" ' +
            'min="0.0001" max="' + h.quantity + '" step="any" style="width:100%;">' +
        '</div>' +
        '<div class="modal-actions">' +
          '<button class="btn" onclick="confirmSell(\'' + docId + '\',' + h.quantity + ')">Confirm Sale</button>' +
          '<button class="btn-outline" onclick="this.closest(\'.modal-overlay\').remove()">Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);
  };

  window.confirmSell = async function(docId, curQty) {
    const sq = parseFloat(document.getElementById('sellQtyInput').value);
    if (!sq || sq <= 0) { alert('Enter shares to sell.'); return; }
    if (sq > curQty + 0.0001) { alert('Cannot sell more than you own (' + curQty + ').'); return; }
    document.querySelector('.modal-overlay').remove();

    if (Math.abs(sq - curQty) < 0.0001) {
      // Selling all = delete
      if (confirm('Selling all shares removes this holding. Continue?')) {
        await deleteHolding(docId);
      }
    } else {
      // Partial sell
      try {
        await updateHoldingDoc(docId, {
          quantity: Math.round((curQty - sq) * 10000) / 10000,
          lastUpdated: new Date().toISOString()
        });
        showStatus('holdingsStatus',
          '&#10003; Sold ' + sq + ' shares. Remaining: ' + (curQty - sq).toFixed(4),
          'success');
        await loadHoldings();
      } catch(e) {
        alert(e.message);
      }
    }
  };

  // ── Edit Holding (modal with all editable fields + versioning) ──
  window.editHolding = async function(docId) {
    const h = (window._holdings || []).find(x => x.id === docId);
    if (!h) return;
    const isCash = h.assetClass === 'Cash' || h.assetClass === 'Money Market' || h.assetClass === 'CD' || h.assetClass === 'Bond Position';
    const m = document.createElement('div');
    m.className = 'modal-overlay';
    m.innerHTML =
      '<div class="modal-box" style="max-width:520px;">' +
        '<h3>Edit: ' + h.ticker + ' — ' + h.companyName + '</h3>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0;">' +
          '<div class="form-group"><label>Shares</label><input type="number" id="editQty" value="' + h.quantity + '" step="any" ' + (isCash ? 'disabled' : '') + '></div>' +
          '<div class="form-group"><label>Cost Basis/Share</label><input type="number" id="editCost" value="' + h.costBasis + '" step="0.01"></div>' +
          '<div class="form-group"><label>Yield %</label><input type="number" id="editYield" value="' + (h.yieldPct || '') + '" step="0.01" placeholder="0.00"></div>' +
          '<div class="form-group"><label>Account Type</label>' +
            '<select id="editAcct">' +
              ['Individual','Roth IRA','Traditional IRA','401(k)','Roth 401(k)','BrokerageLink 401(k)','BrokerageLink Roth IRA','SEP IRA','529 Plan','HSA','Trust','Custodial','Joint','Designated Beneficiary'].map(function(a) {
                return '<option value="' + a + '"' + ((h.accountType || 'Individual') === a ? ' selected' : '') + '>' + a + '</option>';
              }).join('') +
            '</select></div>' +
          '<div class="form-group"><label>Sector</label><input type="text" id="editSector" value="' + (h.sector || '') + '"></div>' +
          '<div class="form-group"><label>Industry</label><input type="text" id="editIndustry" value="' + (h.industry || '') + '"></div>' +
          '<div class="form-group"><label>Asset Type</label><input type="text" id="editAsset" value="' + (h.assetClass || '') + '"></div>' +
          '<div class="form-group"><label>Date Purchased</label><input type="date" id="editDate" value="' + (h.datePurchased || '') + '"></div>' +
        '</div>' +
        '<div class="modal-actions">' +
          '<button class="btn" onclick="submitEdit(\'' + docId + '\')">Save Changes</button>' +
          '<button class="btn-outline" onclick="this.closest(\'.modal-overlay\').remove()">Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);
  };

  window.submitEdit = async function(docId) {
    const h = (window._holdings || []).find(x => x.id === docId);
    if (!h) return;
    // Save previous version for undo
    const prev = { quantity: h.quantity, costBasis: h.costBasis, yieldPct: h.yieldPct || null, accountType: h.accountType, sector: h.sector, industry: h.industry, assetClass: h.assetClass, datePurchased: h.datePurchased };
    const updates = {
      quantity: parseFloat(document.getElementById('editQty').value) || h.quantity,
      costBasis: parseFloat(document.getElementById('editCost').value) || h.costBasis,
      yieldPct: parseFloat(document.getElementById('editYield').value) || null,
      accountType: document.getElementById('editAcct').value,
      sector: document.getElementById('editSector').value || h.sector,
      industry: document.getElementById('editIndustry').value || h.industry,
      assetClass: document.getElementById('editAsset').value || h.assetClass,
      datePurchased: document.getElementById('editDate').value || h.datePurchased,
      previousVersion: JSON.stringify(prev),
      lastEdited: new Date().toISOString(),
      lastUpdated: new Date().toISOString()
    };
    try {
      await updateDoc(doc(db, "holdings", docId), updates);
      document.querySelector('.modal-overlay')?.remove();
      showStatus('holdingsStatus', '&#10003; Updated ' + h.ticker, 'success');
      await loadHoldings();
    } catch(e) { alert(e.message); }
  };

  window.undoEdit = async function(docId) {
    const h = (window._holdings || []).find(x => x.id === docId);
    if (!h || !h.previousVersion) return;
    if (!confirm('Undo last edit to ' + h.ticker + '?')) return;
    try {
      const prev = JSON.parse(h.previousVersion);
      prev.previousVersion = null;
      prev.lastEdited = null;
      prev.lastUpdated = new Date().toISOString();
      await updateDoc(doc(db, "holdings", docId), prev);
      showStatus('holdingsStatus', '&#10003; Reverted ' + h.ticker + ' to previous state', 'success');
      await loadHoldings();
    } catch(e) { alert(e.message); }
  };

  // ── Add Cash Position ──
  window.addCashPosition = async function() {
    const user = window._currentUser;
    if (!user) { alert("Sign in first."); return; }
    const name = document.getElementById('cashName').value.trim() || 'Cash';
    const amount = parseFloat(document.getElementById('cashAmount').value);
    const yieldPct = parseFloat(document.getElementById('cashYield').value) || null;
    const acctType = document.getElementById('cashAccountType').value;
    if (!amount || amount <= 0) { showStatus('addStatus', 'Enter a cash amount.', 'error'); return; }
    var ticker = name.toUpperCase().replace(/\s+/g, '_');
    if (['SPAXX','FDRXX','FZFXX','SPRXX','VMFXX','SWVXX','TTTXX'].indexOf(ticker) >= 0) ticker = ticker; // known money market tickers
    else if (name.toLowerCase().includes('cash')) ticker = 'CASH';
    else if (name.toLowerCase().includes('cd')) ticker = 'CD';
    else if (name.toLowerCase().includes('bond')) ticker = 'BOND';

    var assetClass = 'Cash';
    if (['SPAXX','FDRXX','FZFXX','SPRXX','VMFXX','SWVXX','TTTXX'].indexOf(ticker) >= 0) assetClass = 'Money Market';
    else if (ticker === 'CD') assetClass = 'CD';
    else if (ticker === 'BOND') assetClass = 'Bond Position';

    try {
      await addDoc(collection(db, "holdings"), {
        uid: user.uid, ticker: ticker, companyName: name,
        datePurchased: new Date().toISOString().slice(0,10),
        quantity: 1, costBasis: amount, currentPrice: amount, previousClose: amount,
        sector: 'Cash', industry: 'Cash', assetClass: assetClass,
        marketCap: 0, mktCapCategory: '—', leverage: '',
        yieldPct: yieldPct, accountType: acctType,
        lastUpdated: new Date().toISOString(), createdAt: serverTimestamp()
      });
      showStatus('addStatus', '&#10003; Added ' + name + ' ($' + amount.toLocaleString() + ') to ' + acctType, 'success');
      document.getElementById('cashName').value = '';
      document.getElementById('cashAmount').value = '';
      document.getElementById('cashYield').value = '';
      await loadHoldings();
    } catch(e) { showStatus('addStatus', 'Error: ' + e.message, 'error'); }
  };

  // ── Refresh All Prices ──
  window.refreshAllPrices = async function() {
    const holdings = window._holdings || [];
    if (!holdings.length) return;
    const btn = document.getElementById('refreshBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Refreshing...';
    showStatus('holdingsStatus',
      '<span class="spinner"></span> Refreshing ' + holdings.length + ' holdings...', 'info');
    let n = 0;
    for (const h of holdings) {
      try {
        const q = await fetchQuote(h.ticker);
        const meta = classifyHolding(h.ticker, q);
        await updateHoldingDoc(h.id, {
          currentPrice: q.price || h.currentPrice,
          previousClose: q.previousClose || h.previousClose,
          companyName: q.name || h.companyName,
          sector: meta.sector,
          industry: meta.industry,
          assetClass: meta.assetClass,
          marketCap: meta.marketCap,
          mktCapCategory: meta.mktCapCategory,
          leverage: meta.leverage || '',
          lastUpdated: new Date().toISOString()
        });
        n++;
      } catch(e) {
        console.warn(h.ticker, e);
      }
    }
    showStatus('holdingsStatus', '&#10003; Refreshed ' + n + '/' + holdings.length, 'success');
    await loadHoldings();
    btn.disabled = false;
    btn.textContent = 'Refresh All Prices';
  };

  // ── Direct Add (for bulk import) ──
  window._addHoldingDirect = async function(ticker, name, date, qty, cost, price, prevClose, meta, acctType) {
    const user = window._currentUser;
    if (!user) throw new Error('Not signed in');
    await addDoc(collection(db, "holdings"), {
      uid: user.uid,
      ticker: ticker,
      companyName: name,
      datePurchased: date,
      quantity: qty,
      costBasis: cost,
      currentPrice: price,
      previousClose: prevClose,
      sector: meta.sector,
      industry: meta.industry,
      assetClass: meta.assetClass,
      marketCap: meta.marketCap,
      mktCapCategory: meta.mktCapCategory,
      leverage: meta.leverage || '',
      accountType: acctType || 'Individual',
      lastUpdated: new Date().toISOString(),
      createdAt: serverTimestamp()
    });
  };

  // ═══ SEC DATA CACHE (Firestore) ═══
  // Stores SEC financial data per ticker, refreshes if older than 24 hours
  const SEC_CACHE_HOURS = 24;

  window._getSecCache = async function(ticker) {
    try {
      const ref = doc(db, "sec_data", ticker.toUpperCase());
      const snap = await getDoc(ref);
      if (!snap.exists()) return null;
      const data = snap.data();
      // Check if stale (older than 24 hours)
      if (data.cachedAt) {
        const age = (Date.now() - new Date(data.cachedAt).getTime()) / (1000 * 60 * 60);
        if (age > SEC_CACHE_HOURS) return null; // stale
      }
      return data.secData || null;
    } catch (e) {
      console.warn("SEC cache read error:", e);
      return null;
    }
  };

  window._setSecCache = async function(ticker, secData) {
    try {
      const ref = doc(db, "sec_data", ticker.toUpperCase());
      await setDoc(ref, {
        ticker: ticker.toUpperCase(),
        secData: secData,
        cachedAt: new Date().toISOString(),
        profileName: secData.profile?.name || ticker,
        sector: secData.profile?.sector || '',
        industry: secData.profile?.industry || ''
      });
    } catch (e) {
      console.warn("SEC cache write error:", e);
    }
  };
