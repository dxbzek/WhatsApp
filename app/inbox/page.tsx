"use client";
import { useEffect, useRef, useState } from "react";
import { Icon, IC, Avatar, CHECK2, Skeleton, Toast } from "@/lib/ui";
import { CONVOS, SEED_TEMPLATES, type Tpl } from "@/lib/fixtures";
import { formatPhone } from "@/lib/format";

type UIMsg = { id: string; from: "in" | "out"; t: string; at: string; status?: string | null; media?: string | null; contentSid?: string | null };
type UIConv = {
  id: string; name: string; phone: string; waPhone?: string;
  tag: "Hot" | "Warm" | ""; lead?: string; unread: number; time: string; community: string;
  live: boolean; loaded: boolean; messages: UIMsg[]; blocked?: boolean;
  lastBody?: string; lastDirection?: string; replied?: boolean; assignedAgentId?: string; leadStage?: string;
};

// Pipeline progress of a transferred lead, distinct from the Hot/Warm
// "temperature" (lead_status). Tracks what the owning agent has done with it.
const STAGES = [
  { id: "", label: "No stage" }, { id: "contacted", label: "Contacted" },
  { id: "viewing", label: "Viewing" }, { id: "won", label: "Won" }, { id: "lost", label: "Lost → pool" },
];
const stageLabel = (id?: string) => STAGES.find((s) => s.id === (id || ""))?.label || "";

const LEADS = [
  { id: "new", label: "New" }, { id: "hot", label: "Hot" }, { id: "warm", label: "Warm" },
  { id: "cold", label: "Cold" }, { id: "won", label: "Won" }, { id: "lost", label: "Lost" },
];
const tagOf = (lead?: string): "Hot" | "Warm" | "" => (lead === "hot" ? "Hot" : lead === "warm" ? "Warm" : "");
const hhmm = (iso?: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
};
function mediaSrc(url: string) { return url.includes("api.twilio.com") ? `/api/media?url=${encodeURIComponent(url)}` : url; }

function TagDot({ tag }: { tag: string }) {
  if (!tag) return null;
  const c = tag === "Hot" ? "var(--red)" : "var(--amber-dot)";
  return <span className="leadtag"><span className="d" style={{ background: c }} />{tag}</span>;
}

function Ticks({ status }: { status?: string | null }) {
  if (!status) return <span style={{ color: "#53bdeb" }}>{CHECK2}</span>;
  if (status === "read") return <span style={{ color: "#53bdeb" }}>{CHECK2}</span>;
  if (status === "delivered") return <span style={{ color: "#8a9398" }}>{CHECK2}</span>;
  if (status === "undelivered" || status === "failed") return <span style={{ color: "#E0383E" }} title={status}>✗</span>;
  return <span style={{ color: "#8a9398" }} title={status || ""}>✓</span>;
}

function demoConvs(): UIConv[] {
  return CONVOS.map((c) => ({
    id: String(c.id), name: c.name, phone: c.phone, tag: c.tag, lead: c.tag === "Hot" ? "hot" : c.tag === "Warm" ? "warm" : "new",
    unread: c.unread, time: c.time, community: c.community, live: false, loaded: true,
    replied: c.messages.some((m) => m.from === "in"),
    messages: c.messages.map((m, i) => ({ id: String(i), from: m.from, t: m.t, at: m.at })),
  }));
}

export default function Inbox() {
  const [convos, setConvos] = useState<UIConv[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"all" | "unread" | "hot" | "replied" | "optout">("all");
  const [showThread, setShowThread] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [approved, setApproved] = useState<Tpl[]>(SEED_TEMPLATES.filter((t) => t.status === "approved"));
  const [senders, setSenders] = useState<string[]>([]);
  const [sender, setSender] = useState("");
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false); // first conversation fetch settled
  const [toast, setToast] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [agentNames, setAgentNames] = useState<Record<string, string>>({}); // agent id -> name, for the "assigned to" badge
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]); // ordered, for the assign + filter pickers
  const [agentFilter, setAgentFilter] = useState(""); // "" = all agents, "none" = unassigned, else agent id
  const [stageFilter, setStageFilter] = useState(""); // "" = any stage
  const threadRef = useRef<HTMLDivElement>(null);

  const active = convos.find((c) => c.id === activeId) || null;
  const draft = (activeId && drafts[activeId]) || "";
  const setDraft = (v: string) => setDrafts((d) => {
    const next = { ...d, [activeId || ""]: v };
    try { localStorage.setItem("om_drafts", JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });

  // Initial load: senders, approved templates, drafts, and conversations
  // (live Supabase → fixtures fallback). Also seed search from ?q=.
  useEffect(() => {
    try { setDrafts(JSON.parse(localStorage.getItem("om_drafts") || "{}")); } catch { /* ignore */ }
    try { const p = new URLSearchParams(window.location.search).get("q"); if (p) setQ(p); } catch { /* ignore */ }
    fetch("/api/senders").then((r) => r.json()).then((d) => { setSenders(d.senders || []); if (d.senders?.length) setSender(d.senders[0]); }).catch(() => {});
    fetch("/api/templates").then((r) => r.json()).then((d) => { const a = (d.templates || []).filter((t: Tpl) => t.status === "approved"); if (a.length) setApproved(a); }).catch(() => {});
    fetch("/api/agents").then((r) => r.json()).then((d) => { const list = (d.agents || []).map((a: any) => ({ id: a.id, name: a.name })); setAgents(list); const m: Record<string, string> = {}; list.forEach((a: any) => { m[a.id] = a.name; }); setAgentNames(m); }).catch(() => {});
    loadConvs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadConvs() {
    try {
      // Server route (service role) does the recent-window + actionable-lead merge
      // so the Hot/Unread tabs never drop a lead past the recent 1000. The browser
      // no longer reads the conversations table directly (RLS denies anon).
      const res = await fetch("/api/conversations?view=inbox");
      if (!res.ok) throw new Error("no live data");
      const data: any[] = (await res.json()).conversations || [];
      if (data.length === 0) throw new Error("no live data");
      const mapped: UIConv[] = data.map((c: any) => ({
        id: c.id, name: c.name || "+" + c.wa_phone, phone: formatPhone(c.wa_phone), waPhone: c.wa_phone,
        tag: tagOf(c.lead_status), lead: c.lead_status || "new", unread: c.unread ? 1 : 0, time: hhmm(c.last_at),
        community: c.community || "", live: true, loaded: false, messages: [], blocked: c.status === "blocked",
        lastBody: c.last_body || "", lastDirection: c.last_direction || "", replied: !!c.replied,
        assignedAgentId: c.assigned_agent_id || undefined, leadStage: c.lead_stage || "",
      }));
      setLive(true);
      setConvos((prev) => {
        // preserve already-loaded messages on refresh
        const byId = new Map(prev.map((p) => [p.id, p]));
        return mapped.map((m) => { const old = byId.get(m.id); return old?.loaded ? { ...m, loaded: true, messages: old.messages } : m; });
      });
      if (!activeId && data[0]) setActiveId(data[0].id);
    } catch {
      const d = demoConvs();
      setLive(false);
      setConvos(d);
      if (!activeId) setActiveId(d[0].id);
    } finally {
      setLoaded(true);
    }
  }

  async function loadMsgs(id: string) {
    // NOTE: on a fetch error (e.g. the server is briefly throttled mid campaign
    // blast) we must NOT mark the conversation loaded — caching an empty result
    // as "loaded" leaves the thread permanently blank until a hard reload.
    let data: any[];
    try {
      const res = await fetch(`/api/messages?view=thread&conversation=${encodeURIComponent(id)}`);
      if (!res.ok) return; // leave loaded:false so it shows "Loading…" and retries
      data = (await res.json()).messages || [];
    } catch { return; }
    const msgs: UIMsg[] = (data || []).map((m: any) => ({
      id: m.id, from: m.direction === "out" ? "out" : "in",
      t: m.body && m.body !== "[media]" ? m.body : "", at: hhmm(m.created_at), status: m.status, media: m.media_url, contentSid: m.content_sid,
    }));
    setConvos((p) => p.map((c) => (c.id === id ? { ...c, loaded: true, messages: msgs } : c)));
  }

  // Live updates: poll the gated server routes every 8s (replaces Supabase
  // realtime, which needed the browser's anon DB access). Refreshes the open
  // thread and the conversation list, same as the old postgres_changes handlers.
  useEffect(() => {
    if (!live) return;
    const poll = setInterval(() => { if (activeId) loadMsgs(activeId); loadConvs(); }, 8000);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, activeId]);

  // Auto-load messages for whichever conversation is active but not yet loaded.
  // Covers the auto-selected top conversation (loadConvs sets activeId without
  // fetching its messages) and retries any thread left unloaded by a transient
  // loadMsgs error, so the thread never sits blank waiting for a click.
  useEffect(() => {
    if (!activeId) return;
    const c = convos.find((x) => x.id === activeId);
    if (c && c.live && !c.loaded) loadMsgs(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, convos]);

  // Jump to the newest message when a thread loads or updates. We do it on the
  // next frame (after layout) AND expose scrollToBottom so a template's image
  // can re-scroll once it finishes loading — otherwise the image expands the
  // thread *after* this runs and shoves the latest reply below the fold, which
  // looked like "the reply isn't showing".
  const scrollToBottom = () => { const el = threadRef.current; if (el) el.scrollTop = el.scrollHeight; };
  useEffect(() => { const r = requestAnimationFrame(scrollToBottom); return () => cancelAnimationFrame(r); }, [activeId, convos]);

  // Update a conversation through the gated server route (whitelisted fields).
  async function patchConvo(id: string, patch: Record<string, any>) {
    try {
      await fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, patch }) });
    } catch { /* ignore */ }
  }

  async function openConvo(c: UIConv) {
    setActiveId(c.id);
    setShowThread(true);
    setMoreOpen(false);
    setConvos((p) => p.map((x) => (x.id === c.id ? { ...x, unread: 0 } : x)));
    if (c.live) {
      if (!c.loaded) await loadMsgs(c.id);
      patchConvo(c.id, { unread: false });
    }
  }

  async function send() {
    if (!active || !draft.trim()) return;
    const text = draft.trim();
    if (active.live && active.waPhone) {
      setSending(true);
      try {
        const res = await fetch("/api/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "+" + active.waPhone, body: text, from: sender || undefined }) });
        if (!res.ok) throw new Error((await res.json()).error || "Send failed");
        setDraft(""); setTplOpen(false);
        await loadMsgs(active.id);
      } catch (e: any) {
        setToast({ kind: "bad", text: "Send failed: " + e.message });
      } finally {
        setSending(false);
      }
    } else {
      // demo: append locally
      const at = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      setConvos((p) => p.map((c) => (c.id === active.id ? { ...c, time: at, messages: [...c.messages, { id: "m" + Date.now(), from: "out", t: text, at, status: "read" }] } : c)));
      setDraft(""); setTplOpen(false);
    }
  }

  function insertTemplate(t: Tpl) {
    const first = (active?.name || "there").split(" ")[0].replace(/^\+/, "there");
    setDraft((t.body || "").replace(/\{\{(\d+)\}\}/g, (_, n) => (n === "1" ? first : t.variables?.[n] || "")));
    setTplOpen(false);
    setTimeout(() => document.querySelector<HTMLInputElement>(".msg-input")?.focus(), 0);
  }

  async function setLead(id: string, lead: string) {
    setConvos((p) => p.map((c) => (c.id === id ? { ...c, lead, tag: tagOf(lead) } : c)));
    if (live) {
      await patchConvo(id, { lead_status: lead });
      fetch("/api/pipedrive/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: id }) }).catch(() => {});
    }
  }

  // Assign / reassign the owning agent (or clear it). Optimistic, then persisted.
  // Assigning a lead that was in the pool (stage "lost") clears its stage so it
  // starts fresh for the new owner.
  async function setAgent(id: string, agentId: string) {
    const fromPool = !!agentId && convos.find((c) => c.id === id)?.leadStage === "lost";
    setConvos((p) => p.map((c) => (c.id === id ? { ...c, assignedAgentId: agentId || undefined, leadStage: fromPool ? "" : c.leadStage } : c)));
    if (live) {
      await patchConvo(id, { assigned_agent_id: agentId || null });
      if (fromPool) await patchConvo(id, { lead_stage: null });
    }
  }
  // Set the pipeline stage (Contacted → Viewing → Won), clear it, or send the
  // lead back to the pool ("lost" = release the owner so another agent can take it).
  async function setStage(id: string, stage: string) {
    const toPool = stage === "lost";
    setConvos((p) => p.map((c) => (c.id === id ? { ...c, leadStage: stage, assignedAgentId: toPool ? undefined : c.assignedAgentId } : c)));
    if (live) {
      await patchConvo(id, { lead_stage: stage || null });
      if (toPool) await patchConvo(id, { assigned_agent_id: null });
    }
  }

  const list = convos
    // Replied = anyone who messaged back (opt-outs included, but labelled on the row).
    // Opt-outs get their own filter. Unread/Hot stay actionable-only (no opt-outs).
    .filter((c) => (
      tab === "unread" ? c.unread > 0 && !c.blocked
        : tab === "hot" ? c.tag === "Hot" && !c.blocked
        : tab === "replied" ? !!c.replied
        : tab === "optout" ? !!c.blocked
        : true))
    // Per-agent filter: "" = all, "none" = unassigned, "pool" = abandoned leads
    // (released back, stage "lost"), else a specific agent id.
    .filter((c) => (agentFilter === "" ? true : agentFilter === "pool" ? c.leadStage === "lost" : agentFilter === "none" ? !c.assignedAgentId : c.assignedAgentId === agentFilter))
    // Stage filter: "" = any, else exact pipeline stage.
    .filter((c) => (stageFilter === "" ? true : (c.leadStage || "") === stageFilter))
    .filter((c) => !q.trim() || c.name.toLowerCase().includes(q.toLowerCase()) || (c.waPhone || "").includes(q.replace(/[^0-9]/g, "")));

  return (
    <div className="page inbox-page">
      <div className={"inbox" + (showThread ? " show-thread" : "")}>
        <div className="conv-col">
          <div className="conv-head">
            <div className="conv-title">Inbox</div>
            <div className="list-search full"><Icon d={IC.search} s={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search conversations…" /></div>
            <div className="seg-tabs">
              {([["all", "All"], ["unread", "Unread"], ["replied", "Replied"], ["optout", "Opt-outs"], ["hot", "Hot"]] as const).map(([id, l]) => (
                <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{l}</button>
              ))}
            </div>
            {agents.length > 0 && (
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <select className="seltrig" value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} title="Filter by agent" aria-label="Filter by agent" style={{ height: 32, flex: 1, minWidth: 0 }}>
                  <option value="">All agents</option>
                  <option value="none">Unassigned</option>
                  <option value="pool">♻ Lead Pool</option>
                  {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <select className="seltrig" value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} title="Filter by stage" aria-label="Filter by stage" style={{ height: 32, flex: 1, minWidth: 0 }}>
                  <option value="">Any stage</option>
                  {STAGES.filter((s) => s.id).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </div>
            )}
          </div>
          {loaded && !live && (
            <div style={{ background: "var(--amber-bg)", color: "var(--amber-ink)", borderBottom: "1px solid var(--amber-border)", padding: "8px 16px", fontSize: 12, fontWeight: 600 }}>
              Showing sample data — not connected to the live inbox. These replies aren&apos;t real.
            </div>
          )}
          <div className="conv-list">
            {!loaded && <div style={{ padding: 12 }}><Skeleton rows={7} /></div>}
            {loaded && list.map((c) => (
              <div key={c.id} className={`conv-item ${c.id === activeId ? "active" : ""}`} onClick={() => openConvo(c)}>
                <Avatar name={c.name} size={42} />
                <div className="ci-main">
                  <div className="ci-top"><span className="ci-name">{c.name}</span><span className="ci-time">{c.time}</span></div>
                  <div className="ci-bottom">
                    <span className="ci-msg">{(() => {
                      if (c.messages.length) {
                        const last = c.messages[c.messages.length - 1];
                        return last.t || (last.media ? "📷 Photo" : "");
                      }
                      const b = c.lastBody || "";
                      if (b === "[media]") return "📷 Photo";
                      if (b === "[template]") return "Template message";
                      return b;
                    })()}</span>
                    {c.unread > 0 && <span className="unread">{c.unread}</span>}
                  </div>
                  {(c.tag || c.community || c.blocked || c.leadStage || c.assignedAgentId) && (
                    <div className="ci-tags">
                      {c.blocked
                        ? <span className="leadtag"><span className="d" style={{ background: "var(--ink-3)" }} />Opt-out</span>
                        : <TagDot tag={c.tag} />}
                      {c.leadStage === "lost"
                        ? <span className="ci-comm" style={{ color: "var(--amber-ink)", fontWeight: 600 }}>♻ In pool</span>
                        : c.leadStage && <span className="ci-comm" style={{ color: "var(--blue)", fontWeight: 600 }}>{stageLabel(c.leadStage)}</span>}
                      {c.assignedAgentId && agentNames[c.assignedAgentId] && <span className="ci-comm">→ {agentNames[c.assignedAgentId]}</span>}
                      <span className="ci-comm">{c.community}</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {loaded && list.length === 0 && <div className="empty sm"><div>No conversations match.</div></div>}
          </div>
        </div>

        {active ? (
          <div className="thread-col">
            <div className="thread-head">
              <button className="icon-btn th-back" onClick={() => setShowThread(false)} title="Back" aria-label="Back to conversations"><Icon d={IC.cleft} s={18} /></button>
              <Avatar name={active.name} size={40} />
              <div className="th-main">
                <div className="th-name">{active.name}{active.blocked && <span style={{ color: "var(--red-ink)", fontSize: 11, marginLeft: 8 }}>blocked</span>}{active.assignedAgentId && agentNames[active.assignedAgentId] && <span style={{ color: "var(--blue)", fontSize: 11, marginLeft: 8, fontWeight: 600 }}>→ {agentNames[active.assignedAgentId]}</span>}</div>
                <div className="th-sub">{active.phone}{active.community ? ` · ${active.community}` : ""}</div>
              </div>
              <select className="seltrig" value={active.lead || "new"} onChange={(e) => setLead(active.id, e.target.value)} title="Lead status" aria-label="Lead status" style={{ height: 32 }}>
                {LEADS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
              <a className="icon-btn" href={`tel:${(active.waPhone ? "+" + active.waPhone : active.phone).replace(/\s/g, "")}`} title="Call" aria-label="Call"><Icon d={IC.phone} s={17} /></a>
              <div style={{ position: "relative" }}>
                <button className="icon-btn" title="More" aria-label="More actions" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}><Icon d={IC.dots} s={17} /></button>
                {moreOpen && (
                  <>
                    <div className="acct-scrim" onClick={() => setMoreOpen(false)} />
                    <div className="avatar-menu" style={{ width: 210 }}>
                      <button className="am-item" onClick={() => { setMoreOpen(false); pushPipedrive(active); }}><Icon d={IC.users} s={16} />Push to Pipedrive</button>
                      <button className="am-item" onClick={() => { setMoreOpen(false); setLead(active.id, active.unread ? "new" : active.lead || "new"); markUnread(active); }}><Icon d={IC.inbox} s={16} />Mark as unread</button>
                    </div>
                  </>
                )}
              </div>
            </div>

            {agents.length > 0 && (
              <div className="ctx-bar" style={{ gap: 10, flexWrap: "wrap" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--muted)" }}>
                  Owner
                  <select className="seltrig" value={active.assignedAgentId || ""} onChange={(e) => setAgent(active.id, e.target.value)} title="Assign to agent" aria-label="Assign to agent" style={{ height: 30 }}>
                    <option value="">Unassigned</option>
                    {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--muted)" }}>
                  Stage
                  <select className="seltrig" value={active.leadStage || ""} onChange={(e) => setStage(active.id, e.target.value)} title="Lead stage" aria-label="Lead stage" style={{ height: 30 }}>
                    {STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                </label>
              </div>
            )}

            {active.live && active.waPhone && <CrmContext phone={active.waPhone} />}

            <div className="thread" ref={threadRef}>
              <div className="day-sep"><span>Today</span></div>
              {active.messages.map((m) => {
                // Buttons AND the header/cover image come from the template the message
                // was sent with (matched by content_sid), so the inbox bubble shows the
                // same card the recipient sees on WhatsApp (header image isn't stored on
                // the message row, only on the template).
                const tpl = m.from === "out" && m.contentSid ? approved.find((t) => t.sid === m.contentSid) : null;
                const tplBtns = tpl?.buttons;
                const tplMedia = !m.media ? tpl?.media : null;
                return (
                  <div key={m.id} className={`msg ${m.from}`}>
                    <div className="msg-stack">
                      <div className="msg-bubble">
                        {tplMedia && <img src={mediaSrc(tplMedia)} alt="" onLoad={scrollToBottom} style={{ width: "100%", borderRadius: 8, marginBottom: 6, display: "block" }} />}
                        {m.media && (/\.pdf($|\?)/i.test(m.media)
                          ? <a href={mediaSrc(m.media)} target="_blank" rel="noreferrer" style={{ color: "var(--wa-blue)", display: "block", marginBottom: 4 }}>Open document ↗</a>
                          : <img src={mediaSrc(m.media)} alt="" onLoad={scrollToBottom} />)}
                        {m.t}
                        <span className="msg-time">{m.at} {m.from === "out" && <Ticks status={m.status} />}</span>
                      </div>
                      {tplBtns && tplBtns.length > 0 && (
                        <div className="wa-replies">
                          {tplBtns.map((b, bi) => (
                            <div key={bi} className="wa-reply">
                              {b.type === "QUICK_REPLY"
                                ? <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" /></svg>
                                : <span aria-hidden style={{ fontSize: 12 }}>{b.type === "URL" ? "🔗" : "📞"}</span>}
                              {b.title}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {active.live && !active.loaded && <div className="empty sm">Loading messages…</div>}
            </div>

            <div className="composer-bar">
              {tplOpen && (
                <div className="tpl-pop">
                  <div className="tpl-pop-head">Insert approved template</div>
                  {approved.map((t) => (
                    <div key={t.sid} className="tpl-pop-item" onClick={() => insertTemplate(t)}>
                      <div className="tp-n">{t.name}</div>
                      <div className="tp-p">{(t.body || "").replace(/\s+/g, " ").trim()}</div>
                    </div>
                  ))}
                  {approved.length === 0 && <div className="tpl-pop-item"><div className="tp-p">No approved templates.</div></div>}
                </div>
              )}
              {senders.length > 1 && (
                <select className="seltrig" value={sender} onChange={(e) => setSender(e.target.value)} title="Send from" aria-label="Send from number" style={{ height: 40, maxWidth: 150 }}>
                  {senders.map((s) => <option key={s} value={s}>{formatPhone(s)}</option>)}
                </select>
              )}
              <button className={`icon-btn ${tplOpen ? "on" : ""}`} title="Insert a template" aria-label="Insert a template" aria-haspopup="menu" aria-expanded={tplOpen} onClick={() => setTplOpen((o) => !o)}><Icon d={IC.tmpl} s={18} /></button>
              {active.live && active.waPhone && <AttachMedia phone={active.waPhone} from={sender} onSent={() => loadMsgs(active.id)} notify={(text) => setToast({ kind: "bad", text })} />}
              <input className="msg-input" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="Type a message, or insert a template…" />
              <button className="btn btn-primary send-btn" onClick={send} disabled={sending}><Icon d={IC.send} s={16} f="currentColor" w={0} />{sending ? "…" : "Send"}</button>
            </div>
          </div>
        ) : (
          <div className="thread-col empty-thread">Select a conversation</div>
        )}
      </div>
      {toast && <Toast kind={toast.kind} onDone={() => setToast(null)}>{toast.text}</Toast>}
    </div>
  );

  async function pushPipedrive(c: UIConv) {
    if (!c.live || !c.waPhone) { setToast({ kind: "bad", text: "Pipedrive push needs a live conversation." }); return; }
    try {
      const res = await fetch("/api/pipedrive/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "+" + c.waPhone, name: c.name }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Failed");
      setToast({ kind: "good", text: "Pushed to Pipedrive as a Hot lead." });
    } catch (e: any) {
      setToast({ kind: "bad", text: "Pipedrive push failed: " + e.message });
    }
  }
  async function markUnread(c: UIConv) {
    setConvos((p) => p.map((x) => (x.id === c.id ? { ...x, unread: 1 } : x)));
    if (c.live) patchConvo(c.id, { unread: true });
  }
}

/* CRM context bar — who this number is, pulled from the Audience CRM. */
function CrmContext({ phone }: { phone: string }) {
  const [c, setC] = useState<any>(undefined);
  useEffect(() => {
    setC(undefined);
    fetch(`/api/crm/contact?phone=${encodeURIComponent(phone)}`).then((r) => r.json()).then((d) => setC(d.contact || null)).catch(() => setC(null));
  }, [phone]);
  if (c === undefined) return <div className="ctx-bar"><span style={{ color: "var(--muted)" }}>Checking CRM…</span></div>;
  if (c === null) return <div className="ctx-bar"><span style={{ color: "var(--muted)" }}>Not in Audience CRM yet</span></div>;
  const chips = [c.community, c.building, c.unit_type, c.nationality, c.tier ? `Tier ${c.tier}` : null].filter(Boolean);
  return (
    <div className="ctx-bar">
      {c.name && <span style={{ fontWeight: 700, color: "var(--ink)" }}>{c.name}</span>}
      {chips.map((x: string, i: number) => <span key={i} className="ctx-chip">{x}</span>)}
      {chips.length === 0 && !c.name && <span style={{ color: "var(--muted)" }}>In CRM (no details)</span>}
    </div>
  );
}

/* Attach an image or PDF and send it as a media message (within 24h window). */
function AttachMedia({ phone, from, onSent, notify }: { phone: string; from?: string; onSent: () => void; notify: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("kind", "chat");
      const up = await fetch("/api/upload", { method: "POST", body: fd });
      const ud = await up.json();
      if (!up.ok) throw new Error(ud.error || "Upload failed");
      const res = await fetch("/api/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: "+" + phone, mediaUrl: ud.url, from: from || undefined }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Send failed");
      onSent();
    } catch (err: any) {
      notify(err.message);
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  }
  return (
    <>
      <button className="icon-btn" onClick={() => ref.current?.click()} disabled={busy} title="Attach image or PDF" aria-label="Attach image or PDF"><Icon d={IC.paperclip} s={18} /></button>
      <input ref={ref} type="file" accept="image/*,application/pdf" onChange={pick} style={{ display: "none" }} />
    </>
  );
}
