import { additionReceipts, type BoozeDatabase } from "@chikachow/booze-db";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";

export type AdditionOperation = {
  readonly userId: string;
  readonly kind: "bottles" | "capture";
  readonly operationId: string;
  readonly siteId: string;
  readonly fingerprint: string;
};

export async function getAdditionReceipt<Result>(
  database: BoozeDatabase,
  operation: AdditionOperation,
  resultSchema: z.ZodType<Result>,
): Promise<Result | undefined> {
  const [receipt] = await database
    .select()
    .from(additionReceipts)
    .where(
      and(
        eq(additionReceipts.userId, operation.userId),
        eq(additionReceipts.kind, operation.kind),
        eq(additionReceipts.operationId, operation.operationId),
      ),
    )
    .limit(1);
  if (receipt === undefined) return undefined;
  if (receipt.siteId !== operation.siteId || receipt.fingerprint !== operation.fingerprint) {
    throw new HTTPException(409, {
      message: "This addition ID was already used with different details. Start a new addition.",
    });
  }
  return resultSchema.parse(JSON.parse(receipt.resultJson));
}

export function additionReceiptStatement(
  database: BoozeDatabase,
  operation: AdditionOperation,
  result: unknown,
): Parameters<BoozeDatabase["batch"]>[0][number] {
  return database
    .insert(additionReceipts)
    .values({ ...operation, resultJson: JSON.stringify(result) });
}
