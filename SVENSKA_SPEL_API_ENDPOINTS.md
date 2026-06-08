# Svenska Spel API Discovery - Poolspel

## Slutsats och Svar på Kritiska Frågor

* **Kan vi bygga historisk databas från API:t?** Ja! Historiken går minst 1000 omgångar bakåt för samtliga produkter och endpoints fungerar utmärkt historiskt via sekventiella `drawNumber`.
* **Kan vi få historiska streck/forecast bakåt i tiden?** Ja, streckfördelningen sparas historiskt (i `/draws/{drawNumber}`). Även utdelningsprognos (`/forecast`) och slutligt resultat (`/result`) sparas.
* **Måste vi börja spara egna snapshots framåt?** För att backtesta behövs inga snapshots eftersom Svenska Spel sparar slutlig streckfördelning och odds historiskt! Men, om ni vill ha **utvecklingen** av strecken (hur strecken såg ut *innan* spelstopp, t.ex. 1h före), så måste ni bygga egna snapshots i realtid, eftersom API:t enbart returnerar senaste status för en historisk omgång.
* **Vilken produkt är bäst att börja med?** `topptipset` är bäst för MVP. Det har dragningar varje dag, omgångarna är kortare (8 matcher) och datan är tydlig och robust.
* **Vilka endpoints krävs för MVP?** 
  - `/draws` (för att hitta aktuellt drawNumber)
  - `/draws/{drawNumber}` (för odds och streckfördelning)
  - `/draws/{drawNumber}/result` (för matchresultat, utdelning och rätt rad)
* **Vilka osäkerheter finns kvar?** Rate limits verkar inte appliceras på få/snabba requests, men hur det beter sig vid skrapning av tusentals historiska omgångar är oklart (rekommenderar throttle/delay). Det kan även finnas inställda matcher (lottning) där `outcome` beter sig annorlunda, vilket systemet behöver hantera.

---

## Detaljerade Svar

1. **Hitta aktuellt `drawNumber`:** Anrop mot `/draws` returnerar den aktuella öppna dragningen där `drawNumber` är ett av nyckelfälten.
2. **Kan gamla omgångar hämtas?** Ja, det fungerar utmärkt via `/draws/{drawNumber}`.
3. **Hur långt bak går historiken?** Över 1000 omgångar testades utan problem, vilket motsvarar flera år bakåt i tiden.
4. **Fungerar `/draws/{drawNumber}` historiskt?** Ja.
5. **Fungerar `/draws/{drawNumber}/result` historiskt?** Ja.
6. **Fungerar `/draws/{drawNumber}/forecast` historiskt?** Ja.
7. **Vilka fält returneras?** 
   - *Draw*: `drawNumber`, `openTime`, `closeTime`, `turnover`, `jackpotItems`, samt `events` (med `odds` och `distribution` (streckprocent)).
   - *Forecast*: `turnover` och rot-fältet `distribution` som innehåller utdelningsprognos (`winners`, `amount`, `name`).
   - *Result*: `turnover`, `events` (med `outcome` (rätt tecken) och `outcomeScore` (matchresultat)) samt `distribution` (faktisk utdelning).
8. **Innehåller forecast streck/omsättning/jackpot?** `forecast` innehåller omsättning (`turnover`) och utdelningsprognos. **Observera:** Streckfördelningen (`distribution.home/draw/away`) ligger i `draw`-endpointen per event, inte i `forecast`! Jackpot ligger i `draw`.
9. **Innehåller result rätt rad etc?** Ja. `result` har `outcome` (ex. "1", "X", "2") per event, `outcomeScore` (ex. "2-1"), omsättning (`turnover`), och `distribution` med antal vinnare och utdelningsbelopp.
10. **Är `drawNumber` sekventiellt?** Ja, man kan loopa bakåt med `-1`, `-2`, `-100`.
11. **Finns det luckor?** Det verkar inte finnas några betydande luckor i sekvensen, men felhantering (HTTP 404) bör användas för säkerhets skull.
12. **Beter sig produkterna likadant?** Ja, strukturen för topptipset, europatipset, stryktipset m.fl. är identisk. Enda skillnaden är antal matcher per kupong.
13. **Felkoder:** Om `drawNumber` är för gammalt eller i framtiden (saknas) returnerar API:t HTTP 404 med en tydlig JSON body: `{"error": {"code": 404, "message": "Resource Not Found"}}`.
14. **Rate limits:** Vid snabba parallella tester syntes ingen rate limit, inga `X-RateLimit`-headers och inga HTTP 429-svar, men scraping bör ske ansvarsfullt.

---

## API Endpoints & Exempel

*Base-URL: `https://api.www.svenskaspel.se`*
*Samtliga anrop kräver query-parametern: `?accesskey=<API_NYCKEL>`*

### 1. Hämta aktuella dragningar (Current Draws)
* **Endpoint:** `/external/1/draw/{product}/draws`
* **Metod:** `GET`
* **Syfte:** Hämta aktuell (öppen) kupong för att få `drawNumber`, omsättning, spelstopp och startodds/streck.
* **Fungerar historiskt:** Nej, denna endpoint ger bara nuvarande omgångar.
* **Exempel-URL:** `https://api.www.svenskaspel.se/external/1/draw/topptipset/draws?accesskey=API_KEY`
* **Viktiga fält:** `drawNumber`, `openTime`, `closeTime`, `turnover`, `jackpotItems`, `events[].odds`, `events[].distribution` (streckfördelning).
* **Rekommendation:** Använd i realtid för att hämta det aktuella `drawNumber` som sedan används i underliggande databasanrop.

### 2. Hämta specifik dragning (Draw Details)
* **Endpoint:** `/external/1/draw/{product}/draws/{drawNumber}`
* **Metod:** `GET`
* **Syfte:** Hämta detaljer för en specifik omgång, framförallt streckfördelning och odds per match.
* **Fungerar historiskt:** Ja, går minst 1000 omgångar bakåt.
* **Exempel-URL:** `https://api.www.svenskaspel.se/external/1/draw/topptipset/draws/4177?accesskey=API_KEY`
* **Felhantering:** HTTP 404 vid ogiltigt/framtida `drawNumber`.
* **Rekommendation:** Huvudkällan för att spara historisk streckfördelning och startodds vid backtesting.

### 3. Hämta Resultat (Draw Result)
* **Endpoint:** `/external/1/draw/{product}/draws/{drawNumber}/result`
* **Metod:** `GET`
* **Syfte:** Hämta det slutgiltiga resultatet för kupongen efter att matcherna avslutats.
* **Fungerar historiskt:** Ja.
* **Exempel-URL:** `https://api.www.svenskaspel.se/external/1/draw/topptipset/draws/4177/result?accesskey=API_KEY`
* **Viktiga fält:** `events[].outcome` ("rätt tecken"), `events[].outcomeScore` ("2-1"), `distribution[]` (utdelning per vinstgrupp med `amount` och `winners`).
* **Rekommendation:** Skrapa detta per historiskt `drawNumber` för att verifiera rätt rad och utdelning vid ROI-beräkningar.

### 4. Hämta Prognos (Draw Forecast)
* **Endpoint:** `/external/1/draw/{product}/draws/{drawNumber}/forecast`
* **Metod:** `GET`
* **Syfte:** Hämta prognos för kupongen (utdelningsprognos).
* **Fungerar historiskt:** Ja.
* **Exempel-URL:** `https://api.www.svenskaspel.se/external/1/draw/topptipset/draws/4177/forecast?accesskey=API_KEY`
* **Viktiga fält:** `distribution[]` (uppskattad `amount` / `winners` baserat på streck).
* **Rekommendation:** Använd i realtid innan spelstopp för att se förväntat värde på raderna. Historiskt behövs den oftast inte om `/result` existerar.

---

## Own Wager Uppladdning (Lämna In Egna Rader)

* **Endpoint:** `/external/1/wager/ownwager/{product}`
* **Metod:** `POST`
* **Content-Type:** `application/json;charset=utf-8`
* **Authentication:** API-nyckel krävs i query-param `?accesskey=API_KEY`.

Formatet på body är JSON och `drawNumber: 0` betyder nästa dragning att stänga (aktuell kupong):

```json
{
  "drawNumber": 0,
  "system": "single",
  "items": [
    "1,X,2,1,X,2,1,X,2,1,X,2,1",
    "1,X,2,1,X,2,1,X,2,1,X,2,1"
  ],
  "client": "System Name 1.0",
  "retailer": "820206"
}
```

* **Notera Limits:** Ett request för Topptipset (`single` system) stöder max 1.000 rader. Stryktipset stöder upp till 10.000 rader per anrop. System-strängen anger ifall det är singelrader (`"single"`) eller matematiskt system (`"math"`). Upload-API:t returnerar en URL som kunden sen måste surfa till inom 30 minuter för att bekräfta och betala med sitt eget inlogg.

## Saknade verifieringar

Här följer den tekniska rådatan för resterande fält, formats och beteenden.

### 1. events[].odds
* **Är det odds per 1/X/2?** Ja, för formatet är `"home"`, `"draw"`, `"away"`.
* **Är det startodds/slutodds?** De återspeglar oddsen inför spelstopp. I endpointen kallas de även startOdds, favouriteOdds mm. i root-nivå men `events[].odds` innehåller de specifika oddsen.
* **Finns det historiskt?** Nej, på väldigt gamla omgångar (ex. Topptipset 100) returneras `null`. På nyare returneras string-värden med kommatecken, t.ex. `"1,66"`.
* **Finns fältet i /result?** Nej, odds saknas helt i result-endpointen, de finns enbart i `/draws`.
* **Exakta fältnamn:** `home`, `draw`, `away`.

### 2. events[].distribution
* **Vad är det?** Det är den slutliga streckfördelningen på matchen.
* **Format:** Strängar av heltal (ex. `"58"`), vilket representerar procent.
* **Summerar de till 100?** Ja, 1/X/2 (home/draw/away) summerar till 100 (kan diffa pga avrundning).
* **Historik:** Ja, de bevaras historiskt och reflekterar slutlig streckprocent vid spelstopp.
* **Exakta fältnamn:** `home`, `draw`, `away` (samt referensvärden: `refHome`, `refDraw`, `refAway`).

### 3. Skillnader: draw, forecast, result
* **Endast i /draws:** `drawState`, `fund`, `jackpotItems`, `events[].odds`, `events[].distribution` (streckfördelning).
* **Endast i /forecast:** `forecastComputable`, `numRemainingRows`.
* **Endast i /result:** Root-fältet `cancelled`. Här är `distribution` populerad med den verkliga utdelningen.
* **Turnover:** Finns i alla tre endpoints. Värdet är exakt identiskt (ex. `"200822,00"`).

### 4. Resultatfält
* **Rätt tecken:** Finns i `/result` under `events[].outcome` (värden: `"1"`, `"X"`, `"2"`).
* **Slutresultat/mål:** Finns i `/result` under `events[].outcomeScore` (värden: t.ex. `"1-1"`).

### 5. Utdelningsfält
* **Var finns faktisk utdelning?** I root-objektet `distribution` (som är en array) i `/result`.
* **Antal vinnare:** Fältet `winners` (heltal).
* **Utdelningsbelopp:** Fältet `amount` (sträng, i kronor med ören, ex. `"6830,00"`).
* **Vinstnivåer Topptipset:** Enbart `"8 rätt"`.
* **Vinstnivåer Stryktips/Europatips:** Flera nivåer returneras som separata objekt i arrayen: `"13 rätt"`, `"12 rätt"`, `"11 rätt"`, `"10 rätt"`.

### 6. Inställda/lottade matcher
* **Exempel:** Topptipset omgång 4122, match 3 (Independiente Medellin-Flamengo).
* **outcome:** Får det lottade resultatet (ex. `"2"`).
* **outcomeScore:** Returnerar `"0-0"` eller `"Lottad"`.
* **Särskilt statusfält:** Fältet `cancelled` sätts till `true` för matchen. `eventComment` anger även detaljer, ex: `"Matchen lottad till en 2:a (26-29-45)"`.

### 7. Historikdjup per produkt
Observerat vid test av lägsta tillgängliga `drawNumber` (binärsökning) innan API:t returnerar HTTP 404:
* **topptipset:** Omgång 78
* **topptipsetstryk:** Omgång 273
* **topptipseteuropa:** Omgång 481
* **stryktipset:** Omgång 3500 (äldre omgångar returnerade 404)
* **europatipset:** Omgång 1221

### 8. Antal matcher per produkt
* **Topptipset, Topptipset Stryk, Topptipset Europa:** Har alltid 8 `events`.
* **Stryktipset, Europatipset:** Har alltid 13 `events`.

### 9. Tidfält
* **Fältnamn:** `openTime`, `closeTime` (root-nivå) samt `sportEventStart` (per match i events).
* **Format:** ISO-8601 med tidszon (svensk tid).
* **Exempel:** `"2026-06-03T07:00:00+02:00"`. API:t hanterar tidszon markerat explicit (`+02:00` för sommartid, `+01:00` för normaltid).

### 10. Fel och begränsningar
* **För gammalt / framtida drawNumber:** API:t returnerar HTTP status 404 med body: `{"error": {"code": 404, "message": "Resource Not Found"}}`.
* **Saknad API-nyckel:** Returnerar HTTP status 401 med `{"error": {"code": 100005, "message": "Not authenticated"}}`.
* **Rate limits:** Test med 10 parallella requests resulterade i 10x HTTP 200. Inga `X-RateLimit`-headers skickas i responsen och inga HTTP 429 har observerats.

### 11. Own wager-format (Egna rader)
Bekräftade format för POST mot `/external/1/wager/ownwager/{product}`:
* **Stryktipset / Europatipset (single):**
  Kräver array av kommatecken-separerade 13-matchers-tecken. Max items: 10 000. Inget `betRowAmount` krävs då radinsatsen är fast.
  Exempel: `"items": ["1,X,2,1,X,2,1,X,2,1,X,2,1"]`
* **Topptipset (single):**
  Kräver kommatecken-separerade 8-matchers-tecken. Max items: 1 000. Eftersom insatsen kan väljas inkluderas `"betRowAmount": 5` i body. 
* **Slutligt betalningsflöde:** Uppladdningen genom API:t returnerar en bekräftelse-URL, till vilken användaren/klienten måste navigera för att bekräfta och slutföra betalningen med Svenska Spel-inloggningen.

## Parser-Kritiska Detaljer

### 1. Exempel-JSON

#### `/draws/{drawNumber}` (Utdrag för 1 event)
```json
{
  "drawState": "Finalized",
  "productName": "Topptipset",
  "productId": 25,
  "drawNumber": 4177,
  "openTime": "2026-06-03T07:00:00+02:00",
  "closeTime": "2026-06-06T01:29:00+02:00",
  "turnover": "200822,00",
  "events": [
    {
      "eventNumber": 1,
      "description": "Kanada-Irland",
      "odds": {
        "home": "1,66",
        "draw": "3,85",
        "away": "5,80"
      },
      "distribution": {
        "date": "2026-06-06T01:30:00.766+02:00",
        "refDate": "2026-06-06T01:27:56.131+02:00",
        "home": "58",
        "draw": "24",
        "away": "18",
        "refHome": "59",
        "refDraw": "24",
        "refAway": "17"
      },
      "sportEventStart": "2026-06-06T01:30:00+02:00"
    }
  ]
}
```

#### `/draws/{drawNumber}/forecast`
```json
{
  "forecastComputable": false,
  "turnover": "200822,00",
  "events": [
    {
      "eventNumber": 1,
      "outcome": "X",
      "outcomeScore": "1-1"
    }
  ],
  "distribution": [
    {
      "winners": 23,
      "amount": "6111,00",
      "name": "8 rätt"
    }
  ]
}
```

#### `/draws/{drawNumber}/result`
```json
{
  "cancelled": false,
  "turnover": "200822,00",
  "events": [
    {
      "eventNumber": 1,
      "outcome": "X",
      "outcomeScore": "1-1",
      "cancelled": false
    }
  ],
  "distribution": [
    {
      "winners": 23,
      "amount": "6111,00",
      "name": "8 rätt"
    }
  ]
}
```

### 2. Tabell över viktiga fält

| Fältnamn | Exempelvärde | API Typ | Parser-råd | Enhet |
| :--- | :--- | :--- | :--- | :--- |
| `drawNumber` | `4177` | `Integer` | Läs som int. Primary Key. | - |
| `turnover` | `"200822,00"` | `String` | Byt `,` mot `.` och konvertera till Float. | SEK |
| `distribution[].amount` | `"6111,00"` | `String` | Byt `,` mot `.` och konvertera till Float. | SEK |
| `distribution[].winners` | `23` | `Integer` | Läs som int. Kan vara 0. | Antal |
| `events[].distribution.home` | `"58"` | `String` | Läs som int/float. Måste summeras. | Procent (%) |
| `events[].odds.home` | `"1,66"` | `String` | Byt `,` mot `.` och konvertera till Float. Saknas ofta! | Decimalodds |
| `events[].outcome` | `"X"` | `String` | Läs som sträng ("1", "X", "2", "L"). | - |
| `events[].outcomeScore` | `"1-1"` | `String` | Läs som sträng. Kan vara "Lottad". | - |
| `openTime` / `closeTime` | `"2026-06-03T07:00:00+02:00"` | `String` | Läs som ISO-8601 Datetime. Explicit tidszon finns. | Datum/Tid |

### 3. Betydelse av `refHome`, `refDraw`, `refAway`
Dessa fält ligger i `events[].distribution` och återspeglar streckfördelningen vid en tidigare tidpunkt (`refDate`). Exempelvis visar `date` strecken kl 01:30, medan `refDate` visar strecken kl 01:27. Dessa används av Svenska Spels klienter för att rita ut "pilar" om ett tecken ökar eller minskar i popularitet strax innan spelstopp.

### 4. Historisk tillgänglighet för `events[].odds`
API:t sparar *inte* odds-fältet (`events[].odds`) för gamla omgångar. Fältet returneras som `null` om omgången är mer än ett par veckor/månader gammal.
Vid test försvann oddsen bakåt vid ungefär dessa `drawNumber` (relativt till aktuella dragningar):
* **Topptipset:** Saknas före ca omgång 4151 (endast de senaste ~25 omgångarna hade odds).
* **Topptipset Europa:** Saknas före ca omgång 1836.
* **Europatipset:** Saknas före ca omgång 2577.
* **Stryktipset / Topptipset Stryk:** Oddsen rensas bort så snabbt att inte ens ett par veckor gamla testade omgångar hade dem kvar.

*Slutsats:* Du kan **inte** bygga en historisk databas över odds enbart via detta API, eftersom datan tvättas bort retroaktivt. Streckfördelningen (`distribution`) sparas dock permanent!

### 5. Radkostnad per produkt
Fält för radkostnad (radinsats) finns inte explicit i `/draws`-payloaden. De tekniska radkostnaderna som gäller är dock fasta enligt spelreglerna:
* **Stryktipset:** 1 kr / rad
* **Europatipset:** 1 kr / rad
* **Topptipset (alla 3 varianter):** Radinsatsen är valbar (ex. 1, 2, 5, 10 kr), men i grunden räknas 1 rad = 1 kr i omsättning och i API:t är standardvärdet 1 kr om inget annat anges vid uppladdning (`betRowAmount`).

