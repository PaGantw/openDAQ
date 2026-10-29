#!/usr/bin/env python3
"""Build the SDK and browser workstation bridge without requiring Python bindings."""
import argparse
import hashlib
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[3]
TARGETS = ['daq_web_bridge', 'ref_device_module', 'ref_fb_module',
           'native_stream_cl_module', 'opcua_client_module', 'ws_stream_cl_module']
BOOST_URL = 'https://github.com/boostorg/boost/releases/download/boost-1.82.0/boost-1.82.0.tar.xz'
BOOST_SHA256 = 'fd60da30be908eff945735ac7d4d9addc7f7725b1ff6fcdcaede5262d511d21e'


def prepare_windows_boost(build_dir):
    """Use Python's safe extractor instead of CMake's failing Windows tar extractor.

    Keep the SDK's exact archive and SHA256. Prefer the archive already downloaded
    by a previous CMake attempt; never delete or rewrite a user's source checkout.
    """
    bootstrap = build_dir.resolve() / 'bootstrap'
    source = bootstrap / 'boost-1.82.0'
    marker = source / '.daq-web-archive-sha256'
    if source.exists():
        if marker.is_file() and marker.read_text().strip() == BOOST_SHA256 and (source / 'CMakeLists.txt').is_file():
            return source
        raise RuntimeError(f'Incomplete Boost bootstrap at {source}. Use a fresh --build-dir or move this generated directory aside.')
    bootstrap.mkdir(parents=True, exist_ok=True)
    archive = build_dir.resolve() / '__external' / 'src' / 'boost-1.82.0.tar.xz'
    if not archive.is_file():
        archive = bootstrap / 'boost-1.82.0.tar.xz'
    if not archive.is_file():
        print('Downloading the SDK-pinned Boost 1.82.0 archive...', flush=True)
        with tempfile.NamedTemporaryFile(dir=bootstrap, suffix='.part', delete=False) as f:
            pending = pathlib.Path(f.name)
            try:
                with urllib.request.urlopen(BOOST_URL, timeout=120) as response:
                    shutil.copyfileobj(response, f)
            except BaseException:
                f.close()
                pending.unlink(missing_ok=True)
                raise
        try:
            with pending.open('rb') as f:
                digest = hashlib.file_digest(f, 'sha256').hexdigest()
            if digest != BOOST_SHA256:
                raise RuntimeError('Downloaded Boost archive failed SHA256 verification')
            pending.replace(archive)
        finally:
            pending.unlink(missing_ok=True)
    with archive.open('rb') as f:
        digest = hashlib.file_digest(f, 'sha256').hexdigest()
    if digest != BOOST_SHA256:
        raise RuntimeError(f'Boost archive failed SHA256 verification: {archive}. Remove the corrupt archive before retrying.')
    print('Boost SHA256 verified; extracting with Python...', flush=True)
    with tempfile.TemporaryDirectory(dir=bootstrap, prefix='boost-extract-') as temporary:
        with tarfile.open(archive, 'r:xz') as bundle:
            bundle.extractall(temporary, filter='data')
        extracted = pathlib.Path(temporary) / 'boost-1.82.0'
        if not (extracted / 'CMakeLists.txt').is_file():
            raise RuntimeError('Boost archive is missing its expected CMake project')
        (extracted / marker.name).write_text(BOOST_SHA256 + '\n')
        extracted.replace(source)
    return source


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--build-dir', type=pathlib.Path, default=ROOT / 'build' / 'daq-web')
    p.add_argument('--build-type', choices=['Debug', 'Release', 'RelWithDebInfo'], default='Release')
    p.add_argument('--parallel', type=int, default=min(4, os.cpu_count() or 1))
    a = p.parse_args()
    overrides = []
    if os.name == 'nt':
        if sys.version_info < (3, 12):
            p.error('Windows builds require Python 3.12 or newer for safe archive extraction')
        boost_source = prepare_windows_boost(a.build_dir)
        overrides.append('-DFETCHCONTENT_SOURCE_DIR_BOOST=' + str(boost_source))
    subprocess.run(['cmake', '-S', str(ROOT), '-B', str(a.build_dir),
                    '-DCMAKE_BUILD_TYPE=' + a.build_type,
                    '-DOPENDAQ_BUILD_WEB_APP=ON', '-DDAQMODULES_REF_DEVICE_MODULE=ON',
                    '-DDAQMODULES_REF_FB_MODULE=ON', '-DDAQMODULES_REF_FB_MODULE_ENABLE_RENDERER=OFF',
                    '-DDAQMODULES_OPENDAQ_CLIENT_MODULE=ON', '-DOPENDAQ_ENABLE_NATIVE_STREAMING=ON',
                    '-DOPENDAQ_ENABLE_OPCUA=ON', '-DOPENDAQ_ENABLE_WEBSOCKET_STREAMING=ON',
                    '-DOPENDAQ_ENABLE_UNSTABLE_TEST_LABELS=ON', '-DOPENDAQ_SKIP_UNSTABLE_TESTS=ON',
                    *overrides], check=True)
    subprocess.run(['cmake', '--build', str(a.build_dir), '--config', a.build_type,
                    '--parallel', str(a.parallel), '--target', *TARGETS], check=True)
    print('Build complete. Start server.py with --bridge <build>/bin/daq_web_bridge '
          '(daq_web_bridge.exe on Windows) and --modules <build>/bin.')


if __name__ == '__main__':
    main()
