/**
 * Runtime Loader
 *
 * Loads the developer's handler and optional budget handler.
 *
 *   handler.ts    — REQUIRED: do the work, return deliverable
 *   budget.ts     — OPTIONAL: dynamic pricing + fund requests (ACP native only)
 */

import { resolve } from "path";
import { existsSync } from "fs";
import type { Handler, BudgetHandler } from "../types";

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
  const handler: Handler = handlerModule.default;

  let budgetHandler: BudgetHandler | undefined;
  const budgetPath = resolve(dir, "budget.ts");
  if (existsSync(budgetPath)) {
    const budgetModule = await import(budgetPath);
    budgetHandler = budgetModule.default;
  }

  return { handler, budgetHandler };
}
