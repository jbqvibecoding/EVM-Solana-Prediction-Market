//! On-chain verification of off-chain order signatures.
//!
//! Solana verifies ed25519 signatures via the native Ed25519 program included
//! as a separate instruction in the same transaction. Here we read that
//! instruction back through the Instructions sysvar (instruction introspection)
//! and assert that it proves the expected `maker` signed exactly the serialized
//! order bytes.
//!
//! We parse the Ed25519 instruction's offset header generically rather than
//! assuming fixed byte positions, and require the referenced public key and
//! message to live inside this same instruction (self-contained), which is how
//! `solana_program::ed25519_instruction::new_ed25519_instruction` lays it out.

use crate::ExchangeError;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::ed25519_program;
use anchor_lang::solana_program::sysvar::instructions::load_instruction_at_checked;

pub fn verify_ed25519_signature(
    ix_sysvar: &AccountInfo,
    ix_index: u8,
    expected_pubkey: &Pubkey,
    expected_message: &[u8],
) -> Result<()> {
    let ix = load_instruction_at_checked(ix_index as usize, ix_sysvar)
        .map_err(|_| error!(ExchangeError::SignatureMissing))?;

    require_keys_eq!(
        ix.program_id,
        ed25519_program::ID,
        ExchangeError::InvalidSignatureProgram
    );

    let data = &ix.data;
    // header: num_signatures(u8) + padding(u8) + one offsets struct (7 * u16).
    require!(data.len() >= 16, ExchangeError::MalformedSignatureIx);
    require!(data[0] >= 1, ExchangeError::MalformedSignatureIx);

    let read_u16 = |off: usize| u16::from_le_bytes([data[off], data[off + 1]]);
    let sig_ix_idx = read_u16(4);
    let pk_off = read_u16(6) as usize;
    let pk_ix_idx = read_u16(8);
    let msg_off = read_u16(10) as usize;
    let msg_size = read_u16(12) as usize;
    let msg_ix_idx = read_u16(14);

    // All data must be embedded in this same ed25519 instruction.
    let here = ix_index as u16;
    let is_self = |idx: u16| idx == u16::MAX || idx == here;
    require!(
        is_self(sig_ix_idx) && is_self(pk_ix_idx) && is_self(msg_ix_idx),
        ExchangeError::SignatureNotSelfContained
    );

    // Bounds-checked extraction.
    require!(
        pk_off.saturating_add(32) <= data.len(),
        ExchangeError::MalformedSignatureIx
    );
    require!(
        msg_off.saturating_add(msg_size) <= data.len(),
        ExchangeError::MalformedSignatureIx
    );

    require!(
        &data[pk_off..pk_off + 32] == expected_pubkey.as_ref(),
        ExchangeError::SignerMismatch
    );
    require!(
        &data[msg_off..msg_off + msg_size] == expected_message,
        ExchangeError::MessageMismatch
    );

    Ok(())
}
