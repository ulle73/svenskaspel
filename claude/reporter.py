"""
Topptipset backtest – rapportgenerator.

Producerar reproducerbara nyckeltal, drawdown-analys och
edge-kalibrering för V7-backtestet.

Alla beräkningar är deterministiska och side-effect-fria.
"""
from __future__ import annotations

import json
import math
from datetime import datetime
from typing import Optional

import pandas as pd

from ..core.models import BacktestResult, CouponResult


# ---------------------------------------------------------------------------
# Aggregerade nyckeltal
# ---------------------------------------------------------------------------

def summary_stats(result: BacktestResult) -> dict:
    """
    Beräknar en komplett uppsättning nyckeltal för ett backtest.

    Returnerar en dict med alla nyckeltal, lämplig för JSON-export
    eller vidare bearbetning.
    """
    cr = result.coupon_results

    rows_distribution = [c.num_rows for c in cr]
    payouts = [c.total_payout for c in cr]
    wins = [c for c in cr if c.eight_correct_count > 0]

    # ROI per omgång (för volatilitetsberäkning)
    per_round_roi = [c.net / c.total_cost if c.total_cost > 0 else 0.0 for c in cr]

    # Longest drawdown (omgångar utan 8-rätt)
    max_dd_rounds, max_dd_cost = _compute_drawdown(cr)

    return {
        "strategy":               result.strategy_name,
        "params":                 result.strategy_params,
        "rounds_played":          result.rounds_played,
        "rounds_skipped":         result.rounds_skipped,
        "total_cost_kr":          round(result.total_cost, 2),
        "total_payout_kr":        round(result.total_payout, 2),
        "net_kr":                 round(result.net, 2),
        "roi":                    round(result.roi, 6),
        "roi_pct":                f"{result.roi:+.2%}",
        "win_rate":               round(result.win_rate, 6),
        "win_rate_pct":           f"{result.win_rate:.2%}",
        "total_wins_8_correct":   result.total_wins_8_correct,
        "avg_rows_per_round":     round(result.avg_rows_per_round, 1),
        "avg_cost_per_round_kr":  round(result.avg_cost_per_round, 2),
        "median_rows_per_round":  float(round(_median(rows_distribution), 1)),
        "min_rows":               min(rows_distribution) if rows_distribution else 0,
        "max_rows":               max(rows_distribution) if rows_distribution else 0,
        "total_8_correct_rows":   sum(c.eight_correct_count for c in cr),
        "avg_payout_per_win_kr":  round(
            sum(c.total_payout for c in wins) / len(wins), 2
        ) if wins else 0.0,
        "max_drawdown_rounds":    max_dd_rounds,
        "max_drawdown_cost_kr":   round(max_dd_cost, 2),
        "roi_volatility":         round(_std(per_round_roi), 6),
        "sharpe_approx":          round(
            (result.roi / _std(per_round_roi)) if _std(per_round_roi) > 0 else 0.0, 4
        ),
    }


def _median(values: list) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    n = len(s)
    return (s[n // 2] + s[(n - 1) // 2]) / 2


def _std(values: list) -> float:
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    variance = sum((v - mean) ** 2 for v in values) / (len(values) - 1)
    return math.sqrt(variance)


def _compute_drawdown(coupon_results: list[CouponResult]) -> tuple[int, float]:
    """
    Beräknar längsta sammanhängande period utan 8-rätt och
    den ackumulerade kostnaden under den perioden.

    Returnerar (max_rounds_without_win, total_cost_during_drawdown).
    """
    max_rounds = 0
    max_cost   = 0.0
    current_rounds = 0
    current_cost   = 0.0

    for c in coupon_results:
        if c.eight_correct_count == 0:
            current_rounds += 1
            current_cost   += c.total_cost
            if current_rounds > max_rounds:
                max_rounds = current_rounds
                max_cost   = current_cost
        else:
            current_rounds = 0
            current_cost   = 0.0

    return max_rounds, max_cost


# ---------------------------------------------------------------------------
# Edge-kalibrering: är market% en bra sannolikhetsestimering?
# ---------------------------------------------------------------------------

def edge_calibration_report(result: BacktestResult, draws) -> pd.DataFrame:
    """
    Analyserar hur väl marknadssannolikheten (market_pct) kalibreras mot
    faktiska utfall, uppdelat på deciler av market_pct.

    Parametrar
    ----------
    result:     BacktestResult (för att identifiera vilka omgångar spelades)
    draws:      list[DrawData] – hela dataset

    Returnerar
    ----------
    DataFrame med kolumner:
        bucket, market_pct_range, n_signs, actual_hit_rate,
        avg_market_pct, avg_public_pct, avg_edge
    """
    from ..core.edge import compute_match_edges

    played_draw_numbers = {c.draw_number for c in result.coupon_results}
    rows = []

    for draw in draws:
        if draw.draw_number not in played_draw_numbers:
            continue
        for match in draw.matches:
            for edge in compute_match_edges(match):
                rows.append({
                    "market_pct":  edge.market_pct,
                    "public_pct":  edge.public_pct,
                    "edge":        edge.edge,
                    "is_correct":  int(edge.is_correct),
                })

    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows)
    df["bucket"] = pd.qcut(df["market_pct"], q=10, labels=False, duplicates="drop")

    cal = df.groupby("bucket").agg(
        n_signs=("is_correct", "count"),
        actual_hit_rate=("is_correct", "mean"),
        avg_market_pct=("market_pct", "mean"),
        avg_public_pct=("public_pct", "mean"),
        avg_edge=("edge", "mean"),
    ).reset_index()

    cal["market_pct_range"] = cal["avg_market_pct"].apply(
        lambda x: f"{x:.0%}"
    )
    cal["calibration_error"] = (
        cal["actual_hit_rate"] - cal["avg_market_pct"]
    ).round(4)

    return cal


# ---------------------------------------------------------------------------
# Detaljerad omgångslogg
# ---------------------------------------------------------------------------

def round_log(result: BacktestResult, draws) -> pd.DataFrame:
    """
    Producerar en rad per spelad omgång med nyckeltal.

    Användbart för att identifiera specifika vinstomgångar och
    undersöka om det finns temporala mönster.
    """
    draw_lookup = {d.draw_number: d for d in draws}
    rows = []

    for c in result.coupon_results:
        draw = draw_lookup.get(c.draw_number)
        rows.append({
            "draw_number":       c.draw_number,
            "date":              draw.draw_start.date() if draw and draw.draw_start else None,
            "winning_row":       c.winning_row,
            "num_rows":          c.num_rows,
            "cost_kr":           round(c.total_cost, 2),
            "payout_kr":         round(c.total_payout, 2),
            "net_kr":            round(c.net, 2),
            "roi":               round(c.roi, 4),
            "eight_correct":     c.eight_correct_count,
            "payout_8_correct":  round(c.payout_8_correct, 2),
            "turnover":          round(draw.turnover, 0) if draw and draw.turnover else None,
            "num_winners":       draw.num_winners if draw else None,
        })

    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Textrapport (skriv ut till stdout eller fil)
# ---------------------------------------------------------------------------

def print_report(result: BacktestResult, draws=None, output_file: Optional[str] = None):
    """
    Skriver en läsbar textrapport med alla nyckeltal.

    Om output_file anges sparas rapporten till fil (UTF-8).
    """
    stats = summary_stats(result)
    lines = [
        "=" * 60,
        f"Topptipset Backtest – {stats['strategy']}",
        f"Kördes: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "=" * 60,
        "",
        "PARAMETRAR",
        "-" * 40,
    ]
    for k, v in stats["params"].items():
        lines.append(f"  {k:<28} {v}")

    lines += [
        "",
        "OMGÅNGAR",
        "-" * 40,
        f"  Spelade omgångar:           {stats['rounds_played']:>8}",
        f"  Hoppade (filter):           {stats['rounds_skipped']:>8}",
        "",
        "EKONOMI",
        "-" * 40,
        f"  Total insats:               {stats['total_cost_kr']:>10.2f} kr",
        f"  Total utdelning:            {stats['total_payout_kr']:>10.2f} kr",
        f"  Netto:                      {stats['net_kr']:>+10.2f} kr",
        f"  ROI:                        {stats['roi_pct']:>10}",
        "",
        "KUPONGSTORLEK",
        "-" * 40,
        f"  Snitt rader/omgång:         {stats['avg_rows_per_round']:>8.1f}",
        f"  Median rader/omgång:        {stats['median_rows_per_round']:>8.1f}",
        f"  Min rader:                  {stats['min_rows']:>8}",
        f"  Max rader:                  {stats['max_rows']:>8}",
        f"  Snitt kostnad/omgång:       {stats['avg_cost_per_round_kr']:>10.2f} kr",
        "",
        "VINSTER",
        "-" * 40,
        f"  Antal 8-rätt (omgångar):    {stats['total_wins_8_correct']:>8}",
        f"  Vinstfrekvens:              {stats['win_rate_pct']:>10}",
        f"  Snitt utdelning/vinst:      {stats['avg_payout_per_win_kr']:>10.2f} kr",
        "",
        "RISK",
        "-" * 40,
        f"  Max drawdown (omgångar):    {stats['max_drawdown_rounds']:>8}",
        f"  Max drawdown (kostnad kr):  {stats['max_drawdown_cost_kr']:>10.2f}",
        f"  ROI-volatilitet:            {stats['roi_volatility']:>10.6f}",
        f"  Sharpe (approximation):     {stats['sharpe_approx']:>10.4f}",
        "",
        "=" * 60,
    ]

    output = "\n".join(lines)
    print(output)

    if output_file:
        with open(output_file, "w", encoding="utf-8") as f:
            f.write(output)
        print(f"\nRapport sparad till: {output_file}")


def export_json(result: BacktestResult, path: str):
    """Exporterar summary_stats till JSON för reproducerbarhet."""
    stats = summary_stats(result)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)
    print(f"JSON exporterad till: {path}")
