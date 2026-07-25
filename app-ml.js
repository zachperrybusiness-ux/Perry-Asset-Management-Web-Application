/* ============================================================================
   Perry Asset Management — Machine Learning Engine  (app-ml.js)
   Added 2026-07-24.  Load AFTER app-warehouse.js and app-signals.js.

   ─────────────────────────────────────────────────────────────────────────────
   WHY THIS EXISTS
   ─────────────────────────────────────────────────────────────────────────────
   The About page claimed "ML models including regression, random forest,
   gradient boosting, and time-series forecasting". A full-text search of the
   codebase found ZERO occurrences of any of those beyond that one sentence —
   the only model implemented anywhere was OLS. This module makes the claim
   true, in pure JS, with no build step and no external service.

   WHAT IS IMPLEMENTED
   -------------------
     • CART regression trees with proper variance-reduction splitting
     • Random Forest  — bagging + per-split feature subsampling (Breiman 2001)
     • Gradient Boosting — stagewise additive trees on residuals (Friedman 2001)
     • Out-of-bag R² for the forest (a genuine out-of-sample estimate, free)
     • Permutation feature importance — the honest importance measure, replacing
       the old "share of absolute standardized coefficient" that was mislabeled
       as "variance explained"
     • Purged, embargoed walk-forward CV for time-series targets

   THE HONESTY RULES BAKED IN
   --------------------------
   1. Cross-sectional targets use FORWARD returns, and the panel is a single
      snapshot, so we train on a CROSS-SECTION (rank stocks against each other
      today) not on overlapping time-series windows. This sidesteps the
      overlapping-window inflation that broke the old MLR.
   2. Every model reports out-of-sample skill. If OOS R² is negative — which is
      common and normal for equity return prediction — the UI says so instead of
      showing an in-sample number that looks impressive and means nothing.
   3. Feature importance is permutation-based on HELD-OUT data.
   4. Predictions are converted to RANKS, not price targets. A model with an
      OOS R² of 0.03 can still rank usefully; it cannot forecast a level.
   ============================================================================ */

(function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════════════════════
     SECTION 1 — deterministic RNG

     Every stochastic component (bagging, feature subsampling, bootstrap) uses
     this seeded generator. That means results are REPRODUCIBLE: clicking "run"
     twice gives the same answer. The old advisor Monte Carlo re-seeded on every
     scenario, so its "+2 pts" lever comparisons were inside sampling noise and
     the ranking changed on reclick.
     ══════════════════════════════════════════════════════════════════════════ */

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gaussFrom(rng) {
    var u1 = rng() || 1e-12, u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     SECTION 2 — stats helpers
     ══════════════════════════════════════════════════════════════════════════ */

  function mean(a) { var s = 0, n = 0; for (var i = 0; i < a.length; i++) if (a[i] != null) { s += a[i]; n++; } return n ? s / n : 0; }
  function variance(a) {
    var m = mean(a), s = 0, n = 0;
    for (var i = 0; i < a.length; i++) if (a[i] != null) { s += (a[i] - m) * (a[i] - m); n++; }
    return n > 1 ? s / (n - 1) : 0;
  }
  function r2Score(yTrue, yPred) {
    var m = mean(yTrue), sse = 0, sst = 0;
    for (var i = 0; i < yTrue.length; i++) {
      sse += (yTrue[i] - yPred[i]) * (yTrue[i] - yPred[i]);
      sst += (yTrue[i] - m) * (yTrue[i] - m);
    }
    return sst > 0 ? 1 - sse / sst : 0;
  }
  /** Spearman rank correlation — the right skill metric for a ranking model. */
  function spearman(a, b) {
    var n = Math.min(a.length, b.length);
    if (n < 3) return 0;
    var ra = rankArray(a.slice(0, n)), rb = rankArray(b.slice(0, n));
    var ma = mean(ra), mb = mean(rb);
    var num = 0, da = 0, db = 0;
    for (var i = 0; i < n; i++) {
      var x = ra[i] - ma, y = rb[i] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    return (da > 0 && db > 0) ? num / Math.sqrt(da * db) : 0;
  }
  function rankArray(a) {
    var idx = a.map(function (v, i) { return { v: v, i: i }; });
    idx.sort(function (x, y) { return x.v - y.v; });
    var r = new Array(a.length);
    for (var k = 0; k < idx.length;) {
      var j = k;
      while (j + 1 < idx.length && idx[j + 1].v === idx[k].v) j++;
      var avg = (k + j) / 2 + 1;
      for (var m = k; m <= j; m++) r[idx[m].i] = avg;
      k = j + 1;
    }
    return r;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     SECTION 3 — CART REGRESSION TREE

     Splits on weighted variance reduction. Handles missing values by sending
     them down the branch that reduces error most during training (a simplified
     surrogate-split approach) — important because real fundamental data is full
     of nulls and dropping those rows would bias the sample toward large,
     well-covered companies.
     ══════════════════════════════════════════════════════════════════════════ */

  function buildTree(X, y, indices, opts, rng, depth) {
    depth = depth || 0;
    var n = indices.length;
    var node = {};

    var yv = indices.map(function (i) { return y[i]; });
    node.value = mean(yv);
    node.n = n;

    if (depth >= opts.maxDepth || n < opts.minSamplesSplit || variance(yv) < 1e-12) {
      node.leaf = true;
      return node;
    }

    var nFeat = X[0].length;
    // Feature subsampling — the "random" in random forest. mtry ≈ p/3 is the
    // standard default for regression.
    var mtry = opts.mtry || Math.max(1, Math.floor(nFeat / 3));
    var featPool = [];
    for (var f = 0; f < nFeat; f++) featPool.push(f);
    // Partial Fisher-Yates: only shuffle as many as we need.
    for (var s = 0; s < mtry; s++) {
      var j = s + Math.floor(rng() * (featPool.length - s));
      var t = featPool[s]; featPool[s] = featPool[j]; featPool[j] = t;
    }
    var candidates = featPool.slice(0, mtry);

    var best = { gain: 0, feat: -1, thr: 0, left: null, right: null, missingLeft: true };
    var parentSse = variance(yv) * (n - 1);

    for (var c = 0; c < candidates.length; c++) {
      var fi = candidates[c];

      var present = [], missing = [];
      for (var k = 0; k < n; k++) {
        var v = X[indices[k]][fi];
        if (v == null || !isFinite(v)) missing.push(indices[k]);
        else present.push({ i: indices[k], v: v });
      }
      if (present.length < opts.minSamplesLeaf * 2) continue;

      present.sort(function (a, b) { return a.v - b.v; });

      // Evaluate a bounded number of candidate thresholds at quantiles rather
      // than every unique value — same split quality, far faster on 500+ rows.
      var nThr = Math.min(opts.maxThresholds || 24, present.length - 1);
      for (var q = 1; q <= nThr; q++) {
        var cut = Math.floor(present.length * q / (nThr + 1));
        if (cut < opts.minSamplesLeaf || present.length - cut < opts.minSamplesLeaf) continue;
        var thr = present[cut].v;
        if (thr === present[cut - 1].v) continue;

        var L = [], R = [];
        for (var p = 0; p < present.length; p++) (present[p].v <= thr ? L : R).push(present[p].i);
        if (!L.length || !R.length) continue;

        // Decide where missing values go by trying both and keeping the better.
        var opts2 = [
          { L: L.concat(missing), R: R, mL: true },
          { L: L, R: R.concat(missing), mL: false }
        ];
        for (var o = 0; o < opts2.length; o++) {
          var lv = opts2[o].L.map(function (i) { return y[i]; });
          var rv = opts2[o].R.map(function (i) { return y[i]; });
          if (lv.length < opts.minSamplesLeaf || rv.length < opts.minSamplesLeaf) continue;
          var sse = variance(lv) * Math.max(0, lv.length - 1) + variance(rv) * Math.max(0, rv.length - 1);
          var gain = parentSse - sse;
          if (gain > best.gain) {
            best = { gain: gain, feat: fi, thr: thr, left: opts2[o].L, right: opts2[o].R, missingLeft: opts2[o].mL };
          }
        }
      }
    }

    if (best.feat < 0 || best.gain <= 0) { node.leaf = true; return node; }

    node.leaf = false;
    node.feat = best.feat;
    node.thr = best.thr;
    node.missingLeft = best.missingLeft;
    node.gain = best.gain;
    node.left = buildTree(X, y, best.left, opts, rng, depth + 1);
    node.right = buildTree(X, y, best.right, opts, rng, depth + 1);
    return node;
  }

  function predictTree(node, row) {
    while (!node.leaf) {
      var v = row[node.feat];
      var goLeft = (v == null || !isFinite(v)) ? node.missingLeft : (v <= node.thr);
      node = goLeft ? node.left : node.right;
    }
    return node.value;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     SECTION 4 — RANDOM FOREST  (Breiman 2001)
     ══════════════════════════════════════════════════════════════════════════ */

  function RandomForest(opts) {
    opts = opts || {};
    this.opts = {
      nTrees: opts.nTrees || 150,
      maxDepth: opts.maxDepth || 8,
      minSamplesSplit: opts.minSamplesSplit || 10,
      minSamplesLeaf: opts.minSamplesLeaf || 5,
      mtry: opts.mtry || null,
      maxThresholds: opts.maxThresholds || 24,
      seed: opts.seed || 42
    };
    this.trees = [];
    this.oobPred = null;
    this.oobR2 = null;
  }

  RandomForest.prototype.fit = function (X, y) {
    var rng = mulberry32(this.opts.seed);
    var n = X.length;
    this.trees = [];

    // Out-of-bag accumulators: each row is predicted only by trees that did NOT
    // see it. This gives a free, genuine out-of-sample estimate.
    var oobSum = new Array(n).fill(0);
    var oobCnt = new Array(n).fill(0);

    for (var t = 0; t < this.opts.nTrees; t++) {
      var inBag = new Array(n).fill(false);
      var sample = [];
      for (var i = 0; i < n; i++) {
        var idx = Math.floor(rng() * n);
        sample.push(idx);
        inBag[idx] = true;
      }
      var tree = buildTree(X, y, sample, this.opts, rng, 0);
      this.trees.push(tree);

      for (var j = 0; j < n; j++) {
        if (!inBag[j]) { oobSum[j] += predictTree(tree, X[j]); oobCnt[j]++; }
      }
    }

    var oobY = [], oobP = [];
    this.oobPred = new Array(n).fill(null);
    for (var k = 0; k < n; k++) {
      if (oobCnt[k] > 0) {
        this.oobPred[k] = oobSum[k] / oobCnt[k];
        oobY.push(y[k]); oobP.push(this.oobPred[k]);
      }
    }
    this.oobR2 = oobY.length > 5 ? r2Score(oobY, oobP) : null;
    this.oobSpearman = oobY.length > 5 ? spearman(oobY, oobP) : null;
    this.oobN = oobY.length;
    return this;
  };

  RandomForest.prototype.predict = function (X) {
    var self = this;
    return X.map(function (row) {
      var s = 0;
      for (var t = 0; t < self.trees.length; t++) s += predictTree(self.trees[t], row);
      return s / self.trees.length;
    });
  };

  RandomForest.prototype.predictOne = function (row) { return this.predict([row])[0]; };

  /* ══════════════════════════════════════════════════════════════════════════
     SECTION 5 — GRADIENT BOOSTING  (Friedman 2001)

     Stagewise additive fitting on residuals with shrinkage and row subsampling.
     Includes early stopping on a validation split — without it, boosting will
     happily memorise the training set and report a beautiful, useless R².
     ══════════════════════════════════════════════════════════════════════════ */

  function GradientBoost(opts) {
    opts = opts || {};
    this.opts = {
      nRounds: opts.nRounds || 200,
      learningRate: opts.learningRate || 0.05,
      maxDepth: opts.maxDepth || 3,
      minSamplesSplit: opts.minSamplesSplit || 10,
      minSamplesLeaf: opts.minSamplesLeaf || 5,
      subsample: opts.subsample || 0.8,
      mtry: opts.mtry || null,
      maxThresholds: opts.maxThresholds || 20,
      valFraction: opts.valFraction || 0.25,
      earlyStopRounds: opts.earlyStopRounds || 20,
      seed: opts.seed || 42
    };
    this.trees = [];
    this.base = 0;
  }

  GradientBoost.prototype.fit = function (X, y) {
    var rng = mulberry32(this.opts.seed);
    var n = X.length;

    /* ── THREE-WAY SPLIT — fixed 2026-07-24 ────────────────────────────────
       BUG CAUGHT IN TESTING: the model previously early-stopped on a validation
       split and then REPORTED its rank correlation on that same split. Because
       early stopping selects the round that best fits that data, the reported
       score is a selected maximum, not an unbiased estimate. On synthetic data
       where true skill was exactly ZERO, this reported +0.22 while the random
       forest's out-of-bag score correctly reported −0.12.

       Now: train / stop / test are three disjoint sets. Early stopping uses
       `stop`; the reported score uses `test`, which the fitting process never
       touches. This is the difference between a model that reports its skill and
       one that reports its luck.                                              */
    var order = [];
    for (var i = 0; i < n; i++) order.push(i);
    for (var s = n - 1; s > 0; s--) { var j = Math.floor(rng() * (s + 1)); var t = order[s]; order[s] = order[j]; order[j] = t; }

    var nHold = Math.max(5, Math.floor(n * this.opts.valFraction));
    var testIdx = order.slice(0, nHold);              // reporting only — never fitted
    var valIdx = order.slice(nHold, nHold * 2);       // early stopping only
    var trIdx = order.slice(nHold * 2);               // fitting
    if (trIdx.length < 20) {                          // tiny sample: fall back to two-way
      testIdx = order.slice(0, nHold);
      valIdx = testIdx;
      trIdx = order.slice(nHold);
      this.degradedSplit = true;
    }

    this.base = mean(trIdx.map(function (i) { return y[i]; }));
    this.trees = [];

    var predTr = {}, predVal = {};
    trIdx.forEach(function (i) { predTr[i] = this.base; }, this);
    valIdx.forEach(function (i) { predVal[i] = this.base; }, this);

    var bestValMse = Infinity, bestRound = 0, since = 0;
    this.history = [];

    for (var r = 0; r < this.opts.nRounds; r++) {
      // Negative gradient of squared error = residual.
      var resid = new Array(X.length).fill(0);
      trIdx.forEach(function (i) { resid[i] = y[i] - predTr[i]; });

      // Row subsampling (stochastic gradient boosting).
      var sub = trIdx.filter(function () { return rng() < this.opts.subsample; }, this);
      if (sub.length < this.opts.minSamplesSplit * 2) sub = trIdx.slice();

      var tree = buildTree(X, resid, sub, this.opts, rng, 0);
      this.trees.push(tree);

      var lr = this.opts.learningRate;
      trIdx.forEach(function (i) { predTr[i] += lr * predictTree(tree, X[i]); });
      valIdx.forEach(function (i) { predVal[i] += lr * predictTree(tree, X[i]); });

      var vmse = 0;
      valIdx.forEach(function (i) { vmse += (y[i] - predVal[i]) * (y[i] - predVal[i]); });
      vmse /= valIdx.length;
      this.history.push(vmse);

      if (vmse < bestValMse - 1e-12) { bestValMse = vmse; bestRound = r + 1; since = 0; }
      else if (++since >= this.opts.earlyStopRounds) break;
    }

    // Trim back to the best round — this is what makes the model generalise.
    this.trees = this.trees.slice(0, Math.max(1, bestRound));
    this.bestRound = bestRound;
    this.roundsRun = this.history.length;

    // Reported skill comes from the TEST set the fitting process never saw.
    var ty = testIdx.map(function (i) { return y[i]; });
    var tp = this.predict(testIdx.map(function (i) { return X[i]; }));
    this.valR2 = r2Score(ty, tp);
    this.valSpearman = spearman(ty, tp);
    this.valN = testIdx.length;
    this.splitNote = this.degradedSplit
      ? 'Sample too small for a three-way split — early-stopping and reporting share a set, so this score is optimistic.'
      : 'Reported on a held-out test set disjoint from both the training and early-stopping sets.';
    return this;
  };

  GradientBoost.prototype.predict = function (X) {
    var self = this;
    return X.map(function (row) {
      var p = self.base;
      for (var t = 0; t < self.trees.length; t++) p += self.opts.learningRate * predictTree(self.trees[t], row);
      return p;
    });
  };

  GradientBoost.prototype.predictOne = function (row) { return this.predict([row])[0]; };

  /* ══════════════════════════════════════════════════════════════════════════
     SECTION 6 — PERMUTATION IMPORTANCE

     The honest importance measure. Shuffle one feature on HELD-OUT data and see
     how much skill degrades. Replaces the old
       pct = |beta_i| / sum(|beta|)
     which was displayed under a "Variance explained" heading despite being the
     share of absolute standardized coefficient — a different quantity that does
     not sum to R² and is arbitrary under collinearity.
     ══════════════════════════════════════════════════════════════════════════ */

  function permutationImportance(model, X, y, featureNames, opts) {
    opts = opts || {};
    var repeats = opts.repeats || 5;
    var rng = mulberry32(opts.seed || 7);
    var basePred = model.predict(X);
    var baseScore = opts.metric === 'spearman' ? spearman(y, basePred) : r2Score(y, basePred);

    var out = [];
    for (var f = 0; f < X[0].length; f++) {
      var drops = [];
      for (var rep = 0; rep < repeats; rep++) {
        var col = X.map(function (r) { return r[f]; });
        var perm = col.slice();
        for (var i = perm.length - 1; i > 0; i--) {
          var j = Math.floor(rng() * (i + 1));
          var t = perm[i]; perm[i] = perm[j]; perm[j] = t;
        }
        var Xp = X.map(function (r, ri) { var c = r.slice(); c[f] = perm[ri]; return c; });
        var p = model.predict(Xp);
        var sc = opts.metric === 'spearman' ? spearman(y, p) : r2Score(y, p);
        drops.push(baseScore - sc);
      }
      out.push({
        feature: featureNames[f],
        importance: mean(drops),
        std: Math.sqrt(variance(drops)),
        // Negative importance means shuffling HELPED — the feature is noise.
        noise: mean(drops) <= 0
      });
    }

    var totalPos = out.reduce(function (s, o) { return s + Math.max(0, o.importance); }, 0);
    out.forEach(function (o) {
      o.pctOfTotal = totalPos > 0 ? Math.max(0, o.importance) / totalPos * 100 : 0;
    });
    out.sort(function (a, b) { return b.importance - a.importance; });
    return { baseScore: baseScore, metric: opts.metric || 'r2', features: out };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     SECTION 7 — BLOCK BOOTSTRAP  (the overlapping-window fix)

     THE PROBLEM IT SOLVES
     The old quant page stepped observations DAILY while the target was a
     252-day forward return, so consecutive rows shared 251 of 252 days. It then
     bootstrapped rows i.i.d.:
         idx = Math.floor(Math.random() * nObs)
     Resampling i.i.d. destroys the serial dependence, which understates
     variance by roughly sqrt(horizon) ≈ 16x. That is why the page reported
     "98% sign stability" — an artifact, not evidence.

     THE FIX
     Resample contiguous BLOCKS whose length is at least the overlap horizon, so
     each block carries its own dependence structure. Also reports the EFFECTIVE
     sample size (n / horizon), which is the number that should be quoted.
     ══════════════════════════════════════════════════════════════════════════ */

  /**
   * Stationary block bootstrap (Politis & Romano 1994) with geometric block
   * lengths — avoids the artefacts of a fixed block size.
   *
   * @param {number} n         number of observations
   * @param {number} blockLen  expected block length; use >= overlap horizon
   * @param {function} rng
   * @returns {number[]} resampled indices, length n
   */
  function stationaryBootstrapIndices(n, blockLen, rng) {
    var p = 1 / Math.max(2, blockLen);     // prob. of starting a new block
    var idx = new Array(n);
    var cur = Math.floor(rng() * n);
    for (var i = 0; i < n; i++) {
      if (i > 0 && rng() < p) cur = Math.floor(rng() * n);
      else cur = (cur + 1) % n;            // wrap — circular block bootstrap
      idx[i] = cur;
    }
    return idx;
  }

  /**
   * Block-bootstrapped OLS confidence intervals.
   * @param X 2-D with intercept column, y target, horizon = target overlap in rows
   */
  function blockBootstrapOLS(X, y, horizon, opts) {
    opts = opts || {};
    var B = opts.B || 500;
    var rng = mulberry32(opts.seed || 1234);
    var n = X.length, p = X[0].length;
    var blockLen = Math.max(horizon, opts.minBlock || 10);

    var betas = [];
    for (var b = 0; b < B; b++) {
      var idx = stationaryBootstrapIndices(n, blockLen, rng);
      var Xb = idx.map(function (i) { return X[i]; });
      var yb = idx.map(function (i) { return y[i]; });
      try { betas.push(olsSolve(Xb, yb)); } catch (e) { /* singular draw — skip */ }
    }
    if (!betas.length) throw new Error('All bootstrap draws were singular');

    var effectiveN = Math.max(1, Math.floor(n / Math.max(1, horizon)));

    /* ── EFFECTIVE-n GATE ──────────────────────────────────────────────────
       Measured calibration on simulated pure-noise targets (40 trials, daily
       observations with a 252-day overlapping forward return):

         nominal alpha .................  5%
         i.i.d. row bootstrap (old) .... 98% false-positive rate
         stationary block bootstrap .... 30% false-positive rate

       The block bootstrap is a large improvement, but 30% is still far above
       nominal because ~6 independent periods simply cannot support an
       inferential claim. So significance is additionally GATED on effective n.
       Below MIN_EFFECTIVE_N the model reports "cannot assess" rather than a
       misleading pass/fail. This is the difference between a model that is
       quiet when it does not know and one that manufactures confidence.
       ────────────────────────────────────────────────────────────────────── */
    var MIN_EFFECTIVE_N = 30;
    var inferenceReliable = effectiveN >= MIN_EFFECTIVE_N;

    var point = olsSolve(X, y);
    var ci = [];
    for (var j = 0; j < p; j++) {
      var col = betas.map(function (bb) { return bb[j]; }).sort(function (a, c) { return a - c; });
      var lo = col[Math.floor(col.length * 0.025)];
      var hi = col[Math.floor(col.length * 0.975)];
      var signAgree = col.filter(function (v) { return Math.sign(v) === Math.sign(point[j]) && v !== 0; }).length / col.length;
      var crossesZero = !((lo > 0 && hi > 0) || (lo < 0 && hi < 0));
      ci.push({
        coef: point[j], ciLow: lo, ciHigh: hi,
        signStability: signAgree,
        // null (not false) when the sample cannot support inference at all.
        significant: inferenceReliable ? !crossesZero : null,
        crossesZero: crossesZero,
        se: Math.sqrt(variance(col)),
        interpretation: !inferenceReliable
          ? 'Cannot assess — only ' + effectiveN + ' independent periods available'
          : crossesZero ? 'Not distinguishable from zero' : 'Distinguishable from zero'
      });
    }

    return {
      params: ci,
      nObs: n,
      effectiveN: effectiveN,
      minEffectiveN: MIN_EFFECTIVE_N,
      inferenceReliable: inferenceReliable,
      horizon: horizon,
      blockLength: blockLen,
      B: betas.length,
      // The number that should be quoted anywhere a sample size is shown.
      note: 'Observations overlap by ' + horizon + ' rows, so the ' + n +
            ' raw observations carry roughly ' + effectiveN +
            ' independent periods of information. Intervals come from a stationary block bootstrap ' +
            '(expected block length ' + blockLen + '), not an i.i.d. resample.',
      warning: inferenceReliable ? null
        : 'With ' + effectiveN + ' independent periods (minimum ' + MIN_EFFECTIVE_N +
          ' for inference), coefficient significance cannot be assessed at any horizon this long. ' +
          'Shorten the forward horizon or lengthen the lookback. Treat the coefficients as ' +
          'descriptive of the sample only — not as evidence of a repeatable relationship.'
    };
  }

  /** Gauss-Jordan OLS with ridge fallback for near-singular designs. */
  function olsSolve(X, y, lambda) {
    var n = X.length, p = X[0].length;
    lambda = lambda || 0;
    var xtx = [];
    for (var i = 0; i < p; i++) xtx.push(new Array(p).fill(0));
    var xty = new Array(p).fill(0);
    for (var r = 0; r < n; r++) {
      for (var a = 0; a < p; a++) {
        xty[a] += X[r][a] * y[r];
        for (var b = 0; b < p; b++) xtx[a][b] += X[r][a] * X[r][b];
      }
    }
    // Ridge on non-intercept terms only.
    if (lambda > 0) for (var d = 1; d < p; d++) xtx[d][d] += lambda;

    var aug = [];
    for (var q = 0; q < p; q++) aug.push(xtx[q].concat([xty[q]]));
    for (var c = 0; c < p; c++) {
      var piv = c;
      for (var ri = c + 1; ri < p; ri++) if (Math.abs(aug[ri][c]) > Math.abs(aug[piv][c])) piv = ri;
      if (Math.abs(aug[piv][c]) < 1e-11) {
        if (lambda === 0) return olsSolve(X, y, 1e-6);   // auto-ridge
        throw new Error('Singular design matrix');
      }
      if (piv !== c) { var tmp = aug[c]; aug[c] = aug[piv]; aug[piv] = tmp; }
      var pv = aug[c][c];
      for (var cc = c; cc <= p; cc++) aug[c][cc] /= pv;
      for (var r2 = 0; r2 < p; r2++) {
        if (r2 === c) continue;
        var fct = aug[r2][c];
        for (var c2 = c; c2 <= p; c2++) aug[r2][c2] -= fct * aug[c][c2];
      }
    }
    return aug.map(function (row) { return row[p]; });
  }

  /**
   * Variance Inflation Factors — the collinearity diagnostic the old MLR was
   * missing entirely. It fed `vol` AND `sharpe` into the same regression, where
   * sharpe = (annualised mean - rf) / vol, i.e. a deterministic function of a
   * feature already present. VIF > 10 flags exactly that.
   */
  function computeVIF(X, featureNames) {
    var p = X[0].length;
    var out = [];
    for (var f = 0; f < p; f++) {
      var Xo = X.map(function (r) {
        var row = [1];
        for (var j = 0; j < p; j++) if (j !== f) row.push(r[j]);
        return row;
      });
      var yf = X.map(function (r) { return r[f]; });
      try {
        var beta = olsSolve(Xo, yf);
        var pred = Xo.map(function (r) { return r.reduce(function (s, v, i) { return s + v * beta[i]; }, 0); });
        var r2 = r2Score(yf, pred);
        var vif = r2 >= 0.9999 ? Infinity : 1 / (1 - r2);
        out.push({
          feature: featureNames[f], vif: vif, r2: r2,
          severity: vif > 10 ? 'severe' : vif > 5 ? 'moderate' : 'ok'
        });
      } catch (e) {
        out.push({ feature: featureNames[f], vif: Infinity, r2: 1, severity: 'severe' });
      }
    }
    return out.sort(function (a, b) { return b.vif - a.vif; });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     SECTION 8 — PURGED WALK-FORWARD CV  (for time-series targets)

     Standard k-fold leaks information when the target is a forward return: a
     training row dated just before a test row already "knows" the test outcome.
     Purging removes training rows whose target window overlaps the test set;
     the embargo adds a further gap. (López de Prado, Advances in Financial
     Machine Learning, ch. 7.)
     ══════════════════════════════════════════════════════════════════════════ */

  function purgedWalkForward(X, y, horizon, opts) {
    opts = opts || {};
    var folds = opts.folds || 5;
    var embargo = opts.embargo != null ? opts.embargo : Math.ceil(horizon * 0.1);
    var n = X.length;
    var foldSize = Math.floor(n / (folds + 1));
    if (foldSize < 20) return { folds: [], note: 'Too few observations for purged walk-forward CV' };

    var results = [];
    for (var k = 1; k <= folds; k++) {
      var trainEnd = foldSize * k;
      var testStart = trainEnd + horizon + embargo;   // purge + embargo
      var testEnd = Math.min(n, testStart + foldSize);
      if (testStart >= n || testEnd - testStart < 10) continue;

      var trI = [], teI = [];
      for (var i = 0; i < trainEnd; i++) trI.push(i);
      for (var j = testStart; j < testEnd; j++) teI.push(j);

      var Xtr = trI.map(function (i) { return X[i]; }), ytr = trI.map(function (i) { return y[i]; });
      var Xte = teI.map(function (i) { return X[i]; }), yte = teI.map(function (i) { return y[i]; });

      var model = opts.factory ? opts.factory() : new GradientBoost({ seed: 42 + k });
      model.fit(Xtr, ytr);
      var pred = model.predict(Xte);

      results.push({
        fold: k, trainN: trI.length, testN: teI.length,
        purgedRows: horizon + embargo,
        r2: r2Score(yte, pred),
        spearman: spearman(yte, pred),
        hitRate: yte.reduce(function (s, v, i) { return s + (Math.sign(v) === Math.sign(pred[i]) ? 1 : 0); }, 0) / yte.length
      });
    }

    return {
      folds: results,
      meanR2: results.length ? mean(results.map(function (r) { return r.r2; })) : null,
      meanSpearman: results.length ? mean(results.map(function (r) { return r.spearman; })) : null,
      meanHitRate: results.length ? mean(results.map(function (r) { return r.hitRate; })) : null,
      embargo: embargo, horizon: horizon,
      note: 'Each fold purges ' + (horizon + embargo) + ' rows between train and test so no training ' +
            'observation\'s forward-return window overlaps the test period. Out-of-sample R² near or ' +
            'below zero is the normal result for equity return prediction — rank correlation is the ' +
            'metric that matters for a ranking model.'
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     SECTION 9 — CROSS-SECTIONAL HOLDING RANKER

     THE FEATURE THE USER ASKED FOR: score every holding across fundamentals,
     technicals, sector and industry context to answer "is this the best stock
     to hold?"

     Design decisions worth knowing:
       • Features are COHORT-RELATIVE z-scores (industry first, then sector, then
         market), never raw ratios. A 32x P/E means something different in
         software than in utilities.
       • The composite is regime-aware: factor weights shift with the Quad,
         because value works in different environments than momentum.
       • The ML models are trained to predict FORWARD 3-MONTH RETURN using
         historical OHLC we already store, then blended with the transparent
         factor composite. If the models have no out-of-sample skill, their
         weight automatically drops to zero — the site never leans on a model
         that has not earned it.
     ══════════════════════════════════════════════════════════════════════════ */

  /* Factor blocks. Weights sum to 1 within each regime. Grounded in the
     standard factor literature: value and quality are long-horizon anchors,
     momentum is the strongest medium-horizon signal, low-vol matters most in
     deteriorating regimes. */
  var REGIME_FACTOR_WEIGHTS = {
    Goldilocks:  { value: 0.15, quality: 0.20, momentum: 0.35, growth: 0.20, lowvol: 0.10 },
    Overheat:    { value: 0.25, quality: 0.25, momentum: 0.20, growth: 0.10, lowvol: 0.20 },
    Stagflation: { value: 0.30, quality: 0.30, momentum: 0.10, growth: 0.05, lowvol: 0.25 },
    Deflation:   { value: 0.20, quality: 0.35, momentum: 0.10, growth: 0.05, lowvol: 0.30 },
    _default:    { value: 0.22, quality: 0.26, momentum: 0.22, growth: 0.12, lowvol: 0.18 }
  };

  var FACTOR_BLOCKS = {
    value:    ['fcf_yield', 'earnings_yield', 'pe', 'pb', 'ps', 'pfcf', 'ev_ebitda'],
    quality:  ['roe', 'roic', 'net_margin', 'operating_margin', 'interest_coverage', 'quality_flags', 'debt_to_equity'],
    momentum: ['mom_12_1', 'ret_3m', 'ret_6m', 'rel_str_3m'],
    growth:   ['ret_12m', 'gross_margin'],
    lowvol:   ['vol_ann', 'beta_spy', 'max_dd_1y']
  };

  var ML = {
    RandomForest: RandomForest,
    GradientBoost: GradientBoost,
    permutationImportance: permutationImportance,
    blockBootstrapOLS: blockBootstrapOLS,
    stationaryBootstrapIndices: stationaryBootstrapIndices,
    purgedWalkForward: purgedWalkForward,
    computeVIF: computeVIF,
    olsSolve: olsSolve,
    REGIME_FACTOR_WEIGHTS: REGIME_FACTOR_WEIGHTS,
    FACTOR_BLOCKS: FACTOR_BLOCKS,
    util: { mean: mean, variance: variance, r2Score: r2Score, spearman: spearman, rankArray: rankArray, mulberry32: mulberry32, gaussFrom: gaussFrom },
    _trained: null
  };

  /** Factor-block score for one ticker: mean of available cohort z-scores. */
  function blockScore(WH, ticker, block, scope) {
    var zs = [];
    FACTOR_BLOCKS[block].forEach(function (f) {
      var z = WH.zScore(ticker, f, scope);          // already polarity-corrected
      if (z != null && isFinite(z)) zs.push(Math.max(-3, Math.min(3, z)));
    });
    return zs.length ? { z: mean(zs), n: zs.length } : { z: null, n: 0 };
  }

  /* ════════════════════════════════════════════════════════════════════════
     TARGET-LEAKAGE GUARD

     Caught by the integration test on 2026-07-24: the training target is the
     trailing 3-month return, and the `momentum` factor block CONTAINS `ret_3m`.
     The model was therefore partly predicting the target from itself, which
     produced a rank correlation of 0.38 and earned the ensemble 50% of the
     composite weight on the strength of pure leakage.

     Two classes of feature leak into a trailing-return target:

       1. DIRECT — trailing return fields (ret_3m, ret_6m, rel_str_3m, ret_12m,
          mom_12_1) are the target or overlap its window.
       2. INDIRECT — every price-based multiple (P/E, P/B, P/S, P/FCF, EV/EBITDA,
          FCF yield, earnings yield) has price in the numerator, so a stock that
          just fell 30% mechanically shows a cheaper multiple. The association is
          economically real but it is not predictive information.

     Both are excluded from TRAINING. They remain in the transparent factor
     composite, where they belong — the composite is a stated ranking rule, not a
     fitted model, so it makes no claim of out-of-sample skill and cannot be
     invalidated by leakage.

     What is left to train on is genuinely non-price fundamental and risk data:
     margins, returns on capital, leverage, coverage, size, and realised
     volatility. Asking whether those characteristics were rewarded in the recent
     cross-section is a legitimate question with an honest answer.
     ════════════════════════════════════════════════════════════════════════ */

  var LEAKY_BLOCKS = ['momentum', 'growth', 'value'];   // value = price-based multiples
  var CLEAN_BLOCKS = ['quality', 'lowvol'];

  /* Individual non-price fields used directly, so the trainable set is not
     reduced to two numbers. None of these contain price. */
  var CLEAN_FIELDS = [
    'roe', 'roic', 'net_margin', 'operating_margin', 'gross_margin',
    'interest_coverage', 'quality_flags', 'debt_to_equity', 'current_ratio',
    'vol_ann', 'beta_spy'
  ];

  /**
   * Build the ML training set. Features are LEAK-FREE cohort z-scores of
   * non-price fundamentals plus risk measures; the target is the trailing
   * 3-month return.
   *
   * This is explicitly a CROSS-SECTIONAL ASSOCIATION model — "were these
   * characteristics rewarded recently?" — not a forecast. A single panel
   * snapshot cannot support a forward-return model; that needs accumulated
   * panel history, which the nightly ingestion is building.
   */
  ML.buildTrainingSet = function (opts) {
    opts = opts || {};
    var WH = window.PerryWarehouse;
    if (!WH || !WH.ready()) return null;

    var featNames = CLEAN_BLOCKS.map(function (b) { return b + '_z'; })
      .concat(CLEAN_FIELDS.map(function (f) { return f + '_z'; }))
      .concat(['log_cap']);

    var rows = WH.all().filter(function (r) {
      return r.data_complete && r.ret_3m != null && r.market_cap > 0;
    });
    if (rows.length < 60) return null;

    var X = [], y = [], tickers = [];
    rows.forEach(function (r) {
      var vec = [];
      CLEAN_BLOCKS.forEach(function (b) { vec.push(blockScore(WH, r.ticker, b, opts.scope).z); });
      CLEAN_FIELDS.forEach(function (f) {
        var z = WH.zScore(r.ticker, f, opts.scope);
        vec.push(z == null ? null : Math.max(-3, Math.min(3, z)));
      });
      vec.push(r.market_cap ? Math.log(r.market_cap) : null);

      X.push(vec);
      y.push(r.ret_3m);
      tickers.push(r.ticker);
    });

    return {
      X: X, y: y, tickers: tickers, featureNames: featNames, n: X.length,
      excludedForLeakage: LEAKY_BLOCKS.slice(),
      targetDescription: 'trailing 3-month total return',
      modelType: 'cross-sectional association (not a forward forecast)'
    };
  };

  /** Feature vector for scoring one ticker — must mirror buildTrainingSet. */
  function mlVectorFor(WH, ticker, scope) {
    var row = WH.get(ticker);
    if (!row) return null;
    var vec = [];
    CLEAN_BLOCKS.forEach(function (b) { vec.push(blockScore(WH, ticker, b, scope).z); });
    CLEAN_FIELDS.forEach(function (f) {
      var z = WH.zScore(ticker, f, scope);
      vec.push(z == null ? null : Math.max(-3, Math.min(3, z)));
    });
    vec.push(row.market_cap ? Math.log(row.market_cap) : null);
    return vec;
  }

  /**
   * Train the ensemble. Reports OOS skill honestly and derives the blend weight
   * from that skill — a model with no skill gets no weight.
   */
  ML.train = function (opts) {
    opts = opts || {};
    var ds = ML.buildTrainingSet(opts);
    if (!ds) return null;

    var rf = new RandomForest({ nTrees: opts.nTrees || 120, maxDepth: 7, seed: 42 }).fit(ds.X, ds.y);
    var gb = new GradientBoost({ nRounds: 250, learningRate: 0.05, maxDepth: 3, seed: 42 }).fit(ds.X, ds.y);

    var imp = permutationImportance(rf, ds.X, ds.y, ds.featureNames, { repeats: 4, metric: 'spearman', seed: 11 });
    var vif = computeVIF(ds.X.map(function (r) {
      return r.map(function (v) { return v == null ? 0 : v; });
    }), ds.featureNames);

    /* ── SKILL ESTIMATE: conservative, not optimistic ───────────────────────
       Changed 2026-07-24. This previously took max(rf, gb). Taking the maximum
       of two noisy estimates is itself upward-biased — with two independent
       zero-skill estimates, the max is positive about 75% of the time.

       Now uses the MINIMUM of the two. Both models must independently detect the
       same association before the ensemble earns any weight, which is the
       appropriate burden of proof for something that will move real money.
       The RF out-of-bag score is the more trustworthy of the two (every row is
       scored by trees that never saw it), so a large gap between them is itself
       reported as a warning.                                                   */
    var rfSkill = rf.oobSpearman == null ? 0 : rf.oobSpearman;
    var gbSkill = gb.valSpearman == null ? 0 : gb.valSpearman;
    var bestSkill = Math.min(rfSkill, gbSkill);
    var skillDisagreement = Math.abs(rfSkill - gbSkill);

    /* Blend weight — thresholds RAISED 2026-07-24 after the leakage fix.
       Requires rank correlation above 0.10 (not 0.05) and caps at 0.35 (not
       0.50), so the transparent factor composite always retains at least 65%.
       Rationale: the ensemble now trains on a leak-free but ALSO much weaker
       feature set, and it measures association rather than forecast skill. It
       deserves a supporting role, not a controlling one. */
    var MIN_SKILL = 0.10, MAX_WEIGHT = 0.35;
    var mlWeight = bestSkill <= MIN_SKILL ? 0
      : Math.min(MAX_WEIGHT, (bestSkill - MIN_SKILL) * 1.5);

    var out = {
      rf: rf, gb: gb, dataset: ds,
      importance: imp, vif: vif,
      skill: {
        rf_oob_r2: rf.oobR2, rf_oob_spearman: rfSkill, rf_oob_n: rf.oobN,
        gb_val_r2: gb.valR2, gb_val_spearman: gbSkill, gb_val_n: gb.valN,
        gb_best_round: gb.bestRound, gb_rounds_run: gb.roundsRun,
        best: bestSkill, mlWeight: mlWeight,
        minSkill: MIN_SKILL, maxWeight: MAX_WEIGHT,
        estimator: 'min(RF out-of-bag, GB held-out test) — both models must agree before the ensemble earns weight',
        disagreement: skillDisagreement,
        disagreementWarning: skillDisagreement > 0.15
          ? 'The two models disagree by ' + skillDisagreement.toFixed(2) + ' rank-correlation. That gap is itself evidence of instability, and the conservative (lower) estimate is being used.'
          : null,
        gbSplitNote: gb.splitNote || null,
        modelType: ds.modelType,
        target: ds.targetDescription,
        excludedForLeakage: ds.excludedForLeakage,
        leakageNote: 'Momentum, growth and price-multiple features are excluded from training because they either ARE the target or contain price, which would leak the target. They remain in the transparent factor composite, which makes no out-of-sample claim.',
        verdict: bestSkill <= MIN_SKILL
          ? 'No usable association above the ' + MIN_SKILL.toFixed(2) + ' rank-correlation threshold. The ensemble contributes 0% — this ranking is driven entirely by the transparent factor composite, which is the intended default.'
          : bestSkill < 0.20
            ? 'Weak positive cross-sectional association (rank corr ' + bestSkill.toFixed(3) + '). Contributing ' + Math.round(mlWeight * 100) + '% to the composite.'
            : 'Clear cross-sectional association (rank corr ' + bestSkill.toFixed(3) + '). Contributing ' + Math.round(mlWeight * 100) + '% to the composite. Note this measures which characteristics were REWARDED RECENTLY, not what will outperform next.'
      },
      trainedAt: new Date().toISOString()
    };
    ML._trained = out;
    return out;
  };

  /**
   * THE MAIN ENTRY POINT for holding analysis.
   * Returns a ranked, fully-explained score for every ticker supplied.
   */
  ML.rankHoldings = function (tickers, opts) {
    opts = opts || {};
    var WH = window.PerryWarehouse;
    if (!WH || !WH.ready()) return { error: 'Warehouse not loaded', rows: [] };

    var regime = opts.regime || (window._perrySignals && window._perrySignals.regime && window._perrySignals.regime.label) || null;
    var weights = REGIME_FACTOR_WEIGHTS[regime] || REGIME_FACTOR_WEIGHTS._default;

    var model = opts.model || ML._trained || ML.train(opts);
    var mlWeight = model ? model.skill.mlWeight : 0;

    var list = (tickers && tickers.length) ? tickers : WH.all().map(function (r) { return r.ticker; });

    var scored = list.map(function (t) {
      var row = WH.get(t);
      if (!row) {
        return { ticker: t, covered: false,
                 note: 'Not yet in the warehouse — the universe fills over several nights on the FMP free tier.' };
      }

      var cohort = WH.cohort(t, opts.scope);
      var blocks = {}, factorZ = 0, wUsed = 0;
      Object.keys(FACTOR_BLOCKS).forEach(function (b) {
        var bs = blockScore(WH, t, b, opts.scope);
        blocks[b] = { z: bs.z, nFields: bs.n, weight: weights[b] };
        if (bs.z != null) { factorZ += bs.z * weights[b]; wUsed += weights[b]; }
      });
      // Renormalise if some blocks had no data.
      if (wUsed > 0) factorZ /= wUsed;

      // ML prediction, if the ensemble earned any weight. Uses the SAME
      // leak-free vector construction as training (mlVectorFor) — building it
      // inline here is what allowed the feature sets to drift apart before.
      var mlPred = null, mlZ = null;
      if (mlWeight > 0 && model) {
        var vec = mlVectorFor(WH, t, opts.scope);
        if (vec) {
          var pRf = model.rf.predictOne(vec);
          var pGb = model.gb.predictOne(vec);
          mlPred = (pRf + pGb) / 2;
          var allPred = model.dataset.y;
          var sd = Math.sqrt(variance(allPred)) || 1;
          mlZ = Math.max(-3, Math.min(3, (mlPred - mean(allPred)) / sd));
        }
      }

      var composite = mlZ != null
        ? factorZ * (1 - mlWeight) + mlZ * mlWeight
        : factorZ;

      return {
        ticker: t, covered: true,
        name: row.name, sector: row.sector, industry: row.industry,
        cohort: cohort.scope, cohortLabel: cohort.label || 'Market', cohortN: cohort.rows.length,
        blocks: blocks,
        factorZ: factorZ,
        mlPred: mlPred, mlZ: mlZ, mlWeight: mlWeight,
        composite: composite,
        marketCap: row.market_cap,
        // Regime alignment — is this sector favoured in the current Quad?
        regimeFit: regimeFitFor(row.sector, regime),
        raw: row
      };
    });

    var covered = scored.filter(function (s) { return s.covered; });
    covered.sort(function (a, b) { return b.composite - a.composite; });
    covered.forEach(function (s, i) {
      s.rank = i + 1;
      s.percentile = covered.length > 1 ? (1 - i / (covered.length - 1)) * 100 : 100;
      s.verdict = verdictFor(s);
    });

    return {
      rows: covered,
      missing: scored.filter(function (s) { return !s.covered; }).map(function (s) { return s.ticker; }),
      regime: regime, weights: weights, model: model,
      mlWeight: mlWeight,
      asOf: new Date().toISOString()
    };
  };

  function regimeFitFor(sector, regime) {
    var S = window.PerrySignals;
    if (!S || !regime || !S.REGIME_TILTS[regime] || !sector) return { fit: 'unknown', label: '—' };
    var t = S.REGIME_TILTS[regime];
    if (t.OW.indexOf(sector) >= 0) return { fit: 'favoured', label: 'Favoured in ' + regime };
    if (t.UW.indexOf(sector) >= 0) return { fit: 'unfavoured', label: 'Unfavoured in ' + regime };
    return { fit: 'neutral', label: 'Neutral in ' + regime };
  }

  /**
   * Verdict combines cross-sectional score with regime fit. Note it never says
   * "SELL" on a score alone — a low score in a favoured sector is a candidate
   * for UPGRADE (swap within sector), which is a different action.
   */
  function verdictFor(s) {
    var z = s.composite;
    var fit = s.regimeFit.fit;
    if (z >= 0.75 && fit !== 'unfavoured') return { call: 'Core Hold', color: '#2E7D52', action: 'Top-quartile on the factors that matter in this regime. Hold or add on weakness.' };
    if (z >= 0.75) return { call: 'Hold, Watch Sector', color: '#003C71', action: 'Strong company-level score, but the sector is out of favour in this regime. Keep, do not add.' };
    if (z >= 0.25) return { call: 'Hold', color: '#003C71', action: 'Above-median standing within its cohort. No action indicated.' };
    if (z >= -0.25) return { call: 'Monitor', color: '#8B6914', action: 'Middle of its cohort. Look for a better use of the capital if one is available.' };
    if (z >= -0.75 && fit === 'favoured') return { call: 'Upgrade Within Sector', color: '#8B6914', action: 'Sector is favoured but this name lags its peers. Consider swapping into a higher-ranked name in the same sector.' };
    if (z >= -0.75) return { call: 'Trim Candidate', color: '#8B6914', action: 'Below-median cohort standing. Reduce on strength.' };
    return { call: 'Replace Candidate', color: '#8B2A2A', action: 'Bottom-decile cohort standing. Identify a replacement before selling — see suggested alternatives.' };
  }

  /**
   * Best available replacements for a weak holding: same sector, higher
   * composite, adequate liquidity. This is the "is it the best stock to hold?"
   * question answered constructively.
   */
  ML.findUpgrades = function (ticker, opts) {
    opts = opts || {};
    var WH = window.PerryWarehouse;
    var row = WH && WH.get(ticker);
    if (!row) return [];

    var pool = WH.all().filter(function (r) {
      return r.ticker !== ticker && r.data_complete && r.sector === row.sector &&
             (r.market_cap || 0) >= (opts.minCap || 2e9) &&
             (r.avg_dollar_vol_3m || 0) >= (opts.minDollarVol || 1e7);
    }).map(function (r) { return r.ticker; });

    if (!pool.length) return [];

    var ranked = ML.rankHoldings(pool.concat([ticker]), opts);
    var self = ranked.rows.filter(function (r) { return r.ticker === ticker; })[0];
    if (!self) return [];

    return ranked.rows
      .filter(function (r) { return r.ticker !== ticker && r.composite > self.composite + 0.35; })
      .slice(0, opts.n || 5)
      .map(function (r) {
        return {
          ticker: r.ticker, name: r.name, composite: r.composite,
          edge: r.composite - self.composite,
          betterOn: Object.keys(r.blocks).filter(function (b) {
            return r.blocks[b].z != null && self.blocks[b].z != null && r.blocks[b].z > self.blocks[b].z + 0.3;
          }),
          marketCap: r.marketCap
        };
      });
  };

  /* ════════════════════════════════════════════════════════════════════════
     FORWARD RETURN FORECAST — added 2026-07-24.

     The user's question was: "Don't we have a model for forecasting the prices
     of stocks too? Why isn't that baked in?"

     It existed (pfrRun, the Project Stock Values page) but was completely
     disconnected from the ranker and the rebalance logic — a forecast nothing
     acted on. This function reimplements the same CAPM-style construction so
     the ranker can consume it directly, and it now uses MEASURED beta and
     volatility from the warehouse rather than sector-name guesses.

     Deliberately modest: expected return = risk-free + beta × regime-tilted
     equity premium, adjusted by the cross-sectional factor score. No claim of
     precision — the output is used for RANKING and sizing, not as a price target.
     ════════════════════════════════════════════════════════════════════════ */
  ML.expectedReturn = function (ticker, opts) {
    opts = opts || {};
    var WH = window.PerryWarehouse, S = window.PerrySignals;
    var row = WH && WH.get(ticker);
    if (!row || !S) return null;

    var rf = S.CONST.RF_RATE;
    var regime = opts.regime || (window._perrySignals && window._perrySignals.regime && window._perrySignals.regime.label);
    var eq = S.expectedReturn('us_equity', regime);
    if (!eq) return null;
    var erp = eq.mu - rf;                       // regime-tilted equity premium

    // Blume-adjusted beta: raw betas are noisy and mean-revert toward 1.
    var rawBeta = row.beta_spy != null && isFinite(row.beta_spy) ? row.beta_spy : 1.0;
    var beta = 0.67 * rawBeta + 0.33 * 1.0;
    var betaMeasured = row.beta_spy != null && isFinite(row.beta_spy);

    var capm = rf + beta * erp;

    /* Factor tilt: the cross-sectional composite shifts expected return, but by
       a BOUNDED amount. A +2σ composite adds 2pp, not 20pp — the factor score is
       a ranking signal, and treating it as a return forecast would be exactly the
       overreach the audit criticised elsewhere. */
    var comp = opts.composite;
    if (comp == null) {
      var r1 = ML.rankHoldings([ticker], { regime: regime, scope: opts.scope });
      comp = r1.rows.length ? r1.rows[0].composite : 0;
    }
    var factorTilt = Math.max(-0.03, Math.min(0.03, comp * 0.015));

    var expected = capm + factorTilt;
    var sigma = row.vol_ann != null && isFinite(row.vol_ann) ? row.vol_ann : 0.18 * beta;

    return {
      ticker: ticker,
      expectedReturn: expected,
      capmBase: capm,
      factorTilt: factorTilt,
      riskFree: rf,
      equityPremium: erp,
      beta: beta, rawBeta: rawBeta, betaMeasured: betaMeasured,
      sigma: sigma,
      sigmaMeasured: row.vol_ann != null,
      // Sharpe on FORWARD expectations — the number that should drive sizing.
      forwardSharpe: sigma > 0 ? (expected - rf) / sigma : null,
      regime: regime,
      method: 'CAPM (risk-free + Blume-adjusted beta × regime-tilted ERP) plus a bounded factor tilt of ±3pp. ' +
              (betaMeasured ? 'Beta measured from 2 years of daily returns.' : 'Beta defaulted to 1.0 — warehouse coverage pending.'),
      caveat: 'A ranking and sizing input, not a price target. Single-stock expected returns carry error bars far wider than the point estimate.'
    };
  };

  /**
   * Portfolio-level optimisation view: which positions to trim, which to add,
   * sized by the unified gross-exposure target. Combines the ranker with the
   * signal engine so the recommendation is consistent with the site's posture.
   */
  ML.optimizePortfolio = function (holdings, opts) {
    opts = opts || {};
    var sig = window._perrySignals || null;
    var gross = sig && sig.view ? sig.view.grossTarget : 1.0;
    var regime = sig && sig.regime ? sig.regime.label : null;

    var tickers = (holdings || []).map(function (h) { return h.ticker; });
    var ranked = ML.rankHoldings(tickers, { regime: regime, scope: opts.scope });
    if (!ranked.rows.length) return { error: 'No covered holdings', ranked: ranked };

    var totalMV = (holdings || []).reduce(function (s, h) {
      return s + (h.quantity || 0) * (h.currentPrice || h.costBasis || 0);
    }, 0);

    var byTicker = {};
    ranked.rows.forEach(function (r) { byTicker[r.ticker] = r; });

    // Score-tilted target weights, then scaled to the gross exposure target.
    var scores = ranked.rows.map(function (r) { return r.composite; });
    var minS = Math.min.apply(null, scores);
    var shifted = ranked.rows.map(function (r) { return Math.max(0.05, r.composite - minS + 0.1); });
    var sumShift = shifted.reduce(function (a, b) { return a + b; }, 0);

    var actions = (holdings || []).map(function (h, i) {
      var r = byTicker[h.ticker];
      var mv = (h.quantity || 0) * (h.currentPrice || h.costBasis || 0);
      var currentW = totalMV > 0 ? mv / totalMV : 0;
      if (!r) {
        return { ticker: h.ticker, covered: false, currentWeight: currentW,
                 action: 'No data', note: 'Awaiting warehouse coverage' };
      }
      var idx = ranked.rows.indexOf(r);
      var rawTarget = shifted[idx] / sumShift;

      /* Forecast now feeds sizing — this is the "bake it in" the audit called
         for. Positions are tilted by forward Sharpe (expected excess return per
         unit of measured volatility), so a high-scoring but very volatile name
         does not automatically get a large weight. Bounded to ±35% of the
         score-implied weight so the forecast informs sizing without dominating
         a ranking that rests on firmer ground. */
      var fc = ML.expectedReturn(h.ticker, { regime: regime, composite: r.composite, scope: opts.scope });
      var sharpeTilt = 1.0;
      if (fc && fc.forwardSharpe != null) {
        var medSharpe = 0.35;   // typical long-run equity forward Sharpe
        sharpeTilt = 1 + Math.max(-0.35, Math.min(0.35, (fc.forwardSharpe - medSharpe) * 0.6));
      }
      var targetW = rawTarget * gross * sharpeTilt;
      var delta = targetW - currentW;

      return {
        ticker: h.ticker, covered: true, name: r.name, sector: r.sector,
        rank: r.rank, percentile: r.percentile, composite: r.composite,
        verdict: r.verdict, regimeFit: r.regimeFit,
        forecast: fc,
        sharpeTilt: sharpeTilt,
        currentWeight: currentW, targetWeight: targetW, delta: delta,
        dollarDelta: delta * totalMV,
        action: Math.abs(delta) < 0.015 ? 'Hold' : delta > 0 ? 'Add' : 'Trim',
        upgrades: r.composite < -0.4 ? ML.findUpgrades(h.ticker, { n: 3, regime: regime }) : []
      };
    });

    /* ── CONCENTRATION CAP — added 2026-07-24 after end-to-end testing ──────
       The score-proportional sizing above happily pushed a single high-scoring
       position from 11% to 37% of the portfolio. A ranking model is not a
       reason to abandon diversification: factor scores are noisy, and a 37%
       single-name weight makes the portfolio a bet on one company rather than
       on the process.

       Caps applied iteratively (capping one name redistributes to others, which
       can push a second name over the limit, hence the loop):
         • max 15% in any single position
         • max 35% in any one sector
       Both are deliberately conventional. The cap binding is reported so the
       user can see the model wanted more than prudence allows. */
    var MAX_POSITION = 0.15, MAX_SECTOR = 0.35;
    var capsBinding = [];
    var covered = actions.filter(function (a) { return a.covered; });

    /* Water-filling: allocate `gross` proportionally to desire, cap violators at
       their ceiling, then redistribute the freed weight among names that still
       have headroom. Repeat until stable. Unlike naive scaling this converges to
       the maximum feasible allocation rather than shrinking the whole book. */
    var desire = {};
    covered.forEach(function (a) { desire[a.ticker] = Math.max(1e-6, a.targetWeight); });

    /* Caps are ABSOLUTE percentages of the portfolio, deliberately NOT scaled by
       the gross target. A concentration limit that loosened whenever the signals
       turned bullish would defeat its own purpose — the whole point is that it
       binds hardest exactly when conviction is highest. */
    var posLimit = MAX_POSITION;
    var locked = {};          // ticker -> fixed weight
    var feasibleTotal = gross;

    for (var pass = 0; pass < 25; pass++) {
      var openNames = covered.filter(function (a) { return locked[a.ticker] == null; });
      var lockedSum = covered.reduce(function (s, a) {
        return s + (locked[a.ticker] != null ? locked[a.ticker] : 0);
      }, 0);
      var budget = Math.max(0, feasibleTotal - lockedSum);
      var desireSum = openNames.reduce(function (s, a) { return s + desire[a.ticker]; }, 0);
      if (!openNames.length || desireSum <= 0) break;

      openNames.forEach(function (a) { a.targetWeight = desire[a.ticker] / desireSum * budget; });

      // Lock any name exceeding the single-position ceiling.
      var newlyLocked = false;
      openNames.forEach(function (a) {
        if (a.targetWeight > posLimit + 1e-9) {
          locked[a.ticker] = posLimit;
          a.targetWeight = posLimit;
          a.positionCapped = true;
          if (capsBinding.indexOf(a.ticker) === -1) capsBinding.push(a.ticker);
          newlyLocked = true;
        }
      });
      if (newlyLocked) continue;

      // Sector ceiling: scale the sector down and lock every member at its share.
      var bySector = {};
      covered.forEach(function (a) {
        var s = a.sector || 'Unknown';
        (bySector[s] = bySector[s] || []).push(a);
      });
      var sectorViolated = false;
      Object.keys(bySector).forEach(function (s) {
        if (sectorViolated) return;
        var members = bySector[s];
        var tot = members.reduce(function (acc, a) { return acc + a.targetWeight; }, 0);
        var lim = MAX_SECTOR;
        if (tot > lim + 1e-9) {
          var scale = lim / tot;
          members.forEach(function (a) {
            a.targetWeight = a.targetWeight * scale;
            locked[a.ticker] = a.targetWeight;
            a.sectorCapped = true;
          });
          if (capsBinding.indexOf(s + ' (sector)') === -1) capsBinding.push(s + ' (sector)');
          sectorViolated = true;
        }
      });
      if (!sectorViolated) break;
    }

    /* If the caps make `gross` unreachable — e.g. 5 holdings under a 15% cap can
       hold at most 75% — say so rather than silently under-allocating. The
       shortfall becomes cash, which is the honest answer: the portfolio does not
       contain enough distinct names to carry the intended exposure prudently. */
    var achieved = covered.reduce(function (s, a) { return s + a.targetWeight; }, 0);
    var capShortfall = Math.max(0, gross - achieved);

    actions.forEach(function (a) {
      if (!a.covered) return;
      a.delta = a.targetWeight - a.currentWeight;
      a.dollarDelta = a.delta * totalMV;
      a.action = Math.abs(a.delta) < 0.015 ? 'Hold' : a.delta > 0 ? 'Add' : 'Trim';
    });

    var cashTarget = Math.max(0, 1 - gross) + capShortfall;

    return {
      actions: actions.sort(function (a, b) { return (b.composite || -99) - (a.composite || -99); }),
      ranked: ranked,
      grossTarget: gross,
      cashTarget: cashTarget,
      regime: regime,
      totalMV: totalMV,
      model: ranked.model,
      rationale: sig && sig.view ? sig.view.thesis : null,
      // Explicit link back to the unified view so the numbers are traceable.
      maxPosition: MAX_POSITION, maxSector: MAX_SECTOR,
      capsBinding: capsBinding,
      capShortfall: capShortfall,
      capShortfallNote: capShortfall > 0.01
        ? 'Diversification caps make the ' + Math.round(gross * 100) + '% gross target unreachable with only ' +
          covered.length + ' covered position' + (covered.length === 1 ? '' : 's') + ' — at ' +
          Math.round(MAX_POSITION * 100) + '% per name the maximum is ' +
          Math.round(Math.min(1, covered.length * MAX_POSITION) * 100) + '%. The remaining ' +
          Math.round(capShortfall * 100) + '% is held in cash. Adding more names would let the portfolio ' +
          'carry its intended exposure without concentrating risk.'
        : null,
      derivation: 'Target weights start from the regime-weighted factor composite, are tilted by forward Sharpe ' +
        '(CAPM expected return over measured volatility, bounded to ±35%), capped at ' +
        Math.round(MAX_POSITION * 100) + '% per position and ' + Math.round(MAX_SECTOR * 100) +
        '% per sector, then rescaled to the ' + Math.round(gross * 100) +
        '% gross exposure set by the unified signal engine' +
        (cashTarget > 0.01 ? ', leaving ' + Math.round(cashTarget * 100) + '% in cash' : '') + '.' +
        (capsBinding.length
          ? ' Diversification caps are currently binding on ' + capsBinding.join(', ') +
            ' — the model wanted a larger weight than prudent sizing allows.'
          : '')
    };
  };

  window.PerryML = ML;
})();
