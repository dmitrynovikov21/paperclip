#!/usr/bin/env python3
"""List process IDs, elapsed time, and executable names without full argv."""

import subprocess
import sys


def main():
    if len(sys.argv) != 1:
        print("process helper accepts no arguments", file=sys.stderr)
        return 2
    result = subprocess.run(["ps", "-eo", "pid,etime,comm"], capture_output=True, check=False)
    if result.returncode:
        print(f"ps failed with status {result.returncode}", file=sys.stderr)
        return result.returncode
    sys.stdout.buffer.write(result.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
