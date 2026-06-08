'use strict';

/**
 * strategy-system-play.js
 *
 * Core strategy engine for Topptipset system play.
 * Instead of picking 1 row per draw, we generate "reduced systems"
 * by hedging (garderar) multiple signs on uncertain matches,
 * then evaluate the expected value of the entire system.
 *
 * Key concepts:
 * - Each match can have 1, 2, or 3 signs selected
 * - Total rows = product of signs per match
 * - We optimize which matches to hedge based on model probabilities
 * - Expected profit = sum over all rows of (winProb * payout) - totalCost
 */

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function product(values) {
  let result = 1;
  for (const v of values) {
    result *= v;
  }
  return result;
}

function sum(values) {
  let result = 0;
  for (const v of values) {
    result += v;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Row generation from a gardering system
// ---------------------------------------------------------------------------

/**
 * A "gardering" per match is an array of selected signs, e.g. ['1','X'] or ['2']
 * gardings = [['1','X'], ['1'], ['X','2'], ['1'], ...]  (8 matches)
 *
 * This generates all combinations (rows) from the gardering system.
 */
function generateRows(gardings) {
  const rows = [];
  const matchCount = gardings.length;

  function recurse(matchIndex, currentRow) {
    if (matchIndex === matchCount) {
      rows.push([...currentRow]);
      return;
    }
    for (const sign of gardings[matchIndex]) {
      currentRow.push(sign);
      recurse(matchIndex + 1, currentRow);
      currentRow.pop();
    }
  }

  recurse(0, []);
  return rows;
}

/**
 * Count total rows without generating them (faster for evaluation).
 */
function countRows(gardings) {
  return product(gardings.map(g => g.length));
}

// ---------------------------------------------------------------------------
// Expected Value calculation
// ---------------------------------------------------------------------------

/**
 * Calculate the probability that a specific row wins (all 8 correct).
 * @param {string[]} row - Array of 8 signs, e.g. ['1','X','2','1','1','X','2','1']
 * @param {object[]} matchProbabilities - Array of 8 objects with {home, draw, away}
 */
function rowWinProbability(row, matchProbabilities) {
  let prob = 1;
  for (let i = 0; i < row.length; i++) {
    const sign = row[i];
    const probs = matchProbabilities[i];
    const signProb = sign === '1' ? probs.home : sign === 'X' ? probs.draw : probs.away;
    prob *= signProb;
  }
  return prob;
}

/**
 * Calculate the expected value of a system play.
 *
 * For each possible row in the system:
 *   EV(row) = P(row wins) × expectedPayout - costPerRow
 *
 * Total system EV = sum of EV(row) for all rows
 *
 * @param {string[][]} rows - All rows in the system
 * @param {object[]} matchProbabilities - Per-match probabilities {home, draw, away}
 * @param {number} expectedPayout - Expected payout per winning row (from pool)
 * @param {number} costPerRow - Cost per row (typically 1 kr)
 * @returns {object} System evaluation metrics
 */
function evaluateSystem(rows, matchProbabilities, expectedPayout, costPerRow) {
  const totalRows = rows.length;
  const totalCost = totalRows * costPerRow;

  let totalWinProb = 0;
  let highestRowProb = 0;

  for (const row of rows) {
    const prob = rowWinProbability(row, matchProbabilities);
    totalWinProb += prob;
    if (prob > highestRowProb) {
      highestRowProb = prob;
    }
  }

  // Expected number of winning rows (can be >1 theoretically but very rare)
  const expectedWinningRows = totalWinProb;
  const expectedRevenue = expectedWinningRows * expectedPayout;
  const expectedProfit = expectedRevenue - totalCost;
  const expectedROI = totalCost > 0 ? expectedProfit / totalCost : 0;

  // Probability of at least 1 winning row (approximation for independent-ish rows)
  // More accurate: 1 - product(1 - P(row_i wins)) but rows share matches so they're dependent
  // For non-overlapping rows this is exact; for overlapping it's an approximation
  const probAtLeastOneWin = Math.min(totalWinProb, 1); // Simple upper bound

  return {
    totalRows,
    totalCost,
    totalWinProb,
    expectedWinningRows,
    expectedRevenue,
    expectedProfit,
    expectedROI,
    probAtLeastOneWin,
    highestRowProb,
    costPerRow,
  };
}

/**
 * Fast EV evaluation without generating all rows.
 * Uses the fact that E[winning rows] = sum over matches of product of selected probs.
 *
 * For a system with gardings G_1, G_2, ..., G_8:
 * Total win probability = sum over all rows of product of sign probs
 *                       = product_i(sum of selected sign probs for match i)
 *
 * This is because the rows are the cartesian product of gardings.
 *
 * Example: gardings = [['1','X'], ['2']], probs = [{h:.5,d:.3,a:.2}, {h:.1,d:.3,a:.6}]
 *   Total win prob = (0.5+0.3) * (0.6) = 0.48
 *   Which equals P('1','2') + P('X','2') = 0.5*0.6 + 0.3*0.6 = 0.30 + 0.18 = 0.48 ✓
 */
function evaluateSystemFast(gardings, matchProbabilities, expectedPayout, costPerRow) {
  const totalRows = countRows(gardings);
  const totalCost = totalRows * costPerRow;

  // Probability that the system has at least one winning row
  // = sum of probabilities of all possible rows
  // = product of (sum of selected probabilities per match)
  const perMatchCoverage = gardings.map((signs, i) => {
    const probs = matchProbabilities[i];
    return sum(signs.map(s => s === '1' ? probs.home : s === 'X' ? probs.draw : probs.away));
  });

  const totalWinProb = product(perMatchCoverage);
  const expectedWinningRows = totalWinProb;
  const expectedRevenue = expectedWinningRows * expectedPayout;
  const expectedProfit = expectedRevenue - totalCost;
  const expectedROI = totalCost > 0 ? expectedProfit / totalCost : 0;

  return {
    totalRows,
    totalCost,
    totalWinProb,
    expectedWinningRows,
    expectedRevenue,
    expectedProfit,
    expectedROI,
    perMatchCoverage,
    costPerRow,
    gardings: gardings.map(g => g.join('')),
  };
}

// ---------------------------------------------------------------------------
// Gardering optimization
// ---------------------------------------------------------------------------

/**
 * Rank signs per match by probability (descending).
 * Returns: [{sign, prob, rank}] for each match.
 */
function rankSignsByProbability(matchProbabilities) {
  return matchProbabilities.map(probs => {
    const signs = [
      { sign: '1', prob: probs.home },
      { sign: 'X', prob: probs.draw },
      { sign: '2', prob: probs.away },
    ].sort((a, b) => b.prob - a.prob);
    return signs;
  });
}

/**
 * Build the "favorite-only" system (1 sign per match = 1 row total).
 * This is the baseline.
 */
function buildFavoriteSystem(rankedSigns) {
  return rankedSigns.map(signs => [signs[0].sign]);
}

/**
 * Greedy gardering optimizer.
 *
 * Strategy: start with 1 sign per match (favorites), then iteratively
 * add the most valuable hedge (2nd or 3rd sign on a match) that gives
 * the best marginal EV per additional row cost.
 *
 * @param {object[]} matchProbabilities - Array of 8 {home, draw, away}
 * @param {number} expectedPayout - Pool payout estimate
 * @param {number} costPerRow - Cost per row
 * @param {object} constraints - Budget and quality constraints
 */
function optimizeGardings(matchProbabilities, expectedPayout, costPerRow, constraints = {}) {
  const maxRows = constraints.maxRows || 64;
  const maxSignsPerMatch = constraints.maxSignsPerMatch || 3;
  const minSystemEV = constraints.minSystemEV || 0; // Minimum expected ROI to play

  const rankedSigns = rankSignsByProbability(matchProbabilities);

  // Start with favorites only
  const currentGardings = buildFavoriteSystem(rankedSigns);
  let bestEval = evaluateSystemFast(currentGardings, matchProbabilities, expectedPayout, costPerRow);

  // Track which match-sign additions are still available
  // For each match, we can add the 2nd and 3rd ranked sign
  const candidates = [];
  for (let matchIdx = 0; matchIdx < rankedSigns.length; matchIdx++) {
    for (let signRank = 1; signRank < Math.min(3, maxSignsPerMatch); signRank++) {
      candidates.push({
        matchIdx,
        sign: rankedSigns[matchIdx][signRank].sign,
        prob: rankedSigns[matchIdx][signRank].prob,
        signRank,
      });
    }
  }

  // Track the order of gardering additions for the best system
  const gardHistory = [];

  // Greedy: keep adding the best marginal hedge
  let improved = true;
  while (improved && countRows(currentGardings) < maxRows) {
    improved = false;
    let bestCandidate = null;
    let bestMarginalEV = -Infinity;
    let bestCandidateEval = null;

    for (let ci = 0; ci < candidates.length; ci++) {
      const candidate = candidates[ci];
      if (!candidate) continue;

      // Check if we can add this sign (prerequisite: lower-ranked signs must be added first)
      if (candidate.signRank === 2 && !currentGardings[candidate.matchIdx].includes(rankedSigns[candidate.matchIdx][1].sign)) {
        continue; // Must add 2nd sign before 3rd
      }

      // Check if this sign is already in the gardering
      if (currentGardings[candidate.matchIdx].includes(candidate.sign)) {
        candidates[ci] = null;
        continue;
      }

      // Check if adding this would exceed maxRows
      const testGardings = currentGardings.map(g => [...g]);
      testGardings[candidate.matchIdx].push(candidate.sign);
      const newRowCount = countRows(testGardings);
      if (newRowCount > maxRows) continue;

      // Evaluate
      const testEval = evaluateSystemFast(testGardings, matchProbabilities, expectedPayout, costPerRow);
      const marginalCost = (newRowCount - bestEval.totalRows) * costPerRow;
      const marginalRevenue = testEval.expectedRevenue - bestEval.expectedRevenue;
      const marginalEV = marginalCost > 0 ? (marginalRevenue - marginalCost) / marginalCost : 0;

      if (marginalEV > bestMarginalEV && testEval.expectedProfit > bestEval.expectedProfit) {
        bestMarginalEV = marginalEV;
        bestCandidate = ci;
        bestCandidateEval = testEval;
      }
    }

    if (bestCandidate !== null && bestMarginalEV > -0.5) {
      const candidate = candidates[bestCandidate];
      currentGardings[candidate.matchIdx].push(candidate.sign);
      bestEval = bestCandidateEval;
      candidates[bestCandidate] = null;
      gardHistory.push({
        matchIdx: candidate.matchIdx,
        sign: candidate.sign,
        prob: candidate.prob,
        marginalEV: bestMarginalEV,
        totalRows: bestEval.totalRows,
        expectedROI: bestEval.expectedROI,
      });
      improved = true;
    }
  }

  return {
    gardings: currentGardings,
    evaluation: bestEval,
    gardHistory,
    isPlayable: bestEval.expectedROI >= minSystemEV,
  };
}

// ---------------------------------------------------------------------------
// Kelly criterion for position sizing
// ---------------------------------------------------------------------------

/**
 * Fractional Kelly criterion.
 *
 * f* = (p * b - q) / b
 * where:
 *   p = probability of winning
 *   q = 1 - p
 *   b = net odds (payout/cost - 1)
 *
 * We use fractional Kelly (fraction of full Kelly) for safety.
 *
 * @param {number} winProb - Probability of winning
 * @param {number} expectedPayout - Expected payout per winning unit
 * @param {number} cost - Cost per unit
 * @param {number} fraction - Kelly fraction (0.25 = quarter Kelly, recommended)
 * @returns {number} Fraction of bankroll to risk
 */
function kellyFraction(winProb, expectedPayout, cost, fraction = 0.25) {
  const p = clamp(winProb, 0.0001, 0.9999);
  const q = 1 - p;
  const b = expectedPayout / cost - 1;

  if (b <= 0) return 0;

  const fullKelly = (p * b - q) / b;
  return Math.max(0, fullKelly * fraction);
}

/**
 * Calculate the optimal bet size for a system play.
 *
 * @param {object} systemEval - Result from evaluateSystemFast
 * @param {number} bankroll - Current bankroll in SEK
 * @param {number} kellyFrac - Kelly fraction (default 0.25)
 * @param {number} maxBetPct - Max percentage of bankroll per bet
 * @returns {object} Sizing recommendation
 */
function calculateBetSize(systemEval, bankroll, kellyFrac = 0.25, maxBetPct = 0.10) {
  const winProb = systemEval.totalWinProb;
  const avgPayoutPerRow = systemEval.expectedRevenue / Math.max(systemEval.totalWinProb, 1e-12);
  const costPerRow = systemEval.costPerRow;

  const kellyPct = kellyFraction(winProb, avgPayoutPerRow, systemEval.totalCost, kellyFrac);
  const kellyBet = kellyPct * bankroll;

  // Cap at maxBetPct of bankroll
  const cappedBet = Math.min(kellyBet, bankroll * maxBetPct);

  // How many "units" of the system can we afford?
  // Each unit = totalCost (e.g. 32 rows × 1 kr = 32 kr)
  const unitsAffordable = Math.floor(cappedBet / systemEval.totalCost);
  const actualBet = unitsAffordable * systemEval.totalCost;

  return {
    kellyPct,
    kellyBet,
    cappedBet,
    unitsAffordable: Math.max(unitsAffordable, 0),
    actualBet: Math.max(actualBet, 0),
    systemCost: systemEval.totalCost,
    shouldPlay: unitsAffordable >= 1 && systemEval.expectedROI > 0,
  };
}

// ---------------------------------------------------------------------------
// Estimate expected payout from pool data
// ---------------------------------------------------------------------------

/**
 * Estimate expected payout for a winning row based on pool data.
 *
 * For Topptipset, payout = turnover × (1 - houseCut) / expectedWinners
 * where expectedWinners depends on the streck (public betting distribution).
 *
 * If we have actual historical payout data, we use that directly.
 *
 * @param {number} turnover - Pool turnover in SEK
 * @param {number} houseCutPct - House cut percentage (Topptipset ≈ 35%)
 * @param {object[]} publicDistributions - Array of 8 {home, draw, away} as percentages
 * @param {string[]} correctRow - The actual correct row
 */
function estimatePoolPayout(turnover, houseCutPct, publicDistributions, correctRow) {
  const pool = turnover * (1 - houseCutPct / 100);

  // Expected number of winners = totalRows × probability of correct row based on public streck
  // P(public picks correct row) = product of (public_pct for correct sign / 100)
  const publicProbs = correctRow.map((sign, i) => {
    const dist = publicDistributions[i];
    const pct = sign === '1' ? dist.home : sign === 'X' ? dist.draw : dist.away;
    return pct / 100;
  });

  const publicCorrectProb = product(publicProbs);

  // Total number of rows in the pool = turnover / costPerRow
  const totalPoolRows = turnover; // assuming 1 kr per row
  const expectedWinners = totalPoolRows * publicCorrectProb;

  const expectedPayoutPerWinner = expectedWinners > 0 ? pool / expectedWinners : pool;

  return {
    pool,
    publicCorrectProb,
    totalPoolRows,
    expectedWinners,
    expectedPayoutPerWinner,
  };
}

/**
 * Estimate expected payout using only the public streck distribution.
 * Used when we don't know the actual correct row yet (pre-game).
 *
 * For each possible row, the expected payout is:
 *   turnover * (1-cut) / (totalPoolRows * P_public(row))
 *   = (1-cut) / P_public(row)
 *
 * The "public odds" for a row = 1 / P_public(row)
 * So expected payout per row ≈ (1-cut) × publicOdds
 *
 * @param {object[]} publicDistributions - Array of 8 {home, draw, away} as percentages
 * @param {string[]} signs - The row we're considering
 * @param {number} houseCutPct - House cut (default 35 for Topptipset)
 */
function estimatePayoutForRow(publicDistributions, signs, houseCutPct = 35) {
  const publicProbs = signs.map((sign, i) => {
    const dist = publicDistributions[i];
    const pct = sign === '1' ? dist.home : sign === 'X' ? dist.draw : dist.away;
    return Math.max(pct / 100, 0.001); // Floor to avoid division by zero
  });

  const publicProbProduct = product(publicProbs);
  const publicOdds = 1 / publicProbProduct;
  const expectedPayout = publicOdds * (1 - houseCutPct / 100);

  return {
    publicProbProduct,
    publicOdds,
    expectedPayout,
  };
}

/**
 * Calculate the average expected payout across all rows in a system.
 * Weighted by the model's probability that each row is correct.
 */
function estimateSystemAveragePayout(gardings, matchProbabilities, publicDistributions, houseCutPct = 35) {
  const rows = generateRows(gardings);
  let weightedPayoutSum = 0;
  let totalProb = 0;

  for (const row of rows) {
    const winProb = rowWinProbability(row, matchProbabilities);
    const { expectedPayout } = estimatePayoutForRow(publicDistributions, row, houseCutPct);
    weightedPayoutSum += winProb * expectedPayout;
    totalProb += winProb;
  }

  // Average payout weighted by probability
  const avgExpectedPayout = totalProb > 0 ? weightedPayoutSum / totalProb : 0;

  return {
    avgExpectedPayout,
    totalWinProb: totalProb,
    rowCount: rows.length,
    // Total expected revenue = sum of (winProb_i * payout_i) for each row i
    totalExpectedRevenue: weightedPayoutSum,
  };
}

// ---------------------------------------------------------------------------
// Full system evaluation with payout estimation
// ---------------------------------------------------------------------------

/**
 * Complete system evaluation combining model probabilities and pool payout estimates.
 *
 * @param {string[][]} gardings - Gardering per match
 * @param {object[]} matchProbabilities - Model's probabilities {home, draw, away}
 * @param {object[]} publicDistributions - Public streck {home, draw, away} (percentages)
 * @param {number} costPerRow - Cost per row in SEK
 * @param {number} houseCutPct - House cut percentage
 */
function evaluateSystemWithPayout(gardings, matchProbabilities, publicDistributions, costPerRow = 1, houseCutPct = 35) {
  const rows = generateRows(gardings);
  const totalRows = rows.length;
  const totalCost = totalRows * costPerRow;

  let totalExpectedRevenue = 0;
  let totalWinProb = 0;

  for (const row of rows) {
    const winProb = rowWinProbability(row, matchProbabilities);
    const { expectedPayout } = estimatePayoutForRow(publicDistributions, row, houseCutPct);
    totalExpectedRevenue += winProb * expectedPayout;
    totalWinProb += winProb;
  }

  const expectedProfit = totalExpectedRevenue - totalCost;
  const expectedROI = totalCost > 0 ? expectedProfit / totalCost : 0;

  return {
    totalRows,
    totalCost,
    totalWinProb,
    totalExpectedRevenue,
    expectedProfit,
    expectedROI,
    gardings: gardings.map(g => g.join('')),
    costPerRow,
    houseCutPct,
  };
}

// ---------------------------------------------------------------------------
// Backtest helpers
// ---------------------------------------------------------------------------

/**
 * Given a draw's actual outcome, check if a row wins.
 */
function isWinningRow(row, actualOutcomes) {
  if (row.length !== actualOutcomes.length) return false;
  return row.every((sign, i) => sign === actualOutcomes[i]);
}

/**
 * Count how many rows in a system win.
 */
function countWinningRows(gardings, actualOutcomes) {
  // Fast check: if any match's correct sign is not in the gardering, 0 wins
  for (let i = 0; i < gardings.length; i++) {
    if (!gardings[i].includes(actualOutcomes[i])) {
      return 0;
    }
  }

  // If all correct signs are covered, count = product of gardings that DON'T affect the outcome
  // Actually no — if the correct sign IS in the gardering, it contributes exactly 1 to the product
  // So winning rows = product of 1 for each match = 1? No...
  // If gardings = [['1','X'], ['2']] and correct is ['1','2'], winning rows = 1 ('1','2')
  // If gardings = [['1','X'], ['2']] and correct is ['X','2'], winning rows = 1 ('X','2')
  // So yes: if all correct signs are in gardings, exactly 1 row wins (the correct row itself)
  // The other rows in the system are "wasted" (wrong combinations)
  return 1;
}

/**
 * Evaluate a system play against actual historical results.
 *
 * @param {string[][]} gardings - System gardings
 * @param {string[]} actualOutcomes - Actual outcomes per match
 * @param {number} actualPayout - Actual payout per winning row (from Svenska Spel)
 * @param {number} costPerRow - Cost per row
 * @returns {object} Actual profit/loss
 */
function evaluateSystemActual(gardings, actualOutcomes, actualPayout, costPerRow = 1) {
  const totalRows = countRows(gardings);
  const totalCost = totalRows * costPerRow;
  const winningRows = countWinningRows(gardings, actualOutcomes);
  const revenue = winningRows * actualPayout;
  const profit = revenue - totalCost;

  return {
    totalRows,
    totalCost,
    winningRows,
    revenue,
    profit,
    roi: totalCost > 0 ? profit / totalCost : 0,
    isWin: winningRows > 0,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  generateRows,
  countRows,
  rowWinProbability,
  evaluateSystem,
  evaluateSystemFast,
  optimizeGardings,
  kellyFraction,
  calculateBetSize,
  estimatePoolPayout,
  estimatePayoutForRow,
  estimateSystemAveragePayout,
  evaluateSystemWithPayout,
  isWinningRow,
  countWinningRows,
  evaluateSystemActual,
  rankSignsByProbability,
  buildFavoriteSystem,
};
