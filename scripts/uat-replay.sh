#!/usr/bin/env bash
# Phase 16 plan 04 (D-09, D-11, UAT-03/UAT-04).
#
# Byte-exact replay harness for a captured SendGrid webhook payload
# (plan 16-03's WEBHOOK_RAW_CAPTURE_WORKSPACE_ID seam). Reads a capture file
# with keys `rawBodyBase64`, `signature`, `timestamp` and `publicKey`
# (`publicKey` is carried through for plan 16-05's committed CI fixture; this
# script itself never needs it -- the endpoint's stored public key is what
# the SERVER verifies against, not the client doing the replay), decodes the
# body to raw bytes, and POSTs those exact bytes to `--url`, sending the two
# signature header values verbatim.
#
# CRITICAL invariant (RESEARCH.md's own top finding, D-09): the decoded body
# is written to a FILE and POSTed from that file (`curl --data-binary @file`)
# -- it is NEVER assigned to a bash variable and NEVER re-serialised through
# a second JSON.stringify/base64 round trip anywhere in this script. Either
# would risk mutating the exact wire bytes SendGrid's ECDSA signature was
# computed over, turning a correctly-working system into an apparent
# signature-verification failure. The base64-decode, the optional
# single-byte mutation (`--flip-byte`, D-11's negative check) and the write
# to disk all happen inside ONE `node -e` invocation, operating on a Node
# Buffer end to end -- bash never touches the byte content at all, which is
# a STRONGER guarantee than merely avoiding a shell variable.
#
# Usage:
#   scripts/uat-replay.sh --capture <path> --url <url> [--flip-byte <index>] [--dry-run]
#
# --dry-run prints the command sequence, the decoded byte length, and (if
# given) the flipped byte's index and before/after values -- performs no
# HTTP request. Mirrors scripts/deploy.sh's own --dry-run contract: an
# operator should be able to read exactly what this script is about to do
# before running it against the real public endpoint.
#
# No dependencies beyond `node` and `curl` -- both already required by this
# repository's own tooling and every runbook that already assumes `curl`
# (docs/runbooks/production-topology.md's own readiness checks).

set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# The two SendGrid Event Webhook signature header names, spelled EXACTLY as
# apps/api/src/modules/webhooks/webhooks.routes.ts reads them off
# `request.headers` -- a typo here would make the replay indistinguishable
# from a missing-signature request (both fail closed identically), silently
# reporting a false verification defect.
SIGNATURE_HEADER_NAME="x-twilio-email-event-webhook-signature"
TIMESTAMP_HEADER_NAME="x-twilio-email-event-webhook-timestamp"

# --- Argument parsing ----------------------------------------------------

CAPTURE_PATH=""
URL=""
FLIP_BYTE=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --capture)
      shift
      if [[ $# -eq 0 ]]; then
        echo "uat-replay.sh: --capture requires a path argument" >&2
        exit 1
      fi
      CAPTURE_PATH="$1"
      shift
      ;;
    --url)
      shift
      if [[ $# -eq 0 ]]; then
        echo "uat-replay.sh: --url requires a URL argument" >&2
        exit 1
      fi
      URL="$1"
      shift
      ;;
    --flip-byte)
      shift
      if [[ $# -eq 0 ]]; then
        echo "uat-replay.sh: --flip-byte requires a byte-index argument" >&2
        exit 1
      fi
      FLIP_BYTE="$1"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -*)
      echo "uat-replay.sh: unknown flag '$1'" >&2
      exit 1
      ;;
    *)
      echo "uat-replay.sh: unexpected extra argument '$1'" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$CAPTURE_PATH" ]]; then
  echo "uat-replay.sh: --capture <path> is required." >&2
  echo "Usage: scripts/uat-replay.sh --capture <path> --url <url> [--flip-byte <index>] [--dry-run]" >&2
  exit 1
fi

if [[ -z "$URL" ]]; then
  echo "uat-replay.sh: --url <url> is required." >&2
  echo "Usage: scripts/uat-replay.sh --capture <path> --url <url> [--flip-byte <index>] [--dry-run]" >&2
  exit 1
fi

if [[ ! -f "$CAPTURE_PATH" ]]; then
  echo "uat-replay.sh: capture file '$CAPTURE_PATH' does not exist." >&2
  exit 1
fi

# --- Decode (+ optional single-byte flip), entirely inside node -----------

BODY_FILE="$(mktemp)"
META_FILE="$(mktemp)"
cleanup() {
  rm -f "$BODY_FILE" "$META_FILE"
}
trap cleanup EXIT

# Everything byte-level happens in this ONE node invocation: base64-decode
# the capture's rawBodyBase64 into a Buffer, optionally flip exactly one
# byte (D-11), write the resulting bytes to BODY_FILE untouched by bash, and
# write a small JSON metadata file (byte length, header values, flip
# details) that the rest of this script reads back field by field -- never
# the byte content itself, only these string/number metadata fields.
node -e '
const fs = require("node:fs");

const [, capturePath, bodyOutPath, metaOutPath, flipByteArg] = process.argv;

let capture;
try {
  capture = JSON.parse(fs.readFileSync(capturePath, "utf8"));
} catch (err) {
  console.error(`uat-replay.sh: could not read/parse capture file "${capturePath}" -- ${err.message}`);
  process.exit(1);
}

if (typeof capture.rawBodyBase64 !== "string" || capture.rawBodyBase64.length === 0) {
  console.error(`uat-replay.sh: capture file "${capturePath}" is missing a non-empty "rawBodyBase64" field`);
  process.exit(1);
}

const buf = Buffer.from(capture.rawBodyBase64, "base64");

let flippedIndex = null;
let byteBefore = null;
let byteAfter = null;
if (flipByteArg !== "") {
  const idx = Number(flipByteArg);
  if (!Number.isInteger(idx) || idx < 0 || idx >= buf.length) {
    console.error(
      `uat-replay.sh: --flip-byte index ${flipByteArg} is out of range for a ${buf.length}-byte decoded body`,
    );
    process.exit(1);
  }
  byteBefore = buf[idx];
  // Flip every bit of exactly this one byte -- guarantees the byte actually
  // changes (unlike e.g. adding 1, which wraps to the same value at 0xFF).
  buf[idx] = buf[idx] ^ 0xff;
  byteAfter = buf[idx];
  flippedIndex = idx;
}

fs.writeFileSync(bodyOutPath, buf);

fs.writeFileSync(
  metaOutPath,
  JSON.stringify({
    byteLength: buf.length,
    signature: typeof capture.signature === "string" ? capture.signature : "",
    timestamp: typeof capture.timestamp === "string" ? capture.timestamp : "",
    flippedIndex,
    byteBefore,
    byteAfter,
  }),
);
' "$CAPTURE_PATH" "$BODY_FILE" "$META_FILE" "$FLIP_BYTE"

read_meta_field() {
  node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]] ?? "")' "$META_FILE" "$1"
}

BYTE_LENGTH="$(read_meta_field byteLength)"
SIGNATURE="$(read_meta_field signature)"
TIMESTAMP="$(read_meta_field timestamp)"
FLIPPED_INDEX="$(read_meta_field flippedIndex)"
BYTE_BEFORE="$(read_meta_field byteBefore)"
BYTE_AFTER="$(read_meta_field byteAfter)"

# --- Dry run ---------------------------------------------------------------

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "uat-replay.sh: dry run -- no request will be sent."
  echo "decoded body length: ${BYTE_LENGTH} bytes"
  echo "target URL: $URL"
  echo "would send header '${SIGNATURE_HEADER_NAME}: ${SIGNATURE}'"
  echo "would send header '${TIMESTAMP_HEADER_NAME}: ${TIMESTAMP}'"
  if [[ -n "$FLIPPED_INDEX" ]]; then
    echo "byte at index ${FLIPPED_INDEX} flipped: ${BYTE_BEFORE} -> ${BYTE_AFTER} (D-11 negative check)"
  fi
  echo "curl -sS -o /dev/null -w '%{http_code}\\n' -X POST \\"
  echo "  -H 'Content-Type: application/json' \\"
  echo "  -H '${SIGNATURE_HEADER_NAME}: ${SIGNATURE}' \\"
  echo "  -H '${TIMESTAMP_HEADER_NAME}: ${TIMESTAMP}' \\"
  echo "  --data-binary @<decoded-body-file> \\"
  echo "  '$URL'"
  exit 0
fi

# --- Real POST ---------------------------------------------------------------

echo "uat-replay.sh: POSTing ${BYTE_LENGTH} decoded byte(s) to $URL"
if [[ -n "$FLIPPED_INDEX" ]]; then
  echo "uat-replay.sh: byte at index ${FLIPPED_INDEX} flipped (${BYTE_BEFORE} -> ${BYTE_AFTER}) -- this request is EXPECTED to be rejected (D-11)."
fi

HTTP_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H "Content-Type: application/json" \
  -H "${SIGNATURE_HEADER_NAME}: ${SIGNATURE}" \
  -H "${TIMESTAMP_HEADER_NAME}: ${TIMESTAMP}" \
  --data-binary @"$BODY_FILE" \
  "$URL")"

echo "uat-replay.sh: endpoint responded with HTTP ${HTTP_STATUS}"

if [[ "$HTTP_STATUS" -ge 200 && "$HTTP_STATUS" -lt 300 ]]; then
  exit 0
fi
exit 1
