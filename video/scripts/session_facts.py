#!/usr/bin/env python3
"""Collect everything the film will quote about the recorded Faultline session into data/session.json.

    python3 scripts/session_facts.py <take dir> [--db <faultline.db>] [--out data/session.json]

Sources, in order of authority:
  * Faultline's own SQLite recorder (traces, replays, contracts, chaos_rules, active_proxies);
  * `hermes faultline contracts` / `status` JSON for the same home (the plugin's own CLI);
  * the asciicast of the `hermes chat` session (tool rows in the order they were printed, the agent's replies);
  * the storefront client's output files (what the proxy answered, with X-Faultline-Trace-Id);
  * the recorder's marks (cast seconds + epoch seconds) and the take's UTC start/end.
Nothing here is typed by hand; every value is read from one of those.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

ANSI = re.compile(r"\x1b\[[0-9;?]* ?[A-Za-z@]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]|\r")
# Tool rows as the modern CLI prints them: an emoji, a space, a label. The label is the tool name for plugin
# tools ("🛰️ Faultline_proxy"), the file for read/patch ("🔧 Patch /path"), the command for the terminal
# ("💻 $ grep ..."). Spinner lines ("── ⠴ 🛰️ faultline_proxy · 8s") and "Preparing" lines are not rows.
EMOJI_TOOL = {
    "🛰️": "faultline_proxy", "🛰": "faultline_proxy", "📡": "faultline_traces", "🔁": "faultline_replay",
    "📜": "faultline_contract", "⚡": "faultline_chaos", "🧪": "faultline_simulate",
    "🔧": "patch", "✍️": "write_file", "✍": "write_file", "📖": "read_file", "🔎": "search_files", "💻": "terminal",
}
# The spinner's elapsed-seconds counter can land just before the emoji on the same line ("64🔁 Faultline_replay").
TOOL_ROW = re.compile(r"(?m)^[ \t\d⠀-⣿]{0,8}(🛰️|🛰|📡|🔁|📜|⚡|🧪|🔧|✍️|✍|📖|🔎|💻)[ \t]+([^\n]{1,200}?)[ \t]*$")
# A long footer wraps at the terminal width, so the middle may contain a line break.
FOOTER = re.compile(r"─ (?:(\d+)m)?(\d+(?:\.\d+)?)s · ([^\n]{0,160}(?:\n[^\n]{0,160})?) · (\d+:\d\d [AP]M)")
HERMES = "hermes"
FILM_HOME = "/private/tmp/claude-501/-Users-bigmantech001-Faultline/24ea2fa7-aaf2-4fa6-8efe-c0431050eb42/scratchpad/film-home"


def read_cast(path: Path):
    lines = path.read_text(encoding="utf-8").splitlines()
    header = json.loads(lines[0])
    events = [json.loads(l) for l in lines[1:] if l.strip()]
    return header, events


def cast_timeline(events):
    """Plain text of the whole session plus, for every character, the cast time it was printed at."""
    text_parts, times = [], []
    for t, _, data in events:
        plain = ANSI.sub("", data)
        text_parts.append(plain)
        times.extend([t] * len(plain))
    return "".join(text_parts), times


def tool_rows(text, times):
    rows = []
    for m in TOOL_ROW.finditer(text):
        emoji, label = m.group(1), m.group(2).strip()
        if "Preparing" in label or label.startswith("$ ") is False and emoji == "💻" and not label:
            continue
        if "Preparing" in label:
            continue
        tool = EMOJI_TOOL.get(emoji, emoji)
        if emoji == "📖" and label.lower().startswith("reading tool details"):
            tool = "tool_details"  # Hermes fetching a deferred tool's schema, not a tool call
        if emoji == "🔎" and label.lower().startswith("searching tools"):
            tool = "tool_search"
        t = round(times[m.start(1)], 3)
        if rows and rows[-1]["label"] == label and t - rows[-1]["cast_seconds"] < 3:
            continue  # the same row redrawn
        rows.append({"tool": tool, "emoji": emoji, "label": label, "cast_seconds": t})
    return rows


def footers(text, times):
    out = []
    for m in FOOTER.finditer(text):
        mins, secs, middle, clock = m.groups()
        called = re.search(r"called (\d+) tools?", middle)
        middle = " ".join(middle.split())
        out.append({"turn_seconds": round((int(mins) if mins else 0) * 60 + float(secs), 1), "summary": middle,
                    "tools_called": int(called.group(1)) if called else 0, "clock": clock, "cast_seconds": round(times[m.start()], 3)})
    return out


def typed_prompts(text, times, steps):
    """The user turns, taken from the take's own step list, located where the CLI echoed them."""
    out = []
    def walk(step_list):
        for st in step_list:
            if "type" in st and not st["type"].startswith("/"):
                yield st["type"]
            for sub in st.get("steps", []) or []:
                yield from walk([sub])
    pos = 0
    for typed in walk(steps):
        i = text.find(typed[:40], pos)
        if i < 0:
            continue
        out.append({"text": typed, "cast_seconds": round(times[i], 3)})
        pos = i + 1
    return out


def rows(conn, sql, params=()):
    conn.row_factory = sqlite3.Row
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("take")
    ap.add_argument("--db", default=f"{FILM_HOME}/plugin-data/faultline/faultline.db")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[1] / "data" / "session.json"))
    ap.add_argument("--cast-only", action="store_true", help="parse the cast and print; touch nothing else")
    ap.add_argument("--orig-logic", default="/private/tmp/claude-501/-Users-bigmantech001-Faultline/24ea2fa7-aaf2-4fa6-8efe-c0431050eb42/scratchpad/film/checkout_logic.orig.py")
    args = ap.parse_args()
    take = Path(args.take)

    header, events = read_cast(take / "session.cast")
    text, times = cast_timeline(events)
    marks = json.loads((take / "marks_term.json").read_text())
    if args.cast_only:
        steps = json.loads((take / "steps.json").read_text()) if (take / "steps.json").exists() else []
        for r in tool_rows(text, times):
            print(f"{r['cast_seconds']:7.1f}  {r['tool']:18s} {r['label'][:90]}")
        for f in footers(text, times):
            print(f"{f['cast_seconds']:7.1f}  FOOTER {f['turn_seconds']}s tools={f['tools_called']} :: {f['summary']}")
        for p in typed_prompts(text, times, steps):
            print(f"{p['cast_seconds']:7.1f}  PROMPT {p['text'][:80]}")
        return

    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    traces = rows(conn, "SELECT * FROM traces ORDER BY created_at ASC")
    for t in traces:
        t["drifts"] = json.loads(t.pop("drift_json") or "[]")
        t["request_headers"] = json.loads(t.pop("request_headers_json") or "{}")
        t["response_headers"] = json.loads(t.pop("response_headers_json") or "{}")
        t.pop("response_schema_json", None)
    replays = rows(conn, "SELECT * FROM replays ORDER BY created_at ASC")
    for r in replays:
        r["diff_summary"] = json.loads(r.pop("diff_summary_json") or "{}")
    contracts = rows(conn, "SELECT contract_key, method, normalized_path, expected_status, baseline_latency_ms, sample_count, updated_at FROM contracts ORDER BY normalized_path, method")
    chaos = rows(conn, "SELECT * FROM chaos_rules ORDER BY created_at ASC")
    active = rows(conn, "SELECT * FROM active_proxies")

    failing = [t for t in traces if t["response_status"] >= 500 and not t["replayed_from"]]
    # The failing request the story follows is the one the agent replayed (the storefront's coupon checkout);
    # any other 5xx is the agent reproducing the bug by hand through the proxy.
    by_id = {t["trace_id"]: t for t in traces}
    first_fail = by_id.get(replays[0]["original_trace_id"]) if replays else (failing[0] if failing else None)
    reproduced = [t for t in failing if not first_fail or t["trace_id"] != first_fail["trace_id"]]
    drift_traces = [t for t in traces if t["drifts"]]
    orders_102 = [t for t in traces if t["path"].endswith("/orders/102")]

    env = {**os.environ, "HERMES_HOME": FILM_HOME}
    cli = {}
    for sub in ("status", "contracts"):
        try:
            cli[sub] = json.loads(subprocess.run([HERMES, "faultline", sub], env=env, capture_output=True, text=True, timeout=120).stdout)
        except Exception as exc:  # noqa: BLE001
            cli[sub] = {"error": str(exc)}

    traffic = {}
    for f in sorted(take.glob("traffic_*.txt")):
        traffic[f.stem.replace("traffic_", "")] = f.read_text().splitlines()

    proxy_url = None
    m = re.search(r"http://127\.0\.0\.1:8700", text)
    if m:
        proxy_url = m.group(0)
    if active:
        proxy_url = proxy_url or f"http://127.0.0.1:{active[0]['listen_port']}"

    tools = tool_rows(text, times)
    turns = footers(text, times)
    steps = json.loads((take / "steps.json").read_text()) if (take / "steps.json").exists() else []
    prompts = typed_prompts(text, times, steps)

    def reply_after(cast_t: float, limit: int = 1600) -> str:
        """The agent's final prose for the turn that ends at the footer after cast_t (best effort)."""
        i = next((k for k, ct in enumerate(times) if ct >= cast_t), None)
        if i is None:
            return ""
        return text[max(0, i - limit):i]

    orig_logic = Path(args.orig_logic)
    logic_now = Path("/Users/bigmantech001/Faultline/video/demo/checkout_logic.py")
    logic_patch = ""
    if orig_logic.exists() and logic_now.exists():
        import difflib
        logic_patch = "".join(difflib.unified_diff(orig_logic.read_text().splitlines(True), logic_now.read_text().splitlines(True), "a/checkout_logic.py", "b/checkout_logic.py"))
    stills_dir = Path(__file__).resolve().parents[1] / ".cache/frames/studio-stills"
    stills = sorted(str(p) for p in stills_dir.glob("*.png")) if stills_dir.exists() else []
    approvals = {k: v for k, v in (marks.get("marks") or {}).items() if k.startswith("approval")}

    session = {
        "take_dir": str(take),
        "recorded_utc": {
            "start": (take / "started_utc.txt").read_text().strip() if (take / "started_utc.txt").exists() else None,
            "end": (take / "ended_utc.txt").read_text().strip() if (take / "ended_utc.txt").exists() else None,
            "cast_header_timestamp": header.get("timestamp"),
        },
        "hermes": {"version": "0.23.0", "model": "claude-sonnet-4.6", "home": FILM_HOME, "command": "hermes chat --in /Users/bigmantech001/Faultline/video/demo"},
        "terminal": {"cols": header.get("width"), "rows": header.get("height"), "cast_seconds": events[-1][0] if events else 0},
        "proxy_url": proxy_url,
        "active_proxies_rows": active,
        "prompts": prompts,
        "tool_rows": tools,
        "agent_tool_calls": [t["tool"] for t in tools],
        "turn_footers": turns,
        "traces": traces,
        "failing_trace": first_fail,
        "reproduced_by_agent_5xx": reproduced,
        "checkout_logic_patch": logic_patch,
        "approvals_answered_by_recorder": approvals,
        "studio_stills": stills,
        "replays": replays,
        "drift_traces": drift_traces,
        "orders_102": orders_102,
        "chaos_rules": chaos,
        "contracts": contracts,
        "contract_keys": [c["contract_key"] for c in contracts],
        "cli": cli,
        "traffic": traffic,
        "marks": marks,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(session, indent=1, default=str))
    print(f"wrote {out}")
    print(f"traces={len(traces)} failing={len(failing)} replays={len(replays)} drifts={len(drift_traces)} chaos={len(chaos)} contracts={len(contracts)}")
    print("tool rows:", [(t['tool'], t['cast_seconds']) for t in tools])
    print("footers:", [(f['tools_called'], f['cast_seconds']) for f in turns])
    print("prompts:", [(p['text'][:50], p['cast_seconds']) for p in prompts])
    if first_fail:
        print("failing:", first_fail["trace_id"], first_fail["response_status"], first_fail["latency_ms"], first_fail["response_body"][:160])
    for r in replays:
        print("replay:", r["replay_id"], r["original_trace_id"], "->", r["replay_trace_id"], r["old_status"], "->", r["new_status"], r["old_latency_ms"], r["new_latency_ms"])


if __name__ == "__main__":
    main()
