require('dotenv').config();

const fs = require('fs');
const https = require('https');
const path = require('path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

const ENDPOINT_TYPES = ['draw', 'forecast', 'result'];
const CONFIG = {
  apiKey: process.env.SVENSKA_SPEL_API_NYCKEL,
  databaseUrl: process.env.DATABASE_URL,
  product: 'topptipset',
  baseUrl: 'https://api.www.svenskaspel.se/external/1/draw',
  latestDrawCount: Number(process.env.TOPPTIPSET_LATEST_DRAW_COUNT || 500),
  liveRefreshCount: Number(process.env.TOPPTIPSET_LIVE_REFRESH_COUNT || 30),
  sqlitePath: path.resolve(process.cwd(), process.env.SQLITE_SOURCE_PATH || 'raw_data.db'),
  requestDelayMs: Number(process.env.REQUEST_DELAY_MS || 150),
  maxRetries: Number(process.env.MAX_RETRIES || 3),
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS raw_responses (
  product TEXT NOT NULL,
  draw_number INTEGER NOT NULL,
  endpoint_type TEXT NOT NULL CHECK (endpoint_type IN ('draw', 'forecast', 'result')),
  fetched_at TIMESTAMPTZ NOT NULL,
  http_status INTEGER NOT NULL,
  success BOOLEAN NOT NULL,
  error_text TEXT,
  raw_response TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (product, draw_number, endpoint_type)
);

CREATE TABLE IF NOT EXISTS pool_draws (
  product TEXT NOT NULL,
  draw_number INTEGER NOT NULL,
  product_name TEXT,
  product_id INTEGER,
  draw_state TEXT,
  draw_comment TEXT,
  extra_info JSONB,
  fund JSONB,
  jackpot_items JSONB,
  last_date_without_time_of_day DATE,
  open_time TIMESTAMPTZ,
  close_time TIMESTAMPTZ,
  turnover NUMERIC,
  sport TEXT,
  sport_id INTEGER,
  checksum TEXT,
  draw_available BOOLEAN NOT NULL DEFAULT FALSE,
  forecast_available BOOLEAN NOT NULL DEFAULT FALSE,
  result_available BOOLEAN NOT NULL DEFAULT FALSE,
  forecast_distribution JSONB,
  result_distribution JSONB,
  raw_draw JSONB,
  raw_forecast JSONB,
  raw_result JSONB,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (product, draw_number)
);

CREATE TABLE IF NOT EXISTS pool_events (
  product TEXT NOT NULL,
  draw_number INTEGER NOT NULL,
  event_number INTEGER NOT NULL,
  description TEXT,
  cancelled BOOLEAN,
  result_cancelled BOOLEAN,
  event_comment TEXT,
  participant_type TEXT,
  home_participant_name TEXT,
  away_participant_name TEXT,
  league_name TEXT,
  country_name TEXT,
  sport_event_id BIGINT,
  sport_event_start TIMESTAMPTZ,
  sport_event_status TEXT,
  odds_available BOOLEAN NOT NULL DEFAULT FALSE,
  odds_home NUMERIC,
  odds_draw NUMERIC,
  odds_away NUMERIC,
  start_odds_home NUMERIC,
  start_odds_draw NUMERIC,
  start_odds_away NUMERIC,
  favourite_pct_home INTEGER,
  favourite_pct_draw INTEGER,
  favourite_pct_away INTEGER,
  distribution_home INTEGER,
  distribution_draw INTEGER,
  distribution_away INTEGER,
  distribution_ref_home INTEGER,
  distribution_ref_draw INTEGER,
  distribution_ref_away INTEGER,
  distribution_date TIMESTAMPTZ,
  distribution_ref_date TIMESTAMPTZ,
  forecast_outcome TEXT,
  forecast_outcome_score TEXT,
  forecast_is_finished BOOLEAN,
  result_outcome TEXT,
  result_outcome_score TEXT,
  provider_ids JSONB,
  raw_draw_event JSONB,
  raw_forecast_event JSONB,
  raw_result_event JSONB,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (product, draw_number, event_number),
  FOREIGN KEY (product, draw_number) REFERENCES pool_draws(product, draw_number) ON DELETE CASCADE
);

ALTER TABLE pool_events
  ADD COLUMN IF NOT EXISTS rapidapi_mapping_status TEXT,
  ADD COLUMN IF NOT EXISTS rapidapi_event_id BIGINT,
  ADD COLUMN IF NOT EXISTS rapidapi_event_slug TEXT,
  ADD COLUMN IF NOT EXISTS rapidapi_event_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rapidapi_tournament_name TEXT,
  ADD COLUMN IF NOT EXISTS rapidapi_unique_tournament_id INTEGER,
  ADD COLUMN IF NOT EXISTS rapidapi_home_team_id BIGINT,
  ADD COLUMN IF NOT EXISTS rapidapi_away_team_id BIGINT,
  ADD COLUMN IF NOT EXISTS rapidapi_mapping_score NUMERIC,
  ADD COLUMN IF NOT EXISTS rapidapi_mapping_minutes_diff NUMERIC,
  ADD COLUMN IF NOT EXISTS rapidapi_is_swapped BOOLEAN,
  ADD COLUMN IF NOT EXISTS rapidapi_provider_id INTEGER,
  ADD COLUMN IF NOT EXISTS rapidapi_has_odds BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS rapidapi_odds_open_home NUMERIC,
  ADD COLUMN IF NOT EXISTS rapidapi_odds_open_draw NUMERIC,
  ADD COLUMN IF NOT EXISTS rapidapi_odds_open_away NUMERIC,
  ADD COLUMN IF NOT EXISTS rapidapi_odds_close_home NUMERIC,
  ADD COLUMN IF NOT EXISTS rapidapi_odds_close_draw NUMERIC,
  ADD COLUMN IF NOT EXISTS rapidapi_odds_close_away NUMERIC,
  ADD COLUMN IF NOT EXISTS rapidapi_winner TEXT,
  ADD COLUMN IF NOT EXISTS rapidapi_raw_event JSONB,
  ADD COLUMN IF NOT EXISTS rapidapi_raw_market JSONB,
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
  ADD COLUMN IF NOT EXISTS tipsxtra_imported_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rapidapi_mapped_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_raw_responses_product_draw ON raw_responses (product, draw_number DESC, endpoint_type);
CREATE INDEX IF NOT EXISTS idx_pool_draws_product_close_time ON pool_draws (product, close_time DESC);
CREATE INDEX IF NOT EXISTS idx_pool_events_product_draw ON pool_events (product, draw_number DESC, event_number);
CREATE INDEX IF NOT EXISTS idx_pool_events_odds_available ON pool_events (product, odds_available, draw_number DESC);
CREATE INDEX IF NOT EXISTS idx_pool_events_rapidapi_event_id ON pool_events (product, rapidapi_event_id);
CREATE INDEX IF NOT EXISTS idx_pool_events_rapidapi_provider ON pool_events (product, rapidapi_provider_id, draw_number DESC);
CREATE INDEX IF NOT EXISTS idx_pool_events_tipsxtra_available ON pool_events (product, tipsxtra_available, draw_number DESC);

CREATE OR REPLACE VIEW topptipset_latest_500_events AS
SELECT
  d.draw_number,
  d.close_time,
  d.turnover,
  d.result_available,
  e.event_number,
  e.description,
  e.home_participant_name,
  e.away_participant_name,
  e.sport_event_start,
  e.sport_event_status,
  e.odds_available,
  e.odds_home,
  e.odds_draw,
  e.odds_away,
  e.start_odds_home,
  e.start_odds_draw,
  e.start_odds_away,
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
  e.rapidapi_winner,
  e.distribution_home,
  e.distribution_draw,
  e.distribution_away,
  e.distribution_ref_home,
  e.distribution_ref_draw,
  e.distribution_ref_away,
  e.distribution_date,
  e.distribution_ref_date,
  e.forecast_outcome,
  e.forecast_outcome_score,
  e.result_outcome,
  e.result_outcome_score
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

CREATE OR REPLACE VIEW topptipset_latest_500_draw_summary AS
SELECT
  d.draw_number,
  d.close_time,
  d.turnover,
  d.draw_available,
  d.forecast_available,
  d.result_available,
  COUNT(e.*) AS event_count,
  COUNT(*) FILTER (WHERE e.odds_available) AS events_with_odds,
  COUNT(*) FILTER (WHERE e.rapidapi_has_odds) AS events_with_rapidapi_odds
FROM pool_draws d
LEFT JOIN pool_events e
  ON e.product = d.product
 AND e.draw_number = d.draw_number
WHERE d.product = 'topptipset'
  AND d.draw_number >= COALESCE((
    SELECT MAX(draw_number) - 499
    FROM pool_draws
    WHERE product = 'topptipset'
  ), 0)
GROUP BY
  d.draw_number,
  d.close_time,
  d.turnover,
  d.draw_available,
  d.forecast_available,
  d.result_available
ORDER BY d.draw_number DESC;

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

if (!CONFIG.apiKey) {
  console.error('FATAL: SVENSKA_SPEL_API_NYCKEL saknas i .env');
  process.exit(1);
}

if (!CONFIG.databaseUrl) {
  console.error('FATAL: DATABASE_URL saknas i .env');
  process.exit(1);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function responseKey(drawNumber, endpointType) {
  return `${drawNumber}:${endpointType}`;
}

function parseJson(rawValue) {
  if (!rawValue) {
    return null;
  }

  try {
    return JSON.parse(rawValue);
  } catch (error) {
    return null;
  }
}

function toJson(value) {
  return value == null ? null : JSON.stringify(value);
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

function parseDate(value) {
  return value || null;
}

function normalizeDatabaseUrl(databaseUrl) {
  const parsed = new URL(databaseUrl);
  if (parsed.searchParams.get('sslmode') === 'require') {
    parsed.searchParams.set('sslmode', 'verify-full');
  }
  return parsed.toString();
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          if (data) {
            try {
              parsed = JSON.parse(data);
            } catch (error) {
              parsed = data;
            }
          }
          resolve({ status: res.statusCode, data: parsed });
        });
      })
      .on('error', reject);
  });
}

async function fetchWithRetry(url, retries = CONFIG.maxRetries) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await fetchJson(url);
      if (result.status >= 500 || result.status === 429) {
        if (attempt === retries) {
          return result;
        }
        await delay(CONFIG.requestDelayMs * 5);
        continue;
      }
      return result;
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      await delay(CONFIG.requestDelayMs * 5);
    }
  }

  throw new Error('Max retries exceeded');
}

function buildEndpointUrl(product, drawNumber, endpointType) {
  let suffix = '';
  if (endpointType === 'forecast') {
    suffix = '/forecast';
  } else if (endpointType === 'result') {
    suffix = '/result';
  }

  return `${CONFIG.baseUrl}/${product}/draws/${drawNumber}${suffix}?accesskey=${CONFIG.apiKey}`;
}

async function getCurrentDrawNumber(product) {
  const url = `${CONFIG.baseUrl}/${product}/draws?accesskey=${CONFIG.apiKey}`;
  const result = await fetchWithRetry(url);
  const drawNumber = result.data?.draws?.[0]?.drawNumber;

  if (!drawNumber) {
    throw new Error(`Kunde inte läsa aktuellt drawNumber för ${product}`);
  }

  return drawNumber;
}

async function fetchRawResponse(product, drawNumber, endpointType) {
  await delay(CONFIG.requestDelayMs);

  const url = buildEndpointUrl(product, drawNumber, endpointType);
  const { status, data } = await fetchWithRetry(url);
  const success = status === 200;
  const errorPayload = success
    ? null
    : typeof data === 'object'
      ? JSON.stringify(data?.error || data)
      : String(data || '');

  return {
    product,
    drawNumber,
    endpointType,
    fetchedAt: new Date().toISOString(),
    httpStatus: status,
    success,
    errorText: errorPayload,
    rawResponse: data == null
      ? null
      : typeof data === 'string'
        ? data
        : JSON.stringify(data),
  };
}

function openSqliteDb() {
  if (!fs.existsSync(CONFIG.sqlitePath)) {
    return null;
  }

  return new Database(CONFIG.sqlitePath, { readonly: true });
}

function getSqliteRows(sqliteDb, product, minDrawNumber, maxDrawNumber) {
  const rows = sqliteDb.prepare(`
    SELECT
      product,
      drawNumber,
      endpointType,
      fetchedAt,
      httpStatus,
      success,
      error AS errorText,
      rawResponse
    FROM raw_responses
    WHERE product = ?
      AND drawNumber BETWEEN ? AND ?
    ORDER BY drawNumber DESC, endpointType ASC
  `).all(product, minDrawNumber, maxDrawNumber);

  return rows.map((row) => ({
    product: row.product,
    drawNumber: row.drawNumber,
    endpointType: row.endpointType,
    fetchedAt: row.fetchedAt,
    httpStatus: row.httpStatus,
    success: Boolean(row.success),
    errorText: row.errorText,
    rawResponse: row.rawResponse,
  }));
}

async function ensureSchema(client) {
  await client.query(SCHEMA_SQL);
}

async function upsertRawResponseBatch(client, rows) {
  if (!rows.length) {
    return;
  }

  const values = [];
  const placeholders = rows.map((row, index) => {
    const base = index * 8;
    values.push(
      row.product,
      row.drawNumber,
      row.endpointType,
      row.fetchedAt,
      row.httpStatus,
      row.success,
      row.errorText,
      row.rawResponse
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
  });

  await client.query(
    `
      INSERT INTO raw_responses (
        product,
        draw_number,
        endpoint_type,
        fetched_at,
        http_status,
        success,
        error_text,
        raw_response
      )
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (product, draw_number, endpoint_type)
      DO UPDATE SET
        fetched_at = EXCLUDED.fetched_at,
        http_status = EXCLUDED.http_status,
        success = EXCLUDED.success,
        error_text = EXCLUDED.error_text,
        raw_response = EXCLUDED.raw_response,
        updated_at = NOW()
    `,
    values
  );
}

function buildResponseMap(rows) {
  const map = new Map();
  for (const row of rows) {
    map.set(responseKey(row.drawNumber, row.endpointType), row);
  }
  return map;
}

function getParticipants(drawEvent) {
  const home = drawEvent?.participants?.find((participant) => participant.type === 'home') || null;
  const away = drawEvent?.participants?.find((participant) => participant.type === 'away') || null;
  return { home, away };
}

function indexEvents(events) {
  const map = new Map();
  for (const event of events || []) {
    map.set(event.eventNumber, event);
  }
  return map;
}

async function upsertDraw(client, drawData) {
  await client.query(
    `
      INSERT INTO pool_draws (
        product,
        draw_number,
        product_name,
        product_id,
        draw_state,
        draw_comment,
        extra_info,
        fund,
        jackpot_items,
        last_date_without_time_of_day,
        open_time,
        close_time,
        turnover,
        sport,
        sport_id,
        checksum,
        draw_available,
        forecast_available,
        result_available,
        forecast_distribution,
        result_distribution,
        raw_draw,
        raw_forecast,
        raw_result,
        imported_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21::jsonb,
        $22::jsonb, $23::jsonb, $24::jsonb, NOW()
      )
      ON CONFLICT (product, draw_number)
      DO UPDATE SET
        product_name = EXCLUDED.product_name,
        product_id = EXCLUDED.product_id,
        draw_state = EXCLUDED.draw_state,
        draw_comment = EXCLUDED.draw_comment,
        extra_info = EXCLUDED.extra_info,
        fund = EXCLUDED.fund,
        jackpot_items = EXCLUDED.jackpot_items,
        last_date_without_time_of_day = EXCLUDED.last_date_without_time_of_day,
        open_time = EXCLUDED.open_time,
        close_time = EXCLUDED.close_time,
        turnover = EXCLUDED.turnover,
        sport = EXCLUDED.sport,
        sport_id = EXCLUDED.sport_id,
        checksum = EXCLUDED.checksum,
        draw_available = EXCLUDED.draw_available,
        forecast_available = EXCLUDED.forecast_available,
        result_available = EXCLUDED.result_available,
        forecast_distribution = EXCLUDED.forecast_distribution,
        result_distribution = EXCLUDED.result_distribution,
        raw_draw = EXCLUDED.raw_draw,
        raw_forecast = EXCLUDED.raw_forecast,
        raw_result = EXCLUDED.raw_result,
        imported_at = NOW()
    `,
    [
      drawData.product,
      drawData.drawNumber,
      drawData.productName,
      drawData.productId,
      drawData.drawState,
      drawData.drawComment,
      toJson(drawData.extraInfo),
      toJson(drawData.fund),
      toJson(drawData.jackpotItems),
      drawData.lastDateWithoutTimeOfDay,
      drawData.openTime,
      drawData.closeTime,
      drawData.turnover,
      drawData.sport,
      drawData.sportId,
      drawData.checksum,
      drawData.drawAvailable,
      drawData.forecastAvailable,
      drawData.resultAvailable,
      toJson(drawData.forecastDistribution),
      toJson(drawData.resultDistribution),
      toJson(drawData.rawDraw),
      toJson(drawData.rawForecast),
      toJson(drawData.rawResult),
    ]
  );
}

async function upsertEvent(client, eventData) {
  await client.query(
    `
      INSERT INTO pool_events (
        product,
        draw_number,
        event_number,
        description,
        cancelled,
        result_cancelled,
        event_comment,
        participant_type,
        home_participant_name,
        away_participant_name,
        league_name,
        country_name,
        sport_event_id,
        sport_event_start,
        sport_event_status,
        odds_available,
        odds_home,
        odds_draw,
        odds_away,
        start_odds_home,
        start_odds_draw,
        start_odds_away,
        favourite_pct_home,
        favourite_pct_draw,
        favourite_pct_away,
        distribution_home,
        distribution_draw,
        distribution_away,
        distribution_ref_home,
        distribution_ref_draw,
        distribution_ref_away,
        distribution_date,
        distribution_ref_date,
        forecast_outcome,
        forecast_outcome_score,
        forecast_is_finished,
        result_outcome,
        result_outcome_score,
        provider_ids,
        raw_draw_event,
        raw_forecast_event,
        raw_result_event,
        imported_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29,
        $30, $31, $32, $33, $34, $35, $36, $37, $38, $39::jsonb, $40::jsonb,
        $41::jsonb, $42::jsonb, NOW()
      )
      ON CONFLICT (product, draw_number, event_number)
      DO UPDATE SET
        description = EXCLUDED.description,
        cancelled = EXCLUDED.cancelled,
        result_cancelled = EXCLUDED.result_cancelled,
        event_comment = EXCLUDED.event_comment,
        participant_type = EXCLUDED.participant_type,
        home_participant_name = EXCLUDED.home_participant_name,
        away_participant_name = EXCLUDED.away_participant_name,
        league_name = EXCLUDED.league_name,
        country_name = EXCLUDED.country_name,
        sport_event_id = EXCLUDED.sport_event_id,
        sport_event_start = EXCLUDED.sport_event_start,
        sport_event_status = EXCLUDED.sport_event_status,
        odds_available = EXCLUDED.odds_available,
        odds_home = EXCLUDED.odds_home,
        odds_draw = EXCLUDED.odds_draw,
        odds_away = EXCLUDED.odds_away,
        start_odds_home = EXCLUDED.start_odds_home,
        start_odds_draw = EXCLUDED.start_odds_draw,
        start_odds_away = EXCLUDED.start_odds_away,
        favourite_pct_home = EXCLUDED.favourite_pct_home,
        favourite_pct_draw = EXCLUDED.favourite_pct_draw,
        favourite_pct_away = EXCLUDED.favourite_pct_away,
        distribution_home = EXCLUDED.distribution_home,
        distribution_draw = EXCLUDED.distribution_draw,
        distribution_away = EXCLUDED.distribution_away,
        distribution_ref_home = EXCLUDED.distribution_ref_home,
        distribution_ref_draw = EXCLUDED.distribution_ref_draw,
        distribution_ref_away = EXCLUDED.distribution_ref_away,
        distribution_date = EXCLUDED.distribution_date,
        distribution_ref_date = EXCLUDED.distribution_ref_date,
        forecast_outcome = EXCLUDED.forecast_outcome,
        forecast_outcome_score = EXCLUDED.forecast_outcome_score,
        forecast_is_finished = EXCLUDED.forecast_is_finished,
        result_outcome = EXCLUDED.result_outcome,
        result_outcome_score = EXCLUDED.result_outcome_score,
        provider_ids = EXCLUDED.provider_ids,
        raw_draw_event = EXCLUDED.raw_draw_event,
        raw_forecast_event = EXCLUDED.raw_forecast_event,
        raw_result_event = EXCLUDED.raw_result_event,
        imported_at = NOW()
    `,
    [
      eventData.product,
      eventData.drawNumber,
      eventData.eventNumber,
      eventData.description,
      eventData.cancelled,
      eventData.resultCancelled,
      eventData.eventComment,
      eventData.participantType,
      eventData.homeParticipantName,
      eventData.awayParticipantName,
      eventData.leagueName,
      eventData.countryName,
      eventData.sportEventId,
      eventData.sportEventStart,
      eventData.sportEventStatus,
      eventData.oddsAvailable,
      eventData.oddsHome,
      eventData.oddsDraw,
      eventData.oddsAway,
      eventData.startOddsHome,
      eventData.startOddsDraw,
      eventData.startOddsAway,
      eventData.favouritePctHome,
      eventData.favouritePctDraw,
      eventData.favouritePctAway,
      eventData.distributionHome,
      eventData.distributionDraw,
      eventData.distributionAway,
      eventData.distributionRefHome,
      eventData.distributionRefDraw,
      eventData.distributionRefAway,
      eventData.distributionDate,
      eventData.distributionRefDate,
      eventData.forecastOutcome,
      eventData.forecastOutcomeScore,
      eventData.forecastIsFinished,
      eventData.resultOutcome,
      eventData.resultOutcomeScore,
      toJson(eventData.providerIds),
      toJson(eventData.rawDrawEvent),
      toJson(eventData.rawForecastEvent),
      toJson(eventData.rawResultEvent),
    ]
  );
}

async function normalizeDraws(client, responseMap, currentDraw) {
  const minDrawNumber = currentDraw - CONFIG.latestDrawCount + 1;

  for (let drawNumber = currentDraw; drawNumber >= minDrawNumber; drawNumber -= 1) {
    const drawPayload = parseJson(responseMap.get(responseKey(drawNumber, 'draw'))?.rawResponse);
    const forecastPayload = parseJson(responseMap.get(responseKey(drawNumber, 'forecast'))?.rawResponse);
    const resultPayload = parseJson(responseMap.get(responseKey(drawNumber, 'result'))?.rawResponse);

    const draw = drawPayload?.draw || null;
    const forecast = forecastPayload?.forecast || null;
    const result = resultPayload?.result || null;

    if (!draw && !forecast && !result) {
      continue;
    }

    await upsertDraw(client, {
      product: CONFIG.product,
      drawNumber,
      productName: draw?.productName || forecast?.productName || result?.productName || null,
      productId: draw?.productId || forecast?.productId || result?.productId || null,
      drawState: draw?.drawState || null,
      drawComment: draw?.drawComment || null,
      extraInfo: draw?.extraInfo || null,
      fund: draw?.fund || null,
      jackpotItems: draw?.jackpotItems || null,
      lastDateWithoutTimeOfDay: draw?.lastDateWithoutTimeOfDay || null,
      openTime: parseDate(draw?.openTime || forecast?.openTime || result?.openTime),
      closeTime: parseDate(draw?.closeTime || forecast?.closeTime || result?.closeTime),
      turnover: parseDecimal(draw?.turnover || forecast?.turnover || result?.turnover),
      sport: draw?.sport || forecast?.sport || result?.sport || null,
      sportId: draw?.sportId || forecast?.sportId || result?.sportId || null,
      checksum: draw?.checksum || forecast?.checksum || result?.checksum || null,
      drawAvailable: Boolean(draw),
      forecastAvailable: Boolean(forecast),
      resultAvailable: Boolean(result),
      forecastDistribution: forecast?.distribution || null,
      resultDistribution: result?.distribution || null,
      rawDraw: draw,
      rawForecast: forecast,
      rawResult: result,
    });

    const drawEvents = indexEvents(draw?.events || []);
    const forecastEvents = indexEvents(forecast?.events || []);
    const resultEvents = indexEvents(result?.events || []);
    const eventNumbers = new Set([
      ...drawEvents.keys(),
      ...forecastEvents.keys(),
      ...resultEvents.keys(),
    ]);

    for (const eventNumber of [...eventNumbers].sort((left, right) => left - right)) {
      const drawEvent = drawEvents.get(eventNumber) || null;
      const forecastEvent = forecastEvents.get(eventNumber) || null;
      const resultEvent = resultEvents.get(eventNumber) || null;
      const participants = getParticipants(drawEvent);
      const odds = drawEvent?.odds || null;
      const distribution = drawEvent?.distribution || null;
      const startOdds = drawEvent?.startOdds || null;
      const favouriteOdds = drawEvent?.favouriteOdds || null;
      const hasOdds = Boolean(odds && (odds.home || odds.draw || odds.away));

      await upsertEvent(client, {
        product: CONFIG.product,
        drawNumber,
        eventNumber,
        description: drawEvent?.description || forecastEvent?.description || resultEvent?.description || null,
        cancelled: drawEvent?.cancelled ?? forecastEvent?.cancelled ?? resultEvent?.cancelled ?? null,
        resultCancelled: resultEvent?.cancelled ?? null,
        eventComment: resultEvent?.eventComment || null,
        participantType: drawEvent?.participantType || null,
        homeParticipantName: participants.home?.name || null,
        awayParticipantName: participants.away?.name || null,
        leagueName: drawEvent?.league?.name || null,
        countryName: drawEvent?.league?.country?.name || null,
        sportEventId: drawEvent?.sportEventId || null,
        sportEventStart: parseDate(drawEvent?.sportEventStart),
        sportEventStatus: drawEvent?.sportEventStatus || forecastEvent?.sportEventStatus || null,
        oddsAvailable: hasOdds,
        oddsHome: parseDecimal(odds?.home),
        oddsDraw: parseDecimal(odds?.draw),
        oddsAway: parseDecimal(odds?.away),
        startOddsHome: parseDecimal(startOdds?.home),
        startOddsDraw: parseDecimal(startOdds?.draw),
        startOddsAway: parseDecimal(startOdds?.away),
        favouritePctHome: parseInteger(favouriteOdds?.home),
        favouritePctDraw: parseInteger(favouriteOdds?.draw),
        favouritePctAway: parseInteger(favouriteOdds?.away),
        distributionHome: parseInteger(distribution?.home),
        distributionDraw: parseInteger(distribution?.draw),
        distributionAway: parseInteger(distribution?.away),
        distributionRefHome: parseInteger(distribution?.refHome),
        distributionRefDraw: parseInteger(distribution?.refDraw),
        distributionRefAway: parseInteger(distribution?.refAway),
        distributionDate: parseDate(distribution?.date),
        distributionRefDate: parseDate(distribution?.refDate),
        forecastOutcome: forecastEvent?.outcome || null,
        forecastOutcomeScore: forecastEvent?.outcomeScore || null,
        forecastIsFinished: forecastEvent?.isFinished ?? null,
        resultOutcome: resultEvent?.outcome || null,
        resultOutcomeScore: resultEvent?.outcomeScore || null,
        providerIds: drawEvent?.providerIds || forecastEvent?.providerIds || resultEvent?.providerIds || null,
        rawDrawEvent: drawEvent,
        rawForecastEvent: forecastEvent,
        rawResultEvent: resultEvent,
      });
    }

    if ((currentDraw - drawNumber + 1) % 50 === 0) {
      console.log(`Normalized ${currentDraw - drawNumber + 1} av ${CONFIG.latestDrawCount} draws till Neon.`);
    }
  }
}

async function collectVerification(client) {
  const query = `
    SELECT
      (SELECT COUNT(*) FROM raw_responses WHERE product = 'topptipset') AS raw_response_count,
      (SELECT COUNT(*) FROM pool_draws WHERE product = 'topptipset') AS normalized_draw_count,
      (SELECT COUNT(*) FROM pool_events WHERE product = 'topptipset') AS normalized_event_count,
      (SELECT COUNT(*) FROM topptipset_latest_500_draw_summary) AS latest_500_draw_count,
      (SELECT COUNT(*) FROM topptipset_latest_500_events) AS latest_500_event_count,
      (SELECT COUNT(*) FROM topptipset_latest_500_draw_summary WHERE events_with_odds > 0) AS latest_500_draws_with_any_odds,
      (SELECT COUNT(*) FROM topptipset_latest_500_events WHERE odds_available) AS latest_500_events_with_odds,
      (SELECT COUNT(*) FROM topptipset_latest_500_draw_summary WHERE events_with_rapidapi_odds > 0) AS latest_500_draws_with_any_rapidapi_odds,
      (SELECT COUNT(*) FROM topptipset_latest_500_events WHERE rapidapi_has_odds) AS latest_500_events_with_rapidapi_odds,
      (SELECT COUNT(*) FROM topptipset_latest_500_historical_draw_summary WHERE events_with_tipsxtra_odds > 0) AS latest_500_draws_with_any_tipsxtra_odds,
      (SELECT COUNT(*) FROM topptipset_latest_500_historical_odds WHERE tipsxtra_available) AS latest_500_events_with_tipsxtra_rows,
      (SELECT COUNT(*) FROM topptipset_latest_500_historical_odds WHERE historical_odds_source IS NOT NULL) AS latest_500_events_with_historical_odds,
      (SELECT COUNT(*) FROM topptipset_latest_500_historical_draw_summary WHERE events_with_historical_odds > 0) AS latest_500_draws_with_any_historical_odds,
      (SELECT COUNT(*) FROM topptipset_latest_500_draw_summary WHERE result_available) AS latest_500_draws_with_result,
      (SELECT MIN(draw_number) FROM topptipset_latest_500_draw_summary) AS latest_500_oldest_draw,
      (SELECT MAX(draw_number) FROM topptipset_latest_500_draw_summary) AS latest_500_newest_draw
  `;
  const result = await client.query(query);
  return result.rows[0];
}

async function main() {
  const currentDraw = await getCurrentDrawNumber(CONFIG.product);
  const minLatestDraw = currentDraw - CONFIG.latestDrawCount + 1;
  const sqliteDb = openSqliteDb();
  const pool = new Pool({
    connectionString: normalizeDatabaseUrl(CONFIG.databaseUrl),
  });
  const client = await pool.connect();

  try {
    console.log(`Topptipset current draw: ${currentDraw}`);
    console.log(`Preparing latest ${CONFIG.latestDrawCount} draws (${minLatestDraw}-${currentDraw}) in Neon.`);

    await ensureSchema(client);

    let sqliteSeedCount = 0;
    let responseMap = new Map();

    if (sqliteDb) {
      const sqliteAllRows = getSqliteRows(sqliteDb, CONFIG.product, 1, currentDraw);
      sqliteSeedCount = sqliteAllRows.length;

      for (let index = 0; index < sqliteAllRows.length; index += 250) {
        const batch = sqliteAllRows.slice(index, index + 250);
        await upsertRawResponseBatch(client, batch);
      }

      const latestRows = sqliteAllRows.filter((row) => row.drawNumber >= minLatestDraw);
      responseMap = buildResponseMap(latestRows);
      console.log(`Seeded ${sqliteSeedCount} raw SQLite rows into Neon.`);
    } else {
      console.log('No local raw_data.db found. Will rely on live API fetches only.');
    }

    const liveRefreshFloor = Math.max(minLatestDraw, currentDraw - CONFIG.liveRefreshCount + 1);
    let liveRefreshCount = 0;

    for (let drawNumber = currentDraw; drawNumber >= liveRefreshFloor; drawNumber -= 1) {
      for (const endpointType of ENDPOINT_TYPES) {
        const row = await fetchRawResponse(CONFIG.product, drawNumber, endpointType);
        await upsertRawResponseBatch(client, [row]);
        responseMap.set(responseKey(drawNumber, endpointType), row);
        liveRefreshCount += 1;
      }
    }

    for (let drawNumber = currentDraw; drawNumber >= minLatestDraw; drawNumber -= 1) {
      for (const endpointType of ENDPOINT_TYPES) {
        const key = responseKey(drawNumber, endpointType);
        if (responseMap.has(key)) {
          continue;
        }

        const row = await fetchRawResponse(CONFIG.product, drawNumber, endpointType);
        await upsertRawResponseBatch(client, [row]);
        responseMap.set(key, row);
        liveRefreshCount += 1;
      }
    }

    console.log(`Refreshed or fetched ${liveRefreshCount} live API responses.`);

    await client.query('BEGIN');
    await normalizeDraws(client, responseMap, currentDraw);
    await client.query('COMMIT');

    const verification = await collectVerification(client);
    console.log('=== NEON IMPORT SUMMARY ===');
    console.log(JSON.stringify({
      currentDraw,
      latestDrawWindow: {
        from: minLatestDraw,
        to: currentDraw,
      },
      sqliteSeedCount,
      liveRefreshCount,
      verification,
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
    if (sqliteDb) {
      sqliteDb.close();
    }
  }
}

main();
