#!/usr/bin/env sh
#
# Materialise the Fireblocks RSA signing key from an environment variable.
#
# DigitalOcean App Platform has no file mounts, but the Fireblocks SDK wants a
# path. The key is passed as base64 in FIREBLOCKS_SECRET_KEY_B64 and written
# here at boot, mode 0600, outside the image layers.
#
# Prepare the value with:  base64 -i fireblocks_secret.key | pbcopy

set -eu

KEY_PATH="${FIREBLOCKS_SECRET_KEY_PATH:-/app/secrets/fireblocks_secret.key}"

if [ -z "${FIREBLOCKS_SECRET_KEY_B64:-}" ]; then
  # Not an error: sandbox mode runs without custody credentials by design, and
  # fireblocks.ts already reports which credentials are unset at startup.
  echo "[boot] FIREBLOCKS_SECRET_KEY_B64 unset — starting without a custody signing key"
  exit 0
fi

mkdir -p "$(dirname "$KEY_PATH")"
printf '%s' "$FIREBLOCKS_SECRET_KEY_B64" | base64 -d > "$KEY_PATH"
chmod 600 "$KEY_PATH"

# Fail fast on a truncated or mis-pasted value rather than at the first signing
# attempt, which would be during a customer payment.
if ! head -n 1 "$KEY_PATH" | grep -q 'BEGIN.*PRIVATE KEY'; then
  echo "[boot] FATAL: decoded Fireblocks key is not a PEM private key — check the base64 value" >&2
  exit 1
fi

echo "[boot] Fireblocks signing key written to $KEY_PATH"
