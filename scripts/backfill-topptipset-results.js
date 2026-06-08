require('dotenv').config();

const https = require('https');
const { Pool } = require('pg');

const { normalizeDatabaseUrl, parseNumberList } = require('./lib/rapidapi-topptipset');

const CONFIG = {
  apiKey: process.env.SVENSKA_SPEL_API_NYCKEL,
  baseUrl: 'https://api.www.svenskaspel.se/external/1/draw/topptipset/draws',
  databaseUrl: process.env.DATABASE_URL,
  concurrency: Number(process.env.TOPPTIPSET_RESULT_CONCURRENCY || 3),
  maxRetries: Number(process.env.TOPPTIPSET_RESULT_MAX_RETRIES || 4),
  requestDelayMs: Number(process.env.TOPPTIPSET_RESULT_REQUEST_DELAY_MS || 125),
  targetDrawNumbers: [...new Set(parseNumberList(process.env.TOPPTIPSET_RESULT_DRAW_NUMBERS || ''))].sort(
    (left, right) => left - right
  ),
  forceRefresh: /^(1|true|yes|ja)$/i.test(String(process.env.TOPPTIPSET_RESULT_FORCE || '')),
};

const SCHEMA_SQL = `
ALTER TABLE tipsxtra_topptipset_draws
  ADD COLUMN IF NOT EXISTS svenska_spel_result_available BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS svenska_spel_result_label TEXT,
  ADD COLUMN IF NOT EXISTS svenska_spel_result_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS svenska_spel_result_winners INTEGER,
  ADD COLUMN IF NOT EXISTS svenska_spel_result_distribution JSONB,
  ADD COLUMN IF NOT EXISTS svenska_spel_result_turnover NUMERIC,
  ADD COLUMN IF NOT EXISTS svenska_spel_raw_result JSONB,
  ADD COLUMN IF NOT EXISTS svenska_spel_imported_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tipsxtra_topptipset_draws_real_result
  ON tipsxtra_topptipset_draws (
    complete_backtest,
    svenska_spel_result_available,
    draw_number
  );

CREATE OR REPLACE VIEW tipsxtra_topptipset_complete_real_payout_draws AS
SELECT *
FROM tipsxtra_topptipset_draws
WHERE complete_backtest
  AND svenska_spel_result_available
  AND svenska_spel_result_amount IS NOT NULL
ORDER BY draw_number ASC;
`;

if (!CONFIG.databaseUrl) {
  console.error('FATAL: DATABASE_URL saknas i .env');
  process.exit(1);
}

if (!CONFIG.apiKey) {
  console.error('FATAL: SVENSKA_SPEL_API_NYCKEL saknas i .env');
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDecimal(value) {
  if (value == null || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  const normalized = String(value).trim().replace(/\s+/g, '').replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseInteger(value) {
  const parsed = parseDecimal(value);
  return parsed == null ? null : Math.round(parsed);
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          let data = null;
          try {
            data = body ? JSON.parse(body) : null;
          } catch (error) {
            data = null;
          }

          resolve({
            status: response.statusCode || 0,
            body,
            data,
          });
        });
      })
      .on('error', reject);
  });
}

async function fetchWithRetry(drawNumber) {
  const url = `${CONFIG.baseUrl}/${drawNumber}/result?accesskey=${CONFIG.apiKey}`;
  let lastError = null;

  for (let attempt = 0; attempt < CONFIG.maxRetries; attempt += 1) {
    if (attempt > 0) {
      await sleep(Math.max(CONFIG.requestDelayMs * Math.pow(2, attempt), 250));
    } else if (CONFIG.requestDelayMs > 0) {
      await sleep(CONFIG.requestDelayMs);
    }

    try {
      const response = await fetchJson(url);
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Misslyckades att hämta resultat för draw ${drawNumber}.`);
}

function summarizeResultPayload(payload) {
  const result = payload?.result || null;
  const distribution = Array.isArray(result?.distribution) ? result.distribution : [];
  const winningTier =
    distribution.find((entry) => String(entry?.name || '').toLowerCase().includes('8')) || distribution[0] || null;

  return {
    available: Boolean(result),
    label: winningTier?.name || null,
    amount: parseDecimal(winningTier?.amount),
    winners: parseInteger(winningTier?.winners),
    distribution,
    turnover: parseDecimal(result?.turnover),
    rawResult: result,
  };
}

async function ensureSchema(db) {
  await db.query(SCHEMA_SQL);
}

async function loadTargetDraws(db) {
  if (CONFIG.targetDrawNumbers.length) {
    return CONFIG.targetDrawNumbers;
  }

  const result = await db.query(
    `
      SELECT draw_number
      FROM tipsxtra_topptipset_draws
      WHERE $1::boolean
         OR NOT svenska_spel_result_available
         OR svenska_spel_result_amount IS NULL
      ORDER BY draw_number ASC
    `,
    [CONFIG.forceRefresh]
  );

  return result.rows.map((row) => Number(row.draw_number));
}

async function updateDrawResult(db, drawNumber, payload, httpStatus) {
  const summary = summarizeResultPayload(payload);

  await db.query(
    `
      UPDATE tipsxtra_topptipset_draws
      SET
        svenska_spel_result_available = $2,
        svenska_spel_result_label = $3,
        svenska_spel_result_amount = $4,
        svenska_spel_result_winners = $5,
        svenska_spel_result_distribution = $6::jsonb,
        svenska_spel_result_turnover = $7,
        svenska_spel_raw_result = $8::jsonb,
        svenska_spel_imported_at = NOW()
      WHERE draw_number = $1
    `,
    [
      drawNumber,
      summary.available && httpStatus === 200,
      summary.label,
      summary.amount,
      summary.winners,
      JSON.stringify(summary.distribution),
      summary.turnover,
      JSON.stringify(summary.rawResult),
    ]
  );

  return summary;
}

async function runWorker(db, drawNumbers, sharedState) {
  while (true) {
    const index = sharedState.nextIndex;
    if (index >= drawNumbers.length) {
      return;
    }

    sharedState.nextIndex += 1;
    const drawNumber = drawNumbers[index];

    try {
      const response = await fetchWithRetry(drawNumber);
      const summary = await updateDrawResult(db, drawNumber, response.data, response.status);
      sharedState.processed += 1;
      if (summary.available && summary.amount != null) {
        sharedState.withAmount += 1;
      } else if (summary.available) {
        sharedState.withoutAmount += 1;
      } else {
        sharedState.unavailable += 1;
      }

      if (sharedState.processed % 100 === 0 || sharedState.processed === drawNumbers.length) {
        console.log(
          `Processed ${sharedState.processed}/${drawNumbers.length} draws ` +
            `(with payout ${sharedState.withAmount}, no payout ${sharedState.withoutAmount}, unavailable ${sharedState.unavailable})`
        );
      }
    } catch (error) {
      sharedState.processed += 1;
      sharedState.failed += 1;
      console.warn(`Draw ${drawNumber} failed: ${error.message}`);
    }
  }
}

async function loadSummary(db) {
  const result = await db.query(`
    SELECT
      COUNT(*) AS draw_count,
      COUNT(*) FILTER (WHERE svenska_spel_result_available) AS result_available_count,
      COUNT(*) FILTER (WHERE svenska_spel_result_amount IS NOT NULL) AS payout_amount_count,
      COUNT(*) FILTER (
        WHERE complete_backtest
          AND svenska_spel_result_available
          AND svenska_spel_result_amount IS NOT NULL
      ) AS complete_real_backtest_draw_count,
      MIN(draw_number) FILTER (WHERE svenska_spel_result_amount IS NOT NULL) AS oldest_payout_draw,
      MAX(draw_number) FILTER (WHERE svenska_spel_result_amount IS NOT NULL) AS newest_payout_draw
    FROM tipsxtra_topptipset_draws
  `);

  return result.rows[0];
}

async function main() {
  const pool = new Pool({
    connectionString: normalizeDatabaseUrl(CONFIG.databaseUrl),
  });

  try {
    await ensureSchema(pool);
    const drawNumbers = await loadTargetDraws(pool);

    if (!drawNumbers.length) {
      console.log('No Topptipset draws need payout backfill.');
      const summary = await loadSummary(pool);
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    console.log(`Backfilling Svenska Spel result distribution for ${drawNumbers.length} Topptipset draws...`);

    const sharedState = {
      nextIndex: 0,
      processed: 0,
      withAmount: 0,
      withoutAmount: 0,
      unavailable: 0,
      failed: 0,
    };

    const workers = Array.from({ length: Math.min(CONFIG.concurrency, drawNumbers.length) }, () =>
      runWorker(pool, drawNumbers, sharedState)
    );

    await Promise.all(workers);

    const summary = await loadSummary(pool);
    console.log('Backfill complete.');
    console.log(JSON.stringify({ ...summary, failed_count: sharedState.failed }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
