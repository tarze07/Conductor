//! Base64 (RFC 4648, alfabet standardowy, z dopełnieniem `=`).
//!
//! Wyjście terminala to surowe bajty (ADR-001), więc w JSON przesyłamy je jako base64.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        let idx = |shift: u32| char::from(ALPHABET[((n >> shift) & 0x3f) as usize]);
        out.push(idx(18));
        out.push(idx(12));
        out.push(if chunk.len() > 1 { idx(6) } else { '=' });
        out.push(if chunk.len() > 2 { idx(0) } else { '=' });
    }
    out
}

fn decode_char(c: u8) -> Option<u32> {
    let v = match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => return None,
    };
    Some(u32::from(v))
}

/// Ścisłe dekodowanie: długość podzielna przez 4, dopełnienie tylko na końcu,
/// brak białych znaków i znaków spoza alfabetu.
pub fn decode(s: &str) -> Result<Vec<u8>, &'static str> {
    let b = s.as_bytes();
    if !b.len().is_multiple_of(4) {
        return Err("base64 length must be a multiple of 4");
    }
    let mut out = Vec::with_capacity(b.len() / 4 * 3);
    let quads = b.len() / 4;
    for (qi, q) in b.chunks(4).enumerate() {
        let last = qi + 1 == quads;
        let pad = q.iter().rev().take_while(|&&c| c == b'=').count();
        if pad > 2 || (pad > 0 && !last) {
            return Err("invalid base64 padding");
        }
        let mut n = 0u32;
        for &c in &q[..4 - pad] {
            n = (n << 6) | decode_char(c).ok_or("invalid base64 character")?;
        }
        n <<= 6 * pad as u32;
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc4648_vectors() {
        let cases = [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ];
        for (plain, enc) in cases {
            assert_eq!(encode(plain.as_bytes()), enc);
            assert_eq!(decode(enc).unwrap(), plain.as_bytes());
        }
    }

    #[test]
    fn binary_roundtrip() {
        let data: Vec<u8> = (0..=255u8).chain((0..=255u8).rev()).collect();
        for len in 0..data.len() {
            assert_eq!(decode(&encode(&data[..len])).unwrap(), &data[..len]);
        }
    }

    #[test]
    fn rejects_invalid() {
        for s in ["Zg=", "Z===", "Zg==Zg==", "Zm9v!A==", "Zm 9v", "===="] {
            assert!(decode(s).is_err(), "{s:?}");
        }
    }
}
