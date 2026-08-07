@echo off
REM =========================================================
REM  push.bat - Ajoute, commit et push en un double-clic
REM =========================================================
REM  A placer directement dans le dossier de ton projet
REM  (le meme dossier qui contient le dossier ".git")
REM =========================================================

cd /d "%~dp0"

echo.
echo === Anak Requests - Push rapide ===
echo Dossier : %cd%
echo.

echo Ajout des fichiers modifies...
git add .

set "msg="
set /p msg=Message de commit (Entree = message automatique) :

if "%msg%"=="" (
    set msg=Update %date% %time%
)

echo.
echo Commit : %msg%
git commit -m "%msg%"

echo.
echo Push vers GitHub...
git push

echo.
echo =========================================================
echo  Termine ! (verifie au-dessus s'il y a eu une erreur)
echo =========================================================
pause
