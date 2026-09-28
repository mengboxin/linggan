import json


def parse_bool_setting(value, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        raw = value.strip()
        if raw.lower() in {"true", "1", "yes", "on"}:
            return True
        if raw.lower() in {"false", "0", "no", "off"}:
            return False
        try:
            value = json.loads(raw)
        except Exception:
            return default
    if isinstance(value, dict):
        return parse_bool_setting(value.get("enabled"), default)
    return bool(value)
