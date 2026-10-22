"""Bounded, temporary progress for interrupted analyses in this process."""

import json
import time
from collections import OrderedDict


class AnalysisCheckpoints:
    # Access is serialized by model_capacity, including reads and completion.
    def __init__(self, max_items=32, max_bytes=20 * 1024 * 1024, ttl_seconds=24 * 3600):
        self.max_items = max_items
        self.max_bytes = max_bytes
        self.ttl_seconds = ttl_seconds
        self._items = OrderedDict()
        self._bytes = 0

    def discard(self, key):
        entry = self._items.pop(key, None)
        if entry is not None:
            self._bytes -= sum(len(value) for value in entry[1].values())

    def _prune(self):
        cutoff = time.monotonic() - self.ttl_seconds
        for key, (updated, _) in list(self._items.items()):
            if updated <= cutoff:
                self.discard(key)

    def get(self, key, profile_index):
        self._prune()
        entry = self._items.get(key)
        if entry is None:
            return None
        self._items.move_to_end(key)
        value = entry[1].get(profile_index)
        return json.loads(value)["rating"] if value is not None else None

    def duration_ms(self, key, profile_index):
        entry = self._items.get(key)
        value = entry[1].get(profile_index) if entry is not None else None
        return json.loads(value)["duration_ms"] if value is not None else 0

    def put(self, key, profile_index, rating, duration_ms=0):
        self._prune()
        value = json.dumps({"rating": rating, "duration_ms": duration_ms},
                           ensure_ascii=False, allow_nan=False).encode("utf-8")
        if self.max_items <= 0 or len(value) > self.max_bytes:
            return
        entry = self._items.setdefault(key, [time.monotonic(), {}])
        old = entry[1].get(profile_index, b"")
        self._bytes += len(value) - len(old)
        entry[0] = time.monotonic()
        entry[1][profile_index] = value
        self._items.move_to_end(key)
        while len(self._items) > self.max_items or self._bytes > self.max_bytes:
            self.discard(next(iter(self._items)))

    def clear(self):
        self._items.clear()
        self._bytes = 0


analysis_checkpoints = AnalysisCheckpoints()
