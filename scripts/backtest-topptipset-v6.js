'use strict';

/**
 * backtest-topptipset-v6.js
 *
 * V6:
 * - Full enumeration of all 3^8 = 6,561 rows per draw.
 * - maxRows is applied only after all rows are scored and sorted.
 * - Memory efficient: does not store selectedRows.
 * - Reuses ranked rows per draw/correctionFactor across configs.
 * - Uses train/holdout split.
 * - Selects strategy on train only.
 * - Tests ALL strategies on holdout.
 * - Focuses on robust strategy selection, not jackpot-overfit.
 *
 * Historical analysis/backtest only.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { normalizeDatabaseUrl } = require('./lib/rapidapi-topptipset');

const CONFIG = {
  databaseUrl: process.env.DATABASE_URL,
  outputDir: path.resolve(process.cwd(), 'reports'),

  houseCutPct: Number(process.env.TOPPTIPSET_HOUSE_CUT_PCT || 28.1),
  rowCost: Number(process.env.TOPPTIPSET_ROW_COST || 1),

  trainRatio: Number(process.env.TOPPTIPSET_V6_TRAIN_RATIO || 0.7),

  minTrainDrawsPlayed: Number(
    process.env.TOPPTIPSET_V6_MIN_TRAIN_DRAWS_PLAYED || 100
  ),

  minTrainWins: Number(process.env.TOPPTIPSET_V6_MIN_TRAIN_WINS || 8),

  maxAvgRowsForSelection: Number(
    process.env.TOPPTIPSET_V6_MAX_AVG_ROWS_FOR_SELECTION || 60
  ),

  maxRowsPerDrawHardCap: Number(
    process.env.TOPPTIPSET_V6_MAX_ROWS_HARD_CAP || 75
  ),

  progressEveryDraws: Number(
    process.env.TOPPTIPSET_V6_PROGRESS_EVERY_DRAWS || 250
  ),
};

const HOUSE_FACTOR = 1 - CONFIG.houseCutPct / 100;
const SIGNS = ['1', 'X', '2'];

const FIXED_CONFIGS = [
  {
    id: 'ep150_r30',
    minEdgeProduct: 1.5,
    maxRows: 30,
    minEstimatedRoi: 0,
    minMarketRowProb: 0,
  },
  {
    id: 'ep160_r30',
    minEdgeProduct: 1.6,
    maxRows: 30,
    minEstimatedRoi: 0,
    minMarketRowProb: 0,
  },
  {
    id: 'ep160_r50',
    minEdgeProduct: 1.6,
    maxRows: 50,
    minEstimatedRoi: 0,
    minMarketRowProb: 0,
  },
  {
    id: 'ep180_r30',
    minEdgeProduct: 1.8,
    maxRows: 30,
    minEstimatedRoi: 0,
    minMarketRowProb: 0,
  },
  {
    id: 'ep180_r50',
    minEdgeProduct: 1.8,
    maxRows: 50,
    minEstimatedRoi: 0,
    minMarketRowProb: 0,
  },
  {
    id: 'ep200_r50',
    minEdgeProduct: 2.0,
    maxRows: 50,
    minEstimatedRoi: 0,
    minMarketRowProb: 0,
  },

  // Slightly stricter estimated ROI versions.
  {
    id: 'ep160_r30_est10',
    minEdgeProduct: 1.6,
    maxRows: 30,
    minEstimatedRoi: 0.1,
    minMarketRowProb: 0,
  },
  {
    id: 'ep160_r50_est10',
    minEdgeProduct: 1.6,
    maxRows: 50,
    minEstimatedRoi: 0.1,
    minMarketRowProb: 0,
  },
  {
    id: 'ep180_r30_est10',
    minEdgeProduct: 1.8,
    maxRows: 30,
    minEstimatedRoi: 0.1,
    minMarketRowProb: 0,
  },
  {
    id: 'ep180_r50_est10',
    minEdgeProduct: 1.8,
    maxRows: 50,
    minEstimatedRoi: 0.1,
    minMarketRowProb: 0,
  },
];

const CORRECTION_FACTORS = [0.25, 0.35, 0.5, 0.75, 1];

if (!CONFIG.databaseUrl) {
  console.error('FATAL: DATABASE_URL saknas i .env');
  process.exit(1);
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pctToProb(value) {
  return Math.max(safeNumber(value) / 100, 1e-9);
}

function csvEscape(value) {
  if (value == null) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function actualKey(draw) {
  return draw.actualOutcomes.join('');
}

function compactRow(row) {
  if (!row) return null;

  return {
    key: row.key,
    marketRowProb: row.marketRowProb,
    publicRowProb: row.publicRowProb,
    edgeProduct: row.edgeProduct,
    naiveRoi: row.naiveRoi,
    estimatedWinners: row.estimatedWinners,
    estimatedPayout: row.estimatedPayout,
    estimatedRoi: row.estimatedRoi,
    correctionFactor: row.correctionFactor,
  };
}

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
      e.outcome AS actual_outcome,
      e.market_pct_home,
      e.market_pct_draw,
      e.market_pct_away,
      e.public_pct_home,
      e.public_pct_draw,
      e.public_pct_away
    FROM tipsxtra_topptipset_events e
    JOIN tipsxtra_topptipset_complete_real_payout_draws d
      ON d.draw_number = e.draw_number
    WHERE
      e.public_pct_home > 0
      AND e.public_pct_draw > 0
      AND e.public_pct_away > 0
      AND e.market_pct_home > 0
      AND e.market_pct_draw > 0
      AND e.market_pct_away > 0
      AND e.outcome IN ('1', 'X', '2')
      AND d.svenska_spel_result_amount IS NOT NULL
    ORDER BY d.first_match_start ASC, d.draw_number ASC, e.event_number ASC
  `);

  const grouped = new Map();

  for (const row of result.rows) {
    const drawNumber = Number(row.draw_number);

    if (!grouped.has(drawNumber)) {
      grouped.set(drawNumber, {
        drawNumber,
        drawCode: row.draw_code == null ? null : Number(row.draw_code),
        drawStart: row.draw_start,
        actualPayout: safeNumber(row.actual_payout),
        payoutWinners:
          row.payout_winners == null ? null : Number(row.payout_winners),
        turnover: row.turnover == null ? null : safeNumber(row.turnover),
        events: [],
      });
    }

    grouped.get(drawNumber).events.push(row);
  }

  return [...grouped.values()]
    .map((draw) => {
      const events = [...draw.events].sort(
        (a, b) => Number(a.event_number) - Number(b.event_number)
      );

      if (events.length !== 8) return null;

      const actualOutcomes = events.map((event) =>
        String(event.actual_outcome || '').trim().toUpperCase()
      );

      if (actualOutcomes.some((sign) => !SIGNS.includes(sign))) return null;

      const matches = events.map((event) => {
        const market = {
          '1': pctToProb(event.market_pct_home),
          X: pctToProb(event.market_pct_draw),
          '2': pctToProb(event.market_pct_away),
        };

        const publicProb = {
          '1': pctToProb(event.public_pct_home),
          X: pctToProb(event.public_pct_draw),
          '2': pctToProb(event.public_pct_away),
        };

        return {
          eventNumber: Number(event.event_number),
          homeTeam: event.home_team,
          awayTeam: event.away_team,
          actualOutcome: String(event.actual_outcome).trim().toUpperCase(),
          market,
          publicProb,
          edge: {
            '1': market['1'] / publicProb['1'],
            X: market.X / publicProb.X,
            '2': market['2'] / publicProb['2'],
          },
        };
      });

      return {
        ...draw,
        actualOutcomes,
        matches,
        events: undefined,
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        new Date(a.drawStart) - new Date(b.drawStart) ||
        a.drawNumber - b.drawNumber
    );
}

function enumerateAllRows(draw, correctionFactor) {
  const rows = [];

  const turnoverRows =
    draw.turnover && draw.turnover > 0
      ? draw.turnover / CONFIG.rowCost
      : null;

  const estimatedPrizePool =
    draw.turnover && draw.turnover > 0
      ? draw.turnover * HOUSE_FACTOR
      : null;

  for (let n = 0; n < 6561; n += 1) {
    let x = n;
    let key = '';

    let marketRowProb = 1;
    let publicRowProb = 1;
    let edgeProduct = 1;

    for (let i = 0; i < 8; i += 1) {
      const sign = SIGNS[x % 3];
      x = Math.floor(x / 3);

      const match = draw.matches[i];
      const marketProb = match.market[sign];
      const publicProb = match.publicProb[sign];
      const edge = match.edge[sign];

      key += sign;
      marketRowProb *= marketProb;
      publicRowProb *= publicProb;
      edgeProduct *= edge;
    }

    const naiveRoi = edgeProduct * HOUSE_FACTOR - 1;

    let estimatedWinners = null;
    let estimatedPayout = null;
    let estimatedRoi = naiveRoi;

    if (turnoverRows && estimatedPrizePool) {
      estimatedWinners = turnoverRows * publicRowProb * correctionFactor;
      estimatedPayout = estimatedPrizePool / Math.max(1, estimatedWinners);
      estimatedRoi =
        (marketRowProb * estimatedPayout - CONFIG.rowCost) / CONFIG.rowCost;
    }

    rows.push({
      key,
      marketRowProb,
      publicRowProb,
      edgeProduct,
      naiveRoi,
      estimatedWinners,
      estimatedPayout,
      estimatedRoi,
      correctionFactor,
    });
  }

  return rows;
}

function rankRows(draw, correctionFactor) {
  const rows = enumerateAllRows(draw, correctionFactor);

  rows.sort((a, b) => {
    if (b.estimatedRoi !== a.estimatedRoi) {
      return b.estimatedRoi - a.estimatedRoi;
    }

    if (b.edgeProduct !== a.edgeProduct) {
      return b.edgeProduct - a.edgeProduct;
    }

    return b.marketRowProb - a.marketRowProb;
  });

  const winKey = actualKey(draw);
  let winningRank = -1;
  let winningRow = null;

  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].key === winKey) {
      winningRank = i + 1;
      winningRow = rows[i];
      break;
    }
  }

  return {
    rows,
    winningRank,
    winningRow,
  };
}

function selectRowsFromRanked(draw, ranked, config, correctionFactor) {
  const maxRows = Math.min(config.maxRows, CONFIG.maxRowsPerDrawHardCap);
  const winKey = actualKey(draw);

  let eligibleRows = 0;
  let selectedCount = 0;
  let selectedWinningIndex = null;

  let bestSelectedRow = null;
  let worstSelectedRow = null;

  let totalSelectedMarketProb = 0;
  let selectedEstimatedRoiSum = 0;
  let selectedEdgeProductSum = 0;

  for (const row of ranked.rows) {
    if (row.edgeProduct < config.minEdgeProduct) continue;
    if (row.estimatedRoi < config.minEstimatedRoi) continue;
    if (row.marketRowProb < config.minMarketRowProb) continue;

    eligibleRows += 1;

    if (selectedCount < maxRows) {
      selectedCount += 1;

      if (!bestSelectedRow) bestSelectedRow = row;
      worstSelectedRow = row;

      totalSelectedMarketProb += row.marketRowProb;
      selectedEstimatedRoiSum += row.estimatedRoi;
      selectedEdgeProductSum += row.edgeProduct;

      if (row.key === winKey && selectedWinningIndex == null) {
        selectedWinningIndex = selectedCount;
      }
    }
  }

  if (selectedCount === 0) {
    return {
      playable: false,
      drawNumber: draw.drawNumber,
      reason: 'no_eligible_rows',
      winningRank: ranked.winningRank,
      winningRow: compactRow(ranked.winningRow),
    };
  }

  const isWin = selectedWinningIndex != null;
  const cost = selectedCount * CONFIG.rowCost;
  const revenue = isWin ? draw.actualPayout : 0;
  const profit = revenue - cost;

  return {
    playable: true,
    drawNumber: draw.drawNumber,
    drawCode: draw.drawCode,
    drawStart: draw.drawStart,
    actualKey: winKey,
    actualPayout: draw.actualPayout,
    payoutWinners: draw.payoutWinners,
    turnover: draw.turnover,

    correctionFactor,
    configId: config.id,
    minEdgeProduct: config.minEdgeProduct,
    maxRows: config.maxRows,
    minEstimatedRoi: config.minEstimatedRoi,
    minMarketRowProb: config.minMarketRowProb,

    totalRows: selectedCount,
    eligibleRows,
    cost,
    revenue,
    profit,
    isWin,

    selectedWinningIndex,
    winningRank: ranked.winningRank,
    winningRow: compactRow(ranked.winningRow),

    bestSelectedRow: compactRow(bestSelectedRow),
    worstSelectedRow: compactRow(worstSelectedRow),

    totalSelectedMarketProb,
    avgSelectedEstimatedRoi: selectedEstimatedRoiSum / selectedCount,
    avgSelectedEdgeProduct: selectedEdgeProductSum / selectedCount,
  };
}

function buildStrategies() {
  const strategies = [];

  for (const config of FIXED_CONFIGS) {
    for (const correctionFactor of CORRECTION_FACTORS) {
      strategies.push({
        id: `${config.id}_cf${String(correctionFactor).replace('.', '_')}`,
        config,
        correctionFactor,
      });
    }
  }

  return strategies;
}

function createMetric(strategy, collectPlays) {
  return {
    strategy,
    collectPlays,

    playedDraws: 0,
    skippedDraws: 0,
    wins: 0,

    totalCost: 0,
    totalRevenue: 0,
    totalProfit: 0,

    runningProfit: 0,
    peakProfit: 0,
    maxDrawdown: 0,

    rowsSum: 0,
    selectedMarketProbSum: 0,
    selectedEstimatedRoiSum: 0,

    plays: collectPlays ? [] : undefined,
    skipped: collectPlays ? [] : undefined,
  };
}

function updateMetric(metric, play) {
  if (!play.playable) {
    metric.skippedDraws += 1;

    if (metric.collectPlays) {
      metric.skipped.push({
        drawNumber: play.drawNumber,
        reason: play.reason,
        winningRank: play.winningRank,
      });
    }

    return;
  }

  metric.playedDraws += 1;
  metric.totalCost += play.cost;
  metric.totalRevenue += play.revenue;
  metric.totalProfit += play.profit;

  metric.rowsSum += play.totalRows;
  metric.selectedMarketProbSum += play.totalSelectedMarketProb;
  metric.selectedEstimatedRoiSum += play.avgSelectedEstimatedRoi;

  if (play.isWin) {
    metric.wins += 1;
  }

  metric.runningProfit += play.profit;
  metric.peakProfit = Math.max(metric.peakProfit, metric.runningProfit);
  metric.maxDrawdown = Math.max(
    metric.maxDrawdown,
    metric.peakProfit - metric.runningProfit
  );

  if (metric.collectPlays) {
    metric.plays.push(play);
  }
}

function finalizeMetric(metric) {
  const played = metric.playedDraws;
  const wins = metric.wins;

  return {
    strategy: metric.strategy,
    playedDraws: played,
    skippedDraws: metric.skippedDraws,
    wins,
    hitRate: played ? wins / played : 0,

    totalCost: metric.totalCost,
    totalRevenue: metric.totalRevenue,
    totalProfit: metric.totalProfit,
    roi: metric.totalCost ? metric.totalProfit / metric.totalCost : 0,

    maxDrawdown: metric.maxDrawdown,
    drawdownToCost: metric.totalCost ? metric.maxDrawdown / metric.totalCost : 0,
    avgRowsPerDraw: played ? metric.rowsSum / played : 0,
    avgRevenuePerWin: wins ? metric.totalRevenue / wins : 0,
    avgProfitPerDraw: played ? metric.totalProfit / played : 0,
    avgSelectedMarketProb: played ? metric.selectedMarketProbSum / played : 0,
    avgSelectedEstimatedRoi: played
      ? metric.selectedEstimatedRoiSum / played
      : 0,

    plays: metric.collectPlays ? metric.plays : undefined,
    skipped: metric.collectPlays ? metric.skipped : undefined,
  };
}

function evaluateStrategies(draws, strategies, options = {}) {
  const label = options.label || 'eval';
  const collectPlaysForStrategyId = options.collectPlaysForStrategyId || null;

  const byCorrectionFactor = new Map();

  for (const strategy of strategies) {
    if (!byCorrectionFactor.has(strategy.correctionFactor)) {
      byCorrectionFactor.set(strategy.correctionFactor, []);
    }

    byCorrectionFactor.get(strategy.correctionFactor).push(strategy);
  }

  const metricsByStrategyId = new Map();

  for (const strategy of strategies) {
    metricsByStrategyId.set(
      strategy.id,
      createMetric(strategy, strategy.id === collectPlaysForStrategyId)
    );
  }

  const correctionFactors = [...byCorrectionFactor.keys()].sort(
    (a, b) => a - b
  );

  for (const correctionFactor of correctionFactors) {
    const cfStrategies = byCorrectionFactor.get(correctionFactor);

    console.log(
      `[${label}] correctionFactor=${correctionFactor} strategies=${cfStrategies.length}`
    );

    for (let drawIndex = 0; drawIndex < draws.length; drawIndex += 1) {
      const draw = draws[drawIndex];
      const ranked = rankRows(draw, correctionFactor);

      for (const strategy of cfStrategies) {
        const play = selectRowsFromRanked(
          draw,
          ranked,
          strategy.config,
          correctionFactor
        );

        updateMetric(metricsByStrategyId.get(strategy.id), play);
      }

      if (
        CONFIG.progressEveryDraws > 0 &&
        (drawIndex + 1) % CONFIG.progressEveryDraws === 0
      ) {
        console.log(
          `[${label}] cf=${correctionFactor} processed ${drawIndex + 1}/${draws.length} draws`
        );
      }
    }
  }

  return [...metricsByStrategyId.values()].map(finalizeMetric);
}

function isRobustTrainCandidate(result) {
  return (
    result.playedDraws >= CONFIG.minTrainDrawsPlayed &&
    result.wins >= CONFIG.minTrainWins &&
    result.roi > 0 &&
    result.avgRowsPerDraw <= CONFIG.maxAvgRowsForSelection
  );
}

function chooseBestTrainResult(trainResults) {
  const robust = trainResults.filter(isRobustTrainCandidate);

  const fallback = trainResults.filter(
    (result) =>
      result.playedDraws >= CONFIG.minTrainDrawsPlayed &&
      result.wins >= Math.max(5, Math.floor(CONFIG.minTrainWins / 2)) &&
      result.avgRowsPerDraw <= CONFIG.maxAvgRowsForSelection
  );

  const selectionPool = robust.length
    ? robust
    : fallback.length
      ? fallback
      : trainResults;

  selectionPool.sort((a, b) => {
    // 1. ROI first, but only after filtering away high-volume/jackpot configs.
    if (b.roi !== a.roi) return b.roi - a.roi;

    // 2. Lower drawdown relative to cost.
    if (a.drawdownToCost !== b.drawdownToCost) {
      return a.drawdownToCost - b.drawdownToCost;
    }

    // 3. Lower row volume.
    if (a.avgRowsPerDraw !== b.avgRowsPerDraw) {
      return a.avgRowsPerDraw - b.avgRowsPerDraw;
    }

    // 4. More wins.
    if (b.wins !== a.wins) return b.wins - a.wins;

    // 5. Higher profit.
    return b.totalProfit - a.totalProfit;
  });

  return {
    selected: selectionPool[0],
    robustCandidateCount: robust.length,
    fallbackCandidateCount: fallback.length,
    selectionMode: robust.length ? 'robust' : fallback.length ? 'fallback' : 'unfiltered',
  };
}

function compactMetrics(result) {
  return {
    strategyId: result.strategy.id,
    config: result.strategy.config,
    correctionFactor: result.strategy.correctionFactor,
    playedDraws: result.playedDraws,
    skippedDraws: result.skippedDraws,
    wins: result.wins,
    hitRate: Number(result.hitRate.toFixed(6)),
    totalCost: Number(result.totalCost.toFixed(2)),
    totalRevenue: Number(result.totalRevenue.toFixed(2)),
    totalProfit: Number(result.totalProfit.toFixed(2)),
    roi: Number(result.roi.toFixed(6)),
    maxDrawdown: Number(result.maxDrawdown.toFixed(2)),
    drawdownToCost: Number(result.drawdownToCost.toFixed(6)),
    avgRowsPerDraw: Number(result.avgRowsPerDraw.toFixed(2)),
    avgRevenuePerWin: Number(result.avgRevenuePerWin.toFixed(2)),
    avgProfitPerDraw: Number(result.avgProfitPerDraw.toFixed(2)),
    avgSelectedMarketProb: Number(result.avgSelectedMarketProb.toFixed(8)),
    avgSelectedEstimatedRoi: Number(
      result.avgSelectedEstimatedRoi.toFixed(6)
    ),
  };
}

function writeResultsCsv(filePath, results, selectedStrategyId) {
  const header = [
    'selected',
    'strategy_id',
    'config_id',
    'correction_factor',
    'played_draws',
    'skipped_draws',
    'wins',
    'hit_rate',
    'total_cost',
    'total_revenue',
    'total_profit',
    'roi',
    'max_drawdown',
    'drawdown_to_cost',
    'avg_rows_per_draw',
    'avg_revenue_per_win',
    'avg_profit_per_draw',
    'avg_selected_market_prob',
    'avg_selected_estimated_roi',
  ];

  const lines = [header.join(',')];

  for (const result of results) {
    lines.push(
      [
        result.strategy.id === selectedStrategyId ? 1 : 0,
        result.strategy.id,
        result.strategy.config.id,
        result.strategy.correctionFactor,
        result.playedDraws,
        result.skippedDraws,
        result.wins,
        result.hitRate.toFixed(8),
        result.totalCost.toFixed(2),
        result.totalRevenue.toFixed(2),
        result.totalProfit.toFixed(2),
        result.roi.toFixed(8),
        result.maxDrawdown.toFixed(2),
        result.drawdownToCost.toFixed(8),
        result.avgRowsPerDraw.toFixed(4),
        result.avgRevenuePerWin.toFixed(2),
        result.avgProfitPerDraw.toFixed(4),
        result.avgSelectedMarketProb.toFixed(12),
        result.avgSelectedEstimatedRoi.toFixed(8),
      ]
        .map(csvEscape)
        .join(',')
    );
  }

  fs.writeFileSync(filePath, lines.join('\n'));
}

function writePlaysCsv(filePath, plays) {
  const header = [
    'draw_number',
    'draw_start',
    'config_id',
    'correction_factor',
    'actual_key',
    'is_win',
    'selected_rows',
    'eligible_rows',
    'cost',
    'revenue',
    'profit',
    'actual_payout',
    'turnover',
    'winning_rank',
    'selected_winning_index',
    'best_edge_product',
    'best_estimated_roi',
    'best_market_prob',
    'worst_edge_product',
    'worst_estimated_roi',
    'avg_selected_edge_product',
    'avg_selected_estimated_roi',
    'total_selected_market_prob',
  ];

  const lines = [header.join(',')];

  for (const play of plays) {
    lines.push(
      [
        play.drawNumber,
        play.drawStart,
        play.configId,
        play.correctionFactor,
        play.actualKey,
        play.isWin ? 1 : 0,
        play.totalRows,
        play.eligibleRows,
        play.cost.toFixed(2),
        play.revenue.toFixed(2),
        play.profit.toFixed(2),
        play.actualPayout.toFixed(2),
        play.turnover == null ? '' : play.turnover.toFixed(2),
        play.winningRank,
        play.selectedWinningIndex == null ? '' : play.selectedWinningIndex,
        play.bestSelectedRow?.edgeProduct == null
          ? ''
          : play.bestSelectedRow.edgeProduct.toFixed(8),
        play.bestSelectedRow?.estimatedRoi == null
          ? ''
          : play.bestSelectedRow.estimatedRoi.toFixed(8),
        play.bestSelectedRow?.marketRowProb == null
          ? ''
          : play.bestSelectedRow.marketRowProb.toFixed(12),
        play.worstSelectedRow?.edgeProduct == null
          ? ''
          : play.worstSelectedRow.edgeProduct.toFixed(8),
        play.worstSelectedRow?.estimatedRoi == null
          ? ''
          : play.worstSelectedRow.estimatedRoi.toFixed(8),
        play.avgSelectedEdgeProduct.toFixed(8),
        play.avgSelectedEstimatedRoi.toFixed(8),
        play.totalSelectedMarketProb.toFixed(12),
      ]
        .map(csvEscape)
        .join(',')
    );
  }

  fs.writeFileSync(filePath, lines.join('\n'));
}

function writeWinningRankCsv(filePath, draws, strategy) {
  const header = [
    'draw_number',
    'draw_start',
    'actual_key',
    'actual_payout',
    'turnover',
    'correction_factor',
    'winning_rank',
    'winning_edge_product',
    'winning_naive_roi',
    'winning_estimated_roi',
    'winning_market_prob',
    'winning_public_prob',
    'winning_estimated_winners',
    'winning_estimated_payout',
    'selected',
    'selected_index',
  ];

  const lines = [header.join(',')];

  for (let drawIndex = 0; drawIndex < draws.length; drawIndex += 1) {
    const draw = draws[drawIndex];
    const ranked = rankRows(draw, strategy.correctionFactor);
    const play = selectRowsFromRanked(
      draw,
      ranked,
      strategy.config,
      strategy.correctionFactor
    );

    const winningRow = play.winningRow;
    if (!winningRow) continue;

    lines.push(
      [
        draw.drawNumber,
        draw.drawStart,
        actualKey(draw),
        draw.actualPayout.toFixed(2),
        draw.turnover == null ? '' : draw.turnover.toFixed(2),
        strategy.correctionFactor,
        play.winningRank,
        winningRow.edgeProduct.toFixed(8),
        winningRow.naiveRoi.toFixed(8),
        winningRow.estimatedRoi.toFixed(8),
        winningRow.marketRowProb.toFixed(12),
        winningRow.publicRowProb.toFixed(12),
        winningRow.estimatedWinners == null
          ? ''
          : winningRow.estimatedWinners.toFixed(8),
        winningRow.estimatedPayout == null
          ? ''
          : winningRow.estimatedPayout.toFixed(2),
        play.isWin ? 1 : 0,
        play.selectedWinningIndex == null ? '' : play.selectedWinningIndex,
      ]
        .map(csvEscape)
        .join(',')
    );

    if (
      CONFIG.progressEveryDraws > 0 &&
      (drawIndex + 1) % CONFIG.progressEveryDraws === 0
    ) {
      console.log(
        `[winning-rank] processed ${drawIndex + 1}/${draws.length} holdout draws`
      );
    }
  }

  fs.writeFileSync(filePath, lines.join('\n'));
}

async function main() {
  const runStartedAt = new Date();
  const runLabel = `topptipset-v6-${runStartedAt
    .toISOString()
    .replace(/[^0-9]/g, '')
    .slice(0, 14)}`;

  console.log('\n=== Topptipset V6 robust strategy selection ===');
  console.log(`Run: ${runLabel}`);
  console.log(`House cut: ${CONFIG.houseCutPct}%`);
  console.log(`House factor: ${HOUSE_FACTOR.toFixed(4)}`);
  console.log(`Breakeven edge product: ${(1 / HOUSE_FACTOR).toFixed(4)}`);
  console.log(`Fixed configs: ${FIXED_CONFIGS.length}`);
  console.log(`Correction factors: ${CORRECTION_FACTORS.length}`);
  console.log(
    `Total strategies: ${FIXED_CONFIGS.length * CORRECTION_FACTORS.length}`
  );
  console.log(`Min train draws played: ${CONFIG.minTrainDrawsPlayed}`);
  console.log(`Min train wins: ${CONFIG.minTrainWins}`);
  console.log(`Max avg rows for selection: ${CONFIG.maxAvgRowsForSelection}`);
  console.log(`Max rows hard cap: ${CONFIG.maxRowsPerDrawHardCap}`);

  const pool = new Pool({
    connectionString: normalizeDatabaseUrl(CONFIG.databaseUrl),
  });

  let allDraws;

  try {
    allDraws = await loadHistory(pool);
  } finally {
    await pool.end();
  }

  if (!allDraws.length) {
    throw new Error('No historical draws loaded.');
  }

  const splitIndex = Math.floor(allDraws.length * CONFIG.trainRatio);
  const trainDraws = allDraws.slice(0, splitIndex);
  const holdoutDraws = allDraws.slice(splitIndex);

  console.log(`Loaded draws: ${allDraws.length}`);
  console.log(`Train/analysis draws: ${trainDraws.length}`);
  console.log(`Holdout draws: ${holdoutDraws.length}`);

  const strategies = buildStrategies();

  console.log('\n=== TRAIN / CONFIG SELECTION ===');

  const trainResults = evaluateStrategies(trainDraws, strategies, {
    label: 'train',
  });

  const selection = chooseBestTrainResult(trainResults);
  const bestTrain = selection.selected;

  const sortedTrainResults = [...trainResults].sort((a, b) => b.roi - a.roi);

  for (let i = 0; i < sortedTrainResults.length; i += 1) {
    const result = sortedTrainResults[i];

    console.log(
      `[train ${i + 1}/${sortedTrainResults.length}] ${result.strategy.id} ` +
        `played=${result.playedDraws} wins=${result.wins} ` +
        `ROI=${(result.roi * 100).toFixed(2)}% ` +
        `profit=${result.totalProfit.toFixed(0)} ` +
        `avgRows=${result.avgRowsPerDraw.toFixed(1)} ` +
        `robust=${isRobustTrainCandidate(result) ? 1 : 0}`
    );
  }

  console.log('\n=== SELECTED TRAIN STRATEGY ===');
  console.log(
    JSON.stringify(
      {
        selectionMode: selection.selectionMode,
        robustCandidateCount: selection.robustCandidateCount,
        fallbackCandidateCount: selection.fallbackCandidateCount,
        selected: compactMetrics(bestTrain),
      },
      null,
      2
    )
  );

  console.log('\n=== HOLDOUT / ALL STRATEGIES ===');

  const holdoutResults = evaluateStrategies(holdoutDraws, strategies, {
    label: 'holdout',
    collectPlaysForStrategyId: bestTrain.strategy.id,
  });

  const selectedHoldout = holdoutResults.find(
    (result) => result.strategy.id === bestTrain.strategy.id
  );

  if (!selectedHoldout) {
    throw new Error(`Selected strategy not found in holdout: ${bestTrain.strategy.id}`);
  }

  const sortedHoldoutResults = [...holdoutResults].sort((a, b) => b.roi - a.roi);

  for (let i = 0; i < sortedHoldoutResults.length; i += 1) {
    const result = sortedHoldoutResults[i];

    console.log(
      `[holdout ${i + 1}/${sortedHoldoutResults.length}] ${result.strategy.id} ` +
        `selected=${result.strategy.id === bestTrain.strategy.id ? 1 : 0} ` +
        `played=${result.playedDraws} wins=${result.wins} ` +
        `ROI=${(result.roi * 100).toFixed(2)}% ` +
        `profit=${result.totalProfit.toFixed(0)} ` +
        `avgRows=${result.avgRowsPerDraw.toFixed(1)}`
    );
  }

  fs.mkdirSync(CONFIG.outputDir, { recursive: true });

  const report = {
    runLabel,
    runStartedAt: runStartedAt.toISOString(),
    settings: {
      houseCutPct: CONFIG.houseCutPct,
      houseFactor: HOUSE_FACTOR,
      breakevenEdgeProduct: 1 / HOUSE_FACTOR,
      rowCost: CONFIG.rowCost,
      trainRatio: CONFIG.trainRatio,
      minTrainDrawsPlayed: CONFIG.minTrainDrawsPlayed,
      minTrainWins: CONFIG.minTrainWins,
      maxAvgRowsForSelection: CONFIG.maxAvgRowsForSelection,
      maxRowsPerDrawHardCap: CONFIG.maxRowsPerDrawHardCap,
      fixedConfigs: FIXED_CONFIGS,
      correctionFactors: CORRECTION_FACTORS,
    },
    data: {
      totalDraws: allDraws.length,
      trainDraws: trainDraws.length,
      holdoutDraws: holdoutDraws.length,
      firstDraw: allDraws[0]?.drawNumber,
      lastDraw: allDraws[allDraws.length - 1]?.drawNumber,
      trainRange: [
        trainDraws[0]?.drawNumber,
        trainDraws[trainDraws.length - 1]?.drawNumber,
      ],
      holdoutRange: [
        holdoutDraws[0]?.drawNumber,
        holdoutDraws[holdoutDraws.length - 1]?.drawNumber,
      ],
    },
    selection: {
      selectionMode: selection.selectionMode,
      robustCandidateCount: selection.robustCandidateCount,
      fallbackCandidateCount: selection.fallbackCandidateCount,
      selectedTrainStrategy: compactMetrics(bestTrain),
      selectedHoldoutResult: compactMetrics(selectedHoldout),
    },
    trainResults: sortedTrainResults.map((result) => ({
      selected: result.strategy.id === bestTrain.strategy.id,
      robustTrainCandidate: isRobustTrainCandidate(result),
      ...compactMetrics(result),
    })),
    holdoutResults: sortedHoldoutResults.map((result) => ({
      selected: result.strategy.id === bestTrain.strategy.id,
      ...compactMetrics(result),
    })),
  };

  const jsonPath = path.join(CONFIG.outputDir, `${runLabel}.json`);
  const trainCsvPath = path.join(CONFIG.outputDir, `${runLabel}-train-results.csv`);
  const holdoutCsvPath = path.join(CONFIG.outputDir, `${runLabel}-holdout-results.csv`);
  const selectedPlaysCsvPath = path.join(
    CONFIG.outputDir,
    `${runLabel}-selected-holdout-plays.csv`
  );
  const winningRankCsvPath = path.join(
    CONFIG.outputDir,
    `${runLabel}-selected-winning-row-ranking.csv`
  );

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  writeResultsCsv(trainCsvPath, sortedTrainResults, bestTrain.strategy.id);
  writeResultsCsv(holdoutCsvPath, sortedHoldoutResults, bestTrain.strategy.id);
  writePlaysCsv(selectedPlaysCsvPath, selectedHoldout.plays || []);
  writeWinningRankCsv(winningRankCsvPath, holdoutDraws, bestTrain.strategy);

  console.log('\n=== FINAL SELECTED HOLDOUT RESULT ===');
  console.log(JSON.stringify(compactMetrics(selectedHoldout), null, 2));

  console.log('\nReports written:');
  console.log(`- ${jsonPath}`);
  console.log(`- ${trainCsvPath}`);
  console.log(`- ${holdoutCsvPath}`);
  console.log(`- ${selectedPlaysCsvPath}`);
  console.log(`- ${winningRankCsvPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});