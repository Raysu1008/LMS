#!/usr/bin/env bash
# ローカルの config/local.settings.json を Apps Script の Script Properties に書き込む。
# 前提: clasp ログイン済み（clasp login）、jq あり、プロジェクト直下で実行。
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CFG="$ROOT/config/local.settings.json"
cd "$ROOT"

if [[ ! -f "$CFG" ]]; then
  echo "❌ 見つかりません: $CFG"
  echo "   cp config/local.settings.example.json config/local.settings.json を実行し、ARK_API_KEY 等を埋めてください。"
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "❌ jq が必要です（brew install jq など）。"
  exit 1
fi

# メタキー（アンダースコア始まり）と空値を除外
FILTERED="$(jq -c 'with_entries(select((.key|startswith("_")|not) and (.value != null) and ((.value|tostring|test("^\\s*$")|not))))' "$CFG")"
KEYS="$(echo "$FILTERED" | jq 'keys | length')"
if [[ "$KEYS" -eq 0 ]]; then
  echo "❌ 書き込むプロパティがありません（ARK_API_KEY 等を設定してください）。"
  exit 1
fi

# clasp run は JSON 配列として引数を渡す → GAS 側で先頭要素をオブジェクトとして解釈
PARAMS="$(echo "$FILTERED" | jq -c '[.]')"

echo "☁️  Script Properties に $KEYS 件を書き込みます..."
clasp run installScriptPropertiesFromLocal --params "$PARAMS"
echo "✅ 完了。バックエンドを clasp push / deploy で反映済みであることを確認してください。"
