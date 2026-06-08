require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const { normalizeDatabaseUrl } = require('./lib/rapidapi-topptipset');

const CONFIG = {
  databaseUrl: process.env.DATABASE_URL,
  objective: process.env.TOPPTIPSET_BACKTEST_OBJECTIVE || 'svenskaspel_result_distribution_single_row',
  trainDraws: Number(process.env.TOPPTIPSET_BACKTEST_TRAIN_DRAWS || 1200),
  validationDraws: Number(process.env.TOPPTIPSET_BACKTEST_VALIDATION_DRAWS || 300),
  testDraws: Number(process.env.TOPPTIPSET_BACKTEST_TEST_DRAWS || 150),
  testStepDraws: Number(process.env.TOPPTIPSET_BACKTEST_STEP_DRAWS || 150),
  minValidationTickets: Number(process.env.TOPPTIPSET_BACKTEST_MIN_VALIDATION_BETS || 40),
  outputDir: path.resolve(process.cwd(), process.env.TOPPTIPSET_BACKTEST_OUTPUT_DIR || 'reports'),
  featureNames: [
    'marketProb',
    'publicProb',
    'marketEdge',
    'absMarketEdge',
    'lnMarketOdds',
    'lnPublicOdds',
    'marketSpread',
    'publicSpread',
    'expertSupport',
    'newspaperSupport',
    'isMarketFavorite',
    'isPublicFavorite',
    'isHomeOutcome',
    'isDrawOutcome',
    'isAwayOutcome',
    'priceDislocation',
    'marketEdgeTimesMarketProb',
    'marketEdgeTimesPublicProb',
  ],
};

const RESULT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS topptipset_real_backtest_runs (
  run_label TEXT PRIMARY KEY,
  objective TEXT NOT NULL,
  train_draws INTEGER NOT NULL,
  validation_draws INTEGER NOT NULL,
  test_draws INTEGER NOT NULL,
  step_draws INTEGER NOT NULL,
  summary JSONB NOT NULL,
  fold_results JSONB NOT NULL,
  config_grid JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS topptipset_real_backtest_tickets (
  run_label TEXT NOT NULL REFERENCES topptipset_real_backtest_runs(run_label) ON DELETE CASCADE,
  fold_index INTEGER NOT NULL,
  draw_number INTEGER NOT NULL,
  draw_code INTEGER,
  ticket_signs TEXT NOT NULL,
  predicted_win_probability NUMERIC NOT NULL,
  expected_proxy_pool_roi NUMERIC NOT NULL,
  expected_proxy_market_roi NUMERIC NOT NULL,
  public_odds_product NUMERIC NOT NULL,
  market_odds_product NUMERIC NOT NULL,
  actual_payout NUMERIC NOT NULL,
  actual_profit NUMERIC NOT NULL,
  public_proxy_profit NUMERIC NOT NULL,
  market_proxy_profit NUMERIC NOT NULL,
  is_winning_ticket BOOLEAN NOT NULL,
  contrarian_picks INTEGER NOT NULL,
  avg_candidate_probability NUMERIC NOT NULL,
  min_candidate_probability NUMERIC NOT NULL,
  max_candidate_market_odds NUMERIC NOT NULL,
  strategy_config JSONB NOT NULL,
  selections JSONB NOT NULL,
  PRIMARY KEY (run_label, fold_index, draw_number)
);

CREATE INDEX IF NOT EXISTS idx_topptipset_real_backtest_tickets_draw
  ON topptipset_real_backtest_tickets (run_label, draw_number);
`;

if (!CONFIG.databaseUrl) {
  console.error('FATAL: DATABASE_URL saknas i .env');
  process.exit(1);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeLog(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.log(value);
}

function sigmoid(value) {
  const bounded = clamp(value, -35, 35);
  return 1 / (1 + Math.exp(-bounded));
}

function mean(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function product(values) {
  return values.reduce((accumulator, value) => accumulator * value, 1);
}

function buildRunLabel() {
  const now = new Date();
  const parts = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
  ];
  return `topptipset-real-roi-${parts.join('')}`;
}

function buildConfigGrid() {
  const blendWeights = [0.4, 0.6, 0.8, 1.0];
  const minTicketProbabilities = [0.0003, 0.0006, 0.001, 0.0015];
  const minExpectedProxyRois = [0, 0.25, 0.5, 1, 2];
  const minAverageCandidateProbabilities = [0.32, 0.35, 0.38];
  const minWorstCandidateProbabilities = [0.14, 0.18, 0.22];
  const maxCandidateMarketOdds = [4, 6, 10];
  const minContrarianPicks = [0, 2, 4];

  const configs = [];
  for (const blendWeight of blendWeights) {
    for (const minTicketProbability of minTicketProbabilities) {
      for (const minExpectedProxyRoi of minExpectedProxyRois) {
        for (const minAverageCandidateProbability of minAverageCandidateProbabilities) {
          for (const minWorstCandidateProbability of minWorstCandidateProbabilities) {
            for (const maxMarketOdds of maxCandidateMarketOdds) {
              for (const minContrarianPickCount of minContrarianPicks) {
                configs.push({
                  blendWeight,
                  minTicketProbability,
                  minExpectedProxyRoi,
                  minAverageCandidateProbability,
                  minWorstCandidateProbability,
                  maxCandidateMarketOdds: maxMarketOdds,
                  minContrarianPickCount,
                });
              }
            }
          }
        }
      }
    }
  }
  return configs;
}

function createCandidate(match, outcomeSign, index, marketProbabilities, publicProbabilities, marketOdds, publicOdds, newspaperSupport) {
  const marketProb = marketProbabilities[index];
  const publicProb = publicProbabilities[index];
  const marketOdd = marketOdds[index];
  const publicOdd = publicOdds[index];
  const maxMarketProb = Math.max(...marketProbabilities);
  const maxPublicProb = Math.max(...publicProbabilities);
  const marketEdge = marketProb - publicProb;
  const priceDislocation = marketOdd > 0 ? publicOdd / marketOdd : 0;

  return {
    drawNumber: match.drawNumber,
    drawCode: match.drawCode,
    drawStart: match.drawStart,
    eventNumber: match.eventNumber,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    matchLabel: `${match.homeTeam}-${match.awayTeam}`,
    matchStart: match.matchStart,
    actualOutcome: match.actualOutcome,
    outcomeSign,
    marketOdds: marketOdd,
    publicOdds: publicOdd,
    marketProb,
    publicProb,
    marketEdge,
    absMarketEdge: Math.abs(marketEdge),
    lnMarketOdds: safeLog(marketOdd),
    lnPublicOdds: safeLog(publicOdd),
    marketSpread: (match.marketDiffPct || 0) / 100,
    publicSpread: (match.publicDiffPct || 0) / 100,
    expertSupport: match.expertTip === outcomeSign ? 1 : 0,
    newspaperSupport: (newspaperSupport[index] || 0) / 10,
    isMarketFavorite: marketProb === maxMarketProb ? 1 : 0,
    isPublicFavorite: publicProb === maxPublicProb ? 1 : 0,
    isHomeOutcome: outcomeSign === '1' ? 1 : 0,
    isDrawOutcome: outcomeSign === 'X' ? 1 : 0,
    isAwayOutcome: outcomeSign === '2' ? 1 : 0,
    priceDislocation,
    marketEdgeTimesMarketProb: marketEdge * marketProb,
    marketEdgeTimesPublicProb: marketEdge * publicProb,
    isCorrect: match.actualOutcome === outcomeSign ? 1 : 0,
  };
}

function buildMatches(rows) {
  return rows.map((row) => {
    const marketProbabilities = [
      Number(row.market_pct_home) / 100,
      Number(row.market_pct_draw) / 100,
      Number(row.market_pct_away) / 100,
    ];
    const publicProbabilities = [
      Number(row.public_pct_home) / 100,
      Number(row.public_pct_draw) / 100,
      Number(row.public_pct_away) / 100,
    ];
    const marketOdds = [
      Number(row.market_odds_home),
      Number(row.market_odds_draw),
      Number(row.market_odds_away),
    ];
    const publicOdds = [
      Number(row.public_odds_home),
      Number(row.public_odds_draw),
      Number(row.public_odds_away),
    ];
    const newspaperSupport = [
      Number(row.newspaper_home || 0),
      Number(row.newspaper_draw || 0),
      Number(row.newspaper_away || 0),
    ];

    const match = {
      drawNumber: Number(row.draw_number),
      drawCode: Number(row.draw_code),
      drawStart: row.draw_start,
      eventNumber: Number(row.event_number),
      homeTeam: row.home_team,
      awayTeam: row.away_team,
      matchStart: row.match_start,
      actualOutcome: row.actual_outcome,
      expertTip: row.expert_tip,
      marketDiffPct: Number(row.market_diff_pct || 0),
      publicDiffPct: Number(row.public_diff_pct || 0),
    };

    return {
      ...match,
      candidates: [
        createCandidate(match, '1', 0, marketProbabilities, publicProbabilities, marketOdds, publicOdds, newspaperSupport),
        createCandidate(match, 'X', 1, marketProbabilities, publicProbabilities, marketOdds, publicOdds, newspaperSupport),
        createCandidate(match, '2', 2, marketProbabilities, publicProbabilities, marketOdds, publicOdds, newspaperSupport),
      ],
    };
  });
}

function extractFeatureVector(candidate, featureNames) {
  return featureNames.map((featureName) => Number(candidate[featureName] || 0));
}

function buildTrainingSet(draws, featureNames) {
  const rows = [];
  for (const draw of draws) {
    for (const match of draw.matches) {
      for (const candidate of match.candidates) {
        rows.push({
          features: extractFeatureVector(candidate, featureNames),
          label: candidate.isCorrect,
        });
      }
    }
  }
  return rows;
}

function computeScaler(trainingRows, featureCount) {
  const means = new Float64Array(featureCount);
  const variances = new Float64Array(featureCount);

  for (const row of trainingRows) {
    for (let index = 0; index < featureCount; index += 1) {
      means[index] += row.features[index];
    }
  }

  for (let index = 0; index < featureCount; index += 1) {
    means[index] /= trainingRows.length;
  }

  for (const row of trainingRows) {
    for (let index = 0; index < featureCount; index += 1) {
      const diff = row.features[index] - means[index];
      variances[index] += diff * diff;
    }
  }

  const scales = new Float64Array(featureCount);
  for (let index = 0; index < featureCount; index += 1) {
    const variance = variances[index] / Math.max(1, trainingRows.length - 1);
    const scale = Math.sqrt(variance);
    scales[index] = scale > 1e-9 ? scale : 1;
  }

  return { means, scales };
}

function standardizeFeatures(featureVector, scaler) {
  const standardized = new Float64Array(featureVector.length);
  for (let index = 0; index < featureVector.length; index += 1) {
    standardized[index] = (featureVector[index] - scaler.means[index]) / scaler.scales[index];
  }
  return standardized;
}

function fitLogisticRegression(trainingRows, featureCount) {
  const scaler = computeScaler(trainingRows, featureCount);
  const examples = trainingRows.map((row) => ({
    x: standardizeFeatures(row.features, scaler),
    y: row.label,
  }));

  const weights = new Float64Array(featureCount + 1);
  const epochs = 18;
  const baseLearningRate = 0.035;
  const regularization = 0.0008;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const learningRate = baseLearningRate / (1 + epoch * 0.12);

    for (const example of examples) {
      let score = weights[0];
      for (let index = 0; index < featureCount; index += 1) {
        score += weights[index + 1] * example.x[index];
      }

      const prediction = sigmoid(score);
      const error = prediction - example.y;

      weights[0] -= learningRate * error;
      for (let index = 0; index < featureCount; index += 1) {
        weights[index + 1] -= learningRate * (error * example.x[index] + regularization * weights[index + 1]);
      }
    }
  }

  return { weights, scaler };
}

function predictProbability(model, featureVector) {
  const standardized = standardizeFeatures(featureVector, model.scaler);
  let score = model.weights[0];
  for (let index = 0; index < standardized.length; index += 1) {
    score += model.weights[index + 1] * standardized[index];
  }
  return sigmoid(score);
}

function attachPredictions(draws, model, featureNames, blendWeight) {
  return draws.map((draw) => ({
    ...draw,
    matches: draw.matches.map((match) => {
      const rawCandidates = match.candidates.map((candidate) => {
        const modelProbability = predictProbability(model, extractFeatureVector(candidate, featureNames));
        const blended = blendWeight * modelProbability + (1 - blendWeight) * candidate.marketProb;
        return {
          ...candidate,
          modelProbability,
          blendedProbability: blended,
        };
      });

      const sumBlended = rawCandidates.reduce((sum, candidate) => sum + Math.max(candidate.blendedProbability, 1e-9), 0);
      const normalizedCandidates = rawCandidates.map((candidate) => {
        const predictedProbability = sumBlended > 0
          ? Math.max(candidate.blendedProbability, 1e-9) / sumBlended
          : candidate.marketProb;
        const expectedPoolRoi = predictedProbability * candidate.publicOdds - 1;
        const expectedMarketRoi = predictedProbability * candidate.marketOdds - 1;

        return {
          ...candidate,
          predictedProbability,
          expectedPoolRoi,
          expectedMarketRoi,
        };
      });

      return {
        ...match,
        scoredCandidates: normalizedCandidates,
      };
    }),
  }));
}

function buildTicketForDraw(draw) {
  if (!Array.isArray(draw.matches) || draw.matches.length !== 8 || draw.actualPayout == null) {
    return null;
  }

  const selectedCandidates = draw.matches.map((match) =>
    [...match.scoredCandidates].sort((left, right) => {
      if (right.expectedPoolRoi !== left.expectedPoolRoi) {
        return right.expectedPoolRoi - left.expectedPoolRoi;
      }
      if (right.predictedProbability !== left.predictedProbability) {
        return right.predictedProbability - left.predictedProbability;
      }
      return right.marketEdge - left.marketEdge;
    })[0]
  );

  if (selectedCandidates.some((candidate) => !candidate)) {
    return null;
  }

  const predictedWinProbability = product(selectedCandidates.map((candidate) => candidate.predictedProbability));
  const publicOddsProduct = product(selectedCandidates.map((candidate) => candidate.publicOdds));
  const marketOddsProduct = product(selectedCandidates.map((candidate) => candidate.marketOdds));
  const expectedProxyPoolRoi = predictedWinProbability * publicOddsProduct - 1;
  const expectedProxyMarketRoi = predictedWinProbability * marketOddsProduct - 1;
  const avgCandidateProbability = mean(selectedCandidates.map((candidate) => candidate.predictedProbability));
  const minCandidateProbability = Math.min(...selectedCandidates.map((candidate) => candidate.predictedProbability));
  const maxCandidateMarketOdds = Math.max(...selectedCandidates.map((candidate) => candidate.marketOdds));
  const contrarianPicks = selectedCandidates.filter((candidate) => candidate.marketEdge > 0).length;
  const isWinningTicket = selectedCandidates.every((candidate) => Boolean(candidate.isCorrect));

  return {
    drawNumber: draw.drawNumber,
    drawCode: draw.drawCode,
    drawStart: draw.drawStart,
    actualPayout: draw.actualPayout,
    payoutWinners: draw.payoutWinners,
    payoutLabel: draw.payoutLabel,
    ticketSigns: selectedCandidates.map((candidate) => candidate.outcomeSign).join(''),
    predictedWinProbability,
    expectedProxyPoolRoi,
    expectedProxyMarketRoi,
    publicOddsProduct,
    marketOddsProduct,
    avgCandidateProbability,
    minCandidateProbability,
    maxCandidateMarketOdds,
    contrarianPicks,
    isWinningTicket,
    actualProfit: isWinningTicket ? draw.actualPayout - 1 : -1,
    publicProxyProfit: isWinningTicket ? publicOddsProduct - 1 : -1,
    marketProxyProfit: isWinningTicket ? marketOddsProduct - 1 : -1,
    selections: selectedCandidates.map((candidate) => ({
      eventNumber: candidate.eventNumber,
      matchLabel: candidate.matchLabel,
      outcomeSign: candidate.outcomeSign,
      predictedProbability: candidate.predictedProbability,
      expectedPoolRoi: candidate.expectedPoolRoi,
      expectedMarketRoi: candidate.expectedMarketRoi,
      marketOdds: candidate.marketOdds,
      publicOdds: candidate.publicOdds,
      actualOutcome: candidate.actualOutcome,
      isCorrect: Boolean(candidate.isCorrect),
    })),
  };
}

function evaluateTickets(tickets) {
  if (!tickets.length) {
    return {
      tickets: 0,
      wins: 0,
      hitRate: 0,
      actualProfit: 0,
      actualRoi: 0,
      publicProxyProfit: 0,
      publicProxyRoi: 0,
      marketProxyProfit: 0,
      marketProxyRoi: 0,
      avgExpectedProxyPoolRoi: 0,
      avgExpectedProxyMarketRoi: 0,
      maxActualDrawdown: 0,
      maxPublicProxyDrawdown: 0,
      maxMarketProxyDrawdown: 0,
    };
  }

  let wins = 0;
  let actualProfit = 0;
  let publicProxyProfit = 0;
  let marketProxyProfit = 0;
  let runningActual = 0;
  let runningPublicProxy = 0;
  let runningMarketProxy = 0;
  let peakActual = 0;
  let peakPublicProxy = 0;
  let peakMarketProxy = 0;
  let maxActualDrawdown = 0;
  let maxPublicProxyDrawdown = 0;
  let maxMarketProxyDrawdown = 0;
  let expectedPoolSum = 0;
  let expectedMarketSum = 0;

  for (const ticket of tickets) {
    if (ticket.isWinningTicket) {
      wins += 1;
    }

    actualProfit += ticket.actualProfit;
    publicProxyProfit += ticket.publicProxyProfit;
    marketProxyProfit += ticket.marketProxyProfit;
    expectedPoolSum += ticket.expectedProxyPoolRoi;
    expectedMarketSum += ticket.expectedProxyMarketRoi;

    runningActual += ticket.actualProfit;
    runningPublicProxy += ticket.publicProxyProfit;
    runningMarketProxy += ticket.marketProxyProfit;
    peakActual = Math.max(peakActual, runningActual);
    peakPublicProxy = Math.max(peakPublicProxy, runningPublicProxy);
    peakMarketProxy = Math.max(peakMarketProxy, runningMarketProxy);
    maxActualDrawdown = Math.max(maxActualDrawdown, peakActual - runningActual);
    maxPublicProxyDrawdown = Math.max(maxPublicProxyDrawdown, peakPublicProxy - runningPublicProxy);
    maxMarketProxyDrawdown = Math.max(maxMarketProxyDrawdown, peakMarketProxy - runningMarketProxy);
  }

  return {
    tickets: tickets.length,
    wins,
    hitRate: Number((wins / tickets.length).toFixed(4)),
    actualProfit: Number(actualProfit.toFixed(4)),
    actualRoi: Number((actualProfit / tickets.length).toFixed(4)),
    publicProxyProfit: Number(publicProxyProfit.toFixed(4)),
    publicProxyRoi: Number((publicProxyProfit / tickets.length).toFixed(4)),
    marketProxyProfit: Number(marketProxyProfit.toFixed(4)),
    marketProxyRoi: Number((marketProxyProfit / tickets.length).toFixed(4)),
    avgExpectedProxyPoolRoi: Number((expectedPoolSum / tickets.length).toFixed(4)),
    avgExpectedProxyMarketRoi: Number((expectedMarketSum / tickets.length).toFixed(4)),
    maxActualDrawdown: Number(maxActualDrawdown.toFixed(4)),
    maxPublicProxyDrawdown: Number(maxPublicProxyDrawdown.toFixed(4)),
    maxMarketProxyDrawdown: Number(maxMarketProxyDrawdown.toFixed(4)),
  };
}

function selectTickets(scoredDraws, config) {
  return scoredDraws
    .map((draw) => buildTicketForDraw(draw))
    .filter(Boolean)
    .filter((ticket) => ticket.predictedWinProbability >= config.minTicketProbability)
    .filter((ticket) => ticket.expectedProxyPoolRoi >= config.minExpectedProxyRoi)
    .filter((ticket) => ticket.avgCandidateProbability >= config.minAverageCandidateProbability)
    .filter((ticket) => ticket.minCandidateProbability >= config.minWorstCandidateProbability)
    .filter((ticket) => ticket.maxCandidateMarketOdds <= config.maxCandidateMarketOdds)
    .filter((ticket) => ticket.contrarianPicks >= config.minContrarianPickCount);
}

function chooseBestConfig(scoredDrawsByBlend, configGrid) {
  const candidates = configGrid.map((config) => {
    const selectedTickets = selectTickets(scoredDrawsByBlend.get(config.blendWeight), config);
    const metrics = evaluateTickets(selectedTickets);
    return {
      config,
      metrics,
    };
  });

  const viable = candidates.filter((candidate) => candidate.metrics.tickets >= CONFIG.minValidationTickets);
  const pool = viable.length ? viable : candidates.filter((candidate) => candidate.metrics.tickets >= 10);
  const selectionPool = pool.length ? pool : candidates;

  selectionPool.sort((left, right) => {
    if (right.metrics.actualRoi !== left.metrics.actualRoi) {
      return right.metrics.actualRoi - left.metrics.actualRoi;
    }
    if (right.metrics.actualProfit !== left.metrics.actualProfit) {
      return right.metrics.actualProfit - left.metrics.actualProfit;
    }
    if (right.metrics.tickets !== left.metrics.tickets) {
      return right.metrics.tickets - left.metrics.tickets;
    }
    return right.metrics.hitRate - left.metrics.hitRate;
  });

  return selectionPool[0];
}

function buildDrawWindows(draws) {
  const windows = [];
  const minimumNeeded = CONFIG.trainDraws + CONFIG.validationDraws + CONFIG.testDraws;

  if (draws.length < minimumNeeded) {
    return windows;
  }

  for (
    let validationStart = CONFIG.trainDraws;
    validationStart + CONFIG.validationDraws + CONFIG.testDraws <= draws.length;
    validationStart += CONFIG.testStepDraws
  ) {
    const validationEnd = validationStart + CONFIG.validationDraws;
    const testEnd = validationEnd + CONFIG.testDraws;

    windows.push({
      train: draws.slice(0, validationStart),
      validation: draws.slice(validationStart, validationEnd),
      test: draws.slice(validationEnd, testEnd),
    });
  }

  return windows;
}

async function ensureSchema(client) {
  await client.query(RESULT_SCHEMA_SQL);
}

async function loadHistory(client) {
  const result = await client.query(`
    SELECT
      d.draw_number,
      d.draw_code,
      d.first_match_start AS draw_start,
      d.svenska_spel_result_amount AS actual_payout,
      d.svenska_spel_result_winners AS payout_winners,
      d.svenska_spel_result_label AS payout_label,
      e.event_number,
      e.home_team,
      e.away_team,
      e.match_start,
      e.outcome AS actual_outcome,
      e.expert_tip,
      e.market_diff_pct,
      e.public_diff_pct,
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
      e.newspaper_away
    FROM tipsxtra_topptipset_events e
    JOIN tipsxtra_topptipset_complete_real_payout_draws d
      ON d.draw_number = e.draw_number
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
        payoutWinners: row.payout_winners == null ? null : Number(row.payout_winners),
        payoutLabel: row.payout_label,
        matches: [],
      });
    }
    grouped.get(row.draw_number).matches.push(row);
  }

  return [...grouped.values()]
    .map((draw) => ({
      ...draw,
      matches: buildMatches(draw.matches),
    }))
    .sort((left, right) => {
      if (left.drawStart !== right.drawStart) {
        return new Date(left.drawStart) - new Date(right.drawStart);
      }
      return left.drawNumber - right.drawNumber;
    });
}

function buildFoldSummary(foldIndex, trainDraws, validationDraws, testDraws, bestValidation, testMetrics) {
  return {
    foldIndex,
    trainDrawRange: [trainDraws[0].drawNumber, trainDraws[trainDraws.length - 1].drawNumber],
    validationDrawRange: [validationDraws[0].drawNumber, validationDraws[validationDraws.length - 1].drawNumber],
    testDrawRange: [testDraws[0].drawNumber, testDraws[testDraws.length - 1].drawNumber],
    chosenConfig: bestValidation.config,
    validationMetrics: bestValidation.metrics,
    testMetrics,
  };
}

function summarizeFolds(folds) {
  const aggregate = {
    folds: folds.length,
    totalTickets: 0,
    totalWins: 0,
    totalActualProfit: 0,
    totalPublicProxyProfit: 0,
    totalMarketProxyProfit: 0,
    avgActualRoi: 0,
    avgPublicProxyRoi: 0,
    avgMarketProxyRoi: 0,
    avgHitRate: 0,
    avgExpectedProxyPoolRoi: 0,
    avgExpectedProxyMarketRoi: 0,
    worstFoldActualRoi: 0,
    bestFoldActualRoi: 0,
  };

  if (!folds.length) {
    return aggregate;
  }

  aggregate.worstFoldActualRoi = Number.POSITIVE_INFINITY;
  aggregate.bestFoldActualRoi = Number.NEGATIVE_INFINITY;

  for (const fold of folds) {
    const metrics = fold.testMetrics;
    aggregate.totalTickets += metrics.tickets;
    aggregate.totalWins += metrics.wins;
    aggregate.totalActualProfit += metrics.actualProfit;
    aggregate.totalPublicProxyProfit += metrics.publicProxyProfit;
    aggregate.totalMarketProxyProfit += metrics.marketProxyProfit;
    aggregate.avgActualRoi += metrics.actualRoi;
    aggregate.avgPublicProxyRoi += metrics.publicProxyRoi;
    aggregate.avgMarketProxyRoi += metrics.marketProxyRoi;
    aggregate.avgHitRate += metrics.hitRate;
    aggregate.avgExpectedProxyPoolRoi += metrics.avgExpectedProxyPoolRoi;
    aggregate.avgExpectedProxyMarketRoi += metrics.avgExpectedProxyMarketRoi;
    aggregate.worstFoldActualRoi = Math.min(aggregate.worstFoldActualRoi, metrics.actualRoi);
    aggregate.bestFoldActualRoi = Math.max(aggregate.bestFoldActualRoi, metrics.actualRoi);
  }

  aggregate.avgActualRoi = Number((aggregate.avgActualRoi / folds.length).toFixed(4));
  aggregate.avgPublicProxyRoi = Number((aggregate.avgPublicProxyRoi / folds.length).toFixed(4));
  aggregate.avgMarketProxyRoi = Number((aggregate.avgMarketProxyRoi / folds.length).toFixed(4));
  aggregate.avgHitRate = Number((aggregate.avgHitRate / folds.length).toFixed(4));
  aggregate.avgExpectedProxyPoolRoi = Number((aggregate.avgExpectedProxyPoolRoi / folds.length).toFixed(4));
  aggregate.avgExpectedProxyMarketRoi = Number((aggregate.avgExpectedProxyMarketRoi / folds.length).toFixed(4));
  aggregate.totalActualProfit = Number(aggregate.totalActualProfit.toFixed(4));
  aggregate.totalPublicProxyProfit = Number(aggregate.totalPublicProxyProfit.toFixed(4));
  aggregate.totalMarketProxyProfit = Number(aggregate.totalMarketProxyProfit.toFixed(4));
  aggregate.totalActualRoi = aggregate.totalTickets
    ? Number((aggregate.totalActualProfit / aggregate.totalTickets).toFixed(4))
    : 0;
  aggregate.totalPublicProxyRoi = aggregate.totalTickets
    ? Number((aggregate.totalPublicProxyProfit / aggregate.totalTickets).toFixed(4))
    : 0;
  aggregate.totalMarketProxyRoi = aggregate.totalTickets
    ? Number((aggregate.totalMarketProxyProfit / aggregate.totalTickets).toFixed(4))
    : 0;
  aggregate.totalHitRate = aggregate.totalTickets
    ? Number((aggregate.totalWins / aggregate.totalTickets).toFixed(4))
    : 0;
  aggregate.worstFoldActualRoi = Number(aggregate.worstFoldActualRoi.toFixed(4));
  aggregate.bestFoldActualRoi = Number(aggregate.bestFoldActualRoi.toFixed(4));

  return aggregate;
}

async function saveResults(client, runLabel, summary, foldResults, configGrid, selectedTickets) {
  await client.query(
    `
      INSERT INTO topptipset_real_backtest_runs (
        run_label,
        objective,
        train_draws,
        validation_draws,
        test_draws,
        step_draws,
        summary,
        fold_results,
        config_grid
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb
      )
      ON CONFLICT (run_label)
      DO UPDATE SET
        objective = EXCLUDED.objective,
        train_draws = EXCLUDED.train_draws,
        validation_draws = EXCLUDED.validation_draws,
        test_draws = EXCLUDED.test_draws,
        step_draws = EXCLUDED.step_draws,
        summary = EXCLUDED.summary,
        fold_results = EXCLUDED.fold_results,
        config_grid = EXCLUDED.config_grid,
        created_at = NOW()
    `,
    [
      runLabel,
      CONFIG.objective,
      CONFIG.trainDraws,
      CONFIG.validationDraws,
      CONFIG.testDraws,
      CONFIG.testStepDraws,
      JSON.stringify(summary),
      JSON.stringify(foldResults),
      JSON.stringify(configGrid),
    ]
  );

  await client.query('DELETE FROM topptipset_real_backtest_tickets WHERE run_label = $1', [runLabel]);

  if (!selectedTickets.length) {
    return;
  }

  const batchSize = 150;
  for (let offset = 0; offset < selectedTickets.length; offset += batchSize) {
    const batch = selectedTickets.slice(offset, offset + batchSize);
    const values = [];
    const placeholders = batch.map((ticket, index) => {
      const base = index * 21;
      values.push(
        runLabel,
        ticket.foldIndex,
        ticket.drawNumber,
        ticket.drawCode,
        ticket.ticketSigns,
        ticket.predictedWinProbability,
        ticket.expectedProxyPoolRoi,
        ticket.expectedProxyMarketRoi,
        ticket.publicOddsProduct,
        ticket.marketOddsProduct,
        ticket.actualPayout,
        ticket.actualProfit,
        ticket.publicProxyProfit,
        ticket.marketProxyProfit,
        Boolean(ticket.isWinningTicket),
        ticket.contrarianPicks,
        ticket.avgCandidateProbability,
        ticket.minCandidateProbability,
        ticket.maxCandidateMarketOdds,
        JSON.stringify(ticket.strategyConfig),
        JSON.stringify(ticket.selections)
      );

      return `(
        $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7},
        $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14},
        $${base + 15}, $${base + 16}, $${base + 17}, $${base + 18}, $${base + 19}, $${base + 20}::jsonb,
        $${base + 21}::jsonb
      )`;
    });

    await client.query(
      `
        INSERT INTO topptipset_real_backtest_tickets (
          run_label,
          fold_index,
          draw_number,
          draw_code,
          ticket_signs,
          predicted_win_probability,
          expected_proxy_pool_roi,
          expected_proxy_market_roi,
          public_odds_product,
          market_odds_product,
          actual_payout,
          actual_profit,
          public_proxy_profit,
          market_proxy_profit,
          is_winning_ticket,
          contrarian_picks,
          avg_candidate_probability,
          min_candidate_probability,
          max_candidate_market_odds,
          strategy_config,
          selections
        )
        VALUES ${placeholders.join(', ')}
      `,
      values
    );
  }
}

function writeReportFiles(runLabel, report, selectedTickets) {
  fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  const jsonPath = path.join(CONFIG.outputDir, `${runLabel}.json`);
  const csvPath = path.join(CONFIG.outputDir, `${runLabel}-tickets.csv`);

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const csvLines = [
    [
      'fold_index',
      'draw_number',
      'ticket_signs',
      'predicted_win_probability',
      'expected_proxy_pool_roi',
      'expected_proxy_market_roi',
      'actual_payout',
      'actual_profit',
      'public_proxy_profit',
      'market_proxy_profit',
      'is_winning_ticket',
      'contrarian_picks',
      'avg_candidate_probability',
      'min_candidate_probability',
      'max_candidate_market_odds',
    ].join(','),
    ...selectedTickets.map((ticket) =>
      [
        ticket.foldIndex,
        ticket.drawNumber,
        ticket.ticketSigns,
        ticket.predictedWinProbability.toFixed(8),
        ticket.expectedProxyPoolRoi.toFixed(6),
        ticket.expectedProxyMarketRoi.toFixed(6),
        ticket.actualPayout.toFixed(4),
        ticket.actualProfit.toFixed(4),
        ticket.publicProxyProfit.toFixed(4),
        ticket.marketProxyProfit.toFixed(4),
        ticket.isWinningTicket ? '1' : '0',
        ticket.contrarianPicks,
        ticket.avgCandidateProbability.toFixed(6),
        ticket.minCandidateProbability.toFixed(6),
        ticket.maxCandidateMarketOdds.toFixed(4),
      ].join(',')
    ),
  ];

  fs.writeFileSync(csvPath, csvLines.join('\n'));

  return { jsonPath, csvPath };
}

async function main() {
  const configGrid = buildConfigGrid();
  const runLabel = buildRunLabel();
  const loadPool = new Pool({
    connectionString: normalizeDatabaseUrl(CONFIG.databaseUrl),
  });

  let allDraws;

  try {
    const loadClient = await loadPool.connect();

    try {
      await ensureSchema(loadClient);
      allDraws = await loadHistory(loadClient);
    } finally {
      loadClient.release();
    }
  } finally {
    await loadPool.end();
  }

  const windows = buildDrawWindows(allDraws);

  if (!windows.length) {
    throw new Error('For fa kompletta draws med riktig Svenska Spel-utdelning for nuvarande walk-forward-fonster.');
  }

  const foldResults = [];
  const selectedTickets = [];

  for (let foldIndex = 0; foldIndex < windows.length; foldIndex += 1) {
    console.log(`Running fold ${foldIndex + 1}/${windows.length}...`);

    const window = windows[foldIndex];
    const trainingRows = buildTrainingSet(window.train, CONFIG.featureNames);
    const model = fitLogisticRegression(trainingRows, CONFIG.featureNames.length);

    const validationScoresByBlend = new Map();
    const testScoresByBlend = new Map();
    const blendWeights = [...new Set(configGrid.map((config) => config.blendWeight))];

    for (const blendWeight of blendWeights) {
      validationScoresByBlend.set(blendWeight, attachPredictions(window.validation, model, CONFIG.featureNames, blendWeight));
      testScoresByBlend.set(blendWeight, attachPredictions(window.test, model, CONFIG.featureNames, blendWeight));
    }

    const bestConfig = chooseBestConfig(validationScoresByBlend, configGrid);
    const testTickets = selectTickets(testScoresByBlend.get(bestConfig.config.blendWeight), bestConfig.config).map((ticket) => ({
      ...ticket,
      foldIndex,
      strategyConfig: bestConfig.config,
    }));
    const testMetrics = evaluateTickets(testTickets);

    selectedTickets.push(...testTickets);
    foldResults.push(buildFoldSummary(foldIndex, window.train, window.validation, window.test, bestConfig, testMetrics));

    console.log(
      `Fold ${foldIndex + 1}/${windows.length} done: ` +
        `${testMetrics.tickets} tickets, actual ROI ${testMetrics.actualRoi.toFixed(4)}`
    );
  }

  const summary = {
    runLabel,
    objective: CONFIG.objective,
    drawCount: allDraws.length,
    foldCount: foldResults.length,
    aggregateTestMetrics: summarizeFolds(foldResults),
  };

  const savePool = new Pool({
    connectionString: normalizeDatabaseUrl(CONFIG.databaseUrl),
  });

  try {
    const saveClient = await savePool.connect();

    try {
      await saveResults(saveClient, runLabel, summary, foldResults, configGrid, selectedTickets);
    } finally {
      saveClient.release();
    }
  } finally {
    await savePool.end();
  }

  const report = {
    summary,
    foldResults,
  };

  const paths = writeReportFiles(runLabel, report, selectedTickets);

  console.log(JSON.stringify({ ...summary, reportPaths: paths }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
