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
