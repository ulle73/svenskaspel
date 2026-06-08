'use strict';

/**
 * backtest-topptipset-system.js
 *
 * Walk-forward backtest for Topptipset using SYSTEM PLAY (garderingar).
 *
 * Key differences from the old singelrads-backtest:
 * 1. Generates 5-128 rows per draw (instead of 1)
 * 2. Optimizes garderingar greedily based on EV
 * 3. Uses actual Svenska Spel payouts for profit calculation
 * 4. Tracks cumulative profit curve and drawdown
 * 5. Uses market probabilities as the "true" probabilities (they're well-calibrated)
 *    and public streck for payout estimation (the pool division basis)
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const { normalizeDatabaseUrl } = require('./lib/rapidapi-topptipset');
const strategy = require('./lib/strategy-system-play');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  databaseUrl: process.env.DATABASE_URL,
  trainDraws: Number(process.env.SYSTEM_BACKTEST_TRAIN_DRAWS || 500),
  validationDraws: Number(process.env.SYSTEM_BACKTEST_VALIDATION_DRAWS || 200),
  testDraws: Number(process.env.SYSTEM_BACKTEST_TEST_DRAWS || 100),
  stepDraws: Number(process.env.SYSTEM_BACKTEST_STEP_DRAWS || 100),
  outputDir: path.resolve(process.cwd(), process.env.SYSTEM_BACKTEST_OUTPUT_DIR || 'reports'),
  houseCutPct: Number(process.env.SYSTEM_BACKTEST_HOUSE_CUT || 35),
  costPerRow: Number(process.env.SYSTEM_BACKTEST_COST_PER_ROW || 1),
};

if (!CONFIG.databaseUrl) {
  console.error('FATAL: DATABASE_URL saknas i .env');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Config grid for strategy hyperparameters
// ---------------------------------------------------------------------------

function buildConfigGrid() {
  const configs = [];

  const maxRowsList = [8, 16, 32, 64];
  const maxSignsList = [2, 3];
  const minSystemEVs = [-0.1, 0, 0.1, 0.3];
  // probSource: 'market' uses market odds as true prob, 'blend' mixes with model
  const probSources = ['market', 'blend_light'];

  for (const maxRows of maxRowsList) {
    for (const maxSigns of maxSignsList) {
      for (const minEV of minSystemEVs) {
        for (const probSource of probSources) {
          configs.push({
            maxRows,
            maxSignsPerMatch: maxSigns,
            minSystemEV: minEV,
            probSource,
          });
        }
      }
    }
  }

  return configs;
}

// ---------------------------------------------------------------------------
// Data loading
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
      e.home_team,
      e.away_team,
      e.match_start,
      e.outcome AS actual_outcome,
      e.expert_tip,
      e.market_odds_home,
      e.market_odds_draw,
      e.market_odds_away,
      e.market_pct_home,
      e.market_pct_draw,
      e.market_pct_away,
      e.public_odds_home,
      e.public_odds_draw,
      e.public_odds_away,
      e.public_pct_home,
      e.public_pct_draw,
      e.public_pct_away,
      e.newspaper_home,
      e.newspaper_draw,
      e.newspaper_away,
      e.market_diff_pct,
      e.public_diff_pct
    FROM tipsxtra_topptipset_events e
    JOIN tipsxtra_topptipset_complete_real_payout_draws d
      ON d.draw_number = e.draw_number
    ORDER BY d.first_match_start ASC, d.draw_number ASC, e.event_number ASC
  `);

  // Group by draw
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

  // Process into structured draws
  return [...grouped.values()]
    .map(draw => {
      if (draw.events.length !== 8) return null;

      const matches = draw.events
        .sort((a, b) => Number(a.event_number) - Number(b.event_number))
        .map(e => ({
          eventNumber: Number(e.event_number),
          homeTeam: e.home_team,
          awayTeam: e.away_team,
          actualOutcome: e.actual_outcome,
          expertTip: e.expert_tip,
          marketProbs: {
            home: Number(e.market_pct_home) / 100,
            draw: Number(e.market_pct_draw) / 100,
            away: Number(e.market_pct_away) / 100,
          },
          publicPcts: {
            home: Number(e.public_pct_home),
            draw: Number(e.public_pct_draw),
            away: Number(e.public_pct_away),
          },
          marketOdds: {
            home: Number(e.market_odds_home),
            draw: Number(e.market_odds_draw),
            away: Number(e.market_odds_away),
          },
          publicOdds: {
            home: Number(e.public_odds_home),
            draw: Number(e.public_odds_draw),
            away: Number(e.public_odds_away),
          },
          newspaperTips: {
            home: Number(e.newspaper_home || 0),
            draw: Number(e.newspaper_draw || 0),
            away: Number(e.newspaper_away || 0),
          },
          marketDiffPct: Number(e.market_diff_pct || 0),
          publicDiffPct: Number(e.public_diff_pct || 0),
        }));

      const actualOutcomes = matches.map(m => m.actualOutcome);
      if (actualOutcomes.some(o => !o || !['1', 'X', '2'].includes(o))) return null;

      return {
        ...draw,
        matches,
        actualOutcomes,
        events: undefined, // Remove raw events
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.drawStart !== b.drawStart) return new Date(a.drawStart) - new Date(b.drawStart);
      return a.drawNumber - b.drawNumber;
    });
}

// ---------------------------------------------------------------------------
// Probability model (simplified — uses market odds as truth, with optional light blend)
// ---------------------------------------------------------------------------

/**
 * Build match probabilities based on the selected probSource.
 * 
 * 'market': Use market odds probabilities directly (well-calibrated per our audit)
 * 'blend_light': 90% market + 10% bias-corrected public
 */
function buildMatchProbabilities(match, probSource) {
  const mp = match.marketProbs;

  if (probSource === 'market') {
    return mp;
  }

  if (probSource === 'blend_light') {
    const pp = {
      home: match.publicPcts.home / 100,
      draw: match.publicPcts.draw / 100,
      away: match.publicPcts.away / 100,
    };
    // Light blend: mostly market, slightly informed by public
    const blended = {
      home: 0.9 * mp.home + 0.1 * pp.home,
      draw: 0.9 * mp.draw + 0.1 * pp.draw,
      away: 0.9 * mp.away + 0.1 * pp.away,
    };
    // Normalize
    const total = blended.home + blended.draw + blended.away;
    return {
      home: blended.home / total,
      draw: blended.draw / total,
      away: blended.away / total,
    };
  }

  return mp;
}

// ---------------------------------------------------------------------------
// Strategy execution for a single draw
// ---------------------------------------------------------------------------

function executeStrategy(draw, config) {
  const matchProbs = draw.matches.map(m => buildMatchProbabilities(m, config.probSource));
  const publicDists = draw.matches.map(m => m.publicPcts);

  // Estimate expected payout for this draw
  // Use the favorites row as a proxy for expected payout
  const rankedSigns = strategy.rankSignsByProbability(matchProbs);
  const favoriteRow = rankedSigns.map(s => s[0].sign);
  const favPayoutEst = strategy.estimatePayoutForRow(publicDists, favoriteRow, CONFIG.houseCutPct);

  // Use a rough average payout estimate
  // Better: use median historical payout adjusted for overround
  const avgPayoutEstimate = draw.actualPayout || favPayoutEst.expectedPayout;

  // Optimize gardings
  const optimized = strategy.optimizeGardings(
    matchProbs,
    avgPayoutEstimate,
    CONFIG.costPerRow,
    {
      maxRows: config.maxRows,
      maxSignsPerMatch: config.maxSignsPerMatch,
      minSystemEV: config.minSystemEV,
    }
  );

  // Evaluate with payout estimation
  const evalWithPayout = strategy.evaluateSystemWithPayout(
    optimized.gardings,
    matchProbs,
    publicDists,
    CONFIG.costPerRow,
    CONFIG.houseCutPct
  );

  // Evaluate against actual outcome
  const actualEval = strategy.evaluateSystemActual(
    optimized.gardings,
    draw.actualOutcomes,
    draw.actualPayout,
    CONFIG.costPerRow
  );

  return {
    drawNumber: draw.drawNumber,
    drawCode: draw.drawCode,
    gardings: optimized.gardings.map(g => g.join('')),
    totalRows: actualEval.totalRows,
    totalCost: actualEval.totalCost,
    expectedROI: evalWithPayout.expectedROI,
    expectedProfit: evalWithPayout.expectedProfit,
    totalWinProb: evalWithPayout.totalWinProb,
    actualWinningRows: actualEval.winningRows,
    actualPayout: draw.actualPayout,
    actualRevenue: actualEval.revenue,
    actualProfit: actualEval.profit,
    actualROI: actualEval.roi,
    isWin: actualEval.isWin,
    isPlayable: optimized.isPlayable,
    config,
  };
}

// ---------------------------------------------------------------------------
// Walk-forward backtesting
// ---------------------------------------------------------------------------

function buildWindows(draws) {
  const windows = [];
  const minNeeded = CONFIG.trainDraws + CONFIG.validationDraws + CONFIG.testDraws;

  if (draws.length < minNeeded) {
    console.warn(`Only ${draws.length} draws available, need ${minNeeded}. Reducing window sizes.`);
    // Try with smaller windows
    const reduced = Math.floor(draws.length / 3);
    if (reduced < 50) return windows;
    // Use single window
    windows.push({
      train: draws.slice(0, reduced),
      validation: draws.slice(reduced, reduced * 2),
      test: draws.slice(reduced * 2),
    });
    return windows;
  }

  for (
    let valStart = CONFIG.trainDraws;
    valStart + CONFIG.validationDraws + CONFIG.testDraws <= draws.length;
    valStart += CONFIG.stepDraws
  ) {
    const valEnd = valStart + CONFIG.validationDraws;
    const testEnd = valEnd + CONFIG.testDraws;

    windows.push({
      train: draws.slice(Math.max(0, valStart - CONFIG.trainDraws), valStart),
      validation: draws.slice(valStart, valEnd),
      test: draws.slice(valEnd, testEnd),
    });
  }

  return windows;
}

function evaluateConfigOnDraws(draws, config) {
  const results = [];
  let totalCost = 0;
  let totalRevenue = 0;
  let wins = 0;
  let played = 0;

  for (const draw of draws) {
    const result = executeStrategy(draw, config);

    if (result.isPlayable) {
      played++;
      totalCost += result.totalCost;
      totalRevenue += result.actualRevenue;
      if (result.isWin) wins++;
      results.push(result);
    }
  }

  const totalProfit = totalRevenue - totalCost;
  const roi = totalCost > 0 ? totalProfit / totalCost : 0;
  const hitRate = played > 0 ? wins / played : 0;

  // Calculate drawdown
  let peak = 0;
  let maxDrawdown = 0;
  let running = 0;
  for (const r of results) {
    running += r.actualProfit;
    peak = Math.max(peak, running);
    maxDrawdown = Math.max(maxDrawdown, peak - running);
  }

  return {
    played,
    wins,
    hitRate,
    totalCost,
    totalRevenue,
    totalProfit,
    roi,
    maxDrawdown,
    avgCostPerDraw: played > 0 ? totalCost / played : 0,
    avgRowsPerDraw: played > 0 ? results.reduce((s, r) => s + r.totalRows, 0) / played : 0,
    avgExpectedROI: played > 0 ? results.reduce((s, r) => s + r.expectedROI, 0) / played : 0,
    results,
  };
}

function chooseBestConfig(validationDraws, configGrid) {
  const candidates = configGrid.map(config => {
    const metrics = evaluateConfigOnDraws(validationDraws, config);
    return { config, metrics };
  });

  // Filter configs with enough plays
  const minPlays = Math.max(20, validationDraws.length * 0.1);
  const viable = candidates.filter(c => c.metrics.played >= minPlays);
  const selectionPool = viable.length > 0 ? viable : candidates.filter(c => c.metrics.played >= 5);
  const finalPool = selectionPool.length > 0 ? selectionPool : candidates;

  // Sort by: ROI (primary), profit (secondary), hit rate (tertiary)
  // But also penalize extreme configs with very few plays
  finalPool.sort((a, b) => {
    // Prefer positive ROI with reasonable volume
    const aScore = a.metrics.roi * Math.min(a.metrics.played, 100) / 100;
    const bScore = b.metrics.roi * Math.min(b.metrics.played, 100) / 100;
    if (bScore !== aScore) return bScore - aScore;
    if (b.metrics.totalProfit !== a.metrics.totalProfit) return b.metrics.totalProfit - a.metrics.totalProfit;
    return b.metrics.hitRate - a.metrics.hitRate;
  });

  return finalPool[0];
}

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------

function buildRunLabel() {
  const now = new Date();
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ];
  return `topptipset-system-${parts.join('')}`;
}

async function main() {
  const runLabel = buildRunLabel();
  const configGrid = buildConfigGrid();

  console.log(`\n=== Topptipset System Backtest ===`);
  console.log(`Run: ${runLabel}`);
  console.log(`Config grid: ${configGrid.length} configs`);
  console.log(`Train: ${CONFIG.trainDraws}, Validation: ${CONFIG.validationDraws}, Test: ${CONFIG.testDraws}, Step: ${CONFIG.stepDraws}`);

  // Load data
  const pool = new Pool({ connectionString: normalizeDatabaseUrl(CONFIG.databaseUrl) });

  let allDraws;
  try {
    allDraws = await loadHistory(pool);
  } finally {
    await pool.end();
  }

  console.log(`Loaded ${allDraws.length} complete draws with real payouts`);

  // Build windows
  const windows = buildWindows(allDraws);
  console.log(`Walk-forward windows: ${windows.length}`);

  if (!windows.length) {
    console.error('No valid windows. Need more data.');
    process.exit(1);
  }

  // Run walk-forward
  const foldResults = [];
  const allTestResults = [];

  for (let fi = 0; fi < windows.length; fi++) {
    const window = windows[fi];
    console.log(`\nFold ${fi + 1}/${windows.length}: train=${window.train.length}, val=${window.validation.length}, test=${window.test.length}`);

    // Find best config on validation
    const best = chooseBestConfig(window.validation, configGrid);
    console.log(`  Best validation config: maxRows=${best.config.maxRows}, maxSigns=${best.config.maxSignsPerMatch}, minEV=${best.config.minSystemEV}, prob=${best.config.probSource}`);
    console.log(`  Validation: ${best.metrics.played} plays, ${best.metrics.wins} wins, hitRate=${(best.metrics.hitRate * 100).toFixed(1)}%, ROI=${(best.metrics.roi * 100).toFixed(1)}%, profit=${best.metrics.totalProfit.toFixed(0)} kr`);

    // Apply best config to test
    const testMetrics = evaluateConfigOnDraws(window.test, best.config);
    console.log(`  Test: ${testMetrics.played} plays, ${testMetrics.wins} wins, hitRate=${(testMetrics.hitRate * 100).toFixed(1)}%, ROI=${(testMetrics.roi * 100).toFixed(1)}%, profit=${testMetrics.totalProfit.toFixed(0)} kr`);

    allTestResults.push(...testMetrics.results);

    foldResults.push({
      foldIndex: fi,
      trainRange: [window.train[0].drawNumber, window.train[window.train.length - 1].drawNumber],
      valRange: [window.validation[0].drawNumber, window.validation[window.validation.length - 1].drawNumber],
      testRange: [window.test[0].drawNumber, window.test[window.test.length - 1].drawNumber],
      bestConfig: best.config,
      validationMetrics: {
        played: best.metrics.played,
        wins: best.metrics.wins,
        hitRate: best.metrics.hitRate,
        totalCost: best.metrics.totalCost,
        totalProfit: best.metrics.totalProfit,
        roi: best.metrics.roi,
        maxDrawdown: best.metrics.maxDrawdown,
        avgRowsPerDraw: best.metrics.avgRowsPerDraw,
      },
      testMetrics: {
        played: testMetrics.played,
        wins: testMetrics.wins,
        hitRate: testMetrics.hitRate,
        totalCost: testMetrics.totalCost,
        totalRevenue: testMetrics.totalRevenue,
        totalProfit: testMetrics.totalProfit,
        roi: testMetrics.roi,
        maxDrawdown: testMetrics.maxDrawdown,
        avgRowsPerDraw: testMetrics.avgRowsPerDraw,
      },
    });
  }

  // Aggregate results
  const totalPlayed = allTestResults.length;
  const totalWins = allTestResults.filter(r => r.isWin).length;
  const totalCost = allTestResults.reduce((s, r) => s + r.totalCost, 0);
  const totalRevenue = allTestResults.reduce((s, r) => s + r.actualRevenue, 0);
  const totalProfit = totalRevenue - totalCost;

  // Profit curve
  let peak = 0;
  let maxDD = 0;
  let running = 0;
  const profitCurve = [];
  for (const r of allTestResults) {
    running += r.actualProfit;
    peak = Math.max(peak, running);
    maxDD = Math.max(maxDD, peak - running);
    profitCurve.push({
      drawNumber: r.drawNumber,
      cumulativeProfit: Number(running.toFixed(2)),
      profit: Number(r.actualProfit.toFixed(2)),
      isWin: r.isWin,
      rows: r.totalRows,
      cost: r.totalCost,
    });
  }

  const summary = {
    runLabel,
    totalDraws: allDraws.length,
    foldCount: foldResults.length,
    aggregate: {
      totalPlayed,
      totalWins,
      hitRate: totalPlayed > 0 ? Number((totalWins / totalPlayed).toFixed(4)) : 0,
      totalCost: Number(totalCost.toFixed(2)),
      totalRevenue: Number(totalRevenue.toFixed(2)),
      totalProfit: Number(totalProfit.toFixed(2)),
      roi: totalCost > 0 ? Number((totalProfit / totalCost).toFixed(4)) : 0,
      maxDrawdown: Number(maxDD.toFixed(2)),
      avgCostPerDraw: totalPlayed > 0 ? Number((totalCost / totalPlayed).toFixed(2)) : 0,
    },
  };

  console.log('\n=== AGGREGATE TEST RESULTS ===');
  console.log(JSON.stringify(summary.aggregate, null, 2));

  // Save report
  fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  const reportPath = path.join(CONFIG.outputDir, `${runLabel}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ summary, foldResults, profitCurve }, null, 2));
  console.log(`\nReport saved: ${reportPath}`);

  // Save CSV of all test plays
  const csvPath = path.join(CONFIG.outputDir, `${runLabel}-plays.csv`);
  const csvHeader = 'draw_number,gardings,rows,cost,expected_roi,win_prob,is_win,payout,revenue,profit,cumulative_profit';
  const csvLines = [csvHeader];
  let cumProfit = 0;
  for (const r of allTestResults) {
    cumProfit += r.actualProfit;
    csvLines.push([
      r.drawNumber,
      `"${r.gardings.join(',')}"`,
      r.totalRows,
      r.totalCost,
      r.expectedROI.toFixed(4),
      r.totalWinProb.toFixed(6),
      r.isWin ? 1 : 0,
      r.actualPayout,
      r.actualRevenue,
      r.actualProfit.toFixed(2),
      cumProfit.toFixed(2),
    ].join(','));
  }
  fs.writeFileSync(csvPath, csvLines.join('\n'));
  console.log(`CSV saved: ${csvPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
