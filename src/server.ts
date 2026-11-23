// The sheet app's server. It keeps the API key, so the browser never sees it: the page calls these /api routes, and the server calls Blitframe.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { Blitframe, BlitframeError, DEFAULT_API, type Render, type Version } from "./blitframe.ts";
import { checkRows, MAX_ROWS, readRows, TEXT_COLUMNS, toRenderItem, type Photo, type Row } from "./rows.ts";

const port = Number(process.env.PORT || 3000);
const maxPhotoBytes = 10_000_000;
const photoTypes: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const apiAddress = process.env.BLITFRAME || DEFAULT_API;

type Connection = { blitframe: Blitframe; version: Version; layers: Map<string, string>; keyHint: string };
let connection: Connection | null = null;

// A key in .env connects at start; without one, or with one Blitframe refuses, the page asks for a key.
if (process.env.BLITFRAME_API_KEY) {
  await use(process.env.BLITFRAME_API_KEY).catch((error) => console.error(`The key in .env did not connect: ${error.message}`));
}

// The template is pushed once per key. Every batch after that pins this version and changes only its layers.
async function use(apiKey: string) {
  const blitframe = new Blitframe(apiKey, apiAddress);
  const version = await blitframe.pushTemplate("CSV to videos: Juno Optics spot", "template");
  const layers = await blitframe.layersByName(version.id);
  connection = { blitframe, version, layers, keyHint: `…${apiKey.slice(-4)}` };
  console.log(`Template ready: version ${version.id}`);
}

function connected(): Connection {
  if (!connection) throw new NoKey();
  return connection;
}

class NoKey extends Error {}
class InvalidInput extends Error {}

const routes: Record<string, (request: IncomingMessage, url: URL) => Promise<unknown>> = {
  // Whether the server has a key Blitframe accepted. Only the key's last characters ever reach the page.
  "GET /api/connection": async () => connection ? { connected: true, keyHint: connection.keyHint } : { connected: false },

  // A key from the page: checked with Blitframe, then kept by this server and saved to .env for the next start.
  "POST /api/connection": async (request) => {
    const apiKey = String(JSON.parse((await readBody(request, 10_000)).toString("utf8") || "{}").apiKey ?? "").trim();
    if (!/^[\w-]{16,200}$/.test(apiKey)) throw new InvalidInput("Paste the whole API key, as the console shows it.");
    try {
      await use(apiKey);
    } catch (error) {
      if (error instanceof BlitframeError && error.status === 401) throw new InvalidInput("Blitframe refused this key. Check it in the console and paste it again.");
      throw error;
    }
    await saveKey(apiKey);
    return { connected: true, keyHint: connection!.keyHint };
  },

  // The sample sheet, with each row's photo served from photos/.
  "GET /api/sheet": async () => ({
    columns: Object.entries(TEXT_COLUMNS).map(([id, c]) => ({ id, label: c.label, maxLength: c.maxLength })),
    rows: readRows(await readFile("products.csv", "utf8")).map((row) => ({ ...row, photo: row.photo ? `/${row.photo}` : "" })),
    maxRows: MAX_ROWS,
    maxPhotoBytes,
  }),

  // A CSV the person imports, checked by the same rules as the command-line version. Its photo paths point into photos/.
  "POST /api/csv": async (request) => {
    try {
      const rows = readRows((await readBody(request, 1_000_000)).toString("utf8"));
      return { rows: rows.map((row) => ({ ...row, photo: row.photo ? `/${row.photo.replace(/^\/+/, "")}` : "" })) };
    } catch (error) {
      throw new InvalidInput((error as Error).message);
    }
  },

  // The browser sends each photo's bytes here; the server uploads them to Blitframe. Every render needs its own upload.
  "POST /api/photos": async (request) => {
    const extension = photoTypes[request.headers["content-type"] ?? ""];
    if (!extension) throw new InvalidInput("Choose a PNG, JPEG or WebP photo.");
    return { uploadId: await connected().blitframe.upload(`photo.${extension}`, await readBody(request, maxPhotoBytes)), extension } satisfies Photo;
  },

  // The whole sheet as one batch in the HLS format, so each video can play while it renders. All rows are queued, or none.
  "POST /api/renders": async (request) => {
    const body = JSON.parse((await readBody(request, 1_000_000)).toString("utf8") || "{}");
    const rows: (Row & { upload?: Photo })[] = Array.isArray(body.rows) ? body.rows : [];
    const clean = rows.map((row) => Object.fromEntries(
      ["video", ...Object.keys(TEXT_COLUMNS)].map((key) => [key, typeof row[key] === "string" ? row[key] : ""])));
    try {
      checkRows(clean);
    } catch (error) {
      throw new InvalidInput((error as Error).message);
    }
    const { blitframe, version, layers } = connected();
    const items = clean.map((row, i) => toRenderItem(row, layers, isPhoto(rows[i].upload) ? rows[i].upload : undefined, "hls"));
    const renders = await blitframe.renderBatch(version, items, randomUUID());
    return { renders: renders.map((r) => ({ id: r.id, video: r.name })) };
  },

  "POST /api/statuses": async (request) => {
    const { ids } = JSON.parse((await readBody(request, 100_000)).toString("utf8") || "{}");
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isId)) throw new InvalidInput("Unknown renders.");
    return { renders: (await connected().blitframe.statuses(ids)).map(summary) };
  },

  // A ZIP of every finished video, named after its row.
  "POST /api/archive": async (request) => {
    const { ids } = JSON.parse((await readBody(request, 100_000)).toString("utf8") || "{}");
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isId)) throw new InvalidInput("Unknown renders.");
    return { id: (await connected().blitframe.createArchive(ids, "Juno Optics spots")).id };
  },

  "GET /api/archive": async (_request, url) => {
    const id = url.searchParams.get("id") ?? "";
    if (!isId(id)) throw new InvalidInput("Unknown archive.");
    const archive = await connected().blitframe.getArchive(id);
    return { status: archive.status, url: archive.url, error: archive.error?.message ?? null };
  },
};

function summary(render: Render) {
  return {
    id: render.id,
    video: render.name,
    status: render.status,
    hlsUrl: render.output?.hlsUrl ?? null,
    mp4Url: render.output?.mp4Url ?? null,
    posterUrl: render.output?.posterUrl ?? null,
    error: render.error?.message ?? null,
  };
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const route = routes[`${request.method} ${url.pathname}`];
  try {
    if (route) return send(response, 200, await route(request, url));
    if (request.method === "GET") return await serveFile(response, url.pathname);
    send(response, 404, { error: "Not found." });
  } catch (error) {
    if (error instanceof NoKey) return send(response, 401, { error: "Connect your Blitframe API key first.", code: "no_key" });
    if (error instanceof InvalidInput) return send(response, 400, { error: error.message });
    if (error instanceof BlitframeError && error.status < 500) return send(response, error.status, { error: error.message });
    console.error(error);
    send(response, 502, { error: "Blitframe could not be reached. Try again." });
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Open http://localhost:${port}`);
});

// The key goes to .env, which git ignores, so the next start connects on its own.
async function saveKey(apiKey: string) {
  const lines = (await readFile(".env", "utf8").catch(() => "")).split(/\r?\n/).filter((line) => line && !line.startsWith("BLITFRAME_API_KEY="));
  await writeFile(".env", [...lines, `BLITFRAME_API_KEY=${apiKey}`].join("\n") + "\n");
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer<ArrayBuffer>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new InvalidInput(`The upload is larger than ${limit / 1_000_000} MB.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

function isPhoto(value: unknown): value is Photo {
  const photo = value as Photo | undefined;
  return isId(photo?.uploadId) && Object.values(photoTypes).includes(photo.extension);
}

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp",
};

// The page from public/, the sample photos from photos/, and hls.js from node_modules, so the page plays HLS in every browser.
async function serveFile(response: ServerResponse, pathname: string) {
  const roots = [resolve("public"), resolve("photos")];
  const file = pathname === "/vendor/hls.mjs"
    ? join("node_modules", "hls.js", "dist", "hls.mjs")
    : pathname.startsWith("/photos/")
      ? resolve("photos", `.${pathname.slice("/photos".length)}`)
      : resolve("public", `.${pathname === "/" ? "/index.html" : pathname}`);
  if (pathname !== "/vendor/hls.mjs" && !roots.some((root) => file.startsWith(root + sep))) return send(response, 404, { error: "Not found." });
  try {
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": contentTypes[extname(file)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    send(response, 404, { error: "Not found." });
  }
}
