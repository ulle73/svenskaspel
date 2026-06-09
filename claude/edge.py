"""
Topptipset backtest – edge-beräkning (market vs folk).

V7 testar en enda hypotes:
    edge(sign) = public_pct(sign) - market_pct(sign)

Positivt edge  → folket streckar tecknet MER än marknaden värderar det.
                 Tecknet är troligen "overbet" – lägre förväntad utdelning.

Negativt edge  → folket streckar tecknet MINDRE än marknaden värderar det.
                 Tecknet är potentiellt "underbet" – högre förväntad utdelning
                 relativt sannolikheten, om marknadens sannolikhet är korrekt.

Ingen prediktionsmodell används i V7. Marknadsprocenten behandlas som
den bästa tillgängliga estimering av faktisk sannolikhet.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator

from .models import DrawData, MatchData, MatchEdge, Sign


ALL_SIGNS: tuple[Sign, ...] = ("1", "X", "2")


# ---------------------------------------------------------------------------
# Edge per match och tecken
# ---------------------------------------------------------------------------

def compute_match_edges(match: MatchData) -> tuple[MatchEdge, MatchEdge, MatchEdge]:
    """
    Beräknar edge för alla tre tecken i en match.

    Returnerar alltid exakt tre MatchEdge-objekt (1, X, 2).
    """
    return tuple(
        MatchEdge(
            draw_number=match.draw_number,
            event_number=match.event_number,
            sign=sign,
            market_pct=match.market_pct(sign),
            public_pct=match.public_pct(sign),
            actual_outcome=match.actual_outcome,
        )
        for sign in ALL_SIGNS
    )


def best_edge_sign(match: MatchData) -> MatchEdge:
    """
    Returnerar det tecken med mest negativt edge (mest underbet av folket).

    Det är det tecken vi primärt vill inkludera: folket undervärder det
    relativt marknadens sannolikhetsestimering.
    """
    edges = compute_match_edges(match)
    return min(edges, key=lambda e: e.edge)


def all_draw_edges(draw: DrawData) -> list[MatchEdge]:
    """
    Returnerar alla 24 edge-beräkningar för en omgång (8 matcher × 3 tecken).
    Sorterade på event_number, sedan sign.
    """
    result = []
    for match in draw.matches:
        result.extend(compute_match_edges(match))
    return result


# ---------------------------------------------------------------------------
# Teckenval baserat på edge-tröskel
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SignSelection:
    """
    Vilka tecken som valts för en match, och motivet.

    selected_signs: de tecken som tas med i systemet (1–3 stycken).
    primary_sign:   det tecken med mest negativt edge (marknadens favorit
                    som folket undervärder).
    forced_all:     True om ingen sign passade tröskeln → alla tre tas med
                    (säkerhetsnät: vi garderar hellre än hoppar).
    """
    event_number: int
    selected_signs: tuple[Sign, ...]
    primary_sign: Sign
    edges: dict[Sign, float]   # edge per sign för spårbarhet
    forced_all: bool = False

    def num_signs(self) -> int:
        return len(self.selected_signs)


def select_signs_for_match(
    match: MatchData,
    edge_threshold: float,
    max_signs: int = 3,
) -> SignSelection:
    """
    Väljer tecken för en match baserat på edge-tröskel.

    Logik (V7 – ren market-vs-folk):
    1. Beräkna edge = public_pct - market_pct för varje sign.
    2. Ta med alla tecken vars edge ≤ -edge_threshold
       (dvs. folket undervärder med minst `edge_threshold`).
    3. Det primära tecknet (lägst edge = mest underbet) tas alltid med.
    4. Om inga tecken når tröskeln: ta bara primärtecknet (1 sign).
    5. Begränsa till max_signs.

    Parametrar
    ----------
    edge_threshold:
        Positiv float. T.ex. 0.05 = folket undervärder med ≥5 procentenheter.
        Lägre värde → fler garderade tecken, större kupong, högre frekvens.
        Högre värde → färre tecken, skarpare selektion, lägre frekvens.
    max_signs:
        Max antal tecken per match (1–3). Påverkar kupongstorleken kraftigt:
        8 matcher × 3 signs = 6 561 rader.
    """
    edges_map = {
        sign: match.public_pct(sign) - match.market_pct(sign)
        for sign in ALL_SIGNS
    }

    # Primärt tecken: lägst edge (mest underbet av folket)
    primary = min(ALL_SIGNS, key=lambda s: edges_map[s])

    # Kandidater: edge ≤ -threshold (underbet av folket med tillräcklig marginal)
    candidates = [
        s for s in ALL_SIGNS
        if edges_map[s] <= -edge_threshold
    ]

    if not candidates:
        # Inga tecken når tröskeln → ta bara primärtecknet
        selected = (primary,)
        forced = False
    else:
        # Sortera kandidater på edge (lägst = mest negativt = mest underbet = först)
        candidates.sort(key=lambda s: edges_map[s])
        selected = tuple(candidates[:max_signs])
        # Se till att primärtecknet alltid är med
        if primary not in selected:
            selected = (primary,) + selected[: max_signs - 1]
        forced = False

    return SignSelection(
        event_number=match.event_number,
        selected_signs=tuple(sorted(selected)),
        primary_sign=primary,
        edges=edges_map,
        forced_all=forced,
    )


def select_signs_for_draw(
    draw: DrawData,
    edge_threshold: float,
    max_signs_per_match: int = 3,
) -> list[SignSelection]:
    """
    Väljer tecken för alla 8 matcher i en omgång.

    Returnerar en lista med 8 SignSelection-objekt.
    """
    return [
        select_signs_for_match(
            match,
            edge_threshold=edge_threshold,
            max_signs=max_signs_per_match,
        )
        for match in draw.matches
    ]


# ---------------------------------------------------------------------------
# Kupongexpansion – genererar alla rader från valda tecken
# ---------------------------------------------------------------------------

def expand_coupon(selections: list[SignSelection]) -> list[tuple[Sign, ...]]:
    """
    Expanderar en lista av SignSelection till alla möjliga rader.

    Med 8 matcher och max 3 tecken per match ger full expansion 3^8 = 6 561 rader.
    Med selektiva val blir det färre.

    Returnerar en lista av 8-tuplar, t.ex. [("1","X","1","2","1","X","2","1"), ...].
    """
    rows: list[tuple[Sign, ...]] = [()]
    for sel in sorted(selections, key=lambda s: s.event_number):
        rows = [
            existing + (sign,)
            for existing in rows
            for sign in sel.selected_signs
        ]
    return rows


def coupon_size(selections: list[SignSelection]) -> int:
    """Beräknar antalet rader utan att expandera."""
    result = 1
    for sel in selections:
        result *= sel.num_signs()
    return result
