# Topptipset ROI-optimerat spelstrategi-system

## Problemanalys

Det befintliga backtest-systemet har ett **fatalt strukturellt problem**: det spelar 1 singelrad per omgång (8 rätt krävs), men sannolikheten att träffa alla 8 matcher rätt är ~0.01–0.1%. Senaste backtestet: **169 spelade rader, 0 vinster, -100% ROI** över 9 folds.

> [!CAUTION]
> Nuvarande approach kan ALDRIG bli lönsam med singelrader. Även med perfekt modell är förväntad träfffrekvens ~1 på 200-500 omgångar. Det kräver en bankrulle som överlever 500+ förlustrader, och den volatiliteten gör strategin obrukbar live.

### Grundproblemet

Topptipset kräver **8/8 rätt** för vinst. Med marknadsfavoriter (~45% per match) blir sannolikheten `0.45^8 ≈ 0.07%`. Att spela 1 rad per omgång ger en **extrem negativ variansrisk** – man kan förlora hundratals omgångar i rad innan en vinst.

### Lösningen: Systemspel med täckningsstrategi

Istället för 1 rad per omgång ska vi spela **reducerade system** med 5-50 rader per omgång, där vi:
1. Väljer de mest sannolika tecknen (1/X/2) per match utifrån modellens sannolikheter
2. Garderarar selektivt med 2-3 tecken på osäkra matcher
3. Filtrerar bort omgångar med för lågt förväntat värde
4. Håller radkostnaden under en budget per omgång

---

## User Review Required

> [!IMPORTANT]
> **Strategisk inriktning**: Systemet optimerar för en strategi baserad på **garderingar** (multiple signs per match) snarare än singelrader. Detta innebär radkostnader på 5-100 kr per omgång istället för 1 kr. Är denna approach OK?

> [!IMPORTANT]
> **Stryktipset vs Topptipset**: Stryktipset (13 matcher, 1 kr/rad, multipla vinstnivåer: 10-13 rätt) erbjuder potentiellt bättre möjligheter för value-spel p.g.a. fler vinstnivåer och lägre radpris. Ska vi inkludera Stryktipset-strategier i systemet, eller fokusera enbart på Topptipset?

> [!WARNING]
> **Kelly-sizing**: Systemet planerar att använda Kelly Criterion-baserad insatsstyrning. Detta kräver en definierad bankrulle. Vad är din initiala bankrulle (förslag: 5 000 kr)?

## Open Questions

1. **Tidningen-data**: TipsXtra CSV:en innehåller `newspaper_home/draw/away` (tidningstips). Hur stor vikt vill du lägga på dessa? De kan vara en bra kontrarian-signal.

2. **Live-deployment**: Ska systemet kunna generera spel automatiskt och ladda upp via Own Wager API:t, eller bara ge rekommendationer?

3. **Multi-produkt**: Ska vi stödja Topptipset Europa och Topptipset Stryk också, eller bara standard Topptipset?

---

## Proposed Changes

### Komponent 1: Ny strategi-motor med systemspel

Byter ut singelrads-strategin mot en systemspels-motor som:
- Genererar reducerade system (garderade rader) baserat på modellens sannolikheter
- Optimerar antalet garderingar per match baserat på edge vs. kostnad
- Beräknar förväntat värde för hela systemet (alla rader) mot poolens utdelningsprognos

#### [NEW] [strategy-system-play.js](file:///c:/dev/svenskaspel/scripts/lib/strategy-system-play.js)
- `buildSystemTickets(matches, config)` – genererar alla rader från ett garderingssystem
- `evaluateSystemExpectedValue(tickets, poolOdds, matchProbabilities)` – beräknar EV för hela systemet
- `optimizeGardings(matches, budget, modelProbabilities)` – väljer optimala garderingar givet budget
- `kellyFraction(edge, odds, bankroll)` – Kelly-baserad insatsstyrning

---

### Komponent 2: Förbättrad sannolikhetsmodell

Nuvarande logistisk regression har 18 features men tränas med SGD i bara 18 epochs. Vi förbättrar modellen:

#### [NEW] [model-enhanced.js](file:///c:/dev/svenskaspel/scripts/lib/model-enhanced.js)
- **Gradient Boosted Trees** (hand-implementerat utan externa dependencies): ensemble av beslutsträd för bättre icke-linjär modellering
- **Feature engineering**: Lägg till ligaviktade features, home/away historik, matchdags-features
- **Kalibrering**: Platt-scaling eller isotonic regression för att säkerställa att modellens sannolikheter är välkalibrerade (kritiskt för systemspel!)
- **Cross-validation med tidsfönster**: Expanding window istället för fixed split

---

### Komponent 3: Ny backtest-motor för systemspel

#### [NEW] [backtest-topptipset-system.js](file:///c:/dev/svenskaspel/scripts/backtest-topptipset-system.js)
Helt nytt backtest som:
1. Tränar modell på historiska data (expanding window)
2. Genererar systemspel per omgång (garderingar baserat på modell)
3. Beräknar ROI mot **faktisk Svenska Spel-utdelning** (inte proxy)
4. Trackar: hit rate, ROI, drawdown, Sharpe ratio, profit curve
5. Walk-forward validation med grid search över:
   - Max rader per omgång (budget)
   - Min förväntat värde per rad
   - Garderingsdjup (max tecken per match)
   - Kelly-fraktion

**Config grid-parametrar:**
| Parameter | Värden |
|---|---|
| maxRowsPerDraw | 8, 16, 32, 64, 128 |
| maxSignsPerMatch | 1, 2, 3 |
| minSystemEV | 0.5, 1.0, 1.5, 2.0 |
| minMatchProbability | 0.20, 0.25, 0.30 |
| kellyFraction | 0.05, 0.10, 0.25, 0.50 |

---

### Komponent 4: Vinstberäkning med pooldelning

#### [MODIFY] [backfill-topptipset-results.js](file:///c:/dev/svenskaspel/scripts/backfill-topptipset-results.js)
- Sparar redan faktisk utdelning (`svenska_spel_result_amount`). Behöver ingen ändring.

#### [NEW] [lib/pool-payout-calculator.js](file:///c:/dev/svenskaspel/scripts/lib/pool-payout-calculator.js)
- Beräknar exakt utdelning per vinnande rad baserat på omsättning, streckfördelning, och antal vinnare
- Hanterar specialfall: jackpot, lottade matcher, 0 vinnare

---

### Komponent 5: Rapportgenerering och dashboard

#### [NEW] [reports/generate-strategy-report.js](file:///c:/dev/svenskaspel/scripts/generate-strategy-report.js)
- Genererar en HTML-rapport med:
  - Profit curve (kumulativ vinst över tid)
  - ROI per fold
  - Hit rate och Sharpe ratio
  - Best/worst periods
  - Jämförelse mot baseline (slumpmässigt spel, marknadsfavoriter)

---

### Komponent 6: Live-rekommendationsmotor

#### [NEW] [recommend-topptipset.js](file:///c:/dev/svenskaspel/scripts/recommend-topptipset.js)
- Hämtar aktuell omgångs data från Svenska Spel API
- Kör modellen och genererar system-rekommendation
- Sparar rekommendation till databas
- Output: vilka tecken per match, hur många rader, total kostnad, förväntat värde

---

## Implementation Order

1. **Fas 1: Ny strategi-motor** (`strategy-system-play.js`, `model-enhanced.js`, `pool-payout-calculator.js`)
2. **Fas 2: Backtest** (`backtest-topptipset-system.js`) – kör och validera
3. **Fas 3: Rapportering** (`generate-strategy-report.js`)
4. **Fas 4: Live-motor** (`recommend-topptipset.js`)

---

## Verification Plan

### Automated Tests
```bash
# Kör ny backtest mot historisk data
node scripts/backtest-topptipset-system.js

# Verifiera att modellen är kalibrerad
# (kontrollera att predicted prob ≈ actual hit rate i bins)
```

### Manual Verification
- Jämför backtest-ROI med singelrads-ROI (bör vara dramatiskt bättre)
- Verifiera att hit rate > 0 (singelrads var 0%)
- Kontrollera att profit curve har uppåtgående trend
- Verifiera att Kelly-sizing ger rimliga insatser (1-10% av bankrulle)

### Baseline-jämförelse
- **Baseline 1**: Spela marknadsfavoriterna varje omgång (1 rad) → förväntat ROI ≈ -30%
- **Baseline 2**: Slumpmässiga garderingar → förväntat ROI ≈ -25% (poolavgift)
- **Mål**: ROI > 0% med stabil profit curve över 500+ omgångar
