// The command-line version: one video per spreadsheet row, saved to out/. Run with `npm run cli [-- sheet.csv]`.

import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { Blitframe, DEFAULT_API, type Render } from "./blitframe.ts";
import { PHOTO_COLUMN, readRows, toRenderItem } from "./rows.ts";

const apiKey = process.env.BLITFRAME_API_KEY;
if (!apiKey) {
  console.error("Set BLITFRAME_API_KEY in .env (copy .env.example). Create a key in the console: https://app.codeartworks.com/blitframe/api-keys");
  process.exit(1);
}

const csvFile = process.argv[2] ?? "products.csv";
const outFolder = "out";
const blitframe = new Blitframe(apiKey, process.env.BLITFRAME || DEFAULT_API);

// 1. The template: a project whose head is the template folder.
const version = await blitframe.pushTemplate("CSV to videos: Juno Optics spot", "template");
const layers = await blitframe.layersByName(version.id);
console.log(`Template ready: version ${version.id}`);

// 2. The rows, checked before anything is uploaded or charged.
const rows = readRows(await readFile(csvFile, "utf8"));
console.log(`${rows.length} rows in ${csvFile}`);

// 3. Each row's photo is its own upload, used up by that row's render.
const items = [];
for (const row of rows) {
  const photo = row[PHOTO_COLUMN]
    ? { uploadId: await blitframe.uploadFile(row[PHOTO_COLUMN]), extension: extname(row[PHOTO_COLUMN]).slice(1).toLowerCase() }
    : undefined;
  items.push(toRenderItem(row, layers, photo));
}

// 4. One batch for the whole sheet: all rows are queued, or none is, and it is charged once.
const queued = await blitframe.renderBatch(version, items, randomUUID());
console.log(`Queued ${queued.length} renders`);

// 5. Wait for every render, printing a line whenever the count changes.
let last = "";
const finished = await blitframe.waitForRenders(queued.map((r) => r.id), (renders) => {
  const count = (status: Render["status"]) => renders.filter((r) => r.status === status).length;
  const line = `${count("succeeded")} done, ${count("rendering")} rendering, ${count("queued")} queued, ${count("failed")} failed`;
  if (line !== last) console.log(line);
  last = line;
});

// 6. Download the videos, named after their rows.
await mkdir(outFolder, { recursive: true });
for (const render of finished) {
  if (render.status === "succeeded") {
    const file = join(outFolder, `${render.name}.mp4`);
    await blitframe.download(render.id, file);
    console.log(`Saved ${file}`);
  } else {
    console.log(`${render.name}: ${render.status}${render.error ? ` (${render.error.code}: ${render.error.message})` : ""}`);
  }
}
