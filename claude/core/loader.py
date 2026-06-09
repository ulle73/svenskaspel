"""
Topptipset backtest – datainläsning.

Ansvarar för att läsa rådata (pandas DataFrame eller SQLite) och
omvandla den till immutable DrawData-objekt.

Designprinciper:
- Inga side effects: inläsning returnerar nya objekt, muterar ingenting.
- Explicit kolumnmappning: ändra COLUMN_MAP om ditt schema skiljer sig.
- Sannolikheter normaliseras till 0–1 vid inläsning (oavsett om
  källan lagrar dem som 0–100 eller 0–1).
- Alla valideringsfel samlas och kastas som ett enda ValueError
  så du ser alla problem på en gång.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Optional

import pandas as pd

from .models import DrawData, MatchData, Sign


# ---------------------------------------------------------------------------
# Kolumnmappning – justera dessa namn för att matcha din databas
# ---------------------------------------------------------------------------

# Kolumner i omgångstabellen
DRAW_COLUMNS = {
    "draw_number":        "draw_number",
    "draw_code":          "draw_code",          # valfri
    "draw_start":         "draw_start",          # valfri, datetime
    "first_match_start":  "first_match_start",   # valfri, datetime
    "actual_winning_row": "actual_winning_row",  # "1X2X112X"
    "payout_8_correct":   "payout_8_correct",    # kr
    "num_winners":        "num_winners",          # valfri
    "turnover":           "turnover",             # valfri
}

# Kolumner i matchtabellen
MATCH_COLUMNS = {
    "draw_number":      "draw_number",
    "event_number":     "event_number",          # 1–8
    "home_team":        "home_team",
    "away_team":        "away_team",
    "actual_outcome":   "actual_outcome",        # "1", "X", "2"
    "market_pct_home":  "market_pct_home",
    "market_pct_draw":  "market_pct_draw",
    "market_pct_away":  "market_pct_away",
    "public_pct_home":  "public_pct_home",
    "public_pct_draw":  "public_pct_draw",
    "public_pct_away":  "public_pct_away",
    "odds_1":           "odds_1",                # valfri
    "odds_x":           "odds_x",                # valfri
    "odds_2":           "odds_2",                # valfri
    "expert_tip":       "expert_tip",            # valfri
    "paper_tip":        "paper_tip",             # valfri
    "match_start":      "match_start",           # valfri, datetime
}

REQUIRED_DRAW_COLS   = {"draw_number", "actual_winning_row", "payout_8_correct"}
REQUIRED_MATCH_COLS  = {
    "draw_number", "event_number", "home_team", "away_team", "actual_outcome",
    "market_pct_home", "market_pct_draw", "market_pct_away",
    "public_pct_home", "public_pct_draw", "public_pct_away",
}


# ---------------------------------------------------------------------------
# Hjälpfunktioner
# ---------------------------------------------------------------------------

def _pct_to_fraction(value: float, col: str) -> float:
    """
    Om värdet ser ut att vara i procent (>1.5) konverteras det till
    andel. Värden 0–1 lämnas oförändrade.
    """
    if value > 1.5:
        return value / 100.0
    return float(value)


def _safe_optional_float(value) -> Optional[float]:
    try:
        v = float(value)
        return None if pd.isna(v) else v
    except (TypeError, ValueError):
        return None


def _safe_optional_str(value) -> Optional[str]:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    s = str(value).strip()
    return s if s else None


def _parse_datetime(value) -> Optional[datetime]:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, pd.Timestamp):
        return value.to_pydatetime()
    try:
        return pd.to_datetime(value).to_pydatetime()
    except Exception:
        return None


def _validate_sign(value: str, context: str) -> Sign:
    s = str(value).strip().upper()
    if s not in {"1", "X", "2"}:
        raise ValueError(f"{context}: ogiltigt tecken '{value}' (förväntar 1, X eller 2)")
    return s


def _validate_winning_row(row: str, draw_number: int) -> str:
    row = str(row).strip()
    if len(row) != 8:
        raise ValueError(
            f"draw_number {draw_number}: actual_winning_row har "
            f"{len(row)} tecken, förväntar 8 ('{row}')"
        )
    for i, ch in enumerate(row):
        if ch not in {"1", "X", "2"}:
            raise ValueError(
                f"draw_number {draw_number}: ogiltigt tecken '{ch}' "
                f"på position {i} i actual_winning_row"
            )
    return row


# ---------------------------------------------------------------------------
# Kolumnomdöpning – mappar ditt schema till internt schema
# ---------------------------------------------------------------------------

def _rename_df(df: pd.DataFrame, column_map: dict[str, str]) -> pd.DataFrame:
    """
    Applicerar kolumnmappning: db_kolumn → internt_namn.
    Kastar KeyError om en obligatorisk kolumn saknas.
    """
    rename = {v: k for k, v in column_map.items() if v in df.columns}
    return df.rename(columns=rename)


# ---------------------------------------------------------------------------
# Inläsning från DataFrames
# ---------------------------------------------------------------------------

def load_from_dataframes(
    draws_df: pd.DataFrame,
    matches_df: pd.DataFrame,
    draw_column_map: Optional[dict[str, str]] = None,
    match_column_map: Optional[dict[str, str]] = None,
) -> list[DrawData]:
    """
    Läser in omgångar och matcher från två pandas DataFrames.

    Parametrar
    ----------
    draws_df:
        En rad per omgång. Se DRAW_COLUMNS för förväntade kolumnnamn.
    matches_df:
        En rad per match (8 rader per omgång). Se MATCH_COLUMNS.
    draw_column_map:
        Valfri override av DRAW_COLUMNS, t.ex. {"draw_number": "round_id"}.
    match_column_map:
        Valfri override av MATCH_COLUMNS.

    Returnerar
    ----------
    list[DrawData] sorterad på draw_number, redo för backtest.
    """
    dc_map = {**DRAW_COLUMNS, **(draw_column_map or {})}
    mc_map = {**MATCH_COLUMNS, **(match_column_map or {})}

    draws_df   = _rename_df(draws_df.copy(),   dc_map)
    matches_df = _rename_df(matches_df.copy(), mc_map)

    # Kontrollera att obligatoriska kolumner finns
    errors: list[str] = []
    for col in REQUIRED_DRAW_COLS:
        if col not in draws_df.columns:
            errors.append(f"draws_df saknar kolumn '{col}'")
    for col in REQUIRED_MATCH_COLS:
        if col not in matches_df.columns:
            errors.append(f"matches_df saknar kolumn '{col}'")
    if errors:
        raise ValueError("Kolumnfel vid inläsning:\n" + "\n".join(errors))

    draws_lookup = draws_df.set_index("draw_number").to_dict("index")
    matches_by_draw: dict[int, list[dict]] = {}
    for row in matches_df.to_dict("records"):
        dn = int(row["draw_number"])
        matches_by_draw.setdefault(dn, []).append(row)

    result: list[DrawData] = []
    for draw_number, draw_row in draws_lookup.items():
        draw_number = int(draw_number)
        try:
            winning_row = _validate_winning_row(
                draw_row["actual_winning_row"], draw_number
            )
        except ValueError as e:
            errors.append(str(e))
            continue

        raw_matches = matches_by_draw.get(draw_number, [])
        if len(raw_matches) != 8:
            errors.append(
                f"draw_number {draw_number}: hittade {len(raw_matches)} "
                f"matcher, förväntar 8"
            )
            continue

        raw_matches.sort(key=lambda m: int(m["event_number"]))
        match_objects: list[MatchData] = []
        for m in raw_matches:
            ev = int(m["event_number"])
            try:
                outcome = _validate_sign(
                    m["actual_outcome"],
                    f"draw {draw_number} match {ev}"
                )
                mph = _pct_to_fraction(float(m["market_pct_home"]), "market_pct_home")
                mpd = _pct_to_fraction(float(m["market_pct_draw"]), "market_pct_draw")
                mpa = _pct_to_fraction(float(m["market_pct_away"]), "market_pct_away")
                pph = _pct_to_fraction(float(m["public_pct_home"]), "public_pct_home")
                ppd = _pct_to_fraction(float(m["public_pct_draw"]), "public_pct_draw")
                ppa = _pct_to_fraction(float(m["public_pct_away"]), "public_pct_away")
            except (KeyError, ValueError, TypeError) as e:
                errors.append(
                    f"draw_number {draw_number}, event {ev}: {e}"
                )
                continue

            match_objects.append(MatchData(
                draw_number=draw_number,
                event_number=ev,
                home_team=str(m["home_team"]),
                away_team=str(m["away_team"]),
                actual_outcome=outcome,
                market_pct_home=mph,
                market_pct_draw=mpd,
                market_pct_away=mpa,
                public_pct_home=pph,
                public_pct_draw=ppd,
                public_pct_away=ppa,
                odds_1=_safe_optional_float(m.get("odds_1")),
                odds_x=_safe_optional_float(m.get("odds_x")),
                odds_2=_safe_optional_float(m.get("odds_2")),
                expert_tip=_safe_optional_str(m.get("expert_tip")),
                paper_tip=_safe_optional_str(m.get("paper_tip")),
                match_start=_parse_datetime(m.get("match_start")),
            ))

        if len(match_objects) != 8:
            errors.append(
                f"draw_number {draw_number}: bara {len(match_objects)} giltiga "
                "matcher efter validering – omgången hoppas över"
            )
            continue

        # Kontrollera att faktiska utfall stämmer mot winning_row
        computed_row = "".join(m.actual_outcome for m in match_objects)
        if computed_row != winning_row:
            errors.append(
                f"draw_number {draw_number}: utfallsmismatch "
                f"(matcher='{computed_row}' vs winning_row='{winning_row}')"
            )
            continue

        result.append(DrawData(
            draw_number=draw_number,
            actual_winning_row=winning_row,
            payout_8_correct=float(draw_row["payout_8_correct"]),
            matches=tuple(match_objects),
            draw_code=_safe_optional_str(draw_row.get("draw_code")),
            draw_start=_parse_datetime(draw_row.get("draw_start")),
            first_match_start=_parse_datetime(draw_row.get("first_match_start")),
            num_winners=None if draw_row.get("num_winners") is None
                        else _safe_optional_float(draw_row.get("num_winners")),
            turnover=_safe_optional_float(draw_row.get("turnover")),
        ))

    if errors:
        raise ValueError(
            f"Datainläsning: {len(errors)} fel hittades:\n"
            + "\n".join(f"  [{i+1}] {e}" for i, e in enumerate(errors))
        )

    result.sort(key=lambda d: d.draw_number)
    return result


# ---------------------------------------------------------------------------
# Inläsning från SQLite
# ---------------------------------------------------------------------------

def load_from_sqlite(
    db_path: str | Path,
    draws_table: str = "draws",
    matches_table: str = "matches",
    draw_column_map: Optional[dict[str, str]] = None,
    match_column_map: Optional[dict[str, str]] = None,
) -> list[DrawData]:
    """
    Läser in data direkt från en SQLite-databas.

    Parametrar
    ----------
    db_path:
        Sökväg till .db-filen.
    draws_table / matches_table:
        Tabellnamn (defaultar till "draws" och "matches").
    draw_column_map / match_column_map:
        Valfri kolumnomdöpning, se load_from_dataframes.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        raise FileNotFoundError(f"Databas hittades inte: {db_path}")

    conn = sqlite3.connect(db_path)
    try:
        draws_df   = pd.read_sql_query(f"SELECT * FROM {draws_table}",   conn)
        matches_df = pd.read_sql_query(f"SELECT * FROM {matches_table}", conn)
    finally:
        conn.close()

    return load_from_dataframes(
        draws_df, matches_df,
        draw_column_map=draw_column_map,
        match_column_map=match_column_map,
    )


# ---------------------------------------------------------------------------
# Inläsning från CSV-filer (enklast för att verifiera data)
# ---------------------------------------------------------------------------

def load_from_csv(
    draws_csv: str | Path,
    matches_csv: str | Path,
    draw_column_map: Optional[dict[str, str]] = None,
    match_column_map: Optional[dict[str, str]] = None,
) -> list[DrawData]:
    """
    Läser in data från två CSV-filer.
    """
    draws_df   = pd.read_csv(Path(draws_csv))
    matches_df = pd.read_csv(Path(matches_csv))
    return load_from_dataframes(
        draws_df, matches_df,
        draw_column_map=draw_column_map,
        match_column_map=match_column_map,
    )
