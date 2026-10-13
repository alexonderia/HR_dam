#!/bin/sh
set -eu

: "${OLLAMA_MODEL:?Set OLLAMA_MODEL}"

if ollama show "$OLLAMA_MODEL" >/dev/null 2>&1; then
  echo "Model is already installed: $OLLAMA_MODEL"
else
  echo "Downloading model: $OLLAMA_MODEL"
  ollama pull "$OLLAMA_MODEL"
fi

ollama show "$OLLAMA_MODEL" >/dev/null
echo "Model is ready: $OLLAMA_MODEL"
