// A small Blitframe API client: just the calls this example makes, typed, with one error type.
// API reference: https://codeartworks.com/reference/blitframe

import { createWriteStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";

export const DEFAULT_API = "https://blitframe.codeartworks.com/v1";

export type Replacement =
  | { layer: string; text: string }
  | { layer: string; file: { path: string; uploadId: string }; fit?: "contain" | "cover" };

export type RenderItem = { name: string; format: "mp4" | "hls"; replacements: Replacement[] };

export type Version = { id: string; projectId: string; renderable: boolean; problems: string[]; warnings: string[] };

export type Render = {
  id: string;
  name: string | null;
  status: "queued" | "rendering" | "succeeded" | "failed" | "cancelled";
  playback: "preparing" | "streaming" | "complete" | null;
  error: { code: string; message: string } | null;
  output: { mp4Url: string | null; hlsUrl: string | null; posterUrl: string | null } | null;
};

export type Archive = { id: string; status: "queued" | "building" | "ready" | "failed"; url: string | null; error: { message: string } | null };

type Layer = { layer: string; name: string };

export class BlitframeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(`${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

export class Blitframe {
  readonly #api: string;
  readonly #key: string;

  constructor(apiKey: string, api = DEFAULT_API) {
    this.#key = apiKey;
    this.#api = api.replace(/\/$/, "");
  }

  async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const response = await fetch(this.#api + path, {
      method,
      headers: { Authorization: `Bearer ${this.#key}`, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new BlitframeError(response.status, json.error?.code ?? "unknown", json.error?.message ?? text);
    }
    return json as T;
  }

  // Finds the project by name, or creates it, then makes its head match the folder. Sending the same files again makes no new
  // version, so running the example twice reuses the template it pushed the first time.
  async pushTemplate(projectName: string, folder: string): Promise<Version> {
    const { items } = await this.request<{ items: { id: string; name: string }[] }>(
      "GET", `/projects?q=${encodeURIComponent(projectName)}`);
    const project = items.find((p) => p.name === projectName)
      ?? await this.request<{ id: string }>("POST", "/projects", { name: projectName });

    const files = [];
    for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const fullPath = join(entry.parentPath, entry.name);
      const path = relative(folder, fullPath).split(sep).join("/");
      const bytes = await readFile(fullPath);
      files.push(path.endsWith(".json")
        ? { path, content: bytes.toString("utf8") }
        : { path, contentBase64: bytes.toString("base64") });
    }

    const version = await this.request<Version>("POST", `/projects/${project.id}/versions`, { files, message: "Template" });
    if (!version.renderable) {
      throw new Error(`The template cannot be rendered:\n- ${version.problems.join("\n- ")}`);
    }
    return version;
  }

  // Layer names to the ids replacements use, such as "Headline" → "/assets/2/layers/0".
  async layersByName(versionId: string): Promise<Map<string, string>> {
    const layers = await this.request<{ textLayers: Layer[]; imageLayers: Layer[]; videoLayers: Layer[] }>(
      "GET", `/versions/${versionId}/layers`);
    return new Map([...layers.textLayers, ...layers.imageLayers, ...layers.videoLayers].map((l) => [l.name, l.layer]));
  }

  uploadFile(filePath: string): Promise<string> {
    return readFile(filePath).then((bytes) => this.upload(basename(filePath), bytes));
  }

  // Create an upload, PUT the bytes to the address it returns, then complete it so Blitframe checks the file.
  async upload(fileName: string, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const upload = await this.request<{ id: string; url: string }>("POST", "/uploads", { fileName, sizeBytes: bytes.byteLength });
    const put = await fetch(upload.url, { method: "PUT", body: bytes });
    if (!put.ok) throw new Error(`Uploading ${fileName} failed: ${put.status}`);

    const done = await this.request<{ status: string; error: { message: string } | null }>(
      "POST", `/uploads/${upload.id}/complete`, {}, { Prefer: "wait=30" });
    if (done.status !== "ready") throw new BlitframeError(422, "upload_refused", `${fileName} was refused: ${done.error?.message ?? done.status}`);
    return upload.id;
  }

  // The whole batch is checked before anything is queued, and the key makes a retry of this exact call safe.
  async renderBatch(version: Version, renders: RenderItem[], key: string): Promise<Render[]> {
    const batch = await this.request<{ renders: Render[] }>("POST", `/projects/${version.projectId}/renders/batch`,
      { versionId: version.id, renders }, { "Idempotency-Key": key });
    return batch.renders;
  }

  // Up to 1,000 renders in one call, with their links once they can play.
  async statuses(ids: string[]): Promise<Render[]> {
    return (await this.request<{ renders: Render[] }>("POST", "/renders/statuses", { renderIds: ids })).renders;
  }

  // Polls the renders until each has finished.
  async waitForRenders(ids: string[], onProgress: (renders: Render[]) => void): Promise<Render[]> {
    while (true) {
      const renders = await this.statuses(ids);
      onProgress(renders);
      if (renders.every((r) => r.status === "succeeded" || r.status === "failed" || r.status === "cancelled")) return renders;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  // One ZIP of up to 1,000 finished videos, each under its render's name. It is built in the background.
  createArchive(renderIds: string[], name: string): Promise<Archive> {
    return this.request<Archive>("POST", "/renders/download-archive", { renderIds, name });
  }

  getArchive(archiveId: string): Promise<Archive> {
    return this.request<Archive>("GET", `/renders/download-archive/${archiveId}`, undefined, { Prefer: "wait=20" });
  }

  // Download links last an hour, so each render is fetched right before its download for a fresh one.
  async download(renderId: string, toFile: string): Promise<void> {
    const render = await this.request<Render>("GET", `/renders/${renderId}`);
    const url = render.output?.mp4Url;
    if (!url) throw new Error(`Render ${renderId} has no MP4 to download.`);
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`Downloading ${toFile} failed: ${response.status}`);
    await pipeline(Readable.fromWeb(response.body as ReadableStream), createWriteStream(toFile));
  }
}
