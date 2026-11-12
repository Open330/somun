import json, sqlite3, sys, os
label = sys.argv[1]; d = os.path.join(os.path.dirname(os.path.abspath(__file__)), label)
db = sqlite3.connect(f"file:{d}/data/somun.db?mode=ro", uri=True)
rows = json.load(open(f"{d}/result.json"))
out = os.path.join(d, "review"); os.makedirs(out, exist_ok=True)
items = []
for i, r in enumerate(rows, 1):
    ev = json.loads(db.execute("select evidence from candidates where id=?", (r["candidate"],)).fetchone()[0])
    repo_slug = r["repo"].replace("/", "__")
    src = os.path.join(out, f"source-{repo_slug}.md")
    if not os.path.exists(src):
        hp = (ev.get("homepageSource") or {}).get("text") or ""
        open(src, "w").write(f"# Sources for {r['repo']}\n\nRepository: {ev.get('repoUrl')}\nHomepage: {ev.get('homepage') or '(none)'}\nDescription: {ev.get('description') or ''}\n\n## Homepage text\n{hp or '(no homepage)'}\n\n## README\n{ev.get('readmeForChecks') or ev.get('readmeExcerpt') or ''}\n")
    items.append({"id": f"D{i:02d}", "repo": r["repo"], "language": "Korean" if r["lang"] == "ko" else "English", "channel": "X (280 weighted chars; Korean counts 2)", "body": r["draft"]["body"], "sources": src})
json.dump(items, open(os.path.join(out, "drafts.json"), "w"), ensure_ascii=False, indent=1)
print(os.path.join(out, "drafts.json"))
