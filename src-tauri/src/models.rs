use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ListEntry {
    pub is_dir: bool,
    pub name: String,
    pub path: String,
    pub size: i64,
    pub modified_at: i64,
    pub extension: String,
    pub id: Option<i64>,
    pub tags: Vec<Tag>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub is_auto: bool,
    pub context_id: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub extension: String,
    pub size: i64,
    pub created_at: i64,
    pub modified_at: i64,
    pub accessed_at: i64,
    pub tags: Vec<Tag>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ActivityEntry {
    pub id: i64,
    pub file_id: Option<i64>,
    pub file_path: String,
    pub file_name: String,
    pub action: String,
    pub timestamp: i64,
    pub app_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Context {
    pub id: i64,
    pub name: String,
    pub icon: String,
    pub watched_paths: Vec<String>,
    pub pinned_tag_ids: Vec<i64>,
    pub is_active: bool,
    pub last_path: String,
    pub open_tabs: Vec<String>,
    pub open_file_tabs: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PinnedItem {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub context_id: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TypeBreakdown {
    pub ext: String,
    pub count: i64,
    pub size: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FolderStats {
    pub total_size: i64,
    pub file_count: i64,
    pub dir_count: i64,
    pub breakdown: Vec<TypeBreakdown>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TagRule {
    pub id: i64,
    pub tag_id: i64,
    pub context_id: i64,
    pub rule_type: String,  // "ext" | "name_contains" | "name_starts" | "path_contains" | "size_gt" | "size_lt"
    pub rule_value: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SavedView {
    pub id: i64,
    pub name: String,
    pub icon: String,
    pub tag_ids: Vec<i64>,
    pub context_id: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TagStat {
    pub tag_id: i64,
    pub count: i64,
}
