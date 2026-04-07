import * as readline from "readline";
import { maskAddress } from "./output";

export function prompt(
  rl: readline.Interface,
  question: string
): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

export function printTable(rows: [string, string | null][]): void {
  const normalized = rows.map(([label, value]): [string, string] => [label, value ?? "N/A"]);
  const col1 = Math.max(...normalized.map(([label]) => label.length));
  const col2 = Math.max(...normalized.map(([, value]) => value.length));
  const line = `+${"-".repeat(col1 + 2)}+${"-".repeat(col2 + 2)}+`;
  console.log(line);
  for (const [label, value] of normalized) {
    console.log(`| ${label.padEnd(col1)} | ${value.padEnd(col2)} |`);
  }
  console.log(line);
}

export function selectOption<T>(
  title: string,
  items: T[],
  getLabel: (item: T) => string
): Promise<T> {
  return new Promise((resolve) => {
    let selectedIndex = 0;

    const renderMenu = (firstRender: boolean) => {
      if (!firstRender) {
        process.stdout.write(`\x1B[${items.length}A`);
      }
      for (let i = 0; i < items.length; i++) {
        process.stdout.write(`\x1B[2K`);
        if (i === selectedIndex) {
          process.stdout.write(`\x1B[32m> ${getLabel(items[i])}\x1B[0m\n`);
        } else {
          process.stdout.write(`  ${getLabel(items[i])}\n`);
        }
      }
    };

    console.log(title);
    process.stdout.write(`\x1B[?25l`); // hide cursor
    renderMenu(true);

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const onData = (key: string) => {
      if (key === "\x1B[A") {
        if (selectedIndex > 0) {
          selectedIndex--;
          renderMenu(false);
        }
      } else if (key === "\x1B[B") {
        if (selectedIndex < items.length - 1) {
          selectedIndex++;
          renderMenu(false);
        }
      } else if (key === "\r" || key === "\n") {
        process.stdin.removeListener("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write(`\x1B[?25h`); // show cursor
        resolve(items[selectedIndex]);
      } else if (key === "\x03") {
        process.stdout.write(`\x1B[?25h`);
        process.exit(0);
      }
    };

    process.stdin.on("data", onData);
  });
}

export function selectFromList<
  T extends { name: string; walletAddress: string }
>(title: string, items: T[]): Promise<T> {
  return new Promise((resolve) => {
    let selectedIndex = 0;

    const renderMenu = (firstRender: boolean) => {
      if (!firstRender) {
        process.stdout.write(`\x1B[${items.length}A`);
      }
      for (let i = 0; i < items.length; i++) {
        process.stdout.write(`\x1B[2K`);
        if (i === selectedIndex) {
          process.stdout.write(
            `\x1B[32m> ${items[i].name} ${maskAddress(
              items[i].walletAddress
            )}\x1B[0m\n`
          );
        } else {
          process.stdout.write(
            `  ${items[i].name} ${maskAddress(items[i].walletAddress)}\n`
          );
        }
      }
    };

    console.log(title);
    process.stdout.write(`\x1B[?25l`); // hide cursor
    renderMenu(true);

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const onData = (key: string) => {
      if (key === "\x1B[A") {
        if (selectedIndex > 0) {
          selectedIndex--;
          renderMenu(false);
        }
      } else if (key === "\x1B[B") {
        if (selectedIndex < items.length - 1) {
          selectedIndex++;
          renderMenu(false);
        }
      } else if (key === "\r" || key === "\n") {
        process.stdin.removeListener("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write(`\x1B[?25h`); // show cursor
        resolve(items[selectedIndex]);
      } else if (key === "\x03") {
        process.stdout.write(`\x1B[?25h`);
        process.exit(0);
      }
    };

    process.stdin.on("data", onData);
  });
}
