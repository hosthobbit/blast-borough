// Headless Chromium for automated checks: software rendering only (never the real GPU) and muted.
import { chromium } from "playwright-core";

export async function launch() {
  const env = { ...process.env };
  delete env.WAYLAND_DISPLAY;
  delete env.DISPLAY;
  env.__EGL_VENDOR_LIBRARY_FILENAMES = "/usr/share/glvnd/egl_vendor.d/50_mesa.json";
  env.__GLX_VENDOR_LIBRARY_NAME = "mesa";
  return chromium.launch({
    executablePath: process.env.CHROME || "/usr/bin/chromium",
    headless: true,
    env,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--disable-vulkan", "--mute-audio", "--autoplay-policy=no-user-gesture-required"],
  });
}

/** Collect console errors and page crashes for a page. */
export function watchConsole(page, label) {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(`[${label}] ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  return errors;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
