// Polished loading + error states for the dashboard. Kept presentational and
// self-contained so they can't affect the auth or data-fetch logic.

function SkelCard({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-2xl border border-sand bg-white ${className}`} />;
}

/** A calm shimmer that mirrors the dashboard's shape while data loads. */
export function DashboardSkeleton() {
  return (
    <div className="mx-auto max-w-5xl px-4 pb-20 pt-8 sm:px-6">
      <div className="mb-6 flex items-center justify-between">
        <div className="space-y-2">
          <div className="h-7 w-52 animate-pulse rounded-lg bg-secondary" />
          <div className="h-4 w-36 animate-pulse rounded bg-secondary/70" />
        </div>
        <div className="h-4 w-24 animate-pulse rounded bg-secondary/70" />
      </div>
      <SkelCard className="mb-4 h-44" />
      <SkelCard className="mb-4 h-20" />
      <div className="grid gap-4 md:grid-cols-2">
        <SkelCard className="h-72" />
        <SkelCard className="h-72" />
      </div>
    </div>
  );
}

/** Shown when a load fails for a reason other than an expired session. */
export function DashboardLoadError({ onRetry, onLogout }: { onRetry: () => void; onLogout: () => void }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-5 text-center">
      <span className="text-4xl" aria-hidden>🌿</span>
      <h1 className="mt-4 font-serif text-2xl text-foreground">We couldn't load your progress</h1>
      <p className="mt-2 text-muted-foreground">
        That's on us, not you. Give it another try in a moment — your data is safe.
      </p>
      <div className="mt-6 flex gap-3">
        <button onClick={onRetry} className="h-12 rounded-full bg-primary px-6 font-medium text-white">Try again</button>
        <button onClick={onLogout} className="h-12 rounded-full border border-sand px-6 font-medium text-foreground/70">Sign out</button>
      </div>
    </div>
  );
}
