import tempfile
import unittest
import zipfile
from pathlib import Path

from pages_bundle import unpack


class PagesBundleTests(unittest.TestCase):
    def test_unpacks_a_static_site(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with zipfile.ZipFile(root / "site.zip", "w") as bundle:
                bundle.writestr("index.html", "hello")
                bundle.writestr("assets/main.js", "app")
            unpack(root / "site.zip", root / "site")
            self.assertEqual((root / "site/assets/main.js").read_text(), "app")
            with self.assertRaises(FileExistsError):
                unpack(root / "site.zip", root / "site")

    def test_rejects_traversal_links_and_missing_index(self):
        for name in ["../bad", "/tmp/bad", "assets/../../bad", "assets\\bad", "C:/bad", "link"]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                with zipfile.ZipFile(root / "site.zip", "w") as bundle:
                    bundle.writestr("index.html", "ok")
                    entry = zipfile.ZipInfo(name)
                    if name == "link":
                        entry.external_attr = 0o120777 << 16
                    bundle.writestr(entry, "bad")
                with self.assertRaises(ValueError):
                    unpack(root / "site.zip", root / "site")
                self.assertFalse((root / "site").exists())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with zipfile.ZipFile(root / "site.zip", "w") as bundle:
                bundle.writestr("dist/index.html", "wrong root")
            with self.assertRaises(ValueError):
                unpack(root / "site.zip", root / "site")
