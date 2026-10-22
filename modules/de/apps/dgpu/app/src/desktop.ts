export const OFFLOAD_ENV = [
  "__NV_PRIME_RENDER_OFFLOAD=1",
  "__GLX_VENDOR_LIBRARY_NAME=nvidia",
  "__VK_LAYER_NV_optimus=NVIDIA_only",
] as const;

export const MARKER_KEY = "X-Caelestia-DGPU-Source";
export const WRAPPER_SUFFIX = " (dGPU)";
export const DESKTOP_EXT = ".desktop";
export const MAIN_GROUP = "[Desktop Entry]";
export const DGPU = "dGPU";

const KEY_VALUE = /^([A-Za-z0-9-]+)=(.*)$/;

export interface DesktopGroupEntry {
  readonly group: string;
  readonly key: string;
  readonly value: string;
}

const splitLines = (contents: string): Array<string> => {
  if (contents === "") {
    return [];
  }
  const lines = contents.split(/\r?\n/);
  if (/(\r?\n)$/.test(contents)) {
    lines.pop();
  }
  return lines;
};

/**
 * Parses `(group, key, value)` tuples in file order. Group headers and
 * comments are not returned.
 */
export const desktopGroups = (contents: string): ReadonlyArray<DesktopGroupEntry> => {
  const entries: Array<DesktopGroupEntry> = [];
  let group: string | null = null;
  for (const line of splitLines(contents)) {
    if (line.startsWith("[")) {
      group = line;
      continue;
    }
    const match = KEY_VALUE.exec(line);
    if (match !== null && group !== null) {
      entries.push({
        group,
        key: match[1] ?? "",
        value: match[2] ?? "",
      });
    }
  }
  return entries;
};

export const wrapperFilename = (entryId: string): string => {
  const stem = entryId.endsWith(DESKTOP_EXT)
    ? entryId.slice(0, -DESKTOP_EXT.length)
    : entryId;
  return `${stem}${WRAPPER_SUFFIX}${DESKTOP_EXT}`;
};

const addOffload = (value: string): string => {
  const prefix = `env ${OFFLOAD_ENV.join(" ")} `;
  return value.startsWith("env ")
    ? `env ${OFFLOAD_ENV.join(" ")} ${value.slice(4)}`
    : `${prefix}${value}`;
};

/**
 * Builds a wrapper entry while leaving action groups untouched. The marker is
 * inserted directly under `[Desktop Entry]` so stale wrappers can be detected
 * without trusting the filename alone.
 */
export const buildWrapper = (source: string, entryId: string): string => {
  const out: Array<string> = [];
  let group: string | null = null;
  let markerWritten = false;

  for (const line of splitLines(source)) {
    if (line.startsWith("[")) {
      group = line;
      out.push(line);
      if (group === MAIN_GROUP && !markerWritten) {
        out.push(`${MARKER_KEY}=${entryId}`);
        markerWritten = true;
      }
      continue;
    }

    const match = KEY_VALUE.exec(line);
    if (match === null || group !== MAIN_GROUP) {
      out.push(line);
      continue;
    }

    const key = match[1] ?? "";
    let value = match[2] ?? "";
    if (key === "Name") {
      if (!value.endsWith(WRAPPER_SUFFIX)) {
        value = `${value}${WRAPPER_SUFFIX}`;
      }
      out.push(`Name=${value}`);
    } else if (key === "Exec") {
      out.push(`Exec=${addOffload(value)}`);
    } else if (key === MARKER_KEY) {
      continue;
    } else {
      out.push(line);
    }
  }

  if (!markerWritten) {
    out.push(`${MARKER_KEY}=${entryId}`);
  }
  return `${out.join("\n")}\n`;
};

export const wrapperSourceId = (contents: string): string | undefined => {
  for (const entry of desktopGroups(contents)) {
    if (entry.group === MAIN_GROUP && entry.key === MARKER_KEY) {
      return entry.value;
    }
  }
  return undefined;
};
