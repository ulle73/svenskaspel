require('dotenv').config();
const https = require('https');
const Database = require('better-sqlite3');
const path = require('path');

// ---------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------
const API_KEY = process.env.SVENSKA_SPEL_API_NYCKEL;
if (!API_KEY) {
    console.error("FATAL: SVENSKA_SPEL_API_NYCKEL saknas i .env");
    process.exit(1);
}

const BASE_URL = 'https://api.www.svenskaspel.se/external/1/draw';
const DB_PATH = path.join(__dirname, 'raw_data.db');

const PRODUCTS = [
  {
    id: "topptipset",
    enabled: true,
    oldestDrawNumber: 78
  },
  {
    id: "topptipsetstryk",
    enabled: false,
    oldestDrawNumber: 273
  },
  {
    id: "topptipseteuropa",
    enabled: false,
    oldestDrawNumber: 481
  },
  {
    id: "stryktipset",
    enabled: false,
    oldestDrawNumber: 3500
  },
  {
    id: "europatipset",
    enabled: false,
    oldestDrawNumber: 1221
  }
];

const DELAY_MS = 200;
const MAX_RETRIES = 3;

// ---------------------------------------------------------
// DATABASE INIT
// ---------------------------------------------------------
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS raw_responses (
    product TEXT,
    drawNumber INTEGER,
    endpointType TEXT,
    fetchedAt TEXT,
    httpStatus INTEGER,
    success INTEGER,
    error TEXT,
    rawResponse TEXT,
    PRIMARY KEY (product, drawNumber, endpointType)
  );
`);

const insertStmt = db.prepare(`
  INSERT OR REPLACE INTO raw_responses 
  (product, drawNumber, endpointType, fetchedAt, httpStatus, success, error, rawResponse)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const checkStmt = db.prepare(`
  SELECT httpStatus, success FROM raw_responses 
  WHERE product = ? AND drawNumber = ? AND endpointType = ?
`);

// ---------------------------------------------------------
// HTTP HELPERS
// ---------------------------------------------------------
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed = null;
                if (data) {
                    try {
                        parsed = JSON.parse(data);
                    } catch (e) {
                        // Keep raw if JSON parse fails
                        parsed = data;
                    }
                }
                resolve({ status: res.statusCode, data: parsed });
            });
        }).on('error', reject);
    });
}

async function fetchWithRetry(url, retries = MAX_RETRIES) {
    for (let i = 0; i <= retries; i++) {
        try {
            const result = await fetchJson(url);
            // Retry on 5xx errors or 429
            if (result.status >= 500 || result.status === 429) {
                console.warn(`[HTTP ${result.status}] Temporary error, retrying... (${i + 1}/${retries})`);
                await delay(DELAY_MS * 5);
                continue;
            }
            return result;
        } catch (err) {
            console.error(`[Network Error] ${err.message}, retrying... (${i + 1}/${retries})`);
            if (i === retries) throw err;
            await delay(DELAY_MS * 5);
        }
    }
    throw new Error("Max retries exceeded");
}

// ---------------------------------------------------------
// IMPORT LOGIC
// ---------------------------------------------------------
async function getCurrentDrawNumber(product) {
    const url = `${BASE_URL}/${product}/draws?accesskey=${API_KEY}`;
    const result = await fetchWithRetry(url);
    if (result.status === 200 && result.data && result.data.draws && result.data.draws.length > 0) {
        return result.data.draws[0].drawNumber;
    }
    throw new Error(`Failed to get current drawNumber for ${product}. Status: ${result.status}`);
}

async function importEndpoint(product, drawNumber, endpointType) {
    // Check if already fetched and valid (Success or known 404)
    const existing = checkStmt.get(product, drawNumber, endpointType);
    if (existing) {
        if (existing.success === 1 || existing.httpStatus === 404) {
            // Already safely imported or confirmed missing
            return;
        }
    }

    let urlSuffix = '';
    if (endpointType === 'forecast') urlSuffix = '/forecast';
    else if (endpointType === 'result') urlSuffix = '/result';

    const url = `${BASE_URL}/${product}/draws/${drawNumber}${urlSuffix}?accesskey=${API_KEY}`;
    
    await delay(DELAY_MS); // Throttle
    
    try {
        const { status, data } = await fetchWithRetry(url);
        const fetchedAt = new Date().toISOString();
        let success = status === 200 ? 1 : 0;
        let errorObj = null;
        let rawResponse = null;

        if (status === 200) {
            rawResponse = JSON.stringify(data);
        } else {
            errorObj = typeof data === 'object' ? JSON.stringify(data.error || data) : data;
            if (status === 404) {
                // Not an execution failure, just missing data (e.g. very old draw)
                console.log(`[404] ${product} #${drawNumber} [${endpointType}] Not found.`);
            } else {
                console.warn(`[${status}] ${product} #${drawNumber} [${endpointType}] Error: ${errorObj}`);
            }
        }

        insertStmt.run(
            product,
            drawNumber,
            endpointType,
            fetchedAt,
            status,
            success,
            errorObj,
            rawResponse
        );

    } catch (err) {
        console.error(`FATAL ERROR fetching ${product} #${drawNumber} [${endpointType}]:`, err.message);
        // We don't save hard network crashes to DB so it can be retried next run
    }
}

async function run() {
    console.log("=== STARTING RAW IMPORT ===");
    for (const config of PRODUCTS) {
        if (!config.enabled) {
            console.log(`Skipping disabled product: ${config.id}`);
            continue;
        }

        console.log(`\nInitializing import for: ${config.id}`);
        try {
            const currentDraw = await getCurrentDrawNumber(config.id);
            console.log(`Current drawNumber: ${currentDraw}. Target oldest: ${config.oldestDrawNumber}`);

            for (let d = currentDraw; d >= config.oldestDrawNumber; d--) {
                process.stdout.write(`\rImporting ${config.id} draw ${d}... `);
                
                await importEndpoint(config.id, d, 'draw');
                await importEndpoint(config.id, d, 'forecast');
                await importEndpoint(config.id, d, 'result');
                
                // Visual checkpoint feedback for the user
                if (d % 10 === 0) {
                    process.stdout.write(`\n[Checkpoint] Progress for ${config.id} safely stored to disk down to draw ${d}.\n`);
                }
            }
            console.log(`\nFinished import for ${config.id}!`);

        } catch (err) {
            console.error(`\nFailed to process product ${config.id}: ${err.message}`);
        }
    }
    
    // Quick summary
    const count = db.prepare(`SELECT count(*) as c FROM raw_responses`).get().c;
    const errors = db.prepare(`SELECT count(*) as c FROM raw_responses WHERE success = 0`).get().c;
    console.log(`\n=== IMPORT SUMMARY ===`);
    console.log(`Total records in DB: ${count}`);
    console.log(`Total 404/errors in DB: ${errors}`);
}

run();
