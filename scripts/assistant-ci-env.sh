#!/usr/bin/env bash
# Prints KEY=value lines for $GITHUB_ENV: which channel this CI run packages for.
#   tag vX.Y.Z    -> stable (the tag must match assistant/VERSION)
#   push to main  -> nightly (also a manual run on main)
#   anything else -> dev (built and tested, never published)
set -euo pipefail
version=$(tr -d '[:space:]' < assistant/VERSION)
if [[ "${GITHUB_REF:-}" == refs/tags/v* ]]; then
  tag=${GITHUB_REF#refs/tags/}
  if [[ "${tag#v}" != "$version" ]]; then
    echo "tag $tag doesn't match assistant/VERSION ($version)" >&2
    exit 1
  fi
  echo "ASSISTANT_CHANNEL=stable"
elif [[ "${GITHUB_REF:-}" == refs/heads/main && "${GITHUB_EVENT_NAME:-}" != pull_request ]]; then
  echo "ASSISTANT_CHANNEL=nightly"
else
  echo "ASSISTANT_CHANNEL=dev"
fi
echo "ASSISTANT_COMMIT=${GITHUB_SHA:-$(git rev-parse HEAD)}"
