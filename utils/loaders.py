"""Load SOP documents from local directories or GitHub/GitLab repos (HTTP API, no clone)."""

from __future__ import annotations

import os
import re
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

import requests
from langchain_community.document_loaders import TextLoader
from langchain_core.documents import Document

ALLOWED_EXTS = (".md", ".asciidoc", ".txt", ".log", ".csv", ".json", ".yaml", ".yml")


def is_remote_repo(source: str) -> bool:
    if source.startswith(("git@", "ssh://", "https://", "http://")):
        return True
    if source.endswith(".git"):
        return True
    host = urlparse(source).hostname or ""
    return any(h in host for h in ("github.com", "gitlab.com", "gitlab."))


def _resolve_token(token: str | None) -> str | None:
    return (
        token
        or os.environ.get("GIT_TOKEN")
        or os.environ.get("GITHUB_TOKEN")
        or os.environ.get("GITLAB_TOKEN")
    )


def _allowed_file(path: str) -> bool:
    return path.rsplit("/", 1)[-1].lower().endswith(ALLOWED_EXTS)


def _parse_repo_url(url: str) -> dict:
    raw = url.strip()

    ssh = re.match(r"^git@([^:]+):(.+?)(?:\.git)?$", raw)
    if ssh:
        host, path = ssh.group(1), ssh.group(2)
        parts = path.strip("/").split("/")
        return {
            "kind": "gitlab" if "gitlab" in host else "github",
            "host": host,
            "project": "/".join(parts),
            "ref": None,
            "subpath": "",
        }

    parsed = urlparse(raw)
    host = parsed.hostname or ""
    parts = [unquote(p) for p in parsed.path.strip("/").split("/") if p]
    if parts and parts[-1].endswith(".git"):
        parts[-1] = parts[-1][:-4]

    kind = "gitlab" if "gitlab" in host else "github"
    ref = None
    subpath = ""

    if kind == "github":
        if len(parts) < 2:
            raise ValueError(f"Invalid GitHub URL: {url}")
        project = f"{parts[0]}/{parts[1]}"
        if len(parts) >= 4 and parts[2] in ("tree", "blob"):
            ref = parts[3]
            subpath = "/".join(parts[4:])
        elif len(parts) > 2:
            subpath = "/".join(parts[2:])
        return {
            "kind": kind,
            "host": host,
            "project": project,
            "ref": ref,
            "subpath": subpath,
        }

    if "-" in parts:
        idx = parts.index("-")
        project_parts = parts[:idx]
        rest = parts[idx + 1 :]
        if rest and rest[0] in ("tree", "blob") and len(rest) >= 2:
            ref = rest[1]
            subpath = "/".join(rest[2:])
        project = "/".join(project_parts)
    else:
        project = "/".join(parts)

    if not project:
        raise ValueError(f"Invalid GitLab URL: {url}")

    return {
        "kind": kind,
        "host": host,
        "project": project,
        "ref": ref,
        "subpath": subpath,
    }


def _github_headers(token: str | None) -> dict:
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _github_default_branch(info: dict, token: str | None) -> str:
    api = (
        f"https://api.github.com/repos/{info['project']}"
        if info["host"] == "github.com"
        else f"https://api.{info['host']}/repos/{info['project']}"
    )
    r = requests.get(api, headers=_github_headers(token), timeout=30)
    r.raise_for_status()
    return r.json()["default_branch"]


def _load_github(info: dict, branch: str | None, token: str | None) -> list[Document]:
    ref = branch or info["ref"] or _github_default_branch(info, token)
    sub = info["subpath"].strip("/")
    tree_url = (
        f"https://api.github.com/repos/{info['project']}/git/trees/{ref}?recursive=1"
        if info["host"] == "github.com"
        else f"https://api.{info['host']}/repos/{info['project']}/git/trees/{ref}?recursive=1"
    )

    print(f"🌐 Listing GitHub tree {info['project']}@{ref}...")
    r = requests.get(tree_url, headers=_github_headers(token), timeout=60)
    r.raise_for_status()

    docs: list[Document] = []
    for item in r.json().get("tree", []):
        if item.get("type") != "blob":
            continue
        path = item["path"]
        if sub and not (path == sub or path.startswith(sub + "/")):
            continue
        if not _allowed_file(path):
            continue

        raw_url = (
            f"https://raw.githubusercontent.com/{info['project']}/{ref}/{path}"
            if info["host"] == "github.com"
            else f"https://{info['host']}/raw/{info['project']}/{ref}/{path}"
        )
        try:
            fr = requests.get(raw_url, headers=_github_headers(token), timeout=30)
            fr.raise_for_status()
            docs.append(
                Document(
                    page_content=fr.text,
                    metadata={"source": f"{info['project']}/{path}", "ref": ref},
                )
            )
        except Exception as e:
            print(f"❌ Error loading {path}: {e}")
    return docs


def _gitlab_headers(token: str | None) -> dict:
    return {"PRIVATE-TOKEN": token} if token else {}


def _gitlab_default_branch(info: dict, token: str | None) -> str:
    project_id = quote(info["project"], safe="")
    url = f"https://{info['host']}/api/v4/projects/{project_id}"
    r = requests.get(url, headers=_gitlab_headers(token), timeout=30)
    r.raise_for_status()
    return r.json()["default_branch"]


def _load_gitlab(info: dict, branch: str | None, token: str | None) -> list[Document]:
    ref = branch or info["ref"] or _gitlab_default_branch(info, token)
    sub = info["subpath"].strip("/")
    project_id = quote(info["project"], safe="")
    base = f"https://{info['host']}/api/v4"

    print(f"🌐 Listing GitLab tree {info['project']}@{ref}...")
    paths: list[str] = []
    page = 1
    while True:
        params: dict = {"ref": ref, "recursive": True, "per_page": 100, "page": page}
        if sub:
            params["path"] = sub
        r = requests.get(
            f"{base}/projects/{project_id}/repository/tree",
            headers=_gitlab_headers(token),
            params=params,
            timeout=60,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        for item in batch:
            if item.get("type") == "blob" and _allowed_file(item["path"]):
                paths.append(item["path"])
        if len(batch) < 100:
            break
        page += 1

    docs: list[Document] = []
    for path in paths:
        file_path = quote(path, safe="")
        try:
            fr = requests.get(
                f"{base}/projects/{project_id}/repository/files/{file_path}/raw",
                headers=_gitlab_headers(token),
                params={"ref": ref},
                timeout=30,
            )
            fr.raise_for_status()
            docs.append(
                Document(
                    page_content=fr.text,
                    metadata={"source": f"{info['project']}/{path}", "ref": ref},
                )
            )
        except Exception as e:
            print(f"❌ Error loading {path}: {e}")
    return docs


def load_local_directory(directory: str | Path) -> list[Document]:
    docs = []
    for root, _, files in os.walk(directory):
        for file in files:
            if file.lower().endswith(ALLOWED_EXTS):
                path = os.path.join(root, file)
                try:
                    loader = TextLoader(path, encoding="utf-8")
                    docs.extend(loader.load())
                except Exception as e:
                    print(f"❌ Error loading {path}: {e}")
    return docs


def load_remote_repo(
    url: str,
    branch: str | None = None,
    token: str | None = None,
) -> list[Document]:
    token = _resolve_token(token)
    info = _parse_repo_url(url)
    print(f"📂 Fetching documents from {info['kind']}://{info['project']}")
    if info["kind"] == "github":
        return _load_github(info, branch, token)
    return _load_gitlab(info, branch, token)


def load_sop_files(
    source: str,
    branch: str | None = None,
    token: str | None = None,
) -> list[Document]:
    """Load from a local directory or a GitHub/GitLab URL."""
    if is_remote_repo(source):
        return load_remote_repo(source, branch=branch, token=token)

    directory = Path(source).expanduser().resolve()
    if not directory.is_dir():
        raise FileNotFoundError(f"Local SOP directory not found: {directory}")
    print(f"📂 Reading documents from {directory}")
    return load_local_directory(directory)
