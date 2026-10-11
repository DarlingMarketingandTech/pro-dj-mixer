// Writes every non-default (PDB/import-derived) function name as an REA seed line:
//   0x<hex address>\tfunction\t<name>
// Names are validated with Ghidra's own symbol rules so REA's seed script never rejects them.
//@category REA
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;
import ghidra.program.model.symbol.SourceType;
import ghidra.program.model.symbol.SymbolUtilities;

public class DumpPdbFunctionSeeds extends GhidraScript {
    @Override
    public void run() throws Exception {
        Path out = Path.of(getScriptArgs()[0]);
        int written = 0, skippedDefault = 0, skippedInvalid = 0;
        try (PrintWriter w = new PrintWriter(Files.newBufferedWriter(out, StandardCharsets.UTF_8))) {
            for (Function f : currentProgram.getFunctionManager().getFunctions(true)) {
                if (f.isExternal() || f.isThunk()) continue;
                if (f.getSymbol().getSource() == SourceType.DEFAULT) { skippedDefault++; continue; }
                String name = f.getName(true).replaceAll("\\s+", "_");
                if (name.isEmpty() || name.length() > 2000 || SymbolUtilities.containsInvalidChars(name)) {
                    skippedInvalid++;
                    continue;
                }
                w.print("0x" + Long.toHexString(f.getEntryPoint().getOffset()) + "\tfunction\t" + name + "\n");
                written++;
            }
        }
        println("PDB seeds: written=" + written + " skippedDefault=" + skippedDefault + " skippedInvalid=" + skippedInvalid + " -> " + out);
    }
}
