"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <Login />
    </Suspense>
  );
}

function Login() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Login failed");
      router.replace(params.get("next") || "/");
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form onSubmit={submit} className="login-card">
        <div className="login-brand">
          <div className="brand-tile" aria-label="ERE Homes">ERE</div>
          <div><div className="lb-n">ERE Homes</div><div className="lb-s">WhatsApp Console</div></div>
        </div>

        <div className="field">
          <label className="label">Email</label>
          <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" placeholder="marketing@erehomes.ae" />
        </div>
        <div className="field">
          <label className="label">Password</label>
          <input className="input" value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" placeholder="••••••••" />
        </div>

        {err && <div className="err-box" style={{ marginTop: 0, marginBottom: 14 }}>{err}</div>}

        <button type="submit" disabled={busy} className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 14, textAlign: "center" }}>Access restricted to the ERE Homes marketing team.</div>
      </form>
    </div>
  );
}
