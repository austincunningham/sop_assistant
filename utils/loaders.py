from langchain_community.document_loaders import DirectoryLoader, TextLoader

import os


def load_sop_files(directory: str):
    allowed_exts = ('.md', '.asciidoc', '.txt')

    docs = []
    for root, _, files in os.walk(directory):
        for file in files:
            if file.lower().endswith(allowed_exts):
                path = os.path.join(root, file)
                try:
                    loader = TextLoader(path, encoding='utf-8')
                    docs.extend(loader.load())
                except Exception as e:
                    print(f"❌ Error loading {path}: {e}")
    return docs
