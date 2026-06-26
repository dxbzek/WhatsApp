"use client";

// Simple client-side pager: "N entries · page X of Y" + Prev/Next.
// Pages are 1-based. Buttons disable at the ends. Used by Logs + Suppressed so
// long lists show in pages instead of one endless scroll.
export function Pager({
  page,
  totalPages,
  total,
  onPage,
  unit = "entries",
}: {
  page: number;
  totalPages: number;
  total: number;
  onPage: (p: number) => void;
  unit?: string;
}) {
  if (total === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        marginTop: 12,
        fontSize: 13,
        color: "var(--ink-3)",
      }}
    >
      <span>
        {total.toLocaleString()} {unit} · page {page} of {totalPages}
      </span>
      <div style={{ display: "flex", gap: 6 }}>
        <button className="btn btn-sec btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Prev
        </button>
        <button className="btn btn-sec btn-sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}
