from __future__ import annotations

import sys
from pathlib import Path
import unittest


sys.path.insert(0, str(Path(__file__).parent))

from core.models import DrawData, MatchData
from strategies.v7_market_vs_folk import (
    grid_to_dataframe,
    run_parameter_grid,
    split_train_holdout,
    run_walk_forward_grid,
    walk_forward_grid_folds_to_dataframe,
)


def make_match(draw_number: int, event_number: int, actual_outcome: str) -> MatchData:
    return MatchData(
        draw_number=draw_number,
        event_number=event_number,
        home_team=f"Home {event_number}",
        away_team=f"Away {event_number}",
        actual_outcome=actual_outcome,
        market_pct_home=0.50,
        market_pct_draw=0.30,
        market_pct_away=0.20,
        public_pct_home=0.40,
        public_pct_draw=0.30,
        public_pct_away=0.30,
    )


def make_draw(draw_number: int, actual_outcome: str, payout: float = 1000.0) -> DrawData:
    matches = tuple(
        make_match(draw_number=draw_number, event_number=i, actual_outcome=actual_outcome)
        for i in range(1, 9)
    )
    return DrawData(
        draw_number=draw_number,
        actual_winning_row=actual_outcome * 8,
        payout_8_correct=payout,
        matches=matches,
    )


class V7GridTests(unittest.TestCase):
    def test_split_train_holdout_is_chronological(self):
        draws = [make_draw(i, "1") for i in range(1, 11)]
        train, holdout = split_train_holdout(draws, holdout_fraction=0.2)

        self.assertEqual([d.draw_number for d in train], list(range(1, 9)))
        self.assertEqual([d.draw_number for d in holdout], [9, 10])

    def test_grid_dataframe_includes_train_and_holdout_metrics(self):
        draws = [make_draw(i, "1") for i in range(1, 7)]
        draws.extend(make_draw(i, "X") for i in range(7, 9))

        results = run_parameter_grid(
            draws=draws,
            edge_thresholds=[0.0, 0.2],
            max_signs_options=[2],
            max_rows_options=[None],
            min_edge_sums=[None],
            holdout_fraction=0.25,
            verbose=False,
        )
        df = grid_to_dataframe(results)

        self.assertEqual(len(df), 2)
        self.assertIn("train_avg_rows", df.columns)
        self.assertIn("train_roi", df.columns)
        self.assertIn("train_profit_kr", df.columns)
        self.assertIn("train_wins", df.columns)
        self.assertIn("train_max_drawdown", df.columns)
        self.assertIn("holdout_avg_rows", df.columns)
        self.assertIn("holdout_roi", df.columns)
        self.assertIn("holdout_profit_kr", df.columns)
        self.assertIn("holdout_wins", df.columns)
        self.assertIn("holdout_max_drawdown", df.columns)

        self.assertGreaterEqual(df.iloc[0]["train_roi"], df.iloc[1]["train_roi"])
        self.assertLess(df.iloc[0]["holdout_roi"], df.iloc[1]["holdout_roi"])

    def test_walk_forward_grid_selects_on_validation_not_test(self):
        draws = [make_draw(i, "1") for i in range(1, 5)]
        draws.append(make_draw(5, "X"))

        folds = run_walk_forward_grid(
            draws=draws,
            edge_thresholds=[0.0, 0.2],
            max_signs_options=[2],
            max_rows_options=[None],
            min_edge_sums=[None],
            train_size=2,
            validation_size=2,
            test_size=1,
            verbose=False,
        )
        df = walk_forward_grid_folds_to_dataframe(folds)

        self.assertEqual(len(df), 1)
        self.assertEqual(df.iloc[0]["selected_edge_threshold"], 0.2)
        self.assertEqual(df.iloc[0]["validation_roi"], 999.0)
        self.assertEqual(df.iloc[0]["test_roi"], -1.0)


if __name__ == "__main__":
    unittest.main()
