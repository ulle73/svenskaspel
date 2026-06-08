require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Pool } = require('pg');

const { normalizeDatabaseUrl, parseNumberList } = require('./lib/rapidapi-topptipset');

const CONFIG = {
  product: 'topptipset',
  csvProductName: 'Topptipset',
  databaseUrl: process.env.DATABASE_URL,
  csvPath: path.resolve(process.cwd(), process.env.TIPSXTRA_TOPPTIPSET_CSV_PATH || 'TipsXtra_Topptipset_Statistik_Detaljer.csv'),
  latestDrawCount: Number(process.env.TOPPTIPSET_LATEST_DRAW_COUNT || 500),
  targetDrawNumbers: [...new Set(parseNumberList(process.env.TOPPTIPSET_DRAW_NUMBERS || ''))].sort((left, right) => left - right),
  batchSize: Number(process.env.TIPSXTRA_IMPORT_BATCH_SIZE || 500),
};

const TIPSXTRA_SCHEMA_SQL = `
ALTER TABLE pool_events
  ADD COLUMN IF NOT EXISTS tipsxtra_available BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS tipsxtra_match_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tipsxtra_outcome TEXT,
  ADD COLUMN IF NOT EXISTS tipsxtra_match_status TEXT,
  ADD COLUMN IF NOT EXISTS tipsxtra_expert_tip TEXT,
  ADD COLUMN IF NOT EXISTS tipsxtra_odds_home NUMERIC,
  ADD COLUMN IF NOT EXISTS tipsxtra_odds_draw NUMERIC,
  ADD COLUMN IF NOT EXISTS tipsxtra_odds_away NUMERIC,
  ADD COLUMN IF NOT EXISTS tipsxtra_odds_pct_home INTEGER,
  ADD COLUMN IF NOT EXISTS tipsxtra_odds_pct_draw INTEGER,
  ADD COLUMN IF NOT EXISTS tipsxtra_odds_pct_away INTEGER,
  ADD COLUMN IF NOT EXISTS tipsxtra_public_odds_home NUMERIC,
  ADD COLUMN IF NOT EXISTS tipsxtra_public_odds_draw NUMERIC,
  ADD COLUMN IF NOT EXISTS tipsxtra_public_odds_away NUMERIC,
  ADD COLUMN IF NOT EXISTS tipsxtra_public_pct_home INTEGER,
  ADD COLUMN IF NOT EXISTS tipsxtra_public_pct_draw INTEGER,
  ADD COLUMN IF NOT EXISTS tipsxtra_public_pct_away INTEGER,
  ADD COLUMN IF NOT EXISTS tipsxtra_svspelinfo_id BIGINT,
  ADD COLUMN IF NOT EXISTS tipsxtra_raw_row JSONB,
  ADD COLUMN IF NOT EXISTS tipsxtra_imported_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pool_events_tipsxtra_available
  ON pool_events (product, tipsxtra_available, draw_number DESC);

CREATE OR REPLACE VIEW topptipset_latest_500_historical_odds AS
SELECT
  d.draw_number,
  d.close_time,
  e.event_number,
  e.description,
  e.home_participant_name,
  e.away_participant_name,
  e.sport_event_start,
  e.result_outcome,
  e.result_outcome_score,
  e.tipsxtra_available,
  e.tipsxtra_match_start,
  e.tipsxtra_outcome,
  e.tipsxtra_match_status,
  e.tipsxtra_expert_tip,
  e.tipsxtra_odds_home,
  e.tipsxtra_odds_draw,
  e.tipsxtra_odds_away,
  e.tipsxtra_public_odds_home,
  e.tipsxtra_public_odds_draw,
  e.tipsxtra_public_odds_away,
  e.rapidapi_mapping_status,
  e.rapidapi_event_id,
  e.rapidapi_provider_id,
  e.rapidapi_has_odds,
  e.rapidapi_odds_open_home,
  e.rapidapi_odds_open_draw,
  e.rapidapi_odds_open_away,
  e.rapidapi_odds_close_home,
  e.rapidapi_odds_close_draw,
  e.rapidapi_odds_close_away,
  e.odds_available,
  e.odds_home,
  e.odds_draw,
  e.odds_away,
  CASE
    WHEN e.tipsxtra_available
      AND e.tipsxtra_odds_home IS NOT NULL
      AND e.tipsxtra_odds_draw IS NOT NULL
      AND e.tipsxtra_odds_away IS NOT NULL
      THEN 'tipsxtra'
    WHEN e.rapidapi_has_odds
      AND e.rapidapi_odds_close_home IS NOT NULL
      AND e.rapidapi_odds_close_draw IS NOT NULL
      AND e.rapidapi_odds_close_away IS NOT NULL
      THEN 'rapidapi_close'
    WHEN e.rapidapi_has_odds
      AND e.rapidapi_odds_open_home IS NOT NULL
      AND e.rapidapi_odds_open_draw IS NOT NULL
      AND e.rapidapi_odds_open_away IS NOT NULL
      THEN 'rapidapi_open'
    WHEN e.odds_available
      AND e.odds_home IS NOT NULL
      AND e.odds_draw IS NOT NULL
      AND e.odds_away IS NOT NULL
      THEN 'svenskaspel_api'
    ELSE NULL
  END AS historical_odds_source,
  COALESCE(
    CASE
      WHEN e.tipsxtra_available
        AND e.tipsxtra_odds_home IS NOT NULL
        AND e.tipsxtra_odds_draw IS NOT NULL
        AND e.tipsxtra_odds_away IS NOT NULL
        THEN e.tipsxtra_odds_home
    END,
    CASE
      WHEN e.rapidapi_has_odds
        AND e.rapidapi_odds_close_home IS NOT NULL
        AND e.rapidapi_odds_close_draw IS NOT NULL
        AND e.rapidapi_odds_close_away IS NOT NULL
        THEN e.rapidapi_odds_close_home
    END,
    CASE
      WHEN e.rapidapi_has_odds
        AND e.rapidapi_odds_open_home IS NOT NULL
        AND e.rapidapi_odds_open_draw IS NOT NULL
        AND e.rapidapi_odds_open_away IS NOT NULL
        THEN e.rapidapi_odds_open_home
    END,
    CASE
      WHEN e.odds_available
        AND e.odds_home IS NOT NULL
        AND e.odds_draw IS NOT NULL
        AND e.odds_away IS NOT NULL
        THEN e.odds_home
    END
  ) AS historical_odds_home,
  COALESCE(
    CASE
      WHEN e.tipsxtra_available
        AND e.tipsxtra_odds_home IS NOT NULL
        AND e.tipsxtra_odds_draw IS NOT NULL
        AND e.tipsxtra_odds_away IS NOT NULL
        THEN e.tipsxtra_odds_draw
    END,
    CASE
      WHEN e.rapidapi_has_odds
        AND e.rapidapi_odds_close_home IS NOT NULL
        AND e.rapidapi_odds_close_draw IS NOT NULL
        AND e.rapidapi_odds_close_away IS NOT NULL
        THEN e.rapidapi_odds_close_draw
    END,
    CASE
      WHEN e.rapidapi_has_odds
        AND e.rapidapi_odds_open_home IS NOT NULL
        AND e.rapidapi_odds_open_draw IS NOT NULL
        AND e.rapidapi_odds_open_away IS NOT NULL
        THEN e.rapidapi_odds_open_draw
    END,
    CASE
      WHEN e.odds_available
        AND e.odds_home IS NOT NULL
        AND e.odds_draw IS NOT NULL
        AND e.odds_away IS NOT NULL
        THEN e.odds_draw
    END
  ) AS historical_odds_draw,
  COALESCE(
    CASE
      WHEN e.tipsxtra_available
        AND e.tipsxtra_odds_home IS NOT NULL
        AND e.tipsxtra_odds_draw IS NOT NULL
        AND e.tipsxtra_odds_away IS NOT NULL
        THEN e.tipsxtra_odds_away
    END,
    CASE
      WHEN e.rapidapi_has_odds
        AND e.rapidapi_odds_close_home IS NOT NULL
        AND e.rapidapi_odds_close_draw IS NOT NULL
        AND e.rapidapi_odds_close_away IS NOT NULL
        THEN e.rapidapi_odds_close_away
    END,
    CASE
      WHEN e.rapidapi_has_odds
        AND e.rapidapi_odds_open_home IS NOT NULL
        AND e.rapidapi_odds_open_draw IS NOT NULL
        AND e.rapidapi_odds_open_away IS NOT NULL
        THEN e.rapidapi_odds_open_away
    END,
    CASE
      WHEN e.odds_available
        AND e.odds_home IS NOT NULL
        AND e.odds_draw IS NOT NULL
        AND e.odds_away IS NOT NULL
        THEN e.odds_away
    END
  ) AS historical_odds_away
FROM pool_events e
JOIN pool_draws d
  ON d.product = e.product
 AND d.draw_number = e.draw_number
WHERE e.product = 'topptipset'
  AND e.draw_number >= COALESCE((
    SELECT MAX(draw_number) - 499
    FROM pool_draws
    WHERE product = 'topptipset'
  ), 0)
ORDER BY e.draw_number DESC, e.event_number ASC;

CREATE OR REPLACE VIEW topptipset_latest_500_historical_draw_summary AS
SELECT
  draw_number,
  close_time,
  COUNT(*) AS event_count,
  COUNT(*) FILTER (
    WHERE tipsxtra_available
      AND tipsxtra_odds_home IS NOT NULL
      AND tipsxtra_odds_draw IS NOT NULL
      AND tipsxtra_odds_away IS NOT NULL
  ) AS events_with_tipsxtra_odds,
  COUNT(*) FILTER (WHERE historical_odds_source IS NOT NULL) AS events_with_historical_odds,
  COUNT(*) FILTER (WHERE historical_odds_source = 'tipsxtra') AS events_using_tipsxtra_odds,
  COUNT(*) FILTER (WHERE historical_odds_source LIKE 'rapidapi%') AS events_using_rapidapi_odds,
  COUNT(*) FILTER (WHERE historical_odds_source = 'svenskaspel_api') AS events_using_svenskaspel_api_odds
FROM topptipset_latest_500_historical_odds
GROUP BY draw_number, close_time
ORDER BY draw_number DESC;
`;

if (!CONFIG.databaseUrl) {
  console.error('FATAL: DATABASE_URL saknas i .env');
  process.exit(1);
}

if (!fs.existsSync(CONFIG.csvPath)) {
  console.error(`FATAL: TipsXtra CSV saknas: ${CONFIG.csvPath}`);
  process.exit(1);
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

function parseBooleanFlag(value) {
  if (value == null || value === '') {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'ja') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'nej') {
    return false;
  }
  return null;
}

function parseLocalDateTime(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return null;
  }

  const isoCandidate = normalized.replace(' ', 'T');
  const parsed = new Date(isoCandidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"') {
      const nextCharacter = line[index + 1];
      if (inQuotes && nextCharacter === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (character === ';' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += character;
  }

  values.push(current);
  return values;
}

function normalizeHeader(value) {
  return String(value || '').replace(/^\uFEFF/, '').trim();
}

function rowToObject(headers, values) {
  const row = {};
  for (let index = 0; index < headers.length; index += 1) {
    row[headers[index]] = values[index] ?? '';
  }
  return row;
}

function normalizeStageRow(row) {
  return {
    drawNumber: parseInteger(row.omgang),
    eventNumber: parseInteger(row.matchnummer),
    matchStart: parseLocalDateTime(row.matchstart),
    outcome: String(row.utfall || '').trim() || null,
    matchStatus: String(row.matchstatus || '').trim() || null,
    expertTip: String(row.experttips || '').trim() || null,
    oddsHome: parseDecimal(row.oddset1),
    oddsDraw: parseDecimal(row.oddsetx),
    oddsAway: parseDecimal(row.oddset2),
    oddsPctHome: parseInteger(row.oddset_procent1),
    oddsPctDraw: parseInteger(row.oddset_procentx),
    oddsPctAway: parseInteger(row.oddset_procent2),
    publicOddsHome: parseDecimal(row.svenska_folket_odds1),
    publicOddsDraw: parseDecimal(row.svenska_folket_oddsx),
    publicOddsAway: parseDecimal(row.svenska_folket_odds2),
    publicPctHome: parseInteger(row.svenska_folket1),
    publicPctDraw: parseInteger(row.svenska_folketx),
    publicPctAway: parseInteger(row.svenska_folket2),
    svspelinfoId: parseInteger(row.svspelinfo_id),
    rawRow: row,
  };
}

async function ensureSchema(client) {
  await client.query(TIPSXTRA_SCHEMA_SQL);
}

async function loadTargetDrawNumbers(client) {
  if (CONFIG.targetDrawNumbers.length) {
    return CONFIG.targetDrawNumbers;
  }

  const result = await client.query(
    `
      SELECT draw_number
      FROM pool_draws
      WHERE product = $1
        AND draw_number >= COALESCE((
          SELECT MAX(draw_number) - ($2 - 1)
          FROM pool_draws
          WHERE product = $1
        ), 0)
      ORDER BY draw_number ASC
    `,
    [CONFIG.product, CONFIG.latestDrawCount]
  );

  return result.rows.map((row) => Number(row.draw_number));
}

async function readCsvRows(targetDrawSet) {
  const rows = [];
  const seenDraws = new Set();
  const input = fs.createReadStream(CONFIG.csvPath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input,
    crlfDelay: Infinity,
  });

  let headers = null;

  for await (const line of rl) {
    if (!headers) {
      headers = parseCsvLine(line).map(normalizeHeader);
      continue;
    }

    if (!line.trim()) {
      continue;
    }

    const values = parseCsvLine(line);
    const row = rowToObject(headers, values);

    if (row.produktnamn !== CONFIG.csvProductName) {
      continue;
    }

    const drawNumber = parseInteger(row.omgang);
    if (!targetDrawSet.has(drawNumber)) {
      continue;
    }

    seenDraws.add(drawNumber);
    rows.push(normalizeStageRow(row));
  }

  return {
    rows,
    seenDraws,
  };
}

async function createStageTable(client) {
  await client.query(`
    CREATE TEMP TABLE tipsxtra_import_stage (
      draw_number INTEGER NOT NULL,
      event_number INTEGER NOT NULL,
      match_start TIMESTAMPTZ,
      outcome TEXT,
      match_status TEXT,
      expert_tip TEXT,
      odds_home NUMERIC,
      odds_draw NUMERIC,
      odds_away NUMERIC,
      odds_pct_home INTEGER,
      odds_pct_draw INTEGER,
      odds_pct_away INTEGER,
      public_odds_home NUMERIC,
      public_odds_draw NUMERIC,
      public_odds_away NUMERIC,
      public_pct_home INTEGER,
      public_pct_draw INTEGER,
      public_pct_away INTEGER,
      svspelinfo_id BIGINT,
      raw_row JSONB,
      PRIMARY KEY (draw_number, event_number)
    ) ON COMMIT DROP
  `);
}

async function insertStageRows(client, rows) {
  for (let offset = 0; offset < rows.length; offset += CONFIG.batchSize) {
    const batch = rows.slice(offset, offset + CONFIG.batchSize);
    const values = [];
    const placeholders = batch.map((row, index) => {
      const base = index * 20;
      values.push(
        row.drawNumber,
        row.eventNumber,
        row.matchStart,
        row.outcome,
        row.matchStatus,
        row.expertTip,
        row.oddsHome,
        row.oddsDraw,
        row.oddsAway,
        row.oddsPctHome,
        row.oddsPctDraw,
        row.oddsPctAway,
        row.publicOddsHome,
        row.publicOddsDraw,
        row.publicOddsAway,
        row.publicPctHome,
        row.publicPctDraw,
        row.publicPctAway,
        row.svspelinfoId,
        JSON.stringify(row.rawRow)
      );
      return `(
        $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5},
        $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10},
        $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15},
        $${base + 16}, $${base + 17}, $${base + 18}, $${base + 19}, $${base + 20}::jsonb
      )`;
    });

    await client.query(
      `
        INSERT INTO tipsxtra_import_stage (
          draw_number,
          event_number,
          match_start,
          outcome,
          match_status,
          expert_tip,
          odds_home,
          odds_draw,
          odds_away,
          odds_pct_home,
          odds_pct_draw,
          odds_pct_away,
          public_odds_home,
          public_odds_draw,
          public_odds_away,
          public_pct_home,
          public_pct_draw,
          public_pct_away,
          svspelinfo_id,
          raw_row
        )
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (draw_number, event_number)
        DO UPDATE SET
          match_start = EXCLUDED.match_start,
          outcome = EXCLUDED.outcome,
          match_status = EXCLUDED.match_status,
          expert_tip = EXCLUDED.expert_tip,
          odds_home = EXCLUDED.odds_home,
          odds_draw = EXCLUDED.odds_draw,
          odds_away = EXCLUDED.odds_away,
          odds_pct_home = EXCLUDED.odds_pct_home,
          odds_pct_draw = EXCLUDED.odds_pct_draw,
          odds_pct_away = EXCLUDED.odds_pct_away,
          public_odds_home = EXCLUDED.public_odds_home,
          public_odds_draw = EXCLUDED.public_odds_draw,
          public_odds_away = EXCLUDED.public_odds_away,
          public_pct_home = EXCLUDED.public_pct_home,
          public_pct_draw = EXCLUDED.public_pct_draw,
          public_pct_away = EXCLUDED.public_pct_away,
          svspelinfo_id = EXCLUDED.svspelinfo_id,
          raw_row = EXCLUDED.raw_row
      `,
      values
    );
  }
}

async function resetTargetDraws(client, targetDrawNumbers) {
  await client.query(
    `
      UPDATE pool_events
      SET
        tipsxtra_available = FALSE,
        tipsxtra_match_start = NULL,
        tipsxtra_outcome = NULL,
        tipsxtra_match_status = NULL,
        tipsxtra_expert_tip = NULL,
        tipsxtra_odds_home = NULL,
        tipsxtra_odds_draw = NULL,
        tipsxtra_odds_away = NULL,
        tipsxtra_odds_pct_home = NULL,
        tipsxtra_odds_pct_draw = NULL,
        tipsxtra_odds_pct_away = NULL,
        tipsxtra_public_odds_home = NULL,
        tipsxtra_public_odds_draw = NULL,
        tipsxtra_public_odds_away = NULL,
        tipsxtra_public_pct_home = NULL,
        tipsxtra_public_pct_draw = NULL,
        tipsxtra_public_pct_away = NULL,
        tipsxtra_svspelinfo_id = NULL,
        tipsxtra_raw_row = NULL,
        tipsxtra_imported_at = NULL
      WHERE product = $1
        AND draw_number = ANY($2::int[])
    `,
    [CONFIG.product, targetDrawNumbers]
  );
}

async function applyStageRows(client) {
  const result = await client.query(
    `
      WITH updated AS (
        UPDATE pool_events e
        SET
          tipsxtra_available = TRUE,
          tipsxtra_match_start = s.match_start,
          tipsxtra_outcome = s.outcome,
          tipsxtra_match_status = s.match_status,
          tipsxtra_expert_tip = s.expert_tip,
          tipsxtra_odds_home = s.odds_home,
          tipsxtra_odds_draw = s.odds_draw,
          tipsxtra_odds_away = s.odds_away,
          tipsxtra_odds_pct_home = s.odds_pct_home,
          tipsxtra_odds_pct_draw = s.odds_pct_draw,
          tipsxtra_odds_pct_away = s.odds_pct_away,
          tipsxtra_public_odds_home = s.public_odds_home,
          tipsxtra_public_odds_draw = s.public_odds_draw,
          tipsxtra_public_odds_away = s.public_odds_away,
          tipsxtra_public_pct_home = s.public_pct_home,
          tipsxtra_public_pct_draw = s.public_pct_draw,
          tipsxtra_public_pct_away = s.public_pct_away,
          tipsxtra_svspelinfo_id = s.svspelinfo_id,
          tipsxtra_raw_row = s.raw_row,
          tipsxtra_imported_at = NOW()
        FROM tipsxtra_import_stage s
        WHERE e.product = $1
          AND e.draw_number = s.draw_number
          AND e.event_number = s.event_number
        RETURNING e.draw_number, e.event_number
      )
      SELECT COUNT(*) AS updated_count
      FROM updated
    `,
    [CONFIG.product]
  );

  return Number(result.rows[0]?.updated_count || 0);
}

async function collectVerification(client) {
  const result = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM topptipset_latest_500_historical_odds WHERE tipsxtra_available) AS latest_500_events_with_tipsxtra_rows,
      (SELECT COUNT(*) FROM topptipset_latest_500_historical_odds WHERE historical_odds_source = 'tipsxtra') AS latest_500_events_using_tipsxtra_odds,
      (SELECT COUNT(*) FROM topptipset_latest_500_historical_odds WHERE historical_odds_source LIKE 'rapidapi%') AS latest_500_events_using_rapidapi_odds,
      (SELECT COUNT(*) FROM topptipset_latest_500_historical_odds WHERE historical_odds_source IS NOT NULL) AS latest_500_events_with_historical_odds,
      (SELECT COUNT(*) FROM topptipset_latest_500_historical_draw_summary WHERE events_with_historical_odds > 0) AS latest_500_draws_with_any_historical_odds,
      (SELECT COUNT(*) FROM topptipset_latest_500_historical_draw_summary WHERE events_with_tipsxtra_odds > 0) AS latest_500_draws_with_any_tipsxtra_odds
  `);

  return result.rows[0];
}

async function main() {
  const pool = new Pool({
    connectionString: normalizeDatabaseUrl(CONFIG.databaseUrl),
  });

  try {
    const client = await pool.connect();
    let targetDrawNumbers;

    try {
      await client.query('BEGIN');
      await ensureSchema(client);
      targetDrawNumbers = await loadTargetDrawNumbers(client);

      if (!targetDrawNumbers.length) {
        throw new Error('Hittade inga Topptipset-draws i Neon att uppdatera med TipsXtra CSV.');
      }

      const targetDrawSet = new Set(targetDrawNumbers);
      const { rows, seenDraws } = await readCsvRows(targetDrawSet);
      const missingDrawNumbers = targetDrawNumbers.filter((drawNumber) => !seenDraws.has(drawNumber));

      await createStageTable(client);
      await insertStageRows(client, rows);
      await resetTargetDraws(client, targetDrawNumbers);
      const updatedCount = await applyStageRows(client);
      const verification = await collectVerification(client);

      await client.query('COMMIT');

      console.log(
        JSON.stringify(
          {
            ok: true,
            csvPath: CONFIG.csvPath,
            targetDrawNumbers,
            stageRowCount: rows.length,
            updatedCount,
            missingDrawNumbers,
            verification,
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
