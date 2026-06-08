const https = require('https');

const API_KEY = '3232705f-46ce-41b3-aab8-cab10ab6fab3';
const BASE_URL = 'https://api.www.svenskaspel.se/external/1/draw';
const PRODUCTS = ['topptipset', 'topptipsetstryk', 'topptipseteuropa', 'stryktipset', 'europatipset'];

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve({ status: res.statusCode, data: json });
                } catch (e) {
                    resolve({ status: res.statusCode, data: data });
                }
            });
        }).on('error', reject);
    });
}

async function testProduct(product) {
    console.log(`\n=== Testing Product: ${product} ===`);
    
    // 1. Current draws
    const currentDrawsUrl = `${BASE_URL}/${product}/draws?accesskey=${API_KEY}`;
    const { status: statusDraws, data: currentDraws } = await fetchJson(currentDrawsUrl);
    console.log(`[GET /draws] status: ${statusDraws}`);
    
    if (!currentDraws.draws || currentDraws.draws.length === 0) {
        console.log(`No current draws found for ${product}.`);
        return;
    }

    const currentDraw = currentDraws.draws[0];
    const drawNumber = currentDraw.drawNumber;
    console.log(`Current drawNumber: ${drawNumber}`);
    console.log(`Available fields in /draws: ${Object.keys(currentDraw).join(', ')}`);

    // test /draws/upcoming
    const upcomingUrl = `${BASE_URL}/${product}/draws/upcoming?accesskey=${API_KEY}`;
    const { status: upcomingStatus } = await fetchJson(upcomingUrl);
    console.log(`[GET /draws/upcoming] status: ${upcomingStatus}`);

    // test /draws/result
    const resultUrl = `${BASE_URL}/${product}/draws/result?accesskey=${API_KEY}`;
    const { status: resultStatus } = await fetchJson(resultUrl);
    console.log(`[GET /draws/result] status: ${resultStatus}`);
    
    // Test historical
    const historicalOffsets = [1, 2, 10, 100, 500, 1000];
    for (const offset of historicalOffsets) {
        const testDraw = drawNumber - offset;
        const testUrl = `${BASE_URL}/${product}/draws/${testDraw}?accesskey=${API_KEY}`;
        const { status, data } = await fetchJson(testUrl);
        if (status === 200 && data.draw) {
            console.log(`Historical /draws/${testDraw} (-${offset}) works!`);
        } else {
            console.log(`Historical /draws/${testDraw} (-${offset}) FAILED! Status: ${status}, Error: ${JSON.stringify(data.error || data)}`);
        }
    }

    // Deep dive into -1 (recent historical)
    const recentDraw = drawNumber - 1;
    const { status: rStatus, data: rData } = await fetchJson(`${BASE_URL}/${product}/draws/${recentDraw}?accesskey=${API_KEY}`);
    console.log(`[GET /draws/${recentDraw}] status: ${rStatus}`);
    
    const { status: fStatus, data: fData } = await fetchJson(`${BASE_URL}/${product}/draws/${recentDraw}/forecast?accesskey=${API_KEY}`);
    console.log(`[GET /draws/${recentDraw}/forecast] status: ${fStatus}`);
    if (fData.forecast) {
         console.log(`Forecast fields: ${Object.keys(fData.forecast).join(', ')}`);
    }

    const { status: resStatus, data: resData } = await fetchJson(`${BASE_URL}/${product}/draws/${recentDraw}/result?accesskey=${API_KEY}`);
    console.log(`[GET /draws/${recentDraw}/result] status: ${resStatus}`);
    if (resData.result) {
         console.log(`Result fields: ${Object.keys(resData.result).join(', ')}`);
    }
}

async function main() {
    for (const product of PRODUCTS) {
        await testProduct(product);
    }
}

main().catch(console.error);
