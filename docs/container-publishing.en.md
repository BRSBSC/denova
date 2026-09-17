# Upstream releases and GHCR images

This fork checks the latest stable `alfredxw/denova` release at minute 23 of every hour (UTC) through `.github/workflows/sync-upstream-release.yml`. Scheduled runs may be delayed. Only `vMAJOR.MINOR.PATCH` releases are accepted; prereleases are excluded. The workflow does not merge upstream branches.

## Enable publishing

1. Push these changes to the default `master` branch of `BRSBSC/denova`.
2. Enable workflows in the fork's **Actions** tab. If the initial push did not start a run, select **Sync upstream release and publish GHCR → Run workflow**.
3. Allow `contents: write` and `packages: write` for the built-in `GITHUB_TOKEN`. No separate PAT is needed. Organization restrictions may require administrator changes. If the GHCR package already exists, grant this repository access under the package's Actions access settings.
4. After the first publication, check **Packages → denova → Package settings**. Set visibility to Public for anonymous pulls; a public source repository does not guarantee a public package.
5. Check the Actions logs and Summary for successful image and Release publication. GitHub may disable scheduled workflows in inactive public repositories; re-enable them in Actions when needed.

Images are published as `ghcr.io/brsbsc/denova:v0.4.5` (example) and `ghcr.io/brsbsc/denova:latest`, supporting `linux/amd64` and `linux/arm64`. The publishing job is restricted to `BRSBSC/denova`. Other forks must adjust the repository condition and Compose image address.

## Publication and retries

- Download all upstream Release assets and verify every Denova archive against `checksums.txt`. Missing Linux architectures, checksum failures, or unsafe archive paths stop publication.
- Package the released Linux bundles without recompiling the application. Preserve the frontend, Skills, updater, and license. Add Bash, Git, curl, Python, and ripgrep. Additional language toolchains or external Agent CLIs require an extended image.
- Build and test both architectures: version, HTTP frontend, rejection of unauthenticated access, login, settings access, and configuration/session persistence after restart. Push the version image only after these tests pass.
- Keep the upstream version as the Release title, using an `upstream-vMAJOR.MINOR.PATCH` tag on this workflow's commit. Image tags remain `vMAJOR.MINOR.PATCH`. This avoids additional permissions for importing upstream workflows and does not trigger the existing `v*` source-release workflow. GitHub-generated Source code archives contain the fork's packaging configuration; use the linked upstream release for application source. Existing Releases without this workflow's ownership marker are never overwritten.
- Promote the tested version image to `latest` only if it is still the latest upstream stable release. Publish the mirrored Release with a completion marker last. Failures leave no success marker and can be retried; a draft Release or version image may remain.
- GHCR and GitHub Releases cannot be committed atomically. If the final Release publication fails, `latest` may already reference the tested image; the next retry completes the Release.
- Scheduled runs process only the current latest release, not all historical releases. Enter a manual `tag` to backfill a version. Enable `force` to rebuild a completed version. Pushing container or synchronization changes to `master` also rebuilds the latest version.
- Mirrored attachments remain byte-for-byte upstream files, including upstream download URLs in the installer. Synchronization adds files or replaces matching names; it does not automatically delete previously archived attachments. Completion markers track the Release ID and asset IDs, sizes, and update times; replaced upstream assets trigger processing again. Images use only the Linux bundles downloaded and verified in the current run.

The entire pipeline runs in one workflow and does not rely on a tag triggering another workflow.

## Run the container

Create `docker/.env` (ignored by Git) with initial credentials:

```dotenv
DENOVA_ADMIN_USERNAME=admin
DENOVA_ADMIN_PASSWORD=replace-with-your-own-password
DENOVA_IMAGE_TAG=latest
```

Passwords must contain 1–72 UTF-8 bytes. From the repository root, in either PowerShell or Bash:

```sh
docker compose --env-file docker/.env -f docker/compose.yml up -d
```

Open `http://localhost:8080` and sign in. Compose publishes only on the host loopback address by default. Use `8080:8080` for LAN access, and an HTTPS reverse proxy for internet access.

The container runs as UID/GID `10001:10001`. The `denova-data` named volume persists `/data`, including application data in `/data/.denova` and logs in `/data/log`. Host bind mounts must be writable by that UID. External Projects require additional mounts; the named volume does not include arbitrary host files.

The first startup writes network settings and a bcrypt password hash only when no user `config.toml` exists. Existing settings are never replaced. Environment credentials initialize a new volume only; change subsequent passwords through application settings. Imported configurations must enable `allow_lan_access` and provide `remote_access_username` and `remote_access_password_hash`. Disabling LAN access in the application makes the container port unreachable.

Upgrade by replacing the container while keeping its data volume. Do not use the in-app updater to modify image binaries. Do not run `down -v`, which deletes the volume.

```sh
docker compose --env-file docker/.env -f docker/compose.yml pull
docker compose --env-file docker/.env -f docker/compose.yml up -d
```

To roll back, select an earlier `DENOVA_IMAGE_TAG` and recreate the container. Back up the data volume before upgrades: rolling back an image does not reverse data migrations.

## Validation

```sh
python -B -m unittest discover -s scripts -p test_sync_upstream_release.py
python -B -m unittest discover -s docker -p test_entrypoint.py
bash -n docker/smoke-test.sh
```

The publishing workflow performs actual builds and smoke tests with isolated volumes for both architectures. It does not use development services, real model credentials, or user data. Pull requests run script tests and syntax checks only; they do not publish images.

References: [GitHub Container registry permissions and visibility](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry), [Docker multi-platform builds](https://docs.docker.com/build/building/multi-platform/), [GitHub scheduled events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
