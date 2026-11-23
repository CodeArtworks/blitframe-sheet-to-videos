// Turns spreadsheet rows into render items. Pure functions, so they are tested without calling the API.

import { parse } from "csv-parse/sync";
import type { RenderItem, Replacement } from "./blitframe.ts";

// Which column changes which layer of the template. Rename a column here to match your own spreadsheet.
export const TEXT_COLUMNS = {
  product: { layer: "Product name", label: "Product", maxLength: 24 },
  price: { layer: "Price", label: "Price", maxLength: 8 },
  old_price: { layer: "Old price", label: "Old price", maxLength: 8 },
  feature: { layer: "Feature", label: "Feature", maxLength: 32 },
} as const;

export const PHOTO_COLUMN = "photo";
export const PHOTO_LAYER = "Product photo";
export const MAX_ROWS = 100;

export type Row = Record<string, string>;
export type Photo = { uploadId: string; extension: string };

export function readRows(csv: string): Row[] {
  const rows: Row[] = parse(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  checkRows(rows);
  return rows;
}

// Every row needs a unique, file-safe video name, and no cell may be longer than its layer can hold.
export function checkRows(rows: Row[]): void {
  if (rows.length === 0) throw new Error("The sheet has no rows.");
  if (rows.length > MAX_ROWS) throw new Error(`The sheet has ${rows.length} rows; this example renders up to ${MAX_ROWS}.`);
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    const line = i + 2;
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(row.video ?? "")) {
      throw new Error(`Row ${line}: "video" must be a file name of letters, digits and dashes, such as summer-sale.`);
    }
    if (seen.has(row.video.toLowerCase())) throw new Error(`Row ${line}: the video name "${row.video}" is used twice.`);
    seen.add(row.video.toLowerCase());
    for (const [column, { label, maxLength }] of Object.entries(TEXT_COLUMNS)) {
      if ((row[column] ?? "").length > maxLength) throw new Error(`Row ${line}: ${label} can be at most ${maxLength} characters.`);
    }
  });
}

// An empty cell keeps the template's own text. A photo becomes a new file in the render's version, fitted into the layer's space.
export function toRenderItem(row: Row, layers: Map<string, string>, photo?: Photo, format: "mp4" | "hls" = "mp4"): RenderItem {
  const layer = (name: string) => {
    const id = layers.get(name);
    if (!id) throw new Error(`The template has no layer named "${name}". It has: ${[...layers.keys()].join(", ")}.`);
    return id;
  };

  const replacements: Replacement[] = Object.entries(TEXT_COLUMNS)
    .filter(([column]) => row[column]?.trim())
    .map(([column, { layer: name }]) => ({ layer: layer(name), text: row[column].trim() }));

  if (photo) {
    const path = `images/${row.video}.${photo.extension}`;
    replacements.push({ layer: layer(PHOTO_LAYER), file: { path, uploadId: photo.uploadId }, fit: "contain" });
  }

  return { name: row.video, format, replacements };
}
