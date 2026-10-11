@echo off
rem Starts Private Cinema from the project folder (the folder above "deploy").
cd /d "%~dp0\..\.."
node --env-file-if-exists=.env dist\server\index.js >> "%~dp0private-cinema.log" 2>&1
