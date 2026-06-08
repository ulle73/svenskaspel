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
    // KEY QUESTION: What is the actual house cut?
    // If turnover = total money bet, and payout = total money returned,
    // then house_cut = 1 - sum(payout*winners) / turnover
    const houseCut = await pool.query(`
      SELECT
        COUNT(*) AS draws,
        SUM(svenska_spel_result_turnover) AS total_turnover,
        SUM(svenska_spel_result_amount * svenska_spel_result_winners) AS total_payout,
        SUM(svenska_spel_result_amount * svenska_spel_result_winners)::float / 
          NULLIF(SUM(svenska_spel_result_turnover), 0) AS return_rate,
        1 - SUM(svenska_spel_result_amount * svenska_spel_result_winners)::float / 
          NULLIF(SUM(svenska_spel_result_turnover), 0) AS actual_house_cut
      FROM tipsxtra_topptipset_draws
      WHERE svenska_spel_result_turnover > 0
        AND svenska_spel_result_amount > 0
        AND svenska_spel_result_winners > 0
    `);
    console.log('\n=== ACTUAL HOUSE CUT ===');
    console.log(JSON.stringify(houseCut.rows[0], null, 2));

    // How does payout relate to # winners?
    const payoutByWinners = await pool.query(`
      SELECT
        CASE
          WHEN svenska_spel_result_winners BETWEEN 1 AND 5 THEN 'A: 1-5 winners'
          WHEN svenska_spel_result_winners BETWEEN 6 AND 20 THEN 'B: 6-20 winners'
          WHEN svenska_spel_result_winners BETWEEN 21 AND 100 THEN 'C: 21-100 winners'
          WHEN svenska_spel_result_winners BETWEEN 101 AND 500 THEN 'D: 101-500 winners'
          WHEN svenska_spel_result_winners BETWEEN 501 AND 2000 THEN 'E: 501-2000 winners'
          ELSE 'F: 2000+ winners'
        END AS bucket,
        COUNT(*) AS draws,
        AVG(svenska_spel_result_amount) AS avg_payout,
        AVG(svenska_spel_result_turnover) AS avg_turnover,
        AVG(svenska_spel_result_amount * svenska_spel_result_winners)::float /
          NULLIF(AVG(svenska_spel_result_turnover), 0) AS payout_ratio,
        MIN(svenska_spel_result_amount) AS min_payout,
        MAX(svenska_spel_result_amount) AS max_payout
      FROM tipsxtra_topptipset_draws
      WHERE svenska_spel_result_turnover > 0
        AND svenska_spel_result_amount > 0
        AND svenska_spel_result_winners > 0
      GROUP BY 1
      ORDER BY 1
    `);
    console.log('\n=== PAYOUT BY WINNER COUNT ===');
    payoutByWinners.rows.forEach(r => {
      console.log(`  ${r.bucket}: ${r.draws} draws, avg_payout=${Number(r.avg_payout).toFixed(0)}kr, avg_turnover=${Number(r.avg_turnover).toFixed(0)}kr, payout_ratio=${Number(r.payout_ratio).toFixed(3)}, range=[${Number(r.min_payout).toFixed(0)}-${Number(r.max_payout).toFixed(0)}]`);
    });

    // What is the edge product of the ACTUAL winning row?
    // And how does it correlate with payout?
    const winnerEdgeVsPayout = await pool.query(`
      WITH correct_edges AS (
        SELECT
          e.draw_number,
          CASE e.outcome
            WHEN '1' THEN market_pct_home::float / NULLIF(public_pct_home, 0)
            WHEN 'X' THEN market_pct_draw::float / NULLIF(public_pct_draw, 0)
            WHEN '2' THEN market_pct_away::float / NULLIF(public_pct_away, 0)
          END AS correct_edge
        FROM tipsxtra_topptipset_events e
        JOIN tipsxtra_topptipset_complete_real_payout_draws d ON d.draw_number = e.draw_number
        WHERE public_pct_home > 0 AND public_pct_draw > 0 AND public_pct_away > 0
      ),
      draw_edge_products AS (
        SELECT
          draw_number,
          EXP(SUM(LN(GREATEST(correct_edge, 0.001)))) AS edge_product
        FROM correct_edges
        GROUP BY draw_number
        HAVING COUNT(*) = 8
      )
      SELECT
        CASE
          WHEN dep.edge_product >= 2.0 THEN 'A: high_edge>=2.0'
          WHEN dep.edge_product >= 1.538 THEN 'B: positive_ev>=1.538'
          WHEN dep.edge_product >= 1.0 THEN 'C: above_par>=1.0'
          WHEN dep.edge_product >= 0.5 THEN 'D: moderate>=0.5'
          ELSE 'E: low<0.5'
        END AS edge_bucket,
        COUNT(*) AS draws,
        AVG(d.svenska_spel_result_amount) AS avg_payout,
        AVG(d.svenska_spel_result_winners) AS avg_winners,
        AVG(dep.edge_product) AS avg_edge_product,
        -- Expected payout = edge_product * 0.65 * cost
        -- Actual ROI if we had played this exact row:
        AVG(d.svenska_spel_result_amount - 1) AS avg_profit_per_win
      FROM draw_edge_products dep
      JOIN tipsxtra_topptipset_draws d ON d.draw_number = dep.draw_number
      WHERE d.svenska_spel_result_amount > 0
      GROUP BY 1
      ORDER BY 1
    `);
    console.log('\n=== WINNING ROW EDGE vs ACTUAL PAYOUT ===');
    winnerEdgeVsPayout.rows.forEach(r => {
      console.log(`  ${r.edge_bucket}: ${r.draws} draws, avg_payout=${Number(r.avg_payout).toFixed(0)}kr, avg_winners=${Number(r.avg_winners).toFixed(0)}, avg_edge=${Number(r.avg_edge_product).toFixed(3)}`);
    });

    // CRITICAL: correlation between edge_product and payout
    const correlation = await pool.query(`
      WITH correct_edges AS (
        SELECT
          e.draw_number,
          CASE e.outcome
            WHEN '1' THEN market_pct_home::float / NULLIF(public_pct_home, 0)
            WHEN 'X' THEN market_pct_draw::float / NULLIF(public_pct_draw, 0)
            WHEN '2' THEN market_pct_away::float / NULLIF(public_pct_away, 0)
          END AS correct_edge
        FROM tipsxtra_topptipset_events e
        JOIN tipsxtra_topptipset_complete_real_payout_draws d ON d.draw_number = e.draw_number
        WHERE public_pct_home > 0 AND public_pct_draw > 0 AND public_pct_away > 0
      ),
      draw_edge_products AS (
        SELECT
          draw_number,
          EXP(SUM(LN(GREATEST(correct_edge, 0.001)))) AS edge_product
        FROM correct_edges
        GROUP BY draw_number
        HAVING COUNT(*) = 8
      )
      SELECT
        CORR(dep.edge_product, d.svenska_spel_result_amount) AS edge_payout_correlation,
        CORR(dep.edge_product, LN(GREATEST(d.svenska_spel_result_amount, 1))) AS edge_log_payout_correlation,
        CORR(dep.edge_product, 1.0 / GREATEST(d.svenska_spel_result_winners, 1)) AS edge_inv_winners_correlation
      FROM draw_edge_products dep
      JOIN tipsxtra_topptipset_draws d ON d.draw_number = dep.draw_number
      WHERE d.svenska_spel_result_amount > 0
    `);
    console.log('\n=== CORRELATION: Edge Product vs Payout ===');
    console.log(JSON.stringify(correlation.rows[0], null, 2));

    // What fraction of actual winning rows would we INCLUDE if we only play
    // rows with edge_product >= threshold?
    const coverageAnalysis = await pool.query(`
      WITH correct_edges AS (
        SELECT
          e.draw_number,
          CASE e.outcome
            WHEN '1' THEN market_pct_home::float / NULLIF(public_pct_home, 0)
            WHEN 'X' THEN market_pct_draw::float / NULLIF(public_pct_draw, 0)
            WHEN '2' THEN market_pct_away::float / NULLIF(public_pct_away, 0)
          END AS correct_edge
        FROM tipsxtra_topptipset_events e
        JOIN tipsxtra_topptipset_complete_real_payout_draws d ON d.draw_number = e.draw_number
        WHERE public_pct_home > 0 AND public_pct_draw > 0 AND public_pct_away > 0
      ),
      draw_edge_products AS (
        SELECT
          draw_number,
          EXP(SUM(LN(GREATEST(correct_edge, 0.001)))) AS edge_product
        FROM correct_edges
        GROUP BY draw_number
        HAVING COUNT(*) = 8
      )
      SELECT
        COUNT(*) AS total_draws,
        COUNT(*) FILTER (WHERE edge_product >= 1.0) AS above_par,
        COUNT(*) FILTER (WHERE edge_product >= 1.538) AS positive_ev,
        COUNT(*) FILTER (WHERE edge_product >= 2.0) AS high_ev,
        COUNT(*) FILTER (WHERE edge_product >= 3.0) AS very_high_ev,
        -- What pct of all draws have the correct row in positive EV territory?
        COUNT(*) FILTER (WHERE edge_product >= 1.538)::float / COUNT(*) AS positive_ev_pct,
        -- Average payout for positive EV rows vs negative EV rows
        AVG(CASE WHEN edge_product >= 1.538 THEN d.svenska_spel_result_amount END) AS avg_payout_pos_ev,
        AVG(CASE WHEN edge_product < 1.538 THEN d.svenska_spel_result_amount END) AS avg_payout_neg_ev
      FROM draw_edge_products dep
      JOIN tipsxtra_topptipset_draws d ON d.draw_number = dep.draw_number
      WHERE d.svenska_spel_result_amount > 0
    `);
    console.log('\n=== COVERAGE: How many draws have +EV correct rows? ===');
    const ca = coverageAnalysis.rows[0];
    console.log(`  Total draws: ${ca.total_draws}`);
    console.log(`  Correct row with edge >= 1.0: ${ca.above_par} (${(Number(ca.above_par)/Number(ca.total_draws)*100).toFixed(1)}%)`);
    console.log(`  Correct row with edge >= 1.538 (+EV): ${ca.positive_ev} (${(Number(ca.positive_ev_pct)*100).toFixed(1)}%)`);
    console.log(`  Correct row with edge >= 2.0: ${ca.high_ev}`);
    console.log(`  Correct row with edge >= 3.0: ${ca.very_high_ev}`);
    console.log(`  Avg payout when +EV: ${Number(ca.avg_payout_pos_ev).toFixed(0)} kr`);
    console.log(`  Avg payout when -EV: ${Number(ca.avg_payout_neg_ev).toFixed(0)} kr`);

  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
