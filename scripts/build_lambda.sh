#!/usr/bin/env bash
# Builds build/lambda: sentinel_resume plus exactly the runtime dependencies pinned in uv.lock
# (sentinel-authz, boto3, pyjwt, ...), as arm64 manylinux wheels for the Python 3.14 Lambda
# runtime. No Docker. What ships is what CI audited.
#
#   ./scripts/build_lambda.sh
#   SENTINEL_ENGINE_DIR=../sentinel-engine ./scripts/build_lambda.sh   # try a local engine checkout
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/build/lambda"
WHEELS="${ROOT}/build/wheels"
REQS="${ROOT}/build/requirements-lambda.txt"

rm -rf "${OUT}" "${WHEELS}"
mkdir -p "${OUT}" "${WHEELS}"

# Runtime dependencies only, at the locked versions.
(cd "${ROOT}" && uv export --quiet --frozen --no-dev --no-emit-project --no-hashes --no-annotate) \
  | grep -v '^ *#' > "${REQS}"

ENGINE=()
if [[ -n "${SENTINEL_ENGINE_DIR:-}" ]]; then
  # Local engine for co-development: replaces the locked sentinel-authz.
  uv build --quiet --wheel --out-dir "${WHEELS}" "${SENTINEL_ENGINE_DIR}"
  grep -v '^sentinel-authz==' "${REQS}" > "${REQS}.tmp" && mv "${REQS}.tmp" "${REQS}"
  ENGINE=("sentinel-authz @ file://$(ls "${WHEELS}"/sentinel_authz-*.whl)")
fi

uv pip install \
  --quiet \
  --target "${OUT}" \
  --python-platform aarch64-manylinux2014 \
  --python-version 3.14 \
  --only-binary :all: \
  -r "${REQS}" \
  ${ENGINE[@]+"${ENGINE[@]}"}

cp -R "${ROOT}/sentinel_resume" "${OUT}/"
# Titles and GitHub links of the public design docs, for the documents page (stdlib only).
(cd "${ROOT}" && python3 -m sentinel_resume.library "${OUT}/sentinel_resume/library_index.json")
find "${OUT}" -name "__pycache__" -prune -exec rm -rf {} +

echo "Built ${OUT} ($(du -sh "${OUT}" | cut -f1))"
