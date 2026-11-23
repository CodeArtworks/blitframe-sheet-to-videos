import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRows, readRows, toRenderItem } from "../src/rows.ts";

const layers = new Map([
  ["Product name", "/assets/4/layers/3"],
  ["Price", "/assets/4/layers/1"],
  ["Old price", "/assets/4/layers/0"],
  ["Feature", "/assets/4/layers/2"],
  ["Product photo", "/assets/4/layers/4"],
]);

test("a row becomes one render with a replacement per filled column", () => {
  const [row] = readRows("video,photo,product,price,old_price\nnight-pilot,photos/pilot.png,THE NIGHT PILOT, $89 ,\n");

  const item = toRenderItem(row, layers, { uploadId: "upload-1", extension: "png" }, "hls");

  assert.deepEqual(item, {
    name: "night-pilot",
    format: "hls",
    replacements: [
      { layer: "/assets/4/layers/3", text: "THE NIGHT PILOT" },
      { layer: "/assets/4/layers/1", text: "$89" },
      { layer: "/assets/4/layers/4", file: { path: "images/night-pilot.png", uploadId: "upload-1" }, fit: "contain" },
    ],
  });
});

test("a row without a photo keeps the template's photo, and renders an MP4 by default", () => {
  const [row] = readRows("video,price\nplain,$10\n");

  assert.deepEqual(toRenderItem(row, layers), { name: "plain", format: "mp4", replacements: [{ layer: "/assets/4/layers/1", text: "$10" }] });
});

test("rows are refused before anything is uploaded when a name is missing, unsafe or repeated, or a cell is too long", () => {
  assert.throws(() => readRows("video,price\n,$1\n"), /Row 2: "video" must be a file name/);
  assert.throws(() => readRows("video,price\n../x,$1\n"), /Row 2: "video" must be a file name/);
  assert.throws(() => readRows("video,price\na,$1\nA,$2\n"), /Row 3: the video name "A" is used twice/);
  assert.throws(() => checkRows([{ video: "a", price: "$1,000,000" }]), /Row 2: Price can be at most 8 characters/);
  assert.throws(() => checkRows([]), /no rows/);
});

test("a template without the expected layer names the layers it has", () => {
  const [row] = readRows("video,price\na,$1\n");

  assert.throws(() => toRenderItem(row, new Map([["Title", "/layers/0"]])), /no layer named "Price". It has: Title/);
});
