require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const { normalizeDatabaseUrl } = require('./lib/rapidapi-topptipset');

const CONFIG = {
  databaseUrl: process.env.DATABASE_URL,
  objective: process.env.TOPPTIPSET_BACKTEST_OBJECTIVE || 'pool_proxy',
  trainDraws: Number(process.env.TOPPTIPSET_BACKTEST_TRAIN_DRAWS || 1200),
  validationDraws: Number(process.env.TOPPTIPSET_BACKTEST_VALIDATION_DRAWS || 300),
  testDraws: Number(process.env.TOPPTIPSET_BACKTEST_TEST_DRAWS || 150),
  testStepDraws: Number(process.env.TOPPTIPSET_BACKTEST_STEP_DRAWS || 150),
  minValidationBets: Number(process.env.TOPPTIPSET_BACKTEST_MIN_VALIDATION_BETS || 40),
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
CREATE TABLE IF NOT EXISTS topptipset_backtest_runs (
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

CREATE TABLE IF NOT EXISTS topptipset_backtest_bets (
  run_label TEXT NOT NULL REFERENCES topptipset_backtest_runs(run_label) ON DELETE CASCADE,
  fold_index INTEGER NOT NULL,
  draw_number INTEGER NOT NULL,
  event_number INTEGER NOT NULL,
  outcome_sign TEXT NOT NULL,
  match_label TEXT NOT NULL,
  predicted_probability NUMERIC,
  expected_pool_roi NUMERIC,
  expected_market_roi NUMERIC,
  market_odds NUMERIC,
  public_odds NUMERIC,
  actual_outcome TEXT,
  is_correct BOOLEAN NOT NULL,
  pool_profit NUMERIC NOT NULL,
  market_profit NUMERIC NOT NULL,
  strategy_config JSONB NOT NULL,
  PRIMARY KEY (run_label, fold_index, draw_number, event_number, outcome_sign)
);

CREATE INDEX IF NOT EXISTS idx_topptipset_backtest_bets_draw
  ON topptipset_backtest_bets (run_label, draw_number, event_number);
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
  return `topptipset-roi-${parts.join('')}`;
}

function buildConfigGrid() {
  const blendWeights = [0.4, 0.6, 0.8, 1.0];
  const minExpectedPoolRois = [0.02, 0.05, 0.1, 0.15, 0.2];
  const minProbabilities = [0.18, 0.22, 0.26, 0.3];
  const maxSelectionsPerDraw = [1, 2, 3, 4];
  const maxMarketOdds = [4, 8, 20];
  const requireContrarianOptions = [true, false];

  const configs = [];
  for (const blendWeight of blendWeights) {
    for (const minExpectedPoolRoi of minExpectedPoolRois) {
      for (const minProbability of minProbabilities) {
        for (const maxSelections of maxSelectionsPerDraw) {
          for (const maxOdds of maxMarketOdds) {
            for (const requireContrarian of requireContrarianOptions) {
              configs.push({
                blendWeight,
                minExpectedPoolRoi,
                minProbability,
                maxSelections,
                maxMarketOdds: maxOdds,
                requireContrarian,
              });
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

function evaluateBets(bets) {
  if (!bets.length) {
    return {
      bets: 0,
      wins: 0,
      hitRate: 0,
      poolProfit: 0,
      poolRoi: 0,
      marketProfit: 0,
      marketRoi: 0,
      avgExpectedPoolRoi: 0,
      avgExpectedMarketRoi: 0,
      maxPoolDrawdown: 0,
      maxMarketDrawdown: 0,
    };
  }

  let wins = 0;
  let poolProfit = 0;
  let marketProfit = 0;
  let runningPool = 0;
  let runningMarket = 0;
  let peakPool = 0;
  let peakMarket = 0;
  let maxPoolDrawdown = 0;
  let maxMarketDrawdown = 0;
  let expectedPoolSum = 0;
  let expectedMarketSum = 0;

  for (const bet of bets) {
    if (bet.isCorrect) {
      wins += 1;
    }

    poolProfit += bet.poolProfit;
    marketProfit += bet.marketProfit;
    expectedPoolSum += bet.expectedPoolRoi;
    expectedMarketSum += bet.expectedMarketRoi;

    runningPool += bet.poolProfit;
    runningMarket += bet.marketProfit;
    peakPool = Math.max(peakPool, runningPool);
    peakMarket = Math.max(peakMarket, runningMarket);
    maxPoolDrawdown = Math.max(maxPoolDrawdown, peakPool - runningPool);
    maxMarketDrawdown = Math.max(maxMarketDrawdown, peakMarket - runningMarket);
  }

  return {
    bets: bets.length,
    wins,
    hitRate: Number((wins / bets.length).toFixed(4)),
    poolProfit: Number(poolProfit.toFixed(4)),
    poolRoi: Number((poolProfit / bets.length).toFixed(4)),
    marketProfit: Number(marketProfit.toFixed(4)),
    marketRoi: Number((marketProfit / bets.length).toFixed(4)),
    avgExpectedPoolRoi: Number((expectedPoolSum / bets.length).toFixed(4)),
    avgExpectedMarketRoi: Number((expectedMarketSum / bets.length).toFixed(4)),
    maxPoolDrawdown: Number(maxPoolDrawdown.toFixed(4)),
    maxMarketDrawdown: Number(maxMarketDrawdown.toFixed(4)),
  };
}

function selectBets(scoredDraws, config) {
  const selectedBets = [];

  for (const draw of scoredDraws) {
    const perMatchSelections = [];

    for (const match of draw.matches) {
      const eligible = match.scoredCandidates
        .filter((candidate) => candidate.predictedProbability >= config.minProbability)
        .filter((candidate) => candidate.marketOdds <= config.maxMarketOdds)
        .filter((candidate) => candidate.expectedPoolRoi >= config.minExpectedPoolRoi)
        .filter((candidate) => !config.requireContrarian || candidate.marketEdge > 0)
        .sort((left, right) => {
          if (right.expectedPoolRoi !== left.expectedPoolRoi) {
            return right.expectedPoolRoi - left.expectedPoolRoi;
          }
          if (right.predictedProbability !== left.predictedProbability) {
            return right.predictedProbability - left.predictedProbability;
          }
          return right.marketEdge - left.marketEdge;
        });

      if (!eligible.length) {
        continue;
      }

      perMatchSelections.push(eligible[0]);
    }

    perMatchSelections
      .sort((left, right) => {
        if (right.expectedPoolRoi !== left.expectedPoolRoi) {
          return right.expectedPoolRoi - left.expectedPoolRoi;
        }
        if (right.predictedProbability !== left.predictedProbability) {
          return right.predictedProbability - left.predictedProbability;
        }
        return right.marketEdge - left.marketEdge;
      })
      .slice(0, config.maxSelections)
      .forEach((candidate, index) => {
        selectedBets.push({
          ...candidate,
          rankInDraw: index + 1,
          poolProfit: candidate.isCorrect ? candidate.publicOdds - 1 : -1,
          marketProfit: candidate.isCorrect ? candidate.marketOdds - 1 : -1,
        });
      });
  }

  return selectedBets;
}

function chooseBestConfig(scoredDrawsByBlend, configGrid) {
  const candidates = configGrid.map((config) => {
    const selectedBets = selectBets(scoredDrawsByBlend.get(config.blendWeight), config);
    const metrics = evaluateBets(selectedBets);
    return {
      config,
      metrics,
    };
  });

  const viable = candidates.filter((candidate) => candidate.metrics.bets >= CONFIG.minValidationBets);
  const pool = viable.length ? viable : candidates.filter((candidate) => candidate.metrics.bets >= 10);
  const selectionPool = pool.length ? pool : candidates;

  selectionPool.sort((left, right) => {
    if (right.metrics.poolRoi !== left.metrics.poolRoi) {
      return right.metrics.poolRoi - left.metrics.poolRoi;
    }
    if (right.metrics.poolProfit !== left.metrics.poolProfit) {
      return right.metrics.poolProfit - left.metrics.poolProfit;
    }
    if (right.metrics.bets !== left.metrics.bets) {
      return right.metrics.bets - left.metrics.bets;
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
    JOIN tipsxtra_topptipset_complete_draws d
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
    totalBets: 0,
    totalWins: 0,
    totalPoolProfit: 0,
    totalMarketProfit: 0,
    avgPoolRoi: 0,
    avgMarketRoi: 0,
    avgHitRate: 0,
    avgExpectedPoolRoi: 0,
    avgExpectedMarketRoi: 0,
    worstFoldPoolRoi: 0,
    bestFoldPoolRoi: 0,
  };

  if (!folds.length) {
    return aggregate;
  }

  aggregate.worstFoldPoolRoi = Number.POSITIVE_INFINITY;
  aggregate.bestFoldPoolRoi = Number.NEGATIVE_INFINITY;

  for (const fold of folds) {
    const metrics = fold.testMetrics;
    aggregate.totalBets += metrics.bets;
    aggregate.totalWins += metrics.wins;
    aggregate.totalPoolProfit += metrics.poolProfit;
    aggregate.totalMarketProfit += metrics.marketProfit;
    aggregate.avgPoolRoi += metrics.poolRoi;
    aggregate.avgMarketRoi += metrics.marketRoi;
    aggregate.avgHitRate += metrics.hitRate;
    aggregate.avgExpectedPoolRoi += metrics.avgExpectedPoolRoi;
    aggregate.avgExpectedMarketRoi += metrics.avgExpectedMarketRoi;
    aggregate.worstFoldPoolRoi = Math.min(aggregate.worstFoldPoolRoi, metrics.poolRoi);
    aggregate.bestFoldPoolRoi = Math.max(aggregate.bestFoldPoolRoi, metrics.poolRoi);
  }

  aggregate.avgPoolRoi = Number((aggregate.avgPoolRoi / folds.length).toFixed(4));
  aggregate.avgMarketRoi = Number((aggregate.avgMarketRoi / folds.length).toFixed(4));
  aggregate.avgHitRate = Number((aggregate.avgHitRate / folds.length).toFixed(4));
  aggregate.avgExpectedPoolRoi = Number((aggregate.avgExpectedPoolRoi / folds.length).toFixed(4));
  aggregate.avgExpectedMarketRoi = Number((aggregate.avgExpectedMarketRoi / folds.length).toFixed(4));
  aggregate.totalPoolProfit = Number(aggregate.totalPoolProfit.toFixed(4));
  aggregate.totalMarketProfit = Number(aggregate.totalMarketProfit.toFixed(4));
  aggregate.totalPoolRoi = aggregate.totalBets
    ? Number((aggregate.totalPoolProfit / aggregate.totalBets).toFixed(4))
    : 0;
  aggregate.totalMarketRoi = aggregate.totalBets
    ? Number((aggregate.totalMarketProfit / aggregate.totalBets).toFixed(4))
    : 0;
  aggregate.totalHitRate = aggregate.totalBets
    ? Number((aggregate.totalWins / aggregate.totalBets).toFixed(4))
    : 0;
  aggregate.worstFoldPoolRoi = Number(aggregate.worstFoldPoolRoi.toFixed(4));
  aggregate.bestFoldPoolRoi = Number(aggregate.bestFoldPoolRoi.toFixed(4));

  return aggregate;
}

async function saveResults(client, runLabel, summary, foldResults, configGrid, selectedBets) {
  await client.query(
    `
      INSERT INTO topptipset_backtest_runs (
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

  if (!selectedBets.length) {
    return;
  }

  await client.query('DELETE FROM topptipset_backtest_bets WHERE run_label = $1', [runLabel]);

  const batchSize = 200;
  for (let offset = 0; offset < selectedBets.length; offset += batchSize) {
    const batch = selectedBets.slice(offset, offset + batchSize);
    const values = [];
    const placeholders = batch.map((bet, index) => {
      const base = index * 16;
      values.push(
        runLabel,
        bet.foldIndex,
        bet.drawNumber,
        bet.eventNumber,
        bet.outcomeSign,
        bet.matchLabel,
        bet.predictedProbability,
        bet.expectedPoolRoi,
        bet.expectedMarketRoi,
        bet.marketOdds,
        bet.publicOdds,
        bet.actualOutcome,
        Boolean(bet.isCorrect),
        bet.poolProfit,
        bet.marketProfit,
        JSON.stringify(bet.strategyConfig)
      );

      return `(
        $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7},
        $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14},
        $${base + 15}, $${base + 16}::jsonb
      )`;
    });

    await client.query(
      `
        INSERT INTO topptipset_backtest_bets (
          run_label,
          fold_index,
          draw_number,
          event_number,
          outcome_sign,
          match_label,
          predicted_probability,
          expected_pool_roi,
          expected_market_roi,
          market_odds,
          public_odds,
          actual_outcome,
          is_correct,
          pool_profit,
          market_profit,
          strategy_config
        )
        VALUES ${placeholders.join(', ')}
      `,
      values
    );
  }
}

function writeReportFiles(runLabel, report, selectedBets) {
  fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  const jsonPath = path.join(CONFIG.outputDir, `${runLabel}.json`);
  const csvPath = path.join(CONFIG.outputDir, `${runLabel}-bets.csv`);

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const csvLines = [
    [
      'fold_index',
      'draw_number',
      'event_number',
      'match_label',
      'outcome_sign',
      'predicted_probability',
      'expected_pool_roi',
      'expected_market_roi',
      'market_odds',
      'public_odds',
      'actual_outcome',
      'is_correct',
      'pool_profit',
      'market_profit',
    ].join(','),
    ...selectedBets.map((bet) =>
      [
        bet.foldIndex,
        bet.drawNumber,
        bet.eventNumber,
        `"${bet.matchLabel.replace(/"/g, '""')}"`,
        bet.outcomeSign,
        bet.predictedProbability.toFixed(6),
        bet.expectedPoolRoi.toFixed(6),
        bet.expectedMarketRoi.toFixed(6),
        bet.marketOdds.toFixed(4),
        bet.publicOdds.toFixed(4),
        bet.actualOutcome,
        bet.isCorrect ? '1' : '0',
        bet.poolProfit.toFixed(4),
        bet.marketProfit.toFixed(4),
      ].join(',')
    ),
  ];

  fs.writeFileSync(csvPath, csvLines.join('\n'));

  return { jsonPath, csvPath };
}

async function main() {
  const configGrid = buildConfigGrid();
  const runLabel = buildRunLabel();
  const pool = new Pool({
    connectionString: normalizeDatabaseUrl(CONFIG.databaseUrl),
  });

  try {
    const client = await pool.connect();

    try {
      await ensureSchema(client);
      const allDraws = await loadHistory(client);
      const windows = buildDrawWindows(allDraws);

      if (!windows.length) {
        throw new Error('För få kompletta historical draws för att köra walk-forward-backtest med nuvarande fönsterstorlek.');
      }

      const foldResults = [];
      const selectedBets = [];

      for (let foldIndex = 0; foldIndex < windows.length; foldIndex += 1) {
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

        const scoredTestDraws = testScoresByBlend.get(bestConfig.config.blendWeight);
        const foldBets = selectBets(scoredTestDraws, bestConfig.config).map((bet) => ({
          ...bet,
          foldIndex,
          strategyConfig: bestConfig.config,
        }));
        const testMetrics = evaluateBets(foldBets);

        selectedBets.push(...foldBets);
        foldResults.push(
          buildFoldSummary(
            foldIndex,
            window.train,
            window.validation,
            window.test,
            bestConfig,
            testMetrics
          )
        );
      }

      const summary = {
        runLabel,
        objective: CONFIG.objective,
        dataset: {
          totalCompleteDraws: allDraws.length,
          totalMatches: allDraws.length * 8,
          trainDraws: CONFIG.trainDraws,
          validationDraws: CONFIG.validationDraws,
          testDraws: CONFIG.testDraws,
          stepDraws: CONFIG.testStepDraws,
          foldCount: foldResults.length,
        },
        aggregateTestMetrics: summarizeFolds(foldResults),
      };

      await client.query('BEGIN');
      await saveResults(client, runLabel, summary, foldResults, configGrid, selectedBets);
      await client.query('COMMIT');

      const report = {
        summary,
        foldResults,
      };
      const files = writeReportFiles(runLabel, report, selectedBets);

      console.log(
        JSON.stringify(
          {
            ok: true,
            runLabel,
            files,
            summary,
          },
          null,
          2
        )
      );
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
