"""Run the same HTTP /rank integration in both transports, in isolated data stores."""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
for mode in ('broker', 'direct'):
    subprocess.run([sys.executable, 'tests/run_queue_integration.py', '--bridge', mode], cwd=root, check=True)
