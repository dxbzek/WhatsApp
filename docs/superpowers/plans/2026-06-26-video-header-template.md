# Video Header Template Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow WhatsApp card templates to use an MP4 video as the header media alongside existing image support, via a merged "Image / Video header" option in the template builder UI.

**Architecture:** Two files changed. The upload API gains MP4 acceptance (16 MB cap) for `kind=card`. The template builder UI renames `headerType="image"` to `"media"`, adds a `mediaIsVideo` boolean detected from the uploaded file's MIME type, and renders `<video>` or `<img>` accordingly in both the inline preview and the phone mockup. The Twilio template creation API is unchanged — it already passes `media: [url]` through as-is, and Meta infers the header type from the file's `Content-Type` at the hosted URL.

**Tech Stack:** Next.js 14 App Router, TypeScript, React, Supabase Storage, Twilio Content API

---

## File Map

| File | Change |
|------|--------|
| `app/api/upload/route.ts` | Accept `video/mp4` for `kind=card`, 16 MB cap |
| `app/templates/page.tsx` | State rename + `mediaIsVideo` state + dropdown label + file input accept + preview elements |

---

### Task 1: Update upload API to accept MP4 for card templates

**Files:**
- Modify: `app/api/upload/route.ts`

- [ ] **Step 1: Open the file and locate the kind/type guards**

The relevant block is lines 18-28 of `app/api/upload/route.ts`:

```ts
const isImage = file.type.startsWith("image/");
const isDoc = file.type === "application/pdf";
if (kind === "chat") {
  if (!isImage && !isDoc) return NextResponse.json({ error: "Images or PDF only" }, { status: 400 });
} else if (!isImage) {
  return NextResponse.json({ error: "Image files only" }, { status: 400 });
}
// WhatsApp limits: ~5 MB images, ~16 MB documents.
const max = isImage ? 5 * 1024 * 1024 : 16 * 1024 * 1024;
```

- [ ] **Step 2: Replace that block with the updated version**

```ts
const isImage = file.type.startsWith("image/");
const isVideo = file.type === "video/mp4";
const isDoc = file.type === "application/pdf";
if (kind === "chat") {
  if (!isImage && !isDoc) return NextResponse.json({ error: "Images or PDF only" }, { status: 400 });
} else {
  // kind === "card": accept images and MP4 video
  if (!isImage && !isVideo) return NextResponse.json({ error: "Image or MP4 video files only" }, { status: 400 });
}
// WhatsApp limits: 5 MB images, 16 MB video/documents
const max = isImage ? 5 * 1024 * 1024 : 16 * 1024 * 1024;
```

- [ ] **Step 3: Verify the full updated file looks correct**

The complete `app/api/upload/route.ts` should be:

```ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "template-media";

// Accepts a multipart upload, stores it in a public Supabase Storage
// bucket, and returns a public URL usable as a WhatsApp card header.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    const kind = String(form.get("kind") || "card"); // "card" (image or mp4) | "chat" (image + pdf)
    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

    const isImage = file.type.startsWith("image/");
    const isVideo = file.type === "video/mp4";
    const isDoc = file.type === "application/pdf";
    if (kind === "chat") {
      if (!isImage && !isDoc) return NextResponse.json({ error: "Images or PDF only" }, { status: 400 });
    } else {
      // kind === "card": accept images and MP4 video
      if (!isImage && !isVideo) return NextResponse.json({ error: "Image or MP4 video files only" }, { status: 400 });
    }
    // WhatsApp limits: 5 MB images, 16 MB video/documents
    const max = isImage ? 5 * 1024 * 1024 : 16 * 1024 * 1024;
    if (file.size > max)
      return NextResponse.json({ error: `File must be under ${Math.round(max / 1048576)} MB` }, { status: 400 });

    const sb = supabaseAdmin();
    await sb.storage.createBucket(BUCKET, { public: true }).catch(() => {});

    const ext = (file.name.split(".").pop() || (isImage ? "jpg" : isVideo ? "mp4" : "pdf")).toLowerCase().replace(/[^a-z0-9]/g, "");
    const folder = kind === "chat" ? "chat" : "cards";
    const key = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const buf = Buffer.from(await file.arrayBuffer());

    const { error } = await sb.storage.from(BUCKET).upload(key, buf, {
      contentType: file.type,
      upsert: false,
    });
    if (error) throw new Error(error.message);

    const { data } = sb.storage.from(BUCKET).getPublicUrl(key);
    return NextResponse.json({ url: data.publicUrl });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Upload failed" }, { status: 500 });
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add app/api/upload/route.ts
git commit -m "feat: accept mp4 video uploads for card template headers"
```

---

### Task 2: Update template builder state and dropdown

**Files:**
- Modify: `app/templates/page.tsx`

- [ ] **Step 1: Update the `headerType` state initialisation and add `mediaIsVideo` state**

Find this block in `NewTemplate` (around line 310):

```ts
const [headerType, setHeaderType] = useState<"none" | "text" | "image">(initialKind === "card" ? "image" : "none");
const [headerText, setHeaderText] = useState("");
const [footer, setFooter] = useState("");
const [mediaUrl, setMediaUrl] = useState("");
const [uploading, setUploading] = useState(false);
```

Replace with:

```ts
const [headerType, setHeaderType] = useState<"none" | "text" | "media">(initialKind === "card" ? "media" : "none");
const [headerText, setHeaderText] = useState("");
const [footer, setFooter] = useState("");
const [mediaUrl, setMediaUrl] = useState("");
const [mediaIsVideo, setMediaIsVideo] = useState(false);
const [uploading, setUploading] = useState(false);
```

- [ ] **Step 2: Update `handleUpload` to set `mediaIsVideo` from the file's MIME type**

Find the existing `handleUpload` function (around line 326):

```ts
async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
  const f = e.target.files?.[0];
  if (!f) return;
  setUploading(true);
  setErr(null);
  try {
    const fd = new FormData();
    fd.append("file", f);
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || "Upload failed");
    setMediaUrl(d.url);
  } catch (e: any) {
    setErr(e.message);
  } finally {
    setUploading(false);
  }
}
```

Replace with:

```ts
async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
  const f = e.target.files?.[0];
  if (!f) return;
  setUploading(true);
  setErr(null);
  try {
    const fd = new FormData();
    fd.append("file", f);
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || "Upload failed");
    setMediaUrl(d.url);
    setMediaIsVideo(f.type.startsWith("video/"));
  } catch (e: any) {
    setErr(e.message);
  } finally {
    setUploading(false);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add app/templates/page.tsx
git commit -m "feat: add mediaIsVideo state and detect type on upload"
```

---

### Task 3: Update the header dropdown, file input, and inline preview

**Files:**
- Modify: `app/templates/page.tsx`

- [ ] **Step 1: Update the header `<select>` dropdown**

Find this block inside the `{kind === "card" && ...}` section (around line 440):

```tsx
<select value={headerType} onChange={(e) => setHeaderType(e.target.value as any)} style={{ ...input, marginBottom: 8 }}>
  <option value="none">No header</option>
  <option value="text">Text header</option>
  <option value="image">Image header</option>
</select>
```

Replace with:

```tsx
<select value={headerType} onChange={(e) => setHeaderType(e.target.value as any)} style={{ ...input, marginBottom: 8 }}>
  <option value="none">No header</option>
  <option value="text">Text header</option>
  <option value="media">Image / Video header</option>
</select>
```

- [ ] **Step 2: Update the conditional header content block**

Find this block (around line 445):

```tsx
{headerType === "text" && (
  <input value={headerText} onChange={(e) => setHeaderText(e.target.value)} placeholder="Header text (max 60)" maxLength={60} style={input} />
)}
{headerType === "image" && (
  <>
    <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 6 }}>
      <input type="file" accept="image/*" onChange={handleUpload} disabled={uploading} style={{ fontSize: 13 }} />
      {uploading && <span style={{ fontSize: 12, color: "#9a6700" }}>Uploading…</span>}
    </div>
    <input value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} placeholder="…or paste an image URL" style={input} />
    {mediaUrl && !uploading && (
      <img src={mediaUrl} alt="header preview" style={{ maxHeight: 90, marginTop: 8, borderRadius: 8, border: "1px solid #E4E1DB" }} />
    )}
  </>
)}
```

Replace with:

```tsx
{headerType === "text" && (
  <input value={headerText} onChange={(e) => setHeaderText(e.target.value)} placeholder="Header text (max 60)" maxLength={60} style={input} />
)}
{headerType === "media" && (
  <>
    <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 6 }}>
      <input type="file" accept="image/*,video/mp4" onChange={handleUpload} disabled={uploading} style={{ fontSize: 13 }} />
      {uploading && <span style={{ fontSize: 12, color: "#9a6700" }}>Uploading…</span>}
    </div>
    <input
      value={mediaUrl}
      onChange={(e) => {
        const val = e.target.value;
        setMediaUrl(val);
        setMediaIsVideo(/\.(mp4|mov|webm)$/i.test(val));
      }}
      placeholder="…or paste an image or video URL"
      style={input}
    />
    {mediaUrl && !uploading && (
      mediaIsVideo
        ? <video src={mediaUrl} controls style={{ width: "100%", maxHeight: 160, marginTop: 8, borderRadius: 8, border: "1px solid #E4E1DB" }} />
        : <img src={mediaUrl} alt="header preview" style={{ maxHeight: 90, marginTop: 8, borderRadius: 8, border: "1px solid #E4E1DB" }} />
    )}
  </>
)}
```

- [ ] **Step 3: Update `submit()` — change the `headerType === "image"` guard to `"media"`**

Find inside `submit()` (around line 365):

```ts
if (kind === "card") {
  if (headerType === "text" && headerText) payload.headerText = headerText;
  if (headerType === "image" && mediaUrl) payload.mediaUrl = mediaUrl;
  if (footer) payload.footer = footer;
  payload.buttons = buttons;
}
```

Replace with:

```ts
if (kind === "card") {
  if (headerType === "text" && headerText) payload.headerText = headerText;
  if (headerType === "media" && mediaUrl) payload.mediaUrl = mediaUrl;
  if (footer) payload.footer = footer;
  payload.buttons = buttons;
}
```

- [ ] **Step 4: Commit**

```bash
git add app/templates/page.tsx
git commit -m "feat: update header dropdown and inline preview for image/video"
```

---

### Task 4: Update PhonePreview to render video or image

**Files:**
- Modify: `app/templates/page.tsx`

- [ ] **Step 1: Update the `PhonePreview` function signature to accept `mediaIsVideo`**

Find the `PhonePreview` function signature (around line 553):

```tsx
function PhonePreview({ kind, headerType, headerText, mediaUrl, body, footer, buttons, vars }: {
  kind: string; headerType: string; headerText: string; mediaUrl: string; body: string; footer: string; buttons: Btn[]; vars: Record<string, string>;
}) {
```

Replace with:

```tsx
function PhonePreview({ kind, headerType, headerText, mediaUrl, mediaIsVideo, body, footer, buttons, vars }: {
  kind: string; headerType: string; headerText: string; mediaUrl: string; mediaIsVideo: boolean; body: string; footer: string; buttons: Btn[]; vars: Record<string, string>;
}) {
```

- [ ] **Step 2: Update the image render line inside `PhonePreview`**

Find (around line 568):

```tsx
{kind === "card" && headerType === "image" && mediaUrl && <img src={mediaUrl} alt="" style={{ width: "100%", borderRadius: 6, marginBottom: 6, display: "block" }} />}
```

Replace with:

```tsx
{kind === "card" && headerType === "media" && mediaUrl && (
  mediaIsVideo
    ? <video src={mediaUrl} muted playsInline style={{ width: "100%", borderRadius: 6, marginBottom: 6, display: "block" }} />
    : <img src={mediaUrl} alt="" style={{ width: "100%", borderRadius: 6, marginBottom: 6, display: "block" }} />
)}
```

- [ ] **Step 3: Pass `mediaIsVideo` into the `<PhonePreview>` call**

Find the `<PhonePreview>` usage at the bottom of `NewTemplate` (around line 547):

```tsx
<PhonePreview kind={kind} headerType={headerType} headerText={headerText} mediaUrl={mediaUrl} body={body} footer={footer} buttons={buttons} vars={varDefaults} />
```

Replace with:

```tsx
<PhonePreview kind={kind} headerType={headerType} headerText={headerText} mediaUrl={mediaUrl} mediaIsVideo={mediaIsVideo} body={body} footer={footer} buttons={buttons} vars={varDefaults} />
```

- [ ] **Step 4: Commit**

```bash
git add app/templates/page.tsx
git commit -m "feat: render video in phone preview for video header templates"
```

---

### Task 5: Manual verification

- [ ] **Step 1: Run the dev server**

```bash
cd "c:/Users/Zek/Documents/Claude/Projects/ERE WhatsApp"
npm run dev
```

Open `http://localhost:3000/templates`

- [ ] **Step 2: Verify image header still works**

1. Click "+ New template" → select "WhatsApp Card"
2. Header dropdown → "Image / Video header"
3. Upload a PNG file
4. Confirm: inline preview shows `<img>`, phone mockup shows the image
5. Confirm: no errors in console

- [ ] **Step 3: Verify video header upload**

1. Header dropdown → "Image / Video header"
2. Upload an MP4 file (≤16 MB, H.264/AAC)
3. Confirm: inline preview shows `<video controls>`
4. Confirm: phone mockup shows the video (muted, no controls)
5. Confirm: no errors in console

- [ ] **Step 4: Verify manual URL paste**

1. Clear the file input, paste a `.mp4` URL into the URL field
2. Confirm: preview switches to `<video>`
3. Paste an image URL (`.jpg` / `.png`) 
4. Confirm: preview switches back to `<img>`

- [ ] **Step 5: Verify upload API rejects wrong types**

Using curl or browser devtools, POST to `/api/upload` with a `.mov` file and `kind=card`:
```
Expected response: 400 { "error": "Image or MP4 video files only" }
```

- [ ] **Step 6: Verify size cap**

Attempt to upload an MP4 > 16 MB:
```
Expected response: 400 { "error": "File must be under 16 MB" }
```

- [ ] **Step 7: Final commit and push**

```bash
git push
```

Vercel auto-deploys on push to main. Confirm the deploy succeeds in the Vercel dashboard.
