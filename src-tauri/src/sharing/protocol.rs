use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GuestMsg {
    Auth { password: String, display_name: String },
    ListDir { id: u64, path: String },
    ReadFile { id: u64, path: String },
    WriteFile { id: u64, path: String, content: String },
    DeletePath { id: u64, path: String },
    RenamePath { id: u64, from: String, to: String },
    CreateFile { id: u64, path: String },
    CreateDir { id: u64, path: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostMsg {
    AuthOk { name: String, icon: String, root_paths: Vec<String> },
    AuthErr { reason: String },
    Response { id: u64, ok: bool, payload: serde_json::Value },
    FsEvent { kind: String, path: String },
    ClientJoined { name: String },
    ClientLeft { name: String },
}
