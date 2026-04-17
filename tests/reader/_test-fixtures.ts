/**
 * Shared test fixtures for renderer tests.
 *
 * jsdom is missing several DOM APIs that real browsers ship:
 *   - File.text() and File.arrayBuffer() (used by renderer.load())
 *   - Element.scrollIntoView() (used by PDF/heading navigation)
 *
 * Centralizing the polyfills here keeps the per-renderer tests
 * focused on behavior rather than fixture plumbing.
 *
 * NOT a *.test.ts file -- it's only included via direct import, so
 * vitest won't try to run it as a test.
 */

// scrollIntoView lives on Element.prototype in real browsers but not
// in jsdom. Stub it once so renderers calling it from goTo() don't
// blow up. Idempotent: only installed if missing.
if (typeof Element !== "undefined" && !("scrollIntoView" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: function () {
      /* no-op stub for jsdom */
    },
  });
}

export function makeTextFile(
  name: string,
  content: string,
  type = "text/plain",
): File {
  const blob = new Blob([content], { type });
  const file = new File([blob], name, { type });
  patchFile(file, blob, content);
  return file;
}

export function makeBinaryFile(
  name: string,
  bytes: Uint8Array | number[],
  type = "application/octet-stream",
): File {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const blob = new Blob([data], { type });
  const file = new File([blob], name, { type });
  patchFile(file, blob, null);
  return file;
}

/**
 * Mounts a target div inside a scrollable host so DomRendererBase's
 * findScrollableAncestor() returns a real, scrollable element rather
 * than falling back to documentElement (which jsdom can't scroll).
 */
export function mountInScrollableHost(): HTMLElement {
  const host = document.createElement("div");
  host.style.cssText = "overflow-y:auto;height:200px;";
  const target = document.createElement("div");
  host.appendChild(target);
  document.body.appendChild(host);
  return target;
}

function patchFile(file: File, blob: Blob, textPayload: string | null): void {
  if (typeof file.arrayBuffer !== "function") {
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      writable: true,
      value: () =>
        new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as ArrayBuffer);
          reader.onerror = () => reject(reader.error);
          reader.readAsArrayBuffer(blob);
        }),
    });
  }
  if (typeof file.text !== "function") {
    Object.defineProperty(file, "text", {
      configurable: true,
      writable: true,
      value: () =>
        textPayload !== null
          ? Promise.resolve(textPayload)
          : new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = () => reject(reader.error);
              reader.readAsText(blob);
            }),
    });
  }
}

export function collectTocLabels(toc: Array<{ label: string; children?: any[] }>): string[] {
  const labels: string[] = [];
  for (const e of toc) {
    labels.push(e.label);
    if (e.children) labels.push(...collectTocLabels(e.children));
  }
  return labels;
}
