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
  const budgetHandler = existsSync(budgetPath)
    ? ((await import(budgetPath)).default as BudgetHandler)
    : undefined;

  return { handler, budgetHandler };
}
