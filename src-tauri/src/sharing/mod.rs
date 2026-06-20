pub mod client;
pub mod crypto;
pub mod frame;
pub mod network;
pub mod protocol;
pub mod server;

use client::GuestHandle;
use server::HostHandle;

pub enum SharingState {
    Idle,
    Hosting {
        session_code: String,
        password: String,
        handle: HostHandle,
    },
    Joined {
        host_addr: String,
        handle: GuestHandle,
        next_id: u64,
    },
}

impl SharingState {
    pub fn is_idle(&self) -> bool {
        matches!(self, SharingState::Idle)
    }
}
