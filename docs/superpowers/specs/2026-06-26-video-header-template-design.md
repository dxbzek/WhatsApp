# Video Header Support in WhatsApp Template Builder

**Date:** 2026-06-26
**Status:** Approved

## Goal

Allow WhatsApp card templates to use a video (MP4) as the header media, in addition to the existing image (PNG/JPG) support. The merged "Image / Video header" option detects the media type automatically — no separate dropdown entry needed.

## Scope

2 files changed. No changes to the template creation API, send flow, or submit scripts.

---

## 1. `/app/api/upload/route.ts`

Add `video/mp4` as an accepted MIME type when `kind === "card"`.

**Acceptance rules (card kind):**
- `image/*` → accepted, 5 MB cap
- `video/mp4` → accepted, 16 MB cap
- anything else → rejected with "Image or MP4 video files only"

**Storage:**
- Same `template-media` Supabase bucket
- Same `cards/` folder prefix
- Key pattern unchanged: `cards/{timestamp}-{random}.{ext}`
- Content-type passed through as-is (`video/mp4`) so Supabase serves the file with correct headers (required for Meta to detect VIDEO header type)

**`kind === "chat"` behaviour:** unchanged (images + PDF only).

---

## 2. `app/templates/page.tsx`

### State changes

| Before | After |
|--------|-------|
| `headerType: "none" \| "text" \| "image"` | `headerType: "none" \| "text" \| "media"` |
| — | `mediaIsVideo: boolean` (new, default `false`) |

### Dropdown label

`"Image header"` → `"Image / Video header"` (option value `"media"`)

### File input

```
accept="image/*,video/mp4"
```

### Upload handler (`handleUpload`)

After a successful upload, detect media type from `file.type`:

```ts
setMediaIsVideo(file.type.startsWith("video/"));
```

### Manual URL paste

When user edits the URL input directly, infer type from URL suffix:

```ts
const isVid = /\.(mp4|mov|webm)$/i.test(val);
setMediaIsVideo(isVid);
setMediaUrl(val);
```

### Header preview (inline in `NewTemplate`)

```tsx
{headerType === "media" && mediaUrl && !uploading && (
  mediaIsVideo
    ? <video src={mediaUrl} controls style={{ width: "100%", marginTop: 8, borderRadius: 8, border: "1px solid #E4E1DB" }} />
    : <img src={mediaUrl} alt="header preview" style={{ maxHeight: 90, marginTop: 8, borderRadius: 8, border: "1px solid #E4E1DB" }} />
)}
```

### `submit()` payload

No change — `payload.mediaUrl` already goes as-is to the API. The API puts it in `media: [mediaUrl]`. Meta reads the file's content-type from the hosted URL to determine IMAGE vs VIDEO header.

### `PhonePreview` component

Add `mediaIsVideo: boolean` prop. Where it currently renders `<img>` for the card image header, switch on the new prop:

```tsx
{kind === "card" && headerType === "media" && mediaUrl && (
  mediaIsVideo
    ? <video src={mediaUrl} style={{ width: "100%", borderRadius: 6, marginBottom: 6, display: "block" }} muted playsInline />
    : <img src={mediaUrl} alt="" style={{ width: "100%", borderRadius: 6, marginBottom: 6, display: "block" }} />
)}
```

(`muted playsInline` so it auto-plays silently in the phone mockup, matching how WhatsApp renders video headers in previews.)

---

## What does NOT change

- `app/api/templates/route.ts` — already passes `media: [mediaUrl]` unchanged
- Send / dispatch / campaign flow — no changes
- Standalone submit scripts in `01 - Scripts/` — no changes
- `kind === "chat"` upload path — no changes

---

## Meta / Twilio requirements for video headers

- Format: MP4, H.264 video + AAC audio
- Max size: 16 MB
- The hosted file must be served with `Content-Type: video/mp4` (Supabase does this when uploaded with that content-type)
- Meta determines IMAGE vs VIDEO header from the file content-type at the URL — no explicit "header_type" field is needed in the Twilio `whatsapp/card` payload
- Template still goes through normal Meta approval (24-48 hrs), same as image-header templates
