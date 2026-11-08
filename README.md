# Faultline (`faultline`)

**Local API Flight Recorder, OpenAPI 3.1 Contract Drift Verifier & Deterministic Chaos Replay Studio for Hermes Agent.**

Faultline gives Hermes real-time ground-truth visibility into local HTTP microservices, webhooks, and full-stack APIs without manual `curl` copy-pasting. It runs a zero-config loopback reverse proxy (`127.0.0.1`), automatically redacts sensitive headers (`Authorization`, `Cookie`, `X-Api-Key`) and JSON secret tokens before persisting traces to WAL-mode SQLite, synthesizes OpenAPI 3.1 contracts from healthy `2xx` traffic, flags schema drifts (`type_mismatch`, `missing_required_field`, `server_error_5xx`, `latency_regression`), injects controlled chaos faults (`429`, `503`, latency spikes, corrupt JSON), and deterministically replays captured failing traces (`500 -> 200 OK`) after Hermes patches the code.

---

## Features & Hermes Surfaces Used

| Surface | Capability |
| :--- | :--- |
| **Tools (`provides_tools`)** | `faultline_proxy`, `faultline_traces`, `faultline_replay`, `faultline_contract`, `faultline_chaos`, `faultline_simulate` |
| **Middleware (`provides_middleware`)** | `tool_execution` — measures tool call latency and enriches Faultline telemetry |
| **Hooks (`provides_hooks`)** | `post_tool_call`, `on_session_start` — broadcasts real-time SSE events (`plugin.faultline.*`) |
| **Slash Command** | `/faultline [status\|simulate\|replay <trace_id>]` |
| **CLI Subcommand** | `hermes faultline [status\|simulate\|replay <trace_id>\|contracts]` |
| **Bundled Skill** | `skills/faultline-studio/SKILL.md` |
| **Dashboard Router** | `dashboard/plugin_api.py` (`/api/plugins/faultline/status`, `/traces`, `/replay`, `/contracts`, `/chaos`, `/simulate`) |
| **Hermes Desktop UI (`desktop/plugin.js`)** | Full `/faultline` studio view (`ROUTES_AREA` + `SIDEBAR_NAV_AREA`), right docked waterfall (`panes`), status-bar indicator (`STATUSBAR_AREAS.right`), command palette action (`PALETTE_AREA`), and inline `::faultline-trace{id="..."}` card (`TRANSCRIPT_DIRECTIVE_AREA`) |

---

## Installation

```bash
hermes plugins install https://github.com/bigmantech001/Faultline
```

Or copy/symlink into `~/.hermes/plugins/faultline`.

---

## Quick Start & Self-Contained Demo

### 1. Run the Self-Contained Showcase
```bash
python3 demo_faultline.py
```
This spins up an ephemeral loopback checkout microservice + the Faultline reverse proxy on `127.0.0.1`, captures baseline `200 OK` calls to learn the OpenAPI 3.1 contract, captures a `500 ZeroDivisionError` on a 100% discount coupon (`POST /api/v1/checkout`), detects a schema drift (`total_cents` returned as string instead of integer on `GET /api/v1/orders/102`), triggers a `429` chaos rule on `POST /api/v1/webhooks/stripe`, applies the backend hotfix, and deterministically replays the failed `500` trace to verify `500 -> 200 OK`.

### 2. Slash Commands in Hermes Chat
```text
/faultline status
/faultline simulate
/faultline replay flt-a1b2c3d4
```

### 3. CLI Subcommands
```bash
hermes faultline status
hermes faultline simulate
hermes faultline contracts
hermes faultline replay flt-a1b2c3d4
```

---

## Testing & Catalog Validation

```bash
python3 -m unittest discover -s tests -v
```

---

## Catalog Submission (`plugin-catalog/faultline.yaml`)

```yaml
name: faultline
description: Local API flight recorder, OpenAPI contract drift verifier, and deterministic chaos replay studio for Hermes.
repo: https://github.com/bigmantech001/Faultline
author: bigmantech001
license: MIT
categories:
  - devtools
  - debugging
  - api
  - testing
```
