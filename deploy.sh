#!/bin/bash
# ============================================
# Ready Crew LMS - 一键部署脚本 (PRD Todo #5)
# 用法: ./deploy.sh [描述文字(可选)]
# ============================================

set -e  # 任何命令失败立即退出

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

DEPLOY_DESC="${1:-Auto deploy $(date '+%Y-%m-%d %H:%M')}"

echo ""
echo "🚀 Ready Crew LMS - 部署开始"
echo "================================"
echo "📁 项目目录: $PROJECT_DIR"
echo "📝 部署描述: $DEPLOY_DESC"
echo ""

# Step 1: 将 backend.txt / frontend.txt 同步到 src/
echo "📋 Step 1: 同步源文件到 src/..."
cp "$PROJECT_DIR/backend.txt"  "$PROJECT_DIR/src/コード.gs"
cp "$PROJECT_DIR/frontend.txt" "$PROJECT_DIR/src/index.html"
echo "   ✅ コード.gs 和 index.html 已更新（API 密钥在 Script Properties，见 config/local.settings.example.json）"

# Step 2: 推送到 Google Apps Script
echo ""
echo "☁️  Step 2: 推送到 GAS (clasp push)..."
clasp push --force
echo "   ✅ 推送成功"

# Step 3: 更新固定 Web App 部署（不新建版本，避免超过20个上限）
# Deployment ID 固定为当前 Web App URL 对应的 ID，URL 始终不变。
DEPLOY_ID="AKfycbwH0WFyPu-gdLyLDRkB4sqw0TtnhS35aebzpoNNFevz2RMoDPfF_qwxGv065OkWxCvq"
echo ""
echo "🌐 Step 3: 更新 Web App 部署（描述: $DEPLOY_DESC）..."
clasp deploy --deploymentId "$DEPLOY_ID" --description "$DEPLOY_DESC"
echo "   ✅ 部署完成，Web App URL 不变"

echo ""
echo "================================"
echo "🎉 全部完成！"
echo ""
echo "📌 下一步操作："
echo "   1. 打开 GAS 编辑器确认代码已更新"
echo "   2. 在 GAS「部署」→「管理部署」中获取最新 Web App URL"
echo "   3. 将 URL 分享给团队使用"
echo ""
