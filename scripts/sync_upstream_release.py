"""Mirror a verified upstream release and prepare its Linux bundles for Buildx.

Run prepare before building, then finish only after publishing the tested image.
GITHUB_TOKEN needs contents/packages write on the destination repository only.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
from urllib.parse import quote

UPSTREAM = "alfredxw/denova"
ORIGIN_MARKER = f"<!-- denova-mirror: {UPSTREAM} -->"


def run(*args):
    return subprocess.run(args, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()


def api(endpoint):
    return json.loads(run("gh", "api", endpoint))


def find_release(repo, tag):
    try:
        return api(f"repos/{repo}/releases/tags/{quote(tag, safe='')}")
    except subprocess.CalledProcessError as error:
        if "(HTTP 404)" in error.stderr:
            # The tag endpoint may omit drafts. Recover a previous partial run
            # through the authenticated release listing before creating anything.
            pages = json.loads(run("gh", "api", "--paginate", "--slurp", f"repos/{repo}/releases?per_page=100"))
            return next((release for page in pages for release in page if release["tag_name"] == tag), None)
        raise


def validate_release(release):
    if release.get("draft") or release.get("prerelease"):
        raise ValueError("Only published stable releases are supported")
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", release["tag_name"]):
        raise ValueError("Expected a stable vMAJOR.MINOR.PATCH tag")


def completion_marker(release):
    facts = {"id": release["id"], "tag": release["tag_name"], "assets": [
        {key: asset[key] for key in ("id", "name", "size", "updated_at")}
        for asset in sorted(release["assets"], key=lambda asset: asset["name"])
    ]}
    digest = hashlib.sha256(json.dumps(facts, sort_keys=True).encode()).hexdigest()
    return f"<!-- denova-mirror-complete: {digest} -->"


def is_complete(release, mirror, force):
    return bool(not force and mirror and not mirror["draft"] and completion_marker(release) in (mirror.get("body") or ""))


def verify_assets(directory):
    checksums = {}
    for line in (directory / "checksums.txt").read_text().splitlines():
        match = re.fullmatch(r"([0-9a-fA-F]{64}) [ *]([^/\\]+)", line)
        if not match or match[2] in checksums or match[2] in (".", ".."):
            raise ValueError("Invalid or duplicate checksum entry")
        checksums[match[2]] = match[1].lower()
    archives = list(directory.glob("denova-*.tar.gz")) + list(directory.glob("denova-*.zip"))
    if not archives:
        raise ValueError("No release archives found")
    for archive in archives:
        if archive.name not in checksums:
            raise ValueError(f"Missing checksum: {archive.name}")
        with archive.open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if actual != checksums[archive.name]:
            raise ValueError(f"Checksum mismatch: {archive.name}")


def extract_bundle(archive, destination):
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle.getmembers():
            path = PurePosixPath(member.name)
            if (path.is_absolute() or ".." in path.parts or "\\" in member.name
                    or not path.parts or path.parts[0] != "denova"
                    or not (member.isfile() or member.isdir())):
                raise ValueError(f"Unsafe archive member: {member.name}")
        bundle.extractall(destination, filter="data")


def prepare(args):
    release = (find_release(UPSTREAM, args.tag) if args.tag else api(f"repos/{UPSTREAM}/releases/latest"))
    if release is None:
        raise ValueError("Upstream release does not exist")
    validate_release(release)
    tag = release["tag_name"]
    mirror_tag = f"upstream-{tag}"
    mirror = find_release(args.repository, mirror_tag)
    if mirror and ORIGIN_MARKER not in (mirror.get("body") or ""):
        raise ValueError(f"Destination release {tag} is not managed by this workflow; refusing to overwrite it")
    outputs = {"changed": "false", "version": tag, "image": f"ghcr.io/{args.repository.lower()}"}
    if not is_complete(release, mirror, args.force):
        if args.force and mirror:
            # Clear only our completion marker so an interrupted rebuild can be
            # retried by the next scheduled run, including unchanged upstream assets.
            args.directory.mkdir(parents=True, exist_ok=True)
            notes = args.directory / "retry-notes.md"
            notes.write_text(re.sub(r"<!-- denova-mirror-complete: [0-9a-f]{64} -->", "", mirror.get("body") or ""), encoding="utf-8")
            run("gh", "release", "edit", mirror_tag, "--repo", args.repository, "--notes-file", str(notes))
        assets = args.directory / "assets"
        assets.mkdir(parents=True, exist_ok=False)
        run("gh", "release", "download", tag, "--repo", UPSTREAM, "--dir", str(assets))
        verify_assets(assets)
        for architecture, package in (("amd64", "x64"), ("arm64", "arm64")):
            extract_bundle(assets / f"denova-{tag}-linux-{package}.tar.gz", args.directory / architecture)
            root = args.directory / architecture / "denova"
            for required in ("denova", "denova-updater", "web/index.html", "LICENSE"):
                if not (root / required).is_file():
                    raise ValueError(f"Missing bundle file: {architecture}/{required}")
            if not (root / "skills").is_dir():
                raise ValueError(f"Missing bundled Skills: {architecture}")
        # Persist the exact asset identity used by this run, not a moving latest.
        (args.directory / "release.json").write_text(json.dumps(release), encoding="utf-8")
        outputs["changed"] = "true"
    print(json.dumps(outputs))
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.writelines(f"{key}={value}\n" for key, value in outputs.items())


def finish(args):
    release = json.loads((args.directory / "release.json").read_text(encoding="utf-8"))
    validate_release(release)
    tag = release["tag_name"]
    current = find_release(UPSTREAM, tag)
    if current is None or completion_marker(current) != completion_marker(release):
        raise ValueError("Upstream assets changed during this run; retry with fresh assets")
    validate_release(current)
    mirror_tag = f"upstream-{tag}"
    mirror = find_release(args.repository, mirror_tag)
    if mirror and ORIGIN_MARKER not in (mirror.get("body") or ""):
        raise ValueError("Refusing to overwrite an unmanaged destination release")
    image = f"ghcr.io/{args.repository.lower()}"
    body = (f"Mirrored from https://github.com/{UPSTREAM}/releases/tag/{tag}\n\n"
            f"Container: `{image}:{tag}`\n\n"
            "Attached installers are upstream binaries. GitHub-generated Source code archives "
            "contain this fork's packaging workflow; use the upstream release for application source.\n\n"
            f"{ORIGIN_MARKER}\n\n{release.get('body') or ''}\n")
    notes = args.directory / "mirror-notes.md"
    notes.write_text(body, encoding="utf-8")
    if mirror is None:
        # A separate tag on the workflow commit avoids importing upstream workflow
        # changes (which GITHUB_TOKEN cannot write) and avoids v* release triggers.
        revision = run("git", "rev-parse", "HEAD")
        run("gh", "release", "create", mirror_tag, "--repo", args.repository, "--target", revision, "--draft", "--title", tag, "--notes-file", str(notes))
    files = sorted(str(path) for path in (args.directory / "assets").iterdir() if path.is_file())
    run("gh", "release", "upload", mirror_tag, *files, "--repo", args.repository, "--clobber")
    latest = api(f"repos/{UPSTREAM}/releases/latest")
    is_latest = latest["id"] == release["id"]
    if is_latest:
        run("docker", "buildx", "imagetools", "create", "--tag", f"{image}:latest", f"{image}:{tag}")
    notes.write_text(body + "\n" + completion_marker(release) + "\n", encoding="utf-8")
    run("gh", "release", "edit", mirror_tag, "--repo", args.repository, "--draft=false", f"--latest={str(is_latest).lower()}", "--notes-file", str(notes))
    print(f"Published mirrored release {tag} and {image}:{tag}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("prepare", "finish"))
    parser.add_argument("--repository", required=True)
    parser.add_argument("--tag", default="")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--directory", type=Path, default=Path("dist/upstream"))
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repository) or args.repository.lower() == UPSTREAM.lower():
        parser.error("Destination must be a fork, not the upstream repository")
    if args.tag and not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", args.tag):
        parser.error("Expected a stable vMAJOR.MINOR.PATCH tag")
    try:
        (prepare if args.phase == "prepare" else finish)(args)
    except subprocess.CalledProcessError as error:
        raise SystemExit(f"Command failed: {error.stderr.strip()}") from error


if __name__ == "__main__":
    main()
