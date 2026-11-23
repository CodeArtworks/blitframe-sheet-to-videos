# Sheet to videos with Blitframe

Turn a product feed into one video ad per product. Each row of the sheet puts a product's photo, name, price, old price and feature into a 9-second sale spot for Juno Optics, a made-up eyewear brand, and [Blitframe](https://codeartworks.com/docs/blitframe) renders the whole sheet as one batch.

It comes two ways: a web app where you edit the sheet and watch every video play as it renders, and a command-line script that reads [`products.csv`](products.csv) and saves the MP4s.

## What it shows

- Pushing a template folder (`data.json`, its images and [text fitting](https://codeartworks.com/docs/blitframe/text-fitting) rules) to a project, and reusing it on every run.
- Finding layers by name with [`GET /v1/versions/{id}/layers`](https://codeartworks.com/docs/blitframe/editing#editable-layers).
- [Uploading](https://codeartworks.com/docs/blitframe/uploads) a photo per row.
- One [batch render](https://codeartworks.com/docs/blitframe/editing#many-videos-from-a-data-sheet) for the whole sheet, with text and image [replacements](https://codeartworks.com/docs/blitframe/editing#replacements) per row and an `Idempotency-Key`.
- Following every render with one status call, playing each video over [live HLS](https://codeartworks.com/docs/blitframe/renders#live-hls) while it renders, and packing them into one [ZIP](https://codeartworks.com/docs/blitframe/renders#download-many-videos-as-one-zip).

## Run it

You need [Node.js](https://nodejs.org) 22.18 or later and a Blitframe API key. The free trial is enough: the videos are 1280×720, and the five of them cost 45 render seconds.

1. Install the dependencies:

   ```bash
   npm install
   ```

2. Start the app and open [http://localhost:3000](http://localhost:3000):

   ```bash
   npm start
   ```

   The first time, the page asks for your API key, which you create in **Console → API keys** at [app.codeartworks.com/blitframe/api-keys](https://app.codeartworks.com/blitframe/api-keys). The app's server checks it with Blitframe and saves it to `.env`, so the next start connects by itself. **Key …** in the header changes it.

   Edit any cell, click a photo to change it, add or remove rows or import a CSV, then press **Render**. Each tile plays its video as soon as its first seconds exist. When they are all done, **Download all as ZIP**.

Or render the sheet from the command line, which reads the key from `.env`. The videos land in `out/`, named after the `video` column:

```bash
npm run cli                      # products.csv
npm run cli -- my-products.csv   # another sheet
```

## How it works

| File | Does |
|---|---|
| [`src/server.ts`](src/server.ts) | The app's server. It takes the API key from the page or `.env` and keeps it, pushes the template once the key connects, and answers the page: the sample sheet, CSV import, photo uploads, the batch, statuses and the ZIP. It listens on `127.0.0.1` only. |
| [`src/cli.ts`](src/cli.ts) | The command-line version, top to bottom: template, rows, photos, batch, wait, download. |
| [`src/rows.ts`](src/rows.ts) | The rules both share: which column changes which layer, the checks every row passes before anything is uploaded or charged, and how a row becomes a render. |
| [`src/blitframe.ts`](src/blitframe.ts) | A small typed client for just these Blitframe calls. |
| [`public/`](public) | The app's page. |

One batch, step by step:

1. **Template.** `pushTemplate` finds the project named *CSV to videos: Juno Optics spot*, or creates it, and sends the [`template/`](template) folder as an edit. Sending the same files again makes no new version, so later runs reuse it.
2. **Layers.** The template's layers have plain names, such as `Price` and `Product photo`. The example looks up the ids replacements need, such as `/assets/4/layers/1`, by those names.
3. **Photos.** Each row's photo is its own [upload](https://codeartworks.com/docs/blitframe/uploads), used by that row's render and fitted into the photo's space (`fit: "contain"`).
4. **Batch.** One `POST /v1/projects/{id}/renders/batch` queues every row. The batch is all or nothing: a refused row names itself, such as `renders[3]: …`, and nothing is charged. The app asks for `hls`, the script for `mp4`.
5. **Results.** `POST /v1/renders/statuses` follows up to 1,000 renders in one call. Once a render's stream has started, its `hlsUrl` plays what is rendered so far.

## The template

[`template/`](template) is an ordinary Blitframe project folder:

| File | What it is |
|---|---|
| `data.json` | The composition: three scenes, 9 seconds at 1280×720, 30 fps. The sale opener and the brand close stay the same in every video; the product card in the middle changes per row. |
| `text_fitting.json` | Keeps each line inside the design: a longer product name, price or feature shrinks to the width the original copy took. |
| `images/product.png` | The default product photo. |
| `images/hero-*.png` | The two frames in the opening scene. |

The fonts, Bayon and Fira Mono, come from Blitframe's [font library](https://codeartworks.com/docs/blitframe/fonts), so the folder carries no font files.

## Use your own sheet

- **Columns.** `video` names the file and must be unique. `photo` is a path to a PNG, JPEG or WebP file in `photos/`, or empty to keep the template's photo. The other columns are listed in `TEXT_COLUMNS` in [`src/rows.ts`](src/rows.ts), each with the layer it changes and its longest text. An empty cell keeps the template's text.
- **Your own template.** Name the layers you want to change in After Effects or in `data.json`, put the project in `template/`, and update `TEXT_COLUMNS` and `PHOTO_LAYER`. On a paid plan it can be 1920×1080 or larger. The [data.json reference](https://codeartworks.com/docs/blitframe/data-json-format) says what Blitframe renders.
- **Many rows.** The example takes up to 100 rows; a batch takes up to 1,000 renders. For larger sheets, split them into batches.

## Check it

```bash
npm test        # the row rules, without calling the API
npm run check   # type-check
```

## If something goes wrong

| Message | What to do |
|---|---|
| `Set BLITFRAME_API_KEY in .env` | The command line has no key yet. Connect once in the page, or copy `.env.example` to `.env` and paste your key. |
| `Blitframe refused this key` or `401 unauthorized` | The key was revoked or mistyped. Create a new one in the console and paste it in the page. |
| `402 insufficient_render_seconds` | The workspace has no render seconds left. See **Console → Settings → Plan & billing**. |
| `renders[n]: …` | Row *n* (counting from 0) was refused, and nothing was queued. The message says why. |
| `The template has no layer named "…"` | A column points at a layer the template doesn't have. The message lists the layers it has. |

[Errors](https://codeartworks.com/docs/blitframe/errors) lists every error code.

## License

[MIT](LICENSE). The template and photos are Code Artworks' own, and you may use them with the code.
