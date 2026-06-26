import { NextRequest, NextResponse } from "next/server";
import { twilioGet, twilioContentPost, twilioContentDelete } from "@/lib/twilio";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Parse a Content resource's `types` block into the fields the UI renders.
function parseContent(c: any) {
  const types = c.types || {};
  const typeKey = Object.keys(types)[0] || null;
  const t = (typeKey ? types[typeKey] : null) || {};
  const actions = t.actions || [];
  // Quick-reply button titles - these become the tappable keyword triggers
  const replyButtons = actions
    .filter((a: any) => (a?.type || "").toUpperCase() === "QUICK_REPLY")
    .map((a: any) => a.title)
    .filter(Boolean);
  // Header image (real URL only - skip variable placeholders like "{{1}}")
  const rawMedia = Array.isArray(t.media) ? t.media[0] : t.media;
  const media = typeof rawMedia === "string" && /^https?:\/\//i.test(rawMedia) ? rawMedia : null;
  // Full button list (type/title/url/phone) so the preview can render them
  const buttons = actions
    .map((a: any) => ({ type: (a?.type || "").toUpperCase(), title: a?.title || "", url: a?.url || null, phone: a?.phone || null }))
    .filter((b: any) => b.title);
  return {
    type: typeKey, // e.g. whatsapp/card, whatsapp/text
    variables: c.variables || {},
    body: t.body || null,
    media,
    headerText: t.header_text || null,
    footer: t.footer || null,
    buttons,
    replyButtons,
  };
}

// Page through a Content API list endpoint, collecting items from `key`.
async function twilioList(start: string, key: string) {
  const items: any[] = [];
  let url: string | null = start;
  let guard = 0;
  while (url && guard++ < 40) {
    const data: any = await twilioGet(url);
    for (const c of data[key] || []) items.push(c);
    url = data.meta?.next_page_url || null;
  }
  return items;
}

// Lists templates from /v1/Content (the authoritative record - never drops an item)
// and merges WhatsApp approval status from /v1/ContentAndApprovals as a lookup.
// ContentAndApprovals is eventually consistent and can omit a template whose status
// just changed; using it only for status (not existence) stops templates vanishing.
export async function GET() {
  try {
    const [contents, approvals] = await Promise.all([
      twilioList("https://content.twilio.com/v1/Content?PageSize=50", "contents"),
      twilioList("https://content.twilio.com/v1/ContentAndApprovals?PageSize=50", "contents").catch(() => []),
    ]);
    // sid -> approval_requests
    const approvalBySid = new Map<string, any>();
    for (const a of approvals) if (a?.sid) approvalBySid.set(a.sid, a.approval_requests || {});

    const out = contents.map((c: any) => {
      const approval = approvalBySid.get(c.sid) || {};
      const parsed = parseContent(c);
      return {
        sid: c.sid,
        name: c.friendly_name,
        language: c.language,
        ...parsed,
        category: approval.category || null,
        status: approval.status || "unsubmitted", // approved | pending | rejected | received | ...
        rejection_reason: approval.rejection_reason || null,
        updated: c.date_updated,
      };
    });
    // newest first
    out.sort((a, b) => String(b.updated || "").localeCompare(String(a.updated || "")));
    return NextResponse.json({ templates: out });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Failed to load templates" }, { status: 500 });
  }
}

// Create a Content template and submit it for WhatsApp approval.
// Body: { name, language?, category, kind: "text"|"card"|"quick-reply",
//         body?, title?, mediaUrl?, buttons?: [{type,title,url?,phone?}],
//         variables?: { "1": "sample", ... } }
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();

    // Duplicate: clone an existing template's content under a new name.
    if (b.duplicateOf) {
      return await duplicate(b.duplicateOf, b.name, b.category);
    }

    const name: string = (b.name || "").trim();
    const language: string = (b.language || "en").trim();
    const category: string = (b.category || "MARKETING").trim();
    const kind: string = b.kind;

    if (!name) return NextResponse.json({ error: "Template name is required" }, { status: 400 });
    if (!/^[a-z0-9_]+$/.test(name))
      return NextResponse.json({ error: "Name must be lowercase letters, numbers and underscores only" }, { status: 400 });

    // Build the Content "types" payload from the chosen kind.
    let types: any;
    if (kind === "text") {
      if (!b.body) return NextResponse.json({ error: "Body is required for a text template" }, { status: 400 });
      types = { "twilio/text": { body: b.body } };
    } else if (kind === "card") {
      if (!b.body) return NextResponse.json({ error: "Body is required for a card template" }, { status: 400 });
      const actions = (b.buttons || []).map((x: any) => mapAction(x)).filter(Boolean);
      types = {
        "whatsapp/card": {
          body: b.body,
          ...(b.headerText ? { header_text: b.headerText } : {}),
          ...(b.mediaUrl ? { media: [b.mediaUrl] } : {}),
          ...(b.footer ? { footer: b.footer } : {}),
          ...(actions.length ? { actions } : {}),
        },
      };
    } else if (kind === "quick-reply") {
      if (!b.body) return NextResponse.json({ error: "Body is required for a quick-reply template" }, { status: 400 });
      const actions = (b.buttons || [])
        .filter((x: any) => (x.title || "").trim())
        .slice(0, 3)
        .map((x: any, i: number) => ({ id: x.id || `btn_${i + 1}`, title: x.title }));
      if (!actions.length) return NextResponse.json({ error: "Add at least one quick-reply button" }, { status: 400 });
      types = { "twilio/quick-reply": { body: b.body, actions } };
    } else {
      return NextResponse.json({ error: "Unknown template kind" }, { status: 400 });
    }

    // 1) Create the content
    const content: any = await twilioContentPost("/v1/Content", {
      friendly_name: name,
      language,
      ...(b.variables && Object.keys(b.variables).length ? { variables: b.variables } : {}),
      types,
    });

    // 2) Submit for WhatsApp approval
    let approval: any = null;
    let approvalError: string | null = null;
    try {
      approval = await twilioContentPost(`/v1/Content/${content.sid}/ApprovalRequests/whatsapp`, {
        name,
        category,
      });
    } catch (e: any) {
      approvalError = e.message || "Approval submission failed";
    }

    // 3) Save per-button auto-reply rules (so a tap auto-responds / pushes to Pipedrive)
    const replyButtons = (b.buttons || []).filter(
      (x: any) => (x.title || "").trim() && (x.auto || x.pushLead) && (kind === "quick-reply" || x.type === "quick-reply")
    );
    if (replyButtons.length) {
      const db = supabaseAdmin();
      for (const x of replyButtons) {
        const trigger = x.title.trim();
        const row = {
          trigger,
          reply: x.auto && x.reply?.trim() ? x.reply.trim() : null,
          push_pipedrive: !!x.pushLead,
          block: false,
          enabled: true,
        };
        // upsert by trigger (case-insensitive) so re-creating doesn't duplicate
        const { data: existing } = await db.from("auto_replies").select("id").ilike("trigger", trigger).maybeSingle();
        if (existing?.id) await db.from("auto_replies").update(row).eq("id", existing.id);
        else await db.from("auto_replies").insert(row);
      }
    }

    return NextResponse.json({
      sid: content.sid,
      name,
      submitted: !approvalError,
      status: approval?.status || (approvalError ? "unsubmitted" : "received"),
      approvalError,
      autoReplies: replyButtons.length,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Failed to create template" }, { status: 500 });
  }
}

// WhatsApp card buttons: URL, PHONE_NUMBER, or QUICK_REPLY.
function mapAction(x: any) {
  const title = (x.title || "").trim();
  if (!title) return null;
  if (x.type === "url" && x.url) return { type: "URL", title, url: x.url };
  if (x.type === "phone" && x.phone) return { type: "PHONE_NUMBER", title, phone: x.phone };
  if (x.type === "quick-reply") return { type: "QUICK_REPLY", title, id: x.id || title.toLowerCase().replace(/\s+/g, "_") };
  return null;
}

// Delete a template (Content + its approval). DELETE /api/templates?sid=HX...
export async function DELETE(req: NextRequest) {
  try {
    const sid = req.nextUrl.searchParams.get("sid");
    if (!sid) return NextResponse.json({ error: "sid is required" }, { status: 400 });
    await twilioContentDelete(`/v1/Content/${sid}`);
    return NextResponse.json({ deleted: sid });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Failed to delete template" }, { status: 500 });
  }
}

// Clone an existing template's content under a new name, then resubmit for approval.
async function duplicate(sid: string, rawName: string, rawCategory?: string) {
  const orig: any = await twilioGet(`https://content.twilio.com/v1/Content/${sid}`);
  const name = (rawName || `${orig.friendly_name}_copy`).trim();
  if (!/^[a-z0-9_]+$/.test(name))
    return NextResponse.json({ error: "Name must be lowercase letters, numbers and underscores only" }, { status: 400 });

  const content: any = await twilioContentPost("/v1/Content", {
    friendly_name: name,
    language: orig.language || "en",
    ...(orig.variables && Object.keys(orig.variables).length ? { variables: orig.variables } : {}),
    types: orig.types,
  });

  // Resubmit for WhatsApp approval (a clone needs its own approval).
  let approvalError: string | null = null;
  let approval: any = null;
  try {
    approval = await twilioContentPost(`/v1/Content/${content.sid}/ApprovalRequests/whatsapp`, {
      name,
      category: rawCategory || "MARKETING",
    });
  } catch (e: any) {
    approvalError = e.message || "Approval submission failed";
  }

  return NextResponse.json({
    sid: content.sid,
    name,
    duplicatedFrom: sid,
    submitted: !approvalError,
    status: approval?.status || (approvalError ? "unsubmitted" : "received"),
    approvalError,
  });
}
