// // "use strict";

// // /**
// //  * backtest-topptipset-v5.js
// //  *
// //  * V5:
// //  * - Enumerates all 3^8 = 6,561 rows per draw.
// //  * - maxRows is applied only after all rows are scored and sorted.
// //  * - Uses fixed configs, chosen only on first 70% train/analysis split.
// //  * - Final 30% is holdout and never used for config selection.
// //  * - Writes:
// //  *   reports/topptipset-v5-<timestamp>.json
// //  *   reports/topptipset-v5-<timestamp>-holdout-plays.csv
// //  *   reports/topptipset-v5-<timestamp>-winning-row-ranking.csv
// //  *
// //  * This is a historical analysis/backtest script, not live betting advice.
// //  */

// // require("dotenv").config();

// // const fs = require("fs");
// // const path = require("path");
// // const { Pool } = require("pg");
// // const { normalizeDatabaseUrl } = require("./lib/rapidapi-topptipset");

// // const CONFIG = {
// //   databaseUrl: process.env.DATABASE_URL,
// //   outputDir: path.resolve(process.cwd(), "reports"),

// //   // Verified from V4 audit. If you later calculate a better per-era factor,
// //   // make this dynamic by draw/date.
// //   houseCutPct: Number(process.env.TOPPTIPSET_HOUSE_CUT_PCT || 28.1),

// //   // Historical Topptipset row cost in this backtest.
// //   rowCost: Number(process.env.TOPPTIPSET_ROW_COST || 1),

// //   trainRatio: Number(process.env.TOPPTIPSET_V5_TRAIN_RATIO || 0.7),

// //   // Keep holdout honest: choose config on train only.
// //   minTrainDrawsPlayed: Number(
// //     process.env.TOPPTIPSET_V5_MIN_TRAIN_DRAWS_PLAYED || 50,
// //   ),

// //   // Hard safety cap for very loose configs.
// //   maxRowsPerDrawHardCap: Number(
// //     process.env.TOPPTIPSET_V5_MAX_ROWS_HARD_CAP || 500,
// //   ),
// // };

// // const HOUSE_FACTOR = 1 - CONFIG.houseCutPct / 100;
// // const SIGNS = ["1", "X", "2"];

// // const FIXED_CONFIGS = [
// //   {
// //     id: "ep160_r50",
// //     minEdgeProduct: 1.6,
// //     maxRows: 50,
// //     minEstimatedRoi: 0.0,
// //     minMarketRowProb: 0,
// //   },
// //   {
// //     id: "ep160_r100",
// //     minEdgeProduct: 1.6,
// //     maxRows: 100,
// //     minEstimatedRoi: 0.0,
// //     minMarketRowProb: 0,
// //   },
// //   {
// //     id: "ep180_r50",
// //     minEdgeProduct: 1.8,
// //     maxRows: 50,
// //     minEstimatedRoi: 0.0,
// //     minMarketRowProb: 0,
// //   },
// //   {
// //     id: "ep180_r100",
// //     minEdgeProduct: 1.8,
// //     maxRows: 100,
// //     minEstimatedRoi: 0.0,
// //     minMarketRowProb: 0,
// //   },
// //   {
// //     id: "ep200_r100",
// //     minEdgeProduct: 2.0,
// //     maxRows: 100,
// //     minEstimatedRoi: 0.0,
// //     minMarketRowProb: 0,
// //   },
// //   {
// //     id: "ep200_r200",
// //     minEdgeProduct: 2.0,
// //     maxRows: 200,
// //     minEstimatedRoi: 0.0,
// //     minMarketRowProb: 0,
// //   },
// //   {
// //     id: "ep250_r200",
// //     minEdgeProduct: 2.5,
// //     maxRows: 200,
// //     minEstimatedRoi: 0.0,
// //     minMarketRowProb: 0,
// //   },
// //   {
// //     id: "ep250_r500",
// //     minEdgeProduct: 2.5,
// //     maxRows: 500,
// //     minEstimatedRoi: 0.0,
// //     minMarketRowProb: 0,
// //   },

// //   // Tighter variants. These are useful if the broad configs still overplay.
// //   {
// //     id: "ep160_r50_est10",
// //     minEdgeProduct: 1.6,
// //     maxRows: 50,
// //     minEstimatedRoi: 0.1,
// //     minMarketRowProb: 0,
// //   },
// //   {
// //     id: "ep180_r50_est10",
// //     minEdgeProduct: 1.8,
// //     maxRows: 50,
// //     minEstimatedRoi: 0.1,
// //     minMarketRowProb: 0,
// //   },
// //   {
// //     id: "ep200_r100_est15",
// //     minEdgeProduct: 2.0,
// //     maxRows: 100,
// //     minEstimatedRoi: 0.15,
// //     minMarketRowProb: 0,
// //   },
// //   {
// //     id: "ep250_r200_est20",
// //     minEdgeProduct: 2.5,
// //     maxRows: 200,
// //     minEstimatedRoi: 0.2,
// //     minMarketRowProb: 0,
// //   },

// //   // Frequency/variance filters.
// //   {
// //     id: "ep160_r50_prob00010",
// //     minEdgeProduct: 1.6,
// //     maxRows: 50,
// //     minEstimatedRoi: 0.0,
// //     minMarketRowProb: 0.0001,
// //   },
// //   {
// //     id: "ep180_r100_prob00008",
// //     minEdgeProduct: 1.8,
// //     maxRows: 100,
// //     minEstimatedRoi: 0.0,
// //     minMarketRowProb: 0.00008,
// //   },
// //   {
// //     id: "ep200_r100_prob00005",
// //     minEdgeProduct: 2.0,
// //     maxRows: 100,
// //     minEstimatedRoi: 0.0,
// //     minMarketRowProb: 0.00005,
// //   },
// // ];

// // const CORRECTION_FACTORS = [0.35, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

// // if (!CONFIG.databaseUrl) {
// //   console.error("FATAL: DATABASE_URL saknas i .env");
// //   process.exit(1);
// // }

// // function safeNumber(value, fallback = 0) {
// //   const parsed = Number(value);
// //   return Number.isFinite(parsed) ? parsed : fallback;
// // }

// // function pctToProb(value) {
// //   return Math.max(safeNumber(value) / 100, 1e-9);
// // }

// // function csvEscape(value) {
// //   if (value == null) return "";
// //   const str = String(value);
// //   if (/[",\n\r]/.test(str)) {
// //     return `"${str.replace(/"/g, '""')}"`;
// //   }
// //   return str;
// // }

// // function actualKey(draw) {
// //   return draw.actualOutcomes.join("");
// // }

// // function rowKey(row) {
// //   return row.signs.join("");
// // }

// // async function loadHistory(pool) {
// //   const result = await pool.query(`
// //     SELECT
// //       d.draw_number,
// //       d.draw_code,
// //       d.first_match_start AS draw_start,
// //       d.svenska_spel_result_amount AS actual_payout,
// //       d.svenska_spel_result_winners AS payout_winners,
// //       d.svenska_spel_result_turnover AS turnover,
// //       e.event_number,
// //       e.home_team,
// //       e.away_team,
// //       e.outcome AS actual_outcome,
// //       e.market_pct_home,
// //       e.market_pct_draw,
// //       e.market_pct_away,
// //       e.public_pct_home,
// //       e.public_pct_draw,
// //       e.public_pct_away
// //     FROM tipsxtra_topptipset_events e
// //     JOIN tipsxtra_topptipset_complete_real_payout_draws d
// //       ON d.draw_number = e.draw_number
// //     WHERE
// //       e.public_pct_home > 0
// //       AND e.public_pct_draw > 0
// //       AND e.public_pct_away > 0
// //       AND e.market_pct_home > 0
// //       AND e.market_pct_draw > 0
// //       AND e.market_pct_away > 0
// //       AND e.outcome IN ('1', 'X', '2')
// //       AND d.svenska_spel_result_amount IS NOT NULL
// //     ORDER BY d.first_match_start ASC, d.draw_number ASC, e.event_number ASC
// //   `);

// //   const grouped = new Map();

// //   for (const row of result.rows) {
// //     const drawNumber = Number(row.draw_number);

// //     if (!grouped.has(drawNumber)) {
// //       grouped.set(drawNumber, {
// //         drawNumber,
// //         drawCode: row.draw_code == null ? null : Number(row.draw_code),
// //         drawStart: row.draw_start,
// //         actualPayout: safeNumber(row.actual_payout),
// //         payoutWinners:
// //           row.payout_winners == null ? null : Number(row.payout_winners),
// //         turnover: row.turnover == null ? null : safeNumber(row.turnover),
// //         events: [],
// //       });
// //     }

// //     grouped.get(drawNumber).events.push(row);
// //   }

// //   return [...grouped.values()]
// //     .map((draw) => {
// //       const events = [...draw.events].sort(
// //         (a, b) => Number(a.event_number) - Number(b.event_number),
// //       );

// //       if (events.length !== 8) return null;

// //       const actualOutcomes = events.map((event) =>
// //         String(event.actual_outcome || "")
// //           .trim()
// //           .toUpperCase(),
// //       );
// //       if (actualOutcomes.some((sign) => !SIGNS.includes(sign))) return null;

// //       const matches = events.map((event) => {
// //         const market = {
// //           1: pctToProb(event.market_pct_home),
// //           X: pctToProb(event.market_pct_draw),
// //           2: pctToProb(event.market_pct_away),
// //         };

// //         const publicProb = {
// //           1: pctToProb(event.public_pct_home),
// //           X: pctToProb(event.public_pct_draw),
// //           2: pctToProb(event.public_pct_away),
// //         };

// //         return {
// //           eventNumber: Number(event.event_number),
// //           homeTeam: event.home_team,
// //           awayTeam: event.away_team,
// //           actualOutcome: String(event.actual_outcome).trim().toUpperCase(),
// //           market,
// //           publicProb,
// //           edge: {
// //             1: market["1"] / publicProb["1"],
// //             X: market.X / publicProb.X,
// //             2: market["2"] / publicProb["2"],
// //           },
// //         };
// //       });

// //       return {
// //         ...draw,
// //         actualOutcomes,
// //         matches,
// //         events: undefined,
// //       };
// //     })
// //     .filter(Boolean)
// //     .sort(
// //       (a, b) =>
// //         new Date(a.drawStart) - new Date(b.drawStart) ||
// //         a.drawNumber - b.drawNumber,
// //     );
// // }

// // /**
// //  * Enumerates all 6,561 rows.
// //  * No early cutoff. No branch pruning. maxRows is NOT used here.
// //  */
// // function enumerateAllRows(draw, correctionFactor) {
// //   const rows = [];
// //   const turnoverRows =
// //     draw.turnover && draw.turnover > 0 ? draw.turnover / CONFIG.rowCost : null;

// //   // This is a rough pool estimate. Actual Svenska Spel payout has category logic.
// //   // We use it only to rank/filter historically, then evaluate against actual 8-right payout.
// //   const estimatedPrizePool =
// //     draw.turnover && draw.turnover > 0 ? draw.turnover * HOUSE_FACTOR : null;

// //   for (let n = 0; n < 6561; n += 1) {
// //     let x = n;
// //     const signs = new Array(8);
// //     let marketRowProb = 1;
// //     let publicRowProb = 1;
// //     let edgeProduct = 1;

// //     for (let i = 0; i < 8; i += 1) {
// //       const sign = SIGNS[x % 3];
// //       x = Math.floor(x / 3);

// //       const match = draw.matches[i];
// //       const marketProb = match.market[sign];
// //       const publicProb = match.publicProb[sign];
// //       const edge = match.edge[sign];

// //       signs[i] = sign;
// //       marketRowProb *= marketProb;
// //       publicRowProb *= publicProb;
// //       edgeProduct *= edge;
// //     }

// //     const naiveRoi = edgeProduct * HOUSE_FACTOR - 1;

// //     let estimatedWinners = null;
// //     let estimatedPayout = null;
// //     let estimatedRoi = naiveRoi;

// //     if (turnoverRows && estimatedPrizePool) {
// //       estimatedWinners = turnoverRows * publicRowProb * correctionFactor;
// //       estimatedPayout = estimatedPrizePool / Math.max(1, estimatedWinners);
// //       estimatedRoi =
// //         (marketRowProb * estimatedPayout - CONFIG.rowCost) / CONFIG.rowCost;
// //     }

// //     rows.push({
// //       signs,
// //       key: signs.join(""),
// //       marketRowProb,
// //       publicRowProb,
// //       edgeProduct,
// //       naiveRoi,
// //       estimatedWinners,
// //       estimatedPayout,
// //       estimatedRoi,
// //       correctionFactor,
// //     });
// //   }

// //   return rows;
// // }

// // function rankRows(draw, correctionFactor) {
// //   const rows = enumerateAllRows(draw, correctionFactor);

// //   rows.sort((a, b) => {
// //     if (b.estimatedRoi !== a.estimatedRoi)
// //       return b.estimatedRoi - a.estimatedRoi;
// //     if (b.edgeProduct !== a.edgeProduct) return b.edgeProduct - a.edgeProduct;
// //     return b.marketRowProb - a.marketRowProb;
// //   });

// //   const winKey = actualKey(draw);
// //   let winningRank = -1;
// //   let winningRow = null;

// //   for (let i = 0; i < rows.length; i += 1) {
// //     if (rows[i].key === winKey) {
// //       winningRank = i + 1;
// //       winningRow = rows[i];
// //       break;
// //     }
// //   }

// //   return {
// //     rows,
// //     winningRank,
// //     winningRow,
// //   };
// // }

// // function selectRowsForDraw(draw, config, correctionFactor) {
// //   const ranked = rankRows(draw, correctionFactor);
// //   const maxRows = Math.min(config.maxRows, CONFIG.maxRowsPerDrawHardCap);

// //   const eligibleRows = ranked.rows.filter((row) => {
// //     if (row.edgeProduct < config.minEdgeProduct) return false;
// //     if (row.estimatedRoi < config.minEstimatedRoi) return false;
// //     if (row.marketRowProb < config.minMarketRowProb) return false;
// //     return true;
// //   });

// //   const selectedRows = eligibleRows.slice(0, maxRows);

// //   if (!selectedRows.length) {
// //     return {
// //       playable: false,
// //       drawNumber: draw.drawNumber,
// //       reason: "no_eligible_rows",
// //       winningRank: ranked.winningRank,
// //       winningRow: ranked.winningRow,
// //       selectedRows: [],
// //     };
// //   }

// //   const selectedKeys = new Set(selectedRows.map((row) => row.key));
// //   const winKey = actualKey(draw);
// //   const isWin = selectedKeys.has(winKey);

// //   const cost = selectedRows.length * CONFIG.rowCost;
// //   const revenue = isWin ? draw.actualPayout : 0;
// //   const profit = revenue - cost;

// //   const selectedWinningIndex = selectedRows.findIndex(
// //     (row) => row.key === winKey,
// //   );
// //   const selectedWinningRow =
// //     selectedWinningIndex >= 0 ? selectedRows[selectedWinningIndex] : null;

// //   return {
// //     playable: true,
// //     drawNumber: draw.drawNumber,
// //     drawCode: draw.drawCode,
// //     drawStart: draw.drawStart,
// //     actualKey: winKey,
// //     actualPayout: draw.actualPayout,
// //     payoutWinners: draw.payoutWinners,
// //     turnover: draw.turnover,
// //     correctionFactor,
// //     configId: config.id,
// //     minEdgeProduct: config.minEdgeProduct,
// //     maxRows: config.maxRows,
// //     minEstimatedRoi: config.minEstimatedRoi,
// //     minMarketRowProb: config.minMarketRowProb,
// //     totalRows: selectedRows.length,
// //     eligibleRows: eligibleRows.length,
// //     cost,
// //     revenue,
// //     profit,
// //     isWin,
// //     selectedWinningIndex:
// //       selectedWinningIndex >= 0 ? selectedWinningIndex + 1 : null,
// //     winningRank: ranked.winningRank,
// //     winningRow: ranked.winningRow,
// //     selectedWinningRow,
// //     bestSelectedRow: selectedRows[0],
// //     worstSelectedRow: selectedRows[selectedRows.length - 1],
// //     totalSelectedMarketProb: selectedRows.reduce(
// //       (sum, row) => sum + row.marketRowProb,
// //       0,
// //     ),
// //     avgSelectedEstimatedRoi:
// //       selectedRows.reduce((sum, row) => sum + row.estimatedRoi, 0) /
// //       selectedRows.length,
// //     avgSelectedEdgeProduct:
// //       selectedRows.reduce((sum, row) => sum + row.edgeProduct, 0) /
// //       selectedRows.length,
// //     selectedRows,
// //   };
// // }

// // function evaluateDraws(draws, strategy) {
// //   const plays = [];
// //   const skipped = [];

// //   for (const draw of draws) {
// //     const play = selectRowsForDraw(
// //       draw,
// //       strategy.config,
// //       strategy.correctionFactor,
// //     );

// //     if (play.playable) {
// //       plays.push(play);
// //     } else {
// //       skipped.push(play);
// //     }
// //   }

// //   let totalCost = 0;
// //   let totalRevenue = 0;
// //   let wins = 0;
// //   let running = 0;
// //   let peak = 0;
// //   let maxDrawdown = 0;

// //   for (const play of plays) {
// //     totalCost += play.cost;
// //     totalRevenue += play.revenue;
// //     if (play.isWin) wins += 1;

// //     running += play.profit;
// //     peak = Math.max(peak, running);
// //     maxDrawdown = Math.max(maxDrawdown, peak - running);
// //   }

// //   const totalProfit = totalRevenue - totalCost;

// //   return {
// //     strategy,
// //     playedDraws: plays.length,
// //     skippedDraws: skipped.length,
// //     wins,
// //     hitRate: plays.length ? wins / plays.length : 0,
// //     totalCost,
// //     totalRevenue,
// //     totalProfit,
// //     roi: totalCost ? totalProfit / totalCost : 0,
// //     maxDrawdown,
// //     avgRowsPerDraw: plays.length
// //       ? totalCost / plays.length / CONFIG.rowCost
// //       : 0,
// //     avgRevenuePerWin: wins ? totalRevenue / wins : 0,
// //     avgProfitPerDraw: plays.length ? totalProfit / plays.length : 0,
// //     avgSelectedMarketProb: plays.length
// //       ? plays.reduce((sum, play) => sum + play.totalSelectedMarketProb, 0) /
// //         plays.length
// //       : 0,
// //     avgSelectedEstimatedRoi: plays.length
// //       ? plays.reduce((sum, play) => sum + play.avgSelectedEstimatedRoi, 0) /
// //         plays.length
// //       : 0,
// //     plays,
// //     skipped,
// //   };
// // }

// // function buildStrategies() {
// //   const strategies = [];

// //   for (const config of FIXED_CONFIGS) {
// //     for (const correctionFactor of CORRECTION_FACTORS) {
// //       strategies.push({
// //         id: `${config.id}_cf${String(correctionFactor).replace(".", "_")}`,
// //         config,
// //         correctionFactor,
// //       });
// //     }
// //   }

// //   return strategies;
// // }

// // /**
// //  * Choose on train only.
// //  *
// //  * Ranking rule:
// //  * 1. Positive ROI first.
// //  * 2. Prefer enough volume.
// //  * 3. Prefer lower drawdown.
// //  * 4. Prefer higher profit.
// //  *
// //  * This avoids selecting a tiny lucky config with 1 jackpot.
// //  */
// // function chooseBestTrainResult(trainResults) {
// //   const viable = trainResults.filter(
// //     (result) => result.playedDraws >= CONFIG.minTrainDrawsPlayed,
// //   );

// //   const pool = viable.length
// //     ? viable
// //     : trainResults.filter((result) => result.playedDraws >= 10);
// //   const selectionPool = pool.length ? pool : trainResults;

// //   selectionPool.sort((a, b) => {
// //     const aPositive = a.roi > 0 ? 1 : 0;
// //     const bPositive = b.roi > 0 ? 1 : 0;
// //     if (bPositive !== aPositive) return bPositive - aPositive;

// //     // Penalize severe drawdown relative to total cost.
// //     const aDdRatio = a.totalCost ? a.maxDrawdown / a.totalCost : 999;
// //     const bDdRatio = b.totalCost ? b.maxDrawdown / b.totalCost : 999;

// //     const aScore =
// //       a.roi * 100 +
// //       Math.log10(Math.max(1, a.playedDraws)) * 2 +
// //       Math.log10(Math.max(1, Math.abs(a.totalProfit) + 1)) *
// //         Math.sign(a.totalProfit) -
// //       aDdRatio * 20;

// //     const bScore =
// //       b.roi * 100 +
// //       Math.log10(Math.max(1, b.playedDraws)) * 2 +
// //       Math.log10(Math.max(1, Math.abs(b.totalProfit) + 1)) *
// //         Math.sign(b.totalProfit) -
// //       bDdRatio * 20;

// //     if (bScore !== aScore) return bScore - aScore;
// //     if (b.roi !== a.roi) return b.roi - a.roi;
// //     if (b.totalProfit !== a.totalProfit) return b.totalProfit - a.totalProfit;
// //     return b.playedDraws - a.playedDraws;
// //   });

// //   return selectionPool[0];
// // }

// // function compactMetrics(result) {
// //   return {
// //     strategyId: result.strategy.id,
// //     config: result.strategy.config,
// //     correctionFactor: result.strategy.correctionFactor,
// //     playedDraws: result.playedDraws,
// //     skippedDraws: result.skippedDraws,
// //     wins: result.wins,
// //     hitRate: Number(result.hitRate.toFixed(6)),
// //     totalCost: Number(result.totalCost.toFixed(2)),
// //     totalRevenue: Number(result.totalRevenue.toFixed(2)),
// //     totalProfit: Number(result.totalProfit.toFixed(2)),
// //     roi: Number(result.roi.toFixed(6)),
// //     maxDrawdown: Number(result.maxDrawdown.toFixed(2)),
// //     avgRowsPerDraw: Number(result.avgRowsPerDraw.toFixed(2)),
// //     avgRevenuePerWin: Number(result.avgRevenuePerWin.toFixed(2)),
// //     avgProfitPerDraw: Number(result.avgProfitPerDraw.toFixed(2)),
// //     avgSelectedMarketProb: Number(result.avgSelectedMarketProb.toFixed(8)),
// //     avgSelectedEstimatedRoi: Number(result.avgSelectedEstimatedRoi.toFixed(6)),
// //   };
// // }

// // function writeHoldoutPlaysCsv(filePath, plays) {
// //   const header = [
// //     "draw_number",
// //     "draw_start",
// //     "config_id",
// //     "correction_factor",
// //     "actual_key",
// //     "is_win",
// //     "selected_rows",
// //     "eligible_rows",
// //     "cost",
// //     "revenue",
// //     "profit",
// //     "actual_payout",
// //     "turnover",
// //     "winning_rank",
// //     "selected_winning_index",
// //     "best_edge_product",
// //     "best_estimated_roi",
// //     "best_market_prob",
// //     "worst_edge_product",
// //     "worst_estimated_roi",
// //     "avg_selected_edge_product",
// //     "avg_selected_estimated_roi",
// //     "total_selected_market_prob",
// //   ];

// //   const lines = [header.join(",")];

// //   for (const play of plays) {
// //     lines.push(
// //       [
// //         play.drawNumber,
// //         play.drawStart,
// //         play.configId,
// //         play.correctionFactor,
// //         play.actualKey,
// //         play.isWin ? 1 : 0,
// //         play.totalRows,
// //         play.eligibleRows,
// //         play.cost.toFixed(2),
// //         play.revenue.toFixed(2),
// //         play.profit.toFixed(2),
// //         play.actualPayout.toFixed(2),
// //         play.turnover == null ? "" : play.turnover.toFixed(2),
// //         play.winningRank,
// //         play.selectedWinningIndex == null ? "" : play.selectedWinningIndex,
// //         play.bestSelectedRow.edgeProduct.toFixed(8),
// //         play.bestSelectedRow.estimatedRoi.toFixed(8),
// //         play.bestSelectedRow.marketRowProb.toFixed(12),
// //         play.worstSelectedRow.edgeProduct.toFixed(8),
// //         play.worstSelectedRow.estimatedRoi.toFixed(8),
// //         play.avgSelectedEdgeProduct.toFixed(8),
// //         play.avgSelectedEstimatedRoi.toFixed(8),
// //         play.totalSelectedMarketProb.toFixed(12),
// //       ]
// //         .map(csvEscape)
// //         .join(","),
// //     );
// //   }

// //   fs.writeFileSync(filePath, lines.join("\n"));
// // }

// // function writeWinningRankCsv(filePath, draws, strategy) {
// //   const header = [
// //     "draw_number",
// //     "draw_start",
// //     "actual_key",
// //     "actual_payout",
// //     "turnover",
// //     "correction_factor",
// //     "winning_rank",
// //     "winning_edge_product",
// //     "winning_naive_roi",
// //     "winning_estimated_roi",
// //     "winning_market_prob",
// //     "winning_public_prob",
// //     "winning_estimated_winners",
// //     "winning_estimated_payout",
// //     "selected",
// //     "selected_index",
// //   ];

// //   const lines = [header.join(",")];

// //   for (const draw of draws) {
// //     const play = selectRowsForDraw(
// //       draw,
// //       strategy.config,
// //       strategy.correctionFactor,
// //     );
// //     const winningRow = play.winningRow;

// //     if (!winningRow) continue;

// //     lines.push(
// //       [
// //         draw.drawNumber,
// //         draw.drawStart,
// //         actualKey(draw),
// //         draw.actualPayout.toFixed(2),
// //         draw.turnover == null ? "" : draw.turnover.toFixed(2),
// //         strategy.correctionFactor,
// //         play.winningRank,
// //         winningRow.edgeProduct.toFixed(8),
// //         winningRow.naiveRoi.toFixed(8),
// //         winningRow.estimatedRoi.toFixed(8),
// //         winningRow.marketRowProb.toFixed(12),
// //         winningRow.publicRowProb.toFixed(12),
// //         winningRow.estimatedWinners == null
// //           ? ""
// //           : winningRow.estimatedWinners.toFixed(8),
// //         winningRow.estimatedPayout == null
// //           ? ""
// //           : winningRow.estimatedPayout.toFixed(2),
// //         play.isWin ? 1 : 0,
// //         play.selectedWinningIndex == null ? "" : play.selectedWinningIndex,
// //       ]
// //         .map(csvEscape)
// //         .join(","),
// //     );
// //   }

// //   fs.writeFileSync(filePath, lines.join("\n"));
// // }

// // async function main() {
// //   const runStartedAt = new Date();
// //   const runLabel = `topptipset-v5-${runStartedAt
// //     .toISOString()
// //     .replace(/[^0-9]/g, "")
// //     .slice(0, 14)}`;

// //   console.log("\n=== Topptipset V5 full row enumeration ===");
// //   console.log(`Run: ${runLabel}`);
// //   console.log(`House cut: ${CONFIG.houseCutPct}%`);
// //   console.log(`House factor: ${HOUSE_FACTOR.toFixed(4)}`);
// //   console.log(`Breakeven edge product: ${(1 / HOUSE_FACTOR).toFixed(4)}`);
// //   console.log(`Fixed configs: ${FIXED_CONFIGS.length}`);
// //   console.log(`Correction factors: ${CORRECTION_FACTORS.length}`);

// //   const pool = new Pool({
// //     connectionString: normalizeDatabaseUrl(CONFIG.databaseUrl),
// //   });

// //   let allDraws;
// //   try {
// //     allDraws = await loadHistory(pool);
// //   } finally {
// //     await pool.end();
// //   }

// //   if (!allDraws.length) {
// //     throw new Error("No historical draws loaded.");
// //   }

// //   const splitIndex = Math.floor(allDraws.length * CONFIG.trainRatio);
// //   const trainDraws = allDraws.slice(0, splitIndex);
// //   const holdoutDraws = allDraws.slice(splitIndex);

// //   console.log(`Loaded draws: ${allDraws.length}`);
// //   console.log(`Train/analysis draws: ${trainDraws.length}`);
// //   console.log(`Holdout draws: ${holdoutDraws.length}`);

// //   const strategies = buildStrategies();
// //   console.log(`Strategies to evaluate: ${strategies.length}`);

// //   const trainResults = [];

// //   for (let i = 0; i < strategies.length; i += 1) {
// //     const strategy = strategies[i];
// //     const result = evaluateDraws(trainDraws, strategy);
// //     trainResults.push(result);

// //     console.log(
// //       `[train ${i + 1}/${strategies.length}] ${strategy.id} ` +
// //         `played=${result.playedDraws} wins=${result.wins} ` +
// //         `ROI=${(result.roi * 100).toFixed(2)}% profit=${result.totalProfit.toFixed(0)}`,
// //     );
// //   }

// //   const bestTrain = chooseBestTrainResult(trainResults);
// //   const holdoutResult = evaluateDraws(holdoutDraws, bestTrain.strategy);

// //   const topTrainResults = [...trainResults]
// //     .sort((a, b) => b.roi - a.roi)
// //     .slice(0, 20)
// //     .map(compactMetrics);

// //   fs.mkdirSync(CONFIG.outputDir, { recursive: true });

// //   const report = {
// //     runLabel,
// //     runStartedAt: runStartedAt.toISOString(),
// //     settings: {
// //       houseCutPct: CONFIG.houseCutPct,
// //       houseFactor: HOUSE_FACTOR,
// //       breakevenEdgeProduct: 1 / HOUSE_FACTOR,
// //       rowCost: CONFIG.rowCost,
// //       trainRatio: CONFIG.trainRatio,
// //       minTrainDrawsPlayed: CONFIG.minTrainDrawsPlayed,
// //       maxRowsPerDrawHardCap: CONFIG.maxRowsPerDrawHardCap,
// //     },
// //     data: {
// //       totalDraws: allDraws.length,
// //       trainDraws: trainDraws.length,
// //       holdoutDraws: holdoutDraws.length,
// //       firstDraw: allDraws[0]?.drawNumber,
// //       lastDraw: allDraws[allDraws.length - 1]?.drawNumber,
// //       trainRange: [
// //         trainDraws[0]?.drawNumber,
// //         trainDraws[trainDraws.length - 1]?.drawNumber,
// //       ],
// //       holdoutRange: [
// //         holdoutDraws[0]?.drawNumber,
// //         holdoutDraws[holdoutDraws.length - 1]?.drawNumber,
// //       ],
// //     },
// //     bestTrain: compactMetrics(bestTrain),
// //     holdout: compactMetrics(holdoutResult),
// //     topTrainResults,
// //   };

// //   const jsonPath = path.join(CONFIG.outputDir, `${runLabel}.json`);
// //   const holdoutCsvPath = path.join(
// //     CONFIG.outputDir,
// //     `${runLabel}-holdout-plays.csv`,
// //   );
// //   const winningRankCsvPath = path.join(
// //     CONFIG.outputDir,
// //     `${runLabel}-winning-row-ranking.csv`,
// //   );

// //   fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
// //   writeHoldoutPlaysCsv(holdoutCsvPath, holdoutResult.plays);
// //   writeWinningRankCsv(winningRankCsvPath, holdoutDraws, bestTrain.strategy);

// //   console.log("\n=== BEST TRAIN CONFIG ===");
// //   console.log(JSON.stringify(report.bestTrain, null, 2));

// //   console.log("\n=== FINAL HOLDOUT RESULT ===");
// //   console.log(JSON.stringify(report.holdout, null, 2));

// //   console.log("\nReports written:");
// //   console.log(`- ${jsonPath}`);
// //   console.log(`- ${holdoutCsvPath}`);
// //   console.log(`- ${winningRankCsvPath}`);
// // }

// // main().catch((error) => {
// //   console.error(error);
// //   process.exit(1);
// // });


// 'use strict';

// /**
//  * backtest-topptipset-v5.js
//  *
//  * V5 optimized:
//  * - Enumerates all 3^8 = 6,561 rows per draw.
//  * - maxRows is applied only after all rows are scored and sorted.
//  * - Does NOT store selectedRows in memory.
//  * - Reuses ranked rows per draw/correctionFactor across configs.
//  * - Uses a reduced default config grid to avoid 90+ minute runs.
//  * - Uses first 70% as train/analysis and final 30% as untouched holdout.
//  * - Writes:
//  *   reports/topptipset-v5-<timestamp>.json
//  *   reports/topptipset-v5-<timestamp>-holdout-plays.csv
//  *   reports/topptipset-v5-<timestamp>-winning-row-ranking.csv
//  *
//  * Historical analysis/backtest only.
//  */

// require('dotenv').config();

// const fs = require('fs');
// const path = require('path');
// const { Pool } = require('pg');
// const { normalizeDatabaseUrl } = require('./lib/rapidapi-topptipset');

// const CONFIG = {
//   databaseUrl: process.env.DATABASE_URL,
//   outputDir: path.resolve(process.cwd(), 'reports'),

//   houseCutPct: Number(process.env.TOPPTIPSET_HOUSE_CUT_PCT || 28.1),
//   rowCost: Number(process.env.TOPPTIPSET_ROW_COST || 1),

//   trainRatio: Number(process.env.TOPPTIPSET_V5_TRAIN_RATIO || 0.7),
//   minTrainDrawsPlayed: Number(process.env.TOPPTIPSET_V5_MIN_TRAIN_DRAWS_PLAYED || 50),

//   // Keep this sane. The old 500-row variants exploded cost and memory.
//   maxRowsPerDrawHardCap: Number(process.env.TOPPTIPSET_V5_MAX_ROWS_HARD_CAP || 200),

//   // Log progress every N draws per correctionFactor.
//   progressEveryDraws: Number(process.env.TOPPTIPSET_V5_PROGRESS_EVERY_DRAWS || 250),
// };

// const HOUSE_FACTOR = 1 - CONFIG.houseCutPct / 100;
// const SIGNS = ['1', 'X', '2'];

// /**
//  * Reduced default grid.
//  *
//  * Based on your previous run, 50-row configs looked much better than 100/200/500-row configs.
//  * You can add more configs later, but start narrow and fast.
//  */
// const FIXED_CONFIGS = [
//   {
//     id: 'ep160_r50',
//     minEdgeProduct: 1.6,
//     maxRows: 50,
//     minEstimatedRoi: 0.0,
//     minMarketRowProb: 0,
//   },
//   {
//     id: 'ep180_r50',
//     minEdgeProduct: 1.8,
//     maxRows: 50,
//     minEstimatedRoi: 0.0,
//     minMarketRowProb: 0,
//   },
//   {
//     id: 'ep200_r100',
//     minEdgeProduct: 2.0,
//     maxRows: 100,
//     minEstimatedRoi: 0.0,
//     minMarketRowProb: 0,
//   },
//   {
//     id: 'ep250_r200',
//     minEdgeProduct: 2.5,
//     maxRows: 200,
//     minEstimatedRoi: 0.0,
//     minMarketRowProb: 0,
//   },

//   // Tighter versions.
//   {
//     id: 'ep160_r50_est10',
//     minEdgeProduct: 1.6,
//     maxRows: 50,
//     minEstimatedRoi: 0.10,
//     minMarketRowProb: 0,
//   },
//   {
//     id: 'ep180_r50_est10',
//     minEdgeProduct: 1.8,
//     maxRows: 50,
//     minEstimatedRoi: 0.10,
//     minMarketRowProb: 0,
//   },
// ];

// const CORRECTION_FACTORS = [0.35, 0.5, 1, 2, 3, 4];

// if (!CONFIG.databaseUrl) {
//   console.error('FATAL: DATABASE_URL saknas i .env');
//   process.exit(1);
// }

// function safeNumber(value, fallback = 0) {
//   const parsed = Number(value);
//   return Number.isFinite(parsed) ? parsed : fallback;
// }

// function pctToProb(value) {
//   return Math.max(safeNumber(value) / 100, 1e-9);
// }

// function csvEscape(value) {
//   if (value == null) return '';
//   const str = String(value);
//   if (/[",\n\r]/.test(str)) {
//     return `"${str.replace(/"/g, '""')}"`;
//   }
//   return str;
// }

// function actualKey(draw) {
//   return draw.actualOutcomes.join('');
// }

// function compactRow(row) {
//   if (!row) return null;

//   return {
//     key: row.key,
//     marketRowProb: row.marketRowProb,
//     publicRowProb: row.publicRowProb,
//     edgeProduct: row.edgeProduct,
//     naiveRoi: row.naiveRoi,
//     estimatedWinners: row.estimatedWinners,
//     estimatedPayout: row.estimatedPayout,
//     estimatedRoi: row.estimatedRoi,
//     correctionFactor: row.correctionFactor,
//   };
// }

// async function loadHistory(pool) {
//   const result = await pool.query(`
//     SELECT
//       d.draw_number,
//       d.draw_code,
//       d.first_match_start AS draw_start,
//       d.svenska_spel_result_amount AS actual_payout,
//       d.svenska_spel_result_winners AS payout_winners,
//       d.svenska_spel_result_turnover AS turnover,
//       e.event_number,
//       e.home_team,
//       e.away_team,
//       e.outcome AS actual_outcome,
//       e.market_pct_home,
//       e.market_pct_draw,
//       e.market_pct_away,
//       e.public_pct_home,
//       e.public_pct_draw,
//       e.public_pct_away
//     FROM tipsxtra_topptipset_events e
//     JOIN tipsxtra_topptipset_complete_real_payout_draws d
//       ON d.draw_number = e.draw_number
//     WHERE
//       e.public_pct_home > 0
//       AND e.public_pct_draw > 0
//       AND e.public_pct_away > 0
//       AND e.market_pct_home > 0
//       AND e.market_pct_draw > 0
//       AND e.market_pct_away > 0
//       AND e.outcome IN ('1', 'X', '2')
//       AND d.svenska_spel_result_amount IS NOT NULL
//     ORDER BY d.first_match_start ASC, d.draw_number ASC, e.event_number ASC
//   `);

//   const grouped = new Map();

//   for (const row of result.rows) {
//     const drawNumber = Number(row.draw_number);

//     if (!grouped.has(drawNumber)) {
//       grouped.set(drawNumber, {
//         drawNumber,
//         drawCode: row.draw_code == null ? null : Number(row.draw_code),
//         drawStart: row.draw_start,
//         actualPayout: safeNumber(row.actual_payout),
//         payoutWinners: row.payout_winners == null ? null : Number(row.payout_winners),
//         turnover: row.turnover == null ? null : safeNumber(row.turnover),
//         events: [],
//       });
//     }

//     grouped.get(drawNumber).events.push(row);
//   }

//   return [...grouped.values()]
//     .map((draw) => {
//       const events = [...draw.events].sort(
//         (a, b) => Number(a.event_number) - Number(b.event_number)
//       );

//       if (events.length !== 8) return null;

//       const actualOutcomes = events.map((event) =>
//         String(event.actual_outcome || '').trim().toUpperCase()
//       );

//       if (actualOutcomes.some((sign) => !SIGNS.includes(sign))) return null;

//       const matches = events.map((event) => {
//         const market = {
//           '1': pctToProb(event.market_pct_home),
//           X: pctToProb(event.market_pct_draw),
//           '2': pctToProb(event.market_pct_away),
//         };

//         const publicProb = {
//           '1': pctToProb(event.public_pct_home),
//           X: pctToProb(event.public_pct_draw),
//           '2': pctToProb(event.public_pct_away),
//         };

//         return {
//           eventNumber: Number(event.event_number),
//           homeTeam: event.home_team,
//           awayTeam: event.away_team,
//           actualOutcome: String(event.actual_outcome).trim().toUpperCase(),
//           market,
//           publicProb,
//           edge: {
//             '1': market['1'] / publicProb['1'],
//             X: market.X / publicProb.X,
//             '2': market['2'] / publicProb['2'],
//           },
//         };
//       });

//       return {
//         ...draw,
//         actualOutcomes,
//         matches,
//         events: undefined,
//       };
//     })
//     .filter(Boolean)
//     .sort(
//       (a, b) =>
//         new Date(a.drawStart) - new Date(b.drawStart) ||
//         a.drawNumber - b.drawNumber
//     );
// }

// /**
//  * Enumerates all 6,561 rows.
//  * No early cutoff. No branch pruning. maxRows is NOT used here.
//  *
//  * Important memory detail:
//  * - rows are only kept temporarily for one draw/correctionFactor.
//  * - selectedRows are never stored in final metrics.
//  */
// function enumerateAllRows(draw, correctionFactor) {
//   const rows = [];

//   const turnoverRows =
//     draw.turnover && draw.turnover > 0 ? draw.turnover / CONFIG.rowCost : null;

//   const estimatedPrizePool =
//     draw.turnover && draw.turnover > 0 ? draw.turnover * HOUSE_FACTOR : null;

//   for (let n = 0; n < 6561; n += 1) {
//     let x = n;
//     let key = '';

//     let marketRowProb = 1;
//     let publicRowProb = 1;
//     let edgeProduct = 1;

//     for (let i = 0; i < 8; i += 1) {
//       const sign = SIGNS[x % 3];
//       x = Math.floor(x / 3);

//       const match = draw.matches[i];
//       const marketProb = match.market[sign];
//       const publicProb = match.publicProb[sign];
//       const edge = match.edge[sign];

//       key += sign;
//       marketRowProb *= marketProb;
//       publicRowProb *= publicProb;
//       edgeProduct *= edge;
//     }

//     const naiveRoi = edgeProduct * HOUSE_FACTOR - 1;

//     let estimatedWinners = null;
//     let estimatedPayout = null;
//     let estimatedRoi = naiveRoi;

//     if (turnoverRows && estimatedPrizePool) {
//       estimatedWinners = turnoverRows * publicRowProb * correctionFactor;
//       estimatedPayout = estimatedPrizePool / Math.max(1, estimatedWinners);
//       estimatedRoi =
//         (marketRowProb * estimatedPayout - CONFIG.rowCost) / CONFIG.rowCost;
//     }

//     rows.push({
//       key,
//       marketRowProb,
//       publicRowProb,
//       edgeProduct,
//       naiveRoi,
//       estimatedWinners,
//       estimatedPayout,
//       estimatedRoi,
//       correctionFactor,
//     });
//   }

//   return rows;
// }

// function rankRows(draw, correctionFactor) {
//   const rows = enumerateAllRows(draw, correctionFactor);

//   rows.sort((a, b) => {
//     if (b.estimatedRoi !== a.estimatedRoi) return b.estimatedRoi - a.estimatedRoi;
//     if (b.edgeProduct !== a.edgeProduct) return b.edgeProduct - a.edgeProduct;
//     return b.marketRowProb - a.marketRowProb;
//   });

//   const winKey = actualKey(draw);
//   let winningRank = -1;
//   let winningRow = null;

//   for (let i = 0; i < rows.length; i += 1) {
//     if (rows[i].key === winKey) {
//       winningRank = i + 1;
//       winningRow = rows[i];
//       break;
//     }
//   }

//   return {
//     rows,
//     winningRank,
//     winningRow,
//   };
// }

// function selectRowsFromRanked(draw, ranked, config, correctionFactor) {
//   const maxRows = Math.min(config.maxRows, CONFIG.maxRowsPerDrawHardCap);
//   const winKey = actualKey(draw);

//   let eligibleRows = 0;
//   let selectedCount = 0;
//   let selectedWinningIndex = null;

//   let bestSelectedRow = null;
//   let worstSelectedRow = null;

//   let totalSelectedMarketProb = 0;
//   let selectedEstimatedRoiSum = 0;
//   let selectedEdgeProductSum = 0;

//   for (const row of ranked.rows) {
//     if (row.edgeProduct < config.minEdgeProduct) continue;
//     if (row.estimatedRoi < config.minEstimatedRoi) continue;
//     if (row.marketRowProb < config.minMarketRowProb) continue;

//     eligibleRows += 1;

//     if (selectedCount < maxRows) {
//       selectedCount += 1;

//       if (!bestSelectedRow) bestSelectedRow = row;
//       worstSelectedRow = row;

//       totalSelectedMarketProb += row.marketRowProb;
//       selectedEstimatedRoiSum += row.estimatedRoi;
//       selectedEdgeProductSum += row.edgeProduct;

//       if (row.key === winKey && selectedWinningIndex == null) {
//         selectedWinningIndex = selectedCount;
//       }
//     }
//   }

//   if (selectedCount === 0) {
//     return {
//       playable: false,
//       drawNumber: draw.drawNumber,
//       reason: 'no_eligible_rows',
//       winningRank: ranked.winningRank,
//       winningRow: compactRow(ranked.winningRow),
//     };
//   }

//   const isWin = selectedWinningIndex != null;
//   const cost = selectedCount * CONFIG.rowCost;
//   const revenue = isWin ? draw.actualPayout : 0;
//   const profit = revenue - cost;

//   return {
//     playable: true,
//     drawNumber: draw.drawNumber,
//     drawCode: draw.drawCode,
//     drawStart: draw.drawStart,
//     actualKey: winKey,
//     actualPayout: draw.actualPayout,
//     payoutWinners: draw.payoutWinners,
//     turnover: draw.turnover,

//     correctionFactor,
//     configId: config.id,
//     minEdgeProduct: config.minEdgeProduct,
//     maxRows: config.maxRows,
//     minEstimatedRoi: config.minEstimatedRoi,
//     minMarketRowProb: config.minMarketRowProb,

//     totalRows: selectedCount,
//     eligibleRows,
//     cost,
//     revenue,
//     profit,
//     isWin,

//     selectedWinningIndex,
//     winningRank: ranked.winningRank,
//     winningRow: compactRow(ranked.winningRow),

//     bestSelectedRow: compactRow(bestSelectedRow),
//     worstSelectedRow: compactRow(worstSelectedRow),

//     totalSelectedMarketProb,
//     avgSelectedEstimatedRoi: selectedEstimatedRoiSum / selectedCount,
//     avgSelectedEdgeProduct: selectedEdgeProductSum / selectedCount,
//   };
// }

// function buildStrategies() {
//   const strategies = [];

//   for (const config of FIXED_CONFIGS) {
//     for (const correctionFactor of CORRECTION_FACTORS) {
//       strategies.push({
//         id: `${config.id}_cf${String(correctionFactor).replace('.', '_')}`,
//         config,
//         correctionFactor,
//       });
//     }
//   }

//   return strategies;
// }

// function createMetric(strategy, collectPlays) {
//   return {
//     strategy,
//     collectPlays,

//     playedDraws: 0,
//     skippedDraws: 0,
//     wins: 0,

//     totalCost: 0,
//     totalRevenue: 0,
//     totalProfit: 0,

//     runningProfit: 0,
//     peakProfit: 0,
//     maxDrawdown: 0,

//     rowsSum: 0,
//     revenuePerWinSum: 0,
//     selectedMarketProbSum: 0,
//     selectedEstimatedRoiSum: 0,

//     plays: collectPlays ? [] : undefined,
//     skipped: collectPlays ? [] : undefined,
//   };
// }

// function updateMetric(metric, play) {
//   if (!play.playable) {
//     metric.skippedDraws += 1;

//     if (metric.collectPlays) {
//       metric.skipped.push({
//         drawNumber: play.drawNumber,
//         reason: play.reason,
//         winningRank: play.winningRank,
//       });
//     }

//     return;
//   }

//   metric.playedDraws += 1;
//   metric.totalCost += play.cost;
//   metric.totalRevenue += play.revenue;
//   metric.totalProfit += play.profit;

//   metric.rowsSum += play.totalRows;
//   metric.selectedMarketProbSum += play.totalSelectedMarketProb;
//   metric.selectedEstimatedRoiSum += play.avgSelectedEstimatedRoi;

//   if (play.isWin) {
//     metric.wins += 1;
//     metric.revenuePerWinSum += play.revenue;
//   }

//   metric.runningProfit += play.profit;
//   metric.peakProfit = Math.max(metric.peakProfit, metric.runningProfit);
//   metric.maxDrawdown = Math.max(
//     metric.maxDrawdown,
//     metric.peakProfit - metric.runningProfit
//   );

//   if (metric.collectPlays) {
//     metric.plays.push(play);
//   }
// }

// function finalizeMetric(metric) {
//   const played = metric.playedDraws;
//   const wins = metric.wins;

//   return {
//     strategy: metric.strategy,
//     playedDraws: played,
//     skippedDraws: metric.skippedDraws,
//     wins,
//     hitRate: played ? wins / played : 0,

//     totalCost: metric.totalCost,
//     totalRevenue: metric.totalRevenue,
//     totalProfit: metric.totalProfit,
//     roi: metric.totalCost ? metric.totalProfit / metric.totalCost : 0,

//     maxDrawdown: metric.maxDrawdown,
//     avgRowsPerDraw: played ? metric.rowsSum / played : 0,
//     avgRevenuePerWin: wins ? metric.totalRevenue / wins : 0,
//     avgProfitPerDraw: played ? metric.totalProfit / played : 0,
//     avgSelectedMarketProb: played ? metric.selectedMarketProbSum / played : 0,
//     avgSelectedEstimatedRoi: played ? metric.selectedEstimatedRoiSum / played : 0,

//     plays: metric.collectPlays ? metric.plays : undefined,
//     skipped: metric.collectPlays ? metric.skipped : undefined,
//   };
// }

// /**
//  * Evaluates all strategies efficiently:
//  * - Groups strategies by correctionFactor.
//  * - For each correctionFactor + draw, ranks all 6,561 rows once.
//  * - Applies each config to the same ranked row list.
//  */
// function evaluateStrategies(draws, strategies, options = {}) {
//   const label = options.label || 'eval';
//   const collectPlaysForStrategyId = options.collectPlaysForStrategyId || null;

//   const byCorrectionFactor = new Map();
//   for (const strategy of strategies) {
//     if (!byCorrectionFactor.has(strategy.correctionFactor)) {
//       byCorrectionFactor.set(strategy.correctionFactor, []);
//     }
//     byCorrectionFactor.get(strategy.correctionFactor).push(strategy);
//   }

//   const metricsByStrategyId = new Map();
//   for (const strategy of strategies) {
//     metricsByStrategyId.set(
//       strategy.id,
//       createMetric(strategy, strategy.id === collectPlaysForStrategyId)
//     );
//   }

//   const correctionFactors = [...byCorrectionFactor.keys()].sort((a, b) => a - b);

//   for (const correctionFactor of correctionFactors) {
//     const cfStrategies = byCorrectionFactor.get(correctionFactor);

//     console.log(
//       `[${label}] correctionFactor=${correctionFactor} strategies=${cfStrategies.length}`
//     );

//     for (let drawIndex = 0; drawIndex < draws.length; drawIndex += 1) {
//       const draw = draws[drawIndex];
//       const ranked = rankRows(draw, correctionFactor);

//       for (const strategy of cfStrategies) {
//         const play = selectRowsFromRanked(
//           draw,
//           ranked,
//           strategy.config,
//           correctionFactor
//         );

//         updateMetric(metricsByStrategyId.get(strategy.id), play);
//       }

//       if (
//         CONFIG.progressEveryDraws > 0 &&
//         (drawIndex + 1) % CONFIG.progressEveryDraws === 0
//       ) {
//         console.log(
//           `[${label}] cf=${correctionFactor} processed ${drawIndex + 1}/${draws.length} draws`
//         );
//       }
//     }
//   }

//   return [...metricsByStrategyId.values()].map(finalizeMetric);
// }

// function chooseBestTrainResult(trainResults) {
//   const viable = trainResults.filter(
//     (result) => result.playedDraws >= CONFIG.minTrainDrawsPlayed
//   );

//   const pool = viable.length
//     ? viable
//     : trainResults.filter((result) => result.playedDraws >= 10);

//   const selectionPool = pool.length ? pool : trainResults;

//   selectionPool.sort((a, b) => {
//     const aPositive = a.roi > 0 ? 1 : 0;
//     const bPositive = b.roi > 0 ? 1 : 0;
//     if (bPositive !== aPositive) return bPositive - aPositive;

//     const aDdRatio = a.totalCost ? a.maxDrawdown / a.totalCost : 999;
//     const bDdRatio = b.totalCost ? b.maxDrawdown / b.totalCost : 999;

//     const aScore =
//       a.roi * 100 +
//       Math.log10(Math.max(1, a.playedDraws)) * 2 +
//       Math.log10(Math.max(1, Math.abs(a.totalProfit) + 1)) *
//         Math.sign(a.totalProfit) -
//       aDdRatio * 20;

//     const bScore =
//       b.roi * 100 +
//       Math.log10(Math.max(1, b.playedDraws)) * 2 +
//       Math.log10(Math.max(1, Math.abs(b.totalProfit) + 1)) *
//         Math.sign(b.totalProfit) -
//       bDdRatio * 20;

//     if (bScore !== aScore) return bScore - aScore;
//     if (b.roi !== a.roi) return b.roi - a.roi;
//     if (b.totalProfit !== a.totalProfit) return b.totalProfit - a.totalProfit;
//     return b.playedDraws - a.playedDraws;
//   });

//   return selectionPool[0];
// }

// function compactMetrics(result) {
//   return {
//     strategyId: result.strategy.id,
//     config: result.strategy.config,
//     correctionFactor: result.strategy.correctionFactor,
//     playedDraws: result.playedDraws,
//     skippedDraws: result.skippedDraws,
//     wins: result.wins,
//     hitRate: Number(result.hitRate.toFixed(6)),
//     totalCost: Number(result.totalCost.toFixed(2)),
//     totalRevenue: Number(result.totalRevenue.toFixed(2)),
//     totalProfit: Number(result.totalProfit.toFixed(2)),
//     roi: Number(result.roi.toFixed(6)),
//     maxDrawdown: Number(result.maxDrawdown.toFixed(2)),
//     avgRowsPerDraw: Number(result.avgRowsPerDraw.toFixed(2)),
//     avgRevenuePerWin: Number(result.avgRevenuePerWin.toFixed(2)),
//     avgProfitPerDraw: Number(result.avgProfitPerDraw.toFixed(2)),
//     avgSelectedMarketProb: Number(result.avgSelectedMarketProb.toFixed(8)),
//     avgSelectedEstimatedRoi: Number(result.avgSelectedEstimatedRoi.toFixed(6)),
//   };
// }

// function writeHoldoutPlaysCsv(filePath, plays) {
//   const header = [
//     'draw_number',
//     'draw_start',
//     'config_id',
//     'correction_factor',
//     'actual_key',
//     'is_win',
//     'selected_rows',
//     'eligible_rows',
//     'cost',
//     'revenue',
//     'profit',
//     'actual_payout',
//     'turnover',
//     'winning_rank',
//     'selected_winning_index',
//     'best_edge_product',
//     'best_estimated_roi',
//     'best_market_prob',
//     'worst_edge_product',
//     'worst_estimated_roi',
//     'avg_selected_edge_product',
//     'avg_selected_estimated_roi',
//     'total_selected_market_prob',
//   ];

//   const lines = [header.join(',')];

//   for (const play of plays) {
//     lines.push(
//       [
//         play.drawNumber,
//         play.drawStart,
//         play.configId,
//         play.correctionFactor,
//         play.actualKey,
//         play.isWin ? 1 : 0,
//         play.totalRows,
//         play.eligibleRows,
//         play.cost.toFixed(2),
//         play.revenue.toFixed(2),
//         play.profit.toFixed(2),
//         play.actualPayout.toFixed(2),
//         play.turnover == null ? '' : play.turnover.toFixed(2),
//         play.winningRank,
//         play.selectedWinningIndex == null ? '' : play.selectedWinningIndex,
//         play.bestSelectedRow?.edgeProduct == null ? '' : play.bestSelectedRow.edgeProduct.toFixed(8),
//         play.bestSelectedRow?.estimatedRoi == null ? '' : play.bestSelectedRow.estimatedRoi.toFixed(8),
//         play.bestSelectedRow?.marketRowProb == null ? '' : play.bestSelectedRow.marketRowProb.toFixed(12),
//         play.worstSelectedRow?.edgeProduct == null ? '' : play.worstSelectedRow.edgeProduct.toFixed(8),
//         play.worstSelectedRow?.estimatedRoi == null ? '' : play.worstSelectedRow.estimatedRoi.toFixed(8),
//         play.avgSelectedEdgeProduct.toFixed(8),
//         play.avgSelectedEstimatedRoi.toFixed(8),
//         play.totalSelectedMarketProb.toFixed(12),
//       ]
//         .map(csvEscape)
//         .join(',')
//     );
//   }

//   fs.writeFileSync(filePath, lines.join('\n'));
// }

// function writeWinningRankCsv(filePath, draws, strategy) {
//   const header = [
//     'draw_number',
//     'draw_start',
//     'actual_key',
//     'actual_payout',
//     'turnover',
//     'correction_factor',
//     'winning_rank',
//     'winning_edge_product',
//     'winning_naive_roi',
//     'winning_estimated_roi',
//     'winning_market_prob',
//     'winning_public_prob',
//     'winning_estimated_winners',
//     'winning_estimated_payout',
//     'selected',
//     'selected_index',
//   ];

//   const lines = [header.join(',')];

//   for (let drawIndex = 0; drawIndex < draws.length; drawIndex += 1) {
//     const draw = draws[drawIndex];
//     const ranked = rankRows(draw, strategy.correctionFactor);
//     const play = selectRowsFromRanked(
//       draw,
//       ranked,
//       strategy.config,
//       strategy.correctionFactor
//     );

//     const winningRow = play.winningRow;
//     if (!winningRow) continue;

//     lines.push(
//       [
//         draw.drawNumber,
//         draw.drawStart,
//         actualKey(draw),
//         draw.actualPayout.toFixed(2),
//         draw.turnover == null ? '' : draw.turnover.toFixed(2),
//         strategy.correctionFactor,
//         play.winningRank,
//         winningRow.edgeProduct.toFixed(8),
//         winningRow.naiveRoi.toFixed(8),
//         winningRow.estimatedRoi.toFixed(8),
//         winningRow.marketRowProb.toFixed(12),
//         winningRow.publicRowProb.toFixed(12),
//         winningRow.estimatedWinners == null
//           ? ''
//           : winningRow.estimatedWinners.toFixed(8),
//         winningRow.estimatedPayout == null
//           ? ''
//           : winningRow.estimatedPayout.toFixed(2),
//         play.isWin ? 1 : 0,
//         play.selectedWinningIndex == null ? '' : play.selectedWinningIndex,
//       ]
//         .map(csvEscape)
//         .join(',')
//     );

//     if (
//       CONFIG.progressEveryDraws > 0 &&
//       (drawIndex + 1) % CONFIG.progressEveryDraws === 0
//     ) {
//       console.log(
//         `[winning-rank] processed ${drawIndex + 1}/${draws.length} holdout draws`
//       );
//     }
//   }

//   fs.writeFileSync(filePath, lines.join('\n'));
// }

// async function main() {
//   const runStartedAt = new Date();
//   const runLabel = `topptipset-v5-${runStartedAt
//     .toISOString()
//     .replace(/[^0-9]/g, '')
//     .slice(0, 14)}`;

//   console.log('\n=== Topptipset V5 optimized full row enumeration ===');
//   console.log(`Run: ${runLabel}`);
//   console.log(`House cut: ${CONFIG.houseCutPct}%`);
//   console.log(`House factor: ${HOUSE_FACTOR.toFixed(4)}`);
//   console.log(`Breakeven edge product: ${(1 / HOUSE_FACTOR).toFixed(4)}`);
//   console.log(`Fixed configs: ${FIXED_CONFIGS.length}`);
//   console.log(`Correction factors: ${CORRECTION_FACTORS.length}`);
//   console.log(`Total strategies: ${FIXED_CONFIGS.length * CORRECTION_FACTORS.length}`);

//   const pool = new Pool({
//     connectionString: normalizeDatabaseUrl(CONFIG.databaseUrl),
//   });

//   let allDraws;
//   try {
//     allDraws = await loadHistory(pool);
//   } finally {
//     await pool.end();
//   }

//   if (!allDraws.length) {
//     throw new Error('No historical draws loaded.');
//   }

//   const splitIndex = Math.floor(allDraws.length * CONFIG.trainRatio);
//   const trainDraws = allDraws.slice(0, splitIndex);
//   const holdoutDraws = allDraws.slice(splitIndex);

//   console.log(`Loaded draws: ${allDraws.length}`);
//   console.log(`Train/analysis draws: ${trainDraws.length}`);
//   console.log(`Holdout draws: ${holdoutDraws.length}`);

//   const strategies = buildStrategies();

//   console.log('\n=== TRAIN / CONFIG SELECTION ===');
//   const trainResults = evaluateStrategies(trainDraws, strategies, {
//     label: 'train',
//   });

//   for (let i = 0; i < trainResults.length; i += 1) {
//     const result = trainResults[i];

//     console.log(
//       `[train ${i + 1}/${trainResults.length}] ${result.strategy.id} ` +
//         `played=${result.playedDraws} wins=${result.wins} ` +
//         `ROI=${(result.roi * 100).toFixed(2)}% ` +
//         `profit=${result.totalProfit.toFixed(0)} ` +
//         `avgRows=${result.avgRowsPerDraw.toFixed(1)}`
//     );
//   }

//   const bestTrain = chooseBestTrainResult(trainResults);

//   console.log('\n=== BEST TRAIN CONFIG ===');
//   console.log(JSON.stringify(compactMetrics(bestTrain), null, 2));

//   console.log('\n=== HOLDOUT / FINAL TEST ===');
//   const holdoutResults = evaluateStrategies(holdoutDraws, [bestTrain.strategy], {
//     label: 'holdout',
//     collectPlaysForStrategyId: bestTrain.strategy.id,
//   });

//   const holdoutResult = holdoutResults[0];

//   const topTrainResults = [...trainResults]
//     .sort((a, b) => b.roi - a.roi)
//     .slice(0, 20)
//     .map(compactMetrics);

//   fs.mkdirSync(CONFIG.outputDir, { recursive: true });

//   const report = {
//     runLabel,
//     runStartedAt: runStartedAt.toISOString(),
//     settings: {
//       houseCutPct: CONFIG.houseCutPct,
//       houseFactor: HOUSE_FACTOR,
//       breakevenEdgeProduct: 1 / HOUSE_FACTOR,
//       rowCost: CONFIG.rowCost,
//       trainRatio: CONFIG.trainRatio,
//       minTrainDrawsPlayed: CONFIG.minTrainDrawsPlayed,
//       maxRowsPerDrawHardCap: CONFIG.maxRowsPerDrawHardCap,
//       fixedConfigs: FIXED_CONFIGS,
//       correctionFactors: CORRECTION_FACTORS,
//     },
//     data: {
//       totalDraws: allDraws.length,
//       trainDraws: trainDraws.length,
//       holdoutDraws: holdoutDraws.length,
//       firstDraw: allDraws[0]?.drawNumber,
//       lastDraw: allDraws[allDraws.length - 1]?.drawNumber,
//       trainRange: [
//         trainDraws[0]?.drawNumber,
//         trainDraws[trainDraws.length - 1]?.drawNumber,
//       ],
//       holdoutRange: [
//         holdoutDraws[0]?.drawNumber,
//         holdoutDraws[holdoutDraws.length - 1]?.drawNumber,
//       ],
//     },
//     bestTrain: compactMetrics(bestTrain),
//     holdout: compactMetrics(holdoutResult),
//     topTrainResults,
//   };

//   const jsonPath = path.join(CONFIG.outputDir, `${runLabel}.json`);
//   const holdoutCsvPath = path.join(
//     CONFIG.outputDir,
//     `${runLabel}-holdout-plays.csv`
//   );
//   const winningRankCsvPath = path.join(
//     CONFIG.outputDir,
//     `${runLabel}-winning-row-ranking.csv`
//   );

//   fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
//   writeHoldoutPlaysCsv(holdoutCsvPath, holdoutResult.plays || []);
//   writeWinningRankCsv(winningRankCsvPath, holdoutDraws, bestTrain.strategy);

//   console.log('\n=== FINAL HOLDOUT RESULT ===');
//   console.log(JSON.stringify(report.holdout, null, 2));

//   console.log('\nReports written:');
//   console.log(`- ${jsonPath}`);
//   console.log(`- ${holdoutCsvPath}`);
//   console.log(`- ${winningRankCsvPath}`);
// }

// main().catch((error) => {
//   console.error(error);
//   process.exit(1);
// });


'use strict';

/**
 * backtest-topptipset-v5.js
 *
 * V5 optimized + robust config selection:
 * - Enumerates all 3^8 = 6,561 rows per draw.
 * - maxRows is applied only after all rows are scored and sorted.
 * - Does NOT store selectedRows in memory.
 * - Reuses ranked rows per draw/correctionFactor across configs.
 * - Uses first 70% as train/analysis and final 30% as untouched holdout.
 * - Avoids selecting jackpot-overfit configs with too few wins.
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

  trainRatio: Number(process.env.TOPPTIPSET_V5_TRAIN_RATIO || 0.7),

  minTrainDrawsPlayed: Number(
    process.env.TOPPTIPSET_V5_MIN_TRAIN_DRAWS_PLAYED || 50
  ),

  // Viktig fix: hindrar att en strategi med 1 lyckoträff väljs.
  minTrainWins: Number(process.env.TOPPTIPSET_V5_MIN_TRAIN_WINS || 8),

  maxRowsPerDrawHardCap: Number(
    process.env.TOPPTIPSET_V5_MAX_ROWS_HARD_CAP || 200
  ),

  progressEveryDraws: Number(
    process.env.TOPPTIPSET_V5_PROGRESS_EVERY_DRAWS || 250
  ),
};

const HOUSE_FACTOR = 1 - CONFIG.houseCutPct / 100;
const SIGNS = ['1', 'X', '2'];

const FIXED_CONFIGS = [
  {
    id: 'ep160_r50',
    minEdgeProduct: 1.6,
    maxRows: 50,
    minEstimatedRoi: 0.0,
    minMarketRowProb: 0,
  },
  {
    id: 'ep180_r50',
    minEdgeProduct: 1.8,
    maxRows: 50,
    minEstimatedRoi: 0.0,
    minMarketRowProb: 0,
  },
  {
    id: 'ep200_r100',
    minEdgeProduct: 2.0,
    maxRows: 100,
    minEstimatedRoi: 0.0,
    minMarketRowProb: 0,
  },
  {
    id: 'ep250_r200',
    minEdgeProduct: 2.5,
    maxRows: 200,
    minEstimatedRoi: 0.0,
    minMarketRowProb: 0,
  },
  {
    id: 'ep160_r50_est10',
    minEdgeProduct: 1.6,
    maxRows: 50,
    minEstimatedRoi: 0.10,
    minMarketRowProb: 0,
  },
  {
    id: 'ep180_r50_est10',
    minEdgeProduct: 1.8,
    maxRows: 50,
    minEstimatedRoi: 0.10,
    minMarketRowProb: 0,
  },
];

const CORRECTION_FACTORS = [0.35, 0.5, 1, 2, 3, 4];

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

function chooseBestTrainResult(trainResults) {
  const viable = trainResults.filter(
    (result) =>
      result.playedDraws >= CONFIG.minTrainDrawsPlayed &&
      result.wins >= CONFIG.minTrainWins &&
      result.roi > 0
  );

  const fallback = trainResults.filter(
    (result) =>
      result.playedDraws >= CONFIG.minTrainDrawsPlayed &&
      result.wins >= Math.max(5, Math.floor(CONFIG.minTrainWins / 2))
  );

  const selectionPool = viable.length
    ? viable
    : fallback.length
      ? fallback
      : trainResults;

  selectionPool.sort((a, b) => {
    // 1. Välj inte låg-sample jackpot. Flest vinster först.
    if (b.wins !== a.wins) return b.wins - a.wins;

    // 2. Lägre radvolym före högre radvolym.
    if (a.avgRowsPerDraw !== b.avgRowsPerDraw) {
      return a.avgRowsPerDraw - b.avgRowsPerDraw;
    }

    // 3. Positiv ROI före negativ ROI.
    const aPositive = a.roi > 0 ? 1 : 0;
    const bPositive = b.roi > 0 ? 1 : 0;
    if (bPositive !== aPositive) return bPositive - aPositive;

    // 4. Högre ROI.
    if (b.roi !== a.roi) return b.roi - a.roi;

    // 5. Högre totalprofit.
    if (b.totalProfit !== a.totalProfit) {
      return b.totalProfit - a.totalProfit;
    }

    // 6. Lägre drawdown.
    return a.maxDrawdown - b.maxDrawdown;
  });

  return selectionPool[0];
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
    avgRowsPerDraw: Number(result.avgRowsPerDraw.toFixed(2)),
    avgRevenuePerWin: Number(result.avgRevenuePerWin.toFixed(2)),
    avgProfitPerDraw: Number(result.avgProfitPerDraw.toFixed(2)),
    avgSelectedMarketProb: Number(result.avgSelectedMarketProb.toFixed(8)),
    avgSelectedEstimatedRoi: Number(
      result.avgSelectedEstimatedRoi.toFixed(6)
    ),
  };
}

function writeHoldoutPlaysCsv(filePath, plays) {
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
  const runLabel = `topptipset-v5-${runStartedAt
    .toISOString()
    .replace(/[^0-9]/g, '')
    .slice(0, 14)}`;

  console.log('\n=== Topptipset V5 robust full row enumeration ===');
  console.log(`Run: ${runLabel}`);
  console.log(`House cut: ${CONFIG.houseCutPct}%`);
  console.log(`House factor: ${HOUSE_FACTOR.toFixed(4)}`);
  console.log(`Breakeven edge product: ${(1 / HOUSE_FACTOR).toFixed(4)}`);
  console.log(`Fixed configs: ${FIXED_CONFIGS.length}`);
  console.log(`Correction factors: ${CORRECTION_FACTORS.length}`);
  console.log(
    `Total strategies: ${FIXED_CONFIGS.length * CORRECTION_FACTORS.length}`
  );
  console.log(`Min train wins for robust selection: ${CONFIG.minTrainWins}`);

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

  for (let i = 0; i < trainResults.length; i += 1) {
    const result = trainResults[i];

    console.log(
      `[train ${i + 1}/${trainResults.length}] ${result.strategy.id} ` +
        `played=${result.playedDraws} wins=${result.wins} ` +
        `ROI=${(result.roi * 100).toFixed(2)}% ` +
        `profit=${result.totalProfit.toFixed(0)} ` +
        `avgRows=${result.avgRowsPerDraw.toFixed(1)}`
    );
  }

  const bestTrain = chooseBestTrainResult(trainResults);

  console.log('\n=== BEST TRAIN CONFIG ===');
  console.log(JSON.stringify(compactMetrics(bestTrain), null, 2));

  console.log('\n=== HOLDOUT / FINAL TEST ===');

  const holdoutResults = evaluateStrategies(holdoutDraws, [bestTrain.strategy], {
    label: 'holdout',
    collectPlaysForStrategyId: bestTrain.strategy.id,
  });

  const holdoutResult = holdoutResults[0];

  const topTrainResults = [...trainResults]
    .sort((a, b) => b.roi - a.roi)
    .slice(0, 20)
    .map(compactMetrics);

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
    bestTrain: compactMetrics(bestTrain),
    holdout: compactMetrics(holdoutResult),
    topTrainResults,
  };

  const jsonPath = path.join(CONFIG.outputDir, `${runLabel}.json`);
  const holdoutCsvPath = path.join(
    CONFIG.outputDir,
    `${runLabel}-holdout-plays.csv`
  );
  const winningRankCsvPath = path.join(
    CONFIG.outputDir,
    `${runLabel}-winning-row-ranking.csv`
  );

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeHoldoutPlaysCsv(holdoutCsvPath, holdoutResult.plays || []);
  writeWinningRankCsv(winningRankCsvPath, holdoutDraws, bestTrain.strategy);

  console.log('\n=== FINAL HOLDOUT RESULT ===');
  console.log(JSON.stringify(report.holdout, null, 2));

  console.log('\nReports written:');
  console.log(`- ${jsonPath}`);
  console.log(`- ${holdoutCsvPath}`);
  console.log(`- ${winningRankCsvPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});