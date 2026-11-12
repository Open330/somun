"""Isolated end-to-end introduction eval. Starts a fresh somun server from the worktree,
collects the repos, generates profile -> judge -> X ko/en introductions, and dumps the
UNMODIFIED generated drafts. Nothing is edited by hand."""
import json, os, subprocess, sys, time, uuid, urllib.request
S = os.path.dirname(os.path.abspath(__file__))
label = sys.argv[1]
# Optional: generate the X drafts with the local worker (Claude Code) and this model; profile and judge stay on the server model.
local_model = sys.argv[2] if len(sys.argv) > 2 else None
repos = ["Open330/tend", "Open330/haejo", "Open330/aas", "Open330/barshelf", "jiunbae/oh-my-prompt"]
out = os.path.join(S, label); os.makedirs(os.path.join(out, "data"))
token = str(uuid.uuid4()); port = 18800 + int(time.time()) % 90
env = {**os.environ, "DATA_DIR": os.path.join(out, "data"), "PORT": str(port), "SOMUN_TOKEN": token, "SOMUN_TOKEN_OWNER_ID": "local",
       "CRON": "0 0 1 1 *", "LOG_LEVEL": "info", "SOMUN_SHARED_MODEL_UNLIMITED_OWNERS": "local", "GEMINI_API_KEYS": open(os.path.join(S, "gkeys")).read(),  # JSON {"free-1": key, ...}; not committed
       "GITHUB_TOKEN": subprocess.run(["gh", "auth", "token"], capture_output=True, text=True).stdout.strip()}
for k in ["JIUN_LLM_GATEWAY_URL", "JIUN_LLM_GATEWAY_KEY", "JIUN_USAGE_KEY"]: env.pop(k, None)
log = open(os.path.join(out, "server.log"), "w")
srv = subprocess.Popen(["npx", "tsx", "src/server/main.ts"], cwd="/Users/jiun/workspace/somun-audience-20261112", env=env, stdout=log, stderr=log)
def api(m, p, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/api{p}", method=m, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        t = r.read(); return json.loads(t) if t else None
def wait_jobs(limit=900):
    end = time.time() + limit
    while time.time() < end:
        js = api("GET", "/jobs/status")
        if not any(j["status"] in ("pending", "claimed") for j in js): return js
        time.sleep(3)
    return api("GET", "/jobs/status")
started = time.time()
try:
    for _ in range(90):
        try: api("GET", "/me"); break
        except Exception: time.sleep(1)
    api("PATCH", "/settings", {"channelLangs": {"x": ["ko", "en"]}})
    api("POST", "/sources", {"kind": "github", "targets": repos, "enabled": True})
    api("POST", "/collect", {})
    for _ in range(60):
        cands = api("GET", "/candidates"); cands = cands if isinstance(cands, list) else cands.get("candidates", [])
        if len({c["repo"] for c in cands}) >= len(repos): break
        time.sleep(5)
    for r in repos:
        try: api("POST", f"/profiles/{r}/regenerate")
        except Exception as e: print("profile", r, e)
    wait_jobs()
    latest = {}
    for c in cands:
        if c["repo"] not in latest or c["id"] > latest[c["repo"]]["id"]: latest[c["repo"]] = c
    api("POST", "/candidates/judge", {"ids": [c["id"] for c in latest.values()]})
    wait_jobs()
    timing = {"judge_done_s": round(time.time() - started)}
    if local_model:
        api("PATCH", "/settings", {"llm": {"provider": "local-agent", "agentCli": "claude"}})
        draft_started = time.time()
        for c in latest.values():
            api("POST", f"/candidates/{c['id']}/redraft", {"targets": [{"channel": "x", "lang": "ko"}, {"channel": "x", "lang": "en"}], "introduction": True})
        wenv = {k: v for k, v in os.environ.items() if not (k.startswith("CLAUDE_CODE_") or k in ("CLAUDECODE", "CLAUDE_CONFIG_DIR"))}
        wenv.update({"SOMUN_URL": f"http://127.0.0.1:{port}", "SOMUN_TOKEN": token})
        wlog = open(os.path.join(out, "worker.log"), "w")
        worker = subprocess.Popen(["npx", "tsx", "scripts/agent-worker.ts", "--cli", "claude", "--model", local_model, "--interval", "5"], cwd="/Users/jiun/workspace/somun-audience-20261112", env=wenv, stdout=wlog, stderr=wlog)
        time.sleep(10)
        wait_jobs(3600)
        worker.terminate()
        timing["local_drafts_s"] = round(time.time() - draft_started)
    else:
        draft_started = time.time()
        for c in latest.values():
            d = api("GET", f"/candidates/{c['id']}")
            have = {x["lang"] for x in d["drafts"] if x["channel"] == "x"}
            targets = [{"channel": "x", "lang": l} for l in ("ko", "en") if l not in have]
            if targets: api("POST", f"/candidates/{c['id']}/redraft", {"targets": targets, "introduction": True})
            wait_jobs()
        timing["drafts_s"] = round(time.time() - draft_started)
    json.dump(timing, open(os.path.join(out, "timing.json"), "w"))
    result = []
    for r, c in latest.items():
        d = api("GET", f"/candidates/{c['id']}")
        prof = api("GET", f"/profiles/{r}")
        j = d["judgments"][0] if d["judgments"] else None
        for lang in ("ko", "en"):
            xs = sorted([x for x in d["drafts"] if x["channel"] == "x" and x["lang"] == lang], key=lambda x: x["version"])
            x = xs[-1] if xs else None
            result.append({"repo": r, "candidate": c["id"], "lang": lang, "naming": (prof.get("profile") or {}).get("naming"),
                           "judgment": j and {k: j.get(k) for k in ("decision", "total", "scores", "purpose", "angle", "reasoning")},
                           "draft": x and {k: x.get(k) for k in ("id", "version", "status", "purpose", "model", "body")},
                           "failed": x and [l for l in x["lint"] if not l["ok"]]})
    json.dump(result, open(os.path.join(out, "result.json"), "w"), ensure_ascii=False, indent=1)
    jobs = api("GET", "/jobs/status")
    json.dump(jobs, open(os.path.join(out, "jobs.json"), "w"), ensure_ascii=False, indent=1)
    for x in result:
        print("=====", x["repo"], x["lang"], "| naming", x["naming"], "| judge", x["judgment"] and (x["judgment"]["decision"], x["judgment"]["total"]))
        print(x["draft"]["body"] if x["draft"] else "NO DRAFT")
        print("FAILED:", [f["rule"] for f in (x["failed"] or [])])
finally:
    srv.terminate()
