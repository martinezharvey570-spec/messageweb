@echo off
chcp 65001 >nul
echo ====================================================
echo 正在编译 校务智理 v36 安卓正式签名版安装包 (API 35)...
echo ====================================================
call gradle assembleRelease
if %ERRORLEVEL% EQU 0 (
    copy /Y "app\build\outputs\apk\release\app-release.apk" "xiaowu-zhili.apk" >nul
    echo.
    echo [成功] 已生成最新手机直装签名包：xiaowu-zhili.apk
) else (
    echo [提示] 请确保已安装 Android Studio 或配置 ANDROID_HOME 环境变量。
)
pause
