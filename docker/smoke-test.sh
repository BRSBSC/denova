#!/usr/bin/env bash
set -euo pipefail

image="${1:?Usage: smoke-test.sh IMAGE PLATFORM VERSION}"
platform="${2:?Platform is required}"
version="${3:?Version is required}"
container=""
scratch="$(mktemp -d)"
cleanup() {
  if [[ -n "${container}" ]]; then
    docker logs "${container}" || true
    docker rm --force --volumes "${container}" >/dev/null || true
  fi
  rm -rf "${scratch}"
}
trap cleanup EXIT

actual_version="$(docker run --rm --platform "${platform}" "${image}" --version)"
[[ "${actual_version}" == "${version#v}" ]]
container="$(docker run --detach --platform "${platform}" \
  --publish 127.0.0.1::8080 \
  --env DENOVA_ADMIN_USERNAME=smoke \
  --env DENOVA_ADMIN_PASSWORD=container-smoke-password \
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
docker restart "${container}" > /dev/null
wait_for_server
after="$(docker exec "${container}" sha256sum /data/.denova/config.toml)"
[[ "${before}" == "${after}" ]]
curl --fail --silent --cookie "${scratch}/cookies" "${base_url}/api/settings" > /dev/null
echo "Container smoke test passed: ${platform} ${version}"
