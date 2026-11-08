"""Create the exact source bundle embedded in the native application."""
import argparse
from pathlib import Path
import tempfile
from package import archive, source_files, ROOT

parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True, type=Path)
args = parser.parse_args()
args.output.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="visual-spc-source-") as temporary:
    candidate = Path(temporary) / "source.zip"
    archive(candidate, [(path, path.relative_to(ROOT).as_posix()) for path in source_files()])
    data = candidate.read_bytes()
    if not args.output.exists() or args.output.read_bytes() != data:
        args.output.write_bytes(data)
