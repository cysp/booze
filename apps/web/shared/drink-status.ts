export const drinkStatuses = ["drink-now", "drink-soon", "hold", "past-window", "unknown"] as const;
export type DrinkStatus = (typeof drinkStatuses)[number];

export function calculateDrinkStatus({
  drinkFromYear,
  drinkToYear,
  now = new Date(),
}: {
  readonly drinkFromYear: number | null;
  readonly drinkToYear: number | null;
  readonly now?: Date;
}): DrinkStatus {
  if (drinkFromYear === null && drinkToYear === null) return "unknown";
  const currentYear = now.getUTCFullYear();
  if (drinkToYear !== null && currentYear > drinkToYear) return "past-window";
  if (drinkFromYear !== null && currentYear < drinkFromYear) return "hold";
  if (drinkToYear !== null && drinkToYear - currentYear <= 2) return "drink-soon";
  return "drink-now";
}
