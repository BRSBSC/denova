"""Initialize a new container data volume without replacing existing settings."""

import json
import os
from pathlib import Path
import sys
import tempfile
import tomllib


def password_hash(password):
    import bcrypt
    encoded = password.encode("utf-8")
    if not encoded or len(encoded) > 72:
        raise ValueError("DENOVA_PASSWORD must contain 1 to 72 UTF-8 bytes")
    return bcrypt.hashpw(encoded, bcrypt.gensalt(rounds=12)).decode("ascii")


def initialize_config(target):
    if target.exists():
        settings = tomllib.loads(target.read_text(encoding="utf-8"))
        if not settings.get("allow_lan_access"):
            raise ValueError("Existing config.toml must enable allow_lan_access for container networking")
        if not settings.get("remote_access_username") or not settings.get("remote_access_password_hash"):
            raise ValueError("Existing config.toml must contain remote access credentials")
        return
    username = os.environ.get("DENOVA_USERNAME", "").strip()
    password = os.environ.get("DENOVA_PASSWORD", "")
    if not username or not password:
        raise ValueError("Set DENOVA_USERNAME and DENOVA_PASSWORD for the first start")
    hashed = password_hash(password)
    content = ("allow_lan_access = true\n"
               f"remote_access_username = {json.dumps(username, ensure_ascii=False)}\n"
               f"remote_access_password_hash = {json.dumps(hashed)}\n")
    target.parent.mkdir(parents=True, exist_ok=True)
    # Link a complete private file atomically; never truncate existing user data.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, target)
    finally:
        if temporary is not None:
            temporary.unlink()
    print("Initialized container access settings", flush=True)


def main():
    if "--version" not in sys.argv[1:] and "-version" not in sys.argv[1:]:
        data = Path(os.environ.get("DENOVA_DIR", "/data/.denova"))
        initialize_config(data / "config.toml")
        Path("/data/log").mkdir(parents=True, exist_ok=True)
    # Do not expose bootstrap credentials to Agent child processes.
    os.environ.pop("DENOVA_USERNAME", None)
    os.environ.pop("DENOVA_PASSWORD", None)
    os.execv("/opt/denova/denova", ["denova", *sys.argv[1:]])


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        raise SystemExit(f"Container initialization failed: {error}") from error
