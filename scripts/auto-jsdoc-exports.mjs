import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

const exportRe =
  /^(export\s+(?:async\s+)?(?:function\*?|class|const|let|var|type|interface|enum)\s+)([A-Za-z_][\w]*)/gm;

function hasDocAbove(src, index) {
  const before = src.slice(Math.max(0, index - 400), index);
  // Ignore whitespace-only gap; detect a JSDoc ending immediately above
  return /(?:^|\n)\s*\/\*\*[\s\S]*?\*\/\s*$/.test(before);
}

function describe(kind, name) {
  return `Documentation for \`${name}\`.`;
}

for (const file of fs.readdirSync(srcDir)) {
  if (!file.endsWith(".ts")) continue;
  const p = path.join(srcDir, file);
  let src = fs.readFileSync(p, "utf8");
  let added = 0;
  const insertions = [];

  let m;
  const re = new RegExp(exportRe.source, "gm");
  while ((m = re.exec(src)) !== null) {
    if (hasDocAbove(src, m.index)) continue;
    const decl = m[1];
    const name = m[2];
    let kind = "symbol";
    if (decl.includes("function")) kind = "function";
    else if (decl.includes("class")) kind = "class";
    else if (decl.includes("type")) kind = "type";
    else if (decl.includes("interface")) kind = "interface";
    else if (decl.includes("enum")) kind = "enum";
    else if (decl.includes("const") || decl.includes("let") || decl.includes("var"))
      kind = "constant";
    const doc = `/** ${describe(kind, name)} */\n`;
    insertions.push({ index: m.index, doc });
  }

  // Apply from end so indices stay valid
  for (const ins of insertions.reverse()) {
    src = src.slice(0, ins.index) + ins.doc + src.slice(ins.index);
    added++;
  }

  if (added > 0) {
    fs.writeFileSync(p, src);
    console.log(`${file}: +${added} docs`);
  } else {
    console.log(`${file}: no changes`);
  }
}
