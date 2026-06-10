"""
V7 – Ren market-vs-folk edge-strategi.

Denna modul definierar V7-strategin och ett verktyg för att köra
parametergrid-sökning över edge_threshold och max_signs_per_match.

Hypotes
-------
Folkets streckprocent (public_pct) avviker systematiskt från marknadens
implicita sannolikhet (market_pct). Matcher där folket undervärder ett
tecken (public_pct < market_pct) erbjuder bättre förväntad utdelning
per vunnen rad än vad sannolikheten motiverar.

V7 testar om denna signal är tillräcklig för positivt ROI, utan att
lägga till någon ytterligare prediktionsmodell.

Vad V7 INTE gör (avsiktligt):
- Ingen lagstyrke-modell
- Ingen ELO/Bradley-Terry
- Ingen kalibrering av folk-bias
- Ingen Kelly-skalning av kupongstorlek
- Ingen omgångsfiltrering baserat på entropi eller svårighetsgrad
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import pandas as pd

try:
    from ..core.backtest import StrategyConfig, WalkForwardFold, run_backtest, run_walk_forward
    from ..core.models import BacktestResult, DrawData
except ImportError:
    from core.backtest import StrategyConfig, WalkForwardFold, run_backtest, run_walk_forward
    from core.models import BacktestResult, DrawData


# ---------------------------------------------------------------------------
# Fördefinierade V7-konfigurationer
# ---------------------------------------------------------------------------

def v7_config(
    edge_threshold: float = 0.00,
    max_signs_per_match: int = 2,
    max_rows_per_coupon: Optional[int] = 20,
    min_edge_sum: Optional[float] = None,
    cost_per_row: float = 1.0,
    name: Optional[str] = None,
) -> StrategyConfig:
    """
    Skapar en V7-konfiguration med önskade parametrar.

    Standardvärden:
        edge_threshold=0.05  → tecken med folk% ≥ 5pp under market% tas med
        max_signs_per_match=3 → upp till 3 tecken per match
    """
    auto_name = (
        name or
        f"V7_edge{int(edge_threshold*100)}pct_max{max_signs_per_match}signs"
        + (f"_maxrows{max_rows_per_coupon}" if max_rows_per_coupon else "")
        + (f"_minedgesum{int(min_edge_sum*100)}pct" if min_edge_sum is not None else "")
    )
    return StrategyConfig(
        name=auto_name,
        edge_threshold=edge_threshold,
        max_signs_per_match=max_signs_per_match,
        max_rows_per_coupon=max_rows_per_coupon,
        cost_per_row=cost_per_row,
        min_edge_sum=min_edge_sum,
    )


# ---------------------------------------------------------------------------
# Parametergrid-sökning
# ---------------------------------------------------------------------------

@dataclass
class GridResult:
    """Resultat för en enskild konfiguration i grid-sökningen."""
    config: StrategyConfig
    train_result: BacktestResult
    holdout_result: Optional[BacktestResult] = None

    @property
    def result(self) -> BacktestResult:
        return self.train_result

    @property
    def roi(self) -> float:
        return self.train_result.roi

    @property
    def win_rate(self) -> float:
        return self.train_result.win_rate

    @property
    def avg_rows(self) -> float:
        return self.train_result.avg_rows_per_round

    @property
    def total_cost(self) -> float:
        return self.train_result.total_cost


@dataclass
class WalkForwardGridFold:
    """En walk-forward-fold med config vald på validation och testad framåt."""
    fold_number: int
    train_start: int
    train_end: int
    validation_start: int
    validation_end: int
    test_start: int
    test_end: int
    selected_config: StrategyConfig
    train_result: BacktestResult
    validation_result: BacktestResult
    test_result: BacktestResult


def split_train_holdout(
    draws: list[DrawData],
    holdout_fraction: float = 0.20,
) -> tuple[list[DrawData], list[DrawData]]:
    """
    Delar data kronologiskt i train och holdout.
    """
    if not 0 < holdout_fraction < 1:
        raise ValueError("holdout_fraction måste vara mellan 0 och 1")

    draws_sorted = sorted(draws, key=lambda d: d.draw_number)
    if len(draws_sorted) < 2:
        raise ValueError("Minst 2 omgångar krävs för train/holdout-split")

    holdout_size = max(1, int(round(len(draws_sorted) * holdout_fraction)))
    holdout_size = min(holdout_size, len(draws_sorted) - 1)
    split_idx = len(draws_sorted) - holdout_size
    return draws_sorted[:split_idx], draws_sorted[split_idx:]


def _resolve_grid_space(
    edge_thresholds: Optional[list[float]] = None,
    max_signs_options: Optional[list[int]] = None,
    max_rows_options: Optional[list[Optional[int]]] = None,
    min_edge_sums: Optional[list[Optional[float]]] = None,
) -> tuple[list[float], list[int], list[Optional[int]], list[Optional[float]]]:
    if edge_thresholds is None:
        edge_thresholds = [0.00, 0.01, 0.02, 0.03, 0.05]
    if max_signs_options is None:
        max_signs_options = [2, 3]
    if max_rows_options is None:
        max_rows_options = [10, 20, 30, 50, 100]
    if min_edge_sums is None:
        min_edge_sums = [None, 0.02, 0.05, 0.10]
    return edge_thresholds, max_signs_options, max_rows_options, min_edge_sums


def _build_grid_configs(
    edge_thresholds: Optional[list[float]] = None,
    max_signs_options: Optional[list[int]] = None,
    max_rows_options: Optional[list[Optional[int]]] = None,
    min_edge_sums: Optional[list[Optional[float]]] = None,
) -> list[StrategyConfig]:
    edge_thresholds, max_signs_options, max_rows_options, min_edge_sums = _resolve_grid_space(
        edge_thresholds=edge_thresholds,
        max_signs_options=max_signs_options,
        max_rows_options=max_rows_options,
        min_edge_sums=min_edge_sums,
    )
    configs: list[StrategyConfig] = []
    for threshold in edge_thresholds:
        for max_signs in max_signs_options:
            for max_rows in max_rows_options:
                for min_edge_sum in min_edge_sums:
                    configs.append(
                        v7_config(
                            edge_threshold=threshold,
                            max_signs_per_match=max_signs,
                            max_rows_per_coupon=max_rows,
                            min_edge_sum=min_edge_sum,
                        )
                    )
    return configs


def run_parameter_grid(
    draws: list[DrawData],
    edge_thresholds: Optional[list[float]] = None,
    max_signs_options: Optional[list[int]] = None,
    max_rows_options: Optional[list[Optional[int]]] = None,
    min_edge_sums: Optional[list[Optional[float]]] = None,
    start_draw: Optional[int] = None,
    end_draw: Optional[int] = None,
    holdout_fraction: Optional[float] = None,
    verbose: bool = True,
) -> list[GridResult]:
    """
    Kör ett parametergrid över V7-konfigurationer.

    Defaultvärden om ingenting anges:
        edge_thresholds  = [0.00, 0.01, 0.02, 0.03, 0.05]
        max_signs_options = [2, 3]
        max_rows_options  = [10, 20, 30, 50, 100]
        min_edge_sums     = [None, 0.02, 0.05, 0.10]

    Parametrar
    ----------
    draws:
        Historisk data att köra mot.
    start_draw / end_draw:
        Valfri avgränsning (t.ex. för out-of-sample-test).
    verbose:
        Skriver ut progress per konfiguration.

    Returnerar
    ----------
    list[GridResult] sorterad på ROI (högst först).
    """
    filtered_draws = [
        d for d in draws
        if (start_draw is None or d.draw_number >= start_draw)
        and (end_draw is None or d.draw_number <= end_draw)
    ]
    filtered_draws.sort(key=lambda d: d.draw_number)

    train_draws = filtered_draws
    holdout_draws: list[DrawData] = []
    if holdout_fraction is not None:
        train_draws, holdout_draws = split_train_holdout(filtered_draws, holdout_fraction)

    configs = _build_grid_configs(
        edge_thresholds=edge_thresholds,
        max_signs_options=max_signs_options,
        max_rows_options=max_rows_options,
        min_edge_sums=min_edge_sums,
    )
    results: list[GridResult] = []
    total = len(configs)

    for count, config in enumerate(configs, start=1):
        if verbose:
            print(
                f"[{count}/{total}] {config.name} ...",
                end=" ", flush=True
            )

        train_result = run_backtest(
            draws=train_draws,
            config=config,
        )
        holdout_result = (
            run_backtest(draws=holdout_draws, config=config)
            if holdout_draws else None
        )
        results.append(
            GridResult(
                config=config,
                train_result=train_result,
                holdout_result=holdout_result,
            )
        )
        if verbose:
            if holdout_result is None:
                print(
                    f"train_ROI={train_result.roi:+.2%}  "
                    f"train_wins={train_result.total_wins_8_correct}  "
                    f"train_avg_rows={train_result.avg_rows_per_round:.1f}"
                )
            else:
                print(
                    f"train_ROI={train_result.roi:+.2%}  "
                    f"holdout_ROI={holdout_result.roi:+.2%}  "
                    f"train_avg_rows={train_result.avg_rows_per_round:.1f}"
                )

    results.sort(key=lambda r: r.roi, reverse=True)
    return results


def run_walk_forward_grid(
    draws: list[DrawData],
    edge_thresholds: Optional[list[float]] = None,
    max_signs_options: Optional[list[int]] = None,
    max_rows_options: Optional[list[Optional[int]]] = None,
    min_edge_sums: Optional[list[Optional[float]]] = None,
    train_size: int = 1000,
    validation_size: int = 300,
    test_size: int = 100,
    step_size: Optional[int] = None,
    start_draw: Optional[int] = None,
    end_draw: Optional[int] = None,
    target_rows_min: float = 10.0,
    target_rows_max: float = 50.0,
    verbose: bool = True,
) -> list[WalkForwardGridFold]:
    """
    Walk-forward över config-space:
    träna 1000, validera 300, testa nästa 100, flytta fram och upprepa.
    """
    filtered_draws = [
        d for d in draws
        if (start_draw is None or d.draw_number >= start_draw)
        and (end_draw is None or d.draw_number <= end_draw)
    ]
    filtered_draws.sort(key=lambda d: d.draw_number)

    if step_size is None:
        step_size = test_size
    if step_size <= 0:
        raise ValueError("step_size måste vara > 0")

    min_required = train_size + validation_size + test_size
    if len(filtered_draws) < min_required:
        raise ValueError(
            f"För få omgångar för walk-forward: kräver minst {min_required}, "
            f"fick {len(filtered_draws)}"
        )

    configs = _build_grid_configs(
        edge_thresholds=edge_thresholds,
        max_signs_options=max_signs_options,
        max_rows_options=max_rows_options,
        min_edge_sums=min_edge_sums,
    )

    folds: list[WalkForwardGridFold] = []
    fold_number = 0
    start_idx = 0

    while start_idx + min_required <= len(filtered_draws):
        train_draws = filtered_draws[start_idx:start_idx + train_size]
        validation_start_idx = start_idx + train_size
        validation_end_idx = validation_start_idx + validation_size
        validation_draws = filtered_draws[validation_start_idx:validation_end_idx]
        test_start_idx = validation_end_idx
        test_end_idx = test_start_idx + test_size
        test_draws = filtered_draws[test_start_idx:test_end_idx]

        if len(test_draws) < test_size:
            break

        fold_number += 1
        best_candidate = None

        for config in configs:
            train_result = run_backtest(train_draws, config)
            validation_result = run_backtest(validation_draws, config)
            rows_in_band = (
                target_rows_min <= train_result.avg_rows_per_round <= target_rows_max
                and target_rows_min <= validation_result.avg_rows_per_round <= target_rows_max
            )
            candidate = (config, train_result, validation_result, rows_in_band)
            if best_candidate is None or _walk_forward_candidate_key(candidate) > _walk_forward_candidate_key(best_candidate):
                best_candidate = candidate

        assert best_candidate is not None
        selected_config, train_result, validation_result, _ = best_candidate
        test_result = run_backtest(test_draws, selected_config)

        fold = WalkForwardGridFold(
            fold_number=fold_number,
            train_start=train_draws[0].draw_number,
            train_end=train_draws[-1].draw_number,
            validation_start=validation_draws[0].draw_number,
            validation_end=validation_draws[-1].draw_number,
            test_start=test_draws[0].draw_number,
            test_end=test_draws[-1].draw_number,
            selected_config=selected_config,
            train_result=train_result,
            validation_result=validation_result,
            test_result=test_result,
        )
        folds.append(fold)

        if verbose:
            print(
                f"[fold {fold.fold_number}] train {fold.train_start}-{fold.train_end}  "
                f"val {fold.validation_start}-{fold.validation_end}  "
                f"test {fold.test_start}-{fold.test_end}  "
                f"val_ROI={validation_result.roi:+.2%}  "
                f"test_ROI={test_result.roi:+.2%}  "
                f"cfg={selected_config.name}"
            )

        start_idx += step_size

    return folds


def grid_to_dataframe(grid_results: list[GridResult]) -> pd.DataFrame:
    """
    Konverterar grid-resultat till en pandas DataFrame för enkel analys.

    Kolumner:
        strategy, edge_threshold, max_signs, max_rows,
        rounds_played, rounds_skipped,
        total_cost, total_payout, net,
        roi, win_rate,
        total_wins, avg_rows, avg_cost_per_round
    """
    rows = []
    for gr in grid_results:
        train_metrics = _result_metrics(gr.train_result)
        holdout_metrics = (
            _result_metrics(gr.holdout_result)
            if gr.holdout_result is not None else None
        )
        p = gr.config
        row = {
            "strategy":           p.name,
            "edge_threshold":     p.edge_threshold,
            "max_signs":          p.max_signs_per_match,
            "max_rows":           p.max_rows_per_coupon,
            "min_edge_sum":       p.min_edge_sum,
            "rows_target_10_50":  10 <= train_metrics["avg_rows"] <= 50,
            "train_avg_rows":     train_metrics["avg_rows"],
            "train_roi":          train_metrics["roi"],
            "train_profit_kr":    train_metrics["profit_kr"],
            "train_wins":         train_metrics["wins"],
            "train_max_drawdown": train_metrics["max_drawdown"],
        }
        if holdout_metrics is not None:
            row.update({
                "holdout_avg_rows":     holdout_metrics["avg_rows"],
                "holdout_roi":          holdout_metrics["roi"],
                "holdout_profit_kr":    holdout_metrics["profit_kr"],
                "holdout_wins":         holdout_metrics["wins"],
                "holdout_max_drawdown": holdout_metrics["max_drawdown"],
            })
        rows.append(row)
    return pd.DataFrame(rows)


def walk_forward_grid_folds_to_dataframe(folds: list[WalkForwardGridFold]) -> pd.DataFrame:
    rows = []
    for fold in folds:
        train_metrics = _result_metrics(fold.train_result)
        validation_metrics = _result_metrics(fold.validation_result)
        test_metrics = _result_metrics(fold.test_result)
        rows.append({
            "fold": fold.fold_number,
            "train_start": fold.train_start,
            "train_end": fold.train_end,
            "validation_start": fold.validation_start,
            "validation_end": fold.validation_end,
            "test_start": fold.test_start,
            "test_end": fold.test_end,
            "selected_strategy": fold.selected_config.name,
            "selected_edge_threshold": fold.selected_config.edge_threshold,
            "selected_max_signs": fold.selected_config.max_signs_per_match,
            "selected_max_rows": fold.selected_config.max_rows_per_coupon,
            "selected_min_edge_sum": fold.selected_config.min_edge_sum,
            "train_avg_rows": train_metrics["avg_rows"],
            "train_roi": train_metrics["roi"],
            "train_profit_kr": train_metrics["profit_kr"],
            "train_wins": train_metrics["wins"],
            "train_max_drawdown": train_metrics["max_drawdown"],
            "validation_avg_rows": validation_metrics["avg_rows"],
            "validation_roi": validation_metrics["roi"],
            "validation_profit_kr": validation_metrics["profit_kr"],
            "validation_wins": validation_metrics["wins"],
            "validation_max_drawdown": validation_metrics["max_drawdown"],
            "test_avg_rows": test_metrics["avg_rows"],
            "test_roi": test_metrics["roi"],
            "test_profit_kr": test_metrics["profit_kr"],
            "test_wins": test_metrics["wins"],
            "test_max_drawdown": test_metrics["max_drawdown"],
            "test_positive": fold.test_result.net > 0,
        })
    return pd.DataFrame(rows)


def walk_forward_grid_summary_to_dataframe(folds: list[WalkForwardGridFold]) -> pd.DataFrame:
    groups: dict[tuple, dict] = {}
    for fold in folds:
        key = (
            fold.selected_config.edge_threshold,
            fold.selected_config.max_signs_per_match,
            fold.selected_config.max_rows_per_coupon,
            fold.selected_config.min_edge_sum,
        )
        state = groups.setdefault(key, {
            "edge_threshold": fold.selected_config.edge_threshold,
            "max_signs": fold.selected_config.max_signs_per_match,
            "max_rows": fold.selected_config.max_rows_per_coupon,
            "min_edge_sum": fold.selected_config.min_edge_sum,
            "selected_folds": 0,
            "positive_test_folds": 0,
            "total_test_profit_kr": 0.0,
            "total_test_wins": 0,
            "test_rows_sum": 0.0,
            "test_roi_sum": 0.0,
            "worst_test_drawdown": 0,
        })
        test_metrics = _result_metrics(fold.test_result)
        state["selected_folds"] += 1
        state["positive_test_folds"] += int(fold.test_result.net > 0)
        state["total_test_profit_kr"] += fold.test_result.net
        state["total_test_wins"] += fold.test_result.total_wins_8_correct
        state["test_rows_sum"] += fold.test_result.avg_rows_per_round
        state["test_roi_sum"] += fold.test_result.roi
        state["worst_test_drawdown"] = max(state["worst_test_drawdown"], test_metrics["max_drawdown"])

    rows = []
    for state in groups.values():
        selected_folds = state["selected_folds"]
        rows.append({
            "edge_threshold": state["edge_threshold"],
            "max_signs": state["max_signs"],
            "max_rows": state["max_rows"],
            "min_edge_sum": state["min_edge_sum"],
            "selected_folds": selected_folds,
            "positive_test_folds": state["positive_test_folds"],
            "avg_test_rows": round(state["test_rows_sum"] / selected_folds, 1),
            "avg_test_roi": round(state["test_roi_sum"] / selected_folds, 6),
            "total_test_profit_kr": round(state["total_test_profit_kr"], 2),
            "total_test_wins": state["total_test_wins"],
            "worst_test_drawdown": state["worst_test_drawdown"],
        })

    df = pd.DataFrame(rows)
    if df.empty:
        return df
    return df.sort_values(
        by=["positive_test_folds", "selected_folds", "avg_test_roi", "total_test_profit_kr"],
        ascending=[False, False, False, False],
    ).reset_index(drop=True)


def _result_metrics(result: BacktestResult) -> dict[str, float]:
    max_drawdown = 0
    current_drawdown = 0
    for coupon in result.coupon_results:
        if coupon.eight_correct_count == 0:
            current_drawdown += 1
            max_drawdown = max(max_drawdown, current_drawdown)
        else:
            current_drawdown = 0

    return {
        "avg_rows": round(result.avg_rows_per_round, 1),
        "roi": round(result.roi, 6),
        "profit_kr": round(result.net, 2),
        "wins": result.total_wins_8_correct,
        "max_drawdown": max_drawdown,
    }


def _walk_forward_candidate_key(candidate) -> tuple:
    config, train_result, validation_result, rows_in_band = candidate
    return (
        rows_in_band,
        validation_result.roi,
        train_result.roi,
        validation_result.net,
        train_result.net,
        -config.edge_threshold,
    )
