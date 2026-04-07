import pc from "picocolors";

export const c = {
  bold: pc.bold,
  dim: pc.dim,
  green: pc.green,
  yellow: pc.yellow,
  red: pc.red,
  cyan: pc.cyan,
  magenta: pc.magenta,
  status: (status: string) => {
    switch (status) {
      case "completed":
        return pc.green(status);
      case "rejected":
      case "expired":
        return pc.red(status);
      case "funded":
      case "submitted":
        return pc.yellow(status);
      case "open":
      case "budget_set":
        return pc.cyan(status);
      default:
        return status;
    }
  },
};
