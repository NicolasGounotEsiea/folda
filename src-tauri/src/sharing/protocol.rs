use serde::{Deserialize, Serialize};

// Auth no longer carries a `password` field — authentication is now proven
// by completing the Noise NNpsk0 handshake (see crypto.rs). The password is
// derived into a 32-byte PSK and mixed into the handshake's symmetric key
// schedule, so an attacker who doesn't know the password cannot construct
// any valid Noise message and the handshake fails before this struct is even
// parsed. `Auth` is the first *encrypted* application message — it just
// announces who the guest is.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GuestMsg {
    Auth { display_name: String },
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
    Response { id: u64, ok: bool, payload: serde_json::Value },
    FsEvent { kind: String, path: String },
    ClientJoined { name: String },
    ClientLeft { name: String },
}
