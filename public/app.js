// The sheet app: an editable product sheet, one batch render for all its rows, and a grid that plays each video while it renders.
import Hls from "/vendor/hls.mjs";

const $ = (id) => document.getElementById(id);
const connection = await api("/api/connection");
if (connection.connected) showKey(connection.keyHint);
else await askForKey(false);
$("change-key").addEventListener("click", () => askForKey(true).then(() => location.reload()));
const sheet = await api("/api/sheet");
let rows = sheet.rows.map(toRow);
let renders = [];
let run = 0;
const players = new Map();

drawSheet();

$("add-row").addEventListener("click", () => {
  if (rows.length >= sheet.maxRows) return error(`This example renders up to ${sheet.maxRows} rows.`);
  const last = rows.at(-1);
  rows.push({ ...last, video: uniqueName("new-product"), product: "NEW PRODUCT", file: last?.file, photo: last?.photo ?? "" });
  drawSheet();
  $("sheet-body").lastElementChild?.querySelector("input")?.focus();
});

$("csv").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    const imported = await api("/api/csv", { method: "POST", headers: { "Content-Type": "text/csv" }, body: file });
    rows = imported.rows.map(toRow);
    error("");
    drawSheet();
  } catch (e) {
    error(e.message);
  }
});

// Clicking a row's photo opens the file picker for that row; dropping an image on it works too.
let photoRow = null;
$("photo-picker").addEventListener("change", (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (file && photoRow) setPhoto(photoRow, file);
});

$("render").addEventListener("click", async () => {
  const mine = ++run;
  error("");
  $("render").disabled = true;
  $("zip").hidden = true;
  clearVideos();
  progress(0, rows.length, "Uploading photos…");

  try {
    // Each render uses up its own upload, so every row's photo is uploaded, a few at a time.
    const uploads = await mapLimit(rows, 4, async (row) => {
      const blob = row.file ?? (row.photo ? await (await fetch(row.photo)).blob() : null);
      return blob ? api("/api/photos", { method: "POST", headers: { "Content-Type": blob.type }, body: blob }) : undefined;
    });
    progress(0, rows.length, "Queuing the batch…");
    const body = { rows: rows.map((row, i) => ({ ...pick(row), upload: uploads[i] })) };
    const queued = await api("/api/renders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    renders = queued.renders.map((r) => ({ ...r, status: "queued" }));
    drawVideos();
    await follow(mine);
  } catch (e) {
    error(e.message);
    progress(0, 0, "");
  } finally {
    if (mine === run) $("render").disabled = false;
  }
});

$("zip").addEventListener("click", async () => {
  $("zip").disabled = true;
  $("zip").textContent = "Packing the ZIP…";
  try {
    const ids = renders.filter((r) => r.status === "succeeded").map((r) => r.id);
    const { id } = await api("/api/archive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
    let archive;
    do {
      archive = await api(`/api/archive?id=${id}`);
    } while (archive.status === "queued" || archive.status === "building");
    if (archive.status !== "ready") throw new Error(archive.error ?? "The ZIP could not be made.");
    location.href = archive.url;
  } catch (e) {
    error(e.message);
  } finally {
    $("zip").disabled = false;
    $("zip").textContent = "Download all as ZIP";
  }
});

// One status call for the whole batch every 1.5 seconds. A render whose stream has started plays in its tile at once.
async function follow(mine) {
  while (mine === run) {
    const { renders: latest } = await api("/api/statuses", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: renders.map((r) => r.id) }),
    });
    renders = latest;
    drawVideos();
    const done = renders.filter((r) => ["succeeded", "failed", "cancelled"].includes(r.status)).length;
    const ready = renders.filter((r) => r.status === "succeeded").length;
    progress(done, renders.length, done === renders.length
      ? `${ready} of ${renders.length} videos ready.`
      : `${ready} of ${renders.length} ready, ${renders.filter((r) => r.status === "rendering").length} rendering.`);
    if (done === renders.length) {
      $("zip").hidden = ready === 0;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

function drawSheet() {
  $("row-count").textContent = `${rows.length} ${rows.length === 1 ? "row" : "rows"} → ${rows.length} ${rows.length === 1 ? "video" : "videos"}`;
  $("render").textContent = `Render ${rows.length} ${rows.length === 1 ? "video" : "videos"}`;

  const head = document.createElement("tr");
  for (const label of ["Photo", "Video name", ...sheet.columns.map((c) => c.label), ""]) {
    head.append(Object.assign(document.createElement("th"), { textContent: label }));
  }
  $("sheet-head").replaceChildren(head);

  $("sheet-body").replaceChildren(...rows.map((row, index) => {
    const tr = document.createElement("tr");

    const photoCell = document.createElement("td");
    const photo = Object.assign(document.createElement("button"), { type: "button", className: "thumb", title: "Change the photo" });
    photo.innerHTML = row.photo ? `<img alt="" src="${row.photo}">` : "<span>+</span>";
    photo.addEventListener("click", () => { photoRow = row; $("photo-picker").click(); });
    photo.addEventListener("dragover", (e) => e.preventDefault());
    photo.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) setPhoto(row, e.dataTransfer.files[0]); });
    photoCell.append(photo);
    tr.append(photoCell);

    tr.append(cell(row, "video", 40, "mono"));
    for (const column of sheet.columns) tr.append(cell(row, column.id, column.maxLength, column.id.includes("price") ? "price" : ""));

    const remove = Object.assign(document.createElement("button"), { type: "button", className: "remove", title: "Remove the row", textContent: "×" });
    remove.addEventListener("click", () => { rows.splice(index, 1); drawSheet(); });
    const removeCell = document.createElement("td");
    removeCell.append(remove);
    tr.append(removeCell);
    return tr;
  }));
}

function cell(row, key, maxLength, kind) {
  const td = document.createElement("td");
  const input = Object.assign(document.createElement("input"), { value: row[key] ?? "", maxLength, spellcheck: false, className: kind });
  input.setAttribute("aria-label", key);
  input.addEventListener("input", () => { row[key] = input.value; });
  td.append(input);
  return td;
}

function drawVideos() {
  $("videos").replaceChildren(...renders.map((render) => {
    let li = document.querySelector(`[data-render="${render.id}"]`);
    if (!li) {
      li = document.createElement("li");
      li.dataset.render = render.id;
      li.innerHTML = `<div class="screen"><video muted playsinline loop></video><span class="chip"></span></div>
        <div class="meta"><strong></strong><a class="download" download>MP4</a></div>`;
    }
    const playable = render.hlsUrl && (render.status === "rendering" || render.status === "succeeded");
    const state = render.status === "rendering" ? (playable ? "live" : "rendering") : render.status;
    li.querySelector(".chip").textContent = { live: "Live", rendering: "Rendering", queued: "Queued", succeeded: "Ready" }[state] ?? state;
    li.querySelector(".chip").dataset.state = state;
    li.querySelector("strong").textContent = render.video;
    li.querySelector(".download").hidden = !render.mp4Url;
    if (render.mp4Url) li.querySelector(".download").href = render.mp4Url;
    if (render.posterUrl && !li.querySelector("video").poster) li.querySelector("video").poster = render.posterUrl;
    if (render.error) li.querySelector(".meta").title = render.error;
    const video = li.querySelector("video");
    const player = players.get(render.id);
    if (render.status === "succeeded" && render.mp4Url && player?.kind !== "mp4") {
      player?.hls?.destroy();
      players.set(render.id, { kind: "mp4" });
      video.src = render.mp4Url;
      video.play().catch(() => {});
    } else if (playable && !player) {
      players.set(render.id, { kind: "hls", hls: play(video, render.hlsUrl) });
    }
    return li;
  }));
}

// Safari plays HLS itself; other browsers play it through hls.js.
// A live stream grows while it plays, so play is retried as each segment arrives; the first call comes before any exist.
function play(video, url) {
  const retry = () => video.play().catch(() => {});
  if (!Hls.isSupported()) {
    video.src = url;
    retry();
    return null;
  }
  const hls = new Hls({ lowLatencyMode: true, maxBufferLength: 8, backBufferLength: 8 });
  hls.on(Hls.Events.MANIFEST_PARSED, retry);
  hls.on(Hls.Events.FRAG_LOADED, retry);
  hls.loadSource(url);
  hls.attachMedia(video);
  return hls;
}

function clearVideos() {
  for (const player of players.values()) player.hls?.destroy();
  players.clear();
  renders = [];
  $("videos").replaceChildren();
}

function setPhoto(row, file) {
  row.file = file;
  row.photo = URL.createObjectURL(file);
  drawSheet();
}

function toRow(row) {
  return { video: row.video, photo: row.photo, ...Object.fromEntries(sheet.columns.map((c) => [c.id, row[c.id] ?? ""])) };
}

function pick(row) {
  return { video: row.video, ...Object.fromEntries(sheet.columns.map((c) => [c.id, row[c.id]])) };
}

function uniqueName(base) {
  let n = 1;
  while (rows.some((r) => r.video === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}

async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i]);
    }
  }));
  return results;
}

function progress(done, total, text) {
  $("progress-bar").style.width = total ? `${(done / total) * 100}%` : "0";
  $("progress-text").textContent = text || "Rendered videos appear here.";
}

function error(text) {
  $("form-error").textContent = text;
}

// Someone who cloned the example connects their own account here. The key goes to this app's server, which checks it with Blitframe.
function askForKey(cancellable, reason = "") {
  const dialog = $("connect");
  $("connect-cancel").hidden = !cancellable;
  $("connect-error").textContent = reason;
  if (!dialog.open) dialog.showModal();
  return new Promise((resolve) => {
    dialog.oncancel = (event) => { if (!cancellable) event.preventDefault(); };
    $("connect-cancel").onclick = () => dialog.close();
    $("connect-form").onsubmit = async (event) => {
      event.preventDefault();
      const submit = $("connect-submit");
      submit.disabled = true;
      submit.textContent = "Connecting";
      try {
        const result = await api("/api/connection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey: $("connect-key").value }),
        });
        $("connect-key").value = "";
        dialog.close();
        showKey(result.keyHint);
        resolve(result);
      } catch (e) {
        $("connect-error").textContent = e.message;
      } finally {
        submit.disabled = false;
        submit.textContent = "Connect";
      }
    };
  });
}

function showKey(keyHint) {
  $("change-key").hidden = false;
  $("change-key").textContent = `Key ${keyHint}`;
}

// A 401 means this server has no key Blitframe accepts any more, so the page asks for one and starts again with it.
async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (response.status === 401) askForKey(false, body.code === "no_key" ? "" : body.error).then(() => location.reload());
  if (!response.ok) throw new Error(body.error ?? `Request failed: ${response.status}`);
  return body;
}
