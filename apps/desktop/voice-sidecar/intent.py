"""Intent matcher for the Orchestra voice sidecar.

This module is pure (no audio, no models). It maps a transcribed phrase to
an `action_id` registered in the current vocabulary using a simple
normalized-Levenshtein scorer. It is a deliberately small piece so it can be
unit tested without recorded WAVs.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence


def _normalize(text: str) -> str:
    """Lowercase + collapse whitespace + strip punctuation we care about."""
    cleaned = []
    for ch in text.lower().strip():
        if ch.isalnum() or ch.isspace():
            cleaned.append(ch)
        elif ch in {"'", "-"}:
            # Keep contractions and hyphens as-is.
            cleaned.append(ch)
    return " ".join("".join(cleaned).split())


def _levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    # Standard DP, O(len(a) * len(b)).
    prev = list(range(len(b) + 1))
    for i, ch_a in enumerate(a, start=1):
        curr = [i] + [0] * len(b)
        for j, ch_b in enumerate(b, start=1):
            cost = 0 if ch_a == ch_b else 1
            curr[j] = min(
                curr[j - 1] + 1,      # insertion
                prev[j] + 1,          # deletion
                prev[j - 1] + cost,   # substitution
            )
        prev = curr
    return prev[-1]


def _similarity(a: str, b: str) -> float:
    """Normalized Levenshtein similarity in [0, 1]."""
    if not a and not b:
        return 1.0
    distance = _levenshtein(a, b)
    longest = max(len(a), len(b))
    if longest == 0:
        return 1.0
    return 1.0 - (distance / longest)


@dataclass(frozen=True)
class MatchResult:
    action_id: str
    phrase: str
    confidence: float


class IntentMatcher:
    """Best-match scorer over a small action vocabulary.

    `vocab` is a list of `{"actionId": str, "phrases": [str, ...]}` entries.
    The first phrase in each entry is conventionally the action name; further
    phrases are aliases. Matching tries:

    1. Exact normalized equality (confidence = 1.0).
    2. Phrase-as-substring of transcript (confidence = 0.95) — handles
       "ship it" / "ship the thing" while keeping "shipping container" off
       because "ship" is not a whole-word substring there. We require the
       phrase to appear bounded by word breaks to avoid the prefix collision.
    3. Normalized Levenshtein similarity, returning the best across all
       phrases when above the configured threshold.

    The first vocabulary entry wins on ties — preserves user creation order.
    """

    def __init__(
        self,
        vocab: Iterable[dict] | None = None,
        threshold: float = 0.75,
    ) -> None:
        self._threshold = threshold
        self._vocab: list[dict] = []
        self.set_vocab(vocab or [])

    @property
    def threshold(self) -> float:
        return self._threshold

    def set_threshold(self, threshold: float) -> None:
        self._threshold = float(threshold)

    def set_vocab(self, vocab: Iterable[dict]) -> None:
        normalized: list[dict] = []
        for entry in vocab:
            action_id = entry.get("actionId") or entry.get("action_id")
            phrases = entry.get("phrases") or []
            if not action_id or not phrases:
                continue
            normalized.append({
                "action_id": action_id,
                "phrases": [_normalize(p) for p in phrases if p and p.strip()],
            })
        self._vocab = normalized

    def vocab_size(self) -> int:
        return len(self._vocab)

    def match(self, transcript: str) -> MatchResult | None:
        if not transcript or not self._vocab:
            return None
        norm = _normalize(transcript)
        if not norm:
            return None

        best: MatchResult | None = None

        for entry in self._vocab:
            for phrase in entry["phrases"]:
                if not phrase:
                    continue
                # 1. Exact match.
                if norm == phrase:
                    return MatchResult(entry["action_id"], phrase, 1.0)

                # 2. Whole-word substring (handles "ship it"). Require the
                #    phrase to start at the beginning of a word AND end at a
                #    word boundary in the transcript so "shipping" doesn't
                #    match "ship".
                if _is_whole_word_substring(norm, phrase):
                    candidate = MatchResult(entry["action_id"], phrase, 0.95)
                    if best is None or candidate.confidence > best.confidence:
                        best = candidate
                    continue

                # 3. Fuzzy similarity.
                score = _similarity(norm, phrase)
                if score >= self._threshold and (best is None or score > best.confidence):
                    best = MatchResult(entry["action_id"], phrase, score)

        return best


def _is_whole_word_substring(haystack: str, needle: str) -> bool:
    """True when `needle` appears in `haystack` flanked by word boundaries.

    Because we already normalized to lowercase + alphanumeric + spaces, we can
    simply tokenize on whitespace and look for a contiguous token sequence.
    """
    needle_tokens: Sequence[str] = needle.split()
    haystack_tokens: Sequence[str] = haystack.split()
    if not needle_tokens or len(needle_tokens) > len(haystack_tokens):
        return False
    for start in range(len(haystack_tokens) - len(needle_tokens) + 1):
        if list(haystack_tokens[start:start + len(needle_tokens)]) == list(needle_tokens):
            return True
    return False
