"""Load SOP documents from local directories."""

from __future__ import annotations

import os
from pathlib import Path

from langchain_community.document_loaders import TextLoader
from langchain_core.documents import Document

ALLOWED_EXTS = (".md", ".asciidoc", ".txt", ".log", ".csv", ".json", ".yaml", ".yml")


def load_sop_files(directory: str) -> list[Document]:
    path = Path(directory).expanduser().resolve()
    if not path.is_dir():
        raise FileNotFoundError(f"Local SOP directory not found: {path}")

    print(f"📂 Reading documents from {path}")
    docs: list[Document] = []
    for root, _, files in os.walk(path):
        for file in files:
            if file.lower().endswith(ALLOWED_EXTS):
                file_path = os.path.join(root, file)
                try:
                    loader = TextLoader(file_path, encoding="utf-8")
                    docs.extend(loader.load())
                except Exception as e:
                    print(f"❌ Error loading {file_path}: {e}")
    return docs
