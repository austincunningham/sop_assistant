# About

AI chatbot for SOP libraries. Loads markdown, asciidoc, and text files from **local directories** and **GitHub/GitLab repos**, then answers questions via Ollama (mistral) with source citations.

Remote repos are fetched over the HTTP API — nothing is cloned to disk.

# Prereq

- ollama https://ollama.com/download/linux
- python 3
- c++ > 11

# setup

```bash
ollama run mistral
```

```bash
sudo dnf install gcc-c++ python3-devel
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

# Running

Start the web GUI (optionally with one or more sources):

```bash
python main.py
python main.py /path/to/sops
python main.py /path/a /path/b https://github.com/org/sop-repo
```

With no arguments the app starts empty — use the **Sources** panel in the UI to add directories or repos. You can also set `SOP_DIR` or `SOP_SOURCES` (path-separated list).

Open http://127.0.0.1:5000

Options:

```bash
python main.py /path/to/sops --host 0.0.0.0 --port 8080
python main.py /path/to/sops --cli
```

Private repos — set a token before starting, or paste it in the UI:

```bash
export GIT_TOKEN=...   # or GITHUB_TOKEN / GITLAB_TOKEN
python main.py https://gitlab.com/org/private-sops
```

# CLI example

```bash
python main.py /path/to/sops --cli
```
