"""Core HTTP flight recorder, OpenAPI contract verifier, chaos injector, and deterministic replay engine for Faultline."""

from __future__ import annotations

import datetime as _dt
import http.server
import json
import random
import re
import socketserver
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

try:
    from plugins.plugin_storage import plugin_data_dir, plugin_db, plugin_state_dir
except ImportError:
    def plugin_data_dir(plugin_name: str, ensure: bool = True) -> Path:
        base = Path.home() / ".hermes" / "plugins" / plugin_name / "data"
        if ensure:
            base.mkdir(parents=True, exist_ok=True)
        return base

    def plugin_state_dir(plugin_name: str, ensure: bool = True) -> Path:
        base = Path.home() / ".hermes" / "plugins" / plugin_name / "state"
        if ensure:
            base.mkdir(parents=True, exist_ok=True)
        return base

    def plugin_db(plugin_name: str, db_name: str = "state.db") -> sqlite3.Connection:
        db_path = plugin_data_dir(plugin_name, ensure=True) / db_name
        conn = sqlite3.connect(str(db_path), timeout=15.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

try:
    from hermes_cli.plugin_events import broadcast_plugin_event
except ImportError:
    def broadcast_plugin_event(plugin_name: str, event_type: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return {"plugin": plugin_name, "type": event_type, "payload": payload or {}}

try:
    from agent.redact import redact_sensitive_text
except ImportError:
    def redact_sensitive_text(text: str) -> str:
        if not text:
            return text
        return re.sub(r"(Bearer\s+)[A-Za-z0-9._\-]+", r"\1[REDACTED]", text)


PLUGIN_NAME = "faultline"
LOOPBACK_HOST = "127.0.0.1"
SENSITIVE_HEADERS = {
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "api-key",
    "x-auth-token",
    "x-secret-key",
}

_DB_CACHE: Dict[str, sqlite3.Connection] = {}
_ACTIVE_PROXIES: Dict[int, "ManagedProxyInstance"] = {}
_PROXY_LOCK = threading.Lock()


def _utc_now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


def close_cached_dbs() -> None:
    """Close cached SQLite connections cleanly (used by unit tests)."""
    for key, conn in list(_DB_CACHE.items()):
        try:
            conn.close()
        except Exception:
            pass
        _DB_CACHE.pop(key, None)


def get_db(custom_data_dir: Optional[Path] = None) -> sqlite3.Connection:
    if custom_data_dir is not None:
        custom_data_dir.mkdir(parents=True, exist_ok=True)
        db_file = str((custom_data_dir / "faultline.db").resolve())
        if db_file in _DB_CACHE:
            return _DB_CACHE[db_file]
        conn = sqlite3.connect(db_file, timeout=15.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
    else:
        db_file = str((plugin_data_dir(PLUGIN_NAME, ensure=True) / "faultline.db").resolve())
        if db_file in _DB_CACHE:
            return _DB_CACHE[db_file]
        conn = plugin_db(PLUGIN_NAME, "faultline.db")
    _init_db(conn)
    _DB_CACHE[db_file] = conn
    return conn


def _init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS traces (
            trace_id TEXT PRIMARY KEY,
            method TEXT NOT NULL,
            path TEXT NOT NULL,
            normalized_path TEXT NOT NULL,
            query_string TEXT DEFAULT '',
            target_url TEXT NOT NULL,
            request_headers_json TEXT DEFAULT '{}',
            request_body TEXT DEFAULT '',
            response_status INTEGER NOT NULL,
            response_headers_json TEXT DEFAULT '{}',
            response_body TEXT DEFAULT '',
            latency_ms REAL DEFAULT 0.0,
            response_schema_json TEXT DEFAULT '{}',
            drift_json TEXT DEFAULT '[]',
            chaos_rule_id TEXT DEFAULT '',
            replayed_from TEXT DEFAULT '',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS contracts (
            contract_key TEXT PRIMARY KEY,
            method TEXT NOT NULL,
            normalized_path TEXT NOT NULL,
            expected_status INTEGER NOT NULL,
            request_schema_json TEXT DEFAULT '{}',
            response_schema_json TEXT DEFAULT '{}',
            baseline_latency_ms REAL DEFAULT 0.0,
            sample_count INTEGER DEFAULT 1,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chaos_rules (
            rule_id TEXT PRIMARY KEY,
            method TEXT NOT NULL,
            path_pattern TEXT NOT NULL,
            fault_type TEXT NOT NULL,
            status_code INTEGER DEFAULT 503,
            latency_ms INTEGER DEFAULT 0,
            probability REAL DEFAULT 1.0,
            response_body TEXT DEFAULT '',
            hits INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS replays (
            replay_id TEXT PRIMARY KEY,
            original_trace_id TEXT NOT NULL,
            replay_trace_id TEXT NOT NULL,
            target_url TEXT NOT NULL,
            old_status INTEGER NOT NULL,
            new_status INTEGER NOT NULL,
            old_latency_ms REAL DEFAULT 0.0,
            new_latency_ms REAL DEFAULT 0.0,
            resolved_error INTEGER DEFAULT 0,
            diff_summary_json TEXT DEFAULT '{}',
            created_at TEXT NOT NULL
        );
        """
    )
    conn.commit()


def normalize_route_path(path: str) -> str:
    """Normalize numeric IDs and UUID segments into `{id}` for OpenAPI grouping."""
    clean = path.split("?", 1)[0].strip() or "/"
    if not clean.startswith("/"):
        clean = "/" + clean
    segments = [seg for seg in clean.split("/") if seg]
    normalized: List[str] = []
    uuid_re = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    for seg in segments:
        if seg.isdigit() or uuid_re.match(seg) or re.match(r"^(ord|usr|chk|pay|inv)_[A-Za-z0-9]+$", seg):
            normalized.append("{id}")
        else:
            normalized.append(seg)
    return "/" + "/".join(normalized) if normalized else "/"


def redact_headers(headers: Dict[str, Any]) -> Dict[str, str]:
    sanitized: Dict[str, str] = {}
    for k, v in (headers or {}).items():
        key_str = str(k)
        val_str = str(v)
        if key_str.lower() in SENSITIVE_HEADERS:
            sanitized[key_str] = "[REDACTED]"
        else:
            sanitized[key_str] = redact_sensitive_text(val_str)
    return sanitized


def redact_body(body_text: str) -> str:
    if not body_text:
        return ""
    redacted = redact_sensitive_text(body_text)
    redacted = re.sub(
        r'("(?:password|secret|api_key|access_token|refresh_token|client_secret)"\s*:\s*)"[^"]*"',
        r'\1"[REDACTED]"',
        redacted,
        flags=re.IGNORECASE,
    )
    return redacted[:32768]


def infer_json_schema(value: Any) -> Dict[str, Any]:
    """Infer a concise JSON Schema (Draft 2020-12 / OpenAPI 3.1 compatible) from a Python value."""
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "boolean"}
    if isinstance(value, int):
        return {"type": "integer"}
    if isinstance(value, float):
        return {"type": "number"}
    if isinstance(value, str):
        return {"type": "string"}
    if isinstance(value, list):
        if not value:
            return {"type": "array", "items": {}}
        return {"type": "array", "items": infer_json_schema(value[0])}
    if isinstance(value, dict):
        props: Dict[str, Any] = {}
        req: List[str] = []
        for k in sorted(value.keys()):
            props[str(k)] = infer_json_schema(value[k])
            if value[k] is not None:
                req.append(str(k))
        return {
            "type": "object",
            "properties": props,
            "required": req,
        }
    return {"type": "string"}


def _parse_json_OrderIndependent(raw_text: str) -> Tuple[bool, Any]:
    if not raw_text or not raw_text.strip():
        return False, None
    try:
        return True, json.loads(raw_text)
    except Exception:
        return False, None


def compare_schemas(
    baseline_schema: Dict[str, Any],
    observed_schema: Dict[str, Any],
    path_prefix: str = "$",
) -> List[Dict[str, Any]]:
    """Compare an observed JSON schema against the baseline contract schema and return drift findings."""
    drifts: List[Dict[str, Any]] = []
    if not baseline_schema or not observed_schema:
        return drifts

    base_type = baseline_schema.get("type")
    obs_type = observed_schema.get("type")
    if base_type and obs_type and base_type != obs_type:
        # Allow integer -> number widening without false alarm only if not strict, but integer -> string is a hard drift
        if not ({base_type, obs_type} == {"integer", "number"}):
            drifts.append(
                {
                    "kind": "type_mismatch",
                    "field": path_prefix,
                    "expected": base_type,
                    "actual": obs_type,
                    "severity": "high",
                    "message": f"Field `{path_prefix}` changed type from `{base_type}` to `{obs_type}`.",
                }
            )
        return drifts

    if base_type == "object":
        base_props = baseline_schema.get("properties") or {}
        obs_props = observed_schema.get("properties") or {}
        base_req = set(baseline_schema.get("required") or [])

        for req_field in sorted(base_req):
            if req_field not in obs_props:
                drifts.append(
                    {
                        "kind": "missing_required_field",
                        "field": f"{path_prefix}.{req_field}",
                        "expected": base_props.get(req_field, {}).get("type", "present"),
                        "actual": "missing",
                        "severity": "high",
                        "message": f"Required field `{path_prefix}.{req_field}` is missing from response.",
                    }
                )

        for field_name, sub_base in base_props.items():
            if field_name in obs_props:
                drifts.extend(
                    compare_schemas(
                        sub_base,
                        obs_props[field_name],
                        path_prefix=f"{path_prefix}.{field_name}",
                    )
                )

    elif base_type == "array":
        base_items = baseline_schema.get("items") or {}
        obs_items = observed_schema.get("items") or {}
        if base_items and obs_items:
            drifts.extend(compare_schemas(base_items, obs_items, path_prefix=f"{path_prefix}[0]"))

    return drifts


def record_trace(
    method: str,
    path: str,
    target_url: str,
    request_headers: Optional[Dict[str, Any]],
    request_body: str,
    response_status: int,
    response_headers: Optional[Dict[str, Any]],
    response_body: str,
    latency_ms: float,
    chaos_rule_id: str = "",
    replayed_from: str = "",
    data_dir: Optional[Path] = None,
) -> Dict[str, Any]:
    """Persist an intercepted HTTP request/response trace and audit it against learned OpenAPI contracts."""
    conn = get_db(data_dir)
    trace_id = f"flt-{uuid.uuid4().hex[:8]}"
    method_up = (method or "GET").upper()
    parsed = urllib.parse.urlsplit(path or "/")
    clean_path = parsed.path or "/"
    query_string = parsed.query or ""
    normalized_path = normalize_route_path(clean_path)

    sanitized_req_headers = redact_headers(request_headers or {})
    sanitized_resp_headers = redact_headers(response_headers or {})
    sanitized_req_body = redact_body(request_body or "")
    sanitized_resp_body = redact_body(response_body or "")

    req_ok, req_json = _parse_json_OrderIndependent(sanitized_req_body)
    resp_ok, resp_json = _parse_json_OrderIndependent(sanitized_resp_body)
    req_schema = infer_json_schema(req_json) if req_ok else {}
    resp_schema = infer_json_schema(resp_json) if resp_ok else {}

    contract_key = f"{method_up} {normalized_path}"
    contract_row = conn.execute(
        "SELECT * FROM contracts WHERE contract_key = ?",
        (contract_key,),
    ).fetchone()

    drifts: List[Dict[str, Any]] = []
    now = _utc_now()

    if int(response_status) >= 500:
        drifts.append(
            {
                "kind": "server_error_5xx",
                "field": "$status",
                "expected": 200,
                "actual": int(response_status),
                "severity": "critical",
                "message": f"Endpoint `{contract_key}` returned HTTP {response_status}.",
            }
        )

    if contract_row is None and 200 <= int(response_status) < 300:
        # Establish baseline contract from first healthy 2xx response
        conn.execute(
            """
            INSERT INTO contracts (
                contract_key, method, normalized_path, expected_status,
                request_schema_json, response_schema_json, baseline_latency_ms, sample_count, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
            """,
            (
                contract_key,
                method_up,
                normalized_path,
                int(response_status),
                json.dumps(req_schema),
                json.dumps(resp_schema),
                round(float(latency_ms), 2),
                now,
            ),
        )
    elif contract_row is not None:
        baseline_resp_schema = json.loads(contract_row["response_schema_json"] or "{}")
        if 200 <= int(response_status) < 300 and resp_schema:
            drifts.extend(compare_schemas(baseline_resp_schema, resp_schema))
        baseline_latency = float(contract_row["baseline_latency_ms"] or 0.0)
        if baseline_latency > 0 and latency_ms > max(baseline_latency * 4.0, baseline_latency + 200.0):
            drifts.append(
                {
                    "kind": "latency_regression",
                    "field": "$latency_ms",
                    "expected": round(baseline_latency, 2),
                    "actual": round(float(latency_ms), 2),
                    "severity": "medium",
                    "message": (
                        f"Latency regression on `{contract_key}`: "
                        f"{round(float(latency_ms), 2)}ms vs {round(baseline_latency, 2)}ms baseline."
                    ),
                }
            )
        if 200 <= int(response_status) < 300 and not drifts:
            new_count = int(contract_row["sample_count"] or 1) + 1
            avg_lat = ((baseline_latency * (new_count - 1)) + float(latency_ms)) / new_count
            conn.execute(
                "UPDATE contracts SET sample_count = ?, baseline_latency_ms = ?, updated_at = ? WHERE contract_key = ?",
                (new_count, round(avg_lat, 2), now, contract_key),
            )

    conn.execute(
        """
        INSERT INTO traces (
            trace_id, method, path, normalized_path, query_string, target_url,
            request_headers_json, request_body, response_status, response_headers_json,
            response_body, latency_ms, response_schema_json, drift_json,
            chaos_rule_id, replayed_from, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            trace_id,
            method_up,
            clean_path,
            normalized_path,
            query_string,
            target_url,
            json.dumps(sanitized_req_headers),
            sanitized_req_body,
            int(response_status),
            json.dumps(sanitized_resp_headers),
            sanitized_resp_body,
            round(float(latency_ms), 2),
            json.dumps(resp_schema),
            json.dumps(drifts),
            chaos_rule_id,
            replayed_from,
            now,
        ),
    )
    conn.commit()

    trace_dict = get_trace(trace_id, data_dir=data_dir)
    broadcast_plugin_event(
        PLUGIN_NAME,
        "trace.captured",
        {
            "trace_id": trace_id,
            "method": method_up,
            "path": clean_path,
            "status": int(response_status),
            "latency_ms": round(float(latency_ms), 2),
            "drift_count": len(drifts),
            "chaos_rule_id": chaos_rule_id,
        },
    )
    if drifts:
        broadcast_plugin_event(
            PLUGIN_NAME,
            "contract.drift",
            {
                "trace_id": trace_id,
                "contract_key": contract_key,
                "drifts": drifts,
            },
        )
    return trace_dict


def _row_to_trace(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "trace_id": row["trace_id"],
        "method": row["method"],
        "path": row["path"],
        "normalized_path": row["normalized_path"],
        "query_string": row["query_string"],
        "target_url": row["target_url"],
        "request_headers": json.loads(row["request_headers_json"] or "{}"),
        "request_body": row["request_body"],
        "response_status": int(row["response_status"]),
        "response_headers": json.loads(row["response_headers_json"] or "{}"),
        "response_body": row["response_body"],
        "latency_ms": float(row["latency_ms"] or 0.0),
        "response_schema": json.loads(row["response_schema_json"] or "{}"),
        "drifts": json.loads(row["drift_json"] or "[]"),
        "chaos_rule_id": row["chaos_rule_id"] or "",
        "replayed_from": row["replayed_from"] or "",
        "created_at": row["created_at"],
        "directive": f'::faultline-trace{{id="{row["trace_id"]}"}}',
    }


def get_trace(trace_id: str, data_dir: Optional[Path] = None) -> Dict[str, Any]:
    conn = get_db(data_dir)
    row = conn.execute("SELECT * FROM traces WHERE trace_id = ?", (trace_id,)).fetchone()
    if not row:
        return {"ok": False, "error": f"Trace '{trace_id}' not found."}
    result = _row_to_trace(row)
    result["ok"] = True
    return result


def query_traces(
    limit: int = 25,
    method: Optional[str] = None,
    status_filter: Optional[str] = None,
    path_contains: Optional[str] = None,
    only_drifts: bool = False,
    data_dir: Optional[Path] = None,
) -> Dict[str, Any]:
    conn = get_db(data_dir)
    clauses: List[str] = []
    params: List[Any] = []

    if method:
        clauses.append("method = ?")
        params.append(method.upper())

    if status_filter and status_filter != "all":
        sf = status_filter.strip().lower()
        if sf == "5xx":
            clauses.append("response_status >= 500")
        elif sf == "4xx":
            clauses.append("response_status >= 400 AND response_status < 500")
        elif sf == "2xx":
            clauses.append("response_status >= 200 AND response_status < 300")
        elif sf == "errors":
            clauses.append("response_status >= 400")
        elif sf.isdigit():
            clauses.append("response_status = ?")
            params.append(int(sf))

    if path_contains:
        clauses.append("path LIKE ?")
        params.append(f"%{path_contains}%")

    if only_drifts:
        clauses.append("drift_json != '[]'")

    where_sql = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    sql = f"SELECT * FROM traces {where_sql} ORDER BY created_at DESC LIMIT ?"
    params.append(max(1, min(int(limit or 25), 200)))

    rows = conn.execute(sql, tuple(params)).fetchall()
    traces = [_row_to_trace(r) for r in rows]

    totals = conn.execute(
        """
        SELECT
            COUNT(*) AS total_count,
            SUM(CASE WHEN response_status >= 500 THEN 1 ELSE 0 END) AS count_5xx,
            SUM(CASE WHEN response_status >= 400 AND response_status < 500 THEN 1 ELSE 0 END) AS count_4xx,
            SUM(CASE WHEN drift_json != '[]' THEN 1 ELSE 0 END) AS drift_count,
            AVG(latency_ms) AS avg_latency_ms
        FROM traces
        """
    ).fetchone()

    return {
        "ok": True,
        "count": len(traces),
        "summary": {
            "total_traces": int(totals["total_count"] or 0),
            "count_5xx": int(totals["count_5xx"] or 0),
            "count_4xx": int(totals["count_4xx"] or 0),
            "drift_traces": int(totals["drift_count"] or 0),
            "avg_latency_ms": round(float(totals["avg_latency_ms"] or 0.0), 2),
        },
        "traces": traces,
    }


def add_chaos_rule(
    path_pattern: str = "/api/",
    method: str = "ANY",
    fault_type: str = "status_code",
    status_code: int = 503,
    latency_ms: int = 0,
    probability: float = 1.0,
    response_body: str = "",
    data_dir: Optional[Path] = None,
) -> Dict[str, Any]:
    conn = get_db(data_dir)
    rule_id = f"chaos-{uuid.uuid4().hex[:6]}"
    method_up = (method or "ANY").upper()
    prob = max(0.0, min(1.0, float(probability)))
    default_body = response_body or json.dumps(
        {
            "error": "faultline_chaos_injected",
            "rule_id": rule_id,
            "fault_type": fault_type,
            "status_code": int(status_code),
        }
    )
    conn.execute(
        """
        INSERT INTO chaos_rules (
            rule_id, method, path_pattern, fault_type, status_code,
            latency_ms, probability, response_body, hits, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        """,
        (
            rule_id,
            method_up,
            path_pattern,
            fault_type,
            int(status_code),
            int(latency_ms),
            prob,
            default_body,
            _utc_now(),
        ),
    )
    conn.commit()
    broadcast_plugin_event(
        PLUGIN_NAME,
        "chaos.rule_added",
        {"rule_id": rule_id, "method": method_up, "path_pattern": path_pattern, "fault_type": fault_type},
    )
    return {
        "ok": True,
        "rule": {
            "rule_id": rule_id,
            "method": method_up,
            "path_pattern": path_pattern,
            "fault_type": fault_type,
            "status_code": int(status_code),
            "latency_ms": int(latency_ms),
            "probability": prob,
            "response_body": default_body,
            "hits": 0,
        },
    }


def list_chaos_rules(data_dir: Optional[Path] = None) -> Dict[str, Any]:
    conn = get_db(data_dir)
    rows = conn.execute("SELECT * FROM chaos_rules ORDER BY created_at DESC").fetchall()
    rules = [
        {
            "rule_id": r["rule_id"],
            "method": r["method"],
            "path_pattern": r["path_pattern"],
            "fault_type": r["fault_type"],
            "status_code": int(r["status_code"]),
            "latency_ms": int(r["latency_ms"]),
            "probability": float(r["probability"]),
            "response_body": r["response_body"],
            "hits": int(r["hits"]),
            "created_at": r["created_at"],
        }
        for r in rows
    ]
    return {"ok": True, "count": len(rules), "rules": rules}


def remove_chaos_rule(rule_id: str, data_dir: Optional[Path] = None) -> Dict[str, Any]:
    conn = get_db(data_dir)
    cur = conn.execute("DELETE FROM chaos_rules WHERE rule_id = ?", (rule_id,))
    conn.commit()
    return {"ok": True, "removed": cur.rowcount > 0, "rule_id": rule_id}


def clear_chaos_rules(data_dir: Optional[Path] = None) -> Dict[str, Any]:
    conn = get_db(data_dir)
    cur = conn.execute("DELETE FROM chaos_rules")
    conn.commit()
    return {"ok": True, "cleared_count": cur.rowcount}


def match_chaos_rule(method: str, path: str, data_dir: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    conn = get_db(data_dir)
    rows = conn.execute("SELECT * FROM chaos_rules ORDER BY created_at DESC").fetchall()
    method_up = (method or "GET").upper()
    for row in rows:
        rule_method = row["method"]
        if rule_method not in ("ANY", "*", method_up):
            continue
        pattern = row["path_pattern"] or ""
        matched = False
        if pattern in ("*", "/"):
            matched = True
        elif pattern in path:
            matched = True
        else:
            try:
                if re.search(pattern, path):
                    matched = True
            except re.error:
                matched = False
        if not matched:
            continue
        prob = float(row["probability"] or 1.0)
        if prob < 1.0 and random.random() > prob:
            continue
        conn.execute("UPDATE chaos_rules SET hits = hits + 1 WHERE rule_id = ?", (row["rule_id"],))
        conn.commit()
        return {
            "rule_id": row["rule_id"],
            "fault_type": row["fault_type"],
            "status_code": int(row["status_code"]),
            "latency_ms": int(row["latency_ms"]),
            "response_body": row["response_body"],
        }
    return None


def generate_openapi_spec(data_dir: Optional[Path] = None) -> Dict[str, Any]:
    """Synthesize an OpenAPI 3.1 contract specification from observed traffic."""
    conn = get_db(data_dir)
    rows = conn.execute("SELECT * FROM contracts ORDER BY normalized_path ASC, method ASC").fetchall()
    paths: Dict[str, Dict[str, Any]] = {}
    contracts_list: List[Dict[str, Any]] = []

    for r in rows:
        norm_path = r["normalized_path"]
        method_low = str(r["method"]).lower()
        req_schema = json.loads(r["request_schema_json"] or "{}")
        resp_schema = json.loads(r["response_schema_json"] or "{}")
        expected_status = str(r["expected_status"])

        paths.setdefault(norm_path, {})
        op_obj: Dict[str, Any] = {
            "summary": f"Observed {r['method']} {norm_path} ({r['sample_count']} baseline samples)",
            "x-faultline-baseline-latency-ms": float(r["baseline_latency_ms"] or 0.0),
            "responses": {
                expected_status: {
                    "description": "Baseline observed response schema",
                    "content": {
                        "application/json": {
                            "schema": resp_schema or {"type": "object"},
                        }
                    },
                }
            },
        }
        if req_schema:
            op_obj["requestBody"] = {
                "required": True,
                "content": {
                    "application/json": {
                        "schema": req_schema,
                    }
                },
            }
        paths[norm_path][method_low] = op_obj
        contracts_list.append(
            {
                "contract_key": r["contract_key"],
                "method": r["method"],
                "normalized_path": norm_path,
                "expected_status": int(r["expected_status"]),
                "request_schema": req_schema,
                "response_schema": resp_schema,
                "baseline_latency_ms": float(r["baseline_latency_ms"] or 0.0),
                "sample_count": int(r["sample_count"] or 1),
                "updated_at": r["updated_at"],
            }
        )

    drift_rows = conn.execute(
        "SELECT trace_id, method, path, response_status, drift_json, created_at FROM traces WHERE drift_json != '[]' ORDER BY created_at DESC LIMIT 50"
    ).fetchall()
    recent_drifts = [
        {
            "trace_id": dr["trace_id"],
            "method": dr["method"],
            "path": dr["path"],
            "status": int(dr["response_status"]),
            "drifts": json.loads(dr["drift_json"] or "[]"),
            "created_at": dr["created_at"],
        }
        for dr in drift_rows
    ]

    return {
        "ok": True,
        "contract_count": len(contracts_list),
        "drift_trace_count": len(recent_drifts),
        "contracts": contracts_list,
        "recent_drifts": recent_drifts,
        "openapi": {
            "openapi": "3.1.0",
            "info": {
                "title": "Faultline Learned Service Contract",
                "version": "1.0.0",
                "description": "Automatically synthesized by Hermes Faultline Flight Recorder.",
            },
            "paths": paths,
        },
    }


def replay_trace(
    trace_id: str,
    target_url: Optional[str] = None,
    override_headers: Optional[Dict[str, str]] = None,
    override_body: Optional[str] = None,
    data_dir: Optional[Path] = None,
) -> Dict[str, Any]:
    """Deterministically re-fire a captured HTTP request against an upstream endpoint and diff the response."""
    conn = get_db(data_dir)
    orig = get_trace(trace_id, data_dir=data_dir)
    if not orig.get("ok"):
        return orig

    base_target = (target_url or orig["target_url"]).rstrip("/")
    query_part = f"?{orig['query_string']}" if orig.get("query_string") else ""
    full_url = f"{base_target}{orig['path']}{query_part}"

    headers_to_send: Dict[str, str] = {}
    for k, v in (orig.get("request_headers") or {}).items():
        if k.lower() not in ("host", "content-length") and v != "[REDACTED]":
            headers_to_send[k] = str(v)
    if override_headers:
        for k, v in override_headers.items():
            headers_to_send[str(k)] = str(v)

    body_str = override_body if override_body is not None else (orig.get("request_body") or "")
    body_bytes = body_str.encode("utf-8") if body_str else None

    req = urllib.request.Request(
        full_url,
        data=body_bytes,
        headers=headers_to_send,
        method=orig["method"],
    )

    started = time.perf_counter()
    resp_status = 502
    resp_headers: Dict[str, str] = {}
    resp_body = ""

    try:
        with urllib.request.urlopen(req, timeout=10.0) as resp:
            resp_status = int(resp.status)
            resp_headers = dict(resp.headers.items())
            resp_body = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        try:
            resp_status = int(exc.code)
            resp_headers = dict(exc.headers.items()) if exc.headers else {}
            try:
                resp_body = exc.read().decode("utf-8", errors="replace")
            except Exception:
                resp_body = str(exc)
        finally:
            exc.close()
    except Exception as exc:
        resp_status = 502
        resp_body = json.dumps({"error": "upstream_unreachable", "detail": str(exc)})

    latency_ms = round((time.perf_counter() - started) * 1000.0, 2)

    replay_record = record_trace(
        method=orig["method"],
        path=orig["path"] + (f"?{orig['query_string']}" if orig.get("query_string") else ""),
        target_url=base_target,
        request_headers=headers_to_send,
        request_body=body_str,
        response_status=resp_status,
        response_headers=resp_headers,
        response_body=resp_body,
        latency_ms=latency_ms,
        replayed_from=trace_id,
        data_dir=data_dir,
    )

    old_status = int(orig["response_status"])
    new_status = int(replay_record["response_status"])
    resolved_error = old_status >= 400 and 200 <= new_status < 300

    _, old_json = _parse_json_OrderIndependent(orig.get("response_body") or "")
    _, new_json = _parse_json_OrderIndependent(replay_record.get("response_body") or "")
    old_keys = sorted(old_json.keys()) if isinstance(old_json, dict) else []
    new_keys = sorted(new_json.keys()) if isinstance(new_json, dict) else []

    diff_summary = {
        "status_transition": f"{old_status} -> {new_status}",
        "resolved_error": resolved_error,
        "latency_delta_ms": round(float(replay_record["latency_ms"]) - float(orig["latency_ms"]), 2),
        "old_json_keys": old_keys,
        "new_json_keys": new_keys,
        "drifts_remaining": len(replay_record.get("drifts") or []),
    }

    replay_id = f"rpl-{uuid.uuid4().hex[:8]}"
    conn.execute(
        """
        INSERT INTO replays (
            replay_id, original_trace_id, replay_trace_id, target_url,
            old_status, new_status, old_latency_ms, new_latency_ms,
            resolved_error, diff_summary_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            replay_id,
            trace_id,
            replay_record["trace_id"],
            base_target,
            old_status,
            new_status,
            float(orig["latency_ms"]),
            float(replay_record["latency_ms"]),
            1 if resolved_error else 0,
            json.dumps(diff_summary),
            _utc_now(),
        ),
    )
    conn.commit()

    payload = {
        "ok": True,
        "replay_id": replay_id,
        "original_trace_id": trace_id,
        "replay_trace_id": replay_record["trace_id"],
        "method": orig["method"],
        "path": orig["path"],
        "old_status": old_status,
        "new_status": new_status,
        "status_transition": diff_summary["status_transition"],
        "resolved_error": resolved_error,
        "old_latency_ms": float(orig["latency_ms"]),
        "new_latency_ms": float(replay_record["latency_ms"]),
        "diff": diff_summary,
        "original_response_body": orig["response_body"],
        "replay_response_body": replay_record["response_body"],
        "directive": f'::faultline-trace{{id="{replay_record["trace_id"]}"}}',
    }
    broadcast_plugin_event(PLUGIN_NAME, "replay.completed", payload)
    return payload


class _ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class ManagedProxyInstance:
    """Thread-safe loopback reverse proxy that intercepts HTTP traffic for Faultline."""

    def __init__(self, listen_port: int, target_url: str, data_dir: Optional[Path] = None) -> None:
        self.listen_port = int(listen_port)
        self.target_url = target_url.rstrip("/")
        self.data_dir = data_dir
        self.started_at = _utc_now()
        self.server: Optional[_ThreadingHTTPServer] = None
        self.thread: Optional[threading.Thread] = None

    def start(self) -> int:
        parent = self

        class ProxyHandler(http.server.BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
                return

            def _handle_any(self) -> None:
                started = time.perf_counter()
                content_len = int(self.headers.get("Content-Length", "0") or "0")
                req_body_bytes = self.rfile.read(content_len) if content_len > 0 else b""
                req_body_str = req_body_bytes.decode("utf-8", errors="replace")
                req_headers = {k: v for k, v in self.headers.items()}

                chaos = match_chaos_rule(self.command, self.path, data_dir=parent.data_dir)
                if chaos:
                    delay_ms = int(chaos.get("latency_ms") or 0)
                    if delay_ms > 0:
                        time.sleep(min(delay_ms, 3000) / 1000.0)
                    fault_type = chaos.get("fault_type", "status_code")
                    if fault_type in ("status_code", "latency_and_status", "corrupt_json"):
                        status_code = int(chaos.get("status_code") or 503)
                        if fault_type == "corrupt_json":
                            resp_body = '{"corrupted": true, "unexpected_eof": '
                        else:
                            resp_body = chaos.get("response_body") or json.dumps(
                                {"error": "chaos_fault_injected", "rule_id": chaos["rule_id"]}
                            )
                        latency_ms = round((time.perf_counter() - started) * 1000.0, 2)
                        resp_headers = {"Content-Type": "application/json", "X-Faultline-Chaos": chaos["rule_id"]}
                        record_trace(
                            method=self.command,
                            path=self.path,
                            target_url=parent.target_url,
                            request_headers=req_headers,
                            request_body=req_body_str,
                            response_status=status_code,
                            response_headers=resp_headers,
                            response_body=resp_body,
                            latency_ms=latency_ms,
                            chaos_rule_id=chaos["rule_id"],
                            data_dir=parent.data_dir,
                        )
                        body_out = resp_body.encode("utf-8")
                        self.send_response(status_code)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("X-Faultline-Chaos", chaos["rule_id"])
                        self.send_header("Content-Length", str(len(body_out)))
                        self.end_headers()
                        self.wfile.write(body_out)
                        return

                upstream_url = f"{parent.target_url}{self.path}"
                forward_headers = {
                    k: v for k, v in req_headers.items() if k.lower() not in ("host", "content-length")
                }
                req = urllib.request.Request(
                    upstream_url,
                    data=req_body_bytes if req_body_bytes else None,
                    headers=forward_headers,
                    method=self.command,
                )
                resp_status = 502
                resp_headers_dict: Dict[str, str] = {}
                resp_body_bytes = b""

                try:
                    with urllib.request.urlopen(req, timeout=10.0) as resp:
                        resp_status = int(resp.status)
                        resp_headers_dict = dict(resp.headers.items())
                        resp_body_bytes = resp.read()
                except urllib.error.HTTPError as exc:
                    try:
                        resp_status = int(exc.code)
                        resp_headers_dict = dict(exc.headers.items()) if exc.headers else {}
                        resp_body_bytes = exc.read() if exc.fp else b""
                    finally:
                        exc.close()
                except Exception as exc:
                    resp_status = 502
                    resp_body_bytes = json.dumps({"error": "bad_gateway", "detail": str(exc)}).encode("utf-8")
                    resp_headers_dict = {"Content-Type": "application/json"}

                latency_ms = round((time.perf_counter() - started) * 1000.0, 2)
                resp_body_str = resp_body_bytes.decode("utf-8", errors="replace")

                trace = record_trace(
                    method=self.command,
                    path=self.path,
                    target_url=parent.target_url,
                    request_headers=req_headers,
                    request_body=req_body_str,
                    response_status=resp_status,
                    response_headers=resp_headers_dict,
                    response_body=resp_body_str,
                    latency_ms=latency_ms,
                    chaos_rule_id=chaos["rule_id"] if chaos else "",
                    data_dir=parent.data_dir,
                )

                self.send_response(resp_status)
                self.send_header("Content-Type", resp_headers_dict.get("Content-Type", "application/json"))
                self.send_header("X-Faultline-Trace-Id", trace["trace_id"])
                self.send_header("Content-Length", str(len(resp_body_bytes)))
                self.end_headers()
                self.wfile.write(resp_body_bytes)

            def do_GET(self) -> None:
                self._handle_any()

            def do_POST(self) -> None:
                self._handle_any()

            def do_PUT(self) -> None:
                self._handle_any()

            def do_PATCH(self) -> None:
                self._handle_any()

            def do_DELETE(self) -> None:
                self._handle_any()

        self.server = _ThreadingHTTPServer((LOOPBACK_HOST, self.listen_port), ProxyHandler)
        self.listen_port = int(self.server.server_address[1])
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self.listen_port

    def stop(self) -> None:
        if self.server:
            try:
                self.server.shutdown()
                self.server.server_close()
            except Exception:
                pass
            self.server = None


def start_proxy(
    listen_port: int = 0,
    target_url: str = "http://127.0.0.1:8000",
    data_dir: Optional[Path] = None,
) -> Dict[str, Any]:
    with _PROXY_LOCK:
        if listen_port in _ACTIVE_PROXIES and listen_port != 0:
            inst = _ACTIVE_PROXIES[listen_port]
            return {
                "ok": True,
                "status": "already_running",
                "listen_host": LOOPBACK_HOST,
                "listen_port": inst.listen_port,
                "proxy_url": f"http://{LOOPBACK_HOST}:{inst.listen_port}",
                "target_url": inst.target_url,
                "started_at": inst.started_at,
            }
        inst = ManagedProxyInstance(listen_port=listen_port, target_url=target_url, data_dir=data_dir)
        actual_port = inst.start()
        _ACTIVE_PROXIES[actual_port] = inst
        return {
            "ok": True,
            "status": "running",
            "listen_host": LOOPBACK_HOST,
            "listen_port": actual_port,
            "proxy_url": f"http://{LOOPBACK_HOST}:{actual_port}",
            "target_url": inst.target_url,
            "started_at": inst.started_at,
        }


def stop_proxy(listen_port: Optional[int] = None) -> Dict[str, Any]:
    stopped: List[int] = []
    with _PROXY_LOCK:
        if listen_port is not None:
            inst = _ACTIVE_PROXIES.pop(int(listen_port), None)
            if inst:
                inst.stop()
                stopped.append(int(listen_port))
        else:
            for port, inst in list(_ACTIVE_PROXIES.items()):
                inst.stop()
                stopped.append(port)
                _ACTIVE_PROXIES.pop(port, None)
    return {"ok": True, "stopped_ports": stopped}


def get_proxy_status(data_dir: Optional[Path] = None) -> Dict[str, Any]:
    with _PROXY_LOCK:
        proxies = [
            {
                "listen_host": LOOPBACK_HOST,
                "listen_port": port,
                "proxy_url": f"http://{LOOPBACK_HOST}:{port}",
                "target_url": inst.target_url,
                "started_at": inst.started_at,
            }
            for port, inst in sorted(_ACTIVE_PROXIES.items())
        ]
    traces_info = query_traces(limit=10, data_dir=data_dir)
    contracts_info = generate_openapi_spec(data_dir=data_dir)
    chaos_info = list_chaos_rules(data_dir=data_dir)
    return {
        "ok": True,
        "active_proxies": proxies,
        "summary": traces_info["summary"],
        "contract_count": contracts_info["contract_count"],
        "chaos_rule_count": chaos_info["count"],
        "recent_traces": traces_info["traces"],
    }


def run_live_simulation(
    scenario: str = "checkout_pipeline",
    data_dir: Optional[Path] = None,
) -> Dict[str, Any]:
    """Spin up an ephemeral local microservice + Faultline proxy, capture real 200/500/drift/chaos traces, hotfix the bug, and deterministically replay the 500 trace to verify `500 -> 200 OK`."""
    state = {"patched": False}

    class DemoUpstreamHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            return

        def _send_json(self, status: int, payload: Dict[str, Any]) -> None:
            raw = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:
            if self.path == "/api/v1/orders/101":
                self._send_json(
                    200,
                    {
                        "order_id": "ord_101",
                        "customer_tier": "enterprise",
                        "total_cents": 12500,
                        "currency": "USD",
                        "status": "confirmed",
                    },
                )
            elif self.path == "/api/v1/orders/102":
                # Intentionally returns string for `total_cents` and omits `currency` to demonstrate OpenAPI contract drift detection
                self._send_json(
                    200,
                    {
                        "order_id": "ord_102",
                        "customer_tier": "pro",
                        "total_cents": "twelve-thousand-five-hundred",
                        "status": "pending_review",
                    },
                )
            else:
                self._send_json(404, {"error": "not_found"})

        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0") or "0")
            body_raw = self.rfile.read(length).decode("utf-8", errors="replace") if length > 0 else "{}"
            try:
                data = json.loads(body_raw)
            except Exception:
                data = {}

            if self.path == "/api/v1/checkout":
                subtotal = int(data.get("subtotal_cents", 5000))
                discount = int(data.get("discount_cents", 0))
                net_payable = subtotal - discount

                if net_payable == 0 and not state["patched"]:
                    # Realistic bug: division by net_payable when computing effective fee ratio on 100% promo codes
                    self._send_json(
                        500,
                        {
                            "error": "ZeroDivisionError",
                            "detail": "float division by zero in calculate_fee_ratio(subtotal_cents, net_payable=0)",
                            "endpoint": "/api/v1/checkout",
                        },
                    )
                    return

                fee_ratio = 0.0 if net_payable <= 0 else round(150 / net_payable, 4)
                self._send_json(
                    200,
                    {
                        "checkout_id": "chk_9001",
                        "net_payable_cents": max(0, net_payable),
                        "fee_ratio": fee_ratio,
                        "status": "settled",
                    },
                )
            elif self.path == "/api/v1/webhooks/stripe":
                self._send_json(200, {"received": True, "event_id": data.get("event_id", "evt_1")})
            else:
                self._send_json(404, {"error": "not_found"})

    upstream_server = _ThreadingHTTPServer((LOOPBACK_HOST, 0), DemoUpstreamHandler)
    upstream_port = int(upstream_server.server_address[1])
    upstream_thread = threading.Thread(target=upstream_server.serve_forever, daemon=True)
    upstream_thread.start()

    proxy_info = start_proxy(
        listen_port=0,
        target_url=f"http://{LOOPBACK_HOST}:{upstream_port}",
        data_dir=data_dir,
    )
    proxy_url = proxy_info["proxy_url"]
    proxy_port = int(proxy_info["listen_port"])

    def _call_proxy(method: str, path: str, payload: Optional[Dict[str, Any]] = None, headers: Optional[Dict[str, str]] = None) -> Tuple[int, str, str]:
        req_headers = {"Content-Type": "application/json", "Authorization": "Bearer sk_live_super_secret_token_991"}
        if headers:
            req_headers.update(headers)
        raw = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(f"{proxy_url}{path}", data=raw, headers=req_headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                return int(resp.status), resp.read().decode("utf-8"), resp.headers.get("X-Faultline-Trace-Id", "")
        except urllib.error.HTTPError as exc:
            try:
                body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
                trace_hdr = exc.headers.get("X-Faultline-Trace-Id", "") if exc.headers else ""
                return int(exc.code), body, trace_hdr
            finally:
                exc.close()

    try:
        # 1. Baseline healthy calls (learns OpenAPI contracts for GET /api/v1/orders/{id} and POST /api/v1/checkout)
        _call_proxy("GET", "/api/v1/orders/101")
        _call_proxy("POST", "/api/v1/checkout", {"subtotal_cents": 5000, "discount_cents": 500, "coupon": "WELCOME10"})

        # 2. Trigger HTTP 500 ZeroDivisionError on 100% promo coupon
        _, _, failed_checkout_trace_id = _call_proxy(
            "POST",
            "/api/v1/checkout",
            {"subtotal_cents": 5000, "discount_cents": 5000, "coupon": "FOUNDERS100"},
        )

        # 3. Trigger OpenAPI schema drift on /api/v1/orders/102 (`total_cents` string instead of integer + missing `currency`)
        _, _, drift_trace_id = _call_proxy("GET", "/api/v1/orders/102")

        # 4. Inject Chaos Rule on /api/v1/webhooks/stripe (429 Too Many Requests) and fire webhook
        chaos_res = add_chaos_rule(
            path_pattern="/api/v1/webhooks/stripe",
            method="POST",
            fault_type="status_code",
            status_code=429,
            probability=1.0,
            data_dir=data_dir,
        )
        _call_proxy("POST", "/api/v1/webhooks/stripe", {"event_id": "evt_rate_limited"})
        remove_chaos_rule(chaos_res["rule"]["rule_id"], data_dir=data_dir)

        # 5. Apply hotfix in upstream service and deterministically replay the failed 500 trace
        state["patched"] = True
        replay_res = replay_trace(
            trace_id=failed_checkout_trace_id,
            target_url=f"http://{LOOPBACK_HOST}:{upstream_port}",
            data_dir=data_dir,
        )
    finally:
        stop_proxy(proxy_port)
        upstream_server.shutdown()
        upstream_server.server_close()

    contract_report = generate_openapi_spec(data_dir=data_dir)
    traces_report = query_traces(limit=10, data_dir=data_dir)

    return {
        "ok": True,
        "scenario": scenario,
        "failed_trace_id": failed_checkout_trace_id,
        "drift_trace_id": drift_trace_id,
        "replay_verification": replay_res,
        "contract_summary": {
            "learned_endpoints": contract_report["contract_count"],
            "drift_traces_detected": contract_report["drift_trace_count"],
        },
        "trace_summary": traces_report["summary"],
        "directive": f'::faultline-trace{{id="{replay_res.get("replay_trace_id", failed_checkout_trace_id)}"}}',
    }
