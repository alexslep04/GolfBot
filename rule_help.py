"""Read hover explanations from the one authoritative rules document."""
from pathlib import Path
import re


def load_rule_help():
    source = Path(__file__).with_name("RULES.md").read_text(encoding="utf-8")
    descriptions = {}
    for match in re.finditer(r"(?ms)^### ([^\n]+)\n(.*?)(?=^### |^## |\Z)", source):
        title, body = match.groups()
        marker = re.search(r"<!-- rule: ([\w, ]+) -->", body)
        if marker is None:
            continue
        plain = re.sub(r"<!--.*?-->", "", body, flags=re.S)
        plain = plain.replace("**", "").replace("`", "")
        plain = " ".join(plain.split())
        for key in marker.group(1).split(","):
            descriptions[key.strip()] = (title, plain)
    return descriptions
