#!/usr/bin/env python3
"""Record a real terminal session as asciicast v2 while driving it from a step list.

    python3 record_pty.py --cols 120 --rows 34 --out .cache/session.cast --marks .cache/marks_term.json \
        --steps steps.json -- hermes chat

steps.json is a list of steps, run in order:
    {"wait_for": "regex", "timeout": 60, "mark": "name"}   wait until the regex matches recent output (escape
                                              codes stripped first; optional "mark": note the match time)
    {"sleep": 2.5}                            pause (recorded as silence)
    {"type": "text", "enter": true, "cps": 14} type like a person (chars per second, wall clock), then Enter
    {"key": "enter" | "ctrl-c" | "y"}         a single key
    {"run": "shell command", "out": "file", "mark": "name"}
                                              run a command on the side (not shown), e.g. send traffic;
                                              "out" saves its stdout+stderr to a file; "mark" names the
                                              run:<mark> timestamp (default: first 30 chars of the command)
    {"mark": "name"}                          note the current time under this name (for the film's timing)
    {"wait_idle": 3.0, "timeout": 120}       wait until the output has been quiet for N seconds
    {"wait_run": true, "timeout": 60}         wait until every side command started so far has exited
    {"wait_until": "shell command", "timeout": 120, "every": 0.5, "mark": "name"}
                                              wait until the command exits 0 (e.g. a DB row exists)
    {"autoreply": [{"pattern": "regex", "key": "enter", "mark": "approval"}]}
                                              from now on, whenever the pattern matches NEW output during any
                                              wait, press the key once per occurrence (e.g. an approval box)
    {"unless": "regex", "steps": [...]}       run the sub-steps only if the regex has NOT matched any output so far
    {"if": "regex", "steps": [...]}           run the sub-steps only if the regex HAS matched some output so far

wait_for searches the output that arrived after the previous wait_for match or the previous typed line
(whichever is later), so a line from an earlier turn cannot satisfy a later wait; "anywhere": true searches
everything.

Output chunks are timestamped from the first byte, so the replay is faithful. Nothing is typed into the
session that is not in the step list.

The marks file holds three things: "t0" (epoch seconds of the recording start), "marks" (seconds from t0,
the cast's own clock, for the replayer) and "epoch" (the same marks in epoch seconds, so they line up with
a screen recording made at the same time).
"""

from __future__ import annotations

import argparse
import codecs
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
import fcntl


KEYS = {"enter": "\r", "ctrl-c": "\x03", "ctrl-d": "\x04", "tab": "\t", "esc": "\x1b", "down": "\x1b[B", "up": "\x1b[A"}


def set_winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cols", type=int, default=120)
    ap.add_argument("--rows", type=int, default=34)
    ap.add_argument("--out", required=True)
    ap.add_argument("--marks", required=True)
    ap.add_argument("--steps", required=True)
    ap.add_argument("--env", action="append", default=[], help="KEY=VALUE for the child")
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    args = ap.parse_args()
    cmd = args.cmd[1:] if args.cmd and args.cmd[0] == "--" else args.cmd
    if not cmd:
        ap.error("command missing (after --)")
    steps = json.load(open(args.steps))

    env = dict(os.environ)
    env.update({"TERM": "xterm-256color", "COLUMNS": str(args.cols), "LINES": str(args.rows)})
    for kv in args.env:
        k, _, v = kv.partition("=")
        env[k] = v

    pid, fd = pty.fork()
    if pid == 0:  # child
        os.execvpe(cmd[0], cmd, env)
    set_winsize(fd, args.rows, args.cols)

    t0 = time.time()
    events: list = []
    marks: dict = {}
    side: list = []  # side commands (Popen handles)
    recent = ""  # everything the child printed (matched with escape codes stripped); cursor = where the current wait starts
    cursor = 0
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")  # a glyph split across two reads stays whole
    responders: list = []  # [{"pat": compiled, "key": str, "mark": str|None, "pos": int (search from here), "count": int}]
    ansi = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]|\r")

    def now() -> float:
        return round(time.time() - t0, 3)

    def note(name: str) -> None:
        marks[name] = now()
        print(f"[record] mark {name} at {marks[name]}s", file=sys.stderr)

    def pump(timeout: float) -> bool:
        """Read whatever the child printed within `timeout`; returns False when the child exited."""
        nonlocal recent
        r, _, _ = select.select([fd], [], [], timeout)
        if not r:
            return True
        try:
            data = os.read(fd, 65536)
        except OSError:
            return False
        if not data:
            return False
        text = decoder.decode(data)
        if not text:
            return True
        events.append([now(), "o", text])
        recent += text
        for r in responders:
            m = r["pat"].search(ansi.sub("", recent[r["pos"]:]))
            if m:
                r["count"] += 1
                r["pos"] = len(recent)  # one answer per occurrence
                name = f"{r['mark'] or 'autoreply'}.{r['count']}"
                marks[name] = now()
                print(f"[record] autoreply {name}: key {r['key']!r} at {marks[name]}s", file=sys.stderr)
                time.sleep(0.6)  # let the menu finish drawing before answering
                os.write(fd, KEYS.get(r["key"], r["key"]).encode("utf-8"))
        return True

    def pump_until(deadline: float) -> bool:
        """Keep reading until the wall-clock deadline (so typing speed does not depend on output bursts)."""
        ok = True
        while ok and time.time() < deadline:
            ok = pump(max(0.005, min(0.1, deadline - time.time())))
        return ok

    def write(s: str) -> None:
        os.write(fd, s.encode("utf-8"))

    alive = True

    def plain_since(start: int) -> str:
        return ansi.sub("", recent[start:])

    def run_steps(step_list: list) -> None:
        nonlocal alive, recent, cursor
        for step in step_list:
            if "wait_for" in step:
                pat = re.compile(step["wait_for"], re.S)
                deadline = time.time() + float(step.get("timeout", 60))
                start = 0 if step.get("anywhere") else cursor
                matched = False
                while time.time() < deadline and alive:
                    m = pat.search(plain_since(start))
                    if m:
                        matched = True
                        if step.get("mark"):
                            note(step["mark"])
                        break
                    alive = pump(0.1)
                if matched:
                    cursor = len(recent)
                else:
                    print(f"[record] timeout waiting for {step['wait_for']!r}", file=sys.stderr)
                    marks[f"timeout:{step.get('mark') or step['wait_for'][:30]}"] = now()
            elif "wait_idle" in step:
                quiet = float(step["wait_idle"])
                deadline = time.time() + float(step.get("timeout", 120))
                last = time.time()
                while time.time() < deadline and alive:
                    before = len(events)
                    alive = pump(0.2)
                    if len(events) != before:
                        last = time.time()
                    elif time.time() - last >= quiet:
                        break
                else:
                    print(f"[record] timeout in wait_idle", file=sys.stderr)
                if step.get("mark"):
                    note(step["mark"])
            elif "wait_run" in step:
                deadline = time.time() + float(step.get("timeout", 60))
                while time.time() < deadline and alive and any(p.poll() is None for p in side):
                    alive = pump(0.1)
            elif "wait_until" in step:
                deadline = time.time() + float(step.get("timeout", 120))
                every = float(step.get("every", 0.5))
                ok = False
                while time.time() < deadline and alive:
                    if subprocess.run(step["wait_until"], shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                        ok = True
                        break
                    alive = pump_until(time.time() + every)
                if ok:
                    if step.get("mark"):
                        note(step["mark"])
                else:
                    print(f"[record] timeout in wait_until {step['wait_until'][:60]!r}", file=sys.stderr)
                    marks[f"timeout:{step.get('mark') or 'wait_until'}"] = now()
            elif "autoreply" in step:
                for r in step["autoreply"]:
                    responders.append({"pat": re.compile(r["pattern"], re.S), "key": r.get("key", "enter"), "mark": r.get("mark"), "pos": len(recent), "count": 0})
                print(f"[record] {len(step['autoreply'])} autoreply responder(s) armed", file=sys.stderr)
            elif "unless" in step or "if" in step:
                pat = re.compile(step.get("unless") or step.get("if"), re.S)
                seen = bool(pat.search(plain_since(0)))
                if ("unless" in step and not seen) or ("if" in step and seen):
                    print(f"[record] condition {'unless' if 'unless' in step else 'if'} {pat.pattern!r}: running {len(step.get('steps', []))} step(s)", file=sys.stderr)
                    run_steps(step.get("steps", []))
                else:
                    print(f"[record] condition {'unless' if 'unless' in step else 'if'} {pat.pattern!r}: skipped", file=sys.stderr)
            elif "sleep" in step:
                alive = pump_until(time.time() + float(step["sleep"]))
            elif "type" in step:
                cps = float(step.get("cps", 14))
                for ch in step["type"]:
                    write(ch)
                    alive = pump_until(time.time() + 1.0 / cps)
                    if not alive:
                        break
                if step.get("enter", True) and alive:
                    alive = pump_until(time.time() + 0.25)
                    write("\r")
                cursor = len(recent)
                if step.get("mark"):
                    note(step["mark"])
            elif "key" in step:
                key = step["key"]
                write(KEYS.get(key, key))
            elif "run" in step:
                name = step.get("mark", step["run"][:30])
                marks[f"run:{name}"] = now()
                print(f"[record] run {name} at {marks[f'run:{name}']}s", file=sys.stderr)
                out = open(step["out"], "ab") if step.get("out") else subprocess.DEVNULL
                side.append(subprocess.Popen(step["run"], shell=True, stdout=out, stderr=subprocess.STDOUT))
            elif "mark" in step:
                note(step["mark"])
            else:
                print(f"[record] unknown step {step}", file=sys.stderr)
            if not alive:
                break

    try:
        run_steps(steps)
        # drain
        alive = pump_until(time.time() + 1.5) if alive else alive
    finally:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        header = {"version": 2, "width": args.cols, "height": args.rows, "timestamp": int(t0), "env": {"TERM": "xterm-256color"}}
        os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
        with open(args.out, "w") as f:
            f.write(json.dumps(header) + "\n")
            for ev in events:
                f.write(json.dumps(ev) + "\n")
        with open(args.marks, "w") as f:
            json.dump({"t0": t0, "marks": marks, "epoch": {k: round(t0 + v, 3) for k, v in marks.items()}}, f, indent=1)
        print(f"[record] {len(events)} chunks, {events[-1][0] if events else 0}s -> {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
