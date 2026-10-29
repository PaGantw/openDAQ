#!/usr/bin/env python3
"""Build the SDK and browser workstation bridge without requiring Python bindings."""
import argparse
import os
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[3]
TARGETS = ['daq_web_bridge', 'ref_device_module', 'ref_fb_module',
           'native_stream_cl_module', 'opcua_client_module', 'ws_stream_cl_module']


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--build-dir', type=pathlib.Path, default=ROOT / 'build' / 'daq-web')
    p.add_argument('--build-type', choices=['Debug', 'Release', 'RelWithDebInfo'], default='Release')
    p.add_argument('--parallel', type=int, default=min(4, os.cpu_count() or 1))
    a = p.parse_args()
    subprocess.run(['cmake', '-S', str(ROOT), '-B', str(a.build_dir),
                    '-DCMAKE_BUILD_TYPE=' + a.build_type,
                    '-DOPENDAQ_BUILD_WEB_APP=ON', '-DDAQMODULES_REF_DEVICE_MODULE=ON',
                    '-DDAQMODULES_REF_FB_MODULE=ON', '-DDAQMODULES_REF_FB_MODULE_ENABLE_RENDERER=OFF',
                    '-DDAQMODULES_OPENDAQ_CLIENT_MODULE=ON', '-DOPENDAQ_ENABLE_NATIVE_STREAMING=ON',
                    '-DOPENDAQ_ENABLE_OPCUA=ON', '-DOPENDAQ_ENABLE_WEBSOCKET_STREAMING=ON',
                    '-DOPENDAQ_ENABLE_UNSTABLE_TEST_LABELS=ON', '-DOPENDAQ_SKIP_UNSTABLE_TESTS=ON'], check=True)
    subprocess.run(['cmake', '--build', str(a.build_dir), '--config', a.build_type,
                    '--parallel', str(a.parallel), '--target', *TARGETS], check=True)
    print('Build complete. Start server.py with --bridge <build>/bin/daq_web_bridge '
          '(daq_web_bridge.exe on Windows) and --modules <build>/bin.')


if __name__ == '__main__':
    main()
