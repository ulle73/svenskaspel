const https = require('https');

const API_KEY = '3232705f-46ce-41b3-aab8-cab10ab6fab3';
const BASE_URL = 'https://api.www.svenskaspel.se/external/1/draw';
const product = 'topptipset';
const drawNumber = 4177; // historical

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve({ status: res.statusCode, headers: res.headers, data: json });
                } catch (e) {
                    resolve({ status: res.statusCode, headers: res.headers, data: data });
                }
            });
        }).on('error', reject);
    });
}

async function main() {
    console.log("== FORECAST ==");
    const fRes = await fetchJson(`${BASE_URL}/${product}/draws/${drawNumber}/forecast?accesskey=${API_KEY}`);
    const forecast = fRes.data.forecast;
    if (forecast) {
        console.log("Forecast top keys:", Object.keys(forecast));
        console.log("Distribution keys:", Object.keys(forecast.distribution || {}));
        if (forecast.events && forecast.events.length > 0) {
            console.log("First event keys:", Object.keys(forecast.events[0]));
            console.log("First event distribution:", forecast.events[0].distribution);
        }
    }

    console.log("\n== RESULT ==");
    const rRes = await fetchJson(`${BASE_URL}/${product}/draws/${drawNumber}/result?accesskey=${API_KEY}`);
    const result = rRes.data.result;
    if (result) {
        console.log("Result top keys:", Object.keys(result));
        console.log("Distribution keys:", Object.keys(result.distribution || {}));
        if (result.events && result.events.length > 0) {
            console.log("First event keys:", Object.keys(result.events[0]));
            console.log("First event result:", result.events[0].outcome);
        }
    }

    console.log("\n== ERROR HANDLING ==");
    const errRes = await fetchJson(`${BASE_URL}/${product}/draws/999999?accesskey=${API_KEY}`);
    console.log("Future draw status:", errRes.status, "data:", JSON.stringify(errRes.data.error));

    console.log("\n== RATE LIMITING TEST ==");
    // Test a few quick requests to see if headers give rate limit info
    const tasks = [];
    for(let i=0; i<10; i++) {
        tasks.push(fetchJson(`${BASE_URL}/${product}/draws/${drawNumber}?accesskey=${API_KEY}`));
    }
    const results = await Promise.all(tasks);
    console.log("Statuses of 10 rapid requests:", results.map(r => r.status).join(', '));
    // Print headers of first response to see if there's X-Rate-Limit
    const headers = results[0].headers;
    const rateLimitHeaders = Object.keys(headers).filter(k => k.toLowerCase().includes('rate') || k.toLowerCase().includes('limit') || k.toLowerCase().includes('remain'));
    console.log("Rate Limit Headers:", rateLimitHeaders.map(k => `${k}: ${headers[k]}`));
}

main().catch(console.error);
