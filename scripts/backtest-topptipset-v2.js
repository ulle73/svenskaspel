'use strict';

/**
 * backtest-topptipset-v2.js
 *
 * V2 STRATEGY: Hybrid Contrarian System Play
 *
 * Key insight from data analysis:
 * - EV(row) = P_true(row) / P_public(row) × (1 - houseCut) - 1
 * - Market probs are well-calibrated (P_true ≈ market)
 * - Edge comes from public MISPRICING, not from better probability estimation
 *
 * Strategy:
 * 1. BASE ROW: market favorite per match (highest accuracy: 51.9%)
 * 2. HEDGE: add contrarian sign (high edge = market/public) on selected matches
 * 3. FILTER: only play draws where total system has estimated positive EV
 * 4. SIZE: use fewer rows (8-32) to keep costs low
 *
 * The trick: gardering with the contrarian sign CAPTURES high-payout contrarian
 * outcomes while the base row maintains high probability coverage.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const { normalizeDatabaseUrl } = require('./lib/rapidapi-topptipset');

const CONFIG = {
  databaseUrl: process.env.DATABASE_URL,
  trainDraws: Number(process.env.V2_TRAIN_DRAWS || 400),
  validationDraws: Number(process.env.V2_VALIDATION_DRAWS || 200),
  testDraws: Number(process.env.V2_TEST_DRAWS || 100),
  stepDraws: Number(process.env.V2_STEP_DRAWS || 100),
  outputDir: path.resolve(process.cwd(), process.env.V2_OUTPUT_DIR || 'reports'),
  houseCutPct: 35,
  costPerRow: 1,
};

if (!CONFIG.databaseUrl) {
  console.error('FATAL: DATABASE_URL saknas i .env');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Data loading (same as v1 but simplified)
// ---------------------------------------------------------------------------

async function loadHistory(pool) {
  const result = await pool.query(`
    SELECT
      d.draw_number,
      d.draw_code,
      d.first_match_start AS draw_start,
      d.svenska_spel_result_amount AS actual_payout,
      d.svenska_spel_result_winners AS payout_winners,
      d.svenska_spel_result_turnover AS turnover,
      e.event_number,
      e.home_team, e.away_team,
      e.outcome AS actual_outcome,
      e.market_pct_home, e.market_pct_draw, e.market_pct_away,
      e.public_pct_home, e.public_pct_draw, e.public_pct_away,
      e.market_odds_home, e.market_odds_draw, e.market_odds_away
    FROM tipsxtra_topptipset_events e
    JOIN tipsxtra_topptipset_complete_real_payout_draws d
      ON d.draw_number = e.draw_number
    WHERE e.public_pct_home > 0 AND e.public_pct_draw > 0 AND e.public_pct_away > 0
    ORDER BY d.first_match_start ASC, d.draw_number ASC, e.event_number ASC
  `);

  const grouped = new Map();
  for (const row of result.rows) {
    if (!grouped.has(row.draw_number)) {
      grouped.set(row.draw_number, {
        drawNumber: Number(row.draw_number),
        drawCode: Number(row.draw_code),
        drawStart: row.draw_start,
        actualPayout: Number(row.actual_payout),
        payoutWinners: row.payout_winners != null ? Number(row.payout_winners) : null,
        turnover: row.turnover != null ? Number(row.turnover) : null,
        events: [],
      });
    }
    grouped.get(row.draw_number).events.push(row);
  }

  return [...grouped.values()]
    .filter(draw => draw.events.length === 8)
    .map(draw => {
      const matches = draw.events
        .sort((a, b) => Number(a.event_number) - Number(b.event_number))
        .map(e => {
          const mH = Number(e.market_pct_home);
          const mD = Number(e.market_pct_draw);
          const mA = Number(e.market_pct_away);
          const pH = Number(e.public_pct_home);
          const pD = Number(e.public_pct_draw);
          const pA = Number(e.public_pct_away);

          // Edge per sign = market_pct / public_pct
          const edges = {
            '1': mH / Math.max(pH, 0.1),
            'X': mD / Math.max(pD, 0.1),
            '2': mA / Math.max(pA, 0.1),
          };

          // Market probabilities (true probs)
          const marketProbs = {
            '1': mH / 100,
            'X': mD / 100,
            '2': mA / 100,
          };

          // Public probabilities (determines payout)
          const publicProbs = {
            '1': pH / 100,
            'X': pD / 100,
            '2': pA / 100,
          };

          // Rank signs by market probability (descending)
          const signsByProb = Object.entries(marketProbs)
            .sort(([, a], [, b]) => b - a)
            .map(([sign]) => sign);

          // Rank signs by edge (descending)
          const signsByEdge = Object.entries(edges)
            .sort(([, a], [, b]) => b - a)
            .map(([sign]) => sign);

          return {
            eventNumber: Number(e.event_number),
            homeTeam: e.home_team,
            awayTeam: e.away_team,
            actualOutcome: e.actual_outcome,
            edges,
            marketProbs,
            publicProbs,
            signsByProb,
            signsByEdge,
            marketFavorite: signsByProb[0],
            bestEdgeSign: signsByEdge[0],
            bestEdge: edges[signsByEdge[0]],
            favoriteEdge: edges[signsByProb[0]],
          };
        });

      const actualOutcomes = matches.map(m => m.actualOutcome);
      if (actualOutcomes.some(o => !o || !['1', 'X', '2'].includes(o))) return null;

      return { ...draw, matches, actualOutcomes, events: undefined };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.drawStart !== b.drawStart) return new Date(a.drawStart) - new Date(b.drawStart);
      return a.drawNumber - b.drawNumber;
    });
}

// ---------------------------------------------------------------------------
// V2 Strategy: Hybrid Contrarian System Play
// ---------------------------------------------------------------------------

/**
 * Build a system for a draw based on a config.
 *
 * Config parameters:
 * - maxHedges: max number of matches to hedge (determines max rows: 2^maxHedges)
 * - minHedgeEdge: minimum edge ratio to qualify a match for hedging
 * - minDrawEdgeProduct: minimum product of edges across all picks to play
 * - hedgeStrategy: 'contrarian' (add best-edge sign) or 'second_prob' (add 2nd most probable)
 * - playMode: 'always' or 'selective' (only play when minDrawEdgeProduct met)
 */
function buildSystem(draw, config) {
  const matches = draw.matches;

  // Step 1: For each match, determine base pick and potential hedge
  const matchPlans = matches.map(m => {
    const basePick = m.marketFavorite;
    const baseEdge = m.edges[basePick];

    // Determine hedge sign
    let hedgeSign, hedgeEdge;
    if (config.hedgeStrategy === 'contrarian') {
      // Hedge with the highest-edge sign that ISN'T the base pick
      const candidates = Object.entries(m.edges)
        .filter(([sign]) => sign !== basePick)
        .sort(([, a], [, b]) => b - a);
      hedgeSign = candidates[0][0];
      hedgeEdge = candidates[0][1];
    } else {
      // Hedge with 2nd most probable
      hedgeSign = m.signsByProb[1];
      hedgeEdge = m.edges[hedgeSign];
    }

    // Should we hedge this match?
    const shouldHedge = hedgeEdge >= config.minHedgeEdge;

    // EV contribution of hedging: adds hedgeSign probability but costs more rows
    // The key: hedging INCREASES total win probability AND potentially increases EV
    // if the hedge sign has high edge (underbetted)
    const hedgeEVBenefit = hedgeEdge * m.marketProbs[hedgeSign]; // rough EV gain

    return {
      basePick,
      baseEdge,
      baseProb: m.marketProbs[basePick],
      hedgeSign,
      hedgeEdge,
      hedgeProb: m.marketProbs[hedgeSign],
      shouldHedge,
      hedgeEVBenefit,
      match: m,
    };
  });

  // Step 2: Select which matches to hedge
  // Sort by hedge EV benefit, take top N
  const hedgeCandidates = matchPlans
    .filter(mp => mp.shouldHedge)
    .sort((a, b) => b.hedgeEVBenefit - a.hedgeEVBenefit);

  const hedgeCount = Math.min(hedgeCandidates.length, config.maxHedges);
  const hedgeSet = new Set(hedgeCandidates.slice(0, hedgeCount).map(mp => mp.match.eventNumber));

  // Step 3: Build gardings
  const gardings = matchPlans.map(mp => {
    if (hedgeSet.has(mp.match.eventNumber)) {
      return [mp.basePick, mp.hedgeSign];
    }
    return [mp.basePick];
  });

  // Step 4: Calculate system metrics
  const totalRows = gardings.reduce((prod, g) => prod * g.length, 1);

  // Calculate EV: for each row, EV = P_true(row) / P_public(row) * (1 - cut) - 1
  // Fast calculation:
  // totalWinProb = product of (sum of selected marketProbs per match)
  // For EV we need: sum over all rows of [product(marketProbs) / product(publicProbs)] * (1-cut) - totalRows
  // = (1-cut) * product_i(sum over selected signs of marketProb/publicProb per sign) - totalRows
  // Wait, that's not quite right. Let me think...
  //
  // Each row r has: EV(r) = prod_i(marketProb_i(sign_r_i)) / prod_i(publicProb_i(sign_r_i)) * (1-cut) - 1
  // Total EV = sum_r EV(r) = (1-cut) * sum_r prod_i(edge_i(sign_r_i)) - totalRows
  // And sum_r prod_i(edge_i(sign_r_i)) = prod_i(sum over selected signs of edge_i(sign))
  // This is because rows are the cartesian product!

  const edgeProduct = gardings.reduce((prod, signs, i) => {
    const matchEdgeSum = signs.reduce((s, sign) => s + matches[i].edges[sign], 0);
    return prod * matchEdgeSum;
  }, 1);

  const houseFactor = 1 - CONFIG.houseCutPct / 100;
  const totalEV = houseFactor * edgeProduct - totalRows;
  const evPerRow = totalRows > 0 ? totalEV / totalRows : 0;
  const evROI = totalRows > 0 ? totalEV / totalRows : 0; // Same as evPerRow for unit cost

  // Total win probability
  const totalWinProb = gardings.reduce((prod, signs, i) => {
    const probSum = signs.reduce((s, sign) => s + matches[i].marketProbs[sign], 0);
    return prod * probSum;
  }, 1);

  // Should we play?
  const isPlayable = config.playMode === 'always' ||
    (edgeProduct >= config.minDrawEdgeProduct && totalRows <= config.maxTotalRows);

  return {
    gardings,
    totalRows,
    totalCost: totalRows * CONFIG.costPerRow,
    totalWinProb,
    edgeProduct,
    totalEV,
    evPerRow,
    evROI,
    isPlayable,
    hedgeCount,
    matchPlans,
  };
}

// ---------------------------------------------------------------------------
// Backtest evaluation
// ---------------------------------------------------------------------------

function evaluateSystemActual(gardings, actualOutcomes, actualPayout) {
  // Check if all correct signs are in gardings
  for (let i = 0; i < gardings.length; i++) {
    if (!gardings[i].includes(actualOutcomes[i])) {
      return { winningRows: 0, revenue: 0, profit: -gardings.reduce((p, g) => p * g.length, 1) * CONFIG.costPerRow };
    }
  }
  // Exactly 1 winning row
  const totalRows = gardings.reduce((p, g) => p * g.length, 1);
  const totalCost = totalRows * CONFIG.costPerRow;
  return { winningRows: 1, revenue: actualPayout, profit: actualPayout - totalCost };
}

function runBacktest(draws, config) {
  const results = [];
  let totalCost = 0;
  let totalRevenue = 0;
  let wins = 0;
  let played = 0;
  let skipped = 0;

  for (const draw of draws) {
    const system = buildSystem(draw, config);

    if (!system.isPlayable) {
      skipped++;
      continue;
    }

    played++;
    const actual = evaluateSystemActual(system.gardings, draw.actualOutcomes, draw.actualPayout);
    totalCost += system.totalCost;
    totalRevenue += actual.revenue;
    if (actual.winningRows > 0) wins++;

    results.push({
      drawNumber: draw.drawNumber,
      totalRows: system.totalRows,
      totalCost: system.totalCost,
      hedges: system.hedgeCount,
      edgeProduct: system.edgeProduct,
      evROI: system.evROI,
      totalWinProb: system.totalWinProb,
      isWin: actual.winningRows > 0,
      revenue: actual.revenue,
      profit: actual.profit,
      gardings: system.gardings.map(g => g.join('')),
    });
  }

  const totalProfit = totalRevenue - totalCost;

  // Drawdown
  let peak = 0, maxDD = 0, running = 0;
  for (const r of results) {
    running += r.profit;
    peak = Math.max(peak, running);
    maxDD = Math.max(maxDD, peak - running);
  }

  return {
    played, skipped, wins,
    hitRate: played > 0 ? wins / played : 0,
    totalCost, totalRevenue, totalProfit,
    roi: totalCost > 0 ? totalProfit / totalCost : 0,
    maxDrawdown: maxDD,
    avgCostPerPlay: played > 0 ? totalCost / played : 0,
    avgRowsPerPlay: played > 0 ? results.reduce((s, r) => s + r.totalRows, 0) / played : 0,
    avgEdgeProduct: played > 0 ? results.reduce((s, r) => s + r.edgeProduct, 0) / played : 0,
    avgEVROI: played > 0 ? results.reduce((s, r) => s + r.evROI, 0) / played : 0,
    results,
  };
}

// ---------------------------------------------------------------------------
// Config grid
// ---------------------------------------------------------------------------

function buildConfigGrid() {
  const configs = [];

  const maxHedgesList = [2, 3, 4, 5];
  const minHedgeEdges = [1.0, 1.05, 1.10, 1.15, 1.20];
  const minDrawEdgeProducts = [0, 1.0, 1.2, 1.4, 1.538];
  const hedgeStrategies = ['contrarian', 'second_prob'];
  const playModes = ['always', 'selective'];

  for (const maxHedges of maxHedgesList) {
    for (const minHedgeEdge of minHedgeEdges) {
      for (const minDrawEdgeProduct of minDrawEdgeProducts) {
        for (const hedgeStrategy of hedgeStrategies) {
          for (const playMode of playModes) {
            if (playMode === 'always' && minDrawEdgeProduct > 0) continue; // skip redundant
            configs.push({
              maxHedges,
              maxTotalRows: Math.pow(2, maxHedges), // 4, 8, 16, 32
              minHedgeEdge,
              minDrawEdgeProduct: playMode === 'selective' ? minDrawEdgeProduct : 0,
              hedgeStrategy,
              playMode,
            });
          }
        }
      }
    }
  }

  return configs;
}

function chooseBestConfig(draws, configGrid) {
  let bestScore = -Infinity;
  let bestResult = null;

  for (const config of configGrid) {
    const metrics = runBacktest(draws, config);

    // Score: prioritize positive ROI with enough volume
    // Penalize if too few plays (< 20)
    const volumeFactor = Math.min(metrics.played, 50) / 50;
    const score = metrics.roi * volumeFactor + metrics.hitRate * 0.1;

    if (score > bestScore && metrics.played >= 10) {
      bestScore = score;
      bestResult = { config, metrics };
    }
  }

  return bestResult;
}

// ---------------------------------------------------------------------------
// Walk-forward
// ---------------------------------------------------------------------------

function buildWindows(draws) {
  const windows = [];
  const minNeeded = CONFIG.trainDraws + CONFIG.validationDraws + CONFIG.testDraws;
  if (draws.length < minNeeded) return windows;

  for (
    let valStart = CONFIG.trainDraws;
    valStart + CONFIG.validationDraws + CONFIG.testDraws <= draws.length;
    valStart += CONFIG.stepDraws
  ) {
    const valEnd = valStart + CONFIG.validationDraws;
    const testEnd = valEnd + CONFIG.testDraws;
    windows.push({
      validation: draws.slice(valStart, valEnd),
      test: draws.slice(valEnd, testEnd),
    });
  }
  return windows;
}

function buildRunLabel() {
  const now = new Date();
  return `topptipset-v2-${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
}

async function main() {
  const runLabel = buildRunLabel();
  const configGrid = buildConfigGrid();

  console.log(`\n=== Topptipset V2 Hybrid Contrarian Backtest ===`);
  console.log(`Run: ${runLabel}`);
  console.log(`Config grid: ${configGrid.length} configs`);

  const pool = new Pool({ connectionString: normalizeDatabaseUrl(CONFIG.databaseUrl) });
  let allDraws;
  try { allDraws = await loadHistory(pool); }
  finally { await pool.end(); }

  console.log(`Loaded ${allDraws.length} draws`);

  const windows = buildWindows(allDraws);
  console.log(`Walk-forward windows: ${windows.length}`);

  if (!windows.length) { console.error('Not enough data'); process.exit(1); }

  const foldResults = [];
  const allTestResults = [];

  for (let fi = 0; fi < windows.length; fi++) {
    const w = windows[fi];
    const best = chooseBestConfig(w.validation, configGrid);

    if (!best) {
      console.log(`Fold ${fi+1}: No viable config found`);
      continue;
    }

    const testMetrics = runBacktest(w.test, best.config);
    console.log(
      `Fold ${fi+1}/${windows.length}: ` +
      `hedges=${best.config.maxHedges} minEdge=${best.config.minHedgeEdge} ` +
      `minProd=${best.config.minDrawEdgeProduct} ${best.config.hedgeStrategy} ${best.config.playMode} | ` +
      `val: ${best.metrics.played}p ${best.metrics.wins}w ROI=${(best.metrics.roi*100).toFixed(1)}% | ` +
      `test: ${testMetrics.played}p ${testMetrics.wins}w ROI=${(testMetrics.roi*100).toFixed(1)}% profit=${testMetrics.totalProfit.toFixed(0)}kr`
    );

    allTestResults.push(...testMetrics.results);
    foldResults.push({
      foldIndex: fi,
      bestConfig: best.config,
      validationMetrics: {
        played: best.metrics.played, wins: best.metrics.wins,
        hitRate: best.metrics.hitRate, roi: best.metrics.roi,
        totalProfit: best.metrics.totalProfit, avgEdgeProduct: best.metrics.avgEdgeProduct,
      },
      testMetrics: {
        played: testMetrics.played, wins: testMetrics.wins, skipped: testMetrics.skipped,
        hitRate: testMetrics.hitRate, roi: testMetrics.roi,
        totalCost: testMetrics.totalCost, totalRevenue: testMetrics.totalRevenue,
        totalProfit: testMetrics.totalProfit, maxDrawdown: testMetrics.maxDrawdown,
        avgRowsPerPlay: testMetrics.avgRowsPerPlay, avgEdgeProduct: testMetrics.avgEdgeProduct,
      },
    });
  }

  // Aggregate
  const totalPlayed = allTestResults.length;
  const totalWins = allTestResults.filter(r => r.isWin).length;
  const totalCost = allTestResults.reduce((s, r) => s + r.totalCost, 0);
  const totalRevenue = allTestResults.reduce((s, r) => s + r.revenue, 0);
  const totalProfit = totalRevenue - totalCost;

  let peak = 0, maxDD = 0, running = 0;
  const profitCurve = [];
  for (const r of allTestResults) {
    running += r.profit;
    peak = Math.max(peak, running);
    maxDD = Math.max(maxDD, peak - running);
    profitCurve.push({ drawNumber: r.drawNumber, cumProfit: +running.toFixed(2), profit: +r.profit.toFixed(2), isWin: r.isWin, rows: r.totalRows });
  }

  const summary = {
    runLabel, totalDraws: allDraws.length, foldCount: foldResults.length,
    aggregate: {
      totalPlayed, totalWins,
      hitRate: totalPlayed > 0 ? +(totalWins/totalPlayed).toFixed(4) : 0,
      totalCost: +totalCost.toFixed(2), totalRevenue: +totalRevenue.toFixed(2),
      totalProfit: +totalProfit.toFixed(2),
      roi: totalCost > 0 ? +(totalProfit/totalCost).toFixed(4) : 0,
      maxDrawdown: +maxDD.toFixed(2),
      avgCostPerPlay: totalPlayed > 0 ? +(totalCost/totalPlayed).toFixed(2) : 0,
    },
  };

  console.log('\n=== AGGREGATE V2 TEST RESULTS ===');
  console.log(JSON.stringify(summary.aggregate, null, 2));

  // Save
  fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  const reportPath = path.join(CONFIG.outputDir, `${runLabel}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ summary, foldResults, profitCurve }, null, 2));
  console.log(`Report: ${reportPath}`);

  const csvPath = path.join(CONFIG.outputDir, `${runLabel}-plays.csv`);
  const csvLines = ['draw_number,rows,cost,hedges,edge_product,ev_roi,win_prob,is_win,revenue,profit,cum_profit'];
  let cum = 0;
  for (const r of allTestResults) {
    cum += r.profit;
    csvLines.push([r.drawNumber, r.totalRows, r.totalCost, r.hedges, r.edgeProduct.toFixed(4), r.evROI.toFixed(4), r.totalWinProb.toFixed(6), r.isWin?1:0, r.revenue, r.profit.toFixed(2), cum.toFixed(2)].join(','));
  }
  fs.writeFileSync(csvPath, csvLines.join('\n'));
  console.log(`CSV: ${csvPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
