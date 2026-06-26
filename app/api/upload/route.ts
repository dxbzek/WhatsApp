import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "template-media";

// Accepts a multipart image upload, stores it in a public Supabase Storage
// bucket, and returns a public URL usable as a WhatsApp card header.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    const kind = String(form.get("kind") || "card"); // "card" (image only) | "chat" (image + pdf)
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
    // Idempotent: ignore "already exists" on repeat calls.
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
