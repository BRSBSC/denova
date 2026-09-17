# syntax=docker/dockerfile:1
FROM debian:bookworm-slim

ARG TARGETARCH
ARG VERSION
ARG SOURCE_REPOSITORY
LABEL org.opencontainers.image.title="Denova" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/${SOURCE_REPOSITORY}" \
      org.opencontainers.image.licenses="Apache-2.0"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       bash ca-certificates curl git python3 python3-bcrypt ripgrep tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 denova \
    && useradd --uid 10001 --gid denova --home-dir /data --shell /bin/bash denova \
    && mkdir -p /data/log \
    && chown -R denova:denova /data

COPY dist/upstream/${TARGETARCH}/denova/ /opt/denova/
COPY docker/entrypoint.py /usr/local/lib/denova-entrypoint.py
RUN chmod 0755 /opt/denova/denova /opt/denova/denova-updater \
    && rm -f /opt/denova/config.toml \
    && ln -s /data/log /opt/denova/log

ENV HOME=/data DENOVA_DIR=/data/.denova \
    DENOVA_SKILLS_DIR=/opt/denova/skills PYTHONDONTWRITEBYTECODE=1 \
    PATH=/opt/denova:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /opt/denova
USER 10001:10001
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:8080/api/auth/status > /dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "python3", "/usr/local/lib/denova-entrypoint.py"]
CMD ["--no-open", "--port", "8080"]
