"""
Topptipset backtest – datamodeller.

Alla strukturer är frozen dataclasses: immutable, hashable, och
enkelt serialiserbara. Inga externa beroenden utöver stdlib.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional
from datetime import datetime


Sign = str  # "1", "X" eller "2"
Row = tuple[Sign, ...]  # 8 tecken


@dataclass(frozen=True)
class MatchData:
    """
    En enskild match i en Topptipset-omgång.

    Sannolikheter (market_pct_*, public_pct_*) representeras som
    andelar 0–1, INTE procent. Konvertera vid inläsning om din DB
    lagrar dem som 0–100.

    Oddskolumner är valfria – finns inte alltid i historisk data.
    """
    draw_number: int
    event_number: int          # 1–8
    home_team: str
    away_team: str
    actual_outcome: Sign       # "1", "X" eller "2"

    # Marknadens implicita sannolikheter (summerar till ≈1 efter vig-justering)
    market_pct_home: float     # 0.0–1.0
    market_pct_draw: float
    market_pct_away: float

    # Svenska folkets streckprocent (summerar till ≈1)
    public_pct_home: float
    public_pct_draw: float
    public_pct_away: float

    # Valfria kolumner
    odds_1: Optional[float] = None
    odds_x: Optional[float] = None
    odds_2: Optional[float] = None
    expert_tip: Optional[Sign] = None
    paper_tip: Optional[Sign] = None
    match_start: Optional[datetime] = None

    def market_pct(self, sign: Sign) -> float:
        """Returnerar marknadens sannolikhet för ett givet tecken."""
        return {"1": self.market_pct_home,
                "X": self.market_pct_draw,
                "2": self.market_pct_away}[sign]

    def public_pct(self, sign: Sign) -> float:
        """Returnerar folkprocenten för ett givet tecken."""
        return {"1": self.public_pct_home,
                "X": self.public_pct_draw,
                "2": self.public_pct_away}[sign]

    def all_signs(self) -> dict[Sign, dict[str, float]]:
        """Returnerar båda prokollektionerna för alla tre tecken."""
        return {
            "1": {"market": self.market_pct_home, "public": self.public_pct_home},
            "X": {"market": self.market_pct_draw, "public": self.public_pct_draw},
            "2": {"market": self.market_pct_away, "public": self.public_pct_away},
        }


@dataclass(frozen=True)
class DrawData:
    """
    En komplett Topptipset-omgång med alla åtta matcher.

    Matchar lagras i en tuple sorterad på event_number 1–8.
    actual_winning_row är en 8-teckens sträng, t.ex. "1X2X112X".
    """
    draw_number: int
    actual_winning_row: str         # "1X2X112X" etc.
    payout_8_correct: float         # Utdelning för 8 rätt (kr)
    matches: tuple[MatchData, ...]  # Alltid exakt 8 element

    draw_code: Optional[str] = None
    draw_start: Optional[datetime] = None
    first_match_start: Optional[datetime] = None
    num_winners: Optional[int] = None
    turnover: Optional[float] = None

    def __post_init__(self):
        if len(self.matches) != 8:
            raise ValueError(
                f"Omgång {self.draw_number}: förväntade 8 matcher, "
                f"fick {len(self.matches)}"
            )
        outcomes = "".join(m.actual_outcome for m in self.matches)
        if outcomes != self.actual_winning_row:
            raise ValueError(
                f"Omgång {self.draw_number}: faktiska utfall '{outcomes}' "
                f"stämmer inte med actual_winning_row '{self.actual_winning_row}'"
            )

    def match(self, event_number: int) -> MatchData:
        """Hämtar en match på event_number 1–8."""
        return self.matches[event_number - 1]


@dataclass(frozen=True)
class MatchEdge:
    """
    Edge-beräkning för en enskild sign i en match.

    edge = public_pct - market_pct

    Positivt värde: folket överstreckar tecknet relativt marknaden.
    Negativt värde: folket understreckar – potentiell value.
    """
    draw_number: int
    event_number: int
    sign: Sign
    market_pct: float
    public_pct: float
    actual_outcome: Sign

    @property
    def edge(self) -> float:
        """folk% minus market%. Negativt = folket undervärdar tecknet."""
        return self.public_pct - self.market_pct

    @property
    def is_correct(self) -> bool:
        return self.sign == self.actual_outcome


@dataclass(frozen=True)
class GeneratedRow:
    """
    En enskild rad i en genererad kupong.

    selected_signs: 8-teckens tuple, ett tecken per match.
    Matchas mot DrawData.actual_winning_row för att räkna rätt.
    """
    row: Row   # t.ex. ("1", "X", "1", "2", "1", "X", "2", "1")

    def correct_count(self, winning_row: str) -> int:
        """Räknar hur många tecken som stämmer mot vinnarkombinationen."""
        return sum(r == w for r, w in zip(self.row, winning_row))

    def is_eight_correct(self, winning_row: str) -> bool:
        return self.correct_count(winning_row) == 8


@dataclass
class CouponResult:
    """
    Resultat för en spelad kupong i en enskild omgång.

    cost_per_row: insatsen per rad (standard 1 kr i Topptipset).
    """
    draw_number: int
    num_rows: int
    cost_per_row: float
    rows: tuple[GeneratedRow, ...]

    winning_row: str
    payout_8_correct: float

    eight_correct_count: int = field(init=False)
    total_cost: float = field(init=False)
    total_payout: float = field(init=False)
    net: float = field(init=False)
    roi: float = field(init=False)

    def __post_init__(self):
        self.eight_correct_count = sum(
            r.is_eight_correct(self.winning_row) for r in self.rows
        )
        self.total_cost = self.num_rows * self.cost_per_row
        self.total_payout = self.eight_correct_count * self.payout_8_correct
        self.net = self.total_payout - self.total_cost
        self.roi = self.net / self.total_cost if self.total_cost > 0 else 0.0


@dataclass
class BacktestResult:
    """
    Aggregerat resultat för ett helt backtest.

    rounds_played: antal omgångar där en kupong genererades.
    rounds_skipped: omgångar utan tillräcklig edge (inga kuponger).
    """
    strategy_name: str
    strategy_params: dict

    rounds_played: int
    rounds_skipped: int
    total_rows: int
    total_cost: float
    total_payout: float
    total_wins_8_correct: int   # antal omgångar med minst en 8-rätt

    coupon_results: list[CouponResult]

    # Beräknade vid __post_init__
    net: float = field(init=False)
    roi: float = field(init=False)
    win_rate: float = field(init=False)  # andel omgångar med vinst

    def __post_init__(self):
        self.net = self.total_payout - self.total_cost
        self.roi = self.net / self.total_cost if self.total_cost > 0 else 0.0
        self.win_rate = (
            self.total_wins_8_correct / self.rounds_played
            if self.rounds_played > 0 else 0.0
        )

    @property
    def avg_rows_per_round(self) -> float:
        return self.total_rows / self.rounds_played if self.rounds_played > 0 else 0.0

    @property
    def avg_cost_per_round(self) -> float:
        return self.total_cost / self.rounds_played if self.rounds_played > 0 else 0.0
