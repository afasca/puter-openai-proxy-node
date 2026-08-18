# How to publish this to GitHub (public)

These files are already desensitized and safe to make public. Since I can't push to
GitHub for you, run these steps locally from inside the `repo/` folder.

## 1. Create the repository

Either create an empty repo on github.com first, **or** use the GitHub CLI:

```bash
# with GitHub CLI (recommended)
gh repo create puter-openai-proxy-node --public --source=. --remote=origin
```

## 2. Or do it manually with git

```bash
cd repo
git init
git add .
git commit -m "Initial commit: Puter OpenAI-compatible proxy node"
git branch -M main
git remote add origin https://github.com/<your-username>/puter-openai-proxy-node.git
git push -u origin main
```

Then, on github.com, the repo is public if you created it as public (or switch it in
Settings → General → Danger Zone → Change visibility).

## 3. Before you push — final safety check

```bash
# make sure no secret slipped in
grep -RniE "github_pat_|ghp_|sk-[a-z0-9]{20,}|puter.work" . --exclude-dir=.git
```

Expected: only placeholders like `CHANGE_ME`, `YOUR-WORKER.puter.work`. If you see a real
token, remove it before committing.

---

## ⚠️ IMPORTANT

If you ever pasted a real GitHub Personal Access Token anywhere (chat, an issue, a file),
**revoke it now**: GitHub → Settings → Developer settings → Personal access tokens →
delete it, then generate a new one. A leaked token gives full access to your account.
