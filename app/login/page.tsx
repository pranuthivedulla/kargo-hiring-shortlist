"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import styles from "./login.module.css";

function LoginForm() {
  const params = useSearchParams();
  const next = params.get("next") || "/";

  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not sign in.");
      // A full navigation, so the middleware sees the new cookie.
      window.location.href = next;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form className={styles.card} onSubmit={submit}>
      <div className={styles.brand}>
        <span className={styles.brandName}>Kargo</span>
        <span className={styles.brandSub}>Hiring Shortlist</span>
      </div>

      <p className={styles.lead}>
        This dashboard holds candidate applications and the reasoning behind every
        shortlisting decision. Enter the password you were given.
      </p>

      <label className={styles.field}>
        <span className={styles.label}>Password</span>
        <input
          className={styles.input}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          autoComplete="current-password"
        />
      </label>

      {error && <div className={styles.error}>{error}</div>}

      <button className={styles.button} type="submit" disabled={busy || !password}>
        {busy ? "Checking…" : "Open dashboard"}
      </button>

      <p className={styles.note}>
        One shared password, not a personal account. Nothing here is sent to any candidate
        without an explicit confirmation.
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className={styles.shell}>
      <Suspense fallback={<div className={styles.card}>Loading…</div>}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
