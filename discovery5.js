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

async function findOldestDraw(product, currentDraw) {
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
    console.log(`Oldest draw for ${product} is ${oldest}`);
}

async function main() {
    console.log("== 7. Historikdjup (Binary search all) ==");
    await findOldestDraw('topptipset', 4178);
    await findOldestDraw('topptipsetstryk', 500); // rough guess for current
    await findOldestDraw('topptipseteuropa', 1840);
    await findOldestDraw('stryktipset', 3500);
    await findOldestDraw('europatipset', 2581);

    console.log("\n== 5. Stryktipset/Europatipset utdelningsnivåer ==");
    const strykResult = await fetchJson(`${BASE_URL}/europatipset/draws/2580/result?accesskey=${API_KEY}`);
    if(strykResult.data.result) {
        console.log("Europatipset result distribution:", strykResult.data.result.distribution);
    }
}

main().catch(console.error);
