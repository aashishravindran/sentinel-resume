#!/usr/bin/env bash
# Builds build/lambda: sentinel_resume plus sentinel-engine, pyjwt and a current boto3
# (for S3 Vectors), as arm64 manylinux wheels for the Python 3.14 Lambda runtime. No Docker.
#
#   ./scripts/build_lambda.sh                         # ../sentinel-engine if present, else the tag
#   SENTINEL_ENGINE_REF=v0.2.0 ./scripts/build_lambda.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/build/lambda"
WHEELS="${ROOT}/build/wheels"
ENGINE_DIR="${SENTINEL_ENGINE_DIR:-${ROOT}/../sentinel-engine}"
ENGINE_REF="${SENTINEL_ENGINE_REF:-v0.1.0}"

rm -rf "${OUT}" "${WHEELS}" "${ROOT}/build/sentinel-engine"
mkdir -p "${OUT}" "${WHEELS}"

if [[ ! -d "${ENGINE_DIR}" ]]; then
  ENGINE_DIR="${ROOT}/build/sentinel-engine"
  git clone --quiet --depth 1 --branch "${ENGINE_REF}" \
    https://github.com/aashishravindran/sentinel-engine "${ENGINE_DIR}"
fi
uv build --quiet --wheel --out-dir "${WHEELS}" "${ENGINE_DIR}"

uv pip install \
  --quiet \
  --target "${OUT}" \
  --python-platform aarch64-manylinux2014 \
  --python-version 3.14 \
  --only-binary :all: \
  "sentinel-engine @ file://$(ls "${WHEELS}"/sentinel_engine-*.whl)" \
  "boto3>=1.42"

cp -R "${ROOT}/sentinel_resume" "${OUT}/"
find "${OUT}" -name "__pycache__" -prune -exec rm -rf {} +

echo "Built ${OUT} ($(du -sh "${OUT}" | cut -f1))"
