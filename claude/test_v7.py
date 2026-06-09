"""
Topptipset backtest – enhetstester.

Kör med: python -m pytest tests/test_v7.py -v
eller:   python tests/test_v7.py

Alla tester använder syntetisk data för att verifiera korrekthet
oberoende av den faktiska databasen.
"""
from __future__ import annotations

import sys
import traceback
from datetime import datetime

# Lägg till projektrooten i path
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import importlib, types, sys as _sys

# Gör paketen importerbara utan installation
_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _root not in _sys.path:
    _sys.path.insert(0, _root)

from topptipset_backtest.core.models import DrawData, MatchData, GeneratedRow
from topptipset_backtest.core.edge import (
    compute_match_edges,
    select_signs_for_match,
    select_signs_for_draw,
    expand_coupon,
    coupon_size,
)
from topptipset_backtest.core.backtest import StrategyConfig, run_backtest
from topptipset_backtest.strategies.v7_market_vs_folk import v7_config, run_parameter_grid


# ---------------------------------------------------------------------------
# Hjälpfunktioner för syntetisk data
# ---------------------------------------------------------------------------

def make_match(
    draw_number: int = 1,
    event_number: int = 1,
    actual_outcome: str = "1",
    market_pct: tuple = (0.5, 0.3, 0.2),
    public_pct: tuple = (0.5, 0.3, 0.2),
) -> MatchData:
    return MatchData(
        draw_number=draw_number,
        event_number=event_number,
        home_team="Hemmalag",
        away_team="Bortalag",
        actual_outcome=actual_outcome,
        market_pct_home=market_pct[0],
        market_pct_draw=market_pct[1],
        market_pct_away=market_pct[2],
        public_pct_home=public_pct[0],
        public_pct_draw=public_pct[1],
        public_pct_away=public_pct[2],
    )


def make_draw(
    draw_number: int = 1,
    winning_row: str = "11111111",
    payout: float = 1_000_000.0,
    matches_override=None,
) -> DrawData:
    if matches_override is not None:
        matches = matches_override
    else:
        # Alla matcher: 1 vinner, marknad och folk lika
        matches = tuple(
            make_match(
                draw_number=draw_number,
                event_number=i + 1,
                actual_outcome=winning_row[i],
            )
            for i in range(8)
        )
    return DrawData(
        draw_number=draw_number,
        actual_winning_row=winning_row,
        payout_8_correct=payout,
        matches=matches,
    )


# ---------------------------------------------------------------------------
# Tester
# ---------------------------------------------------------------------------

PASSED = []
FAILED = []


def test(name):
    def decorator(fn):
        def wrapper():
            try:
                fn()
                PASSED.append(name)
                print(f"  ✓ {name}")
            except Exception as e:
                FAILED.append((name, str(e)))
                print(f"  ✗ {name}: {e}")
                traceback.print_exc()
        return wrapper
    return decorator


@test("Edge-beräkning: positivt edge när folk överstreckar")
def test_positive_edge():
    match = make_match(
        market_pct=(0.50, 0.30, 0.20),
        public_pct=(0.60, 0.25, 0.15),  # folk 10pp mer på 1
    )
    edges = compute_match_edges(match)
    edge_1 = next(e for e in edges if e.sign == "1")
    assert abs(edge_1.edge - 0.10) < 1e-9, f"Förväntat 0.10, fick {edge_1.edge}"


@test("Edge-beräkning: negativt edge när folk understreckar")
def test_negative_edge():
    match = make_match(
        market_pct=(0.50, 0.30, 0.20),
        public_pct=(0.40, 0.30, 0.30),  # folk 10pp mindre på 1
    )
    edges = compute_match_edges(match)
    edge_1 = next(e for e in edges if e.sign == "1")
    assert abs(edge_1.edge - (-0.10)) < 1e-9


@test("Teckenval: tecknet med lägst edge väljs primärt")
def test_primary_sign_selection():
    match = make_match(
        market_pct=(0.50, 0.30, 0.20),
        public_pct=(0.40, 0.30, 0.30),
        # edge: 1=-0.10, X=0.00, 2=+0.10
        # primärt borde vara "1" (lägst edge = -0.10)
    )
    sel = select_signs_for_match(match, edge_threshold=0.05)
    assert sel.primary_sign == "1", f"Förväntat '1', fick '{sel.primary_sign}'"


@test("Teckenval: threshold 0.05 → tar med alla underbet-tecken ≥5pp")
def test_threshold_selection():
    match = make_match(
        market_pct=(0.50, 0.30, 0.20),
        public_pct=(0.40, 0.22, 0.38),
        # edge: 1=-0.10, X=-0.08, 2=+0.18
        # med threshold=0.05: 1 (edge=-0.10) ✓, X (edge=-0.08) ✓, 2 (edge=+0.18) ✗
    )
    sel = select_signs_for_match(match, edge_threshold=0.05)
    assert "1" in sel.selected_signs, "1 borde vara valt"
    assert "X" in sel.selected_signs, "X borde vara valt"
    assert "2" not in sel.selected_signs, "2 borde INTE vara valt"


@test("Teckenval: threshold 0.20 → ingen sign uppfyller, tar primärsign")
def test_high_threshold_fallback():
    match = make_match(
        market_pct=(0.50, 0.30, 0.20),
        public_pct=(0.45, 0.30, 0.25),
        # max negativ edge: -0.05 (under threshold 0.20)
    )
    sel = select_signs_for_match(match, edge_threshold=0.20)
    assert len(sel.selected_signs) == 1, f"Förväntat 1 sign, fick {sel.selected_signs}"
    assert sel.selected_signs[0] == sel.primary_sign


@test("Kupongexpansion: 1 sign per match = 1 rad")
def test_single_sign_expansion():
    matches = [
        make_match(event_number=i + 1, actual_outcome="1")
        for i in range(8)
    ]
    draw = make_draw(matches_override=tuple(matches))
    selections = select_signs_for_draw(draw, edge_threshold=100.0)  # Extrem threshold
    rows = expand_coupon(selections)
    assert len(rows) == 1, f"Förväntat 1 rad, fick {len(rows)}"


@test("Kupongexpansion: 3 signs per match = 6561 rader")
def test_full_expansion():
    # Alla matcher har stark underbet på alla tecken
    matches = tuple(
        make_match(
            event_number=i + 1,
            actual_outcome="1",
            market_pct=(0.50, 0.30, 0.20),
            public_pct=(0.20, 0.10, 0.05),  # folk understreckar allt kraftigt
        )
        for i in range(8)
    )
    draw = make_draw(matches_override=matches)
    selections = select_signs_for_draw(draw, edge_threshold=0.01, max_signs_per_match=3)
    n = coupon_size(selections)
    rows = expand_coupon(selections)
    assert n == 3 ** 8, f"coupon_size: förväntat {3**8}, fick {n}"
    assert len(rows) == 3 ** 8, f"expand: förväntat {3**8}, fick {len(rows)}"


@test("GeneratedRow: korrekt räkning av rätta tecken")
def test_correct_count():
    # rad:     1  X  1  2  1  X  2  1
    # vinnare: 1  X  1  X  1  1  2  X
    # match:   ✓  ✓  ✓  ✗  ✓  ✗  ✓  ✗  → 5 rätt
    row = GeneratedRow(row=("1", "X", "1", "2", "1", "X", "2", "1"))
    assert row.correct_count("1X1X112X") == 5, f"Fick {row.correct_count('1X1X112X')}"

    # Exakt match
    exact = "1X121X21"
    assert row.correct_count(exact) == 8, f"Exakt match: fick {row.correct_count(exact)}"
    assert row.is_eight_correct(exact)

    # Ingen match
    none_match = "2122X12X"
    # rad:     1  X  1  2  1  X  2  1
    # vinnare: 2  1  2  2  X  1  2  X
    # match:   ✗  ✗  ✗  ✓  ✗  ✗  ✓  ✗  → 2 rätt
    assert not row.is_eight_correct(none_match)


@test("CouponResult: nettovärde beräknas korrekt")
def test_coupon_result_net():
    from topptipset_backtest.core.models import CouponResult
    rows = tuple(
        GeneratedRow(row=("1",) * 8)
        for _ in range(10)
    )
    # Vinnarkombination matchar 3 av 10 rader
    winning = "1" * 8
    coupon = CouponResult(
        draw_number=1,
        num_rows=10,
        cost_per_row=1.0,
        rows=rows,
        winning_row=winning,
        payout_8_correct=500_000.0,
    )
    assert coupon.eight_correct_count == 10
    assert coupon.total_cost == 10.0
    assert coupon.total_payout == 10 * 500_000.0
    assert coupon.net == 10 * 500_000.0 - 10.0


@test("Backtest: ingen vinstomgång utan träff")
def test_no_win_without_match():
    # Strategi med threshold=100 (extrem) → tar bara primärtecknet (lägst edge)
    # Alla matcher: marknaden föredrar '1' (50%), folket överstreckar '2' (40%)
    # edge: 1 = 0.40-0.50 = -0.10 (primärt, lägst edge → vald)
    # men faktiskt utfall är "2" → ingen 8-rätt
    matches = tuple(
        make_match(
            event_number=i + 1,
            actual_outcome="2",
            market_pct=(0.50, 0.30, 0.20),
            public_pct=(0.40, 0.30, 0.30),
            # edge: 1=-0.10 (primärt), X=0.00, 2=+0.10
            # med max_signs=1 → bara "1" väljs (primärtecken med lägst edge -0.10)
            # men utfallet är "2" → ingen träff
        )
        for i in range(8)
    )
    draw = make_draw(
        winning_row="22222222",
        matches_override=matches,
    )
    config = v7_config(edge_threshold=0.05, max_signs_per_match=1)
    result = run_backtest([draw], config)
    assert result.total_wins_8_correct == 0, (
        f"Förväntat 0 vinster, fick {result.total_wins_8_correct}. "
        f"Kupongstorlek: {result.coupon_results[0].num_rows if result.coupon_results else 'N/A'}"
    )
    assert result.total_payout == 0.0


@test("Backtest: vinst registreras när kupong täcker vinnarkombinationen")
def test_win_registered():
    # Alla matcher har stark underbet på ALLA tecken → full expansion → täcker all rader
    matches = tuple(
        make_match(
            event_number=i + 1,
            actual_outcome="X",
            market_pct=(0.50, 0.30, 0.20),
            public_pct=(0.20, 0.10, 0.05),  # drastisk underbet → alla 3 signs valda
        )
        for i in range(8)
    )
    draw = make_draw(
        winning_row="XXXXXXXX",
        payout=1_000_000.0,
        matches_override=matches,
    )
    config = v7_config(edge_threshold=0.01, max_signs_per_match=3)
    result = run_backtest([draw], config)
    assert result.total_wins_8_correct == 1, f"Förväntat 1 vinst, fick {result.total_wins_8_correct}"
    assert result.total_payout == 1_000_000.0


@test("Backtest ROI: positiv ROI när utdelning > insats")
def test_positive_roi():
    matches = tuple(
        make_match(
            event_number=i + 1,
            actual_outcome="X",
            market_pct=(0.50, 0.30, 0.20),
            public_pct=(0.20, 0.10, 0.05),
        )
        for i in range(8)
    )
    draw = make_draw(
        winning_row="XXXXXXXX",
        payout=1_000_000.0,
        matches_override=matches,
    )
    config = v7_config(edge_threshold=0.01, max_signs_per_match=3)
    result = run_backtest([draw], config)
    assert result.roi > 0, f"Förväntat positiv ROI, fick {result.roi}"


@test("DrawData: ValidationError om winning_row inte matchar matcher")
def test_validation_mismatch():
    matches = tuple(
        make_match(event_number=i + 1, actual_outcome="1")
        for i in range(8)
    )
    try:
        DrawData(
            draw_number=99,
            actual_winning_row="2X2X2X2X",  # Fel row
            payout_8_correct=1_000_000.0,
            matches=matches,
        )
        assert False, "Borde ha kastat ValueError"
    except ValueError:
        pass  # Förväntat


@test("DrawData: ValidationError om inte exakt 8 matcher")
def test_validation_wrong_match_count():
    matches = tuple(
        make_match(event_number=i + 1, actual_outcome="1")
        for i in range(7)  # Bara 7 matcher
    )
    try:
        DrawData(
            draw_number=99,
            actual_winning_row="11111111",
            payout_8_correct=1_000_000.0,
            matches=matches,
        )
        assert False, "Borde ha kastat ValueError"
    except ValueError:
        pass  # Förväntat


@test("Datainläsning från DataFrames")
def test_load_from_dataframes():
    import pandas as pd
    from topptipset_backtest.core.loader import load_from_dataframes

    draws_data = [{
        "draw_number": 1,
        "actual_winning_row": "1X21X21X",
        "payout_8_correct": 500000,
    }]
    matches_data = [
        {
            "draw_number": 1, "event_number": i + 1,
            "home_team": "A", "away_team": "B",
            "actual_outcome": "1X21X21X"[i],
            "market_pct_home": 0.50, "market_pct_draw": 0.30, "market_pct_away": 0.20,
            "public_pct_home": 0.45, "public_pct_draw": 0.30, "public_pct_away": 0.25,
        }
        for i in range(8)
    ]

    draws = load_from_dataframes(
        pd.DataFrame(draws_data),
        pd.DataFrame(matches_data),
    )
    assert len(draws) == 1
    assert draws[0].draw_number == 1
    assert draws[0].actual_winning_row == "1X21X21X"
    assert len(draws[0].matches) == 8


@test("Datainläsning: procent-till-andel-konvertering")
def test_pct_conversion():
    import pandas as pd
    from topptipset_backtest.core.loader import load_from_dataframes

    # DB lagrar procent som 0–100
    draws_data = [{"draw_number": 1, "actual_winning_row": "11111111", "payout_8_correct": 1000}]
    matches_data = [
        {
            "draw_number": 1, "event_number": i + 1,
            "home_team": "A", "away_team": "B",
            "actual_outcome": "1",
            "market_pct_home": 50.0, "market_pct_draw": 30.0, "market_pct_away": 20.0,
            "public_pct_home": 45.0, "public_pct_draw": 30.0, "public_pct_away": 25.0,
        }
        for i in range(8)
    ]
    draws = load_from_dataframes(pd.DataFrame(draws_data), pd.DataFrame(matches_data))
    m = draws[0].matches[0]
    assert m.market_pct_home == 0.50, f"Förväntat 0.50, fick {m.market_pct_home}"
    assert m.public_pct_home == 0.45, f"Förväntat 0.45, fick {m.public_pct_home}"


# ---------------------------------------------------------------------------
# Kör alla tester
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("\nTopptipset V7 – Enhetstester")
    print("=" * 50)

    test_positive_edge()
    test_negative_edge()
    test_primary_sign_selection()
    test_threshold_selection()
    test_high_threshold_fallback()
    test_single_sign_expansion()
    test_full_expansion()
    test_correct_count()
    test_coupon_result_net()
    test_no_win_without_match()
    test_win_registered()
    test_positive_roi()
    test_validation_mismatch()
    test_validation_wrong_match_count()
    test_load_from_dataframes()
    test_pct_conversion()

    print()
    print(f"Resultat: {len(PASSED)} godkända, {len(FAILED)} misslyckade")
    if FAILED:
        print("\nMisslyckade:")
        for name, err in FAILED:
            print(f"  ✗ {name}: {err}")
        sys.exit(1)
    else:
        print("Alla tester godkända ✓")
        sys.exit(0)
