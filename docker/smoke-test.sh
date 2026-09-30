#!/usr/bin/env bash
set -euo pipefail

image="${1:?Usage: smoke-test.sh IMAGE PLATFORM VERSION}"
platform="${2:?Platform is required}"
version="${3:?Version is required}"
container=""
volume=""
scratch="$(mktemp -d)"
cleanup() {
  if [[ -n "${container}" ]]; then
    docker logs "${container}" || true
    docker rm --force --volumes "${container}" >/dev/null || true
  fi
  if [[ -n "${volume}" ]]; then
    docker volume rm "${volume}" >/dev/null || true
  fi
  rm -rf "${scratch}"
}
trap cleanup EXIT

actual_version="$(docker run --rm --platform "${platform}" "${image}" --version)"
[[ "${actual_version}" == "${version#v}" ]]
volume="$(docker volume create)"
# Reproduce a reused/externally created volume inaccessible to UID 10001.
docker run --rm --platform "${platform}" --user 0:0 \
  --entrypoint /bin/sh --volume "${volume}:/data" "${image}" -c \
  'mkdir -p /data/.denova; chown 0:0 /data/.denova; chmod 0700 /data/.denova'
container="$(docker run --detach --platform "${platform}" \
  --publish 127.0.0.1::8080 \
  --volume "${volume}:/data" \
  --env DENOVA_USERNAME=smoke \
  --env DENOVA_PASSWORD=container-smoke-password \
  "${image}")"

wait_for_server() {
  local address
  address="$(docker port "${container}" 8080/tcp)"
  base_url="http://${address}"
  for attempt in {1..60}; do
    if curl --fail --silent "${base_url}/api/auth/status" > "${scratch}/status.json"; then
      return
    fi
    sleep 2
  done
  echo "Container did not become ready: ${platform}" >&2
  return 1
}

wait_for_server
python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); assert not s["local"] and not s["authenticated"], s' "${scratch}/status.json"
curl --fail --silent "${base_url}/" > "${scratch}/index.html"
grep -qi '<html' "${scratch}/index.html"
[[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "${base_url}/api/settings")" == "401" ]]
curl --fail --silent --cookie-jar "${scratch}/cookies" \
  --header 'Content-Type: application/json' \
  --data '{"username":"smoke","password":"container-smoke-password"}' \
  "${base_url}/api/auth/login" > "${scratch}/login.json"
python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["authenticated"]' "${scratch}/login.json"
curl --fail --silent --cookie "${scratch}/cookies" "${base_url}/api/settings" > /dev/null
before="$(docker exec "${container}" sha256sum /data/.denova/config.toml)"
# Preserve the actual password hash and session data while reproducing the
# reported read failure on an existing private configuration.
docker exec --user 0:0 "${container}" sh -c \
  'chown -R 0:0 /data/.denova; chmod 0700 /data/.denova; chmod 0600 /data/.denova/config.toml'
docker restart "${container}" > /dev/null
wait_for_server
after="$(docker exec --user 10001:10001 "${container}" sha256sum /data/.denova/config.toml)"
[[ "${before}" == "${after}" ]]
curl --fail --silent --cookie "${scratch}/cookies" "${base_url}/api/settings" > /dev/null
docker exec --user 0:0 "${container}" python3 -c '
from pathlib import Path
uids = []
for comm in Path("/proc").glob("[0-9]*/comm"):
    try:
        if comm.read_text().strip() == "denova":
            status = comm.with_name("status").read_text().splitlines()
            uids.append(next(line.split()[1:] for line in status if line.startswith("Uid:")))
    except FileNotFoundError:
        pass
assert uids == [["10001"] * 4], uids
'
echo "Container smoke test passed: ${platform} ${version}"
