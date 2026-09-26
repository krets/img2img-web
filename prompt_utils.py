"""Prompt-text helpers shared by db.py (hash on insert) and its startup backfill."""

import hashlib
import re

_WHITESPACE = re.compile(r"\s+")

# Changing this default changes every hash, i.e. requires re-hashing all results.
CASEFOLD_DEFAULT = False


def normalize_prompt(text, casefold=CASEFOLD_DEFAULT):
    """Strips and collapses runs of whitespace so trivially different copies of
    a prompt group together. Returns "" for None.
    """
    normalized = _WHITESPACE.sub(" ", (text or "").strip())
    return normalized.casefold() if casefold else normalized


def prompt_hash(text, casefold=CASEFOLD_DEFAULT):
    """sha256 hex of the normalized prompt, or None when there is no prompt text."""
    normalized = normalize_prompt(text, casefold)
    if not normalized:
        return None
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()
