require('dotenv').config();

const { Pool } = require('pg');
const {
  buildRapidClient,
  extractThreeWayOdds,
  findRapidApiCandidatesForSourceEvent,
  fetchProviderOdds,
  isConfidentCandidate,
  normalizeDatabaseUrl,
  parseNumberList,
} = require('./lib/rapidapi-topptipset');

const CONFIG = {
  product: 'topptipset',
  latestDrawCount: Number(process.env.TOPPTIPSET_LATEST_DRAW_COUNT || 500),
  targetDrawNumbers: [...new Set(parseNumberList(process.env.TOPPTIPSET_DRAW_NUMBERS || ''))].sort((left, right) => left - right),
  databaseUrl: process.env.DATABASE_URL,
  mappingConcurrency: Number(process.env.RAPIDAPI_MAPPING_CONCURRENCY || 6),
  oddsConcurrency: Number(process.env.RAPIDAPI_ODDS_CONCURRENCY || 6),
  calibrationProviderIds: parseNumberList(process.env.RAPIDAPI_CALIBRATION_PROVIDER_IDS || '1,5,226,317,100'),
  fallbackProviderIds: parseNumberList(process.env.RAPIDAPI_FALLBACK_PROVIDER_IDS || ''),
};

const RAPIDAPI_SCHEMA_SQL = `
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
  ADD COLUMN IF NOT EXISTS rapidapi_mapped_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pool_events_rapidapi_event_id
  ON pool_events (product, rapidapi_event_id);

CREATE INDEX IF NOT EXISTS idx_pool_events_rapidapi_provider
  ON pool_events (product, rapidapi_provider_id, draw_number DESC);
`;

if (!CONFIG.databaseUrl) {
  console.error('FATAL: DATABASE_URL saknas i .env');
  process.exit(1);
}

function toJson(value) {
  return value == null ? null : JSON.stringify(value);
}

function chooseProviderOrder(stats) {
  const sorted = [...stats].sort((left, right) => {
    if (right.eventsCompared !== left.eventsCompared) {
      return right.eventsCompared - left.eventsCompared;
    }
    if (left.meanAbsError !== right.meanAbsError) {
      return left.meanAbsError - right.meanAbsError;
    }
    if (right.eventsWithOdds !== left.eventsWithOdds) {
      return right.eventsWithOdds - left.eventsWithOdds;
    }
    return left.providerId - right.providerId;
  });

  return sorted.map((entry) => entry.providerId);
}

function summarizeProviderStats(statsMap, totalCalibrationEvents) {
  return [...statsMap.values()].map((entry) => {
    const meanAbsError = entry.valuesCompared > 0
      ? Number((entry.absErrorSum / entry.valuesCompared).toFixed(4))
      : Number.POSITIVE_INFINITY;

    const openingMae = entry.openingValuesCompared > 0
      ? Number((entry.openingAbsErrorSum / entry.openingValuesCompared).toFixed(4))
      : null;

    const closingMae = entry.closingValuesCompared > 0
      ? Number((entry.closingAbsErrorSum / entry.closingValuesCompared).toFixed(4))
      : null;

    return {
      providerId: entry.providerId,
      eventsWithOdds: entry.eventsWithOdds,
      eventsCompared: entry.eventsCompared,
      valuesCompared: entry.valuesCompared,
      coveragePct: totalCalibrationEvents > 0
        ? Number(((entry.eventsCompared / totalCalibrationEvents) * 100).toFixed(2))
        : 0,
      meanAbsError,
      openingMae,
      closingMae,
    };
  });
}

function compareOdds(stats, sourceEvent, threeWay) {
  const sourceOpening = [
    Number(sourceEvent.start_odds_home),
    Number(sourceEvent.start_odds_draw),
    Number(sourceEvent.start_odds_away),
  ];
  const sourceClosing = [
    Number(sourceEvent.odds_home),
    Number(sourceEvent.odds_draw),
    Number(sourceEvent.odds_away),
  ];
  const rapidOpening = [threeWay.opening.home, threeWay.opening.draw, threeWay.opening.away];
  const rapidClosing = [threeWay.closing.home, threeWay.closing.draw, threeWay.closing.away];

  let comparedValues = 0;

  for (let index = 0; index < 3; index += 1) {
    const left = sourceOpening[index];
    const right = rapidOpening[index];
    if (Number.isFinite(left) && Number.isFinite(right)) {
      stats.absErrorSum += Math.abs(left - right);
      stats.openingAbsErrorSum += Math.abs(left - right);
      stats.valuesCompared += 1;
      stats.openingValuesCompared += 1;
      comparedValues += 1;
    }
  }

  for (let index = 0; index < 3; index += 1) {
    const left = sourceClosing[index];
    const right = rapidClosing[index];
    if (Number.isFinite(left) && Number.isFinite(right)) {
      stats.absErrorSum += Math.abs(left - right);
      stats.closingAbsErrorSum += Math.abs(left - right);
      stats.valuesCompared += 1;
      stats.closingValuesCompared += 1;
      comparedValues += 1;
    }
  }

  if (comparedValues > 0) {
    stats.eventsCompared += 1;
  }
}

async function mapLimit(items, concurrency, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = index;
      index += 1;
      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

async function ensureRapidApiSchema(client) {
  await client.query(RAPIDAPI_SCHEMA_SQL);
}

async function loadLatestEvents(client) {
  if (CONFIG.targetDrawNumbers.length) {
    const result = await client.query(
      `
        SELECT
          e.product,
          e.draw_number,
          e.event_number,
          e.description,
          e.home_participant_name,
          e.away_participant_name,
          e.sport_event_start,
          e.league_name,
          e.country_name,
          e.odds_available,
          e.odds_home,
          e.odds_draw,
          e.odds_away,
          e.start_odds_home,
          e.start_odds_draw,
          e.start_odds_away,
          d.close_time
        FROM pool_events e
        JOIN pool_draws d
          ON d.product = e.product
         AND d.draw_number = e.draw_number
        WHERE e.product = $1
          AND e.draw_number = ANY($2::int[])
        ORDER BY e.draw_number DESC, e.event_number ASC
      `,
      [CONFIG.product, CONFIG.targetDrawNumbers]
    );

    return result.rows;
  }

  const result = await client.query(
    `
      SELECT
        e.product,
        e.draw_number,
        e.event_number,
        e.description,
        e.home_participant_name,
        e.away_participant_name,
        e.sport_event_start,
        e.league_name,
        e.country_name,
        e.odds_available,
        e.odds_home,
        e.odds_draw,
        e.odds_away,
        e.start_odds_home,
        e.start_odds_draw,
        e.start_odds_away,
        d.close_time
      FROM pool_events e
      JOIN pool_draws d
        ON d.product = e.product
       AND d.draw_number = e.draw_number
      WHERE e.product = $1
        AND e.draw_number >= COALESCE((
          SELECT MAX(draw_number) - ($2 - 1)
          FROM pool_draws
          WHERE product = $1
        ), 0)
      ORDER BY e.draw_number DESC, e.event_number ASC
    `,
    [CONFIG.product, CONFIG.latestDrawCount]
  );

  return result.rows;
}


function buildEventKey(event) {
  return `${event.draw_number}:${event.event_number}`;
}

async function mapSourceEvent(sourceEvent, rapidClient, mappingCache) {
  const candidateLookup = await findRapidApiCandidatesForSourceEvent(rapidClient, sourceEvent, mappingCache);
  const selectedCandidate = candidateLookup.selectedCandidate;

  if (!selectedCandidate) {
    return {
      sourceEvent,
      mappingStatus: candidateLookup.strategy === 'missing_start_time' ? 'missing_start_time' : 'unmapped',
      selectedCandidate: null,
      rankedCandidates: candidateLookup.rankedCandidates,
      searchWindow: candidateLookup.searchWindow,
      strategy: candidateLookup.strategy,
    };
  }

  return {
    sourceEvent,
    mappingStatus: isConfidentCandidate(selectedCandidate) ? 'mapped' : 'ambiguous',
    selectedCandidate,
    rankedCandidates: candidateLookup.rankedCandidates,
    searchWindow: candidateLookup.searchWindow,
    strategy: candidateLookup.strategy,
  };
}

async function getProviderOddsCached(providerCache, rapidClient, eventId, providerId) {
  const key = `${eventId}:${providerId}`;
  if (!providerCache.has(key)) {
    providerCache.set(key, fetchProviderOdds(rapidClient, eventId, providerId));
  }
  return providerCache.get(key);
}

async function calibrateProviders(mappedEvents, rapidClient, providerCache) {
  const calibrationEvents = mappedEvents.filter(
    (entry) => entry.mappingStatus === 'mapped' && entry.selectedCandidate && entry.sourceEvent.odds_available
  );

  const statsMap = new Map(
    CONFIG.calibrationProviderIds.map((providerId) => [
      providerId,
      {
        providerId,
        eventsWithOdds: 0,
        eventsCompared: 0,
        valuesCompared: 0,
        absErrorSum: 0,
        openingAbsErrorSum: 0,
        openingValuesCompared: 0,
        closingAbsErrorSum: 0,
        closingValuesCompared: 0,
      },
    ])
  );

  await mapLimit(calibrationEvents, CONFIG.oddsConcurrency, async (entry) => {
    for (const providerId of CONFIG.calibrationProviderIds) {
      const provider = await getProviderOddsCached(
        providerCache,
        rapidClient,
        entry.selectedCandidate.event.id,
        providerId
      );

      const threeWay = provider.available
        ? extractThreeWayOdds(provider.markets, { isSwapped: entry.selectedCandidate.isSwapped })
        : null;

      if (!threeWay) {
        continue;
      }

      const stats = statsMap.get(providerId);
      stats.eventsWithOdds += 1;
      compareOdds(stats, entry.sourceEvent, threeWay);
    }
  });

  const stats = summarizeProviderStats(statsMap, calibrationEvents.length);
  const providerOrder = CONFIG.fallbackProviderIds.length
    ? CONFIG.fallbackProviderIds
    : chooseProviderOrder(stats.filter((entry) => Number.isFinite(entry.meanAbsError)));

  return {
    calibrationEventCount: calibrationEvents.length,
    providerStats: stats,
    providerOrder: providerOrder.length ? providerOrder : [100, 226, 5, 1, 317],
  };
}

async function selectProviderOdds(mappingEntry, providerOrder, rapidClient, providerCache) {
  if (mappingEntry.mappingStatus !== 'mapped' || !mappingEntry.selectedCandidate) {
    return null;
  }

  for (const providerId of providerOrder) {
    const provider = await getProviderOddsCached(
      providerCache,
      rapidClient,
      mappingEntry.selectedCandidate.event.id,
      providerId
    );

    const threeWay = provider.available
      ? extractThreeWayOdds(provider.markets, { isSwapped: mappingEntry.selectedCandidate.isSwapped })
      : null;

    if (threeWay) {
      return {
        providerId,
        requestUrl: provider.url,
        requestKeySuffix: provider.keySuffix,
        threeWay,
      };
    }
  }

  return null;
}

async function updateRapidApiEvent(client, entry, selectedOdds) {
  const candidate = entry.selectedCandidate;
  const event = candidate?.event || null;

  const mappingStatus = entry.mappingStatus === 'mapped' && !selectedOdds
    ? 'mapped_no_odds'
    : entry.mappingStatus;

  await client.query(
    `
      UPDATE pool_events
      SET
        rapidapi_mapping_status = $4,
        rapidapi_event_id = $5,
        rapidapi_event_slug = $6,
        rapidapi_event_start = $7,
        rapidapi_tournament_name = $8,
        rapidapi_unique_tournament_id = $9,
        rapidapi_home_team_id = $10,
        rapidapi_away_team_id = $11,
        rapidapi_mapping_score = $12,
        rapidapi_mapping_minutes_diff = $13,
        rapidapi_is_swapped = $14,
        rapidapi_provider_id = $15,
        rapidapi_has_odds = $16,
        rapidapi_odds_open_home = $17,
        rapidapi_odds_open_draw = $18,
        rapidapi_odds_open_away = $19,
        rapidapi_odds_close_home = $20,
        rapidapi_odds_close_draw = $21,
        rapidapi_odds_close_away = $22,
        rapidapi_winner = $23,
        rapidapi_raw_event = $24::jsonb,
        rapidapi_raw_market = $25::jsonb,
        rapidapi_mapped_at = NOW()
      WHERE product = $1
        AND draw_number = $2
        AND event_number = $3
    `,
    [
      entry.sourceEvent.product,
      entry.sourceEvent.draw_number,
      entry.sourceEvent.event_number,
      mappingStatus,
      event?.id || null,
      event?.slug || null,
      event?.startTimestamp ? new Date(event.startTimestamp * 1000).toISOString() : null,
      event?.tournament?.uniqueTournament?.name || event?.tournament?.name || null,
      event?.tournament?.uniqueTournament?.id || null,
      event?.homeTeam?.id || null,
      event?.awayTeam?.id || null,
      candidate?.score ?? null,
      candidate?.minutesDiff ?? null,
      candidate?.isSwapped ?? null,
      selectedOdds?.providerId || null,
      Boolean(selectedOdds),
      selectedOdds?.threeWay?.opening?.home ?? null,
      selectedOdds?.threeWay?.opening?.draw ?? null,
      selectedOdds?.threeWay?.opening?.away ?? null,
      selectedOdds?.threeWay?.closing?.home ?? null,
      selectedOdds?.threeWay?.closing?.draw ?? null,
      selectedOdds?.threeWay?.closing?.away ?? null,
      selectedOdds?.threeWay?.winner || null,
      toJson(event),
      toJson(selectedOdds?.threeWay || null),
    ]
  );
}

async function collectVerification(client) {
  const result = await client.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE rapidapi_mapping_status = 'mapped') AS mapped_events,
        COUNT(*) FILTER (WHERE rapidapi_mapping_status = 'mapped_no_odds') AS mapped_events_without_odds,
        COUNT(*) FILTER (WHERE rapidapi_mapping_status = 'ambiguous') AS ambiguous_events,
        COUNT(*) FILTER (WHERE rapidapi_mapping_status = 'unmapped') AS unmapped_events,
        COUNT(*) FILTER (WHERE rapidapi_has_odds) AS rapidapi_events_with_odds,
        COUNT(DISTINCT rapidapi_provider_id) FILTER (WHERE rapidapi_provider_id IS NOT NULL) AS providers_used
      FROM pool_events
      WHERE product = $1
        AND draw_number >= COALESCE((
          SELECT MAX(draw_number) - ($2 - 1)
          FROM pool_draws
          WHERE product = $1
        ), 0)
    `,
    [CONFIG.product, CONFIG.latestDrawCount]
  );

  return result.rows[0];
}

async function main() {
  const rapidClient = buildRapidClient();
  const pool = new Pool({
    connectionString: normalizeDatabaseUrl(CONFIG.databaseUrl),
  });

  try {
    const schemaClient = await pool.connect();
    try {
      await ensureRapidApiSchema(schemaClient);
    } finally {
      schemaClient.release();
    }

    const loadClient = await pool.connect();
    let latestEvents;
    try {
      latestEvents = await loadLatestEvents(loadClient);
    } finally {
      loadClient.release();
    }

    const mappingCache = {
      scheduledCache: new Map(),
      directMatchSearchCache: new Map(),
      teamSearchCache: new Map(),
      teamMatchesCache: new Map(),
    };
    const providerCache = new Map();

    if (CONFIG.targetDrawNumbers.length) {
      console.log(`RapidAPI backfill limited to draw numbers: ${CONFIG.targetDrawNumbers.join(', ')}`);
    }
    console.log(`Loaded ${latestEvents.length} Topptipset events from Neon for RapidAPI backfill.`);

    const mappedEvents = await mapLimit(latestEvents, CONFIG.mappingConcurrency, async (event) =>
      mapSourceEvent(event, rapidClient, mappingCache)
    );

    const mappedCount = mappedEvents.filter((entry) => entry.mappingStatus === 'mapped').length;
    const ambiguousCount = mappedEvents.filter((entry) => entry.mappingStatus === 'ambiguous').length;
    const unmappedCount = mappedEvents.filter((entry) => entry.mappingStatus !== 'mapped' && entry.mappingStatus !== 'ambiguous').length;

    console.log(
      JSON.stringify(
        {
          mapping: {
            totalEvents: mappedEvents.length,
            mappedCount,
            ambiguousCount,
            unmappedCount,
            scheduledDatesFetched: mappingCache.scheduledCache.size,
            matchSearchesFetched: mappingCache.directMatchSearchCache.size,
            teamSearchesFetched: mappingCache.teamSearchCache.size,
            teamHistoryPagesFetched: mappingCache.teamMatchesCache.size,
          },
        },
        null,
        2
      )
    );

    const calibration = await calibrateProviders(mappedEvents, rapidClient, providerCache);
    console.log(
      JSON.stringify(
        {
          calibration,
        },
        null,
        2
      )
    );

    const selectionResults = await mapLimit(mappedEvents, CONFIG.oddsConcurrency, async (entry) => ({
      entry,
      selectedOdds: await selectProviderOdds(entry, calibration.providerOrder, rapidClient, providerCache),
    }));

    const writeClient = await pool.connect();
    try {
      await writeClient.query('BEGIN');
      for (const result of selectionResults) {
        await updateRapidApiEvent(writeClient, result.entry, result.selectedOdds);
      }
      await writeClient.query('COMMIT');
    } catch (error) {
      await writeClient.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      writeClient.release();
    }

    const verifyClient = await pool.connect();
    let verification;
    try {
      verification = await collectVerification(verifyClient);
    } finally {
      verifyClient.release();
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          latestDrawCount: CONFIG.latestDrawCount,
          targetDrawNumbers: CONFIG.targetDrawNumbers,
          providerOrder: calibration.providerOrder,
          verification,
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
