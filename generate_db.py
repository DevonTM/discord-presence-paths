#!/usr/bin/env python3
"""Fetch Discord's detectable applications list and build a fast-searchable SQLite DB.

Sources the data from https://discord.com/api/v10/applications/detectable
(no external pip dependencies — uses only urllib from the standard library).

Produces an SQLite DB with:
  - A `games` table (name, path, plus normalized name column for fast search)
  - An FTS5 virtual table for full-text search on name only
  - Indexes for exact and prefix matching on name

Usage:
    python generate_db.py                  # fetch from Discord API → detectable.db
    python generate_db.py --local FILE     # read from a local JSON file instead
    python generate_db.py --output OUT.db  # custom output path
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import tempfile
from typing import Any, Dict, IO, Iterator, List, Optional, Tuple
from urllib.request import urlopen, Request

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DISCORD_DETECTABLE_URL = "https://discord.com/api/v10/applications/detectable"
BATCH_SIZE = 500        # rows per INSERT batch
DOWNLOAD_CHUNK = 256 * 1024   # 256 KiB per HTTP read chunk
JSON_CHUNK = 1 << 20          # 1 MiB read chunks for streaming parser

# ---------------------------------------------------------------------------
# Streaming JSON parser (works on any file-like object)
# ---------------------------------------------------------------------------

def iter_json_array(source: IO[bytes]) -> Iterator[Dict[str, Any]]:
    """Yield top-level objects from a huge JSON array without loading all at once.

    ``source`` is a binary file-like that supports ``.read(n)``.
    """
    decoder = json.JSONDecoder()
    buf = ""
    started = False
    idx = 0

    eof = False
    while True:
        if not eof:
            chunk = source.read(JSON_CHUNK)
            if chunk:
                buf += chunk if isinstance(chunk, str) else chunk.decode("utf-8")
            else:
                eof = True

        while idx < len(buf) and buf[idx].isspace():
            idx += 1

        if not started:
            if idx >= len(buf):
                if eof:
                    return
                continue
            if buf[idx] != "[":
                raise ValueError("Expected JSON array at root level")
            started = True
            idx += 1
            continue

        if idx < len(buf) and buf[idx] == "]":
            return

        if idx < len(buf) and buf[idx] == ",":
            idx += 1
            continue

        if idx >= len(buf):
            if eof:
                return
            continue

        try:
            obj, next_idx = decoder.raw_decode(buf, idx)
        except json.JSONDecodeError:
            if eof:
                raise
            continue

        idx = next_idx
        yield obj


# ---------------------------------------------------------------------------
# Normalisation helpers
# ---------------------------------------------------------------------------

_SLASH_RE = re.compile(r"[\\/]")

def _normalise_name(name: str) -> str:
    """Lower-case, collapse whitespace for FTS-friendly matching."""
    return re.sub(r"\s+", " ", name.lower()).strip()

def _normalise_path(p: str) -> str:
    """Lower-case, unify slashes, strip trailing slashes."""
    return _SLASH_RE.sub("/", p.lower()).strip().rstrip("/")


def _windows_path(p: str) -> str:
    """Store display paths with Windows-style backslashes."""
    return _SLASH_RE.sub(r"\\", p.strip()).rstrip(r"\\")

def _exe_depth(p: str) -> int:
    return p.count("/")


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------

def _pick_best_path(executables: List[Dict[str, Any]]) -> Optional[str]:
    """From the executables list, return the longest valid win32 non-launcher path.

    Robustness notes (avoid spurious DB churn from Discord metadata flips):
      * Only executables explicitly flagged as a launcher (``is_launcher is True``)
        are skipped. A missing/null ``is_launcher`` is treated as a real executable,
        so the occasional absent flag on a game exe no longer drops the whole row
        (which previously removed that game from the DB entirely).
      * Selection is order-independent: we take the maximum over a stable tuple key,
        so Discord reshuffling the ``executables`` array cannot change the result.
    """
    candidates: List[str] = []
    for exe in executables:
        if not isinstance(exe, dict):
            continue
        # Skip only explicit launchers; treat absent/null as a real executable.
        if exe.get("is_launcher") is True:
            continue
        if exe.get("os") != "win32":
            continue
        name = exe.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        candidates.append(name.strip())

    if not candidates:
        return None

    # Prefer longest path string, then deepest directory depth, then alphabetically.
    # `max` is commutative over the key, so reordering of `candidates` is irrelevant.
    return max(candidates, key=lambda v: (len(v), _exe_depth(_normalise_path(v)), v))


def iter_games(source: IO[bytes]) -> Iterator[Tuple[str, str]]:
    """Yield (game_name, best_executable_path) tuples from the JSON source."""
    for item in iter_json_array(source):
        game_name = item.get("name")
        if not isinstance(game_name, str) or not game_name.strip():
            continue
        best = _pick_best_path(item.get("executables") or [])
        if best is not None:
            yield (game_name.strip(), best)


# ---------------------------------------------------------------------------
# Data source
# ---------------------------------------------------------------------------

def open_source(args: argparse.Namespace) -> IO[bytes]:
    """Return a binary file-like to stream JSON from (URL or local file)."""
    if args.local:
        path = args.local
        if not os.path.isfile(path):
            print(f"ERROR: {path} not found.", file=sys.stderr)
            raise SystemExit(1)
        print(f"Reading from local file: {path}")
        return open(path, "rb")

    url = args.url
    print(f"Fetching from: {url}")
    req = Request(url, headers={"User-Agent": "generate-db/1.0"})
    resp = urlopen(req, timeout=60)
    return resp


# ---------------------------------------------------------------------------
# SQLite helpers
# ---------------------------------------------------------------------------

def _connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    # Keep the published DB self-contained. WAL mode can leave browsers looking
    # for a sidecar -wal file after the static .db is fetched into memory.
    conn.execute("PRAGMA journal_mode = DELETE")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA temp_store = MEMORY")
    conn.execute("PRAGMA cache_size = -64000")  # 64 MiB page cache
    return conn


def _create_schema(conn: sqlite3.Connection) -> bool:
    """Create tables and indexes. Returns True if FTS5 is available."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS games (
            id        INTEGER PRIMARY KEY,
            name      TEXT    NOT NULL,
            name_norm TEXT    NOT NULL,
            path      TEXT    NOT NULL,
            path_norm TEXT    NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_games_name_norm
            ON games(name_norm COLLATE BINARY);
        CREATE INDEX IF NOT EXISTS idx_games_name_prefix
            ON games(name_norm COLLATE BINARY, id);
    """)

    has_fts5 = True
    try:
        conn.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS game_fts USING fts5(
                name,
                content='games',
                content_rowid='id',
                tokenize='unicode61 remove_diacritics 2'
            )
        """)
    except sqlite3.OperationalError:
        has_fts5 = False
        print(
            "NOTE: FTS5 not available — falling back to LIKE-based search. "
            "Install a Python built with SQLite ≥ 3.9.0 for FTS5 support.",
            file=sys.stderr,
        )
    return has_fts5


def _create_fts_triggers(conn: sqlite3.Connection) -> None:
    """Triggers to keep FTS index in sync with the games table."""
    conn.executescript("""
        CREATE TRIGGER IF NOT EXISTS games_ai AFTER INSERT ON games BEGIN
            INSERT INTO game_fts(rowid, name)
            VALUES (new.id, new.name);
        END;

        CREATE TRIGGER IF NOT EXISTS games_ad AFTER DELETE ON games BEGIN
            INSERT INTO game_fts(game_fts, rowid, name)
            VALUES ('delete', old.id, old.name);
        END;

        CREATE TRIGGER IF NOT EXISTS games_au AFTER UPDATE ON games BEGIN
            INSERT INTO game_fts(game_fts, rowid, name)
            VALUES ('delete', old.id, old.name);
            INSERT INTO game_fts(rowid, name)
            VALUES (new.id, new.name);
        END;
    """)


def build_database(source: IO[bytes], db_path: str) -> Tuple[int, int, bool]:
    """Main entry: stream JSON → insert into SQLite.

    Returns (total_json_entries_seen, rows_saved, fts5_enabled).
    """
    if os.path.exists(db_path):
        os.remove(db_path)

    conn = _connect(db_path)
    fts5 = _create_schema(conn)
    if fts5:
        _create_fts_triggers(conn)

    seen = 0
    saved = 0
    batch: List[Tuple[str, str, str, str]] = []  # name, name_norm, path, path_norm

    def flush() -> int:
        if not batch:
            return 0
        conn.executemany(
            "INSERT INTO games(name, name_norm, path, path_norm) VALUES (?, ?, ?, ?)",
            batch,
        )
        n = len(batch)
        batch.clear()
        return n

    for game_name, exe_path in iter_games(source):
        seen += 1
        nn = _normalise_name(game_name)
        pn = _normalise_path(exe_path)
        batch.append((game_name, nn, _windows_path(exe_path), pn))
        if len(batch) >= BATCH_SIZE:
            saved += flush()

    saved += flush()

    # Finalise FTS optimisation
    if fts5:
        conn.execute("INSERT INTO game_fts(game_fts) VALUES('optimize')")

    conn.commit()
    conn.close()
    return seen, saved, fts5


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch Discord detectable apps and build a searchable SQLite DB.",
    )
    parser.add_argument(
        "--url",
        default=DISCORD_DETECTABLE_URL,
        help=f"Discord API URL to fetch (default: {DISCORD_DETECTABLE_URL})",
    )
    parser.add_argument(
        "--local",
        metavar="FILE",
        help="Read from a local JSON file instead of fetching from the URL",
    )
    parser.add_argument(
        "--output",
        default="detectable.db",
        help="Output SQLite database path (default: detectable.db)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    db_path = args.output

    try:
        source = open_source(args)
    except Exception as exc:
        print(f"ERROR: failed to open data source: {exc}", file=sys.stderr)
        return 1

    try:
        seen, saved, fts5 = build_database(source, db_path)
    finally:
        source.close()

    print(f"Processed {seen} game entries")
    print(f"Saved {saved} rows to {db_path}")
    print(f"FTS5 search table: {'enabled' if fts5 else 'disabled'}")

    # Quick smoke-test query
    conn = sqlite3.connect(db_path)
    cur = conn.execute("SELECT COUNT(*) FROM games")
    count = cur.fetchone()[0]
    print(f"Verification: {count} rows in database")
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
