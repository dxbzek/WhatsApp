import { NextRequest, NextResponse } from "next/server";
import { twilioGet, twilioContentPost, twilioContentDelete, marketingAuthHeader } from "@/lib/twilio";
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
// authHeader targets a specific lane's (sub)account; defaults to the utility creds.
async function twilioList(start: string, key: string, authHeader?: string) {
  const items: any[] = [];
  let url: string | null = start;
  let guard = 0;
  while (url && guard++ < 40) {
    const data: any = await twilioGet(url, authHeader);
    for (const c of data[key] || []) items.push(c);
    url = data.meta?.next_page_url || null;
  }
  return items;
}

// List one lane's templates (Content = authoritative existence; ContentAndApprovals
// merged in only for status, which is eventually consistent). Tags each with `lane`.
async function listLane(lane: "utility" | "marketing", authHeader?: string) {
  const [contents, approvals] = await Promise.all([
    twilioList("https://content.twilio.com/v1/Content?PageSize=50", "contents", authHeader),
    twilioList("https://content.twilio.com/v1/ContentAndApprovals?PageSize=50", "contents", authHeader).catch(() => []),
  ]);
  const approvalBySid = new Map<string, any>();
  for (const a of approvals) if (a?.sid) approvalBySid.set(a.sid, a.approval_requests || {});
  return contents.map((c: any) => {
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
      lane, // which sending lane/number owns this template
    };
  });
}

// Lists templates from BOTH lanes (utility + marketing subaccounts) so the console
// shows and can differentiate them. The marketing lane is skipped gracefully when
// TWILIO_MKT_* is not configured (console degrades to utility-only).
export async function GET() {
  try {
    const mkt = marketingAuthHeader();
    const [utility, marketing] = await Promise.all([
      listLane("utility"),
      mkt ? listLane("marketing", mkt) : Promise.resolve([] as any[]),
    ]);
    const out = [...utility, ...marketing];
    // newest first
    out.sort((a, b) => String(b.updated || "").localeCompare(String(a.updated || "")));
    return NextResponse.json({ templates: out, marketingLane: !!mkt });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Failed to load templates" }, { status: 500 });
  }
}

// Create a Content template and submit it for WhatsApp approval.
// Body: { name, language?, category, kind: "text"|"card"|"quick-reply",
//         body?, title?, mediaUrl?, buttons?: [{type,title,url?,phone?}],
//         variables?: { "1": "sample", ... } }
// A MARKETING template is created on the MARKETING lane (its own number); UTILITY on
// the utility lane. This keeps each template on the account that actually sends it.
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

    // Route the create to the lane that will actually send it: MARKETING category ->
    // marketing subaccount (if configured), else the utility lane.
    const mkt = marketingAuthHeader();
    const laneAuth = category.toUpperCase() === "MARKETING" && mkt ? mkt : undefined;

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

    // 1) Create the content on the chosen lane
    const content: any = await twilioContentPost("/v1/Content", {
      friendly_name: name,
      language,
      ...(b.variables && Object.keys(b.variables).length ? { variables: b.variables } : {}),
      types,
    }, laneAuth);

    // 2) Submit for WhatsApp approval (same lane)
    let approval: any = null;
    let approvalError: string | null = null;
    try {
      approval = await twilioContentPost(`/v1/Content/${content.sid}/ApprovalRequests/whatsapp`, {
        name,
        category,
      }, laneAuth);
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
      lane: laneAuth ? "marketing" : "utility",
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

// Resolve which lane owns a Content SID: try utility first, then marketing. Returns
// the auth header for that lane (undefined = utility) or throws if found on neither.
async function laneAuthForSid(sid: string): Promise<string | undefined> {
  try {
    await twilioGet(`https://content.twilio.com/v1/Content/${sid}`);
    return undefined; // utility lane
  } catch {
    const mkt = marketingAuthHeader();
    if (mkt) {
      await twilioGet(`https://content.twilio.com/v1/Content/${sid}`, mkt);
      return mkt; // marketing lane
    }
    throw new Error("Template not found on any lane");
  }
}

// Delete a template (Content + its approval) on whichever lane owns it.
// DELETE /api/templates?sid=HX...
export async function DELETE(req: NextRequest) {
  try {
    const sid = req.nextUrl.searchParams.get("sid");
    if (!sid) return NextResponse.json({ error: "sid is required" }, { status: 400 });
    const auth = await laneAuthForSid(sid);
    await twilioContentDelete(`/v1/Content/${sid}`, auth);
    return NextResponse.json({ deleted: sid });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Failed to delete template" }, { status: 500 });
  }
}

// Clone an existing template's content under a new name on the SAME lane, then
// resubmit for approval on that lane.
async function duplicate(sid: string, rawName: string, rawCategory?: string) {
  const auth = await laneAuthForSid(sid);
  const orig: any = await twilioGet(`https://content.twilio.com/v1/Content/${sid}`, auth);
  const name = (rawName || `${orig.friendly_name}_copy`).trim();
  if (!/^[a-z0-9_]+$/.test(name))
    return NextResponse.json({ error: "Name must be lowercase letters, numbers and underscores only" }, { status: 400 });

  const content: any = await twilioContentPost("/v1/Content", {
    friendly_name: name,
    language: orig.language || "en",
    ...(orig.variables && Object.keys(orig.variables).length ? { variables: orig.variables } : {}),
    types: orig.types,
  }, auth);

  // Resubmit for WhatsApp approval (a clone needs its own approval).
  let approvalError: string | null = null;
  let approval: any = null;
  try {
    approval = await twilioContentPost(`/v1/Content/${content.sid}/ApprovalRequests/whatsapp`, {
      name,
      category: rawCategory || "MARKETING",
    }, auth);
  } catch (e: any) {
    approvalError = e.message || "Approval submission failed";
  }

  return NextResponse.json({
    sid: content.sid,
    name,
    lane: auth ? "marketing" : "utility",
    duplicatedFrom: sid,
    submitted: !approvalError,
    status: approval?.status || (approvalError ? "unsubmitted" : "received"),
    approvalError,
  });
}
