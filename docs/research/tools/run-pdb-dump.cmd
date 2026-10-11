@echo off
rem Ghidra headless on the ORIGINAL mixxx.exe (so mixxx.pdb beside it is found), then dump
rem every PDB-named function as an REA seed line. Takes ~18 min. See README.md in this folder.
set JAVA_HOME=C:\tools\jdk-21.0.12.1+1
set PATH=%JAVA_HOME%\bin;%PATH%
set MAXMEM=8G
set WORK=%TEMP%\mixxx-pdb-dump
if not exist "%WORK%" mkdir "%WORK%"
call C:\tools\ghidra_12.1.4_PUBLIC\support\analyzeHeadless.bat "%WORK%" mixxxpdb -import "C:\Program Files\Mixxx\mixxx.exe" -scriptPath "%~dp0." -postScript DumpPdbFunctionSeeds.java "C:\tools\rea-snapshots\mixxx-2.5.6-pdb.seeds" -deleteProject -analysisTimeoutPerFile 7200
