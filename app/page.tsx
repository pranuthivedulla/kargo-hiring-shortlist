"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./dashboard.module.css";
import type { Decision, DecisionsFile, DecisionStatus, RunFile, Signal } from "@/lib/types";

type Role = "PM" | "SPM" | "OPEN";

const ROLE_LABEL: Record<Role, string> = {
  PM: "Product Manager",
  SPM: "Senior Product Manager",
  OPEN: "Role not stated",
};

const ROLES: Role[] = ["PM", "SPM", "OPEN"];

type RunPayload = {
  run: RunFile | null;
  decisions: DecisionsFile;
  available: number;
  batchCap: number;
  /** When set, every message goes here and no CV address is used. */
  sendOverrideTo: string | null;
};

const badgeClass = (s: Signal | undefined) =>
  s === "STRONG" ? styles.strong : s === "PARTIAL" ? styles.partial : styles.absent;

const key = (name: string) => name.toLowerCase().replace(/\s+/g, " ").trim();

export default function Dashboard() {
  const [role, setRole] = useState<Role>("PM");
  const [data, setData] = useState<Record<Role, RunPayload | null>>({
    PM: null,
    SPM: null,
    OPEN: null,
  });
  const [loaded, setLoaded] = useState<Partial<Record<Role, true>>>({});
  const [errors, setErrors] = useState<Partial<Record<Role, string>>>({});
  const [running, setRunning] = useState(false);
  const [showRejected, setShowRejected] = useState(false);
  const [pending, setPending] = useState<Decision | null>(null);

  const loading = !loaded[role];
  const error = errors[role] ?? null;
  const setError = useCallback(
    (msg: string | null) => setErrors((e) => ({ ...e, [role]: msg ?? undefined })),
    [role],
  );

  const load = useCallback(async (r: Role) => {
    const res = await fetch(`/api/run?role=${r}`, { cache: "no-store" });
    const json = (await res.json()) as RunPayload & { error?: string };
    if (!res.ok) throw new Error(json.error ?? "Could not load this role.");
    setData((d) => ({ ...d, [r]: json }));
  }, []);

  // Fetching the stored run for the selected role. Every state write happens
  // after the await, so switching tabs mid-flight cannot clobber the new role.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await load(role);
        if (!cancelled) setErrors((e) => ({ ...e, [role]: undefined }));
      } catch (e) {
        if (!cancelled) setErrors((prev) => ({ ...prev, [role]: (e as Error).message }));
      } finally {
        if (!cancelled) setLoaded((l) => ({ ...l, [role]: true }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [role, load]);

  const payload = data[role];
  const run = payload?.run ?? null;
  const decisions = useMemo(() => payload?.decisions ?? {}, [payload]);

  const idFor = useCallback((name: string) => run?.candidateIds?.[key(name)] ?? key(name), [run]);

  const runBatch = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "The batch run failed.");
      await load(role);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  /**
   * Records the decision immediately and returns a drafted message. Nothing is
   * sent here — the draft opens in a dialog for Arjun to read and confirm.
   */
  const decide = async (candidate: string, status: DecisionStatus) => {
    setError(null);
    try {
      const res = await fetch("/api/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: idFor(candidate), candidate, role, status }),
      });
      const json = (await res.json()) as { decision?: Decision; error?: string };
      if (!res.ok || !json.decision) throw new Error(json.error ?? "Could not record the decision.");
      await load(role);
      setPending(json.decision);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const gateFailed = useMemo(
    () => run?.notAdvancing.filter((n) => n.status === "GATE_FAILED").length ?? 0,
    [run],
  );
  const advancedCount = useMemo(
    () =>
      Object.values(decisions).filter(
        (d) => d.role === role && d.status === "advanced" && d.comms.state === "sent",
      ).length,
    [decisions, role],
  );

  const stubbed = run?.model.includes("STUB") ?? false;

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <span className={styles.brandName}>Kargo</span>
          <span className={styles.brandSub}>Hiring Shortlist</span>
        </div>
        <div className={styles.topRight}>
          {run && (
            <span className={styles.pill}>
              {stubbed
                ? "Stubbed run — no model call"
                : `Ranked ${new Date(run.createdAt).toLocaleString()}`}
            </span>
          )}
          <button className={styles.runBtn} onClick={runBatch} disabled={running || loading}>
            {running ? "Running…" : run ? "Re-run batch" : "Run batch"}
          </button>
        </div>
      </header>

      <div className={styles.tabRow}>
        <div className={styles.tabs} role="tablist" aria-label="Open roles">
          {ROLES.map((r) => (
            <button
              key={r}
              role="tab"
              aria-selected={role === r}
              className={`${styles.tab} ${role === r ? styles.tabActive : ""}`}
              onClick={() => setRole(r)}
            >
              {ROLE_LABEL[r]}
            </button>
          ))}
        </div>
        <div className={styles.gateSummary}>
          {run
            ? `${run.batchTotal} CVs reviewed · ${run.shortlist.length} passed gate · ${gateFailed} gated out`
            : `${payload?.available ?? 0} CVs ingested · not yet ranked`}
        </div>
      </div>

      <main className={styles.main}>
        <section className={styles.column}>
          <div className={styles.columnHead}>
            <h1>Ranked shortlist</h1>
            <span className={styles.columnMeta}>
              {run ? `${run.shortlist.length} candidates passed the gate` : "—"}
            </span>
          </div>

          {error && <div className={styles.error}>{error}</div>}
          {loading && <div className={styles.spinner}>Loading…</div>}

          {!loading && !run && (
            <div className={styles.empty}>
              No batch has been run for {ROLE_LABEL[role]} yet. {payload?.available ?? 0} CVs are
              ingested and ready (cap {payload?.batchCap ?? 30} per run). Nothing is ranked, and no
              message is drafted, until you press <b>Run batch</b>.
            </div>
          )}

          {run?.shortlist.map((c) => {
            const d = decisions[idFor(c.candidate)];
            return (
              <article key={c.candidate} className={styles.card}>
                <div className={styles.cardHead}>
                  <div className={styles.rank}>{c.rank}</div>
                  <div className={styles.who}>
                    <div className={styles.name}>{c.candidate}</div>
                    <div className={styles.role}>{c.role}</div>
                  </div>
                  <div className={`${styles.badge} ${badgeClass(c.primary_signal)}`}>
                    Primary · {c.primary_signal}
                  </div>
                  <div className={`${styles.badge} ${badgeClass(c.secondary_signal)}`}>
                    Secondary · {c.secondary_signal}
                  </div>
                  {c.recommended_role && (
                    <div className={`${styles.badge} ${styles.recommend}`}>
                      Suggest · {c.recommended_role}
                    </div>
                  )}
                </div>

                <div className={styles.well}>
                  <div className={styles.wellCol}>
                    <div className={styles.wellLabel}>Why ranked here</div>
                    <div className={styles.wellBody}>{c.why_ranked_here}</div>
                  </div>
                  <div className={styles.wellCol}>
                    <div className={styles.wellLabel}>What to probe</div>
                    <ul className={styles.probeList}>
                      {c.what_to_probe.map((q, i) => (
                        <li key={i}>{q}</li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className={styles.evidence}>
                  <strong>Primary:</strong> {c.primary_evidence}
                  <br />
                  <strong>Secondary:</strong> {c.secondary_evidence}
                  {c.role_rationale && (
                    <>
                      <br />
                      <strong>Why this role:</strong> {c.role_rationale}
                    </>
                  )}
                </div>

                <div className={styles.actions}>
                  {d ? (
                    <>
                      <span className={`${styles.status} ${statusClass(d)}`}>{statusLabel(d)}</span>
                      {(d.comms.state === "pending" || d.comms.state === "failed") && (
                        <button className={styles.btnSolid} onClick={() => setPending(d)}>
                          Review message
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <button
                        className={styles.btnGhost}
                        onClick={() => decide(c.candidate, "rejected")}
                      >
                        Reject
                      </button>
                      <button
                        className={styles.btnSolid}
                        onClick={() => decide(c.candidate, "advanced")}
                      >
                        Advance
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </section>

        <aside className={styles.sidebar}>
          <div className={styles.panel}>
            <div className={styles.panelTitle}>Batch summary</div>
            <div className={styles.statRow}>
              <span>CVs in this run</span>
              <b>{run?.batchTotal ?? 0}</b>
            </div>
            <div className={styles.statRow}>
              <span>Passed gate</span>
              <b style={{ color: "var(--good)" }}>{run?.shortlist.length ?? 0}</b>
            </div>
            <div className={styles.statRow}>
              <span>Gated out</span>
              <b style={{ color: "var(--accent)" }}>{gateFailed}</b>
            </div>
            <div className={styles.statRow}>
              <span>Interview invites sent</span>
              <b>{advancedCount}</b>
            </div>
          </div>

          <div className={styles.panel}>
            <button className={styles.toggle} onClick={() => setShowRejected((v) => !v)}>
              <span>Not advancing — with reason</span>
              <span className={styles.toggleMeta}>
                {run?.notAdvancing.length ?? 0} · {showRejected ? "Hide" : "Show"}
              </span>
            </button>
            {showRejected && (
              <div className={styles.rejectList}>
                {(run?.notAdvancing ?? []).map((n) => {
                  const d = decisions[idFor(n.candidate)];
                  return (
                    <div key={n.candidate} className={styles.rejectItem}>
                      <div className={styles.rejectHead}>
                        <span className={styles.rejectName}>{n.candidate}</span>
                        <span className={styles.rejectStatus}>
                          {n.recommended_role === "NEITHER"
                            ? "Fits neither role"
                            : n.status === "GATE_FAILED"
                              ? "Gate failed"
                              : "Ranked, not shortlisted"}
                        </span>
                      </div>
                      <div className={styles.rejectReason}>{n.reason}</div>
                      <div className={styles.actions} style={{ marginTop: 8 }}>
                        {d ? (
                          <>
                            <span className={`${styles.status} ${statusClass(d)}`}>
                              {statusLabel(d)}
                            </span>
                            {(d.comms.state === "pending" || d.comms.state === "failed") && (
                              <button className={styles.btnGhost} onClick={() => setPending(d)}>
                                Review
                              </button>
                            )}
                          </>
                        ) : (
                          <button
                            className={styles.btnGhost}
                            onClick={() => decide(n.candidate, "rejected")}
                          >
                            Send decline
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
                {(run?.notAdvancing.length ?? 0) === 0 && (
                  <div className={styles.rejectReason}>Nothing here yet.</div>
                )}
              </div>
            )}
          </div>

          <div className={styles.note}>
            <div className={styles.noteTitle}>Scheduling</div>
            <div className={styles.noteBody}>
              Advancing a candidate calls Calendly for a single-use booking link and drafts the
              interview-invite email. Nothing reaches the candidate until you read the draft and
              confirm it.
            </div>
          </div>
        </aside>
      </main>

      {pending && (
        <ConfirmDialog
          decision={pending}
          overrideTo={payload?.sendOverrideTo ?? null}
          onClose={() => setPending(null)}
          onDone={async () => {
            setPending(null);
            await load(role);
          }}
        />
      )}
    </div>
  );
}

function statusClass(d: Decision) {
  if (d.comms.state === "failed") return styles.statusFailed;
  if (d.comms.state === "pending") return styles.statusPending;
  return d.status === "advanced" ? styles.statusAdvanced : styles.statusRejected;
}

function statusLabel(d: Decision) {
  const word = d.status === "advanced" ? "Advanced" : "Rejected";
  if (d.comms.state === "pending") return `${word} — message not sent yet`;
  if (d.comms.state === "failed") return `${word} — send failed`;
  if (d.comms.state === "skipped") return `${word} — no message sent`;
  return d.status === "advanced" ? "Advanced — invite sent" : "Rejected — decline sent";
}

function ConfirmDialog({
  decision,
  overrideTo,
  onClose,
  onDone,
}: {
  decision: Decision;
  overrideTo: string | null;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [email, setEmail] = useState(decision.email ?? "");
  const [subject, setSubject] = useState(decision.comms.subject ?? "");
  const [body, setBody] = useState(decision.comms.body ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(decision.comms.error ?? null);

  const act = async (send: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: decision.candidateId, send, email, subject, body }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Send failed.");
      await onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label="Confirm message">
      <div className={styles.dialog}>
        <h2>
          {decision.status === "advanced" ? "Interview invite" : "Decline"} — {decision.candidate}
        </h2>
        <p className={styles.dialogLead}>
          The decision is already recorded. This message has not been sent. Read it, edit anything
          you want, then send — or close and send later.
        </p>

        {overrideTo && (
          <div className={styles.override}>
            <b>Test mode.</b> Every message is sent to <b>{overrideTo}</b>. No address is
            read from any CV, and editing the field below will not change where this goes.
          </div>
        )}

        {decision.comms.bookingUrl && (
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Calendly booking link (single use)</span>
            <a href={decision.comms.bookingUrl} target="_blank" rel="noreferrer">
              {decision.comms.bookingUrl}
            </a>
          </div>
        )}

        <label className={styles.field}>
          <span className={styles.fieldLabel}>To</span>
          <input
            className={styles.input}
            value={overrideTo ?? email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="candidate@example.com"
            type="email"
            disabled={!!overrideTo}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Subject</span>
          <input
            className={styles.input}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Body</span>
          <textarea
            className={styles.textarea}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>

        {err && <div className={styles.error}>{err}</div>}

        <div className={styles.dialogActions}>
          <button className={styles.btnGhost} onClick={onClose} disabled={busy}>
            Close without sending
          </button>
          <button className={styles.btnGhost} onClick={() => act(false)} disabled={busy}>
            Mark as handled elsewhere
          </button>
          <button
            className={styles.btnSolid}
            onClick={() => act(true)}
            disabled={busy || !(overrideTo ?? email)}
          >
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
