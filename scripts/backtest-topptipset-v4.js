'use strict';

/**
 * backtest-topptipset-v4.js
 *
 * V4 STRATEGY: EV-Ranked Row Selection with CORRECT house cut (28%, not 35%)
 *
 * Key insight: Data audit showed actual house cut = 28.1% (return rate 71.9%).
 * This lowers the breakeven threshold from 1.538 to 1.389.
 *
 * EV per row = (P_market(row) / P_public(row)) × (1 - houseCut) - 1
 * = edge_product(row) × 0.719 - 1
 *
 * Only play rows where EV > 0, i.e., edge_product > 1.389
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { normalizeDatabaseUrl } = require('./lib/rapidapi-topptipset');

const CONFIG = {
  databaseUrl: process.env.DATABASE_URL,
  outputDir: path.resolve(process.cwd(), 'reports'),
  houseCutPct: 28.1,  // CORRECTED from 35%! Verified from actual turnover/payout data.
  costPerRow: 1,
};

const HOUSE_FACTOR = 1 - CONFIG.houseCutPct / 100; // 0.65
const SIGNS = ['1', 'X', '2'];

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadHistory(pool) {
  const result = await pool.query(`
    SELECT
      d.draw_number, d.draw_code,
      d.first_match_start AS draw_start,
      d.svenska_spel_result_amount AS actual_payout,
      d.svenska_spel_result_winners AS payout_winners,
      d.svenska_spel_result_turnover AS turnover,
      e.event_number,
      e.outcome AS actual_outcome,
      e.market_pct_home, e.market_pct_draw, e.market_pct_away,
      e.public_pct_home, e.public_pct_draw, e.public_pct_away
    FROM tipsxtra_topptipset_events e
    JOIN tipsxtra_topptipset_complete_real_payout_draws d ON d.draw_number = e.draw_number
    WHERE e.public_pct_home > 0 AND e.public_pct_draw > 0 AND e.public_pct_away > 0
    ORDER BY d.first_match_start ASC, d.draw_number ASC, e.event_number ASC
  `);

  const grouped = new Map();
  for (const row of result.rows) {
    if (!grouped.has(row.draw_number)) {
      grouped.set(row.draw_number, {
        drawNumber: Number(row.draw_number),
        actualPayout: Number(row.actual_payout),
        payoutWinners: row.payout_winners != null ? Number(row.payout_winners) : null,
        turnover: row.turnover != null ? Number(row.turnover) : null,
        drawStart: row.draw_start,
        events: [],
      });
    }
    grouped.get(row.draw_number).events.push(row);
  }

  return [...grouped.values()]
    .filter(d => d.events.length === 8)
    .map(d => {
      const events = d.events.sort((a, b) => Number(a.event_number) - Number(b.event_number));
      const actualOutcomes = events.map(e => e.actual_outcome);
      if (actualOutcomes.some(o => !['1', 'X', '2'].includes(o))) return null;

      // Precompute per-sign edge ratios for each match
      const matchEdges = events.map(e => {
        const mH = Number(e.market_pct_home), mD = Number(e.market_pct_draw), mA = Number(e.market_pct_away);
        const pH = Number(e.public_pct_home), pD = Number(e.public_pct_draw), pA = Number(e.public_pct_away);
        return {
          '1': { marketProb: mH / 100, publicProb: pH / 100, edge: mH / Math.max(pH, 0.1) },
          'X': { marketProb: mD / 100, publicProb: pD / 100, edge: mD / Math.max(pD, 0.1) },
          '2': { marketProb: mA / 100, publicProb: pA / 100, edge: mA / Math.max(pA, 0.1) },
        };
      });

      return { ...d, matchEdges, actualOutcomes, events: undefined };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.drawStart) - new Date(b.drawStart) || a.drawNumber - b.drawNumber);
}

// ---------------------------------------------------------------------------
// Row enumeration and ranking
// ---------------------------------------------------------------------------

/**
 * For each match, compute the edge for each sign.
 * A row's edge_product = product of per-sign edges.
 * A row's EV = edge_product * 0.65 - 1
 *
 * Instead of enumerating all 6561 rows (expensive per draw × thousands of draws),
 * we use a smarter approach:
 *
 * The edge_product of a row = product_i(edge_i(sign_i))
 * To find rows with edge_product > threshold, we can:
 * 1. For each match, sort signs by edge (desc)
 * 2. Use branch-and-bound: prune branches where max possible remaining edge < threshold
 */

function findPositiveEVRows(matchEdges, minEdgeProduct, maxRows) {
  const rows = [];
  const matchCount = matchEdges.length;

  // For each match, precompute sorted signs by edge (descending)
  const sortedSigns = matchEdges.map(me =>
    SIGNS.map(s => ({ sign: s, edge: me[s].edge, marketProb: me[s].marketProb }))
      .sort((a, b) => b.edge - a.edge)
  );

  // Precompute max possible edge product from position i onward
  // = product of best edge per remaining match
  const maxRemainingEdge = new Array(matchCount + 1);
  maxRemainingEdge[matchCount] = 1;
  for (let i = matchCount - 1; i >= 0; i--) {
    maxRemainingEdge[i] = maxRemainingEdge[i + 1] * sortedSigns[i][0].edge;
  }

  function recurse(matchIdx, currentRow, currentEdgeProduct) {
    if (rows.length >= maxRows) return;

    if (matchIdx === matchCount) {
      if (currentEdgeProduct >= minEdgeProduct) {
        // Calculate market probability for this row
        let marketProb = 1;
        for (let i = 0; i < matchCount; i++) {
          marketProb *= matchEdges[i][currentRow[i]].marketProb;
        }
        rows.push({
          signs: [...currentRow],
          edgeProduct: currentEdgeProduct,
          ev: currentEdgeProduct * HOUSE_FACTOR - 1,
          marketProb,
        });
      }
      return;
    }

    for (const { sign, edge } of sortedSigns[matchIdx]) {
      const newProduct = currentEdgeProduct * edge;
      // Prune: can this branch reach the threshold?
      if (newProduct * maxRemainingEdge[matchIdx + 1] < minEdgeProduct) {
        continue; // All remaining branches are worse
      }
      currentRow.push(sign);
      recurse(matchIdx + 1, currentRow, newProduct);
      currentRow.pop();
    }
  }

  recurse(0, [], 1);

  // Sort by EV descending
  rows.sort((a, b) => b.ev - a.ev);
  return rows;
}

// ---------------------------------------------------------------------------
// Strategy execution
// ---------------------------------------------------------------------------

function executeV3Strategy(draw, config) {
  const positiveEVRows = findPositiveEVRows(
    draw.matchEdges,
    config.minEdgeProduct,
    config.maxRows
  );

  if (positiveEVRows.length < config.minPositiveEVRows) {
    return { isPlayable: false, reason: 'not_enough_ev_rows' };
  }

  // Select top N rows by EV
  const selectedRows = positiveEVRows.slice(0, config.maxRows);
  const totalRows = selectedRows.length;
  const totalCost = totalRows * CONFIG.costPerRow;

  // Check if any selected row matches actual outcome
  const actualKey = draw.actualOutcomes.join(',');
  let winningRowIdx = -1;
  let winningRowEV = 0;
  for (let i = 0; i < selectedRows.length; i++) {
    if (selectedRows[i].signs.join(',') === actualKey) {
      winningRowIdx = i;
      winningRowEV = selectedRows[i].ev;
      break;
    }
  }

  const isWin = winningRowIdx >= 0;
  const revenue = isWin ? draw.actualPayout : 0;
  const profit = revenue - totalCost;

  // Stats about the selected rows
  const avgEV = selectedRows.reduce((s, r) => s + r.ev, 0) / totalRows;
  const avgEdgeProduct = selectedRows.reduce((s, r) => s + r.edgeProduct, 0) / totalRows;
  const totalMarketProb = selectedRows.reduce((s, r) => s + r.marketProb, 0);

  return {
    isPlayable: true,
    drawNumber: draw.drawNumber,
    totalRows,
    totalCost,
    positiveEVRowCount: positiveEVRows.length,
    selectedRowCount: totalRows,
    avgEV,
    avgEdgeProduct,
    totalMarketProb,
    isWin,
    winningRowIdx,
    winningRowEV,
    revenue,
    profit,
    bestRowEV: selectedRows[0]?.ev || 0,
    worstRowEV: selectedRows[selectedRows.length - 1]?.ev || 0,
  };
}

// ---------------------------------------------------------------------------
// Config grid
// ---------------------------------------------------------------------------

function buildConfigGrid() {
  const configs = [];

  // minEdgeProduct thresholds (must be > 1/0.719 = 1.391 for positive EV at 28.1% cut)
  const minEdgeProducts = [1.391, 1.45, 1.538, 1.6, 1.8, 2.0, 2.5];
  const maxRowsList = [5, 10, 20, 50, 100, 200, 500];
  const minPositiveEVRowsList = [1, 3, 5, 10];

  for (const minEP of minEdgeProducts) {
    for (const maxR of maxRowsList) {
      for (const minPEV of minPositiveEVRowsList) {
        configs.push({
          minEdgeProduct: minEP,
          maxRows: maxR,
          minPositiveEVRows: minPEV,
        });
      }
    }
  }

  return configs;
}

// ---------------------------------------------------------------------------
// Backtest
// ---------------------------------------------------------------------------

function runBacktest(draws, config) {
  const results = [];
  let totalCost = 0, totalRevenue = 0, wins = 0, played = 0, skipped = 0;

  for (const draw of draws) {
    const result = executeV3Strategy(draw, config);
    if (!result.isPlayable) { skipped++; continue; }

    played++;
    totalCost += result.totalCost;
    totalRevenue += result.revenue;
    if (result.isWin) wins++;
    results.push(result);
  }

  const totalProfit = totalRevenue - totalCost;
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
    avgEVRowCount: played > 0 ? results.reduce((s, r) => s + r.positiveEVRowCount, 0) / played : 0,
    avgSelectedRows: played > 0 ? results.reduce((s, r) => s + r.totalRows, 0) / played : 0,
    avgMarketProb: played > 0 ? results.reduce((s, r) => s + r.totalMarketProb, 0) / played : 0,
    results,
  };
}

function chooseBestConfig(draws, configGrid) {
  let bestScore = -Infinity;
  let bestResult = null;

  for (const config of configGrid) {
    const m = runBacktest(draws, config);
    if (m.played < 10) continue;

    // Score: ROI adjusted for volume
    const volFactor = Math.min(m.played, 50) / 50;
    const score = m.roi * volFactor;

    if (score > bestScore) {
      bestScore = score;
      bestResult = { config, metrics: m };
    }
  }
  return bestResult;
}

// ---------------------------------------------------------------------------
// Walk-forward
// ---------------------------------------------------------------------------

async function main() {
  const configGrid = buildConfigGrid();
  const now = new Date();
  const runLabel = `topptipset-v4-${now.toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;

  console.log(`\n=== Topptipset V4 EV-Ranked (28.1% house cut) ===`);
  console.log(`Run: ${runLabel}`);
  console.log(`Config grid: ${configGrid.length} configs`);
  console.log(`House cut: ${CONFIG.houseCutPct}% → breakeven edge: ${(1/(1-CONFIG.houseCutPct/100)).toFixed(3)}`);

  const pool = new Pool({ connectionString: normalizeDatabaseUrl(CONFIG.databaseUrl) });
  let allDraws;
  try { allDraws = await loadHistory(pool); }
  finally { await pool.end(); }
  console.log(`Loaded ${allDraws.length} draws`);

  // Walk-forward windows
  const trainSize = 400, valSize = 200, testSize = 100, step = 100;
  const windows = [];
  for (let vs = trainSize; vs + valSize + testSize <= allDraws.length; vs += step) {
    windows.push({
      validation: allDraws.slice(vs, vs + valSize),
      test: allDraws.slice(vs + valSize, vs + valSize + testSize),
    });
  }
  console.log(`Windows: ${windows.length}`);

  const foldResults = [];
  const allTestResults = [];

  for (let fi = 0; fi < windows.length; fi++) {
    const w = windows[fi];
    const best = chooseBestConfig(w.validation, configGrid);
    if (!best) { console.log(`Fold ${fi+1}: no viable config`); continue; }

    const test = runBacktest(w.test, best.config);
    console.log(
      `Fold ${fi+1}/${windows.length}: ` +
      `minEP=${best.config.minEdgeProduct} maxR=${best.config.maxRows} minPEV=${best.config.minPositiveEVRows} | ` +
      `val: ${best.metrics.played}p ${best.metrics.wins}w ROI=${(best.metrics.roi*100).toFixed(1)}% | ` +
      `test: ${test.played}p ${test.wins}w ROI=${(test.roi*100).toFixed(1)}% profit=${test.totalProfit.toFixed(0)}kr`
    );

    allTestResults.push(...test.results);
    foldResults.push({
      foldIndex: fi, bestConfig: best.config,
      valMetrics: { played: best.metrics.played, wins: best.metrics.wins, roi: best.metrics.roi, totalProfit: best.metrics.totalProfit },
      testMetrics: { played: test.played, wins: test.wins, skipped: test.skipped, roi: test.roi, totalCost: test.totalCost, totalRevenue: test.totalRevenue, totalProfit: test.totalProfit, maxDD: test.maxDrawdown, avgRows: test.avgSelectedRows, avgEVRows: test.avgEVRowCount },
    });
  }

  // Aggregate
  const tp = allTestResults.length;
  const tw = allTestResults.filter(r => r.isWin).length;
  const tc = allTestResults.reduce((s, r) => s + r.totalCost, 0);
  const tr = allTestResults.reduce((s, r) => s + r.revenue, 0);

  let peak = 0, maxDD = 0, run = 0;
  const curve = [];
  for (const r of allTestResults) {
    run += r.profit;
    peak = Math.max(peak, run);
    maxDD = Math.max(maxDD, peak - run);
    curve.push({ dn: r.drawNumber, cp: +run.toFixed(2), p: +r.profit.toFixed(2), w: r.isWin, rows: r.totalRows, evRows: r.positiveEVRowCount });
  }

  const agg = {
    totalPlayed: tp, totalWins: tw,
    hitRate: tp > 0 ? +(tw/tp).toFixed(4) : 0,
    totalCost: +tc.toFixed(2), totalRevenue: +tr.toFixed(2), totalProfit: +(tr-tc).toFixed(2),
    roi: tc > 0 ? +((tr-tc)/tc).toFixed(4) : 0,
    maxDrawdown: +maxDD.toFixed(2),
    avgCostPerPlay: tp > 0 ? +(tc/tp).toFixed(2) : 0,
    avgWinPayout: tw > 0 ? +(tr/tw).toFixed(2) : 0,
  };

  console.log('\n=== AGGREGATE V4 TEST RESULTS ===');
  console.log(JSON.stringify(agg, null, 2));

  // If any wins, show details
  if (tw > 0) {
    console.log('\n=== WINNING PLAYS ===');
    allTestResults.filter(r => r.isWin).forEach(r => {
      console.log(`  Draw ${r.drawNumber}: ${r.totalRows} rows, cost=${r.totalCost}kr, payout=${r.revenue}kr, profit=${r.profit.toFixed(0)}kr, EV=${r.winningRowEV.toFixed(3)}, edgeProd=${(r.revenue > 0 ? r.winningRowEV + 1 : 0).toFixed(3)}, evRows=${r.positiveEVRowCount}, rank=${r.winningRowIdx+1}`);
    });
  }

  fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  const rp = path.join(CONFIG.outputDir, `${runLabel}.json`);
  fs.writeFileSync(rp, JSON.stringify({ summary: { runLabel, agg }, foldResults, curve }, null, 2));
  console.log(`\nReport: ${rp}`);
}

main().catch(err => { console.error(err); process.exit(1); });
