import { mkdir, readFile, writeFile, stat, open } from "node:fs/promises"
import { createHash } from "node:crypto"
import { isAbsolute, join, resolve } from "node:path"
import { homedir } from "node:os"
import { parseImageInfo, type ImageInfo } from "./dimensions.js"

// ---------------------------------------------------------------------------
// Header-only dimension reading: reads the first 4KB of a file, enough for
// any image header (PNG needs 24 bytes, JPEG SOF can be up to ~64KB into
// the file but is usually in the first 4KB, WebP/GIF < 30 bytes).
// ---------------------------------------------------------------------------
const HEADER_READ_SIZE = 4096

export async function readImageDimensions(
  path: string,
): Promise<ImageInfo | null> {
  let fh
  try {
    fh = await open(path, "r")
    const buf = Buffer.alloc(HEADER_READ_SIZE)
    const { bytesRead } = await fh.read(buf, 0, HEADER_READ_SIZE, 0)
    return parseImageInfo(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead))
  } catch {
    return null
  } finally {
    await fh?.close()
  }
}

// ---------------------------------------------------------------------------
// In-flight deduplication: concurrent requests for the same URL share a
// single promise instead of doing redundant file reads / network fetches.
// ---------------------------------------------------------------------------
const inflight = new Map<string, Promise<FetchedImage | FetchError>>()

export type FetchOptions = {
  allowNetwork: boolean
  networkSizeLimit: number // bytes
  networkTimeoutMs: number
  cacheDir: string
  // Directory used to resolve relative path references. Falls back to
  // process.cwd() when undefined.
  baseDir?: string
}

export type FetchedImage = {
  bytes: Uint8Array
  info: ImageInfo | null
  source: "file" | "http" | "cache"
  url: string
}

export type FetchError = {
  error: string
  url: string
}

export const DEFAULT_FETCH_OPTIONS: FetchOptions = {
  allowNetwork: true,
  networkSizeLimit: 10 * 1024 * 1024,
  networkTimeoutMs: 5000,
  cacheDir: join(homedir(), ".cache", "opencode-images"),
}

export function isImageUrl(s: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp)(\?.*)?$/i.test(s)
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 32)
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export function fetchImage(
  url: string,
  opts: FetchOptions = DEFAULT_FETCH_OPTIONS,
): Promise<FetchedImage | FetchError> {
  const existing = inflight.get(url)
  if (existing) return existing
  const p = _fetchImage(url, opts).finally(() => inflight.delete(url))
  inflight.set(url, p)
  return p
}

async function _fetchImage(
  url: string,
  opts: FetchOptions,
): Promise<FetchedImage | FetchError> {
  // Normalize: strip file:// prefix; treat anything that isn't http(s) as a path.
  let path: string | null = null
  if (url.startsWith("file://")) path = decodeURIComponent(url.slice("file://".length))
  else if (!/^https?:\/\//i.test(url)) path = url

  if (path) {
    // Resolve relative paths against baseDir (or cwd as a fallback).
    if (!isAbsolute(path)) {
      const base = opts.baseDir ?? process.cwd()
      path = resolve(base, path)
    }
    try {
      const bytes = await readFile(path)
      const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      return { bytes: u8, info: parseImageInfo(u8), source: "file", url }
    } catch (e) {
      return { error: `read ${path}: ${(e as Error).message}`, url }
    }
  }

  if (!opts.allowNetwork) {
    return { error: "network disabled", url }
  }

  const cachePath = join(opts.cacheDir, hash(url) + extensionFromUrl(url))
  if (await fileExists(cachePath)) {
    try {
      const bytes = await readFile(cachePath)
      const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      return { bytes: u8, info: parseImageInfo(u8), source: "cache", url }
    } catch {
      // fall through to refetch
    }
  }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), opts.networkTimeoutMs)
  try {
    const res = await fetch(url, { signal: ac.signal })
    clearTimeout(timer)
    if (!res.ok) return { error: `HTTP ${res.status}`, url }
    const lenHeader = res.headers.get("content-length")
    if (lenHeader && parseInt(lenHeader, 10) > opts.networkSizeLimit) {
      return { error: `size ${lenHeader} > limit`, url }
    }
    const buf = await res.arrayBuffer()
    if (buf.byteLength > opts.networkSizeLimit) {
      return { error: `size ${buf.byteLength} > limit`, url }
    }
    const u8 = new Uint8Array(buf)
    try {
      await mkdir(opts.cacheDir, { recursive: true })
      await writeFile(cachePath, u8)
    } catch {
      // cache failure is non-fatal
    }
    return { bytes: u8, info: parseImageInfo(u8), source: "http", url }
  } catch (e) {
    clearTimeout(timer)
    return { error: `fetch: ${(e as Error).message}`, url }
  }
}

function extensionFromUrl(url: string): string {
  const m = url.match(/\.(png|jpe?g|gif|webp|bmp)(?:\?|$)/i)
  return m ? "." + m[1].toLowerCase() : ""
}
