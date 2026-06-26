// Direct Pipedrive integration (no Ulgebra). Pushes a WhatsApp lead into
// Pipedrive: find-or-create the person by phone, then open a Hot lead + note.
const clean = (v?: string) => (v || "").replace(/^\uFEFF/, "").trim();
const TOKEN = () => clean(process.env.PIPEDRIVE_API_TOKEN);
const BASE = "https://api.pipedrive.com/v1";

// Lead label ids (ERE Homes Pipedrive)
const LABEL_HOT = "d1b2a296-7a18-44d2-ac63-5b096641a3af";
const JSON_HEADERS = { "Content-Type": "application/json" };

async function pd(path: string, init?: RequestInit) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${BASE}${path}${sep}api_token=${TOKEN()}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.success === false) {
    throw new Error(data?.error || `Pipedrive ${res.status}`);
  }
  return data.data;
}

// Resolve a lead-label id by name (Hot/Warm/Cold…), cached per process.
let _labels: any[] | null = null;
export async function leadLabelIdByName(name: string): Promise<string | null> {
  if (!_labels) _labels = (await pd(`/leadLabels`).catch(() => [])) || [];
  const labels = _labels || [];
  const f = labels.find((l) => (l.name || "").toLowerCase() === name.toLowerCase());
  return f ? f.id : null;
}

// Find a person by phone, creating one if none exists.
export async function findOrCreatePersonByPhone(phone: string, name?: string) {
  const p = phone.startsWith("+") ? phone : `+${phone}`;
  let person = await findPersonByPhone(p);
  if (!person) {
    person = await pd(`/persons`, {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ name: name || p, phone: [{ value: p, primary: true, label: "mobile" }] }),
    });
  }
  return person;
}

// Ensure a lead exists for a person; reuse a known id, else find or create one.
export async function ensureLead(personId: number, title: string, knownLeadId?: string | null) {
  if (knownLeadId) {
    const ok = await pd(`/leads/${knownLeadId}`).catch(() => null);
    if (ok) return knownLeadId;
  }
  const list = await pd(`/leads?person_id=${personId}&limit=1`).catch(() => null);
  if (list && list.length) return list[0].id;
  const lead = await pd(`/leads`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ title, person_id: personId }) });
  return lead.id;
}

export async function setLeadLabel(leadId: string, labelId: string | null) {
  await pd(`/leads/${leadId}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ label_ids: labelId ? [labelId] : [] }) });
}

// Assign a lead to an agent (Pipedrive user) so it lands in their queue.
export async function setLeadOwner(leadId: string, ownerId: number) {
  await pd(`/leads/${leadId}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ owner_id: ownerId }) });
}

// List active Pipedrive users (id + name + email), for mapping agents to
// their Pipedrive owner id. Cached per process.
let _users: any[] | null = null;
export async function listPipedriveUsers(): Promise<{ id: number; name: string; email: string }[]> {
  if (!_users) _users = (await pd(`/users`).catch(() => [])) || [];
  return (_users || []).map((u: any) => ({ id: u.id, name: u.name, email: u.email }));
}

// Keep a single running WhatsApp-transcript note on the person up to date.
export async function upsertWhatsAppNote(personId: number, content: string, noteId?: string | null) {
  if (noteId) {
    const ok = await pd(`/notes/${noteId}`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ content }) }).catch(() => null);
    if (ok !== null) return noteId;
  }
  const note = await pd(`/notes`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ content, person_id: personId }) });
  return note.id;
}

export async function findPersonByPhone(phone: string) {
  const term = encodeURIComponent(phone.replace(/^whatsapp:/, ""));
  const data = await pd(`/persons/search?term=${term}&fields=phone&exact_match=false&limit=1`);
  const items = data?.items || [];
  return items.length ? items[0].item : null;
}

export async function pushLeadFromWhatsApp(opts: { phone: string; name?: string; note?: string }) {
  const phone = opts.phone.startsWith("+") ? opts.phone : `+${opts.phone}`;
  let person = await findPersonByPhone(phone);
  let created = false;
  if (!person) {
    person = await pd(`/persons`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: opts.name || phone,
        phone: [{ value: phone, primary: true, label: "mobile" }],
      }),
    });
    created = true;
  }

  const lead = await pd(`/leads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `${opts.name || phone} - WhatsApp`,
      person_id: person.id,
      label_ids: [LABEL_HOT],
    }),
  });

  if (opts.note) {
    await pd(`/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: opts.note, lead_id: lead.id }),
    }).catch(() => {});
  }

  return { personId: person.id, leadId: lead.id, personCreated: created };
}
