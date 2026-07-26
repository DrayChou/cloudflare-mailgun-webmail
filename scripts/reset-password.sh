#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

EMAIL="${1:-}"
if [[ ! "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  echo "用法: $0 user@example.com" >&2
  exit 1
fi

read -r -s -p "输入新密码（至少 16 位）: " PASSWORD1
echo
read -r -s -p "再次输入新密码: " PASSWORD2
echo

if [[ "$PASSWORD1" != "$PASSWORD2" ]]; then
  echo "两次密码不一致，未修改。" >&2
  exit 1
fi
if (( ${#PASSWORD1} < 16 )); then
  echo "密码至少需要 16 个字符，未修改。" >&2
  exit 1
fi

IFS='|' read -r SALT HASH < <(printf '%s' "$PASSWORD1" | node --input-type=module -e '
import { pbkdf2Sync, randomBytes } from "node:crypto";
let password = "";
for await (const chunk of process.stdin) password += chunk;
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, 10_000, 32, "sha256");
process.stdout.write(`${salt.toString("base64")}|${hash.toString("base64")}\n`);
')
unset PASSWORD1 PASSWORD2

NOW_MS="$(( $(date +%s) * 1000 ))"
SQL="UPDATE users SET password_hash = '${HASH}', password_salt = '${SALT}', password_iterations = 10000, updated_at = ${NOW_MS} WHERE lower(username) = lower('${EMAIL}'); DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE lower(username) = lower('${EMAIL}'));"

npx wrangler d1 execute MAIL_DB --remote --command "$SQL"
echo "密码已重置：${EMAIL}。所有旧 Session 已失效。"
