import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type JsonReadResult =
  | { status: "ok"; value: unknown }
  | { status: "missing" }
  | { status: "unreadable"; error: Error };

export function readJsonFile(filePath: string): JsonReadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "unreadable", error: toError(error) };
  }
  try {
    return { status: "ok", value: JSON.parse(raw) as unknown };
  } catch (error) {
    return { status: "unreadable", error: toError(error) };
  }
}

export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomUUID()}`,
  );
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value), "utf8");
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
