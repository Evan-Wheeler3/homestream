@echo off
rem Starts Wheelhouse from the project folder (the folder above "deploy").
cd /d "%~dp0\..\.."
node --env-file-if-exists=.env dist\server\index.js >> "%~dp0wheelhouse.log" 2>&1
