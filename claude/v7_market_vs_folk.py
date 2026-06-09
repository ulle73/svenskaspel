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

from ..core.backtest import StrategyConfig, WalkForwardFold, run_backtest, run_walk_forward
from ..core.models import BacktestResult, DrawData


# ---------------------------------------------------------------------------
# Fördefinierade V7-konfigurationer
# ---------------------------------------------------------------------------

def v7_config(
    edge_threshold: float = 0.05,
    max_signs_per_match: int = 3,
    max_rows_per_coupon: Optional[int] = None,
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
    result: BacktestResult

    @property
    def roi(self) -> float:
        return self.result.roi

    @property
    def win_rate(self) -> float:
        return self.result.win_rate

    @property
    def avg_rows(self) -> float:
        return self.result.avg_rows_per_round

    @property
    def total_cost(self) -> float:
        return self.result.total_cost


def run_parameter_grid(
    draws: list[DrawData],
    edge_thresholds: Optional[list[float]] = None,
    max_signs_options: Optional[list[int]] = None,
    max_rows_options: Optional[list[Optional[int]]] = None,
    start_draw: Optional[int] = None,
    end_draw: Optional[int] = None,
    verbose: bool = True,
) -> list[GridResult]:
    """
    Kör ett parametergrid över V7-konfigurationer.

    Defaultvärden om ingenting anges:
        edge_thresholds  = [0.0, 0.02, 0.05, 0.08, 0.10, 0.15]
        max_signs_options = [1, 2, 3]
        max_rows_options  = [None]  (ingen begränsning)

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
    if edge_thresholds is None:
        edge_thresholds = [0.0, 0.02, 0.05, 0.08, 0.10, 0.15]
    if max_signs_options is None:
        max_signs_options = [1, 2, 3]
    if max_rows_options is None:
        max_rows_options = [None]

    results: list[GridResult] = []
    total = len(edge_thresholds) * len(max_signs_options) * len(max_rows_options)
    count = 0

    for threshold in edge_thresholds:
        for max_signs in max_signs_options:
            for max_rows in max_rows_options:
                count += 1
                config = v7_config(
                    edge_threshold=threshold,
                    max_signs_per_match=max_signs,
                    max_rows_per_coupon=max_rows,
                )
                if verbose:
                    print(
                        f"[{count}/{total}] {config.name} ...",
                        end=" ", flush=True
                    )
                result = run_backtest(
                    draws=draws,
                    config=config,
                    start_draw=start_draw,
                    end_draw=end_draw,
                )
                results.append(GridResult(config=config, result=result))
                if verbose:
                    print(
                        f"ROI={result.roi:+.2%}  "
                        f"wins={result.total_wins_8_correct}  "
                        f"avg_rows={result.avg_rows_per_round:.1f}"
                    )

    results.sort(key=lambda r: r.roi, reverse=True)
    return results


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
        r = gr.result
        p = gr.config
        rows.append({
            "strategy":           p.name,
            "edge_threshold":     p.edge_threshold,
            "max_signs":          p.max_signs_per_match,
            "max_rows":           p.max_rows_per_coupon,
            "rounds_played":      r.rounds_played,
            "rounds_skipped":     r.rounds_skipped,
            "total_cost":         round(r.total_cost, 2),
            "total_payout":       round(r.total_payout, 2),
            "net":                round(r.net, 2),
            "roi":                round(r.roi, 6),
            "win_rate":           round(r.win_rate, 6),
            "total_wins_8":       r.total_wins_8_correct,
            "avg_rows":           round(r.avg_rows_per_round, 1),
            "avg_cost_per_round": round(r.avg_cost_per_round, 2),
        })
    return pd.DataFrame(rows)
