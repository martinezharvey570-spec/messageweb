#!/usr/bin/env bash
set -e
echo "===================================================="
echo "正在编译 校务智理 v36 安卓正式签名版安装包 (API 35)..."
echo "===================================================="
gradle assembleRelease
cp app/build/outputs/apk/release/app-release.apk ./xiaowu-zhili.apk
echo "[成功] 已生成最新手机直装签名包：$(pwd)/xiaowu-zhili.apk"
