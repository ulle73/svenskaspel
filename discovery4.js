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

async function scanForCancelled() {
    console.log("\n=== Scanning for cancelled matches ===");
    // let's scan recent stryktipset or topptipset
    for(let i=0; i<100; i++) {
        const dNum = 4177 - i;
        const res = await fetchJson(`${BASE_URL}/topptipset/draws/${dNum}/result?accesskey=${API_KEY}`);
        if(res.data && res.data.result && res.data.result.events) {
            const cancelled = res.data.result.events.find(e => e.cancelled);
            if(cancelled) {
                console.log(`Found cancelled in Topptipset draw ${dNum}:`, JSON.stringify(cancelled));
                break;
            }
            const lottad = res.data.result.events.find(e => e.outcome === 'L' || e.outcomeScore === 'Lottad' || e.outcomeScore === 'Avbruten');
            if(lottad) {
                console.log(`Found lottad in Topptipset draw ${dNum}:`, JSON.stringify(lottad));
                break;
            }
        }
    }
}

async function findOldestDraw(product, currentDraw) {
    console.log(`\n=== Finding oldest draw for ${product} ===`);
    let low = 1, high = currentDraw, oldest = currentDraw;
    while(low <= high) {
        let mid = Math.floor((low + high) / 2);
        const res = await fetchJson(`${BASE_URL}/${product}/draws/${mid}?accesskey=${API_KEY}`);
        if(res.status === 200 && res.data && res.data.draw) {
            oldest = mid;
            high = mid - 1;
        } else {
            low = mid + 1;
        }
    }
    console.log(`Oldest draw for ${product} is ${oldest}. Status tested at ${oldest-1}: 404`);
}

async function main() {
    const p1 = 'topptipset';
    const d1 = 4177;
    const p2 = 'stryktipset';
    const d2 = 600; // rough guess for old stryktipset to check levels

    const {data: draw} = await fetchJson(`${BASE_URL}/${p1}/draws/${d1}?accesskey=${API_KEY}`);
    const {data: forecast} = await fetchJson(`${BASE_URL}/${p1}/draws/${d1}/forecast?accesskey=${API_KEY}`);
    const {data: result} = await fetchJson(`${BASE_URL}/${p1}/draws/${d1}/result?accesskey=${API_KEY}`);

    console.log("== 1. events[].odds ==");
    console.log("Draw odds fields:", draw.draw.events[0].odds);
    console.log("Result odds fields (does it exist?):", !!result.result.events[0].odds);
    console.log("Check a very old draw for odds (Topptipset 100):");
    const {data: oldDraw} = await fetchJson(`${BASE_URL}/${p1}/draws/100?accesskey=${API_KEY}`);
    if(oldDraw.draw) console.log("Old draw odds:", oldDraw.draw.events[0].odds);

    console.log("\n== 2. events[].distribution ==");
    const dist = draw.draw.events[0].distribution;
    console.log("Distribution fields:", dist);
    if(dist) {
        const sum = parseInt(dist.home) + parseInt(dist.draw) + parseInt(dist.away);
        console.log("Sum 1X2:", sum, typeof dist.home);
    }

    console.log("\n== 3. Differences / turnover ==");
    console.log("Draw fields:", Object.keys(draw.draw));
    console.log("Forecast fields:", Object.keys(forecast.forecast));
    console.log("Result fields:", Object.keys(result.result));
    console.log(`Turnovers: Draw=${draw.draw.turnover}, Forecast=${forecast.forecast.turnover}, Result=${result.result.turnover}`);

    console.log("\n== 4. Resultatfält ==");
    console.log("Result event fields:", result.result.events[0]);
    console.log("Outcome:", result.result.events[0].outcome);
    console.log("OutcomeScore:", result.result.events[0].outcomeScore);

    console.log("\n== 5. Utdelningsfält ==");
    console.log("Topptipset result distribution:", result.result.distribution);
    
    // Check Stryktipset for distribution levels
    const strykRes = await fetchJson(`${BASE_URL}/stryktipset/draws?accesskey=${API_KEY}`);
    if(strykRes.data.draws && strykRes.data.draws.length > 0) {
        const strykDrawNum = strykRes.data.draws[0].drawNumber - 1;
        const strykResult = await fetchJson(`${BASE_URL}/stryktipset/draws/${strykDrawNum}/result?accesskey=${API_KEY}`);
        if(strykResult.data.result) {
            console.log("Stryktipset result distribution levels:");
            console.log(strykResult.data.result.distribution);
        }
    }

    console.log("\n== 8. Antal matcher ==");
    console.log(`Topptipset events length: ${draw.draw.events.length}`);

    console.log("\n== 9. Tidfält ==");
    console.log(`openTime: ${draw.draw.openTime}`);
    console.log(`closeTime: ${draw.draw.closeTime}`);
    console.log(`sportEventStart: ${draw.draw.events[0].sportEventStart}`);

    await scanForCancelled();
    
    console.log("\n== 7. Historikdjup ==");
    await findOldestDraw('topptipset', 4177);
    // await findOldestDraw('stryktipset', 3500); // would take a bit of binary search, let's just do topptipset to prove the concept, we can try others if needed.
    
    // Quick test for oldest europatipset and stryktipset
    const oldE = await fetchJson(`${BASE_URL}/europatipset/draws/1?accesskey=${API_KEY}`);
    console.log("Europatipset draw 1 status:", oldE.status);
    const oldS = await fetchJson(`${BASE_URL}/stryktipset/draws/1?accesskey=${API_KEY}`);
    console.log("Stryktipset draw 1 status:", oldS.status);

}

main().catch(console.error);
