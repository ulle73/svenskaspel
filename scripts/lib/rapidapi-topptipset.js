const https = require('https');

const RAPIDAPI_BASE_URLS = {
  sportapi7: process.env.RAPIDAPI_SPORTAPI7_BASE_URL || 'https://sportapi7.p.rapidapi.com',
  sofascore: process.env.RAPIDAPI_SOFASCORE_BASE_URL || 'https://sofascore.p.rapidapi.com',
  sportApiRealTime:
    process.env.RAPIDAPI_SPORT_API_REAL_TIME_BASE_URL || 'https://sport-api-real-time.p.rapidapi.com',
  sofascoreSportApi:
    process.env.RAPIDAPI_SOFASCORE_SPORT_API_BASE_URL || 'https://sofascore-sport-api.p.rapidapi.com',
  sofasport: process.env.RAPIDAPI_SOFASPORT_BASE_URL || 'https://sofasport.p.rapidapi.com',
  sofascore6: process.env.RAPIDAPI_SOFASCORE6_BASE_URL || 'https://sofascore6.p.rapidapi.com',
  sofascoreApi4: process.env.RAPIDAPI_SOFASCORE_API4_BASE_URL || 'https://sofascore-api4.p.rapidapi.com',
};

const TEAM_NAME_ALIASES = {
  kanada: ['canada'],
  irland: ['ireland'],
  sverige: ['sweden'],
  norge: ['norway'],
  danmark: ['denmark'],
  finland: ['finland'],
  island: ['iceland'],
  england: ['england'],
  skottland: ['scotland'],
  wales: ['wales'],
  nordirland: ['northern ireland'],
  tyskland: ['germany'],
  frankrike: ['france'],
  spanien: ['spain'],
  portugal: ['portugal'],
  nederlanderna: ['netherlands'],
  belgien: ['belgium'],
  osterrike: ['austria'],
  schweiz: ['switzerland'],
  polen: ['poland'],
  tjeckien: ['czechia', 'czech republic'],
  slovakien: ['slovakia'],
  ungern: ['hungary'],
  kroatien: ['croatia'],
  slovenien: ['slovenia'],
  rumanien: ['romania'],
  bulgarien: ['bulgaria'],
  grekland: ['greece'],
  turkiet: ['turkiye', 'turkey'],
  georgien: ['georgia'],
  armenien: ['armenia'],
  ukraina: ['ukraine'],
  usa: ['usa', 'united states'],
  mexiko: ['mexico'],
  japan: ['japan'],
  sydkorea: ['korea republic', 'south korea'],
  marocko: ['morocco'],
  tunisien: ['tunisia'],
  algeriet: ['algeria'],
  nigeria: ['nigeria'],
  senegal: ['senegal'],
  brasilien: ['brazil'],
  argentina: ['argentina'],
  uruguay: ['uruguay'],
  paraguay: ['paraguay'],
  bolivia: ['bolivia'],
  chile: ['chile'],
  peru: ['peru'],
  colombia: ['colombia'],
  ecuador: ['ecuador'],
  jamaica: ['jamaica'],
  elfenbenskusten: ['ivory coast', 'cote d ivoire'],
  egypten: ['egypt'],
};

const CLUB_STOPWORDS = new Set([
  'fc',
  'if',
  'ifk',
  'bk',
  'fk',
  'sc',
  'ac',
  'cf',
  'afc',
  'club',
  'de',
  'cd',
  'bois',
  'bk',
  'ff',
  'ik',
  'bk',
]);

function parseNumberList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry));
}

function parseRapidApiKeys() {
  const candidates = [
    process.env.RAPIDAPI_KEYS || '',
    process.env.RAPIDAPI_KEY || '',
    ...Array.from({ length: 20 }, (_, index) => process.env[`RAPIDAPI_KEY_${index + 1}`] || ''),
  ];

  const keys = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const normalized = String(candidate || '')
      .replace(/^RAPIDAPI_KEYS?=/, '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    for (const key of normalized) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }

  return keys;
}

function normalizeDatabaseUrl(databaseUrl) {
  const parsed = new URL(databaseUrl);
  if (parsed.searchParams.get('sslmode') === 'require') {
    parsed.searchParams.set('sslmode', 'verify-full');
  }
  return parsed.toString();
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenize(value) {
  return new Set(
    normalizeText(value)
      .split(/\s+/)
      .map(normalizeToken)
      .filter(Boolean)
      .filter((token) => !CLUB_STOPWORDS.has(token))
  );
}

function normalizeToken(value) {
  const token = String(value || '').trim();
  if (!token) {
    return '';
  }

  if (token.length > 4 && token.endsWith('s')) {
    return token.slice(0, -1);
  }

  return token;
}

function buildNameVariants(value) {
  const normalized = normalizeText(value);
  const variants = new Set();

  if (normalized) {
    variants.add(normalized);
    variants.add(normalized.replace(/\s+u\d+$/, '').trim());
  }

  for (const alias of TEAM_NAME_ALIASES[normalized] || []) {
    const aliasNormalized = normalizeText(alias);
    if (aliasNormalized) {
      variants.add(aliasNormalized);
    }
  }

  return [...variants].filter(Boolean);
}

function buildMatchSearchQueries(sourceEvent) {
  const queries = new Set();
  const description = normalizeText(sourceEvent?.description);
  const homeVariants = buildNameVariants(sourceEvent?.home_participant_name).slice(0, 3);
  const awayVariants = buildNameVariants(sourceEvent?.away_participant_name).slice(0, 3);

  if (description) {
    queries.add(description);
  }

  for (const homeVariant of homeVariants) {
    for (const awayVariant of awayVariants) {
      if (homeVariant && awayVariant) {
        queries.add(`${homeVariant} ${awayVariant}`.trim());
      }
    }
  }

  return [...queries].filter(Boolean).slice(0, 10);
}

function scoreNameMatch(left, right) {
  const rightNormalized = normalizeText(right);
  if (!rightNormalized) {
    return 0;
  }

  const leftVariants = buildNameVariants(left);
  if (!leftVariants.length) {
    return 0;
  }

  let bestScore = 0;

  for (const leftVariant of leftVariants) {
    if (leftVariant === rightNormalized) {
      return 1.5;
    }

    const leftTokens = tokenize(leftVariant);
    const rightTokens = tokenize(rightNormalized);
    if (!leftTokens.size || !rightTokens.size) {
      continue;
    }

    const leftTokenList = [...leftTokens];
    const rightTokenList = [...rightTokens];
    const leftIsSubset = leftTokenList.every((token) => rightTokens.has(token));
    const rightIsSubset = rightTokenList.every((token) => leftTokens.has(token));
    if (leftIsSubset || rightIsSubset) {
      bestScore = Math.max(bestScore, 1);
    }

    let overlap = 0;
    for (const token of leftTokenList) {
      if (rightTokens.has(token)) {
        overlap += 1;
      }
    }

    bestScore = Math.max(bestScore, overlap / Math.max(leftTokens.size, rightTokens.size));
  }

  return bestScore;
}

function parseOddsNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
  }

  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }

  if (/^\d+\/\d+$/.test(normalized)) {
    const [numerator, denominator] = normalized.split('/').map((entry) => Number.parseFloat(entry));
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
      return Number((numerator / denominator + 1).toFixed(2));
    }
  }

  const parsed = Number.parseFloat(normalized.replace(/,/g, '.'));
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function keySuffix(value) {
  return value ? `...${String(value).slice(-4)}` : null;
}

function addUtcDays(dateValue, offset) {
  const date = new Date(dateValue);
  date.setUTCDate(date.getUTCDate() + offset);
  return date;
}

function ymdUtc(dateValue) {
  const date = new Date(dateValue);
  return date.toISOString().slice(0, 10);
}

function buildSearchDates(sourceEventStart) {
  const start = new Date(sourceEventStart);
  const dates = [ymdUtc(addUtcDays(start, -1)), ymdUtc(start), ymdUtc(addUtcDays(start, 1))];
  return [...new Set(dates)];
}

function buildPrimarySearchDate(sourceEventStart) {
  return ymdUtc(new Date(sourceEventStart));
}

function buildAdjacentSearchDates(sourceEventStart) {
  const start = new Date(sourceEventStart);
  return [...new Set([ymdUtc(addUtcDays(start, -1)), ymdUtc(addUtcDays(start, 1))])];
}

function summarizeEvent(event) {
  return {
    eventId: event.id,
    slug: event.slug,
    startTimestamp: event.startTimestamp,
    startIso: event.startTimestamp ? new Date(event.startTimestamp * 1000).toISOString() : null,
    tournamentName: event.tournament?.name || null,
    uniqueTournamentName: event.tournament?.uniqueTournament?.name || null,
    uniqueTournamentId: event.tournament?.uniqueTournament?.id || null,
    categoryName: event.tournament?.category?.name || null,
    homeTeamName: event.homeTeam?.name || null,
    awayTeamName: event.awayTeam?.name || null,
    homeTeamId: event.homeTeam?.id || null,
    awayTeamId: event.awayTeam?.id || null,
    national: Boolean(event.homeTeam?.national) && Boolean(event.awayTeam?.national),
    status: event.status?.description || null,
    homeScore: event.homeScore?.current ?? null,
    awayScore: event.awayScore?.current ?? null,
  };
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function buildRapidApiUrl(baseUrl, path) {
  return new URL(String(path || '').replace(/^\/+/, ''), `${trimTrailingSlash(baseUrl)}/`).toString();
}

function appendQueryParams(urlString, query = {}) {
  const url = new URL(urlString);

  for (const [key, value] of Object.entries(query || {})) {
    if (value === null || value === undefined || value === '') {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === null || item === undefined || item === '') {
          continue;
        }
        url.searchParams.append(key, String(item));
      }
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function isEmptyValue(value) {
  if (value === null || value === undefined) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === 'string') {
    return value.trim() === '';
  }
  if (isPlainObject(value)) {
    return Object.keys(value).length === 0;
  }
  return false;
}

function extractEventsFromPayload(payload) {
  const candidates = [
    payload,
    payload?.events,
    payload?.data?.events,
    payload?.data?.matches,
    payload?.matches,
    payload?.data,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function extractEventEnvelope(payload) {
  const candidates = [payload?.event, payload?.data?.event, payload?.data, payload];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) && candidate.id) {
      return { event: candidate };
    }
  }

  return null;
}

function normalizeOddsPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return payload ?? null;
  }

  const candidates = [payload, payload.data, payload.event, payload.results];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }

    if (
      (Array.isArray(candidate.odds) && candidate.odds.length > 0) ||
      (Array.isArray(candidate.bookmakers) && candidate.bookmakers.length > 0) ||
      (Array.isArray(candidate.markets) && candidate.markets.length > 0)
    ) {
      return candidate;
    }
  }

  return payload;
}

function isEmptyOddsPayload(payload) {
  if (!payload) {
    return true;
  }
  if (Array.isArray(payload.odds) && payload.odds.length === 0) {
    return true;
  }
  if (Array.isArray(payload.bookmakers) && payload.bookmakers.length === 0) {
    return true;
  }
  if (Array.isArray(payload.markets) && payload.markets.length === 0) {
    return true;
  }
  return isEmptyValue(payload);
}

function extractMarketsFromPayload(payload) {
  const normalized = normalizeOddsPayload(payload);
  if (Array.isArray(normalized?.markets)) {
    return normalized.markets;
  }
  if (Array.isArray(normalized?.data)) {
    return normalized.data;
  }
  return [];
}

function extractSearchAllItems(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.data)) {
    return payload.data;
  }
  if (Array.isArray(payload?.results)) {
    return payload.results;
  }
  return [];
}

function normalizeSearchAllMatchEntity(entity) {
  if (!entity || typeof entity !== 'object') {
    return null;
  }

  const tournament = entity.tournament && typeof entity.tournament === 'object' ? entity.tournament : {};
  const uniqueTournament =
    (entity.uniqueTournament && typeof entity.uniqueTournament === 'object' ? entity.uniqueTournament : null) ||
    (tournament.uniqueTournament && typeof tournament.uniqueTournament === 'object' ? tournament.uniqueTournament : null);
  const category =
    (uniqueTournament?.category && typeof uniqueTournament.category === 'object' ? uniqueTournament.category : null) ||
    (tournament.category && typeof tournament.category === 'object' ? tournament.category : null);

  return {
    id: entity.id,
    slug: entity.slug || null,
    startTimestamp: Number(entity.startTimestamp ?? entity.timestamp ?? 0) || null,
    status: entity.status || null,
    sport: entity.sport || null,
    tournament: {
      ...tournament,
      category,
      uniqueTournament: uniqueTournament
        ? {
            ...uniqueTournament,
            category: uniqueTournament.category || category || null,
          }
        : null,
    },
    uniqueTournament: uniqueTournament
      ? {
          ...uniqueTournament,
          category: uniqueTournament.category || category || null,
        }
      : null,
    homeTeam: entity.homeTeam || null,
    awayTeam: entity.awayTeam || null,
    homeScore: entity.homeScore || null,
    awayScore: entity.awayScore || null,
  };
}

function extractFootballTeamsFromSearchAll(payload) {
  return extractSearchAllItems(payload)
    .filter((item) => String(item?.type || '').toLowerCase() === 'team')
    .map((item) => item?.entity || null)
    .filter((team) => team && (team?.sport?.id === 1 || String(team?.sport?.slug || '').toLowerCase() === 'football'));
}

function extractFootballMatchesFromSearchAll(payload) {
  return extractSearchAllItems(payload)
    .filter((item) => String(item?.type || '').toLowerCase() === 'match')
    .map((item) => normalizeSearchAllMatchEntity(item?.entity || null))
    .filter(
      (event) => event && (event?.sport?.id === 1 || String(event?.sport?.slug || '').toLowerCase() === 'football')
    );
}

function isLikelyInternationalCompetition(sourceEvent) {
  const country = normalizeText(sourceEvent?.country_name);
  const league = normalizeText(sourceEvent?.league_name);
  if (country === 'internationell') {
    return true;
  }

  return [
    'friendly',
    'nations league',
    'world cup',
    'euro',
    'vm kval',
    'uefa',
    'concacaf',
    'conmebol',
    'fifa',
    'copa america',
  ].some((token) => league.includes(token));
}

function readHasNextPage(payload) {
  const candidates = [payload?.hasNextPage, payload?.data?.hasNextPage];
  return candidates.some((value) => value === true);
}

function httpGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: 'GET',
        headers,
      },
      (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          let parsed = body;
          try {
            parsed = body ? JSON.parse(body) : null;
          } catch (_error) {
            parsed = body;
          }

          resolve({
            status: response.statusCode,
            headers: response.headers,
            data: parsed,
          });
        });
      }
    );

    request.on('error', reject);
    request.end();
  });
}

function buildRapidClient(options = {}) {
  const rapidApiKeys = options.rapidApiKeys || parseRapidApiKeys();
  const baseUrls = {
    ...RAPIDAPI_BASE_URLS,
    ...(options.baseUrls || {}),
  };

  if (!rapidApiKeys.length) {
    throw new Error('Missing RapidAPI credentials. Add RAPIDAPI_KEYS or RAPIDAPI_KEY to .env.');
  }

  const state = { index: 0, calls: 0 };

  async function requestJson(endpoints, params = {}, requestOptions = {}) {
    let lastFailure = null;

    if (!Array.isArray(endpoints) || !endpoints.length) {
      return {
        ok: false,
        status: 0,
        data: null,
        url: null,
        keySuffix: null,
        source: null,
      };
    }

    for (const endpoint of endpoints) {
      if (!endpoint || typeof endpoint.url !== 'function') {
        continue;
      }

      const endpointUrl = endpoint.url(params, baseUrls);
      if (!endpointUrl) {
        continue;
      }

      const finalUrl = appendQueryParams(
        endpointUrl,
        typeof endpoint.query === 'function' ? endpoint.query(params) : endpoint.query
      );
      const host = endpoint.host || new URL(endpointUrl).host;
      const isEmpty = endpoint.isEmpty || isEmptyValue;
      const allowEmpty = endpoint.allowEmpty ?? requestOptions.allowEmpty ?? false;
      const retryStatuses = endpoint.retryStatuses || [403, 404, 429, 500, 502, 503, 504];

      for (let attempt = 0; attempt < rapidApiKeys.length; attempt += 1) {
        const keyIndex = (state.index + attempt) % rapidApiKeys.length;
        const apiKey = rapidApiKeys[keyIndex];
        state.calls += 1;

        try {
          const response = await httpGetJson(finalUrl, {
            'x-rapidapi-key': apiKey,
            'x-rapidapi-host': host,
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
          });

          const transformed =
            typeof endpoint.transform === 'function' ? endpoint.transform(response.data, params) : response.data;

          if (response.status === 200 && (!isEmpty(transformed) || allowEmpty)) {
            state.index = (keyIndex + 1) % rapidApiKeys.length;
            return {
              ok: true,
              status: response.status,
              data: transformed,
              url: finalUrl,
              keySuffix: keySuffix(apiKey),
              source: endpoint.name || finalUrl,
            };
          }

          lastFailure = {
            ok: false,
            status: response.status,
            data: transformed,
            url: finalUrl,
            keySuffix: keySuffix(apiKey),
            source: endpoint.name || finalUrl,
          };
          state.index = (keyIndex + 1) % rapidApiKeys.length;

          if (response.status === 200) {
            continue;
          }

          if (!retryStatuses.includes(response.status)) {
            break;
          }
        } catch (error) {
          lastFailure = {
            ok: false,
            status: 0,
            data: { message: error.message },
            url: finalUrl,
            keySuffix: keySuffix(apiKey),
            source: endpoint.name || finalUrl,
          };
          state.index = (keyIndex + 1) % rapidApiKeys.length;
        }
      }
    }

    return (
      lastFailure || {
        ok: false,
        status: 0,
        data: null,
        url: null,
        keySuffix: null,
        source: null,
      }
    );
  }

  return {
    baseUrl: baseUrls.sportapi7,
    host: new URL(baseUrls.sportapi7).host,
    hosts: baseUrls,
    state,
    async getJson(pathname, query = {}) {
      return requestJson(
        [
          {
            name: 'sportapi7-direct',
            url: (_params, hosts) => buildRapidApiUrl(hosts.sportapi7, pathname),
            query,
            transform: (data) => data,
            allowEmpty: true,
          },
        ],
        {},
        { allowEmpty: true }
      );
    },
    requestJson,
  };
}

async function fetchScheduledEvents(client, date, options = {}) {
  const categoryId = Number(options.categoryId);
  const includeGlobalEndpoint = options.includeGlobalEndpoint !== false;
  const endpoints = [];

  if (includeGlobalEndpoint) {
    endpoints.push(
      {
        name: 'sportapi7-scheduled-events',
        url: (_params, hosts) => buildRapidApiUrl(hosts.sportapi7, `/api/v1/sport/football/scheduled-events/${date}`),
        transform: (data) => extractEventsFromPayload(data),
        allowEmpty: true,
      },
      {
        name: 'sofascore-sport-api-scheduled-events',
        url: (_params, hosts) =>
          buildRapidApiUrl(hosts.sofascoreSportApi, `/api/sport/football/scheduled-events/${date}`),
        transform: (data) => extractEventsFromPayload(data),
        allowEmpty: true,
      }
    );
  }

  if (Number.isFinite(categoryId)) {
    endpoints.push(
      {
        name: 'sofascore-tournament-scheduled-events',
        url: (_params, hosts) => buildRapidApiUrl(hosts.sofascore, '/tournaments/get-scheduled-events'),
        query: () => ({ categoryId, date }),
        transform: (data) => extractEventsFromPayload(data),
        allowEmpty: true,
      },
      {
        name: 'sport-api-real-time-tournament-scheduled-events',
        url: (_params, hosts) => buildRapidApiUrl(hosts.sportApiRealTime, '/tournaments/scheduled-events'),
        query: () => ({ categoryId, date }),
        transform: (data) => extractEventsFromPayload(data),
        allowEmpty: true,
      }
    );
  }

  const response = await client.requestJson(endpoints, {}, { allowEmpty: true });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch RapidAPI scheduled events for ${date}. HTTP ${response.status}: ${JSON.stringify(response.data)}`
    );
  }

  return {
    ...response,
    events: Array.isArray(response.data) ? response.data : extractEventsFromPayload(response.data),
  };
}

async function fetchEventDetails(client, eventId) {
  const response = await client.requestJson(
    [
      {
        name: 'sport-api-real-time-match-details',
        url: (_params, hosts) => buildRapidApiUrl(hosts.sportApiRealTime, '/matches/details'),
        query: () => ({ matchId: eventId }),
        transform: (data) => extractEventEnvelope(data),
      },
      {
        name: 'sportapi7-event-details',
        url: (_params, hosts) => buildRapidApiUrl(hosts.sportapi7, `/api/v1/event/${eventId}`),
        transform: (data) => extractEventEnvelope(data),
      },
      {
        name: 'sofascore-sport-api-event-details',
        url: (_params, hosts) => buildRapidApiUrl(hosts.sofascoreSportApi, `/api/event/${eventId}`),
        transform: (data) => extractEventEnvelope(data),
      },
    ],
    {},
    { allowEmpty: false }
  );

  if (!response.ok || !response.data?.event) {
    throw new Error(`Failed to fetch RapidAPI event ${eventId}. HTTP ${response.status}: ${JSON.stringify(response.data)}`);
  }

  return response;
}

async function fetchProviderOdds(client, eventId, providerId) {
  const response = await client.requestJson(
    [
      {
        name: `sportapi7-odds-${providerId}`,
        url: (_params, hosts) => buildRapidApiUrl(hosts.sportapi7, `/api/v1/event/${eventId}/odds/${providerId}/all`),
        transform: (data) => normalizeOddsPayload(data),
        isEmpty: isEmptyOddsPayload,
      },
      {
        name: `sofascore-sport-api-odds-${providerId}`,
        url: (_params, hosts) =>
          buildRapidApiUrl(hosts.sofascoreSportApi, `/api/event/${eventId}/odds/${providerId}/all`),
        transform: (data) => normalizeOddsPayload(data),
        isEmpty: isEmptyOddsPayload,
      },
      {
        name: `sofasport-odds-${providerId}`,
        url: (_params, hosts) => buildRapidApiUrl(hosts.sofasport, '/v1/events/odds/all'),
        query: () => ({
          event_id: eventId,
          provider_id: providerId,
          odds_format: 'decimal',
        }),
        transform: (data) => normalizeOddsPayload(data),
        isEmpty: isEmptyOddsPayload,
      },
      {
        name: `sofascore-odds-${providerId}`,
        url: (_params, hosts) => buildRapidApiUrl(hosts.sofascore, '/matches/get-all-odds'),
        query: () => ({ matchId: eventId }),
        transform: (data) => normalizeOddsPayload(data),
        isEmpty: isEmptyOddsPayload,
      },
      {
        name: `sport-api-real-time-odds-${providerId}`,
        url: (_params, hosts) => buildRapidApiUrl(hosts.sportApiRealTime, '/matches/all-odds'),
        query: () => ({ matchId: eventId }),
        transform: (data) => normalizeOddsPayload(data),
        isEmpty: isEmptyOddsPayload,
      },
    ],
    {},
    { allowEmpty: false }
  );

  if (!response.ok) {
    return {
      providerId,
      available: false,
      status: response.status,
      data: response.data,
      keySuffix: response.keySuffix,
      url: response.url,
      source: response.source,
      markets: [],
    };
  }

  return {
    providerId,
    available: true,
    status: response.status,
    data: response.data,
    markets: extractMarketsFromPayload(response.data),
    keySuffix: response.keySuffix,
    url: response.url,
    source: response.source,
  };
}

async function searchTeams(client, teamName) {
  const response = await client.requestJson(
    [
      {
        name: 'sofascore6-search-all-team',
        url: (_params, hosts) => buildRapidApiUrl(hosts.sofascore6, '/api/sofascore/v1/search/all'),
        query: () => ({ q: teamName }),
        transform: (data) => extractFootballTeamsFromSearchAll(data),
      },
      {
        name: 'sofascore-team-search',
        url: (_params, hosts) => buildRapidApiUrl(hosts.sofascore, '/teams/search'),
        query: () => ({ name: teamName }),
        transform: (data) => (Array.isArray(data?.teams) ? data.teams : []),
      },
    ],
    {},
    { allowEmpty: false }
  );

  return {
    ...response,
    teams: Array.isArray(response.data) ? response.data : [],
  };
}

async function searchMatches(client, query) {
  const response = await client.requestJson(
    [
      {
        name: 'sofascore6-search-all-match',
        url: (_params, hosts) => buildRapidApiUrl(hosts.sofascore6, '/api/sofascore/v1/search/all'),
        query: () => ({ q: query }),
        transform: (data) => extractFootballMatchesFromSearchAll(data),
      },
    ],
    {},
    { allowEmpty: false }
  );

  return {
    ...response,
    events: Array.isArray(response.data) ? response.data : [],
  };
}

async function fetchTeamLastMatches(client, teamId, pageIndex = 0) {
  const response = await client.requestJson(
    [
      {
        name: 'sport-api-real-time-team-last-matches',
        url: (_params, hosts) => buildRapidApiUrl(hosts.sportApiRealTime, '/teams/last-matches'),
        query: () => ({ teamId, page: pageIndex }),
        transform: (data) => ({
          events: extractEventsFromPayload(data),
          hasNextPage: readHasNextPage(data),
        }),
        isEmpty: (payload) => !Array.isArray(payload?.events) || payload.events.length === 0,
      },
      {
        name: 'sofascore-team-last-matches',
        url: (_params, hosts) => buildRapidApiUrl(hosts.sofascore, '/teams/get-last-matches'),
        query: () => ({ teamId, pageIndex }),
        transform: (data) => ({
          events: extractEventsFromPayload(data),
          hasNextPage: readHasNextPage(data),
        }),
        isEmpty: (payload) => !Array.isArray(payload?.events) || payload.events.length === 0,
      },
    ],
    {},
    { allowEmpty: false }
  );

  return {
    ...response,
    events: Array.isArray(response.data?.events) ? response.data.events : [],
    hasNextPage: response.data?.hasNextPage === true,
  };
}

function rankCandidateEvents(sourceEvent, events) {
  const sourceStartMs = new Date(sourceEvent.sport_event_start).getTime();

  const ranked = events.map((event) => {
    const candidateStartMs = Number(event.startTimestamp || 0) * 1000;
    const minutesDiff = Math.abs(candidateStartMs - sourceStartMs) / 60000;

    const homeScore = scoreNameMatch(sourceEvent.home_participant_name, event.homeTeam?.name || '');
    const awayScore = scoreNameMatch(sourceEvent.away_participant_name, event.awayTeam?.name || '');
    const swappedHomeScore = scoreNameMatch(sourceEvent.home_participant_name, event.awayTeam?.name || '');
    const swappedAwayScore = scoreNameMatch(sourceEvent.away_participant_name, event.homeTeam?.name || '');

    const directScore = homeScore + awayScore;
    const swappedScore = swappedHomeScore + swappedAwayScore;
    const isSwapped = swappedScore > directScore;
    const nameScore = isSwapped ? swappedScore : directScore;

    const directExact = homeScore >= 1.5 && awayScore >= 1.5;
    const swappedExact = swappedHomeScore >= 1.5 && swappedAwayScore >= 1.5;
    const national = Boolean(event.homeTeam?.national) && Boolean(event.awayTeam?.national);
    const youth = /u\d+/i.test(String(event.homeTeam?.name || '')) || /u\d+/i.test(String(event.awayTeam?.name || ''));
    const tournamentName = String(event.tournament?.uniqueTournament?.name || event.tournament?.name || '').toLowerCase();
    const friendlyBoost = tournamentName.includes('friendly') ? 4 : 0;

    const score =
      (directExact ? 1000 : 0) +
      (swappedExact ? 950 : 0) +
      nameScore * 40 -
      Math.min(minutesDiff / 2, 120) +
      (national ? 8 : -8) +
      (youth ? -25 : 0) +
      friendlyBoost;

    return {
      event,
      score,
      minutesDiff,
      national,
      youth,
      isSwapped,
      directExact,
      swappedExact,
      nameScore,
    };
  });

  ranked.sort((left, right) => right.score - left.score);
  return ranked;
}

function isConfidentCandidate(candidate) {
  if (!candidate) {
    return false;
  }

  if ((candidate.directExact || candidate.swappedExact) && candidate.minutesDiff <= 180 && !candidate.youth) {
    return true;
  }

  return candidate.nameScore >= 2 && candidate.minutesDiff <= 30 && !candidate.youth;
}

function rankTeamSearchResults(sourceEvent, teamName, teams) {
  const preferNational = isLikelyInternationalCompetition(sourceEvent);

  return (teams || [])
    .filter((team) => team?.sport?.id === 1 || String(team?.sport?.slug || '').toLowerCase() === 'football')
    .map((team) => ({
      team,
      score: scoreNameMatch(teamName, team.name || ''),
      national: Boolean(team?.national),
    }))
    .filter((entry) => entry.score > 0.75)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (preferNational && left.national !== right.national) {
        return left.national ? -1 : 1;
      }
      if (!preferNational && left.national !== right.national) {
        return left.national ? 1 : -1;
      }
      return Number(left.team?.id || 0) - Number(right.team?.id || 0);
    });
}

async function getCachedPromise(cache, key, factory) {
  if (!cache.has(key)) {
    cache.set(key, Promise.resolve().then(factory));
  }
  return cache.get(key);
}

async function findTeamCandidates(client, sourceEvent, teamName, cache) {
  const lookups = [];
  const merged = new Map();

  for (const query of buildNameVariants(teamName).slice(0, 4)) {
    const response = await getCachedPromise(cache, query, () => searchTeams(client, query));
    lookups.push({
      strategy: 'team-search',
      query,
      source: response.source || null,
      url: response.url || null,
      keySuffix: response.keySuffix || null,
      candidateCount: response.teams.length,
    });

    for (const entry of rankTeamSearchResults(sourceEvent, teamName, response.teams).slice(0, 5)) {
      const existing = merged.get(entry.team.id);
      if (!existing || entry.score > existing.score) {
        merged.set(entry.team.id, entry);
      }
    }
  }

  return {
    lookups,
    candidates: [...merged.values()].sort((left, right) => right.score - left.score).slice(0, 4),
  };
}

async function findDirectMatchCandidates(client, sourceEvent, cache) {
  const lookups = [];
  const merged = new Map();

  for (const query of buildMatchSearchQueries(sourceEvent)) {
    const response = await getCachedPromise(cache, query, () => searchMatches(client, query));
    lookups.push({
      strategy: 'match-search',
      query,
      source: response.source || null,
      url: response.url || null,
      keySuffix: response.keySuffix || null,
      candidateCount: response.events.length,
    });

    for (const candidate of rankCandidateEvents(sourceEvent, response.events).slice(0, 8)) {
      const existing = merged.get(candidate.event.id);
      if (!existing || candidate.score > existing.score) {
        merged.set(candidate.event.id, candidate.event);
      }
    }
  }

  return {
    lookups,
    events: [...merged.values()],
  };
}

async function loadTeamHistoryAroundDate(client, teamId, sourceStartMs, cache, options = {}) {
  const maxPages = Number(options.maxPages) || 8;
  const minStartMs = sourceStartMs - 3 * 24 * 60 * 60 * 1000;
  const maxStartMs = sourceStartMs + 3 * 24 * 60 * 60 * 1000;
  const events = [];
  const sources = new Set();
  let pagesFetched = 0;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const cacheKey = `${teamId}:${pageIndex}`;
    const response = await getCachedPromise(cache, cacheKey, () => fetchTeamLastMatches(client, teamId, pageIndex));
    pagesFetched += 1;

    if (response.source) {
      sources.add(response.source);
    }

    if (!response.ok || !response.events.length) {
      break;
    }

    const pageTimestamps = [];
    for (const event of response.events) {
      const eventStartMs = Number(event.startTimestamp || 0) * 1000;
      if (Number.isFinite(eventStartMs) && eventStartMs > 0) {
        pageTimestamps.push(eventStartMs);
      }
      if (eventStartMs >= minStartMs && eventStartMs <= maxStartMs) {
        events.push(event);
      }
    }

    if (!pageTimestamps.length) {
      break;
    }

    const oldestTimestamp = Math.min(...pageTimestamps);
    if (oldestTimestamp < minStartMs || response.hasNextPage !== true) {
      break;
    }
  }

  return {
    events,
    pagesFetched,
    source: sources.size ? [...sources].join(',') : null,
  };
}

async function findRapidApiCandidatesForSourceEvent(client, sourceEvent, cache = {}) {
  const scheduledCache = cache.scheduledCache || new Map();
  const directMatchSearchCache = cache.directMatchSearchCache || new Map();
  const teamSearchCache = cache.teamSearchCache || new Map();
  const teamMatchesCache = cache.teamMatchesCache || new Map();
  const searchWindow = [];
  const eventsById = new Map();
  let strategy = 'unmapped';

  if (!sourceEvent.sport_event_start) {
    return {
      strategy: 'missing_start_time',
      searchWindow,
      rankedCandidates: [],
      selectedCandidate: null,
      candidateEvents: [],
    };
  }

  const directMatchCandidates = await findDirectMatchCandidates(client, sourceEvent, directMatchSearchCache);
  searchWindow.push(...directMatchCandidates.lookups);

  for (const event of directMatchCandidates.events) {
    if (!eventsById.has(event.id)) {
      eventsById.set(event.id, event);
    }
  }

  let rankedCandidates = rankCandidateEvents(sourceEvent, [...eventsById.values()]);
  let selectedCandidate = rankedCandidates[0] || null;

  if (directMatchCandidates.events.length) {
    strategy = 'match-search';
  }

  if (isConfidentCandidate(selectedCandidate)) {
    return {
      strategy: 'match-search',
      searchWindow,
      rankedCandidates,
      selectedCandidate,
      candidateEvents: [...eventsById.values()],
    };
  }

  for (const date of buildSearchDates(sourceEvent.sport_event_start)) {
    try {
      const response = await getCachedPromise(scheduledCache, date, () => fetchScheduledEvents(client, date));
      searchWindow.push({
        strategy: 'scheduled',
        date,
        source: response.source || null,
        url: response.url || null,
        keySuffix: response.keySuffix || null,
        eventCount: response.events.length,
      });

      for (const event of response.events) {
        if (!eventsById.has(event.id)) {
          eventsById.set(event.id, event);
        }
      }
    } catch (error) {
      searchWindow.push({
        strategy: 'scheduled',
        date,
        source: null,
        url: null,
        keySuffix: null,
        eventCount: 0,
        error: error.message,
      });
    }
  }

  rankedCandidates = rankCandidateEvents(sourceEvent, [...eventsById.values()]);
  selectedCandidate = rankedCandidates[0] || null;

  if (isConfidentCandidate(selectedCandidate)) {
    return {
      strategy: 'scheduled',
      searchWindow,
      rankedCandidates,
      selectedCandidate,
      candidateEvents: [...eventsById.values()],
    };
  }

  const sourceStartMs = new Date(sourceEvent.sport_event_start).getTime();
  const teamEntries = [
    { role: 'home', teamName: sourceEvent.home_participant_name },
    { role: 'away', teamName: sourceEvent.away_participant_name },
  ];

  for (const teamEntry of teamEntries) {
    const teamCandidates = await findTeamCandidates(client, sourceEvent, teamEntry.teamName, teamSearchCache);
    searchWindow.push(
      ...teamCandidates.lookups.map((lookup) => ({
        ...lookup,
        role: teamEntry.role,
      }))
    );

    for (const candidate of teamCandidates.candidates.slice(0, 3)) {
      const history = await loadTeamHistoryAroundDate(client, candidate.team.id, sourceStartMs, teamMatchesCache);
      searchWindow.push({
        strategy: 'team-history',
        role: teamEntry.role,
        teamId: candidate.team.id,
        teamName: candidate.team.name,
        source: history.source,
        pagesFetched: history.pagesFetched,
        eventCount: history.events.length,
      });

      for (const event of history.events) {
        if (!eventsById.has(event.id)) {
          eventsById.set(event.id, event);
        }
      }

      if (history.events.length) {
        strategy = 'team-history';
      }

      rankedCandidates = rankCandidateEvents(sourceEvent, [...eventsById.values()]);
      selectedCandidate = rankedCandidates[0] || null;

      if (isConfidentCandidate(selectedCandidate)) {
        return {
          strategy: 'team-history',
          searchWindow,
          rankedCandidates,
          selectedCandidate,
          candidateEvents: [...eventsById.values()],
        };
      }
    }
  }

  rankedCandidates = rankCandidateEvents(sourceEvent, [...eventsById.values()]);
  selectedCandidate = rankedCandidates[0] || null;

  return {
    strategy: eventsById.size ? strategy : 'unmapped',
    searchWindow,
    rankedCandidates,
    selectedCandidate,
    candidateEvents: [...eventsById.values()],
  };
}

function flipOutcome(value) {
  if (value === 'home') {
    return 'away';
  }
  if (value === 'away') {
    return 'home';
  }
  return value;
}

function maybeSwapThreeWayOdds(threeWay, isSwapped) {
  if (!threeWay || !isSwapped) {
    return threeWay;
  }

  return {
    ...threeWay,
    opening: {
      home: threeWay.opening.away,
      draw: threeWay.opening.draw,
      away: threeWay.opening.home,
    },
    closing: {
      home: threeWay.closing.away,
      draw: threeWay.closing.draw,
      away: threeWay.closing.home,
    },
    winner: flipOutcome(threeWay.winner),
    sourceOrientation: 'swapped',
  };
}

function extractThreeWayOdds(markets, options = {}) {
  const matchResultMarket = (markets || []).find(
    (market) =>
      market.marketGroup === '1X2' &&
      market.marketPeriod === 'Full-time' &&
      Number(market.marketId) === 1 &&
      Array.isArray(market.choices)
  );

  if (!matchResultMarket) {
    return null;
  }

  const opening = { home: null, draw: null, away: null };
  const closing = { home: null, draw: null, away: null };
  let winner = null;

  for (const choice of matchResultMarket.choices) {
    const label = String(choice.name || '').trim();
    let outcomeType = null;
    if (label === '1') {
      outcomeType = 'home';
    } else if (label === 'X') {
      outcomeType = 'draw';
    } else if (label === '2') {
      outcomeType = 'away';
    }

    if (!outcomeType) {
      continue;
    }

    opening[outcomeType] = parseOddsNumber(choice.initialFractionalValue);
    closing[outcomeType] = parseOddsNumber(choice.fractionalValue);
    if (choice.winning === true) {
      winner = outcomeType;
    }
  }

  const threeWay = {
    marketId: matchResultMarket.marketId,
    marketName: matchResultMarket.marketName,
    marketGroup: matchResultMarket.marketGroup,
    marketPeriod: matchResultMarket.marketPeriod,
    opening,
    closing,
    winner,
    sourceOrientation: 'native',
    rawChoices: matchResultMarket.choices,
  };

  return maybeSwapThreeWayOdds(threeWay, Boolean(options.isSwapped));
}

function isoOrNull(value) {
  return value ? new Date(value).toISOString() : null;
}

function getProviderBetRadarId(providerIds) {
  if (!Array.isArray(providerIds)) {
    return null;
  }

  const betRadar = providerIds.find((provider) => String(provider.provider).toLowerCase() === 'betradar');
  return betRadar ? Number(betRadar.id) : null;
}

module.exports = {
  RAPIDAPI_BASE_URLS,
  buildRapidApiUrl,
  buildRapidClient,
  buildSearchDates,
  extractThreeWayOdds,
  fetchEventDetails,
  fetchProviderOdds,
  fetchScheduledEvents,
  fetchTeamLastMatches,
  findRapidApiCandidatesForSourceEvent,
  getProviderBetRadarId,
  isConfidentCandidate,
  isoOrNull,
  normalizeDatabaseUrl,
  parseNumberList,
  parseOddsNumber,
  parseRapidApiKeys,
  rankCandidateEvents,
  scoreNameMatch,
  searchTeams,
  summarizeEvent,
};
