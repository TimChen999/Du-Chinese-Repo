declare module "*.css?inline" {
  const css: string;
  export default css;
}

// Vite ?url suffix returns the resolved asset URL as a string. Used
// by the PDF renderer to bootstrap pdf.js's worker without hard-
// coding a path that would break across dev/build modes.
declare module "*?url" {
  const url: string;
  export default url;
}

// ─── File System Access API ─────────────────────────────────────────
// These APIs are available in Chromium browsers but not yet in the
// standard DOM lib typings.

interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface OpenFilePickerOptions {
  types?: FilePickerAcceptType[];
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
}

interface FileSystemHandlePermissionDescriptor {
  mode?: "read" | "readwrite";
}

interface FileSystemFileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
  requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface FileSystemDirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
}

type FileSystemHandle = FileSystemFileHandle | FileSystemDirectoryHandle;

interface Window {
  showOpenFilePicker(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
}

interface DataTransferItem {
  getAsFileSystemHandle?(): Promise<FileSystemHandle>;
}
