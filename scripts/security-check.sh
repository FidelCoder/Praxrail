#!/usr/bin/env bash
set -euo pipefail

pnpm audit --audit-level high
pnpm test

if command -v gitleaks >/dev/null; then
  gitleaks detect --redact --no-banner
else
  echo "gitleaks is required for a release security check" >&2
  exit 1
fi

if [[ -n "${PRAXRAIL_IMAGE:-}" ]]; then
  if ! command -v trivy >/dev/null; then
    echo "PRAXRAIL_IMAGE is set but trivy is unavailable" >&2
    exit 1
  fi
  trivy image --severity HIGH,CRITICAL --exit-code 1 "$PRAXRAIL_IMAGE"
fi
