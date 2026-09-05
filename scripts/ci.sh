#!/usr/bin/env bash
# Shared entry point for local pre-push checks and any external CI runner.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
mode="${1:-check}"
if [[ "$mode" != check && "$mode" != release && "$mode" != postgres ]]; then
  echo 'Usage: bash scripts/ci.sh [check|release|postgres]' >&2
  exit 2
fi
python="$root/backend/.venv/bin/python"
if [[ ! -x "$python" ]]; then
  echo 'Install backend/requirements-dev.txt in backend/.venv first.' >&2
  exit 1
fi
if [[ "$mode" == postgres ]]; then
  : "${PVWEB_DATABASE_URL:?Set a disposable PostgreSQL test database URL}"
  cd backend
  "$python" -m alembic -c alembic.ini upgrade head
  "$python" -m scripts.verify_postgres_tags
  exit
fi
# Invalidate old release output before checking so failed runs cannot leave a
# stale artifact that looks like the result of the current verification.
rm -f artifacts/pages/pages-site.zip artifacts/pages/pages-site.zip.sha256
"$python" -m ruff check --config backend/ruff.toml backend workers python scripts
"$python" -m unittest discover -s scripts -p 'test_*.py'
(
  cd backend
  mkdir -p coverage
  "$python" -m pytest --cov=app --cov=../workers --cov-branch --cov-fail-under=80 \
    --cov-report=term-missing --cov-report=xml:coverage/coverage.xml --cov-report=html:coverage/html
  PVWEB_DATABASE_URL=postgresql+psycopg://u:p@localhost/db \
    "$python" -m alembic -c alembic.ini upgrade head --sql > coverage/postgres-migration.sql
)
"$python" -m pytest -q python
(
  cd frontend
  npm run typecheck
  npm run lint
  npm run test:coverage
  npm run build
  npm run e2e
)
git diff --check
if [[ "$mode" == release ]]; then
  "$python" scripts/pages_bundle.py pack frontend/dist artifacts/pages
fi
