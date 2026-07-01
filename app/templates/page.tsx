"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Icon, IC, Badge, PageHead, Skeleton, CHECK2, sm, kindOf, TYPE_LABEL, LANG_LABEL, isRTL, renderVars, fmtUpdated, LANGUAGES } from "@/lib/ui";
import { type Tpl } from "@/lib/fixtures";

type Btn = { type: "url" | "phone" | "quick-reply"; title: string; url?: string; phone?: string };

/* ── Live phone preview ── */
function PhonePreview({ kind, headerType, headerText, mediaUrl, mediaIsVideo, body, footer, buttons, vars }: {
  kind: string; headerType: string; headerText: string; mediaUrl: string; mediaIsVideo: boolean; body: string; footer: string; buttons: Btn[]; vars: Record<string, string>;
}) {
  const render = (t: string) => (t || "").replace(/\{\{(\d+)\}\}/g, (_, n) => vars[n] || `{{${n}}}`);
  const btns = kind === "card" || kind === "quick-reply" ? buttons.filter((b) => b.title) : [];
  return (
    <div className="phone">
      <div className="phone-notch" />
      <div className="wa-top"><div className="wa-ava">E</div><div><div className="wa-name">ERE Homes</div><div className="wa-status">online</div></div></div>
      <div className="wa-chat">
        <div className="wa-bubble">
          {kind === "card" && headerType === "media" && mediaUrl && (mediaIsVideo ? <video src={mediaUrl} muted playsInline className="bimg" /> : <img className="bimg" src={mediaUrl} alt="" />)}
          {kind === "card" && headerType === "media" && !mediaUrl && <div className="bimgph">Image / Video header</div>}
          {kind === "card" && headerType === "text" && headerText && <div className="bhead">{render(headerText)}</div>}
          <div className="bbody">{render(body) || <span className="placeholder">Your message will appear here…</span>}</div>
          {kind === "card" && footer && <div className="bfoot">{render(footer)}</div>}
          <div className="btime">12:30 PM <span style={{ color: "#53bdeb" }}>{CHECK2}</span></div>
        </div>
        {btns.length > 0 && <div className="wa-replies">{btns.map((b, i) => <div key={i} className="wa-reply"><Icon d={IC.reply} s={13} /> {b.title}</div>)}</div>}
      </div>
    </div>
  );
}

type Seed = { kind: "text" | "card" | "quick-reply"; name: string; category: string; language: string; body: string; buttons: Btn[]; varDefaults: Record<string, string>; headerType?: "none" | "text" | "image" | "media"; headerText?: string; mediaUrl?: string; footer?: string } | null;

/* ── Composer modal ── */
function Composer({ onClose, onCreated, seed }: { onClose: () => void; onCreated: (t: Tpl | null) => void; seed: Seed }) {
  const DEFAULT_BUTTONS: Btn[] = [{ type: "quick-reply", title: "" }, { type: "quick-reply", title: "" }, { type: "quick-reply", title: "" }];
  const initialKind = seed?.kind ?? "card";
  const isBtnKind = initialKind === "card" || initialKind === "quick-reply";
  const [kind, setKind] = useState<"text" | "card" | "quick-reply">(initialKind);
  const [name, setName] = useState(seed?.name ?? "");
  const [category, setCategory] = useState(seed?.category ?? "MARKETING");
  const [language, setLanguage] = useState(seed?.language ?? "en");
  const [body, setBody] = useState(seed?.body ?? "");
  const [headerType, setHeaderType] = useState<"none" | "text" | "media">(seed?.headerType === "image" ? "media" : (seed?.headerType as "none" | "text" | "media" | undefined) ?? (initialKind === "card" ? "media" : "none"));
  const [headerText, setHeaderText] = useState(seed?.headerText ?? "");
  const [footer, setFooter] = useState(seed?.footer ?? "");
  const [mediaUrl, setMediaUrl] = useState(seed?.mediaUrl ?? "");
  const [mediaIsVideo, setMediaIsVideo] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [buttons, setButtons] = useState<Btn[]>(seed?.buttons?.length ? seed.buttons : isBtnKind ? DEFAULT_BUTTONS : []);
  const [varDefaults, setVarDefaults] = useState<Record<string, string>>(seed?.varDefaults ?? {});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const detectedVars = Array.from(new Set([...`${body} ${headerText} ${footer}`.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1]))).sort((a, b) => Number(a) - Number(b));
  const maxButtons = 3;
  const addButton = () => buttons.length < maxButtons && setButtons([...buttons, { type: "quick-reply", title: "" }]);
  const setBtn = (i: number, patch: Partial<Btn>) => setButtons(buttons.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading(true);
    setErr(null);
    // Prefer the real uploader (Supabase storage); fall back to an inline data URL.
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Upload failed");
      setMediaUrl(d.url);
      setMediaIsVideo(f.type.startsWith("video/"));
      setUploading(false);
    } catch {
      const r = new FileReader();
      r.onload = () => { setMediaUrl(String(r.result)); setMediaIsVideo(false); setUploading(false); };
      r.onerror = () => { setErr("Upload failed"); setUploading(false); };
      r.readAsDataURL(f);
    }
  }

  async function submit() {
    setErr(null);
    setMsg(null);
    if (!name.trim()) return setErr("Template name is required.");
    if (!body.trim()) return setErr("Body text is required.");
    // A data: URI means the image never uploaded to a public URL; Twilio rejects it.
    if (kind === "card" && headerType === "media" && mediaUrl && !/^https?:\/\//i.test(mediaUrl)) {
      return setErr("The header media has not finished uploading to a public URL. Re-add the file, wait for the preview, then submit.");
    }
    setBusy(true);

    const vars: Record<string, string> = {};
    for (const k of detectedVars) if ((varDefaults[k] || "").trim()) vars[k] = varDefaults[k].trim();
    const replyButtons = kind === "card" || kind === "quick-reply"
      ? buttons.filter((b) => b.title && (kind === "quick-reply" || b.type === "quick-reply")).map((b) => b.title)
      : [];

    const payload: any = { name, category, language, kind, body };
    if (Object.keys(vars).length) payload.variables = vars;
    if (kind === "card") {
      if (headerType === "text" && headerText) payload.headerText = headerText;
      if (headerType === "media" && mediaUrl) payload.mediaUrl = mediaUrl;
      if (footer) payload.footer = footer;
      payload.buttons = buttons;
    }
    if (kind === "quick-reply") payload.buttons = buttons;

    const localTpl: Tpl = {
      sid: "HX" + Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32),
      name, language, category,
      type: kind === "card" ? "whatsapp/card" : kind === "quick-reply" ? "twilio/quick-reply" : "twilio/text",
      status: "pending", rejection_reason: null, variables: vars, body, replyButtons,
      updated: new Date().toISOString(),
    };

    try {
      const res = await fetch("/api/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create the template");
      // Only treat it as created if Twilio actually returned a real Content SID.
      if (!data.sid || !String(data.sid).startsWith("HX")) {
        throw new Error(data.approvalError || "Twilio did not return a template SID, so nothing was created.");
      }
      const note = data.approvalError
        ? `Created “${name}” but approval was NOT submitted: ${data.approvalError}`
        : `Submitted “${name}” to Meta for review. Status: ${data.status || "pending"}.`;
      setMsg(note);
      setBusy(false);
      setTimeout(() => onCreated({ ...localTpl, sid: data.sid, status: data.status === "approved" ? "approved" : "pending" }), 850);
    } catch (e: any) {
      // Surface the real failure instead of faking a phantom template that vanishes on refresh.
      setErr(e?.message || "Could not create the template. Nothing was saved to Twilio.");
      setBusy(false);
    }
  }

  return (
    <div className="modal">
      <div className="modal-head">
        <button className="icon-btn" onClick={onClose} title="Cancel"><Icon d={IC.x} s={18} /></button>
        <div>
          <div className="mt">{seed ? "Duplicate content template" : "Create content template"}</div>
          <div className="ms">{seed ? "Edit the copy, then submit for approval" : "Compose a message and submit it to Meta"}</div>
        </div>
        <div className="mr">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}><Icon d={IC.bolt} s={15} f="currentColor" w={0} />{busy ? "Submitting…" : "Create & submit"}</button>
        </div>
      </div>
      <div className="modal-body">
        <div className="composer-form">
          <div className="sect">
            <div className="sect-t">Template type</div>
            <div className="sect-d">Pick the message structure. Cards support a header, footer and buttons.</div>
            <div className="seg">
              {([["text", "Text"], ["card", "Card"], ["quick-reply", "Quick reply"]] as const).map(([k, l]) => (
                <button key={k} className={kind === k ? "on" : ""} onClick={() => { setKind(k); setButtons(k === "text" ? [] : DEFAULT_BUTTONS); setHeaderType(k === "card" ? "media" : "none"); setHeaderText(""); setMediaUrl(""); setMediaIsVideo(false); }}>{l}</button>
              ))}
            </div>
          </div>

          <div className="sect">
            <div className="sect-t">Details</div>
            <div className="sect-d">A unique name, message category and language.</div>
            <div className="fgrid">
              <div className="field" style={{ marginBottom: 0 }}><label className="label">Name</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))} placeholder="property_offer_v2" /></div>
              <div className="field" style={{ marginBottom: 0 }}><label className="label">Category</label>
                <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}><option>MARKETING</option><option>UTILITY</option></select></div>
              <div className="field" style={{ marginBottom: 0 }}><label className="label">Language</label>
                <select className="input" value={language} onChange={(e) => setLanguage(e.target.value)}>{LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</select></div>
            </div>
          </div>

          <div className="sect">
            <div className="sect-t">Message content</div>
            <div className="sect-d">Use {"{{1}}"}, {"{{2}}"} for variables that get personalized per contact.</div>
            {kind === "card" && (
              <div className="field"><label className="label">Header <span className="opt">· optional</span></label>
                <select className="input" style={{ marginBottom: 8 }} value={headerType} onChange={(e) => setHeaderType(e.target.value as any)}>
                  <option value="none">No header</option><option value="text">Text header</option><option value="media">Image / Video header</option>
                </select>
                {headerType === "text" && <input className="input" value={headerText} onChange={(e) => setHeaderText(e.target.value)} placeholder="Header text (max 60)" maxLength={60} />}
                {headerType === "media" && (
                  <>
                    <div className="btn-row"><input type="file" accept="image/*,video/mp4" onChange={handleUpload} disabled={uploading} style={{ fontSize: 12.5 }} />{uploading && <span style={{ fontSize: 12, color: "var(--amber-ink)" }}>Uploading…</span>}</div>
                    <input className="input" value={mediaUrl.startsWith("data:") ? "" : mediaUrl} onChange={(e) => { const val = e.target.value; setMediaUrl(val); setMediaIsVideo(/\.(mp4|mov|webm)$/i.test(val)); }} placeholder="…or paste an image or video URL" />
                    {mediaUrl && !uploading && (mediaIsVideo ? <video src={mediaUrl} controls style={{ width: "100%", maxHeight: 120, marginTop: 8, borderRadius: 4, border: "1px solid var(--border)" }} /> : <img src={mediaUrl} alt="" style={{ maxHeight: 90, marginTop: 8, borderRadius: 4, border: "1px solid var(--border)" }} />)}
                  </>
                )}
              </div>
            )}
            <div className="field"><label className="label">Body{kind === "card" ? <span className="opt"> · max 1024</span> : null}</label>
              <textarea className="input" rows={4} value={body} maxLength={kind === "card" ? 1024 : undefined} onChange={(e) => setBody(e.target.value)} placeholder="Hi {{1}}, here's your update…" /></div>
            {kind === "card" && (
              <div className="field" style={{ marginBottom: 0 }}><label className="label">Footer <span className="opt">· optional, max 60</span></label>
                <input className="input" value={footer} onChange={(e) => setFooter(e.target.value)} placeholder="ERE Homes · Reply STOP to opt out" maxLength={60} /></div>
            )}
          </div>

          {detectedVars.length > 0 && (
            <div className="sect">
              <div className="sect-t">Sample values</div>
              <div className="sect-d">Used as a fallback when a contact is missing a value, and to render the preview.</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10 }}>
                {detectedVars.map((k) => (
                  <div key={k} style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <span className="varkey">{`{{${k}}}`}</span>
                    <input className="input" value={varDefaults[k] || ""} onChange={(e) => setVarDefaults({ ...varDefaults, [k]: e.target.value })} placeholder={k === "1" ? "e.g. there" : "default"} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {(kind === "card" || kind === "quick-reply") && (
            <div className="sect">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <div className="sect-t">Buttons</div>
                <button className="add-btn" onClick={addButton} disabled={buttons.length >= maxButtons}>+ Add button</button>
              </div>
              <div className="sect-d">{kind === "quick-reply" ? "Up to 3 quick replies." : "Up to 3 reply buttons, or 2 link/call buttons."}</div>
              {buttons.map((bt, i) => (
                <div key={i} className="btn-row">
                  {kind === "card" && (
                    <select className="input" style={{ width: 100, flex: "none" }} value={bt.type} onChange={(e) => setBtn(i, { type: e.target.value as Btn["type"] })}>
                      <option value="url">Link</option><option value="phone">Call</option><option value="quick-reply">Reply</option>
                    </select>
                  )}
                  <input className="input" style={{ flex: 1 }} value={bt.title} onChange={(e) => setBtn(i, { title: e.target.value })} placeholder="Button text" />
                  {kind === "card" && bt.type === "url" && <input className="input" style={{ flex: 1 }} value={bt.url || ""} onChange={(e) => setBtn(i, { url: e.target.value })} placeholder="https://…" />}
                  {kind === "card" && bt.type === "phone" && <input className="input" style={{ flex: 1 }} value={bt.phone || ""} onChange={(e) => setBtn(i, { phone: e.target.value })} placeholder="+9715…" />}
                  <button className="icon-x" onClick={() => setButtons(buttons.filter((_, idx) => idx !== i))}><Icon d={IC.x} s={15} /></button>
                </div>
              ))}
              {kind === "quick-reply" && <div className="hint">Set what each button replies with under “Auto-replies” once the template is created.</div>}
            </div>
          )}

          {err && <div className="err-box">{err}</div>}
          {msg && <div className="ok-box">{msg}</div>}
          <div style={{ height: 20 }} />
        </div>
        <div className="composer-aside">
          <div className="sticky">
            <div className="preview-lab">Live preview</div>
            <PhonePreview kind={kind} headerType={headerType} headerText={headerText} mediaUrl={mediaUrl} mediaIsVideo={mediaIsVideo} body={body} footer={footer} buttons={buttons} vars={varDefaults} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Auto-reply config (wired to /api/auto-replies, local fallback) ── */
type Rule = { id?: string; reply: string; push: boolean; block: boolean; enabled: boolean };
function AutoReplyConfig({ buttons }: { buttons: string[] }) {
  const [rules, setRules] = useState<Record<string, Rule>>(() => { const m: Record<string, Rule> = {}; for (const b of buttons) m[b] = { reply: "", push: false, block: false, enabled: true }; return m; });
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const set = (t: string, patch: Partial<Rule>) => setRules((r) => ({ ...r, [t]: { ...r[t], ...patch } }));

  useEffect(() => {
    fetch("/api/auto-replies")
      .then((r) => r.json())
      .then((d) => {
        const byTrigger: Record<string, any> = {};
        for (const r of d.rules || []) byTrigger[(r.trigger || "").toLowerCase()] = r;
        setRules((prev) => {
          const next = { ...prev };
          for (const b of buttons) {
            const ex = byTrigger[b.toLowerCase()];
            if (ex) next[b] = { id: ex.id, reply: ex.reply || "", push: !!ex.push_pipedrive, block: !!ex.block, enabled: ex.enabled !== false };
          }
          return next;
        });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(trigger: string) {
    const r = rules[trigger];
    try {
      const res = await fetch("/api/auto-replies", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: r.id, trigger, reply: r.reply, push_pipedrive: r.push, block: r.block, enabled: r.enabled }),
      });
      const d = await res.json();
      if (res.ok && d.rule?.id) set(trigger, { id: d.rule.id });
    } catch { /* local-only */ }
    setSavedKey(trigger);
    setTimeout(() => setSavedKey(null), 1500);
  }

  return (
    <div>
      <div className="autocard">
        {buttons.map((b) => {
          const r = rules[b] || { reply: "", push: false, block: false, enabled: true };
          return (
            <div key={b} className="autorule">
              <div className="kw">When a contact taps <span className="tag">{b}</span></div>
              <textarea className="input" rows={2} value={r.reply} onChange={(e) => set(b, { reply: e.target.value })} placeholder="Auto-reply sent back to the contact…" />
              <div className="checkrow">
                <label><input type="checkbox" checked={r.push} onChange={(e) => set(b, { push: e.target.checked })} /> Create Hot lead in Pipedrive</label>
                <label><input type="checkbox" checked={r.block} onChange={(e) => set(b, { block: e.target.checked })} /> Block / opt-out</label>
                <label><input type="checkbox" checked={r.enabled} onChange={(e) => set(b, { enabled: e.target.checked })} /> Enabled</label>
                <button className="btn btn-sec btn-sm" onClick={() => save(b)}>{savedKey === b ? "Saved ✓" : "Save"}</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Detail drawer ── */
function Drawer({ t, onClose, onDuplicate, onDelete, busy }: { t: Tpl; onClose: () => void; onDuplicate: (t: Tpl) => void; onDelete: (t: Tpl) => void; busy: boolean }) {
  const [tab, setTab] = useState<"details" | "auto">("details");
  const varCount = Object.keys(t.variables || {}).length;
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="drawer">
        <div className="dr-head">
          <div className="dh-main">
            <div className="dh-name">{t.name}</div>
            <div className="dh-meta">{TYPE_LABEL(t.type)} · {LANG_LABEL(t.language)} · {t.category || "—"}</div>
          </div>
          <Badge status={t.status} />
          <button className="icon-btn" onClick={onClose}><Icon d={IC.x} s={18} /></button>
        </div>
        {t.replyButtons.length > 0 && (
          <div className="dr-tabs">
            {([["details", "Details"], ["auto", `Auto-replies (${t.replyButtons.length})`]] as const).map(([id, l]) => (
              <button key={id} className={`tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>{l}</button>
            ))}
          </div>
        )}
        <div className="dr-body">
          {tab === "details" && (
            <>
              <div className="dlabel">Message preview</div>
              <div className="bubble">
                <div className={`inner ${isRTL(t.language) ? "rtl" : ""}`}>
                  {t.media && <img src={t.media} alt="" style={{ width: "100%", borderRadius: 6, marginBottom: 7, display: "block" }} />}
                  {t.headerText && <div style={{ fontWeight: 700, marginBottom: 4 }}>{renderVars(t.headerText)}</div>}
                  {renderVars(t.body)}
                  {t.footer && <div style={{ fontSize: 11.5, color: "#8a9398", marginTop: 6 }}>{renderVars(t.footer)}</div>}
                  <div className="btime">12:30 PM <span style={{ color: "#53bdeb" }}>{CHECK2}</span></div>
                </div>
                {(() => {
                  const pv = t.buttons && t.buttons.length ? t.buttons : t.replyButtons.map((title) => ({ type: "QUICK_REPLY", title }));
                  return pv.length > 0 ? (
                    <div className="replies">{pv.map((b, i) => (
                      <div key={i} className="reply"><Icon d={b.type === "URL" ? IC.ext : b.type === "PHONE_NUMBER" ? IC.phone : IC.reply} s={13} />{b.title}</div>
                    ))}</div>
                  ) : null;
                })()}
              </div>
              {t.rejection_reason && (<><div className="dlabel">Rejection reason</div><div className="reject"><b>Rejected by Meta</b>{t.rejection_reason}</div></>)}
              {varCount > 0 && (
                <>
                  <div className="dlabel">Variables</div>
                  <div>{Object.entries(t.variables).map(([k, v]) => (
                    <div key={k} className="vrow"><span className="vk">{`{{${k}}}`}</span><span className="vv">{v || <em style={{ opacity: 0.6 }}>empty</em>}</span></div>
                  ))}</div>
                </>
              )}
              <div className="dlabel">Properties</div>
              <div className="kv2">
                <div><div className="k">Content SID</div><div className="v mono">{t.sid}</div></div>
                <div><div className="k">Type</div><div className="v">{TYPE_LABEL(t.type)}</div></div>
                <div><div className="k">Language</div><div className="v">{LANG_LABEL(t.language)}</div></div>
                <div><div className="k">Category</div><div className="v">{t.category || "—"}</div></div>
                <div><div className="k">Last updated</div><div className="v">{fmtUpdated(t.updated)}</div></div>
                <div><div className="k">Buttons</div><div className="v">{t.replyButtons.length || "—"}</div></div>
              </div>
            </>
          )}
          {tab === "auto" && (
            <>
              <div className="dlabel">Button automations</div>
              <p style={{ fontSize: 13, color: "var(--ink-2)", marginBottom: 14 }}>When a contact taps a button, the app sends your reply automatically — and can push a lead into Pipedrive or opt them out.</p>
              <AutoReplyConfig buttons={t.replyButtons} />
            </>
          )}
        </div>
        <div className="dr-foot">
          <button className="btn btn-sec" onClick={() => onDuplicate(t)} disabled={busy}><Icon d={IC.copy} s={15} />Duplicate</button>
          <button className="btn btn-ghost danger" onClick={() => onDelete(t)} disabled={busy}><Icon d={IC.trash} s={15} />Delete</button>
          <a className="btn btn-ghost" style={{ marginLeft: "auto" }} href={`https://console.twilio.com/us1/develop/content-template-builder/${t.sid}`} target="_blank" rel="noreferrer">Open in Twilio <Icon d={IC.ext} s={14} /></a>
        </div>
      </div>
    </>
  );
}

function LanePill({ lane }: { lane: string }) {
  const marketing = lane === "marketing";
  const c = marketing ? { bg: "#fdf0d5", fg: "#8a5a00" } : { bg: "#e6f0fb", fg: "#1d4ed8" };
  return (
    <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.2, padding: "1px 7px", borderRadius: 999, background: c.bg, color: c.fg, whiteSpace: "nowrap", flex: "none" }}>
      {marketing ? "Marketing" : "Utility"}
    </span>
  );
}

function Row({ t, selected, onOpen }: { t: Tpl; selected: boolean; onOpen: (t: Tpl) => void }) {
  const k = kindOf(t.type);
  const preview = (t.body || "").replace(/\s+/g, " ").trim();
  const varCount = Object.keys(t.variables || {}).length;
  const lane = (t as any).lane || "utility";
  return (
    <tr className={selected ? "sel" : ""} onClick={() => onOpen(t)}>
      <td>
        <div className="cell-name">
          <span className={`tkind ${k}`} style={t.media ? { overflow: "hidden", padding: 0 } : undefined}>
            {t.media ? <img src={t.media} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Icon d={k === "card" ? IC.tmpl : k === "qr" ? IC.reply : IC.hash} s={15} />}
          </span>
          <div className="nm">
            <div className="t" style={{ display: "flex", alignItems: "center", gap: 7 }}>{t.name}<LanePill lane={lane} /></div>
            <div className="p">{preview}</div>
          </div>
        </div>
      </td>
      <td className="tcol-type">{TYPE_LABEL(t.type)}</td>
      <td className="tcol-muted">{t.category || "—"}</td>
      <td className="tcol-muted">{LANG_LABEL(t.language)}</td>
      <td>
        {t.replyButtons.length > 0 && <span className="metric"><Icon d={IC.reply} s={12} />{t.replyButtons.length}</span>}
        {varCount > 0 && <span className="metric"><Icon d={IC.vars} s={12} />{varCount}</span>}
        {t.replyButtons.length === 0 && varCount === 0 && <span className="tcol-muted">—</span>}
      </td>
      <td><Badge status={t.status} /></td>
      <td className="tcol-muted" style={{ whiteSpace: "nowrap" }}>{fmtUpdated(t.updated)}</td>
      <td style={{ textAlign: "right" }}><span className="row-chev"><Icon d={IC.chev} s={16} /></span></td>
    </tr>
  );
}

const FILTERS = [
  { id: "all", label: "All" }, { id: "approved", label: "Approved" }, { id: "pending", label: "Pending" },
  { id: "rejected", label: "Rejected" }, { id: "unsubmitted", label: "Drafts" },
];

export default function Templates() {
  const [tpls, setTpls] = useState<Tpl[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composer, setComposer] = useState(false);
  const [seed, setSeed] = useState<Seed>(null);
  const [active, setActive] = useState<Tpl | null>(null);
  const [busySid, setBusySid] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [cat, setCat] = useState("all");
  const [q, setQ] = useState("");

  // background=true => quiet refresh (no spinner, keep current rows on a transient
  // error) so the 20s poll never flashes the list or blanks it on a blip.
  async function load(background = false) {
    if (!background) { setLoading(true); setError(null); }
    try {
      const res = await fetch("/api/templates");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load templates");
      // Show exactly what Twilio returns - never substitute demo data, which
      // would look like templates nobody created (e.g. when the account is down).
      setTpls(data.templates || []);
      if (background) setError(null);
    } catch (e: any) {
      if (!background) {
        setTpls([]);
        setError(e?.message || "Couldn't reach Twilio. Check the connection and try again.");
      }
      // a background blip keeps the last good list rather than wiping it
    } finally {
      if (!background) setLoading(false);
    }
  }
  // Initial load + keep approval statuses live (received -> pending -> approved)
  // without a manual reload. Pause while the tab is hidden to avoid wasted calls.
  useEffect(() => {
    load();
    const poll = setInterval(() => { if (!document.hidden) load(true); }, 20000);
    return () => clearInterval(poll);
  }, []);

  const matchStatus = (st: string, f: string) => (f === "all" ? true : f === "pending" ? st === "pending" || st === "received" : st === f);
  const counts = useMemo(() => {
    const c = { total: tpls.length, approved: 0, pending: 0, rejected: 0, unsubmitted: 0 };
    for (const t of tpls) {
      if (t.status === "approved") c.approved++;
      else if (t.status === "pending" || t.status === "received") c.pending++;
      else if (t.status === "rejected") c.rejected++;
      else c.unsubmitted++;
    }
    return c;
  }, [tpls]);

  const filtered = useMemo(() => tpls.filter((t) => {
    if (!matchStatus(t.status, filter)) return false;
    // `cat` now holds the LANE filter (which sending account owns the template):
    // "marketing" = marketing number, "utility" = utility number.
    if (cat !== "all" && ((t as any).lane || "utility") !== cat) return false;
    if (q.trim()) { const s = q.toLowerCase(); if (!t.name.toLowerCase().includes(s) && !(t.body || "").toLowerCase().includes(s)) return false; }
    return true;
  }), [tpls, filter, cat, q]);

  async function deleteTpl(t: Tpl) {
    if (!confirm(`Delete template "${t.name}"? This removes it from Twilio and cannot be undone.`)) return;
    setBusySid(t.sid);
    try {
      const res = await fetch(`/api/templates?sid=${encodeURIComponent(t.sid)}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
    } catch { /* fall through to local removal */ }
    setTpls((p) => p.filter((x) => x.sid !== t.sid));
    setBusySid(null);
    setActive(null);
  }

  function duplicateTpl(t: Tpl) {
    const k: "text" | "card" | "quick-reply" = kindOf(t.type) === "card" ? "card" : t.replyButtons.length || kindOf(t.type) === "qr" ? "quick-reply" : "text";
    // Map Twilio button types back to the composer's shape so the copy is complete.
    const btnType = (api: string): Btn["type"] => (api === "URL" ? "url" : api === "PHONE_NUMBER" ? "phone" : "quick-reply");
    const buttons: Btn[] = k === "text"
      ? []
      : (t.buttons && t.buttons.length
          ? t.buttons.map((b) => ({ type: btnType(b.type), title: b.title, url: b.url || undefined, phone: b.phone || undefined }))
          : t.replyButtons.map((title) => ({ type: "quick-reply" as const, title })));
    setSeed({
      kind: k,
      name: `${t.name}_copy`.toLowerCase().replace(/[^a-z0-9_]/g, "_"),
      category: t.category || "MARKETING",
      language: t.language || "en",
      body: t.body || "",
      headerType: t.media ? "media" : t.headerText ? "text" : "none",
      headerText: t.headerText || "",
      mediaUrl: t.media || "",
      footer: t.footer || "",
      buttons,
      varDefaults: t.variables || {},
    });
    setActive(null);
    setComposer(true);
  }

  return (
    <div className="page">
      <div className="maxw">
        <PageHead title="Content templates" sub="Pre-approved WhatsApp messages your team sends to owners and buyers. Compose, submit to Meta, and track approval.">
          <Link className="btn btn-sec" href="/templates/performance"><Icon d={IC.insights} s={15} />Performance</Link>
          <button className="btn btn-sec" onClick={() => load()}><Icon d={IC.refresh} s={15} />{loading ? "Loading…" : "Refresh"}</button>
          <button className="btn btn-primary" onClick={() => { setSeed(null); setComposer(true); }}><Icon d={IC.plus} s={16} />Create new</button>
        </PageHead>

        <div className="kpis">
          <div className="kpi"><div className="kl">Total templates</div><div className="kv">{counts.total}</div><div className="ks">across {new Set(tpls.map((t) => t.language)).size} languages</div></div>
          <div className="kpi"><div className="kl"><span className="dot" style={{ background: "var(--green-dot)" }} />Approved</div><div className="kv">{counts.approved}</div><div className="ks">ready to send</div></div>
          <div className="kpi"><div className="kl"><span className="dot" style={{ background: "var(--amber-dot)" }} />Pending</div><div className="kv">{counts.pending}</div><div className="ks">in Meta review</div></div>
          <div className="kpi"><div className="kl"><span className="dot" style={{ background: "var(--red)" }} />Rejected</div><div className="kv">{counts.rejected}</div><div className="ks">needs changes</div></div>
          <div className="kpi"><div className="kl"><span className="dot" style={{ background: "var(--ink-3)" }} />Drafts</div><div className="kv">{counts.unsubmitted}</div><div className="ks">not submitted</div></div>
        </div>

        <div className="bar">
          <div className="tabs">
            {FILTERS.map((f) => {
              const n = f.id === "all" ? counts.total : (counts as any)[f.id] ?? 0;
              return <button key={f.id} className={`tab ${filter === f.id ? "active" : ""}`} onClick={() => setFilter(f.id)}>{f.label}<span className="cnt">{n}</span></button>;
            })}
          </div>
          <div className="bar-right">
            {([["marketing", "Marketing"], ["utility", "Utility"]] as const).map(([id, label]) => (
              <button key={id} className={`seltrig ${cat === id ? "on" : ""}`} onClick={() => setCat(cat === id ? "all" : id)}>{label}</button>
            ))}
            <div className="list-search"><Icon d={IC.search} s={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates…" /></div>
          </div>
        </div>

        <div className="panel">
          {loading ? <Skeleton rows={6} /> : error ? (
            <div className="empty"><div className="ei"><Icon d={IC.refresh} s={22} /></div><h4>Couldn&apos;t load templates</h4><div>{error}</div><button className="btn btn-sec" style={{ marginTop: 12 }} onClick={() => load()}><Icon d={IC.refresh} s={15} />Try again</button></div>
          ) : tpls.length === 0 ? (
            <div className="empty"><div className="ei"><Icon d={IC.plus} s={22} /></div><h4>No templates yet</h4><div>Create your first WhatsApp template and submit it to Meta for approval.</div></div>
          ) : filtered.length > 0 ? (
            <table className="ttable">
              <thead><tr><th>Template</th><th>Type</th><th>Category</th><th>Language</th><th>Content</th><th>Status</th><th>Updated</th><th></th></tr></thead>
              <tbody>{filtered.map((t) => <Row key={t.sid} t={t} selected={active?.sid === t.sid} onOpen={setActive} />)}</tbody>
            </table>
          ) : (
            <div className="empty"><div className="ei"><Icon d={IC.search} s={22} /></div><h4>No templates match</h4><div>Try a different status, category, or search term.</div></div>
          )}
        </div>
      </div>

      {active && <Drawer t={active} onClose={() => setActive(null)} onDuplicate={duplicateTpl} onDelete={deleteTpl} busy={busySid === active.sid} />}
      {composer && <Composer key={seed ? seed.name : "new"} seed={seed} onClose={() => { setComposer(false); setSeed(null); }} onCreated={(c) => { setComposer(false); setSeed(null); if (c) setTpls((p) => [c, ...p]); }} />}
    </div>
  );
}
