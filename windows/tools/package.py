"""Package the Windows Release build and its self-contained project source."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import zipfile
from pe_resource import read_resource

ROOT = Path(__file__).resolve().parents[2]
BINARY_FILES = ("Visual-SPC-Player.exe",)
SOURCE_TREES = (".github", "windows", "native", "src", "scripts", "tests", "docs", "public", "LICENSES")
SOURCE_FILES = (
    "README.md", "LICENSE", "NOTICE.md", "CONTRIBUTING.md", ".gitignore",
    ".gitattributes", "package.json", "pnpm-lock.yaml", "tsconfig.json",
    "tsconfig.app.json", "tsconfig.node.json", "vite.config.ts", "index.html",
)
EXCLUDED_SUFFIXES = {".spc", ".wav", ".pcm", ".log", ".zip", ".exe", ".dll", ".obj", ".lib", ".pdb", ".wasm"}


def source_files():
    for name in SOURCE_FILES:
        path = ROOT / name
        if path.is_file():
            yield path
    for name in SOURCE_TREES:
        tree = ROOT / name
        for directory, dirs, files in os.walk(tree, followlinks=False):
            current = Path(directory)
            relative = current.relative_to(ROOT)
            dirs[:] = sorted(d for d in dirs if d not in {".git", ".local", "node_modules", "__pycache__"}
                             and not (relative == Path("native") and d.startswith("build"))
                             and not (relative == Path("windows") and d == "out")
                             and not (current / d).is_symlink())
            for filename in sorted(files):
                path = current / filename
                if not path.is_symlink() and path.suffix.lower() not in EXCLUDED_SUFFIXES:
                    yield path


def archive(destination, entries):
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as output:
        for path, name in sorted(entries, key=lambda entry: entry[1]):
            if name.startswith("/") or ".." in Path(name).parts:
                raise RuntimeError("Unsafe archive path")
            info = zipfile.ZipInfo(name.replace("\\", "/"), date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            output.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--build-dir", type=Path, default=ROOT / "windows/out/x64-release")
    parser.add_argument("--output", type=Path, default=ROOT / "release")
    args = parser.parse_args()
    build = args.build_dir.resolve()
    cache = (build / "CMakeCache.txt").read_text(encoding="utf-8")
    if "CMAKE_BUILD_TYPE:STRING=Release" not in cache:
        raise RuntimeError("Package a Release configuration")
    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise RuntimeError("Use a numeric project version")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    stage = output / "windows-x64"
    subprocess.run(["cmake", "--install", str(build), "--prefix", str(stage)], check=True)
    actual = {p.relative_to(stage).as_posix() for p in stage.rglob("*") if p.is_file()}
    if actual != set(BINARY_FILES):
        raise RuntimeError(f"Unexpected installed files: {actual.symmetric_difference(BINARY_FILES)}")
    binary = output / f"Visual-SPC-Player-{version}-windows-x64.zip"
    source = output / f"Visual-SPC-Player-{version}-windows-source.zip"
    entries = [(path, path.relative_to(ROOT).as_posix()) for path in source_files()]
    required = {"windows/CMakeLists.txt", "native/desktop_api.cpp", "windows/vendor/imgui/imgui.cpp",
                "windows/vendor/json/json.hpp", "windows/tests/fixtures/metrics.bin",
                "windows/src/model/PaletteTables.h", "docs/windows.md"}
    if not required.issubset({name for _, name in entries}):
        raise RuntimeError("Source archive is incomplete")
    embedded = build / "embedded/Visual-SPC-Player-source.zip"
    installed = stage / "Visual-SPC-Player.exe"
    embedded_data = read_resource(installed, 207)
    if embedded_data != embedded.read_bytes():
        raise RuntimeError("Rebuild the application: executable source resource differs from the build bundle")
    text_resources = {201: "windows/resources/README.txt", 202: "windows/resources/THIRD-PARTY-NOTICES.txt",
                      203: "LICENSE", 204: "LICENSES/LGPL-2.1.txt", 205: "windows/vendor/imgui/LICENSE.txt",
                      206: "windows/vendor/json/LICENSE.MIT", 208: "windows/resources/BUILDING.txt"}
    for identifier, name in text_resources.items():
        if read_resource(installed, identifier) != (ROOT / name).read_bytes():
            raise RuntimeError(f"Rebuild the application: executable text is stale: {name}")
    with zipfile.ZipFile(io.BytesIO(embedded_data)) as included:
        if set(included.namelist()) != {name for _, name in entries}:
            raise RuntimeError("Rebuild the executable: embedded source file list is stale")
        for path, name in entries:
            if included.read(name) != path.read_bytes():
                raise RuntimeError(f"Rebuild the executable: embedded source is stale: {name}")
    archive(binary, [(stage / name, name) for name in BINARY_FILES])
    source.write_bytes(embedded_data)
    executable = output / "Visual-SPC-Player.exe"
    executable.write_bytes((stage / "Visual-SPC-Player.exe").read_bytes())
    checksums = "".join(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n" for path in (executable, binary, source))
    (output / "SHA256SUMS").write_text(checksums, encoding="ascii", newline="\n")
    print(binary)
    print(source)


if __name__ == "__main__":
    main()
