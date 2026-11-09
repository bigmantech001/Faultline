# Faultline demo film

The demo film for Faultline, a Hermes Agent plugin that records, audits, breaks and replays HTTP traffic. The film is 79.7 seconds long (2391 frames at 30 fps, from `src/timing.json`). It shows one real `hermes chat` session from 2026-11-08: a storefront checkout fails with a 500 on one coupon code, the agent puts Faultline's proxy in front of the service, reads the failing trace, patches the bug, replays the exact captured request and gets a 200, flags schema drift on a route that still answers 200, adds a chaos rule that makes a webhook answer 429, and exports the learned OpenAPI contract. The left half of the frame is the terminal. The right half is the Faultline Studio page in the Hermes Desktop workspace, filmed during the same session. Every number on screen comes from Faultline's own recorder database.

## Deliverables

| File | What it is |
| :--- | :--- |
| `out/faultline-demo-4k.mp4` | 3840x2160, H.264, AAC 320k, audio at -14 LUFS (`npm run render4k && npm run finish`) |
| `out/faultline-demo-1080p.mp4` | 1920x1080 downscale of the 4K master, the file to attach to the X post (`npm run 1080p`) |
| `out/faultline-thumbnail.png` | the poster still (`npm run poster`) |
| `out/faultline-thumbnail.jpg` | the same image as JPEG: `ffmpeg -i out/faultline-thumbnail.png -q:v 2 out/faultline-thumbnail.jpg` |
| `post.txt` | the X post, under 600 characters |
| `youtube.txt` | title, description and chapters for the YouTube upload |

`out/` is ignored by git. The deliverables are built locally and uploaded by hand.

## What is real

Everything the film shows or says is traced here to a file in this folder. Times are UTC on 2026-11-08, from `data/session.json` (`recorded_utc`, the recorder's marks, and the timestamps Faultline's database wrote).

### The session

- One `hermes chat` session, recorded from 18:28:05 to 18:42:29. `hermes chat --in video/demo` ran in a throwaway Hermes home with the Faultline plugin enabled. Terminal size 110x36. The asciicast is 813.0 seconds long.
- Hermes Agent 0.23.0. The banner in the recording reads `Hermes Agent v0.23.0 (2026.9.24)`. The Studio footer reads `client v0.23.0`, `backend v0.23.0`.
- Model `claude-sonnet-4.6`, the name the hermes chat status bar shows. How that Hermes home reached the model (its provider settings) is not in the recording and is not claimed here.
- Three prompts were typed by the recorder, as a person would type them. Nothing else was typed. Quoted from `data/session.json` `prompts`:
  1. 18:28:55 "Our checkout service runs on http://127.0.0.1:8000. Some coupon checkouts fail with a 500 and I cannot see why. Put Faultline in front of it on port 8700 and tell me the proxy URL to point the storefront at."
  2. 18:30:38 "The storefront just hit it. Find the failing request in Faultline, tell me exactly why it fails, and fix the cause in checkout_logic.py. The service hot-reloads. Then replay the failed trace to prove it."
  3. 18:36:49 "Also check the orders route for contract drift, then add a chaos rule that makes POST /api/v1/webhooks/stripe answer 429 so we can test the retry path, and show me the learned OpenAPI contract."
- The agent's tool calls, in the order the chat printed them (`agent_tool_calls` and `tool_rows`, 35 calls):
  - Turn 1 (70 s): `terminal` (curl to the upstream), `faultline_proxy` at 18:29:15, `terminal` (route probes through the proxy), `terminal` (curl `/openapi.json` piped to python), `search_files`, `terminal` (lsof), `terminal` (ls of `video/demo`), `search_files`, `read_file checkout_service.py`, `read_file client.py`, `terminal` (checkout cases through the proxy, which reproduced the 500 as trace `flt-d4fe62ad` at 18:30:00), `faultline_traces` at 18:30:04. The reply gave the proxy URL `http://127.0.0.1:8700` and the cause at `checkout_logic.py:17-19`.
  - Turn 2 (97 s): `faultline_traces` at 18:30:48, `search_files`, `read_file proxy_engine.py`, `patch video/demo/checkout_logic.py` at 18:31:33, `terminal` (five checkout cases through the proxy, all 200), `tool_details`, `faultline_replay` at 18:31:46, `faultline_traces` twice.
  - Turn 3 (163 s): `faultline_traces` at 18:37:04, `faultline_chaos` at 18:37:11, `terminal` (the webhook through the proxy and more), `search_files`, `read_file tools.py`, `read_file proxy_engine.py`, `patch tools.py` at 18:37:45, `faultline_contract` at 18:37:50, `terminal` (ls tests), `terminal` (unittest discover), `read_file test_faultline.py`, `terminal` (the test file), `write_file` (a scratch check script), `terminal` (ran it).
  - In turn 3 the agent also edited the plugin's own `tools.py` (an `export_openapi` path, a `drifted` filter and two argument aliases). That edit is not part of the film.
- Three approval boxes. Each was Hermes Agent's "Dangerous Command" box, flagged as "script execution via -e/-c flag", with the choices Allow once, Allow for this session, Add to permanent allowlist, Deny, Show full command. The recorder pressed Enter on "Allow once" each time (`approvals_answered_by_recorder`), and the chat printed "allowed once":
  1. 18:29:25: `curl -sS --max-time 5 http://127.0.0.1:8700/openapi.json | python3 -c "..."` (listing the paths of an OpenAPI document, if the service had one; it answered 404).
  2. 18:37:57: `cd /Users/bigmantech001/Faultline && python3 -c "import json, tools ..."` (calling `tools.handle_faultline_contract({'export_openapi': ...})` directly).
  3. 18:39:08: `cd /Users/bigmantech001/Faultline && python3 -c "import importlib.util, sys, json ..."` (loading the patched handler the way Hermes loads it).
- Turn footers as printed: "read 1 skill, 3 files · ran 7 commands · searched 3 paths · called 5 tools" (18:30:11), "edited 1 file +10 -4 · read 2 files · ran 2 commands · searched 1 path · +1 more" (18:32:20), "edited 2 files +11 -0 · read 5 files · ran 6 commands · searched 1 path · +1 more" (18:39:37).

### The service and the storefront

- `demo/checkout_service.py`: a small real HTTP service on `127.0.0.1:8000`, standard library only. It reloads `checkout_logic.py` whenever that file changes, so a patch takes effect without a restart. An exception becomes a 500 with a JSON body naming the function and line.
- `demo/checkout_logic.py`: the business logic. `calculate_fee_ratio` divides `PLATFORM_FEE_CENTS` (150) by the net payable amount. `FOUNDERS100` is a 100% coupon, so the net payable is 0 and the division fails. Order 102 is a legacy row with `total_cents` stored as text and no `currency`.
- `demo/client.py`: the storefront. It sends real requests to the proxy in four steps (baseline, coupon, orders, webhook) with a fake `Authorization: Bearer` token, so the film can show the header redacted. It prints the `X-Faultline-Trace-Id` each response carries.
- The committed `checkout_logic.py` is the buggy version. The agent's patch lives only in the recording and in `data/session.json` (`checkout_logic_patch`).

### The failing trace

- `flt-92e75bfe`: `POST /api/v1/checkout` at 18:30:20.228, sent by the storefront (`User-Agent: Python-urllib/3.14`). Request body `{"subtotal_cents": 5000, "coupon": "FOUNDERS100"}`. Response 500 in 1.16 ms. Response body: `{"error": "ZeroDivisionError", "detail": "division by zero in calculate_fee_ratio() at checkout_logic.py:19", "endpoint": "/api/v1/checkout"}`.
- The stored request headers show `Authorization: [REDACTED]`. Faultline redacted it before writing.
- Its one finding: `server_error_5xx`, severity critical, "Endpoint `POST /api/v1/checkout` returned HTTP 500."
- The agent had already reproduced the same 500 with curl at 18:30:00 (`flt-d4fe62ad`, subtotal 12500, 1.31 ms, same error body).

### The patch

At 18:31:33 the agent patched `checkout_logic.py`. `calculate_fee_ratio` now takes only `net_payable_cents` and returns `0.0` when it is zero or less. `checkout()` clamps the net payable at 0 and drops the dead first argument. The turn footer counts it as "+10 -4". The full unified diff is `checkout_logic_patch` in `data/session.json`. The film shows the terminal at the moment the patch is applied.

### The replay

- `rpl-e7b938ad` at 18:31:46.377, from the agent's `faultline_replay` call. Original `flt-92e75bfe`, replayed as `flt-33cbbabc`. Status 500 to 200. Latency 1.16 ms to 1.8 ms (delta 0.64 ms). `resolved_error: true`. The old body had the keys `error`, `detail`, `endpoint`; the new body has `checkout_id`, `coupon`, `discount_cents`, `fee_ratio`, `net_payable_cents`, `status`, `subtotal_cents`. `drifts_remaining: 1`: the replayed response has `coupon` as a string where the learned baseline (a checkout without a coupon) had `null`. The agent reported that drift as pre-existing rather than hiding it.
- A second replay, `rpl-351526f1` at 18:36:43, came from the Replay button in the Studio: `flt-d4fe62ad` replayed as `flt-1c40cc8f`, 500 to 200 in 22.49 ms. The green banner in the Studio footage ("Deterministic Replay Verified: 500 to 200, original trace flt-d4fe62ad, replay trace flt-1c40cc8f, 22.49 ms") is that one.

### The drift on a 200

- `flt-611b7ca7`: `GET /api/v1/orders/102` at 18:30:26.243, status 200 in 1.8 ms. Body: `{"order_id": "ord_102", "customer_tier": "pro", "total_cents": "twelve-thousand-five-hundred", "status": "pending_review"}`.
- Two findings, both severity high: `missing_required_field` on `$.currency` (expected string, actual missing) and `type_mismatch` on `$.total_cents` (integer to string). The baseline was learned from `GET /api/v1/orders/101` (`total_cents: 12500`, `currency: "USD"`).
- The session ended with 11 drift traces (`drift_traces`): this one, the two 500s, and eight checkout responses whose `coupon` was a string against the `null` baseline.

### The chaos rule

- `chaos-688910`, created 18:37:11.003: method `POST`, path `/api/v1/webhooks/stripe`, fault `status_code` 429, probability 1.0, no added latency.
- Two hits: `flt-81b05cfe` at 18:37:13 from the storefront (0.83 ms) and `flt-05bb1e7b` at 18:37:17 from the agent's curl (0.42 ms). Both carry the header `X-Faultline-Chaos: chaos-688910` and the body `{"error": "faultline_chaos_injected", "rule_id": "chaos-688910", "fault_type": "status_code", "status_code": 429}`.
- A `GET` to the same path at 18:37:17 got the service's own 404. The rule is scoped to the method.

### The learned contract

- Two contract keys (`contract_keys`): `POST /api/v1/checkout` (4 baseline samples, baseline latency 1.16 ms) and `GET /api/v1/orders/{id}` (3 samples, 1.58 ms).
- The agent exported the OpenAPI 3.1 document in turn 3. A copy is `demo/faultline-openapi.json`.
- Totals at the end of the session (`cli.status.summary`, from `hermes faultline status`): 25 traces, 2 server errors, 7 4xx, 11 drift traces, average latency 2.85 ms, 2 contracts, 1 chaos rule.

### The footage

Terminal (left):

- `scripts/record_pty.py` ran the real `hermes chat` in a pty and saved an asciicast v2 file. Every output chunk is timestamped from the first byte. Nothing was typed into the session that was not in the step list, and the step list typed only the three prompts, the three approvals and `/exit`. It held two fallback confirmations for the case the agent asked before acting; this take did not need them.
- `scripts/cast2player.mjs` turned that file into `termplayer/cast.js` (the full cast, 813 s) and `termplayer/segments.js` (the speed plan and the beat marks). The same plan is `data/term_segments.json`.
- The terminal recording was made under the macOS account folder `/Users/<account>`. For the submission, `termplayer/cast.js` names that folder `/Users/bigmantech001` (the scratch-path session id is shortened by four characters to keep row widths). Nothing else in the cast was changed. The Desktop status bar label for the same folder is set over in `src/ui/Footage.tsx` (it is out of frame in every shot).
- `termplayer/player.html` replays the cast in xterm.js 5.5 with IBM Plex Mono. `scripts/capture_term.mjs` opens it in headless Google Chrome at 1600x900 with device scale 2 and screencasts it to JPEG frames. `scripts/encode.mjs` turns the frames into `public/footage/term.mp4` at 30 fps.
- Waits and model thinking are sped up. The factors below are the exact ones from `data/term_segments.json`. The clip is 107.3 s of footage for 813 s of session. `src/ui/Footage.tsx` reads the same table and prints "real session, waits sped up Nx" or "real session, real time" on the clip while it plays.

| Cast seconds | Speed | What happens |
| :--- | :--- | :--- |
| 0 to 11.5 | 1x | prompt 1 typed |
| 11.5 to 25.5 | 6x | the agent checks the upstream |
| 25.5 to 26 | 1x | `faultline_proxy` is called |
| 26 to 78 | 6x | the agent probes routes, reads the demo files, reproduces the 500 |
| 78 to 81.5 | 1x | the reply with the proxy URL |
| 81.5 to 113 | 4x | the storefront traffic and the Studio click |
| 113 to 114.3 | 1x | prompt 2 sent |
| 114.3 to 118.2 | 6x | thinking |
| 118.2 to 118.6 | 1x | the trace is read |
| 118.6 to 163 | 6x | the agent finds the cause |
| 163 to 163.4 | 1x | the patch is applied |
| 163.4 to 168 | 3x | the hot-reload check |
| 168 to 168.4 | 1x | `faultline_replay` is called |
| 168.4 to 200.8 | 4x | the agent reads the replay and the drifts |
| 200.8 to 210.6 | 1x | the reply: the cause, the fix, the replay |
| 210.6 to 479 | 1000x | the recorder waited while the Studio side took stills and clicked Replay |
| 479 to 485.2 | 1x | prompt 3 typed |
| 485.2 to 500.7 | 6x | the orders traces are checked |
| 500.7 to 501.1 | 1x | the chaos rule is added |
| 501.1 to 639.6 | 8x | the webhook test, the contract work, the tests |
| 639.6 to 647.6 | 1x | the reply: the drift, the 429, the contract |
| 647.6 to 805 | 1000x | the recorder waited for the contract to print |
| 805 to 813 | 1x | `/exit` |

Studio (right):

- The real Hermes Desktop workspace. `hermes webapp` serves it from the gateway of the same Hermes home (the "Webapp", on `127.0.0.1:9121`). `scripts/studio.mjs` signed in with the one-use link that command prints, turned the Faultline Desktop half on in Capabilities, Plugins, opened the Studio page at `/faultline`, and screencast it in headless Chrome at 1600x900 with device scale 2 for the whole take: 19,008 JPEG frames over 821.5 s, each with an epoch timestamp (`.cache/frames/studio/frames.json`). Beats are in `.cache/marks.json` as `studio.*`.
- The step list told it when to click: the 500 row at 18:30:32 (the inspector opens on `flt-92e75bfe`), the Replay button at 18:36:43, the 429 row at 18:42:15. The stat tiles, the waterfall rows, the inspector payloads and the replay banner are the page's own rendering of Faultline's database.
- The Studio frames sit in `video/.cache`, which git ignores. They exist only on the machine that recorded them.
- `.cache/marks.json` also holds `live.*` beats from the recorder and `term.*` beats from an earlier, incomplete player run. The terminal clip must be captured again with `scripts/capture_term.mjs` before the film is rendered.

### Narration, music, effects

- Narration: ElevenLabs, voice Daniel (id `onwK4e9ZLuTAKqWW03F9`), model `eleven_multilingual_v2`, settings in `script.json`. Seven lines, 2,847 characters in total (`.cache/vo.json`). `scripts/voiceover.mjs` requests each line with word timestamps and normalises it to -16 LUFS. `scripts/timing.mjs` maps the spoken words back onto the written text and puts every word on a frame in `src/timing.json`. The on-screen ticker, the word cues and the sound cues all read that file.
- Music: ElevenLabs Music, generated from a composition plan (`.cache/music.json`, source `elevenlabs-music-plan`). 82 s, about 95 bpm, -16.7 LUFS. `src/Film.tsx` ducks it under every spoken line.
- Effects: 16 short cues from ElevenLabs sound generation (`scripts/sfx.mjs`), trimmed and peak-normalised, placed on spoken words in `src/Film.tsx`.
- Final mix: `scripts/finish.mjs` brings the master to -14 LUFS with true peaks at or below -1.5 dBTP, two-pass loudnorm, video copied untouched.

### Graphics and names

- The wordmark, the mark, the seismograph strip at the bottom of every scene, the cards, counters, status chips and the poster are drawn in Remotion (`src/ui`, `src/scenes`, `src/Poster.tsx`). Fonts: Space Grotesk and IBM Plex Mono via `@remotion/google-fonts`.
- The names Hermes, Hermes Agent and Nous Research appear only as text ("A plugin for Hermes Agent", "Hermes Agent Plugin Hackathon"). No logo of theirs is used. The hermes chat interface and the Hermes Desktop workspace appear as they are, in the footage.
- `src/data.ts` holds one constant that is not measured: `COUPON_REQUEST` (`{"subtotal_cents": 5000, "coupon": "FOUNDERS100"}`), the storefront's coupon step. It is equal to the request body of `flt-92e75bfe`.

## Build it

From this folder, in order:

```bash
npm install
npm run vo && npm run music && npm run sfx && npm run timing
node scripts/capture_term.mjs && node scripts/encode.mjs
npm run stills
npm run draft
npm run render4k && npm run finish && npm run 1080p
npm run poster
```

- `vo`, `music` and `sfx` call ElevenLabs. `scripts/env.mjs` reads the key at runtime from `ELEVENLABS_API_KEY` in the environment or from an env file outside the repo. The key is never written to disk by these scripts, never logged, and never part of an error message. Generated audio is cached under `.cache` and `public/audio`, both ignored by git, so a clean clone regenerates it.
- `timing` writes `src/timing.json` from the generated voice files. It is ignored by git for the same reason.
- `capture_term.mjs` needs Google Chrome at `/Applications/Google Chrome.app`. It replays `termplayer/cast.js`, which is in the repo. `encode.mjs` also encodes the Studio clip when `.cache/frames/studio` is present.
- `stills` writes check frames to `out/stills`. `draft` renders a half-size preview. `render4k` renders the master at `--scale 2`, `finish` normalises the audio, `1080p` downscales for X, `poster` renders the thumbnail.
- `npm run typecheck` runs the TypeScript check.

The take itself cannot be rebuilt from this repo. It needs a Hermes Agent install with a model provider, the Faultline plugin enabled, the demo service and the Desktop workspace running at once (`scripts/take.sh`, `scripts/record_pty.py`, `scripts/studio.mjs`, `scripts/take_steps.template.json` are the tooling that did it). What the take produced is kept: the terminal recording in `termplayer/cast.js` and `termplayer/segments.js`, the speed table in `data/term_segments.json`, the facts in `data/session.json` (exported from Faultline's database and the asciicast by `scripts/session_facts.py`), and the contract the agent exported in `demo/faultline-openapi.json`.
