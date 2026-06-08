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
    // 1. Per-sign value ratio analysis: market_pct / public_pct
    // This is the KEY metric for pool betting edge
    const valueRatios = await pool.query(`
      WITH sign_data AS (
        SELECT
          e.draw_number, e.event_number,
          -- Home sign
          market_pct_home::float / NULLIF(public_pct_home, 0) AS home_edge,
          market_pct_home, public_pct_home,
          CASE WHEN outcome = '1' THEN 1 ELSE 0 END AS home_correct,
          -- Draw sign
          market_pct_draw::float / NULLIF(public_pct_draw, 0) AS draw_edge,
          market_pct_draw, public_pct_draw,
          CASE WHEN outcome = 'X' THEN 1 ELSE 0 END AS draw_correct,
          -- Away sign
          market_pct_away::float / NULLIF(public_pct_away, 0) AS away_edge,
          market_pct_away, public_pct_away,
          CASE WHEN outcome = '2' THEN 1 ELSE 0 END AS away_correct,
          outcome
        FROM tipsxtra_topptipset_events e
        JOIN tipsxtra_topptipset_draws d ON d.draw_number = e.draw_number
        WHERE d.complete_backtest
          AND public_pct_home > 0 AND public_pct_draw > 0 AND public_pct_away > 0
      ),
      all_signs AS (
        SELECT home_edge AS edge, market_pct_home AS market_pct, public_pct_home AS public_pct, home_correct AS correct, '1' AS sign FROM sign_data
        UNION ALL
        SELECT draw_edge, market_pct_draw, public_pct_draw, draw_correct, 'X' FROM sign_data
        UNION ALL
        SELECT away_edge, market_pct_away, public_pct_away, away_correct, '2' FROM sign_data
      ),
      bucketed AS (
        SELECT *,
          CASE
            WHEN edge >= 1.3 THEN 'A: edge>=1.30 (very under-bet)'
            WHEN edge >= 1.15 THEN 'B: edge>=1.15'
            WHEN edge >= 1.05 THEN 'C: edge>=1.05'
            WHEN edge >= 0.95 THEN 'D: edge~1.00 (fair)'
            WHEN edge >= 0.85 THEN 'E: edge>=0.85'
            WHEN edge >= 0.70 THEN 'F: edge>=0.70'
            ELSE 'G: edge<0.70 (very over-bet)'
          END AS bucket
        FROM all_signs
      )
      SELECT
        bucket,
        COUNT(*) AS n,
        AVG(edge) AS avg_edge,
        AVG(correct) * 100 AS actual_win_pct,
        AVG(market_pct) AS avg_market_pct,
        AVG(public_pct) AS avg_public_pct,
        AVG(edge * 0.65) AS avg_ev_factor
      FROM bucketed
      GROUP BY bucket
      ORDER BY bucket
    `);
    console.log('\n=== VALUE RATIO ANALYSIS (market/public per sign) ===');
    console.log('bucket | n | avg_edge | actual_win% | market% | public% | EV_factor');
    valueRatios.rows.forEach(r => {
      const evFactor = Number(r.avg_ev_factor);
      const flag = evFactor > 1 ? ' ★ POSITIVE EV' : '';
      console.log(`  ${r.bucket} | ${r.n} | ${Number(r.avg_edge).toFixed(3)} | ${Number(r.actual_win_pct).toFixed(1)}% | ${Number(r.avg_market_pct).toFixed(1)}% | ${Number(r.avg_public_pct).toFixed(1)}% | ${evFactor.toFixed(3)}${flag}`);
    });

    // 2. Per-row contrarian analysis:
    // For each draw, what's the value ratio product for the actual winning row?
    const rowValueProducts = await pool.query(`
      WITH correct_sign_edges AS (
        SELECT
          e.draw_number,
          e.event_number,
          e.outcome,
          CASE e.outcome
            WHEN '1' THEN market_pct_home::float / NULLIF(public_pct_home, 0)
            WHEN 'X' THEN market_pct_draw::float / NULLIF(public_pct_draw, 0)
            WHEN '2' THEN market_pct_away::float / NULLIF(public_pct_away, 0)
          END AS correct_edge
        FROM tipsxtra_topptipset_events e
        JOIN tipsxtra_topptipset_complete_real_payout_draws d ON d.draw_number = e.draw_number
        WHERE public_pct_home > 0 AND public_pct_draw > 0 AND public_pct_away > 0
      ),
      draw_products AS (
        SELECT
          draw_number,
          EXP(SUM(LN(GREATEST(correct_edge, 0.01)))) AS row_value_product,
          AVG(correct_edge) AS avg_edge,
          MIN(correct_edge) AS min_edge,
          COUNT(*) AS events
        FROM correct_sign_edges
        GROUP BY draw_number
        HAVING COUNT(*) = 8
      )
      SELECT
        CASE
          WHEN row_value_product >= 3.0 THEN 'A: prod>=3.0 (very contrarian)'
          WHEN row_value_product >= 2.0 THEN 'B: prod>=2.0'
          WHEN row_value_product >= 1.538 THEN 'C: prod>=1.538 (break-even @ 35%)'
          WHEN row_value_product >= 1.0 THEN 'D: prod>=1.0 (positive before cut)'
          WHEN row_value_product >= 0.5 THEN 'E: prod>=0.5'
          ELSE 'F: prod<0.5'
        END AS bucket,
        COUNT(*) AS draws,
        AVG(row_value_product) AS avg_product,
        AVG(row_value_product * 0.65) AS avg_ev_product
      FROM draw_products
      GROUP BY 1
      ORDER BY 1
    `);
    console.log('\n=== CORRECT ROW VALUE PRODUCT DISTRIBUTION ===');
    console.log('(row_value_product = product of market/public for the actual winning signs)');
    rowValueProducts.rows.forEach(r => {
      const evProd = Number(r.avg_ev_product);
      const flag = evProd > 1 ? ' ★ PROFITABLE TERRITORY' : '';
      console.log(`  ${r.bucket} | ${r.draws} draws | avg_prod=${Number(r.avg_product).toFixed(3)} | EV_prod=${evProd.toFixed(3)}${flag}`);
    });

    // 3. How often does the "best edge per match" sign actually win?
    const bestEdgeAccuracy = await pool.query(`
      WITH match_edges AS (
        SELECT
          e.draw_number, e.event_number, e.outcome,
          market_pct_home::float / NULLIF(public_pct_home, 0) AS h_edge,
          market_pct_draw::float / NULLIF(public_pct_draw, 0) AS d_edge,
          market_pct_away::float / NULLIF(public_pct_away, 0) AS a_edge,
          market_pct_home, market_pct_draw, market_pct_away,
          public_pct_home, public_pct_draw, public_pct_away
        FROM tipsxtra_topptipset_events e
        JOIN tipsxtra_topptipset_draws d ON d.draw_number = e.draw_number
        WHERE d.complete_backtest
          AND public_pct_home > 0 AND public_pct_draw > 0 AND public_pct_away > 0
      ),
      ranked AS (
        SELECT *,
          CASE
            WHEN h_edge >= d_edge AND h_edge >= a_edge THEN '1'
            WHEN d_edge >= h_edge AND d_edge >= a_edge THEN 'X'
            ELSE '2'
          END AS best_edge_sign,
          GREATEST(h_edge, d_edge, a_edge) AS best_edge,
          CASE
            WHEN market_pct_home >= market_pct_draw AND market_pct_home >= market_pct_away THEN '1'
            WHEN market_pct_draw >= market_pct_home AND market_pct_draw >= market_pct_away THEN 'X'
            ELSE '2'
          END AS market_fav_sign
        FROM match_edges
      )
      SELECT
        'best_edge' AS strategy,
        COUNT(*) AS n,
        AVG(CASE WHEN outcome = best_edge_sign THEN 1.0 ELSE 0.0 END) * 100 AS accuracy,
        AVG(best_edge) AS avg_edge
      FROM ranked
      UNION ALL
      SELECT
        'market_favorite' AS strategy,
        COUNT(*),
        AVG(CASE WHEN outcome = market_fav_sign THEN 1.0 ELSE 0.0 END) * 100,
        1.0
      FROM ranked
    `);
    console.log('\n=== STRATEGY ACCURACY: Best Edge vs Market Favorite ===');
    bestEdgeAccuracy.rows.forEach(r => {
      console.log(`  ${r.strategy}: accuracy=${Number(r.accuracy).toFixed(1)}%, avg_edge=${Number(r.avg_edge).toFixed(3)} (n=${r.n})`);
    });

    // 4. Simulate simple contrarian strategy:
    // For each match, pick the sign with highest edge (market/public ratio)
    // Calculate theoretical payout for each draw
    const contrarianSim = await pool.query(`
      WITH match_best_edge AS (
        SELECT
          e.draw_number,
          e.event_number,
          e.outcome,
          CASE
            WHEN (market_pct_home::float / NULLIF(public_pct_home, 0)) >= (market_pct_draw::float / NULLIF(public_pct_draw, 0))
             AND (market_pct_home::float / NULLIF(public_pct_home, 0)) >= (market_pct_away::float / NULLIF(public_pct_away, 0))
            THEN '1'
            WHEN (market_pct_draw::float / NULLIF(public_pct_draw, 0)) >= (market_pct_away::float / NULLIF(public_pct_away, 0))
            THEN 'X'
            ELSE '2'
          END AS picked_sign,
          GREATEST(
            market_pct_home::float / NULLIF(public_pct_home, 0),
            market_pct_draw::float / NULLIF(public_pct_draw, 0),
            market_pct_away::float / NULLIF(public_pct_away, 0)
          ) AS edge
        FROM tipsxtra_topptipset_events e
        JOIN tipsxtra_topptipset_complete_real_payout_draws d ON d.draw_number = e.draw_number
        WHERE public_pct_home > 0 AND public_pct_draw > 0 AND public_pct_away > 0
      ),
      draw_results AS (
        SELECT
          draw_number,
          COUNT(*) AS events,
          SUM(CASE WHEN picked_sign = outcome THEN 1 ELSE 0 END) AS correct_picks,
          EXP(SUM(LN(GREATEST(edge, 0.01)))) AS row_value_product,
          BOOL_AND(picked_sign = outcome) AS all_correct
        FROM match_best_edge
        GROUP BY draw_number
        HAVING COUNT(*) = 8
      )
      SELECT
        COUNT(*) AS total_draws,
        SUM(CASE WHEN all_correct THEN 1 ELSE 0 END) AS wins,
        AVG(correct_picks) AS avg_correct_per_draw,
        AVG(row_value_product) AS avg_value_product,
        AVG(CASE WHEN all_correct THEN row_value_product ELSE NULL END) AS avg_winning_value_product
      FROM draw_results
    `);
    console.log('\n=== CONTRARIAN SINGELRAD SIMULATION ===');
    console.log('(Pick highest market/public ratio per match)');
    const sim = contrarianSim.rows[0];
    console.log(`  Draws: ${sim.total_draws}, Wins: ${sim.wins}`);
    console.log(`  Avg correct picks/draw: ${Number(sim.avg_correct_per_draw).toFixed(2)} / 8`);
    console.log(`  Avg value product: ${Number(sim.avg_value_product).toFixed(3)}`);
    console.log(`  Avg winning value product: ${sim.avg_winning_value_product ? Number(sim.avg_winning_value_product).toFixed(3) : 'N/A'}`);

    // 5. Key question: what's the actual EV for each sign strategy?
    // Compare: pick best edge sign vs pick market favorite vs pick hybrid
    const perSignEV = await pool.query(`
      WITH sign_analysis AS (
        SELECT
          e.draw_number, e.event_number, e.outcome,
          -- Three strategies per match:
          -- 1) Market favorite
          CASE
            WHEN market_pct_home >= market_pct_draw AND market_pct_home >= market_pct_away THEN '1'
            WHEN market_pct_draw >= market_pct_home AND market_pct_draw >= market_pct_away THEN 'X'
            ELSE '2'
          END AS mkt_fav,
          -- 2) Best edge (contrarian)
          CASE
            WHEN (market_pct_home::float / NULLIF(public_pct_home, 0)) >= (market_pct_draw::float / NULLIF(public_pct_draw, 0))
             AND (market_pct_home::float / NULLIF(public_pct_home, 0)) >= (market_pct_away::float / NULLIF(public_pct_away, 0))
            THEN '1'
            WHEN (market_pct_draw::float / NULLIF(public_pct_draw, 0)) >= (market_pct_away::float / NULLIF(public_pct_away, 0))
            THEN 'X'
            ELSE '2'
          END AS best_edge,
          -- Edge values per sign
          market_pct_home::float / NULLIF(public_pct_home, 0) AS h_e,
          market_pct_draw::float / NULLIF(public_pct_draw, 0) AS d_e,
          market_pct_away::float / NULLIF(public_pct_away, 0) AS a_e
        FROM tipsxtra_topptipset_events e
        JOIN tipsxtra_topptipset_draws d ON d.draw_number = e.draw_number
        WHERE d.complete_backtest
          AND public_pct_home > 0 AND public_pct_draw > 0 AND public_pct_away > 0
      )
      SELECT
        -- How often mkt_fav = best_edge?
        AVG(CASE WHEN mkt_fav = best_edge THEN 1.0 ELSE 0.0 END) * 100 AS agree_pct,
        -- When they disagree, who is right more?
        AVG(CASE WHEN mkt_fav != best_edge AND outcome = mkt_fav THEN 1.0
             WHEN mkt_fav != best_edge AND outcome = best_edge THEN 0.0
             ELSE NULL END) * 100 AS mkt_right_when_disagree,
        -- Average edge ratio for the picked sign
        AVG(CASE mkt_fav WHEN '1' THEN h_e WHEN 'X' THEN d_e ELSE a_e END) AS avg_mkt_fav_edge,
        AVG(GREATEST(h_e, d_e, a_e)) AS avg_best_edge
      FROM sign_analysis
    `);
    console.log('\n=== MARKET FAV vs BEST EDGE COMPARISON ===');
    const comp = perSignEV.rows[0];
    console.log(`  Agree: ${Number(comp.agree_pct).toFixed(1)}%`);
    console.log(`  When disagree, market fav right: ${comp.mkt_right_when_disagree ? Number(comp.mkt_right_when_disagree).toFixed(1) : 'N/A'}%`);
    console.log(`  Avg edge for market fav pick: ${Number(comp.avg_mkt_fav_edge).toFixed(3)}`);
    console.log(`  Avg edge for best edge pick: ${Number(comp.avg_best_edge).toFixed(3)}`);

    // 6. Hybrid analysis: market favorite but WITH edge filter
    const hybridAnalysis = await pool.query(`
      WITH match_data AS (
        SELECT
          e.draw_number, e.event_number, e.outcome,
          market_pct_home, market_pct_draw, market_pct_away,
          public_pct_home, public_pct_draw, public_pct_away,
          market_pct_home::float / NULLIF(public_pct_home, 0) AS h_e,
          market_pct_draw::float / NULLIF(public_pct_draw, 0) AS d_e,
          market_pct_away::float / NULLIF(public_pct_away, 0) AS a_e,
          CASE
            WHEN market_pct_home >= market_pct_draw AND market_pct_home >= market_pct_away THEN '1'
            WHEN market_pct_draw >= market_pct_home AND market_pct_draw >= market_pct_away THEN 'X'
            ELSE '2'
          END AS mkt_fav
        FROM tipsxtra_topptipset_events e
        JOIN tipsxtra_topptipset_draws d ON d.draw_number = e.draw_number
        WHERE d.complete_backtest
          AND public_pct_home > 0 AND public_pct_draw > 0 AND public_pct_away > 0
      ),
      with_fav_edge AS (
        SELECT *,
          CASE mkt_fav WHEN '1' THEN h_e WHEN 'X' THEN d_e ELSE a_e END AS fav_edge
        FROM match_data
      ),
      bucketed AS (
        SELECT *,
          CASE
            WHEN fav_edge >= 1.2 THEN 'A: fav_edge>=1.20'
            WHEN fav_edge >= 1.1 THEN 'B: fav_edge>=1.10'
            WHEN fav_edge >= 1.0 THEN 'C: fav_edge>=1.00'
            WHEN fav_edge >= 0.9 THEN 'D: fav_edge>=0.90'
            ELSE 'E: fav_edge<0.90'
          END AS bucket
        FROM with_fav_edge
      )
      SELECT
        bucket,
        COUNT(*) AS n,
        AVG(CASE WHEN outcome = mkt_fav THEN 1.0 ELSE 0.0 END) * 100 AS accuracy,
        AVG(fav_edge) AS avg_edge,
        AVG(fav_edge * 0.65) AS ev_factor,
        AVG(CASE WHEN outcome = mkt_fav THEN fav_edge * 0.65 ELSE 0 END) AS conditional_ev
      FROM bucketed
      GROUP BY bucket
      ORDER BY bucket
    `);
    console.log('\n=== MARKET FAVORITE + EDGE FILTER ===');
    console.log('(Market favorite accuracy grouped by its edge ratio)');
    hybridAnalysis.rows.forEach(r => {
      console.log(`  ${r.bucket} | n=${r.n} | accuracy=${Number(r.accuracy).toFixed(1)}% | avg_edge=${Number(r.avg_edge).toFixed(3)} | ev_factor=${Number(r.ev_factor).toFixed(3)}`);
    });

  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
