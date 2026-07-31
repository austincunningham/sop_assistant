import argparse
import os
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

from utils.rag import SopIndex, build_index

ROOT = Path(__file__).resolve().parent
app = Flask(
    __name__,
    static_folder=str(ROOT / "static"),
    static_url_path="/static",
)
index: SopIndex | None = None


def parse_args():
    parser = argparse.ArgumentParser(
        description="SOP Assistant — ask questions about local SOP directories."
    )
    parser.add_argument(
        "sources",
        nargs="*",
        default=None,
        help="One or more local SOP directories.",
    )
    parser.add_argument(
        "--cli",
        action="store_true",
        help="Run in terminal chat mode instead of the web GUI.",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Web server host (default: 127.0.0.1).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=5000,
        help="Web server port (default: 5000).",
    )
    parser.add_argument(
        "--model",
        default="mistral",
        help="Ollama model name (default: mistral).",
    )
    return parser.parse_args()


def _default_sources() -> list[str]:
    """Sources from SOP_DIR / SOP_SOURCES, or empty (add via CLI args or web UI)."""
    env = os.environ.get("SOP_DIR") or os.environ.get("SOP_SOURCES")
    if not env:
        return []
    return [s.strip() for s in env.split(os.pathsep) if s.strip()]


@app.route("/")
def home():
    return send_from_directory(ROOT, "webapp.html")


@app.route("/api/status")
def status():
    return jsonify(
        {
            "ready": bool(index and index.ready),
            "sources": index.list_sources() if index else [],
        }
    )


@app.route("/api/sources", methods=["GET"])
def list_sources():
    if index is None:
        return jsonify({"sources": []})
    return jsonify({"sources": index.list_sources()})


@app.route("/api/sources", methods=["POST"])
def add_source():
    if index is None:
        return jsonify({"error": "Assistant is not initialized."}), 503

    data = request.get_json(silent=True) or {}
    location = (data.get("location") or data.get("path") or "").strip()
    if not location:
        return jsonify({"error": "location is required (local directory path)."}), 400

    try:
        entry = index.add_source(location)
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    return jsonify({"source": entry, "sources": index.list_sources()}), 201


@app.route("/api/sources/<source_id>", methods=["DELETE"])
def remove_source(source_id: str):
    if index is None:
        return jsonify({"error": "Assistant is not initialized."}), 503

    try:
        index.remove_source(source_id)
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    return jsonify({"sources": index.list_sources()})


@app.route("/api/chat", methods=["POST"])
def chat():
    if index is None or not index.ready:
        return jsonify({"error": "Add at least one SOP source first."}), 503

    data = request.get_json(silent=True) or {}
    query = (data.get("message") or data.get("query") or "").strip()
    if not query:
        return jsonify({"error": "Message is required."}), 400

    try:
        result = index.ask(query)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    return jsonify(result)


def run_cli(sop_index: SopIndex):
    print("🤖 SOP Assistant ready. Type your question below. Type 'exit' to quit.")
    while True:
        query = input("\n📝 You: ")
        if query.lower() in ("exit", "quit"):
            print("👋 Bye! Take care.")
            break

        result = sop_index.ask(query)
        print("\n🤖 Assistant:\n", result["answer"])
        print("\n📎 Sources:")
        for src in result["sources"]:
            print(f" - {src}")


def main():
    global index

    args = parse_args()
    locations = args.sources if args.sources else _default_sources()

    if locations:
        print(f"📚 Initial sources ({len(locations)}):")
        for loc in locations:
            print(f"   • {loc}")
    else:
        print("📚 No initial sources — add directories via the web UI or pass them as arguments.")

    index = build_index(locations, model=args.model)

    if args.cli:
        if not index.ready:
            raise SystemExit(
                "No sources indexed. Pass at least one valid directory, "
                "or set SOP_DIR / SOP_SOURCES."
            )
        run_cli(index)
        return

    if not index.ready:
        print("ℹ️  Starting with an empty index — use the Sources panel to add content.")

    print(f"🌐 Web GUI → http://{args.host}:{args.port}")
    app.run(host=args.host, port=args.port, debug=False)


if __name__ == "__main__":
    main()
