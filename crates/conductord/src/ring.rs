//! Ring buffer bajtów z absolutnymi offsetami.
//!
//! Każdy bajt wyjścia agenta ma stały, absolutny offset (licząc od startu przebiegu).
//! Bufor trzyma ostatnie `capacity` bajtów; starsze wypadają. Klient czyta od
//! offsetu `since` i dostaje `next_offset`, więc wiele klientów (CLI, UI) może
//! niezależnie śledzić to samo wyjście, a utrata danych jest jawna (`dropped`).

use std::collections::VecDeque;

#[derive(Debug)]
pub struct RingBuffer {
    buf: VecDeque<u8>,
    capacity: usize,
    /// Absolutny offset pierwszego bajtu w `buf`.
    start: u64,
}

/// Wynik odczytu.
#[derive(Debug, PartialEq, Eq)]
pub struct Chunk {
    pub data: Vec<u8>,
    /// Absolutny offset pierwszego bajtu w `data`.
    pub offset: u64,
    /// Offset do następnego odczytu.
    pub next_offset: u64,
    /// Ile bajtów między `since` a `offset` zostało utraconych.
    pub dropped: u64,
}

impl RingBuffer {
    pub fn new(capacity: usize) -> Self {
        assert!(capacity > 0, "ring buffer capacity must be > 0");
        RingBuffer {
            buf: VecDeque::with_capacity(capacity.min(64 * 1024)),
            capacity,
            start: 0,
        }
    }

    /// Absolutny offset końca (liczba wszystkich bajtów kiedykolwiek zapisanych).
    pub fn end(&self) -> u64 {
        self.start + self.buf.len() as u64
    }

    /// Najstarszy dostępny offset.
    #[cfg(test)]
    pub fn start(&self) -> u64 {
        self.start
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.buf.len()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    pub fn push(&mut self, data: &[u8]) {
        // Jeśli sam zapis jest większy niż pojemność, zostaje tylko jego ogon.
        let skip = data.len().saturating_sub(self.capacity);
        if skip > 0 {
            self.start += (self.buf.len() + skip) as u64;
            self.buf.clear();
        }
        let data = &data[skip..];
        let overflow = (self.buf.len() + data.len()).saturating_sub(self.capacity);
        if overflow > 0 {
            self.buf.drain(..overflow);
            self.start += overflow as u64;
        }
        self.buf.extend(data);
    }

    /// Czyta najwyżej `max` bajtów od absolutnego offsetu `since`.
    /// `since` większe niż koniec jest przycinane do końca (pusty wynik).
    pub fn read_from(&self, since: u64, max: usize) -> Chunk {
        let end = self.end();
        let from = since.clamp(self.start, end);
        let dropped = from - since.min(from);
        let rel = (from - self.start) as usize;
        let n = (self.buf.len() - rel).min(max);
        let data: Vec<u8> = self.buf.range(rel..rel + n).copied().collect();
        Chunk {
            offset: from,
            next_offset: from + n as u64,
            dropped,
            data,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_read() {
        let mut r = RingBuffer::new(16);
        assert!(r.is_empty());
        r.push(b"hello ");
        r.push(b"world");
        assert_eq!(r.end(), 11);
        let c = r.read_from(0, 100);
        assert_eq!(c.data, b"hello world");
        assert_eq!((c.offset, c.next_offset, c.dropped), (0, 11, 0));
        let c = r.read_from(6, 3);
        assert_eq!(c.data, b"wor");
        assert_eq!(c.next_offset, 9);
        let c = r.read_from(11, 100);
        assert!(c.data.is_empty());
        assert_eq!(c.next_offset, 11);
    }

    #[test]
    fn overflow_keeps_absolute_offsets() {
        let mut r = RingBuffer::new(8);
        r.push(b"0123456789"); // większe niż pojemność
        assert_eq!((r.start(), r.end(), r.len()), (2, 10, 8));
        r.push(b"ab");
        assert_eq!((r.start(), r.end()), (4, 12));
        let c = r.read_from(0, 100);
        assert_eq!(c.data, b"456789ab");
        assert_eq!((c.offset, c.next_offset, c.dropped), (4, 12, 4));
        let c = r.read_from(9, 100);
        assert_eq!(c.data, b"9ab");
        assert_eq!(c.dropped, 0);
    }

    #[test]
    fn since_past_end_is_clamped() {
        let mut r = RingBuffer::new(4);
        r.push(b"abc");
        let c = r.read_from(100, 10);
        assert!(c.data.is_empty());
        assert_eq!((c.offset, c.next_offset, c.dropped), (3, 3, 0));
    }

    #[test]
    fn many_small_pushes() {
        let mut r = RingBuffer::new(5);
        for i in 0..100u8 {
            r.push(&[i]);
        }
        assert_eq!(r.end(), 100);
        assert_eq!(r.read_from(0, 10).data, vec![95, 96, 97, 98, 99]);
        // Śledzenie przyrostowe od zapamiętanego offsetu.
        let mut since = 97;
        let c = r.read_from(since, 1);
        assert_eq!(c.data, vec![97]);
        since = c.next_offset;
        assert_eq!(r.read_from(since, 10).data, vec![98, 99]);
    }
}
