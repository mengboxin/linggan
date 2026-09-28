import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.settings_parsers import parse_bool_setting


def test_foxapi_promo_parser_accepts_disabled_values():
    values = [
        False,
        "false",
        "0",
        {"enabled": False},
        '{"enabled": false}',
        {"enabled": "false"},
    ]

    for value in values:
        assert parse_bool_setting(value) is False


def test_foxapi_promo_parser_accepts_enabled_values():
    values = [
        True,
        "true",
        "1",
        {"enabled": True},
        '{"enabled": true}',
        {"enabled": "true"},
    ]

    for value in values:
        assert parse_bool_setting(value) is True
