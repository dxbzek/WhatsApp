"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

type Tpl = {
  sid: string;
  name: string;
  language: string;
  type: string | null;
  category: string | null;
  status: string;
  rejection_reason: string | null;
  variables: Record<string, string>;
  body: string | null;
  replyButtons: string[];
  updated: string;
};

const STATUS_COLOR: Record<string, string> = {
  approved: "#137333",
  pending: "#9a6700",
  received: "#9a6700",
  rejected: "#b00020",
  unsubmitted: "#6B6862",
};

// WhatsApp template language codes, weighted to ERE's Dubai audience.
const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "en_GB", label: "English (UK)" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
  { code: "ur", label: "Urdu" },
  { code: "fa", label: "Persian / Farsi" },
  { code: "ru", label: "Russian" },
  { code: "fr", label: "French" },
  { code: "fil", label: "Filipino" },
  { code: "zh_CN", label: "Chinese (Simplified)" },
  { code: "es", label: "Spanish" },
  { code: "de", label: "German" },
];

export default function Templates() {
  const [tpls, setTpls] = useState<Tpl[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [autoFor, setAutoFor] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set()); // expanded template cards
  const toggle = (sid: string) => setOpen((p) => { const n = new Set(p); n.has(sid) ? n.delete(sid) : n.add(sid); return n; });
  const [seed, setSeed] = useState<any>(null); // prefill for the create form (from Duplicate)

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/templates");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setTpls(data.templates || []);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  const [busySid, setBusySid] = useState<string | null>(null);

  async function deleteTpl(t: Tpl) {
    if (!confirm(`Delete template "${t.name}"? This removes it from Twilio and cannot be undone.`)) return;
    setBusySid(t.sid);
    setErr(null);
    try {
      const res = await fetch(`/api/templates?sid=${encodeURIComponent(t.sid)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Delete failed");
      setTpls((prev) => prev.filter((x) => x.sid !== t.sid));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusySid(null);
    }
  }

  // Duplicate = open the create form pre-filled with this template's content,
  // so it can be edited before submitting (nothing is created until you submit).
  function duplicateTpl(t: Tpl) {
    const type = (t.type || "").toLowerCase();
    const kind = type.includes("card") ? "card" : (t.replyButtons.length || type.includes("quick")) ? "quick-reply" : "text";
    setSeed({
      kind,
      name: `${t.name}_copy`.toLowerCase().replace(/[^a-z0-9_]/g, "_"),
      category: t.category || "MARKETING",
      language: t.language || "en",
      body: t.body || "",
      buttons: kind === "quick-reply" ? t.replyButtons.map((title) => ({ type: "quick-reply", title })) : [],
      varDefaults: t.variables || {},
    });
    setShowNew(true);
    // Scroll the form into view (the app scrolls an inner container, not window).
    setTimeout(() => document.getElementById("tpl-form-top")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  }

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "28px 24px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <h1 style={{ fontFamily: "Georgia, serif", fontWeight: 400, fontSize: 24, margin: 0 }}>
          WhatsApp Templates
        </h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Link href="/templates/performance" style={{ fontSize: 13, color: "#6B6862", textDecoration: "none", whiteSpace: "nowrap" }}>Performance →</Link>
          <button onClick={() => { if (!showNew) setSeed(null); setShowNew((s) => !s); }} style={{ ...btn, background: showNew ? "#6B6862" : "#137333" }}>
            {showNew ? "Close" : "+ New template"}
          </button>
          <button onClick={load} style={btn}>{loading ? "Loading…" : "Refresh"}</button>
        </div>
      </div>

      {showNew && (
        <NewTemplate
          key={seed ? seed.name : "new"}
          seed={seed}
          onCreated={() => {
            setShowNew(false);
            setSeed(null);
            load();
          }}
        />
      )}

      {err && <div style={errBox}>{err}</div>}
      {!err && !loading && tpls.length === 0 && (
        <div style={{ color: "#6B6862" }}>No content templates found on this Twilio account.</div>
      )}

      <div style={{ display: "grid", gap: 12 }}>
        {tpls.map((t) => (
          <div key={t.sid} style={card}>
            <div onClick={() => toggle(t.sid)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, cursor: "pointer" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <span style={{ color: "#9a958c", fontSize: 12, transform: open.has(t.sid) ? "rotate(90deg)" : "none", transition: "transform .15s", flexShrink: 0 }}>▶</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</div>
                  {open.has(t.sid) && <div style={{ fontSize: 12, color: "#9a958c", marginTop: 2 }}>{t.sid} · {t.type || "-"} · {t.language || "-"}</div>}
                </div>
              </div>
              <span
                style={{
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 1,
                  color: "#fff",
                  background: STATUS_COLOR[t.status] || "#6B6862",
                  padding: "4px 10px",
                  borderRadius: 20,
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                {t.status}
              </span>
            </div>

            {open.has(t.sid) && (
              <>
                {t.category && (
                  <div style={{ fontSize: 12, color: "#6B6862", marginTop: 8 }}>Category: {t.category}</div>
                )}
                {t.body && (
                  <div style={{ marginTop: 10, padding: 12, background: "#F5F5F5", borderRadius: 8, fontSize: 14, whiteSpace: "pre-wrap" }}>
                    {t.body}
                  </div>
                )}
                {Object.keys(t.variables || {}).length > 0 && (
                  <div style={{ fontSize: 12, color: "#6B6862", marginTop: 8 }}>
                    Variables: {Object.entries(t.variables).map(([k, v]) => `{{${k}}}=${v}`).join(", ")}
                  </div>
                )}
                {t.rejection_reason && (
                  <div style={{ fontSize: 12, color: "#b00020", marginTop: 8 }}>
                    Rejected: {t.rejection_reason}
                  </div>
                )}

                <div style={{ display: "flex", gap: 8, marginTop: 14, borderTop: "1px solid #F0EEE9", paddingTop: 12, flexWrap: "wrap" }}>
                  {t.replyButtons.length > 0 && (
                    <button onClick={() => setAutoFor(autoFor === t.sid ? null : t.sid)} style={{ ...action, fontWeight: 600 }}>
                      {autoFor === t.sid ? "Hide auto-replies" : `Auto-replies (${t.replyButtons.length})`}
                    </button>
                  )}
                  <button onClick={() => duplicateTpl(t)} disabled={busySid === t.sid} style={action}>
                    {busySid === t.sid ? "…" : "Duplicate"}
                  </button>
                  <button onClick={() => deleteTpl(t)} disabled={busySid === t.sid} style={{ ...action, color: "#b00020", borderColor: "#f0c5c0" }}>
                    Delete
                  </button>
                </div>

                {autoFor === t.sid && <AutoReplyConfig buttons={t.replyButtons} />}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Template-first auto-reply setup: shows the selected template's reply
// buttons (keywords) and lets you set what each one replies with.
function AutoReplyConfig({ buttons }: { buttons: string[] }) {
  const [rules, setRules] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [savedKey, setSavedKey] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/auto-replies");
    const d = await res.json();
    const byTrigger: Record<string, any> = {};
    for (const r of d.rules || []) byTrigger[(r.trigger || "").toLowerCase()] = r;
    const map: Record<string, any> = {};
    for (const b of buttons) {
      const ex = byTrigger[b.toLowerCase()];
      map[b] = ex
        ? { id: ex.id, reply: ex.reply || "", push_pipedrive: !!ex.push_pipedrive, block: !!ex.block, enabled: ex.enabled !== false }
        : { reply: "", push_pipedrive: false, block: false, enabled: true };
    }
    setRules(map);
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  async function save(trigger: string) {
    const r = rules[trigger];
    const res = await fetch("/api/auto-replies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: r.id, trigger, reply: r.reply, push_pipedrive: r.push_pipedrive, block: r.block, enabled: r.enabled }),
    });
    const d = await res.json();
    if (res.ok) { setRules({ ...rules, [trigger]: { ...r, id: d.rule.id } }); setSavedKey(trigger); setTimeout(() => setSavedKey(null), 1500); }
    else alert(d.error || "Save failed");
  }
  function set(trigger: string, patch: any) { setRules({ ...rules, [trigger]: { ...rules[trigger], ...patch } }); }

  return (
    <div style={{ marginTop: 12, padding: 14, background: "#FFFFFF", border: "1px solid #F0EEE9", borderRadius: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Auto-replies for this template’s buttons</div>
      <div style={{ fontSize: 12, color: "#6B6862", marginBottom: 10 }}>When a contact taps a button, the app sends the reply (and optionally creates a Pipedrive lead).</div>
      {loading && <div style={{ color: "#6B6862", fontSize: 13 }}>Loading…</div>}
      {!loading && buttons.map((b) => {
        const r = rules[b] || {};
        return (
          <div key={b} style={{ borderTop: "1px solid #F0EEE9", paddingTop: 10, marginTop: 10 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>Keyword: “{b}”</div>
            <textarea value={r.reply || ""} onChange={(e) => set(b, { reply: e.target.value })} rows={2} placeholder="Reply sent automatically when this button is tapped…" style={{ ...input, resize: "vertical" }} />
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", marginTop: 4 }}>
              <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center", cursor: "pointer", color: "#137333" }}>
                <input type="checkbox" checked={!!r.push_pipedrive} onChange={(e) => set(b, { push_pipedrive: e.target.checked })} /> Create Hot lead in Pipedrive
              </label>
              <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center", cursor: "pointer", color: "#b00020" }}>
                <input type="checkbox" checked={!!r.block} onChange={(e) => set(b, { block: e.target.checked })} /> Block (opt-out)
              </label>
              <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                <input type="checkbox" checked={r.enabled !== false} onChange={(e) => set(b, { enabled: e.target.checked })} /> Enabled
              </label>
              <button onClick={() => save(b)} style={{ ...pillActive, padding: "6px 16px", borderRadius: 8, cursor: "pointer", border: "none" }}>
                {savedKey === b ? "Saved ✓" : "Save"}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

type Btn = {
  type: "url" | "phone" | "quick-reply";
  title: string;
  url?: string;
  phone?: string;
  auto?: boolean; // auto-reply when this button is tapped
  reply?: string; // the auto-reply text
  pushLead?: boolean; // create a Hot lead in Pipedrive on tap
};

function NewTemplate({ onCreated, seed }: { onCreated: () => void; seed?: any }) {
  // Card templates start from a ready scaffold: image header + 3 buttons.
  // (Applies to both a brand-new card and a duplicated card, since header/
  // buttons aren't carried over in the list data.) Quick-reply keeps its
  // copied buttons; text gets none.
  const DEFAULT_BUTTONS: Btn[] = [
    { type: "quick-reply", title: "" },
    { type: "quick-reply", title: "" },
    { type: "quick-reply", title: "" },
  ];
  const initialKind: "text" | "card" | "quick-reply" = seed?.kind ?? "card";
  const isBtnKind = initialKind === "card" || initialKind === "quick-reply";
  const [kind, setKind] = useState<"text" | "card" | "quick-reply">(initialKind);
  const [name, setName] = useState(seed?.name ?? "");
  const [category, setCategory] = useState(seed?.category ?? "MARKETING");
  const [language, setLanguage] = useState(seed?.language ?? "en");
  const [body, setBody] = useState(seed?.body ?? "");
  const [headerType, setHeaderType] = useState<"none" | "text" | "media">(initialKind === "card" ? "media" : "none");
  const [headerText, setHeaderText] = useState("");
  const [footer, setFooter] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [mediaIsVideo, setMediaIsVideo] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [buttons, setButtons] = useState<Btn[]>(seed?.buttons?.length ? seed.buttons : (isBtnKind ? DEFAULT_BUTTONS : []));
  const [varDefaults, setVarDefaults] = useState<Record<string, string>>(seed?.varDefaults ?? {});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Detect {{1}}, {{2}}… across all text fields so we can offer a default per variable.
  const detectedVars = Array.from(
    new Set([...`${body} ${headerText} ${footer}`.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1]))
  ).sort((a, b) => Number(a) - Number(b));

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

  const maxButtons = 3;
  function addButton() {
    if (buttons.length >= maxButtons) return;
    setButtons([...buttons, { type: "quick-reply", title: "" }]);
  }
  function setBtn(i: number, patch: Partial<Btn>) {
    setButtons(buttons.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));
  }

  async function submit() {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      const payload: any = { name, category, language, kind };
      // Default values for any {{n}} the recipient may be missing
      const vars: Record<string, string> = {};
      for (const k of detectedVars) if ((varDefaults[k] || "").trim()) vars[k] = varDefaults[k].trim();
      if (Object.keys(vars).length) payload.variables = vars;
      payload.body = body;
      if (kind === "card") {
        if (headerType === "text" && headerText) payload.headerText = headerText;
        if (headerType === "media" && mediaUrl) payload.mediaUrl = mediaUrl;
        if (footer) payload.footer = footer;
        payload.buttons = buttons;
      }
      if (kind === "quick-reply") {
        payload.buttons = buttons;
      }
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      if (data.approvalError) {
        setMsg(`Created ${data.sid}, but approval submit failed: ${data.approvalError}`);
      } else {
        setMsg(`Submitted "${data.name}" - status: ${data.status}. Refreshing…`);
        setTimeout(onCreated, 900);
      }
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="tpl-form-top" style={{ ...card, marginBottom: 18, background: "#FFFFFF", scrollMarginTop: 12, display: "flex", gap: 22, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 440px", minWidth: 0 }}>
      <div style={{ fontWeight: 600, marginBottom: 14 }}>{seed ? "Duplicate template - edit, then submit" : "New WhatsApp template"}</div>
      {seed && kind === "card" && (
        <div style={{ fontSize: 12, color: "#9a6700", background: "#FFF8E6", border: "1px solid #F0E2B8", borderRadius: 8, padding: "8px 12px", marginBottom: 12 }}>
          Card header image, footer and buttons aren’t carried over - re-add them below before submitting.
        </div>
      )}

      {/* Type selector */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {([["text", "Text"], ["card", "WhatsApp Card"], ["quick-reply", "Quick Reply"]] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => { setKind(k); setButtons([]); }}
            style={{ ...pill, ...(kind === k ? pillActive : {}) }}
          >
            {label}
          </button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
        <Field label="Name (a-z, 0-9, _)">
          <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="property_offer_v2" style={input} />
        </Field>
        <Field label="Category">
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={input}>
            <option>MARKETING</option>
            <option>UTILITY</option>
          </select>
        </Field>
        <Field label="Language">
          <select value={language} onChange={(e) => setLanguage(e.target.value)} style={input}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </Field>
      </div>

      {/* Card header (text or image) - shown above the body on WhatsApp */}
      {kind === "card" && (
        <>
          <Field label="Header (optional)">
            <select value={headerType} onChange={(e) => setHeaderType(e.target.value as any)} style={{ ...input, marginBottom: 8 }}>
              <option value="none">No header</option>
              <option value="text">Text header</option>
              <option value="media">Image / Video header</option>
            </select>
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
          </Field>
        </>
      )}

      {/* Body - required for every type */}
      <Field label={`Body${kind === "card" ? " (max 1024)" : ""}  ·  use {{1}}, {{2}} for variables`}>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={kind === "card" ? 1024 : undefined} placeholder="Hi {{1}}, here's your update…" style={{ ...input, resize: "vertical" }} />
      </Field>

      {/* Footer - card only */}
      {kind === "card" && (
        <Field label="Footer (optional, max 60)">
          <input value={footer} onChange={(e) => setFooter(e.target.value)} placeholder="ERE Homes · Reply STOP to opt out" maxLength={60} style={input} />
        </Field>
      )}

      {/* Variable defaults - fallback used when the recipient is missing this value */}
      {detectedVars.length > 0 && (
        <div style={{ marginTop: 6, marginBottom: 6 }}>
          <div style={{ fontSize: 12, color: "#6B6862", marginBottom: 6 }}>
            Default values (used if the recipient is missing one)
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 8 }}>
            {detectedVars.map((k) => (
              <div key={k} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, color: "#141414", fontWeight: 600, whiteSpace: "nowrap" }}>{`{{${k}}}`}</span>
                <input
                  value={varDefaults[k] || ""}
                  onChange={(e) => setVarDefaults({ ...varDefaults, [k]: e.target.value })}
                  placeholder={k === "1" ? "e.g. there" : "default"}
                  style={input}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Buttons for card + quick-reply */}
      {(kind === "card" || kind === "quick-reply") && (
        <div style={{ marginTop: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: "#6B6862" }}>
              Buttons {kind === "quick-reply" ? "(quick replies, up to 3)" : "(up to 3 reply, or 2 link/call)"}
            </span>
            <button onClick={addButton} disabled={buttons.length >= maxButtons} style={{ ...pill, padding: "4px 12px" }}>+ Add</button>
          </div>
          {buttons.map((bt, i) => (
            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
              {kind === "card" && (
                <select value={bt.type} onChange={(e) => setBtn(i, { type: e.target.value as any })} style={{ ...input, width: 110, marginBottom: 0 }}>
                  <option value="url">Link</option>
                  <option value="phone">Call</option>
                  <option value="quick-reply">Reply</option>
                </select>
              )}
              <input value={bt.title} onChange={(e) => setBtn(i, { title: e.target.value })} placeholder="Button text" style={{ ...input, flex: 1, marginBottom: 0 }} />
              {kind === "card" && bt.type === "url" && (
                <input value={bt.url || ""} onChange={(e) => setBtn(i, { url: e.target.value })} placeholder="https://…" style={{ ...input, flex: 1, marginBottom: 0 }} />
              )}
              {kind === "card" && bt.type === "phone" && (
                <input value={bt.phone || ""} onChange={(e) => setBtn(i, { phone: e.target.value })} placeholder="+9715…" style={{ ...input, flex: 1, marginBottom: 0 }} />
              )}
              <button onClick={() => setButtons(buttons.filter((_, idx) => idx !== i))} style={{ ...pill, padding: "6px 10px", color: "#b00020" }}>✕</button>
            </div>
          ))}
          {kind === "quick-reply" && (
            <div style={{ fontSize: 12, color: "#9a958c", marginTop: 4 }}>
              Set up what these buttons reply with under “Auto-replies” on the template card after it’s created.
            </div>
          )}
        </div>
      )}

      {err && <div style={{ ...errBox, marginTop: 12 }}>{err}</div>}
      {msg && <div style={{ background: "#e7f4ea", color: "#137333", padding: 12, borderRadius: 8, marginTop: 12, fontSize: 14 }}>{msg}</div>}

      <div style={{ marginTop: 14 }}>
        <button onClick={submit} disabled={busy} style={{ ...btn, background: "#137333" }}>
          {busy ? "Submitting…" : "Create & submit for approval"}
        </button>
        <span style={{ fontSize: 12, color: "#9a958c", marginLeft: 12 }}>
          Goes to Meta for review; status shows here as pending → approved/rejected.
        </span>
      </div>
      </div>

      <PhonePreview kind={kind} headerType={headerType} headerText={headerText} mediaUrl={mediaUrl} mediaIsVideo={mediaIsVideo} body={body} footer={footer} buttons={buttons} vars={varDefaults} />
    </div>
  );
}

// Live WhatsApp-style phone mockup of the template being built.
function PhonePreview({ kind, headerType, headerText, mediaUrl, mediaIsVideo, body, footer, buttons, vars }: {
  kind: string; headerType: string; headerText: string; mediaUrl: string; mediaIsVideo: boolean; body: string; footer: string; buttons: Btn[]; vars: Record<string, string>;
}) {
  const render = (text: string) => (text || "").replace(/\{\{(\d+)\}\}/g, (_, n) => vars[n] || `{{${n}}}`);
  const btns = (kind === "card" || kind === "quick-reply") ? buttons.filter((b) => b.title) : [];
  return (
    <div style={{ flex: "0 0 290px", position: "sticky", top: 12, margin: "0 auto" }}>
      <div style={{ fontSize: 12, color: "#6B6862", marginBottom: 8, textAlign: "center" }}>Preview</div>
      <div style={{ width: 290, border: "9px solid #111", borderRadius: 34, overflow: "hidden", boxShadow: "0 12px 30px rgba(0,0,0,.18)" }}>
        <div style={{ background: "#075E54", color: "#fff", padding: "12px 14px", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 30, height: 30, borderRadius: 30, background: "#cfe9e2", flexShrink: 0 }} />
          <div><div style={{ fontSize: 13, fontWeight: 600 }}>ERE Homes</div><div style={{ fontSize: 10, opacity: 0.85 }}>online</div></div>
        </div>
        <div style={{ background: "#E5DDD5", padding: 12, minHeight: 280 }}>
          <div style={{ background: "#fff", borderRadius: 10, padding: 9, maxWidth: "90%", boxShadow: "0 1px 1px rgba(0,0,0,.13)", fontSize: 13, lineHeight: 1.45 }}>
            {kind === "card" && headerType === "media" && mediaUrl && (
              mediaIsVideo
                ? <video src={mediaUrl} muted playsInline style={{ width: "100%", borderRadius: 6, marginBottom: 6, display: "block" }} />
                : <img src={mediaUrl} alt="" style={{ width: "100%", borderRadius: 6, marginBottom: 6, display: "block" }} />
            )}
            {kind === "card" && headerType === "text" && headerText && <div style={{ fontWeight: 700, marginBottom: 4 }}>{render(headerText)}</div>}
            <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{render(body) || <span style={{ color: "#9a958c" }}>Your message will appear here…</span>}</div>
            {kind === "card" && footer && <div style={{ fontSize: 11, color: "#8a8d91", marginTop: 6 }}>{render(footer)}</div>}
            <div style={{ fontSize: 10, color: "#8a8d91", textAlign: "right", marginTop: 4 }}>12:30 PM</div>
          </div>
          {btns.length > 0 && (
            <div style={{ maxWidth: "90%", marginTop: 4 }}>
              {btns.map((b, i) => (
                <div key={i} style={{ background: "#fff", color: "#0a84ff", textAlign: "center", padding: "10px", borderRadius: 8, fontSize: 13, fontWeight: 500, marginTop: 4, boxShadow: "0 1px 1px rgba(0,0,0,.13)" }}>
                  {b.title}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <span style={{ display: "block", fontSize: 12, color: "#6B6862", marginBottom: 4 }}>{label}</span>
      {children}
    </label>
  );
}

const btn: React.CSSProperties = {
  padding: "9px 18px",
  background: "#141414",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 12,
  letterSpacing: 1,
  textTransform: "uppercase",
};
const pill: React.CSSProperties = {
  padding: "8px 16px",
  background: "#fff",
  border: "1px solid #E4E1DB",
  borderRadius: 20,
  cursor: "pointer",
  fontSize: 13,
};
const pillActive: React.CSSProperties = { background: "#141414", color: "#fff", borderColor: "#141414" };
const action: React.CSSProperties = {
  padding: "7px 16px",
  background: "#fff",
  border: "1px solid #E4E1DB",
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 13,
};
const input: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  border: "1px solid #E4E1DB",
  borderRadius: 8,
  fontSize: 14,
  boxSizing: "border-box",
  background: "#fff",
};
const card: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #E4E1DB",
  borderRadius: 12,
  padding: 18,
};
const errBox: React.CSSProperties = {
  background: "#fdecea",
  color: "#b00020",
  padding: 12,
  borderRadius: 8,
  marginBottom: 14,
  fontSize: 14,
};
