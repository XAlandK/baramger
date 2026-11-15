// The two Node functions the assistant's tests use to read the mission package from disk.
// (The app has no @types/node; this keeps it that way.)
declare module "node:fs/promises" {
  export function readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function appendFile(path: string, data: string): Promise<void>;
}
declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
