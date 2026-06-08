const https = require('https');

const API_KEY = '3232705f-46ce-41b3-aab8-cab10ab6fab3';
const BASE_URL = 'https://api.www.svenskaspel.se/external/1/draw';

function fetchJson(url) {
    return new Promise((resolve) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch(e) {
                    resolve({ status: res.statusCode, data: {} });
                }
            });
        }).on('error', () => resolve({ status: 500, data: {} }));
    });
}

async function findFirstOdds(product, low, high) {
    let firstOdds = null;
    let originalLow = low;
    let originalHigh = high;
    while(low <= high) {
        let mid = Math.floor((low + high) / 2);
        const res = await fetchJson(`${BASE_URL}/${product}/draws/${mid}?accesskey=${API_KEY}`);
        
        let hasOdds = false;
        if(res.status === 200 && res.data && res.data.draw && res.data.draw.events) {
            hasOdds = res.data.draw.events.some(e => e.odds !== null);
        }
        
        if(hasOdds) {
            firstOdds = mid;
            high = mid - 1; // look for earlier
        } else {
            low = mid + 1; // look for later
        }
    }
    console.log(`First odds for ${product} starts around draw ${firstOdds}`);
}

async function main() {
    console.log("== 4. First draw with odds ==");
    await findFirstOdds('topptipset', 78, 4178);
    await findFirstOdds('topptipsetstryk', 273, 500);
    await findFirstOdds('topptipseteuropa', 481, 1840);
    await findFirstOdds('stryktipset', 3500, 3700); // adjust current to rough max if unknown
    await findFirstOdds('europatipset', 1221, 2581);

    console.log("\n== Row Cost Info ==");
    const currentT = await fetchJson(`${BASE_URL}/topptipset/draws?accesskey=${API_KEY}`);
    const currentS = await fetchJson(`${BASE_URL}/stryktipset/draws/3500?accesskey=${API_KEY}`); // old draw just to check
    console.log("Topptipset fund/rowPrice:", JSON.stringify(currentT.data.draws ? currentT.data.draws[0].fund : 'none'));
    if (currentS.data && currentS.data.draw) console.log("Stryktipset fund/rowPrice:", JSON.stringify(currentS.data.draw.fund));

    console.log("\n== Sample JSON Extracts ==");
    // Get Topptipset 4177 for sample
    const d1 = await fetchJson(`${BASE_URL}/topptipset/draws/4177?accesskey=${API_KEY}`);
    const f1 = await fetchJson(`${BASE_URL}/topptipset/draws/4177/forecast?accesskey=${API_KEY}`);
    const r1 = await fetchJson(`${BASE_URL}/topptipset/draws/4177/result?accesskey=${API_KEY}`);

    if (d1.data && d1.data.draw) {
        let sd = d1.data.draw;
        sd.events = [sd.events[0]]; // keep only 1 event
        console.log("DRAW JSON:");
        console.log(JSON.stringify(sd, null, 2));
    }

    if (f1.data && f1.data.forecast) {
        let sf = f1.data.forecast;
        if(sf.events) sf.events = [sf.events[0]];
        console.log("FORECAST JSON:");
        console.log(JSON.stringify(sf, null, 2));
    }

    if (r1.data && r1.data.result) {
        let sr = r1.data.result;
        if(sr.events) sr.events = [sr.events[0]];
        console.log("RESULT JSON:");
        console.log(JSON.stringify(sr, null, 2));
    }
}

main().catch(console.error);
