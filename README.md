# About

AI Chatbot for SOP repo, Reads a SOP directory with md and asciidoc and text files to provide answers 

# Prereq

- ollama https://ollama.com/download/linux
- python 3
- c++ > 11

# setup 

Run ollama with mistral, this should be run in parrell with the python application
```bash
ollama run mistral
```
Install dependances 
```bash
sudo dnf install gcc-c++ python3-devel
pip install langchain chromadb sentence-transformers ollama
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt 
```

# Running 

```bash
python main.py
```
expected cli interface e.g.

```bash
🤖 SOP Assistant ready. Type your question below. Type 'exit' to quit.

📝 You: redis is full

🤖 Assistant:
  To address a situation where Redis is full, you can follow these steps:...

```

