// Test helper: the Worker reads package files through its assets binding; in tests they come from disk.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PackageStore } from "../worker/tools";

export const DATA = fileURLToPath(new URL("../../data/package/", import.meta.url));

/** A fetch-like reader of the built site's files ("package/…" → data/package/…). */
export async function diskAsset(path: string): Promise<Response> {
  try {
    return new Response(await readFile(DATA + path.replace(/^\/?package\//, "")));
  } catch {
    return new Response("not found", { status: 404 });
  }
}

export function diskStore(): PackageStore {
  return new PackageStore(diskAsset);
}
