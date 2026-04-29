import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export const installSpecs = async (): Promise<void> => {
    const here = fileURLToPath(new URL(".", import.meta.url))
    const entry = join(here, "specs", "tokens.ts")
    const outDir = join(homedir(), ".fig", "autocomplete", "build")

    const proc = Bun.spawn(["bun", "build", entry, "--outdir", outDir, "--minify", "--format", "esm"], {
        stdout: "inherit",
        stderr: "inherit",
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
        process.stderr.write(`tokens: spec build failed (exit ${exitCode})\n`)
        process.exit(exitCode)
    }
    console.log(`Installed Fig autocomplete spec to ${outDir}`)
}
