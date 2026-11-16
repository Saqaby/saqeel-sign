@echo off
rem Saqeel document signing - opens the local site (works offline)
set "PAGE=%~dp0index.html"
where msedge >nul 2>nul && (start "" msedge --app="file:///%PAGE:\=/%" & exit /b)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app="file:///%PAGE:\=/%"
  exit /b
)
start "" "%PAGE%"
