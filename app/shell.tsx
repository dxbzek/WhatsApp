"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon, IC, Avatar, useModCombo, Toast } from "@/lib/ui";
import { type Sender } from "@/lib/fixtures";
import { formatPhone } from "@/lib/format";
import { useLive } from "@/lib/useLive";

// Two sections, deliberately. This app is the ERE Command Centre with WhatsApp
// as ONE of its channels — not a Twilio console with an extra page bolted on.
// Everything Twilio-specific (the sender switcher, sub-account admin, sender
// health) belongs under WhatsApp and is hidden everywhere else.
const NAV_GROUPS: { section: string; items: { id: string; href: string; icon: React.ReactNode }[] }[] = [
  {
    section: "Overview",
    items: [{ id: "Command Centre", href: "/", icon: IC.dash }],
  },
  {
    section: "WhatsApp",
    items: [
      { id: "Overview", href: "/whatsapp", icon: IC.dash },
      { id: "Inbox", href: "/inbox", icon: IC.inbox },
      { id: "Leads", href: "/leads", icon: IC.users },
      { id: "Templates", href: "/templates", icon: IC.tmpl },
      { id: "Campaigns", href: "/campaigns", icon: IC.camp },
      { id: "Automation", href: "/automation", icon: IC.bolt },
      { id: "Insights", href: "/insights", icon: IC.insights },
      { id: "Suppressed", href: "/suppressed", icon: IC.ban },
      { id: "Sender health", href: "/sender-health", icon: IC.phone },
      { id: "Logs", href: "/logs", icon: IC.clock },
      { id: "Billing", href: "/billing", icon: IC.billing },
    ],
  },
];
const NAV = NAV_GROUPS.flatMap((g) => g.items);

// Routes that are genuinely WhatsApp/Twilio. The sender switcher only makes
// sense on these — on the Command Centre "sending as +971…" is meaningless.
const WA_ROUTES = new Set(NAV_GROUPS[1].items.map((i) => i.href));

const CRUMB: Record<string, string[]> = {
  "/": ["Command Centre"],
  "/whatsapp": ["WhatsApp", "Overview"],
  "/inbox": ["Conversations"],
  "/leads": ["Lead Status"],
  "/templates": ["Content Template Builder", "Templates"],
  "/campaigns": ["Broadcasts"],
  "/automation": ["Automation"],
  "/insights": ["Analytics"],
  "/suppressed": ["Suppressed contacts"],
  "/sender-health": ["Sender health"],
  "/logs": ["Activity log"],
  "/billing": ["Account", "Billing"],
};
const PAGE_TITLE: Record<string, string> = {
  "/": "Command Centre", "/whatsapp": "WhatsApp", "/inbox": "Inbox", "/leads": "Lead Status", "/templates": "Templates",
  "/campaigns": "Campaigns", "/automation": "Automation", "/insights": "Insights",
  "/suppressed": "Suppressed", "/sender-health": "Sender health", "/logs": "Logs", "/billing": "Billing",
};

const initials = (s: string) => s.replace(/[^a-zA-Z ]/g, "").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

export default function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname() || "/";
  const isLogin = path === "/login";
  const [vw, setVw] = useState(1200);
  const [navOpen, setNavOpen] = useState(true);
  // Until mounted we don't know the real width, so CSS owns the default
  // (shown on desktop, hidden on mobile) — avoids a one-frame sidebar flash.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const h = () => setVw(window.innerWidth);
    h();
    const saved = localStorage.getItem("om_nav");
    setNavOpen(saved !== null ? saved === "1" : window.innerWidth > 900);
    setMounted(true);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  useEffect(() => {
    localStorage.setItem("om_nav", navOpen ? "1" : "0");
  }, [navOpen]);

  // Reflect the current section in the tab title.
  useEffect(() => {
    const base = path.startsWith("/inbox") ? "Inbox"
      : path.startsWith("/leads") ? "Lead Status"
      : path.startsWith("/templates") ? "Templates"
      : path.startsWith("/campaigns") ? "Campaigns"
      : path.startsWith("/insights") ? "Insights"
      : path.startsWith("/billing") ? "Billing"
      : PAGE_TITLE[path] || "Console";
    document.title = `ERE Homes · ${base}`;
  }, [path]);

  const isMobile = vw <= 900;
  const closeOnNav = () => { if (isMobile) setNavOpen(false); };

  if (isLogin) return <>{children}</>;

  // Resolve the active top-level route key for crumbs/active state.
  const activeKey = NAV.find((n) => (n.href === "/" ? path === "/" : path.startsWith(n.href)))?.href || "/";

  return (
    <div className="app">
      <Sidebar path={activeKey} open={navOpen} mounted={mounted} isMobile={isMobile} onClose={() => setNavOpen(false)} closeOnNav={closeOnNav} />
      {navOpen && isMobile && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}
      <div className="main">
        <TopBar path={activeKey} navOpen={navOpen} onMenu={() => setNavOpen(true)} />
        <div className="main-scroll">{children}</div>
      </div>
    </div>
  );
}

/* ── Sidebar ── */
function Sidebar({ path, open, mounted, isMobile, onClose, closeOnNav }: { path: string; open: boolean; mounted: boolean; isMobile: boolean; onClose: () => void; closeOnNav: () => void }) {
  const [acctOpen, setAcctOpen] = useState(false);
  // Empty until /api/senders answers. Never seeded with sample numbers — the
  // switcher must only ever show WhatsApp numbers we actually own.
  const [senders, setSenders] = useState<Sender[]>([]);
  const [senderId, setSenderId] = useState<string>("");
  const [mktNumber, setMktNumber] = useState(""); // the subaccount's number, for the badge
  const [utilNumber, setUtilNumber] = useState("");
  // Start at 0 so the badge stays hidden until the live unread count loads —
  // never show a seed number as if it were real.
  const [unread, setUnread] = useState<number>(0);

  // Load the real WhatsApp senders. No fallback: if this fails the switcher
  // shows a neutral placeholder, not an invented number.
  useEffect(() => {
    let live = true;
    fetch("/api/senders")
      .then((r) => r.json())
      .then((d) => {
        if (!live) return;
        const nums: string[] = d.senders || [];
        setMktNumber(d.marketing || "");
        setUtilNumber(d.utility || "");
        if (nums.length) {
          // Lane names matching the real Twilio subaccounts: "ERE Utility (WhatsApp)"
          // and "ERE Marketing (WhatsApp)". BOTH numbers live on subaccounts under
          // the parent (which only holds the balance) — there is no "main line".
          const real: Sender[] = nums.map((n, i) => ({
            id: n,
            sub: "ERE Homes",
            label: n === d.utility ? "ERE Utility" : n === d.marketing ? "ERE Marketing" : `Number ${i + 1}`,
            number: formatPhone(n),
          }));
          setSenders(real);
          const stored = localStorage.getItem("om_sender");
          setSenderId(real.find((s) => s.id === stored) ? stored! : real[0].id);
        }
      })
      .catch(() => { /* leave the switcher on its placeholder */ });
    return () => { live = false; };
  }, []);

  // Live unread badge, via the gated server route (service role) so the browser
  // never reads the conversations table with the public anon key (RLS denies
  // anon). Realtime reaches us via /api/stream instead, which subscribes with
  // the service role on the server — see the useLive call below. The interval
  // here is only a backstop for a dropped stream, and the inbox still dispatches
  // "ere:unread-delta" so the badge moves the instant a thread is opened.
  // Stays at 0 (hidden) when the backend isn't configured or returns nothing —
  // no seed number.
  const refreshUnread = useRef<() => void>(() => {});
  useEffect(() => {
    let live = true;
    async function refresh() {
      try {
        const res = await fetch("/api/conversations?view=unreadCount");
        if (!res.ok) return;
        const { count } = await res.json();
        if (live && typeof count === "number") setUnread(count);
      } catch { /* keep fallback */ }
    }
    refresh();
    refreshUnread.current = refresh;
    const poll = setInterval(refresh, 60000);
    const onDelta = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (typeof d === "number") setUnread((u) => Math.max(0, u + d));
    };
    window.addEventListener("ere:unread-delta", onDelta);
    return () => { live = false; clearInterval(poll); window.removeEventListener("ere:unread-delta", onDelta); };
  }, []);

  // Badge moves the moment an inbound message lands, on whatever page you're on.
  useLive(["conversations", "messages"], () => refreshUnread.current(), 250);

  // Placeholder while /api/senders is in flight or unavailable. Deliberately
  // shows no number rather than a plausible-looking fake one.
  const PLACEHOLDER: Sender = { id: "", sub: "ERE Homes", label: "Loading…", number: "—" };
  const sender = senders.find((s) => s.id === senderId) || senders[0] || PLACEHOLDER;
  const pick = (id: string) => { setSenderId(id); localStorage.setItem("om_sender", id); setAcctOpen(false); };
  // Both lanes are Twilio SUBACCOUNTS (utility AND marketing) under the parent
  // that holds the balance — badge any sender whose lane we know.
  const isSub = (id: string) => (!!mktNumber && id === mktNumber) || (!!utilNumber && id === utilNumber);
  const onSub = isSub(sender.id);
  // The sender switcher and Twilio admin belong to the WhatsApp screens only.
  const onWhatsApp = WA_ROUTES.has(path);

  return (
    <aside className={`sidebar ${!mounted ? "pre-mount" : open ? "" : "collapsed"}`}>
      <div className="side-brand">
        <img className="side-logo-img" src="/ere-logo-white.png" alt="ERE Homes" />
        <button className="side-toggle" onClick={onClose} title="Hide sidebar" aria-label="Hide sidebar"><Icon d={IC.cleft} s={18} /></button>
      </div>

      {/* Sender switcher: WhatsApp screens only. It is Twilio plumbing, and on
          the Command Centre it made the whole app read as a messaging tool. */}
      {onWhatsApp && (
      <div className="side-acct-wrap">
        {acctOpen && <div className="acct-scrim" onClick={() => setAcctOpen(false)} />}
        <button className={`side-acct ${acctOpen ? "on" : ""}`} onClick={() => setAcctOpen((o) => !o)}>
          <div className="av">{initials(sender.label)}</div>
          <div className="lbl">
            <div className="a">{sender.label}{onSub && <span className="sub-badge">Subaccount</span>}</div>
            <div className="b">{sender.number}</div>
          </div>
          <span className="cv"><Icon d={IC.cdown} s={14} /></span>
        </button>
        {acctOpen && (
          <div className="acct-menu">
            <div className="acct-menu-h">Sending as</div>
            {senders.map((s) => (
              <button key={s.id} className={`acct-item ${s.id === senderId ? "on" : ""}`} onClick={() => pick(s.id)}>
                <div className="av">{initials(s.label)}</div>
                <div className="ai-main">
                  <div className="ai-t">{s.label}{isSub(s.id) && <span className="sub-badge">Subaccount</span>}</div>
                  <div className="ai-s">{s.number}</div>
                </div>
                {s.id === senderId && <span className="ai-check"><Icon d={IC.check} s={15} /></span>}
              </button>
            ))}
            <div className="acct-menu-foot">
              <a href="https://console.twilio.com/us1/develop/sms/senders/whatsapp-senders" target="_blank" rel="noreferrer">Manage senders &amp; sub-accounts</a>
            </div>
          </div>
        )}
      </div>
      )}

      {NAV_GROUPS.map((g) => (
        <div key={g.section}>
          <div className="side-sec">{g.section}</div>
          <nav className="side-nav">
            {g.items.map((n) => (
              <Link key={n.href} href={n.href} onClick={closeOnNav} className={`nav-item ${n.href === path ? "active" : ""}`}>
                <span className="ic"><Icon d={n.icon} s={18} /></span>{n.id}
                {n.id === "Inbox" && unread > 0 && <span className="nb">{unread}</span>}
              </Link>
            ))}
          </nav>
        </div>
      ))}

      <div className="side-foot">
        <span className="side-help" style={{ cursor: "default" }}>ERE Homes · Command Centre</span>
      </div>
    </aside>
  );
}

/* ── Top bar ── */
function TopBar({ path, navOpen, onMenu }: { path: string; navOpen: boolean; onMenu: () => void }) {
  const router = useRouter();
  const combo = useModCombo();
  const crumbs = CRUMB[path] || ["Overview"];
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape" && document.activeElement === searchRef.current) searchRef.current?.blur();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  async function enableAlerts() {
    if (typeof Notification === "undefined") { setToast({ kind: "bad", text: "This browser doesn't support notifications." }); return; }
    const p = await Notification.requestPermission();
    setToast(p === "granted" ? { kind: "good", text: "Lead alerts are on — you'll be notified of new replies." } : { kind: "bad", text: "Notifications are blocked. Enable them in your browser settings." });
  }
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  }
  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") { const q = (e.target as HTMLInputElement).value.trim(); router.push(q ? `/inbox?q=${encodeURIComponent(q)}` : "/inbox"); }
  }

  return (
    <header className="topbar">
      {!navOpen && <button className="icon-btn" onClick={onMenu} title="Show sidebar" aria-label="Show sidebar"><Icon d={IC.menu} s={18} /></button>}
      <div className="crumb">
        <span>ERE Homes</span>
        {crumbs.map((c, i) => (
          <span key={i} style={{ display: "contents" }}>
            <span className="sep">/</span>
            <span className={i === crumbs.length - 1 ? "here" : ""}>{c}</span>
          </span>
        ))}
      </div>
      <div className="top-search">
        <Icon d={IC.search} s={16} />
        <input ref={searchRef} id="om-search" placeholder="Search conversations, leads, numbers…" onKeyDown={onSearchKey} />
        {combo && <kbd>{combo}</kbd>}
      </div>
      <button className="icon-btn" title="Turn on lead alerts" aria-label="Turn on lead alerts" onClick={enableAlerts}><Icon d={IC.bell} s={18} /><span className="ping" /></button>
      <div className="top-avatar">
        {/* The signed-in account, not a hardcoded name. "Karim Rahimi" was
            sample data left in the chrome and read as a real user. */}
        <button className="avatar-trigger" onClick={() => setMenuOpen((o) => !o)} title="Account menu" aria-label="Account menu" aria-haspopup="menu" aria-expanded={menuOpen}><Avatar name="ERE Homes" size={30} /></button>
        {menuOpen && (
          <>
            <div className="acct-scrim" onClick={() => setMenuOpen(false)} />
            <div className="avatar-menu">
              <div className="am-head"><div className="am-name">ERE Homes</div><div className="am-mail">marketing@erehomes.ae</div></div>
              <button className="am-item" onClick={() => { setMenuOpen(false); enableAlerts(); }}><Icon d={IC.bell} s={16} />Lead alerts</button>
              <button className="am-item danger" onClick={logout}><Icon d={IC.logout} s={16} />Sign out</button>
            </div>
          </>
        )}
      </div>
      {toast && <Toast kind={toast.kind} onDone={() => setToast(null)}>{toast.text}</Toast>}
    </header>
  );
}
