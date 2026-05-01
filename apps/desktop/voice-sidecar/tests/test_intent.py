"""Unit tests for voice intent matching.

These tests do not touch audio. They drive the pure matcher with synthetic
transcripts so the matcher's behavior is decoupled from openWakeWord and
parakeet-mlx.
"""

from intent import IntentMatcher, MatchResult


def _vocab() -> list[dict]:
    return [
        {"actionId": "abc-1", "phrases": ["ship"]},
        {"actionId": "abc-2", "phrases": ["deploy", "deploy to prod"]},
        {"actionId": "abc-3", "phrases": ["run tests", "test"]},
    ]


def test_exact_match_returns_action() -> None:
    matcher = IntentMatcher(_vocab())
    result = matcher.match("ship")
    assert isinstance(result, MatchResult)
    assert result is not None and result.action_id == "abc-1"
    assert result.confidence == 1.0


def test_close_match_passes_threshold() -> None:
    matcher = IntentMatcher(_vocab(), threshold=0.75)
    # "shp" is a single typo away from "ship"; normalized Levenshtein ~= 0.75.
    result = matcher.match("shp")
    assert result is not None and result.action_id == "abc-1"


def test_extra_words_match_when_phrase_is_substring() -> None:
    matcher = IntentMatcher(_vocab())
    result = matcher.match("ship it")
    assert result is not None and result.action_id == "abc-1"

    result = matcher.match("ship the thing")
    assert result is not None and result.action_id == "abc-1"


def test_unrelated_words_do_not_match() -> None:
    matcher = IntentMatcher(_vocab())
    # "shipping container" contains the word "shipping" which is not a substring
    # of "ship" alone — but we explicitly want this not to fire.
    result = matcher.match("shipping container")
    assert result is None or result.action_id != "abc-1"


def test_alias_resolves_to_owning_action() -> None:
    matcher = IntentMatcher(_vocab())
    result = matcher.match("deploy to prod")
    assert result is not None and result.action_id == "abc-2"


def test_below_threshold_returns_none() -> None:
    matcher = IntentMatcher(_vocab(), threshold=0.95)
    # "shp" similarity ~= 0.75; with a 0.95 threshold, must reject.
    result = matcher.match("shp")
    assert result is None


def test_empty_vocab_never_matches() -> None:
    matcher = IntentMatcher([])
    assert matcher.match("anything") is None


def test_collision_first_wins_by_creation_order() -> None:
    vocab = [
        {"actionId": "first", "phrases": ["build"]},
        {"actionId": "second", "phrases": ["build"]},
    ]
    matcher = IntentMatcher(vocab)
    result = matcher.match("build")
    assert result is not None and result.action_id == "first"


def test_set_vocab_replaces_previous() -> None:
    matcher = IntentMatcher([{"actionId": "a", "phrases": ["alpha"]}])
    assert matcher.match("alpha") is not None
    matcher.set_vocab([{"actionId": "b", "phrases": ["beta"]}])
    assert matcher.match("alpha") is None
    assert matcher.match("beta") is not None
