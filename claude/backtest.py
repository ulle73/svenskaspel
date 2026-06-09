"""
Topptipset backtest – exekveringsmotor.

Designprinciper mot läckage och reproducerbarhet:
- Omgångar itereras i draw_number-ordning (kronologiskt).
- Varje beslut fattas baserat på data som var känd FÖRE omgångens start.
- Inget tillståndsläckage: varje omgång är oberoende (V7 använder ingen
  adaptiv modell, så det finns inget rolling state att läcka).
- Deterministiskt: givet samma indata och parametrar ger körningen
  alltid exakt samma resultat.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

from .edge import (
    coupon_size,
    expand_coupon,
    select_signs_for_draw,
)
from .models import (
    BacktestResult,
    CouponResult,
    DrawData,
    GeneratedRow,
)


# ---------------------------------------------------------------------------
# Strategigränssnitt
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class StrategyConfig:
    """
    Konfiguration för en backtest-körning.

    Parametrar
    ----------
    name:
        Namn på strategin, används i rapporter.
    edge_threshold:
        Minimalt negativt edge för att ett tecken ska tas med.
        edge = public_pct - market_pct < -edge_threshold → underbet.
        Typiska värden att undersöka: 0.0, 0.02, 0.05, 0.08, 0.10, 0.15.
    max_signs_per_match:
        Max antal tecken per match. Styr kupongstorleken.
        1 → alltid singelsystem (1 rad), 3 → upp till 6 561 rader.
    max_rows_per_coupon:
        Om kupongexpansionen överstiger detta antal rader hoppas omgången
        INTE över – istället garderas de `max_signs_per_match` matcherna
        med lägst (minst negativt) edge ner till 1 sign tills kupongstorlek
        ≤ max_rows_per_coupon. Sätts till None för att tillåta alla rader.
    cost_per_row:
        Insats per rad i kronor (standard 1 kr).
    min_edge_sum:
        Om summan av negativa edges för omgången understiger detta värde
        hoppas omgången över (ingen kupong spelas). Sätts till None för
        att alltid spela.
    """
    name: str
    edge_threshold: float = 0.05
    max_signs_per_match: int = 3
    max_rows_per_coupon: Optional[int] = None
    cost_per_row: float = 1.0
    min_edge_sum: Optional[float] = None

    def to_dict(self) -> dict:
        return {
            "edge_threshold":      self.edge_threshold,
            "max_signs_per_match": self.max_signs_per_match,
            "max_rows_per_coupon": self.max_rows_per_coupon,
            "cost_per_row":        self.cost_per_row,
            "min_edge_sum":        self.min_edge_sum,
        }


# ---------------------------------------------------------------------------
# Backtest-motor
# ---------------------------------------------------------------------------

def run_backtest(
    draws: list[DrawData],
    config: StrategyConfig,
    start_draw: Optional[int] = None,
    end_draw: Optional[int] = None,
    progress_callback: Optional[Callable[[int, int], None]] = None,
) -> BacktestResult:
    """
    Kör ett komplett backtest på historisk data.

    Parametrar
    ----------
    draws:
        Lista av DrawData, sorterad på draw_number.
    config:
        Strategikonfiguration (se StrategyConfig).
    start_draw / end_draw:
        Valfri avgränsning på draw_number (inklusiva gränser).
        Används för walk-forward-validering.
    progress_callback:
        Valfri funktion(current_index, total) för progress-rapportering.

    Returnerar
    ----------
    BacktestResult med alla kuponger och aggregerade nyckeltal.

    Notering om läckage
    -------------------
    V7 använder ingen rullande modell – alla beslut baseras enbart på
    per-omgångsdata (market_pct och public_pct). Det finns därför inget
    look-ahead-läckage att oroa sig för i V7. Walk-forward är ändå
    implementerat för att metodiken ska vara korrekt när adaptiva
    modeller läggs till i framtida versioner.
    """
    # Filtrera på tidsperiod
    filtered = [
        d for d in draws
        if (start_draw is None or d.draw_number >= start_draw)
        and (end_draw   is None or d.draw_number <= end_draw)
    ]
    filtered.sort(key=lambda d: d.draw_number)

    coupon_results: list[CouponResult] = []
    rounds_skipped = 0
    total_rows = 0
    total_cost = 0.0
    total_payout = 0.0
    total_wins = 0

    for idx, draw in enumerate(filtered):
        if progress_callback:
            progress_callback(idx + 1, len(filtered))

        # --- Steg 1: Beräkna teckenval för denna omgång ---
        selections = select_signs_for_draw(
            draw,
            edge_threshold=config.edge_threshold,
            max_signs_per_match=config.max_signs_per_match,
        )

        # --- Steg 2: Kontrollera min_edge_sum-filter ---
        if config.min_edge_sum is not None:
            total_negative_edge = sum(
                min(sel.edges.values())
                for sel in selections
            )
            if total_negative_edge > -config.min_edge_sum:
                rounds_skipped += 1
                continue

        # --- Steg 3: Hantera max_rows_per_coupon ---
        if config.max_rows_per_coupon is not None:
            selections = _trim_to_max_rows(
                selections,
                config.max_rows_per_coupon,
            )

        # --- Steg 4: Expandera kupong ---
        raw_rows = expand_coupon(selections)
        rows = tuple(GeneratedRow(row=r) for r in raw_rows)

        # --- Steg 5: Utvärdera kupong mot faktiskt utfall ---
        coupon = CouponResult(
            draw_number=draw.draw_number,
            num_rows=len(rows),
            cost_per_row=config.cost_per_row,
            rows=rows,
            winning_row=draw.actual_winning_row,
            payout_8_correct=draw.payout_8_correct,
        )

        coupon_results.append(coupon)
        total_rows    += coupon.num_rows
        total_cost    += coupon.total_cost
        total_payout  += coupon.total_payout
        if coupon.eight_correct_count > 0:
            total_wins += 1

    return BacktestResult(
        strategy_name=config.name,
        strategy_params=config.to_dict(),
        rounds_played=len(coupon_results),
        rounds_skipped=rounds_skipped,
        total_rows=total_rows,
        total_cost=total_cost,
        total_payout=total_payout,
        total_wins_8_correct=total_wins,
        coupon_results=coupon_results,
    )


def _trim_to_max_rows(
    selections,
    max_rows: int,
) -> list:
    """
    Trimmar kupongstorlek till max_rows genom att reducera antalet tecken
    i de matcher som har lägst absolut negativt edge (minst värde).

    Trimmar iterativt: hitta den match med "sämst" edge bland de som
    har fler än 1 sign valt, reducera till 1 sign färre, upprepa.
    """
    from .edge import SignSelection

    sels = list(selections)  # mutable kopia

    while coupon_size(sels) > max_rows:
        # Hitta den match med fler än 1 sign och lägst absolut negativ edge-sum
        candidates = [
            (i, sel) for i, sel in enumerate(sels)
            if sel.num_signs() > 1
        ]
        if not candidates:
            break  # Kan inte reducera mer

        # Sortera: den med minst negativt edge trimmas först
        candidates.sort(
            key=lambda ic: sum(
                v for v in ic[1].edges.values() if v < 0
            ),
            reverse=True,  # Minst negativt edge → trimma först
        )
        idx, sel = candidates[0]

        # Behåll bara primärtecknet (det med lägst edge)
        sels[idx] = SignSelection(
            event_number=sel.event_number,
            selected_signs=(sel.primary_sign,),
            primary_sign=sel.primary_sign,
            edges=sel.edges,
            forced_all=False,
        )

    return sels


# ---------------------------------------------------------------------------
# Walk-forward validering
# ---------------------------------------------------------------------------

@dataclass
class WalkForwardFold:
    """Ett fold i walk-forward-valideringen."""
    fold_number: int
    train_start: int
    train_end: int
    test_start: int
    test_end: int
    test_result: BacktestResult


def run_walk_forward(
    draws: list[DrawData],
    config: StrategyConfig,
    train_size: int = 500,
    test_size: int = 100,
    min_train_size: int = 200,
) -> list[WalkForwardFold]:
    """
    Walk-forward validering för att detektera overfitting.

    Tränar (simulerar anpassning) på train_size omgångar och
    utvärderar på test_size efterföljande omgångar. Eftersom V7
    inte har träningsbara parametrar används detta bara för att
    undersöka stabiliteten i edge-metoden över tid.

    Parametrar
    ----------
    train_size:
        Antal omgångar per träningsfönster (används ej i V7, men
        implementeras för framtida modeller).
    test_size:
        Antal omgångar per testfönster.
    min_train_size:
        Minimum träningsdata för att ett fold ska skapas.
    """
    draws_sorted = sorted(draws, key=lambda d: d.draw_number)
    draw_numbers = [d.draw_number for d in draws_sorted]

    folds: list[WalkForwardFold] = []
    fold_num = 0
    i = 0

    while i + min_train_size < len(draws_sorted):
        train_start_idx = max(0, i)
        train_end_idx   = min(i + train_size, len(draws_sorted) - 1)
        test_start_idx  = train_end_idx + 1
        test_end_idx    = min(test_start_idx + test_size - 1, len(draws_sorted) - 1)

        if test_start_idx >= len(draws_sorted):
            break

        fold_num += 1
        test_result = run_backtest(
            draws=draws_sorted,
            config=config,
            start_draw=draw_numbers[test_start_idx],
            end_draw=draw_numbers[test_end_idx],
        )

        folds.append(WalkForwardFold(
            fold_number=fold_num,
            train_start=draw_numbers[train_start_idx],
            train_end=draw_numbers[train_end_idx],
            test_start=draw_numbers[test_start_idx],
            test_end=draw_numbers[test_end_idx],
            test_result=test_result,
        ))

        i += test_size  # Rulla fram med test_size

    return folds
