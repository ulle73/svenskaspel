require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const {
  buildRapidClient,
  extractThreeWayOdds,
  fetchEventDetails,
  fetchProviderOdds,
  findRapidApiCandidatesForSourceEvent,
  getProviderBetRadarId,
  isoOrNull,
  normalizeDatabaseUrl,
  parseNumberList,
  summarizeEvent,
} = require('./lib/rapidapi-topptipset');

const DEFAULT_DRAW_NUMBER = Number(process.env.RAPIDAPI_VERIFY_DRAW_NUMBER || 4177);
const DEFAULT_EVENT_NUMBER = Number(process.env.RAPIDAPI_VERIFY_EVENT_NUMBER || 1);
const DEFAULT_PROVIDER_IDS = parseNumberList(process.env.RAPIDAPI_VERIFY_PROVIDER_IDS || '1,5,226,317,100');

function parseArgs(argv) {
  const parsed = {
    drawNumber: DEFAULT_DRAW_NUMBER,
    eventNumber: DEFAULT_EVENT_NUMBER,
    outFile: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === '--draw' && next) {
      parsed.drawNumber = Number(next);
      index += 1;
    } else if (current === '--event' && next) {
      parsed.eventNumber = Number(next);
      index += 1;
    } else if (current === '--out' && next) {
      parsed.outFile = next;
      index += 1;
    }
  }

  return parsed;
}

function diffOdds(left, right) {
  if (left === null || right === null || left === undefined || right === undefined) {
    return null;
  }
  return Number((Number(left) - Number(right)).toFixed(2));
}

async function getSourceEvent(pool, drawNumber, eventNumber) {
  const result = await pool.query(
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
        e.odds_home,
        e.odds_draw,
        e.odds_away,
        e.start_odds_home,
        e.start_odds_draw,
        e.start_odds_away,
        e.provider_ids,
        e.raw_draw_event,
        d.close_time
      FROM pool_events e
      JOIN pool_draws d
        ON d.product = e.product
       AND d.draw_number = e.draw_number
      WHERE e.product = 'topptipset'
        AND e.draw_number = $1
        AND e.event_number = $2
      LIMIT 1
    `,
    [drawNumber, eventNumber]
  );

  if (!result.rows[0]) {
    throw new Error(`No Topptipset event found for draw ${drawNumber}, event ${eventNumber}.`);
  }

  return result.rows[0];
}

function buildVerificationReport(
  sourceEvent,
  selectedCandidate,
  rankedCandidates,
  eventDetails,
  providerResults,
  searchWindow,
  rapidApiSource,
  eventDetailsError = null
) {
  const sourceCloseOdds = {
    home: Number(sourceEvent.odds_home),
    draw: Number(sourceEvent.odds_draw),
    away: Number(sourceEvent.odds_away),
  };

  const sourceOpenOdds = {
    home: Number(sourceEvent.start_odds_home),
    draw: Number(sourceEvent.start_odds_draw),
    away: Number(sourceEvent.start_odds_away),
  };

  return {
    generatedAt: new Date().toISOString(),
    rapidApiSource,
    searchWindow,
    sourceEvent: {
      drawNumber: sourceEvent.draw_number,
      eventNumber: sourceEvent.event_number,
      description: sourceEvent.description,
      homeParticipantName: sourceEvent.home_participant_name,
      awayParticipantName: sourceEvent.away_participant_name,
      sportEventStart: isoOrNull(sourceEvent.sport_event_start),
      closeTime: isoOrNull(sourceEvent.close_time),
      leagueName: sourceEvent.league_name,
      countryName: sourceEvent.country_name,
      betRadarId: getProviderBetRadarId(sourceEvent.provider_ids),
      providerIds: sourceEvent.provider_ids,
      svenskaSpelOdds: {
        opening: sourceOpenOdds,
        closing: sourceCloseOdds,
      },
    },
    selectedRapidApiEvent: {
      ...summarizeEvent(eventDetails.event),
      mapping: {
        score: selectedCandidate.score,
        minutesDiff: selectedCandidate.minutesDiff,
        national: selectedCandidate.national,
        youth: selectedCandidate.youth,
        directExact: selectedCandidate.directExact,
        swappedExact: selectedCandidate.swappedExact,
        nameScore: selectedCandidate.nameScore,
        isSwapped: selectedCandidate.isSwapped,
      },
      eventUrl: eventDetails.url,
      eventKeySuffix: eventDetails.keySuffix,
      eventDetailsError,
    },
    candidateEvents: rankedCandidates.slice(0, 5).map((candidate) => ({
      ...summarizeEvent(candidate.event),
      score: candidate.score,
      minutesDiff: candidate.minutesDiff,
      national: candidate.national,
      youth: candidate.youth,
      directExact: candidate.directExact,
      swappedExact: candidate.swappedExact,
      nameScore: candidate.nameScore,
      isSwapped: candidate.isSwapped,
    })),
    providerOdds: providerResults.map((provider) => {
      const threeWay = provider.available
        ? extractThreeWayOdds(provider.markets, { isSwapped: selectedCandidate.isSwapped })
        : null;

      return {
        providerId: provider.providerId,
        available: provider.available,
        status: provider.status,
        requestUrl: provider.url,
        requestKeySuffix: provider.keySuffix,
        fullTime1x2: threeWay
          ? {
              opening: threeWay.opening,
              closing: threeWay.closing,
              winner: threeWay.winner,
              sourceOrientation: threeWay.sourceOrientation,
              diffVsSvenskaSpelOpening: {
                home: diffOdds(threeWay.opening.home, sourceOpenOdds.home),
                draw: diffOdds(threeWay.opening.draw, sourceOpenOdds.draw),
                away: diffOdds(threeWay.opening.away, sourceOpenOdds.away),
              },
              diffVsSvenskaSpelClosing: {
                home: diffOdds(threeWay.closing.home, sourceCloseOdds.home),
                draw: diffOdds(threeWay.closing.draw, sourceCloseOdds.draw),
                away: diffOdds(threeWay.closing.away, sourceCloseOdds.away),
              },
              rawChoices: threeWay.rawChoices,
            }
          : null,
        rawOdds: provider.data,
      };
    }),
  };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL saknas i .env');
  }

  const options = parseArgs(process.argv);
  const rapidClient = buildRapidClient();
  const pool = new Pool({
    connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL),
  });

  try {
    const sourceEvent = await getSourceEvent(pool, options.drawNumber, options.eventNumber);
    const mappingCache = {
      scheduledCache: new Map(),
      directMatchSearchCache: new Map(),
      teamSearchCache: new Map(),
      teamMatchesCache: new Map(),
    };
    const candidateLookup = await findRapidApiCandidatesForSourceEvent(rapidClient, sourceEvent, mappingCache);
    const rankedCandidates = candidateLookup.rankedCandidates;
    const selectedCandidate = candidateLookup.selectedCandidate;

    if (!selectedCandidate) {
      throw new Error('No RapidAPI event candidates were found for the selected Topptipset match.');
    }

    let eventDetails;
    let eventDetailsError = null;
    try {
      eventDetails = await fetchEventDetails(rapidClient, selectedCandidate.event.id);
    } catch (error) {
      eventDetailsError = error.message;
      eventDetails = {
        data: {
          event: selectedCandidate.event,
        },
        url: null,
        keySuffix: null,
      };
    }
    const providerResults = [];

    for (const providerId of DEFAULT_PROVIDER_IDS) {
      providerResults.push(await fetchProviderOdds(rapidClient, selectedCandidate.event.id, providerId));
    }

    const report = buildVerificationReport(
      sourceEvent,
      selectedCandidate,
      rankedCandidates,
      eventDetails.data,
      providerResults,
      candidateLookup.searchWindow,
      candidateLookup.strategy,
      eventDetailsError
    );

    const defaultOutFile = path.resolve(
      process.cwd(),
      `rapidapi-verify-draw-${options.drawNumber}-event-${options.eventNumber}.json`
    );
    const outFile = path.resolve(process.cwd(), options.outFile || defaultOutFile);
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

    const providerSummary = report.providerOdds
      .filter((provider) => provider.fullTime1x2)
      .map((provider) => ({
        providerId: provider.providerId,
        opening: provider.fullTime1x2.opening,
        closing: provider.fullTime1x2.closing,
      }));

    console.log(
      JSON.stringify(
        {
          ok: true,
          outFile,
          sourceEvent: report.sourceEvent,
          selectedRapidApiEvent: report.selectedRapidApiEvent,
          providerSummary,
        },
        null,
        2
      )
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
