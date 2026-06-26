"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon, IC, Avatar, useModCombo, Toast } from "@/lib/ui";
import { SENDERS, type Sender } from "@/lib/fixtures";
import { formatPhone } from "@/lib/format";

const NAV = [
  { id: "Dashboard", href: "/", icon: IC.dash },
  { id: "Inbox", href: "/inbox", icon: IC.inbox },
  { id: "Templates", href: "/templates", icon: IC.tmpl },
  { id: "Campaigns", href: "/campaigns", icon: IC.camp },
  { id: "Automation", href: "/automation", icon: IC.bolt },
  { id: "Insights", href: "/insights", icon: IC.insights },
  { id: "Suppressed", href: "/suppressed", icon: IC.ban },
  { id: "Logs", href: "/logs", icon: IC.clock },
  { id: "Billing", href: "/billing", icon: IC.billing },
];

const CRUMB: Record<string, string[]> = {
  "/": ["Overview"],
  "/inbox": ["Conversations"],
  "/templates": ["Content Template Builder", "Templates"],
  "/campaigns": ["Broadcasts"],
  "/automation": ["Automation"],
  "/insights": ["Analytics"],
  "/suppressed": ["Suppressed contacts"],
  "/logs": ["Activity log"],
  "/billing": ["Account", "Billing"],
};
const PAGE_TITLE: Record<string, string> = {
  "/": "Dashboard", "/inbox": "Inbox", "/templates": "Templates",
  "/campaigns": "Campaigns", "/automation": "Automation", "/insights": "Insights",
  "/suppressed": "Suppressed", "/logs": "Logs", "/billing": "Billing",
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
  const [senders, setSenders] = useState<Sender[]>(SENDERS);
  const [senderId, setSenderId] = useState<string>(SENDERS[0].id);
  // Start at 0 so the badge stays hidden until the live unread count loads —
  // never show a seed number as if it were real.
  const [unread, setUnread] = useState<number>(0);

  // Load real WhatsApp senders; fall back to the fixtures.
  useEffect(() => {
    let live = true;
    fetch("/api/senders")
      .then((r) => r.json())
      .then((d) => {
        if (!live) return;
        const nums: string[] = d.senders || [];
        if (nums.length) {
          const real: Sender[] = nums.map((n, i) => ({ id: n, sub: i === 0 ? "ERE Homes" : "ERE Homes", label: i === 0 ? "Main line" : `Number ${i + 1}`, number: formatPhone(n) }));
          setSenders(real);
          const stored = localStorage.getItem("om_sender");
          setSenderId(real.find((s) => s.id === stored) ? stored! : real[0].id);
        } else {
          const stored = localStorage.getItem("om_sender");
          if (stored && SENDERS.find((s) => s.id === stored)) setSenderId(stored);
        }
      })
      .catch(() => {
        const stored = localStorage.getItem("om_sender");
        if (stored && SENDERS.find((s) => s.id === stored)) setSenderId(stored);
      });
    return () => { live = false; };
  }, []);

  // Live unread badge, via the gated server route (service role) so the browser
  // never reads the conversations table with the public anon key. Polls every
  // 15s instead of Supabase realtime. Stays at 0 (hidden) when the backend isn't
  // configured or returns nothing — no seed number.
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
    const poll = setInterval(refresh, 15000);
    return () => { live = false; clearInterval(poll); };
  }, []);

  const sender = senders.find((s) => s.id === senderId) || senders[0];
  const pick = (id: string) => { setSenderId(id); localStorage.setItem("om_sender", id); setAcctOpen(false); };

  return (
    <aside className={`sidebar ${!mounted ? "pre-mount" : open ? "" : "collapsed"}`}>
      <div className="side-brand">
        <div className="side-logo brand-tile" aria-label="ERE Homes">ERE</div>
        <div className="bt"><div className="n">ERE Homes</div><div className="s">Messaging</div></div>
        <button className="side-toggle" onClick={onClose} title="Hide sidebar" aria-label="Hide sidebar"><Icon d={IC.cleft} s={18} /></button>
      </div>

      <div className="side-acct-wrap">
        {acctOpen && <div className="acct-scrim" onClick={() => setAcctOpen(false)} />}
        <button className={`side-acct ${acctOpen ? "on" : ""}`} onClick={() => setAcctOpen((o) => !o)}>
          <div className="av">{initials(sender.label)}</div>
          <div className="lbl"><div className="a">{sender.sub} · {sender.label}</div><div className="b">{sender.number}</div></div>
          <span className="cv"><Icon d={IC.cdown} s={14} /></span>
        </button>
        {acctOpen && (
          <div className="acct-menu">
            <div className="acct-menu-h">Switch WhatsApp sender</div>
            {senders.map((s) => (
              <button key={s.id} className={`acct-item ${s.id === senderId ? "on" : ""}`} onClick={() => pick(s.id)}>
                <div className="av">{initials(s.label)}</div>
                <div className="ai-main"><div className="ai-t">{s.sub} · {s.label}</div><div className="ai-s">{s.number}</div></div>
                {s.id === senderId && <span className="ai-check"><Icon d={IC.check} s={15} /></span>}
              </button>
            ))}
            <div className="acct-menu-foot">
              <a href="https://console.twilio.com/us1/develop/sms/senders/whatsapp-senders" target="_blank" rel="noreferrer">Manage senders &amp; sub-accounts</a>
            </div>
          </div>
        )}
      </div>

      <div className="side-sec">Messaging</div>
      <nav className="side-nav">
        {NAV.map((n) => (
          <Link key={n.id} href={n.href} onClick={closeOnNav} className={`nav-item ${n.href === path ? "active" : ""}`}>
            <span className="ic"><Icon d={n.icon} s={18} /></span>{n.id}
            {n.id === "Inbox" && unread > 0 && <span className="nb">{unread}</span>}
          </Link>
        ))}
      </nav>

      <div className="side-foot">
        <a href="https://www.twilio.com/docs/whatsapp" target="_blank" rel="noreferrer" className="side-help"><Icon d={IC.help} s={17} />Docs &amp; support</a>
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
        <span>Messaging</span>
        {crumbs.map((c, i) => (
          <span key={i} style={{ display: "contents" }}>
            <span className="sep">/</span>
            <span className={i === crumbs.length - 1 ? "here" : ""}>{c}</span>
          </span>
        ))}
      </div>
      <div className="top-search">
        <Icon d={IC.search} s={16} />
        <input ref={searchRef} id="om-search" placeholder="Search resources, SID, docs…" onKeyDown={onSearchKey} />
        {combo && <kbd>{combo}</kbd>}
      </div>
      <button className="icon-btn" title="Turn on lead alerts" aria-label="Turn on lead alerts" onClick={enableAlerts}><Icon d={IC.bell} s={18} /><span className="ping" /></button>
      <a className="icon-btn" href="https://www.twilio.com/docs/whatsapp" target="_blank" rel="noreferrer" title="Help" aria-label="Help"><Icon d={IC.help} s={18} /></a>
      <div className="top-avatar">
        <button className="avatar-trigger" onClick={() => setMenuOpen((o) => !o)} title="Account menu" aria-label="Account menu" aria-haspopup="menu" aria-expanded={menuOpen}><Avatar name="Karim Rahimi" size={30} /></button>
        {menuOpen && (
          <>
            <div className="acct-scrim" onClick={() => setMenuOpen(false)} />
            <div className="avatar-menu">
              <div className="am-head"><div className="am-name">Karim Rahimi</div><div className="am-mail">marketing@erehomes.ae</div></div>
              <button className="am-item" onClick={() => { setMenuOpen(false); enableAlerts(); }}><Icon d={IC.bell} s={16} />Lead alerts</button>
              <a className="am-item" href="https://www.twilio.com/docs/whatsapp" target="_blank" rel="noreferrer"><Icon d={IC.help} s={16} />Docs &amp; support</a>
              <button className="am-item danger" onClick={logout}><Icon d={IC.logout} s={16} />Sign out</button>
            </div>
          </>
        )}
      </div>
      {toast && <Toast kind={toast.kind} onDone={() => setToast(null)}>{toast.text}</Toast>}
    </header>
  );
}
