
import unittest
from unittest.mock import patch

from app import text_extractor


class TextCacheTests(unittest.TestCase):
    def setUp(self):
        self.old_cache = text_extractor._text_cache.copy()
        self.old_bytes = text_extractor._text_cache_bytes

        text_extractor._text_cache.clear()
        text_extractor._text_cache_bytes = 0

    def tearDown(self):
        text_extractor._text_cache.clear()
        text_extractor._text_cache.update(self.old_cache)
        text_extractor._text_cache_bytes = self.old_bytes

    def test_cache_respects_item_limit_and_lru(self):
        with patch.object(
            text_extractor.settings, "TEXT_CACHE_MAX_ITEMS", 2
        ), patch.object(
            text_extractor.settings, "TEXT_CACHE_MAX_BYTES", 100
        ):
            text_extractor._cache_put("a", "aa")
            text_extractor._cache_put("b", "bb")

            # Обращение к a делает запись самой недавно использованной.
            self.assertEqual(text_extractor._cache_get("a"), "aa")

            text_extractor._cache_put("c", "cc")

            self.assertEqual(
                list(text_extractor._text_cache.keys()),
                ["a", "c"],
            )
            self.assertEqual(text_extractor._text_cache_bytes, 4)

    def test_cache_respects_byte_limit(self):
        with patch.object(
            text_extractor.settings, "TEXT_CACHE_MAX_ITEMS", 10
        ), patch.object(
            text_extractor.settings, "TEXT_CACHE_MAX_BYTES", 3
        ):
            text_extractor._cache_put("a", "aa")
            text_extractor._cache_put("b", "bb")

            # Две записи по 2 байта не помещаются в лимит 3 байта.
            self.assertEqual(
                list(text_extractor._text_cache.keys()),
                ["b"],
            )
            self.assertEqual(text_extractor._text_cache_bytes, 2)

            # Отдельная запись, превышающая весь лимит, не кэшируется.
            text_extractor._cache_put("large", "four")

            self.assertNotIn("large", text_extractor._text_cache)
            self.assertEqual(text_extractor._text_cache_bytes, 2)


if __name__ == "__main__":
    unittest.main()
