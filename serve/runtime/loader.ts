import { existsSync } from "fs";
import { resolve } from "path";
import type { BudgetHandler, Handler } from "../types";

export interface LoadedHandlers {
  handler: Handler;
  budgetHandler?: BudgetHandler;
}

export async function loadHandlers(dir: string): Promise<LoadedHandlers> {
  const handlerPath = resolve(dir, "handler.ts");
  if (!existsSync(handlerPath)) {
    throw new Error(`handler.ts not found in ${dir}. This file is required.`);
  }

  const handlerModule = await import(handlerPath);
  const handler = handlerModule.default as Handler;
  if (typeof handler !== "function") {
    throw new Error(`handler.ts must export a default handler function.`);
  }

  const budgetPath = resolve(dir, "budget.ts");
  let budgetHandler: BudgetHandler | undefined;
  if (existsSync(budgetPath)) {
    const budgetModule = await import(budgetPath);
    budgetHandler = budgetModule.default as BudgetHandler;
    if (typeof budgetHandler !== "function") {
      throw new Error(
        `budget.ts must export a default budget handler function.`,
      );
    }
  }

  return { handler, budgetHandler };
}
