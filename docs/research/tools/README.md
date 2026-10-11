# Mixxx tracing tools

Research helpers used for `docs/research/MIXXX_REVERSE_ENGINEERING.md`. They are not part of the app.

**Prerequisites** (installed 2026-10-11):
- Ghidra 12.1.4 at `C:\tools\ghidra_12.1.4_PUBLIC`
- Temurin JDK 21 at `C:\tools\jdk-21.0.12.1+1`
- Mixxx 2.5.6 at `C:\Program Files\Mixxx` (with `mixxx.pdb`)

| File | What it does |
|---|---|
| `run-pdb-dump.cmd` + `DumpPdbFunctionSeeds.java` | Runs Ghidra headless on the original `mixxx.exe` so its PDB loads. Then writes `C:\tools\rea-snapshots\mixxx-2.5.6-pdb.seeds`: one `0x<addr>\tfunction\t<name>` line per PDB-named function. ~18 min. |
| `rea-trace-mixxx.mjs` | Starts a private REA MCP server with `REA_GHIDRA_SEED_FILE` pointing at the seeds. One Ghidra analysis (~12 min), then searches, decompiles and collects callers and callees for the functions in `TARGETS`. Writes the raw REA JSON plus `summary.json` to `C:\tools\rea-snapshots\mixxx-trace-…-pdb\`. Edit `TARGETS` to trace other functions. |

**Why the seed file?** REA imports a renamed private copy of the binary with a private user profile, so Ghidra never finds `mixxx.pdb`, and every function stays `FUN_…`. Seeds are REA's supported way to name functions before analysis.

The session's own REA MCP server can use the seeds too: add `REA_GHIDRA_SEED_FILE` to the `rea` entry's `env` in `~/.claude.json` and reconnect it.

Decompiled output is derived from GPL-licensed code, so keep raw evidence outside this repo.
