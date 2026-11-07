import { readFileSync, writeFileSync } from "node:fs";

const read = name => readFileSync(new URL("../src/group/personas/" + name + ".md", import.meta.url), "utf8").replaceAll(String.fromCharCode(13,10),String.fromCharCode(10));
const out = [
  "// This file is GENERATED from src/group/personas/*.md. Do not edit directly.",
  "export const DEFAULT_DS_PERSONA = " + JSON.stringify(read("ds")) + ";",
  "export const DEFAULT_DOUBAO_PERSONA = " + JSON.stringify(read("doubao")) + ";",
  ""
].join("\n");
writeFileSync(new URL("../src/group/persona-defaults.generated.ts", import.meta.url), out);
