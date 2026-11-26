# deploy/data-host/Dockerfile: the CLICS data host's PostgreSQL (ADR 0012, #432): PostgreSQL 18.7 with
# pgvector 0.8.7. Production's `vector` is 0.8.0, which does not build on PostgreSQL 18 (0.8.1 added it);
# 0.8.7 is the 0.8 line's latest, with its buffer-overflow and HNSW-corruption fixes. The move creates the
# extension fresh and carries vectors as text, so the version step changes no value. Built on the data
# host (cme-dev), so the binary matches its CPU; no `-march=native`, so it also runs on another x86-64 or
# arm64 host.
#
#   docker compose -p clics-data -f docker-compose.yml build
#
# Both inputs are pinned: the base image by digest (postgres:18.7, Debian trixie) and pgvector by the
# commit its v0.8.7 tag points at. The build stops if the tag has moved.
ARG PG_IMAGE=postgres:18.7@sha256:f5cbc081c25690710f3fc6f4c61a7565382bae01ca0d0f2028a53d7926b85a20

FROM ${PG_IMAGE} AS build
ARG PGVECTOR_TAG=v0.8.7
ARG PGVECTOR_COMMIT=f37c13f68b57d2c3472b2214fbcff699d6d34876
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git build-essential "postgresql-server-dev-${PG_MAJOR}" \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --branch "${PGVECTOR_TAG}" --depth 1 https://github.com/pgvector/pgvector.git /src/pgvector \
 && test "$(git -C /src/pgvector rev-parse HEAD)" = "${PGVECTOR_COMMIT}" \
 && make -C /src/pgvector OPTFLAGS="" \
 && make -C /src/pgvector OPTFLAGS="" install DESTDIR=/out

FROM ${PG_IMAGE}
COPY --from=build /out/usr/lib/postgresql/ /usr/lib/postgresql/
COPY --from=build /out/usr/share/postgresql/ /usr/share/postgresql/
LABEL org.clics.pgvector="0.8.7" org.clics.pgvector-commit="f37c13f68b57d2c3472b2214fbcff699d6d34876"
