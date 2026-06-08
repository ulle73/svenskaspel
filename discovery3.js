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
                const json = JSON.parse(data);
                resolve({ data: json });
            });
        });
    });
}

async function main() {
    const dRes = await fetchJson(`${BASE_URL}/${product}/draws/${drawNumber}?accesskey=${API_KEY}`);
    const draw = dRes.data.draw;
    if (draw && draw.events && draw.events.length > 0) {
        console.log("Historical Draw event distribution (streck):", draw.events[0].distribution);
    }
    
    const fRes = await fetchJson(`${BASE_URL}/${product}/draws/${drawNumber}/forecast?accesskey=${API_KEY}`);
    const forecast = fRes.data.forecast;
    if (forecast && forecast.distribution) {
         console.log("Forecast root distribution (utdelning):", forecast.distribution);
    }

    const rRes = await fetchJson(`${BASE_URL}/${product}/draws/${drawNumber}/result?accesskey=${API_KEY}`);
    const result = rRes.data.result;
    if (result && result.distribution) {
         console.log("Result root distribution (utdelning):", result.distribution);
    }
}

main().catch(console.error);
