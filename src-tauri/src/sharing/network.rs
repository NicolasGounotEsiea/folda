use std::net::{IpAddr, UdpSocket};
use std::time::Duration;

/// Returns the best external IP we can discover: tries STUN first, falls back to
/// the local outbound interface address (good enough for LAN use).
pub fn discover_public_ip() -> String {
    stun_lookup()
        .or_else(local_outbound_ip)
        .map(|ip| ip.to_string())
        .unwrap_or_else(|| "127.0.0.1".to_string())
}

fn stun_lookup() -> Option<IpAddr> {
    use std::net::ToSocketAddrs;

    // Resolve stun.l.google.com — blocks, called from spawn_blocking
    let server_addr = "stun.l.google.com:19302"
        .to_socket_addrs()
        .ok()?
        .next()?;

    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.set_read_timeout(Some(Duration::from_secs(3))).ok()?;

    // RFC 5389 STUN Binding Request (20-byte header, no attributes)
    let mut req = [0u8; 20];
    req[0..2].copy_from_slice(&0x0001u16.to_be_bytes()); // Binding Request
    // length = 0
    req[4..8].copy_from_slice(&0x2112A442u32.to_be_bytes()); // magic cookie
    for i in 0..12 {
        req[8 + i] = (i as u8).wrapping_mul(37); // transaction ID
    }

    sock.send_to(&req, server_addr).ok()?;

    let mut buf = [0u8; 512];
    let (n, _) = sock.recv_from(&mut buf).ok()?;
    if n < 20 {
        return None;
    }

    // Walk attributes looking for XOR-MAPPED-ADDRESS (0x0020)
    let mut pos = 20usize;
    while pos + 4 <= n {
        let attr_type = u16::from_be_bytes([buf[pos], buf[pos + 1]]);
        let attr_len = u16::from_be_bytes([buf[pos + 2], buf[pos + 3]]) as usize;
        pos += 4;

        if pos + attr_len > n {
            break;
        }

        if attr_type == 0x0020 && attr_len >= 8 && buf[pos + 1] == 0x01 {
            // IPv4: 4 bytes XOR'd with magic cookie
            let raw = u32::from_be_bytes([buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]]);
            let ip_int = raw ^ 0x2112A442u32;
            return Some(IpAddr::V4(std::net::Ipv4Addr::from(ip_int)));
        }

        // attributes are padded to 4-byte boundaries
        pos += attr_len + (4 - attr_len % 4) % 4;
    }

    None
}

fn local_outbound_ip() -> Option<IpAddr> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    Some(sock.local_addr().ok()?.ip())
}
