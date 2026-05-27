export function humanizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);

  // Windows OS error codes embedded in Rust error strings
  if (/os error 5|access is denied/i.test(raw)) return "Permission denied";
  if (/os error 32|used by another process/i.test(raw)) return "File is in use by another application";
  if (/os error 2|cannot find the file|no such file/i.test(raw)) return "File not found";
  if (/os error 3|path not found/i.test(raw)) return "Path not found";
  if (/os error 112|disk.*full|not enough space/i.test(raw)) return "Disk is full";
  if (/os error 183|already exists/i.test(raw)) return "A file with that name already exists";
  if (/os error 17|not same device/i.test(raw)) return "Cannot move between drives";
  if (/os error 87|invalid parameter/i.test(raw)) return "Invalid file name";

  // Truncate long raw messages
  return raw.length > 120 ? raw.slice(0, 120) + "…" : raw;
}
