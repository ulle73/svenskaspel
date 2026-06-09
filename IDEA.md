/**
 * Topptipset ROI strategy pack
 * Drop into scripts/lib/topptipset-roi-strategies.js and import from your backtest scripts.
 *
 * Core idea:
 * - Use market odds/probability as true-probability proxy.
 * - Use Svenska Folket/public implied payout as pool payout proxy.
 * - Target outcomes where market says more likely than the crowd: marketProb - publicProb > 0.
 * - Prefer lineups/rows that combine expected value with not-too-low hit frequency.
 */

function product(values) {
  return values.reduce((acc, v) => acc * v, 1);
}

function rowExpectedRoi(selections, payoutMultiplier = 1) {
  const winProb = product(selections.map((s) => s.predictedProbability ?? s.marketProb));
  const publicOddsProduct = product(selections.map((s) => s.publicOdds));
  return winProb * publicOddsProduct * payoutMultiplier - 1;
}

function candidateScore(candidate, weights = {}) {
  const {
    ev = 2.0,
    edge = 1.0,
    prob = 0.6,
    crowdFade = 0.5,
    longshotPenalty = 0.25,
  } = weights;

  const p = candidate.predictedProbability ?? candidate.marketProb;
  const expectedPoolRoi = candidate.expectedPoolRoi ?? (p * candidate.publicOdds - 1);
  const edgeValue = candidate.marketEdge ?? (candidate.marketProb - candidate.publicProb);
  const crowdFadeValue = Math.max(0, (candidate.publicProb ?? 0) - (candidate.marketProb ?? 0));
  const longshot = Math.max(0, (candidate.marketOdds ?? 0) - 4);

  return (
    ev * expectedPoolRoi +
    edge * edgeValue +
    prob * p -
    crowdFade * crowdFadeValue -
    longshotPenalty * longshot
  );
}

const STRATEGIES = [
  {
    id: 'edge_frequency_balanced',
    description: 'Hög frekvens: spelar max 1-3 utfall per omgång där marknaden är tydligt högre än folket.',
    minProbability: 0.26,
    minMarketEdge: 0.10,
    minExpectedPoolRoi: 0.30,
    maxMarketOdds: 4,
    maxSelectionsPerDraw: 3,
    scoreWeights: { ev: 2.0, edge: 1.2, prob: 0.8, crowdFade: 0.6, longshotPenalty: 0.2 },
  },
  {
    id: 'roi_strict_contrarian',
    description: 'Mer ROI, lägre volym: kräver större edge och högre förväntat värde.',
    minProbability: 0.22,
    minMarketEdge: 0.14,
    minExpectedPoolRoi: 0.45,
    maxMarketOdds: 5,
    maxSelectionsPerDraw: 2,
    scoreWeights: { ev: 2.5, edge: 1.6, prob: 0.4, crowdFade: 0.8, longshotPenalty: 0.25 },
  },
  {
    id: 'safe_value_favorites',
    description: 'Lägre varians: bara spelbara favoriter/halvfavoriter som folket undervärderar.',
    minProbability: 0.35,
    minMarketEdge: 0.08,
    minExpectedPoolRoi: 0.18,
    maxMarketOdds: 3,
    maxSelectionsPerDraw: 4,
    scoreWeights: { ev: 1.5, edge: 1.0, prob: 1.2, crowdFade: 0.4, longshotPenalty: 0.4 },
  },
  {
    id: 'full_row_pool_proxy',
    description: 'Radstrategi: bygger en enkelrad med bästa EV per match och spelar bara raden om helrads-EV är hög.',
    minRowExpectedRoi: 0.15,
    minContrarianPicks: 4,
    minAverageProbability: 0.32,
    minWorstProbability: 0.14,
    maxLegMarketOdds: 6,
    scoreWeights: { ev: 2.2, edge: 1.4, prob: 0.5, crowdFade: 0.7, longshotPenalty: 0.2 },
  },
];

function selectSingleOutcomeBets(scoredDraws, strategy) {
  const bets = [];

  for (const draw of scoredDraws) {
    const perMatch = [];

    for (const match of draw.matches) {
      const eligible = match.scoredCandidates
        .filter((c) => (c.predictedProbability ?? c.marketProb) >= strategy.minProbability)
        .filter((c) => (c.marketEdge ?? c.marketProb - c.publicProb) >= strategy.minMarketEdge)
        .filter((c) => (c.expectedPoolRoi ?? ((c.predictedProbability ?? c.marketProb) * c.publicOdds - 1)) >= strategy.minExpectedPoolRoi)
        .filter((c) => c.marketOdds <= strategy.maxMarketOdds)
        .sort((a, b) => candidateScore(b, strategy.scoreWeights) - candidateScore(a, strategy.scoreWeights));

      if (eligible.length) perMatch.push(eligible[0]);
    }

    perMatch
      .sort((a, b) => candidateScore(b, strategy.scoreWeights) - candidateScore(a, strategy.scoreWeights))
      .slice(0, strategy.maxSelectionsPerDraw)
      .forEach((candidate, index) => {
        bets.push({
          ...candidate,
          strategyId: strategy.id,
          rankInDraw: index + 1,
          poolProfit: candidate.isCorrect ? candidate.publicOdds - 1 : -1,
          marketProfit: candidate.isCorrect ? candidate.marketOdds - 1 : -1,
        });
      });
  }

  return bets;
}

function buildFullRowTicket(draw, strategy) {
  if (!Array.isArray(draw.matches) || draw.matches.length !== 8) return null;

  const selections = draw.matches.map((match) => {
    return [...match.scoredCandidates]
      .filter((c) => c.marketOdds <= strategy.maxLegMarketOdds)
      .sort((a, b) => candidateScore(b, strategy.scoreWeights) - candidateScore(a, strategy.scoreWeights))[0];
  });

  if (selections.some((selection) => !selection)) return null;

  const probabilities = selections.map((s) => s.predictedProbability ?? s.marketProb);
  const rowRoi = rowExpectedRoi(selections);
  const contrarianPicks = selections.filter((s) => (s.marketEdge ?? s.marketProb - s.publicProb) > 0).length;

  if (rowRoi < strategy.minRowExpectedRoi) return null;
  if (contrarianPicks < strategy.minContrarianPicks) return null;
  if (probabilities.reduce((a, b) => a + b, 0) / probabilities.length < strategy.minAverageProbability) return null;
  if (Math.min(...probabilities) < strategy.minWorstProbability) return null;

  return {
    drawNumber: draw.drawNumber,
    drawCode: draw.drawCode,
    strategyId: strategy.id,
    ticketSigns: selections.map((s) => s.outcomeSign).join(''),
    predictedWinProbability: product(probabilities),
    expectedProxyPoolRoi: rowRoi,
    publicOddsProduct: product(selections.map((s) => s.publicOdds)),
    marketOddsProduct: product(selections.map((s) => s.marketOdds)),
    contrarianPicks,
    selections,
  };
}

function selectFullRowTickets(scoredDraws, strategy) {
  return scoredDraws.map((draw) => buildFullRowTicket(draw, strategy)).filter(Boolean);
}

module.exports = {
  STRATEGIES,
  candidateScore,
  selectSingleOutcomeBets,
  selectFullRowTickets,
  rowExpectedRoi,
};