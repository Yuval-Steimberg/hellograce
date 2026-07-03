import type { DashboardSummary } from "@/lib/dashboardApi";

const CLAY = "#B05A41";

/**
 * A scannable read of what's been logged today. Each row shows the food and its
 * protein/calorie estimate, with a running total footer. Friendly empty state.
 */
export function TodaysMeals({ nutrition }: { nutrition: DashboardSummary["nutrition"] }) {
  const items = nutrition.today.items;

  return (
    <div className="rounded-2xl border border-sand bg-white p-5 shadow-[0_1px_2px_rgba(36,31,27,0.04)]">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="font-serif text-lg text-foreground">Today's meals</h3>
        {items.length > 0 && (
          <span className="text-xs text-muted-foreground">{items.length} logged</span>
        )}
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-sand bg-secondary/30 px-6 py-7 text-center">
          <span className="text-2xl" aria-hidden>🍽️</span>
          <p className="mt-2 text-sm text-muted-foreground">Nothing logged yet today. Add a meal from the panel — or just text Grace.</p>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-sand/70">
            {items.map((it, i) => (
              <li key={i} className="flex items-center justify-between gap-3 py-2.5 first:pt-0">
                <span className="min-w-0 truncate text-sm text-foreground/85">{it.food}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  <span className="font-medium" style={{ color: CLAY }}>{it.protein}g</span> · {it.calories} kcal
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center justify-between border-t border-sand pt-3 text-sm">
            <span className="text-muted-foreground">Total today</span>
            <span className="font-medium text-foreground">
              {nutrition.today.protein}g protein · {nutrition.today.calories} kcal
            </span>
          </div>
        </>
      )}
    </div>
  );
}
