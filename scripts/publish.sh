#!/usr/bin/env bash
# Upload each solver's zip to the Chrome Web Store and submit it for review.
#
#   scripts/publish.sh                    # all five
#   scripts/publish.sh Queens_Solver ...  # just these
#
# Auth: gcloud impersonates the publisher's service account, so there's no key or
# refresh token to keep. Needs `gcloud auth login` as an account holding Service
# Account Token Creator on that service account. Build the zips first, and bump
# each manifest version: the store rejects an upload that doesn't raise it.
set -euo pipefail

PUBLISHER_ID="ad6e71e0-dc48-47b5-8d0d-f0f163178213"
SERVICE_ACCOUNT="webstore-publisher@annular-weaver-509520-k0.iam.gserviceaccount.com"
API="https://chromewebstore.googleapis.com"

# A function, not an associative array: macOS ships bash 3.2.
ALL="Queens_Solver Tango_Solver Zip_Solver Patches_Solver Mini_Sudoku_Solver"
item_id() {
  case $1 in
    Queens_Solver) echo ffimecnpmjmjhnpfibgijonefbffipaj ;;
    Tango_Solver) echo lieoeccecmpfiahfdoiengmldenljdle ;;
    Zip_Solver) echo ffhagcpnmojjoicapfbjknifcpdpdkko ;;
    Patches_Solver) echo akfafdkbjjahmodbahceoifkamldcadc ;;
    Mini_Sudoku_Solver) echo ihloniejebknegobhngghljipalnblpb ;;
    *) return 1 ;;
  esac
}

cd "$(dirname "$0")/.."
TOKEN=$(gcloud auth print-access-token \
  --impersonate-service-account="$SERVICE_ACCOUNT" \
  --scopes=https://www.googleapis.com/auth/chromewebstore 2>/dev/null)

json_field() { python3 -I -c "import json,sys; d=json.load(sys.stdin); print(d.get('$1') or '')"; }

publish_one() {
  local name=$1 id
  id=$(item_id "$name") || { echo "$name: unknown extension"; return 1; }
  local zip="$name.zip" item="$API/v2/publishers/$PUBLISHER_ID/items/$id"
  [[ -f $zip ]] || { echo "$name: $zip not found"; return 1; }
  local version
  version=$(python3 -I -c "import json; print(json.load(open('$name/manifest.json'))['version'])")

  echo "$name $version: uploading"
  local res state
  res=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" -T "$zip" "$API/upload/v2/publishers/$PUBLISHER_ID/items/$id:upload")
  [[ -n ${VERBOSE:-} ]] && echo "$res"
  state=$(json_field uploadState <<<"$res")
  for _ in {1..20}; do
    [[ $state == IN_PROGRESS || $state == UPLOAD_IN_PROGRESS ]] || break
    sleep 3
    res=$(curl -sS -H "Authorization: Bearer $TOKEN" "$item:fetchStatus")
    state=$(json_field lastAsyncUploadState <<<"$res")
  done
  if [[ $state != SUCCEEDED && $state != SUCCESS ]]; then
    echo "$name: upload failed ($state)"; echo "$res"; return 1
  fi

  echo "$name $version: submitting for review"
  res=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}' "$item:publish")
  [[ -n ${VERBOSE:-} ]] && echo "$res"
  echo "$name: $(json_field state <<<"$res")"
  [[ -n $(json_field state <<<"$res") ]] || { echo "$res"; return 1; }
}

status=0
for name in ${*:-$ALL}; do
  publish_one "$name" || status=1
done
exit $status
