require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Pool } = require('pg');

const { normalizeDatabaseUrl } = require('./lib/rapidapi-topptipset');

const CONFIG = {
  databaseUrl: process.env.DATABASE_URL,
  csvPath: path.resolve(process.cwd(), process.env.TIPSXTRA_TOPPTIPSET_CSV_PATH || 'TipsXtra_Topptipset_Statistik_Detaljer.csv'),
  csvProductName: 'Topptipset',
  eventBatchSize: Number(process.env.TIPSXTRA_HISTORY_EVENT_BATCH_SIZE || 250),
  drawBatchSize: Number(process.env.TIPSXTRA_HISTORY_DRAW_BATCH_SIZE || 500),
};

const HISTORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tipsxtra_topptipset_draws (
  draw_number INTEGER PRIMARY KEY,
  draw_code INTEGER,
  event_count INTEGER NOT NULL,
  first_match_start TIMESTAMPTZ,
  last_match_start TIMESTAMPTZ,
  complete_odds BOOLEAN NOT NULL DEFAULT FALSE,
  complete_results BOOLEAN NOT NULL DEFAULT FALSE,
  complete_backtest BOOLEAN NOT NULL DEFAULT FALSE,
  source_file TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tipsxtra_topptipset_events (
  draw_number INTEGER NOT NULL REFERENCES tipsxtra_topptipset_draws(draw_number) ON DELETE CASCADE,
  draw_code INTEGER,
  event_number INTEGER NOT NULL,
  home_team TEXT,
  away_team TEXT,
  home_score INTEGER,
  away_score INTEGER,
  match_start TIMESTAMPTZ,
  outcome TEXT,
  match_status TEXT,
  expert_tip TEXT,
  market_high_pct INTEGER,
  market_low_pct INTEGER,
  market_diff_pct INTEGER,
  public_high_pct INTEGER,
  public_low_pct INTEGER,
  public_diff_pct INTEGER,
  public_rank INTEGER,
  market_rank INTEGER,
  market_odds_home NUMERIC,
  market_odds_draw NUMERIC,
  market_odds_away NUMERIC,
  market_pct_home INTEGER,
  market_pct_draw INTEGER,
  market_pct_away INTEGER,
  public_odds_home NUMERIC,
  public_odds_draw NUMERIC,
  public_odds_away NUMERIC,
  public_pct_home INTEGER,
  public_pct_draw INTEGER,
  public_pct_away INTEGER,
  newspaper_home INTEGER,
  newspaper_draw INTEGER,
  newspaper_away INTEGER,
  public_was_right BOOLEAN,
  market_was_right BOOLEAN,
  public_was_wrong BOOLEAN,
  market_was_wrong BOOLEAN,
  expert_was_right BOOLEAN,
  svspelinfo_id BIGINT,
  raw_row JSONB,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (draw_number, event_number)
);

CREATE INDEX IF NOT EXISTS idx_tipsxtra_topptipset_draws_complete_backtest
  ON tipsxtra_topptipset_draws (complete_backtest, draw_number);

CREATE INDEX IF NOT EXISTS idx_tipsxtra_topptipset_events_match_start
  ON tipsxtra_topptipset_events (match_start, draw_number, event_number);

CREATE INDEX IF NOT EXISTS idx_tipsxtra_topptipset_events_svspelinfo
  ON tipsxtra_topptipset_events (svspelinfo_id);

CREATE OR REPLACE VIEW tipsxtra_topptipset_complete_draws AS
SELECT *
FROM tipsxtra_topptipset_draws
WHERE complete_backtest
ORDER BY draw_number ASC;

CREATE OR REPLACE VIEW tipsxtra_topptipset_backtest_candidates AS
SELECT
  e.draw_number,
  e.draw_code,
  e.event_number,
  e.home_team,
  e.away_team,
  e.match_start,
  e.outcome AS actual_outcome,
  e.match_status,
  e.expert_tip,
  e.market_diff_pct,
  e.public_diff_pct,
  '1'::TEXT AS outcome_sign,
  e.market_odds_home AS market_odds,
  e.market_pct_home / 100.0 AS market_prob,
  e.public_odds_home AS public_odds,
  e.public_pct_home / 100.0 AS public_prob,
  e.newspaper_home AS newspaper_support,
  CASE WHEN e.outcome = '1' THEN TRUE ELSE FALSE END AS is_correct,
  CASE WHEN e.expert_tip = '1' THEN TRUE ELSE FALSE END AS expert_support
FROM tipsxtra_topptipset_events e
JOIN tipsxtra_topptipset_complete_draws d
  ON d.draw_number = e.draw_number
UNION ALL
SELECT
  e.draw_number,
  e.draw_code,
  e.event_number,
  e.home_team,
  e.away_team,
  e.match_start,
  e.outcome AS actual_outcome,
  e.match_status,
  e.expert_tip,
  e.market_diff_pct,
  e.public_diff_pct,
  'X'::TEXT AS outcome_sign,
  e.market_odds_draw AS market_odds,
  e.market_pct_draw / 100.0 AS market_prob,
  e.public_odds_draw AS public_odds,
  e.public_pct_draw / 100.0 AS public_prob,
  e.newspaper_draw AS newspaper_support,
  CASE WHEN e.outcome = 'X' THEN TRUE ELSE FALSE END AS is_correct,
  CASE WHEN e.expert_tip = 'X' THEN TRUE ELSE FALSE END AS expert_support
FROM tipsxtra_topptipset_events e
JOIN tipsxtra_topptipset_complete_draws d
  ON d.draw_number = e.draw_number
UNION ALL
SELECT
  e.draw_number,
  e.draw_code,
  e.event_number,
  e.home_team,
  e.away_team,
  e.match_start,
  e.outcome AS actual_outcome,
  e.match_status,
  e.expert_tip,
  e.market_diff_pct,
  e.public_diff_pct,
  '2'::TEXT AS outcome_sign,
  e.market_odds_away AS market_odds,
  e.market_pct_away / 100.0 AS market_prob,
  e.public_odds_away AS public_odds,
  e.public_pct_away / 100.0 AS public_prob,
  e.newspaper_away AS newspaper_support,
  CASE WHEN e.outcome = '2' THEN TRUE ELSE FALSE END AS is_correct,
  CASE WHEN e.expert_tip = '2' THEN TRUE ELSE FALSE END AS expert_support
FROM tipsxtra_topptipset_events e
JOIN tipsxtra_topptipset_complete_draws d
  ON d.draw_number = e.draw_number;
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

  const parsed = new Date(normalized.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeOutcome(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === '1' || normalized === 'X' || normalized === '2') {
    return normalized;
  }
  return null;
}

function normalizeHeader(value) {
  return String(value || '').replace(/^\uFEFF/, '').trim();
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

function rowToObject(headers, values) {
  const row = {};
  for (let index = 0; index < headers.length; index += 1) {
    row[headers[index]] = values[index] ?? '';
  }
  return row;
}

function normalizeCsvRow(row) {
  return {
    drawNumber: parseInteger(row.omgang),
    drawCode: parseInteger(row.omg),
    eventNumber: parseInteger(row.matchnummer),
    homeTeam: String(row.hemmalag || '').trim() || null,
    awayTeam: String(row.bortalag || '').trim() || null,
    homeScore: parseInteger(row.hemmaresultat),
    awayScore: parseInteger(row.bortaresultat),
    matchStart: parseLocalDateTime(row.matchstart),
    outcome: normalizeOutcome(row.utfall),
    matchStatus: String(row.matchstatus || '').trim() || null,
    expertTip: normalizeOutcome(row.experttips),
    marketHighPct: parseInteger(row.oddset_high),
    marketLowPct: parseInteger(row.oddset_low),
    marketDiffPct: parseInteger(row.oddset_diff),
    publicHighPct: parseInteger(row.people_high),
    publicLowPct: parseInteger(row.people_low),
    publicDiffPct: parseInteger(row.people_diff),
    publicRank: parseInteger(row.people_rank),
    marketRank: parseInteger(row.oddset_rank),
    marketOddsHome: parseDecimal(row.oddset1),
    marketOddsDraw: parseDecimal(row.oddsetx),
    marketOddsAway: parseDecimal(row.oddset2),
    marketPctHome: parseInteger(row.oddset_procent1),
    marketPctDraw: parseInteger(row.oddset_procentx),
    marketPctAway: parseInteger(row.oddset_procent2),
    publicOddsHome: parseDecimal(row.svenska_folket_odds1),
    publicOddsDraw: parseDecimal(row.svenska_folket_oddsx),
    publicOddsAway: parseDecimal(row.svenska_folket_odds2),
    publicPctHome: parseInteger(row.svenska_folket1),
    publicPctDraw: parseInteger(row.svenska_folketx),
    publicPctAway: parseInteger(row.svenska_folket2),
    newspaperHome: parseInteger(row.tio_tidningar1),
    newspaperDraw: parseInteger(row.tio_tidningarx),
    newspaperAway: parseInteger(row.tio_tidningar2),
    publicWasRight: parseBooleanFlag(row.people_was_right),
    marketWasRight: parseBooleanFlag(row.oddset_was_right),
    publicWasWrong: parseBooleanFlag(row.people_was_wrong),
    marketWasWrong: parseBooleanFlag(row.oddset_was_wrong),
    expertWasRight: parseBooleanFlag(row.expert_was_right),
    svspelinfoId: parseInteger(row.svspelinfo_id),
    rawRow: row,
  };
}

async function readCsvHistory() {
  const events = [];
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

    const row = rowToObject(headers, parseCsvLine(line));
    if (row.produktnamn !== CONFIG.csvProductName) {
      continue;
    }

    const normalized = normalizeCsvRow(row);
    if (!normalized.drawNumber || !normalized.eventNumber) {
      continue;
    }

    events.push(normalized);
  }

  return events;
}

function summarizeDraws(events) {
  const grouped = new Map();

  for (const event of events) {
    if (!grouped.has(event.drawNumber)) {
      grouped.set(event.drawNumber, []);
    }
    grouped.get(event.drawNumber).push(event);
  }

  return [...grouped.entries()]
    .map(([drawNumber, drawEvents]) => {
      const sortedEvents = [...drawEvents].sort((left, right) => left.eventNumber - right.eventNumber);
      const matchStarts = sortedEvents.map((event) => event.matchStart).filter(Boolean).sort();
      const completeOdds = sortedEvents.every(
        (event) =>
          event.marketOddsHome != null &&
          event.marketOddsDraw != null &&
          event.marketOddsAway != null &&
          event.publicOddsHome != null &&
          event.publicOddsDraw != null &&
          event.publicOddsAway != null
      );
      const completeResults = sortedEvents.every((event) => event.outcome != null);

      return {
        drawNumber,
        drawCode: sortedEvents[0]?.drawCode ?? null,
        eventCount: sortedEvents.length,
        firstMatchStart: matchStarts[0] || null,
        lastMatchStart: matchStarts[matchStarts.length - 1] || null,
        completeOdds,
        completeResults,
        completeBacktest: sortedEvents.length === 8 && completeOdds && completeResults,
      };
    })
    .sort((left, right) => left.drawNumber - right.drawNumber);
}

async function ensureSchema(client) {
  await client.query(HISTORY_SCHEMA_SQL);
}

async function upsertDraws(client, drawRows) {
  for (let offset = 0; offset < drawRows.length; offset += CONFIG.drawBatchSize) {
    const batch = drawRows.slice(offset, offset + CONFIG.drawBatchSize);
    const values = [];
    const placeholders = batch.map((draw, index) => {
      const base = index * 9;
      values.push(
        draw.drawNumber,
        draw.drawCode,
        draw.eventCount,
        draw.firstMatchStart,
        draw.lastMatchStart,
        draw.completeOdds,
        draw.completeResults,
        draw.completeBacktest,
        CONFIG.csvPath
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
    });

    await client.query(
      `
        INSERT INTO tipsxtra_topptipset_draws (
          draw_number,
          draw_code,
          event_count,
          first_match_start,
          last_match_start,
          complete_odds,
          complete_results,
          complete_backtest,
          source_file
        )
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (draw_number)
        DO UPDATE SET
          draw_code = EXCLUDED.draw_code,
          event_count = EXCLUDED.event_count,
          first_match_start = EXCLUDED.first_match_start,
          last_match_start = EXCLUDED.last_match_start,
          complete_odds = EXCLUDED.complete_odds,
          complete_results = EXCLUDED.complete_results,
          complete_backtest = EXCLUDED.complete_backtest,
          source_file = EXCLUDED.source_file,
          imported_at = NOW()
      `,
      values
    );
  }
}

async function upsertEvents(client, eventRows) {
  for (let offset = 0; offset < eventRows.length; offset += CONFIG.eventBatchSize) {
    const batch = eventRows.slice(offset, offset + CONFIG.eventBatchSize);
    const values = [];
    const placeholders = batch.map((event, index) => {
      const base = index * 41;
      values.push(
        event.drawNumber,
        event.drawCode,
        event.eventNumber,
        event.homeTeam,
        event.awayTeam,
        event.homeScore,
        event.awayScore,
        event.matchStart,
        event.outcome,
        event.matchStatus,
        event.expertTip,
        event.marketHighPct,
        event.marketLowPct,
        event.marketDiffPct,
        event.publicHighPct,
        event.publicLowPct,
        event.publicDiffPct,
        event.publicRank,
        event.marketRank,
        event.marketOddsHome,
        event.marketOddsDraw,
        event.marketOddsAway,
        event.marketPctHome,
        event.marketPctDraw,
        event.marketPctAway,
        event.publicOddsHome,
        event.publicOddsDraw,
        event.publicOddsAway,
        event.publicPctHome,
        event.publicPctDraw,
        event.publicPctAway,
        event.newspaperHome,
        event.newspaperDraw,
        event.newspaperAway,
        event.publicWasRight,
        event.marketWasRight,
        event.publicWasWrong,
        event.marketWasWrong,
        event.expertWasRight,
        event.svspelinfoId,
        JSON.stringify(event.rawRow)
      );
      return `(
        $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8},
        $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15}, $${base + 16},
        $${base + 17}, $${base + 18}, $${base + 19}, $${base + 20}, $${base + 21}, $${base + 22}, $${base + 23}, $${base + 24},
        $${base + 25}, $${base + 26}, $${base + 27}, $${base + 28}, $${base + 29}, $${base + 30}, $${base + 31}, $${base + 32},
        $${base + 33}, $${base + 34}, $${base + 35}, $${base + 36}, $${base + 37}, $${base + 38}, $${base + 39}, $${base + 40},
        $${base + 41}::jsonb
      )`;
    });

    await client.query(
      `
        INSERT INTO tipsxtra_topptipset_events (
          draw_number,
          draw_code,
          event_number,
          home_team,
          away_team,
          home_score,
          away_score,
          match_start,
          outcome,
          match_status,
          expert_tip,
          market_high_pct,
          market_low_pct,
          market_diff_pct,
          public_high_pct,
          public_low_pct,
          public_diff_pct,
          public_rank,
          market_rank,
          market_odds_home,
          market_odds_draw,
          market_odds_away,
          market_pct_home,
          market_pct_draw,
          market_pct_away,
          public_odds_home,
          public_odds_draw,
          public_odds_away,
          public_pct_home,
          public_pct_draw,
          public_pct_away,
          newspaper_home,
          newspaper_draw,
          newspaper_away,
          public_was_right,
          market_was_right,
          public_was_wrong,
          market_was_wrong,
          expert_was_right,
          svspelinfo_id,
          raw_row
        )
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (draw_number, event_number)
        DO UPDATE SET
          draw_code = EXCLUDED.draw_code,
          home_team = EXCLUDED.home_team,
          away_team = EXCLUDED.away_team,
          home_score = EXCLUDED.home_score,
          away_score = EXCLUDED.away_score,
          match_start = EXCLUDED.match_start,
          outcome = EXCLUDED.outcome,
          match_status = EXCLUDED.match_status,
          expert_tip = EXCLUDED.expert_tip,
          market_high_pct = EXCLUDED.market_high_pct,
          market_low_pct = EXCLUDED.market_low_pct,
          market_diff_pct = EXCLUDED.market_diff_pct,
          public_high_pct = EXCLUDED.public_high_pct,
          public_low_pct = EXCLUDED.public_low_pct,
          public_diff_pct = EXCLUDED.public_diff_pct,
          public_rank = EXCLUDED.public_rank,
          market_rank = EXCLUDED.market_rank,
          market_odds_home = EXCLUDED.market_odds_home,
          market_odds_draw = EXCLUDED.market_odds_draw,
          market_odds_away = EXCLUDED.market_odds_away,
          market_pct_home = EXCLUDED.market_pct_home,
          market_pct_draw = EXCLUDED.market_pct_draw,
          market_pct_away = EXCLUDED.market_pct_away,
          public_odds_home = EXCLUDED.public_odds_home,
          public_odds_draw = EXCLUDED.public_odds_draw,
          public_odds_away = EXCLUDED.public_odds_away,
          public_pct_home = EXCLUDED.public_pct_home,
          public_pct_draw = EXCLUDED.public_pct_draw,
          public_pct_away = EXCLUDED.public_pct_away,
          newspaper_home = EXCLUDED.newspaper_home,
          newspaper_draw = EXCLUDED.newspaper_draw,
          newspaper_away = EXCLUDED.newspaper_away,
          public_was_right = EXCLUDED.public_was_right,
          market_was_right = EXCLUDED.market_was_right,
          public_was_wrong = EXCLUDED.public_was_wrong,
          market_was_wrong = EXCLUDED.market_was_wrong,
          expert_was_right = EXCLUDED.expert_was_right,
          svspelinfo_id = EXCLUDED.svspelinfo_id,
          raw_row = EXCLUDED.raw_row,
          imported_at = NOW()
      `,
      values
    );
  }
}

async function collectVerification(client) {
  const result = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM tipsxtra_topptipset_draws) AS draw_count,
      (SELECT COUNT(*) FROM tipsxtra_topptipset_events) AS event_count,
      (SELECT COUNT(*) FROM tipsxtra_topptipset_draws WHERE complete_backtest) AS complete_backtest_draw_count,
      (SELECT COUNT(*) FROM tipsxtra_topptipset_backtest_candidates) AS candidate_count,
      (SELECT MIN(draw_number) FROM tipsxtra_topptipset_draws) AS oldest_draw,
      (SELECT MAX(draw_number) FROM tipsxtra_topptipset_draws) AS newest_draw
  `);
  return result.rows[0];
}

async function main() {
  const events = await readCsvHistory();
  const draws = summarizeDraws(events);

  const pool = new Pool({
    connectionString: normalizeDatabaseUrl(CONFIG.databaseUrl),
  });

  try {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await ensureSchema(client);
      await upsertDraws(client, draws);
      await upsertEvents(client, events);
      const verification = await collectVerification(client);
      await client.query('COMMIT');

      console.log(
        JSON.stringify(
          {
            ok: true,
            csvPath: CONFIG.csvPath,
            importedDraws: draws.length,
            importedEvents: events.length,
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
