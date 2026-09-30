#!/bin/sh
set -eu

# Mounted volumes can retain root-owned private files from an earlier image.
# Prepare only Denova's managed data and logs, then drop privileges before
# reading settings or starting the application and its Agent child processes.
if [ "$(id -u)" = "0" ]; then
    for argument do
        case "${argument}" in
            --version|-version)
                exec gosu 10001:10001 python3 /usr/local/lib/denova-entrypoint.py "$@"
                ;;
        esac
    done

    requested_data_dir="${DENOVA_DIR:-/data/.denova}"
    data_dir="$(realpath -m -- "${requested_data_dir}")"
    if [ "$(realpath -ms -- "${requested_data_dir}")" != "${data_dir}" ]; then
        echo "Container data preparation failed: DENOVA_DIR must not contain symbolic links" >&2
        exit 1
    fi
    case "${data_dir}" in
        /data/*) ;;
        *)
            echo "Container data preparation failed: DENOVA_DIR must resolve inside /data" >&2
            exit 1
            ;;
    esac
    if [ -L /data/log ]; then
        echo "Container data preparation failed: /data/log must not be a symbolic link" >&2
        exit 1
    fi
    mkdir -p -- "${data_dir}" /data/log
    # A nested DENOVA_DIR also needs traversable parent directories. Adjust
    # only the path itself, leaving sibling directories and their contents alone.
    parent_dir="$(dirname -- "${data_dir}")"
    while [ "${parent_dir}" != "/data" ]; do
        chown --no-dereference 10001:10001 "${parent_dir}"
        parent_dir="$(dirname -- "${parent_dir}")"
    done
    chown --no-dereference 10001:10001 /data
    find "${data_dir}" /data/log -xdev \( ! -uid 10001 -o ! -gid 10001 \) \
        -exec chown --no-dereference 10001:10001 {} +
    echo "Prepared container data ownership for UID/GID 10001:10001"
    exec gosu 10001:10001 python3 /usr/local/lib/denova-entrypoint.py "$@"
fi

# An explicit non-root --user override requires a writable mounted volume.
exec python3 /usr/local/lib/denova-entrypoint.py "$@"
