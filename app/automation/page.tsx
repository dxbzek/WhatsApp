"use client";
import { useEffect, useState } from "react";
import { Icon, IC, PageHead, Skeleton } from "@/lib/ui";

type Rule = {
  id?: string;
  trigger: string;
  reply: string | null;
  block: boolean;
  push_pipedrive: boolean;
  enabled: boolean;
};

const BLANK: Rule = { trigger: "", reply: "", block: false, push_pipedrive: false, enabled: true };

export default function Automation() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Rule | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/auto-replies");
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      setRules(d.rules || []);
    } catch (e: any) { setErr(e.message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function save(r: Rule) {
    setErr(null);
    const res = await fetch("/api/auto-replies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(r) });
    const d = await res.json();
    if (!res.ok) { setErr(d.error); return; }
    setEditing(null);
    load();
  }
  async function remove(id?: string) {
    if (!id || !confirm("Delete this rule?")) return;
    await fetch(`/api/auto-replies?id=${id}`, { method: "DELETE" });
    load();
  }
  async function toggle(r: Rule) {
    await save({ ...r, enabled: !r.enabled });
  }

  return (
    <div className="page"><div className="maxw">
      <PageHead title="Automation" sub="When a contact taps a button or texts a keyword that matches a trigger, the app can auto-reply, block them, and/or create a Hot lead in Pipedrive. Triggers match the button text exactly (case-insensitive).">
        <button className="btn btn-primary" onClick={() => setEditing({ ...BLANK })}><Icon d={IC.plus} s={16} />New rule</button>
      </PageHead>

      {err && <div className="err-box" style={{ marginBottom: 14 }}>{err}</div>}

      {editing && <RuleForm rule={editing} onCancel={() => setEditing(null)} onSave={save} />}

      {loading && <Skeleton rows={4} />}

      {!loading && rules.length > 0 && (
        <div className="autocard">
          {rules.map((r) => (
            <div className="autorule" key={r.id} style={{ opacity: r.enabled ? 1 : 0.6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="kw">
                    <span className="tag">{r.trigger}</span>
                    {r.block && <span className="badge" style={{ color: "var(--red-ink)", background: "var(--red-bg)", borderColor: "var(--red-border)" }}>blocks</span>}
                    {r.push_pipedrive && <span className="badge" style={{ color: "var(--green-ink)", background: "var(--green-bg)", borderColor: "var(--green-border)" }}>→ Pipedrive</span>}
                    {!r.enabled && <span className="badge" style={{ color: "var(--ink-2)", background: "var(--chip)", borderColor: "var(--border)" }}>off</span>}
                  </div>
                  {r.reply && <div style={{ fontSize: 13, color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{r.reply}</div>}
                  {!r.reply && !r.block && !r.push_pipedrive && <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>No action set</div>}
                </div>
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => toggle(r)}>{r.enabled ? "Disable" : "Enable"}</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditing(r)}>Edit</button>
                  <button className="btn btn-ghost btn-sm danger" onClick={() => remove(r.id)}>Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && rules.length === 0 && (
        <div className="empty">
          <div className="ei"><Icon d={IC.bolt} s={22} /></div>
          <h4>No rules yet</h4>
          <div>Add one to start auto-replying to button taps.</div>
        </div>
      )}
    </div></div>
  );
}

function RuleForm({ rule, onCancel, onSave }: { rule: Rule; onCancel: () => void; onSave: (r: Rule) => void }) {
  const [r, setR] = useState<Rule>({ ...rule, reply: rule.reply || "" });
  return (
    <div className="card">
      <div className="card-head"><div className="card-t">{rule.id ? "Edit rule" : "New rule"}</div></div>
      <div className="field">
        <label className="label">Trigger (button text / keyword)</label>
        <input className="input" value={r.trigger} onChange={(e) => setR({ ...r, trigger: e.target.value })} placeholder="e.g. MANAGE" />
      </div>
      <div className="field">
        <label className="label">Auto-reply message <span className="opt">(optional)</span></label>
        <textarea className="input" value={r.reply || ""} onChange={(e) => setR({ ...r, reply: e.target.value })} rows={3} placeholder="Message to send back automatically" />
      </div>
      <div className="checkrow" style={{ marginBottom: 16 }}>
        <label>
          <input type="checkbox" checked={r.push_pipedrive} onChange={(e) => setR({ ...r, push_pipedrive: e.target.checked })} /> Create Hot lead in Pipedrive
        </label>
        <label>
          <input type="checkbox" checked={r.block} onChange={(e) => setR({ ...r, block: e.target.checked })} /> Block (opt-out)
        </label>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn btn-primary" onClick={() => onSave(r)}>Save rule</button>
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
