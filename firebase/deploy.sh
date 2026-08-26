#!/usr/bin/env bash
#
# One-shot production setup for the QC DAO Firebase backend: creates the Firestore
# database in the right region if one doesn't exist yet, deploys firestore rules,
# indexes, and both Cloud Functions, then prints what's left to do by hand.
#
# This script never deletes or moves an existing Firestore database. If one already
# exists in the wrong region, it stops and points you at the manual migration steps
# in README.md instead - recreating a database destroys every document in it, which
# is not something a setup script should ever decide to do on its own.
#
# Usage:
#   ./deploy.sh --project <firebase-project-id> [--yes]
#
#   --project <id>   Firebase project id to deploy to. Falls back to whatever is in
#                     .firebaserc if omitted (see .firebaserc.example).
#   --yes, -y        Skip the confirmation prompt before deploying.
#
# Prerequisites:
#   - Node.js and npm (same ones the rest of this repo needs)
#   - Logged in to the Firebase CLI: npx firebase login
#   - A Firebase project already created in the console (this script sets up
#     Firestore and Cloud Functions inside it, it does not create the project
#     itself, or enable Authentication - do that once in the console first)
#
# Safe to re-run: every step here is idempotent except the Firestore database
# creation, which is itself guarded by the check in step 3.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Must match REGION in functions/index.js and FUNCTIONS_REGION in
# frontend/src/lib/firebase.js. Firestore's own location has to match this too -
# see "Firestore database location" in README.md for why a mismatch is a real,
# silent performance problem (every read/write crosses regions) rather than just a
# style preference.
REGION="asia-southeast1"

PROJECT_ID=""
SKIP_CONFIRM=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      PROJECT_ID="${2:-}"
      shift 2
      ;;
    --yes|-y)
      SKIP_CONFIRM=true
      shift
      ;;
    -h|--help)
      # Only the leading comment block (skip the shebang, stop at the first
      # non-comment line) - not every `#` comment in the whole script.
      awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: ./deploy.sh --project <firebase-project-id> [--yes]" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$PROJECT_ID" && -f .firebaserc ]]; then
  PROJECT_ID=$(node -e "
    try {
      const rc = JSON.parse(require('fs').readFileSync('.firebaserc', 'utf8'));
      console.log(rc.projects?.default ?? '');
    } catch { console.log(''); }
  ")
fi

if [[ -z "$PROJECT_ID" ]]; then
  echo "No project id given, and none found in .firebaserc." >&2
  echo "Usage: ./deploy.sh --project <firebase-project-id> [--yes]" >&2
  exit 1
fi

FIREBASE="npx firebase"

echo "== QC DAO Firebase backend setup =="
echo "Project:  $PROJECT_ID"
echo "Region:   $REGION"
echo ""

if [[ "$SKIP_CONFIRM" != true ]]; then
  read -r -p "Deploy Firestore rules/indexes and Cloud Functions to '$PROJECT_ID'? [y/N] " CONFIRM
  [[ "$CONFIRM" =~ ^[Yy]$ ]] || { echo "Aborted, nothing changed."; exit 1; }
fi

echo ""
echo "-- 1. Installing dependencies --"
npm install
npm --prefix functions install

echo ""
echo "-- 2. Checking Firestore database --"

# Allowed to fail: a brand-new project has no database yet, and the Firebase CLI
# exits non-zero for that. Everything else in this script keeps `set -e`.
set +e
EXISTING_JSON=$($FIREBASE firestore:databases:get "(default)" --project "$PROJECT_ID" --json 2>/dev/null)
set -e

EXISTING_LOCATION=$(node -e "
  try {
    const parsed = JSON.parse(process.argv[1] || '{}');
    console.log(parsed.status === 'success' ? (parsed.result?.locationId ?? '') : '');
  } catch { console.log(''); }
" "$EXISTING_JSON")

if [[ -z "$EXISTING_LOCATION" ]]; then
  echo "No Firestore database found. Creating one in $REGION..."
  $FIREBASE firestore:databases:create "(default)" \
    --location "$REGION" \
    --delete-protection ENABLED \
    --project "$PROJECT_ID"
elif [[ "$EXISTING_LOCATION" != "$REGION" ]]; then
  cat >&2 <<EOF

A Firestore database already exists in '$PROJECT_ID', but it's in
'$EXISTING_LOCATION', not '$REGION'.

This script will NOT delete or move it - recreating a Firestore database
destroys every document inside it, and a setup script should never make that
call on its own. See the "Firestore database location" section of README.md
for the manual delete + recreate commands, then re-run this script.
EOF
  exit 1
else
  echo "Firestore database already exists in $REGION. Nothing to create."
fi

echo ""
echo "-- 3. Deploying Firestore rules and indexes --"
$FIREBASE deploy --only firestore:rules,firestore:indexes --project "$PROJECT_ID"

echo ""
echo "-- 4. Deploying Cloud Functions --"
$FIREBASE deploy --only functions --project "$PROJECT_ID"

echo ""
echo "-- 5. Verifying --"
$FIREBASE functions:list --project "$PROJECT_ID"

cat <<EOF

== Backend deployed to '$PROJECT_ID' ==

Still to do by hand:
  1. If Authentication hasn't been touched yet in this project, open the
     Authentication tab in the Firebase console and complete its first-time
     setup - visiting Firestore or Functions does not provision it.
  2. Get the app's web config (Project settings -> General -> Your apps) and
     put the six VITE_FIREBASE_* values into frontend/.env.local.
  3. Sign in once through the running app to create your own profile, then
     promote it to role: 1 (administrator) by hand in the Firestore console -
     there is no other way to grant that role, by design.
  4. If you're deploying the frontend too: 'npm run build' in frontend/, then
     from here, '$FIREBASE deploy --only hosting --project $PROJECT_ID'.

See README.md for local emulator setup, running the test suites, and the full
schema this backend enforces.
EOF
