//! sidekick_pay: per-session USDC escrow that pays LAN-party helpers for verified compute.
//!
//! Spec section 11. Flow:
//!   initialize_config (admin) -> open_session (treasury funds a vault) ->
//!   register_helper (settler) -> settle* (settler pays helpers from the vault) ->
//!   close_session (settler refunds the remainder to the treasury).
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("GDJD4wtm4dU3Zg9gzW2HyTziwswq84yqjCWceLPQEKqs");

pub const CONFIG_SEED: &[u8] = b"config";
pub const SESSION_SEED: &[u8] = b"session";
pub const HELPER_SEED: &[u8] = b"helper";

#[program]
pub mod sidekick_pay {
    use super::*;

    /// Creates the global Config. `settler` is the server key allowed to settle and close.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        unit_price: u64,
        job_weights: [u16; 4],
        settler: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.settler = settler;
        config.usdc_mint = ctx.accounts.usdc_mint.key();
        config.unit_price = unit_price;
        config.job_weights = job_weights;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Treasury opens a session and escrows `budget` USDC into the session vault.
    pub fn open_session(ctx: Context<OpenSession>, session_id: u64, budget: u64) -> Result<()> {
        let session = &mut ctx.accounts.session;
        session.treasury = ctx.accounts.treasury.key();
        session.session_id = session_id;
        session.budget = budget;
        session.spent = 0;
        session.units_paid = 0;
        session.open = true;
        session.bump = ctx.bumps.session;

        if budget > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.treasury_ata.to_account_info(),
                        to: ctx.accounts.vault.to_account_info(),
                        authority: ctx.accounts.treasury.to_account_info(),
                    },
                ),
                budget,
            )?;
        }

        emit!(SessionOpened {
            session: session.key(),
            treasury: session.treasury,
            budget,
        });
        Ok(())
    }

    /// Settler creates the per-helper stats account (settler pays rent).
    pub fn register_helper(ctx: Context<RegisterHelper>, helper_wallet: Pubkey) -> Result<()> {
        let stats = &mut ctx.accounts.helper_stats;
        stats.wallet = helper_wallet;
        stats.total_units = 0;
        stats.total_earned = 0;
        stats.settlements = 0;
        stats.bump = ctx.bumps.helper_stats;
        Ok(())
    }

    /// Settler pays `units * unit_price` USDC from the session vault to the helper ATA.
    pub fn settle(
        ctx: Context<Settle>,
        session_id: u64,
        units: u64,
        receipts_root: [u8; 32],
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        let session = &ctx.accounts.session;
        require!(session.open, SidekickError::SessionClosed);
        require!(units > 0, SidekickError::ZeroUnits);
        let amount = units
            .checked_mul(config.unit_price)
            .ok_or(SidekickError::Overflow)?;
        let new_spent = session
            .spent
            .checked_add(amount)
            .ok_or(SidekickError::Overflow)?;
        require!(new_spent <= session.budget, SidekickError::OverBudget);

        let treasury_key = session.treasury;
        let id_bytes = session_id.to_le_bytes();
        let bump = [session.bump];
        let seeds: &[&[u8]] = &[SESSION_SEED, treasury_key.as_ref(), &id_bytes, &bump];
        let signer: &[&[&[u8]]] = &[seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.helper_ata.to_account_info(),
                    authority: ctx.accounts.session.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;

        let session = &mut ctx.accounts.session;
        session.spent = new_spent;
        session.units_paid = session
            .units_paid
            .checked_add(units)
            .ok_or(SidekickError::Overflow)?;

        let stats = &mut ctx.accounts.helper_stats;
        stats.total_units = stats
            .total_units
            .checked_add(units)
            .ok_or(SidekickError::Overflow)?;
        stats.total_earned = stats
            .total_earned
            .checked_add(amount)
            .ok_or(SidekickError::Overflow)?;
        stats.settlements = stats.settlements.saturating_add(1);

        emit!(JobsSettled {
            session: session.key(),
            helper: stats.wallet,
            units,
            amount,
            receipts_root,
            total_units: stats.total_units,
            total_earned: stats.total_earned,
        });
        Ok(())
    }

    /// Settler closes the session and refunds the vault balance to the treasury ATA.
    pub fn close_session(ctx: Context<CloseSession>, session_id: u64) -> Result<()> {
        require!(ctx.accounts.session.open, SidekickError::SessionClosed);
        let refunded = ctx.accounts.vault.amount;
        let treasury_key = ctx.accounts.session.treasury;
        let id_bytes = session_id.to_le_bytes();
        let bump = [ctx.accounts.session.bump];
        let seeds: &[&[u8]] = &[SESSION_SEED, treasury_key.as_ref(), &id_bytes, &bump];
        let signer: &[&[&[u8]]] = &[seeds];

        if refunded > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.treasury_ata.to_account_info(),
                        authority: ctx.accounts.session.to_account_info(),
                    },
                    signer,
                ),
                refunded,
            )?;
        }

        let session = &mut ctx.accounts.session;
        session.open = false;
        emit!(SessionClosed {
            session: session.key(),
            refunded,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------- accounts

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub settler: Pubkey,
    pub usdc_mint: Pubkey,
    /// Base units of USDC per work unit (1_000 = 0.001 USDC).
    pub unit_price: u64,
    /// dialogue, areagen, pathfind, simtick.
    pub job_weights: [u16; 4],
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Session {
    pub treasury: Pubkey,
    pub session_id: u64,
    pub budget: u64,
    pub spent: u64,
    pub units_paid: u64,
    pub open: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct HelperStats {
    pub wallet: Pubkey,
    pub total_units: u64,
    pub total_earned: u64,
    pub settlements: u32,
    pub bump: u8,
}

// ---------------------------------------------------------------- contexts

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    pub usdc_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(session_id: u64)]
pub struct OpenSession<'info> {
    #[account(mut)]
    pub treasury: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = treasury,
        space = 8 + Session::INIT_SPACE,
        seeds = [SESSION_SEED, treasury.key().as_ref(), &session_id.to_le_bytes()],
        bump
    )]
    pub session: Account<'info, Session>,
    #[account(address = config.usdc_mint @ SidekickError::WrongMint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = treasury
    )]
    pub treasury_ata: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = treasury,
        associated_token::mint = usdc_mint,
        associated_token::authority = session
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(helper_wallet: Pubkey)]
pub struct RegisterHelper<'info> {
    #[account(mut, address = config.settler @ SidekickError::NotSettler)]
    pub settler: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = settler,
        space = 8 + HelperStats::INIT_SPACE,
        seeds = [HELPER_SEED, helper_wallet.as_ref()],
        bump
    )]
    pub helper_stats: Account<'info, HelperStats>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(session_id: u64)]
pub struct Settle<'info> {
    #[account(address = config.settler @ SidekickError::NotSettler)]
    pub settler: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: only used as a PDA seed; must equal session.treasury.
    #[account(address = session.treasury)]
    pub treasury: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [SESSION_SEED, treasury.key().as_ref(), &session_id.to_le_bytes()],
        bump = session.bump
    )]
    pub session: Account<'info, Session>,
    #[account(
        mut,
        associated_token::mint = config.usdc_mint,
        associated_token::authority = session
    )]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: helper wallet; validated via helper_stats seeds and helper_ata owner.
    pub helper: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [HELPER_SEED, helper.key().as_ref()],
        bump = helper_stats.bump
    )]
    pub helper_stats: Account<'info, HelperStats>,
    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = helper
    )]
    pub helper_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(session_id: u64)]
pub struct CloseSession<'info> {
    #[account(address = config.settler @ SidekickError::NotSettler)]
    pub settler: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: only used as a PDA seed and refund authority; must equal session.treasury.
    #[account(address = session.treasury)]
    pub treasury: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [SESSION_SEED, treasury.key().as_ref(), &session_id.to_le_bytes()],
        bump = session.bump
    )]
    pub session: Account<'info, Session>,
    #[account(
        mut,
        associated_token::mint = config.usdc_mint,
        associated_token::authority = session
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = config.usdc_mint,
        associated_token::authority = treasury
    )]
    pub treasury_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------- events

#[event]
pub struct SessionOpened {
    pub session: Pubkey,
    pub treasury: Pubkey,
    pub budget: u64,
}

#[event]
pub struct JobsSettled {
    pub session: Pubkey,
    pub helper: Pubkey,
    pub units: u64,
    pub amount: u64,
    pub receipts_root: [u8; 32],
    pub total_units: u64,
    pub total_earned: u64,
}

#[event]
pub struct SessionClosed {
    pub session: Pubkey,
    pub refunded: u64,
}

// ---------------------------------------------------------------- errors

#[error_code]
pub enum SidekickError {
    #[msg("Session is closed")]
    SessionClosed,
    #[msg("Settlement would exceed the session budget")]
    OverBudget,
    #[msg("Signer is not the configured settler")]
    NotSettler,
    #[msg("Mint does not match the configured USDC mint")]
    WrongMint,
    #[msg("Units must be greater than zero")]
    ZeroUnits,
    #[msg("Arithmetic overflow")]
    Overflow,
}
