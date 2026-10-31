#!/usr/bin/env python3
"""Read-only bounded-interval status until controller completion."""
import subprocess,sys,time
from pathlib import Path
root=Path(__file__).resolve().parent
while True:
 subprocess.run([sys.executable,str(root/'status.py')],check=True)
 if (root/'results/controller-result.json').exists():break
 time.sleep(50)
