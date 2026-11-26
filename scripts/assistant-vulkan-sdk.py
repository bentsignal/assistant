#!/usr/bin/env python3
"""Fetches the LunarG Vulkan SDK for Windows into a folder, without running its installer.

The installer (Qt Installer Framework) refuses to run unelevated from a command line, so this
downloads it, checks its SHA-256 against LunarG's files.json, and unpacks the SDK's own 7z
archives from inside it with 7-Zip: Bin (glslc), Include, Lib (vulkan-1.lib), share, Source.
It sets nothing system-wide; point VULKAN_SDK at the folder (docs/dev-setup.md).

    python scripts/assistant-vulkan-sdk.py <version> <dest> [--7z <7z.exe>] [--cache <dir>]
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import urllib.request

SIGNATURE = b"7z\xbc\xaf\x27\x1c"
WANTED = {"Bin", "Include", "Lib", "share", "Source", "Config", "README.txt"}


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch(url, dest):
    request = urllib.request.Request(url, headers={"User-Agent": "assistant-build"})
    with urllib.request.urlopen(request) as response, open(dest + ".part", "wb") as out:
        shutil.copyfileobj(response, out)
    os.replace(dest + ".part", dest)


def expected_hash(version):
    """LunarG's published SHA-256 for the Windows x64 installer, if it lists one."""
    try:
        request = urllib.request.Request(
            "https://vulkan.lunarg.com/sdk/files.json", headers={"User-Agent": "assistant-build"}
        )
        with urllib.request.urlopen(request) as response:
            files = json.load(response)
        for entry in files.get("windows", {}).get(version, {}).get("files", []):
            if entry.get("file_name", "").startswith("vulkansdk-windows-X64"):
                return entry.get("sha")
    except Exception as error:  # noqa: BLE001 - the hash is a check, not the download
        print(f"note: no published hash ({error})", file=sys.stderr)
    return None


def carve(installer, out_dir):
    """Writes each complete 7z archive embedded in the installer to out_dir."""
    data = open(installer, "rb").read()
    parts = []
    for match in re.finditer(re.escape(SIGNATURE), data):
        start = match.start()
        if start + 32 > len(data):
            continue
        next_offset, next_size = struct.unpack("<QQ", data[start + 12 : start + 28])
        end = start + 32 + next_offset + next_size
        if next_offset == 0 or end > len(data) or next_size > 50_000_000:
            continue
        path = os.path.join(out_dir, f"part{len(parts):02d}.7z")
        with open(path, "wb") as file:
            file.write(data[start:end])
        parts.append(path)
    return parts


def top_level(seven_zip, archive):
    listing = subprocess.run([seven_zip, "l", "-slt", archive], capture_output=True, text=True)
    names = set()
    for line in listing.stdout.splitlines():
        if line.startswith("Path = ") and not line.endswith(".7z"):
            names.add(re.split(r"[\\/]", line[7:])[0])
    return names


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("version")
    parser.add_argument("dest")
    parser.add_argument("--7z", dest="seven_zip", default=shutil.which("7z") or "7z")
    parser.add_argument("--cache", default=tempfile.gettempdir())
    args = parser.parse_args()
    if os.path.isfile(os.path.join(args.dest, "Lib", "vulkan-1.lib")):
        print(f"Vulkan SDK already in {args.dest}")
        return
    name = f"vulkansdk-windows-X64-{args.version}.exe"
    installer = os.path.join(args.cache, name)
    if not os.path.isfile(installer):
        print(f"downloading {name}")
        fetch(f"https://sdk.lunarg.com/sdk/download/{args.version}/windows/{name}", installer)
    want = expected_hash(args.version)
    got = sha256(installer)
    if want and want.lower() != got:
        os.remove(installer)
        sys.exit(f"{name}: SHA-256 {got} isn't LunarG's {want}")
    print(f"{name}: sha256 {got}{' (matches LunarG)' if want else ''}")
    with tempfile.TemporaryDirectory() as work:
        parts = carve(installer, work)
        if not parts:
            sys.exit("found no SDK archives in the installer")
        for part in parts:
            if top_level(args.seven_zip, part) & WANTED:
                subprocess.run(
                    [args.seven_zip, "x", "-y", f"-o{args.dest}", part],
                    check=True,
                    stdout=subprocess.DEVNULL,
                )
    for needed in ("Lib/vulkan-1.lib", "Bin/glslc.exe", "Include/vulkan/vulkan.h"):
        if not os.path.isfile(os.path.join(args.dest, needed)):
            sys.exit(f"the SDK in {args.dest} has no {needed}")
    print(f"Vulkan SDK {args.version} in {args.dest}")


if __name__ == "__main__":
    main()
