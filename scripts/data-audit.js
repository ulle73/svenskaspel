require('dotenv').config();
const { Pool } = require('pg');

function normalizeDatabaseUrl(databaseUrl) {
  const parsed = new URL(databaseUrl);
  if (parsed.searchParams.get('sslmode') === 'require') {
    parsed.searchParams.set('sslmode', 'verify-full');
  }
  return parsed.toString();
}

async function main() {
  const pool = new Pool({
    connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL),
  });

  try {
    // 1. Basic counts
    const counts = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM tipsxtra_topptipset_draws) AS total_draws,
        (SELECT COUNT(*) FROM tipsxtra_topptipset_draws WHERE complete_backtest) AS complete_draws,
        (SELECT COUNT(*) FROM tipsxtra_topptipset_draws WHERE complete_backtest AND svenska_spel_result_available AND svenska_spel_result_amount IS NOT NULL) AS real_payout_draws,
        (SELECT COUNT(*) FROM tipsxtra_topptipset_events) AS total_events,
        (SELECT MIN(draw_number) FROM tipsxtra_topptipset_draws WHERE complete_backtest) AS oldest_complete,
        (SELECT MAX(draw_number) FROM tipsxtra_topptipset_draws WHERE complete_backtest) AS newest_complete,
        (SELECT MIN(draw_number) FROM tipsxtra_topptipset_draws WHERE complete_backtest AND svenska_spel_result_available) AS oldest_real_payout,
        (SELECT MAX(draw_number) FROM tipsxtra_topptipset_draws WHERE complete_backtest AND svenska_spel_result_available) AS newest_real_payout
    `);
    console.log('\n=== DATA COUNTS ===');
    console.log(JSON.stringify(counts.rows[0], null, 2));

    // 2. Payout distribution stats
    const payouts = await pool.query(`
      SELECT
        COUNT(*) AS draws_with_payout,
        AVG(svenska_spel_result_amount) AS avg_payout,
        MIN(svenska_spel_result_amount) AS min_payout,
        MAX(svenska_spel_result_amount) AS max_payout,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY svenska_spel_result_amount) AS median_payout,
        PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY svenska_spel_result_amount) AS p25_payout,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY svenska_spel_result_amount) AS p75_payout,
        AVG(svenska_spel_result_winners) AS avg_winners,
        MIN(svenska_spel_result_winners) AS min_winners,
        MAX(svenska_spel_result_winners) AS max_winners
      FROM tipsxtra_topptipset_draws
      WHERE svenska_spel_result_amount IS NOT NULL
        AND svenska_spel_result_amount > 0
    `);
    console.log('\n=== PAYOUT STATS ===');
    console.log(JSON.stringify(payouts.rows[0], null, 2));

    // 3. How often are zero-winner draws?
    const zeroWinners = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE svenska_spel_result_winners = 0) AS zero_winner_draws,
        COUNT(*) FILTER (WHERE svenska_spel_result_winners = 0)::float / NULLIF(COUNT(*), 0) AS zero_winner_pct,
        COUNT(*) FILTER (WHERE svenska_spel_result_winners BETWEEN 1 AND 5) AS few_winners_1_5,
        COUNT(*) FILTER (WHERE svenska_spel_result_winners BETWEEN 6 AND 20) AS medium_winners_6_20,
        COUNT(*) FILTER (WHERE svenska_spel_result_winners > 20) AS many_winners_gt20
      FROM tipsxtra_topptipset_draws
      WHERE svenska_spel_result_available
    `);
    console.log('\n=== WINNER DISTRIBUTION ===');
    console.log(JSON.stringify(zeroWinners.rows[0], null, 2));

    // 4. Market accuracy - how often does market favorite win?
    const marketAccuracy = await pool.query(`
      SELECT
        COUNT(*) AS total_matches,
        COUNT(*) FILTER (WHERE market_was_right) AS market_right,
        COUNT(*) FILTER (WHERE market_was_right)::float / NULLIF(COUNT(*), 0) AS market_accuracy,
        COUNT(*) FILTER (WHERE public_was_right) AS public_right,
        COUNT(*) FILTER (WHERE public_was_right)::float / NULLIF(COUNT(*), 0) AS public_accuracy,
        COUNT(*) FILTER (WHERE expert_was_right) AS expert_right,
        COUNT(*) FILTER (WHERE expert_was_right)::float / NULLIF(COUNT(*), 0) AS expert_accuracy,
        COUNT(*) FILTER (WHERE outcome = '1') AS home_wins,
        COUNT(*) FILTER (WHERE outcome = 'X') AS draws,
        COUNT(*) FILTER (WHERE outcome = '2') AS away_wins
      FROM tipsxtra_topptipset_events e
      JOIN tipsxtra_topptipset_draws d ON d.draw_number = e.draw_number
      WHERE d.complete_backtest
    `);
    console.log('\n=== PREDICTION ACCURACY ===');
    console.log(JSON.stringify(marketAccuracy.rows[0], null, 2));

    // 5. Market odds calibration - are market probs well-calibrated?
    const calibration = await pool.query(`
      WITH buckets AS (
        SELECT
          CASE
            WHEN market_pct_home >= 50 THEN 'fav_50plus'
            WHEN market_pct_home >= 40 THEN 'fav_40_49'
            WHEN market_pct_home >= 30 THEN 'mid_30_39'
            WHEN market_pct_home >= 20 THEN 'low_20_29'
            ELSE 'vlow_under20'
          END AS bucket,
          CASE WHEN outcome = '1' THEN 1 ELSE 0 END AS home_won,
          market_pct_home
        FROM tipsxtra_topptipset_events e
        JOIN tipsxtra_topptipset_draws d ON d.draw_number = e.draw_number
        WHERE d.complete_backtest AND market_pct_home IS NOT NULL
      )
      SELECT
        bucket,
        COUNT(*) AS n,
        AVG(market_pct_home) AS avg_predicted_pct,
        AVG(home_won) * 100 AS actual_win_pct
      FROM buckets
      GROUP BY bucket
      ORDER BY avg_predicted_pct DESC
    `);
    console.log('\n=== MARKET CALIBRATION (Home Win) ===');
    calibration.rows.forEach(r => {
      console.log(`  ${r.bucket}: predicted=${Number(r.avg_predicted_pct).toFixed(1)}% actual=${Number(r.actual_win_pct).toFixed(1)}% (n=${r.n})`);
    });

    // 6. Streck vs odds - what are public odds (from streck)?
    const streckAnalysis = await pool.query(`
      SELECT
        AVG(public_pct_home) AS avg_public_home_pct,
        AVG(public_pct_draw) AS avg_public_draw_pct,
        AVG(public_pct_away) AS avg_public_away_pct,
        AVG(market_pct_home) AS avg_market_home_pct,
        AVG(market_pct_draw) AS avg_market_draw_pct,
        AVG(market_pct_away) AS avg_market_away_pct,
        AVG(ABS(public_pct_home - market_pct_home)) AS avg_home_streck_diff,
        AVG(ABS(public_pct_draw - market_pct_draw)) AS avg_draw_streck_diff,
        AVG(ABS(public_pct_away - market_pct_away)) AS avg_away_streck_diff
      FROM tipsxtra_topptipset_events e
      JOIN tipsxtra_topptipset_draws d ON d.draw_number = e.draw_number
      WHERE d.complete_backtest
    `);
    console.log('\n=== STRECK vs MARKET (avg pct) ===');
    console.log(JSON.stringify(streckAnalysis.rows[0], null, 2));

    // 7. Value hunting: when market and public disagree, who is right?
    const valueAnalysis = await pool.query(`
      WITH disagreements AS (
        SELECT
          e.*,
          CASE
            WHEN market_pct_home > public_pct_home + 5 THEN 'market_more_home'
            WHEN public_pct_home > market_pct_home + 5 THEN 'public_more_home'
            ELSE 'agree'
          END AS disagreement_type
        FROM tipsxtra_topptipset_events e
        JOIN tipsxtra_topptipset_draws d ON d.draw_number = e.draw_number
        WHERE d.complete_backtest
      )
      SELECT
        disagreement_type,
        COUNT(*) AS n,
        AVG(CASE WHEN outcome = '1' THEN 1.0 ELSE 0.0 END) * 100 AS home_win_pct,
        AVG(market_pct_home) AS avg_market_home,
        AVG(public_pct_home) AS avg_public_home
      FROM disagreements
      GROUP BY disagreement_type
      ORDER BY disagreement_type
    `);
    console.log('\n=== VALUE: Market vs Public Disagreement (Home) ===');
    valueAnalysis.rows.forEach(r => {
      console.log(`  ${r.disagreement_type}: actual_home_win=${Number(r.home_win_pct).toFixed(1)}% market=${Number(r.avg_market_home).toFixed(1)}% public=${Number(r.avg_public_home).toFixed(1)}% (n=${r.n})`);
    });

    // 8. Turnover analysis
    const turnoverAnalysis = await pool.query(`
      SELECT
        AVG(svenska_spel_result_turnover) AS avg_turnover,
        MIN(svenska_spel_result_turnover) AS min_turnover,
        MAX(svenska_spel_result_turnover) AS max_turnover,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY svenska_spel_result_turnover) AS median_turnover
      FROM tipsxtra_topptipset_draws
      WHERE svenska_spel_result_turnover IS NOT NULL AND svenska_spel_result_turnover > 0
    `);
    console.log('\n=== TURNOVER (SEK) ===');
    console.log(JSON.stringify(turnoverAnalysis.rows[0], null, 2));

    // 9. Kontrollera om market odds stämmer med market pct
    const oddsCheck = await pool.query(`
      SELECT
        AVG(ABS(1.0/NULLIF(market_odds_home,0)*100 - market_pct_home)) AS avg_home_odds_pct_diff,
        AVG(ABS(1.0/NULLIF(market_odds_draw,0)*100 - market_pct_draw)) AS avg_draw_odds_pct_diff,
        AVG(ABS(1.0/NULLIF(market_odds_away,0)*100 - market_pct_away)) AS avg_away_odds_pct_diff,
        COUNT(*) AS n
      FROM tipsxtra_topptipset_events e
      JOIN tipsxtra_topptipset_draws d ON d.draw_number = e.draw_number
      WHERE d.complete_backtest
        AND market_odds_home > 0
        AND market_odds_draw > 0
        AND market_odds_away > 0
    `);
    console.log('\n=== ODDS vs PCT CONSISTENCY ===');
    console.log(JSON.stringify(oddsCheck.rows[0], null, 2));

  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
