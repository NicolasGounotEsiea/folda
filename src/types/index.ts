export interface Tag {
  id: number;
  name: string;
  color: string;
  is_auto: boolean;
  context_id: number; // 0 = global, >0 = workspace-scoped association
}

export interface FileEntry {
  id: number;
  path: string;
  name: string;
  extension: string;
  size: number;
  created_at: number;
  modified_at: number;
  accessed_at: number;
  tags: Tag[];
}

export interface ActivityEntry {
  id: number;
  file_id: number | null;
  file_path: string;
  file_name: string;
  action: string;
  timestamp: number;
  app_name: string | null;
}

export interface Context {
  id: number;
  name: string;
  icon: string;
  watched_paths: string[];
  pinned_tag_ids: number[];
  is_active: boolean;
  last_path: string;
  open_tabs: string[];
  open_file_tabs: string[];
}

export interface PinnedItem {
  id: number;
  path: string;
  name: string;
  is_dir: boolean;
  context_id: number; // 0 = global, >0 = workspace-scoped
}

export interface TypeBreakdown {
  ext: string;
  count: number;
  size: number;
}

export interface FolderStats {
  total_size: number;
  file_count: number;
  dir_count: number;
  breakdown: TypeBreakdown[];
}

export interface ListEntry {
  is_dir: boolean;
  name: string;
  path: string;
  size: number;
  created_at: number;
  modified_at: number;
  extension: string;
  id: number | null;
  tags: Tag[];
  /// True when this directory is an encrypted-vault root (it holds a valid
  /// `.nxsvault`). Computed backend-side by `list_directory` — one cheap probe
  /// per folder — so the UI never has to round-trip per entry to ask.
  /// Drives the padlock icon and the "unlock instead of navigate" behaviour.
  is_vault?: boolean;
  /// Set by the Toolbar/CommandPalette when a file appears in search results
  /// because its INDEXED CONTENT matched the query (not just the filename).
  /// Undefined / false for regular list_directory results. Drives the small
  /// "contenu" badge that explains why a non-name-matching file is in the list.
  matched_content?: boolean;
  /// FTS5-generated excerpt of the matched content, with the matched terms
  /// wrapped in `<b>` / `</b>` markers. Only present when matched_content is
  /// true. The frontend renders the markers as React `<mark>` elements —
  /// never via dangerouslySetInnerHTML.
  match_snippet?: string;
}

/// Backend payload from `search_files`. Wraps a FileEntry-like row with origin
/// metadata so the UI can show why each result matched.
export interface SearchHit {
  id: number;
  path: string;
  name: string;
  extension: string;
  size: number;
  created_at: number;
  modified_at: number;
  accessed_at: number;
  tags: Tag[];
  matched_name: boolean;
  matched_content: boolean;
  snippet: string | null;
}

export interface TagRule {
  id: number;
  tag_id: number;
  context_id: number;
  rule_type: "ext" | "name_contains" | "name_starts" | "path_contains" | "size_gt" | "size_lt";
  rule_value: string;
}

export interface SavedView {
  id: number;
  name: string;
  icon: string;
  tag_ids: number[];
  context_id: number;
}

export interface TagStat {
  tag_id: number;
  count: number;
}

export type ViewMode = "explorer" | "timeline";
export type LayoutMode = "list" | "grid";
