"""Verify Boost extraction, cache reuse and integrity failure behavior without network access."""
import hashlib
import importlib.util
import io
import pathlib
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('daq_web_build', pathlib.Path(__file__).resolve().parents[1] / 'build.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.archive = self.root / '__external' / 'src' / 'boost-1.82.0.tar.xz'
        self.archive.parent.mkdir(parents=True)

    def bundle(self, unsafe=False):
        with tarfile.open(self.archive, 'w:xz') as tar:
            content = b'cmake_minimum_required(VERSION 3.24)\n'
            member = tarfile.TarInfo('boost-1.82.0/CMakeLists.txt')
            member.size = len(content)
            tar.addfile(member, io.BytesIO(content))
            if unsafe:
                member = tarfile.TarInfo('../escaped-file')
                member.size = len(content)
                tar.addfile(member, io.BytesIO(content))
        return hashlib.sha256(self.archive.read_bytes()).hexdigest()

    def test_cached_archive_extracts_once_and_reuses_source(self):
        checksum = self.bundle()
        with patch.object(build, 'BOOST_SHA256', checksum), patch.object(build.urllib.request, 'urlopen') as network:
            source = build.prepare_windows_boost(self.root)
            self.assertTrue((source / 'CMakeLists.txt').is_file())
            self.assertEqual((source / '.daq-web-archive-sha256').read_text().strip(), checksum)
            with patch.object(build.tarfile, 'open', side_effect=AssertionError('Unexpected re-extraction')):
                self.assertEqual(build.prepare_windows_boost(self.root), source)
            network.assert_not_called()

    def test_invalid_checksum_stops_before_extraction(self):
        self.bundle()
        with patch.object(build, 'BOOST_SHA256', '0' * 64):
            with self.assertRaisesRegex(RuntimeError, 'SHA256'):
                build.prepare_windows_boost(self.root)
        self.assertFalse((self.root / 'bootstrap' / 'boost-1.82.0').exists())

    def test_path_traversal_is_rejected_and_temporary_files_cleaned(self):
        checksum = self.bundle(unsafe=True)
        with patch.object(build, 'BOOST_SHA256', checksum):
            with self.assertRaises(tarfile.FilterError):
                build.prepare_windows_boost(self.root)
        self.assertFalse((self.root / 'bootstrap' / 'escaped-file').exists())
        self.assertEqual(list((self.root / 'bootstrap').iterdir()), [])

    def test_existing_unknown_directory_is_preserved(self):
        source = self.root / 'bootstrap' / 'boost-1.82.0'
        source.mkdir(parents=True)
        user_file = source / 'keep.txt'
        user_file.write_text('keep')
        with self.assertRaisesRegex(RuntimeError, 'Incomplete'):
            build.prepare_windows_boost(self.root)
        self.assertEqual(user_file.read_text(), 'keep')


if __name__ == '__main__':
    unittest.main(verbosity=2)
