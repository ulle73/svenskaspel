"""
Topptipset V7 – Huvudskript.

Kör backtestet mot din faktiska databas och producerar reproducerbar rapport.

Användning:
    python claude/run_v7.py
    python claude/run_v7.py --postgres
    python claude/run_v7.py --db topptipset.db
    python claude/run_v7.py --db topptipset.db --draws-table draws --matches-table matches
    python claude/run_v7.py --csv-draws draws.csv --csv-matches matches.csv
    python claude/run_v7.py --db topptipset.db --grid               # Parametergrid
    python claude/run_v7.py --db topptipset.db --walk-forward       # Walk-forward validering

Kolumnmappning (om ditt schema skiljer sig):
    Redigera DRAW_COLUMN_OVERRIDE och MATCH_COLUMN_OVERRIDE nedan.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Säkerställ att projektrooten är i path
sys.path.insert(0, str(Path(__file__).parent))

from core.loader import load_from_csv, load_from_postgres, load_from_sqlite
from core.backtest import run_walk_forward
from strategies.v7_market_vs_folk import (
    v7_config,
    split_train_holdout,
    run_parameter_grid,
    grid_to_dataframe,
    run_walk_forward_grid,
    walk_forward_grid_folds_to_dataframe,
    walk_forward_grid_summary_to_dataframe,
)
from reports.reporter import print_report, export_json, round_log, edge_calibration_report

# ---------------------------------------------------------------------------
# Anpassa kolumnnamn här om ditt schema skiljer sig från standard
# ---------------------------------------------------------------------------
DRAW_COLUMN_OVERRIDE: dict[str, str] = {
    # "draw_number":        "round_id",     # internt namn → ditt DB-kolumnnamn
    # "actual_winning_row": "winning_row",
    # "payout_8_correct":   "eight_correct_payout",
}

MATCH_COLUMN_OVERRIDE: dict[str, str] = {
    # "draw_number":      "round_id",
    # "event_number":     "match_number",
    # "actual_outcome":   "result",
    # "market_pct_home":  "mkt_home",
}


def main():
    parser = argparse.ArgumentParser(description="Topptipset V7 Backtest")
    src = parser.add_mutually_exclusive_group(required=False)
    src.add_argument("--postgres",    action="store_true", help="Läs från Postgres via DATABASE_URL (default)")
    src.add_argument("--db",          type=str, help="Sökväg till SQLite-databas")
    src.add_argument("--csv-draws",   type=str, help="CSV-fil med omgångsdata")

    parser.add_argument("--csv-matches",   type=str, help="CSV-fil med matchdata (kräver --csv-draws)")
    parser.add_argument("--draws-table",   type=str, default="draws",   help="Tabellnamn för omgångar")
    parser.add_argument("--matches-table", type=str, default="matches", help="Tabellnamn för matcher")

    # Backtest-alternativ
    parser.add_argument("--grid",         action="store_true", help="Kör parametergrid")
    parser.add_argument("--walk-forward", action="store_true", help="Walk-forward validering")
    parser.add_argument("--holdout-pct",  type=float, default=0.20, help="Andel senaste omgångar som hålls ut för grid")
    parser.add_argument("--wf-train-size",      type=int, default=1000, help="Train-fönster för walk-forward grid")
    parser.add_argument("--wf-validation-size", type=int, default=300, help="Validation-fönster för walk-forward grid")
    parser.add_argument("--wf-test-size",       type=int, default=100, help="Test-fönster för walk-forward grid")
    parser.add_argument("--wf-step-size",       type=int, default=None, help="Steglängd för walk-forward grid (default = teststorlek)")

    # Strategiparametrar
    parser.add_argument("--edge-threshold",    type=float, default=0.00)
    parser.add_argument("--max-signs",         type=int,   default=2)
    parser.add_argument("--max-rows",          type=int,   default=20)
    parser.add_argument("--min-edge-sum",      type=float, default=None)
    parser.add_argument("--cost-per-row",      type=float, default=1.0)
    parser.add_argument("--start-draw",        type=int,   default=None)
    parser.add_argument("--end-draw",          type=int,   default=None)

    # Utdataalternativ
    parser.add_argument("--report",     type=str, default=None, help="Spara textrapport till fil")
    parser.add_argument("--json",       type=str, default=None, help="Exportera JSON-resultat")
    parser.add_argument("--round-log",  type=str, default=None, help="Exportera omgångslogg (CSV)")
    parser.add_argument("--calibration", type=str, default=None, help="Exportera kalibrering (CSV)")

    args = parser.parse_args()

    # --- Ladda data ---
    print("Laddar data...", end=" ", flush=True)
    try:
        if args.csv_matches and not args.csv_draws:
            parser.error("--csv-matches kräver också --csv-draws")

        if args.db:
            draws = load_from_sqlite(
                args.db,
                draws_table=args.draws_table,
                matches_table=args.matches_table,
                draw_column_map=DRAW_COLUMN_OVERRIDE or None,
                match_column_map=MATCH_COLUMN_OVERRIDE or None,
            )
        elif args.csv_draws:
            if not args.csv_matches:
                parser.error("--csv-draws kräver också --csv-matches")
            draws = load_from_csv(
                args.csv_draws,
                args.csv_matches,
                draw_column_map=DRAW_COLUMN_OVERRIDE or None,
                match_column_map=MATCH_COLUMN_OVERRIDE or None,
            )
        else:
            draws = load_from_postgres()
    except Exception as e:
        print(f"\nFel vid inläsning: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"{len(draws)} omgångar laddade.")

    # --- Walk-forward grid ---
    if args.grid and args.walk_forward:
        print("\nKör walk-forward grid...")
        folds = run_walk_forward_grid(
            draws=draws,
            start_draw=args.start_draw,
            end_draw=args.end_draw,
            train_size=args.wf_train_size,
            validation_size=args.wf_validation_size,
            test_size=args.wf_test_size,
            step_size=args.wf_step_size,
        )
        folds_df = walk_forward_grid_folds_to_dataframe(folds)
        summary_df = walk_forward_grid_summary_to_dataframe(folds)
        print("\nVald config per fold:")
        print(folds_df.to_string(index=False))
        print("\nÅterkommande config-typer på test:")
        print(summary_df.to_string(index=False))
        folds_df.to_csv("v7_walk_forward_folds.csv", index=False)
        summary_df.to_csv("v7_walk_forward_summary.csv", index=False)
        print("\nWalk-forward folddata sparad till: v7_walk_forward_folds.csv")
        print("Walk-forward sammanfattning sparad till: v7_walk_forward_summary.csv")
        return

    # --- Parametergrid ---
    if args.grid:
        print("\nKör parametergrid...")
        filtered_draws = [
            d for d in draws
            if (args.start_draw is None or d.draw_number >= args.start_draw)
            and (args.end_draw is None or d.draw_number <= args.end_draw)
        ]
        train_draws, holdout_draws = split_train_holdout(filtered_draws, holdout_fraction=args.holdout_pct)
        print(
            f"Train/holdout-split: {len(train_draws)} train, "
            f"{len(holdout_draws)} holdout ({args.holdout_pct:.0%} holdout)"
        )
        grid_results = run_parameter_grid(
            draws=draws,
            start_draw=args.start_draw,
            end_draw=args.end_draw,
            holdout_fraction=args.holdout_pct,
        )
        df = grid_to_dataframe(grid_results)
        print("\nAlla konfigurationer, sorterade på train ROI:")
        print(df.to_string(index=False))
        df.to_csv("v7_grid_results.csv", index=False)
        print("\nFullständigt grid sparat till: v7_grid_results.csv")
        return

    # --- Single-run backtest ---
    config = v7_config(
        edge_threshold=args.edge_threshold,
        max_signs_per_match=args.max_signs,
        max_rows_per_coupon=args.max_rows,
        min_edge_sum=args.min_edge_sum,
        cost_per_row=args.cost_per_row,
    )

    from core.backtest import run_backtest
    result = run_backtest(
        draws=draws,
        config=config,
        start_draw=args.start_draw,
        end_draw=args.end_draw,
    )

    # --- Rapport ---
    print_report(result, draws=draws, output_file=args.report)

    if args.json:
        export_json(result, args.json)

    if args.round_log:
        log_df = round_log(result, draws)
        log_df.to_csv(args.round_log, index=False)
        print(f"Omgångslogg sparad till: {args.round_log}")

    if args.calibration:
        cal_df = edge_calibration_report(result, draws)
        cal_df.to_csv(args.calibration, index=False)
        print(f"Kalibrering sparad till: {args.calibration}")

    # --- Walk-forward ---
    if args.walk_forward:
        print("\nKör walk-forward validering...")
        folds = run_walk_forward(
            draws=draws,
            config=config,
            train_size=500,
            test_size=100,
        )
        print(f"\n{'Fold':>4}  {'Test-omgångar':>18}  {'ROI':>10}  {'Vinster':>8}")
        print("-" * 50)
        for f in folds:
            r = f.test_result
            print(
                f"{f.fold_number:>4}  "
                f"{f.test_start}–{f.test_end}  "
                f"{r.roi:>+10.2%}  "
                f"{r.total_wins_8_correct:>8}"
            )


if __name__ == "__main__":
    main()
