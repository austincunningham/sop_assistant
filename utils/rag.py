"""Multi-source SOP index backed by Chroma + Ollama."""

from __future__ import annotations

import uuid
from pathlib import Path

from langchain_classic.chains import RetrievalQA
from langchain_community.vectorstores import Chroma
from langchain_core.documents import Document
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_ollama import OllamaLLM
from langchain_text_splitters import RecursiveCharacterTextSplitter

from utils.loaders import is_remote_repo, load_sop_files


class SopIndex:
    def __init__(self, model: str = "mistral"):
        self.model = model
        self.sources: list[dict] = []
        self.embeddings = HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2")
        self.llm = OllamaLLM(model=model)
        self.splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=100)
        self.vectorstore: Chroma | None = None
        self.qa_chain: RetrievalQA | None = None

    @property
    def ready(self) -> bool:
        return self.qa_chain is not None and bool(self.sources)

    def list_sources(self) -> list[dict]:
        return [
            {
                "id": s["id"],
                "kind": s["kind"],
                "location": s["location"],
                "branch": s.get("branch"),
                "doc_count": s.get("doc_count", 0),
            }
            for s in self.sources
        ]

    def _normalize_location(self, location: str) -> str:
        location = location.strip()
        if is_remote_repo(location):
            return location.rstrip("/")
        return str(Path(location).expanduser().resolve())

    def _load_tagged(
        self,
        source_id: str,
        location: str,
        branch: str | None,
        token: str | None,
    ) -> list[Document]:
        docs = load_sop_files(location, branch=branch, token=token)
        for doc in docs:
            doc.metadata["source_id"] = source_id
            doc.metadata.setdefault("origin", location)
        return docs

    def _rebuild_chain(self, all_docs: list[Document]) -> None:
        if not all_docs:
            self.vectorstore = None
            self.qa_chain = None
            return

        chunks = self.splitter.split_documents(all_docs)
        print(f"🧠 Indexing {len(chunks)} chunks from {len(all_docs)} documents...")
        self.vectorstore = Chroma.from_documents(chunks, self.embeddings)
        self.qa_chain = RetrievalQA.from_chain_type(
            llm=self.llm,
            retriever=self.vectorstore.as_retriever(),
            return_source_documents=True,
        )

    def _collect_all_docs(self) -> list[Document]:
        """Load all current sources. Does not mutate source metadata."""
        docs: list[Document] = []
        for src in self.sources:
            docs.extend(
                self._load_tagged(
                    src["id"], src["location"], src.get("branch"), src.get("token")
                )
            )
        return docs

    def _apply_doc_counts(self, docs: list[Document]) -> None:
        counts: dict[str, int] = {}
        for doc in docs:
            sid = doc.metadata.get("source_id")
            if sid:
                counts[sid] = counts.get(sid, 0) + 1
        for src in self.sources:
            src["doc_count"] = counts.get(src["id"], 0)

    def add_source(
        self,
        location: str,
        branch: str | None = None,
        token: str | None = None,
    ) -> dict:
        location = self._normalize_location(location)
        for existing in self.sources:
            if existing["location"] == location and existing.get("branch") == branch:
                raise ValueError(f"Source already added: {location}")

        kind = "repo" if is_remote_repo(location) else "directory"
        source_id = uuid.uuid4().hex[:10]
        print(f"➕ Adding {kind}: {location}")
        docs = self._load_tagged(source_id, location, branch, token)
        if not docs:
            raise ValueError(f"No documents found for: {location}")

        entry = {
            "id": source_id,
            "kind": kind,
            "location": location,
            "branch": branch,
            "token": token,
            "doc_count": len(docs),
        }

        # Keep prior source dicts untouched until rebuild succeeds
        previous = list(self.sources)
        try:
            all_docs: list[Document] = []
            for src in previous:
                all_docs.extend(
                    self._load_tagged(
                        src["id"], src["location"], src.get("branch"), src.get("token")
                    )
                )
            all_docs.extend(docs)
            self.sources = previous + [entry]
            self._rebuild_chain(all_docs)
            self._apply_doc_counts(all_docs)
        except Exception:
            self.sources = previous
            raise

        return {
            "id": source_id,
            "kind": kind,
            "location": location,
            "branch": branch,
            "doc_count": entry["doc_count"],
        }

    def remove_source(self, source_id: str) -> None:
        previous = list(self.sources)
        remaining = [s for s in self.sources if s["id"] != source_id]
        if len(remaining) == len(previous):
            raise KeyError(f"Unknown source id: {source_id}")

        print(f"➖ Removed source {source_id}; rebuilding index...")
        self.sources = remaining
        try:
            if not self.sources:
                self.vectorstore = None
                self.qa_chain = None
                return
            all_docs = self._collect_all_docs()
            self._rebuild_chain(all_docs)
            self._apply_doc_counts(all_docs)
        except Exception:
            self.sources = previous
            raise

    def ask(self, query: str) -> dict:
        if not self.qa_chain:
            raise RuntimeError("No sources indexed yet.")
        result = self.qa_chain.invoke({"query": query})
        sources = []
        for doc in result.get("source_documents") or []:
            src = doc.metadata.get("source")
            if src and src not in sources:
                sources.append(src)
        return {"answer": result.get("result", ""), "sources": sources}


def build_index(locations: list[str], model: str = "mistral") -> SopIndex:
    """Build an index from locations. Skips failed sources instead of crashing."""
    index = SopIndex(model=model)
    for loc in locations:
        try:
            index.add_source(loc)
        except Exception as e:
            print(f"⚠️  Skipping source {loc}: {e}")
    return index
