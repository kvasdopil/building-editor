/**
 * Module hooks that let a script import the app's TypeScript straight from
 * `src/`, so a CLI exercises the code that ships rather than a copy of it.
 *
 * Node strips the types itself; what it does not do is resolve the two things
 * the app's imports rely on — the extensionless `./surface-grid` of TypeScript
 * source and the `@/` alias from tsconfig. Both are filled in here. Register
 * the hooks before the first dynamic import of a `.ts` module:
 *
 *   import { register } from "node:module";
 *   register("./lib/ts-hooks.mjs", import.meta.url);
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

export async function resolve(specifier, context, next) {
  const wanted = specifier.startsWith("@/")
    ? pathToFileURL(path.join(SRC, specifier.slice(2))).href
    : specifier;
  try {
    return await next(wanted, context);
  } catch (error) {
    // TypeScript source imports its neighbours without an extension.
    if (/\.[mc]?[jt]s$/.test(wanted)) throw error;
    return await next(`${wanted}.ts`, context);
  }
}

export async function load(url, context, next) {
  try {
    return await next(url, context);
  } catch (error) {
    // Node strips types but refuses the few TypeScript forms that need code
    // generated for them — a constructor parameter property, an enum. Those
    // are rare enough to compile properly only when one turns up.
    if (error.code !== "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") throw error;
    const { default: ts } = await import("typescript");
    const source = await readFile(fileURLToPath(url), "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
      fileName: url,
    });
    return { format: "module", source: outputText, shortCircuit: true };
  }
}
